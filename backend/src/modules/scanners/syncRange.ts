/**
 * ============================================================================
 * โมดูลตรวจสอบและจัดการช่วงวันที่และเวลาสำหรับการดึงข้อมูลเครื่องสแกน
 * ไฟล์: backend/src/modules/scanners/syncRange.ts
 * ============================================================================
 * หน้าที่หลัก:
 * - รองรับ 4 โหมดการดึงข้อมูล:
 *   1. TODAY           : ดึงเฉพาะข้อมูลสแกนของวันนี้ (00:00:00 - 23:59:59 เขตเวลา Asia/Bangkok)
 *   2. CUSTOM_RANGE    : ดึงตามช่วงวันที่และเวลาที่ผู้ใช้ระบุ (รองรับข้ามวันและข้ามเดือน)
 *   3. MONTHLY         : ดึงข้อมูลแบบรายเดือน (YYYY-MM) ตามปฏิทินเขตเวลา Asia/Bangkok
 *   4. FULL_HISTORICAL : ดึงข้อมูลทั้งหมดที่เครื่องรองรับ (ADMIN ONLY, รองรับ alias ALL / ALL_SUPPORTED)
 * - บังคับสิทธิ์ตาม Role ฝั่ง Server โดยอ้างอิงเวลาปัจจุบันของ Server ในเขตเวลา Asia/Bangkok:
 *   - ADMIN             : ดึงได้ทุกโหมดรวมถึง FULL_HISTORICAL และรายเดือนย้อนหลัง
 *   - RESPONSIBLE_STAFF : ห้ามสั่ง FULL_HISTORICAL และจำกัดเฉพาะเดือนปัจจุบัน + เดือนก่อนหน้า 1 เดือนปฏิทิน
 * - คำนวณ `--days` สำหรับ ScannerSyncCli.exe และระบุข้อจำกัด EXE อย่างโปร่งใส
 */
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';

export type ScannerSyncMode = 'TODAY' | 'CUSTOM_RANGE' | 'MONTHLY' | 'FULL_HISTORICAL' | 'ALL';
export type CanonicalImportType = 'TODAY' | 'CUSTOM_RANGE' | 'MONTHLY' | 'FULL_HISTORICAL';

export type ScannerFilterStrategy =
  | 'BACKEND_POST_READ_FILTER'
  | 'EXE_DAYS_WINDOW_NO_POST_FILTER'
  | 'ALL_DEVICE_EVENTS_NO_POST_FILTER';

export interface ScannerSyncRangeInput {
  syncMode?: string | null;
  yearMonth?: string | null;
  dateFrom?: string | null;
  timeFrom?: string | null;
  dateTo?: string | null;
  timeTo?: string | null;
}

export interface ResolvedScannerSyncRange {
  syncMode: ScannerSyncMode;
  canonicalImportType: CanonicalImportType;
  yearMonth: string | null;
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
  exeLimitationWarning: string | null;
}

