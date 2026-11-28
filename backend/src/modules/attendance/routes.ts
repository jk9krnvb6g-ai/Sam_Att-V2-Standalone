import { Router } from 'express';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { requireAuth, requireRoles, enforceOwnPersonMapping } from '../../middleware/auth.ts';
import {
  getHalfDayPreCheckinWindowMinutes,
  previewReprocessRange,
  reprocessAttendanceRange,
} from './processor.ts';
import { addDaysYmd } from './matchingEngine.ts';
import { evaluateAttendanceLifecycle } from './lifecycle.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  assertRoleAuthorizedForDateRange,
  ScannerSyncRangeError,
} from '../scanners/syncRange.ts';
import {
  loadHospitalHolidaysForRange,
  resolveHolidayForPersonDate,
  type HospitalHolidayRow,
} from '../holidays/service.ts';
import { findClosedPeriodsInRange, isPeriodClosed } from '../periods/lock.ts';

export const attendanceRouter = Router();

const ALLOWED_LEAVE_TYPES = new Set(['HALF_DAY_MORNING', 'HALF_DAY_AFTERNOON', 'CUSTOM_PARTIAL']);
const ALLOWED_REVIEW_STATUSES = new Set([
  'PENDING',
  'REVIEWED',
  'VERIFIED_APPROVED',
  'NEEDS_RE_REVIEW',
  'REJECTED',
]);

function applyAttendanceStatusFilter(
  statusFilter: string,
  conditions: string[],
  params: unknown[]
): void {
  const normalized = statusFilter.trim().toUpperCase();
  if (!normalized) return;

  if (normalized === 'EARLY_CHECKOUT') {
    conditions.push('a.early_checkout_indicator = 1');
  } else if (normalized === 'NEEDS_RE_REVIEW') {
    conditions.push("a.review_status = 'NEEDS_RE_REVIEW'");
  } else if (normalized === 'COMPLETE') {
    conditions.push("a.attendance_status = 'COMPLETE'");
  } else if (normalized === 'MISSING_CHECKIN') {
    conditions.push("a.status = 'MISSING_CHECKIN'");
  } else if (normalized === 'LATE') {
    conditions.push("(a.is_late = 1 OR a.status = 'LATE')");
  } else if (normalized === 'IN_PROGRESS') {
    conditions.push("(a.status = 'IN_PROGRESS' OR a.attendance_status = 'IN_PROGRESS')");
  } else if (normalized === 'LATE_IN_PROGRESS') {
    conditions.push("(a.status = 'LATE_IN_PROGRESS' OR a.attendance_status = 'LATE_IN_PROGRESS')");
  } else {
    conditions.push('a.status = ?');
    params.push(normalized);
  }
}

