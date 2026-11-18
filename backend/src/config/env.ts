/**
 * ============================================================================
 * โมดูลจัดการค่าตัวแปรสภาพแวดล้อมและการตรวจสอบความพร้อมก่อนเปิดระบบ (Environment & Fail-Closed Config Validator)
 * ไฟล์: backend/src/config/env.ts
 * ============================================================================
 * หน้าที่หลัก:
 * - อ่านค่าตัวแปรจากไฟล์ .env หรือ Environment Variables ของระบบปฏิบัติการ
 * - ยกเลิกการใช้ค่าคงที่ (Hardcoded Static Secrets) สำหรับ JWT_SECRET และ SCANNER_INGEST_SHARED_TOKEN (แก้ไข P0 ข้อ 03–04)
 * - ในโหมดพัฒนา/ทดสอบ (development/test) หากไม่ได้ตั้งค่า Secret จะสุ่มด้วย CSPRNG เฉพาะรอบการรันนั้น (Ephemeral Random Secret)
 * - ในโหมดใช้งานจริง (NODE_ENV=production) ฟังก์ชัน validateProductionConfig() จะตรวจสอบความพร้อมของ
 *   Environment Variables, TLS Certificate นอก Repository, รหัสผ่านฐานข้อมูล, Port และความแข็งแกร่งของ Secret
 *   หากไม่ผ่านแม้แต่ข้อเดียวจะหยุดการทำงานทันทีแบบ Fail-Closed ก่อนเปิดพอร์ตให้บริการ (แก้ไข P1 ข้อ 15)
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import dotenv from 'dotenv';
import { generateCryptographicSecret } from '../utils/crypto.ts';

export function isAutomatedTestRuntime(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.SAM_ATT_TEST_ISOLATION === 'true' ||
    process.execArgv.includes('--test') ||
    process.argv.some((arg) => arg.endsWith('.test.ts'))
  );
}

// ห้ามโหลดไฟล์ .env ของ Production เข้าสู่โปรเซส Automated Test เด็ดขาด เพื่อป้องกันการเชื่อมต่อฐานข้อมูลจริง (10.1.0.201 / HOSOffice)
if (!isAutomatedTestRuntime()) {
  dotenv.config();
} else if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'test';
}

export type DbEngineMode = 'mysql' | 'sqlite_sandbox';
export type DataMode = 'REAL' | 'DEMO';

export interface AppConfig {
  nodeEnv: string;
  dataMode: DataMode;
  host: string;
  port: number;
  previewHttpPort: number;
  publicBasePath: string;
  apiBasePath: string;
  tlsCertPath: string;
  tlsKeyPath: string;
  dbEngine: DbEngineMode;
  samAttDb: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    sqlitePath: string;
  };
  hosofficeDb: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    hrPersonTable: string;
    pushWriteUser: string;
    pushWritePassword: string;
  };
  auth: {
    jwtSecret: string;
    jwtSecretExplicitlyConfigured: boolean;
    sessionTtlMinutes: number;
    rateLimitWindowMinutes: number;
    rateLimitMaxAttempts: number;
  };
  scanner: {
    syncEnabled: boolean;
    autoSchedulerEnabled: boolean;
    readerExePath: string;
    timeoutMs: number;
    syncDays: number;
    previewMode: boolean;
    mysqlConnectionString: string;
    ingestSharedToken: string;
    ingestTokenExplicitlyConfigured: boolean;
  };
  hosofficePush: {
    livePushEnabled: boolean;
    targetTable: string;
  };
}

export class ProductionConfigError extends Error {
  public readonly code = 'FAIL_CLOSED_CONFIG_INVALID';
  public readonly violations: string[];
  constructor(violations: string[]) {
    super(`Production Configuration Validation Failed (Fail-Closed): ${violations.join(' | ')}`);
    this.name = 'ProductionConfigError';
    this.violations = violations;
  }
}

export class TestIsolationViolationError extends Error {
  public readonly code = 'TEST_ISOLATION_VIOLATION';
  public readonly violations: string[];
  constructor(violations: string[]) {
    super(`Test Isolation Fail-Closed Guard Triggered: ${violations.join(' | ')}`);
    this.name = 'TestIsolationViolationError';
    this.violations = violations;
  }
}

/**
 * ตรวจสอบยืนยันว่า Automated Tests แยกขาดจากฐานข้อมูล Production (10.1.0.201 / samchuk_attendance_v2) อย่างสมบูรณ์
 * หากไม่สามารถยืนยันการแยกฐานข้อมูลได้ จะหยุดทำงานแบบ Fail-Closed ทันทีก่อนมีการเขียนข้อมูล
 */