export interface ResponsibleStaffMonthWindow {
  serverTodayBkkYmd: string;
  currentYearMonth: string;
  previousYearMonth: string;
  earliestAllowedYmd: string;
  allowedYearMonths: [string, string];
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
 * แปลงและตรวจสอบเดือนปฏิทิน YYYY-MM (รองรับปีอธิกสุรทินและเดือน 28/29/30/31 วันอย่างแม่นยำ)
 */
export function parseYearMonthBounds(rawYearMonth: string): {
  year: number;
  month: number;
  yearMonth: string;
  dateFrom: string;
  dateTo: string;
  daysInMonth: number;
} | null {
  const trimmed = String(rawYearMonth || '').trim();
  const match = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  return {
    year,
    month,
    yearMonth: ym,
    dateFrom: `${ym}-01`,
    dateTo: `${ym}-${String(daysInMonth).padStart(2, '0')}`,
    daysInMonth,
  };
}

/**
 * คำนวณกรอบเดือนปฏิทินที่สิทธิ์ RESPONSIBLE_STAFF ได้รับอนุญาตโดยอ้างอิงเวลาปัจจุบันของ Server (Asia/Bangkok):
 * เฉพาะ "เดือนปัจจุบัน" และ "เดือนก่อนหน้า 1 เดือนปฏิทิน" (ไม่ใช่ rolling 60 วัน)
 * รองรับรอยต่อปี เช่น ม.ค. 2027 -> อนุญาต 2027-01 และ 2026-12 (เริ่มตั้งแต่ 2026-12-01)
 */
export function getResponsibleStaffMonthWindow(referenceDate?: Date): ResponsibleStaffMonthWindow {
  const bkk = getCurrentBangkokDateParts(referenceDate || new Date());
  const [currentYear, currentMonth] = bkk.currentYearMonth.split('-').map(Number);
  const currentYearMonth = `${currentYear}-${String(currentMonth).padStart(2, '0')}`;
  const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;
  const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
  const previousYearMonth = `${prevYear}-${String(prevMonth).padStart(2, '0')}`;
  const earliestAllowedYmd = `${previousYearMonth}-01`;

  return {
    serverTodayBkkYmd: bkk.todayYmd,
    currentYearMonth,
    previousYearMonth,
    earliestAllowedYmd,
    allowedYearMonths: [previousYearMonth, currentYearMonth],
  };
}

/**
 * บังคับตรวจสิทธิ์ตาม Role และกรอบเดือนปฏิทินฝั่ง Server (Asia/Bangkok)
 * ใช้ร่วมกันทั้งการดึงข้อมูลจากเครื่องสแกน (TODAY / CUSTOM_RANGE / MONTHLY / FULL_HISTORICAL),
 * การ Reprocess Attendance และการ Resolve Unmatched Raw Scans เพื่อป้องกันการ Bypass
 */
export function assertRoleAuthorizedForDateRange(params: {
  role: string;
  syncMode?: string | null;
  yearMonth?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  referenceDate?: Date;
}): ResponsibleStaffMonthWindow {
  const role = String(params.role || '').trim().toUpperCase();
  const window = getResponsibleStaffMonthWindow(params.referenceDate);

  if (role === 'ADMIN') {
    return window;
  }

  if (role !== 'RESPONSIBLE_STAFF') {
    throw new ScannerSyncRangeError(
      'FORBIDDEN',
      'ไม่มีสิทธิ์ดำเนินการกับช่วงข้อมูลนี้',
      403
    );
  }

  const normalizedMode = String(params.syncMode || '').trim().toUpperCase();
  if (
    normalizedMode === 'ALL' ||
    normalizedMode === 'ALL_SUPPORTED' ||
    normalizedMode === 'FULL_HISTORICAL'
  ) {
    throw new ScannerSyncRangeError(
      'FULL_HISTORICAL_ADMIN_ONLY',
      'การดึงข้อมูลทั้งหมดย้อนหลัง (Full Historical Import) อนุญาตเฉพาะผู้ดูแลระบบ (ADMIN) เท่านั้น สิทธิ์เจ้าหน้าที่ผู้รับผิดชอบสามารถดึงข้อมูลรายวันหรือรายเดือนได้เฉพาะเดือนปัจจุบันและเดือนก่อนหน้า 1 เดือน',
      403
    );
  }

  if (normalizedMode === 'MONTHLY') {
    const ym = String(params.yearMonth || '').trim();
    if (!window.allowedYearMonths.includes(ym)) {
      throw new ScannerSyncRangeError(
        'STAFF_MONTHLY_WINDOW_FORBIDDEN',
        `สิทธิ์เจ้าหน้าที่ผู้รับผิดชอบสามารถดึงข้อมูลรายเดือนได้เฉพาะเดือนปัจจุบัน (${window.currentYearMonth}) และเดือนก่อนหน้า 1 เดือน (${window.previousYearMonth}) ตามเวลาประเทศไทยเท่านั้น`,
        403
      );
    }
    return window;
  }

  const dateFrom = String(params.dateFrom || '').trim();
  if (dateFrom && isValidYmdDate(dateFrom) && dateFrom < window.earliestAllowedYmd) {
    throw new ScannerSyncRangeError(
      'STAFF_DATE_WINDOW_FORBIDDEN',
      `สิทธิ์เจ้าหน้าที่ผู้รับผิดชอบไม่สามารถดำเนินการกับข้อมูลย้อนหลังเกินเดือนก่อนหน้า 1 เดือนปฏิทินได้ (อนุญาตตั้งแต่ ${window.earliestAllowedYmd} เป็นต้นไป ตามเวลาประเทศไทย)`,
      403
    );
  }

  return window;
}

/**
 * แปลงและตรวจสอบเวลา HH:mm หรือ HH:mm:ss
 * คืนค่า { normalized: 'HH:mm:ss', compareBase: 'HH:mm:ss' }
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
  const hasYearMonth = Boolean(String(input?.yearMonth || '').trim());

  const rawMode = String(input?.syncMode || '').trim().toUpperCase();
  let syncMode: ScannerSyncMode;

  if (!rawMode) {
    if (hasYearMonth) {
      syncMode = 'MONTHLY';
    } else if (hasExplicitRangeFields) {
      syncMode = 'CUSTOM_RANGE';
    } else {
      syncMode = 'ALL';
    }
  } else if (
    rawMode === 'TODAY' ||
    rawMode === 'CUSTOM_RANGE' ||
    rawMode === 'MONTHLY' ||
    rawMode === 'FULL_HISTORICAL' ||
    rawMode === 'ALL'
  ) {
    syncMode = rawMode;
  } else if (rawMode === 'ALL_SUPPORTED') {
    syncMode = 'ALL';
  } else {
    throw new ScannerSyncRangeError(
      'INVALID_SYNC_MODE',
      `โหมดการดึงข้อมูลไม่ถูกต้อง (${rawMode}) รองรับเฉพาะ TODAY, CUSTOM_RANGE, MONTHLY, FULL_HISTORICAL หรือ ALL`
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
      canonicalImportType: 'TODAY',
      yearMonth: null,
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
      exeLimitationWarning: null,
    };
  }

  if (syncMode === 'MONTHLY') {
    const rawYm = String(input?.yearMonth || '').trim();
    const bounds = parseYearMonthBounds(rawYm);
    if (!bounds) {
      throw new ScannerSyncRangeError(
        'INVALID_YEAR_MONTH',
        `รูปแบบเดือนที่เลือกไม่ถูกต้อง (${rawYm || 'ว่าง'}) กรุณาระบุเป็น YYYY-MM เช่น 2026-11`
      );
    }

    const filterFromBkk = `${bounds.dateFrom} 00:00:00`;
    const filterToBkk = `${bounds.dateTo} 23:59:59`;
    const daysBackFromToday = Math.max(1, diffCalendarDaysYmd(bounds.dateFrom, bkk.todayYmd) + 1);
    const exeDaysArg = Math.max(1, Math.min(365, Math.max(daysBackFromToday, bounds.daysInMonth)));
    const exeLimitationWarning =
      options.isScannerSyncCli && daysBackFromToday > 365
        ? `โปรแกรม ScannerSyncCli.exe เดิมรองรับพารามิเตอร์ --days สูงสุด 365 วัน (เดือนที่เลือกย้อนหลัง ${daysBackFromToday} วัน) ข้อมูลที่เก่ากว่า 365 วันหรือถูกลบจากหน่วยความจำเครื่องสแกนอาจไม่สามารถดึงกลับมาได้`
        : options.isScannerSyncCli && daysBackFromToday > maxRangeDays
          ? `เดือนที่เลือกย้อนหลัง ${daysBackFromToday} วัน ระบบจะส่ง --days ${exeDaysArg} ให้ ScannerSyncCli.exe และคัดกรองเฉพาะเดือน ${bounds.yearMonth} ทั้งนี้ข้อมูลที่ดึงได้ขึ้นกับความจุหน่วยความจำของเครื่องสแกนแต่ละเครื่อง`
          : null;

    const filterModeNotice = options.isScannerSyncCli
      ? `ดึงข้อมูลรายเดือน ${bounds.yearMonth} (${filterFromBkk} ถึง ${filterToBkk} เวลาประเทศไทย) โดยส่ง --days ${exeDaysArg} ให้ ScannerSyncCli.exe แล้วคัดกรองเฉพาะรายการในเดือนที่เลือกบน Backend พร้อมกันข้อมูลซ้ำอัตโนมัติ`
      : `ดึงข้อมูลรายเดือน ${bounds.yearMonth} (${filterFromBkk} ถึง ${filterToBkk} เวลาประเทศไทย) โดยคัดกรองเฉพาะรายการในเดือนที่เลือกบน Backend พร้อมกันข้อมูลซ้ำอัตโนมัติ`;

    return {
      syncMode: 'MONTHLY',
      canonicalImportType: 'MONTHLY',
      yearMonth: bounds.yearMonth,
      timezone: 'Asia/Bangkok',
      filterFromBkk,
      filterToBkk,
      dateFrom: bounds.dateFrom,
      timeFrom: '00:00:00',
      dateTo: bounds.dateTo,
      timeTo: '23:59:59',
      spanDays: bounds.daysInMonth,
      exeDaysArg,
      filterStrategy: 'BACKEND_POST_READ_FILTER',
      exeSupportsNativeDateTimeRange: false,
      filterModeNotice,
      exeLimitationWarning,
    };
  }

  if (syncMode === 'ALL' || syncMode === 'FULL_HISTORICAL') {
    const exeDaysArg = options.isScheduledSync
      ? defaultExeSyncDays
      : syncMode === 'FULL_HISTORICAL'
        ? Math.max(maxRangeDays, 365)
        : maxRangeDays;
    const filterStrategy: ScannerFilterStrategy = options.isScannerSyncCli
      ? 'EXE_DAYS_WINDOW_NO_POST_FILTER'
      : 'ALL_DEVICE_EVENTS_NO_POST_FILTER';
    const exeLimitationWarning = options.isScannerSyncCli
      ? `ข้อจำกัดจริงของ ScannerSyncCli.exe เดิม: รองรับเฉพาะพารามิเตอร์ --days สูงสุด ${exeDaysArg} วันย้อนหลัง และจำนวนข้อมูลที่ได้จริงขึ้นกับความจุหน่วยความจำของเครื่องสแกนแต่ละเครื่อง (ไม่แก้ไขไฟล์ EXE เดิม)`
      : 'จำนวนข้อมูลย้อนหลังที่ได้จริงขึ้นกับความจุหน่วยความจำของเครื่องสแกนแต่ละเครื่องและไฟล์โปรแกรมอ่านเครื่องสแกนเดิม';
    const filterModeNotice = options.isScannerSyncCli
      ? `ดึงข้อมูลทั้งหมดที่โปรแกรม ScannerSyncCli.exe รองรับภายในกรอบสูงสุด ${exeDaysArg} วันย้อนหลัง (--days ${exeDaysArg}) โดยไม่ตัดช่วงเวลาย่อย และตรวจสอบรายการซ้ำอัตโนมัติ`
      : 'ดึงข้อมูลทั้งหมดที่โปรแกรมอ่านเครื่องสแกนส่งกลับมาโดยไม่ตัดช่วงเวลา และตรวจสอบรายการซ้ำอัตโนมัติ';

    return {
      syncMode,
      canonicalImportType: 'FULL_HISTORICAL',
      yearMonth: null,
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
      exeLimitationWarning,
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
    canonicalImportType: 'CUSTOM_RANGE',
    yearMonth: null,
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
    exeLimitationWarning: null,
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
