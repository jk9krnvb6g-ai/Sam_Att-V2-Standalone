/**
 * ============================================================================
 * โมดูลจัดการการเข้าสู่ระบบ เซสชัน และผู้ใช้งานระบบ (Auth & User Management Routes)
 * ไฟล์: backend/src/modules/auth/routes.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. POST /auth/login: ตรวจสอบรหัสผ่าน, ป้องกัน Brute-Force Lockout,
 *    ออก HttpOnly, Secure, SameSite=Strict Cookie (`sam_att_session`) คู่กับ CSRF Token (`sam_att_csrf`) (แก้ไข P1 ข้อ 12)
 * 2. GET /auth/me: คืนค่าข้อมูลผู้ใช้ปัจจุบันและรหัส CSRF Token สำหรับแนบใน Header X-CSRF-Token
 * 3. POST /auth/logout: บันทึก jti ลงตาราง `revoked_sessions` และล้าง Cookie ทั้งหมดทันที
 * 4. GET/POST/PUT /users: จัดการบัญชีผู้ใช้งานและผูก `approved_person_id` เฉพาะผู้ดูแลระบบ (ADMIN)
 */
import { Router, type Response } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import {
  hashPassword,
  verifyPassword,
  signJwt,
  computeCsrfToken,
  repairThaiMojibakeIfCorrupted,
  type UserRole,
} from '../../utils/crypto.ts';
import {
  requireAuth,
  requireRoles,
  SESSION_COOKIE_NAME,
  CSRF_COOKIE_NAME,
} from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export const authRouter = Router();

