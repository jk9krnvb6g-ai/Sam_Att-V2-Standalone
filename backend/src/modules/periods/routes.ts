import { Router } from 'express';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';

export const periodsRouter = Router();

export const ALLOWED_PRE_CLOSE_STATUSES = new Set([
  'OPEN',
  'REVIEWING',
  'READY_TO_CLOSE',
  'REOPENED',
]);

function getMonthDateBounds(ym: string): { dateFrom: string; dateTo: string } {
  const [yStr, mStr] = ym.split('-');
  const y = Number(yStr);
  const m = Number(mStr);
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    dateFrom: `${ym}-01`,
    dateTo: `${ym}-${String(lastDay).padStart(2, '0')}`,
  };
}

export interface PeriodReadinessReport {
  periodYm: string;
  dateFrom: string;
  dateTo: string;
  currentStatus: string;
  canClose: boolean;
  blockingIssuesCount: number;
  warningsCount: number;
  blockingIssues: Array<{
    code: string;
    labelThai: string;
    count: number;
    targetView: string;
  }>;
  warnings: Array<{
    code: string;
    labelThai: string;
    count: number;
    targetView: string;
  }>;
  summary: {
    totalShiftAssignments: number;
    totalAttendanceRecords: number;
    completeCount: number;
    lateCount: number;
    noScanCount: number;
    missingScanCount: number;
    approvedCount: number;
    lateScanReviewRequiredCount: number;
  };
}

