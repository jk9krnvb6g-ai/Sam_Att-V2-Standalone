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
import { execFile, spawn } from 'child_process';
import mysql from 'mysql2/promise';
import { Router } from 'express';
import {
  loadConfig,
  persistGitHubTokenToEnvFile,
  resolveDotEnvFilePath,
  validateProductionConfig,
} from '../../config/env.ts';
import {
  dbExecute,
  dbQuery,
  inspectDatabaseIntegrityReadOnly,
  inspectMigrationsDetailedReadOnly,
  type DetailedMigrationInspection,
} from '../../database/adapter.ts';
import { verifyPassword } from '../../utils/crypto.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
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
  acquireDeployLock,
  createInitialSteps,
  createPersistentDeployJob,
  generateDeployJobId,
  getDeployJobsDir,
  getDeployLockFilePath,
  getDeployLockStatus,
  getJobFilePath,
  listAvailableAppSnapshots,
  readLatestPersistentDeployJob,
  readPersistentDeployJob,
  releaseDeployLock,
  savePersistentDeployJob,
  syncFinishedDiskJobToHistory,
  type PersistentDeployJob,
} from '../deployment/jobStore.ts';
import {
  checkGitHubUpdates,
  clearGitHubUpdateCache,
  diagnoseDeploymentFailure,
  evaluateDeploymentReadiness,
  hasCustomGitHubFetcherForTests,
  readInstalledVersionInfo,
  readPackageVersion,
  sanitizeDeploymentLog,
  type GitHubVersionCheckResult,
} from '../deployment/githubUpdateCenter.ts';

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
let customDeployRollbackRunner: DeployBatRunner | null = null;
let customGitInspector: DeploymentGitInspector | null = null;
let batDeploymentRunning = false;

export function setDeployBatRunnerForTests(runner: DeployBatRunner | null): void {
  customDeployBatRunner = runner;
}

export function setDeployRollbackRunnerForTests(runner: DeployBatRunner | null): void {
  customDeployRollbackRunner = runner;
}

export function setDeploymentGitInspectorForTests(inspector: DeploymentGitInspector | null): void {
  customGitInspector = inspector;
}

export function sanitizeDeploymentOutput(text: string): string {
  return sanitizeDeploymentLog(text);
}

