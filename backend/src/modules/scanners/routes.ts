import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { computeRawScanDedupKey, type SixFieldScannerEvent } from '../../utils/crypto.ts';
import { requireAuth, requireRoles, enforceOwnPersonMapping } from '../../middleware/auth.ts';
import { resolveRawScanPersonnelMappings, reprocessAttendanceRange } from '../attendance/processor.ts';
import { writeAuditLog } from '../audit/service.ts';

const execFileAsync = promisify(execFile);

// Test Double hook strictly for automated integration tests (never active in production)
let testDoubleScannerOutput: string | Error | null = null;

export function setScannerExeTestDouble(output: string | Error | null): void {
  testDoubleScannerOutput = output;
}

/**
 * Validates that an incoming object strictly conforms to the 6-field Scanner Reader EXE JSON contract:
 * { machineNo, enrollNumber, scanDateTime, verifyMode, inOutMode, workCode }
 */
export function validateSixFieldEvent(raw: unknown): SixFieldScannerEvent {
  if (!raw || typeof raw !== 'object') {
    throw new Error('INVALID_EVENT_OBJECT: Event must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;
  const machineNo = Number(obj.machineNo);
  const enrollNumber = String(obj.enrollNumber ?? '').trim();
  const scanDateTime = String(obj.scanDateTime ?? '').trim();
  const verifyMode = Number(obj.verifyMode);
  const inOutMode = Number(obj.inOutMode);
  const workCode = Number(obj.workCode);

  if (!Number.isInteger(machineNo) || machineNo <= 0) {
    throw new Error(`INVALID_MACHINE_NO: ${String(obj.machineNo)}`);
  }
  if (!enrollNumber) {
    throw new Error('INVALID_ENROLL_NUMBER: enrollNumber cannot be empty');
  }
  if (!scanDateTime) {
    throw new Error('INVALID_SCAN_DATETIME: scanDateTime cannot be empty');
  }
  if (!Number.isInteger(verifyMode) || !Number.isInteger(inOutMode) || !Number.isInteger(workCode)) {
    throw new Error('INVALID_MODE_FIELDS: verifyMode, inOutMode, and workCode must be integers');
  }

  return {
    machineNo,
    enrollNumber,
    scanDateTime,
    verifyMode,
    inOutMode,
    workCode,
  };
}

export async function ingestSixFieldEventsBatch(
  rawEvents: unknown[],
  triggerMode: string,
  triggeredBy: string,
  machineNoFilter?: number | null
): Promise<{
  syncRunId: number;
  totalRead: number;
  newInserted: number;
  duplicatesSkipped: number;
  unmatchedCount: number;
  affectedDates: string[];
}> {
  const validatedEvents: Array<{
    event: SixFieldScannerEvent;
    dedupKey: string;
    canonicalBkkTime: string;
  }> = [];

  for (const item of rawEvents) {
    const ev = validateSixFieldEvent(item);
    const { dedupKey, canonicalBkkTime } = computeRawScanDedupKey(ev);
    validatedEvents.push({ event: ev, dedupKey, canonicalBkkTime });
  }

  const runRes = await dbExecute(
    `INSERT INTO sync_runs (
      trigger_mode, machine_no, status, total_events_read, triggered_by
    ) VALUES (?, ?, 'RUNNING', ?, ?)`,
    [triggerMode, machineNoFilter ?? null, validatedEvents.length, triggeredBy]
  );
  const syncRunId = runRes.insertId || 1;

  let newInserted = 0;
  let duplicatesSkipped = 0;
  const affectedDateSet = new Set<string>();

  for (const { event, dedupKey, canonicalBkkTime } of validatedEvents) {
    const existing = await dbQuery<{ id: number }>(
      'SELECT id FROM raw_scans WHERE event_dedup_key = ? LIMIT 1',
      [dedupKey]
    );

    if (existing.length > 0) {
      duplicatesSkipped++;
      continue;
    }

    const payloadJson = JSON.stringify(event);
    await dbExecute(
      `INSERT INTO raw_scans (
        event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
        verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'UNMATCHED', ?)`,
      [
        dedupKey,
        event.machineNo,
        event.enrollNumber,
        event.scanDateTime,
        canonicalBkkTime,
        event.verifyMode,
        event.inOutMode,
        event.workCode,
        payloadJson,
        syncRunId,
      ]
    );
    newInserted++;
    affectedDateSet.add(canonicalBkkTime.slice(0, 10));
  }

  const sortedDates = Array.from(affectedDateSet).sort();
  let unmatchedCount = 0;

  if (sortedDates.length > 0) {
    const minDate = sortedDates[0];
    const maxDate = sortedDates[sortedDates.length - 1];
    const mapStats = await resolveRawScanPersonnelMappings(minDate, maxDate);
    unmatchedCount = mapStats.unmatchedCount;

    await reprocessAttendanceRange({
      dateFrom: minDate,
      dateTo: maxDate,
      actorUsername: triggeredBy,
    });
  }

  await dbExecute(
    `UPDATE sync_runs
     SET finished_at = CURRENT_TIMESTAMP, status = 'SUCCESS',
         new_scans_inserted = ?, duplicate_scans_skipped = ?, unmatched_scans_count = ?
     WHERE id = ?`,
    [newInserted, duplicatesSkipped, unmatchedCount, syncRunId]
  );

  if (machineNoFilter) {
    await dbExecute(
      `UPDATE scanner_devices
       SET last_sync_at = CURRENT_TIMESTAMP, last_success_at = CURRENT_TIMESTAMP,
           last_sync_status = 'SUCCESS', last_error_message = NULL
       WHERE machine_no = ?`,
      [machineNoFilter]
    );
  }

  return {
    syncRunId,
    totalRead: validatedEvents.length,
    newInserted,
    duplicatesSkipped,
    unmatchedCount,
    affectedDates: sortedDates,
  };
}

export const scannersRouter = Router();

scannersRouter.get(
  '/scanners',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const devices = await dbQuery('SELECT * FROM scanner_devices ORDER BY machine_no ASC');
      const schedules = await dbQuery('SELECT * FROM sync_schedules ORDER BY cron_time ASC');
      const syncRuns = await dbQuery('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 25');
      const cfg = loadConfig();

      res.json({
        devices,
        schedules,
        syncRuns,
        exeContractStatus: {
          syncEnabled: cfg.scanner.syncEnabled,
          readerExePath: cfg.scanner.readerExePath,
          exeBinaryPresent: fs.existsSync(cfg.scanner.readerExePath),
          contractFields: ['machineNo', 'enrollNumber', 'scanDateTime', 'verifyMode', 'inOutMode', 'workCode'],
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

scannersRouter.post('/scanners', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const machineNo = Number(req.body?.machineNo);
    const deviceName = String(req.body?.deviceName || '').trim();
    const ipAddress = String(req.body?.ipAddress || '').trim();
    const devicePort = Number(req.body?.devicePort || 4370);
    const locationName = String(req.body?.locationName || '').trim();

    if (!Number.isInteger(machineNo) || machineNo <= 0 || !deviceName || !ipAddress || !locationName) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุหมายเลขเครื่อง (machineNo), ชื่อเครื่อง, IP Address และสถานที่ติดตั้งให้ครบถ้วน',
        requestId: req.requestId,
      });
      return;
    }

    const dup = await dbQuery<{ id: number }>(
      'SELECT id FROM scanner_devices WHERE machine_no = ? LIMIT 1',
      [machineNo]
    );
    if (dup.length > 0) {
      res.status(409).json({
        error: 'DUPLICATE_MACHINE_NO',
        message: `เครื่องสแกนหมายเลข ${machineNo} มีอยู่ในทะเบียนแล้ว`,
        requestId: req.requestId,
      });
      return;
    }

    const result = await dbExecute(
      `INSERT INTO scanner_devices (
        machine_no, device_name, ip_address, device_port, location_name, is_enabled, last_sync_status
      ) VALUES (?, ?, ?, ?, ?, 1, 'NEVER_RUN')`,
      [machineNo, deviceName, ipAddress, devicePort, locationName]
    );

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'SCANNER_DEVICE_CREATED',
      targetType: 'SCANNER_DEVICE',
      targetId: String(machineNo),
      result: 'SUCCESS',
      detail: { machineNo, deviceName, ipAddress, devicePort, locationName },
    });

    res.status(201).json({
      id: result.insertId,
      machineNo,
      deviceName,
      ipAddress,
      devicePort,
      locationName,
      isEnabled: 1,
    });
  } catch (err) {
    next(err);
  }
});

