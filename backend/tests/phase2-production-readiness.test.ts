/**
 * ============================================================================
 * ชุดทดสอบความพร้อมสำหรับการใช้งานจริงบน Windows Server 2025 (Phase 2 Production Readiness Test Suite)
 * ไฟล์: backend/tests/phase2-production-readiness.test.ts
 * ============================================================================
 * ครอบคลุมการตรวจสอบ:
 * 1. โครงสร้างโฟลเดอร์มาตรฐาน Drive D (D:\WebApps\Sam_Att, D:\Backups\Sam_Att, D:\Deployments\Sam_Att)
 * 2. การตรวจสอบคู่ใบรับรอง X.509 Certificate + Private Key (validateTlsCertificatePair) และ Fail-Closed Production Config
 * 3. การป้องกันการสร้าง Self-Signed Certificate อัตโนมัติในโหมด Production และการใส่ IP SAN 10.2.0.23
 * 4. โหมด Standby ของ Scanner Scheduler (SCANNER_AUTO_SCHEDULER_ENABLED=false) เพื่อป้องกันการซิงก์ซ้ำก่อน Cutover
 * 5. การตรวจสอบฐานข้อมูลแบบ Read-Only 100% (runProductionDatabasePreflightReadOnly & startupReadOnlyOnMysql)
 * 6. จุดตรวจสอบสถานะระบบ /api/Sam_Att/health, /api/Sam_Att/health/live, /api/Sam_Att/health/ready และการแยก API 404 JSON
 * 7. ระบบบันทึกข้อมูลลงไฟล์พร้อมหมุนเวียนไฟล์อัตโนมัติและการปกปิดข้อมูลความลับ (Structured Logger & Secret Redaction)
 * 8. การตรวจสอบความปลอดภัยและมาตรฐาน 7-bit ASCII ของชุดสคริปต์ PowerShell 5.1 และ WinSW XML ทั้งหมด
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';
import crypto from 'crypto';

const TEST_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TMP_SQLITE_PATH = path.join(os.tmpdir(), `sam_att_phase2_${TEST_ID}.sqlite`);
const TMP_CERT_DIR = path.join(os.tmpdir(), `sam_att_phase2_certs_${TEST_ID}`);
const TMP_LOGS_DIR = path.join(os.tmpdir(), `sam_att_phase2_logs_${TEST_ID}`);
const CERT_PATH = path.join(TMP_CERT_DIR, 'server.crt');
const KEY_PATH = path.join(TMP_CERT_DIR, 'server.key');

process.env.NODE_ENV = 'test';
process.env.SAM_ATT_DATA_MODE = 'REAL';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TMP_SQLITE_PATH;
process.env.TLS_CERT_PATH = CERT_PATH;
process.env.TLS_KEY_PATH = KEY_PATH;
process.env.JWT_SECRET = 'phase2-test-jwt-secret-key-at-least-32-chars-long-998877';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'phase2-test-scanner-ingest-token-24chars';

import {
  loadConfig,
  validateProductionConfig,
  validateTlsCertificatePair,
  ProductionConfigError,
  DEFAULT_PRODUCTION_ROOT,
  DEFAULT_PRODUCTION_BACKUP_DIR,
  DEFAULT_PRODUCTION_DEPLOYMENTS_DIR,
} from '../src/config/env.ts';
import {
  runMigrations,
  ensureBaselineSystemCatalog,
  runProductionDatabasePreflightReadOnly,
  resetSqliteInstanceForTests,
} from '../src/database/adapter.ts';
import {
  generateSelfSignedX509CertAndKey,
  ensureTlsCertificates,
} from '../src/server.ts';
import { createExpressApp } from '../src/app.ts';
import { redactSecretsFromText, writeStructuredLog } from '../src/utils/logger.ts';

let httpsServer: https.Server;
let baseUrl = '';

async function requestJson(
  urlPath: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: Record<string, unknown>; data: any; rawText: string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, baseUrl);
    const req = https.request(
      url,
      {
        method: options.method || 'GET',
        headers: options.headers || {},
        rejectUnauthorized: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const rawText = Buffer.concat(chunks).toString('utf8');
          let data: any = null;
          try {
            data = JSON.parse(rawText);
          } catch {
            data = null;
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers as Record<string, unknown>,
            data,
            rawText,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

test('Phase 2 Production Readiness Verification Suite', async (t) => {
  resetSqliteInstanceForTests(TMP_SQLITE_PATH);
  ensureTlsCertificates(CERT_PATH, KEY_PATH, 'test');
  await runMigrations();
  await ensureBaselineSystemCatalog();

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
  const addr = httpsServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 4101;
  baseUrl = `https://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise<void>((resolve) => httpsServer.close(() => resolve()));
    resetSqliteInstanceForTests();
    for (const p of [TMP_SQLITE_PATH, TMP_CERT_DIR, TMP_LOGS_DIR]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  await t.test('1. Standard Drive D directory paths and Production Scanner Standby default', () => {
    assert.equal(DEFAULT_PRODUCTION_ROOT, 'D:\\WebApps\\Sam_Att');
    assert.equal(DEFAULT_PRODUCTION_BACKUP_DIR, 'D:\\Backups\\Sam_Att');
    assert.equal(DEFAULT_PRODUCTION_DEPLOYMENTS_DIR, 'D:\\Deployments\\Sam_Att');

    const cfg = loadConfig();
    assert.equal(cfg.paths.samAttRoot, 'D:\\WebApps\\Sam_Att');
    assert.equal(cfg.paths.appDir, 'D:\\WebApps\\Sam_Att\\App');
    assert.equal(cfg.paths.configDir, 'D:\\WebApps\\Sam_Att\\Config');
    assert.equal(cfg.paths.logsDir, 'D:\\WebApps\\Sam_Att\\Logs');
    assert.equal(cfg.paths.serviceDir, 'D:\\WebApps\\Sam_Att\\Service');
    assert.equal(cfg.paths.certsDir, 'D:\\WebApps\\Sam_Att\\Certs');
    assert.equal(cfg.paths.backupDir, 'D:\\Backups\\Sam_Att');
    assert.equal(cfg.paths.deploymentsDir, 'D:\\Deployments\\Sam_Att');

    // Verify production mode defaults scanner.autoSchedulerEnabled to false (Standby Mode prior to cutover)
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAutoSched = process.env.SCANNER_AUTO_SCHEDULER_ENABLED;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.SCANNER_AUTO_SCHEDULER_ENABLED;
      const prodCfg = loadConfig();
      assert.equal(
        prodCfg.scanner.autoSchedulerEnabled,
        false,
        'Production mode must default SCANNER_AUTO_SCHEDULER_ENABLED to false (Standby Mode)'
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevAutoSched !== undefined) {
        process.env.SCANNER_AUTO_SCHEDULER_ENABLED = prevAutoSched;
      }
    }
  });

  await t.test('2. X.509 Certificate & Private Key validation, IP SAN 10.2.0.23, and Production Auto-Cert Prevention', () => {
    // Valid matching pair with IP SAN 10.2.0.23
    const pairCheck = validateTlsCertificatePair(CERT_PATH, KEY_PATH);
    assert.equal(pairCheck.valid, true);
    assert.equal(pairCheck.errors.length, 0);
    assert.ok(pairCheck.subjectAltName?.includes('10.2.0.23'), 'Generated certificate must include IP SAN 10.2.0.23');

    // Mismatched private key detection
    const otherPair = generateSelfSignedX509CertAndKey('other-host');
    const mismatchedKeyPath = path.join(TMP_CERT_DIR, 'mismatched.key');
    fs.writeFileSync(mismatchedKeyPath, otherPair.keyPem, 'utf8');
    const mismatchResult = validateTlsCertificatePair(CERT_PATH, mismatchedKeyPath);
    assert.equal(mismatchResult.valid, false);
    assert.ok(mismatchResult.errors.some((e) => e.includes('TLS_KEY_MISMATCH')));

    // Production mode must NOT auto-generate self-signed certificates silently
    const missingProdCert = path.join(TMP_CERT_DIR, 'prod_missing.crt');
    const missingProdKey = path.join(TMP_CERT_DIR, 'prod_missing.key');
    ensureTlsCertificates(missingProdCert, missingProdKey, 'production');
    assert.equal(fs.existsSync(missingProdCert), false, 'Production startup must not auto-generate self-signed cert');
    assert.equal(fs.existsSync(missingProdKey), false, 'Production startup must not auto-generate self-signed key');

    // validateProductionConfig must fail closed when cert/key is missing or mismatched
    const baseCfg = loadConfig();
    assert.throws(
      () =>
        validateProductionConfig({
          ...baseCfg,
          nodeEnv: 'production',
          dataMode: 'REAL',
          dbEngine: 'mysql',
          tlsCertPath: CERT_PATH,
          tlsKeyPath: mismatchedKeyPath,
          samAttDb: {
            ...baseCfg.samAttDb,
            host: '10.1.0.201',
            user: 'sam_att_app',
            password: 'StrongProdDbPassword123!',
          },
        }),
      (err: unknown) => err instanceof ProductionConfigError && err.violations.some((v) => v.includes('TLS_KEY_MISMATCH'))
    );
  });

  await t.test('3. Read-Only Production Database Preflight Check verifies tables and columns without mutation', async () => {
    const report = await runProductionDatabasePreflightReadOnly();
    assert.equal(report.ok, true, `Expected DB preflight ok, got errors: ${report.errors.join('; ')}`);
    assert.equal(report.readOnlyMode, true);
    assert.equal(report.missingTables.length, 0);
    assert.equal(report.missingColumns.length, 0);
    assert.ok(report.existingTablesCount >= 16);
    assert.ok(typeof report.tableRowCounts.users === 'number');
  });

  await t.test('4. Health Check Endpoints (/health, /health/live, /health/ready) and API JSON 404 separation', async () => {
    const liveRes = await requestJson('/api/Sam_Att/health/live');
    assert.equal(liveRes.status, 200);
    assert.equal(liveRes.data.status, 'OK');
    assert.equal(liveRes.data.liveness, 'ALIVE');
    assert.equal(liveRes.data.applicationName, 'Sam_Att V2 Standalone');
    assert.ok(typeof liveRes.data.uptimeSeconds === 'number');
    assert.ok(typeof liveRes.data.commitHash === 'string');

    const readyRes = await requestJson('/api/Sam_Att/health/ready');
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.data.status, 'OK');
    assert.equal(readyRes.data.readiness, 'READY');
    assert.equal(readyRes.data.database.connected, true);
    assert.equal(readyRes.data.database.readOnlyStartupEnforced, true);
    assert.equal(readyRes.data.scanner.status, 'READY_OR_STANDBY');

    const mainHealthRes = await requestJson('/api/Sam_Att/health');
    assert.equal(mainHealthRes.status, 200);
    assert.equal(mainHealthRes.data.status, 'OK');
    assert.equal(mainHealthRes.data.service, 'Sam_Att V2 Standalone');

    const unknownApiRes = await requestJson('/api/Sam_Att/non-existent-phase2-route');
    assert.equal(unknownApiRes.status, 404);
    assert.equal(unknownApiRes.data.error, 'API_ENDPOINT_NOT_FOUND');
    assert.ok(String(unknownApiRes.headers['content-type']).includes('application/json'));
  });

  await t.test('5. Structured File Logger enforces secret redaction and size-based log rotation', () => {
    const rawSecretText =
      'Connecting with SAM_ATT_DB_PASSWORD=SuperSecretHospitalPwd999! and Bearer eyJhbGciOiJIUzI1NiJ9.secret and ghp_1234567890abcdefghijklmnopqrstuvwx';
    const redacted = redactSecretsFromText(rawSecretText);
    assert.ok(!redacted.includes('SuperSecretHospitalPwd999!'));
    assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9.secret'));
    assert.ok(!redacted.includes('ghp_1234567890abcdefghijklmnopqrstuvwx'));
    assert.ok(redacted.includes('***REDACTED***'));

    // Test file writing and rotation with a small maxBytesOverride (200 bytes)
    for (let i = 0; i < 6; i++) {
      writeStructuredLog({
        category: 'application',
        level: 'INFO',
        event: 'ROTATION_TEST',
        message: `Log entry ${i} with SAM_ATT_DB_PASSWORD=HiddenPassword12345`,
        logsDirOverride: TMP_LOGS_DIR,
        maxBytesOverride: 180,
      });
    }
    const appLogFile = path.join(TMP_LOGS_DIR, 'application.log');
    const rotatedLogFile = path.join(TMP_LOGS_DIR, 'application.log.1');
    assert.equal(fs.existsSync(appLogFile), true, 'application.log must be created');
    assert.equal(fs.existsSync(rotatedLogFile), true, 'application.log.1 must be created after rotation');
    const logContent = fs.readFileSync(appLogFile, 'utf8') + fs.readFileSync(rotatedLogFile, 'utf8');
    assert.ok(!logContent.includes('HiddenPassword12345'), 'Passwords must never be written to log files');
  });

  await t.test('6. PowerShell 5.1 Scripts & WinSW XML static safety and 7-bit ASCII compliance', () => {
    const psScripts = [
      'Install_Sam_Att.bat',
      'Install_Sam_Att.ps1',
      'Preflight_Sam_Att.ps1',
      'Deploy_Sam_Att.ps1',
      'HealthCheck_Sam_Att.ps1',
      'Backup_Sam_Att.ps1',
      'Rollback_Sam_Att.ps1',
      'Uninstall_Sam_Att.ps1',
    ];

    for (const relPath of psScripts) {
      const fullPath = path.resolve(process.cwd(), relPath);
      assert.equal(fs.existsSync(fullPath), true, `Required script ${relPath} must exist`);
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.match(content, /^[\x00-\x7F]*$/, `${relPath} must be 100% 7-bit ASCII for Windows PowerShell 5.1`);

      const codeLines = content
        .replace(/<#[\s\S]*?#>/g, '')
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('#') && !l.trim().startsWith('REM'))
        .join('\n');

      assert.ok(!/taskkill\s+\/F\s+\/IM\s+node\.exe/i.test(codeLines), `${relPath} must never kill all node.exe processes`);
      assert.ok(!/Stop-Process\s+-Name\s+node/i.test(codeLines), `${relPath} must never Stop-Process -Name node`);
      assert.ok(!/\biisreset\b/i.test(codeLines), `${relPath} must never run iisreset`);
      assert.ok(!/\bRestart-Computer\b/i.test(codeLines), `${relPath} must never restart the Windows Server`);
    }

    const winswXml = fs.readFileSync(path.resolve(process.cwd(), 'scripts/winsw-sam-att.xml'), 'utf8');
    assert.ok(winswXml.includes('<id>SamAttV2Standalone</id>'));
    assert.ok(winswXml.includes('<workingdirectory>D:\\WebApps\\Sam_Att\\App</workingdirectory>'));
    assert.ok(winswXml.includes('D:\\WebApps\\Sam_Att\\Config\\.env'));
    assert.ok(winswXml.includes('D:\\WebApps\\Sam_Att\\Certs\\server.crt'));
    assert.ok(winswXml.includes('D:\\WebApps\\Sam_Att\\Logs'));
    assert.ok(winswXml.includes('<env name="SCANNER_AUTO_SCHEDULER_ENABLED" value="false" />'));
  });
});
