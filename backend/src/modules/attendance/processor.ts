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
 * Matches raw_scans to personnel using effective-dated fingerprint_mappings.
 * Never alters raw_date_time, machine_no, enroll_number, or raw_payload_json!
 */
export async function resolveRawScanPersonnelMappings(dateFrom: string, dateTo: string): Promise<{
  newlyMatched: number;
  unmatchedCount: number;
  conflictCount: number;
}> {
  const extendedEnd = addDays(dateTo, 1);
  const scans = await dbQuery<{
    id: number;
    enroll_number: string;
    canonical_bkk_time: string;
    matched_person_id: string | null;
    mapping_state: string;
  }>(
    `SELECT id, enroll_number, canonical_bkk_time, matched_person_id, mapping_state
     FROM raw_scans
     WHERE canonical_bkk_time >= ? AND canonical_bkk_time <= ?`,
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
        await dbExecute(
          'UPDATE raw_scans SET matched_person_id = ?, mapping_state = ? WHERE id = ?',
          [targetPersonId, 'MATCHED', scan.id]
        );
        newlyMatched++;
      }
    } else if (matchingRows.length > 1 || (matchingRows.length === 1 && matchingRows[0].conflict_state !== 'NONE')) {
      conflictCount++;
      if (scan.mapping_state !== 'CONFLICT') {
        await dbExecute(
          'UPDATE raw_scans SET matched_person_id = NULL, mapping_state = ? WHERE id = ?',
          ['CONFLICT', scan.id]
        );
      }
    } else {
      unmatchedCount++;
      if (scan.mapping_state !== 'UNMATCHED') {
        await dbExecute(
          'UPDATE raw_scans SET matched_person_id = NULL, mapping_state = ? WHERE id = ?',
          ['UNMATCHED', scan.id]
        );
      }
    }
  }

  return { newlyMatched, unmatchedCount, conflictCount };
}

/**
 * Pure deterministic calculation of attendance rows for a date range.
 */
export async function computeAttendanceOutcomes(options: ReprocessOptions): Promise<CalculatedShiftAttendance[]> {
  const nowBkk = options.referenceNowBkk || getBangkokNowString();
  const nowMin = toEpochMinutes(nowBkk);

  const assignmentParams: unknown[] = [options.dateFrom, options.dateTo];
  let personClause = '';
  if (options.personId) {
    personClause = ' AND sa.person_id = ?';
    assignmentParams.push(options.personId);
  }

  const assignments = await dbQuery<{
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

  const extendedEnd = addDays(options.dateTo, 1);
  const rawScans = await dbQuery<{
    id: number;
    matched_person_id: string | null;
    canonical_bkk_time: string;
    in_out_mode: number;
    mapping_state: string;
  }>(
    `SELECT id, matched_person_id, canonical_bkk_time, in_out_mode, mapping_state
     FROM raw_scans
     WHERE canonical_bkk_time >= ? AND canonical_bkk_time <= ?
     ORDER BY canonical_bkk_time ASC`,
    [`${options.dateFrom} 00:00:00`, `${extendedEnd} 23:59:59`]
  );

  const results: CalculatedShiftAttendance[] = [];

  for (const sa of assignments) {
    const startTs = `${sa.work_date} ${sa.snapshot_start_time}:00`;
    const isCross =
      Number(sa.snapshot_is_cross_midnight) === 1 || sa.snapshot_end_time <= sa.snapshot_start_time;
    const endDay = isCross ? addDays(sa.work_date, 1) : sa.work_date;
    const endTs = `${endDay} ${sa.snapshot_end_time}:00`;

    // Cutoff can be on work_date or next day if cutoff < start_time
    const cutoffDay = sa.snapshot_cutoff_time < sa.snapshot_start_time ? addDays(sa.work_date, 1) : sa.work_date;
    const cutoffTs = `${cutoffDay} ${sa.snapshot_cutoff_time}:00`;

    const startMin = toEpochMinutes(startTs);
    const endMin = toEpochMinutes(endTs);
    const cutoffMin = toEpochMinutes(cutoffTs);

    // Check if personnel has a mapping issue (e.g., EMPTY_FINGLE_ID or CONFLICT)
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

    // Window for check-in: [start - 180 min, end - 30 min]
    // Window for check-out: [start + 60 min, end + 240 min]
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
      // Only mark NO_SCAN if current reference time has passed the shift's cutoff time!
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

    // Compute lateness against start_time + grace_minutes
    const checkinMin = toEpochMinutes(firstCheckin.canonical_bkk_time);
    const rawDiffMin = checkinMin - startMin;
    const isLate = rawDiffMin > Number(sa.snapshot_grace_minutes) ? 1 : 0;
    const lateMinutes = isLate ? Math.max(0, rawDiffMin) : 0;

    if (!lastCheckout) {
      // Check if shift checkout window has passed
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
    status: string;
    late_minutes: number;
    check_in_time: string | null;
    check_out_time: string | null;
  }>(
    `SELECT id, person_id, work_date, shift_assignment_id, status, late_minutes, check_in_time, check_out_time
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
        e.person_id === item.personId &&
        e.work_date === item.workDate &&
        e.shift_assignment_id === item.shiftAssignmentId
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

  for (const item of projected) {
    const existing = await dbQuery<{
      id: number;
      review_status: string;
    }>(
      `SELECT id, review_status FROM attendance
       WHERE person_id = ? AND work_date = ? AND shift_assignment_id = ? LIMIT 1`,
      [item.personId, item.workDate, item.shiftAssignmentId]
    );

    if (existing.length === 0) {
      await dbExecute(
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
      insertedCount++;
    } else {
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
