/**
 * ============================================================================
 * ไฟล์: backend/src/modules/attendance/processor.ts
 * หน้าที่: เครื่องมือประมวลผลและคำนวณเวลาปฏิบัติงาน (Attendance Reprocess Engine)
 * ============================================================================
 * กฎธุรกิจสำคัญ (ATT-01 ถึง ATT-16):
 * 1. ห้ามแก้ไขหรือลบข้อมูลในตาราง `raw_scans` เด็ดขาด (Immutable Raw Scans)
 * 2. ใช้ Global Multi-Shift Matching Engine (`matchingEngine.ts`) ประเมินทุกกะของบุคลากรร่วมกัน
 *    - เรียง Raw Scan ตาม `(canonical_bkk_time ASC, id ASC)` (ATT-02, TC-29)
 *    - ห้ามใช้ Raw Scan ID ซ้ำเกิน 1 บทบาท และบันทึกหลักฐานลง `attendance_raw_scan_usage` (ATT-03, ATT-09)
 *    - รองรับกะต่อเนื่องห่างกัน 1 นาทีโดยใช้สแกนคนละรายการ (ATT-04, ATT-05)
 *    - ใช้สแกนแรกที่เหมาะสมเป็น IN และสแกนแรกที่เหมาะสมเป็น OUT หลังจัดสรรทุกกะแล้ว (ATT-06, ATT-07)
 *    - กรณีสแกนเดียวทับซ้อนระหว่าง OUT กะแรกกับ IN กะถัดไป ให้จัดเป็น IN กะถัดไปก่อนโดยไม่ใช้ซ้ำ (ATT-16)
 *    - คำนวณออกก่อนเวลา (`early_checkout_indicator`, `early_checkout_minutes`) แยกจากสถานะความครบถ้วน (ATT-10, ATT-12, ATT-14)
 *    - รองรับการลาครึ่งวัน (`attendance_leaves`) โดยไม่แก้ไขแม่แบบกะทำงาน (ATT-15)
 * 3. การรัน Reprocess ซ้ำ (ATT-13):
 *    - รักษา `attendance_notes`, `hr_review_history`, `review_reason`, `reviewed_by`, `reviewed_at` เดิมไว้ครบถ้วน
 *    - หากผลจับคู่เปลี่ยนแปลงบนรายการที่เคยตรวจสอบแล้วหรือมีหมายเหตุ จะเปลี่ยน `review_status` เป็น `NEEDS_RE_REVIEW`
 *      และทำเครื่องหมาย `needs_re_review = 1` บนหมายเหตุ พร้อมบันทึกประวัติลง `attendance_matching_history`
 * ============================================================================
 */

import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  normalizeWorkDateString,
  resolveEffectiveDailyScheduleForPersonDate,
  computeAbsoluteIntervalMinutes,
  loadPersonnelTypeRulesWithDefaultShifts,
  loadActivePublicHolidaysMap,
  isFullDayPersonalHolidayLeaveType,
  type DailyOverrideRow,
  type ExistingAssignmentRow,
  type PersonnelTypeRuleRow,
} from '../shifts/routes.ts';
import {
  addDaysYmd,
  matchPersonShiftsGlobally,
  type AttendanceCompletenessStatus,
  type LegacyAttendanceStatus,
  type MatchingLeaveInput,
  type MatchingRawScanInput,
  type MatchingShiftInput,
  type MatchedShiftOutcome,
} from './matchingEngine.ts';

export const ATTENDANCE_RULE_VERSION = 'v2.3.0-global-match-bkk';

export interface ReprocessOptions {
  dateFrom: string; // YYYY-MM-DD
  dateTo: string;   // YYYY-MM-DD
  personId?: string;
  referenceNowBkk?: string; // YYYY-MM-DD HH:mm:ss (defaults to current Asia/Bangkok time)
  actorUsername: string;
  actorRole?: string;
  requestId?: string;
  ipAddress?: string;
}

export interface CalculatedShiftAttendance {
  personId: string;
  workDate: string;
  shiftAssignmentId: number | null;
  shiftCode: string | null;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  evaluatedStartTime: string | null;
  evaluatedEndTime: string | null;
  cutoffTimestamp: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  checkInRawScanId: number | null;
  checkOutRawScanId: number | null;
  status: LegacyAttendanceStatus;
  attendanceStatus: AttendanceCompletenessStatus;
  secondaryFlags: string | null;
  isLate: number;
  lateMinutes: number;
  earlyCheckoutIndicator: number;
  earlyCheckoutMinutes: number;
  matchingRule: string;
  leaveId: number | null;
  leaveType: string | null;
  leaveStartTime: string | null;
  leaveEndTime: string | null;
}

const BKK_TIMESTAMP_FORMATTER = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function getBangkokNowString(): string {
  return BKK_TIMESTAMP_FORMATTER.format(new Date());
}

/**
 * แปลงค่า Timestamp (Date / ISO / 'YYYY-MM-DD HH:mm:ss') ให้เป็นรูปแบบมาตรฐานเขตเวลา Asia/Bangkok ('YYYY-MM-DD HH:mm:ss')
 * ป้องกันปัญหา Date object จาก MySQL2 หรือรูปแบบที่มีตัวคั่น 'T' ทำให้เปรียบเทียบวันที่/เวลาคลาดเคลื่อน
 */
export function normalizeBkkTimestamp(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? '' : BKK_TIMESTAMP_FORMATTER.format(raw);
  }
  const str = String(raw).trim();
  if (!str) return '';
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(str)) {
    const parsed = new Date(str);
    if (!Number.isNaN(parsed.getTime())) {
      return BKK_TIMESTAMP_FORMATTER.format(parsed);
    }
  }
  const match = /^(\d{4}-\d{2}-\d{2})[T\s]+(\d{2}:\d{2})(?::(\d{2}))?/.exec(str);
  if (match) {
    return `${match[1]} ${match[2]}:${match[3] || '00'}`;
  }
  return str.replace('T', ' ').slice(0, 19);
}

function normalizeNullableBkkTimestamp(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const normalized = normalizeBkkTimestamp(raw);
  return normalized ? normalized : null;
}

export async function getHalfDayPreCheckinWindowMinutes(): Promise<number> {
  try {
    const rows = await dbQuery<{ setting_value: string }>(
      "SELECT setting_value FROM attendance_settings WHERE setting_key = 'half_day_pre_checkin_window_minutes' LIMIT 1"
    );
    if (rows.length > 0) {
      const parsed = Number(rows[0].setting_value);
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 240) {
        return Math.round(parsed);
      }
    }
  } catch {
    // Fallback to 60 minutes if settings table is not yet initialized
  }
  return 60;
}

interface NormalizedFingerprintMappingRow {
  id?: number;
  person_id: string;
  fingle_id: string;
  effective_from: string;
  effective_to: string | null;
  conflict_state: string;
}