export function assertTestEnvironmentIsolated(cfg: AppConfig = loadConfig()): void {
  const violations: string[] = [];
  if (cfg.nodeEnv !== 'test') {
    violations.push(`EXPECTED_NODE_ENV_TEST: found NODE_ENV='${cfg.nodeEnv}'`);
  }
  if (cfg.dbEngine !== 'sqlite_sandbox') {
    violations.push(`FORBIDDEN_TEST_DB_ENGINE: Automated tests must use 'sqlite_sandbox', found '${cfg.dbEngine}'`);
  }
  if (cfg.samAttDb.host === '10.1.0.201') {
    violations.push('FORBIDDEN_PRODUCTION_DB_HOST: Automated tests must never target production MySQL host 10.1.0.201');
  }
  const normalizedTmp = path.resolve(os.tmpdir());
  const normalizedSqlite = path.resolve(cfg.samAttDb.sqlitePath);
  if (!normalizedSqlite.startsWith(normalizedTmp)) {
    violations.push(
      `UNSAFE_TEST_SQLITE_PATH: Test SQLite path (${normalizedSqlite}) must reside inside os.tmpdir() (${normalizedTmp})`
    );
  }
  if (violations.length > 0) {
    throw new TestIsolationViolationError(violations);
  }
}

// Ephemeral CSPRNG secrets for non-production runtime only (never static constants!)
const EPHEMERAL_DEV_JWT_SECRET = generateCryptographicSecret(48);
const EPHEMERAL_DEV_SCANNER_TOKEN = generateCryptographicSecret(32);

const INVALID_SECRET_PLACEHOLDERS = new Set([
  '',
  'CHANGE_ME',
  'GENERATE_SECURE_RANDOM_SECRET_AT_DEPLOY',
  'GENERATE_SCANNER_INGEST_SECRET_AT_DEPLOY',
  'sam-att-v2-standalone-dev-hmac-secret-change-in-prod-98f3a1c2',
  'sam-att-exe-ingest-token-v2',
]);

function isValidConfiguredSecret(val: string | undefined, minLength: number): boolean {
  if (!val) return false;
  const trimmed = val.trim();
  if (INVALID_SECRET_PLACEHOLDERS.has(trimmed)) return false;
  return trimmed.length >= minLength;
}

/**
 * โหลดค่าตั้งค่าระบบทั้งหมด
 */
