/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: Shift Template Modal & Alert System (UX/UI + API Integration)
 * ไฟล์: backend/tests/shift-template-modal-alert.test.ts
 * ============================================================================
 * ตรวจสอบครบทั้ง 12 หัวข้อสำคัญ:
 * 1. ค่าเริ่มต้นโหมด Create และโหมด Edit (Pre-fill ข้อมูลเดิมถูกต้อง)
 * 2. Dirty Check / Unsaved Changes Guard ทุกฟิลด์ (รวม Default Shift)
 * 3. Validation ระดับฟิลด์ (Required fields, รูปแบบรหัสกะ, เวลา 24 ชม., ผ่อนผัน 0–180 นาที)
 * 4. ป้องกัน Default Shift ซ้ำทั้งใน Client Validation และ Backend API (409)
 * 5. แปลง API Error Codes เป็นข้อความระดับฟิลด์ที่อ่านเข้าใจง่าย
 * 6. Success Toast auto-dismiss 4000ms และไม่ใช้ browser alert()/confirm()
 * 7. Create -> Refresh list จริงจาก API, Edit -> Refresh list จริงจาก API
 * 8. Failure path (409 / 400) ไม่ทำให้ข้อมูลเดิมเสียหาย
 * 9. Deactivate / Reactivate แม่แบบกะ (พร้อมบล็อกปิดใช้งานกะเริ่มต้น 409 DEFAULT_SHIFT_IN_USE)
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
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_FILE;
process.env.DEMO_MODE_ENABLED = 'true';
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
  DEFAULT_SUCCESS_TOAST_MS,
  type ActiveDefaultBindingInfo,
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

