/**
 * ============================================================================
 * โมดูลจัดการเครื่องสแกนนิ้ว การรับข้อมูลสแกนดิบ 6 ฟิลด์ และตารางเวลาซิงก์ (Scanner & Raw Scans Routes)
 * ไฟล์: backend/src/modules/scanners/routes.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. ตรวจสอบสัญญาข้อมูลสแกน 6 ฟิลด์จาก `ScannerReader.exe` อย่างเคร่งครัด (`validateSixFieldEvent`)
 * 2. บันทึกข้อมูลสแกนดิบลงตาราง `raw_scans` แบบ Append-Only เท่านั้น (ห้าม UPDATE/DELETE เด็ดขาด — แก้ไข P1 ข้อ 08)
 *    และบันทึกผลการจับคู่ `FINGLE_ID` ลงตาราง `raw_scan_mappings`
 * 3. มีกลไก Mutex Lock (`scannerSyncMutexLocked`) ป้องกันการกดซิงก์ซ้อนกับรอบซิงก์อัตโนมัติ (แก้ไข P1 ข้อ 09)
 * 4. รองรับการตรวจสอบโทเค็นของเครื่องสแกน (`X-Scanner-Token`) ด้วย `verifyScannerIngestToken` แบบ Timing-Safe (แก้ไข P0 ข้อ 04)
 * 5. ทดสอบและจัดการกรณีเครื่องสแกนไม่ตอบสนอง, Timeout, JSON ผิดรูปแบบ และการซิงก์ซ้ำ (แก้ไข P1 ข้อ 18)
 */
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import {
  computeRawScanDedupKey,
  verifyScannerIngestToken,
  getCurrentBangkokDateParts,
  type SixFieldScannerEvent,
} from '../../utils/crypto.ts';
import { requireAuth, requireRoles, enforceOwnPersonMapping } from '../../middleware/auth.ts';
import { resolveRawScanPersonnelMappings, reprocessAttendanceRange } from '../attendance/processor.ts';
import { writeAuditLog } from '../audit/service.ts';
import { evaluateDueSyncSchedules, getScannerSchedulerStatus } from './scheduler.ts';
import {
  startCentralJob,
  updateCentralJobStep,
  completeCentralJob,
  failCentralJob,
  getLatestJobByType,
} from '../jobs/tracker.ts';

const execFileAsync = promisify(execFile);

// Test Double hook strictly for automated integration tests (never active in production)
let testDoubleScannerOutput: string | Error | null = null;
let scannerSyncMutexLocked = false;

export function setScannerExeTestDouble(output: string | Error | null): void {
  testDoubleScannerOutput = output;
}

export function isScannerSyncLocked(): boolean {
  return scannerSyncMutexLocked;
}

