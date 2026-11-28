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
  validatePasswordStrength,
  generateTemporaryPassword,
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
      must_change_password?: number;
    }>(
      'SELECT id, username, password_hash, display_name, role, approved_person_id, is_active, must_change_password FROM users WHERE username = ? LIMIT 1',
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
        mustChangePassword: Number(user.must_change_password || 0) === 1,
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
        mustChangePassword: u.mustChangePassword,
        personProfile,
      },
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    const u = req.user!;
    const currentPassword = String(req.body?.currentPassword || '');
    const newPassword = String(req.body?.newPassword || '');

    if (!currentPassword || !newPassword) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุรหัสผ่านปัจจุบันและรหัสผ่านใหม่',
        requestId: req.requestId,
      });
      return;
    }

    const rows = await dbQuery<{ id: number; password_hash: string }>(
      'SELECT id, password_hash FROM users WHERE id = ? LIMIT 1',
      [u.id]
    );
    if (!rows[0] || !verifyPassword(currentPassword, rows[0].password_hash)) {
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: u.username,
        actorRole: u.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'AUTH_PASSWORD_CHANGE_FAILED',
        targetType: 'USER',
        targetId: String(u.id),
        result: 'FAILURE',
        errorCode: 'INVALID_CURRENT_PASSWORD',
      });
      res.status(401).json({
        error: 'INVALID_CURRENT_PASSWORD',
        message: 'รหัสผ่านปัจจุบันไม่ถูกต้อง',
        requestId: req.requestId,
      });
      return;
    }

    if (currentPassword === newPassword) {
      res.status(400).json({
        error: 'PASSWORD_UNCHANGED',
        message: 'รหัสผ่านใหม่ต้องแตกต่างจากรหัสผ่านปัจจุบัน',
        requestId: req.requestId,
      });
      return;
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      res.status(400).json({
        error: 'WEAK_PASSWORD',
        message: strength.reason || 'รหัสผ่านใหม่ไม่ตรงตามเกณฑ์ความปลอดภัย',
        requestId: req.requestId,
      });
      return;
    }

    await dbExecute(
      `UPDATE users
       SET password_hash = ?,
           must_change_password = 0,
           password_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [hashPassword(newPassword), u.id]
    );

    await dbExecute('DELETE FROM auth_rate_limits WHERE rate_key = ?', [`login:${u.username.toLowerCase()}`]);

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: u.username,
      actorRole: u.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'AUTH_PASSWORD_CHANGED',
      targetType: 'USER',
      targetId: String(u.id),
      result: 'SUCCESS',
      detail: { username: u.username, clearedForcedChange: true },
    });

    res.json({
      status: 'PASSWORD_CHANGED',
      mustChangePassword: false,
      requestId: req.requestId,
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
      must_change_password?: number;
      password_updated_at?: string | null;
      last_login_at: string | null;
      created_at: string;
      full_name: string | null;
      department_name: string | null;
    }>(
      `SELECT u.id, u.username, u.display_name, u.role, u.approved_person_id,
              u.is_active, u.must_change_password, u.password_updated_at,
              u.last_login_at, u.created_at,
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
      must_change_password: Number(r.must_change_password || 0),
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
    const mustChangePassword = req.body?.mustChangePassword ? 1 : 0;

    if (!username || !password || !displayName) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุ username, displayName และรหัสผ่านอย่างน้อย 8 ตัวอักษร',
        requestId: req.requestId,
      });
      return;
    }

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      res.status(400).json({
        error: 'WEAK_PASSWORD',
        message: strength.reason || 'รหัสผ่านไม่ตรงตามเกณฑ์ความปลอดภัย',
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
      `INSERT INTO users (username, password_hash, display_name, role, approved_person_id, is_active, must_change_password)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [username, hashPassword(password), displayName, role, approvedPersonId, mustChangePassword]
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
      detail: { username, role, approvedPersonId, mustChangePassword: Boolean(mustChangePassword) },
    });

    res.status(201).json({
      id: result.insertId,
      username,
      displayName,
      role,
      approvedPersonId,
      isActive: 1,
      mustChangePassword: Boolean(mustChangePassword),
    });
  } catch (err) {
    next(err);
  }
});

async function countActiveAdmins(): Promise<number> {
  const rows = await dbQuery<{ cnt: number }>(
    "SELECT COUNT(*) AS cnt FROM users WHERE role = 'ADMIN' AND is_active = 1"
  );
  return Number(rows[0]?.cnt || 0);
}

authRouter.put('/users/:id', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: 'INVALID_USER_ID', message: 'รหัสบัญชีผู้ใช้ไม่ถูกต้อง', requestId: req.requestId });
      return;
    }

    const existingRows = await dbQuery<{
      id: number;
      username: string;
      display_name: string;
      role: UserRole;
      approved_person_id: string | null;
      is_active: number;
    }>(
      'SELECT id, username, display_name, role, approved_person_id, is_active FROM users WHERE id = ? LIMIT 1',
      [targetId]
    );
    const existing = existingRows[0];
    if (!existing) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'ไม่พบบัญชีผู้ใช้งานที่ต้องการแก้ไข',
        requestId: req.requestId,
      });
      return;
    }

    const nextRole = (req.body?.role !== undefined ? String(req.body.role) : existing.role) as UserRole;
    const nextIsActive =
      req.body?.isActive !== undefined ? (req.body.isActive ? 1 : 0) : Number(existing.is_active);
    const nextDisplayName =
      req.body?.displayName !== undefined
        ? String(req.body.displayName || '').trim()
        : existing.display_name;
    const nextApprovedPersonId =
      req.body?.approvedPersonId !== undefined
        ? req.body.approvedPersonId
          ? String(req.body.approvedPersonId).trim()
          : null
        : existing.approved_person_id;

    if (!nextDisplayName) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุชื่อ-นามสกุลที่แสดงในระบบ',
        requestId: req.requestId,
      });
      return;
    }

    if (!['ADMIN', 'RESPONSIBLE_STAFF', 'GENERAL_USER'].includes(nextRole)) {
      res.status(400).json({
        error: 'INVALID_ROLE',
        message: 'บทบาทต้องเป็น ADMIN, RESPONSIBLE_STAFF หรือ GENERAL_USER เท่านั้น',
        requestId: req.requestId,
      });
      return;
    }

    if (targetId === req.user!.id && nextIsActive === 0) {
      res.status(409).json({
        error: 'CANNOT_DISABLE_SELF',
        message: 'ไม่สามารถระงับการใช้งานบัญชีของตนเองที่กำลังเข้าสู่ระบบอยู่ได้',
        requestId: req.requestId,
      });
      return;
    }

    if (
      existing.role === 'ADMIN' &&
      Number(existing.is_active) === 1 &&
      (nextRole !== 'ADMIN' || nextIsActive !== 1)
    ) {
      const adminCount = await countActiveAdmins();
      if (adminCount <= 1) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'USER_UPDATE_BLOCKED',
          targetType: 'USER',
          targetId: String(targetId),
          result: 'BLOCKED',
          errorCode: 'LAST_ADMIN_PROTECTED',
        });
        res.status(409).json({
          error: 'LAST_ADMIN_PROTECTED',
          message: 'ไม่สามารถลดสิทธิ์หรือปิดการใช้งานผู้ดูแลระบบ (ADMIN) คนสุดท้ายที่เปิดใช้งานอยู่ได้',
          requestId: req.requestId,
        });
        return;
      }
    }

    if (nextApprovedPersonId) {
      const person = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE person_id = ? LIMIT 1',
        [nextApprovedPersonId]
      );
      if (person.length === 0) {
        res.status(400).json({
          error: 'PERSON_ID_NOT_FOUND',
          message: `ไม่พบรหัสบุคลากร ${nextApprovedPersonId} ในฐานข้อมูลบุคลากร`,
          requestId: req.requestId,
        });
        return;
      }
    }

    await dbExecute(
      'UPDATE users SET display_name = ?, role = ?, approved_person_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [nextDisplayName, nextRole, nextApprovedPersonId, nextIsActive, targetId]
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
      detail: {
        username: existing.username,
        displayName: nextDisplayName,
        role: nextRole,
        approvedPersonId: nextApprovedPersonId,
        isActive: nextIsActive,
      },
    });

    res.json({
      status: 'UPDATED',
      id: targetId,
      displayName: nextDisplayName,
      role: nextRole,
      approvedPersonId: nextApprovedPersonId,
      isActive: nextIsActive,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.patch('/users/:id/status', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: 'INVALID_USER_ID', message: 'รหัสบัญชีผู้ใช้ไม่ถูกต้อง', requestId: req.requestId });
      return;
    }

    if (typeof req.body?.isActive !== 'boolean') {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาระบุสถานะ isActive (true หรือ false)',
        requestId: req.requestId,
      });
      return;
    }

    const nextIsActive = req.body.isActive ? 1 : 0;
    const rows = await dbQuery<{
      id: number;
      username: string;
      role: UserRole;
      is_active: number;
    }>('SELECT id, username, role, is_active FROM users WHERE id = ? LIMIT 1', [targetId]);
    const existing = rows[0];
    if (!existing) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'ไม่พบบัญชีผู้ใช้งานที่ต้องการเปลี่ยนสถานะ',
        requestId: req.requestId,
      });
      return;
    }

    if (targetId === req.user!.id && nextIsActive === 0) {
      res.status(409).json({
        error: 'CANNOT_DISABLE_SELF',
        message: 'ไม่สามารถระงับการใช้งานบัญชีของตนเองที่กำลังเข้าสู่ระบบอยู่ได้',
        requestId: req.requestId,
      });
      return;
    }

    if (existing.role === 'ADMIN' && Number(existing.is_active) === 1 && nextIsActive === 0) {
      const adminCount = await countActiveAdmins();
      if (adminCount <= 1) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'USER_STATUS_BLOCKED',
          targetType: 'USER',
          targetId: String(targetId),
          result: 'BLOCKED',
          errorCode: 'LAST_ADMIN_PROTECTED',
        });
        res.status(409).json({
          error: 'LAST_ADMIN_PROTECTED',
          message: 'ไม่สามารถระงับการใช้งานผู้ดูแลระบบ (ADMIN) คนสุดท้ายได้',
          requestId: req.requestId,
        });
        return;
      }
    }

    await dbExecute(
      'UPDATE users SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [nextIsActive, targetId]
    );

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'USER_STATUS_UPDATED',
      targetType: 'USER',
      targetId: String(targetId),
      result: 'SUCCESS',
      detail: { username: existing.username, isActive: nextIsActive },
    });

    res.json({
      status: 'UPDATED',
      id: targetId,
      username: existing.username,
      isActive: nextIsActive,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/users/:id/reset-password', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.id);
    if (!Number.isInteger(targetId) || targetId <= 0) {
      res.status(400).json({ error: 'INVALID_USER_ID', message: 'รหัสบัญชีผู้ใช้ไม่ถูกต้อง', requestId: req.requestId });
      return;
    }

    const rows = await dbQuery<{ id: number; username: string; display_name: string }>(
      'SELECT id, username, display_name FROM users WHERE id = ? LIMIT 1',
      [targetId]
    );
    const target = rows[0];
    if (!target) {
      res.status(404).json({
        error: 'USER_NOT_FOUND',
        message: 'ไม่พบบัญชีผู้ใช้งานที่ต้องการรีเซ็ตรหัสผ่าน',
        requestId: req.requestId,
      });
      return;
    }

    const temporaryPassword = generateTemporaryPassword(12);
    await dbExecute(
      `UPDATE users
       SET password_hash = ?,
           must_change_password = 1,
           password_updated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [hashPassword(temporaryPassword), targetId]
    );

    await dbExecute('DELETE FROM auth_rate_limits WHERE rate_key = ?', [
      `login:${target.username.toLowerCase()}`,
    ]);

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'USER_PASSWORD_RESET',
      targetType: 'USER',
      targetId: String(targetId),
      result: 'SUCCESS',
      detail: { username: target.username, mustChangePassword: true },
    });

    res.json({
      status: 'PASSWORD_RESET',
      id: targetId,
      username: target.username,
      displayName: repairThaiMojibakeIfCorrupted(target.display_name, target.username).text,
      temporaryPassword,
      mustChangePassword: true,
      requestId: req.requestId,
    });
  } catch (err) {
    next(err);
  }
});

