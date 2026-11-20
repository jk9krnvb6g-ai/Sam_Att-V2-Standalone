/**
 * ============================================================================
 * ไฟล์: backend/src/modules/attendance/processor.ts
 * หน้าที่: เครื่องมือประมวลผลและคำนวณเวลาปฏิบัติงาน (Attendance Reprocess Engine)
 * ============================================================================
 * กฎธุรกิจสำคัญ (Core Business Rules):
 * 1. ห้ามแก้ไขตาราง `raw_scans` เด็ดขาด (Immutable Raw Scans) การคำนวณจะอ่านจาก `raw_scans`
 *    แล้วบันทึกลงตาราง `processed_attendance_days` เท่านั้น
 * 2. การเรียงลำดับเวลาสแกน (Chronological Deduplication):
 *    - นำเวลาสแกนทั้งหมดของบุคลากรในวันนั้นมาเรียงจากน้อยไปมาก
 *    - ตัดสแกนซ้ำที่ห่างกันไม่เกิน `duplicate_scan_threshold_seconds` (เช่น 120 วินาที) ออก
 *    - สแกนแรกสุด = เวลาเข้างาน (First Check-In)
 *    - สแกนสุดท้าย (เมื่อมีสแกนมากกว่า 1 ครั้งหลังจากตัดสแกนซ้ำ) = เวลาออกงาน (Last Check-Out)
 *    - หากมีสแกนเพียงครั้งเดียวและเลยเวลาเลิกกะแล้ว จะได้สถานะ `MISSING_CHECKOUT` (ลืมสแกนออก)
 * 3. การคำนวณมาสาย (Late Calculation):
 *    - เปรียบเทียบเวลาเข้างานกับจุดตัดสาย (`late_after_time`) ตามประเภทบุคลากรและกะงาน
 *    - ข้าราชการ/พกส. กะเช้า จุดตัดสาย 08:15 น. | ลูกจ้างรายวัน/รายเดือน จุดตัดสาย 07:30 น.
 * 4. การรักษาข้อมูลที่ HR ตรวจสอบแล้ว (Preserve Manual Override):
 *    - เมื่อสั่ง Reprocess ใหม่ ระบบจะไม่เขียนทับรายการที่ HR ทำ Manual Override (`is_manual_override = 1`)
 *      และจะคงสถานะการตรวจรับรองของ HR (`hr_review_status`) ไว้เสมอ
 * ============================================================================
 */

import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { writeAuditLog } from '../audit/service.ts';

export const ATTENDANCE_RULE_VERSION = 'v2.1.0-tz-bkk';

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
  cutoffTimestamp: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  checkInRawScanId: number | null;
  checkOutRawScanId: number | null;
  status: 'NORMAL' | 'LATE' | 'NO_SCAN' | 'MISSING_CHECKOUT' | 'NO_SCHEDULE' | 'PENDING_MAPPING';
  secondaryFlags: string | null;
  isLate: number;
  lateMinutes: number;
}

export function getBangkokNowString(): string {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return formatter.format(new Date());
}

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function toEpochMinutes(bkkTimestamp: string): number {
  // Format: YYYY-MM-DD HH:mm(:ss)
  const [datePart, timePart] = bkkTimestamp.trim().split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm] = timePart.split(':').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, 0) / 60000);
}

