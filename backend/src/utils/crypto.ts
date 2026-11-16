/**
 * ============================================================================
 * โมดูลการเข้ารหัส ความปลอดภัย และการคำนวณรหัสป้องกันข้อมูลซ้ำ (Crypto & Security Utils)
 * ไฟล์: backend/src/utils/crypto.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. hashPassword / verifyPassword: เข้ารหัสและตรวจสอบรหัสผ่านด้วยอัลกอริทึม scrypt + Salt สุ่ม 16 ไบต์
 *    พร้อมใช้ timingSafeEqual เพื่อป้องกันการโจมตีแบบวัดเวลา (Timing Attack)
 * 2. signJwt / verifyJwt: สร้างและตรวจสอบโทเค็น JWT มาตรฐาน HS256 พร้อมรหัสประจำเซสชัน (jti)
 * 3. generateCryptographicSecret / verifyScannerIngestToken: สร้าง Secret แบบสุ่มที่ปลอดภัยทางคริปโต
 *    และตรวจสอบ Scanner Token ด้วย timingSafeEqual (แก้ไขปัญหา P0 ข้อ 03–04)
 * 4. computeCsrfToken / verifyCsrfToken / parseCookies: รองรับการยืนยันตัวตนด้วย HttpOnly, Secure,
 *    SameSite=Strict Cookie คู่กับ CSRF Token ที่ผูกกับรหัสเซสชัน jti (แก้ไขปัญหา P1 ข้อ 12)
 * 5. normalizeBangkokScanDateTime & computeRawScanDedupKey: คำนวณรหัส SHA-256 จากข้อมูลสแกน 6 ฟิลด์
 * 6. sanitizeCsvCell: ป้องกันช่องโหว่ Spreadsheet Formula Injection (CSV Injection) เวลาส่งออกไฟล์ Excel
 */
import crypto from 'crypto';

export type UserRole = 'ADMIN' | 'RESPONSIBLE_STAFF' | 'GENERAL_USER';

export interface JwtPayload {
  sub: string; // ชื่อบัญชีผู้ใช้งาน (username)
  userId: number;
  role: UserRole;
  jti: string; // รหัสอ้างอิงเซสชันสำหรับตรวจสอบการสั่ง Logout ในตาราง revoked_sessions
  iat: number;
  exp: number;
}

/**
 * สร้างรหัสลับแบบสุ่มที่มีความปลอดภัยสูงด้วย Cryptographically Secure Pseudo-Random Number Generator (CSPRNG)
 */
export function generateCryptographicSecret(byteLength = 48): string {
  return crypto.randomBytes(byteLength).toString('hex');
}

/**
 * ตรวจสอบโทเค็นของเครื่องสแกน (Scanner Ingest Shared Token) แบบคงที่เวลา (Timing-Safe Comparison)
 * เพื่อป้องกันการโจมตีแบบ Timing Side-Channel (แก้ไขปัญหา P0 ข้อ 04)
 */
export function verifyScannerIngestToken(providedToken: string, expectedToken: string): boolean {
  if (!providedToken || !expectedToken) {
    return false;
  }
  const a = Buffer.from(String(providedToken), 'utf8');
  const b = Buffer.from(String(expectedToken), 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * สร้าง CSRF Token ที่ผูกกับรหัสเซสชัน (jti) ด้วย HMAC-SHA256
 * สำหรับป้องกัน CSRF เมื่อใช้งานคู่กับ HttpOnly Session Cookie (แก้ไขปัญหา P1 ข้อ 12)
 */
export function computeCsrfToken(jti: string, secret: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(`csrf:${jti}`, 'utf8')
    .digest('hex');
}

/**
 * ตรวจสอบความถูกต้องของ CSRF Token แบบ Timing-Safe
 */
export function verifyCsrfToken(providedToken: string, jti: string, secret: string): boolean {
  if (!providedToken || !jti || !secret) {
    return false;
  }
  const expected = computeCsrfToken(jti, secret);
  const a = Buffer.from(String(providedToken), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/**
 * แยกค่า Cookie จาก HTTP Header `Cookie`
 */
export function parseCookies(cookieHeader?: string): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) {
    return result;
  }
  const pairs = cookieHeader.split(';');
  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      result[key] = decodeURIComponent(val);
    } catch {
      result[key] = val;
    }
  }
  return result;
}

/**
 * เข้ารหัสรหัสผ่านด้วยอัลกอริทึม scrypt พร้อมสุ่ม Salt ขนาด 16 ไบต์
 */
