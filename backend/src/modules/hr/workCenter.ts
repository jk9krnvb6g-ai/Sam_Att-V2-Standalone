import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { evaluateCompletenessSnapshot } from '../attendance/completeness.ts';
import { isPeriodClosed } from '../periods/lock.ts';
import { normalizeWorkDateString } from '../shifts/routes.ts';

export const hrWorkCenterRouter = Router();

export type WorkQueueBucket = 'URGENT' | 'TODAY' | 'PENDING' | 'COMPLETED';

// GET /hr-work-center/overview — ศูนย์ปฏิบัติการ HR รายวัน (รวมสรุปวันนี้ + คิวงานจัดลำดับความสำคัญ)
hrWorkCenterRouter.get(
  '/hr-work-center/overview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const bkk = getCurrentBangkokDateParts();
      const targetDate = req.query.date
        ? normalizeWorkDateString(req.query.date)
        : bkk.todayYmd;
      const dateFrom = req.query.dateFrom
        ? normalizeWorkDateString(req.query.dateFrom)
        : bkk.monthStartYmd;
      const dateTo = req.query.dateTo
        ? normalizeWorkDateString(req.query.dateTo)
        : bkk.todayYmd;
      const department = req.query.department ? String(req.query.department).trim() : '';

      const deptWhere = department ? ' AND p.department_name = ?' : '';
      const todayParams: unknown[] = department ? [targetDate, department] : [targetDate];
      const rangeParams: unknown[] = department
        ? [dateFrom, dateTo, department]
        : [dateFrom, dateTo];

      const [
        todayRows,
        rangeQueueRows,
        unmatchedRows,
        conflictRows,
        periodStatus,
        completenessSnapshot,
        lastSyncRows,
      ] = await Promise.all([
        dbQuery<{
          id: number;
          person_id: string;
          full_name: string;
          department_name: string;
          work_date: string;
          shift_code: string | null;
          shift_name: string | null;
          scheduled_start: string | null;
          scheduled_end: string | null;
          check_in_time: string | null;
          check_out_time: string | null;
          status: string;
          attendance_status: string | null;
          is_late: number;
          late_minutes: number;
          early_checkout_indicator: number;
          review_status: string;
          late_scan_review_required: number | null;
        }>(
          `SELECT a.id, a.person_id, p.full_name, p.department_name, a.work_date,
                  a.shift_code, a.shift_name, a.scheduled_start, a.scheduled_end,
                  a.check_in_time, a.check_out_time, a.status, a.attendance_status,
                  a.is_late, a.late_minutes, a.early_checkout_indicator, a.review_status,
                  COALESCE(a.late_scan_review_required, 0) AS late_scan_review_required
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE a.work_date = ?${deptWhere}
           ORDER BY a.scheduled_start ASC, p.full_name ASC`,
          todayParams
        ),
        dbQuery<{
          id: number;
          person_id: string;
          full_name: string;
          department_name: string;
          work_date: string;
          shift_code: string | null;
          shift_name: string | null;
          status: string;
          attendance_status: string | null;
          is_late: number;
          late_minutes: number;
          early_checkout_indicator: number;
          review_status: string;
          reviewed_by: string | null;
          reviewed_at: string | null;
          late_scan_review_required: number | null;
        }>(
          `SELECT a.id, a.person_id, p.full_name, p.department_name, a.work_date,
                  a.shift_code, a.shift_name, a.status, a.attendance_status,
                  a.is_late, a.late_minutes, a.early_checkout_indicator,
                  a.review_status, a.reviewed_by, a.reviewed_at,
                  COALESCE(a.late_scan_review_required, 0) AS late_scan_review_required
           FROM attendance a
           INNER JOIN personnel p ON p.person_id = a.person_id
           WHERE a.work_date >= ? AND a.work_date <= ?${deptWhere}
           ORDER BY a.work_date DESC, a.id DESC
           LIMIT 300`,
          rangeParams
        ),
        dbQuery<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM raw_scan_mappings WHERE mapping_state = 'UNMATCHED'`
        ),
        dbQuery<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM raw_scan_mappings WHERE mapping_state = 'CONFLICT'`
        ),
        isPeriodClosed(bkk.currentYearMonth),
        evaluateCompletenessSnapshot({
          dateFrom: targetDate,
          dateTo: targetDate,
          department: department || undefined,
        }),
        dbQuery<{ id: number; status: string; completed_at: string | null }>(
          'SELECT id, status, finished_at AS completed_at FROM sync_runs ORDER BY id DESC LIMIT 1'
        ),
      ]);

      const scheduledToday = Math.max(
        todayRows.length,
        completenessSnapshot.metrics.expectedShiftCount
      );
      const inProgressCount = todayRows.filter((r) =>
        ['IN_PROGRESS', 'LATE_IN_PROGRESS', 'NOT_STARTED', 'AWAITING_CHECKIN'].includes(
          String(r.status || '').toUpperCase()
        )
      ).length;
      const completedTodayCount = todayRows.filter(
        (r) =>
          String(r.attendance_status || '').toUpperCase() === 'COMPLETE' ||
          ['NORMAL', 'LATE'].includes(String(r.status || '').toUpperCase())
      ).length;
      const lateTodayCount = todayRows.filter(
        (r) => Number(r.is_late) === 1 || String(r.status || '').toUpperCase() === 'LATE'
      ).length;
      const missingScanTodayCount = todayRows.filter((r) =>
        ['NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT'].includes(
          String(r.status || '').toUpperCase()
        )
      ).length;

      const queueItems: Array<{
        attendanceId: number | null;
        personId: string | null;
        fullName: string;
        departmentName: string;
        workDate: string;
        shiftCode: string | null;
        status: string;
        reviewStatus: string;
        lateMinutes: number;
        priorityBucket: WorkQueueBucket;
        reasonThai: string;
        targetView: string;
      }> = [];

      for (const r of rangeQueueRows) {
        const workDate = normalizeWorkDateString(r.work_date);
        const st = String(r.status || '').toUpperCase();
        const rev = String(r.review_status || 'PENDING').toUpperCase();
        const isResolved = rev === 'REVIEWED' || rev === 'VERIFIED_APPROVED';
        const isAbnormal =
          ['NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'PENDING_MAPPING'].includes(st) ||
          Number(r.late_scan_review_required || 0) === 1 ||
          rev === 'NEEDS_RE_REVIEW';
        const isLateOrEarly =
          Number(r.is_late) === 1 || st === 'LATE' || Number(r.early_checkout_indicator) === 1;

        let bucket: WorkQueueBucket;
        let reasonThai = 'บันทึกเวลาปฏิบัติงานครบถ้วน';
        let targetView = 'hrAttendance';

        if (isResolved) {
          bucket = 'COMPLETED';
          reasonThai = `HR ตรวจสอบแล้ว (${rev})`;
        } else if (isAbnormal) {
          bucket = 'URGENT';
          targetView = 'attendanceReview';
          if (Number(r.late_scan_review_required || 0) === 1) {
            reasonThai = 'พบสแกนเข้ามาภายหลังในงวดที่ปิดรอบแล้ว รอ HR พิจารณา';
          } else if (rev === 'NEEDS_RE_REVIEW') {
            reasonThai = 'ผลจับคู่เวลาเปลี่ยนแปลงหลังเคยตรวจสอบ รอตรวจซ้ำ';
          } else if (st === 'NO_SCAN') {
            reasonThai = 'ไม่มีข้อมูลสแกนเข้า-ออกงาน';
          } else if (st === 'MISSING_CHECKIN') {
            reasonThai = 'ขาดสแกนเข้างาน';
          } else if (st === 'MISSING_CHECKOUT') {
            reasonThai = 'ขาดสแกนออกงาน';
          } else {
            reasonThai = 'รอผูกรหัสบุคลากรกับข้อมูลสแกน';
          }
        } else if (workDate === targetDate) {
          bucket = 'TODAY';
          reasonThai =
            Number(r.is_late) === 1
              ? `มาสาย ${Number(r.late_minutes || 0)} นาที (วันนี้)`
              : `สถานะวันนี้: ${st}`;
          targetView = isLateOrEarly ? 'attendanceReview' : 'hrAttendance';
        } else if (isLateOrEarly || rev === 'PENDING' || rev === 'PENDING_REVIEW') {
          bucket = 'PENDING';
          reasonThai =
            Number(r.is_late) === 1
              ? `มาสาย ${Number(r.late_minutes || 0)} นาที รอ HR ยืนยัน`
              : Number(r.early_checkout_indicator) === 1
                ? 'ออกก่อนเวลากะ รอ HR ตรวจสอบ'
                : 'รอ HR ตรวจสอบรายการ';
          targetView = 'attendanceReview';
        } else {
          bucket = 'COMPLETED';
        }

        queueItems.push({
          attendanceId: Number(r.id),
          personId: r.person_id,
          fullName: r.full_name,
          departmentName: r.department_name,
          workDate,
          shiftCode: r.shift_code,
          status: st,
          reviewStatus: rev,
          lateMinutes: Number(r.late_minutes || 0),
          priorityBucket: bucket,
          reasonThai,
          targetView,
        });
      }

      const pendingReviewCount = queueItems.filter(
        (q) => q.priorityBucket === 'URGENT' || q.priorityBucket === 'PENDING'
      ).length;

      res.json({
        targetDate,
        dateFrom,
        dateTo,
        department: department || null,
        overview: {
          scheduledToday,
          inProgress: inProgressCount,
          completed: completedTodayCount,
          late: lateTodayCount,
          missingScan: missingScanTodayCount,
          pendingReview: pendingReviewCount,
          incompleteData:
            completenessSnapshot.metrics.missingAttendanceCount +
            completenessSnapshot.metrics.unprocessedScanCount,
          unmatchedRawScans: Number(unmatchedRows[0]?.cnt || 0),
          conflictRawScans: Number(conflictRows[0]?.cnt || 0),
          lateScanReviewRequiredCount: todayRows.filter(
            (r) => Number(r.late_scan_review_required || 0) === 1
          ).length,
        },
        periodStatus,
        lastScannerSync: lastSyncRows[0] || null,
        hosofficePreviewReadiness: {
          livePushEnabled: cfg.hosofficePush.livePushEnabled,
          modeLabelThai: cfg.hosofficePush.livePushEnabled
            ? 'เปิดส่งข้อมูลจริง'
            : 'โหมดตรวจสอบพรีวิวก่อนส่ง (ไม่เขียนทับ HOSOffice)',
          approvedRecordsInRange: queueItems.filter((q) => q.priorityBucket === 'COMPLETED').length,
        },
        bucketCounts: {
          URGENT: queueItems.filter((q) => q.priorityBucket === 'URGENT').length,
          TODAY: queueItems.filter((q) => q.priorityBucket === 'TODAY').length,
          PENDING: queueItems.filter((q) => q.priorityBucket === 'PENDING').length,
          COMPLETED: queueItems.filter((q) => q.priorityBucket === 'COMPLETED').length,
        },
        queueItems: queueItems.slice(0, 200),
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);