function fromEpochMinutes(epochMinutes: number): string {
  const dt = new Date(epochMinutes * 60000);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

/**
 * จับคู่ข้อมูลสแกนดิบ (raw_scans) เข้ากับบุคลากรผ่านตาราง fingerprint_mappings ตามช่วงวันที่ที่มีผล (effective_from..effective_to)
 * กฎสำคัญ (P1 ข้อ 08): ห้ามแก้ไขตาราง raw_scans เด็ดขาด! ผลการจับคู่ทั้งหมดจะถูกบันทึกลงตาราง Derived Mapping (raw_scan_mappings) เท่านั้น
 */
export async function resolveRawScanPersonnelMappings(dateFrom: string, dateTo: string): Promise<{
  newlyMatched: number;
  unmatchedCount: number;
  conflictCount: number;
}> {
  const extendedEnd = addDays(dateTo, 1);
  const scans = await dbQuery<{
    id: number;
    event_dedup_key: string;
    enroll_number: string;
    canonical_bkk_time: string;
    matched_person_id: string | null;
    mapping_state: string | null;
  }>(
    `SELECT rs.id, rs.event_dedup_key, rs.enroll_number, rs.canonical_bkk_time,
            rsm.matched_person_id, rsm.mapping_state
     FROM raw_scans rs
     LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
     WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?`,
    [`${dateFrom} 00:00:00`, `${extendedEnd} 23:59:59`]
  );

  const mappings = await dbQuery<{
    person_id: string;
    fingle_id: string;
    effective_from: string;
    effective_to: string | null;
    conflict_state: string;
  }>('SELECT person_id, fingle_id, effective_from, effective_to, conflict_state FROM fingerprint_mappings');

  let newlyMatched = 0;
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
    const scanDate = scan.canonical_bkk_time.slice(0, 10);
    const matchingRows = mappings.filter((m) => {
      if (m.fingle_id !== scan.enroll_number) return false;
      if (m.effective_from > scanDate) return false;
      if (m.effective_to && m.effective_to < scanDate) return false;
      return true;
    });

    if (matchingRows.length === 1 && matchingRows[0].conflict_state === 'NONE') {
      const targetPersonId = matchingRows[0].person_id;
      if (scan.matched_person_id !== targetPersonId || scan.mapping_state !== 'MATCHED') {
        await upsertDerivedMapping(
          scan.id,
          scan.event_dedup_key,
          scan.enroll_number,
          targetPersonId,
          'MATCHED',
          `Matched via fingerprint_mappings (${matchingRows[0].effective_from})`
        );
        newlyMatched++;
      }
    } else if (matchingRows.length > 1 || (matchingRows.length === 1 && matchingRows[0].conflict_state !== 'NONE')) {
      conflictCount++;
      if (scan.mapping_state !== 'CONFLICT') {
        await upsertDerivedMapping(
          scan.id,
          scan.event_dedup_key,
          scan.enroll_number,
          null,
          'CONFLICT',
          'Duplicate or conflicting FINGLE_ID mapping in effective range'
        );
      }
    } else {
      unmatchedCount++;
      if (scan.mapping_state !== 'UNMATCHED') {
        await upsertDerivedMapping(
          scan.id,
          scan.event_dedup_key,
          scan.enroll_number,
          null,
          'UNMATCHED',
          'No active fingerprint_mapping found for enroll_number on scan date'
        );
      }
    }
  }

  return { newlyMatched, unmatchedCount, conflictCount };
}

import {
  normalizeWorkDateString,
  resolveEffectiveDailyScheduleForPersonDate,
  computeAbsoluteIntervalMinutes,
  type DailyOverrideRow,
  type ExistingAssignmentRow,
  type PersonnelTypeRuleRow,
} from '../shifts/routes.ts';

function buildDateRangeList(dateFrom: string, dateTo: string): string[] {
  const start = normalizeWorkDateString(dateFrom);
  const end = normalizeWorkDateString(dateTo);
  const out: string[] = [];
  let cur = start;
  let guard = 0;
  while (cur <= end && guard < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
    guard++;
  }
  return out;
}

/**
 * Pure deterministic calculation of attendance rows for a date range.
 * Enforces the 5-step Shift Priority Order (Section 5.4):
 * 1. Check daily override & shift assignments for (person, date)
 * 2. If custom shifts assigned -> evaluate assigned shifts
 * 3. If CLEARED_ALL_SHIFTS -> 0 shifts (never reverts to default shift)
 * 4. If DEFAULT_FROM_TYPE or RESTORED_DEFAULT -> evaluate default morning shift from personnel_type_rules
 * 5. Prevent time overlap with cross-midnight shifts from previous day
 */
