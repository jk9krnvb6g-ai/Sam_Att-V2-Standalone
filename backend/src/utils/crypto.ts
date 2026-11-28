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

const WEAK_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '12345678',
  '123456789',
  '1234567890',
  'qwertyui',
  'admin123',
  'admin1234',
  'samatt123',
]);

/**
 * ตรวจสอบความแข็งแรงของรหัสผ่าน:
 * - ความยาวอย่างน้อย 8 ตัวอักษร (และไม่เกิน 128 ตัวอักษร)
 * - ต้องมีอักขระอย่างน้อย 2 ประเภท (ตัวพิมพ์เล็ก, ตัวพิมพ์ใหญ่, ตัวเลข, อักขระพิเศษ)
 * - ไม่อยู่ในรายการรหัสผ่านที่คาดเดาง่าย
 */
export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  const raw = String(password || '');
  if (raw.length < 8) {
    return { valid: false, reason: 'รหัสผ่านต้องมีความยาวอย่างน้อย 8 ตัวอักษร' };
  }
  if (raw.length > 128) {
    return { valid: false, reason: 'รหัสผ่านต้องมีความยาวไม่เกิน 128 ตัวอักษร' };
  }
  if (WEAK_PASSWORDS.has(raw.trim().toLowerCase())) {
    return { valid: false, reason: 'รหัสผ่านนี้คาดเดาง่ายเกินไป กรุณาตั้งรหัสผ่านที่ปลอดภัยกว่านี้' };
  }
  let classes = 0;
  if (/[a-z]/.test(raw)) classes += 1;
  if (/[A-Z]/.test(raw)) classes += 1;
  if (/[0-9]/.test(raw)) classes += 1;
  if (/[^A-Za-z0-9]/.test(raw)) classes += 1;
  if (classes < 2) {
    return {
      valid: false,
      reason: 'รหัสผ่านต้องประกอบด้วยอักขระอย่างน้อย 2 ประเภท (เช่น ตัวอักษรพิมพ์ใหญ่/เล็ก ตัวเลข หรือสัญลักษณ์)',
    };
  }
  return { valid: true };
}

/**
 * สร้างรหัสผ่านชั่วคราวแบบสุ่มด้วย CSPRNG (ความยาวค่าเริ่มต้น 12 ตัวอักษร)
 * หลีกเลี่ยงอักขระที่สับสนง่าย (0, O, 1, l, I) และรับประกันการมีอักขระครบทุกประเภท
 */
