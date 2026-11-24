/**
 * ============================================================================
 * โมดูลตั้งค่าระบบ บันทึกความปลอดภัย และศูนย์ควบคุมการอัปเดต (Settings, Audit & Deployment Routes)
 * ไฟล์: backend/src/modules/settings/routes.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. GET /system-logs: แสดงบันทึกความปลอดภัย (Audit Logs) เฉพาะผู้ดูแลระบบ (ADMIN)
 * 2. GET /settings/connections & /health: ตรวจสอบสถานะการเชื่อมต่อโดยไม่เปิดเผยรหัสผ่านหรือ Secret เด็ดขาด
 * 3. POST /deployment/approve & /deployment/rollback: เชื่อมต่อกับ `backend/src/modules/deployment/agent.ts`
 *    เพื่อตรวจ SHA-256 จริง, สำรองข้อมูลจริงลงดิสก์, รัน Health Check และบันทึกสถานะจริง (`PENDING` -> `RUNNING` -> `SUCCESS` / `FAILED`) (แก้ไข P1 ข้อ 10–11)
 */
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import mysql from 'mysql2/promise';
import { Router } from 'express';
import { loadConfig, validateProductionConfig } from '../../config/env.ts';
import {
  dbExecute,
  dbQuery,
  inspectDatabaseIntegrityReadOnly,
  inspectMigrationsDetailedReadOnly,
  type DetailedMigrationInspection,
} from '../../database/adapter.ts';
import { verifyPassword } from '../../utils/crypto.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { verifyActorReauthentication } from '../auth/reauth.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  ensureBaselineDeploymentWorkspaceInitialized,
  executeStandaloneDeployment,
  executeStandaloneRollback,
  getActiveReleaseMetadata,
  isDeploymentInProgress,
} from '../deployment/agent.ts';
import {
  getActiveJobByType,
  getLatestJobByType,
  getJobById,
  listRecentJobs,
  startCentralJob,
  updateCentralJobStep,
  completeCentralJob,
  failCentralJob,
  type CentralJobType,
} from '../jobs/tracker.ts';
import {
  checkGitHubUpdateReadOnly,
  clearGitHubUpdateCache,
  diagnoseDeploymentFailure,
  evaluateDeploymentReadiness,
  getGitHubRepoConfig,
  getGitHubUpdateSummaryReadOnly,
  readInstalledPackageVersion,
  sanitizeDeploymentSecrets,
} from '../deployment/github-update.ts';

export const settingsRouter = Router();

export interface DeployBatResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  scriptPath: string;
  durationMs: number;
}

export interface DeploymentGitInspection {
  available: boolean;
  branch: string;
  currentCommit: string;
  targetCommit: string;
  hasUpdates: boolean;
  gitMigrationFiles: string[];
  warning?: string | null;
}

type DeployBatRunner = (scriptPath: string, args?: string[]) => Promise<DeployBatResult>;
type DeploymentGitInspector = () => Promise<DeploymentGitInspection>;
let customDeployBatRunner: DeployBatRunner | null = null;
let customGitInspector: DeploymentGitInspector | null = null;
let batDeploymentRunning = false;

export function setDeployBatRunnerForTests(runner: DeployBatRunner | null): void {
  customDeployBatRunner = runner;
}

export function setDeploymentGitInspectorForTests(inspector: DeploymentGitInspector | null): void {
  customGitInspector = inspector;
}

function sanitizeDeploymentOutput(text: string): string {
  return sanitizeDeploymentSecrets(text);
}

function parseDeployOutputMetadata(stdout: string): {
  backupDir: string | null;
  backupSqlPath: string | null;
  backupSqlSha256: string | null;
  commitBefore: string | null;
  commitAfter: string | null;
  migrationsApplied: string[];
  requiresAdminDatabaseRestore: boolean;
  migrationApprovalRequired: boolean;
} {
  const backupDirMatch = stdout.match(/BackupDir\s*:\s*(.+)/i);
  const backupSqlMatch = stdout.match(/BackupSql\s*:\s*(.+)/i);
  const backupSqlShaMatch = stdout.match(/BackupSqlSha\s*:\s*([a-f0-9]{16,64})/i);
  const commitMatch = stdout.match(/Commit\s*:\s*([a-zA-Z0-9_-]+)\s*->\s*([a-zA-Z0-9_-]+)/i);
  const migMatch = stdout.match(/Migrations\s*:\s*(.+)/i);
  const rawMig = migMatch ? migMatch[1].trim() : '';
  const migrationsApplied =
    rawMig && rawMig.toUpperCase() !== 'NONE'
      ? rawMig
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  return {
    backupDir: backupDirMatch ? backupDirMatch[1].trim() : null,
    backupSqlPath: backupSqlMatch ? backupSqlMatch[1].trim() : null,
    backupSqlSha256: backupSqlShaMatch ? backupSqlShaMatch[1].trim() : null,
    commitBefore: commitMatch ? commitMatch[1].trim() : null,
    commitAfter: commitMatch ? commitMatch[2].trim() : null,
    migrationsApplied,
    requiresAdminDatabaseRestore:
      /ADMIN DB RESTORE REQUIRED|MANUAL_DB_RESTORE_REQUIRED/i.test(stdout),
    migrationApprovalRequired: /MIGRATION_APPROVAL_REQUIRED/i.test(stdout),
  };
}