scannersRouter.put('/scanners/:id', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const deviceName = String(req.body?.deviceName || '').trim();
    const ipAddress = String(req.body?.ipAddress || '').trim();
    const devicePort = Number(req.body?.devicePort || 4370);
    const locationName = String(req.body?.locationName || '').trim();

    if (!deviceName || !ipAddress || !locationName) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุชื่อเครื่อง, IP Address และสถานที่ติดตั้ง',
        requestId: req.requestId,
      });
      return;
    }

    await dbExecute(
      `UPDATE scanner_devices
       SET device_name = ?, ip_address = ?, device_port = ?, location_name = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [deviceName, ipAddress, devicePort, locationName, id]
    );

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'SCANNER_DEVICE_UPDATED',
      targetType: 'SCANNER_DEVICE',
      targetId: String(id),
      result: 'SUCCESS',
      detail: { deviceName, ipAddress, devicePort, locationName },
    });

    res.json({ status: 'UPDATED', id });
  } catch (err) {
    next(err);
  }
});

scannersRouter.patch(
  '/scanners/:id/enabled',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const isEnabled = req.body?.isEnabled ? 1 : 0;

      await dbExecute(
        'UPDATE scanner_devices SET is_enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [isEnabled, id]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SCANNER_DEVICE_TOGGLED',
        targetType: 'SCANNER_DEVICE',
        targetId: String(id),
        result: 'SUCCESS',
        detail: { isEnabled },
      });

      res.json({ status: 'UPDATED', id, isEnabled });
    } catch (err) {
      next(err);
    }
  }
);

scannersRouter.delete('/scanners/:id', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    await dbExecute('DELETE FROM scanner_devices WHERE id = ?', [id]);

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'SCANNER_DEVICE_DELETED',
      targetType: 'SCANNER_DEVICE',
      targetId: String(id),
      result: 'SUCCESS',
    });

    res.json({ status: 'DELETED', id });
  } catch (err) {
    next(err);
  }
});

scannersRouter.get(
  '/sync-runs',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const items = await dbQuery('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 50');
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

scannersRouter.post(
  '/sync-schedules',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const scheduleLabel = String(req.body?.scheduleLabel || '').trim();
      const cronTime = String(req.body?.cronTime || '').trim();
      if (!scheduleLabel || !/^\d{2}:\d{2}$/.test(cronTime)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุชื่อรอบซิงก์และเวลาในรูปแบบ HH:mm (เช่น 00:00 หรือ 08:00)',
          requestId: req.requestId,
        });
        return;
      }

      const result = await dbExecute(
        'INSERT INTO sync_schedules (schedule_label, cron_time, is_enabled, updated_by) VALUES (?, ?, 1, ?)',
        [scheduleLabel, cronTime, req.user!.username]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SYNC_SCHEDULE_CREATED',
        targetType: 'SYNC_SCHEDULE',
        targetId: String(result.insertId),
        result: 'SUCCESS',
        detail: { scheduleLabel, cronTime },
      });

      res.status(201).json({
        id: result.insertId,
        scheduleLabel,
        cronTime,
        isEnabled: 1,
      });
    } catch (err) {
      next(err);
    }
  }
);

scannersRouter.patch(
  '/sync-schedules/:id',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const isEnabled = req.body?.isEnabled ? 1 : 0;
      await dbExecute(
        'UPDATE sync_schedules SET is_enabled = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [isEnabled, req.user!.username, id]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SYNC_SCHEDULE_TOGGLED',
        targetType: 'SYNC_SCHEDULE',
        targetId: String(id),
        result: 'SUCCESS',
        detail: { isEnabled },
      });

      res.json({ status: 'UPDATED', id, isEnabled });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Triggers Scanner Reader EXE Sync.
 * Strictly honors the rule: never fake a successful hardware sync if the EXE binary or device is unavailable!
 */
scannersRouter.post(
  '/scanners/sync',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    const actor = req.user!.username;
    const machineNo = req.body?.machineNo ? Number(req.body.machineNo) : null;
    const cfg = loadConfig();

    try {
      let stdoutText: string;

      if (testDoubleScannerOutput !== null) {
        if (testDoubleScannerOutput instanceof Error) {
          throw testDoubleScannerOutput;
        }
        stdoutText = testDoubleScannerOutput;
      } else {
        if (!cfg.scanner.syncEnabled) {
          const err = new Error(
            'BLOCKED_BY_EXTERNAL_CONTRACT: ปิดการเรียก ScannerReader.exe อัตโนมัติไว้ (SCANNER_SYNC_ENABLED=false) กรุณาตั้งค่า Path ของไฟล์ EXE เดิมบนเครื่อง Windows Server ก่อนเปิดใช้งานจริง'
          );
          (err as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
          throw err;
        }
        if (!fs.existsSync(cfg.scanner.readerExePath)) {
          const err = new Error(
            `SCANNER_EXE_NOT_FOUND: ไม่พบไฟล์ ScannerReader.exe ที่ ${cfg.scanner.readerExePath}`
          );
          (err as Error & { code?: string }).code = 'SCANNER_EXE_NOT_FOUND';
          throw err;
        }

        const args = machineNo ? ['--machine', String(machineNo)] : [];
        const { stdout } = await execFileAsync(cfg.scanner.readerExePath, args, {
          timeout: cfg.scanner.timeoutMs,
        });
        stdoutText = stdout;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(stdoutText);
      } catch {
        const err = new Error('INVALID_EXE_JSON_OUTPUT: ผลลัพธ์จาก ScannerReader.exe ไม่ใช่ JSON ที่ถูกต้อง');
        (err as Error & { code?: string }).code = 'INVALID_EXE_JSON_OUTPUT';
        throw err;
      }

      if (!Array.isArray(parsed)) {
        const err = new Error('INVALID_EXE_CONTRACT: JSON จาก ScannerReader.exe ต้องเป็น Array ของ Event 6 ฟิลด์');
        (err as Error & { code?: string }).code = 'INVALID_EXE_CONTRACT';
        throw err;
      }

      const result = await ingestSixFieldEventsBatch(parsed, 'MANUAL_EXE_SYNC', actor, machineNo);

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: actor,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SCANNER_SYNC_SUCCESS',
        targetType: 'SCANNER',
        targetId: machineNo ? String(machineNo) : 'ALL',
        result: 'SUCCESS',
        detail: result,
      });

      res.json({
        status: 'SUCCESS',
        ...result,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || 'SCANNER_SYNC_FAILED';
      const message = err instanceof Error ? err.message : String(err);

      await dbExecute(
        `INSERT INTO sync_runs (
          trigger_mode, machine_no, finished_at, status,
          total_events_read, new_scans_inserted, duplicate_scans_skipped, unmatched_scans_count,
          error_code, error_message, triggered_by
        ) VALUES ('MANUAL_EXE_SYNC', ?, CURRENT_TIMESTAMP, 'FAILED', 0, 0, 0, 0, ?, ?, ?)`,
        [machineNo, code, message, actor]
      );

      if (machineNo) {
        await dbExecute(
          `UPDATE scanner_devices
           SET last_sync_at = CURRENT_TIMESTAMP, last_sync_status = 'FAILED', last_error_message = ?
           WHERE machine_no = ?`,
          [message, machineNo]
        );
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: actor,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'SCANNER_SYNC_FAILED',
        targetType: 'SCANNER',
        targetId: machineNo ? String(machineNo) : 'ALL',
        result: 'FAILURE',
        errorCode: code,
        detail: { message },
      });

      const httpStatus = code.startsWith('INVALID_') ? 422 : 503;
      res.status(httpStatus).json({
        error: code,
        message,
        failClosed: true,
        requestId: req.requestId,
      });
    }
  }
);

/**
 * Authenticated ingestion endpoint for receiving 6-field JSON events directly from ScannerReader.exe
 * or via the EXE Contract Test Harness.
 */
scannersRouter.post(
  '/scanners/ingest',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const events = req.body?.events;
      if (!Array.isArray(events) || events.length === 0) {
        res.status(400).json({
          error: 'INVALID_PAYLOAD',
          message: 'กรุณาส่ง events เป็น JSON Array ของข้อมูล 6 ฟิลด์ตามสัญญา EXE',
          requestId: req.requestId,
        });
        return;
      }

      const result = await ingestSixFieldEventsBatch(
        events,
        'EXE_JSON_INGEST',
        req.user!.username,
        null
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'RAW_SCANS_INGESTED',
        targetType: 'RAW_SCANS',
        targetId: String(result.syncRunId),
        result: 'SUCCESS',
        detail: result,
      });

      res.status(201).json({
        status: 'SUCCESS',
        ...result,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(422).json({
        error: 'EXE_CONTRACT_VALIDATION_FAILED',
        message,
        requestId: req.requestId,
      });
    }
  }
);

scannersRouter.get(
  '/raw-scans',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const dateFrom = String(req.query.dateFrom || '').trim();
      const dateTo = String(req.query.dateTo || '').trim();
      const machineNo = String(req.query.machineNo || '').trim();
      const mappingState = String(req.query.mappingState || '').trim();
      const search = String(req.query.search || '').trim();

      const conditions = ['1=1'];
      const params: unknown[] = [];

      if (dateFrom) {
        conditions.push('rs.canonical_bkk_time >= ?');
        params.push(`${dateFrom} 00:00:00`);
      }
      if (dateTo) {
        conditions.push('rs.canonical_bkk_time <= ?');
        params.push(`${dateTo} 23:59:59`);
      }
      if (machineNo) {
        conditions.push('rs.machine_no = ?');
        params.push(Number(machineNo));
      }
      if (mappingState) {
        conditions.push('rs.mapping_state = ?');
        params.push(mappingState);
      }
      if (search) {
        conditions.push('(rs.enroll_number LIKE ? OR rs.matched_person_id LIKE ? OR p.full_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      const items = await dbQuery(
        `SELECT rs.*, p.full_name, p.department_name
         FROM raw_scans rs
         LEFT JOIN personnel p ON p.person_id = rs.matched_person_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY rs.canonical_bkk_time DESC
         LIMIT 200`,
        params
      );

      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

scannersRouter.get(
  '/me/raw-scans',
  requireAuth,
  enforceOwnPersonMapping,
  async (req, res, next) => {
    try {
      const personId = req.user!.approvedPersonId!;
      const items = await dbQuery(
        `SELECT id, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
                verify_mode, in_out_mode, work_code, mapping_state, imported_at
         FROM raw_scans
         WHERE matched_person_id = ?
         ORDER BY canonical_bkk_time DESC`,
        [personId]
      );
      res.json({ personId, items });
    } catch (err) {
      next(err);
    }
  }
);
