/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: Historical Scanner Sync, RBAC Window, Reauthentication,
 * Historical Mapping Recovery & Idempotent Attendance Reprocess
 * ไฟล์: backend/tests/historical-sync-mapping.test.ts
 * ============================================================================
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import type { AddressInfo } from 'net';
import {
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
  dbQuery,
  dbExecute,
} from '../src/database/adapter.ts';
import { assertTestEnvironmentIsolated } from '../src/config/env.ts';
import { ensureTlsCertificates } from '../src/server.ts';
import { createExpressApp } from '../src/app.ts';
import {
  getResponsibleStaffMonthWindow,
  assertRoleAuthorizedForDateRange,
  parseYearMonthBounds,
  ScannerSyncRangeError,
} from '../src/modules/scanners/syncRange.ts';
import {
  setScannerExeTestDouble,
  setScannerSyncLockForTests,
  ingestSixFieldEventsBatch,
} from '../src/modules/scanners/routes.ts';
import { setScannerExeProcessRunnerForTests } from '../src/modules/scanners/exeRunner.ts';
import {
  startCentralJob,
  updateCentralJobStep,
  completeCentralJob,
  getJobById,
} from '../src/modules/jobs/tracker.ts';
import { getCurrentBangkokDateParts } from '../src/utils/crypto.ts';

const TEST_RUN_ID = `hist_${process.pid}_${Date.now()}`;
const TEST_SQLITE_PATH = path.join(os.tmpdir(), `sam_att_hist_${TEST_RUN_ID}.sqlite`);
const TEST_CERT_DIR = path.join(os.tmpdir(), `sam_att_hist_certs_${TEST_RUN_ID}`);
const CERT_PATH = path.join(TEST_CERT_DIR, 'server.crt');
const KEY_PATH = path.join(TEST_CERT_DIR, 'server.key');

let httpsServer: https.Server;
let baseUrl: string;
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

async function apiCall(
  endpoint: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: any; rawText: string }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  let bodyBuffer: Buffer | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyBuffer = Buffer.from(JSON.stringify(options.body), 'utf8');
    headers['Content-Length'] = String(bodyBuffer.length);
  }
  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${endpoint}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers,
        agent: httpsAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let data: any;
          try {
            data = JSON.parse(rawText);
          } catch {
            data = rawText;
          }
          resolve({ status: res.statusCode || 500, data, rawText });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function shiftYearMonth(ym: string, deltaMonths: number): string {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + deltaMonths, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
}

