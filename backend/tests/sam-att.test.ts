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
  ensureBaselineSystemCatalog,
  seedBaselineAndSyntheticData,
  setSimulatedDatabaseDown,
  dbQuery,
  dbExecute,
  ImmutableTableViolationError,
} from '../src/database/adapter.ts';
import {
  loadConfig,
  validateProductionConfig,
  ProductionConfigError,
  assertTestEnvironmentIsolated,
  TestIsolationViolationError,
} from '../src/config/env.ts';
import { reprocessAttendanceRange } from '../src/modules/attendance/processor.ts';
import {
  setHosOfficeTestDouble,
  setHosOfficeSchemaColumnsForTests,
  validateHosOfficeHrPersonColumnsContract,
} from '../src/modules/personnel/routes.ts';
import {
  evaluateBulkShiftAssignments,
  evaluateDailyCellChange,
  evaluateDailyCellSync,
  findSelectedShiftsSelfOverlap,
  findAllSelectedShiftsSelfOverlaps,
  normalizeWorkDateString,
} from '../src/modules/shifts/routes.ts';
import {
  classifyShiftIconKind,
  buildCompactMonthlyCellViewModel,
  findClientSelectedShiftsOverlap,
  findAllClientSelectedShiftsOverlaps,
  computeClientShiftInterval,
  intervalsOverlapHalfOpen,
  computeFilteredSelectionState,
  toggleSelectAllFiltered,
} from '../../frontend/src/utils/shiftDisplay.ts';
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
import {
  sanitizeCsvCell,
  hasThaiMojibake,
  repairThaiMojibakeIfCorrupted,
  getCurrentBangkokDateParts,
} from '../src/utils/crypto.ts';
import { buildXlsxBufferFromRows } from '../src/utils/xlsx.ts';
import { setDeployBatRunnerForTests } from '../src/modules/settings/routes.ts';
import { runOneClickDeployment } from '../../deployment/deploy-runner.ts';

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
    const strayBunLock = path.resolve(process.cwd(), 'bun.lock');
    if (fs.existsSync(strayBunLock)) {
      try {
        fs.unlinkSync(strayBunLock);
      } catch {
        // ignore
      }
    }
    process.env.NODE_ENV = 'test';
    process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
    process.env.SAM_ATT_DATA_MODE = 'DEMO';
    process.env.PUBLIC_BASE_PATH = '/Sam_Att/';
    process.env.API_BASE_PATH = '/api/Sam_Att';
    process.env.SESSION_TTL_MINUTES = '480';
    process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '5';
    process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES = '15';
    process.env.HOSOFFICE_DB_HOST = 'CHANGE_ME';
    process.env.HOSOFFICE_DB_PORT = '3306';
    process.env.HOSOFFICE_DB_NAME = 'hosoffice';
    process.env.HOSOFFICE_DB_USER = 'hosoffice_readonly';
    process.env.HOSOFFICE_DB_PASSWORD = 'CHANGE_ME';
    process.env.HOSOFFICE_HR_PERSON_TABLE = 'hr_person';
    process.env.HOSOFFICE_PUSH_WRITE_USER = 'hosoffice_attendance_writer';
    process.env.HOSOFFICE_PUSH_WRITE_PASSWORD = 'CHANGE_ME';
    process.env.HOSOFFICE_LIVE_PUSH_ENABLED = 'false';
    process.env.HOSOFFICE_PUSH_TARGET_TABLE = '';
    process.env.SCANNER_SYNC_ENABLED = 'false';
    process.env.SCANNER_AUTO_SCHEDULER_ENABLED = 'false';
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
    // ตรวจว่า .gitignore ป้องกันไม่ให้ไฟล์ Private Key และ SQLite Runtime ถูก Commit ขึ้น Git และไม่มีไฟล์ bun.lock ค้าง
    const gitignoreRaw = fs.readFileSync(path.resolve(process.cwd(), '.gitignore'), 'utf8');
    assert.ok(gitignoreRaw.includes('certs/*.key'), 'certs/*.key must be excluded in .gitignore');
    assert.ok(gitignoreRaw.includes('data/*.sqlite'), 'data/*.sqlite must be excluded in .gitignore');
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

    // Regression A: Even if production HOSOFFICE_DB_HOST is injected into process.env during automated test run,
    // /personnel/sync must still fail closed with BLOCKED_BY_EXTERNAL_CONTRACT and never connect to external MySQL
    const prevHosHost = process.env.HOSOFFICE_DB_HOST;
    const prevHosPass = process.env.HOSOFFICE_DB_PASSWORD;
    try {
      process.env.HOSOFFICE_DB_HOST = '10.1.0.201';
      process.env.HOSOFFICE_DB_PASSWORD = 'SimulatedProductionPassword';
      const leakedEnvSync = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: staffToken,
        body: { effectiveDate: '2026-11-13' },
      });
      assert.equal(leakedEnvSync.status, 503);
      assert.equal(leakedEnvSync.data.error, 'BLOCKED_BY_EXTERNAL_CONTRACT');
    } finally {
      process.env.HOSOFFICE_DB_HOST = prevHosHost;
      process.env.HOSOFFICE_DB_PASSWORD = prevHosPass;
    }

    // Regression B: External schema contract verification must block incompatible hr_person tables BEFORE touching internal personnel table
    const countBeforeBadSchema = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM personnel');
    setHosOfficeSchemaColumnsForTests(['UNKNOWN_COL_A', 'UNKNOWN_COL_B']);
    try {
      const badSchemaSync = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: staffToken,
        body: { effectiveDate: '2026-11-13' },
      });
      assert.equal(badSchemaSync.status, 503);
      assert.equal(badSchemaSync.data.error, 'BLOCKED_BY_EXTERNAL_CONTRACT');
      const countAfterBadSchema = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM personnel');
      assert.equal(Number(countAfterBadSchema[0].cnt), Number(countBeforeBadSchema[0].cnt), 'Internal personnel table must remain untouched when external contract fails');
    } finally {
      setHosOfficeSchemaColumnsForTests(null);
    }

    assert.equal(
      validateHosOfficeHrPersonColumnsContract(['PERSON_ID', 'FINGLE_ID', 'FIRST_NAME', 'LAST_NAME']).valid,
      true
    );
    assert.equal(
      validateHosOfficeHrPersonColumnsContract(['ID', 'FINGLE_ID', 'HR_FNAME', 'HR_LNAME', 'HR_DEPARTMENT_ID']).valid,
      true
    );

    // Regression C: Test Database Isolation Fail-Closed Guard (blocks 10.1.0.201 / mysql engine in test mode)
    assert.doesNotThrow(() => assertTestEnvironmentIsolated(loadConfig()));
    assert.throws(
      () =>
        assertTestEnvironmentIsolated({
          ...loadConfig(),
          dbEngine: 'mysql',
          samAttDb: {
            ...loadConfig().samAttDb,
            host: '10.1.0.201',
            database: 'samchuk_attendance_v2',
          },
        }),
      (err: unknown) => err instanceof TestIsolationViolationError && err.code === 'TEST_ISOLATION_VIOLATION'
    );

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

    // 8. Regression: MySQL Date object returned for work_date must never throw TypeError: dateStr.split is not a function
    assert.equal(normalizeWorkDateString(new Date('2026-11-18T00:00:00.000+07:00')), '2026-11-18');
    assert.equal(normalizeWorkDateString('2026-11-18 00:00:00'), '2026-11-18');

    const mysqlDateSimEval = await evaluateBulkShiftAssignments(
      async <T = Record<string, unknown>>(sql: string): Promise<T[]> => {
        if (sql.includes('FROM personnel')) {
          return [
            {
              person_id: 10,
              full_name: 'นางสาวกัลยกร พูลทวี',
              department_name: 'กลุ่มงานการพยาบาล',
              personnel_type_name: 'พกส.',
            },
          ] as unknown as T[];
        }
        if (sql.includes('FROM shift_assignments')) {
          return [
            {
              id: 501,
              person_id: 10,
              shift_id: 1,
              work_date: new Date('2026-11-18T00:00:00.000+07:00') as unknown as string,
              snapshot_shift_code: 'OFF-0816',
              snapshot_shift_name: 'เวรราชการปกติ',
              snapshot_start_time: '08:00',
              snapshot_end_time: '16:00',
              snapshot_is_cross_midnight: 0,
              status: 'ACTIVE',
            },
          ] as unknown as T[];
        }
        return [];
      },
      {
        personIds: ['10'],
        shift: {
          id: 2,
          shift_code: 'MOR-0816',
          shift_name: 'เวรเช้า',
          shift_category: 'MORNING',
          start_time: '08:00',
          end_time: '16:00',
          grace_minutes: 15,
          cutoff_time: '10:30',
          is_cross_midnight: 0,
          is_active: 1,
        },
        workDates: ['2026-11-18', '2026-11-19'],
      }
    );
    assert.equal(mysqlDateSimEval.summary.totalRequested, 2);
    assert.equal(mysqlDateSimEval.summary.overlapCount, 1, 'Must detect overlap even when MySQL driver returns work_date as Date object');
    assert.equal(mysqlDateSimEval.summary.readyCount, 1);

    // 9. Regression: bulk-preview with non-existent personId must return 404 PERSONNEL_NOT_FOUND with requestId (never 500)
    const missingPersonPreview = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: ['NON-EXISTENT-PERSON-999'],
        shiftId: 1,
        workDates: ['2026-11-20'],
      },
    });
    assert.equal(missingPersonPreview.status, 404);
    assert.equal(missingPersonPreview.data.error, 'PERSONNEL_NOT_FOUND');
    assert.ok(missingPersonPreview.data.requestId, 'Error response must include requestId');
  });

  test('22. REAL vs DEMO Data Mode Isolation, Thai Mojibake Repair (TIS-620/Latin-1 -> UTF-8), Read-Only Data Integrity Audit & Dynamic Bangkok Dates', async () => {
    // 1. Verify Thai Mojibake detection & repair for Windows-874 / TIS-620 ("เธเธนเน...")
    const cleanThai = 'ผู้ดูแลระบบสูงสุด (โรงพยาบาลสามชุก)';
    const utf8Bytes = Buffer.from(cleanThai, 'utf8');
    const tis620CorruptedChars: string[] = [];
    for (const b of utf8Bytes) {
      if (b < 0x80) {
        tis620CorruptedChars.push(String.fromCharCode(b));
      } else if (b >= 0xa1 && b <= 0xfb) {
        tis620CorruptedChars.push(String.fromCharCode(b + 0x0d60));
      } else if (b === 0x85) {
        tis620CorruptedChars.push('\u2026');
      } else {
        tis620CorruptedChars.push(String.fromCharCode(b));
      }
    }
    const corruptedTis620String = tis620CorruptedChars.join('');
    assert.ok(corruptedTis620String.includes('เธ'), 'Simulated TIS-620 Mojibake must contain เธ pattern');
    assert.equal(hasThaiMojibake(corruptedTis620String), true, 'Must detect TIS-620 Mojibake');
    assert.equal(hasThaiMojibake(cleanThai), false, 'Valid Thai string must not be flagged as Mojibake');

    const repairedTis620 = repairThaiMojibakeIfCorrupted(corruptedTis620String, 'fallback');
    assert.equal(repairedTis620.wasCorrupted, true);
    assert.equal(repairedTis620.text, cleanThai, 'Must accurately reverse TIS-620 Mojibake back to clean UTF-8 Thai');

    // Simulate UTF-8 bytes misread as Latin-1
    const corruptedLatin1String = utf8Bytes.toString('latin1');
    assert.equal(hasThaiMojibake(corruptedLatin1String), true, 'Must detect Latin-1 Mojibake');
    const repairedLatin1 = repairThaiMojibakeIfCorrupted(corruptedLatin1String, 'fallback');
    assert.equal(repairedLatin1.wasCorrupted, true);
    assert.equal(repairedLatin1.text, cleanThai, 'Must accurately reverse Latin-1 Mojibake back to clean UTF-8 Thai');

    // 2. Verify Read-Only Data Integrity Audit endpoint (/api/Sam_Att/settings/data-integrity-audit)
    const auditRes = await apiCall('/api/Sam_Att/settings/data-integrity-audit', {
      token: adminToken,
    });
    assert.equal(auditRes.status, 200);
    assert.equal(auditRes.data.readOnlyInspection, true);
    assert.equal(auditRes.data.syntheticRecordsFound.personnelCount, 5);
    assert.ok(Array.isArray(auditRes.data.mojibakeDetected));

    // 3. Verify Dashboard Summary returns dynamic filter options & dataMode
    const dashRes = await apiCall('/api/Sam_Att/dashboard/summary?dateFrom=2026-11-01&dateTo=2026-11-30', {
      token: adminToken,
    });
    assert.equal(dashRes.status, 200);
    assert.equal(dashRes.data.dataMode, 'DEMO');
    assert.equal(dashRes.data.isEmptyPeriod, false);
    assert.ok(Array.isArray(dashRes.data.availableDepartments));
    assert.ok(dashRes.data.availableDepartments.length > 0);
    assert.ok(dashRes.data.availableDepartments.some((d: string) => d.includes('กลุ่มงาน')));
    assert.ok(Array.isArray(dashRes.data.availablePersonnelTypes));
    assert.ok(dashRes.data.availablePersonnelTypes.some((t: any) => t.code === 'CIVIL_SERVANT'));

    // 4. Verify Production Config Fail-Closed blocks SAM_ATT_DATA_MODE=DEMO in production
    const baseProdCfg = loadConfig();
    assert.throws(
      () =>
        validateProductionConfig({
          ...baseProdCfg,
          nodeEnv: 'production',
          dataMode: 'DEMO',
          dbEngine: 'mysql',
        }),
      (err: unknown) => err instanceof ProductionConfigError && err.violations.some((v) => v.includes('DEMO'))
    );

    // 5. Verify REAL mode on a clean SQLite database seeds ONLY baseline catalog and ZERO synthetic personnel/scans
    const realModeSqlitePath = path.join(os.tmpdir(), `sam_att_real_mode_${TEST_RUN_ID}.sqlite`);
    try {
      process.env.SAM_ATT_DATA_MODE = 'REAL';
      resetSqliteInstanceForTests(realModeSqlitePath);
      await runMigrations();
      await ensureBaselineSystemCatalog();
      // Calling seedBaselineAndSyntheticData in REAL mode must NOT insert synthetic data
      await seedBaselineAndSyntheticData();

      const realPersonnel = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM personnel');
      const realRawScans = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans');
      const realUsers = await dbQuery<{ username: string; display_name: string; approved_person_id: string | null }>(
        'SELECT username, display_name, approved_person_id FROM users'
      );
      const realShifts = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM shifts');
      const realRules = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM personnel_type_rules');
      const realScanners = await dbQuery<{ machine_no: number }>('SELECT machine_no FROM scanner_devices ORDER BY machine_no ASC');

      assert.equal(Number(realPersonnel[0].cnt), 0, 'REAL mode must have 0 synthetic personnel');
      assert.equal(Number(realRawScans[0].cnt), 0, 'REAL mode must have 0 synthetic raw scans');
      assert.equal(realUsers.length, 1, 'REAL mode must only create 1 initial admin bootstrap account');
      assert.equal(realUsers[0].username, 'admin');
      assert.equal(realUsers[0].approved_person_id, null, 'REAL mode admin must not be bound to fake SAM-P001');
      assert.equal(realUsers[0].display_name, 'ผู้ดูแลระบบหลัก (System Admin)');
      assert.equal(Number(realShifts[0].cnt), 9, 'REAL mode must have 9 standard shift templates');
      assert.equal(Number(realRules[0].cnt), 5, 'REAL mode must have 5 personnel type rules');
      assert.deepEqual(
        realScanners.map((s) => Number(s.machine_no)),
        [1, 2, 3],
        'REAL mode must register hospital scanner devices 1, 2, 3 (not demo 101-103)'
      );

      // Verify getCurrentBangkokDateParts returns valid YYYY-MM-DD in Asia/Bangkok
      const bkkParts = getCurrentBangkokDateParts();
      assert.match(bkkParts.todayYmd, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(bkkParts.currentYearMonth, /^\d{4}-\d{2}$/);
    } finally {
      process.env.SAM_ATT_DATA_MODE = 'DEMO';
      resetSqliteInstanceForTests(TEST_SQLITE_PATH);
      for (const ext of ['', '-shm', '-wal']) {
        const f = `${realModeSqlitePath}${ext}`;
        if (fs.existsSync(f)) {
          try {
            fs.unlinkSync(f);
          } catch {
            // ignore
          }
        }
      }
    }
  });

  test('23. One-Click Deployment Scripts (Deploy_Sam_Att.bat & Deploy_Sam_Att.ps1) & 15 Failure/Safety Scenarios Verification', async () => {
    // A. Verify physical deployment scripts exist and enforce strict safety invariants
    const rootBatPath = path.resolve(process.cwd(), 'Deploy_Sam_Att.bat');
    const deployBatPath = path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.bat');
    const deployPs1Path = path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.ps1');

    assert.ok(fs.existsSync(rootBatPath), 'Root Deploy_Sam_Att.bat must exist');
    assert.ok(fs.existsSync(deployBatPath), 'deployment/Deploy_Sam_Att.bat must exist');
    assert.ok(fs.existsSync(deployPs1Path), 'deployment/Deploy_Sam_Att.ps1 must exist');

    const rootBatContent = fs.readFileSync(rootBatPath, 'utf8');
    const deployBatContent = fs.readFileSync(deployBatPath, 'utf8');
    const ps1Content = fs.readFileSync(deployPs1Path, 'utf8');

    // Enforce 100% 7-bit ASCII in .bat and .ps1 files so Windows PowerShell 5.1 (Windows-874 default ANSI codepage) never misparses UTF-8 bytes as curly quotes
    assert.match(rootBatContent, /^[\x00-\x7F]*$/, 'Root Deploy_Sam_Att.bat must be 100% 7-bit ASCII');
    assert.match(deployBatContent, /^[\x00-\x7F]*$/, 'deployment/Deploy_Sam_Att.bat must be 100% 7-bit ASCII');
    assert.match(ps1Content, /^[\x00-\x7F]*$/, 'deployment/Deploy_Sam_Att.ps1 must be 100% 7-bit ASCII');

    // Must support -CheckOnly and -ApproveMigrations
    assert.ok(ps1Content.includes('[switch]$CheckOnly'), 'Deploy_Sam_Att.ps1 must support -CheckOnly');
    assert.ok(ps1Content.includes('[switch]$ApproveMigrations'), 'Deploy_Sam_Att.ps1 must support -ApproveMigrations');
    // Must forbid destructive git reset --hard / git clean -fd and iisreset execution
    assert.ok(!/^\s*git\s+reset\s+--hard/m.test(ps1Content), 'Deploy_Sam_Att.ps1 must never run git reset --hard');
    assert.ok(!/^\s*git\s+clean\s+-fd/m.test(ps1Content), 'Deploy_Sam_Att.ps1 must never run git clean -fd');
    assert.ok(!/^\s*iisreset/im.test(ps1Content), 'Deploy_Sam_Att.ps1 must never run iisreset');
    // Must explicitly protect Procurement and CentralApiGateway
    assert.ok(ps1Content.includes('Procurement'), 'Deploy_Sam_Att.ps1 must explicitly guard Procurement');
    assert.ok(ps1Content.includes('CentralApiGateway'), 'Deploy_Sam_Att.ps1 must explicitly guard CentralApiGateway');

    // B. Create an isolated mock deployment workspace for the 15 scenarios
    const mockAppDir = path.join(os.tmpdir(), `sam_att_oneclick_test_${TEST_RUN_ID}`);
    fs.mkdirSync(path.join(mockAppDir, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(mockAppDir, 'ScannerReader'), { recursive: true });
    fs.writeFileSync(path.join(mockAppDir, 'package.json'), '{"name":"sam-att-v2-standalone","version":"2.0.0"}', 'utf8');
    fs.writeFileSync(path.join(mockAppDir, 'package-lock.json'), '{"name":"sam-att-v2-standalone","lockfileVersion":3}', 'utf8');
    fs.writeFileSync(path.join(mockAppDir, 'server.ts'), '// server entry', 'utf8');
    fs.writeFileSync(
      path.join(mockAppDir, 'dist', 'index.html'),
      '<!doctype html><html><body data-commit="OLD_COMMIT">v2.0.0</body></html>',
      'utf8'
    );
    fs.writeFileSync(path.join(mockAppDir, 'ScannerReader', 'ScannerSyncCli.exe'), 'ORIGINAL_SCANNER_BINARY_V2', 'utf8');

    const validProdEnv = [
      'NODE_ENV=production',
      'SAM_ATT_DATA_MODE=REAL',
      'SAM_ATT_DB_ENGINE=mysql',
      'SAM_ATT_DB_HOST=10.1.0.201',
      'SAM_ATT_DB_PORT=3306',
      'SAM_ATT_DB_NAME=samchuk_attendance_v2',
      'SAM_ATT_DB_USER=sam_att_app',
      'SAM_ATT_DB_PASSWORD=SuperSecretMysqlPass#2026!',
      'JWT_SECRET=9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e9f8e7d6c5b4a3f2e1d0c9b8a',
      'SCANNER_INGEST_SHARED_TOKEN=a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    ].join('\n');
    fs.writeFileSync(path.join(mockAppDir, '.env'), validProdEnv, 'utf8');

    try {
      // Scenario 1: GitHub ไม่สามารถเชื่อมต่อได้ (Git Fetch fails -> Abort, no changes)
      const s1 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateGitFetchFailure: true },
      });
      assert.equal(s1.exitCode, 1);
      assert.equal(s1.finalBanner, 'DEPLOYMENT ABORTED');
      assert.ok(s1.consoleOutput.includes('GIT_FETCH_FAILED'));
      assert.ok(!s1.consoleOutput.includes('DEPLOYMENT SUCCESS'));

      // Scenario 2: Git Working Tree มีไฟล์แก้ไข (Dirty working tree -> Stop in Preflight, no git reset --hard)
      const s2 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { gitDirtyFiles: ['M backend/src/server.ts'] },
      });
      assert.equal(s2.exitCode, 1);
      assert.equal(s2.finalBanner, 'DEPLOYMENT ABORTED');
      assert.ok(s2.consoleOutput.includes('PREFLIGHT_DIRTY_WORKING_TREE'));

      // Scenario 3: npm install ล้มเหลว (Fails at Step 4 -> Automatic Safe Rollback)
      const s3 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateNpmInstallFailure: true },
      });
      assert.equal(s3.exitCode, 1);
      assert.equal(s3.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.equal(s3.rolledBack, true);
      assert.equal(s3.rollbackSucceeded, true);
      assert.equal(s3.commitAfter, s3.commitBefore, 'Must revert commit back to commitBefore');

      // Scenario 4: Typecheck ไม่ผ่าน (Fails at Step 5 -> Automatic Safe Rollback)
      const s4 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateTypecheckFailure: true },
      });
      assert.equal(s4.exitCode, 1);
      assert.equal(s4.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.ok(s4.consoleOutput.includes('TYPECHECK_FAILED'));

      // Scenario 5: Unit Tests ไม่ผ่าน (Fails at Step 5 -> Automatic Safe Rollback)
      const s5 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateUnitTestFailure: true },
      });
      assert.equal(s5.exitCode, 1);
      assert.equal(s5.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.ok(s5.consoleOutput.includes('UNIT_TESTS_FAILED'));

      // Scenario 6: Build ไม่สำเร็จ (Fails at Step 5 -> Automatic Safe Rollback)
      const s6 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateBuildFailure: true },
      });
      assert.equal(s6.exitCode, 1);
      assert.equal(s6.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.ok(s6.consoleOutput.includes('BUILD_FAILED'));

      // Scenario 7: Port 4101 ถูกใช้งานโดย Process อื่น (Foreign process owns 4101 -> Abort in Preflight, never kill by port)
      const s7 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { port4101Owner: 'FOREIGN_PROCESS', foreignProcessName: 'ProcurementService.exe' },
      });
      assert.equal(s7.exitCode, 1);
      assert.equal(s7.finalBanner, 'DEPLOYMENT ABORTED');
      assert.equal(s7.foreignProcessKilled, false);
      assert.ok(s7.consoleOutput.includes('PREFLIGHT_PORT_4101_FOREIGN_PROCESS'));

      // Scenario 8: Backend เริ่มไม่สำเร็จ (Fails at Step 6 -> Automatic Safe Rollback)
      const s8 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateBackendStartFailure: true },
      });
      assert.equal(s8.exitCode, 1);
      assert.equal(s8.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.ok(s8.consoleOutput.includes('BACKEND_START_FAILED'));

      // Scenario 9: Health API ไม่ตอบ (Fails at Step 7 -> Automatic Safe Rollback)
      const s9 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateHealthApiUnreachable: true },
      });
      assert.equal(s9.exitCode, 1);
      assert.equal(s9.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.ok(s9.consoleOutput.includes('HEALTH_API_UNREACHABLE'));
      assert.ok(!s9.consoleOutput.includes('DEPLOYMENT SUCCESS'));

      // Scenario 10: MySQL เชื่อมต่อไม่ได้ (Fails at Step 7 -> Automatic Safe Rollback, no SQLite fallback)
      const s10 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateMysqlDisconnected: true },
      });
      assert.equal(s10.exitCode, 1);
      assert.equal(s10.finalBanner, 'DEPLOYMENT ROLLED_BACK');
      assert.ok(s10.consoleOutput.includes('MYSQL_DISCONNECTED'));

      // Scenario 11: Backup ไม่สำเร็จ (Fails at Step 3 -> Aborts before modifying dependencies/build/service)
      const s11 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { simulateBackupFailure: true },
      });
      assert.equal(s11.exitCode, 1);
      assert.ok(s11.consoleOutput.includes('BACKUP_FAILED'));
      assert.equal(s11.steps.some((st) => st.stepNumber === 4), false, 'Must not proceed to Step 4 when Backup fails');

      // Scenario 12: Rollback ไม่สำเร็จ (Reports CRITICAL status with Exit Code 2, never SUCCESS)
      const s12 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: {
          simulateHealthApiUnreachable: true,
          simulateRollbackFailure: true,
        },
      });
      assert.equal(s12.exitCode, 2);
      assert.equal(s12.finalBanner, 'DEPLOYMENT CRITICAL');
      assert.equal(s12.rollbackSucceeded, false);
      assert.ok(s12.consoleOutput.includes('DEPLOYMENT CRITICAL — ROLLBACK FAILED'));
      assert.ok(!s12.consoleOutput.includes('DEPLOYMENT SUCCESS'));

      // Scenario 13: .env ไม่ครบ หรือตั้งค่า DEMO /CHANGE_ME (Fails in Step 1 Preflight)
      const s13 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: {
          envContent: 'SAM_ATT_DATA_MODE=REAL\nSAM_ATT_DB_ENGINE=mysql\nSAM_ATT_DB_HOST=10.1.0.201\nSAM_ATT_DB_PASSWORD=CHANGE_ME',
        },
      });
      assert.equal(s13.exitCode, 1);
      assert.equal(s13.finalBanner, 'DEPLOYMENT ABORTED');
      assert.ok(s13.consoleOutput.includes('PREFLIGHT_ENV_INCOMPLETE'));

      // Scenario 14: ไม่มีสิทธิ์จัดการ IIS (Fails in Step 1 Preflight)
      const s14 = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { iisPermissionDenied: true },
      });
      assert.equal(s14.exitCode, 1);
      assert.equal(s14.finalBanner, 'DEPLOYMENT ABORTED');
      assert.ok(s14.consoleOutput.includes('PREFLIGHT_IIS_PERMISSION_DENIED'));

      // Scenario 15: ต้องไม่กระทบ Procurement + ห้ามรัน Migration อัตโนมัติ + ปิดบังรหัสผ่านใน Log + Full Happy Path
      const sMig = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: { pendingMigrations: ['database/migrations/002_new_table.sql'] },
      });
      assert.equal(sMig.exitCode, 1);
      assert.ok(sMig.consoleOutput.includes('MIGRATION_APPROVAL_REQUIRED'));

      const sCheckOnly = await runOneClickDeployment({
        appDir: mockAppDir,
        checkOnly: true,
      });
      assert.equal(sCheckOnly.exitCode, 0);
      assert.equal(sCheckOnly.steps.length, 2, 'CheckOnly mode stops cleanly after Step 2 inspection');

      const sHappy = await runOneClickDeployment({
        appDir: mockAppDir,
        hooks: {
          coTenantServices: ['Procurement', 'CentralApiGateway'],
        },
      });
      assert.equal(sHappy.exitCode, 0);
      assert.equal(sHappy.finalBanner, 'DEPLOYMENT SUCCESS');
      assert.equal(sHappy.procurementTouched, false, 'Procurement must never be touched');
      assert.equal(sHappy.iisResetExecuted, false, 'iisreset must never be executed');
      assert.equal(sHappy.scannerExeModified, false, 'ScannerReader EXE must never be modified');
      assert.equal(sHappy.steps.length, 7);
      assert.ok(sHappy.steps.every((st) => st.status === 'PASS'));
      assert.ok(sHappy.consoleOutput.includes('Frontend HTTPS : 200 OK'));
      assert.ok(sHappy.consoleOutput.includes('Backend API    : 200 OK'));
      assert.ok(sHappy.consoleOutput.includes('MySQL          : CONNECTED'));
      assert.ok(sHappy.consoleOutput.includes('Database       : samchuk_attendance_v2'));
      assert.ok(sHappy.consoleOutput.includes('Port           : 4101'));
      assert.ok(sHappy.consoleOutput.includes('DEPLOYMENT SUCCESS'));
      // Verify secret password is redacted from logs and console output
      assert.ok(!sHappy.logContent.includes('SuperSecretMysqlPass#2026!'), 'MySQL password must never appear in logs');
      assert.ok(!sHappy.consoleOutput.includes('SuperSecretMysqlPass#2026!'), 'MySQL password must never appear in console');
    } finally {
      fs.rmSync(mockAppDir, { recursive: true, force: true });
    }
  });

  test('24. Master Prompt Business Logic: Default Morning Shift by Personnel Type, Daily Cell Overrides, Day-Off Suppression (No Revert), Excel .xlsx Import, Sync Runs Filter & One-Button Deploy', async () => {
    const login = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(login.status, 200);
    const token = login.data.token as string;
    const staffLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(staffLogin.status, 200);
    const staffToken = staffLogin.data.token as string;

    // -------------------------------------------------------------------------
    // Scenario A & B: Default Morning Shift by Personnel Type & Late Grace Calculation
    // ข้าราชการ / พนักงานราชการ / พนักงานกระทรวง: 08:00–16:00, grace 15 นาที (08:15 = PRESENT, 08:16 = LATE)
    // ลูกจ้างประจำ (PERMANENT_EMP / 02): 07:30–16:00, grace 0 นาที (07:30 = PRESENT, 07:31 = LATE 1 นาที)
    // -------------------------------------------------------------------------
    const rulesRes = await apiCall('/api/Sam_Att/personnel-type-rules', { token });
    assert.equal(rulesRes.status, 200);
    const rules = rulesRes.data.items as any[];
    const permRule = rules.find((r) => r.personnel_type_code === 'PERMANENT_EMP');
    const civilRule = rules.find((r) => r.personnel_type_code === 'CIVIL_SERVANT');
    const govRule = rules.find((r) => r.personnel_type_code === 'GOV_EMPLOYEE');
    const phRule = rules.find((r) => r.personnel_type_code === 'PUBLIC_HEALTH_EMP');

    assert.ok(permRule, 'PERMANENT_EMP rule must exist');
    assert.equal(permRule.default_start_time, '07:30');
    assert.equal(permRule.default_end_time, '16:00');
    assert.equal(Number(permRule.default_grace_minutes), 0);

    assert.ok(civilRule && govRule && phRule, 'CIVIL_SERVANT, GOV_EMPLOYEE, PUBLIC_HEALTH_EMP rules must exist');
    assert.equal(civilRule.default_start_time, '08:00');
    assert.equal(Number(civilRule.default_grace_minutes), 15);
    assert.equal(govRule.default_start_time, '08:00');
    assert.equal(Number(govRule.default_grace_minutes), 15);
    assert.equal(phRule.default_start_time, '08:00');
    assert.equal(Number(phRule.default_grace_minutes), 15);

    // Seed a ลูกจ้างประจำ (PERMANENT_EMP) person and a ข้าราชการ (CIVIL_SERVANT) person with NO custom shift assignment on 2026-06-15
    await dbExecute(
      `INSERT INTO personnel (
        person_id, fingle_id, title_name, first_name, last_name, full_name,
        position_name, department_code, department_name, work_group_name,
        personnel_type_code, personnel_type_name, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(person_id) DO UPDATE SET
        fingle_id = excluded.fingle_id,
        personnel_type_code = excluded.personnel_type_code,
        personnel_type_name = excluded.personnel_type_name`,
      [
        'SAM-PERM-01',
        '9901',
        'นาย',
        'สมศักดิ์',
        'ลูกจ้างประจำ',
        'นายสมศักดิ์ ลูกจ้างประจำ',
        'พนักงานบริการ',
        'GEN',
        'กลุ่มงานบริหารทั่วไป',
        'บริหารทั่วไป',
        '02',
        'ลูกจ้างประจำ',
      ]
    );

    await dbExecute(
      `INSERT INTO personnel (
        person_id, fingle_id, title_name, first_name, last_name, full_name,
        position_name, department_code, department_name, work_group_name,
        personnel_type_code, personnel_type_name, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(person_id) DO UPDATE SET
        fingle_id = excluded.fingle_id,
        personnel_type_code = excluded.personnel_type_code,
        personnel_type_name = excluded.personnel_type_name`,
      [
        'SAM-CIVIL-01',
        '9902',
        'นางสาว',
        'กมลวรรณ',
        'ข้าราชการ',
        'นางสาวกมลวรรณ ข้าราชการ',
        'พยาบาลวิชาชีพ',
        'OPD',
        'กลุ่มงานผู้ป่วยนอก',
        'การพยาบาล',
        '01',
        'ข้าราชการ',
      ]
    );

    await dbExecute(
      `INSERT INTO fingerprint_mappings (person_id, fingle_id, effective_from, effective_to, conflict_state, created_by)
       VALUES (?, ?, '2020-01-01', NULL, 'NONE', 'test_suite')`,
      ['SAM-PERM-01', '9901']
    );
    await dbExecute(
      `INSERT INTO fingerprint_mappings (person_id, fingle_id, effective_from, effective_to, conflict_state, created_by)
       VALUES (?, ?, '2020-01-01', NULL, 'NONE', 'test_suite')`,
      ['SAM-CIVIL-01', '9902']
    );

    // Insert raw scans on 2026-06-15:
    // - ลูกจ้างประจำ scans at 07:31:00 -> must be LATE (1 minute late since start=07:30, grace=0)
    // - ข้าราชการ scans at 08:14:00 -> must be NORMAL (within 08:00 + 15m grace)
    const ingestScans = await apiCall('/api/Sam_Att/scanners/ingest', {
      method: 'POST',
      token,
      body: {
        events: [
          {
            machineNo: 101,
            enrollNumber: '9901',
            scanDateTime: '2026-06-15 07:31:00',
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 101,
            enrollNumber: '9901',
            scanDateTime: '2026-06-15 16:05:00',
            verifyMode: 1,
            inOutMode: 1,
            workCode: 0,
          },
          {
            machineNo: 101,
            enrollNumber: '9902',
            scanDateTime: '2026-06-15 08:14:00',
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 101,
            enrollNumber: '9902',
            scanDateTime: '2026-06-15 16:10:00',
            verifyMode: 1,
            inOutMode: 1,
            workCode: 0,
          },
        ],
      },
    });
    assert.equal(ingestScans.status, 201);

    const permAttRows = await dbQuery<{
      status: string;
      late_minutes: number;
      scheduled_start: string;
    }>(
      `SELECT status, late_minutes, scheduled_start
       FROM attendance
       WHERE person_id = 'SAM-PERM-01' AND work_date = '2026-06-15'`
    );
    assert.equal(permAttRows.length, 1);
    assert.ok(permAttRows[0].scheduled_start.includes('07:30'));
    assert.equal(permAttRows[0].status, 'LATE', 'Permanent employee scanning at 07:31 must be LATE');
    assert.equal(Number(permAttRows[0].late_minutes), 1);

    const civilAttRows = await dbQuery<{
      status: string;
      late_minutes: number;
      scheduled_start: string;
    }>(
      `SELECT status, late_minutes, scheduled_start
       FROM attendance
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-06-15'`
    );
    assert.equal(civilAttRows.length, 1);
    assert.ok(civilAttRows[0].scheduled_start.includes('08:00'));
    assert.equal(civilAttRows[0].status, 'NORMAL', 'Civil servant scanning at 08:14 must be NORMAL');
    assert.equal(Number(civilAttRows[0].late_minutes), 0);

    // -------------------------------------------------------------------------
    // Scenario C, D, E: Single-Person Cell Click Actions + Clear All Shifts (Day-Off Suppression)
    // Must NEVER revert to default shift after refresh, HOSOffice sync, Scanner sync, or Attendance reprocess!
    // -------------------------------------------------------------------------
    const clearRes = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-06-16',
        action: 'CLEAR_ALL_SHIFTS',
        reason: 'หยุดพักผ่อนประจำวัน',
      },
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.data.effectiveSchedule.mode, 'CLEARED_ALL_SHIFTS');
    assert.equal(clearRes.data.effectiveSchedule.shifts.length, 0);

    // Verify GET /shift-assignments returns override_state = CLEARED_ALL_SHIFTS on refresh
    const checkAfterRefresh = await apiCall(
      '/api/Sam_Att/shift-assignments?personId=SAM-CIVIL-01&dateFrom=2026-06-01&dateTo=2026-06-30',
      { token }
    );
    assert.equal(checkAfterRefresh.status, 200);
    const ovRow = (checkAfterRefresh.data.dailyOverrides as any[]).find(
      (o) => o.person_id === 'SAM-CIVIL-01' && o.work_date === '2026-06-16'
    );
    assert.ok(ovRow, 'Daily override row must persist after refresh');
    assert.equal(ovRow.override_state, 'CLEARED_ALL_SHIFTS');

    // Reprocess attendance across 2026-06-16 -> must NOT create a default shift or mark ABSENT on a cleared day-off!
    await reprocessAttendanceRange({
      dateFrom: '2026-06-16',
      dateTo: '2026-06-16',
      referenceNowBkk: '2026-06-16 18:00:00',
      actorUsername: 'admin',
    });
    const clearedDayAtt = await dbQuery<{ id: number }>(
      `SELECT id FROM attendance WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-06-16'`
    );
    assert.equal(
      clearedDayAtt.length,
      0,
      'Cleared shift day (ไม่มีเวร) must NEVER revert to default shift or generate ABSENT record on reprocess'
    );

    // Restore default shift explicitly -> must return to DEFAULT_FROM_TYPE (08:00–16:00)
    const restoreRes = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-06-16',
        action: 'RESTORE_DEFAULT',
      },
    });
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.data.effectiveSchedule.mode, 'DEFAULT_FROM_TYPE');
    assert.equal(restoreRes.data.effectiveSchedule.shifts.length, 1);
    assert.equal(restoreRes.data.effectiveSchedule.shifts[0].startTime, '08:00');

    // Add Afternoon shift alongside Morning shift, then remove Morning shift -> only Afternoon shift remains
    const allShiftsRes = await apiCall('/api/Sam_Att/shifts', { token });
    const shiftList = allShiftsRes.data.items as any[];
    const morShift = shiftList.find((s) => s.shift_code === 'MOR-0816' || s.shift_code === 'OFF-0816');
    const aftShift = shiftList.find((s) => s.shift_code === 'AFT-1600');
    assert.ok(morShift && aftShift);

    await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-06-17',
        action: 'REPLACE_SHIFTS',
        shiftIds: [morShift.id, aftShift.id],
      },
    });

    const removeMorningRes = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-06-17',
        action: 'REMOVE_MORNING',
      },
    });
    assert.equal(removeMorningRes.status, 200);
    assert.equal(removeMorningRes.data.effectiveSchedule.mode, 'CUSTOM_ASSIGNED');
    assert.equal(removeMorningRes.data.effectiveSchedule.shifts.length, 1);
    assert.equal(removeMorningRes.data.effectiveSchedule.shifts[0].shiftCode, 'AFT-1600');

    // -------------------------------------------------------------------------
    // Scenario F: Excel (.xlsx) Template Download, Preview & Confirm Import
    // -------------------------------------------------------------------------
    const tplRes = await apiCall('/api/Sam_Att/shift-assignments/import-template.xlsx', { token });
    assert.equal(tplRes.status, 200);
    assert.ok(
      tplRes.headers.get('content-type')?.includes('spreadsheetml.sheet'),
      'Template download must return .xlsx MIME type'
    );

    const xlsxBuf = buildXlsxBufferFromRows('ScheduleImport', [
      ['person_id', 'full_name', 'work_date', 'shift_code', 'note'],
      ['SAM-CIVIL-01', 'นางสาวกมลวรรณ ข้าราชการ', '2026-06-20', 'AFT', 'เวรบ่าย'],
      ['SAM-PERM-01', 'นายสมศักดิ์ ลูกจ้างประจำ', '2026-06-20', 'OFF', 'วันหยุดไม่มีเวร'],
      ['UNKNOWN-999', 'ไม่พบบุคลากร', '2026-06-20', 'MOR', 'ต้องแจ้งเตือน'],
    ]);

    const excelPreviewRes = await apiCall('/api/Sam_Att/shift-assignments/import-excel/preview', {
      method: 'POST',
      token,
      body: {
        fileName: 'test_roster.xlsx',
        fileBase64: xlsxBuf.toString('base64'),
      },
    });
    assert.equal(excelPreviewRes.status, 200);
    assert.equal(excelPreviewRes.data.summary.totalRows, 3);
    assert.equal(excelPreviewRes.data.summary.validCount, 2);
    assert.equal(excelPreviewRes.data.summary.invalidCount, 1);

    const excelConfirmRes = await apiCall('/api/Sam_Att/shift-assignments/import-excel/confirm', {
      method: 'POST',
      token,
      body: {
        fileName: 'test_roster.xlsx',
        fileBase64: xlsxBuf.toString('base64'),
        mode: 'REPLACE_DATE',
      },
    });
    assert.equal(excelConfirmRes.status, 200);
    assert.equal(excelConfirmRes.data.insertedCount, 2);
    assert.equal(excelConfirmRes.data.skippedCount, 1);

    // Verify SAM-PERM-01 on 2026-06-20 was set to CLEARED_ALL_SHIFTS via 'OFF' in Excel import
    const permClearedCheck = await dbQuery<{ override_state: string }>(
      `SELECT override_state FROM shift_daily_overrides WHERE person_id = 'SAM-PERM-01' AND work_date = '2026-06-20'`
    );
    assert.equal(permClearedCheck.length, 1);
    assert.equal(permClearedCheck[0].override_state, 'CLEARED_ALL_SHIFTS');

    // -------------------------------------------------------------------------
    // Scenario G: Scanner Sync History Filtering & Central Job Progress Tracker
    // -------------------------------------------------------------------------
    const syncRunsFiltered = await apiCall(
      '/api/Sam_Att/sync-runs?period=30D&status=ALL&page=1&pageSize=10',
      { token }
    );
    assert.equal(syncRunsFiltered.status, 200);
    assert.ok(Array.isArray(syncRunsFiltered.data.items));
    assert.equal(syncRunsFiltered.data.pagination.page, 1);

    const activeJobsRes = await apiCall('/api/Sam_Att/jobs/active', { token });
    assert.equal(activeJobsRes.status, 200);
    assert.ok(Array.isArray(activeJobsRes.data.items));

    // -------------------------------------------------------------------------
    // Scenario H: One-Button Update System ("อัปเดตระบบ Sam_Att" -> POST /deployment/run-bat)
    // -------------------------------------------------------------------------
    // 1. Non-ADMIN must be blocked (403 FORBIDDEN)
    const nonAdminDeploy = await apiCall('/api/Sam_Att/deployment/run-bat', {
      method: 'POST',
      token: staffToken,
      body: { confirmRun: true },
    });
    assert.equal(nonAdminDeploy.status, 403);

    // 2. ADMIN with test runner double executes cleanly and records deployment_history + audit_logs
    setDeployBatRunnerForTests(async (scriptPath) => ({
      exitCode: 0,
      stdout: `Executed ${path.basename(scriptPath)}\nCommit : fb866e50 -> fb866e50\nDEPLOYMENT SUCCESS\n`,
      stderr: '',
      scriptPath,
      durationMs: 125,
    }));
    try {
      const adminDeploy = await apiCall('/api/Sam_Att/deployment/run-bat', {
        method: 'POST',
        token,
        body: { confirmRun: true },
      });
      assert.equal(adminDeploy.status, 200);
      assert.equal(adminDeploy.data.status, 'SUCCESS');
      assert.equal(adminDeploy.data.exitCode, 0);
      assert.ok(adminDeploy.data.output.includes('DEPLOYMENT SUCCESS'));
    } finally {
      setDeployBatRunnerForTests(null);
    }
  });

  test('25. Multi-Shift Bulk Assignment (Add / Replace / Remove / Clear-All), Cross-Midnight Overlap & Compact Monthly Icon View-Model Tests', async () => {
    // -------------------------------------------------------------------------
    // Part A: Unit Tests — Multi-Shift Overlap & Compact Monthly Icon Helpers
    // -------------------------------------------------------------------------
    const sampleMorning = {
      id: 1,
      shift_code: 'MOR-0816',
      shift_name: 'กะเช้า (08:00-16:00)',
      shift_category: 'MORNING',
      start_time: '08:00',
      end_time: '16:00',
      grace_minutes: 15,
      cutoff_time: '10:30',
      is_cross_midnight: 0,
      is_active: 1,
    };
    const sampleAfternoon = {
      id: 2,
      shift_code: 'AFT-1600',
      shift_name: 'กะบ่าย (16:00-00:00)',
      shift_category: 'AFTERNOON',
      start_time: '16:00',
      end_time: '00:00',
      grace_minutes: 15,
      cutoff_time: '18:30',
      is_cross_midnight: 1,
      is_active: 1,
    };
    const sampleMorningAfternoon = {
      id: 3,
      shift_code: 'MA-0820',
      shift_name: 'กะเช้า–บ่าย',
      shift_category: 'MORNING_AFTERNOON',
      start_time: '08:00',
      end_time: '20:00',
      grace_minutes: 15,
      cutoff_time: '10:30',
      is_cross_midnight: 0,
      is_active: 1,
    };

    // Non-overlapping shifts (Morning + Afternoon) must pass self-overlap check
    assert.equal(findSelectedShiftsSelfOverlap([sampleMorning, sampleAfternoon]), null);
    assert.equal(findClientSelectedShiftsOverlap([sampleMorning, sampleAfternoon]), null);

    // Overlapping shifts (Morning + Morning-Afternoon) must be flagged on both backend & client
    const backendSelfOverlap = findSelectedShiftsSelfOverlap([
      sampleMorning,
      sampleMorningAfternoon,
    ]);
    assert.ok(backendSelfOverlap, 'Backend must detect overlapping selected shifts');
    const clientSelfOverlap = findClientSelectedShiftsOverlap([
      sampleMorning,
      sampleMorningAfternoon,
    ]);
    assert.ok(clientSelfOverlap, 'Client must detect overlapping selected shifts');

    // Icon classification for Morning, Afternoon, Night, and other shift types
    assert.equal(classifyShiftIconKind({ shiftCode: 'MOR-0816', shiftName: 'กะเช้า' }), 'MORNING');
    assert.equal(classifyShiftIconKind({ shiftCode: 'AFT-1600', shiftName: 'กะบ่าย' }), 'AFTERNOON');
    assert.equal(classifyShiftIconKind({ shiftCode: 'NIG-0008', shiftName: 'กะดึก' }), 'NIGHT');
    assert.equal(
      classifyShiftIconKind({ shiftCode: 'MA-0820', shiftName: 'กะเช้า–บ่าย' }),
      'MORNING_AFTERNOON'
    );
    assert.equal(
      classifyShiftIconKind({ shiftCode: 'AN-1608', shiftName: 'กะบ่าย–ดึก' }),
      'AFTERNOON_NIGHT'
    );
    assert.equal(
      classifyShiftIconKind({ shiftCode: 'FULL-24', shiftName: 'กะทั้งวัน 24 ชม.' }),
      'FULL_DAY'
    );
    assert.equal(
      classifyShiftIconKind({ shiftCode: 'EXT-2008', shiftName: 'กะพิเศษ 20:00-08:00' }),
      'SPECIAL'
    );

    // Compact Monthly Cell View-Model: Default vs Custom (1, 2, 3+ shifts) vs Empty Dash
    const vmDefault = buildCompactMonthlyCellViewModel(
      {
        mode: 'DEFAULT_FROM_TYPE',
        activeItems: [],
        defaultRule: {
          personnel_type_name: 'ข้าราชการ',
          default_start_time: '08:00',
          default_end_time: '16:00',
          default_grace_minutes: 15,
        },
      },
      '1 ก.ค. 2569'
    );
    assert.equal(vmDefault.kind, 'DEFAULT');
    assert.equal(vmDefault.visibleIcons.length, 1);
    assert.equal(vmDefault.visibleIcons[0].iconKind, 'MORNING');
    assert.ok(vmDefault.tooltipText.includes('08:00–16:00'));

    const vmThreeShifts = buildCompactMonthlyCellViewModel(
      {
        mode: 'CUSTOM_ASSIGNED',
        activeItems: [
          {
            id: 101,
            snapshot_shift_code: 'MOR-0816',
            snapshot_shift_name: 'กะเช้า',
            snapshot_start_time: '08:00',
            snapshot_end_time: '16:00',
            snapshot_is_cross_midnight: 0,
          },
          {
            id: 102,
            snapshot_shift_code: 'AFT-1600',
            snapshot_shift_name: 'กะบ่าย',
            snapshot_start_time: '16:00',
            snapshot_end_time: '00:00',
            snapshot_is_cross_midnight: 1,
          },
          {
            id: 103,
            snapshot_shift_code: 'NIG-0008',
            snapshot_shift_name: 'กะดึก',
            snapshot_start_time: '00:00',
            snapshot_end_time: '08:00',
            snapshot_is_cross_midnight: 0,
          },
        ],
      },
      '2 ก.ค. 2569',
      2
    );
    assert.equal(vmThreeShifts.kind, 'CUSTOM');
    assert.equal(vmThreeShifts.totalShifts, 3);
    assert.equal(vmThreeShifts.visibleIcons.length, 2);
    assert.equal(vmThreeShifts.overflowCount, 1);
    assert.equal(vmThreeShifts.visibleIcons[0].iconKind, 'MORNING');
    assert.equal(vmThreeShifts.visibleIcons[1].iconKind, 'AFTERNOON');
    assert.ok(vmThreeShifts.tooltipText.includes('กะเช้า (08:00–16:00 น.)'));
    assert.ok(vmThreeShifts.tooltipText.includes('กะบ่าย (16:00–00:00 น. ข้ามวัน)'));
    assert.ok(vmThreeShifts.tooltipText.includes('กะดึก (00:00–08:00 น.)'));

    const vmCleared = buildCompactMonthlyCellViewModel(
      { mode: 'CLEARED_ALL_SHIFTS', activeItems: [] },
      '3 ก.ค. 2569'
    );
    assert.equal(vmCleared.kind, 'EMPTY_DASH');
    assert.equal(vmCleared.isClearedByStaff, true);

    // -------------------------------------------------------------------------
    // Part B: Integration Tests — Multi-Shift Bulk API (Add / Overlap / Replace / Remove / Clear-All)
    // -------------------------------------------------------------------------
    const login = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(login.status, 200);
    const token = login.data.token as string;

    // Fetch existing shift templates + create a Morning-Afternoon template for overlap testing
    const shiftsRes = await apiCall('/api/Sam_Att/shifts', { token });
    assert.equal(shiftsRes.status, 200);
    const allShifts = shiftsRes.data.items as Array<any>;
    const morShift = allShifts.find((s) => s.shift_code === 'MOR-0816');
    const aftShift = allShifts.find((s) => s.shift_code === 'AFT-1600');
    const nigShift = allShifts.find((s) => s.shift_code === 'NIG-0008');
    let extShift = allShifts.find((s) => s.shift_code === 'EXT-2008');
    assert.ok(morShift && aftShift && nigShift, 'Baseline MOR/AFT/NIG shifts must exist');

    if (!extShift) {
      const createExt = await apiCall('/api/Sam_Att/shifts', {
        method: 'POST',
        token,
        body: {
          shiftCode: 'EXT-2008',
          shiftName: 'เวรพิเศษข้ามคืน',
          shiftCategory: 'SPECIAL',
          startTime: '20:00',
          endTime: '08:00',
          graceMinutes: 15,
          cutoffTime: '22:00',
        },
      });
      assert.equal(createExt.status, 201);
      extShift = { id: createExt.data.id };
    }

    let maShift = allShifts.find((s) => s.shift_code === 'MA-0820');
    if (!maShift) {
      const createMa = await apiCall('/api/Sam_Att/shifts', {
        method: 'POST',
        token,
        body: {
          shiftCode: 'MA-0820',
          shiftName: 'กะเช้า–บ่ายต่อเนื่อง',
          shiftCategory: 'MORNING_AFTERNOON',
          startTime: '08:00',
          endTime: '20:00',
          graceMinutes: 15,
          cutoffTime: '10:30',
        },
      });
      assert.equal(createMa.status, 201);
      maShift = { id: createMa.data.id };
    }

    // 1. Multi-Shift ADD_SHIFTS Preview & Save (2 personnel × 2 dates × 2 shifts = 8 assignments)
    const multiPreviewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01', 'SAM-PERM-01'],
        shiftIds: [morShift.id, aftShift.id],
        workDates: ['2026-07-01', '2026-07-02'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(multiPreviewRes.status, 200);
    assert.equal(multiPreviewRes.data.operationMode, 'ADD_SHIFTS');
    assert.equal(multiPreviewRes.data.shiftSnapshots.length, 2);
    assert.equal(multiPreviewRes.data.summary.totalRequested, 8);
    assert.equal(multiPreviewRes.data.summary.readyCount, 8);
    assert.equal(multiPreviewRes.data.summary.conflictCount, 0);

    const multiAddRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01', 'SAM-PERM-01'],
        shiftIds: [morShift.id, aftShift.id],
        workDates: ['2026-07-01', '2026-07-02'],
        operationMode: 'ADD_SHIFTS',
        conflictStrategy: 'SKIP_CONFLICTS',
      },
    });
    assert.equal(multiAddRes.status, 201);
    assert.equal(multiAddRes.data.insertedCount, 8);
    assert.equal(multiAddRes.data.shiftSnapshots.length, 2);

    // 2. Reject self-overlapping selected shifts (MOR 08:00–16:00 + MA 08:00–20:00 -> 409)
    const selfOverlapPreview = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [morShift.id, maShift.id],
        workDates: ['2026-07-05'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(selfOverlapPreview.status, 409);
    assert.equal(selfOverlapPreview.data.error, 'SELECTED_SHIFTS_OVERLAP');

    // 3. Cross-midnight overlap across consecutive dates in a single multi-shift batch
    //    EXT-2008 (20:00–08:00 next day) on 2026-07-10 overlaps NIG-0008 (00:00–08:00) on 2026-07-11
    const crossBatchPreview = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [nigShift.id, extShift.id],
        workDates: ['2026-07-10', '2026-07-11'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(crossBatchPreview.status, 200);
    assert.ok(
      crossBatchPreview.data.summary.overlapCount >= 1,
      'Must detect cross-midnight overlap between EXT-2008 on Day 1 and NIG-0008 on Day 2'
    );
    assert.ok(
      crossBatchPreview.data.items.some(
        (i: any) =>
          i.workDate === '2026-07-11' &&
          i.shiftCode === 'NIG-0008' &&
          i.status === 'SELECTED_SHIFTS_OVERLAP'
      ),
      'NIG-0008 on Day 2 must be flagged as SELECTED_SHIFTS_OVERLAP against EXT-2008 on Day 1'
    );

    // 3b. Cross-midnight overlap against an already-persisted DB assignment on Day 1
    const persistExtRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [extShift.id],
        workDates: ['2026-07-10'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(persistExtRes.status, 201);

    const crossDbPreview = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [nigShift.id],
        workDates: ['2026-07-11'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(crossDbPreview.status, 200);
    assert.equal(crossDbPreview.data.summary.overlapCount, 1);
    assert.equal(crossDbPreview.data.items[0].status, 'TIME_OVERLAP_CONFLICT');

    // 4. Enforce explicit confirmation (confirmAction: true) for REPLACE_SHIFTS / REMOVE_SELECTED_SHIFTS / CLEAR_ALL_SHIFTS
    for (const destructiveMode of [
      'REPLACE_SHIFTS',
      'REMOVE_SELECTED_SHIFTS',
      'CLEAR_ALL_SHIFTS',
    ] as const) {
      const blockedRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
        method: 'POST',
        token,
        body: {
          personIds: ['SAM-CIVIL-01'],
          shiftIds: destructiveMode === 'CLEAR_ALL_SHIFTS' ? [] : [nigShift.id],
          workDates: ['2026-07-01'],
          operationMode: destructiveMode,
          confirmAction: false,
        },
      });
      assert.equal(
        blockedRes.status,
        400,
        `${destructiveMode} without confirmAction=true must return 400`
      );
      assert.equal(blockedRes.data.error, 'CONFIRMATION_REQUIRED');
    }

    // 5. REPLACE_SHIFTS with confirmAction: true replaces MOR+AFT on 2026-07-01..02 with NIG only
    const replaceRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01', 'SAM-PERM-01'],
        shiftIds: [nigShift.id],
        workDates: ['2026-07-01', '2026-07-02'],
        operationMode: 'REPLACE_SHIFTS',
        confirmAction: true,
        reason: 'ทดสอบแทนที่กะเดิมด้วยกะดึก',
      },
    });
    assert.equal(replaceRes.status, 201);
    assert.equal(replaceRes.data.cancelledCount, 8);
    assert.equal(replaceRes.data.insertedCount, 4);

    const activeAfterReplace = await dbQuery<{ snapshot_shift_code: string }>(
      `SELECT snapshot_shift_code FROM shift_assignments
       WHERE person_id IN ('SAM-CIVIL-01', 'SAM-PERM-01')
         AND work_date IN ('2026-07-01', '2026-07-02')
         AND status = 'ACTIVE'`
    );
    assert.equal(activeAfterReplace.length, 4);
    assert.ok(activeAfterReplace.every((r) => r.snapshot_shift_code === 'NIG-0008'));

    // 6. REMOVE_SELECTED_SHIFTS: removes only selected shift while keeping other shift intact;
    //    when last shift is removed, marks CLEARED_ALL_SHIFTS so default does not reappear
    await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [morShift.id, aftShift.id],
        workDates: ['2026-07-03'],
        operationMode: 'ADD_SHIFTS',
      },
    });

    const removeOneRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [morShift.id],
        workDates: ['2026-07-03'],
        operationMode: 'REMOVE_SELECTED_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(removeOneRes.status, 201);
    assert.equal(removeOneRes.data.cancelledCount, 1);
    assert.equal(removeOneRes.data.clearedCellsCount, 0);

    const remainingAfterOne = await dbQuery<{ snapshot_shift_code: string }>(
      `SELECT snapshot_shift_code FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-07-03' AND status = 'ACTIVE'`
    );
    assert.equal(remainingAfterOne.length, 1);
    assert.equal(remainingAfterOne[0].snapshot_shift_code, 'AFT-1600');

    const removeLastRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [aftShift.id],
        workDates: ['2026-07-03'],
        operationMode: 'REMOVE_SELECTED_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(removeLastRes.status, 201);
    assert.equal(removeLastRes.data.cancelledCount, 1);
    assert.equal(removeLastRes.data.clearedCellsCount, 1);

    // 7. CLEAR_ALL_SHIFTS persists CLEARED_ALL_SHIFTS permanently and never auto-reverts to default
    const clearAllRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token,
      body: {
        personIds: ['SAM-CIVIL-01'],
        shiftIds: [],
        workDates: ['2026-07-04'],
        operationMode: 'CLEAR_ALL_SHIFTS',
        confirmAction: true,
        reason: 'วันหยุดประจำสัปดาห์ (ไม่มีเวร)',
      },
    });
    assert.equal(clearAllRes.status, 201);
    assert.equal(clearAllRes.data.clearedCellsCount, 1);

    await reprocessAttendanceRange({
      dateFrom: '2026-07-04',
      dateTo: '2026-07-04',
      referenceNowBkk: '2026-07-04 18:00:00',
      actorUsername: 'admin',
    });
    const clearedAttendanceRows = await dbQuery<{ id: number }>(
      `SELECT id FROM attendance WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-07-04'`
    );
    assert.equal(
      clearedAttendanceRows.length,
      0,
      'CLEARED_ALL_SHIFTS day must NOT auto-revert to personnel-type default morning shift'
    );
  });

  test('Test 26: Quick Daily Shift Cell Multi-Select, Half-Open [start, end) Overnight & Adjacent-Day Overlap, Transactional All-or-Nothing, Concurrent Race Protection, Icon-Only Weekly/Monthly, and HOSOffice Sync Non-Reversion', async () => {
    const login = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(login.status, 200);
    const token = login.data.token as string;

    // Fetch real DB shift templates
    const shiftsRes = await apiCall('/api/Sam_Att/shifts', { token });
    assert.equal(shiftsRes.status, 200);
    const allShifts = shiftsRes.data.items as Array<{
      id: number;
      shift_code: string;
      shift_name: string;
      shift_category: string;
      start_time: string;
      end_time: string;
      grace_minutes: number;
      cutoff_time: string;
      is_cross_midnight: number;
      is_active: number;
    }>;

    const morShift = allShifts.find((s) => s.shift_code === 'MOR-0816')!;
    const aftShift = allShifts.find((s) => s.shift_code === 'AFT-1600')!;
    const nigShift = allShifts.find((s) => s.shift_code === 'NIG-0008')!;
    const extShift = allShifts.find((s) => s.shift_code === 'EXT-2008')!;
    assert.ok(morShift && aftShift && nigShift && extShift, 'Baseline shifts must exist');

    // Ensure overlapping 08:00-20:00 shift (MA-0820) exists for overlap tests
    let maShift = allShifts.find((s) => s.shift_code === 'MA-0820');
    if (!maShift) {
      const createMa = await apiCall('/api/Sam_Att/shifts', {
        method: 'POST',
        token,
        body: {
          shiftCode: 'MA-0820',
          shiftName: 'เวรเช้า-บ่าย (08:00-20:00)',
          shiftCategory: 'MORNING_AFTERNOON',
          startTime: '08:00',
          endTime: '20:00',
          graceMinutes: 15,
          cutoffTime: '22:00',
          isCrossMidnight: false,
        },
      });
      assert.equal(createMa.status, 201);
      const reloadShifts = await apiCall('/api/Sam_Att/shifts', { token });
      maShift = reloadShifts.data.items.find((s: any) => s.shift_code === 'MA-0820');
    }
    assert.ok(maShift, 'MA-0820 shift must exist');

    // ------------------------------------------------------------------
    // A. UNIT TESTS: Half-open [start, end) + Real Datetime Overnight
    // ------------------------------------------------------------------
    const morIv = computeClientShiftInterval('2026-08-10', '08:00', '16:00', 0);
    const aftIv = computeClientShiftInterval('2026-08-10', '16:00', '00:00', 1);
    assert.equal(
      intervalsOverlapHalfOpen(morIv, aftIv),
      false,
      '[08:00, 16:00) and [16:00, 24:00) must NOT overlap (half-open boundary)'
    );
    assert.equal(aftIv.endDate, '2026-08-11', 'AFT 16:00-00:00 must end on next date 2026-08-11');

    const overlapIv = computeClientShiftInterval('2026-08-10', '15:59', '20:00', 0);
    assert.equal(
      intervalsOverlapHalfOpen(morIv, overlapIv),
      true,
      '[08:00, 16:00) and [15:59, 20:00) MUST overlap'
    );

    const extDay1 = computeClientShiftInterval('2026-08-10', '20:00', '08:00', 1);
    const morDay2 = computeClientShiftInterval('2026-08-11', '08:00', '16:00', 0);
    const nigDay2 = computeClientShiftInterval('2026-08-11', '00:00', '08:00', 0);
    const earlyDay2 = computeClientShiftInterval('2026-08-11', '07:30', '16:00', 0);
    assert.equal(extDay1.endDate, '2026-08-11');
    assert.equal(
      intervalsOverlapHalfOpen(extDay1, morDay2),
      false,
      'Overnight 20:00–08:00 (+1) touching 08:00–16:00 next day must NOT overlap'
    );
    assert.equal(
      intervalsOverlapHalfOpen(extDay1, nigDay2),
      true,
      'Overnight 20:00–08:00 (+1) MUST overlap 00:00–08:00 next day'
    );
    assert.equal(
      intervalsOverlapHalfOpen(extDay1, earlyDay2),
      true,
      'Overnight 20:00–08:00 (+1) MUST overlap 07:30–16:00 next day'
    );

    // Pure unit check on evaluateDailyCellChange (self-overlap + prev-day + default materialization)
    const unitSelfOverlap = evaluateDailyCellChange({
      workDate: '2026-08-05',
      action: 'ADD_SHIFT',
      selectedShifts: [morShift, maShift],
      sameDayActive: [],
      adjacentDaysActive: [],
      dailyOverride: null,
      defaultRule: null,
    });
    assert.equal(unitSelfOverlap.canProceed, false);
    assert.ok(unitSelfOverlap.conflicts.some((c) => c.code === 'SELECTED_SHIFTS_OVERLAP'));

    const unitDefaultMaterialize = evaluateDailyCellChange({
      workDate: '2026-08-05',
      action: 'ADD_SHIFT',
      selectedShifts: [aftShift],
      sameDayActive: [],
      adjacentDaysActive: [],
      dailyOverride: null,
      defaultRule: {
        id: 1,
        personnel_type_code: 'CIVIL_SERVANT',
        personnel_type_name: 'ข้าราชการ',
        default_start_time: '08:00',
        default_end_time: '16:00',
        default_grace_minutes: 15,
        default_cutoff_time: '18:00',
        is_active: 1,
        effective_from: '2020-01-01',
        CheckinWindowBeforeMinutes: 120,
        CheckoutWindowAfterMinutes: 240,
        require_checkout: 1,
        allow_overlapping_shifts: 0,
        rule_version: 'v1',
      },
    });
    assert.equal(unitDefaultMaterialize.canProceed, true);
    assert.ok(
      unitDefaultMaterialize.defaultShiftToMaterialize,
      'ADD_SHIFT on DEFAULT_FROM_TYPE day must preserve default morning shift for materialization'
    );
    assert.equal(unitDefaultMaterialize.resultingShifts.length, 2);

    // Unit check: Weekly (maxVisible=4) & Monthly (maxVisible=2) Icon-Only view-models
    const multiDayEffective = {
      mode: 'CUSTOM_ASSIGNED' as const,
      activeItems: [
        {
          id: 1,
          snapshot_shift_code: morShift.shift_code,
          snapshot_shift_name: morShift.shift_name,
          snapshot_start_time: morShift.start_time,
          snapshot_end_time: morShift.end_time,
          snapshot_is_cross_midnight: morShift.is_cross_midnight,
        },
        {
          id: 2,
          snapshot_shift_code: aftShift.shift_code,
          snapshot_shift_name: aftShift.shift_name,
          snapshot_start_time: aftShift.start_time,
          snapshot_end_time: aftShift.end_time,
          snapshot_is_cross_midnight: aftShift.is_cross_midnight,
        },
        {
          id: 3,
          snapshot_shift_code: nigShift.shift_code,
          snapshot_shift_name: nigShift.shift_name,
          snapshot_start_time: nigShift.start_time,
          snapshot_end_time: nigShift.end_time,
          snapshot_is_cross_midnight: nigShift.is_cross_midnight,
        },
      ],
    };
    const weeklyIconVm = buildCompactMonthlyCellViewModel(multiDayEffective, '1 ส.ค. 2569', 4);
    assert.equal(weeklyIconVm.visibleIcons.length, 3, 'Weekly Icon-Only must show all 3 icons');
    assert.equal(weeklyIconVm.overflowCount, 0);
    assert.ok(weeklyIconVm.tooltipText.includes('08:00–16:00') && weeklyIconVm.tooltipText.includes('16:00–00:00'));

    const monthlyIconVm = buildCompactMonthlyCellViewModel(multiDayEffective, '1 ส.ค. 2569', 2);
    assert.equal(monthlyIconVm.visibleIcons.length, 2, 'Monthly Icon-Only shows up to 2 icons');
    assert.equal(monthlyIconVm.overflowCount, 1, 'Monthly Icon-Only shows +1 overflow indicator');

    // ------------------------------------------------------------------
    // B. INTEGRATION: Multi-select ADD_SHIFT preserving DEFAULT_FROM_TYPE
    // ------------------------------------------------------------------
    // SAM-CIVIL-01 has default morning shift 08:00-16:00 on 2026-08-01
    const previewAddOnDefault = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-preview', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-01',
        action: 'ADD_SHIFT',
        shiftIds: [aftShift.id],
      },
    });
    assert.equal(previewAddOnDefault.status, 200);
    assert.equal(previewAddOnDefault.data.canProceed, true);
    assert.equal(previewAddOnDefault.data.existingSameDayShifts.length, 1);
    assert.equal(previewAddOnDefault.data.resultingShifts.length, 2);

    const execAddOnDefault = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-01',
        action: 'ADD_SHIFT',
        shiftIds: [aftShift.id],
        reason: 'เพิ่มกะบ่ายโดยเก็บกะเช้าเริ่มต้นไว้',
      },
    });
    assert.equal(execAddOnDefault.status, 200);
    assert.equal(
      execAddOnDefault.data.insertedCount,
      1,
      'Must report 1 newly added shift while preserving existing default morning shift in DB'
    );

    const activeAug1 = await dbQuery<{ snapshot_shift_code: string }>(
      `SELECT snapshot_shift_code FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-01' AND status = 'ACTIVE'
       ORDER BY snapshot_start_time ASC`
    );
    assert.equal(activeAug1.length, 2);
    assert.deepEqual(
      activeAug1.map((r) => r.snapshot_shift_code),
      ['MOR-0816', 'AFT-1600']
    );

    // ------------------------------------------------------------------
    // C. INTEGRATION: Duplicate Shift Rejection (409)
    // ------------------------------------------------------------------
    const previewDup = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-preview', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-01',
        action: 'ADD_SHIFT',
        shiftIds: [aftShift.id],
      },
    });
    assert.equal(previewDup.status, 200);
    assert.equal(previewDup.data.canProceed, false);
    assert.ok(previewDup.data.conflicts.some((c: any) => c.code === 'DUPLICATE_SAME_SHIFT'));

    const execDup = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-01',
        action: 'ADD_SHIFT',
        shiftIds: [aftShift.id],
      },
    });
    assert.equal(execDup.status, 409);
    assert.equal(execDup.data.error, 'DUPLICATE_SAME_SHIFT');

    // ------------------------------------------------------------------
    // D. INTEGRATION: Multi-Select ADD_SHIFT (>1 shift at once) & All-or-Nothing Rollback on Conflict
    // ------------------------------------------------------------------
    // First clear 2026-08-02 so we start clean
    const clearAug2 = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-02',
        action: 'CLEAR_ALL_SHIFTS',
      },
    });
    assert.equal(clearAug2.status, 200);

    // Try adding [MOR-0816, MA-0820] -> conflict -> 409 and 0 rows inserted (All-or-Nothing)
    const execSelfOverlap = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-02',
        action: 'ADD_SHIFT',
        shiftIds: [morShift.id, maShift.id],
      },
    });
    assert.equal(execSelfOverlap.status, 409);
    assert.equal(execSelfOverlap.data.error, 'SELECTED_SHIFTS_OVERLAP');
    const aug2AfterFailed = await dbQuery<{ id: number }>(
      `SELECT id FROM shift_assignments WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-02' AND status = 'ACTIVE'`
    );
    assert.equal(aug2AfterFailed.length, 0, 'All-or-Nothing: zero shifts inserted when any conflict exists');

    // Now add valid multi-shifts [MOR-0816, AFT-1600] together (touching at 16:00 -> valid)
    const execMultiValid = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-02',
        action: 'ADD_SHIFT',
        shiftIds: [morShift.id, aftShift.id],
      },
    });
    assert.equal(execMultiValid.status, 200);
    assert.equal(execMultiValid.data.insertedCount, 2);

    // ------------------------------------------------------------------
    // E. INTEGRATION: Previous-Day & Next-Day Overnight Conflict Detection
    // ------------------------------------------------------------------
    // Put EXT-2008 (20:00-08:00 next day) on 2026-08-10 (replace default morning first)
    const putExtDay10 = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-10',
        action: 'REPLACE_SHIFTS',
        shiftIds: [extShift.id],
        confirmReplace: true,
      },
    });
    assert.equal(putExtDay10.status, 200);

    // On 2026-08-11: trying to ADD NIG-0008 (00:00-08:00) MUST conflict with EXT-2008 on 2026-08-10
    const clearDay11 = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: { personId: 'SAM-CIVIL-01', workDate: '2026-08-11', action: 'CLEAR_ALL_SHIFTS' },
    });
    assert.equal(clearDay11.status, 200);

    const prevDayConflictPreview = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-preview', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-11',
        action: 'ADD_SHIFT',
        shiftIds: [nigShift.id],
      },
    });
    assert.equal(prevDayConflictPreview.status, 200);
    assert.equal(prevDayConflictPreview.data.canProceed, false);
    assert.ok(
      prevDayConflictPreview.data.conflicts.some(
        (c: any) =>
          c.code === 'ADJACENT_DAY_OVERLAP' &&
          String(c.message).includes('2026-08-10') &&
          String(c.message).includes('EXT-2008')
      ),
      'Conflict message must clearly state overlapping shift code and date from previous day'
    );

    const prevDayConflictAction = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-11',
        action: 'ADD_SHIFT',
        shiftIds: [nigShift.id],
      },
    });
    assert.equal(prevDayConflictAction.status, 409);
    assert.equal(prevDayConflictAction.data.error, 'ADJACENT_DAY_OVERLAP');

    // On 2026-08-11: MOR-0816 (08:00-16:00) touches EXT-2008 end (08:00) -> MUST SUCCEED
    const touchBoundaryOk = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-11',
        action: 'ADD_SHIFT',
        shiftIds: [morShift.id],
      },
    });
    assert.equal(touchBoundaryOk.status, 200);

    // Next-day conflict: put NIG-0008 (00:00-08:00) on 2026-08-15, then try EXT-2008 (20:00-08:00) on 2026-08-14
    const putNigDay15 = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-15',
        action: 'REPLACE_SHIFTS',
        shiftIds: [nigShift.id],
        confirmReplace: true,
      },
    });
    assert.equal(putNigDay15.status, 200);

    const nextDayConflictAction = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-14',
        action: 'REPLACE_SHIFTS',
        shiftIds: [extShift.id],
        confirmReplace: true,
      },
    });
    assert.equal(nextDayConflictAction.status, 409);
    assert.equal(nextDayConflictAction.data.error, 'ADJACENT_DAY_OVERLAP');
    assert.ok(
      String(nextDayConflictAction.data.message).includes('2026-08-15'),
      'Next-day overlap warning must mention next date 2026-08-15'
    );

    // ------------------------------------------------------------------
    // F. INTEGRATION: REPLACE_SHIFTS Preview + Explicit Confirmation + Audit Trail
    // ------------------------------------------------------------------
    const replacePreview = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-preview', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-02',
        action: 'REPLACE_SHIFTS',
        shiftIds: [nigShift.id, aftShift.id],
      },
    });
    assert.equal(replacePreview.status, 200);
    assert.equal(replacePreview.data.canProceed, true);
    assert.equal(replacePreview.data.shiftsToBeReplaced.length, 2, 'Must list exact 2 existing shifts to be replaced');
    assert.equal(replacePreview.data.resultingShifts.length, 2, 'Must preview exact 2 resulting shifts');

    // Must reject when confirmReplace === false
    const replaceBlocked = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-02',
        action: 'REPLACE_SHIFTS',
        shiftIds: [nigShift.id, aftShift.id],
        confirmReplace: false,
      },
    });
    assert.equal(replaceBlocked.status, 400);
    assert.equal(replaceBlocked.data.error, 'CONFIRMATION_REQUIRED');

    // Execute with confirmReplace === true
    const replaceConfirmed = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-02',
        action: 'REPLACE_SHIFTS',
        shiftIds: [nigShift.id, aftShift.id],
        confirmReplace: true,
        reason: 'เปลี่ยนเป็นเวรดึก+บ่ายตามคำสั่งหัวหน้าตึก',
      },
    });
    assert.equal(replaceConfirmed.status, 200);
    assert.equal(replaceConfirmed.data.cancelledCount, 2);
    assert.equal(replaceConfirmed.data.insertedCount, 2);

    const cancelLogsAug2 = await dbQuery<{ id: number }>(
      `SELECT id FROM shift_cancellation_logs WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-02'`
    );
    assert.ok(cancelLogsAug2.length >= 2, 'Replace must record cancellation audit logs');

    // ------------------------------------------------------------------
    // G. CONCURRENCY: Simultaneous Overlapping Updates Race Protection
    // ------------------------------------------------------------------
    const clearRaceDay = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: { personId: 'SAM-CIVIL-01', workDate: '2026-08-20', action: 'CLEAR_ALL_SHIFTS' },
    });
    assert.equal(clearRaceDay.status, 200);

    // Fire two concurrent overlapping ADD_SHIFT requests (MOR 08:00-16:00 vs MA 08:00-20:00)
    const [raceResA, raceResB] = await Promise.all([
      apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
        method: 'POST',
        token,
        body: {
          personId: 'SAM-CIVIL-01',
          workDate: '2026-08-20',
          action: 'ADD_SHIFT',
          shiftIds: [morShift.id],
        },
      }),
      apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
        method: 'POST',
        token,
        body: {
          personId: 'SAM-CIVIL-01',
          workDate: '2026-08-20',
          action: 'ADD_SHIFT',
          shiftIds: [maShift.id],
        },
      }),
    ]);

    const raceStatuses = [raceResA.status, raceResB.status].sort((a, b) => a - b);
    assert.deepEqual(
      raceStatuses,
      [200, 409],
      `Concurrent overlapping writes MUST produce exactly one 200 and one 409 (got ${raceStatuses.join(', ')})`
    );
    const raceActiveRows = await dbQuery<{ snapshot_shift_code: string }>(
      `SELECT snapshot_shift_code FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-20' AND status = 'ACTIVE'`
    );
    assert.equal(
      raceActiveRows.length,
      1,
      'Concurrent race guard must guarantee exactly 1 active shift with zero overlapping duplicates'
    );

    // ------------------------------------------------------------------
    // H. REGRESSION: Clear All + HOSOffice Personnel Sync + Attendance Reprocess Non-Reversion
    // ------------------------------------------------------------------
    const clearAug22 = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-08-22',
        action: 'CLEAR_ALL_SHIFTS',
        reason: 'ยกเลิกกะทั้งหมดวันที่ 22 ส.ค.',
      },
    });
    assert.equal(clearAug22.status, 200);

    // Run HOSOffice personnel sync touching SAM-CIVIL-01
    setHosOfficeTestDouble([
      {
        PERSON_ID: 'SAM-CIVIL-01',
        FINGLE_ID: '1001',
        TITLE_NAME: 'นาย',
        FIRST_NAME: 'สมชาย',
        LAST_NAME: 'ข้าราชการ',
        POSITION_NAME: 'นายแพทย์ชำนาญการ',
        DEPARTMENT_CODE: 'DEP-MED',
        DEPARTMENT_NAME: 'กลุ่มงานการแพทย์',
        WORK_GROUP_NAME: 'กลุ่มงานการแพทย์',
        PERSONNEL_TYPE_CODE: 'CIVIL_SERVANT',
        PERSONNEL_TYPE_NAME: 'ข้าราชการ',
        IS_ACTIVE: 1,
      },
    ]);
    try {
      const syncRes = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token,
        body: { effectiveDate: '2026-08-22' },
      });
      assert.equal(syncRes.status, 200);
    } finally {
      setHosOfficeTestDouble(null);
    }

    // Run Attendance Reprocess on 2026-08-22
    await reprocessAttendanceRange({
      dateFrom: '2026-08-22',
      dateTo: '2026-08-22',
      referenceNowBkk: '2026-08-22 18:00:00',
      actorUsername: 'admin',
    });

    // Verify override remains CLEARED_ALL_SHIFTS, 0 active shifts, 0 attendance rows
    const overrideAug22 = await dbQuery<{ override_state: string }>(
      `SELECT override_state FROM shift_daily_overrides
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-22'`
    );
    assert.equal(overrideAug22.length, 1);
    assert.equal(overrideAug22[0].override_state, 'CLEARED_ALL_SHIFTS');

    const activeAug22 = await dbQuery<{ id: number }>(
      `SELECT id FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-22' AND status = 'ACTIVE'`
    );
    assert.equal(activeAug22.length, 0);

    const attAug22 = await dbQuery<{ id: number }>(
      `SELECT id FROM attendance
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-08-22'`
    );
    assert.equal(
      attAug22.length,
      0,
      'HOSOffice sync and Attendance Reprocess must NEVER revert CLEARED_ALL_SHIFTS back to default shift'
    );
  });

  test('Test 27: Final UX/UI Refactoring — Daily Shift Checkbox Synchronize (20 Required Scenarios: Load State, Add/Remove/Change/Clear, Carryover, Overnight Conflicts, Rollback, Double Submit, RBAC, Icon-Only, History Safety)', async () => {
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminLogin.status, 200);
    const token = adminLogin.data.token as string;

    const genLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(genLogin.status, 200);
    const genToken = genLogin.data.token as string;

    // Fetch real active shift templates + ensure EARLY-0614 (06:00-14:00) exists for Nov 2/Nov 3 overnight test
    const shiftsRes = await apiCall('/api/Sam_Att/shifts', { token });
    assert.equal(shiftsRes.status, 200);
    let allShifts = shiftsRes.data.items as Array<any>;
    const morShift = allShifts.find((s) => s.shift_code === 'MOR-0816')!;
    const aftShift = allShifts.find((s) => s.shift_code === 'AFT-1600')!;
    const nigShift = allShifts.find((s) => s.shift_code === 'NIG-0008')!;
    const extShift = allShifts.find((s) => s.shift_code === 'EXT-2008')!;
    const maShift = allShifts.find((s) => s.shift_code === 'MA-0820')!;
    assert.ok(morShift && aftShift && nigShift && extShift && maShift);

    let earlyShift = allShifts.find((s) => s.shift_code === 'EARLY-0614');
    if (!earlyShift) {
      const createEarly = await apiCall('/api/Sam_Att/shifts', {
        method: 'POST',
        token,
        body: {
          shiftCode: 'EARLY-0614',
          shiftName: 'เวรเช้าตรู่',
          shiftCategory: 'MORNING',
          startTime: '06:00',
          endTime: '14:00',
          graceMinutes: 15,
          cutoffTime: '09:00',
          isCrossMidnight: false,
        },
      });
      assert.equal(createEarly.status, 201);
      const reload = await apiCall('/api/Sam_Att/shifts', { token });
      allShifts = reload.data.items;
      earlyShift = allShifts.find((s) => s.shift_code === 'EARLY-0614');
    }
    assert.ok(earlyShift);

    // -------------------------------------------------------------------------
    // Scenario 1: เปิด Modal (GET /daily-cell) แล้ว Checkbox ตรงกับกะเดิม (DEFAULT_FROM_TYPE)
    // -------------------------------------------------------------------------
    const openDefault = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-01',
      { token }
    );
    assert.equal(openDefault.status, 200);
    assert.equal(openDefault.data.effectiveState, 'DEFAULT_FROM_TYPE');
    assert.equal(openDefault.data.clearedAll, false);
    assert.deepEqual(
      openDefault.data.selectedTemplateIds,
      [morShift.id],
      'Scenario 1: Opening DEFAULT_FROM_TYPE day MUST pre-check morning template ID'
    );
    assert.ok(openDefault.data.availableTemplates.length >= 5);
    assert.equal(openDefault.data.effectiveShifts.length, 1);

    // -------------------------------------------------------------------------
    // Scenario 2 & 14: เพิ่มกะใหม่โดยเก็บกะเดิม (ติ๊กบ่ายเพิ่ม -> เหลือเช้า+บ่าย) + เปิดซ้ำตรง Backend
    // -------------------------------------------------------------------------
    const syncAddAft = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-01',
        selectedTemplateIds: [morShift.id, aftShift.id],
        reason: 'เพิ่มกะบ่ายโดยเก็บกะเช้าเดิม',
      },
    });
    assert.equal(syncAddAft.status, 200);
    assert.equal(syncAddAft.data.changed, true);
    assert.equal(syncAddAft.data.addedCount, 1);
    assert.equal(syncAddAft.data.keptCount, 1);

    // Scenario 14: Re-open modal -> checkboxes MUST match [MOR, AFT]
    const reopenAfterAdd = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-01',
      { token }
    );
    assert.equal(reopenAfterAdd.status, 200);
    assert.equal(reopenAfterAdd.data.effectiveState, 'CUSTOM_ASSIGNED');
    assert.deepEqual(
      [...reopenAfterAdd.data.selectedTemplateIds].sort((a: number, b: number) => a - b),
      [morShift.id, aftShift.id].sort((a, b) => a - b),
      'Scenario 14: Re-opened modal must pre-check BOTH Morning and Afternoon shifts'
    );

    const morningAssignBeforeRemove = reopenAfterAdd.data.effectiveShifts.find(
      (s: any) => s.templateId === morShift.id
    );
    assert.ok(morningAssignBeforeRemove?.assignmentId, 'Morning shift must have real assignmentId');

    // -------------------------------------------------------------------------
    // Scenario 3: ลบกะเดียวโดยไม่กระทบกะอื่น (เอาติ๊กกะบ่ายออก -> คง Assignment ID กะเช้าไว้!)
    // -------------------------------------------------------------------------
    const syncRemoveAft = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-01',
        selectedTemplateIds: [morShift.id],
        reason: 'เอาติ๊กกะบ่ายออก เก็บกะเช้าไว้',
      },
    });
    assert.equal(syncRemoveAft.status, 200);
    assert.equal(syncRemoveAft.data.removedCount, 1);
    assert.equal(syncRemoveAft.data.keptCount, 1);

    const reopenAfterRemove = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-01',
      { token }
    );
    assert.deepEqual(reopenAfterRemove.data.selectedTemplateIds, [morShift.id]);
    assert.equal(
      reopenAfterRemove.data.effectiveShifts[0].assignmentId,
      morningAssignBeforeRemove.assignmentId,
      'Scenario 3: Kept shift MUST preserve its original assignmentId (no unnecessary delete+recreate)'
    );

    // -------------------------------------------------------------------------
    // Scenario 4: เปลี่ยนกะด้วยการเอาติ๊กออกและติ๊กใหม่ (เอาเช้าออก + ติ๊กดึก -> เหลือเฉพาะดึก)
    // -------------------------------------------------------------------------
    const previewChangeToNight = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell-sync-preview',
      {
        method: 'POST',
        token,
        body: {
          personId: 'SAM-CIVIL-01',
          workDate: '2026-11-01',
          selectedTemplateIds: [nigShift.id],
        },
      }
    );
    assert.equal(previewChangeToNight.status, 200);
    assert.equal(previewChangeToNight.data.canProceed, true);
    assert.equal(previewChangeToNight.data.shiftsToAdd.length, 1);
    assert.equal(previewChangeToNight.data.shiftsToRemove.length, 1);
    assert.equal(previewChangeToNight.data.shiftsToKeep.length, 0);

    const syncChangeToNight = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-01',
        selectedTemplateIds: [nigShift.id],
        reason: 'เปลี่ยนจากกะเช้าเป็นกะดึก',
      },
    });
    assert.equal(syncChangeToNight.status, 200);
    const reopenNight = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-01',
      { token }
    );
    assert.deepEqual(reopenNight.data.selectedTemplateIds, [nigShift.id]);

    // -------------------------------------------------------------------------
    // Scenario 5: เลือกหลายกะพร้อมกัน (เช้า + บ่าย ในครั้งเดียว)
    // -------------------------------------------------------------------------
    const syncMulti = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-05',
        selectedTemplateIds: [morShift.id, aftShift.id],
      },
    });
    assert.equal(syncMulti.status, 200);
    const reopenMulti = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-05',
      { token }
    );
    assert.equal(reopenMulti.data.selectedTemplateIds.length, 2);

    // -------------------------------------------------------------------------
    // Scenario 6, 7, 8, 9: ลบทุกกะ -> Refresh ไม่กลับมา -> HOSOffice Sync ไม่กลับมา -> Reprocess ไม่กลับมา
    // -------------------------------------------------------------------------
    const syncClearAll = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-06',
        selectedTemplateIds: [],
        reason: 'ตั้งใจเอาติ๊กออกทั้งหมด (วันหยุด)',
      },
    });
    assert.equal(syncClearAll.status, 200);
    assert.equal(syncClearAll.data.overrideState, 'CLEARED_ALL_SHIFTS');

    // Scenario 7: Refresh / Re-open modal -> must remain cleared with []
    const reopenCleared = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-06',
      { token }
    );
    assert.equal(reopenCleared.status, 200);
    assert.equal(reopenCleared.data.clearedAll, true);
    assert.deepEqual(reopenCleared.data.selectedTemplateIds, []);

    // Scenario 8: HOSOffice Sync must NOT revert CLEARED_ALL_SHIFTS
    setHosOfficeTestDouble([
      {
        PERSON_ID: 'SAM-CIVIL-01',
        FINGLE_ID: '1001',
        TITLE_NAME: 'นาย',
        FIRST_NAME: 'สมชาย',
        LAST_NAME: 'ข้าราชการ',
        POSITION_NAME: 'นายแพทย์ชำนาญการ',
        DEPARTMENT_CODE: 'DEP-MED',
        DEPARTMENT_NAME: 'กลุ่มงานการแพทย์',
        WORK_GROUP_NAME: 'กลุ่มงานการแพทย์',
        PERSONNEL_TYPE_CODE: 'CIVIL_SERVANT',
        PERSONNEL_TYPE_NAME: 'ข้าราชการ',
        IS_ACTIVE: 1,
      },
    ]);
    try {
      const syncHos = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token,
        body: { effectiveDate: '2026-11-06' },
      });
      assert.equal(syncHos.status, 200);
    } finally {
      setHosOfficeTestDouble(null);
    }

    // Scenario 9: Attendance Reprocess must NOT revert CLEARED_ALL_SHIFTS
    await reprocessAttendanceRange({
      dateFrom: '2026-11-06',
      dateTo: '2026-11-06',
      referenceNowBkk: '2026-11-06 18:00:00',
      actorUsername: 'admin',
    });

    const reopenAfterSyncAndReprocess = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-06',
      { token }
    );
    assert.equal(reopenAfterSyncAndReprocess.data.clearedAll, true);
    assert.deepEqual(reopenAfterSyncAndReprocess.data.selectedTemplateIds, []);
    const attNov6 = await dbQuery<{ id: number }>(
      `SELECT id FROM attendance WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-11-06'`
    );
    assert.equal(attNov6.length, 0);

    // -------------------------------------------------------------------------
    // Scenario 10 & 15: ตรวจ Conflict ภายในวัน + Rollback All-or-Nothing เมื่อผิดพลาด
    // -------------------------------------------------------------------------
    const activeBeforeConflict = await dbQuery<{ id: number; snapshot_shift_code: string }>(
      `SELECT id, snapshot_shift_code FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-11-05' AND status = 'ACTIVE'`
    );
    assert.equal(activeBeforeConflict.length, 2);

    const sameDayConflict = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-05',
        selectedTemplateIds: [morShift.id, maShift.id], // 08:00-16:00 overlaps 08:00-20:00
      },
    });
    assert.equal(sameDayConflict.status, 409);
    assert.equal(sameDayConflict.data.error, 'SELECTED_SHIFTS_OVERLAP');

    // Scenario 15: Original shifts on 2026-11-05 must remain 100% untouched (Rollback)
    const activeAfterConflict = await dbQuery<{ id: number; snapshot_shift_code: string }>(
      `SELECT id, snapshot_shift_code FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-11-05' AND status = 'ACTIVE'`
    );
    assert.deepEqual(
      activeAfterConflict.map((r) => r.id),
      activeBeforeConflict.map((r) => r.id),
      'Scenario 15: Failed sync due to conflict must NOT alter or delete existing assignments'
    );

    // -------------------------------------------------------------------------
    // Scenario 11, 12, 13 & 19: กะข้ามวัน Nov 2 (20:00-08:00) vs Nov 3 (06:00-14:00 Conflict / 08:00-16:00 OK) + Carryover Info
    // -------------------------------------------------------------------------
    // Set Nov 2 to EXT-2008 (20:00–08:00 next day)
    const setNov2Ext = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-02',
        selectedTemplateIds: [extShift.id],
      },
    });
    assert.equal(
      setNov2Ext.status,
      200,
      'Scenario 13: Nov 2 20:00-08:00 touching Nov 3 default 08:00-16:00 must succeed under [start, end)'
    );

    // Scenario 19: Open Nov 3 -> carryoverFromPrevDay MUST show Nov 2 EXT-2008, NOT in selectedTemplateIds!
    const openNov3 = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-03',
      { token }
    );
    assert.equal(openNov3.status, 200);
    assert.equal(openNov3.data.carryoverFromPrevDay.length, 1);
    assert.equal(openNov3.data.carryoverFromPrevDay[0].shiftCode, 'EXT-2008');
    assert.equal(openNov3.data.carryoverFromPrevDay[0].workDate, '2026-11-02');
    assert.ok(
      String(openNov3.data.carryoverFromPrevDay[0].noticeText).includes('2026-11-02'),
      'Scenario 19: Carryover notice must clearly state start date from previous day'
    );
    assert.ok(
      !openNov3.data.selectedTemplateIds.includes(extShift.id),
      'Scenario 19: Previous-day carryover shift must NOT be placed in today checkbox selection'
    );

    // Scenario 12: On Nov 3, selecting EARLY-0614 (06:00–14:00) MUST conflict with Nov 2 EXT-2008 (20:00–08:00)
    const prevDayOverlap = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-03',
        selectedTemplateIds: [earlyShift.id],
      },
    });
    assert.equal(prevDayOverlap.status, 409);
    assert.equal(prevDayOverlap.data.error, 'ADJACENT_DAY_OVERLAP');

    // Scenario 13: On Nov 3, selecting MOR-0816 (08:00–16:00) + AFT-1600 (16:00–00:00) touches 08:00 and 16:00 -> MUST SUCCEED
    const boundaryTouchOk = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-03',
        selectedTemplateIds: [morShift.id, aftShift.id],
      },
    });
    assert.equal(boundaryTouchOk.status, 200);

    // Scenario 11: Next-day conflict — set Nov 9 to EARLY-0614 (06:00–14:00), then try EXT-2008 (20:00–08:00) on Nov 8 -> 409!
    const setNov9Early = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-09',
        selectedTemplateIds: [earlyShift.id],
      },
    });
    assert.equal(setNov9Early.status, 200);

    const nextDayOverlap = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-08',
        selectedTemplateIds: [extShift.id],
      },
    });
    assert.equal(nextDayOverlap.status, 409);
    assert.equal(nextDayOverlap.data.error, 'ADJACENT_DAY_OVERLAP');
    assert.ok(String(nextDayOverlap.data.message).includes('2026-11-09'));

    // -------------------------------------------------------------------------
    // Scenario 16: กดบันทึกซ้ำ (Double Submit / Concurrent Identical Sync) ต้องไม่สร้างข้อมูลซ้ำ
    // -------------------------------------------------------------------------
    const [dupSubmitA, dupSubmitB] = await Promise.all([
      apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
        method: 'POST',
        token,
        body: {
          personId: 'SAM-CIVIL-01',
          workDate: '2026-11-10',
          selectedTemplateIds: [morShift.id, aftShift.id],
        },
      }),
      apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
        method: 'POST',
        token,
        body: {
          personId: 'SAM-CIVIL-01',
          workDate: '2026-11-10',
          selectedTemplateIds: [morShift.id, aftShift.id],
        },
      }),
    ]);
    assert.equal(dupSubmitA.status, 200);
    assert.equal(dupSubmitB.status, 200);
    const activeNov10 = await dbQuery<{ snapshot_shift_code: string }>(
      `SELECT snapshot_shift_code FROM shift_assignments
       WHERE person_id = 'SAM-CIVIL-01' AND work_date = '2026-11-10' AND status = 'ACTIVE'`
    );
    assert.equal(
      activeNov10.length,
      2,
      'Scenario 16: Simultaneous double submit MUST NOT create duplicate shift rows'
    );
    const changedFlags = [dupSubmitA.data.changed, dupSubmitB.data.changed].sort();
    assert.deepEqual(changedFlags, [false, true], 'Second identical submit must be a safe no-op');

    // -------------------------------------------------------------------------
    // Scenario 17: GENERAL_USER ไม่สามารถแก้ไขกะ (แต่ดูของตนเองได้แบบ Read-Only)
    // -------------------------------------------------------------------------
    const genEditBlocked = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token: genToken,
      body: {
        personId: 'SAM-P003',
        workDate: '2026-11-10',
        selectedTemplateIds: [aftShift.id],
      },
    });
    assert.equal(genEditBlocked.status, 403);

    const genPreviewBlocked = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync-preview', {
      method: 'POST',
      token: genToken,
      body: {
        personId: 'SAM-P003',
        workDate: '2026-11-10',
        selectedTemplateIds: [aftShift.id],
      },
    });
    assert.equal(genPreviewBlocked.status, 403);

    const genReadOtherBlocked = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-CIVIL-01&workDate=2026-11-10',
      { token: genToken }
    );
    assert.equal(genReadOtherBlocked.status, 403);

    const genReadOwnOk = await apiCall(
      '/api/Sam_Att/shift-assignments/daily-cell?personId=SAM-P003&workDate=2026-11-10',
      { token: genToken }
    );
    assert.equal(genReadOwnOk.status, 200);
    assert.equal(genReadOwnOk.data.canEdit, false);

    // -------------------------------------------------------------------------
    // Scenario 18: Icon-Only Calendar แสดงหลายกะถูกต้อง (maxVisible=2 + +N + MoonStar SPECIAL)
    // -------------------------------------------------------------------------
    assert.equal(
      classifyShiftIconKind({
        shiftCode: 'EXT-2008',
        shiftName: 'เวรพิเศษข้ามคืน',
        shiftCategory: 'SPECIAL',
        startTime: '20:00',
        endTime: '08:00',
        isCrossMidnight: 1,
      }),
      'SPECIAL'
    );
    const iconVm3 = buildCompactMonthlyCellViewModel(
      {
        mode: 'CUSTOM_ASSIGNED',
        activeItems: [
          {
            id: 1,
            snapshot_shift_code: morShift.shift_code,
            snapshot_shift_name: morShift.shift_name,
            snapshot_start_time: morShift.start_time,
            snapshot_end_time: morShift.end_time,
            snapshot_is_cross_midnight: 0,
          },
          {
            id: 2,
            snapshot_shift_code: aftShift.shift_code,
            snapshot_shift_name: aftShift.shift_name,
            snapshot_start_time: aftShift.start_time,
            snapshot_end_time: aftShift.end_time,
            snapshot_is_cross_midnight: 1,
          },
          {
            id: 3,
            snapshot_shift_code: extShift.shift_code,
            snapshot_shift_name: extShift.shift_name,
            snapshot_start_time: extShift.start_time,
            snapshot_end_time: extShift.end_time,
            snapshot_is_cross_midnight: 1,
          },
        ],
      },
      '10 พ.ย. 2569',
      2
    );
    assert.equal(iconVm3.visibleIcons.length, 2);
    assert.equal(iconVm3.overflowCount, 1);

    // -------------------------------------------------------------------------
    // Scenario 20: การเปลี่ยนกะไม่ทำให้ Attendance History หรือ Raw Scan เสียหาย + บันทึก Audit Log ครบ
    // -------------------------------------------------------------------------
    const rawCountBefore = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;
    const attCountBefore = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance'))[0].cnt;

    const syncForAudit = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-sync', {
      method: 'POST',
      token,
      body: {
        personId: 'SAM-CIVIL-01',
        workDate: '2026-11-12',
        selectedTemplateIds: [nigShift.id],
        reason: 'ทดสอบตรวจ Audit และความปลอดภัยของ Raw Scan/Attendance',
      },
    });
    assert.equal(syncForAudit.status, 200);

    const rawCountAfter = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;
    const attCountAfter = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance'))[0].cnt;
    assert.equal(rawCountAfter, rawCountBefore, 'raw_scans must remain completely untouched');
    assert.equal(attCountAfter, attCountBefore, 'historical attendance rows must remain untouched');

    const auditRows = await dbQuery<{ action: string; target_id: string; detail_json: string }>(
      `SELECT action, target_id, detail_json FROM audit_logs
       WHERE action = 'SHIFT_CELL_SYNC' AND target_id = 'SAM-CIVIL-01:2026-11-12'
       ORDER BY id DESC LIMIT 1`
    );
    assert.equal(auditRows.length, 1, 'Audit log must be written for SHIFT_CELL_SYNC');
    const detail = JSON.parse(auditRows[0].detail_json);
    assert.equal(detail.actorUsername, 'admin');
    assert.equal(detail.personId, 'SAM-CIVIL-01');
    assert.equal(detail.workDate, '2026-11-12');
    assert.ok(Array.isArray(detail.previousShifts) && detail.previousShifts.length === 1);
    assert.ok(Array.isArray(detail.newShifts) && detail.newShifts.length === 1);

    // Bonus Unit Check (Requirement 6.2): Duplicate same-template rows must be surfaced as specialExistingAssignments so single checkbox never wipes both unintentionally
    const dupEval = evaluateDailyCellSync({
      workDate: '2026-11-20',
      selectedTemplateIds: [morShift.id],
      availableTemplates: [morShift, aftShift],
      sameDayActive: [
        {
          id: 9001,
          person_id: 'SAM-CIVIL-01',
          shift_id: morShift.id,
          work_date: '2026-11-20',
          snapshot_shift_code: morShift.shift_code,
          snapshot_shift_name: morShift.shift_name,
          snapshot_start_time: morShift.start_time,
          snapshot_end_time: morShift.end_time,
          snapshot_is_cross_midnight: 0,
          status: 'ACTIVE',
        },
        {
          id: 9002,
          person_id: 'SAM-CIVIL-01',
          shift_id: morShift.id,
          work_date: '2026-11-20',
          snapshot_shift_code: morShift.shift_code,
          snapshot_shift_name: morShift.shift_name,
          snapshot_start_time: morShift.start_time,
          snapshot_end_time: morShift.end_time,
          snapshot_is_cross_midnight: 0,
          status: 'ACTIVE',
        },
      ],
      adjacentDaysActive: [],
      dailyOverride: null,
      defaultRule: null,
      keepSpecialAssignmentIds: [9002],
    });
    assert.equal(dupEval.specialExistingAssignments.length, 1);
    assert.equal(dupEval.specialExistingAssignments[0].assignmentId, 9002);
    assert.equal(dupEval.specialExistingAssignments[0].specialReason, 'DUPLICATE_TEMPLATE');
  });

  test('28. Bulk Assign Workspace UX Logic: Tri-state Filtered Personnel Select-All, Cross-Filter Preservation, Multi-Shift Overlap (Same-Day & Cross-Midnight), and Backend Bulk Validation + RBAC', async () => {
    // -------------------------------------------------------------------------
    // Part A: Unit tests for Personnel Tri-State Header Checkbox & Filter Preservation
    // -------------------------------------------------------------------------
    const nursingIds = ['N-01', 'N-02', 'N-03', 'N-04', 'N-05', 'N-06', 'N-07', 'N-08', 'N-09', 'N-10'];
    const adminIds = ['A-01', 'A-02', 'A-03', 'A-04', 'A-05'];

    // A1: Empty filtered result -> disabled & unchecked
    const emptyState = computeFilteredSelectionState([], []);
    assert.equal(emptyState.disabled, true);
    assert.equal(emptyState.state, 'unchecked');
    assert.equal(emptyState.totalFilteredCount, 0);

    // A2: Select 1 by 1 -> indeterminate
    let selected = ['N-01', 'N-02'];
    const partialState = computeFilteredSelectionState(nursingIds, selected);
    assert.equal(partialState.disabled, false);
    assert.equal(partialState.state, 'indeterminate');
    assert.equal(partialState.selectedInFilteredCount, 2);
    assert.equal(partialState.uniqueSelectedTotalCount, 2);

    // A3: Toggle select-all in Nursing -> all 10 selected & checked
    selected = toggleSelectAllFiltered(nursingIds, selected);
    assert.equal(selected.length, 10);
    const nursingChecked = computeFilteredSelectionState(nursingIds, selected);
    assert.equal(nursingChecked.state, 'checked');
    assert.equal(nursingChecked.selectedInFilteredCount, 10);

    // A4: Switch filter to Admin -> Nursing 10 MUST remain preserved, Admin header checkbox is unchecked
    const adminBefore = computeFilteredSelectionState(adminIds, selected);
    assert.equal(adminBefore.state, 'unchecked');
    assert.equal(adminBefore.uniqueSelectedTotalCount, 10);

    // A5: Select all 5 in Admin -> total unique selected = 15 (10 Nursing + 5 Admin)
    selected = toggleSelectAllFiltered(adminIds, selected);
    assert.equal(selected.length, 15);
    const adminAfter = computeFilteredSelectionState(adminIds, selected);
    assert.equal(adminAfter.state, 'checked');
    assert.equal(adminAfter.uniqueSelectedTotalCount, 15);

    // A6: Uncheck select-all while filtered to Admin -> removes ONLY Admin's 5, keeps Nursing's 10
    selected = toggleSelectAllFiltered(adminIds, selected);
    assert.equal(selected.length, 10);
    assert.deepEqual(selected.sort(), [...nursingIds].sort());
    assert.equal(computeFilteredSelectionState(nursingIds, selected).state, 'checked');
    assert.equal(computeFilteredSelectionState(adminIds, selected).state, 'unchecked');

    // A7: Search subset (2 matching rows) -> select-all selects only matching rows without losing others
    const searchSubset = ['A-01', 'A-03'];
    selected = toggleSelectAllFiltered(searchSubset, selected);
    assert.equal(selected.length, 12);
    assert.equal(computeFilteredSelectionState(adminIds, selected).state, 'indeterminate');
    assert.equal(computeFilteredSelectionState(searchSubset, selected).state, 'checked');

    // -------------------------------------------------------------------------
    // Part B: Unit tests for Multi-Shift Select-All & Half-Open [start, end) Overlap (Same-Day + Cross-Midnight)
    // -------------------------------------------------------------------------
    const sampleShifts = [
      { id: 1, shift_code: 'OFF-0816', shift_name: 'เวรราชการปกติ', start_time: '08:00', end_time: '16:00', is_cross_midnight: 0 },
      { id: 2, shift_code: 'MOR-0816', shift_name: 'เวรเช้า', start_time: '08:00', end_time: '16:00', is_cross_midnight: 0 },
      { id: 3, shift_code: 'AFT-1600', shift_name: 'เวรบ่าย', start_time: '16:00', end_time: '00:00', is_cross_midnight: 1 },
      { id: 4, shift_code: 'EXT-2008', shift_name: 'เวรดึกพิเศษ', start_time: '20:00', end_time: '08:00', is_cross_midnight: 1 },
      { id: 5, shift_code: 'EARLY-0614', shift_name: 'เวรเช้าตรู่', start_time: '06:00', end_time: '14:00', is_cross_midnight: 0 },
    ];

    // B1: Boundary-touching [08:00, 16:00) + [16:00, 00:00) -> 0 overlaps
    const nonOverlapPair = findAllClientSelectedShiftsOverlaps([sampleShifts[1], sampleShifts[2]], [
      '2026-12-01',
      '2026-12-02',
    ]);
    assert.equal(nonOverlapPair.length, 0, '[08:00, 16:00) and [16:00, 00:00) must NOT overlap');

    // B2: Cross-midnight 20:00–08:00 (+1) touching next-day 08:00–16:00 -> 0 overlaps
    const nightTouchMorning = findAllClientSelectedShiftsOverlaps(
      [sampleShifts[1], sampleShifts[3]],
      ['2026-12-01', '2026-12-02']
    );
    assert.equal(
      nightTouchMorning.length,
      0,
      '20:00-08:00 (+1) touching 08:00-16:00 next day must NOT overlap under [start, end)'
    );

    // B3: Cross-midnight 20:00–08:00 (+1) vs next-day 06:00–14:00 on consecutive dates -> CROSS_MIDNIGHT_NEXT_DAY overlap!
    const nightOverlapEarly = findAllClientSelectedShiftsOverlaps(
      [sampleShifts[3], sampleShifts[4]],
      ['2026-12-01', '2026-12-02']
    );
    assert.equal(nightOverlapEarly.length, 1);
    assert.equal(nightOverlapEarly[0].kind, 'CROSS_MIDNIGHT_NEXT_DAY');

    // B4: Same two shifts on non-consecutive dates -> 0 overlaps
    const nightNonConsec = findAllClientSelectedShiftsOverlaps(
      [sampleShifts[3], sampleShifts[4]],
      ['2026-12-01', '2026-12-03']
    );
    assert.equal(nightNonConsec.length, 0);

    // B5: Select ALL shifts -> immediately flags all overlapping pairs (OFF-0816 vs MOR-0816, AFT-1600 vs EXT-2008, etc.)
    const selectAllOverlaps = findAllClientSelectedShiftsOverlaps(sampleShifts, [
      '2026-12-01',
      '2026-12-02',
    ]);
    assert.ok(selectAllOverlaps.length >= 4, 'Selecting all templates must report every overlapping pair');
    assert.ok(
      selectAllOverlaps.some(
        (o) => o.kind === 'SAME_DAY' && o.shiftAId === 1 && o.shiftBId === 2
      ),
      'Must report OFF-0816 (08:00-16:00) overlapping MOR-0816 (08:00-16:00)'
    );

    // Backend pure helper check
    const backendAllOverlaps = findAllSelectedShiftsSelfOverlaps(
      sampleShifts.map((s) => ({
        ...s,
        shift_category: 'SPECIAL',
        grace_minutes: 15,
        cutoff_time: '10:00',
        is_active: 1,
      })) as any,
      '2026-12-01'
    );
    assert.ok(backendAllOverlaps.length >= 3);

    // -------------------------------------------------------------------------
    // Part C: Integration Tests (Backend Validation, Multi-Person/Multi-Day Modes & RBAC)
    // -------------------------------------------------------------------------
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = adminLogin.data.token as string;
    const shiftsRes = await apiCall('/api/Sam_Att/shifts?activeOnly=true', { token: adminToken });
    assert.equal(shiftsRes.status, 200);
    const activeShifts = shiftsRes.data.items as Array<{
      id: number;
      shift_code: string;
      start_time: string;
      end_time: string;
    }>;
    const allActiveShiftIds = activeShifts.map((s) => Number(s.id));
    assert.ok(allActiveShiftIds.length >= 3, 'Must have real shift templates from Backend');

    const morShift = activeShifts.find((s) => s.shift_code === 'MOR-0816')!;
    const aftShift = activeShifts.find((s) => s.shift_code === 'AFT-1600')!;
    assert.ok(morShift && aftShift);

    // C1: Selecting ALL overlapping shifts in ADD_SHIFTS -> bulk-preview & bulk MUST return 409 SELECTED_SHIFTS_OVERLAP with conflicts[]
    const overlapPreviewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftIds: allActiveShiftIds,
        workDates: ['2026-12-10', '2026-12-11'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(overlapPreviewRes.status, 409);
    assert.equal(overlapPreviewRes.data.error, 'SELECTED_SHIFTS_OVERLAP');
    assert.ok(Array.isArray(overlapPreviewRes.data.conflicts) && overlapPreviewRes.data.conflicts.length >= 1);

    const overlapSaveRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftIds: allActiveShiftIds,
        workDates: ['2026-12-10', '2026-12-11'],
        operationMode: 'ADD_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(overlapSaveRes.status, 409);
    assert.equal(overlapSaveRes.data.error, 'SELECTED_SHIFTS_OVERLAP');

    // Verify 0 rows inserted on 2026-12-10/11
    const afterBlockedRows = await dbQuery<{ id: number }>(
      `SELECT id FROM shift_assignments
       WHERE person_id IN ('SAM-P001', 'SAM-P002')
         AND work_date IN ('2026-12-10', '2026-12-11')
         AND status = 'ACTIVE'`
    );
    assert.equal(afterBlockedRows.length, 0, 'Overlapping bulk save must NEVER write rows to DB');

    // C2: Multi-person (2) x Multi-day (2) x Non-overlapping Multi-shift (MOR + AFT) -> ADD_SHIFTS succeeds (8 rows)
    const validAddRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftIds: [morShift.id, aftShift.id],
        workDates: ['2026-12-10', '2026-12-11'],
        operationMode: 'ADD_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(validAddRes.status, 201);
    assert.equal(validAddRes.data.insertedCount, 8);

    // C3: REMOVE_SELECTED_SHIFTS allows selecting ALL shifts (including overlapping pairs) without 409
    const removePreviewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: ['SAM-P001'],
        shiftIds: allActiveShiftIds,
        workDates: ['2026-12-10'],
        operationMode: 'REMOVE_SELECTED_SHIFTS',
      },
    });
    assert.equal(
      removePreviewRes.status,
      200,
      'REMOVE_SELECTED_SHIFTS must allow selecting overlapping templates to remove'
    );
    assert.equal(removePreviewRes.data.summary.readyCount, 2);

    // C4: CLEAR_ALL_SHIFTS works with empty shiftIds: [] (must NOT require selecting templates)
    const clearAllPreviewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftIds: [],
        workDates: ['2026-12-10', '2026-12-11'],
        operationMode: 'CLEAR_ALL_SHIFTS',
      },
    });
    assert.equal(clearAllPreviewRes.status, 200);
    assert.equal(clearAllPreviewRes.data.summary.readyCount, 4);

    const clearAllSaveRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: ['SAM-P001', 'SAM-P002'],
        shiftIds: [],
        workDates: ['2026-12-10', '2026-12-11'],
        operationMode: 'CLEAR_ALL_SHIFTS',
        confirmAction: true,
        reason: 'ทดสอบลบกะทั้งหมดแบบกลุ่มโดยไม่เลือกแม่แบบกะ',
      },
    });
    assert.equal(clearAllSaveRes.status, 201);
    assert.equal(clearAllSaveRes.data.cancelledCount, 8);
    assert.equal(clearAllSaveRes.data.clearedCellsCount, 4);

    // Verify CLEARED_ALL_SHIFTS persisted in shift_daily_overrides
    const clearedOverrides = await dbQuery<{ override_state: string }>(
      `SELECT override_state FROM shift_daily_overrides
       WHERE person_id IN ('SAM-P001', 'SAM-P002')
         AND work_date IN ('2026-12-10', '2026-12-11')`
    );
    assert.equal(clearedOverrides.length, 4);
    assert.ok(clearedOverrides.every((r) => r.override_state === 'CLEARED_ALL_SHIFTS'));

    // C5: RBAC Authorization check — GENERAL_USER MUST receive 403 on bulk-preview and bulk
    const genLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(genLogin.status, 200);
    const generalToken = genLogin.data.token as string;
    const rbacPreviewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: generalToken,
      body: {
        personIds: ['SAM-P001'],
        shiftIds: [morShift.id],
        workDates: ['2026-12-12'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(rbacPreviewRes.status, 403, 'GENERAL_USER must be forbidden from bulk-preview');

    const rbacBulkRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: generalToken,
      body: {
        personIds: ['SAM-P001'],
        shiftIds: [morShift.id],
        workDates: ['2026-12-12'],
        operationMode: 'ADD_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(rbacBulkRes.status, 403, 'GENERAL_USER must be forbidden from bulk save');
  });
});





