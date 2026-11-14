import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { loadConfig } from '../config/env.ts';
import { dbQuery, DatabaseUnavailableError } from '../database/adapter.ts';
import { verifyJwt, type UserRole } from '../utils/crypto.ts';
import { writeAuditLog } from '../modules/audit/service.ts';

export interface AuthenticatedUser {
  id: number;
  username: string;
  displayName: string;
  role: UserRole;
  approvedPersonId: string | null;
  jti: string;
  exp: number;
}

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: AuthenticatedUser;
    }
  }
}

export function attachRequestId(req: Request, res: Response, next: NextFunction): void {
  const existing = req.headers['x-request-id'];
  const requestId = typeof existing === 'string' && existing.trim() ? existing.trim() : crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
}

function extractBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'กรุณาเข้าสู่ระบบก่อนใช้งาน (Missing authentication token)',
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
    // Check revoked_sessions
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

    // Always resolve current user role and approved_person_id from database (never trust stale token claims)
    const users = await dbQuery<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      approved_person_id: string | null;
      is_active: number;
    }>(
      'SELECT id, username, display_name, role, approved_person_id, is_active FROM users WHERE id = ? AND username = ? LIMIT 1',
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
    req.user = {
      id: dbUser.id,
      username: dbUser.username,
      displayName: dbUser.display_name,
      role: dbUser.role,
      approvedPersonId: dbUser.approved_person_id,
      jti: payload.jti,
      exp: payload.exp,
    };
    next();
  } catch (err) {
    if (err instanceof DatabaseUnavailableError) {
      res.status(503).json({
        error: 'DB_UNAVAILABLE',
        message: err.message,
        requestId: req.requestId,
      });
      return;
    }
    next(err);
  }
}

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
 * Prevents IDOR on /me/* endpoints:
 * Rejects any attempt to override target personId via query, params, or body,
 * and ensures the user has an approved PERSON_ID mapped by ADMIN.
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
