/**
 * ============================================================================
 * โมดูลจัดการระบบบันทึกข้อมูลระดับองค์กร (Structured File Logger, Rotation & Secret Redaction)
 * ไฟล์: backend/src/utils/logger.ts
 * ============================================================================
 * หน้าที่หลัก (Phase 2.12 — Logging & Monitoring):
 * 1. บันทึก Log แยกตามหมวดหมู่ลงในโฟลเดอร์มาตรฐาน `D:\WebApps\Sam_Att\Logs` (หรือ `SAM_ATT_LOGS_DIR`):
 *    - `application.log`: บันทึกเหตุการณ์การทำงานทั่วไปของแอปพลิเคชัน
 *    - `error.log`: บันทึกข้อผิดพลาดระดับระบบและฐานข้อมูล
 *    - `scanner.log`: บันทึกการเชื่อมต่อและการซิงก์เครื่องสแกนลายนิ้วมือ
 *    - `security-audit.log`: บันทึกเหตุการณ์ด้านความปลอดภัยและการยืนยันตัวตน
 * 2. หมุนเวียนไฟล์ Log อัตโนมัติ (Size-Based Log Rotation) เมื่อขนาดไฟล์เกินค่ากำหนด (ค่าเริ่มต้น 10 MB, เก็บย้อนหลัง 5 ไฟล์)
 * 3. ปกปิดข้อมูลความลับทุกชนิด (Secret Redaction): ห้ามบันทึก Password, JWT Secret, Scanner Token,
 *    GitHub Token, Private Key หรือ Connection String ลงในไฟล์ Log เด็ดขาด
 */
import fs from 'fs';
import path from 'path';
import os from 'os';

export type LogCategory = 'application' | 'error' | 'scanner' | 'security-audit' | 'deployment';
export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'SECURITY';

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const DEFAULT_MAX_BACKUPS = 5;

const SENSITIVE_KEY_VALUE_REGEX =
  /\b(PASSWORD|PWD|SAM_ATT_DB_PASSWORD|HOSOFFICE_DB_PASSWORD|HOSOFFICE_PUSH_DB_PASSWORD|JWT_SECRET|SCANNER_INGEST_SHARED_TOKEN|GITHUB_TOKEN|MYSQL_PWD|PRIVATE_KEY|SECRET|TOKEN|API_KEY)\s*([=:])\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s,&"'}]+)/gi;

const CONNECTION_STRING_SECRET_REGEX =
  /((?:mysql|mariadb|postgres|https?):\/\/[^:\s/]+:)([^@\s]+)(@)/gi;

const BEARER_TOKEN_REGEX = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
const GITHUB_PAT_REGEX = /\b(gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g;
const PEM_PRIVATE_KEY_REGEX =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;

/**
 * ปกปิดข้อมูลความลับ (Secret Redaction) ในข้อความหรือออบเจ็กต์ก่อนบันทึกลงไฟล์ Log
 */
export function redactSecretsFromText(input: string): string {
  if (!input) return '';
  let text = String(input);
  text = text.replace(PEM_PRIVATE_KEY_REGEX, '[REDACTED_PRIVATE_KEY]');
  text = text.replace(SENSITIVE_KEY_VALUE_REGEX, '$1$2***REDACTED***');
  text = text.replace(CONNECTION_STRING_SECRET_REGEX, '$1***REDACTED***$3');
  text = text.replace(BEARER_TOKEN_REGEX, '$1***REDACTED***');
  text = text.replace(GITHUB_PAT_REGEX, '***REDACTED_GITHUB_TOKEN***');

  // Redact dynamic secrets from process.env if they are at least 6 chars
  const envSecretKeys = [
    'SAM_ATT_DB_PASSWORD',
    'HOSOFFICE_DB_PASSWORD',
    'HOSOFFICE_PUSH_DB_PASSWORD',
    'JWT_SECRET',
    'SCANNER_INGEST_SHARED_TOKEN',
    'GITHUB_TOKEN',
  ];
  for (const key of envSecretKeys) {
    const val = process.env[key];
    if (val && val.trim().length >= 6) {
      const escaped = val.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped, 'g'), '***REDACTED***');
    }
  }
  return text;
}