function parseDeployOutputMetadata(stdout: string): {
  backupDir: string | null;
  backupSqlPath: string | null;
  backupSqlSha256: string | null;
  commitBefore: string | null;
  commitAfter: string | null;
  targetCommit: string | null;
  migrationsApplied: string[];
  requiresAdminDatabaseRestore: boolean;
  migrationApprovalRequired: boolean;
} {
  const backupDirMatch = stdout.match(/(?:BackupDir|SnapshotDir)\s*:\s*(.+)/i);
  const backupSqlMatch = stdout.match(/BackupSql\s*:\s*(.+)/i);
  const backupSqlShaMatch = stdout.match(/BackupSqlSha\s*:\s*([a-f0-9]{16,64})/i);
  const commitMatch = stdout.match(/Commit\s*:\s*([a-zA-Z0-9_-]+)\s*->\s*([a-zA-Z0-9_-]+)/i);
  const commitBeforeLine = stdout.match(/CommitBefore\s*:\s*([a-f0-9]{7,40})/i);
  const commitAfterLine = stdout.match(/CommitAfter\s*:\s*([a-f0-9]{7,40})/i);
  const targetCommitLine = stdout.match(/TargetCommit\s*:\s*([a-f0-9]{7,40})/i);
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
    commitBefore: commitBeforeLine ? commitBeforeLine[1].trim() : commitMatch ? commitMatch[1].trim() : null,
    commitAfter: commitAfterLine ? commitAfterLine[1].trim() : commitMatch ? commitMatch[2].trim() : null,
    targetCommit: targetCommitLine ? targetCommitLine[1].trim() : null,
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

// B14. Standalone Deployment / GitHub Update Center / Backup / Rollback (ADMIN Only)
settingsRouter.get(
  '/deployment/status',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const syncedDiskJob = await syncFinishedDiskJobToHistory(req.user?.username || 'admin');
      const lockInfo = getDeployLockStatus();
      const [history, installed] = await Promise.all([
        dbQuery('SELECT * FROM deployment_history ORDER BY id DESC LIMIT 20'),
        readInstalledVersionInfo(),
      ]);
      const availableSnapshots = listAvailableAppSnapshots();
      const activeDiskJob =
        syncedDiskJob && (syncedDiskJob.status === 'PENDING' || syncedDiskJob.status === 'RUNNING')
          ? syncedDiskJob
          : null;
      const snapshotRoot =
        process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR ||
        process.env.SAM_ATT_BACKUP_DIR ||
        'C:\\SamAttDeploySnapshots';

      res.json({
        serviceName: 'SamAttV2Standalone',
        serviceWrapper: 'WinSW (Windows Service Wrapper)',
        architecture: 'STANDALONE_SINGLE_PORT_HTTPS',
        appOnlyPolicy: true,
        httpsPort: cfg.port,
        currentVersion: installed.packageVersion,
        installedVersion: installed.packageVersion,
        installedReleaseTag: installed.installedReleaseTag,
        currentCommit: installed.currentCommit || 'unknown',
        currentCommitShort: installed.currentCommitShort || 'unknown',
        localGitAvailable: installed.localGitAvailable,
        workingTreeClean: installed.workingTreeClean,
        dirtyFiles: installed.dirtyFiles,
        gitWarning: installed.gitWarning,
        repository: cfg.github.repo,
        repositoryUrl: `https://github.com/${cfg.github.repo}`,
        branch: cfg.github.branch,
        tokenConfigured: cfg.github.tokenConfigured,
        tokenMaskedHint: cfg.github.tokenMaskedHint,
        cacheTtlMinutes: Math.max(1, Math.round(cfg.github.cacheTtlMs / 60000)),
        envFileExists: fs.existsSync(resolveDotEnvFilePath()),
        platform: process.platform,
        targetNodeVersion: '>=22.0.0',
        runtimeNodeVersion: process.version,
        isolatedFromProcurementAndGateway: true,
        inProgress:
          isDeploymentInProgress() ||
          batDeploymentRunning ||
          lockInfo.locked ||
          Boolean(activeDiskJob),
        lock: lockInfo,
        activeJob: activeDiskJob || getActiveJobByType('DEPLOYMENT_RUN'),
        latestJob: syncedDiskJob || getLatestJobByType('DEPLOYMENT_RUN'),
        uiLiveProductionDeployEnabled: process.platform === 'win32' || Boolean(customDeployBatRunner),
        snapshotRootPolicy: snapshotRoot,
        backupRootPolicy: `${snapshotRoot} (Application Snapshot นอก Git Repository)`,
        availableSnapshots,
        rollbackAvailable: availableSnapshots.length > 0,
        uiDeployNotice:
          'Application-Only One-Click Deployment (8 ขั้นตอน): ตรวจความพร้อม -> ตรวจ GitHub & DB Block -> สำรอง Snapshot dist/ นอก Git Repo -> git pull & ตรวจ lockfile ก่อน npm ci -> Typecheck & Build (ไม่รัน npm test บน Production) -> รีสตาร์ทเฉพาะ Sam_Att บนพอร์ต 4101 -> Health Check -> สรุปผล (ไม่แตะต้องฐานข้อมูลและ Procurement)',
        history,
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/update-notification',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const forceRefresh = req.query.force === '1' || req.query.force === 'true';
      const gitState = customGitInspector ? await inspectGitDeploymentState(false) : null;
      const gh = await checkGitHubUpdates({
        forceRefresh,
        overrideGit: gitState
          ? {
              available: gitState.available,
              branch: gitState.branch,
              currentCommit: gitState.currentCommit,
              warning: gitState.warning,
            }
          : undefined,
      });

      res.json({
        hasUpdate: gh.hasUpdates,
        status: gh.status,
        statusLabelThai: gh.statusLabelThai,
        repository: gh.repository,
        branch: gh.branch,
        installedVersion: gh.installedVersion,
        installedReleaseTag: gh.installedReleaseTag,
        latestVersion: gh.latestVersion,
        currentCommit: gh.currentCommit,
        currentCommitShort: gh.currentCommitShort,
        targetCommit: gh.targetCommit,
        targetCommitShort: gh.targetCommitShort,
        commitsBehind: gh.commitsBehind,
        checkedAt: gh.checkedAt,
        githubReachable: gh.githubReachable,
        githubError: gh.githubError,
        githubErrorCode: gh.githubErrorCode,
        remediationThai: gh.remediationThai,
        tokenConfigured: gh.tokenConfigured,
        tokenMaskedHint: gh.tokenMaskedHint,
        fromCache: gh.fromCache,
        cacheExpiresAt: gh.cacheExpiresAt,
        cacheTtlMinutes: gh.cacheTtlMinutes,
        isStale: Boolean(gh.isStale),
        staleWarningThai: gh.staleWarningThai ?? null,
        lastSuccessfulCheckedAt: gh.lastSuccessfulCheckedAt ?? null,
        cooldownActive: Boolean(gh.cooldownActive),
        cooldownUntil: gh.cooldownUntil ?? null,
        cooldownUntilThai: gh.cooldownUntilThai ?? null,
        rateLimit: gh.rateLimit,
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.get(
  '/deployment/readiness',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const [dbInspection, gitState] = await Promise.all([
        inspectMigrationsDetailedReadOnly(),
        inspectGitDeploymentState(false),
      ]);

      let githubCheck: GitHubVersionCheckResult | null = null;
      if (!(process.env.NODE_ENV === 'test' && customGitInspector && !hasCustomGitHubFetcherForTests())) {
        githubCheck = await checkGitHubUpdates({
          forceRefresh: false,
          overrideGit: customGitInspector
            ? {
                available: gitState.available,
                branch: gitState.branch,
                currentCommit: gitState.currentCommit,
                warning: gitState.warning,
              }
            : undefined,
        });
      }

      const mergedPending = Array.from(
        new Set([
          ...mergePendingMigrations(dbInspection, gitState),
          ...(githubCheck?.compareMigrationFiles || []),
        ])
      ).sort();

      const readiness = evaluateDeploymentReadiness({
        actorRole: req.user!.role,
        githubCheck,
        dbInspection,
        combinedPendingMigrations: mergedPending,
        hasCustomDeployRunner: Boolean(customDeployBatRunner),
      });

      res.json(readiness);
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
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const forceRefresh =
        req.query.force === '1' ||
        req.query.force === 'true' ||
        req.body?.force === true ||
        req.body?.force === 'true';

      const [dbInspection, gitState] = await Promise.all([
        inspectMigrationsDetailedReadOnly(),
        inspectGitDeploymentState(forceRefresh),
      ]);

      const skipExternalGithubInLegacyMockTest =
        process.env.NODE_ENV === 'test' && Boolean(customGitInspector) && !hasCustomGitHubFetcherForTests();

      let githubCheck: GitHubVersionCheckResult | null = null;
      if (!skipExternalGithubInLegacyMockTest) {
        githubCheck = await checkGitHubUpdates({
          forceRefresh,
          overrideGit: customGitInspector
            ? {
                available: gitState.available,
                branch: gitState.branch,
                currentCommit: gitState.currentCommit,
                warning: gitState.warning,
              }
            : undefined,
        });
      }

      const combinedPending = Array.from(
        new Set([
          ...mergePendingMigrations(dbInspection, gitState),
          ...(githubCheck?.compareMigrationFiles || []),
        ])
      ).sort();

      const resolvedCurrentCommit = githubCheck
        ? githubCheck.currentCommit
        : gitState.currentCommit;
      const resolvedTargetCommit =
        githubCheck && githubCheck.githubReachable && githubCheck.targetCommit !== 'unknown'
          ? githubCheck.targetCommit
          : gitState.targetCommit;
      const resolvedHasUpdates = githubCheck
        ? githubCheck.hasUpdates || combinedPending.length > 0
        : gitState.hasUpdates || combinedPending.length > 0;
      const installedVersion = githubCheck?.installedVersion || readPackageVersion();

      const readiness = evaluateDeploymentReadiness({
        actorRole: req.user!.role,
        githubCheck,
        dbInspection,
        combinedPendingMigrations: combinedPending,
        hasCustomDeployRunner: Boolean(customDeployBatRunner),
      });

      const checkedAt = githubCheck?.checkedAt || new Date().toISOString();

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'DEPLOYMENT_VERSION_CHECKED',
        targetType: 'DEPLOYMENT',
        targetId: resolvedTargetCommit,
        result: githubCheck && !githubCheck.githubReachable ? 'FAILURE' : 'SUCCESS',
        errorCode: githubCheck?.githubErrorCode || null,
        detail: {
          repository: cfg.github.repo,
          branch: cfg.github.branch,
          status: githubCheck?.status || (resolvedHasUpdates ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE'),
          currentCommit: resolvedCurrentCommit,
          targetCommit: resolvedTargetCommit,
          commitsBehind: githubCheck?.commitsBehind || 0,
          pendingMigrations: combinedPending,
          canDeploy: readiness.canDeploy,
          forceRefresh,
          fromCache: Boolean(githubCheck?.fromCache),
        },
      });

      res.json({
        repository: cfg.github.repo,
        repositoryUrl: `https://github.com/${cfg.github.repo}`,
        checkedAt,
        currentVersion: installedVersion,
        installedVersion,
        installedReleaseTag: githubCheck?.installedReleaseTag || null,
        latestVersion: githubCheck?.latestVersion || null,
        latestRelease: githubCheck?.latestRelease || null,
        currentCommit: resolvedCurrentCommit,
        currentCommitShort:
          resolvedCurrentCommit && resolvedCurrentCommit !== 'unknown'
            ? resolvedCurrentCommit.slice(0, 8)
            : 'unknown',
        targetCommit: resolvedTargetCommit,
        targetCommitShort:
          resolvedTargetCommit && resolvedTargetCommit !== 'unknown'
            ? resolvedTargetCommit.slice(0, 8)
            : 'unknown',
        branch: githubCheck?.branch || gitState.branch,
        status: githubCheck?.status || (resolvedHasUpdates ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE'),
        statusLabelThai:
          githubCheck?.statusLabelThai ||
          (resolvedHasUpdates ? 'พบการอัปเดตใหม่' : 'เป็นเวอร์ชันล่าสุดแล้ว'),
        hasUpdates: resolvedHasUpdates,
        githubReachable: githubCheck ? githubCheck.githubReachable : true,
        githubError: githubCheck?.githubError || null,
        githubErrorCode: githubCheck?.githubErrorCode || null,
        remediationThai: githubCheck?.remediationThai || null,
        tokenConfigured: githubCheck ? githubCheck.tokenConfigured : cfg.github.tokenConfigured,
        tokenMaskedHint: githubCheck ? githubCheck.tokenMaskedHint : cfg.github.tokenMaskedHint,
        fromCache: githubCheck ? githubCheck.fromCache : false,
        cacheExpiresAt: githubCheck?.cacheExpiresAt || null,
        cacheTtlMinutes:
          githubCheck?.cacheTtlMinutes || Math.max(1, Math.round(cfg.github.cacheTtlMs / 60000)),
        isStale: Boolean(githubCheck?.isStale),
        staleWarningThai: githubCheck?.staleWarningThai ?? null,
        lastSuccessfulCheckedAt: githubCheck?.lastSuccessfulCheckedAt ?? null,
        cooldownActive: Boolean(githubCheck?.cooldownActive),
        cooldownUntil: githubCheck?.cooldownUntil ?? null,
        cooldownUntilThai: githubCheck?.cooldownUntilThai ?? null,
        rateLimit: githubCheck?.rateLimit || null,
        commitsBehind: githubCheck?.commitsBehind || 0,
        commitsAhead: githubCheck?.commitsAhead || 0,
        latestCommitDate: githubCheck?.latestCommitDate || null,
        latestCommitMessage: githubCheck?.latestCommitMessage || null,
        latestCommitAuthor: githubCheck?.latestCommitAuthor || null,
        localGitAvailable: githubCheck ? githubCheck.localGitAvailable : gitState.available,
        workingTreeClean: githubCheck ? githubCheck.workingTreeClean : null,
        dirtyFiles: githubCheck?.dirtyFiles || [],
        gitWarning: gitState.warning || null,
        changelog: githubCheck?.changelog || null,
        readiness,
        appliedMigrations: dbInspection.appliedMigrations,
        pendingMigrations: combinedPending,
        pendingMigrationDetails: dbInspection.pendingDetails,
        checksumMismatches: dbInspection.checksumMismatches,
        schemaVerification: dbInspection.schemaVerification,
        migrationApprovalRequired: combinedPending.length > 0,
        backupPolicy: {
          appOnly: true,
          backupBeforeGitPull: true,
          storedOutsideGitRepo: true,
          defaultBackupRoot: process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR || 'C:\\SamAttDeploySnapshots',
          databaseTarget: cfg.samAttDb.database,
        },
        availableRelease: {
          version: githubCheck?.latestVersion || installedVersion,
          commitSha: resolvedTargetCommit,
          status:
            githubCheck && !githubCheck.githubReachable
              ? 'GITHUB_UNREACHABLE'
              : combinedPending.length > 0
                ? 'DB_SCHEMA_CHANGE_BLOCKED'
                : githubCheck?.status || (resolvedHasUpdates ? 'UPDATE_AVAILABLE' : 'UP_TO_DATE'),
          releaseNotes:
            githubCheck?.changelog?.noticeThai ||
            'ตรวจสอบข้อมูลจาก GitHub Repository โดยตรง',
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

settingsRouter.post(
  '/deployment/github-token',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const isClear = req.body?.clear === true;
      const rawToken = typeof req.body?.token === 'string' ? req.body.token : '';

      if (!isClear && !rawToken.trim()) {
        res.status(400).json({
          error: 'INVALID_GITHUB_TOKEN_FORMAT',
          message: 'กรุณากรอก GITHUB_TOKEN ก่อนบันทึก',
        });
        return;
      }

      let persisted: {
        envFilePath: string;
        tokenConfigured: boolean;
        tokenMaskedHint: string | null;
      };
      try {
        persisted = persistGitHubTokenToEnvFile(isClear ? null : rawToken);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'INVALID_GITHUB_TOKEN_FORMAT';
        res.status(400).json({
          error: 'INVALID_GITHUB_TOKEN_FORMAT',
          message: sanitizeDeploymentLog(msg.replace(/^INVALID_GITHUB_TOKEN_FORMAT:\s*/i, ''), [rawToken]),
        });
        return;
      }

      // ล้าง In-memory Cache & ETag Cache ทันทีเพื่อให้ตรวจสอบใหม่ด้วย Token ล่าสุด
      clearGitHubUpdateCache();

      const [dbInspection, gitState] = await Promise.all([
        inspectMigrationsDetailedReadOnly(),
        inspectGitDeploymentState(true),
      ]);

      const skipExternalGithubInLegacyMockTest =
        process.env.NODE_ENV === 'test' && Boolean(customGitInspector) && !hasCustomGitHubFetcherForTests();

      let githubCheck: GitHubVersionCheckResult | null = null;
      if (!skipExternalGithubInLegacyMockTest) {
        githubCheck = await checkGitHubUpdates({
          forceRefresh: true,
          overrideGit: customGitInspector
            ? {
                available: gitState.available,
                branch: gitState.branch,
                currentCommit: gitState.currentCommit,
                warning: gitState.warning,
              }
            : undefined,
        });
      }

      const combinedPending = Array.from(
        new Set([
          ...mergePendingMigrations(dbInspection, gitState),
          ...(githubCheck?.compareMigrationFiles || []),
        ])
      ).sort();

      const readiness = evaluateDeploymentReadiness({
        actorRole: req.user!.role,
        githubCheck,
        dbInspection,
        combinedPendingMigrations: combinedPending,
        hasCustomDeployRunner: Boolean(customDeployBatRunner),
      });

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: isClear ? 'GITHUB_TOKEN_CLEARED' : 'GITHUB_TOKEN_UPDATED',
        targetType: 'DEPLOYMENT',
        targetId: persisted.tokenMaskedHint || 'NONE',
        result: githubCheck && !githubCheck.githubReachable ? 'FAILURE' : 'SUCCESS',
        errorCode: githubCheck?.githubErrorCode || null,
        detail: {
          tokenConfigured: persisted.tokenConfigured,
          tokenMaskedHint: persisted.tokenMaskedHint,
          githubReachable: githubCheck ? githubCheck.githubReachable : null,
          githubErrorCode: githubCheck?.githubErrorCode || null,
        },
      });

      const cfg = loadConfig();
      res.json({
        success: true,
        cleared: isClear,
        tokenConfigured: persisted.tokenConfigured,
        tokenMaskedHint: persisted.tokenMaskedHint,
        message: isClear
          ? 'ล้างค่า GITHUB_TOKEN ในไฟล์ .env และรีโหลดค่าฝั่ง Server เรียบร้อยแล้ว'
          : githubCheck?.githubReachable
            ? 'บันทึก GITHUB_TOKEN ลงไฟล์ .env รีโหลดค่า และเชื่อมต่อ GitHub API สำเร็จแล้ว'
            : 'บันทึก GITHUB_TOKEN ลงไฟล์ .env และรีโหลดค่าแล้ว แต่การเชื่อมต่อ GitHub API ยังพบข้อผิดพลาด',
        checkResult: githubCheck
          ? {
              repository: cfg.github.repo,
              repositoryUrl: `https://github.com/${cfg.github.repo}`,
              checkedAt: githubCheck.checkedAt,
              currentVersion: githubCheck.installedVersion,
              installedVersion: githubCheck.installedVersion,
              installedReleaseTag: githubCheck.installedReleaseTag,
              latestVersion: githubCheck.latestVersion,
              latestRelease: githubCheck.latestRelease,
              currentCommit: githubCheck.currentCommit,
              currentCommitShort: githubCheck.currentCommitShort,
              targetCommit: githubCheck.targetCommit,
              targetCommitShort: githubCheck.targetCommitShort,
              branch: githubCheck.branch,
              status: githubCheck.status,
              statusLabelThai: githubCheck.statusLabelThai,
              hasUpdates: githubCheck.hasUpdates || combinedPending.length > 0,
              githubReachable: githubCheck.githubReachable,
              githubError: githubCheck.githubError,
              githubErrorCode: githubCheck.githubErrorCode,
              remediationThai: githubCheck.remediationThai,
              tokenConfigured: persisted.tokenConfigured,
              tokenMaskedHint: persisted.tokenMaskedHint,
              fromCache: githubCheck.fromCache,
              cacheExpiresAt: githubCheck.cacheExpiresAt,
              cacheTtlMinutes: githubCheck.cacheTtlMinutes,
              isStale: Boolean(githubCheck.isStale),
              staleWarningThai: githubCheck.staleWarningThai ?? null,
              lastSuccessfulCheckedAt: githubCheck.lastSuccessfulCheckedAt ?? null,
              cooldownActive: Boolean(githubCheck.cooldownActive),
              cooldownUntil: githubCheck.cooldownUntil ?? null,
              cooldownUntilThai: githubCheck.cooldownUntilThai ?? null,
              rateLimit: githubCheck.rateLimit,
              commitsBehind: githubCheck.commitsBehind,
              commitsAhead: githubCheck.commitsAhead,
              latestCommitDate: githubCheck.latestCommitDate,
              latestCommitMessage: githubCheck.latestCommitMessage,
              latestCommitAuthor: githubCheck.latestCommitAuthor,
              localGitAvailable: githubCheck.localGitAvailable,
              workingTreeClean: githubCheck.workingTreeClean,
              dirtyFiles: githubCheck.dirtyFiles,
              changelog: githubCheck.changelog,
              readiness,
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
            }
          : null,
        readiness,
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
  async (req, res, next) => {
    try {
      const requestedJobId = typeof req.query.jobId === 'string' ? req.query.jobId.trim() : '';
      const syncedLatest = await syncFinishedDiskJobToHistory(req.user?.username || 'admin');
      const diskJob = requestedJobId ? readPersistentDeployJob(requestedJobId) || syncedLatest : syncedLatest;
      const lockInfo = getDeployLockStatus();
      const latest = await dbQuery('SELECT * FROM deployment_history ORDER BY id DESC LIMIT 1');
      const diskActive =
        diskJob && (diskJob.status === 'PENDING' || diskJob.status === 'RUNNING') ? diskJob : null;

      res.json({
        inProgress:
          isDeploymentInProgress() ||
          batDeploymentRunning ||
          lockInfo.locked ||
          Boolean(diskActive),
        lock: lockInfo,
        job: diskJob,
        activeJob: diskActive || getActiveJobByType('DEPLOYMENT_RUN'),
        latestJob: diskJob || getLatestJobByType('DEPLOYMENT_RUN'),
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

// B15. Application-Only One-Button Deployment (8 Steps, Detached Survival & No DB Management — ADMIN Only)
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

      const activeLock = getDeployLockStatus();
      const currentDiskJob = readLatestPersistentDeployJob();
      const diskRunning =
        currentDiskJob && (currentDiskJob.status === 'PENDING' || currentDiskJob.status === 'RUNNING');

      if (isDeploymentInProgress() || batDeploymentRunning || activeLock.locked || diskRunning) {
        res.status(409).json({
          status: 'FAILED',
          error: 'DEPLOYMENT_ALREADY_IN_PROGRESS',
          message: 'กำลังมีการอัปเดตระบบทำงานอยู่ กรุณารอให้เสร็จสิ้นก่อนสั่งอัปเดตซ้ำ',
          activeJob: currentDiskJob || getActiveJobByType('DEPLOYMENT_RUN'),
          lock: activeLock,
          requestId: req.requestId,
        });
        return;
      }

      // 1. ตรวจสอบ Migration ที่ค้างอยู่และสถานะ Git (ป้องกันการอัปเดตซ้ำและป้องกัน DB Schema Change)
      const [dbInspection, gitState] = await Promise.all([
        inspectMigrationsDetailedReadOnly(),
        inspectGitDeploymentState(true),
      ]);

      if (dbInspection.checksumMismatches.length > 0) {
        res.status(409).json({
          status: 'FAILED',
          error: 'MIGRATION_CHECKSUM_MISMATCH',
          checksumMismatches: dbInspection.checksumMismatches,
          message:
            'ตรวจพบไฟล์ Migration ที่เคยรันไปแล้วถูกแก้ไขค่า Checksum ระบบระงับการอัปเดตเพื่อความปลอดภัย กรุณาติดต่อผู้ดูแลระบบ/DBA ก่อนดำเนินการ',
          requestId: req.requestId,
        });
        return;
      }

      const combinedPending = mergePendingMigrations(dbInspection, gitState);
      const expectedTargetCommit = gitState.targetCommit || gitState.currentCommit;

      // 2. Database Non-Interference Block: ห้ามอัปเดตผ่านหน้าเว็บเมื่อมี Database Migration ค้างหรือเปลี่ยนแปลง (แม้ส่ง approveMigrations มา)
      if (combinedPending.length > 0) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_BLOCKED_DB_SCHEMA_CHANGE',
          targetType: 'DEPLOYMENT',
          targetId: expectedTargetCommit,
          result: 'BLOCKED',
          errorCode: 'DB_SCHEMA_CHANGE_BLOCKED',
          detail: {
            targetCommit: expectedTargetCommit,
            currentCommit: gitState.currentCommit,
            pendingMigrations: combinedPending,
          },
        });

        res.status(409).json({
          status: 'FAILED',
          error: 'DB_SCHEMA_CHANGE_BLOCKED',
          message: 'เวอร์ชันนี้ต้องมีการปรับปรุงโครงสร้างฐานข้อมูล กรุณาติดต่อผู้ดูแลระบบก่อนอัปเดต',
          targetCommit: expectedTargetCommit,
          currentCommit: gitState.currentCommit,
          pendingMigrations: combinedPending,
          requestId: req.requestId,
        });
        return;
      }

      // 3. No-Update Protection: ห้ามอัปเดตซ้ำเมื่อ Installed Commit == Target Commit
      const isSameCommitUpToDate =
        gitState.available &&
        gitState.currentCommit &&
        expectedTargetCommit &&
        gitState.currentCommit !== 'unknown' &&
        expectedTargetCommit !== 'unknown' &&
        gitState.currentCommit === expectedTargetCommit &&
        !gitState.hasUpdates;

      if (isSameCommitUpToDate) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_BLOCKED_NO_UPDATE_AVAILABLE',
          targetType: 'DEPLOYMENT',
          targetId: expectedTargetCommit,
          result: 'BLOCKED',
          errorCode: 'NO_UPDATE_AVAILABLE',
          detail: {
            currentCommit: gitState.currentCommit,
            targetCommit: expectedTargetCommit,
          },
        });

        res.status(409).json({
          status: 'NO_CHANGES',
          error: 'NO_UPDATE_AVAILABLE',
          message: 'เป็นเวอร์ชันล่าสุดแล้ว (Commit บนเครื่องตรงกับ GitHub) จึงไม่ต้องดำเนินการอัปเดตซ้ำ',
          currentCommit: gitState.currentCommit,
          targetCommit: expectedTargetCommit,
          requestId: req.requestId,
        });
        return;
      }

      const windowsScriptPath = 'C:\\inetpub\\wwwroot\\Sam_Att\\deployment\\Deploy_Sam_Att.bat';
      const localScriptPath = path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.bat');
      const resolvedScriptPath = fs.existsSync(windowsScriptPath)
        ? windowsScriptPath
        : localScriptPath;
      const resolvedPs1Path = path.join(path.dirname(resolvedScriptPath), 'Deploy_Sam_Att.ps1');
      const resolvedAppDir = path.dirname(path.dirname(resolvedScriptPath));

      if (!fs.existsSync(resolvedScriptPath) && !customDeployBatRunner) {
        res.status(404).json({
          status: 'FAILED',
          error: 'DEPLOY_SCRIPT_NOT_FOUND',
          message: `ไม่พบไฟล์สคริปต์อัปเดตที่กำหนด (${windowsScriptPath})`,
          requestId: req.requestId,
        });
        return;
      }

      const jobId = generateDeployJobId('appdeploy');
      const jobStatusFile = getJobFilePath(jobId);
      const lockFile = getDeployLockFilePath();
      const diskLogPath = path.join(getDeployJobsDir(), `${jobId}.log`);
      const cliArgs: string[] = [
        '-NonInteractive',
        '-JobId',
        jobId,
        '-JobStatusFile',
        jobStatusFile,
        '-LockFile',
        lockFile,
      ];

      // On real Windows Server (without test runner), spawn detached so backend restart never kills caller!
      if (!customDeployBatRunner && process.platform === 'win32') {
        const useDirectPs1 = fs.existsSync(resolvedPs1Path);
        const exeName = useDirectPs1 ? 'powershell.exe' : 'cmd.exe';
        const exeArgs = useDirectPs1
          ? [
              '-NoProfile',
              '-ExecutionPolicy',
              'Bypass',
              '-File',
              resolvedPs1Path,
              '-AppDir',
              resolvedAppDir,
              '-LogFilePath',
              diskLogPath,
              ...cliArgs,
            ]
          : ['/c', resolvedScriptPath, ...cliArgs];

        const initialJob = createPersistentDeployJob({
          jobId,
          jobType: 'APP_UPDATE',
          actorUsername: req.user!.username,
          commitBefore: gitState.currentCommit,
          targetCommit: expectedTargetCommit,
          logFilePath: diskLogPath,
        });
        initialJob.status = 'RUNNING';
        initialJob.steps[0].status = 'RUNNING';
        initialJob.steps[0].startedAt = new Date().toISOString();
        savePersistentDeployJob(initialJob);
        acquireDeployLock({ jobId, pid: process.pid, actorUsername: req.user!.username });

        try {
          const child = spawn(exeName, exeArgs, {
            cwd: resolvedAppDir,
            env: {
              ...process.env,
              SAM_ATT_NO_PAUSE: '1',
            },
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          if (child.pid) {
            acquireDeployLock({ jobId, pid: child.pid, actorUsername: req.user!.username });
            savePersistentDeployJob({
              ...initialJob,
              pid: child.pid,
            });
          }
          child.unref();
        } catch (spawnErr: unknown) {
          releaseDeployLock(jobId);
          const msg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
          const failedJob = savePersistentDeployJob({
            ...initialJob,
            status: 'FAILED',
            completedAt: new Date().toISOString(),
            errorCode: 'BACKEND_START_FAILED',
            errorMessage: sanitizeDeploymentOutput(msg),
          });
          res.status(500).json({
            status: 'FAILED',
            error: 'BACKEND_START_FAILED',
            jobId,
            job: failedJob,
            message: `ไม่สามารถเริ่มสคริปต์อัปเดตบน Windows ได้: ${sanitizeDeploymentOutput(msg)}`,
            requestId: req.requestId,
          });
          return;
        }

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_BAT_STARTED_DETACHED',
          targetType: 'DEPLOYMENT',
          targetId: expectedTargetCommit,
          result: 'SUCCESS',
          detail: {
            jobId,
            commitBefore: gitState.currentCommit,
            targetCommit: expectedTargetCommit,
            detached: true,
          },
        });

        res.status(202).json({
          status: 'RUNNING',
          detached: true,
          jobId,
          scriptPath: useDirectPs1 ? resolvedPs1Path : resolvedScriptPath,
          commitBefore: gitState.currentCommit,
          targetCommit: expectedTargetCommit,
          job: readPersistentDeployJob(jobId) || initialJob,
          message:
            'เริ่มกระบวนการอัปเดต Application 8 ขั้นตอนแล้ว (รองรับการรีสตาร์ท Sam_Att อัตโนมัติระหว่างอัปเดต)',
          requestId: req.requestId,
        });
        return;
      }

      if (!customDeployBatRunner) {
        const centralJob = startCentralJob({
          jobType: 'DEPLOYMENT_RUN',
          actorUsername: req.user!.username,
          initialStep: 'ไม่รองรับการรันสคริปต์ Windows ในสภาพแวดล้อมปัจจุบัน',
          stage: 'PREFLIGHT',
          totalCount: 8,
        });
        failCentralJob(centralJob.jobId, {
          errorCode: 'UNSUPPORTED_OS_ENVIRONMENT',
          errorMessage:
            'การรันสคริปต์อัปเดต Deploy_Sam_Att.ps1 รองรับเฉพาะบนเครื่อง Windows Server เท่านั้น (สภาพแวดล้อมปัจจุบันไม่สามารถเรียก PowerShell Windows Service ได้)',
          currentStep: 'ไม่รองรับการรันสคริปต์ Windows ในสภาพแวดล้อมปัจจุบัน',
        });
        res.status(501).json({
          status: 'FAILED',
          error: 'UNSUPPORTED_OS_ENVIRONMENT',
          jobId: centralJob.jobId,
          scriptPath: resolvedScriptPath,
          diagnostic: {
            exitCode: 1,
            failedStepNumber: 1,
            failedStepName: 'Preflight Check',
            errorCode: 'UNSUPPORTED_OS_ENVIRONMENT',
            detectedCause: `สภาพแวดล้อมเซิร์ฟเวอร์ปัจจุบันคือ ${process.platform} ไม่ใช่ Windows Server`,
            remediation: 'ดำเนินการอัปเดตจริงบนเครื่อง Windows Server ของโรงพยาบาลสามชุก (C:\\inetpub\\wwwroot\\Sam_Att)',
            rollbackStatus: 'NO_CHANGES_APPLIED',
            rollbackStatusThai: 'หยุดก่อนเปลี่ยนแปลงระบบ — โค้ดและฐานข้อมูลเดิมไม่ถูกกระทบ',
          },
          message:
            'การรันสคริปต์อัปเดต Deploy_Sam_Att.ps1 รองรับเฉพาะบนเครื่อง Windows Server เท่านั้น (สภาพแวดล้อมปัจจุบันไม่สามารถเรียก PowerShell Windows Service ได้)',
          requestId: req.requestId,
        });
        return;
      }

      // Test Runner path (synchronous test double execution with full persistent jobStore + lock coverage)
      batDeploymentRunning = true;
      const startTime = Date.now();
      const job = startCentralJob({
        jobType: 'DEPLOYMENT_RUN',
        actorUsername: req.user!.username,
        initialStep: 'ตรวจสอบความพร้อมระบบและเตรียมอัปเดต Application (8 ขั้นตอน)...',
        stage: 'PREFLIGHT',
        totalCount: 8,
      });

      const diskJob = createPersistentDeployJob({
        jobId,
        jobType: 'APP_UPDATE',
        actorUsername: req.user!.username,
        commitBefore: gitState.currentCommit,
        targetCommit: expectedTargetCommit,
        logFilePath: diskLogPath,
        pid: process.pid,
      });
      acquireDeployLock({ jobId, pid: process.pid, actorUsername: req.user!.username });

      try {
        updateCentralJobStep(job.jobId, {
          stage: 'BACKING_UP',
          currentStep: 'กำลังรันสคริปต์อัปเดต Application 8 ขั้นตอน Deploy_Sam_Att.ps1...',
          processedCount: 2,
          totalCount: 8,
        });

        const batResult = await customDeployBatRunner(resolvedScriptPath, cliArgs);
        const safeStdout = sanitizeDeploymentOutput(batResult.stdout);
        const safeStderr = sanitizeDeploymentOutput(batResult.stderr);
        const parsedMeta = parseDeployOutputMetadata(`${safeStdout}\n${safeStderr}`);
        const success = batResult.exitCode === 0;
        const releaseVersion = readPackageVersion();
        const statusText = success ? 'SUCCESS' : 'FAILED';
        const commitBeforeVal = parsedMeta.commitBefore || gitState.currentCommit || 'unknown';
        const recordedCommit = parsedMeta.commitAfter || expectedTargetCommit || 'unknown';
        const diagnostic = success
          ? null
          : diagnoseDeploymentFailure(batResult.exitCode, safeStdout, safeStderr);

        const isRolledBack = Boolean(
          !success &&
            (diagnostic?.rollbackStatus === 'ROLLED_BACK_CODE' ||
              /ROLLED BACK SAFELY TO PREVIOUS VERSION/i.test(safeStdout))
        );

        const updatedSteps = createInitialSteps('APP_UPDATE').map((step) => {
          if (success) {
            return {
              ...step,
              status: 'PASS' as const,
              startedAt: diskJob.startedAt,
              completedAt: new Date().toISOString(),
            };
          }
          const failNum = diagnostic?.failedStepNumber ?? 8;
          if (step.stepNumber < failNum) {
            return { ...step, status: 'PASS' as const };
          }
          if (step.stepNumber === failNum) {
            return {
              ...step,
              status: 'FAIL' as const,
              detail: diagnostic?.detectedCause || safeStderr || 'Deployment step failed',
            };
          }
          return { ...step, status: 'SKIP' as const };
        });

        const persistedFinal = savePersistentDeployJob({
          ...diskJob,
          status: success ? 'SUCCESS' : isRolledBack ? 'ROLLED_BACK' : 'FAILED',
          completedAt: new Date().toISOString(),
          currentStepNumber: success ? 8 : diagnostic?.failedStepNumber || 8,
          currentStepName: success ? 'Final Report' : diagnostic?.failedStepName || 'Deployment',
          currentStepLabelThai: success
            ? 'อัปเดต Application 8 ขั้นตอนสำเร็จ'
            : diagnostic?.failedStepName || 'Deployment Failed',
          progressPercent: 100,
          commitBefore: commitBeforeVal,
          commitAfter: recordedCommit,
          snapshotDir: parsedMeta.backupDir,
          rolledBack: isRolledBack,
          errorCode: success ? null : diagnostic?.errorCode || `EXIT_CODE_${batResult.exitCode}`,
          errorMessage: success ? null : diagnostic?.detectedCause || safeStderr || null,
          historyRecorded: true,
          logTail: `${safeStdout}\n${safeStderr}`.split(/\r?\n/).filter(Boolean).slice(-120),
          steps: updatedSteps,
        });

        const structuredNotes = success
          ? `[COMMIT ${commitBeforeVal.slice(0, 8)} -> ${recordedCommit.slice(0, 8)}]\n${safeStdout.slice(-900)}`
          : [
              `[FAIL Step ${diagnostic?.failedStepNumber ?? '?'}: ${diagnostic?.failedStepName} | ${diagnostic?.errorCode}]`,
              `สาเหตุ: ${diagnostic?.detectedCause}`,
              `Commit: ${commitBeforeVal.slice(0, 8)} -> ${recordedCommit.slice(0, 8)}`,
              safeStdout ? `STDOUT:\n${safeStdout.slice(-500)}` : '',
              safeStderr ? `STDERR:\n${safeStderr.slice(-300)}` : '',
            ]
              .filter(Boolean)
              .join('\n')
              .slice(0, 1800);

        const insertRes = await dbExecute(
          `INSERT INTO deployment_history
             (release_version, commit_sha, artifact_sha256, action_type, status, backup_archive_path, preflight_passed, notes, executed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            releaseVersion,
            recordedCommit.slice(0, 64),
            'app-only-verified',
            'DEPLOY_BAT',
            statusText,
            parsedMeta.backupDir ? parsedMeta.backupDir.slice(0, 255) : null,
            success ? 1 : 0,
            structuredNotes,
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
          errorCode: success ? null : diagnostic?.errorCode || `EXIT_CODE_${batResult.exitCode}`,
          detail: {
            jobId,
            scriptPath: batResult.scriptPath,
            exitCode: batResult.exitCode,
            durationMs: batResult.durationMs,
            commitBefore: commitBeforeVal,
            commitAfter: recordedCommit,
            snapshotDir: parsedMeta.backupDir,
            failedStepNumber: diagnostic?.failedStepNumber ?? null,
            failedStepName: diagnostic?.failedStepName ?? null,
            detectedErrorCode: diagnostic?.errorCode ?? null,
          },
        });

        if (!success) {
          const errCode = diagnostic?.errorCode || 'DEPLOYMENT_EXECUTION_FAILED';
          const errMsg = `การอัปเดตระบบไม่สำเร็จที่ขั้นตอน "${diagnostic?.failedStepName}" (${errCode}, Exit Code: ${batResult.exitCode}) — ${diagnostic?.detectedCause}`;

          failCentralJob(job.jobId, {
            errorCode: errCode,
            errorMessage: errMsg,
            currentStep: `ล้มเหลวที่ขั้นตอน ${diagnostic?.failedStepName || 'Deployment'}`,
            resultSummary: {
              deploymentId: insertRes.insertId,
              exitCode: batResult.exitCode,
              failedStepNumber: diagnostic?.failedStepNumber ?? null,
              failedStepName: diagnostic?.failedStepName ?? null,
              errorCode: errCode,
              snapshotDir: parsedMeta.backupDir,
            },
          });

          res.status(422).json({
            status: 'FAILED',
            error: errCode,
            jobId,
            job: persistedFinal,
            deploymentId: insertRes.insertId,
            exitCode: batResult.exitCode,
            scriptPath: batResult.scriptPath,
            commitBefore: commitBeforeVal,
            targetCommit: expectedTargetCommit,
            snapshotDir: parsedMeta.backupDir,
            backupDir: parsedMeta.backupDir,
            rolledBack: isRolledBack,
            diagnostic,
            output: safeStdout,
            errorOutput: safeStderr,
            message: errMsg,
            requestId: req.requestId,
          });
          return;
        }

        completeCentralJob(job.jobId, {
          status: 'SUCCESS',
          currentStep: 'อัปเดตระบบ Application 8 ขั้นตอนและตรวจสอบ Health Check สำเร็จ',
          processedCount: 8,
          totalCount: 8,
          resultSummary: {
            deploymentId: insertRes.insertId,
            commitBefore: commitBeforeVal,
            commitAfter: recordedCommit,
            snapshotDir: parsedMeta.backupDir,
          },
        });

        res.json({
          status: 'SUCCESS',
          jobId,
          job: persistedFinal,
          deploymentId: insertRes.insertId,
          releaseVersion,
          exitCode: 0,
          scriptPath: batResult.scriptPath,
          durationMs: batResult.durationMs,
          commitBefore: commitBeforeVal,
          commitAfter: recordedCommit,
          snapshotDir: parsedMeta.backupDir,
          backupDir: parsedMeta.backupDir,
          executedAt: new Date().toISOString(),
          executedBy: req.user!.username,
          output: safeStdout,
          message: 'อัปเดตระบบ Sam_Att V2 Standalone สำเร็จเรียบร้อยแล้ว',
        });
      } finally {
        releaseDeployLock(jobId);
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

// B16. Application-Only Safe Rollback (ADMIN Only — Restores Code & dist/ without touching Database or .env)
settingsRouter.post(
  '/deployment/rollback-app',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      if (req.body?.confirmRollback !== true) {
        res.status(400).json({
          status: 'FAILED',
          error: 'CONFIRMATION_REQUIRED',
          message: 'กรุณายืนยันการย้อนกลับเวอร์ชัน Application ก่อนดำเนินการ (confirmRollback: true)',
          requestId: req.requestId,
        });
        return;
      }

      const activeLock = getDeployLockStatus();
      const currentDiskJob = readLatestPersistentDeployJob();
      const diskRunning =
        currentDiskJob && (currentDiskJob.status === 'PENDING' || currentDiskJob.status === 'RUNNING');

      if (isDeploymentInProgress() || batDeploymentRunning || activeLock.locked || diskRunning) {
        res.status(409).json({
          status: 'FAILED',
          error: 'DEPLOYMENT_ALREADY_IN_PROGRESS',
          message: 'กำลังมีการอัปเดตหรือย้อนกลับระบบทำงานอยู่ กรุณารอให้เสร็จสิ้นก่อน',
          requestId: req.requestId,
        });
        return;
      }

      const snapshots = listAvailableAppSnapshots();
      const requestedSnapshotDir = typeof req.body?.snapshotDir === 'string' ? req.body.snapshotDir.trim() : '';
      let chosenSnapshot = snapshots[0] || null;
      if (requestedSnapshotDir) {
        const resolvedReq = path.resolve(requestedSnapshotDir);
        const matched = snapshots.find((s) => path.resolve(s.snapshotDir) === resolvedReq);
        if (!matched) {
          res.status(400).json({
            status: 'FAILED',
            error: 'INVALID_SNAPSHOT_DIR',
            message: 'โฟลเดอร์ Snapshot ที่เลือกไม่อยู่ในรายการที่ตรวจสอบได้หรืออยู่นอก C:\\SamAttDeploySnapshots',
            requestId: req.requestId,
          });
          return;
        }
        chosenSnapshot = matched;
      }

      if (!chosenSnapshot && !customDeployRollbackRunner) {
        res.status(404).json({
          status: 'FAILED',
          error: 'ROLLBACK_SNAPSHOT_NOT_FOUND',
          message: 'ไม่พบ Application Snapshot สำหรับย้อนกลับใน C:\\SamAttDeploySnapshots',
          requestId: req.requestId,
        });
        return;
      }

      const windowsPs1Path = 'C:\\inetpub\\wwwroot\\Sam_Att\\deployment\\Deploy_Sam_Att.ps1';
      const localPs1Path = path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.ps1');
      const resolvedPs1Path = fs.existsSync(windowsPs1Path) ? windowsPs1Path : localPs1Path;
      const resolvedAppDir = path.dirname(path.dirname(resolvedPs1Path));

      const jobId = generateDeployJobId('rollback');
      const jobStatusFile = getJobFilePath(jobId);
      const lockFile = getDeployLockFilePath();
      const diskLogPath = path.join(getDeployJobsDir(), `${jobId}.log`);
      const targetSnapshotPath = chosenSnapshot?.snapshotDir || requestedSnapshotDir || '';
      const rollbackArgs = [
        '-NonInteractive',
        '-RollbackOnly',
        '-JobId',
        jobId,
        '-JobStatusFile',
        jobStatusFile,
        '-LockFile',
        lockFile,
        ...(targetSnapshotPath ? ['-SnapshotDirToRestore', targetSnapshotPath] : []),
      ];

      if (!customDeployRollbackRunner && process.platform === 'win32') {
        const initialJob = createPersistentDeployJob({
          jobId,
          jobType: 'APP_ROLLBACK',
          actorUsername: req.user!.username,
          commitBefore: chosenSnapshot?.commitBefore || null,
          targetCommit: chosenSnapshot?.commitBefore || null,
          logFilePath: diskLogPath,
        });
        initialJob.status = 'RUNNING';
        initialJob.rollbackSnapshotDir = targetSnapshotPath;
        initialJob.steps[0].status = 'RUNNING';
        initialJob.steps[0].startedAt = new Date().toISOString();
        savePersistentDeployJob(initialJob);
        acquireDeployLock({ jobId, pid: process.pid, actorUsername: req.user!.username });

        const child = spawn(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            resolvedPs1Path,
            '-AppDir',
            resolvedAppDir,
            '-LogFilePath',
            diskLogPath,
            ...rollbackArgs,
          ],
          {
            cwd: resolvedAppDir,
            env: { ...process.env, SAM_ATT_NO_PAUSE: '1' },
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          }
        );
        if (child.pid) {
          acquireDeployLock({ jobId, pid: child.pid, actorUsername: req.user!.username });
          savePersistentDeployJob({ ...initialJob, pid: child.pid });
        }
        child.unref();

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_APP_ROLLBACK_STARTED',
          targetType: 'DEPLOYMENT',
          targetId: chosenSnapshot?.snapshotName || 'latest',
          result: 'SUCCESS',
          detail: {
            jobId,
            snapshotDir: targetSnapshotPath,
            commitBefore: chosenSnapshot?.commitBefore || null,
            databaseTouched: false,
          },
        });

        res.status(202).json({
          status: 'RUNNING',
          detached: true,
          jobId,
          snapshotDir: targetSnapshotPath,
          job: readPersistentDeployJob(jobId) || initialJob,
          message: 'เริ่มกระบวนการย้อนกลับ Application ไปยังเวอร์ชันก่อนหน้าแล้ว (ไม่แตะต้องฐานข้อมูลและ .env)',
          requestId: req.requestId,
        });
        return;
      }

      if (!customDeployRollbackRunner) {
        res.status(501).json({
          status: 'FAILED',
          error: 'UNSUPPORTED_OS_ENVIRONMENT',
          message: 'การสั่งย้อนกลับ Application อัตโนมัติรองรับเฉพาะบนเครื่อง Windows Server เท่านั้น',
          requestId: req.requestId,
        });
        return;
      }

      batDeploymentRunning = true;
      const diskJob = createPersistentDeployJob({
        jobId,
        jobType: 'APP_ROLLBACK',
        actorUsername: req.user!.username,
        commitBefore: chosenSnapshot?.commitBefore || null,
        targetCommit: chosenSnapshot?.commitBefore || null,
        logFilePath: diskLogPath,
        pid: process.pid,
      });
      acquireDeployLock({ jobId, pid: process.pid, actorUsername: req.user!.username });

      try {
        const rbResult = await customDeployRollbackRunner(resolvedPs1Path, rollbackArgs);
        const safeStdout = sanitizeDeploymentOutput(rbResult.stdout);
        const safeStderr = sanitizeDeploymentOutput(rbResult.stderr);
        const parsedMeta = parseDeployOutputMetadata(`${safeStdout}\n${safeStderr}`);
        const success = rbResult.exitCode === 0;
        const releaseVersion = readPackageVersion();
        const restoredCommit = parsedMeta.commitAfter || chosenSnapshot?.commitBefore || 'unknown';

        const persistedFinal = savePersistentDeployJob({
          ...diskJob,
          status: success ? 'SUCCESS' : 'FAILED',
          completedAt: new Date().toISOString(),
          currentStepNumber: 5,
          currentStepName: 'Health Check & Report',
          currentStepLabelThai: success ? 'ย้อนกลับ Application และ Health Check สำเร็จ' : 'การย้อนกลับ Application ล้มเหลว',
          progressPercent: 100,
          commitAfter: restoredCommit,
          rolledBack: success,
          rollbackSnapshotDir: parsedMeta.backupDir || targetSnapshotPath || null,
          errorCode: success ? null : 'ROLLBACK_FAILED',
          errorMessage: success ? null : safeStderr || 'Application rollback failed',
          historyRecorded: true,
          logTail: `${safeStdout}\n${safeStderr}`.split(/\r?\n/).filter(Boolean).slice(-120),
          steps: createInitialSteps('APP_ROLLBACK').map((s) => ({
            ...s,
            status: success ? ('PASS' as const) : ('FAIL' as const),
          })),
        });

        const insertRes = await dbExecute(
          `INSERT INTO deployment_history
             (release_version, commit_sha, artifact_sha256, action_type, status, backup_archive_path, preflight_passed, notes, executed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            releaseVersion,
            restoredCommit.slice(0, 64),
            'app-only-rollback',
            'APP_ROLLBACK',
            success ? 'SUCCESS' : 'FAILED',
            (parsedMeta.backupDir || targetSnapshotPath || null)?.slice(0, 255) || null,
            success ? 1 : 0,
            sanitizeDeploymentOutput(safeStdout || safeStderr).slice(0, 1500),
            req.user!.username,
          ]
        );

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'DEPLOYMENT_APP_ROLLBACK_COMPLETED',
          targetType: 'DEPLOYMENT',
          targetId: String(insertRes.insertId),
          result: success ? 'SUCCESS' : 'FAILURE',
          errorCode: success ? null : 'ROLLBACK_FAILED',
          detail: {
            jobId,
            snapshotDir: targetSnapshotPath || parsedMeta.backupDir,
            restoredCommit,
            databaseTouched: false,
          },
        });

        if (!success) {
          res.status(422).json({
            status: 'FAILED',
            error: 'ROLLBACK_FAILED',
            jobId,
            job: persistedFinal,
            output: safeStdout,
            errorOutput: safeStderr,
            message: 'การย้อนกลับ Application ไม่สำเร็จ กรุณาตรวจสอบ Log บนเซิร์ฟเวอร์',
            requestId: req.requestId,
          });
          return;
        }

        res.json({
          status: 'SUCCESS',
          jobId,
          job: persistedFinal,
          deploymentId: insertRes.insertId,
          restoredCommit,
          snapshotDir: targetSnapshotPath || parsedMeta.backupDir,
          databaseTouched: false,
          output: safeStdout,
          message: 'ย้อนกลับ Application ไปยังเวอร์ชันก่อนหน้าและตรวจสอบ Health Check สำเร็จแล้ว (ไม่แตะต้องฐานข้อมูล)',
        });
      } finally {
        releaseDeployLock(jobId);
        batDeploymentRunning = false;
      }
    } catch (err) {
      batDeploymentRunning = false;
      next(err);
    }
  }
);

settingsRouter.all('/deployment/rollback-app', (req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({
    status: 'FAILED',
    error: 'METHOD_NOT_ALLOWED',
    allowedMethods: ['POST'],
    receivedMethod: req.method,
    message: `Endpoint /api/Sam_Att/deployment/rollback-app รองรับเฉพาะคำสั่ง POST เท่านั้น`,
    requestId: req.requestId,
  });
});


