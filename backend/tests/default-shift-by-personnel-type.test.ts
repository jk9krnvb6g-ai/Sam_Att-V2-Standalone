/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: Default Shift by Personnel Type (12 กรณีบังคับครบถ้วน)
 * ไฟล์: backend/tests/default-shift-by-personnel-type.test.ts
 * ============================================================================
 * ครอบคลุมครบทั้ง 12 กรณีตามข้อกำหนด:
 * 1. ประเภทบุคลากรที่มี Default Shift
 * 2. ประเภทบุคลากรที่ไม่มี Default Shift ("ยังไม่กำหนดกะ")
 * 3. วันทำงานที่แตกต่างกัน (จันทร์–ศุกร์, จันทร์–เสาร์, ทุกวัน)
 * 4. ตารางเวรรายบุคคลทับ Default Shift (รวมวันหยุด/วันเสาร์–อาทิตย์)
 * 5. หลายกะใน 1 วัน (Multi-Shift)
 * 6. วันหยุดราชการ (public_holidays) — Default ไม่ทับ แต่เวรรายบุคคลทำงานได้
 * 7. วันหยุดเฉพาะบุคคล (PERSONAL_HOLIDAY override และ full-day attendance_leaves)
 * 8. การยกเลิกเวร (CLEARED_ALL_SHIFTS)
 * 9. การเปลี่ยน Default Shift (บันทึกผู้แก้ไข/เวลา, ไม่ลบกะเดิม, ไม่แก้เวร/Attendance ย้อนหลัง)
 * 10. การ Reprocess ย้อนหลังโดยผู้มีสิทธิ์เท่านั้น
 * 11. ไม่เกิด NO_SCAN หรือ LATE ผิดพลาดในวันหยุด/นอกวันทำงาน/ยกเลิกเวร/ยังไม่กำหนดกะ
 * 12. ไม่มีผลกระทบต่อ raw_scans + ตรวจสอบ Migration 005 Schema Verification
 */
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';

const TEST_DB_FILE = path.join(
  os.tmpdir(),
  `sam_att_pt_default_${process.pid}_${Date.now()}.sqlite`
);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_FILE;
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.JWT_SECRET = 'sam-att-pt-default-test-secret-2026';
process.env.SCANNER_SYNC_ENABLED = 'false';
process.env.SCANNER_AUTO_SCHEDULER_ENABLED = 'false';
process.env.HOSOFFICE_DB_HOST = 'CHANGE_ME';
process.env.HOSOFFICE_DB_PASSWORD = 'CHANGE_ME';

import { createExpressApp } from '../src/app.ts';
import {
  dbExecute,
  dbQuery,
  parseMigrationSqlFile,
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
  verifyMigrationSchemaPostApply,
} from '../src/database/adapter.ts';
import { reprocessAttendanceRange } from '../src/modules/attendance/processor.ts';

let server: http.Server;
let baseUrl = '';
let adminToken = '';
let staffToken = '';
let viewerToken = '';

let shiftOfficeId = 0; // 08:00 - 16:00
let shiftAltId = 0; // 08:30 - 16:30
let shiftAfternoonId = 0; // 16:00 - 00:00

let ruleMonFriId = 0;
let ruleMonSatId = 0;
let ruleNoDefaultId = 0;

const PERSON_MON_FRI = 'PTD-P001';
const PERSON_MON_SAT = 'PTD-P002';
const PERSON_NO_DEFAULT = 'PTD-P003';