function buildSuggestedUsername(personId: string, fingleId: string | null): string {
  const rawBase = String(personId || fingleId || '').trim().toLowerCase();
  const sanitized = rawBase.replace(/[^a-z0-9._-]/g, '');
  if (sanitized.length >= 3) {
    return sanitized;
  }
  const fClean = String(fingleId || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (fClean.length >= 3) {
    return fClean;
  }
  return `staff_${sanitized || fClean || 'user'}`;
}

authRouter.get('/users/bulk-candidates', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const department = String(req.query.department || '').trim();
    const personnelType = String(req.query.personnelType || '').trim();
    const search = String(req.query.search || '').trim().toLowerCase();

    const conditions = ['p.is_active = 1'];
    const params: unknown[] = [];
    if (department) {
      conditions.push('p.department_name = ?');
      params.push(department);
    }
    if (personnelType) {
      conditions.push('p.personnel_type_code = ?');
      params.push(personnelType);
    }

    const [personnelRows, existingUsers] = await Promise.all([
      dbQuery<{
        person_id: string;
        full_name: string;
        department_name: string;
        position_name: string;
        personnel_type_code: string;
        personnel_type_name: string;
        fingle_id: string | null;
      }>(
        `SELECT p.person_id, p.full_name, p.department_name, p.position_name,
                p.personnel_type_code, p.personnel_type_name, p.fingle_id
         FROM personnel p
         WHERE ${conditions.join(' AND ')}
         ORDER BY p.department_name ASC, p.full_name ASC`,
        params
      ),
      dbQuery<{ username: string; approved_person_id: string | null }>(
        'SELECT username, approved_person_id FROM users'
      ),
    ]);

    const existingUsernames = new Set(existingUsers.map((u) => String(u.username || '').toLowerCase()));
    const linkedPersonIds = new Set(
      existingUsers
        .map((u) => (u.approved_person_id ? String(u.approved_person_id).trim() : ''))
        .filter(Boolean)
    );

    const candidates = personnelRows
      .filter((p) => !linkedPersonIds.has(String(p.person_id).trim()))
      .map((p) => {
        const pid = String(p.person_id).trim();
        const fullName = repairThaiMojibakeIfCorrupted(p.full_name, pid).text;
        const departmentName = repairThaiMojibakeIfCorrupted(p.department_name, '-').text;
        const positionName = repairThaiMojibakeIfCorrupted(p.position_name, '-').text;
        const personnelTypeName = repairThaiMojibakeIfCorrupted(p.personnel_type_name, '-').text;
        const suggestedUsername = buildSuggestedUsername(pid, p.fingle_id);
        return {
          personId: pid,
          fullName,
          departmentName,
          positionName,
          personnelTypeCode: p.personnel_type_code,
          personnelTypeName,
          fingleId: p.fingle_id,
          suggestedUsername,
          usernameExists: existingUsernames.has(suggestedUsername.toLowerCase()),
        };
      })
      .filter((c) => {
        if (!search) return true;
        return (
          c.personId.toLowerCase().includes(search) ||
          c.fullName.toLowerCase().includes(search) ||
          c.departmentName.toLowerCase().includes(search) ||
          c.suggestedUsername.toLowerCase().includes(search)
        );
      });

    res.json({
      items: candidates,
      summary: {
        totalActivePersonnel: personnelRows.length,
        alreadyLinkedCount: personnelRows.length - candidates.length,
        availableCandidateCount: candidates.length,
      },
      requestId: req.requestId,
    });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/users/bulk-create', requireAuth, requireRoles('ADMIN'), async (req, res, next) => {
  try {
    const rawCandidates = Array.isArray(req.body?.candidates) ? req.body.candidates : [];
    const defaultRoleRaw = String(req.body?.defaultRole || 'GENERAL_USER').trim().toUpperCase();

    if (rawCandidates.length === 0) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 รายการสำหรับสร้างบัญชีผู้ใช้แบบกลุ่ม',
        requestId: req.requestId,
      });
      return;
    }

    if (rawCandidates.length > 500) {
      res.status(400).json({
        error: 'BATCH_LIMIT_EXCEEDED',
        message: 'รองรับการสร้างบัญชีผู้ใช้แบบกลุ่มสูงสุด 500 รายการต่อครั้ง',
        requestId: req.requestId,
      });
      return;
    }

    const hasForbiddenAdminRole =
      defaultRoleRaw === 'ADMIN' ||
      rawCandidates.some(
        (c: { role?: unknown }) => String(c?.role || '').trim().toUpperCase() === 'ADMIN'
      );
    if (hasForbiddenAdminRole) {
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'USERS_BULK_CREATE_BLOCKED',
        targetType: 'USER_BATCH',
        targetId: String(rawCandidates.length),
        result: 'BLOCKED',
        errorCode: 'BULK_ADMIN_CREATION_FORBIDDEN',
      });
      res.status(403).json({
        error: 'BULK_ADMIN_CREATION_FORBIDDEN',
        message: 'ไม่อนุญาตให้สร้างบัญชีบทบาท ADMIN แบบกลุ่ม เพื่อความปลอดภัยของระบบ',
        requestId: req.requestId,
      });
      return;
    }

    const existingUsers = await dbQuery<{ username: string; approved_person_id: string | null }>(
      'SELECT username, approved_person_id FROM users'
    );
    const usedUsernames = new Set(existingUsers.map((u) => String(u.username || '').toLowerCase()));
    const linkedPersonIds = new Set(
      existingUsers
        .map((u) => (u.approved_person_id ? String(u.approved_person_id).trim() : ''))
        .filter(Boolean)
    );

    const personnelRows = await dbQuery<{
      person_id: string;
      full_name: string;
      department_name: string;
      fingle_id: string | null;
      is_active: number;
    }>('SELECT person_id, full_name, department_name, fingle_id, is_active FROM personnel');
    const personById = new Map(personnelRows.map((p) => [String(p.person_id).trim(), p]));

    const created: Array<{
      id: number;
      personId: string;
      username: string;
      displayName: string;
      departmentName: string;
      role: 'GENERAL_USER' | 'RESPONSIBLE_STAFF';
      temporaryPassword: string;
      mustChangePassword: true;
    }> = [];
    const failed: Array<{
      personId: string;
      username: string;
      reasonCode: string;
      message: string;
    }> = [];

    for (const item of rawCandidates as Array<{
      personId?: unknown;
      username?: unknown;
      displayName?: unknown;
      role?: unknown;
    }>) {
      const personId = String(item?.personId || '').trim();
      const requestedRole = String(item?.role || defaultRoleRaw || 'GENERAL_USER')
        .trim()
        .toUpperCase();
      const role: 'GENERAL_USER' | 'RESPONSIBLE_STAFF' =
        requestedRole === 'RESPONSIBLE_STAFF' ? 'RESPONSIBLE_STAFF' : 'GENERAL_USER';

      if (!personId) {
        failed.push({
          personId: '',
          username: '',
          reasonCode: 'INVALID_PERSON_ID',
          message: 'ไม่ระบุรหัสบุคลากร',
        });
        continue;
      }

      const person = personById.get(personId);
      if (!person || Number(person.is_active) !== 1) {
        failed.push({
          personId,
          username: String(item?.username || ''),
          reasonCode: 'PERSONNEL_NOT_FOUND',
          message: `ไม่พบบุคลากรที่เปิดใช้งานรหัส ${personId}`,
        });
        continue;
      }

      const username = String(
        item?.username || buildSuggestedUsername(personId, person.fingle_id)
      )
        .trim()
        .replace(/\s+/g, '');

      if (!/^[a-zA-Z0-9._-]{3,64}$/.test(username)) {
        failed.push({
          personId,
          username,
          reasonCode: 'INVALID_USERNAME',
          message: `ชื่อผู้ใช้ "${username}" ต้องมี 3-64 ตัวอักษร (a-z, 0-9, ., _, -)`,
        });
        continue;
      }

      if (linkedPersonIds.has(personId)) {
        failed.push({
          personId,
          username,
          reasonCode: 'PERSON_ALREADY_LINKED',
          message: `บุคลากร ${personId} มีบัญชีผู้ใช้งานผูกอยู่แล้ว`,
        });
        continue;
      }

      if (usedUsernames.has(username.toLowerCase())) {
        failed.push({
          personId,
          username,
          reasonCode: 'USERNAME_EXISTS',
          message: `ชื่อผู้ใช้ "${username}" ซ้ำกับบัญชีที่มีอยู่ในระบบ`,
        });
        continue;
      }

      const displayName = String(
        item?.displayName || repairThaiMojibakeIfCorrupted(person.full_name, personId).text
      ).trim();
      const departmentName = repairThaiMojibakeIfCorrupted(person.department_name, '-').text;
      const temporaryPassword = generateTemporaryPassword(12);
      const passwordHash = hashPassword(temporaryPassword);

      const ins = await dbExecute(
        `INSERT INTO users (username, password_hash, display_name, role, approved_person_id, is_active, must_change_password)
         VALUES (?, ?, ?, ?, ?, 1, 1)`,
        [username, passwordHash, displayName, role, personId]
      );

      usedUsernames.add(username.toLowerCase());
      linkedPersonIds.add(personId);

      created.push({
        id: Number(ins.insertId),
        personId,
        username,
        displayName,
        departmentName,
        role,
        temporaryPassword,
        mustChangePassword: true,
      });
    }

    // บันทึก Audit Log เฉพาะจำนวนและรายการ username/personId โดยห้ามเก็บรหัสผ่านเด็ดขาด
    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'USERS_BULK_CREATED',
      targetType: 'USER_BATCH',
      targetId: `${created.length}/${rawCandidates.length}`,
      result:
        failed.length === rawCandidates.length
          ? 'FAILURE'
          : failed.length > 0
            ? 'PARTIAL_SUCCESS'
            : 'SUCCESS',
      detail: {
        totalRequested: rawCandidates.length,
        createdCount: created.length,
        failedCount: failed.length,
        createdAccounts: created.map((c) => ({
          id: c.id,
          username: c.username,
          personId: c.personId,
          role: c.role,
          mustChangePassword: true,
        })),
        failedReasons: failed.slice(0, 20),
      },
    });

    res.status(created.length > 0 ? 201 : 400).json({
      totalRequested: rawCandidates.length,
      createdCount: created.length,
      failedCount: failed.length,
      created,
      failed,
      requestId: req.requestId,
    });
  } catch (err) {
    next(err);
  }
});
