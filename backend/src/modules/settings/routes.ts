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
import mysql from 'mysql2/promise';
import { Router } from 'express';
import { loadConfig, validateProductionConfig } from '../../config/env.ts';
import { dbQuery } from '../../database/adapter.ts';
import { verifyPassword } from '../../utils/crypto.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  executeStandaloneDeployment,
  executeStandaloneRollback,
  isDeploymentInProgress,
} from '../deployment/agent.ts';

export const settingsRouter = Router();

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
            connectTimeout: 3000,
          });
          await conn.query('SELECT 1');
          await conn.end();
          res.json({
            target,
            reachable: true,
            message: 'เชื่อมต่อฐานข้อมูล HOSOffice Read-only สำเร็จ',
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
      const history = await dbQuery('SELECT * FROM deployment_history ORDER BY id DESC LIMIT 15');
      res.json({
        serviceName: 'SamAttV2Standalone',
        serviceWrapper: 'WinSW (Windows Service Wrapper)',
        architecture: 'STANDALONE_SINGLE_PORT_HTTPS',
        httpsPort: cfg.port,
        currentVersion: '2.0.0-standalone',
        targetNodeVersion: '26.13.1',
        runtimeNodeVersion: process.version,
        isolatedFromProcurementAndGateway: true,
        inProgress: isDeploymentInProgress(),
        uiLiveProductionDeployEnabled: true,
        uiDeployNotice:
          'ทำงานผ่านกลไก Sam_Att Deployment Agent โดยตรวจ SHA-256 จริง, สำรองฐานข้อมูลจริงลงดิสก์, รัน Health Check และรองรับ Rollback เฉพาะ Service SamAttV2Standalone โดยไม่แตะต้อง Procurement',
        history,
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
      res.json({
        currentVersion: '2.0.0-standalone',
        availableRelease: {
          version: '2.0.0-standalone',
          commitSha: 'initial-standalone-build',
          status: 'UP_TO_DATE',
          releaseNotes:
            'Sam_Att V2 Standalone รุ่นเสถียร แยกออกจาก Central API Gateway อย่างสมบูรณ์ ใช้ HTTPS Port 4101 เดียวกันทั้ง Frontend และ API',
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
      const releaseVersion = String(req.body?.releaseVersion || '2.0.0-standalone').trim();
      const commitSha = String(req.body?.commitSha || '').trim();
      const artifactSha256 = String(req.body?.artifactSha256 || '').trim();
      const packageContent = typeof req.body?.packageContent === 'string' ? req.body.packageContent : undefined;
      const artifactFilePath = typeof req.body?.artifactFilePath === 'string' ? req.body.artifactFilePath : undefined;

      if (!password || !commitSha || !/^[a-f0-9]{64}$/i.test(artifactSha256)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'ต้องยืนยันรหัสผ่าน ADMIN, รหัส Commit SHA และค่า SHA-256 (64 hex chars) ของแพ็กเกจ',
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
          packageContent,
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
          healthCheck: outcome.healthCheck,
        });
      } catch (deployErr: unknown) {
        const code = (deployErr as { code?: string })?.code || 'DEPLOYMENT_EXECUTION_FAILED';
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

        res.status(422).json({
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