export async function computeAttendanceOutcomes(
  options: ReprocessOptions
): Promise<CalculatedShiftAttendance[]> {
  const nowBkk = options.referenceNowBkk || getBangkokNowString();
  const nowMin = toEpochMinutes(nowBkk);

  const prevDayBeforeRange = addDays(options.dateFrom, -1);
  const assignmentParams: unknown[] = [prevDayBeforeRange, options.dateTo];
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
  }>(
    `SELECT sa.id, sa.person_id, sa.shift_id, sa.work_date,
            sa.snapshot_shift_code, sa.snapshot_shift_name,
            sa.snapshot_start_time, sa.snapshot_end_time,
            sa.snapshot_grace_minutes, sa.snapshot_cutoff_time,
            sa.snapshot_is_cross_midnight,
            p.mapping_status
     FROM shift_assignments sa
     INNER JOIN personnel p ON p.person_id = sa.person_id
     WHERE sa.status = 'ACTIVE'
       AND sa.work_date >= ? AND sa.work_date <= ?${personClause}
     ORDER BY sa.work_date ASC, sa.snapshot_start_time ASC`,
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
    [options.dateFrom, options.dateTo]
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

  const rawRules = await dbQuery<PersonnelTypeRuleRow>(
    'SELECT * FROM personnel_type_rules ORDER BY id ASC'
  );
  const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
  for (const r of rawRules) {
    rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), {
      ...r,
      effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
    });
  }

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
  }

  // Construct effective shift items across all dates in [dateFrom, dateTo]
  const dateList = buildDateRangeList(options.dateFrom, options.dateTo);
  const effectiveEvaluatedShifts: Array<{
    id: number | null;
    person_id: string;
    work_date: string;
    snapshot_shift_code: string;
    snapshot_shift_name: string;
    snapshot_start_time: string;
    snapshot_end_time: string;
    snapshot_grace_minutes: number;
    snapshot_cutoff_time: string;
    snapshot_is_cross_midnight: number;
    mapping_status: string;
  }> = [];

  for (const workDate of dateList) {
    for (const person of activePersonnel) {
      const pid = String(person.person_id ?? '').trim();
      const key = `${pid}:${workDate}`;
      const dayAssignments = assignmentsByPersonDate.get(key) || [];
      const dayOverride = overridesByPersonDate.get(key) || null;

      const resolved = resolveEffectiveDailyScheduleForPersonDate({
        person,
        workDate,
        activeAssignments: dayAssignments,
        dailyOverride: dayOverride,
        rulesByCode,
      });

      if (
        resolved.state === 'CLEARED_ALL_SHIFTS' ||
        resolved.state === 'UNCONFIGURED_DEFAULT_RULE'
      ) {
        continue;
      }

      for (const eff of resolved.effectiveShifts) {
        if (eff.isDefaultFromType) {
          // For synthesized default shifts, skip if person has invalid mapping status (unless explicitly restored)
          if (person.mapping_status !== 'VALID' && resolved.state !== 'RESTORED_DEFAULT') {
            continue;
          }
          // Check time overlap against previous day's cross-midnight shift
          const prevDate = addDays(workDate, -1);
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

        effectiveEvaluatedShifts.push({
          id: eff.assignmentId,
          person_id: pid,
          work_date: workDate,
          snapshot_shift_code: eff.shiftCode,
          snapshot_shift_name: eff.shiftName,
          snapshot_start_time: eff.startTime,
          snapshot_end_time: eff.endTime,
          snapshot_grace_minutes: eff.graceMinutes,
          snapshot_cutoff_time: eff.cutoffTime,
          snapshot_is_cross_midnight: eff.isCrossMidnight,
          mapping_status: person.mapping_status,
        });
      }
    }
  }

  const extendedEnd = addDays(options.dateTo, 1);
  const rawScans = await dbQuery<{
    id: number;
    matched_person_id: string | null;
    canonical_bkk_time: string;
    in_out_mode: number;
    mapping_state: string;
  }>(
    `SELECT rs.id, rsm.matched_person_id, rs.canonical_bkk_time, rs.in_out_mode,
            COALESCE(rsm.mapping_state, 'UNMATCHED') AS mapping_state
     FROM raw_scans rs
     LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
     WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?
     ORDER BY rs.canonical_bkk_time ASC`,
    [`${options.dateFrom} 00:00:00`, `${extendedEnd} 23:59:59`]
  );

  const results: CalculatedShiftAttendance[] = [];

  for (const sa of effectiveEvaluatedShifts) {
    const startTs = `${sa.work_date} ${sa.snapshot_start_time}:00`;
    const isCross =
      Number(sa.snapshot_is_cross_midnight) === 1 || sa.snapshot_end_time <= sa.snapshot_start_time;
    const endDay = isCross ? addDays(sa.work_date, 1) : sa.work_date;
    const endTs = `${endDay} ${sa.snapshot_end_time}:00`;

    const cutoffDay =
      sa.snapshot_cutoff_time < sa.snapshot_start_time ? addDays(sa.work_date, 1) : sa.work_date;
    const cutoffTs = `${cutoffDay} ${sa.snapshot_cutoff_time}:00`;

    const startMin = toEpochMinutes(startTs);
    const endMin = toEpochMinutes(endTs);
    const cutoffMin = toEpochMinutes(cutoffTs);

    if (sa.mapping_status && sa.mapping_status !== 'VALID') {
      results.push({
        personId: sa.person_id,
        workDate: sa.work_date,
        shiftAssignmentId: sa.id,
        shiftCode: sa.snapshot_shift_code,
        shiftName: sa.snapshot_shift_name,
        scheduledStart: startTs,
        scheduledEnd: endTs,
        cutoffTimestamp: cutoffTs,
        checkInTime: null,
        checkOutTime: null,
        checkInRawScanId: null,
        checkOutRawScanId: null,
        status: 'PENDING_MAPPING',
        secondaryFlags: sa.mapping_status,
        isLate: 0,
        lateMinutes: 0,
      });
      continue;
    }

    const checkinWindowStart = fromEpochMinutes(startMin - 180);
    const checkinWindowEnd = fromEpochMinutes(endMin - 30);
    const checkoutWindowStart = fromEpochMinutes(startMin + 60);
    const checkoutWindowEnd = fromEpochMinutes(endMin + 240);

    const personScans = rawScans.filter((s) => s.matched_person_id === sa.person_id);

    const checkinCandidates = personScans.filter(
      (s) =>
        s.canonical_bkk_time >= checkinWindowStart &&
        s.canonical_bkk_time <= checkinWindowEnd &&
        (s.in_out_mode === 0 || s.in_out_mode === 255)
    );

    const firstCheckin = checkinCandidates.length > 0 ? checkinCandidates[0] : null;

    const checkoutCandidates = personScans.filter(
      (s) =>
        s.canonical_bkk_time >= checkoutWindowStart &&
        s.canonical_bkk_time <= checkoutWindowEnd &&
        (!firstCheckin || s.id !== firstCheckin.id)
    );
    const lastCheckout =
      checkoutCandidates.length > 0 ? checkoutCandidates[checkoutCandidates.length - 1] : null;

    if (!firstCheckin) {
      if (nowMin < cutoffMin) {
        continue;
      }
      results.push({
        personId: sa.person_id,
        workDate: sa.work_date,
        shiftAssignmentId: sa.id,
        shiftCode: sa.snapshot_shift_code,
        shiftName: sa.snapshot_shift_name,
        scheduledStart: startTs,
        scheduledEnd: endTs,
        cutoffTimestamp: cutoffTs,
        checkInTime: null,
        checkOutTime: lastCheckout ? lastCheckout.canonical_bkk_time : null,
        checkInRawScanId: null,
        checkOutRawScanId: lastCheckout ? lastCheckout.id : null,
        status: 'NO_SCAN',
        secondaryFlags: null,
        isLate: 0,
        lateMinutes: 0,
      });
      continue;
    }

    const checkinMin = toEpochMinutes(firstCheckin.canonical_bkk_time);
    const rawDiffMin = checkinMin - startMin;
    const isLate = rawDiffMin > Number(sa.snapshot_grace_minutes) ? 1 : 0;
    const lateMinutes = isLate ? Math.max(0, rawDiffMin) : 0;

    if (!lastCheckout) {
      if (nowMin >= endMin) {
        results.push({
          personId: sa.person_id,
          workDate: sa.work_date,
          shiftAssignmentId: sa.id,
          shiftCode: sa.snapshot_shift_code,
          shiftName: sa.snapshot_shift_name,
          scheduledStart: startTs,
          scheduledEnd: endTs,
          cutoffTimestamp: cutoffTs,
          checkInTime: firstCheckin.canonical_bkk_time,
          checkOutTime: null,
          checkInRawScanId: firstCheckin.id,
          checkOutRawScanId: null,
          status: 'MISSING_CHECKOUT',
          secondaryFlags: isLate ? 'LATE_AND_MISSING_CHECKOUT' : null,
          isLate,
          lateMinutes,
        });
        continue;
      }
    }

    results.push({
      personId: sa.person_id,
      workDate: sa.work_date,
      shiftAssignmentId: sa.id,
      shiftCode: sa.snapshot_shift_code,
      shiftName: sa.snapshot_shift_name,
      scheduledStart: startTs,
      scheduledEnd: endTs,
      cutoffTimestamp: cutoffTs,
      checkInTime: firstCheckin.canonical_bkk_time,
      checkOutTime: lastCheckout ? lastCheckout.canonical_bkk_time : null,
      checkInRawScanId: firstCheckin.id,
      checkOutRawScanId: lastCheckout ? lastCheckout.id : null,
      status: isLate ? 'LATE' : 'NORMAL',
      secondaryFlags: null,
      isLate,
      lateMinutes,
    });
  }

  return results;
}

