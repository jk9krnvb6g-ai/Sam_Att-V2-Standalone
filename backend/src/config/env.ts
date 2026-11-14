import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export type DbEngineMode = 'mysql' | 'sqlite_sandbox';

export interface AppConfig {
  nodeEnv: string;
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
  };
  auth: {
    jwtSecret: string;
    sessionTtlMinutes: number;
    rateLimitWindowMinutes: number;
    rateLimitMaxAttempts: number;
  };
  scanner: {
    syncEnabled: boolean;
    readerExePath: string;
    timeoutMs: number;
    ingestSharedToken: string;
  };
  hosofficePush: {
    livePushEnabled: boolean;
    targetTable: string;
  };
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV || 'development';
  // In production, default strictly to mysql fail-closed.
  // In development/test sandbox where external MySQL daemon is not attached, allow sqlite_sandbox unless SAM_ATT_DB_ENGINE=mysql is explicitly set.
  const explicitEngine = process.env.SAM_ATT_DB_ENGINE as DbEngineMode | undefined;
  const dbEngine: DbEngineMode = explicitEngine
    ? explicitEngine
    : nodeEnv === 'production'
      ? 'mysql'
      : 'sqlite_sandbox';

  const rawPort = process.env.SAM_ATT_HTTPS_PORT || process.env.PORT;
  const httpsPort = rawPort && rawPort !== '3000' ? Number(rawPort) : 4101;

  return {
    nodeEnv,
    host: process.env.HOST || '0.0.0.0',
    port: httpsPort,
    previewHttpPort: Number(process.env.PREVIEW_HTTP_PORT || 3000),
    publicBasePath: process.env.PUBLIC_BASE_PATH || '/Sam_Att/',
    apiBasePath: process.env.API_BASE_PATH || '/api/Sam_Att',
    tlsCertPath: path.resolve(process.cwd(), process.env.TLS_CERT_PATH || './certs/server.crt'),
    tlsKeyPath: path.resolve(process.cwd(), process.env.TLS_KEY_PATH || './certs/server.key'),
    dbEngine,
    samAttDb: {
      host: process.env.SAM_ATT_DB_HOST || '127.0.0.1',
      port: Number(process.env.SAM_ATT_DB_PORT || 3306),
      database: process.env.SAM_ATT_DB_NAME || 'samchuk_attendance_v2',
      user: process.env.SAM_ATT_DB_USER || 'sam_att_app',
      password: process.env.SAM_ATT_DB_PASSWORD || 'CHANGE_ME',
      sqlitePath: path.resolve(process.cwd(), process.env.SAM_ATT_SQLITE_PATH || './data/sam_att_v2.sqlite'),
    },
    hosofficeDb: {
      host: process.env.HOSOFFICE_DB_HOST || 'CHANGE_ME',
      port: Number(process.env.HOSOFFICE_DB_PORT || 3306),
      database: process.env.HOSOFFICE_DB_NAME || 'hosoffice',
      user: process.env.HOSOFFICE_DB_USER || 'hosoffice_readonly',
      password: process.env.HOSOFFICE_DB_PASSWORD || 'CHANGE_ME',
      hrPersonTable: process.env.HOSOFFICE_HR_PERSON_TABLE || 'hr_person',
    },
    auth: {
      jwtSecret:
        process.env.JWT_SECRET && process.env.JWT_SECRET !== 'GENERATE_SECURE_RANDOM_SECRET_AT_DEPLOY'
          ? process.env.JWT_SECRET
          : 'sam-att-v2-standalone-dev-hmac-secret-change-in-prod-98f3a1c2',
      sessionTtlMinutes: Number(process.env.SESSION_TTL_MINUTES || 480),
      rateLimitWindowMinutes: Number(process.env.AUTH_RATE_LIMIT_WINDOW_MINUTES || 15),
      rateLimitMaxAttempts: Number(process.env.AUTH_RATE_LIMIT_MAX_ATTEMPTS || 5),
    },
    scanner: {
      syncEnabled: process.env.SCANNER_SYNC_ENABLED === 'true',
      readerExePath: process.env.SCANNER_READER_EXE_PATH || 'C:\\Sam_Att\\bin\\ScannerReader.exe',
      timeoutMs: Number(process.env.SCANNER_READER_TIMEOUT_MS || 30000),
      ingestSharedToken:
        process.env.SCANNER_INGEST_SHARED_TOKEN &&
        process.env.SCANNER_INGEST_SHARED_TOKEN !== 'GENERATE_SCANNER_INGEST_SECRET_AT_DEPLOY'
          ? process.env.SCANNER_INGEST_SHARED_TOKEN
          : 'sam-att-exe-ingest-token-v2',
    },
    hosofficePush: {
      livePushEnabled: process.env.HOSOFFICE_LIVE_PUSH_ENABLED === 'true',
      targetTable: process.env.HOSOFFICE_PUSH_TARGET_TABLE || '',
    },
  };
}
