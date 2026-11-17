/**
 * ============================================================================
 * หน้าตารางเวรและแม่แบบกะทำงาน (Shift Roster & Shift Templates Management)
 * ไฟล์: frontend/src/pages/ShiftsView.tsx
 * ============================================================================
 * การออกแบบ UX/UI สำหรับเจ้าหน้าที่โรงพยาบาล:
 * 1. แยกแท็บหลักชัดเจนระหว่าง "ตารางเวร" (หน้าหลัก) และ "จัดการแม่แบบกะ"
 * 2. มุมมองหลักเป็น "ตารางเวรประจำเดือน" (Monthly Roster Grid) ที่ดูง่ายทั้งบน Desktop และ Tablet
 *    คลิกที่ช่องว่างในตารางเพื่อมอบหมายเวรให้บุคลากรในวันนั้นได้ทันที หรือคลิกเวรที่มีอยู่เพื่อดู Snapshot/ยกเลิกเวร
 * 3. มี "มุมมองรายการ" (List View) สำหรับตรวจสอบรายละเอียด Snapshot เวลาเริ่ม-เลิกงาน นาทีผ่อนผัน
 *    เวลาตัดรอบสแกน และประวัติการยกเลิกเวรย้อนหลัง (Audit History)
 * 4. ย้ายฟอร์มมอบหมายเวรไปไว้ในหน้าต่าง Dialog ที่เปิดด้วยปุ่ม "มอบหมายเวร"
 *    รองรับการเลือกหลายบุคลากรและหลายวัน พร้อมระบบตรวจสอบความขัดแย้ง (Preview) ก่อนบันทึกจริง
 * 5. ใช้โทนสีม่วงอ่อน (#6D28D9 / #F5F3FF) ขาว (#FFFFFF) และเทาอ่อน (#F8FAFC / #E2E8F0)
 *    หลีกเลี่ยงการใช้ Gradient และการตกแต่งที่รกตา
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
  RotateCcw,
  FileCheck2,
  Eye,
} from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
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
import { formatThaiDate, formatThaiDateTime } from '../utils/thaiFormat.ts';

type MainTabKey = 'ROSTER' | 'TEMPLATES';
type RosterViewMode = 'MONTHLY_GRID' | 'DETAIL_LIST';
type MonthDayRangeMode = 'ALL' | 'FIRST_HALF' | 'SECOND_HALF';
type DateSelectionMode = 'DATE_RANGE' | 'MULTI_PICK';
type WeekdayFilterMode = 'ALL_DAYS' | 'WEEKDAYS_ONLY' | 'WEEKENDS_ONLY';
type ConflictStrategyMode = 'SKIP_CONFLICTS' | 'ABORT_ON_CONFLICT';

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

function formatThaiMonthTitle(monthValue: string): string {
  const [yStr, mStr] = (monthValue || '2026-11').split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  if (Number.isNaN(year) || Number.isNaN(month) || month < 1 || month > 12) {
    return monthValue;
  }
  return `${THAI_FULL_MONTHS[month - 1]} พ.ศ. ${year + 543}`;
}

function getMonthDateBounds(monthValue: string): {
  year: number;
  month: number;
  daysInMonth: number;
  dateFrom: string;
  dateTo: string;
  allDates: Array<{
    dateStr: string;
    dayNum: number;
    weekdayIdx: number;
    weekdayShort: string;
    isWeekend: boolean;
  }>;
} {
  const [yStr, mStr] = (monthValue || '2026-11').split('-');
  const year = Number(yStr) || 2026;
  const month = Number(mStr) || 11;
  const daysInMonth = new Date(year, month, 0).getDate();
  const mm = String(month).padStart(2, '0');
  const allDates: Array<{
    dateStr: string;
    dayNum: number;
    weekdayIdx: number;
    weekdayShort: string;
    isWeekend: boolean;
  }> = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dd = String(d).padStart(2, '0');
    const dateStr = `${year}-${mm}-${dd}`;
    const weekdayIdx = new Date(year, month - 1, d).getDay();
    allDates.push({
      dateStr,
      dayNum: d,
      weekdayIdx,
      weekdayShort: THAI_SHORT_WEEKDAYS[weekdayIdx],
      isWeekend: weekdayIdx === 0 || weekdayIdx === 6,
    });
  }

  return {
    year,
    month,
    daysInMonth,
    dateFrom: `${year}-${mm}-01`,
    dateTo: `${year}-${mm}-${String(daysInMonth).padStart(2, '0')}`,
    allDates,
  };
}

function shiftMonthString(monthValue: string, deltaMonths: number): string {
  const [yStr, mStr] = (monthValue || '2026-11').split('-');
  const dt = new Date(Number(yStr) || 2026, (Number(mStr) || 11) - 1 + deltaMonths, 1);
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
  const maxDays = 62; // จำกัดไม่เกิน 2 เดือนต่อครั้งเพื่อความรวดเร็วในการตรวจสอบ
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

const SHIFT_CATEGORY_LABELS: Record<string, string> = {
  OFFICIAL: 'เวรราชการ',
  MORNING: 'เวรเช้า',
  AFTERNOON: 'เวรบ่าย',
  NIGHT: 'เวรดึก',
  CROSS_MIDNIGHT: 'เวรข้ามวัน',
  SPECIAL: 'เวรพิเศษ',
};

export function ShiftsView() {
  // แท็บหลัก: ตารางเวร (ค่าเริ่มต้น) หรือ จัดการแม่แบบกะ
  const [activeTab, setActiveTab] = useState<MainTabKey>('ROSTER');
  // มุมมองภายในแท็บตารางเวร: ตารางเวรประจำเดือน (ค่าเริ่มต้น) หรือ มุมมองรายการ
  const [rosterViewMode, setRosterViewMode] = useState<RosterViewMode>('MONTHLY_GRID');
  // ช่วงวันที่ที่แสดงในตารางรายเดือน (ทั้งเดือน / ครึ่งเดือนแรก / ครึ่งเดือนหลัง)
  const [dayRangeMode, setDayRangeMode] = useState<MonthDayRangeMode>('ALL');

  // ข้อมูลจาก API
  const [shifts, setShifts] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [cancellationLogs, setCancellationLogs] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ตัวกรองตารางเวร
  const [selectedMonth, setSelectedMonth] = useState('2026-11');
  const [searchText, setSearchText] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('ALL');
  const [shiftFilter, setShiftFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ACTIVE' | 'CANCELLED' | 'ALL'>('ACTIVE');

  // ตัวกรองในแท็บจัดการแม่แบบกะ
  const [templateSearch, setTemplateSearch] = useState('');
  const [showCreateTemplateModal, setShowCreateTemplateModal] = useState(false);

  // ฟอร์มสร้างแม่แบบกะทำงานใหม่
  const [shiftCode, setShiftCode] = useState('');
  const [shiftName, setShiftName] = useState('');
  const [shiftCategory, setShiftCategory] = useState('OFFICIAL');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('16:00');
  const [graceMinutes, setGraceMinutes] = useState(15);
  const [cutoffTime, setCutoffTime] = useState('10:30');
  const [creatingTemplate, setCreatingTemplate] = useState(false);

  // หน้าต่างมอบหมายเวร (Bulk & Single Assignment Dialog)
  const [assignModalOpen, setAssignModalOpen] = useState(false);
  const [selectedPersonIds, setSelectedPersonIds] = useState<string[]>(['SAM-P001']);
  const [modalPersonDeptFilter, setModalPersonDeptFilter] = useState('ALL');
  const [modalPersonSearch, setModalPersonSearch] = useState('');
  const [assignShiftId, setAssignShiftId] = useState<number>(1);
  const [dateSelectionMode, setDateSelectionMode] = useState<DateSelectionMode>('DATE_RANGE');
  const [rangeStartDate, setRangeStartDate] = useState('2026-11-14');
  const [rangeEndDate, setRangeEndDate] = useState('2026-11-16');
  const [weekdayFilter, setWeekdayFilter] = useState<WeekdayFilterMode>('ALL_DAYS');
  const [multiPickedDates, setMultiPickedDates] = useState<string[]>(['2026-11-14']);
  const [conflictStrategy, setConflictStrategy] = useState<ConflictStrategyMode>('SKIP_CONFLICTS');

  // สถานะการตรวจสอบความขัดแย้ง (Preview) และการบันทึก
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<{
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
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [submittingBulk, setSubmittingBulk] = useState(false);

  // หน้าต่างดูรายละเอียดเวร / ยืนยันยกเลิกตารางเวร (Soft Cancel)
  const [inspectTarget, setInspectTarget] = useState<any | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState(
    'ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน (บันทึกประวัติการตรวจสอบ)'
  );

  // การเรียงลำดับและแบ่งหน้าสำหรับมุมมองรายการ (List View)
  const [sortKey, setSortKey] = useState('work_date');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const monthBounds = useMemo(() => getMonthDateBounds(selectedMonth), [selectedMonth]);

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
      setShifts(loadedShifts);
      setAssignments(saRes.items || []);
      setCancellationLogs(saRes.cancellationLogs || []);
      setPersonnel(pRes.items || []);

      if (loadedShifts.length > 0 && !loadedShifts.some((s: any) => Number(s.id) === assignShiftId)) {
        setAssignShiftId(Number(loadedShifts[0].id));
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
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

  // รายชื่อแผนกทั้งหมดจากข้อมูลบุคลากร
  const departments = useMemo(() => {
    const set = new Set<string>();
    for (const p of personnel) {
      if (p.department_name) set.add(p.department_name);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }, [personnel]);

  // กรองบุคลากรสำหรับแสดงในตารางเวรรายเดือน
  const filteredPersonnelForRoster = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return personnel.filter((p) => {
      if (departmentFilter !== 'ALL' && p.department_name !== departmentFilter) {
        return false;
      }
      if (q) {
        const hay = `${p.full_name || ''} ${p.person_id || ''} ${p.fingle_id || ''} ${p.position_name || ''} ${p.department_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [personnel, departmentFilter, searchText]);

  // กรองรายการตารางเวรตามตัวกรองทั้งหมด
  const filteredAssignments = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return assignments.filter((a) => {
      if (statusFilter !== 'ALL' && a.status !== statusFilter) return false;
      if (departmentFilter !== 'ALL' && a.department_name !== departmentFilter) return false;
      if (shiftFilter !== 'ALL' && String(a.shift_id) !== shiftFilter && a.snapshot_shift_code !== shiftFilter) {
        return false;
      }
      if (q) {
        const hay = `${a.full_name || ''} ${a.person_id || ''} ${a.snapshot_shift_name || ''} ${a.snapshot_shift_code || ''} ${a.department_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [assignments, statusFilter, departmentFilter, shiftFilter, searchText]);

  // จัดกลุ่มตารางเวรตาม (person_id -> work_date -> รายการเวร) สำหรับตารางรายเดือน
  const assignmentsByPersonAndDate = useMemo(() => {
    const map = new Map<string, Map<string, any[]>>();
    for (const a of filteredAssignments) {
      let dateMap = map.get(a.person_id);
      if (!dateMap) {
        dateMap = new Map<string, any[]>();
        map.set(a.person_id, dateMap);
      }
      const list = dateMap.get(a.work_date) || [];
      list.push(a);
      dateMap.set(a.work_date, list);
    }
    return map;
  }, [filteredAssignments]);

  // วันที่ที่จะแสดงในคอลัมน์ของตารางเวรประจำเดือน (รองรับทั้งเดือน / ครึ่งเดือนแรก / ครึ่งเดือนหลัง)
  const visibleMonthDates = useMemo(() => {
    if (dayRangeMode === 'FIRST_HALF') {
      return monthBounds.allDates.filter((d) => d.dayNum <= 15);
    }
    if (dayRangeMode === 'SECOND_HALF') {
      return monthBounds.allDates.filter((d) => d.dayNum >= 16);
    }
    return monthBounds.allDates;
  }, [monthBounds.allDates, dayRangeMode]);

  // คำนวณรายการวันที่ที่เลือกในหน้าต่างมอบหมายเวร
  const effectiveSelectedDates = useMemo(() => {
    if (dateSelectionMode === 'MULTI_PICK') {
      return [...multiPickedDates].sort();
    }
    return buildDatesFromRange(rangeStartDate, rangeEndDate, weekdayFilter);
  }, [dateSelectionMode, multiPickedDates, rangeStartDate, rangeEndDate, weekdayFilter]);

  // แม่แบบกะที่กำลังเลือกอยู่ในหน้าต่างมอบหมายเวร
  const selectedShiftTemplate = useMemo(
    () => shifts.find((s) => Number(s.id) === Number(assignShiftId)) || null,
    [shifts, assignShiftId]
  );

  // บุคลากรที่แสดงในรายการเลือกของหน้าต่างมอบหมายเวร
  const modalFilteredPersonnel = useMemo(() => {
    const q = modalPersonSearch.trim().toLowerCase();
    return personnel.filter((p) => {
      if (modalPersonDeptFilter !== 'ALL' && p.department_name !== modalPersonDeptFilter) {
        return false;
      }
      if (q) {
        const hay = `${p.full_name || ''} ${p.person_id || ''} ${p.department_name || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [personnel, modalPersonDeptFilter, modalPersonSearch]);

  // ล้างผล Preview เดิมเมื่อผู้ใช้เปลี่ยนเงื่อนไขในหน้าต่างมอบหมายเวร
  useEffect(() => {
    setPreviewData(null);
    setPreviewError(null);
  }, [selectedPersonIds, assignShiftId, effectiveSelectedDates]);

  // เปิดหน้าต่างมอบหมายเวร (รองรับการส่งค่าเริ่มต้นเมื่อคลิกจากช่องตารางรายเดือนหรือการ์ดแม่แบบกะ)
  function openAssignModal(preset?: { personId?: string; workDate?: string; shiftId?: number }) {
    setPreviewData(null);
    setPreviewError(null);
    if (preset?.personId) {
      setSelectedPersonIds([preset.personId]);
    } else if (selectedPersonIds.length === 0 && personnel.length > 0) {
      setSelectedPersonIds([personnel[0].person_id]);
    }
    if (preset?.shiftId) {
      setAssignShiftId(Number(preset.shiftId));
    }
    if (preset?.workDate) {
      setDateSelectionMode('MULTI_PICK');
      setMultiPickedDates([preset.workDate]);
      setRangeStartDate(preset.workDate);
      setRangeEndDate(preset.workDate);
    }
    setAssignModalOpen(true);
  }

  function toggleSelectPersonInModal(personId: string) {
    setSelectedPersonIds((prev) =>
      prev.includes(personId) ? prev.filter((id) => id !== personId) : [...prev, personId]
    );
  }

  function selectAllFilteredPersonsInModal() {
    const ids = modalFilteredPersonnel.map((p) => p.person_id);
    setSelectedPersonIds((prev) => Array.from(new Set([...prev, ...ids])));
  }

  function clearSelectedPersonsInModal() {
    setSelectedPersonIds([]);
  }

  function toggleMultiPickedDate(dateStr: string) {
    setMultiPickedDates((prev) =>
      prev.includes(dateStr) ? prev.filter((d) => d !== dateStr) : [...prev, dateStr]
    );
  }

  // เรียก API ตรวจสอบความขัดแย้ง (Bulk Conflict Preview)
  async function handleRunConflictPreview() {
    if (selectedPersonIds.length === 0) {
      setPreviewError('กรุณาเลือกบุคลากรอย่างน้อย 1 คน');
      return;
    }
    if (effectiveSelectedDates.length === 0) {
      setPreviewError('กรุณาเลือกวันที่ปฏิบัติงานอย่างน้อย 1 วัน');
      return;
    }
    if (!assignShiftId) {
      setPreviewError('กรุณาเลือกแม่แบบกะทำงาน');
      return;
    }

    setPreviewLoading(true);
    setPreviewError(null);
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
    } catch (err) {
      if (err instanceof ApiClientError) {
        setPreviewError(err.message);
      } else {
        setPreviewError('ไม่สามารถตรวจสอบความขัดแย้งของตารางเวรได้');
      }
    } finally {
      setPreviewLoading(false);
    }
  }

  // บันทึกการมอบหมายเวรจริงหลังจากตรวจสอบ Preview แล้ว
  async function handleConfirmBulkAssign() {
    if (!previewData) {
      await handleRunConflictPreview();
      return;
    }

    if (
      conflictStrategy === 'ABORT_ON_CONFLICT' &&
      previewData.summary.conflictCount > 0
    ) {
      setPreviewError(
        `พบรายการขัดแย้ง ${previewData.summary.conflictCount} รายการ กรุณาเปลี่ยนนโยบายเป็น "ข้ามเฉพาะรายการที่ซ้ำ/ทับซ้อน" หรือปรับวันที่เลือกใหม่`
      );
      return;
    }

    if (previewData.summary.readyCount === 0) {
      setPreviewError('ไม่มีรายการตารางเวรใหม่ที่สามารถบันทึกได้ (ทุกรายการมีเวรอยู่แล้วหรือเวลาทับซ้อน)');
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
          ? `บันทึกตารางเวรสำเร็จ ${inserted} รายการ (ข้ามรายการที่มีเวรซ้ำหรือเวลาทับซ้อน ${skipped} รายการ โดยไม่แก้ไขข้อมูลเวรเดิม)`
          : `บันทึกการมอบหมายตารางเวรสำเร็จ ${inserted} รายการ`
      );
      setAssignModalOpen(false);
      setPreviewData(null);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setPreviewError(err.message);
      } else {
        setPreviewError('เกิดข้อผิดพลาดในการบันทึกตารางเวร');
      }
    } finally {
      setSubmittingBulk(false);
    }
  }

  // สร้างแม่แบบกะทำงานใหม่ในแท็บ "จัดการแม่แบบกะ"
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
          shiftName,
          shiftCategory,
          startTime,
          endTime,
          graceMinutes: Number(graceMinutes),
          cutoffTime,
        }),
      });
      setShiftCode('');
      setShiftName('');
      setShowCreateTemplateModal(false);
      setNotice('สร้างแม่แบบกะทำงานใหม่เรียบร้อยแล้ว');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
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
        setError({ code: err.code, message: err.message });
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

  // กรองแม่แบบกะทำงานในแท็บที่ 2
  const filteredShifts = useMemo(() => {
    const q = templateSearch.trim().toLowerCase();
    if (!q) return shifts;
    return shifts.filter((s) => {
      const hay = `${s.shift_code || ''} ${s.shift_name || ''} ${s.shift_category || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [shifts, templateSearch]);

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

  return (
    <div className="space-y-5">
      {/* ส่วนหัวของหน้า พร้อมปุ่มหลัก "มอบหมายเวร" */}
      <div className="bg-white border border-slate-200 rounded-xl p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1">
          <div className="text-[12.5px] font-semibold text-violet-700">
            ระบบบริหารตารางเวรและเวลาปฏิบัติงาน · โรงพยาบาลสามชุก
          </div>
          <h1 className="text-[20px] sm:text-[23px] font-bold text-slate-800 tracking-tight">
            ตารางเวรและแม่แบบกะทำงาน
          </h1>
          <p className="text-[13.5px] text-slate-600">
            จัดตารางเวรประจำเดือน มอบหมายเวรหลายวันหรือหลายคนพร้อมตรวจความขัดแย้ง และรักษาค่าเวลาตามแม่แบบกะ (Snapshot)
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          {activeTab === 'TEMPLATES' && (
            <button
              type="button"
              onClick={() => setShowCreateTemplateModal(true)}
              className="h-10 px-4 rounded-lg border border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100 text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <Clock className="w-4 h-4 text-violet-700" />
              <span>เพิ่มแม่แบบกะใหม่</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => openAssignModal()}
            className="h-10 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>มอบหมายเวร</span>
          </button>
        </div>
      </div>

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* แถบสลับแท็บหลัก: 1. ตารางเวร | 2. จัดการแม่แบบกะ */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div
          role="tablist"
          aria-label="แถบเมนูหลักตารางเวรและแม่แบบกะ"
          className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg w-full sm:w-auto"
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ROSTER'}
            onClick={() => setActiveTab('ROSTER')}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-md text-[14px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'ROSTER'
                ? 'bg-white text-violet-800 border border-slate-200/80 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Calendar className="w-4 h-4" />
            <span>ตารางเวร</span>
            <span className="font-mono text-[12.5px] text-slate-500 tabular-nums">
              ({activeCountInMonth})
            </span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'TEMPLATES'}
            onClick={() => setActiveTab('TEMPLATES')}
            className={`flex-1 sm:flex-initial px-4 py-2 rounded-md text-[14px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap ${
              activeTab === 'TEMPLATES'
                ? 'bg-white text-violet-800 border border-slate-200/80 shadow-2xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            <Clock className="w-4 h-4" />
            <span>จัดการแม่แบบกะ</span>
            <span className="font-mono text-[12.5px] text-slate-500 tabular-nums">
              ({shifts.length})
            </span>
          </button>
        </div>

        {/* สลับมุมมองภายในแท็บตารางเวร (ตารางเวรประจำเดือน / มุมมองรายการ) */}
        {activeTab === 'ROSTER' && (
          <div className="inline-flex items-center p-1 bg-slate-100 border border-slate-200 rounded-lg self-start sm:self-auto">
            <button
              type="button"
              onClick={() => setRosterViewMode('MONTHLY_GRID')}
              className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                rosterViewMode === 'MONTHLY_GRID'
                  ? 'bg-violet-700 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>ตารางเวรประจำเดือน</span>
            </button>
            <button
              type="button"
              onClick={() => setRosterViewMode('DETAIL_LIST')}
              className={`px-3.5 py-1.5 rounded-md text-[13px] font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap ${
                rosterViewMode === 'DETAIL_LIST'
                  ? 'bg-violet-700 text-white'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <List className="w-3.5 h-3.5" />
              <span>มุมมองรายการ ({filteredAssignments.length})</span>
            </button>
          </div>
        )}
      </div>

      {/* =====================================================================
          แท็บที่ 1: ตารางเวร (ROSTER TAB)
         ===================================================================== */}
      {activeTab === 'ROSTER' && (
        <div className="space-y-4">
          {/* แถบค้นหาและตัวกรอง (กระชับ ไม่รก) */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3.5">
            <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
              {/* เลือกเดือนพร้อมปุ่มเลื่อนเดือน */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center bg-slate-50 border border-slate-200 rounded-lg p-1">
                  <button
                    type="button"
                    onClick={() => setSelectedMonth((m) => shiftMonthString(m, -1))}
                    className="p-1.5 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition-colors"
                    title="เดือนก่อนหน้า"
                    aria-label="เดือนก่อนหน้า"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <input
                    type="month"
                    aria-label="เลือกเดือนตารางเวร"
                    value={selectedMonth}
                    onChange={(e) => setSelectedMonth(e.target.value || '2026-11')}
                    className="px-2.5 py-1 bg-transparent text-[13.5px] font-mono font-semibold text-slate-800 focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setSelectedMonth((m) => shiftMonthString(m, 1))}
                    className="p-1.5 rounded-md text-slate-600 hover:text-slate-900 hover:bg-white transition-colors"
                    title="เดือนถัดไป"
                    aria-label="เดือนถัดไป"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <span className="text-[14px] font-bold text-violet-900 bg-violet-50 border border-violet-200 px-3 py-1.5 rounded-lg">
                  {formatThaiMonthTitle(selectedMonth)}
                </span>

                <span className="text-[13px] text-slate-500 hidden sm:inline">
                  บุคลากร {filteredPersonnelForRoster.length} คน · เวรปกติ {activeCountInMonth} เวร · เวรข้ามวัน {crossMidnightCountInMonth} เวร
                </span>
              </div>

              {/* ตัวเลือกช่วงวันที่สำหรับตารางรายเดือน (ช่วยให้ดูบน Tablet ได้ง่าย) */}
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
                    ครึ่งแรก (1–15)
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
                    ครึ่งหลัง (16–{monthBounds.daysInMonth})
                  </button>
                </div>
              )}
            </div>

            {/* แถวตัวกรอง: ค้นหา, แผนก, กะทำงาน, สถานะ */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-2.5 items-center">
              <div className="relative lg:col-span-4">
                <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchText}
                  onChange={(e) => {
                    setSearchText(e.target.value);
                    setPage(1);
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
                  }}
                  className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                >
                  <option value="ALL">ทุกกะทำงาน ({shifts.length} แม่แบบ)</option>
                  {shifts.map((s) => (
                    <option key={s.id} value={String(s.id)}>
                      {s.shift_code} · {s.shift_name} ({s.start_time}–{s.end_time})
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
                  <option value="ACTIVE">ใช้งานปกติ</option>
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
              มุมมองที่ 1.1: ตารางเวรประจำเดือน (MONTHLY ROSTER GRID - หน้าหลัก)
             ================================================================= */}
          {rosterViewMode === 'MONTHLY_GRID' ? (
            <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 sm:px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <h2 className="text-[16px] font-bold text-slate-800">
                    ตารางเวรประจำเดือน {formatThaiMonthTitle(selectedMonth)}
                  </h2>
                  <p className="text-[12.5px] text-slate-600">
                    คลิกที่ช่องว่างเพื่อมอบหมายเวรในวันนั้นทันที หรือคลิกที่ป้ายรหัสกะเพื่อดูเวลา Snapshot และยกเลิกเวร
                  </p>
                </div>

                {/* คำอธิบายสัญลักษณ์สีแบบเรียบง่าย */}
                <div className="flex flex-wrap items-center gap-3 text-[12px] text-slate-600">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-violet-100 border border-violet-300 inline-block" />
                    <span>เวรภายในวัน</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-blue-100 border border-blue-300 inline-block" />
                    <span>เวรข้ามวัน (+1 วัน)</span>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-xs bg-slate-100 border border-slate-300 inline-block" />
                    <span>วันเสาร์–อาทิตย์</span>
                  </span>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-left text-[13px]">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                      <th className="sticky left-0 z-10 bg-slate-50 py-3 px-4 font-semibold min-w-[230px] max-w-[260px] border-r border-slate-200">
                        บุคลากร / กลุ่มงาน ({filteredPersonnelForRoster.length} คน)
                      </th>
                      <th className="py-3 px-2.5 font-semibold text-center min-w-[68px] border-r border-slate-200 bg-slate-50">
                        รวมเวร
                      </th>
                      {visibleMonthDates.map((d) => (
                        <th
                          key={d.dateStr}
                          className={`py-2 px-1.5 text-center min-w-[66px] border-r border-slate-200/80 font-mono tabular-nums ${
                            d.isWeekend ? 'bg-slate-100/90 text-slate-700' : 'bg-slate-50 text-slate-700'
                          }`}
                        >
                          <div className="text-[11px] font-sans font-medium text-slate-500">
                            {d.weekdayShort}
                          </div>
                          <div className="text-[13px] font-bold">{d.dayNum}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {loading ? (
                      <tr>
                        <td
                          colSpan={visibleMonthDates.length + 2}
                          className="py-12 text-center text-[14px] text-slate-500"
                        >
                          กำลังโหลดตารางเวรประจำเดือน...
                        </td>
                      </tr>
                    ) : filteredPersonnelForRoster.length === 0 ? (
                      <TableEmptyState
                        colSpan={visibleMonthDates.length + 2}
                        title="ไม่พบบุคลากรตามเงื่อนไขที่ค้นหา"
                        description="ลองเปลี่ยนคำค้นหาหรือเลือกทุกกลุ่มงานเพื่อแสดงตารางเวรทั้งหมด"
                      />
                    ) : (
                      filteredPersonnelForRoster.map((person) => {
                        const personDateMap = assignmentsByPersonAndDate.get(person.person_id);
                        let personTotalShifts = 0;
                        if (personDateMap) {
                          for (const list of personDateMap.values()) {
                            personTotalShifts += list.filter((x) => x.status === 'ACTIVE').length;
                          }
                        }

                        return (
                          <tr key={person.person_id} className="hover:bg-violet-50/30 transition-colors">
                            {/* คอลัมน์รายชื่อบุคลากร (Sticky Left บน Desktop/Tablet) */}
                            <td className="sticky left-0 z-10 bg-white py-3 px-4 border-r border-slate-200 align-top">
                              <div className="font-bold text-[13.5px] text-slate-800 leading-snug">
                                {person.full_name}
                              </div>
                              <div className="text-[12px] text-slate-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
                                <span className="font-mono">{person.person_id}</span>
                                <span aria-hidden="true">·</span>
                                <span className="truncate max-w-[150px]">{person.department_name}</span>
                              </div>
                            </td>

                            {/* จำนวนเวรรวมของบุคลากรในเดือนนี้ */}
                            <td className="py-3 px-2 text-center font-mono tabular-nums font-bold text-violet-800 border-r border-slate-200 align-middle bg-slate-50/40">
                              {personTotalShifts}
                            </td>

                            {/* ช่องวันที่แต่ละวันในเดือน */}
                            {visibleMonthDates.map((d) => {
                              const cellItems = personDateMap?.get(d.dateStr) || [];
                              return (
                                <td
                                  key={d.dateStr}
                                  className={`p-1.5 border-r border-slate-200/70 align-top min-h-[58px] ${
                                    d.isWeekend ? 'bg-slate-50/70' : ''
                                  }`}
                                >
                                  <div className="flex flex-col gap-1 min-h-[44px]">
                                    {cellItems.map((item) => {
                                      const isCross = Number(item.snapshot_is_cross_midnight) === 1;
                                      const isCancelled = item.status !== 'ACTIVE';
                                      return (
                                        <button
                                          key={item.id}
                                          type="button"
                                          onClick={() => setInspectTarget(item)}
                                          title={`${item.snapshot_shift_name} (${item.snapshot_start_time}–${item.snapshot_end_time} น.) คลิกเพื่อดูรายละเอียดหรือยกเลิกเวร`}
                                          className={`w-full text-left px-1.5 py-1 rounded border text-[11.5px] leading-tight transition-colors ${
                                            isCancelled
                                              ? 'bg-red-50 border-red-200 text-red-700 line-through'
                                              : isCross
                                                ? 'bg-blue-50 border-blue-200 text-blue-900 hover:bg-blue-100'
                                                : 'bg-violet-50 border-violet-200 text-violet-900 hover:bg-violet-100'
                                          }`}
                                        >
                                          <div className="font-mono font-bold flex items-center justify-between gap-0.5">
                                            <span className="truncate">{item.snapshot_shift_code}</span>
                                            {isCross && <Moon className="w-3 h-3 text-blue-700 shrink-0" />}
                                          </div>
                                          <div className="font-mono text-[10.5px] opacity-85 tabular-nums">
                                            {item.snapshot_start_time}–{item.snapshot_end_time}
                                          </div>
                                        </button>
                                      );
                                    })}

                                    {/* ปุ่มเพิ่มเวรในช่องวันที่นั้นโดยตรง */}
                                    <button
                                      type="button"
                                      onClick={() =>
                                        openAssignModal({
                                          personId: person.person_id,
                                          workDate: d.dateStr,
                                        })
                                      }
                                      className={`w-full rounded border border-dashed text-[11px] flex items-center justify-center transition-colors ${
                                        cellItems.length === 0
                                          ? 'h-10 border-slate-200 text-slate-400 hover:border-violet-400 hover:text-violet-700 hover:bg-violet-50/50'
                                          : 'h-6 border-slate-200 text-slate-400 hover:border-violet-400 hover:text-violet-700 hover:bg-violet-50/50'
                                      }`}
                                      title={`มอบหมายเวรให้ ${person.full_name} วันที่ ${formatThaiDate(d.dateStr)}`}
                                      aria-label={`มอบหมายเวรให้ ${person.full_name} วันที่ ${formatThaiDate(d.dateStr)}`}
                                    >
                                      <Plus className="w-3.5 h-3.5" />
                                    </button>
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
          ) : (
            /* =================================================================
               มุมมองที่ 1.2: มุมมองรายการละเอียดและประวัติการยกเลิก (LIST VIEW)
               ================================================================= */
            <div className="space-y-5">
              <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="px-4 sm:px-6 py-4 border-b border-slate-200 bg-slate-50 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h2 className="text-[16.5px] font-bold text-slate-800">
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
                              <div className="font-bold text-[15px] text-slate-800">{a.full_name}</div>
                              <div className="text-[12.5px] text-slate-500">
                                {a.person_id} · {a.department_name}
                              </div>
                            </div>
                            <span
                              className={`text-[12.5px] font-semibold px-2.5 py-0.5 rounded border ${
                                a.status === 'ACTIVE'
                                  ? 'text-emerald-800 bg-emerald-50 border-emerald-200'
                                  : 'text-red-800 bg-red-50 border-red-200'
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
                                {a.snapshot_shift_name} ({a.snapshot_shift_code})
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500">เวลาตาม Snapshot:</span>
                              <span className="font-mono text-slate-800">
                                {a.snapshot_start_time} – {a.snapshot_end_time} น.{' '}
                                {isCross ? '(ข้ามวัน +1)' : ''}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500">ผ่อนผันสาย / ตัดรอบ:</span>
                              <span className="font-mono text-slate-700">
                                {a.snapshot_grace_minutes} นาที / ตัดรอบ {a.snapshot_cutoff_time} น.
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
                          description="คลิกปุ่ม “มอบหมายเวร” ด้านบนเพื่อเพิ่มตารางเวรใหม่"
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
                                <div className="font-bold text-slate-800">{a.full_name}</div>
                                <div className="text-[12px] text-slate-500 mt-0.5">
                                  <span className="font-mono">{a.person_id}</span> · {a.department_name}
                                </div>
                              </td>
                              <td className="py-3.5 px-4">
                                <div className="font-semibold text-slate-800">{a.snapshot_shift_name}</div>
                                <div className="text-[12px] font-mono text-violet-700 mt-0.5">
                                  รหัสกะ: {a.snapshot_shift_code}
                                  {isCross ? ' · เวรข้ามวัน (+1 วัน)' : ''}
                                </div>
                              </td>
                              <td className="py-3.5 px-4 font-mono tabular-nums text-slate-800 whitespace-nowrap">
                                {a.snapshot_start_time} – {a.snapshot_end_time} น.
                              </td>
                              <td className="py-3.5 px-4 font-mono tabular-nums text-[12.5px] text-slate-600 whitespace-nowrap">
                                ผ่อนผัน {a.snapshot_grace_minutes} น. · ตัดรอบ {a.snapshot_cutoff_time} น.
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
                      ระบบรักษาประวัติการยกเลิกเวรทุกครั้ง (Soft Cancel Audit Trail) เพื่อความโปร่งใสในการตรวจสอบของฝ่ายทรัพยากรบุคคล
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
          แท็บที่ 2: จัดการแม่แบบกะ (SHIFT TEMPLATES TAB)
         ===================================================================== */}
      {activeTab === 'TEMPLATES' && (
        <div className="space-y-5">
          {/* แถบค้นหาแม่แบบกะและปุ่มสร้างแม่แบบกะ */}
          <div className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div className="relative w-full sm:max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={templateSearch}
                onChange={(e) => setTemplateSearch(e.target.value)}
                placeholder="ค้นหารหัสกะ หรือชื่อแม่แบบกะทำงาน..."
                className="w-full h-10 pl-9 pr-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-violet-600"
              />
            </div>

            <div className="flex items-center gap-2.5">
              <span className="text-[13px] text-slate-500">
                แสดง {filteredShifts.length} จาก {shifts.length} แม่แบบกะ
              </span>
              <button
                type="button"
                onClick={() => setShowCreateTemplateModal((prev) => !prev)}
                className="h-10 px-4 rounded-lg bg-violet-700 hover:bg-violet-800 text-white text-[13.5px] font-semibold inline-flex items-center gap-2 transition-colors whitespace-nowrap"
              >
                <Plus className="w-4 h-4" />
                <span>{showCreateTemplateModal ? 'ซ่อนฟอร์มสร้างแม่แบบกะ' : 'สร้างแม่แบบกะใหม่'}</span>
              </button>
            </div>
          </div>

          {/* ฟอร์มสร้างแม่แบบกะทำงานใหม่ (อยู่ในแท็บจัดการแม่แบบกะตามข้อกำหนดข้อ 5) */}
          {showCreateTemplateModal && (
            <form
              onSubmit={handleCreateShift}
              className="bg-white border border-violet-200 rounded-xl p-5 sm:p-6 space-y-5"
            >
              <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3.5">
                <div>
                  <h2 className="text-[17px] font-bold text-slate-800">
                    สร้างแม่แบบกะทำงานใหม่
                  </h2>
                  <p className="text-[13px] text-slate-600 mt-0.5">
                    กำหนดเวลาเริ่ม–เลิกงานในระบบ 24 ชั่วโมง (หากเวลาเลิกงานน้อยกว่าหรือเท่ากับเวลาเริ่มงาน ระบบจะกำหนดเป็นเวรข้ามเที่ยงคืนอัตโนมัติ)
                  </p>
                </div>
                <span className="text-[12.5px] font-medium text-violet-800 bg-violet-50 border border-violet-200 px-3 py-1 rounded-md">
                  {endTime <= startTime ? 'ตรวจพบเป็น: เวรข้ามเที่ยงคืน (+1 วัน)' : 'ตรวจพบเป็น: เวรภายในวันเดียว'}
                </span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <div>
                  <label htmlFor="shift-code" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                    รหัสกะทำงาน <RequiredMark />
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

                <div className="sm:col-span-2">
                  <label htmlFor="shift-name" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                    ชื่อแม่แบบกะทำงาน <RequiredMark />
                  </label>
                  <input
                    id="shift-name"
                    type="text"
                    required
                    value={shiftName}
                    onChange={(e) => setShiftName(e.target.value)}
                    placeholder="เช่น เวรอุบัติเหตุ-ฉุกเฉิน ดึกข้ามวัน"
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  />
                </div>

                <div>
                  <label htmlFor="shift-category" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                    หมวดหมู่กะ <RequiredMark />
                  </label>
                  <select
                    id="shift-category"
                    value={shiftCategory}
                    onChange={(e) => setShiftCategory(e.target.value)}
                    className="w-full h-10 px-3 rounded-lg border border-slate-300 bg-white text-[13.5px] text-slate-800 focus:outline-none focus:border-violet-600"
                  >
                    <option value="OFFICIAL">เวรราชการ (OFFICIAL)</option>
                    <option value="MORNING">เวรเช้า (MORNING)</option>
                    <option value="AFTERNOON">เวรบ่าย (AFTERNOON)</option>
                    <option value="NIGHT">เวรดึก (NIGHT)</option>
                    <option value="CROSS_MIDNIGHT">เวรข้ามวัน (CROSS_MIDNIGHT)</option>
                    <option value="SPECIAL">เวรพิเศษ (SPECIAL)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="shift-start" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
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
                  <label htmlFor="shift-end" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
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
                  <label htmlFor="shift-grace" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                    เวลาผ่อนผันสาย (นาที) <RequiredMark />
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
                  <label htmlFor="shift-cutoff" className="block text-[13px] font-semibold text-slate-700 mb-1.5">
                    เวลาตัดรอบขาดสแกน <RequiredMark />
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
                  onClick={() => setShowCreateTemplateModal(false)}
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

          {/* รายการแม่แบบกะทำงานทั้งหมด */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredShifts.map((s) => {
              const isCross = Number(s.is_cross_midnight) === 1;
              const categoryText =
                SHIFT_CATEGORY_LABELS[String(s.shift_category || '').toUpperCase()] ||
                s.shift_category ||
                'เวรปฏิบัติงาน';
              return (
                <div
                  key={s.id}
                  className="bg-white border border-slate-200 rounded-xl p-5 flex flex-col justify-between space-y-4 hover:border-violet-300 transition-colors"
                >
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[13px] font-bold text-violet-800 bg-violet-50 px-2.5 py-1 rounded border border-violet-200">
                        {s.shift_code}
                      </span>
                      <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-slate-600">
                        {isCross ? (
                          <>
                            <Moon className="w-3.5 h-3.5 text-blue-700" />
                            <span className="text-blue-700 font-semibold">เวรข้ามวัน (+1 วัน)</span>
                          </>
                        ) : (
                          <>
                            <Sun className="w-3.5 h-3.5 text-emerald-700" />
                            <span>ภายในวันเดียว</span>
                          </>
                        )}
                      </span>
                    </div>

                    <h3 className="text-[16px] font-bold text-slate-800">{s.shift_name}</h3>
                    <div className="text-[12.5px] text-slate-500">
                      หมวดหมู่: {categoryText} · สถานะ: เปิดใช้งาน
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-200 space-y-1.5 text-[13.5px]">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาเริ่ม–เลิกงาน:</span>
                      <span className="font-mono font-bold text-slate-800 tabular-nums">
                        {s.start_time} – {s.end_time} น.
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาผ่อนผันสาย:</span>
                      <span className="font-mono font-semibold text-emerald-700 tabular-nums">
                        {s.grace_minutes} นาที
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-500">เวลาตัดรอบขาดสแกน:</span>
                      <span className="font-mono font-semibold text-amber-700 tabular-nums">
                        {s.cutoff_time} น.
                      </span>
                    </div>
                  </div>

                  <div className="pt-2">
                    <button
                      type="button"
                      onClick={() => openAssignModal({ shiftId: Number(s.id) })}
                      className="w-full h-9 px-3 rounded-lg border border-violet-200 bg-violet-50 hover:bg-violet-100 text-violet-800 text-[13px] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>มอบหมายเวรด้วยแม่แบบนี้</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* =====================================================================
          DIALOG 1: หน้าต่างมอบหมายเวร (รองรับหลายบุคลากร + หลายวัน + Preview ความขัดแย้ง)
         ===================================================================== */}
      <SharedModal
        open={assignModalOpen}
        onClose={() => setAssignModalOpen(false)}
        kickerText="ระบบมอบหมายตารางเวรและตรวจสอบความขัดแย้งอัตโนมัติ"
        title="มอบหมายเวรปฏิบัติงาน (รายบุคคล หรือ หลายบุคลากร / หลายวัน)"
        subtitle="ระบบจะคัดลอกค่าเวลาเริ่ม–เลิกงาน เวลาผ่อนผันสาย และเวลาตัดรอบสแกน (Snapshot) ลงในเวรแต่ละรายการโดยไม่กระทบข้อมูลเวรเดิม"
        maxWidthClass="max-w-4xl"
        footer={
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
            <button
              type="button"
              onClick={handleRunConflictPreview}
              disabled={previewLoading || submittingBulk}
              className="h-10 px-4 rounded-lg border border-violet-300 bg-violet-50 hover:bg-violet-100 text-violet-900 text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <FileCheck2 className="w-4 h-4 text-violet-700" />
              <span>
                {previewLoading ? 'กำลังตรวจสอบความขัดแย้ง...' : '1. ตรวจสอบความขัดแย้ง (Preview)'}
              </span>
            </button>

            <button
              type="button"
              onClick={handleConfirmBulkAssign}
              disabled={
                submittingBulk ||
                previewLoading ||
                !previewData ||
                previewData.summary.readyCount === 0 ||
                (conflictStrategy === 'ABORT_ON_CONFLICT' && previewData.summary.conflictCount > 0)
              }
              className="h-10 px-5 rounded-lg bg-violet-700 hover:bg-violet-800 disabled:opacity-45 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors whitespace-nowrap"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>
                {submittingBulk
                  ? 'กำลังบันทึกตารางเวร...'
                  : previewData
                    ? `2. ยืนยันบันทึกเวร (${previewData.summary.readyCount} รายการ)`
                    : '2. ยืนยันบันทึกเวร'}
              </span>
            </button>
          </div>
        }
      >
        <div className="space-y-5">
          {/* ขั้นตอนที่ 1: เลือกแม่แบบกะทำงาน */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <label htmlFor="modal-select-shift" className="text-[14px] font-bold text-slate-800">
                1. เลือกแม่แบบกะทำงาน <RequiredMark />
              </label>
              {selectedShiftTemplate && (
                <span className="text-[12.5px] font-mono text-violet-800 bg-violet-50 border border-violet-200 px-2.5 py-1 rounded">
                  Snapshot: {selectedShiftTemplate.start_time}–{selectedShiftTemplate.end_time} น. · ผ่อนผัน{' '}
                  {selectedShiftTemplate.grace_minutes} นาที · ตัดรอบ {selectedShiftTemplate.cutoff_time} น.
                  {Number(selectedShiftTemplate.is_cross_midnight) === 1 ? ' · ข้ามเที่ยงคืน (+1 วัน)' : ''}
                </span>
              )}
            </div>

            <select
              id="modal-select-shift"
              value={assignShiftId}
              onChange={(e) => setAssignShiftId(Number(e.target.value))}
              className="w-full h-10.5 px-3.5 rounded-lg border border-slate-300 bg-white text-[14px] font-medium text-slate-800 focus:outline-none focus:border-violet-600"
            >
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  [{s.shift_code}] {s.shift_name} ({s.start_time}–{s.end_time} น.
                  {Number(s.is_cross_midnight) === 1 ? ' · เวรข้ามวัน' : ''})
                </option>
              ))}
            </select>
          </div>

          {/* ขั้นตอนที่ 2 และ 3: เลือกบุคลากร (หลายคน) และ เลือกวันที่ปฏิบัติงาน (หลายวัน) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* 2. เลือกบุคลากร */}
            <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-3 flex flex-col">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[14px] font-bold text-slate-800 inline-flex items-center gap-1.5">
                  <Users className="w-4 h-4 text-violet-700" />
                  <span>2. เลือกบุคลากร ({selectedPersonIds.length} คน)</span>
                  <RequiredMark />
                </div>
                <div className="inline-flex items-center gap-2 text-[12px]">
                  <button
                    type="button"
                    onClick={selectAllFilteredPersonsInModal}
                    className="text-violet-700 hover:underline font-semibold"
                  >
                    เลือกทั้งหมดที่แสดง
                  </button>
                  <span className="text-slate-300">|</span>
                  <button
                    type="button"
                    onClick={clearSelectedPersonsInModal}
                    className="text-slate-500 hover:underline"
                  >
                    ล้าง
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select
                  aria-label="กรองแผนกในการเลือกบุคลากร"
                  value={modalPersonDeptFilter}
                  onChange={(e) => setModalPersonDeptFilter(e.target.value)}
                  className="h-9 px-2.5 rounded-lg border border-slate-300 bg-slate-50 text-[12.5px] text-slate-700"
                >
                  <option value="ALL">ทุกกลุ่มงาน/แผนก</option>
                  {departments.map((dept) => (
                    <option key={dept} value={dept}>
                      {dept}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  value={modalPersonSearch}
                  onChange={(e) => setModalPersonSearch(e.target.value)}
                  placeholder="ค้นหาชื่อหรือรหัส..."
                  className="h-9 px-2.5 rounded-lg border border-slate-300 bg-white text-[12.5px] text-slate-800"
                />
              </div>

              <div className="border border-slate-200 rounded-lg divide-y divide-slate-200 max-h-52 overflow-y-auto bg-slate-50/40">
                {modalFilteredPersonnel.map((p) => {
                  const checked = selectedPersonIds.includes(p.person_id);
                  return (
                    <label
                      key={p.person_id}
                      className={`flex items-start gap-2.5 px-3 py-2.5 cursor-pointer text-[13px] transition-colors ${
                        checked ? 'bg-violet-50/80' : 'hover:bg-white'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleSelectPersonInModal(p.person_id)}
                        className="mt-0.5 rounded border-slate-300 text-violet-700 focus:ring-violet-600"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-800 truncate">{p.full_name}</div>
                        <div className="text-[11.5px] text-slate-500 truncate">
                          <span className="font-mono">{p.person_id}</span> · {p.department_name}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* 3. เลือกวันที่ปฏิบัติงาน (ช่วงวันที่ หรือ เลือกหลายวันในเดือน) */}
            <div className="p-4 rounded-xl bg-white border border-slate-200 space-y-3 flex flex-col justify-between">
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-[14px] font-bold text-slate-800 inline-flex items-center gap-1.5">
                    <Calendar className="w-4 h-4 text-violet-700" />
                    <span>3. เลือกวันที่ปฏิบัติงาน ({effectiveSelectedDates.length} วัน)</span>
                    <RequiredMark />
                  </div>

                  <div className="inline-flex items-center p-0.5 bg-slate-100 border border-slate-200 rounded-md text-[12px]">
                    <button
                      type="button"
                      onClick={() => setDateSelectionMode('DATE_RANGE')}
                      className={`px-2.5 py-1 rounded font-medium ${
                        dateSelectionMode === 'DATE_RANGE'
                          ? 'bg-white text-violet-800 font-semibold shadow-2xs'
                          : 'text-slate-600'
                      }`}
                    >
                      ช่วงวันที่
                    </button>
                    <button
                      type="button"
                      onClick={() => setDateSelectionMode('MULTI_PICK')}
                      className={`px-2.5 py-1 rounded font-medium ${
                        dateSelectionMode === 'MULTI_PICK'
                          ? 'bg-white text-violet-800 font-semibold shadow-2xs'
                          : 'text-slate-600'
                      }`}
                    >
                      เลือกวันเอง
                    </button>
                  </div>
                </div>

                {dateSelectionMode === 'DATE_RANGE' ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[12.5px] font-medium text-slate-600 mb-1">
                          ตั้งแต่วันที่
                        </label>
                        <input
                          type="date"
                          value={rangeStartDate}
                          onChange={(e) => setRangeStartDate(e.target.value)}
                          className="w-full h-9.5 px-3 rounded-lg border border-slate-300 font-mono text-[13px] text-slate-800"
                        />
                      </div>
                      <div>
                        <label className="block text-[12.5px] font-medium text-slate-600 mb-1">
                          ถึงวันที่
                        </label>
                        <input
                          type="date"
                          value={rangeEndDate}
                          onChange={(e) => setRangeEndDate(e.target.value)}
                          className="w-full h-9.5 px-3 rounded-lg border border-slate-300 font-mono text-[13px] text-slate-800"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[12.5px] font-medium text-slate-600 mb-1">
                        กรองวันในสัปดาห์
                      </label>
                      <select
                        value={weekdayFilter}
                        onChange={(e) => setWeekdayFilter(e.target.value as WeekdayFilterMode)}
                        className="w-full h-9.5 px-3 rounded-lg border border-slate-300 bg-white text-[13px] text-slate-800"
                      >
                        <option value="ALL_DAYS">ทุกวันในช่วงที่เลือก</option>
                        <option value="WEEKDAYS_ONLY">เฉพาะวันทำการ (จันทร์ – ศุกร์)</option>
                        <option value="WEEKENDS_ONLY">เฉพาะวันหยุดสุดสัปดาห์ (เสาร์ – อาทิตย์)</option>
                      </select>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[12px] text-slate-600">
                      <span>คลิกเลือกวันที่ในเดือน {formatThaiMonthTitle(selectedMonth)}:</span>
                      <button
                        type="button"
                        onClick={() => setMultiPickedDates([])}
                        className="text-slate-500 hover:underline"
                      >
                        ล้างวันที่เลือก
                      </button>
                    </div>
                    <div className="grid grid-cols-7 gap-1.5 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                      {monthBounds.allDates.map((d) => {
                        const active = multiPickedDates.includes(d.dateStr);
                        return (
                          <button
                            key={d.dateStr}
                            type="button"
                            onClick={() => toggleMultiPickedDate(d.dateStr)}
                            className={`h-9 rounded-md font-mono text-[12px] flex flex-col items-center justify-center border transition-colors ${
                              active
                                ? 'bg-violet-700 border-violet-700 text-white font-bold'
                                : d.isWeekend
                                  ? 'bg-slate-100 border-slate-200 text-slate-700 hover:border-violet-400'
                                  : 'bg-white border-slate-200 text-slate-800 hover:border-violet-400'
                            }`}
                          >
                            <span className="text-[9.5px] opacity-75 leading-none">{d.weekdayShort}</span>
                            <span className="leading-tight">{d.dayNum}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>

              {/* นโยบายเมื่อพบเวรซ้ำหรือเวลาทับซ้อน */}
              <div className="pt-3 border-t border-slate-200 space-y-1.5">
                <label className="block text-[12.5px] font-semibold text-slate-700">
                  4. การจัดการเมื่อพบเวรซ้ำหรือเวลาทับซ้อน (ห้ามทับเวรเดิม)
                </label>
                <select
                  value={conflictStrategy}
                  onChange={(e) => setConflictStrategy(e.target.value as ConflictStrategyMode)}
                  className="w-full h-9.5 px-3 rounded-lg border border-slate-300 bg-slate-50 text-[13px] text-slate-800"
                >
                  <option value="SKIP_CONFLICTS">
                    ข้ามเฉพาะรายการที่ซ้ำ/เวลาทับซ้อน และบันทึกเฉพาะรายการที่ว่าง (แนะนำ)
                  </option>
                  <option value="ABORT_ON_CONFLICT">
                    ยกเลิกการบันทึกทั้งหมดทันทีหากพบความขัดแย้งแม้แต่รายการเดียว
                  </option>
                </select>
              </div>
            </div>
          </div>

          {/* แจ้งเตือนข้อผิดพลาดในการตรวจสอบ */}
          {previewError && (
            <div className="p-3.5 rounded-lg bg-red-50 border border-red-200 text-red-800 text-[13.5px] flex items-center gap-2.5">
              <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" />
              <span>{previewError}</span>
            </div>
          )}

          {/* ส่วนที่ 5: ตารางแสดงตัวอย่างและผลการตรวจสอบความขัดแย้ง (Preview Table) */}
          {previewData ? (
            <div className="border border-slate-200 rounded-xl overflow-hidden bg-white space-y-0">
              <div className="px-4 py-3 bg-violet-50 border-b border-violet-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div className="font-bold text-[14px] text-violet-950">
                  ผลการตรวจสอบก่อนบันทึก ({previewData.summary.totalRequested} รายการ)
                </div>
                <div className="flex flex-wrap items-center gap-3 text-[13px] font-semibold">
                  <span className="text-emerald-800">
                    พร้อมบันทึก: {previewData.summary.readyCount} รายการ
                  </span>
                  <span aria-hidden="true" className="text-slate-300">
                    ·
                  </span>
                  <span
                    className={
                      previewData.summary.conflictCount > 0 ? 'text-amber-800' : 'text-slate-600'
                    }
                  >
                    พบความขัดแย้ง/ซ้ำ: {previewData.summary.conflictCount} รายการ
                  </span>
                </div>
              </div>

              <div className="max-h-60 overflow-y-auto">
                <table className="w-full text-left border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-slate-200 bg-slate-50 text-slate-700">
                      <th className="py-2.5 px-3.5 font-semibold">วันที่ปฏิบัติงาน</th>
                      <th className="py-2.5 px-3.5 font-semibold">บุคลากร</th>
                      <th className="py-2.5 px-3.5 font-semibold">กะที่จะมอบหมาย</th>
                      <th className="py-2.5 px-3.5 font-semibold">ผลการตรวจสอบความขัดแย้ง</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {previewData.items.map((item, idx) => (
                      <tr
                        key={`${item.personId}-${item.workDate}-${idx}`}
                        className={item.status === 'READY' ? 'bg-white' : 'bg-amber-50/40'}
                      >
                        <td className="py-2.5 px-3.5 font-mono tabular-nums font-semibold text-slate-800 whitespace-nowrap">
                          {formatThaiDate(item.workDate)}
                        </td>
                        <td className="py-2.5 px-3.5">
                          <span className="font-semibold text-slate-800">{item.fullName}</span>{' '}
                          <span className="text-[12px] font-mono text-slate-500">
                            ({item.personId})
                          </span>
                        </td>
                        <td className="py-2.5 px-3.5 font-mono text-slate-700 whitespace-nowrap">
                          {previewData.shiftSnapshot.shiftCode} ({previewData.shiftSnapshot.startTime}–
                          {previewData.shiftSnapshot.endTime} น.)
                        </td>
                        <td className="py-2.5 px-3.5">
                          {item.status === 'READY' ? (
                            <span className="text-emerald-700 font-semibold">
                              พร้อมบันทึก (ไม่มีเวรซ้ำหรือเวลาทับซ้อน)
                            </span>
                          ) : (
                            <span className="text-amber-800 font-semibold">
                              {item.conflictMessage}{' '}
                              {conflictStrategy === 'SKIP_CONFLICTS'
                                ? '— ระบบจะข้ามรายการนี้โดยไม่ทับเวรเดิม'
                                : '— ต้องแก้ไขก่อนบันทึก'}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-center text-[13.5px] text-slate-600">
              เลือกบุคลากร ({selectedPersonIds.length} คน) และวันที่ ({effectiveSelectedDates.length}{' '}
              วัน) แล้วกดปุ่ม{' '}
              <strong className="text-violet-800">“1. ตรวจสอบความขัดแย้ง (Preview)”</strong>{' '}
              ด้านล่างเพื่อดูรายการก่อนบันทึกจริง
            </div>
          )}
        </div>
      </SharedModal>

      {/* =====================================================================
          DIALOG 2: หน้าต่างตรวจสอบรายละเอียด Snapshot ของเวรรายรายการ
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
          inspectTarget?.status === 'ACTIVE' ? (
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
          ) : undefined
        }
      >
        {inspectTarget && (
          <div className="space-y-4 text-[14px]">
            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-500">บุคลากร:</span>
                <span className="font-bold text-slate-800">
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
                <span className="text-slate-500">แม่แบบกะ (Snapshot):</span>
                <span className="font-semibold text-violet-900">
                  {inspectTarget.snapshot_shift_name} ({inspectTarget.snapshot_shift_code})
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">เวลาเริ่ม–เลิกงาน:</span>
                <span className="font-mono font-bold text-slate-800 tabular-nums">
                  {inspectTarget.snapshot_start_time} – {inspectTarget.snapshot_end_time} น.
                  {Number(inspectTarget.snapshot_is_cross_midnight) === 1
                    ? ' (ข้ามเที่ยงคืน +1 วัน)'
                    : ''}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">เวลาผ่อนผันสาย:</span>
                <span className="font-mono text-emerald-700 font-semibold">
                  {inspectTarget.snapshot_grace_minutes} นาที
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-500">เวลาตัดรอบขาดสแกน:</span>
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
          DIALOG 3: หน้าต่างยืนยันการยกเลิกตารางเวรแบบบันทึกประวัติ (Soft Cancel)
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
              <div className="font-bold text-[15px] text-slate-800">
                {cancelTarget.full_name} ({cancelTarget.person_id})
              </div>
              <div className="text-slate-600">
                วันที่เวร: {formatThaiDate(cancelTarget.work_date)} · กะ:{' '}
                {cancelTarget.snapshot_shift_name} ({cancelTarget.snapshot_start_time}–
                {cancelTarget.snapshot_end_time} น.)
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
    </div>
  );
}