describe('Historical Sync, RBAC Window, Reauth, Historical Mapping & Idempotent Reprocess', () => {
  let adminToken = '';
  let staffToken = '';
  let userToken = '';

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
    process.env.SAM_ATT_DATA_MODE = 'DEMO';
    process.env.PUBLIC_BASE_PATH = '/Sam_Att/';
    process.env.API_BASE_PATH = '/api/Sam_Att';
    process.env.SCANNER_SYNC_ENABLED = 'false';
    process.env.SCANNER_AUTO_SCHEDULER_ENABLED = 'false';
    process.env.SCANNER_READER_EXE_PATH = './ScannerReader/ScannerSyncCli.exe';
    process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS = '5';
    process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES = '15';
    process.env.TLS_CERT_PATH = CERT_PATH;
    process.env.TLS_KEY_PATH = KEY_PATH;

    resetSqliteInstanceForTests(TEST_SQLITE_PATH);
    assertTestEnvironmentIsolated();
    await runMigrations();
    await seedBaselineAndSyntheticData();

    ensureTlsCertificates(CERT_PATH, KEY_PATH, 'test');
    const app = createExpressApp({ serveStaticBuild: false });
    httpsServer = https.createServer(
      { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) },
      app
    );
    await new Promise<void>((resolve) => httpsServer.listen(0, '127.0.0.1', () => resolve()));
    const addr = httpsServer.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${addr.port}`;

    const loginAdmin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(loginAdmin.status, 200);
    adminToken = loginAdmin.data.token;

    const loginStaff = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(loginStaff.status, 200);
    staffToken = loginStaff.data.token;

    const loginUser = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(loginUser.status, 200);
    userToken = loginUser.data.token;
  });

  after(async () => {
    setScannerExeTestDouble(null);
    setScannerExeProcessRunnerForTests(null);
    setScannerSyncLockForTests(false);
    if (httpsServer) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
    try {
      if (fs.existsSync(TEST_SQLITE_PATH)) fs.unlinkSync(TEST_SQLITE_PATH);
      if (fs.existsSync(TEST_CERT_DIR)) fs.rmSync(TEST_CERT_DIR, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('HIST-01: Bangkok calendar-month RBAC window (year rollover Jan <-> Dec & leap year Feb 29)', () => {
    // Leap year check
    const feb2028 = parseYearMonthBounds('2028-02');
    assert.ok(feb2028);
    assert.equal(feb2028.dateFrom, '2028-02-01');
    assert.equal(feb2028.dateTo, '2028-02-29');
    assert.equal(feb2028.daysInMonth, 29);

    // Year rollover: Jan 15, 2027 10:00 BKK = 03:00Z
    const janRef = new Date('2027-01-15T03:00:00Z');
    const win = getResponsibleStaffMonthWindow(janRef);
    assert.equal(win.currentYearMonth, '2027-01');
    assert.equal(win.previousYearMonth, '2026-12');
    assert.equal(win.earliestAllowedYmd, '2026-12-01');
    assert.deepEqual(win.allowedYearMonths, ['2026-12', '2027-01']);

    // Staff allowed 2027-01 & 2026-12, blocked 2026-11
    assert.doesNotThrow(() =>
      assertRoleAuthorizedForDateRange({
        role: 'RESPONSIBLE_STAFF',
        syncMode: 'MONTHLY',
        yearMonth: '2027-01',
        referenceDate: janRef,
      })
    );
    assert.doesNotThrow(() =>
      assertRoleAuthorizedForDateRange({
        role: 'RESPONSIBLE_STAFF',
        syncMode: 'MONTHLY',
        yearMonth: '2026-12',
        referenceDate: janRef,
      })
    );
    assert.throws(
      () =>
        assertRoleAuthorizedForDateRange({
          role: 'RESPONSIBLE_STAFF',
          syncMode: 'MONTHLY',
          yearMonth: '2026-11',
          referenceDate: janRef,
        }),
      (err: unknown) =>
        err instanceof ScannerSyncRangeError &&
        err.statusCode === 403 &&
        err.code === 'STAFF_MONTHLY_WINDOW_FORBIDDEN'
    );
    assert.throws(
      () =>
        assertRoleAuthorizedForDateRange({
          role: 'RESPONSIBLE_STAFF',
          syncMode: 'CUSTOM_RANGE',
          dateFrom: '2026-11-30',
          dateTo: '2026-12-02',
          referenceDate: janRef,
        }),
      (err: unknown) =>
        err instanceof ScannerSyncRangeError &&
        err.statusCode === 403 &&
        err.code === 'STAFF_DATE_WINDOW_FORBIDDEN'
    );

    // ADMIN allowed anything
    assert.doesNotThrow(() =>
      assertRoleAuthorizedForDateRange({
        role: 'ADMIN',
        syncMode: 'FULL_HISTORICAL',
        referenceDate: janRef,
      })
    );
  });

  test('HIST-02: RBAC & Anti-Bypass across scanners/sync, reprocess, preview & resolve-unmatched', async () => {
    const bkk = getCurrentBangkokDateParts();
    const curYm = bkk.currentYearMonth;
    const prevYm = shiftYearMonth(curYm, -1);
    const twoMonthsAgoYm = shiftYearMonth(curYm, -2);
    const tooOldDate = `${twoMonthsAgoYm}-15`;

    // GET /scanners exposes roleSyncPolicy accurately
    const scAdmin = await apiCall('/api/Sam_Att/scanners', { token: adminToken });
    assert.equal(scAdmin.status, 200);
    assert.equal(scAdmin.data.roleSyncPolicy.canFullHistoricalImport, true);

    const scStaff = await apiCall('/api/Sam_Att/scanners', { token: staffToken });
    assert.equal(scStaff.status, 200);
    assert.equal(scStaff.data.roleSyncPolicy.canFullHistoricalImport, false);
    assert.deepEqual(scStaff.data.roleSyncPolicy.allowedYearMonths, [prevYm, curYm]);

    // Staff blocked from FULL_HISTORICAL & ALL
    for (const mode of ['FULL_HISTORICAL', 'ALL', 'ALL_SUPPORTED']) {
      const r = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: mode,
          impactAcknowledged: true,
          confirmPassword: 'Staff@SamAtt2026',
        },
      });
      assert.equal(r.status, 403);
      assert.equal(r.data.error, 'FULL_HISTORICAL_ADMIN_ONLY');
    }

    // Staff blocked from MONTHLY 2 months ago
    const oldMonthly = await apiCall('/api/Sam_Att/scanners/sync', {
      method: 'POST',
      token: staffToken,
      body: {
        syncMode: 'MONTHLY',
        yearMonth: twoMonthsAgoYm,
        impactAcknowledged: true,
        confirmPassword: 'Staff@SamAtt2026',
      },
    });
    assert.equal(oldMonthly.status, 403);
    assert.equal(oldMonthly.data.error, 'STAFF_MONTHLY_WINDOW_FORBIDDEN');

    // Staff blocked from bypassing via CUSTOM_RANGE, reprocess, reprocess/preview, resolve-unmatched
    const bypassCustom = await apiCall('/api/Sam_Att/scanners/sync', {
      method: 'POST',
      token: staffToken,
      body: {
        syncMode: 'CUSTOM_RANGE',
        dateFrom: tooOldDate,
        dateTo: `${twoMonthsAgoYm}-16`,
      },
    });
    assert.equal(bypassCustom.status, 403);
    assert.equal(bypassCustom.data.error, 'STAFF_DATE_WINDOW_FORBIDDEN');

    const bypassReprocess = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: tooOldDate, dateTo: `${twoMonthsAgoYm}-16` },
    });
    assert.equal(bypassReprocess.status, 403);
    assert.equal(bypassReprocess.data.error, 'STAFF_DATE_WINDOW_FORBIDDEN');

    const bypassPreview = await apiCall('/api/Sam_Att/attendance/reprocess/preview', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: tooOldDate, dateTo: `${twoMonthsAgoYm}-16` },
    });
    assert.equal(bypassPreview.status, 403);
    assert.equal(bypassPreview.data.error, 'STAFF_DATE_WINDOW_FORBIDDEN');

    const bypassResolve = await apiCall('/api/Sam_Att/personnel/mappings/resolve-unmatched', {
      method: 'POST',
      token: staffToken,
      body: { dateFrom: tooOldDate, dateTo: `${twoMonthsAgoYm}-16` },
    });
    assert.equal(bypassResolve.status, 403);
    assert.equal(bypassResolve.data.error, 'STAFF_DATE_WINDOW_FORBIDDEN');

    // GENERAL_USER blocked
    const userBlocked = await apiCall('/api/Sam_Att/scanners/sync', {
      method: 'POST',
      token: userToken,
      body: { syncMode: 'TODAY' },
    });
    assert.equal(userBlocked.status, 403);
  });

  test('HIST-03: Impact Confirmation, Actor Own-Password Reauth, Cross-User Password Rejection & Rate Limiting', async () => {
    const bkk = getCurrentBangkokDateParts();
    const curYm = bkk.currentYearMonth;
    const prevYm = shiftYearMonth(curYm, -1);

    try {
      setScannerExeTestDouble(
        JSON.stringify({
          success: true,
          machines: [{ machineNo: 101, status: 'OK', read: 1 }],
          scans: [
            {
              machineNo: 101,
              enrollNumber: '1001',
              scanDateTime: `${bkk.todayYmd} 07:55:00`,
              verifyMode: 1,
              inOutMode: 0,
              workCode: 0,
            },
          ],
        })
      );

      // Missing impactAcknowledged -> 400
      const noAck = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: { syncMode: 'FULL_HISTORICAL', confirmPassword: 'Admin@SamAtt2026' },
      });
      assert.equal(noAck.status, 400);
      assert.equal(noAck.data.error, 'IMPACT_CONFIRMATION_REQUIRED');

      // Missing confirmPassword -> 400
      const noPwd = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: { syncMode: 'FULL_HISTORICAL', impactAcknowledged: true },
      });
      assert.equal(noPwd.status, 400);
      assert.equal(noPwd.data.error, 'PASSWORD_CONFIRMATION_REQUIRED');

      // Admin using staff's password -> 401
      const wrongCrossAdmin = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: {
          syncMode: 'FULL_HISTORICAL',
          impactAcknowledged: true,
          confirmPassword: 'Staff@SamAtt2026',
        },
      });
      assert.equal(wrongCrossAdmin.status, 401);
      assert.equal(wrongCrossAdmin.data.error, 'INVALID_CONFIRM_PASSWORD');

      // Staff using admin's password -> 401
      const wrongCrossStaff = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'MONTHLY',
          yearMonth: curYm,
          impactAcknowledged: true,
          confirmPassword: 'Admin@SamAtt2026',
        },
      });
      assert.equal(wrongCrossStaff.status, 401);
      assert.equal(wrongCrossStaff.data.error, 'INVALID_CONFIRM_PASSWORD');

      // Staff succeeds MONTHLY for current month AND previous month with OWN password
      const staffCurOk = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'MONTHLY',
          yearMonth: curYm,
          impactAcknowledged: true,
          confirmPassword: 'Staff@SamAtt2026',
        },
      });
      assert.equal(staffCurOk.status, 200);
      assert.equal(staffCurOk.data.syncMode, 'MONTHLY');
      assert.equal(staffCurOk.data.yearMonth, curYm);

      const staffPrevOk = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'MONTHLY',
          yearMonth: prevYm,
          impactAcknowledged: true,
          confirmPassword: 'Staff@SamAtt2026',
        },
      });
      assert.equal(staffPrevOk.status, 200);
      assert.equal(staffPrevOk.data.yearMonth, prevYm);

      // ADMIN succeeds FULL_HISTORICAL with own password + gets honest exeLimitationWarning
      const adminFullOk = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: {
          syncMode: 'FULL_HISTORICAL',
          impactAcknowledged: true,
          confirmPassword: 'Admin@SamAtt2026',
        },
      });
      assert.equal(adminFullOk.status, 200);
      assert.equal(adminFullOk.data.syncMode, 'FULL_HISTORICAL');
      assert.ok(adminFullOk.data.exeLimitationWarning);
      assert.equal(adminFullOk.rawText.includes('Admin@SamAtt2026'), false);

      // Brute-force rate limit test on staff confirmPassword (5 wrong attempts -> 429)
      const secretBadPwd = 'WrongSecretReauthPwd#991';
      for (let i = 0; i < 4; i++) {
        const failAttempt = await apiCall('/api/Sam_Att/scanners/sync', {
          method: 'POST',
          token: staffToken,
          body: {
            syncMode: 'MONTHLY',
            yearMonth: curYm,
            impactAcknowledged: true,
            confirmPassword: secretBadPwd,
          },
        });
        assert.equal(failAttempt.status, 401);
        assert.equal(failAttempt.rawText.includes(secretBadPwd), false);
      }
      const lockedAttempt = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'MONTHLY',
          yearMonth: curYm,
          impactAcknowledged: true,
          confirmPassword: secretBadPwd,
        },
      });
      assert.equal(lockedAttempt.status, 429);
      assert.equal(lockedAttempt.data.error, 'REAUTH_RATE_LIMITED');

      // Verify password NEVER appears in audit_logs
      const logs = await dbQuery<{ detail_json: string | null }>(
        'SELECT detail_json FROM audit_logs ORDER BY id DESC LIMIT 30'
      );
      for (const l of logs) {
        const txt = String(l.detail_json || '');
        assert.equal(txt.includes('Admin@SamAtt2026'), false);
        assert.equal(txt.includes('Staff@SamAtt2026'), false);
        assert.equal(txt.includes(secretBadPwd), false);
      }

      // Reset staff rate limit so subsequent tests aren't blocked
      await dbExecute("DELETE FROM auth_rate_limits WHERE rate_key LIKE 'reauth:%:hrstaff'");
    } finally {
      setScannerExeTestDouble(null);
    }
  });

  test('HIST-04: Real Production Bug Fix (PERSON_ID=3, FINGLE_ID=57, 2026-11-18 & 2026-11-19), Timezone Boundary & Concurrent Dedup', async () => {
    // Seed PERSON_ID = '3' with FINGLE_ID = '57' and shifts on 2026-11-17..2026-11-19
    await dbExecute(
      `INSERT OR REPLACE INTO personnel
       (person_id, fingle_id, title_name, first_name, last_name, full_name, position_name, department_code, department_name, personnel_type_code, personnel_type_name, is_active, mapping_status)
       VALUES ('3', '57', 'นางสาว', 'ทดสอบ', 'บุคลากรสามชุก', 'นางสาวทดสอบ บุคลากรสามชุก', 'พยาบาลวิชาชีพ', 'DEP-NUR', 'กลุ่มงานการพยาบาล', 'CIVIL_SERVANT', 'ข้าราชการ', 1, 'VALID')`
    );

    const shifts = await dbQuery<{
      id: number;
      shift_code: string;
      shift_name: string;
      start_time: string;
      end_time: string;
      grace_minutes: number;
      cutoff_time: string;
      is_cross_midnight: number;
    }>("SELECT * FROM shifts WHERE shift_code = 'MOR-0816' LIMIT 1");
    assert.ok(shifts.length > 0);
    const sh = shifts[0];

    for (const d of ['2026-11-17', '2026-11-18', '2026-11-19']) {
      await dbExecute(
        `INSERT INTO shift_assignments (
          person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
          snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
          snapshot_is_cross_midnight, status, assigned_by
        ) VALUES ('3', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'admin')`,
        [
          sh.id,
          d,
          sh.shift_code,
          sh.shift_name,
          sh.start_time,
          sh.end_time,
          sh.grace_minutes,
          sh.cutoff_time,
          sh.is_cross_midnight,
        ]
      );
    }

    // Step A: Scans arrive BEFORE mapping exists (including Nov 17 23:30:00, Nov 18 ISO 'T', and Nov 19 multi-scan)
    const rawEvents = [
      { machineNo: 101, enrollNumber: '57', scanDateTime: '2026-11-17 23:30:00', verifyMode: 1, inOutMode: 0, workCode: 0 },
      { machineNo: 101, enrollNumber: '57', scanDateTime: '2026-11-18T08:06:04', verifyMode: 1, inOutMode: 0, workCode: 0 },
      { machineNo: 101, enrollNumber: '57', scanDateTime: '2026-11-19 07:59:56', verifyMode: 1, inOutMode: 0, workCode: 0 },
      { machineNo: 101, enrollNumber: '57', scanDateTime: '2026-11-19 08:07:17', verifyMode: 1, inOutMode: 0, workCode: 0 },
    ];

    // Concurrent parallel ingestion produces ZERO duplicates and preserves multiple scans per day
    const [r1, r2] = await Promise.all([
      ingestSixFieldEventsBatch(rawEvents, 'JSON_INGEST', 'admin', null),
      ingestSixFieldEventsBatch(rawEvents, 'JSON_INGEST', 'admin', null),
    ]);
    assert.equal(r1.newInserted + r2.newInserted, 4, 'Exactly 4 unique scans must be inserted across parallel imports');

    const storedScans = await dbQuery<{ id: number; canonical_bkk_time: string }>(
      "SELECT id, canonical_bkk_time FROM raw_scans WHERE enroll_number = '57' ORDER BY canonical_bkk_time ASC"
    );
    assert.equal(storedScans.length, 4, 'All 4 scans (including 2 scans on Nov 19) must be preserved in raw_scans');

    // Step B: Create fingerprint_mappings for PERSON_ID=3, FINGLE_ID=57 with effective_from = '2026-11-18'
    await dbExecute(
      `INSERT INTO fingerprint_mappings (person_id, fingle_id, effective_from, effective_to, conflict_state, source)
       VALUES ('3', '57', '2026-11-18', NULL, 'NONE', 'HOSOFFICE_SYNC')`
    );

    // Step C: Re-import the exact same batch (all duplicates!) — MUST still trigger mapping resolution & attendance reprocess!
    const reimport = await ingestSixFieldEventsBatch(rawEvents, 'JSON_INGEST', 'admin', null);
    assert.equal(reimport.newInserted, 0);
    assert.equal(reimport.duplicatesSkipped, 4);

    // Verify Timezone/Date Boundary: Nov 17 23:30:00 stays UNMATCHED; Nov 18 & Nov 19 are MATCHED!
    const mappings = await dbQuery<{
      canonical_bkk_time: string;
      mapping_state: string;
      matched_person_id: string | null;
    }>(
      `SELECT rs.canonical_bkk_time, rsm.mapping_state, rsm.matched_person_id
       FROM raw_scans rs
       JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
       WHERE rs.enroll_number = '57'
       ORDER BY rs.canonical_bkk_time ASC`
    );
    assert.equal(mappings[0].canonical_bkk_time, '2026-11-17 23:30:00');
    assert.equal(mappings[0].mapping_state, 'UNMATCHED', 'Nov 17 scan must NOT match effective_from=2026-11-18');
    assert.equal(mappings[0].matched_person_id, null);

    for (let i = 1; i < mappings.length; i++) {
      assert.equal(mappings[i].mapping_state, 'MATCHED');
      assert.equal(mappings[i].matched_person_id, '3');
    }

    // Verify Attendance Engine matched Nov 18 & Nov 19 (NOT NO_SCAN!) and populated attendance_raw_scan_usage!
    const attRows = await dbQuery<{
      id: number;
      work_date: string;
      attendance_status: string;
      review_reason: string | null;
      check_in_time: string | null;
    }>(
      `SELECT id, work_date, attendance_status, review_reason, check_in_time
       FROM attendance
       WHERE person_id = '3' AND work_date IN ('2026-11-18', '2026-11-19')
       ORDER BY work_date ASC`
    );
    assert.equal(attRows.length, 2);
    assert.equal(attRows[0].work_date, '2026-11-18');
    assert.equal(attRows[0].attendance_status, 'MISSING_CHECKOUT');
    assert.notEqual(attRows[0].review_reason, 'NO_RAW_SCANS_IN_WINDOW');
    assert.equal(attRows[0].check_in_time, '2026-11-18 08:06:04');

    assert.equal(attRows[1].work_date, '2026-11-19');
    assert.equal(attRows[1].attendance_status, 'MISSING_CHECKOUT');
    assert.notEqual(attRows[1].review_reason, 'NO_RAW_SCANS_IN_WINDOW');
    assert.equal(attRows[1].check_in_time, '2026-11-19 07:59:56');

    const usageRows = await dbQuery<{ attendance_id: number; usage_role: string }>(
      `SELECT attendance_id, usage_role FROM attendance_raw_scan_usage WHERE attendance_id IN (?, ?)`,
      [attRows[0].id, attRows[1].id]
    );
    assert.ok(usageRows.length >= 2, 'attendance_raw_scan_usage MUST be populated for Nov 18 & Nov 19');
  });

  test('HIST-05: Historical Mapping ADMIN Preview/Approve, Conflict Blocking & Audit Trail', async () => {
    const mapRow = (
      await dbQuery<{ id: number }>(
        "SELECT id FROM fingerprint_mappings WHERE person_id = '3' AND fingle_id = '57' LIMIT 1"
      )
    )[0];
    assert.ok(mapRow);

    // RESPONSIBLE_STAFF blocked from preview & approve (403)
    const staffPrev = await apiCall(`/api/Sam_Att/personnel/mappings/${mapRow.id}/retroactive-preview`, {
      method: 'POST',
      token: staffToken,
      body: { proposedEffectiveFrom: '2026-11-17' },
    });
    assert.equal(staffPrev.status, 403);

    // ADMIN read-only preview (no conflict) -> canApprove = true, willBecomeMatchedCount = 1, zero DB mutation
    const adminPrev = await apiCall(`/api/Sam_Att/personnel/mappings/${mapRow.id}/retroactive-preview`, {
      method: 'POST',
      token: adminToken,
      body: { proposedEffectiveFrom: '2026-11-17' },
    });
    assert.equal(adminPrev.status, 200);
    assert.equal(adminPrev.data.canApprove, true);
    assert.equal(adminPrev.data.willBecomeMatchedCount, 1);

    // Confirm preview did NOT mutate raw_scan_mappings
    const nov17Before = (
      await dbQuery<{ mapping_state: string }>(
        `SELECT rsm.mapping_state FROM raw_scans rs JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         WHERE rs.enroll_number = '57' AND rs.canonical_bkk_time = '2026-11-17 23:30:00'`
      )
    )[0];
    assert.equal(nov17Before.mapping_state, 'UNMATCHED');

    // Insert conflicting historical ownership for fingle_id='57' on 2026-11-10..2026-11-16
    const existingOther = await dbQuery<{ person_id: string }>(
      "SELECT person_id FROM personnel WHERE person_id != '3' LIMIT 1"
    );
    const otherPersonId = existingOther[0].person_id;
    await dbExecute(
      `INSERT INTO fingerprint_mappings (person_id, fingle_id, effective_from, effective_to, conflict_state, source)
       VALUES (?, '57', '2026-11-10', '2026-11-16', 'NONE', 'HOSOFFICE_SYNC')`,
      [otherPersonId]
    );

    // Trying to extend to 2026-11-15 MUST be blocked (conflict!)
    const conflictPrev = await apiCall(`/api/Sam_Att/personnel/mappings/${mapRow.id}/retroactive-preview`, {
      method: 'POST',
      token: adminToken,
      body: { proposedEffectiveFrom: '2026-11-15' },
    });
    assert.equal(conflictPrev.status, 200);
    assert.equal(conflictPrev.data.canApprove, false);
    assert.ok(conflictPrev.data.conflicts.length >= 1);

    const conflictApprove = await apiCall(`/api/Sam_Att/personnel/mappings/${mapRow.id}/retroactive-approve`, {
      method: 'POST',
      token: adminToken,
      body: {
        proposedEffectiveFrom: '2026-11-15',
        reason: 'ทดสอบชนซ้ำช่วงวันที่',
        impactAcknowledged: true,
        confirmPassword: 'Admin@SamAtt2026',
      },
    });
    assert.equal(conflictApprove.status, 409);
    assert.equal(conflictApprove.data.error, 'HISTORICAL_MAPPING_CONFLICT');

    // Non-overlapping retroactive approval to 2026-11-17 succeeds!
    const okApprove = await apiCall(`/api/Sam_Att/personnel/mappings/${mapRow.id}/retroactive-approve`, {
      method: 'POST',
      token: adminToken,
      body: {
        proposedEffectiveFrom: '2026-11-17',
        reason: 'บุคลากรเริ่มใช้รหัส 57 ตั้งแต่วันที่ 17 พ.ย. 2569',
        reprocessAttendance: true,
        impactAcknowledged: true,
        confirmPassword: 'Admin@SamAtt2026',
      },
    });
    assert.equal(okApprove.status, 200);
    assert.equal(okApprove.data.mappingResolution.newlyMatched, 1);

    const nov17After = (
      await dbQuery<{ mapping_state: string; matched_person_id: string }>(
        `SELECT rsm.mapping_state, rsm.matched_person_id FROM raw_scans rs JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         WHERE rs.enroll_number = '57' AND rs.canonical_bkk_time = '2026-11-17 23:30:00'`
      )
    )[0];
    assert.equal(nov17After.mapping_state, 'MATCHED');
    assert.equal(nov17After.matched_person_id, '3');

    const updatedMap = (
      await dbQuery<{
        original_effective_from: string;
        retroactive_adjusted_by: string;
        retroactive_reason: string;
      }>('SELECT original_effective_from, retroactive_adjusted_by, retroactive_reason FROM fingerprint_mappings WHERE id = ?', [
        mapRow.id,
      ])
    )[0];
    assert.equal(updatedMap.original_effective_from, '2026-11-18');
    assert.equal(updatedMap.retroactive_adjusted_by, 'admin');
    assert.ok(updatedMap.retroactive_reason.includes('17 พ.ย.'));
  });

  test('HIST-06: Read-Only Reprocess Preview & Strictly Idempotent Reprocess (Preserving HR Notes & Reviews)', async () => {
    // Attach HR note and review metadata to PERSON_ID='3' attendance on 2026-11-18
    const att18 = (
      await dbQuery<{ id: number }>(
        "SELECT id FROM attendance WHERE person_id = '3' AND work_date = '2026-11-18' LIMIT 1"
      )
    )[0];
    assert.ok(att18);
    await dbExecute(
      `UPDATE attendance
       SET review_status = 'REVIEWED', reviewed_by = 'hrstaff'
       WHERE id = ?`,
      [att18.id]
    );
    await dbExecute(
      `INSERT INTO attendance_notes (attendance_id, person_id, work_date, reason_type, note_text, created_by)
       VALUES (?, '3', '2026-11-18', 'HR_NOTE', 'HR ยืนยันปฏิบัติงานจริง', 'hrstaff')`,
      [att18.id]
    );

    // Read-only preview must not mutate
    const prevRes = await apiCall('/api/Sam_Att/attendance/reprocess/preview', {
      method: 'POST',
      token: adminToken,
      body: { dateFrom: '2026-11-18', dateTo: '2026-11-19', personId: '3' },
    });
    assert.equal(prevRes.status, 200);

    // Run reprocess twice back-to-back
    const runA = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: adminToken,
      body: { dateFrom: '2026-11-18', dateTo: '2026-11-19', personId: '3' },
    });
    assert.equal(runA.status, 200);

    const histCountAfterA = (
      await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance_matching_history WHERE attendance_id = ?', [
        att18.id,
      ])
    )[0].cnt;
    const usageCountAfterA = (
      await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance_raw_scan_usage WHERE attendance_id = ?', [
        att18.id,
      ])
    )[0].cnt;

    const runB = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: adminToken,
      body: { dateFrom: '2026-11-18', dateTo: '2026-11-19', personId: '3' },
    });
    assert.equal(runB.status, 200);

    const histCountAfterB = (
      await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance_matching_history WHERE attendance_id = ?', [
        att18.id,
      ])
    )[0].cnt;
    const usageCountAfterB = (
      await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance_raw_scan_usage WHERE attendance_id = ?', [
        att18.id,
      ])
    )[0].cnt;

    assert.equal(histCountAfterB, histCountAfterA, 'Idempotent reprocess must not write fake matching history');
    assert.equal(usageCountAfterB, usageCountAfterA, 'Idempotent reprocess must not duplicate attendance_raw_scan_usage');

    // Verify HR notes & review status preserved
    const att18After = (
      await dbQuery<{ review_status: string; reviewed_by: string }>(
        'SELECT review_status, reviewed_by FROM attendance WHERE id = ?',
        [att18.id]
      )
    )[0];
    assert.equal(att18After.review_status, 'REVIEWED');
    assert.equal(att18After.reviewed_by, 'hrstaff');

    const notesAfter = await dbQuery<{ note_text: string }>(
      'SELECT note_text FROM attendance_notes WHERE attendance_id = ?',
      [att18.id]
    );
    assert.ok(notesAfter.some((n) => n.note_text === 'HR ยืนยันปฏิบัติงานจริง'));
  });

  test('HIST-07: Partial Machine Failure -> PARTIAL_SUCCESS & Global Progress 99% Cap while RUNNING', async () => {
    const bkkToday = getCurrentBangkokDateParts().todayYmd;

    // 1. Global Progress tracker never shows 100% while RUNNING and supports PARTIAL_SUCCESS
    const job = startCentralJob({
      jobType: 'SCANNER_MANUAL_SYNC',
      actorUsername: 'admin',
      initialStep: 'กำลังเริ่มดึงข้อมูล',
      totalCount: 10,
      stage: 'READING_SCANNER',
    });
    updateCentralJobStep(job.jobId, {
      processedCount: 10,
      totalCount: 10,
      stage: 'PROCESSING_ATTENDANCE',
      currentStep: 'กำลังประมวลผลเวลาปฏิบัติงาน',
    });
    const mid = getJobById(job.jobId);
    assert.ok(mid);
    assert.equal(mid.status, 'RUNNING');
    assert.equal(mid.progressPercent, 99, 'Running job progress MUST be capped at 99%');
    completeCentralJob(job.jobId, {
      status: 'PARTIAL_SUCCESS',
      currentStep: 'เสร็จสิ้นบางส่วน',
    });
    const done = getJobById(job.jobId);
    assert.ok(done);
    assert.equal(done.status, 'PARTIAL_SUCCESS');
    assert.equal(done.progressPercent, 100);

    // 2. Partial machine failure via Scanner Sync endpoint
    try {
      setScannerExeProcessRunnerForTests(async () => ({
        stdout: JSON.stringify({
          success: false,
          machines: [
            { machineNo: 101, status: 'OK', read: 1 },
            { machineNo: 102, status: 'FAILED', error: 'Connection timed out' },
          ],
          scans: [
            {
              machineNo: 101,
              enrollNumber: '1001',
              scanDateTime: `${bkkToday} 08:02:11`,
              verifyMode: 1,
              inOutMode: 0,
              workCode: 0,
            },
          ],
        }),
        stderr: '',
      }));

      const partialRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(partialRes.status, 200);
      assert.equal(partialRes.data.status, 'PARTIAL_SUCCESS');
      assert.equal(partialRes.data.newInserted, 1);
      assert.ok(Array.isArray(partialRes.data.machineResults));
      assert.equal(partialRes.data.machineResults.length, 2);
      assert.ok(partialRes.data.warningMessage);

      const savedRun = (
        await dbQuery<{ status: string; machine_results_json: string | null }>(
          'SELECT status, machine_results_json FROM sync_runs WHERE id = ?',
          [partialRes.data.syncRunId]
        )
      )[0];
      assert.equal(savedRun.status, 'PARTIAL_SUCCESS');
      assert.ok(savedRun.machine_results_json);
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });
});