function setAuthCookies(
  res: Response,
  token: string,
  csrfToken: string,
  ttlSeconds: number,
  isSecureRequest: boolean
): void {
  const secureFlag = isSecureRequest ? '; Secure' : '';
  const sessionCookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=${ttlSeconds}`;
  const csrfCookie = `${CSRF_COOKIE_NAME}=${encodeURIComponent(csrfToken)}${secureFlag}; SameSite=Strict; Path=/; Max-Age=${ttlSeconds}`;
  res.setHeader('Set-Cookie', [sessionCookie, csrfCookie]);
}

function clearAuthCookies(res: Response, isSecureRequest: boolean): void {
  const secureFlag = isSecureRequest ? '; Secure' : '';
  res.setHeader('Set-Cookie', [
    `${SESSION_COOKIE_NAME}=; HttpOnly${secureFlag}; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
    `${CSRF_COOKIE_NAME}=${secureFlag}; SameSite=Strict; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
  ]);
}

authRouter.post('/auth/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const ipAddress = req.ip || '127.0.0.1';

    if (!username || !password) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุชื่อผู้ใช้งานและรหัสผ่าน',
        requestId: req.requestId,
      });
      return;
    }

    const cfg = loadConfig();
    const rateKey = `login:${username.toLowerCase()}`;
    const nowIso = new Date().toISOString().slice(0, 19).replace('T', ' ');

    // Check rate limit lockout
    const rateRows = await dbQuery<{
      rate_key: string;
      failed_attempts: number;
      locked_until: string | null;
    }>('SELECT rate_key, failed_attempts, locked_until FROM auth_rate_limits WHERE rate_key = ? LIMIT 1', [
      rateKey,
    ]);

    if (rateRows.length > 0 && rateRows[0].locked_until && rateRows[0].locked_until > nowIso) {
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: username,
        actorRole: 'UNAUTHENTICATED',
        ipAddress,
        action: 'AUTH_LOGIN_LOCKED',
        targetType: 'USER',
        targetId: username,
        result: 'BLOCKED',
        errorCode: 'ACCOUNT_TEMPORARILY_LOCKED',
      });
      res.status(429).json({
        error: 'ACCOUNT_TEMPORARILY_LOCKED',
        message: 'มีการพยายามเข้าสู่ระบบผิดพลาดเกินจำนวนครั้งที่กำหนด กรุณารอสักครู่แล้วลองใหม่',
        lockedUntil: rateRows[0].locked_until,
        requestId: req.requestId,
      });
      return;
    }

    const users = await dbQuery<{
      id: number;
      username: string;
      password_hash: string;
      display_name: string;
      role: UserRole;
      approved_person_id: string | null;
      is_active: number;
    }>(
      'SELECT id, username, password_hash, display_name, role, approved_person_id, is_active FROM users WHERE username = ? LIMIT 1',
      [username]
    );

    const user = users[0];
    const passwordValid = user ? verifyPassword(password, user.password_hash) : false;

    if (!user || !passwordValid) {
      const currentFails = rateRows.length > 0 ? Number(rateRows[0].failed_attempts) + 1 : 1;
      const shouldLock = currentFails >= cfg.auth.rateLimitMaxAttempts;
      const lockedUntil = shouldLock
        ? new Date(Date.now() + cfg.auth.rateLimitWindowMinutes * 60000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ')
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
        requestId: req.requestId,
        actorUsername: username,
        actorRole: 'UNAUTHENTICATED',
        ipAddress,
        action: 'AUTH_LOGIN_FAILURE',
        targetType: 'USER',
        targetId: username,
        result: 'FAILURE',
        errorCode: 'INVALID_CREDENTIALS',
        detail: { failedAttempts: currentFails, locked: shouldLock },
      });

      res.status(401).json({
        error: 'INVALID_CREDENTIALS',
        message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง',
        requestId: req.requestId,
      });
      return;
    }

    if (Number(user.is_active) !== 1) {
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: user.username,
        actorRole: user.role,
        ipAddress,
        action: 'AUTH_LOGIN_DISABLED_ACCOUNT',
        targetType: 'USER',
        targetId: user.username,
        result: 'DENIED',
        errorCode: 'ACCOUNT_DISABLED',
      });
      res.status(403).json({
        error: 'ACCOUNT_DISABLED',
        message: 'บัญชีผู้ใช้งานนี้ถูกปิดการใช้งาน กรุณาติดต่อผู้ดูแลระบบ',
        requestId: req.requestId,
      });
      return;
    }

    // Clear rate limit on successful login
    await dbExecute('DELETE FROM auth_rate_limits WHERE rate_key = ?', [rateKey]);
    await dbExecute('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso, user.id]);

    const ttlSeconds = cfg.auth.sessionTtlMinutes * 60;
    const { token, jti, expiresAtIso } = signJwt(
      {
        sub: user.username,
        userId: user.id,
        role: user.role,
      },
      cfg.auth.jwtSecret,
      ttlSeconds
    );
    const csrfToken = computeCsrfToken(jti, cfg.auth.jwtSecret);
    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || cfg.nodeEnv === 'production';

    setAuthCookies(res, token, csrfToken, ttlSeconds, isSecure);

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: user.username,
      actorRole: user.role,
      ipAddress,
      action: 'AUTH_LOGIN_SUCCESS',
      targetType: 'USER',
      targetId: String(user.id),
      result: 'SUCCESS',
    });

    const cleanDisplayName = repairThaiMojibakeIfCorrupted(
      user.display_name,
      user.username === 'admin' ? 'ผู้ดูแลระบบสูงสุด (โรงพยาบาลสามชุก)' : user.username
    ).text;

    res.json({
      token,
      csrfToken,
      expiresAt: expiresAtIso,
      dataMode: cfg.dataMode,
      user: {
        id: user.id,
        username: user.username,
        displayName: cleanDisplayName,
        role: user.role,
        approvedPersonId: user.approved_person_id,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.get('/auth/me', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    const cfg = loadConfig();
    let personProfile = null;
    if (u.approvedPersonId) {
      const rows = await dbQuery<{
        person_id: string;
        fingle_id: string | null;
        full_name: string;
        position_name: string | null;
        department_name: string;
        personnel_type_name: string;
      }>(
        'SELECT person_id, fingle_id, full_name, position_name, department_name, personnel_type_name FROM personnel WHERE person_id = ? LIMIT 1',
        [u.approvedPersonId]
      );
      if (rows[0]) {
        personProfile = {
          ...rows[0],
          full_name: repairThaiMojibakeIfCorrupted(rows[0].full_name, rows[0].person_id).text,
          department_name: repairThaiMojibakeIfCorrupted(rows[0].department_name, '-').text,
          personnel_type_name: repairThaiMojibakeIfCorrupted(rows[0].personnel_type_name, '-').text,
        };
      }
    }

    const csrfToken = computeCsrfToken(u.jti, cfg.auth.jwtSecret);

    res.json({
      csrfToken,
      dataMode: cfg.dataMode,
      user: {
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        approvedPersonId: u.approvedPersonId,
        personProfile,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/logout', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    const cfg = loadConfig();
    const expiresAtIso = new Date(u.exp * 1000).toISOString().slice(0, 19).replace('T', ' ');
    await dbExecute(
      'INSERT IGNORE INTO revoked_sessions (jti, username, revoked_reason, expires_at) VALUES (?, ?, ?, ?)',
      [u.jti, u.username, 'USER_LOGOUT', expiresAtIso]
    );

    const isSecure = req.secure || req.headers['x-forwarded-proto'] === 'https' || cfg.nodeEnv === 'production';
    clearAuthCookies(res, isSecure);

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: u.username,
      actorRole: u.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'AUTH_LOGOUT',
      targetType: 'SESSION',
      targetId: u.jti,
      result: 'SUCCESS',
    });

    res.json({ status: 'LOGGED_OUT', requestId: req.requestId });
  } catch (err) {
    next(err);
  }
});

// ADMIN User & Account-to-PERSON_ID Management
authRouter.get('/users', requireAuth, requireRoles('ADMIN'), async (_req, res, next) => {
  try {
    const rows = await dbQuery<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      approved_person_id: string | null;
      is_active: number;
      last_login_at: string | null;
      created_at: string;
      full_name: string | null;
      department_name: string | null;
    }>(
      `SELECT u.id, u.username, u.display_name, u.role, u.approved_person_id,
              u.is_active, u.last_login_at, u.created_at,
              p.full_name, p.department_name
       FROM users u
       LEFT JOIN personnel p ON p.person_id = u.approved_person_id
       ORDER BY u.id ASC`
    );
    const items = rows.map((r) => ({
      ...r,
      display_name: repairThaiMojibakeIfCorrupted(r.display_name, r.username).text,
      full_name: r.full_name ? repairThaiMojibakeIfCorrupted(r.full_name, r.approved_person_id || '').text : null,
      department_name: r.department_name ? repairThaiMojibakeIfCorrupted(r.department_name, '-').text : null,
    }));
    res.json({ items });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/users', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const displayName = String(req.body?.displayName || '').trim();
    const role = String(req.body?.role || '') as UserRole;
    const approvedPersonId = req.body?.approvedPersonId ? String(req.body.approvedPersonId).trim() : null;

    if (!username || password.length < 8 || !displayName) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุ username, displayName และรหัสผ่านอย่างน้อย 8 ตัวอักษร',
        requestId: req.requestId,
      });
      return;
    }

    if (!['ADMIN', 'RESPONSIBLE_STAFF', 'GENERAL_USER'].includes(role)) {
      res.status(400).json({
        error: 'INVALID_ROLE',
        message: 'บทบาทต้องเป็น ADMIN, RESPONSIBLE_STAFF หรือ GENERAL_USER เท่านั้น',
        requestId: req.requestId,
      });
      return;
    }

    if (approvedPersonId) {
      const person = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE person_id = ? LIMIT 1',
        [approvedPersonId]
      );
      if (person.length === 0) {
        res.status(400).json({
          error: 'PERSON_ID_NOT_FOUND',
          message: `ไม่พบรหัสบุคลากร ${approvedPersonId} ในฐานข้อมูลที่ซิงก์จาก HOSOffice`,
          requestId: req.requestId,
        });
        return;
      }
    }

    const existing = await dbQuery<{ id: number }>('SELECT id FROM users WHERE username = ? LIMIT 1', [username]);
    if (existing.length > 0) {
      res.status(409).json({
        error: 'USERNAME_EXISTS',
        message: 'ชื่อผู้ใช้งานนี้มีอยู่ในระบบแล้ว',
        requestId: req.requestId,
      });
      return;
    }

    const result = await dbExecute(
      `INSERT INTO users (username, password_hash, display_name, role, approved_person_id, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [username, hashPassword(password), displayName, role, approvedPersonId]
    );

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'USER_CREATED',
      targetType: 'USER',
      targetId: String(result.insertId),
      result: 'SUCCESS',
      detail: { username, role, approvedPersonId },
    });

    res.status(201).json({
      id: result.insertId,
      username,
      displayName,
      role,
      approvedPersonId,
      isActive: 1,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.put('/users/:id', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    const role = String(req.body?.role || '') as UserRole;
    const isActive = req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : 1;
    const approvedPersonId = req.body?.approvedPersonId ? String(req.body.approvedPersonId).trim() : null;

    if (!['ADMIN', 'RESPONSIBLE_STAFF', 'GENERAL_USER'].includes(role)) {
      res.status(400).json({
        error: 'INVALID_ROLE',
        message: 'บทบาทต้องเป็น ADMIN, RESPONSIBLE_STAFF หรือ GENERAL_USER เท่านั้น',
        requestId: req.requestId,
      });
      return;
    }

    if (approvedPersonId) {
      const person = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE person_id = ? LIMIT 1',
        [approvedPersonId]
      );
      if (person.length === 0) {
        res.status(400).json({
          error: 'PERSON_ID_NOT_FOUND',
          message: `ไม่พบรหัสบุคลากร ${approvedPersonId} ในฐานข้อมูลบุคลากร`,
          requestId: req.requestId,
        });
        return;
      }
    }

    await dbExecute(
      'UPDATE users SET role = ?, approved_person_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [role, approvedPersonId, isActive, targetId]
    );

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'USER_UPDATED',
      targetType: 'USER',
      targetId: String(targetId),
      result: 'SUCCESS',
      detail: { role, approvedPersonId, isActive },
    });

    res.json({ status: 'UPDATED', id: targetId, role, approvedPersonId, isActive });
  } catch (err) {
    next(err);
  }
});
