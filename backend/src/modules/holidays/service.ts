import { dbQuery } from '../../database/adapter.ts';
import type { PublicHolidayRow } from '../shifts/routes.ts';

export interface HospitalHolidayRow {
  id: number;
  holiday_date: string;
  holiday_name: string;
  category: string;
  scope_type: string;
  department_name: string | null;
  person_id: string | null;
  override_policy: string;
  is_active: number;
  notes: string | null;
  created_by: string;
  updated_by: string | null;
  created_at?: string;
  updated_at?: string;
  sourceTable?: 'hospital_holidays' | 'public_holidays';
}

export const ALLOWED_HOLIDAY_CATEGORIES = new Set([
  'NATIONAL',
  'COMPENSATORY',
  'SPECIAL',
  'WEEKLY',
]);

export function normalizeHolidayDateYmd(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return '';
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Asia/Bangkok',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(raw);
  }
  const str = String(raw).trim();
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(str);
  return match ? match[1] : str;
}

export function mapLegacyHolidayTypeToCategory(holidayType: string): string {
  const upper = String(holidayType || '').trim().toUpperCase();
  if (ALLOWED_HOLIDAY_CATEGORIES.has(upper)) return upper;
  if (upper === 'COMPENSATORY_HOLIDAY') return 'COMPENSATORY';
  if (upper === 'SPECIAL_HOLIDAY' || upper === 'HOSPITAL_SPECIAL') return 'SPECIAL';
  if (upper === 'WEEKLY_OFF') return 'WEEKLY';
  return 'NATIONAL';
}

/**
 * โหลดข้อมูลวันหยุดแบบรวม (hospital_holidays + public_holidays) สำหรับช่วงวันที่ที่กำหนด
 * ใช้ร่วมกันระหว่างระบบตารางเวร, ประมวลผลเวลาปฏิบัติงาน และปฏิทินวันหยุดโรงพยาบาล
 */
export async function loadHospitalHolidaysForRange(
  dateFrom: string,
  dateTo: string,
  options?: { includeInactive?: boolean }
): Promise<HospitalHolidayRow[]> {
  const fromStr = normalizeHolidayDateYmd(dateFrom);
  const toStr = normalizeHolidayDateYmd(dateTo);
  const activeClause = options?.includeInactive ? '1=1' : 'is_active = 1';
  const rows: HospitalHolidayRow[] = [];
  const seenAllKeys = new Set<string>();

  try {
    const hhRows = await dbQuery<HospitalHolidayRow>(
      `SELECT id, holiday_date, holiday_name, category, scope_type, department_name,
              person_id, override_policy, is_active, notes, created_by, updated_by,
              created_at, updated_at
       FROM hospital_holidays
       WHERE ${activeClause} AND holiday_date >= ? AND holiday_date <= ?
       ORDER BY holiday_date ASC, id ASC`,
      [fromStr, toStr]
    );
    for (const r of hhRows) {
      const dateStr = normalizeHolidayDateYmd(r.holiday_date);
      const scopeType = String(r.scope_type || 'ALL').trim().toUpperCase();
      if (scopeType === 'ALL' && Number(r.is_active ?? 1) === 1) {
        seenAllKeys.add(dateStr);
      }
      rows.push({
        ...r,
        holiday_date: dateStr,
        category: String(r.category || 'NATIONAL').trim().toUpperCase(),
        scope_type: scopeType,
        department_name: r.department_name ? String(r.department_name).trim() : null,
        person_id: r.person_id ? String(r.person_id).trim() : null,
        override_policy: String(r.override_policy || 'EXEMPT').trim().toUpperCase(),
        sourceTable: 'hospital_holidays',
      });
    }
  } catch {
    // Safe fallback if migration 006 is not applied yet
  }

  try {
    const phRows = await dbQuery<PublicHolidayRow>(
      `SELECT id, holiday_date, holiday_name, holiday_type, is_active, created_by, created_at
       FROM public_holidays
       WHERE ${activeClause} AND holiday_date >= ? AND holiday_date <= ?
       ORDER BY holiday_date ASC`,
      [fromStr, toStr]
    );
    for (const r of phRows) {
      const dateStr = normalizeHolidayDateYmd(r.holiday_date);
      if (seenAllKeys.has(dateStr)) continue;
      rows.push({
        id: Number(r.id) + 1_000_000,
        holiday_date: dateStr,
        holiday_name: r.holiday_name,
        category: mapLegacyHolidayTypeToCategory(r.holiday_type),
        scope_type: 'ALL',
        department_name: null,
        person_id: null,
        override_policy: 'EXEMPT',
        is_active: Number(r.is_active ?? 1),
        notes: null,
        created_by: String(r.created_by || 'system'),
        updated_by: null,
        created_at: r.created_at,
        sourceTable: 'public_holidays',
      });
    }
  } catch {
    // Ignore if table absent
  }

  rows.sort((a, b) => a.holiday_date.localeCompare(b.holiday_date) || a.id - b.id);
  return rows;
}

/**
 * หาวันหยุดที่มีผลกับบุคลากร 1 คนในวันใดวันหนึ่งตามลำดับความสำคัญ:
 * PERSON > DEPARTMENT > ALL
 */
export function resolveHolidayForPersonDate(params: {
  workDate: string;
  personId: string;
  departmentName?: string | null;
  holidays: HospitalHolidayRow[];
}): HospitalHolidayRow | null {
  const workDate = normalizeHolidayDateYmd(params.workDate);
  const pid = String(params.personId || '').trim();
  const dept = String(params.departmentName || '').trim();

  const matching = params.holidays.filter((h) => {
    if (Number(h.is_active ?? 1) !== 1) return false;
    if (normalizeHolidayDateYmd(h.holiday_date) !== workDate) return false;
    if (h.scope_type === 'PERSON') return h.person_id === pid;
    if (h.scope_type === 'DEPARTMENT') return Boolean(dept && h.department_name === dept);
    return h.scope_type === 'ALL';
  });

  if (matching.length === 0) return null;
  const personRule = matching.find((m) => m.scope_type === 'PERSON');
  if (personRule) return personRule;
  const deptRule = matching.find((m) => m.scope_type === 'DEPARTMENT');
  if (deptRule) return deptRule;
  return matching[0];
}

export function holidayRowToPublicHolidayAdapter(
  holiday: HospitalHolidayRow | null | undefined
): PublicHolidayRow | null {
  if (!holiday || Number(holiday.is_active ?? 1) !== 1) return null;
  const policy = String(holiday.override_policy || 'EXEMPT').toUpperCase();
  if (policy === 'MANDATORY_SHIFT' || policy === 'WORK_WITH_OT') {
    return null;
  }
  return {
    id: holiday.id,
    holiday_date: holiday.holiday_date,
    holiday_name: holiday.holiday_name,
    holiday_type: holiday.category,
    is_active: holiday.is_active,
    created_by: holiday.created_by,
    created_at: holiday.created_at,
  };
}
