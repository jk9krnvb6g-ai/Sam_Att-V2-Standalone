/**
 * ============================================================================
 * ยูทิลิตี้สถานะฟอร์ม การตรวจสอบข้อมูล และแผนที่ข้อผิดพลาดสำหรับ Shift Template Modal
 * ไฟล์: frontend/src/utils/shiftTemplateForm.ts
 * ============================================================================
 * แยก Pure Functions เพื่อความเสถียร ตรวจสอบได้ด้วย Automated Tests ครบทุกกรณี:
 * - สร้างค่าเริ่มต้นของฟอร์มสำหรับโหมด Create และ Edit
 * - ตรวจจับการแก้ไขค้างไว้ (Unsaved Changes / Dirty Check)
 * - ตรวจสอบ Required Fields และรูปแบบเวลา/ตัวเลขพร้อมข้อความผิดพลาดใต้ฟิลด์
 * - ตรวจจับกฎ Default Shift ไม่ให้กำหนดซ้ำในประเภทบุคลากรเดียวกัน
 * - แปลง Error Code จาก Backend API เป็นข้อความผิดพลาดระดับฟิลด์ที่ชัดเจน
 */
import { cleanShiftDisplayName } from './shiftDisplay.ts';

export type ShiftTemplateModalMode = 'create' | 'edit';

export interface ActiveDefaultBindingInfo {
  personnelTypeCode: string;
  personnelTypeName: string;
  shiftId: number;
  shiftCode: string;
  shiftName: string;
  startTime: string;
  endTime: string;
}

export interface ShiftTemplateFormValues {
  shiftName: string;
  shiftCode: string;
  shiftCategory: string;
  startTime: string;
  endTime: string;
  graceMinutes: string;
  cutoffTime: string;
  isActive: boolean;
  createIsDefault: boolean;
  createDefaultScopeCode: string;
  editSelectedDefaultScopes: string[];
  defaultReason: string;
}

export type ShiftTemplateFieldKey =
  | 'shiftName'
  | 'shiftCode'
  | 'shiftCategory'
  | 'startTime'
  | 'endTime'
  | 'graceMinutes'
  | 'cutoffTime'
  | 'defaultShift'
  | 'isActive';

export type ShiftTemplateFieldErrors = Partial<Record<ShiftTemplateFieldKey, string>>;

export interface ShiftTemplateValidationResult {
  valid: boolean;
  fieldErrors: ShiftTemplateFieldErrors;
  formError: string | null;
}

export interface FloatingToastItem {
  id: string;
  variant: 'success' | 'error' | 'warning';
  message: string;
  detail?: string;
  requestId?: string;
  durationMs: number;
}

export const DEFAULT_SUCCESS_TOAST_MS = 4000;
export const DEFAULT_WARNING_TOAST_MS = 5000;
export const DEFAULT_ERROR_TOAST_MS = 6500;

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function createInitialShiftTemplateFormValues(
  mode: ShiftTemplateModalMode,
  shiftRow?: {
    id?: number;
    shift_code?: string;
    shift_name?: string;
    shift_category?: string;
    start_time?: string;
    end_time?: string;
    grace_minutes?: number | string;
    cutoff_time?: string;
    is_active?: number | boolean;
    default_personnel_types?: Array<{
      personnelTypeCode?: string;
      personnel_type_code?: string;
    }>;
  } | null
): ShiftTemplateFormValues {
  if (mode === 'edit' && shiftRow) {
    const boundCodes = Array.isArray(shiftRow.default_personnel_types)
      ? shiftRow.default_personnel_types
          .map((d) =>
            String(d.personnelTypeCode || d.personnel_type_code || '')
              .trim()
              .toUpperCase()
          )
          .filter(Boolean)
          .sort()
      : [];
    return {
      shiftName: cleanShiftDisplayName(shiftRow.shift_name),
      shiftCode: String(shiftRow.shift_code || '').trim(),
      shiftCategory: String(shiftRow.shift_category || 'OFFICIAL').trim().toUpperCase(),
      startTime: String(shiftRow.start_time || '08:00').trim(),
      endTime: String(shiftRow.end_time || '16:00').trim(),
      graceMinutes: String(
        shiftRow.grace_minutes !== undefined && shiftRow.grace_minutes !== null
          ? Number(shiftRow.grace_minutes)
          : 15
      ),
      cutoffTime: String(shiftRow.cutoff_time || '10:30').trim(),
      isActive: Number(shiftRow.is_active ?? 1) === 1,
      createIsDefault: false,
      createDefaultScopeCode: '',
      editSelectedDefaultScopes: boundCodes,
      defaultReason: '',
    };
  }

  return {
    shiftName: '',
    shiftCode: '',
    shiftCategory: 'OFFICIAL',
    startTime: '08:00',
    endTime: '16:00',
    graceMinutes: '15',
    cutoffTime: '10:30',
    isActive: true,
    createIsDefault: false,
    createDefaultScopeCode: '',
    editSelectedDefaultScopes: [],
    defaultReason: '',
  };
}