export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';

  // ในโหมด Production บังคับใช้ MySQL จริงเท่านั้น
  const explicitEngine = process.env.SAM_ATT_DB_ENGINE as DbEngineMode | undefined;
  const dbEngine: DbEngineMode = explicitEngine
    ? explicitEngine
    : nodeEnv === 'production'
      ? 'mysql'
      : 'sqlite_sandbox';

  // กำหนดโหมดข้อมูล (SAM_ATT_DATA_MODE):
  // - หากระบุ SAM_ATT_DATA_MODE=REAL หรือ DEMO จะใช้ค่านั้น (แต่ถ้า NODE_ENV=production แล้วตั้ง DEMO จะถูกบล็อกแบบ Fail-Closed ใน validateProductionConfig)
  // - หากไม่ได้ระบุ: ถ้าใช้ MySQL หรืออยู่ในโหมด Production จะเป็น REAL เสมอ; ถ้าเป็น sqlite_sandbox ในโหมดพัฒนาจะเป็น DEMO
  const rawDataMode = process.env.SAM_ATT_DATA_MODE?.trim().toUpperCase();
  const dataMode: DataMode =
    rawDataMode === 'REAL' || rawDataMode === 'DEMO'
      ? (rawDataMode as DataMode)
      : nodeEnv === 'production' || dbEngine === 'mysql'
        ? 'REAL'
        : 'DEMO';

  const rawPort = process.env.SAM_ATT_HTTPS_PORT;
  const httpsPort = rawPort ? Number(rawPort) : 4101;

  const rawJwtSecret = process.env.JWT_SECRET?.trim();
  const jwtExplicit = isValidConfiguredSecret(rawJwtSecret, 32);

  const rawScannerToken = process.env.SCANNER_INGEST_SHARED_TOKEN?.trim();
  const scannerTokenExplicit = isValidConfiguredSecret(rawScannerToken, 24);

  // ในโหมด development/test ใช้ไฟล์แยกตามโหมดใน os.tmpdir() เพื่อไม่ให้ข้อมูล DEMO ปะปนกับฐานข้อมูลจริง
  const defaultSqlitePath = path.join(
    os.tmpdir(),
    dataMode === 'DEMO' ? 'sam_att_v2_demo_sandbox.sqlite' : 'sam_att_v2_real_runtime.sqlite'
  );

  // พาธใบรับรอง TLS: รองรับ C:\inetpub\wwwroot\Sam_Att\certs (ซึ่งอยู่ใน .gitignore ไม่ถูก Commit ขึ้น Git) หรือ C:\Sam_Att\certs
  const defaultCertDir =
    nodeEnv === 'production'
      ? fs.existsSync('C:\\inetpub\\wwwroot\\Sam_Att\\certs')
        ? 'C:\\inetpub\\wwwroot\\Sam_Att\\certs'
        : 'C:\\Sam_Att\\certs'
      : path.join(os.tmpdir(), 'sam_att_v2_dev_certs');

  const samAttHost = process.env.SAM_ATT_DB_HOST || '127.0.0.1';
  const samAttPort = Number(process.env.SAM_ATT_DB_PORT || 3306);
  const samAttDatabase = process.env.SAM_ATT_DB_NAME || 'samchuk_attendance_v2';
  const samAttUser = process.env.SAM_ATT_DB_USER || 'sam_att_app';
  const samAttPassword = process.env.SAM_ATT_DB_PASSWORD || 'CHANGE_ME';

  const hosHost = process.env.HOSOFFICE_DB_HOST || 'CHANGE_ME';
  const hosPort = Number(process.env.HOSOFFICE_DB_PORT || 3306);
  const hosDatabase = process.env.HOSOFFICE_DB_NAME || 'hosoffice';
  const hosUser = process.env.HOSOFFICE_DB_USER || 'hosoffice_readonly';
  const hosPassword = process.env.HOSOFFICE_DB_PASSWORD || 'CHANGE_ME';

  // ให้ ScannerSyncCli.exe เชื่อมต่อกับฐานข้อมูลหลักของ Sam_Att (samchuk_attendance_v2) เป็นค่าเริ่มต้น
  // เพื่อไม่ให้ไปเขียนทับฐานข้อมูล HOSOffice โดยตรง (เว้นแต่ตั้งค่า SCANNER_MYSQL_CONNECTION_STRING เอง)
  const fallbackScannerMysqlConn = `Server=${samAttHost};Port=${samAttPort};Database=${samAttDatabase};User ID=${samAttUser};Password=${samAttPassword};CharSet=utf8mb4;`;

  return {
    nodeEnv,
    dataMode,
    host: process.env.HOST || '0.0.0.0',
    port: httpsPort,
    previewHttpPort: Number(process.env.PREVIEW_HTTP_PORT || 3000),
    publicBasePath: process.env.PUBLIC_BASE_PATH || '/Sam_Att/',
    apiBasePath: process.env.API_BASE_PATH || '/api/Sam_Att',
    tlsCertPath: process.env.TLS_CERT_PATH
      ? path.resolve(process.cwd(), process.env.TLS_CERT_PATH)
      : path.join(defaultCertDir, 'server.crt'),
    tlsKeyPath: process.env.TLS_KEY_PATH
      ? path.resolve(process.cwd(), process.env.TLS_KEY_PATH)
      : path.join(defaultCertDir, 'server.key'),
    dbEngine,
    samAttDb: {
      host: samAttHost,
      port: samAttPort,
      database: samAttDatabase,
      user: samAttUser,
      password: samAttPassword,
      sqlitePath: process.env.SAM_ATT_SQLITE_PATH
        ? path.resolve(process.cwd(), process.env.SAM_ATT_SQLITE_PATH)
        : defaultSqlitePath,
    },
    hosofficeDb: {
      host: hosHost,
      port: hosPort,
      database: hosDatabase,
      user: hosUser,
      password: hosPassword,
      hrPersonTable: process.env.HOSOFFICE_HR_PERSON_TABLE || 'hr_person',
      pushWriteUser: process.env.HOSOFFICE_PUSH_WRITE_USER || process.env.HOSOFFICE_DB_USER || 'hosoffice_attendance_writer',
      pushWritePassword: process.env.HOSOFFICE_PUSH_WRITE_PASSWORD || process.env.HOSOFFICE_DB_PASSWORD || 'CHANGE_ME',
    },
    auth: {
      jwtSecret: jwtExplicit ? rawJwtSecret! : nodeEnv === 'production' ? '' : EPHEMERAL_DEV_JWT_SECRET,
      jwtSecretExplicitlyConfigured: jwtExplicit,
      sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES || 480),
      rateLimitWindowMinutes: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES || 15),
      rateLimitMaxAttempts: Number(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS || 5),
    },
    scanner: {
      syncEnabled: process.env.SCANNER_SYNC_ENABLED === 'true',
      autoSchedulerEnabled: process.env.SCANNER_AUTO_SCHEDULER_ENABLED !== 'false',
      readerExePath: (() => {
        const rawExePath = process.env.SCANNER_READER_EXE_PATH?.trim();
        if (rawExePath) {
          if (/^[a-zA-Z]:[\\/]/.test(rawExePath) || path.isAbsolute(rawExePath)) {
            return rawExePath;
          }
          return path.resolve(process.cwd(), rawExePath);
        }
        const localSyncCliExe = path.resolve(process.cwd(), 'ScannerReader', 'ScannerSyncCli.exe');
        if (fs.existsSync(localSyncCliExe)) {
          return localSyncCliExe;
        }
        const localReaderExe = path.resolve(process.cwd(), 'ScannerReader', 'ScannerReader.exe');
        if (fs.existsSync(localReaderExe)) {
          return localReaderExe;
        }
        if (fs.existsSync('C:\\inetpub\\wwwroot\\Sam_Att\\ScannerReader\\ScannerSyncCli.exe')) {
          return 'C:\\inetpub\\wwwroot\\Sam_Att\\ScannerReader\\ScannerSyncCli.exe';
        }
        if (fs.existsSync('C:\\Sam_Att\\ScannerReader\\ScannerSyncCli.exe')) {
          return 'C:\\Sam_Att\\ScannerReader\\ScannerSyncCli.exe';
        }
        if (fs.existsSync('C:\\Sam_Att\\bin\\ScannerReader.exe')) {
          return 'C:\\Sam_Att\\bin\\ScannerReader.exe';
        }
        return localSyncCliExe;
      })(),
      timeoutMs: Number(process.env.SCANNER_READER_TIMEOUT_MS || 30000),
      syncDays: Number(process.env.SCANNER_SYNC_DAYS || 3),
      previewMode: process.env.SCANNER_CLI_PREVIEW_MODE !== 'false',
      mysqlConnectionString:
        process.env.SCANNER_MYSQL_CONNECTION_STRING?.trim() || fallbackScannerMysqlConn,
      ingestSharedToken: scannerTokenExplicit
        ? rawScannerToken!
        : nodeEnv === 'production'
          ? ''
          : EPHEMERAL_DEV_SCANNER_TOKEN,
      ingestTokenExplicitlyConfigured: scannerTokenExplicit,
    },
    hosofficePush: {
      livePushEnabled: process.env.HOSOFFICE_LIVE_PUSH_ENABLED === 'true',
      targetTable: (process.env.HOSOFFICE_PUSH_TARGET_TABLE || '').trim(),
    },
  };
}