function resolveAttendanceSort(sortByRaw: unknown, sortDirRaw: unknown): { col: string; dir: 'ASC' | 'DESC' } {
  const dir = String(sortDirRaw || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const map: Record<string, string> = {
    work_date: 'a.work_date',
    person_id: 'a.person_id',
    full_name: 'p.full_name',
    late_minutes: 'a.late_minutes',
    early_checkout_minutes: 'a.early_checkout_minutes',
    status: 'a.status',
    review_status: 'a.review_status',
  };
  return {
    col: map[String(sortByRaw || '').trim()] || 'a.work_date',
    dir,
  };
}

// B3. My Attendance & My Shifts (Own-Only Enforced)
attendanceRouter.get(
  '/me/attendance',
  requireAuth,
  enforceOwnPersonMapping,
  async (req, res, next) => {
    try {
      const personId = req.user!.approvedPersonId!;
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.query.dateFrom || `${bkk.currentYear}-01-01`).trim();
      const dateTo = String(req.query.dateTo || `${bkk.currentYear}-12-31`).trim();

      const rawItems = await dbQuery<{
        id: number;
        person_id: string;
        work_date: string;
        shift_code: string | null;
        shift_name: string | null;
        scheduled_start: string | null;
        scheduled_end: string | null;
        evaluated_start_time: string | null;
        evaluated_end_time: string | null;
        check_in_time: string | null;
        check_out_time: string | null;
        status: string;
        attendance_status: string | null;
        secondary_flags: string | null;
        is_late: number;
        late_minutes: number;
        early_checkout_indicator: number;
        early_checkout_minutes: number;
        review_status: string;
        review_reason: string | null;
        leave_type: string | null;
        leave_start_time: string | null;
        leave_end_time: string | null;
        cutoff_timestamp?: string | null;
        mapping_status?: string | null;
      }>(
        `SELECT * FROM attendance
         WHERE person_id = ? AND work_date >= ? AND work_date <= ?
         ORDER BY work_date DESC, scheduled_start ASC`,
        [personId, dateFrom, dateTo]
      );

      let holidays: HospitalHolidayRow[] = [];
      let deptName = '';
      try {
        const personRows = await dbQuery<{ department_name: string }>(
          'SELECT department_name FROM personnel WHERE person_id = ? LIMIT 1',
          [personId]
        );
        deptName = personRows[0]?.department_name || '';
        const allHolidays = await loadHospitalHolidaysForRange(dateFrom, dateTo);
        holidays = allHolidays.filter(
          (h) =>
            h.scope_type === 'ALL' ||
            (h.scope_type === 'DEPARTMENT' && Boolean(deptName && h.department_name === deptName)) ||
            (h.scope_type === 'PERSON' && h.person_id === personId)
        );
      } catch {
        holidays = [];
      }

      const items = rawItems.map((row) => {
        const wDate = String(row.work_date).slice(0, 10);
        const h = resolveHolidayForPersonDate({
          workDate: wDate,
          personId,
          departmentName: deptName,
          holidays,
        });
        const lc = evaluateAttendanceLifecycle({
          workDate: String(row.work_date).slice(0, 10),
          scheduledStart: row.scheduled_start,
          scheduledEnd: row.scheduled_end,
          evaluatedStart: row.evaluated_start_time,
          evaluatedEnd: row.evaluated_end_time,
          cutoffTimestamp: row.cutoff_timestamp,
          checkInTime: row.check_in_time,
          checkOutTime: row.check_out_time,
          status: row.status,
          attendanceStatus: row.attendance_status,
          isLate: row.is_late,
          lateMinutes: row.late_minutes,
          earlyCheckoutIndicator: row.early_checkout_indicator,
          earlyCheckoutMinutes: row.early_checkout_minutes,
          mappingStatus: row.mapping_status,
          holidayName: h?.holiday_name || null,
          holidayPolicy: h?.override_policy || null,
          leaveType: row.leave_type,
          referenceNowBkk: bkk.nowDateTimeBkk,
        });
        return {
          ...row,
          lifecycleState: lc.lifecycleState,
          lifecycleLabelThai: lc.thaiLabel,
          isFinalized: lc.isFinalized,
          remainingCheckinWindowMinutes: lc.remainingCheckinWindowMinutes,
          remainingShiftMinutes: lc.remainingShiftMinutes,
          phases: lc.phases,
        };
      });

      // Build todayStatusCard from today's attendance row, today's shift assignment, or holiday
      let todayStatusCard: Record<string, unknown> | null = null;
      const todayItem = items.find((i) => String(i.work_date).slice(0, 10) === bkk.todayYmd);
      const todayHoliday = resolveHolidayForPersonDate({
        workDate: bkk.todayYmd,
        personId,
        departmentName: deptName,
        holidays,
      });
      if (todayItem) {
        todayStatusCard = {
          workDate: bkk.todayYmd,
          shiftCode: todayItem.shift_code,
          shiftName: todayItem.shift_name,
          scheduledStart: todayItem.scheduled_start,
          scheduledEnd: todayItem.scheduled_end,
          checkInTime: todayItem.check_in_time,
          checkOutTime: todayItem.check_out_time,
          lateMinutes: todayItem.late_minutes,
          lifecycleState: todayItem.lifecycleState,
          lifecycleLabelThai: todayItem.lifecycleLabelThai,
          isFinalized: todayItem.isFinalized,
          remainingCheckinWindowMinutes: todayItem.remainingCheckinWindowMinutes,
          remainingShiftMinutes: todayItem.remainingShiftMinutes,
          phases: todayItem.phases,
          holiday: todayHoliday,
        };
      } else {
        const todayShifts = await dbQuery<{
          snapshot_shift_code: string;
          snapshot_shift_name: string;
          snapshot_start_time: string;
          snapshot_end_time: string;
          snapshot_cutoff_time: string;
          snapshot_is_cross_midnight: number;
        }>(
          `SELECT snapshot_shift_code, snapshot_shift_name, snapshot_start_time,
                  snapshot_end_time, snapshot_cutoff_time, snapshot_is_cross_midnight
           FROM shift_assignments
           WHERE person_id = ? AND work_date = ? AND status = 'ACTIVE'
           ORDER BY snapshot_start_time ASC LIMIT 1`,
          [personId, bkk.todayYmd]
        );
        if (todayShifts[0]) {
          const ts = todayShifts[0];
          const lc = evaluateAttendanceLifecycle({
            workDate: bkk.todayYmd,
            startTime: ts.snapshot_start_time,
            endTime: ts.snapshot_end_time,
            cutoffTime: ts.snapshot_cutoff_time,
            isCrossMidnight: ts.snapshot_is_cross_midnight,
            holidayName: todayHoliday?.holiday_name || null,
            holidayPolicy: todayHoliday?.override_policy || null,
            referenceNowBkk: bkk.nowDateTimeBkk,
          });
          todayStatusCard = {
            workDate: bkk.todayYmd,
            shiftCode: ts.snapshot_shift_code,
            shiftName: ts.snapshot_shift_name,
            scheduledStart: lc.evaluatedStart,
            scheduledEnd: lc.evaluatedEnd,
            checkInTime: null,
            checkOutTime: null,
            lateMinutes: 0,
            lifecycleState: lc.lifecycleState,
            lifecycleLabelThai: lc.thaiLabel,
            isFinalized: lc.isFinalized,
            remainingCheckinWindowMinutes: lc.remainingCheckinWindowMinutes,
            remainingShiftMinutes: lc.remainingShiftMinutes,
            phases: lc.phases,
            holiday: todayHoliday,
          };
        } else {
          const lc = evaluateAttendanceLifecycle({
            workDate: bkk.todayYmd,
            status: todayHoliday ? 'OFF_DAY' : 'NO_SHIFT',
            holidayName: todayHoliday?.holiday_name || null,
            holidayPolicy: todayHoliday?.override_policy || null,
            referenceNowBkk: bkk.nowDateTimeBkk,
          });
          todayStatusCard = {
            workDate: bkk.todayYmd,
            shiftCode: null,
            shiftName: todayHoliday ? todayHoliday.holiday_name : 'ไม่มีตารางเวรวันนี้',
            scheduledStart: null,
            scheduledEnd: null,
            checkInTime: null,
            checkOutTime: null,
            lateMinutes: 0,
            lifecycleState: lc.lifecycleState,
            lifecycleLabelThai: lc.thaiLabel,
            isFinalized: true,
            remainingCheckinWindowMinutes: null,
            remainingShiftMinutes: null,
            phases: [],
            holiday: todayHoliday,
          };
        }
      }

      const notes = await dbQuery<{
        id: number;
        attendance_id: number;
        reason_type: string;
        note_text: string;
        needs_re_review: number;
        created_by: string;
        created_at: string;
      }>(
        `SELECT id, attendance_id, reason_type, note_text, needs_re_review, created_by, created_at
         FROM attendance_notes
         WHERE person_id = ? AND visible_to_employee = 1
         ORDER BY id DESC`,
        [personId]
      );

      const leaves = await dbQuery(
        `SELECT id, person_id, work_date, shift_assignment_id, leave_type, leave_start_time, leave_end_time, reason, status
         FROM attendance_leaves
         WHERE person_id = ? AND status = 'ACTIVE' AND work_date >= ? AND work_date <= ?
         ORDER BY work_date DESC`,
        [personId, dateFrom, dateTo]
      );

      const totalShifts = items.length;
      const lateOccurrences = items.filter((i) => Number(i.is_late) === 1).length;
      const totalLateMinutes = items.reduce((acc, i) => acc + Number(i.late_minutes || 0), 0);
      const earlyCheckoutCount = items.filter((i) => Number(i.early_checkout_indicator) === 1).length;
      const missingCheckinCount = items.filter(
        (i) => i.status === 'MISSING_CHECKIN' || i.attendance_status === 'MISSING_CHECKIN'
      ).length;
      const completeCount = items.filter(
        (i) => i.attendance_status === 'COMPLETE' || i.status === 'NORMAL' || i.status === 'LATE'
      ).length;
      const needsReReviewCount = items.filter((i) => i.review_status === 'NEEDS_RE_REVIEW').length;

      res.json({
        personId,
        todayStatusCard,
        holidays,
        summary: {
          totalShifts,
          lateOccurrences,
          totalLateMinutes,
          normalCount: items.filter((i) => i.status === 'NORMAL').length,
          completeCount,
          inProgressCount: items.filter((i) => i.lifecycleState === 'IN_PROGRESS' || i.lifecycleState === 'LATE_IN_PROGRESS').length,
          noScanCount: items.filter((i) => i.status === 'NO_SCAN').length,
          missingCheckinCount,
          missingCheckoutCount: items.filter((i) => i.status === 'MISSING_CHECKOUT').length,
          earlyCheckoutCount,
          needsReReviewCount,
        },
        items,
        notes,
        leaves,
      });
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.get(
  '/me/shifts',
  requireAuth,
  enforceOwnPersonMapping,
  async (req, res, next) => {
    try {
      const personId = req.user!.approvedPersonId!;
      const items = await dbQuery(
        `SELECT * FROM shift_assignments
         WHERE person_id = ? AND status = 'ACTIVE'
         ORDER BY work_date DESC, snapshot_start_time ASC`,
        [personId]
      );
      res.json({ personId, items });
    } catch (err) {
      next(err);
    }
  }
);

// B6. HR Attendance Management (Organization-Wide, optional server pagination)
attendanceRouter.get(
  '/attendance',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.query.dateFrom || bkk.monthStartYmd).trim();
      const dateTo = String(req.query.dateTo || bkk.monthEndYmd).trim();
      const department = String(req.query.department || '').trim();
      const personnelType = String(req.query.personnelType || '').trim();
      const status = String(req.query.status || '').trim();
      const reviewStatus = String(req.query.reviewStatus || '').trim().toUpperCase();
      const search = String(req.query.search || '').trim();
      const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
      const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
      const rawPageSize = Number.parseInt(String(req.query.pageSize || '50'), 10);
      const pageSize = Number.isFinite(rawPageSize) ? Math.min(200, Math.max(1, rawPageSize)) : 50;
      const sort = resolveAttendanceSort(req.query.sortBy, req.query.sortDir);

      const baseConditions = ['a.work_date >= ?', 'a.work_date <= ?'];
      const baseParams: unknown[] = [dateFrom, dateTo];

      if (department) {
        baseConditions.push('p.department_name = ?');
        baseParams.push(department);
      }
      if (personnelType) {
        baseConditions.push('p.personnel_type_code = ?');
        baseParams.push(personnelType);
      }
      if (status) {
        applyAttendanceStatusFilter(status, baseConditions, baseParams);
      }
      if (search) {
        baseConditions.push('(a.person_id LIKE ? OR p.full_name LIKE ?)');
        baseParams.push(`%${search}%`, `%${search}%`);
      }

      const tabCountRows = await dbQuery<{
        totalCount: number;
        pendingCount: number;
        verifiedCount: number;
      }>(
        `SELECT COUNT(*) AS totalCount,
                SUM(CASE WHEN a.review_status IN ('PENDING', 'PENDING_REVIEW', 'NEEDS_RE_REVIEW') THEN 1 ELSE 0 END) AS pendingCount,
                SUM(CASE WHEN a.review_status IN ('REVIEWED', 'VERIFIED_APPROVED') THEN 1 ELSE 0 END) AS verifiedCount
         FROM attendance a
         INNER JOIN personnel p ON p.person_id = a.person_id
         WHERE ${baseConditions.join(' AND ')}`,
        baseParams
      );

      const conditions = [...baseConditions];
      const params = [...baseParams];
      if (reviewStatus === 'PENDING') {
        conditions.push("a.review_status IN ('PENDING', 'PENDING_REVIEW', 'NEEDS_RE_REVIEW')");
      } else if (reviewStatus === 'VERIFIED') {
        conditions.push("a.review_status IN ('REVIEWED', 'VERIFIED_APPROVED')");
      } else if (reviewStatus) {
        conditions.push('a.review_status = ?');
        params.push(reviewStatus);
      }

      let items: Array<Record<string, unknown>>;
      let totalCount: number;

      if (hasPagination) {
        const cntRows = await dbQuery<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE ${conditions.join(' AND ')}`,
          params
        );
        totalCount = Number(cntRows[0]?.cnt || 0);
        items = await dbQuery(
          `SELECT a.*, p.full_name, p.department_name, p.personnel_type_name, p.fingle_id
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY ${sort.col} ${sort.dir}, a.person_id ASC, a.scheduled_start ASC
           LIMIT ? OFFSET ?`,
          [...params, pageSize, (page - 1) * pageSize]
        );
      } else {
        items = await dbQuery(
          `SELECT a.*, p.full_name, p.department_name, p.personnel_type_name, p.fingle_id
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY ${sort.col} ${sort.dir}, a.person_id ASC, a.scheduled_start ASC`,
          params
        );
        totalCount = items.length;
      }

      res.json({
        items,
        totalCount,
        page: hasPagination ? page : 1,
        pageSize: hasPagination ? pageSize : totalCount || 50,
        totalPages: hasPagination ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1,
        tabCounts: {
          all: Number(tabCountRows[0]?.totalCount || 0),
          pending: Number(tabCountRows[0]?.pendingCount || 0),
          verified: Number(tabCountRows[0]?.verifiedCount || 0),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// B7. Attendance Review Queue & Notes / Review / Reprocess
attendanceRouter.get(
  '/attendance-review',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.query.dateFrom || bkk.monthStartYmd).trim();
      const dateTo = String(req.query.dateTo || bkk.monthEndYmd).trim();
      const statusFilter = String(req.query.status || '').trim();
      const reviewStatus = String(req.query.reviewStatus || '').trim().toUpperCase();
      const search = String(req.query.search || '').trim();
      const hasPagination = req.query.page !== undefined || req.query.pageSize !== undefined;
      const page = Math.max(1, Number.parseInt(String(req.query.page || '1'), 10) || 1);
      const rawPageSize = Number.parseInt(String(req.query.pageSize || '50'), 10);
      const pageSize = Number.isFinite(rawPageSize) ? Math.min(200, Math.max(1, rawPageSize)) : 50;
      const sort = resolveAttendanceSort(req.query.sortBy, req.query.sortDir);

      const baseConditions = [
        'a.work_date >= ?',
        'a.work_date <= ?',
        "(a.status IN ('NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'LATE', 'PENDING_MAPPING') OR a.is_late = 1 OR a.early_checkout_indicator = 1 OR a.review_status = 'NEEDS_RE_REVIEW')",
      ];
      const baseParams: unknown[] = [dateFrom, dateTo];

      if (statusFilter) {
        applyAttendanceStatusFilter(statusFilter, baseConditions, baseParams);
      }
      if (search) {
        baseConditions.push('(a.person_id LIKE ? OR p.full_name LIKE ?)');
        baseParams.push(`%${search}%`, `%${search}%`);
      }

      const tabCountRows = await dbQuery<{
        totalCount: number;
        pendingCount: number;
        verifiedCount: number;
      }>(
        `SELECT COUNT(*) AS totalCount,
                SUM(CASE WHEN a.review_status IN ('PENDING', 'PENDING_REVIEW', 'NEEDS_RE_REVIEW') THEN 1 ELSE 0 END) AS pendingCount,
                SUM(CASE WHEN a.review_status IN ('REVIEWED', 'VERIFIED_APPROVED') THEN 1 ELSE 0 END) AS verifiedCount
         FROM attendance a
         INNER JOIN personnel p ON p.person_id = a.person_id
         WHERE ${baseConditions.join(' AND ')}`,
        baseParams
      );

      const conditions = [...baseConditions];
      const params = [...baseParams];
      if (reviewStatus === 'PENDING') {
        conditions.push("a.review_status IN ('PENDING', 'PENDING_REVIEW', 'NEEDS_RE_REVIEW')");
      } else if (reviewStatus === 'VERIFIED') {
        conditions.push("a.review_status IN ('REVIEWED', 'VERIFIED_APPROVED')");
      } else if (reviewStatus) {
        conditions.push('a.review_status = ?');
        params.push(reviewStatus);
      }

      let items: Array<Record<string, unknown>>;
      let totalCount: number;
      if (hasPagination) {
        const cntRows = await dbQuery<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE ${conditions.join(' AND ')}`,
          params
        );
        totalCount = Number(cntRows[0]?.cnt || 0);
        items = await dbQuery(
          `SELECT a.*, p.full_name, p.department_name, p.personnel_type_name, p.fingle_id
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY ${sort.col} ${sort.dir}, a.person_id ASC, a.scheduled_start ASC
           LIMIT ? OFFSET ?`,
          [...params, pageSize, (page - 1) * pageSize]
        );
      } else {
        items = await dbQuery(
          `SELECT a.*, p.full_name, p.department_name, p.personnel_type_name, p.fingle_id
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY ${sort.col} ${sort.dir}, a.person_id ASC, a.scheduled_start ASC`,
          params
        );
        totalCount = items.length;
      }

      const notes = await dbQuery('SELECT * FROM attendance_notes ORDER BY id DESC LIMIT 200');
      const reviewHistory = await dbQuery('SELECT * FROM hr_review_history ORDER BY id DESC LIMIT 50');
      const matchingHistory = await dbQuery(
        'SELECT * FROM attendance_matching_history ORDER BY id DESC LIMIT 50'
      );
      const leaves = await dbQuery(
        `SELECT * FROM attendance_leaves
         WHERE status = 'ACTIVE' AND work_date >= ? AND work_date <= ?
         ORDER BY work_date DESC, id DESC`,
        [dateFrom, dateTo]
      );

      res.json({
        items,
        totalCount,
        page: hasPagination ? page : 1,
        pageSize: hasPagination ? pageSize : totalCount || 50,
        totalPages: hasPagination ? Math.max(1, Math.ceil(totalCount / pageSize)) : 1,
        tabCounts: {
          all: Number(tabCountRows[0]?.totalCount || 0),
          pending: Number(tabCountRows[0]?.pendingCount || 0),
          verified: Number(tabCountRows[0]?.verifiedCount || 0),
        },
        notes,
        reviewHistory,
        matchingHistory,
        leaves,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ATT-15: Half-Day / Partial Leave Endpoints (Never modifies shift templates)
attendanceRouter.get(
  '/attendance/leaves',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.query.dateFrom || bkk.monthStartYmd).trim();
      const dateTo = String(req.query.dateTo || bkk.monthEndYmd).trim();
      const personId = String(req.query.personId || '').trim();

      const conditions = ["l.status = 'ACTIVE'", 'l.work_date >= ?', 'l.work_date <= ?'];
      const params: unknown[] = [dateFrom, dateTo];
      if (personId) {
        conditions.push('l.person_id = ?');
        params.push(personId);
      }

      const items = await dbQuery(
        `SELECT l.*, p.full_name, p.department_name
         FROM attendance_leaves l
         INNER JOIN personnel p ON p.person_id = l.person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY l.work_date DESC, l.id DESC`,
        params
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.post(
  '/attendance/leaves',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const personId = String(req.body?.personId || '').trim();
      const workDate = String(req.body?.workDate || '').trim();
      const shiftAssignmentIdRaw = req.body?.shiftAssignmentId;
      const shiftAssignmentId =
        shiftAssignmentIdRaw !== undefined &&
        shiftAssignmentIdRaw !== null &&
        String(shiftAssignmentIdRaw).trim() !== ''
          ? Number(shiftAssignmentIdRaw)
          : null;
      const leaveType = String(req.body?.leaveType || 'HALF_DAY_MORNING').trim().toUpperCase();
      const leaveStartTime = String(req.body?.leaveStartTime || '').trim();
      const leaveEndTime = String(req.body?.leaveEndTime || '').trim();
      const reason = req.body?.reason ? String(req.body.reason).trim() : null;
      const autoReprocess = req.body?.autoReprocess !== false;
      const referenceNowBkk = req.body?.referenceNowBkk
        ? String(req.body.referenceNowBkk).trim()
        : undefined;

      if (!personId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสบุคลากร (personId) และวันที่ลาในรูปแบบ YYYY-MM-DD',
          requestId: req.requestId,
        });
        return;
      }
      if (!ALLOWED_LEAVE_TYPES.has(leaveType)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'ประเภทการลาต้องเป็น HALF_DAY_MORNING, HALF_DAY_AFTERNOON หรือ CUSTOM_PARTIAL',
          requestId: req.requestId,
        });
        return;
      }
      if (!/^\d{2}:\d{2}$/.test(leaveStartTime) || !/^\d{2}:\d{2}$/.test(leaveEndTime)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุเวลาเริ่มลาและเวลาสิ้นสุดการลาในรูปแบบ HH:mm',
          requestId: req.requestId,
        });
        return;
      }
      if (leaveStartTime >= leaveEndTime) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'เวลาเริ่มลาต้องน้อยกว่าเวลาสิ้นสุดการลา',
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(workDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถบันทึกการลาในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      const personRows = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE person_id = ? LIMIT 1',
        [personId]
      );
      if (personRows.length === 0) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'ไม่พบข้อมูลบุคลากรที่ต้องการบันทึกการลา',
          requestId: req.requestId,
        });
        return;
      }

      const ins = await dbExecute(
        `INSERT INTO attendance_leaves (
          person_id, work_date, shift_assignment_id, leave_type, leave_start_time, leave_end_time,
          reason, status, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
        [
          personId,
          workDate,
          shiftAssignmentId,
          leaveType,
          leaveStartTime,
          leaveEndTime,
          reason,
          req.user!.username,
        ]
      );

      let reprocessResult: unknown = null;
      if (autoReprocess) {
        reprocessResult = await reprocessAttendanceRange({
          dateFrom: workDate,
          dateTo: workDate,
          personId,
          referenceNowBkk,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          requestId: req.requestId,
          ipAddress: req.ip || '127.0.0.1',
        });
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_LEAVE_CREATED',
        targetType: 'ATTENDANCE_LEAVE',
        targetId: String(ins.insertId),
        result: 'SUCCESS',
        detail: {
          personId,
          workDate,
          shiftAssignmentId,
          leaveType,
          leaveStartTime,
          leaveEndTime,
          reason,
        },
      });

      res.status(201).json({
        id: ins.insertId,
        personId,
        workDate,
        shiftAssignmentId,
        leaveType,
        leaveStartTime,
        leaveEndTime,
        reason,
        status: 'ACTIVE',
        reprocessResult,
      });
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.delete(
  '/attendance/leaves/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const leaveId = Number(req.params.id);
      if (!Number.isInteger(leaveId) || leaveId <= 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รหัสรายการลาไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const rows = await dbQuery<{ id: number; person_id: string; work_date: string }>(
        "SELECT id, person_id, work_date FROM attendance_leaves WHERE id = ? AND status = 'ACTIVE' LIMIT 1",
        [leaveId]
      );
      if (rows.length === 0) {
        res.status(404).json({
          error: 'LEAVE_NOT_FOUND',
          message: 'ไม่พบรายการลาที่ต้องการยกเลิก',
          requestId: req.requestId,
        });
        return;
      }

      const lv = rows[0];
      const periodLock = await isPeriodClosed(lv.work_date);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถยกเลิกการลาในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      await dbExecute(
        "UPDATE attendance_leaves SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [leaveId]
      );

      let reprocessResult: unknown = null;
      if (String(req.query.autoReprocess || 'true').toLowerCase() !== 'false') {
        reprocessResult = await reprocessAttendanceRange({
          dateFrom: String(lv.work_date).slice(0, 10),
          dateTo: String(lv.work_date).slice(0, 10),
          personId: lv.person_id,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          requestId: req.requestId,
          ipAddress: req.ip || '127.0.0.1',
        });
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_LEAVE_CANCELLED',
        targetType: 'ATTENDANCE_LEAVE',
        targetId: String(leaveId),
        result: 'SUCCESS',
        detail: { personId: lv.person_id, workDate: lv.work_date },
      });

      res.json({
        status: 'CANCELLED',
        id: leaveId,
        reprocessResult,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ATT-15: Attendance Matching Central Settings (half_day_pre_checkin_window_minutes: 30/60/120)
attendanceRouter.get(
  '/attendance/settings',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const halfDayPreCheckinWindowMinutes = await getHalfDayPreCheckinWindowMinutes();
      const rows = await dbQuery('SELECT * FROM attendance_settings ORDER BY setting_key ASC');
      res.json({
        halfDayPreCheckinWindowMinutes,
        settings: rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.put(
  '/attendance/settings',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const minutes = Number(req.body?.halfDayPreCheckinWindowMinutes);
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 240) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message:
            'ค่าช่วงเวลารับสแกนเข้าก่อนเริ่มงานหลังลาครึ่งวันต้องเป็นจำนวนเต็มระหว่าง 0 ถึง 240 นาที (เช่น 30, 60, 120)',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ setting_key: string }>(
        "SELECT setting_key FROM attendance_settings WHERE setting_key = 'half_day_pre_checkin_window_minutes' LIMIT 1"
      );
      if (existing.length === 0) {
        await dbExecute(
          `INSERT INTO attendance_settings (setting_key, setting_value, description, updated_by)
           VALUES ('half_day_pre_checkin_window_minutes', ?, 'ช่วงเวลารับสแกนเข้าก่อนเวลาเริ่มปฏิบัติงานหลังลาครึ่งวันเช้า (นาที)', ?)`,
          [String(minutes), req.user!.username]
        );
      } else {
        await dbExecute(
          `UPDATE attendance_settings
           SET setting_value = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE setting_key = 'half_day_pre_checkin_window_minutes'`,
          [String(minutes), req.user!.username]
        );
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_SETTINGS_UPDATED',
        targetType: 'ATTENDANCE_SETTINGS',
        targetId: 'half_day_pre_checkin_window_minutes',
        result: 'SUCCESS',
        detail: { halfDayPreCheckinWindowMinutes: minutes },
      });

      res.json({
        status: 'UPDATED',
        halfDayPreCheckinWindowMinutes: minutes,
      });
    } catch (err) {
      next(err);
    }
  }
);

// Reprocess Preview & Execute (defined before :id routes)
attendanceRouter.post(
  '/attendance/reprocess/preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.body?.dateFrom || bkk.yesterdayYmd).trim();
      const dateTo = String(req.body?.dateTo || bkk.todayYmd).trim();
      const personId = req.body?.personId ? String(req.body.personId).trim() : undefined;
      const referenceNowBkk = req.body?.referenceNowBkk
        ? String(req.body.referenceNowBkk).trim()
        : undefined;

      try {
        assertRoleAuthorizedForDateRange({
          role: req.user!.role,
          syncMode: 'CUSTOM_RANGE',
          dateFrom,
          dateTo,
        });
      } catch (authErr: unknown) {
        if (authErr instanceof ScannerSyncRangeError) {
          res.status(authErr.statusCode).json({
            error: authErr.code,
            message: authErr.message,
            requestId: req.requestId,
          });
          return;
        }
        throw authErr;
      }

      const preview = await previewReprocessRange({
        dateFrom,
        dateTo,
        personId,
        referenceNowBkk,
        actorUsername: req.user!.username,
      });

      res.json(preview);
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.post(
  '/attendance/reprocess',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.body?.dateFrom || bkk.yesterdayYmd).trim();
      const dateTo = String(req.body?.dateTo || bkk.todayYmd).trim();
      const personId = req.body?.personId ? String(req.body.personId).trim() : undefined;
      const referenceNowBkk = req.body?.referenceNowBkk
        ? String(req.body.referenceNowBkk).trim()
        : undefined;

      try {
        assertRoleAuthorizedForDateRange({
          role: req.user!.role,
          syncMode: 'CUSTOM_RANGE',
          dateFrom,
          dateTo,
        });
      } catch (authErr: unknown) {
        if (authErr instanceof ScannerSyncRangeError) {
          res.status(authErr.statusCode).json({
            error: authErr.code,
            message: authErr.message,
            requestId: req.requestId,
          });
          return;
        }
        throw authErr;
      }

      const closedMonths = await findClosedPeriodsInRange(dateFrom, dateTo);
      if (closedMonths.length > 0) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถสั่งประมวลผลเวลาซ้ำในช่วงที่มีเดือนที่ปิดรอบบัญชีแล้ว (${closedMonths.join(', ')})`,
          closedPeriods: closedMonths,
          requestId: req.requestId,
        });
        return;
      }

      const result = await reprocessAttendanceRange({
        dateFrom,
        dateTo,
        personId,
        referenceNowBkk,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        requestId: req.requestId,
        ipAddress: req.ip || '127.0.0.1',
      });

      res.json({
        status: 'REPROCESSED',
        ...result,
      });
    } catch (err) {
      next(err);
    }
  }
);

