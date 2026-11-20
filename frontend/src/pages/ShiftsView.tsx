/**
 * ============================================================================
 * หน้าตารางเวรและแม่แบบกะทำงาน (Full-Page Hospital Shift Roster & Templates)
 * ไฟล์: frontend/src/pages/ShiftsView.tsx
 * ============================================================================
 * การออกแบบ UX/UI สำหรับเจ้าหน้าที่โรงพยาบาลสามชุก:
 * 1. Full-Page Schedule Management แทนการพึ่งพา Modal ขนาดใหญ่
 *    - รองรับทั้ง "ตารางเวรรายเดือน", "ตารางเวรรายสัปดาห์" และ "มุมมองรายการ"
 *    - เปลี่ยนเดือนและปี พ.ศ. ได้ง่ายด้วยตัวเลือกเดือนภาษาไทยและปี พ.ศ. โดยตรง
 *    - ชื่อบุคลากรคงที่ทางซ้าย (Sticky Left) และหัวตารางวันที่คงที่ด้านบน (Sticky Header)
 *    - แสดงสถานะ "ไม่มีเวร" ชัดเจน และคลิกช่องตารางเพื่อเพิ่มหรือดู/แก้ไขเวรได้ทันที
 * 2. การเพิ่มเวรใหม่แบบ Full-Page Workspace แยกเป็น 2 วิธีชัดเจน (ไม่ใช้ Modal ซ้อน Modal):
 *    - วิธีที่ 1: เพิ่มเวรให้บุคลากรหนึ่งคน (เลือกบุคลากร -> เลือกวันที่ -> เลือกแม่แบบกะ -> ตรวจสอบ -> บันทึก)
 *    - วิธีที่ 2: เพิ่มเวรหลายคนพร้อมกัน (เลือกกลุ่มงาน -> เลือกบุคลากรหลายคน -> เลือกช่วงวันที่/หลายวัน -> เลือกกะ -> ตรวจสอบ -> ยืนยันบันทึก)
 * 3. รองรับบุคลากรหลายร้อยคนโดยไม่กระตุก และไม่เลือกบุคลากรทั้งหมดโดยอัตโนมัติ
 * 4. แสดงชื่อแม่แบบกะและเวลาเพียงครั้งเดียว (ตัดข้อความเวลาที่ซ้ำซ้อนในชื่อกะออก)
 * 5. แสดงผลตรวจสอบความขัดแย้งภาษาไทยชัดเจน พร้อมรหัสอ้างอิง (Request ID) เมื่อเกิดข้อผิดพลาด
 * ============================================================================
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Trash2,
  Clock,
  Moon,
  Sun,
  Calendar,
  List,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Users,
  User,
  RotateCcw,
  FileCheck2,
  Eye,
  ArrowLeft,
  X,
  Check,
  CalendarDays,
  Download,
  Upload,
  Edit3,
} from 'lucide-react';
import { apiRequest, ApiClientError, downloadShiftImportTemplateXlsx } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SharedModal,
  TableEmptyState,
  RequiredMark,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  getCurrentBangkokDateParts,
} from '../utils/thaiFormat.ts';

type WorkspaceTabKey = 'ROSTER' | 'ASSIGN_WORKSPACE' | 'TEMPLATES';
type RosterViewMode = 'MONTHLY_GRID' | 'WEEKLY_GRID' | 'DETAIL_LIST';
type MonthDayRangeMode = 'ALL' | 'FIRST_HALF' | 'SECOND_HALF';
type AssignMethodMode = 'SINGLE_PERSON' | 'MULTI_PERSON';
type DatePickStrategy = 'SINGLE_DAY' | 'MULTI_PICK' | 'DATE_RANGE';
type WeekdayFilterMode = 'ALL_DAYS' | 'WEEKDAYS_ONLY' | 'WEEKENDS_ONLY';
type ConflictStrategyMode = 'SKIP_CONFLICTS' | 'ABORT_ON_CONFLICT';
type PreviewFilterTab = 'ALL' | 'READY' | 'CONFLICT';

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

const THAI_SHORT_WEEKDAYS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
const THAI_FULL_WEEKDAYS = [
  'วันอาทิตย์',
  'วันจันทร์',
  'วันอังคาร',
  'วันพุธ',
  'วันพฤหัสบดี',
  'วันศุกร์',
  'วันเสาร์',
];

const SHIFT_CATEGORY_LABELS: Record<string, string> = {
  OFFICIAL: 'เวรราชการ',
  MORNING: 'เวรเช้า',
  AFTERNOON: 'เวรบ่าย',
  NIGHT: 'เวรดึก',
  CROSS_MIDNIGHT: 'เวรข้ามวัน',
  SPECIAL: 'เวรพิเศษ',
};

/**
 * ตัดข้อความเวลาที่ซ้ำซ้อนออกจากชื่อกะ เช่น
 * "เวรราชการปกติ (08:00–16:00)" -> "เวรราชการปกติ"
 * เพื่อไม่ให้แสดงเวลาซ้ำซ้อนเป็น "เวรราชการปกติ (08:00–16:00) (08:00–16:00 น.)"
 */
export function formatCleanShiftName(rawName: string | null | undefined): string {
  const str = String(rawName || '').trim();
  if (!str) return 'เวรปฏิบัติงาน';
  const cleaned = str
    .replace(/\s*\(\s*\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2}(?:\s*น\.?)?\s*\)\s*$/u, '')
    .trim();
  return cleaned || str;
}

function formatThaiMonthTitle(monthValue: string): string {
  const bkk = getCurrentBangkokDateParts();
  const [yStr, mStr] = (monthValue || bkk.currentYearMonth).split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return monthValue;
  }
  return `${THAI_FULL_MONTHS[month - 1]} พ.ศ. ${year + 543}`;
}

export interface MonthDayDescriptor {
  dateStr: string;
  dayNum: number;
  weekdayIdx: number;
  weekdayShort: string;
  weekdayFull: string;
  isWeekend: boolean;
}

function getMonthDateBounds(monthValue: string): {
  year: number;
  month: number;
  daysInMonth: number;
  dateFrom: string;
  dateTo: string;
  allDates: MonthDayDescriptor[];
  weeks: Array<{
    weekIndex: number;
    label: string;
    dates: MonthDayDescriptor[];
  }>;
} {
  const bkk = getCurrentBangkokDateParts();
  const [yStr, mStr] = (monthValue || bkk.currentYearMonth).split('-');
  const year = Number(yStr) || Number(bkk.currentYear);
  const month = Number(mStr) || 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  const allDates: MonthDayDescriptor[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dd = String(d).padStart(2, '0');
    const dateStr = `${year}-${mm}-${dd}`;
    const weekdayIdx = new Date(year, month - 1, d).getDay();
    allDates.push({
      dateStr,
      dayNum: d,
      weekdayIdx,
      weekdayShort: THAI_SHORT_WEEKDAYS[weekdayIdx],
      weekdayFull: THAI_FULL_WEEKDAYS[weekdayIdx],
      isWeekend: weekdayIdx === 0 || weekdayIdx === 6,
    });
  }

  // แบ่งเป็นสัปดาห์ละ 7 วันภายในเดือนสำหรับมุมมองรายสัปดาห์
  const weeks: Array<{
    weekIndex: number;
    label: string;
    dates: MonthDayDescriptor[];
  }> = [];
  for (let i = 0; i < allDates.length; i += 7) {
    const chunk = allDates.slice(i, i + 7);
    const firstDay = chunk[0].dayNum;
    const lastDay = chunk[chunk.length - 1].dayNum;
    const wIdx = weeks.length;
    weeks.push({
      weekIndex: wIdx,
      label: `สัปดาห์ที่ ${wIdx + 1} (วันที่ ${firstDay}–${lastDay} ${THAI_FULL_MONTHS[month - 1]})`,
      dates: chunk,
    });
  }

  return {
    year,
    month,
    daysInMonth,
    dateFrom: `${year}-${mm}-01`,
    dateTo: `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`,
    allDates,
    weeks,
  };
}

function shiftMonthString(monthValue: string, deltaMonths: number): string {
  const bkk = getCurrentBangkokDateParts();
  const [yStr, mStr] = (monthValue || bkk.currentYearMonth).split('-');
  const dt = new Date(
    Number(yStr) || Number(bkk.currentYear),
    (Number(mStr) || 1) - 1 + deltaMonths,
    1
  );
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

function buildDatesFromRange(
  startDate: string,
  endDate: string,
  weekdayFilter: WeekdayFilterMode
): string[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
    return [];
  }
  const [sy, sm, sd] = startDate.split('-').map(Number);
  const [ey, em, ed] = endDate.split('-').map(Number);
  const startUtc = Date.UTC(sy, sm - 1, sd);
  const endUtc = Date.UTC(ey, em - 1, ed);
  if (endUtc < startUtc) return [];

  const result: string[] = [];
  const maxDays = 62;
  let currentUtc = startUtc;
  let count = 0;

  while (currentUtc <= endUtc && count < maxDays) {
    const dt = new Date(currentUtc);
    const weekday = dt.getUTCDay();
    const isWeekend = weekday === 0 || weekday === 6;

    const passFilter =
      weekdayFilter === 'ALL_DAYS' ||
      (weekdayFilter === 'WEEKDAYS_ONLY' && !isWeekend) ||
      (weekdayFilter === 'WEEKENDS_ONLY' && isWeekend);

    if (passFilter) {
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const d = String(dt.getUTCDate()).padStart(2, '0');
      result.push(`${y}-${m}-${d}`);
    }

    currentUtc += 86_400_000;
    count++;
  }
  return result;
}

