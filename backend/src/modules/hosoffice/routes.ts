/**
 * ============================================================================
 * โมดูลส่งข้อมูลเวลาปฏิบัติงานกลับเข้าสู่ระบบ HOSOffice (HOSOffice Dry-Run & Live Push Engine)
 * ไฟล์: backend/src/modules/hosoffice/routes.ts
 * ============================================================================
 * หน้าที่หลัก (แก้ไขปัญหา P0 ข้อ 07 และ P1 ข้อ 16–17):
 * 1. POST /hosoffice/push/preview: ตรวจสอบความพร้อมของข้อมูล (Validation) แบบ Dry-Run โดยไม่เขียนลงฐานข้อมูลปลายทาง
 * 2. POST /hosoffice/push:
 *    - อนุญาตให้ทั้ง `ADMIN` และ `RESPONSIBLE_STAFF` ส่งข้อมูลได้โดยตรงตามสิทธิ์ (ไม่ต้องมีขั้นตอนอนุมัติซ้ำ)
 *    - ตรวจสอบ Idempotency Key ป้องกันการส่งซ้ำ (`DUPLICATE_IDEMPOTENCY_KEY`)
 *    - ตรวจสอบความถูกต้องของรายการ (Validation) ห้ามส่งรายการที่ยังไม่ผูก `FINGLE_ID` หรือรายการ `NO_SCAN`/`MISSING_CHECKOUT` ที่ HR ยังไม่ตรวจ
 *    - ทำงานภายใต้ Database Transaction (`BEGIN` / `COMMIT` / `ROLLBACK`) โดยใช้บัญชีที่มีสิทธิ์เฉพาะตารางปลายทาง (`pushWriteUser`)
 *    - บันทึกผลการส่งจริง (`SUCCESS` / `FAILED`) ลงตาราง `push_history` และ `audit_logs`
 */
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute, dbTransaction } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export const hosofficeRouter = Router();

export interface ValidatedHosOfficePushRecord {
  PERSON_ID: string;
  FINGLE_ID: string;
  WORK_DATE: string;
  SHIFT_CODE: string | null;
  CHECK_IN_DATETIME: string | null;
  CHECK_OUT_DATETIME: string | null;
  ATTENDANCE_STATUS: string;
  LATE_MINUTES: number;
  HR_REVIEW_STATUS: string;
}

// Test Sink hook for verifying Live Push Transaction, Idempotency & Rollback against a HOSOffice Test DB in automated tests
type HosOfficePushTestSink = (
  targetTable: string,
  records: ValidatedHosOfficePushRecord[],
  idempotencyKey: string
) => Promise<{ writtenCount: number }>;

let hosOfficePushTestSink: HosOfficePushTestSink | null = null;

export function setHosOfficeLivePushTestSink(sink: HosOfficePushTestSink | null): void {
  hosOfficePushTestSink = sink;
}

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

