/**
 * ============================================================================
 * โมดูลตรวจสอบและจัดการช่วงวันที่และเวลาสำหรับการดึงข้อมูลเครื่องสแกน
 * ไฟล์: backend/src/modules/scanners/syncRange.ts
 * ============================================================================
 * หน้าที่หลัก:
 * - รองรับ 3 โหมดการดึงข้อมูล:
 *   1. TODAY        : ดึงเฉพาะข้อมูลสแกนของวันนี้ (00:00:00 - 23:59:59 เขตเวลา Asia/Bangkok)
 *   2. CUSTOM_RANGE : ดึงตามช่วงวันที่และเวลาที่ผู้ใช้ระบุ (รองรับข้ามวันและข้ามเดือน)
 *   3. ALL          : ดึงข้อมูลทั้งหมดในช่วงสูงสุดที่ระบบและโปรแกรมอ่านเครื่องสแกนรองรับ
 * - ตรวจสอบความถูกต้องของวันที่และเวลาแบบเข้มงวด (ปฏิเสธวันที่ไม่มีอยู่จริง, รูปแบบผิด,
 *   เวลาเริ่มต้นมากกว่าเวลาสิ้นสุด หรือช่วงวันเกินขีดจำกัดสูงสุดของระบบ)
 * - คำนวณจำนวนวันย้อนหลัง (`--days`) ที่ต้องส่งให้ `ScannerSyncCli.exe` อย่างปลอดภัย
 *   และระบุกลไกการคัดกรองจริง (`BACKEND_POST_READ_FILTER` vs `NO_POST_READ_FILTER`) อย่างโปร่งใส
 */
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';

export type ScannerSyncMode = 'TODAY' | 'CUSTOM_RANGE' | 'ALL';

export type ScannerFilterStrategy =
  | 'BACKEND_POST_READ_FILTER'
  | 'EXE_DAYS_WINDOW_NO_POST_FILTER'
  | 'ALL_DEVICE_EVENTS_NO_POST_FILTER';

export interface ScannerSyncRangeInput {
  syncMode?: string | null;
  dateFrom?: string | null;
  timeFrom?: string | null;
  dateTo?: string | null;
  timeTo?: string | null;
}

export interface ResolvedScannerSyncRange {
  syncMode: ScannerSyncMode;
  timezone: 'Asia/Bangkok';
  filterFromBkk: string | null;
  filterToBkk: string | null;
  dateFrom: string | null;
  timeFrom: string | null;
  dateTo: string | null;
  timeTo: string | null;
  spanDays: number | null;
  exeDaysArg: number;
  filterStrategy: ScannerFilterStrategy;
  exeSupportsNativeDateTimeRange: false;
  filterModeNotice: string;
}

export class ScannerSyncRangeError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'ScannerSyncRangeError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * ตรวจสอบว่าสตริง YYYY-MM-DD เป็นวันที่จริงตามปฏิทิน (ปฏิเสธ 2026-02-30 หรือเดือน 13)
 */
export function isValidYmdDate(ymd: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() + 1 === month &&
    dt.getUTCDate() === day
  );
}

/**
 * แปลงและตรวจสอบเวลา HH:mm หรือ HH:mm:ss
 * คืนค่า { normalized: 'HH:mm:ss', minuteKey: 'HH:mm' }
 */
export function parseTimeOfDay(
  rawTime: string,
  boundary: 'start' | 'end'
): { normalized: string; compareBase: string } | null {
  const trimmed = rawTime.trim();
  const hhmm = /^(\d{2}):(\d{2})$/.exec(trimmed);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    const base = `${hhmm[1]}:${hhmm[2]}`;
    return {
      normalized: `${base}:${boundary === 'start' ? '00' : '59'}`,
      compareBase: `${base}:00`,
    };
  }

  const hhmmss = /^(\d{2}):(\d{2}):(\d{2})$/.exec(trimmed);
  if (hhmmss) {
    const h = Number(hhmmss[1]);
    const m = Number(hhmmss[2]);
    const s = Number(hhmmss[3]);
    if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) return null;
    const full = `${hhmmss[1]}:${hhmmss[2]}:${hhmmss[3]}`;
    return {
      normalized: full,
      compareBase: full,
    };
  }

  return null;
}

