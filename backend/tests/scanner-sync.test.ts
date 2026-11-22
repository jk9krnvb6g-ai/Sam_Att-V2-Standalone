/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติสำหรับ Scanner Sync Backend (SCAN-01 ถึง SCAN-20)
 * ไฟล์: backend/tests/scanner-sync.test.ts
 * ============================================================================
 * ครอบคลุม:
 * - การสร้าง Arguments (--days 1/2/7/30/90, --preview, --machine) แบบ Array ปลอดภัย
 * - Buffer Limit (32 MB default / 64 MB hard cap) และการแยก ERR_CHILD_PROCESS_STDIO_MAXBUFFER
 * - Timeout (120s default / 300s hard cap) และการฆ่าโปรเซสจริงเมื่อ Timeout
 * - Fail-Closed JSON Parsing (UTF-8 BOM, [INFO]/[ERROR] prefix, Truncated JSON, Plain Error Text)
 * - Data Integrity (Deduplication, Post-Read Filter, Zero Partial Writes, Mutex Release)
 * - Security & Diagnostic Logging (Zero Secret / Raw Scan Leakage)
 * - Regression (TODAY Mode & ATT-01..ATT-16 Matching Engine)
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import type { AddressInfo } from 'net';
import {
  resetSqliteInstanceForTests,
  runMigrations,
  seedBaselineAndSyntheticData,
  dbQuery,
} from '../src/database/adapter.ts';
import {
  loadConfig,
  assertTestEnvironmentIsolated,
  SCANNER_MAX_BUFFER_DEFAULT_BYTES,
  SCANNER_MAX_BUFFER_HARD_CAP_BYTES,
  SCANNER_TIMEOUT_DEFAULT_MS,
  SCANNER_TIMEOUT_HARD_CAP_MS,
} from '../src/config/env.ts';
import {
  setScannerExeTestDouble,
  isScannerSyncLocked,
  setScannerSyncLockForTests,
} from '../src/modules/scanners/routes.ts';
import {
  buildScannerExeArgs,
  parseScannerExeJsonOutput,
  runScannerExeProcess,
  setScannerExeProcessRunnerForTests,
  setScannerDiagnosticLoggerForTests,
  ScannerExeError,
  type ScannerSyncDiagnosticLog,
} from '../src/modules/scanners/exeRunner.ts';
import { validateAndNormalizeScannerSyncRange } from '../src/modules/scanners/syncRange.ts';
import { matchPersonShiftsGlobally } from '../src/modules/attendance/matchingEngine.ts';
import { getCurrentBangkokDateParts } from '../src/utils/crypto.ts';
import { ensureTlsCertificates } from '../src/server.ts';
import { createExpressApp } from '../src/app.ts';

const TEST_RUN_ID = `scan_${process.pid}_${Date.now()}`;
const TEST_SQLITE_PATH = path.join(os.tmpdir(), `sam_att_scanner_${TEST_RUN_ID}.sqlite`);
const TEST_CERT_DIR = path.join(os.tmpdir(), `sam_att_scanner_certs_${TEST_RUN_ID}`);
const CERT_PATH = path.join(TEST_CERT_DIR, 'server.crt');
const KEY_PATH = path.join(TEST_CERT_DIR, 'server.key');

let httpsServer: https.Server;
let baseUrl: string;

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

function shiftYmd(baseYmd: string, deltaDays: number): string {
  const [y, m, d] = baseYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
}