export async function evaluatePushBatch(dateFrom: string, dateTo: string) {
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

  const validItems: ValidatedHosOfficePushRecord[] = [];
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

/**
 * เขียนข้อมูลที่ผ่านการตรวจสอบเข้าสู่ตารางปลายทางของ HOSOffice ภายใต้ Transaction เดียวกัน
 */
async function writeBatchToHosOfficeTargetTable(
  targetTableRaw: string,
  records: ValidatedHosOfficePushRecord[],
  idempotencyKey: string
): Promise<{ writtenCount: number }> {
  const safeTable = targetTableRaw.replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeTable) {
    throw new Error('INVALID_TARGET_TABLE: ชื่อตารางปลายทาง HOSOffice ไม่ถูกต้อง');
  }

  if (hosOfficePushTestSink) {
    return hosOfficePushTestSink(safeTable, records, idempotencyKey);
  }

  const cfg = loadConfig();
  if (!cfg.hosofficeDb.host || cfg.hosofficeDb.host === 'CHANGE_ME') {
    const err = new Error(
      'HOSOFFICE_DB_UNCONFIGURED: ยังไม่ได้ตั้งค่า HOSOFFICE_DB_HOST สำหรับเชื่อมต่อฐานข้อมูล HOSOffice'
    );
    (err as Error & { code?: string }).code = 'HOSOFFICE_DB_UNCONFIGURED';
    throw err;
  }

  const conn = await mysql.createConnection({
    host: cfg.hosofficeDb.host,
    port: cfg.hosofficeDb.port,
    user: cfg.hosofficeDb.pushWriteUser,
    password: cfg.hosofficeDb.pushWritePassword,
    database: cfg.hosofficeDb.database,
    charset: 'utf8mb4',
    connectTimeout: 5000,
    timezone: '+07:00',
  });

  try {
    await conn.beginTransaction();
    let writtenCount = 0;

    for (const rec of records) {
      await conn.execute(
        `INSERT INTO ${safeTable} (
          PERSON_ID, FINGLE_ID, WORK_DATE, SHIFT_CODE,
          CHECK_IN_DATETIME, CHECK_OUT_DATETIME,
          ATTENDANCE_STATUS, LATE_MINUTES, HR_REVIEW_STATUS,
          IDEMPOTENCY_KEY, UPDATED_AT
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          FINGLE_ID = VALUES(FINGLE_ID),
          CHECK_IN_DATETIME = VALUES(CHECK_IN_DATETIME),
          CHECK_OUT_DATETIME = VALUES(CHECK_OUT_DATETIME),
          ATTENDANCE_STATUS = VALUES(ATTENDANCE_STATUS),
          LATE_MINUTES = VALUES(LATE_MINUTES),
          HR_REVIEW_STATUS = VALUES(HR_REVIEW_STATUS),
          IDEMPOTENCY_KEY = VALUES(IDEMPOTENCY_KEY),
          UPDATED_AT = CURRENT_TIMESTAMP`,
        [
          rec.PERSON_ID,
          rec.FINGLE_ID,
          rec.WORK_DATE,
          rec.SHIFT_CODE || 'DEFAULT',
          rec.CHECK_IN_DATETIME,
          rec.CHECK_OUT_DATETIME,
          rec.ATTENDANCE_STATUS,
          rec.LATE_MINUTES,
          rec.HR_REVIEW_STATUS,
          idempotencyKey,
        ]
      );
      writtenCount++;
    }

    await conn.commit();
    return { writtenCount };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    await conn.end();
  }
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
          ? 'LIVE_PUSH_READY'
          : 'DRY_RUN_ONLY_LIVE_PUSH_DISABLED',
        targetTable: cfg.hosofficePush.targetTable,
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
        targetTable: cfg.hosofficePush.targetTable,
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

// B11. HOSOffice Live Push (Direct Execution by ADMIN & RESPONSIBLE_STAFF with Transaction & Idempotency)
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
            'ปิดการส่งข้อมูลจริงเข้า HOSOffice (HOSOFFICE_LIVE_PUSH_ENABLED=false) กรุณาเปิดตั้งค่าหลังจากยืนยันตารางปลายทางแล้ว',
          sideEffectsWritten: 0,
          requestId: req.requestId,
        });
        return;
      }

      // 1. ตรวจสอบ Idempotency Key เพื่อป้องกันการส่งข้อมูลชุดเดิมซ้ำ
      const existing = await dbQuery<{ id: number; status: string }>(
        "SELECT id, status FROM push_history WHERE idempotency_key = ? AND push_mode = 'LIVE_PUSH' AND status = 'SUCCESS' LIMIT 1",
        [idempotencyKey]
      );
      if (existing.length > 0) {
        res.status(409).json({
          error: 'DUPLICATE_IDEMPOTENCY_KEY',
          message: `ชุดข้อมูลที่มี Idempotency Key ${idempotencyKey} เคยถูกส่งเข้า HOSOffice สำเร็จแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      // 2. ประเมินและตรวจสอบความถูกต้องของข้อมูลในชุดที่จะส่ง
      const batch = await evaluatePushBatch(dateFrom, dateTo);
      if (batch.validItems.length === 0) {
        res.status(422).json({
          error: 'NO_VALID_RECORDS_TO_PUSH',
          message: 'ไม่พบรายการที่ผ่านเกณฑ์ความถูกต้องสำหรับส่งเข้า HOSOffice ในช่วงวันที่ที่เลือก',
          invalidCount: batch.invalidItems.length,
          invalidItems: batch.invalidItems,
          requestId: req.requestId,
        });
        return;
      }

      const payloadJson = JSON.stringify({
        targetTable: cfg.hosofficePush.targetTable,
        dateFrom,
        dateTo,
        validRecords: batch.validItems,
        invalidRecords: batch.invalidItems,
      });

      // 3. ส่งข้อมูลเข้าตารางปลายทาง HOSOffice ภายใต้ Transaction พร้อมบันทึก push_history
      try {
        const pushOutcome = await writeBatchToHosOfficeTargetTable(
          cfg.hosofficePush.targetTable,
          batch.validItems,
          idempotencyKey
        );

        await dbTransaction(async (tx) => {
          await tx.execute(
            `INSERT INTO push_history (
              idempotency_key, push_mode, date_from, date_to,
              total_records, valid_records, invalid_records, status,
              payload_preview_json, initiated_by
            ) VALUES (?, 'LIVE_PUSH', ?, ?, ?, ?, ?, 'SUCCESS', ?, ?)`,
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
        });

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSOFFICE_LIVE_PUSH_SUCCESS',
          targetType: 'HOSOFFICE_PUSH',
          targetId: idempotencyKey,
          result: 'SUCCESS',
          detail: {
            targetTable: cfg.hosofficePush.targetTable,
            dateFrom,
            dateTo,
            writtenCount: pushOutcome.writtenCount,
            skippedInvalidCount: batch.invalidItems.length,
          },
        });

        res.status(200).json({
          status: 'SUCCESS',
          mode: 'LIVE_PUSH',
          idempotencyKey,
          targetTable: cfg.hosofficePush.targetTable,
          dateFrom,
          dateTo,
          writtenCount: pushOutcome.writtenCount,
          validCount: batch.validItems.length,
          invalidCount: batch.invalidItems.length,
          initiatedBy: req.user!.username,
        });
      } catch (pushErr: unknown) {
        const errCode = (pushErr as { code?: string })?.code || 'HOSOFFICE_PUSH_TRANSACTION_FAILED';
        const errMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);

        await dbExecute(
          `INSERT IGNORE INTO push_history (
            idempotency_key, push_mode, date_from, date_to,
            total_records, valid_records, invalid_records, status,
            payload_preview_json, error_detail, initiated_by
          ) VALUES (?, 'LIVE_PUSH', ?, ?, ?, ?, ?, 'FAILED', ?, ?, ?)`,
          [
            `${idempotencyKey}-FAIL-${Date.now()}`,
            dateFrom,
            dateTo,
            batch.totalRecords,
            batch.validItems.length,
            batch.invalidItems.length,
            payloadJson,
            errMsg.slice(0, 900),
            req.user!.username,
          ]
        );

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSOFFICE_LIVE_PUSH_FAILED',
          targetType: 'HOSOFFICE_PUSH',
          targetId: idempotencyKey,
          result: 'FAILURE',
          errorCode: errCode,
          detail: { targetTable: cfg.hosofficePush.targetTable, error: errMsg },
        });

        res.status(503).json({
          error: errCode,
          message: 'การส่งข้อมูลเข้า HOSOffice ล้มเหลว ระบบได้ทำการ Rollback รายการทั้งหมดแล้ว',
          sideEffectsWritten: 0,
          requestId: req.requestId,
        });
      }
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
        targetTable: cfg.hosofficePush.targetTable,
        targetTableConfigured: Boolean(cfg.hosofficePush.targetTable),
        items,
      });
    } catch (err) {
      next(err);
    }
  }
);
