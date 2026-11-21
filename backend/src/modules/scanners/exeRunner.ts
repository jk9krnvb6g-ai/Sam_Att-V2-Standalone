/**
 * ============================================================================
 * โมดูลควบคุมการรันโปรแกรมดึงข้อมูลเครื่องสแกน (ScannerSyncCli.exe / ScannerReader.exe)
 * ไฟล์: backend/src/modules/scanners/exeRunner.ts
 * ============================================================================
 * หน้าที่หลัก:
 * - สร้าง Arguments แบบ Array สำหรับ `execFile` โดยไม่ผ่าน Shell (ป้องกัน Command Injection)
 * - กำหนด `maxBuffer` และ `timeout` อย่างมีขอบเขตปลอดภัย (ป้องกัน Buffer Overflow 1MB ของ Node.js)
 * - แยกประเภท Process Error ชัดเจน (Buffer Overflow, Timeout, EXE Not Found, Device Unreachable, Invalid JSON)
 * - แปลง JSON ตาม Contract ของ EXE เดิมแบบ Fail-Closed (รองรับ UTF-8 BOM และบรรทัด Log นำหน้าเฉพาะที่ยืนยันได้,
 *   ปฏิเสธ JSON ที่ถูกตัดกลางทางหรือไม่สมบูรณ์เสมอ)
 * - บันทึก Diagnostic Metadata อย่างปลอดภัยโดยไม่เปิดเผยรหัสผ่าน, Connection String หรือ Raw Scan Payload
 */
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type ScannerExeErrorCode =
  | 'BLOCKED_BY_EXTERNAL_CONTRACT'
  | 'SCANNER_EXE_NOT_FOUND'
  | 'SCANNER_TIMEOUT'
  | 'SCANNER_OUTPUT_TOO_LARGE'
  | 'SCANNER_DEVICE_UNREACHABLE'
  | 'INVALID_EXE_JSON_OUTPUT'
  | 'INVALID_EXE_CONTRACT'
  | 'SYNC_ALREADY_RUNNING';

export class ScannerExeError extends Error {
  public readonly code: ScannerExeErrorCode;
  public readonly statusCode: number;
  public readonly meta?: {
    exitCode?: number | null;
    signal?: string | null;
    stdoutBytes?: number;
    stderrBytes?: number;
    durationMs?: number;
  };

  constructor(
    code: ScannerExeErrorCode,
    message: string,
    statusCode: number,
    meta?: {
      exitCode?: number | null;
      signal?: string | null;
      stdoutBytes?: number;
      stderrBytes?: number;
      durationMs?: number;
    }
  ) {
    super(message);
    this.name = 'ScannerExeError';
    this.code = code;
    this.statusCode = statusCode;
    this.meta = meta;
  }
}

export interface ScannerExeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  durationMs: number;
}

export interface ScannerExeRunParams {
  exePath: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxBufferBytes: number;
  mysqlConnectionString: string;
}

export type ScannerExeProcessRunner = (
  params: ScannerExeRunParams
) => Promise<{ stdout: string; stderr: string }>;

export interface ScannerSyncDiagnosticLog {
  event: 'SCANNER_SYNC_DIAGNOSTIC';
  requestId: string;
  jobId: string | null;
  syncMode: string;
  exeDaysArgUsed: number;
  requestedDateRange: {
    fromBkk: string | null;
    toBkk: string | null;
  };
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  bufferLimitBytes: number;
  timeoutMs: number;
  errorCode: string | null;
}

export interface ScannerMachineStatusReport {
  machineNo?: number;
  ip?: string;
  read?: number;
  new?: number;
  duplicates?: number;
  status?: string;
}

export interface ParsedScannerContractSuccess {
  ok: true;
  events: unknown[];
  machines: ScannerMachineStatusReport[];
}

export interface ParsedScannerContractFailure {
  ok: false;
  errorMessage: string;
  machines: ScannerMachineStatusReport[];
}

export type ParsedScannerContractResult =
  | ParsedScannerContractSuccess
  | ParsedScannerContractFailure;

// Test-only hooks (never active in production)
let testProcessRunner: ScannerExeProcessRunner | null = null;
let testDiagnosticLogger: ((entry: ScannerSyncDiagnosticLog) => void) | null = null;

export function setScannerExeProcessRunnerForTests(
  runner: ScannerExeProcessRunner | null
): void {
  testProcessRunner = runner;
}

export function hasScannerExeProcessRunnerForTests(): boolean {
  return testProcessRunner !== null;
}

export function setScannerDiagnosticLoggerForTests(
  logger: ((entry: ScannerSyncDiagnosticLog) => void) | null
): void {
  testDiagnosticLogger = logger;
}