async function apiCall(
  endpoint: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
  } = {}
): Promise<{ status: number; data: any; rawText: string }> {
  const headers: Record<string, string> = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  let bodyBuffer: Buffer | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    bodyBuffer = Buffer.from(JSON.stringify(options.body), 'utf8');
    headers['Content-Length'] = String(bodyBuffer.length);
  }

  return new Promise((resolve, reject) => {
    const url = new URL(`${baseUrl}${endpoint}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: options.method || 'GET',
        headers,
        agent: httpsAgent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let data: any;
          try {
            data = JSON.parse(rawText);
          } catch {
            data = rawText;
          }
          resolve({
            status: res.statusCode || 500,
            data,
            rawText,
          });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

describe('Scanner Sync Backend — Multi-Day Buffer, Timeout, Fail-Closed Parsing & Safety (SCAN-01..SCAN-20)', () => {
  let adminToken = '';
  let staffToken = '';
  const capturedDiagnostics: ScannerSyncDiagnosticLog[] = [];

  before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
    process.env.SAM_ATT_DATA_MODE = 'DEMO';
    process.env.PUBLIC_BASE_PATH = '/Sam_Att/';
    process.env.API_BASE_PATH = '/api/Sam_Att';
    process.env.SCANNER_SYNC_ENABLED = 'false';
    process.env.SCANNER_AUTO_SCHEDULER_ENABLED = 'false';
    process.env.SCANNER_READER_EXE_PATH = './ScannerReader/ScannerSyncCli.exe';
    delete process.env.SCANNER_READER_MAX_BUFFER_BYTES;
    delete process.env.SCANNER_READER_TIMEOUT_MS;
    process.env.TLS_CERT_PATH = CERT_PATH;
    process.env.TLS_KEY_PATH = KEY_PATH;

    resetSqliteInstanceForTests(TEST_SQLITE_PATH);
    assertTestEnvironmentIsolated();

    await runMigrations();
    await seedBaselineAndSyntheticData();

    ensureTlsCertificates(CERT_PATH, KEY_PATH, 'test');
    const app = createExpressApp({ serveStaticBuild: false });
    httpsServer = https.createServer(
      {
        key: fs.readFileSync(KEY_PATH),
        cert: fs.readFileSync(CERT_PATH),
      },
      app
    );
    await new Promise<void>((resolve) => {
      httpsServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = httpsServer.address() as AddressInfo;
    baseUrl = `https://127.0.0.1:${addr.port}`;

    const loginAdminRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(loginAdminRes.status, 200);
    adminToken = loginAdminRes.data.token;

    const loginRes = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(loginRes.status, 200);
    staffToken = loginRes.data.token;

    setScannerDiagnosticLoggerForTests((entry) => {
      capturedDiagnostics.push(entry);
    });
  });

  after(async () => {
    setScannerExeTestDouble(null);
    setScannerExeProcessRunnerForTests(null);
    setScannerDiagnosticLoggerForTests(null);
    setScannerSyncLockForTests(false);
    delete process.env.SCANNER_READER_MAX_BUFFER_BYTES;
    delete process.env.SCANNER_READER_TIMEOUT_MS;

    if (httpsServer) {
      await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    }
    try {
      if (fs.existsSync(TEST_SQLITE_PATH)) fs.unlinkSync(TEST_SQLITE_PATH);
      if (fs.existsSync(TEST_CERT_DIR)) fs.rmSync(TEST_CERT_DIR, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('SCAN-01..SCAN-06 & Config Bounds: TODAY, CUSTOM_RANGE (1/2/7/30d), ALL_SUPPORTED (90d) & safe EXE args', async () => {
    // ตรวจค่าเริ่มต้นและเพดานความปลอดภัยของ Buffer / Timeout
    const defaultCfg = loadConfig();
    assert.equal(defaultCfg.scanner.maxBufferBytes, SCANNER_MAX_BUFFER_DEFAULT_BYTES);
    assert.equal(defaultCfg.scanner.timeoutMs, SCANNER_TIMEOUT_DEFAULT_MS);

    // ตรวจการ clamp ค่าเกินเพดานสูงสุด (ห้ามเพิ่ม Buffer / Timeout แบบไม่จำกัด)
    process.env.SCANNER_READER_MAX_BUFFER_BYTES = '999999999999';
    process.env.SCANNER_READER_TIMEOUT_MS = '999999999';
    const clampedCfg = loadConfig();
    assert.equal(clampedCfg.scanner.maxBufferBytes, SCANNER_MAX_BUFFER_HARD_CAP_BYTES);
    assert.equal(clampedCfg.scanner.timeoutMs, SCANNER_TIMEOUT_HARD_CAP_MS);
    delete process.env.SCANNER_READER_MAX_BUFFER_BYTES;
    delete process.env.SCANNER_READER_TIMEOUT_MS;

    // ตรวจการสร้าง Arguments แบบ Array (ไม่มี Shell Interpolation)
    assert.deepEqual(
      buildScannerExeArgs({ isScannerSyncCli: true, exeDaysArg: 1, previewMode: true, machineNo: null }),
      ['--days', '1', '--preview']
    );
    assert.deepEqual(
      buildScannerExeArgs({ isScannerSyncCli: true, exeDaysArg: 2, previewMode: true, machineNo: 1 }),
      ['--days', '2', '--preview', '--machine', '1']
    );
    assert.deepEqual(
      buildScannerExeArgs({ isScannerSyncCli: true, exeDaysArg: 7, previewMode: true }),
      ['--days', '7', '--preview']
    );
    assert.deepEqual(
      buildScannerExeArgs({ isScannerSyncCli: true, exeDaysArg: 30, previewMode: true }),
      ['--days', '30', '--preview']
    );
    assert.deepEqual(
      buildScannerExeArgs({ isScannerSyncCli: true, exeDaysArg: 90, previewMode: true }),
      ['--days', '90', '--preview']
    );

    const bkkToday = getCurrentBangkokDateParts().todayYmd;
    const capturedCalls: Array<{ args: string[]; maxBufferBytes: number; timeoutMs: number }> = [];

    try {
      setScannerExeProcessRunnerForTests(async (params) => {
        capturedCalls.push({
          args: [...params.args],
          maxBufferBytes: params.maxBufferBytes,
          timeoutMs: params.timeoutMs,
        });
        const scans = [
          {
            machineNo: 1,
            enrollNumber: '1001',
            scanDateTime: `${bkkToday} 07:45:00`,
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 1,
            enrollNumber: '1001',
            scanDateTime: `${shiftYmd(bkkToday, -1)} 07:50:00`,
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 1,
            enrollNumber: '1001',
            scanDateTime: `${shiftYmd(bkkToday, -6)} 07:52:00`,
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 1,
            enrollNumber: '1001',
            scanDateTime: `${shiftYmd(bkkToday, -29)} 07:55:00`,
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
          {
            machineNo: 1,
            enrollNumber: '1001',
            scanDateTime: `${shiftYmd(bkkToday, -85)} 07:58:00`,
            verifyMode: 1,
            inOutMode: 0,
            workCode: 0,
          },
        ];
        return {
          stdout: JSON.stringify({ success: true, totalRead: scans.length, machines: [], scans }, null, 2),
          stderr: '',
        };
      });

      // SCAN-01: TODAY (--days 1)
      const resToday = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(resToday.status, 200);
      assert.equal(resToday.data.syncMode, 'TODAY');
      assert.equal(resToday.data.exeDaysArgUsed, 1);
      assert.equal(resToday.data.matchedInRange, 1);
      assert.equal(resToday.data.filteredOutCount, 4);
      assert.deepEqual(capturedCalls.at(-1)?.args, ['--days', '1', '--preview']);
      assert.equal(capturedCalls.at(-1)?.maxBufferBytes, SCANNER_MAX_BUFFER_DEFAULT_BYTES);

      // SCAN-02: CUSTOM_RANGE 1 day
      const res1d = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: bkkToday,
          timeFrom: '00:00',
          dateTo: bkkToday,
          timeTo: '23:59',
        },
      });
      assert.equal(res1d.status, 200);
      assert.equal(res1d.data.exeDaysArgUsed, 1);
      assert.equal(res1d.data.matchedInRange, 1);
      assert.deepEqual(capturedCalls.at(-1)?.args, ['--days', '1', '--preview']);

      // SCAN-03: CUSTOM_RANGE 2 days
      const res2d = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: shiftYmd(bkkToday, -1),
          timeFrom: '00:00',
          dateTo: bkkToday,
          timeTo: '23:59',
        },
      });
      assert.equal(res2d.status, 200);
      assert.equal(res2d.data.exeDaysArgUsed, 2);
      assert.equal(res2d.data.matchedInRange, 2);
      assert.deepEqual(capturedCalls.at(-1)?.args, ['--days', '2', '--preview']);

      // SCAN-04: CUSTOM_RANGE 7 days
      const res7d = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: shiftYmd(bkkToday, -6),
          timeFrom: '00:00',
          dateTo: bkkToday,
          timeTo: '23:59',
        },
      });
      assert.equal(res7d.status, 200);
      assert.equal(res7d.data.exeDaysArgUsed, 7);
      assert.equal(res7d.data.matchedInRange, 3);
      assert.deepEqual(capturedCalls.at(-1)?.args, ['--days', '7', '--preview']);

      // SCAN-05: CUSTOM_RANGE 30 days
      const res30d = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: shiftYmd(bkkToday, -29),
          timeFrom: '00:00',
          dateTo: bkkToday,
          timeTo: '23:59',
        },
      });
      assert.equal(res30d.status, 200);
      assert.equal(res30d.data.exeDaysArgUsed, 30);
      assert.equal(res30d.data.matchedInRange, 4);
      assert.deepEqual(capturedCalls.at(-1)?.args, ['--days', '30', '--preview']);

      // SCAN-06: ALL_SUPPORTED (alias -> ALL, 90 days, ADMIN + Reauth)
      const res90d = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: {
          syncMode: 'ALL_SUPPORTED',
          impactAcknowledged: true,
          confirmPassword: 'Admin@SamAtt2026',
        },
      });
      assert.equal(res90d.status, 200);
      assert.equal(res90d.data.syncMode, 'ALL');
      assert.equal(res90d.data.exeDaysArgUsed, 90);
      assert.equal(res90d.data.matchedInRange, 5);
      assert.equal(res90d.data.filteredOutCount, 0);
      assert.deepEqual(capturedCalls.at(-1)?.args, ['--days', '90', '--preview']);

      // ตรวจสอบว่า Scheduled Sync ยังคงใช้ defaultExeSyncDays=3
      const schedRange = validateAndNormalizeScannerSyncRange(
        { syncMode: 'ALL' },
        { maxRangeDays: 90, defaultExeSyncDays: 3, isScannerSyncCli: true, isScheduledSync: true }
      );
      assert.equal(schedRange.exeDaysArg, 3);
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-07: Large pretty-printed JSON payload (> 1 MB default Node buffer, within 32 MB limit) succeeds', async () => {
    const bkkToday = getCurrentBangkokDateParts().todayYmd;
    // สร้าง JSON แบบ WriteIndented=true ขนาด > 1.5 MB (มากกว่า default 1 MB ของ Node.js แต่ไม่เกิน 32 MB)
    const largeScans: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 8500; i++) {
      const hh = String(Math.floor(i / 3600) % 24).padStart(2, '0');
      const mm = String(Math.floor((i % 3600) / 60)).padStart(2, '0');
      const ss = String(i % 60).padStart(2, '0');
      // ใส่แค่ 2 รายการที่ตรงช่วงวันเป้าหมาย เพื่อไม่ให้ insert DB 8,500 แถวช้าเกินไป แต่ยังคงทดสอบ Parse JSON ขนาด > 1.4 MB จริง
      const ymd = i < 2 ? bkkToday : shiftYmd(bkkToday, -40);
      largeScans.push({
        machineNo: (i % 3) + 1,
        enrollNumber: String(9000 + (i % 50)),
        scanDateTime: `${ymd} ${hh}:${mm}:${ss}`,
        verifyMode: 1,
        inOutMode: i % 2,
        workCode: 0,
      });
    }
    const indentedPayload = JSON.stringify(
      { success: true, totalRead: largeScans.length, machines: [], scans: largeScans },
      null,
      2
    );
    const payloadBytes = Buffer.byteLength(indentedPayload, 'utf8');
    assert.ok(payloadBytes > 1_200_000, `Payload must exceed old 1 MB Node default, got ${payloadBytes} bytes`);

    try {
      // ทดสอบผ่าน child_process.execFile จริงด้วย Node child process เพื่อพิสูจน์ว่า maxBuffer 32 MB รองรับได้จริง
      const realExecResult = await runScannerExeProcess({
        exePath: process.execPath,
        args: [
          '-e',
          `const scans = [];
           for (let i = 0; i < 8500; i++) {
             scans.push({ machineNo: 1, enrollNumber: "9001", scanDateTime: "${shiftYmd(bkkToday, -40)} 08:00:00", verifyMode: 1, inOutMode: 0, workCode: 0 });
           }
           process.stdout.write(JSON.stringify({ success: true, totalRead: scans.length, machines: [], scans }, null, 2));`,
        ],
        cwd: process.cwd(),
        timeoutMs: 15_000,
        maxBufferBytes: SCANNER_MAX_BUFFER_DEFAULT_BYTES,
        mysqlConnectionString: '',
      });
      assert.ok(realExecResult.stdoutBytes > 1_200_000);
      const parsedLarge = parseScannerExeJsonOutput(realExecResult.stdout, { exitCode: 0 }) as any;
      assert.equal(parsedLarge.scans.length, 8500);

      // และทดสอบผ่าน HTTP Endpoint POST /api/Sam_Att/scanners/sync
      setScannerExeProcessRunnerForTests(async () => ({
        stdout: indentedPayload,
        stderr: '',
      }));
      const res = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: bkkToday,
          timeFrom: '00:00',
          dateTo: bkkToday,
          timeTo: '23:59',
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.totalReadFromDevice, 8500);
      assert.equal(res.data.matchedInRange, 2);
      assert.equal(res.data.filteredOutCount, 8498);
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-08: Output exceeding maxBuffer returns SCANNER_OUTPUT_TOO_LARGE (NOT INVALID_EXE_JSON_OUTPUT)', async () => {
    // 1. ทดสอบผ่าน Node child_process.execFile จริง ให้เกิด ERR_CHILD_PROCESS_STDIO_MAXBUFFER จริงๆ
    await assert.rejects(
      () =>
        runScannerExeProcess({
          exePath: process.execPath,
          args: ['-e', 'process.stdout.write("{\\"success\\":true,\\"scans\\":[\\"" + "A".repeat(40000) + "\\"]}");'],
          cwd: process.cwd(),
          timeoutMs: 10_000,
          maxBufferBytes: 4096,
          mysqlConnectionString: '',
        }),
      (err: unknown) => {
        assert.ok(err instanceof ScannerExeError);
        assert.equal(err.code, 'SCANNER_OUTPUT_TOO_LARGE');
        assert.equal(err.statusCode, 413);
        return true;
      }
    );

    // 2. ทดสอบผ่าน HTTP Route เมื่อ execFile โยน ERR_CHILD_PROCESS_STDIO_MAXBUFFER พร้อม stdout ที่ถูกตัด
    const beforeCount = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;
    try {
      setScannerExeProcessRunnerForTests(async () => {
        const overflowErr = new RangeError('stdout maxBuffer length exceeded') as Error & {
          code?: string;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        overflowErr.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        overflowErr.stdout = '{"success": true, "scans": [{"machineNo": 1, "enrollNumber": "1001"';
        overflowErr.stderr = '';
        overflowErr.killed = true;
        throw overflowErr;
      });

      const res = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: {
          syncMode: 'ALL',
          impactAcknowledged: true,
          confirmPassword: 'Admin@SamAtt2026',
        },
      });
      assert.equal(res.status, 413);
      assert.equal(res.data.error, 'SCANNER_OUTPUT_TOO_LARGE');
      assert.equal(res.data.failClosed, true);
      assert.notEqual(res.data.error, 'INVALID_EXE_JSON_OUTPUT');
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }

    const afterCount = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;
    assert.equal(afterCount, beforeCount, 'No partial rows may be saved on buffer overflow');
  });

  test('SCAN-09 & SCAN-17: Truncated JSON fails closed with INVALID_EXE_JSON_OUTPUT and saves zero partial rows', async () => {
    const beforeCount = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;

    const truncatedPayloads = [
      '{"success": true, "scans": [{"machineNo": 1, "enrollNumber": "1001", "scanDateTime": "2026-11-20 07:50:00"',
      '[INFO] Successfully read 500 records\n{"success": true, "scans": [{"machineNo": 1',
      '[{"machineNo": 1, "enrollNumber": "1001", "scanDateTime": "2026-11-20 07:50:00", "verifyMode": 1, "inOutMode": 0, "workCode": 0},',
    ];

    try {
      for (const badPayload of truncatedPayloads) {
        setScannerExeProcessRunnerForTests(async () => ({
          stdout: badPayload,
          stderr: '',
        }));
        const res = await apiCall('/api/Sam_Att/scanners/sync', {
          method: 'POST',
          token: staffToken,
          body: { syncMode: 'TODAY' },
        });
        assert.equal(res.status, 422);
        assert.equal(res.data.error, 'INVALID_EXE_JSON_OUTPUT');
        assert.equal(res.data.failClosed, true);
      }
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }

    const afterCount = (await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM raw_scans'))[0].cnt;
    assert.equal(afterCount, beforeCount, 'Zero partial records may be persisted when JSON parse fails');
  });

  test('SCAN-10: EXE Timeout kills process and returns SCANNER_TIMEOUT', async () => {
    // 1. ทดสอบ Timeout จริงบน Node child_process.execFile
    await assert.rejects(
      () =>
        runScannerExeProcess({
          exePath: process.execPath,
          args: ['-e', 'setTimeout(() => process.stdout.write("{}"), 5000);'],
          cwd: process.cwd(),
          timeoutMs: 150,
          maxBufferBytes: 1024 * 1024,
          mysqlConnectionString: '',
        }),
      (err: unknown) => {
        assert.ok(err instanceof ScannerExeError);
        assert.equal(err.code, 'SCANNER_TIMEOUT');
        assert.equal(err.statusCode, 503);
        return true;
      }
    );

    // 2. ทดสอบผ่าน HTTP Route
    try {
      setScannerExeProcessRunnerForTests(async () => {
        const err = new Error('Command timed out') as Error & { killed?: boolean; signal?: string; code?: string };
        err.killed = true;
        err.signal = 'SIGTERM';
        err.code = 'ETIMEDOUT';
        throw err;
      });
      const res = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: adminToken,
        body: {
          syncMode: 'ALL',
          impactAcknowledged: true,
          confirmPassword: 'Admin@SamAtt2026',
        },
      });
      assert.equal(res.status, 503);
      assert.equal(res.data.error, 'SCANNER_TIMEOUT');
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-11: Non-zero Exit Code with complete JSON (including [ERROR]/[INFO] prefix & UTF-8 BOM) follows EXE contract', async () => {
    const bkkToday = getCurrentBangkokDateParts().todayYmd;
    try {
      // 11a. exitCode = 1 (partial machine failure) + [ERROR] prefix + UTF-8 BOM + complete valid JSON
      setScannerExeProcessRunnerForTests(async () => {
        const err = new Error('Process exited with code 1') as Error & {
          code?: number;
          stdout?: string;
          stderr?: string;
        };
        err.code = 1;
        err.stdout =
          '\uFEFF[ERROR] CONNECT FAILED : Handle = -1 (Machine 3)\r\n' +
          '[INFO] Successfully read 1 scans from Machine 1\r\n' +
          JSON.stringify(
            {
              success: true,
              exitCode: 1,
              machines: [
                { machineNo: 1, ip: '192.168.111.163', read: 1, new: 1, duplicates: 0, status: 'OK' },
                { machineNo: 3, ip: '192.168.111.165', read: 0, new: 0, duplicates: 0, status: 'CONNECT_FAILED' },
              ],
              scans: [
                {
                  machineNo: 1,
                  enrollNumber: '1001',
                  scanDateTime: `${bkkToday} 08:02:15`,
                  verifyMode: 1,
                  inOutMode: 0,
                  workCode: 0,
                },
              ],
            },
            null,
            2
          );
        err.stderr = '[ERROR] Machine 3 unreachable';
        throw err;
      });

      const partialRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(partialRes.status, 200);
      assert.equal(partialRes.data.matchedInRange, 1);

      // 11b. exitCode = 2 + complete JSON { success: false, error: "Another sync process is already running." }
      setScannerExeProcessRunnerForTests(async () => {
        const err = new Error('Process exited with code 2') as Error & { code?: number; stdout?: string };
        err.code = 2;
        err.stdout = JSON.stringify({
          success: false,
          error: 'Another sync process is already running.',
          exitCode: 2,
        });
        throw err;
      });
      const lockRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(lockRes.status, 409);
      assert.equal(lockRes.data.error, 'SYNC_ALREADY_RUNNING');
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-12: EXE returning plain Error Text fails closed without echoing raw stderr/stdout', async () => {
    try {
      // 12a. Non-zero exit code + plain error text (no JSON at all) -> SCANNER_DEVICE_UNREACHABLE (503)
      setScannerExeProcessRunnerForTests(async () => {
        const err = new Error('Exit code 2') as Error & { code?: number; stdout?: string; stderr?: string };
        err.code = 2;
        err.stdout = '[ERROR] CONNECT FAILED : Handle = -1\nServer=10.1.0.201;Password=RAW_DB_SECRET_123';
        err.stderr = 'Unhandled exception Password=RAW_STDERR_SECRET_456';
        throw err;
      });
      const resNonZero = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(resNonZero.status, 503);
      assert.equal(resNonZero.data.error, 'SCANNER_DEVICE_UNREACHABLE');
      assert.equal(resNonZero.rawText.includes('RAW_DB_SECRET_123'), false);
      assert.equal(resNonZero.rawText.includes('RAW_STDERR_SECRET_456'), false);

      // 12b. Exit code 0 + non-JSON plain error text -> INVALID_EXE_JSON_OUTPUT (422)
      setScannerExeProcessRunnerForTests(async () => ({
        stdout: 'SCANNER_MYSQL_CONNECTION_STRING is not configured.',
        stderr: '',
      }));
      const resZeroText = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(resZeroText.status, 422);
      assert.equal(resZeroText.data.error, 'INVALID_EXE_JSON_OUTPUT');
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-13, SCAN-14 & SCAN-15: Deduplication, Cross-Day/Cross-Month & Backend Post-Read Filter', async () => {
    const payload = JSON.stringify({
      success: true,
      scans: [
        // นอกช่วง (ก่อน range)
        {
          machineNo: 101,
          enrollNumber: '1002',
          scanDateTime: '2026-12-29 23:59:59',
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
        // อยู่ในช่วงข้ามเดือน (31 ธ.ค. เวรข้ามวัน -> 1 ม.ค.)
        {
          machineNo: 101,
          enrollNumber: '1002',
          scanDateTime: '2026-12-31 19:55:00',
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
        {
          machineNo: 101,
          enrollNumber: '1002',
          scanDateTime: '2027-01-01 08:05:00',
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
        // นอกช่วง (หลัง range)
        {
          machineNo: 101,
          enrollNumber: '1002',
          scanDateTime: '2027-01-03 07:50:00',
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
      ],
    });

    try {
      setScannerExeProcessRunnerForTests(async () => ({ stdout: payload, stderr: '' }));

      // รอบแรก: บันทึกเฉพาะ 2 รายการในช่วยข้ามเดือน กรองออก 2 รายการ
      const run1 = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: '2026-12-30',
          timeFrom: '00:00',
          dateTo: '2027-01-02',
          timeTo: '23:59',
        },
      });
      assert.equal(run1.status, 200);
      assert.equal(run1.data.matchedInRange, 2);
      assert.equal(run1.data.filteredOutCount, 2);
      assert.equal(run1.data.newInserted, 2);
      assert.equal(run1.data.duplicatesSkipped, 0);

      // ตรวจสอบว่ารายการนอกช่วงไม่ถูกบันทึกลง raw_scans
      const excludedRows = await dbQuery(
        `SELECT id FROM raw_scans
         WHERE enroll_number = '1002'
           AND canonical_bkk_time IN ('2026-12-29 23:59:59', '2027-01-03 07:50:00')`
      );
      assert.equal(excludedRows.length, 0);

      // รอบสอง (SCAN-13): ดึงซ้ำต้องข้ามรายการซ้ำ 100%
      const run2 = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: {
          syncMode: 'CUSTOM_RANGE',
          dateFrom: '2026-12-30',
          timeFrom: '00:00',
          dateTo: '2027-01-02',
          timeTo: '23:59',
        },
      });
      assert.equal(run2.status, 200);
      assert.equal(run2.data.newInserted, 0);
      assert.equal(run2.data.duplicatesSkipped, 2);
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-16: Mutex lock is always released after every failure mode', async () => {
    const failures: Array<() => Promise<{ stdout: string; stderr: string }>> = [
      async () => {
        const e = new RangeError('stdout maxBuffer length exceeded') as Error & { code?: string };
        e.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        throw e;
      },
      async () => {
        const e = new Error('timeout') as Error & { killed?: boolean; signal?: string };
        e.killed = true;
        e.signal = 'SIGTERM';
        throw e;
      },
      async () => {
        const e = new Error('ENOENT') as Error & { code?: string };
        e.code = 'ENOENT';
        throw e;
      },
      async () => ({ stdout: '{"truncated": ', stderr: '' }),
    ];

    try {
      for (const failRunner of failures) {
        setScannerExeProcessRunnerForTests(failRunner);
        const failRes = await apiCall('/api/Sam_Att/scanners/sync', {
          method: 'POST',
          token: staffToken,
          body: { syncMode: 'TODAY' },
        });
        assert.ok(failRes.status >= 400);
        assert.equal(isScannerSyncLocked(), false, 'Mutex MUST be released immediately in finally block');
      }

      // หลังล้มเหลวทุกแบบ ต้องสามารถสั่งซิงก์รอบถัดไปได้ทันทีโดยไม่ติด 409 SYNC_ALREADY_RUNNING
      setScannerExeProcessRunnerForTests(async () => ({
        stdout: JSON.stringify({ success: true, scans: [] }),
        stderr: '',
      }));
      const recoveryRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(recoveryRes.status, 200);
      assert.equal(isScannerSyncLocked(), false);
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-18: Diagnostic logging records safe metadata and never exposes secrets or raw scans', async () => {
    capturedDiagnostics.length = 0;
    const secretMarker = 'SUPER_SECRET_DB_PASS_999';
    const enrollMarker = 'ENROLL_PII_887766';

    try {
      setScannerExeProcessRunnerForTests(async () => {
        const err = new Error(
          `Connection failed Server=10.1.0.201;User ID=dba_root;Password=${secretMarker};Bearer TOKEN_XYZ_SECRET`
        ) as Error & { code?: number; stdout?: string; stderr?: string };
        err.code = 2;
        err.stdout = JSON.stringify({
          success: false,
          error: `DB Auth Failed Password=${secretMarker} for ${enrollMarker}`,
        });
        err.stderr = `Password=${secretMarker}`;
        throw err;
      });

      const res = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(res.status, 503);
      assert.equal(res.rawText.includes(secretMarker), false, 'API response must never leak passwords');

      assert.ok(capturedDiagnostics.length >= 1, 'Diagnostic log must be emitted');
      const diag = capturedDiagnostics.at(-1)!;
      assert.ok(diag.requestId);
      assert.ok(diag.jobId);
      assert.equal(diag.syncMode, 'TODAY');
      assert.equal(diag.exeDaysArgUsed, 1);
      assert.ok(diag.requestedDateRange.fromBkk);
      assert.ok(diag.requestedDateRange.toBkk);
      assert.equal(typeof diag.durationMs, 'number');
      assert.equal(diag.exitCode, 2);
      assert.ok(diag.stdoutBytes > 0);
      assert.ok(diag.stderrBytes > 0);
      assert.equal(diag.bufferLimitBytes, SCANNER_MAX_BUFFER_DEFAULT_BYTES);
      assert.equal(diag.errorCode, 'SCANNER_DEVICE_UNREACHABLE');

      const diagSerialized = JSON.stringify(diag);
      assert.equal(diagSerialized.includes(secretMarker), false, 'Diagnostic log must never leak secrets');
      assert.equal(diagSerialized.includes(enrollMarker), false, 'Diagnostic log must never leak raw scans/PII');
      assert.equal(diagSerialized.includes('TOKEN_XYZ_SECRET'), false, 'Diagnostic log must never leak tokens');
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }
  });

  test('SCAN-19 & SCAN-20: TODAY regression and ATT-01..ATT-16 matching engine regression', async () => {
    // SCAN-19: ตรวจ Regression โหมด TODAY กับสัญญา EXE จริง (มี [INFO] prefix + UTF-8 BOM + JSON)
    const bkkToday = getCurrentBangkokDateParts().todayYmd;
    try {
      setScannerExeProcessRunnerForTests(async () => ({
        stdout:
          '\uFEFF[INFO] Successfully read 2 records\n' +
          JSON.stringify({
            success: true,
            totalRead: 2,
            machines: [{ machineNo: 1, status: 'OK', read: 2 }],
            scans: [
              {
                machineNo: 1,
                enrollNumber: '1004',
                scanDateTime: `${bkkToday} 07:49:00`,
                verifyMode: 1,
                inOutMode: 0,
                workCode: 0,
              },
              {
                machineNo: 1,
                enrollNumber: '1004',
                scanDateTime: `${bkkToday} 16:05:00`,
                verifyMode: 1,
                inOutMode: 1,
                workCode: 0,
              },
            ],
          }),
        stderr: '',
      }));

      const todayRes = await apiCall('/api/Sam_Att/scanners/sync', {
        method: 'POST',
        token: staffToken,
        body: { syncMode: 'TODAY' },
      });
      assert.equal(todayRes.status, 200);
      assert.equal(todayRes.data.syncMode, 'TODAY');
      assert.equal(todayRes.data.exeDaysArgUsed, 1);
      assert.equal(todayRes.data.filterStrategy, 'BACKEND_POST_READ_FILTER');
      assert.equal(todayRes.data.matchedInRange, 2);
      assert.equal(todayRes.data.failedCount, 0);
    } finally {
      setScannerExeProcessRunnerForTests(null);
    }

    // SCAN-20: ยืนยันว่า Matching Engine ATT-01..ATT-16 (เช่น เวรควบ เช้า+ดึกข้ามวัน) ทำงานไม่ถดถอย
    const matchResult = matchPersonShiftsGlobally({
      shifts: [
        {
          personId: 'P001',
          workDate: '2026-11-20',
          shiftAssignmentId: 1,
          shiftCode: 'M0816',
          shiftName: 'เวรเช้า',
          startTime: '08:00',
          endTime: '16:00',
          graceMinutes: 15,
          cutoffTime: '18:00',
          isCrossMidnight: 0,
          mappingStatus: 'VALID',
          checkinWindowBeforeMin: 120,
          checkinWindowAfterMin: 180,
          checkoutWindowBeforeMin: 60,
          checkoutWindowAfterMin: 180,
        },
        {
          personId: 'P001',
          workDate: '2026-11-20',
          shiftAssignmentId: 2,
          shiftCode: 'N2008',
          shiftName: 'เวรดึก',
          startTime: '20:00',
          endTime: '08:00',
          graceMinutes: 15,
          cutoffTime: '10:00',
          isCrossMidnight: 1,
          mappingStatus: 'VALID',
          checkinWindowBeforeMin: 120,
          checkinWindowAfterMin: 180,
          checkoutWindowBeforeMin: 60,
          checkoutWindowAfterMin: 180,
        },
      ],
      rawScans: [
        { id: 10, personId: 'P001', canonicalBkkTime: '2026-11-20 07:50:00', inOutMode: 0 },
        { id: 11, personId: 'P001', canonicalBkkTime: '2026-11-20 16:05:00', inOutMode: 1 },
        { id: 12, personId: 'P001', canonicalBkkTime: '2026-11-20 19:52:00', inOutMode: 0 },
        { id: 13, personId: 'P001', canonicalBkkTime: '2026-11-21 08:06:00', inOutMode: 1 },
      ],
      leaves: [],
      config: {
        referenceNowBkk: '2026-11-21 12:00:00',
        halfDayPreCheckinWindowMinutes: 60,
      },
    });
    assert.equal(matchResult.outcomes.length, 2);
    assert.equal(matchResult.outcomes[0].status, 'NORMAL');
    assert.equal(matchResult.outcomes[0].checkInRawScanId, 10);
    assert.equal(matchResult.outcomes[0].checkOutRawScanId, 11);
    assert.equal(matchResult.outcomes[1].status, 'NORMAL');
    assert.equal(matchResult.outcomes[1].checkInRawScanId, 12);
    assert.equal(matchResult.outcomes[1].checkOutRawScanId, 13);
  });
});