export function resolveLogsDirectory(): string {
  if (process.env.SAM_ATT_LOGS_DIR && process.env.SAM_ATT_LOGS_DIR.trim()) {
    return path.resolve(process.env.SAM_ATT_LOGS_DIR.trim());
  }
  const isWin = process.platform === 'win32';
  const nodeEnv = process.env.NODE_ENV || 'development';
  if (nodeEnv === 'production' && isWin) {
    const rootDir = process.env.SAM_ATT_ROOT?.trim() || 'D:\\WebApps\\Sam_Att';
    return path.join(rootDir, 'Logs');
  }
  if (nodeEnv === 'test') {
    return path.join(os.tmpdir(), 'sam_att_test_logs');
  }
  return path.resolve(process.cwd(), 'logs');
}

function rotateLogFileIfNeeded(
  filePath: string,
  maxBytes = DEFAULT_MAX_BYTES,
  maxBackups = DEFAULT_MAX_BACKUPS
): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const stats = fs.statSync(filePath);
    if (stats.size < maxBytes) return;

    for (let i = maxBackups - 1; i >= 1; i--) {
      const src = `${filePath}.${i}`;
      const dst = `${filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        fs.renameSync(src, dst);
      }
    }
    fs.renameSync(filePath, `${filePath}.1`);
  } catch {
    // Non-fatal rotation error
  }
}

export function writeStructuredLog(params: {
  category: LogCategory;
  level: LogLevel;
  event: string;
  message: string;
  meta?: Record<string, unknown>;
  logsDirOverride?: string;
  maxBytesOverride?: number;
}): void {
  const logsDir = params.logsDirOverride || resolveLogsDirectory();
  const safeMessage = redactSecretsFromText(params.message);
  const safeMetaStr = params.meta ? redactSecretsFromText(JSON.stringify(params.meta)) : undefined;

  const entry = {
    timestamp: new Date().toISOString(),
    level: params.level,
    category: params.category,
    event: params.event,
    message: safeMessage,
    ...(safeMetaStr ? { meta: JSON.parse(safeMetaStr) } : {}),
  };

  const line = JSON.stringify(entry) + '\n';

  try {
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    const targetFile = path.join(logsDir, `${params.category}.log`);
    rotateLogFileIfNeeded(targetFile, params.maxBytesOverride ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BACKUPS);
    fs.appendFileSync(targetFile, line, 'utf8');

    // Mirror ERROR entries to error.log automatically if category is not already 'error'
    if (params.level === 'ERROR' && params.category !== 'error') {
      const errorFile = path.join(logsDir, 'error.log');
      rotateLogFileIfNeeded(errorFile, params.maxBytesOverride ?? DEFAULT_MAX_BYTES, DEFAULT_MAX_BACKUPS);
      fs.appendFileSync(errorFile, line, 'utf8');
    }
  } catch {
    // Avoid crashing server if disk log write fails
  }
}

export const appLogger = {
  info(event: string, message: string, meta?: Record<string, unknown>) {
    writeStructuredLog({ category: 'application', level: 'INFO', event, message, meta });
  },
  warn(event: string, message: string, meta?: Record<string, unknown>) {
    writeStructuredLog({ category: 'application', level: 'WARN', event, message, meta });
  },
  error(event: string, message: string, meta?: Record<string, unknown>) {
    writeStructuredLog({ category: 'error', level: 'ERROR', event, message, meta });
  },
  scanner(level: LogLevel, event: string, message: string, meta?: Record<string, unknown>) {
    writeStructuredLog({ category: 'scanner', level, event, message, meta });
  },
  security(event: string, message: string, meta?: Record<string, unknown>) {
    writeStructuredLog({ category: 'security-audit', level: 'SECURITY', event, message, meta });
  },
};
