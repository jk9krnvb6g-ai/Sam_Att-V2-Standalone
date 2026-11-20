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
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  buildXlsxBufferFromRows,
  extractScheduleRecordsFromXlsxBuffer,
  normalizeExcelWorkDate,
  type ParsedScheduleExcelRow,
} from '../../utils/xlsx.ts';

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
}

export type DailyScheduleOverrideState =
  | 'DEFAULT_FROM_TYPE'
  | 'CUSTOM_ASSIGNED'
  | 'CLEARED_ALL_SHIFTS'
  | 'RESTORED_DEFAULT'
  | 'UNCONFIGURED_DEFAULT_RULE';

export interface DailyOverrideRow {
  id?: number;
  person_id: string;
  work_date: string;
  override_state: 'CUSTOM_ASSIGNED' | 'CLEARED_ALL_SHIFTS' | 'RESTORED_DEFAULT';
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

export interface BulkPreviewItem {
  personId: string;
  fullName: string;
  departmentName: string;
  workDate: string;
  status: 'READY' | 'DUPLICATE_SAME_SHIFT' | 'TIME_OVERLAP_CONFLICT';
  conflictCode: string | null;
  conflictMessage: string | null;
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

  // ลำดับความสำคัญที่ 1 & 2: หากผู้จัดเวรตั้งใจลบกะทั้งหมดในวันนั้น (CLEARED_ALL_SHIFTS) -> วันนั้นไม่มีเวร (0 กะ)
  if (params.dailyOverride?.override_state === 'CLEARED_ALL_SHIFTS') {
    return {
      state: 'CLEARED_ALL_SHIFTS',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: null,
    };
  }

  // ลำดับความสำคัญที่ 3: หากมีเวรที่กำหนดเองในวันนั้น (CUSTOM_ASSIGNED) -> ใช้เวรที่กำหนดไว้
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

  // ลำดับความสำคัญที่ 4: หากยังไม่เคยกำหนดเวร หรือกดคืนค่ากะเริ่มต้น -> ใช้กะเช้าเริ่มต้นตามประเภทบุคลากร
  if (!directRule || !isRuleActive) {
    return {
      state: 'UNCONFIGURED_DEFAULT_RULE',
      effectiveShifts: [],
      defaultRule: directRule,
      unconfiguredMessage: `ประเภทบุคลากร (${params.person.personnel_type_name || canonicalTypeCode}) ยังไม่ได้ตั้งค่ากะเริ่มต้นหรือยังไม่ถึงวันที่มีผลบังคับใช้`,
    };
  }

  const startTime = directRule.default_start_time || '08:00';
  const endTime = directRule.default_end_time || '16:00';
  const graceMinutes = Number(directRule.default_grace_minutes ?? 15);
  const cutoffTime = directRule.default_cutoff_time || '11:00';