// ATT-09 & TC-25: Inspect all raw scans around a shift (used vs extra unused) with strict Own-Only enforcement for GENERAL_USER
attendanceRouter.get('/attendance/:id/scans', requireAuth, async (req, res, next) => {
  try {
    const attendanceId = Number(req.params.id);
    if (!Number.isInteger(attendanceId) || attendanceId <= 0) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'รหัสรายการลงเวลาไม่ถูกต้อง',
        requestId: req.requestId,
      });
      return;
    }

    const attRows = await dbQuery<{
      id: number;
      person_id: string;
      work_date: string;
      shift_code: string | null;
      shift_name: string | null;
      scheduled_start: string | null;
      scheduled_end: string | null;
      evaluated_start_time: string | null;
      evaluated_end_time: string | null;
      check_in_raw_scan_id: number | null;
      check_out_raw_scan_id: number | null;
      status: string;
      attendance_status: string | null;
      early_checkout_indicator: number;
      early_checkout_minutes: number;
      review_status: string;
      matching_rule: string | null;
    }>('SELECT * FROM attendance WHERE id = ? LIMIT 1', [attendanceId]);

    if (attRows.length === 0) {
      res.status(404).json({
        error: 'ATTENDANCE_NOT_FOUND',
        message: 'ไม่พบรายการลงเวลาที่ต้องการตรวจสอบ',
        requestId: req.requestId,
      });
      return;
    }

    const att = attRows[0];
    // Strict Own-Only authorization check for GENERAL_USER (TC-25)
    if (req.user!.role === 'GENERAL_USER') {
      if (
        !req.user!.approvedPersonId ||
        String(att.person_id).trim() !== String(req.user!.approvedPersonId).trim()
      ) {
        res.status(403).json({
          error: 'FORBIDDEN_OWN_DATA_ONLY',
          message: 'ไม่อนุญาตให้ดูข้อมูลหลักฐานการสแกนของบุคลากรท่านอื่น',
          requestId: req.requestId,
        });
        return;
      }
    }

    const workDateStr = String(att.work_date).slice(0, 10);
    const windowStart = `${addDaysYmd(workDateStr, -1)} 00:00:00`;
    const windowEnd = `${addDaysYmd(workDateStr, 1)} 23:59:59`;

    const rawScanRows = await dbQuery<{
      id: number;
      machine_no: number;
      enroll_number: string;
      scan_date_time: string;
      canonical_bkk_time: string;
      verify_mode: number;
      in_out_mode: number;
      work_code: number;
      usage_attendance_id: number | null;
      usage_role: string | null;
      usage_work_date: string | null;
      usage_shift_code: string | null;
    }>(
      `SELECT rs.id, rs.machine_no, rs.enroll_number, rs.scan_date_time, rs.canonical_bkk_time,
              rs.verify_mode, rs.in_out_mode, rs.work_code,
              u.attendance_id AS usage_attendance_id,
              u.usage_role AS usage_role,
              u.work_date AS usage_work_date,
              u.shift_code AS usage_shift_code
       FROM raw_scans rs
       INNER JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
       LEFT JOIN attendance_raw_scan_usage u ON u.raw_scan_id = rs.id
       WHERE rsm.matched_person_id = ?
         AND rsm.mapping_state = 'MATCHED'
         AND rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?
       ORDER BY rs.canonical_bkk_time ASC, rs.id ASC`,
      [att.person_id, windowStart, windowEnd]
    );

    const scans = rawScanRows.map((s) => {
      let relationToShift:
        | 'USED_AS_IN_THIS_SHIFT'
        | 'USED_AS_OUT_THIS_SHIFT'
        | 'USED_BY_OTHER_SHIFT'
        | 'EXTRA_UNUSED';

      if (s.usage_attendance_id !== null && Number(s.usage_attendance_id) === Number(att.id)) {
        relationToShift =
          s.usage_role === 'CHECK_IN' ? 'USED_AS_IN_THIS_SHIFT' : 'USED_AS_OUT_THIS_SHIFT';
      } else if (s.usage_attendance_id !== null) {
        relationToShift = 'USED_BY_OTHER_SHIFT';
      } else {
        relationToShift = 'EXTRA_UNUSED';
      }

      return {
        ...s,
        relationToShift,
      };
    });

    const matchingHistory = await dbQuery(
      `SELECT * FROM attendance_matching_history
       WHERE attendance_id = ?
       ORDER BY id DESC LIMIT 20`,
      [attendanceId]
    );

    const notes =
      req.user!.role === 'GENERAL_USER'
        ? await dbQuery(
            `SELECT id, attendance_id, reason_type, note_text, needs_re_review, created_by, created_at
             FROM attendance_notes
             WHERE attendance_id = ? AND visible_to_employee = 1
             ORDER BY id DESC`,
            [attendanceId]
          )
        : await dbQuery(
            `SELECT id, attendance_id, reason_type, note_text, needs_re_review, visible_to_employee, created_by, created_at
             FROM attendance_notes
             WHERE attendance_id = ?
             ORDER BY id DESC`,
            [attendanceId]
          );

    res.json({
      attendance: att,
      scans,
      usedScansCount: scans.filter(
        (s) =>
          s.relationToShift === 'USED_AS_IN_THIS_SHIFT' ||
          s.relationToShift === 'USED_AS_OUT_THIS_SHIFT'
      ).length,
      extraScansCount: scans.filter((s) => s.relationToShift === 'EXTRA_UNUSED').length,
      matchingHistory,
      notes,
    });
  } catch (err) {
    next(err);
  }
});

