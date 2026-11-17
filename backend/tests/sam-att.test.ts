import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import type { AddressInfo } from 'net';
import {
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
  setSimulatedDatabaseDown,
  dbQuery,
  dbExecute,
  ImmutableTableViolationError,
} from '../src/database/adapter.ts';
import { loadConfig, validateProductionConfig, ProductionConfigError } from '../src/config/env.ts';
import { reprocessAttendanceRange } from '../src/modules/attendance/processor.ts';
import { setHosOfficeTestDouble } from '../src/modules/personnel/routes.ts';
import {
  setScannerExeTestDouble,
  setScannerSyncLockForTests,
} from '../src/modules/scanners/routes.ts';
import {
  resetSchedulerHistoryForTests,
  stopAutomaticScannerScheduler,
} from '../src/modules/scanners/scheduler.ts';
import {
  REQUIRED_HOSOFFICE_TARGET_COLUMNS,
  setHosOfficeTargetAdapterForTests,
  setSimulatePostHosOfficeCommitLocalDbFailureForTests,
  type HosOfficeTableContractSchema,
  type ValidatedHosOfficePushRecord,
} from '../src/modules/hosoffice/routes.ts';
import {
  buildReleaseArtifactFile,
  ensureBaselineDeploymentWorkspaceInitialized,
  executeStandaloneDeployment,
  executeStandaloneRollback,
  getActiveReleaseMetadata,
} from '../src/modules/deployment/agent.ts';
import { ensureTlsCertificates } from '../src/server.ts';
import { createExpressApp } from '../src/app.ts';
import { sanitizeCsvCell } from '../src/utils/crypto.ts';

// ใช้โฟลเดอร์ชั่วคราวใน os.tmpdir() สำหรับฐานข้อมูลและใบรับรองการทดสอบ เพื่อไม่ให้มีไฟล์ .sqlite หรือ .key ตกค้างใน Git Repository (แก้ไข P0 ข้อ 01–02)
const TEST_RUN_ID = `${process.pid}_${Date.now()}`;
const TEST_SQLITE_PATH = path.join(os.tmpdir(), `sam_att_test_${TEST_RUN_ID}.sqlite`);
const TEST_CERT_DIR = path.join(os.tmpdir(), `sam_att_certs_${TEST_RUN_ID}`);
const TEST_DEPLOY_DIR = path.join(os.tmpdir(), `sam_att_deploy_${TEST_RUN_ID}`);
const CERT_PATH = path.join(TEST_CERT_DIR, 'server.crt');
const KEY_PATH = path.join(TEST_CERT_DIR, 'server.key');

let httpsServer: https.Server;
let baseUrl: string;

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

async function apiCall(
  endpoint: string,
  options: {
    method?: string;
    token?: string;
    cookie?: string;
    csrfToken?: string;
    scannerToken?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; headers: Headers; setCookies: string[]; data: any; rawText: string }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.cookie) {
    headers['Cookie'] = options.cookie;
  }
  if (options.csrfToken) {
    headers['X-CSRF-Token'] = options.csrfToken;
  }
  if (options.scannerToken) {
    headers['X-Scanner-Token'] = options.scannerToken;
  }
  const bodyBuffer =
    options.body !== undefined ? Buffer.from(JSON.stringify(options.body), 'utf8') : null;
  if (bodyBuffer) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(bodyBuffer.length);
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(`${baseUrl}${endpoint}`);
    const req = https.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method: options.method || 'GET',
        headers,
        agent: httpsAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let data: any = null;
          try {
            data = JSON.parse(rawText);
          } catch {
            data = rawText;
          }
          const hdrs = new Headers();
          const setCookies: string[] = [];
          for (const [k, v] of Object.entries(res.headers)) {
            if (k.toLowerCase() === 'set-cookie' && Array.isArray(v)) {
              setCookies.push(...v);
            } else if (typeof v === 'string') {
              hdrs.set(k, v);
            }
          }
          resolve({
            status: res.statusCode || 500,
            headers: hdrs,
            setCookies,
            data,
            rawText,
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuffer) {
      req.write(bodyBuffer);
    }
    req.end();
  });
}