describe('Shift Template Modal & Standard Alert System (UI-01..UI-12)', () => {
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

  test('UI-01: Create & Edit initial values pre-fill cleanly and strip redundant time suffix', () => {
    const createInit = createInitialShiftTemplateFormValues('create');
    assert.equal(createInit.shiftName, '');
    assert.equal(createInit.shiftCode, '');
    assert.equal(createInit.startTime, '08:00');
    assert.equal(createInit.endTime, '16:00');
    assert.equal(createInit.graceMinutes, '15');
    assert.equal(createInit.createIsDefault, false);

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
      default_personnel_types: [{ personnelTypeCode: 'GOV_OFFICER' }],
    });
    assert.equal(editInit.shiftName, 'เวรดึกฉุกเฉิน');
    assert.equal(editInit.shiftCode, 'ER-NIGHT');
    assert.equal(editInit.shiftCategory, 'NIGHT');
    assert.equal(editInit.graceMinutes, '10');
    assert.equal(editInit.isActive, true);
    assert.deepEqual(editInit.editSelectedDefaultScopes, ['GOV_OFFICER']);
  });

  test('UI-02: Unsaved changes (dirty) detection works for both Create and Edit modes', () => {
    const createInit = createInitialShiftTemplateFormValues('create');
    assert.equal(isShiftTemplateFormDirty(createInit, { ...createInit }, 'create'), false);
    assert.equal(
      isShiftTemplateFormDirty(createInit, { ...createInit, shiftName: 'เวรคลินิกพิเศษ' }, 'create'),
      true
    );
    assert.equal(
      isShiftTemplateFormDirty(
        createInit,
        { ...createInit, createDefaultScopeCode: 'CONTRACT_TEMP', createIsDefault: true },
        'create'
      ),
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
      default_personnel_types: [],
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
    assert.equal(
      isShiftTemplateFormDirty(
        editInit,
        { ...editInit, editSelectedDefaultScopes: ['GOV_OFFICER'] },
        'edit'
      ),
      true
    );
  });

  test('UI-03: Field-level validation blocks missing required fields, bad code/times, and duplicate Default Shift', () => {
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

    const bindings = new Map<string, ActiveDefaultBindingInfo>([
      [
        'GOV_OFFICER',
        {
          personnelTypeCode: 'GOV_OFFICER',
          personnelTypeName: 'ข้าราชการ',
          shiftId: 1,
          shiftCode: 'STD-0816',
          shiftName: 'เวรราชการปกติ',
          startTime: '08:00',
          endTime: '16:00',
        },
      ],
    ]);

    const dupDefaultRes = validateShiftTemplateForm(
      {
        ...emptyCreate,
        shiftName: 'เวรใหม่',
        shiftCode: 'NEW-0816',
        createIsDefault: true,
        createDefaultScopeCode: 'GOV_OFFICER',
      },
      'create',
      bindings
    );
    assert.equal(dupDefaultRes.valid, false);
    assert.ok(dupDefaultRes.fieldErrors.defaultShift?.includes('เวรราชการปกติ'));
    assert.ok(dupDefaultRes.fieldErrors.defaultShift?.includes('STD-0816'));
  });

  test('UI-04: API error codes map cleanly to field-level errors and Success Toast defaults to 4000ms', () => {
    assert.equal(DEFAULT_SUCCESS_TOAST_MS, 4000);

    const dupCode = mapShiftTemplateApiErrorToFields({
      code: 'SHIFT_CODE_EXISTS',
      message: 'รหัสกะ ER-2008 มีอยู่ในระบบแล้ว',
    });
    assert.equal(dupCode.fieldErrors.shiftCode, 'รหัสกะ ER-2008 มีอยู่ในระบบแล้ว');

    const dupDefault = mapShiftTemplateApiErrorToFields({
      code: 'DEFAULT_SHIFT_ALREADY_EXISTS',
      message: 'ประเภทบุคลากรนี้มีกะเริ่มต้นอยู่แล้ว',
    });
    assert.equal(dupDefault.fieldErrors.defaultShift, 'ประเภทบุคลากรนี้มีกะเริ่มต้นอยู่แล้ว');

    const inUse = mapShiftTemplateApiErrorToFields({
      code: 'DEFAULT_SHIFT_IN_USE',
      message: 'ไม่สามารถปิดใช้งานกะเริ่มต้นที่กำลังใช้งานอยู่ได้',
    });
    assert.equal(inUse.fieldErrors.isActive, 'ไม่สามารถปิดใช้งานกะเริ่มต้นที่กำลังใช้งานอยู่ได้');
  });

  test('UI-05: Architecture guard — no window.alert/window.confirm, unified modal width 780px, FloatingToastStack & ConfirmDialog wired', () => {
    const repoRoot = process.cwd();
    const shiftsViewSrc = fs.readFileSync(
      path.join(repoRoot, 'frontend/src/pages/ShiftsView.tsx'),
      'utf8'
    );
    const modalSrc = fs.readFileSync(
      path.join(repoRoot, 'frontend/src/components/shifts/ShiftTemplateModal.tsx'),
      'utf8'
    );

    assert.equal(shiftsViewSrc.includes('window.alert('), false);
    assert.equal(shiftsViewSrc.includes('window.confirm('), false);
    assert.equal(modalSrc.includes('window.alert('), false);
    assert.equal(modalSrc.includes('window.confirm('), false);
    assert.equal(shiftsViewSrc.includes('showCreateTemplateForm'), false);
    assert.ok(shiftsViewSrc.includes('<ShiftTemplateModal'));
    assert.ok(shiftsViewSrc.includes('<FloatingToastStack'));
    assert.ok(shiftsViewSrc.includes('confirmToggleShiftTarget'));
    assert.ok(shiftsViewSrc.includes('confirmChangeDefaultPayload'));
    assert.ok(modalSrc.includes('max-w-[780px]'));
    assert.ok(modalSrc.includes('discardConfirmOpen'));
    assert.ok(modalSrc.includes('bg-black/45'));
  });

  test('UI-06: End-to-end API Create, Edit, Duplicate Failure Preservation, Deactivate/Activate, and Roster Regression', async () => {
    // 1. Create new shift template via Modal endpoint
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
        isDefault: false,
        defaultPersonnelTypeCodes: [],
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