export function ShiftsView() {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  // แท็บหลัก: ตารางเวร (ROSTER) | จัดเวร/เพิ่มเวรใหม่ (ASSIGN_WORKSPACE) | แม่แบบกะทำงาน (TEMPLATES)
  const [activeTab, setActiveTab] = useState<WorkspaceTabKey>('ROSTER');

  // มุมมองภายในหน้าตารางเวร: รายเดือน (ค่าเริ่มต้น) | รายสัปดาห์ | มุมมองรายการ
  const [rosterViewMode, setRosterViewMode] = useState<RosterViewMode>('MONTHLY_GRID');
  const [dayRangeMode, setDayRangeMode] = useState<MonthDayRangeMode>('ALL');
  const [selectedWeekIndex, setSelectedWeekIndex] = useState<number>(0);

  // ข้อมูลจาก Backend API
  const [shifts, setShifts] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [dailyOverrides, setDailyOverrides] = useState<any[]>([]);
  const [personnelTypeRules, setPersonnelTypeRules] = useState<any[]>([]);
  const [cancellationLogs, setCancellationLogs] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string; requestId?: string } | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(null);

  // ตัวกรองตารางเวรหลัก
  const [selectedMonth, setSelectedMonth] = useState(initialBkk.currentYearMonth);
  const [searchText, setSearchText] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('ALL');
  const [shiftFilter, setShiftFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'CANCELLED' | 'ALL'>('ACTIVE');

  // การแบ่งหน้าบุคลากรในตารางเวรรายเดือน/รายสัปดาห์ เพื่อรองรับหลายร้อยคนโดยไม่กระตุก
  const [rosterPersonPage, setRosterPersonPage] = useState(1);
  const [rosterPersonPageSize, setRosterPersonPageSize] = useState<number>(25);

  // ตัวกรองและฟอร์มในแท็บแม่แบบกะทำงาน
  const [templateSearch, setTemplateSearch] = useState('');
  const [showCreateTemplateForm, setShowCreateTemplateForm] = useState(false);
  const [shiftCode, setShiftCode] = useState('');
  const [shiftName, setShiftName] = useState('');
  const [shiftCategory, setShiftCategory] = useState('OFFICIAL');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('16:00');
  const [graceMinutes, setGraceMinutes] = useState(15);
  const [cutoffTime, setCutoffTime] = useState('10:30');
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  // =========================================================================
  // สถานะสำหรับหน้า "จัดเวร / เพิ่มเวรใหม่" (Full-Page Assignment Workspace)
  // =========================================================================
  const [assignMethod, setAssignMethod] = useState<AssignMethodMode>('SINGLE_PERSON');
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [assignPersonDeptFilter, setAssignPersonDeptFilter] = useState('ALL');
  const [assignPersonSearch, setAssignPersonSearch] = useState('');
  const [assignPersonnelRenderLimit, setAssignPersonnelRenderLimit] = useState<number>(80);

  const [assignShiftId, setAssignShiftId] = useState<number>(0);
  const [datePickStrategy, setDatePickStrategy] = useState<DatePickStrategy>('SINGLE_DAY');
  const [singleWorkDate, setSingleWorkDate] = useState<string>(initialBkk.todayYmd);
  const [multiPickedDates, setMultiPickedDates] = useState<string[]>([initialBkk.todayYmd]);
  const [rangeStartDate, setRangeStartDate] = useState<string>(initialBkk.todayYmd);
  const [rangeEndDate, setRangeEndDate] = useState<string>(initialBkk.todayYmd);
  const [weekdayFilter, setWeekdayFilter] = useState<WeekdayFilterMode>('ALL_DAYS');
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategyMode>('SKIP_CONFLICTS');

  // ผลการตรวจสอบความขัดแย้ง (Conflict Preview)
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewFilterTab, setPreviewFilterTab] = useState<PreviewFilterTab>('ALL');
  const [previewData, setPreviewData] = useState<{
    requestId?: string;
    shiftSnapshot: any;
    summary: {
      totalRequested: number;
      readyCount: number;
      conflictCount: number;
      duplicateCount: number;
      overlapCount: number;
    };
    items: Array<{
      personId: string;
      fullName: string;
      departmentName: string;
      workDate: string;
      status: 'READY' | 'DUPLICATE_SAME_SHIFT' | 'TIME_OVERLAP_CONFLICT';
      conflictCode: string | null;
      conflictMessage: string | null;
      existingAssignment: any | null;
    }>;
  } | null>(null);
  const [previewError, setPreviewError] = useState<{
    code?: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [submittingBulk, setSubmittingBulk] = useState(false);

  // หน้าต่างดูรายละเอียด Snapshot ของเวร / ยืนยันยกเลิกตารางเวร (Soft Cancel)
  const [inspectTarget, setInspectTarget] = useState<any | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState(
    'ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน (บันทึกประวัติการตรวจสอบ)'
  );

  // =========================================================================
  // Quick Single-Person Cell Modal (คลิกช่องวันที่ของบุคลากร 1 คน จัดการทันที)
  // =========================================================================
  const [quickCellTarget, setQuickCellTarget] = useState<{
    person: any;
    workDate: string;
  } | null>(null);
  const [quickCellSelectedShiftId, setQuickCellSelectedShiftId] = useState<number>(0);
  const [quickCellBusy, setQuickCellBusy] = useState(false);
  const [quickCellReason, setQuickCellReason] = useState('');

  // =========================================================================
  // นำเข้าตารางเวรจากไฟล์ Excel (.xlsx)
  // =========================================================================
  const [showExcelImportModal, setShowExcelImportModal] = useState(false);
  const [excelFileName, setExcelFileName] = useState('');
  const [excelFileBase64, setExcelFileBase64] = useState('');
  const [excelImportMode, setExcelImportMode] = useState<'REPLACE_DATE' | 'ADD_SHIFT'>('REPLACE_DATE');
  const [excelBusy, setExcelBusy] = useState(false);
  const [excelPreview, setExcelPreview] = useState<any | null>(null);
  const [excelError, setExcelError] = useState<string | null>(null);

  // =========================================================================
  // การจัดการกฎกะเช้าเริ่มต้นตามประเภทบุคลากร (personnel_type_rules)
  // =========================================================================
  const [editingRule, setEditingRule] = useState<any | null>(null);
  const [showAddRuleForm, setShowAddRuleForm] = useState(false);
  const [newRuleCode, setNewRuleCode] = useState('');
  const [newRuleName, setNewRuleName] = useState('');
  const [newRuleStart, setNewRuleStart] = useState('08:00');
  const [newRuleEnd, setNewRuleEnd] = useState('16:00');
  const [newRuleGrace, setNewRuleGrace] = useState(15);
  const [newRuleCutoff, setNewRuleCutoff] = useState('11:00');
  const [newRuleEffectiveFrom, setNewRuleEffectiveFrom] = useState('2020-01-01');
  const [ruleSaving, setRuleSaving] = useState(false);

  // การเรียงลำดับและแบ่งหน้าสำหรับมุมมองรายการ (Detail List View)
  const [sortKey, setSortKey] = useState('work_date');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const monthBounds = useMemo(() => getMonthDateBounds(selectedMonth), [selectedMonth]);

  // ปรับ selectedWeekIndex ให้อยู่ในช่วงสัปดาห์ของเดือนที่เลือกเสมอ
  useEffect(() => {
    if (selectedWeekIndex >= monthBounds.weeks.length) {
      setSelectedWeekIndex(0);
    }
  }, [monthBounds.weeks.length, selectedWeekIndex]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [shRes, saRes, pRes] = await Promise.all([
        apiRequest('/shifts'),
        apiRequest(
          `/shift-assignments?dateFrom=${encodeURIComponent(monthBounds.dateFrom)}&dateTo=${encodeURIComponent(monthBounds.dateTo)}`
        ),
        apiRequest('/personnel'),
      ]);
      const loadedShifts = shRes.items || [];
      const loadedPersonnel = pRes.items || [];
      setShifts(loadedShifts);
      setAssignments(saRes.items || []);
      setDailyOverrides(saRes.dailyOverrides || []);
      setPersonnelTypeRules(saRes.personnelTypeRules || []);
      setCancellationLogs(saRes.cancellationLogs || []);
      setPersonnel(loadedPersonnel);

      if (
        loadedShifts.length > 0 &&
        (!assignShiftId || !loadedShifts.some((s: any) => Number(s.id) === Number(assignShiftId)))
      ) {
        setAssignShiftId(Number(loadedShifts[0].id));
      }
      if (
        loadedShifts.length > 0 &&
        (!quickCellSelectedShiftId || !loadedShifts.some((s: any) => Number(s.id) === Number(quickCellSelectedShiftId)))
      ) {
        setQuickCellSelectedShiftId(Number(loadedShifts[0].id));
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลตารางเวรและแม่แบบกะทำงานได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [monthBounds.dateFrom, monthBounds.dateTo, assignShiftId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // รายชื่อกลุ่มงาน/แผนกทั้งหมดจากข้อมูลบุคลากรจริง
  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const p of personnel) {
      if (p.department_name) set.add(String(p.department_name).trim());
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }, [personnel]);

  // แผนที่ค้นหาข้อมูลบุคลากรตาม person_id อย่างรวดเร็ว (O(1))
  const personnelByIdMap = useMemo(() => {
    const map = new Map<string, any>();
    for (const p of personnel) {
      map.set(String(p.person_id).trim(), p);
    }
    return map;
  }, [personnel]);

  // กรองรายการตารางเวรตามตัวกรองทั้งหมด
  const filteredAssignments = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return assignments.filter((a) => {
      if (statusFilter !== 'ALL' && a.status !== statusFilter) return false;
      if (departmentFilter !== 'ALL' && a.department_name !== departmentFilter) return false;
      if (
        shiftFilter !== 'ALL' &&
        String(a.shift_id) !== shiftFilter &&
        a.snapshot_shift_code !== shiftFilter
      ) {
        return false;
      }
      if (q) {
        const hay = `${a.full_name || ''} ${a.person_id || ''} ${a.snapshot_shift_name || ''} ${a.snapshot_shift_code || ''} ${a.department_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [assignments, statusFilter, departmentFilter, shiftFilter, searchText]);

  // จัดกลุ่มตารางเวรตาม (person_id -> work_date -> รายการเวร)
  const assignmentsByPersonAndDate = useMemo(() => {
    const map = new Map<string, Map<string, any[]>>();
    for (const a of filteredAssignments) {
      const pid = String(a.person_id ?? '').trim();
      const wDate = String(a.work_date ?? '').slice(0, 10);
      let dateMap = map.get(pid);
      if (!dateMap) {
        dateMap = new Map<string, any[]>();
        map.set(pid, dateMap);
      }
      const list = dateMap.get(wDate) || [];
      list.push(a);
      dateMap.set(wDate, list);
    }
    return map;
  }, [filteredAssignments]);

  // แผนที่ค้นหาสถานะ Override รายวัน (person_id::work_date -> override row)
  const dailyOverrideByPersonDateMap = useMemo(() => {
    const map = new Map<string, any>();
    for (const ov of dailyOverrides) {
      const pid = String(ov.person_id ?? '').trim();
      const wDate = String(ov.work_date ?? '').slice(0, 10);
      if (pid && wDate) {
        map.set(`${pid}::${wDate}`, ov);
      }
    }
    return map;
  }, [dailyOverrides]);

  // จับคู่กฎกะเช้าเริ่มต้นตามประเภทบุคลากร
  const findDefaultRuleForPerson = useCallback(
    (person: any, workDate?: string) => {
      if (!person) return null;
      const rawCode = String(person.personnel_type_code || '').trim().toUpperCase();
      const rawName = String(person.personnel_type_name || '').trim();
      const codeAlias: Record<string, string> = {
        '01': 'CIVIL_SERVANT',
        '1': 'CIVIL_SERVANT',
        '02': 'PERMANENT_EMP',
        '2': 'PERMANENT_EMP',
        '03': 'GOV_EMPLOYEE',
        '3': 'GOV_EMPLOYEE',
        '04': 'PUBLIC_HEALTH_EMP',
        '4': 'PUBLIC_HEALTH_EMP',
        '05': 'TEMP_EMPLOYEE',
        '5': 'TEMP_EMPLOYEE',
      };
      const mappedCode = codeAlias[rawCode] || rawCode;

      for (const r of personnelTypeRules) {
        if (Number(r.is_active ?? 1) !== 1) continue;
        const eff = String(r.effective_from || '2020-01-01').slice(0, 10);
        if (workDate && eff > workDate) continue;
        const rCode = String(r.personnel_type_code || '').trim().toUpperCase();
        const rName = String(r.personnel_type_name || '').trim();
        if (
          rCode === mappedCode ||
          rCode === rawCode ||
          (rawName && rName === rawName) ||
          (rawName.includes('ข้าราชการ') && rCode === 'CIVIL_SERVANT') ||
          (rawName.includes('ลูกจ้างประจำ') && rCode === 'PERMANENT_EMP') ||
          (rawName.includes('พนักงานราชการ') && rCode === 'GOV_EMPLOYEE') ||
          (rawName.includes('พนักงานกระทรวง') && rCode === 'PUBLIC_HEALTH_EMP')
        ) {
          return r;
        }
      }
      return null;
    },
    [personnelTypeRules]
  );

  // คำนวณสถานะเวรสุทธิของบุคลากรในแต่ละวันตามลำดับความสำคัญ (Priority Engine)
  const getEffectiveCellState = useCallback(
    (person: any, dateStr: string) => {
      const pid = String(person.person_id ?? '').trim();
      const personDateMap = assignmentsByPersonAndDate.get(pid);
      const cellItems = personDateMap?.get(dateStr) || [];
      const activeItems = cellItems.filter((x) => x.status === 'ACTIVE');
      const overrideRow = dailyOverrideByPersonDateMap.get(`${pid}::${dateStr}`);
      const defaultRule = findDefaultRuleForPerson(person, dateStr);

      if (overrideRow?.override_state === 'CLEARED_ALL_SHIFTS' && activeItems.length === 0) {
        return {
          mode: 'CLEARED_ALL_SHIFTS' as const,
          activeItems: [],
          allItems: cellItems,
          defaultRule,
          overrideRow,
        };
      }
      if (activeItems.length > 0) {
        return {
          mode: 'CUSTOM_ASSIGNED' as const,
          activeItems,
          allItems: cellItems,
          defaultRule,
          overrideRow,
        };
      }
      if (defaultRule) {
        return {
          mode: 'DEFAULT_FROM_TYPE' as const,
          activeItems: [],
          allItems: cellItems,
          defaultRule,
          overrideRow,
        };
      }
      return {
        mode: 'UNCONFIGURED_DEFAULT_RULE' as const,
        activeItems: [],
        allItems: cellItems,
        defaultRule: null,
        overrideRow,
      };
    },
    [assignmentsByPersonAndDate, dailyOverrideByPersonDateMap, findDefaultRuleForPerson]
  );

  // เปิด Quick Single-Person Cell Modal ทันทีเมื่อคลิกช่องวันที่ของบุคลากร
  function openQuickCellModal(person: any, workDate: string) {
    setQuickCellTarget({ person, workDate });
    setQuickCellReason('');
    if (shifts.length > 0 && !quickCellSelectedShiftId) {
      setQuickCellSelectedShiftId(Number(shifts[0].id));
    }
  }

  // ดำเนินการจัดการเวรรายช่อง (เพิ่มกะ / เปลี่ยนกะ / ลบกะเช้า / ลบกะบ่าย / ลบกะทั้งหมด / คืนค่ากะเริ่มต้น)
  async function handleQuickCellAction(
    action:
      | 'ADD_SHIFT'
      | 'REPLACE_SHIFTS'
      | 'REMOVE_MORNING'
      | 'REMOVE_AFTERNOON'
      | 'CLEAR_ALL_SHIFTS'
      | 'RESTORE_DEFAULT',
    explicitShiftId?: number
  ) {
    if (!quickCellTarget) return;
    setQuickCellBusy(true);
    setError(null);
    try {
      const targetShiftId = explicitShiftId || quickCellSelectedShiftId;
      const body: Record<string, any> = {
        personId: String(quickCellTarget.person.person_id).trim(),
        workDate: quickCellTarget.workDate,
        action,
        reason: quickCellReason.trim() || undefined,
      };
      if (action === 'ADD_SHIFT') {
        body.shiftId = Number(targetShiftId);
      } else if (action === 'REPLACE_SHIFTS') {
        body.shiftIds = [Number(targetShiftId)];
      }
      const res = await apiRequest('/shift-assignments/daily-cell-action', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setNotice(res.message || 'อัปเดตตารางเวรสำเร็จ');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      } else {
        setError({ message: 'ไม่สามารถอัปเดตตารางเวรในช่องที่เลือกได้' });
      }
    } finally {
      setQuickCellBusy(false);
    }
  }

  // ดาวน์โหลดไฟล์ Template Excel (.xlsx)
  async function handleDownloadExcelTemplate() {
    try {
      await downloadShiftImportTemplateXlsx();
      setNotice('ดาวน์โหลดไฟล์แม่แบบตารางเวร Excel (.xlsx) สำเร็จ');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      } else {
        setError({ message: 'ไม่สามารถดาวน์โหลดไฟล์ Template Excel ได้' });
      }
    }
  }

  // อ่านไฟล์ .xlsx ที่ผู้ใช้เลือกเป็น Base64
  function handleSelectExcelFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setExcelPreview(null);
    setExcelError(null);
    if (!file) {
      setExcelFileName('');
      setExcelFileBase64('');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setExcelError('ระบบรองรับเฉพาะไฟล์นามสกุล .xlsx เท่านั้น');
      return;
    }
    setExcelFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer;
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      setExcelFileBase64(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  }

  // ตรวจสอบไฟล์ Excel ก่อนบันทึกจริง (Preview)
  async function handlePreviewExcelImport() {
    if (!excelFileBase64) {
      setExcelError('กรุณาเลือกไฟล์ Excel (.xlsx) ก่อนตรวจสอบ');
      return;
    }
    setExcelBusy(true);
    setExcelError(null);
    try {
      const res = await apiRequest('/shift-assignments/import-excel/preview', {
        method: 'POST',
        body: JSON.stringify({
          fileName: excelFileName,
          fileBase64: excelFileBase64,
          mode: excelImportMode,
        }),
      });
      setExcelPreview(res);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setExcelError(`${err.message}${err.requestId ? ` (Ref: ${err.requestId})` : ''}`);
      } else {
        setExcelError('ไม่สามารถอ่านหรือตรวจสอบไฟล์ Excel ได้');
      }
    } finally {
      setExcelBusy(false);
    }
  }

  // ยืนยันนำเข้าตารางเวรจากไฟล์ Excel (.xlsx)
  async function handleConfirmExcelImport() {
    if (!excelFileBase64) return;
    setExcelBusy(true);
    setExcelError(null);
    try {
      const res = await apiRequest('/shift-assignments/import-excel/confirm', {
        method: 'POST',
        body: JSON.stringify({
          fileName: excelFileName,
          fileBase64: excelFileBase64,
          mode: excelImportMode,
        }),
      });
      setNotice(
        `นำเข้าตารางเวรจากไฟล์ ${excelFileName} สำเร็จ: บันทึก ${res.insertedCount || 0} รายการ (ข้าม ${res.skippedCount || 0} รายการ)`
      );
      setShowExcelImportModal(false);
      setExcelPreview(null);
      setExcelFileName('');
      setExcelFileBase64('');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setExcelError(`${err.message}${err.requestId ? ` (Ref: ${err.requestId})` : ''}`);
      } else {
        setExcelError('เกิดข้อผิดพลาดขณะบันทึกตารางเวรจากไฟล์ Excel');
      }
    } finally {
      setExcelBusy(false);
    }
  }

  // บันทึกการแก้ไขกฎกะเช้าเริ่มต้นตามประเภทบุคลากร
  async function handleSaveRuleEdit(e: React.FormEvent) {
    e.preventDefault();
    if (!editingRule) return;
    setRuleSaving(true);
    try {
      await apiRequest(`/personnel-type-rules/${editingRule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          personnelTypeName: editingRule.personnel_type_name,
          defaultStartTime: editingRule.default_start_time || '08:00',
          defaultEndTime: editingRule.default_end_time || '16:00',
          defaultGraceMinutes: Number(editingRule.default_grace_minutes ?? 15),
          defaultCutoffTime: editingRule.default_cutoff_time || '11:00',
          effectiveFrom: editingRule.effective_from || '2020-01-01',
          isActive: Number(editingRule.is_active ?? 1) === 1,
        }),
      });
      setNotice(`อัปเดตกฎกะเช้าเริ่มต้นสำหรับ "${editingRule.personnel_type_name}" สำเร็จ`);
      setEditingRule(null);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      }
    } finally {
      setRuleSaving(false);
    }
  }

  // เพิ่มประเภทบุคลากรและกฎกะเช้าเริ่มต้นใหม่
  async function handleCreateRule(e: React.FormEvent) {
    e.preventDefault();
    setRuleSaving(true);
    try {
      await apiRequest('/personnel-type-rules', {
        method: 'POST',
        body: JSON.stringify({
          personnelTypeCode: newRuleCode.trim(),
          personnelTypeName: newRuleName.trim(),
          defaultStartTime: newRuleStart,
          defaultEndTime: newRuleEnd,
          defaultGraceMinutes: Number(newRuleGrace),
          defaultCutoffTime: newRuleCutoff,
          effectiveFrom: newRuleEffectiveFrom,
          isActive: true,
        }),
      });
      setNotice(`เพิ่มกฎกะเช้าเริ่มต้นสำหรับประเภทบุคลากร "${newRuleName.trim()}" สำเร็จ`);
      setShowAddRuleForm(false);
      setNewRuleCode('');
      setNewRuleName('');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      }
    } finally {
      setRuleSaving(false);
    }
  }

  // เปิด/ปิดใช้งานกฎกะเช้าเริ่มต้น
  async function handleToggleRuleActive(rule: any) {
    try {
      const nextActive = Number(rule.is_active ?? 1) !== 1;
      await apiRequest(`/personnel-type-rules/${rule.id}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextActive }),
      });
      setNotice(
        `${nextActive ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}กฎกะเช้าเริ่มต้นของ "${rule.personnel_type_name}" สำเร็จ`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      }
    }
  }

  // กรองบุคลากรสำหรับแสดงในตารางเวรรายเดือนและรายสัปดาห์
  const filteredPersonnelForRoster = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return personnel.filter((p) => {
      const pid = String(p.person_id ?? '').trim();
      if (departmentFilter !== 'ALL' && p.department_name !== departmentFilter) {
        return false;
      }
      if (shiftFilter !== 'ALL') {
        const personDateMap = assignmentsByPersonAndDate.get(pid);
        if (!personDateMap || personDateMap.size === 0) return false;
      }
      if (q) {
        const hay = `${p.full_name || ''} ${pid} ${p.fingle_id || ''} ${p.position_name || ''} ${p.department_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [personnel, departmentFilter, shiftFilter, searchText, assignmentsByPersonAndDate]);

  // แบ่งหน้าบุคลากรในตารางรายเดือน/รายสัปดาห์
  const rosterTotalPages = Math.max(
    1,
    Math.ceil(filteredPersonnelForRoster.length / rosterPersonPageSize)
  );
  const pagedPersonnelForRoster = useMemo(() => {
    const safePage = Math.min(rosterPersonPage, rosterTotalPages);
    const start = (safePage - 1) * rosterPersonPageSize;
    return filteredPersonnelForRoster.slice(start, start + rosterPersonPageSize);
  }, [filteredPersonnelForRoster, rosterPersonPage, rosterTotalPages, rosterPersonPageSize]);

  // วันที่ที่จะแสดงในคอลัมน์ของตารางเวรรายเดือน
  const visibleMonthDates = useMemo(() => {
    if (dayRangeMode === 'FIRST_HALF') {
      return monthBounds.allDates.filter((d) => d.dayNum <= 15);
    }
    if (dayRangeMode === 'SECOND_HALF') {
      return monthBounds.allDates.filter((d) => d.dayNum >= 16);
    }
    return monthBounds.allDates;
  }, [monthBounds.allDates, dayRangeMode]);

  // วันที่ที่จะแสดงในคอลัมน์ของตารางเวรรายสัปดาห์
  const activeWeekObj = useMemo(() => {
    return (
      monthBounds.weeks[selectedWeekIndex] ||
      monthBounds.weeks[0] || {
        weekIndex: 0,
        label: formatThaiMonthTitle(selectedMonth),
        dates: monthBounds.allDates.slice(0, 7),
      }
    );
  }, [monthBounds.weeks, monthBounds.allDates, selectedWeekIndex, selectedMonth]);

  // คำนวณรายการวันที่ที่เลือกในหน้า "จัดเวร / เพิ่มเวรใหม่"
  const effectiveSelectedDates = useMemo(() => {
    if (datePickStrategy === 'SINGLE_DAY') {
      return /^\d{4}-\d{2}-\d{2}$/.test(singleWorkDate) ? [singleWorkDate] : [];
    }
    if (datePickStrategy === 'MULTI_PICK') {
      return Array.from(new Set(multiPickedDates)).sort();
    }
    return buildDatesFromRange(rangeStartDate, rangeEndDate, weekdayFilter);
  }, [
    datePickStrategy,
    singleWorkDate,
    multiPickedDates,
    rangeStartDate,
    rangeEndDate,
    weekdayFilter,
  ]);

  // ตรวจสอบว่าวันที่ที่เลือกอยู่นอกเดือนที่กำลังเปิดดูหรือไม่ (ป้องกันการเลือกวันที่ผิดเดือนโดยไม่ตั้งใจ)
  const outOfMonthDatesWarning = useMemo(() => {
    if (effectiveSelectedDates.length === 0) return null;
    const outside = effectiveSelectedDates.filter((d) => !d.startsWith(selectedMonth));
    if (outside.length === 0) return null;
    return `มีวันที่เลือกจำนวน ${outside.length} วัน อยู่นอกเดือน${formatThaiMonthTitle(selectedMonth)} (เช่น ${formatThaiDate(outside[0])}) กรุณาตรวจสอบเดือนให้ถูกต้องก่อนบันทึก`;
  }, [effectiveSelectedDates, selectedMonth]);

  // แม่แบบกะที่กำลังเลือกอยู่ในหน้าจัดเวร
  const selectedShiftTemplate = useMemo(
    () => shifts.find((s) => Number(s.id) === Number(assignShiftId)) || null,
    [shifts, assignShiftId]
  );

  // บุคลากรที่กรองในหน้า "จัดเวร / เพิ่มเวรใหม่"
  const assignFilteredPersonnel = useMemo(() => {
    const q = assignPersonSearch.trim().toLowerCase();
    return personnel.filter((p) => {
      if (assignPersonDeptFilter !== 'ALL' && p.department_name !== assignPersonDeptFilter) {
        return false;
      }
      if (q) {
        const hay = `${p.full_name || ''} ${p.person_id || ''} ${p.fingle_id || ''} ${p.department_name || ''} ${p.position_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [personnel, assignPersonDeptFilter, assignPersonSearch]);

  // จำกัดจำนวนแถวที่ Render ในกล่องเลือกบุคลากรเพื่อป้องกันหน้าจอกระตุกเมื่อมีบุคลากรหลายร้อยคน
  const visibleAssignPersonnel = useMemo(
    () => assignFilteredPersonnel.slice(0, assignPersonnelRenderLimit),
    [assignFilteredPersonnel, assignPersonnelRenderLimit]
  );

  // รายชื่อบุคลากรที่ถูกเลือกไว้แล้วสำหรับแสดงในส่วนสรุป
  const selectedPersonnelObjects = useMemo(() => {
    return selectedPersonIds.map((pid) => {
      const found = personnelByIdMap.get(pid);
      return (
        found || {
          person_id: pid,
          full_name: pid,
          department_name: '-',
        }
      );
    });
  }, [selectedPersonIds, personnelByIdMap]);

  // ล้างผล Preview เดิมเมื่อผู้ใช้เปลี่ยนเงื่อนไขในหน้าจัดเวร
  useEffect(() => {
    setPreviewData(null);
    setPreviewError(null);
  }, [selectedPersonIds, assignShiftId, effectiveSelectedDates, assignMethod]);

  /**
   * เปิดหน้า "จัดเวร / เพิ่มเวรใหม่" (Full-Page Assignment Workspace)
   * - ห้ามเลือกบุคลากรทั้งหมดโดยอัตโนมัติ
   * - หากคลิกมาจากช่องของบุคลากรในตารางเวร จะเลือกเฉพาะบุคลากรคนนั้นและวันที่นั้นให้ทันที
   */
  function openAssignWorkspace(preset?: {
    method?: AssignMethodMode;
    personId?: string;
    workDate?: string;
    shiftId?: number;
  }) {
    setPreviewData(null);
    setPreviewError(null);
    setPreviewFilterTab('ALL');

    const targetMethod: AssignMethodMode =
      preset?.method || (preset?.personId ? 'SINGLE_PERSON' : 'SINGLE_PERSON');
    setAssignMethod(targetMethod);

    if (preset?.personId) {
      setSelectedPersonIds([String(preset.personId).trim()]);
    } else {
      // ไม่เลือกบุคลากรทั้งหมดโดยอัตโนมัติ ให้ผู้ใช้เป็นผู้เลือกเองอย่างชัดเจน
      setSelectedPersonIds([]);
    }

    if (preset?.shiftId) {
      setAssignShiftId(Number(preset.shiftId));
    } else if (!assignShiftId && shifts.length > 0) {
      setAssignShiftId(Number(shifts[0].id));
    }

    const defaultDateInMonth =
      preset?.workDate ||
      (initialBkk.todayYmd.startsWith(selectedMonth)
        ? initialBkk.todayYmd
        : monthBounds.dateFrom);

    setSingleWorkDate(defaultDateInMonth);
    setMultiPickedDates([defaultDateInMonth]);
    setRangeStartDate(defaultDateInMonth);
    setRangeEndDate(defaultDateInMonth);

    if (preset?.workDate) {
      setDatePickStrategy('SINGLE_DAY');
    } else if (targetMethod === 'MULTI_PERSON') {
      setDatePickStrategy('DATE_RANGE');
      setRangeStartDate(monthBounds.dateFrom);
      setRangeEndDate(monthBounds.dateTo);
    } else {
      setDatePickStrategy('SINGLE_DAY');
    }

    setActiveTab('ASSIGN_WORKSPACE');
  }

  function handleSwitchAssignMethod(newMethod: AssignMethodMode) {
    setAssignMethod(newMethod);
    setPreviewData(null);
    setPreviewError(null);
    if (newMethod === 'SINGLE_PERSON') {
      if (selectedPersonIds.length > 1) {
        setSelectedPersonIds([selectedPersonIds[0]]);
      }
      setDatePickStrategy('SINGLE_DAY');
    } else {
      setDatePickStrategy('DATE_RANGE');
      setRangeStartDate(monthBounds.dateFrom);
      setRangeEndDate(monthBounds.dateTo);
    }
  }

  function handleSelectPerson(personId: string) {
    const pid = String(personId).trim();
    if (assignMethod === 'SINGLE_PERSON') {
      setSelectedPersonIds((prev) => (prev.includes(pid) ? [] : [pid]));
      return;
    }
    setSelectedPersonIds((prev) =>
      prev.includes(pid) ? prev.filter((id) => id !== pid) : [...prev, pid]
    );
  }

  function selectAllFilteredPersons() {
    const filteredIds = assignFilteredPersonnel.map((p) => String(p.person_id).trim());
    if (assignMethod === 'SINGLE_PERSON') {
      if (filteredIds.length > 0) {
        setSelectedPersonIds([filteredIds[0]]);
      }
      return;
    }
    setSelectedPersonIds((prev) => Array.from(new Set([...prev, ...filteredIds])));
  }

  function clearSelectedPersons() {
    setSelectedPersonIds([]);
  }

  function toggleMultiPickedDate(dateStr: string) {
    setMultiPickedDates((prev) =>
      prev.includes(dateStr) ? prev.filter((d) => d !== dateStr) : [...prev, dateStr]
    );
  }

  function quickPickMonthDates(
    mode: 'ALL_MONTH' | 'WEEKDAYS_MONTH' | 'WEEKENDS_MONTH' | 'FIRST_HALF' | 'SECOND_HALF' | 'CLEAR'
  ) {
    if (mode === 'CLEAR') {
      setMultiPickedDates([]);
      return;
    }
    if (mode === 'ALL_MONTH') {
      setMultiPickedDates(monthBounds.allDates.map((d) => d.dateStr));
      return;
    }
    if (mode === 'WEEKDAYS_MONTH') {
      setMultiPickedDates(monthBounds.allDates.filter((d) => !d.isWeekend).map((d) => d.dateStr));
      return;
    }
    if (mode === 'WEEKENDS_MONTH') {
      setMultiPickedDates(monthBounds.allDates.filter((d) => d.isWeekend).map((d) => d.dateStr));
      return;
    }
    if (mode === 'FIRST_HALF') {
      setMultiPickedDates(
        monthBounds.allDates.filter((d) => d.dayNum <= 15).map((d) => d.dateStr)
      );
      return;
    }
    if (mode === 'SECOND_HALF') {
      setMultiPickedDates(
        monthBounds.allDates.filter((d) => d.dayNum >= 16).map((d) => d.dateStr)
      );
    }
  }

  // เรียก API ตรวจสอบความขัดแย้ง (Bulk Conflict Preview)
  async function handleRunConflictPreview() {
    if (selectedPersonIds.length === 0) {
      setPreviewError({
        code: 'NO_PERSON_SELECTED',
        message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 คนก่อนกดตรวจสอบความซ้ำซ้อน',
      });
      return;
    }
    if (effectiveSelectedDates.length === 0) {
      setPreviewError({
        code: 'NO_DATE_SELECTED',
        message: 'กรุณาเลือกวันที่ปฏิบัติงานอย่างน้อย 1 วัน',
      });
      return;
    }
    if (!assignShiftId) {
      setPreviewError({
        code: 'NO_SHIFT_SELECTED',
        message: 'กรุณาเลือกแม่แบบกะทำงาน',
      });
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewData(null);
    try {
      const res = await apiRequest('/shift-assignments/bulk-preview', {
        method: 'POST',
        body: JSON.stringify({
          personIds: selectedPersonIds,
          shiftId: Number(assignShiftId),
          workDates: effectiveSelectedDates,
        }),
      });
      setPreviewData(res);
      setPreviewFilterTab('ALL');
    } catch (err) {
      setPreviewData(null);
      if (err instanceof ApiClientError) {
        setPreviewError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
      } else {
        setPreviewError({
          message: 'ไม่สามารถตรวจสอบความขัดแย้งของตารางเวรได้ กรุณาลองใหม่อีกครั้ง',
        });
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  // บันทึกการมอบหมายเวรจริงหลังจากตรวจสอบ Preview แล้ว
  async function handleConfirmBulkAssign() {
    if (!previewData || previewError) {
      return;
    }

    if (
      conflictStrategy === 'ABORT_ON_CONFLICT' &&
      previewData.summary.conflictCount > 0
    ) {
      setPreviewError({
        code: 'CONFLICT_ABORT_POLICY',
        message: `พบรายการที่มีเวรอยู่แล้วหรือเวลาทับซ้อน ${previewData.summary.conflictCount} รายการ กรุณาเปลี่ยนนโยบายเป็น "ข้ามเฉพาะรายการที่มีเวรอยู่แล้ว/เวลาทับซ้อน" หรือปรับวันที่เลือกใหม่`,
      });
      return;
    }

    if (previewData.summary.readyCount === 0) {
      setPreviewError({
        code: 'NO_READY_ITEMS',
        message:
          'ไม่มีรายการตารางเวรใหม่ที่สามารถบันทึกได้ (ทุกรายการมีเวรอยู่แล้วหรือเวลาทับซ้อนกับกะอื่น)',
      });
      return;
    }

    setSubmittingBulk(true);
    setPreviewError(null);
    setError(null);
    try {
      const res = await apiRequest('/shift-assignments/bulk', {
        method: 'POST',
        body: JSON.stringify({
          personIds: selectedPersonIds,
          shiftId: Number(assignShiftId),
          workDates: effectiveSelectedDates,
          conflictStrategy,
        }),
      });

      const inserted = Number(res.insertedCount || 0);
      const skipped = Number(res.skippedConflictCount || 0);
      setNotice(
        skipped > 0
          ? `บันทึกตารางเวรสำเร็จ ${inserted} รายการ (ข้ามรายการที่มีเวรอยู่แล้วหรือเวลาทับซ้อน ${skipped} รายการ โดยไม่ลบหรือทับเวรเดิม)`
          : `บันทึกตารางเวรสำเร็จ ${inserted} รายการ`
      );
      setPreviewData(null);
      setActiveTab('ROSTER');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setPreviewError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
      } else {
        setPreviewError({
          message: 'เกิดข้อผิดพลาดในการบันทึกตารางเวร กรุณาลองใหม่อีกครั้ง',
        });
      }
    } finally {
      setSubmittingBulk(false);
    }
  }

  // สร้างแม่แบบกะทำงานใหม่ในแท็บ "แม่แบบกะทำงาน"
  async function handleCreateShift(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCreatingTemplate(true);
    try {
      await apiRequest('/shifts', {
        method: 'POST',
        body: JSON.stringify({
          shiftCode,
          shiftName: formatCleanShiftName(shiftName),
          shiftCategory,
          startTime,
          endTime,
          graceMinutes: Number(graceMinutes),
          cutoffTime,
        }),
      });
      setShiftCode('');
      setShiftName('');
      setShowCreateTemplateForm(false);
      setNotice('สร้างแม่แบบกะทำงานใหม่เรียบร้อยแล้ว');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
      }
    } finally {
      setCreatingTemplate(false);
    }
  }

  // ยกเลิกเวรแบบ Soft Cancel
  async function handleConfirmCancelAssignment(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelTarget) return;
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/shift-assignments/${cancelTarget.id}`, {
        method: 'DELETE',
        body: JSON.stringify({
          cancelReason,
        }),
      });
      setNotice(
        `ยกเลิกเวรของ ${cancelTarget.full_name} วันที่ ${formatThaiDate(cancelTarget.work_date)} เรียบร้อยแล้ว (บันทึกประวัติการตรวจสอบ)`
      );
      setCancelTarget(null);
      setInspectTarget(null);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
      }
    }
  }

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('ASC');
    }
    setPage(1);
  }

  function resetAllFilters() {
    setSearchText('');
    setDepartmentFilter('ALL');
    setShiftFilter('ALL');
    setStatusFilter('ACTIVE');
    setPage(1);
    setRosterPersonPage(1);
  }

  const hasActiveFilters =
    searchText.trim() !== '' ||
    departmentFilter !== 'ALL' ||
    shiftFilter !== 'ALL' ||
    statusFilter !== 'ACTIVE';

  const sortedAssignments = useMemo(() => {
    return [...filteredAssignments].sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      return sortDir === 'ASC'
        ? String(valA || '').localeCompare(String(valB || ''), 'th')
        : String(valB || '').localeCompare(String(valA || ''), 'th');
    });
  }, [filteredAssignments, sortKey, sortDir]);

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedAssignments.length) : pageSize;
  const pagedAssignments = sortedAssignments.slice((page - 1) * numericSize, page * numericSize);

  // กรองแม่แบบกะทำงานในแท็บแม่แบบกะ
  const filteredShifts = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return shifts;
    return shifts.filter((s) => {
      const hay = `${s.shift_code || ''} ${s.shift_name || ''} ${s.shift_category || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [shifts, templateSearch]);

  // กรองรายการในตารางผลลัพธ์ Preview
  const filteredPreviewItems = useMemo(() => {
    if (!previewData) return [];
    if (previewFilterTab === 'READY') {
      return previewData.items.filter((i) => i.status === 'READY');
    }
    if (previewFilterTab === 'CONFLICT') {
      return previewData.items.filter((i) => i.status !== 'READY');
    }
    return previewData.items;
  }, [previewData, previewFilterTab]);

  // สรุปตัวเลขภาพรวมของเดือนที่เลือก
  const activeCountInMonth = useMemo(
    () => assignments.filter((a) => a.status === 'ACTIVE').length,
    [assignments]
  );
  const crossMidnightCountInMonth = useMemo(
    () =>
      assignments.filter((a) => a.status === 'ACTIVE' && Number(a.snapshot_is_cross_midnight) === 1)
        .length,
    [assignments]
  );

  // รายการปี ค.ศ./พ.ศ. สำหรับเปลี่ยนเดือนและปีได้ง่าย
  const selectableYears = useMemo(() => {
    const curY = Number(initialBkk.currentYear) || 2026;
    return [curY - 2, curY - 1, curY, curY + 1, curY + 2];
  }, [initialBkk.currentYear]);

  function handleChangeYearOrMonth(newYear: number, newMonth: number) {
    const mm = String(Math.min(12, Math.max(1, newMonth))).padStart(2, '0');
    setSelectedMonth(`${newYear}-${mm}`);
    setRosterPersonPage(1);
    setSelectedWeekIndex(0);
  }

  return (
    <div className="space-y-5">
      {/* =====================================================================
          ส่วนหัวหลักของโมดูล (Lavender & Clean White Government Workforce Header)
         ===================================================================== */}
      <div className="bg-white border border-violet-200/90 rounded-xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[12.5px] font-semibold text-violet-700">
            ระบบบริหารตารางเวรและเวลาปฏิบัติงานบุคลากร · โรงพยาบาลสามชุก
          </div>
          <h1 className="text-[20px] sm:text-[23px] font-bold text-slate-900 tracking-tight">
            ตารางเวรและแม่แบบกะทำงาน
          </h1>
          <p className="text-[13.5px] text-slate-600">
            จัดตารางเวรรายเดือนและรายสัปดาห์ เพิ่มเวรรายบุคคลหรือหลายคนพร้อมตรวจสอบความซ้ำซ้อนก่อนบันทึกจริง
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {activeTab === 'ASSIGN_WORKSPACE' ? (
            <button
              type="button"
              onClick={() => setActiveTab('ROSTER')}
              className="h-10 px-4 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <ArrowLeft className="w-4 h-4 text-slate-600" />
              <span>กลับไปหน้าตารางเวร</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={handleDownloadExcelTemplate}
                className="h-10 px-3.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Download className="w-4 h-4 text-violet-700" />
                <span>ดาวน์โหลด Template Excel</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setExcelPreview(null);
                  setExcelError(null);
                  setShowExcelImportModal(true);
                }}
                className="h-10 px-3.5 rounded-lg border border-violet-300 bg-violet-50/90 hover:bg-violet-100 text-violet-900 text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <Upload className="w-4 h-4 text-violet-700" />
                <span>นำเข้าตารางเวรจาก Excel</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  openAssignWorkspace({
                    method: 'SINGLE_PERSON',
                  })
                }
                className="h-10 px-3.5 rounded-lg border border-violet-300 bg-violet-50/80 hover:bg-violet-100 text-violet-900 text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap"
              >
                <User className="w-4 h-4 text-violet-700" />
                <span>เพิ่มเวรรายบุคคล (1 คน)</span>
              </button>

              <button
                type="button"
                onClick={() =>
                  openAssignWorkspace({
                    method: 'MULTI_PERSON',
                  })
                }
                className="h-10 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
              >
                <Users className="w-4 h-4" />
                <span>เพิ่มเวรหลายคนพร้อมกัน</span>
              </button>
            </>
          )}
        </div>
      </div>

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* =====================================================================
          แถบนำทางหลัก 3 หน้าจอ (Full-Page Navigation Tabs)
         ===================================================================== */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div
          role="tablist"
          aria-label="แถบเมนูหลักตารางเวรและแม่แบบกะ"
          className="inline-flex flex-wrap items-center p-1 bg-violet-50/70 border border-violet-200/80 rounded-lg w-full md:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ROSTER'}
            onClick={() => setActiveTab('ROSTER')}
            className={`flex-1 md:flex-initial px-4 py-2 rounded-md text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'ROSTER'
                ? 'bg-white text-violet-900 border border-violet-200 shadow-2xs'
                : 'text-slate-700 hover:text-violet-900'
            }`}
          >
            <Calendar className="w-4 h-4 text-violet-700" />
            <span>1. ตารางเวรปฏิบัติงาน</span>
            <span className="font-mono text-[12px] text-slate-500 tabular-nums">
              ({activeCountInMonth})
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ASSIGN_WORKSPACE'}
            onClick={() => {
              if (activeTab !== 'ASSIGN_WORKSPACE') {
                openAssignWorkspace({ method: assignMethod });
              }
            }}
            className={`flex-1 md:flex-initial px-4 py-2 rounded-md text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'ASSIGN_WORKSPACE'
                ? 'bg-white text-violet-900 border border-violet-200 shadow-2xs'
                : 'text-slate-700 hover:text-violet-900'
            }`}
          >
            <Plus className="w-4 h-4 text-violet-700" />
            <span>2. จัดเวร / เพิ่มเวรใหม่</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'TEMPLATES'}
            onClick={() => setActiveTab('TEMPLATES')}
            className={`flex-1 md:flex-initial px-4 py-2 rounded-md text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'TEMPLATES'
                ? 'bg-white text-violet-900 border border-violet-200 shadow-2xs'
                : 'text-slate-700 hover:text-violet-900'
            }`}
          >
            <Clock className="w-4 h-4 text-violet-700" />
            <span>3. แม่แบบกะทำงาน</span>
            <span className="font-mono text-[12px] text-slate-500 tabular-nums">
              ({shifts.length})
            </span>
          </button>
        </div>

        {/* สลับมุมมองภายในหน้าตารางเวร: รายเดือน | รายสัปดาห์ | รายการ */}
        {activeTab === 'ROSTER' && (
          <div className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg self-start md:self-auto">
            <button
              type="button"
              onClick={() => setRosterViewMode('MONTHLY_GRID')}
              className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                rosterViewMode === 'MONTHLY_GRID'
                  ? 'bg-violet-700 text-white'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>ตารางรายเดือน</span>
            </button>

            <button
              type="button"
              onClick={() => setRosterViewMode('WEEKLY_GRID')}
              className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                rosterViewMode === 'WEEKLY_GRID'
                  ? 'bg-violet-700 text-white'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>ตารางรายสัปดาห์</span>
            </button>

            <button
              type="button"
              onClick={() => setRosterViewMode('DETAIL_LIST')}
              className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                rosterViewMode === 'DETAIL_LIST'
                  ? 'bg-violet-700 text-white'
                  : 'text-slate-700 hover:text-slate-900'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>มุมมองรายการ ({filteredAssignments.length})</span>
            </button>
          </div>
        )}
      </div>

      {/* =====================================================================
          หน้าจอที่ 1: ตารางเวรปฏิบัติงาน (FULL-PAGE SCHEDULE MANAGEMENT)
         ===================================================================== */}
      {activeTab === 'ROSTER' && (
        <div className="space-y-4">
          {/* แถบเลือกเดือน/ปี พ.ศ. และตัวกรองตารางเวร */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3.5">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              {/* เลือกเดือนและปี พ.ศ. ได้ง่ายโดยตรง */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center bg-violet-50/70 border border-violet-200 rounded-lg p-1 gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMonth((m) => shiftMonthString(m, -1));
                      setRosterPersonPage(1);
                    }}
                    className="h-8 px-2.5 rounded-md text-violet-900 hover:bg-white transition-colors inline-flex items-center gap-1 text-[12.5px] font-semibold"
                    title="เดือนก่อนหน้า"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span className="hidden sm:inline">เดือนก่อน</span>
                  </button>

                  <select
                    aria-label="เลือกเดือนภาษาไทย"
                    value={monthBounds.month}
                    onChange={(e) =>
                      handleChangeYearOrMonth(monthBounds.year, Number(e.target.value))
                    }
                    className="h-8 px-2.5 rounded-md bg-white border border-violet-200 text-[13.5px] font-bold text-violet-950 focus:outline-none focus:border-violet-600"
                  >
                    {THAI_FULL_MONTHS.map((mName, idx) => (
                      <option key={mName} value={idx + 1}>
                        เดือน{mName}
                      </option>
                    ))}
                  </select>

                  <select
                    aria-label="เลือกปี พ.ศ."
                    value={monthBounds.year}
                    onChange={(e) =>
                      handleChangeYearOrMonth(Number(e.target.value), monthBounds.month)
                    }
                    className="h-8 px-2.5 rounded-md bg-white border border-violet-200 text-[13.5px] font-bold text-violet-950 font-mono tabular-nums focus:outline-none focus:border-violet-600"
                  >
                    {selectableYears.map((y) => (
                      <option key={y} value={y}>
                        พ.ศ. {y + 543} ({y})
                      </option>
                    ))}
                  </select>

                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMonth((m) => shiftMonthString(m, 1));
                      setRosterPersonPage(1);
                    }}
                    className="h-8 px-2.5 rounded-md text-violet-900 hover:bg-white transition-colors inline-flex items-center gap-1 text-[12.5px] font-semibold"
                    title="เดือนถัดไป"
                  >
                    <span className="hidden sm:inline">เดือนถัดไป</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                {selectedMonth !== initialBkk.currentYearMonth && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMonth(initialBkk.currentYearMonth);
                      setRosterPersonPage(1);
                    }}
                    className="h-9 px-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-[12.5px] font-semibold text-slate-700 whitespace-nowrap"
                  >
                    กลับมาเดือนปัจจุบัน
                  </button>
                )}

                <div className="text-[13px] text-slate-600 flex items-center gap-1.5 flex-wrap pl-1">
                  <span>บุคลากรที่แสดง {filteredPersonnelForRoster.length} คน</span>
                  <span aria-hidden="true">·</span>
                  <span>เวรทั้งหมดในเดือน {activeCountInMonth} เวร</span>
                  <span aria-hidden="true">·</span>
                  <span>เวรข้ามวัน {crossMidnightCountInMonth} เวร</span>
                </div>
              </div>

              {/* ตัวเลือกช่วงวันที่สำหรับตารางรายเดือน หรือเลือกสัปดาห์สำหรับตารางรายสัปดาห์ */}
              {rosterViewMode === 'MONTHLY_GRID' && (
                <div className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg self-start xl:self-auto">
                  <button
                    type="button"
                    onClick={() => setDayRangeMode('ALL')}
                    className={`px-3 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                      dayRangeMode === 'ALL'
                        ? 'bg-white text-violet-800 font-semibold shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    ทั้งเดือน (1–{monthBounds.daysInMonth})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDayRangeMode('FIRST_HALF')}
                    className={`px-3 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                      dayRangeMode === 'FIRST_HALF'
                        ? 'bg-white text-violet-800 font-semibold shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    ครึ่งเดือนแรก (1–15)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDayRangeMode('SECOND_HALF')}
                    className={`px-3 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                      dayRangeMode === 'SECOND_HALF'
                        ? 'bg-white text-violet-800 font-semibold shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    ครึ่งเดือนหลัง (16–{monthBounds.daysInMonth})
                  </button>
                </div>
              )}

              {rosterViewMode === 'WEEKLY_GRID' && (
                <div className="inline-flex items-center gap-1.5 bg-violet-50/70 border border-violet-200 rounded-lg p-1 self-start xl:self-auto">
                  <button
                    type="button"
                    disabled={selectedWeekIndex <= 0}
                    onClick={() => setSelectedWeekIndex((w) => Math.max(0, w - 1))}
                    className="h-8 px-2.5 rounded-md text-violet-900 hover:bg-white disabled:opacity-40 text-[12.5px] font-semibold inline-flex items-center gap-1"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>สัปดาห์ก่อน</span>
                  </button>
                  <select
                    aria-label="เลือกสัปดาห์ในเดือน"
                    value={selectedWeekIndex}
                    onChange={(e) => setSelectedWeekIndex(Number(e.target.value))}
                    className="h-8 px-2.5 rounded-md bg-white border border-violet-200 text-[13px] font-semibold text-violet-950 focus:outline-none"
                  >
                    {monthBounds.weeks.map((w) => (
                      <option key={w.weekIndex} value={w.weekIndex}>
                        {w.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    disabled={selectedWeekIndex >= monthBounds.weeks.length - 1}
                    onClick={() =>
                      setSelectedWeekIndex((w) => Math.min(monthBounds.weeks.length - 1, w + 1))
                    }
                    className="h-8 px-2.5 rounded-md text-violet-900 hover:bg-white disabled:opacity-40 text-[12.5px] font-semibold inline-flex items-center gap-1"
                  >
                    <span>สัปดาห์ถัดไป</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            {/* แถวตัวกรอง: ค้นหาบุคลากร, กรองตามกลุ่มงาน/แผนก, กรองตามแม่แบบกะ, สถานะ */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 items-center">
              <div className="relative lg:col-span-4">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value);
                    setPage(1);
                    setRosterPersonPage(1);
                  }}
                  placeholder="ค้นหาชื่อ-สกุล, รหัสบุคลากร, รหัสสแกนนิ้ว..."
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-violet-600"
                />
              </div>

              <div className="lg:col-span-3">
                <select
                  aria-label="กรองตามกลุ่มงานหรือแผนก"
                  value={departmentFilter}
                  onChange={(e) => {
                    setDepartmentFilter(e.target.value);
                    setPage(1);
                    setRosterPersonPage(1);
                  }}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                >
                  <option value="ALL">ทุกกลุ่มงาน / แผนก ({personnel.length} คน)</option>
                  {departments.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>
              </div>

              <div className="lg:col-span-3">
                <select
                  aria-label="กรองตามแม่แบบกะทำงาน"
                  value={shiftFilter}
                  onChange={(e) => {
                    setShiftFilter(e.target.value);
                    setPage(1);
                    setRosterPersonPage(1);
                  }}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                >
                  <option value="ALL">ทุกแม่แบบกะทำงาน ({shifts.length} แม่แบบ)</option>
                  {shifts.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {formatCleanShiftName(s.shift_name)} · {s.start_time}–{s.end_time} น. ({s.shift_code})
                    </option>
                  ))}
                </select>
              </div>

              <div className="lg:col-span-2 flex items-center gap-2">
                <select
                  aria-label="กรองตามสถานะตารางเวร"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(e.target.value as 'ACTIVE' | 'CANCELLED' | 'ALL');
                    setPage(1);
                  }}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                >
                  <option value="ACTIVE">เวรที่ใช้งานปกติ</option>
                  <option value="ALL">ทุกสถานะ</option>
                  <option value="CANCELLED">เฉพาะที่ยกเลิก</option>
                </select>

                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="h-10 px-3 rounded-lg border border-slate-300 bg-slate-50 hover:bg-slate-100 text-slate-700 text-[13px] font-medium inline-flex items-center gap-1 shrink-0"
                    title="ล้างตัวกรองทั้งหมด"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span className="hidden xl:inline">ล้าง</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* =================================================================
              มุมมองที่ 1.1: ตารางเวรรายเดือน (MONTHLY ROSTER GRID)
             ================================================================= */}
          {rosterViewMode === 'MONTHLY_GRID' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 sm:px-5 py-3.5 bg-violet-50/50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-[16px] font-bold text-slate-900">
                    ตารางเวรรายเดือน · {formatThaiMonthTitle(selectedMonth)}
                  </h2>
                  <p className="text-[12.5px] text-slate-600">
                    คลิกที่ช่องตารางของบุคลากรในแต่ละวัน เพื่อเพิ่มกะ เปลี่ยนกะ ลบกะทั้งหมด (ตั้งเป็นไม่มีเวร) หรือคืนค่ากะเช้าเริ่มต้นได้ทันที
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-600">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-emerald-50 border border-emerald-300 inline-block" />
                    <span>กะเช้าเริ่มต้นตามประเภทบุคลากร</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-violet-100 border border-violet-300 inline-block" />
                    <span>เวรที่จัดเอง / แก้ไขเฉพาะวัน</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-blue-100 border border-blue-300 inline-block" />
                    <span>เวรข้ามวัน (+1 วัน)</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-amber-50 border border-amber-300 inline-block" />
                    <span>ไม่มีเวร (ลบเวรวันนั้นแล้ว)</span>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[680px]">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="sticky top-0 z-20">
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                      <th className="sticky left-0 z-30 bg-slate-50 py-3 px-4 font-semibold min-w-[230px] max-w-[260px] border-r border-slate-200">
                        บุคลากร / กลุ่มงาน ({filteredPersonnelForRoster.length} คน)
                      </th>
                      <th className="py-3 px-2.5 font-semibold text-center min-w-[68px] border-r border-slate-200 bg-slate-50">
                        รวมเวร
                      </th>
                      {visibleMonthDates.map((d) => {
                        const isToday = d.dateStr === initialBkk.todayYmd;
                        return (
                          <th
                            key={d.dateStr}
                            className={`py-2 px-1.5 text-center min-w-[74px] border-r border-slate-200/80 font-mono tabular-nums ${
                              isToday
                                ? 'bg-violet-100 text-violet-950'
                                : d.isWeekend
                                  ? 'bg-slate-100 text-slate-700'
                                  : 'bg-slate-50 text-slate-700'
                            }`}
                          >
                            <div className="text-[11px] font-sans font-medium text-slate-500">
                              {d.weekdayShort}
                            </div>
                            <div className="text-[13px] font-bold">{d.dayNum}</div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loading ? (
                      <tr>
                        <td
                          colSpan={visibleMonthDates.length + 2}
                          className="py-12 text-center text-[14px] text-slate-500"
                        >
                          กำลังโหลดตารางเวรรายเดือน...
                        </td>
                      </tr>
                    ) : pagedPersonnelForRoster.length === 0 ? (
                      <TableEmptyState
                        colSpan={visibleMonthDates.length + 2}
                        title="ไม่พบบุคลากรตามเงื่อนไขที่ค้นหา"
                        description="ลองเปลี่ยนคำค้นหาหรือเลือกทุกกลุ่มงานเพื่อแสดงตารางเวรทั้งหมด"
                      />
                    ) : (
                      pagedPersonnelForRoster.map((person) => {
                        const pid = String(person.person_id).trim();
                        let personTotalShifts = 0;
                        for (const d of visibleMonthDates) {
                          const eff = getEffectiveCellState(person, d.dateStr);
                          if (eff.mode === 'CUSTOM_ASSIGNED') {
                            personTotalShifts += eff.activeItems.length;
                          } else if (eff.mode === 'DEFAULT_FROM_TYPE') {
                            personTotalShifts += 1;
                          }
                        }

                        return (
                          <tr
                            key={pid}
                            className="hover:bg-violet-50/25 transition-colors group"
                          >
                            {/* คอลัมน์รายชื่อบุคลากรทางซ้าย (Sticky Left) */}
                            <td className="sticky left-0 z-10 bg-white group-hover:bg-violet-50/40 py-3 px-4 border-r border-slate-200 align-top">
                              <div className="font-bold text-[13.5px] text-slate-900 leading-snug">
                                {person.full_name}
                              </div>
                              <div className="text-[12px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span className="font-mono">{pid}</span>
                                <span aria-hidden="true">·</span>
                                <span className="truncate max-w-[155px]">
                                  {person.department_name}
                                </span>
                              </div>
                              {person.personnel_type_name && (
                                <div className="text-[11px] text-violet-700 font-medium mt-0.5">
                                  {person.personnel_type_name}
                                </div>
                              )}
                            </td>

                            {/* จำนวนเวรรวมในเดือนนี้ */}
                            <td className="py-3 px-2 text-center font-mono tabular-nums font-bold text-violet-800 border-r border-slate-200 align-middle bg-slate-50/40">
                              {personTotalShifts}
                            </td>

                            {/* ช่องวันที่แต่ละวันในเดือน */}
                            {visibleMonthDates.map((d) => {
                              const cellEff = getEffectiveCellState(person, d.dateStr);
                              return (
                                <td
                                  key={d.dateStr}
                                  className={`p-1.5 border-r border-slate-200/70 align-top min-h-[64px] ${
                                    d.isWeekend ? 'bg-slate-50/75' : ''
                                  }`}
                                >
                                  <div className="flex flex-col gap-1 min-h-[50px]">
                                    {cellEff.mode === 'CLEARED_ALL_SHIFTS' ? (
                                      <button
                                        type="button"
                                        onClick={() => openQuickCellModal(person, d.dateStr)}
                                        className="w-full h-12 rounded-md border border-dashed border-amber-300 bg-amber-50/60 hover:bg-amber-100/70 text-amber-900 flex flex-col items-center justify-center gap-0.5 transition-colors px-1"
                                        title={`วันที่ ${formatThaiDate(d.dateStr)} ถูกลบเวรออกแล้ว (ไม่มีเวร) คลิกเพื่อเพิ่มเวรหรือคืนค่ากะเริ่มต้น`}
                                      >
                                        <span className="text-[10.5px] font-bold">ไม่มีเวร</span>
                                        <span className="text-[9.5px] text-amber-800">
                                          (ลบเวรแล้ว)
                                        </span>
                                      </button>
                                    ) : cellEff.mode === 'DEFAULT_FROM_TYPE' && cellEff.defaultRule ? (
                                      <button
                                        type="button"
                                        onClick={() => openQuickCellModal(person, d.dateStr)}
                                        className="w-full text-left px-1.5 py-1 rounded border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100/80 text-emerald-950 text-[11px] leading-tight transition-colors"
                                        title={`กะเช้าเริ่มต้นตามประเภทบุคลากร (${cellEff.defaultRule.default_start_time || '08:00'}–${cellEff.defaultRule.default_end_time || '16:00'} น.) คลิกเพื่อเปลี่ยนกะ เพิ่มกะบ่าย/ดึก หรือลบเวร`}
                                      >
                                        <div className="font-semibold flex items-center justify-between gap-0.5">
                                          <span className="truncate">กะเช้า (เริ่มต้น)</span>
                                        </div>
                                        <div className="font-mono text-[10px] opacity-85 tabular-nums">
                                          {cellEff.defaultRule.default_start_time || '08:00'}–
                                          {cellEff.defaultRule.default_end_time || '16:00'}
                                        </div>
                                      </button>
                                    ) : cellEff.mode === 'CUSTOM_ASSIGNED' ? (
                                      <>
                                        {cellEff.activeItems.map((item) => {
                                          const isCross =
                                            Number(item.snapshot_is_cross_midnight) === 1;
                                          return (
                                            <button
                                              key={item.id}
                                              type="button"
                                              onClick={() => openQuickCellModal(person, d.dateStr)}
                                              title={`${formatCleanShiftName(item.snapshot_shift_name)} (${item.snapshot_start_time}–${item.snapshot_end_time} น.) คลิกเพื่อแก้ไขหรือลบเวร`}
                                              className={`w-full text-left px-1.5 py-1 rounded border text-[11.5px] leading-tight transition-colors ${
                                                isCross
                                                  ? 'bg-blue-50 border-blue-200 text-blue-900 hover:bg-blue-100'
                                                  : 'bg-violet-50 border-violet-200 text-violet-950 hover:bg-violet-100'
                                              }`}
                                            >
                                              <div className="font-semibold flex items-center justify-between gap-0.5">
                                                <span className="truncate">
                                                  {formatCleanShiftName(item.snapshot_shift_name)}
                                                </span>
                                                {isCross && (
                                                  <Moon className="w-3 h-3 text-blue-700 shrink-0" />
                                                )}
                                              </div>
                                              <div className="font-mono text-[10.5px] opacity-85 tabular-nums">
                                                {item.snapshot_start_time}–{item.snapshot_end_time}
                                              </div>
                                            </button>
                                          );
                                        })}

                                        <button
                                          type="button"
                                          onClick={() => openQuickCellModal(person, d.dateStr)}
                                          className="w-full h-5 rounded border border-dashed border-slate-200 text-slate-400 hover:border-violet-400 hover:text-violet-700 hover:bg-violet-50/50 text-[10px] flex items-center justify-center transition-colors"
                                          title={`จัดการเวรของ ${person.full_name} วันที่ ${formatThaiDate(d.dateStr)}`}
                                        >
                                          <Plus className="w-3 h-3" />
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => openQuickCellModal(person, d.dateStr)}
                                        className="w-full h-12 rounded-md border border-dashed border-slate-200/90 hover:border-violet-400 hover:bg-violet-50/70 text-slate-400 hover:text-violet-800 flex flex-col items-center justify-center gap-0.5 transition-colors"
                                        title={`คลิกเพื่อจัดการเวรให้ ${person.full_name} วันที่ ${formatThaiDate(d.dateStr)}`}
                                      >
                                        <span className="text-[10.5px] font-medium">ไม่มีเวร</span>
                                        <span className="text-[10px] font-semibold inline-flex items-center gap-0.5 text-violet-700 opacity-80">
                                          <Plus className="w-3 h-3" /> จัดเวร
                                        </span>
                                      </button>
                                    )}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {/* แถบแบ่งหน้าบุคลากรในตารางเวรรายเดือน */}
              <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[13px] text-slate-600">
                <div>
                  แสดงบุคลากร{' '}
                  <span className="font-semibold text-slate-800">
                    {filteredPersonnelForRoster.length === 0
                      ? 0
                      : (rosterPersonPage - 1) * rosterPersonPageSize + 1}
                  </span>{' '}
                  ถึง{' '}
                  <span className="font-semibold text-slate-800">
                    {Math.min(
                      rosterPersonPage * rosterPersonPageSize,
                      filteredPersonnelForRoster.length
                    )}
                  </span>{' '}
                  จากทั้งหมด{' '}
                  <span className="font-semibold text-slate-800">
                    {filteredPersonnelForRoster.length}
                  </span>{' '}
                  คน
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[12.5px] text-slate-600">จำนวนคนต่อหน้า:</label>
                  <select
                    value={rosterPersonPageSize}
                    onChange={(e) => {
                      setRosterPersonPageSize(Number(e.target.value));
                      setRosterPersonPage(1);
                    }}
                    className="h-8 px-2 rounded border border-slate-300 bg-white text-[12.5px] font-mono"
                  >
                    <option value={15}>15 คน</option>
                    <option value={25}>25 คน</option>
                    <option value={50}>50 คน</option>
                    <option value={100}>100 คน</option>
                  </select>

                  <div className="inline-flex items-center gap-1">
                    <button
                      type="button"
                      disabled={rosterPersonPage <= 1}
                      onClick={() => setRosterPersonPage((p) => Math.max(1, p - 1))}
                      className="h-8 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-[12.5px] font-medium"
                    >
                      ก่อนหน้า
                    </button>
                    <span className="px-2 font-mono text-[12.5px]">
                      หน้า {rosterPersonPage} / {rosterTotalPages}
                    </span>
                    <button
                      type="button"
                      disabled={rosterPersonPage >= rosterTotalPages}
                      onClick={() =>
                        setRosterPersonPage((p) => Math.min(rosterTotalPages, p + 1))
                      }
                      className="h-8 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-[12.5px] font-medium"
                    >
                      ถัดไป
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* =================================================================
              มุมมองที่ 1.2: ตารางเวรรายสัปดาห์ (WEEKLY ROSTER GRID)
             ================================================================= */}
          {rosterViewMode === 'WEEKLY_GRID' && (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 sm:px-5 py-3.5 bg-violet-50/50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-[16px] font-bold text-slate-900">
                    ตารางเวรรายสัปดาห์ · {activeWeekObj.label}
                  </h2>
                  <p className="text-[12.5px] text-slate-600">
                    แสดงรายละเอียดชื่อกะทำงาน เวลาเริ่ม–เลิกงาน และสถานะไม่มีเวรแบบเต็มช่อง อ่านง่ายสำหรับตรวจเวรรายสัปดาห์
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={selectedWeekIndex <= 0}
                    onClick={() => setSelectedWeekIndex((w) => Math.max(0, w - 1))}
                    className="h-8 px-3 rounded-lg border border-violet-200 bg-white hover:bg-violet-50 disabled:opacity-40 text-violet-900 text-[12.5px] font-semibold inline-flex items-center gap-1"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>สัปดาห์ก่อน</span>
                  </button>
                  <button
                    type="button"
                    disabled={selectedWeekIndex >= monthBounds.weeks.length - 1}
                    onClick={() =>
                      setSelectedWeekIndex((w) => Math.min(monthBounds.weeks.length - 1, w + 1))
                    }
                    className="h-8 px-3 rounded-lg border border-violet-200 bg-white hover:bg-violet-50 disabled:opacity-40 text-violet-900 text-[12.5px] font-semibold inline-flex items-center gap-1"
                  >
                    <span>สัปดาห์ถัดไป</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[680px]">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="sticky top-0 z-20">
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                      <th className="sticky left-0 z-30 bg-slate-50 py-3 px-4 font-semibold min-w-[230px] max-w-[260px] border-r border-slate-200">
                        บุคลากร / กลุ่มงาน ({filteredPersonnelForRoster.length} คน)
                      </th>
                      {activeWeekObj.dates.map((d) => {
                        const isToday = d.dateStr === initialBkk.todayYmd;
                        return (
                          <th
                            key={d.dateStr}
                            className={`py-2.5 px-3 text-center min-w-[138px] border-r border-slate-200/80 ${
                              isToday
                                ? 'bg-violet-100 text-violet-950'
                                : d.isWeekend
                                  ? 'bg-slate-100 text-slate-700'
                                  : 'bg-slate-50 text-slate-700'
                            }`}
                          >
                            <div className="text-[12px] font-semibold">{d.weekdayFull}</div>
                            <div className="text-[12.5px] font-mono tabular-nums text-slate-600">
                              {formatThaiDate(d.dateStr)}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loading ? (
                      <tr>
                        <td
                          colSpan={activeWeekObj.dates.length + 1}
                          className="py-12 text-center text-[14px] text-slate-500"
                        >
                          กำลังโหลดตารางเวรรายสัปดาห์...
                        </td>
                      </tr>
                    ) : pagedPersonnelForRoster.length === 0 ? (
                      <TableEmptyState
                        colSpan={activeWeekObj.dates.length + 1}
                        title="ไม่พบบุคลากรตามเงื่อนไขที่ค้นหา"
                        description="ลองเปลี่ยนคำค้นหาหรือเลือกทุกกลุ่มงานเพื่อแสดงตารางเวรรายสัปดาห์"
                      />
                    ) : (
                      pagedPersonnelForRoster.map((person) => {
                        const pid = String(person.person_id).trim();
                        return (
                          <tr key={pid} className="hover:bg-violet-50/25 transition-colors group">
                            <td className="sticky left-0 z-10 bg-white group-hover:bg-violet-50/40 py-3 px-4 border-r border-slate-200 align-top">
                              <div className="font-bold text-[13.5px] text-slate-900">
                                {person.full_name}
                              </div>
                              <div className="text-[12px] text-slate-500 mt-0.5">
                                <span className="font-mono">{pid}</span> · {person.department_name}
                              </div>
                            </td>

                            {activeWeekObj.dates.map((d) => {
                              const cellEff = getEffectiveCellState(person, d.dateStr);
                              return (
                                <td
                                  key={d.dateStr}
                                  className={`p-2 border-r border-slate-200/70 align-top ${
                                    d.isWeekend ? 'bg-slate-50/75' : ''
                                  }`}
                                >
                                  <div className="flex flex-col gap-1.5 min-h-[64px]">
                                    {cellEff.mode === 'CLEARED_ALL_SHIFTS' ? (
                                      <button
                                        type="button"
                                        onClick={() => openQuickCellModal(person, d.dateStr)}
                                        className="w-full h-14 rounded-lg border border-dashed border-amber-300 bg-amber-50/60 hover:bg-amber-100/70 text-amber-900 flex flex-col items-center justify-center gap-0.5 transition-colors"
                                      >
                                        <span className="text-[12px] font-bold">ไม่มีเวร (ลบเวรแล้ว)</span>
                                        <span className="text-[11px] font-semibold text-amber-800 inline-flex items-center gap-1">
                                          คลิกเพื่อเพิ่มเวรหรือคืนค่าเริ่มต้น
                                        </span>
                                      </button>
                                    ) : cellEff.mode === 'DEFAULT_FROM_TYPE' && cellEff.defaultRule ? (
                                      <button
                                        type="button"
                                        onClick={() => openQuickCellModal(person, d.dateStr)}
                                        className="w-full text-left p-2 rounded-lg border border-emerald-200 bg-emerald-50/70 hover:bg-emerald-100/80 text-emerald-950 text-[12px] space-y-0.5 transition-colors"
                                      >
                                        <div className="font-bold leading-snug">
                                          กะเช้า (ค่าเริ่มต้นตามประเภท)
                                        </div>
                                        <div className="font-mono text-[11.5px] font-semibold tabular-nums">
                                          {cellEff.defaultRule.default_start_time || '08:00'}–
                                          {cellEff.defaultRule.default_end_time || '16:00'} น.
                                        </div>
                                        <div className="text-[10.5px] text-emerald-800">
                                          ผ่อนผัน {cellEff.defaultRule.default_grace_minutes ?? 15} นาที · คลิกเพื่อแก้ไข
                                        </div>
                                      </button>
                                    ) : cellEff.mode === 'CUSTOM_ASSIGNED' ? (
                                      <>
                                        {cellEff.activeItems.map((item) => {
                                          const isCross =
                                            Number(item.snapshot_is_cross_midnight) === 1;
                                          return (
                                            <button
                                              key={item.id}
                                              type="button"
                                              onClick={() => openQuickCellModal(person, d.dateStr)}
                                              className={`w-full text-left p-2 rounded-lg border text-[12px] space-y-0.5 transition-colors ${
                                                isCross
                                                  ? 'bg-blue-50 border-blue-200 text-blue-950 hover:bg-blue-100'
                                                  : 'bg-violet-50 border-violet-200 text-violet-950 hover:bg-violet-100'
                                              }`}
                                            >
                                              <div className="font-bold leading-snug">
                                                {formatCleanShiftName(item.snapshot_shift_name)}
                                              </div>
                                              <div className="font-mono text-[11.5px] font-semibold tabular-nums">
                                                {item.snapshot_start_time}–{item.snapshot_end_time} น.
                                              </div>
                                              <div className="text-[10.5px] text-slate-500 font-mono">
                                                รหัส: {item.snapshot_shift_code}
                                                {isCross ? ' · ข้ามวัน' : ''}
                                              </div>
                                            </button>
                                          );
                                        })}
                                        <button
                                          type="button"
                                          onClick={() => openQuickCellModal(person, d.dateStr)}
                                          className="w-full h-6 rounded border border-dashed border-slate-200 text-slate-500 hover:border-violet-400 hover:text-violet-800 hover:bg-violet-50 text-[11px] font-medium inline-flex items-center justify-center gap-1"
                                        >
                                          <Plus className="w-3 h-3" />
                                          <span>จัดการ / เพิ่มกะ</span>
                                        </button>
                                      </>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={() => openQuickCellModal(person, d.dateStr)}
                                        className="w-full h-14 rounded-lg border border-dashed border-slate-200 hover:border-violet-400 hover:bg-violet-50/70 text-slate-400 hover:text-violet-800 flex flex-col items-center justify-center gap-0.5 transition-colors"
                                      >
                                        <span className="text-[12px] font-medium">ไม่มีเวร</span>
                                        <span className="text-[11px] font-semibold text-violet-700 inline-flex items-center gap-1">
                                          <Plus className="w-3.5 h-3.5" /> คลิกเพื่อเพิ่มเวร
                                        </span>
                                      </button>
                                    )}
                                  </div>
                                </td>
                              );
                            })}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* =================================================================
              มุมมองที่ 1.3: มุมมองรายการละเอียดและประวัติการยกเลิก (LIST VIEW)
             ================================================================= */}
          {rosterViewMode === 'DETAIL_LIST' && (
            <div className="space-y-5">
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-violet-50/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[16.5px] font-bold text-slate-900">
                      รายการเวรที่มอบหมาย ({filteredAssignments.length} รายการ)
                    </h2>
                    <p className="text-[13px] text-slate-600">
                      แสดงค่าเวลาตาม Snapshot ณ วันที่มอบหมายเวร (เวลาเริ่ม–เลิกงาน เวลาผ่อนผันสาย และเวลาตัดรอบสแกน)
                    </p>
                  </div>
                </div>

                {/* มุมมองการ์ดสำหรับหน้าจอขนาดเล็ก (< 768px) */}
                <div className="md:hidden divide-y divide-slate-200">
                  {loading ? (
                    <div className="py-10 text-center text-[14px] text-slate-500">
                      กำลังโหลดรายการตารางเวร...
                    </div>
                  ) : pagedAssignments.length === 0 ? (
                    <div className="py-10 px-4 text-center text-[14px] text-slate-500">
                      ไม่พบรายการตารางเวรตามเงื่อนไขที่เลือก
                    </div>
                  ) : (
                    pagedAssignments.map((a) => {
                      const isCross = Number(a.snapshot_is_cross_midnight) === 1;
                      return (
                        <div key={a.id} className="p-4 space-y-3 bg-white">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="font-bold text-[15px] text-slate-900">
                                {a.full_name}
                              </div>
                              <div className="text-[12.5px] text-slate-500">
                                {a.person_id} · {a.department_name}
                              </div>
                            </div>
                            <span
                              className={`text-[12.5px] font-semibold ${
                                a.status === 'ACTIVE' ? 'text-emerald-700' : 'text-red-700'
                              }`}
                            >
                              {a.status === 'ACTIVE' ? 'ใช้งานปกติ' : 'ยกเลิกแล้ว'}
                            </span>
                          </div>

                          <div className="p-3 rounded-lg bg-slate-50 border border-slate-200 text-[13px] space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500">วันที่ปฏิบัติงาน:</span>
                              <span className="font-mono font-bold text-slate-800">
                                {formatThaiDate(a.work_date)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500">กะทำงาน:</span>
                              <span className="font-semibold text-violet-900">
                                {formatCleanShiftName(a.snapshot_shift_name)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500">เวลาเริ่ม–เลิกงาน:</span>
                              <span className="font-mono text-slate-800">
                                {a.snapshot_start_time}–{a.snapshot_end_time} น.{' '}
                                {isCross ? '(ข้ามวัน +1)' : ''}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500">รหัสกะ / ผ่อนผัน / ตัดรอบ:</span>
                              <span className="font-mono text-slate-700">
                                {a.snapshot_shift_code} · ผ่อนผัน {a.snapshot_grace_minutes} น. · ตัดรอบ{' '}
                                {a.snapshot_cutoff_time} น.
                              </span>
                            </div>
                          </div>

                          {a.status === 'ACTIVE' && (
                            <button
                              type="button"
                              onClick={() => setCancelTarget(a)}
                              className="w-full h-10 px-3.5 text-[13px] text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 inline-flex items-center justify-center gap-1.5 font-semibold transition-colors"
                            >
                              <Trash2 className="w-4 h-4" />
                              <span>ยกเลิกตารางเวร</span>
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>

                {/* ตารางสำหรับ Desktop และ Tablet (>= 768px) */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[13.5px]">
                    <thead>
                      <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                        <SortableHeader
                          label="วันที่ปฏิบัติงาน"
                          sortKey="work_date"
                          activeSortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSort}
                        />
                        <SortableHeader
                          label="บุคลากร · กลุ่มงาน"
                          sortKey="full_name"
                          activeSortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSort}
                        />
                        <SortableHeader
                          label="กะทำงาน (Snapshot)"
                          sortKey="snapshot_shift_code"
                          activeSortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSort}
                        />
                        <th className="py-3.5 px-4 font-semibold">เวลาเริ่ม–เลิกงาน</th>
                        <th className="py-3.5 px-4 font-semibold">ผ่อนผันสาย / ตัดรอบ</th>
                        <SortableHeader
                          label="สถานะ"
                          sortKey="status"
                          activeSortKey={sortKey}
                          sortDir={sortDir}
                          onSort={handleSort}
                        />
                        <th className="py-3.5 px-4 font-semibold text-right">การจัดการ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {loading ? (
                        <tr>
                          <td colSpan={7} className="py-12 text-center text-[14px] text-slate-500">
                            กำลังโหลดตารางเวร...
                          </td>
                        </tr>
                      ) : pagedAssignments.length === 0 ? (
                        <TableEmptyState
                          colSpan={7}
                          title="ไม่พบรายการตารางเวรในเดือนหรือตัวกรองที่เลือก"
                          description="คลิกปุ่ม “เพิ่มเวรรายบุคคล” หรือ “เพิ่มเวรหลายคนพร้อมกัน” ด้านบนเพื่อจัดตารางเวรใหม่"
                        />
                      ) : (
                        pagedAssignments.map((a) => {
                          const isCross = Number(a.snapshot_is_cross_midnight) === 1;
                          return (
                            <tr key={a.id} className="hover:bg-slate-50/80 transition-colors">
                              <td className="py-3.5 px-4 font-mono tabular-nums font-semibold text-slate-800 whitespace-nowrap">
                                {formatThaiDate(a.work_date)}
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="font-bold text-slate-900">{a.full_name}</div>
                                <div className="text-[12px] text-slate-500 mt-0.5">
                                  <span className="font-mono">{a.person_id}</span> ·{' '}
                                  {a.department_name}
                                </div>
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="font-semibold text-slate-900">
                                  {formatCleanShiftName(a.snapshot_shift_name)}
                                </div>
                                <div className="text-[12px] font-mono text-violet-700 mt-0.5">
                                  รหัสกะ: {a.snapshot_shift_code}
                                  {isCross ? ' · เวรข้ามวัน (+1 วัน)' : ''}
                                </div>
                              </td>
                              <td className="py-3.5 px-4 font-mono tabular-nums text-slate-800 whitespace-nowrap">
                                {a.snapshot_start_time}–{a.snapshot_end_time} น.
                              </td>
                              <td className="py-3.5 px-4 font-mono tabular-nums text-[12.5px] text-slate-600 whitespace-nowrap">
                                ผ่อนผัน {a.snapshot_grace_minutes} นาที · ตัดรอบ{' '}
                                {a.snapshot_cutoff_time} น.
                              </td>
                              <td className="py-3.5 px-4 whitespace-nowrap">
                                <span
                                  className={`font-semibold text-[13px] ${
                                    a.status === 'ACTIVE' ? 'text-emerald-700' : 'text-red-700'
                                  }`}
                                >
                                  {a.status === 'ACTIVE' ? 'ใช้งานปกติ' : 'ยกเลิกแล้ว'}
                                </span>
                              </td>
                              <td className="py-3.5 px-4 text-right whitespace-nowrap">
                                <div className="inline-flex items-center justify-end gap-2">
                                  <button
                                    type="button"
                                    onClick={() => setInspectTarget(a)}
                                    className="h-9 px-3 text-[12.5px] text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 inline-flex items-center gap-1 font-medium transition-colors"
                                  >
                                    <Eye className="w-3.5 h-3.5" />
                                    <span>ดูข้อมูล</span>
                                  </button>
                                  {a.status === 'ACTIVE' && (
                                    <button
                                      type="button"
                                      onClick={() => setCancelTarget(a)}
                                      className="h-9 px-3 text-[12.5px] text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 inline-flex items-center gap-1 font-semibold transition-colors"
                                    >
                                      <Trash2 className="w-3.5 h-3.5" />
                                      <span>ยกเลิกเวร</span>
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                <TablePaginationBar
                  currentPage={page}
                  pageSize={pageSize}
                  totalItems={sortedAssignments.length}
                  onPageChange={setPage}
                  onPageSizeChange={setPageSize}
                />
              </div>

              {/* ตารางประวัติการยกเลิกตารางเวรย้อนหลัง (Audit History) */}
              {cancellationLogs.length > 0 && (
                <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-6 py-3.5 border-b border-slate-200 bg-slate-50">
                    <h2 className="text-[16px] font-bold text-slate-800">
                      ประวัติการยกเลิกตารางเวรย้อนหลัง ({cancellationLogs.length} รายการล่าสุด)
                    </h2>
                    <p className="text-[12.5px] text-slate-600">
                      ระบบรักษาประวัติการยกเลิกเวรทุกครั้ง (Soft Cancel Audit Trail) เพื่อความโปร่งใสในการตรวจสอบ
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-[13.5px]">
                      <thead>
                        <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                          <th className="py-3 px-4 font-semibold">วันและเวลาที่ยกเลิก</th>
                          <th className="py-3 px-4 font-semibold">บุคลากร</th>
                          <th className="py-3 px-4 font-semibold">วันที่เวร / รหัสกะ</th>
                          <th className="py-3 px-4 font-semibold">เหตุผลการยกเลิก</th>
                          <th className="py-3 px-4 font-semibold">ผู้ดำเนินการ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {cancellationLogs.map((c) => (
                          <tr key={c.id} className="hover:bg-slate-50/70">
                            <td className="py-3 px-4 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                              {formatThaiDateTime(c.cancelled_at)}
                            </td>
                            <td className="py-3 px-4 font-semibold text-slate-800">
                              {c.full_name} ({c.person_id})
                            </td>
                            <td className="py-3 px-4 font-mono tabular-nums text-slate-700 whitespace-nowrap">
                              {formatThaiDate(c.work_date)} · {c.shift_code}
                            </td>
                            <td className="py-3 px-4 text-slate-700">{c.cancel_reason}</td>
                            <td className="py-3 px-4 font-mono text-slate-600">{c.cancelled_by}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          หน้าจอที่ 2: จัดเวร / เพิ่มเวรใหม่ (FULL-PAGE WIZARD & FORM WORKSPACE)
          แยกเป็น 2 วิธีชัดเจน: 1. เพิ่มเวรให้บุคลากรหนึ่งคน | 2. เพิ่มเวรหลายคนพร้อมกัน
         ===================================================================== */}
      {activeTab === 'ASSIGN_WORKSPACE' && (
        <div className="space-y-5">
          {/* เลือกวิธีการเพิ่มเวร (2 วิธีชัดเจน) */}
          <div className="bg-white border border-violet-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-[17px] font-bold text-slate-900">
                  เลือกรูปแบบการจัดตารางเวร
                </h2>
                <p className="text-[13px] text-slate-600">
                  เลือกว่าต้องการเพิ่มเวรให้บุคลากรรายบุคคล (1 คน) หรือจัดเวรให้บุคลากรหลายคนพร้อมกันตามกลุ่มงาน/แผนก
                </p>
              </div>
              <span className="text-[13px] font-semibold text-violet-900 bg-violet-50 border border-violet-200 px-3 py-1.5 rounded-lg self-start sm:self-auto">
                เดือนที่กำลังจัดเวร: {formatThaiMonthTitle(selectedMonth)}
              </span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <button
                type="button"
                onClick={() => handleSwitchAssignMethod('SINGLE_PERSON')}
                className={`p-4 rounded-xl border text-left transition-colors flex items-start gap-3.5 ${
                  assignMethod === 'SINGLE_PERSON'
                    ? 'bg-violet-50/90 border-violet-600 text-violet-950'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-violet-300'
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                    assignMethod === 'SINGLE_PERSON'
                      ? 'bg-violet-700 text-white'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  <User className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <div className="font-bold text-[15px]">
                    วิธีที่ 1: เพิ่มเวรให้บุคลากรหนึ่งคน
                  </div>
                  <p className="text-[13px] text-slate-600 leading-relaxed">
                    เหมาะสำหรับลงเวรรายบุคคล แก้ไขตารางเวรเฉพาะคน หรือคลิกเพิ่มเวรจากช่องตารางโดยตรง
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleSwitchAssignMethod('MULTI_PERSON')}
                className={`p-4 rounded-xl border text-left transition-colors flex items-start gap-3.5 ${
                  assignMethod === 'MULTI_PERSON'
                    ? 'bg-violet-50/90 border-violet-600 text-violet-950'
                    : 'bg-white border-slate-200 text-slate-700 hover:border-violet-300'
                }`}
              >
                <div
                  className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${
                    assignMethod === 'MULTI_PERSON'
                      ? 'bg-violet-700 text-white'
                      : 'bg-slate-100 text-slate-600'
                  }`}
                >
                  <Users className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <div className="font-bold text-[15px]">
                    วิธีที่ 2: เพิ่มเวรหลายคนพร้อมกัน (รายกลุ่มงาน / แผนก)
                  </div>
                  <p className="text-[13px] text-slate-600 leading-relaxed">
                    เหมาะสำหรับจัดตารางเวรประจำเดือนให้ทั้งกลุ่มงาน เลือกเฉพาะวันจันทร์–ศุกร์ หรือหลายวันพร้อมกัน
                  </p>
                </div>
              </button>
            </div>
          </div>

          {/* เนื้อหา 3 ขั้นตอนหลัก: 1. เลือกบุคลากร | 2. เลือกวันที่ | 3. เลือกแม่แบบกะทำงาน */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* ===============================================================
                ขั้นตอนที่ 1: เลือกบุคลากร (5 คอลัมน์บน Desktop)
               =============================================================== */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-5 space-y-4 flex flex-col justify-between">
              <div className="space-y-3.5">
                <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-[15.5px] font-bold text-slate-900">
                      ขั้นตอนที่ 1: {assignMethod === 'SINGLE_PERSON' ? 'เลือกบุคลากร (1 คน)' : 'เลือกกลุ่มงานและบุคลากรหลายคน'}{' '}
                      <RequiredMark />
                    </h3>
                    <p className="text-[12.5px] text-slate-500 mt-0.5">
                      {assignMethod === 'SINGLE_PERSON'
                        ? 'ค้นหาชื่อหรือรหัสเพื่อเลือกบุคลากร 1 คนที่ต้องการเพิ่มเวร'
                        : 'กรองตามกลุ่มงานแล้วเลือกบุคลากรหลายคน หรือกดเลือกทั้งหมดเฉพาะผลลัพธ์ที่กรอง'}
                    </p>
                  </div>
                  <span className="font-mono text-[13px] font-bold text-violet-900 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-md shrink-0 tabular-nums">
                    เลือกแล้ว {selectedPersonIds.length} คน
                  </span>
                </div>

                {/* ตัวกรองกลุ่มงานและช่องค้นหาชื่อ/รหัสทันที */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[12px] font-semibold text-slate-700 mb-1">
                      กลุ่มงาน / แผนก
                    </label>
                    <select
                      aria-label="กรองกลุ่มงานในการเลือกบุคลากร"
                      value={assignPersonDeptFilter}
                      onChange={(e) => {
                        setAssignPersonDeptFilter(e.target.value);
                        setAssignPersonnelRenderLimit(80);
                      }}
                      className="w-full h-9.5 px-3 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-800 focus:outline-none focus:border-violet-600"
                    >
                      <option value="ALL">ทุกกลุ่มงาน/แผนก ({personnel.length} คน)</option>
                      {departments.map((dept) => (
                        <option key={dept} value={dept}>
                          {dept}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] font-semibold text-slate-700 mb-1">
                      ค้นหาชื่อ หรือ รหัสบุคลากร
                    </label>
                    <div className="relative">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                      <input
                        type="text"
                        value={assignPersonSearch}
                        onChange={(e) => {
                          setAssignPersonSearch(e.target.value);
                          setAssignPersonnelRenderLimit(80);
                        }}
                        placeholder="พิมพ์ชื่อ, รหัส, สแกนนิ้ว..."
                        className="w-full h-9.5 pl-8 pr-2.5 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-800 focus:outline-none focus:border-violet-600"
                      />
                    </div>
                  </div>
                </div>

                {/* ปุ่มเลือกทั้งหมดเฉพาะผลลัพธ์ที่กรอง & ยกเลิกการเลือกทั้งหมด */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                  <span className="text-[12.5px] text-slate-600">
                    พบผลลัพธ์ที่กรอง{' '}
                    <strong className="text-slate-900 font-mono tabular-nums">
                      {assignFilteredPersonnel.length}
                    </strong>{' '}
                    คน
                  </span>

                  <div className="inline-flex items-center gap-2">
                    {assignMethod === 'MULTI_PERSON' && (
                      <button
                        type="button"
                        disabled={assignFilteredPersonnel.length === 0}
                        onClick={selectAllFilteredPersons}
                        className="h-8 px-2.5 rounded-md border border-violet-300 bg-violet-50 hover:bg-violet-100 disabled:opacity-40 text-violet-900 text-[12px] font-semibold transition-colors"
                      >
                        เลือกทั้งหมดเฉพาะที่กรอง ({assignFilteredPersonnel.length} คน)
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={selectedPersonIds.length === 0}
                      onClick={clearSelectedPersons}
                      className="h-8 px-2.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700 text-[12px] font-medium transition-colors"
                    >
                      ยกเลิกการเลือกทั้งหมด
                    </button>
                  </div>
                </div>

                {/* รายการบุคลากร (รองรับหลายร้อยคนโดยไม่กระตุก) */}
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-200 max-h-72 overflow-y-auto bg-slate-50/40">
                  {visibleAssignPersonnel.length === 0 ? (
                    <div className="py-10 px-4 text-center text-[13px] text-slate-500">
                      ไม่พบบุคลากรตามคำค้นหาหรือกลุ่มงานที่เลือก
                    </div>
                  ) : (
                    visibleAssignPersonnel.map((p) => {
                      const pid = String(p.person_id).trim();
                      const checked = selectedPersonIds.includes(pid);
                      return (
                        <label
                          key={pid}
                          onClick={() => handleSelectPerson(pid)}
                          className={`flex items-start gap-3 px-3.5 py-2.5 cursor-pointer text-[13px] transition-colors ${
                            checked ? 'bg-violet-50/90' : 'hover:bg-white'
                          }`}
                        >
                          <input
                            type={assignMethod === 'SINGLE_PERSON' ? 'radio' : 'checkbox'}
                            name="assign-person-selector"
                            checked={checked}
                            onChange={() => {}}
                            className="mt-1 rounded border-slate-300 text-violet-700 focus:ring-violet-600"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="font-bold text-slate-900 truncate">{p.full_name}</div>
                            <div className="text-[12px] text-slate-500 truncate">
                              รหัส <span className="font-mono">{pid}</span> · {p.department_name}
                              {p.position_name && p.position_name !== '-'
                                ? ` · ${p.position_name}`
                                : ''}
                            </div>
                          </div>
                        </label>
                      );
                    })
                  )}

                  {assignFilteredPersonnel.length > visibleAssignPersonnel.length && (
                    <div className="p-2.5 text-center bg-white">
                      <button
                        type="button"
                        onClick={() => setAssignPersonnelRenderLimit((lim) => lim + 100)}
                        className="text-[12.5px] font-semibold text-violet-800 hover:underline"
                      >
                        แสดงรายชื่อเพิ่มเติมอีก (เหลืออีก{' '}
                        {assignFilteredPersonnel.length - visibleAssignPersonnel.length} คน)
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* ส่วนสรุปรายชื่อบุคลากรที่เลือกไว้ */}
              <div className="pt-3 border-t border-slate-200 space-y-2">
                <div className="flex items-center justify-between text-[12.5px]">
                  <span className="font-semibold text-slate-700">
                    รายชื่อบุคลากรที่เลือก ({selectedPersonnelObjects.length} คน):
                  </span>
                </div>

                {selectedPersonnelObjects.length === 0 ? (
                  <div className="p-2.5 rounded-lg bg-slate-50 border border-dashed border-slate-300 text-[12.5px] text-slate-500 text-center">
                    ยังไม่ได้เลือกบุคลากร กรุณาคลิกเลือกรายชื่อด้านบน
                  </div>
                ) : (
                  <div className="max-h-28 overflow-y-auto p-2 rounded-lg bg-violet-50/50 border border-violet-200/80 flex flex-wrap gap-1.5">
                    {selectedPersonnelObjects.slice(0, 30).map((p) => {
                      const pid = String(p.person_id).trim();
                      return (
                        <span
                          key={pid}
                          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border border-violet-200 text-[12px] text-slate-800"
                        >
                          <span className="font-semibold truncate max-w-[160px]">
                            {p.full_name}
                          </span>
                          <span className="font-mono text-slate-400">({pid})</span>
                          <button
                            type="button"
                            onClick={() =>
                              setSelectedPersonIds((prev) => prev.filter((id) => id !== pid))
                            }
                            className="text-slate-400 hover:text-red-600"
                            title="นำรายชื่อนี้ออก"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </span>
                      );
                    })}
                    {selectedPersonnelObjects.length > 30 && (
                      <span className="text-[12px] font-semibold text-violet-800 px-2 py-1">
                        และอีก {selectedPersonnelObjects.length - 30} คน
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ===============================================================
                ขั้นตอนที่ 2 และ 3: เลือกวันที่ และ เลือกแม่แบบกะทำงาน (7 คอลัมน์บน Desktop)
               =============================================================== */}
            <div className="lg:col-span-7 space-y-5">
              {/* ขั้นตอนที่ 2: เลือกวันที่ปฏิบัติงาน */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-[15.5px] font-bold text-slate-900">
                      ขั้นตอนที่ 2: เลือกวันที่ปฏิบัติงาน <RequiredMark />
                    </h3>
                    <p className="text-[12.5px] text-slate-500 mt-0.5">
                      เลือกวันเดียว เลือกหลายวันจากปฏิทิน หรือเลือกช่วงวันที่พร้อมกรองเฉพาะวันจันทร์–ศุกร์ได้
                    </p>
                  </div>
                  <span className="font-mono text-[13px] font-bold text-violet-900 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded-md shrink-0 tabular-nums">
                    เลือกแล้ว {effectiveSelectedDates.length} วัน
                  </span>
                </div>

                {/* แถบสลับรูปแบบการเลือกวันที่ */}
                <div className="inline-flex flex-wrap items-center p-1 bg-slate-100 border border-slate-200 rounded-lg gap-1">
                  <button
                    type="button"
                    onClick={() => setDatePickStrategy('SINGLE_DAY')}
                    className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
                      datePickStrategy === 'SINGLE_DAY'
                        ? 'bg-white text-violet-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    เลือกวันเดียว
                  </button>
                  <button
                    type="button"
                    onClick={() => setDatePickStrategy('MULTI_PICK')}
                    className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
                      datePickStrategy === 'MULTI_PICK'
                        ? 'bg-white text-violet-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    เลือกหลายวันจากปฏิทิน
                  </button>
                  <button
                    type="button"
                    onClick={() => setDatePickStrategy('DATE_RANGE')}
                    className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
                      datePickStrategy === 'DATE_RANGE'
                        ? 'bg-white text-violet-900 shadow-2xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    เลือกช่วงวันที่ (จันทร์–ศุกร์ / ทุกวัน)
                  </button>
                </div>

                {/* รูปแบบที่ 2.1: เลือกวันเดียว */}
                {datePickStrategy === 'SINGLE_DAY' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                    <div>
                      <label className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                        ระบุวันที่ต้องการจัดเวร
                      </label>
                      <input
                        type="date"
                        value={singleWorkDate}
                        onChange={(e) => setSingleWorkDate(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                      />
                    </div>
                    <div className="p-2.5 rounded-lg bg-violet-50/70 border border-violet-200 text-[13px] text-violet-950">
                      วันที่เลือก:{' '}
                      <strong className="font-semibold">
                        {singleWorkDate ? formatThaiDate(singleWorkDate) : '-'}
                      </strong>
                    </div>
                  </div>
                )}

                {/* รูปแบบที่ 2.2: เลือกหลายวันจากปฏิทินของเดือน */}
                {datePickStrategy === 'MULTI_PICK' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[13px] font-semibold text-slate-800">
                        ปฏิทินเดือน {formatThaiMonthTitle(selectedMonth)}
                      </span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => quickPickMonthDates('WEEKDAYS_MONTH')}
                          className="h-7 px-2.5 rounded border border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-900 text-[12px] font-semibold"
                        >
                          เฉพาะจันทร์–ศุกร์ทั้งเดือน
                        </button>
                        <button
                          type="button"
                          onClick={() => quickPickMonthDates('ALL_MONTH')}
                          className="h-7 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-medium"
                        >
                          ทุกวันทั้งเดือน
                        </button>
                        <button
                          type="button"
                          onClick={() => quickPickMonthDates('FIRST_HALF')}
                          className="h-7 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-medium"
                        >
                          วันที่ 1–15
                        </button>
                        <button
                          type="button"
                          onClick={() => quickPickMonthDates('SECOND_HALF')}
                          className="h-7 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-medium"
                        >
                          วันที่ 16–{monthBounds.daysInMonth}
                        </button>
                        <button
                          type="button"
                          onClick={() => quickPickMonthDates('CLEAR')}
                          className="h-7 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-red-700 text-[12px] font-medium"
                        >
                          ล้างวันที่
                        </button>
                      </div>
                    </div>

                    <div className="grid grid-cols-7 gap-1.5 p-3 bg-slate-50 border border-slate-200 rounded-xl">
                      {monthBounds.allDates.map((d) => {
                        const active = multiPickedDates.includes(d.dateStr);
                        return (
                          <button
                            key={d.dateStr}
                            type="button"
                            onClick={() => toggleMultiPickedDate(d.dateStr)}
                            className={`h-11 rounded-lg font-mono text-[12.5px] flex flex-col items-center justify-center border transition-colors ${
                              active
                                ? 'bg-violet-700 border-violet-700 text-white font-bold'
                                : d.isWeekend
                                  ? 'bg-amber-50/70 border-amber-200 text-amber-950 hover:border-violet-400'
                                  : 'bg-white border-slate-200 text-slate-800 hover:border-violet-400'
                            }`}
                          >
                            <span
                              className={`text-[10px] leading-none ${
                                active
                                  ? 'text-violet-100'
                                  : d.isWeekend
                                    ? 'text-amber-700 font-semibold'
                                    : 'text-slate-500'
                              }`}
                            >
                              {d.weekdayShort}
                            </span>
                            <span className="leading-tight mt-0.5">{d.dayNum}</span>
                          </button>
                        );
                      })}
                    </div>

                    <div className="text-[12px] text-slate-500 flex items-center gap-3">
                      <span className="inline-flex items-center gap-1.5">
                        <span className="w-2.5 h-2.5 rounded-xs bg-amber-50 border border-amber-200 inline-block" />
                        <span>ช่องสีครีมคือวันหยุดสุดสัปดาห์ (เสาร์–อาทิตย์)</span>
                      </span>
                    </div>
                  </div>
                )}

                {/* รูปแบบที่ 2.3: เลือกช่วงวันที่ */}
                {datePickStrategy === 'DATE_RANGE' && (
                  <div className="space-y-3.5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                          ตั้งแต่วันที่
                        </label>
                        <input
                          type="date"
                          value={rangeStartDate}
                          onChange={(e) => setRangeStartDate(e.target.value)}
                          className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-[13px] text-slate-800"
                        />
                      </div>

                      <div>
                        <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                          ถึงวันที่
                        </label>
                        <input
                          type="date"
                          value={rangeEndDate}
                          onChange={(e) => setRangeEndDate(e.target.value)}
                          className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-[13px] text-slate-800"
                        />
                      </div>

                      <div>
                        <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                          เงื่อนไขวันในสัปดาห์
                        </label>
                        <select
                          value={weekdayFilter}
                          onChange={(e) => setWeekdayFilter(e.target.value as WeekdayFilterMode)}
                          className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-800"
                        >
                          <option value="ALL_DAYS">เลือกทุกวันในช่วง</option>
                          <option value="WEEKDAYS_ONLY">เฉพาะวันจันทร์ – ศุกร์</option>
                          <option value="WEEKENDS_ONLY">เฉพาะวันเสาร์ – อาทิตย์</option>
                        </select>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[12px] text-slate-500">ตั้งช่วงวันที่ด่วน:</span>
                      <button
                        type="button"
                        onClick={() => {
                          setRangeStartDate(monthBounds.dateFrom);
                          setRangeEndDate(monthBounds.dateTo);
                          setWeekdayFilter('WEEKDAYS_ONLY');
                        }}
                        className="h-7 px-2.5 rounded border border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-900 text-[12px] font-semibold"
                      >
                        จันทร์–ศุกร์ ตลอดเดือน{THAI_FULL_MONTHS[monthBounds.month - 1]}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setRangeStartDate(monthBounds.dateFrom);
                          setRangeEndDate(monthBounds.dateTo);
                          setWeekdayFilter('ALL_DAYS');
                        }}
                        className="h-7 px-2.5 rounded border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-medium"
                      >
                        ทุกวัน ตลอดเดือน{THAI_FULL_MONTHS[monthBounds.month - 1]}
                      </button>
                    </div>
                  </div>
                )}

                {/* แจ้งเตือนหากผู้ใช้เผลอเลือกวันที่ผิดเดือน */}
                {outOfMonthDatesWarning && (
                  <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-950 text-[12.5px] flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <span>{outOfMonthDatesWarning}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSingleWorkDate(monthBounds.dateFrom);
                        setRangeStartDate(monthBounds.dateFrom);
                        setRangeEndDate(monthBounds.dateTo);
                        setMultiPickedDates([monthBounds.dateFrom]);
                      }}
                      className="h-7 px-2.5 rounded bg-white border border-amber-300 text-amber-900 font-semibold text-[12px] shrink-0"
                    >
                      ตั้งเป็นเดือน{THAI_FULL_MONTHS[monthBounds.month - 1]}
                    </button>
                  </div>
                )}
              </div>

              {/* ขั้นตอนที่ 3: เลือกแม่แบบกะทำงาน (แสดงชื่อกะและเวลาครั้งเดียว ไม่ซ้ำซ้อน) */}
              <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-200 pb-3">
                  <div>
                    <h3 className="text-[15.5px] font-bold text-slate-900">
                      ขั้นตอนที่ 3: เลือกแม่แบบกะทำงาน <RequiredMark />
                    </h3>
                    <p className="text-[12.5px] text-slate-500 mt-0.5">
                      คลิกเลือกแม่แบบกะที่ต้องการ ระบบจะบันทึกค่าเวลาตาม Snapshot ณ วันที่มอบหมาย
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {shifts.map((s) => {
                    const isSelected = Number(s.id) === Number(assignShiftId);
                    const isCross = Number(s.is_cross_midnight) === 1;
                    const cleanName = formatCleanShiftName(s.shift_name);
                    return (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setAssignShiftId(Number(s.id))}
                        className={`p-3.5 rounded-xl border text-left transition-colors flex flex-col justify-between gap-2 ${
                          isSelected
                            ? 'bg-violet-50/90 border-violet-600'
                            : 'bg-white border-slate-200 hover:border-violet-300'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div>
                            <div className="font-bold text-[15px] text-slate-900">{cleanName}</div>
                            <div className="font-mono font-bold text-[14px] text-violet-800 tabular-nums mt-0.5">
                              {s.start_time}–{s.end_time} น.
                            </div>
                          </div>
                          <div
                            className={`w-5 h-5 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                              isSelected
                                ? 'bg-violet-700 border-violet-700 text-white'
                                : 'border-slate-300 bg-white'
                            }`}
                          >
                            {isSelected && <Check className="w-3.5 h-3.5" />}
                          </div>
                        </div>

                        <div className="pt-2 border-t border-slate-200/80 text-[12px] text-slate-600 flex flex-wrap items-center justify-between gap-1">
                          <span>
                            ผ่อนผันสาย {s.grace_minutes} นาที · ตัดรอบ {s.cutoff_time} น.
                          </span>
                          <span className="font-mono text-[11.5px] text-slate-500">
                            รหัส: {s.shift_code}
                            {isCross ? ' (ข้ามวัน)' : ''}
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {/* นโยบายเมื่อพบรายการที่มีเวรอยู่แล้วหรือเวลาทับซ้อน */}
                <div className="pt-3 border-t border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <label className="text-[13px] font-semibold text-slate-700">
                    การจัดการเมื่อพบรายการที่มีเวรอยู่แล้วหรือเวลาทับซ้อน:
                  </label>
                  <select
                    value={conflictStrategy}
                    onChange={(e) => setConflictStrategy(e.target.value as ConflictStrategyMode)}
                    className="h-9.5 px-3 rounded-lg border border-slate-300 bg-slate-50 text-[13px] text-slate-800 sm:max-w-md w-full"
                  >
                    <option value="SKIP_CONFLICTS">
                      ข้ามเฉพาะรายการที่มีเวรอยู่แล้ว/เวลาทับซ้อน และบันทึกเฉพาะรายการที่ว่าง (แนะนำ)
                    </option>
                    <option value="ABORT_ON_CONFLICT">
                      ยกเลิกการบันทึกทั้งหมดหากพบรายการขัดแย้งแม้แต่รายการเดียว
                    </option>
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* =================================================================
              ขั้นตอนที่ 4: ตรวจสอบความขัดแย้งก่อนบันทึก (Conflict Preview & Confirm)
             ================================================================= */}
          <div className="bg-white border border-violet-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div>
                <h3 className="text-[16px] font-bold text-slate-900">
                  ขั้นตอนที่ 4: ตรวจสอบความซ้ำซ้อนและยืนยันบันทึกตารางเวร
                </h3>
                <p className="text-[13px] text-slate-600">
                  กดปุ่ม “1. ตรวจสอบความซ้ำซ้อน” เพื่อดูรายการเวรที่จะเพิ่ม รายการที่มีอยู่แล้ว และรายการที่เวลาทับซ้อนก่อนบันทึกจริง
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleRunConflictPreview}
                  disabled={previewLoading || submittingBulk}
                  className="h-10 px-4 rounded-lg border border-violet-300 bg-violet-50 hover:bg-violet-100 disabled:opacity-50 text-violet-950 text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                >
                  <FileCheck2 className="w-4 h-4 text-violet-700" />
                  <span>
                    {previewLoading
                      ? 'กำลังตรวจสอบความซ้ำซ้อน...'
                      : '1. ตรวจสอบความซ้ำซ้อนก่อนบันทึก'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleConfirmBulkAssign}
                  disabled={
                    submittingBulk ||
                    previewLoading ||
                    Boolean(previewError) ||
                    !previewData ||
                    previewData.summary.readyCount === 0 ||
                    (conflictStrategy === 'ABORT_ON_CONFLICT' &&
                      previewData.summary.conflictCount > 0)
                  }
                  className="h-10 px-5 rounded-lg bg-violet-700 hover:bg-violet-800 disabled:opacity-40 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {submittingBulk
                      ? 'กำลังบันทึกตารางเวร...'
                      : previewData
                        ? `2. ยืนยันบันทึกเวร (${previewData.summary.readyCount} รายการที่บันทึกได้)`
                        : '2. ยืนยันบันทึกเวร'}
                  </span>
                </button>
              </div>
            </div>

            {/* แสดงข้อผิดพลาดจากการตรวจสอบความซ้ำซ้อน พร้อม Request ID */}
            {previewError && (
              <div
                role="alert"
                className="p-4 rounded-xl bg-red-50 border border-red-300 text-red-950 text-[13.5px] flex items-start gap-3"
              >
                <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <div className="font-bold text-red-900 flex flex-wrap items-center gap-2">
                    <span>ไม่สามารถดำเนินการบันทึกตารางเวรได้</span>
                    {previewError.code && (
                      <span className="font-mono text-[12px] bg-red-100 text-red-900 px-2 py-0.5 rounded">
                        รหัส: {previewError.code}
                      </span>
                    )}
                    {previewError.requestId && (
                      <span className="font-mono text-[12px] bg-red-100 text-red-900 px-2 py-0.5 rounded">
                        Request ID: {previewError.requestId}
                      </span>
                    )}
                  </div>
                  <p className="text-red-900">{previewError.message}</p>
                </div>
              </div>
            )}

            {/* ตารางสรุปผลการตรวจสอบความขัดแย้ง (ภาษาไทยเข้าใจง่าย) */}
            {previewData ? (
              <div className="space-y-4 pt-2">
                {/* การ์ดสรุปตัวเลข 5 รายการตามข้อกำหนดข้อ 6 */}
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200">
                    <div className="text-[12px] text-slate-600">รายการเวรที่จะเพิ่มทั้งหมด</div>
                    <div className="text-[20px] font-bold font-mono tabular-nums text-slate-900 mt-0.5">
                      {previewData.summary.totalRequested} รายการ
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-emerald-50/70 border border-emerald-200">
                    <div className="text-[12px] text-emerald-800 font-semibold">
                      รายการที่บันทึกได้
                    </div>
                    <div className="text-[20px] font-bold font-mono tabular-nums text-emerald-800 mt-0.5">
                      {previewData.summary.readyCount} รายการ
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200">
                    <div className="text-[12px] text-amber-900 font-semibold">
                      รายการที่มีอยู่แล้ว (กะซ้ำ)
                    </div>
                    <div className="text-[20px] font-bold font-mono tabular-nums text-amber-900 mt-0.5">
                      {previewData.summary.duplicateCount} รายการ
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-amber-50/70 border border-amber-200">
                    <div className="text-[12px] text-amber-900 font-semibold">
                      รายการเวลาทับซ้อน
                    </div>
                    <div className="text-[20px] font-bold font-mono tabular-nums text-amber-900 mt-0.5">
                      {previewData.summary.overlapCount} รายการ
                    </div>
                  </div>

                  <div className="p-3.5 rounded-xl bg-slate-100 border border-slate-300">
                    <div className="text-[12px] text-slate-700 font-semibold">
                      รายการที่ไม่สามารถบันทึกได้
                    </div>
                    <div className="text-[20px] font-bold font-mono tabular-nums text-slate-800 mt-0.5">
                      {previewData.summary.conflictCount} รายการ
                    </div>
                  </div>
                </div>

                {/* แถบกรองดูรายการในตารางผลลัพธ์ Preview */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg self-start">
                    <button
                      type="button"
                      onClick={() => setPreviewFilterTab('ALL')}
                      className={`px-3 py-1 rounded-md text-[12.5px] font-semibold ${
                        previewFilterTab === 'ALL'
                          ? 'bg-white text-violet-900 shadow-2xs'
                          : 'text-slate-600'
                      }`}
                    >
                      ทั้งหมด ({previewData.items.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewFilterTab('READY')}
                      className={`px-3 py-1 rounded-md text-[12.5px] font-semibold ${
                        previewFilterTab === 'READY'
                          ? 'bg-white text-emerald-800 shadow-2xs'
                          : 'text-slate-600'
                      }`}
                    >
                      รายการที่บันทึกได้ ({previewData.summary.readyCount})
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewFilterTab('CONFLICT')}
                      className={`px-3 py-1 rounded-md text-[12.5px] font-semibold ${
                        previewFilterTab === 'CONFLICT'
                          ? 'bg-white text-amber-900 shadow-2xs'
                          : 'text-slate-600'
                      }`}
                    >
                      รายการที่จะถูกข้าม / ขัดแย้ง ({previewData.summary.conflictCount})
                    </button>
                  </div>

                  <div className="text-[12.5px] text-slate-600">
                    แม่แบบกะที่เลือก:{' '}
                    <strong className="text-violet-900">
                      {formatCleanShiftName(previewData.shiftSnapshot.shiftName)} (
                      {previewData.shiftSnapshot.startTime}–{previewData.shiftSnapshot.endTime} น.)
                    </strong>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="max-h-72 overflow-y-auto">
                    <table className="w-full text-left border-collapse text-[13px]">
                      <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 text-slate-700">
                        <tr>
                          <th className="py-2.5 px-3.5 font-semibold">วันที่ปฏิบัติงาน</th>
                          <th className="py-2.5 px-3.5 font-semibold">บุคลากร · กลุ่มงาน</th>
                          <th className="py-2.5 px-3.5 font-semibold">กะที่จะเพิ่ม</th>
                          <th className="py-2.5 px-3.5 font-semibold">สถานะและเหตุผล</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200">
                        {filteredPreviewItems.map((item, idx) => (
                          <tr
                            key={`${item.personId}-${item.workDate}-${idx}`}
                            className={item.status === 'READY' ? 'bg-white' : 'bg-amber-50/40'}
                          >
                            <td className="py-2.5 px-3.5 font-mono tabular-nums font-semibold text-slate-800 whitespace-nowrap">
                              {formatThaiDate(item.workDate)}
                            </td>
                            <td className="py-2.5 px-3.5">
                              <span className="font-bold text-slate-900">{item.fullName}</span>{' '}
                              <span className="text-[12px] font-mono text-slate-500">
                                ({item.personId}) · {item.departmentName}
                              </span>
                            </td>
                            <td className="py-2.5 px-3.5 text-slate-800 whitespace-nowrap">
                              <span className="font-semibold">
                                {formatCleanShiftName(previewData.shiftSnapshot.shiftName)}
                              </span>{' '}
                              <span className="font-mono text-[12px] text-slate-600">
                                ({previewData.shiftSnapshot.startTime}–
                                {previewData.shiftSnapshot.endTime} น.)
                              </span>
                            </td>
                            <td className="py-2.5 px-3.5">
                              {item.status === 'READY' ? (
                                <span className="text-emerald-700 font-semibold">
                                  บันทึกได้ (ไม่มีเวรซ้ำหรือเวลาทับซ้อน)
                                </span>
                              ) : (
                                <div className="text-amber-900 font-semibold">
                                  <span>
                                    {item.status === 'DUPLICATE_SAME_SHIFT'
                                      ? 'มีเวรนี้อยู่แล้ว: '
                                      : 'เวลาทับซ้อน: '}
                                    {item.conflictMessage}
                                  </span>{' '}
                                  <span className="text-slate-600 font-normal">
                                    {conflictStrategy === 'SKIP_CONFLICTS'
                                      ? '(ระบบจะข้ามรายการนี้โดยไม่ลบหรือทับเวรเดิม)'
                                      : '(ไม่สามารถบันทึกได้ ต้องเอาวันนี้ออกก่อน)'}
                                  </span>
                                </div>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-4 rounded-xl bg-violet-50/40 border border-dashed border-violet-200 text-center text-[13.5px] text-slate-600">
                เลือกบุคลากร ({selectedPersonIds.length} คน) · วันที่ (
                {effectiveSelectedDates.length} วัน) · แม่แบบกะทำงาน แล้วกดปุ่ม{' '}
                <strong className="text-violet-900">“1. ตรวจสอบความซ้ำซ้อนก่อนบันทึก”</strong>{' '}
                เพื่อดูสรุปรายการที่จะเพิ่มก่อนยืนยันบันทึก
              </div>
            )}
          </div>
        </div>
      )}

      {/* =====================================================================
          หน้าจอที่ 3: แม่แบบกะทำงาน (SHIFT TEMPLATES MANAGEMENT)
          แสดงชื่อกะและเวลาเพียงครั้งเดียว ไม่แสดงรหัสและข้อความเวลาซ้ำซ้อน
         ===================================================================== */}
      {activeTab === 'TEMPLATES' && (
        <div className="space-y-5">
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative w-full sm:max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="ค้นหาชื่อแม่แบบกะทำงาน หรือรหัสกะ..."
                className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-violet-600"
              />
            </div>

            <div className="flex items-center gap-2.5">
              <span className="text-[13px] text-slate-500">
                แสดง {filteredShifts.length} จาก {shifts.length} แม่แบบกะ
              </span>
              <button
                type="button"
                onClick={() => setShowCreateTemplateForm((prev) => !prev)}
                className="h-10 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[13.5px] font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>{showCreateTemplateForm ? 'ซ่อนฟอร์มสร้างแม่แบบกะ' : 'เพิ่มแม่แบบกะใหม่'}</span>
              </button>
            </div>
          </div>

          {showCreateTemplateForm && (
            <form
              onSubmit={handleCreateShift}
              className="bg-white border border-violet-200 rounded-xl p-5 sm:p-6 space-y-5"
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 border-b border-slate-200 pb-3.5">
                <div>
                  <h2 className="text-[17px] font-bold text-slate-900">
                    เพิ่มแม่แบบกะทำงานใหม่
                  </h2>
                  <p className="text-[13px] text-slate-600 mt-0.5">
                    ระบุชื่อกะโดยไม่ต้องพิมพ์วงเล็บเวลาต่อท้าย ระบบจะแสดงเวลาเริ่ม–เลิกงานให้อัตโนมัติ
                  </p>
                </div>
                <span className="text-[12.5px] font-semibold text-violet-900 bg-violet-50 border border-violet-200 px-3 py-1 rounded-md self-start">
                  {endTime <= startTime
                    ? 'ประเภทเวลา: เวรข้ามเที่ยงคืน (+1 วัน)'
                    : 'ประเภทเวลา: เวรภายในวันเดียว'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="sm:col-span-2">
                  <label
                    htmlFor="shift-name"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    ชื่อแม่แบบกะทำงาน <RequiredMark />
                  </label>
                  <input
                    id="shift-name"
                    type="text"
                    required
                    value={shiftName}
                    onChange={(e) => setShiftName(e.target.value)}
                    placeholder="เช่น เวรปกติ, เวรเช้า, เวรบ่าย, เวรดึก"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="shift-code"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    รหัสกะ (ข้อมูลรอง) <RequiredMark />
                  </label>
                  <input
                    id="shift-code"
                    type="text"
                    required
                    value={shiftCode}
                    onChange={(e) => setShiftCode(e.target.value)}
                    placeholder="เช่น ER-2008"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="shift-category"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    หมวดหมู่กะ <RequiredMark />
                  </label>
                  <select
                    id="shift-category"
                    value={shiftCategory}
                    onChange={(e) => setShiftCategory(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  >
                    <option value="OFFICIAL">เวรราชการ</option>
                    <option value="MORNING">เวรเช้า</option>
                    <option value="AFTERNOON">เวรบ่าย</option>
                    <option value="NIGHT">เวรดึก</option>
                    <option value="CROSS_MIDNIGHT">เวรข้ามวัน</option>
                    <option value="SPECIAL">เวรพิเศษ</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="shift-start"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    เวลาเริ่มงาน (24 ชม.) <RequiredMark />
                  </label>
                  <input
                    id="shift-start"
                    type="time"
                    required
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono tabular-nums text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="shift-end"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    เวลาเลิกงาน (24 ชม.) <RequiredMark />
                  </label>
                  <input
                    id="shift-end"
                    type="time"
                    required
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono tabular-nums text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="shift-grace"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    เวลาผ่อนผันการมาสาย (นาที) <RequiredMark />
                  </label>
                  <input
                    id="shift-grace"
                    type="number"
                    min={0}
                    max={120}
                    required
                    value={graceMinutes}
                    onChange={(e) => setGraceMinutes(Number(e.target.value))}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono tabular-nums text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>

                <div>
                  <label
                    htmlFor="shift-cutoff"
                    className="block text-[13px] font-semibold text-slate-700 mb-1.5"
                  >
                    เวลาตัดรอบสแกน <RequiredMark />
                  </label>
                  <input
                    id="shift-cutoff"
                    type="time"
                    required
                    value={cutoffTime}
                    onChange={(e) => setCutoffTime(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 font-mono tabular-nums text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-end gap-2.5 pt-3 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowCreateTemplateForm(false)}
                  className="h-10 px-4 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[13.5px] font-medium"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  disabled={creatingTemplate}
                  className="h-10 px-5 rounded-lg bg-violet-700 hover:bg-violet-800 disabled:opacity-50 text-white text-[13.5px] font-semibold inline-flex items-center gap-2"
                >
                  <Plus className="w-4 h-4" />
                  <span>{creatingTemplate ? 'กำลังบันทึกแม่แบบกะ...' : 'บันทึกแม่แบบกะใหม่'}</span>
                </button>
              </div>
            </form>
          )}

          {/* รายการแม่แบบกะทำงานแบบอ่านง่าย ไม่แสดงเวลาซ้ำซ้อน */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredShifts.map((s) => {
              const isCross = Number(s.is_cross_midnight) === 1;
              const isActive = Number(s.is_active ?? 1) === 1;
              const cleanName = formatCleanShiftName(s.shift_name);
              const categoryText =
                SHIFT_CATEGORY_LABELS[String(s.shift_category || '').toUpperCase()] ||
                s.shift_category ||
                'เวรปฏิบัติงาน';
              return (
                <div
                  key={s.id}
                  className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4 hover:border-violet-300 transition-colors"
                >
                  {/* หัวการ์ด: ชื่อกะเด่นชัด + เวลา 1 ครั้ง ไม่ซ้ำซ้อน */}
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-[17px] font-bold text-slate-900 leading-snug">
                        {cleanName}
                      </h3>
                      <span className="inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 shrink-0">
                        {isCross ? (
                          <>
                            <Moon className="w-3.5 h-3.5 text-blue-700" />
                            <span className="text-blue-700 font-semibold">เวรข้ามวัน</span>
                          </>
                        ) : (
                          <>
                            <Sun className="w-3.5 h-3.5 text-emerald-700" />
                            <span>ภายในวัน</span>
                          </>
                        )}
                      </span>
                    </div>

                    <div className="text-[19px] font-bold font-mono tabular-nums text-violet-800">
                      {s.start_time}–{s.end_time} น.
                    </div>

                    <div className="text-[12.5px] text-slate-500">
                      รหัสกะ: <span className="font-mono text-slate-700">{s.shift_code}</span> ·{' '}
                      {categoryText}
                    </div>
                  </div>

                  {/* รายละเอียด 5 รายการตามข้อกำหนดข้อ 5 */}
                  <div className="pt-3 border-t border-slate-200 space-y-1.5 text-[13.5px]">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาเริ่มงาน:</span>
                      <span className="font-mono font-semibold text-slate-800 tabular-nums">
                        {s.start_time} น.
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาเลิกงาน:</span>
                      <span className="font-mono font-semibold text-slate-800 tabular-nums">
                        {s.end_time} น. {isCross ? '(วันถัดไป)' : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาผ่อนผันการมาสาย:</span>
                      <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                        {s.grace_minutes} นาที
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาตัดรอบสแกน:</span>
                      <span className="font-mono font-semibold text-amber-700 tabular-nums">
                        {s.cutoff_time} น.
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">สถานะเปิดใช้งาน:</span>
                      <span
                        className={`font-semibold ${
                          isActive ? 'text-emerald-700' : 'text-slate-500'
                        }`}
                      >
                        {isActive ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                      </span>
                    </div>
                  </div>

                  <div className="pt-2 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        openAssignWorkspace({
                          method: 'SINGLE_PERSON',
                          shiftId: Number(s.id),
                        })
                      }
                      className="h-9 px-3 rounded-lg border border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-900 text-[12.5px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <User className="w-3.5 h-3.5" />
                      <span>จัดเวรรายบุคคล</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        openAssignWorkspace({
                          method: 'MULTI_PERSON',
                          shiftId: Number(s.id),
                        })
                      }
                      className="h-9 px-3 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[12.5px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Users className="w-3.5 h-3.5" />
                      <span>จัดเวรหลายคน</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* =================================================================
              ส่วนที่ 3.2: กฎกะเช้าเริ่มต้นตามประเภทบุคลากร (Personnel Type Default Shift Rules)
             ================================================================= */}
          <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-4">
              <div>
                <div className="text-[12px] font-semibold text-violet-700">
                  กฎกะเช้าเริ่มต้นอัตโนมัติตามประเภทบุคลากร (Default Morning Shift by Personnel Type)
                </div>
                <h3 className="text-[17px] font-bold text-slate-900">
                  กำหนดเวลาเริ่ม–เลิกงาน กะเช้าเริ่มต้น และเวลาผ่อนผันสายแยกตามประเภทบุคลากร
                </h3>
                <p className="text-[13px] text-slate-600 mt-0.5">
                  หากบุคลากรไม่มีการจัดเวรพิเศษและไม่ได้ถูกลบเวรในวันนั้น ระบบจะใช้กะเช้าเริ่มต้นตามประเภทบุคลากรโดยอัตโนมัติ (การแก้ไขมีผลตั้งแต่วันที่มีผลบังคับใช้เป็นต้นไป ไม่กระทบข้อมูลย้อนหลัง)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAddRuleForm((v) => !v)}
                className="h-10 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[13px] font-semibold inline-flex items-center gap-1.5 shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>{showAddRuleForm ? 'ปิดฟอร์มเพิ่มประเภทบุคลากร' : 'เพิ่มประเภทบุคลากรใหม่'}</span>
              </button>
            </div>

            {showAddRuleForm && (
              <form
                onSubmit={handleCreateRule}
                className="p-4 rounded-xl bg-violet-50/50 border border-violet-200 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end"
              >
                <div>
                  <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                    รหัสประเภท <RequiredMark />
                  </label>
                  <input
                    type="text"
                    required
                    value={newRuleCode}
                    onChange={(e) => setNewRuleCode(e.target.value)}
                    placeholder="เช่น CONTRACT_EMP"
                    className="w-full h-9 px-3 rounded-lg border border-slate-300 bg-white text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                    ชื่อประเภทบุคลากร <RequiredMark />
                  </label>
                  <input
                    type="text"
                    required
                    value={newRuleName}
                    onChange={(e) => setNewRuleName(e.target.value)}
                    placeholder="เช่น ลูกจ้างเหมาบริการ"
                    className="w-full h-9 px-3 rounded-lg border border-slate-300 bg-white text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                    เวลาเริ่ม–เลิกงาน
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="time"
                      value={newRuleStart}
                      onChange={(e) => setNewRuleStart(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-slate-300 bg-white text-[13px] font-mono"
                    />
                    <span>–</span>
                    <input
                      type="time"
                      value={newRuleEnd}
                      onChange={(e) => setNewRuleEnd(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-slate-300 bg-white text-[13px] font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                    ผ่อนผันสาย (นาที)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={newRuleGrace}
                    onChange={(e) => setNewRuleGrace(Number(e.target.value))}
                    className="w-full h-9 px-3 rounded-lg border border-slate-300 bg-white text-[13px] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-slate-700 mb-1">
                    เวลาตัดรอบ / วันที่มีผล
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="time"
                      value={newRuleCutoff}
                      onChange={(e) => setNewRuleCutoff(e.target.value)}
                      className="w-24 h-9 px-2 rounded-lg border border-slate-300 bg-white text-[12.5px] font-mono"
                    />
                    <input
                      type="date"
                      value={newRuleEffectiveFrom}
                      onChange={(e) => setNewRuleEffectiveFrom(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-slate-300 bg-white text-[12.5px] font-mono"
                    />
                  </div>
                </div>
                <div>
                  <button
                    type="submit"
                    disabled={ruleSaving}
                    className="w-full h-9 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[13px] font-semibold"
                  >
                    {ruleSaving ? 'กำลังบันทึก...' : 'บันทึกกฎใหม่'}
                  </button>
                </div>
              </form>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                    <th className="py-2.5 px-3 font-semibold">ประเภทบุคลากร</th>
                    <th className="py-2.5 px-3 font-semibold">รหัสอ้างอิง</th>
                    <th className="py-2.5 px-3 font-semibold">เวลากะเช้าเริ่มต้น</th>
                    <th className="py-2.5 px-3 font-semibold">เวลาผ่อนผันสาย</th>
                    <th className="py-2.5 px-3 font-semibold">เวลาตัดรอบสแกน</th>
                    <th className="py-2.5 px-3 font-semibold">วันที่มีผลบังคับใช้</th>
                    <th className="py-2.5 px-3 font-semibold">สถานะ</th>
                    <th className="py-2.5 px-3 font-semibold text-right">การจัดการ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {personnelTypeRules.map((r) => {
                    const active = Number(r.is_active ?? 1) === 1;
                    return (
                      <tr key={r.id} className="hover:bg-violet-50/30">
                        <td className="py-2.5 px-3 font-bold text-slate-900">
                          {r.personnel_type_name}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[12.5px] text-slate-600">
                          {r.personnel_type_code}
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold text-violet-900">
                          {r.default_start_time || '08:00'}–{r.default_end_time || '16:00'} น.
                        </td>
                        <td className="py-2.5 px-3 font-mono font-semibold text-emerald-700">
                          {r.default_grace_minutes ?? 15} นาที
                        </td>
                        <td className="py-2.5 px-3 font-mono text-amber-800">
                          {r.default_cutoff_time || '11:00'} น.
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[12.5px] text-slate-600">
                          {formatThaiDate(String(r.effective_from || '2020-01-01').slice(0, 10))}
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`text-[12.5px] font-semibold ${
                              active ? 'text-emerald-700' : 'text-slate-400'
                            }`}
                          >
                            {active ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right space-x-2">
                          <button
                            type="button"
                            onClick={() => setEditingRule({ ...r })}
                            className="h-8 px-3 rounded-md border border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-900 text-[12px] font-semibold inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>แก้ไขเวลา/ค่าสาย</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleToggleRuleActive(r)}
                            className="h-8 px-3 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-medium"
                          >
                            {active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          DIALOG 1: หน้าต่างตรวจสอบรายละเอียด Snapshot ของเวรรายรายการ
         ===================================================================== */}
      <SharedModal
        open={Boolean(inspectTarget)}
        onClose={() => setInspectTarget(null)}
        kickerText="รายละเอียดตารางเวรและค่า Snapshot ที่บันทึกไว้"
        title={
          inspectTarget
            ? `ตารางเวรวันที่ ${formatThaiDate(inspectTarget.work_date)} — ${inspectTarget.full_name}`
            : 'รายละเอียดตารางเวร'
        }
        maxWidthClass="max-w-lg"
        footer={
          inspectTarget ? (
            <div className="flex flex-wrap items-center justify-between gap-2 w-full">
              <button
                type="button"
                onClick={() => {
                  const target = inspectTarget;
                  setInspectTarget(null);
                  openAssignWorkspace({
                    method: 'SINGLE_PERSON',
                    personId: String(target.person_id).trim(),
                    workDate: String(target.work_date).slice(0, 10),
                  });
                }}
                className="h-10 px-3.5 rounded-lg border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-900 text-[13px] font-semibold inline-flex items-center gap-1.5"
              >
                <Plus className="w-4 h-4" />
                <span>เพิ่มกะอื่นในวันนี้</span>
              </button>

              {inspectTarget.status === 'ACTIVE' && (
                <button
                  type="button"
                  onClick={() => {
                    const target = inspectTarget;
                    setInspectTarget(null);
                    setCancelTarget(target);
                  }}
                  className="h-10 px-4 rounded-lg bg-red-700 hover:bg-red-800 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-1.5"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>ยกเลิกตารางเวรนี้ (Soft Cancel)</span>
                </button>
              )}
            </div>
          ) : undefined
        }
      >
        {inspectTarget && (
          <div className="space-y-4 text-[14px]">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">บุคลากร:</span>
                <span className="font-bold text-slate-900">
                  {inspectTarget.full_name} ({inspectTarget.person_id})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">กลุ่มงาน/แผนก:</span>
                <span className="font-medium text-slate-800">{inspectTarget.department_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">วันที่ปฏิบัติงาน:</span>
                <span className="font-mono font-bold text-slate-800">
                  {formatThaiDate(inspectTarget.work_date)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">ชื่อกะ (Snapshot):</span>
                <span className="font-bold text-violet-900">
                  {formatCleanShiftName(inspectTarget.snapshot_shift_name)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">รหัสกะ:</span>
                <span className="font-mono text-slate-700">{inspectTarget.snapshot_shift_code}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">เวลาเริ่ม–เลิกงาน:</span>
                <span className="font-mono font-bold text-slate-900 tabular-nums">
                  {inspectTarget.snapshot_start_time}–{inspectTarget.snapshot_end_time} น.
                  {Number(inspectTarget.snapshot_is_cross_midnight) === 1
                    ? ' (ข้ามเที่ยงคืน +1 วัน)'
                    : ''}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">เวลาผ่อนผันการมาสาย:</span>
                <span className="font-mono text-emerald-700 font-semibold">
                  {inspectTarget.snapshot_grace_minutes} นาที
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">เวลาตัดรอบสแกน:</span>
                <span className="font-mono text-amber-700 font-semibold">
                  {inspectTarget.snapshot_cutoff_time} น.
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">ผู้มอบหมายเวร:</span>
                <span className="font-mono text-slate-700">{inspectTarget.assigned_by || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">สถานะปัจจุบัน:</span>
                <span
                  className={`font-bold ${
                    inspectTarget.status === 'ACTIVE' ? 'text-emerald-700' : 'text-red-700'
                  }`}
                >
                  {inspectTarget.status === 'ACTIVE' ? 'ใช้งานปกติ (ACTIVE)' : 'ยกเลิกแล้ว (CANCELLED)'}
                </span>
              </div>
            </div>
          </div>
        )}
      </SharedModal>

      {/* =====================================================================
          DIALOG 2: หน้าต่างยืนยันการยกเลิกตารางเวรแบบบันทึกประวัติ (Soft Cancel)
         ===================================================================== */}
      <SharedModal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        kickerText="การยกเลิกตารางเวรพร้อมบันทึกประวัติการตรวจสอบ"
        title={`ยืนยันการยกเลิกตารางเวร #${cancelTarget?.id || ''}`}
        maxWidthClass="max-w-lg"
      >
        {cancelTarget && (
          <form onSubmit={handleConfirmCancelAssignment} className="space-y-4 text-[14px]">
            <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 space-y-1">
              <div className="font-bold text-[15px] text-slate-900">
                {cancelTarget.full_name} ({cancelTarget.person_id})
              </div>
              <div className="text-slate-600">
                วันที่เวร: {formatThaiDate(cancelTarget.work_date)} · กะ:{' '}
                {formatCleanShiftName(cancelTarget.snapshot_shift_name)} (
                {cancelTarget.snapshot_start_time}–{cancelTarget.snapshot_end_time} น.)
              </div>
            </div>
            <div>
              <label className="block text-[13.5px] font-semibold text-slate-700 mb-1.5">
                ระบุเหตุผลการยกเลิกเวร <RequiredMark />
              </label>
              <textarea
                rows={3}
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full p-3 border border-slate-300 rounded-lg text-[14px] text-slate-800 focus:outline-none focus:border-violet-600"
              />
            </div>
            <div className="flex justify-end gap-2.5 pt-3 border-t border-slate-200">
              <button
                type="submit"
                className="w-full sm:w-auto h-10 px-5 text-[14px] font-semibold bg-red-700 text-white rounded-lg hover:bg-red-800 transition-colors"
              >
                ยืนยันยกเลิกตารางเวร
              </button>
            </div>
          </form>
        )}
      </SharedModal>

      {/* =====================================================================
          DIALOG 3: Quick Single-Person Cell Modal (คลิกช่องของบุคลากร 1 คนในตารางเวร)
         ===================================================================== */}
      <SharedModal
        open={Boolean(quickCellTarget)}
        onClose={() => setQuickCellTarget(null)}
        kickerText="จัดการเวรรายบุคคลประจำวัน (Quick Daily Shift Cell)"
        title={
          quickCellTarget
            ? `${quickCellTarget.person.full_name} — ${formatThaiDate(quickCellTarget.workDate)}`
            : 'จัดการเวรรายบุคคล'
        }
        maxWidthClass="max-w-xl"
      >
        {quickCellTarget && (() => {
          const eff = getEffectiveCellState(quickCellTarget.person, quickCellTarget.workDate);
          const defRule = eff.defaultRule;
          return (
            <div className="space-y-4 text-[13.5px]">
              {/* ข้อมูลสรุปบุคลากรและสถานะเวรปัจจุบัน */}
              <div className="p-3.5 rounded-xl bg-violet-50/60 border border-violet-200 space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">ชื่อบุคลากร:</span>
                  <span className="font-bold text-slate-900">
                    {quickCellTarget.person.full_name} ({quickCellTarget.person.person_id})
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">วันที่ปฏิบัติงาน:</span>
                  <span className="font-mono font-bold text-violet-950">
                    {formatThaiDate(quickCellTarget.workDate)}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">ประเภทบุคลากร:</span>
                  <span className="font-semibold text-slate-800">
                    {quickCellTarget.person.personnel_type_name ||
                      defRule?.personnel_type_name ||
                      'ไม่ระบุประเภท'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-600">กะเช้าเริ่มต้นตามประเภท:</span>
                  <span className="font-mono font-semibold text-emerald-800">
                    {defRule
                      ? `กะเช้า (${defRule.default_start_time || '08:00'}–${defRule.default_end_time || '16:00'} น. · สายได้ ${defRule.default_grace_minutes ?? 15} นาที)`
                      : 'ยังไม่ได้ตั้งค่ากะเริ่มต้น'}
                  </span>
                </div>
                <div className="flex items-center justify-between pt-1 border-t border-violet-200/80">
                  <span className="text-slate-600">กะปัจจุบันในวันนี้:</span>
                  <span className="font-bold text-violet-900">
                    {eff.mode === 'CLEARED_ALL_SHIFTS'
                      ? 'ไม่มีเวร (ลบเวรทั้งหมดในวันนี้ออกแล้ว)'
                      : eff.mode === 'CUSTOM_ASSIGNED'
                        ? eff.activeItems
                            .map(
                              (x: any) =>
                                `${formatCleanShiftName(x.snapshot_shift_name)} (${x.snapshot_start_time}–${x.snapshot_end_time})`
                            )
                            .join(', ')
                        : eff.mode === 'DEFAULT_FROM_TYPE' && defRule
                          ? `กะเช้าเริ่มต้น (${defRule.default_start_time || '08:00'}–${defRule.default_end_time || '16:00'} น.)`
                          : 'ไม่มีเวร'}
                  </span>
                </div>
              </div>

              {/* เลือกแม่แบบกะสำหรับ เพิ่มกะ หรือ เปลี่ยนกะ */}
              <div className="p-3.5 rounded-xl bg-white border border-slate-200 space-y-3">
                <label className="block text-[13px] font-bold text-slate-800">
                  เลือกแม่แบบกะทำงานที่ต้องการเพิ่มหรือเปลี่ยนแทนที่:
                </label>
                <select
                  aria-label="เลือกแม่แบบกะทำงานสำหรับช่องวันที่นี้"
                  value={quickCellSelectedShiftId}
                  onChange={(e) => setQuickCellSelectedShiftId(Number(e.target.value))}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] font-semibold text-slate-900 focus:outline-none focus:border-violet-600"
                >
                  {shifts.map((s) => (
                    <option key={s.id} value={Number(s.id)}>
                      {formatCleanShiftName(s.shift_name)} · {s.start_time}–{s.end_time} น. ({s.shift_code})
                    </option>
                  ))}
                </select>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={quickCellBusy}
                    onClick={() => handleQuickCellAction('REPLACE_SHIFTS')}
                    className="h-10 px-3.5 rounded-lg bg-violet-700 hover:bg-violet-800 text-white font-semibold text-[13px] inline-flex items-center justify-center gap-1.5"
                  >
                    <Check className="w-4 h-4" />
                    <span>บันทึก / เปลี่ยนเป็นกะที่เลือก</span>
                  </button>
                  <button
                    type="button"
                    disabled={quickCellBusy}
                    onClick={() => handleQuickCellAction('ADD_SHIFT')}
                    className="h-10 px-3.5 rounded-lg border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-900 font-semibold text-[13px] inline-flex items-center justify-center gap-1.5"
                  >
                    <Plus className="w-4 h-4" />
                    <span>เพิ่มกะที่เลือกควบคู่ในวันนี้</span>
                  </button>
                </div>
              </div>

              {/* ปุ่มลัดจัดการกะเช้า / กะบ่าย / ลบกะทั้งหมด (ไม่มีเวร) / คืนค่ากะเริ่มต้น */}
              <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                <div className="text-[12.5px] font-bold text-slate-700">
                  คำสั่งจัดการด่วนสำหรับวันที่ {formatThaiDate(quickCellTarget.workDate)}:
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={quickCellBusy}
                    onClick={() => handleQuickCellAction('REMOVE_MORNING')}
                    className="h-9 px-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-[12.5px] font-semibold"
                  >
                    ลบเฉพาะกะเช้า
                  </button>
                  <button
                    type="button"
                    disabled={quickCellBusy}
                    onClick={() => handleQuickCellAction('REMOVE_AFTERNOON')}
                    className="h-9 px-3 rounded-lg border border-slate-300 bg-white hover:bg-slate-100 text-slate-800 text-[12.5px] font-semibold"
                  >
                    ลบเฉพาะกะบ่าย
                  </button>
                  <button
                    type="button"
                    disabled={quickCellBusy}
                    onClick={() => handleQuickCellAction('CLEAR_ALL_SHIFTS')}
                    className="h-9 px-3 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-red-800 text-[12.5px] font-bold inline-flex items-center justify-center gap-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>ลบกะทั้งหมด (ตั้งเป็นไม่มีเวร)</span>
                  </button>
                  <button
                    type="button"
                    disabled={quickCellBusy}
                    onClick={() => handleQuickCellAction('RESTORE_DEFAULT')}
                    className="h-9 px-3 rounded-lg border border-emerald-300 bg-emerald-50 hover:bg-emerald-100 text-emerald-900 text-[12.5px] font-bold inline-flex items-center justify-center gap-1"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>คืนค่ากะเริ่มต้น</span>
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </SharedModal>

      {/* =====================================================================
          DIALOG 4: นำเข้าตารางเวรจากไฟล์ Excel (.xlsx)
         ===================================================================== */}
      <SharedModal
        open={showExcelImportModal}
        onClose={() => setShowExcelImportModal(false)}
        kickerText="นำเข้าตารางเวรจากไฟล์ Excel (.xlsx)"
        title="อัปโหลดและตรวจสอบตารางเวรจากไฟล์ Excel (.xlsx)"
        maxWidthClass="max-w-2xl"
      >
        <div className="space-y-4 text-[13.5px]">
          <div className="p-3.5 rounded-xl bg-violet-50/70 border border-violet-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-bold text-slate-900">
                คอลัมน์มาตรฐานที่รองรับ: person_id, full_name, work_date, shift_code
              </div>
              <div className="text-[12.5px] text-slate-600">
                รหัสกะมาตรฐาน: MOR (เช้า), AFT (บ่าย), NIG (ดึก), MORAFT (เช้า–บ่าย), AFTNIG (บ่าย–ดึก), FULL (ทั้งวัน), OFF (ไม่มีเวร)
              </div>
            </div>
            <button
              type="button"
              onClick={handleDownloadExcelTemplate}
              className="h-9 px-3.5 rounded-lg border border-violet-300 bg-white hover:bg-violet-50 text-violet-900 text-[12.5px] font-semibold inline-flex items-center gap-1.5 shrink-0"
            >
              <Download className="w-4 h-4" />
              <span>ดาวน์โหลด Template Excel</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-semibold text-slate-700 mb-1">
                เลือกไฟล์ Excel (.xlsx) <RequiredMark />
              </label>
              <input
                type="file"
                accept=".xlsx"
                onChange={handleSelectExcelFile}
                className="w-full text-[13px] file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-semibold file:bg-violet-100 file:text-violet-900 hover:file:bg-violet-200"
              />
            </div>
            <div>
              <label className="block text-[13px] font-semibold text-slate-700 mb-1">
                รูปแบบการนำเข้าเมื่อมีเวรเดิมในวันเดียวกัน
              </label>
              <select
                value={excelImportMode}
                onChange={(e) => setExcelImportMode(e.target.value as 'REPLACE_DATE' | 'ADD_SHIFT')}
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13px]"
              >
                <option value="REPLACE_DATE">แทนที่เวรเดิมของวันนั้น (แนะนำ)</option>
                <option value="ADD_SHIFT">เพิ่มกะควบคู่โดยไม่ลบเวรเดิม</option>
              </select>
            </div>
          </div>

          {excelError && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-red-800 text-[13px] font-medium">
              {excelError}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!excelFileBase64 || excelBusy}
              onClick={handlePreviewExcelImport}
              className="h-10 px-4 rounded-lg border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-900 font-semibold text-[13px] disabled:opacity-50"
            >
              {excelBusy ? 'กำลังตรวจสอบไฟล์...' : '1. ตรวจสอบข้อมูลก่อนนำเข้า (Preview)'}
            </button>
            {excelPreview && (
              <button
                type="button"
                disabled={excelBusy || Number(excelPreview.summary?.validCount || 0) === 0}
                onClick={handleConfirmExcelImport}
                className="h-10 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white font-semibold text-[13px] disabled:opacity-50"
              >
                {excelBusy
                  ? 'กำลังบันทึก...'
                  : `2. ยืนยันการนำเข้า (${excelPreview.summary?.validCount || 0} รายการ)`}
              </button>
            )}
          </div>

          {excelPreview && (
            <div className="space-y-3 pt-2 border-t border-slate-200">
              <div className="grid grid-cols-3 gap-2.5 text-center">
                <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-[11.5px] text-slate-500">จำนวนแถวทั้งหมด</div>
                  <div className="text-[17px] font-bold font-mono text-slate-900">
                    {excelPreview.summary?.totalRows || 0}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div className="text-[11.5px] text-emerald-700">พร้อมนำเข้า</div>
                  <div className="text-[17px] font-bold font-mono text-emerald-800">
                    {excelPreview.summary?.validCount || 0}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200">
                  <div className="text-[11.5px] text-amber-800">พบปัญหา / ข้าม</div>
                  <div className="text-[17px] font-bold font-mono text-amber-900">
                    {excelPreview.summary?.invalidCount || 0}
                  </div>
                </div>
              </div>

              <div className="max-h-60 overflow-y-auto border border-slate-200 rounded-lg">
                <table className="w-full text-left border-collapse text-[12.5px]">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr className="border-b border-slate-200">
                      <th className="py-2 px-2.5">แถว</th>
                      <th className="py-2 px-2.5">บุคลากร</th>
                      <th className="py-2 px-2.5">วันที่</th>
                      <th className="py-2 px-2.5">กะ</th>
                      <th className="py-2 px-2.5">ผลการตรวจสอบ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {(excelPreview.items || []).map((it: any, idx: number) => (
                      <tr key={idx}>
                        <td className="py-1.5 px-2.5 font-mono">{it.rowNumber}</td>
                        <td className="py-1.5 px-2.5">
                          {it.fullName || it.personId} ({it.personId})
                        </td>
                        <td className="py-1.5 px-2.5 font-mono">{it.workDate}</td>
                        <td className="py-1.5 px-2.5 font-semibold">
                          {it.shiftName || it.shiftCode}
                        </td>
                        <td
                          className={`py-1.5 px-2.5 font-semibold ${
                            it.valid ? 'text-emerald-700' : 'text-red-700'
                          }`}
                        >
                          {it.valid ? 'พร้อมนำเข้า' : it.errorMessage}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </SharedModal>

      {/* =====================================================================
          DIALOG 5: แก้ไขกฎกะเช้าเริ่มต้นตามประเภทบุคลากร
         ===================================================================== */}
      <SharedModal
        open={Boolean(editingRule)}
        onClose={() => setEditingRule(null)}
        kickerText="แก้ไขกฎกะเช้าเริ่มต้นตามประเภทบุคลากร"
        title={
          editingRule
            ? `ตั้งค่ากะเช้าเริ่มต้น — ${editingRule.personnel_type_name}`
            : 'แก้ไขกฎกะเช้าเริ่มต้น'
        }
        maxWidthClass="max-w-lg"
      >
        {editingRule && (
          <form onSubmit={handleSaveRuleEdit} className="space-y-3.5 text-[13.5px]">
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                ชื่อประเภทบุคลากร <RequiredMark />
              </label>
              <input
                type="text"
                required
                value={editingRule.personnel_type_name || ''}
                onChange={(e) =>
                  setEditingRule({ ...editingRule, personnel_type_name: e.target.value })
                }
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  เวลาเริ่มงานกะเช้า <RequiredMark />
                </label>
                <input
                  type="time"
                  required
                  value={editingRule.default_start_time || '08:00'}
                  onChange={(e) =>
                    setEditingRule({ ...editingRule, default_start_time: e.target.value })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  เวลาเลิกงานกะเช้า <RequiredMark />
                </label>
                <input
                  type="time"
                  required
                  value={editingRule.default_end_time || '16:00'}
                  onChange={(e) =>
                    setEditingRule({ ...editingRule, default_end_time: e.target.value })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white font-mono"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  เวลาผ่อนผันสาย (นาที) <RequiredMark />
                </label>
                <input
                  type="number"
                  min={0}
                  max={180}
                  required
                  value={editingRule.default_grace_minutes ?? 15}
                  onChange={(e) =>
                    setEditingRule({
                      ...editingRule,
                      default_grace_minutes: Number(e.target.value),
                    })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-slate-700 mb-1">
                  เวลาตัดรอบสแกนเข้า <RequiredMark />
                </label>
                <input
                  type="time"
                  required
                  value={editingRule.default_cutoff_time || '11:00'}
                  onChange={(e) =>
                    setEditingRule({ ...editingRule, default_cutoff_time: e.target.value })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block font-semibold text-slate-700 mb-1">
                วันที่มีผลบังคับใช้ (ไม่กระทบการคำนวณย้อนหลังก่อนวันนี้)
              </label>
              <input
                type="date"
                value={String(editingRule.effective_from || '2020-01-01').slice(0, 10)}
                onChange={(e) =>
                  setEditingRule({ ...editingRule, effective_from: e.target.value })
                }
                className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white font-mono"
              />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setEditingRule(null)}
                className="h-10 px-4 rounded-lg border border-slate-300 bg-white text-slate-700 font-semibold"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={ruleSaving}
                className="h-10 px-5 rounded-lg bg-violet-700 hover:bg-violet-800 text-white font-semibold"
              >
                {ruleSaving ? 'กำลังบันทึก...' : 'บันทึกการเปลี่ยนแปลง'}
              </button>
            </div>
          </form>
        )}
      </SharedModal>
    </div>
  );
}
