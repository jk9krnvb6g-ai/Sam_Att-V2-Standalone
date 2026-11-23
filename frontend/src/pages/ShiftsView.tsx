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
import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import {
  Plus,
  Trash2,
  Clock,
  Moon,
  MoonStar,
  Sun,
  Sunset,
  Sunrise,
  CloudMoon,
  Sparkles,
  RefreshCw,
  Calendar,
  List,
  Search,
  ChevronLeft,
  ChevronRight,
  CheckCircle2,
  AlertTriangle,
  Info,
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
  Star,
  ArrowRightLeft,
  Power,
  ShieldCheck,
} from 'lucide-react';
import {
  apiRequest,
  ApiClientError,
  downloadShiftImportTemplateXlsx,
  type UserRole,
} from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  MetricStrip,
  TabBar,
  StatusBadge,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  FloatingToastStack,
  SharedModal,
  ConfirmDialog,
  TableEmptyState,
  RequiredMark,
  type FloatingToastData,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { ShiftTemplateModal } from '../components/shifts/ShiftTemplateModal.tsx';
import {
  DEFAULT_ERROR_TOAST_MS,
  DEFAULT_SUCCESS_TOAST_MS,
  DEFAULT_WARNING_TOAST_MS,
  type ActiveDefaultBindingInfo,
  type ShiftTemplateModalMode,
} from '../utils/shiftTemplateForm.ts';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  getCurrentBangkokDateParts,
} from '../utils/thaiFormat.ts';
import {
  classifyShiftIconKind,
  buildCompactMonthlyCellViewModel,
  computeClientShiftInterval,
  intervalsOverlapHalfOpen,
  computeFilteredSelectionState,
  toggleSelectAllFiltered,
  findAllClientSelectedShiftsOverlaps,
  type ShiftIconKind,
} from '../utils/shiftDisplay.ts';

type WorkspaceTabKey = 'ROSTER' | 'ASSIGN_WORKSPACE' | 'TEMPLATES';
type RosterViewMode = 'MONTHLY_GRID' | 'WEEKLY_GRID' | 'DETAIL_LIST';
type MonthDayRangeMode = 'ALL' | 'FIRST_HALF' | 'SECOND_HALF';
type AssignMethodMode = 'SINGLE_PERSON' | 'MULTI_PERSON';
type DatePickStrategy = 'SINGLE_DAY' | 'MULTI_PICK' | 'DATE_RANGE';
type WeekdayFilterMode = 'ALL_DAYS' | 'WEEKDAYS_ONLY' | 'WEEKENDS_ONLY';
type ConflictStrategyMode = 'SKIP_CONFLICTS' | 'ABORT_ON_CONFLICT';
type PreviewFilterTab = 'ALL' | 'READY' | 'CONFLICT';
type BulkOperationMode =
  | 'ADD_SHIFTS'
  | 'REPLACE_SHIFTS'
  | 'REMOVE_SELECTED_SHIFTS'
  | 'CLEAR_ALL_SHIFTS';

function renderShiftIcon(kind: ShiftIconKind, className = 'w-3.5 h-3.5') {
  switch (kind) {
    case 'MORNING':
      return <Sun className={`${className} text-amber-600 shrink-0`} aria-hidden="true" />;
    case 'AFTERNOON':
      return <Sunset className={`${className} text-orange-600 shrink-0`} aria-hidden="true" />;
    case 'NIGHT':
      return <Moon className={`${className} text-indigo-700 shrink-0`} aria-hidden="true" />;
    case 'MORNING_AFTERNOON':
      return <Sunrise className={`${className} text-[#4E3978] shrink-0`} aria-hidden="true" />;
    case 'AFTERNOON_NIGHT':
      return <CloudMoon className={`${className} text-indigo-600 shrink-0`} aria-hidden="true" />;
    case 'SPECIAL':
      return <MoonStar className={`${className} text-fuchsia-700 shrink-0`} aria-hidden="true" />;
    case 'FULL_DAY':
    default:
      return <Clock className={`${className} text-[#4E3978] shrink-0`} aria-hidden="true" />;
  }
}

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

