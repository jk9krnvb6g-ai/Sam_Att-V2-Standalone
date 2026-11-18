import { Router } from 'express';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { requireAuth, requireRoles, enforceOwnPersonMapping } from '../../middleware/auth.ts';
import { previewReprocessRange, reprocessAttendanceRange } from './processor.ts';
import { writeAuditLog } from '../audit/service.ts';

export const attendanceRouter = Router();

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

      const items = await dbQuery<{
        id: number;
        person_id: string;
        work_date: string;
        shift_code: string | null;
        shift_name: string | null;
        scheduled_start: string | null;
        scheduled_end: string | null;
        check_in_time: string | null;
        check_out_time: string | null;
        status: string;
        secondary_flags: string | null;
        is_late: number;
        late_minutes: number;
        review_status: string;
      }>(
        `SELECT * FROM attendance
         WHERE person_id = ? AND work_date >= ? AND work_date <= ?
         ORDER BY work_date DESC`,
        [personId, dateFrom, dateTo]
      );

      const notes = await dbQuery<{
        id: number;
        attendance_id: number;
        reason_type: string;
        note_text: string;
        created_by: string;
        created_at: string;
      }>(
        `SELECT id, attendance_id, reason_type, note_text, created_by, created_at
         FROM attendance_notes
         WHERE person_id = ? AND visible_to_employee = 1
         ORDER BY id DESC`,
        [personId]
      );

      const totalShifts = items.length;
      const lateOccurrences = items.filter((i) => Number(i.is_late) === 1).length;
      const totalLateMinutes = items.reduce((acc, i) => acc + Number(i.late_minutes || 0), 0);

      res.json({
        personId,
        summary: {
          totalShifts,
          lateOccurrences,
          totalLateMinutes,
          normalCount: items.filter((i) => i.status === 'NORMAL').length,
          noScanCount: items.filter((i) => i.status === 'NO_SCAN').length,
          missingCheckoutCount: items.filter((i) => i.status === 'MISSING_CHECKOUT').length,
        },
        items,
        notes,
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

// B6. HR Attendance Management (Organization-Wide)
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
      const search = String(req.query.search || '').trim();

      const conditions = ['a.work_date >= ?', 'a.work_date <= ?'];
      const params: unknown[] = [dateFrom, dateTo];

      if (department) {
        conditions.push('p.department_name = ?');
        params.push(department);
      }
      if (personnelType) {
        conditions.push('p.personnel_type_code = ?');
        params.push(personnelType);
      }
      if (status) {
        conditions.push('a.status = ?');
        params.push(status);
      }
      if (search) {
        conditions.push('(a.person_id LIKE ? OR p.full_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`);
      }

      const items = await dbQuery(
        `SELECT a.*, p.full_name, p.department_name, p.personnel_type_name, p.fingle_id
         FROM attendance a
         INNER JOIN personnel p ON p.person_id = a.person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.work_date DESC, a.person_id ASC`,
        params
      );

      res.json({ items });
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

      const conditions = [
        'a.work_date >= ?',
        'a.work_date <= ?',
        "(a.status IN ('NO_SCAN', 'MISSING_CHECKOUT', 'LATE', 'PENDING_MAPPING') OR a.is_late = 1)",
      ];
      const params: unknown[] = [dateFrom, dateTo];

      if (statusFilter) {
        conditions.push('a.status = ?');
        params.push(statusFilter);
      }

      const items = await dbQuery(
        `SELECT a.*, p.full_name, p.department_name, p.personnel_type_name, p.fingle_id
         FROM attendance a
         INNER JOIN personnel p ON p.person_id = a.person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY a.work_date DESC, a.person_id ASC`,
        params
      );

      const notes = await dbQuery('SELECT * FROM attendance_notes ORDER BY id DESC');
      const reviewHistory = await dbQuery('SELECT * FROM hr_review_history ORDER BY id DESC LIMIT 50');

      res.json({
        items,
        notes,
        reviewHistory,
      });
    } catch (err) {
      next(err);
    }
  }
);

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
      const result = await dbExecute(
        `INSERT INTO attendance_notes (
          attendance_id, person_id, work_date, reason_type, note_text, visible_to_employee, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      const newReviewStatus = String(req.body?.reviewStatus || 'REVIEWED').trim();
      const reviewReasonCategory = String(req.body?.reviewReasonCategory || 'VERIFIED_BY_HR').trim();
      const reviewComment = String(req.body?.reviewComment || '').trim();

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
        review_status: string;
      }>('SELECT id, person_id, work_date, status, review_status FROM attendance WHERE id = ? LIMIT 1', [
        attendanceId,
      ]);

      if (attRows.length === 0) {
        res.status(404).json({
          error: 'ATTENDANCE_NOT_FOUND',
          message: 'ไม่พบรายการลงเวลาที่ต้องการตรวจสอบ',
          requestId: req.requestId,
        });
        return;
      }

      const att = attRows[0];

      // Update review_status only — preserve derived attendance status (e.g., MISSING_CHECKOUT / NO_SCAN) and never touch raw_scans
      await dbExecute('UPDATE attendance SET review_status = ? WHERE id = ?', [
        newReviewStatus,
        attendanceId,
      ]);

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
          newReviewStatus,
          reviewReasonCategory,
        },
      });

      res.json({
        id: result.insertId,
        attendanceId,
        preservedAttendanceStatus: att.status,
        reviewStatus: newReviewStatus,
      });
    } catch (err) {
      next(err);
    }
  }
);

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