export function isShiftTemplateFormDirty(
  initial: ShiftTemplateFormValues,
  current: ShiftTemplateFormValues,
  mode: ShiftTemplateModalMode
): boolean {
  if (initial.shiftName.trim() !== current.shiftName.trim()) return true;
  if (initial.shiftCode.trim() !== current.shiftCode.trim()) return true;
  if (initial.shiftCategory !== current.shiftCategory) return true;
  if (initial.startTime !== current.startTime) return true;
  if (initial.endTime !== current.endTime) return true;
  if (initial.graceMinutes.trim() !== current.graceMinutes.trim()) return true;
  if (initial.cutoffTime !== current.cutoffTime) return true;
  if (initial.defaultReason.trim() !== current.defaultReason.trim()) return true;

  if (mode === 'create') {
    if (initial.createIsDefault !== current.createIsDefault) return true;
    if (initial.createDefaultScopeCode !== current.createDefaultScopeCode) return true;
  } else {
    if (initial.isActive !== current.isActive) return true;
    const initSorted = [...initial.editSelectedDefaultScopes].sort().join(',');
    const curSorted = [...current.editSelectedDefaultScopes].sort().join(',');
    if (initSorted !== curSorted) return true;
  }

  return false;
}

export function validateShiftTemplateForm(
  values: ShiftTemplateFormValues,
  mode: ShiftTemplateModalMode,
  defaultBindingByTypeCode?: Map<string, ActiveDefaultBindingInfo>,
  editingShiftId?: number | null
): ShiftTemplateValidationResult {
  const fieldErrors: ShiftTemplateFieldErrors = {};

  const trimmedName = values.shiftName.trim();
  const trimmedCode = values.shiftCode.trim();
  const trimmedStart = values.startTime.trim();
  const trimmedEnd = values.endTime.trim();
  const trimmedCutoff = values.cutoffTime.trim();
  const trimmedGrace = values.graceMinutes.trim();

  if (!trimmedName) {
    fieldErrors.shiftName = 'กรุณาระบุชื่อแม่แบบกะทำงาน';
  } else if (trimmedName.length > 120) {
    fieldErrors.shiftName = 'ชื่อแม่แบบกะทำงานต้องไม่เกิน 120 ตัวอักษร';
  }

  if (!trimmedCode) {
    fieldErrors.shiftCode = 'กรุณาระบุรหัสกะทำงาน';
  } else if (!/^[A-Za-z0-9_-]{2,32}$/.test(trimmedCode)) {
    fieldErrors.shiftCode = 'รหัสกะต้องเป็นตัวอักษรภาษาอังกฤษ ตัวเลข หรือขีด (-, _) ความยาว 2–32 ตัวอักษร';
  }

  if (!values.shiftCategory.trim()) {
    fieldErrors.shiftCategory = 'กรุณาเลือกหมวดหมู่กะ';
  }

  if (!HHMM_REGEX.test(trimmedStart)) {
    fieldErrors.startTime = 'กรุณาระบุเวลาเริ่มงานให้ถูกต้อง (รูปแบบ 24 ชม. เช่น 08:00)';
  }

  if (!HHMM_REGEX.test(trimmedEnd)) {
    fieldErrors.endTime = 'กรุณาระบุเวลาเลิกงานให้ถูกต้อง (รูปแบบ 24 ชม. เช่น 16:00)';
  }

  if (!HHMM_REGEX.test(trimmedCutoff)) {
    fieldErrors.cutoffTime = 'กรุณาระบุเวลาตัดรอบสแกนให้ถูกต้อง (รูปแบบ 24 ชม. เช่น 10:30)';
  }

  const graceNum = Number(trimmedGrace);
  if (trimmedGrace === '' || !Number.isFinite(graceNum) || !Number.isInteger(graceNum)) {
    fieldErrors.graceMinutes = 'กรุณาระบุเวลาผ่อนผันการมาสายเป็นจำนวนเต็ม (นาที)';
  } else if (graceNum < 0 || graceNum > 180) {
    fieldErrors.graceMinutes = 'เวลาผ่อนผันการมาสายต้องอยู่ระหว่าง 0 ถึง 180 นาที';
  }

  // ตรวจสอบกฎ Default Shift
  if (mode === 'create' && values.createIsDefault) {
    const scopeNorm = values.createDefaultScopeCode.trim().toUpperCase();
    if (!scopeNorm) {
      fieldErrors.defaultShift = 'กรุณาเลือกประเภทบุคลากรเป้าหมายก่อนกำหนดเป็นกะเริ่มต้น';
    } else if (defaultBindingByTypeCode) {
      const existing = defaultBindingByTypeCode.get(scopeNorm);
      if (existing) {
        fieldErrors.defaultShift = `ประเภทบุคลากร "${existing.personnelTypeName}" มีกะเริ่มต้นอยู่แล้วคือ "${cleanShiftDisplayName(existing.shiftName)}" (${existing.shiftCode}) ไม่สามารถกำหนดซ้ำได้`;
      }
    }
  }

  if (mode === 'edit' && defaultBindingByTypeCode && editingShiftId != null) {
    for (const rawScope of values.editSelectedDefaultScopes) {
      const scopeNorm = rawScope.trim().toUpperCase();
      const existing = defaultBindingByTypeCode.get(scopeNorm);
      if (existing && Number(existing.shiftId) !== Number(editingShiftId)) {
        fieldErrors.defaultShift = `ประเภทบุคลากร "${existing.personnelTypeName}" มีกะเริ่มต้นอื่นอยู่แล้วคือ "${cleanShiftDisplayName(existing.shiftName)}" (${existing.shiftCode}) ไม่สามารถกำหนดซ้ำได้`;
        break;
      }
    }
  }

  const errorKeys = Object.keys(fieldErrors);
  if (errorKeys.length > 0) {
    return {
      valid: false,
      fieldErrors,
      formError: 'กรุณาตรวจสอบข้อมูลที่กรอกให้ครบถ้วนและถูกต้องก่อนบันทึก',
    };
  }

  return {
    valid: true,
    fieldErrors: {},
    formError: null,
  };
}

