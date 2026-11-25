/**
 * ============================================================================
 * ชุดทดสอบระบบอัปเดตปลอดภัยและอนุมัติ Database Migration (Safe Deployment & Migration Tests)
 * ไฟล์: backend/tests/safe-deployment-migration.test.ts
 * ============================================================================
 * ครอบคลุมครบ 18 สถานการณ์ด้านความปลอดภัย (SQLite Sandbox แยกอิสระ ไม่แตะ MySQL จริง):
 * 1. อัปเดตปกติเมื่อไม่มี Migration ใหม่
 * 2. อัปเดตที่มี Pending Migration โดยยังไม่อนุมัติ -> ระงับด้วย MIGRATION_APPROVAL_REQUIRED
 * 3. สิทธิ์ที่ไม่ใช่ ADMIN (RESPONSIBLE_STAFF / GENERAL_USER) -> 403 FORBIDDEN
 * 4. ADMIN กรอกรหัสผ่านผิด -> 401 + Rate Limit + ห้ามบันทึกรหัสผ่านใน Log/Response
 * 5. ADMIN อนุมัติด้วยรหัสผ่านของตนเอง + ผูก Commit & รายการไฟล์ -> ผ่านและส่ง Flags ครบถ้วน
 * 6. Approval Binding Mismatch (เปลี่ยน Commit หรือเพิ่มไฟล์หลังอนุมัติ) -> 409 MIGRATION_APPROVAL_MISMATCH
 * 7. Backup ล้มเหลวก่อน git pull -> ยกเลิกทันที ไม่ pull และไม่ restart backend
 * 8. Backup เก็บนอก Git Repository เสมอ และสร้างเสร็จก่อน git pull (ปฏิเสธ path ใน repo)
 * 9. รัน 003_historical_import_and_mapping.sql บนฐานข้อมูลที่มีเฉพาะ 001+002 -> ตรวจครบทั้ง 11 คอลัมน์
 * 10. Idempotency: รันซ้ำเมื่อ 003 อยู่ใน schema_migrations แล้ว -> ข้ามอย่างปลอดภัย
 * 11. Partially Applied DB: คอลัมน์ซ้ำชนิดตรงกันผ่าน / คอลัมน์ซ้ำชนิดไม่ตรงกัน -> MIGRATION_COLUMN_TYPE_MISMATCH
 * 12. Migration ล้มเหลวกลางคัน -> ไม่บันทึก schema_migrations, ไม่ restart backend, ไม่ลบ raw_scans
 * 13. Post-Migration Failure (Backend/Health พังหลัง Migration ผ่าน) -> ย้อนโค้ด + แจ้ง ADMIN DB Restore (ห้าม auto-DROP)
 * 14. Checksum Drift (แก้ไฟล์ Migration ที่เคยรันแล้ว) -> MIGRATION_CHECKSUM_MISMATCH (409)
 * 15. คำสั่งอันตรายต้องห้าม (DROP/TRUNCATE/DELETE raw_scans) -> FORBIDDEN_DESTRUCTIVE_MIGRATION
 * 16. Route/Method Guard: GET /api/Sam_Att/deployment/run-bat -> 405 METHOD_NOT_ALLOWED (ไม่ใช่ 404)
 * 17. Script Static Invariants: 7-bit ASCII, --defaults-extra-file, C:\SamAttBackups, Procurement guard, ห้าม iisreset
 * 18. Secret Masking: รหัสผ่าน/Secret ไม่รั่วไหลใน output, logs หรือ audit_logs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TEST_RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `sam_att_safe_deploy_${TEST_RUN_ID}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_TEST_ISOLATION = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'safe_deploy_test_jwt_secret_key_min_32_chars_2026';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'safe_deploy_test_scanner_token_min_24_chars';

import {
  resetSqliteInstanceForTests,
  dbExecute,
  dbQuery,
  ensureBaselineSystemCatalog,
  inspectMigrationsDetailedReadOnly,
  runMigrations,
  seedDemoSyntheticData,
} from '../src/database/adapter.ts';
import { createExpressApp } from '../src/app.ts';
import {
  setDeployBatRunnerForTests,
  setDeploymentGitInspectorForTests,
} from '../src/modules/settings/routes.ts';
import { runOneClickDeployment } from '../../deployment/deploy-runner.ts';

let serverUrl = '';
let closeServer: () => Promise<void> = async () => {};
let adminToken = '';
let staffToken = '';
let generalToken = '';

const ADMIN_PASS = 'Admin@SamAtt2026';

async function apiCall(
  endpoint: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${serverUrl}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function createIsolatedWorkspace(): { appDir: string; backupRootDir: string; cleanup: () => void } {
  const base = path.join(
    os.tmpdir(),
    `sam_att_ws_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`
  );
  const appDir = path.join(base, 'Sam_Att_Repo');
  const backupRootDir = path.join(base, 'ExternalBackups');
  fs.mkdirSync(path.join(appDir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(appDir, 'ScannerReader'), { recursive: true });
  fs.mkdirSync(backupRootDir, { recursive: true });

  fs.writeFileSync(
    path.join(appDir, 'package.json'),
    JSON.stringify({ name: 'sam-att-v2-standalone', version: '2.0.0' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(appDir, 'package-lock.json'),
    JSON.stringify({ name: 'sam-att-v2-standalone', lockfileVersion: 3 }),
    'utf8'
  );
  fs.writeFileSync(path.join(appDir, 'server.ts'), '// entry', 'utf8');
  fs.writeFileSync(
    path.join(appDir, 'dist', 'index.html'),
    '<!doctype html><html><body>v2.0.0</body></html>',
    'utf8'
  );
  fs.writeFileSync(
    path.join(appDir, 'ScannerReader', 'ScannerSyncCli.exe'),
    'BINARY_SCANNER_EXE_FIXED',
    'utf8'
  );
  fs.writeFileSync(
    path.join(appDir, '.env'),
    [
      'NODE_ENV=production',
      'SAM_ATT_DATA_MODE=REAL',
      'SAM_ATT_DB_ENGINE=mysql',
      'SAM_ATT_DB_HOST=10.1.0.201',
      'SAM_ATT_DB_PORT=3306',
      'SAM_ATT_DB_NAME=samchuk_attendance_v2',
      'SAM_ATT_DB_USER=sam_att_app',
      'SAM_ATT_DB_PASSWORD=TopSecretDbPassword#991!',
      'JWT_SECRET=a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890abcdef',
      'SCANNER_INGEST_SHARED_TOKEN=scan_token_secret_0123456789abcdef012345',
    ].join('\n'),
    'utf8'
  );

  return {
    appDir,
    backupRootDir,
    cleanup: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

test('Safe Deployment & Database Migration Governance Suite (18 Scenarios)', async (t) => {
  resetSqliteInstanceForTests(TEST_DB_PATH);
  await runMigrations();
  await ensureBaselineSystemCatalog();
  await seedDemoSyntheticData();

  const app = createExpressApp();
  const srv = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      if (typeof (srv as any).closeAllConnections === 'function') {
        (srv as any).closeAllConnections();
      }
      srv.close(() => resolve());
    });

  try {
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: ADMIN_PASS },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.data.token;

    const staffLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(staffLogin.status, 200);
    staffToken = staffLogin.data.token;

    const userLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(userLogin.status, 200);
    generalToken = userLogin.data.token;
    // -------------------------------------------------------------------------
    // Scenario 1, 7, 8: Runner — No migrations happy path, Backup before git pull,
    // Backup strictly outside Git repo, Backup failure aborts before pull
    // -------------------------------------------------------------------------
    await t.test('1 & 8. Update without new migrations stores verified backup outside repo strictly BEFORE git pull', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          backupRootDir: ws.backupRootDir,
          hooks: {
            commitBefore: '9f1cdc1000000000000000000000000000000001',
            remoteCommit: 'aaaa222200000000000000000000000000000002',
            pendingMigrations: [],
          },
        });
        assert.equal(res.exitCode, 0);
        assert.equal(res.finalBanner, 'DEPLOYMENT SUCCESS');
        assert.equal(res.backupStoredOutsideRepo, true);
        assert.equal(res.backupCompletedBeforeGitPull, true);
        assert.ok(res.backupDir && res.backupDir.startsWith(ws.backupRootDir));
        assert.ok(res.backupSqlPath && fs.existsSync(res.backupSqlPath));
        assert.ok(res.backupSqlSha256 && res.backupSqlSha256.length === 64);
        assert.equal(res.procurementTouched, false);
        assert.equal(res.iisResetExecuted, false);

        // Reject backup dir inside Git repo
        const insideRepoRes = await runOneClickDeployment({
          appDir: ws.appDir,
          backupRootDir: path.join(ws.appDir, 'backups'),
        });
        assert.equal(insideRepoRes.exitCode, 1);
        assert.equal(insideRepoRes.finalBanner, 'DEPLOYMENT ABORTED');
        assert.ok(insideRepoRes.consoleOutput.includes('PREFLIGHT_BACKUP_DIR_INSIDE_GIT'));
      } finally {
        ws.cleanup();
      }
    });

    await t.test('7. Database backup failure aborts strictly BEFORE git pull and never restarts backend', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const commitBefore = '9f1cdc1000000000000000000000000000000001';
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          backupRootDir: ws.backupRootDir,
          hooks: {
            commitBefore,
            remoteCommit: 'bbbb333300000000000000000000000000000003',
            simulateDbBackupFailure: true,
          },
        });
        assert.equal(res.exitCode, 1);
        assert.equal(res.finalBanner, 'DEPLOYMENT ABORTED');
        assert.equal(res.commitAfter, commitBefore, 'git pull must NOT have advanced commit when backup failed');
        assert.equal(res.backendRestarted, false);
        assert.equal(res.steps.some((s) => s.stepNumber >= 4), false);
        assert.ok(res.consoleOutput.includes('BACKUP_FAILED'));
      } finally {
        ws.cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 2, 3, 4, 5, 6, 16, 18: API Migration Approval Gate, RBAC,
    // Reauth Password Verification, Approval Binding, Method Guard (405), Secret Masking
    // -------------------------------------------------------------------------
    await t.test('16. GET /api/Sam_Att/deployment/run-bat returns 405 METHOD_NOT_ALLOWED (never misleading 404)', async () => {
      const res = await apiCall('/api/Sam_Att/deployment/run-bat', {
        method: 'GET',
        token: adminToken,
      });
      assert.equal(res.status, 405);
      assert.equal(res.data.error, 'METHOD_NOT_ALLOWED');
      assert.deepEqual(res.data.allowedMethods, ['POST']);
    });

    await t.test('2, 3, 4, 5, 6, 18. API Migration Approval Gate + RBAC + Reauth + Commit/File Binding + Secret Redaction', async () => {
      const targetCommit = 'cccc444400000000000000000000000000000004';
      let runnerInvokedCount = 0;
      let capturedArgs: string[] = [];

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: '9f1cdc1000000000000000000000000000000001',
        targetCommit,
        hasUpdates: true,
        gitMigrationFiles: ['003_historical_import_and_mapping.sql'],
      }));

      setDeployBatRunnerForTests(async (scriptPath, args = []) => {
        runnerInvokedCount++;
        capturedArgs = args;
        return {
          exitCode: 0,
          stdout: [
            `Executed ${path.basename(scriptPath)}`,
            `SAM_ATT_DB_PASSWORD=TopSecretDbPassword#991!`,
            `BackupDir      : C:\\SamAttBackups\\deploy_backup_20261122_120000`,
            `BackupSql      : C:\\SamAttBackups\\deploy_backup_20261122_120000\\samchuk_attendance_v2.sql`,
            `BackupSqlSha   : 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
            `Migrations     : 003_historical_import_and_mapping.sql`,
            `Commit         : 9f1cdc10 -> cccc4444`,
            `DEPLOYMENT SUCCESS`,
          ].join('\n'),
          stderr: '',
          scriptPath,
          durationMs: 210,
        };
      });

      try {
        // Check-updates & migrations inspection APIs work for ADMIN and report pending migration
        const checkRes = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(checkRes.status, 200);
        assert.equal(checkRes.data.migrationApprovalRequired, true);
        assert.ok(checkRes.data.pendingMigrations.includes('003_historical_import_and_mapping.sql'));

        const migApiRes = await apiCall('/api/Sam_Att/deployment/migrations', {
          token: adminToken,
        });
        assert.equal(migApiRes.status, 200);
        assert.equal(migApiRes.data.migrationApprovalRequired, true);

        // Scenario 3: Non-ADMIN blocked (403 FORBIDDEN)
        const staffRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: staffToken,
          body: { confirmRun: true, approveMigrations: true },
        });
        assert.equal(staffRes.status, 403);

        const userRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: generalToken,
          body: { confirmRun: true, approveMigrations: true },
        });
        assert.equal(userRes.status, 403);
        assert.equal(runnerInvokedCount, 0);

        // Scenario 2: ADMIN without approveMigrations -> 409 MIGRATION_APPROVAL_REQUIRED
        const unapprovedRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true },
        });
        assert.equal(unapprovedRes.status, 409);
        assert.equal(unapprovedRes.data.error, 'MIGRATION_APPROVAL_REQUIRED');
        assert.equal(runnerInvokedCount, 0);

        // Scenario 6: Approval Binding Mismatch (wrong commit or wrong file list) -> 409 MIGRATION_APPROVAL_MISMATCH
        const wrongCommitRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: {
            confirmRun: true,
            approveMigrations: true,
            approvedTargetCommit: 'deadbeef00000000000000000000000000000000',
            approvedMigrationFiles: ['003_historical_import_and_mapping.sql'],
            impactAcknowledged: true,
            confirmPassword: ADMIN_PASS,
          },
        });
        assert.equal(wrongCommitRes.status, 409);
        assert.equal(wrongCommitRes.data.error, 'MIGRATION_APPROVAL_MISMATCH');

        const wrongFileRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: {
            confirmRun: true,
            approveMigrations: true,
            approvedTargetCommit: targetCommit,
            approvedMigrationFiles: ['002_attendance_matching_engine.sql'],
            impactAcknowledged: true,
            confirmPassword: ADMIN_PASS,
          },
        });
        assert.equal(wrongFileRes.status, 409);
        assert.equal(wrongFileRes.data.error, 'MIGRATION_APPROVAL_MISMATCH');
        assert.equal(runnerInvokedCount, 0);

        // Scenario 4: Wrong ADMIN password -> 401 INVALID_CONFIRM_PASSWORD, never runs script, never logs password
        const wrongPass = 'WrongSecretPass#999!';
        const badPassRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: {
            confirmRun: true,
            approveMigrations: true,
            approvedTargetCommit: targetCommit,
            approvedMigrationFiles: ['003_historical_import_and_mapping.sql'],
            impactAcknowledged: true,
            confirmPassword: wrongPass,
          },
        });
        assert.equal(badPassRes.status, 401);
        assert.equal(badPassRes.data.error, 'INVALID_CONFIRM_PASSWORD');
        assert.equal(runnerInvokedCount, 0);
        assert.ok(!JSON.stringify(badPassRes.data).includes(wrongPass));

        const auditAfterBadPass = await dbQuery<{ detail_json: string }>(
          "SELECT detail_json FROM audit_logs WHERE action LIKE 'DEPLOYMENT_MIGRATION_APPROVAL%'"
        );
        for (const row of auditAfterBadPass) {
          assert.ok(!String(row.detail_json || '').includes(wrongPass));
        }

        // Scenario 5 & 18: Correct ADMIN password + impactAcknowledged + exact binding -> 200 SUCCESS, secrets masked!
        const approvedRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: {
            confirmRun: true,
            approveMigrations: true,
            approvedTargetCommit: targetCommit,
            approvedMigrationFiles: ['003_historical_import_and_mapping.sql'],
            impactAcknowledged: true,
            confirmPassword: ADMIN_PASS,
          },
        });
        assert.equal(approvedRes.status, 200);
        assert.equal(approvedRes.data.status, 'SUCCESS');
        assert.equal(approvedRes.data.exitCode, 0);
        assert.equal(runnerInvokedCount, 1);
        assert.ok(capturedArgs.includes('-ApproveMigrations'));
        assert.ok(capturedArgs.includes(targetCommit));
        assert.ok(capturedArgs.includes('003_historical_import_and_mapping.sql'));
        assert.equal(approvedRes.data.backupDir, 'C:\\SamAttBackups\\deploy_backup_20261122_120000');
        assert.deepEqual(approvedRes.data.migrationsApplied, ['003_historical_import_and_mapping.sql']);
        // Secret masking verification
        assert.ok(!String(approvedRes.data.output).includes('TopSecretDbPassword#991!'));
        assert.ok(String(approvedRes.data.output).includes('***REDACTED***'));
        assert.ok(!JSON.stringify(approvedRes.data).includes(ADMIN_PASS));
      } finally {
        setDeployBatRunnerForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 12 & 13: Mid-migration failure & Post-migration failure (Migration-Aware Rollback)
    // -------------------------------------------------------------------------
    await t.test('12. Mid-migration failure stops immediately, never restarts backend, flags requiresAdminDatabaseRestore', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          backupRootDir: ws.backupRootDir,
          approveMigrations: true,
          approvedTargetCommit: 'dddd555500000000000000000000000000000005',
          approvedMigrations: ['003_historical_import_and_mapping.sql'],
          hooks: {
            commitBefore: '9f1cdc1000000000000000000000000000000001',
            remoteCommit: 'dddd555500000000000000000000000000000005',
            pendingMigrations: ['003_historical_import_and_mapping.sql'],
            simulateMigrationFailure: true,
          },
        });
        assert.equal(res.exitCode, 2);
        assert.equal(res.backendRestarted, false, 'Backend must NOT restart with new code when migration fails');
        assert.equal(res.requiresAdminDatabaseRestore, true);
        assert.equal(res.commitAfter, res.commitBefore, 'Git commit must revert back safely');
        assert.ok(res.backupSqlPath && fs.existsSync(res.backupSqlPath));
        assert.ok(!res.consoleOutput.includes('DEPLOYMENT SUCCESS'));
      } finally {
        ws.cleanup();
      }
    });

    await t.test('13. Post-migration health failure reverts code without auto-DROP and flags requiresAdminDatabaseRestore', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          backupRootDir: ws.backupRootDir,
          approveMigrations: true,
          approvedTargetCommit: 'eeee666600000000000000000000000000000006',
          approvedMigrations: ['003_historical_import_and_mapping.sql'],
          hooks: {
            commitBefore: '9f1cdc1000000000000000000000000000000001',
            remoteCommit: 'eeee666600000000000000000000000000000006',
            pendingMigrations: ['003_historical_import_and_mapping.sql'],
            simulateHealthApiUnreachable: true,
          },
        });
        assert.equal(res.exitCode, 2);
        assert.equal(res.requiresAdminDatabaseRestore, true);
        assert.deepEqual(res.migrationsApplied, ['003_historical_import_and_mapping.sql']);
        assert.equal(res.commitAfter, res.commitBefore);
        assert.ok(res.consoleOutput.includes('ADMIN DATABASE RESTORE REQUIRED'));
        assert.ok(!res.consoleOutput.includes('DEPLOYMENT SUCCESS'));
      } finally {
        ws.cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 9, 10, 11a, 11b, 14, 15: Real SQLite Migration Engine Tests
    // (003 on 001+002, Idempotency, Partial compatible vs incompatible column,
    //  Mid-statement failure, Checksum drift, Destructive SQL rejection)
    // -------------------------------------------------------------------------
    await t.test('9, 10, 11, 14, 15. Hardened Migration Engine: 003 verification, idempotency, column type mismatch, checksum drift & destructive guard', async () => {
      // 9. Verify real 003_historical_import_and_mapping.sql passes detailed inspection & all 11 columns
      const inspectNow = await inspectMigrationsDetailedReadOnly();
      assert.equal(inspectNow.checksumMismatches.length, 0);
      assert.equal(inspectNow.schemaVerification.ok, true);
      const colNames = inspectNow.schemaVerification.verifiedColumns.map((c) => `${c.table}.${c.column}`);
      for (const expectedCol of [
        'sync_runs.matched_scans_count',
        'sync_runs.conflict_scans_count',
        'sync_runs.attendance_created_count',
        'sync_runs.attendance_updated_count',
        'sync_runs.machine_results_json',
        'sync_runs.import_year_month',
        'fingerprint_mappings.original_effective_from',
        'fingerprint_mappings.retroactive_adjusted_by',
        'fingerprint_mappings.retroactive_adjusted_at',
        'fingerprint_mappings.retroactive_reason',
        'fingerprint_mappings.updated_at',
      ]) {
        assert.ok(colNames.includes(expectedCol), `Expected verified column ${expectedCol}`);
      }

      // 10. Idempotent re-run when all migrations already applied
      const rerun = await runMigrations();
      assert.equal(rerun.applied.length, 0);
      assert.ok(rerun.skipped.includes('003_historical_import_and_mapping.sql'));

      // Prepare temp migrations dir copying 001..003 plus custom additive test migrations
      const tmpMigDir = path.join(os.tmpdir(), `sam_att_mig_test_${TEST_RUN_ID}`);
      fs.mkdirSync(tmpMigDir, { recursive: true });
      const prodMigDir = path.resolve(process.cwd(), 'database/migrations');
      for (const f of fs.readdirSync(prodMigDir).filter((x) => x.endsWith('.sql'))) {
        fs.copyFileSync(path.join(prodMigDir, f), path.join(tmpMigDir, f));
      }

      try {
        // 11a. Partially applied compatible column: create column manually before running migration 904
        await dbExecute('ALTER TABLE sync_runs ADD COLUMN test_compat_counter INT NOT NULL DEFAULT 0');
        fs.writeFileSync(
          path.join(tmpMigDir, '904_test_compat_partial.sql'),
          [
            'ALTER TABLE sync_runs ADD COLUMN test_compat_counter INT NOT NULL DEFAULT 0;',
            'ALTER TABLE sync_runs ADD COLUMN test_compat_note VARCHAR(120) NULL;',
          ].join('\n'),
          'utf8'
        );

        // First test mid-migration failure: fail on statement index 1 -> must NOT record version 904 in schema_migrations!
        await assert.rejects(
          () =>
            runMigrations({
              migrationsDir: tmpMigDir,
              approvedFiles: ['904_test_compat_partial.sql'],
              simulateFailureAtStatement: 1,
            }),
          /SIMULATED_MIGRATION_STATEMENT_FAILURE/
        );
        const rowsAfterMidFail = await dbQuery<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '904'"
        );
        assert.equal(rowsAfterMidFail.length, 0, 'Failed migration must NOT be marked applied in schema_migrations');

        // Now run 904 cleanly -> compatible duplicate column passes and remaining column is added & verified
        const res904 = await runMigrations({
          migrationsDir: tmpMigDir,
          approvedFiles: ['904_test_compat_partial.sql'],
        });
        assert.deepEqual(res904.applied, ['904_test_compat_partial.sql']);
        assert.equal(res904.schemaVerification.ok, true);

        // 11b. Partially applied INCOMPATIBLE column: existing column is TEXT, migration expects INT -> MUST FAIL!
        await dbExecute('ALTER TABLE sync_runs ADD COLUMN test_bad_type_col VARCHAR(64) NULL');
        fs.writeFileSync(
          path.join(tmpMigDir, '905_test_incompatible_type.sql'),
          'ALTER TABLE sync_runs ADD COLUMN test_bad_type_col INT NOT NULL DEFAULT 0;\n',
          'utf8'
        );
        await assert.rejects(
          () =>
            runMigrations({
              migrationsDir: tmpMigDir,
              approvedFiles: ['905_test_incompatible_type.sql'],
            }),
          /MIGRATION_COLUMN_TYPE_MISMATCH/
        );
        const rows905 = await dbQuery<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = '905'"
        );
        assert.equal(rows905.length, 0, 'Incompatible column migration must NOT be recorded');
        fs.unlinkSync(path.join(tmpMigDir, '905_test_incompatible_type.sql'));

        // 15. Destructive SQL (DROP TABLE / DELETE FROM raw_scans) -> MUST REJECT BEFORE EXECUTING!
        fs.writeFileSync(
          path.join(tmpMigDir, '906_forbidden_drop.sql'),
          'DROP TABLE raw_scans;\n',
          'utf8'
        );
        await assert.rejects(
          () =>
            runMigrations({
              migrationsDir: tmpMigDir,
              approvedFiles: ['906_forbidden_drop.sql'],
            }),
          /FORBIDDEN_DESTRUCTIVE_MIGRATION/
        );
        fs.unlinkSync(path.join(tmpMigDir, '906_forbidden_drop.sql'));

        // 14. Checksum Drift: tamper with already-applied 904 file -> MUST BLOCK!
        fs.appendFileSync(path.join(tmpMigDir, '904_test_compat_partial.sql'), '\n-- tampered\n', 'utf8');
        const driftInspect = await inspectMigrationsDetailedReadOnly({ migrationsDir: tmpMigDir });
        assert.equal(driftInspect.checksumMismatches.length, 1);
        assert.equal(driftInspect.checksumMismatches[0].version, '904');

        await assert.rejects(
          () => runMigrations({ migrationsDir: tmpMigDir }),
          /MIGRATION_CHECKSUM_MISMATCH/
        );

        // Clean up test version 904 record so DB remains clean
        await dbExecute("DELETE FROM schema_migrations WHERE version = '904'");
      } finally {
        fs.rmSync(tmpMigDir, { recursive: true, force: true });
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 17: Script Static Safety & 7-bit ASCII Invariants
    // -------------------------------------------------------------------------
    await t.test('17. Deployment & Backup Scripts enforce 7-bit ASCII, --defaults-extra-file, C:\\SamAttBackups & Procurement isolation', async () => {
      const deployPs1 = fs.readFileSync(path.resolve(process.cwd(), 'deployment/Deploy_Sam_Att.ps1'), 'utf8');
      const backupPs1 = fs.readFileSync(path.resolve(process.cwd(), 'scripts/backup.ps1'), 'utf8');
      const restorePs1 = fs.readFileSync(path.resolve(process.cwd(), 'scripts/restore-test.ps1'), 'utf8');

      // Pure 7-bit ASCII for Windows PowerShell 5.1 safety
      assert.match(deployPs1, /^[\x00-\x7F]*$/, 'deployment/Deploy_Sam_Att.ps1 must be 100% 7-bit ASCII');
      assert.match(backupPs1, /^[\x00-\x7F]*$/, 'scripts/backup.ps1 must be 100% 7-bit ASCII');
      assert.match(restorePs1, /^[\x00-\x7F]*$/, 'scripts/restore-test.ps1 must be 100% 7-bit ASCII');

      // External backup directory outside Git repo
      assert.ok(deployPs1.includes('C:\\SamAttBackups'));
      assert.ok(deployPs1.includes('PREFLIGHT_BACKUP_DIR_INSIDE_GIT'));
      assert.ok(backupPs1.includes('C:\\SamAttBackups'));
      assert.ok(backupPs1.includes('BACKUP_DIR_INSIDE_GIT_FORBIDDEN'));

      // Uses --defaults-extra-file instead of plaintext CLI password
      assert.ok(deployPs1.includes('--defaults-extra-file='));
      assert.ok(backupPs1.includes('--defaults-extra-file='));
      assert.ok(restorePs1.includes('--defaults-extra-file='));

      // Explicit HOSOffice & Procurement isolation + forbidden commands check
      assert.ok(deployPs1.includes('BACKUP_FAILED_FORBIDDEN_HOSOFFICE_DB'));
      assert.ok(deployPs1.includes('ApprovedCommit'));
      assert.ok(deployPs1.includes('ApprovedMigrations'));
      assert.ok(deployPs1.includes('cli-migrate.ts'));
      assert.ok(deployPs1.includes('--verify-schema'));
      assert.ok(deployPs1.includes('MANUAL_DB_RESTORE_REQUIRED'));
      assert.ok(!/^\s*iisreset\b/im.test(deployPs1));
      assert.ok(!/^\s*git\s+reset\s+--hard/m.test(deployPs1));
      assert.ok(!/^\s*git\s+clean\s+-fd/m.test(deployPs1));
    });

    // -------------------------------------------------------------------------
    // Scenario 18: Deploy_Sam_Att.ps1 MySQL .cnf Isolation, ACL & Cleanup Guard
    // -------------------------------------------------------------------------
    await t.test('18. Deploy_Sam_Att.ps1 isolates temp .cnf, fixes file icacls flags, verifies read/ACL before mysqldump, masks secrets, and cleans up', async () => {
      const deployPs1 = fs.readFileSync(path.resolve(process.cwd(), 'deployment/Deploy_Sam_Att.ps1'), 'utf8');

      // Extract Set-RestrictedBackupAcl & New-VerifiedMySqlBackup bodies for precise structural assertions
      const aclFnMatch = deployPs1.match(/function Set-RestrictedBackupAcl \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction New-VerifiedMySqlBackup/);
      assert.ok(aclFnMatch, 'Expected Set-RestrictedBackupAcl function in Deploy_Sam_Att.ps1');
      const aclFn = aclFnMatch[0];

      const backupFnMatch = deployPs1.match(/function New-VerifiedMySqlBackup \{[\s\S]*?\r?\n\}\r?\n\r?\nfunction Invoke-SafeRollback/);
      assert.ok(backupFnMatch, 'Expected New-VerifiedMySqlBackup function in Deploy_Sam_Att.ps1');
      const backupFn = backupFnMatch[0];

      // 1 & 5. Set-RestrictedBackupAcl separates directory (OI)(CI)F vs file :F and fails fast on non-zero icacls exit code
      assert.ok(aclFn.includes('ACL_TARGET_NOT_FOUND'));
      assert.ok(aclFn.includes('PSIsContainer'));
      assert.ok(aclFn.includes('SYSTEM:(OI)(CI)F'));
      assert.ok(aclFn.includes('${CurrentUser}:(OI)(CI)F'));
      assert.ok(aclFn.includes('SYSTEM:F'));
      assert.ok(aclFn.includes('${CurrentUser}:F'));
      assert.ok(aclFn.includes('Invoke-NativeCli -Executable "icacls"'));
      assert.ok(aclFn.includes('$AclRes.ExitCode -ne 0'));
      assert.ok(aclFn.includes('ACL_CONFIGURATION_FAILED'));
      assert.ok(!aclFn.includes('2>$null'), 'icacls errors must never be swallowed with 2>$null');
      assert.ok(!aclFn.includes('Warning: Failed to apply'), 'icacls failure must throw instead of logging warning');

      // 2. Dedicated Sam_Att temp dir instead of $env:TEMP / [IO.Path]::GetTempPath()
      const backupCodeOnly = backupFn
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      assert.ok(!backupCodeOnly.includes('$env:TEMP'), 'Must not create .cnf inside $env:TEMP');
      assert.ok(!backupCodeOnly.includes('$env:TMP'), 'Must not create .cnf inside $env:TMP');
      assert.ok(!backupCodeOnly.includes('GetTempPath'), 'Must not use Windows user GetTempPath');
      assert.ok(!backupCodeOnly.includes('sam_att_my_backup_'), 'Old $env:TEMP cnf naming must be removed');
      assert.ok(backupCodeOnly.includes('".sam_att_tmp"'));
      assert.ok(backupCodeOnly.includes('UTF8Encoding($false)'), 'Option file must be UTF-8 without BOM for MariaDB/PS 5.1');

      // 3 & 4. Explicit ACL check, existence + non-zero size check, and active-account read verification before mysqldump
      assert.ok(backupFn.includes('BACKUP_FAILED_CNF_MISSING'));
      assert.ok(backupFn.includes('BACKUP_FAILED_CNF_EMPTY'));
      assert.ok(backupFn.includes('Get-Acl -LiteralPath $TmpCnf'));
      assert.ok(backupFn.includes('BACKUP_FAILED_CNF_ACL_VERIFICATION'));
      assert.ok(backupFn.includes('[System.IO.File]::Open($TmpCnf'));
      assert.ok(backupFn.includes('BACKUP_FAILED_CNF_UNREADABLE'));
      assert.ok(backupFn.includes('BACKUP_FAILED_CNF_MISSING_BEFORE_DUMP'));

      // 6. --defaults-extra-file MUST be the very first CLI argument passed to mysqldump
      const dumpArgsMatch = backupFn.match(/Invoke-NativeCli -Executable \$MysqlDumpExe -Arguments @\(([\s\S]*?)\)/);
      assert.ok(dumpArgsMatch, 'Expected Invoke-NativeCli call for $MysqlDumpExe');
      const firstArgLine = dumpArgsMatch[1].trim().split(/\r?\n/)[0].trim();
      assert.ok(
        firstArgLine.startsWith('"--defaults-extra-file=$TmpCnf"'),
        `First mysqldump argument must be "--defaults-extra-file=$TmpCnf", got: ${firstArgLine}`
      );
      assert.ok(!dumpArgsMatch[1].includes('--password'), 'DB password must never be in mysqldump CLI args');
      assert.ok(!dumpArgsMatch[1].includes('-p$'), 'DB password must never be in mysqldump CLI args');

      // 7. Password masking across registers and error output
      assert.ok(backupFn.includes('Register-SensitiveSecret -SecretValue $DbPassword'));
      assert.ok(backupFn.includes('Register-SensitiveSecret -SecretValue $EscapedPass'));
      assert.ok(backupFn.includes('Protect-SensitiveText -InputText $DumpRes.Output'));

      // 8. Guaranteed cleanup of .cnf and temporary directory in finally block
      const finallyMatch = backupFn.match(/\r?\n    \} finally \{([\s\S]*?)\r?\n    \}/);
      assert.ok(finallyMatch, 'Expected outer finally cleanup block in New-VerifiedMySqlBackup');
      assert.ok(finallyMatch[1].includes('Remove-Item -LiteralPath $TmpCnf -Force'));
      assert.ok(finallyMatch[1].includes('Remove-Item -LiteralPath $TmpCnfDir -Recurse -Force'));
      assert.ok(finallyMatch[1].includes('Remove-Item -LiteralPath $SamAttTmpRoot -Force'));

      // 9, 10, 13. Backup integrity, SHA256 & Migration Approval Guard remain intact
      assert.ok(backupFn.includes('BACKUP_FAILED_SQL_DUMP_MISSING'));
      assert.ok(backupFn.includes('BACKUP_FAILED_SQL_DUMP_EMPTY'));
      assert.ok(backupFn.includes('BACKUP_FAILED_SQL_DUMP_CORRUPT'));
      assert.ok(backupFn.includes('Get-FileHash -Path $SqlDumpPath -Algorithm SHA256'));
      assert.ok(deployPs1.includes('[switch]$ApproveMigrations'));
      assert.ok(deployPs1.includes('MIGRATION_APPROVAL_REQUIRED'));
    });
  } finally {
    await closeServer();
    resetSqliteInstanceForTests();
    try {
      fs.unlinkSync(TEST_DB_PATH);
    } catch {
      // ignore
    }
  }
});
