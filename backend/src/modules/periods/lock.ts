import { dbQuery } from '../../database/adapter.ts';

export interface ClosedPeriodInfo {
  closed: boolean;
  periodYm: string;
  status: string;
  closedBy: string | null;
  closedAt: string | null;
}

export function extractYearMonth(dateInput: unknown): string {
  const str = String(dateInput ?? '').trim();
  const match = /^(\d{4}-\d{2})/.exec(str);
  return match ? match[1] : '';
}

export function enumerateMonthsInRange(dateFrom: string, dateTo: string): string[] {
  const startYm = extractYearMonth(dateFrom);
  const endYm = extractYearMonth(dateTo);
  if (!/^\d{4}-\d{2}$/.test(startYm) || !/^\d{4}-\d{2}$/.test(endYm) || startYm > endYm) {
    return [];
  }
  const [sy, sm] = startYm.split('-').map(Number);
  const [ey, em] = endYm.split('-').map(Number);
  const result: string[] = [];
  let y = sy;
  let m = sm;
  let guard = 0;
  while ((y < ey || (y === ey && m <= em)) && guard < 120) {
    result.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    guard += 1;
  }
  return result;
}

export async function isPeriodClosed(workDateOrYm: unknown): Promise<ClosedPeriodInfo> {
  const periodYm = extractYearMonth(workDateOrYm);
  if (!/^\d{4}-\d{2}$/.test(periodYm)) {
    return { closed: false, periodYm: '', status: 'OPEN', closedBy: null, closedAt: null };
  }
  try {
    const rows = await dbQuery<{
      period_ym: string;
      status: string;
      closed_by: string | null;
      closed_at: string | null;
    }>(
      'SELECT period_ym, status, closed_by, closed_at FROM attendance_periods WHERE period_ym = ? LIMIT 1',
      [periodYm]
    );
    if (rows.length === 0) {
      return { closed: false, periodYm, status: 'OPEN', closedBy: null, closedAt: null };
    }
    const row = rows[0];
    return {
      closed: String(row.status || '').toUpperCase() === 'CLOSED',
      periodYm,
      status: String(row.status || 'OPEN').toUpperCase(),
      closedBy: row.closed_by ?? null,
      closedAt: row.closed_at ? String(row.closed_at) : null,
    };
  } catch {
    return { closed: false, periodYm, status: 'OPEN', closedBy: null, closedAt: null };
  }
}

export async function findClosedPeriodsInRange(
  dateFrom: string,
  dateTo: string
): Promise<string[]> {
  const months = enumerateMonthsInRange(dateFrom, dateTo);
  if (months.length === 0) return [];
  try {
    const placeholders = months.map(() => '?').join(', ');
    const rows = await dbQuery<{ period_ym: string }>(
      `SELECT period_ym FROM attendance_periods WHERE status = 'CLOSED' AND period_ym IN (${placeholders}) ORDER BY period_ym ASC`,
      months
    );
    return rows.map((r) => String(r.period_ym));
  } catch {
    return [];
  }
}

export async function findClosedPeriodsInDates(dates: string[]): Promise<string[]> {
  const months = Array.from(
    new Set(dates.map((d) => extractYearMonth(d)).filter((ym) => /^\d{4}-\d{2}$/.test(ym)))
  ).sort();
  if (months.length === 0) return [];
  try {
    const placeholders = months.map(() => '?').join(', ');
    const rows = await dbQuery<{ period_ym: string }>(
      `SELECT period_ym FROM attendance_periods WHERE status = 'CLOSED' AND period_ym IN (${placeholders}) ORDER BY period_ym ASC`,
      months
    );
    return rows.map((r) => String(r.period_ym));
  } catch {
    return [];
  }
}