export function setScannerSyncLockForTests(locked: boolean): void {
  scannerSyncMutexLocked = locked;
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

/**
 * บันทึกชุดข้อมูลสแกน 6 ฟิลด์ลงตาราง `raw_scans` แบบ Append-Only
 * พร้อมสร้างแถวเริ่มต้นใน `raw_scan_mappings`, จับคู่บุคลากร และสั่ง Reprocess อัตโนมัติ
 */
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
    const insertRes = await dbExecute(
      `INSERT INTO raw_scans (
        event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
        verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'IMMUTABLE_RAW', ?)`,
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

    if (insertRes.insertId) {
      await dbExecute(
        `INSERT IGNORE INTO raw_scan_mappings (
          raw_scan_id, event_dedup_key, enroll_number, matched_person_id, mapping_state, mapping_rule_note
        ) VALUES (?, ?, ?, NULL, 'UNMATCHED', 'PENDING_INITIAL_RESOLUTION')`,
        [insertRes.insertId, dedupKey, event.enrollNumber]
      );
    }

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

/**
 * ฟังก์ชันกลางสำหรับสั่งรัน `ScannerReader.exe` (ใช้ร่วมกันทั้งการกด Manual Sync และ Automatic Scheduler)
 * มีการล็อกป้องกันการทำงานซ้อนกัน (Concurrency Mutex) และรองรับการตรวจจับ Timeout / เครื่องสแกนไม่ตอบสนอง
 */
export async function executeScannerReaderSync(options: {
  triggerMode: string;
  actorUsername: string;
  actorRole: string;
  machineNo?: number | null;
  requestId?: string;
  ipAddress?: string;
}) {
  if (scannerSyncMutexLocked) {
    const conflictErr = new Error(
      'SYNC_ALREADY_RUNNING: ระบบกำลังดึงข้อมูลจากเครื่องสแกนอยู่ในขณะนี้ กรุณารอให้รอบปัจจุบันเสร็จสิ้นก่อน'
    );
    (conflictErr as Error & { code?: string; statusCode?: number }).code = 'SYNC_ALREADY_RUNNING';
    (conflictErr as Error & { code?: string; statusCode?: number }).statusCode = 409;
    throw conflictErr;
  }

  scannerSyncMutexLocked = true;
  const cfg = loadConfig();
  const machineNo = options.machineNo ?? null;

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
          `SCANNER_EXE_NOT_FOUND: ไม่พบไฟล์โปรแกรมดึงข้อมูลสแกนนิ้วที่ ${cfg.scanner.readerExePath}`
        );
        (err as Error & { code?: string }).code = 'SCANNER_EXE_NOT_FOUND';
        throw err;
      }

      const isScannerSyncCli = /ScannerSyncCli\.exe$/i.test(cfg.scanner.readerExePath);
      const args: string[] = [];
      if (isScannerSyncCli) {
        args.push('--days', String(cfg.scanner.syncDays));
        if (cfg.scanner.previewMode) {
          args.push('--preview');
        }
      }
      if (machineNo) {
        args.push('--machine', String(machineNo));
      }

      const exeWorkingDir = cfg.scanner.readerExePath.replace(/[\\/][^\\/]+$/, '') || process.cwd();
      try {
        const { stdout } = await execFileAsync(cfg.scanner.readerExePath, args, {
          cwd: exeWorkingDir,
          timeout: cfg.scanner.timeoutMs,
          env: {
            ...process.env,
            SCANNER_MYSQL_CONNECTION_STRING: cfg.scanner.mysqlConnectionString,
          },
        });
        stdoutText = stdout;
      } catch (execErr: any) {
        if (execErr?.killed || execErr?.signal === 'SIGTERM' || String(execErr?.code) === 'ETIMEDOUT') {
          const timeoutErr = new Error(
            `SCANNER_TIMEOUT: เครื่องสแกนนิ้วหรือโปรแกรมดึงสแกนไม่ตอบสนองภายในเวลาที่กำหนด (${cfg.scanner.timeoutMs} ms)`
          );
          (timeoutErr as Error & { code?: string }).code = 'SCANNER_TIMEOUT';
          throw timeoutErr;
        }
        // ScannerSyncCli.exe คืนค่า exitCode = 1 เมื่ออ่านสำเร็จบางเครื่อง หรือ exitCode = 2 พร้อมพิมพ์ JSON ลง stdout
        if (typeof execErr?.stdout === 'string' && execErr.stdout.trim().length > 0) {
          stdoutText = execErr.stdout;
        } else {
          const unreachableErr = new Error(
            `SCANNER_DEVICE_UNREACHABLE: ไม่สามารถดึงข้อมูลจากเครื่องสแกนได้ (${execErr?.message || 'Unknown EXE error'})`
          );
          (unreachableErr as Error & { code?: string }).code = 'SCANNER_DEVICE_UNREACHABLE';
          throw unreachableErr;
        }
      }
    }

    let parsed: unknown;
    try {
      const trimmedOut = stdoutText.trim();
      try {
        parsed = JSON.parse(trimmedOut);
      } catch {
        // กรณีมีบรรทัดข้อความอื่นนำหน้า JSON บน stdout ให้ตัดเฉพาะก้อน JSON มาแปลง
        const firstBrace = trimmedOut.search(/[\[{]/);
        if (firstBrace > 0) {
          parsed = JSON.parse(trimmedOut.slice(firstBrace));
        } else {
          throw new Error('JSON parse failed');
        }
      }
    } catch {
      const err = new Error('INVALID_EXE_JSON_OUTPUT: ผลลัพธ์จากโปรแกรมดึงสแกนไม่ใช่ JSON ที่ถูกต้อง');
      (err as Error & { code?: string }).code = 'INVALID_EXE_JSON_OUTPUT';
      throw err;
    }

    let eventsToIngest: unknown[];
    if (Array.isArray(parsed)) {
      eventsToIngest = parsed;
    } else if (parsed && typeof parsed === 'object') {
      const wrapper = parsed as {
        success?: boolean;
        message?: string;
        error?: string;
        exitCode?: number;
        machines?: Array<{
          machineNo?: number;
          ip?: string;
          read?: number;
          new?: number;
          duplicates?: number;
          status?: string;
        }>;
        scans?: unknown[];
      };

      if (Array.isArray(wrapper.machines)) {
        for (const m of wrapper.machines) {
          if (typeof m.machineNo === 'number') {
            const machineOk = String(m.status || '').toUpperCase() === 'OK';
            await dbExecute(
              `UPDATE scanner_devices
               SET last_sync_at = CURRENT_TIMESTAMP,
                   last_sync_status = ?,
                   last_error_message = ?
               WHERE machine_no = ?`,
              [
                machineOk ? 'SUCCESS' : 'FAILED',
                machineOk ? null : `สถานะจาก ScannerSyncCli: ${m.status || 'FAILED'}`,
                m.machineNo,
              ]
            );
          }
        }
      }

      if (wrapper.success === false) {
        const errMsg = wrapper.error || wrapper.message || 'ไม่สามารถดึงข้อมูลจากเครื่องสแกนนิ้วได้';
        if (errMsg.includes('Another sync process')) {
          const conflictErr = new Error(`SYNC_ALREADY_RUNNING: ${errMsg}`);
          (conflictErr as Error & { code?: string; statusCode?: number }).code = 'SYNC_ALREADY_RUNNING';
          (conflictErr as Error & { code?: string; statusCode?: number }).statusCode = 409;
          throw conflictErr;
        }
        const unreachableErr = new Error(`SCANNER_DEVICE_UNREACHABLE: ${errMsg}`);
        (unreachableErr as Error & { code?: string }).code = 'SCANNER_DEVICE_UNREACHABLE';
        throw unreachableErr;
      }

      if (!Array.isArray(wrapper.scans)) {
        const err = new Error(
          'INVALID_EXE_CONTRACT: JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array 6 ฟิลด์ หรือ Object ที่มีฟิลด์ scans เป็น Array'
        );
        (err as Error & { code?: string }).code = 'INVALID_EXE_CONTRACT';
        throw err;
      }

      eventsToIngest = wrapper.scans;
    } else {
      const err = new Error('INVALID_EXE_CONTRACT: JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array ของ Event 6 ฟิลด์');
      (err as Error & { code?: string }).code = 'INVALID_EXE_CONTRACT';
      throw err;
    }

    const result = await ingestSixFieldEventsBatch(
      eventsToIngest,
      options.triggerMode,
      options.actorUsername,
      machineNo
    );

    await writeAuditLog({
      requestId: options.requestId || 'scanner-sync',
      actorUsername: options.actorUsername,
      actorRole: options.actorRole,
      ipAddress: options.ipAddress || '127.0.0.1',
      action: 'SCANNER_SYNC_SUCCESS',
      targetType: 'SCANNER',
      targetId: machineNo ? String(machineNo) : 'ALL',
      result: 'SUCCESS',
      detail: result,
    });

    return result;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || 'SCANNER_SYNC_FAILED';
    const message = err instanceof Error ? err.message : String(err);

    await dbExecute(
      `INSERT INTO sync_runs (
        trigger_mode, machine_no, finished_at, status,
        total_events_read, new_scans_inserted, duplicate_scans_skipped, unmatched_scans_count,
        error_code, error_message, triggered_by
      ) VALUES (?, ?, CURRENT_TIMESTAMP, 'FAILED', 0, 0, 0, 0, ?, ?, ?)`,
      [options.triggerMode, machineNo, code, message, options.actorUsername]
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
      requestId: options.requestId || 'scanner-sync',
      actorUsername: options.actorUsername,
      actorRole: options.actorRole,
      ipAddress: options.ipAddress || '127.0.0.1',
      action: 'SCANNER_SYNC_FAILED',
      targetType: 'SCANNER',
      targetId: machineNo ? String(machineNo) : 'ALL',
      result: 'FAILURE',
      errorCode: code,
      detail: { message },
    });

    throw err;
  } finally {
    scannerSyncMutexLocked = false;
  }
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
        schedulerStatus: getScannerSchedulerStatus(),
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

