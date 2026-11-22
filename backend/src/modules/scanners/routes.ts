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
import { addDaysYmd } from '../attendance/matchingEngine.ts';
import { writeAuditLog } from '../audit/service.ts';
import { evaluateDueSyncSchedules, getScannerSchedulerStatus } from './scheduler.ts';
import {
  startCentralJob,
  updateCentralJobStep,
  completeCentralJob,
  failCentralJob,
  getLatestJobByType,
  type CentralJobStage,
} from '../jobs/tracker.ts';
import {
  validateAndNormalizeScannerSyncRange,
  isCanonicalBkkTimeInRange,
  assertRoleAuthorizedForDateRange,
  getResponsibleStaffMonthWindow,
  ScannerSyncRangeError,
  type ScannerSyncRangeInput,
  type ResolvedScannerSyncRange,
} from './syncRange.ts';
import {
  buildScannerExeArgs,
  runScannerExeProcess,
  parseScannerExeJsonOutput,
  extractScannerContractPayload,
  sanitizeScannerErrorMessage,
  emitScannerSyncDiagnostic,
  hasScannerExeProcessRunnerForTests,
  ScannerExeError,
  type ScannerMachineStatusReport,
} from './exeRunner.ts';
import { verifyActorReauthentication } from '../auth/reauth.ts';

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

function isDuplicateKeyError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code || '');
  const msg = err instanceof Error ? err.message : String(err || '');
  return (
    code === 'ER_DUP_ENTRY' ||
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    /UNIQUE constraint failed|Duplicate entry/i.test(msg)
  );
}

/**
 * บันทึกชุดข้อมูลสแกน 6 ฟิลด์ลงตาราง `raw_scans` แบบ Append-Only และ Atomic Deduplication
 * - ใช้ INSERT IGNORE ระดับฐานข้อมูล + จับ Duplicate Error เพื่อให้ปลอดภัยภายใต้ Concurrency
 * - ติดตามวันที่ที่เกี่ยวข้องทั้งรายการใหม่และรายการที่มีอยู่แล้ว เพื่อให้การจับคู่บุคลากรและการ Reprocess
 *   ทำงานได้ครบถ้วนแม้เป็นการดึงซ้ำหลังเพิ่ม mapping บุคลากรแล้ว
 * - รองรับสถานะ PARTIAL_SUCCESS เมื่อบางเครื่องหรือบางรายการไม่สำเร็จโดยไม่ทำข้อมูลเครื่องที่สำเร็จหาย
 */
