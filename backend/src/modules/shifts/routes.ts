/**
 * ============================================================================
 * โมดูลจัดการแม่แบบกะทำงาน กฎกะเช้าเริ่มต้นตามประเภทบุคลากร และการมอบหมายตารางเวร
 * ไฟล์: backend/src/modules/shifts/routes.ts
 * ============================================================================
 * คุณสมบัติหลัก:
 * 1. GET/POST/PUT/PATCH /personnel-type-rules: จัดการกฎกะเช้าเริ่มต้นตามประเภทบุคลากร
 *    พร้อมวันที่มีผลบังคับใช้ (effective_from) และบันทึกประวัติการแก้ไข (personnel_type_rule_history)
 * 2. GET/POST/PUT/PATCH /shifts: จัดการแม่แบบกะทำงาน (กะเช้า, กะบ่าย, กะดึก, กะเช้า–บ่าย, กะบ่าย–ดึก, กะทั้งวัน, กะพิเศษ)
 * 3. ลำดับความสำคัญของการใช้เวร (Shift Priority Engine):
 *    - ตรวจตารางเวรรายวันของบุคลากร (shift_daily_overrides + shift_assignments)
 *    - หากตั้งใจยกเลิกทุกกะ (CLEARED_ALL_SHIFTS) -> วันนั้นไม่มีเวร (0 กะ) และจะไม่ดึงกะเริ่มต้นกลับมาเอง
 *    - หากกำหนดเวรเองแล้ว (CUSTOM_ASSIGNED) -> ใช้เวรที่กำหนด
 *    - หากยังไม่เคยกำหนด (DEFAULT_FROM_TYPE) หรือคืนค่ากะเริ่มต้น (RESTORED_DEFAULT) -> ใช้กะเช้าเริ่มต้นตามประเภทบุคลากร
 *    - หากประเภทบุคลากรยังไม่ได้ตั้งค่ากะเริ่มต้น -> แจ้งสถานะ UNCONFIGURED_DEFAULT_RULE โดยไม่เดาเวลาทำงานเอง
 * 4. POST /shift-assignments/daily-cell-action: จัดการเวรรายช่องตารางของบุคลากร 1 คนโดยตรง
 *    (เพิ่มกะ, เปลี่ยนกะ, ลบกะเช้า, ลบกะบ่าย, ลบกะทั้งหมด/ไม่มีเวร, คืนค่ากะเริ่มต้น)
 * 5. GET /shift-assignments/import-template.xlsx & POST /shift-assignments/import-excel/preview|confirm:
 *    นำเข้าตารางเวรจากไฟล์ Excel (.xlsx) พร้อมตรวจสอบความถูกต้องและแสดงตัวอย่างก่อนยืนยัน
 * ============================================================================
 */
import { Router } from 'express';
import {
  dbQuery,
  dbExecute,
  dbTransaction,
  type DbTransactionContext,
} from '../../database/adapter.ts';
import { loadConfig } from '../../config/env.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  buildXlsxBufferFromRows,
  extractScheduleRecordsFromXlsxBuffer,
  normalizeExcelWorkDate,
  type ParsedScheduleExcelRow,
} from '../../utils/xlsx.ts';
import { findClosedPeriodsInDates, isPeriodClosed } from '../periods/lock.ts';
import {
  holidayRowToPublicHolidayAdapter,
  loadHospitalHolidaysForRange,
  resolveHolidayForPersonDate,
} from '../holidays/service.ts';

export const shiftsRouter = Router();

export interface ShiftRow {
  id: number;
  shift_code: string;
  shift_name: string;
  shift_category: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  cutoff_time: string;
  is_cross_midnight: number;
  is_active: number;
}

export interface PersonnelTypeRuleRow {
  id: number;
  personnel_type_code: string;
  personnel_type_name: string;
  default_start_time: string;
  default_end_time: string;
  default_grace_minutes: number;
  default_cutoff_time: string;
  effective_from: string;
  is_active: number;
  CheckinWindowBeforeMinutes: number;
  CheckoutWindowAfterMinutes: number;
  require_checkout: number;
  allow_overlapping_shifts: number;
  rule_version: string;
  updated_at?: string;
  default_shift_id?: number | null;
  default_shift_code?: string | null;
  default_shift_name?: string | null;
  default_shift_category?: string | null;
  default_shift_start_time?: string | null;
  default_shift_end_time?: string | null;
  default_shift_grace_minutes?: number | null;
  default_shift_cutoff_time?: string | null;
  default_shift_is_cross_midnight?: number | null;
  default_shift_is_active?: number | null;
  default_assigned_by?: string | null;
  default_assigned_reason?: string | null;
  default_updated_at?: string | null;
  default_workdays?: string | null;
}

export interface PublicHolidayRow {
  id: number;
  holiday_date: string;
  holiday_name: string;
  holiday_type: string;
  is_active: number;
  created_by?: string;
  created_at?: string;
}

export const DEFAULT_ALL_WORKDAYS = '1,2,3,4,5,6,0';
const WORKDAY_DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * จัดรูปแบบวันทำงานที่ Default Shift มีผลให้เป็นมาตรฐาน CSV ของเลขวัน (0=อา., 1=จ., ..., 6=ส.)
 * เรียงตามลำดับสัปดาห์การทำงานไทย (จ.–อา.) และตัดค่าซ้ำออก
 */
export function normalizeDefaultWorkdays(
  raw: unknown,
  fallback: string = DEFAULT_ALL_WORKDAYS
): string {
  if (raw === undefined || raw === null) {
    return fallback;
  }
  const tokens: string[] = Array.isArray(raw)
    ? raw.map((item) => String(item).trim())
    : String(raw)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

  if (tokens.length === 0) {
    return '';
  }

  const validSet = new Set<number>();
  for (const tok of tokens) {
    if (/^[0-6]$/.test(tok)) {
      validSet.add(Number(tok));
    }
  }
  if (validSet.size === 0) {
    return '';
  }
  return WORKDAY_DISPLAY_ORDER.filter((d) => validSet.has(d)).join(',');
}

export function getWorkDateWeekdayNumber(workDate: string): number {
  const normalized = normalizeWorkDateString(workDate);
  const [yStr, mStr, dStr] = normalized.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const d = Number(dStr);
  if (!y || !m || !d) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function isWorkDateMatchingDefaultWorkdays(
  workDate: string,
  defaultWorkdays: string | null | undefined
): boolean {
  if (defaultWorkdays === undefined || defaultWorkdays === null) {
    return true;
  }
  const trimmed = String(defaultWorkdays).trim();
  if (!trimmed) {
    return false;
  }
  const weekday = getWorkDateWeekdayNumber(workDate);
  if (weekday < 0) return false;
  const allowed = new Set(
    trimmed
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^[0-6]$/.test(s))
      .map(Number)
  );
  return allowed.has(weekday);
}

export function isFullDayPersonalHolidayLeaveType(leaveType: unknown): boolean {
  const norm = String(leaveType || '').trim().toUpperCase();
  return norm === 'FULL_DAY' || norm === 'PERSONAL_HOLIDAY' || norm === 'DAY_OFF';
}

export async function loadActivePublicHolidaysMap(
  dateFrom: string,
  dateTo: string,
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]> = dbQuery
): Promise<Map<string, PublicHolidayRow>> {
  const map = new Map<string, PublicHolidayRow>();
  try {
    const rows = await queryRunner<PublicHolidayRow>(
      `SELECT id, holiday_date, holiday_name, holiday_type, is_active, created_by, created_at
       FROM public_holidays
       WHERE is_active = 1
         AND holiday_date >= ?
         AND holiday_date <= ?
       ORDER BY holiday_date ASC`,
      [normalizeWorkDateString(dateFrom), normalizeWorkDateString(dateTo)]
    );
    for (const row of rows) {
      const dateStr = normalizeWorkDateString(row.holiday_date);
      if (dateStr) {
        map.set(dateStr, {
          ...row,
          holiday_date: dateStr,
        });
      }
    }
  } catch {
    // ปลอดภัยกรณี Production ยังไม่ได้รัน Migration 005_default_shift_by_personnel_type.sql
  }
  return map;
}

export interface DefaultShiftBindingSummary {
  personnelTypeCode: string;
  personnelTypeName: string;
  isRuleActive: boolean;
  effectiveFrom: string;
  defaultWorkdays: string;
  defaultShiftId: number | null;
  defaultShiftCode: string | null;
  defaultShiftName: string | null;
  defaultStartTime: string | null;
  defaultEndTime: string | null;
  defaultGraceMinutes: number | null;
  defaultCutoffTime: string | null;
  defaultIsCrossMidnight: number;
  assignedBy: string | null;
  assignedReason: string | null;
  updatedAt: string | null;
}

function isUniqueConstraintError(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string } | null;
  const code = String(e?.code || '').toUpperCase();
  const msg = String(e?.message || '');
  return (
    code === 'ER_DUP_ENTRY' ||
    e?.errno === 1062 ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    /UNIQUE\s+constraint\s+failed/i.test(msg) ||
    /Duplicate\s+entry/i.test(msg)
  );
}

const defaultShiftScopeLockChains = new Map<string, Promise<void>>();

async function withDefaultShiftScopeLocks<T>(
  scopeCodes: string[],
  work: () => Promise<T>
): Promise<T> {
  const sortedUnique = Array.from(
    new Set(scopeCodes.map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))
  ).sort();
  if (sortedUnique.length === 0) {
    return work();
  }

  const runRecursive = async (index: number): Promise<T> => {
    if (index >= sortedUnique.length) {
      return work();
    }
    const key = sortedUnique[index];
    const previous = defaultShiftScopeLockChains.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    defaultShiftScopeLockChains.set(key, tail);

    await previous;
    try {
      return await runRecursive(index + 1);
    } finally {
      release();
      if (defaultShiftScopeLockChains.get(key) === tail) {
        defaultShiftScopeLockChains.delete(key);
      }
    }
  };

  return runRecursive(0);
}

export async function loadPersonnelTypeRulesWithDefaultShifts(
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]> = dbQuery
): Promise<PersonnelTypeRuleRow[]> {
  try {
    const rows = await queryRunner<
      PersonnelTypeRuleRow & { resolved_default_shift_id?: number | null }
    >(
      `SELECT r.*,
              COALESCE(ds.shift_id, r.default_shift_id) AS resolved_default_shift_id,
              s.shift_code AS default_shift_code,
              s.shift_name AS default_shift_name,
              s.shift_category AS default_shift_category,
              s.start_time AS default_shift_start_time,
              s.end_time AS default_shift_end_time,
              s.grace_minutes AS default_shift_grace_minutes,
              s.cutoff_time AS default_shift_cutoff_time,
              s.is_cross_midnight AS default_shift_is_cross_midnight,
              s.is_active AS default_shift_is_active,
              ds.assigned_by AS default_assigned_by,
              ds.assigned_reason AS default_assigned_reason,
              ds.updated_at AS default_updated_at
       FROM personnel_type_rules r
       LEFT JOIN personnel_type_default_shifts ds ON ds.personnel_type_code = r.personnel_type_code
       LEFT JOIN shifts s ON s.id = COALESCE(ds.shift_id, r.default_shift_id)
       ORDER BY r.id ASC`
    );
    return rows.map((r) => ({
      ...r,
      effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
      default_workdays:
        r.default_workdays !== undefined && r.default_workdays !== null
          ? normalizeDefaultWorkdays(r.default_workdays, DEFAULT_ALL_WORKDAYS)
          : DEFAULT_ALL_WORKDAYS,
      default_shift_id:
        r.resolved_default_shift_id !== undefined && r.resolved_default_shift_id !== null
          ? Number(r.resolved_default_shift_id)
          : r.default_shift_id !== undefined && r.default_shift_id !== null
            ? Number(r.default_shift_id)
            : null,
    }));
  } catch {
    // Fallback กรณีฐานข้อมูล Production ยังไม่ได้รัน Migration 004_default_shift_templates.sql
    const rows = await queryRunner<PersonnelTypeRuleRow>(
      'SELECT * FROM personnel_type_rules ORDER BY id ASC'
    );
    return rows.map((r) => ({
      ...r,
      effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
      default_workdays:
        r.default_workdays !== undefined && r.default_workdays !== null
          ? normalizeDefaultWorkdays(r.default_workdays, DEFAULT_ALL_WORKDAYS)
          : DEFAULT_ALL_WORKDAYS,
      default_shift_id: null,
    }));
  }
}

export function resolveDefaultShiftSpecFromRule(rule: PersonnelTypeRuleRow | null | undefined): {
  shiftId: number | null;
  shiftCode: string;
  shiftName: string;
  shiftCategory: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
  cutoffTime: string;
  isCrossMidnight: number;
} | null {
  if (!rule) return null;

  if (
    rule.default_shift_id != null &&
    rule.default_shift_code &&
    rule.default_shift_start_time &&
    rule.default_shift_end_time &&
    Number(rule.default_shift_is_active ?? 1) === 1
  ) {
    const startTime = String(rule.default_shift_start_time).trim();
    const endTime = String(rule.default_shift_end_time).trim();
    return {
      shiftId: Number(rule.default_shift_id),
      shiftCode: String(rule.default_shift_code).trim(),
      shiftName: String(rule.default_shift_name || `กะเริ่มต้น (${rule.personnel_type_name})`).trim(),
      shiftCategory: String(rule.default_shift_category || 'MORNING').trim(),
      startTime,
      endTime,
      graceMinutes: Number(rule.default_shift_grace_minutes ?? rule.default_grace_minutes ?? 15),
      cutoffTime: String(rule.default_shift_cutoff_time || rule.default_cutoff_time || '11:00').trim(),
      isCrossMidnight:
        rule.default_shift_is_cross_midnight !== undefined &&
        rule.default_shift_is_cross_midnight !== null
          ? Number(rule.default_shift_is_cross_midnight)
          : endTime <= startTime
            ? 1
            : 0,
    };
  }

  const startTime = String(rule.default_start_time || '').trim();
  const endTime = String(rule.default_end_time || '').trim();
  if (!/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) {
    return null;
  }

  return {
    shiftId: null,
    shiftCode: startTime === '07:30' ? 'MOR-0730' : 'MOR-0816',
    shiftName: `กะเช้าเริ่มต้น (${rule.personnel_type_name})`,
    shiftCategory: 'MORNING',
    startTime,
    endTime,
    graceMinutes: Number(rule.default_grace_minutes ?? 15),
    cutoffTime: String(rule.default_cutoff_time || '11:00').trim(),
    isCrossMidnight: endTime <= startTime ? 1 : 0,
  };
}

export type DailyScheduleOverrideState =
  | 'DEFAULT_FROM_TYPE'
  | 'CUSTOM_ASSIGNED'
  | 'CLEARED_ALL_SHIFTS'
  | 'PUBLIC_HOLIDAY'
  | 'PERSONAL_HOLIDAY'
  | 'NON_WORKING_DAY'
  | 'RESTORED_DEFAULT'
  | 'UNCONFIGURED_DEFAULT_RULE';

export interface DailyOverrideRow {
  id?: number;
  person_id: string;
  work_date: string;
  override_state:
    | 'CUSTOM_ASSIGNED'
    | 'CLEARED_ALL_SHIFTS'
    | 'PERSONAL_HOLIDAY'
    | 'RESTORED_DEFAULT';
  reason: string | null;
  updated_by: string;
  updated_at?: string;
}

export interface ExistingAssignmentRow {
  id: number;
  person_id: string;
  shift_id: number;
  work_date: string;
  snapshot_shift_code: string;
  snapshot_shift_name: string;
  snapshot_start_time: string;
  snapshot_end_time: string;
  snapshot_grace_minutes?: number;
  snapshot_cutoff_time?: string;
  snapshot_is_cross_midnight: number;
  status: string;
}

interface PersonnelSummaryRow {
  person_id: string;
  full_name: string;
  department_name: string;
  personnel_type_code?: string;
  personnel_type_name: string;
}

export type BulkOperationMode =
  | 'ADD_SHIFTS'
  | 'REPLACE_SHIFTS'
  | 'REMOVE_SELECTED_SHIFTS'
  | 'CLEAR_ALL_SHIFTS';

export interface BulkPreviewItem {
  personId: string;
  fullName: string;
  departmentName: string;
  workDate: string;
  shiftId: number | null;
  shiftCode: string | null;
  shiftName: string | null;
  startTime: string | null;
  endTime: string | null;
  isCrossMidnight: number;
  operationMode: BulkOperationMode;
  status:
    | 'READY'
    | 'DUPLICATE_SAME_SHIFT'
    | 'TIME_OVERLAP_CONFLICT'
    | 'SELECTED_SHIFTS_OVERLAP'
    | 'NOT_ASSIGNED';
  conflictCode: string | null;
  conflictMessage: string | null;
  existingOnDateCount?: number;
  existingAssignment: {
    id: number;
    workDate: string;
    shiftCode: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    isCrossMidnight: number;
  } | null;
}

export function normalizeWorkDateString(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const bkkMs = raw.getTime() + 7 * 3600_000;
    const bkkDate = new Date(bkkMs);
    const y = bkkDate.getUTCFullYear();
    const m = String(bkkDate.getUTCMonth() + 1).padStart(2, '0');
    const d = String(bkkDate.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const str = String(raw ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) {
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) {
      const bkkMs = parsed.getTime() + 7 * 3600_000;
      const bkkDate = new Date(bkkMs);
      const y = bkkDate.getUTCFullYear();
      const m = String(bkkDate.getUTCMonth() + 1).padStart(2, '0');
      const d = String(bkkDate.getUTCDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}\s/.test(str)) {
    return str.slice(0, 10);
  }
  return str;
}

export function normalizePersonnelTypeCodeForDefaultShift(
  rawCode: unknown,
  rawName?: unknown
): string {
  const code = String(rawCode ?? '').trim().toUpperCase();
  const name = String(rawName ?? '').trim();

  if (code === '01' || code === '1' || code === 'CIVIL_SERVANT') return 'CIVIL_SERVANT';
  if (code === '02' || code === '2' || code === 'PERMANENT_EMP') return 'PERMANENT_EMP';
  if (code === '03' || code === '3' || code === 'GOV_EMPLOYEE') return 'GOV_EMPLOYEE';
  if (code === '04' || code === '4' || code === 'PUBLIC_HEALTH_EMP') return 'PUBLIC_HEALTH_EMP';
  if (code === '05' || code === '5' || code === '06' || code === '6' || code === 'TEMP_EMPLOYEE') {
    return 'TEMP_EMPLOYEE';
  }

  if (!code && name) {
    if (name.includes('ข้าราชการ')) return 'CIVIL_SERVANT';
    if (name.includes('ลูกจ้างประจำ')) return 'PERMANENT_EMP';
    if (name.includes('พนักงานราชการ')) return 'GOV_EMPLOYEE';
    if (name.includes('พกส') || name.includes('พนักงานกระทรวง')) return 'PUBLIC_HEALTH_EMP';
    if (name.includes('ชั่วคราว') || name.includes('รายวัน')) return 'TEMP_EMPLOYEE';
  }

  return code || 'UNKNOWN_TYPE';
}

export function resolveEffectiveDailyScheduleForPersonDate(params: {
  person: {
    person_id: string;
    personnel_type_code?: string | null;
    personnel_type_name?: string | null;
  };
  workDate: string;
  activeAssignments: ExistingAssignmentRow[];
  dailyOverride: DailyOverrideRow | null | undefined;
  rulesByCode: Map<string, PersonnelTypeRuleRow>;
  publicHoliday?: PublicHolidayRow | null;
  personalHoliday?: { reason?: string | null; source?: 'OVERRIDE' | 'LEAVE' } | null;
}): {
  state: DailyScheduleOverrideState;
  effectiveShifts: Array<{
    isDefaultFromType: boolean;
    assignmentId: number | null;
    shiftId: number | null;
    shiftCode: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    graceMinutes: number;
    cutoffTime: string;
    isCrossMidnight: number;
  }>;
  defaultRule: PersonnelTypeRuleRow | null;
  unconfiguredMessage: string | null;
} {
  const workDate = normalizeWorkDateString(params.workDate);
  const canonicalTypeCode = normalizePersonnelTypeCodeForDefaultShift(
    params.person.personnel_type_code,
    params.person.personnel_type_name
  );
  const directRule =
    params.rulesByCode.get(String(params.person.personnel_type_code || '').trim().toUpperCase()) ||
    params.rulesByCode.get(canonicalTypeCode) ||
    null;

  const isRuleActive =
    directRule !== null &&
    Number(directRule.is_active ?? 1) === 1 &&
    normalizeWorkDateString(directRule.effective_from || '2026-01-01') <= workDate;

  // ลำดับที่ 1 — ตารางเวรรายบุคคล (Individual Shift Assignments)
  // หากมีตารางเวรเฉพาะวัน ให้ใช้ตารางเวรที่กำหนดไว้ทั้งหมด (รวมหลายกะในวันเดียว และกรณีจัดเวรวันหยุด)
  if (params.activeAssignments.length > 0) {
    return {
      state: 'CUSTOM_ASSIGNED',
      effectiveShifts: params.activeAssignments.map((a) => ({
        isDefaultFromType: false,
        assignmentId: a.id,
        shiftId: a.shift_id,
        shiftCode: a.snapshot_shift_code,
        shiftName: a.snapshot_shift_name,
        startTime: a.snapshot_start_time,
        endTime: a.snapshot_end_time,
        graceMinutes: Number(a.snapshot_grace_minutes ?? 15),
        cutoffTime: String(a.snapshot_cutoff_time || '11:00'),
        isCrossMidnight: Number(a.snapshot_is_cross_midnight ?? 0),
      })),
      defaultRule: directRule,
      unconfiguredMessage: null,
    };
  }

  // ลำดับที่ 2 — วันหยุดและการยกเลิกเวร (ห้ามให้ Default Shift สร้างเวรทับ)
  if (params.dailyOverride?.override_state === 'CLEARED_ALL_SHIFTS') {
    return {
      state: 'CLEARED_ALL_SHIFTS',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: null,
    };
  }

  if (params.dailyOverride?.override_state === 'PERSONAL_HOLIDAY' || params.personalHoliday) {
    return {
      state: 'PERSONAL_HOLIDAY',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: null,
    };
  }

  if (params.publicHoliday && Number(params.publicHoliday.is_active ?? 1) === 1) {
    return {
      state: 'PUBLIC_HOLIDAY',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: null,
    };
  }

  // ลำดับที่ 3 — Default ตามประเภทบุคลากร (ตรวจสอบวันที่มีผลและวันทำงานที่กำหนดไว้)
  const defaultSpec = isRuleActive ? resolveDefaultShiftSpecFromRule(directRule) : null;
  if (!directRule || !isRuleActive || !defaultSpec) {
    // ลำดับที่ 4 — ไม่มีเวร (“ยังไม่กำหนดกะ”) และไม่ถือเป็น NO_SCAN หรือมาสายอัตโนมัติ
    return {
      state: 'UNCONFIGURED_DEFAULT_RULE',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: `ยังไม่กำหนดกะสำหรับประเภทบุคลากร (${params.person.personnel_type_name || canonicalTypeCode})`,
    };
  }

  if (!isWorkDateMatchingDefaultWorkdays(workDate, directRule.default_workdays)) {
    return {
      state: 'NON_WORKING_DAY',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: null,
    };
  }

  return {
    state:
      params.dailyOverride?.override_state === 'RESTORED_DEFAULT'
        ? 'RESTORED_DEFAULT'
        : 'DEFAULT_FROM_TYPE',
    effectiveShifts: [
      {
        isDefaultFromType: true,
        assignmentId: null,
        shiftId: defaultSpec.shiftId,
        shiftCode: defaultSpec.shiftCode,
        shiftName: defaultSpec.shiftName,
        startTime: defaultSpec.startTime,
        endTime: defaultSpec.endTime,
        graceMinutes: defaultSpec.graceMinutes,
        cutoffTime: defaultSpec.cutoffTime,
        isCrossMidnight: defaultSpec.isCrossMidnight,
      },
    ],
    defaultRule: directRule,
    unconfiguredMessage: null,
  };
}

function parseTimeToMinutes(hhmm: string): number {
  const [hStr, mStr] = String(hhmm || '00:00').split(':');
  return Number(hStr || 0) * 60 + Number(mStr || 0);
}

function parseDateToUtcDayIndex(dateInput: unknown): number {
  const dateStr = normalizeWorkDateString(dateInput);
  const [yStr, mStr, dStr] = dateStr.split('-');
  const utcMs = Date.UTC(Number(yStr || 1970), Number(mStr || 1) - 1, Number(dStr || 1));
  return Math.floor(utcMs / 86_400_000);
}

function addDaysToDateString(dateInput: unknown, offsetDays: number): string {
  const dateStr = normalizeWorkDateString(dateInput);
  const [yStr, mStr, dStr] = dateStr.split('-');
  const dt = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + offsetDays));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function computeAbsoluteIntervalMinutes(
  workDate: unknown,
  startTime: string,
  endTime: string,
  isCrossMidnight: number
): { startAbsMin: number; endAbsMin: number } {
  const dayIndex = parseDateToUtcDayIndex(workDate);
  const startMin = parseTimeToMinutes(startTime);
  const endMin = parseTimeToMinutes(endTime);
  const cross = Number(isCrossMidnight) === 1 || endMin <= startMin;
  return {
    startAbsMin: dayIndex * 1440 + startMin,
    endAbsMin: dayIndex * 1440 + endMin + (cross ? 1440 : 0),
  };
}

async function upsertDailyOverrideRecord(
  executor: (sql: string, params?: unknown[]) => Promise<unknown>,
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  params: {
    personId: string;
    workDate: string;
    overrideState: 'CUSTOM_ASSIGNED' | 'CLEARED_ALL_SHIFTS' | 'RESTORED_DEFAULT' | 'PERSONAL_HOLIDAY';
    reason: string | null;
    actorUsername: string;
  }
): Promise<void> {
  const existing = await queryRunner<{ id: number }>(
    'SELECT id FROM shift_daily_overrides WHERE person_id = ? AND work_date = ? LIMIT 1',
    [params.personId, params.workDate]
  );
  if (existing.length > 0) {
    await executor(
      `UPDATE shift_daily_overrides
       SET override_state = ?, reason = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [params.overrideState, params.reason, params.actorUsername, existing[0].id]
    );
  } else {
    await executor(
      `INSERT INTO shift_daily_overrides (person_id, work_date, override_state, reason, updated_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        params.personId,
        params.workDate,
        params.overrideState,
        params.reason,
        params.actorUsername,
      ]
    );
  }
}

/**
 * ตรวจสอบทุกคู่ของแม่แบบกะที่เลือกพร้อมกัน (Multi-Shift) ว่ามีช่วงเวลาทับซ้อนกันเองในวันเดียวกันหรือไม่
 * ใช้หลักการช่วงเวลา [start, end) เช่น [08:00, 16:00) กับ [16:00, 24:00) ถือว่าไม่ทับซ้อน
 */
export function findAllSelectedShiftsSelfOverlaps(
  shifts: ShiftRow[],
  referenceDate = '2026-01-01'
): Array<{ shiftA: ShiftRow; shiftB: ShiftRow; message: string }> {
  const conflicts: Array<{ shiftA: ShiftRow; shiftB: ShiftRow; message: string }> = [];
  for (let i = 0; i < shifts.length; i++) {
    for (let j = i + 1; j < shifts.length; j++) {
      const a = shifts[i];
      const b = shifts[j];
      const intA = computeAbsoluteIntervalMinutes(
        referenceDate,
        a.start_time,
        a.end_time,
        a.is_cross_midnight
      );
      const intB = computeAbsoluteIntervalMinutes(
        referenceDate,
        b.start_time,
        b.end_time,
        b.is_cross_midnight
      );
      if (Math.max(intA.startAbsMin, intB.startAbsMin) < Math.min(intA.endAbsMin, intB.endAbsMin)) {
        const crossA = Number(a.is_cross_midnight) === 1 ? ' (+1 วัน)' : '';
        const crossB = Number(b.is_cross_midnight) === 1 ? ' (+1 วัน)' : '';
        conflicts.push({
          shiftA: a,
          shiftB: b,
          message: `แม่แบบกะที่เลือก "${a.shift_name}" (${a.start_time}–${a.end_time} น.${crossA}) และ "${b.shift_name}" (${b.start_time}–${b.end_time} น.${crossB}) มีช่วงเวลาทับซ้อนกัน`,
        });
      }
    }
  }
  return conflicts;
}

/**
 * ตรวจสอบว่าชุดแม่แบบกะที่เลือกพร้อมกัน (Multi-Shift) มีเวลาทับซ้อนกันเองในวันเดียวกันหรือไม่
 */
export function findSelectedShiftsSelfOverlap(
  shifts: ShiftRow[],
  referenceDate = '2026-01-01'
): { shiftA: ShiftRow; shiftB: ShiftRow; message: string } | null {
  const all = findAllSelectedShiftsSelfOverlaps(shifts, referenceDate);
  return all.length > 0 ? all[0] : null;
}

// ============================================================================
// Per-Person In-Process Schedule Mutex (ป้องกัน Concurrent Updates ใน Process เดียวกัน
// ควบคู่กับ MySQL SELECT ... FOR UPDATE และ SQLite Serialized Transaction)
// ============================================================================
const personScheduleLockQueues = new Map<string, Promise<void>>();

export async function withPersonScheduleLock<T>(
  personId: string,
  work: () => Promise<T>
): Promise<T> {
  const key = String(personId || '').trim();
  const prev = personScheduleLockQueues.get(key) || Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = prev.then(() => gate);
  personScheduleLockQueues.set(key, chained);

  await prev;
  try {
    return await work();
  } finally {
    release();
    if (personScheduleLockQueues.get(key) === chained) {
      personScheduleLockQueues.delete(key);
    }
  }
}

export interface DailyCellShiftPreviewItem {
  shiftId: number | null;
  shiftCode: string;
  shiftName: string;
  workDate: string;
  startTime: string;
  endTime: string;
  endDate: string;
  isCrossMidnight: number;
  graceMinutes?: number;
  cutoffTime?: string;
  source: 'EXISTING' | 'DEFAULT_IMPLICIT' | 'NEW';
  startAbsMin: number;
  endAbsMin: number;
}

export interface DailyCellConflict {
  code:
    | 'SELECTED_SHIFTS_OVERLAP'
    | 'DUPLICATE_SAME_SHIFT'
    | 'TIME_OVERLAP_CONFLICT'
    | 'ADJACENT_DAY_OVERLAP';
  shiftA: {
    shiftCode: string;
    shiftName: string;
    workDate: string;
    startTime: string;
    endTime: string;
    endDate: string;
    isCrossMidnight: number;
  };
  shiftB: {
    shiftCode: string;
    shiftName: string;
    workDate: string;
    startTime: string;
    endTime: string;
    endDate: string;
    isCrossMidnight: number;
  };
  message: string;
}

