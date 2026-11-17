/**
 * ============================================================================
 * โมดูลจัดการแม่แบบกะทำงานและการมอบหมายตารางเวร (Shifts & Roster Assignments API)
 * ไฟล์: backend/src/modules/shifts/routes.ts
 * ============================================================================
 * คุณสมบัติหลัก:
 * 1. GET /shifts & POST /shifts: ดึงและสร้างแม่แบบกะทำงาน (รองรับเวรปกติและเวรข้ามวัน)
 * 2. GET /shift-assignments: ดึงรายการตารางเวรตามช่วงวันที่ บุคลากร แผนก กะ และสถานะ พร้อมประวัติการยกเลิก
 * 3. POST /shift-assignments: มอบหมายเวรเดี่ยวพร้อมบันทึกค่า Snapshot ของเวลาทำงาน ณ วันที่มอบหมาย
 * 4. POST /shift-assignments/bulk-preview: ตรวจสอบความขัดแย้ง (เวรซ้ำ / เวลาทับซ้อนรวมถึงเวรข้ามวัน)
 *    สำหรับหลายบุคลากรและหลายวันก่อนบันทึกจริง
 * 5. POST /shift-assignments/bulk: บันทึกการมอบหมายเวรแบบกลุ่มภายใต้ Database Transaction เดียวกัน
 *    โดยห้ามแก้ไขหรือทับข้อมูลเวรเดิมที่มีอยู่แล้วเด็ดขาด
 * 6. DELETE /shift-assignments/:id: ยกเลิกเวรแบบ Soft Cancel พร้อมบันทึกเหตุผลลง shift_cancellation_logs และ Audit Log
 * ============================================================================
 */
import { Router } from 'express';
import { dbQuery, dbExecute, dbTransaction, type DbTransactionContext } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export const shiftsRouter = Router();

interface ShiftRow {
  id: number;
  shift_code: string;
  shift_name: string;
  shift_category: string;
  start_time: string;
  end_time: string;
  grace_minutes: number;
  cutoff_time: string;
  is_cross_midnight: number;
  is_active: number;
}

interface ExistingAssignmentRow {
  id: number;
  person_id: string;
  shift_id: number;
  work_date: string;
  snapshot_shift_code: string;
  snapshot_shift_name: string;
  snapshot_start_time: string;
  snapshot_end_time: string;
  snapshot_is_cross_midnight: number;
  status: string;
}

interface PersonnelSummaryRow {
  person_id: string;
  full_name: string;
  department_name: string;
  personnel_type_name: string;
}

export interface BulkPreviewItem {
  personId: string;
  fullName: string;
  departmentName: string;
  workDate: string;
  status: 'READY' | 'DUPLICATE_SAME_SHIFT' | 'TIME_OVERLAP_CONFLICT';
  conflictCode: string | null;
  conflictMessage: string | null;
  existingAssignment: {
    id: number;
    workDate: string;
    shiftCode: string;
    shiftName: string;
    startTime: string;
    endTime: string;
    isCrossMidnight: number;
  } | null;
}

function parseTimeToMinutes(hhmm: string): number {
  const [hStr, mStr] = String(hhmm || '00:00').split(':');
  return Number(hStr || 0) * 60 + Number(mStr || 0);
}

function parseDateToUtcDayIndex(dateStr: string): number {
  const [yStr, mStr, dStr] = dateStr.split('-');
  const utcMs = Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr));
  return Math.floor(utcMs / 86_400_000);
}