/**
 * สร้าง Arguments แบบ Array สำหรับเรียก ScannerSyncCli.exe / ScannerReader.exe ผ่าน execFile
 * ห้ามใช้ shell string interpolation เด็ดขาด
 */
export function buildScannerExeArgs(options: {
  isScannerSyncCli: boolean;
  exeDaysArg: number;
  previewMode: boolean;
  machineNo?: number | null;
}): string[] {
  const args: string[] = [];
  if (options.isScannerSyncCli) {
    const safeDays = Math.max(1, Math.min(365, Math.floor(Number(options.exeDaysArg) || 1)));
    args.push('--days', String(safeDays));
    if (options.previewMode) {
      args.push('--preview');
    }
  }
  if (
    options.machineNo !== undefined &&
    options.machineNo !== null &&
    Number.isInteger(options.machineNo) &&
    options.machineNo > 0
  ) {
    args.push('--machine', String(options.machineNo));
  }
  return args;
}

/**
 * ล้างข้อมูลอ่อนไหว (รหัสผ่าน, Connection String, Token) ออกจากข้อความ Error ก่อนบันทึก Log หรือส่งกลับ Client
 */
export function sanitizeScannerErrorMessage(rawMessage: string): string {
  return String(rawMessage || '')
    .replace(/Password\s*=\s*[^;,\s]+/gi, 'Password=***')
    .replace(/Pwd\s*=\s*[^;,\s]+/gi, 'Pwd=***')
    .replace(/User\s*ID\s*=\s*[^;,\s]+/gi, 'User ID=***')
    .replace(/Uid\s*=\s*[^;,\s]+/gi, 'Uid=***')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer ***')
    .replace(/SCANNER_MYSQL_CONNECTION_STRING\s*=\s*\S+/gi, 'SCANNER_MYSQL_CONNECTION_STRING=***')
    .slice(0, 400);
}

/**
 * บันทึก Diagnostic Metadata อย่างปลอดภัย (ไม่มีข้อมูลลับหรือ Raw Scan Payload)
 */
export function emitScannerSyncDiagnostic(entry: ScannerSyncDiagnosticLog): void {
  if (testDiagnosticLogger) {
    testDiagnosticLogger(entry);
  }
  const serialized = JSON.stringify(entry);
  if (entry.errorCode) {
    console.error(`[ScannerSyncDiagnostic] ${serialized}`);
  } else {
    console.info(`[ScannerSyncDiagnostic] ${serialized}`);
  }
}

function isMaxBufferError(err: any): boolean {
  if (!err) return false;
  if (String(err.code || '') === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return true;
  }
  const msg = String(err.message || '');
  if (/maxBuffer\s+length\s+exceeded/i.test(msg) || /stdout\s+maxBuffer/i.test(msg) || /stderr\s+maxBuffer/i.test(msg)) {
    return true;
  }
  return false;
}

function isTimeoutError(err: any): boolean {
  if (!err) return false;
  if (String(err.code || '') === 'ETIMEDOUT') return true;
  if (err.killed === true) return true;
  if (err.signal === 'SIGTERM' || err.signal === 'SIGKILL') return true;
  return false;
}

function isExeNotFoundError(err: any): boolean {
  if (!err) return false;
  return String(err.code || '') === 'ENOENT';
}

function normalizeExitCode(rawCode: unknown): number | null {
  return typeof rawCode === 'number' && Number.isInteger(rawCode) ? rawCode : null;
}

/**
 * รันโปรแกรมอ่านเครื่องสแกนด้วย execFile พร้อมจำกัด Buffer และ Timeout อย่างปลอดภัย
 * และแยกประเภท Process Error อย่างแม่นยำก่อนส่งต่อไปยัง JSON Parser
 */