describe('Sam_Att V2 Standalone — Full Verification Matrix (Phase 0 to Phase 6 & Audit 01–20)', () => {
  let adminToken = '';
  let staffToken = '';
  let generalUserToken = '';

  before(async () => {
    process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
    process.env.TLS_CERT_PATH = CERT_PATH;
    process.env.TLS_KEY_PATH = KEY_PATH;
    process.env.SAM_ATT_DEPLOY_ROOT_DIR = TEST_DEPLOY_DIR;
    resetSqliteInstanceForTests(TEST_SQLITE_PATH);

    const mig = await runMigrations();
    assert.ok(mig.totalTables >= 21, 'Must create at least 21 baseline tables including raw_scan_mappings');
    await seedBaselineAndSyntheticData();
    await reprocessAttendanceRange({
      dateFrom: '2026-11-12',
      dateTo: '2026-11-13',
      referenceNowBkk: '2026-11-13 18:00:00',
      actorUsername: 'test_bootstrap',
    });

    ensureTlsCertificates(CERT_PATH, KEY_PATH, 'test');
    const app = createExpressApp({ serveStaticBuild: true });
    httpsServer = https.createServer(
      {
        key: fs.readFileSync(KEY_PATH),
        cert: fs.readFileSync(CERT_PATH),
      },
      app
    );

    await new Promise<void>((resolve) => {
      httpsServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpsServer.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    stopAutomaticScannerScheduler();
    if (httpsServer) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
    resetSqliteInstanceForTests();
    for (const ext of ['', '-shm', '-wal']) {
      const f = `${TEST_SQLITE_PATH}${ext}`;
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {
          // ignore
        }
      }
    }
    if (fs.existsSync(TEST_CERT_DIR)) {
      try {
        fs.rmSync(TEST_CERT_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
    if (fs.existsSync(TEST_DEPLOY_DIR)) {
      try {
        fs.rmSync(TEST_DEPLOY_DIR, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('Phase 0 & Security Gate (Items 01, 02, 05, 13): Single-Port HTTPS, Security Headers, and Complete Cross-Platform Lockfile', async () => {
    // ตรวจว่าไม่มีไฟล์ Private Key, SQLite Runtime หรือ bun.lock ค้างในโฟลเดอร์โปรเจกต์
    assert.equal(fs.existsSync(path.resolve(process.cwd(), 'certs/server.key')), false, 'certs/server.key must not exist in repo');
    assert.equal(fs.existsSync(path.resolve(process.cwd(), 'data/sam_att_v2.sqlite')), false, 'data/sam_att_v2.sqlite must not exist in repo');
    assert.equal(fs.existsSync(path.resolve(process.cwd(), 'bun.lock')), false, 'bun.lock must be removed');
    assert.equal(fs.existsSync(path.resolve(process.cwd(), 'package-lock.json')), true, 'package-lock.json must exist for npm ci');

    // PHASE 1: ยืนยันว่า package-lock.json มี Optional Dependencies ครบทั้ง Linux และ Windows สำหรับ Tailwind Oxide, LightningCSS, Rolldown และ Esbuild
    const rawLock = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package-lock.json'), 'utf8'));
    const pkgKeys = Object.keys(rawLock.packages || {});
    assert.ok(pkgKeys.includes('node_modules/@tailwindcss/oxide-win32-x64-msvc'), 'Lockfile must include Windows Tailwind Oxide binary');
    assert.ok(pkgKeys.includes('node_modules/lightningcss-win32-x64-msvc'), 'Lockfile must include Windows LightningCSS binary');
    assert.ok(pkgKeys.includes('node_modules/@rolldown/binding-win32-x64-msvc'), 'Lockfile must include Windows Rolldown binding');
    assert.ok(pkgKeys.includes('node_modules/@esbuild/win32-x64'), 'Lockfile must include Windows esbuild binary');

    const health = await apiCall('/api/Sam_Att/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'OK');
    assert.equal(health.data.centralGatewayUsed, false);
    assert.equal(health.data.publicBasePath, '/Sam_Att/');
    assert.equal(health.data.apiBasePath, '/api/Sam_Att');

    // ตรวจสอบ Security Headers (Item 13)
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(health.headers.get('x-frame-options'), 'DENY');
    assert.ok(health.headers.get('content-security-policy')?.includes("default-src 'self'"));
    assert.ok(health.headers.get('strict-transport-security')?.includes('max-age=31536000'));

    if (fs.existsSync(path.resolve(process.cwd(), 'dist/index.html'))) {
      const spa = await apiCall('/Sam_Att/');
      assert.equal(spa.status, 200);
      assert.ok(spa.rawText.includes('Sam_Att V2 Standalone'));
    }
  });

  test('Phase 1 Gate (Items 03–04, 12, 15): Authentication, HttpOnly Cookie + CSRF Protection, Session Revocation, Lockout, and Production Config Validation', async () => {
    // 1. Login ADMIN and verify HttpOnly + Secure + SameSite=Strict Cookie & CSRF Token (Item 12)
    const adminRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminRes.status, 200);
    assert.ok(adminRes.data.token);
    assert.ok(adminRes.data.csrfToken, 'Must return csrfToken bound to session jti');
    assert.equal(adminRes.data.user.role, 'ADMIN');
    assert.equal(adminRes.data.user.password_hash, undefined);
    adminToken = adminRes.data.token;

    const sessionCookieHeader = adminRes.setCookies.find((c) => c.startsWith('sam_att_session='));
    assert.ok(sessionCookieHeader, 'Must set sam_att_session cookie');
    assert.ok(sessionCookieHeader.includes('HttpOnly'), 'Session cookie must be HttpOnly');
    assert.ok(sessionCookieHeader.includes('SameSite=Strict'), 'Session cookie must be SameSite=Strict');

    const cookiePair = sessionCookieHeader.split(';')[0];

    // Test Cookie Authentication on GET /auth/me
    const meWithCookie = await apiCall('/api/Sam_Att/auth/me', {
      cookie: cookiePair,
    });
    assert.equal(meWithCookie.status, 200);
    assert.equal(meWithCookie.data.user.username, 'admin');

    // Test CSRF Enforcement: Mutating POST with Cookie but WITHOUT X-CSRF-Token MUST be rejected with 403
    const csrfBlocked = await apiCall('/api/Sam_Att/sync-schedules', {
      method: 'POST',
      cookie: cookiePair,
      body: { scheduleLabel: 'No CSRF', cronTime: '12:00' },
    });
    assert.equal(csrfBlocked.status, 403);
    assert.equal(csrfBlocked.data.error, 'CSRF_VALIDATION_FAILED');

    // 2. Login RESPONSIBLE_STAFF
    const staffRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(staffRes.status, 200);
    assert.equal(staffRes.data.user.role, 'RESPONSIBLE_STAFF');
    staffToken = staffRes.data.token;

    // 3. Login GENERAL_USER
    const userRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(userRes.status, 200);
    assert.equal(userRes.data.user.role, 'GENERAL_USER');
    assert.equal(userRes.data.user.approvedPersonId, 'SAM-P003');
    generalUserToken = userRes.data.token;

    // 4. Test Logout Token Revocation & Cookie Clearing
    const tempLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1004', password: 'User@SamAtt2026' },
    });
    assert.equal(tempLogin.status, 200);
    const tempCookie = tempLogin.setCookies.find((c) => c.startsWith('sam_att_session='))!.split(';')[0];
    const tempCsrf = tempLogin.data.csrfToken;

    const logoutRes = await apiCall('/api/Sam_Att/auth/logout', {
      method: 'POST',
      cookie: tempCookie,
      csrfToken: tempCsrf,
    });
    assert.equal(logoutRes.status, 200);
    assert.ok(logoutRes.setCookies.some((c) => c.includes('Max-Age=0')), 'Logout must clear session cookies');

    const afterLogout = await apiCall('/api/Sam_Att/auth/me', {
      cookie: tempCookie,
    });
    assert.equal(afterLogout.status, 401);
    assert.equal(afterLogout.data.error, 'TOKEN_REVOKED');

    // 5. Brute-force lockout after 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const bad = await apiCall('/api/Sam_Att/auth/login', {
        method: 'POST',
        body: { username: 'brute_target_user', password: 'WrongPassword!' },
      });
      assert.equal(bad.status, 401);
    }
    const lockedRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'brute_target_user', password: 'WrongPassword!' },
    });
    assert.equal(lockedRes.status, 429);
    assert.equal(lockedRes.data.error, 'ACCOUNT_TEMPORARILY_LOCKED');

    // 6. Production Configuration Validation Fail-Closed (Items 03–04, 15)
    assert.throws(
      () => {
        const badProdCfg = {
          ...loadConfig(),
          nodeEnv: 'production',
          dbEngine: 'sqlite_sandbox' as const,
          auth: {
            jwtSecret: '',
            jwtSecretExplicitlyConfigured: false,
            sessionTtlMinutes: 480,
            rateLimitWindowMinutes: 15,
            rateLimitMaxAttempts: 5,
          },
        };
        validateProductionConfig(badProdCfg);
      },
      (err: unknown) => err instanceof ProductionConfigError && err.code === 'FAIL_CLOSED_CONFIG_INVALID',
      'Must fail closed when production configuration is missing secrets or using non-MySQL engine'
    );
  });

  test('Phase 1 Gate: 3-Role RBAC & Own-Only Anti-IDOR Enforcement', async () => {
    const ownAtt = await apiCall('/api/Sam_Att/me/attendance', {
      token: generalUserToken,
    });
    assert.equal(ownAtt.status, 200);
    assert.equal(ownAtt.data.personId, 'SAM-P003');

    const idorAttempt = await apiCall('/api/Sam_Att/me/attendance?personId=SAM-P001', {
      token: generalUserToken,
    });
    assert.equal(idorAttempt.status, 403);
    assert.equal(idorAttempt.data.error, 'FORBIDDEN_IDOR_ATTEMPT');

    const dashDenied = await apiCall('/api/Sam_Att/dashboard/summary', {
      token: generalUserToken,
    });
    assert.equal(dashDenied.status, 403);

    const logsDenied = await apiCall('/api/Sam_Att/system-logs', {
      token: generalUserToken,
    });
    assert.equal(logsDenied.status, 403);

    const staffDash = await apiCall('/api/Sam_Att/dashboard/summary', {
      token: staffToken,
    });
    assert.equal(staffDash.status, 200);

    const staffUsersDenied = await apiCall('/api/Sam_Att/users', {
      token: staffToken,
    });
    assert.equal(staffUsersDenied.status, 403);
  });

  test('Phase 1 Gate (Item 14): Database Unavailable Fail-Closed Behavior & Error Sanitization (Zero DB Host/Stack Leakage)', async () => {
    setSimulatedDatabaseDown(true);
    try {
      const healthDown = await apiCall('/api/Sam_Att/health');
      assert.equal(healthDown.status, 503);
      assert.equal(healthDown.data.status, 'FAIL_CLOSED');
      assert.equal(healthDown.data.error, 'DB_UNAVAILABLE');
      assert.equal(healthDown.data.message.includes('3306'), false, 'Must not leak DB port or connection string');

      const apiDown = await apiCall('/api/Sam_Att/dashboard/summary', {
        token: adminToken,
      });
      assert.equal(apiDown.status, 503);
      assert.equal(apiDown.data.error, 'DB_UNAVAILABLE');
      assert.equal(apiDown.data.message.includes('samchuk_attendance_v2'), false, 'Must not leak internal schema details');
    } finally {
      setSimulatedDatabaseDown(false);
    }
  });

  test('Phase 2 Gate (Items 16–17): HOSOffice Read-Only Sync Fail-Closed, Idempotent Upsert, and Duplicate FINGLE_ID Conflict Detection', async () => {
    const unconfiguredSync = await apiCall('/api/Sam_Att/personnel/sync', {
      method: 'POST',
      token: staffToken,
      body: { effectiveDate: '2026-11-13' },
    });
    assert.equal(unconfiguredSync.status, 503);
    assert.equal(unconfiguredSync.data.error, 'BLOCKED_BY_EXTERNAL_CONTRACT');

    setHosOfficeTestDouble([
      {
        PERSON_ID: 'SAM-P006',
        FINGLE_ID: '9009',
        TITLE_NAME: 'นาง',
        FIRST_NAME: 'กนกวรรณ',
        LAST_NAME: 'ทดสอบซิงก์',
        POSITION_NAME: 'เภสัชกร',
        DEPARTMENT_CODE: 'DEP-PHA',
        DEPARTMENT_NAME: 'กลุ่มงานเภสัชกรรม',
        WORK_GROUP_NAME: 'กลุ่มงานเภสัชกรรม',
        PERSONNEL_TYPE_CODE: 'CIVIL_SERVANT',
        PERSONNEL_TYPE_NAME: 'ข้าราชการ',
        IS_ACTIVE: 1,
      },
      {
        PERSON_ID: 'SAM-P007',
        FINGLE_ID: '9009',
        TITLE_NAME: 'นาย',
        FIRST_NAME: 'ธีรภัทร',
        LAST_NAME: 'ซ้ำรหัสสแกน',
        POSITION_NAME: 'เจ้าพนักงานเภสัชกรรม',
        DEPARTMENT_CODE: 'DEP-PHA',
        DEPARTMENT_NAME: 'กลุ่มงานเภสัชกรรม',
        WORK_GROUP_NAME: 'กลุ่มงานเภสัชกรรม',
        PERSONNEL_TYPE_CODE: 'PUBLIC_HEALTH_EMP',
        PERSONNEL_TYPE_NAME: 'พนักงานกระทรวงสาธารณสุข (พกส.)',
        IS_ACTIVE: 1,
      },
    ]);

    try {
      const sync1 = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: staffToken,
        body: { effectiveDate: '2026-11-13' },
      });
      assert.equal(sync1.status, 200);
      assert.equal(sync1.data.recordsUpserted, 2);
      assert.equal(sync1.data.mappingConflictsFound, 2);

      const sync2 = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: staffToken,
        body: { effectiveDate: '2026-11-13' },
      });
      assert.equal(sync2.status, 200);

      const issues = await apiCall('/api/Sam_Att/personnel/mapping-issues', {
        token: staffToken,
      });
      assert.equal(issues.status, 200);
      const dupPersons = issues.data.personnelIssues.filter(
        (p: any) => p.mapping_status === 'DUPLICATE_FINGLE_ID'
      );
      assert.equal(dupPersons.length, 2);
    } finally {
      setHosOfficeTestDouble(null);
    }
  });

  test('Phase 3 Gate (Items 08, 09, 18): Raw Scan Append-Only Immutability Guard, Derived Mappings, Automatic Scheduler, and ScannerReader.exe Live Acceptance', async () => {
    // 1. Hardware sync when SCANNER_SYNC_ENABLED=false fails closed
    const hwSync = await apiCall('/api/Sam_Att/scanners/sync', {
      method: 'POST',
      token: staffToken,
    });
    assert.equal(hwSync.status, 503);
    assert.equal(hwSync.data.error, 'BLOCKED_BY_EXTERNAL_CONTRACT');

    // 2. Verify Append-Only Immutability Guard on raw_scans (Item 08)
    await assert.rejects(
      async () => {
        await dbExecute("UPDATE raw_scans SET mapping_state = 'MUTATED' WHERE id = 1");
      },
      (err: unknown) => err instanceof ImmutableTableViolationError && err.code === 'IMMUTABLE_TABLE_VIOLATION',
      'Direct UPDATE on raw_scans must be blocked by ImmutableTableViolationError'
    );

    await assert.rejects(
      async () => {
        await dbExecute('DELETE FROM raw_scans WHERE id = 1');
      },
      (err: unknown) => err instanceof ImmutableTableViolationError,
      'Direct DELETE on raw_scans must be blocked by ImmutableTableViolationError'
    );

    // 3. Test X-Scanner-Token timing-safe authentication (Item 04)
    const badScannerTokenRes = await apiCall('/api/Sam_Att/scanners/ingest', {
      method: 'POST',
      scannerToken: 'wrong-scanner-token-value',
      body: { events: [] },
    });
    assert.equal(badScannerTokenRes.status, 401);
    assert.equal(badScannerTokenRes.data.error, 'INVALID_SCANNER_TOKEN');

    const cfg = loadConfig();
    const sampleBatch = [
      {
        machineNo: 101,
        enrollNumber: '1001',
        scanDateTime: '2026-11-13 07:54:00',
        verifyMode: 1,
        inOutMode: 0,
        workCode: 0,
      },
      {
        machineNo: 101,
        enrollNumber: '1001',
        scanDateTime: '2026-11-13 16:03:00',
        verifyMode: 1,
        inOutMode: 1,
        workCode: 0,
      },
    ];

    const ingest1 = await apiCall('/api/Sam_Att/scanners/ingest', {
      method: 'POST',
      scannerToken: cfg.scanner.ingestSharedToken,
      body: { events: sampleBatch },
    });
    assert.equal(ingest1.status, 201);
    assert.equal(ingest1.data.newInserted, 2);
    assert.equal(ingest1.data.duplicatesSkipped, 0);

    const ingest2 = await apiCall('/api/Sam_Att/scanners/ingest', {
      method: 'POST',
      token: staffToken,
      body: { events: sampleBatch },
    });
    assert.equal(ingest2.status, 201);
    assert.equal(ingest2.data.newInserted, 0);
    assert.equal(ingest2.data.duplicatesSkipped, 2);

    // 4. ScannerReader.exe Live Acceptance: Timeout, Malformed JSON, Concurrency Lock, and Automatic Scheduler (Items 09 & 18)
    try {
      // 4a. Timeout / Unreachable Device simulation
      const timeoutErr = new Error('SCANNER_TIMEOUT: Simulated EXE timeout after 30000ms');
      (timeoutErr as Error & { code?: string }).code = 'SCANNER_TIMEOUT';
      setScannerExeTestDouble(timeoutErr);

      const syncTimeoutRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
      });
      assert.equal(syncTimeoutRes.status, 503);
      assert.equal(syncTimeoutRes.data.error, 'SCANNER_TIMEOUT');

      // 4b. Malformed JSON output from EXE
      setScannerExeTestDouble('NOT_VALID_JSON_OUTPUT');
      const syncBadJsonRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
      });
      assert.equal(syncBadJsonRes.status, 422);
      assert.equal(syncBadJsonRes.data.error, 'INVALID_EXE_JSON_OUTPUT');

      // 4c. Concurrency Mutex Lock (prevents overlapping sync runs)
      setScannerSyncLockForTests(true);
      try {
        const concurrentRes = await apiCall('/api/Sam_Att/scanners/sync', {
          method: 'POST',
          token: staffToken,
        });
        assert.equal(concurrentRes.status, 409);
        assert.equal(concurrentRes.data.error, 'SYNC_ALREADY_RUNNING');
      } finally {
        setScannerSyncLockForTests(false);
      }

      // 4d. Automatic Scanner Scheduler at 08:00 BKK Time (reads sync_schedules, ingests 6-field JSON, and auto-reprocesses)
      resetSchedulerHistoryForTests();
      setScannerExeTestDouble(
        JSON.stringify([
          {
            machineNo: 101,
            enrollNumber: '1004',
            scanDateTime: '2026-11-13 07:48:00',
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 101,
            enrollNumber: '1004',
            scanDateTime: '2026-11-13 16:04:00',
            verifyMode: 1,
            inOutMode: 1,
            workCode: 0,
          },
        ])
      );

      const schedRun = await apiCall('/api/Sam_Att/scanners/scheduler/run-due', {
        method: 'POST',
        token: adminToken,
        body: { referenceBkkNow: '2026-11-13 08:00:05' },
      });
      assert.equal(schedRun.status, 200);
      assert.ok(schedRun.data.triggeredSchedules.length >= 1, 'Scheduler must trigger the 08:00 schedule');
      assert.equal(schedRun.data.triggeredSchedules[0].status, 'SUCCESS');

      // 4e. ScannerSyncCli.exe Wrapper JSON Contract ({ success, totalRead, machines, scans })
      setScannerExeTestDouble(
        JSON.stringify({
          success: true,
          totalRead: 2,
          totalNew: 0,
          duplicates: 2,
          unmapped: 0,
          affectedDates: ['2026-11-13'],
          machines: [
            {
              machineNo: 1,
              ip: '192.168.111.163',
              read: 2,
              new: 0,
              duplicates: 2,
              status: 'OK',
            },
          ],
          scans: [
            {
              machineNo: 101,
              enrollNumber: '1004',
              scanDateTime: '2026-11-13 07:48:00',
              verifyMode: 1,
              inOutMode: 0,
              workCode: 0,
            },
            {
              machineNo: 101,
              enrollNumber: '1004',
              scanDateTime: '2026-11-13 16:04:00',
              verifyMode: 1,
              inOutMode: 1,
              workCode: 0,
            },
          ],
        })
      );

      const cliWrapperSyncRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
      });
      assert.equal(cliWrapperSyncRes.status, 200);
      assert.equal(cliWrapperSyncRes.data.totalRead, 2);
      assert.equal(cliWrapperSyncRes.data.duplicatesSkipped, 2);
    } finally {
      setScannerExeTestDouble(null);
    }

    // 5. Verify Cross-Midnight Shift calculation and Raw Scan Immutability across Note/Review/Reprocess
    const attList = await apiCall('/api/Sam_Att/attendance?dateFrom=2026-11-12&dateTo=2026-11-13', {
      token: staffToken,
    });
    assert.equal(attList.status, 200);
    const crossMidnightRow = attList.data.items.find(
      (a: any) => a.person_id === 'SAM-P002' && a.shift_code === 'EXT-2008'
    );
    assert.ok(crossMidnightRow, 'Cross-midnight shift EXT-2008 must be evaluated');
    assert.equal(crossMidnightRow.status, 'NORMAL');
    assert.equal(crossMidnightRow.check_in_time, '2026-11-12 19:55:18');
    assert.equal(crossMidnightRow.check_out_time, '2026-11-13 08:06:30');

    const rawBefore = await dbQuery('SELECT * FROM raw_scans ORDER BY id ASC');
    const noScanRow = attList.data.items.find((a: any) => a.status === 'NO_SCAN' || a.status === 'MISSING_CHECKOUT');
    assert.ok(noScanRow);

    const noteRes = await apiCall(`/api/Sam_Att/attendance/${noScanRow.id}/notes`, {
      method: 'POST',
      token: staffToken,
      body: {
        reasonType: 'OFFICIAL_DUTY',
        noteText: 'ไปราชการตามหนังสือสั่งการ รพ.สามชุก ที่ สพ 0033/112',
      },
    });
    assert.equal(noteRes.status, 201);

    const revRes = await apiCall(`/api/Sam_Att/attendance/${noScanRow.id}/review`, {
      method: 'POST',
      token: staffToken,
      body: {
        reviewStatus: 'VERIFIED_APPROVED',
        reviewReasonCategory: 'OFFICIAL_DUTY',
        reviewComment: 'ตรวจสอบใบขออนุมัติไปราชการเรียบร้อย',
      },
    });
    assert.equal(revRes.status, 200);

    const rep1 = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13', referenceNowBkk: '2026-11-13 18:00:00' },
    });
    assert.equal(rep1.status, 200);

    const rawAfter = await dbQuery('SELECT * FROM raw_scans ORDER BY id ASC');
    assert.deepEqual(rawBefore, rawAfter, 'Entire raw_scans table must remain 100% untouched after reprocess');
  });

  test('Phase 4 Gate (Item 07): Dashboard KPIs, CSV Injection Protection, and HOSOffice Live Push Contract Verification, Idempotency, UNKNOWN State & Reconciliation', async () => {
    const dash = await apiCall('/api/Sam_Att/dashboard/summary?dateFrom=2026-11-12&dateTo=2026-11-13', {
      token: staffToken,
    });
    assert.equal(dash.status, 200);
    assert.equal(dash.data.kpi.latePeople, 2);
    assert.equal(dash.data.kpi.lateOccurrences, 3);
    assert.equal(dash.data.kpi.totalLateMinutes, 85);

    assert.equal(sanitizeCsvCell('=CMD|\' /C calc\'!A0'), '"\'=CMD|\' /C calc\'!A0"');
    assert.equal(sanitizeCsvCell('+SUM(A1:A10)'), '"\'+SUM(A1:A10)"');
    assert.equal(sanitizeCsvCell('@IMPORTXML()'), '"\'@IMPORTXML()"');

    const csvExport = await apiCall('/api/Sam_Att/reports/lateness/export.csv?dateFrom=2026-11-12&dateTo=2026-11-13', {
      token: staffToken,
    });
    assert.equal(csvExport.status, 200);
    assert.ok(csvExport.rawText.includes('PERSON_ID'));
    assert.ok(csvExport.rawText.includes('SAM-P003'));

    // Dry-run preview works with zero external side effects
    const previewPush = await apiCall('/api/Sam_Att/hosoffice/push/preview', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13' },
    });
    assert.equal(previewPush.status, 200);
    assert.equal(previewPush.data.mode, 'DRY_RUN_PREVIEW');

    // Live Push blocked when feature flag is false or target table is empty
    const livePushBlocked = await apiCall('/api/Sam_Att/hosoffice/push', {
      method: 'POST',
      token: adminToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13' },
    });
    assert.equal(livePushBlocked.status, 403);
    assert.equal(livePushBlocked.data.error, 'HOSOFFICE_LIVE_PUSH_DISABLED');

    // Setup Simulated HOSOffice Target Table with Unique Composite Key & Contract Inspection
    process.env.HOSOFFICE_LIVE_PUSH_ENABLED = 'true';
    process.env.HOSOFFICE_PUSH_TARGET_TABLE = 'fingle_scan_attendance';

    const simulatedHosOfficeRows = new Map<
      string,
      {
        record: ValidatedHosOfficePushRecord;
        batchKey: string;
        recordIdempotencyKey: string;
      }
    >();

    let contractShouldBeInvalid = false;

    setHosOfficeTargetAdapterForTests({
      async inspectTableContract(tableName: string): Promise<HosOfficeTableContractSchema> {
        if (contractShouldBeInvalid) {
          return {
            tableName,
            columns: [{ name: 'PERSON_ID', dataType: 'varchar' }], // missing required columns & unique key
            uniqueKeys: [],
            permissions: ['SELECT'],
          };
        }
        return {
          tableName,
          columns: REQUIRED_HOSOFFICE_TARGET_COLUMNS.map((c) => ({
            name: c.name,
            dataType: c.allowedTypes[0],
          })),
          uniqueKeys: [['PERSON_ID', 'WORK_DATE', 'SHIFT_CODE'], ['IDEMPOTENCY_KEY']],
          permissions: ['SELECT', 'INSERT', 'UPDATE'],
        };
      },
      async writeIdempotentBatch(tableName, records, batchIdempotencyKey) {
        let deduplicatedCount = 0;
        for (const rec of records) {
          const shiftCode = rec.SHIFT_CODE || 'DEFAULT';
          const compositeKey = `${tableName}:${rec.PERSON_ID}:${rec.WORK_DATE}:${shiftCode}`;
          const recordIdempotencyKey = `${batchIdempotencyKey}:${rec.PERSON_ID}:${rec.WORK_DATE}:${shiftCode}`;
          if (simulatedHosOfficeRows.has(compositeKey)) {
            deduplicatedCount++;
          }
          simulatedHosOfficeRows.set(compositeKey, {
            record: rec,
            batchKey: batchIdempotencyKey,
            recordIdempotencyKey,
          });
        }
        return { writtenCount: records.length, deduplicatedCount };
      },
      async queryRecordsByBatchKey(_tableName, batchIdempotencyKey) {
        const out: Array<{
          personId: string;
          workDate: string;
          shiftCode: string;
          recordIdempotencyKey: string;
        }> = [];
        for (const item of simulatedHosOfficeRows.values()) {
          if (item.batchKey === batchIdempotencyKey) {
            out.push({
              personId: item.record.PERSON_ID,
              workDate: item.record.WORK_DATE,
              shiftCode: item.record.SHIFT_CODE || 'DEFAULT',
              recordIdempotencyKey: item.recordIdempotencyKey,
            });
          }
        }
        return out;
      },
    });

    try {
      // 1. Reject invalid HOSOffice Target Table Schema Contract (409 HOSOFFICE_SCHEMA_CONTRACT_INVALID)
      contractShouldBeInvalid = true;
      const badContractRes = await apiCall('/api/Sam_Att/hosoffice/push', {
        method: 'POST',
        token: staffToken,
        body: {
          dateFrom: '2026-11-12',
          dateTo: '2026-11-13',
          idempotencyKey: 'LIVE-BATCH-CONTRACT-FAIL',
        },
      });
      assert.equal(badContractRes.status, 409);
      assert.equal(badContractRes.data.error, 'HOSOFFICE_SCHEMA_CONTRACT_INVALID');
      assert.equal(simulatedHosOfficeRows.size, 0, 'Must write zero rows when schema contract fails');

      // 2. Test Outbox UNKNOWN State: HOSOffice write succeeds, but Sam_Att local confirmation fails
      contractShouldBeInvalid = false;
      setSimulatePostHosOfficeCommitLocalDbFailureForTests(true);

      const unknownStateRes = await apiCall('/api/Sam_Att/hosoffice/push', {
        method: 'POST',
        token: staffToken,
        body: {
          dateFrom: '2026-11-12',
          dateTo: '2026-11-13',
          idempotencyKey: 'LIVE-BATCH-20261112-20261113',
        },
      });
      assert.equal(unknownStateRes.status, 502);
      assert.equal(unknownStateRes.data.status, 'UNKNOWN');
      assert.equal(unknownStateRes.data.error, 'HOSOFFICE_COMMIT_LOCAL_SYNC_UNKNOWN');
      assert.equal(unknownStateRes.data.reconciliationRequired, true);
      const countAfterFirstWrite = simulatedHosOfficeRows.size;
      assert.ok(countAfterFirstWrite > 0, 'HOSOffice target table already committed the rows');

      setSimulatePostHosOfficeCommitLocalDbFailureForTests(false);

      // 3. Reconcile UNKNOWN batch via POST /hosoffice/push/reconcile -> confirms rows in HOSOffice and marks SUCCESS
      const reconcileRes = await apiCall('/api/Sam_Att/hosoffice/push/reconcile', {
        method: 'POST',
        token: staffToken,
        body: { idempotencyKey: 'LIVE-BATCH-20261112-20261113' },
      });
      assert.equal(reconcileRes.status, 200);
      assert.equal(reconcileRes.data.status, 'RECONCILED');
      assert.equal(reconcileRes.data.items[0].previousStatus, 'UNKNOWN');
      assert.equal(reconcileRes.data.items[0].resolvedStatus, 'SUCCESS');
      assert.equal(simulatedHosOfficeRows.size, countAfterFirstWrite, 'Zero duplicate rows created');

      // 4. Duplicate push with already-SUCCESS Idempotency Key MUST be blocked with 409
      const dupPushRes = await apiCall('/api/Sam_Att/hosoffice/push', {
        method: 'POST',
        token: adminToken,
        body: {
          dateFrom: '2026-11-12',
          dateTo: '2026-11-13',
          idempotencyKey: 'LIVE-BATCH-20261112-20261113',
        },
      });
      assert.equal(dupPushRes.status, 409);
      assert.equal(dupPushRes.data.error, 'DUPLICATE_IDEMPOTENCY_KEY');
    } finally {
      process.env.HOSOFFICE_LIVE_PUSH_ENABLED = 'false';
      process.env.HOSOFFICE_PUSH_TARGET_TABLE = '';
      setSimulatePostHosOfficeCommitLocalDbFailureForTests(false);
      setHosOfficeTargetAdapterForTests(null);
    }
  });

  test('Phase 2 & 3 Gate (Items 06, 10–11): Real Deployment Agent, Staging, Active Release Switch, Auto-Revert on Failure, and Verified Database + Release Rollback', async () => {
    await ensureBaselineDeploymentWorkspaceInitialized();

    const settingsRes = await apiCall('/api/Sam_Att/settings/connections', {
      token: adminToken,
    });
    assert.equal(settingsRes.status, 200);
    assert.equal(settingsRes.data.samAttDatabase.password, undefined, 'Must never leak DB password');

    const preflight = await apiCall('/api/Sam_Att/deployment/preflight', {
      method: 'POST',
      token: adminToken,
    });
    assert.equal(preflight.status, 200);
    assert.equal(preflight.data.preflightPassed, true);

    // 1. Block Path Traversal in artifactFilePath
    const traversalArtifact = buildReleaseArtifactFile({
      releaseVersion: '2.0.2-standalone',
      commitSha: '11223344556677889900aabbccddeeff00112233',
    });

    const traversalRes = await apiCall('/api/Sam_Att/deployment/approve', {
      method: 'POST',
      token: adminToken,
      body: {
        adminPassword: 'Admin@SamAtt2026',
        releaseVersion: '2.0.2-standalone',
        commitSha: '11223344556677889900aabbccddeeff00112233',
        artifactFilePath: '../../etc/passwd',
        artifactSha256: traversalArtifact.artifactSha256,
      },
    });
    assert.equal(traversalRes.status, 422);
    assert.equal(traversalRes.data.error, 'UNSAFE_PATH_TRAVERSAL');

    // 2. Reject non-existent artifact file on disk
    const missingArtifactRes = await apiCall('/api/Sam_Att/deployment/approve', {
      method: 'POST',
      token: adminToken,
      body: {
        adminPassword: 'Admin@SamAtt2026',
        releaseVersion: '2.0.2-standalone',
        commitSha: '11223344556677889900aabbccddeeff00112233',
        artifactFilePath: 'non_existent_package.artifact.json',
        artifactSha256: traversalArtifact.artifactSha256,
      },
    });
    assert.equal(missingArtifactRes.status, 422);
    assert.equal(missingArtifactRes.data.error, 'ARTIFACT_FILE_NOT_FOUND');

    // 3. Reject mismatched SHA-256 on real artifact file
    const wrongSha256 = '0000000000000000000000000000000000000000000000000000000000000000';
    const shaMismatchRes = await apiCall('/api/Sam_Att/deployment/approve', {
      method: 'POST',
      token: adminToken,
      body: {
        adminPassword: 'Admin@SamAtt2026',
        releaseVersion: '2.0.2-standalone',
        commitSha: '11223344556677889900aabbccddeeff00112233',
        artifactFilePath: traversalArtifact.artifactRelativeName,
        artifactSha256: wrongSha256,
      },
    });
    assert.equal(shaMismatchRes.status, 422);
    assert.equal(shaMismatchRes.data.status, 'FAILED');
    assert.equal(shaMismatchRes.data.error, 'ARTIFACT_SHA256_MISMATCH');

    // 4. Deploy real artifact 2.0.2-standalone -> verifies Staging, Backup creation, Active Release switch, and Version change
    const beforeMeta = getActiveReleaseMetadata();
    assert.equal(beforeMeta?.releaseVersion, '2.0.0-standalone');

    const goodApprove = await apiCall('/api/Sam_Att/deployment/approve', {
      method: 'POST',
      token: adminToken,
      body: {
        adminPassword: 'Admin@SamAtt2026',
        releaseVersion: '2.0.2-standalone',
        commitSha: '11223344556677889900aabbccddeeff00112233',
        artifactFilePath: traversalArtifact.artifactRelativeName,
        artifactSha256: traversalArtifact.artifactSha256,
      },
    });
    assert.equal(goodApprove.status, 200);
    assert.equal(goodApprove.data.status, 'SUCCESS');
    assert.equal(goodApprove.data.healthCheck.activeReleaseVersion, '2.0.2-standalone');
    assert.equal(fs.existsSync(goodApprove.data.backupArchivePath), true, 'Backup directory must exist on disk');
    assert.equal(getActiveReleaseMetadata()?.releaseVersion, '2.0.2-standalone', 'Active release on disk must now be 2.0.2-standalone');

    // 5. Test Automatic Revert when Post-Switch Health Check fails
    const brokenReleaseArtifact = buildReleaseArtifactFile({
      releaseVersion: '2.0.3-broken',
      commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    });
    await assert.rejects(
      async () => {
        await executeStandaloneDeployment({
          releaseVersion: '2.0.3-broken',
          commitSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
          expectedArtifactSha256: brokenReleaseArtifact.artifactSha256,
          artifactFilePath: brokenReleaseArtifact.artifactRelativeName,
          actorUsername: 'admin',
          simulatePostSwitchHealthFailure: true,
        });
      },
      /POST_DEPLOY_HEALTHCHECK_FAILED/
    );
    assert.equal(
      getActiveReleaseMetadata()?.releaseVersion,
      '2.0.2-standalone',
      'Active release must automatically revert to 2.0.2-standalone when deploy health check fails'
    );

    // 6. Test Phase 3 Backup -> Mutate Database Data -> Rollback -> Verify Both Database Data & Release Version Restored!
    const schedulesBeforeMutation = await dbQuery<{ id: number; cron_time: string }>(
      'SELECT id, cron_time FROM sync_schedules ORDER BY id ASC'
    );
    assert.equal(schedulesBeforeMutation[0].cron_time, '00:00');

    // Mutate database table sync_schedules after backup was taken during goodApprove
    await dbExecute("UPDATE sync_schedules SET cron_time = '05:55' WHERE id = 1");
    const mutatedSchedule = await dbQuery<{ cron_time: string }>('SELECT cron_time FROM sync_schedules WHERE id = 1');
    assert.equal(mutatedSchedule[0].cron_time, '05:55');

    // Also test Pre-Restore Safety Recovery when restore fails midway
    await assert.rejects(
      async () => {
        await executeStandaloneRollback({
          targetBackupId: goodApprove.data.deploymentId,
          reason: 'Test Midway Restore Failure Safety Recovery',
          actorUsername: 'admin',
          simulateMidwayRestoreFailure: true,
        });
      },
      /RESTORE_MIDWAY_INTERRUPTED/
    );
    // Verify pre-restore state was automatically recovered after midway failure
    const afterFailedRestoreSchedule = await dbQuery<{ cron_time: string }>(
      'SELECT cron_time FROM sync_schedules WHERE id = 1'
    );
    assert.equal(afterFailedRestoreSchedule[0].cron_time, '05:55', 'Pre-restore safety recovery must restore mutated state on midway error');
    assert.equal(getActiveReleaseMetadata()?.releaseVersion, '2.0.2-standalone');

    // Now execute real Rollback to goodApprove's backup (which backed up 2.0.0-standalone and cron_time = '00:00')
    const rollbackRes = await apiCall('/api/Sam_Att/deployment/rollback', {
      method: 'POST',
      token: adminToken,
      body: {
        targetBackupId: goodApprove.data.deploymentId,
        reason: 'ทดสอบการกู้คืนฐานข้อมูลและ Release จริงจาก Backup',
      },
    });
    assert.equal(rollbackRes.status, 200);
    assert.equal(rollbackRes.data.status, 'SUCCESS');
    assert.equal(rollbackRes.data.targetVersion, '2.0.0-standalone');
    assert.equal(getActiveReleaseMetadata()?.releaseVersion, '2.0.0-standalone', 'Active release version must roll back to 2.0.0-standalone');

    const restoredSchedule = await dbQuery<{ cron_time: string }>('SELECT cron_time FROM sync_schedules WHERE id = 1');
    assert.equal(restoredSchedule[0].cron_time, '00:00', 'Database table sync_schedules must be restored to 00:00 from backup');

    // 7. Verify Rollback strictly fails with BACKUP_ARCHIVE_MISSING if the backup folder is deleted (never fabricates a fake backup!)
    fs.rmSync(goodApprove.data.backupArchivePath, { recursive: true, force: true });
    const missingBackupRollback = await apiCall('/api/Sam_Att/deployment/rollback', {
      method: 'POST',
      token: adminToken,
      body: {
        targetBackupId: goodApprove.data.deploymentId,
        reason: 'Must fail when backup folder is missing',
      },
    });
    assert.equal(missingBackupRollback.status, 422);
    assert.equal(missingBackupRollback.data.error, 'BACKUP_ARCHIVE_MISSING');
  });

  test('Suite 9: Shift Roster & Templates — Multi-Person/Multi-Day Bulk Conflict Preview, Transactional Bulk Assignment, Snapshot & Soft Cancel Preservation', async () => {
    // 1. Snapshot existing assignments on 2026-11-12 to ensure they are NEVER modified
    const beforeExisting = await dbQuery<{
      id: number;
      person_id: string;
      shift_id: number;
      work_date: string;
      snapshot_shift_code: string;
      updated_at: string;
    }>(
      "SELECT id, person_id, shift_id, work_date, snapshot_shift_code, updated_at FROM shift_assignments WHERE work_date = '2026-11-12' AND person_id IN ('SAM-P001', 'SAM-P002') ORDER BY id ASC"
    );
    assert.ok(beforeExisting.length >= 2, 'Seeded assignments on 2026-11-12 must exist');

    // 2. Call POST /api/Sam_Att/shift-assignments/bulk-preview for SAM-P001 & SAM-P002 across 2026-11-12, 2026-11-18, 2026-11-19 with shiftId=1 (OFF-0816)
    const previewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftId: 1,
        workDates: ['2026-11-12', '2026-11-18', '2026-11-19'],
      },
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.data.summary.totalRequested, 6);
    assert.equal(previewRes.data.summary.readyCount, 4, '4 slots (Nov 18 & 19 for both personnel) should be READY');
    assert.equal(previewRes.data.summary.conflictCount, 2, '2 slots on Nov 12 should be flagged as conflicts');
    assert.equal(previewRes.data.summary.duplicateCount, 1, 'SAM-P001 on Nov 12 already has shiftId=1 (DUPLICATE_SAME_SHIFT)');
    assert.equal(previewRes.data.summary.overlapCount, 1, 'SAM-P002 on Nov 12 already has MOR-0816 08:00-16:00 (TIME_OVERLAP_CONFLICT)');

    // 3. Call POST /api/Sam_Att/shift-assignments/bulk with ABORT_ON_CONFLICT -> must return 409 and insert 0 rows
    const abortBulkRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftId: 1,
        workDates: ['2026-11-12', '2026-11-18', '2026-11-19'],
        conflictStrategy: 'ABORT_ON_CONFLICT',
      },
    });
    assert.equal(abortBulkRes.status, 409);
    assert.equal(abortBulkRes.data.error, 'BULK_SHIFT_CONFLICT');

    const checkAfterAbort = await dbQuery<{ id: number }>(
      "SELECT id FROM shift_assignments WHERE work_date IN ('2026-11-18', '2026-11-19')"
    );
    assert.equal(checkAfterAbort.length, 0, 'ABORT_ON_CONFLICT must not insert any rows when conflicts exist');

    // 4. Call POST /api/Sam_Att/shift-assignments/bulk with SKIP_CONFLICTS -> must insert the 4 READY rows and skip the 2 conflicts without modifying existing rows
    const skipBulkRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftId: 1,
        workDates: ['2026-11-12', '2026-11-18', '2026-11-19'],
        conflictStrategy: 'SKIP_CONFLICTS',
      },
    });
    assert.equal(skipBulkRes.status, 201);
    assert.equal(skipBulkRes.data.insertedCount, 4);
    assert.equal(skipBulkRes.data.skippedConflictCount, 2);

    // 5. Verify existing assignments on 2026-11-12 were strictly untouched
    const afterExisting = await dbQuery<{
      id: number;
      person_id: string;
      shift_id: number;
      work_date: string;
      snapshot_shift_code: string;
      updated_at: string;
    }>(
      "SELECT id, person_id, shift_id, work_date, snapshot_shift_code, updated_at FROM shift_assignments WHERE work_date = '2026-11-12' AND person_id IN ('SAM-P001', 'SAM-P002') ORDER BY id ASC"
    );
    assert.deepEqual(afterExisting, beforeExisting, 'Existing shift assignments must never be modified during bulk assignment');

    // 6. Verify newly inserted rows have full Snapshot fields preserved
    const newlyInserted = await dbQuery<{
      id: number;
      person_id: string;
      work_date: string;
      snapshot_shift_code: string;
      snapshot_start_time: string;
      snapshot_end_time: string;
      snapshot_grace_minutes: number;
      snapshot_cutoff_time: string;
      status: string;
    }>(
      "SELECT id, person_id, work_date, snapshot_shift_code, snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time, status FROM shift_assignments WHERE work_date IN ('2026-11-18', '2026-11-19') ORDER BY work_date ASC, person_id ASC"
    );
    assert.equal(newlyInserted.length, 4);
    assert.equal(newlyInserted[0].snapshot_shift_code, 'OFF-0816');
    assert.equal(newlyInserted[0].snapshot_start_time, '08:00');
    assert.equal(newlyInserted[0].snapshot_end_time, '16:00');
    assert.equal(newlyInserted[0].snapshot_grace_minutes, 15);
    assert.equal(newlyInserted[0].snapshot_cutoff_time, '10:30');
    assert.equal(newlyInserted[0].status, 'ACTIVE');

    // 7. Verify Soft Cancel preserves the row as CANCELLED and logs to shift_cancellation_logs
    const targetCancelId = newlyInserted[0].id;
    const cancelRes = await apiCall(`/api/Sam_Att/shift-assignments/${targetCancelId}`, {
      method: 'DELETE',
      token: staffToken,
      body: { cancelReason: 'ทดสอบยกเลิกตารางเวรแบบบันทึกประวัติ (Soft Cancel)' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, 'CANCELLED');

    const cancelledRow = await dbQuery<{ status: string }>(
      'SELECT status FROM shift_assignments WHERE id = ?',
      [targetCancelId]
    );
    assert.equal(cancelledRow[0].status, 'CANCELLED');

    const cancelLog = await dbQuery<{ shift_assignment_id: number; cancel_reason: string }>(
      'SELECT shift_assignment_id, cancel_reason FROM shift_cancellation_logs WHERE shift_assignment_id = ?',
      [targetCancelId]
    );
    assert.equal(cancelLog.length, 1);
    assert.equal(cancelLog[0].cancel_reason, 'ทดสอบยกเลิกตารางเวรแบบบันทึกประวัติ (Soft Cancel)');
  });
});