export function hashPassword(plainPassword: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

/**
 * ตรวจสอบรหัสผ่านที่ผู้ใช้กรอกเทียบกับค่า Hash ที่เก็บในฐานข้อมูลแบบคงที่เวลา (Timing-Safe)
 */
export function verifyPassword(plainPassword: string, storedHash: string): boolean {
  try {
    const parts = storedHash.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') {
      return false;
    }
    const [, salt, keyHex] = parts;
    const derivedKey = crypto.scryptSync(plainPassword, salt, 64);
    const storedKey = Buffer.from(keyHex, 'hex');
    if (derivedKey.length !== storedKey.length) {
      return false;
    }
    return crypto.timingSafeEqual(derivedKey, storedKey);
  } catch {
    return false;
  }
}

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(input: string): string {
  let padded = input.replace(/-/g, '+').replace(/_/g, '/');
  while (padded.length % 4 !== 0) {
    padded += '=';
  }
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * สร้างโทเค็น JWT (HS256) สำหรับผู้ใช้งานที่ล็อกอินสำเร็จ
 */
export function signJwt(
  payload: Omit<JwtPayload, 'iat' | 'exp' | 'jti'>,
  secret: string,
  ttlSeconds: number
): { token: string; jti: string; expiresAtIso: string } {
  const nowSec = Math.floor(Date.now() / 1000);
  const expSec = nowSec + ttlSeconds;
  const jti = crypto.randomUUID();

  const fullPayload: JwtPayload = {
    ...payload,
    jti,
    iat: nowSec,
    exp: expSec,
  };

  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = base64UrlEncode(JSON.stringify(fullPayload));
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  const expiresAtIso = new Date(expSec * 1000).toISOString().slice(0, 19).replace('T', ' ');
  return {
    token: `${header}.${body}.${signature}`,
    jti,
    expiresAtIso,
  };
}

/**
 * ตรวจสอบความถูกต้องของลายเซ็นและวันหมดอายุของโทเค็น JWT
 */
export function verifyJwt(token: string, secret: string): { valid: boolean; payload?: JwtPayload; reason?: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return { valid: false, reason: 'MALFORMED_TOKEN' };
    }
    const [header, body, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(`${header}.${body}`)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'INVALID_SIGNATURE' };
    }

    const payload = JSON.parse(base64UrlDecode(body)) as JwtPayload;
    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
      return { valid: false, reason: 'TOKEN_EXPIRED' };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false, reason: 'TOKEN_PARSE_ERROR' };
  }
}

/**
 * แปลงและตรวจสอบความถูกต้องของเวลาสแกนให้อยู่ในรูปแบบมาตรฐาน 'YYYY-MM-DD HH:mm:ss' (Asia/Bangkok)
 */
export function normalizeBangkokScanDateTime(rawDateTime: string): string {
  const trimmed = String(rawDateTime || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-]\d{2}:?\d{2}))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`INVALID_SCAN_DATETIME_FORMAT: ${rawDateTime}`);
  }
  const [, yyyy, mm, dd, hh, min, ss] = match;
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(min);
  const second = Number(ss);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`OUT_OF_RANGE_SCAN_DATETIME: ${rawDateTime}`);
  }
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

/**
 * โครงสร้างข้อมูลสแกน 6 ฟิลด์ตามสัญญามาตรฐานของโปรแกรม ScannerReader.exe
 */
export interface SixFieldScannerEvent {
  machineNo: number;
  enrollNumber: string;
  scanDateTime: string;
  verifyMode: number;
  inOutMode: number;
  workCode: number;
}

/**
 * คำนวณรหัสป้องกันข้อมูลซ้ำ (SHA-256 Deduplication Key) จากค่าทั้ง 6 ฟิลด์ของเครื่องสแกน
 * หากดึงข้อมูลสแกนซ้ำจากเครื่องเดิม ระบบจะได้ค่า dedupKey เดิมและข้ามการบันทึกซ้ำโดยอัตโนมัติ
 */
export function computeRawScanDedupKey(event: SixFieldScannerEvent): {
  dedupKey: string;
  canonicalBkkTime: string;
} {
  const canonicalBkkTime = normalizeBangkokScanDateTime(event.scanDateTime);
  const canonicalString = [
    Number(event.machineNo),
    String(event.enrollNumber).trim(),
    canonicalBkkTime,
    Number(event.verifyMode),
    Number(event.inOutMode),
    Number(event.workCode),
  ].join('|');

  const dedupKey = crypto.createHash('sha256').update(canonicalString, 'utf8').digest('hex');
  return { dedupKey, canonicalBkkTime };
}

/**
 * ป้องกันช่องโหว่ Spreadsheet Formula Injection (CSV Injection)
 * หากข้อมูลในช่องเริ่มต้นด้วยเครื่องหมาย =, +, -, @, Tab หรือ CR จะเติมเครื่องหมาย ' นำหน้าเสมอ
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '""';
  }
  let str = String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}