scannersRouter.get(
  '/scanners/scheduler/status',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res) => {
    res.json(getScannerSchedulerStatus());
  }
);

scannersRouter.post(
  '/scanners/scheduler/run-due',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const referenceBkkNow = req.body?.referenceBkkNow ? String(req.body.referenceBkkNow).trim() : undefined;
      const result = await evaluateDueSyncSchedules(referenceBkkNow);
      res.json(result);
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
  async (req, res, next) => {
    try {
      const period = String(req.query.period || 'ALL').trim().toUpperCase();
      let dateFrom = String(req.query.dateFrom || '').trim();
      let dateTo = String(req.query.dateTo || '').trim();
      const machineNo = String(req.query.machineNo || '').trim();
      const status = String(req.query.status || '').trim();
      const page = Math.max(1, Number(req.query.page || 1));
      const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize || 50)));

      if (!dateFrom && !dateTo && (period === 'TODAY' || period === '7D' || period === '30D')) {
        const bkk = getCurrentBangkokDateParts();
        dateTo = bkk.todayYmd;
        const [y, m, d] = bkk.todayYmd.split('-').map(Number);
        const offsetDays = period === 'TODAY' ? 0 : period === '7D' ? -6 : -29;
        const startDt = new Date(Date.UTC(y, m - 1, d + offsetDays));
        dateFrom = startDt.toISOString().slice(0, 10);
      }

      const conditions = ['1=1'];
      const params: unknown[] = [];

      if (dateFrom && /^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
        conditions.push('started_at >= ?');
        params.push(`${dateFrom} 00:00:00`);
      }
      if (dateTo && /^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
        conditions.push('started_at <= ?');
        params.push(`${dateTo} 23:59:59`);
      }
      if (machineNo && machineNo !== 'ALL') {
        conditions.push('machine_no = ?');
        params.push(Number(machineNo));
      }
      if (status && status !== 'ALL') {
        conditions.push('status = ?');
        params.push(status);
      }

      const whereSql = conditions.join(' AND ');
      const countRows = await dbQuery<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM sync_runs WHERE ${whereSql}`,
        params
      );
      const totalCount = Number(countRows[0]?.cnt ?? 0);
      const offset = (page - 1) * pageSize;

      const items = await dbQuery(
        `SELECT * FROM sync_runs WHERE ${whereSql} ORDER BY id DESC LIMIT ${pageSize} OFFSET ${offset}`,
        params
      );

      const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
      res.json({
        items,
        total: totalCount,
        totalCount,
        page,
        pageSize,
        pagination: {
          page,
          pageSize,
          totalCount,
          totalPages,
        },
        latestJob: getLatestJobByType('SCANNER_MANUAL_SYNC'),
      });
    } catch (err) {
      next(err);
    }
  }
);

scannersRouter.get(
  '/sync-runs/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const runId = Number(req.params.id);
      const rows = await dbQuery('SELECT * FROM sync_runs WHERE id = ? LIMIT 1', [runId]);
      if (rows.length === 0) {
        res.status(404).json({
          error: 'SYNC_RUN_NOT_FOUND',
          message: 'ไม่พบข้อมูลรอบการดึงข้อมูลที่เลือก',
          requestId: req.requestId,
        });
        return;
      }
      res.json({ item: rows[0] });
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
 * Triggers Scanner Reader EXE Sync (Manual Sync).
 */
scannersRouter.post(
  '/scanners/sync',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res) => {
    const actor = req.user!.username;
    const machineNo = req.body?.machineNo ? Number(req.body.machineNo) : null;

    let trackedJobId: string | null = null;
    try {
      const job = startCentralJob({
        jobType: 'SCANNER_MANUAL_SYNC',
        actorUsername: actor,
        initialStep: machineNo
          ? `กำลังเชื่อมต่อเครื่องสแกนหมายเลข #${machineNo} และอ่านข้อมูลสแกนนิ้ว...`
          : 'กำลังเชื่อมต่อเครื่องสแกนทุกเครื่องที่เปิดใช้งานและอ่านข้อมูลสแกนนิ้ว...',
      });
      trackedJobId = job.jobId;
    } catch {
      // Concurrency handled inside executeScannerReaderSync
    }

    try {
      const result = await executeScannerReaderSync({
        triggerMode: 'MANUAL_EXE_SYNC',
        actorUsername: actor,
        actorRole: req.user!.role,
        machineNo,
        requestId: req.requestId,
        ipAddress: req.ip || '127.0.0.1',
      });

      if (trackedJobId) {
        updateCentralJobStep(trackedJobId, {
          currentStep: 'กำลังจับคู่รหัสสแกนนิ้วและคำนวณเวลาปฏิบัติงาน...',
          processedCount: Number(result.totalRead ?? 0),
          totalCount: Number(result.totalRead ?? 0),
        });
        completeCentralJob(trackedJobId, {
          currentStep: 'ดึงข้อมูลจากเครื่องสแกนและคำนวณเวลาเสร็จสมบูรณ์',
          processedCount: Number(result.totalRead ?? 0),
          totalCount: Number(result.totalRead ?? 0),
          resultSummary: result as unknown as Record<string, unknown>,
        });
      }

      res.json({
        status: 'SUCCESS',
        jobId: trackedJobId,
        ...result,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || 'SCANNER_SYNC_FAILED';
      const statusCode = (err as { statusCode?: number })?.statusCode;
      const message = err instanceof Error ? err.message : String(err);

      if (trackedJobId) {
        failCentralJob(trackedJobId, {
          currentStep: 'การดึงข้อมูลจากเครื่องสแกนไม่สำเร็จ',
          errorCode: code,
          errorMessage: message,
        });
      }

      const httpStatus = statusCode || (code.startsWith('INVALID_') ? 422 : 503);
      res.status(httpStatus).json({
        error: code,
        message,
        jobId: trackedJobId,
        failClosed: true,
        requestId: req.requestId,
      });
    }
  }
);