export async function computePeriodReadiness(periodYm: string): Promise<PeriodReadinessReport> {
  const { dateFrom, dateTo } = getMonthDateBounds(periodYm);

  const periodRows = await dbQuery<{ status: string }>(
    'SELECT status FROM attendance_periods WHERE period_ym = ? LIMIT 1',
    [periodYm]
  );
  const currentStatus = periodRows[0]?.status ? String(periodRows[0].status).toUpperCase() : 'OPEN';

  const [
    attAggRows,
    shiftAggRows,
    missingMappingRows,
    conflictMappingRows,
    unprocessedScanRows,
  ] = await Promise.all([
    dbQuery<{
      totalRecords: number;
      completeCount: number;
      lateCount: number;
      noScanCount: number;
      missingScanCount: number;
      approvedCount: number;
      pendingHrReviewCount: number;
      needsReReviewCount: number;
      inProgressCount: number;
      lateScanReviewCount: number;
    }>(
      `SELECT
        COUNT(*) AS totalRecords,
        SUM(CASE WHEN attendance_status = 'COMPLETE' OR status IN ('NORMAL', 'LATE') THEN 1 ELSE 0 END) AS completeCount,
        SUM(CASE WHEN is_late = 1 OR status = 'LATE' THEN 1 ELSE 0 END) AS lateCount,
        SUM(CASE WHEN status = 'NO_SCAN' THEN 1 ELSE 0 END) AS noScanCount,
        SUM(CASE WHEN status IN ('MISSING_CHECKIN', 'MISSING_CHECKOUT') THEN 1 ELSE 0 END) AS missingScanCount,
        SUM(CASE WHEN review_status IN ('REVIEWED', 'VERIFIED_APPROVED') THEN 1 ELSE 0 END) AS approvedCount,
        SUM(CASE WHEN review_status IN ('PENDING', 'PENDING_REVIEW') AND (status IN ('NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'LATE', 'PENDING_MAPPING') OR is_late = 1 OR early_checkout_indicator = 1) THEN 1 ELSE 0 END) AS pendingHrReviewCount,
        SUM(CASE WHEN review_status = 'NEEDS_RE_REVIEW' THEN 1 ELSE 0 END) AS needsReReviewCount,
        SUM(CASE WHEN status IN ('IN_PROGRESS', 'LATE_IN_PROGRESS', 'NOT_STARTED', 'AWAITING_CHECKIN') THEN 1 ELSE 0 END) AS inProgressCount,
        SUM(CASE WHEN COALESCE(late_scan_review_required, 0) = 1 THEN 1 ELSE 0 END) AS lateScanReviewCount
       FROM attendance
       WHERE work_date >= ? AND work_date <= ?`,
      [dateFrom, dateTo]
    ),
    dbQuery<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM shift_assignments WHERE work_date >= ? AND work_date <= ? AND status = 'ACTIVE'`,
      [dateFrom, dateTo]
    ),
    dbQuery<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM raw_scans rs
       LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
       WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?
         AND (rsm.raw_scan_id IS NULL OR rsm.mapping_state = 'UNMATCHED')`,
      [`${dateFrom} 00:00:00`, `${dateTo} 23:59:59`]
    ),
    dbQuery<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM raw_scans rs
       INNER JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
       WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?
         AND rsm.mapping_state = 'CONFLICT'`,
      [`${dateFrom} 00:00:00`, `${dateTo} 23:59:59`]
    ),
    dbQuery<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM raw_scans rs
       INNER JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
       LEFT JOIN attendance_raw_scan_usage u ON u.raw_scan_id = rs.id
       WHERE rs.canonical_bkk_time >= ? AND rs.canonical_bkk_time <= ?
         AND rsm.mapping_state = 'MATCHED'
         AND u.raw_scan_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM attendance a
           WHERE a.person_id = rsm.matched_person_id
             AND a.work_date = SUBSTR(rs.canonical_bkk_time, 1, 10)
         )`,
      [`${dateFrom} 00:00:00`, `${dateTo} 23:59:59`]
    ),
  ]);

  const att = attAggRows[0] || ({} as Record<string, number>);
  const totalShiftAssignments = Number(shiftAggRows[0]?.cnt || 0);
  const totalAttendanceRecords = Number(att.totalRecords || 0);
  const missingMappingCount = Number(missingMappingRows[0]?.cnt || 0);
  const conflictMappingCount = Number(conflictMappingRows[0]?.cnt || 0);
  const unprocessedScanCount = Number(unprocessedScanRows[0]?.cnt || 0);
  const pendingHrReviewCount = Number(att.pendingHrReviewCount || 0);
  const needsReReviewCount = Number(att.needsReReviewCount || 0);
  const lateScanReviewRequiredCount = Number(att.lateScanReviewCount || 0);
  const inProgressCount = Number(att.inProgressCount || 0);

  const missingAttendanceGapRows = await dbQuery<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM shift_assignments sa
     WHERE sa.work_date >= ? AND sa.work_date <= ? AND sa.status = 'ACTIVE'
       AND NOT EXISTS (
         SELECT 1 FROM attendance a
         WHERE a.person_id = sa.person_id AND a.work_date = sa.work_date
       )`,
    [dateFrom, dateTo]
  );
  const missingAttendanceCount = Number(missingAttendanceGapRows[0]?.cnt || 0);

  const blockingIssues: PeriodReadinessReport['blockingIssues'] = [];
  if (missingMappingCount > 0) {
    blockingIssues.push({
      code: 'MISSING_MAPPING',
      labelThai: 'พบสแกนที่ยังไม่ผูกรหัสบุคลากร (Missing Mapping)',
      count: missingMappingCount,
      targetView: 'personnel',
    });
  }
  if (conflictMappingCount > 0) {
    blockingIssues.push({
      code: 'MAPPING_CONFLICT',
      labelThai: 'พบรหัสสแกนซ้ำซ้อน (Mapping Conflict)',
      count: conflictMappingCount,
      targetView: 'personnel',
    });
  }
  if (pendingHrReviewCount > 0) {
    blockingIssues.push({
      code: 'PENDING_HR_REVIEW',
      labelThai: 'มีรายการลงเวลาผิดปกติรอ HR ตรวจสอบ',
      count: pendingHrReviewCount,
      targetView: 'attendanceReview',
    });
  }
  if (needsReReviewCount > 0) {
    blockingIssues.push({
      code: 'NEEDS_RE_REVIEW',
      labelThai: 'มีรายการที่ต้องตรวจสอบซ้ำ (NEEDS_RE_REVIEW)',
      count: needsReReviewCount,
      targetView: 'attendanceReview',
    });
  }
  if (unprocessedScanCount > 0) {
    blockingIssues.push({
      code: 'UNPROCESSED_SCANS',
      labelThai: 'มีข้อมูลสแกนที่ยังไม่ได้ประมวลผลลงเวลา',
      count: unprocessedScanCount,
      targetView: 'completeness',
    });
  }

  const warnings: PeriodReadinessReport['warnings'] = [];
  if (missingAttendanceCount > 0) {
    warnings.push({
      code: 'MISSING_ATTENDANCE',
      labelThai: 'มีตารางเวรที่ยังไม่มีรายการประมวลผลเวลา (ตรวจสอบที่ศูนย์ความครบถ้วน)',
      count: missingAttendanceCount,
      targetView: 'completeness',
    });
  }
  if (inProgressCount > 0) {
    warnings.push({
      code: 'IN_PROGRESS_RECORDS',
      labelThai: 'มีรายการที่ยังอยู่ระหว่างปฏิบัติงานหรือยังไม่ถึงเวลาสิ้นสุดกะ',
      count: inProgressCount,
      targetView: 'hrAttendance',
    });
  }
  if (lateScanReviewRequiredCount > 0) {
    warnings.push({
      code: 'LATE_SCAN_REVIEW_REQUIRED',
      labelThai: 'มีรายการที่มีข้อมูลสแกนเข้ามาภายหลังรอการตรวจสอบ',
      count: lateScanReviewRequiredCount,
      targetView: 'attendanceReview',
    });
  }

  return {
    periodYm,
    dateFrom,
    dateTo,
    currentStatus,
    canClose: blockingIssues.length === 0 && currentStatus !== 'CLOSED',
    blockingIssuesCount: blockingIssues.reduce((sum, i) => sum + i.count, 0),
    warningsCount: warnings.reduce((sum, w) => sum + w.count, 0),
    blockingIssues,
    warnings,
    summary: {
      totalShiftAssignments,
      totalAttendanceRecords,
      completeCount: Number(att.completeCount || 0),
      lateCount: Number(att.lateCount || 0),
      noScanCount: Number(att.noScanCount || 0),
      missingScanCount: Number(att.missingScanCount || 0),
      approvedCount: Number(att.approvedCount || 0),
      lateScanReviewRequiredCount,
    },
  };
}

// GET /attendance-periods — รายการงวดเดือนและประวัติการปิดรอบ
periodsRouter.get(
  '/attendance-periods',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const periods = await dbQuery('SELECT * FROM attendance_periods ORDER BY period_ym DESC LIMIT 36');
      const history = await dbQuery(
        'SELECT * FROM attendance_period_history ORDER BY id DESC LIMIT 60'
      );
      res.json({
        currentYearMonth: bkk.currentYearMonth,
        items: periods,
        history,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /attendance-periods/:ym/readiness — ตรวจสอบความพร้อมก่อนปิดรอบเดือน
periodsRouter.get(
  '/attendance-periods/:ym/readiness',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const ym = String(req.params.ym || '').trim();
      if (!/^\d{4}-\d{2}$/.test(ym)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รูปแบบงวดเดือนต้องเป็น YYYY-MM เช่น 2026-11',
          requestId: req.requestId,
        });
        return;
      }
      const readiness = await computePeriodReadiness(ym);
      const history = await dbQuery(
        'SELECT * FROM attendance_period_history WHERE period_ym = ? ORDER BY id DESC LIMIT 20',
        [ym]
      );
      const periodRows = await dbQuery('SELECT * FROM attendance_periods WHERE period_ym = ? LIMIT 1', [ym]);
      res.json({
        ...readiness,
        period: periodRows[0] || null,
        history,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /attendance-periods/:ym/status — เปลี่ยนสถานะก่อนปิดรอบ (OPEN / REVIEWING / READY_TO_CLOSE)
periodsRouter.post(
  '/attendance-periods/:ym/status',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const ym = String(req.params.ym || '').trim();
      const nextStatus = String(req.body?.status || '').trim().toUpperCase();
      if (!/^\d{4}-\d{2}$/.test(ym) || !ALLOWED_PRE_CLOSE_STATUSES.has(nextStatus)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'สถานะงวดเดือนต้องเป็น OPEN, REVIEWING หรือ READY_TO_CLOSE',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ status: string }>(
        'SELECT status FROM attendance_periods WHERE period_ym = ? LIMIT 1',
        [ym]
      );
      const prevStatus = existing[0]?.status ? String(existing[0].status).toUpperCase() : 'OPEN';
      if (prevStatus === 'CLOSED') {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: 'งวดเดือนนี้ถูกปิดรอบแล้ว กรุณาให้ผู้ดูแลระบบสั่งเปิดรอบใหม่ (Reopen) ก่อนแก้ไขสถานะ',
          requestId: req.requestId,
        });
        return;
      }

      if (existing.length === 0) {
        await dbExecute(
          `INSERT INTO attendance_periods (period_ym, status, updated_by) VALUES (?, ?, ?)`,
          [ym, nextStatus, req.user!.username]
        );
      } else {
        await dbExecute(
          `UPDATE attendance_periods SET status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE period_ym = ?`,
          [nextStatus, req.user!.username, ym]
        );
      }

      await dbExecute(
        `INSERT INTO attendance_period_history (period_ym, previous_status, new_status, action_type, reason, acted_by)
         VALUES (?, ?, ?, 'STATUS_CHANGE', ?, ?)`,
        [ym, prevStatus, nextStatus, String(req.body?.reason || '').trim() || null, req.user!.username]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_PERIOD_STATUS_UPDATED',
        targetType: 'ATTENDANCE_PERIOD',
        targetId: ym,
        result: 'SUCCESS',
        detail: { previousStatus: prevStatus, newStatus: nextStatus },
      });

      res.json({ periodYm: ym, previousStatus: prevStatus, status: nextStatus });
    } catch (err) {
      next(err);
    }
  }
);

// POST /attendance-periods/:ym/close — ปิดรอบประจำเดือนและล็อกรายการลงเวลา
periodsRouter.post(
  '/attendance-periods/:ym/close',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const ym = String(req.params.ym || '').trim();
      if (!/^\d{4}-\d{2}$/.test(ym)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รูปแบบงวดเดือนต้องเป็น YYYY-MM',
          requestId: req.requestId,
        });
        return;
      }

      const readiness = await computePeriodReadiness(ym);
      if (readiness.currentStatus === 'CLOSED') {
        res.status(409).json({
          error: 'ALREADY_CLOSED',
          message: `งวดเดือน ${ym} ถูกปิดรอบไปแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      if (readiness.blockingIssues.length > 0) {
        res.status(409).json({
          error: 'CLOSING_BLOCKED_ISSUES',
          message: `ไม่สามารถปิดรอบเดือน ${ym} ได้ เนื่องจากยังมีรายการติดขัดที่ต้องแก้ไขก่อน ${readiness.blockingIssuesCount} รายการ`,
          readiness,
          requestId: req.requestId,
        });
        return;
      }

      const snapshotJson = JSON.stringify({
        closedAt: new Date().toISOString(),
        closedBy: req.user!.username,
        summary: readiness.summary,
        warnings: readiness.warnings,
      });
      const readinessJson = JSON.stringify(readiness);

      const existing = await dbQuery<{ status: string }>(
        'SELECT status FROM attendance_periods WHERE period_ym = ? LIMIT 1',
        [ym]
      );
      if (existing.length === 0) {
        await dbExecute(
          `INSERT INTO attendance_periods (
            period_ym, status, readiness_json, summary_snapshot_json, closed_by, closed_at, updated_by
          ) VALUES (?, 'CLOSED', ?, ?, ?, CURRENT_TIMESTAMP, ?)`,
          [ym, readinessJson, snapshotJson, req.user!.username, req.user!.username]
        );
      } else {
        await dbExecute(
          `UPDATE attendance_periods
           SET status = 'CLOSED', readiness_json = ?, summary_snapshot_json = ?,
               closed_by = ?, closed_at = CURRENT_TIMESTAMP, updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE period_ym = ?`,
          [readinessJson, snapshotJson, req.user!.username, req.user!.username, ym]
        );
      }

      await dbExecute(
        `UPDATE attendance SET is_locked_period = 1 WHERE work_date >= ? AND work_date <= ?`,
        [readiness.dateFrom, readiness.dateTo]
      );

      await dbExecute(
        `INSERT INTO attendance_period_history (
          period_ym, previous_status, new_status, action_type, reason, readiness_snapshot_json, acted_by
        ) VALUES (?, ?, 'CLOSED', 'CLOSE_PERIOD', ?, ?, ?)`,
        [
          ym,
          readiness.currentStatus,
          String(req.body?.note || 'ปิดรอบเวลาปฏิบัติงานประจำเดือน').trim(),
          readinessJson,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_PERIOD_CLOSED',
        targetType: 'ATTENDANCE_PERIOD',
        targetId: ym,
        result: 'SUCCESS',
        detail: {
          previousStatus: readiness.currentStatus,
          summary: readiness.summary,
          hosofficeLivePushRemainsDisabled: true,
        },
      });

      res.json({
        status: 'CLOSED',
        periodYm: ym,
        readiness,
        message: `ปิดรอบเดือน ${ym} และล็อกข้อมูลเวลาปฏิบัติงานเรียบร้อยแล้ว (ไม่มีการส่งข้อมูลเข้า HOSOffice โดยอัตโนมัติ)`,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /attendance-periods/:ym/reopen — เปิดรอบใหม่เฉพาะ ADMIN โดยต้องระบุเหตุผล
periodsRouter.post(
  '/attendance-periods/:ym/reopen',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const ym = String(req.params.ym || '').trim();
      const reason = String(req.body?.reason || '').trim();
      if (!/^\d{4}-\d{2}$/.test(ym)) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'รูปแบบงวดเดือนไม่ถูกต้อง' });
        return;
      }
      if (!reason || reason.length < 5) {
        res.status(400).json({
          error: 'REASON_REQUIRED',
          message: 'กรุณาระบุเหตุผลในการเปิดรอบเดือนใหม่อย่างชัดเจน (อย่างน้อย 5 ตัวอักษร)',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ status: string }>(
        'SELECT status FROM attendance_periods WHERE period_ym = ? LIMIT 1',
        [ym]
      );
      if (existing.length === 0 || String(existing[0].status).toUpperCase() !== 'CLOSED') {
        res.status(409).json({
          error: 'PERIOD_NOT_CLOSED',
          message: `งวดเดือน ${ym} ไม่ได้อยู่ในสถานะปิดรอบ`,
          requestId: req.requestId,
        });
        return;
      }

      const { dateFrom, dateTo } = getMonthDateBounds(ym);
      await dbExecute(
        `UPDATE attendance_periods
         SET status = 'REOPENED', reopened_by = ?, reopened_at = CURRENT_TIMESTAMP,
             reopen_reason = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE period_ym = ?`,
        [req.user!.username, reason, req.user!.username, ym]
      );

      await dbExecute(
        `UPDATE attendance SET is_locked_period = 0 WHERE work_date >= ? AND work_date <= ?`,
        [dateFrom, dateTo]
      );

      await dbExecute(
        `INSERT INTO attendance_period_history (
          period_ym, previous_status, new_status, action_type, reason, acted_by
        ) VALUES (?, 'CLOSED', 'REOPENED', 'REOPEN_PERIOD', ?, ?)`,
        [ym, reason, req.user!.username]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'ATTENDANCE_PERIOD_REOPENED',
        targetType: 'ATTENDANCE_PERIOD',
        targetId: ym,
        result: 'SUCCESS',
        detail: { reason, previousStatus: 'CLOSED', newStatus: 'REOPENED' },
      });

      res.json({
        status: 'REOPENED',
        periodYm: ym,
        reason,
        warning:
          'คำเตือน: รายงานหรือตัวเลขสรุปของเดือนนี้ที่ส่งออกไว้ก่อนหน้าอาจเปลี่ยนแปลงได้หลังแก้ไขหรือประมวลผลเวลาใหม่',
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);