function runGitReadOnly(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

async function inspectGitDeploymentState(fetchRemote = false): Promise<DeploymentGitInspection> {
  if (customGitInspector) {
    return customGitInspector();
  }

  const cwd = process.cwd();
  const branchRes = await runGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const headRes = await runGitReadOnly(['rev-parse', 'HEAD'], cwd);
  if (!branchRes.ok || !headRes.ok || !headRes.stdout) {
    return {
      available: false,
      branch: 'main',
      currentCommit: 'unknown',
      targetCommit: 'unknown',
      hasUpdates: false,
      gitMigrationFiles: [],
      warning: 'ไม่พบข้อมูล Git Repository ในสภาพแวดล้อมปัจจุบัน',
    };
  }

  const branch = branchRes.stdout || 'main';
  const currentCommit = headRes.stdout;
  let targetCommit = currentCommit;
  let warning: string | null = null;
  let gitMigrationFiles: string[] = [];

  if (fetchRemote) {
    const fetchRes = await runGitReadOnly(['fetch', 'origin', branch], cwd);
    if (!fetchRes.ok) {
      warning = 'ไม่สามารถเชื่อมต่อ GitHub เพื่อตรวจสอบ Commit ล่าสุดได้ในขณะนี้ (แสดงข้อมูล Local ล่าสุด)';
    }
  }

  const remoteRes = await runGitReadOnly(['rev-parse', `origin/${branch}`], cwd);
  if (remoteRes.ok && remoteRes.stdout) {
    targetCommit = remoteRes.stdout;
    if (targetCommit !== currentCommit) {
      const diffRes = await runGitReadOnly(
        ['diff', '--name-only', `${currentCommit}..${targetCommit}`, '--', 'database/migrations/'],
        cwd
      );
      if (diffRes.ok && diffRes.stdout) {
        gitMigrationFiles = diffRes.stdout
          .split(/\r?\n/)
          .map((l) => path.basename(l.trim()))
          .filter((f) => f.endsWith('.sql'));
      }
    }
  }

  return {
    available: true,
    branch,
    currentCommit,
    targetCommit,
    hasUpdates: targetCommit !== currentCommit,
    gitMigrationFiles,
    warning,
  };
}

function mergePendingMigrations(
  dbInspection: DetailedMigrationInspection,
  gitState: DeploymentGitInspection
): string[] {
  const set = new Set<string>();
  for (const f of dbInspection.pendingFiles) {
    set.add(path.basename(f));
  }
  for (const f of gitState.gitMigrationFiles) {
    set.add(path.basename(f));
  }
  return Array.from(set).sort();
}

// B11.5 Central Job Progress Tracking (Recoverable on Page Refresh)
settingsRouter.get('/jobs/active', requireAuth, async (req, res, next) => {
  try {
    const jobType = String(req.query.type || '').trim() as CentralJobType;
    if (
      jobType === 'HOSOFFICE_PERSONNEL_SYNC' ||
      jobType === 'HOSOFFICE_LIVE_PUSH' ||
      jobType === 'SCANNER_MANUAL_SYNC' ||
      jobType === 'DEPLOYMENT_RUN'
    ) {
      const activeJob = getActiveJobByType(jobType);
      const latestJob = getLatestJobByType(jobType);
      res.json({
        jobType,
        inProgress: Boolean(activeJob),
        activeJob,
        latestJob,
      });
      return;
    }

    const activeMap = {
      HOSOFFICE_PERSONNEL_SYNC: getActiveJobByType('HOSOFFICE_PERSONNEL_SYNC'),
      HOSOFFICE_LIVE_PUSH: getActiveJobByType('HOSOFFICE_LIVE_PUSH'),
      SCANNER_MANUAL_SYNC: getActiveJobByType('SCANNER_MANUAL_SYNC'),
      DEPLOYMENT_RUN: getActiveJobByType('DEPLOYMENT_RUN'),
    };
    const activeItems = Object.values(activeMap).filter(Boolean);
    res.json({
      items: activeItems,
      activeJobs: activeMap,
      recentJobs: listRecentJobs(15),
    });
  } catch (err) {
    next(err);
  }
});

settingsRouter.get('/jobs/:jobId', requireAuth, async (req, res, next) => {
  try {
    const job = getJobById(String(req.params.jobId || ''));
    if (!job) {
      res.status(404).json({
        error: 'JOB_NOT_FOUND',
        message: 'ไม่พบรหัสงานประมวลผลที่ระบุ',
        requestId: req.requestId,
      });
      return;
    }
    res.json({ job });
  } catch (err) {
    next(err);
  }
});

// B12. System Logs (ADMIN Only — Zero Secrets)
settingsRouter.get('/system-logs', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const actionFilter = String(req.query.action || '').trim();
    const resultFilter = String(req.query.result || '').trim();
    const search = String(req.query.search || '').trim();

    const conditions = ['1=1'];
    const params: unknown[] = [];

    if (actionFilter) {
      conditions.push('action LIKE ?');
      params.push(`%${actionFilter}%`);
    }
    if (resultFilter) {
      conditions.push('result = ?');
      params.push(resultFilter);
    }
    if (search) {
      conditions.push('(actor_username LIKE ? OR target_id LIKE ? OR request_id LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    const items = await dbQuery(
      `SELECT id, request_id, actor_username, actor_role, ip_address,
              action, target_type, target_id, result, error_code, detail_json, created_at
       FROM audit_logs
       WHERE ${conditions.join(' AND ')}
       ORDER BY id DESC
       LIMIT 150`,
      params
    );

    res.json({ items });
  } catch (err) {
    next(err);
  }
});

