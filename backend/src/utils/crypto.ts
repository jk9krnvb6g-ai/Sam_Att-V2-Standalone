import crypto from 'crypto';

export type UserRole = 'ADMIN' | 'RESPONSIBLE_STAFF' | 'GENERAL_USER';

export interface JwtPayload {
  sub: string; // username
  userId: number;
  role: UserRole;
  jti: string;
  iat: number;
  exp: number;
}

/**
 * Password Hashing with scrypt + 16-byte random salt.
 */
export function hashPassword(plainPassword: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

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
 * Normalizes a scanDateTime string to canonical Asia/Bangkok 'YYYY-MM-DD HH:mm:ss' format.
 * Rejects invalid date formats or out-of-range calendar values.
 */
export function normalizeBangkokScanDateTime(rawDateTime: string): string {
  const trimmed = String(rawDateTime || '').trim();
  // Match 'YYYY-MM-DD HH:mm:ss' or 'YYYY-MM-DDTHH:mm:ss' (+optional +07:00)
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
 * Computes deterministic SHA-256 deduplication key from the 6-field Scanner Reader EXE contract.
 */
export interface SixFieldScannerEvent {
  machineNo: number;
  enrollNumber: string;
  scanDateTime: string;
  verifyMode: number;
  inOutMode: number;
  workCode: number;
}

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
 * Protects CSV exports against Spreadsheet Formula Injection (CSV Injection).
 * Any cell starting with =, +, -, @, Tab, or CR is prefixed with an apostrophe.
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