/**
 * ตรวจสอบความถูกต้องของค่าตั้งค่าในโหมด Production ก่อนเปิด Listener (แก้ไข P0 ข้อ 03–04 และ P1 ข้อ 15)
 * หากไม่พร้อมจะโยน ProductionConfigError ทันที (Fail-Closed)
 */
export function validateProductionConfig(cfg: AppConfig = loadConfig()): {
  valid: boolean;
  violations: string[];
} {
  const violations: string[] = [];

  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) {
    violations.push(`INVALID_PORT: พอร์ต HTTPS (${cfg.port}) ต้องเป็นตัวเลขระหว่าง 1 ถึง 65535`);
  }

  if (cfg.dataMode === 'DEMO' && process.env.HOSOFFICE_LIVE_PUSH_ENABLED === 'true') {
    violations.push(
      'DEMO_MODE_LIVE_PUSH_FORBIDDEN: ห้ามเปิด HOSOFFICE_LIVE_PUSH_ENABLED=true ขณะทำงานในโหมดข้อมูลตัวอย่าง (DEMO)'
    );
  }

  if (cfg.dataMode === 'DEMO' && cfg.dbEngine === 'mysql') {
    violations.push(
      'DEMO_MODE_MYSQL_FORBIDDEN: ห้ามรันโหมดข้อมูลตัวอย่าง (DEMO) บนฐานข้อมูล MySQL จริง เพื่อป้องกันข้อมูลจำลองปะปนกับข้อมูลโรงพยาบาล'
    );
  }

  if (cfg.nodeEnv === 'production') {
    if (cfg.dataMode !== 'REAL') {
      violations.push(
        'INVALID_DATA_MODE: โหมด Production ต้องใช้ SAM_ATT_DATA_MODE=REAL เท่านั้น ห้ามใช้โหมด DEMO ในสภาพแวดล้อมใช้งานจริง'
      );
    }
    if (cfg.dbEngine !== 'mysql') {
      violations.push('INVALID_DB_ENGINE: โหมด Production ต้องใช้ SAM_ATT_DB_ENGINE=mysql เท่านั้น');
    }
    if (!cfg.samAttDb.host || cfg.samAttDb.host === 'CHANGE_ME') {
      violations.push('MISSING_DB_HOST: กรุณากำหนดค่า SAM_ATT_DB_HOST สำหรับฐานข้อมูล MySQL');
    }
    if (!cfg.samAttDb.user || cfg.samAttDb.user === 'CHANGE_ME') {
      violations.push('MISSING_DB_USER: กรุณากำหนดค่า SAM_ATT_DB_USER');
    }
    if (!cfg.samAttDb.password || cfg.samAttDb.password === 'CHANGE_ME') {
      violations.push('MISSING_DB_PASSWORD: ห้ามใช้รหัสผ่านฐานข้อมูลเป็นค่าว่างหรือ CHANGE_ME ในโหมด Production');
    }
    if (!cfg.auth.jwtSecretExplicitlyConfigured || cfg.auth.jwtSecret.length < 32) {
      violations.push(
        'MISSING_OR_WEAK_JWT_SECRET: โหมด Production ต้องกำหนด JWT_SECRET จาก Environment Variable ที่มีความยาวอย่างน้อย 32 ตัวอักษร และห้ามใช้ค่า Placeholder'
      );
    }
    if (!cfg.scanner.ingestTokenExplicitlyConfigured || cfg.scanner.ingestSharedToken.length < 24) {
      violations.push(
        'MISSING_OR_WEAK_SCANNER_TOKEN: โหมด Production ต้องกำหนด SCANNER_INGEST_SHARED_TOKEN ที่มีความยาวอย่างน้อย 24 ตัวอักษร'
      );
    }
    if (
      cfg.auth.jwtSecret &&
      cfg.scanner.ingestSharedToken &&
      cfg.auth.jwtSecret === cfg.scanner.ingestSharedToken
    ) {
      violations.push(
        'DUPLICATE_SECRETS: ค่า SCANNER_INGEST_SHARED_TOKEN ต้องแยกจาก JWT_SECRET ห้ามใช้ค่าเดียวกัน'
      );
    }
    if (!fs.existsSync(cfg.tlsCertPath) || !fs.existsSync(cfg.tlsKeyPath)) {
      violations.push(
        `MISSING_TLS_CERTIFICATE: ไม่พบไฟล์ใบรับรอง TLS ที่กำหนด (${cfg.tlsCertPath} หรือ ${cfg.tlsKeyPath})`
      );
    }
  }

  if (violations.length > 0 && cfg.nodeEnv === 'production') {
    throw new ProductionConfigError(violations);
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}
