import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import https from 'https';
import type { AddressInfo } from 'net';
import {
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
  setSimulatedDatabaseDown,
  dbQuery,
} from '../src/database/adapter.ts';
import { reprocessAttendanceRange } from '../src/modules/attendance/processor.ts';
import { setHosOfficeTestDouble } from '../src/modules/personnel/routes.ts';
import { ensureTlsCertificates } from '../src/server.ts';
import { createExpressApp } from '../src/app.ts';
import { sanitizeCsvCell } from '../src/utils/crypto.ts';

const TEST_SQLITE_PATH = path.resolve(process.cwd(), './data/sam_att_test_suite.sqlite');
const CERT_PATH = path.resolve(process.cwd(), './certs/server.crt');
const KEY_PATH = path.resolve(process.cwd(), './certs/server.key');

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
    body?: unknown;
  } = {}
): Promise<{ status: number; headers: Headers; data: any; rawText: string }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  // Node fetch with custom dispatcher or node:https request
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
          for (const [k, v] of Object.entries(res.headers)) {
            if (typeof v === 'string') hdrs.set(k, v);
          }
          resolve({
            status: res.statusCode || 500,
            headers: hdrs,
            data,
            rawText,
          });
        });
      }
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(JSON.stringify(options.body));
    }
    req.end();
  });
}

