/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: ระบบแม่แบบกะทำงาน — Default Shift Template Governance
 * ไฟล์: backend/tests/default-shift-templates.test.ts
 * ============================================================================
 * ครอบคลุม 8+ สถานการณ์บังคับ:
 * 1. ยังไม่มีกะเริ่มต้น -> กำหนดเป็นกะเริ่มต้นได้สำเร็จ
 * 2. มีกะเริ่มต้นอยู่แล้ว -> ปฏิเสธการกำหนดซ้ำ (409 DEFAULT_SHIFT_ALREADY_EXISTS) ทั้ง POST/PUT และ DB UNIQUE
 * 3. ประเภทบุคลากรต่างกัน -> กะเริ่มต้นแยกกันทำงานถูกต้องตามประเภท
 * 4. มีการจัดเวรรายวัน (shift_assignments) -> ใช้กะรายวันแทนกะเริ่มต้น (รวมหลายกะ/วัน)
 * 5. ไม่มีเวรรายวัน -> ใช้กะเริ่มต้นของประเภทบุคลากร และหากไม่มีทั้งคู่ -> UNCONFIGURED_DEFAULT_RULE (ไม่สร้างกะ/สแกนปลอม)
 * 6. เปลี่ยนกะเริ่มต้น (Explicit Change Default) -> ข้อมูลตารางเวรย้อนหลัง/สแกน/การลงเวลาไม่ถูกแก้ไข และบันทึก Audit Log
 * 7. ผู้ใช้ไม่มีสิทธิ์ (GENERAL_USER) -> ถูกปฏิเสธ 403 FORBIDDEN ทุกเส้นทางแก้ไข
 * 8. ยิง API พร้อมกันหลายคำขอ (Concurrent Requests) -> ไม่มีกะเริ่มต้นซ้ำในฐานข้อมูล (สำเร็จ 1, ถูกปฏิเสธ 409 ที่เหลือ)
 * 9. ห้ามปิดใช้งานแม่แบบกะที่กำลังถูกผูกเป็นกะเริ่มต้นอยู่ (409 DEFAULT_SHIFT_IN_USE) และตรวจสอบ Migration 004
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
  `sam_att_default_shifts_${process.pid}_${Date.now()}.sqlite`
);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_FILE;
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.JWT_SECRET = 'sam-att-default-shift-test-secret-key-2026';
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
  parseMigrationSqlFile,
  verifyMigrationSchemaPostApply,
} from '../src/database/adapter.ts';
import { reprocessAttendanceRange } from '../src/modules/attendance/processor.ts';
import { ingestSixFieldEventsBatch } from '../src/modules/scanners/routes.ts';
import { buildCompactMonthlyCellViewModel } from '../../frontend/src/utils/shiftDisplay.ts';

let server: http.Server;
let baseUrl = '';
let adminToken = '';
let staffToken = '';
let generalUserToken = '';

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