export interface DailyCellEvaluationResult {
  canProceed: boolean;
  action: 'ADD_SHIFT' | 'REPLACE_SHIFTS';
  conflicts: DailyCellConflict[];
  existingSameDayShifts: DailyCellShiftPreviewItem[];
  shiftsToBeReplaced: DailyCellShiftPreviewItem[];
  resultingShifts: DailyCellShiftPreviewItem[];
  adjacentShifts: DailyCellShiftPreviewItem[];
  defaultShiftToMaterialize: {
    shiftCode: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    graceMinutes: number;
    cutoffTime: string;
    isCrossMidnight: number;
  } | null;
}

function formatShiftSpanLabel(item: {
  shiftCode?: string;
  shiftName: string;
  workDate: string;
  startTime: string;
  endTime: string;
  endDate: string;
  isCrossMidnight: number;
}): string {
  const cleanName = String(item.shiftName || '').trim();
  const codeSuffix = item.shiftCode ? ` [${item.shiftCode}]` : '';
  if (item.isCrossMidnight === 1 || item.endDate !== item.workDate) {
    return `${cleanName}${codeSuffix} (${item.workDate} ${item.startTime} – ${item.endDate} ${item.endTime} น.)`;
  }
  return `${cleanName}${codeSuffix} (${item.workDate} ${item.startTime}–${item.endTime} น.)`;
}

function toDailyCellShiftItem(params: {
  shiftId: number | null;
  shiftCode: string;
  shiftName: string;
  workDate: string;
  startTime: string;
  endTime: string;
  isCrossMidnight: number;
  graceMinutes?: number;
  cutoffTime?: string;
  source: 'EXISTING' | 'DEFAULT_IMPLICIT' | 'NEW';
}): DailyCellShiftPreviewItem {
  const startMin = parseTimeToMinutes(params.startTime);
  const endMin = parseTimeToMinutes(params.endTime);
  const cross = Number(params.isCrossMidnight) === 1 || endMin <= startMin ? 1 : 0;
  const interval = computeAbsoluteIntervalMinutes(
    params.workDate,
    params.startTime,
    params.endTime,
    cross
  );
  const endDate = cross === 1 ? addDaysToDateString(params.workDate, 1) : params.workDate;
  return {
    shiftId: params.shiftId,
    shiftCode: params.shiftCode,
    shiftName: params.shiftName,
    workDate: params.workDate,
    startTime: params.startTime,
    endTime: params.endTime,
    endDate,
    isCrossMidnight: cross,
    graceMinutes: params.graceMinutes,
    cutoffTime: params.cutoffTime,
    source: params.source,
    startAbsMin: interval.startAbsMin,
    endAbsMin: interval.endAbsMin,
  };
}

/**
 * ประเมินการเพิ่มหรือแทนที่กะหลายกะพร้อมกันสำหรับ Quick Daily Shift Cell
 * ใช้หลักการช่วงเวลา [start, end) จริงจากวันที่ + เวลา (รองรับกะข้ามวัน และวันก่อนหน้า/วันถัดไป)
 */
export function evaluateDailyCellChange(params: {
  workDate: string;
  action: 'ADD_SHIFT' | 'REPLACE_SHIFTS';
  selectedShifts: ShiftRow[];
  sameDayActive: ExistingAssignmentRow[];
  adjacentDaysActive: ExistingAssignmentRow[];
  dailyOverride: DailyOverrideRow | null;
  defaultRule: PersonnelTypeRuleRow | null;
}): DailyCellEvaluationResult {
  const {
    workDate,
    action,
    selectedShifts,
    sameDayActive,
    adjacentDaysActive,
    dailyOverride,
    defaultRule,
  } = params;

  const conflicts: DailyCellConflict[] = [];

  // 1. สร้างรายการกะปัจจุบันในวันนั้น (รวมกรณี DEFAULT_FROM_TYPE ที่ยังไม่มีแถวใน shift_assignments)
  const existingSameDayShifts: DailyCellShiftPreviewItem[] = sameDayActive.map((ex) =>
    toDailyCellShiftItem({
      shiftId: Number(ex.shift_id),
      shiftCode: ex.snapshot_shift_code,
      shiftName: ex.snapshot_shift_name,
      workDate: ex.work_date,
      startTime: ex.snapshot_start_time,
      endTime: ex.snapshot_end_time,
      isCrossMidnight: Number(ex.snapshot_is_cross_midnight),
      graceMinutes: ex.snapshot_grace_minutes,
      cutoffTime: ex.snapshot_cutoff_time,
      source: 'EXISTING',
    })
  );

  let defaultShiftToMaterialize: DailyCellEvaluationResult['defaultShiftToMaterialize'] = null;
  const isCleared = dailyOverride?.override_state === 'CLEARED_ALL_SHIFTS';
  const isCustomWithoutRows = dailyOverride?.override_state === 'CUSTOM_ASSIGNED';

  const defaultSpecForCell =
    existingSameDayShifts.length === 0 &&
    !isCleared &&
    !isCustomWithoutRows &&
    defaultRule &&
    Number(defaultRule.is_active) === 1 &&
    (!defaultRule.effective_from || workDate >= normalizeWorkDateString(defaultRule.effective_from))
      ? resolveDefaultShiftSpecFromRule(defaultRule)
      : null;

  if (defaultSpecForCell) {
    const defItem = toDailyCellShiftItem({
      shiftId: defaultSpecForCell.shiftId,
      shiftCode: defaultSpecForCell.shiftCode,
      shiftName: defaultSpecForCell.shiftName,
      workDate,
      startTime: defaultSpecForCell.startTime,
      endTime: defaultSpecForCell.endTime,
      isCrossMidnight: defaultSpecForCell.isCrossMidnight,
      graceMinutes: defaultSpecForCell.graceMinutes,
      cutoffTime: defaultSpecForCell.cutoffTime,
      source: 'DEFAULT_IMPLICIT',
    });
    existingSameDayShifts.push(defItem);
    if (action === 'ADD_SHIFT') {
      defaultShiftToMaterialize = {
        shiftCode: defaultSpecForCell.shiftCode,
        shiftName: defaultSpecForCell.shiftName,
        startTime: defaultSpecForCell.startTime,
        endTime: defaultSpecForCell.endTime,
        graceMinutes: defaultSpecForCell.graceMinutes,
        cutoffTime: defaultSpecForCell.cutoffTime,
        isCrossMidnight: defaultSpecForCell.isCrossMidnight,
      };
    }
  }

  // 2. รายการกะจากวันก่อนหน้าและวันถัดไปที่อาจข้ามวันมาทับซ้อน
  const adjacentShifts: DailyCellShiftPreviewItem[] = adjacentDaysActive.map((adj) =>
    toDailyCellShiftItem({
      shiftId: Number(adj.shift_id),
      shiftCode: adj.snapshot_shift_code,
      shiftName: adj.snapshot_shift_name,
      workDate: adj.work_date,
      startTime: adj.snapshot_start_time,
      endTime: adj.snapshot_end_time,
      isCrossMidnight: Number(adj.snapshot_is_cross_midnight),
      graceMinutes: adj.snapshot_grace_minutes,
      cutoffTime: adj.snapshot_cutoff_time,
      source: 'EXISTING',
    })
  );

  // 3. รายการกะใหม่ที่ผู้ใช้ติ๊กเลือก
  const candidateItems: DailyCellShiftPreviewItem[] = selectedShifts.map((s) =>
    toDailyCellShiftItem({
      shiftId: Number(s.id),
      shiftCode: s.shift_code,
      shiftName: s.shift_name,
      workDate,
      startTime: s.start_time,
      endTime: s.end_time,
      isCrossMidnight: Number(s.is_cross_midnight),
      graceMinutes: s.grace_minutes,
      cutoffTime: s.cutoff_time,
      source: 'NEW',
    })
  );

  const intervalsOverlap = (a: DailyCellShiftPreviewItem, b: DailyCellShiftPreviewItem) =>
    Math.max(a.startAbsMin, b.startAbsMin) < Math.min(a.endAbsMin, b.endAbsMin);

  const toRef = (x: DailyCellShiftPreviewItem) => ({
    shiftCode: x.shiftCode,
    shiftName: x.shiftName,
    workDate: x.workDate,
    startTime: x.startTime,
    endTime: x.endTime,
    endDate: x.endDate,
    isCrossMidnight: x.isCrossMidnight,
  });

  // 4. ตรวจทับซ้อนระหว่างกะใหม่ที่เลือกพร้อมกันเอง (Multi-select self-overlap)
  for (let i = 0; i < candidateItems.length; i++) {
    for (let j = i + 1; j < candidateItems.length; j++) {
      const a = candidateItems[i];
      const b = candidateItems[j];
      if (intervalsOverlap(a, b)) {
        conflicts.push({
          code: 'SELECTED_SHIFTS_OVERLAP',
          shiftA: toRef(a),
          shiftB: toRef(b),
          message: `กะที่เลือกทับซ้อนกันเอง: ${formatShiftSpanLabel(a)} ทับซ้อนกับ ${formatShiftSpanLabel(b)}`,
        });
      }
    }
  }

  // 5. โหมดเพิ่มกะ (ADD_SHIFT): ตรวจซ้ำกะเดิม และตรวจเวลาทับซ้อนกับกะเดิมในวันเดียวกัน
  if (action === 'ADD_SHIFT') {
    for (const cand of candidateItems) {
      for (const ex of existingSameDayShifts) {
        const isSameShift =
          (ex.shiftId !== null && cand.shiftId !== null && ex.shiftId === cand.shiftId) ||
          (ex.shiftCode && cand.shiftCode && ex.shiftCode === cand.shiftCode) ||
          (ex.source === 'DEFAULT_IMPLICIT' &&
            cand.startAbsMin === ex.startAbsMin &&
            cand.endAbsMin === ex.endAbsMin);

        if (isSameShift) {
          conflicts.push({
            code: 'DUPLICATE_SAME_SHIFT',
            shiftA: toRef(cand),
            shiftB: toRef(ex),
            message: `ซ้ำกับกะที่มีอยู่แล้ว: ${formatShiftSpanLabel(cand)} ซ้ำกับ ${formatShiftSpanLabel(ex)}`,
          });
        } else if (intervalsOverlap(cand, ex)) {
          conflicts.push({
            code: 'TIME_OVERLAP_CONFLICT',
            shiftA: toRef(cand),
            shiftB: toRef(ex),
            message: `เวลาทับซ้อนกับกะเดิมในวันนี้: ${formatShiftSpanLabel(cand)} ทับซ้อนกับ ${formatShiftSpanLabel(ex)}`,
          });
        }
      }
    }
  }

  // 6. ตรวจเวลาทับซ้อนกับกะของวันก่อนหน้าและวันถัดไป (ใช้ได้ทั้งโหมด ADD_SHIFT และ REPLACE_SHIFTS)
  for (const cand of candidateItems) {
    for (const adj of adjacentShifts) {
      if (intervalsOverlap(cand, adj)) {
        const relationLabel = adj.workDate < workDate ? 'วันก่อนหน้า' : 'วันถัดไป';
        conflicts.push({
          code: 'ADJACENT_DAY_OVERLAP',
          shiftA: toRef(cand),
          shiftB: toRef(adj),
          message: `เวลาทับซ้อนกับกะข้ามวันของ${relationLabel}: ${formatShiftSpanLabel(cand)} ทับซ้อนกับ ${formatShiftSpanLabel(adj)}`,
        });
      }
    }
  }

  const shiftsToBeReplaced = action === 'REPLACE_SHIFTS' ? [...existingSameDayShifts] : [];
  const resultingShifts = (
    action === 'ADD_SHIFT'
      ? [...existingSameDayShifts, ...candidateItems]
      : [...candidateItems]
  ).sort((a, b) => a.startAbsMin - b.startAbsMin || a.endAbsMin - b.endAbsMin);

  return {
    canProceed: conflicts.length === 0,
    action,
    conflicts,
    existingSameDayShifts,
    shiftsToBeReplaced,
    resultingShifts,
    adjacentShifts,
    defaultShiftToMaterialize,
  };
}

export interface DailyCellEffectiveShift {
  identityKey: string;
  assignmentId: number | null;
  templateId: number | null;
  shiftCode: string;
  shiftName: string;
  shiftCategory: string;
  workDate: string;
  startTime: string;
  endTime: string;
  endDate: string;
  isCrossMidnight: number;
  graceMinutes: number;
  cutoffTime: string;
  source: 'ASSIGNMENT' | 'DEFAULT_IMPLICIT';
  isSpecialAssignment: boolean;
  specialReason: 'UNMATCHED_TEMPLATE' | 'DUPLICATE_TEMPLATE' | null;
  startAbsMin: number;
  endAbsMin: number;
}

export interface DailyCellCarryoverShift {
  assignmentId: number | null;
  shiftCode: string;
  shiftName: string;
  workDate: string;
  startTime: string;
  endTime: string;
  endDate: string;
  isCrossMidnight: number;
  startAbsMin: number;
  endAbsMin: number;
  noticeText: string;
}

export interface DailyCellSyncEvaluationResult {
  canProceed: boolean;
  hasChanges: boolean;
  willClearAll: boolean;
  effectiveState: DailyScheduleOverrideState;
  conflicts: DailyCellConflict[];
  existingEffectiveShifts: DailyCellEffectiveShift[];
  selectedTemplateIds: number[];
  shiftsToKeep: DailyCellEffectiveShift[];
  shiftsToAdd: DailyCellShiftPreviewItem[];
  shiftsToRemove: DailyCellEffectiveShift[];
  resultingShifts: DailyCellShiftPreviewItem[];
  carryoverFromPrevDay: DailyCellCarryoverShift[];
  nextDayShifts: DailyCellShiftPreviewItem[];
  specialExistingAssignments: DailyCellEffectiveShift[];
  defaultShiftToMaterialize: {
    templateId: number | null;
    shiftCode: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    graceMinutes: number;
    cutoffTime: string;
    isCrossMidnight: number;
  } | null;
}

/**
 * จับคู่กะที่มีผลจริง (Assignment หรือ Default Rule) กับ Template ID ที่ใช้งานอยู่ในตาราง shifts
 */
export function matchShiftTemplateId(
  shift: {
    shiftId?: number | null;
    shiftCode?: string | null;
    startTime?: string | null;
    endTime?: string | null;
    isCrossMidnight?: number | null;
  },
  availableTemplates: ShiftRow[]
): ShiftRow | null {
  if (shift.shiftId && Number(shift.shiftId) > 0) {
    const byId = availableTemplates.find((t) => Number(t.id) === Number(shift.shiftId));
    if (byId) return byId;
  }
  const code = String(shift.shiftCode || '').trim().toUpperCase();
  if (code) {
    const byCode = availableTemplates.find(
      (t) => String(t.shift_code || '').trim().toUpperCase() === code
    );
    if (byCode) return byCode;
  }
  const st = String(shift.startTime || '').trim();
  const et = String(shift.endTime || '').trim();
  const cross = Number(shift.isCrossMidnight ?? (et <= st ? 1 : 0));
  if (st && et) {
    const byTime = availableTemplates.find((t) => {
      const tCross = Number(t.is_cross_midnight) === 1 || t.end_time <= t.start_time ? 1 : 0;
      return t.start_time === st && t.end_time === et && tCross === cross;
    });
    if (byTime) return byTime;
  }
  return null;
}

/**
 * ประเมินการซิงค์กะที่เลือกทั้งหมดในวันเดียว (Synchronize Selected Shifts)
 * - Selected Template IDs = สถานะกะทั้งหมดที่ผู้ใช้ต้องการให้มีในวันนั้นหลังบันทึก
 * - รักษา Assignment ID ของกะเดิมที่ยังคงไว้ ไม่ลบแล้วสร้างใหม่โดยไม่จำเป็น
 * - จัดการกะเริ่มต้นตามประเภทบุคลากร (Derived Default), CLEARED_ALL_SHIFTS,
 *   กะข้ามวันจากวันก่อนหน้า/วันถัดไป, และกรณีพิเศษที่มี Template เดียวกันหลายรายการ
 */
export function evaluateDailyCellSync(params: {
  workDate: string;
  selectedTemplateIds: number[];
  availableTemplates: ShiftRow[];
  sameDayActive: ExistingAssignmentRow[];
  adjacentDaysActive: ExistingAssignmentRow[];
  dailyOverride: DailyOverrideRow | null;
  defaultRule: PersonnelTypeRuleRow | null;
  nextDayDefaultRule?: PersonnelTypeRuleRow | null;
  nextDayOverride?: DailyOverrideRow | null;
  publicHoliday?: PublicHolidayRow | null;
  nextDayPublicHoliday?: PublicHolidayRow | null;
  personalHoliday?: boolean;
  keepSpecialAssignmentIds?: number[];
}): DailyCellSyncEvaluationResult {
  const {
    workDate,
    availableTemplates,
    sameDayActive,
    adjacentDaysActive,
    dailyOverride,
    defaultRule,
    nextDayDefaultRule,
    nextDayOverride,
    publicHoliday,
    nextDayPublicHoliday,
    personalHoliday,
  } = params;

  const uniqueSelectedIds: number[] = [];
  for (const id of params.selectedTemplateIds || []) {
    const n = Number(id);
    if (n > 0 && !uniqueSelectedIds.includes(n)) uniqueSelectedIds.push(n);
  }
  const selectedIdSet = new Set(uniqueSelectedIds);
  const templateById = new Map<number, ShiftRow>(
    availableTemplates.map((t) => [Number(t.id), t])
  );

  // 1. สร้างรายการ Effective Shifts ปัจจุบัน พร้อมจับคู่ Template ID และตรวจ duplicate/unmatched
  const existingEffectiveShifts: DailyCellEffectiveShift[] = [];
  const seenTemplateIds = new Set<number>();

  for (const ex of sameDayActive) {
    const matchedTpl = matchShiftTemplateId(
      {
        shiftId: Number(ex.shift_id),
        shiftCode: ex.snapshot_shift_code,
        startTime: ex.snapshot_start_time,
        endTime: ex.snapshot_end_time,
        isCrossMidnight: Number(ex.snapshot_is_cross_midnight),
      },
      availableTemplates
    );
    const tplId = matchedTpl ? Number(matchedTpl.id) : null;
    const isDuplicateTpl = tplId !== null && seenTemplateIds.has(tplId);
    if (tplId !== null) seenTemplateIds.add(tplId);

    const previewItem = toDailyCellShiftItem({
      shiftId: tplId ?? Number(ex.shift_id),
      shiftCode: ex.snapshot_shift_code,
      shiftName: ex.snapshot_shift_name,
      workDate: ex.work_date,
      startTime: ex.snapshot_start_time,
      endTime: ex.snapshot_end_time,
      isCrossMidnight: Number(ex.snapshot_is_cross_midnight),
      graceMinutes: ex.snapshot_grace_minutes,
      cutoffTime: ex.snapshot_cutoff_time,
      source: 'EXISTING',
    });

    const specialReason: 'UNMATCHED_TEMPLATE' | 'DUPLICATE_TEMPLATE' | null =
      tplId === null ? 'UNMATCHED_TEMPLATE' : isDuplicateTpl ? 'DUPLICATE_TEMPLATE' : null;

    existingEffectiveShifts.push({
      identityKey: `assign:${ex.id}`,
      assignmentId: Number(ex.id),
      templateId: tplId,
      shiftCode: previewItem.shiftCode,
      shiftName: previewItem.shiftName,
      shiftCategory: matchedTpl?.shift_category || 'SPECIAL',
      workDate: previewItem.workDate,
      startTime: previewItem.startTime,
      endTime: previewItem.endTime,
      endDate: previewItem.endDate,
      isCrossMidnight: previewItem.isCrossMidnight,
      graceMinutes: Number(ex.snapshot_grace_minutes ?? 15),
      cutoffTime: ex.snapshot_cutoff_time || '11:00',
      source: 'ASSIGNMENT',
      isSpecialAssignment: specialReason !== null,
      specialReason,
      startAbsMin: previewItem.startAbsMin,
      endAbsMin: previewItem.endAbsMin,
    });
  }

  const isCleared =
    dailyOverride?.override_state === 'CLEARED_ALL_SHIFTS' && existingEffectiveShifts.length === 0;
  const isPersonalHoliday =
    (dailyOverride?.override_state === 'PERSONAL_HOLIDAY' || Boolean(personalHoliday)) &&
    existingEffectiveShifts.length === 0;
  const isPublicHoliday =
    Boolean(publicHoliday && Number(publicHoliday.is_active ?? 1) === 1) &&
    existingEffectiveShifts.length === 0;
  const isCustomWithoutRows =
    dailyOverride?.override_state === 'CUSTOM_ASSIGNED' && existingEffectiveShifts.length === 0;

  const isRuleActiveToday =
    Boolean(defaultRule) &&
    Number(defaultRule!.is_active) === 1 &&
    (!defaultRule!.effective_from || workDate >= normalizeWorkDateString(defaultRule!.effective_from));

  const rawDefaultSpecToday =
    !isCleared &&
    !isPersonalHoliday &&
    !isPublicHoliday &&
    existingEffectiveShifts.length === 0 &&
    !isCustomWithoutRows &&
    isRuleActiveToday
      ? resolveDefaultShiftSpecFromRule(defaultRule)
      : null;

  const isWorkingDayToday =
    defaultRule && rawDefaultSpecToday
      ? isWorkDateMatchingDefaultWorkdays(workDate, defaultRule.default_workdays)
      : false;

  const syncDefaultSpec = isWorkingDayToday ? rawDefaultSpecToday : null;

  let effectiveState: DailyScheduleOverrideState = 'UNCONFIGURED_DEFAULT_RULE';
  if (existingEffectiveShifts.length > 0) {
    effectiveState = 'CUSTOM_ASSIGNED';
  } else if (isCleared) {
    effectiveState = 'CLEARED_ALL_SHIFTS';
  } else if (isPersonalHoliday) {
    effectiveState = 'PERSONAL_HOLIDAY';
  } else if (isPublicHoliday) {
    effectiveState = 'PUBLIC_HOLIDAY';
  } else if (rawDefaultSpecToday && !isWorkingDayToday) {
    effectiveState = 'NON_WORKING_DAY';
  } else if (syncDefaultSpec && defaultRule) {
    effectiveState =
      dailyOverride?.override_state === 'RESTORED_DEFAULT'
        ? 'RESTORED_DEFAULT'
        : 'DEFAULT_FROM_TYPE';

    const matchedDefTpl =
      (syncDefaultSpec.shiftId != null
        ? availableTemplates.find((t) => Number(t.id) === Number(syncDefaultSpec.shiftId))
        : null) ||
      matchShiftTemplateId(
        {
          shiftCode: syncDefaultSpec.shiftCode,
          startTime: syncDefaultSpec.startTime,
          endTime: syncDefaultSpec.endTime,
          isCrossMidnight: syncDefaultSpec.isCrossMidnight,
        },
        availableTemplates
      );
    const defName = matchedDefTpl ? matchedDefTpl.shift_name : syncDefaultSpec.shiftName;
    const previewItem = toDailyCellShiftItem({
      shiftId: matchedDefTpl ? Number(matchedDefTpl.id) : syncDefaultSpec.shiftId,
      shiftCode: matchedDefTpl?.shift_code || syncDefaultSpec.shiftCode,
      shiftName: defName,
      workDate,
      startTime: syncDefaultSpec.startTime,
      endTime: syncDefaultSpec.endTime,
      isCrossMidnight: syncDefaultSpec.isCrossMidnight,
      graceMinutes: syncDefaultSpec.graceMinutes,
      cutoffTime: syncDefaultSpec.cutoffTime,
      source: 'DEFAULT_IMPLICIT',
    });
    existingEffectiveShifts.push({
      identityKey: `default:${defaultRule.personnel_type_code}`,
      assignmentId: null,
      templateId: matchedDefTpl ? Number(matchedDefTpl.id) : syncDefaultSpec.shiftId,
      shiftCode: previewItem.shiftCode,
      shiftName: previewItem.shiftName,
      shiftCategory: matchedDefTpl?.shift_category || syncDefaultSpec.shiftCategory,
      workDate,
      startTime: syncDefaultSpec.startTime,
      endTime: syncDefaultSpec.endTime,
      endDate: previewItem.endDate,
      isCrossMidnight: syncDefaultSpec.isCrossMidnight,
      graceMinutes: syncDefaultSpec.graceMinutes,
      cutoffTime: syncDefaultSpec.cutoffTime,
      source: 'DEFAULT_IMPLICIT',
      isSpecialAssignment: false,
      specialReason: null,
      startAbsMin: previewItem.startAbsMin,
      endAbsMin: previewItem.endAbsMin,
    });
  }

  const specialExistingAssignments = existingEffectiveShifts.filter((e) => e.isSpecialAssignment);
  const keepSpecialSet =
    params.keepSpecialAssignmentIds !== undefined
      ? new Set(params.keepSpecialAssignmentIds.map(Number))
      : new Set(
          specialExistingAssignments
            .map((e) => e.assignmentId)
            .filter((id): id is number => id !== null)
        );

  // 2. คำนวณ Diff: shiftsToKeep / shiftsToRemove / shiftsToAdd
  const shiftsToKeep: DailyCellEffectiveShift[] = [];
  const shiftsToRemove: DailyCellEffectiveShift[] = [];
  const keptPrimaryTemplateIds = new Set<number>();

  for (const ex of existingEffectiveShifts) {
    if (ex.isSpecialAssignment) {
      if (ex.assignmentId !== null && keepSpecialSet.has(ex.assignmentId)) {
        shiftsToKeep.push(ex);
      } else {
        shiftsToRemove.push(ex);
      }
      continue;
    }

    if (ex.templateId !== null && selectedIdSet.has(ex.templateId)) {
      shiftsToKeep.push(ex);
      keptPrimaryTemplateIds.add(ex.templateId);
    } else if (ex.templateId === null && ex.source === 'DEFAULT_IMPLICIT' && uniqueSelectedIds.length === 0) {
      shiftsToRemove.push(ex);
    } else {
      shiftsToRemove.push(ex);
    }
  }

  const shiftsToAdd: DailyCellShiftPreviewItem[] = [];
  for (const sid of uniqueSelectedIds) {
    if (keptPrimaryTemplateIds.has(sid)) continue;
    const tpl = templateById.get(sid);
    if (!tpl) continue;
    shiftsToAdd.push(
      toDailyCellShiftItem({
        shiftId: Number(tpl.id),
        shiftCode: tpl.shift_code,
        shiftName: tpl.shift_name,
        workDate,
        startTime: tpl.start_time,
        endTime: tpl.end_time,
        isCrossMidnight: Number(tpl.is_cross_midnight),
        graceMinutes: tpl.grace_minutes,
        cutoffTime: tpl.cutoff_time,
        source: 'NEW',
      })
    );
  }

  // กรณี DEFAULT_FROM_TYPE ที่ผู้ใช้เก็บกะเช้าเริ่มต้นไว้ + เพิ่มกะอื่น -> ต้อง Materialize กะเช้าเริ่มต้นลง shift_assignments
  let defaultShiftToMaterialize: DailyCellSyncEvaluationResult['defaultShiftToMaterialize'] = null;
  const keptDefault = shiftsToKeep.find((k) => k.source === 'DEFAULT_IMPLICIT');
  if (keptDefault && shiftsToAdd.length > 0) {
    defaultShiftToMaterialize = {
      templateId: keptDefault.templateId,
      shiftCode: keptDefault.shiftCode,
      shiftName: keptDefault.shiftName,
      startTime: keptDefault.startTime,
      endTime: keptDefault.endTime,
      graceMinutes: keptDefault.graceMinutes,
      cutoffTime: keptDefault.cutoffTime,
      isCrossMidnight: keptDefault.isCrossMidnight,
    };
  }

  const resultingShifts: DailyCellShiftPreviewItem[] = [
    ...shiftsToKeep.map((k) => ({
      shiftId: k.templateId,
      shiftCode: k.shiftCode,
      shiftName: k.shiftName,
      workDate: k.workDate,
      startTime: k.startTime,
      endTime: k.endTime,
      endDate: k.endDate,
      isCrossMidnight: k.isCrossMidnight,
      graceMinutes: k.graceMinutes,
      cutoffTime: k.cutoffTime,
      source: (k.source === 'DEFAULT_IMPLICIT' ? 'DEFAULT_IMPLICIT' : 'EXISTING') as
        | 'EXISTING'
        | 'DEFAULT_IMPLICIT'
        | 'NEW',
      startAbsMin: k.startAbsMin,
      endAbsMin: k.endAbsMin,
    })),
    ...shiftsToAdd,
  ].sort((a, b) => a.startAbsMin - b.startAbsMin || a.endAbsMin - b.endAbsMin);

  // 3. จำแนกกะต่อเนื่องจากวันก่อนหน้า (Carryover) และกะของวันถัดไป (Next Day)
  const workDateStartAbsMin = computeAbsoluteIntervalMinutes(workDate, '00:00', '00:01', 0).startAbsMin;
  const nextDate = addDaysToDateString(workDate, 1);

  const adjacentPreviewItems: DailyCellShiftPreviewItem[] = adjacentDaysActive.map((adj) =>
    toDailyCellShiftItem({
      shiftId: Number(adj.shift_id),
      shiftCode: adj.snapshot_shift_code,
      shiftName: adj.snapshot_shift_name,
      workDate: adj.work_date,
      startTime: adj.snapshot_start_time,
      endTime: adj.snapshot_end_time,
      isCrossMidnight: Number(adj.snapshot_is_cross_midnight),
      graceMinutes: adj.snapshot_grace_minutes,
      cutoffTime: adj.snapshot_cutoff_time,
      source: 'EXISTING',
    })
  );

  // รวมกะเช้าเริ่มต้นของวันถัดไป (ถ้าวันถัดไปไม่มี Assignment เฉพาะ และไม่ได้ CLEARED_ALL_SHIFTS / วันหยุด / วันไม่ทำงาน)
  const nextDayHasExplicit = adjacentPreviewItems.some((a) => a.workDate === nextDate);
  const nextDayCleared =
    nextDayOverride?.override_state === 'CLEARED_ALL_SHIFTS' ||
    nextDayOverride?.override_state === 'PERSONAL_HOLIDAY';
  const nextDayIsHoliday = Boolean(
    nextDayPublicHoliday && Number(nextDayPublicHoliday.is_active ?? 1) === 1
  );
  const nextDayDefaultSpec =
    !nextDayHasExplicit &&
    !nextDayCleared &&
    !nextDayIsHoliday &&
    nextDayDefaultRule &&
    Number(nextDayDefaultRule.is_active) === 1 &&
    (!nextDayDefaultRule.effective_from ||
      nextDate >= normalizeWorkDateString(nextDayDefaultRule.effective_from)) &&
    isWorkDateMatchingDefaultWorkdays(nextDate, nextDayDefaultRule.default_workdays)
      ? resolveDefaultShiftSpecFromRule(nextDayDefaultRule)
      : null;

  if (nextDayDefaultSpec) {
    adjacentPreviewItems.push(
      toDailyCellShiftItem({
        shiftId: nextDayDefaultSpec.shiftId,
        shiftCode: nextDayDefaultSpec.shiftCode,
        shiftName: nextDayDefaultSpec.shiftName,
        workDate: nextDate,
        startTime: nextDayDefaultSpec.startTime,
        endTime: nextDayDefaultSpec.endTime,
        isCrossMidnight: nextDayDefaultSpec.isCrossMidnight,
        graceMinutes: nextDayDefaultSpec.graceMinutes,
        cutoffTime: nextDayDefaultSpec.cutoffTime,
        source: 'DEFAULT_IMPLICIT',
      })
    );
  }

  const carryoverFromPrevDay: DailyCellCarryoverShift[] = [];
  for (const adj of adjacentDaysActive) {
    if (adj.work_date >= workDate) continue;
    const iv = toDailyCellShiftItem({
      shiftId: Number(adj.shift_id),
      shiftCode: adj.snapshot_shift_code,
      shiftName: adj.snapshot_shift_name,
      workDate: adj.work_date,
      startTime: adj.snapshot_start_time,
      endTime: adj.snapshot_end_time,
      isCrossMidnight: Number(adj.snapshot_is_cross_midnight),
      source: 'EXISTING',
    });
    // เฉพาะกะที่เวลาสิ้นสุดจริงข้ามเข้ามาในวัน workDate (endAbsMin > 00:00 ของ workDate)
    if (iv.endAbsMin > workDateStartAbsMin) {
      carryoverFromPrevDay.push({
        assignmentId: Number(adj.id),
        shiftCode: iv.shiftCode,
        shiftName: iv.shiftName,
        workDate: iv.workDate,
        startTime: iv.startTime,
        endTime: iv.endTime,
        endDate: iv.endDate,
        isCrossMidnight: iv.isCrossMidnight,
        startAbsMin: iv.startAbsMin,
        endAbsMin: iv.endAbsMin,
        noticeText: `กะนี้เริ่มจากวันที่ ${iv.workDate} (${iv.startTime}–${iv.endTime} น. ข้ามวัน)`,
      });
    }
  }

  const nextDayShifts = adjacentPreviewItems.filter((a) => a.workDate > workDate);

  // 4. ตรวจสอบเวลาทับซ้อนแบบ Half-open [start, end)
  const intervalsOverlap = (
    a: { startAbsMin: number; endAbsMin: number },
    b: { startAbsMin: number; endAbsMin: number }
  ): boolean => Math.max(a.startAbsMin, b.startAbsMin) < Math.min(a.endAbsMin, b.endAbsMin);

  const conflicts: DailyCellConflict[] = [];
  const toRef = (x: DailyCellShiftPreviewItem) => ({
    shiftCode: x.shiftCode,
    shiftName: x.shiftName,
    workDate: x.workDate,
    startTime: x.startTime,
    endTime: x.endTime,
    endDate: x.endDate,
    isCrossMidnight: x.isCrossMidnight,
  });

  // 4.1 ตรวจทับซ้อนภายในวัน (ระหว่างกะทั้งหมดใน resultingShifts)
  for (let i = 0; i < resultingShifts.length; i++) {
    for (let j = i + 1; j < resultingShifts.length; j++) {
      const a = resultingShifts[i];
      const b = resultingShifts[j];
      if (intervalsOverlap(a, b)) {
        conflicts.push({
          code: 'SELECTED_SHIFTS_OVERLAP',
          shiftA: toRef(a),
          shiftB: toRef(b),
          message: `ช่วงเวลาทับซ้อนภายในวัน: ${formatShiftSpanLabel(a)} ทับซ้อนกับ ${formatShiftSpanLabel(b)}`,
        });
      }
    }
  }

  // 4.2 ตรวจทับซ้อนกับกะจากวันก่อนหน้าและวันถัดไป
  for (const resShift of resultingShifts) {
    for (const adj of adjacentPreviewItems) {
      if (intervalsOverlap(resShift, adj)) {
        const relationLabel = adj.workDate < workDate ? 'วันก่อนหน้า' : 'วันถัดไป';
        conflicts.push({
          code: 'ADJACENT_DAY_OVERLAP',
          shiftA: toRef(resShift),
          shiftB: toRef(adj),
          message: `เวลาทับซ้อนกับกะข้ามวันของ${relationLabel}: ${formatShiftSpanLabel(resShift)} ทับซ้อนกับ ${formatShiftSpanLabel(adj)}`,
        });
      }
    }
  }

  const willClearAll = resultingShifts.length === 0;
  const hasChanges =
    shiftsToAdd.length > 0 || shiftsToRemove.length > 0 || (willClearAll && !isCleared);

  return {
    canProceed: conflicts.length === 0,
    hasChanges,
    willClearAll,
    effectiveState,
    conflicts,
    existingEffectiveShifts,
    selectedTemplateIds: uniqueSelectedIds,
    shiftsToKeep,
    shiftsToAdd,
    shiftsToRemove,
    resultingShifts,
    carryoverFromPrevDay,
    nextDayShifts,
    specialExistingAssignments,
    defaultShiftToMaterialize,
  };
}