export function ShiftsView({
  userRole = 'ADMIN',
  onNavigate,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const canEditShifts = userRole === 'ADMIN' || userRole === 'RESPONSIBLE_STAFF';
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
  const [defaultBindings, setDefaultBindings] = useState<any[]>([]);
  const [cancellationLogs, setCancellationLogs] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string; requestId?: string } | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(null);

  // ระบบแจ้งเตือนมาตรฐานแบบ Toast มุมขวาบน (Success ปิดอัตโนมัติใน 4 วินาที, Error/Warning กดปิดได้)
  const [toasts, setToasts] = useState<FloatingToastData[]>([]);
  const toastTimersRef = useRef<Map<string, number>>(new Map());

  const dismissToast = useCallback((id: string) => {
    const timer = toastTimersRef.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(id);
    }
    setToasts((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const pushToast = useCallback(
    (
      variant: 'success' | 'error' | 'warning',
      message: string,
      options?: { detail?: string; requestId?: string; durationMs?: number }
    ) => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const durationMs =
        options?.durationMs ??
        (variant === 'success'
          ? DEFAULT_SUCCESS_TOAST_MS
          : variant === 'warning'
            ? DEFAULT_WARNING_TOAST_MS
            : DEFAULT_ERROR_TOAST_MS);

      setToasts((prev) => [
        ...prev.slice(-3),
        {
          id,
          variant,
          message,
          detail: options?.detail,
          requestId: options?.requestId,
        },
      ]);

      if (durationMs > 0) {
        const timer = window.setTimeout(() => {
          toastTimersRef.current.delete(id);
          setToasts((prev) => prev.filter((item) => item.id !== id));
        }, durationMs);
        toastTimersRef.current.set(id, timer);
      }
    },
    []
  );

  useEffect(() => {
    const timersMap = toastTimersRef.current;
    return () => {
      timersMap.forEach((timerId) => window.clearTimeout(timerId));
      timersMap.clear();
    };
  }, []);

  // ตัวกรองตารางเวรหลัก
  const [selectedMonth, setSelectedMonth] = useState(initialBkk.currentYearMonth);
  const [searchText, setSearchText] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('ALL');
  const [shiftFilter, setShiftFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'CANCELLED' | 'ALL'>('ACTIVE');

  // การแบ่งหน้าบุคลากรในตารางเวรรายเดือน/รายสัปดาห์ เพื่อรองรับหลายร้อยคนโดยไม่กระตุก
  const [rosterPersonPage, setRosterPersonPage] = useState(1);
  const [rosterPersonPageSize, setRosterPersonPageSize] = useState<number>(25);

  // ตัวกรองและสถานะ Modal ในแท็บแม่แบบกะทำงาน (Unified Create / Edit Modal)
  const [templateSearch, setTemplateSearch] = useState('');
  const [templateModalState, setTemplateModalState] = useState<{
    open: boolean;
    mode: ShiftTemplateModalMode;
    shift: any | null;
  }>({
    open: false,
    mode: 'create',
    shift: null,
  });
  const [confirmToggleShiftTarget, setConfirmToggleShiftTarget] = useState<any | null>(null);
  const [toggleShiftBusy, setToggleShiftBusy] = useState(false);
  const [confirmToggleRuleTarget, setConfirmToggleRuleTarget] = useState<any | null>(null);
  const [toggleRuleBusy, setToggleRuleBusy] = useState(false);

  // หน้าต่างเปลี่ยนกะเริ่มต้นแบบชัดเจนและมีการบันทึก Audit Log (Explicit Change Default Shift)
  const [changeDefaultModalOpen, setChangeDefaultModalOpen] = useState(false);
  const [changeDefaultScopeCode, setChangeDefaultScopeCode] = useState('');
  const [changeDefaultSelectedShiftId, setChangeDefaultSelectedShiftId] = useState<string>('');
  const [changeDefaultReason, setChangeDefaultReason] = useState('');
  const [changeDefaultSaving, setChangeDefaultSaving] = useState(false);
  const [changeDefaultError, setChangeDefaultError] = useState<{
    code?: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [confirmChangeDefaultPayload, setConfirmChangeDefaultPayload] = useState<{
    scopeCode: string;
    scopeName: string;
    previousShiftName: string;
    previousShiftCode: string;
    nextShiftId: number;
    nextShiftName: string;
    nextShiftCode: string;
  } | null>(null);
  const [confirmClearDefaultScope, setConfirmClearDefaultScope] = useState<{
    personnelTypeCode: string;
    personnelTypeName: string;
    currentShiftName: string;
  } | null>(null);

  // =========================================================================
  // สถานะสำหรับหน้า "จัดเวร / เพิ่มเวรใหม่" (Full-Page Assignment Workspace)
  // =========================================================================
  const [assignMethod, setAssignMethod] = useState<AssignMethodMode>('SINGLE_PERSON');
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>([]);
  const [assignPersonDeptFilter, setAssignPersonDeptFilter] = useState('ALL');
  const [assignPersonSearch, setAssignPersonSearch] = useState('');
  const [assignPersonnelRenderLimit, setAssignPersonnelRenderLimit] = useState<number>(80);
  const [confirmClearPersonsOpen, setConfirmClearPersonsOpen] = useState<boolean>(false);
  const [showAllSelectedPersonChips, setShowAllSelectedPersonChips] = useState<boolean>(false);
  const selectAllFilteredCheckboxRef = useRef<HTMLInputElement | null>(null);

  const [selectedShiftIds, setSelectedShiftIds] = useState<number[]>([]);
  const [bulkOperationMode, setBulkOperationMode] = useState<BulkOperationMode>('ADD_SHIFTS');
  const [bulkActionReason, setBulkActionReason] = useState<string>('');
  const [confirmBulkModalOpen, setConfirmBulkModalOpen] = useState<boolean>(false);
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
    operationMode?: BulkOperationMode;
    shiftSnapshot: any | null;
    shiftSnapshots?: any[];
    summary: {
      totalRequested: number;
      readyCount: number;
      conflictCount: number;
      duplicateCount: number;
      overlapCount: number;
      notAssignedCount?: number;
      replaceAffectedCells?: number;
      clearAffectedCells?: number;
    };
    items: Array<{
      personId: string;
      fullName: string;
      departmentName: string;
      workDate: string;
      shiftId?: number | null;
      shiftCode?: string | null;
      shiftName?: string | null;
      startTime?: string | null;
      endTime?: string | null;
      isCrossMidnight?: number;
      operationMode?: BulkOperationMode;
      status:
        | 'READY'
        | 'DUPLICATE_SAME_SHIFT'
        | 'TIME_OVERLAP_CONFLICT'
        | 'SELECTED_SHIFTS_OVERLAP'
        | 'NOT_ASSIGNED';
      conflictCode: string | null;
      conflictMessage: string | null;
      existingOnDateCount?: number;
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
  // Quick Single-Person Cell Modal (คลิกวันที่ -> โหลดกะจริง -> ติ๊กกะ -> บันทึกครั้งเดียว)
  // =========================================================================
  const [quickCellTarget, setQuickCellTarget] = useState<{
    person: any;
    workDate: string;
  } | null>(null);
  const [quickCellLoading, setQuickCellLoading] = useState(false);
  const [quickCellLoadError, setQuickCellLoadError] = useState<string | null>(null);
  const [quickCellData, setQuickCellData] = useState<{
    canEdit: boolean;
    person: {
      person_id: string;
      full_name: string;
      department_name: string;
      personnel_type_code: string;
      personnel_type_name: string;
    };
    workDate: string;
    effectiveState: string;
    effectiveShifts: Array<{
      identityKey: string;
      assignmentId: number | null;
      templateId: number | null;
      shiftCode: string;
      shiftName: string;
      shiftCategory: string;
      workDate: string;
      startTime: string;
      endTime: string;
      endDate: string;
      isCrossMidnight: number;
      source: 'ASSIGNMENT' | 'DEFAULT_IMPLICIT';
      isSpecialAssignment: boolean;
      specialReason: 'UNMATCHED_TEMPLATE' | 'DUPLICATE_TEMPLATE' | null;
    }>;
    availableTemplates: Array<{
      id: number;
      shiftCode: string;
      shiftName: string;
      shiftCategory: string;
      startTime: string;
      endTime: string;
      graceMinutes: number;
      cutoffTime: string;
      isCrossMidnight: number;
    }>;
    selectedTemplateIds: number[];
    dailyOverride: {
      overrideState: string;
      reason: string | null;
      updatedBy: string;
      updatedAt: string | null;
    } | null;
    clearedAll: boolean;
    defaultRule: {
      personnelTypeCode: string;
      personnelTypeName: string;
      defaultStartTime: string;
      defaultEndTime: string;
      defaultGraceMinutes: number;
      defaultCutoffTime: string;
      isActive: number;
    } | null;
    carryoverFromPrevDay: Array<{
      assignmentId: number | null;
      shiftCode: string;
      shiftName: string;
      workDate: string;
      startTime: string;
      endTime: string;
      endDate: string;
      isCrossMidnight: number;
      noticeText: string;
    }>;
    nextDayShifts: Array<{
      shiftCode: string;
      shiftName: string;
      workDate: string;
      startTime: string;
      endTime: string;
      endDate: string;
      isCrossMidnight: number;
    }>;
    specialExistingAssignments: Array<{
      identityKey: string;
      assignmentId: number | null;
      templateId: number | null;
      shiftCode: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      isCrossMidnight: number;
      specialReason: 'UNMATCHED_TEMPLATE' | 'DUPLICATE_TEMPLATE' | null;
    }>;
  } | null>(null);
  const [quickCellSelectedIds, setQuickCellSelectedIds] = useState<number[]>([]);
  const [quickCellKeepSpecialIds, setQuickCellKeepSpecialIds] = useState<number[]>([]);
  const [quickCellPreviewLoading, setQuickCellPreviewLoading] = useState(false);
  const [quickCellPreview, setQuickCellPreview] = useState<{
    canProceed: boolean;
    hasChanges: boolean;
    willClearAll: boolean;
    conflicts: Array<{
      code: string;
      message: string;
    }>;
    existingEffectiveShifts: Array<{
      shiftCode: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      isCrossMidnight: number;
      source: string;
    }>;
    shiftsToKeep: Array<{
      shiftCode: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      isCrossMidnight: number;
    }>;
    shiftsToAdd: Array<{
      shiftCode: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      isCrossMidnight: number;
    }>;
    shiftsToRemove: Array<{
      shiftCode: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      isCrossMidnight: number;
    }>;
    resultingShifts: Array<{
      shiftCode: string;
      shiftName: string;
      startTime: string;
      endTime: string;
      isCrossMidnight: number;
      source: 'EXISTING' | 'DEFAULT_IMPLICIT' | 'NEW';
    }>;
  } | null>(null);
  const [quickCellConfirmStep, setQuickCellConfirmStep] = useState(false);
  const [quickCellError, setQuickCellError] = useState<string | null>(null);
  const [quickCellBusy, setQuickCellBusy] = useState(false);
  const [quickCellReason, setQuickCellReason] = useState('');
  const quickCellLoadSeqRef = useRef(0);
  const quickCellSubmitLockRef = useRef(false);

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
      const loadedRules = shRes.personnelTypeRules || saRes.personnelTypeRules || [];
      setShifts(loadedShifts);
      setDefaultBindings(shRes.defaultBindings || []);
      setAssignments(saRes.items || []);
      setDailyOverrides(saRes.dailyOverrides || []);
      setPersonnelTypeRules(loadedRules);
      setCancellationLogs(saRes.cancellationLogs || []);
      setPersonnel(loadedPersonnel);

      if (loadedShifts.length > 0) {
        const validIds = new Set(loadedShifts.map((s: any) => Number(s.id)));
        setSelectedShiftIds((prev) => {
          const kept = prev.filter((id) => validIds.has(id));
          return kept.length > 0 ? kept : [Number(loadedShifts[0].id)];
        });
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
  }, [monthBounds.dateFrom, monthBounds.dateTo]);

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

  // จัดกลุ่มตารางเวรจริงทั้งหมด (ไม่ถูกตัดออกด้วยตัวกรอง) เพื่อแสดง Icon-Only บนปฏิทินได้ถูกต้องครบถ้วน
  const assignmentsByPersonAndDate = useMemo(() => {
    const map = new Map<string, Map<string, any[]>>();
    for (const a of assignments) {
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
  }, [assignments]);

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
      const hasConfiguredDefault =
        Boolean(defaultRule) &&
        ((defaultRule.default_shift_id != null &&
          Number(defaultRule.default_shift_id) > 0 &&
          Number(defaultRule.default_shift_is_active ?? 1) === 1) ||
          (String(defaultRule.default_start_time || '').trim().length > 0 &&
            String(defaultRule.default_end_time || '').trim().length > 0));

      if (hasConfiguredDefault && defaultRule) {
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

  // ปิด Quick Daily Shift Cell Modal และรีเซ็ตค่าทุกอย่างไม่ให้ค้างไปรอบถัดไป
  function closeQuickCellModal() {
    if (quickCellBusy) return;
    quickCellLoadSeqRef.current += 1;
    setQuickCellTarget(null);
    setQuickCellData(null);
    setQuickCellSelectedIds([]);
    setQuickCellKeepSpecialIds([]);
    setQuickCellPreview(null);
    setQuickCellConfirmStep(false);
    setQuickCellLoadError(null);
    setQuickCellError(null);
    setQuickCellReason('');
    setQuickCellLoading(false);
    setQuickCellPreviewLoading(false);
  }

  // เปิด Quick Daily Shift Cell Modal และโหลดสถานะจริงล่าสุดจาก Backend ทันที
  function openQuickCellModal(person: any, workDate: string) {
    const seq = quickCellLoadSeqRef.current + 1;
    quickCellLoadSeqRef.current = seq;

    // ล้างค่าค้างจากการเปิดครั้งก่อนทั้งหมดก่อนเริ่มโหลดใหม่
    setQuickCellTarget({ person, workDate });
    setQuickCellData(null);
    setQuickCellSelectedIds([]);
    setQuickCellKeepSpecialIds([]);
    setQuickCellPreview(null);
    setQuickCellConfirmStep(false);
    setQuickCellLoadError(null);
    setQuickCellError(null);
    setQuickCellReason('');
    setQuickCellLoading(true);

    const pid = String(person.person_id ?? '').trim();
    apiRequest(
      `/shift-assignments/daily-cell?personId=${encodeURIComponent(pid)}&workDate=${encodeURIComponent(workDate)}`
    )
      .then((res) => {
        if (quickCellLoadSeqRef.current !== seq) return;
        setQuickCellData(res);
        setQuickCellSelectedIds(Array.isArray(res.selectedTemplateIds) ? res.selectedTemplateIds.map(Number) : []);
        const specialIds = Array.isArray(res.specialExistingAssignments)
          ? res.specialExistingAssignments
              .map((s: any) => Number(s.assignmentId))
              .filter((id: number) => id > 0)
          : [];
        setQuickCellKeepSpecialIds(specialIds);
      })
      .catch((err) => {
        if (quickCellLoadSeqRef.current !== seq) return;
        if (err instanceof ApiClientError) {
          setQuickCellLoadError(err.message);
        } else {
          setQuickCellLoadError('ไม่สามารถโหลดข้อมูลกะทำงานล่าสุดจากระบบได้ กรุณาลองใหม่อีกครั้ง');
        }
      })
      .finally(() => {
        if (quickCellLoadSeqRef.current === seq) {
          setQuickCellLoading(false);
        }
      });
  }

  function toggleQuickCellTemplate(templateId: number) {
    if (!canEditShifts || quickCellBusy || quickCellLoading || !quickCellData) return;
    const idNum = Number(templateId);
    setQuickCellConfirmStep(false);
    setQuickCellError(null);
    setQuickCellSelectedIds((prev) =>
      prev.includes(idNum) ? prev.filter((id) => id !== idNum) : [...prev, idNum]
    );
  }

  function toggleQuickCellSpecialAssignment(assignmentId: number) {
    if (!canEditShifts || quickCellBusy || quickCellLoading || !quickCellData) return;
    const idNum = Number(assignmentId);
    setQuickCellConfirmStep(false);
    setQuickCellError(null);
    setQuickCellKeepSpecialIds((prev) =>
      prev.includes(idNum) ? prev.filter((id) => id !== idNum) : [...prev, idNum]
    );
  }

  // ตรวจสอบเวลาทับซ้อนฝั่ง Client แบบทันที (Half-open [start, end) รวมวันก่อนหน้าและวันถัดไป)
  const quickCellClientConflicts = useMemo(() => {
    if (!quickCellData) return [] as string[];
    const workDate = quickCellData.workDate;
    const selectedTemplates = quickCellData.availableTemplates.filter((t) =>
      quickCellSelectedIds.includes(Number(t.id))
    );
    const keptSpecials = (quickCellData.specialExistingAssignments || []).filter(
      (s) => s.assignmentId !== null && quickCellKeepSpecialIds.includes(Number(s.assignmentId))
    );

    const activeIntervals = [
      ...selectedTemplates.map((t) => ({
        label: `${formatCleanShiftName(t.shiftName)} (${t.startTime}–${t.endTime} น.)`,
        iv: computeClientShiftInterval(workDate, t.startTime, t.endTime, t.isCrossMidnight),
      })),
      ...keptSpecials.map((s) => ({
        label: `${formatCleanShiftName(s.shiftName)} (${s.startTime}–${s.endTime} น.)`,
        iv: computeClientShiftInterval(workDate, s.startTime, s.endTime, s.isCrossMidnight),
      })),
    ];

    const msgs: string[] = [];
    for (let i = 0; i < activeIntervals.length; i++) {
      for (let j = i + 1; j < activeIntervals.length; j++) {
        if (intervalsOverlapHalfOpen(activeIntervals[i].iv, activeIntervals[j].iv)) {
          msgs.push(
            `ช่วงเวลาทับซ้อนภายในวัน: ${activeIntervals[i].label} ทับซ้อนกับ ${activeIntervals[j].label}`
          );
        }
      }
    }
    for (const cur of activeIntervals) {
      for (const prev of quickCellData.carryoverFromPrevDay || []) {
        const prevIv = computeClientShiftInterval(
          prev.workDate,
          prev.startTime,
          prev.endTime,
          prev.isCrossMidnight
        );
        if (intervalsOverlapHalfOpen(cur.iv, prevIv)) {
          msgs.push(
            `เวลาทับซ้อนกับกะข้ามวันจากวันก่อนหน้า: ${cur.label} ทับซ้อนกับ ${formatCleanShiftName(prev.shiftName)} (เริ่ม ${formatThaiDate(prev.workDate)} ${prev.startTime}–${prev.endTime} น.)`
          );
        }
      }
      for (const nxt of quickCellData.nextDayShifts || []) {
        const nxtIv = computeClientShiftInterval(
          nxt.workDate,
          nxt.startTime,
          nxt.endTime,
          nxt.isCrossMidnight
        );
        if (intervalsOverlapHalfOpen(cur.iv, nxtIv)) {
          msgs.push(
            `เวลาทับซ้อนกับกะของวันถัดไป: ${cur.label} ทับซ้อนกับ ${formatCleanShiftName(nxt.shiftName)} (${formatThaiDate(nxt.workDate)} ${nxt.startTime}–${nxt.endTime} น.)`
          );
        }
      }
    }
    return msgs;
  }, [quickCellData, quickCellSelectedIds, quickCellKeepSpecialIds]);

  // เรียก Backend Synchronize Preview ทุกครั้งที่ Checkbox เปลี่ยน เพื่อตรวจสอบ Conflict และ Diff ที่แม่นยำ 100%
  useEffect(() => {
    if (!quickCellTarget || !quickCellData || quickCellLoading || !canEditShifts) {
      setQuickCellPreview(null);
      setQuickCellPreviewLoading(false);
      return;
    }

    let cancelled = false;
    setQuickCellPreviewLoading(true);

    apiRequest('/shift-assignments/daily-cell-sync-preview', {
      method: 'POST',
      body: JSON.stringify({
        personId: quickCellData.person.person_id,
        workDate: quickCellData.workDate,
        selectedTemplateIds: quickCellSelectedIds,
        keepSpecialAssignmentIds: quickCellKeepSpecialIds,
      }),
    })
      .then((res) => {
        if (!cancelled) {
          setQuickCellPreview(res);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setQuickCellPreview(null);
          if (err instanceof ApiClientError) {
            setQuickCellError(err.message);
          } else {
            setQuickCellError('ไม่สามารถตรวจสอบสรุปการเปลี่ยนแปลงและความทับซ้อนของกะได้');
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setQuickCellPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    quickCellTarget,
    quickCellData,
    quickCellLoading,
    quickCellSelectedIds,
    quickCellKeepSpecialIds,
    canEditShifts,
  ]);

  // กด "ยืนยันบันทึก" -> ซิงค์ Selected Shifts เป็นสถานะสุดท้ายของวันใน Transaction เดียว (ป้องกัน Double Submit)
  async function handleConfirmQuickCellSync() {
    if (!quickCellTarget || !quickCellData || !canEditShifts) return;
    if (quickCellSubmitLockRef.current || quickCellBusy) return;
    if (quickCellLoadError) return;
    if (quickCellClientConflicts.length > 0 || (quickCellPreview && !quickCellPreview.canProceed)) {
      setQuickCellError('พบช่วงเวลาทับซ้อน ไม่สามารถบันทึกได้');
      return;
    }

    quickCellSubmitLockRef.current = true;
    setQuickCellBusy(true);
    setQuickCellError(null);
    setError(null);
    try {
      const res = await apiRequest('/shift-assignments/daily-cell-sync', {
        method: 'POST',
        body: JSON.stringify({
          personId: quickCellData.person.person_id,
          workDate: quickCellData.workDate,
          selectedTemplateIds: quickCellSelectedIds,
          keepSpecialAssignmentIds: quickCellKeepSpecialIds,
          reason: quickCellReason.trim() || undefined,
        }),
      });
      setNotice(res.message || 'บันทึกตารางเวรสำเร็จ');
      // ปิด Modal และรีเฟรชตารางเวรทันทีเมื่อบันทึกสำเร็จ
      quickCellLoadSeqRef.current += 1;
      setQuickCellTarget(null);
      setQuickCellData(null);
      setQuickCellSelectedIds([]);
      setQuickCellKeepSpecialIds([]);
      setQuickCellPreview(null);
      setQuickCellConfirmStep(false);
      setQuickCellReason('');
      await loadData();
    } catch (err) {
      // บันทึกไม่สำเร็จ: ไม่ปิด Modal, รักษาค่าที่ผู้ใช้เลือกไว้เพื่อแก้ไข, ไม่แสดงข้อความสำเร็จ
      if (err instanceof ApiClientError) {
        setQuickCellError(err.message);
        setError({ code: err.code, message: err.message, requestId: err.requestId });
      } else {
        setQuickCellError('ไม่สามารถบันทึกตารางเวรได้ กรุณาตรวจสอบและลองใหม่อีกครั้ง');
        setError({ message: 'ไม่สามารถบันทึกตารางเวรได้ กรุณาตรวจสอบและลองใหม่อีกครั้ง' });
      }
      setQuickCellConfirmStep(false);
    } finally {
      quickCellSubmitLockRef.current = false;
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
      const msg = `อัปเดตกฎกะเช้าเริ่มต้นสำหรับ "${editingRule.personnel_type_name}" สำเร็จ`;
      setNotice(msg);
      pushToast('success', 'บันทึกการแก้ไขกฎกะเริ่มต้นสำเร็จ', {
        detail: `อัปเดตประเภทบุคลากร "${editingRule.personnel_type_name}" แล้ว`,
      });
      setEditingRule(null);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
        pushToast('error', 'ไม่สามารถอัปเดตกฎกะเริ่มต้นได้', {
          detail: err.message,
          requestId: err.requestId,
        });
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
      const createdName = newRuleName.trim();
      setNotice(`เพิ่มกฎกะเช้าเริ่มต้นสำหรับประเภทบุคลากร "${createdName}" สำเร็จ`);
      pushToast('success', 'เพิ่มกฎประเภทบุคลากรสำเร็จ', {
        detail: `บันทึก "${createdName}" เรียบร้อยแล้ว`,
      });
      setShowAddRuleForm(false);
      setNewRuleCode('');
      setNewRuleName('');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
        pushToast('error', 'ไม่สามารถเพิ่มกฎประเภทบุคลากรได้', {
          detail: err.message,
          requestId: err.requestId,
        });
      }
    } finally {
      setRuleSaving(false);
    }
  }

  // ยืนยันเปิด/ปิดใช้งานกฎกะเช้าเริ่มต้น
  async function handleConfirmToggleRuleActive() {
    if (!confirmToggleRuleTarget || toggleRuleBusy) return;
    const rule = confirmToggleRuleTarget;
    setToggleRuleBusy(true);
    try {
      const nextActive = Number(rule.is_active ?? 1) !== 1;
      await apiRequest(`/personnel-type-rules/${rule.id}/toggle`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextActive }),
      });
      const statusText = nextActive ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
      setConfirmToggleRuleTarget(null);
      setNotice(`${statusText}กฎกะเช้าเริ่มต้นของ "${rule.personnel_type_name}" สำเร็จ`);
      pushToast('success', `${statusText}กฎประเภทบุคลากรสำเร็จ`, {
        detail: rule.personnel_type_name,
      });
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message, requestId: err.requestId });
        pushToast('error', 'ไม่สามารถปรับสถานะกฎประเภทบุคลากรได้', {
          detail: err.message,
          requestId: err.requestId,
        });
      }
    } finally {
      setToggleRuleBusy(false);
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

  // แม่แบบกะที่เปิดใช้งานและสามารถเลือกได้จริงจาก Backend
  const selectableShiftTemplates = useMemo(
    () => shifts.filter((s) => s.is_active === undefined || Number(s.is_active) === 1),
    [shifts]
  );

  // แม่แบบกะที่กำลังเลือกอยู่ในหน้าจัดเวร (อ้างอิงด้วย Shift Template ID เสมอ)
  const selectedShiftTemplates = useMemo(
    () => selectableShiftTemplates.filter((s) => selectedShiftIds.includes(Number(s.id))),
    [selectableShiftTemplates, selectedShiftIds]
  );

  // ตรวจสอบทุกคู่แม่แบบกะที่เลือกพร้อมกันว่ามีช่วงเวลาทับซ้อนกันหรือไม่ (ทั้งในวันเดียวกันและกะข้ามวันต่อวันถัดไป ตามหลักการ [start, end))
  const clientShiftOverlaps = useMemo(() => {
    if (bulkOperationMode !== 'ADD_SHIFTS' && bulkOperationMode !== 'REPLACE_SHIFTS') {
      return [];
    }
    return findAllClientSelectedShiftsOverlaps(selectedShiftTemplates, effectiveSelectedDates);
  }, [selectedShiftTemplates, effectiveSelectedDates, bulkOperationMode]);

  const hasSameDayClientShiftOverlap = useMemo(
    () => clientShiftOverlaps.some((o) => o.kind === 'SAME_DAY'),
    [clientShiftOverlaps]
  );

  const overlappingShiftIdSet = useMemo(() => {
    const ids = new Set<number>();
    for (const o of clientShiftOverlaps) {
      ids.add(o.shiftAId);
      ids.add(o.shiftBId);
    }
    return ids;
  }, [clientShiftOverlaps]);

  // บุคลากรที่กรองในหน้า "จัดเวร / เพิ่มเวรใหม่" (ไม่ล้างรายการที่เลือกไว้เมื่อเปลี่ยนตัวกรองหรือคำค้นหา)
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

  // รหัสบุคลากรทั้งหมดที่ตรงกับตัวกรองปัจจุบัน (ใช้สำหรับ Checkbox เลือกทั้งหมดแบบ 3 สถานะ)
  const assignFilteredPersonIds = useMemo(
    () => assignFilteredPersonnel.map((p) => String(p.person_id).trim()).filter(Boolean),
    [assignFilteredPersonnel]
  );

  const filteredPersonSelectionMeta = useMemo(
    () => computeFilteredSelectionState(assignFilteredPersonIds, selectedPersonIds),
    [assignFilteredPersonIds, selectedPersonIds]
  );

  // ซิงค์สถานะ indeterminate ของ Checkbox เลือกทั้งหมดที่หัวรายการบุคลากร
  useEffect(() => {
    if (selectAllFilteredCheckboxRef.current) {
      selectAllFilteredCheckboxRef.current.indeterminate =
        filteredPersonSelectionMeta.state === 'indeterminate';
    }
  }, [filteredPersonSelectionMeta.state, assignMethod, activeTab]);

  // จำกัดจำนวนแถวที่ Render ในกล่องเลือกบุคลากรเพื่อป้องกันหน้าจอกระตุกเมื่อมีบุคลากรหลายร้อยคน
  const visibleAssignPersonnel = useMemo(
    () => assignFilteredPersonnel.slice(0, assignPersonnelRenderLimit),
    [assignFilteredPersonnel, assignPersonnelRenderLimit]
  );

  // รายชื่อบุคลากรที่ถูกเลือกไว้แล้วสำหรับแสดงในส่วนสรุป (ไม่ซ้ำตาม Personnel ID)
  const selectedPersonnelObjects = useMemo(() => {
    const uniqueIds = Array.from(
      new Set(selectedPersonIds.map((pid) => String(pid).trim()).filter(Boolean))
    );
    return uniqueIds.map((pid) => {
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
    setConfirmBulkModalOpen(false);
  }, [selectedPersonIds, selectedShiftIds, effectiveSelectedDates, assignMethod, bulkOperationMode]);

  function toggleAssignShiftId(shiftId: number) {
    const idNum = Number(shiftId);
    setSelectedShiftIds((prev) =>
      prev.includes(idNum) ? prev.filter((id) => id !== idNum) : [...prev, idNum]
    );
  }

  function selectAllAssignShifts() {
    setSelectedShiftIds(selectableShiftTemplates.map((s) => Number(s.id)));
  }

  function clearSelectedShifts() {
    setSelectedShiftIds([]);
  }

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
    operationMode?: BulkOperationMode;
  }) {
    setPreviewData(null);
    setPreviewError(null);
    setPreviewFilterTab('ALL');
    setConfirmBulkModalOpen(false);
    setConfirmClearPersonsOpen(false);
    setShowAllSelectedPersonChips(false);
    setBulkOperationMode(preset?.operationMode || 'ADD_SHIFTS');
    setBulkActionReason('');

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
      setSelectedShiftIds([Number(preset.shiftId)]);
    } else if (selectedShiftIds.length === 0 && shifts.length > 0) {
      setSelectedShiftIds([Number(shifts[0].id)]);
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
    if (!pid) return;
    if (assignMethod === 'SINGLE_PERSON') {
      setSelectedPersonIds((prev) => (prev.includes(pid) ? [] : [pid]));
      return;
    }
    setSelectedPersonIds((prev) =>
      prev.includes(pid) ? prev.filter((id) => id !== pid) : Array.from(new Set([...prev, pid]))
    );
  }

  function handleToggleSelectAllFilteredPersons() {
    if (assignMethod !== 'MULTI_PERSON' || assignFilteredPersonIds.length === 0) {
      return;
    }
    setSelectedPersonIds((prev) => toggleSelectAllFiltered(assignFilteredPersonIds, prev));
  }

  function handleRequestClearSelectedPersons() {
    if (selectedPersonIds.length === 0) return;
    // ป้องกันการกดล้างรายชื่อผิดพลาดเมื่อเลือกบุคลากรไว้จำนวนมาก
    if (selectedPersonIds.length >= 10) {
      setConfirmClearPersonsOpen(true);
      return;
    }
    setSelectedPersonIds([]);
    setShowAllSelectedPersonChips(false);
  }

  function confirmClearAllSelectedPersons() {
    setSelectedPersonIds([]);
    setConfirmClearPersonsOpen(false);
    setShowAllSelectedPersonChips(false);
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

  // เรียก API ตรวจสอบ Preview & ความขัดแย้ง (รองรับหลายกะและทุกโหมดการทำงาน)
  async function handleRunConflictPreview() {
    if (selectedPersonIds.length === 0) {
      setPreviewError({
        code: 'NO_PERSON_SELECTED',
        message: 'กรุณาเลือกบุคลากรอย่างน้อย 1 คนก่อนกดตรวจสอบ Preview',
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
    if (bulkOperationMode !== 'CLEAR_ALL_SHIFTS' && selectedShiftIds.length === 0) {
      setPreviewError({
        code: 'NO_SHIFT_SELECTED',
        message: 'กรุณาเลือกแม่แบบกะทำงานอย่างน้อย 1 กะในขั้นตอนที่ 1',
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
          shiftIds: bulkOperationMode === 'CLEAR_ALL_SHIFTS' ? [] : selectedShiftIds,
          workDates: effectiveSelectedDates,
          operationMode: bulkOperationMode,
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

  // กดปุ่มยืนยันบันทึก: หากเป็นการแทนที่/ลบกะเดิม จะเปิดหน้าต่างยืนยันชัดเจนก่อนเสมอ
  function handleRequestConfirmBulkAssign() {
    if (!previewData || previewError) {
      return;
    }

    if (
      (bulkOperationMode === 'ADD_SHIFTS' || bulkOperationMode === 'REPLACE_SHIFTS') &&
      conflictStrategy === 'ABORT_ON_CONFLICT' &&
      previewData.summary.conflictCount > 0
    ) {
      setPreviewError({
        code: 'CONFLICT_ABORT_POLICY',
        message: `พบรายการที่มีเวรอยู่แล้วหรือเวลาทับซ้อน ${previewData.summary.conflictCount} รายการ กรุณาเปลี่ยนนโยบายเป็น "ข้ามเฉพาะรายการที่ขัดแย้ง" หรือปรับกะ/วันที่ใหม่`,
      });
      return;
    }

    if (previewData.summary.readyCount === 0) {
      setPreviewError({
        code: 'NO_READY_ITEMS',
        message:
          bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
            ? 'ไม่พบกะที่เลือกในวันที่และบุคลากรที่ระบุ จึงไม่มีรายการที่ต้องลบ'
            : 'ไม่มีรายการตารางเวรที่สามารถดำเนินการได้ (ทุกรายการมีเวรอยู่แล้วหรือเวลาทับซ้อน)',
      });
      return;
    }

    // ห้ามเปลี่ยน แทนที่ หรือลบกะเดิมโดยไม่ได้รับการยืนยันอย่างชัดเจน
    if (bulkOperationMode !== 'ADD_SHIFTS') {
      setConfirmBulkModalOpen(true);
      return;
    }

    void executeBulkAssign(true);
  }

  // บันทึกการดำเนินการจริงไปยัง Backend (Transactional)
  async function executeBulkAssign(confirmAction: boolean) {
    if (!previewData || previewError) {
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
          shiftIds: bulkOperationMode === 'CLEAR_ALL_SHIFTS' ? [] : selectedShiftIds,
          workDates: effectiveSelectedDates,
          operationMode: bulkOperationMode,
          conflictStrategy,
          confirmAction,
          reason: bulkActionReason.trim() || undefined,
        }),
      });

      const inserted = Number(res.insertedCount || 0);
      const cancelled = Number(res.cancelledCount || 0);
      const clearedCells = Number(res.clearedCellsCount || 0);
      const skipped = Number(res.skippedConflictCount || 0);

      if (bulkOperationMode === 'CLEAR_ALL_SHIFTS') {
        setNotice(
          `ลบกะทั้งหมดสำเร็จ ${clearedCells} วัน-คน (ยกเลิกกะเดิม ${cancelled} รายการ และคงสถานะ “ไม่มีเวร” ไว้ไม่สร้างกะกลับมาอัตโนมัติ)`
        );
      } else if (bulkOperationMode === 'REMOVE_SELECTED_SHIFTS') {
        setNotice(
          clearedCells > 0
            ? `ลบกะที่เลือกสำเร็จ ${cancelled} รายการ (วันที่ไม่มีกะเหลืออีก ${clearedCells} วัน-คน ถูกคงสถานะ “ไม่มีเวร” ไว้)`
            : `ลบกะที่เลือกสำเร็จ ${cancelled} รายการ`
        );
      } else if (bulkOperationMode === 'REPLACE_SHIFTS') {
        setNotice(
          `แทนที่กะเดิมสำเร็จ: ยกเลิกกะเดิม ${cancelled} รายการ และบันทึกกะใหม่ ${inserted} รายการ${
            skipped > 0 ? ` (ข้ามรายการเวลาทับซ้อนกับวันข้างเคียง ${skipped} รายการ)` : ''
          }`
        );
      } else {
        setNotice(
          skipped > 0
            ? `บันทึกเพิ่มตารางเวรสำเร็จ ${inserted} รายการ (ข้ามรายการที่มีเวรอยู่แล้วหรือเวลาทับซ้อน ${skipped} รายการ โดยไม่ลบหรือทับเวรเดิม)`
            : `บันทึกเพิ่มตารางเวรสำเร็จ ${inserted} รายการ`
        );
      }

      setConfirmBulkModalOpen(false);
      setPreviewData(null);
      setActiveTab('ROSTER');
      await loadData();
    } catch (err) {
      setConfirmBulkModalOpen(false);
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

  // แผนที่ค้นหาการผูกกะเริ่มต้นจากฐานข้อมูลจริงตาม personnelTypeCode (เฉพาะรายการที่มี defaultShiftId จริงเท่านั้น)
  const defaultBindingByTypeCode = useMemo(() => {
    const map = new Map<string, ActiveDefaultBindingInfo>();
    for (const b of defaultBindings) {
      const code = String(b.personnelTypeCode || b.personnel_type_code || '')
        .trim()
        .toUpperCase();
      const shiftIdRaw = b.defaultShiftId ?? b.shift_id;
      if (!code || shiftIdRaw == null || Number(shiftIdRaw) <= 0) continue;
      map.set(code, {
        personnelTypeCode: code,
        personnelTypeName: String(b.personnelTypeName || b.personnel_type_name || code),
        shiftId: Number(shiftIdRaw),
        shiftCode: String(b.defaultShiftCode || b.shift_code || ''),
        shiftName: String(b.defaultShiftName || b.shift_name || ''),
        startTime: String(b.defaultStartTime || b.start_time || ''),
        endTime: String(b.defaultEndTime || b.end_time || ''),
      });
    }
    return map;
  }, [defaultBindings]);

  // เปิด Modal สร้างแม่แบบกะทำงานใหม่
  function openCreateShiftModal() {
    setError(null);
    setTemplateModalState({
      open: true,
      mode: 'create',
      shift: null,
    });
  }

  // เปิด Modal แก้ไขแม่แบบกะทำงาน (ใช้ Modal เดียวกับสร้างใหม่พร้อมข้อมูลเดิม)
  function openEditShiftModal(shiftRow: any) {
    setError(null);
    setTemplateModalState({
      open: true,
      mode: 'edit',
      shift: shiftRow,
    });
  }

  // บันทึกแม่แบบกะสำเร็จจาก ShiftTemplateModal -> ปิด Modal, Refresh จาก API จริง, แสดง Success Toast 4 วินาที
  async function handleTemplateModalSaved(summary: {
    mode: ShiftTemplateModalMode;
    shiftName: string;
    shiftCode: string;
    isDefaultBound: boolean;
  }) {
    setTemplateModalState({ open: false, mode: 'create', shift: null });
    setError(null);
    if (summary.mode === 'create') {
      pushToast('success', 'บันทึกแม่แบบกะทำงานสำเร็จ', {
        detail: summary.isDefaultBound
          ? `เพิ่มแม่แบบกะ "${summary.shiftName}" (${summary.shiftCode}) และกำหนดเป็นกะเริ่มต้นเรียบร้อยแล้ว`
          : `เพิ่มแม่แบบกะ "${summary.shiftName}" (${summary.shiftCode}) เรียบร้อยแล้ว`,
      });
    } else {
      pushToast('success', 'บันทึกการแก้ไขแม่แบบกะทำงานสำเร็จ', {
        detail: `อัปเดต "${summary.shiftName}" (${summary.shiftCode}) เรียบร้อยแล้ว (ไม่กระทบตารางเวรย้อนหลัง)`,
      });
    }
    await loadData();
  }

  // กดปุ่มเปิด/ปิดใช้งานแม่แบบกะทำงาน -> แสดง Confirmation Dialog ก่อนเสมอ
  function handleRequestToggleShiftActive(shiftRow: any) {
    const isCurrentlyActive = Number(shiftRow.is_active ?? 1) === 1;
    const defaultTypes = Array.isArray(shiftRow.default_personnel_types)
      ? shiftRow.default_personnel_types
      : [];
    const isBoundDefault = Number(shiftRow.is_default ?? 0) === 1 && defaultTypes.length > 0;

    if (isCurrentlyActive && isBoundDefault) {
      const boundNames = defaultTypes
        .map((d: any) => d.personnelTypeName || d.personnel_type_name || d.personnelTypeCode)
        .join(', ');
      pushToast('warning', 'ไม่สามารถปิดใช้งานแม่แบบกะนี้ได้', {
        detail: `"${formatCleanShiftName(shiftRow.shift_name)}" กำลังถูกใช้เป็นกะเริ่มต้นของ ${boundNames} กรุณาเปลี่ยนหรือยกเลิกกะเริ่มต้นก่อนปิดใช้งาน`,
      });
      return;
    }

    setConfirmToggleShiftTarget(shiftRow);
  }

  // ยืนยันการเปิด/ปิดใช้งานแม่แบบกะทำงานผ่าน PUT /api/Sam_Att/shifts/:id
  async function handleConfirmToggleShiftActive() {
    if (!confirmToggleShiftTarget || toggleShiftBusy) return;
    const target = confirmToggleShiftTarget;
    const nextActive = Number(target.is_active ?? 1) !== 1;
    const cleanName = formatCleanShiftName(target.shift_name);

    setToggleShiftBusy(true);
    setError(null);
    try {
      await apiRequest(`/shifts/${target.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          shiftCode: String(target.shift_code || ''),
          shiftName: cleanName,
          shiftCategory: String(target.shift_category || 'OFFICIAL'),
          startTime: String(target.start_time || '08:00'),
          endTime: String(target.end_time || '16:00'),
          graceMinutes: Number(target.grace_minutes ?? 15),
          cutoffTime: String(target.cutoff_time || '10:30'),
          isActive: nextActive,
        }),
      });
      setConfirmToggleShiftTarget(null);
      pushToast(
        'success',
        nextActive ? 'เปิดใช้งานแม่แบบกะทำงานสำเร็จ' : 'ปิดใช้งานแม่แบบกะทำงานสำเร็จ',
        {
          detail: `${cleanName} (${target.shift_code})`,
        }
      );
      await loadData();
    } catch (err) {
      setConfirmToggleShiftTarget(null);
      if (err instanceof ApiClientError) {
        pushToast('error', 'ไม่สามารถเปลี่ยนสถานะแม่แบบกะทำงานได้', {
          detail: err.message,
          requestId: err.requestId,
        });
      } else {
        pushToast('error', 'ไม่สามารถเปลี่ยนสถานะแม่แบบกะทำงานได้', {
          detail: 'กรุณาตรวจสอบการเชื่อมต่อแล้วลองใหม่อีกครั้ง',
        });
      }
    } finally {
      setToggleShiftBusy(false);
    }
  }

  // เปิดหน้าต่างเปลี่ยนกะเริ่มต้นแบบ Explicit พร้อมตรวจสอบสิทธิ์และบันทึก Audit Log
  function openChangeDefaultModal(options?: { scopeCode?: string; shiftId?: number }) {
    const defaultScope =
      options?.scopeCode ||
      (personnelTypeRules[0]?.personnel_type_code
        ? String(personnelTypeRules[0].personnel_type_code)
        : '');
    const activeShiftsList = shifts.filter((s) => Number(s.is_active ?? 1) === 1);
    const defaultShiftId =
      options?.shiftId != null
        ? String(options.shiftId)
        : activeShiftsList[0]?.id != null
          ? String(activeShiftsList[0].id)
          : '';
    setChangeDefaultScopeCode(String(defaultScope).trim().toUpperCase());
    setChangeDefaultSelectedShiftId(defaultShiftId);
    setChangeDefaultReason('');
    setChangeDefaultError(null);
    setConfirmChangeDefaultPayload(null);
    setChangeDefaultModalOpen(true);
  }

  async function executeChangeDefault(scopeCode: string, nextShiftId: number) {
    setChangeDefaultError(null);
    setError(null);
    setNotice(null);
    setChangeDefaultSaving(true);
    try {
      const res = await apiRequest(`/shifts/${nextShiftId}/set-default`, {
        method: 'POST',
        body: JSON.stringify({
          personnelTypeCode: scopeCode,
          reason: changeDefaultReason.trim() || undefined,
        }),
      });
      setConfirmChangeDefaultPayload(null);
      setChangeDefaultModalOpen(false);
      pushToast('success', 'บันทึกกะเริ่มต้นสำเร็จ', {
        detail:
          res?.message ||
          'เปลี่ยนกะเริ่มต้นเรียบร้อยแล้ว (บันทึก Audit Log และไม่กระทบตารางเวรย้อนหลัง)',
      });
      await loadData();
    } catch (err) {
      setConfirmChangeDefaultPayload(null);
      if (err instanceof ApiClientError) {
        setChangeDefaultError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
        pushToast('error', 'ไม่สามารถเปลี่ยนกะเริ่มต้นได้', {
          detail: err.message,
          requestId: err.requestId,
        });
      } else {
        setChangeDefaultError({ message: 'ไม่สามารถเปลี่ยนกะเริ่มต้นได้ กรุณาลองใหม่อีกครั้ง' });
        pushToast('error', 'ไม่สามารถเปลี่ยนกะเริ่มต้นได้', {
          detail: 'กรุณาลองใหม่อีกครั้ง',
        });
      }
    } finally {
      setChangeDefaultSaving(false);
    }
  }

  async function handleSubmitChangeDefault(e: React.FormEvent) {
    e.preventDefault();
    if (!changeDefaultScopeCode || !changeDefaultSelectedShiftId) {
      setChangeDefaultError({
        code: 'INVALID_INPUT',
        message: 'กรุณาเลือกประเภทบุคลากรและแม่แบบกะทำงานที่ต้องการกำหนดเป็นกะเริ่มต้น',
      });
      return;
    }

    const nextShiftId = Number(changeDefaultSelectedShiftId);
    const currentBinding = defaultBindingByTypeCode.get(changeDefaultScopeCode) || null;
    const selectedShiftRow = shifts.find((s) => Number(s.id) === nextShiftId);
    const currentRule = personnelTypeRules.find(
      (r) => String(r.personnel_type_code || '').trim().toUpperCase() === changeDefaultScopeCode
    );

    if (currentBinding && Number(currentBinding.shiftId) === nextShiftId) {
      setChangeDefaultError({
        code: 'NO_CHANGE',
        message: `แม่แบบกะ "${formatCleanShiftName(currentBinding.shiftName)}" เป็นกะเริ่มต้นของประเภทนี้อยู่แล้ว`,
      });
      return;
    }

    // หากประเภทบุคลากรนี้มีกะเริ่มต้นเดิมอยู่แล้ว ให้แสดงหน้าต่างยืนยันชื่อกะเดิมและกะใหม่ก่อนเสมอ
    if (currentBinding && selectedShiftRow) {
      setConfirmChangeDefaultPayload({
        scopeCode: changeDefaultScopeCode,
        scopeName: String(currentRule?.personnel_type_name || changeDefaultScopeCode),
        previousShiftName: formatCleanShiftName(currentBinding.shiftName),
        previousShiftCode: currentBinding.shiftCode,
        nextShiftId,
        nextShiftName: formatCleanShiftName(selectedShiftRow.shift_name),
        nextShiftCode: String(selectedShiftRow.shift_code || ''),
      });
      return;
    }

    await executeChangeDefault(changeDefaultScopeCode, nextShiftId);
  }

  async function handleConfirmClearDefault() {
    if (!confirmClearDefaultScope) return;
    setChangeDefaultError(null);
    setError(null);
    setNotice(null);
    setChangeDefaultSaving(true);
    try {
      const res = await apiRequest(
        `/shifts/default/${encodeURIComponent(confirmClearDefaultScope.personnelTypeCode)}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            reason: changeDefaultReason.trim() || 'ยกเลิกการผูกกะเริ่มต้นจากหน้าแม่แบบกะทำงาน',
          }),
        }
      );
      setConfirmClearDefaultScope(null);
      setChangeDefaultModalOpen(false);
      pushToast('success', 'ยกเลิกการผูกกะเริ่มต้นสำเร็จ', {
        detail: res?.message || 'ยกเลิกกะเริ่มต้นของประเภทบุคลากรเรียบร้อยแล้ว',
      });
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setChangeDefaultError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
        pushToast('error', 'ไม่สามารถยกเลิกการผูกกะเริ่มต้นได้', {
          detail: err.message,
          requestId: err.requestId,
        });
      }
      setConfirmClearDefaultScope(null);
    } finally {
      setChangeDefaultSaving(false);
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
      const cancelSummary = `ยกเลิกเวรของ ${cancelTarget.full_name} วันที่ ${formatThaiDate(cancelTarget.work_date)} เรียบร้อยแล้ว`;
      setNotice(`${cancelSummary} (บันทึกประวัติการตรวจสอบ)`);
      pushToast('success', 'ยกเลิกเวรปฏิบัติงานสำเร็จ', {
        detail: cancelSummary,
      });
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
        pushToast('error', 'ไม่สามารถยกเลิกเวรปฏิบัติงานได้', {
          detail: err.message,
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
      {/* ระบบแจ้งเตือน Toast มาตรฐานมุมขวาบน */}
      <FloatingToastStack toasts={toasts} onDismiss={dismissToast} />

      {/* =====================================================================
          ส่วนหัวหลักของโมดูล (Modern HIS PageHeader — ไม่บีบหัวข้อเมื่อมีหลายปุ่ม)
         ===================================================================== */}
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="ตารางเวรและแม่แบบกะทำงาน"
        subtitle="จัดตารางเวรรายเดือนและรายสัปดาห์ เพิ่มเวรรายบุคคลหรือหลายคนพร้อมตรวจสอบความซ้ำซ้อนก่อนบันทึกจริง"
        meta={
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[#777287]">
            <span>รอบเดือนปัจจุบัน:</span>
            <span className="font-semibold text-[#4E3978]">{formatThaiMonthTitle(selectedMonth)}</span>
            <span className="text-[#D8D1E6]" aria-hidden="true">·</span>
            <span className="tabular-nums">
              บุคลากรที่แสดง <strong className="text-[#292638]">{filteredPersonnelForRoster.length}</strong> คน
            </span>
          </div>
        }
        actions={
          <>
            <PageHelpAction
              guideKey="shifts"
              activeTabKey={activeTab}
              userRole={userRole}
              onNavigate={onNavigate}
              compact
            />
            {activeTab === 'ASSIGN_WORKSPACE' ? (
              <button
                type="button"
                onClick={() => setActiveTab('ROSTER')}
                className="ent-btn-secondary whitespace-nowrap"
              >
                <ArrowLeft className="w-4 h-4 text-[#777287]" />
                <span>กลับไปหน้าตารางเวร</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleDownloadExcelTemplate}
                  className="ent-btn-secondary text-[13px] whitespace-nowrap"
                >
                  <Download className="w-4 h-4 text-[#8066B5]" />
                  <span>ดาวน์โหลด Template Excel</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setExcelPreview(null);
                    setExcelError(null);
                    setShowExcelImportModal(true);
                  }}
                  className="ent-btn-soft text-[13px] whitespace-nowrap"
                >
                  <Upload className="w-4 h-4 text-[#8066B5]" />
                  <span>นำเข้าตารางเวรจาก Excel</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    openAssignWorkspace({
                      method: 'SINGLE_PERSON',
                    })
                  }
                  className="ent-btn-soft text-[13px] whitespace-nowrap"
                >
                  <User className="w-4 h-4 text-[#8066B5]" />
                  <span>เพิ่มเวรรายบุคคล (1 คน)</span>
                </button>

                <button
                  type="button"
                  onClick={() =>
                    openAssignWorkspace({
                      method: 'MULTI_PERSON',
                    })
                  }
                  className="ent-btn-primary whitespace-nowrap"
                >
                  <Users className="w-4 h-4" />
                  <span>เพิ่มเวรหลายคนพร้อมกัน</span>
                </button>
              </>
            )}
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* =====================================================================
          แถบนำทางหลัก 3 หน้าจอ (Modern HIS Underline TabBar + View Switcher)
         ===================================================================== */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-3 border-b border-[#E8E4EF]">
        <TabBar
          variant="underline"
          activeKey={activeTab}
          onChange={(key) => {
            if (key === 'ASSIGN_WORKSPACE') {
              if (activeTab !== 'ASSIGN_WORKSPACE') {
                openAssignWorkspace({ method: assignMethod });
              }
            } else {
              setActiveTab(key as WorkspaceTabKey);
            }
          }}
          items={[
            {
              key: 'ROSTER',
              label: '1. ตารางเวรปฏิบัติงาน',
              count: activeCountInMonth,
              icon: <Calendar className="w-4 h-4" />,
            },
            {
              key: 'ASSIGN_WORKSPACE',
              label: '2. จัดเวร / เพิ่มเวรใหม่',
              icon: <Plus className="w-4 h-4" />,
            },
            {
              key: 'TEMPLATES',
              label: '3. แม่แบบกะทำงาน',
              count: shifts.length,
              icon: <Clock className="w-4 h-4" />,
            },
          ]}
        />

        {/* สลับมุมมองภายในหน้าตารางเวร: รายเดือน | รายสัปดาห์ | รายการ */}
        {activeTab === 'ROSTER' && (
          <div className="ent-tab-bar self-start lg:self-auto mb-2">
            <button
              type="button"
              onClick={() => setRosterViewMode('MONTHLY_GRID')}
              className={`ent-tab-btn text-[13px] ${
                rosterViewMode === 'MONTHLY_GRID' ? 'ent-tab-btn-active' : ''
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>ตารางรายเดือน</span>
            </button>

            <button
              type="button"
              onClick={() => setRosterViewMode('WEEKLY_GRID')}
              className={`ent-tab-btn text-[13px] ${
                rosterViewMode === 'WEEKLY_GRID' ? 'ent-tab-btn-active' : ''
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              <span>ตารางรายสัปดาห์</span>
            </button>

            <button
              type="button"
              onClick={() => setRosterViewMode('DETAIL_LIST')}
              className={`ent-tab-btn text-[13px] ${
                rosterViewMode === 'DETAIL_LIST' ? 'ent-tab-btn-active' : ''
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>มุมมองรายการ ({filteredAssignments.length})</span>
            </button>
          </div>
        )}
      </div>

      {/* แถบสรุปภาพรวมตารางเวรรายเดือน (Unified MetricStrip) */}
      {activeTab === 'ROSTER' && (
        <MetricStrip
          items={[
            {
              label: 'เวรที่จัดในเดือนนี้',
              value: `${activeCountInMonth.toLocaleString('th-TH')} เวร`,
              subtext: `รอบเดือน ${formatThaiMonthTitle(selectedMonth)}`,
              tone: 'primary',
            },
            {
              label: 'บุคลากรที่แสดงในตาราง',
              value: `${filteredPersonnelForRoster.length.toLocaleString('th-TH')} คน`,
              subtext: departmentFilter === 'ALL' ? 'ทุกกลุ่มงาน / หน่วยงาน' : departmentFilter,
            },
            {
              label: 'เวรข้ามเที่ยงคืน (+1 วัน)',
              value: `${crossMidnightCountInMonth.toLocaleString('th-TH')} เวร`,
              subtext: 'กะดึก / กะพิเศษข้ามวัน',
              tone: crossMidnightCountInMonth > 0 ? 'info' : 'neutral',
            },
            {
              label: 'แม่แบบกะที่พร้อมใช้',
              value: `${shifts.length.toLocaleString('th-TH')} แม่แบบ`,
              subtext: 'คลิกแท็บแม่แบบกะเพื่อปรับแต่ง',
            },
          ]}
        />
      )}

      {/* =====================================================================
          หน้าจอที่ 1: ตารางเวรปฏิบัติงาน (FULL-PAGE SCHEDULE MANAGEMENT)
         ===================================================================== */}
      {activeTab === 'ROSTER' && (
        <div className="space-y-4">
          {/* แถบเลือกเดือน/ปี พ.ศ. และตัวกรองตารางเวร */}
          <div className="bg-white border border-[#E8E4EF] rounded-xl p-4 space-y-3.5">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              {/* เลือกเดือนและปี พ.ศ. ได้ง่ายโดยตรง */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center bg-[#F1ECFA] border border-[#E8E4EF] rounded-lg p-1 gap-1">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedMonth((m) => shiftMonthString(m, -1));
                      setRosterPersonPage(1);
                    }}
                    className="h-8 px-2.5 rounded-md text-[#4E3978] hover:bg-white transition-colors inline-flex items-center gap-1 text-[12.5px] font-semibold"
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
                    className="h-8 px-2.5 rounded-md bg-white border border-[#E8E4EF] text-[13.5px] font-bold text-violet-950 focus:outline-none focus:border-[#8066B5]"
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
                    className="h-8 px-2.5 rounded-md bg-white border border-[#E8E4EF] text-[13.5px] font-bold text-violet-950 font-mono tabular-nums focus:outline-none focus:border-[#8066B5]"
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
                    className="h-8 px-2.5 rounded-md text-[#4E3978] hover:bg-white transition-colors inline-flex items-center gap-1 text-[12.5px] font-semibold"
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
                    className="h-9 px-3 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] text-[12.5px] font-semibold text-[#292638] whitespace-nowrap"
                  >
                    กลับมาเดือนปัจจุบัน
                  </button>
                )}

                <div className="text-[13px] text-[#777287] flex items-center gap-1.5 flex-wrap pl-1">
                  <span>บุคลากรที่แสดง {filteredPersonnelForRoster.length} คน</span>
                  <span aria-hidden="true">·</span>
                  <span>เวรทั้งหมดในเดือน {activeCountInMonth} เวร</span>
                  <span aria-hidden="true">·</span>
                  <span>เวรข้ามวัน {crossMidnightCountInMonth} เวร</span>
                </div>
              </div>

              {/* ตัวเลือกช่วงวันที่สำหรับตารางรายเดือน หรือเลือกสัปดาห์สำหรับตารางรายสัปดาห์ */}
              {rosterViewMode === 'MONTHLY_GRID' && (
                <div className="inline-flex items-center p-1 bg-[#F1ECFA] border border-[#E8E4EF] rounded-lg self-start xl:self-auto">
                  <button
                    type="button"
                    onClick={() => setDayRangeMode('ALL')}
                    className={`px-3 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                      dayRangeMode === 'ALL'
                        ? 'bg-white text-[#4E3978] font-semibold shadow-2xs'
                        : 'text-[#777287] hover:text-[#292638]'
                    }`}
                  >
                    ทั้งเดือน (1–{monthBounds.daysInMonth})
                  </button>
                  <button
                    type="button"
                    onClick={() => setDayRangeMode('FIRST_HALF')}
                    className={`px-3 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                      dayRangeMode === 'FIRST_HALF'
                        ? 'bg-white text-[#4E3978] font-semibold shadow-2xs'
                        : 'text-[#777287] hover:text-[#292638]'
                    }`}
                  >
                    ครึ่งเดือนแรก (1–15)
                  </button>
                  <button
                    type="button"
                    onClick={() => setDayRangeMode('SECOND_HALF')}
                    className={`px-3 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap ${
                      dayRangeMode === 'SECOND_HALF'
                        ? 'bg-white text-[#4E3978] font-semibold shadow-2xs'
                        : 'text-[#777287] hover:text-[#292638]'
                    }`}
                  >
                    ครึ่งเดือนหลัง (16–{monthBounds.daysInMonth})
                  </button>
                </div>
              )}

              {rosterViewMode === 'WEEKLY_GRID' && (
                <div className="inline-flex items-center gap-1.5 bg-[#F1ECFA] border border-[#E8E4EF] rounded-lg p-1 self-start xl:self-auto">
                  <button
                    type="button"
                    disabled={selectedWeekIndex <= 0}
                    onClick={() => setSelectedWeekIndex((w) => Math.max(0, w - 1))}
                    className="h-8 px-2.5 rounded-md text-[#4E3978] hover:bg-white disabled:opacity-40 text-[12.5px] font-semibold inline-flex items-center gap-1"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>สัปดาห์ก่อน</span>
                  </button>
                  <select
                    aria-label="เลือกสัปดาห์ในเดือน"
                    value={selectedWeekIndex}
                    onChange={(e) => setSelectedWeekIndex(Number(e.target.value))}
                    className="h-8 px-2.5 rounded-md bg-white border border-[#E8E4EF] text-[13px] font-semibold text-violet-950 focus:outline-none"
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
                    className="h-8 px-2.5 rounded-md text-[#4E3978] hover:bg-white disabled:opacity-40 text-[12.5px] font-semibold inline-flex items-center gap-1"
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
                <Search className="w-4 h-4 text-[#9A94AA] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value);
                    setPage(1);
                    setRosterPersonPage(1);
                  }}
                  placeholder="ค้นหาชื่อ-สกุล, รหัสบุคลากร, รหัสสแกนนิ้ว..."
                  className="w-full h-10 pl-9 pr-3 rounded-lg border border-[#D8D1E6] bg-white text-[13.5px] text-[#292638] placeholder:text-[#9A94AA] focus:outline-none focus:border-[#8066B5]"
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
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13.5px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
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
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13.5px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
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
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13.5px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                >
                  <option value="ACTIVE">เวรที่ใช้งานปกติ</option>
                  <option value="ALL">ทุกสถานะ</option>
                  <option value="CANCELLED">เฉพาะที่ยกเลิก</option>
                </select>

                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetAllFilters}
                    className="h-10 px-3 rounded-lg border border-[#D8D1E6] bg-[#F8F7FC] hover:bg-[#F1ECFA] text-[#292638] text-[13px] font-medium inline-flex items-center gap-1 shrink-0"
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
            <div className="bg-white border border-[#E8E4EF] rounded-xl overflow-hidden">
              <div className="px-4 sm:px-5 py-3.5 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-col gap-2.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[16px] font-bold text-[#292638]">
                      ตารางเวรรายเดือน · {formatThaiMonthTitle(selectedMonth)}
                    </h2>
                    <p className="text-[12.5px] text-[#777287]">
                      วางเมาส์บนไอคอนเพื่อดูชื่อกะและเวลาจริง หรือคลิกช่องวันที่เพื่อเปิดรายละเอียดและแก้ไขกะได้ทันที
                    </p>
                  </div>
                </div>

                {/* คำอธิบายสัญลักษณ์ Icon กะทัดรัด (แยกกะเริ่มต้น vs กะที่เจ้าหน้าที่กำหนดเองชัดเจน) */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[#292638] pt-1 border-t border-[#E8E4EF]/70">
                  <span className="inline-flex items-center gap-1">
                    <Sun className="w-3.5 h-3.5 text-amber-600" />
                    <span>กะเช้า</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Sunset className="w-3.5 h-3.5 text-orange-600" />
                    <span>กะบ่าย</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Moon className="w-3.5 h-3.5 text-indigo-700" />
                    <span>กะดึก</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Sunrise className="w-3.5 h-3.5 text-[#4E3978]" />
                    <span>เช้า–บ่าย</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CloudMoon className="w-3.5 h-3.5 text-indigo-600" />
                    <span>บ่าย–ดึก</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-[#4E3978]" />
                    <span>กะอื่น/ทั้งวัน</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MoonStar className="w-3.5 h-3.5 text-fuchsia-700" />
                    <span>กะพิเศษข้ามวัน</span>
                  </span>
                  <span className="text-[#D8D1E6]" aria-hidden="true">|</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-md border border-dashed border-emerald-400 bg-emerald-50/70 inline-flex items-center justify-center">
                      <Sun className="w-3 h-3 text-amber-600" />
                    </span>
                    <span>กรอบเส้นประ: กะเริ่มต้นอัตโนมัติ</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="relative w-5 h-5 rounded-md border border-[#8066B5] bg-[#F1ECFA] inline-flex items-center justify-center">
                      <Sun className="w-3 h-3 text-amber-600" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#4E3978] absolute -top-0.5 -right-0.5" />
                    </span>
                    <span>กรอบทึบ+จุดมุมขวา: กะที่เจ้าหน้าที่กำหนดเอง</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono font-bold text-[#9A94AA] px-1">—</span>
                    <span>ไม่มีเวร</span>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[680px]">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="sticky top-0 z-20">
                    <tr className="border-b border-[#E8E4EF] bg-[#F8F7FC] text-[#292638]">
                      <th className="sticky left-0 z-30 bg-[#F8F7FC] py-2.5 px-3.5 font-semibold min-w-[215px] max-w-[245px] border-r border-[#E8E4EF]">
                        บุคลากร / กลุ่มงาน ({filteredPersonnelForRoster.length} คน)
                      </th>
                      <th className="py-2.5 px-2 font-semibold text-center min-w-[54px] w-[54px] border-r border-[#E8E4EF] bg-[#F8F7FC] text-[12px]">
                        รวม
                      </th>
                      {visibleMonthDates.map((d) => {
                        const isToday = d.dateStr === initialBkk.todayYmd;
                        return (
                          <th
                            key={d.dateStr}
                            className={`py-2 px-0.5 text-center min-w-[42px] w-[42px] sm:min-w-[46px] sm:w-[46px] border-r border-[#E8E4EF]/80 font-mono tabular-nums ${
                              isToday
                                ? 'bg-[#E9DFF5] text-[#4E3978]'
                                : d.isWeekend
                                  ? 'bg-[#F1ECFA]/90 text-[#292638]'
                                  : 'bg-[#F8F7FC] text-[#292638]'
                            }`}
                          >
                            <div className="text-[10.5px] font-sans font-medium text-[#777287] leading-tight">
                              {d.weekdayShort}
                            </div>
                            <div className="text-[12.5px] font-bold leading-tight mt-0.5">
                              {d.dayNum}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8E4EF]/80">
                    {loading ? (
                      <tr>
                        <td
                          colSpan={visibleMonthDates.length + 2}
                          className="py-12 text-center text-[14px] text-[#777287]"
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
                            className="hover:bg-[#F8F7FC] transition-colors group"
                          >
                            {/* คอลัมน์รายชื่อบุคลากรทางซ้าย (Sticky Left) */}
                            <td className="sticky left-0 z-10 bg-white group-hover:bg-[#F8F7FC] py-2 px-3.5 border-r border-[#E8E4EF] align-middle">
                              <div className="font-bold text-[13px] text-[#292638] leading-snug truncate max-w-[225px]">
                                {person.full_name}
                              </div>
                              <div className="text-[11.5px] text-[#777287] mt-0.5 flex items-center gap-1 truncate max-w-[225px]">
                                <span className="font-mono">{pid}</span>
                                <span aria-hidden="true">·</span>
                                <span className="truncate">{person.department_name}</span>
                              </div>
                              {person.personnel_type_name && (
                                <div className="text-[10.5px] text-[#4E3978] font-medium truncate max-w-[225px]">
                                  {person.personnel_type_name}
                                </div>
                              )}
                            </td>

                            {/* จำนวนเวรรวมในเดือนนี้ */}
                            <td className="py-2 px-1 text-center font-mono tabular-nums font-bold text-[#4E3978] border-r border-[#E8E4EF] align-middle bg-[#F8F7FC]/60 text-[12.5px]">
                              {personTotalShifts}
                            </td>

                            {/* ช่องวันที่แต่ละวันในเดือน (Compact Icon Mode) */}
                            {visibleMonthDates.map((d) => {
                              const cellEff = getEffectiveCellState(person, d.dateStr);
                              const vm = buildCompactMonthlyCellViewModel(
                                cellEff,
                                formatThaiDate(d.dateStr),
                                2
                              );
                              const isToday = d.dateStr === initialBkk.todayYmd;

                              return (
                                <td
                                  key={d.dateStr}
                                  className={`p-1 border-r border-[#E8E4EF]/60 align-middle text-center ${
                                    isToday
                                      ? 'bg-[#F1ECFA]/35'
                                      : d.isWeekend
                                        ? 'bg-[#F8F7FC]/80'
                                        : ''
                                  }`}
                                >
                                  {vm.kind === 'EMPTY_DASH' ? (
                                    <button
                                      type="button"
                                      onClick={() => openQuickCellModal(person, d.dateStr)}
                                      title={vm.tooltipText}
                                      aria-label={vm.ariaLabel}
                                      className={`w-full h-9 rounded-lg flex items-center justify-center transition-colors ${
                                        vm.isClearedByStaff
                                          ? 'border border-dashed border-amber-300 bg-amber-50/70 text-amber-700 hover:bg-amber-100/80'
                                          : 'border border-transparent text-[#9A94AA] hover:border-[#8066B5]/60 hover:bg-[#F1ECFA]/60 hover:text-[#4E3978]'
                                      }`}
                                    >
                                      <span className="font-mono text-[14px] font-semibold leading-none">
                                        —
                                      </span>
                                    </button>
                                  ) : vm.kind === 'DEFAULT' ? (
                                    <button
                                      type="button"
                                      onClick={() => openQuickCellModal(person, d.dateStr)}
                                      title={vm.tooltipText}
                                      aria-label={vm.ariaLabel}
                                      className="w-full h-9 rounded-lg border border-dashed border-emerald-400/90 bg-emerald-50/65 hover:bg-emerald-100/80 flex items-center justify-center transition-colors"
                                    >
                                      {renderShiftIcon(vm.visibleIcons[0].iconKind, 'w-4 h-4')}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => openQuickCellModal(person, d.dateStr)}
                                      title={vm.tooltipText}
                                      aria-label={vm.ariaLabel}
                                      className="relative w-full h-9 rounded-lg border border-[#8066B5] bg-[#F1ECFA] hover:bg-[#E9DFF5] flex items-center justify-center gap-0.5 px-0.5 transition-colors"
                                    >
                                      <span
                                        className="w-1.5 h-1.5 rounded-full bg-[#4E3978] absolute top-1 right-1"
                                        aria-hidden="true"
                                      />
                                      <div className="flex items-center justify-center gap-0.5">
                                        {vm.visibleIcons.map((iconItem) => (
                                          <span key={iconItem.id} className="inline-flex">
                                            {renderShiftIcon(
                                              iconItem.iconKind,
                                              vm.visibleIcons.length > 1 || vm.overflowCount > 0
                                                ? 'w-3.5 h-3.5'
                                                : 'w-4 h-4'
                                            )}
                                          </span>
                                        ))}
                                      </div>
                                      {vm.overflowCount > 0 && (
                                        <span className="text-[9.5px] font-mono font-bold text-[#4E3978] leading-none">
                                          +{vm.overflowCount}
                                        </span>
                                      )}
                                    </button>
                                  )}
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
              <div className="px-4 py-3 bg-[#F8F7FC] border-t border-[#E8E4EF] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[13px] text-[#777287]">
                <div>
                  แสดงบุคลากร{' '}
                  <span className="font-semibold text-[#292638]">
                    {filteredPersonnelForRoster.length === 0
                      ? 0
                      : (rosterPersonPage - 1) * rosterPersonPageSize + 1}
                  </span>{' '}
                  ถึง{' '}
                  <span className="font-semibold text-[#292638]">
                    {Math.min(
                      rosterPersonPage * rosterPersonPageSize,
                      filteredPersonnelForRoster.length
                    )}
                  </span>{' '}
                  จากทั้งหมด{' '}
                  <span className="font-semibold text-[#292638]">
                    {filteredPersonnelForRoster.length}
                  </span>{' '}
                  คน
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="text-[12.5px] text-[#777287]">จำนวนคนต่อหน้า:</label>
                  <select
                    value={rosterPersonPageSize}
                    onChange={(e) => {
                      setRosterPersonPageSize(Number(e.target.value));
                      setRosterPersonPage(1);
                    }}
                    className="h-8 px-2 rounded border border-[#D8D1E6] bg-white text-[12.5px] font-mono"
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
                      className="h-8 px-2.5 rounded border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] disabled:opacity-40 text-[12.5px] font-medium"
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
                      className="h-8 px-2.5 rounded border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] disabled:opacity-40 text-[12.5px] font-medium"
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
            <div className="bg-white border border-[#E8E4EF] rounded-xl overflow-hidden">
              <div className="px-4 sm:px-5 py-3.5 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-col gap-2.5">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[16px] font-bold text-[#292638]">
                      ตารางเวรรายสัปดาห์ · {activeWeekObj.label}
                    </h2>
                    <p className="text-[12.5px] text-[#777287]">
                      แสดงเวรแบบ Icon กะทัดรัด (แสดงหลาย Icon ในวันที่มีหลายกะ) วางเมาส์เพื่อดูเวลาจริง หรือคลิกช่องเพื่อเปิดดูรายละเอียดและแก้ไข
                    </p>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={selectedWeekIndex <= 0}
                      onClick={() => setSelectedWeekIndex((w) => Math.max(0, w - 1))}
                      className="h-8 px-3 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F1ECFA] disabled:opacity-40 text-[#4E3978] text-[12.5px] font-semibold inline-flex items-center gap-1"
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
                      className="h-8 px-3 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F1ECFA] disabled:opacity-40 text-[#4E3978] text-[12.5px] font-semibold inline-flex items-center gap-1"
                    >
                      <span>สัปดาห์ถัดไป</span>
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* แถบคำอธิบาย Icon เดียวกับตารางรายเดือน */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[#292638] pt-1 border-t border-[#E8E4EF]/70">
                  <span className="inline-flex items-center gap-1">
                    <Sun className="w-3.5 h-3.5 text-amber-600" />
                    <span>กะเช้า</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Sunset className="w-3.5 h-3.5 text-orange-600" />
                    <span>กะบ่าย</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Moon className="w-3.5 h-3.5 text-indigo-700" />
                    <span>กะดึก</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Sunrise className="w-3.5 h-3.5 text-[#4E3978]" />
                    <span>เช้า–บ่าย</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <CloudMoon className="w-3.5 h-3.5 text-indigo-600" />
                    <span>บ่าย–ดึก</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-[#4E3978]" />
                    <span>กะอื่น/ทั้งวัน</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <MoonStar className="w-3.5 h-3.5 text-fuchsia-700" />
                    <span>กะพิเศษข้ามวัน</span>
                  </span>
                  <span className="text-[#D8D1E6]" aria-hidden="true">|</span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-5 h-5 rounded-md border border-dashed border-emerald-400 bg-emerald-50/70 inline-flex items-center justify-center">
                      <Sun className="w-3 h-3 text-amber-600" />
                    </span>
                    <span>กรอบเส้นประ: กะเริ่มต้นอัตโนมัติ</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="relative w-5 h-5 rounded-md border border-[#8066B5] bg-[#F1ECFA] inline-flex items-center justify-center">
                      <Sun className="w-3 h-3 text-amber-600" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#4E3978] absolute -top-0.5 -right-0.5" />
                    </span>
                    <span>กรอบทึบ+จุดมุมขวา: กะที่เจ้าหน้าที่กำหนดเอง</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono font-bold text-[#9A94AA] px-1">—</span>
                    <span>ไม่มีเวร</span>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto max-h-[680px]">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead className="sticky top-0 z-20">
                    <tr className="border-b border-[#E8E4EF] bg-[#F8F7FC] text-[#292638]">
                      <th className="sticky left-0 z-30 bg-[#F8F7FC] py-2.5 px-4 font-semibold min-w-[220px] max-w-[255px] border-r border-[#E8E4EF]">
                        บุคลากร / กลุ่มงาน ({filteredPersonnelForRoster.length} คน)
                      </th>
                      {activeWeekObj.dates.map((d) => {
                        const isToday = d.dateStr === initialBkk.todayYmd;
                        return (
                          <th
                            key={d.dateStr}
                            className={`py-2.5 px-2 text-center min-w-[92px] border-r border-[#E8E4EF]/80 ${
                              isToday
                                ? 'bg-[#E9DFF5] text-[#4E3978]'
                                : d.isWeekend
                                  ? 'bg-[#F1ECFA]/90 text-[#292638]'
                                  : 'bg-[#F8F7FC] text-[#292638]'
                            }`}
                          >
                            <div className="text-[11.5px] font-semibold">{d.weekdayFull}</div>
                            <div className="text-[12px] font-mono tabular-nums text-[#777287]">
                              {formatThaiDate(d.dateStr)}
                            </div>
                          </th>
                        );
                      })}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8E4EF]/80">
                    {loading ? (
                      <tr>
                        <td
                          colSpan={activeWeekObj.dates.length + 1}
                          className="py-12 text-center text-[14px] text-[#777287]"
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
                          <tr key={pid} className="hover:bg-[#F8F7FC] transition-colors group">
                            <td className="sticky left-0 z-10 bg-white group-hover:bg-[#F8F7FC] py-2.5 px-4 border-r border-[#E8E4EF] align-middle">
                              <div className="font-bold text-[13.5px] text-[#292638] truncate max-w-[235px]">
                                {person.full_name}
                              </div>
                              <div className="text-[12px] text-[#777287] mt-0.5 truncate max-w-[235px]">
                                <span className="font-mono">{pid}</span> · {person.department_name}
                              </div>
                              {person.personnel_type_name && (
                                <div className="text-[10.5px] text-[#4E3978] font-medium truncate max-w-[235px]">
                                  {person.personnel_type_name}
                                </div>
                              )}
                            </td>

                            {activeWeekObj.dates.map((d) => {
                              const cellEff = getEffectiveCellState(person, d.dateStr);
                              const vm = buildCompactMonthlyCellViewModel(
                                cellEff,
                                formatThaiDate(d.dateStr),
                                2
                              );
                              const isToday = d.dateStr === initialBkk.todayYmd;
                              return (
                                <td
                                  key={d.dateStr}
                                  className={`p-1.5 border-r border-[#E8E4EF]/70 align-middle text-center ${
                                    isToday
                                      ? 'bg-[#F1ECFA]/35'
                                      : d.isWeekend
                                        ? 'bg-[#F8F7FC]/80'
                                        : ''
                                  }`}
                                >
                                  {vm.kind === 'EMPTY_DASH' ? (
                                    <button
                                      type="button"
                                      onClick={() => openQuickCellModal(person, d.dateStr)}
                                      title={vm.tooltipText}
                                      aria-label={vm.ariaLabel}
                                      className={`w-full h-11 rounded-lg flex items-center justify-center transition-colors ${
                                        vm.isClearedByStaff
                                          ? 'border border-dashed border-amber-300 bg-amber-50/70 text-amber-700 hover:bg-amber-100/80'
                                          : 'border border-transparent text-[#9A94AA] hover:border-[#8066B5]/60 hover:bg-[#F1ECFA]/60 hover:text-[#4E3978]'
                                      }`}
                                    >
                                      <span className="font-mono text-[15px] font-semibold leading-none">
                                        —
                                      </span>
                                    </button>
                                  ) : vm.kind === 'DEFAULT' ? (
                                    <button
                                      type="button"
                                      onClick={() => openQuickCellModal(person, d.dateStr)}
                                      title={vm.tooltipText}
                                      aria-label={vm.ariaLabel}
                                      className="w-full h-11 rounded-lg border border-dashed border-emerald-400/90 bg-emerald-50/65 hover:bg-emerald-100/80 flex items-center justify-center transition-colors"
                                    >
                                      {renderShiftIcon(vm.visibleIcons[0].iconKind, 'w-4.5 h-4.5')}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => openQuickCellModal(person, d.dateStr)}
                                      title={vm.tooltipText}
                                      aria-label={vm.ariaLabel}
                                      className="relative w-full h-11 rounded-lg border border-[#8066B5] bg-[#F1ECFA] hover:bg-[#E9DFF5] flex items-center justify-center gap-1 px-1.5 transition-colors"
                                    >
                                      <span
                                        className="w-1.5 h-1.5 rounded-full bg-[#4E3978] absolute top-1.5 right-1.5"
                                        aria-hidden="true"
                                      />
                                      <div className="flex items-center justify-center gap-1">
                                        {vm.visibleIcons.map((iconItem) => (
                                          <span key={iconItem.id} className="inline-flex">
                                            {renderShiftIcon(
                                              iconItem.iconKind,
                                              vm.visibleIcons.length > 2 ? 'w-4 h-4' : 'w-4.5 h-4.5'
                                            )}
                                          </span>
                                        ))}
                                      </div>
                                      {vm.overflowCount > 0 && (
                                        <span className="text-[11px] font-mono font-bold text-[#4E3978] leading-none">
                                          +{vm.overflowCount}
                                        </span>
                                      )}
                                    </button>
                                  )}
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
              <div className="bg-white border border-[#E8E4EF] rounded-xl overflow-hidden">
                <div className="px-4 sm:px-6 py-4 border-b border-[#E8E4EF] bg-[#F1ECFA]/50 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[16.5px] font-bold text-[#292638]">
                      รายการเวรที่มอบหมาย ({filteredAssignments.length} รายการ)
                    </h2>
                    <p className="text-[13px] text-[#777287]">
                      แสดงค่าเวลาตาม Snapshot ณ วันที่มอบหมายเวร (เวลาเริ่ม–เลิกงาน เวลาผ่อนผันสาย และเวลาตัดรอบสแกน)
                    </p>
                  </div>
                </div>

                {/* มุมมองการ์ดสำหรับหน้าจอขนาดเล็ก (< 768px) */}
                <div className="md:hidden divide-y divide-[#E8E4EF]">
                  {loading ? (
                    <div className="py-10 text-center text-[14px] text-[#777287]">
                      กำลังโหลดรายการตารางเวร...
                    </div>
                  ) : pagedAssignments.length === 0 ? (
                    <div className="py-10 px-4 text-center text-[14px] text-[#777287]">
                      ไม่พบรายการตารางเวรตามเงื่อนไขที่เลือก
                    </div>
                  ) : (
                    pagedAssignments.map((a) => {
                      const isCross = Number(a.snapshot_is_cross_midnight) === 1;
                      return (
                        <div key={a.id} className="p-4 space-y-3 bg-white">
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="font-bold text-[15px] text-[#292638]">
                                {a.full_name}
                              </div>
                              <div className="text-[12.5px] text-[#777287]">
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

                          <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] text-[13px] space-y-1.5">
                            <div className="flex items-center justify-between">
                              <span className="text-[#777287]">วันที่ปฏิบัติงาน:</span>
                              <span className="font-mono font-bold text-[#292638]">
                                {formatThaiDate(a.work_date)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#777287]">กะทำงาน:</span>
                              <span className="font-semibold text-[#4E3978]">
                                {formatCleanShiftName(a.snapshot_shift_name)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#777287]">เวลาเริ่ม–เลิกงาน:</span>
                              <span className="font-mono text-[#292638]">
                                {a.snapshot_start_time}–{a.snapshot_end_time} น.{' '}
                                {isCross ? '(ข้ามวัน +1)' : ''}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-[#777287]">รหัสกะ / ผ่อนผัน / ตัดรอบ:</span>
                              <span className="font-mono text-[#292638]">
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
                      <tr className="border-b border-[#E8E4EF] bg-[#F8F7FC] text-[#292638]">
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
                    <tbody className="divide-y divide-[#E8E4EF]">
                      {loading ? (
                        <tr>
                          <td colSpan={7} className="py-12 text-center text-[14px] text-[#777287]">
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
                            <tr key={a.id} className="hover:bg-[#F8F7FC]/80 transition-colors">
                              <td className="py-3.5 px-4 font-mono tabular-nums font-semibold text-[#292638] whitespace-nowrap">
                                {formatThaiDate(a.work_date)}
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="font-bold text-[#292638]">{a.full_name}</div>
                                <div className="text-[12px] text-[#777287] mt-0.5">
                                  <span className="font-mono">{a.person_id}</span> ·{' '}
                                  {a.department_name}
                                </div>
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="font-semibold text-[#292638]">
                                  {formatCleanShiftName(a.snapshot_shift_name)}
                                </div>
                                <div className="text-[12px] font-mono text-[#4E3978] mt-0.5">
                                  รหัสกะ: {a.snapshot_shift_code}
                                  {isCross ? ' · เวรข้ามวัน (+1 วัน)' : ''}
                                </div>
                              </td>
                              <td className="py-3.5 px-4 font-mono tabular-nums text-[#292638] whitespace-nowrap">
                                {a.snapshot_start_time}–{a.snapshot_end_time} น.
                              </td>
                              <td className="py-3.5 px-4 font-mono tabular-nums text-[12.5px] text-[#777287] whitespace-nowrap">
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
                                    className="h-9 px-3 text-[12.5px] text-[#292638] bg-white border border-[#D8D1E6] rounded-lg hover:bg-[#F8F7FC] inline-flex items-center gap-1 font-medium transition-colors"
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
                <div className="bg-white border border-[#E8E4EF] rounded-xl overflow-hidden">
                  <div className="px-4 sm:px-6 py-3.5 border-b border-[#E8E4EF] bg-[#F8F7FC]">
                    <h2 className="text-[16px] font-bold text-[#292638]">
                      ประวัติการยกเลิกตารางเวรย้อนหลัง ({cancellationLogs.length} รายการล่าสุด)
                    </h2>
                    <p className="text-[12.5px] text-[#777287]">
                      ระบบรักษาประวัติการยกเลิกเวรทุกครั้ง (Soft Cancel Audit Trail) เพื่อความโปร่งใสในการตรวจสอบ
                    </p>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse text-[13.5px]">
                      <thead>
                        <tr className="border-b border-[#E8E4EF] bg-[#F8F7FC] text-[#292638]">
                          <th className="py-3 px-4 font-semibold">วันและเวลาที่ยกเลิก</th>
                          <th className="py-3 px-4 font-semibold">บุคลากร</th>
                          <th className="py-3 px-4 font-semibold">วันที่เวร / รหัสกะ</th>
                          <th className="py-3 px-4 font-semibold">เหตุผลการยกเลิก</th>
                          <th className="py-3 px-4 font-semibold">ผู้ดำเนินการ</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E8E4EF]">
                        {cancellationLogs.map((c) => (
                          <tr key={c.id} className="hover:bg-[#F8F7FC]/70">
                            <td className="py-3 px-4 font-mono tabular-nums text-[#292638] whitespace-nowrap">
                              {formatThaiDateTime(c.cancelled_at)}
                            </td>
                            <td className="py-3 px-4 font-semibold text-[#292638]">
                              {c.full_name} ({c.person_id})
                            </td>
                            <td className="py-3 px-4 font-mono tabular-nums text-[#292638] whitespace-nowrap">
                              {formatThaiDate(c.work_date)} · {c.shift_code}
                            </td>
                            <td className="py-3 px-4 text-[#292638]">{c.cancel_reason}</td>
                            <td className="py-3 px-4 font-mono text-[#777287]">{c.cancelled_by}</td>
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
        <div className="space-y-6">
          {/* =================================================================
              ส่วนเลือกประเภทการดำเนินการ (พื้นหลังขาว #FFFFFF)
              Card ที่เลือกใช้พื้นหลังม่วงอ่อน (#F1ECFA) และขอบม่วง (#8066B5)
             ================================================================= */}
          <section className="bg-white border border-[#E8E4EF] rounded-2xl shadow-xs p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="min-w-0">
                <h2 className="text-[17px] font-bold text-[#292638]">
                  จัดตารางเวรหลายคน / หลายวัน และเลือกได้หลายกะพร้อมกัน
                </h2>
                <p className="text-[13px] text-[#777287] mt-0.5">
                  เลือกประเภทการดำเนินการ → ① เลือกบุคลากรและแม่แบบกะ → ② เลือกวันที่ปฏิบัติงาน → ③ ตรวจสอบและยืนยัน
                </p>
              </div>
              <span className="text-[13px] font-semibold text-[#8066B5] bg-[#F1ECFA] border border-[#E8E4EF] px-3 py-1.5 rounded-lg self-start sm:self-auto whitespace-nowrap">
                เดือนที่กำลังจัดเวร: {formatThaiMonthTitle(selectedMonth)}
              </span>
            </div>

            {/* 1. สลับรายบุคคล vs หลายคน */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleSwitchAssignMethod('SINGLE_PERSON')}
                className={`p-3.5 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                  assignMethod === 'SINGLE_PERSON'
                    ? 'bg-[#F1ECFA] border-[#8066B5] text-[#292638] shadow-2xs'
                    : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]/60'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                    assignMethod === 'SINGLE_PERSON'
                      ? 'bg-[#8066B5] text-white'
                      : 'bg-[#F8F7FC] text-[#777287] border border-[#E8E4EF]'
                  }`}
                >
                  <User className="w-4.5 h-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[14.5px] text-[#292638]">
                    จัดเวรรายบุคคล (1 คน)
                  </div>
                  <p className="text-[12.5px] text-[#777287]">
                    เลือก 1 คน พร้อมเลือกได้หลายกะและหลายวัน
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => handleSwitchAssignMethod('MULTI_PERSON')}
                className={`p-3.5 rounded-xl border text-left transition-colors flex items-start gap-3 ${
                  assignMethod === 'MULTI_PERSON'
                    ? 'bg-[#F1ECFA] border-[#8066B5] text-[#292638] shadow-2xs'
                    : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]/60'
                }`}
              >
                <div
                  className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${
                    assignMethod === 'MULTI_PERSON'
                      ? 'bg-[#8066B5] text-white'
                      : 'bg-[#F8F7FC] text-[#777287] border border-[#E8E4EF]'
                  }`}
                >
                  <Users className="w-4.5 h-4.5" />
                </div>
                <div className="min-w-0">
                  <div className="font-bold text-[14.5px] text-[#292638]">
                    จัดเวรหลายคนพร้อมกัน (รายกลุ่มงาน/แผนก)
                  </div>
                  <p className="text-[12.5px] text-[#777287]">
                    เลือกบุคลากรหลายคน เลือกหลายกะ และกำหนดหลายวันพร้อมกัน
                  </p>
                </div>
              </button>
            </div>

            {/* 2. แยกประเภทการดำเนินการชัดเจน: เพิ่มกะ / แทนที่กะเดิม / ลบกะที่เลือก / ลบกะทั้งหมด */}
            <div className="pt-3.5 border-t border-[#E8E4EF] space-y-2.5">
              <div className="text-[13px] font-bold text-[#292638]">
                ประเภทการดำเนินการกับตารางเวร{' '}
                <span className="font-normal text-[#777287]">
                  (ระบบจะไม่แก้หรือลบกะเดิมหากไม่เลือกและยืนยันชัดเจน)
                </span>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                <button
                  type="button"
                  onClick={() => setBulkOperationMode('ADD_SHIFTS')}
                  className={`p-3.5 rounded-xl border text-left transition-colors ${
                    bulkOperationMode === 'ADD_SHIFTS'
                      ? 'bg-[#F1ECFA] border-[#8066B5] text-[#292638] shadow-2xs'
                      : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-[13.5px] text-[#292638]">
                    <Plus className="w-4 h-4 text-[#8066B5] shrink-0" />
                    <span>เพิ่มกะใหม่</span>
                  </div>
                  <p className="text-[12px] text-[#777287] mt-1 leading-snug">
                    เพิ่มเฉพาะกะที่เลือก ไม่ลบหรือทับกะเดิมที่มีอยู่แล้ว
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setBulkOperationMode('REPLACE_SHIFTS')}
                  className={`p-3.5 rounded-xl border text-left transition-colors ${
                    bulkOperationMode === 'REPLACE_SHIFTS'
                      ? 'bg-[#F1ECFA] border-[#8066B5] text-[#292638] shadow-2xs'
                      : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-[13.5px] text-[#292638]">
                    <RefreshCw className="w-4 h-4 text-amber-600 shrink-0" />
                    <span>แทนที่กะเดิมทั้งหมดในวันนั้น</span>
                  </div>
                  <p className="text-[12px] text-[#777287] mt-1 leading-snug">
                    ยกเลิกกะเดิมของวันที่เลือกแล้วบันทึกกะใหม่แทน (ต้องยืนยัน)
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setBulkOperationMode('REMOVE_SELECTED_SHIFTS')}
                  className={`p-3.5 rounded-xl border text-left transition-colors ${
                    bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
                      ? 'bg-[#F1ECFA] border-[#8066B5] text-[#292638] shadow-2xs'
                      : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-[13.5px] text-[#292638]">
                    <Trash2 className="w-4 h-4 text-red-600 shrink-0" />
                    <span>ลบเฉพาะกะที่เลือก</span>
                  </div>
                  <p className="text-[12px] text-[#777287] mt-1 leading-snug">
                    ลบเฉพาะกะที่ติ๊กเลือก คงกะอื่นในวันเดียวกันไว้ (ต้องยืนยัน)
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setBulkOperationMode('CLEAR_ALL_SHIFTS')}
                  className={`p-3.5 rounded-xl border text-left transition-colors ${
                    bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                      ? 'bg-[#F1ECFA] border-[#8066B5] text-[#292638] shadow-2xs'
                      : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]/60'
                  }`}
                >
                  <div className="flex items-center gap-2 font-bold text-[13.5px] text-[#292638]">
                    <X className="w-4 h-4 text-red-600 shrink-0" />
                    <span>ลบกะทั้งหมด (ตั้งเป็นไม่มีเวร)</span>
                  </div>
                  <p className="text-[12px] text-[#777287] mt-1 leading-snug">
                    ยกเลิกทุกกะในวันที่เลือก และคงสถานะ “ไม่มีเวร” ไว้ถาวร
                  </p>
                </button>
              </div>
            </div>
          </section>

          {/* =================================================================
              ขั้นตอนที่ ①: เลือกบุคลากรและแม่แบบกะทำงาน
              พื้นหลังม่วงอ่อนมาก (#F8F7FC) | Header แถบม่วงอ่อน (#F1ECFA)
              ภายในส่วนรายชื่อบุคลากรและ Card กะใช้พื้นหลังขาว (#FFFFFF)
             ================================================================= */}
          <section className="bg-[#F8F7FC] border border-[#E8E4EF] rounded-2xl shadow-xs overflow-hidden">
            <div className="bg-[#F1ECFA] border-b border-[#E8E4EF] px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-start gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className="w-7 h-7 rounded-full bg-[#8066B5] text-white font-bold text-[13.5px] flex items-center justify-center shrink-0 mt-0.5 shadow-2xs"
                >
                  1
                </span>
                <div className="min-w-0">
                  <h3 className="text-[15.5px] font-bold text-[#292638] leading-snug">
                    เลือกบุคลากรและแม่แบบกะทำงาน <RequiredMark />
                  </h3>
                  <p className="text-[12.5px] text-[#777287] mt-0.5">
                    เลือกบุคลากรทางซ้าย (รักษาการเลือกข้ามแผนก/คำค้นหา) และเลือกแม่แบบกะทางขวาได้หลายกะพร้อมกัน
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0 pl-10 sm:pl-0">
                <span className="font-mono text-[12.5px] font-bold text-[#8066B5] bg-white border border-[#E8E4EF] px-2.5 py-1 rounded-lg tabular-nums">
                  เลือกแล้ว {filteredPersonSelectionMeta.uniqueSelectedTotalCount} คน
                </span>
                <span className="font-mono text-[12.5px] font-bold text-[#8066B5] bg-white border border-[#E8E4EF] px-2.5 py-1 rounded-lg tabular-nums">
                  {bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                    ? 'ล้างทุกกะ (ไม่ต้องเลือกกะ)'
                    : `เลือกแล้ว ${selectedShiftIds.length} กะ`}
                </span>
              </div>
            </div>

            <div className="p-4 sm:p-5 grid grid-cols-1 lg:grid-cols-12 gap-5">
              {/* ซ้าย: เลือกบุคลากร (พื้นหลังขาว #FFFFFF) */}
              <div className="lg:col-span-6 min-w-0 bg-white border border-[#E8E4EF] rounded-xl p-4 flex flex-col justify-between gap-3.5 shadow-2xs">
                <div className="space-y-3 min-w-0">
                  {/* หัวแผงเลือกบุคลากร + Badge จำนวน + ปุ่มล้างรายชื่อ */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-[#E8E4EF]/80">
                    <div className="flex flex-wrap items-center gap-2 min-w-0">
                      <span className="text-[14px] font-bold text-[#292638]">
                        เลือกบุคลากร
                      </span>
                      <span
                        data-testid="selected-personnel-count-badge"
                        className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-[#F1ECFA] border border-[#E8E4EF] text-[#8066B5] text-[12px] font-bold font-mono tabular-nums"
                      >
                        เลือกแล้ว {filteredPersonSelectionMeta.uniqueSelectedTotalCount} คน
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={filteredPersonSelectionMeta.uniqueSelectedTotalCount === 0}
                      onClick={handleRequestClearSelectedPersons}
                      className="h-8 px-3 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] hover:border-[#8066B5] disabled:opacity-40 disabled:pointer-events-none text-[#292638] text-[12px] font-semibold transition-colors whitespace-nowrap"
                    >
                      ล้างรายชื่อ
                    </button>
                  </div>

                  {/* ตัวกรองกลุ่มงาน + ค้นหาชื่อ/รหัส (ไม่ล้างรายการที่เลือกเมื่อเปลี่ยนตัวกรอง) */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="min-w-0">
                      <label className="block text-[12px] font-semibold text-[#292638] mb-1">
                        กลุ่มงาน / แผนก
                      </label>
                      <select
                        aria-label="กรองกลุ่มงานในการเลือกบุคลากร"
                        value={assignPersonDeptFilter}
                        onChange={(e) => {
                          setAssignPersonDeptFilter(e.target.value);
                          setAssignPersonnelRenderLimit(80);
                        }}
                        className="w-full h-9.5 px-3 rounded-lg border border-[#E8E4EF] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                      >
                        <option value="ALL">ทุกกลุ่มงาน/แผนก ({personnel.length} คน)</option>
                        {departments.map((dept) => (
                          <option key={dept} value={dept}>
                            {dept}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="min-w-0">
                      <label className="block text-[12px] font-semibold text-[#292638] mb-1">
                        ค้นหาชื่อ รหัส หรือกลุ่มงาน
                      </label>
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 text-[#777287] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                        <input
                          type="text"
                          value={assignPersonSearch}
                          onChange={(e) => {
                            setAssignPersonSearch(e.target.value);
                            setAssignPersonnelRenderLimit(80);
                          }}
                          placeholder="พิมพ์ชื่อ, รหัสบุคลากร, กลุ่มงาน..."
                          className="w-full h-9.5 pl-8 pr-8 rounded-lg border border-[#E8E4EF] bg-white text-[13px] text-[#292638] placeholder:text-[#777287]/70 focus:outline-none focus:border-[#8066B5]"
                        />
                        {assignPersonSearch && (
                          <button
                            type="button"
                            onClick={() => {
                              setAssignPersonSearch('');
                              setAssignPersonnelRenderLimit(80);
                            }}
                            aria-label="ล้างคำค้นหาบุคลากร"
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#777287] hover:text-[#292638]"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* กล่องรายชื่อบุคลากร พร้อมหัวรายการ Checkbox เลือกทั้งหมดแบบ 3 สถานะ (Tri-state) */}
                  <div className="border border-[#E8E4EF] rounded-xl overflow-hidden bg-white">
                    {assignMethod === 'MULTI_PERSON' ? (
                      <div className="px-3.5 py-2.5 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-wrap items-center justify-between gap-2">
                        <label
                          className={`inline-flex items-center gap-2.5 text-[13px] font-bold select-none min-w-0 ${
                            filteredPersonSelectionMeta.disabled
                              ? 'text-[#777287]/60 cursor-not-allowed'
                              : 'text-[#292638] cursor-pointer'
                          }`}
                        >
                          <input
                            ref={selectAllFilteredCheckboxRef}
                            type="checkbox"
                            checked={filteredPersonSelectionMeta.state === 'checked'}
                            disabled={filteredPersonSelectionMeta.disabled}
                            onChange={handleToggleSelectAllFilteredPersons}
                            aria-label={`เลือกทั้งหมดในรายการที่แสดง (${filteredPersonSelectionMeta.totalFilteredCount} คน)`}
                            className="w-4 h-4 rounded border-[#8066B5]/60 accent-[#8066B5] text-[#8066B5] focus:ring-[#8066B5] shrink-0"
                          />
                          <span className="truncate">
                            เลือกทั้งหมดในรายการที่แสดง (
                            <span className="font-mono tabular-nums text-[#8066B5]">
                              {filteredPersonSelectionMeta.totalFilteredCount}
                            </span>{' '}
                            คน)
                          </span>
                        </label>

                        {filteredPersonSelectionMeta.totalFilteredCount > 0 && (
                          <span className="text-[11.5px] font-medium text-[#777287] font-mono tabular-nums shrink-0">
                            {filteredPersonSelectionMeta.state === 'indeterminate'
                              ? `เลือกบางส่วน ${filteredPersonSelectionMeta.selectedInFilteredCount}/${filteredPersonSelectionMeta.totalFilteredCount}`
                              : filteredPersonSelectionMeta.state === 'checked'
                                ? 'เลือกครบรายการที่กรอง'
                                : `ทั้งหมด ${filteredPersonSelectionMeta.totalFilteredCount} คน`}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="px-3.5 py-2 bg-[#F8F7FC] border-b border-[#E8E4EF] flex items-center justify-between gap-2 text-[12.5px] text-[#777287]">
                        <span>
                          พบผลลัพธ์{' '}
                          <strong className="font-mono tabular-nums text-[#292638]">
                            {assignFilteredPersonnel.length}
                          </strong>{' '}
                          คน
                        </span>
                        <span className="text-[11.5px]">โหมดรายบุคคล (เลือกได้ 1 คน)</span>
                      </div>
                    )}

                    <div className="divide-y divide-[#E8E4EF]/60 max-h-72 overflow-y-auto bg-white">
                      {visibleAssignPersonnel.length === 0 ? (
                        <div className="py-10 px-4 text-center text-[13px] text-[#777287]">
                          ไม่พบบุคลากรตามคำค้นหาหรือกลุ่มงานที่เลือก
                        </div>
                      ) : (
                        visibleAssignPersonnel.map((p) => {
                          const pid = String(p.person_id).trim();
                          const checked = selectedPersonIds.includes(pid);
                          return (
                            <label
                              key={pid}
                              className={`flex items-start gap-3 px-3.5 py-2.5 cursor-pointer text-[13px] transition-colors ${
                                checked ? 'bg-[#F1ECFA]/85' : 'bg-white hover:bg-[#F8F7FC]'
                              }`}
                            >
                              <input
                                type={assignMethod === 'SINGLE_PERSON' ? 'radio' : 'checkbox'}
                                name="assign-person-selector"
                                checked={checked}
                                onChange={() => handleSelectPerson(pid)}
                                className="mt-1 w-4 h-4 rounded border-[#D8D1E6] accent-[#8066B5] text-[#8066B5] focus:ring-[#8066B5] shrink-0"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="font-bold text-[#292638] truncate">
                                  {p.full_name}
                                </div>
                                <div className="text-[12px] text-[#777287] truncate">
                                  รหัส <span className="font-mono">{pid}</span> ·{' '}
                                  {p.department_name}
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
                        <div className="p-2.5 text-center bg-[#F8F7FC]">
                          <button
                            type="button"
                            onClick={() => setAssignPersonnelRenderLimit((lim) => lim + 100)}
                            className="text-[12.5px] font-semibold text-[#8066B5] hover:underline"
                          >
                            แสดงรายชื่อเพิ่มเติมอีก (เหลืออีก{' '}
                            {assignFilteredPersonnel.length - visibleAssignPersonnel.length} คน)
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* พื้นที่สรุปรายชื่อบุคลากรที่เลือกไว้ (เอาออกทีละคนได้) */}
                <div className="pt-2.5 border-t border-[#E8E4EF]/80 space-y-1.5 min-w-0">
                  <div className="flex items-center justify-between gap-2 text-[12px] font-semibold text-[#292638]">
                    <span>
                      รายชื่อบุคลากรที่เลือก ({selectedPersonnelObjects.length} คน):
                    </span>
                    {selectedPersonnelObjects.length > 24 && (
                      <button
                        type="button"
                        onClick={() => setShowAllSelectedPersonChips((v) => !v)}
                        className="text-[11.5px] font-semibold text-[#8066B5] hover:underline"
                      >
                        {showAllSelectedPersonChips
                          ? 'ย่อรายการ'
                          : `ดูทั้งหมด (${selectedPersonnelObjects.length})`}
                      </button>
                    )}
                  </div>
                  {selectedPersonnelObjects.length === 0 ? (
                    <div className="p-2.5 rounded-lg bg-[#F8F7FC] border border-dashed border-[#E8E4EF] text-[12px] text-[#777287] text-center">
                      ยังไม่ได้เลือกบุคลากร กรุณาติ๊กเลือกจากรายการด้านบน
                    </div>
                  ) : (
                    <div className="max-h-28 overflow-y-auto p-2 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] flex flex-wrap gap-1.5">
                      {(showAllSelectedPersonChips
                        ? selectedPersonnelObjects
                        : selectedPersonnelObjects.slice(0, 24)
                      ).map((p) => {
                        const pid = String(p.person_id).trim();
                        return (
                          <span
                            key={pid}
                            className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md bg-white border border-[#E8E4EF] text-[12px] text-[#292638] max-w-full"
                          >
                            <span className="font-semibold truncate max-w-[150px]">
                              {p.full_name}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                setSelectedPersonIds((prev) => prev.filter((id) => id !== pid))
                              }
                              className="text-[#777287] hover:text-red-600 shrink-0"
                              title={`นำ ${p.full_name} ออก`}
                              aria-label={`นำ ${p.full_name} ออกจากรายการที่เลือก`}
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </span>
                        );
                      })}
                      {!showAllSelectedPersonChips && selectedPersonnelObjects.length > 24 && (
                        <button
                          type="button"
                          onClick={() => setShowAllSelectedPersonChips(true)}
                          className="text-[12px] font-semibold text-[#8066B5] hover:underline px-2 py-0.5"
                        >
                          และอีก {selectedPersonnelObjects.length - 24} คน
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* ขวา: เลือกแม่แบบกะทำงานแบบ Multi-select Checkbox (พื้นหลังขาว #FFFFFF) */}
              <div className="lg:col-span-6 min-w-0 bg-white border border-[#E8E4EF] rounded-xl p-4 flex flex-col justify-between gap-3.5 shadow-2xs">
                <div className="space-y-3 min-w-0">
                  {/* หัวแผงเลือกแม่แบบกะ + Badge จำนวน + ปุ่มเลือกทุกกะ (N) + ปุ่มล้างการเลือก */}
                  <div className="space-y-2 pb-2.5 border-b border-[#E8E4EF]/80">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <span className="text-[14px] font-bold text-[#292638]">
                          เลือกแม่แบบกะทำงาน (เลือกได้มากกว่า 1 กะ)
                        </span>
                        <span
                          data-testid="selected-shifts-count-badge"
                          className="inline-flex items-center px-2.5 py-0.5 rounded-md bg-[#F1ECFA] border border-[#E8E4EF] text-[#8066B5] text-[12px] font-bold font-mono tabular-nums"
                        >
                          {bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                            ? 'ไม่ต้องเลือกกะ'
                            : `เลือกแล้ว ${selectedShiftIds.length} กะ`}
                        </span>
                      </div>

                      {bulkOperationMode !== 'CLEAR_ALL_SHIFTS' && (
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            disabled={
                              selectableShiftTemplates.length === 0 ||
                              selectedShiftIds.length === selectableShiftTemplates.length
                            }
                            onClick={selectAllAssignShifts}
                            className="h-8 px-2.5 rounded-lg border border-[#E8E4EF] bg-[#F1ECFA] hover:bg-[#E9DFF5] hover:border-[#8066B5] disabled:opacity-40 disabled:pointer-events-none text-[#8066B5] text-[12px] font-bold transition-colors whitespace-nowrap"
                          >
                            เลือกทุกกะ ({selectableShiftTemplates.length})
                          </button>
                          <button
                            type="button"
                            disabled={selectedShiftIds.length === 0}
                            onClick={clearSelectedShifts}
                            className="h-8 px-2.5 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] hover:border-[#8066B5] disabled:opacity-40 disabled:pointer-events-none text-[#292638] text-[12px] font-semibold transition-colors whitespace-nowrap"
                          >
                            ล้างการเลือก
                          </button>
                        </div>
                      )}
                    </div>

                    {bulkOperationMode !== 'CLEAR_ALL_SHIFTS' && (
                      <p className="text-[12px] text-[#777287] leading-snug">
                        Checkbox ด้านล่างคือกะที่เลือกเพื่อใช้กับการดำเนินการแบบกลุ่ม ไม่ใช่สถานะกะเดิมของบุคลากรแต่ละคน
                      </p>
                    )}
                  </div>

                  {bulkOperationMode === 'CLEAR_ALL_SHIFTS' ? (
                    <div className="p-5 rounded-xl bg-red-50/70 border border-red-200 space-y-2 text-[13px] text-red-950">
                      <div className="font-bold flex items-center gap-2 text-red-900">
                        <AlertTriangle className="w-4.5 h-4.5 text-red-600 shrink-0" />
                        <span>โหมดลบกะทั้งหมด (ตั้งเป็น “ไม่มีเวร”)</span>
                      </div>
                      <p className="leading-relaxed">
                        ไม่ต้องเลือกแม่แบบกะ ระบบจะยกเลิกกะปฏิบัติงานทั้งหมดของบุคลากรและวันที่ที่เลือก
                        และบันทึกสถานะ <strong>ไม่มีเวร (CLEARED_ALL_SHIFTS)</strong> ไว้ถาวร
                        โดยไม่สร้างกะเช้าเริ่มต้นกลับมาอัตโนมัติ
                      </p>
                    </div>
                  ) : (
                    <>
                      {/* แจ้งเตือนทันทีเมื่อพบแม่แบบกะที่มีช่วงเวลาทับซ้อนกัน (รวมกะข้ามวันตามหลักการ [start, end)) */}
                      {clientShiftOverlaps.length > 0 && (
                        <div
                          role="alert"
                          className="p-3.5 rounded-xl bg-red-50 border border-red-300 text-red-950 text-[12.5px] space-y-2"
                        >
                          <div className="flex items-start gap-2 font-bold text-red-900">
                            <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 mt-0.5" />
                            <span>
                              พบแม่แบบกะที่มีเวลาทับซ้อนกัน กรุณาตรวจสอบก่อนบันทึก (
                              {clientShiftOverlaps.length} คู่)
                            </span>
                          </div>
                          <ul className="list-disc pl-6 space-y-1 text-[12px] text-red-900 max-h-28 overflow-y-auto pr-1">
                            {clientShiftOverlaps.map((ov, idx) => (
                              <li key={`${ov.kind}-${ov.shiftAId}-${ov.shiftBId}-${idx}`}>
                                {ov.message}
                              </li>
                            ))}
                          </ul>
                          <p className="text-[11.5px] text-red-800/90 pl-6">
                            ระบบจะไม่อนุญาตให้บันทึกกะที่มีช่วงเวลาทับซ้อนกัน กรุณานำกะที่ทับซ้อนออกก่อนดำเนินการ (กะที่สิ้นสุดเวลาเดียวกับอีกกะเริ่มต้นถือว่าไม่ทับซ้อน)
                          </p>
                        </div>
                      )}

                      {/* การ์ดแม่แบบกะแบบ 2 คอลัมน์บน Desktop */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 max-h-[340px] overflow-y-auto pr-0.5">
                        {selectableShiftTemplates.map((s) => {
                          const sid = Number(s.id);
                          const isSelected = selectedShiftIds.includes(sid);
                          const isConflicting = isSelected && overlappingShiftIdSet.has(sid);
                          const isCross = Number(s.is_cross_midnight) === 1;
                          const cleanName = formatCleanShiftName(s.shift_name);
                          const iconKind = classifyShiftIconKind({
                            shiftCode: s.shift_code,
                            shiftName: s.shift_name,
                            shiftCategory: s.shift_category,
                            startTime: s.start_time,
                            endTime: s.end_time,
                            isCrossMidnight: isCross,
                          });
                          return (
                            <label
                              key={sid}
                              className={`p-3 rounded-xl border cursor-pointer transition-colors flex flex-col justify-between gap-2 select-none min-w-0 ${
                                isSelected
                                  ? isConflicting
                                    ? 'bg-[#F1ECFA] border-red-400 ring-1 ring-red-200'
                                    : 'bg-[#F1ECFA] border-[#8066B5] ring-1 ring-[#8066B5]/15'
                                  : 'bg-white border-[#E8E4EF] hover:border-[#8066B5]/60'
                              }`}
                            >
                              <div className="flex items-start justify-between gap-2 min-w-0">
                                <div className="flex items-start gap-2 min-w-0">
                                  <div className="w-7 h-7 rounded-lg bg-white border border-[#E8E4EF] flex items-center justify-center shrink-0 mt-0.5">
                                    {renderShiftIcon(iconKind, 'w-4 h-4')}
                                  </div>
                                  <div className="min-w-0">
                                    <div className="font-bold text-[13.5px] text-[#292638] leading-snug truncate">
                                      {cleanName}
                                    </div>
                                    <div className="font-mono font-bold text-[13px] text-[#8066B5] tabular-nums mt-0.5 flex flex-wrap items-center gap-1">
                                      <span>
                                        {s.start_time}–{s.end_time} น.
                                      </span>
                                      {isCross && (
                                        <span className="text-[10.5px] font-semibold px-1.5 py-0.2 rounded bg-white border border-[#E8E4EF] text-[#8066B5]">
                                          +1 วัน
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                </div>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() => toggleAssignShiftId(sid)}
                                  className="mt-1 w-4 h-4 rounded border-[#D8D1E6] accent-[#8066B5] text-[#8066B5] focus:ring-[#8066B5] shrink-0"
                                />
                              </div>

                              <div className="pt-1.5 border-t border-[#E8E4EF]/70 text-[11.5px] text-[#777287] flex items-center justify-between gap-1.5">
                                <span className="truncate">
                                  {s.grace_minutes !== undefined && s.grace_minutes !== null
                                    ? `ผ่อนผัน ${s.grace_minutes} นาที`
                                    : 'ตามเวลามาตรฐาน'}
                                </span>
                                <span className="font-mono text-[11px] text-[#777287] shrink-0">
                                  {s.shift_code}
                                  {isCross ? ' (+1 วัน)' : ''}
                                </span>
                              </div>
                            </label>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>

                {/* สรุปกะที่เลือกไว้ในรูปแบบ Chip พร้อมปุ่ม X เอาออกทีละกะ */}
                {bulkOperationMode !== 'CLEAR_ALL_SHIFTS' && (
                  <div className="pt-2.5 border-t border-[#E8E4EF]/80 space-y-1.5 min-w-0">
                    <div className="text-[12px] font-semibold text-[#292638]">
                      แม่แบบกะที่เลือก ({selectedShiftTemplates.length} กะ):
                    </div>
                    {selectedShiftTemplates.length === 0 ? (
                      <div className="p-2.5 rounded-lg bg-[#F8F7FC] border border-dashed border-[#E8E4EF] text-[12px] text-[#777287] text-center">
                        ยังไม่ได้เลือกแม่แบบกะ กรุณาติ๊กเลือกอย่างน้อย 1 กะ
                      </div>
                    ) : (
                      <div className="max-h-28 overflow-y-auto p-2 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] flex flex-wrap gap-1.5">
                        {selectedShiftTemplates.map((s) => {
                          const sid = Number(s.id);
                          const isCross = Number(s.is_cross_midnight) === 1;
                          const isConflicting = overlappingShiftIdSet.has(sid);
                          const iconKind = classifyShiftIconKind({
                            shiftCode: s.shift_code,
                            shiftName: s.shift_name,
                            shiftCategory: s.shift_category,
                            startTime: s.start_time,
                            endTime: s.end_time,
                            isCrossMidnight: isCross,
                          });
                          return (
                            <span
                              key={sid}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-white border text-[12px] text-[#292638] max-w-full ${
                                isConflicting ? 'border-red-300' : 'border-[#E8E4EF]'
                              }`}
                            >
                              {renderShiftIcon(iconKind, 'w-3.5 h-3.5')}
                              <span className="font-semibold truncate">
                                {formatCleanShiftName(s.shift_name)}
                              </span>
                              <span className="font-mono text-[11.5px] text-[#8066B5] shrink-0">
                                {s.start_time}–{s.end_time}
                                {isCross ? ' (+1 วัน)' : ''}
                              </span>
                              <button
                                type="button"
                                onClick={() => toggleAssignShiftId(sid)}
                                className="text-[#777287] hover:text-red-600 shrink-0"
                                title={`นำกะ ${formatCleanShiftName(s.shift_name)} ออก`}
                                aria-label={`นำกะ ${formatCleanShiftName(s.shift_name)} ออก`}
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>

          {/* =================================================================
              ขั้นตอนที่ ②: เลือกวันที่ปฏิบัติงาน
              พื้นหลังขาว (#FFFFFF) | Header แถบม่วงอ่อน (#F1ECFA)
             ================================================================= */}
          <section className="bg-white border border-[#E8E4EF] rounded-2xl shadow-xs overflow-hidden">
            <div className="bg-[#F1ECFA] border-b border-[#E8E4EF] px-5 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
              <div className="flex items-start gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className="w-7 h-7 rounded-full bg-[#8066B5] text-white font-bold text-[13.5px] flex items-center justify-center shrink-0 mt-0.5 shadow-2xs"
                >
                  2
                </span>
                <div className="min-w-0">
                  <h3 className="text-[15.5px] font-bold text-[#292638] leading-snug">
                    เลือกวันที่ปฏิบัติงาน <RequiredMark />
                  </h3>
                  <p className="text-[12.5px] text-[#777287] mt-0.5">
                    เลือกวันเดียว เลือกหลายวันจากปฏิทิน หรือเลือกช่วงวันที่พร้อมกรองเฉพาะวันจันทร์–ศุกร์ได้
                  </p>
                </div>
              </div>
              <span className="font-mono text-[13px] font-bold text-[#8066B5] bg-white border border-[#E8E4EF] px-3 py-1 rounded-lg shrink-0 tabular-nums self-start sm:self-auto ml-10 sm:ml-0">
                เลือกแล้ว {effectiveSelectedDates.length} วัน
              </span>
            </div>

            <div className="p-5 bg-white space-y-4">
              <div className="inline-flex flex-wrap items-center p-1 bg-[#F8F7FC] border border-[#E8E4EF] rounded-lg gap-1">
                <button
                  type="button"
                  onClick={() => setDatePickStrategy('SINGLE_DAY')}
                  className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
                    datePickStrategy === 'SINGLE_DAY'
                      ? 'bg-white text-[#8066B5] shadow-2xs border border-[#E8E4EF]'
                      : 'text-[#777287] hover:text-[#292638]'
                  }`}
                >
                  เลือกวันเดียว
                </button>
                <button
                  type="button"
                  onClick={() => setDatePickStrategy('MULTI_PICK')}
                  className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
                    datePickStrategy === 'MULTI_PICK'
                      ? 'bg-white text-[#8066B5] shadow-2xs border border-[#E8E4EF]'
                      : 'text-[#777287] hover:text-[#292638]'
                  }`}
                >
                  เลือกหลายวันจากปฏิทิน
                </button>
                <button
                  type="button"
                  onClick={() => setDatePickStrategy('DATE_RANGE')}
                  className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold transition-colors ${
                    datePickStrategy === 'DATE_RANGE'
                      ? 'bg-white text-[#8066B5] shadow-2xs border border-[#E8E4EF]'
                      : 'text-[#777287] hover:text-[#292638]'
                  }`}
                >
                  เลือกช่วงวันที่ (จันทร์–ศุกร์ / ทุกวัน)
                </button>
              </div>

              {datePickStrategy === 'SINGLE_DAY' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                  <div>
                    <label className="block text-[13px] font-semibold text-[#292638] mb-1.5">
                      ระบุวันที่ต้องการจัดเวร
                    </label>
                    <input
                      type="date"
                      value={singleWorkDate}
                      onChange={(e) => setSingleWorkDate(e.target.value)}
                      className="w-full h-10 px-3 rounded-lg border border-[#E8E4EF] bg-white font-mono text-[13.5px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                    />
                  </div>
                  <div className="p-2.5 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] text-[13px] text-[#292638]">
                    วันที่เลือก:{' '}
                    <strong className="font-semibold">
                      {singleWorkDate ? formatThaiDate(singleWorkDate) : '-'}
                    </strong>
                  </div>
                </div>
              )}

              {datePickStrategy === 'MULTI_PICK' && (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[13px] font-semibold text-[#292638]">
                      ปฏิทินเดือน {formatThaiMonthTitle(selectedMonth)}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => quickPickMonthDates('WEEKDAYS_MONTH')}
                        className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-[#F1ECFA] hover:bg-[#E9DFF5] text-[#8066B5] text-[12px] font-semibold"
                      >
                        เฉพาะจันทร์–ศุกร์ทั้งเดือน
                      </button>
                      <button
                        type="button"
                        onClick={() => quickPickMonthDates('ALL_MONTH')}
                        className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12px] font-medium"
                      >
                        ทุกวันทั้งเดือน
                      </button>
                      <button
                        type="button"
                        onClick={() => quickPickMonthDates('FIRST_HALF')}
                        className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12px] font-medium"
                      >
                        วันที่ 1–15
                      </button>
                      <button
                        type="button"
                        onClick={() => quickPickMonthDates('SECOND_HALF')}
                        className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12px] font-medium"
                      >
                        วันที่ 16–{monthBounds.daysInMonth}
                      </button>
                      <button
                        type="button"
                        onClick={() => quickPickMonthDates('CLEAR')}
                        className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-white hover:bg-red-50 text-red-700 text-[12px] font-medium"
                      >
                        ล้างวันที่
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-7 gap-1.5 p-3 bg-[#F8F7FC] border border-[#E8E4EF] rounded-xl">
                    {monthBounds.allDates.map((d) => {
                      const active = multiPickedDates.includes(d.dateStr);
                      return (
                        <button
                          key={d.dateStr}
                          type="button"
                          onClick={() => toggleMultiPickedDate(d.dateStr)}
                          className={`h-11 rounded-lg font-mono text-[12.5px] flex flex-col items-center justify-center border transition-colors ${
                            active
                              ? 'bg-[#8066B5] border-[#8066B5] text-white font-bold'
                              : d.isWeekend
                                ? 'bg-amber-50/70 border-amber-200 text-amber-950 hover:border-[#8066B5]'
                                : 'bg-white border-[#E8E4EF] text-[#292638] hover:border-[#8066B5]'
                          }`}
                        >
                          <span
                            className={`text-[10px] leading-none ${
                              active
                                ? 'text-violet-100'
                                : d.isWeekend
                                  ? 'text-amber-700 font-semibold'
                                  : 'text-[#777287]'
                            }`}
                          >
                            {d.weekdayShort}
                          </span>
                          <span className="leading-tight mt-0.5">{d.dayNum}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {datePickStrategy === 'DATE_RANGE' && (
                <div className="space-y-3.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                        ตั้งแต่วันที่
                      </label>
                      <input
                        type="date"
                        value={rangeStartDate}
                        onChange={(e) => setRangeStartDate(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg border border-[#E8E4EF] bg-white font-mono text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                      />
                    </div>

                    <div>
                      <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                        ถึงวันที่
                      </label>
                      <input
                        type="date"
                        value={rangeEndDate}
                        onChange={(e) => setRangeEndDate(e.target.value)}
                        className="w-full h-10 px-3 rounded-lg border border-[#E8E4EF] bg-white font-mono text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                      />
                    </div>

                    <div>
                      <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                        เงื่อนไขวันในสัปดาห์
                      </label>
                      <select
                        value={weekdayFilter}
                        onChange={(e) => setWeekdayFilter(e.target.value as WeekdayFilterMode)}
                        className="w-full h-10 px-3 rounded-lg border border-[#E8E4EF] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                      >
                        <option value="ALL_DAYS">เลือกทุกวันในช่วง</option>
                        <option value="WEEKDAYS_ONLY">เฉพาะวันจันทร์ – ศุกร์</option>
                        <option value="WEEKENDS_ONLY">เฉพาะวันเสาร์ – อาทิตย์</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-[#777287]">ตั้งช่วงวันที่ด่วน:</span>
                    <button
                      type="button"
                      onClick={() => {
                        setRangeStartDate(monthBounds.dateFrom);
                        setRangeEndDate(monthBounds.dateTo);
                        setWeekdayFilter('WEEKDAYS_ONLY');
                      }}
                      className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-[#F1ECFA] hover:bg-[#E9DFF5] text-[#8066B5] text-[12px] font-semibold"
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
                      className="h-7 px-2.5 rounded-md border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12px] font-medium"
                    >
                      ทุกวัน ตลอดเดือน{THAI_FULL_MONTHS[monthBounds.month - 1]}
                    </button>
                  </div>
                </div>
              )}

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
          </section>

          {/* =================================================================
              ขั้นตอนที่ ③: ตรวจสอบและยืนยัน
              พื้นหลังม่วงอ่อนมาก (#F8F7FC) | Header แถบม่วงอ่อน (#F1ECFA)
              Summary Cards และตารางผล Preview ใช้พื้นหลังขาว (#FFFFFF)
             ================================================================= */}
          <section className="bg-[#F8F7FC] border border-[#E8E4EF] rounded-2xl shadow-xs overflow-hidden">
            <div className="bg-[#F1ECFA] border-b border-[#E8E4EF] px-5 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3">
              <div className="flex items-start gap-3 min-w-0">
                <span
                  aria-hidden="true"
                  className="w-7 h-7 rounded-full bg-[#8066B5] text-white font-bold text-[13.5px] flex items-center justify-center shrink-0 mt-0.5 shadow-2xs"
                >
                  3
                </span>
                <div className="min-w-0">
                  <h3 className="text-[15.5px] font-bold text-[#292638] leading-snug">
                    ตรวจสอบและยืนยัน
                  </h3>
                  <p className="text-[12.5px] text-[#777287] mt-0.5">
                    ตรวจสอบกะทับซ้อน กะข้ามวัน และรายการที่จะได้รับผลกระทบก่อนบันทึกลงระบบจริง
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 pl-10 md:pl-0">
                <button
                  type="button"
                  onClick={handleRunConflictPreview}
                  disabled={previewLoading || submittingBulk}
                  className="h-10 px-4 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] hover:border-[#8066B5] disabled:opacity-50 text-[#8066B5] text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shadow-2xs"
                >
                  <FileCheck2 className="w-4 h-4 text-[#8066B5]" />
                  <span>
                    {previewLoading ? 'กำลังตรวจสอบ Preview...' : '1. ตรวจสอบ Preview ก่อนบันทึก'}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleRequestConfirmBulkAssign}
                  disabled={
                    submittingBulk ||
                    previewLoading ||
                    hasSameDayClientShiftOverlap ||
                    Boolean(previewError) ||
                    !previewData ||
                    previewData.summary.readyCount === 0 ||
                    ((bulkOperationMode === 'ADD_SHIFTS' ||
                      bulkOperationMode === 'REPLACE_SHIFTS') &&
                      conflictStrategy === 'ABORT_ON_CONFLICT' &&
                      previewData.summary.conflictCount > 0)
                  }
                  className={`h-10 px-5 rounded-lg disabled:opacity-40 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap shadow-2xs ${
                    bulkOperationMode === 'CLEAR_ALL_SHIFTS' ||
                    bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
                      ? 'bg-red-700 hover:bg-red-800'
                      : bulkOperationMode === 'REPLACE_SHIFTS'
                        ? 'bg-amber-700 hover:bg-amber-800'
                        : 'bg-[#8066B5] hover:bg-[#6E54A3]'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>
                    {submittingBulk
                      ? 'กำลังบันทึก...'
                      : previewData
                        ? bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                          ? `2. ยืนยันลบกะทั้งหมด (${previewData.summary.readyCount} วัน-คน)`
                          : bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
                            ? `2. ยืนยันลบกะที่เลือก (${previewData.summary.readyCount} รายการ)`
                            : bulkOperationMode === 'REPLACE_SHIFTS'
                              ? `2. ยืนยันแทนที่กะเดิม (${previewData.summary.readyCount} รายการ)`
                              : `2. ยืนยันเพิ่มเวร (${previewData.summary.readyCount} รายการ)`
                        : '2. ยืนยันดำเนินการ'}
                  </span>
                </button>
              </div>
            </div>

            <div className="p-4 sm:p-5 space-y-4">
              {/* นโยบายจัดการความขัดแย้ง และหมายเหตุเหตุผล (การ์ดพื้นหลังขาว) */}
              <div className="bg-white border border-[#E8E4EF] rounded-xl p-4 grid grid-cols-1 md:grid-cols-2 gap-3.5">
                {(bulkOperationMode === 'ADD_SHIFTS' || bulkOperationMode === 'REPLACE_SHIFTS') && (
                  <div>
                    <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                      นโยบายเมื่อพบรายการซ้ำหรือเวลาทับซ้อน:
                    </label>
                    <select
                      value={conflictStrategy}
                      onChange={(e) => setConflictStrategy(e.target.value as ConflictStrategyMode)}
                      className="w-full h-9.5 px-3 rounded-lg border border-[#E8E4EF] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                    >
                      <option value="SKIP_CONFLICTS">
                        ข้ามเฉพาะรายการที่ซ้ำ/เวลาทับซ้อน และบันทึกเฉพาะรายการที่พร้อม (แนะนำ)
                      </option>
                      <option value="ABORT_ON_CONFLICT">
                        ยกเลิกทั้งหมดหากพบรายการขัดแย้งแม้แต่รายการเดียว
                      </option>
                    </select>
                  </div>
                )}

                {bulkOperationMode !== 'ADD_SHIFTS' && (
                  <div>
                    <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                      หมายเหตุ / เหตุผลการแก้ไขหรือลบกะ (บันทึกประวัติตรวจสอบ):
                    </label>
                    <input
                      type="text"
                      value={bulkActionReason}
                      onChange={(e) => setBulkActionReason(e.target.value)}
                      placeholder="เช่น ปรับตารางเวรประจำเดือนตามคำสั่งหัวหน้ากลุ่มงาน"
                      className="w-full h-9.5 px-3 rounded-lg border border-[#E8E4EF] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                    />
                  </div>
                )}
              </div>

              {/* แจ้งเตือนซ้ำในขั้นตอนที่ 3 หากยังมีกะที่ทับซ้อนกันอยู่ */}
              {clientShiftOverlaps.length > 0 && !previewError && (
                <div
                  role="alert"
                  className="p-3.5 rounded-xl bg-red-50 border border-red-300 text-red-950 text-[13px] flex items-start gap-2.5"
                >
                  <AlertTriangle className="w-4.5 h-4.5 text-red-600 shrink-0 mt-0.5" />
                  <div className="space-y-0.5">
                    <div className="font-bold text-red-900">
                      พบแม่แบบกะที่มีเวลาทับซ้อนกัน ({clientShiftOverlaps.length} คู่)
                    </div>
                    <p className="text-[12.5px] text-red-900">
                      กรุณาตรวจสอบและปรับการเลือกแม่แบบกะในขั้นตอนที่ 1 ก่อนบันทึก (Backend จะตรวจสอบซ้ำอีกครั้งก่อนบันทึกเสมอ)
                    </p>
                  </div>
                </div>
              )}

              {/* แสดงข้อผิดพลาดจากการตรวจสอบ Preview พร้อม Request ID */}
              {previewError && (
                <div
                  role="alert"
                  className="p-4 rounded-xl bg-red-50 border border-red-300 text-red-950 text-[13.5px] flex items-start gap-3"
                >
                  <AlertTriangle className="w-5 h-5 text-red-700 shrink-0 mt-0.5" />
                  <div className="space-y-1 min-w-0">
                    <div className="font-bold text-red-900 flex flex-wrap items-center gap-2">
                      <span>ไม่สามารถดำเนินการได้</span>
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
                    <p className="text-red-900 break-words">{previewError.message}</p>
                  </div>
                </div>
              )}

              {/* ตารางสรุปผลการตรวจสอบ Preview (Summary Cards พื้นหลังขาว #FFFFFF) */}
              {previewData ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                    <div className="p-3.5 rounded-xl bg-white border border-[#E8E4EF] shadow-2xs">
                      <div className="text-[12px] text-[#777287] font-medium">
                        รายการที่ตรวจสอบทั้งหมด
                      </div>
                      <div className="text-[20px] font-bold font-mono tabular-nums text-[#292638] mt-0.5">
                        {previewData.summary.totalRequested} รายการ
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-emerald-200 shadow-2xs">
                      <div className="text-[12px] text-emerald-800 font-semibold">
                        พร้อมดำเนินการ
                      </div>
                      <div className="text-[20px] font-bold font-mono tabular-nums text-emerald-700 mt-0.5">
                        {previewData.summary.readyCount} รายการ
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-amber-200 shadow-2xs">
                      <div className="text-[12px] text-amber-800 font-semibold">
                        กะซ้ำที่มีอยู่แล้ว
                      </div>
                      <div className="text-[20px] font-bold font-mono tabular-nums text-amber-800 mt-0.5">
                        {previewData.summary.duplicateCount} รายการ
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-amber-200 shadow-2xs">
                      <div className="text-[12px] text-amber-800 font-semibold">
                        เวลาทับซ้อน / ข้ามวัน
                      </div>
                      <div className="text-[20px] font-bold font-mono tabular-nums text-amber-800 mt-0.5">
                        {previewData.summary.overlapCount} รายการ
                      </div>
                    </div>

                    <div className="p-3.5 rounded-xl bg-white border border-[#E8E4EF] shadow-2xs">
                      <div className="text-[12px] text-[#8066B5] font-semibold">
                        {bulkOperationMode === 'REPLACE_SHIFTS'
                          ? 'ช่องที่จะถูกแทนที่กะเดิม'
                          : bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                            ? 'ช่องที่จะตั้งเป็นไม่มีเวร'
                            : bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
                              ? 'ไม่พบกะเดิมให้ลบ'
                              : 'ขัดแย้ง / ถูกข้าม'}
                      </div>
                      <div className="text-[20px] font-bold font-mono tabular-nums text-[#8066B5] mt-0.5">
                        {bulkOperationMode === 'REPLACE_SHIFTS'
                          ? `${previewData.summary.replaceAffectedCells || 0} วัน-คน`
                          : bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                            ? `${previewData.summary.clearAffectedCells || 0} วัน-คน`
                            : bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
                              ? `${previewData.summary.notAssignedCount || 0} รายการ`
                              : `${previewData.summary.conflictCount} รายการ`}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="inline-flex flex-wrap items-center p-1 bg-white border border-[#E8E4EF] rounded-lg self-start gap-1">
                      <button
                        type="button"
                        onClick={() => setPreviewFilterTab('ALL')}
                        className={`px-3 py-1 rounded-md text-[12.5px] font-semibold ${
                          previewFilterTab === 'ALL'
                            ? 'bg-[#F1ECFA] text-[#8066B5]'
                            : 'text-[#777287] hover:text-[#292638]'
                        }`}
                      >
                        ทั้งหมด ({previewData.items.length})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewFilterTab('READY')}
                        className={`px-3 py-1 rounded-md text-[12.5px] font-semibold ${
                          previewFilterTab === 'READY'
                            ? 'bg-emerald-50 text-emerald-800'
                            : 'text-[#777287] hover:text-[#292638]'
                        }`}
                      >
                        พร้อมดำเนินการ ({previewData.summary.readyCount})
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewFilterTab('CONFLICT')}
                        className={`px-3 py-1 rounded-md text-[12.5px] font-semibold ${
                          previewFilterTab === 'CONFLICT'
                            ? 'bg-amber-50 text-amber-900'
                            : 'text-[#777287] hover:text-[#292638]'
                        }`}
                      >
                        ขัดแย้ง / ข้าม (
                        {previewData.items.length - previewData.summary.readyCount})
                      </button>
                    </div>

                    <div className="text-[12.5px] text-[#777287]">
                      {bulkOperationMode === 'CLEAR_ALL_SHIFTS' ? (
                        <strong className="text-red-700">โหมด: ลบกะทั้งหมด (ตั้งเป็นไม่มีเวร)</strong>
                      ) : (
                        <>
                          กะที่เลือก ({(previewData.shiftSnapshots || []).length || 1} กะ):{' '}
                          <strong className="text-[#8066B5]">
                            {(previewData.shiftSnapshots && previewData.shiftSnapshots.length > 0
                              ? previewData.shiftSnapshots
                              : previewData.shiftSnapshot
                                ? [previewData.shiftSnapshot]
                                : []
                            )
                              .map(
                                (sn: any) =>
                                  `${formatCleanShiftName(sn.shiftName)} (${sn.startTime}–${sn.endTime})`
                              )
                              .join(', ')}
                          </strong>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="bg-white border border-[#E8E4EF] rounded-xl overflow-hidden shadow-2xs">
                    <div className="max-h-72 overflow-y-auto overflow-x-auto">
                      <table className="w-full min-w-[640px] text-left border-collapse text-[13px]">
                        <thead className="sticky top-0 bg-[#F1ECFA] border-b border-[#E8E4EF] text-[#292638]">
                          <tr>
                            <th className="py-2.5 px-3.5 font-semibold">วันที่ปฏิบัติงาน</th>
                            <th className="py-2.5 px-3.5 font-semibold">บุคลากร · กลุ่มงาน</th>
                            <th className="py-2.5 px-3.5 font-semibold">กะที่ดำเนินการ</th>
                            <th className="py-2.5 px-3.5 font-semibold">สถานะและเหตุผล</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-[#E8E4EF]/70">
                          {filteredPreviewItems.map((item, idx) => {
                            const displayShiftName =
                              item.shiftName || previewData.shiftSnapshot?.shiftName;
                            const displayStart =
                              item.startTime || previewData.shiftSnapshot?.startTime;
                            const displayEnd = item.endTime || previewData.shiftSnapshot?.endTime;
                            const iconKind = displayShiftName
                              ? classifyShiftIconKind({
                                  shiftCode: item.shiftCode || previewData.shiftSnapshot?.shiftCode,
                                  shiftName: displayShiftName,
                                  startTime: displayStart,
                                  endTime: displayEnd,
                                  isCrossMidnight: item.isCrossMidnight,
                                })
                              : null;

                            return (
                              <tr
                                key={`${item.personId}-${item.workDate}-${item.shiftId ?? 'clear'}-${idx}`}
                                className={item.status === 'READY' ? 'bg-white' : 'bg-amber-50/40'}
                              >
                                <td className="py-2.5 px-3.5 font-mono tabular-nums font-semibold text-[#292638] whitespace-nowrap">
                                  {formatThaiDate(item.workDate)}
                                </td>
                                <td className="py-2.5 px-3.5">
                                  <span className="font-bold text-[#292638]">{item.fullName}</span>{' '}
                                  <span className="text-[12px] font-mono text-[#777287]">
                                    ({item.personId}) · {item.departmentName}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3.5 text-[#292638] whitespace-nowrap">
                                  {bulkOperationMode === 'CLEAR_ALL_SHIFTS' ? (
                                    <span className="font-semibold text-red-700">
                                      ลบทุกกะ (ตั้งเป็นไม่มีเวร)
                                    </span>
                                  ) : (
                                    <span className="inline-flex items-center gap-1.5">
                                      {iconKind && renderShiftIcon(iconKind, 'w-3.5 h-3.5')}
                                      <span className="font-semibold">
                                        {formatCleanShiftName(displayShiftName)}
                                      </span>
                                      <span className="font-mono text-[12px] text-[#777287]">
                                        ({displayStart}–{displayEnd} น.)
                                      </span>
                                    </span>
                                  )}
                                </td>
                                <td className="py-2.5 px-3.5">
                                  {item.status === 'READY' ? (
                                    <span className="text-emerald-700 font-semibold">
                                      {bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                                        ? item.existingOnDateCount && item.existingOnDateCount > 0
                                          ? `พร้อมลบกะเดิม ${item.existingOnDateCount} กะ และตั้งเป็นไม่มีเวร`
                                          : 'พร้อมตั้งเป็นไม่มีเวร (คงสถานะไม่สร้างกะอัตโนมัติ)'
                                        : bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
                                          ? 'พบกะนี้ในระบบ พร้อมลบออก'
                                          : bulkOperationMode === 'REPLACE_SHIFTS' &&
                                              item.existingOnDateCount &&
                                              item.existingOnDateCount > 0
                                            ? `พร้อมบันทึก (จะแทนที่กะเดิม ${item.existingOnDateCount} กะในวันนี้)`
                                            : 'พร้อมบันทึก (ไม่มีเวรซ้ำหรือเวลาทับซ้อน)'}
                                    </span>
                                  ) : (
                                    <div className="text-amber-900 font-semibold">
                                      <span>
                                        {item.status === 'DUPLICATE_SAME_SHIFT'
                                          ? 'มีเวรนี้อยู่แล้ว: '
                                          : item.status === 'NOT_ASSIGNED'
                                            ? 'ไม่พบกะเดิม: '
                                            : 'เวลาทับซ้อน: '}
                                        {item.conflictMessage}
                                      </span>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-white border border-dashed border-[#E8E4EF] text-center text-[13.5px] text-[#777287]">
                  เลือกบุคลากร ({filteredPersonSelectionMeta.uniqueSelectedTotalCount} คน) ·{' '}
                  {bulkOperationMode === 'CLEAR_ALL_SHIFTS'
                    ? 'ล้างทุกกะ'
                    : `กะที่เลือก (${selectedShiftIds.length} กะ)`}{' '}
                  · วันที่ ({effectiveSelectedDates.length} วัน) แล้วกดปุ่ม{' '}
                  <strong className="text-[#8066B5]">“1. ตรวจสอบ Preview ก่อนบันทึก”</strong>{' '}
                  เพื่อดูผลกระทบและความซ้ำซ้อนก่อนยืนยัน
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* =====================================================================
          หน้าจอที่ 3: แม่แบบกะทำงาน (SHIFT TEMPLATES MANAGEMENT)
          แสดงชื่อกะและเวลาเพียงครั้งเดียว ไม่แสดงรหัสและข้อความเวลาซ้ำซ้อน
         ===================================================================== */}
      {activeTab === 'TEMPLATES' && (
        <div className="space-y-5">
          <div className="ent-card p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative w-full sm:max-w-md">
              <Search className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="ค้นหาชื่อแม่แบบกะทำงาน หรือรหัสกะ..."
                className="ent-input pl-9 pr-3 w-full"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[13px] text-[#777287] tabular-nums">
                แสดง {filteredShifts.length} จาก {shifts.length} แม่แบบกะ
              </span>
              {canEditShifts && (
                <>
                  <button
                    type="button"
                    onClick={() => openChangeDefaultModal()}
                    className="h-10 px-3.5 rounded-lg border border-[#D8D1E6] bg-[#F1ECFA] hover:bg-[#E7DDF8] text-[#4E3978] text-[13px] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <ArrowRightLeft className="w-4 h-4" />
                    <span>จัดการ/เปลี่ยนกะเริ่มต้น</span>
                  </button>
                  <button
                    type="button"
                    onClick={openCreateShiftModal}
                    className="ent-btn-primary whitespace-nowrap"
                  >
                    <Plus className="w-4 h-4" />
                    <span>เพิ่มแม่แบบกะ</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* รายการแม่แบบกะทำงานแบบอ่านง่าย ไม่แสดงเวลาซ้ำซ้อน */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredShifts.map((s) => {
              const isCross = Number(s.is_cross_midnight) === 1;
              const isActive = Number(s.is_active ?? 1) === 1;
              const defaultTypes: Array<{
                personnelTypeCode?: string;
                personnelTypeName?: string;
                personnel_type_code?: string;
                personnel_type_name?: string;
              }> = Array.isArray(s.default_personnel_types) ? s.default_personnel_types : [];
              const isRealDefault = Number(s.is_default ?? 0) === 1 && defaultTypes.length > 0;
              const cleanName = formatCleanShiftName(s.shift_name);
              const categoryText =
                SHIFT_CATEGORY_LABELS[String(s.shift_category || '').toUpperCase()] ||
                s.shift_category ||
                'เวรปฏิบัติงาน';
              return (
                <div
                  key={s.id}
                  className={`his-surface p-5 flex flex-col justify-between space-y-4 transition-colors ${
                    isRealDefault
                      ? 'border-[#8066B5]/60 hover:border-[#8066B5]'
                      : 'hover:border-[#8066B5]/50'
                  }`}
                >
                  {/* หัวการ์ด: ชื่อกะเด่นชัด + ตัวบ่งชี้กะเริ่มต้นจากฐานข้อมูลจริง */}
                  <div className="space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="space-y-1 min-w-0">
                        <h3 className="text-[16.5px] font-bold text-[#292638] leading-snug">
                          {cleanName}
                        </h3>
                        {isRealDefault && (
                          <StatusBadge
                            tone="brand"
                            icon={<Star className="w-3.5 h-3.5 fill-current" aria-hidden="true" />}
                          >
                            กะเริ่มต้น
                          </StatusBadge>
                        )}
                      </div>
                      <StatusBadge
                        tone={isCross ? 'info' : 'success'}
                        icon={
                          isCross ? (
                            <Moon className="w-3.5 h-3.5" aria-hidden="true" />
                          ) : (
                            <Sun className="w-3.5 h-3.5" aria-hidden="true" />
                          )
                        }
                      >
                        {isCross ? 'เวรข้ามวัน' : 'ภายในวัน'}
                      </StatusBadge>
                    </div>

                    <div className="text-[19px] font-bold font-mono tabular-nums text-[#4E3978]">
                      {s.start_time}–{s.end_time} น.
                    </div>

                    <div className="text-[12.5px] text-[#777287]">
                      รหัสกะ: <span className="font-mono text-[#292638] font-medium">{s.shift_code}</span> ·{' '}
                      {categoryText}
                    </div>

                    {isRealDefault && (
                      <div className="rounded-lg bg-[#F1ECFA]/70 border border-[#D8D1E6] px-3 py-2 text-[12px] text-[#4E3978]">
                        <span className="font-semibold">กะเริ่มต้นสำหรับ:</span>{' '}
                        <span>
                          {defaultTypes
                            .map((dt) => dt.personnelTypeName || dt.personnel_type_name || dt.personnelTypeCode)
                            .join(', ')}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* รายละเอียด 5 รายการ */}
                  <div className="pt-3 border-t border-[#E8E4EF] space-y-1.5 text-[13.5px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[#777287]">เวลาเริ่มงาน</span>
                      <span className="font-mono font-semibold text-[#292638] tabular-nums">
                        {s.start_time} น.
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#777287]">เวลาเลิกงาน</span>
                      <span className="font-mono font-semibold text-[#292638] tabular-nums">
                        {s.end_time} น. {isCross ? '(วันถัดไป)' : ''}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#777287]">เวลาผ่อนผันการมาสาย</span>
                      <span className="font-mono font-semibold text-[#198568] tabular-nums">
                        {s.grace_minutes} นาที
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#777287]">เวลาตัดรอบสแกน</span>
                      <span className="font-mono font-semibold text-[#B87516] tabular-nums">
                        {s.cutoff_time} น.
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#777287]">สถานะเปิดใช้งาน</span>
                      <StatusBadge tone={isActive ? 'success' : 'neutral'} dot>
                        {isActive ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                      </StatusBadge>
                    </div>
                  </div>

                  <div className="pt-2 space-y-2">
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          openAssignWorkspace({
                            method: 'SINGLE_PERSON',
                            shiftId: Number(s.id),
                          })
                        }
                        className="ent-btn-soft h-9 px-3 text-[12.5px]"
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
                        className="ent-btn-primary h-9 px-3 text-[12.5px]"
                      >
                        <Users className="w-3.5 h-3.5" />
                        <span>จัดเวรหลายคน</span>
                      </button>
                    </div>

                    {canEditShifts && (
                      <div className="space-y-1.5 pt-1.5 border-t border-[#E8E4EF]/80">
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => openEditShiftModal(s)}
                            className="h-8 px-2.5 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5 text-[#4E3978]" />
                            <span>แก้ไขแม่แบบกะ</span>
                          </button>
                          <button
                            type="button"
                            disabled={!isActive}
                            onClick={() =>
                              openChangeDefaultModal({
                                shiftId: Number(s.id),
                                scopeCode:
                                  defaultTypes[0]?.personnelTypeCode ||
                                  defaultTypes[0]?.personnel_type_code,
                              })
                            }
                            className="h-8 px-2.5 rounded-lg border border-[#D8D1E6] bg-[#F1ECFA]/60 hover:bg-[#E7DDF8] disabled:opacity-50 text-[#4E3978] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                            <span>{isRealDefault ? 'จัดการกะเริ่มต้น' : 'ตั้งเป็นกะเริ่มต้น'}</span>
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => handleRequestToggleShiftActive(s)}
                          className={`w-full h-8 px-2.5 rounded-lg border text-[12px] font-medium inline-flex items-center justify-center gap-1.5 transition-colors ${
                            isActive
                              ? 'border-[#E8E4EF] bg-white hover:bg-[#FFF5F6] hover:border-[#F2CDD3] text-[#777287] hover:text-[#9E2A3A]'
                              : 'border-[#BCE7D9] bg-[#ECF8F4] hover:bg-[#DCF3EB] text-[#116952]'
                          }`}
                        >
                          <Power className="w-3.5 h-3.5" />
                          <span>{isActive ? 'ปิดใช้งานแม่แบบกะนี้' : 'เปิดใช้งานแม่แบบกะนี้'}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* =================================================================
              ส่วนที่ 3.2: กฎกะเช้าเริ่มต้นตามประเภทบุคลากร (Personnel Type Default Shift Rules)
             ================================================================= */}
          <div className="bg-white border border-[#E8E4EF] rounded-xl p-5 space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#E8E4EF] pb-4">
              <div>
                <div className="text-[12px] font-semibold text-[#4E3978]">
                  กฎกะเช้าเริ่มต้นอัตโนมัติตามประเภทบุคลากร (Default Morning Shift by Personnel Type)
                </div>
                <h3 className="text-[17px] font-bold text-[#292638]">
                  กำหนดเวลาเริ่ม–เลิกงาน กะเช้าเริ่มต้น และเวลาผ่อนผันสายแยกตามประเภทบุคลากร
                </h3>
                <p className="text-[13px] text-[#777287] mt-0.5">
                  หากบุคลากรไม่มีการจัดเวรพิเศษและไม่ได้ถูกลบเวรในวันนั้น ระบบจะใช้กะเช้าเริ่มต้นตามประเภทบุคลากรโดยอัตโนมัติ (การแก้ไขมีผลตั้งแต่วันที่มีผลบังคับใช้เป็นต้นไป ไม่กระทบข้อมูลย้อนหลัง)
                </p>
              </div>
              {canEditShifts && (
                <button
                  type="button"
                  onClick={() => setShowAddRuleForm((v) => !v)}
                  className="h-10 px-4 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] text-white text-[13px] font-semibold inline-flex items-center gap-1.5 shrink-0"
                >
                  <Plus className="w-4 h-4" />
                  <span>{showAddRuleForm ? 'ปิดฟอร์มเพิ่มประเภทบุคลากร' : 'เพิ่มประเภทบุคลากรใหม่'}</span>
                </button>
              )}
            </div>

            {showAddRuleForm && (
              <form
                onSubmit={handleCreateRule}
                className="p-4 rounded-xl bg-[#F1ECFA]/50 border border-[#E8E4EF] grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end"
              >
                <div>
                  <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                    รหัสประเภท <RequiredMark />
                  </label>
                  <input
                    type="text"
                    required
                    value={newRuleCode}
                    onChange={(e) => setNewRuleCode(e.target.value)}
                    placeholder="เช่น CONTRACT_EMP"
                    className="w-full h-9 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                    ชื่อประเภทบุคลากร <RequiredMark />
                  </label>
                  <input
                    type="text"
                    required
                    value={newRuleName}
                    onChange={(e) => setNewRuleName(e.target.value)}
                    placeholder="เช่น ลูกจ้างเหมาบริการ"
                    className="w-full h-9 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px]"
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                    เวลาเริ่ม–เลิกงาน
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="time"
                      value={newRuleStart}
                      onChange={(e) => setNewRuleStart(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[#D8D1E6] bg-white text-[13px] font-mono"
                    />
                    <span>–</span>
                    <input
                      type="time"
                      value={newRuleEnd}
                      onChange={(e) => setNewRuleEnd(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[#D8D1E6] bg-white text-[13px] font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                    ผ่อนผันสาย (นาที)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={180}
                    value={newRuleGrace}
                    onChange={(e) => setNewRuleGrace(Number(e.target.value))}
                    className="w-full h-9 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px] font-mono"
                  />
                </div>
                <div>
                  <label className="block text-[12.5px] font-semibold text-[#292638] mb-1">
                    เวลาตัดรอบ / วันที่มีผล
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="time"
                      value={newRuleCutoff}
                      onChange={(e) => setNewRuleCutoff(e.target.value)}
                      className="w-24 h-9 px-2 rounded-lg border border-[#D8D1E6] bg-white text-[12.5px] font-mono"
                    />
                    <input
                      type="date"
                      value={newRuleEffectiveFrom}
                      onChange={(e) => setNewRuleEffectiveFrom(e.target.value)}
                      className="w-full h-9 px-2 rounded-lg border border-[#D8D1E6] bg-white text-[12.5px] font-mono"
                    />
                  </div>
                </div>
                <div>
                  <button
                    type="submit"
                    disabled={ruleSaving}
                    className="w-full h-9 px-4 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] text-white text-[13px] font-semibold"
                  >
                    {ruleSaving ? 'กำลังบันทึก...' : 'บันทึกกฎใหม่'}
                  </button>
                </div>
              </form>
            )}

            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-[13.5px]">
                <thead>
                  <tr className="border-b border-[#E8E4EF] bg-[#F8F7FC] text-[#292638]">
                    <th className="py-2.5 px-3 font-semibold">ประเภทบุคลากร</th>
                    <th className="py-2.5 px-3 font-semibold">รหัสอ้างอิง</th>
                    <th className="py-2.5 px-3 font-semibold">แม่แบบกะเริ่มต้นที่ผูกไว้</th>
                    <th className="py-2.5 px-3 font-semibold">เวลากะเริ่มต้น</th>
                    <th className="py-2.5 px-3 font-semibold">เวลาผ่อนผันสาย</th>
                    <th className="py-2.5 px-3 font-semibold">เวลาตัดรอบสแกน</th>
                    <th className="py-2.5 px-3 font-semibold">วันที่มีผลบังคับใช้</th>
                    <th className="py-2.5 px-3 font-semibold">สถานะ</th>
                    {canEditShifts && (
                      <th className="py-2.5 px-3 font-semibold text-right">การจัดการ</th>
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E8E4EF]">
                  {personnelTypeRules.map((r) => {
                    const active = Number(r.is_active ?? 1) === 1;
                    const typeCode = String(r.personnel_type_code || '').trim().toUpperCase();
                    const linkedShiftId =
                      r.default_shift_id != null ? Number(r.default_shift_id) : null;
                    const linkedShiftName = r.default_shift_name
                      ? formatCleanShiftName(r.default_shift_name)
                      : null;
                    const linkedShiftCode = r.default_shift_code
                      ? String(r.default_shift_code)
                      : null;
                    const startDisplay = String(
                      r.default_shift_start_time || r.default_start_time || ''
                    ).trim();
                    const endDisplay = String(
                      r.default_shift_end_time || r.default_end_time || ''
                    ).trim();
                    const hasAnyDefaultTime = Boolean(startDisplay && endDisplay);
                    return (
                      <tr key={r.id} className="hover:bg-[#F1ECFA]/30">
                        <td className="py-2.5 px-3 font-bold text-[#292638]">
                          {r.personnel_type_name}
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[12.5px] text-[#777287]">
                          {r.personnel_type_code}
                        </td>
                        <td className="py-2.5 px-3">
                          {linkedShiftId && linkedShiftName ? (
                            <div className="flex flex-col">
                              <span className="font-semibold text-[#4E3978] inline-flex items-center gap-1">
                                <Star className="w-3.5 h-3.5 text-[#8066B5] fill-current shrink-0" aria-hidden="true" />
                                <span>{linkedShiftName}</span>
                              </span>
                              {linkedShiftCode && (
                                <span className="font-mono text-[11.5px] text-[#777287]">
                                  {linkedShiftCode}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-[12.5px] font-medium text-amber-800 inline-flex items-center gap-1">
                              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                              <span>ยังไม่ได้ผูกแม่แบบกะเริ่มต้น</span>
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-bold text-[#4E3978]">
                          {hasAnyDefaultTime ? (
                            `${startDisplay}–${endDisplay} น.`
                          ) : (
                            <span className="text-[12.5px] font-sans font-medium text-[#777287]">
                              ไม่พบกะที่กำหนด
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-semibold text-emerald-700">
                          {r.default_shift_grace_minutes ?? r.default_grace_minutes ?? 15} นาที
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-amber-800">
                          {r.default_shift_cutoff_time || r.default_cutoff_time || '11:00'} น.
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[12.5px] text-[#777287]">
                          {formatThaiDate(String(r.effective_from || '2020-01-01').slice(0, 10))}
                        </td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`text-[12.5px] font-semibold ${
                              active ? 'text-emerald-700' : 'text-[#9A94AA]'
                            }`}
                          >
                            {active ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}
                          </span>
                        </td>
                        {canEditShifts && (
                          <td className="py-2.5 px-3 text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              onClick={() =>
                                openChangeDefaultModal({
                                  scopeCode: typeCode,
                                  shiftId: linkedShiftId ?? undefined,
                                })
                              }
                              className="h-8 px-2.5 rounded-md border border-[#8066B5]/40 bg-[#F1ECFA] hover:bg-[#E7DDF8] text-[#4E3978] text-[12px] font-semibold inline-flex items-center gap-1"
                            >
                              <ArrowRightLeft className="w-3.5 h-3.5" />
                              <span>{linkedShiftId ? 'เปลี่ยนกะเริ่มต้น' : 'กำหนดกะเริ่มต้น'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingRule({ ...r })}
                              className="h-8 px-2.5 rounded-md border border-[#E8E4EF] bg-white hover:bg-[#F8F7FC] text-[#4E3978] text-[12px] font-semibold inline-flex items-center gap-1"
                            >
                              <Edit3 className="w-3.5 h-3.5" />
                              <span>แก้ไขเวลา/ค่าสาย</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmToggleRuleTarget(r)}
                              className="h-8 px-2.5 rounded-md border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12px] font-medium"
                            >
                              {active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                            </button>
                          </td>
                        )}
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
                className="h-10 px-3.5 rounded-lg border border-[#D8D1E6] bg-[#F1ECFA] hover:bg-[#E9DFF5] text-[#4E3978] text-[13px] font-semibold inline-flex items-center gap-1.5"
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
            <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">บุคลากร:</span>
                <span className="font-bold text-[#292638]">
                  {inspectTarget.full_name} ({inspectTarget.person_id})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">กลุ่มงาน/แผนก:</span>
                <span className="font-medium text-[#292638]">{inspectTarget.department_name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">วันที่ปฏิบัติงาน:</span>
                <span className="font-mono font-bold text-[#292638]">
                  {formatThaiDate(inspectTarget.work_date)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">ชื่อกะ (Snapshot):</span>
                <span className="font-bold text-[#4E3978]">
                  {formatCleanShiftName(inspectTarget.snapshot_shift_name)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">รหัสกะ:</span>
                <span className="font-mono text-[#292638]">{inspectTarget.snapshot_shift_code}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">เวลาเริ่ม–เลิกงาน:</span>
                <span className="font-mono font-bold text-[#292638] tabular-nums">
                  {inspectTarget.snapshot_start_time}–{inspectTarget.snapshot_end_time} น.
                  {Number(inspectTarget.snapshot_is_cross_midnight) === 1
                    ? ' (ข้ามเที่ยงคืน +1 วัน)'
                    : ''}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">เวลาผ่อนผันการมาสาย:</span>
                <span className="font-mono text-emerald-700 font-semibold">
                  {inspectTarget.snapshot_grace_minutes} นาที
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">เวลาตัดรอบสแกน:</span>
                <span className="font-mono text-amber-700 font-semibold">
                  {inspectTarget.snapshot_cutoff_time} น.
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">ผู้มอบหมายเวร:</span>
                <span className="font-mono text-[#292638]">{inspectTarget.assigned_by || '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[#777287]">สถานะปัจจุบัน:</span>
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
            <div className="p-4 bg-[#F8F7FC] rounded-xl border border-[#E8E4EF] space-y-1">
              <div className="font-bold text-[15px] text-[#292638]">
                {cancelTarget.full_name} ({cancelTarget.person_id})
              </div>
              <div className="text-[#777287]">
                วันที่เวร: {formatThaiDate(cancelTarget.work_date)} · กะ:{' '}
                {formatCleanShiftName(cancelTarget.snapshot_shift_name)} (
                {cancelTarget.snapshot_start_time}–{cancelTarget.snapshot_end_time} น.)
              </div>
            </div>
            <div>
              <label className="block text-[13.5px] font-semibold text-[#292638] mb-1.5">
                ระบุเหตุผลการยกเลิกเวร <RequiredMark />
              </label>
              <textarea
                rows={3}
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full p-3 border border-[#D8D1E6] rounded-lg text-[14px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
              />
            </div>
            <div className="flex justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
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
        onClose={closeQuickCellModal}
        kickerText="จัดเวรรายวัน (Quick Daily Shift Cell)"
        title={
          quickCellTarget
            ? `${quickCellTarget.person.full_name} — ${formatThaiDate(quickCellTarget.workDate)}`
            : 'จัดเวรรายวัน'
        }
        maxWidthClass="max-w-xl"
      >
        {quickCellTarget && (() => {
          const effectiveEditable = canEditShifts && Boolean(quickCellData?.canEdit ?? canEditShifts);
          const backendConflicts = quickCellPreview?.conflicts?.map((c) => c.message) || [];
          const allConflictMessages =
            backendConflicts.length > 0 ? backendConflicts : quickCellClientConflicts;
          const hasConflicts = allConflictMessages.length > 0;
          const hasChanges = Boolean(quickCellPreview?.hasChanges);
          const existingTemplateIdSet = new Set(
            (quickCellData?.effectiveShifts || [])
              .filter((e) => !e.isSpecialAssignment && e.templateId !== null)
              .map((e) => Number(e.templateId))
          );

          const canProceedToConfirm =
            effectiveEditable &&
            !quickCellLoading &&
            !quickCellLoadError &&
            !quickCellBusy &&
            !quickCellPreviewLoading &&
            !hasConflicts &&
            Boolean(quickCellPreview) &&
            hasChanges;

          return (
            <div className="space-y-4 text-[13.5px]">
              {/* ส่วนหัว: ชื่อบุคลากร · วันที่ · ประเภทบุคลากร */}
              <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <span className="font-bold text-[#292638] text-[14.5px]">
                      {quickCellData?.person.full_name || quickCellTarget.person.full_name}
                    </span>{' '}
                    <span className="font-mono text-[12px] text-[#777287]">
                      ({quickCellData?.person.person_id || quickCellTarget.person.person_id})
                    </span>
                  </div>
                  <span className="font-mono font-bold text-[#4E3978] bg-[#F1ECFA] border border-[#E8E4EF] px-2.5 py-0.5 rounded-md text-[12.5px]">
                    {formatThaiDate(quickCellTarget.workDate)}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-[#777287]">
                  <span>
                    ประเภทบุคลากร:{' '}
                    <strong className="text-[#292638]">
                      {quickCellData?.person.personnel_type_name ||
                        quickCellTarget.person.personnel_type_name ||
                        'ไม่ระบุประเภท'}
                    </strong>
                  </span>
                  {quickCellData && (
                    <span
                      className={`text-[11.5px] font-semibold px-2 py-0.5 rounded-md border ${
                        quickCellData.clearedAll
                          ? 'bg-amber-50 border-amber-300 text-amber-900'
                          : quickCellData.effectiveState === 'CUSTOM_ASSIGNED'
                            ? 'bg-[#F1ECFA] border-[#8066B5] text-[#4E3978]'
                            : 'bg-emerald-50 border-dashed border-emerald-400 text-emerald-900'
                      }`}
                    >
                      {quickCellData.clearedAll
                        ? 'สถานะ: ไม่มีเวร (ตั้งใจยกเลิกทุกกะ)'
                        : quickCellData.effectiveState === 'CUSTOM_ASSIGNED'
                          ? `กำหนดเวรเอง (${quickCellData.effectiveShifts.length} กะ)`
                          : 'กะเริ่มต้นตามประเภทบุคลากร'}
                    </span>
                  )}
                </div>
              </div>

              {/* สถานะกำลังโหลดจาก Backend */}
              {quickCellLoading && (
                <div className="py-10 text-center space-y-2 text-[#777287] bg-[#F8F7FC] rounded-xl border border-[#E8E4EF]">
                  <RefreshCw className="w-5 h-5 animate-spin mx-auto text-[#4E3978]" />
                  <div className="text-[13.5px] font-medium">
                    กำลังโหลดข้อมูลกะทำงานล่าสุดจากระบบ...
                  </div>
                </div>
              )}

              {/* โหลดข้อมูลไม่สำเร็จ -> แจ้ง Error และไม่อนุญาตให้บันทึกข้อมูลที่ไม่สมบูรณ์ */}
              {!quickCellLoading && quickCellLoadError && (
                <div
                  role="alert"
                  className="p-4 rounded-xl bg-red-50 border border-red-300 text-red-950 space-y-3"
                >
                  <div className="font-bold text-red-900 flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                    <span>โหลดข้อมูลตารางเวรไม่สำเร็จ — ไม่สามารถบันทึกได้</span>
                  </div>
                  <p className="text-[13px] text-red-900">{quickCellLoadError}</p>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => openQuickCellModal(quickCellTarget.person, quickCellTarget.workDate)}
                      className="h-9 px-3.5 rounded-lg bg-[#4E3978] hover:bg-[#4E3978] text-white text-[12.5px] font-semibold inline-flex items-center gap-1.5"
                    >
                      <RefreshCw className="w-3.5 h-3.5" />
                      <span>ลองโหลดใหม่</span>
                    </button>
                    <button
                      type="button"
                      onClick={closeQuickCellModal}
                      className="h-9 px-3.5 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] text-[#292638] text-[12.5px] font-semibold"
                    >
                      ปิดหน้าต่าง
                    </button>
                  </div>
                </div>
              )}

              {/* เนื้อหาหลักหลังโหลดข้อมูลสำเร็จ */}
              {!quickCellLoading && !quickCellLoadError && quickCellData && (
                <>
                  {/* กะที่ต่อเนื่องจากวันก่อนหน้า (Read-only Info — ไม่แสดงเป็น Checkbox เพื่อไม่ให้ลบกะวันก่อนหน้าโดยไม่ตั้งใจ) */}
                  {quickCellData.carryoverFromPrevDay.length > 0 && (
                    <div className="p-3 rounded-xl bg-indigo-50/80 border border-indigo-200 text-indigo-950 space-y-1.5">
                      <div className="text-[12.5px] font-bold text-indigo-900 flex items-center gap-1.5">
                        <Info className="w-4 h-4 text-indigo-700 shrink-0" />
                        <span>กะที่ต่อเนื่องจากวันก่อนหน้า</span>
                      </div>
                      <div className="space-y-1">
                        {quickCellData.carryoverFromPrevDay.map((co, idx) => {
                          const iconKind = classifyShiftIconKind({
                            shiftCode: co.shiftCode,
                            shiftName: co.shiftName,
                            startTime: co.startTime,
                            endTime: co.endTime,
                            isCrossMidnight: co.isCrossMidnight,
                          });
                          return (
                            <div
                              key={`${co.shiftCode}-${idx}`}
                              className="flex flex-wrap items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg bg-white/90 border border-indigo-200/80 text-[12.5px]"
                            >
                              <div className="flex items-center gap-1.5 font-semibold text-[#292638]">
                                {renderShiftIcon(iconKind, 'w-3.5 h-3.5')}
                                <span>{formatCleanShiftName(co.shiftName)}</span>
                                <span className="font-mono text-[#4E3978]">
                                  {co.startTime}–{co.endTime} น.
                                </span>
                              </div>
                              <span className="text-[11.5px] text-indigo-800 font-medium">
                                กะนี้เริ่มจากวันที่ {formatThaiDate(co.workDate)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                      <p className="text-[11.5px] text-indigo-800">
                        หากต้องการแก้ไขกะข้ามวันข้างต้น กรุณาคลิกที่ช่องวันที่เริ่มต้นของกะนั้น
                      </p>
                    </div>
                  )}

                  {/* ขั้นตอนที่ 1: เลือกกะด้วย Checkbox (คลิกวันที่ -> ติ๊กกะ -> บันทึกครั้งเดียว) */}
                  {!quickCellConfirmStep ? (
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="font-bold text-[#292638] text-[14px]">
                          เลือกกะที่ต้องการให้มีในวันนี้
                        </div>
                        <span className="font-mono text-[12px] font-bold text-[#4E3978] bg-[#F1ECFA] border border-[#E8E4EF] px-2 py-0.5 rounded-md tabular-nums">
                          เลือกอยู่ {quickCellSelectedIds.length + quickCellKeepSpecialIds.length} กะ
                        </span>
                      </div>

                      {!effectiveEditable && (
                        <div className="p-2.5 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] text-[#777287] text-[12px]">
                          บัญชีของคุณมีสิทธิ์ดูตารางเวรเท่านั้น ไม่สามารถแก้ไขกะทำงานได้
                        </div>
                      )}

                      {/* รายการแม่แบบกะทั้งหมดจากฐานข้อมูลจริง */}
                      <div className="space-y-2 max-h-72 overflow-y-auto pr-0.5">
                        {quickCellData.availableTemplates.map((tpl) => {
                          const tid = Number(tpl.id);
                          const checked = quickCellSelectedIds.includes(tid);
                          const isCross = Number(tpl.isCrossMidnight) === 1;
                          const isCurrentlyActive = existingTemplateIdSet.has(tid);
                          const iconKind = classifyShiftIconKind({
                            shiftCode: tpl.shiftCode,
                            shiftName: tpl.shiftName,
                            shiftCategory: tpl.shiftCategory,
                            startTime: tpl.startTime,
                            endTime: tpl.endTime,
                            isCrossMidnight: isCross,
                          });

                          return (
                            <label
                              key={tid}
                              className={`p-3 rounded-xl border transition-colors flex items-center gap-3 select-none ${
                                effectiveEditable ? 'cursor-pointer' : 'cursor-default opacity-85'
                              } ${
                                checked
                                  ? 'bg-[#F1ECFA] border-[#4E3978]'
                                  : 'bg-white border-[#E8E4EF] hover:border-[#8066B5]/70'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={!effectiveEditable || quickCellBusy}
                                onChange={() => toggleQuickCellTemplate(tid)}
                                className="w-4 h-4 rounded border-[#D8D1E6] text-[#4E3978] focus:ring-[#4E3978] shrink-0"
                              />
                              {renderShiftIcon(iconKind, 'w-4 h-4')}
                              <div className="min-w-0 flex-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="font-bold text-[13.5px] text-[#292638] truncate">
                                    {formatCleanShiftName(tpl.shiftName)}
                                  </span>
                                  {isCurrentlyActive && (
                                    <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-white border border-[#E8E4EF] text-[#4E3978]">
                                      กะเดิมวันนี้
                                    </span>
                                  )}
                                </div>
                                <span className="font-mono font-bold text-[12.5px] text-[#4E3978] tabular-nums shrink-0">
                                  {tpl.startTime}–{tpl.endTime} น.
                                  {isCross ? ' (+1 วัน)' : ''}
                                </span>
                              </div>
                            </label>
                          );
                        })}
                      </div>

                      {/* กรณีพิเศษ: รายการ Assignment ที่ซ้ำ Template เดียวกันหรือแม่แบบถูกปิดใช้งาน (Requirement 6.2) */}
                      {quickCellData.specialExistingAssignments.length > 0 && (
                        <div className="p-3 rounded-xl bg-amber-50/70 border border-amber-300 space-y-2">
                          <div className="text-[12px] font-bold text-amber-900">
                            รายการกะเพิ่มเติมที่มีอยู่เดิมในวันนี้ (จัดการแยกรายการเพื่อความปลอดภัย):
                          </div>
                          <div className="space-y-1.5">
                            {quickCellData.specialExistingAssignments.map((sp) => {
                              const aid = Number(sp.assignmentId);
                              const kept = quickCellKeepSpecialIds.includes(aid);
                              return (
                                <label
                                  key={sp.identityKey}
                                  className="flex items-center gap-2.5 p-2 rounded-lg bg-white border border-amber-200 cursor-pointer text-[12.5px]"
                                >
                                  <input
                                    type="checkbox"
                                    checked={kept}
                                    disabled={!effectiveEditable || quickCellBusy}
                                    onChange={() => toggleQuickCellSpecialAssignment(aid)}
                                    className="w-4 h-4 rounded border-amber-400 text-[#4E3978] focus:ring-[#4E3978]"
                                  />
                                  <span className="font-semibold text-[#292638]">
                                    {formatCleanShiftName(sp.shiftName)}
                                  </span>
                                  <span className="font-mono text-[#4E3978]">
                                    {sp.startTime}–{sp.endTime} น.
                                  </span>
                                  <span className="font-mono text-[11px] text-[#777287] ml-auto">
                                    #{aid}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* ข้อความแนะนำเมื่อเอาติ๊กออกทั้งหมด */}
                      {effectiveEditable &&
                        quickCellSelectedIds.length === 0 &&
                        quickCellKeepSpecialIds.length === 0 &&
                        !hasConflicts && (
                          <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-300 text-amber-950 text-[12.5px]">
                            ไม่ได้ติ๊กกะใดไว้ — เมื่อบันทึก ระบบจะกำหนดวันนี้เป็น{' '}
                            <strong>ไม่มีเวร</strong> และจะไม่สร้างกะเริ่มต้นกลับมาอัตโนมัติ
                          </div>
                        )}

                      {/* แจ้งเตือน Conflict หรือ Error */}
                      {(hasConflicts || quickCellError) && (
                        <div
                          role="alert"
                          className="p-3 rounded-xl bg-red-50 border border-red-300 text-red-950 text-[12.5px] space-y-1.5"
                        >
                          <div className="font-bold text-red-900 flex items-center gap-1.5">
                            <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
                            <span>พบข้อขัดแย้งของเวลาปฏิบัติงาน — ไม่สามารถบันทึกได้</span>
                          </div>
                          {allConflictMessages.length > 0 ? (
                            <ul className="list-disc pl-5 space-y-1 text-red-900">
                              {allConflictMessages.map((msg, idx) => (
                                <li key={idx}>{msg}</li>
                              ))}
                            </ul>
                          ) : (
                            <p className="text-red-900">{quickCellError}</p>
                          )}
                        </div>
                      )}

                      {/* ปุ่มหลักเพียง "บันทึกเวร" และปุ่มรอง "ยกเลิก" */}
                      <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[#E8E4EF]">
                        <button
                          type="button"
                          disabled={quickCellBusy}
                          onClick={closeQuickCellModal}
                          className="h-10 px-4 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] text-[#292638] font-semibold text-[13px]"
                        >
                          {effectiveEditable ? 'ยกเลิก' : 'ปิด'}
                        </button>
                        {effectiveEditable && (
                          <button
                            type="button"
                            disabled={!canProceedToConfirm}
                            onClick={() => {
                              setQuickCellError(null);
                              setQuickCellConfirmStep(true);
                            }}
                            className="h-10 px-5 rounded-lg bg-[#4E3978] hover:bg-[#4E3978] disabled:opacity-40 text-white font-semibold text-[13px] inline-flex items-center gap-1.5 transition-colors"
                          >
                            <Check className="w-4 h-4" />
                            <span>
                              {quickCellPreviewLoading ? 'กำลังตรวจสอบ...' : 'บันทึกเวร'}
                            </span>
                          </button>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* ขั้นตอนที่ 2 (Inline Confirmation Preview): แสดงกะเดิม / กะหลังแก้ไข / สรุปการเปลี่ยนแปลง ก่อนกดยืนยันบันทึก */
                    <div className="space-y-3.5">
                      <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-3">
                        <div className="font-bold text-[#4E3978] text-[14px]">
                          สรุปการเปลี่ยนแปลงก่อนยืนยันบันทึก
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div className="p-2.5 rounded-lg bg-white border border-[#E8E4EF] space-y-1">
                            <div className="text-[12px] font-bold text-[#777287]">กะเดิม:</div>
                            {quickCellPreview && quickCellPreview.existingEffectiveShifts.length > 0 ? (
                              <ul className="space-y-1 text-[12.5px] text-[#292638]">
                                {quickCellPreview.existingEffectiveShifts.map((s, idx) => (
                                  <li key={idx} className="flex items-center justify-between gap-1">
                                    <span>• {formatCleanShiftName(s.shiftName)}</span>
                                    <span className="font-mono text-[11.5px] text-[#777287]">
                                      {s.startTime}–{s.endTime}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="text-[12.5px] text-[#777287]">— ไม่มีเวร</div>
                            )}
                          </div>

                          <div className="p-2.5 rounded-lg bg-[#F1ECFA]/60 border border-[#8066B5] space-y-1">
                            <div className="text-[12px] font-bold text-[#4E3978]">กะหลังแก้ไข:</div>
                            {quickCellPreview && quickCellPreview.resultingShifts.length > 0 ? (
                              <ul className="space-y-1 text-[12.5px] text-[#292638] font-semibold">
                                {quickCellPreview.resultingShifts.map((s, idx) => (
                                  <li key={idx} className="flex items-center justify-between gap-1">
                                    <span>• {formatCleanShiftName(s.shiftName)}</span>
                                    <span className="font-mono text-[11.5px] text-[#4E3978]">
                                      {s.startTime}–{s.endTime}
                                      {s.isCrossMidnight === 1 ? ' (+1)' : ''}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            ) : (
                              <div className="text-[12.5px] font-bold text-amber-800">
                                — ไม่มีเวร (ตั้งใจยกเลิกทุกกะ)
                              </div>
                            )}
                          </div>
                        </div>

                        {quickCellPreview && (
                          <div className="pt-2 border-t border-[#E8E4EF] space-y-1 text-[12.5px]">
                            <div className="font-bold text-[#292638]">การเปลี่ยนแปลง:</div>
                            <ul className="space-y-0.5">
                              {quickCellPreview.shiftsToAdd.map((a, idx) => (
                                <li key={`add-${idx}`} className="text-emerald-800 font-medium">
                                  + เพิ่ม {formatCleanShiftName(a.shiftName)} ({a.startTime}–{a.endTime} น.) 1 กะ
                                </li>
                              ))}
                              {quickCellPreview.shiftsToRemove.map((r, idx) => (
                                <li key={`rem-${idx}`} className="text-red-800 font-medium">
                                  − ลบ {formatCleanShiftName(r.shiftName)} ({r.startTime}–{r.endTime} น.) 1 กะ
                                </li>
                              ))}
                              {quickCellPreview.shiftsToKeep.map((k, idx) => (
                                <li key={`keep-${idx}`} className="text-[#777287]">
                                  • คง {formatCleanShiftName(k.shiftName)} ({k.startTime}–{k.endTime} น.) 1 กะ
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>

                      <div>
                        <input
                          type="text"
                          value={quickCellReason}
                          onChange={(e) => setQuickCellReason(e.target.value)}
                          placeholder="หมายเหตุการแก้ไข (ถ้ามี)..."
                          className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#4E3978]"
                        />
                      </div>

                      {quickCellError && (
                        <div
                          role="alert"
                          className="p-3 rounded-xl bg-red-50 border border-red-300 text-red-900 text-[12.5px] font-medium"
                        >
                          {quickCellError}
                        </div>
                      )}

                      <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[#E8E4EF]">
                        <button
                          type="button"
                          disabled={quickCellBusy}
                          onClick={() => setQuickCellConfirmStep(false)}
                          className="h-10 px-4 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] text-[#292638] font-semibold text-[13px]"
                        >
                          ยกเลิก
                        </button>
                        <button
                          type="button"
                          disabled={quickCellBusy || hasConflicts}
                          onClick={handleConfirmQuickCellSync}
                          className="h-10 px-5 rounded-lg bg-[#4E3978] hover:bg-[#4E3978] disabled:opacity-40 text-white font-semibold text-[13px] inline-flex items-center gap-1.5 transition-colors"
                        >
                          <Check className="w-4 h-4" />
                          <span>{quickCellBusy ? 'กำลังบันทึก...' : 'ยืนยันบันทึก'}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </>
              )}
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
          <div className="p-3.5 rounded-xl bg-[#F1ECFA] border border-[#E8E4EF] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="space-y-0.5">
              <div className="font-bold text-[#292638]">
                คอลัมน์มาตรฐานที่รองรับ: person_id, full_name, work_date, shift_code
              </div>
              <div className="text-[12.5px] text-[#777287]">
                รหัสกะมาตรฐาน: MOR (เช้า), AFT (บ่าย), NIG (ดึก), MORAFT (เช้า–บ่าย), AFTNIG (บ่าย–ดึก), FULL (ทั้งวัน), OFF (ไม่มีเวร)
              </div>
            </div>
            <button
              type="button"
              onClick={handleDownloadExcelTemplate}
              className="h-9 px-3.5 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F1ECFA] text-[#4E3978] text-[12.5px] font-semibold inline-flex items-center gap-1.5 shrink-0"
            >
              <Download className="w-4 h-4" />
              <span>ดาวน์โหลด Template Excel</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                เลือกไฟล์ Excel (.xlsx) <RequiredMark />
              </label>
              <input
                type="file"
                accept=".xlsx"
                onChange={handleSelectExcelFile}
                className="w-full text-[13px] file:mr-3 file:py-2 file:px-3.5 file:rounded-lg file:border-0 file:text-[12.5px] file:font-semibold file:bg-[#E9DFF5] file:text-[#4E3978] hover:file:bg-violet-200"
              />
            </div>
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                รูปแบบการนำเข้าเมื่อมีเวรเดิมในวันเดียวกัน
              </label>
              <select
                value={excelImportMode}
                onChange={(e) => setExcelImportMode(e.target.value as 'REPLACE_DATE' | 'ADD_SHIFT')}
                className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px]"
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
              className="h-10 px-4 rounded-lg border border-[#D8D1E6] bg-[#F1ECFA] hover:bg-[#E9DFF5] text-[#4E3978] font-semibold text-[13px] disabled:opacity-50"
            >
              {excelBusy ? 'กำลังตรวจสอบไฟล์...' : '1. ตรวจสอบข้อมูลก่อนนำเข้า (Preview)'}
            </button>
            {excelPreview && (
              <button
                type="button"
                disabled={excelBusy || Number(excelPreview.summary?.validCount || 0) === 0}
                onClick={handleConfirmExcelImport}
                className="h-10 px-4 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] text-white font-semibold text-[13px] disabled:opacity-50"
              >
                {excelBusy
                  ? 'กำลังบันทึก...'
                  : `2. ยืนยันการนำเข้า (${excelPreview.summary?.validCount || 0} รายการ)`}
              </button>
            )}
          </div>

          {excelPreview && (
            <div className="space-y-3 pt-2 border-t border-[#E8E4EF]">
              <div className="grid grid-cols-3 gap-2.5 text-center">
                <div className="p-2.5 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[11.5px] text-[#777287]">จำนวนแถวทั้งหมด</div>
                  <div className="text-[17px] font-bold font-mono text-[#292638]">
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

              <div className="max-h-60 overflow-y-auto border border-[#E8E4EF] rounded-lg">
                <table className="w-full text-left border-collapse text-[12.5px]">
                  <thead className="bg-[#F8F7FC] sticky top-0">
                    <tr className="border-b border-[#E8E4EF]">
                      <th className="py-2 px-2.5">แถว</th>
                      <th className="py-2 px-2.5">บุคลากร</th>
                      <th className="py-2 px-2.5">วันที่</th>
                      <th className="py-2 px-2.5">กะ</th>
                      <th className="py-2 px-2.5">ผลการตรวจสอบ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E8E4EF]">
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
              <label className="block font-semibold text-[#292638] mb-1">
                ชื่อประเภทบุคลากร <RequiredMark />
              </label>
              <input
                type="text"
                required
                value={editingRule.personnel_type_name || ''}
                onChange={(e) =>
                  setEditingRule({ ...editingRule, personnel_type_name: e.target.value })
                }
                className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-[#292638] mb-1">
                  เวลาเริ่มงานกะเช้า <RequiredMark />
                </label>
                <input
                  type="time"
                  required
                  value={editingRule.default_start_time || '08:00'}
                  onChange={(e) =>
                    setEditingRule({ ...editingRule, default_start_time: e.target.value })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#292638] mb-1">
                  เวลาเลิกงานกะเช้า <RequiredMark />
                </label>
                <input
                  type="time"
                  required
                  value={editingRule.default_end_time || '16:00'}
                  onChange={(e) =>
                    setEditingRule({ ...editingRule, default_end_time: e.target.value })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white font-mono"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-semibold text-[#292638] mb-1">
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
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white font-mono"
                />
              </div>
              <div>
                <label className="block font-semibold text-[#292638] mb-1">
                  เวลาตัดรอบสแกนเข้า <RequiredMark />
                </label>
                <input
                  type="time"
                  required
                  value={editingRule.default_cutoff_time || '11:00'}
                  onChange={(e) =>
                    setEditingRule({ ...editingRule, default_cutoff_time: e.target.value })
                  }
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white font-mono"
                />
              </div>
            </div>
            <div>
              <label className="block font-semibold text-[#292638] mb-1">
                วันที่มีผลบังคับใช้ (ไม่กระทบการคำนวณย้อนหลังก่อนวันนี้)
              </label>
              <input
                type="date"
                value={String(editingRule.effective_from || '2020-01-01').slice(0, 10)}
                onChange={(e) =>
                  setEditingRule({ ...editingRule, effective_from: e.target.value })
                }
                className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white font-mono"
              />
            </div>
            <div className="flex justify-end gap-2 pt-3 border-t border-[#E8E4EF]">
              <button
                type="button"
                onClick={() => setEditingRule(null)}
                className="h-10 px-4 rounded-lg border border-[#D8D1E6] bg-white text-[#292638] font-semibold"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={ruleSaving}
                className="h-10 px-5 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] text-white font-semibold"
              >
                {ruleSaving ? 'กำลังบันทึก...' : 'บันทึกการเปลี่ยนแปลง'}
              </button>
            </div>
          </form>
        )}
      </SharedModal>

      {/* หน้าต่างยืนยันชัดเจนก่อนแทนที่หรือลบกะเดิม (ป้องกันการแก้/ลบข้อมูลโดยไม่ได้ยืนยัน) */}
      <ConfirmDialog
        open={confirmBulkModalOpen}
        onCancel={() => setConfirmBulkModalOpen(false)}
        onConfirm={() => void executeBulkAssign(true)}
        loading={submittingBulk}
        variant={
          bulkOperationMode === 'CLEAR_ALL_SHIFTS' ||
          bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
            ? 'danger'
            : 'warning'
        }
        title={
          bulkOperationMode === 'CLEAR_ALL_SHIFTS'
            ? 'ยืนยันลบกะทั้งหมดและตั้งเป็น “ไม่มีเวร”'
            : bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
              ? 'ยืนยันลบเฉพาะกะที่เลือก'
              : 'ยืนยันแทนที่กะเดิมทั้งหมดในวันที่เลือก'
        }
        description="การดำเนินการนี้จะเปลี่ยนแปลงตารางเวรเดิมที่มีอยู่ในระบบ และบันทึกประวัติการตรวจสอบไว้ทั้งหมด"
        confirmLabel={
          bulkOperationMode === 'CLEAR_ALL_SHIFTS'
            ? 'ยืนยันลบกะทั้งหมด'
            : bulkOperationMode === 'REMOVE_SELECTED_SHIFTS'
              ? 'ยืนยันลบกะที่เลือก'
              : 'ยืนยันแทนที่กะเดิม'
        }
      >
        <div className="space-y-3 text-[13.5px] text-[#292638]">
          <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1.5">
            <div>
              จำนวนบุคลากร: <strong className="font-mono">{selectedPersonIds.length}</strong> คน ·
              จำนวนวันที่: <strong className="font-mono">{effectiveSelectedDates.length}</strong>{' '}
              วัน
            </div>
            {bulkOperationMode !== 'CLEAR_ALL_SHIFTS' && (
              <div>
                กะที่เลือก ({selectedShiftTemplates.length} กะ):{' '}
                <strong>
                  {selectedShiftTemplates
                    .map((s) => `${formatCleanShiftName(s.shift_name)} (${s.start_time}–${s.end_time})`)
                    .join(', ')}
                </strong>
              </div>
            )}
            {previewData && (
              <div>
                รายการพร้อมดำเนินการ:{' '}
                <strong className="font-mono text-[#4E3978]">
                  {previewData.summary.readyCount}
                </strong>{' '}
                รายการ
                {bulkOperationMode === 'REPLACE_SHIFTS' &&
                (previewData.summary.replaceAffectedCells || 0) > 0
                  ? ` (จะยกเลิกกะเดิม ${previewData.summary.replaceAffectedCells} วัน-คน)`
                  : ''}
              </div>
            )}
          </div>
          {bulkOperationMode === 'CLEAR_ALL_SHIFTS' && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-950 text-[12.5px]">
              วันที่ถูกลบกะทั้งหมดจะถูกคงสถานะ <strong>ไม่มีเวร (CLEARED_ALL_SHIFTS)</strong> ไว้
              ระบบจะไม่สร้างกะเช้าเริ่มต้นกลับมาเอง
            </div>
          )}
        </div>
      </ConfirmDialog>

      {/* หน้าต่างยืนยันก่อนล้างรายชื่อบุคลากรทั้งหมด (เมื่อเลือกบุคลากรจำนวนมากเพื่อป้องกันการกดผิด) */}
      <ConfirmDialog
        open={confirmClearPersonsOpen}
        onCancel={() => setConfirmClearPersonsOpen(false)}
        onConfirm={confirmClearAllSelectedPersons}
        variant="warning"
        title="ยืนยันล้างรายชื่อบุคลากรที่เลือกทั้งหมด"
        description={`คุณกำลังเลือกบุคลากรไว้ทั้งหมด ${filteredPersonSelectionMeta.uniqueSelectedTotalCount} คน การกดล้างรายชื่อจะยกเลิกการเลือกทั้งหมด (รวมถึงบุคลากรที่เลือกไว้จากกลุ่มงานอื่น)`}
        confirmLabel={`ล้างทั้งหมด (${filteredPersonSelectionMeta.uniqueSelectedTotalCount} คน)`}
      />

      {/* =====================================================================
          DIALOG: เพิ่มและแก้ไขแม่แบบกะทำงาน (Unified Shift Template Modal Popup)
         ===================================================================== */}
      <ShiftTemplateModal
        open={templateModalState.open}
        mode={templateModalState.mode}
        initialShift={templateModalState.shift}
        personnelTypeRules={personnelTypeRules}
        defaultBindingByTypeCode={defaultBindingByTypeCode}
        onClose={() => setTemplateModalState({ open: false, mode: 'create', shift: null })}
        onSaved={handleTemplateModalSaved}
        onErrorToast={(err) =>
          pushToast('error', err.message, {
            detail: err.detail,
            requestId: err.requestId,
          })
        }
        onRequestChangeDefault={(opts) => openChangeDefaultModal(opts)}
      />

      {/* =====================================================================
          DIALOG: เปลี่ยนกะเริ่มต้นแบบชัดเจนและมีการบันทึก Audit Log (Explicit Change Default Shift)
         ===================================================================== */}
      <SharedModal
        open={changeDefaultModalOpen}
        onClose={() => {
          if (!changeDefaultSaving && !confirmChangeDefaultPayload && !confirmClearDefaultScope) {
            setChangeDefaultModalOpen(false);
            setChangeDefaultError(null);
          }
        }}
        kickerText="การจัดการกะเริ่มต้นตามประเภทบุคลากร (บันทึก Audit Log)"
        title="เปลี่ยนหรือกำหนดกะเริ่มต้น (Change Default Shift)"
        maxWidthClass="max-w-xl"
        hideDefaultCloseButton
        disableEscapeClose={
          changeDefaultSaving ||
          Boolean(confirmChangeDefaultPayload) ||
          Boolean(confirmClearDefaultScope)
        }
        closeOnBackdrop={
          !changeDefaultSaving &&
          !confirmChangeDefaultPayload &&
          !confirmClearDefaultScope
        }
      >
        {(() => {
          const currentBinding = changeDefaultScopeCode
            ? defaultBindingByTypeCode.get(changeDefaultScopeCode) || null
            : null;
          const currentRule = personnelTypeRules.find(
            (r) => String(r.personnel_type_code || '').trim().toUpperCase() === changeDefaultScopeCode
          );
          const selectedNewShift = shifts.find(
            (s) => String(s.id) === String(changeDefaultSelectedShiftId)
          );
          const activeShiftsForSelect = shifts.filter((s) => Number(s.is_active ?? 1) === 1);

          return (
            <form onSubmit={handleSubmitChangeDefault} className="space-y-4 text-[13.5px]">
              {changeDefaultError && <ErrorBanner error={changeDefaultError} />}

              <div>
                <label className="block font-semibold text-[#292638] mb-1">
                  ประเภทบุคลากรเป้าหมาย <RequiredMark />
                </label>
                <select
                  required
                  value={changeDefaultScopeCode}
                  onChange={(e) => setChangeDefaultScopeCode(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[#292638]"
                >
                  {personnelTypeRules.map((rule) => {
                    const code = String(rule.personnel_type_code || '').trim().toUpperCase();
                    const b = defaultBindingByTypeCode.get(code);
                    return (
                      <option key={code} value={code}>
                        {rule.personnel_type_name} ({code}) —{' '}
                        {b
                          ? `กะเริ่มต้นปัจจุบัน: ${formatCleanShiftName(b.shiftName)}`
                          : 'ยังไม่มีกะเริ่มต้น'}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div>
                <label className="block font-semibold text-[#292638] mb-1">
                  แม่แบบกะทำงานที่ต้องการกำหนดเป็นกะเริ่มต้น <RequiredMark />
                </label>
                <select
                  required
                  value={changeDefaultSelectedShiftId}
                  onChange={(e) => setChangeDefaultSelectedShiftId(e.target.value)}
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[#292638]"
                >
                  <option value="">-- เลือกแม่แบบกะทำงาน --</option>
                  {activeShiftsForSelect.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {formatCleanShiftName(s.shift_name)} ({s.shift_code}) · {s.start_time}–
                      {s.end_time} น. (ผ่อนผัน {s.grace_minutes} นาที)
                    </option>
                  ))}
                </select>
              </div>

              {/* เปรียบเทียบกะเริ่มต้นเดิม vs กะเริ่มต้นใหม่ */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="rounded-lg border border-[#E8E4EF] bg-[#F8F7FC] p-3 space-y-1">
                  <div className="text-[11.5px] font-semibold text-[#777287]">กะเริ่มต้นปัจจุบัน</div>
                  {currentBinding ? (
                    <>
                      <div className="font-bold text-[#292638]">
                        {formatCleanShiftName(currentBinding.shiftName)}
                      </div>
                      <div className="font-mono text-[12px] text-[#4E3978] tabular-nums">
                        {currentBinding.shiftCode} · {currentBinding.startTime}–
                        {currentBinding.endTime} น.
                      </div>
                    </>
                  ) : (
                    <div className="text-[12.5px] text-amber-800 font-medium">
                      ยังไม่ได้กำหนดกะเริ่มต้น
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-[#8066B5]/40 bg-[#F1ECFA]/60 p-3 space-y-1">
                  <div className="text-[11.5px] font-semibold text-[#4E3978]">กะเริ่มต้นใหม่ที่เลือก</div>
                  {selectedNewShift ? (
                    <>
                      <div className="font-bold text-[#292638]">
                        {formatCleanShiftName(selectedNewShift.shift_name)}
                      </div>
                      <div className="font-mono text-[12px] text-[#4E3978] tabular-nums">
                        {selectedNewShift.shift_code} · {selectedNewShift.start_time}–
                        {selectedNewShift.end_time} น.
                      </div>
                    </>
                  ) : (
                    <div className="text-[12.5px] text-[#777287]">กรุณาเลือกแม่แบบกะ</div>
                  )}
                </div>
              </div>

              <div>
                <label className="block font-semibold text-[#292638] mb-1">
                  เหตุผลการเปลี่ยนกะเริ่มต้น (บันทึกใน Audit Log)
                </label>
                <input
                  type="text"
                  value={changeDefaultReason}
                  onChange={(e) => setChangeDefaultReason(e.target.value)}
                  placeholder="เช่น ปรับเวลาทำงานปกติของประเภทบุคลากรตามคำสั่งโรงพยาบาล"
                  className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[#292638]"
                />
              </div>

              <div className="rounded-lg border border-[#D8D1E6] bg-[#F8F7FC] p-3 text-[12.5px] text-[#4E3978] flex items-start gap-2">
                <ShieldCheck className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
                <span>
                  การเปลี่ยนกะเริ่มต้นจะมีผลกับการคำนวณเวรอัตโนมัติในวันที่ไม่มีการจัดเวรรายวันเท่านั้น{' '}
                  <strong>
                    จะไม่แก้ไขหรือลบตารางเวรย้อนหลัง ข้อมูลสแกนดิบ และประวัติการลงเวลาย้อนหลัง
                  </strong>{' '}
                  และจะบันทึกหลักฐานการเปลี่ยนแปลงไว้ใน Audit Log ทุกครั้ง
                </span>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-[#E8E4EF]">
                <div>
                  {currentBinding && currentRule && (
                    <button
                      type="button"
                      disabled={changeDefaultSaving}
                      onClick={() =>
                        setConfirmClearDefaultScope({
                          personnelTypeCode: changeDefaultScopeCode,
                          personnelTypeName: String(
                            currentRule.personnel_type_name || changeDefaultScopeCode
                          ),
                          currentShiftName: formatCleanShiftName(currentBinding.shiftName),
                        })
                      }
                      className="h-9 px-3 rounded-lg border border-rose-300 bg-rose-50 hover:bg-rose-100 text-rose-800 text-[12px] font-semibold"
                    >
                      ยกเลิกการผูกกะเริ่มต้นนี้
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={changeDefaultSaving}
                    onClick={() => setChangeDefaultModalOpen(false)}
                    className="h-10 px-4 rounded-lg border border-[#D8D1E6] bg-white text-[#292638] font-semibold"
                  >
                    ยกเลิก
                  </button>
                  <button
                    type="submit"
                    disabled={changeDefaultSaving || !changeDefaultSelectedShiftId}
                    className="h-10 px-5 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] disabled:opacity-50 text-white font-semibold"
                  >
                    {changeDefaultSaving ? 'กำลังบันทึก...' : 'ยืนยันเปลี่ยนกะเริ่มต้น'}
                  </button>
                </div>
              </div>
            </form>
          );
        })()}
      </SharedModal>

      {/* หน้าต่างยืนยันการยกเลิกผูกกะเริ่มต้นของประเภทบุคลากร */}
      <ConfirmDialog
        open={Boolean(confirmClearDefaultScope)}
        onCancel={() => setConfirmClearDefaultScope(null)}
        onConfirm={() => void handleConfirmClearDefault()}
        loading={changeDefaultSaving}
        variant="warning"
        title="ยืนยันยกเลิกการผูกกะเริ่มต้น"
        description={
          confirmClearDefaultScope
            ? `ต้องการยกเลิกกะเริ่มต้น “${confirmClearDefaultScope.currentShiftName}” ของประเภทบุคลากร ${confirmClearDefaultScope.personnelTypeName} หรือไม่? หลังจากยกเลิก วันที่ไม่มีการจัดเวรรายวันจะแสดงเป็น “ไม่พบกะที่กำหนด” จนกว่าจะกำหนดกะเริ่มต้นใหม่ (ไม่กระทบข้อมูลย้อนหลัง)`
            : ''
        }
        cancelLabel="ยกเลิก"
        confirmLabel="ยืนยันยกเลิกการผูกกะเริ่มต้น"
      />

      {/* หน้าต่างยืนยันการเปลี่ยนกะเริ่มต้นเมื่อประเภทบุคลากรมีกะเริ่มต้นเดิมอยู่แล้ว */}
      <ConfirmDialog
        open={Boolean(confirmChangeDefaultPayload)}
        onCancel={() => setConfirmChangeDefaultPayload(null)}
        onConfirm={() => {
          if (!confirmChangeDefaultPayload) return;
          void executeChangeDefault(
            confirmChangeDefaultPayload.scopeCode,
            confirmChangeDefaultPayload.nextShiftId
          );
        }}
        loading={changeDefaultSaving}
        variant="warning"
        title="ยืนยันเปลี่ยนกะเริ่มต้น"
        description={
          confirmChangeDefaultPayload
            ? `ต้องการเปลี่ยนกะเริ่มต้นของประเภทบุคลากร “${confirmChangeDefaultPayload.scopeName}” จาก “${confirmChangeDefaultPayload.previousShiftName} (${confirmChangeDefaultPayload.previousShiftCode})” เป็น “${confirmChangeDefaultPayload.nextShiftName} (${confirmChangeDefaultPayload.nextShiftCode})” หรือไม่? การเปลี่ยนแปลงจะบันทึกใน Audit Log และไม่กระทบข้อมูลตารางเวรย้อนหลัง`
            : ''
        }
        cancelLabel="ยกเลิก"
        confirmLabel="ยืนยันเปลี่ยนกะเริ่มต้น"
      />

      {/* หน้าต่างยืนยันการปิด/เปิดใช้งานแม่แบบกะทำงาน */}
      <ConfirmDialog
        open={Boolean(confirmToggleShiftTarget)}
        onCancel={() => setConfirmToggleShiftTarget(null)}
        onConfirm={() => void handleConfirmToggleShiftActive()}
        loading={toggleShiftBusy}
        variant={
          confirmToggleShiftTarget && Number(confirmToggleShiftTarget.is_active ?? 1) === 1
            ? 'danger'
            : 'warning'
        }
        title={
          confirmToggleShiftTarget && Number(confirmToggleShiftTarget.is_active ?? 1) === 1
            ? 'ยืนยันปิดใช้งานแม่แบบกะทำงาน'
            : 'ยืนยันเปิดใช้งานแม่แบบกะทำงาน'
        }
        description={
          confirmToggleShiftTarget
            ? Number(confirmToggleShiftTarget.is_active ?? 1) === 1
              ? `ต้องการปิดใช้งานแม่แบบกะ “${formatCleanShiftName(confirmToggleShiftTarget.shift_name)} (${confirmToggleShiftTarget.shift_code})” หรือไม่? แม่แบบกะที่ปิดใช้งานจะไม่แสดงให้เลือกจัดเวรใหม่ แต่ตารางเวรและประวัติการลงเวลาย้อนหลังจะยังคงอยู่ครบถ้วน`
              : `ต้องการเปิดใช้งานแม่แบบกะ “${formatCleanShiftName(confirmToggleShiftTarget.shift_name)} (${confirmToggleShiftTarget.shift_code})” อีกครั้งหรือไม่?`
            : ''
        }
        cancelLabel="ยกเลิก"
        confirmLabel={
          confirmToggleShiftTarget && Number(confirmToggleShiftTarget.is_active ?? 1) === 1
            ? 'ยืนยันปิดใช้งาน'
            : 'ยืนยันเปิดใช้งาน'
        }
      />

      {/* หน้าต่างยืนยันการปิด/เปิดใช้งานกฎประเภทบุคลากร */}
      <ConfirmDialog
        open={Boolean(confirmToggleRuleTarget)}
        onCancel={() => setConfirmToggleRuleTarget(null)}
        onConfirm={() => void handleConfirmToggleRuleActive()}
        loading={toggleRuleBusy}
        variant="warning"
        title={
          confirmToggleRuleTarget && Number(confirmToggleRuleTarget.is_active ?? 1) === 1
            ? 'ยืนยันปิดใช้งานกฎประเภทบุคลากร'
            : 'ยืนยันเปิดใช้งานกฎประเภทบุคลากร'
        }
        description={
          confirmToggleRuleTarget
            ? Number(confirmToggleRuleTarget.is_active ?? 1) === 1
              ? `ต้องการปิดใช้งานกฎกะเช้าเริ่มต้นของประเภทบุคลากร “${confirmToggleRuleTarget.personnel_type_name} (${confirmToggleRuleTarget.personnel_type_code})” หรือไม่? (ไม่กระทบข้อมูลย้อนหลัง)`
              : `ต้องการเปิดใช้งานกฎกะเช้าเริ่มต้นของประเภทบุคลากร “${confirmToggleRuleTarget.personnel_type_name} (${confirmToggleRuleTarget.personnel_type_code})” หรือไม่?`
            : ''
        }
        cancelLabel="ยกเลิก"
        confirmLabel="ยืนยัน"
      />
    </div>
  );
}