export function mapShiftTemplateApiErrorToFields(err: {
  code?: string;
  message?: string;
}): {
  fieldErrors: ShiftTemplateFieldErrors;
  formError: string;
} {
  const code = String(err.code || '').trim().toUpperCase();
  const message = String(err.message || 'ไม่สามารถบันทึกแม่แบบกะทำงานได้ กรุณาลองใหม่อีกครั้ง');
  const fieldErrors: ShiftTemplateFieldErrors = {};

  if (code === 'SHIFT_CODE_EXISTS' || code === 'DUPLICATE_SHIFT_CODE') {
    fieldErrors.shiftCode = message;
  } else if (code === 'DEFAULT_SHIFT_ALREADY_EXISTS') {
    fieldErrors.defaultShift = message;
  } else if (code === 'DEFAULT_SHIFT_IN_USE') {
    fieldErrors.isActive = message;
  } else if (code === 'VALIDATION_ERROR' || code === 'INVALID_INPUT') {
    if (message.includes('รหัสกะ')) fieldErrors.shiftCode = message;
    if (message.includes('ชื่อกะ') || message.includes('ชื่อแม่แบบ')) fieldErrors.shiftName = message;
    if (message.includes('เวลาเริ่ม')) fieldErrors.startTime = message;
    if (message.includes('เวลาเลิก')) fieldErrors.endTime = message;
    if (message.includes('ผ่อนผัน')) fieldErrors.graceMinutes = message;
    if (message.includes('ตัดรอบ')) fieldErrors.cutoffTime = message;
  }

  return {
    fieldErrors,
    formError: message,
  };
}