export async function evaluateBulkShiftAssignments(
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  options: {
    personIds: string[];
    shift?: ShiftRow;
    shifts?: ShiftRow[];
    workDates: string[];
    operationMode?: BulkOperationMode;
  }
): Promise<{
  items: BulkPreviewItem[];
  summary: {
    totalRequested: number;
    readyCount: number;
    conflictCount: number;
    duplicateCount: number;
    overlapCount: number;
    notAssignedCount: number;
    replaceAffectedCells: number;
    clearAffectedCells: number;
  };
}> {
  const { personIds, workDates } = options;
  const operationMode: BulkOperationMode = options.operationMode || 'ADD_SHIFTS';
  const selectedShifts: ShiftRow[] =
    options.shifts && options.shifts.length > 0
      ? options.shifts
      : options.shift
        ? [options.shift]
        : [];

  const personPlaceholders = personIds.map(() => '?').join(', ');
  const personnelRows = await queryRunner<PersonnelSummaryRow>(
    `SELECT person_id, full_name, department_name, personnel_type_name
     FROM personnel
     WHERE person_id IN (${personPlaceholders})`,
    personIds
  );
  const personMap = new Map<string, PersonnelSummaryRow>();
  for (const p of personnelRows) {
    const pid = String(p.person_id ?? '').trim();
    personMap.set(pid, {
      ...p,
      person_id: pid,
    });
  }

  const sortedDates = [...workDates].map((d) => normalizeWorkDateString(d)).sort();
  const selectedDateSet = new Set(sortedDates);
  const minDateMinusOne = addDaysToDateString(sortedDates[0], -1);
  const maxDatePlusOne = addDaysToDateString(sortedDates[sortedDates.length - 1], 1);

  const existingAssignments = await queryRunner<ExistingAssignmentRow>(
    `SELECT id, person_id, shift_id, work_date,
            snapshot_shift_code, snapshot_shift_name,
            snapshot_start_time, snapshot_end_time, snapshot_is_cross_midnight, status
     FROM shift_assignments
     WHERE person_id IN (${personPlaceholders})
       AND work_date >= ?
       AND work_date <= ?
       AND status = 'ACTIVE'
     ORDER BY work_date ASC, snapshot_start_time ASC`,
    [...personIds, minDateMinusOne, maxDatePlusOne]
  );

  const existingByPerson = new Map<string, ExistingAssignmentRow[]>();
  for (const rawEx of existingAssignments) {
    const exPid = String(rawEx.person_id ?? '').trim();
    const exDate = normalizeWorkDateString(rawEx.work_date);
    const ex: ExistingAssignmentRow = {
      ...rawEx,
      person_id: exPid,
      work_date: exDate,
    };
    const list = existingByPerson.get(exPid) || [];
    list.push(ex);
    existingByPerson.set(exPid, list);
  }

  const items: BulkPreviewItem[] = [];
  let readyCount = 0;
  let duplicateCount = 0;
  let overlapCount = 0;
  let notAssignedCount = 0;
  let replaceAffectedCells = 0;
  let clearAffectedCells = 0;

  for (const rawPersonId of personIds) {
    const personId = String(rawPersonId ?? '').trim();
    const personInfo = personMap.get(personId);
    const fullName = personInfo?.full_name || personId;
    const departmentName = personInfo?.department_name || '-';
    const personExisting = existingByPerson.get(personId) || [];

    // โหมด 4: ลบกะทั้งหมด (ตั้งเป็นไม่มีเวร / CLEARED_ALL_SHIFTS)
    if (operationMode === 'CLEAR_ALL_SHIFTS') {
      for (const workDate of sortedDates) {
        const sameDayActive = personExisting.filter((ex) => ex.work_date === workDate);
        clearAffectedCells++;
        readyCount++;
        items.push({
          personId,
          fullName,
          departmentName,
          workDate,
          shiftId: null,
          shiftCode: 'OFF',
          shiftName: 'ลบกะทั้งหมด (ตั้งเป็นไม่มีเวร)',
          startTime: null,
          endTime: null,
          isCrossMidnight: 0,
          operationMode,
          status: 'READY',
          conflictCode: null,
          conflictMessage: null,
          existingOnDateCount: sameDayActive.length,
          existingAssignment: sameDayActive[0]
            ? {
                id: sameDayActive[0].id,
                workDate: sameDayActive[0].work_date,
                shiftCode: sameDayActive[0].snapshot_shift_code,
                shiftName: sameDayActive[0].snapshot_shift_name,
                startTime: sameDayActive[0].snapshot_start_time,
                endTime: sameDayActive[0].snapshot_end_time,
                isCrossMidnight: Number(sameDayActive[0].snapshot_is_cross_midnight),
              }
            : null,
        });
      }
      continue;
    }

    // โหมด 3: ลบเฉพาะกะที่เลือก
    if (operationMode === 'REMOVE_SELECTED_SHIFTS') {
      for (const workDate of sortedDates) {
        for (const shift of selectedShifts) {
          const matchingEx = personExisting.find(
            (ex) => ex.work_date === workDate && Number(ex.shift_id) === Number(shift.id)
          );
          if (!matchingEx) {
            notAssignedCount++;
            items.push({
              personId,
              fullName,
              departmentName,
              workDate,
              shiftId: shift.id,
              shiftCode: shift.shift_code,
              shiftName: shift.shift_name,
              startTime: shift.start_time,
              endTime: shift.end_time,
              isCrossMidnight: Number(shift.is_cross_midnight),
              operationMode,
              status: 'NOT_ASSIGNED',
              conflictCode: 'NOT_ASSIGNED',
              conflictMessage: `ไม่พบเวรกะ ${shift.shift_name} ที่มอบหมายไว้ในวันที่ ${workDate}`,
              existingOnDateCount: 0,
              existingAssignment: null,
            });
            continue;
          }

          readyCount++;
          items.push({
            personId,
            fullName,
            departmentName,
            workDate,
            shiftId: shift.id,
            shiftCode: shift.shift_code,
            shiftName: shift.shift_name,
            startTime: shift.start_time,
            endTime: shift.end_time,
            isCrossMidnight: Number(shift.is_cross_midnight),
            operationMode,
            status: 'READY',
            conflictCode: null,
            conflictMessage: null,
            existingOnDateCount: 1,
            existingAssignment: {
              id: matchingEx.id,
              workDate: matchingEx.work_date,
              shiftCode: matchingEx.snapshot_shift_code,
              shiftName: matchingEx.snapshot_shift_name,
              startTime: matchingEx.snapshot_start_time,
              endTime: matchingEx.snapshot_end_time,
              isCrossMidnight: Number(matchingEx.snapshot_is_cross_midnight),
            },
          });
        }
      }
      continue;
    }

    // โหมด 1 (ADD_SHIFTS) และ โหมด 2 (REPLACE_SHIFTS): เก็บรายการที่ผ่านในรอบนี้ไว้ตรวจเวลาทับซ้อนข้ามวัน/ในวันเดียวกัน
    const acceptedInBatch: Array<{
      workDate: string;
      shift: ShiftRow;
      startAbsMin: number;
      endAbsMin: number;
    }> = [];

    for (const workDate of sortedDates) {
      const sameDayExisting = personExisting.filter((ex) => ex.work_date === workDate);
      if (operationMode === 'REPLACE_SHIFTS' && sameDayExisting.length > 0) {
        replaceAffectedCells++;
      }

      // สำหรับ REPLACE_SHIFTS: เวรเดิมที่อยู่ในวันที่ถูกเลือกจะถูกแทนที่ จึงตรวจเทียบกับเวรเดิมที่อยู่นอกชุดวันที่เลือกเท่านั้น (เช่น วันก่อนหน้า/วันถัดไปที่ข้ามวัน)
      const dbToCompare =
        operationMode === 'REPLACE_SHIFTS'
          ? personExisting.filter((ex) => !selectedDateSet.has(ex.work_date))
          : personExisting;

      for (const shift of selectedShifts) {
        const candidateInterval = computeAbsoluteIntervalMinutes(
          workDate,
          shift.start_time,
          shift.end_time,
          shift.is_cross_midnight
        );

        // 1. ตรวจทับซ้อนกับกะอื่นในชุดคำสั่งรอบเดียวกัน (ทั้งในวันเดียวกัน และกะข้ามวันจากวันก่อนหน้าในชุดวันที่เลือก)
        const batchOverlap = acceptedInBatch.find(
          (b) =>
            Math.max(candidateInterval.startAbsMin, b.startAbsMin) <
            Math.min(candidateInterval.endAbsMin, b.endAbsMin)
        );
        if (batchOverlap) {
          overlapCount++;
          items.push({
            personId,
            fullName,
            departmentName,
            workDate,
            shiftId: shift.id,
            shiftCode: shift.shift_code,
            shiftName: shift.shift_name,
            startTime: shift.start_time,
            endTime: shift.end_time,
            isCrossMidnight: Number(shift.is_cross_midnight),
            operationMode,
            status: 'SELECTED_SHIFTS_OVERLAP',
            conflictCode: 'SELECTED_SHIFTS_OVERLAP',
            conflictMessage: `เวลาทับซ้อนกับกะที่เลือกในชุดเดียวกัน: ${batchOverlap.shift.shift_name} (${batchOverlap.shift.start_time}–${batchOverlap.shift.end_time} น. วันที่ ${batchOverlap.workDate})`,
            existingOnDateCount: sameDayExisting.length,
            existingAssignment: null,
          });
          continue;
        }

        // 2. ตรวจซ้ำกะเดิมในระบบ (เฉพาะโหมด ADD_SHIFTS)
        if (operationMode === 'ADD_SHIFTS') {
          const sameShiftDup = dbToCompare.find(
            (ex) => Number(ex.shift_id) === Number(shift.id) && ex.work_date === workDate
          );

          if (sameShiftDup) {
            duplicateCount++;
            items.push({
              personId,
              fullName,
              departmentName,
              workDate,
              shiftId: shift.id,
              shiftCode: shift.shift_code,
              shiftName: shift.shift_name,
              startTime: shift.start_time,
              endTime: shift.end_time,
              isCrossMidnight: Number(shift.is_cross_midnight),
              operationMode,
              status: 'DUPLICATE_SAME_SHIFT',
              conflictCode: 'DUPLICATE_SAME_SHIFT',
              conflictMessage: `มีเวรกะ ${sameShiftDup.snapshot_shift_name} (${sameShiftDup.snapshot_start_time}–${sameShiftDup.snapshot_end_time} น.) ในวันนี้อยู่แล้ว`,
              existingOnDateCount: sameDayExisting.length,
              existingAssignment: {
                id: sameShiftDup.id,
                workDate: sameShiftDup.work_date,
                shiftCode: sameShiftDup.snapshot_shift_code,
                shiftName: sameShiftDup.snapshot_shift_name,
                startTime: sameShiftDup.snapshot_start_time,
                endTime: sameShiftDup.snapshot_end_time,
                isCrossMidnight: Number(sameShiftDup.snapshot_is_cross_midnight),
              },
            });
            continue;
          }
        }

        // 3. ตรวจเวลาทับซ้อนกับเวรเดิมในระบบ (รวมกะข้ามวันจากวันก่อนหน้า/วันถัดไป)
        const overlappingEx = dbToCompare.find((ex) => {
          const exInterval = computeAbsoluteIntervalMinutes(
            ex.work_date,
            ex.snapshot_start_time,
            ex.snapshot_end_time,
            ex.snapshot_is_cross_midnight
          );
          return (
            Math.max(candidateInterval.startAbsMin, exInterval.startAbsMin) <
            Math.min(candidateInterval.endAbsMin, exInterval.endAbsMin)
          );
        });

        if (overlappingEx) {
          overlapCount++;
          items.push({
            personId,
            fullName,
            departmentName,
            workDate,
            shiftId: shift.id,
            shiftCode: shift.shift_code,
            shiftName: shift.shift_name,
            startTime: shift.start_time,
            endTime: shift.end_time,
            isCrossMidnight: Number(shift.is_cross_midnight),
            operationMode,
            status: 'TIME_OVERLAP_CONFLICT',
            conflictCode: 'TIME_OVERLAP_CONFLICT',
            conflictMessage: `เวลาทับซ้อนกับ ${overlappingEx.snapshot_shift_name} (${overlappingEx.snapshot_start_time}–${overlappingEx.snapshot_end_time} น. วันที่ ${overlappingEx.work_date})`,
            existingOnDateCount: sameDayExisting.length,
            existingAssignment: {
              id: overlappingEx.id,
              workDate: overlappingEx.work_date,
              shiftCode: overlappingEx.snapshot_shift_code,
              shiftName: overlappingEx.snapshot_shift_name,
              startTime: overlappingEx.snapshot_start_time,
              endTime: overlappingEx.snapshot_end_time,
              isCrossMidnight: Number(overlappingEx.snapshot_is_cross_midnight),
            },
          });
          continue;
        }

        acceptedInBatch.push({
          workDate,
          shift,
          startAbsMin: candidateInterval.startAbsMin,
          endAbsMin: candidateInterval.endAbsMin,
        });
        readyCount++;
        items.push({
          personId,
          fullName,
          departmentName,
          workDate,
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          shiftName: shift.shift_name,
          startTime: shift.start_time,
          endTime: shift.end_time,
          isCrossMidnight: Number(shift.is_cross_midnight),
          operationMode,
          status: 'READY',
          conflictCode: null,
          conflictMessage: null,
          existingOnDateCount: sameDayExisting.length,
          existingAssignment:
            operationMode === 'REPLACE_SHIFTS' && sameDayExisting[0]
              ? {
                  id: sameDayExisting[0].id,
                  workDate: sameDayExisting[0].work_date,
                  shiftCode: sameDayExisting[0].snapshot_shift_code,
                  shiftName: sameDayExisting[0].snapshot_shift_name,
                  startTime: sameDayExisting[0].snapshot_start_time,
                  endTime: sameDayExisting[0].snapshot_end_time,
                  isCrossMidnight: Number(sameDayExisting[0].snapshot_is_cross_midnight),
                }
              : null,
        });
      }
    }
  }

  return {
    items,
    summary: {
      totalRequested: items.length,
      readyCount,
      conflictCount: duplicateCount + overlapCount,
      duplicateCount,
      overlapCount,
      notAssignedCount,
      replaceAffectedCells,
      clearAffectedCells,
    },
  };
}

// ============================================================================
// 1. กฎกะเช้าเริ่มต้นตามประเภทบุคลากร (Personnel Type Default Shift Rules)
// ============================================================================

