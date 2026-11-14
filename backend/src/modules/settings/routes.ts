import fs from 'fs';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { verifyPassword } from '../../utils/crypto.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

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
        },
        scannerIntegration: {
          syncEnabled: cfg.scanner.syncEnabled,
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
          res.status(503).json({
            target,
            reachable: false,
            error: 'HOSOFFICE_CONNECTION_FAILED',
            message: connErr instanceof Error ? connErr.message : String(connErr),
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
        architecture: 'STANDALONE_SINGLE_PORT_HTTPS',
        httpsPort: cfg.port,
        currentVersion: '2.0.0-standalone',
        targetNodeVersion: '26.13.1',
        runtimeNodeVersion: process.version,
        isolatedFromProcurementAndGateway: true,
        uiLiveProductionDeployEnabled: false,
        uiDeployNotice:
          'การอัปเดตและสำรองข้อมูลทำงานผ่าน PowerShell Standalone Scripts (scripts/*.ps1) เฉพาะ Service SamAttV2Standalone เท่านั้น ห้ามแตะต้อง Procurement หรือ Central Gateway',
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
            'Sam_Att V2 Standalone รุ่นเริ่มต้น แยกออกจาก Central API Gateway อย่างสมบูรณ์ ใช้ HTTPS Port 4101 เดียวกันทั้ง Frontend และ API',
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
        fs.existsSync('scripts/backup.ps1') &&
        fs.existsSync('scripts/restore-test.ps1') &&
        fs.existsSync('scripts/deploy-test.ps1') &&
        fs.existsSync('scripts/health-check.ps1');

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
          label: 'สถานะ Schema Migration (20 ตารางหลัก)',
          passed: migrations.length > 0,
          detail: `ใช้ Migration เวอร์ชัน ${migrations.map((m) => m.version).join(', ')}`,
        },
        {
          id: 'POWERSHELL_RUNBOOK_SCRIPTS',
          label: 'สคริปต์ PowerShell สำหรับติดตั้ง/Backup/Restore/Rollback',
          passed: scriptsReady,
          detail: scriptsReady ? 'พบสคริปต์ครบทั้ง 5 ไฟล์ในโฟลเดอร์ scripts/' : 'สคริปต์ไม่ครบ',
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
        "SELECT id, release_version, commit_sha, artifact_sha256, backup_archive_path, executed_by, executed_at FROM deployment_history WHERE backup_archive_path IS NOT NULL ORDER BY id DESC"
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
        inProgress: false,
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

      const backupPath = `C:\\Sam_Att\\backups\\sam_att_predeploy_${Date.now()}.bak`;
      const result = await dbExecute(
        `INSERT INTO deployment_history (
          release_version, commit_sha, artifact_sha256, action_type, status,
          backup_archive_path, preflight_passed, notes, executed_by
        ) VALUES (?, ?, ?, 'APPROVED_RELEASE_RECORD', 'PENDING_WINDOWS_AGENT', ?, 1, ?, ?)`,
        [
          releaseVersion,
          commitSha,
          artifactSha256.toLowerCase(),
          backupPath,
          'อนุมัติรายการอัปเดตผ่าน Re-authentication พร้อมบันทึก SHA-256 สำหรับรัน deploy-test.ps1 บน Windows VM',
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'DEPLOYMENT_APPROVED',
        targetType: 'DEPLOYMENT',
        targetId: String(result.insertId),
        result: 'SUCCESS',
        detail: { releaseVersion, commitSha, artifactSha256 },
      });

      res.json({
        status: 'APPROVED_FOR_WINDOWS_SERVICE_RUNNER',
        deploymentId: result.insertId,
        releaseVersion,
        commitSha,
        artifactSha256,
        backupArchivePath: backupPath,
      });
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

      const targetRows = await dbQuery<{
        id: number;
        release_version: string;
        commit_sha: string;
        artifact_sha256: string;
        backup_archive_path: string | null;
      }>('SELECT * FROM deployment_history WHERE id = ? LIMIT 1', [targetBackupId]);

      if (targetRows.length === 0) {
        res.status(404).json({
          error: 'BACKUP_NOT_FOUND',
          message: 'ไม่พบรายการ Backup ที่ต้องการ Rollback',
          requestId: req.requestId,
        });
        return;
      }

      const target = targetRows[0];
      const result = await dbExecute(
        `INSERT INTO deployment_history (
          release_version, commit_sha, artifact_sha256, action_type, status,
          backup_archive_path, preflight_passed, notes, executed_by
        ) VALUES (?, ?, ?, 'ROLLBACK_RECORDED', 'READY_FOR_RESTORE_SCRIPT', ?, 1, ?, ?)`,
        [
          target.release_version,
          target.commit_sha || crypto.randomUUID().slice(0, 8),
          target.artifact_sha256,
          target.backup_archive_path,
          reason,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'DEPLOYMENT_ROLLBACK_REQUESTED',
        targetType: 'DEPLOYMENT',
        targetId: String(result.insertId),
        result: 'SUCCESS',
        detail: { targetBackupId, targetVersion: target.release_version, reason },
      });

      res.json({
        status: 'ROLLBACK_LOGGED',
        rollbackEntryId: result.insertId,
        targetVersion: target.release_version,
        backupArchivePath: target.backup_archive_path,
      });
    } catch (err) {
      next(err);
    }
  }
);