function evaluateScanMappingAgainstRows(
  enrollNumber: string,
  scanDateYmd: string,
  normalizedMappings: NormalizedFingerprintMappingRow[]
): {
  state: 'MATCHED' | 'UNMATCHED' | 'CONFLICT';
  personId: string | null;
  ruleNote: string;
} {
  const trimmedEnroll = String(enrollNumber || '').trim();
  const matchingRows = normalizedMappings.filter((m) => {
    if (m.fingle_id !== trimmedEnroll) return false;
    if (m.effective_from > scanDateYmd) return false;
    if (m.effective_to && m.effective_to < scanDateYmd) return false;
    return true;
  });

  if (matchingRows.length === 1 && matchingRows[0].conflict_state === 'NONE') {
    return {
      state: 'MATCHED',
      personId: matchingRows[0].person_id,
      ruleNote: `Matched via fingerprint_mappings (${matchingRows[0].effective_from})`,
    };
  }
  if (
    matchingRows.length > 1 ||
    (matchingRows.length === 1 && matchingRows[0].conflict_state !== 'NONE')
  ) {
    return {
      state: 'CONFLICT',
      personId: null,
      ruleNote: 'Duplicate or conflicting FINGLE_ID mapping in effective range',
    };
  }
  return {
    state: 'UNMATCHED',
    personId: null,
    ruleNote: 'No active fingerprint_mapping found for enroll_number on scan date',
  };
}

async function loadNormalizedFingerprintMappings(): Promise<NormalizedFingerprintMappingRow[]> {
  const rawMappings = await dbQuery<{
    id?: number;
    person_id: string;
    fingle_id: string;
    effective_from: unknown;
    effective_to: unknown;
    conflict_state: string;
  }>('SELECT id, person_id, fingle_id, effective_from, effective_to, conflict_state FROM fingerprint_mappings');

  return rawMappings
    .map((m) => ({
      id: m.id,
      person_id: String(m.person_id ?? '').trim(),
      fingle_id: String(m.fingle_id ?? '').trim(),
      effective_from: normalizeWorkDateString(m.effective_from),
      effective_to:
        m.effective_to !== null && m.effective_to !== undefined && String(m.effective_to).trim() !== ''
          ? normalizeWorkDateString(m.effective_to)
          : null,
      conflict_state: String(m.conflict_state || 'NONE').trim().toUpperCase(),
    }))
    .filter((m) => Boolean(m.person_id && m.fingle_id && m.effective_from));
}

/**
 * จับคู่ข้อมูลสแกนดิบ (raw_scans) เข้ากับบุคลากรผ่านตาราง fingerprint_mappings ตามช่วงวันที่ที่มีผล
 * กฎสำคัญ:
 * - ห้ามแก้ไขตาราง raw_scans เด็ดขาด บันทึกผลการจับคู่ลง raw_scan_mappings เท่านั้น
 * - ใช้การ Normalize วันที่แบบ Asia/Bangkok (YYYY-MM-DD) ทั้งฝั่ง scanDate และ effective_from/effective_to
 *   เพื่อไม่ให้เกิดปัญหา Timezone Shift (เช่น สแกนวันที่ 17 ไปจับคู่ effective_from วันที่ 18)
 */