  return {
    state:
      params.dailyOverride?.override_state === 'RESTORED_DEFAULT'
        ? 'RESTORED_DEFAULT'
        : 'DEFAULT_FROM_TYPE',
    effectiveShifts: [
      {
        isDefaultFromType: true,
        assignmentId: null,
        shiftId: null,
        shiftCode: startTime === '07:30' ? 'MOR-0730' : 'MOR-0816',
        shiftName: `กะเช้าเริ่มต้น (${directRule.personnel_type_name})`,
        startTime,
        endTime,
        graceMinutes,
        cutoffTime,
        isCrossMidnight: endTime <= startTime ? 1 : 0,
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
    overrideState: 'CUSTOM_ASSIGNED' | 'CLEARED_ALL_SHIFTS' | 'RESTORED_DEFAULT';
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

export async function evaluateBulkShiftAssignments(
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  options: {
    personIds: string[];
    shift: ShiftRow;
    workDates: string[];
  }
): Promise<{
  items: BulkPreviewItem[];
  summary: {
    totalRequested: number;
    readyCount: number;
    conflictCount: number;
    duplicateCount: number;
    overlapCount: number;
  };
}> {
  const { personIds, shift, workDates } = options;

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

  for (const rawPersonId of personIds) {
    const personId = String(rawPersonId ?? '').trim();
    const personInfo = personMap.get(personId);
    const fullName = personInfo?.full_name || personId;
    const departmentName = personInfo?.department_name || '-';
    const personExisting = existingByPerson.get(personId) || [];

    for (const workDate of sortedDates) {
      const candidateInterval = computeAbsoluteIntervalMinutes(
        workDate,
        shift.start_time,
        shift.end_time,
        shift.is_cross_midnight
      );

      const sameShiftDup = personExisting.find(
        (ex) => Number(ex.shift_id) === Number(shift.id) && ex.work_date === workDate
      );

      if (sameShiftDup) {
        duplicateCount++;
        items.push({
          personId,
          fullName,
          departmentName,
          workDate,
          status: 'DUPLICATE_SAME_SHIFT',
          conflictCode: 'DUPLICATE_SAME_SHIFT',
          conflictMessage: `มีเวรกะ ${sameShiftDup.snapshot_shift_name} (${sameShiftDup.snapshot_start_time}–${sameShiftDup.snapshot_end_time} น.) ในวันนี้อยู่แล้ว`,
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

      const overlappingEx = personExisting.find((ex) => {
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
          status: 'TIME_OVERLAP_CONFLICT',
          conflictCode: 'TIME_OVERLAP_CONFLICT',
          conflictMessage: `เวลาทับซ้อนกับ ${overlappingEx.snapshot_shift_name} (${overlappingEx.snapshot_start_time}–${overlappingEx.snapshot_end_time} น. วันที่ ${overlappingEx.work_date})`,
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

      readyCount++;
      items.push({
        personId,
        fullName,
        departmentName,
        workDate,
        status: 'READY',
        conflictCode: null,
        conflictMessage: null,
        existingAssignment: null,
      });
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
      const rules = await dbQuery<PersonnelTypeRuleRow>(
        'SELECT * FROM personnel_type_rules ORDER BY id ASC'
      );
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
      const defaultStartTime = String(req.body?.defaultStartTime || '08:00').trim();
      const defaultEndTime = String(req.body?.defaultEndTime || '16:00').trim();
      const defaultGraceMinutes = Number(req.body?.defaultGraceMinutes ?? 15);
      const defaultCutoffTime = String(req.body?.defaultCutoffTime || '11:00').trim();
      const effectiveFrom = normalizeWorkDateString(req.body?.effectiveFrom || '2026-01-01');
      const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : 1;

      if (
        !personnelTypeCode ||
        !personnelTypeName ||
        !/^\d{2}:\d{2}$/.test(defaultStartTime) ||
        !/^\d{2}:\d{2}$/.test(defaultEndTime) ||
        !/^\d{2}:\d{2}$/.test(defaultCutoffTime) ||
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

      const ins = await dbExecute(
        `INSERT INTO personnel_type_rules (
          personnel_type_code, personnel_type_name, default_start_time, default_end_time,
          default_grace_minutes, default_cutoff_time, effective_from, is_active,
          CheckinWindowBeforeMinutes, CheckoutWindowAfterMinutes, require_checkout,
          allow_overlapping_shifts, rule_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 120, 240, 1, 0, 'v2.2.0')`,
        [
          personnelTypeCode,
          personnelTypeName,
          defaultStartTime,
          defaultEndTime,
          defaultGraceMinutes,
          defaultCutoffTime,
          effectiveFrom,
          isActive,
        ]
      );

      await dbExecute(
        `INSERT INTO personnel_type_rule_history (
          rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
          default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?)`,
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
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'PERSONNEL_TYPE_RULE_CREATED',
        targetType: 'PERSONNEL_TYPE_RULE',
        targetId: String(ins.insertId),
        result: 'SUCCESS',
        detail: {
          personnelTypeCode,
          personnelTypeName,
          defaultStartTime,
          defaultEndTime,
          defaultGraceMinutes,
          defaultCutoffTime,
          effectiveFrom,
          isActive,
        },
      });

      res.status(201).json({
        id: ins.insertId,
        personnelTypeCode,
        personnelTypeName,
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
      const personnelTypeName = String(
        req.body?.personnelTypeName || current.personnel_type_name
      ).trim();
      const defaultStartTime = String(
        req.body?.defaultStartTime || current.default_start_time || '08:00'
      ).trim();
      const defaultEndTime = String(
        req.body?.defaultEndTime || current.default_end_time || '16:00'
      ).trim();
      const defaultGraceMinutes =
        req.body?.defaultGraceMinutes !== undefined
          ? Number(req.body.defaultGraceMinutes)
          : Number(current.default_grace_minutes);
      const defaultCutoffTime = String(
        req.body?.defaultCutoffTime || current.default_cutoff_time || '11:00'
      ).trim();
      const effectiveFrom = normalizeWorkDateString(
        req.body?.effectiveFrom || current.effective_from || '2026-01-01'
      );
      const isActive =
        req.body?.isActive !== undefined
          ? req.body.isActive
            ? 1
            : 0
          : Number(current.is_active ?? 1);

      if (
        !personnelTypeName ||
        !/^\d{2}:\d{2}$/.test(defaultStartTime) ||
        !/^\d{2}:\d{2}$/.test(defaultEndTime) ||
        !/^\d{2}:\d{2}$/.test(defaultCutoffTime) ||
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

      await dbExecute(
        `UPDATE personnel_type_rules
         SET personnel_type_name = ?,
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
          defaultStartTime,
          defaultEndTime,
          defaultGraceMinutes,
          defaultCutoffTime,
          effectiveFrom,
          isActive,
          ruleId,
        ]
      );

      await dbExecute(
        `INSERT INTO personnel_type_rule_history (
          rule_id, personnel_type_code, personnel_type_name, default_start_time, default_end_time,
          default_grace_minutes, default_cutoff_time, effective_from, is_active, action_type, changed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'UPDATED', ?)`,
        [
          ruleId,
          current.personnel_type_code,
          personnelTypeName,
          defaultStartTime,
          defaultEndTime,
          defaultGraceMinutes,
          defaultCutoffTime,
          effectiveFrom,
          isActive,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'PERSONNEL_TYPE_RULE_UPDATED',
        targetType: 'PERSONNEL_TYPE_RULE',
        targetId: String(ruleId),
        result: 'SUCCESS',
        detail: {
          personnelTypeCode: current.personnel_type_code,
          previous: {
            defaultStartTime: current.default_start_time,
            defaultEndTime: current.default_end_time,
            defaultGraceMinutes: current.default_grace_minutes,
            defaultCutoffTime: current.default_cutoff_time,
            effectiveFrom: normalizeWorkDateString(current.effective_from),
            isActive: current.is_active,
          },
          updated: {
            personnelTypeName,
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
        personnelTypeCode: current.personnel_type_code,
        personnelTypeName,
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

shiftsRouter.get(
  '/shifts',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const items = await dbQuery('SELECT * FROM shifts ORDER BY id ASC');
      const rules = await dbQuery<PersonnelTypeRuleRow>(
        'SELECT * FROM personnel_type_rules ORDER BY id ASC'
      );
      res.json({
        items,
        personnelTypeRules: rules.map((r) => ({
          ...r,
          effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
        })),
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

      if (
        !shiftCode ||
        !shiftName ||
        !/^\d{2}:\d{2}$/.test(startTime) ||
        !/^\d{2}:\d{2}$/.test(endTime) ||
        !/^\d{2}:\d{2}$/.test(cutoffTime)
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสกะ ชื่อกะ เวลาเริ่ม-สิ้นสุด และเวลาตัดรอบสแกนในรูปแบบ HH:mm',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ id: number }>(
        'SELECT id FROM shifts WHERE shift_code = ? LIMIT 1',
        [shiftCode]
      );
      if (existing.length > 0) {
        res.status(409).json({
          error: 'DUPLICATE_SHIFT_CODE',
          message: `รหัสกะ ${shiftCode} มีอยู่ในระบบแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      const result = await dbExecute(
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

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_CREATED',
        targetType: 'SHIFT',
        targetId: String(result.insertId),
        result: 'SUCCESS',
        detail: {
          shiftCode,
          shiftName,
          startTime,
          endTime,
          graceMinutes,
          cutoffTime,
          isCrossMidnight,
        },
      });

      res.status(201).json({
        id: result.insertId,
        shiftCode,
        shiftName,
        shiftCategory,
        startTime,
        endTime,
        graceMinutes,
        cutoffTime,
        isCrossMidnight,
      });
    } catch (err) {
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

      if (
        !shiftName ||
        !/^\d{2}:\d{2}$/.test(startTime) ||
        !/^\d{2}:\d{2}$/.test(endTime) ||
        !/^\d{2}:\d{2}$/.test(cutoffTime)
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุชื่อกะและเวลาในรูปแบบ HH:mm ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      await dbExecute(
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

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_UPDATED',
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
      });
    } catch (err) {
      next(err);
    }
  }
);

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

      const rawRules = await dbQuery<PersonnelTypeRuleRow>(
        'SELECT * FROM personnel_type_rules ORDER BY id ASC'
      );
      const personnelTypeRules = rawRules.map((r) => ({
        ...r,
        effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
      }));

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

      res.json({
        items,
        dailyOverrides,
        personnelTypeRules,
        cancellationLogs,
        importLogs,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * 4. จัดการเวรรายช่องตารางของบุคลากร 1 คนโดยตรง (Single-Person Quick Cell Action)
 * รองรับ: ADD_SHIFT | REPLACE_SHIFTS | REMOVE_MORNING | REMOVE_AFTERNOON | CLEAR_ALL_SHIFTS | RESTORE_DEFAULT
 */
shiftsRouter.post(
  '/shift-assignments/daily-cell-action',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const workDate = normalizeWorkDateString(req.body?.workDate);
      const action = String(req.body?.action || '').trim().toUpperCase();
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

      // เตรียมรายการ shiftIds กรณี ADD_SHIFT หรือ REPLACE_SHIFTS
      const rawShiftIds: number[] = [];
      if (req.body?.shiftId) {
        rawShiftIds.push(Number(req.body.shiftId));
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
        selectedShifts = await dbQuery<ShiftRow>(
          `SELECT * FROM shifts WHERE id IN (${placeholders}) AND is_active = 1`,
          rawShiftIds
        );
        if (selectedShifts.length !== rawShiftIds.length) {
          res.status(404).json({
            error: 'SHIFT_NOT_FOUND',
            message: 'ไม่พบแม่แบบกะทำงานที่เลือก หรือแม่แบบกะถูกปิดใช้งาน',
            requestId: req.requestId,
          });
          return;
        }

        // ตรวจว่ากะที่เลือกหลายกะในวันเดียวกันทับซ้อนกันเองหรือไม่
        for (let i = 0; i < selectedShifts.length; i++) {
          for (let j = i + 1; j < selectedShifts.length; j++) {
            const intA = computeAbsoluteIntervalMinutes(
              workDate,
              selectedShifts[i].start_time,
              selectedShifts[i].end_time,
              selectedShifts[i].is_cross_midnight
            );
            const intB = computeAbsoluteIntervalMinutes(
              workDate,
              selectedShifts[j].start_time,
              selectedShifts[j].end_time,
              selectedShifts[j].is_cross_midnight
            );
            if (Math.max(intA.startAbsMin, intB.startAbsMin) < Math.min(intA.endAbsMin, intB.endAbsMin)) {
              res.status(409).json({
                error: 'TIME_OVERLAP_CONFLICT',
                message: `กะ ${selectedShifts[i].shift_name} และ ${selectedShifts[j].shift_name} มีช่วงเวลาทับซ้อนกัน`,
                requestId: req.requestId,
              });
              return;
            }
          }
        }
      }

      const prevDate = addDaysToDateString(workDate, -1);
      const nextDate = addDaysToDateString(workDate, 1);

      const txResult = await dbTransaction(async (tx: DbTransactionContext) => {
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
            conflictError: null as { code: string; message: string } | null,
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

        if (action === 'REPLACE_SHIFTS') {
          // ตรวจว่ากะใหม่ทับซ้อนกับเวรข้ามวันของวันข้างเคียงหรือไม่
          for (const s of selectedShifts) {
            const candInt = computeAbsoluteIntervalMinutes(
              workDate,
              s.start_time,
              s.end_time,
              s.is_cross_midnight
            );
            const adjConflict = adjacentDaysActive.find((adj) => {
              const adjInt = computeAbsoluteIntervalMinutes(
                adj.work_date,
                adj.snapshot_start_time,
                adj.snapshot_end_time,
                adj.snapshot_is_cross_midnight
              );
              return (
                Math.max(candInt.startAbsMin, adjInt.startAbsMin) <
                Math.min(candInt.endAbsMin, adjInt.endAbsMin)
              );
            });
            if (adjConflict) {
              return {
                overrideState: 'CUSTOM_ASSIGNED' as const,
                cancelledCount: 0,
                insertedCount: 0,
                conflictError: {
                  code: 'TIME_OVERLAP_CONFLICT',
                  message: `เวลาทับซ้อนกับเวรข้ามวัน ${adjConflict.snapshot_shift_name} (${adjConflict.snapshot_start_time}–${adjConflict.snapshot_end_time} น. วันที่ ${adjConflict.work_date})`,
                },
              };
            }
          }

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

        // ADD_SHIFT: เพิ่มกะโดยเก็บเวรที่มีอยู่แล้วในวันนั้น (ตรวจซ้ำและเวลาทับซ้อน)
        for (const s of selectedShifts) {
          const sameDup = sameDayActive.find((ex) => Number(ex.shift_id) === Number(s.id));
          if (sameDup) {
            return {
              overrideState: 'CUSTOM_ASSIGNED' as const,
              cancelledCount: 0,
              insertedCount: 0,
              conflictError: {
                code: 'DUPLICATE_SAME_SHIFT',
                message: `บุคลากรมีเวร ${sameDup.snapshot_shift_name} ในวันที่ ${workDate} อยู่แล้ว`,
              },
            };
          }

          const candInt = computeAbsoluteIntervalMinutes(
            workDate,
            s.start_time,
            s.end_time,
            s.is_cross_midnight
          );
          const overlapEx = normalizedNearby.find((ex) => {
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

          if (overlapEx) {
            return {
              overrideState: 'CUSTOM_ASSIGNED' as const,
              cancelledCount: 0,
              insertedCount: 0,
              conflictError: {
                code: 'TIME_OVERLAP_CONFLICT',
                message: `เวลาทับซ้อนกับ ${overlapEx.snapshot_shift_name} (${overlapEx.snapshot_start_time}–${overlapEx.snapshot_end_time} น. วันที่ ${overlapEx.work_date})`,
              },
            };
          }
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
          cancelledCount: 0,
          insertedCount,
          conflictError: null,
        };
      });

      if (txResult.conflictError) {
        res.status(409).json({
          error: txResult.conflictError.code,
          message: txResult.conflictError.message,
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
          overrideState: txResult.overrideState,
          cancelledCount: txResult.cancelledCount,
          insertedCount: txResult.insertedCount,
          reason,
        },
      });

      const [updatedAssignments, updatedOverrides, allTypeRules] = await Promise.all([
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
        dbQuery<PersonnelTypeRuleRow>('SELECT * FROM personnel_type_rules ORDER BY id ASC'),
      ]);

      const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
      for (const r of allTypeRules) {
        rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), r);
      }

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
        REPLACE_SHIFTS: 'เปลี่ยนกะทำงานรายวันเรียบร้อยแล้ว',
        ADD_SHIFT: 'เพิ่มกะทำงานรายวันเรียบร้อยแล้ว',
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

shiftsRouter.post(
  '/shift-assignments/bulk-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const rawPersonIds: unknown[] = Array.isArray(req.body?.personIds) ? req.body.personIds : [];
      const rawWorkDates: unknown[] = Array.isArray(req.body?.workDates) ? req.body.workDates : [];
      const shiftId = Number(req.body?.shiftId);

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

      if (personIds.length === 0 || workDates.length === 0 || !shiftId) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน กะทำงาน และวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
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
          message: 'ไม่พบแม่แบบกะทำงานที่เลือก หรือแม่แบบกะนี้ถูกปิดใช้งาน',
          requestId: req.requestId,
        });
        return;
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

      const shift = shifts[0];
      const evaluation = await evaluateBulkShiftAssignments(dbQuery, {
        personIds,
        shift,
        workDates,
      });

      res.json({
        requestId: req.requestId,
        shiftSnapshot: {
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          shiftName: shift.shift_name,
          startTime: shift.start_time,
          endTime: shift.end_time,
          graceMinutes: shift.grace_minutes,
          cutoffTime: shift.cutoff_time,
          isCrossMidnight: Number(shift.is_cross_midnight),
        },
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
      const shiftId = Number(req.body?.shiftId);
      const conflictStrategy =
        req.body?.conflictStrategy === 'ABORT_ON_CONFLICT'
          ? 'ABORT_ON_CONFLICT'
          : 'SKIP_CONFLICTS';

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

      if (personIds.length === 0 || workDates.length === 0 || !shiftId) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน กะทำงาน และวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
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
          message: 'ไม่พบแม่แบบกะทำงานที่เลือก หรือแม่แบบกะนี้ถูกปิดใช้งาน',
          requestId: req.requestId,
        });
        return;
      }

      const shift = shifts[0];

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
          shift,
          workDates,
        });

        const conflicts = evaluation.items.filter((item) => item.status !== 'READY');
        const readyItems = evaluation.items.filter((item) => item.status === 'READY');

        if (conflictStrategy === 'ABORT_ON_CONFLICT' && conflicts.length > 0) {
          return {
            abortedDueToConflict: true,
            insertedIds: [] as number[],
            readyItems,
            conflicts,
            summary: evaluation.summary,
          };
        }

        const insertedIds: number[] = [];
        for (const item of readyItems) {
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
            reason: `มอบหมายเวรแบบกลุ่ม (${shift.shift_code})`,
            actorUsername: req.user!.username,
          });
        }

        return {
          abortedDueToConflict: false,
          insertedIds,
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

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_BULK_ASSIGNED',
        targetType: 'SHIFT_ASSIGNMENT',
        targetId: (txOutcome.insertedIds.join(',') || 'NONE').slice(0, 120),
        result: 'SUCCESS',
        detail: {
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          conflictStrategy,
          totalRequested: txOutcome.summary.totalRequested,
          insertedCount: txOutcome.insertedIds.length,
          skippedConflictCount: txOutcome.conflicts.length,
          personIds,
          workDates,
        },
      });

      res.status(201).json({
        status: 'SUCCESS',
        requestId: req.requestId,
        shiftSnapshot: {
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          shiftName: shift.shift_name,
          startTime: shift.start_time,
          endTime: shift.end_time,
          graceMinutes: shift.grace_minutes,
          cutoffTime: shift.cutoff_time,
          isCrossMidnight: Number(shift.is_cross_midnight),
        },
        insertedCount: txOutcome.insertedIds.length,
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
