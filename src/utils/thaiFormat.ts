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
 * Formats 'YYYY-MM-DD' into Thai Buddhist Era format, e.g. '13 พ.ย. 2569'
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
 * Formats 'YYYY-MM-DD HH:mm:ss' into Thai Buddhist Era date + time, e.g. '13 พ.ย. 2569 · 07:50:12 น.'
 */
export function formatThaiDateTime(tsStr?: string | null): string {
  if (!tsStr) return '-';
  const trimmed = tsStr.trim().replace('T', ' ');
  const [datePart, timePart] = trimmed.split(' ');
  const thaiDate = formatThaiDate(datePart);
  if (!timePart) return thaiDate;
  return `${thaiDate} · ${timePart.slice(0, 8)} น.`;
}

export type PeriodMode = 'DAILY' | 'MONTHLY' | 'YEARLY' | 'CUSTOM';

export function resolvePeriodRange(params: {
  mode: PeriodMode;
  dailyDate: string;
  monthValue: string; // YYYY-MM
  yearValue: string;  // YYYY
  customFrom: string;
  customTo: string;
}): { dateFrom: string; dateTo: string; thaiPeriodLabel: string } {
  const { mode, dailyDate, monthValue, yearValue, customFrom, customTo } = params;

  if (mode === 'DAILY') {
    return {
      dateFrom: dailyDate,
      dateTo: dailyDate,
      thaiPeriodLabel: `รายวัน: ${formatThaiDate(dailyDate)}`,
    };
  }

  if (mode === 'MONTHLY') {
    const [yStr, mStr] = (monthValue || '2026-11').split('-');
    const year = Number(yStr);
    const month = Number(mStr);
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
    const year = Number(yearValue || '2026');
    return {
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
      thaiPeriodLabel: `ประจำปี พ.ศ. ${year + 543}`,
    };
  }

  return {
    dateFrom: customFrom,
    dateTo: customTo,
    thaiPeriodLabel: `ช่วงวันที่ ${formatThaiDate(customFrom)} ถึง ${formatThaiDate(customTo)}`,
  };
}