function addDaysToDateString(dateStr: string, offsetDays: number): string {
  const [yStr, mStr, dStr] = dateStr.split('-');
  const dt = new Date(Date.UTC(Number(yStr), Number(mStr) - 1, Number(dStr) + offsetDays));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * คำนวณช่วงเวลาเริ่มต้นและสิ้นสุดเป็นนาทีสัมบูรณ์ (Absolute Minutes)
 * เพื่อใช้ตรวจจับการทับซ้อนของเวลาระหว่างเวรในวันเดียวกันและเวรข้ามเที่ยงคืนจากวันข้างเคียง
 */
function computeAbsoluteIntervalMinutes(
  workDate: string,
  startTime: string,
  endTime: string,
  isCrossMidnight: number
): { startAbsMin: number; endAbsMin: number } {
  const dayIndex = parseDateToUtcDayIndex(workDate);
  const startMin = parseTimeToMinutes(startTime);
  const endMin = parseTimeToMinutes(endTime);
  const cross = Number(isCrossMidnight) === 1 || endMin <= startMin;
  return {
    startAbsMin: dayIndex * 1440 + startMin,
    endAbsMin: dayIndex * 1440 + endMin + (cross ? 1440 : 0),
  };
}

/**
 * ตรวจสอบความขัดแย้งของรายการมอบหมายเวร (หลายบุคลากร x หลายวัน)
 * โดยไม่แก้ไขข้อมูลเวรเดิมที่มีอยู่
 */
async function evaluateBulkShiftAssignments(
  queryRunner: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>,
  options: {
    personIds: string[];
    shift: ShiftRow;
    workDates: string[];
  }
): Promise<{
  items: BulkPreviewItem[];
  summary: {
    totalRequested: number;
    readyCount: number;
    conflictCount: number;
    duplicateCount: number;
    overlapCount: number;
  };
}> {
  const { personIds, shift, workDates } = options;

  const personPlaceholders = personIds.map(() => '?').join(', ');
  const personnelRows = await queryRunner<PersonnelSummaryRow>(
    `SELECT person_id, full_name, department_name, personnel_type_name
     FROM personnel
     WHERE person_id IN (${personPlaceholders})`,
    personIds
  );
  const personMap = new Map<string, PersonnelSummaryRow>();
  for (const p of personnelRows) {
    personMap.set(p.person_id, p);
  }

  const sortedDates = [...workDates].sort();
  const minDateMinusOne = addDaysToDateString(sortedDates[0], -1);
  const maxDatePlusOne = addDaysToDateString(sortedDates[sortedDates.length - 1], 1);

  const existingAssignments = await queryRunner<ExistingAssignmentRow>(
    `SELECT id, person_id, shift_id, work_date,
            snapshot_shift_code, snapshot_shift_name,
            snapshot_start_time, snapshot_end_time, snapshot_is_cross_midnight, status
     FROM shift_assignments
     WHERE person_id IN (${personPlaceholders})
       AND work_date >= ?
       AND work_date <= ?
       AND status = 'ACTIVE'
     ORDER BY work_date ASC, snapshot_start_time ASC`,
    [...personIds, minDateMinusOne, maxDatePlusOne]
  );

  const existingByPerson = new Map<string, ExistingAssignmentRow[]>();
  for (const ex of existingAssignments) {
    const list = existingByPerson.get(ex.person_id) || [];
    list.push(ex);
    existingByPerson.set(ex.person_id, list);
  }

  const items: BulkPreviewItem[] = [];
  let readyCount = 0;
  let duplicateCount = 0;
  let overlapCount = 0;

  for (const personId of personIds) {
    const personInfo = personMap.get(personId);
    const fullName = personInfo?.full_name || personId;
    const departmentName = personInfo?.department_name || '-';
    const personExisting = existingByPerson.get(personId) || [];

    for (const workDate of sortedDates) {
      const candidateInterval = computeAbsoluteIntervalMinutes(
        workDate,
        shift.start_time,
        shift.end_time,
        shift.is_cross_midnight
      );

      // 1. ตรวจว่ามีกะเดียวกันในวันเดียวกันอยู่แล้วหรือไม่
      const sameShiftDup = personExisting.find(
        (ex) => Number(ex.shift_id) === Number(shift.id) && ex.work_date === workDate
      );

      if (sameShiftDup) {
        duplicateCount++;
        items.push({
          personId,
          fullName,
          departmentName,
          workDate,
          status: 'DUPLICATE_SAME_SHIFT',
          conflictCode: 'DUPLICATE_SAME_SHIFT',
          conflictMessage: `มีเวรกะ ${sameShiftDup.snapshot_shift_code} (${sameShiftDup.snapshot_start_time}–${sameShiftDup.snapshot_end_time} น.) ในวันนี้อยู่แล้ว`,
          existingAssignment: {
            id: sameShiftDup.id,
            workDate: sameShiftDup.work_date,
            shiftCode: sameShiftDup.snapshot_shift_code,
            shiftName: sameShiftDup.snapshot_shift_name,
            startTime: sameShiftDup.snapshot_start_time,
            endTime: sameShiftDup.snapshot_end_time,
            isCrossMidnight: Number(sameShiftDup.snapshot_is_cross_midnight),
          },
        });
        continue;
      }

      // 2. ตรวจว่าช่วงเวลาทับซ้อนกับเวรอื่นที่มอบหมายไว้แล้วหรือไม่ (รวมถึงเวรข้ามวัน)
      const overlappingEx = personExisting.find((ex) => {
        const exInterval = computeAbsoluteIntervalMinutes(
          ex.work_date,
          ex.snapshot_start_time,
          ex.snapshot_end_time,
          ex.snapshot_is_cross_midnight
        );
        return (
          Math.max(candidateInterval.startAbsMin, exInterval.startAbsMin) <
          Math.min(candidateInterval.endAbsMin, exInterval.endAbsMin)
        );
      });

      if (overlappingEx) {
        overlapCount++;
        items.push({
          personId,
          fullName,
          departmentName,
          workDate,
          status: 'TIME_OVERLAP_CONFLICT',
          conflictCode: 'TIME_OVERLAP_CONFLICT',
          conflictMessage: `เวลาทับซ้อนกับ ${overlappingEx.snapshot_shift_name} (${overlappingEx.snapshot_start_time}–${overlappingEx.snapshot_end_time} น. วันที่ ${overlappingEx.work_date})`,
          existingAssignment: {
            id: overlappingEx.id,
            workDate: overlappingEx.work_date,
            shiftCode: overlappingEx.snapshot_shift_code,
            shiftName: overlappingEx.snapshot_shift_name,
            startTime: overlappingEx.snapshot_start_time,
            endTime: overlappingEx.snapshot_end_time,
            isCrossMidnight: Number(overlappingEx.snapshot_is_cross_midnight),
          },
        });
        continue;
      }

      readyCount++;
      items.push({
        personId,
        fullName,
        departmentName,
        workDate,
        status: 'READY',
        conflictCode: null,
        conflictMessage: null,
        existingAssignment: null,
      });
    }
  }

  return {
    items,
    summary: {
      totalRequested: items.length,
      readyCount,
      conflictCount: duplicateCount + overlapCount,
      duplicateCount,
      overlapCount,
    },
  };
}

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

      if (
        !shiftCode ||
        !shiftName ||
        !/^\d{2}:\d{2}$/.test(startTime) ||
        !/^\d{2}:\d{2}$/.test(endTime) ||
        !/^\d{2}:\d{2}$/.test(cutoffTime)
      ) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุรหัสกะ ชื่อกะ เวลาเริ่ม-สิ้นสุด และเวลาตัดรอบสแกนในรูปแบบ HH:mm',
          requestId: req.requestId,
        });
        return;
      }

      const existing = await dbQuery<{ id: number }>(
        'SELECT id FROM shifts WHERE shift_code = ? LIMIT 1',
        [shiftCode]
      );
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
        [
          shiftCode,
          shiftName,
          shiftCategory,
          startTime,
          endTime,
          graceMinutes,
          cutoffTime,
          isCrossMidnight,
        ]
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
        detail: {
          shiftCode,
          shiftName,
          startTime,
          endTime,
          graceMinutes,
          cutoffTime,
          isCrossMidnight,
        },
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
      const department = String(req.query.department || '').trim();
      const shiftId = req.query.shiftId ? Number(req.query.shiftId) : 0;

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
      if (department) {
        conditions.push('p.department_name = ?');
        params.push(department);
      }
      if (shiftId > 0) {
        conditions.push('sa.shift_id = ?');
        params.push(shiftId);
      }

      const items = await dbQuery(
        `SELECT sa.*, p.full_name, p.department_name, p.personnel_type_name, p.position_name, p.fingle_id
         FROM shift_assignments sa
         INNER JOIN personnel p ON p.person_id = sa.person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY sa.work_date DESC, sa.snapshot_start_time ASC`,
        params
      );

      const cancellationLogs = await dbQuery(
        `SELECT scl.*, p.full_name, p.department_name
         FROM shift_cancellation_logs scl
         LEFT JOIN personnel p ON p.person_id = scl.person_id
         ORDER BY scl.id DESC LIMIT 30`
      );

      res.json({ items, cancellationLogs });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * ตรวจสอบความขัดแย้งและแสดงตัวอย่างก่อนบันทึกการมอบหมายเวรแบบหลายวัน/หลายบุคลากร
 */
