/**
 * ============================================================================
 * ชุดทดสอบความพร้อมสำหรับการใช้งานจริงบน Windows Server 2025 (Phase 2 Production Readiness & Hotfix Test Suite)
 * ไฟล์: backend/tests/phase2-production-readiness.test.ts
 * ============================================================================
 * ครอบคลุมการตรวจสอบ:
 * 1. โครงสร้างโฟลเดอร์มาตรฐาน Drive D (D:\WebApps\Sam_Att, D:\Backups\Sam_Att, D:\Deployments\Sam_Att)
 * 2. การตรวจสอบคู่ใบรับรอง X.509 Certificate + Private Key (validateTlsCertificatePair) และ Fail-Closed Production Config
 * 3. การป้องกันการสร้าง Self-Signed Certificate อัตโนมัติในโหมด Production และการใส่ IP SAN 10.2.0.23
 * 4. โหมด Standby ของ Scanner Scheduler (SCANNER_AUTO_SCHEDULER_ENABLED=false) เพื่อป้องกันการซิงก์ซ้ำก่อน Cutover
 * 5. การตรวจสอบฐานข้อมูลแบบ Read-Only 100% (runProductionDatabasePreflightReadOnly, runMigrations & ensureBaselineSystemCatalog)
 * 6. จุดตรวจสอบสถานะระบบ /api/Sam_Att/health, /api/Sam_Att/health/live, /api/Sam_Att/health/ready และการแยก API 404 JSON
 * 7. ระบบบันทึกข้อมูลลงไฟล์พร้อมหมุนเวียนไฟล์อัตโนมัติและการปกปิดข้อมูลความลับ (Structured Logger & Secret Redaction)
 * 8. การตรวจสอบ Hotfix FIX 01 – FIX 08:
 *    - FIX 01: Strict HTTPS Health Check (ไม่มี SkipCertificateCheck / ServerCertificateValidationCallback={$true} / rejectUnauthorized:false)
 *    - FIX 02: Scoped Firewall (ยกเลิก Default กว้าง LocalSubnet,10.0.0.0/8,192.168.0.0/16 และเปิดเฉพาะ TCP 4101)
 *    - FIX 03: Strict Windows Service Health Check (ตรวจ Service Running, Port 4101 PID Tree Ownership, Version & Commit)
 *    - FIX 04: Runtime Compatibility (Node.js >=22.0.0 <27.0.0 รองรับ Node 22 และ Node 26.13.1, .NET 10.0 win-x86 ScannerSyncCli)
 *    - FIX 05: Backup & Rollback SHA-256 File Manifest, Pre-Stop Integrity Check, last_known_good.json, Shared Lifecycle Lock
 *    - FIX 06: Zero DDL/DML on Production Startup, Lossless .env Password Quoting/Parsing (#, $, &, quotes, spaces), NTFS icacls
 *    - FIX 07: Unified Deployment Engine, FreshInstall Overwrite Protection, Windows ExcludedPortRange Check, -DryRun/-WhatIf
 *    - FIX 08: Windows CI Runner Job (windows-latest) in .github/workflows/ci.yml
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import https from 'https';

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
  formatEnvFileValue,
  parseDotEnvContentLossless,
  reloadEnvConfig,
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
  dbQuery,
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
        ca: fs.readFileSync(CERT_PATH),
        rejectUnauthorized: true,
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

test('Phase 2 Production Readiness & Hotfix Verification Suite (FIX 01 - FIX 08)', async (t) => {
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
    const pairCheck = validateTlsCertificatePair(CERT_PATH, KEY_PATH);
    assert.equal(pairCheck.valid, true);
    assert.equal(pairCheck.errors.length, 0);
    assert.ok(pairCheck.subjectAltName?.includes('10.2.0.23'), 'Generated certificate must include IP SAN 10.2.0.23');

    const otherPair = generateSelfSignedX509CertAndKey('other-host');
    const mismatchedKeyPath = path.join(TMP_CERT_DIR, 'mismatched.key');
    fs.writeFileSync(mismatchedKeyPath, otherPair.keyPem, 'utf8');
    const mismatchResult = validateTlsCertificatePair(CERT_PATH, mismatchedKeyPath);
    assert.equal(mismatchResult.valid, false);
    assert.ok(mismatchResult.errors.some((e) => e.includes('TLS_KEY_MISMATCH')));

    const missingProdCert = path.join(TMP_CERT_DIR, 'prod_missing.crt');
    const missingProdKey = path.join(TMP_CERT_DIR, 'prod_missing.key');
    ensureTlsCertificates(missingProdCert, missingProdKey, 'production');
    assert.equal(fs.existsSync(missingProdCert), false, 'Production startup must not auto-generate self-signed cert');
    assert.equal(fs.existsSync(missingProdKey), false, 'Production startup must not auto-generate self-signed key');

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

  await t.test('3. Read-Only Production Database Preflight & Zero-Mutation Startup Guard (FIX 06)', async () => {
    const report = await runProductionDatabasePreflightReadOnly();
    assert.equal(report.ok, true, `Expected DB preflight ok, got errors: ${report.errors.join('; ')}`);
    assert.equal(report.readOnlyMode, true);
    assert.equal(report.missingTables.length, 0);
    assert.equal(report.missingColumns.length, 0);
    assert.ok(report.existingTablesCount >= 16);

    // Verify ensureBaselineSystemCatalog is a strict no-op when NODE_ENV=production even if called without startupReadOnlyOnMysql
    // (Wait to query SQLite before/after NODE_ENV=production because SQLite fallback is strictly forbidden while NODE_ENV=production!)
    const beforeRules = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM personnel_type_rules');
    const prevNodeEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      await ensureBaselineSystemCatalog();
      await assert.rejects(
        async () => {
          await dbQuery('SELECT 1');
        },
        /เกิดข้อผิดพลาดในการประมวลผลคำสั่งฐานข้อมูล|ไม่สามารถเชื่อมต่อฐานข้อมูลหลัก|REAL_MODE_SQLITE_FALLBACK_FORBIDDEN/i,
        'SQLite fallback must be strictly forbidden when NODE_ENV=production'
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
    }
    const afterRules = await dbQuery<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM personnel_type_rules');
    assert.equal(beforeRules[0].cnt, afterRules[0].cnt, 'ensureBaselineSystemCatalog must not mutate DB in production startup');
  });

  await t.test('4. Lossless .env Password Quoting & Parsing for Special Characters (#, $, &, quotes, spaces — FIX 06)', () => {
    const complexPasswords = [
      'Samchuk#Prod$2026&Db!Pass',
      'P@ssw0rd With Spaces #Hash $Dollar &Ampersand',
      'Quote"Inside\'And\\Backslash#End',
      'SimpleAlphaNumeric12345',
    ];

    for (const pwd of complexPasswords) {
      const formatted = formatEnvFileValue(pwd);
      const envText = [
        '# Production .env test',
        'NODE_ENV=production',
        `SAM_ATT_DB_PASSWORD=${formatted}`,
        `HOSOFFICE_DB_PASSWORD=${formatted}`,
      ].join('\r\n');

      const parsed = parseDotEnvContentLossless(envText);
      assert.equal(parsed.SAM_ATT_DB_PASSWORD, pwd, `Password '${pwd}' must survive formatEnvFileValue + parseDotEnvContentLossless losslessly`);
      assert.equal(parsed.HOSOFFICE_DB_PASSWORD, pwd);
    }

    // Also test reloadEnvConfig with temporary .env file containing #, $, &
    const tmpEnvFile = path.join(TMP_CERT_DIR, '.env.special-test');
    const rawUnquotedAndQuoted = [
      'SAM_ATT_DB_USER=sam_att_app',
      'SAM_ATT_DB_PASSWORD="Hospital#Secret$2026&Key With Spaces"',
      'HOSOFFICE_DB_PASSWORD=Unquoted#Hash$Dollar&Amp',
    ].join('\r\n');
    fs.writeFileSync(tmpEnvFile, rawUnquotedAndQuoted, 'utf8');

    const prevEnvPath = process.env.SAM_ATT_ENV_PATH;
    const prevDbPwd = process.env.SAM_ATT_DB_PASSWORD;
    const prevHosPwd = process.env.HOSOFFICE_DB_PASSWORD;
    try {
      process.env.SAM_ATT_ENV_PATH = tmpEnvFile;
      reloadEnvConfig({ override: true });
      assert.equal(process.env.SAM_ATT_DB_PASSWORD, 'Hospital#Secret$2026&Key With Spaces');
      assert.equal(process.env.HOSOFFICE_DB_PASSWORD, 'Unquoted#Hash$Dollar&Amp');
    } finally {
      if (prevEnvPath === undefined) delete process.env.SAM_ATT_ENV_PATH;
      else process.env.SAM_ATT_ENV_PATH = prevEnvPath;
      if (prevDbPwd === undefined) delete process.env.SAM_ATT_DB_PASSWORD;
      else process.env.SAM_ATT_DB_PASSWORD = prevDbPwd;
      if (prevHosPwd === undefined) delete process.env.HOSOFFICE_DB_PASSWORD;
      else process.env.HOSOFFICE_DB_PASSWORD = prevHosPwd;
    }
  });

  await t.test('5. Health Check Endpoints (/health, /health/live, /health/ready) with Strict TLS Client Verification', async () => {
    const liveRes = await requestJson('/api/Sam_Att/health/live');
    assert.equal(liveRes.status, 200);
    assert.equal(liveRes.data.status, 'OK');
    assert.equal(liveRes.data.liveness, 'ALIVE');
    assert.equal(liveRes.data.applicationName, 'Sam_Att V2 Standalone');

    const readyRes = await requestJson('/api/Sam_Att/health/ready');
    assert.equal(readyRes.status, 200);
    assert.equal(readyRes.data.status, 'OK');
    assert.equal(readyRes.data.readiness, 'READY');
    assert.equal(readyRes.data.database.connected, true);
    assert.equal(readyRes.data.database.readOnlyStartupEnforced, true);

    const mainHealthRes = await requestJson('/api/Sam_Att/health');
    assert.equal(mainHealthRes.status, 200);
    assert.equal(mainHealthRes.data.status, 'OK');

    const unknownApiRes = await requestJson('/api/Sam_Att/non-existent-phase2-route');
    assert.equal(unknownApiRes.status, 404);
    assert.equal(unknownApiRes.data.error, 'API_ENDPOINT_NOT_FOUND');
  });

  await t.test('6. Structured File Logger enforces secret redaction and size-based log rotation', () => {
    const rawSecretText =
      'Connecting with SAM_ATT_DB_PASSWORD=SuperSecretHospitalPwd999! and Bearer eyJhbGciOiJIUzI1NiJ9.secret and ghp_1234567890abcdefghijklmnopqrstuvwx';
    const redacted = redactSecretsFromText(rawSecretText);
    assert.ok(!redacted.includes('SuperSecretHospitalPwd999!'));
    assert.ok(!redacted.includes('eyJhbGciOiJIUzI1NiJ9.secret'));
    assert.ok(!redacted.includes('ghp_1234567890abcdefghijklmnopqrstuvwx'));
    assert.ok(redacted.includes('***REDACTED***'));

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
    assert.equal(fs.existsSync(appLogFile), true);
    assert.equal(fs.existsSync(rotatedLogFile), true);
    const logContent = fs.readFileSync(appLogFile, 'utf8') + fs.readFileSync(rotatedLogFile, 'utf8');
    assert.ok(!logContent.includes('HiddenPassword12345'));
  });

  await t.test('7. Hotfix Audit: FIX 01, FIX 02, FIX 03, FIX 04, FIX 05, FIX 07, FIX 08 Static & Structural Verification', () => {
    const allPsScripts = [
      'Install_Sam_Att.bat',
      'Install_Sam_Att.ps1',
      'Preflight_Sam_Att.ps1',
      'Deploy_Sam_Att.ps1',
      'HealthCheck_Sam_Att.ps1',
      'Backup_Sam_Att.ps1',
      'Rollback_Sam_Att.ps1',
      'Uninstall_Sam_Att.ps1',
      'deployment/Deploy_Sam_Att.ps1',
      'scripts/health-check.ps1',
      'scripts/install-windows.ps1',
      'scripts/backup.ps1',
      'scripts/deploy-test.ps1',
      'scripts/restore-test.ps1',
    ];

    for (const relPath of allPsScripts) {
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
      assert.ok(!/Stop-Process\s+-Name\s+node\b/i.test(codeLines), `${relPath} must never Stop-Process -Name node`);
      assert.ok(!/\biisreset\b/i.test(codeLines), `${relPath} must never run iisreset`);
      assert.ok(!/\bRestart-Computer\b/i.test(codeLines), `${relPath} must never restart the Windows Server`);
    }

    // FIX 01: HealthCheck_Sam_Att.ps1, scripts/health-check.ps1, and deployment/Deploy_Sam_Att.ps1 must have zero TLS cert validation bypasses
    for (const hcRel of ['HealthCheck_Sam_Att.ps1', 'scripts/health-check.ps1', 'deployment/Deploy_Sam_Att.ps1']) {
      const hcContent = fs.readFileSync(path.resolve(process.cwd(), hcRel), 'utf8');
      const hcCode = hcContent
        .replace(/<#[\s\S]*?#>/g, '')
        .split(/\r?\n/)
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
      assert.ok(!/SkipCertificateCheck/i.test(hcCode), `${hcRel} must not use -SkipCertificateCheck`);
      assert.ok(!/ServerCertificateValidationCallback\s*=\s*\{\s*\$true\s*\}/i.test(hcCode), `${hcRel} must not bypass ServerCertificateValidationCallback`);
      assert.ok(!/rejectUnauthorized\s*:\s*false/i.test(hcCode), `${hcRel} must not use rejectUnauthorized: false`);
      assert.ok(!/NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/i.test(hcCode), `${hcRel} must not set NODE_TLS_REJECT_UNAUTHORIZED=0`);
    }

    const rootHc = fs.readFileSync(path.resolve(process.cwd(), 'HealthCheck_Sam_Att.ps1'), 'utf8');
    assert.ok(rootHc.includes('[string]$HostName = "10.2.0.23"'), 'HealthCheck_Sam_Att.ps1 must default HostName to 10.2.0.23');
    assert.ok(rootHc.includes('SKIP_SERVICE_CHECK_FORBIDDEN_IN_PRODUCTION'), 'HealthCheck_Sam_Att.ps1 must forbid SkipServiceCheck without DiagnosticMode');
    assert.ok(rootHc.includes('Test-ProcessBelongsToServiceTree'), 'HealthCheck_Sam_Att.ps1 must verify port 4101 is owned by SamAttV2Standalone process tree');
    assert.ok(rootHc.includes('VERSION_MISMATCH') && rootHc.includes('COMMIT_MISMATCH'), 'HealthCheck_Sam_Att.ps1 must verify version and commit');

    // FIX 02 & FIX 06 & FIX 07: Install_Sam_Att.ps1 checks
    const installerContent = fs.readFileSync(path.resolve(process.cwd(), 'Install_Sam_Att.ps1'), 'utf8');
    assert.ok(!installerContent.includes('LocalSubnet,10.0.0.0/8,192.168.0.0/16'), 'Install_Sam_Att.ps1 must not contain overly broad default FirewallRemoteAddress');
    assert.ok(installerContent.includes('[string]$FirewallRemoteAddress = ""'), 'Install_Sam_Att.ps1 must default FirewallRemoteAddress to empty string');
    assert.ok(installerContent.includes('MISSING_FIREWALL_SCOPE'), 'Install_Sam_Att.ps1 must fail closed if FirewallRemoteAddress is omitted in NonInteractive mode');
    assert.ok(installerContent.includes('EXISTING_INSTALLATION_DETECTED'), 'Install_Sam_Att.ps1 must prevent FreshInstall from overwriting an existing installation');
    assert.ok(installerContent.includes('DATABASE_TARGET_CONFIRMATION_REQUIRED'), 'Install_Sam_Att.ps1 must require explicit database target confirmation');
    assert.ok(installerContent.includes('Set-RestrictedFileAcl'), 'Install_Sam_Att.ps1 must restrict NTFS ACLs on Config/.env and Certs/server.key');

    // FIX 04: package.json engines.node and ScannerSyncCli.runtimeconfig.json verification
    const pkgJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
    assert.equal(pkgJson.engines?.node, '>=22.0.0 <27.0.0', 'package.json must declare engines.node >=22.0.0 <27.0.0 (covering Node 22 & Node 26.13.1)');

    const scannerRuntimeCfg = JSON.parse(
      fs.readFileSync(path.resolve(process.cwd(), 'ScannerReader/ScannerSyncCli.runtimeconfig.json'), 'utf8')
    );
    assert.equal(scannerRuntimeCfg.runtimeOptions?.tfm, 'net10.0');
    assert.equal(scannerRuntimeCfg.runtimeOptions?.framework?.name, 'Microsoft.NETCore.App');
    assert.equal(scannerRuntimeCfg.runtimeOptions?.framework?.version, '10.0.0');

    // FIX 05: Backup & Rollback SHA-256 manifest and shared lifecycle lock
    const backupContent = fs.readFileSync(path.resolve(process.cwd(), 'Backup_Sam_Att.ps1'), 'utf8');
    const rollbackContent = fs.readFileSync(path.resolve(process.cwd(), 'Rollback_Sam_Att.ps1'), 'utf8');
    assert.ok(backupContent.includes('last_known_good.json'), 'Backup_Sam_Att.ps1 must record last_known_good.json');
    assert.ok(backupContent.includes('lifecycle.lock'), 'Backup_Sam_Att.ps1 must use shared lifecycle.lock');
    assert.ok(rollbackContent.includes('Test-SnapshotIntegrityBeforeStop'), 'Rollback_Sam_Att.ps1 must verify snapshot SHA-256 manifest before stopping service');
    assert.ok(rollbackContent.includes('SNAPSHOT_FILE_HASH_MISMATCH'), 'Rollback_Sam_Att.ps1 must reject mismatched file hashes before stopping service');
    assert.ok(rollbackContent.includes('lifecycle.lock'), 'Rollback_Sam_Att.ps1 must use shared lifecycle.lock');

    // FIX 08: Windows CI Runner in .github/workflows/ci.yml
    const ciYml = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ciYml.includes('runs-on: windows-latest'), 'ci.yml must include a windows-latest runner job');
    assert.ok(ciYml.includes('System.Management.Automation.Language.Parser'), 'ci.yml must parse all PowerShell scripts via PowerShell AST parser on Windows');
  });
});