export async function runScannerExeProcess(
  params: ScannerExeRunParams
): Promise<ScannerExeExecResult> {
  const startedAt = Date.now();

  if (!testProcessRunner && !fs.existsSync(params.exePath)) {
    throw new ScannerExeError(
      'SCANNER_EXE_NOT_FOUND',
      'SCANNER_EXE_NOT_FOUND: ไม่พบไฟล์โปรแกรมดึงข้อมูลสแกนลายนิ้วมือตามเส้นทางที่ตั้งค่าไว้',
      503,
      { exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, durationMs: 0 }
    );
  }

  try {
    const output = testProcessRunner
      ? await testProcessRunner(params)
      : await execFileAsync(params.exePath, params.args, {
          cwd: params.cwd,
          timeout: params.timeoutMs,
          maxBuffer: params.maxBufferBytes,
          killSignal: 'SIGTERM',
          windowsHide: true,
          encoding: 'utf8',
          env: {
            ...process.env,
            SCANNER_MYSQL_CONNECTION_STRING: params.mysqlConnectionString,
          },
        });

    const stdout = typeof output.stdout === 'string' ? output.stdout : String(output.stdout || '');
    const stderr = typeof output.stderr === 'string' ? output.stderr : String(output.stderr || '');
    const stdoutBytes = Buffer.byteLength(stdout, 'utf8');
    const stderrBytes = Buffer.byteLength(stderr, 'utf8');
    const durationMs = Date.now() - startedAt;

    if (stdoutBytes > params.maxBufferBytes) {
      const limitMb = (params.maxBufferBytes / (1024 * 1024)).toFixed(1);
      throw new ScannerExeError(
        'SCANNER_OUTPUT_TOO_LARGE',
        `SCANNER_OUTPUT_TOO_LARGE: ข้อมูลจากโปรแกรมดึงสแกนมีขนาดเกินขีดจำกัด Buffer ที่ปลอดภัย (${limitMb} MB) กรุณาลดช่วงวันที่ที่เลือกหรือปรับค่า SCANNER_READER_MAX_BUFFER_BYTES`,
        413,
        { exitCode: 0, signal: null, stdoutBytes, stderrBytes, durationMs }
      );
    }

    return {
      stdout,
      stderr,
      exitCode: 0,
      signal: null,
      stdoutBytes,
      stderrBytes,
      durationMs,
    };
  } catch (execErr: any) {
    if (execErr instanceof ScannerExeError) {
      throw execErr;
    }

    const durationMs = Date.now() - startedAt;
    const rawStdout = typeof execErr?.stdout === 'string' ? execErr.stdout : '';
    const rawStderr = typeof execErr?.stderr === 'string' ? execErr.stderr : '';
    const stdoutBytes = Buffer.byteLength(rawStdout, 'utf8');
    const stderrBytes = Buffer.byteLength(rawStderr, 'utf8');
    const exitCode = normalizeExitCode(execErr?.code);
    const signal = typeof execErr?.signal === 'string' ? execErr.signal : null;
    const meta = { exitCode, signal, stdoutBytes, stderrBytes, durationMs };

    // 1. ตรวจสอบ Buffer Overflow ก่อนเสมอ เพื่อไม่ให้นำ stdout ที่ถูกตัดไป Parse เป็น JSON หรือสับสนกับ Timeout
    if (isMaxBufferError(execErr)) {
      const limitMb = (params.maxBufferBytes / (1024 * 1024)).toFixed(1);
      throw new ScannerExeError(
        'SCANNER_OUTPUT_TOO_LARGE',
        `SCANNER_OUTPUT_TOO_LARGE: ข้อมูลจากโปรแกรมดึงสแกนมีขนาดเกินขีดจำกัด Buffer ที่ปลอดภัย (${limitMb} MB) กรุณาลดช่วงวันที่ที่เลือกหรือแบ่งการดึงข้อมูลเป็นช่วงย่อย`,
        413,
        meta
      );
    }

    // 2. ตรวจสอบกรณีไม่พบไฟล์ EXE
    if (isExeNotFoundError(execErr)) {
      throw new ScannerExeError(
        'SCANNER_EXE_NOT_FOUND',
        'SCANNER_EXE_NOT_FOUND: ไม่พบไฟล์โปรแกรมดึงข้อมูลสแกนลายนิ้วมือตามเส้นทางที่ตั้งค่าไว้',
        503,
        meta
      );
    }

    // 3. ตรวจสอบ Timeout (หลังตรวจสอบ maxBuffer แล้ว)
    if (isTimeoutError(execErr)) {
      throw new ScannerExeError(
        'SCANNER_TIMEOUT',
        `SCANNER_TIMEOUT: เครื่องสแกนนิ้วหรือโปรแกรมดึงสแกนไม่ตอบสนองภายในเวลาที่กำหนด (${params.timeoutMs} ms)`,
        503,
        meta
      );
    }

    // 4. กรณี Non-zero Exit Code:
    //    ตาม Contract ของ ScannerSyncCli.exe เดิม:
    //    - exitCode = 1 (อ่านสำเร็จบางเครื่อง) หรือ exitCode = 2 (เกิดข้อผิดพลาด/ล็อกซ้ำ) จะพิมพ์ JSON สมบูรณ์ลง stdout
    //    - ห้ามคืน stdout หากขนาดแตะ/เกิน maxBufferBytes
    if (stdoutBytes >= params.maxBufferBytes) {
      const limitMb = (params.maxBufferBytes / (1024 * 1024)).toFixed(1);
      throw new ScannerExeError(
        'SCANNER_OUTPUT_TOO_LARGE',
        `SCANNER_OUTPUT_TOO_LARGE: ข้อมูลจากโปรแกรมดึงสแกนมีขนาดเกินขีดจำกัด Buffer ที่ปลอดภัย (${limitMb} MB) กรุณาลดช่วงวันที่ที่เลือกหรือแบ่งการดึงข้อมูลเป็นช่วงย่อย`,
        413,
        meta
      );
    }

    if (rawStdout.trim().length > 0) {
      return {
        stdout: rawStdout,
        stderr: rawStderr,
        exitCode,
        signal,
        stdoutBytes,
        stderrBytes,
        durationMs,
      };
    }

    throw new ScannerExeError(
      'SCANNER_DEVICE_UNREACHABLE',
      `SCANNER_DEVICE_UNREACHABLE: ไม่สามารถดึงข้อมูลจากเครื่องสแกนได้ (Exit Code: ${exitCode ?? 'unknown'})`,
      503,
      meta
    );
  }
}

