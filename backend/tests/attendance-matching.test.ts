/**
 * ============================================================================
 * Automated Test Suite: Attendance Matching Engine (TC-01 through TC-30)
 * Covers ATT-01 through ATT-16 against real Matching Engine, real SQLite DB
 * with 001 + 002 migrations, and real Express HTTP API.
 * ============================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-att-matching-test-'));
const testSqlitePath = path.join(tmpDir, 'sam_att_matching_test.sqlite');

process.env.NODE_ENV = 'test';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = testSqlitePath;
process.env.JWT_SECRET = 'test-only-matching-engine-jwt-secret-key-2026-sam-att-v2';
process.env.SCANNER_SYNC_ENABLED = 'false';
process.env.HOSOFFICE_LIVE_PUSH_ENABLED = 'false';

import {
  resetSqliteInstanceForTests,
  runMigrations,
  ensureBaselineSystemCatalog,
  seedDemoSyntheticData,
  dbQuery,
  dbExecute,
  ImmutableTableViolationError,
} from '../src/database/adapter.ts';
import { createExpressApp } from '../src/app.ts';
import {
  matchPersonShiftsGlobally,
  type MatchingShiftInput,
  type MatchingRawScanInput,
  type MatchingLeaveInput,
} from '../src/modules/attendance/matchingEngine.ts';
import {
  reprocessAttendanceRange,
  resolveRawScanPersonnelMappings,
} from '../src/modules/attendance/processor.ts';
import { evaluatePushBatch } from '../src/modules/hosoffice/routes.ts';
import { computeRawScanDedupKey } from '../src/utils/crypto.ts';

let server: http.Server;
let baseUrl = '';
let adminToken = '';
let staffToken = '';
let user1003Token = '';
let user1004Token = '';

async function apiCall(
  method: string,
  urlPath: string,
  options?: { token?: string; body?: unknown }
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (options?.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: options?.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: res.status, body: json };
}

function makeShift(overrides: Partial<MatchingShiftInput>): MatchingShiftInput {
  return {
    personId: 'SAM-P001',
    workDate: '2026-12-01',
    shiftAssignmentId: 1,
    shiftCode: 'MOR-0816',
    shiftName: 'กะเช้า (08:00–16:00)',
    startTime: '08:00',
    endTime: '16:00',
    graceMinutes: 15,
    cutoffTime: '10:30',
    isCrossMidnight: 0,
    mappingStatus: 'VALID',
    checkinWindowBeforeMin: 120,
    checkinWindowAfterMin: 240,
    checkoutWindowBeforeMin: 180,
    checkoutWindowAfterMin: 240,
    ...overrides,
  };
}

function makeScan(id: number, canonicalBkkTime: string, personId = 'SAM-P001'): MatchingRawScanInput {
  return { id, personId, canonicalBkkTime, inOutMode: 0 };
}

async function insertRawScanForTest(params: {
  machineNo?: number;
  enrollNumber: string;
  scanDateTime: string;
  inOutMode?: number;
}): Promise<number> {
  const ev = {
    machineNo: params.machineNo ?? 1,
    enrollNumber: params.enrollNumber,
    scanDateTime: params.scanDateTime,
    verifyMode: 1,
    inOutMode: params.inOutMode ?? 0,
    workCode: 0,
  };
  const { dedupKey, canonicalBkkTime } = computeRawScanDedupKey(ev);
  const res = await dbExecute(
    `INSERT INTO raw_scans (
      event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
      verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'IMMUTABLE_RAW')`,
    [
      dedupKey,
      ev.machineNo,
      ev.enrollNumber,
      ev.scanDateTime,
      canonicalBkkTime,
      ev.verifyMode,
      ev.inOutMode,
      ev.workCode,
      JSON.stringify(ev),
    ]
  );
  return Number(res.insertId);
}

async function assignShiftForTest(params: {
  personId: string;
  workDate: string;
  shiftId: number;
  code: string;
  name: string;
  start: string;
  end: string;
  grace?: number;
  cutoff?: string;
  cross?: number;
}): Promise<number> {
  const res = await dbExecute(
    `INSERT INTO shift_assignments (
      person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
      snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
      snapshot_is_cross_midnight, assigned_by, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'test', 'ACTIVE')`,
    [
      params.personId,
      params.shiftId,
      params.workDate,
      params.code,
      params.name,
      params.start,
      params.end,
      params.grace ?? 15,
      params.cutoff ?? '10:30',
      params.cross ?? (params.end <= params.start ? 1 : 0),
    ]
  );
  return Number(res.insertId);
}

test.before(async () => {
  resetSqliteInstanceForTests(testSqlitePath);
  const mig = await runMigrations();
  assert.ok(mig.applied.includes('001_initial_schema.sql'));
  assert.ok(mig.applied.includes('002_attendance_matching_engine.sql'));
  await ensureBaselineSystemCatalog();
  await seedDemoSyntheticData();

  const app = createExpressApp({ serveStaticBuild: false });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}/api/Sam_Att`;
      resolve();
    });
  });

  const loginAdmin = await apiCall('POST', '/auth/login', {
    body: { username: 'admin', password: 'Admin@SamAtt2026' },
  });
  assert.equal(loginAdmin.status, 200);
  adminToken = loginAdmin.body.token;

  const loginStaff = await apiCall('POST', '/auth/login', {
    body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
  });
  assert.equal(loginStaff.status, 200);
  staffToken = loginStaff.body.token;

  const loginU3 = await apiCall('POST', '/auth/login', {
    body: { username: 'user1003', password: 'User@SamAtt2026' },
  });
  assert.equal(loginU3.status, 200);
  user1003Token = loginU3.body.token;

  const loginU4 = await apiCall('POST', '/auth/login', {
    body: { username: 'user1004', password: 'User@SamAtt2026' },
  });
  assert.equal(loginU4.status, 200);
  user1004Token = loginU4.body.token;
});

test.after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  resetSqliteInstanceForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Pure Matching Engine Unit Tests (TC-01 .. TC-17, TC-21, TC-23, TC-27, TC-28, TC-29)
// ============================================================================

test('TC-01: Normal single shift (08:00–16:00) matches IN and OUT as COMPLETE / NORMAL', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 07:45:00'), makeScan(2, '2026-12-01 16:05:00')],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes.length, 1);
  assert.equal(res.outcomes[0].attendanceStatus, 'COMPLETE');
  assert.equal(res.outcomes[0].status, 'NORMAL');
  assert.equal(res.outcomes[0].checkInRawScanId, 1);
  assert.equal(res.outcomes[0].checkOutRawScanId, 2);
  assert.equal(res.outcomes[0].isLate, 0);
  assert.equal(res.outcomes[0].earlyCheckoutIndicator, 0);
});

test('TC-02: Multiple IN scans -> selects FIRST valid IN scan and marks extras unused (ATT-06, ATT-09)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [
      makeScan(10, '2026-12-01 07:35:00'),
      makeScan(11, '2026-12-01 07:45:00'),
      makeScan(12, '2026-12-01 07:55:00'),
      makeScan(13, '2026-12-01 16:05:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkInRawScanId, 10);
  assert.equal(res.outcomes[0].checkOutRawScanId, 13);
  assert.deepEqual(res.extraScanIds, [11, 12]);
});

test('TC-03: Multiple OUT scans -> selects FIRST valid OUT scan and marks later scans unused (ATT-07, ATT-09)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [
      makeScan(20, '2026-12-01 07:50:00'),
      makeScan(21, '2026-12-01 16:02:00'),
      makeScan(22, '2026-12-01 16:15:00'),
      makeScan(23, '2026-12-01 16:40:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkInRawScanId, 20);
  assert.equal(res.outcomes[0].checkOutRawScanId, 21);
  assert.deepEqual(res.extraScanIds, [22, 23]);
});

test('TC-04: Consecutive shifts (08:00–16:00 + 16:00–00:00) with 4 distinct scans -> both COMPLETE, zero reuse (ATT-01, ATT-03, ATT-04)', () => {
  const shifts = [
    makeShift({ shiftAssignmentId: 1, shiftCode: 'MOR-0816', startTime: '08:00', endTime: '16:00', isCrossMidnight: 0 }),
    makeShift({ shiftAssignmentId: 2, shiftCode: 'AFT-1600', startTime: '16:00', endTime: '00:00', isCrossMidnight: 1, cutoffTime: '18:30' }),
  ];
  const res = matchPersonShiftsGlobally({
    shifts,
    rawScans: [
      makeScan(1, '2026-12-01 07:50:00'),
      makeScan(2, '2026-12-01 16:00:00'),
      makeScan(3, '2026-12-01 16:05:00'),
      makeScan(4, '2026-12-02 00:10:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-02 10:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes.length, 2);
  assert.equal(res.outcomes[0].checkInRawScanId, 1);
  assert.equal(res.outcomes[0].checkOutRawScanId, 2);
  assert.equal(res.outcomes[0].attendanceStatus, 'COMPLETE');
  assert.equal(res.outcomes[1].checkInRawScanId, 3);
  assert.equal(res.outcomes[1].checkOutRawScanId, 4);
  assert.equal(res.outcomes[1].attendanceStatus, 'COMPLETE');
  assert.equal(res.usedScanIds.size, 4);
});

test('TC-05: Consecutive shifts with 1-minute gap (16:00 OUT and 16:01 IN) -> no artificial minimum gap (ATT-05)', () => {
  const shifts = [
    makeShift({ shiftAssignmentId: 1, shiftCode: 'MOR-0816', startTime: '08:00', endTime: '16:00' }),
    makeShift({ shiftAssignmentId: 2, shiftCode: 'AFT-1600', startTime: '16:00', endTime: '00:00', isCrossMidnight: 1, cutoffTime: '18:30' }),
  ];
  const res = matchPersonShiftsGlobally({
    shifts,
    rawScans: [
      makeScan(1, '2026-12-01 07:55:00'),
      makeScan(2, '2026-12-01 16:00:00'),
      makeScan(3, '2026-12-01 16:01:00'),
      makeScan(4, '2026-12-02 00:05:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-02 10:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkOutRawScanId, 2);
  assert.equal(res.outcomes[1].checkInRawScanId, 3);
  assert.equal(res.outcomes[0].attendanceStatus, 'COMPLETE');
  assert.equal(res.outcomes[1].attendanceStatus, 'COMPLETE');
});

test('TC-07: Single scan in overlap between Shift 1 OUT and Shift 2 IN -> prioritizes Shift 2 IN, no reuse (ATT-16)', () => {
  const shifts = [
    makeShift({ shiftAssignmentId: 1, shiftCode: 'MOR-0816', startTime: '08:00', endTime: '16:00' }),
    makeShift({ shiftAssignmentId: 2, shiftCode: 'AFT-1600', startTime: '16:00', endTime: '00:00', isCrossMidnight: 1, cutoffTime: '18:30' }),
  ];
  const res = matchPersonShiftsGlobally({
    shifts,
    rawScans: [
      makeScan(1, '2026-12-01 07:50:00'),
      makeScan(2, '2026-12-01 15:58:00'),
      makeScan(3, '2026-12-02 00:05:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-02 10:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkInRawScanId, 1);
  assert.equal(res.outcomes[0].checkOutRawScanId, null);
  assert.equal(res.outcomes[0].attendanceStatus, 'MISSING_CHECKOUT');
  assert.equal(res.outcomes[1].checkInRawScanId, 2);
  assert.equal(res.outcomes[1].checkOutRawScanId, 3);
  assert.equal(res.outcomes[1].attendanceStatus, 'COMPLETE');
  assert.equal(res.outcomes[0].matchingRule, 'ATT16_OVERLAP_PRIORITIZED_NEXT_SHIFT_IN');
});

test('TC-08: Three consecutive shifts across midnight (Morning + Afternoon + Night) -> 6 distinct scans matched cleanly', () => {
  const shifts = [
    makeShift({ shiftAssignmentId: 1, workDate: '2026-12-01', shiftCode: 'MOR-0816', startTime: '08:00', endTime: '16:00', isCrossMidnight: 0 }),
    makeShift({ shiftAssignmentId: 2, workDate: '2026-12-01', shiftCode: 'AFT-1600', startTime: '16:00', endTime: '00:00', isCrossMidnight: 1, cutoffTime: '18:30' }),
    makeShift({ shiftAssignmentId: 3, workDate: '2026-12-02', shiftCode: 'NIG-0008', startTime: '00:00', endTime: '08:00', isCrossMidnight: 0, cutoffTime: '02:30' }),
  ];
  const res = matchPersonShiftsGlobally({
    shifts,
    rawScans: [
      makeScan(1, '2026-12-01 07:55:00'),
      makeScan(2, '2026-12-01 16:00:00'),
      makeScan(3, '2026-12-01 16:02:00'),
      makeScan(4, '2026-12-02 00:00:00'),
      makeScan(5, '2026-12-02 00:02:00'),
      makeScan(6, '2026-12-02 08:05:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-02 12:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes.length, 3);
  assert.deepEqual(
    res.outcomes.map((o) => [o.checkInRawScanId, o.checkOutRawScanId, o.attendanceStatus]),
    [
      [1, 2, 'COMPLETE'],
      [3, 4, 'COMPLETE'],
      [5, 6, 'COMPLETE'],
    ]
  );
  assert.equal(res.usedScanIds.size, 6);
});

test('TC-09: Early checkout -> COMPLETE + earlyCheckoutIndicator=1 + accurate earlyCheckoutMinutes (ATT-10, ATT-12)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 07:55:00'), makeScan(2, '2026-12-01 15:10:00')],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  const o = res.outcomes[0];
  assert.equal(o.attendanceStatus, 'COMPLETE');
  assert.equal(o.status, 'NORMAL');
  assert.equal(o.isLate, 0);
  assert.equal(o.earlyCheckoutIndicator, 1);
  assert.equal(o.earlyCheckoutMinutes, 50);
  assert.equal(o.secondaryFlags, 'EARLY_CHECKOUT');
});

test('TC-10: Late AND Early Checkout simultaneously -> both indicators accurately populated (ATT-10, ATT-12)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({ graceMinutes: 15 })],
    rawScans: [makeScan(1, '2026-12-01 08:25:00'), makeScan(2, '2026-12-01 15:30:00')],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  const o = res.outcomes[0];
  assert.equal(o.attendanceStatus, 'COMPLETE');
  assert.equal(o.status, 'LATE');
  assert.equal(o.isLate, 1);
  assert.equal(o.lateMinutes, 25);
  assert.equal(o.earlyCheckoutIndicator, 1);
  assert.equal(o.earlyCheckoutMinutes, 30);
  assert.equal(o.secondaryFlags, 'LATE_AND_EARLY_CHECKOUT');
});

test('TC-12 & TC-13: Half-Day Morning Leave (08:00–12:00) + configurable pre-checkin window 30 / 60 / 120 min (ATT-15)', () => {
  const leave: MatchingLeaveInput = {
    id: 1,
    personId: 'SAM-P001',
    workDate: '2026-12-01',
    shiftAssignmentId: 1,
    leaveType: 'HALF_DAY_MORNING',
    leaveStartTime: '08:00',
    leaveEndTime: '12:00',
  };

  // TC-12: IN at 11:45, OUT at 16:05 with default 60 min window -> evaluated 12:00..16:00, NORMAL/COMPLETE
  const res12 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 11:45:00'), makeScan(2, '2026-12-01 16:05:00')],
    leaves: [leave],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res12.outcomes[0].evaluatedStartTime, '2026-12-01 12:00:00');
  assert.equal(res12.outcomes[0].evaluatedEndTime, '2026-12-01 16:00:00');
  assert.equal(res12.outcomes[0].attendanceStatus, 'COMPLETE');
  assert.equal(res12.outcomes[0].status, 'NORMAL');
  assert.equal(res12.outcomes[0].isLate, 0);

  // TC-13a: Scan at 11:10 rejected when pre-checkin window = 30 min (window starts 11:30)
  const res30 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 11:10:00'), makeScan(2, '2026-12-01 16:05:00')],
    leaves: [leave],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 30 },
  });
  assert.equal(res30.outcomes[0].checkInRawScanId, null);
  assert.equal(res30.outcomes[0].attendanceStatus, 'MISSING_CHECKIN');

  // TC-13b: Same scan at 11:10 accepted when pre-checkin window = 60 min (window starts 11:00)
  const res60 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 11:10:00'), makeScan(2, '2026-12-01 16:05:00')],
    leaves: [leave],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res60.outcomes[0].checkInRawScanId, 1);
  assert.equal(res60.outcomes[0].attendanceStatus, 'COMPLETE');

  // TC-13c: Scan at 10:15 accepted only when pre-checkin window = 120 min (window starts 10:00)
  const res120 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 10:15:00'), makeScan(2, '2026-12-01 16:05:00')],
    leaves: [leave],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 120 },
  });
  assert.equal(res120.outcomes[0].checkInRawScanId, 1);
  assert.equal(res120.outcomes[0].attendanceStatus, 'COMPLETE');
});

test('TC-14: Half-Day Afternoon Leave (12:00–16:00) evaluates end at 12:00 cleanly (ATT-15)', () => {
  const leave: MatchingLeaveInput = {
    id: 2,
    personId: 'SAM-P001',
    workDate: '2026-12-01',
    shiftAssignmentId: 1,
    leaveType: 'HALF_DAY_AFTERNOON',
    leaveStartTime: '12:00',
    leaveEndTime: '16:00',
  };
  const resOnTime = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 07:50:00'), makeScan(2, '2026-12-01 12:05:00')],
    leaves: [leave],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(resOnTime.outcomes[0].evaluatedStartTime, '2026-12-01 08:00:00');
  assert.equal(resOnTime.outcomes[0].evaluatedEndTime, '2026-12-01 12:00:00');
  assert.equal(resOnTime.outcomes[0].attendanceStatus, 'COMPLETE');
  assert.equal(resOnTime.outcomes[0].earlyCheckoutIndicator, 0);

  const resEarly = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 07:50:00'), makeScan(2, '2026-12-01 11:30:00')],
    leaves: [leave],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(resEarly.outcomes[0].earlyCheckoutIndicator, 1);
  assert.equal(resEarly.outcomes[0].earlyCheckoutMinutes, 30);
});

test('TC-15, TC-16, TC-17: Completeness statuses MISSING_CHECKOUT, MISSING_CHECKIN, NO_SCAN (ATT-14)', () => {
  // TC-15: IN only past end
  const r15 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(1, '2026-12-01 07:55:00')],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 20:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(r15.outcomes[0].attendanceStatus, 'MISSING_CHECKOUT');
  assert.equal(r15.outcomes[0].status, 'MISSING_CHECKOUT');
  assert.equal(r15.outcomes[0].checkInRawScanId, 1);
  assert.equal(r15.outcomes[0].checkOutRawScanId, null);

  // TC-16: OUT only
  const r16 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [makeScan(2, '2026-12-01 16:05:00')],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 20:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(r16.outcomes[0].attendanceStatus, 'MISSING_CHECKIN');
  assert.equal(r16.outcomes[0].status, 'MISSING_CHECKIN');
  assert.equal(r16.outcomes[0].checkInRawScanId, null);
  assert.equal(r16.outcomes[0].checkOutRawScanId, 2);

  // TC-17: Zero scans past cutoff
  const r17 = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 20:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(r17.outcomes[0].attendanceStatus, 'NO_SCAN');
  assert.equal(r17.outcomes[0].status, 'NO_SCAN');
});

test('TC-21: Extra scans around consecutive shifts -> allocates Shift 1 OUT & Shift 2 IN before marking extra unused (ATT-08, ATT-09)', () => {
  const shifts = [
    makeShift({ shiftAssignmentId: 1, shiftCode: 'MOR-0816', startTime: '08:00', endTime: '16:00' }),
    makeShift({ shiftAssignmentId: 2, shiftCode: 'AFT-1600', startTime: '16:00', endTime: '00:00', isCrossMidnight: 1, cutoffTime: '18:30' }),
  ];
  const res = matchPersonShiftsGlobally({
    shifts,
    rawScans: [
      makeScan(1, '2026-12-01 07:50:00'),
      makeScan(2, '2026-12-01 15:55:00'),
      makeScan(3, '2026-12-01 16:02:00'),
      makeScan(4, '2026-12-01 16:10:00'),
      makeScan(5, '2026-12-02 00:05:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-02 10:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkOutRawScanId, 2);
  assert.equal(res.outcomes[1].checkInRawScanId, 3);
  assert.deepEqual(res.extraScanIds, [4]);
});

test('TC-23: Multiple valid OUT scans inside OUT window -> picks earliest valid OUT scan (ATT-07)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [
      makeScan(1, '2026-12-01 08:30:00'),
      makeScan(2, '2026-12-01 15:40:00'),
      makeScan(3, '2026-12-01 16:05:00'),
      makeScan(4, '2026-12-01 16:20:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkInRawScanId, 1);
  assert.equal(res.outcomes[0].checkOutRawScanId, 2);
  assert.equal(res.outcomes[0].earlyCheckoutIndicator, 1);
  assert.equal(res.outcomes[0].earlyCheckoutMinutes, 20);
  assert.deepEqual(res.extraScanIds, [3, 4]);
});

test('TC-27: Late check-in 3.5 hours after shift start (11:30) still accepted as IN (ATT-06)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({ graceMinutes: 15 })],
    rawScans: [makeScan(1, '2026-12-01 11:30:00'), makeScan(2, '2026-12-01 16:05:00')],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].attendanceStatus, 'COMPLETE');
  assert.equal(res.outcomes[0].status, 'LATE');
  assert.equal(res.outcomes[0].lateMinutes, 210);
  assert.equal(res.outcomes[0].checkInRawScanId, 1);
  assert.equal(res.outcomes[0].checkOutRawScanId, 2);
});

test('TC-28: Scans strictly outside IN and OUT acceptance windows are NOT matched (ATT-06, ATT-07)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [
      makeScan(1, '2026-12-01 04:00:00'),
      makeScan(2, '2026-12-01 22:30:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:30:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].attendanceStatus, 'NO_SCAN');
  assert.deepEqual(res.extraScanIds, [1, 2]);
});

test('TC-29: Identical timestamp tie-breaker selects smallest ID and rejects same-second IN/OUT pair (ATT-02, Sec 4.3)', () => {
  const res = matchPersonShiftsGlobally({
    shifts: [makeShift({})],
    rawScans: [
      makeScan(99, '2026-12-01 07:55:00'),
      makeScan(42, '2026-12-01 07:55:00'),
    ],
    leaves: [],
    config: { referenceNowBkk: '2026-12-01 23:00:00', halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(res.outcomes[0].checkInRawScanId, 42);
  assert.equal(res.outcomes[0].checkOutRawScanId, null);
  assert.equal(res.outcomes[0].attendanceStatus, 'MISSING_CHECKOUT');
  assert.deepEqual(res.extraScanIds, [99]);
});

// ============================================================================
// Full-Stack DB + HTTP API Integration Tests (TC-06, TC-11, TC-18..TC-20, TC-22, TC-24..TC-26, TC-30)
// ============================================================================

test('TC-06 & TC-24: DB-level anti-reuse PK on attendance_raw_scan_usage and raw_scans immutability', async () => {
  const workDate = '2026-12-05';
  await assignShiftForTest({
    personId: 'SAM-P001',
    workDate,
    shiftId: 2,
    code: 'MOR-0816',
    name: 'กะเช้า (08:00–16:00)',
    start: '08:00',
    end: '16:00',
  });
  await assignShiftForTest({
    personId: 'SAM-P001',
    workDate,
    shiftId: 3,
    code: 'AFT-1600',
    name: 'กะบ่าย (16:00–00:00)',
    start: '16:00',
    end: '00:00',
    cutoff: '18:30',
    cross: 1,
  });

  const s1 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${workDate} 07:50:00` });
  const s2 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${workDate} 16:00:00` });
  const s3 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${workDate} 16:03:00` });
  const s4 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: '2026-12-06 00:05:00' });

  const rawCountBefore = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;

  await reprocessAttendanceRange({
    dateFrom: workDate,
    dateTo: workDate,
    personId: 'SAM-P001',
    referenceNowBkk: '2026-12-06 10:00:00',
    actorUsername: 'admin',
  });

  const usageRows = await dbQuery<{ raw_scan_id: number; attendance_id: number; usage_role: string }>(
    'SELECT raw_scan_id, attendance_id, usage_role FROM attendance_raw_scan_usage WHERE person_id = ? AND work_date = ? ORDER BY raw_scan_id ASC',
    ['SAM-P001', workDate]
  );
  assert.equal(usageRows.length, 4);
  assert.deepEqual(
    usageRows.map((u) => u.raw_scan_id),
    [s1, s2, s3, s4]
  );

  // DB-level PK constraint must reject inserting duplicate raw_scan_id (ATT-03)
  await assert.rejects(
    dbExecute(
      `INSERT INTO attendance_raw_scan_usage (raw_scan_id, attendance_id, person_id, work_date, shift_code, usage_role)
       VALUES (?, ?, 'SAM-P001', ?, 'MOR-0816', 'CHECK_OUT')`,
      [s2, usageRows[0].attendance_id, workDate]
    )
  );

  // TC-24: raw_scans immutable — count unchanged and UPDATE/DELETE blocked
  const rawCountAfter = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;
  assert.equal(rawCountAfter, rawCountBefore);
  await assert.rejects(
    dbExecute('UPDATE raw_scans SET enroll_number = ? WHERE id = ?', ['9999', s1]),
    ImmutableTableViolationError
  );
  await assert.rejects(
    dbExecute('DELETE FROM raw_scans WHERE id = ?', [s1]),
    ImmutableTableViolationError
  );
});

test('TC-11: HR Note & Review on Early Checkout preserves check_out_time and early_checkout_minutes (ATT-11, ATT-12)', async () => {
  const workDate = '2026-12-07';
  await assignShiftForTest({
    personId: 'SAM-P002',
    workDate,
    shiftId: 2,
    code: 'MOR-0816',
    name: 'กะเช้า (08:00–16:00)',
    start: '08:00',
    end: '16:00',
  });
  await insertRawScanForTest({ enrollNumber: '1002', scanDateTime: `${workDate} 07:55:00` });
  await insertRawScanForTest({ enrollNumber: '1002', scanDateTime: `${workDate} 15:10:00` });

  await reprocessAttendanceRange({
    dateFrom: workDate,
    dateTo: workDate,
    personId: 'SAM-P002',
    referenceNowBkk: `${workDate} 22:00:00`,
    actorUsername: 'admin',
  });

  const [att] = await dbQuery<any>(
    'SELECT * FROM attendance WHERE person_id = ? AND work_date = ? LIMIT 1',
    ['SAM-P002', workDate]
  );
  assert.equal(att.attendance_status, 'COMPLETE');
  assert.equal(Number(att.early_checkout_indicator), 1);
  assert.equal(Number(att.early_checkout_minutes), 50);

  const noteRes = await apiCall('POST', `/attendance/${att.id}/notes`, {
    token: staffToken,
    body: {
      reasonType: 'EARLY_CHECKOUT_OFFICIAL',
      noteText: 'ไปราชการช่วงบ่ายตามคำสั่ง รพ.',
    },
  });
  assert.equal(noteRes.status, 201);

  const revRes = await apiCall('POST', `/attendance/${att.id}/review`, {
    token: staffToken,
    body: {
      reviewStatus: 'VERIFIED_APPROVED',
      reviewReasonCategory: 'EARLY_CHECKOUT_OFFICIAL',
      reviewComment: 'อนุมัติตามหนังสือไปราชการ',
    },
  });
  assert.equal(revRes.status, 200);
  assert.equal(revRes.body.preservedEarlyCheckoutIndicator, 1);
  assert.equal(revRes.body.preservedEarlyCheckoutMinutes, 50);

  const [afterAtt] = await dbQuery<any>('SELECT * FROM attendance WHERE id = ?', [att.id]);
  assert.equal(afterAtt.check_out_time, `${workDate} 15:10:00`);
  assert.equal(Number(afterAtt.early_checkout_indicator), 1);
  assert.equal(Number(afterAtt.early_checkout_minutes), 50);
  assert.equal(afterAtt.review_status, 'VERIFIED_APPROVED');
  assert.equal(afterAtt.review_reason, 'อนุมัติตามหนังสือไปราชการ');
  assert.equal(afterAtt.reviewed_by, 'hrstaff');
});

test('TC-18 & TC-20: Cross-midnight OUT scan via /scanners/ingest auto-reprocesses previous day & deduplicates duplicates', async () => {
  const workDate = '2026-12-09';
  const nextDate = '2026-12-10';
  await assignShiftForTest({
    personId: 'SAM-P003',
    workDate,
    shiftId: 3,
    code: 'AFT-1600',
    name: 'กะบ่าย (16:00–00:00)',
    start: '16:00',
    end: '00:00',
    cutoff: '18:30',
    cross: 1,
  });

  // Ingest IN scan + exact duplicate (TC-20)
  const ingest1 = await apiCall('POST', '/scanners/ingest', {
    token: adminToken,
    body: {
      events: [
        { machineNo: 1, enrollNumber: '1003', scanDateTime: `${workDate} 15:55:00`, verifyMode: 1, inOutMode: 0, workCode: 0 },
        { machineNo: 1, enrollNumber: '1003', scanDateTime: `${workDate} 15:55:00`, verifyMode: 1, inOutMode: 0, workCode: 0 },
      ],
    },
  });
  assert.equal(ingest1.status, 201);
  assert.equal(ingest1.body.newInserted, 1);
  assert.equal(ingest1.body.duplicatesSkipped, 1);

  // Now post-midnight OUT scan arrives on nextDate (TC-18)
  const ingest2 = await apiCall('POST', '/scanners/ingest', {
    token: adminToken,
    body: {
      events: [
        { machineNo: 1, enrollNumber: '1003', scanDateTime: `${nextDate} 00:15:00`, verifyMode: 1, inOutMode: 1, workCode: 0 },
      ],
    },
  });
  assert.equal(ingest2.status, 201);

  const [att] = await dbQuery<any>(
    "SELECT * FROM attendance WHERE person_id = 'SAM-P003' AND work_date = ? AND shift_code = 'AFT-1600' LIMIT 1",
    [workDate]
  );
  assert.ok(att);
  assert.equal(att.attendance_status, 'COMPLETE');
  assert.equal(att.check_in_time, `${workDate} 15:55:00`);
  assert.equal(att.check_out_time, `${nextDate} 00:15:00`);
});

test('TC-19 & TC-26: Reprocess idempotency + NEEDS_RE_REVIEW on changed reviewed shift blocks HOSOffice push (ATT-13)', async () => {
  const workDate = '2026-12-12';
  await assignShiftForTest({
    personId: 'SAM-P004',
    workDate,
    shiftId: 2,
    code: 'MOR-0816',
    name: 'กะเช้า (08:00–16:00)',
    start: '08:00',
    end: '16:00',
  });
  await insertRawScanForTest({ enrollNumber: '1004', scanDateTime: `${workDate} 08:30:00` });

  // First reprocess: only IN scan -> MISSING_CHECKOUT
  await reprocessAttendanceRange({
    dateFrom: workDate,
    dateTo: workDate,
    personId: 'SAM-P004',
    referenceNowBkk: `${workDate} 22:00:00`,
    actorUsername: 'admin',
  });

  const [att1] = await dbQuery<any>(
    "SELECT * FROM attendance WHERE person_id = 'SAM-P004' AND work_date = ? LIMIT 1",
    [workDate]
  );
  assert.equal(att1.status, 'MISSING_CHECKOUT');

  // HR adds note & approves
  await apiCall('POST', `/attendance/${att1.id}/notes`, {
    token: staffToken,
    body: { reasonType: 'FORGOT_CHECKOUT_VERIFIED', noteText: 'ลืมสแกนออก (หัวหน้างานรับรอง)' },
  });
  await apiCall('POST', `/attendance/${att1.id}/review`, {
    token: staffToken,
    body: {
      reviewStatus: 'VERIFIED_APPROVED',
      reviewReasonCategory: 'FORGOT_CHECKOUT_VERIFIED',
      reviewComment: 'ยืนยันการปฏิบัติงานครบกะ',
    },
  });

  // TC-19: Reprocess again with NO new scans -> review_status MUST remain VERIFIED_APPROVED, 0 new history rows
  const histBefore = (
    await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance_matching_history WHERE attendance_id = ?', [
      att1.id,
    ])
  )[0].cnt;

  const idemp = await reprocessAttendanceRange({
    dateFrom: workDate,
    dateTo: workDate,
    personId: 'SAM-P004',
    referenceNowBkk: `${workDate} 22:00:00`,
    actorUsername: 'admin',
  });
  assert.equal(idemp.changedCount, 0);

  const [attAfterIdemp] = await dbQuery<any>('SELECT * FROM attendance WHERE id = ?', [att1.id]);
  assert.equal(attAfterIdemp.review_status, 'VERIFIED_APPROVED');
  const histAfterIdemp = (
    await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM attendance_matching_history WHERE attendance_id = ?', [
      att1.id,
    ])
  )[0].cnt;
  assert.equal(histAfterIdemp, histBefore);

  // TC-26: Late-arriving OUT scan syncs in -> Reprocess changes result -> flags NEEDS_RE_REVIEW & preserves notes!
  await insertRawScanForTest({ enrollNumber: '1004', scanDateTime: `${workDate} 16:05:00` });
  const changedRep = await reprocessAttendanceRange({
    dateFrom: workDate,
    dateTo: workDate,
    personId: 'SAM-P004',
    referenceNowBkk: `${workDate} 22:00:00`,
    actorUsername: 'admin',
  });
  assert.equal(changedRep.changedCount, 1);
  assert.equal(changedRep.reReviewFlaggedCount, 1);

  const [attChanged] = await dbQuery<any>('SELECT * FROM attendance WHERE id = ?', [att1.id]);
  assert.equal(attChanged.attendance_status, 'COMPLETE');
  assert.equal(attChanged.status, 'LATE');
  assert.equal(attChanged.review_status, 'NEEDS_RE_REVIEW');

  const notesAfter = await dbQuery<any>('SELECT * FROM attendance_notes WHERE attendance_id = ?', [att1.id]);
  assert.equal(notesAfter.length, 1);
  assert.equal(Number(notesAfter[0].needs_re_review), 1);

  const histAfterChange = await dbQuery<any>(
    'SELECT * FROM attendance_matching_history WHERE attendance_id = ?',
    [att1.id]
  );
  assert.ok(histAfterChange.length >= 1);
  assert.equal(histAfterChange[0].previous_status, 'MISSING_CHECKOUT');
  assert.equal(histAfterChange[0].new_status, 'LATE');

  // HOSOffice push batch MUST block NEEDS_RE_REVIEW
  const pushEvalBlocked = await evaluatePushBatch(workDate, workDate);
  const blockedItem = pushEvalBlocked.invalidItems.find((i) => i.attendanceId === att1.id);
  assert.ok(blockedItem, 'NEEDS_RE_REVIEW row must be blocked from HOSOffice push');

  // Once HR re-reviews, needs_re_review resets to 0 and HOSOffice push allows it
  await apiCall('POST', `/attendance/${att1.id}/review`, {
    token: staffToken,
    body: {
      reviewStatus: 'VERIFIED_APPROVED',
      reviewReasonCategory: 'VERIFIED_BY_HR',
      reviewComment: 'ตรวจสอบซ้ำหลังพบสแกนออกแล้ว',
    },
  });
  const notesReReviewed = await dbQuery<any>('SELECT * FROM attendance_notes WHERE attendance_id = ?', [att1.id]);
  assert.equal(Number(notesReReviewed[0].needs_re_review), 0);

  const pushEvalAllowed = await evaluatePushBatch(workDate, workDate);
  assert.ok(
    pushEvalAllowed.validItems.some((v) => v.PERSON_ID === 'SAM-P004' && v.WORK_DATE === workDate),
    'Re-reviewed row should be eligible for HOSOffice push'
  );
});

test('TC-22: Cross-day boundary protection prevents Day 2 reprocess from stealing Day 1 cross-midnight OUT scan', async () => {
  const day1 = '2026-12-15';
  const day2 = '2026-12-16';
  await assignShiftForTest({
    personId: 'SAM-P001',
    workDate: day1,
    shiftId: 3,
    code: 'AFT-1600',
    name: 'กะบ่าย (16:00–00:00)',
    start: '16:00',
    end: '00:00',
    cutoff: '18:30',
    cross: 1,
  });
  await assignShiftForTest({
    personId: 'SAM-P001',
    workDate: day2,
    shiftId: 4,
    code: 'NIG-0008',
    name: 'กะดึก (00:00–08:00)',
    start: '00:00',
    end: '08:00',
    cutoff: '02:30',
    cross: 0,
  });

  const s1 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${day1} 15:55:00` });
  const s2 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${day2} 00:05:00` });
  const s3 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${day2} 00:08:00` });
  const s4 = await insertRawScanForTest({ enrollNumber: '1001', scanDateTime: `${day2} 08:05:00` });

  // Reprocess ONLY day2 -> global boundary window [day1..day3] must keep s2 for day1 OUT and assign s3 to day2 IN!
  await reprocessAttendanceRange({
    dateFrom: day2,
    dateTo: day2,
    personId: 'SAM-P001',
    referenceNowBkk: `${day2} 12:00:00`,
    actorUsername: 'admin',
  });

  const [day2Att] = await dbQuery<any>(
    "SELECT * FROM attendance WHERE person_id = 'SAM-P001' AND work_date = ? AND shift_code = 'NIG-0008' LIMIT 1",
    [day2]
  );
  assert.ok(day2Att);
  assert.equal(Number(day2Att.check_in_raw_scan_id), s3, 'Day 2 must NOT steal Day 1 OUT scan s2');
  assert.equal(Number(day2Att.check_out_raw_scan_id), s4);
  assert.ok(s1 < s2);
});

test('TC-25: Strict RBAC and Own-Only enforcement on /attendance/:id/scans, /attendance/leaves, /attendance/settings', async () => {
  const workDate = '2026-12-18';
  await assignShiftForTest({
    personId: 'SAM-P003',
    workDate,
    shiftId: 2,
    code: 'MOR-0816',
    name: 'กะเช้า (08:00–16:00)',
    start: '08:00',
    end: '16:00',
  });
  await insertRawScanForTest({ enrollNumber: '1003', scanDateTime: `${workDate} 07:50:00` });
  await insertRawScanForTest({ enrollNumber: '1003', scanDateTime: `${workDate} 16:05:00` });
  await insertRawScanForTest({ enrollNumber: '1003', scanDateTime: `${workDate} 16:25:00` });

  await reprocessAttendanceRange({
    dateFrom: workDate,
    dateTo: workDate,
    personId: 'SAM-P003',
    referenceNowBkk: `${workDate} 22:00:00`,
    actorUsername: 'admin',
  });

  const [u3Att] = await dbQuery<any>(
    "SELECT * FROM attendance WHERE person_id = 'SAM-P003' AND work_date = ? LIMIT 1",
    [workDate]
  );

  // Own user (user1003) -> 200 OK with used vs extra scans
  const ownRes = await apiCall('GET', `/attendance/${u3Att.id}/scans`, { token: user1003Token });
  assert.equal(ownRes.status, 200);
  assert.equal(ownRes.body.usedScansCount, 2);
  assert.equal(ownRes.body.extraScansCount, 1);

  // Other GENERAL_USER (user1004) -> 403 FORBIDDEN_OWN_DATA_ONLY (anti-IDOR)
  const otherRes = await apiCall('GET', `/attendance/${u3Att.id}/scans`, { token: user1004Token });
  assert.equal(otherRes.status, 403);
  assert.equal(otherRes.body.error, 'FORBIDDEN_OWN_DATA_ONLY');

  // HR / ADMIN -> 200 OK
  const hrRes = await apiCall('GET', `/attendance/${u3Att.id}/scans`, { token: staffToken });
  assert.equal(hrRes.status, 200);

  // GENERAL_USER blocked from leaves & settings management
  const leaveBlocked = await apiCall('POST', '/attendance/leaves', {
    token: user1003Token,
    body: {
      personId: 'SAM-P003',
      workDate,
      leaveType: 'HALF_DAY_MORNING',
      leaveStartTime: '08:00',
      leaveEndTime: '12:00',
    },
  });
  assert.equal(leaveBlocked.status, 403);

  const settingsBlocked = await apiCall('PUT', '/attendance/settings', {
    token: user1003Token,
    body: { halfDayPreCheckinWindowMinutes: 30 },
  });
  assert.equal(settingsBlocked.status, 403);
});

test('TC-30: End-to-end API routes for leaves, settings, status filters, raw-scans usage, and report KPIs', async () => {
  const workDate = '2026-12-20';
  const shiftAssignId = await assignShiftForTest({
    personId: 'SAM-P003',
    workDate,
    shiftId: 2,
    code: 'MOR-0816',
    name: 'กะเช้า (08:00–16:00)',
    start: '08:00',
    end: '16:00',
  });
  await insertRawScanForTest({ enrollNumber: '1003', scanDateTime: `${workDate} 11:20:00` });
  await insertRawScanForTest({ enrollNumber: '1003', scanDateTime: `${workDate} 16:05:00` });

  // Verify central settings PUT/GET (ATT-15)
  const setPut = await apiCall('PUT', '/attendance/settings', {
    token: adminToken,
    body: { halfDayPreCheckinWindowMinutes: 60 },
  });
  assert.equal(setPut.status, 200);
  const setGet = await apiCall('GET', '/attendance/settings', { token: staffToken });
  assert.equal(setGet.status, 200);
  assert.equal(setGet.body.halfDayPreCheckinWindowMinutes, 60);

  // Record half-day morning leave via API and verify shift template was NOT modified
  const shiftBefore = (await dbQuery<any>('SELECT start_time, end_time FROM shifts WHERE id = 2'))[0];
  const leaveRes = await apiCall('POST', '/attendance/leaves', {
    token: staffToken,
    body: {
      personId: 'SAM-P003',
      workDate,
      shiftAssignmentId: shiftAssignId,
      leaveType: 'HALF_DAY_MORNING',
      leaveStartTime: '08:00',
      leaveEndTime: '12:00',
      reason: 'ลากิจช่วงเช้า',
      referenceNowBkk: `${workDate} 22:00:00`,
    },
  });
  assert.equal(leaveRes.status, 201);
  const shiftAfter = (await dbQuery<any>('SELECT start_time, end_time FROM shifts WHERE id = 2'))[0];
  assert.deepEqual(shiftAfter, shiftBefore, 'Shift template must NEVER be modified by half-day leave');

  // Verify /me/attendance reflects leave and normal status
  const myAtt = await apiCall('GET', `/me/attendance?dateFrom=${workDate}&dateTo=${workDate}`, {
    token: user1003Token,
  });
  assert.equal(myAtt.status, 200);
  assert.equal(myAtt.body.items.length, 1);
  assert.equal(myAtt.body.items[0].status, 'NORMAL');
  assert.equal(myAtt.body.items[0].leave_type, 'HALF_DAY_MORNING');

  // Verify /me/raw-scans includes usage_role trace
  const myScans = await apiCall('GET', '/me/raw-scans', { token: user1003Token });
  assert.equal(myScans.status, 200);
  assert.ok(myScans.body.items.some((s: any) => s.usage_role === 'CHECK_IN'));
  assert.ok(myScans.body.items.some((s: any) => s.usage_role === 'CHECK_OUT'));

  // Verify /attendance?status=EARLY_CHECKOUT returns our TC-11 early checkout row
  const earlyFilter = await apiCall(
    'GET',
    '/attendance?dateFrom=2026-12-01&dateTo=2026-12-31&status=EARLY_CHECKOUT',
    { token: staffToken }
  );
  assert.equal(earlyFilter.status, 200);
  assert.ok(earlyFilter.body.items.some((i: any) => i.person_id === 'SAM-P002' && i.work_date === '2026-12-07'));

  // Verify /reports/lateness returns new KPIs cleanly
  const reportRes = await apiCall(
    'GET',
    '/reports/lateness?dateFrom=2026-12-01&dateTo=2026-12-31',
    { token: staffToken }
  );
  assert.equal(reportRes.status, 200);
  assert.ok(typeof reportRes.body.kpi.earlyCheckoutCount === 'number');
  assert.ok(typeof reportRes.body.kpi.missingCheckinCount === 'number');
  assert.ok(typeof reportRes.body.kpi.completeCount === 'number');
  assert.ok(typeof reportRes.body.kpi.needsReReviewCount === 'number');
  assert.ok(reportRes.body.kpi.earlyCheckoutCount >= 1);

  // Verify /raw-scans exposes usage_role
  const adminRaw = await apiCall('GET', `/raw-scans?dateFrom=${workDate}&dateTo=${workDate}`, {
    token: adminToken,
  });
  assert.equal(adminRaw.status, 200);
  assert.ok(adminRaw.body.items.some((r: any) => r.usage_role === 'CHECK_IN'));

  // Clean up test resolve call sanity check
  const mapRes = await resolveRawScanPersonnelMappings(workDate, workDate);
  assert.ok(typeof mapRes.newlyMatched === 'number');
});