attendanceRouter.post(
  '/attendance/:id/notes',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const attendanceId = Number(req.params.id);
      const reasonType = String(req.body?.reasonType || 'LEAVE_OR_OFFICIAL').trim();
      const noteText = String(req.body?.noteText || '').trim();
      const visibleToEmployee = req.body?.visibleToEmployee !== false ? 1 : 0;

      if (!noteText) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรายละเอียดหมายเหตุหรือเหตุผล',
          requestId: req.requestId,
        });
        return;
      }

      const attRows = await dbQuery<{ id: number; person_id: string; work_date: string }>(
        'SELECT id, person_id, work_date FROM attendance WHERE id = ? LIMIT 1',
        [attendanceId]
      );
      if (attRows.length === 0) {
        res.status(404).json({
          error: 'ATTENDANCE_NOT_FOUND',
          message: 'ไม่พบรายการลงเวลาที่ต้องการบันทึกหมายเหตุ',
          requestId: req.requestId,
        });
        return;
      }

      const att = attRows[0];
      const periodLock = await isPeriodClosed(att.work_date);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถเพิ่มหมายเหตุในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      const result = await dbExecute(
        `INSERT INTO attendance_notes (
          attendance_id, person_id, work_date, reason_type, note_text, visible_to_employee, needs_re_review, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        [attendanceId, att.person_id, att.work_date, reasonType, noteText, visibleToEmployee, req.user!.username]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_NOTE_ADDED',
        targetType: 'ATTENDANCE',
        targetId: String(attendanceId),
        result: 'SUCCESS',
        detail: { personId: att.person_id, workDate: att.work_date, reasonType, noteText },
      });

      res.status(201).json({
        id: result.insertId,
        attendanceId,
        personId: att.person_id,
        workDate: att.work_date,
        reasonType,
        noteText,
      });
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.post(
  '/attendance/:id/review',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const attendanceId = Number(req.params.id);
      const newReviewStatus = String(req.body?.reviewStatus || 'REVIEWED').trim().toUpperCase();
      const reviewReasonCategory = String(req.body?.reviewReasonCategory || 'VERIFIED_BY_HR').trim();
      const reviewComment = String(req.body?.reviewComment || '').trim();

      if (!ALLOWED_REVIEW_STATUSES.has(newReviewStatus)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'สถานะการตรวจสอบ HR ไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      if (!reviewComment) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุความเห็นหรือผลการตรวจสอบ',
          requestId: req.requestId,
        });
        return;
      }

      const attRows = await dbQuery<{
        id: number;
        person_id: string;
        work_date: string;
        status: string;
        attendance_status: string | null;
        early_checkout_indicator: number;
        early_checkout_minutes: number;
        review_status: string;
        record_version: number | null;
      }>(
        `SELECT id, person_id, work_date, status, attendance_status,
                early_checkout_indicator, early_checkout_minutes, review_status,
                COALESCE(record_version, 1) AS record_version
         FROM attendance WHERE id = ? LIMIT 1`,
        [attendanceId]
      );

      if (attRows.length === 0) {
        res.status(404).json({
          error: 'ATTENDANCE_NOT_FOUND',
          message: 'ไม่พบรายการลงเวลาที่ต้องการตรวจสอบ',
          requestId: req.requestId,
        });
        return;
      }

      const att = attRows[0];
      const periodLock = await isPeriodClosed(att.work_date);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถแก้ไขผลการตรวจสอบในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      const currentVersion = Number(att.record_version || 1);
      if (
        req.body?.recordVersion !== undefined &&
        Number(req.body.recordVersion) !== currentVersion
      ) {
        res.status(409).json({
          error: 'OPTIMISTIC_LOCK_CONFLICT',
          message: 'ข้อมูลรายการลงเวลานี้ถูกแก้ไขโดยผู้ใช้อื่นแล้ว กรุณาโหลดหน้าใหม่ก่อนบันทึก',
          currentVersion,
          requestId: req.requestId,
        });
        return;
      }

      // ATT-11 / ATT-12: Update ONLY review metadata — preserve derived attendance status, early_checkout, check_in/out times, and never touch raw_scans
      const updateRes = await dbExecute(
        `UPDATE attendance
         SET review_status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
             record_version = COALESCE(record_version, 1) + 1
         WHERE id = ? AND COALESCE(record_version, 1) = ?`,
        [newReviewStatus, reviewComment, req.user!.username, attendanceId, currentVersion]
      );
      if (updateRes.affectedRows === 0) {
        res.status(409).json({
          error: 'OPTIMISTIC_LOCK_CONFLICT',
          message: 'ข้อมูลรายการลงเวลานี้ถูกเปลี่ยนแปลงพร้อมกัน กรุณาโหลดหน้าใหม่แล้วลองอีกครั้ง',
          requestId: req.requestId,
        });
        return;
      }

      // Clear needs_re_review flag on notes once HR has re-reviewed
      if (newReviewStatus === 'REVIEWED' || newReviewStatus === 'VERIFIED_APPROVED') {
        await dbExecute(
          'UPDATE attendance_notes SET needs_re_review = 0 WHERE attendance_id = ?',
          [attendanceId]
        );
      }

      const result = await dbExecute(
        `INSERT INTO hr_review_history (
          attendance_id, person_id, work_date, previous_review_status,
          new_review_status, review_reason_category, review_comment, reviewed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          attendanceId,
          att.person_id,
          att.work_date,
          att.review_status,
          newReviewStatus,
          reviewReasonCategory,
          reviewComment,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_REVIEWED',
        targetType: 'ATTENDANCE',
        targetId: String(attendanceId),
        result: 'SUCCESS',
        detail: {
          personId: att.person_id,
          workDate: att.work_date,
          preservedAttendanceStatus: att.status,
          preservedCompletenessStatus: att.attendance_status,
          preservedEarlyCheckoutIndicator: att.early_checkout_indicator,
          preservedEarlyCheckoutMinutes: att.early_checkout_minutes,
          newReviewStatus,
          reviewReasonCategory,
          newRecordVersion: currentVersion + 1,
        },
      });

      res.json({
        id: result.insertId,
        attendanceId,
        recordVersion: currentVersion + 1,
        preservedAttendanceStatus: att.status,
        preservedCompletenessStatus: att.attendance_status,
        preservedEarlyCheckoutIndicator: att.early_checkout_indicator,
        preservedEarlyCheckoutMinutes: att.early_checkout_minutes,
        reviewStatus: newReviewStatus,
        reviewReason: reviewComment,
        reviewedBy: req.user!.username,
      });
    } catch (err) {
      next(err);
    }
  }
);