describe('Sam_Att V2 Standalone — Full Verification Matrix (Phase 0 to Phase 6)', () => {
  let adminToken = '';
  let staffToken = '';
  let generalUserToken = '';

  before(async () => {
    if (fs.existsSync(TEST_SQLITE_PATH)) {
      fs.unlinkSync(TEST_SQLITE_PATH);
    }
    process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
    resetSqliteInstanceForTests(TEST_SQLITE_PATH);

    const mig = await runMigrations();
    assert.ok(mig.totalTables >= 20, 'Must create at least 20 baseline tables');
    await seedBaselineAndSyntheticData();
    await reprocessAttendanceRange({
      dateFrom: '2026-11-12',
      dateTo: '2026-11-13',
      referenceNowBkk: '2026-11-13 18:00:00',
      actorUsername: 'test_bootstrap',
    });

    ensureTlsCertificates(CERT_PATH, KEY_PATH);
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
    if (httpsServer) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
    resetSqliteInstanceForTests();
    if (fs.existsSync(TEST_SQLITE_PATH)) {
      try {
        fs.unlinkSync(TEST_SQLITE_PATH);
      } catch {
        // ignore
      }
    }
  });

  test('Phase 0 Gate: Single-Port HTTPS serves /Sam_Att/ SPA and /api/Sam_Att/health without Central Gateway', async () => {
    const health = await apiCall('/api/Sam_Att/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.status, 'OK');
    assert.equal(health.data.centralGatewayUsed, false);
    assert.equal(health.data.publicBasePath, '/Sam_Att/');
    assert.equal(health.data.apiBasePath, '/api/Sam_Att');

    if (fs.existsSync(path.resolve(process.cwd(), 'dist/index.html'))) {
      const spa = await apiCall('/Sam_Att/');
      assert.equal(spa.status, 200);
      assert.ok(spa.rawText.includes('Sam_Att V2 Standalone'));
    }
  });

  test('Phase 1 Gate: Authentication, Password Hash Protection, Session Revocation, and Brute-Force Lockout', async () => {
    // 1. Login ADMIN
    const adminRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminRes.status, 200);
    assert.ok(adminRes.data.token);
    assert.equal(adminRes.data.user.role, 'ADMIN');
    assert.equal(adminRes.data.user.password_hash, undefined);
    adminToken = adminRes.data.token;

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

    // 4. Test Logout Token Revocation using a temporary login session
    const tempLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1004', password: 'User@SamAtt2026' },
    });
    assert.equal(tempLogin.status, 200);
    const tempToken = tempLogin.data.token;

    const logoutRes = await apiCall('/api/Sam_Att/auth/logout', {
      method: 'POST',
      token: tempToken,
    });
    assert.equal(logoutRes.status, 200);

    const afterLogout = await apiCall('/api/Sam_Att/auth/me', {
      token: tempToken,
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
  });

  test('Phase 1 Gate: 3-Role RBAC & Own-Only Anti-IDOR Enforcement', async () => {
    // GENERAL_USER can access own attendance (SAM-P003)
    const ownAtt = await apiCall('/api/Sam_Att/me/attendance', {
      token: generalUserToken,
    });
    assert.equal(ownAtt.status, 200);
    assert.equal(ownAtt.data.personId, 'SAM-P003');

    // GENERAL_USER attempting IDOR via query ?personId=SAM-P001 MUST be blocked with 403
    const idorAttempt = await apiCall('/api/Sam_Att/me/attendance?personId=SAM-P001', {
      token: generalUserToken,
    });
    assert.equal(idorAttempt.status, 403);
    assert.equal(idorAttempt.data.error, 'FORBIDDEN_IDOR_ATTEMPT');

    // GENERAL_USER attempting to call organization Dashboard or Personnel or Audit Logs MUST be rejected with 403
    const dashDenied = await apiCall('/api/Sam_Att/dashboard/summary', {
      token: generalUserToken,
    });
    assert.equal(dashDenied.status, 403);

    const logsDenied = await apiCall('/api/Sam_Att/system-logs', {
      token: generalUserToken,
    });
    assert.equal(logsDenied.status, 403);

    // RESPONSIBLE_STAFF can access Dashboard & Personnel, but NOT ADMIN /system-logs or /users
    const staffDash = await apiCall('/api/Sam_Att/dashboard/summary', {
      token: staffToken,
    });
    assert.equal(staffDash.status, 200);

    const staffUsersDenied = await apiCall('/api/Sam_Att/users', {
      token: staffToken,
    });
    assert.equal(staffUsersDenied.status, 403);
  });

  test('Phase 1 Gate: Database Unavailable Fail-Closed Behavior (Zero Mock Fallback)', async () => {
    setSimulatedDatabaseDown(true);
    try {
      const healthDown = await apiCall('/api/Sam_Att/health');
      assert.equal(healthDown.status, 503);
      assert.equal(healthDown.data.status, 'FAIL_CLOSED');
      assert.equal(healthDown.data.error, 'DB_UNAVAILABLE');

      const apiDown = await apiCall('/api/Sam_Att/dashboard/summary', {
        token: adminToken,
      });
      assert.equal(apiDown.status, 503);
      assert.equal(apiDown.data.error, 'DB_UNAVAILABLE');
    } finally {
      setSimulatedDatabaseDown(false);
    }
  });

  test('Phase 2 Gate: HOSOffice Read-Only Sync Fail-Closed, Idempotent Upsert, and Duplicate FINGLE_ID Conflict Detection', async () => {
    // 1. Default unconfigured HOSOffice (CHANGE_ME) fails closed with 503 BLOCKED_BY_EXTERNAL_CONTRACT
    const unconfiguredSync = await apiCall('/api/Sam_Att/personnel/sync', {
      method: 'POST',
      token: staffToken,
      body: { effectiveDate: '2026-11-13' },
    });
    assert.equal(unconfiguredSync.status, 503);
    assert.equal(unconfiguredSync.data.error, 'BLOCKED_BY_EXTERNAL_CONTRACT');

    // 2. Contract Test Double with duplicate FINGLE_ID conflict (9009 shared by 2 active persons)
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
        FINGLE_ID: '9009', // Duplicate FINGLE_ID!
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

      // Sync a second time to verify idempotency (no duplicate personnel rows created)
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

  test('Phase 3 Gate: Scanner 6-Field JSON Contract, Deduplication, Cross-Midnight Shifts, and Raw Scan Immutability', async () => {
    // 1. Hardware sync when SCANNER_SYNC_ENABLED=false fails closed (never fakes success)
    const hwSync = await apiCall('/api/Sam_Att/scanners/sync', {
      method: 'POST',
      token: staffToken,
    });
    assert.equal(hwSync.status, 503);
    assert.equal(hwSync.data.error, 'BLOCKED_BY_EXTERNAL_CONTRACT');

    // 2. Ingest 6-field JSON batch (Run 1 -> inserts 1 new scan; Run 2 -> skips duplicate)
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
      token: staffToken,
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

    // 3. Verify Cross-Midnight Shift calculation for SAM-P002 on 2026-11-12 (20:00 -> 2026-11-13 08:00)
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

    // 4. Add Note & HR Review and verify Raw Scans remain 100% immutable across Reprocess
    const rawBefore = await dbQuery('SELECT id, event_dedup_key, raw_payload_json FROM raw_scans ORDER BY id ASC');

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

    // Run deterministic reprocess twice
    const rep1 = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13', referenceNowBkk: '2026-11-13 18:00:00' },
    });
    assert.equal(rep1.status, 200);

    const previewAfterRep = await apiCall('/api/Sam_Att/attendance/reprocess/preview', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13', referenceNowBkk: '2026-11-13 18:00:00' },
    });
    assert.equal(previewAfterRep.status, 200);
    assert.equal(previewAfterRep.data.changedCount, 0, 'Reprocess must be idempotent when inputs are unchanged');

    const rawAfter = await dbQuery('SELECT id, event_dedup_key, raw_payload_json FROM raw_scans ORDER BY id ASC');
    assert.deepEqual(rawBefore, rawAfter, 'Raw scans must remain strictly immutable after notes, review, and reprocess');

    // 5. Verify Sync Schedule RBAC (RESPONSIBLE_STAFF denied 403, ADMIN allowed 201/200) and persistence
    const staffDeniedSched = await apiCall('/api/Sam_Att/sync-schedules', {
      method: 'POST',
      token: staffToken,
      body: {
        scheduleLabel: 'รอบซิงก์ไม่อนุญาต',
        cronTime: '16:45',
      },
    });
    assert.equal(staffDeniedSched.status, 403);

    const createSched = await apiCall('/api/Sam_Att/sync-schedules', {
      method: 'POST',
      token: adminToken,
      body: {
        scheduleLabel: 'รอบซิงก์หลังเลิกเวรบ่าย 16:45 น.',
        cronTime: '16:45',
      },
    });
    assert.equal(createSched.status, 201);

    const scannersRes = await apiCall('/api/Sam_Att/scanners', {
      token: staffToken,
    });
    assert.equal(scannersRes.status, 200);
    const createdItem = scannersRes.data.schedules.find(
      (s: any) => s.schedule_label === 'รอบซิงก์หลังเลิกเวรบ่าย 16:45 น.'
    );
    assert.ok(createdItem, 'New sync schedule must be persisted in sync_schedules');

    const toggleSched = await apiCall(`/api/Sam_Att/sync-schedules/${createdItem.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: { isEnabled: false },
    });
    assert.equal(toggleSched.status, 200);
    assert.equal(toggleSched.data.isEnabled, 0);
  });

  test('Phase 4 & 5 Gate: Dashboard Distinct Late People vs Occurrences, CSV Injection Protection, and HOSOffice Push Guard', async () => {
    // 1. Verify Dashboard separates latePeople (distinct person_id) vs lateOccurrences
    const dash = await apiCall('/api/Sam_Att/dashboard/summary?dateFrom=2026-11-12&dateTo=2026-11-13', {
      token: staffToken,
    });
    assert.equal(dash.status, 200);
    // SAM-P003 was late on 2026-11-12 (28m) and 2026-11-13 (35m); SAM-P004 was late on 2026-11-12 (22m)
    // Distinct latePeople = 2, lateOccurrences = 3, totalLateMinutes = 85
    assert.equal(dash.data.kpi.latePeople, 2);
    assert.equal(dash.data.kpi.lateOccurrences, 3);
    assert.equal(dash.data.kpi.totalLateMinutes, 85);

    // 2. Verify CSV Export & Formula Injection Sanitizer
    assert.equal(sanitizeCsvCell('=CMD|\' /C calc\'!A0'), '"\'=CMD|\' /C calc\'!A0"');
    assert.equal(sanitizeCsvCell('+SUM(A1:A10)'), '"\'+SUM(A1:A10)"');
    assert.equal(sanitizeCsvCell('@IMPORTXML()'), '"\'@IMPORTXML()"');

    const csvExport = await apiCall('/api/Sam_Att/reports/lateness/export.csv?dateFrom=2026-11-12&dateTo=2026-11-13', {
      token: staffToken,
    });
    assert.equal(csvExport.status, 200);
    assert.ok(csvExport.rawText.includes('PERSON_ID'));
    assert.ok(csvExport.rawText.includes('SAM-P003'));

    // 3. HOSOffice Push Preview (Dry-Run) works with zero external side effects, while Live Push is blocked by flag
    const previewPush = await apiCall('/api/Sam_Att/hosoffice/push/preview', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13' },
    });
    assert.equal(previewPush.status, 200);
    assert.equal(previewPush.data.mode, 'DRY_RUN_PREVIEW');

    const livePushBlocked = await apiCall('/api/Sam_Att/hosoffice/push', {
      method: 'POST',
      token: adminToken,
      body: { dateFrom: '2026-11-12', dateTo: '2026-11-13' },
    });
    assert.equal(livePushBlocked.status, 403);
    assert.equal(livePushBlocked.data.error, 'HOSOFFICE_LIVE_PUSH_DISABLED');
    assert.equal(livePushBlocked.data.sideEffectsWritten, 0);
  });

  test('Phase 6 Gate: Standalone Deployment Preflight, ADMIN Re-Authentication, and No Secrets in Settings', async () => {
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

    // Reject wrong ADMIN password on deployment approval
    const badApprove = await apiCall('/api/Sam_Att/deployment/approve', {
      method: 'POST',
      token: adminToken,
      body: {
        adminPassword: 'WrongAdminPassword',
        releaseVersion: '2.0.1-standalone',
        commitSha: '38a7f4195f613a458aae3961fc22a74522630c57',
        artifactSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    });
    assert.equal(badApprove.status, 401);

    // Approve with valid ADMIN password and 64-char SHA-256
    const goodApprove = await apiCall('/api/Sam_Att/deployment/approve', {
      method: 'POST',
      token: adminToken,
      body: {
        adminPassword: 'Admin@SamAtt2026',
        releaseVersion: '2.0.1-standalone',
        commitSha: '38a7f4195f613a458aae3961fc22a74522630c57',
        artifactSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
    });
    assert.equal(goodApprove.status, 200);
    assert.equal(goodApprove.data.status, 'APPROVED_FOR_WINDOWS_SERVICE_RUNNER');
  });
});