/**
 * คำนวณจำนวนวันปฏิทินระหว่าง startYmd ถึง endYmd (end - start)
 */
export function diffCalendarDaysYmd(startYmd: string, endYmd: string): number {
  const [sy, sm, sd] = startYmd.split('-').map(Number);
  const [ey, em, ed] = endYmd.split('-').map(Number);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  return Math.round((endUtc - startUtc) / 86_400_000);
}

/**
 * ตรวจสอบและแปลงพารามิเตอร์ช่วงวันที่และเวลาสำหรับสั่งดึงข้อมูลจากเครื่องสแกน
 * ใช้เขตเวลา Asia/Bangkok (UTC+07:00) อย่างสม่ำเสมอ
 */
export function validateAndNormalizeScannerSyncRange(
  input: ScannerSyncRangeInput | undefined,
  options: {
    maxRangeDays: number;
    defaultExeSyncDays: number;
    isScannerSyncCli: boolean;
    isScheduledSync?: boolean;
    referenceDate?: Date;
  }
): ResolvedScannerSyncRange {
  const maxRangeDays = Math.max(1, Math.min(365, Math.floor(options.maxRangeDays || 90)));
  const defaultExeSyncDays = Math.max(1, Math.min(maxRangeDays, Math.floor(options.defaultExeSyncDays || 3)));
  const bkk = getCurrentBangkokDateParts(options.referenceDate || new Date());

  const hasExplicitRangeFields = Boolean(
    input?.dateFrom || input?.dateTo || input?.timeFrom || input?.timeTo
  );

  const rawMode = String(input?.syncMode || '').trim().toUpperCase();
  let syncMode: ScannerSyncMode;

  if (!rawMode) {
    syncMode = hasExplicitRangeFields ? 'CUSTOM_RANGE' : 'ALL';
  } else if (rawMode === 'TODAY' || rawMode === 'CUSTOM_RANGE' || rawMode === 'ALL') {
    syncMode = rawMode;
  } else {
    throw new ScannerSyncRangeError(
      'INVALID_SYNC_MODE',
      `โหมดการดึงข้อมูลไม่ถูกต้อง (${rawMode}) รองรับเฉพาะ TODAY, CUSTOM_RANGE หรือ ALL`
    );
  }

  if (syncMode === 'TODAY') {
    const filterFromBkk = `${bkk.todayYmd} 00:00:00`;
    const filterToBkk = `${bkk.todayYmd} 23:59:59`;
    const exeDaysArg = 1;
    const filterModeNotice = options.isScannerSyncCli
      ? `โปรแกรม ScannerSyncCli.exe อ่านข้อมูลย้อนหลัง 1 วัน (--days 1) แล้วระบบ Backend คัดกรองเฉพาะเวลาสแกนในวันนี้ (${filterFromBkk} ถึง ${filterToBkk} เวลาประเทศไทย) ก่อนบันทึกลงฐานข้อมูล`
      : `ระบบอ่านข้อมูลจากโปรแกรมเครื่องสแกน แล้วคัดกรองเฉพาะเวลาสแกนในวันนี้ (${filterFromBkk} ถึง ${filterToBkk} เวลาประเทศไทย) บน Backend ก่อนบันทึกลงฐานข้อมูล`;

    return {
      syncMode: 'TODAY',
      timezone: 'Asia/Bangkok',
      filterFromBkk,
      filterToBkk,
      dateFrom: bkk.todayYmd,
      timeFrom: '00:00:00',
      dateTo: bkk.todayYmd,
      timeTo: '23:59:59',
      spanDays: 1,
      exeDaysArg,
      filterStrategy: 'BACKEND_POST_READ_FILTER',
      exeSupportsNativeDateTimeRange: false,
      filterModeNotice,
    };
  }

  if (syncMode === 'ALL') {
    // สำหรับรอบซิงก์อัตโนมัติยังคงใช้ SCANNER_SYNC_DAYS เดิมเพื่อความเร็ว
    // สำหรับการเลือก "ดึงข้อมูลทั้งหมดที่เครื่องรองรับ" ด้วยตนเอง จะดึงครอบคลุมสูงสุดตามขีดจำกัดที่ระบบรองรับ
    const exeDaysArg = options.isScheduledSync ? defaultExeSyncDays : maxRangeDays;
    const filterStrategy: ScannerFilterStrategy = options.isScannerSyncCli
      ? 'EXE_DAYS_WINDOW_NO_POST_FILTER'
      : 'ALL_DEVICE_EVENTS_NO_POST_FILTER';
    const filterModeNotice = options.isScannerSyncCli
      ? `ดึงข้อมูลทั้งหมดที่โปรแกรม ScannerSyncCli.exe รองรับภายในกรอบสูงสุด ${exeDaysArg} วันย้อนหลัง (--days ${exeDaysArg}) โดยไม่ตัดช่วงเวลาย่อย และตรวจสอบรายการซ้ำอัตโนมัติ`
      : 'ดึงข้อมูลทั้งหมดที่โปรแกรมอ่านเครื่องสแกนส่งกลับมาโดยไม่ตัดช่วงเวลา และตรวจสอบรายการซ้ำอัตโนมัติ';

    return {
      syncMode: 'ALL',
      timezone: 'Asia/Bangkok',
      filterFromBkk: null,
      filterToBkk: null,
      dateFrom: null,
      timeFrom: null,
      dateTo: null,
      timeTo: null,
      spanDays: null,
      exeDaysArg,
      filterStrategy,
      exeSupportsNativeDateTimeRange: false,
      filterModeNotice,
    };
  }

  // CUSTOM_RANGE
  const dateFrom = String(input?.dateFrom || '').trim();
  const dateTo = String(input?.dateTo || '').trim();
  const rawTimeFrom = String(input?.timeFrom ?? '00:00').trim() || '00:00';
  const rawTimeTo = String(input?.timeTo ?? '23:59').trim() || '23:59';

  if (!dateFrom || !dateTo) {
    throw new ScannerSyncRangeError(
      'INVALID_DATE_TIME_RANGE',
      'กรุณาระบุทั้งตั้งแต่วันที่และถึงวันที่สำหรับการดึงข้อมูลแบบเลือกช่วงเวลา'
    );
  }

  if (!isValidYmdDate(dateFrom)) {
    throw new ScannerSyncRangeError(
      'INVALID_DATE_TIME_RANGE',
      `รูปแบบหรือค่าของ "ตั้งแต่วันที่" ไม่ถูกต้อง (${dateFrom}) กรุณาระบุเป็น YYYY-MM-DD ที่ถูกต้องตามปฏิทิน`
    );
  }

  if (!isValidYmdDate(dateTo)) {
    throw new ScannerSyncRangeError(
      'INVALID_DATE_TIME_RANGE',
      `รูปแบบหรือค่าของ "ถึงวันที่" ไม่ถูกต้อง (${dateTo}) กรุณาระบุเป็น YYYY-MM-DD ที่ถูกต้องตามปฏิทิน`
    );
  }

  const parsedStart = parseTimeOfDay(rawTimeFrom, 'start');
  if (!parsedStart) {
    throw new ScannerSyncRangeError(
      'INVALID_DATE_TIME_RANGE',
      `รูปแบบ "เวลาเริ่มต้น" ไม่ถูกต้อง (${rawTimeFrom}) กรุณาระบุเป็น HH:mm หรือ HH:mm:ss`
    );
  }

  const parsedEnd = parseTimeOfDay(rawTimeTo, 'end');
  if (!parsedEnd) {
    throw new ScannerSyncRangeError(
      'INVALID_DATE_TIME_RANGE',
      `รูปแบบ "เวลาสิ้นสุด" ไม่ถูกต้อง (${rawTimeTo}) กรุณาระบุเป็น HH:mm หรือ HH:mm:ss`
    );
  }

  const startCompare = `${dateFrom} ${parsedStart.compareBase}`;
  const endCompare = `${dateTo} ${parsedEnd.compareBase}`;
  if (startCompare > endCompare) {
    throw new ScannerSyncRangeError(
      'INVALID_DATE_TIME_RANGE',
      `วันและเวลาเริ่มต้น (${dateFrom} ${rawTimeFrom}) ต้องไม่มากกว่าวันและเวลาสิ้นสุด (${dateTo} ${rawTimeTo})`
    );
  }

  const spanDays = diffCalendarDaysYmd(dateFrom, dateTo) + 1;
  if (spanDays > maxRangeDays) {
    throw new ScannerSyncRangeError(
      'DATE_RANGE_EXCEEDED',
      `ช่วงวันที่ที่เลือก (${spanDays} วัน) เกินขีดจำกัดสูงสุดที่ระบบรองรับ (${maxRangeDays} วันต่อรอบ) กรุณาแบ่งดึงข้อมูลเป็นช่วงไม่เกิน ${maxRangeDays} วัน`
    );
  }

  const filterFromBkk = `${dateFrom} ${parsedStart.normalized}`;
  const filterToBkk = `${dateTo} ${parsedEnd.normalized}`;

  // คำนวณจำนวนวันย้อนหลังจากวันนี้ (Asia/Bangkok) เพื่อให้ ScannerSyncCli.exe ดึงย้อนหลังครอบคลุมถึง dateFrom
  const daysBackFromToday = diffCalendarDaysYmd(dateFrom, bkk.todayYmd) + 1;
  const exeDaysArg = Math.max(1, Math.min(365, Math.max(daysBackFromToday, spanDays)));

  const filterModeNotice = options.isScannerSyncCli
    ? `โปรแกรม ScannerSyncCli.exe ไม่รองรับพารามิเตอร์ช่วงเวลาตรงบนตัวเครื่อง ระบบจะอ่านข้อมูลย้อนหลังครอบคลุม (--days ${exeDaysArg}) แล้วคัดกรองเฉพาะรายการสแกนในช่วง ${filterFromBkk} ถึง ${filterToBkk} (Asia/Bangkok) บน Backend ก่อนบันทึกลงฐานข้อมูล`
    : `ระบบอ่านข้อมูลจากโปรแกรมเครื่องสแกน แล้วคัดกรองเฉพาะรายการสแกนในช่วง ${filterFromBkk} ถึง ${filterToBkk} (Asia/Bangkok) บน Backend ก่อนบันทึกลงฐานข้อมูล`;

  return {
    syncMode: 'CUSTOM_RANGE',
    timezone: 'Asia/Bangkok',
    filterFromBkk,
    filterToBkk,
    dateFrom,
    timeFrom: parsedStart.normalized,
    dateTo,
    timeTo: parsedEnd.normalized,
    spanDays,
    exeDaysArg,
    filterStrategy: 'BACKEND_POST_READ_FILTER',
    exeSupportsNativeDateTimeRange: false,
    filterModeNotice,
  };
}

/**
 * ตรวจสอบว่าเวลาสแกนมาตรฐาน (Asia/Bangkok 'YYYY-MM-DD HH:mm:ss') อยู่ในช่วงที่เลือกหรือไม่
 */
export function isCanonicalBkkTimeInRange(
  canonicalBkkTime: string,
  filterFromBkk: string | null,
  filterToBkk: string | null
): boolean {
  if (!filterFromBkk || !filterToBkk) {
    return true;
  }
  return canonicalBkkTime >= filterFromBkk && canonicalBkkTime <= filterToBkk;
}