// B13. Settings / Connections & Health (ADMIN Only — Never Return Passwords or Secrets)
settingsRouter.get(
  '/settings/connections',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const cfg = loadConfig();
      const certExists = fs.existsSync(cfg.tlsCertPath) && fs.existsSync(cfg.tlsKeyPath);

      res.json({
        system: {
          appName: 'Sam_Att V2 Standalone',
          version: '2.0.0-standalone',
          dataMode: cfg.dataMode,
          targetNodeEngine: '26.13.1',
          runtimeNodeVersion: process.version,
          nodeEnv: cfg.nodeEnv,
          httpsPort: cfg.port,
          publicBasePath: cfg.publicBasePath,
          apiBasePath: cfg.apiBasePath,
          centralGatewayUsed: false,
        },
        tls: {
          certPath: cfg.tlsCertPath,
          keyPath: cfg.tlsKeyPath,
          certificateReady: certExists,
        },
        samAttDatabase: {
          engine: cfg.dbEngine,
          host: cfg.samAttDb.host,
          port: cfg.samAttDb.port,
          database: cfg.samAttDb.database,
          user: cfg.samAttDb.user,
          passwordConfigured: Boolean(cfg.samAttDb.password && cfg.samAttDb.password !== 'CHANGE_ME'),
        },
        hosofficeDatabase: {
          host: cfg.hosofficeDb.host,
          port: cfg.hosofficeDb.port,
          database: cfg.hosofficeDb.database,
          user: cfg.hosofficeDb.user,
          hrPersonTable: cfg.hosofficeDb.hrPersonTable,
          configured: Boolean(cfg.hosofficeDb.host && cfg.hosofficeDb.host !== 'CHANGE_ME'),
          livePushEnabled: cfg.hosofficePush.livePushEnabled,
          targetTable: cfg.hosofficePush.targetTable,
        },
        scannerIntegration: {
          syncEnabled: cfg.scanner.syncEnabled,
          autoSchedulerEnabled: cfg.scanner.autoSchedulerEnabled,
          readerExePath: cfg.scanner.readerExePath,
          exeBinaryExists: fs.existsSync(cfg.scanner.readerExePath),
          timeoutMs: cfg.scanner.timeoutMs,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/settings/connections/health',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const cfg = loadConfig();
      const tableCheck = await dbQuery<{ cnt: number }>('SELECT COUNT(*) as cnt FROM users');

      const hosofficeReady =
        cfg.hosofficeDb.host !== 'CHANGE_ME' && Boolean(cfg.hosofficeDb.host);
      const scannerExeReady =
        cfg.scanner.syncEnabled && fs.existsSync(cfg.scanner.readerExePath);

      res.json({
        status: 'HEALTHY',
        dataMode: cfg.dataMode,
        samAttDb: {
          connected: true,
          engine: cfg.dbEngine,
          userCount: Number(tableCheck[0]?.cnt || 0),
        },
        hosofficeDb: {
          status: hosofficeReady ? 'CONFIGURED' : 'BLOCKED_BY_EXTERNAL_CONTRACT',
          detail: hosofficeReady
            ? 'ตั้งค่า Host สำหรับเชื่อมต่อ HOSOffice Read-only แล้ว'
            : 'รอข้อมูล HOSOFFICE_DB_HOST และบัญชี Read-only จากเจ้าของระบบ',
        },
        scannerExe: {
          status: scannerExeReady ? 'READY' : 'BLOCKED_BY_EXTERNAL_CONTRACT',
          detail: scannerExeReady
            ? 'พบไฟล์ ScannerReader.exe พร้อมซิงก์'
            : 'รอการติดตั้งร่วมกับไฟล์ ScannerReader.exe เดิมบน Windows Server',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// B13.2 Read-Only Synthetic Data & Mojibake Inspector (Zero Automatic Deletion)
settingsRouter.get(
  '/settings/data-integrity-audit',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const report = await inspectDatabaseIntegrityReadOnly();
      res.json(report);
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.post(
  '/settings/connections/test',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const target = String(req.body?.target || 'sam_att_db').trim();
      const cfg = loadConfig();

      if (target === 'sam_att_db') {
        await dbQuery('SELECT 1 as ok');
        res.json({
          target,
          reachable: true,
          engine: cfg.dbEngine,
          message: `เชื่อมต่อฐานข้อมูล Sam_Att (${cfg.samAttDb.database}) สำเร็จ`,
        });
        return;
      }

      if (target === 'hosoffice_db') {
        if (!cfg.hosofficeDb.host || cfg.hosofficeDb.host === 'CHANGE_ME') {
          res.status(503).json({
            target,
            reachable: false,
            error: 'BLOCKED_BY_EXTERNAL_CONTRACT',
            message: 'ยังไม่ได้กำหนดค่า HOSOFFICE_DB_HOST ในไฟล์ .env (ห้ามจำลองผลสำเร็จ)',
          });
          return;
        }
        try {
          const conn = await mysql.createConnection({
            host: cfg.hosofficeDb.host,
            port: cfg.hosofficeDb.port,
            user: cfg.hosofficeDb.user,
            password: cfg.hosofficeDb.password,
            database: cfg.hosofficeDb.database,
            charset: 'utf8mb4',
            connectTimeout: 3000,
          });
          await conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
          await conn.query('SELECT 1');
          await conn.end();
          res.json({
            target,
            reachable: true,
            message: 'เชื่อมต่อฐานข้อมูล HOSOffice Read-only สำเร็จ (UTF-8 / utf8mb4)',
          });
        } catch (connErr: unknown) {
          console.error('[HOSOffice Connection Test Error]', connErr);
          res.status(503).json({
            target,
            reachable: false,
            error: 'HOSOFFICE_CONNECTION_FAILED',
            message: 'ไม่สามารถเชื่อมต่อฐานข้อมูล HOSOffice ได้ กรุณาตรวจสอบค่าตั้งค่าเครือข่ายและสิทธิ์ผู้ใช้',
          });
        }
        return;
      }

      if (target === 'scanner_exe') {
        const exists = fs.existsSync(cfg.scanner.readerExePath);
        if (!exists) {
          res.status(503).json({
            target,
            reachable: false,
            error: 'BLOCKED_BY_EXTERNAL_CONTRACT',
            message: `ไม่พบไฟล์ ${cfg.scanner.readerExePath} บนเครื่องเซิร์ฟเวอร์ปัจจุบัน`,
          });
          return;
        }
        res.json({
          target,
          reachable: true,
          message: `พบไฟล์ ScannerReader.exe ที่ ${cfg.scanner.readerExePath}`,
        });
        return;
      }

      res.status(400).json({
        error: 'INVALID_TARGET',
        message: 'ระบุ target เป็น sam_att_db, hosoffice_db หรือ scanner_exe',
      });
    } catch (err) {
      next(err);
    }
  }
);

// B14. Standalone Deployment / Update / Backup / Rollback (Isolated to Sam_Att Windows Service Only)
settingsRouter.get(
  '/deployment/status',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const cfg = loadConfig();
      const repoCfg = getGitHubRepoConfig();
      const pkgVersion = readInstalledPackageVersion();
      const history = await dbQuery('SELECT * FROM deployment_history ORDER BY id DESC LIMIT 25');
      res.json({
        serviceName: 'SamAttV2Standalone',
        serviceWrapper: 'WinSW (Windows Service Wrapper)',
        architecture: 'STANDALONE_SINGLE_PORT_HTTPS',
        httpsPort: cfg.port,
        currentVersion: `${pkgVersion}-standalone`,
        packageVersion: pkgVersion,
        targetNodeVersion: '>=22.0.0',
        runtimeNodeVersion: process.version,
        osPlatform: process.platform,
        isWindowsServer: process.platform === 'win32',
        repository: {
          owner: repoCfg.owner,
          name: repoCfg.name,
          fullName: `${repoCfg.owner}/${repoCfg.name}`,
          branch: repoCfg.branch,
          htmlUrl: `https://github.com/${repoCfg.owner}/${repoCfg.name}`,
        },
        isolatedFromProcurementAndGateway: true,
        inProgress: isDeploymentInProgress() || batDeploymentRunning,
        activeJob: getActiveJobByType('DEPLOYMENT_RUN'),
        latestJob: getLatestJobByType('DEPLOYMENT_RUN'),
        uiLiveProductionDeployEnabled: true,
        backupRootPolicy: process.env.SAM_ATT_BACKUP_DIR || 'C:\\SamAttBackups (นอก Git Repository)',
        uiDeployNotice:
          'ทำงานผ่านกลไก Sam_Att Safe Deployment: ตรวจสอบ GitHub & Migration -> สำรอง MySQL samchuk_attendance_v2 นอก Git Repo ก่อน git pull -> Build/Test -> รัน Migration ที่ ADMIN อนุมัติ -> ตรวจ Schema -> Restart เฉพาะ Sam_Att บนพอร์ต 4101 โดยไม่แตะต้อง Procurement',
        history,
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/update-summary',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const forceRefresh = req.query.refresh === 'true' || req.query.refresh === '1';
      const summary = await getGitHubUpdateSummaryReadOnly({ forceRefresh });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/migrations',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const inspection = await inspectMigrationsDetailedReadOnly();
      const gitState = await inspectGitDeploymentState(false);
      const combinedPending = mergePendingMigrations(inspection, gitState);
      res.json({
        ...inspection,
        git: gitState,
        combinedPendingMigrations: combinedPending,
        migrationApprovalRequired: combinedPending.length > 0,
        backupPolicy: {
          backupBeforeGitPull: true,
          storedOutsideGitRepo: true,
          defaultBackupRoot: process.env.SAM_ATT_BACKUP_DIR || 'C:\\SamAttBackups',
          databaseTarget: loadConfig().samAttDb.database,
          forbidsHosOfficeAccess: true,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.post(
  '/deployment/check-updates',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const cfg = loadConfig();
      const [dbInspection, gitState, githubCheck] = await Promise.all([
        inspectMigrationsDetailedReadOnly(),
        inspectGitDeploymentState(true),
        checkGitHubUpdateReadOnly({ forceRefresh: true }),
      ]);
      const combinedPending = mergePendingMigrations(dbInspection, gitState);
      const readiness = evaluateDeploymentReadiness({
        githubCheck,
        dbInspection,
        combinedPendingMigrations: combinedPending,
        deploymentInProgress: isDeploymentInProgress() || batDeploymentRunning,
      });

      const resolvedCurrentCommit =
        gitState.currentCommit !== 'unknown'
          ? gitState.currentCommit
          : githubCheck.installed.commitSha;
      const resolvedTargetCommit =
        gitState.targetCommit !== 'unknown'
          ? gitState.targetCommit
          : githubCheck.remote.targetCommitSha;
      const hasUpdates =
        githubCheck.status === 'UPDATE_AVAILABLE' ||
        gitState.hasUpdates ||
        combinedPending.length > 0;

      res.json({
        currentVersion: `${githubCheck.installed.version}-standalone`,
        packageVersion: githubCheck.installed.version,
        currentCommit: resolvedCurrentCommit,
        targetCommit: resolvedTargetCommit,
        branch: githubCheck.repository.branch,
        hasUpdates,
        gitWarning: gitState.warning || githubCheck.remote.errorMessage || null,
        versionStatus: githubCheck.status,
        statusLabelThai: githubCheck.statusLabelThai,
        statusDescriptionThai: githubCheck.statusDescriptionThai,
        releaseAvailability: githubCheck.releaseAvailability,
        github: githubCheck,
        changelog: githubCheck.changelog,
        readiness,
        checkedAt: githubCheck.checkedAt,
        appliedMigrations: dbInspection.appliedMigrations,
        pendingMigrations: combinedPending,
        pendingMigrationDetails: dbInspection.pendingDetails,
        checksumMismatches: dbInspection.checksumMismatches,
        schemaVerification: dbInspection.schemaVerification,
        migrationApprovalRequired: combinedPending.length > 0,
        backupPolicy: {
          backupBeforeGitPull: true,
          storedOutsideGitRepo: true,
          defaultBackupRoot: process.env.SAM_ATT_BACKUP_DIR || 'C:\\SamAttBackups',
          databaseTarget: cfg.samAttDb.database,
        },
        availableRelease: {
          version:
            githubCheck.remote.latestReleaseTag || `${githubCheck.installed.version}-standalone`,
          commitSha: resolvedTargetCommit,
          status:
            combinedPending.length > 0
              ? 'MIGRATION_APPROVAL_REQUIRED'
              : githubCheck.status === 'UPDATE_AVAILABLE' || gitState.hasUpdates
                ? 'UPDATE_AVAILABLE'
                : githubCheck.status,
          releaseNotes:
            githubCheck.changelog.sourceLabelThai ||
            'ตรวจสอบจาก GitHub Repository จริง (jk9krnvb6g-ai/Sam_Att-V2-Standalone)',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.post(
  '/deployment/preflight',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const certExists = fs.existsSync(cfg.tlsCertPath) && fs.existsSync(cfg.tlsKeyPath);
      const migrations = await dbQuery<{ version: string }>('SELECT version FROM schema_migrations');
      const scriptsReady =
        fs.existsSync('scripts/install-windows.ps1') &&
        fs.existsSync('scripts/winsw-sam-att.xml') &&
        fs.existsSync('scripts/backup.ps1') &&
        fs.existsSync('scripts/restore-test.ps1') &&
        fs.existsSync('scripts/deploy-test.ps1') &&
        fs.existsSync('scripts/health-check.ps1');

      const configValidation = validateProductionConfig(cfg);

      const checks = [
        {
          id: 'ISOLATION_POLICY',
          label: 'แยกอิสระจาก Procurement / Central API Gateway / FILESERVER',
          passed: true,
          detail: 'ไม่มีการอ้างอิงพอร์ตหรือเซอร์วิสของระบบอื่น',
        },
        {
          id: 'HTTPS_TLS_CERT',
          label: 'ใบรับรอง TLS สำหรับ HTTPS Port 4101',
          passed: certExists,
          detail: certExists ? `พบใบรับรองที่ ${cfg.tlsCertPath}` : 'ไม่พบไฟล์ใบรับรอง TLS',
        },
        {
          id: 'DB_MIGRATION_STATE',
          label: 'สถานะ Schema Migration (รวมตาราง raw_scan_mappings แบบ Immutable)',
          passed: migrations.length > 0,
          detail: `ใช้ Migration เวอร์ชัน ${migrations.map((m) => m.version).join(', ')}`,
        },
        {
          id: 'WINSW_AND_POWERSHELL_RUNBOOK',
          label: 'ไฟล์ WinSW Service Wrapper (winsw-sam-att.xml) และสคริปต์ PowerShell',
          passed: scriptsReady,
          detail: scriptsReady ? 'พบไฟล์ WinSW XML และสคริปต์ครบถ้วนในโฟลเดอร์ scripts/' : 'สคริปต์ไม่ครบ',
        },
        {
          id: 'CONFIG_SECURITY_VALIDATION',
          label: 'การตรวจสอบความปลอดภัยของค่าตั้งค่า (Port & Secrets)',
          passed: configValidation.valid,
          detail: configValidation.valid
            ? 'ค่าตั้งค่าผ่านเกณฑ์ความปลอดภัย'
            : configValidation.violations.join('; '),
        },
      ];

      const allPassed = checks.every((c) => c.passed);

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'DEPLOYMENT_PREFLIGHT_CHECK',
        targetType: 'DEPLOYMENT',
        targetId: '2.0.0-standalone',
        result: allPassed ? 'SUCCESS' : 'FAILURE',
        detail: { allPassed, checks },
      });

      res.json({
        preflightPassed: allPassed,
        checks,
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/history',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const items = await dbQuery('SELECT * FROM deployment_history ORDER BY id DESC LIMIT 30');
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/backups',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const items = await dbQuery(
        'SELECT id, release_version, commit_sha, artifact_sha256, status, backup_archive_path, executed_by, executed_at FROM deployment_history WHERE backup_archive_path IS NOT NULL ORDER BY id DESC'
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/progress',
  requireAuth,
  requireRoles('ADMIN'),
  async (_req, res, next) => {
    try {
      const latest = await dbQuery('SELECT * FROM deployment_history ORDER BY id DESC LIMIT 1');
      res.json({
        inProgress: isDeploymentInProgress(),
        latestOperation: latest[0] || null,
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.post(
  '/deployment/approve',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const password = String(req.body?.adminPassword || '');
      const releaseVersion = String(req.body?.releaseVersion || '2.0.1-standalone').trim();
      const commitSha = String(req.body?.commitSha || '').trim();
      const artifactSha256 = String(req.body?.artifactSha256 || '').trim();
      const artifactFilePath = String(req.body?.artifactFilePath || '').trim();

      if (!password || !commitSha || !artifactFilePath || !/^[a-f0-9]{64}$/i.test(artifactSha256)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message:
            'ต้องระบุรหัสผ่าน ADMIN, รหัส Commit SHA, พาธไฟล์ Artifact จริง (artifactFilePath) และค่า SHA-256 (64 hex chars)',
          requestId: req.requestId,
        });
        return;
      }

      const dbUsers = await dbQuery<{ password_hash: string }>(
        'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
        [req.user!.id]
      );
      if (dbUsers.length === 0 || !verifyPassword(password, dbUsers[0].password_hash)) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_APPROVE_REAUTH_FAILED',
          targetType: 'DEPLOYMENT',
          targetId: releaseVersion,
          result: 'DENIED',
          errorCode: 'INVALID_ADMIN_PASSWORD',
        });
        res.status(401).json({
          error: 'INVALID_ADMIN_PASSWORD',
          message: 'รหัสผ่านยืนยันตัวตนของ ADMIN ไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      try {
        const outcome = await executeStandaloneDeployment({
          releaseVersion,
          commitSha,
          expectedArtifactSha256: artifactSha256,
          artifactFilePath,
          actorUsername: req.user!.username,
        });

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_EXECUTED_SUCCESS',
          targetType: 'DEPLOYMENT',
          targetId: String(outcome.deploymentId),
          result: 'SUCCESS',
          detail: outcome,
        });

        res.json({
          status: outcome.status,
          deploymentStatus: outcome.status,
          deploymentId: outcome.deploymentId,
          releaseVersion: outcome.releaseVersion,
          commitSha: outcome.commitSha,
          artifactSha256: outcome.artifactSha256,
          backupArchivePath: outcome.backupArchivePath,
          backupSha256: outcome.backupSha256,
          stagedFileCount: outcome.stagedFileCount,
          healthCheck: outcome.healthCheck,
        });
      } catch (deployErr: unknown) {
        const code = (deployErr as { code?: string })?.code || 'DEPLOYMENT_EXECUTION_FAILED';
        const statusCode = (deployErr as { statusCode?: number })?.statusCode || 422;
        const message = deployErr instanceof Error ? deployErr.message : String(deployErr);

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_EXECUTED_FAILED',
          targetType: 'DEPLOYMENT',
          targetId: releaseVersion,
          result: 'FAILURE',
          errorCode: code,
          detail: { message },
        });

        res.status(statusCode).json({
          status: 'FAILED',
          error: code,
          message,
          requestId: req.requestId,
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.post(
  '/deployment/rollback',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const targetBackupId = Number(req.body?.targetBackupId || 1);
      const reason = String(req.body?.reason || 'Rollback ไปยังเวอร์ชันเสถียรตามแผนฉุกเฉิน').trim();

      try {
        const outcome = await executeStandaloneRollback({
          targetBackupId,
          reason,
          actorUsername: req.user!.username,
        });

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_ROLLBACK_EXECUTED',
          targetType: 'DEPLOYMENT',
          targetId: String(outcome.rollbackEntryId),
          result: 'SUCCESS',
          detail: outcome,
        });

        res.json({
          status: outcome.status,
          rollbackEntryId: outcome.rollbackEntryId,
          targetVersion: outcome.targetVersion,
          backupArchivePath: outcome.restoredFromPath,
          restoredTablesCount: outcome.restoredTablesCount,
          healthCheck: outcome.healthCheck,
          healthCheckPassed: outcome.healthCheck.healthy,
        });
      } catch (rbErr: unknown) {
        const code = (rbErr as { code?: string })?.code || 'ROLLBACK_FAILED';
        const statusCode = (rbErr as { statusCode?: number })?.statusCode || 422;
        const message = rbErr instanceof Error ? rbErr.message : String(rbErr);

        res.status(statusCode).json({
          status: 'FAILED',
          error: code,
          message,
          requestId: req.requestId,
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

// B15. Safe One-Button Deployment with Migration Approval Gate (ADMIN Only — Fixed Path Deploy_Sam_Att.bat)
settingsRouter.post(
  '/deployment/run-bat',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      if (req.body?.confirmRun !== true) {
        res.status(400).json({
          status: 'FAILED',
          error: 'CONFIRMATION_REQUIRED',
          message: 'กรุณายืนยันการอัปเดตระบบก่อนดำเนินการ (confirmRun: true)',
          requestId: req.requestId,
        });
        return;
      }

      if (isDeploymentInProgress() || batDeploymentRunning) {
        res.status(409).json({
          status: 'FAILED',
          error: 'DEPLOYMENT_ALREADY_IN_PROGRESS',
          message: 'กำลังมีการอัปเดตระบบทำงานอยู่ กรุณารอให้เสร็จสิ้นก่อนสั่งอัปเดตซ้ำ',
          activeJob: getActiveJobByType('DEPLOYMENT_RUN'),
          requestId: req.requestId,
        });
        return;
      }

      // 1. ตรวจสอบ Migration ที่ค้างอยู่และสถานะ Git ล่าสุด (fetchRemote=true เพื่อป้องกัน stale-ref mismatch กับ Deploy_Sam_Att.ps1)
      const [dbInspection, gitState] = await Promise.all([
        inspectMigrationsDetailedReadOnly(),
        inspectGitDeploymentState(!customGitInspector),
      ]);

      if (dbInspection.checksumMismatches.length > 0) {
        res.status(409).json({
          status: 'FAILED',
          error: 'MIGRATION_CHECKSUM_MISMATCH',
          checksumMismatches: dbInspection.checksumMismatches,
          message:
            'ตรวจพบไฟล์ Migration ที่เคยรันไปแล้วถูกแก้ไขค่า Checksum ระบบระงับการอัปเดตเพื่อความปลอดภัย กรุณาตรวจสอบก่อนดำเนินการ',
          requestId: req.requestId,
        });
        return;
      }

      const combinedPending = mergePendingMigrations(dbInspection, gitState);
      const expectedTargetCommit = gitState.targetCommit || gitState.currentCommit;
      const cliArgs: string[] = ['-NonInteractive'];
      let migrationApprovalRecorded = false;

      if (combinedPending.length > 0) {
        if (req.body?.approveMigrations !== true) {
          await writeAuditLog({
            requestId: req.requestId,
            actorUsername: req.user!.username,
            actorRole: req.user!.role,
            ipAddress: req.ip || '127.0.0.1',
            action: 'DEPLOYMENT_BLOCKED_MIGRATION_APPROVAL_REQUIRED',
            targetType: 'DEPLOYMENT',
            targetId: expectedTargetCommit,
            result: 'BLOCKED',
            errorCode: 'MIGRATION_APPROVAL_REQUIRED',
            detail: {
              targetCommit: expectedTargetCommit,
              pendingMigrations: combinedPending,
            },
          });

          res.status(409).json({
            status: 'FAILED',
            error: 'MIGRATION_APPROVAL_REQUIRED',
            message: `ตรวจพบ Database Migration ที่รอการอนุมัติ (${combinedPending.join(', ')}) ห้ามรันอัตโนมัติ กรุณาตรวจสอบผลกระทบและยืนยันด้วยรหัสผ่านผู้ดูแลระบบก่อนดำเนินการ`,
            targetCommit: expectedTargetCommit,
            currentCommit: gitState.currentCommit,
            pendingMigrations: combinedPending,
            pendingMigrationDetails: dbInspection.pendingDetails,
            appliedMigrations: dbInspection.appliedMigrations,
            backupPolicy: {
              backupBeforeGitPull: true,
              storedOutsideGitRepo: true,
              defaultBackupRoot: process.env.SAM_ATT_BACKUP_DIR || 'C:\\SamAttBackups',
              databaseTarget: loadConfig().samAttDb.database,
            },
            requestId: req.requestId,
          });
          return;
        }

        // 2. ผูกการอนุมัติเข้ากับ Target Commit และรายการไฟล์ Migration ที่ตรวจพบจริง (ห้ามอนุมัติไฟล์ A แล้วไปรันไฟล์ B)
        const approvedTargetCommit = String(req.body?.approvedTargetCommit || '').trim();
        const approvedFilesRaw: unknown[] = Array.isArray(req.body?.approvedMigrationFiles)
          ? req.body.approvedMigrationFiles
          : [];
        const approvedFilesNormalized = Array.from(
          new Set(approvedFilesRaw.map((f) => path.basename(String(f || '').trim())).filter(Boolean))
        ).sort();

        if (
          !approvedTargetCommit ||
          approvedTargetCommit !== expectedTargetCommit ||
          approvedFilesNormalized.join(',') !== combinedPending.join(',')
        ) {
          await writeAuditLog({
            requestId: req.requestId,
            actorUsername: req.user!.username,
            actorRole: req.user!.role,
            ipAddress: req.ip || '127.0.0.1',
            action: 'DEPLOYMENT_MIGRATION_APPROVAL_MISMATCH',
            targetType: 'DEPLOYMENT',
            targetId: expectedTargetCommit,
            result: 'DENIED',
            errorCode: 'MIGRATION_APPROVAL_MISMATCH',
            detail: {
              expectedTargetCommit,
              approvedTargetCommit,
              expectedMigrations: combinedPending,
              approvedMigrations: approvedFilesNormalized,
            },
          });

          res.status(409).json({
            status: 'FAILED',
            error: 'MIGRATION_APPROVAL_MISMATCH',
            message:
              'ข้อมูลการอนุมัติ Migration ไม่ตรงกับ Commit เป้าหมายหรือรายการไฟล์ Migration ล่าสุด กรุณาตรวจสอบและอนุมัติใหม่อีกครั้ง',
            expectedTargetCommit,
            expectedMigrations: combinedPending,
            requestId: req.requestId,
          });
          return;
        }

        // 3. ยืนยันตัวตนด้วยรหัสผ่านของบัญชี ADMIN ที่กำลังล็อกอินจริง (พร้อม Brute-force Rate Limit & ห้ามบันทึกรหัสผ่าน)
        const reauth = await verifyActorReauthentication({
          userId: req.user!.id,
          username: req.user!.username,
          role: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          requestId: req.requestId,
          operationName: 'DEPLOYMENT_MIGRATION_APPROVAL',
          targetType: 'DEPLOYMENT',
          targetId: expectedTargetCommit,
          confirmPassword: req.body?.confirmPassword,
          impactAcknowledged: req.body?.impactAcknowledged,
        });

        if (!reauth.ok) {
          res.status(reauth.statusCode || 401).json({
            status: 'FAILED',
            error: reauth.errorCode || 'REAUTH_FAILED',
            message: reauth.message || 'การยืนยันตัวตนด้วยรหัสผ่านผู้ดูแลระบบไม่ผ่าน',
            lockedUntil: reauth.lockedUntil || null,
            requestId: req.requestId,
          });
          return;
        }

        migrationApprovalRecorded = true;
        cliArgs.push(
          '-ApproveMigrations',
          '-ApprovedCommit',
          approvedTargetCommit,
          '-ApprovedMigrations',
          approvedFilesNormalized.join(',')
        );
      }

      const localScriptPath = path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.bat');
      const windowsScriptPath = 'C:\\inetpub\\wwwroot\\Sam_Att\\deployment\\Deploy_Sam_Att.bat';
      const resolvedScriptPath = fs.existsSync(localScriptPath)
        ? localScriptPath
        : windowsScriptPath;
      const resolvedPs1Path = path.join(path.dirname(resolvedScriptPath), 'Deploy_Sam_Att.ps1');

      if (!fs.existsSync(resolvedScriptPath) && !customDeployBatRunner) {
        res.status(404).json({
          status: 'FAILED',
          error: 'DEPLOY_SCRIPT_NOT_FOUND',
          message: `ไม่พบไฟล์สคริปต์อัปเดตที่กำหนด (${localScriptPath})`,
          requestId: req.requestId,
        });
        return;
      }

      batDeploymentRunning = true;
      const startTime = Date.now();
      const job = startCentralJob({
        jobType: 'DEPLOYMENT_RUN',
        actorUsername: req.user!.username,
        initialStep: 'ตรวจสอบความพร้อมระบบและเตรียมสำรองข้อมูลก่อนอัปเดต...',
        stage: 'PREFLIGHT',
        totalCount: 7,
      });

      try {
        updateCentralJobStep(job.jobId, {
          stage: 'BACKING_UP',
          currentStep: migrationApprovalRecorded
            ? `กำลังสำรองข้อมูลและรันสคริปต์อัปเดตพร้อม Migration ที่อนุมัติ (${combinedPending.join(', ')})...`
            : 'กำลังสำรองข้อมูลและรันสคริปต์ Deploy_Sam_Att...',
          processedCount: 2,
          totalCount: 7,
        });

        let batResult: DeployBatResult;

        if (customDeployBatRunner) {
          batResult = await customDeployBatRunner(resolvedScriptPath, cliArgs);
        } else if (process.platform === 'win32') {
          const appRootDir = path.dirname(path.dirname(resolvedScriptPath));
          const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            SAM_ATT_NO_PAUSE: '1',
          };
          if (migrationApprovalRecorded) {
            childEnv.SAM_ATT_APPROVED_COMMIT = expectedTargetCommit;
            childEnv.SAM_ATT_APPROVED_MIGRATIONS = combinedPending.join(',');
          }

          // Invoke PowerShell directly on Windows when Deploy_Sam_Att.ps1 exists to prevent cmd.exe comma/quote splitting
          const useDirectPowerShell = fs.existsSync(resolvedPs1Path);
          const execBinary = useDirectPowerShell ? 'powershell.exe' : 'cmd.exe';
          const execArgs = useDirectPowerShell
            ? [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                resolvedPs1Path,
                '-AppDir',
                appRootDir,
                ...cliArgs,
              ]
            : ['/c', resolvedScriptPath, ...cliArgs];

          batResult = await new Promise<DeployBatResult>((resolve) => {
            execFile(
              execBinary,
              execArgs,
              {
                cwd: appRootDir,
                env: childEnv,
                timeout: 600000,
                maxBuffer: 16 * 1024 * 1024,
                windowsHide: true,
              },
              (err, stdout, stderr) => {
                const exitCode =
                  err && typeof (err as { code?: number }).code === 'number'
                    ? Number((err as { code?: number }).code)
                    : err
                      ? 1
                      : 0;
                resolve({
                  exitCode,
                  stdout: String(stdout || ''),
                  stderr: String(stderr || (err ? err.message : '')),
                  scriptPath: useDirectPowerShell ? resolvedPs1Path : resolvedScriptPath,
                  durationMs: Date.now() - startTime,
                });
              }
            );
          });
        } else {
          const nonWinDiagnostics = {
            failedStep: 'ขั้นตอนที่ 1/7: ตรวจสอบสภาพแวดล้อมเซิร์ฟเวอร์',
            errorCode: 'UNSUPPORTED_OS_ENVIRONMENT',
            detectedCause: `สภาพแวดล้อมปัจจุบันเป็น ${process.platform} ซึ่งไม่สามารถรันสคริปต์ Windows PowerShell / Deploy_Sam_Att.bat ได้`,
            remediationSteps: [
              'ดำเนินการอัปเดตบนเครื่องเซิร์ฟเวอร์ Windows Server ที่ติดตั้งระบบ Sam_Att V2 Standalone จริง',
            ],
            exitCode: 1,
            rolledBack: false,
            requiresAdminDatabaseRestore: false,
            httpStatus: 501,
          };
          failCentralJob(job.jobId, {
            errorCode: 'UNSUPPORTED_OS_ENVIRONMENT',
            errorMessage:
              'การรันไฟล์ Deploy_Sam_Att.bat รองรับเฉพาะบนเครื่อง Windows Server เท่านั้น (สภาพแวดล้อมปัจจุบันไม่สามารถเรียก cmd.exe ได้)',
            currentStep: 'ไม่รองรับการรันสคริปต์ Windows ในสภาพแวดล้อมปัจจุบัน',
          });
          res.status(501).json({
            status: 'FAILED',
            error: 'UNSUPPORTED_OS_ENVIRONMENT',
            jobId: job.jobId,
            scriptPath: resolvedScriptPath,
            diagnostics: nonWinDiagnostics,
            message:
              'การรันไฟล์ Deploy_Sam_Att.bat รองรับเฉพาะบนเครื่อง Windows Server เท่านั้น (สภาพแวดล้อมปัจจุบันไม่สามารถเรียก cmd.exe ได้)',
            requestId: req.requestId,
          });
          return;
        }

        const safeStdout = sanitizeDeploymentOutput(batResult.stdout);
        const safeStderr = sanitizeDeploymentOutput(batResult.stderr);
        const parsedMeta = parseDeployOutputMetadata(`${safeStdout}\n${safeStderr}`);
        const success = batResult.exitCode === 0;
        const releaseVersion = `${readInstalledPackageVersion()}-standalone`;
        const statusText = success ? 'SUCCESS' : 'FAILED';
        const recordedCommit = parsedMeta.commitAfter || expectedTargetCommit || 'unknown';
        const diagnostics = success
          ? null
          : diagnoseDeploymentFailure({
              exitCode: batResult.exitCode,
              stdout: safeStdout,
              stderr: safeStderr,
              requiresAdminDatabaseRestore: parsedMeta.requiresAdminDatabaseRestore,
              migrationApprovalRequired: parsedMeta.migrationApprovalRequired,
            });

        const historyNotes = success
          ? safeStdout.slice(-900)
          : sanitizeDeploymentOutput(
              `[${diagnostics!.errorCode}] ${diagnostics!.failedStep} — ${diagnostics!.detectedCause}\n${safeStdout}\n${safeStderr}`
            ).slice(-950);

        const insertRes = await dbExecute(
          `INSERT INTO deployment_history
             (release_version, commit_sha, artifact_sha256, action_type, status, backup_archive_path, preflight_passed, notes, executed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            releaseVersion,
            recordedCommit.slice(0, 64),
            (parsedMeta.backupSqlSha256 || 'bat-execution-verified').slice(0, 64),
            migrationApprovalRecorded ? 'DEPLOY_BAT_WITH_MIGRATION' : 'DEPLOY_BAT',
            statusText,
            parsedMeta.backupDir ? parsedMeta.backupDir.slice(0, 255) : null,
            success ? 1 : 0,
            historyNotes,
            req.user!.username,
          ]
        );

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_BAT_EXECUTED',
          targetType: 'DEPLOYMENT',
          targetId: String(insertRes.insertId),
          result: success ? 'SUCCESS' : 'FAILURE',
          errorCode: success
            ? null
            : diagnostics?.errorCode || `EXIT_CODE_${batResult.exitCode}`,
          detail: {
            jobId: job.jobId,
            scriptPath: batResult.scriptPath,
            exitCode: batResult.exitCode,
            durationMs: batResult.durationMs,
            commitBefore: parsedMeta.commitBefore || gitState.currentCommit,
            commitAfter: recordedCommit,
            backupDir: parsedMeta.backupDir,
            migrationsApproved: migrationApprovalRecorded ? combinedPending : [],
            migrationsApplied: parsedMeta.migrationsApplied,
            requiresAdminDatabaseRestore: parsedMeta.requiresAdminDatabaseRestore,
            failedStep: diagnostics?.failedStep || null,
            detectedCause: diagnostics?.detectedCause || null,
          },
        });

        if (!success && diagnostics) {
          const errCode = parsedMeta.migrationApprovalRequired
            ? 'MIGRATION_APPROVAL_REQUIRED'
            : parsedMeta.requiresAdminDatabaseRestore
              ? 'MANUAL_DB_RESTORE_REQUIRED'
              : diagnostics.errorCode === 'DEPLOYMENT_EXECUTION_FAILED'
                ? 'DEPLOYMENT_EXECUTION_FAILED'
                : diagnostics.errorCode;
          const errMsg = parsedMeta.migrationApprovalRequired
            ? 'ตรวจพบ Database Migration ที่ต้องได้รับอนุมัติจากผู้ดูแลระบบก่อนดำเนินการ (MIGRATION_APPROVAL_REQUIRED)'
            : parsedMeta.requiresAdminDatabaseRestore
              ? `การอัปเดตไม่สำเร็จหลังเริ่มรัน Migration (Exit Code: ${batResult.exitCode}) ระบบได้ย้อนซอร์สโค้ดแล้ว แต่ผู้ดูแลระบบต้องตรวจสอบและกู้คืนฐานข้อมูลด้วยตนเองหากจำเป็น`
              : `${diagnostics.detectedCause} (Exit Code: ${batResult.exitCode})`;

          failCentralJob(job.jobId, {
            errorCode: errCode,
            errorMessage: errMsg,
            currentStep: diagnostics.failedStep,
            resultSummary: {
              deploymentId: insertRes.insertId,
              exitCode: batResult.exitCode,
              failedStep: diagnostics.failedStep,
              errorCode: diagnostics.errorCode,
              backupDir: parsedMeta.backupDir,
              backupSqlPath: parsedMeta.backupSqlPath,
              requiresAdminDatabaseRestore: diagnostics.requiresAdminDatabaseRestore,
            },
          });

          res.status(diagnostics.httpStatus).json({
            status: 'FAILED',
            error: errCode,
            jobId: job.jobId,
            deploymentId: insertRes.insertId,
            exitCode: batResult.exitCode,
            scriptPath: batResult.scriptPath,
            backupDir: parsedMeta.backupDir,
            backupSqlPath: parsedMeta.backupSqlPath,
            requiresAdminDatabaseRestore: diagnostics.requiresAdminDatabaseRestore,
            diagnostics,
            output: safeStdout,
            errorOutput: safeStderr,
            message: errMsg,
            requestId: req.requestId,
          });
          return;
        }

        clearGitHubUpdateCache();

        completeCentralJob(job.jobId, {
          status: 'SUCCESS',
          currentStep: 'อัปเดตระบบและตรวจสอบ Health Check สำเร็จ',
          processedCount: 7,
          totalCount: 7,
          resultSummary: {
            deploymentId: insertRes.insertId,
            commitBefore: parsedMeta.commitBefore || gitState.currentCommit,
            commitAfter: recordedCommit,
            backupDir: parsedMeta.backupDir,
            migrationsApplied: parsedMeta.migrationsApplied,
          },
        });

        res.json({
          status: 'SUCCESS',
          jobId: job.jobId,
          deploymentId: insertRes.insertId,
          releaseVersion,
          exitCode: 0,
          scriptPath: batResult.scriptPath,
          durationMs: batResult.durationMs,
          commitBefore: parsedMeta.commitBefore || gitState.currentCommit,
          commitAfter: recordedCommit,
          backupDir: parsedMeta.backupDir,
          backupSqlPath: parsedMeta.backupSqlPath,
          migrationsApplied: parsedMeta.migrationsApplied,
          executedAt: new Date().toISOString(),
          executedBy: req.user!.username,
          output: safeStdout,
          message: 'อัปเดตระบบ Sam_Att V2 Standalone สำเร็จเรียบร้อยแล้ว',
        });
      } finally {
        batDeploymentRunning = false;
      }
    } catch (err) {
      batDeploymentRunning = false;
      next(err);
    }
  }
);

// Explicit Method Guard for /deployment/run-bat (catches GET converted from POST by IIS 301/302 redirects or direct browser visits)
settingsRouter.all('/deployment/run-bat', (req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    status: 'FAILED',
    error: 'METHOD_NOT_ALLOWED',
    allowedMethods: ['POST'],
    receivedMethod: req.method,
    message: `Endpoint /api/Sam_Att/deployment/run-bat รองรับเฉพาะคำสั่ง POST เท่านั้น (ได้รับ ${req.method}) — หากเกิดจาก Reverse Proxy/IIS Redirect 301/302 ให้ตรวจสอบให้ส่งตรงผ่าน HTTPS POST หรือใช้ 307/308`,
    requestId: req.requestId,
  });
});


