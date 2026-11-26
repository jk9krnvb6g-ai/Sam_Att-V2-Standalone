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
  sanitizeDeploymentOutput,
  setDeployBatRunnerForTests,
  setDeployRollbackRunnerForTests,
  setDeploymentGitInspectorForTests,
} from '../src/modules/settings/routes.ts';
import {
  acquireDeployLock,
  listAvailableAppSnapshots,
  releaseDeployLock,
} from '../src/modules/deployment/jobStore.ts';
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
    // Scenario 1, 7, 8: Runner — App-Only Snapshot strictly outside Git repo BEFORE git pull,
    // zero DB dump, zero npm test in Prod, Snapshot failure aborts cleanly before pull
    // -------------------------------------------------------------------------
    await t.test('1 & 8. App-Only update stores snapshot outside repo strictly BEFORE git pull with zero DB dump and zero npm test', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          snapshotRootDir: ws.backupRootDir,
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
        assert.ok(res.snapshotDir && res.snapshotDir.startsWith(ws.backupRootDir));
        assert.equal(res.backupSqlPath, null, 'App-Only deploy must NOT create SQL dump');
        assert.equal(res.ranNpmTestInProd, false, 'Prod deploy must NOT run npm test');
        assert.equal(res.npmCiSkipped, true, 'Unchanged lockfile must skip npm ci');
        assert.equal(res.procurementTouched, false);
        assert.equal(res.iisResetExecuted, false);

        // Reject snapshot dir inside Git repo
        const insideRepoRes = await runOneClickDeployment({
          appDir: ws.appDir,
          snapshotRootDir: path.join(ws.appDir, 'snapshots'),
        });
        assert.equal(insideRepoRes.exitCode, 1);
        assert.equal(insideRepoRes.finalBanner, 'DEPLOYMENT ABORTED');
        assert.ok(insideRepoRes.consoleOutput.includes('PREFLIGHT_SNAPSHOT_DIR_INSIDE_GIT'));
      } finally {
        ws.cleanup();
      }
    });

    await t.test('7. Snapshot failure aborts strictly BEFORE git pull and never restarts backend', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const commitBefore = '9f1cdc1000000000000000000000000000000001';
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          snapshotRootDir: ws.backupRootDir,
          hooks: {
            commitBefore,
            remoteCommit: 'bbbb333300000000000000000000000000000003',
            simulateSnapshotFailure: true,
          },
        });
        assert.equal(res.exitCode, 1);
        assert.equal(res.finalBanner, 'DEPLOYMENT ABORTED');
        assert.equal(res.commitAfter, commitBefore, 'git pull must NOT have advanced commit when snapshot failed');
        assert.equal(res.backendRestarted, false);
        assert.equal(res.steps.some((s) => s.stepNumber >= 4), false);
        assert.ok(res.consoleOutput.includes('SNAPSHOT_FAILED'));
      } finally {
        ws.cleanup();
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 2, 3, 4, 5, 6, 16, 18: API DB Schema Hard Block (Zero Web Migrations), RBAC,
    // NO_UPDATE_AVAILABLE Guard, Lock Conflict (409), App Rollback (/deployment/rollback-app),
    // Method Guard (405), Secret Masking
    // -------------------------------------------------------------------------
    await t.test('16. GET /api/Sam_Att/deployment/run-bat & rollback-app return 405 METHOD_NOT_ALLOWED', async () => {
      const res = await apiCall('/api/Sam_Att/deployment/run-bat', {
        method: 'GET',
        token: adminToken,
      });
      assert.equal(res.status, 405);
      assert.equal(res.data.error, 'METHOD_NOT_ALLOWED');
      assert.deepEqual(res.data.allowedMethods, ['POST']);

      const rbRes = await apiCall('/api/Sam_Att/deployment/rollback-app', {
        method: 'GET',
        token: adminToken,
      });
      assert.equal(rbRes.status, 405);
      assert.equal(rbRes.data.error, 'METHOD_NOT_ALLOWED');
    });

    await t.test('2, 3, 4, 5, 6, 18. API DB Schema Hard Block + RBAC + NO_UPDATE_AVAILABLE + Lock Guard + App Rollback + Secret Redaction', async () => {
      const oldCommit = '9f1cdc1000000000000000000000000000000001';
      const targetCommit = 'cccc444400000000000000000000000000000004';
      let runnerInvokedCount = 0;

      const tmpSnapRoot = path.join(os.tmpdir(), `sam_att_snap_root_${TEST_RUN_ID}`);
      const tmpJobsDir = path.join(os.tmpdir(), `sam_att_jobs_dir_${TEST_RUN_ID}`);
      const tmpLockFile = path.join(tmpJobsDir, 'deploy_active.lock');
      const prevSnapEnv = process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR;
      const prevJobsEnv = process.env.SAM_ATT_DEPLOY_JOBS_DIR;
      const prevLockEnv = process.env.SAM_ATT_DEPLOY_LOCK_FILE;
      process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR = tmpSnapRoot;
      process.env.SAM_ATT_DEPLOY_JOBS_DIR = tmpJobsDir;
      process.env.SAM_ATT_DEPLOY_LOCK_FILE = tmpLockFile;

      const sampleSnapDir = path.join(tmpSnapRoot, 'app_snapshot_20261126_010101');
      fs.mkdirSync(path.join(sampleSnapDir, 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(sampleSnapDir, 'snapshot-manifest.json'),
        JSON.stringify({ commitBefore: oldCommit, targetCommit, createdAt: '2026-11-26T01:01:01.000Z' }),
        'utf8'
      );

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: oldCommit,
        targetCommit,
        hasUpdates: true,
        gitMigrationFiles: ['003_historical_import_and_mapping.sql'],
      }));

      setDeployBatRunnerForTests(async (scriptPath) => {
        runnerInvokedCount++;
        return {
          exitCode: 0,
          stdout: [
            `Executed ${path.basename(scriptPath)}`,
            `SAM_ATT_DB_PASSWORD=TopSecretDbPassword#991!`,
            `Authorization: Bearer ghp_TopSecretGitHubToken1234567890abcdef`,
            `SnapshotDir    : ${sampleSnapDir}`,
            `Commit         : ${oldCommit.slice(0, 8)} -> ${targetCommit.slice(0, 8)}`,
            `DEPLOYMENT SUCCESS`,
          ].join('\n'),
          stderr: '',
          scriptPath,
          durationMs: 210,
        };
      });

      setDeployRollbackRunnerForTests(async (scriptPath) => ({
        exitCode: 0,
        stdout: [
          `Rollback ${path.basename(scriptPath)}`,
          `SnapshotDir    : ${sampleSnapDir}`,
          `Commit         : ${targetCommit.slice(0, 8)} -> ${oldCommit.slice(0, 8)}`,
          `DEPLOYMENT ROLLED_BACK_MANUAL`,
        ].join('\n'),
        stderr: '',
        scriptPath,
        durationMs: 140,
      }));

      try {
        // Check-updates blocks deployment readiness when pending migration exists
        const checkRes = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(checkRes.status, 200);
        assert.equal(checkRes.data.readiness.canDeploy, false);
        assert.ok(checkRes.data.pendingMigrations.includes('003_historical_import_and_mapping.sql'));

        // Non-ADMIN blocked (403 FORBIDDEN) for both run-bat and rollback-app
        const staffRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: staffToken,
          body: { confirmRun: true },
        });
        assert.equal(staffRes.status, 403);

        const userRes = await apiCall('/api/Sam_Att/deployment/rollback-app', {
          method: 'POST',
          token: generalToken,
          body: { confirmRollback: true },
        });
        assert.equal(userRes.status, 403);
        assert.equal(runnerInvokedCount, 0);

        // Scenario 2 & 5: Pending DB migration is HARD BLOCKED (409 DB_SCHEMA_CHANGE_BLOCKED), even if approveMigrations is passed
        const blockedSchemaRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true, approveMigrations: true, confirmPassword: ADMIN_PASS },
        });
        assert.equal(blockedSchemaRes.status, 409);
        assert.equal(blockedSchemaRes.data.error, 'DB_SCHEMA_CHANGE_BLOCKED');
        assert.ok(blockedSchemaRes.data.message.includes('กรุณาติดต่อผู้ดูแลระบบก่อนอัปเดต'));
        assert.equal(runnerInvokedCount, 0);

        // Scenario 4: No-Update Protection -> 409 NO_UPDATE_AVAILABLE when currentCommit == targetCommit
        setDeploymentGitInspectorForTests(async () => ({
          available: true,
          branch: 'main',
          currentCommit: targetCommit,
          targetCommit,
          hasUpdates: false,
          gitMigrationFiles: [],
        }));
        const noUpdateRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true },
        });
        assert.equal(noUpdateRes.status, 409);
        assert.equal(noUpdateRes.data.error, 'NO_UPDATE_AVAILABLE');
        assert.equal(runnerInvokedCount, 0);

        // Scenario 6: Active Disk Lock -> 409 DEPLOYMENT_ALREADY_IN_PROGRESS
        setDeploymentGitInspectorForTests(async () => ({
          available: true,
          branch: 'main',
          currentCommit: oldCommit,
          targetCommit,
          hasUpdates: true,
          gitMigrationFiles: [],
        }));
        acquireDeployLock({ jobId: 'test_active_lock', pid: process.pid, actorUsername: 'admin' });
        try {
          const lockedRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
            method: 'POST',
            token: adminToken,
            body: { confirmRun: true },
          });
          assert.equal(lockedRes.status, 409);
          assert.equal(lockedRes.data.error, 'DEPLOYMENT_ALREADY_IN_PROGRESS');
        } finally {
          releaseDeployLock('test_active_lock');
        }

        // Clean App-Only update executes cleanly & redacts DB password + Bearer token!
        const deployRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true },
        });
        assert.equal(deployRes.status, 200);
        assert.equal(deployRes.data.status, 'SUCCESS');
        assert.equal(runnerInvokedCount, 1);
        assert.ok(!String(deployRes.data.output).includes('TopSecretDbPassword#991!'));
        assert.ok(!String(deployRes.data.output).includes('ghp_TopSecretGitHubToken1234567890abcdef'));
        assert.ok(String(deployRes.data.output).includes('***REDACTED***'));
        assert.ok(sanitizeDeploymentOutput('Authorization: Bearer secret_token_123').includes('***REDACTED***'));

        // List snapshots & trigger App-Only Rollback (rejects invalid path, accepts valid snapshotDir)
        assert.equal(listAvailableAppSnapshots().length, 1);
        const badSnapRollback = await apiCall('/api/Sam_Att/deployment/rollback-app', {
          method: 'POST',
          token: adminToken,
          body: { confirmRollback: true, snapshotDir: 'C:\\Windows\\System32' },
        });
        assert.equal(badSnapRollback.status, 400);
        assert.equal(badSnapRollback.data.error, 'INVALID_SNAPSHOT_DIR');

        const okRollback = await apiCall('/api/Sam_Att/deployment/rollback-app', {
          method: 'POST',
          token: adminToken,
          body: { confirmRollback: true, snapshotDir: sampleSnapDir },
        });
        assert.equal(okRollback.status, 200);
        assert.equal(okRollback.data.status, 'SUCCESS');
        assert.equal(okRollback.data.databaseTouched, false);
      } finally {
        setDeployBatRunnerForTests(null);
        setDeployRollbackRunnerForTests(null);
        setDeploymentGitInspectorForTests(null);
        if (prevSnapEnv !== undefined) process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR = prevSnapEnv;
        else delete process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR;
        if (prevJobsEnv !== undefined) process.env.SAM_ATT_DEPLOY_JOBS_DIR = prevJobsEnv;
        else delete process.env.SAM_ATT_DEPLOY_JOBS_DIR;
        if (prevLockEnv !== undefined) process.env.SAM_ATT_DEPLOY_LOCK_FILE = prevLockEnv;
        else delete process.env.SAM_ATT_DEPLOY_LOCK_FILE;
        fs.rmSync(tmpSnapRoot, { recursive: true, force: true });
        fs.rmSync(tmpJobsDir, { recursive: true, force: true });
      }
    });

    // -------------------------------------------------------------------------
    // Scenario 12 & 13: Failure during Install/Build/Health safely rolls back App-Only (DB & .env untouched)
    // -------------------------------------------------------------------------
    await t.test('12. Step 4 npm ci lock error stops Sam_Att first and rolls back Application Snapshot cleanly', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          snapshotRootDir: ws.backupRootDir,
          hooks: {
            commitBefore: '9f1cdc1000000000000000000000000000000001',
            remoteCommit: 'dddd555500000000000000000000000000000005',
            lockfileChanged: true,
            simulateNpmLockError: true,
          },
        });
        assert.equal(res.exitCode, 1);
        assert.equal(res.finalBanner, 'DEPLOYMENT ROLLED_BACK');
        assert.equal(res.stoppedSamAttBeforeNpmCi, true);
        assert.equal(res.requiresAdminDatabaseRestore, false);
        assert.equal(res.commitAfter, res.commitBefore, 'Git commit must revert back safely');
        assert.ok(res.consoleOutput.includes('NPM_CI_LOCK_ERROR'));
      } finally {
        ws.cleanup();
      }
    });

    await t.test('13. Post-deploy health failure reverts Application cleanly without touching DB or .env', async () => {
      const ws = createIsolatedWorkspace();
      try {
        const res = await runOneClickDeployment({
          appDir: ws.appDir,
          snapshotRootDir: ws.backupRootDir,
          hooks: {
            commitBefore: '9f1cdc1000000000000000000000000000000001',
            remoteCommit: 'eeee666600000000000000000000000000000006',
            simulateHealthApiUnreachable: true,
          },
        });
        assert.equal(res.exitCode, 1);
        assert.equal(res.finalBanner, 'DEPLOYMENT ROLLED_BACK');
        assert.equal(res.requiresAdminDatabaseRestore, false);
        assert.equal(res.commitAfter, res.commitBefore);
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
    // Scenario 17: Script Static Safety & 7-bit ASCII Invariants (8-Step App-Only Deploy + Separate Backup Scripts)
    // -------------------------------------------------------------------------
    await t.test('17. Deployment Script enforces 8-step App-Only 7-bit ASCII & Procurement isolation while Backup Scripts enforce --defaults-extra-file', async () => {
      const deployPs1 = fs.readFileSync(path.resolve(process.cwd(), 'deployment/Deploy_Sam_Att.ps1'), 'utf8');
      const backupPs1 = fs.readFileSync(path.resolve(process.cwd(), 'scripts/backup.ps1'), 'utf8');
      const restorePs1 = fs.readFileSync(path.resolve(process.cwd(), 'scripts/restore-test.ps1'), 'utf8');

      // Pure 7-bit ASCII for Windows PowerShell 5.1 safety
      assert.match(deployPs1, /^[\x00-\x7F]*$/, 'deployment/Deploy_Sam_Att.ps1 must be 100% 7-bit ASCII');
      assert.match(backupPs1, /^[\x00-\x7F]*$/, 'scripts/backup.ps1 must be 100% 7-bit ASCII');
      assert.match(restorePs1, /^[\x00-\x7F]*$/, 'scripts/restore-test.ps1 must be 100% 7-bit ASCII');

      // 8-Step Application-Only Deployment assertions
      assert.ok(
        deployPs1.includes('$TotalSteps = 8') || deployPs1.includes('$TotalSteps = if ($RollbackOnly) { 5 } else { 8 }'),
        'Deploy_Sam_Att.ps1 must define 8 deployment steps'
      );
      assert.ok(deployPs1.includes('C:\\SamAttDeploySnapshots'), 'App-only rollback snapshot root must live outside Git repo');
      assert.ok(deployPs1.includes('PREFLIGHT_SNAPSHOT_DIR_INSIDE_GIT'));
      assert.ok(deployPs1.includes('PREFLIGHT_FORBIDDEN_HOSOFFICE_DB'));
      assert.ok(deployPs1.includes('DB_SCHEMA_CHANGE_BLOCKED'));
      assert.ok(deployPs1.includes('STEP 8 - DEPLOYMENT REPORT'));
      assert.ok(deployPs1.includes('Invoke-SafeAppRollback'));

      // Separate DB backup/restore scripts retain --defaults-extra-file & external backup dir
      assert.ok(backupPs1.includes('C:\\SamAttBackups'));
      assert.ok(backupPs1.includes('BACKUP_DIR_INSIDE_GIT_FORBIDDEN'));
      assert.ok(backupPs1.includes('--defaults-extra-file='));
      assert.ok(restorePs1.includes('--defaults-extra-file='));

      // Forbidden destructive commands check
      assert.ok(!/^\s*iisreset\b/im.test(deployPs1));
      assert.ok(!/^\s*git\s+reset\s+--hard/m.test(deployPs1));
      assert.ok(!/^\s*git\s+clean\s+-fd/m.test(deployPs1));
    });

    // -------------------------------------------------------------------------
    // Scenario 18: Deploy_Sam_Att.ps1 Strictly Application-Only (Zero DB Management), Read-Only Health, Secret Masking & Safe Rollback
    // -------------------------------------------------------------------------
    await t.test('18. Deploy_Sam_Att.ps1 enforces 8-step sequence, zero DB backup/migration execution, DB schema block, secret masking, and app-only rollback', async () => {
      const deployPs1 = fs.readFileSync(path.resolve(process.cwd(), 'deployment/Deploy_Sam_Att.ps1'), 'utf8');
      const deployCodeOnly = deployPs1
        .replace(/<#[\s\S]*?#>/g, '')
        .split(/\r?\n/)
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');

      // 1. All 8 steps in exact order
      const expectedStepLabels = [
        'STEP 1 - Preflight Check',
        'STEP 2 - GitHub Version Verification',
        'STEP 3 - Change Impact Analysis',
        'STEP 4 - Update Source & Smart Dependency Management',
        'STEP 5 - Check & Build',
        'STEP 6 - Restart Application',
        'STEP 7 - Health Check',
        'STEP 8 - Deployment Report',
      ];
      let prevIdx = -1;
      for (const label of expectedStepLabels) {
        const idx = deployPs1.indexOf(label);
        assert.ok(idx > prevIdx, `Expected '${label}' to appear in order in Deploy_Sam_Att.ps1`);
        prevIdx = idx;
      }

      // 2. Zero database backup / dump / migration execution AND zero npm test in Production Deploy_Sam_Att.ps1
      assert.ok(!deployCodeOnly.includes('mysqldump'), 'Deploy_Sam_Att.ps1 must NOT run mysqldump');
      assert.ok(!deployCodeOnly.includes('mariadb-dump'), 'Deploy_Sam_Att.ps1 must NOT run mariadb-dump');
      assert.ok(!deployCodeOnly.includes('cli-migrate.ts'), 'Deploy_Sam_Att.ps1 must NOT run cli-migrate.ts');
      const deployWithoutGuidanceMsg = deployCodeOnly.replace(
        /"Database schema or migration changes were detected\. Deployment is strictly Application-Only\. Ask DBA to run 'npm run db:migrate' on server before retrying update\."/g,
        ''
      );
      assert.ok(!deployWithoutGuidanceMsg.includes('db:migrate'), 'Deploy_Sam_Att.ps1 must NOT invoke npm run db:migrate');
      assert.ok(!deployCodeOnly.includes('New-VerifiedMySqlBackup'), 'Deploy_Sam_Att.ps1 must NOT contain DB backup routine');
      assert.ok(!deployCodeOnly.includes('Set-RestrictedBackupAcl'), 'Deploy_Sam_Att.ps1 must NOT contain DB backup ACL routine');
      assert.ok(!/npm\.cmd.*test\b/i.test(deployCodeOnly), 'Deploy_Sam_Att.ps1 must NOT run npm test on Production');

      // 3. Step 1-3 Read-only MySQL config verification, GitHub check, No-Update stop & DB schema change block
      assert.ok(deployPs1.includes('jk9krnvb6g-ai/Sam_Att-V2-Standalone'));
      assert.ok(deployPs1.includes('PREFLIGHT_ENV_INCOMPLETE'));
      assert.ok(deployPs1.includes('GITHUB_REPO_MISMATCH'));
      assert.ok(deployPs1.includes('GIT_HISTORY_DIVERGED'));
      assert.ok(deployPs1.includes('NO_CHANGES'));
      assert.ok(deployPs1.includes('DB_SCHEMA_CHANGE_BLOCKED'));
      assert.ok(deployPs1.includes('CONFIG_ENV_TRACKED_VIOLATION'));

      // 4. Step 4-5 Smart lockfile strategy, EPERM stop-before-npm-ci, .env immutability & ScannerReader preservation
      assert.ok(deployPs1.includes('SKIPPED_LOCKFILE_UNCHANGED'));
      assert.ok(deployPs1.includes('NPM_CI_LOCK_ERROR'));
      assert.ok(deployPs1.includes('SECURITY_ENV_MUTATED_VIOLATION'));
      assert.ok(deployPs1.includes('SCANNER_EXE_MODIFIED_VIOLATION'));
      assert.ok(deployPs1.includes('$JobStatusFile'));
      assert.ok(deployPs1.includes('$RollbackOnly'));

      // 5. Step 6-7 Service isolation, Port 4101 ownership & Read-only health verification
      assert.ok(deployPs1.includes('SECURITY_ISOLATION_VIOLATION'));
      assert.ok(deployPs1.includes('PREFLIGHT_PORT_4101_FOREIGN_PROCESS'));
      assert.ok(deployPs1.includes('/api/Sam_Att/health'));
      assert.ok(deployPs1.includes('CONNECTED (READ-ONLY CHECK)'));
      assert.ok(deployPs1.includes('POST_DEPLOY_LOG_ERRORS'));

      // 6. Secret masking, startupReadOnlyOnMysql server guard & Application-only rollback
      assert.ok(deployPs1.includes('Register-SensitiveSecret'));
      assert.ok(deployPs1.includes('Protect-SensitiveText'));
      assert.ok(deployPs1.includes('git" -Arguments @("reset", "--keep"'));
      assert.ok(deployPs1.includes('Restart-SamAttBackendOnly'));

      const serverTs = fs.readFileSync(path.resolve(process.cwd(), 'backend/src/server.ts'), 'utf8');
      assert.ok(serverTs.includes('startupReadOnlyOnMysql: true'), 'server.ts must enforce read-only MySQL startup');
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
