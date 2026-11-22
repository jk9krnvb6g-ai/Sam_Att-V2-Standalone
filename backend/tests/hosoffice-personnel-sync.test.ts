/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: HOSOffice Personnel Sync (HR_STATUS_ID = '01' & Safe Status Verification)
 * ไฟล์: backend/tests/hosoffice-personnel-sync.test.ts
 * ============================================================================
 * ครอบคลุมข้อกำหนดทั้งหมด:
 * - HOS-01: SQL อ่านจาก hosoffice.hr_person แบบ Read-Only โดยใช้ WHERE HR_STATUS_ID = '01',
 *           ตรวจ External Contract คอลัมน์ HR_STATUS_ID และ Parameterized Status Verification SQL
 * - HOS-02: การคัดกรอง HR_STATUS_ID = '01', '02', NULL, '' และการรักษา PERSON_ID / FINGLE_ID
 * - HOS-03: บุคลากรที่เคยซิงก์แล้วเปลี่ยนสถานะจาก '01' -> '02' และ '01' -> NULL:
 *           ปรับเฉพาะ personnel.is_active = 0 อย่างปลอดภัย โดยไม่ลบ/แก้ไข Raw Scan,
 *           Fingerprint Mapping History, Attendance, Leave, Notes หรือ Push History
 *           และการคืนสถานะเมื่อกลับเป็น '01'
 * - HOS-04: กฎความปลอดภัย — ห้ามปรับบุคลากรที่หายจากผล Query เป็น Inactive ทันที
 *           หากยังไม่ได้ตรวจสอบสถานะต้นทางจริง (ทั้งกรณีไม่พบในต้นทางและกรณี Query ตรวจสอบล้มเหลว)
 * - HOS-05: การตรวจรหัสสแกนซ้ำ (DUPLICATE_FINGLE_ID) พิจารณาเฉพาะบุคลากรสถานะ '01' เท่านั้น
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
  `sam_att_hosoffice_sync_${process.pid}_${Date.now()}.sqlite`
);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_FILE;
process.env.DEMO_MODE_ENABLED = 'true';
process.env.JWT_SECRET = 'sam-att-hosoffice-sync-test-secret-key-2026';
process.env.SCANNER_SYNC_ENABLED = 'false';
process.env.SCANNER_AUTO_SCHEDULER_ENABLED = 'false';
process.env.HOSOFFICE_DB_HOST = 'CHANGE_ME';
process.env.HOSOFFICE_DB_PASSWORD = 'CHANGE_ME';

import { createExpressApp } from '../src/app.ts';
import {
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
  dbQuery,
  dbExecute,
} from '../src/database/adapter.ts';
import {
  ACTIVE_HR_STATUS_ID,
  buildActiveHrPersonSelectSql,
  buildVerifyHrStatusSelectSql,
  fetchFromHosOfficeReadOnly,
  isActiveHrStatusId,
  normalizeHosOfficeRow,
  resolveHosOfficeHrPersonMeta,
  setHosOfficeSchemaColumnsForTests,
  setHosOfficeTestDouble,
  type HosOfficeHrPersonRow,
} from '../src/modules/personnel/routes.ts';
import { ingestSixFieldEventsBatch } from '../src/modules/scanners/routes.ts';

let server: http.Server;
let baseUrl = '';
let adminToken = '';
let staffToken = '';

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

function makeHosRow(
  overrides: Partial<HosOfficeHrPersonRow> & { PERSON_ID: string; FIRST_NAME: string; LAST_NAME: string }
): HosOfficeHrPersonRow {
  return {
    FINGLE_ID: null,
    TITLE_NAME: 'นางสาว',
    POSITION_NAME: 'พยาบาลวิชาชีพ',
    DEPARTMENT_CODE: 'DEP-NUR',
    DEPARTMENT_NAME: 'กลุ่มงานการพยาบาล',
    WORK_GROUP_NAME: 'หอผู้ป่วยใน',
    PERSONNEL_TYPE_CODE: 'CIVIL_SERVANT',
    PERSONNEL_TYPE_NAME: 'ข้าราชการ',
    IS_ACTIVE: 1,
    HR_STATUS_ID: '01',
    ...overrides,
  };
}

