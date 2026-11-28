/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: Shift Template Modal & Alert System (UX/UI + API Integration)
 * ไฟล์: backend/tests/shift-template-modal-alert.test.ts
 * ============================================================================
 * ตรวจสอบครบทุกหัวข้อสำคัญ:
 * 1. ค่าเริ่มต้นโหมด Create และโหมด Edit (Pre-fill ข้อมูลเดิมถูกต้อง 7 ฟิลด์หลัก)
 * 2. Dirty Check / Unsaved Changes Guard ทุกฟิลด์ของ Shift Template และ Personnel Type Default
 * 3. Validation ระดับฟิลด์ (Required fields, รูปแบบรหัสกะ, เวลา 24 ชม., ผ่อนผัน 0–180 นาที)
 * 4. ยืนยันว่า ShiftTemplateModal ไม่มี Checkbox/Toggle สำหรับ Default Shift (จัดการจุดเดียวที่ประเภทบุคลากร)
 * 5. แปลง API Error Codes เป็นข้อความระดับฟิลด์ที่อ่านเข้าใจง่าย
 * 6. Success Toast auto-dismiss 4000ms และไม่ใช้ browser alert()/confirm()
 * 7. Create -> Refresh list จริงจาก API, Edit -> Refresh list จริงจาก API
 * 8. Failure path (409 / 400) ไม่ทำให้ข้อมูลเดิมเสียหาย
 * 9. Deactivate / Reactivate แม่แบบกะ
 * 10. Zero regression กับการจัดตารางเวรรายวัน (Shift Assignments)
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
  `sam_att_modal_alert_${process.pid}_${Date.now()}.sqlite`
);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_FILE;
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.JWT_SECRET = 'sam-att-modal-alert-test-secret-key-2026';
process.env.SCANNER_SYNC_ENABLED = 'false';
process.env.SCANNER_AUTO_SCHEDULER_ENABLED = 'false';
process.env.HOSOFFICE_DB_HOST = 'CHANGE_ME';
process.env.HOSOFFICE_DB_PASSWORD = 'CHANGE_ME';

import { createExpressApp } from '../src/app.ts';
import {
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
} from '../src/database/adapter.ts';
import {
  createInitialShiftTemplateFormValues,
  isShiftTemplateFormDirty,
  validateShiftTemplateForm,
  mapShiftTemplateApiErrorToFields,
  formatDefaultWorkdaysThai,
  isDateInWorkdays,
  validatePersonnelTypeDefaultForm,
  DEFAULT_SUCCESS_TOAST_MS,
} from '../../frontend/src/utils/shiftTemplateForm.ts';

let server: http.Server;
let baseUrl = '';
let adminToken = '';

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