shiftsRouter.get(
  '/personnel-type-rules',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const rules = await loadPersonnelTypeRulesWithDefaultShifts();
      const history = await dbQuery<Record<string, unknown>>(
        'SELECT * FROM personnel_type_rule_history ORDER BY id DESC LIMIT 50'
      );
      res.json({
        items: rules.map((r) => ({
          ...r,
          effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
        })),
        history: history.map((h) => ({
          ...h,
          effective_from: normalizeWorkDateString(h.effective_from || '2026-01-01'),
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.post(
  '/personnel-type-rules',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personnelTypeCode = String(req.body?.personnelTypeCode || '')
        .trim()
        .toUpperCase();
      const personnelTypeName = String(req.body?.personnelTypeName || '').trim();
      const rawDefaultShiftId = req.body?.defaultShiftId;
      const hasExplicitDefaultShiftId =
        rawDefaultShiftId !== undefined && rawDefaultShiftId !== null && String(rawDefaultShiftId).trim() !== '';
      const defaultShiftIdNum = hasExplicitDefaultShiftId ? Number(rawDefaultShiftId) : null;
      const noDefaultShift =
        Boolean(req.body?.noDefaultShift) ||
        (req.body?.defaultShiftId === null && req.body?.defaultStartTime === undefined);

      const defaultWorkdays = normalizeDefaultWorkdays(
        req.body?.defaultWorkdays,
        DEFAULT_ALL_WORKDAYS
      );

      let linkedShift: ShiftRow | null = null;
      if (hasExplicitDefaultShiftId) {
        if (!Number.isInteger(defaultShiftIdNum) || (defaultShiftIdNum as number) <= 0) {
          res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: 'รหัสแม่แบบกะเริ่มต้นไม่ถูกต้อง',
            requestId: req.requestId,
          });
          return;
        }
        const shiftRows = await dbQuery<ShiftRow>('SELECT * FROM shifts WHERE id = ? LIMIT 1', [
          defaultShiftIdNum,
        ]);
        if (shiftRows.length === 0) {
          res.status(404).json({
            error: 'SHIFT_NOT_FOUND',
            message: 'ไม่พบแม่แบบกะทำงานที่เลือก',
            requestId: req.requestId,
          });
          return;
        }
        if (Number(shiftRows[0].is_active) !== 1) {
          res.status(400).json({
            error: 'SHIFT_INACTIVE',
            message: `แม่แบบกะ "${shiftRows[0].shift_name}" ถูกปิดใช้งานอยู่ ไม่สามารถกำหนดเป็นกะเริ่มต้นได้`,
            requestId: req.requestId,
          });
          return;
        }
        linkedShift = shiftRows[0];
      }

      const defaultStartTime = linkedShift
        ? linkedShift.start_time
        : noDefaultShift
          ? ''
          : String(req.body?.defaultStartTime ?? '08:00').trim();
      const defaultEndTime = linkedShift
        ? linkedShift.end_time
        : noDefaultShift
          ? ''
          : String(req.body?.defaultEndTime ?? '16:00').trim();
      const defaultGraceMinutes = linkedShift
        ? Number(linkedShift.grace_minutes ?? 15)
        : Number(req.body?.defaultGraceMinutes ?? 15);
      const defaultCutoffTime = linkedShift
        ? linkedShift.cutoff_time
        : noDefaultShift
          ? ''
          : String(req.body?.defaultCutoffTime ?? '11:00').trim();
      const effectiveFrom = normalizeWorkDateString(req.body?.effectiveFrom || '2026-01-01');
      const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : 1;
      const reason = String(
        req.body?.reason || 'สร้างประเภทบุคลากรและกำหนดกะเริ่มต้นตามประเภทบุคลากร'
      ).trim();

      const timesValid =
        linkedShift !== null || noDefaultShift
          ? true
          : /^\d{2}:\d{2}$/.test(defaultStartTime) &&
            /^\d{2}:\d{2}$/.test(defaultEndTime) &&
            /^\d{2}:\d{2}$/.test(defaultCutoffTime);

      if (
        !personnelTypeCode ||
        !personnelTypeName ||
        !timesValid ||
        !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ||
        Number.isNaN(defaultGraceMinutes) ||
        defaultGraceMinutes < 0 ||
        defaultGraceMinutes > 180
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message:
            'กรุณาระบุรหัสประเภทบุคลากร ชื่อประเภท เวลาเริ่ม–เลิกงาน เวลาผ่อนผัน เวลาตัดรอบ และวันที่มีผลบังคับใช้ให้ครบถ้วน',
          requestId: req.requestId,
        });
        return;
      }

      if (linkedShift && !defaultWorkdays) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกวันทำงานอย่างน้อย 1 วันเมื่อกำหนดแม่แบบกะเริ่มต้น',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ id: number }>(
        'SELECT id FROM personnel_type_rules WHERE personnel_type_code = ? LIMIT 1',
        [personnelTypeCode]
      );
      if (existing.length > 0) {
        res.status(409).json({
          error: 'DUPLICATE_PERSONNEL_TYPE_CODE',
          message: `รหัสประเภทบุคลากร ${personnelTypeCode} มีอยู่ในระบบแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      const createdId = await withDefaultShiftScopeLocks([personnelTypeCode], () =>
        dbTransaction(async (tx: DbTransactionContext): Promise<number> => {
          const ins = await tx.execute(
            `INSERT INTO personnel_type_rules (
              personnel_type_code, personnel_type_name, default_start_time, default_end_time,
              default_grace_minutes, default_cutoff_time, effective_from, is_active,
              CheckinWindowBeforeMinutes, CheckoutWindowAfterMinutes, require_checkout,
              allow_overlapping_shifts, rule_version, default_shift_id, default_workdays
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 120, 240, 1, 0, 'v2.3.0', ?, ?)`,
            [
              personnelTypeCode,
              personnelTypeName,
              defaultStartTime,
              defaultEndTime,
              defaultGraceMinutes,
              defaultCutoffTime,
              effectiveFrom,
              isActive,
              linkedShift ? linkedShift.id : null,
              defaultWorkdays || DEFAULT_ALL_WORKDAYS,
            ]
          );

          if (linkedShift) {
            await tx.execute(
              `INSERT INTO personnel_type_default_shifts (
                personnel_type_code, shift_id, assigned_by, assigned_reason
              ) VALUES (?, ?, ?, ?)`,
              [personnelTypeCode, linkedShift.id, req.user!.username, reason]
            );
          }

          await tx.execute(
            `INSERT INTO personnel_type_rule_history (
              rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
              default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by,
              default_shift_id, default_workdays
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?)`,
            [
              ins.insertId,
              personnelTypeCode,
              personnelTypeName,
              defaultStartTime,
              defaultEndTime,
              defaultGraceMinutes,
              defaultCutoffTime,
              effectiveFrom,
              isActive,
              req.user!.username,
              linkedShift ? linkedShift.id : null,
              defaultWorkdays || DEFAULT_ALL_WORKDAYS,
            ]
          );

          return Number(ins.insertId);
        })
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'PERSONNEL_TYPE_RULE_CREATED',
        targetType: 'PERSONNEL_TYPE_RULE',
        targetId: String(createdId),
        result: 'SUCCESS',
        detail: {
          personnelTypeCode,
          personnelTypeName,
          defaultShiftId: linkedShift ? linkedShift.id : null,
          defaultShiftCode: linkedShift ? linkedShift.shift_code : null,
          defaultWorkdays: defaultWorkdays || DEFAULT_ALL_WORKDAYS,
          defaultStartTime,
          defaultEndTime,
          defaultGraceMinutes,
          defaultCutoffTime,
          effectiveFrom,
          isActive,
          reason,
        },
      });

      res.status(201).json({
        id: createdId,
        personnelTypeCode,
        personnelTypeName,
        defaultShiftId: linkedShift ? linkedShift.id : null,
        defaultWorkdays: defaultWorkdays || DEFAULT_ALL_WORKDAYS,
        defaultStartTime,
        defaultEndTime,
        defaultGraceMinutes,
        defaultCutoffTime,
        effectiveFrom,
        isActive,
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.put(
  '/personnel-type-rules/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const ruleId = Number(req.params.id);
      const rows = await dbQuery<PersonnelTypeRuleRow>(
        'SELECT * FROM personnel_type_rules WHERE id = ? LIMIT 1',
        [ruleId]
      );
      if (rows.length === 0) {
        res.status(404).json({
          error: 'RULE_NOT_FOUND',
          message: 'ไม่พบกฎกะเริ่มต้นของประเภทบุคลากรที่ต้องการแก้ไข',
          requestId: req.requestId,
        });
        return;
      }

      const current = rows[0];
      const scopeCode = String(current.personnel_type_code || '').trim().toUpperCase();
      const personnelTypeName = String(
        req.body?.personnelTypeName || current.personnel_type_name
      ).trim();

      const hasDefaultShiftIdKey = Object.prototype.hasOwnProperty.call(
        req.body || {},
        'defaultShiftId'
      );
      const hasDefaultWorkdaysKey = Object.prototype.hasOwnProperty.call(
        req.body || {},
        'defaultWorkdays'
      );

      const nextDefaultWorkdays = hasDefaultWorkdaysKey
        ? normalizeDefaultWorkdays(req.body.defaultWorkdays, '')
        : normalizeDefaultWorkdays(current.default_workdays, DEFAULT_ALL_WORKDAYS);

      let targetShift: ShiftRow | null = null;
      let clearingDefaultShift = false;
      if (hasDefaultShiftIdKey) {
        const rawSid = req.body.defaultShiftId;
        if (rawSid === null || rawSid === '' || Number(rawSid) === 0) {
          clearingDefaultShift = true;
        } else {
          const parsedSid = Number(rawSid);
          if (!Number.isInteger(parsedSid) || parsedSid <= 0) {
            res.status(400).json({
              error: 'VALIDATION_ERROR',
              message: 'รหัสแม่แบบกะเริ่มต้นไม่ถูกต้อง',
              requestId: req.requestId,
            });
            return;
          }
          const shiftRows = await dbQuery<ShiftRow>('SELECT * FROM shifts WHERE id = ? LIMIT 1', [
            parsedSid,
          ]);
          if (shiftRows.length === 0) {
            res.status(404).json({
              error: 'SHIFT_NOT_FOUND',
              message: 'ไม่พบแม่แบบกะทำงานที่เลือก',
              requestId: req.requestId,
            });
            return;
          }
          if (Number(shiftRows[0].is_active) !== 1) {
            res.status(400).json({
              error: 'SHIFT_INACTIVE',
              message: `แม่แบบกะ "${shiftRows[0].shift_name}" ถูกปิดใช้งานอยู่ ไม่สามารถกำหนดเป็นกะเริ่มต้นได้`,
              requestId: req.requestId,
            });
            return;
          }
          targetShift = shiftRows[0];
        }
      }

      const defaultStartTime = targetShift
        ? targetShift.start_time
        : clearingDefaultShift
          ? ''
          : String(req.body?.defaultStartTime ?? current.default_start_time ?? '').trim();
      const defaultEndTime = targetShift
        ? targetShift.end_time
        : clearingDefaultShift
          ? ''
          : String(req.body?.defaultEndTime ?? current.default_end_time ?? '').trim();
      const defaultGraceMinutes = targetShift
        ? Number(targetShift.grace_minutes ?? 15)
        : req.body?.defaultGraceMinutes !== undefined
          ? Number(req.body.defaultGraceMinutes)
          : Number(current.default_grace_minutes ?? 15);
      const defaultCutoffTime = targetShift
        ? targetShift.cutoff_time
        : clearingDefaultShift
          ? ''
          : String(req.body?.defaultCutoffTime ?? current.default_cutoff_time ?? '').trim();
      const effectiveFrom = normalizeWorkDateString(
        req.body?.effectiveFrom || current.effective_from || '2026-01-01'
      );
      const isActive =
        req.body?.isActive !== undefined
          ? req.body.isActive
            ? 1
            : 0
          : Number(current.is_active ?? 1);
      const reason = String(
        req.body?.reason ||
          (clearingDefaultShift
            ? 'ยกเลิกการกำหนดกะเริ่มต้นตามประเภทบุคลากร'
            : targetShift
              ? `เปลี่ยนกะเริ่มต้นตามประเภทบุคลากรเป็น "${targetShift.shift_name}"`
              : 'แก้ไขกฎกะเริ่มต้นตามประเภทบุคลากร')
      ).trim();

      const allowEmptyTimes =
        clearingDefaultShift ||
        (!hasDefaultShiftIdKey &&
          current.default_shift_id == null &&
          !defaultStartTime &&
          !defaultEndTime);

      const timesValid = allowEmptyTimes
        ? true
        : /^\d{2}:\d{2}$/.test(defaultStartTime) &&
          /^\d{2}:\d{2}$/.test(defaultEndTime) &&
          /^\d{2}:\d{2}$/.test(defaultCutoffTime);

      if (
        !personnelTypeName ||
        !timesValid ||
        !/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom) ||
        Number.isNaN(defaultGraceMinutes) ||
        defaultGraceMinutes < 0 ||
        defaultGraceMinutes > 180
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message:
            'ข้อมูลเวลาเริ่ม–เลิกงาน เวลาผ่อนผัน เวลาตัดรอบ หรือวันที่มีผลบังคับใช้ไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      if (targetShift && !nextDefaultWorkdays) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกวันทำงานอย่างน้อย 1 วันสำหรับแม่แบบกะเริ่มต้น',
          requestId: req.requestId,
        });
        return;
      }

      const txOutcome = await withDefaultShiftScopeLocks([scopeCode], () =>
        dbTransaction(async (tx: DbTransactionContext) => {
          const lockClause = loadConfig().dbEngine === 'mysql' ? ' FOR UPDATE' : '';
          const prevBindingRows = await tx.query<{
            id: number;
            shift_id: number;
            shift_code: string | null;
            shift_name: string | null;
          }>(
            `SELECT ds.id, ds.shift_id, s.shift_code, s.shift_name
             FROM personnel_type_default_shifts ds
             LEFT JOIN shifts s ON s.id = ds.shift_id
             WHERE ds.personnel_type_code = ?
             LIMIT 1${lockClause}`,
            [scopeCode]
          );
          const prevBinding = prevBindingRows[0] || null;

          let nextDefaultShiftId: number | null =
            current.default_shift_id !== undefined && current.default_shift_id !== null
              ? Number(current.default_shift_id)
              : prevBinding
                ? Number(prevBinding.shift_id)
                : null;
          let actionType = 'UPDATED';

          if (clearingDefaultShift) {
            await tx.execute(
              'DELETE FROM personnel_type_default_shifts WHERE personnel_type_code = ?',
              [scopeCode]
            );
            nextDefaultShiftId = null;
            actionType = 'DEFAULT_SHIFT_CLEARED';
          } else if (targetShift) {
            if (prevBinding) {
              await tx.execute(
                `UPDATE personnel_type_default_shifts
                 SET shift_id = ?, assigned_by = ?, assigned_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE personnel_type_code = ?`,
                [targetShift.id, req.user!.username, reason, scopeCode]
              );
              actionType =
                Number(prevBinding.shift_id) === Number(targetShift.id)
                  ? 'DEFAULT_WORKDAYS_UPDATED'
                  : 'DEFAULT_SHIFT_CHANGED';
            } else {
              await tx.execute(
                `INSERT INTO personnel_type_default_shifts (
                  personnel_type_code, shift_id, assigned_by, assigned_reason
                ) VALUES (?, ?, ?, ?)`,
                [scopeCode, targetShift.id, req.user!.username, reason]
              );
              actionType = 'DEFAULT_SHIFT_ASSIGNED';
            }
            nextDefaultShiftId = Number(targetShift.id);
          }

          await tx.execute(
            `UPDATE personnel_type_rules
             SET personnel_type_name = ?,
                 default_shift_id = ?,
                 default_workdays = ?,
                 default_start_time = ?,
                 default_end_time = ?,
                 default_grace_minutes = ?,
                 default_cutoff_time = ?,
                 effective_from = ?,
                 is_active = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              personnelTypeName,
              nextDefaultShiftId,
              nextDefaultWorkdays || DEFAULT_ALL_WORKDAYS,
              defaultStartTime,
              defaultEndTime,
              defaultGraceMinutes,
              defaultCutoffTime,
              effectiveFrom,
              isActive,
              ruleId,
            ]
          );

          await tx.execute(
            `INSERT INTO personnel_type_rule_history (
              rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
              default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by,
              default_shift_id, default_workdays
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              ruleId,
              scopeCode,
              personnelTypeName,
              defaultStartTime,
              defaultEndTime,
              defaultGraceMinutes,
              defaultCutoffTime,
              effectiveFrom,
              isActive,
              actionType,
              req.user!.username,
              nextDefaultShiftId,
              nextDefaultWorkdays || DEFAULT_ALL_WORKDAYS,
            ]
          );

          return {
            prevBinding,
            nextDefaultShiftId,
            actionType,
          };
        })
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action:
          txOutcome.actionType === 'DEFAULT_SHIFT_CLEARED'
            ? 'DEFAULT_SHIFT_CLEARED'
            : txOutcome.actionType === 'DEFAULT_SHIFT_CHANGED'
              ? 'DEFAULT_SHIFT_CHANGED'
              : txOutcome.actionType === 'DEFAULT_SHIFT_ASSIGNED'
                ? 'DEFAULT_SHIFT_ASSIGNED'
                : 'PERSONNEL_TYPE_RULE_UPDATED',
        targetType: 'PERSONNEL_TYPE_RULE',
        targetId: String(ruleId),
        result: 'SUCCESS',
        detail: {
          personnelTypeCode: scopeCode,
          reason,
          historicalAssignmentsPreserved: true,
          attendanceAutoMutation: false,
          previous: {
            defaultShiftId: txOutcome.prevBinding ? Number(txOutcome.prevBinding.shift_id) : null,
            defaultShiftCode: txOutcome.prevBinding?.shift_code || null,
            defaultShiftName: txOutcome.prevBinding?.shift_name || null,
            defaultWorkdays: normalizeDefaultWorkdays(current.default_workdays, DEFAULT_ALL_WORKDAYS),
            defaultStartTime: current.default_start_time,
            defaultEndTime: current.default_end_time,
            defaultGraceMinutes: current.default_grace_minutes,
            defaultCutoffTime: current.default_cutoff_time,
            effectiveFrom: normalizeWorkDateString(current.effective_from),
            isActive: current.is_active,
          },
          updated: {
            personnelTypeName,
            defaultShiftId: txOutcome.nextDefaultShiftId,
            defaultShiftCode: targetShift ? targetShift.shift_code : null,
            defaultShiftName: targetShift ? targetShift.shift_name : null,
            defaultWorkdays: nextDefaultWorkdays || DEFAULT_ALL_WORKDAYS,
            defaultStartTime,
            defaultEndTime,
            defaultGraceMinutes,
            defaultCutoffTime,
            effectiveFrom,
            isActive,
          },
        },
      });

      res.json({
        status: 'UPDATED',
        id: ruleId,
        personnelTypeCode: scopeCode,
        personnelTypeName,
        defaultShiftId: txOutcome.nextDefaultShiftId,
        defaultShiftCode: targetShift ? targetShift.shift_code : null,
        defaultShiftName: targetShift ? targetShift.shift_name : null,
        defaultWorkdays: nextDefaultWorkdays || DEFAULT_ALL_WORKDAYS,
        defaultStartTime,
        defaultEndTime,
        defaultGraceMinutes,
        defaultCutoffTime,
        effectiveFrom,
        isActive,
        message: clearingDefaultShift
          ? `ยกเลิกกะเริ่มต้นของ "${personnelTypeName}" เรียบร้อยแล้ว (ไม่กระทบตารางเวรและข้อมูลย้อนหลัง)`
          : targetShift
            ? `กำหนดกะเริ่มต้นของ "${personnelTypeName}" เป็น "${targetShift.shift_name}" เรียบร้อยแล้ว (ไม่กระทบตารางเวรและข้อมูลย้อนหลัง)`
            : `อัปเดตกฎประเภทบุคลากร "${personnelTypeName}" เรียบร้อยแล้ว`,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.patch(
  '/personnel-type-rules/:id/toggle',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const ruleId = Number(req.params.id);
      const rows = await dbQuery<PersonnelTypeRuleRow>(
        'SELECT * FROM personnel_type_rules WHERE id = ? LIMIT 1',
        [ruleId]
      );
      if (rows.length === 0) {
        res.status(404).json({
          error: 'RULE_NOT_FOUND',
          message: 'ไม่พบกฎกะเริ่มต้นที่ต้องการเปลี่ยนสถานะ',
          requestId: req.requestId,
        });
        return;
      }

      const current = rows[0];
      const nextActive =
        req.body?.isActive !== undefined
          ? req.body.isActive
            ? 1
            : 0
          : Number(current.is_active) === 1
            ? 0
            : 1;

      await dbExecute(
        'UPDATE personnel_type_rules SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [nextActive, ruleId]
      );

      await dbExecute(
        `INSERT INTO personnel_type_rule_history (
          rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
          default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'TOGGLED_ACTIVE', ?)`,
        [
          ruleId,
          current.personnel_type_code,
          current.personnel_type_name,
          current.default_start_time || '08:00',
          current.default_end_time || '16:00',
          Number(current.default_grace_minutes ?? 15),
          current.default_cutoff_time || '11:00',
          normalizeWorkDateString(current.effective_from || '2026-01-01'),
          nextActive,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'PERSONNEL_TYPE_RULE_TOGGLED',
        targetType: 'PERSONNEL_TYPE_RULE',
        targetId: String(ruleId),
        result: 'SUCCESS',
        detail: {
          personnelTypeCode: current.personnel_type_code,
          isActive: nextActive,
        },
      });

      res.json({
        status: 'UPDATED',
        id: ruleId,
        isActive: nextActive,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// 2. แม่แบบกะทำงาน (Shift Templates — แยกจากประเภทบุคลากรอย่างชัดเจน)
// ============================================================================

function parseRequestedDefaultPersonnelTypeCodes(body: Record<string, unknown> | undefined): string[] {
  const result: string[] = [];
  if (Array.isArray(body?.defaultPersonnelTypeCodes)) {
    for (const raw of body.defaultPersonnelTypeCodes) {
      const code = String(raw || '').trim().toUpperCase();
      if (code && !result.includes(code)) result.push(code);
    }
  }
  if (typeof body?.defaultPersonnelTypeCode === 'string' && body.defaultPersonnelTypeCode.trim()) {
    const code = body.defaultPersonnelTypeCode.trim().toUpperCase();
    if (!result.includes(code)) result.push(code);
  }
  return result;
}

shiftsRouter.get(
  '/shifts',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const [rawShifts, rules] = await Promise.all([
        dbQuery<ShiftRow>('SELECT * FROM shifts ORDER BY id ASC'),
        loadPersonnelTypeRulesWithDefaultShifts(),
      ]);

      const defaultTypesByShiftId = new Map<
        number,
        Array<{
          personnelTypeCode: string;
          personnelTypeName: string;
          effectiveFrom: string;
          isRuleActive: boolean;
          assignedBy: string | null;
          assignedReason: string | null;
          updatedAt: string | null;
        }>
      >();

      const defaultBindings: DefaultShiftBindingSummary[] = rules.map((r) => {
        const shiftId = r.default_shift_id != null ? Number(r.default_shift_id) : null;
        const effectiveFrom = normalizeWorkDateString(r.effective_from || '2026-01-01');
        const isRuleActive = Number(r.is_active ?? 1) === 1;
        if (shiftId != null) {
          const list = defaultTypesByShiftId.get(shiftId) || [];
          list.push({
            personnelTypeCode: r.personnel_type_code,
            personnelTypeName: r.personnel_type_name,
            effectiveFrom,
            isRuleActive,
            assignedBy: r.default_assigned_by || null,
            assignedReason: r.default_assigned_reason || null,
            updatedAt: r.default_updated_at ? String(r.default_updated_at) : null,
          });
          defaultTypesByShiftId.set(shiftId, list);
        }
        return {
          personnelTypeCode: r.personnel_type_code,
          personnelTypeName: r.personnel_type_name,
          isRuleActive,
          effectiveFrom,
          defaultWorkdays: normalizeDefaultWorkdays(r.default_workdays, DEFAULT_ALL_WORKDAYS),
          defaultShiftId: shiftId,
          defaultShiftCode: r.default_shift_code || null,
          defaultShiftName: r.default_shift_name || null,
          defaultStartTime: r.default_shift_start_time || (r.default_start_time || null),
          defaultEndTime: r.default_shift_end_time || (r.default_end_time || null),
          defaultGraceMinutes:
            r.default_shift_grace_minutes !== undefined && r.default_shift_grace_minutes !== null
              ? Number(r.default_shift_grace_minutes)
              : Number(r.default_grace_minutes ?? 15),
          defaultCutoffTime: r.default_shift_cutoff_time || (r.default_cutoff_time || null),
          defaultIsCrossMidnight: Number(r.default_shift_is_cross_midnight ?? 0),
          assignedBy: r.default_assigned_by || null,
          assignedReason: r.default_assigned_reason || null,
          updatedAt: r.default_updated_at ? String(r.default_updated_at) : null,
        };
      });

      const items = rawShifts.map((s) => {
        const defaultPersonnelTypes = defaultTypesByShiftId.get(Number(s.id)) || [];
        return {
          ...s,
          is_default: defaultPersonnelTypes.length > 0 ? 1 : 0,
          default_personnel_types: defaultPersonnelTypes,
        };
      });

      res.json({
        items,
        personnelTypeRules: rules.map((r) => ({
          ...r,
          effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
          has_default_shift_template: r.default_shift_id != null,
        })),
        defaultBindings,
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.post(
  '/shifts',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const shiftCode = String(req.body?.shiftCode || '').trim().toUpperCase();
      const shiftName = String(req.body?.shiftName || '').trim();
      const shiftCategory = String(req.body?.shiftCategory || 'OFFICIAL').trim().toUpperCase();
      const startTime = String(req.body?.startTime || '').trim();
      const endTime = String(req.body?.endTime || '').trim();
      const graceMinutes = Number(req.body?.graceMinutes ?? 15);
      const cutoffTime = String(req.body?.cutoffTime || '').trim();
      const isCrossMidnight =
        req.body?.isCrossMidnight !== undefined
          ? Number(Boolean(req.body.isCrossMidnight))
          : endTime <= startTime
            ? 1
            : 0;
      const isDefault = Boolean(req.body?.isDefault);
      const defaultPersonnelTypeCodes = isDefault
        ? parseRequestedDefaultPersonnelTypeCodes(req.body)
        : [];
      const defaultReason = String(
        req.body?.defaultReason || 'กำหนดเป็นกะเริ่มต้นขณะสร้างแม่แบบกะทำงาน'
      ).trim();

      if (
        !shiftCode ||
        !shiftName ||
        !/^\d{2}:\d{2}$/.test(startTime) ||
        !/^\d{2}:\d{2}$/.test(endTime) ||
        !/^\d{2}:\d{2}$/.test(cutoffTime) ||
        Number.isNaN(graceMinutes) ||
        graceMinutes < 0 ||
        graceMinutes > 180
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสกะ ชื่อกะ เวลาเริ่ม-สิ้นสุด เวลาผ่อนผัน และเวลาตัดรอบสแกนในรูปแบบ HH:mm',
          requestId: req.requestId,
        });
        return;
      }

      if (isDefault && defaultPersonnelTypeCodes.length === 0) {
        res.status(400).json({
          error: 'DEFAULT_SCOPE_REQUIRED',
          message: 'กรุณาระบุขอบเขตประเภทบุคลากรอย่างน้อย 1 ประเภท เมื่อเลือกกำหนดเป็นกะเริ่มต้น',
          requestId: req.requestId,
        });
        return;
      }

      type CreateShiftTxOutcome =
        | { status: 'DUPLICATE_SHIFT_CODE' }
        | { status: 'PERSONNEL_TYPE_NOT_FOUND'; missingCode: string }
        | {
            status: 'DEFAULT_ALREADY_EXISTS';
            conflicts: Array<{
              personnelTypeCode: string;
              personnelTypeName: string;
              currentDefaultShiftId: number;
              currentDefaultShiftCode: string;
              currentDefaultShiftName: string;
              currentStartTime: string;
              currentEndTime: string;
            }>;
          }
        | { status: 'CREATED'; shiftId: number };

      const txOutcome: CreateShiftTxOutcome = await withDefaultShiftScopeLocks(
        defaultPersonnelTypeCodes,
        () =>
          dbTransaction(async (tx: DbTransactionContext): Promise<CreateShiftTxOutcome> => {
            const existing = await tx.query<{ id: number }>(
              'SELECT id FROM shifts WHERE shift_code = ? LIMIT 1',
              [shiftCode]
            );
            if (existing.length > 0) {
              return { status: 'DUPLICATE_SHIFT_CODE' };
            }

            const conflicts: Array<{
              personnelTypeCode: string;
              personnelTypeName: string;
              currentDefaultShiftId: number;
              currentDefaultShiftCode: string;
              currentDefaultShiftName: string;
              currentStartTime: string;
              currentEndTime: string;
            }> = [];

            const targetRuleRows = new Map<string, PersonnelTypeRuleRow>();
            if (isDefault) {
              const lockClause = loadConfig().dbEngine === 'mysql' ? ' FOR UPDATE' : '';
              for (const scopeCode of defaultPersonnelTypeCodes) {
                const ruleRows = await tx.query<PersonnelTypeRuleRow>(
                  `SELECT * FROM personnel_type_rules WHERE personnel_type_code = ? LIMIT 1${lockClause}`,
                  [scopeCode]
                );
                if (ruleRows.length === 0) {
                  return { status: 'PERSONNEL_TYPE_NOT_FOUND', missingCode: scopeCode };
                }
                targetRuleRows.set(scopeCode, ruleRows[0]);

                const existingDefault = await tx.query<{
                  shift_id: number;
                  shift_code: string;
                  shift_name: string;
                  start_time: string;
                  end_time: string;
                }>(
                  `SELECT ds.shift_id, s.shift_code, s.shift_name, s.start_time, s.end_time
                   FROM personnel_type_default_shifts ds
                   INNER JOIN shifts s ON s.id = ds.shift_id
                   WHERE ds.personnel_type_code = ?
                   LIMIT 1${lockClause}`,
                  [scopeCode]
                );
                if (existingDefault.length > 0) {
                  conflicts.push({
                    personnelTypeCode: scopeCode,
                    personnelTypeName: ruleRows[0].personnel_type_name,
                    currentDefaultShiftId: Number(existingDefault[0].shift_id),
                    currentDefaultShiftCode: existingDefault[0].shift_code,
                    currentDefaultShiftName: existingDefault[0].shift_name,
                    currentStartTime: existingDefault[0].start_time,
                    currentEndTime: existingDefault[0].end_time,
                  });
                }
              }

              if (conflicts.length > 0) {
                return { status: 'DEFAULT_ALREADY_EXISTS', conflicts };
              }
            }

            const result = await tx.execute(
              `INSERT INTO shifts (
                shift_code, shift_name, shift_category, start_time, end_time,
                grace_minutes, cutoff_time, is_cross_midnight, is_active
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
              [
                shiftCode,
                shiftName,
                shiftCategory,
                startTime,
                endTime,
                graceMinutes,
                cutoffTime,
                isCrossMidnight,
              ]
            );
            const newShiftId = Number(result.insertId);

            if (isDefault) {
              for (const scopeCode of defaultPersonnelTypeCodes) {
                const rule = targetRuleRows.get(scopeCode)!;
                await tx.execute(
                  `INSERT INTO personnel_type_default_shifts (
                    personnel_type_code, shift_id, assigned_by, assigned_reason
                  ) VALUES (?, ?, ?, ?)`,
                  [scopeCode, newShiftId, req.user!.username, defaultReason]
                );
                await tx.execute(
                  `UPDATE personnel_type_rules
                   SET default_shift_id = ?,
                       default_start_time = ?,
                       default_end_time = ?,
                       default_grace_minutes = ?,
                       default_cutoff_time = ?,
                       is_active = 1,
                       updated_at = CURRENT_TIMESTAMP
                   WHERE personnel_type_code = ?`,
                  [newShiftId, startTime, endTime, graceMinutes, cutoffTime, scopeCode]
                );
                await tx.execute(
                  `INSERT INTO personnel_type_rule_history (
                    rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
                    default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by, default_shift_id
                  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'DEFAULT_SHIFT_ASSIGNED', ?, ?)`,
                  [
                    rule.id,
                    scopeCode,
                    rule.personnel_type_name,
                    startTime,
                    endTime,
                    graceMinutes,
                    cutoffTime,
                    normalizeWorkDateString(rule.effective_from || '2026-01-01'),
                    req.user!.username,
                    newShiftId,
                  ]
                );
              }
            }

            return { status: 'CREATED', shiftId: newShiftId };
          })
      );

      if (txOutcome.status === 'DUPLICATE_SHIFT_CODE') {
        res.status(409).json({
          error: 'DUPLICATE_SHIFT_CODE',
          message: `รหัสกะ ${shiftCode} มีอยู่ในระบบแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      if (txOutcome.status === 'PERSONNEL_TYPE_NOT_FOUND') {
        res.status(404).json({
          error: 'PERSONNEL_TYPE_NOT_FOUND',
          message: `ไม่พบประเภทบุคลากรรหัส ${txOutcome.missingCode} ในระบบ`,
          requestId: req.requestId,
        });
        return;
      }

      if (txOutcome.status === 'DEFAULT_ALREADY_EXISTS') {
        const first = txOutcome.conflicts[0];
        res.status(409).json({
          error: 'DEFAULT_SHIFT_ALREADY_EXISTS',
          message: `ประเภทบุคลากร "${first.personnelTypeName}" มีกะเริ่มต้นใช้งานอยู่แล้วคือ "${first.currentDefaultShiftName}" (${first.currentDefaultShiftCode}) ไม่สามารถกำหนดซ้ำได้ หากต้องการเปลี่ยนกรุณาใช้คำสั่งเปลี่ยนกะเริ่มต้น`,
          conflicts: txOutcome.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: isDefault ? 'SHIFT_CREATED_AS_DEFAULT' : 'SHIFT_CREATED',
        targetType: 'SHIFT',
        targetId: String(txOutcome.shiftId),
        result: 'SUCCESS',
        detail: {
          shiftCode,
          shiftName,
          startTime,
          endTime,
          graceMinutes,
          cutoffTime,
          isCrossMidnight,
          isDefault,
          defaultPersonnelTypeCodes,
        },
      });

      res.status(201).json({
        id: txOutcome.shiftId,
        shiftCode,
        shiftName,
        shiftCategory,
        startTime,
        endTime,
        graceMinutes,
        cutoffTime,
        isCrossMidnight,
        isDefault,
        defaultPersonnelTypeCodes,
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        res.status(409).json({
          error: 'DEFAULT_SHIFT_ALREADY_EXISTS',
          message:
            'ตรวจพบการกำหนดกะเริ่มต้นซ้ำในขอบเขตประเภทบุคลากรเดียวกัน (ป้องกันโดยข้อจำกัดฐานข้อมูล) กรุณารีเฟรชและใช้คำสั่งเปลี่ยนกะเริ่มต้นแทน',
          requestId: req.requestId,
        });
        return;
      }
      next(err);
    }
  }
);

shiftsRouter.put(
  '/shifts/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รหัสอ้างอิงแม่แบบกะทำงานไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const rows = await dbQuery<ShiftRow>('SELECT * FROM shifts WHERE id = ? LIMIT 1', [shiftId]);
      if (rows.length === 0) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบแม่แบบกะทำงานที่ต้องการแก้ไข',
          requestId: req.requestId,
        });
        return;
      }

      const current = rows[0];
      const shiftName = String(req.body?.shiftName || current.shift_name).trim();
      const shiftCategory = String(req.body?.shiftCategory || current.shift_category)
        .trim()
        .toUpperCase();
      const startTime = String(req.body?.startTime || current.start_time).trim();
      const endTime = String(req.body?.endTime || current.end_time).trim();
      const graceMinutes =
        req.body?.graceMinutes !== undefined
          ? Number(req.body.graceMinutes)
          : Number(current.grace_minutes);
      const cutoffTime = String(req.body?.cutoffTime || current.cutoff_time).trim();
      const isActive =
        req.body?.isActive !== undefined
          ? req.body.isActive
            ? 1
            : 0
          : Number(current.is_active);
      const isCrossMidnight =
        req.body?.isCrossMidnight !== undefined
          ? Number(Boolean(req.body.isCrossMidnight))
          : endTime <= startTime
            ? 1
            : 0;

      const wantsAssignDefault = Boolean(req.body?.isDefault);
      const requestedDefaultScopes = wantsAssignDefault
        ? parseRequestedDefaultPersonnelTypeCodes(req.body)
        : [];
      const defaultReason = String(
        req.body?.defaultReason || 'กำหนดเป็นกะเริ่มต้นระหว่างแก้ไขแม่แบบกะทำงาน'
      ).trim();

      if (
        !shiftName ||
        !/^\d{2}:\d{2}$/.test(startTime) ||
        !/^\d{2}:\d{2}$/.test(endTime) ||
        !/^\d{2}:\d{2}$/.test(cutoffTime) ||
        Number.isNaN(graceMinutes) ||
        graceMinutes < 0 ||
        graceMinutes > 180
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุชื่อกะและเวลาในรูปแบบ HH:mm ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      if (wantsAssignDefault && requestedDefaultScopes.length === 0) {
        res.status(400).json({
          error: 'DEFAULT_SCOPE_REQUIRED',
          message: 'กรุณาระบุขอบเขตประเภทบุคลากรอย่างน้อย 1 ประเภท เมื่อเลือกกำหนดเป็นกะเริ่มต้น',
          requestId: req.requestId,
        });
        return;
      }

      if (wantsAssignDefault && isActive === 0) {
        res.status(400).json({
          error: 'SHIFT_INACTIVE',
          message: 'ไม่สามารถกำหนดแม่แบบกะที่ปิดใช้งานให้เป็นกะเริ่มต้นได้',
          requestId: req.requestId,
        });
        return;
      }

      type UpdateShiftTxOutcome =
        | { status: 'PERSONNEL_TYPE_NOT_FOUND'; missingCode: string }
        | { status: 'DEFAULT_SHIFT_IN_USE'; boundTypes: string[] }
        | {
            status: 'DEFAULT_ALREADY_EXISTS';
            conflicts: Array<{
              personnelTypeCode: string;
              personnelTypeName: string;
              currentDefaultShiftId: number;
              currentDefaultShiftCode: string;
              currentDefaultShiftName: string;
              currentStartTime: string;
              currentEndTime: string;
            }>;
          }
        | { status: 'UPDATED'; assignedScopes: string[]; syncedScopes: string[] };

      const txOutcome: UpdateShiftTxOutcome = await withDefaultShiftScopeLocks(
        requestedDefaultScopes,
        () =>
          dbTransaction(async (tx: DbTransactionContext): Promise<UpdateShiftTxOutcome> => {
            const lockClause = loadConfig().dbEngine === 'mysql' ? ' FOR UPDATE' : '';

            // ตรวจว่าแม่แบบกะนี้เป็นกะเริ่มต้นของประเภทบุคลากรใดอยู่บ้าง
            const currentlyBoundRows = await tx.query<{
              personnel_type_code: string;
              personnel_type_name: string;
            }>(
              `SELECT ds.personnel_type_code, COALESCE(r.personnel_type_name, ds.personnel_type_code) AS personnel_type_name
               FROM personnel_type_default_shifts ds
               LEFT JOIN personnel_type_rules r ON r.personnel_type_code = ds.personnel_type_code
               WHERE ds.shift_id = ?${lockClause}`,
              [shiftId]
            );

            if (isActive === 0 && currentlyBoundRows.length > 0) {
              return {
                status: 'DEFAULT_SHIFT_IN_USE',
                boundTypes: currentlyBoundRows.map((x) => x.personnel_type_name),
              };
            }

            const newScopesToBind: Array<{ scopeCode: string; rule: PersonnelTypeRuleRow }> = [];
            if (wantsAssignDefault) {
              const conflicts: Array<{
                personnelTypeCode: string;
                personnelTypeName: string;
                currentDefaultShiftId: number;
                currentDefaultShiftCode: string;
                currentDefaultShiftName: string;
                currentStartTime: string;
                currentEndTime: string;
              }> = [];

              for (const scopeCode of requestedDefaultScopes) {
                const ruleRows = await tx.query<PersonnelTypeRuleRow>(
                  `SELECT * FROM personnel_type_rules WHERE personnel_type_code = ? LIMIT 1${lockClause}`,
                  [scopeCode]
                );
                if (ruleRows.length === 0) {
                  return { status: 'PERSONNEL_TYPE_NOT_FOUND', missingCode: scopeCode };
                }

                const existingDefault = await tx.query<{
                  shift_id: number;
                  shift_code: string;
                  shift_name: string;
                  start_time: string;
                  end_time: string;
                }>(
                  `SELECT ds.shift_id, s.shift_code, s.shift_name, s.start_time, s.end_time
                   FROM personnel_type_default_shifts ds
                   INNER JOIN shifts s ON s.id = ds.shift_id
                   WHERE ds.personnel_type_code = ?
                   LIMIT 1${lockClause}`,
                  [scopeCode]
                );

                if (existingDefault.length > 0) {
                  if (Number(existingDefault[0].shift_id) !== shiftId) {
                    conflicts.push({
                      personnelTypeCode: scopeCode,
                      personnelTypeName: ruleRows[0].personnel_type_name,
                      currentDefaultShiftId: Number(existingDefault[0].shift_id),
                      currentDefaultShiftCode: existingDefault[0].shift_code,
                      currentDefaultShiftName: existingDefault[0].shift_name,
                      currentStartTime: existingDefault[0].start_time,
                      currentEndTime: existingDefault[0].end_time,
                    });
                  }
                } else {
                  newScopesToBind.push({ scopeCode, rule: ruleRows[0] });
                }
              }

              if (conflicts.length > 0) {
                return { status: 'DEFAULT_ALREADY_EXISTS', conflicts };
              }
            }

            await tx.execute(
              `UPDATE shifts
               SET shift_name = ?, shift_category = ?, start_time = ?, end_time = ?,
                   grace_minutes = ?, cutoff_time = ?, is_cross_midnight = ?, is_active = ?,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ?`,
              [
                shiftName,
                shiftCategory,
                startTime,
                endTime,
                graceMinutes,
                cutoffTime,
                isCrossMidnight,
                isActive,
                shiftId,
              ]
            );

            // ผูกประเภทบุคลากรใหม่ที่ยังไม่มีกะเริ่มต้น
            const assignedScopes: string[] = [];
            for (const { scopeCode, rule } of newScopesToBind) {
              await tx.execute(
                `INSERT INTO personnel_type_default_shifts (
                  personnel_type_code, shift_id, assigned_by, assigned_reason
                ) VALUES (?, ?, ?, ?)`,
                [scopeCode, shiftId, req.user!.username, defaultReason]
              );
              await tx.execute(
                `UPDATE personnel_type_rules
                 SET default_shift_id = ?,
                     default_start_time = ?,
                     default_end_time = ?,
                     default_grace_minutes = ?,
                     default_cutoff_time = ?,
                     is_active = 1,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE personnel_type_code = ?`,
                [shiftId, startTime, endTime, graceMinutes, cutoffTime, scopeCode]
              );
              await tx.execute(
                `INSERT INTO personnel_type_rule_history (
                  rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
                  default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by, default_shift_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'DEFAULT_SHIFT_ASSIGNED', ?, ?)`,
                [
                  rule.id,
                  scopeCode,
                  rule.personnel_type_name,
                  startTime,
                  endTime,
                  graceMinutes,
                  cutoffTime,
                  normalizeWorkDateString(rule.effective_from || '2026-01-01'),
                  req.user!.username,
                  shiftId,
                ]
              );
              assignedScopes.push(scopeCode);
            }

            // ซิงก์เวลาล่าสุดเข้าสู่ personnel_type_rules ของประเภทที่ใช้กะนี้เป็น Default อยู่เดิม (ไม่แก้ตารางเวรย้อนหลัง)
            const syncedScopes: string[] = [];
            for (const bound of currentlyBoundRows) {
              await tx.execute(
                `UPDATE personnel_type_rules
                 SET default_start_time = ?,
                     default_end_time = ?,
                     default_grace_minutes = ?,
                     default_cutoff_time = ?,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE personnel_type_code = ?`,
                [startTime, endTime, graceMinutes, cutoffTime, bound.personnel_type_code]
              );
              syncedScopes.push(bound.personnel_type_code);
            }

            return { status: 'UPDATED', assignedScopes, syncedScopes };
          })
      );

      if (txOutcome.status === 'DEFAULT_SHIFT_IN_USE') {
        res.status(409).json({
          error: 'DEFAULT_SHIFT_IN_USE',
          message: `ไม่สามารถปิดใช้งานแม่แบบกะนี้ได้ เนื่องจากกำลังใช้งานเป็นกะเริ่มต้นของ: ${txOutcome.boundTypes.join(', ')} กรุณาเปลี่ยนกะเริ่มต้นก่อน`,
          requestId: req.requestId,
        });
        return;
      }

      if (txOutcome.status === 'PERSONNEL_TYPE_NOT_FOUND') {
        res.status(404).json({
          error: 'PERSONNEL_TYPE_NOT_FOUND',
          message: `ไม่พบประเภทบุคลากรรหัส ${txOutcome.missingCode} ในระบบ`,
          requestId: req.requestId,
        });
        return;
      }

      if (txOutcome.status === 'DEFAULT_ALREADY_EXISTS') {
        const first = txOutcome.conflicts[0];
        res.status(409).json({
          error: 'DEFAULT_SHIFT_ALREADY_EXISTS',
          message: `ประเภทบุคลากร "${first.personnelTypeName}" มีกะเริ่มต้นใช้งานอยู่แล้วคือ "${first.currentDefaultShiftName}" (${first.currentDefaultShiftCode}) ไม่สามารถกำหนดซ้ำได้ หากต้องการเปลี่ยนกรุณาใช้คำสั่งเปลี่ยนกะเริ่มต้น`,
          conflicts: txOutcome.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action:
          txOutcome.assignedScopes.length > 0 ? 'SHIFT_UPDATED_AND_SET_DEFAULT' : 'SHIFT_UPDATED',
        targetType: 'SHIFT',
        targetId: String(shiftId),
        result: 'SUCCESS',
        detail: {
          shiftCode: current.shift_code,
          shiftName,
          startTime,
          endTime,
          graceMinutes,
          cutoffTime,
          isCrossMidnight,
          isActive,
          assignedDefaultScopes: txOutcome.assignedScopes,
          syncedDefaultScopes: txOutcome.syncedScopes,
        },
      });

      res.json({
        status: 'UPDATED',
        id: shiftId,
        shiftCode: current.shift_code,
        shiftName,
        shiftCategory,
        startTime,
        endTime,
        graceMinutes,
        cutoffTime,
        isCrossMidnight,
        isActive,
        assignedDefaultScopes: txOutcome.assignedScopes,
      });
    } catch (err) {
      if (isUniqueConstraintError(err)) {
        res.status(409).json({
          error: 'DEFAULT_SHIFT_ALREADY_EXISTS',
          message:
            'ตรวจพบการกำหนดกะเริ่มต้นซ้ำในขอบเขตประเภทบุคลากรเดียวกัน (ป้องกันโดยข้อจำกัดฐานข้อมูล) กรุณารีเฟรชและใช้คำสั่งเปลี่ยนกะเริ่มต้นแทน',
          requestId: req.requestId,
        });
        return;
      }
      next(err);
    }
  }
);

/**
 * 2.1 คำสั่งเปลี่ยนหรือกำหนดกะเริ่มต้นอย่างชัดเจน (Explicit Change Default Shift)
 * - ตรวจสิทธิ์เฉพาะ ADMIN / RESPONSIBLE_STAFF
 * - ทำงานภายใต้ Database Transaction + Scope Lock
 * - บันทึกประวัติใน personnel_type_rule_history และ audit_logs
 * - ห้ามลบหรือแก้ไขตารางเวรย้อนหลัง (shift_assignments) หรือ Raw Scans โดยเด็ดขาด
 */
shiftsRouter.post(
  '/shifts/:id/set-default',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const shiftId = Number(req.params.id);
      if (!Number.isInteger(shiftId) || shiftId <= 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รหัสแม่แบบกะทำงานไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const scopeCodes = parseRequestedDefaultPersonnelTypeCodes({
        defaultPersonnelTypeCode: req.body?.personnelTypeCode || req.body?.defaultPersonnelTypeCode,
        defaultPersonnelTypeCodes:
          req.body?.personnelTypeCodes || req.body?.defaultPersonnelTypeCodes,
      });
      if (scopeCodes.length === 0) {
        res.status(400).json({
          error: 'DEFAULT_SCOPE_REQUIRED',
          message: 'กรุณาระบุประเภทบุคลากรที่ต้องการเปลี่ยนกะเริ่มต้น',
          requestId: req.requestId,
        });
        return;
      }

      const reason = String(
        req.body?.reason || 'เปลี่ยนกะเริ่มต้นตามประเภทบุคลากรโดยผู้มีสิทธิ์'
      ).trim();
      const requestedEffectiveFrom = req.body?.effectiveFrom
        ? normalizeWorkDateString(req.body.effectiveFrom)
        : null;
      if (requestedEffectiveFrom && !/^\d{4}-\d{2}-\d{2}$/.test(requestedEffectiveFrom)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รูปแบบวันที่มีผลบังคับใช้ต้องเป็น YYYY-MM-DD',
          requestId: req.requestId,
        });
        return;
      }

      const shiftRows = await dbQuery<ShiftRow>('SELECT * FROM shifts WHERE id = ? LIMIT 1', [
        shiftId,
      ]);
      if (shiftRows.length === 0) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบแม่แบบกะทำงานที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      const targetShift = shiftRows[0];
      if (Number(targetShift.is_active) !== 1) {
        res.status(400).json({
          error: 'SHIFT_INACTIVE',
          message: `แม่แบบกะ "${targetShift.shift_name}" ถูกปิดใช้งานอยู่ ไม่สามารถกำหนดเป็นกะเริ่มต้นได้`,
          requestId: req.requestId,
        });
        return;
      }

      type ChangeDefaultTxResult =
        | { status: 'PERSONNEL_TYPE_NOT_FOUND'; missingCode: string }
        | {
            status: 'CHANGED';
            changes: Array<{
              personnelTypeCode: string;
              personnelTypeName: string;
              previousDefaultShiftId: number | null;
              previousDefaultShiftCode: string | null;
              previousDefaultShiftName: string | null;
              newDefaultShiftId: number;
              newDefaultShiftCode: string;
              newDefaultShiftName: string;
              effectiveFrom: string;
            }>;
          };

      const txOutcome: ChangeDefaultTxResult = await withDefaultShiftScopeLocks(scopeCodes, () =>
        dbTransaction(async (tx: DbTransactionContext): Promise<ChangeDefaultTxResult> => {
          const lockClause = loadConfig().dbEngine === 'mysql' ? ' FOR UPDATE' : '';
          const changes: Array<{
            personnelTypeCode: string;
            personnelTypeName: string;
            previousDefaultShiftId: number | null;
            previousDefaultShiftCode: string | null;
            previousDefaultShiftName: string | null;
            newDefaultShiftId: number;
            newDefaultShiftCode: string;
            newDefaultShiftName: string;
            effectiveFrom: string;
          }> = [];

          for (const scopeCode of scopeCodes) {
            const ruleRows = await tx.query<PersonnelTypeRuleRow>(
              `SELECT * FROM personnel_type_rules WHERE personnel_type_code = ? LIMIT 1${lockClause}`,
              [scopeCode]
            );
            if (ruleRows.length === 0) {
              return { status: 'PERSONNEL_TYPE_NOT_FOUND', missingCode: scopeCode };
            }
            const rule = ruleRows[0];

            const prevRows = await tx.query<{
              id: number;
              shift_id: number;
              shift_code: string | null;
              shift_name: string | null;
            }>(
              `SELECT ds.id, ds.shift_id, s.shift_code, s.shift_name
               FROM personnel_type_default_shifts ds
               LEFT JOIN shifts s ON s.id = ds.shift_id
               WHERE ds.personnel_type_code = ?
               LIMIT 1${lockClause}`,
              [scopeCode]
            );

            const prev = prevRows[0] || null;
            if (prev) {
              await tx.execute(
                `UPDATE personnel_type_default_shifts
                 SET shift_id = ?, assigned_by = ?, assigned_reason = ?, updated_at = CURRENT_TIMESTAMP
                 WHERE personnel_type_code = ?`,
                [shiftId, req.user!.username, reason, scopeCode]
              );
            } else {
              await tx.execute(
                `INSERT INTO personnel_type_default_shifts (
                  personnel_type_code, shift_id, assigned_by, assigned_reason
                ) VALUES (?, ?, ?, ?)`,
                [scopeCode, shiftId, req.user!.username, reason]
              );
            }

            const nextEffectiveFrom =
              requestedEffectiveFrom || normalizeWorkDateString(rule.effective_from || '2026-01-01');

            await tx.execute(
              `UPDATE personnel_type_rules
               SET default_shift_id = ?,
                   default_start_time = ?,
                   default_end_time = ?,
                   default_grace_minutes = ?,
                   default_cutoff_time = ?,
                   effective_from = ?,
                   is_active = 1,
                   updated_at = CURRENT_TIMESTAMP
               WHERE personnel_type_code = ?`,
              [
                shiftId,
                targetShift.start_time,
                targetShift.end_time,
                Number(targetShift.grace_minutes ?? 15),
                targetShift.cutoff_time,
                nextEffectiveFrom,
                scopeCode,
              ]
            );

            await tx.execute(
              `INSERT INTO personnel_type_rule_history (
                rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
                default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by, default_shift_id
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
              [
                rule.id,
                scopeCode,
                rule.personnel_type_name,
                targetShift.start_time,
                targetShift.end_time,
                Number(targetShift.grace_minutes ?? 15),
                targetShift.cutoff_time,
                nextEffectiveFrom,
                prev ? 'DEFAULT_SHIFT_CHANGED' : 'DEFAULT_SHIFT_ASSIGNED',
                req.user!.username,
                shiftId,
              ]
            );

            changes.push({
              personnelTypeCode: scopeCode,
              personnelTypeName: rule.personnel_type_name,
              previousDefaultShiftId: prev ? Number(prev.shift_id) : null,
              previousDefaultShiftCode: prev?.shift_code || null,
              previousDefaultShiftName: prev?.shift_name || null,
              newDefaultShiftId: shiftId,
              newDefaultShiftCode: targetShift.shift_code,
              newDefaultShiftName: targetShift.shift_name,
              effectiveFrom: nextEffectiveFrom,
            });
          }

          return { status: 'CHANGED', changes };
        })
      );

      if (txOutcome.status === 'PERSONNEL_TYPE_NOT_FOUND') {
        res.status(404).json({
          error: 'PERSONNEL_TYPE_NOT_FOUND',
          message: `ไม่พบประเภทบุคลากรรหัส ${txOutcome.missingCode} ในระบบ`,
          requestId: req.requestId,
        });
        return;
      }

      const hadAnyPrevious = txOutcome.changes.some((c) => c.previousDefaultShiftId !== null);
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: hadAnyPrevious ? 'DEFAULT_SHIFT_CHANGED' : 'DEFAULT_SHIFT_ASSIGNED',
        targetType: 'SHIFT',
        targetId: String(shiftId),
        result: 'SUCCESS',
        detail: {
          reason,
          changes: txOutcome.changes,
          historicalAssignmentsPreserved: true,
        },
      });

      res.json({
        status: 'UPDATED',
        message: `อัปเดตกะเริ่มต้นเป็น "${targetShift.shift_name}" เรียบร้อยแล้ว โดยไม่กระทบตารางเวรย้อนหลัง`,
        changes: txOutcome.changes,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 2.2 ยกเลิกการกำหนดกะเริ่มต้นสำหรับประเภทบุคลากร (Clear Default Shift)
 * - ตรวจสิทธิ์เฉพาะ ADMIN / RESPONSIBLE_STAFF
 * - ล้างผูกกะเริ่มต้นออกเพื่อให้สามารถกำหนดใหม่ หรือแสดงสถานะ "ไม่พบกะที่กำหนด" เมื่อไม่มีตารางเวรเฉพาะวัน
 * - ห้ามลบหรือแก้ไขตารางเวรย้อนหลัง (shift_assignments) หรือ Raw Scans
 */
shiftsRouter.delete(
  '/shifts/default/:personnelTypeCode',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const scopeCode = String(req.params.personnelTypeCode || '').trim().toUpperCase();
      const reason = String(
        req.body?.reason || 'ยกเลิกกะเริ่มต้นของประเภทบุคลากรโดยผู้มีสิทธิ์'
      ).trim();

      if (!scopeCode) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสประเภทบุคลากร',
          requestId: req.requestId,
        });
        return;
      }

      const txOutcome = await withDefaultShiftScopeLocks([scopeCode], () =>
        dbTransaction(async (tx: DbTransactionContext) => {
          const ruleRows = await tx.query<PersonnelTypeRuleRow>(
            'SELECT * FROM personnel_type_rules WHERE personnel_type_code = ? LIMIT 1',
            [scopeCode]
          );
          if (ruleRows.length === 0) {
            return { found: false as const };
          }
          const rule = ruleRows[0];
          const prevRows = await tx.query<{
            shift_id: number;
            shift_code: string | null;
            shift_name: string | null;
          }>(
            `SELECT ds.shift_id, s.shift_code, s.shift_name
             FROM personnel_type_default_shifts ds
             LEFT JOIN shifts s ON s.id = ds.shift_id
             WHERE ds.personnel_type_code = ?
             LIMIT 1`,
            [scopeCode]
          );

          await tx.execute(
            'DELETE FROM personnel_type_default_shifts WHERE personnel_type_code = ?',
            [scopeCode]
          );
          await tx.execute(
            `UPDATE personnel_type_rules
             SET default_shift_id = NULL,
                 default_start_time = '',
                 default_end_time = '',
                 updated_at = CURRENT_TIMESTAMP
             WHERE personnel_type_code = ?`,
            [scopeCode]
          );
          await tx.execute(
            `INSERT INTO personnel_type_rule_history (
              rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
              default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by, default_shift_id
            ) VALUES (?, ?, ?, '', '', ?, ?, ?, ?, 'DEFAULT_SHIFT_CLEARED', ?, NULL)`,
            [
              rule.id,
              scopeCode,
              rule.personnel_type_name,
              Number(rule.default_grace_minutes ?? 15),
              rule.default_cutoff_time || '11:00',
              normalizeWorkDateString(rule.effective_from || '2026-01-01'),
              Number(rule.is_active ?? 1),
              req.user!.username,
            ]
          );

          return {
            found: true as const,
            personnelTypeName: rule.personnel_type_name,
            previous: prevRows[0] || null,
          };
        })
      );

      if (!txOutcome.found) {
        res.status(404).json({
          error: 'PERSONNEL_TYPE_NOT_FOUND',
          message: `ไม่พบประเภทบุคลากรรหัส ${scopeCode} ในระบบ`,
          requestId: req.requestId,
        });
        return;
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'DEFAULT_SHIFT_CLEARED',
        targetType: 'PERSONNEL_TYPE_RULE',
        targetId: scopeCode,
        result: 'SUCCESS',
        detail: {
          personnelTypeCode: scopeCode,
          personnelTypeName: txOutcome.personnelTypeName,
          previousDefaultShift: txOutcome.previous,
          reason,
          historicalAssignmentsPreserved: true,
        },
      });

      res.json({
        status: 'CLEARED',
        personnelTypeCode: scopeCode,
        personnelTypeName: txOutcome.personnelTypeName,
        message: `ยกเลิกกะเริ่มต้นของ "${txOutcome.personnelTypeName}" เรียบร้อยแล้ว โดยไม่กระทบตารางเวรย้อนหลัง`,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// (ย้ายเส้นทาง /holidays* ทั้งหมดไปที่ backend/src/modules/holidays/routes.ts เพื่อรองรับ scoped hospital_holidays และ B1)

// ============================================================================
// 3. รายการตารางเวรและสถานะรายวัน (Shift Assignments & Daily Overrides)
// ============================================================================

shiftsRouter.get(
  '/shift-assignments',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const dateFrom = normalizeWorkDateString(req.query.dateFrom || '2026-11-01');
      const dateTo = normalizeWorkDateString(req.query.dateTo || '2026-11-30');
      const personId = String(req.query.personId || '').trim();
      const status = String(req.query.status || '').trim();
      const department = String(req.query.department || '').trim();
      const shiftId = req.query.shiftId ? Number(req.query.shiftId) : 0;

      const conditions = ['sa.work_date >= ?', 'sa.work_date <= ?'];
      const params: unknown[] = [dateFrom, dateTo];

      if (personId) {
        conditions.push('sa.person_id = ?');
        params.push(personId);
      }
      if (status) {
        conditions.push('sa.status = ?');
        params.push(status);
      }
      if (department) {
        conditions.push('p.department_name = ?');
        params.push(department);
      }
      if (shiftId > 0) {
        conditions.push('sa.shift_id = ?');
        params.push(shiftId);
      }

      const rawItems = await dbQuery<Record<string, unknown>>(
        `SELECT sa.*, p.full_name, p.department_name, p.personnel_type_code, p.personnel_type_name, p.position_name, p.fingle_id
         FROM shift_assignments sa
         INNER JOIN personnel p ON p.person_id = sa.person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sa.work_date DESC, sa.snapshot_start_time ASC`,
        params
      );

      const items = rawItems.map((row) => ({
        ...row,
        person_id: String(row.person_id ?? '').trim(),
        work_date: normalizeWorkDateString(row.work_date),
      }));

      const overrideConditions = ['work_date >= ?', 'work_date <= ?'];
      const overrideParams: unknown[] = [dateFrom, dateTo];
      if (personId) {
        overrideConditions.push('person_id = ?');
        overrideParams.push(personId);
      }

      const rawOverrides = await dbQuery<DailyOverrideRow>(
        `SELECT * FROM shift_daily_overrides WHERE ${overrideConditions.join(' AND ')} ORDER BY work_date ASC`,
        overrideParams
      );
      const dailyOverrides = rawOverrides.map((row) => ({
        ...row,
        person_id: String(row.person_id ?? '').trim(),
        work_date: normalizeWorkDateString(row.work_date),
      }));

      const personnelTypeRules = await loadPersonnelTypeRulesWithDefaultShifts();

      const rawCancellationLogs = await dbQuery<Record<string, unknown>>(
        `SELECT scl.*, p.full_name, p.department_name
         FROM shift_cancellation_logs scl
         LEFT JOIN personnel p ON p.person_id = scl.person_id
         ORDER BY scl.id DESC LIMIT 40`
      );

      const cancellationLogs = rawCancellationLogs.map((row) => ({
        ...row,
        person_id: String(row.person_id ?? '').trim(),
        work_date: normalizeWorkDateString(row.work_date),
      }));

      const importLogs = await dbQuery<Record<string, unknown>>(
        'SELECT * FROM shift_import_logs ORDER BY id DESC LIMIT 20'
      );

      const hospitalHolidays = await loadHospitalHolidaysForRange(dateFrom, dateTo);
      const publicHolidays = hospitalHolidays.map((h) => ({
        id: h.id,
        holiday_date: h.holiday_date,
        holiday_name: h.holiday_name,
        holiday_type: h.category,
        scope_type: h.scope_type,
        department_name: h.department_name,
        person_id: h.person_id,
        override_policy: h.override_policy,
        is_active: h.is_active,
        created_by: h.created_by,
        created_at: h.created_at,
      }));

      res.json({
        items,
        dailyOverrides,
        personnelTypeRules,
        publicHolidays,
        hospitalHolidays,
        cancellationLogs,
        importLogs,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4.0 โหลดข้อมูลสถานะเวรล่าสุดของบุคลากร 1 คนใน 1 วัน (Authoritative Daily Cell State)
 * แยกข้อมูลชัดเจน:
 * 1. effectiveShifts — กะที่มีผลจริง (Assignment + Default จากประเภทบุคลากร)
 * 2. availableTemplates — แม่แบบกะที่ใช้งานได้ทั้งหมดจากฐานข้อมูลจริง
 * 3. dailyOverride — การกำหนดเฉพาะวัน
 * 4. clearedAll — วันที่ตั้งใจยกเลิกทุกกะ
 * 5. carryoverFromPrevDay — กะข้ามวันจากวันก่อนหน้าที่ต่อเนื่องมาถึงวันนี้ (Read-only info)
 */
shiftsRouter.get(
  '/shift-assignments/daily-cell',
  requireAuth,
  async (req, res, next) => {
    try {
      const personId = String(req.query.personId || '').trim();
      const workDate = normalizeWorkDateString(req.query.workDate);

      if (!personId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสบุคลากรและวันที่ (YYYY-MM-DD) ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const role = req.user!.role;
      const canEdit = role === 'ADMIN' || role === 'RESPONSIBLE_STAFF';
      if (!canEdit) {
        const ownPersonId = String(req.user!.approvedPersonId || '').trim();
        if (!ownPersonId || ownPersonId !== personId) {
          res.status(403).json({
            error: 'FORBIDDEN',
            message: 'คุณไม่มีสิทธิ์ดูข้อมูลตารางเวรของบุคลากรท่านอื่น',
            requestId: req.requestId,
          });
          return;
        }
      }

      const personRows = await dbQuery<{
        person_id: string;
        full_name: string;
        department_name: string;
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        'SELECT person_id, full_name, department_name, personnel_type_code, personnel_type_name FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (personRows.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบรหัสบุคลากรที่เลือกในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const prevDate = addDaysToDateString(workDate, -1);
      const nextDate = addDaysToDateString(workDate, 1);

      const [availableTemplates, nearbyAssignments, overrides, allTypeRules, hospitalHolidays] =
        await Promise.all([
          dbQuery<ShiftRow>('SELECT * FROM shifts WHERE is_active = 1 ORDER BY start_time ASC, id ASC'),
          dbQuery<ExistingAssignmentRow>(
            `SELECT id, person_id, shift_id, work_date,
                    snapshot_shift_code, snapshot_shift_name,
                    snapshot_start_time, snapshot_end_time,
                    snapshot_grace_minutes, snapshot_cutoff_time,
                    snapshot_is_cross_midnight, status
             FROM shift_assignments
             WHERE person_id = ?
               AND work_date >= ?
               AND work_date <= ?
               AND status = 'ACTIVE'
             ORDER BY work_date ASC, snapshot_start_time ASC, id ASC`,
            [personId, prevDate, nextDate]
          ),
          dbQuery<DailyOverrideRow>(
            'SELECT * FROM shift_daily_overrides WHERE person_id = ? AND work_date IN (?, ?)',
            [personId, workDate, nextDate]
          ),
          loadPersonnelTypeRulesWithDefaultShifts(),
          loadHospitalHolidaysForRange(workDate, nextDate),
        ]);

      const normalizedNearby = nearbyAssignments.map((a) => ({
        ...a,
        person_id: String(a.person_id ?? '').trim(),
        work_date: normalizeWorkDateString(a.work_date),
      }));
      const sameDayActive = normalizedNearby.filter((a) => a.work_date === workDate);
      const adjacentDaysActive = normalizedNearby.filter((a) => a.work_date !== workDate);

      const normalizedOverrides = overrides.map((o) => ({
        ...o,
        work_date: normalizeWorkDateString(o.work_date),
      }));
      const todayOverride = normalizedOverrides.find((o) => o.work_date === workDate) || null;
      const nextDayOverride = normalizedOverrides.find((o) => o.work_date === nextDate) || null;

      const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
      for (const r of allTypeRules) {
        rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
      }
      const normTypeCode = normalizePersonnelTypeCodeForDefaultShift(
        personRows[0].personnel_type_code,
        personRows[0].personnel_type_name
      );
      const defaultRule = normTypeCode ? rulesByCode.get(normTypeCode) || null : null;

      let hasFullDayLeaveToday = false;
      try {
        const leaveRows = await dbQuery<{ leave_type: string }>(
          `SELECT leave_type FROM attendance_leaves
           WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE'`,
          [personId, workDate]
        );
        hasFullDayLeaveToday = leaveRows.some((l) =>
          isFullDayPersonalHolidayLeaveType(l.leave_type)
        );
      } catch {
        hasFullDayLeaveToday = false;
      }

      const todayScopedHoliday = resolveHolidayForPersonDate({
        workDate,
        personId,
        departmentName: personRows[0].department_name,
        holidays: hospitalHolidays,
      });
      const nextScopedHoliday = resolveHolidayForPersonDate({
        workDate: nextDate,
        personId,
        departmentName: personRows[0].department_name,
        holidays: hospitalHolidays,
      });
      const todayPublicHoliday = holidayRowToPublicHolidayAdapter(todayScopedHoliday);
      const nextDayPublicHoliday = holidayRowToPublicHolidayAdapter(nextScopedHoliday);

      // คำนวณสถานะปัจจุบันก่อน เพื่อดึง selectedTemplateIds ที่ตรงกับกะที่มีผลจริง 100%
      const initialEval = evaluateDailyCellSync({
        workDate,
        selectedTemplateIds: [],
        availableTemplates,
        sameDayActive,
        adjacentDaysActive,
        dailyOverride: todayOverride,
        defaultRule,
        nextDayDefaultRule: defaultRule,
        nextDayOverride,
        publicHoliday: todayPublicHoliday,
        nextDayPublicHoliday,
        personalHoliday: hasFullDayLeaveToday,
      });

      const currentSelectedTemplateIds: number[] = [];
      for (const eff of initialEval.existingEffectiveShifts) {
        if (!eff.isSpecialAssignment && eff.templateId !== null) {
          if (!currentSelectedTemplateIds.includes(eff.templateId)) {
            currentSelectedTemplateIds.push(eff.templateId);
          }
        }
      }

      const clearedAll =
        todayOverride?.override_state === 'CLEARED_ALL_SHIFTS' && sameDayActive.length === 0;

      res.json({
        status: 'OK',
        canEdit,
        person: personRows[0],
        workDate,
        effectiveState: initialEval.effectiveState,
        unconfiguredMessage:
          initialEval.effectiveState === 'UNCONFIGURED_DEFAULT_RULE'
            ? 'ยังไม่กำหนดกะ (ไม่มีเวรรายบุคคลและประเภทบุคลากรนี้ยังไม่ได้กำหนดกะเริ่มต้น)'
            : null,
        publicHoliday: todayPublicHoliday
          ? {
              holidayDate: todayPublicHoliday.holiday_date,
              holidayName: todayPublicHoliday.holiday_name,
              holidayType: todayPublicHoliday.holiday_type,
            }
          : null,
        effectiveShifts: initialEval.existingEffectiveShifts,
        availableTemplates: availableTemplates.map((t) => ({
          id: Number(t.id),
          shiftCode: t.shift_code,
          shiftName: t.shift_name,
          shiftCategory: t.shift_category,
          startTime: t.start_time,
          endTime: t.end_time,
          graceMinutes: Number(t.grace_minutes),
          cutoffTime: t.cutoff_time,
          isCrossMidnight: Number(t.is_cross_midnight) === 1 || t.end_time <= t.start_time ? 1 : 0,
        })),
        selectedTemplateIds: currentSelectedTemplateIds,
        dailyOverride: todayOverride
          ? {
              overrideState: todayOverride.override_state,
              reason: todayOverride.reason,
              updatedBy: todayOverride.updated_by,
              updatedAt: todayOverride.updated_at || null,
            }
          : null,
        clearedAll,
        defaultRule: defaultRule
          ? {
              personnelTypeCode: defaultRule.personnel_type_code,
              personnelTypeName: defaultRule.personnel_type_name,
              defaultStartTime: defaultRule.default_start_time,
              defaultEndTime: defaultRule.default_end_time,
              defaultGraceMinutes: Number(defaultRule.default_grace_minutes ?? 15),
              defaultCutoffTime: defaultRule.default_cutoff_time,
              isActive: Number(defaultRule.is_active),
            }
          : null,
        carryoverFromPrevDay: initialEval.carryoverFromPrevDay,
        nextDayShifts: initialEval.nextDayShifts,
        specialExistingAssignments: initialEval.specialExistingAssignments,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4.1 ตรวจสอบ Preview และ Conflict ล่วงหน้าสำหรับโหมด Synchronize Selected Shifts
 * รับ selectedTemplateIds[] = ชุดกะทั้งหมดที่ผู้ใช้ต้องการให้มีในวันนั้น
 */
shiftsRouter.post(
  '/shift-assignments/daily-cell-sync-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const workDate = normalizeWorkDateString(req.body?.workDate);

      if (!personId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสบุคลากรและวันที่ (YYYY-MM-DD) ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      if (!Array.isArray(req.body?.selectedTemplateIds)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รูปแบบรายการกะที่เลือก (selectedTemplateIds) ไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const rawSelectedIds: number[] = [];
      for (const id of req.body.selectedTemplateIds) {
        const n = Number(id);
        if (n > 0 && !rawSelectedIds.includes(n)) rawSelectedIds.push(n);
      }

      const keepSpecialAssignmentIds: number[] | undefined = Array.isArray(
        req.body?.keepSpecialAssignmentIds
      )
        ? req.body.keepSpecialAssignmentIds
            .map((x: unknown) => Number(x))
            .filter((n: number) => n > 0)
        : undefined;

      const personRows = await dbQuery<{
        person_id: string;
        full_name: string;
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        'SELECT person_id, full_name, personnel_type_code, personnel_type_name FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (personRows.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบรหัสบุคลากรที่เลือกในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const prevDate = addDaysToDateString(workDate, -1);
      const nextDate = addDaysToDateString(workDate, 1);

      const [availableTemplates, nearbyAssignments, overrides, allTypeRules] = await Promise.all([
        dbQuery<ShiftRow>('SELECT * FROM shifts WHERE is_active = 1 ORDER BY start_time ASC, id ASC'),
        dbQuery<ExistingAssignmentRow>(
          `SELECT id, person_id, shift_id, work_date,
                  snapshot_shift_code, snapshot_shift_name,
                  snapshot_start_time, snapshot_end_time,
                  snapshot_grace_minutes, snapshot_cutoff_time,
                  snapshot_is_cross_midnight, status
           FROM shift_assignments
           WHERE person_id = ?
             AND work_date >= ?
             AND work_date <= ?
             AND status = 'ACTIVE'
           ORDER BY work_date ASC, snapshot_start_time ASC, id ASC`,
          [personId, prevDate, nextDate]
        ),
        dbQuery<DailyOverrideRow>(
          'SELECT * FROM shift_daily_overrides WHERE person_id = ? AND work_date IN (?, ?)',
          [personId, workDate, nextDate]
        ),
        loadPersonnelTypeRulesWithDefaultShifts(),
      ]);

      const validIdSet = new Set(availableTemplates.map((t) => Number(t.id)));
      const invalidId = rawSelectedIds.find((id) => !validIdSet.has(id));
      if (invalidId !== undefined) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบแม่แบบกะทำงานบางรายการที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
          requestId: req.requestId,
        });
        return;
      }

      const normalizedNearby = nearbyAssignments.map((a) => ({
        ...a,
        person_id: String(a.person_id ?? '').trim(),
        work_date: normalizeWorkDateString(a.work_date),
      }));
      const sameDayActive = normalizedNearby.filter((a) => a.work_date === workDate);
      const adjacentDaysActive = normalizedNearby.filter((a) => a.work_date !== workDate);

      const normalizedOverrides = overrides.map((o) => ({
        ...o,
        work_date: normalizeWorkDateString(o.work_date),
      }));
      const todayOverride = normalizedOverrides.find((o) => o.work_date === workDate) || null;
      const nextDayOverride = normalizedOverrides.find((o) => o.work_date === nextDate) || null;

      const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
      for (const r of allTypeRules) {
        rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
      }
      const normTypeCode = normalizePersonnelTypeCodeForDefaultShift(
        personRows[0].personnel_type_code,
        personRows[0].personnel_type_name
      );
      const defaultRule = normTypeCode ? rulesByCode.get(normTypeCode) || null : null;

      const evalResult = evaluateDailyCellSync({
        workDate,
        selectedTemplateIds: rawSelectedIds,
        availableTemplates,
        sameDayActive,
        adjacentDaysActive,
        dailyOverride: todayOverride,
        defaultRule,
        nextDayDefaultRule: defaultRule,
        nextDayOverride,
        keepSpecialAssignmentIds,
      });

      res.json({
        status: 'OK',
        personId,
        workDate,
        ...evalResult,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4.2 บันทึกชุดกะทั้งหมดของวันเดียวแบบ Synchronize Selected Shifts (All-or-Nothing Transaction)
 * - เปรียบเทียบ Existing Effective Shifts vs Selected Template IDs ภายใน Transaction
 * - คง Assignment ID ของกะที่ไม่เปลี่ยน, ยกเลิกเฉพาะกะที่เอาออก, เพิ่มเฉพาะกะที่ติ๊กเพิ่ม
 * - หากเอาติ๊กออกทั้งหมด -> บันทึก shift_daily_overrides = CLEARED_ALL_SHIFTS (ไม่กลับมาเอง)
 * - หากเกิด Conflict -> 409 และ Rollback ทั้งรายการ
 * - ป้องกัน Double Submit และ Concurrent Updates ด้วย withPersonScheduleLock + MySQL FOR UPDATE
 */
shiftsRouter.post(
  '/shift-assignments/daily-cell-sync',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const workDate = normalizeWorkDateString(req.body?.workDate);
      const reason = String(
        req.body?.reason || 'ปรับปรุงตารางเวรรายวันจากหน้าต่างเลือกกะ'
      ).trim();

      if (!personId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสบุคลากรและวันที่ (YYYY-MM-DD) ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(workDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถแก้ไขตารางเวรในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      if (!Array.isArray(req.body?.selectedTemplateIds)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาส่งรายการกะที่ต้องการ (selectedTemplateIds) เป็นอาเรย์',
          requestId: req.requestId,
        });
        return;
      }

      const rawSelectedIds: number[] = [];
      for (const id of req.body.selectedTemplateIds) {
        const n = Number(id);
        if (n > 0 && !rawSelectedIds.includes(n)) rawSelectedIds.push(n);
      }

      const keepSpecialAssignmentIds: number[] | undefined = Array.isArray(
        req.body?.keepSpecialAssignmentIds
      )
        ? req.body.keepSpecialAssignmentIds
            .map((x: unknown) => Number(x))
            .filter((n: number) => n > 0)
        : undefined;

      const personRows = await dbQuery<{
        person_id: string;
        full_name: string;
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        'SELECT person_id, full_name, personnel_type_code, personnel_type_name FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (personRows.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบรหัสบุคลากรที่เลือกในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const prevDate = addDaysToDateString(workDate, -1);
      const nextDate = addDaysToDateString(workDate, 1);

      const txResult = await withPersonScheduleLock(personId, () =>
        dbTransaction(async (tx: DbTransactionContext) => {
          if (loadConfig().dbEngine === 'mysql') {
            await tx.query('SELECT person_id FROM personnel WHERE person_id = ? FOR UPDATE', [
              personId,
            ]);
          }

          const availableTemplates = await tx.query<ShiftRow>(
            'SELECT * FROM shifts WHERE is_active = 1 ORDER BY start_time ASC, id ASC'
          );
          const validIdSet = new Set(availableTemplates.map((t) => Number(t.id)));
          const missingId = rawSelectedIds.find((id) => !validIdSet.has(id));
          if (missingId !== undefined) {
            return {
              notFoundShift: true as const,
              conflictError: null,
              changed: false,
              overrideState: 'CUSTOM_ASSIGNED' as DailyScheduleOverrideState,
              addedCount: 0,
              removedCount: 0,
              keptCount: 0,
              previousShiftsSummary: [] as string[],
              newShiftsSummary: [] as string[],
              addedSummary: [] as string[],
              removedSummary: [] as string[],
              keptSummary: [] as string[],
            };
          }

          const nearbyAssignments = await tx.query<ExistingAssignmentRow>(
            `SELECT id, person_id, shift_id, work_date,
                    snapshot_shift_code, snapshot_shift_name,
                    snapshot_start_time, snapshot_end_time,
                    snapshot_grace_minutes, snapshot_cutoff_time,
                    snapshot_is_cross_midnight, status
             FROM shift_assignments
             WHERE person_id = ?
               AND work_date >= ?
               AND work_date <= ?
               AND status = 'ACTIVE'
             ORDER BY work_date ASC, snapshot_start_time ASC, id ASC`,
            [personId, prevDate, nextDate]
          );

          const overridesInTx = await tx.query<DailyOverrideRow>(
            'SELECT * FROM shift_daily_overrides WHERE person_id = ? AND work_date IN (?, ?)',
            [personId, workDate, nextDate]
          );
          const allRulesInTx = await loadPersonnelTypeRulesWithDefaultShifts(tx.query);

          const normalizedNearby = nearbyAssignments.map((a) => ({
            ...a,
            person_id: String(a.person_id ?? '').trim(),
            work_date: normalizeWorkDateString(a.work_date),
          }));
          const sameDayActive = normalizedNearby.filter((a) => a.work_date === workDate);
          const adjacentDaysActive = normalizedNearby.filter((a) => a.work_date !== workDate);

          const normalizedOverrides = overridesInTx.map((o) => ({
            ...o,
            work_date: normalizeWorkDateString(o.work_date),
          }));
          const todayOverride = normalizedOverrides.find((o) => o.work_date === workDate) || null;
          const nextDayOverride = normalizedOverrides.find((o) => o.work_date === nextDate) || null;

          const rulesByCodeInTx = new Map<string, PersonnelTypeRuleRow>();
          for (const r of allRulesInTx) {
            rulesByCodeInTx.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
          }
          const normTypeCode = normalizePersonnelTypeCodeForDefaultShift(
            personRows[0].personnel_type_code,
            personRows[0].personnel_type_name
          );
          const defaultRuleInTx = normTypeCode ? rulesByCodeInTx.get(normTypeCode) || null : null;

          const evalResult = evaluateDailyCellSync({
            workDate,
            selectedTemplateIds: rawSelectedIds,
            availableTemplates,
            sameDayActive,
            adjacentDaysActive,
            dailyOverride: todayOverride,
            defaultRule: defaultRuleInTx,
            nextDayDefaultRule: defaultRuleInTx,
            nextDayOverride,
            keepSpecialAssignmentIds,
          });

          if (!evalResult.canProceed) {
            const primary = evalResult.conflicts[0];
            return {
              notFoundShift: false as const,
              conflictError: {
                code: primary.code,
                message: evalResult.conflicts.map((c) => c.message).join(' | '),
                conflicts: evalResult.conflicts,
              },
              changed: false,
              overrideState: evalResult.effectiveState,
              addedCount: 0,
              removedCount: 0,
              keptCount: evalResult.shiftsToKeep.length,
              previousShiftsSummary: [] as string[],
              newShiftsSummary: [] as string[],
              addedSummary: [] as string[],
              removedSummary: [] as string[],
              keptSummary: [] as string[],
            };
          }

          const formatSummary = (x: {
            shiftCode: string;
            shiftName: string;
            startTime: string;
            endTime: string;
          }) => `${x.shiftName} [${x.shiftCode}] (${x.startTime}–${x.endTime})`;

          const previousShiftsSummary = evalResult.existingEffectiveShifts.map(formatSummary);
          const newShiftsSummary = evalResult.resultingShifts.map(formatSummary);
          const addedSummary = evalResult.shiftsToAdd.map(formatSummary);
          const removedSummary = evalResult.shiftsToRemove.map(formatSummary);
          const keptSummary = evalResult.shiftsToKeep.map(formatSummary);

          // ป้องกัน Double Submit / No-op: หากสถานะตรงกับข้อมูลเดิมทุกประการ ไม่ต้องเขียนซ้ำ
          if (!evalResult.hasChanges) {
            return {
              notFoundShift: false as const,
              conflictError: null,
              changed: false,
              overrideState: evalResult.effectiveState,
              addedCount: 0,
              removedCount: 0,
              keptCount: evalResult.shiftsToKeep.length,
              previousShiftsSummary,
              newShiftsSummary,
              addedSummary,
              removedSummary,
              keptSummary,
            };
          }

          // 1. ยกเลิกเฉพาะ Assignment ที่เอาออก (ไม่แตะกะเดิมที่ยังคงไว้ เพื่อรักษา Assignment ID และประวัติ)
          let removedCount = 0;
          for (const rem of evalResult.shiftsToRemove) {
            if (rem.source === 'ASSIGNMENT' && rem.assignmentId !== null) {
              await tx.execute(
                "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [rem.assignmentId]
              );
              await tx.execute(
                `INSERT INTO shift_cancellation_logs (
                  shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [rem.assignmentId, personId, workDate, rem.shiftCode, reason, req.user!.username]
              );
            }
            removedCount++;
          }

          // 2. หากเดิมเป็น DEFAULT_FROM_TYPE และผู้ใช้ยังคงกะเช้าเริ่มต้นไว้พร้อมเพิ่มกะอื่น ให้ Materialize กะเช้าเริ่มต้นไว้ด้วย
          if (evalResult.defaultShiftToMaterialize) {
            const defMat = evalResult.defaultShiftToMaterialize;
            const matchedTplId =
              defMat.templateId ??
              availableTemplates.find(
                (t) =>
                  t.shift_code === defMat.shiftCode ||
                  (t.start_time === defMat.startTime && t.end_time === defMat.endTime)
              )?.id ??
              evalResult.shiftsToAdd[0]?.shiftId ??
              availableTemplates[0]?.id;

            if (matchedTplId) {
              await tx.execute(
                `INSERT INTO shift_assignments (
                  person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                  snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
                  snapshot_is_cross_midnight, status, assigned_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
                [
                  personId,
                  matchedTplId,
                  workDate,
                  defMat.shiftCode,
                  defMat.shiftName,
                  defMat.startTime,
                  defMat.endTime,
                  defMat.graceMinutes,
                  defMat.cutoffTime,
                  defMat.isCrossMidnight,
                  req.user!.username,
                ]
              );
            }
          }

          // 3. เพิ่มเฉพาะกะใหม่ที่ติ๊กเพิ่ม
          const templateByIdInTx = new Map(availableTemplates.map((t) => [Number(t.id), t]));
          let addedCount = 0;
          for (const addItem of evalResult.shiftsToAdd) {
            const tpl = addItem.shiftId ? templateByIdInTx.get(Number(addItem.shiftId)) : null;
            if (!tpl) continue;
            await tx.execute(
              `INSERT INTO shift_assignments (
                person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
                snapshot_is_cross_midnight, status, assigned_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
              [
                personId,
                tpl.id,
                workDate,
                tpl.shift_code,
                tpl.shift_name,
                tpl.start_time,
                tpl.end_time,
                tpl.grace_minutes,
                tpl.cutoff_time,
                tpl.is_cross_midnight,
                req.user!.username,
              ]
            );
            addedCount++;
          }

          // 4. บันทึก Daily Override:
          //    - เอาติ๊กออกทั้งหมด -> CLEARED_ALL_SHIFTS (ไม่สร้างกะเริ่มต้นกลับมาเอง)
          //    - มีกะที่เลือกอย่างน้อย 1 กะ -> CUSTOM_ASSIGNED
          const nextOverrideState: 'CLEARED_ALL_SHIFTS' | 'CUSTOM_ASSIGNED' =
            evalResult.willClearAll ? 'CLEARED_ALL_SHIFTS' : 'CUSTOM_ASSIGNED';

          await upsertDailyOverrideRecord(tx.execute, tx.query, {
            personId,
            workDate,
            overrideState: nextOverrideState,
            reason,
            actorUsername: req.user!.username,
          });

          return {
            notFoundShift: false as const,
            conflictError: null,
            changed: true,
            overrideState: nextOverrideState as DailyScheduleOverrideState,
            addedCount,
            removedCount,
            keptCount: evalResult.shiftsToKeep.length,
            previousShiftsSummary,
            newShiftsSummary,
            addedSummary,
            removedSummary,
            keptSummary,
          };
        })
      );

      if (txResult.notFoundShift) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบแม่แบบกะทำงานบางรายการที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
          requestId: req.requestId,
        });
        return;
      }

      if (txResult.conflictError) {
        res.status(409).json({
          error: txResult.conflictError.code,
          message: txResult.conflictError.message,
          conflicts: txResult.conflictError.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      if (txResult.changed) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'SHIFT_CELL_SYNC',
          targetType: 'SHIFT_DAILY_OVERRIDE',
          targetId: `${personId}:${workDate}`,
          result: 'SUCCESS',
          detail: {
            actorUsername: req.user!.username,
            personId,
            workDate,
            previousShifts: txResult.previousShiftsSummary,
            newShifts: txResult.newShiftsSummary,
            addedShifts: txResult.addedSummary,
            removedShifts: txResult.removedSummary,
            keptShifts: txResult.keptSummary,
            overrideState: txResult.overrideState,
            reason,
            operatedAt: new Date().toISOString(),
          },
        });
      }

      const actionMsg = !txResult.changed
        ? 'ไม่มีการเปลี่ยนแปลงกะทำงานในวันนี้'
        : txResult.overrideState === 'CLEARED_ALL_SHIFTS'
          ? 'บันทึกเป็นไม่มีเวรในวันนี้สำเร็จ (ระบบจะไม่สร้างกะเริ่มต้นกลับมาอัตโนมัติ)'
          : `บันทึกตารางเวรสำเร็จ (เพิ่ม ${txResult.addedCount} กะ, ลบ ${txResult.removedCount} กะ, คงไว้ ${txResult.keptCount} กะ)`;

      res.json({
        status: 'OK',
        changed: txResult.changed,
        personId,
        workDate,
        overrideState: txResult.overrideState,
        addedCount: txResult.addedCount,
        removedCount: txResult.removedCount,
        keptCount: txResult.keptCount,
        previousShifts: txResult.previousShiftsSummary,
        newShifts: txResult.newShiftsSummary,
        message: actionMsg,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4A. ตรวจสอบ Preview และ Conflict ล่วงหน้าสำหรับ Quick Daily Shift Cell
 * รองรับ Multi-select (shiftIds[]) + ADD_SHIFT / REPLACE_SHIFTS + ตรวจวันก่อนหน้า/วันถัดไป
 */
shiftsRouter.post(
  '/shift-assignments/daily-cell-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const workDate = normalizeWorkDateString(req.body?.workDate);
      const rawAction = String(req.body?.action || 'ADD_SHIFT').trim().toUpperCase();
      const action: 'ADD_SHIFT' | 'REPLACE_SHIFTS' =
        rawAction === 'REPLACE_SHIFTS' ? 'REPLACE_SHIFTS' : 'ADD_SHIFT';

      if (!personId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุบุคลากรและวันที่ (YYYY-MM-DD) ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const personRows = await dbQuery<{
        person_id: string;
        full_name: string;
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        'SELECT person_id, full_name, personnel_type_code, personnel_type_name FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (personRows.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบรหัสบุคลากรที่เลือกในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const rawShiftIds: number[] = [];
      if (req.body?.shiftId) {
        const n = Number(req.body.shiftId);
        if (n > 0) rawShiftIds.push(n);
      }
      if (Array.isArray(req.body?.shiftIds)) {
        for (const id of req.body.shiftIds) {
          const n = Number(id);
          if (n > 0 && !rawShiftIds.includes(n)) rawShiftIds.push(n);
        }
      }

      let selectedShifts: ShiftRow[] = [];
      if (rawShiftIds.length > 0) {
        const placeholders = rawShiftIds.map(() => '?').join(', ');
        const fetched = await dbQuery<ShiftRow>(
          `SELECT * FROM shifts WHERE id IN (${placeholders}) AND is_active = 1`,
          rawShiftIds
        );
        if (fetched.length !== rawShiftIds.length) {
          res.status(404).json({
            error: 'SHIFT_NOT_FOUND',
            message: 'ไม่พบแม่แบบกะทำงานบางรายการที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
            requestId: req.requestId,
          });
          return;
        }
        const byId = new Map(fetched.map((s) => [Number(s.id), s]));
        selectedShifts = rawShiftIds.map((id) => byId.get(id)!).filter(Boolean);
      }

      const prevDate = addDaysToDateString(workDate, -1);
      const nextDate = addDaysToDateString(workDate, 1);

      const [nearbyAssignments, overrides, allTypeRules] = await Promise.all([
        dbQuery<ExistingAssignmentRow>(
          `SELECT id, person_id, shift_id, work_date,
                  snapshot_shift_code, snapshot_shift_name,
                  snapshot_start_time, snapshot_end_time,
                  snapshot_grace_minutes, snapshot_cutoff_time,
                  snapshot_is_cross_midnight, status
           FROM shift_assignments
           WHERE person_id = ?
             AND work_date >= ?
             AND work_date <= ?
             AND status = 'ACTIVE'
           ORDER BY work_date ASC, snapshot_start_time ASC`,
          [personId, prevDate, nextDate]
        ),
        dbQuery<DailyOverrideRow>(
          'SELECT * FROM shift_daily_overrides WHERE person_id = ? AND work_date = ? LIMIT 1',
          [personId, workDate]
        ),
        loadPersonnelTypeRulesWithDefaultShifts(),
      ]);

      const normalizedNearby = nearbyAssignments.map((a) => ({
        ...a,
        person_id: String(a.person_id ?? '').trim(),
        work_date: normalizeWorkDateString(a.work_date),
      }));
      const sameDayActive = normalizedNearby.filter((a) => a.work_date === workDate);
      const adjacentDaysActive = normalizedNearby.filter((a) => a.work_date !== workDate);

      const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
      for (const r of allTypeRules) {
        rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
      }
      const normTypeCode = normalizePersonnelTypeCodeForDefaultShift(
        personRows[0].personnel_type_code,
        personRows[0].personnel_type_name
      );
      const defaultRule = normTypeCode ? rulesByCode.get(normTypeCode) || null : null;

      const evalResult = evaluateDailyCellChange({
        workDate,
        action,
        selectedShifts,
        sameDayActive,
        adjacentDaysActive,
        dailyOverride: overrides[0] || null,
        defaultRule,
      });

      res.json({
        status: 'OK',
        personId,
        workDate,
        ...evalResult,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4B. จัดการเวรรายช่องตารางของบุคลากร 1 คนโดยตรง (Single-Person Quick Cell Action)
 * รองรับ: ADD_SHIFT / ADD_SHIFTS | REPLACE_SHIFTS | REMOVE_MORNING | REMOVE_AFTERNOON | CLEAR_ALL_SHIFTS | RESTORE_DEFAULT
 * - รองรับ Multi-select (shiftIds[]) ทั้งโหมดเพิ่มกะและแทนที่กะเดิม
 * - ตรวจ Conflict ซ้ำภายใน Database Transaction (All-or-Nothing) + ป้องกัน Concurrent Updates
 */
shiftsRouter.post(
  '/shift-assignments/daily-cell-action',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const workDate = normalizeWorkDateString(req.body?.workDate);
      const rawAction = String(req.body?.action || '').trim().toUpperCase();
      const action = rawAction === 'ADD_SHIFTS' ? 'ADD_SHIFT' : rawAction;
      const confirmReplace = req.body?.confirmReplace;
      const reason = String(
        req.body?.reason || 'แก้ไขตารางเวรรายวันจากช่องตารางโดยตรง'
      ).trim();

      const validActions = [
        'ADD_SHIFT',
        'REPLACE_SHIFTS',
        'REMOVE_MORNING',
        'REMOVE_AFTERNOON',
        'CLEAR_ALL_SHIFTS',
        'RESTORE_DEFAULT',
      ];

      if (!personId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate) || !validActions.includes(action)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุบุคลากร วันที่ (YYYY-MM-DD) และคำสั่งจัดการเวรรายวันที่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      if (action === 'REPLACE_SHIFTS' && confirmReplace === false) {
        res.status(400).json({
          error: 'CONFIRMATION_REQUIRED',
          message: 'กรุณายืนยันการแทนที่กะเดิมก่อนบันทึก',
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(workDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถแก้ไขตารางเวรในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      const personRows = await dbQuery<{
        person_id: string;
        full_name: string;
        department_name: string;
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        'SELECT person_id, full_name, department_name, personnel_type_code, personnel_type_name FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (personRows.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบรหัสบุคลากรที่เลือกในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      // เตรียมรายการ shiftIds กรณี ADD_SHIFT หรือ REPLACE_SHIFTS
      const rawShiftIds: number[] = [];
      if (req.body?.shiftId) {
        const n = Number(req.body.shiftId);
        if (n > 0) rawShiftIds.push(n);
      }
      if (Array.isArray(req.body?.shiftIds)) {
        for (const id of req.body.shiftIds) {
          const n = Number(id);
          if (n > 0 && !rawShiftIds.includes(n)) rawShiftIds.push(n);
        }
      }

      let selectedShifts: ShiftRow[] = [];
      if (action === 'ADD_SHIFT' || action === 'REPLACE_SHIFTS') {
        if (rawShiftIds.length === 0) {
          res.status(400).json({
            error: 'SHIFT_REQUIRED',
            message: 'กรุณาเลือกแม่แบบกะทำงานอย่างน้อย 1 กะ',
            requestId: req.requestId,
          });
          return;
        }
        const placeholders = rawShiftIds.map(() => '?').join(', ');
        const fetchedShifts = await dbQuery<ShiftRow>(
          `SELECT * FROM shifts WHERE id IN (${placeholders}) AND is_active = 1`,
          rawShiftIds
        );
        if (fetchedShifts.length !== rawShiftIds.length) {
          res.status(404).json({
            error: 'SHIFT_NOT_FOUND',
            message: 'ไม่พบแม่แบบกะทำงานที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
            requestId: req.requestId,
          });
          return;
        }
        const shiftById = new Map(fetchedShifts.map((s) => [Number(s.id), s]));
        selectedShifts = rawShiftIds.map((id) => shiftById.get(id)!).filter(Boolean);
      }

      const prevDate = addDaysToDateString(workDate, -1);
      const nextDate = addDaysToDateString(workDate, 1);

      // ใช้ Per-Person Lock + Database Transaction (All-or-Nothing) + Row Lock บน MySQL
      const txResult = await withPersonScheduleLock(personId, () =>
        dbTransaction(async (tx: DbTransactionContext) => {
          if (loadConfig().dbEngine === 'mysql') {
            await tx.query('SELECT person_id FROM personnel WHERE person_id = ? FOR UPDATE', [
              personId,
            ]);
          }

          const nearbyAssignments = await tx.query<ExistingAssignmentRow>(
            `SELECT id, person_id, shift_id, work_date,
                    snapshot_shift_code, snapshot_shift_name,
                    snapshot_start_time, snapshot_end_time,
                    snapshot_grace_minutes, snapshot_cutoff_time,
                    snapshot_is_cross_midnight, status
             FROM shift_assignments
             WHERE person_id = ?
               AND work_date >= ?
               AND work_date <= ?
               AND status = 'ACTIVE'
             ORDER BY work_date ASC, snapshot_start_time ASC`,
            [personId, prevDate, nextDate]
          );

          const currentOverrides = await tx.query<DailyOverrideRow>(
            'SELECT * FROM shift_daily_overrides WHERE person_id = ? AND work_date = ? LIMIT 1',
            [personId, workDate]
          );
          const allRulesInTx = await loadPersonnelTypeRulesWithDefaultShifts(tx.query);

          const normalizedNearby = nearbyAssignments.map((a) => ({
            ...a,
            person_id: String(a.person_id ?? '').trim(),
            work_date: normalizeWorkDateString(a.work_date),
          }));
          const sameDayActive = normalizedNearby.filter((a) => a.work_date === workDate);
          const adjacentDaysActive = normalizedNearby.filter((a) => a.work_date !== workDate);

          if (action === 'CLEAR_ALL_SHIFTS') {
            for (const ex of sameDayActive) {
              await tx.execute(
                "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [ex.id]
              );
              await tx.execute(
                `INSERT INTO shift_cancellation_logs (
                  shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [ex.id, personId, workDate, ex.snapshot_shift_code, reason, req.user!.username]
              );
            }

            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId,
              workDate,
              overrideState: 'CLEARED_ALL_SHIFTS',
              reason,
              actorUsername: req.user!.username,
            });

            return {
              overrideState: 'CLEARED_ALL_SHIFTS' as const,
              cancelledCount: sameDayActive.length,
              insertedCount: 0,
              conflictError: null as {
                code: string;
                message: string;
                conflicts: DailyCellConflict[];
              } | null,
            };
          }

          if (action === 'RESTORE_DEFAULT') {
            for (const ex of sameDayActive) {
              await tx.execute(
                "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [ex.id]
              );
              await tx.execute(
                `INSERT INTO shift_cancellation_logs (
                  shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  ex.id,
                  personId,
                  workDate,
                  ex.snapshot_shift_code,
                  reason || 'คืนค่ากะเริ่มต้นตามประเภทบุคลากร',
                  req.user!.username,
                ]
              );
            }

            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId,
              workDate,
              overrideState: 'RESTORED_DEFAULT',
              reason: reason || 'คืนค่ากะเริ่มต้นตามประเภทบุคลากร',
              actorUsername: req.user!.username,
            });

            return {
              overrideState: 'RESTORED_DEFAULT' as const,
              cancelledCount: sameDayActive.length,
              insertedCount: 0,
              conflictError: null,
            };
          }

          if (action === 'REMOVE_MORNING' || action === 'REMOVE_AFTERNOON') {
            const isTargetShift = (a: ExistingAssignmentRow) => {
              const startMin = parseTimeToMinutes(a.snapshot_start_time);
              if (action === 'REMOVE_MORNING') {
                return startMin >= 360 && startMin < 720; // 06:00 - 11:59
              }
              return startMin >= 720 && startMin < 1140; // 12:00 - 18:59
            };

            const toCancel = sameDayActive.filter(isTargetShift);
            const remaining = sameDayActive.filter((a) => !isTargetShift(a));

            for (const ex of toCancel) {
              await tx.execute(
                "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [ex.id]
              );
              await tx.execute(
                `INSERT INTO shift_cancellation_logs (
                  shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [ex.id, personId, workDate, ex.snapshot_shift_code, reason, req.user!.username]
              );
            }

            // หากลบกะเช้าหรือกะบ่ายแล้วไม่เหลือกะอื่นในวันนั้น ให้บันทึกเป็น CLEARED_ALL_SHIFTS เพื่อไม่ให้กะเริ่มต้นกลับมาเอง
            const nextState =
              remaining.length > 0 ? ('CUSTOM_ASSIGNED' as const) : ('CLEARED_ALL_SHIFTS' as const);

            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId,
              workDate,
              overrideState: nextState,
              reason,
              actorUsername: req.user!.username,
            });

            return {
              overrideState: nextState,
              cancelledCount: toCancel.length,
              insertedCount: 0,
              conflictError: null,
            };
          }

          // ตรวจสอบ Conflict ซ้ำภายใน Transaction สำหรับทั้ง ADD_SHIFT และ REPLACE_SHIFTS
          const rulesByCodeInTx = new Map<string, PersonnelTypeRuleRow>();
          for (const r of allRulesInTx) {
            rulesByCodeInTx.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
          }
          const normTypeCode = normalizePersonnelTypeCodeForDefaultShift(
            personRows[0].personnel_type_code,
            personRows[0].personnel_type_name
          );
          const defaultRuleInTx = normTypeCode ? rulesByCodeInTx.get(normTypeCode) || null : null;

          const evalResult = evaluateDailyCellChange({
            workDate,
            action: action === 'REPLACE_SHIFTS' ? 'REPLACE_SHIFTS' : 'ADD_SHIFT',
            selectedShifts,
            sameDayActive,
            adjacentDaysActive,
            dailyOverride: currentOverrides[0] || null,
            defaultRule: defaultRuleInTx,
          });

          if (!evalResult.canProceed) {
            const primary = evalResult.conflicts[0];
            return {
              overrideState: 'CUSTOM_ASSIGNED' as const,
              cancelledCount: 0,
              insertedCount: 0,
              conflictError: {
                code: primary.code,
                message: evalResult.conflicts.map((c) => c.message).join(' | '),
                conflicts: evalResult.conflicts,
              },
            };
          }

          if (action === 'REPLACE_SHIFTS') {
            for (const ex of sameDayActive) {
              await tx.execute(
                "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
                [ex.id]
              );
              await tx.execute(
                `INSERT INTO shift_cancellation_logs (
                  shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
                ) VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  ex.id,
                  personId,
                  workDate,
                  ex.snapshot_shift_code,
                  reason || 'เปลี่ยนกะทำงานรายวัน',
                  req.user!.username,
                ]
              );
            }

            let insertedCount = 0;
            for (const s of selectedShifts) {
              await tx.execute(
                `INSERT INTO shift_assignments (
                  person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                  snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
                  snapshot_is_cross_midnight, status, assigned_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
                [
                  personId,
                  s.id,
                  workDate,
                  s.shift_code,
                  s.shift_name,
                  s.start_time,
                  s.end_time,
                  s.grace_minutes,
                  s.cutoff_time,
                  s.is_cross_midnight,
                  req.user!.username,
                ]
              );
              insertedCount++;
            }

            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId,
              workDate,
              overrideState: 'CUSTOM_ASSIGNED',
              reason,
              actorUsername: req.user!.username,
            });

            return {
              overrideState: 'CUSTOM_ASSIGNED' as const,
              cancelledCount: sameDayActive.length,
              insertedCount,
              conflictError: null,
            };
          }

          // ADD_SHIFT: รักษากะเดิมไว้ทั้งหมด (รวมกรณีเดิมเป็นกะเช้าเริ่มต้นตามประเภทบุคลากร -> บันทึกคงไว้ด้วย)
          let insertedCount = 0;
          if (evalResult.defaultShiftToMaterialize) {
            const defMat = evalResult.defaultShiftToMaterialize;
            const matchedMorningTemplates = await tx.query<{ id: number }>(
              `SELECT id FROM shifts
               WHERE is_active = 1
                 AND (shift_code = ? OR (start_time = ? AND end_time = ?))
               ORDER BY id ASC LIMIT 1`,
              [defMat.shiftCode, defMat.startTime, defMat.endTime]
            );
            const fallbackAnyShift =
              matchedMorningTemplates.length > 0
                ? matchedMorningTemplates[0].id
                : selectedShifts[0].id;

            await tx.execute(
              `INSERT INTO shift_assignments (
                person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
                snapshot_is_cross_midnight, status, assigned_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
              [
                personId,
                fallbackAnyShift,
                workDate,
                defMat.shiftCode,
                defMat.shiftName,
                defMat.startTime,
                defMat.endTime,
                defMat.graceMinutes,
                defMat.cutoffTime,
                defMat.isCrossMidnight,
                req.user!.username,
              ]
            );
          }

          for (const s of selectedShifts) {
            await tx.execute(
              `INSERT INTO shift_assignments (
                person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
                snapshot_is_cross_midnight, status, assigned_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
              [
                personId,
                s.id,
                workDate,
                s.shift_code,
                s.shift_name,
                s.start_time,
                s.end_time,
                s.grace_minutes,
                s.cutoff_time,
                s.is_cross_midnight,
                req.user!.username,
              ]
            );
            insertedCount++;
          }

          await upsertDailyOverrideRecord(tx.execute, tx.query, {
            personId,
            workDate,
            overrideState: 'CUSTOM_ASSIGNED',
            reason,
            actorUsername: req.user!.username,
          });

          return {
            overrideState: 'CUSTOM_ASSIGNED' as const,
            cancelledCount: 0,
            insertedCount,
            conflictError: null,
          };
        })
      );

      if (txResult.conflictError) {
        res.status(409).json({
          error: txResult.conflictError.code,
          message: txResult.conflictError.message,
          conflicts: txResult.conflictError.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: `SHIFT_CELL_${action}`,
        targetType: 'SHIFT_DAILY_OVERRIDE',
        targetId: `${personId}:${workDate}`,
        result: 'SUCCESS',
        detail: {
          personId,
          workDate,
          action,
          shiftIds: rawShiftIds,
          overrideState: txResult.overrideState,
          cancelledCount: txResult.cancelledCount,
          insertedCount: txResult.insertedCount,
          reason,
        },
      });

      const [updatedAssignments, updatedOverrides, allTypeRules, hospitalHolidays] = await Promise.all([
        dbQuery<ExistingAssignmentRow>(
          `SELECT id, person_id, shift_id, work_date,
                  snapshot_shift_code, snapshot_shift_name,
                  snapshot_start_time, snapshot_end_time,
                  snapshot_grace_minutes, snapshot_cutoff_time,
                  snapshot_is_cross_midnight, status
           FROM shift_assignments
           WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE'
           ORDER BY snapshot_start_time ASC`,
          [personId, workDate]
        ),
        dbQuery<DailyOverrideRow>(
          'SELECT * FROM shift_daily_overrides WHERE person_id = ? AND work_date = ? LIMIT 1',
          [personId, workDate]
        ),
        loadPersonnelTypeRulesWithDefaultShifts(),
        loadHospitalHolidaysForRange(workDate, workDate),
      ]);

      const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
      for (const r of allTypeRules) {
        rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
      }

      const scopedHoliday = resolveHolidayForPersonDate({
        workDate,
        personId,
        departmentName: personRows[0].department_name,
        holidays: hospitalHolidays,
      });

      const resolvedSchedule = resolveEffectiveDailyScheduleForPersonDate({
        person: personRows[0],
        workDate,
        activeAssignments: updatedAssignments.map((a) => ({
          ...a,
          person_id: String(a.person_id ?? '').trim(),
          work_date: normalizeWorkDateString(a.work_date),
        })),
        dailyOverride: updatedOverrides[0] || null,
        rulesByCode,
        publicHoliday: holidayRowToPublicHolidayAdapter(scopedHoliday),
      });

      const effectiveSchedule = {
        mode:
          resolvedSchedule.state === 'RESTORED_DEFAULT'
            ? 'DEFAULT_FROM_TYPE'
            : resolvedSchedule.state,
        state: resolvedSchedule.state,
        shifts: resolvedSchedule.effectiveShifts,
        unconfiguredMessage: resolvedSchedule.unconfiguredMessage,
      };

      const actionMessages: Record<string, string> = {
        CLEAR_ALL_SHIFTS: 'ตั้งค่าวันหยุด (ไม่มีเวร) เรียบร้อยแล้ว',
        RESTORE_DEFAULT: 'คืนค่ากะเช้าเริ่มต้นตามประเภทบุคลากรเรียบร้อยแล้ว',
        REMOVE_MORNING: 'ลบกะเช้าในวันที่เลือกเรียบร้อยแล้ว',
        REMOVE_AFTERNOON: 'ลบกะบ่ายในวันที่เลือกเรียบร้อยแล้ว',
        REPLACE_SHIFTS: `แทนที่กะเดิมด้วยกะที่เลือก (${txResult.insertedCount} กะ) เรียบร้อยแล้ว`,
        ADD_SHIFT: `เพิ่มกะที่เลือก (${txResult.insertedCount} กะ) โดยเก็บกะเดิมไว้เรียบร้อยแล้ว`,
      };

      res.json({
        status: 'SUCCESS',
        message: actionMessages[action] || 'อัปเดตตารางเวรสำเร็จ',
        personId,
        workDate,
        action,
        overrideState: txResult.overrideState,
        cancelledCount: txResult.cancelledCount,
        insertedCount: txResult.insertedCount,
        effectiveSchedule,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// 5. การนำเข้าตารางเวรจากไฟล์ Excel (.xlsx) และดาวน์โหลด Template
// ============================================================================

shiftsRouter.get(
  '/shift-assignments/import-template.xlsx',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const samplePersons = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE is_active = 1 ORDER BY person_id ASC LIMIT 2'
      );
      const p1 = samplePersons[0]?.person_id ? String(samplePersons[0].person_id) : 'SAM-P001';
      const p2 = samplePersons[1]?.person_id ? String(samplePersons[1].person_id) : 'SAM-P002';

      const templateRows: string[][] = [
        ['person_id', 'work_date', 'shift_code', 'note'],
        [p1, '2026-11-24', 'MOR-0816', 'กะเช้าปกติ (ใช้ MOR หรือ MOR-0816 ได้)'],
        [p1, '2026-11-24', 'AFT-1600', 'อยู่เวรบ่ายต่อ (ไม่ทับเวลา)'],
        [p2, '2026-11-25', 'EXT-2008', 'กะพิเศษข้ามวัน'],
        [p2, '2026-11-26', 'OFF', 'วันหยุด (ไม่มีเวร)'],
      ];

      const xlsxBuf = buildXlsxBufferFromRows('ScheduleImportTemplate', templateRows);

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        'attachment; filename="Sam_Att_Schedule_Template.xlsx"'
      );
      res.send(xlsxBuf);
    } catch (err) {
      next(err);
    }
  }
);

export interface ExcelImportEvaluatedRow {
  rowNumber: number;
  personId: string;
  fullName: string | null;
  departmentName: string | null;
  workDate: string;
  shiftCode: string;
  shiftId: number | null;
  shiftName: string | null;
  startTime: string | null;
  endTime: string | null;
  note: string;
  valid: boolean;
  isClearDayOff?: boolean;
  status:
    | 'READY'
    | 'UNKNOWN_PERSONNEL'
    | 'INVALID_DATE'
    | 'UNKNOWN_SHIFT_CODE'
    | 'DUPLICATE_IN_FILE'
    | 'OVERLAP_IN_FILE'
    | 'DUPLICATE_IN_DB'
    | 'OVERLAP_IN_DB';
  errorMessage: string | null;
}

const EXCEL_CLEAR_DAY_OFF_CODES = new Set(['OFF', 'NONE', 'CLEAR', 'DAYOFF', 'วันหยุด', 'ไม่มีเวร']);

function resolveExcelShiftTemplate(rawCode: string, allShifts: ShiftRow[]): ShiftRow | null {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;

  // 1. ตรงกับ shift_code จริงในตาราง shifts
  const exact = allShifts.find((s) => String(s.shift_code || '').trim().toUpperCase() === code);
  if (exact) return exact;

  // 2. รหัสย่อมาตรฐานที่เจ้าหน้าที่ใช้บ่อยในไฟล์ Excel
  const findByCodesOrCategory = (codes: string[], categories: string[]): ShiftRow | null => {
    for (const c of codes) {
      const m = allShifts.find((s) => String(s.shift_code || '').trim().toUpperCase() === c);
      if (m) return m;
    }
    for (const cat of categories) {
      const m = allShifts.find((s) => String(s.shift_category || '').trim().toUpperCase() === cat);
      if (m) return m;
    }
    return null;
  };

  if (code === 'MOR' || code === 'M' || code === 'เช้า') {
    return findByCodesOrCategory(['MOR-0816', 'OFF-0816'], ['MORNING']);
  }
  if (code === 'AFT' || code === 'A' || code === 'บ่าย') {
    return findByCodesOrCategory(['AFT-1600'], ['AFTERNOON']);
  }
  if (code === 'NIG' || code === 'N' || code === 'ดึก') {
    return findByCodesOrCategory(['NIG-0008'], ['NIGHT']);
  }
  if (code === 'MORAFT' || code === 'MA' || code === 'เช้า-บ่าย') {
    return findByCodesOrCategory(['MA-0800', 'MORAFT-0800'], ['MORNING_AFTERNOON']);
  }
  if (code === 'AFTNIG' || code === 'AN' || code === 'บ่าย-ดึก') {
    return findByCodesOrCategory(['AN-1608', 'AFTNIG-1608'], ['AFTERNOON_NIGHT']);
  }
  if (code === 'FULL' || code === 'ALL' || code === 'ทั้งวัน') {
    return findByCodesOrCategory(['FULL-0808'], ['FULL_DAY']);
  }
  if (code === 'EXT' || code === 'SPECIAL' || code === 'พิเศษ') {
    return findByCodesOrCategory(['EXT-2008'], ['SPECIAL']);
  }
  return null;
}

async function evaluateExcelImportRows(
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  parsedRows: ParsedScheduleExcelRow[],
  importMode: 'ADD_SHIFT' | 'REPLACE_DATE' = 'ADD_SHIFT'
): Promise<{
  items: ExcelImportEvaluatedRow[];
  summary: {
    totalRows: number;
    validCount: number;
    invalidCount: number;
    unknownPersonCount: number;
    invalidDateCount: number;
    unknownShiftCount: number;
    duplicateCount: number;
    overlapCount: number;
  };
}> {
  const allPersonnel = await queryRunner<{
    person_id: string;
    full_name: string;
    department_name: string;
  }>('SELECT person_id, full_name, department_name FROM personnel');
  const personMap = new Map<string, { full_name: string; department_name: string }>();
  for (const p of allPersonnel) {
    personMap.set(String(p.person_id ?? '').trim(), {
      full_name: p.full_name,
      department_name: p.department_name,
    });
  }

  const allShifts = await queryRunner<ShiftRow>('SELECT * FROM shifts WHERE is_active = 1');

  // Collect valid dates and personIds to query existing DB assignments
  const validDates: string[] = [];
  const validPersonIds = new Set<string>();
  for (const r of parsedRows) {
    if (personMap.has(r.personId)) validPersonIds.add(r.personId);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.workDate)) validDates.push(r.workDate);
  }

  const existingByPerson = new Map<string, ExistingAssignmentRow[]>();
  if (validPersonIds.size > 0 && validDates.length > 0) {
    validDates.sort();
    const minDate = addDaysToDateString(validDates[0], -1);
    const maxDate = addDaysToDateString(validDates[validDates.length - 1], 1);
    const pList = Array.from(validPersonIds);
    const placeholders = pList.map(() => '?').join(', ');
    const dbExisting = await queryRunner<ExistingAssignmentRow>(
      `SELECT id, person_id, shift_id, work_date,
              snapshot_shift_code, snapshot_shift_name,
              snapshot_start_time, snapshot_end_time, snapshot_is_cross_midnight, status
       FROM shift_assignments
       WHERE person_id IN (${placeholders})
         AND work_date >= ?
         AND work_date <= ?
         AND status = 'ACTIVE'`,
      [...pList, minDate, maxDate]
    );

    for (const ex of dbExisting) {
      const pid = String(ex.person_id ?? '').trim();
      const list = existingByPerson.get(pid) || [];
      list.push({
        ...ex,
        person_id: pid,
        work_date: normalizeWorkDateString(ex.work_date),
      });
      existingByPerson.set(pid, list);
    }
  }

  const acceptedInFileByPerson = new Map<
    string,
    Array<{
      rowNumber: number;
      workDate: string;
      isClearDayOff: boolean;
      shift: ShiftRow | null;
    }>
  >();

  const items: ExcelImportEvaluatedRow[] = [];
  let validCount = 0;
  let unknownPersonCount = 0;
  let invalidDateCount = 0;
  let unknownShiftCount = 0;
  let duplicateCount = 0;
  let overlapCount = 0;

  for (const row of parsedRows) {
    const personId = String(row.personId || '').trim();
    const workDate = normalizeExcelWorkDate(row.workDate);
    const shiftCode = String(row.shiftCode || '').trim().toUpperCase();
    const personInfo = personMap.get(personId) || null;
    const isClearDayOff = EXCEL_CLEAR_DAY_OFF_CODES.has(shiftCode);
    const shiftInfo = isClearDayOff ? null : resolveExcelShiftTemplate(shiftCode, allShifts);

    if (!personId || !personInfo) {
      unknownPersonCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId: personId || '-',
        fullName: null,
        departmentName: null,
        workDate: workDate || '-',
        shiftCode: shiftCode || '-',
        shiftId: null,
        shiftName: null,
        startTime: null,
        endTime: null,
        note: row.note,
        valid: false,
        status: 'UNKNOWN_PERSONNEL',
        errorMessage: `ไม่พบรหัสบุคลากร "${personId || '-'}" ในทะเบียนบุคลากร`,
      });
      continue;
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
      invalidDateCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate: workDate || '-',
        shiftCode: shiftCode || '-',
        shiftId: shiftInfo?.id || null,
        shiftName: isClearDayOff ? 'วันหยุด (ไม่มีเวร)' : shiftInfo?.shift_name || null,
        startTime: shiftInfo?.start_time || null,
        endTime: shiftInfo?.end_time || null,
        note: row.note,
        valid: false,
        status: 'INVALID_DATE',
        errorMessage: `รูปแบบวันที่ "${row.workDate}" ไม่ถูกต้อง (ต้องเป็น YYYY-MM-DD เช่น 2026-11-24)`,
      });
      continue;
    }

    if (!isClearDayOff && !shiftInfo) {
      unknownShiftCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: shiftCode || '-',
        shiftId: null,
        shiftName: null,
        startTime: null,
        endTime: null,
        note: row.note,
        valid: false,
        status: 'UNKNOWN_SHIFT_CODE',
        errorMessage: `ไม่พบรหัสกะทำงาน "${shiftCode || '-'}" ในแม่แบบกะที่เปิดใช้งาน (รองรับรหัสกะจริง, MOR/AFT/NIG และ OFF)`,
      });
      continue;
    }

    const fileList = acceptedInFileByPerson.get(personId) || [];

    // กรณี OFF (วันหยุด / ลบกะทั้งหมด)
    if (isClearDayOff) {
      const sameDateFileConflict = fileList.find((f) => f.workDate === workDate);
      if (sameDateFileConflict) {
        const isDupOff = sameDateFileConflict.isClearDayOff;
        if (isDupOff) duplicateCount++;
        else overlapCount++;
        items.push({
          rowNumber: row.rowNumber,
          personId,
          fullName: personInfo.full_name,
          departmentName: personInfo.department_name,
          workDate,
          shiftCode,
          shiftId: null,
          shiftName: 'วันหยุด (ไม่มีเวร)',
          startTime: null,
          endTime: null,
          note: row.note,
          valid: false,
          isClearDayOff: true,
          status: isDupOff ? 'DUPLICATE_IN_FILE' : 'OVERLAP_IN_FILE',
          errorMessage: isDupOff
            ? `กำหนดวันหยุด (OFF) ซ้ำกับแถวที่ ${sameDateFileConflict.rowNumber} ในไฟล์เดียวกัน`
            : `ไม่สามารถกำหนด OFF ร่วมกับกะทำงานในแถวที่ ${sameDateFileConflict.rowNumber} ในวันเดียวกันได้`,
        });
        continue;
      }

      fileList.push({ rowNumber: row.rowNumber, workDate, isClearDayOff: true, shift: null });
      acceptedInFileByPerson.set(personId, fileList);
      validCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: 'OFF',
        shiftId: null,
        shiftName: 'วันหยุด (ไม่มีเวร)',
        startTime: null,
        endTime: null,
        note: row.note,
        valid: true,
        isClearDayOff: true,
        status: 'READY',
        errorMessage: null,
      });
      continue;
    }

    const resolvedShift = shiftInfo!;
    const candInt = computeAbsoluteIntervalMinutes(
      workDate,
      resolvedShift.start_time,
      resolvedShift.end_time,
      resolvedShift.is_cross_midnight
    );

    // 1. Check duplicate or overlap within the uploaded Excel file itself
    const fileOffConflict = fileList.find((f) => f.workDate === workDate && f.isClearDayOff);
    if (fileOffConflict) {
      overlapCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: resolvedShift.shift_code,
        shiftId: resolvedShift.id,
        shiftName: resolvedShift.shift_name,
        startTime: resolvedShift.start_time,
        endTime: resolvedShift.end_time,
        note: row.note,
        valid: false,
        status: 'OVERLAP_IN_FILE',
        errorMessage: `ขัดแย้งกับแถวที่ ${fileOffConflict.rowNumber} ที่ระบุเป็นวันหยุด (OFF) ในวันเดียวกัน`,
      });
      continue;
    }

    const fileDup = fileList.find(
      (f) => f.workDate === workDate && f.shift && Number(f.shift.id) === Number(resolvedShift.id)
    );
    if (fileDup) {
      duplicateCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: resolvedShift.shift_code,
        shiftId: resolvedShift.id,
        shiftName: resolvedShift.shift_name,
        startTime: resolvedShift.start_time,
        endTime: resolvedShift.end_time,
        note: row.note,
        valid: false,
        status: 'DUPLICATE_IN_FILE',
        errorMessage: `กะซ้ำกับแถวที่ ${fileDup.rowNumber} ในไฟล์ Excel เดียวกัน`,
      });
      continue;
    }

    const fileOverlap = fileList.find((f) => {
      if (!f.shift) return false;
      const fInt = computeAbsoluteIntervalMinutes(
        f.workDate,
        f.shift.start_time,
        f.shift.end_time,
        f.shift.is_cross_midnight
      );
      return (
        Math.max(candInt.startAbsMin, fInt.startAbsMin) <
        Math.min(candInt.endAbsMin, fInt.endAbsMin)
      );
    });
    if (fileOverlap && fileOverlap.shift) {
      overlapCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: resolvedShift.shift_code,
        shiftId: resolvedShift.id,
        shiftName: resolvedShift.shift_name,
        startTime: resolvedShift.start_time,
        endTime: resolvedShift.end_time,
        note: row.note,
        valid: false,
        status: 'OVERLAP_IN_FILE',
        errorMessage: `เวลาทับซ้อนกับแถวที่ ${fileOverlap.rowNumber} (${fileOverlap.shift.shift_name}) ในไฟล์เดียวกัน`,
      });
      continue;
    }

    // 2. Check duplicate or overlap against existing DB shift_assignments
    // ถ้าโหมด REPLACE_DATE จะยกเลิกเวรเดิมเฉพาะวันนั้นอยู่แล้ว จึงตรวจเฉพาะวันข้างเคียง (ข้ามคืน)
    const dbList = (existingByPerson.get(personId) || []).filter((ex) =>
      importMode === 'REPLACE_DATE' ? ex.work_date !== workDate : true
    );
    const dbDup = dbList.find(
      (ex) => ex.work_date === workDate && Number(ex.shift_id) === Number(resolvedShift.id)
    );
    if (dbDup) {
      duplicateCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: resolvedShift.shift_code,
        shiftId: resolvedShift.id,
        shiftName: resolvedShift.shift_name,
        startTime: resolvedShift.start_time,
        endTime: resolvedShift.end_time,
        note: row.note,
        valid: false,
        status: 'DUPLICATE_IN_DB',
        errorMessage: `มีเวร ${dbDup.snapshot_shift_name} ในระบบแล้วเมื่อวันที่ ${workDate}`,
      });
      continue;
    }

    const dbOverlap = dbList.find((ex) => {
      const exInt = computeAbsoluteIntervalMinutes(
        ex.work_date,
        ex.snapshot_start_time,
        ex.snapshot_end_time,
        ex.snapshot_is_cross_midnight
      );
      return (
        Math.max(candInt.startAbsMin, exInt.startAbsMin) <
        Math.min(candInt.endAbsMin, exInt.endAbsMin)
      );
    });
    if (dbOverlap) {
      overlapCount++;
      items.push({
        rowNumber: row.rowNumber,
        personId,
        fullName: personInfo.full_name,
        departmentName: personInfo.department_name,
        workDate,
        shiftCode: resolvedShift.shift_code,
        shiftId: resolvedShift.id,
        shiftName: resolvedShift.shift_name,
        startTime: resolvedShift.start_time,
        endTime: resolvedShift.end_time,
        note: row.note,
        valid: false,
        status: 'OVERLAP_IN_DB',
        errorMessage: `เวลาทับซ้อนกับเวรในระบบ ${dbOverlap.snapshot_shift_name} (${dbOverlap.snapshot_start_time}–${dbOverlap.snapshot_end_time} น. วันที่ ${dbOverlap.work_date})`,
      });
      continue;
    }

    fileList.push({
      rowNumber: row.rowNumber,
      workDate,
      isClearDayOff: false,
      shift: resolvedShift,
    });
    acceptedInFileByPerson.set(personId, fileList);
    validCount++;
    items.push({
      rowNumber: row.rowNumber,
      personId,
      fullName: personInfo.full_name,
      departmentName: personInfo.department_name,
      workDate,
      shiftCode: resolvedShift.shift_code,
      shiftId: resolvedShift.id,
      shiftName: resolvedShift.shift_name,
      startTime: resolvedShift.start_time,
      endTime: resolvedShift.end_time,
      note: row.note,
      valid: true,
      isClearDayOff: false,
      status: 'READY',
      errorMessage: null,
    });
  }

  return {
    items,
    summary: {
      totalRows: items.length,
      validCount,
      invalidCount: items.length - validCount,
      unknownPersonCount,
      invalidDateCount,
      unknownShiftCount,
      duplicateCount,
      overlapCount,
    },
  };
}