/**
 * Middleware อนุญาตให้ `/scanners/ingest` รับข้อมูลได้ทั้งจาก:
 * 1) `X-Scanner-Token` ที่ตรวจสอบด้วย Timing-Safe (`verifyScannerIngestToken`) สำหรับ `ScannerReader.exe`
 * 2) ผู้ใช้งานที่ล็อกอินด้วยสิทธิ์ `ADMIN` หรือ `RESPONSIBLE_STAFF`
 */
async function requireScannerTokenOrStaffAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const scannerTokenHeader = String(req.headers['x-scanner-token'] || '').trim();
  if (scannerTokenHeader) {
    const cfg = loadConfig();
    if (!verifyScannerIngestToken(scannerTokenHeader, cfg.scanner.ingestSharedToken)) {
      res.status(401).json({
        error: 'INVALID_SCANNER_TOKEN',
        message: 'รหัสโทเค็นของเครื่องสแกน (X-Scanner-Token) ไม่ถูกต้อง',
        requestId: req.requestId,
      });
      return;
    }
    req.user = {
      id: 0,
      username: 'scanner_exe_agent',
      displayName: 'ScannerReader.exe Agent',
      role: 'ADMIN',
      approvedPersonId: null,
      jti: 'scanner-token-auth',
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    next();
    return;
  }

  await requireAuth(req, res, async () => {
    await requireRoles('ADMIN', 'RESPONSIBLE_STAFF')(req, res, next);
  });
}