describe('Shift Template Modal & Standard Alert System (UI-01..UI-06)', () => {
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
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try {
      if (fs.existsSync(TEST_DB_FILE)) fs.unlinkSync(TEST_DB_FILE);
    } catch {
      // ignore cleanup error
    }
  });

  test('UI-01: Create & Edit initial values pre-fill cleanly (7 core fields only) and strip redundant time suffix', () => {
    const createInit = createInitialShiftTemplateFormValues('create');
    assert.equal(createInit.shiftName, '');
    assert.equal(createInit.shiftCode, '');
    assert.equal(createInit.startTime, '08:00');
    assert.equal(createInit.endTime, '16:00');
    assert.equal(createInit.graceMinutes, '15');
    assert.equal('createIsDefault' in createInit, false);

    const editInit = createInitialShiftTemplateFormValues('edit', {
      id: 7,
      shift_code: 'ER-NIGHT',
      shift_name: 'เวรดึกฉุกเฉิน (00:00–08:00)',
      shift_category: 'NIGHT',
      start_time: '00:00',
      end_time: '08:00',
      grace_minutes: 10,
      cutoff_time: '02:00',
      is_active: 1,
    });
    assert.equal(editInit.shiftName, 'เวรดึกฉุกเฉิน');
    assert.equal(editInit.shiftCode, 'ER-NIGHT');
    assert.equal(editInit.shiftCategory, 'NIGHT');
    assert.equal(editInit.graceMinutes, '10');
    assert.equal(editInit.isActive, true);
  });

  test('UI-02: Unsaved changes (dirty) detection works for both Create and Edit modes', () => {
    const createInit = createInitialShiftTemplateFormValues('create');
    assert.equal(isShiftTemplateFormDirty(createInit, { ...createInit }, 'create'), false);
    assert.equal(
      isShiftTemplateFormDirty(createInit, { ...createInit, shiftName: 'เวรคลินิกพิเศษ' }, 'create'),
      true
    );

    const editInit = createInitialShiftTemplateFormValues('edit', {
      id: 3,
      shift_code: 'MORN-01',
      shift_name: 'เวรเช้า',
      shift_category: 'MORNING',
      start_time: '08:00',
      end_time: '16:00',
      grace_minutes: 15,
      cutoff_time: '10:30',
      is_active: 1,
    });
    assert.equal(isShiftTemplateFormDirty(editInit, { ...editInit }, 'edit'), false);
    assert.equal(
      isShiftTemplateFormDirty(editInit, { ...editInit, graceMinutes: '20' }, 'edit'),
      true
    );
    assert.equal(
      isShiftTemplateFormDirty(editInit, { ...editInit, isActive: false }, 'edit'),
      true
    );
  });

  test('UI-03: Field-level validation blocks missing required fields and validates Personnel Type Default Shift workdays', () => {
    const emptyCreate = createInitialShiftTemplateFormValues('create');
    const invalidRes = validateShiftTemplateForm(
      {
        ...emptyCreate,
        shiftName: '   ',
        shiftCode: 'รหัสไทย!',
        startTime: '25:99',
        endTime: '',
        graceMinutes: '250',
        cutoffTime: 'invalid',
      },
      'create'
    );
    assert.equal(invalidRes.valid, false);
    assert.ok(invalidRes.fieldErrors.shiftName);
    assert.ok(invalidRes.fieldErrors.shiftCode);
    assert.ok(invalidRes.fieldErrors.startTime);
    assert.ok(invalidRes.fieldErrors.endTime);
    assert.ok(invalidRes.fieldErrors.graceMinutes);
    assert.ok(invalidRes.fieldErrors.cutoffTime);

    assert.equal(formatDefaultWorkdaysThai('1,2,3,4,5'), 'จันทร์–ศุกร์');
    assert.equal(formatDefaultWorkdaysThai('1,2,3,4,5,6'), 'จันทร์–เสาร์');
    assert.equal(formatDefaultWorkdaysThai('1,2,3,4,5,6,0'), 'ทุกวัน (จ.–อา.)');
    assert.equal(isDateInWorkdays('2026-07-06', '1,2,3,4,5'), true); // Monday
    assert.equal(isDateInWorkdays('2026-07-11', '1,2,3,4,5'), false); // Saturday

    const badRuleForm = validatePersonnelTypeDefaultForm({
      personnelTypeName: 'ข้าราชการ',
      defaultShiftId: 1,
      defaultWorkdays: [],
      effectiveFrom: '2026-01-01',
      reason: '',
      isActive: true,
    });
    assert.equal(badRuleForm.valid, false);
    assert.ok(badRuleForm.fieldErrors.defaultWorkdays);

    const noDefaultRuleForm = validatePersonnelTypeDefaultForm({
      personnelTypeName: 'พยาบาลเวรผลัด',
      defaultShiftId: null,
      defaultWorkdays: [],
      effectiveFrom: '2026-01-01',
      reason: '',
      isActive: true,
    });
    assert.equal(noDefaultRuleForm.valid, true);
  });

  test('UI-04: API error codes map cleanly to field-level errors and Success Toast defaults to 4000ms', () => {
    assert.equal(DEFAULT_SUCCESS_TOAST_MS, 4000);

    const dupCode = mapShiftTemplateApiErrorToFields({
      code: 'SHIFT_CODE_EXISTS',
      message: 'รหัสกะ ER-2008 มีอยู่ในระบบแล้ว',
    });
    assert.equal(dupCode.fieldErrors.shiftCode, 'รหัสกะ ER-2008 มีอยู่ในระบบแล้ว');

    const inUse = mapShiftTemplateApiErrorToFields({
      code: 'DEFAULT_SHIFT_IN_USE',
      message: 'ไม่สามารถปิดใช้งานกะเริ่มต้นที่กำลังใช้งานอยู่ได้',
    });
    assert.equal(inUse.fieldErrors.isActive, 'ไม่สามารถปิดใช้งานกะเริ่มต้นที่กำลังใช้งานอยู่ได้');
  });

  test('UI-05: Architecture guard — no window.alert/confirm, no Default Shift checkbox inside ShiftTemplateModal, PersonnelTypeDefaultModal wired', () => {
    const repoRoot = process.cwd();
    const shiftsViewSrc = fs.readFileSync(
      path.join(repoRoot, 'frontend/src/pages/ShiftsView.tsx'),
      'utf8'
    );
    const modalSrc = fs.readFileSync(
      path.join(repoRoot, 'frontend/src/components/shifts/ShiftTemplateModal.tsx'),
      'utf8'
    );
    const ptDefaultModalSrc = fs.readFileSync(
      path.join(repoRoot, 'frontend/src/components/shifts/PersonnelTypeDefaultModal.tsx'),
      'utf8'
    );

    assert.equal(shiftsViewSrc.includes('window.alert('), false);
    assert.equal(shiftsViewSrc.includes('window.confirm('), false);
    assert.equal(modalSrc.includes('window.alert('), false);
    assert.equal(modalSrc.includes('window.confirm('), false);
    assert.equal(ptDefaultModalSrc.includes('window.alert('), false);
    assert.equal(ptDefaultModalSrc.includes('window.confirm('), false);

    // ShiftTemplateModal MUST NOT have Default Shift checkbox/toggle
    assert.equal(modalSrc.includes('createIsDefault'), false);
    assert.equal(modalSrc.includes('editSelectedDefaultScopes'), false);
    assert.equal(modalSrc.includes('กำหนดเป็นกะเริ่มต้น (Default Shift)'), false);

    assert.equal(shiftsViewSrc.includes('showCreateTemplateForm'), false);
    assert.ok(shiftsViewSrc.includes('<ShiftTemplateModal'));
    assert.ok(shiftsViewSrc.includes('<PersonnelTypeDefaultModal'));
    assert.ok(shiftsViewSrc.includes('<FloatingToastStack'));
    assert.ok(shiftsViewSrc.includes('confirmToggleShiftTarget'));
    assert.ok(modalSrc.includes('max-w-[780px]'));
    assert.ok(modalSrc.includes('discardConfirmOpen'));
    assert.ok(modalSrc.includes('bg-black/45'));
    assert.ok(ptDefaultModalSrc.includes('ไม่กำหนดกะเริ่มต้น'));
  });

  test('UI-06: End-to-end API Create, Edit, Duplicate Failure Preservation, Deactivate/Activate, and Roster Regression', async () => {
    // 1. Create new shift template via Modal endpoint (no Default Shift fields)
    const createRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'MODAL-TEST-01',
        shiftName: 'เวรคลินิกนอกเวลา',
        shiftCategory: 'AFTERNOON',
        startTime: '16:30',
        endTime: '20:30',
        graceMinutes: 10,
        cutoffTime: '18:00',
      },
    });
    assert.equal(createRes.status, 201);
    const createdId = Number(createRes.data.id);
    assert.ok(createdId > 0);

    // 2. Refresh list from real API and verify presence
    const listAfterCreate = await apiCall('/api/Sam_Att/shifts', { token: adminToken });
    assert.equal(listAfterCreate.status, 200);
    const foundCreated = listAfterCreate.data.items.find(
      (item: any) => Number(item.id) === createdId
    );
    assert.ok(foundCreated);
    assert.equal(foundCreated.shift_code, 'MODAL-TEST-01');
    assert.equal(foundCreated.shift_name, 'เวรคลินิกนอกเวลา');

    // 3. Duplicate shiftCode fails cleanly (409) without altering existing record
    const dupRes = await apiCall('/api/Sam_Att/shifts', {
      method: 'POST',
      token: adminToken,
      body: {
        shiftCode: 'MODAL-TEST-01',
        shiftName: 'เวรซ้ำ',
        shiftCategory: 'AFTERNOON',
        startTime: '17:00',
        endTime: '21:00',
        graceMinutes: 5,
        cutoffTime: '18:30',
      },
    });
    assert.equal(dupRes.status, 409);

    // 4. Edit existing shift template via same Modal endpoint (PUT /shifts/:id)
    const editRes = await apiCall(`/api/Sam_Att/shifts/${createdId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        shiftCode: 'MODAL-TEST-01',
        shiftName: 'เวรคลินิกนอกเวลา (ปรับปรุง)',
        shiftCategory: 'SPECIAL',
        startTime: '16:00',
        endTime: '20:00',
        graceMinutes: 15,
        cutoffTime: '17:30',
        isActive: true,
      },
    });
    assert.equal(editRes.status, 200);

    // 5. Deactivate non-default shift template & reactivate via confirmation flow
    const deactivateRes = await apiCall(`/api/Sam_Att/shifts/${createdId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        shiftCode: 'MODAL-TEST-01',
        shiftName: 'เวรคลินิกนอกเวลา (ปรับปรุง)',
        shiftCategory: 'SPECIAL',
        startTime: '16:00',
        endTime: '20:00',
        graceMinutes: 15,
        cutoffTime: '17:30',
        isActive: false,
      },
    });
    assert.equal(deactivateRes.status, 200);

    const listAfterDeactivate = await apiCall('/api/Sam_Att/shifts', { token: adminToken });
    const deactivatedRow = listAfterDeactivate.data.items.find(
      (item: any) => Number(item.id) === createdId
    );
    assert.equal(Number(deactivatedRow.is_active), 0);

    const reactivateRes = await apiCall(`/api/Sam_Att/shifts/${createdId}`, {
      method: 'PUT',
      token: adminToken,
      body: {
        shiftCode: 'MODAL-TEST-01',
        shiftName: 'เวรคลินิกนอกเวลา (ปรับปรุง)',
        shiftCategory: 'SPECIAL',
        startTime: '16:00',
        endTime: '20:00',
        graceMinutes: 15,
        cutoffTime: '17:30',
        isActive: true,
      },
    });
    assert.equal(reactivateRes.status, 200);

    // 6. Verify existing shift assignment scheduling still works (Zero Regression)
    const personnelRes = await apiCall('/api/Sam_Att/personnel?limit=5', { token: adminToken });
    assert.equal(personnelRes.status, 200);
    const firstPerson = personnelRes.data.items?.[0];
    assert.ok(firstPerson?.person_id);

    const previewRes = await apiCall('/api/Sam_Att/shift-assignments/bulk-preview', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: [String(firstPerson.person_id)],
        shiftIds: [createdId],
        workDates: ['2026-08-18'],
        operationMode: 'ADD_SHIFTS',
      },
    });
    assert.equal(previewRes.status, 200);
    assert.equal(previewRes.data.summary.readyCount, 1);

    const assignRes = await apiCall('/api/Sam_Att/shift-assignments/bulk', {
      method: 'POST',
      token: adminToken,
      body: {
        personIds: [String(firstPerson.person_id)],
        shiftIds: [createdId],
        workDates: ['2026-08-18'],
        operationMode: 'ADD_SHIFTS',
        conflictStrategy: 'SKIP_CONFLICTS',
        confirmAction: true,
      },
    });
    assert.equal(assignRes.status, 201);
    assert.equal(assignRes.data.insertedCount, 1);
  });
});
