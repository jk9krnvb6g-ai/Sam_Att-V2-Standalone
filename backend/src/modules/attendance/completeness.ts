import { Router } from 'express';
import { dbExecute, dbQuery } from '../../database/adapter.ts';
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import { findClosedPeriodsInRange } from '../periods/lock.ts';
import {
  holidayRowToPublicHolidayAdapter,
  loadHospitalHolidaysForRange,
  resolveHolidayForPersonDate,
} from '../holidays/service.ts';
import {
  isFullDayPersonalHolidayLeaveType,
  loadPersonnelTypeRulesWithDefaultShifts,
  normalizeWorkDateString,
  resolveEffectiveDailyScheduleForPersonDate,
  type DailyOverrideRow,
  type ExistingAssignmentRow,
  type PersonnelTypeRuleRow,
} from '../shifts/routes.ts';
import { reprocessAttendanceRange, resolveRawScanPersonnelMappings } from './processor.ts';

export const completenessRouter = Router();

function enumerateYmdDates(dateFrom: string, dateTo: string): string[] {
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
    return [];
  }
  const dates: string[] = [];
  const cursor = new Date(start.getTime());
  let guard = 0;
  while (cursor <= end && guard < 100) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    guard++;
  }
  return dates;
}

export interface CompletenessGapItem {
  gapType:
    | 'MISSING_ATTENDANCE'
    | 'UNPROCESSED_SCAN'
    | 'MISSING_MAPPING'
    | 'CONFLICT_MAPPING'
    | 'LATE_SCAN_CLOSED';
  personId: string | null;
  fullName: string | null;
  departmentName: string | null;
  workDate: string;
  shiftCode: string | null;
  shiftName: string | null;
  fingleId?: string | null;
  rawScanCount?: number;
  reasonThai: string;
}