describe('Default Shift Template Governance & Resolution (DEF-01..DEF-09)', () => {
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

    const userLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(userLogin.status, 200);
    generalUserToken = userLogin.data.token;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
    } catch {
      // ignore cleanup error
    }
  });

  test('DEF-01: ยังไม่มีกะเริ่มต้น -> สามารถสร้างแม่แบบกะและกำหนดเป็นกะเริ่มต้นได้สำเร็จ', async () => {
    const createTypeRes = await apiCall('/api/Sam_Att/personnel-type-rules', {
      method: 'POST',
      token: adminToken,
      body: {
        personnelTypeCode: 'CONTRACT_EMPTY',
        personnelTypeName: 'ลูกจ้างเหมาบริการ (ทดสอบ)',
        noDefaultShift: true,
        effectiveFrom: '2026-01-01',
      },
    });
    assert.equal(createTypeRes.status, 201, JSON.stringify(createTypeRes.data));

    const beforeShifts = await apiCall('/api/Sam_Att/shifts', { token: adminToken });
    assert.equal(beforeShifts.status, 200);
    const emptyRuleBefore = beforeShifts.data.personnelTypeRules.find(
      (r: any) => r.personnel_type_code === 'CONTRACT_EMPTY'
    );
    assert.ok(emptyRuleBefore, 'ต้องพบประเภทบุคลากร CONTRACT_EMPTY');
    assert.equal(emptyRuleBefore.default_shift_id, null);
    assert.equal(emptyRuleBefore.has_default_shift_template, false);

    // สร้างแม่แบบกะใหม่และกำหนดเป็น Default Shift ให้ CONTRACT_EMPTY
    const createShiftRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: staffToken,
      body: {
        shiftCode: 'DEF-CONT-01',
        shiftName: 'เวรเหมาบริการมาตรฐาน',
        shiftCategory: 'OFFICIAL',
        startTime: '08:30',
        endTime: '16:30',
        graceMinutes: 10,
        cutoffTime: '11:00',
        isDefault: true,
        defaultPersonnelTypeCodes: ['CONTRACT_EMPTY'],
        defaultReason: 'กำหนดกะเริ่มต้นครั้งแรกให้กลุ่มลูกจ้างเหมาบริการ',
      },
    });
    assert.equal(createShiftRes.status, 201, JSON.stringify(createShiftRes.data));
    assert.equal(createShiftRes.data.isDefault, true);

    const afterShifts = await apiCall('/api/Sam_Att/shifts', { token: adminToken });
    assert.equal(afterShifts.status, 200);
    const createdShift = afterShifts.data.items.find((s: any) => s.shift_code === 'DEF-CONT-01');
    assert.ok(createdShift, 'ต้องพบแม่แบบกะ DEF-CONT-01');
    assert.equal(Number(createdShift.is_default), 1);
    assert.equal(createdShift.default_personnel_types.length, 1);
    assert.equal(createdShift.default_personnel_types[0].personnelTypeCode, 'CONTRACT_EMPTY');

    const boundRule = afterShifts.data.personnelTypeRules.find(
      (r: any) => r.personnel_type_code === 'CONTRACT_EMPTY'
    );
    assert.equal(Number(boundRule.default_shift_id), Number(createdShift.id));
    assert.equal(boundRule.default_shift_code, 'DEF-CONT-01');
    assert.equal(boundRule.has_default_shift_template, true);
  });

  test('DEF-02: มีกะเริ่มต้นอยู่แล้ว -> ปฏิเสธการกำหนดซ้ำทั้ง POST/PUT (409) และระดับฐานข้อมูล (UNIQUE)', async () => {
    // 2.1 ยิง POST /shifts พยายามกำหนดซ้ำให้ CONTRACT_EMPTY
    const dupPostRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'DEF-CONT-DUP',
        shiftName: 'เวรเหมาบริการซ้ำซ้อน',
        shiftCategory: 'OFFICIAL',
        startTime: '09:00',
        endTime: '17:00',
        graceMinutes: 15,
        cutoffTime: '11:30',
        isDefault: true,
        defaultPersonnelTypeCodes: ['CONTRACT_EMPTY'],
      },
    });
    assert.equal(dupPostRes.status, 409, JSON.stringify(dupPostRes.data));
    assert.equal(dupPostRes.data.error, 'DEFAULT_SHIFT_ALREADY_EXISTS');
    assert.ok(
      String(dupPostRes.data.message || '').includes('เวรเหมาบริการมาตรฐาน'),
      'ข้อความแจ้งเตือนต้องระบุชื่อกะเริ่มต้นที่ใช้งานอยู่ปัจจุบัน'
    );
    assert.ok(Array.isArray(dupPostRes.data.conflicts) && dupPostRes.data.conflicts.length === 1);

    // ตรวจสอบว่าไม่สร้างแถวแม่แบบกะค้าง (Atomic Rollback)
    const orphanShift = await dbQuery(
      `SELECT id FROM shifts WHERE shift_code = ?`,
      ['DEF-CONT-DUP']
    );
    assert.equal(orphanShift.length, 0, 'ต้องไม่เหลือแถว shift ค้างเมื่อ Transaction ถูก Rollback');

    // 2.2 สร้างแม่แบบกะปกติ แล้วพยายาม PUT เพื่อกำหนดเป็น Default ซ้ำให้ CONTRACT_EMPTY
    const normalCreate = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'NORM-CONT-02',
        shiftName: 'เวรปกติสำรอง',
        shiftCategory: 'OFFICIAL',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '11:00',
      },
    });
    assert.equal(normalCreate.status, 201);

    const dupPutRes = await apiCall(`/api/Sam_Att/shifts/${normalCreate.data.id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        shiftCode: 'NORM-CONT-02',
        shiftName: 'เวรปกติสำรอง',
        shiftCategory: 'OFFICIAL',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '11:00',
        isDefault: true,
        defaultPersonnelTypeCodes: ['CONTRACT_EMPTY'],
      },
    });
    assert.equal(dupPutRes.status, 409, JSON.stringify(dupPutRes.data));
    assert.equal(dupPutRes.data.error, 'DEFAULT_SHIFT_ALREADY_EXISTS');

    // 2.3 ตรวจสอบระดับ Database UNIQUE Constraint โดยตรง
    await assert.rejects(
      async () => {
        await dbExecute(
          `INSERT INTO personnel_type_default_shifts (personnel_type_code, shift_id, assigned_by, assigned_reason)
           VALUES (?, ?, 'test', 'direct-dup')`,
          ['CONTRACT_EMPTY', normalCreate.data.id]
        );
      },
      /UNIQUE|constraint/i,
      'ฐานข้อมูลต้องปฏิเสธการเพิ่มกะเริ่มต้นซ้ำด้วย UNIQUE constraint'
    );
  });

  test('DEF-03 & DEF-04 & DEF-05: แยกกะเริ่มต้นตามประเภทบุคลากร, กะรายวันมีความสำคัญสูงกว่า และไม่สร้างกะปลอมเมื่อยังไม่ตั้งค่า', async () => {
    // สร้าง 3 ประเภทบุคลากร: TYPE_NURSE_A (มี Default A), TYPE_TECH_B (มี Default B), TYPE_NO_DEFAULT (ไม่มี Default)
    for (const [code, name] of [
      ['TYPE_NURSE_A', 'กลุ่มพยาบาลเฉพาะทาง A'],
      ['TYPE_TECH_B', 'กลุ่มเทคนิคการแพทย์ B'],
      ['TYPE_NO_DEFAULT', 'กลุ่มที่ยังไม่ตั้งค่ากะเริ่มต้น'],
    ]) {
      const r = await apiCall('/api/Sam_Att/personnel-type-rules', {
        method: 'POST',
        token: adminToken,
        body: {
          personnelTypeCode: code,
          personnelTypeName: name,
          noDefaultShift: true,
          effectiveFrom: '2026-01-01',
        },
      });
      assert.equal(r.status, 201);
    }

    const shiftARes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'DEF-NUR-A',
        shiftName: 'กะเริ่มต้นพยาบาล A',
        shiftCategory: 'MORNING',
        startTime: '08:30',
        endTime: '16:30',
        graceMinutes: 10,
        cutoffTime: '11:00',
        isDefault: true,
        defaultPersonnelTypeCodes: ['TYPE_NURSE_A'],
      },
    });
    assert.equal(shiftARes.status, 201);

    const shiftBRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'DEF-TECH-B',
        shiftName: 'กะเริ่มต้นเทคนิค B',
        shiftCategory: 'MORNING',
        startTime: '07:00',
        endTime: '15:00',
        graceMinutes: 5,
        cutoffTime: '10:00',
        isDefault: true,
        defaultPersonnelTypeCodes: ['TYPE_TECH_B'],
      },
    });
    assert.equal(shiftBRes.status, 201);

    // เพิ่มบุคลากรทดสอบ 3 คนในฐานข้อมูลทดสอบ พร้อมประวัติรหัสสแกนลายนิ้วมือ
    await dbExecute(
      `INSERT INTO personnel (person_id, fingle_id, title_name, first_name, last_name, full_name, position_name, department_name, personnel_type_code, personnel_type_name, is_active)
       VALUES
       ('P-DEF-A', '99101', 'นางสาว', 'ทดสอบ', 'พยาบาลเอ', 'นางสาวทดสอบ พยาบาลเอ', 'พยาบาลวิชาชีพ', 'กลุ่มงานการพยาบาล', 'TYPE_NURSE_A', 'กลุ่มพยาบาลเฉพาะทาง A', 1),
       ('P-DEF-B', '99102', 'นาย', 'ทดสอบ', 'เทคนิคบี', 'นายทดสอบ เทคนิคบี', 'นักเทคนิคการแพทย์', 'กลุ่มงานเทคนิคการแพทย์', 'TYPE_TECH_B', 'กลุ่มเทคนิคการแพทย์ B', 1),
       ('P-DEF-NONE', '99103', 'นาย', 'ทดสอบ', 'ไม่มีกะเริ่มต้น', 'นายทดสอบ ไม่มีกะเริ่มต้น', 'เจ้าพนักงาน', 'กลุ่มงานบริหาร', 'TYPE_NO_DEFAULT', 'กลุ่มที่ยังไม่ตั้งค่ากะเริ่มต้น', 1)`
    );
    await dbExecute(
      `INSERT INTO fingerprint_mappings (person_id, fingle_id, effective_from, effective_to, conflict_state, source)
       VALUES
       ('P-DEF-A', '99101', '2026-01-01', NULL, 'NONE', 'TEST'),
       ('P-DEF-B', '99102', '2026-01-01', NULL, 'NONE', 'TEST'),
       ('P-DEF-NONE', '99103', '2026-01-01', NULL, 'NONE', 'TEST')`
    );

    const workDate = '2026-05-12';
    const overrideDate = '2026-05-13';

    // ตรวจสอบ Daily Cell Resolution ของทั้ง 3 คนในวันที่ไม่มีการจัดเวรรายวัน
    const cellA = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=P-DEF-A&workDate=${workDate}`,
      { token: adminToken }
    );
    assert.equal(cellA.status, 200);
    assert.equal(cellA.data.effectiveState, 'DEFAULT_FROM_TYPE');
    assert.equal(cellA.data.effectiveShifts.length, 1);
    assert.equal(cellA.data.effectiveShifts[0].shiftCode, 'DEF-NUR-A');
    assert.equal(cellA.data.effectiveShifts[0].startTime, '08:30');
    assert.equal(cellA.data.effectiveShifts[0].endTime, '16:30');

    const cellB = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=P-DEF-B&workDate=${workDate}`,
      { token: adminToken }
    );
    assert.equal(cellB.status, 200);
    assert.equal(cellB.data.effectiveState, 'DEFAULT_FROM_TYPE');
    assert.equal(cellB.data.effectiveShifts.length, 1);
    assert.equal(cellB.data.effectiveShifts[0].shiftCode, 'DEF-TECH-B');
    assert.equal(cellB.data.effectiveShifts[0].startTime, '07:00');
    assert.equal(cellB.data.effectiveShifts[0].endTime, '15:00');

    const cellNone = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=P-DEF-NONE&workDate=${workDate}`,
      { token: adminToken }
    );
    assert.equal(cellNone.status, 200);
    assert.equal(cellNone.data.effectiveState, 'UNCONFIGURED_DEFAULT_RULE');
    assert.equal(cellNone.data.effectiveShifts.length, 0, 'ต้องไม่สร้างกะปลอมเมื่อยังไม่ตั้งค่ากะเริ่มต้น');

    // จัดเวรรายวันให้ P-DEF-A ในวันที่ overrideDate -> ต้องแทนที่ Default Shift
    const aftShift = (
      await dbQuery<{ id: number }>(`SELECT id FROM shifts WHERE shift_code = 'AFT-1600' LIMIT 1`)
    )[0];
    assert.ok(aftShift, 'ต้องมีแม่แบบกะบ่าย AFT-1600 ในฐานระบบ');

    const assignDailyRes = await apiCall('/api/Sam_Att/shift-assignments', {
      method: 'POST',
      token: adminToken,
      body: {
        personId: 'P-DEF-A',
        shiftId: aftShift.id,
        workDate: overrideDate,
      },
    });
    assert.equal(assignDailyRes.status, 201, JSON.stringify(assignDailyRes.data));

    const cellAOverride = await apiCall(
      `/api/Sam_Att/shift-assignments/daily-cell?personId=P-DEF-A&workDate=${overrideDate}`,
      { token: adminToken }
    );
    assert.equal(cellAOverride.status, 200);
    assert.equal(cellAOverride.data.effectiveState, 'CUSTOM_ASSIGNED');
    assert.equal(cellAOverride.data.effectiveShifts[0].shiftCode, 'AFT-1600');

    // ทดสอบ Attendance Processor จริงผ่าน ingestSixFieldEventsBatch:
    // - P-DEF-A สแกนเข้า 08:35 (สายไม่เกิน 10 นาทีของ DEF-NUR-A 08:30–16:30) และออก 16:32 ใน workDate -> NORMAL
    // - P-DEF-B สแกนเข้า 07:15 (สายเกิน 5 นาทีของ DEF-TECH-B 07:00–15:00) และออก 15:05 ใน workDate -> LATE
    // - P-DEF-A ใน overrideDate สแกนเข้า 16:02 ออก 23:55 -> จับคู่ AFT-1600 ไม่ใช่ DEF-NUR-A
    // - P-DEF-NONE ใน workDate -> NO_SHIFT_ASSIGNED (ไม่สร้างกะปลอม)
    await ingestSixFieldEventsBatch(
      [
        {
          machineNo: 1,
          enrollNumber: '99101',
          scanDateTime: `${workDate} 08:35:00`,
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
        {
          machineNo: 1,
          enrollNumber: '99101',
          scanDateTime: `${workDate} 16:32:00`,
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
        {
          machineNo: 1,
          enrollNumber: '99102',
          scanDateTime: `${workDate} 07:15:00`,
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
        {
          machineNo: 1,
          enrollNumber: '99102',
          scanDateTime: `${workDate} 15:05:00`,
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
        {
          machineNo: 1,
          enrollNumber: '99101',
          scanDateTime: `${overrideDate} 16:02:00`,
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
        {
          machineNo: 1,
          enrollNumber: '99101',
          scanDateTime: `${overrideDate} 23:55:00`,
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
      ],
      'MANUAL',
      'admin'
    );

    await reprocessAttendanceRange({
      dateFrom: workDate,
      dateTo: overrideDate,
      actorUsername: 'admin',
    });

    const attRows = await dbQuery<{
      person_id: string;
      work_date: string;
      shift_code: string | null;
      status: string;
      late_minutes: number;
    }>(
      `SELECT person_id, work_date, shift_code, status, late_minutes
       FROM attendance
       WHERE person_id IN ('P-DEF-A', 'P-DEF-B', 'P-DEF-NONE')
         AND work_date IN (?, ?)
       ORDER BY person_id, work_date`,
      [workDate, overrideDate]
    );

    const attADefault = attRows.find((r) => r.person_id === 'P-DEF-A' && r.work_date === workDate);
    assert.ok(attADefault);
    assert.equal(attADefault.shift_code, 'DEF-NUR-A');
    assert.equal(attADefault.status, 'NORMAL');
    assert.equal(Number(attADefault.late_minutes), 0);

    const attBDefault = attRows.find((r) => r.person_id === 'P-DEF-B' && r.work_date === workDate);
    assert.ok(attBDefault);
    assert.equal(attBDefault.shift_code, 'DEF-TECH-B');
    assert.equal(attBDefault.status, 'LATE');
    assert.equal(Number(attBDefault.late_minutes), 15);

    const attAOverride = attRows.find(
      (r) => r.person_id === 'P-DEF-A' && r.work_date === overrideDate
    );
    assert.ok(attAOverride);
    assert.equal(attAOverride.shift_code, 'AFT-1600');
    assert.equal(attAOverride.status, 'NORMAL');

    const attNone = attRows.find((r) => r.person_id === 'P-DEF-NONE' && r.work_date === workDate);
    assert.equal(
      attNone,
      undefined,
      'ต้องไม่สร้างกะปลอมหรือแถว attendance ปลอมเมื่อไม่มีทั้งเวรรายวัน กะเริ่มต้น และสแกน'
    );

    // ตรวจสอบ Frontend ViewModel ใช้ชื่อ/รหัสกะเริ่มต้นจริง ไม่ฮาร์ดโค้ด
    const vmLinked = buildCompactMonthlyCellViewModel(
      {
        mode: 'DEFAULT_FROM_TYPE',
        activeItems: [],
        defaultRule: {
          personnel_type_name: 'กลุ่มพยาบาลเฉพาะทาง A',
          default_shift_id: shiftARes.data.id,
          default_shift_code: 'DEF-NUR-A',
          default_shift_name: 'กะเริ่มต้นพยาบาล A',
          default_shift_start_time: '08:30',
          default_shift_end_time: '16:30',
          default_shift_grace_minutes: 10,
        },
      },
      '12 พ.ค. 2569'
    );
    assert.equal(vmLinked.kind, 'DEFAULT');
    assert.equal(vmLinked.visibleIcons[0].shiftCode, 'DEF-NUR-A');
    assert.ok(vmLinked.visibleIcons[0].cleanName.includes('กะเริ่มต้นพยาบาล A'));

    const vmUnconfigured = buildCompactMonthlyCellViewModel(
      {
        mode: 'DEFAULT_FROM_TYPE',
        activeItems: [],
        defaultRule: {
          personnel_type_name: 'กลุ่มที่ยังไม่ตั้งค่ากะเริ่มต้น',
          default_shift_id: null,
          default_start_time: '',
          default_end_time: '',
        },
      },
      '12 พ.ค. 2569'
    );
    assert.equal(vmUnconfigured.kind, 'EMPTY_DASH');
    assert.equal(vmUnconfigured.totalShifts, 0);
  });

  test('DEF-06: เปลี่ยนกะเริ่มต้น (Explicit Change Default) ไม่กระทบข้อมูลย้อนหลัง และบันทึก Audit Log + ห้ามปิดใช้งานกะที่ผูกอยู่', async () => {
    const newDefaultRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'DEF-NUR-A-V2',
        shiftName: 'กะเริ่มต้นพยาบาล A รุ่นปรับปรุง',
        shiftCategory: 'MORNING',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '10:30',
      },
    });
    assert.equal(newDefaultRes.status, 201);

    // เก็บ Snapshot ของข้อมูลย้อนหลังก่อนเปลี่ยนกะเริ่มต้น
    const assignmentsBefore = await dbQuery(
      `SELECT id, person_id, work_date, snapshot_shift_code, snapshot_start_time, snapshot_end_time, status
       FROM shift_assignments WHERE person_id = 'P-DEF-A' ORDER BY id`
    );
    const rawScansBefore = await dbQuery(
      `SELECT id, matched_person_id, canonical_bkk_time, event_dedup_key
       FROM raw_scans WHERE matched_person_id = 'P-DEF-A' ORDER BY id`
    );
    const attendanceBefore = await dbQuery(
      `SELECT id, person_id, work_date, shift_code, status, late_minutes
       FROM attendance WHERE person_id = 'P-DEF-A' ORDER BY id`
    );

    // เปลี่ยนกะเริ่มต้นของ TYPE_NURSE_A ไปเป็น DEF-NUR-A-V2
    const changeRes = await apiCall(`/api/Sam_Att/shifts/${newDefaultRes.data.id}/set-default`, {
      method: 'POST',
      token: staffToken,
      body: {
        personnelTypeCode: 'TYPE_NURSE_A',
        reason: 'ปรับเวลากะเริ่มต้นตามมติคณะกรรมการบริหารโรงพยาบาล',
      },
    });
    assert.equal(changeRes.status, 200, JSON.stringify(changeRes.data));
    assert.ok(Array.isArray(changeRes.data.changes) && changeRes.data.changes.length === 1);
    assert.equal(changeRes.data.changes[0].newDefaultShiftCode, 'DEF-NUR-A-V2');
    assert.equal(changeRes.data.changes[0].previousDefaultShiftCode, 'DEF-NUR-A');

    // ตรวจสอบว่าข้อมูลย้อนหลังทั้งหมดไม่ถูกแก้ไขแม้แต่คอลัมน์เดียว
    const assignmentsAfter = await dbQuery(
      `SELECT id, person_id, work_date, snapshot_shift_code, snapshot_start_time, snapshot_end_time, status
       FROM shift_assignments WHERE person_id = 'P-DEF-A' ORDER BY id`
    );
    const rawScansAfter = await dbQuery(
      `SELECT id, matched_person_id, canonical_bkk_time, event_dedup_key
       FROM raw_scans WHERE matched_person_id = 'P-DEF-A' ORDER BY id`
    );
    const attendanceAfter = await dbQuery(
      `SELECT id, person_id, work_date, shift_code, status, late_minutes
       FROM attendance WHERE person_id = 'P-DEF-A' ORDER BY id`
    );
    assert.deepEqual(assignmentsAfter, assignmentsBefore, 'shift_assignments ย้อนหลังต้องไม่ถูกเปลี่ยนแปลง');
    assert.deepEqual(rawScansAfter, rawScansBefore, 'raw_scans ย้อนหลังต้องไม่ถูกเปลี่ยนแปลง');
    assert.deepEqual(attendanceAfter, attendanceBefore, 'attendance ย้อนหลังต้องไม่ถูกเปลี่ยนแปลง');

    // ตรวจสอบ Audit Log และ Rule History
    const auditRows = await dbQuery<{ action: string; actor_username: string; detail_json: string }>(
      `SELECT action, actor_username, detail_json
       FROM audit_logs
       WHERE action = 'DEFAULT_SHIFT_CHANGED'
       ORDER BY id DESC LIMIT 1`
    );
    assert.equal(auditRows.length, 1);
    assert.equal(auditRows[0].actor_username, 'hrstaff');
    const detail = JSON.parse(auditRows[0].detail_json);
    assert.equal(detail.historicalAssignmentsPreserved, true);
    assert.equal(detail.changes[0].personnelTypeCode, 'TYPE_NURSE_A');
    assert.equal(detail.changes[0].previousDefaultShiftCode, 'DEF-NUR-A');
    assert.equal(detail.changes[0].newDefaultShiftCode, 'DEF-NUR-A-V2');

    // ตรวจสอบว่าไม่สามารถปิดใช้งานแม่แบบกะที่กำลังถูกผูกเป็นกะเริ่มต้นได้ (409 DEFAULT_SHIFT_IN_USE)
    const deactivateInUseRes = await apiCall(`/api/Sam_Att/shifts/${newDefaultRes.data.id}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        shiftCode: 'DEF-NUR-A-V2',
        shiftName: 'กะเริ่มต้นพยาบาล A รุ่นปรับปรุง',
        shiftCategory: 'MORNING',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '10:30',
        isActive: false,
      },
    });
    assert.equal(deactivateInUseRes.status, 409, JSON.stringify(deactivateInUseRes.data));
    assert.equal(deactivateInUseRes.data.error, 'DEFAULT_SHIFT_IN_USE');
  });

  test('DEF-07: ผู้ใช้ไม่มีสิทธิ์ (GENERAL_USER) ไม่สามารถสร้าง/แก้ไข/เปลี่ยน/ยกเลิกกะเริ่มต้นได้ (403 FORBIDDEN)', async () => {
    const anyShift = (await dbQuery<{ id: number }>(`SELECT id FROM shifts LIMIT 1`))[0];
    assert.ok(anyShift);

    const postRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: generalUserToken,
      body: {
        shiftCode: 'UNAUTH-01',
        shiftName: 'เวรไม่มีสิทธิ์',
        shiftCategory: 'OFFICIAL',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '11:00',
        isDefault: true,
        defaultPersonnelTypeCodes: ['TYPE_NO_DEFAULT'],
      },
    });
    assert.equal(postRes.status, 403);

    const putRes = await apiCall(`/api/Sam_Att/shifts/${anyShift.id}`, {
      method: 'PUT',
      token: generalUserToken,
      body: {
        shiftCode: 'MOR-0816',
        shiftName: 'พยายามแก้โดยไม่มีสิทธิ์',
        shiftCategory: 'OFFICIAL',
        startTime: '08:00',
        endTime: '16:00',
        graceMinutes: 15,
        cutoffTime: '11:00',
      },
    });
    assert.equal(putRes.status, 403);

    const setDefRes = await apiCall(`/api/Sam_Att/shifts/${anyShift.id}/set-default`, {
      method: 'POST',
      token: generalUserToken,
      body: {
        personnelTypeCode: 'TYPE_NO_DEFAULT',
        reason: 'unauthorized attempt',
      },
    });
    assert.equal(setDefRes.status, 403);

    const delDefRes = await apiCall('/api/Sam_Att/shifts/default/TYPE_NURSE_A', {
      method: 'DELETE',
      token: generalUserToken,
      body: { reason: 'unauthorized clear' },
    });
    assert.equal(delDefRes.status, 403);
  });

  test('DEF-08: ยิง API กำหนดกะเริ่มต้นพร้อมกันหลายคำขอ (Concurrent Requests) -> สำเร็จ 1 รายการ ที่เหลือ 409 ไม่มีกะเริ่มต้นซ้ำ', async () => {
    const createTypeRes = await apiCall('/api/Sam_Att/personnel-type-rules', {
      method: 'POST',
      token: adminToken,
      body: {
        personnelTypeCode: 'CONCURRENT_TYPE',
        personnelTypeName: 'กลุ่มทดสอบคำขอพร้อมกัน',
        noDefaultShift: true,
        effectiveFrom: '2026-01-01',
      },
    });
    assert.equal(createTypeRes.status, 201);

    const concurrentAttempts = Array.from({ length: 5 }, (_, idx) =>
      apiCall('/api/Sam_Att/shifts', {
        method: 'POST',
        token: adminToken,
        body: {
          shiftCode: `CONC-DEF-0${idx + 1}`,
          shiftName: `กะทดสอบพร้อมกัน ${idx + 1}`,
          shiftCategory: 'OFFICIAL',
          startTime: '08:00',
          endTime: '16:00',
          graceMinutes: 15,
          cutoffTime: '10:30',
          isDefault: true,
          defaultPersonnelTypeCodes: ['CONCURRENT_TYPE'],
        },
      })
    );

    const results = await Promise.all(concurrentAttempts);
    const created = results.filter((r) => r.status === 201);
    const rejectedConflict = results.filter(
      (r) => r.status === 409 && r.data.error === 'DEFAULT_SHIFT_ALREADY_EXISTS'
    );

    assert.equal(created.length, 1, `ต้องมีเพียง 1 คำขอที่สำเร็จ แต่ได้: ${JSON.stringify(results)}`);
    assert.equal(
      rejectedConflict.length,
      4,
      `อีก 4 คำขอต้องถูกปฏิเสธด้วย 409 DEFAULT_SHIFT_ALREADY_EXISTS แต่ได้: ${JSON.stringify(results)}`
    );

    const dbBindings = await dbQuery<{ personnel_type_code: string; shift_id: number }>(
      `SELECT personnel_type_code, shift_id
       FROM personnel_type_default_shifts
       WHERE personnel_type_code = 'CONCURRENT_TYPE'`
    );
    assert.equal(dbBindings.length, 1, 'ฐานข้อมูลต้องมีแถวกะเริ่มต้นของ CONCURRENT_TYPE เพียง 1 แถวเท่านั้น');
  });

  test('DEF-09: ยกเลิกผูกกะเริ่มต้น (DELETE /shifts/default/:code) และตรวจสอบ Schema Migration 004', async () => {
    const clearRes = await apiCall('/api/Sam_Att/shifts/default/CONCURRENT_TYPE', {
      method: 'DELETE',
      token: adminToken,
      body: { reason: 'ทดสอบยกเลิกผูกกะเริ่มต้น' },
    });
    assert.equal(clearRes.status, 200, JSON.stringify(clearRes.data));

    const remainingBindings = await dbQuery(
      `SELECT * FROM personnel_type_default_shifts WHERE personnel_type_code = 'CONCURRENT_TYPE'`
    );
    assert.equal(remainingBindings.length, 0);

    const migrationPath = path.resolve(
      process.cwd(),
      'database/migrations/004_default_shift_templates.sql'
    );
    const parsedImpact = parseMigrationSqlFile(migrationPath, '004_default_shift_templates.sql');
    const migrationVerify = await verifyMigrationSchemaPostApply([parsedImpact]);
    assert.equal(migrationVerify.ok, true, JSON.stringify(migrationVerify));
  });
});
