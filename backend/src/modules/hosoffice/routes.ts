import crypto from 'crypto';
import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export const hosofficeRouter = Router();

interface PushCandidateRow {
  id: number;
  person_id: string;
  fingle_id: string | null;
  full_name: string;
  department_name: string;
  work_date: string;
  shift_code: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  status: string;
  is_late: number;
  late_minutes: number;
  review_status: string;
}

async function evaluatePushBatch(dateFrom: string, dateTo: string) {
  const rows = await dbQuery<PushCandidateRow>(
    `SELECT a.id, a.person_id, p.fingle_id, p.full_name, p.department_name,
            a.work_date, a.shift_code, a.check_in_time, a.check_out_time,
            a.status, a.is_late, a.late_minutes, a.review_status
     FROM attendance a
     INNER JOIN personnel p ON p.person_id = a.person_id
     WHERE a.work_date >= ? AND a.work_date <= ?
     ORDER BY a.work_date ASC, a.person_id ASC`,
    [dateFrom, dateTo]
  );

  const validItems: Array<Record<string, unknown>> = [];
  const invalidItems: Array<{
    attendanceId: number;
    personId: string;
    fullName: string;
    workDate: string;
    status: string;
    reason: string;
  }> = [];

  for (const r of rows) {
    if (r.status === 'PENDING_MAPPING' || !r.fingle_id) {
      invalidItems.push({
        attendanceId: r.id,
        personId: r.person_id,
        fullName: r.full_name,
        workDate: r.work_date,
        status: r.status,
        reason: 'รหัส FINGLE_ID ยังไม่สมบูรณ์หรือมีข้อขัดแย้งการจับคู่',
      });
      continue;
    }

    if ((r.status === 'NO_SCAN' || r.status === 'MISSING_CHECKOUT') && r.review_status === 'PENDING') {
      invalidItems.push({
        attendanceId: r.id,
        personId: r.person_id,
        fullName: r.full_name,
        workDate: r.work_date,
        status: r.status,
        reason: `รายการสถานะ ${r.status} ยังไม่ผ่านการตรวจสอบโดยเจ้าหน้าที่ HR (review_status = PENDING)`,
      });
      continue;
    }

    validItems.push({
      PERSON_ID: r.person_id,
      FINGLE_ID: r.fingle_id,
      WORK_DATE: r.work_date,
      SHIFT_CODE: r.shift_code,
      CHECK_IN_DATETIME: r.check_in_time,
      CHECK_OUT_DATETIME: r.check_out_time,
      ATTENDANCE_STATUS: r.status,
      LATE_MINUTES: Number(r.late_minutes || 0),
      HR_REVIEW_STATUS: r.review_status,
    });
  }

  return {
    totalRecords: rows.length,
    validItems,
    invalidItems,
  };
}

// B11. HOSOffice Push Preview (DRY_RUN — Zero External Write)
hosofficeRouter.post(
  '/hosoffice/push/preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const dateFrom = String(req.body?.dateFrom || '2026-11-12').trim();
      const dateTo = String(req.body?.dateTo || '2026-11-13').trim();
      const cfg = loadConfig();

      const batch = await evaluatePushBatch(dateFrom, dateTo);
      const idempotencyKey = `PREVIEW-${dateFrom}-${dateTo}-${crypto.randomUUID().slice(0, 8)}`;

      const payloadJson = JSON.stringify({
        contractStatus: cfg.hosofficePush.livePushEnabled
          ? 'LIVE_FLAG_ENABLED_AWAITING_TARGET_TABLE'
          : 'DRY_RUN_ONLY_LIVE_PUSH_DISABLED',
        dateFrom,
        dateTo,
        validRecords: batch.validItems,
        invalidRecords: batch.invalidItems,
      });

      await dbExecute(
        `INSERT INTO push_history (
          idempotency_key, push_mode, date_from, date_to,
          total_records, valid_records, invalid_records, status,
          payload_preview_json, initiated_by
        ) VALUES (?, 'DRY_RUN_PREVIEW', ?, ?, ?, ?, ?, 'PREVIEW_READY', ?, ?)`,
        [
          idempotencyKey,
          dateFrom,
          dateTo,
          batch.totalRecords,
          batch.validItems.length,
          batch.invalidItems.length,
          payloadJson,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOSOFFICE_PUSH_PREVIEW',
        targetType: 'HOSOFFICE_PUSH',
        targetId: idempotencyKey,
        result: 'SUCCESS',
        detail: {
          dateFrom,
          dateTo,
          totalRecords: batch.totalRecords,
          validCount: batch.validItems.length,
          invalidCount: batch.invalidItems.length,
        },
      });

      res.json({
        mode: 'DRY_RUN_PREVIEW',
        livePushEnabled: cfg.hosofficePush.livePushEnabled,
        idempotencyKey,
        dateFrom,
        dateTo,
        totalRecords: batch.totalRecords,
        validCount: batch.validItems.length,
        invalidCount: batch.invalidItems.length,
        validItems: batch.validItems,
        invalidItems: batch.invalidItems,
      });
    } catch (err) {
      next(err);
    }
  }
);

