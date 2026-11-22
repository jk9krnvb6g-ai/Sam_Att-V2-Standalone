/**
 * ============================================================================
 * โมดูลยืนยันตัวตนด้วยรหัสผ่านของผู้ดำเนินการปัจจุบัน (Actor Reauthentication & Rate Limiter)
 * ไฟล์: backend/src/modules/auth/reauth.ts
 * ============================================================================
 * ใช้สำหรับคำสั่งที่มีผลกระทบสูง (High-Impact Operations):
 * - การดึงข้อมูลสแกนรายเดือน (MONTHLY) และดึงข้อมูลทั้งหมด (FULL_HISTORICAL / ALL)
 * - การอนุมัติปรับวันที่มีผลย้อนหลังของรหัสลายนิ้วมือ (Retroactive Fingerprint Mapping)
 *
 * นโยบายความปลอดภัย:
 * 1. ตรวจสอบรหัสผ่านเทียบกับ Hash ของ "ผู้ใช้งานที่กำลังล็อกอินอยู่จริงเท่านั้น" (ห้ามยอมรับรหัสผ่านของผู้อื่น)
 * 2. บังคับให้ผู้ใช้ยืนยันการรับทราบผลกระทบ (impactAcknowledged === true)
 * 3. ป้องกัน Brute-Force ด้วยตาราง auth_rate_limits (ล็อกชั่วคราวเมื่อกรอกผิดเกินกำหนด)
 * 4. ห้ามบันทึกรหัสผ่านหรือส่งรหัสผ่านกลับไปใน Response หรือ Audit Log เด็ดขาด
 */
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { verifyPassword } from '../../utils/crypto.ts';
import { writeAuditLog } from '../audit/service.ts';

export interface ReauthRequestParams {
  userId: number;
  username: string;
  role: string;
  ipAddress: string;
  requestId: string;
  operationName: string;
  targetType: string;
  targetId?: string;
  confirmPassword: unknown;
  impactAcknowledged: unknown;
}

export interface ReauthResult {
  ok: boolean;
  statusCode?: number;
  errorCode?: string;
  message?: string;
  lockedUntil?: string | null;
}

