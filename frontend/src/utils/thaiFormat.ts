/**
 * ============================================================================
 * โมดูลจัดการรูปแบบวันที่ภาษาไทย (พ.ศ.) และการคำนวณช่วงเวลา (Thai Date Formatter)
 * ไฟล์: frontend/src/utils/thaiFormat.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. formatThaiDate(): แปลงวันที่ 'YYYY-MM-DD' เป็นรูปแบบภาษาไทย พ.ศ. เช่น '13 พ.ย. 2569'
 * 2. formatThaiDateTime(): แปลงวันและเวลา 'YYYY-MM-DD HH:mm:ss' เป็น '13 พ.ย. 2569 · 07:50:12 น.'
 * 3. resolvePeriodRange(): คำนวณวันเริ่มต้น (dateFrom) และวันสิ้นสุด (dateTo)
 *    จากโหมดตัวกรอง 4 รูปแบบ (รายวัน, รายเดือน, รายปี, กำหนดช่วงวันที่เอง)
 */

// ชื่อเดือนภาษาไทยแบบย่อ
const THAI_SHORT_MONTHS = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.',
];

// ชื่อเดือนภาษาไทยแบบเต็ม
const THAI_FULL_MONTHS = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

/**
 * แปลงสตริงวันที่มาตรฐาน 'YYYY-MM-DD' เป็นวันที่ภาษาไทยศักราชพุทธ (พ.ศ. = ค.ศ. + 543)
 * ตัวอย่างผลลัพธ์: '13 พ.ย. 2569'
 */
export function formatThaiDate(dateStr?: string | null): string {
  if (!dateStr) return '-';
  const clean = dateStr.trim().slice(0, 10);
  const parts = clean.split('-');
  if (parts.length !== 3) return dateStr;
  const year = Number(parts[0]);
  const monthIdx = Number(parts[1]) - 1;
  const day = Number(parts[2]);
  if (Number.isNaN(year) || monthIdx < 0 || monthIdx > 11 || Number.isNaN(day)) {
    return dateStr;
  }
  const beYear = year + 543;
  return `${day} ${THAI_SHORT_MONTHS[monthIdx]} ${beYear}`;
}

/**
 * แปลงสตริงวันและเวลา 'YYYY-MM-DD HH:mm:ss' เป็นรูปแบบภาษาไทยพร้อมเวลา
 * ตัวอย่างผลลัพธ์: '13 พ.ย. 2569 · 07:50:12 น.'
 */
export function formatThaiDateTime(tsStr?: string | null): string {
  if (!tsStr) return '-';
  const trimmed = tsStr.trim().replace('T', ' ');
  const [datePart, timePart] = trimmed.split(' ');
  const thaiDate = formatThaiDate(datePart);
  if (!timePart) return thaiDate;
  return `${thaiDate} · ${timePart.slice(0, 8)} น.`;
}

// โหมดการเลือกช่วงเวลาทั้ง 4 รูปแบบที่ใช้ร่วมกันทุกหน้า
export type PeriodMode = 'DAILY' | 'MONTHLY' | 'YEARLY' | 'CUSTOM';

/**
 * ดึงค่าวันที่ปัจจุบันตามเขตเวลา Asia/Bangkok (+07:00) สำหรับใช้เป็นค่าเริ่มต้นแทนการ Hardcode วันที่คงที่
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
  const bkkMs = referenceDate.getTime() + 7 * 3600 * 1000;
  const bkkDate = new Date(bkkMs);
  const year = bkkDate.getUTCFullYear();
  const month = bkkDate.getUTCMonth() + 1;
  const day = bkkDate.getUTCDate();
  const hh = String(bkkDate.getUTCHours()).padStart(2, '0');
  const mi = String(bkkDate.getUTCMinutes()).padStart(2, '0');
  const ss = String(bkkDate.getUTCSeconds()).padStart(2, '0');

  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  const todayYmd = `${year}-${mm}-${dd}`;

  const yesterdayDate = new Date(bkkMs - 24 * 3600 * 1000);
  const yYear = yesterdayDate.getUTCFullYear();
  const yMonth = String(yesterdayDate.getUTCMonth() + 1).padStart(2, '0');
  const yDay = String(yesterdayDate.getUTCDate()).padStart(2, '0');
  const yesterdayYmd = `${yYear}-${yMonth}-${yDay}`;

  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthStartYmd = `${year}-${mm}-01`;
  const monthEndYmd = `${year}-${mm}-${String(lastDay).padStart(2, '0')}`;

  return {
    todayYmd,
    yesterdayYmd,
    currentYearMonth: `${year}-${mm}`,
    currentYear: String(year),
    monthStartYmd,
    monthEndYmd,
    nowDateTimeBkk: `${todayYmd} ${hh}:${mi}:${ss}`,
  };
}

/**
 * คำนวณค่า dateFrom, dateTo และป้ายกำกับภาษาไทย (thaiPeriodLabel)
 * ตามโหมดช่วงเวลาที่ผู้ใช้เลือกในแถบตัวกรอง PeriodFilterBar
 */
export function resolvePeriodRange(params: {
  mode: PeriodMode;
  dailyDate: string;
  monthValue: string; // รูปแบบ YYYY-MM
  yearValue: string;  // รูปแบบ YYYY
  customFrom: string;
  customTo: string;
}): { dateFrom: string; dateTo: string; thaiPeriodLabel: string } {
  const { mode, dailyDate, monthValue, yearValue, customFrom, customTo } = params;
  const bkk = getCurrentBangkokDateParts();

  if (mode === 'DAILY') {
    const activeDay = dailyDate || bkk.todayYmd;
    return {
      dateFrom: activeDay,
      dateTo: activeDay,
      thaiPeriodLabel: `รายวัน: ${formatThaiDate(activeDay)}`,
    };
  }

  if (mode === 'MONTHLY') {
    const [yStr, mStr] = (monthValue || bkk.currentYearMonth).split('-');
    const year = Number(yStr);
    const month = Number(mStr);
    // หาวันสุดท้ายของเดือนนั้น (เช่น 28, 29, 30 หรือ 31)
    const lastDay = new Date(year, month, 0).getDate();
    const mm = String(month).padStart(2, '0');
    const dd = String(lastDay).padStart(2, '0');
    const monthName = THAI_FULL_MONTHS[month - 1] || '';
    return {
      dateFrom: `${year}-${mm}-01`,
      dateTo: `${year}-${mm}-${dd}`,
      thaiPeriodLabel: `ประจำเดือน ${monthName} พ.ศ. ${year + 543}`,
    };
  }

  if (mode === 'YEARLY') {
    const year = Number(yearValue || bkk.currentYear);
    return {
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      thaiPeriodLabel: `ประจำปี พ.ศ. ${year + 543}`,
    };
  }

  return {
    dateFrom: customFrom || bkk.monthStartYmd,
    dateTo: customTo || bkk.monthEndYmd,
    thaiPeriodLabel: `ช่วงวันที่ ${formatThaiDate(customFrom || bkk.monthStartYmd)} ถึง ${formatThaiDate(customTo || bkk.monthEndYmd)}`,
  };
}