export async function ingestSixFieldEventsBatch(
  rawEvents: unknown[],
  triggerMode: string,
  triggeredBy: string,
  machineNoFilter?: number | null,
  options?: {
    rangeFilter?: ResolvedScannerSyncRange | null;
    allowPartialInvalidEvents?: boolean;
    machineResults?: ScannerMachineStatusReport[];
    partialFailure?: boolean;
    warningMessage?: string | null;
    onProgress?: (
      step: string,
      processed?: number,
      total?: number,
      stage?: CentralJobStage
    ) => void;
  }
): Promise<{
  syncRunId: number;
  status: 'SUCCESS' | 'PARTIAL_SUCCESS';
  totalRead: number;
  totalReadFromDevice: number;
  matchedInRange: number;
  filteredOutCount: number;
  newInserted: number;
  duplicatesSkipped: number;
  failedCount: number;
  failedSamples: string[];
  matchedScansCount: number;
  unmatchedCount: number;
  conflictScansCount: number;
  attendanceCreatedCount: number;
  attendanceUpdatedCount: number;
  affectedDates: string[];
  syncMode: string;
  canonicalImportType: string;
  yearMonth: string | null;
  filterFromBkk: string | null;
  filterToBkk: string | null;
  filterStrategy: string | null;
  filterModeNotice: string | null;
  exeLimitationWarning: string | null;
  exeDaysArgUsed: number | null;
  machineResults: ScannerMachineStatusReport[];
  warningMessage: string | null;
}> {
  const rangeFilter = options?.rangeFilter ?? null;
  const allowPartialInvalid = Boolean(options?.allowPartialInvalidEvents);
  const totalReadFromDevice = rawEvents.length;
  const machineResults = Array.isArray(options?.machineResults) ? options.machineResults : [];

  options?.onProgress?.(
    rangeFilter?.filterFromBkk && rangeFilter?.filterToBkk
      ? `กำลังตรวจสอบและคัดกรองช่วงเวลา ${rangeFilter.filterFromBkk} ถึง ${rangeFilter.filterToBkk} (อ่านพบ ${totalReadFromDevice} รายการ)...`
      : `กำลังตรวจสอบโครงสร้างข้อมูลสแกน 6 ฟิลด์ (${totalReadFromDevice} รายการ)...`,
    0,
    totalReadFromDevice,
    'DEDUPLICATING'
  );

  const inRangeEvents: Array<{
    event: SixFieldScannerEvent;
    dedupKey: string;
    canonicalBkkTime: string;
  }> = [];
  let filteredOutCount = 0;
  let failedCount = 0;
  const failedSamples: string[] = [];

  for (const item of rawEvents) {
    try {
      const ev = validateSixFieldEvent(item);
      const { dedupKey, canonicalBkkTime } = computeRawScanDedupKey(ev);
      if (
        rangeFilter &&
        !isCanonicalBkkTimeInRange(
          canonicalBkkTime,
          rangeFilter.filterFromBkk,
          rangeFilter.filterToBkk
        )
      ) {
        filteredOutCount++;
        continue;
      }
      inRangeEvents.push({ event: ev, dedupKey, canonicalBkkTime });
    } catch (evErr: unknown) {
      if (!allowPartialInvalid) {
        throw evErr;
      }
      failedCount++;
      if (failedSamples.length < 5) {
        failedSamples.push(evErr instanceof Error ? evErr.message : String(evErr));
      }
    }
  }

  const matchedInRange = inRangeEvents.length;
  const syncScopeMode = rangeFilter?.syncMode || 'ALL';
  const canonicalImportType = rangeFilter?.canonicalImportType || 'FULL_HISTORICAL';
  const importYearMonth = rangeFilter?.yearMonth ?? null;
  const filterFromBkk = rangeFilter?.filterFromBkk ?? null;
  const filterToBkk = rangeFilter?.filterToBkk ?? null;
  const filterStrategy = rangeFilter?.filterStrategy ?? null;

  const runRes = await dbExecute(
    `INSERT INTO sync_runs (
      trigger_mode, machine_no, status,
      sync_scope_mode, import_year_month, filter_from_bkk, filter_to_bkk, filter_strategy,
      total_events_read, matched_in_range_count, filtered_out_count, failed_events_count,
      machine_results_json, triggered_by
    ) VALUES (?, ?, 'RUNNING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      triggerMode,
      machineNoFilter ?? null,
      syncScopeMode,
      importYearMonth,
      filterFromBkk,
      filterToBkk,
      filterStrategy,
      totalReadFromDevice,
      matchedInRange,
      filteredOutCount,
      failedCount,
      machineResults.length > 0 ? JSON.stringify(machineResults) : null,
      triggeredBy,
    ]
  );
  const syncRunId = runRes.insertId || 1;

  options?.onProgress?.(
    `กำลังตรวจสอบรายการซ้ำและบันทึกสแกนใหม่ (ตรงช่วงเวลา ${matchedInRange} จาก ${totalReadFromDevice} รายการ)...`,
    0,
    Math.max(1, matchedInRange),
    'DEDUPLICATING'
  );

  let newInserted = 0;
  let duplicatesSkipped = 0;
  const affectedDateSet = new Set<string>();

  for (let i = 0; i < inRangeEvents.length; i++) {
    const { event, dedupKey, canonicalBkkTime } = inRangeEvents[i];
    const scanDate = canonicalBkkTime.slice(0, 10);
    if (scanDate) {
      // รวมวันที่ของทุกรายการในช่วง (แม้จะเป็น duplicate) เพื่อให้ mapping & attendance recovery ทำงานครบ
      affectedDateSet.add(scanDate);
    }

    const payloadJson = JSON.stringify(event);
    try {
      const insertRes = await dbExecute(
        `INSERT IGNORE INTO raw_scans (
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

      if (Number(insertRes.affectedRows || 0) === 0) {
        duplicatesSkipped++;
      } else {
        if (insertRes.insertId) {
          await dbExecute(
            `INSERT IGNORE INTO raw_scan_mappings (
              raw_scan_id, event_dedup_key, enroll_number, matched_person_id, mapping_state, mapping_rule_note
            ) VALUES (?, ?, ?, NULL, 'UNMATCHED', 'PENDING_INITIAL_RESOLUTION')`,
            [insertRes.insertId, dedupKey, event.enrollNumber]
          );
        }
        newInserted++;
      }
    } catch (insErr: unknown) {
      if (isDuplicateKeyError(insErr)) {
        duplicatesSkipped++;
      } else {
        throw insErr;
      }
    }

    if (matchedInRange > 0 && ((i + 1) % 100 === 0 || i + 1 === matchedInRange)) {
      options?.onProgress?.(
        `ตรวจสอบรายการซ้ำและบันทึกสแกนดิบแล้ว ${i + 1}/${matchedInRange} รายการ (ใหม่ ${newInserted}, ซ้ำ ${duplicatesSkipped})...`,
        i + 1,
        matchedInRange,
        'DEDUPLICATING'
      );
    }
  }

  const sortedDates = Array.from(affectedDateSet).sort();
  let matchedScansCount = 0;
  let unmatchedCount = 0;
  let conflictScansCount = 0;
  let attendanceCreatedCount = 0;
  let attendanceUpdatedCount = 0;

  if (sortedDates.length > 0) {
    const minDate = sortedDates[0];
    const maxDate = sortedDates[sortedDates.length - 1];
    // Expand by -1 day so post-midnight OUT scans update previous day's cross-midnight shift (ATT-01)
    const reprocessFrom = addDaysYmd(minDate, -1);

    options?.onProgress?.(
      `กำลังจับคู่รหัสลายนิ้วมือกับทะเบียนบุคลากร (${minDate} ถึง ${maxDate})...`,
      Math.max(1, matchedInRange - 1),
      Math.max(1, matchedInRange),
      'MAPPING'
    );

    const mapStats = await resolveRawScanPersonnelMappings(reprocessFrom, maxDate);
    matchedScansCount = mapStats.matchedCount;
    unmatchedCount = mapStats.unmatchedCount;
    conflictScansCount = mapStats.conflictCount;

    options?.onProgress?.(
      `กำลังคำนวณและจับคู่เวลาเข้า-ออกงานกับตารางเวร (${minDate} ถึง ${maxDate})...`,
      Math.max(1, matchedInRange - 1),
      Math.max(1, matchedInRange),
      'PROCESSING_ATTENDANCE'
    );

    const reprocessRes = await reprocessAttendanceRange({
      dateFrom: reprocessFrom,
      dateTo: maxDate,
      actorUsername: triggeredBy,
    });
    attendanceCreatedCount = reprocessRes.insertedCount;
    attendanceUpdatedCount = reprocessRes.updatedCount;
  }

  const finalStatus: 'SUCCESS' | 'PARTIAL_SUCCESS' =
    Boolean(options?.partialFailure) || (failedCount > 0 && matchedInRange > 0)
      ? 'PARTIAL_SUCCESS'
      : 'SUCCESS';

  const warningMessage =
    options?.warningMessage ||
    (failedCount > 0 && matchedInRange > 0
      ? `พบข้อมูลสแกนที่ไม่ตรงตามรูปแบบสัญญา EXE จำนวน ${failedCount} รายการ ระบบได้ข้ามรายการที่ผิดรูปแบบและบันทึกรายการที่ถูกต้องครบถ้วนแล้ว`
      : null);

  await dbExecute(
    `UPDATE sync_runs
     SET finished_at = CURRENT_TIMESTAMP, status = ?,
         matched_in_range_count = ?, filtered_out_count = ?, failed_events_count = ?,
         new_scans_inserted = ?, duplicate_scans_skipped = ?,
         matched_scans_count = ?, unmatched_scans_count = ?, conflict_scans_count = ?,
         attendance_created_count = ?, attendance_updated_count = ?,
         machine_results_json = ?, error_message = ?
     WHERE id = ?`,
    [
      finalStatus,
      matchedInRange,
      filteredOutCount,
      failedCount,
      newInserted,
      duplicatesSkipped,
      matchedScansCount,
      unmatchedCount,
      conflictScansCount,
      attendanceCreatedCount,
      attendanceUpdatedCount,
      machineResults.length > 0 ? JSON.stringify(machineResults) : null,
      warningMessage,
      syncRunId,
    ]
  );

  if (machineNoFilter) {
    await dbExecute(
      `UPDATE scanner_devices
       SET last_sync_at = CURRENT_TIMESTAMP, last_success_at = CURRENT_TIMESTAMP,
           last_sync_status = ?, last_error_message = ?
       WHERE machine_no = ?`,
      [finalStatus === 'PARTIAL_SUCCESS' ? 'PARTIAL_SUCCESS' : 'SUCCESS', warningMessage, machineNoFilter]
    );
  }

  return {
    syncRunId,
    status: finalStatus,
    totalRead: totalReadFromDevice,
    totalReadFromDevice,
    matchedInRange,
    filteredOutCount,
    newInserted,
    duplicatesSkipped,
    failedCount,
    failedSamples,
    matchedScansCount,
    unmatchedCount,
    conflictScansCount,
    attendanceCreatedCount,
    attendanceUpdatedCount,
    affectedDates: sortedDates,
    syncMode: syncScopeMode,
    canonicalImportType,
    yearMonth: importYearMonth,
    filterFromBkk,
    filterToBkk,
    filterStrategy,
    filterModeNotice: rangeFilter?.filterModeNotice ?? null,
    exeLimitationWarning: rangeFilter?.exeLimitationWarning ?? null,
    exeDaysArgUsed: rangeFilter?.exeDaysArg ?? null,
    machineResults,
    warningMessage,
  };
}

