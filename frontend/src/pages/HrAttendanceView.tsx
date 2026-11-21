/**
 * ============================================================================
 * หน้าตรวจสอบเวลาปฏิบัติงานและประมวลผลเวลาใหม่สำหรับ HR (HR Attendance Review & Reprocess)
 * ไฟล์: frontend/src/pages/HrAttendanceView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงรายการผลการลงเวลารายกะของบุคลากรทั้งโรงพยาบาล พร้อมตัวกรองช่วงเวลา สถานะ กลุ่มงาน ประเภทบุคลากร และค้นหา
 * 2. รองรับการจำลองผลก่อนประมวลผลใหม่ (Preview Reprocess) และการสั่งประมวลผลเวลาใหม่ (Execute Reprocess)
 *    โดยไม่แก้ไขข้อมูลสแกนต้นฉบับ (raw_scans) และไม่ลบหมายเหตุเดิม
 * 3. เปิดแผงด้านข้าง (Slide-Over Drawer) เพื่อตรวจสอบหลักฐาน Raw Scan บันทึกลาครึ่งวัน หมายเหตุ และรับรองผล HR
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Play, Eye, CheckCircle2, FileText, Search, PanelRightOpen } from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import {
  AttendanceStatusText,
  ReviewStatusLabel,
  ErrorBanner,
} from '../components/StatusText.tsx';
import {
  PageHeader,
  PeriodFilterBar,
  SlideOverDrawer,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  TableEmptyState,
  TableLoadingSkeleton,
  RequiredMark,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  getCurrentBangkokDateParts,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

const REASON_LABELS: Record<string, string> = {
  OFFICIAL_DUTY: 'ไปราชการ / อบรมภายนอก',
  ANNUAL_LEAVE: 'ลาพักผ่อน / ลากิจ / ลาป่วย',
  HALF_DAY_LEAVE: 'ลาครึ่งวัน (เช้า / บ่าย)',
  EARLY_CHECKOUT_OFFICIAL: 'ออกก่อนเวลา (ไปราชการ / ภารกิจหน่วยงาน)',
  EARLY_CHECKOUT_EMERGENCY: 'ออกก่อนเวลา (เหตุฉุกเฉิน / ได้รับอนุญาต)',
  FORGOT_CHECKOUT_VERIFIED: 'ลืมสแกนออก (มีหลักฐานปฏิบัติงานจริง)',
  SCANNER_ISSUE: 'เครื่องสแกนขัดข้องชั่วคราว',
  LEAVE_OR_OFFICIAL: 'ลา / ไปราชการตามอนุมัติ',
};

export function HrAttendanceView({
  mode,
  userRole,
  onNavigate,
}: {
  mode: 'management' | 'review';
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState(initialBkk.todayYmd);
  const [monthValue, setMonthValue] = useState(initialBkk.currentYearMonth);
  const [yearValue, setYearValue] = useState(initialBkk.currentYear);
  const [customFrom, setCustomFrom] = useState(initialBkk.monthStartYmd);
  const [customTo, setCustomTo] = useState(initialBkk.monthEndYmd);

  const [statusFilter, setStatusFilter] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [personnelTypeFilter, setPersonnelTypeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]);
  const [reviewHistory, setReviewHistory] = useState<any[]>([]);

  // Sorting & Pagination
  const [sortKey, setSortKey] = useState('work_date');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  // Detail Drawer state
  const [selectedRow, setSelectedRow] = useState<any | null>(null);
  const [selectedRowScans, setSelectedRowScans] = useState<any[]>([]);
  const [selectedRowHistory, setSelectedRowHistory] = useState<any[]>([]);
  const [loadingDrawerScans, setLoadingDrawerScans] = useState(false);
  const [reasonType, setReasonType] = useState('OFFICIAL_DUTY');
  const [noteText, setNoteText] = useState('');
  const [reviewComment, setReviewComment] = useState('');

  // Half-day leave form inside drawer (ATT-15)
  const [leaveType, setLeaveType] = useState<'HALF_DAY_MORNING' | 'HALF_DAY_AFTERNOON'>('HALF_DAY_MORNING');
  const [leaveStartTime, setLeaveStartTime] = useState('08:00');
  const [leaveEndTime, setLeaveEndTime] = useState('12:00');
  const [leaveReason, setLeaveReason] = useState('');
  const [savingLeave, setSavingLeave] = useState(false);

  // Reprocess Preview / Execute state
  const [reprocessFrom, setReprocessFrom] = useState(initialBkk.yesterdayYmd);
  const [reprocessTo, setReprocessTo] = useState(initialBkk.todayYmd);
  const [previewResult, setPreviewResult] = useState<any>(null);

  const resolvedRange = useMemo(
    () =>
      resolvePeriodRange({
        mode: periodMode,
        dailyDate,
        monthValue,
        yearValue,
        customFrom,
        customTo,
      }),
    [periodMode, dailyDate, monthValue, yearValue, customFrom, customTo]
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        dateFrom: resolvedRange.dateFrom,
        dateTo: resolvedRange.dateTo,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(search ? { search } : {}),
      });
      if (mode === 'management') {
        const res = await apiRequest(`/attendance?${qs.toString()}`);
        setItems(res.items || []);
      } else {
        const res = await apiRequest(`/attendance-review?${qs.toString()}`);
        setItems(res.items || []);
        setNotes(res.notes || []);
        setReviewHistory(res.reviewHistory || []);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลผลการลงเวลาได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [resolvedRange.dateFrom, resolvedRange.dateTo, statusFilter, search, mode]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!selectedRow?.id) {
      setSelectedRowScans([]);
      setSelectedRowHistory([]);
      return;
    }
    let cancelled = false;
    setLoadingDrawerScans(true);
    apiRequest(`/attendance/${selectedRow.id}/scans`)
      .then((res) => {
        if (!cancelled) {
          setSelectedRowScans(res.scans || []);
          setSelectedRowHistory(res.matchingHistory || []);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSelectedRowScans([]);
          setSelectedRowHistory([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDrawerScans(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRow?.id]);

  // Dynamic client-side filter options derived strictly from real loaded items
  const availableDepartments = useMemo(() => {
    const set = new Set<string>();
    items.forEach((row) => {
      if (row.department_name) set.add(String(row.department_name));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }, [items]);

  const availablePersonnelTypes = useMemo(() => {
    const set = new Set<string>();
    items.forEach((row) => {
      const label = row.personnel_type_name || row.personnel_type_code;
      if (label) set.add(String(label));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }, [items]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('DESC');
    }
    setPage(1);
  }

  const filteredAndSortedItems = useMemo(() => {
    let list = [...items];
    if (departmentFilter) {
      list = list.filter((row) => String(row.department_name || '') === departmentFilter);
    }
    if (personnelTypeFilter) {
      list = list.filter(
        (row) => String(row.personnel_type_name || row.personnel_type_code || '') === personnelTypeFilter
      );
    }
    list.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      if (typeof valA === 'number' && typeof valB === 'number') {
        return sortDir === 'ASC' ? valA - valB : valB - valA;
      }
      return sortDir === 'ASC'
        ? String(valA || '').localeCompare(String(valB || ''), 'th')
        : String(valB || '').localeCompare(String(valA || ''), 'th');
    });
    return list;
  }, [items, departmentFilter, personnelTypeFilter, sortKey, sortDir]);

  const pagedItems = useMemo(() => {
    if (pageSize === 'ALL') return filteredAndSortedItems;
    const start = (page - 1) * pageSize;
    return filteredAndSortedItems.slice(start, start + pageSize);
  }, [filteredAndSortedItems, page, pageSize]);

  async function handleAddNote() {
    if (!selectedRow) return;
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/attendance/${selectedRow.id}/notes`, {
        method: 'POST',
        body: JSON.stringify({
          reasonType,
          noteText,
          visibleToEmployee: true,
        }),
      });
      setNoteText('');
      setNotice(`บันทึกหมายเหตุสำหรับเวรของ ${selectedRow.full_name} สำเร็จ (โดยไม่แก้ไขข้อมูลสแกนต้นฉบับ)`);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleConfirmReview() {
    if (!selectedRow) return;
    setError(null);
    setNotice(null);
    try {
      await apiRequest(`/attendance/${selectedRow.id}/review`, {
        method: 'POST',
        body: JSON.stringify({
          reviewStatus: 'VERIFIED_APPROVED',
          reviewReasonCategory: reasonType,
          reviewComment: reviewComment || 'ตรวจสอบหลักฐานถูกต้องตามระเบียบโรงพยาบาล',
        }),
      });
      setReviewComment('');
      setSelectedRow(null);
      setNotice(`รับรองผลการตรวจสอบสำหรับ ${selectedRow.full_name} เรียบร้อยแล้ว`);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleSaveHalfDayLeave() {
    if (!selectedRow) return;
    setSavingLeave(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/attendance/leaves', {
        method: 'POST',
        body: JSON.stringify({
          personId: selectedRow.person_id,
          workDate: String(selectedRow.work_date).slice(0, 10),
          shiftAssignmentId: selectedRow.shift_assignment_id ?? null,
          leaveType,
          leaveStartTime,
          leaveEndTime,
          reason: leaveReason || (leaveType === 'HALF_DAY_MORNING' ? 'ลาครึ่งวันเช้า' : 'ลาครึ่งวันบ่าย'),
          autoReprocess: true,
        }),
      });
      setLeaveReason('');
      setNotice(
        `บันทึกการลาครึ่งวัน (${leaveStartTime}–${leaveEndTime} น.) สำหรับ ${selectedRow.full_name} และคำนวณเวลาใหม่เรียบร้อยแล้ว (ไม่แก้ไขแม่แบบกะ)`
      );
      setSelectedRow(null);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    } finally {
      setSavingLeave(false);
    }
  }

  async function handlePreviewReprocess() {
    setError(null);
    setNotice(null);
    try {
      const bkk = getCurrentBangkokDateParts();
      const res = await apiRequest('/attendance/reprocess/preview', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: reprocessFrom,
          dateTo: reprocessTo,
          referenceNowBkk: bkk.nowDateTimeBkk,
        }),
      });
      setPreviewResult(res);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleExecuteReprocess() {
    setError(null);
    setNotice(null);
    try {
      const bkk = getCurrentBangkokDateParts();
      const res = await apiRequest('/attendance/reprocess', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: reprocessFrom,
          dateTo: reprocessTo,
          referenceNowBkk: bkk.nowDateTimeBkk,
        }),
      });
      setPreviewResult(null);
      setNotice(
        `คำนวณเวลาปฏิบัติงานซ้ำสำเร็จ: ประมวลผล ${res.totalProcessed} เวร (อัปเดต ${res.updatedCount}, เพิ่มใหม่ ${res.insertedCount}) โดยคงข้อมูลสแกนต้นฉบับและหมายเหตุเดิมครบถ้วน`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title={
          mode === 'management'
            ? 'รายการลงเวลาปฏิบัติงานทั้งหมด'
            : 'ตรวจสอบเวลาปฏิบัติงาน บันทึกเหตุผล และคำนวณเวลาซ้ำ'
        }
        subtitle="ตรวจสอบเวลาสแกนเข้า–ออกงานเทียบกับตารางเวร บันทึกหมายเหตุการลาหรือไปราชการ และรับรองผลตรวจสอบโดยไม่แก้ไขข้อมูลสแกนต้นฉบับ"
        actions={
          <PageHelpAction
            guideKey={mode === 'management' ? 'hrAttendance' : 'attendanceReview'}
            userRole={userRole}
            onNavigate={onNavigate}
          />
        }
      />

      <PeriodFilterBar
        mode={periodMode}
        onModeChange={setPeriodMode}
        dailyDate={dailyDate}
        onDailyDateChange={setDailyDate}
        monthValue={monthValue}
        onMonthValueChange={setMonthValue}
        yearValue={yearValue}
        onYearValueChange={setYearValue}
        customFrom={customFrom}
        onCustomFromChange={setCustomFrom}
        customTo={customTo}
        onCustomToChange={setCustomTo}
        extraFilters={
          <>
            <select
              aria-label="กรองตามสถานะการลงเวลา"
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="ent-input w-full sm:w-auto"
            >
              <option value="">ทุกสถานะการลงเวลา</option>
              <option value="NORMAL">ลงเวลาปกติ</option>
              <option value="LATE">มาสาย</option>
              <option value="EARLY_CHECKOUT">ออกก่อนเวลา</option>
              <option value="NO_SCAN">ไม่พบข้อมูลสแกน</option>
              <option value="MISSING_CHECKIN">ไม่สแกนเข้างาน</option>
              <option value="MISSING_CHECKOUT">ไม่สแกนออกงาน</option>
              <option value="NEEDS_RE_REVIEW">ต้องตรวจสอบซ้ำ (หลัง Reprocess)</option>
              <option value="PENDING_MAPPING">รอเชื่อมโยงรหัสสแกน</option>
            </select>

            {availableDepartments.length > 0 && (
              <select
                aria-label="กรองตามกลุ่มงาน"
                value={departmentFilter}
                onChange={(e) => {
                  setDepartmentFilter(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกกลุ่มงาน</option>
                {availableDepartments.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            )}

            {availablePersonnelTypes.length > 0 && (
              <select
                aria-label="กรองตามประเภทบุคลากร"
                value={personnelTypeFilter}
                onChange={(e) => {
                  setPersonnelTypeFilter(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกประเภทบุคลากร</option>
                {availablePersonnelTypes.map((pt) => (
                  <option key={pt} value={pt}>
                    {pt}
                  </option>
                ))}
              </select>
            )}

            <div className="relative w-full sm:w-60">
              <Search className="w-4 h-4 text-[#746B83] absolute left-3.5 top-3" aria-hidden="true" />
              <input
                type="text"
                aria-label="ค้นหาชื่อบุคลากรหรือรหัส"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="ค้นหาชื่อ หรือ รหัสบุคลากร..."
                className="ent-input pl-10 pr-4 w-full"
              />
            </div>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {mode === 'review' && (
        <div className="ent-card p-5 sm:p-6 space-y-4">
          <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
                คำนวณผลเวลาปฏิบัติงานซ้ำ (Reprocess)
              </h2>
              <p className="text-[13.5px] text-[#746B83]">
                ใช้เมื่อมีการปรับตารางเวรหรืออัปเดตการเชื่อมโยงรหัสสแกน โดยคงข้อมูลสแกนต้นฉบับและหมายเหตุเดิมครบถ้วน
              </p>
            </div>

            <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 w-full xl:w-auto">
              <div className="grid grid-cols-1 sm:flex items-center gap-2">
                <input
                  type="date"
                  aria-label="คำนวณซ้ำตั้งแต่วันที่"
                  value={reprocessFrom}
                  onChange={(e) => setReprocessFrom(e.target.value)}
                  className="ent-input font-mono tabular-nums w-full sm:w-auto"
                />
                <span className="text-[13px] text-[#746B83] text-center">ถึง</span>
                <input
                  type="date"
                  aria-label="คำนวณซ้ำถึงวันที่"
                  value={reprocessTo}
                  onChange={(e) => setReprocessTo(e.target.value)}
                  className="ent-input font-mono tabular-nums w-full sm:w-auto"
                />
              </div>
              <button
                type="button"
                onClick={handlePreviewReprocess}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                <Eye className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                <span>1. ดูตัวอย่างผลกระทบ</span>
              </button>
              <button
                type="button"
                onClick={handleExecuteReprocess}
                className="ent-btn-primary w-full sm:w-auto"
              >
                <Play className="w-4 h-4" aria-hidden="true" />
                <span>2. ยืนยันคำนวณเวลาซ้ำ</span>
              </button>
            </div>
          </div>

          {previewResult && (
            <div className="border border-[#E6DFF0] bg-[#F2EDFA] rounded-xl p-4 text-[13.5px] space-y-1">
              <div className="font-bold text-[#543B7A]">
                ผลการจำลองการคำนวณซ้ำ ({formatThaiDate(previewResult.dateFrom)} ถึง{' '}
                {formatThaiDate(previewResult.dateTo)}):
              </div>
              <div className="text-[#262238] tabular-nums">
                ประเมินทั้งหมด <strong>{previewResult.totalEvaluated}</strong> เวร · รายการใหม่{' '}
                <strong>{previewResult.newRecordsCount}</strong> · เปลี่ยนแปลงสถานะ{' '}
                <strong>{previewResult.changedCount}</strong> · คงเดิม{' '}
                <strong>{previewResult.unchangedCount}</strong> เวร
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Attendance Table (Mobile Card List + Desktop Table) */}
      <div className="ent-table-wrapper">
        {loading ? (
          <TableLoadingSkeleton rows={6} cols={6} />
        ) : (
          <>
            {/* Mobile Card View (< md) */}
            <div className="md:hidden divide-y divide-[#E6DFF0]">
              {pagedItems.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#746B83]">
                  ไม่พบรายการลงเวลาตามตัวกรองที่เลือก
                </div>
              ) : (
                pagedItems.map((row) => {
                  const rowNotes = notes.filter((n) => n.attendance_id === row.id);
                  return (
                    <div key={row.id} className="p-4 space-y-3 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-bold text-[15px] text-[#262238]">{row.full_name}</div>
                          <div className="text-[12.5px] text-[#746B83] mt-0.5">
                            <span className="font-mono">{row.person_id}</span> · สแกน{' '}
                            <span className="font-mono">{row.fingle_id || '—'}</span>
                          </div>
                          <div className="text-[12.5px] text-[#746B83] truncate">
                            {row.department_name}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-semibold text-[13.5px] text-[#262238]">
                            {formatThaiDate(row.work_date)}
                          </div>
                          <div className="text-[12px] font-mono text-[#746B83] tabular-nums">
                            {row.shift_name} ({row.scheduled_start?.slice(11, 16)}–
                            {row.scheduled_end?.slice(11, 16)})
                          </div>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 p-3 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] text-[13px]">
                        <div>
                          <div className="text-[#746B83] text-[12px]">เวลาสแกนเข้า</div>
                          {row.check_in_time ? (
                            <div className="font-mono font-bold text-[#262238] mt-0.5 tabular-nums">
                              {row.check_in_time.slice(11, 16)} น.
                            </div>
                          ) : (
                            <div className="font-semibold text-[#C74455] mt-0.5">ไม่พบสแกนเข้า</div>
                          )}
                        </div>
                        <div>
                          <div className="text-[#746B83] text-[12px]">เวลาสแกนออก</div>
                          {row.check_out_time ? (
                            <div className="font-mono font-bold text-[#262238] mt-0.5 tabular-nums">
                              {row.check_out_time.slice(11, 16)} น.
                            </div>
                          ) : (
                            <div className="font-semibold text-[#B87516] mt-0.5">ไม่พบสแกนออก</div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <AttendanceStatusText
                            status={row.status}
                            secondaryFlags={row.secondary_flags}
                            earlyCheckoutMinutes={row.early_checkout_minutes}
                          />
                          {row.late_minutes > 0 && (
                            <span className="font-mono text-[12.5px] font-bold text-[#B87516] tabular-nums">
                              · สาย {row.late_minutes} น.
                            </span>
                          )}
                          {Number(row.early_checkout_minutes || 0) > 0 && (
                            <span className="font-mono text-[12.5px] font-bold text-[#C74455] tabular-nums">
                              · ออกก่อน {row.early_checkout_minutes} น.
                            </span>
                          )}
                        </div>
                        <ReviewStatusLabel status={row.review_status} />
                      </div>

                      {rowNotes.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-[#F2EDFA] border border-[#E6DFF0] text-[12.5px] text-[#543B7A] space-y-1">
                          {rowNotes.map((n) => (
                            <div key={n.id}>
                              <strong>{REASON_LABELS[n.reason_type] || n.reason_type}:</strong>{' '}
                              {n.note_text}
                            </div>
                          ))}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => setSelectedRow(row)}
                        className="ent-btn-secondary w-full"
                      >
                        <PanelRightOpen className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                        <span>{mode === 'review' ? 'ตรวจสอบหลักฐาน / บันทึกหมายเหตุ' : 'ดูรายละเอียดหลักฐาน'}</span>
                      </button>
                    </div>
                  );
                })
              )}
            </div>

            {/* Desktop Table View (>= md) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                    <SortableHeader
                      label="วันที่ปฏิบัติงาน"
                      sortKey="work_date"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="บุคลากร · หน่วยงาน"
                      sortKey="full_name"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="กะปฏิบัติงาน"
                      sortKey="shift_name"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <th className="py-3.5 px-4 text-[13px] font-semibold">สแกนเข้า</th>
                    <th className="py-3.5 px-4 text-[13px] font-semibold">สแกนออก</th>
                    <SortableHeader
                      label="นาทีสาย"
                      sortKey="late_minutes"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="ออกก่อนเวลา"
                      sortKey="early_checkout_minutes"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                      align="right"
                    />
                    <SortableHeader
                      label="สถานะ"
                      sortKey="status"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="ผลตรวจ HR"
                      sortKey="review_status"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <th className="py-3.5 px-4 text-[13px] font-semibold text-right">รายละเอียด</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6DFF0]">
                  {pagedItems.length === 0 ? (
                    <TableEmptyState colSpan={10} title="ไม่พบรายการลงเวลาตามตัวกรองที่เลือก" />
                  ) : (
                    pagedItems.map((row) => {
                      const rowNotes = notes.filter((n) => n.attendance_id === row.id);
                      const earlyMins = Number(row.early_checkout_minutes || 0);
                      return (
                        <tr key={row.id} className="hover:bg-[#F8F7FC] transition-colors">
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-[#262238]">
                              {formatThaiDate(row.work_date)}
                            </div>
                            <div className="text-[12px] font-mono text-[#746B83] tabular-nums mt-0.5">
                              เวร #{row.id}
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-[14.5px] text-[#262238]">{row.full_name}</div>
                            <div className="text-[12px] text-[#746B83] mt-0.5">
                              <span className="font-mono">{row.person_id}</span> · สแกน{' '}
                              <span className="font-mono">{row.fingle_id || '—'}</span> · {row.department_name}
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-[#262238]">{row.shift_name}</div>
                            <div className="text-[12px] font-mono text-[#746B83] tabular-nums mt-0.5">
                              {row.scheduled_start?.slice(11, 16)}–{row.scheduled_end?.slice(11, 16)} น.
                            </div>
                          </td>
                          <td className="py-3.5 px-4 font-mono tabular-nums">
                            {row.check_in_time ? (
                              <div>
                                <div className="font-semibold text-[#262238]">
                                  {row.check_in_time.slice(11, 16)} น.
                                </div>
                                <div className="text-[11.5px] text-[#746B83]">
                                  #{row.check_in_raw_scan_id}
                                </div>
                              </div>
                            ) : (
                              <span className="text-[#C74455] font-sans text-[13px] font-medium">
                                ไม่พบสแกนเข้า
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 font-mono tabular-nums">
                            {row.check_out_time ? (
                              <div>
                                <div className="font-semibold text-[#262238]">
                                  {row.check_out_time.slice(11, 16)} น.
                                </div>
                                <div className="text-[11.5px] text-[#746B83]">
                                  #{row.check_out_raw_scan_id}
                                </div>
                              </div>
                            ) : (
                              <span className="text-[#B87516] font-sans text-[13px] font-medium">
                                ไม่พบสแกนออก
                              </span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                            {row.late_minutes > 0 ? (
                              <span className="font-bold text-[#B87516]">{row.late_minutes} น.</span>
                            ) : (
                              <span className="text-[#746B83]">0</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4 text-right font-mono tabular-nums">
                            {earlyMins > 0 ? (
                              <span className="font-bold text-[#C74455]">{earlyMins} น.</span>
                            ) : (
                              <span className="text-[#746B83]">0</span>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <AttendanceStatusText
                              status={row.status}
                              secondaryFlags={row.secondary_flags}
                              earlyCheckoutMinutes={row.early_checkout_minutes}
                            />
                            {row.leave_type && (
                              <div className="text-[12px] text-[#543B7A] mt-0.5">
                                ลาบางส่วน ({row.leave_start_time}–{row.leave_end_time} น.)
                              </div>
                            )}
                          </td>
                          <td className="py-3.5 px-4">
                            <ReviewStatusLabel status={row.review_status} />
                            {row.review_reason && (
                              <div className="text-[12px] text-[#746B83] mt-0.5">{row.review_reason}</div>
                            )}
                            {rowNotes.map((n) => (
                              <div key={n.id} className="text-[12px] text-[#543B7A] mt-1">
                                {REASON_LABELS[n.reason_type] || n.reason_type}: {n.note_text}
                                {Number(n.needs_re_review) === 1 && (
                                  <span className="ml-1 text-[#C74455] font-semibold">(ต้องตรวจซ้ำ)</span>
                                )}
                              </div>
                            ))}
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => setSelectedRow(row)}
                              className="h-9 px-3 text-[13px] font-semibold bg-white border border-[#E6DFF0] rounded-lg hover:bg-[#F2EDFA] hover:border-[#8E70C9]/50 hover:text-[#543B7A] inline-flex items-center gap-1.5 whitespace-nowrap text-[#262238] transition-colors cursor-pointer"
                            >
                              <PanelRightOpen className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                              <span>{mode === 'review' ? 'ตรวจสอบ / หมายเหตุ' : 'ดูรายละเอียด'}</span>
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <TablePaginationBar
          totalItems={filteredAndSortedItems.length}
          currentPage={page}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* Slide-Over Detail Drawer for Inspecting Raw Scan Evidence & Recording HR Review */}
      <SlideOverDrawer
        open={Boolean(selectedRow)}
        onClose={() => setSelectedRow(null)}
        kickerText="แผงตรวจสอบหลักฐานการสแกนและบันทึกหมายเหตุ HR"
        title={selectedRow ? `${selectedRow.full_name}` : ''}
        subtitle={
          selectedRow
            ? `วันที่ปฏิบัติงาน: ${formatThaiDate(selectedRow.work_date)} · ${selectedRow.shift_name}`
            : ''
        }
      >
        {selectedRow && (
          <div className="space-y-6">
            {/* Employee & Shift Summary Card */}
            <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E6DFF0] pb-3">
                <div>
                  <div className="text-[12.5px] text-[#746B83]">รหัสบุคลากร · รหัสลายนิ้วมือ · กลุ่มงาน</div>
                  <div className="font-mono font-bold text-[#262238] text-[14px] mt-0.5">
                    {selectedRow.person_id} · สแกน {selectedRow.fingle_id || '—'} ·{' '}
                    <span className="font-sans font-medium text-[#746B83]">{selectedRow.department_name}</span>
                  </div>
                </div>
                <AttendanceStatusText
                  status={selectedRow.status}
                  secondaryFlags={selectedRow.secondary_flags}
                  earlyCheckoutMinutes={selectedRow.early_checkout_minutes}
                />
              </div>

              {(selectedRow.leave_type || Number(selectedRow.early_checkout_minutes || 0) > 0) && (
                <div className="flex flex-wrap gap-2 text-[12.5px]">
                  {selectedRow.leave_type && (
                    <span className="px-2.5 py-1 rounded-md bg-[#F2EDFA] border border-[#E6DFF0] text-[#543B7A] font-semibold">
                      ลาบางส่วน {selectedRow.leave_start_time}–{selectedRow.leave_end_time} น. (ประเมินช่วง{' '}
                      {selectedRow.evaluated_start_time?.slice(11, 16)}–{selectedRow.evaluated_end_time?.slice(11, 16)} น.)
                    </span>
                  )}
                  {Number(selectedRow.early_checkout_minutes || 0) > 0 && (
                    <span className="px-2.5 py-1 rounded-md bg-[#FDF2F3] border border-[#F3CCD0] text-[#C74455] font-semibold">
                      ออกก่อนเวลา {selectedRow.early_checkout_minutes} นาที
                    </span>
                  )}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13.5px]">
                <div className="p-3 rounded-lg bg-white border border-[#E6DFF0]">
                  <div className="text-[12.5px] text-[#746B83]">หลักฐานเวลาสแกนเข้า</div>
                  <div className="font-mono font-semibold text-[#262238] mt-1 tabular-nums">
                    {selectedRow.check_in_time
                      ? formatThaiDateTime(selectedRow.check_in_time)
                      : 'ไม่พบข้อมูลสแกนเข้า'}
                  </div>
                  <div className="font-mono text-[12px] text-[#746B83] mt-0.5">
                    Raw Scan: #{selectedRow.check_in_raw_scan_id || '—'}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-white border border-[#E6DFF0]">
                  <div className="text-[12.5px] text-[#746B83]">หลักฐานเวลาสแกนออก</div>
                  <div className="font-mono font-semibold text-[#262238] mt-1 tabular-nums">
                    {selectedRow.check_out_time
                      ? formatThaiDateTime(selectedRow.check_out_time)
                      : 'ไม่พบข้อมูลสแกนออก'}
                  </div>
                  <div className="font-mono text-[12px] text-[#746B83] mt-0.5">
                    Raw Scan: #{selectedRow.check_out_raw_scan_id || '—'}
                  </div>
                </div>
              </div>
            </div>

            {/* Raw Scan Usage Trace (ATT-09: Used vs Extra Unused Scans) */}
            <div className="space-y-2.5">
              <div className="border-b border-[#E6DFF0] pb-1.5">
                <h4 className="text-[15px] font-bold text-[#262238]">
                  รายการสแกนทั้งหมดของบุคลากรในช่วงเวรนี้ ({selectedRowScans.length} รายการ)
                </h4>
                <p className="text-[12.5px] text-[#746B83]">
                  แสดงสแกนที่ถูกนำไปจับคู่เป็นเข้า/ออกงาน กะอื่น และสแกนเพิ่มเติมที่ไม่ได้ถูกใช้ซ้ำ
                </p>
              </div>
              {loadingDrawerScans ? (
                <div className="text-[13px] text-[#746B83] py-2">กำลังโหลดรายการสแกน...</div>
              ) : selectedRowScans.length === 0 ? (
                <div className="text-[13px] text-[#746B83] py-2">ไม่พบข้อมูลสแกนดิบในช่วงเวลาใกล้เคียง</div>
              ) : (
                <div className="divide-y divide-[#E6DFF0] border border-[#E6DFF0] rounded-xl bg-white text-[13px]">
                  {selectedRowScans.map((sc) => (
                    <div key={sc.id} className="px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="font-mono font-bold text-[#262238] tabular-nums">{sc.canonical_bkk_time}</span>
                        <span className="text-[12px] font-mono text-[#746B83] ml-2">
                          (สแกน #{sc.id} · เครื่อง #{sc.machine_no})
                        </span>
                      </div>
                      <span
                        className={`text-[12.5px] font-semibold ${
                          sc.relationToShift === 'USED_AS_IN_THIS_SHIFT'
                            ? 'text-[#198568]'
                            : sc.relationToShift === 'USED_AS_OUT_THIS_SHIFT'
                            ? 'text-[#5879BC]'
                            : sc.relationToShift === 'USED_BY_OTHER_SHIFT'
                            ? 'text-[#543B7A]'
                            : 'text-[#746B83]'
                        }`}
                      >
                        {sc.relationToShift === 'USED_AS_IN_THIS_SHIFT'
                          ? 'ใช้เป็นสแกนเข้ากะนี้'
                          : sc.relationToShift === 'USED_AS_OUT_THIS_SHIFT'
                          ? 'ใช้เป็นสแกนออกกะนี้'
                          : sc.relationToShift === 'USED_BY_OTHER_SHIFT'
                          ? `ใช้โดยกะอื่น (${sc.usage_shift_code || `#${sc.usage_attendance_id}`})`
                          : 'สแกนเพิ่มเติม (ไม่ถูกใช้)'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {selectedRowHistory.length > 0 && (
                <div className="p-3 rounded-xl bg-[#FEF8ED] border border-[#F3DFBC] text-[12.5px] text-[#262238] space-y-1">
                  <div className="font-bold text-[#B87516]">ประวัติการเปลี่ยนแปลงผลจับคู่ (Reprocess):</div>
                  {selectedRowHistory.slice(0, 3).map((mh) => (
                    <div key={mh.id} className="font-mono">
                      {mh.previous_status} → {mh.new_status} ({mh.change_reason}) โดย {mh.triggered_by}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Compact Half-Day Leave Recording (ATT-15 — never modifies shift template) */}
            <div className="space-y-3 p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0]">
              <div>
                <h4 className="text-[14.5px] font-bold text-[#262238]">
                  บันทึกการลาครึ่งวันสำหรับเวรนี้ (ไม่แก้ไขแม่แบบกะ)
                </h4>
                <p className="text-[12.5px] text-[#746B83]">
                  ระบบจะปรับช่วงเวลาที่ใช้ประเมินมาสาย/ออกก่อนเวลาเฉพาะรายการนี้และคำนวณเวลาใหม่ทันที
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                <select
                  aria-label="ประเภทการลาครึ่งวัน"
                  value={leaveType}
                  onChange={(e) => {
                    const val = e.target.value as 'HALF_DAY_MORNING' | 'HALF_DAY_AFTERNOON';
                    setLeaveType(val);
                    if (val === 'HALF_DAY_MORNING') {
                      setLeaveStartTime('08:00');
                      setLeaveEndTime('12:00');
                    } else {
                      setLeaveStartTime('12:00');
                      setLeaveEndTime('16:00');
                    }
                  }}
                  className="ent-input w-full"
                >
                  <option value="HALF_DAY_MORNING">ลาครึ่งวันเช้า</option>
                  <option value="HALF_DAY_AFTERNOON">ลาครึ่งวันบ่าย</option>
                </select>
                <input
                  type="time"
                  aria-label="เวลาเริ่มลา"
                  value={leaveStartTime}
                  onChange={(e) => setLeaveStartTime(e.target.value)}
                  className="ent-input font-mono w-full"
                />
                <input
                  type="time"
                  aria-label="เวลาสิ้นสุดการลา"
                  value={leaveEndTime}
                  onChange={(e) => setLeaveEndTime(e.target.value)}
                  className="ent-input font-mono w-full"
                />
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={leaveReason}
                  onChange={(e) => setLeaveReason(e.target.value)}
                  placeholder="เหตุผลการลาครึ่งวัน (เช่น ลากิจช่วงเช้า / ลาป่วยช่วงบ่าย)"
                  className="ent-input flex-1"
                />
                <button
                  type="button"
                  disabled={savingLeave}
                  onClick={handleSaveHalfDayLeave}
                  className="ent-btn-secondary shrink-0 disabled:opacity-60"
                >
                  <span>{savingLeave ? 'กำลังบันทึก...' : 'บันทึกลาครึ่งวัน & คำนวณใหม่'}</span>
                </button>
              </div>
            </div>

            {/* HR Note & Verification Form */}
            <div className="space-y-4">
              <div className="border-b border-[#E6DFF0] pb-2">
                <h4 className="text-[15.5px] font-bold text-[#262238]">
                  บันทึกเหตุผลและรับรองผลการตรวจสอบ
                </h4>
                <p className="text-[13px] text-[#746B83]">
                  การบันทึกหมายเหตุจะจัดเก็บแยกในตารางประวัติโดยไม่แก้ไขเวลาสแกนต้นฉบับจากเครื่องสแกน
                </p>
              </div>

              <div>
                <label className="ent-label">
                  ประเภทเหตุผลประกอบการตรวจสอบ <RequiredMark />
                </label>
                <select
                  value={reasonType}
                  onChange={(e) => setReasonType(e.target.value)}
                  className="ent-input w-full"
                >
                  <option value="OFFICIAL_DUTY">ไปราชการ / อบรมภายนอก</option>
                  <option value="ANNUAL_LEAVE">ลาพักผ่อน / ลากิจ / ลาป่วย</option>
                  <option value="HALF_DAY_LEAVE">ลาครึ่งวัน (เช้า / บ่าย)</option>
                  <option value="EARLY_CHECKOUT_OFFICIAL">ออกก่อนเวลา (ไปราชการ / ภารกิจหน่วยงาน)</option>
                  <option value="EARLY_CHECKOUT_EMERGENCY">ออกก่อนเวลา (เหตุฉุกเฉิน / ได้รับอนุญาต)</option>
                  <option value="FORGOT_CHECKOUT_VERIFIED">
                    ลืมสแกนออกงาน (มีหลักฐานปฏิบัติงานจริง)
                  </option>
                  <option value="SCANNER_ISSUE">เครื่องสแกนขัดข้องชั่วคราว</option>
                </select>
              </div>

              <div>
                <label className="ent-label">
                  รายละเอียดหมายเหตุ (แสดงให้บุคลากรทราบในหน้าส่วนตัว) <RequiredMark />
                </label>
                <input
                  type="text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="ระบุเลขที่หนังสือส่งตัว หรือรายละเอียดการลา..."
                  className="ent-input w-full"
                />
              </div>

              <div>
                <label className="ent-label">ความเห็นการรับรองผลของเจ้าหน้าที่ HR</label>
                <input
                  type="text"
                  value={reviewComment}
                  onChange={(e) => setReviewComment(e.target.value)}
                  placeholder="เช่น ตรวจสอบใบลาและหนังสืออนุมัติถูกต้องครบถ้วน..."
                  className="ent-input w-full"
                />
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleAddNote}
                  className="ent-btn-secondary w-full sm:w-auto"
                >
                  <FileText className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                  <span>บันทึกหมายเหตุ</span>
                </button>
                <button
                  type="button"
                  onClick={handleConfirmReview}
                  className="ent-btn-primary w-full sm:w-auto"
                >
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                  <span>ยืนยันรับรองผลตรวจสอบ HR</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {mode === 'review' && reviewHistory.length > 0 && (
        <div className="ent-table-wrapper">
          <div className="px-5 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC]">
            <h2 className="text-[17px] font-bold text-[#262238]">
              ประวัติการรับรองผลตรวจสอบล่าสุดโดยเจ้าหน้าที่ HR
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                  <th className="py-3.5 px-5 font-semibold text-[13px]">วันและเวลาที่ตรวจสอบ</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสเวร · บุคลากร</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">ผลการพิจารณา</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">ความเห็นเจ้าหน้าที่</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">ผู้ตรวจสอบ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6DFF0]">
                {reviewHistory.map((h) => (
                  <tr key={h.id} className="hover:bg-[#F8F7FC]">
                    <td className="py-3.5 px-5 font-mono tabular-nums text-[#262238]">
                      {formatThaiDateTime(h.reviewed_at)}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-[#262238]">
                      เวร #{h.attendance_id} · {h.person_id} ({formatThaiDate(h.work_date)})
                    </td>
                    <td className="py-3.5 px-5">
                      <ReviewStatusLabel status={h.new_review_status} />
                    </td>
                    <td className="py-3.5 px-5 text-[#262238]">{h.review_comment}</td>
                    <td className="py-3.5 px-5 font-mono text-[#746B83]">{h.reviewed_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
