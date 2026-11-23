/**
 * ============================================================================
 * ยูทิลิตี้สถานะฟอร์ม การตรวจสอบข้อมูล และวันทำงานสำหรับแม่แบบกะทำงาน
 * และกฎกะเริ่มต้นตามประเภทบุคลากร
 * ไฟล์: frontend/src/utils/shiftTemplateForm.ts
 * ============================================================================
 * แยก Pure Functions เพื่อความเสถียร ตรวจสอบได้ด้วย Automated Tests ครบทุกกรณี:
 * - สร้างค่าเริ่มต้นของฟอร์มแม่แบบกะทำงาน (เฉพาะ 7 ฟิลด์หลัก + สถานะใช้งานในโหมดแก้ไข)
 * - ไม่มีการกำหนด Default Shift ภายในฟอร์มแม่แบบกะทำงาน (ย้ายไปกำหนดที่ประเภทบุคลากรจุดเดียว)
 * - ตรวจจับการแก้ไขค้างไว้ (Unsaved Changes / Dirty Check)
 * - ตรวจสอบ Required Fields และรูปแบบเวลา/ตัวเลขพร้อมข้อความผิดพลาดใต้ฟิลด์
 * - แปลง/ตรวจสอบวันทำงานของกะเริ่มต้น (default_workdays) เช่น จันทร์–ศุกร์, จันทร์–เสาร์, ทุกวัน
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
  defaultWorkdays?: string;
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
}

export type ShiftTemplateFieldKey =
  | 'shiftName'
  | 'shiftCode'
  | 'shiftCategory'
  | 'startTime'
  | 'endTime'
  | 'graceMinutes'
  | 'cutoffTime'
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

export const DEFAULT_ALL_WORKDAYS_CSV = '1,2,3,4,5,6,0';

export const WEEKDAY_OPTIONS: ReadonlyArray<{
  value: number;
  shortLabel: string;
  fullLabel: string;
}> = [
  { value: 1, shortLabel: 'จ.', fullLabel: 'จันทร์' },
  { value: 2, shortLabel: 'อ.', fullLabel: 'อังคาร' },
  { value: 3, shortLabel: 'พ.', fullLabel: 'พุธ' },
  { value: 4, shortLabel: 'พฤ.', fullLabel: 'พฤหัสบดี' },
  { value: 5, shortLabel: 'ศ.', fullLabel: 'ศุกร์' },
  { value: 6, shortLabel: 'ส.', fullLabel: 'เสาร์' },
  { value: 0, shortLabel: 'อา.', fullLabel: 'อาทิตย์' },
];

export const WORKDAY_PRESETS: ReadonlyArray<{
  key: 'MON_FRI' | 'MON_SAT' | 'ALL_DAYS';
  label: string;
  csv: string;
  days: number[];
}> = [
  { key: 'MON_FRI', label: 'จันทร์–ศุกร์', csv: '1,2,3,4,5', days: [1, 2, 3, 4, 5] },
  { key: 'MON_SAT', label: 'จันทร์–เสาร์', csv: '1,2,3,4,5,6', days: [1, 2, 3, 4, 5, 6] },
  { key: 'ALL_DAYS', label: 'ทุกวัน (จ.–อา.)', csv: '1,2,3,4,5,6,0', days: [1, 2, 3, 4, 5, 6, 0] },
];

const CANONICAL_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseWorkdaysCsv(csv: string | null | undefined): number[] {
  if (csv === null || csv === undefined || String(csv).trim() === '') {
    return [1, 2, 3, 4, 5, 6, 0];
  }
  const tokens = String(csv)
    .split(',')
    .map((t) => Number(t.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
  const set = new Set(tokens);
  return CANONICAL_DAY_ORDER.filter((d) => set.has(d));
}

export function serializeWorkdays(days: number[]): string {
  const set = new Set(days.filter((n) => Number.isInteger(n) && n >= 0 && n <= 6));
  return CANONICAL_DAY_ORDER.filter((d) => set.has(d)).join(',');
}

export function formatDefaultWorkdaysThai(csv: string | null | undefined): string {
  const days = parseWorkdaysCsv(csv);
  if (days.length === 0) return 'ไม่ได้กำหนดวันทำงาน';
  const normalized = days.join(',');
  if (normalized === '1,2,3,4,5,6,0') return 'ทุกวัน (จ.–อา.)';
  if (normalized === '1,2,3,4,5') return 'จันทร์–ศุกร์';
  if (normalized === '1,2,3,4,5,6') return 'จันทร์–เสาร์';
  if (normalized === '6,0') return 'เสาร์–อาทิตย์';
  return days
    .map((d) => WEEKDAY_OPTIONS.find((w) => w.value === d)?.shortLabel || '')
    .filter(Boolean)
    .join(', ');
}

export function isDateInWorkdays(
  dateStr: string,
  csv: string | null | undefined
): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || '').trim());
  if (!m) return false;
  const weekday = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  ).getUTCDay();
  const days = parseWorkdaysCsv(csv);
  return days.includes(weekday);
}

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
  } | null
): ShiftTemplateFormValues {
  if (mode === 'edit' && shiftRow) {
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

  if (mode === 'edit') {
    if (initial.isActive !== current.isActive) return true;
  }

  return false;
}

export function validateShiftTemplateForm(
  values: ShiftTemplateFormValues,
  _mode: ShiftTemplateModalMode
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
    fieldErrors.shiftCode =
      'รหัสกะต้องเป็นตัวอักษรภาษาอังกฤษ ตัวเลข หรือขีด (-, _) ความยาว 2–32 ตัวอักษร';
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

  if (Object.keys(fieldErrors).length > 0) {
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

export interface PersonnelTypeDefaultFormValues {
  personnelTypeName: string;
  defaultShiftId: number | null;
  defaultWorkdays: number[];
  effectiveFrom: string;
  reason: string;
  isActive: boolean;
}

export type PersonnelTypeDefaultFieldKey =
  | 'personnelTypeName'
  | 'defaultShiftId'
  | 'defaultWorkdays'
  | 'effectiveFrom';

export function isPersonnelTypeDefaultFormDirty(
  initial: PersonnelTypeDefaultFormValues,
  current: PersonnelTypeDefaultFormValues
): boolean {
  if (initial.personnelTypeName.trim() !== current.personnelTypeName.trim()) return true;
  if ((initial.defaultShiftId ?? null) !== (current.defaultShiftId ?? null)) return true;
  if (serializeWorkdays(initial.defaultWorkdays) !== serializeWorkdays(current.defaultWorkdays)) {
    return true;
  }
  if (initial.effectiveFrom !== current.effectiveFrom) return true;
  if (initial.reason.trim() !== current.reason.trim()) return true;
  if (initial.isActive !== current.isActive) return true;
  return false;
}

export function validatePersonnelTypeDefaultForm(values: PersonnelTypeDefaultFormValues): {
  valid: boolean;
  fieldErrors: Partial<Record<PersonnelTypeDefaultFieldKey, string>>;
  formError: string | null;
} {
  const fieldErrors: Partial<Record<PersonnelTypeDefaultFieldKey, string>> = {};

  if (!values.personnelTypeName.trim()) {
    fieldErrors.personnelTypeName = 'กรุณาระบุชื่อประเภทบุคลากร';
  }

  if (values.defaultShiftId !== null && values.defaultWorkdays.length === 0) {
    fieldErrors.defaultWorkdays = 'กรุณาเลือกวันทำงานอย่างน้อย 1 วันเมื่อกำหนดกะเริ่มต้น';
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(values.effectiveFrom || '').trim())) {
    fieldErrors.effectiveFrom = 'กรุณาระบุวันที่เริ่มมีผลบังคับใช้ให้ถูกต้อง (YYYY-MM-DD)';
  }

  if (Object.keys(fieldErrors).length > 0) {
    return {
      valid: false,
      fieldErrors,
      formError: 'กรุณาตรวจสอบข้อมูลการตั้งค่ากะเริ่มต้นให้ครบถ้วนก่อนบันทึก',
    };
  }

  return {
    valid: true,
    fieldErrors: {},
    formError: null,
  };
}