/**
 * ฟังก์ชันกลางสำหรับสั่งรัน `ScannerReader.exe` / `ScannerSyncCli.exe` (ใช้ร่วมกันทั้งการกด Manual Sync และ Automatic Scheduler)
 * - ไม่แก้ไขตัวไฟล์ EXE เดิม
 * - มีการตรวจสอบช่วงวันที่/เวลา (Asia/Bangkok) และคัดกรองบน Backend ก่อนบันทึก Raw Scans
 * - มีการล็อกป้องกันการทำงานซ้อนกัน (Concurrency Mutex) และรองรับการตรวจจับ Timeout / เครื่องสแกนไม่ตอบสนอง
 */
export async function executeScannerReaderSync(options: {
  triggerMode: string;
  actorUsername: string;
  actorRole: string;
  machineNo?: number | null;
  requestId?: string;
  jobId?: string | null;
  ipAddress?: string;
  rangeInput?: ScannerSyncRangeInput;
  referenceDate?: Date;
  onProgress?: (
    step: string,
    processed?: number,
    total?: number,
    stage?: CentralJobStage
  ) => void;
}) {
  const cfg = loadConfig();
  const isScannerSyncCli = /ScannerSyncCli\.exe$/i.test(cfg.scanner.readerExePath);
  const isScheduledSync = options.triggerMode.toUpperCase().includes('SCHEDULED');

  // ตรวจสอบความถูกต้องของช่วงวันที่และเวลาก่อนจอง Mutex และก่อนเรียก EXE (Fail-Fast 400)
  const resolvedRange = validateAndNormalizeScannerSyncRange(options.rangeInput, {
    maxRangeDays: cfg.scanner.maxRangeDays,
    defaultExeSyncDays: cfg.scanner.syncDays,
    isScannerSyncCli,
    isScheduledSync,
    referenceDate: options.referenceDate,
  });

  if (scannerSyncMutexLocked) {
    const conflictErr = new ScannerExeError(
      'SYNC_ALREADY_RUNNING',
      'SYNC_ALREADY_RUNNING: ระบบกำลังดึงข้อมูลจากเครื่องสแกนอยู่ในขณะนี้ กรุณารอให้รอบปัจจุบันเสร็จสิ้นก่อน',
      409
    );
    throw conflictErr;
  }

  scannerSyncMutexLocked = true;
  const machineNo = options.machineNo ?? null;
  const syncStartedAt = Date.now();
  let lastExitCode: number | null = null;
  let lastSignal: string | null = null;
  let lastStdoutBytes = 0;
  let lastStderrBytes = 0;

  try {
    let stdoutText: string;

    options.onProgress?.(
      machineNo
        ? `กำลังเชื่อมต่อเครื่องสแกนหมายเลข #${machineNo} และอ่านข้อมูลสแกน...`
        : 'กำลังเชื่อมต่อโปรแกรมอ่านเครื่องสแกนและดึงข้อมูลจากเครื่องที่เปิดใช้งาน...',
      undefined,
      undefined,
      'READING_SCANNER'
    );

    if (testDoubleScannerOutput !== null) {
      if (testDoubleScannerOutput instanceof Error) {
        throw testDoubleScannerOutput;
      }
      stdoutText = testDoubleScannerOutput;
      lastExitCode = 0;
      lastStdoutBytes = Buffer.byteLength(stdoutText, 'utf8');
      if (lastStdoutBytes > cfg.scanner.maxBufferBytes) {
        const limitMb = (cfg.scanner.maxBufferBytes / (1024 * 1024)).toFixed(1);
        throw new ScannerExeError(
          'SCANNER_OUTPUT_TOO_LARGE',
          `SCANNER_OUTPUT_TOO_LARGE: ข้อมูลจากโปรแกรมดึงสแกนมีขนาดเกินขีดจำกัด Buffer ที่ปลอดภัย (${limitMb} MB) กรุณาลดช่วงวันที่ที่เลือกหรือปรับค่า SCANNER_READER_MAX_BUFFER_BYTES`,
          413,
          {
            exitCode: 0,
            signal: null,
            stdoutBytes: lastStdoutBytes,
            stderrBytes: 0,
            durationMs: Date.now() - syncStartedAt,
          }
        );
      }
    } else {
      if (!cfg.scanner.syncEnabled && !hasScannerExeProcessRunnerForTests()) {
        throw new ScannerExeError(
          'BLOCKED_BY_EXTERNAL_CONTRACT',
          'BLOCKED_BY_EXTERNAL_CONTRACT: ปิดการเรียก ScannerReader.exe อัตโนมัติไว้ (SCANNER_SYNC_ENABLED=false) กรุณาตั้งค่า Path ของไฟล์ EXE เดิมบนเครื่อง Windows Server ก่อนเปิดใช้งานจริง',
          503
        );
      }

      const args = buildScannerExeArgs({
        isScannerSyncCli,
        exeDaysArg: resolvedRange.exeDaysArg,
        previewMode: cfg.scanner.previewMode,
        machineNo,
      });

      const exeWorkingDir = cfg.scanner.readerExePath.replace(/[\\/][^\\/]+$/, '') || process.cwd();
      const execResult = await runScannerExeProcess({
        exePath: cfg.scanner.readerExePath,
        args,
        cwd: exeWorkingDir,
        timeoutMs: cfg.scanner.timeoutMs,
        maxBufferBytes: cfg.scanner.maxBufferBytes,
        mysqlConnectionString: cfg.scanner.mysqlConnectionString,
      });

      stdoutText = execResult.stdout;
      lastExitCode = execResult.exitCode;
      lastSignal = execResult.signal;
      lastStdoutBytes = execResult.stdoutBytes;
      lastStderrBytes = execResult.stderrBytes;
    }

    const parsed = parseScannerExeJsonOutput(stdoutText, { exitCode: lastExitCode });
    const contractPayload = extractScannerContractPayload(parsed);

    if (contractPayload.machines.length > 0) {
      for (const m of contractPayload.machines) {
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
              machineOk
                ? null
                : sanitizeScannerErrorMessage(`สถานะจาก ScannerSyncCli: ${m.status || 'FAILED'}`),
              m.machineNo,
            ]
          );
        }
      }
    }

    if (!contractPayload.ok) {
      const errMsg = contractPayload.errorMessage;
      if (errMsg.includes('Another sync process')) {
        throw new ScannerExeError('SYNC_ALREADY_RUNNING', `SYNC_ALREADY_RUNNING: ${errMsg}`, 409);
      }
      throw new ScannerExeError(
        'SCANNER_DEVICE_UNREACHABLE',
        `SCANNER_DEVICE_UNREACHABLE: ${errMsg}`,
        503
      );
    }

    const result = await ingestSixFieldEventsBatch(
      contractPayload.events,
      options.triggerMode,
      options.actorUsername,
      machineNo,
      {
        rangeFilter: resolvedRange,
        allowPartialInvalidEvents: true,
        machineResults: contractPayload.machines,
        partialFailure: contractPayload.partialFailure,
        warningMessage: contractPayload.warningMessage,
        onProgress: options.onProgress,
      }
    );

    emitScannerSyncDiagnostic({
      event: 'SCANNER_SYNC_DIAGNOSTIC',
      requestId: options.requestId || 'scanner-sync',
      jobId: options.jobId ?? null,
      syncMode: resolvedRange.syncMode,
      exeDaysArgUsed: resolvedRange.exeDaysArg,
      requestedDateRange: {
        fromBkk: resolvedRange.filterFromBkk,
        toBkk: resolvedRange.filterToBkk,
      },
      durationMs: Date.now() - syncStartedAt,
      exitCode: lastExitCode,
      signal: lastSignal,
      stdoutBytes: lastStdoutBytes,
      stderrBytes: lastStderrBytes,
      bufferLimitBytes: cfg.scanner.maxBufferBytes,
      timeoutMs: cfg.scanner.timeoutMs,
      errorCode: result.status === 'PARTIAL_SUCCESS' ? 'PARTIAL_SUCCESS' : null,
    });

    await writeAuditLog({
      requestId: options.requestId || 'scanner-sync',
      actorUsername: options.actorUsername,
      actorRole: options.actorRole,
      ipAddress: options.ipAddress || '127.0.0.1',
      action:
        result.status === 'PARTIAL_SUCCESS'
          ? 'SCANNER_SYNC_PARTIAL_SUCCESS'
          : 'SCANNER_SYNC_SUCCESS',
      targetType: 'SCANNER',
      targetId: machineNo ? String(machineNo) : 'ALL',
      result: result.status,
      detail: result,
    });

    return result;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code || 'SCANNER_SYNC_FAILED';
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = sanitizeScannerErrorMessage(rawMessage);
    const meta = err instanceof ScannerExeError ? err.meta : undefined;

    emitScannerSyncDiagnostic({
      event: 'SCANNER_SYNC_DIAGNOSTIC',
      requestId: options.requestId || 'scanner-sync',
      jobId: options.jobId ?? null,
      syncMode: resolvedRange.syncMode,
      exeDaysArgUsed: resolvedRange.exeDaysArg,
      requestedDateRange: {
        fromBkk: resolvedRange.filterFromBkk,
        toBkk: resolvedRange.filterToBkk,
      },
      durationMs: meta?.durationMs ?? Date.now() - syncStartedAt,
      exitCode: meta?.exitCode ?? lastExitCode,
      signal: meta?.signal ?? lastSignal,
      stdoutBytes: meta?.stdoutBytes ?? lastStdoutBytes,
      stderrBytes: meta?.stderrBytes ?? lastStderrBytes,
      bufferLimitBytes: cfg.scanner.maxBufferBytes,
      timeoutMs: cfg.scanner.timeoutMs,
      errorCode: code,
    });

    await dbExecute(
      `INSERT INTO sync_runs (
        trigger_mode, machine_no, finished_at, status,
        sync_scope_mode, filter_from_bkk, filter_to_bkk, filter_strategy,
        total_events_read, matched_in_range_count, filtered_out_count,
        new_scans_inserted, duplicate_scans_skipped, failed_events_count, unmatched_scans_count,
        error_code, error_message, triggered_by
      ) VALUES (?, ?, CURRENT_TIMESTAMP, 'FAILED', ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
      [
        options.triggerMode,
        machineNo,
        resolvedRange.syncMode,
        resolvedRange.filterFromBkk,
        resolvedRange.filterToBkk,
        resolvedRange.filterStrategy,
        code,
        message,
        options.actorUsername,
      ]
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
      detail: {
        message,
        syncMode: resolvedRange.syncMode,
        exeDaysArgUsed: resolvedRange.exeDaysArg,
        filterFromBkk: resolvedRange.filterFromBkk,
        filterToBkk: resolvedRange.filterToBkk,
        stdoutBytes: meta?.stdoutBytes ?? lastStdoutBytes,
        stderrBytes: meta?.stderrBytes ?? lastStderrBytes,
        bufferLimitBytes: cfg.scanner.maxBufferBytes,
      },
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
  async (req, res, next) => {
    try {
      const devices = await dbQuery('SELECT * FROM scanner_devices ORDER BY machine_no ASC');
      const schedules = await dbQuery('SELECT * FROM sync_schedules ORDER BY cron_time ASC');
      const syncRuns = await dbQuery('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 25');
      const cfg = loadConfig();
      const isScannerSyncCli = /ScannerSyncCli\.exe$/i.test(cfg.scanner.readerExePath);
      const staffWindow = getResponsibleStaffMonthWindow();
      const isAdmin = req.user!.role === 'ADMIN';

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
        roleSyncPolicy: {
          role: req.user!.role,
          timezone: 'Asia/Bangkok',
          serverTodayBkkYmd: staffWindow.serverTodayBkkYmd,
          currentYearMonth: staffWindow.currentYearMonth,
          previousYearMonth: staffWindow.previousYearMonth,
          earliestAllowedYmd: isAdmin ? null : staffWindow.earliestAllowedYmd,
          allowedYearMonths: isAdmin ? null : staffWindow.allowedYearMonths,
          canFullHistoricalImport: isAdmin,
          canAnyPastMonthImport: isAdmin,
          requiresPasswordConfirmationFor: ['MONTHLY', 'FULL_HISTORICAL', 'ALL'],
        },
        syncRangeCapabilities: {
          timezone: 'Asia/Bangkok',
          maxRangeDays: cfg.scanner.maxRangeDays,
          defaultScheduledSyncDays: cfg.scanner.syncDays,
          maxBufferBytes: cfg.scanner.maxBufferBytes,
          timeoutMs: cfg.scanner.timeoutMs,
          supportsTodayMode: true,
          supportsCustomRangeMode: true,
          supportsMonthlyMode: true,
          supportsFullHistoricalMode: true,
          supportsAllMode: true,
          exeSupportsNativeDateTimeRange: false,
          filterStrategy: 'BACKEND_POST_READ_FILTER',
          exeBinaryName: isScannerSyncCli ? 'ScannerSyncCli.exe' : 'ScannerReader.exe',
          explanationTh: isScannerSyncCli
            ? `โปรแกรม ScannerSyncCli.exe เดิมรองรับเฉพาะพารามิเตอร์จำนวนวันย้อนหลัง (--days สูงสุด 365 วัน) และไม่ได้รับช่วงเวลาตรงจากตัวเครื่อง ระบบจึงอ่านข้อมูลย้อนหลังให้ครอบคลุมแล้วคัดกรองเฉพาะรายการสแกนที่มีเวลา (scanDateTime เขตเวลา Asia/Bangkok) อยู่ในช่วงวันที่และเวลาหรือเดือนที่เลือกบน Backend ก่อนบันทึกลงฐานข้อมูล พร้อมป้องกันข้อมูลซ้ำระดับฐานข้อมูล`
            : `ระบบอ่านข้อมูลจากโปรแกรมเครื่องสแกนเดิม แล้วคัดกรองเฉพาะรายการสแกนที่มีเวลา (scanDateTime เขตเวลา Asia/Bangkok) อยู่ในช่วงวันที่และเวลาหรือเดือนที่เลือกบน Backend ก่อนบันทึกลงฐานข้อมูล พร้อมป้องกันข้อมูลซ้ำระดับฐานข้อมูล`,
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
 * Triggers Scanner Reader EXE Sync (Manual Sync) with optional Date/Time Range filtering (Asia/Bangkok).
 */
scannersRouter.post(
  '/scanners/sync',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res) => {
    const actor = req.user!.username;
    const rawMachineNo = req.body?.machineNo;
    const machineNo =
      rawMachineNo !== undefined && rawMachineNo !== null && String(rawMachineNo).trim() !== ''
        ? Number(rawMachineNo)
        : null;

    if (machineNo !== null && (!Number.isInteger(machineNo) || machineNo <= 0)) {
      res.status(400).json({
        error: 'INVALID_MACHINE_NO',
        message: 'หมายเลขเครื่องสแกน (machineNo) ต้องเป็นจำนวนเต็มบวก',
        requestId: req.requestId,
      });
      return;
    }

    const rangeInput: ScannerSyncRangeInput = {
      syncMode: req.body?.syncMode ?? undefined,
      yearMonth: req.body?.yearMonth ?? undefined,
      dateFrom: req.body?.dateFrom ?? undefined,
      timeFrom: req.body?.timeFrom ?? undefined,
      dateTo: req.body?.dateTo ?? undefined,
      timeTo: req.body?.timeTo ?? undefined,
    };

    // 1. ตรวจสอบช่วงวันที่และเวลาก่อนสร้าง Background Job เพื่อคืน HTTP 400 ทันทีหากไม่ถูกต้อง
    const cfg = loadConfig();
    const isScannerSyncCli = /ScannerSyncCli\.exe$/i.test(cfg.scanner.readerExePath);
    let previewRange: ResolvedScannerSyncRange;
    try {
      previewRange = validateAndNormalizeScannerSyncRange(rangeInput, {
        maxRangeDays: cfg.scanner.maxRangeDays,
        defaultExeSyncDays: cfg.scanner.syncDays,
        isScannerSyncCli,
      });
    } catch (rangeErr: unknown) {
      if (rangeErr instanceof ScannerSyncRangeError) {
        res.status(rangeErr.statusCode).json({
          error: rangeErr.code,
          message: rangeErr.message,
          requestId: req.requestId,
        });
        return;
      }
      res.status(400).json({
        error: 'INVALID_DATE_TIME_RANGE',
        message: rangeErr instanceof Error ? rangeErr.message : 'ช่วงวันที่และเวลาไม่ถูกต้อง',
        requestId: req.requestId,
      });
      return;
    }

    // 2. บังคับตรวจสิทธิ์ตาม Role และกรอบเดือนปฏิทินฝั่ง Server (Asia/Bangkok) ก่อนเรียก EXE เสมอ
    try {
      assertRoleAuthorizedForDateRange({
        role: req.user!.role,
        syncMode: previewRange.syncMode,
        yearMonth: previewRange.yearMonth,
        dateFrom: previewRange.dateFrom,
        dateTo: previewRange.dateTo,
      });
    } catch (authErr: unknown) {
      if (authErr instanceof ScannerSyncRangeError) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: actor,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'SCANNER_SYNC_FORBIDDEN_POLICY',
          targetType: 'SCANNER',
          targetId: machineNo ? String(machineNo) : 'ALL',
          result: 'DENIED',
          errorCode: authErr.code,
          detail: {
            syncMode: previewRange.syncMode,
            yearMonth: previewRange.yearMonth,
            dateFrom: previewRange.dateFrom,
            dateTo: previewRange.dateTo,
          },
        });
        res.status(authErr.statusCode).json({
          error: authErr.code,
          message: authErr.message,
          requestId: req.requestId,
        });
        return;
      }
      res.status(403).json({
        error: 'FORBIDDEN',
        message: 'ไม่มีสิทธิ์ดำเนินการดึงข้อมูลในช่วงนี้',
        requestId: req.requestId,
      });
      return;
    }

    // 3. บังคับยืนยันผลกระทบ + รหัสผ่านของผู้ดำเนินการปัจจุบันสำหรับ MONTHLY และ FULL_HISTORICAL / ALL
    if (
      previewRange.canonicalImportType === 'MONTHLY' ||
      previewRange.canonicalImportType === 'FULL_HISTORICAL'
    ) {
      const reauth = await verifyActorReauthentication({
        userId: req.user!.id,
        username: req.user!.username,
        role: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        requestId: req.requestId,
        operationName:
          previewRange.canonicalImportType === 'FULL_HISTORICAL'
            ? 'SCANNER_FULL_HISTORICAL_SYNC'
            : 'SCANNER_MONTHLY_SYNC',
        targetType: 'SCANNER',
        targetId: machineNo ? String(machineNo) : 'ALL',
        confirmPassword: req.body?.confirmPassword,
        impactAcknowledged: req.body?.impactAcknowledged,
      });

      if (!reauth.ok) {
        res.status(reauth.statusCode || 401).json({
          error: reauth.errorCode,
          message: reauth.message,
          lockedUntil: reauth.lockedUntil ?? undefined,
          requestId: req.requestId,
        });
        return;
      }
    }

    if (scannerSyncMutexLocked) {
      res.status(409).json({
        error: 'SYNC_ALREADY_RUNNING',
        message:
          'SYNC_ALREADY_RUNNING: ระบบกำลังดึงข้อมูลจากเครื่องสแกนอยู่ในขณะนี้ กรุณารอให้รอบปัจจุบันเสร็จสิ้นก่อน',
        failClosed: true,
        requestId: req.requestId,
      });
      return;
    }

    let trackedJobId: string | null = null;
    try {
      const rangeLabel =
        previewRange.yearMonth
          ? ` รายเดือน ${previewRange.yearMonth}`
          : previewRange.filterFromBkk && previewRange.filterToBkk
            ? ` ช่วง ${previewRange.filterFromBkk} ถึง ${previewRange.filterToBkk}`
            : ' (ดึงข้อมูลทั้งหมดที่เครื่องรองรับ)';
      const job = startCentralJob({
        jobType: 'SCANNER_MANUAL_SYNC',
        actorUsername: actor,
        stage: 'READING_SCANNER',
        initialStep: machineNo
          ? `กำลังเชื่อมต่อเครื่องสแกนหมายเลข #${machineNo}${rangeLabel}...`
          : `กำลังเชื่อมต่อเครื่องสแกนทุกเครื่องที่เปิดใช้งาน${rangeLabel}...`,
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
        jobId: trackedJobId,
        ipAddress: req.ip || '127.0.0.1',
        rangeInput,
        onProgress: (step, processed, total, stage) => {
          if (trackedJobId) {
            updateCentralJobStep(trackedJobId, {
              ...(stage ? { stage } : {}),
              currentStep: step,
              ...(typeof processed === 'number' ? { processedCount: processed } : {}),
              ...(typeof total === 'number' ? { totalCount: total } : {}),
            });
          }
        },
      });

      if (trackedJobId) {
        completeCentralJob(trackedJobId, {
          status: result.status === 'PARTIAL_SUCCESS' ? 'PARTIAL_SUCCESS' : 'SUCCESS',
          currentStep:
            result.status === 'PARTIAL_SUCCESS'
              ? 'ดึงข้อมูลเสร็จสิ้นบางส่วน (บางเครื่องหรือบางรายการไม่สำเร็จ กรุณาตรวจสอบรายละเอียด)'
              : 'ดึงข้อมูลจากเครื่องสแกนและคำนวณเวลาเสร็จสมบูรณ์',
          processedCount: Number(result.matchedInRange ?? result.totalRead ?? 0),
          totalCount: Number(result.totalReadFromDevice ?? result.totalRead ?? 0),
          resultSummary: result as unknown as Record<string, unknown>,
        });
      }

      res.json({
        jobId: trackedJobId,
        ...result,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || 'SCANNER_SYNC_FAILED';
      const statusCode = (err as { statusCode?: number })?.statusCode;
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = sanitizeScannerErrorMessage(rawMessage);

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
                p.full_name, p.department_name,
                u.usage_role,
                u.attendance_id AS used_attendance_id,
                u.work_date AS used_work_date,
                u.shift_code AS used_shift_code
         FROM raw_scans rs
         LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         LEFT JOIN personnel p ON p.person_id = rsm.matched_person_id
         LEFT JOIN attendance_raw_scan_usage u ON u.raw_scan_id = rs.id
         WHERE ${conditions.join(' AND ')}
         ORDER BY rs.canonical_bkk_time DESC, rs.id DESC
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
                rs.imported_at,
                u.usage_role,
                u.attendance_id AS used_attendance_id,
                u.work_date AS used_work_date,
                u.shift_code AS used_shift_code
         FROM raw_scans rs
         INNER JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         LEFT JOIN attendance_raw_scan_usage u ON u.raw_scan_id = rs.id
         WHERE rsm.matched_person_id = ?
         ORDER BY rs.canonical_bkk_time DESC, rs.id DESC`,
        [personId]
      );
      res.json({ personId, items });
    } catch (err) {
      next(err);
    }
  }
);