/**
 * ตรวจสอบว่าบรรทัดข้อความเป็นบรรทัด Log นำหน้าที่ยืนยันว่ามาจาก ScannerSyncCli.exe
 * เช่น [INFO] Successfully read..., [ERROR] CONNECT FAILED..., เส้นคั่น ---
 */
function isConfirmedCliLogPrefixLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^\[(INFO|ERROR|WARN|WARNING|DEBUG)\](?:\s|$)/i.test(trimmed)) return true;
  if (/^-{3,}$/.test(trimmed)) return true;
  if (/^READ ONLY TEST$/i.test(trimmed)) return true;
  return false;
}

/**
 * ตรวจสอบว่าข้อความมีลักษณะเริ่มต้นเป็นโครงสร้าง JSON (เพื่อแยก JSON ที่ถูกตัด/ผิดรูปแบบ ออกจาก Plain Error Text)
 */
function startsLikeJsonDocument(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{')) return true;
  // แยก `[` ของ JSON Array ออกจาก `[INFO]` / `[ERROR]`
  if (trimmed.startsWith('[') && !/^\[(INFO|ERROR|WARN|WARNING|DEBUG)\]/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * แปลง stdout จากโปรแกรมอ่านสแกนเป็น JSON อย่างปลอดภัยแบบ Fail-Closed:
 * - ลบ UTF-8 BOM หากมี
 * - รองรับ JSON ที่สมบูรณ์ทั้งก้อน
 * - รองรับเฉพาะบรรทัด Log นำหน้าที่ยืนยันได้จาก ScannerSyncCli.exe ([INFO]/[ERROR]/---) ก่อนก้อน JSON ที่สมบูรณ์
 * - ปฏิเสธ JSON ที่ถูกตัดกลางทาง, มีข้อความขยะต่อท้าย หรือไม่ครบโครงสร้างเสมอ
 */
export function parseScannerExeJsonOutput(
  stdoutText: string,
  options?: { exitCode?: number | null }
): unknown {
  const withoutBom = String(stdoutText || '').replace(/^\uFEFF/, '');
  const trimmed = withoutBom.trim();

  if (!trimmed) {
    throw new ScannerExeError(
      'INVALID_EXE_JSON_OUTPUT',
      'INVALID_EXE_JSON_OUTPUT: ผลลัพธ์จากโปรแกรมดึงสแกนว่างเปล่าหรือไม่ใช่ JSON ที่ถูกต้อง',
      422
    );
  }

  // 1. พยายาม Parse JSON โดยตรงก่อน (กรณีมาตรฐานที่สะอาดที่สุด)
  try {
    const direct = JSON.parse(trimmed);
    if (direct === null || typeof direct !== 'object') {
      throw new ScannerExeError(
        'INVALID_EXE_CONTRACT',
        'INVALID_EXE_CONTRACT: JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array 6 ฟิลด์ หรือ Object ตาม Contract',
        422
      );
    }
    return direct;
  } catch (err) {
    if (err instanceof ScannerExeError) {
      throw err;
    }
  }

  // 2. ตรวจสอบเฉพาะกรณีมีบรรทัด Log ที่ยืนยันได้จาก ScannerSyncCli.exe นำหน้า JSON ที่สมบูรณ์
  const lines = withoutBom.split(/\r?\n/);
  let firstJsonLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isConfirmedCliLogPrefixLine(line)) {
      continue;
    }
    if (startsLikeJsonDocument(line)) {
      firstJsonLineIdx = i;
      break;
    }
    // พบข้อความทั่วไปที่ไม่ใช่บรรทัด Log นำหน้าที่รู้จัก -> ไม่สุ่มตัดข้อความกลางคัน
    break;
  }

  if (firstJsonLineIdx > 0) {
    const candidateJson = lines.slice(firstJsonLineIdx).join('\n').trim();
    try {
      const extracted = JSON.parse(candidateJson);
      if (extracted === null || typeof extracted !== 'object') {
        throw new ScannerExeError(
          'INVALID_EXE_CONTRACT',
          'INVALID_EXE_CONTRACT: JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array 6 ฟิลด์ หรือ Object ตาม Contract',
          422
        );
      }
      return extracted;
    } catch (err) {
      if (err instanceof ScannerExeError) {
        throw err;
      }
      // JSON หลังบรรทัด Log ถูกตัดกลางทางหรือผิดรูปแบบ -> Fail-Closed เสมอ
      throw new ScannerExeError(
        'INVALID_EXE_JSON_OUTPUT',
        'INVALID_EXE_JSON_OUTPUT: ผลลัพธ์จากโปรแกรมดึงสแกนไม่ใช่ JSON ที่สมบูรณ์หรือถูกตัดกลางทาง',
        422
      );
    }
  }

  // 3. หาก EXE จบด้วย Non-zero Exit Code และส่งเฉพาะ Plain Error Text (ไม่มีก้อน JSON เลย)
  //    ให้แยกออกจากการที่ JSON ผิดรูปแบบจริง และรายงานเป็น SCANNER_DEVICE_UNREACHABLE (ไม่ส่ง raw stdout กลับ Browser)
  const exitCode = options?.exitCode ?? null;
  if (exitCode !== null && exitCode !== 0 && !startsLikeJsonDocument(trimmed)) {
    throw new ScannerExeError(
      'SCANNER_DEVICE_UNREACHABLE',
      `SCANNER_DEVICE_UNREACHABLE: โปรแกรมดึงสแกนส่งข้อความแจ้งข้อผิดพลาด (Exit Code: ${exitCode}) และไม่สามารถอ่านข้อมูลจากเครื่องสแกนได้`,
      503
    );
  }

  throw new ScannerExeError(
    'INVALID_EXE_JSON_OUTPUT',
    'INVALID_EXE_JSON_OUTPUT: ผลลัพธ์จากโปรแกรมดึงสแกนไม่ใช่ JSON ที่ถูกต้อง',
    422
  );
}

/**
 * ตรวจสอบโครงสร้าง JSON หลัง Parse ตามสัญญาเดิมของ ScannerReader.exe / ScannerSyncCli.exe
 */
export function extractScannerContractPayload(parsed: unknown): ParsedScannerContractResult {
  if (Array.isArray(parsed)) {
    return {
      ok: true,
      events: parsed,
      machines: [],
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ScannerExeError(
      'INVALID_EXE_CONTRACT',
      'INVALID_EXE_CONTRACT: JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array ของ Event 6 ฟิลด์',
      422
    );
  }

  const wrapper = parsed as {
    success?: unknown;
    message?: unknown;
    error?: unknown;
    exitCode?: unknown;
    machines?: unknown;
    scans?: unknown;
  };

  if (wrapper.machines !== undefined && !Array.isArray(wrapper.machines)) {
    throw new ScannerExeError(
      'INVALID_EXE_CONTRACT',
      'INVALID_EXE_CONTRACT: ฟิลด์ machines ใน JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array',
      422
    );
  }

  const machines: ScannerMachineStatusReport[] = Array.isArray(wrapper.machines)
    ? (wrapper.machines as ScannerMachineStatusReport[])
    : [];

  if (wrapper.success === false) {
    const rawMsg =
      (typeof wrapper.error === 'string' && wrapper.error.trim()) ||
      (typeof wrapper.message === 'string' && wrapper.message.trim()) ||
      'ไม่สามารถดึงข้อมูลจากเครื่องสแกนนิ้วได้';
    return {
      ok: false,
      errorMessage: sanitizeScannerErrorMessage(rawMsg),
      machines,
    };
  }

  if (!Array.isArray(wrapper.scans)) {
    throw new ScannerExeError(
      'INVALID_EXE_CONTRACT',
      'INVALID_EXE_CONTRACT: JSON จากโปรแกรมสแกนนิ้วต้องเป็น Array 6 ฟิลด์ หรือ Object ที่มีฟิลด์ scans เป็น Array',
      422
    );
  }

  return {
    ok: true,
    events: wrapper.scans,
    machines,
  };
}