export async function evaluateCompletenessSnapshot(params: {
  dateFrom: string;
  dateTo: string;
  department?: string;
  personnelType?: string;
}) {
  const dateFrom = normalizeWorkDateString(params.dateFrom);
  const dateTo = normalizeWorkDateString(params.dateTo);
  const department = String(params.department || '').trim();
  const personnelType = String(params.personnelType || '').trim();
  const dates = enumerateYmdDates(dateFrom, dateTo);

  const pConditions = ['is_active = 1'];
  const pParams: unknown[] = [];
  if (department) {
    pConditions.push('department_name = ?');
    pParams.push(department);
  }
  if (personnelType) {
    pConditions.push('personnel_type_code = ?');
    pParams.push(personnelType);
  }

  const personnelList = await dbQuery<{
    person_id: string;
    full_name: string;
    department_name: string;
    personnel_type_code: string;
    personnel_type_name: string;
    mapping_status: string;
  }>(
    `SELECT person_id, full_name, department_name, personnel_type_code, personnel_type_name, mapping_status
     FROM personnel
     WHERE ${pConditions.join(' AND ')}
     ORDER BY department_name ASC, full_name ASC`,
    pParams
  );

  const personById = new Map(personnelList.map((p) => [String(p.person_id).trim(), p]));

  const [
    rawAssignments,
    rawOverrides,
    allTypeRules,
    hospitalHolidays,
    rawLeaves,
    existingAttendance,
    closedPeriods,
  ] = await Promise.all([
    dbQuery<ExistingAssignmentRow>(
      `SELECT id, person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
              snapshot_start_time, snapshot_end_time, snapshot_grace_minutes,
              snapshot_cutoff_time, snapshot_is_cross_midnight, status
       FROM shift_assignments
       WHERE work_date >= ? AND work_date <= ? AND status = 'ACTIVE'`,
      [dateFrom, dateTo]
    ),
    dbQuery<DailyOverrideRow>(
      `SELECT * FROM shift_daily_overrides WHERE work_date >= ? AND work_date <= ?`,
      [dateFrom, dateTo]
    ),
    loadPersonnelTypeRulesWithDefaultShifts(),
    loadHospitalHolidaysForRange(dateFrom, dateTo),
    dbQuery<{ person_id: string; work_date: string; leave_type: string; reason: string | null }>(
      `SELECT person_id, work_date, leave_type, reason
       FROM attendance_leaves
       WHERE status = 'ACTIVE' AND work_date >= ? AND work_date <= ?`,
      [dateFrom, dateTo]
    ),
    dbQuery<{
      id: number;
      person_id: string;
      work_date: string;
      shift_assignment_id: number | null;
      shift_code: string | null;
      status: string;
      review_status: string;
      late_scan_review_required: number | null;
    }>(
      `SELECT id, person_id, work_date, shift_assignment_id, shift_code, status, review_status,
              COALESCE(late_scan_review_required, 0) AS late_scan_review_required
       FROM attendance
       WHERE work_date >= ? AND work_date <= ?`,
      [dateFrom, dateTo]
    ),
    findClosedPeriodsInRange(dateFrom, dateTo),
  ]);

  const rulesByCode = new Map<string, PersonnelTypeRuleRow>();
  for (const r of allTypeRules) {
    rulesByCode.set(String(r.personnel_type_code || '').trim().toUpperCase(), {
      ...r,
      effective_from: normalizeWorkDateString(r.effective_from || '2026-01-01'),
    });
  }

  const assignmentsByPersonDate = new Map<string, ExistingAssignmentRow[]>();
  for (const sa of rawAssignments) {
    const pid = String(sa.person_id).trim();
    const wDate = normalizeWorkDateString(sa.work_date);
    if (!personById.has(pid)) continue;
    const key = `${pid}:${wDate}`;
    const list = assignmentsByPersonDate.get(key) || [];
    list.push({ ...sa, person_id: pid, work_date: wDate });
    assignmentsByPersonDate.set(key, list);
  }

  const overridesByPersonDate = new Map<string, DailyOverrideRow>();
  for (const ov of rawOverrides) {
    const pid = String(ov.person_id).trim();
    const wDate = normalizeWorkDateString(ov.work_date);
    overridesByPersonDate.set(`${pid}:${wDate}`, { ...ov, person_id: pid, work_date: wDate });
  }

  const personalHolidayByPersonDate = new Map<string, { reason?: string | null }>();
  for (const lv of rawLeaves) {
    if (isFullDayPersonalHolidayLeaveType(lv.leave_type)) {
      const pid = String(lv.person_id).trim();
      const wDate = normalizeWorkDateString(lv.work_date);
      personalHolidayByPersonDate.set(`${pid}:${wDate}`, { reason: lv.reason });
    }
  }

  const attCountByPersonDateCode = new Set<string>();
  const attCountByPersonDate = new Map<string, number>();
  let scopedAttendanceCount = 0;
  let pendingReviewCount = 0;
  let lateScanReviewRequiredCount = 0;

  for (const att of existingAttendance) {
    const pid = String(att.person_id).trim();
    if (!personById.has(pid)) continue;
    scopedAttendanceCount++;
    const wDate = normalizeWorkDateString(att.work_date);
    const sCode = String(att.shift_code || '').trim();
    attCountByPersonDateCode.add(`${pid}:${wDate}:${sCode}`);
    attCountByPersonDate.set(`${pid}:${wDate}`, (attCountByPersonDate.get(`${pid}:${wDate}`) || 0) + 1);
    if (
      att.review_status === 'PENDING' ||
      att.review_status === 'PENDING_REVIEW' ||
      att.review_status === 'NEEDS_RE_REVIEW'
    ) {
      pendingReviewCount++;
    }
    if (Number(att.late_scan_review_required || 0) === 1) {
      lateScanReviewRequiredCount++;
    }
  }

  let expectedShiftCount = 0;
  let missingAttendanceCount = 0;
  const gapItems: CompletenessGapItem[] = [];

  for (const workDate of dates) {
    for (const person of personnelList) {
      const pid = String(person.person_id).trim();
      const key = `${pid}:${workDate}`;
      const scopedHoliday = resolveHolidayForPersonDate({
        workDate,
        personId: pid,
        departmentName: person.department_name,
        holidays: hospitalHolidays,
      });

      const resolved = resolveEffectiveDailyScheduleForPersonDate({
        person,
        workDate,
        activeAssignments: assignmentsByPersonDate.get(key) || [],
        dailyOverride: overridesByPersonDate.get(key) || null,
        rulesByCode,
        publicHoliday: holidayRowToPublicHolidayAdapter(scopedHoliday),
        personalHoliday: personalHolidayByPersonDate.get(key) || null,
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

      for (const eff of resolved.effectiveShifts) {
        if (eff.isDefaultFromType && person.mapping_status !== 'VALID' && resolved.state !== 'RESTORED_DEFAULT') {
          continue;
        }
        expectedShiftCount++;
        const hasExact = attCountByPersonDateCode.has(`${pid}:${workDate}:${eff.shiftCode}`);
        const hasAnyOnDate = (attCountByPersonDate.get(`${pid}:${workDate}`) || 0) > 0;
        if (!hasExact && !hasAnyOnDate) {
          missingAttendanceCount++;
          if (gapItems.length < 500) {
            gapItems.push({
              gapType: 'MISSING_ATTENDANCE',
              personId: pid,
              fullName: person.full_name,
              departmentName: person.department_name,
              workDate,
              shiftCode: eff.shiftCode,
              shiftName: eff.shiftName,
              reasonThai: eff.isDefaultFromType
                ? `มีกะเริ่มต้น (${eff.shiftCode}) แต่ยังไม่มีข้อมูลประมวลผลเวลาในวันที่ ${workDate}`
                : `มีตารางเวร (${eff.shiftCode}) แต่ยังไม่มีรายการประมวลผลเวลา`,
            });
          }
        }
      }
    }
  }

  // Evaluate raw scans in range: UNMATCHED / CONFLICT / MATCHED unprocessed
  const rawScanRows = await dbQuery<{
    id: number;
    fingle_id: string;
    canonical_bkk_time: string;
    mapping_state: string | null;
    matched_person_id: string | null;
    used_attendance_id: number | null;
  }>(
    `SELECT rs.id, rs.enroll_number AS fingle_id, rs.canonical_bkk_time,
            rsm.mapping_state, rsm.matched_person_id,
            u.attendance_id AS used_attendance_id
     FROM raw_scans rs
     LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
     LEFT JOIN attendance_raw_scan_usage u ON u.raw_scan_id = rs.id
     WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?
     ORDER BY rs.canonical_bkk_time DESC
     LIMIT 2000`,
    [`${dateFrom} 00:00:00`, `${dateTo} 23:59:59`]
  );

  let missingMappingCount = 0;
  let conflictCount = 0;
  let unprocessedScanCount = 0;

  for (const rs of rawScanRows) {
    const scanDate = String(rs.canonical_bkk_time || '').slice(0, 10);
    const state = String(rs.mapping_state || 'UNMATCHED').toUpperCase();
    const matchedPid = rs.matched_person_id ? String(rs.matched_person_id).trim() : null;

    if (department || personnelType) {
      if (matchedPid && !personById.has(matchedPid)) {
        continue;
      }
    }

    if (state === 'UNMATCHED') {
      missingMappingCount++;
      if (gapItems.length < 500) {
        gapItems.push({
          gapType: 'MISSING_MAPPING',
          personId: null,
          fullName: null,
          departmentName: null,
          workDate: scanDate,
          shiftCode: null,
          shiftName: null,
          fingleId: rs.fingle_id,
          reasonThai: `พบรหัสสแกน ${rs.fingle_id} ที่ยังไม่ผูกรหัสบุคลากรในทะเบียน`,
        });
      }
    } else if (state === 'CONFLICT') {
      conflictCount++;
      if (gapItems.length < 500) {
        gapItems.push({
          gapType: 'CONFLICT_MAPPING',
          personId: matchedPid,
          fullName: matchedPid ? personById.get(matchedPid)?.full_name || null : null,
          departmentName: matchedPid ? personById.get(matchedPid)?.department_name || null : null,
          workDate: scanDate,
          shiftCode: null,
          shiftName: null,
          fingleId: rs.fingle_id,
          reasonThai: `รหัสสแกน ${rs.fingle_id} ผูกซ้ำซ้อนกับบุคลากรมากกว่า 1 รายการ`,
        });
      }
    } else if (state === 'MATCHED' && rs.used_attendance_id === null && matchedPid) {
      const hasAtt = (attCountByPersonDate.get(`${matchedPid}:${scanDate}`) || 0) > 0;
      if (!hasAtt) {
        unprocessedScanCount++;
        const person = personById.get(matchedPid);
        if (gapItems.length < 500) {
          gapItems.push({
            gapType: 'UNPROCESSED_SCAN',
            personId: matchedPid,
            fullName: person?.full_name || null,
            departmentName: person?.department_name || null,
            workDate: scanDate,
            shiftCode: null,
            shiftName: null,
            fingleId: rs.fingle_id,
            reasonThai: `มีสแกนของ ${person?.full_name || matchedPid} วันที่ ${scanDate} แต่ยังไม่ได้ประมวลผลลงเวลา`,
          });
        }
      }
    }
  }

  return {
    dateFrom,
    dateTo,
    department: department || null,
    personnelType: personnelType || null,
    closedPeriods,
    metrics: {
      totalPersonnelEvaluated: personnelList.length,
      expectedShiftCount,
      existingAttendanceCount: scopedAttendanceCount,
      missingAttendanceCount,
      missingMappingCount,
      conflictCount,
      unprocessedScanCount,
      pendingReviewCount,
      lateScanReviewRequiredCount,
      completenessPercent:
        expectedShiftCount > 0
          ? Number(
              (
                ((expectedShiftCount - missingAttendanceCount) / expectedShiftCount) *
                100
              ).toFixed(1)
            )
          : 100,
      totalActionableGaps:
        missingAttendanceCount + missingMappingCount + conflictCount + unprocessedScanCount,
    },
    gapItems,
  };
}

// GET /attendance/completeness — ประเมินความครบถ้วนของข้อมูลย้อนหลังแบบ Read-Only (ไม่สร้างแถวหลอก)
completenessRouter.get(
  '/attendance/completeness',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = normalizeWorkDateString(req.query.dateFrom || bkk.monthStartYmd);
      const dateTo = normalizeWorkDateString(req.query.dateTo || bkk.todayYmd);
      const department = req.query.department ? String(req.query.department).trim() : undefined;
      const personnelType = req.query.personnelType
        ? String(req.query.personnelType).trim()
        : undefined;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุช่วงวันที่ dateFrom และ dateTo (YYYY-MM-DD) ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const dates = enumerateYmdDates(dateFrom, dateTo);
      if (dates.length === 0 || dates.length > 93) {
        res.status(400).json({
          error: 'RANGE_TOO_LARGE',
          message: 'กรุณาระบุช่วงวันที่ตรวจสอบความครบถ้วนไม่เกิน 93 วันต่อครั้ง',
          requestId: req.requestId,
        });
        return;
      }

      const snapshot = await evaluateCompletenessSnapshot({
        dateFrom,
        dateTo,
        department,
        personnelType,
      });

      let recentRuns: Array<Record<string, unknown>> = [];
      try {
        recentRuns = await dbQuery(
          'SELECT * FROM completeness_runs ORDER BY id DESC LIMIT 15'
        );
      } catch {
        recentRuns = [];
      }

      res.json({
        ...snapshot,
        recentRuns,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /attendance/completeness/process-preview — พรีวิวก่อนซ่อมแซมและประมวลผลข้อมูลย้อนหลัง
completenessRouter.post(
  '/attendance/completeness/process-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = normalizeWorkDateString(req.body?.dateFrom || bkk.monthStartYmd);
      const dateTo = normalizeWorkDateString(req.body?.dateTo || bkk.todayYmd);
      const department = req.body?.department ? String(req.body.department).trim() : undefined;
      const personnelType = req.body?.personnelType
        ? String(req.body.personnelType).trim()
        : undefined;

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุช่วงวันที่สำหรับพรีวิวให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const snapshot = await evaluateCompletenessSnapshot({
        dateFrom,
        dateTo,
        department,
        personnelType,
      });

      res.json({
        ...snapshot,
        canExecute: snapshot.closedPeriods.length === 0,
        blockedReasonThai:
          snapshot.closedPeriods.length > 0
            ? `ช่วงวันที่ที่เลือกครอบคลุมเดือนที่ปิดรอบบัญชีแล้ว (${snapshot.closedPeriods.join(', ')}) จึงไม่สามารถสั่งประมวลผลอัตโนมัติในเดือนที่ปิดรอบได้`
            : null,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /attendance/completeness/process — ประมวลผลเติมข้อมูลที่ขาด (รองรับ Retry Failed Only และบล็อกเดือนปิดรอบ)
completenessRouter.post(
  '/attendance/completeness/process',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = normalizeWorkDateString(req.body?.dateFrom || bkk.monthStartYmd);
      const dateTo = normalizeWorkDateString(req.body?.dateTo || bkk.todayYmd);
      const department = req.body?.department ? String(req.body.department).trim() : undefined;
      const personnelType = req.body?.personnelType
        ? String(req.body.personnelType).trim()
        : undefined;
      const selectedTargets: Array<{ personId: string; workDate: string }> = Array.isArray(
        req.body?.targets
      )
        ? req.body.targets
            .map((t: { personId?: unknown; workDate?: unknown }) => ({
              personId: String(t?.personId || '').trim(),
              workDate: normalizeWorkDateString(t?.workDate),
            }))
            .filter(
              (t: { personId: string; workDate: string }) =>
                t.personId && /^\d{4}-\d{2}-\d{2}$/.test(t.workDate)
            )
        : [];

      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo) || dateFrom > dateTo) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุช่วงวันที่ dateFrom และ dateTo ให้ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const closedPeriods = await findClosedPeriodsInRange(dateFrom, dateTo);
      if (closedPeriods.length > 0) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถประมวลผลความครบถ้วนในช่วงที่มีเดือนปิดรอบบัญชีแล้วได้ (${closedPeriods.join(', ')})`,
          closedPeriods,
          requestId: req.requestId,
        });
        return;
      }

      const beforeSnapshot = await evaluateCompletenessSnapshot({
        dateFrom,
        dateTo,
        department,
        personnelType,
      });

      const mappingStats = await resolveRawScanPersonnelMappings(dateFrom, dateTo);

      const processedItems: Array<{ personId: string | null; workDate: string; processedCount: number }> = [];
      const failedItems: Array<{ personId: string | null; workDate: string; reason: string }> = [];

      if (selectedTargets.length > 0) {
        const uniqueTargets = Array.from(
          new Map(selectedTargets.map((t) => [`${t.personId}|${t.workDate}`, t])).values()
        );
        for (const t of uniqueTargets) {
          try {
            const outcome = await reprocessAttendanceRange({
              dateFrom: t.workDate,
              dateTo: t.workDate,
              personId: t.personId,
              actorUsername: req.user!.username,
              actorRole: req.user!.role,
              requestId: req.requestId,
              ipAddress: req.ip || '127.0.0.1',
            });
            processedItems.push({
              personId: t.personId,
              workDate: t.workDate,
              processedCount: outcome.totalProcessed,
            });
          } catch (err) {
            failedItems.push({
              personId: t.personId,
              workDate: t.workDate,
              reason: err instanceof Error ? err.message : 'ไม่สามารถประมวลผลรายการนี้ได้',
            });
          }
        }
      } else {
        try {
          const outcome = await reprocessAttendanceRange({
            dateFrom,
            dateTo,
            actorUsername: req.user!.username,
            actorRole: req.user!.role,
            requestId: req.requestId,
            ipAddress: req.ip || '127.0.0.1',
          });
          processedItems.push({
            personId: null,
            workDate: `${dateFrom}..${dateTo}`,
            processedCount: outcome.totalProcessed,
          });
        } catch (err) {
          failedItems.push({
            personId: null,
            workDate: `${dateFrom}..${dateTo}`,
            reason: err instanceof Error ? err.message : 'เกิดข้อผิดพลาดระหว่างประมวลผลช่วงวันที่',
          });
        }
      }

      const afterSnapshot = await evaluateCompletenessSnapshot({
        dateFrom,
        dateTo,
        department,
        personnelType,
      });

      const totalProcessedCount = processedItems.reduce((sum, i) => sum + i.processedCount, 0);
      const runStatus =
        failedItems.length === 0
          ? 'COMPLETED'
          : processedItems.length > 0
            ? 'PARTIAL'
            : 'FAILED';

      try {
        await dbExecute(
          `INSERT INTO completeness_runs (
            date_from, date_to, department_name,
            expected_count, missing_before_count,
            processed_count, failed_count,
            status, result_summary_json, triggered_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            dateFrom,
            dateTo,
            department || null,
            beforeSnapshot.metrics.expectedShiftCount,
            beforeSnapshot.metrics.missingAttendanceCount,
            totalProcessedCount,
            failedItems.length,
            runStatus,
            JSON.stringify({
              existingAttendanceBefore: beforeSnapshot.metrics.existingAttendanceCount,
              unprocessedScansBefore: beforeSnapshot.metrics.unprocessedScanCount,
              mappingStats,
              afterMetrics: afterSnapshot.metrics,
              failedCount: failedItems.length,
            }),
            req.user!.username,
          ]
        );
      } catch {
        // Non-blocking if legacy schema omits completeness_runs
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'COMPLETENESS_BATCH_PROCESSED',
        targetType: 'ATTENDANCE_COMPLETENESS',
        targetId: `${dateFrom}..${dateTo}`,
        result:
          failedItems.length === 0
            ? 'SUCCESS'
            : processedItems.length > 0
              ? 'PARTIAL_SUCCESS'
              : 'FAILURE',
        detail: {
          department: department || null,
          expectedShifts: beforeSnapshot.metrics.expectedShiftCount,
          missingBefore: beforeSnapshot.metrics.missingAttendanceCount,
          missingAfter: afterSnapshot.metrics.missingAttendanceCount,
          totalProcessedCount,
          failedCount: failedItems.length,
        },
      });

      res.json({
        status: runStatus,
        mappingStats,
        processedItems,
        failedItems,
        beforeMetrics: beforeSnapshot.metrics,
        afterSnapshot,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);