function parseExcelPayloadFromBody(body: Record<string, unknown>): {
  filename: string;
  parsedRows: ParsedScheduleExcelRow[];
} {
  const filename = String(body?.filename || body?.fileName || 'schedule_import.xlsx').trim();
  if (Array.isArray(body?.rows)) {
    const rows = body.rows as Array<Record<string, unknown>>;
    return {
      filename,
      parsedRows: rows.map((r, idx) => ({
        rowNumber: Number(r.rowNumber || idx + 2),
        personId: String(r.person_id ?? r.personId ?? '').trim(),
        workDate: normalizeExcelWorkDate(String(r.work_date ?? r.workDate ?? '')),
        shiftCode: String(r.shift_code ?? r.shiftCode ?? '').trim().toUpperCase(),
        note: String(r.note ?? '').trim(),
      })),
    };
  }

  const fileBase64 = String(body?.fileBase64 || '').trim();
  if (!fileBase64) {
    throw new Error('EXCEL_FILE_REQUIRED: กรุณาเลือกไฟล์ Excel (.xlsx) ที่ต้องการนำเข้า');
  }
  const cleanBase64 = fileBase64.replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(cleanBase64, 'base64');
  return {
    filename,
    parsedRows: extractScheduleRecordsFromXlsxBuffer(buf),
  };
}

