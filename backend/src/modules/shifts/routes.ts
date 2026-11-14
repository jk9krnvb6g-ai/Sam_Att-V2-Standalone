import { Router } from 'express';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export const shiftsRouter = Router();

shiftsRouter.get(
  '/shifts',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const items = await dbQuery('SELECT * FROM shifts ORDER BY id ASC');
      const rules = await dbQuery('SELECT * FROM personnel_type_rules ORDER BY id ASC');
      res.json({ items, personnelTypeRules: rules });
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

      if (!shiftCode || !shiftName || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime) || !/^\d{2}:\d{2}$/.test(cutoffTime)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสกะ ชื่อกะ เวลาเริ่ม-สิ้นสุด และเวลา Cutoff ในรูปแบบ HH:mm',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ id: number }>('SELECT id FROM shifts WHERE shift_code = ? LIMIT 1', [
        shiftCode,
      ]);
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
        [shiftCode, shiftName, shiftCategory, startTime, endTime, graceMinutes, cutoffTime, isCrossMidnight]
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
        detail: { shiftCode, shiftName, startTime, endTime, graceMinutes, cutoffTime, isCrossMidnight },
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

shiftsRouter.get(
  '/shift-assignments',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const dateFrom = String(req.query.dateFrom || '2026-11-01').trim();
      const dateTo = String(req.query.dateTo || '2026-11-30').trim();
      const personId = String(req.query.personId || '').trim();
      const status = String(req.query.status || '').trim();

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

      const items = await dbQuery(
        `SELECT sa.*, p.full_name, p.department_name, p.personnel_type_name
         FROM shift_assignments sa
         INNER JOIN personnel p ON p.person_id = sa.person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sa.work_date DESC, sa.snapshot_start_time ASC`,
        params
      );

      const cancellationLogs = await dbQuery(
        `SELECT scl.*, p.full_name
         FROM shift_cancellation_logs scl
         LEFT JOIN personnel p ON p.person_id = scl.person_id
         ORDER BY scl.id DESC LIMIT 20`
      );

      res.json({ items, cancellationLogs });
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
      const workDate = String(req.body?.workDate || '').trim();

      if (!personId || !shiftId || !/^\d{4}-\d{2}-\d{2}$/.test(workDate)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุบุคลากร กะ และวันที่ปฏิบัติงาน (YYYY-MM-DD)',
          requestId: req.requestId,
        });
        return;
      }

      const shifts = await dbQuery<{
        id: number;
        shift_code: string;
        shift_name: string;
        start_time: string;
        end_time: string;
        grace_minutes: number;
        cutoff_time: string;
        is_cross_midnight: number;
      }>('SELECT * FROM shifts WHERE id = ? AND is_active = 1 LIMIT 1', [shiftId]);

      if (shifts.length === 0) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบประเภทกะที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      const shift = shifts[0];

      // Check duplicate same shift on same date for same person
      const dup = await dbQuery<{ id: number }>(
        "SELECT id FROM shift_assignments WHERE person_id = ? AND shift_id = ? AND work_date = ? AND status = 'ACTIVE' LIMIT 1",
        [personId, shiftId, workDate]
      );
      if (dup.length > 0) {
        res.status(409).json({
          error: 'DUPLICATE_SHIFT_ASSIGNMENT',
          message: 'บุคลากรนี้ได้รับมอบหมายกะเดียวกันในวันที่เลือกไว้แล้ว',
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
      const cancelReason = String(req.body?.cancelReason || req.query.cancelReason || 'ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน').trim();

      const rows = await dbQuery<{
        id: number;
        person_id: string;
        work_date: string;
        snapshot_shift_code: string;
        status: string;
      }>('SELECT id, person_id, work_date, snapshot_shift_code, status FROM shift_assignments WHERE id = ? LIMIT 1', [
        assignmentId,
      ]);

      if (rows.length === 0) {
        res.status(404).json({
          error: 'ASSIGNMENT_NOT_FOUND',
          message: 'ไม่พบรายการตารางเวรที่ต้องการยกเลิก',
          requestId: req.requestId,
        });
        return;
      }

      const row = rows[0];
      await dbExecute(
        "UPDATE shift_assignments SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        [assignmentId]
      );

      await dbExecute(
        `INSERT INTO shift_cancellation_logs (
          shift_assignment_id, person_id, work_date, shift_code, cancel_reason, cancelled_by
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [assignmentId, row.person_id, row.work_date, row.snapshot_shift_code, cancelReason, req.user!.username]
      );

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
          personId: row.person_id,
          workDate: row.work_date,
          shiftCode: row.snapshot_shift_code,
          cancelReason,
        },
      });

      res.json({
        status: 'CANCELLED',
        id: assignmentId,
        cancelReason,
      });
    } catch (err) {
      next(err);
    }
  }
);