async function apiCall(
  routePath: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${baseUrl}${routePath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: any = {};
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { status: res.status, data };
}

async function insertRawScanForPerson(params: {
  personId: string;
  fingleId: string;
  canonicalBkkTime: string;
  inOutMode: number;
  suffix: string;
}): Promise<number> {
  const dedupKey = `ptd_${params.personId}_${params.canonicalBkkTime}_${params.suffix}`;
  const ins = await dbExecute(
    `INSERT INTO raw_scans (
      event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
      verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'MATCHED')`,
    [
      dedupKey,
      99,
      params.fingleId,
      params.canonicalBkkTime,
      params.canonicalBkkTime,
      1,
      params.inOutMode,
      0,
      JSON.stringify({ test: true, suffix: params.suffix }),
      params.personId,
    ]
  );
  const scanId = Number(ins.insertId);
  await dbExecute(
    `INSERT INTO raw_scan_mappings (
      raw_scan_id, event_dedup_key, enroll_number, matched_person_id, mapping_state
    ) VALUES (?, ?, ?, ?, 'MATCHED')`,
    [scanId, dedupKey, params.fingleId, params.personId]
  );
  return scanId;
}

describe('Default Shift by Personnel Type — 12 Mandatory Scenarios (PTD-01..PTD-12)', () => {
  before(async () => {
    resetSqliteInstanceForTests(TEST_DB_FILE);
    await runMigrations();
    await seedBaselineAndSyntheticData();

    const app = createExpressApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Login Admin, Responsible Staff, Viewer (Executive)
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.data.token;

    const staffLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(staffLogin.status, 200);
    staffToken = staffLogin.data.token;

    const viewerLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(viewerLogin.status, 200);
    viewerToken = viewerLogin.data.token;

    // Create dedicated shift templates (reusable across multiple personnel types)
    const s1 = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'PTD-OFF-0816',
        shiftName: 'เวรราชการหลัก',
        shiftCategory: 'OFFICIAL',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '11:00',
      },
    });
    assert.equal(s1.status, 201);
    shiftOfficeId = Number(s1.data.id);

    const s2 = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'PTD-ALT-0830',
        shiftName: 'เวรคลินิกสาย',
        shiftCategory: 'OFFICIAL',
        startTime: '08:30',
        endTime: '16:30',
        graceMinutes: 10,
        cutoffTime: '11:30',
      },
    });
    assert.equal(s2.status, 201);
    shiftAltId = Number(s2.data.id);

    const s3 = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'PTD-AFT-1600',
        shiftName: 'เวรบ่าย',
        shiftCategory: 'AFTERNOON',
        startTime: '16:00',
        endTime: '00:00',
        graceMinutes: 15,
        cutoffTime: '19:00',
      },
    });
    assert.equal(s3.status, 201);
    shiftAfternoonId = Number(s3.data.id);

    // Create 3 test personnel type rules:
    // 1) PTD_MON_FRI -> Default = PTD-OFF-0816, Mon-Fri ('1,2,3,4,5')
    const r1 = await apiCall('/api/Sam_Att/personnel-type-rules', {
      method: 'POST',
      token: adminToken,
      body: {
        personnelTypeCode: 'PTD_MON_FRI',
        personnelTypeName: 'กลุ่มสำนักงาน (จ.–ศ.)',
        defaultShiftId: shiftOfficeId,
        defaultWorkdays: '1,2,3,4,5',
        effectiveFrom: '2026-01-01',
      },
    });
    assert.equal(r1.status, 201);
    ruleMonFriId = Number(r1.data.id);

    // 2) PTD_MON_SAT -> Same shift template reused (PTD-OFF-0816), Mon-Sat ('1,2,3,4,5,6')
    const r2 = await apiCall('/api/Sam_Att/personnel-type-rules', {
      method: 'POST',
      token: adminToken,
      body: {
        personnelTypeCode: 'PTD_MON_SAT',
        personnelTypeName: 'กลุ่มคลินิก (จ.–ส.)',
        defaultShiftId: shiftOfficeId,
        defaultWorkdays: '1,2,3,4,5,6',
        effectiveFrom: '2026-01-01',
      },
    });
    assert.equal(r2.status, 201);
    ruleMonSatId = Number(r2.data.id);

    // 3) PTD_NO_DEFAULT -> Explicitly NO default shift (defaultShiftId: null)
    const r3 = await apiCall('/api/Sam_Att/personnel-type-rules', {
      method: 'POST',
      token: adminToken,
      body: {
        personnelTypeCode: 'PTD_NO_DEFAULT',
        personnelTypeName: 'พยาบาลเวรผลัด (ไม่กำหนดกะเริ่มต้น)',
        defaultShiftId: null,
        effectiveFrom: '2026-01-01',
      },
    });
    assert.equal(r3.status, 201);
    ruleNoDefaultId = Number(r3.data.id);

    // Insert 3 test personnel matching those 3 personnel types
    const testPeople = [
      {
        personId: PERSON_MON_FRI,
        fingleId: '99101',
        name: 'นางสาวทดสอบ จันทร์ศุกร์',
        typeCode: 'PTD_MON_FRI',
        typeName: 'กลุ่มสำนักงาน (จ.–ศ.)',
      },
      {
        personId: PERSON_MON_SAT,
        fingleId: '99102',
        name: 'นายทดสอบ จันทร์เสาร์',
        typeCode: 'PTD_MON_SAT',
        typeName: 'กลุ่มคลินิก (จ.–ส.)',
      },
      {
        personId: PERSON_NO_DEFAULT,
        fingleId: '99103',
        name: 'นางสาวทดสอบ ไม่มีกะเริ่มต้น',
        typeCode: 'PTD_NO_DEFAULT',
        typeName: 'พยาบาลเวรผลัด (ไม่กำหนดกะเริ่มต้น)',
      },
    ];

    for (const tp of testPeople) {
      await dbExecute(
        `INSERT INTO personnel (
          person_id, fingle_id, first_name, last_name, full_name, department_name, position_name,
          personnel_type_code, personnel_type_name, is_active, mapping_status
        ) VALUES (?, ?, ?, ?, ?, 'กลุ่มงานทดสอบ', 'เจ้าหน้าที่ทดสอบ', ?, ?, 1, 'VALID')`,
        [tp.personId, tp.fingleId, tp.name, 'ทดสอบ', tp.name, tp.typeCode, tp.typeName]
      );
      await dbExecute(
        `INSERT INTO fingerprint_mappings (
          person_id, fingle_id, effective_from, effective_to, conflict_state, source, created_by
        ) VALUES (?, ?, '2026-01-01', NULL, 'NONE', 'TEST_SEED', 'admin')`,
        [tp.personId, tp.fingleId]
      );
    }
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
    } catch {
      // ignore cleanup error
    }
  });

  test('PTD-01: Personnel type WITH Default Shift resolves Default Shift on working day and allows reusing one template across multiple types', async () => {
    // 2026-09-07 is Monday
    await insertRawScanForPerson({
      personId: PERSON_MON_FRI,
      fingleId: '99101',
      canonicalBkkTime: '2026-09-07 07:55:00',
      inOutMode: 0,
      suffix: 'in1',
    });
    await insertRawScanForPerson({
      personId: PERSON_MON_FRI,
      fingleId: '99101',
      canonicalBkkTime: '2026-09-07 16:05:00',
      inOutMode: 1,
      suffix: 'out1',
    });

    const summary = await reprocessAttendanceRange({
      dateFrom: '2026-09-07',
      dateTo: '2026-09-07',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-08 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    assert.equal(summary.totalProcessed, 1);

    const attRows = await dbQuery<any>(
      `SELECT shift_code, attendance_status, status, late_minutes
       FROM attendance
       WHERE person_id = ? AND work_date = '2026-09-07'`,
      [PERSON_MON_FRI]
    );
    assert.equal(attRows.length, 1);
    assert.equal(attRows[0].shift_code, 'PTD-OFF-0816');
    assert.equal(attRows[0].attendance_status, 'COMPLETE');
    assert.equal(Number(attRows[0].late_minutes), 0);

    // Verify same shift template is bound to BOTH PTD_MON_FRI and PTD_MON_SAT
    const bindings = await dbQuery<any>(
      `SELECT personnel_type_code FROM personnel_type_default_shifts WHERE shift_id = ? ORDER BY personnel_type_code ASC`,
      [shiftOfficeId]
    );
    assert.deepEqual(
      bindings.map((b) => b.personnel_type_code),
      ['PTD_MON_FRI', 'PTD_MON_SAT']
    );
  });

  test('PTD-02: Personnel type WITHOUT Default Shift displays "ยังไม่กำหนดกะ" and NEVER generates NO_SCAN or LATE', async () => {
    // 2026-09-07 is Monday — PERSON_NO_DEFAULT has no individual shift and no default shift
    const cellRes = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_NO_DEFAULT}&workDate=2026-09-07`,
      { token: adminToken }
    );
    assert.equal(cellRes.status, 200);
    assert.equal(cellRes.data.effectiveState, 'UNCONFIGURED_DEFAULT_RULE');
    assert.ok(String(cellRes.data.unconfiguredMessage || '').includes('ยังไม่กำหนดกะ'));

    const summary = await reprocessAttendanceRange({
      dateFrom: '2026-09-07',
      dateTo: '2026-09-07',
      personId: PERSON_NO_DEFAULT,
      referenceNowBkk: '2026-09-08 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    assert.equal(summary.totalProcessed, 0);

    const attRows = await dbQuery<any>(
      `SELECT * FROM attendance WHERE person_id = ? AND work_date = '2026-09-07'`,
      [PERSON_NO_DEFAULT]
    );
    assert.equal(attRows.length, 0);
  });

  test('PTD-03: Different working days (Mon–Fri vs Mon–Sat) enforce default_workdays strictly', async () => {
    // 2026-09-12 is Saturday, 2026-09-13 is Sunday
    const satMonFriCell = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_MON_FRI}&workDate=2026-09-12`,
      { token: adminToken }
    );
    assert.equal(satMonFriCell.status, 200);
    assert.equal(satMonFriCell.data.effectiveState, 'NON_WORKING_DAY');

    const satMonSatCell = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_MON_SAT}&workDate=2026-09-12`,
      { token: adminToken }
    );
    assert.equal(satMonSatCell.status, 200);
    assert.equal(satMonSatCell.data.effectiveState, 'DEFAULT_FROM_TYPE');

    const sunMonSatCell = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_MON_SAT}&workDate=2026-09-13`,
      { token: adminToken }
    );
    assert.equal(sunMonSatCell.status, 200);
    assert.equal(sunMonSatCell.data.effectiveState, 'NON_WORKING_DAY');

    // Reprocess Saturday for both: Mon-Fri gets 0 attendance rows (no false NO_SCAN), Mon-Sat gets 1 shift
    await reprocessAttendanceRange({
      dateFrom: '2026-09-12',
      dateTo: '2026-09-13',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-15 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    const monFriWeekendAtt = await dbQuery<any>(
      `SELECT * FROM attendance WHERE person_id = ? AND work_date IN ('2026-09-12', '2026-09-13')`,
      [PERSON_MON_FRI]
    );
    assert.equal(monFriWeekendAtt.length, 0);

    await insertRawScanForPerson({
      personId: PERSON_MON_SAT,
      fingleId: '99102',
      canonicalBkkTime: '2026-09-12 07:58:00',
      inOutMode: 0,
      suffix: 'sat_in',
    });
    await insertRawScanForPerson({
      personId: PERSON_MON_SAT,
      fingleId: '99102',
      canonicalBkkTime: '2026-09-12 16:02:00',
      inOutMode: 1,
      suffix: 'sat_out',
    });
    await reprocessAttendanceRange({
      dateFrom: '2026-09-12',
      dateTo: '2026-09-13',
      personId: PERSON_MON_SAT,
      referenceNowBkk: '2026-09-15 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    const monSatSatAtt = await dbQuery<any>(
      `SELECT work_date, shift_code, attendance_status FROM attendance WHERE person_id = ? AND work_date IN ('2026-09-12', '2026-09-13')`,
      [PERSON_MON_SAT]
    );
    assert.equal(monSatSatAtt.length, 1);
    assert.equal(String(monSatSatAtt[0].work_date).slice(0, 10), '2026-09-12');
    assert.equal(monSatSatAtt[0].shift_code, 'PTD-OFF-0816');
    assert.equal(monSatSatAtt[0].attendance_status, 'COMPLETE');
  });

  test('PTD-04: Individual roster overrides Default Shift (Priority 1), including on weekend', async () => {
    // Assign afternoon shift on Monday 2026-09-08 AND on Saturday 2026-09-19 for PERSON_MON_FRI
    const assignRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: [PERSON_MON_FRI],
        shiftIds: [shiftAfternoonId],
        workDates: ['2026-09-08', '2026-09-19'],
        operationMode: 'REPLACE_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(assignRes.status, 201);

    await insertRawScanForPerson({
      personId: PERSON_MON_FRI,
      fingleId: '99101',
      canonicalBkkTime: '2026-09-08 15:52:00',
      inOutMode: 0,
      suffix: 'ov_in',
    });
    await insertRawScanForPerson({
      personId: PERSON_MON_FRI,
      fingleId: '99101',
      canonicalBkkTime: '2026-09-09 00:04:00',
      inOutMode: 1,
      suffix: 'ov_out',
    });
    await insertRawScanForPerson({
      personId: PERSON_MON_FRI,
      fingleId: '99101',
      canonicalBkkTime: '2026-09-19 15:55:00',
      inOutMode: 0,
      suffix: 'wknd_in',
    });
    await insertRawScanForPerson({
      personId: PERSON_MON_FRI,
      fingleId: '99101',
      canonicalBkkTime: '2026-09-20 00:03:00',
      inOutMode: 1,
      suffix: 'wknd_out',
    });

    await reprocessAttendanceRange({
      dateFrom: '2026-09-08',
      dateTo: '2026-09-08',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-21 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    await reprocessAttendanceRange({
      dateFrom: '2026-09-19',
      dateTo: '2026-09-19',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-21 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const rows = await dbQuery<any>(
      `SELECT work_date, shift_code, attendance_status
       FROM attendance
       WHERE person_id = ? AND work_date IN ('2026-09-08', '2026-09-19')
       ORDER BY work_date ASC`,
      [PERSON_MON_FRI]
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0].shift_code, 'PTD-AFT-1600');
    assert.equal(rows[0].attendance_status, 'COMPLETE');
    assert.equal(rows[1].shift_code, 'PTD-AFT-1600');
    assert.equal(rows[1].attendance_status, 'COMPLETE');
  });

  test('PTD-05: Multiple shifts in 1 day (Morning + Afternoon) are all preserved without Default interference', async () => {
    // 2026-09-09 (Wednesday) — assign 2 shifts to PERSON_NO_DEFAULT
    const assignMulti = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: [PERSON_NO_DEFAULT],
        shiftIds: [shiftOfficeId, shiftAfternoonId],
        workDates: ['2026-09-09'],
        operationMode: 'REPLACE_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(assignMulti.status, 201);
    assert.equal(assignMulti.data.insertedCount, 2);

    await insertRawScanForPerson({
      personId: PERSON_NO_DEFAULT,
      fingleId: '99103',
      canonicalBkkTime: '2026-09-09 07:55:00',
      inOutMode: 0,
      suffix: 'm1_in',
    });
    await insertRawScanForPerson({
      personId: PERSON_NO_DEFAULT,
      fingleId: '99103',
      canonicalBkkTime: '2026-09-09 15:58:00',
      inOutMode: 1,
      suffix: 'm1_out',
    });
    await insertRawScanForPerson({
      personId: PERSON_NO_DEFAULT,
      fingleId: '99103',
      canonicalBkkTime: '2026-09-09 16:02:00',
      inOutMode: 0,
      suffix: 'm2_in',
    });
    await insertRawScanForPerson({
      personId: PERSON_NO_DEFAULT,
      fingleId: '99103',
      canonicalBkkTime: '2026-09-10 00:05:00',
      inOutMode: 1,
      suffix: 'm2_out',
    });

    await reprocessAttendanceRange({
      dateFrom: '2026-09-09',
      dateTo: '2026-09-09',
      personId: PERSON_NO_DEFAULT,
      referenceNowBkk: '2026-09-11 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const multiAtt = await dbQuery<any>(
      `SELECT shift_code, attendance_status FROM attendance WHERE person_id = ? AND work_date = '2026-09-09' ORDER BY shift_code ASC`,
      [PERSON_NO_DEFAULT]
    );
    assert.equal(multiAtt.length, 2);
    assert.deepEqual(
      multiAtt.map((r) => r.shift_code),
      ['PTD-AFT-1600', 'PTD-OFF-0816']
    );
    assert.equal(multiAtt[0].attendance_status, 'COMPLETE');
    assert.equal(multiAtt[1].attendance_status, 'COMPLETE');
  });

  test('PTD-06: Public Holiday suppresses Default Shift (no NO_SCAN/LATE), while individual roster on holiday still applies', async () => {
    // 2026-09-10 is Thursday -> register as Public Holiday via API
    const holRes = await apiCall('/api/Sam_Att/holidays', {
      method: 'POST',
      token: adminToken,
      body: {
        holidayDate: '2026-09-10',
        holidayName: 'วันหยุดราชการทดสอบ',
        holidayType: 'OFFICIAL',
      },
    });
    assert.equal(holRes.status, 201);

    // PERSON_MON_FRI has NO individual shift on 2026-09-10 -> MUST be PUBLIC_HOLIDAY, 0 attendance rows
    const cellHoliday = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_MON_FRI}&workDate=2026-09-10`,
      { token: adminToken }
    );
    assert.equal(cellHoliday.status, 200);
    assert.equal(cellHoliday.data.effectiveState, 'PUBLIC_HOLIDAY');

    // PERSON_MON_SAT has an individual roster on the same holiday -> Priority 1 MUST win!
    const assignHol = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: staffToken,
      body: {
        personIds: [PERSON_MON_SAT],
        shiftIds: [shiftAltId],
        workDates: ['2026-09-10'],
        operationMode: 'REPLACE_SHIFTS',
        confirmAction: true,
      },
    });
    assert.equal(assignHol.status, 201);

    await insertRawScanForPerson({
      personId: PERSON_MON_SAT,
      fingleId: '99102',
      canonicalBkkTime: '2026-09-10 08:25:00',
      inOutMode: 0,
      suffix: 'hol_in',
    });
    await insertRawScanForPerson({
      personId: PERSON_MON_SAT,
      fingleId: '99102',
      canonicalBkkTime: '2026-09-10 16:35:00',
      inOutMode: 1,
      suffix: 'hol_out',
    });

    await reprocessAttendanceRange({
      dateFrom: '2026-09-10',
      dateTo: '2026-09-10',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-12 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    await reprocessAttendanceRange({
      dateFrom: '2026-09-10',
      dateTo: '2026-09-10',
      personId: PERSON_MON_SAT,
      referenceNowBkk: '2026-09-12 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const holAttNone = await dbQuery<any>(
      `SELECT * FROM attendance WHERE person_id = ? AND work_date = '2026-09-10'`,
      [PERSON_MON_FRI]
    );
    assert.equal(holAttNone.length, 0);

    const holAttCustom = await dbQuery<any>(
      `SELECT shift_code, attendance_status FROM attendance WHERE person_id = ? AND work_date = '2026-09-10'`,
      [PERSON_MON_SAT]
    );
    assert.equal(holAttCustom.length, 1);
    assert.equal(holAttCustom[0].shift_code, 'PTD-ALT-0830');
    assert.equal(holAttCustom[0].attendance_status, 'COMPLETE');
  });

  test('PTD-07: Personal Holiday (PERSONAL_HOLIDAY override & full-day leave) suppresses Default Shift', async () => {
    // Case A: PERSONAL_HOLIDAY in shift_daily_overrides on Friday 2026-09-11
    await dbExecute(
      `INSERT INTO shift_daily_overrides (person_id, work_date, override_state, reason, updated_by)
       VALUES (?, '2026-09-11', 'PERSONAL_HOLIDAY', 'วันหยุดพักผ่อนเฉพาะบุคคล', 'hrstaff')`,
      [PERSON_MON_FRI]
    );

    // Case B: Full-day leave in attendance_leaves on Monday 2026-09-14
    await dbExecute(
      `INSERT INTO attendance_leaves (
        person_id, work_date, shift_assignment_id, leave_type,
        leave_start_time, leave_end_time, reason, status, created_by
      ) VALUES (?, '2026-09-14', NULL, 'FULL_DAY', '08:00', '16:00', 'ลาพักผ่อนเต็มวัน', 'ACTIVE', 'hrstaff')`,
      [PERSON_MON_FRI]
    );

    const cellPersonalA = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_MON_FRI}&workDate=2026-09-11`,
      { token: adminToken }
    );
    assert.equal(cellPersonalA.status, 200);
    assert.equal(cellPersonalA.data.effectiveState, 'PERSONAL_HOLIDAY');

    const cellPersonalB = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=${PERSON_MON_FRI}&workDate=2026-09-14`,
      { token: adminToken }
    );
    assert.equal(cellPersonalB.status, 200);
    assert.equal(cellPersonalB.data.effectiveState, 'PERSONAL_HOLIDAY');

    await reprocessAttendanceRange({
      dateFrom: '2026-09-11',
      dateTo: '2026-09-14',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-20 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const attPersonal = await dbQuery<any>(
      `SELECT * FROM attendance WHERE person_id = ? AND work_date IN ('2026-09-11', '2026-09-14')`,
      [PERSON_MON_FRI]
    );
    assert.equal(attPersonal.length, 0);
  });

  test('PTD-08: Shift Cancellation (CLEARED_ALL_SHIFTS) suppresses Default Shift completely', async () => {
    // Clear Tuesday 2026-09-15 via daily-cell-action
    const clearRes = await apiCall('/api/Sam_Att/shift-assignments/daily-cell-action', {
      method: 'POST',
      token: staffToken,
      body: {
        personId: PERSON_MON_FRI,
        workDate: '2026-09-15',
        action: 'CLEAR_ALL_SHIFTS',
        reason: 'ยกเลิกเวรประจำวันเนื่องจากไปราชการต่างจังหวัด',
      },
    });
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.data.effectiveSchedule.state, 'CLEARED_ALL_SHIFTS');

    await reprocessAttendanceRange({
      dateFrom: '2026-09-15',
      dateTo: '2026-09-15',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-20 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const attCleared = await dbQuery<any>(
      `SELECT * FROM attendance WHERE person_id = ? AND work_date = '2026-09-15'`,
      [PERSON_MON_FRI]
    );
    assert.equal(attCleared.length, 0);
  });

  test('PTD-09: Changing Default Shift logs actor & timestamp, preserves old template, past shift_assignments, and already-processed attendance (with RBAC check)', async () => {
    // Unauthorized viewer cannot change Default Shift
    const forbiddenRes = await apiCall(`/api/Sam_Att/personnel-type-rules/${ruleMonFriId}`, {
      method: 'PUT',
      token: viewerToken,
      body: {
        personnelTypeName: 'กลุ่มสำนักงาน (จ.–ศ.)',
        defaultShiftId: shiftAltId,
        defaultWorkdays: '1,2,3,4,5',
        effectiveFrom: '2026-01-01',
        reason: 'unauthorized attempt',
      },
    });
    assert.equal(forbiddenRes.status, 403);

    // Snapshot past shift_assignments & processed attendance BEFORE change
    const beforePastAtt = await dbQuery<any>(
      `SELECT id, shift_code, attendance_status, calculated_at FROM attendance WHERE person_id = ? AND work_date = '2026-09-07'`,
      [PERSON_MON_FRI]
    );
    assert.equal(beforePastAtt.length, 1);
    assert.equal(beforePastAtt[0].shift_code, 'PTD-OFF-0816');

    const beforePastAssign = await dbQuery<any>(
      `SELECT id, shift_id, snapshot_shift_code FROM shift_assignments WHERE person_id = ? AND work_date = '2026-09-08' AND status = 'ACTIVE'`,
      [PERSON_MON_FRI]
    );
    assert.equal(beforePastAssign.length, 1);

    // Authorized RESPONSIBLE_STAFF changes PTD_MON_FRI default shift from PTD-OFF-0816 -> PTD-ALT-0830
    const changeRes = await apiCall(`/api/Sam_Att/personnel-type-rules/${ruleMonFriId}`, {
      method: 'PUT',
      token: staffToken,
      body: {
        personnelTypeName: 'กลุ่มสำนักงาน (จ.–ศ.)',
        defaultShiftId: shiftAltId,
        defaultWorkdays: '1,2,3,4,5',
        effectiveFrom: '2026-01-01',
        reason: 'ปรับกะเริ่มต้นสำนักงานเป็น 08:30–16:30',
        isActive: true,
      },
    });
    assert.equal(changeRes.status, 200);

    // 1. Old shift template MUST still exist and remain active
    const oldShiftRows = await dbQuery<any>(`SELECT id, is_active FROM shifts WHERE id = ?`, [
      shiftOfficeId,
    ]);
    assert.equal(oldShiftRows.length, 1);
    assert.equal(Number(oldShiftRows[0].is_active), 1);

    // 2. Past shift_assignments MUST be completely untouched
    const afterPastAssign = await dbQuery<any>(
      `SELECT id, shift_id, snapshot_shift_code FROM shift_assignments WHERE person_id = ? AND work_date = '2026-09-08' AND status = 'ACTIVE'`,
      [PERSON_MON_FRI]
    );
    assert.deepEqual(afterPastAssign, beforePastAssign);

    // 3. Already-processed attendance MUST NOT be auto-mutated
    const afterPastAtt = await dbQuery<any>(
      `SELECT id, shift_code, attendance_status, calculated_at FROM attendance WHERE person_id = ? AND work_date = '2026-09-07'`,
      [PERSON_MON_FRI]
    );
    assert.deepEqual(afterPastAtt, beforePastAtt);

    // 4. Actor & timestamp recorded in personnel_type_default_shifts, history, and audit_logs
    const bindingRows = await dbQuery<any>(
      `SELECT shift_id, assigned_by, updated_at FROM personnel_type_default_shifts WHERE personnel_type_code = 'PTD_MON_FRI'`
    );
    assert.equal(bindingRows.length, 1);
    assert.equal(Number(bindingRows[0].shift_id), shiftAltId);
    assert.equal(bindingRows[0].assigned_by, 'hrstaff');
    assert.ok(bindingRows[0].updated_at);

    const histRows = await dbQuery<any>(
      `SELECT changed_by, changed_at, action_type, default_workdays FROM personnel_type_rule_history WHERE personnel_type_code = 'PTD_MON_FRI' ORDER BY id DESC LIMIT 1`
    );
    assert.equal(histRows.length, 1);
    assert.equal(histRows[0].changed_by, 'hrstaff');
    assert.ok(histRows[0].changed_at);
    assert.equal(histRows[0].default_workdays, '1,2,3,4,5');

    const auditRows = await dbQuery<any>(
      `SELECT actor_username, action, target_type, created_at
       FROM audit_logs
       WHERE action = 'DEFAULT_SHIFT_CHANGED' AND target_type = 'PERSONNEL_TYPE_RULE'
       ORDER BY id DESC LIMIT 1`
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].actor_username, 'hrstaff');
    assert.ok(auditRows[0].created_at);
  });

  test('PTD-10: Authorized historical Reprocess updates attendance to new Default Shift only when explicitly triggered', async () => {
    // Unauthorized viewer cannot trigger Reprocess
    const deniedReproc = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: viewerToken,
      body: {
        dateFrom: '2026-09-07',
        dateTo: '2026-09-07',
        personId: PERSON_MON_FRI,
      },
    });
    assert.equal(deniedReproc.status, 403);

    // Authorized Admin runs Reprocess for 2026-09-07
    const reprocRes = await apiCall('/api/Sam_Att/attendance/reprocess', {
      method: 'POST',
      token: adminToken,
      body: {
        dateFrom: '2026-09-07',
        dateTo: '2026-09-07',
        personId: PERSON_MON_FRI,
      },
    });
    assert.equal(reprocRes.status, 200);

    const updatedAtt = await dbQuery<any>(
      `SELECT shift_code, attendance_status FROM attendance WHERE person_id = ? AND work_date = '2026-09-07'`,
      [PERSON_MON_FRI]
    );
    assert.equal(updatedAtt.length, 1);
    assert.equal(updatedAtt[0].shift_code, 'PTD-ALT-0830');
    assert.equal(updatedAtt[0].attendance_status, 'COMPLETE');
  });

  test('PTD-11: Zero false NO_SCAN or LATE across holidays, non-working days, cleared days, and unconfigured personnel type', async () => {
    // Reprocess full week 2026-09-10..2026-09-15 for PERSON_MON_FRI (all are holiday / personal holiday / weekend / cleared)
    // and for PERSON_NO_DEFAULT (no default shift on any of those days)
    await reprocessAttendanceRange({
      dateFrom: '2026-09-10',
      dateTo: '2026-09-15',
      personId: PERSON_MON_FRI,
      referenceNowBkk: '2026-09-25 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });
    await reprocessAttendanceRange({
      dateFrom: '2026-09-10',
      dateTo: '2026-09-15',
      personId: PERSON_NO_DEFAULT,
      referenceNowBkk: '2026-09-25 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const badStatuses = await dbQuery<any>(
      `SELECT person_id, work_date, attendance_status, status
       FROM attendance
       WHERE person_id IN (?, ?)
         AND work_date >= '2026-09-10' AND work_date <= '2026-09-15'
         AND (attendance_status IN ('NO_SCAN', 'LATE') OR status IN ('NO_SCAN', 'LATE'))`,
      [PERSON_MON_FRI, PERSON_NO_DEFAULT]
    );
    assert.equal(badStatuses.length, 0);
  });

  test('PTD-12: Zero mutation to raw_scans + Migration 005 parses & verifies cleanly', async () => {
    const rawBefore = await dbQuery<any>(
      `SELECT id, machine_no, enroll_number, canonical_bkk_time, in_out_mode, event_dedup_key
       FROM raw_scans
       WHERE machine_no = 99
       ORDER BY id ASC`
    );
    assert.ok(rawBefore.length >= 10);

    // Clear default shift on PTD_MON_SAT (set to null) and reprocess -> raw_scans MUST stay 100% identical
    const clearDefaultRes = await apiCall(`/api/Sam_Att/personnel-type-rules/${ruleMonSatId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        personnelTypeName: 'กลุ่มคลินิก (จ.–ส.)',
        defaultShiftId: null,
        effectiveFrom: '2026-01-01',
        reason: 'ทดสอบตั้งเป็นไม่กำหนดกะเริ่มต้น',
        isActive: true,
      },
    });
    assert.equal(clearDefaultRes.status, 200);

    await reprocessAttendanceRange({
      dateFrom: '2026-09-07',
      dateTo: '2026-09-19',
      personId: PERSON_MON_SAT,
      referenceNowBkk: '2026-09-25 12:00:00',
      actorUsername: 'admin',
      actorRole: 'ADMIN',
    });

    const rawAfter = await dbQuery<any>(
      `SELECT id, machine_no, enroll_number, canonical_bkk_time, in_out_mode, event_dedup_key
       FROM raw_scans
       WHERE machine_no = 99
       ORDER BY id ASC`
    );
    assert.deepEqual(rawAfter, rawBefore);

    // Verify Migration 005 SQL file parsing and post-apply schema check
    const migPath = path.resolve(
      process.cwd(),
      'database/migrations/005_default_shift_by_personnel_type.sql'
    );
    const parsed = parseMigrationSqlFile(migPath, '005_default_shift_by_personnel_type.sql');
    assert.equal(parsed.hasDestructiveStatements, false);
    assert.ok(parsed.tablesCreated.includes('public_holidays'));
    const verify = await verifyMigrationSchemaPostApply([parsed]);
    assert.equal(verify.ok, true, `Migration 005 verification errors: ${verify.errors.join('; ')}`);

    // Suppress unused variable warning for ruleNoDefaultId
    assert.ok(ruleNoDefaultId > 0);
  });
});