export async function verifyActorReauthentication(
  params: ReauthRequestParams
): Promise<ReauthResult> {
  if (params.impactAcknowledged !== true) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'IMPACT_CONFIRMATION_REQUIRED',
      message: 'กรุณาทำเครื่องหมายยืนยันว่าได้รับทราบผลกระทบของการดำเนินการนี้ก่อนกดยืนยัน',
    };
  }

  const password = typeof params.confirmPassword === 'string' ? params.confirmPassword : '';
  if (!password) {
    return {
      ok: false,
      statusCode: 400,
      errorCode: 'PASSWORD_CONFIRMATION_REQUIRED',
      message: 'กรุณากรอกรหัสผ่านของบัญชีผู้ใช้งานปัจจุบันเพื่อยืนยันตัวตนก่อนดำเนินการ',
    };
  }

  const cfg = loadConfig();
  const maxAttempts = Math.max(3, Math.min(10, cfg.auth.rateLimitMaxAttempts || 5));
  const lockMinutes = Math.max(5, Math.min(60, cfg.auth.rateLimitWindowMinutes || 15));
  const rateKey = `reauth:${params.userId}:${params.username.toLowerCase()}`;
  const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const rateRows = await dbQuery<{
    rate_key: string;
    failed_attempts: number;
    locked_until: string | null;
  }>(
    'SELECT rate_key, failed_attempts, locked_until FROM auth_rate_limits WHERE rate_key = ? LIMIT 1',
    [rateKey]
  );

  if (rateRows.length > 0 && rateRows[0].locked_until && rateRows[0].locked_until > nowIso) {
    await writeAuditLog({
      requestId: params.requestId,
      actorUsername: params.username,
      actorRole: params.role,
      ipAddress: params.ipAddress,
      action: `${params.operationName}_REAUTH_LOCKED`,
      targetType: params.targetType,
      targetId: params.targetId,
      result: 'BLOCKED',
      errorCode: 'REAUTH_RATE_LIMITED',
      detail: { lockedUntil: rateRows[0].locked_until },
    });

    return {
      ok: false,
      statusCode: 429,
      errorCode: 'REAUTH_RATE_LIMITED',
      message: 'กรอกรหัสผ่านยืนยันตัวตนผิดเกินจำนวนครั้งที่กำหนด กรุณารอสักครู่แล้วลองใหม่อีกครั้ง',
      lockedUntil: rateRows[0].locked_until,
    };
  }

  // โหลด Hash รหัสผ่านเฉพาะบัญชีของผู้ดำเนินการที่กำลังล็อกอินอยู่จริงเท่านั้น (ห้ามตรวจสอบข้ามบัญชี)
  const users = await dbQuery<{
    id: number;
    username: string;
    password_hash: string;
    is_active: number;
  }>(
    'SELECT id, username, password_hash, is_active FROM users WHERE id = ? AND username = ? LIMIT 1',
    [params.userId, params.username]
  );

  const actorRow = users[0];
  const valid =
    Boolean(actorRow) &&
    Number(actorRow.is_active) === 1 &&
    verifyPassword(password, actorRow.password_hash);

  if (!valid) {
    const prevFails =
      rateRows.length > 0 && (!rateRows[0].locked_until || rateRows[0].locked_until <= nowIso)
        ? Number(rateRows[0].failed_attempts || 0)
        : 0;
    const currentFails = prevFails + 1;
    const shouldLock = currentFails >= maxAttempts;
    const lockedUntil = shouldLock
      ? new Date(Date.now() + lockMinutes * 60_000).toISOString().slice(0, 19).replace('T', ' ')
      : null;

    if (rateRows.length === 0) {
      await dbExecute(
        'INSERT INTO auth_rate_limits (rate_key, failed_attempts, first_failed_at, locked_until, updated_at) VALUES (?, ?, ?, ?, ?)',
        [rateKey, currentFails, nowIso, lockedUntil, nowIso]
      );
    } else {
      await dbExecute(
        'UPDATE auth_rate_limits SET failed_attempts = ?, locked_until = ?, updated_at = ? WHERE rate_key = ?',
        [currentFails, lockedUntil, nowIso, rateKey]
      );
    }

    await writeAuditLog({
      requestId: params.requestId,
      actorUsername: params.username,
      actorRole: params.role,
      ipAddress: params.ipAddress,
      action: `${params.operationName}_REAUTH_FAILED`,
      targetType: params.targetType,
      targetId: params.targetId,
      result: 'DENIED',
      errorCode: shouldLock ? 'REAUTH_RATE_LIMITED' : 'INVALID_CONFIRM_PASSWORD',
      detail: { failedAttempts: currentFails, locked: shouldLock },
    });

    if (shouldLock) {
      return {
        ok: false,
        statusCode: 429,
        errorCode: 'REAUTH_RATE_LIMITED',
        message: 'กรอกรหัสผ่านยืนยันตัวตนผิดเกินจำนวนครั้งที่กำหนด ระบบระงับการยืนยันชั่วคราว กรุณารอสักครู่',
        lockedUntil,
      };
    }

    return {
      ok: false,
      statusCode: 401,
      errorCode: 'INVALID_CONFIRM_PASSWORD',
      message: `รหัสผ่านของบัญชีผู้ใช้งานปัจจุบันไม่ถูกต้อง (เหลือโอกาสอีก ${Math.max(0, maxAttempts - currentFails)} ครั้ง)`,
    };
  }

  // ล้างตัวนับเมื่อยืนยันรหัสผ่านสำเร็จ
  if (rateRows.length > 0) {
    await dbExecute('DELETE FROM auth_rate_limits WHERE rate_key = ?', [rateKey]);
  }

  return { ok: true };
}