// B7: Bulk HR Review Preview & Execute (Partial-Success + Optimistic Locking + Period Guard)
attendanceRouter.post(
  '/attendance/bulk-review/preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const rawIds: unknown[] = Array.isArray(req.body?.attendanceIds) ? req.body.attendanceIds : [];
      const attendanceIds = Array.from(
        new Set<number>(
          rawIds.map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0)
        )
      );
      const targetReviewStatus = String(req.body?.targetReviewStatus || 'VERIFIED_APPROVED')
        .trim()
        .toUpperCase();
      const reviewComment = String(req.body?.reviewComment || '').trim();

      if (attendanceIds.length === 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกรายการลงเวลาอย่างน้อย 1 รายการ',
          requestId: req.requestId,
        });
        return;
      }

      if (!ALLOWED_REVIEW_STATUSES.has(targetReviewStatus)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'สถานะการตรวจสอบ HR ปลายทางไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const placeholders = attendanceIds.map(() => '?').join(', ');
      const foundRows = await dbQuery<{
        id: number;
        person_id: string;
        full_name: string;
        department_name: string;
        work_date: string;
        shift_code: string | null;
        status: string;
        attendance_status: string | null;
        review_status: string;
        record_version: number | null;
      }>(
        `SELECT a.id, a.person_id, p.full_name, p.department_name, a.work_date, a.shift_code,
                a.status, a.attendance_status, a.review_status,
                COALESCE(a.record_version, 1) AS record_version
         FROM attendance a
         LEFT JOIN personnel p ON p.person_id = a.person_id
         WHERE a.id IN (${placeholders})`,
        attendanceIds
      );
      const byId = new Map(foundRows.map((r) => [Number(r.id), r]));

      const eligibleItems: Array<Record<string, unknown>> = [];
      const ineligibleItems: Array<Record<string, unknown>> = [];

      for (const id of attendanceIds) {
        const row = byId.get(id);
        if (!row) {
          ineligibleItems.push({
            id,
            reasonCode: 'NOT_FOUND',
            reasonThai: 'ไม่พบรายการลงเวลาในฐานข้อมูล',
          });
          continue;
        }
        const periodLock = await isPeriodClosed(row.work_date);
        if (periodLock.closed) {
          ineligibleItems.push({
            id,
            personId: row.person_id,
            fullName: row.full_name,
            workDate: String(row.work_date).slice(0, 10),
            reasonCode: 'PERIOD_CLOSED',
            periodYm: periodLock.periodYm,
            reasonThai: `งวดเดือน ${periodLock.periodYm} ปิดรอบบัญชีเวลาแล้ว ไม่สามารถแก้ไขผลตรวจสอบได้`,
          });
          continue;
        }
        const requiresComment =
          targetReviewStatus === 'REJECTED' ||
          ['NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'LATE', 'PENDING_MAPPING'].includes(
            String(row.status || '').toUpperCase()
          );
        if (requiresComment && !reviewComment) {
          ineligibleItems.push({
            id,
            personId: row.person_id,
            fullName: row.full_name,
            workDate: String(row.work_date).slice(0, 10),
            status: row.status,
            reasonCode: 'COMMENT_REQUIRED',
            reasonThai: 'รายการสแกนไม่ครบ/สาย หรือการปฏิเสธผล ต้องระบุเหตุผลประกอบการตรวจสอบ',
          });
          continue;
        }
        eligibleItems.push({
          id: Number(row.id),
          personId: row.person_id,
          fullName: row.full_name,
          departmentName: row.department_name,
          workDate: String(row.work_date).slice(0, 10),
          shiftCode: row.shift_code,
          status: row.status,
          attendanceStatus: row.attendance_status,
          currentReviewStatus: row.review_status,
          recordVersion: Number(row.record_version || 1),
        });
      }

      res.json({
        targetReviewStatus,
        totalRequested: attendanceIds.length,
        eligibleCount: eligibleItems.length,
        ineligibleCount: ineligibleItems.length,
        eligibleItems,
        ineligibleItems,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

attendanceRouter.post(
  '/attendance/bulk-review',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const targetReviewStatus = String(req.body?.targetReviewStatus || 'VERIFIED_APPROVED')
        .trim()
        .toUpperCase();
      const reviewReasonCategory = String(req.body?.reviewReasonCategory || 'VERIFIED_BY_HR').trim();
      const reviewComment = String(req.body?.reviewComment || '').trim();

      if (!ALLOWED_REVIEW_STATUSES.has(targetReviewStatus)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'สถานะการตรวจสอบ HR ปลายทางไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const rawItems: Array<{ id: number; recordVersion?: number }> = Array.isArray(req.body?.items)
        ? req.body.items
            .map((item: { id?: unknown; recordVersion?: unknown }) => ({
              id: Number(item?.id),
              recordVersion:
                item?.recordVersion !== undefined ? Number(item.recordVersion) : undefined,
            }))
            .filter((item: { id: number }) => Number.isInteger(item.id) && item.id > 0)
        : Array.isArray(req.body?.attendanceIds)
          ? req.body.attendanceIds
              .map((id: unknown) => ({ id: Number(id) }))
              .filter((item: { id: number }) => Number.isInteger(item.id) && item.id > 0)
          : [];

      const uniqueItems = Array.from(new Map(rawItems.map((i) => [i.id, i])).values());
      if (uniqueItems.length === 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกรายการลงเวลาที่ต้องการตรวจสอบอย่างน้อย 1 รายการ',
          requestId: req.requestId,
        });
        return;
      }

      const succeeded: Array<{
        id: number;
        personId: string;
        workDate: string;
        newReviewStatus: string;
        newRecordVersion: number;
      }> = [];
      const failed: Array<{
        id: number;
        reasonCode: string;
        message: string;
      }> = [];

      for (const reqItem of uniqueItems) {
        const rows = await dbQuery<{
          id: number;
          person_id: string;
          work_date: string;
          status: string;
          review_status: string;
          record_version: number | null;
        }>(
          `SELECT id, person_id, work_date, status, review_status,
                  COALESCE(record_version, 1) AS record_version
           FROM attendance WHERE id = ? LIMIT 1`,
          [reqItem.id]
        );
        if (rows.length === 0) {
          failed.push({
            id: reqItem.id,
            reasonCode: 'NOT_FOUND',
            message: 'ไม่พบรายการลงเวลาในระบบ',
          });
          continue;
        }
        const att = rows[0];
        const periodLock = await isPeriodClosed(att.work_date);
        if (periodLock.closed) {
          failed.push({
            id: reqItem.id,
            reasonCode: 'PERIOD_CLOSED',
            message: `งวดเดือน ${periodLock.periodYm} ปิดรอบบัญชีเวลาแล้ว`,
          });
          continue;
        }

        const requiresComment =
          targetReviewStatus === 'REJECTED' ||
          ['NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'LATE', 'PENDING_MAPPING'].includes(
            String(att.status || '').toUpperCase()
          );
        if (requiresComment && !reviewComment) {
          failed.push({
            id: reqItem.id,
            reasonCode: 'COMMENT_REQUIRED',
            message: 'กรุณาระบุเหตุผลประกอบการตรวจสอบสำหรับรายการผิดปกติ/ปฏิเสธผล',
          });
          continue;
        }

        const currentVersion = Number(att.record_version || 1);
        if (reqItem.recordVersion !== undefined && reqItem.recordVersion !== currentVersion) {
          failed.push({
            id: reqItem.id,
            reasonCode: 'OPTIMISTIC_LOCK_CONFLICT',
            message: `รายการถูกแก้ไขโดยผู้อื่นแล้ว (เวอร์ชันปัจจุบัน ${currentVersion})`,
          });
          continue;
        }

        const finalComment = reviewComment || `ตรวจสอบแบบกลุ่ม (${targetReviewStatus})`;
        const updateRes = await dbExecute(
          `UPDATE attendance
           SET review_status = ?, review_reason = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP,
               record_version = COALESCE(record_version, 1) + 1
           WHERE id = ? AND COALESCE(record_version, 1) = ?`,
          [targetReviewStatus, finalComment, req.user!.username, reqItem.id, currentVersion]
        );
        if (updateRes.affectedRows === 0) {
          failed.push({
            id: reqItem.id,
            reasonCode: 'OPTIMISTIC_LOCK_CONFLICT',
            message: 'ข้อมูลถูกแก้ไขพร้อมกันระหว่างบันทึก กรุณาโหลดข้อมูลใหม่',
          });
          continue;
        }

        if (targetReviewStatus === 'REVIEWED' || targetReviewStatus === 'VERIFIED_APPROVED') {
          await dbExecute(
            'UPDATE attendance_notes SET needs_re_review = 0 WHERE attendance_id = ?',
            [reqItem.id]
          );
        }

        await dbExecute(
          `INSERT INTO hr_review_history (
            attendance_id, person_id, work_date, previous_review_status,
            new_review_status, review_reason_category, review_comment, reviewed_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            reqItem.id,
            att.person_id,
            att.work_date,
            att.review_status,
            targetReviewStatus,
            reviewReasonCategory,
            finalComment,
            req.user!.username,
          ]
        );

        succeeded.push({
          id: reqItem.id,
          personId: att.person_id,
          workDate: String(att.work_date).slice(0, 10),
          newReviewStatus: targetReviewStatus,
          newRecordVersion: currentVersion + 1,
        });
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_BULK_REVIEWED',
        targetType: 'ATTENDANCE_BATCH',
        targetId: `${succeeded.length}/${uniqueItems.length}`,
        result:
          failed.length === uniqueItems.length
            ? 'FAILURE'
            : failed.length > 0
              ? 'PARTIAL_SUCCESS'
              : 'SUCCESS',
        detail: {
          targetReviewStatus,
          reviewReasonCategory,
          totalRequested: uniqueItems.length,
          succeededCount: succeeded.length,
          failedCount: failed.length,
          failedReasons: failed.slice(0, 10),
        },
      });

      res.json({
        targetReviewStatus,
        totalRequested: uniqueItems.length,
        succeededCount: succeeded.length,
        failedCount: failed.length,
        partialSuccess: succeeded.length > 0 && failed.length > 0,
        succeeded,
        failed,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);