scannersRouter.post(
  '/scanners/ingest',
  requireScannerTokenOrStaffAuth,
  async (req, res) => {
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
        conditions.push("COALESCE(rsm.mapping_state, 'UNMATCHED') = ?");
        params.push(mappingState);
      }
      if (search) {
        conditions.push('(rs.enroll_number LIKE ? OR rsm.matched_person_id LIKE ? OR p.full_name LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      const items = await dbQuery(
        `SELECT rs.id, rs.event_dedup_key, rs.machine_no, rs.enroll_number,
                rs.scan_date_time, rs.canonical_bkk_time, rs.verify_mode,
                rs.in_out_mode, rs.work_code, rs.raw_payload_json, rs.sync_run_id, rs.imported_at,
                rsm.matched_person_id,
                COALESCE(rsm.mapping_state, 'UNMATCHED') AS mapping_state,
                p.full_name, p.department_name
         FROM raw_scans rs
         LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         LEFT JOIN personnel p ON p.person_id = rsm.matched_person_id
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
        `SELECT rs.id, rs.machine_no, rs.enroll_number, rs.scan_date_time, rs.canonical_bkk_time,
                rs.verify_mode, rs.in_out_mode, rs.work_code,
                COALESCE(rsm.mapping_state, 'MATCHED') AS mapping_state,
                rs.imported_at
         FROM raw_scans rs
         INNER JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         WHERE rsm.matched_person_id = ?
         ORDER BY rs.canonical_bkk_time DESC`,
        [personId]
      );
      res.json({ personId, items });
    } catch (err) {
      next(err);
    }
  }
);