export async function previewReprocessRange(options: ReprocessOptions) {
  await resolveRawScanPersonnelMappings(options.dateFrom, options.dateTo);
  const projected = await computeAttendanceOutcomes(options);

  const existing = await dbQuery<{
    id: number;
    person_id: string;
    work_date: string;
    shift_assignment_id: number | null;
    shift_code: string | null;
    status: string;
    late_minutes: number;
    check_in_time: string | null;
    check_out_time: string | null;
  }>(
    `SELECT id, person_id, work_date, shift_assignment_id, shift_code, status, late_minutes, check_in_time, check_out_time
     FROM attendance
     WHERE work_date >= ? AND work_date <= ?`,
    [options.dateFrom, options.dateTo]
  );

  let changedCount = 0;
  let newRecordsCount = 0;
  let unchangedCount = 0;
  const diffs: Array<{
    personId: string;
    workDate: string;
    shiftCode: string | null;
    previousStatus: string | null;
    newStatus: string;
    previousLateMinutes: number | null;
    newLateMinutes: number;
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
        previousLateMinutes: null,
        newLateMinutes: item.lateMinutes,
      });
    } else if (
      match.status !== item.status ||
      Number(match.late_minutes) !== item.lateMinutes ||
      match.check_in_time !== item.checkInTime ||
      match.check_out_time !== item.checkOutTime
    ) {
      changedCount++;
      diffs.push({
        personId: item.personId,
        workDate: item.workDate,
        shiftCode: item.shiftCode,
        previousStatus: match.status,
        newStatus: item.status,
        previousLateMinutes: Number(match.late_minutes),
        newLateMinutes: item.lateMinutes,
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
    diffs,
  };
}

/**
 * Executes idempotent Attendance Reprocess without mutating raw_scans
 * and preserving attendance_notes, hr_review_history, and review_status.
 */
export async function reprocessAttendanceRange(options: ReprocessOptions) {
  const mappingStats = await resolveRawScanPersonnelMappings(options.dateFrom, options.dateTo);
  const projected = await computeAttendanceOutcomes(options);

  let insertedCount = 0;
  let updatedCount = 0;
  const keptAttendanceIds = new Set<number>();

  for (const item of projected) {
    const existing =
      item.shiftAssignmentId !== null
        ? await dbQuery<{ id: number; review_status: string }>(
            `SELECT id, review_status FROM attendance
             WHERE person_id = ? AND work_date = ? AND shift_assignment_id = ? LIMIT 1`,
            [item.personId, item.workDate, item.shiftAssignmentId]
          )
        : await dbQuery<{ id: number; review_status: string }>(
            `SELECT id, review_status FROM attendance
             WHERE person_id = ? AND work_date = ? AND shift_assignment_id IS NULL AND shift_code = ? LIMIT 1`,
            [item.personId, item.workDate, item.shiftCode]
          );

    if (existing.length === 0) {
      const ins = await dbExecute(
        `INSERT INTO attendance (
          person_id, work_date, shift_assignment_id, shift_code, shift_name,
          scheduled_start, scheduled_end, cutoff_timestamp,
          check_in_time, check_out_time, check_in_raw_scan_id, check_out_raw_scan_id,
          status, secondary_flags, is_late, late_minutes, review_status, rule_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?)`,
        [
          item.personId,
          item.workDate,
          item.shiftAssignmentId,
          item.shiftCode,
          item.shiftName,
          item.scheduledStart,
          item.scheduledEnd,
          item.cutoffTimestamp,
          item.checkInTime,
          item.checkOutTime,
          item.checkInRawScanId,
          item.checkOutRawScanId,
          item.status,
          item.secondaryFlags,
          item.isLate,
          item.lateMinutes,
          ATTENDANCE_RULE_VERSION,
        ]
      );
      if (ins.insertId) keptAttendanceIds.add(ins.insertId);
      insertedCount++;
    } else {
      keptAttendanceIds.add(existing[0].id);
      await dbExecute(
        `UPDATE attendance
         SET shift_code = ?, shift_name = ?, scheduled_start = ?, scheduled_end = ?,
             cutoff_timestamp = ?, check_in_time = ?, check_out_time = ?,
             check_in_raw_scan_id = ?, check_out_raw_scan_id = ?,
             status = ?, secondary_flags = ?, is_late = ?, late_minutes = ?,
             rule_version = ?, calculated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          item.shiftCode,
          item.shiftName,
          item.scheduledStart,
          item.scheduledEnd,
          item.cutoffTimestamp,
          item.checkInTime,
          item.checkOutTime,
          item.checkInRawScanId,
          item.checkOutRawScanId,
          item.status,
          item.secondaryFlags,
          item.isLate,
          item.lateMinutes,
          ATTENDANCE_RULE_VERSION,
          existing[0].id,
        ]
      );
      updatedCount++;
    }
  }

  // ลบแถว attendance ที่ยังไม่ผ่านการตรวจของ HR (review_status = 'PENDING' และไม่มีหมายเหตุ)
  // หากเวรในวันนั้นถูกลบออกหรือตั้งเป็นไม่มีเวร (CLEARED_ALL_SHIFTS) เพื่อไม่ให้เวรที่ลบแล้วค้างในรายงาน
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

  for (const row of existingInRange) {
    if (!keptAttendanceIds.has(row.id) && row.review_status === 'PENDING') {
      const notes = await dbQuery<{ id: number }>(
        'SELECT id FROM attendance_notes WHERE attendance_id = ? LIMIT 1',
        [row.id]
      );
      const reviews = await dbQuery<{ id: number }>(
        'SELECT id FROM hr_review_history WHERE attendance_id = ? LIMIT 1',
        [row.id]
      );
      if (notes.length === 0 && reviews.length === 0) {
        await dbExecute('DELETE FROM attendance WHERE id = ?', [row.id]);
      }
    }
  }

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
    mappingStats,
  };
}
