/**
 * ============================================================================
 * โมดูลตรวจสอบตัวตนและควบคุมสิทธิ์การเข้าถึง (Authentication, Cookie/CSRF & RBAC Middleware)
 * ไฟล์: backend/src/middleware/auth.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. attachRequestId: สร้างรหัสอ้างอิงคำขอ (X-Request-Id) สำหรับตรวจสอบย้อนหลังใน Audit Logs
 * 2. requireAuth:
 *    - รองรับการยืนยันตัวตนหลักผ่าน HttpOnly, Secure, SameSite=Strict Cookie (`sam_att_session`)
 *      พร้อมตรวจสอบ CSRF Token (`X-CSRF-Token`) สำหรับคำสั่งเปลี่ยนแปลงข้อมูล (POST/PUT/PATCH/DELETE) (แก้ไข P1 ข้อ 12)
 *    - รองรับ Authorization: Bearer <token> สำหรับสคริปต์/CLI ทดสอบอัตโนมัติ
 *    - ตรวจสอบว่าเซสชันถูกยกเลิกในตาราง `revoked_sessions` หรือไม่
 *    - ดึงข้อมูลสิทธิ์ล่าสุดของผู้ใช้จากตาราง `users` ในฐานข้อมูลจริงเสมอ
 * 3. requireRoles: บังคับสิทธิ์ 3 ระดับ (ADMIN, RESPONSIBLE_STAFF, GENERAL_USER)
 * 4. enforceOwnPersonMapping: ป้องกันช่องโหว่ IDOR สำหรับเมนูส่วนตัว (/me/*)
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config/env.ts';
import { dbQuery, DatabaseUnavailableError } from '../database/adapter.ts';
import {
  verifyJwt,
  parseCookies,
  verifyCsrfToken,
  repairThaiMojibakeIfCorrupted,
  type UserRole,
} from '../utils/crypto.ts';
import { writeAuditLog } from '../modules/audit/service.ts';

export const SESSION_COOKIE_NAME = 'sam_att_session';
export const CSRF_COOKIE_NAME = 'sam_att_csrf';

export interface AuthenticatedUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  approvedPersonId: string | null;
  mustChangePassword: boolean;
  jti: string;
  exp: number;
  authSource?: 'COOKIE' | 'BEARER';
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: AuthenticatedUser;
    }
  }
}

/**
 * แนบหมายเลขประจำคำขอ (Request ID) เข้ากับทุก Request และส่งกลับใน Header X-Request-Id
 */
export function attachRequestId(req: Request, res: Response, next: NextFunction): void {
  const existing = req.headers['x-request-id'];
  const requestId = typeof existing === 'string' && existing.trim() ? existing.trim() : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

/**
 * ดึงค่า JWT Token จาก HttpOnly Cookie (`sam_att_session`) เป็นหลัก
 * หรือจาก Header `Authorization: Bearer <token>` สำหรับ CLI/Test Client
 */
function extractAuthToken(req: Request): { token: string | null; source: 'COOKIE' | 'BEARER' | null } {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[SESSION_COOKIE_NAME]) {
    return { token: cookies[SESSION_COOKIE_NAME], source: 'COOKIE' };
  }
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return { token: authHeader.slice(7).trim(), source: 'BEARER' };
  }
  return { token: null, source: null };
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Middleware ตรวจสอบการเข้าสู่ระบบ (Authentication + CSRF Verification)
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { token, source } = extractAuthToken(req);
    if (!token || !source) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'กรุณาเข้าสู่ระบบก่อนใช้งาน (Missing authentication session)',
        requestId: req.requestId,
      });
      return;
    }

    const cfg = loadConfig();
    const verified = verifyJwt(token, cfg.auth.jwtSecret);
    if (!verified.valid || !verified.payload) {
      res.status(401).json({
        error: verified.reason || 'INVALID_TOKEN',
        message: 'เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบใหม่',
        requestId: req.requestId,
      });
      return;
    }

    const { payload } = verified;

    // กรณีใช้ HttpOnly Cookie และเป็นการเรียกคำสั่งเปลี่ยนแปลงข้อมูล (POST/PUT/PATCH/DELETE)
    // ต้องตรวจสอบ CSRF Token ใน Header X-CSRF-Token เสมอ (แก้ไขปัญหา P1 ข้อ 12)
    if (source === 'COOKIE' && MUTATING_METHODS.has(req.method.toUpperCase())) {
      const csrfHeader = String(req.headers['x-csrf-token'] || '').trim();
      if (!verifyCsrfToken(csrfHeader, payload.jti, cfg.auth.jwtSecret)) {
        res.status(403).json({
          error: 'CSRF_VALIDATION_FAILED',
          message: 'คำขอถูกปฏิเสธเนื่องจากรหัสป้องกัน CSRF (X-CSRF-Token) ไม่ถูกต้องหรือขาดหายไป',
          requestId: req.requestId,
        });
        return;
      }
    }

    // ตรวจสอบว่าโทเค็นนี้ถูกสั่งออกจากระบบ (Revoked) ไปแล้วหรือยัง
    const revoked = await dbQuery<{ jti: string }>(
      'SELECT jti FROM revoked_sessions WHERE jti = ? LIMIT 1',
      [payload.jti]
    );
    if (revoked.length > 0) {
      res.status(401).json({
        error: 'TOKEN_REVOKED',
        message: 'เซสชันนี้ถูกยกเลิกแล้ว กรุณาเข้าสู่ระบบใหม่',
        requestId: req.requestId,
      });
      return;
    }

    // ดึงระดับสิทธิ์ (role) และรหัสบุคลากรที่ผูกไว้ (approved_person_id) จากฐานข้อมูลจริงทุกครั้ง
    const users = await dbQuery<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      approved_person_id: string | null;
      is_active: number;
      must_change_password?: number;
    }>(
      'SELECT id, username, display_name, role, approved_person_id, is_active, must_change_password FROM users WHERE id = ? AND username = ? LIMIT 1',
      [payload.userId, payload.sub]
    );

    if (users.length === 0 || Number(users[0].is_active) !== 1) {
      res.status(403).json({
        error: 'ACCOUNT_DISABLED',
        message: 'บัญชีผู้ใช้งานถูกระงับหรือไม่พบในระบบ',
        requestId: req.requestId,
      });
      return;
    }

    const dbUser = users[0];
    const cleanDisplayName = repairThaiMojibakeIfCorrupted(
      dbUser.display_name,
      dbUser.username === 'admin' ? 'ผู้ดูแลระบบสูงสุด (โรงพยาบาลสามชุก)' : dbUser.username
    ).text;
    const mustChangePassword = Number(dbUser.must_change_password || 0) === 1;
    const reqPath = (req.path || '').split('?')[0];
    const allowedDuringForcedChange =
      reqPath === '/auth/me' ||
      reqPath === '/auth/logout' ||
      reqPath === '/auth/change-password';

    if (mustChangePassword && !allowedDuringForcedChange) {
      res.status(403).json({
        error: 'PASSWORD_CHANGE_REQUIRED',
        message: 'กรุณาเปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งานระบบ',
        mustChangePassword: true,
        requestId: req.requestId,
      });
      return;
    }

    req.user = {
      id: dbUser.id,
      username: dbUser.username,
      displayName: cleanDisplayName,
      role: dbUser.role,
      approvedPersonId: dbUser.approved_person_id,
      mustChangePassword,
      jti: payload.jti,
      exp: payload.exp,
      authSource: source,
    };
    next();
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      res.status(503).json({
        error: 'DB_UNAVAILABLE',
        message: err.PublicSafeMessage,
        requestId: req.requestId,
      });
      return;
    }
    next(err);
  }
}