shiftsRouter.post(
  '/shift-assignments/import-excel/preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      let parsedPayload: { filename: string; parsedRows: ParsedScheduleExcelRow[] };
      try {
        parsedPayload = parseExcelPayloadFromBody(req.body || {});
      } catch (parseErr: unknown) {
        res.status(400).json({
          error: 'INVALID_EXCEL_FILE',
          message:
            parseErr instanceof Error
              ? parseErr.message
              : 'ไม่สามารถอ่านไฟล์ Excel (.xlsx) ได้ กรุณาใช้ไฟล์จาก Template มาตรฐาน',
          requestId: req.requestId,
        });
        return;
      }

      if (parsedPayload.parsedRows.length === 0) {
        res.status(400).json({
          error: 'EMPTY_EXCEL_ROWS',
          message: 'ไม่พบข้อมูลแถวตารางเวรในไฟล์ Excel (.xlsx) ที่อัปโหลด',
          requestId: req.requestId,
        });
        return;
      }

      const importMode = req.body?.mode === 'REPLACE_DATE' ? 'REPLACE_DATE' : 'ADD_SHIFT';
      const evaluation = await evaluateExcelImportRows(
        dbQuery,
        parsedPayload.parsedRows,
        importMode
      );

      res.json({
        filename: parsedPayload.filename,
        fileName: parsedPayload.filename,
        mode: importMode,
        summary: evaluation.summary,
        items: evaluation.items,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.post(
  '/shift-assignments/import-excel/confirm',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      let parsedPayload: { filename: string; parsedRows: ParsedScheduleExcelRow[] };
      try {
        parsedPayload = parseExcelPayloadFromBody(req.body || {});
      } catch (parseErr: unknown) {
        res.status(400).json({
          error: 'INVALID_EXCEL_FILE',
          message:
            parseErr instanceof Error
              ? parseErr.message
              : 'ไม่สามารถอ่านไฟล์ Excel (.xlsx) ได้',
          requestId: req.requestId,
        });
        return;
      }

      const conflictStrategy =
        req.body?.conflictStrategy === 'ABORT_ON_ERROR' ? 'ABORT_ON_ERROR' : 'SKIP_INVALID';
      const importMode = req.body?.mode === 'REPLACE_DATE' ? 'REPLACE_DATE' : 'ADD_SHIFT';

      const closedMonths = await findClosedPeriodsInDates(
        parsedPayload.parsedRows.map((r) => r.workDate)
      );
      if (closedMonths.length > 0) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถนำเข้าตารางเวรในงวดเดือนที่ปิดรอบบัญชีแล้วได้ (${closedMonths.join(', ')})`,
          closedPeriods: closedMonths,
          requestId: req.requestId,
        });
        return;
      }

      const allShifts = await dbQuery<ShiftRow>('SELECT * FROM shifts WHERE is_active = 1');
      const shiftById = new Map<number, ShiftRow>();
      for (const s of allShifts) {
        shiftById.set(Number(s.id), s);
      }

      const txResult = await dbTransaction(async (tx: DbTransactionContext) => {
        const evaluation = await evaluateExcelImportRows(
          tx.query,
          parsedPayload.parsedRows,
          importMode
        );
        const readyItems = evaluation.items.filter((i) => i.status === 'READY');
        const invalidItems = evaluation.items.filter((i) => i.status !== 'READY');

        if (conflictStrategy === 'ABORT_ON_ERROR' && invalidItems.length > 0) {
          return {
            aborted: true,
            importedCount: 0,
            skippedCount: invalidItems.length,
            evaluation,
          };
        }

        // ถ้าโหมด REPLACE_DATE หรือรายการเป็น OFF ให้ Soft-Cancel เฉพาะ (personId, workDate) ที่มีใน readyItems เท่านั้น (ห้ามล้างตารางเวรทั้งระบบ)
        const clearedDateKeys = new Set<string>();
        const cancelExistingForPersonDate = async (
          personId: string,
          workDate: string,
          cancelReason: string
        ) => {
          const key = `${personId}|${workDate}`;
          if (clearedDateKeys.has(key)) return;
          clearedDateKeys.add(key);

          const existingActive = await tx.query<ExistingAssignmentRow>(
            `SELECT id, person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                    snapshot_start_time, snapshot_end_time, snapshot_is_cross_midnight, status
             FROM shift_assignments
             WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE'`,
            [personId, workDate]
          );
          for (const ex of existingActive) {
            await tx.execute(
              "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              [ex.id]
            );
            await tx.execute(
              `INSERT INTO shift_cancellation_logs (
                shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [ex.id, personId, workDate, ex.snapshot_shift_code, cancelReason, req.user!.username]
            );
          }
        };

        let importedCount = 0;
        for (const item of readyItems) {
          if (item.isClearDayOff) {
            await cancelExistingForPersonDate(
              item.personId,
              item.workDate,
              item.note || `กำหนดวันหยุด (OFF) จากไฟล์ Excel (${parsedPayload.filename})`
            );
            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId: item.personId,
              workDate: item.workDate,
              overrideState: 'CLEARED_ALL_SHIFTS',
              reason: item.note || `กำหนดวันหยุด (OFF) จากไฟล์ Excel (${parsedPayload.filename})`,
              actorUsername: req.user!.username,
            });
            importedCount++;
            continue;
          }

          const shift = shiftById.get(Number(item.shiftId));
          if (!shift) continue;

          if (importMode === 'REPLACE_DATE') {
            await cancelExistingForPersonDate(
              item.personId,
              item.workDate,
              `แทนที่เวรเดิมจากการนำเข้าไฟล์ Excel (${parsedPayload.filename})`
            );
          }

          await tx.execute(
            `INSERT INTO shift_assignments (
              person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
              snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
              snapshot_is_cross_midnight, status, assigned_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
            [
              item.personId,
              shift.id,
              item.workDate,
              shift.shift_code,
              shift.shift_name,
              shift.start_time,
              shift.end_time,
              shift.grace_minutes,
              shift.cutoff_time,
              shift.is_cross_midnight,
              req.user!.username,
            ]
          );

          await upsertDailyOverrideRecord(tx.execute, tx.query, {
            personId: item.personId,
            workDate: item.workDate,
            overrideState: 'CUSTOM_ASSIGNED',
            reason: item.note || `นำเข้าตารางเวรจากไฟล์ Excel (${parsedPayload.filename})`,
            actorUsername: req.user!.username,
          });

          importedCount++;
        }

        await tx.execute(
          `INSERT INTO shift_import_logs (
            filename, total_rows, valid_rows, invalid_rows, imported_count, skipped_count, imported_by, summary_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            parsedPayload.filename,
            evaluation.summary.totalRows,
            evaluation.summary.validCount,
            evaluation.summary.invalidCount,
            importedCount,
            invalidItems.length,
            req.user!.username,
            JSON.stringify(evaluation.summary),
          ]
        );

        return {
          aborted: false,
          importedCount,
          skippedCount: invalidItems.length,
          evaluation,
        };
      });

      if (txResult.aborted) {
        res.status(409).json({
          error: 'EXCEL_IMPORT_CONFLICT',
          message: `พบรายการที่ไม่ถูกต้องหรือซ้ำซ้อน ${txResult.skippedCount} รายการ ระบบยกเลิกการนำเข้าตามนโยบายที่เลือก`,
          summary: txResult.evaluation.summary,
          items: txResult.evaluation.items,
          requestId: req.requestId,
        });
        return;
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_EXCEL_IMPORTED',
        targetType: 'SHIFT_ASSIGNMENT',
        targetId: parsedPayload.filename.slice(0, 120),
        result: 'SUCCESS',
        detail: {
          filename: parsedPayload.filename,
          mode: importMode,
          importedCount: txResult.importedCount,
          skippedCount: txResult.skippedCount,
          summary: txResult.evaluation.summary,
        },
      });

      res.status(200).json({
        status: 'SUCCESS',
        filename: parsedPayload.filename,
        fileName: parsedPayload.filename,
        mode: importMode,
        importedCount: txResult.importedCount,
        insertedCount: txResult.importedCount,
        skippedCount: txResult.skippedCount,
        summary: txResult.evaluation.summary,
        items: txResult.evaluation.items,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ============================================================================
// 6. การมอบหมายเวรแบบกลุ่มและรายเดี่ยว (Bulk & Single Assignment + Soft Cancel)
// ============================================================================

function parseBulkShiftIds(body: Record<string, unknown>): number[] {
  const result: number[] = [];
  if (Array.isArray(body?.shiftIds)) {
    for (const raw of body.shiftIds) {
      const n = Number(raw);
      if (Number.isInteger(n) && n > 0 && !result.includes(n)) {
        result.push(n);
      }
    }
  }
  if (body?.shiftId) {
    const n = Number(body.shiftId);
    if (Number.isInteger(n) && n > 0 && !result.includes(n)) {
      result.push(n);
    }
  }
  return result;
}

function parseBulkOperationMode(raw: unknown): BulkOperationMode {
  const val = String(raw || 'ADD_SHIFTS').trim().toUpperCase();
  if (
    val === 'ADD_SHIFTS' ||
    val === 'REPLACE_SHIFTS' ||
    val === 'REMOVE_SELECTED_SHIFTS' ||
    val === 'CLEAR_ALL_SHIFTS'
  ) {
    return val;
  }
  return 'ADD_SHIFTS';
}

function formatShiftSnapshotItem(s: ShiftRow) {
  return {
    shiftId: s.id,
    shiftCode: s.shift_code,
    shiftName: s.shift_name,
    startTime: s.start_time,
    endTime: s.end_time,
    graceMinutes: s.grace_minutes,
    cutoffTime: s.cutoff_time,
    isCrossMidnight: Number(s.is_cross_midnight),
  };
}

shiftsRouter.post(
  '/shift-assignments/bulk-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const rawPersonIds: unknown[] = Array.isArray(req.body?.personIds) ? req.body.personIds : [];
      const rawWorkDates: unknown[] = Array.isArray(req.body?.workDates) ? req.body.workDates : [];
      const operationMode = parseBulkOperationMode(req.body?.operationMode);
      const shiftIds = parseBulkShiftIds((req.body || {}) as Record<string, unknown>);

      const personIds = Array.from(
        new Set(rawPersonIds.map((id) => String(id || '').trim()).filter(Boolean))
      );
      const workDates = Array.from(
        new Set(
          rawWorkDates
            .map((d) => normalizeWorkDateString(d))
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      ).sort();

      if (
        personIds.length === 0 ||
        workDates.length === 0 ||
        (operationMode !== 'CLEAR_ALL_SHIFTS' && shiftIds.length === 0)
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message:
            operationMode === 'CLEAR_ALL_SHIFTS'
              ? 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน และวันที่ปฏิบัติงานอย่างน้อย 1 วัน'
              : 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน แม่แบบกะทำงานอย่างน้อย 1 กะ และวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
          requestId: req.requestId,
        });
        return;
      }

      let selectedShifts: ShiftRow[] = [];
      if (operationMode !== 'CLEAR_ALL_SHIFTS') {
        const placeholders = shiftIds.map(() => '?').join(', ');
        const foundShifts = await dbQuery<ShiftRow>(
          `SELECT * FROM shifts WHERE id IN (${placeholders}) AND is_active = 1`,
          shiftIds
        );
        if (foundShifts.length !== shiftIds.length) {
          res.status(404).json({
            error: 'SHIFT_NOT_FOUND',
            message: 'ไม่พบแม่แบบกะทำงานบางรายการที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
            requestId: req.requestId,
          });
          return;
        }
        // รักษาลำดับตามที่ผู้ใช้เลือก
        const byId = new Map(foundShifts.map((s) => [Number(s.id), s]));
        selectedShifts = shiftIds.map((id) => byId.get(id)!).filter(Boolean);

        // ตรวจการทับซ้อนกันเองของกะที่เลือกในโหมด ADD_SHIFTS / REPLACE_SHIFTS
        if (operationMode === 'ADD_SHIFTS' || operationMode === 'REPLACE_SHIFTS') {
          const selfOverlaps = findAllSelectedShiftsSelfOverlaps(selectedShifts, workDates[0]);
          if (selfOverlaps.length > 0) {
            const summaryMessage =
              selfOverlaps.length === 1
                ? selfOverlaps[0].message
                : `พบแม่แบบกะที่มีเวลาทับซ้อนกัน ${selfOverlaps.length} คู่ กรุณาตรวจสอบก่อนบันทึก: ${selfOverlaps
                    .slice(0, 3)
                    .map((o) => `${o.shiftA.shift_name} กับ ${o.shiftB.shift_name}`)
                    .join(', ')}${selfOverlaps.length > 3 ? ` และอีก ${selfOverlaps.length - 3} คู่` : ''}`;
            res.status(409).json({
              error: 'SELECTED_SHIFTS_OVERLAP',
              message: summaryMessage,
              conflicts: selfOverlaps.map((o) => ({
                shiftAId: o.shiftA.id,
                shiftAName: o.shiftA.shift_name,
                shiftATime: `${o.shiftA.start_time}–${o.shiftA.end_time}`,
                shiftBId: o.shiftB.id,
                shiftBName: o.shiftB.shift_name,
                shiftBTime: `${o.shiftB.start_time}–${o.shiftB.end_time}`,
                message: o.message,
              })),
              requestId: req.requestId,
            });
            return;
          }
        }
      }

      const personPlaceholders = personIds.map(() => '?').join(', ');
      const validPersons = await dbQuery<{ person_id: string }>(
        `SELECT person_id FROM personnel WHERE person_id IN (${personPlaceholders})`,
        personIds
      );
      if (validPersons.length !== personIds.length) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'พบรหัสบุคลากรบางรายการไม่มีอยู่ในระบบ กรุณารีเฟรชรายชื่อบุคลากรแล้วลองใหม่',
          requestId: req.requestId,
        });
        return;
      }

      const evaluation = await evaluateBulkShiftAssignments(dbQuery, {
        personIds,
        shifts: selectedShifts,
        workDates,
        operationMode,
      });

      const shiftSnapshots = selectedShifts.map(formatShiftSnapshotItem);

      res.json({
        requestId: req.requestId,
        operationMode,
        shiftSnapshot: shiftSnapshots[0] || null,
        shiftSnapshots,
        summary: evaluation.summary,
        items: evaluation.items,
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.post(
  '/shift-assignments/bulk',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const rawPersonIds: unknown[] = Array.isArray(req.body?.personIds) ? req.body.personIds : [];
      const rawWorkDates: unknown[] = Array.isArray(req.body?.workDates) ? req.body.workDates : [];
      const operationMode = parseBulkOperationMode(req.body?.operationMode);
      const shiftIds = parseBulkShiftIds((req.body || {}) as Record<string, unknown>);
      const reason = String(req.body?.reason || '').trim() || null;
      const conflictStrategy =
        req.body?.conflictStrategy === 'ABORT_ON_CONFLICT'
          ? 'ABORT_ON_CONFLICT'
          : 'SKIP_CONFLICTS';

      // ห้ามแทนที่หรือลบข้อมูลกะเดิมโดยไม่ได้รับการยืนยันอย่างชัดเจน
      if (
        (operationMode === 'REPLACE_SHIFTS' ||
          operationMode === 'REMOVE_SELECTED_SHIFTS' ||
          operationMode === 'CLEAR_ALL_SHIFTS') &&
        req.body?.confirmAction !== true
      ) {
        res.status(400).json({
          error: 'CONFIRMATION_REQUIRED',
          message:
            'การแทนที่กะเดิมหรือลบกะทำงานต้องได้รับการยืนยันอย่างชัดเจนจากผู้ใช้งานก่อนบันทึก (confirmAction: true)',
          requestId: req.requestId,
        });
        return;
      }

      const personIds = Array.from(
        new Set(rawPersonIds.map((id) => String(id || '').trim()).filter(Boolean))
      );
      const workDates = Array.from(
        new Set(
          rawWorkDates
            .map((d) => normalizeWorkDateString(d))
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      ).sort();

      if (
        personIds.length === 0 ||
        workDates.length === 0 ||
        (operationMode !== 'CLEAR_ALL_SHIFTS' && shiftIds.length === 0)
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message:
            operationMode === 'CLEAR_ALL_SHIFTS'
              ? 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน และวันที่ปฏิบัติงานอย่างน้อย 1 วัน'
              : 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน แม่แบบกะทำงานอย่างน้อย 1 กะ และวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
          requestId: req.requestId,
        });
        return;
      }

      const closedMonths = await findClosedPeriodsInDates(workDates);
      if (closedMonths.length > 0) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถจัดการตารางเวรแบบกลุ่มในงวดเดือนที่ปิดรอบบัญชีแล้วได้ (${closedMonths.join(', ')})`,
          closedPeriods: closedMonths,
          requestId: req.requestId,
        });
        return;
      }

      let selectedShifts: ShiftRow[] = [];
      if (operationMode !== 'CLEAR_ALL_SHIFTS') {
        const placeholders = shiftIds.map(() => '?').join(', ');
        const foundShifts = await dbQuery<ShiftRow>(
          `SELECT * FROM shifts WHERE id IN (${placeholders}) AND is_active = 1`,
          shiftIds
        );
        if (foundShifts.length !== shiftIds.length) {
          res.status(404).json({
            error: 'SHIFT_NOT_FOUND',
            message: 'ไม่พบแม่แบบกะทำงานบางรายการที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
            requestId: req.requestId,
          });
          return;
        }
        const byId = new Map(foundShifts.map((s) => [Number(s.id), s]));
        selectedShifts = shiftIds.map((id) => byId.get(id)!).filter(Boolean);

        if (operationMode === 'ADD_SHIFTS' || operationMode === 'REPLACE_SHIFTS') {
          const selfOverlaps = findAllSelectedShiftsSelfOverlaps(selectedShifts, workDates[0]);
          if (selfOverlaps.length > 0) {
            const summaryMessage =
              selfOverlaps.length === 1
                ? selfOverlaps[0].message
                : `พบแม่แบบกะที่มีเวลาทับซ้อนกัน ${selfOverlaps.length} คู่ กรุณาตรวจสอบก่อนบันทึก: ${selfOverlaps
                    .slice(0, 3)
                    .map((o) => `${o.shiftA.shift_name} กับ ${o.shiftB.shift_name}`)
                    .join(', ')}${selfOverlaps.length > 3 ? ` และอีก ${selfOverlaps.length - 3} คู่` : ''}`;
            res.status(409).json({
              error: 'SELECTED_SHIFTS_OVERLAP',
              message: summaryMessage,
              conflicts: selfOverlaps.map((o) => ({
                shiftAId: o.shiftA.id,
                shiftAName: o.shiftA.shift_name,
                shiftATime: `${o.shiftA.start_time}–${o.shiftA.end_time}`,
                shiftBId: o.shiftB.id,
                shiftBName: o.shiftB.shift_name,
                shiftBTime: `${o.shiftB.start_time}–${o.shiftB.end_time}`,
                message: o.message,
              })),
              requestId: req.requestId,
            });
            return;
          }
        }
      }

      const shiftById = new Map(selectedShifts.map((s) => [Number(s.id), s]));

      const personPlaceholders = personIds.map(() => '?').join(', ');
      const validPersons = await dbQuery<{ person_id: string }>(
        `SELECT person_id FROM personnel WHERE person_id IN (${personPlaceholders})`,
        personIds
      );
      if (validPersons.length !== personIds.length) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'พบรหัสบุคลากรบางรายการไม่มีอยู่ในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const txOutcome = await dbTransaction(async (tx: DbTransactionContext) => {
        const evaluation = await evaluateBulkShiftAssignments(tx.query, {
          personIds,
          shifts: selectedShifts,
          workDates,
          operationMode,
        });

        const conflicts = evaluation.items.filter(
          (item) => item.status !== 'READY' && item.status !== 'NOT_ASSIGNED'
        );
        const readyItems = evaluation.items.filter((item) => item.status === 'READY');

        if (conflictStrategy === 'ABORT_ON_CONFLICT' && conflicts.length > 0) {
          return {
            abortedDueToConflict: true,
            insertedIds: [] as number[],
            cancelledCount: 0,
            clearedCellsCount: 0,
            readyItems,
            conflicts,
            summary: evaluation.summary,
          };
        }

        const insertedIds: number[] = [];
        let cancelledCount = 0;
        let clearedCellsCount = 0;

        const cancelActiveForPersonDate = async (
          personId: string,
          workDate: string,
          cancelReasonText: string,
          onlyShiftId?: number | null
        ): Promise<number> => {
          const existingActive = onlyShiftId
            ? await tx.query<ExistingAssignmentRow>(
                `SELECT id, person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                        snapshot_start_time, snapshot_end_time, snapshot_is_cross_midnight, status
                 FROM shift_assignments
                 WHERE person_id = ? AND work_date = ? AND shift_id = ? AND status = 'ACTIVE'`,
                [personId, workDate, onlyShiftId]
              )
            : await tx.query<ExistingAssignmentRow>(
                `SELECT id, person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                        snapshot_start_time, snapshot_end_time, snapshot_is_cross_midnight, status
                 FROM shift_assignments
                 WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE'`,
                [personId, workDate]
              );

          for (const ex of existingActive) {
            await tx.execute(
              "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
              [ex.id]
            );
            await tx.execute(
              `INSERT INTO shift_cancellation_logs (
                shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
              ) VALUES (?, ?, ?, ?, ?, ?)`,
              [
                ex.id,
                personId,
                workDate,
                ex.snapshot_shift_code,
                cancelReasonText,
                req.user!.username,
              ]
            );
          }
          return existingActive.length;
        };

        if (operationMode === 'CLEAR_ALL_SHIFTS') {
          for (const item of readyItems) {
            const c = await cancelActiveForPersonDate(
              item.personId,
              item.workDate,
              reason || 'ลบกะทั้งหมดแบบกลุ่ม (ตั้งเป็นไม่มีเวร)'
            );
            cancelledCount += c;
            clearedCellsCount++;
            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId: item.personId,
              workDate: item.workDate,
              overrideState: 'CLEARED_ALL_SHIFTS',
              reason: reason || 'ลบกะทั้งหมดแบบกลุ่ม (ตั้งเป็นไม่มีเวร)',
              actorUsername: req.user!.username,
            });
          }
        } else if (operationMode === 'REMOVE_SELECTED_SHIFTS') {
          const touchedPersonDates = new Set<string>();
          for (const item of readyItems) {
            if (!item.shiftId) continue;
            const c = await cancelActiveForPersonDate(
              item.personId,
              item.workDate,
              reason || `ลบกะที่เลือกแบบกลุ่ม (${item.shiftCode || item.shiftId})`,
              item.shiftId
            );
            cancelledCount += c;
            touchedPersonDates.add(`${item.personId}|${item.workDate}`);
          }

          // ตรวจแต่ละ (personId, workDate) ที่ลบกะแล้ว: หากไม่เหลือกะ ACTIVE ให้คงสถานะ CLEARED_ALL_SHIFTS (ห้ามสร้างกะเริ่มต้นกลับมาเอง)
          for (const key of touchedPersonDates) {
            const [pid, wDate] = key.split('|');
            const remaining = await tx.query<{ id: number }>(
              "SELECT id FROM shift_assignments WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE' LIMIT 1",
              [pid, wDate]
            );
            const nextState =
              remaining.length > 0 ? ('CUSTOM_ASSIGNED' as const) : ('CLEARED_ALL_SHIFTS' as const);
            if (nextState === 'CLEARED_ALL_SHIFTS') {
              clearedCellsCount++;
            }
            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId: pid,
              workDate: wDate,
              overrideState: nextState,
              reason: reason || 'ลบกะที่เลือกแบบกลุ่ม',
              actorUsername: req.user!.username,
            });
          }
        } else {
          // ADD_SHIFTS หรือ REPLACE_SHIFTS
          const replacedKeys = new Set<string>();
          for (const item of readyItems) {
            const shift = item.shiftId ? shiftById.get(Number(item.shiftId)) : undefined;
            if (!shift) continue;

            if (operationMode === 'REPLACE_SHIFTS') {
              const key = `${item.personId}|${item.workDate}`;
              if (!replacedKeys.has(key)) {
                replacedKeys.add(key);
                const c = await cancelActiveForPersonDate(
                  item.personId,
                  item.workDate,
                  reason || `แทนที่กะเดิมแบบกลุ่ม (${selectedShifts.map((s) => s.shift_code).join(', ')})`
                );
                cancelledCount += c;
              }
            }

            const ins = await tx.execute(
              `INSERT INTO shift_assignments (
                person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
                snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
                snapshot_is_cross_midnight, status, assigned_by
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
              [
                item.personId,
                shift.id,
                item.workDate,
                shift.shift_code,
                shift.shift_name,
                shift.start_time,
                shift.end_time,
                shift.grace_minutes,
                shift.cutoff_time,
                shift.is_cross_midnight,
                req.user!.username,
              ]
            );
            if (ins.insertId) {
              insertedIds.push(ins.insertId);
            }

            await upsertDailyOverrideRecord(tx.execute, tx.query, {
              personId: item.personId,
              workDate: item.workDate,
              overrideState: 'CUSTOM_ASSIGNED',
              reason:
                reason ||
                (operationMode === 'REPLACE_SHIFTS'
                  ? `แทนที่กะแบบกลุ่ม (${shift.shift_code})`
                  : `มอบหมายเวรแบบกลุ่ม (${shift.shift_code})`),
              actorUsername: req.user!.username,
            });
          }
        }

        return {
          abortedDueToConflict: false,
          insertedIds,
          cancelledCount,
          clearedCellsCount,
          readyItems,
          conflicts,
          summary: evaluation.summary,
        };
      });

      if (txOutcome.abortedDueToConflict) {
        res.status(409).json({
          error: 'BULK_SHIFT_CONFLICT',
          message: `พบตารางเวรซ้ำหรือเวลาทับซ้อน ${txOutcome.conflicts.length} รายการ ระบบยกเลิกการบันทึกทั้งหมดตามนโยบายที่เลือก`,
          summary: txOutcome.summary,
          conflicts: txOutcome.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      const shiftSnapshots = selectedShifts.map(formatShiftSnapshotItem);

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action:
          operationMode === 'CLEAR_ALL_SHIFTS'
            ? 'SHIFT_BULK_CLEARED'
            : operationMode === 'REMOVE_SELECTED_SHIFTS'
              ? 'SHIFT_BULK_REMOVED'
              : operationMode === 'REPLACE_SHIFTS'
                ? 'SHIFT_BULK_REPLACED'
                : 'SHIFT_BULK_ASSIGNED',
        targetType: 'SHIFT_ASSIGNMENT',
        targetId: (txOutcome.insertedIds.join(',') || `${operationMode}:${personIds.length}p`).slice(
          0,
          120
        ),
        result: 'SUCCESS',
        detail: {
          operationMode,
          shiftIds,
          shiftCodes: selectedShifts.map((s) => s.shift_code),
          conflictStrategy,
          totalRequested: txOutcome.summary.totalRequested,
          insertedCount: txOutcome.insertedIds.length,
          cancelledCount: txOutcome.cancelledCount,
          clearedCellsCount: txOutcome.clearedCellsCount,
          skippedConflictCount: txOutcome.conflicts.length,
          personIds,
          workDates,
        },
      });

      res.status(201).json({
        status: 'SUCCESS',
        requestId: req.requestId,
        operationMode,
        shiftSnapshot: shiftSnapshots[0] || null,
        shiftSnapshots,
        insertedCount: txOutcome.insertedIds.length,
        cancelledCount: txOutcome.cancelledCount,
        clearedCellsCount: txOutcome.clearedCellsCount,
        skippedConflictCount: txOutcome.conflicts.length,
        insertedIds: txOutcome.insertedIds,
        conflicts: txOutcome.conflicts,
        summary: txOutcome.summary,
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.post(
  '/shift-assignments',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const shiftId = Number(req.body?.shiftId);
      const workDate = normalizeWorkDateString(req.body?.workDate);

      if (!personId || !shiftId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุบุคลากร กะ และวันที่ปฏิบัติงาน (YYYY-MM-DD)',
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(workDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถเพิ่มตารางเวรในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      const validPersons = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (validPersons.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบรหัสบุคลากรที่เลือกในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const shifts = await dbQuery<ShiftRow>(
        'SELECT * FROM shifts WHERE id = ? AND is_active = 1 LIMIT 1',
        [shiftId]
      );

      if (shifts.length === 0) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบประเภทกะที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      const shift = shifts[0];

      // ตรวจสอบเวรซ้ำหรือเวลาทับซ้อนในวันเดียวกันและวันข้างเคียง
      const evalSingle = await evaluateBulkShiftAssignments(dbQuery, {
        personIds: [personId],
        shift,
        workDates: [workDate],
      });
      const evalItem = evalSingle.items[0];
      if (evalItem && evalItem.status !== 'READY') {
        res.status(409).json({
          error:
            evalItem.status === 'DUPLICATE_SAME_SHIFT'
              ? 'DUPLICATE_SHIFT_ASSIGNMENT'
              : 'TIME_OVERLAP_CONFLICT',
          message:
            evalItem.conflictMessage ||
            'บุคลากรนี้ได้รับมอบหมายกะเดียวกันหรือมีเวลาทับซ้อนในวันที่เลือกไว้แล้ว',
          requestId: req.requestId,
        });
        return;
      }

      const result = await dbExecute(
        `INSERT INTO shift_assignments (
          person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
          snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
          snapshot_is_cross_midnight, status, assigned_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          personId,
          shift.id,
          workDate,
          shift.shift_code,
          shift.shift_name,
          shift.start_time,
          shift.end_time,
          shift.grace_minutes,
          shift.cutoff_time,
          shift.is_cross_midnight,
          req.user!.username,
        ]
      );

      await upsertDailyOverrideRecord(dbExecute, dbQuery, {
        personId,
        workDate,
        overrideState: 'CUSTOM_ASSIGNED',
        reason: `มอบหมายเวร (${shift.shift_code})`,
        actorUsername: req.user!.username,
      });

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_ASSIGNED',
        targetType: 'SHIFT_ASSIGNMENT',
        targetId: String(result.insertId),
        result: 'SUCCESS',
        detail: { personId, shiftId, shiftCode: shift.shift_code, workDate },
      });

      res.status(201).json({
        id: result.insertId,
        personId,
        shiftId,
        workDate,
        shiftCode: shift.shift_code,
        status: 'ACTIVE',
      });
    } catch (err) {
      next(err);
    }
  }
);

