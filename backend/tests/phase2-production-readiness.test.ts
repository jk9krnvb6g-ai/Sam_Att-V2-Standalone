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
import { acquireDeployLock, releaseDeployLock } from '../src/modules/deployment/jobStore.ts';

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
      'scripts/LifecycleLock.ps1',
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

    // FIX 05: Backup & Rollback SHA-256 manifest and shared Atomic Lifecycle Lock
    const backupContent = fs.readFileSync(path.resolve(process.cwd(), 'Backup_Sam_Att.ps1'), 'utf8');
    const rollbackContent = fs.readFileSync(path.resolve(process.cwd(), 'Rollback_Sam_Att.ps1'), 'utf8');
    const lockEngineContent = fs.readFileSync(path.resolve(process.cwd(), 'scripts/LifecycleLock.ps1'), 'utf8');
    assert.ok(backupContent.includes('last_known_good.json'), 'Backup_Sam_Att.ps1 must record last_known_good.json');
    assert.ok(backupContent.includes('Acquire-AtomicLifecycleLock'), 'Backup_Sam_Att.ps1 must use shared Acquire-AtomicLifecycleLock');
    assert.ok(rollbackContent.includes('Test-SnapshotIntegrityBeforeStop'), 'Rollback_Sam_Att.ps1 must verify snapshot SHA-256 manifest before stopping service');
    assert.ok(rollbackContent.includes('SNAPSHOT_FILE_HASH_MISMATCH'), 'Rollback_Sam_Att.ps1 must reject mismatched file hashes before stopping service');
    assert.ok(rollbackContent.includes('Acquire-AtomicLifecycleLock'), 'Rollback_Sam_Att.ps1 must use shared Acquire-AtomicLifecycleLock');
    assert.ok(lockEngineContent.includes('[System.IO.FileMode]::CreateNew'), 'scripts/LifecycleLock.ps1 must use atomic [System.IO.FileMode]::CreateNew');

    // FIX 08: Windows CI Runner in .github/workflows/ci.yml
    const ciYml = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    assert.ok(ciYml.includes('runs-on: windows-latest'), 'ci.yml must include a windows-latest runner job');
    assert.ok(ciYml.includes('System.Management.Automation.Language.Parser'), 'ci.yml must parse all PowerShell scripts via PowerShell AST parser on Windows');
  });

  await t.test('8. FINAL SAFETY PATCH FIX 01: Absolute Production Database Startup Safety (Fail-Closed on SAM_ATT_AUTO_MIGRATE=true)', async () => {
    const baseCfg = loadConfig();
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAutoMigrate = process.env.SAM_ATT_AUTO_MIGRATE;

    try {
      process.env.NODE_ENV = 'production';
      process.env.SAM_ATT_AUTO_MIGRATE = 'true';

      // 1. validateProductionConfig must fail closed with PRODUCTION_AUTO_MIGRATE_FORBIDDEN
      assert.throws(
        () =>
          validateProductionConfig({
            ...baseCfg,
            nodeEnv: 'production',
            dataMode: 'REAL',
            dbEngine: 'mysql',
            tlsCertPath: CERT_PATH,
            tlsKeyPath: KEY_PATH,
            samAttDb: {
              ...baseCfg.samAttDb,
              host: '10.1.0.201',
              user: 'sam_att_app',
              password: 'StrongProdDbPassword123!',
            },
          }),
        (err: unknown) =>
          err instanceof ProductionConfigError &&
          err.violations.some((v) => v.includes('PRODUCTION_AUTO_MIGRATE_FORBIDDEN')),
        'validateProductionConfig must throw PRODUCTION_AUTO_MIGRATE_FORBIDDEN when NODE_ENV=production and SAM_ATT_AUTO_MIGRATE=true'
      );

      // 2. runMigrations() must fail closed with PRODUCTION_AUTO_MIGRATE_FORBIDDEN
      await assert.rejects(
        async () => {
          await runMigrations();
        },
        /PRODUCTION_AUTO_MIGRATE_FORBIDDEN/,
        'runMigrations must fail closed when NODE_ENV=production and SAM_ATT_AUTO_MIGRATE=true'
      );

      // 3. ensureBaselineSystemCatalog() must fail closed with PRODUCTION_AUTO_MIGRATE_FORBIDDEN
      await assert.rejects(
        async () => {
          await ensureBaselineSystemCatalog();
        },
        /PRODUCTION_AUTO_MIGRATE_FORBIDDEN/,
        'ensureBaselineSystemCatalog must fail closed when NODE_ENV=production and SAM_ATT_AUTO_MIGRATE=true'
      );
    } finally {
      process.env.NODE_ENV = prevNodeEnv;
      if (prevAutoMigrate === undefined) {
        delete process.env.SAM_ATT_AUTO_MIGRATE;
      } else {
        process.env.SAM_ATT_AUTO_MIGRATE = prevAutoMigrate;
      }
    }
  });

  await t.test('9. FINAL SAFETY PATCH FIX 02 & TASK 3: Atomic Lifecycle Lock Concurrency, Stale Lock Recovery, PID+StartTime Verification, Corrupt Lock Guard & Ownership Protection', async () => {
    // 1. Verify all 5 lifecycle scripts + deployment/Deploy_Sam_Att.ps1 use the unified atomic lock mechanism
    const rootLifecycleScripts = [
      'Install_Sam_Att.ps1',
      'Deploy_Sam_Att.ps1',
      'Backup_Sam_Att.ps1',
      'Rollback_Sam_Att.ps1',
      'Uninstall_Sam_Att.ps1',
    ];
    for (const scriptName of rootLifecycleScripts) {
      const content = fs.readFileSync(path.resolve(process.cwd(), scriptName), 'utf8');
      assert.ok(
        content.includes('LifecycleLock.ps1') &&
          content.includes('Acquire-AtomicLifecycleLock') &&
          content.includes('Release-AtomicLifecycleLock'),
        `${scriptName} must use scripts/LifecycleLock.ps1 (Acquire-AtomicLifecycleLock / Release-AtomicLifecycleLock)`
      );
    }

    const lockPsContent = fs.readFileSync(path.resolve(process.cwd(), 'scripts/LifecycleLock.ps1'), 'utf8');
    assert.ok(
      lockPsContent.includes('[System.IO.FileMode]::CreateNew') &&
        lockPsContent.includes('Test-LockOwnerProcessAlive') &&
        lockPsContent.includes('ownerStartTimeUtc') &&
        lockPsContent.includes('[System.IO.File]::Move($Path, $staleTrash)') &&
        lockPsContent.includes('PARTIAL_OR_CORRUPT'),
      'scripts/LifecycleLock.ps1 must enforce FileMode.CreateNew, PID + StartTime verification, partial/corrupt lock guard, and atomic rename-to-trash stale lock recovery'
    );

    const innerDeployContent = fs.readFileSync(path.resolve(process.cwd(), 'deployment/Deploy_Sam_Att.ps1'), 'utf8');
    assert.ok(
      innerDeployContent.includes('[System.IO.FileMode]::CreateNew'),
      'deployment/Deploy_Sam_Att.ps1 must use atomic [System.IO.FileMode]::CreateNew for its deploy_active.lock'
    );

    // 2. Real Concurrency Test against atomic file lock engine (O_CREAT | O_EXCL / FileMode.CreateNew semantics)
    const tmpLockFile = path.join(TMP_CERT_DIR, `atomic_concurrency_${Date.now()}.lock`);
    const prevLockEnv = process.env.SAM_ATT_DEPLOY_LOCK_FILE;
    try {
      process.env.SAM_ATT_DEPLOY_LOCK_FILE = tmpLockFile;

      // (A) Concurrent Acquisition: Launch 8 concurrent contenders trying to acquire the same lock file simultaneously
      const contenders = Array.from({ length: 8 }, (_, idx) =>
        Promise.resolve().then(() =>
          acquireDeployLock({
            jobId: `concurrent_job_${idx + 1}`,
            pid: process.pid,
            actorUsername: `admin_${idx + 1}`,
          })
        )
      );
      const results = await Promise.all(contenders);
      const winners = results.filter((r) => r.acquired === true);
      const losers = results.filter((r) => r.acquired === false);

      assert.equal(winners.length, 1, 'Exactly ONE concurrent lifecycle operation may acquire the atomic lock');
      assert.equal(losers.length, 7, 'All other 7 concurrent contenders must be rejected');

      const winningJobId = winners[0].jobId!;

      // (B) ParentLockId / InheritedJobId Validation
      const childReuse = acquireDeployLock({
        jobId: 'child_sub_operation',
        pid: process.pid,
        actorUsername: 'admin',
        inheritedJobId: winningJobId,
      });
      assert.equal(childReuse.acquired, true, 'Child operation with matching inheritedJobId must succeed');
      assert.equal(childReuse.jobId, winningJobId, 'Underlying lock file must retain parent jobId ownership');

      const badParentReuse = acquireDeployLock({
        jobId: 'child_wrong_parent',
        pid: process.pid,
        actorUsername: 'admin',
        inheritedJobId: 'wrong_parent_job_id',
      });
      assert.equal(badParentReuse.acquired, false, 'Child operation with non-matching inheritedJobId must fail closed');

      // (C) Unauthorized Release Protection: non-owner jobId or wrong PID cannot release the lock
      const wrongJobRelease = releaseDeployLock('non_owner_job_id', process.pid);
      assert.equal(wrongJobRelease, false, 'Non-owner jobId must not release the atomic lock');
      assert.equal(fs.existsSync(tmpLockFile), true);

      const wrongPidRelease = releaseDeployLock(winningJobId, process.pid + 99999);
      assert.equal(wrongPidRelease, false, 'Non-owner PID must not release the atomic lock');
      assert.equal(fs.existsSync(tmpLockFile), true);

      // True owner (matching jobId + matching PID) releases the lock cleanly
      const ownerReleased = releaseDeployLock(winningJobId, process.pid);
      assert.equal(ownerReleased, true, 'True lock owner must release the lock file');
      assert.equal(fs.existsSync(tmpLockFile), false, 'Lock file must be removed after owner release');

      // (D) Safe Stale Lock Recovery Under Contention: dead PID lock is recovered by exactly ONE contender without deleting the winner's new lock
      fs.writeFileSync(
        tmpLockFile,
        JSON.stringify({
          jobId: 'crashed_dead_job_999',
          pid: 999999,
          actorUsername: 'admin',
          startedAt: new Date(Date.now() - 60_000).toISOString(),
        }),
        'utf8'
      );

      const recoveryContenders = Array.from({ length: 6 }, (_, idx) =>
        Promise.resolve().then(() =>
          acquireDeployLock({
            jobId: `recovery_contender_${idx + 1}`,
            pid: process.pid,
            actorUsername: 'admin',
          })
        )
      );
      const recoveryResults = await Promise.all(recoveryContenders);
      const recoveryWinners = recoveryResults.filter((r) => r.acquired === true);
      assert.equal(recoveryWinners.length, 1, 'Exactly ONE contender may win stale lock recovery');
      assert.equal(fs.existsSync(tmpLockFile), true, 'New lock created by recovery winner must remain intact on disk');
      const onDiskAfterRecovery = JSON.parse(fs.readFileSync(tmpLockFile, 'utf8'));
      assert.equal(onDiskAfterRecovery.jobId, recoveryWinners[0].jobId);
      releaseDeployLock(recoveryWinners[0].jobId!, process.pid);

      // (E) Partial / Corrupt Lock File Guard: freshly created partial file (<5000ms old) must NOT be deleted
      fs.writeFileSync(tmpLockFile, '{partial_corrupt_json', 'utf8');
      const blockedByFreshPartial = acquireDeployLock({
        jobId: 'contender_during_partial_write',
        pid: process.pid,
        actorUsername: 'admin',
      });
      assert.equal(blockedByFreshPartial.acquired, false, 'Fresh partial/corrupt lock file (<5000ms) must not be deleted');
      assert.equal(fs.existsSync(tmpLockFile), true);
    } finally {
      if (prevLockEnv === undefined) {
        delete process.env.SAM_ATT_DEPLOY_LOCK_FILE;
      } else {
        process.env.SAM_ATT_DEPLOY_LOCK_FILE = prevLockEnv;
      }
      try {
        fs.rmSync(tmpLockFile, { force: true });
      } catch {
        // ignore
      }
    }
  });

  await t.test('10. FINAL SAFETY PATCH FIX 03 & FIX 04: Selected Node.js Runtime Binding & Fresh Installation Isolated Test Gate', () => {
    const installerContent = fs.readFileSync(path.resolve(process.cwd(), 'Install_Sam_Att.ps1'), 'utf8');
    const preflightContent = fs.readFileSync(path.resolve(process.cwd(), 'Preflight_Sam_Att.ps1'), 'utf8');
    const ciYml = fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');

    // FIX 03: Selected NodeExecutablePath binding & Windows CI matrix for Node 22.x and 26.x
    assert.ok(
      installerContent.includes('$resolvedNodeDir = Split-Path -Parent $resolvedNodeExe') &&
        installerContent.includes('--scripts-prepend-node-path=true') &&
        installerContent.includes('& $resolvedNodeExe --import tsx backend/src/database/cli-preflight.ts'),
      'Install_Sam_Att.ps1 must bind npm and cli-preflight.ts to the selected $resolvedNodeExe'
    );
    assert.ok(
      preflightContent.includes('& $resolvedNodeExe --import tsx backend/src/database/cli-preflight.ts --json'),
      'Preflight_Sam_Att.ps1 must run cli-preflight.ts directly with $resolvedNodeExe'
    );
    assert.ok(
      ciYml.includes('node_spec: "22.x"') && ciYml.includes('node_spec: "26.x"'),
      '.github/workflows/ci.yml must include Windows matrix entries for Node.js 22.x and 26.x'
    );

    // FIX 04: Fresh Installation Test Gate (typecheck + lint + isolated npm test + build + read-only db:preflight)
    assert.ok(
      installerContent.includes('run lint --scripts-prepend-node-path=true') &&
        installerContent.includes('LINT_FAILED'),
      'Install_Sam_Att.ps1 Step 6 must execute npm run lint and check $LASTEXITCODE'
    );
    assert.ok(
      installerContent.includes('SAM_ATT_TEST_ISOLATION=true') &&
        installerContent.includes('SAM_ATT_DB_ENGINE=sqlite_sandbox') &&
        installerContent.includes('test --scripts-prepend-node-path=true') &&
        installerContent.includes('FRESH_INSTALL_TEST_GATE_FAILED'),
      'Install_Sam_Att.ps1 Step 6 must run isolated npm test (sqlite_sandbox in TEMP, disconnected from Production MySQL) during FreshInstall'
    );
  });

  await t.test('11. FINAL SAFETY PATCH FIX 05: ScannerReader Binary PE Header Architecture (x86 32-bit) & COM Export Verification', () => {
    const scannerDir = path.resolve(process.cwd(), 'ScannerReader');
    const expectedBinaries = [
      'ScannerSyncCli.exe',
      'ScannerSyncCli.dll',
      'FK623Attend.dll',
      'FKAttend.dll',
      'FKPwdEncDec.dll',
      'FKViaDev.dll',
      'LFWViaDev.dll',
      'FpDataConv.dll',
      'FaceDataConv.dll',
      'UniversalOfflineSDK.dll',
      'Interop.RealSvrOcxTcpLib.dll',
      'MySqlConnector.dll',
    ];

    for (const fileName of expectedBinaries) {
      const fullPath = path.join(scannerDir, fileName);
      assert.equal(fs.existsSync(fullPath), true, `ScannerReader/${fileName} must exist`);
      const buf = fs.readFileSync(fullPath);
      assert.equal(buf.toString('ascii', 0, 2), 'MZ', `${fileName} must have valid DOS MZ header`);
      const peOffset = buf.readUInt32LE(0x3c);
      assert.equal(buf.toString('ascii', peOffset, peOffset + 4), 'PE\0\0', `${fileName} must have valid PE signature`);
      const machine = buf.readUInt16LE(peOffset + 4);
      assert.equal(
        machine,
        0x014c,
        `${fileName} PE Machine Type must be 0x014c (IMAGE_FILE_MACHINE_I386 / 32-bit x86), got 0x${machine.toString(16)}`
      );
    }

    const depsJson = JSON.parse(fs.readFileSync(path.join(scannerDir, 'ScannerSyncCli.deps.json'), 'utf8'));
    assert.equal(
      depsJson.runtimeTarget?.name,
      '.NETCoreApp,Version=v10.0/win-x86',
      'ScannerSyncCli.deps.json must target .NETCoreApp,Version=v10.0/win-x86'
    );
  });
});