shiftsRouter.post(
  '/shift-assignments/bulk-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const rawPersonIds: unknown[] = Array.isArray(req.body?.personIds) ? req.body.personIds : [];
      const rawWorkDates: unknown[] = Array.isArray(req.body?.workDates) ? req.body.workDates : [];
      const shiftId = Number(req.body?.shiftId);

      const personIds = Array.from(
        new Set(rawPersonIds.map((id) => String(id || '').trim()).filter(Boolean))
      );
      const workDates = Array.from(
        new Set(
          rawWorkDates
            .map((d) => String(d || '').trim())
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      ).sort();

      if (personIds.length === 0 || workDates.length === 0 || !shiftId) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน กะทำงาน และวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
          requestId: req.requestId,
        });
        return;
      }

      const shifts = await dbQuery<ShiftRow>(
        'SELECT * FROM shifts WHERE id = ? AND is_active = 1 LIMIT 1',
        [shiftId]
      );
      if (shifts.length === 0) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบแม่แบบกะทำงานที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      const shift = shifts[0];
      const evaluation = await evaluateBulkShiftAssignments(dbQuery, {
        personIds,
        shift,
        workDates,
      });

      res.json({
        shiftSnapshot: {
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          shiftName: shift.shift_name,
          startTime: shift.start_time,
          endTime: shift.end_time,
          graceMinutes: shift.grace_minutes,
          cutoffTime: shift.cutoff_time,
          isCrossMidnight: Number(shift.is_cross_midnight),
        },
        summary: evaluation.summary,
        items: evaluation.items,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * บันทึกการมอบหมายเวรแบบหลายวันและหลายบุคลากรภายใต้ Database Transaction เดียวกัน
 * ห้ามแก้ไขหรือเขียนทับข้อมูลเวรเดิมที่มีอยู่แล้วเด็ดขาด (Requirement 7, 8, 12, 13)
 */
shiftsRouter.post(
  '/shift-assignments/bulk',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const rawPersonIds: unknown[] = Array.isArray(req.body?.personIds) ? req.body.personIds : [];
      const rawWorkDates: unknown[] = Array.isArray(req.body?.workDates) ? req.body.workDates : [];
      const shiftId = Number(req.body?.shiftId);
      const conflictStrategy =
        req.body?.conflictStrategy === 'ABORT_ON_CONFLICT'
          ? 'ABORT_ON_CONFLICT'
          : 'SKIP_CONFLICTS';

      const personIds = Array.from(
        new Set(rawPersonIds.map((id) => String(id || '').trim()).filter(Boolean))
      );
      const workDates = Array.from(
        new Set(
          rawWorkDates
            .map((d) => String(d || '').trim())
            .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        )
      ).sort();

      if (personIds.length === 0 || workDates.length === 0 || !shiftId) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 คน กะทำงาน และวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
          requestId: req.requestId,
        });
        return;
      }

      const shifts = await dbQuery<ShiftRow>(
        'SELECT * FROM shifts WHERE id = ? AND is_active = 1 LIMIT 1',
        [shiftId]
      );
      if (shifts.length === 0) {
        res.status(404).json({
          error: 'SHIFT_NOT_FOUND',
          message: 'ไม่พบแม่แบบกะทำงานที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      const shift = shifts[0];

      // ตรวจสอบบุคลากรว่ามีอยู่จริงครบทุกคน
      const personPlaceholders = personIds.map(() => '?').join(', ');
      const validPersons = await dbQuery<{ person_id: string }>(
        `SELECT person_id FROM personnel WHERE person_id IN (${personPlaceholders})`,
        personIds
      );
      if (validPersons.length !== personIds.length) {
        res.status(404).json({
          error: 'PERSONNEL_NOT_FOUND',
          message: 'พบรหัสบุคลากรบางรายการไม่มีอยู่ในระบบ',
          requestId: req.requestId,
        });
        return;
      }

      const txOutcome = await dbTransaction(async (tx: DbTransactionContext) => {
        const evaluation = await evaluateBulkShiftAssignments(tx.query, {
          personIds,
          shift,
          workDates,
        });

        const conflicts = evaluation.items.filter((item) => item.status !== 'READY');
        const readyItems = evaluation.items.filter((item) => item.status === 'READY');

        if (conflictStrategy === 'ABORT_ON_CONFLICT' && conflicts.length > 0) {
          return {
            abortedDueToConflict: true,
            insertedIds: [] as number[],
            readyItems,
            conflicts,
            summary: evaluation.summary,
          };
        }

        const insertedIds: number[] = [];
        for (const item of readyItems) {
          const ins = await tx.execute(
            `INSERT INTO shift_assignments (
              person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
              snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
              snapshot_is_cross_midnight, status, assigned_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?)`,
            [
              item.personId,
              shift.id,
              item.workDate,
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
          if (ins.insertId) {
            insertedIds.push(ins.insertId);
          }
        }

        return {
          abortedDueToConflict: false,
          insertedIds,
          readyItems,
          conflicts,
          summary: evaluation.summary,
        };
      });

      if (txOutcome.abortedDueToConflict) {
        res.status(409).json({
          error: 'BULK_SHIFT_CONFLICT',
          message: `พบตารางเวรซ้ำหรือเวลาทับซ้อน ${txOutcome.conflicts.length} รายการ ระบบยกเลิกการบันทึกทั้งหมดตามนโยบายที่เลือก`,
          summary: txOutcome.summary,
          conflicts: txOutcome.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SHIFT_BULK_ASSIGNED',
        targetType: 'SHIFT_ASSIGNMENT',
        targetId: txOutcome.insertedIds.join(',') || 'NONE',
        result: 'SUCCESS',
        detail: {
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          conflictStrategy,
          totalRequested: txOutcome.summary.totalRequested,
          insertedCount: txOutcome.insertedIds.length,
          skippedConflictCount: txOutcome.conflicts.length,
          personIds,
          workDates,
        },
      });

      res.status(201).json({
        status: 'SUCCESS',
        shiftSnapshot: {
          shiftId: shift.id,
          shiftCode: shift.shift_code,
          shiftName: shift.shift_name,
          startTime: shift.start_time,
          endTime: shift.end_time,
          graceMinutes: shift.grace_minutes,
          cutoffTime: shift.cutoff_time,
          isCrossMidnight: Number(shift.is_cross_midnight),
        },
        insertedCount: txOutcome.insertedIds.length,
        skippedConflictCount: txOutcome.conflicts.length,
        insertedIds: txOutcome.insertedIds,
        conflicts: txOutcome.conflicts,
        summary: txOutcome.summary,
      });
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

      const shifts = await dbQuery<ShiftRow>(
        'SELECT * FROM shifts WHERE id = ? AND is_active = 1 LIMIT 1',
        [shiftId]
      );

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
      const cancelReason = String(
        req.body?.cancelReason ||
          req.query.cancelReason ||
          'ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน'
      ).trim();

      const rows = await dbQuery<{
        id: number;
        person_id: string;
        work_date: string;
        snapshot_shift_code: string;
        status: string;
      }>(
        'SELECT id, person_id, work_date, snapshot_shift_code, status FROM shift_assignments WHERE id = ? LIMIT 1',
        [assignmentId]
      );

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
        [
          assignmentId,
          row.person_id,
          row.work_date,
          row.snapshot_shift_code,
          cancelReason,
          req.user!.username,
        ]
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