shiftsRouter.delete(
  '/shift-assignments/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const assignmentId = Number(req.params.id);
      const cancelReason = String(
        req.body?.cancelReason ||
          req.query.cancelReason ||
          'ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน'
      ).trim();
      const restoreDefault = Boolean(req.body?.restoreDefault);

      const rows = await dbQuery<{
        id: number;
        person_id: string;
        work_date: string;
        snapshot_shift_code: string;
        status: string;
      }>(
        'SELECT id, person_id, work_date, snapshot_shift_code, status FROM shift_assignments WHERE id = ? LIMIT 1',
        [assignmentId]
      );

      if (rows.length === 0) {
        res.status(404).json({
          error: 'ASSIGNMENT_NOT_FOUND',
          message: 'ไม่พบรายการตารางเวรที่ต้องการยกเลิก',
          requestId: req.requestId,
        });
        return;
      }

      const row = rows[0];
      const personId = String(row.person_id).trim();
      const normalizedWorkDate = normalizeWorkDateString(row.work_date);

      const periodLock = await isPeriodClosed(normalizedWorkDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถยกเลิกตารางเวรในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      await dbExecute(
        "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [assignmentId]
      );

      await dbExecute(
        `INSERT INTO shift_cancellation_logs (
          shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [
          assignmentId,
          personId,
          normalizedWorkDate,
          row.snapshot_shift_code,
          cancelReason,
          req.user!.username,
        ]
      );

      // ตรวจว่าในวันนั้นยังมีเวร ACTIVE เหลืออยู่หรือไม่
      const remainingActive = await dbQuery<{ id: number }>(
        "SELECT id FROM shift_assignments WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE'",
        [personId, normalizedWorkDate]
      );
      const nextOverrideState =
        remainingActive.length > 0
          ? 'CUSTOM_ASSIGNED'
          : restoreDefault
            ? 'RESTORED_DEFAULT'
            : 'CLEARED_ALL_SHIFTS';

      await upsertDailyOverrideRecord(dbExecute, dbQuery, {
        personId,
        workDate: normalizedWorkDate,
        overrideState: nextOverrideState,
        reason: cancelReason,
        actorUsername: req.user!.username,
      });

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_ASSIGNMENT_CANCELLED',
        targetType: 'SHIFT_ASSIGNMENT',
        targetId: String(assignmentId),
        result: 'SUCCESS',
        detail: {
          personId,
          workDate: normalizedWorkDate,
          shiftCode: row.snapshot_shift_code,
          cancelReason,
          overrideState: nextOverrideState,
        },
      });

      res.json({
        status: 'CANCELLED',
        id: assignmentId,
        cancelReason,
        overrideState: nextOverrideState,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);