export async function resolveRawScanPersonnelMappings(
  dateFrom: string,
  dateTo: string,
  options?: { fingleId?: string }
): Promise<{
  totalEvaluated: number;
  newlyMatched: number;
  matchedCount: number;
  unmatchedCount: number;
  conflictCount: number;
}> {
  const extendedStart = addDaysYmd(normalizeWorkDateString(dateFrom), -1);
  const extendedEnd = addDaysYmd(normalizeWorkDateString(dateTo), 2);
  const scanParams: unknown[] = [`${extendedStart} 00:00:00`, `${extendedEnd} 23:59:59`];
  let fingleClause = '';
  if (options?.fingleId) {
    fingleClause = ' AND TRIM(rs.enroll_number) = ?';
    scanParams.push(String(options.fingleId).trim());
  }

  const scans = await dbQuery<{
    id: number;
    event_dedup_key: string;
    enroll_number: string;
    canonical_bkk_time: unknown;
    matched_person_id: string | null;
    mapping_state: string | null;
  }>(
    `SELECT rs.id, rs.event_dedup_key, rs.enroll_number, rs.canonical_bkk_time,
            rsm.matched_person_id, rsm.mapping_state
     FROM raw_scans rs
     LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
     WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?${fingleClause}
     ORDER BY rs.canonical_bkk_time ASC, rs.id ASC`,
    scanParams
  );

  const normalizedMappings = await loadNormalizedFingerprintMappings();

  let newlyMatched = 0;
  let matchedCount = 0;
  let unmatchedCount = 0;
  let conflictCount = 0;

  async function upsertDerivedMapping(
    rawScanId: number,
    dedupKey: string,
    enrollNumber: string,
    matchedPersonId: string | null,
    mappingState: 'MATCHED' | 'UNMATCHED' | 'CONFLICT',
    ruleNote: string
  ) {
    const existing = await dbQuery<{ raw_scan_id: number }>(
      'SELECT raw_scan_id FROM raw_scan_mappings WHERE raw_scan_id = ? LIMIT 1',
      [rawScanId]
    );
    if (existing.length === 0) {
      await dbExecute(
        `INSERT INTO raw_scan_mappings (
          raw_scan_id, event_dedup_key, enroll_number, matched_person_id, mapping_state, mapping_rule_note, resolved_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [rawScanId, dedupKey, enrollNumber, matchedPersonId, mappingState, ruleNote]
      );
    } else {
      await dbExecute(
        `UPDATE raw_scan_mappings
         SET matched_person_id = ?, mapping_state = ?, mapping_rule_note = ?, resolved_at = CURRENT_TIMESTAMP
         WHERE raw_scan_id = ?`,
        [matchedPersonId, mappingState, ruleNote, rawScanId]
      );
    }
  }

  for (const scan of scans) {
    const scanBkkTs = normalizeBkkTimestamp(scan.canonical_bkk_time);
    const scanDate = scanBkkTs.slice(0, 10);
    const trimmedEnroll = String(scan.enroll_number ?? '').trim();
    const outcome = evaluateScanMappingAgainstRows(trimmedEnroll, scanDate, normalizedMappings);

    if (outcome.state === 'MATCHED' && outcome.personId) {
      matchedCount++;
      const currentPersonId = scan.matched_person_id ? String(scan.matched_person_id).trim() : null;
      if (currentPersonId !== outcome.personId || scan.mapping_state !== 'MATCHED') {
        await upsertDerivedMapping(
          Number(scan.id),
          scan.event_dedup_key,
          trimmedEnroll,
          outcome.personId,
          'MATCHED',
          outcome.ruleNote
        );
        newlyMatched++;
      }
    } else if (outcome.state === 'CONFLICT') {
      conflictCount++;
      if (scan.mapping_state !== 'CONFLICT' || scan.matched_person_id !== null) {
        await upsertDerivedMapping(
          Number(scan.id),
          scan.event_dedup_key,
          trimmedEnroll,
          null,
          'CONFLICT',
          outcome.ruleNote
        );
      }
    } else {
      unmatchedCount++;
      if (scan.mapping_state !== 'UNMATCHED' || scan.matched_person_id !== null) {
        await upsertDerivedMapping(
          Number(scan.id),
          scan.event_dedup_key,
          trimmedEnroll,
          null,
          'UNMATCHED',
          outcome.ruleNote
        );
      }
    }
  }

  return {
    totalEvaluated: scans.length,
    newlyMatched,
    matchedCount,
    unmatchedCount,
    conflictCount,
  };
}

/**
 * จำลองผลการจับคู่ Raw Scan กับบุคลากรในหน่วยความจำเท่านั้น (Read-Only สำหรับ Preview ห้ามเขียนลง DB)
 */
async function resolveRawScanMappingsInMemory(
  dateFrom: string,
  dateTo: string
): Promise<Map<number, string>> {
  const extendedStart = addDaysYmd(normalizeWorkDateString(dateFrom), -1);
  const extendedEnd = addDaysYmd(normalizeWorkDateString(dateTo), 2);
  const scans = await dbQuery<{
    id: number;
    enroll_number: string;
    canonical_bkk_time: unknown;
  }>(
    `SELECT id, enroll_number, canonical_bkk_time
     FROM raw_scans
     WHERE canonical_bkk_time >= ? AND canonical_bkk_time <= ?
     ORDER BY canonical_bkk_time ASC, id ASC`,
    [`${extendedStart} 00:00:00`, `${extendedEnd} 23:59:59`]
  );
  const normalizedMappings = await loadNormalizedFingerprintMappings();
  const matchedMap = new Map<number, string>();
  for (const scan of scans) {
    const scanDate = normalizeBkkTimestamp(scan.canonical_bkk_time).slice(0, 10);
    const outcome = evaluateScanMappingAgainstRows(scan.enroll_number, scanDate, normalizedMappings);
    if (outcome.state === 'MATCHED' && outcome.personId) {
      matchedMap.set(Number(scan.id), outcome.personId);
    }
  }
  return matchedMap;
}

function buildDateRangeList(dateFrom: string, dateTo: string): string[] {
  const start = normalizeWorkDateString(dateFrom);
  const end = normalizeWorkDateString(dateTo);
  const out: string[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 420) {
    out.push(cur);
    cur = addDaysYmd(cur, 1);
    guard++;
  }
  return out;
}

/**
 * Pure deterministic calculation of attendance rows for a date range using the
 * Global Multi-Shift Matching Engine (ATT-01..ATT-16).
 *
 * Evaluates shifts across [dateFrom - 1 .. dateTo + 1] together with all raw scans
 * in [dateFrom - 1 00:00:00 .. dateTo + 2 23:59:59] so cross-midnight boundary shifts
 * never reuse scans, then returns only outcomes whose workDate lies in [dateFrom .. dateTo].
 */
export async function computeAttendanceOutcomes(
  options: ReprocessOptions,
  overrides?: { inMemoryMatchedPersonByScanId?: Map<number, string> }
): Promise<CalculatedShiftAttendance[]> {
  const nowBkk = normalizeBkkTimestamp(options.referenceNowBkk || getBangkokNowString());
  const halfDayPreCheckinWindowMinutes = await getHalfDayPreCheckinWindowMinutes();

  const evalDateFrom = addDaysYmd(options.dateFrom, -1);
  const evalDateTo = addDaysYmd(options.dateTo, 1);
  const prevDayBeforeEval = addDaysYmd(evalDateFrom, -1);

  const assignmentParams: unknown[] = [prevDayBeforeEval, evalDateTo];
  let personClause = '';
  if (options.personId) {
    personClause = ' AND sa.person_id = ?';
    assignmentParams.push(options.personId);
  }

  const rawAssignments = await dbQuery<{
    id: number;
    person_id: string;
    shift_id: number;
    work_date: string;
    snapshot_shift_code: string;
    snapshot_shift_name: string;
    snapshot_start_time: string;
    snapshot_end_time: string;
    snapshot_grace_minutes: number;
    snapshot_cutoff_time: string;
    snapshot_is_cross_midnight: number;
    mapping_status: string;
    checkin_window_before_min: number | null;
    checkin_window_after_min: number | null;
    checkout_window_before_min: number | null;
    checkout_window_after_min: number | null;
  }>(
    `SELECT sa.id, sa.person_id, sa.shift_id, sa.work_date,
            sa.snapshot_shift_code, sa.snapshot_shift_name,
            sa.snapshot_start_time, sa.snapshot_end_time,
            sa.snapshot_grace_minutes, sa.snapshot_cutoff_time,
            sa.snapshot_is_cross_midnight,
            p.mapping_status,
            s.checkin_window_before_min,
            s.checkin_window_after_min,
            s.checkout_window_before_min,
            s.checkout_window_after_min
     FROM shift_assignments sa
     INNER JOIN personnel p ON p.person_id = sa.person_id
     LEFT JOIN shifts s ON s.id = sa.shift_id
     WHERE sa.status = 'ACTIVE'
       AND sa.work_date >= ? AND sa.work_date <= ?${personClause}
     ORDER BY sa.work_date ASC, sa.snapshot_start_time ASC, sa.id ASC`,
    assignmentParams
  );

  const personnelParams: unknown[] = [];
  let personnelWhere = 'WHERE is_active = 1';
  if (options.personId) {
    personnelWhere += ' AND person_id = ?';
    personnelParams.push(options.personId);
  }
  const activePersonnel = await dbQuery<{
    person_id: string;
    personnel_type_code: string;
    personnel_type_name: string;
    mapping_status: string;
  }>(
    `SELECT person_id, personnel_type_code, personnel_type_name, mapping_status
     FROM personnel
     ${personnelWhere}
     ORDER BY person_id ASC`,
    personnelParams
  );

  const rawOverrides = await dbQuery<DailyOverrideRow>(
    `SELECT * FROM shift_daily_overrides WHERE work_date >= ? AND work_date <= ?`,
    [evalDateFrom, evalDateTo]
  );
  const overridesByPersonDate = new Map<string, DailyOverrideRow>();
  for (const ov of rawOverrides) {
    const pid = String(ov.person_id ?? '').trim();
    const wDate = normalizeWorkDateString(ov.work_date);
    overridesByPersonDate.set(`${pid}:${wDate}`, {
      ...ov,
      person_id: pid,
      work_date: wDate,
    });
  }

  const rawRules = await loadPersonnelTypeRulesWithDefaultShifts();
  const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
  for (const r of rawRules) {
    rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), {
      ...r,
      effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
    });
  }

  const assignmentWindowById = new Map<
    number,
    {
      inBefore: number;
      inAfter: number;
      outBefore: number;
      outAfter: number;
    }
  >();

  const assignmentsByPersonDate = new Map<string, ExistingAssignmentRow[]>();
  for (const sa of rawAssignments) {
    const pid = String(sa.person_id ?? '').trim();
    const wDate = normalizeWorkDateString(sa.work_date);
    const key = `${pid}:${wDate}`;
    const list = assignmentsByPersonDate.get(key) || [];
    list.push({
      id: sa.id,
      person_id: pid,
      shift_id: sa.shift_id,
      work_date: wDate,
      snapshot_shift_code: sa.snapshot_shift_code,
      snapshot_shift_name: sa.snapshot_shift_name,
      snapshot_start_time: sa.snapshot_start_time,
      snapshot_end_time: sa.snapshot_end_time,
      snapshot_grace_minutes: sa.snapshot_grace_minutes,
      snapshot_cutoff_time: sa.snapshot_cutoff_time,
      snapshot_is_cross_midnight: sa.snapshot_is_cross_midnight,
      status: 'ACTIVE',
    });
    assignmentsByPersonDate.set(key, list);

    assignmentWindowById.set(sa.id, {
      inBefore: Number(sa.checkin_window_before_min ?? 120),
      inAfter: Number(sa.checkin_window_after_min ?? 240),
      outBefore: Number(sa.checkout_window_before_min ?? 180),
      outAfter: Number(sa.checkout_window_after_min ?? 240),
    });
  }

  // Load official public holidays and active leaves BEFORE resolving daily schedules (4-Step Priority Order)
  const publicHolidayMap = await loadActivePublicHolidaysMap(evalDateFrom, evalDateTo);

  const leaveParams: unknown[] = [evalDateFrom, evalDateTo];
  let leavePersonClause = '';
  if (options.personId) {
    leavePersonClause = ' AND person_id = ?';
    leaveParams.push(options.personId);
  }
  let rawLeaves: Array<{
    id: number;
    person_id: string;
    work_date: string;
    shift_assignment_id: number | null;
    leave_type: string;
    leave_start_time: string;
    leave_end_time: string;
    reason: string | null;
  }> = [];
  try {
    rawLeaves = await dbQuery(
      `SELECT id, person_id, work_date, shift_assignment_id, leave_type, leave_start_time, leave_end_time, reason
       FROM attendance_leaves
       WHERE status = 'ACTIVE'
         AND work_date >= ? AND work_date <= ?${leavePersonClause}
       ORDER BY id ASC`,
      leaveParams
    );
  } catch {
    rawLeaves = [];
  }

  const leavesByPerson = new Map<string, MatchingLeaveInput[]>();
  const personalHolidayByPersonDate = new Map<string, { label?: string | null; reason?: string | null }>();
  for (const lv of rawLeaves) {
    const pid = String(lv.person_id || '').trim();
    const wDate = normalizeWorkDateString(lv.work_date);
    const list = leavesByPerson.get(pid) || [];
    list.push({
      id: Number(lv.id),
      personId: pid,
      workDate: wDate,
      shiftAssignmentId: lv.shift_assignment_id !== null ? Number(lv.shift_assignment_id) : null,
      leaveType: lv.leave_type,
      leaveStartTime: lv.leave_start_time,
      leaveEndTime: lv.leave_end_time,
      reason: lv.reason,
    });
    leavesByPerson.set(pid, list);

    if (isFullDayPersonalHolidayLeaveType(lv.leave_type)) {
      personalHolidayByPersonDate.set(`${pid}:${wDate}`, {
        label: lv.reason || lv.leave_type,
        reason: lv.reason,
      });
    }
  }

  // Construct effective shift inputs across [evalDateFrom .. evalDateTo] per person
  const dateList = buildDateRangeList(evalDateFrom, evalDateTo);
  const shiftsByPerson = new Map<string, MatchingShiftInput[]>();

  for (const workDate of dateList) {
    const dayPublicHoliday = publicHolidayMap.get(workDate) || null;
    for (const person of activePersonnel) {
      const pid = String(person.person_id ?? '').trim();
      const key = `${pid}:${workDate}`;
      const dayAssignments = assignmentsByPersonDate.get(key) || [];
      const dayOverride = overridesByPersonDate.get(key) || null;
      const dayPersonalHoliday = personalHolidayByPersonDate.get(key) || null;

      const resolved = resolveEffectiveDailyScheduleForPersonDate({
        person,
        workDate,
        activeAssignments: dayAssignments,
        dailyOverride: dayOverride,
        rulesByCode,
        publicHoliday: dayPublicHoliday,
        personalHoliday: dayPersonalHoliday,
      });

      if (
        resolved.state === 'CLEARED_ALL_SHIFTS' ||
        resolved.state === 'PUBLIC_HOLIDAY' ||
        resolved.state === 'PERSONAL_HOLIDAY' ||
        resolved.state === 'NON_WORKING_DAY' ||
        resolved.state === 'UNCONFIGURED_DEFAULT_RULE'
      ) {
        continue;
      }

      const typeRule =
        resolved.defaultRule ||
        rulesByCode.get(String(person.personnel_type_code || '').trim().toUpperCase());

      for (const eff of resolved.effectiveShifts) {
        if (eff.isDefaultFromType) {
          if (person.mapping_status !== 'VALID' && resolved.state !== 'RESTORED_DEFAULT') {
            continue;
          }
          const prevDate = addDaysYmd(workDate, -1);
          const prevDayList = assignmentsByPersonDate.get(`${pid}:${prevDate}`) || [];
          const candInt = computeAbsoluteIntervalMinutes(
            workDate,
            eff.startTime,
            eff.endTime,
            eff.isCrossMidnight
          );
          const overlapsPrevCross = prevDayList.some((prevShift) => {
            const prevInt = computeAbsoluteIntervalMinutes(
              prevShift.work_date,
              prevShift.snapshot_start_time,
              prevShift.snapshot_end_time,
              prevShift.snapshot_is_cross_midnight
            );
            return (
              Math.max(candInt.startAbsMin, prevInt.startAbsMin) <
              Math.min(candInt.endAbsMin, prevInt.endAbsMin)
            );
          });
          if (overlapsPrevCross) {
            continue;
          }
        }

        const win =
          eff.assignmentId !== null ? assignmentWindowById.get(eff.assignmentId) : undefined;
        const checkinWindowBeforeMin =
          win?.inBefore ?? Number((typeRule as any)?.CheckinWindowBeforeMinutes ?? 120);
        const checkinWindowAfterMin = win?.inAfter ?? 240;
        const checkoutWindowBeforeMin = win?.outBefore ?? 180;
        const checkoutWindowAfterMin =
          win?.outAfter ?? Number((typeRule as any)?.CheckoutWindowAfterMinutes ?? 240);

        const list = shiftsByPerson.get(pid) || [];
        list.push({
          personId: pid,
          workDate,
          shiftAssignmentId: eff.assignmentId,
          shiftCode: eff.shiftCode,
          shiftName: eff.shiftName,
          startTime: eff.startTime,
          endTime: eff.endTime,
          graceMinutes: Number(eff.graceMinutes ?? 0),
          cutoffTime: eff.cutoffTime,
          isCrossMidnight: Number(eff.isCrossMidnight ?? 0),
          mappingStatus: person.mapping_status,
          checkinWindowBeforeMin,
          checkinWindowAfterMin,
          checkoutWindowBeforeMin,
          checkoutWindowAfterMin,
        });
        shiftsByPerson.set(pid, list);
      }
    }
  }

  // Load all raw scans across [evalDateFrom 00:00:00 .. dateTo + 2 23:59:59] sorted by (canonical_bkk_time ASC, id ASC) (ATT-02, TC-29)
  const scanWindowStart = `${evalDateFrom} 00:00:00`;
  const scanWindowEnd = `${addDaysYmd(options.dateTo, 2)} 23:59:59`;
  const scanParams: unknown[] = [scanWindowStart, scanWindowEnd];
  let scanPersonClause = '';
  if (options.personId) {
    scanPersonClause = ' AND rsm.matched_person_id = ?';
    scanParams.push(options.personId);
  }

  const scansByPerson = new Map<string, MatchingRawScanInput[]>();

  if (overrides?.inMemoryMatchedPersonByScanId) {
    const rawScans = await dbQuery<{
      id: number;
      canonical_bkk_time: unknown;
      in_out_mode: number;
    }>(
      `SELECT id, canonical_bkk_time, in_out_mode
       FROM raw_scans
       WHERE canonical_bkk_time >= ? AND canonical_bkk_time <= ?
       ORDER BY canonical_bkk_time ASC, id ASC`,
      [scanWindowStart, scanWindowEnd]
    );

    const targetPersonId = options.personId ? String(options.personId).trim() : null;
    for (const s of rawScans) {
      const pid = overrides.inMemoryMatchedPersonByScanId.get(Number(s.id));
      if (!pid) continue;
      if (targetPersonId && pid !== targetPersonId) continue;
      const canonicalBkkTime = normalizeBkkTimestamp(s.canonical_bkk_time);
      if (!canonicalBkkTime) continue;
      const list = scansByPerson.get(pid) || [];
      list.push({
        id: Number(s.id),
        personId: pid,
        canonicalBkkTime,
        inOutMode: Number(s.in_out_mode),
      });
      scansByPerson.set(pid, list);
    }
  } else {
    const rawScans = await dbQuery<{
      id: number;
      matched_person_id: string | null;
      canonical_bkk_time: unknown;
      in_out_mode: number;
    }>(
      `SELECT rs.id, rsm.matched_person_id, rs.canonical_bkk_time, rs.in_out_mode
       FROM raw_scans rs
       INNER JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
       WHERE rsm.mapping_state = 'MATCHED'
         AND rsm.matched_person_id IS NOT NULL
         AND rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?${scanPersonClause}
       ORDER BY rs.canonical_bkk_time ASC, rs.id ASC`,
      scanParams
    );

    for (const s of rawScans) {
      const pid = String(s.matched_person_id || '').trim();
      if (!pid) continue;
      const canonicalBkkTime = normalizeBkkTimestamp(s.canonical_bkk_time);
      if (!canonicalBkkTime) continue;
      const list = scansByPerson.get(pid) || [];
      list.push({
        id: Number(s.id),
        personId: pid,
        canonicalBkkTime,
        inOutMode: Number(s.in_out_mode),
      });
      scansByPerson.set(pid, list);
    }
  }

  // Active leaves were loaded above before daily schedule resolution and mapped into leavesByPerson.

  // Run Global Multi-Shift Matching per person
  const results: CalculatedShiftAttendance[] = [];
  for (const [personId, personShifts] of shiftsByPerson.entries()) {
    const personScans = scansByPerson.get(personId) || [];
    const personLeaves = leavesByPerson.get(personId) || [];

    const matchResult = matchPersonShiftsGlobally({
      shifts: personShifts,
      rawScans: personScans,
      leaves: personLeaves,
      config: {
        referenceNowBkk: nowBkk,
        halfDayPreCheckinWindowMinutes,
      },
    });

    for (const outcome of matchResult.outcomes) {
      if (outcome.workDate >= options.dateFrom && outcome.workDate <= options.dateTo) {
        results.push(mapOutcomeToCalculated(outcome));
      }
    }
  }

  results.sort(
    (a, b) =>
      a.workDate.localeCompare(b.workDate) ||
      a.personId.localeCompare(b.personId) ||
      String(a.scheduledStart || '').localeCompare(String(b.scheduledStart || ''))
  );

  return results;
}

function mapOutcomeToCalculated(o: MatchedShiftOutcome): CalculatedShiftAttendance {
  return {
    personId: o.personId,
    workDate: o.workDate,
    shiftAssignmentId: o.shiftAssignmentId,
    shiftCode: o.shiftCode,
    shiftName: o.shiftName,
    scheduledStart: o.scheduledStart,
    scheduledEnd: o.scheduledEnd,
    evaluatedStartTime: o.evaluatedStartTime,
    evaluatedEndTime: o.evaluatedEndTime,
    cutoffTimestamp: o.cutoffTimestamp,
    checkInTime: o.checkInTime,
    checkOutTime: o.checkOutTime,
    checkInRawScanId: o.checkInRawScanId,
    checkOutRawScanId: o.checkOutRawScanId,
    status: o.status,
    attendanceStatus: o.attendanceStatus,
    secondaryFlags: o.secondaryFlags,
    isLate: o.isLate,
    lateMinutes: o.lateMinutes,
    earlyCheckoutIndicator: o.earlyCheckoutIndicator,
    earlyCheckoutMinutes: o.earlyCheckoutMinutes,
    matchingRule: o.matchingRule,
    leaveId: o.leaveId,
    leaveType: o.leaveType,
    leaveStartTime: o.leaveStartTime,
    leaveEndTime: o.leaveEndTime,
  };
}

function hasMaterialAttendanceChange(
  prev: {
    status: string;
    attendance_status?: string | null;
    check_in_time: unknown;
    check_out_time: unknown;
    check_in_raw_scan_id: number | null;
    check_out_raw_scan_id: number | null;
    late_minutes: number;
    early_checkout_minutes?: number | null;
    evaluated_start_time?: unknown;
    evaluated_end_time?: unknown;
  },
  next: CalculatedShiftAttendance
): boolean {
  const prevInId =
    prev.check_in_raw_scan_id !== null && prev.check_in_raw_scan_id !== undefined
      ? Number(prev.check_in_raw_scan_id)
      : null;
  const prevOutId =
    prev.check_out_raw_scan_id !== null && prev.check_out_raw_scan_id !== undefined
      ? Number(prev.check_out_raw_scan_id)
      : null;
  const prevAttStatus =
    prev.attendance_status ||
    (prev.status === 'NORMAL' || prev.status === 'LATE' ? 'COMPLETE' : prev.status);

  return (
    prev.status !== next.status ||
    prevAttStatus !== next.attendanceStatus ||
    prevInId !== next.checkInRawScanId ||
    prevOutId !== next.checkOutRawScanId ||
    normalizeNullableBkkTimestamp(prev.check_in_time) !== normalizeNullableBkkTimestamp(next.checkInTime) ||
    normalizeNullableBkkTimestamp(prev.check_out_time) !== normalizeNullableBkkTimestamp(next.checkOutTime) ||
    Number(prev.late_minutes || 0) !== Number(next.lateMinutes || 0) ||
    Number(prev.early_checkout_minutes || 0) !== Number(next.earlyCheckoutMinutes || 0) ||
    normalizeNullableBkkTimestamp(prev.evaluated_start_time) !==
      normalizeNullableBkkTimestamp(next.evaluatedStartTime) ||
    normalizeNullableBkkTimestamp(prev.evaluated_end_time) !==
      normalizeNullableBkkTimestamp(next.evaluatedEndTime)
  );
}

/**
 * พรีวิวผลการ Reprocess แบบ Read-Only (ไม่แก้ไข raw_scan_mappings, attendance หรือตารางใดๆ)
 */
export async function previewReprocessRange(options: ReprocessOptions) {
  const inMemoryMatchedPersonByScanId = await resolveRawScanMappingsInMemory(
    options.dateFrom,
    options.dateTo
  );
  const projected = await computeAttendanceOutcomes(options, {
    inMemoryMatchedPersonByScanId,
  });

  const existingParams: unknown[] = [options.dateFrom, options.dateTo];
  let personClause = '';
  if (options.personId) {
    personClause = ' AND person_id = ?';
    existingParams.push(options.personId);
  }

  const existing = await dbQuery<{
    id: number;
    person_id: string;
    work_date: string;
    shift_assignment_id: number | null;
    shift_code: string | null;
    status: string;
    attendance_status: string | null;
    late_minutes: number;
    early_checkout_minutes: number | null;
    check_in_time: string | null;
    check_out_time: string | null;
    check_in_raw_scan_id: number | null;
    check_out_raw_scan_id: number | null;
    evaluated_start_time: string | null;
    evaluated_end_time: string | null;
    review_status: string;
  }>(
    `SELECT id, person_id, work_date, shift_assignment_id, shift_code, status, attendance_status,
            late_minutes, early_checkout_minutes, check_in_time, check_out_time,
            check_in_raw_scan_id, check_out_raw_scan_id, evaluated_start_time, evaluated_end_time, review_status
     FROM attendance
     WHERE work_date >= ? AND work_date <= ?${personClause}`,
    existingParams
  );

  let changedCount = 0;
  let newRecordsCount = 0;
  let unchangedCount = 0;
  let willFlagReReviewCount = 0;
  const diffs: Array<{
    personId: string;
    workDate: string;
    shiftCode: string | null;
    previousStatus: string | null;
    newStatus: string;
    previousAttendanceStatus: string | null;
    newAttendanceStatus: string;
    previousLateMinutes: number | null;
    newLateMinutes: number;
    previousEarlyCheckoutMinutes: number | null;
    newEarlyCheckoutMinutes: number;
    willFlagReReview: boolean;
  }> = [];

  for (const item of projected) {
    const match = existing.find(
      (e) =>
        String(e.person_id).trim() === item.personId &&
        normalizeWorkDateString(e.work_date) === item.workDate &&
        (item.shiftAssignmentId !== null
          ? Number(e.shift_assignment_id) === Number(item.shiftAssignmentId)
          : e.shift_assignment_id === null && e.shift_code === item.shiftCode)
    );
    if (!match) {
      newRecordsCount++;
      diffs.push({
        personId: item.personId,
        workDate: item.workDate,
        shiftCode: item.shiftCode,
        previousStatus: null,
        newStatus: item.status,
        previousAttendanceStatus: null,
        newAttendanceStatus: item.attendanceStatus,
        previousLateMinutes: null,
        newLateMinutes: item.lateMinutes,
        previousEarlyCheckoutMinutes: null,
        newEarlyCheckoutMinutes: item.earlyCheckoutMinutes,
        willFlagReReview: false,
      });
    } else if (hasMaterialAttendanceChange(match, item)) {
      changedCount++;
      const willFlagReReview =
        match.review_status === 'REVIEWED' || match.review_status === 'VERIFIED_APPROVED';
      if (willFlagReReview) willFlagReReviewCount++;
      diffs.push({
        personId: item.personId,
        workDate: item.workDate,
        shiftCode: item.shiftCode,
        previousStatus: match.status,
        newStatus: item.status,
        previousAttendanceStatus: match.attendance_status,
        newAttendanceStatus: item.attendanceStatus,
        previousLateMinutes: Number(match.late_minutes),
        newLateMinutes: item.lateMinutes,
        previousEarlyCheckoutMinutes: Number(match.early_checkout_minutes || 0),
        newEarlyCheckoutMinutes: item.earlyCheckoutMinutes,
        willFlagReReview,
      });
    } else {
      unchangedCount++;
    }
  }

  return {
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    ruleVersion: ATTENDANCE_RULE_VERSION,
    totalEvaluated: projected.length,
    newRecordsCount,
    changedCount,
    unchangedCount,
    willFlagReReviewCount,
    diffs,
  };
}

/**
 * Executes idempotent Attendance Reprocess without mutating raw_scans:
 * - Persists global matching results and enforces DB-level scan anti-reuse via attendance_raw_scan_usage (ATT-03)
 * - Preserves attendance_notes, hr_review_history, review_reason, reviewed_by, reviewed_at (ATT-13)
 * - Flags NEEDS_RE_REVIEW + attendance_notes.needs_re_review = 1 and records attendance_matching_history
 *   when material matching results change on previously reviewed / noted shifts (ATT-13, TC-26)
 */
let reprocessExecutionQueue: Promise<unknown> = Promise.resolve();

export function reprocessAttendanceRange(options: ReprocessOptions) {
  const run = reprocessExecutionQueue.then(() => runReprocessAttendanceRangeInternal(options));
  reprocessExecutionQueue = run.catch(() => undefined);
  return run;
}

async function runReprocessAttendanceRangeInternal(options: ReprocessOptions) {
  const mappingStats = await resolveRawScanPersonnelMappings(options.dateFrom, options.dateTo);
  const projected = await computeAttendanceOutcomes(options);

  let insertedCount = 0;
  let updatedCount = 0;
  let changedCount = 0;
  let unchangedCount = 0;
  let reReviewFlaggedCount = 0;
  const keptAttendanceIds = new Set<number>();
  const pendingUsageRows: Array<{
    rawScanId: number;
    attendanceId: number;
    personId: string;
    workDate: string;
    shiftAssignmentId: number | null;
    shiftCode: string | null;
    usageRole: 'CHECK_IN' | 'CHECK_OUT';
  }> = [];

  for (const item of projected) {
    const existing =
      item.shiftAssignmentId !== null
        ? await dbQuery<{
            id: number;
            review_status: string;
            status: string;
            attendance_status: string | null;
            check_in_time: string | null;
            check_out_time: string | null;
            check_in_raw_scan_id: number | null;
            check_out_raw_scan_id: number | null;
            late_minutes: number;
            early_checkout_minutes: number | null;
            evaluated_start_time: string | null;
            evaluated_end_time: string | null;
          }>(
            `SELECT id, review_status, status, attendance_status,
                    check_in_time, check_out_time, check_in_raw_scan_id, check_out_raw_scan_id,
                    late_minutes, early_checkout_minutes, evaluated_start_time, evaluated_end_time
             FROM attendance
             WHERE person_id = ? AND work_date = ? AND shift_assignment_id = ? LIMIT 1`,
            [item.personId, item.workDate, item.shiftAssignmentId]
          )
        : await dbQuery<{
            id: number;
            review_status: string;
            status: string;
            attendance_status: string | null;
            check_in_time: string | null;
            check_out_time: string | null;
            check_in_raw_scan_id: number | null;
            check_out_raw_scan_id: number | null;
            late_minutes: number;
            early_checkout_minutes: number | null;
            evaluated_start_time: string | null;
            evaluated_end_time: string | null;
          }>(
            `SELECT id, review_status, status, attendance_status,
                    check_in_time, check_out_time, check_in_raw_scan_id, check_out_raw_scan_id,
                    late_minutes, early_checkout_minutes, evaluated_start_time, evaluated_end_time
             FROM attendance
             WHERE person_id = ? AND work_date = ? AND shift_assignment_id IS NULL AND shift_code = ? LIMIT 1`,
            [item.personId, item.workDate, item.shiftCode]
          );

    let attendanceId: number;

    if (existing.length === 0) {
      const ins = await dbExecute(
        `INSERT INTO attendance (
          person_id, work_date, shift_assignment_id, shift_code, shift_name,
          scheduled_start, scheduled_end, evaluated_start_time, evaluated_end_time, cutoff_timestamp,
          check_in_time, check_out_time, check_in_raw_scan_id, check_out_raw_scan_id,
          status, attendance_status, secondary_flags, is_late, late_minutes,
          early_checkout_indicator, early_checkout_minutes,
          review_status, rule_version, matching_rule, processed_at,
          leave_id, leave_type, leave_start_time, leave_end_time
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)`,
        [
          item.personId,
          item.workDate,
          item.shiftAssignmentId,
          item.shiftCode,
          item.shiftName,
          item.scheduledStart,
          item.scheduledEnd,
          item.evaluatedStartTime,
          item.evaluatedEndTime,
          item.cutoffTimestamp,
          item.checkInTime,
          item.checkOutTime,
          item.checkInRawScanId,
          item.checkOutRawScanId,
          item.status,
          item.attendanceStatus,
          item.secondaryFlags,
          item.isLate,
          item.lateMinutes,
          item.earlyCheckoutIndicator,
          item.earlyCheckoutMinutes,
          ATTENDANCE_RULE_VERSION,
          item.matchingRule,
          item.leaveId,
          item.leaveType,
          item.leaveStartTime,
          item.leaveEndTime,
        ]
      );
      attendanceId = Number(ins.insertId || 0);
      if (attendanceId) keptAttendanceIds.add(attendanceId);
      insertedCount++;
    } else {
      const prev = existing[0];
      attendanceId = Number(prev.id);
      keptAttendanceIds.add(attendanceId);

      const changed = hasMaterialAttendanceChange(prev, item);
      let nextReviewStatus = prev.review_status;

      if (changed) {
        changedCount++;
        const existingNotes = await dbQuery<{ id: number }>(
          'SELECT id FROM attendance_notes WHERE attendance_id = ? LIMIT 1',
          [attendanceId]
        );
        const wasReviewedOrNoted =
          prev.review_status === 'REVIEWED' ||
          prev.review_status === 'VERIFIED_APPROVED' ||
          existingNotes.length > 0;

        if (wasReviewedOrNoted) {
          nextReviewStatus = 'NEEDS_RE_REVIEW';
          reReviewFlaggedCount++;
          if (existingNotes.length > 0) {
            await dbExecute(
              'UPDATE attendance_notes SET needs_re_review = 1 WHERE attendance_id = ?',
              [attendanceId]
            );
          }
        }

        await dbExecute(
          `INSERT INTO attendance_matching_history (
            attendance_id, person_id, work_date, shift_assignment_id,
            previous_check_in_raw_scan_id, new_check_in_raw_scan_id,
            previous_check_out_raw_scan_id, new_check_out_raw_scan_id,
            previous_status, new_status,
            previous_attendance_status, new_attendance_status,
            previous_late_minutes, new_late_minutes,
            previous_early_checkout_minutes, new_early_checkout_minutes,
            previous_review_status, new_review_status,
            matching_rule, change_reason, rule_version, triggered_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            attendanceId,
            item.personId,
            item.workDate,
            item.shiftAssignmentId,
            prev.check_in_raw_scan_id,
            item.checkInRawScanId,
            prev.check_out_raw_scan_id,
            item.checkOutRawScanId,
            prev.status,
            item.status,
            prev.attendance_status,
            item.attendanceStatus,
            Number(prev.late_minutes || 0),
            item.lateMinutes,
            Number(prev.early_checkout_minutes || 0),
            item.earlyCheckoutMinutes,
            prev.review_status,
            nextReviewStatus,
            item.matchingRule,
            wasReviewedOrNoted
              ? 'REPROCESS_CHANGED_REVIEWED_OR_NOTED_SHIFT'
              : 'REPROCESS_MATCHING_UPDATED',
            ATTENDANCE_RULE_VERSION,
            options.actorUsername,
          ]
        );
      } else {
        unchangedCount++;
      }

      await dbExecute(
        `UPDATE attendance
         SET shift_code = ?, shift_name = ?, scheduled_start = ?, scheduled_end = ?,
             evaluated_start_time = ?, evaluated_end_time = ?, cutoff_timestamp = ?,
             check_in_time = ?, check_out_time = ?,
             check_in_raw_scan_id = ?, check_out_raw_scan_id = ?,
             status = ?, attendance_status = ?, secondary_flags = ?,
             is_late = ?, late_minutes = ?,
             early_checkout_indicator = ?, early_checkout_minutes = ?,
             review_status = ?, rule_version = ?, matching_rule = ?,
             leave_id = ?, leave_type = ?, leave_start_time = ?, leave_end_time = ?,
             calculated_at = CURRENT_TIMESTAMP, processed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          item.shiftCode,
          item.shiftName,
          item.scheduledStart,
          item.scheduledEnd,
          item.evaluatedStartTime,
          item.evaluatedEndTime,
          item.cutoffTimestamp,
          item.checkInTime,
          item.checkOutTime,
          item.checkInRawScanId,
          item.checkOutRawScanId,
          item.status,
          item.attendanceStatus,
          item.secondaryFlags,
          item.isLate,
          item.lateMinutes,
          item.earlyCheckoutIndicator,
          item.earlyCheckoutMinutes,
          nextReviewStatus,
          ATTENDANCE_RULE_VERSION,
          item.matchingRule,
          item.leaveId,
          item.leaveType,
          item.leaveStartTime,
          item.leaveEndTime,
          attendanceId,
        ]
      );
      updatedCount++;
    }

    if (attendanceId) {
      if (item.checkInRawScanId !== null) {
        pendingUsageRows.push({
          rawScanId: item.checkInRawScanId,
          attendanceId,
          personId: item.personId,
          workDate: item.workDate,
          shiftAssignmentId: item.shiftAssignmentId,
          shiftCode: item.shiftCode,
          usageRole: 'CHECK_IN',
        });
      }
      if (item.checkOutRawScanId !== null) {
        pendingUsageRows.push({
          rawScanId: item.checkOutRawScanId,
          attendanceId,
          personId: item.personId,
          workDate: item.workDate,
          shiftAssignmentId: item.shiftAssignmentId,
          shiftCode: item.shiftCode,
          usageRole: 'CHECK_OUT',
        });
      }
    }
  }

  // Synchronize attendance_raw_scan_usage for the reprocessed scope (ATT-03 DB-level anti-reuse)
  const existingInRange = await dbQuery<{
    id: number;
    person_id: string;
    review_status: string;
  }>(
    `SELECT id, person_id, review_status FROM attendance
     WHERE work_date >= ? AND work_date <= ?${options.personId ? ' AND person_id = ?' : ''}`,
    options.personId
      ? [options.dateFrom, options.dateTo, options.personId]
      : [options.dateFrom, options.dateTo]
  );

  const inRangeAttendanceIds = new Set<number>(existingInRange.map((r) => Number(r.id)));
  for (const id of keptAttendanceIds) {
    inRangeAttendanceIds.add(id);
  }

  // Clear previous usage rows belonging to attendance records in this reprocessed range
  for (const attId of inRangeAttendanceIds) {
    await dbExecute('DELETE FROM attendance_raw_scan_usage WHERE attendance_id = ?', [attId]);
  }

  // Insert new usage rows; PRIMARY KEY (raw_scan_id) strictly blocks any duplicate reuse within the reprocessed set
  const insertedScanIdsThisRun = new Set<number>();
  for (const u of pendingUsageRows) {
    if (insertedScanIdsThisRun.has(u.rawScanId)) {
      throw new Error(
        `ATT03_SCAN_REUSE_VIOLATION: raw_scan_id=${u.rawScanId} attempted reuse across shifts`
      );
    }
    // If an outside-range stale record held this scan before global boundary correction, release stale claim first
    const staleClaim = await dbQuery<{ attendance_id: number }>(
      'SELECT attendance_id FROM attendance_raw_scan_usage WHERE raw_scan_id = ? LIMIT 1',
      [u.rawScanId]
    );
    if (staleClaim.length > 0 && !keptAttendanceIds.has(Number(staleClaim[0].attendance_id))) {
      await dbExecute('DELETE FROM attendance_raw_scan_usage WHERE raw_scan_id = ?', [u.rawScanId]);
    }
    await dbExecute(
      `INSERT INTO attendance_raw_scan_usage (
        raw_scan_id, attendance_id, person_id, work_date, shift_assignment_id, shift_code, usage_role
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        u.rawScanId,
        u.attendanceId,
        u.personId,
        u.workDate,
        u.shiftAssignmentId,
        u.shiftCode,
        u.usageRole,
      ]
    );
    insertedScanIdsThisRun.add(u.rawScanId);
  }

  // Delete obsolete PENDING attendance rows with no notes/reviews if their shift was removed or cleared
  for (const row of existingInRange) {
    const rowId = Number(row.id);
    if (!keptAttendanceIds.has(rowId) && row.review_status === 'PENDING') {
      const notes = await dbQuery<{ id: number }>(
        'SELECT id FROM attendance_notes WHERE attendance_id = ? LIMIT 1',
        [rowId]
      );
      const reviews = await dbQuery<{ id: number }>(
        'SELECT id FROM hr_review_history WHERE attendance_id = ? LIMIT 1',
        [rowId]
      );
      if (notes.length === 0 && reviews.length === 0) {
        await dbExecute('DELETE FROM attendance_raw_scan_usage WHERE attendance_id = ?', [rowId]);
        await dbExecute('DELETE FROM attendance_matching_history WHERE attendance_id = ?', [rowId]);
        await dbExecute('DELETE FROM attendance WHERE id = ?', [rowId]);
      }
    }
  }

  const earlyCheckoutCount = projected.filter((p) => p.earlyCheckoutIndicator === 1).length;
  const missingCheckinCount = projected.filter((p) => p.attendanceStatus === 'MISSING_CHECKIN').length;
  const usageRowsCount = insertedScanIdsThisRun.size;

  await writeAuditLog({
    requestId: options.requestId || 'reprocess-internal',
    actorUsername: options.actorUsername,
    actorRole: options.actorRole || 'SYSTEM',
    ipAddress: options.ipAddress || '127.0.0.1',
    action: 'ATTENDANCE_REPROCESS',
    targetType: 'ATTENDANCE_RANGE',
    targetId: `${options.dateFrom}..${options.dateTo}`,
    result: 'SUCCESS',
    detail: {
      dateFrom: options.dateFrom,
      dateTo: options.dateTo,
      insertedCount,
      updatedCount,
      changedCount,
      unchangedCount,
      reReviewFlaggedCount,
      earlyCheckoutCount,
      missingCheckinCount,
      usageRowsCount,
      mappingStats,
      ruleVersion: ATTENDANCE_RULE_VERSION,
    },
  });

  return {
    dateFrom: options.dateFrom,
    dateTo: options.dateTo,
    ruleVersion: ATTENDANCE_RULE_VERSION,
    totalProcessed: projected.length,
    insertedCount,
    updatedCount,
    changedCount,
    unchangedCount,
    reReviewFlaggedCount,
    earlyCheckoutCount,
    missingCheckinCount,
    usageRowsCount,
    mappingStats,
  };
}