export function generateTemporaryPassword(length = 12): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const special = '@#$%&*!';
  const all = upper + lower + digits + special;
  const targetLen = Math.max(10, length);

  const chars: string[] = [
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    digits[crypto.randomInt(0, digits.length)],
    special[crypto.randomInt(0, special.length)],
  ];
  while (chars.length < targetLen) {
    chars.push(all[crypto.randomInt(0, all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
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
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):?(\d{2}))?$/.exec(
      trimmed
    );
  if (!match) {
    throw new Error(`INVALID_SCAN_DATETIME_FORMAT: ${rawDateTime}`);
  }
  const [, yyyy, mm, dd, hh, min, ss, tzToken, tzSign, tzHourStr, tzMinStr] = match;
  const year = Number(yyyy);
  const month = Number(mm);
  const day = Number(dd);
  const hour = Number(hh);
  const minute = Number(min);
  const second = Number(ss);

  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`OUT_OF_RANGE_SCAN_DATETIME: ${rawDateTime}`);
  }

  // ตรวจสอบว่าเป็นวันที่จริงตามปฏิทิน (ปฏิเสธเช่น 2026-02-30)
  const checkCal = new Date(Date.UTC(year, month - 1, day));
  if (
    checkCal.getUTCFullYear() !== year ||
    checkCal.getUTCMonth() + 1 !== month ||
    checkCal.getUTCDate() !== day
  ) {
    throw new Error(`OUT_OF_RANGE_SCAN_DATETIME: ${rawDateTime}`);
  }

  // หากระบุ Offset ที่ไม่ใช่ +07:00 (เช่น 'Z' หรือ '+00:00') ให้แปลงเป็นเวลา Asia/Bangkok (UTC+07:00)
  if (tzToken) {
    let offsetMinutes = 0;
    if (tzToken !== 'Z') {
      const tzH = Number(tzHourStr || 0);
      const tzM = Number(tzMinStr || 0);
      if (tzH > 14 || tzM > 59) {
        throw new Error(`INVALID_SCAN_DATETIME_FORMAT: ${rawDateTime}`);
      }
      offsetMinutes = (tzSign === '-' ? -1 : 1) * (tzH * 60 + tzM);
    }
    if (offsetMinutes !== 420) {
      const utcMs = Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
      const bkkDt = new Date(utcMs + 420 * 60_000);
      const bY = String(bkkDt.getUTCFullYear()).padStart(4, '0');
      const bM = String(bkkDt.getUTCMonth() + 1).padStart(2, '0');
      const bD = String(bkkDt.getUTCDate()).padStart(2, '0');
      const bH = String(bkkDt.getUTCHours()).padStart(2, '0');
      const bMin = String(bkkDt.getUTCMinutes()).padStart(2, '0');
      const bS = String(bkkDt.getUTCSeconds()).padStart(2, '0');
      return `${bY}-${bM}-${bD} ${bH}:${bMin}:${bS}`;
    }
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

/**
 * คำนวณค่าวันที่และเวลาปัจจุบันตามเขตเวลาประเทศไทย (Asia/Bangkok, UTC+07:00)
 * เพื่อใช้เป็นค่าเริ่มต้นแทนการ Hardcode วันที่คงที่
 */
export function getCurrentBangkokDateParts(referenceDate: Date = new Date()): {
  todayYmd: string;
  yesterdayYmd: string;
  currentYearMonth: string;
  currentYear: string;
  monthStartYmd: string;
  monthEndYmd: string;
  nowDateTimeBkk: string;
} {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = fmt.formatToParts(referenceDate);
  const map: Record<string, string> = {};
  for (const p of parts) {
    map[p.type] = p.value;
  }

  const year = Number(map.year || 2026);
  const month = Number(map.month || 1);
  const day = Number(map.day || 1);
  const hour = map.hour === '24' ? '00' : map.hour || '00';
  const minute = map.minute || '00';
  const second = map.second || '00';

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const todayYmd = `${year}-${mm}-${dd}`;
  const currentYearMonth = `${year}-${mm}`;
  const currentYear = String(year);
  const monthStartYmd = `${year}-${mm}-01`;
  const daysInMonth = new Date(year, month, 0).getDate();
  const monthEndYmd = `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`;

  const yesterdayDt = new Date(Date.UTC(year, month - 1, day - 1));
  const yYear = yesterdayDt.getUTCFullYear();
  const yMonth = String(yesterdayDt.getUTCMonth() + 1).padStart(2, '0');
  const yDay = String(yesterdayDt.getUTCDate()).padStart(2, '0');
  const yesterdayYmd = `${yYear}-${yMonth}-${yDay}`;

  return {
    todayYmd,
    yesterdayYmd,
    currentYearMonth,
    currentYear,
    monthStartYmd,
    monthEndYmd,
    nowDateTimeBkk: `${todayYmd} ${hour}:${minute}:${second}`,
  };
}

export function nowBkkString(): string {
  return getCurrentBangkokDateParts().nowDateTimeBkk;
}

/**
 * ตรวจสอบว่าข้อความมีลักษณะเป็นภาษาไทยเพี้ยน (Mojibake) จากการอ่าน UTF-8 เป็น TIS-620/Windows-874 หรือ Latin-1 หรือไม่
 * เช่น "เธเธนเน..." (เกิดจากไบต์ 0xE0 0xB8 / 0xE0 0xB9 ของ UTF-8 ถูกตีความเป็นอักษร 'เ'+'ธ' หรือ 'เ'+'น' ใน TIS-620)
 * หรือ "à¸..." (เกิดจากไบต์ 0xE0 0xB8 ถูกตีความเป็น Latin-1)
 */
export function hasThaiMojibake(value: unknown): boolean {
  if (typeof value !== 'string' || !value) return false;
  // รูปแบบที่ 1: UTF-8 ถูกอ่านเป็น TIS-620 / Windows-874 จะเกิดลำดับ "เธ" หรือ "เน" ซ้ำติดกันผิดธรรมชาติของภาษาไทย
  if (/(เธ[ก-ฮะ-์]|เน[ก-ฮะ-์]){2,}/.test(value) || /เธเธ|เธเน|เนเธ|เนเน/.test(value)) {
    return true;
  }
  // รูปแบบที่ 2: UTF-8 ถูกอ่านเป็น Latin-1 / Windows-1252 จะเกิดลำดับ "à¸" หรือ "à¹"
  if (/à[¸¹]/.test(value)) {
    return true;
  }
  // รูปแบบที่ 3: Replacement character
  if (value.includes('\uFFFD')) {
    return true;
  }
  return false;
}

/**
 * กู้คืนข้อความภาษาไทยที่ถูกแปลงผิดเป็น Latin-1 หรือ TIS-620 Mojibake (ถ้าสามารถย้อนกลับเป็น UTF-8 ที่ถูกต้องได้)
 */
export function repairThaiMojibakeIfCorrupted(
  value: string | null | undefined,
  fallbackCleanText?: string
): { text: string; wasCorrupted: boolean } {
  const raw = String(value || '');
  if (!raw) {
    return { text: raw, wasCorrupted: false };
  }
  if (!hasThaiMojibake(raw)) {
    return { text: raw, wasCorrupted: false };
  }

  // กรณีที่ 1: Latin-1 Mojibake ("à¸...") -> แปลงกลับด้วย Buffer.from(raw, 'latin1').toString('utf8')
  if (/à[¸¹]/.test(raw)) {
    try {
      const candidate = Buffer.from(raw, 'latin1').toString('utf8');
      if (!hasThaiMojibake(candidate) && /[\u0E01-\u0E5B]/.test(candidate)) {
        return { text: candidate, wasCorrupted: true };
      }
    } catch {
      // fall through
    }
  }

  // กรณีที่ 2: TIS-620 / Windows-874 Mojibake ("เธ..." / "เน...")
  // แปลงอักขระไทย U+0E01..U+0E5B กลับเป็นไบต์ TIS-620 (0xA1..0xFB)
  try {
    const bytes: number[] = [];
    let allMapped = true;
    for (let i = 0; i < raw.length; i++) {
      const code = raw.charCodeAt(i);
      if (code <= 0x7f) {
        bytes.push(code);
      } else if (code >= 0x0e01 && code <= 0x0e5b) {
        bytes.push(code - 0x0e00 + 0xa0);
      } else if (code >= 0x0080 && code <= 0x00ff) {
        bytes.push(code);
      } else {
        allMapped = false;
        break;
      }
    }
    if (allMapped && bytes.length > 0) {
      const decoded = Buffer.from(bytes).toString('utf8');
      if (!decoded.includes('\uFFFD') && !hasThaiMojibake(decoded) && /[\u0E01-\u0E5B]/.test(decoded)) {
        return { text: decoded, wasCorrupted: true };
      }
    }
  } catch {
    // fall through
  }

  if (fallbackCleanText) {
    return { text: fallbackCleanText, wasCorrupted: true };
  }
  return { text: raw, wasCorrupted: true };
}