// B11. HOSOffice Live Push (Feature Flag Guarded — Fail-Closed by Default)
hosofficeRouter.post(
  '/hosoffice/push',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const dateFrom = String(req.body?.dateFrom || '2026-11-12').trim();
      const dateTo = String(req.body?.dateTo || '2026-11-13').trim();
      const idempotencyKey = String(req.body?.idempotencyKey || `LIVE-${dateFrom}-${dateTo}`).trim();

      if (!cfg.hosofficePush.livePushEnabled || !cfg.hosofficePush.targetTable) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSOFFICE_LIVE_PUSH_BLOCKED',
          targetType: 'HOSOFFICE_PUSH',
          targetId: idempotencyKey,
          result: 'BLOCKED',
          errorCode: 'HOSOFFICE_LIVE_PUSH_DISABLED',
          detail: {
            livePushEnabled: cfg.hosofficePush.livePushEnabled,
            targetTableConfigured: Boolean(cfg.hosofficePush.targetTable),
          },
        });

        res.status(403).json({
          error: 'HOSOFFICE_LIVE_PUSH_DISABLED',
          code: 'BLOCKED_BY_EXTERNAL_CONTRACT',
          message:
            'ปิดการส่งข้อมูลจริงเข้า HOSOffice (HOSOFFICE_LIVE_PUSH_ENABLED=false) ตามข้อกำหนดความปลอดภัย จนกว่าเจ้าของระบบจะอนุมัติ Schema ตารางปลายทางและสิทธิ์การเขียนบน HOSOffice Test DB',
          sideEffectsWritten: 0,
          requestId: req.requestId,
        });
        return;
      }

      // Check idempotency key to prevent duplicate live push
      const existing = await dbQuery<{ id: number; status: string }>(
        "SELECT id, status FROM push_history WHERE idempotency_key = ? AND push_mode = 'LIVE_PUSH' LIMIT 1",
        [idempotencyKey]
      );
      if (existing.length > 0) {
        res.status(409).json({
          error: 'DUPLICATE_IDEMPOTENCY_KEY',
          message: `ชุดข้อมูลที่มี Idempotency Key ${idempotencyKey} เคยถูกประมวลผลแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      res.status(503).json({
        error: 'BLOCKED_BY_EXTERNAL_CONTRACT',
        message: 'รอรับ Schema ตารางปลายทางของ HOSOffice Test DB จากเจ้าของระบบก่อนเปิดการเขียนจริง',
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

hosofficeRouter.get(
  '/hosoffice/push-history',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const cfg = loadConfig();
      const items = await dbQuery('SELECT * FROM push_history ORDER BY id DESC LIMIT 30');
      res.json({
        livePushEnabled: cfg.hosofficePush.livePushEnabled,
        targetTableConfigured: Boolean(cfg.hosofficePush.targetTable),
        items,
      });
    } catch (err) {
      next(err);
    }
  }
);