/**
 * Middleware ตรวจสอบระดับสิทธิ์ผู้ใช้งาน (Role-Based Access Control)
 */
export function requireRoles(...allowedRoles: UserRole[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'กรุณาเข้าสู่ระบบ',
        requestId: req.requestId,
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user.username,
        actorRole: req.user.role,
        ipAddress: req.ip || '127.0.0.1',
        action: `RBAC_DENIED:${req.method}:${req.originalUrl}`,
        targetType: 'ENDPOINT',
        targetId: req.originalUrl,
        result: 'DENIED',
        errorCode: 'FORBIDDEN_ROLE',
        detail: { requiredRoles: allowedRoles, actualRole: req.user.role },
      });

      res.status(403).json({
        error: 'FORBIDDEN_ROLE',
        message: 'สิทธิ์ของคุณไม่เพียงพอสำหรับเข้าถึงเมนูหรือคำสั่งนี้',
        requestId: req.requestId,
      });
      return;
    }
    next();
  };
}

/**
 * Middleware ป้องกันการเข้าถึงข้อมูลข้ามบุคคล (Anti-IDOR Own-Only Enforcement) สำหรับ API /me/*
 */
export async function enforceOwnPersonMapping(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'กรุณาเข้าสู่ระบบ', requestId: req.requestId });
    return;
  }

  const attemptedPersonId =
    (req.query.personId as string | undefined) ||
    (req.query.person_id as string | undefined) ||
    (req.params.personId as string | undefined) ||
    (req.body && (req.body.personId || req.body.person_id));

  if (attemptedPersonId && attemptedPersonId !== req.user.approvedPersonId) {
    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user.username,
      actorRole: req.user.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'IDOR_ATTEMPT_BLOCKED',
      targetType: 'PERSONNEL',
      targetId: String(attemptedPersonId),
      result: 'DENIED',
      errorCode: 'FORBIDDEN_IDOR_ATTEMPT',
      detail: { approvedPersonId: req.user.approvedPersonId, attemptedPersonId },
    });

    res.status(403).json({
      error: 'FORBIDDEN_IDOR_ATTEMPT',
      message: 'ไม่อนุญาตให้ระบุหรือเข้าถึงข้อมูลรหัสบุคลากรของผู้อื่น (Own-Only Enforcement)',
      requestId: req.requestId,
    });
    return;
  }

  if (!req.user.approvedPersonId) {
    res.status(403).json({
      error: 'PERSON_MAPPING_NOT_APPROVED',
      message: 'บัญชีของคุณยังไม่ได้รับการผูกกับรหัสบุคลากร (PERSON_ID) โดยผู้ดูแลระบบ',
      requestId: req.requestId,
    });
    return;
  }

  next();
}