describe('HOSOffice Personnel Sync — HR_STATUS_ID = 01, Safe Verification & History Preservation (HOS-01..HOS-05)', () => {
  before(async () => {
    resetSqliteInstanceForTests(TEST_DB_FILE);
    await runMigrations();
    await seedBaselineAndSyntheticData();
    const app = createExpressApp();
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;

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
  });

  after(async () => {
    setHosOfficeTestDouble(null);
    setHosOfficeSchemaColumnsForTests(null);
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    resetSqliteInstanceForTests();
    for (const suffix of ['', '-wal', '-shm']) {
      const f = `${TEST_DB_FILE}${suffix}`;
      if (fs.existsSync(f)) {
        try {
          fs.unlinkSync(f);
        } catch {
          // ignore cleanup failure on test db
        }
      }
    }
  });

  test('HOS-01: Read-Only SQL uses WHERE HR_STATUS_ID = 01, parameterized status check & HR_STATUS_ID contract guard', async () => {
    assert.equal(ACTIVE_HR_STATUS_ID, '01');

    // 1. Active personnel query MUST use WHERE HR_STATUS_ID = '01' and be strictly Read-Only SELECT
    const activeSql = buildActiveHrPersonSelectSql('hr_person');
    assert.equal(activeSql, "SELECT * FROM hr_person WHERE HR_STATUS_ID = '01'");
    assert.equal(/^\s*SELECT\b/i.test(activeSql), true);
    assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(activeSql), false);

    // 2. Source status verification query MUST be parameterized Read-Only SELECT
    const verifySql = buildVerifyHrStatusSelectSql('hr_person', 'PERSON_ID', 3);
    assert.equal(
      verifySql,
      'SELECT PERSON_ID AS PERSON_ID, HR_STATUS_ID FROM hr_person WHERE PERSON_ID IN (?, ?, ?)'
    );
    assert.equal(/^\s*SELECT\b/i.test(verifySql), true);
    assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i.test(verifySql), false);

    // Rejects unauthorized column names (SQL injection defense)
    assert.throws(() => buildVerifyHrStatusSelectSql('hr_person', '1=1; DROP TABLE hr_person', 1));

    // 3. normalizeHosOfficeRow handles HR_STATUS_ID = '01', '02', NULL, '' accurately
    assert.equal(isActiveHrStatusId('01'), true);
    assert.equal(isActiveHrStatusId(' 01 '), true);
    assert.equal(isActiveHrStatusId('02'), false);
    assert.equal(isActiveHrStatusId(null), false);
    assert.equal(isActiveHrStatusId(''), false);

    const row01 = normalizeHosOfficeRow({
      PERSON_ID: 'N1',
      FINGLE_ID: '501',
      HR_FNAME: 'สมหมาย',
      HR_LNAME: 'ทำงานปกติ',
      HR_STATUS_ID: '01',
    });
    assert.equal(row01.HR_STATUS_ID, '01');
    assert.equal(row01.IS_ACTIVE, 1);

    const row02 = normalizeHosOfficeRow({
      PERSON_ID: 'N2',
      FINGLE_ID: '502',
      HR_FNAME: 'สมปอง',
      HR_LNAME: 'ลาออกแล้ว',
      HR_STATUS_ID: '02',
    });
    assert.equal(row02.HR_STATUS_ID, '02');
    assert.equal(row02.IS_ACTIVE, 0);

    const rowNull = normalizeHosOfficeRow({
      PERSON_ID: 'N3',
      FINGLE_ID: '503',
      HR_FNAME: 'สมศรี',
      HR_LNAME: 'ไม่มีสถานะ',
      HR_STATUS_ID: null,
    });
    assert.equal(rowNull.HR_STATUS_ID, null);
    assert.equal(rowNull.IS_ACTIVE, 0);

    // 4. Schema contract rejects hr_person without HR_STATUS_ID column before touching DB
    const metaMissing = resolveHosOfficeHrPersonMeta(['PERSON_ID', 'FINGLE_ID', 'FIRST_NAME', 'LAST_NAME']);
    assert.equal(metaMissing.hasHrStatusIdColumn, false);
    const metaValid = resolveHosOfficeHrPersonMeta([
      'ID',
      'FINGLE_ID',
      'HR_FNAME',
      'HR_LNAME',
      'HR_STATUS_ID',
    ]);
    assert.equal(metaValid.hasHrStatusIdColumn, true);
    assert.equal(metaValid.personIdColumn, 'ID');

    setHosOfficeSchemaColumnsForTests(['PERSON_ID', 'FINGLE_ID', 'FIRST_NAME', 'LAST_NAME']);
    try {
      await assert.rejects(
        () => fetchFromHosOfficeReadOnly([]),
        (err: unknown) =>
          (err as { code?: string })?.code === 'BLOCKED_BY_EXTERNAL_CONTRACT' &&
          String((err as Error)?.message || '').includes('HR_STATUS_ID')
      );
    } finally {
      setHosOfficeSchemaColumnsForTests(null);
    }
  });

  test('HOS-02: Only HR_STATUS_ID = 01 is synced into Sam_Att; 02, NULL, and blank are excluded while PERSON_ID/FINGLE_ID mapping stays valid', async () => {
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P01',
        FINGLE_ID: '7101',
        FIRST_NAME: 'อัมพร',
        LAST_NAME: 'สถานะปกติ',
        HR_STATUS_ID: '01',
        IS_ACTIVE: 1,
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P02',
        FINGLE_ID: '7102',
        FIRST_NAME: 'ประเสริฐ',
        LAST_NAME: 'สถานะศูนย์สอง',
        HR_STATUS_ID: '02',
        IS_ACTIVE: 0,
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P03',
        FINGLE_ID: '7103',
        FIRST_NAME: 'วิภา',
        LAST_NAME: 'สถานะว่างนัล',
        HR_STATUS_ID: null,
        IS_ACTIVE: 0,
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P04',
        FINGLE_ID: '7104',
        FIRST_NAME: 'สุชาติ',
        LAST_NAME: 'สถานะว่างเปล่า',
        HR_STATUS_ID: '',
        IS_ACTIVE: 0,
      }),
    ]);

    try {
      const syncRes = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: staffToken,
        body: { effectiveDate: '2026-11-20' },
      });
      assert.equal(syncRes.status, 200);
      assert.equal(syncRes.data.hrStatusFilter, '01');
      assert.equal(syncRes.data.recordsFetched, 1);
      assert.equal(syncRes.data.recordsUpserted, 1);
      assert.equal(syncRes.data.deactivatedCount, 0);

      const synced = await dbQuery<{
        person_id: string;
        fingle_id: string;
        is_active: number;
        mapping_status: string;
      }>("SELECT person_id, fingle_id, is_active, mapping_status FROM personnel WHERE person_id LIKE 'HOS-P0%' ORDER BY person_id");

      assert.equal(synced.length, 1);
      assert.equal(synced[0].person_id, 'HOS-P01');
      assert.equal(synced[0].fingle_id, '7101');
      assert.equal(Number(synced[0].is_active), 1);
      assert.equal(synced[0].mapping_status, 'VALID');

      const mapRows = await dbQuery<{ person_id: string; fingle_id: string; effective_from: string; effective_to: string | null }>(
        "SELECT person_id, fingle_id, effective_from, effective_to FROM fingerprint_mappings WHERE person_id LIKE 'HOS-P0%'"
      );
      assert.equal(mapRows.length, 1);
      assert.equal(mapRows[0].person_id, 'HOS-P01');
      assert.equal(mapRows[0].fingle_id, '7101');
      assert.equal(mapRows[0].effective_from, '2026-11-20');
      assert.equal(mapRows[0].effective_to, null);
    } finally {
      setHosOfficeTestDouble(null);
    }
  });

  test('HOS-03: Previously-synced personnel changing 01 -> 02 and 01 -> NULL safely become inactive WITHOUT mutating or deleting any history, and reactivate if back to 01', async () => {
    // 1. Initial sync with HOS-P10 & HOS-P11 as HR_STATUS_ID = '01'
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P10',
        FINGLE_ID: '7210',
        FIRST_NAME: 'กานดา',
        LAST_NAME: 'เปลี่ยนเป็นศูนย์สอง',
        HR_STATUS_ID: '01',
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P11',
        FINGLE_ID: '7211',
        FIRST_NAME: 'ปิยะ',
        LAST_NAME: 'เปลี่ยนเป็นนัล',
        HR_STATUS_ID: '01',
      }),
    ]);

    try {
      const initialSync = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-18' },
      });
      assert.equal(initialSync.status, 200);
      assert.equal(initialSync.data.recordsUpserted, 2);
    } finally {
      setHosOfficeTestDouble(null);
    }

    // 2. Seed rich history for HOS-P10 across Raw Scan, Fingerprint Mapping, Shift/Attendance, Leave, Notes, Push History
    const shiftRow = (
      await dbQuery<{
        id: number;
        shift_code: string;
        shift_name: string;
        start_time: string;
        end_time: string;
        grace_minutes: number;
        cutoff_time: string;
        is_cross_midnight: number;
      }>("SELECT * FROM shifts WHERE shift_code = 'MOR-0816' LIMIT 1")
    )[0];
    assert.ok(shiftRow);

    const saIns = await dbExecute(
      `INSERT INTO shift_assignments (
        person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
        snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
        snapshot_is_cross_midnight, status, assigned_by
      ) VALUES ('HOS-P10', ?, '2026-11-18', ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'admin')`,
      [
        shiftRow.id,
        shiftRow.shift_code,
        shiftRow.shift_name,
        shiftRow.start_time,
        shiftRow.end_time,
        shiftRow.grace_minutes,
        shiftRow.cutoff_time,
        shiftRow.is_cross_midnight,
      ]
    );
    assert.ok(saIns.insertId);

    // Ingest raw scans (automatically resolves raw_scan_mappings and creates attendance)
    await ingestSixFieldEventsBatch(
      [
        { machineNo: 1, enrollNumber: '7210', scanDateTime: '2026-11-18 07:55:00', verifyMode: 1, inOutMode: 0, workCode: 0 },
        { machineNo: 1, enrollNumber: '7210', scanDateTime: '2026-11-18 16:05:00', verifyMode: 1, inOutMode: 1, workCode: 0 },
      ],
      'JSON_INGEST',
      'admin',
      null
    );

    const attBefore = (
      await dbQuery<Record<string, unknown>>(
        "SELECT * FROM attendance WHERE person_id = 'HOS-P10' AND work_date = '2026-11-18'"
      )
    )[0];
    assert.ok(attBefore, 'Attendance row for HOS-P10 must exist before status transition');

    await dbExecute(
      `INSERT INTO attendance_leaves (
        person_id, work_date, shift_assignment_id, leave_type, leave_start_time, leave_end_time, reason, status, created_by
      ) VALUES ('HOS-P10', '2026-11-19', NULL, 'PERSONAL_LEAVE', '08:00', '16:00', 'ลากิจประวัติเดิม', 'ACTIVE', 'hrstaff')`
    );

    await dbExecute(
      `INSERT INTO attendance_notes (
        attendance_id, person_id, work_date, reason_type, note_text, visible_to_employee, created_by
      ) VALUES (?, 'HOS-P10', '2026-11-18', 'HR_NOTE', 'หมายเหตุเดิมต้องไม่หาย', 1, 'hrstaff')`,
      [attBefore.id]
    );

    await dbExecute(
      `INSERT INTO push_history (
        idempotency_key, push_mode, date_from, date_to, total_records, valid_records, invalid_records,
        status, payload_preview_json, initiated_by
      ) VALUES ('HOS-P10-PUSH-KEY-01', 'DRY_RUN', '2026-11-18', '2026-11-18', 1, 1, 0, 'SUCCESS', '[{"personId":"HOS-P10"}]', 'admin')`
    );

    // Snapshot all 6 history tables BEFORE status-change sync
    const snapRawScansBefore = await dbQuery("SELECT * FROM raw_scans WHERE enroll_number = '7210' ORDER BY id ASC");
    const snapFpMappingsBefore = await dbQuery(
      "SELECT * FROM fingerprint_mappings WHERE person_id IN ('HOS-P10', 'HOS-P11') ORDER BY id ASC"
    );
    const snapAttendanceBefore = await dbQuery("SELECT * FROM attendance WHERE person_id = 'HOS-P10' ORDER BY id ASC");
    const snapLeavesBefore = await dbQuery("SELECT * FROM attendance_leaves WHERE person_id = 'HOS-P10' ORDER BY id ASC");
    const snapNotesBefore = await dbQuery("SELECT * FROM attendance_notes WHERE person_id = 'HOS-P10' ORDER BY id ASC");
    const snapPushBefore = await dbQuery("SELECT * FROM push_history WHERE idempotency_key = 'HOS-P10-PUSH-KEY-01'");

    assert.equal(snapRawScansBefore.length, 2);
    assert.equal(snapFpMappingsBefore.length, 2);
    assert.ok(snapAttendanceBefore.length >= 1);
    assert.equal(snapLeavesBefore.length, 1);
    assert.equal(snapNotesBefore.length, 1);
    assert.equal(snapPushBefore.length, 1);

    // 3. Next HOSOffice sync: HOS-P10 changed to '02', HOS-P11 changed to NULL, HOS-P01 stays '01'
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P01',
        FINGLE_ID: '7101',
        FIRST_NAME: 'อัมพร',
        LAST_NAME: 'สถานะปกติ',
        HR_STATUS_ID: '01',
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P10',
        FINGLE_ID: '7210',
        FIRST_NAME: 'กานดา',
        LAST_NAME: 'เปลี่ยนเป็นศูนย์สอง',
        HR_STATUS_ID: '02',
        IS_ACTIVE: 0,
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P11',
        FINGLE_ID: '7211',
        FIRST_NAME: 'ปิยะ',
        LAST_NAME: 'เปลี่ยนเป็นนัล',
        HR_STATUS_ID: null,
        IS_ACTIVE: 0,
      }),
    ]);

    try {
      const changeSync = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-21' },
      });
      assert.equal(changeSync.status, 200);
      assert.equal(changeSync.data.recordsFetched, 1);
      assert.equal(changeSync.data.deactivatedCount, 2);
      assert.equal(changeSync.data.sourceVerificationExecuted, true);

      const deactivatedMap = new Map<string, string | null>(
        (changeSync.data.deactivatedPersonnel as Array<{ personId: string; verifiedHrStatusId: string | null }>).map(
          (d) => [d.personId, d.verifiedHrStatusId]
        )
      );
      assert.equal(deactivatedMap.get('HOS-P10'), '02');
      assert.equal(deactivatedMap.get('HOS-P11'), null);
    } finally {
      setHosOfficeTestDouble(null);
    }

    // Verify personnel rows still exist with is_active = 0 (NOT deleted)
    const afterStatus = await dbQuery<{ person_id: string; is_active: number }>(
      "SELECT person_id, is_active FROM personnel WHERE person_id IN ('HOS-P10', 'HOS-P11') ORDER BY person_id"
    );
    assert.equal(afterStatus.length, 2);
    assert.equal(Number(afterStatus[0].is_active), 0);
    assert.equal(Number(afterStatus[1].is_active), 0);

    // Verify ALL 6 history tables are 100% UNCHANGED (zero delete / zero mutation)
    const snapRawScansAfter = await dbQuery("SELECT * FROM raw_scans WHERE enroll_number = '7210' ORDER BY id ASC");
    const snapFpMappingsAfter = await dbQuery(
      "SELECT * FROM fingerprint_mappings WHERE person_id IN ('HOS-P10', 'HOS-P11') ORDER BY id ASC"
    );
    const snapAttendanceAfter = await dbQuery("SELECT * FROM attendance WHERE person_id = 'HOS-P10' ORDER BY id ASC");
    const snapLeavesAfter = await dbQuery("SELECT * FROM attendance_leaves WHERE person_id = 'HOS-P10' ORDER BY id ASC");
    const snapNotesAfter = await dbQuery("SELECT * FROM attendance_notes WHERE person_id = 'HOS-P10' ORDER BY id ASC");
    const snapPushAfter = await dbQuery("SELECT * FROM push_history WHERE idempotency_key = 'HOS-P10-PUSH-KEY-01'");

    assert.deepEqual(snapRawScansAfter, snapRawScansBefore, 'raw_scans must NEVER be modified or deleted');
    assert.deepEqual(snapFpMappingsAfter, snapFpMappingsBefore, 'fingerprint_mappings history must NEVER be modified or deleted');
    assert.deepEqual(snapAttendanceAfter, snapAttendanceBefore, 'attendance history must NEVER be modified or deleted');
    assert.deepEqual(snapLeavesAfter, snapLeavesBefore, 'attendance_leaves must NEVER be modified or deleted');
    assert.deepEqual(snapNotesAfter, snapNotesBefore, 'attendance_notes must NEVER be modified or deleted');
    assert.deepEqual(snapPushAfter, snapPushBefore, 'push_history must NEVER be modified or deleted');

    // 4. Reactivation: HOS-P10 returns to HR_STATUS_ID = '01' -> safely reactivated, keeping FINGLE_ID 7210
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P10',
        FINGLE_ID: '7210',
        FIRST_NAME: 'กานดา',
        LAST_NAME: 'กลับเข้าปฏิบัติงาน',
        HR_STATUS_ID: '01',
      }),
    ]);

    try {
      const reactivateSync = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-21' },
      });
      assert.equal(reactivateSync.status, 200);
      assert.equal(reactivateSync.data.reactivatedCount, 1);

      const p10Row = (
        await dbQuery<{ is_active: number; fingle_id: string }>(
          "SELECT is_active, fingle_id FROM personnel WHERE person_id = 'HOS-P10'"
        )
      )[0];
      assert.equal(Number(p10Row.is_active), 1);
      assert.equal(p10Row.fingle_id, '7210');
    } finally {
      setHosOfficeTestDouble(null);
    }
  });

  test('HOS-04: Missing personnel without verified non-01 source status MUST NEVER be marked inactive (both unfound & verification error)', async () => {
    // Sync HOS-P20 as active ('01')
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P20',
        FINGLE_ID: '7320',
        FIRST_NAME: 'นภา',
        LAST_NAME: 'ไม่พบในต้นทางชั่วคราว',
        HR_STATUS_ID: '01',
      }),
    ]);
    try {
      const s1 = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-20' },
      });
      assert.equal(s1.status, 200);
    } finally {
      setHosOfficeTestDouble(null);
    }

    // Case A: Next sync does NOT contain HOS-P20 in source at all (foundInSource = false) -> MUST remain is_active = 1
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P01',
        FINGLE_ID: '7101',
        FIRST_NAME: 'อัมพร',
        LAST_NAME: 'สถานะปกติ',
        HR_STATUS_ID: '01',
      }),
    ]);
    try {
      const s2 = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-21' },
      });
      assert.equal(s2.status, 200);
      assert.equal(s2.data.deactivatedCount, 0);
      assert.equal(
        (s2.data.unverifiedMissingPersonIds as string[]).includes('HOS-P20'),
        true,
        'HOS-P20 must be reported as unverified missing instead of being deactivated'
      );

      const p20AfterA = (
        await dbQuery<{ is_active: number }>("SELECT is_active FROM personnel WHERE person_id = 'HOS-P20'")
      )[0];
      assert.equal(Number(p20AfterA.is_active), 1, 'Missing unverified person must NOT be deactivated');
    } finally {
      setHosOfficeTestDouble(null);
    }

    // Case B: Source status verification query fails mid-sync -> MUST NOT guess inactive even if source row is '02'
    setHosOfficeTestDouble(
      [
        makeHosRow({
          PERSON_ID: 'HOS-P01',
          FINGLE_ID: '7101',
          FIRST_NAME: 'อัมพร',
          LAST_NAME: 'สถานะปกติ',
          HR_STATUS_ID: '01',
        }),
        makeHosRow({
          PERSON_ID: 'HOS-P20',
          FINGLE_ID: '7320',
          FIRST_NAME: 'นภา',
          LAST_NAME: 'ไม่พบในต้นทางชั่วคราว',
          HR_STATUS_ID: '02',
          IS_ACTIVE: 0,
        }),
      ],
      false,
      { failStatusVerification: true }
    );
    try {
      const s3 = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-21' },
      });
      assert.equal(s3.status, 200);
      assert.equal(s3.data.sourceVerificationExecuted, false);
      assert.ok(s3.data.sourceVerificationWarning);
      assert.equal(s3.data.deactivatedCount, 0);

      const p20AfterB = (
        await dbQuery<{ is_active: number }>("SELECT is_active FROM personnel WHERE person_id = 'HOS-P20'")
      )[0];
      assert.equal(Number(p20AfterB.is_active), 1, 'Person must remain active when source verification fails');
    } finally {
      setHosOfficeTestDouble(null);
    }
  });

  test('HOS-05: Duplicate FINGLE_ID conflict check ignores non-01 personnel in HOSOffice', async () => {
    setHosOfficeTestDouble([
      makeHosRow({
        PERSON_ID: 'HOS-P30',
        FINGLE_ID: '7400',
        FIRST_NAME: 'อดีตพนักงาน',
        LAST_NAME: 'ลาออก',
        HR_STATUS_ID: '02',
        IS_ACTIVE: 0,
      }),
      makeHosRow({
        PERSON_ID: 'HOS-P31',
        FINGLE_ID: '7400',
        FIRST_NAME: 'พนักงานปัจจุบัน',
        LAST_NAME: 'ทำงานปกติ',
        HR_STATUS_ID: '01',
        IS_ACTIVE: 1,
      }),
    ]);

    try {
      const res = await apiCall('/api/Sam_Att/personnel/sync', {
        method: 'POST',
        token: adminToken,
        body: { effectiveDate: '2026-11-21' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.recordsFetched, 1);
      assert.equal(res.data.mappingConflictsFound, 0);

      const p31 = (
        await dbQuery<{ fingle_id: string; is_active: number; mapping_status: string }>(
          "SELECT fingle_id, is_active, mapping_status FROM personnel WHERE person_id = 'HOS-P31'"
        )
      )[0];
      assert.equal(p31.fingle_id, '7400');
      assert.equal(Number(p31.is_active), 1);
      assert.equal(p31.mapping_status, 'VALID');
    } finally {
      setHosOfficeTestDouble(null);
    }
  });
});
