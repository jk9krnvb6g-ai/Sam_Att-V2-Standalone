/**
 * ============================================================================
 * หน้าเวลาปฏิบัติงานของฉัน (Personal Attendance, Shifts & Scans View)
 * ไฟล์: frontend/src/pages/MyAttendanceView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * - เรียกใช้งาน API กลุ่ม /api/Sam_Att/me/* ซึ่งบังคับตรวจสิทธิ์ Own-Only ที่ฝั่ง Backend
 * - แสดงข้อมูลเฉพาะของบุคลากรเจ้าของบัญชีที่ล็อกอินอยู่เท่านั้น แบ่งเป็น 3 แท็บ:
 *   1. ผลการลงเวลารายวัน (พร้อมคอลัมน์ออกก่อนเวลา ปุ่มเปิดดูหลักฐานเวลาสแกน และหมายเหตุ HR)
 *   2. ตารางเวรที่ได้รับมอบหมาย (สลับมุมมองรายการ / ปฏิทินรายเดือนได้จากข้อมูลจริง)
 *   3. ประวัติการสแกนลายนิ้วมือต้นฉบับของตนเอง
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { PanelRightOpen, CalendarDays, List, ChevronLeft, ChevronRight } from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../services/api.ts';
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
  TableEmptyState,
  TableLoadingSkeleton,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import { type NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  getCurrentBangkokDateParts,
  THAI_MONTHS,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

const THAI_WEEKDAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

export function MyAttendanceView({
  user,
  onNavigate,
}: {
  user: AuthUser;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState(initialBkk.todayYmd);
  const [monthValue, setMonthValue] = useState(initialBkk.currentYearMonth);
  const [yearValue, setYearValue] = useState(initialBkk.currentYear);
  const [customFrom, setCustomFrom] = useState(initialBkk.monthStartYmd);
  const [customTo, setCustomTo] = useState(initialBkk.monthEndYmd);

  const [activeTab, setActiveTab] = useState<'attendance' | 'shifts' | 'rawScans'>('attendance');
  const [shiftDisplayMode, setShiftDisplayMode] = useState<'list' | 'calendar'>('list');
  const [calendarMonth, setCalendarMonth] = useState(initialBkk.currentYearMonth);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [attendanceData, setAttendanceData] = useState<any>(null);
  const [shiftsData, setShiftsData] = useState<any[]>([]);
  const [rawScansData, setRawScansData] = useState<any[]>([]);

  // Pagination & Sorting state
  const [sortKey, setSortKey] = useState('work_date');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  // Slide-Over Detail Drawer for inspecting a single shift & its raw scan trace
  const [selectedRowModal, setSelectedRowModal] = useState<any | null>(null);

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

  const loadOwnData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        dateFrom: resolvedRange.dateFrom,
        dateTo: resolvedRange.dateTo,
      });
      const [att, sh, rs] = await Promise.all([
        apiRequest(`/me/attendance?${qs.toString()}`),
        apiRequest('/me/shifts'),
        apiRequest('/me/raw-scans'),
      ]);
      setAttendanceData(att);
      setShiftsData(sh.items || []);
      setRawScansData(rs.items || []);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลการลงเวลาของคุณได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [resolvedRange.dateFrom, resolvedRange.dateTo]);

  useEffect(() => {
    loadOwnData();
  }, [loadOwnData]);

  const summary = attendanceData?.summary;

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('DESC');
    }
    setPage(1);
  }

  const sortedAttendanceItems = useMemo(() => {
    const list = [...(attendanceData?.items || [])];
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
  }, [attendanceData?.items, sortKey, sortDir]);

  const pagedAttendance = useMemo(() => {
    if (pageSize === 'ALL') return sortedAttendanceItems;
    const start = (page - 1) * pageSize;
    return sortedAttendanceItems.slice(start, start + pageSize);
  }, [sortedAttendanceItems, page, pageSize]);

  // Client-side monthly calendar cells built purely from existing shiftsData
  const calendarModel = useMemo(() => {
    const [yrStr, moStr] = calendarMonth.split('-');
    const yr = Number(yrStr) || Number(initialBkk.currentYear);
    const mo = Number(moStr) || 1;
    const firstWeekday = new Date(Date.UTC(yr, mo - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(yr, mo, 0)).getUTCDate();

    const byDate = new Map<string, any[]>();
    for (const s of shiftsData) {
      const key = String(s.work_date || '').slice(0, 10);
      if (!byDate.has(key)) byDate.set(key, []);
      byDate.get(key)!.push(s);
    }

    const cells: Array<{ ymd: string | null; day: number | null; shifts: any[] }> = [];
    for (let i = 0; i < firstWeekday; i++) {
      cells.push({ ymd: null, day: null, shifts: [] });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ ymd, day: d, shifts: byDate.get(ymd) || [] });
    }
    const thaiLabel = `${THAI_MONTHS[mo - 1] || ''} ${yr + 543}`;
    return { yr, mo, thaiLabel, cells };
  }, [calendarMonth, shiftsData, initialBkk.currentYear]);

  function stepCalendarMonth(delta: number) {
    const dt = new Date(Date.UTC(calendarModel.yr, calendarModel.mo - 1 + delta, 1));
    const nextYm = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
    setCalendarMonth(nextYm);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        category="ข้อมูลส่วนบุคคล"
        title="เวลาปฏิบัติงานและตารางเวรของฉัน"
        subtitle={`แสดงข้อมูลการลงเวลาเฉพาะของ ${user.displayName} (รหัสบุคลากร: ${user.approvedPersonId || 'ยังไม่ได้ผูกชื่อบุคลากร'})`}
        actions={
          <PageHelpAction
            guideKey="myAttendance"
            activeTabKey={activeTab}
            userRole={user.role}
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
      />

      <ErrorBanner error={error} onRetry={loadOwnData} />

      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="ent-card p-5">
            <div className="text-[13px] font-medium text-[#746B83]">เวรปฏิบัติงานทั้งหมด</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#262238] tabular-nums">
              {summary.totalShifts} เวร
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13px] font-medium text-[#746B83]">ลงเวลาปกติ</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#198568] tabular-nums">
              {summary.normalCount} เวร
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13px] font-medium text-[#746B83]">จำนวนครั้งที่มาสาย</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#B87516] tabular-nums">
              {summary.lateOccurrences} ครั้ง
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13px] font-medium text-[#746B83]">นาทีสายสะสม</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#262238] tabular-nums">
              {summary.totalLateMinutes} นาที
            </div>
          </div>
          <div className="ent-card p-5 col-span-2 lg:col-span-1">
            <div className="text-[13px] font-medium text-[#746B83]">ขาดสแกน / ไม่สแกนออก</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#C74455] tabular-nums">
              {summary.noScanCount} / {summary.missingCheckoutCount}
            </div>
          </div>
        </div>
      )}

      {/* Segmented View Controls */}
      <div className="ent-tab-bar w-full sm:w-fit flex-col sm:flex-row">
        <button
          type="button"
          onClick={() => setActiveTab('attendance')}
          className={`ent-tab-btn ${activeTab === 'attendance' ? 'ent-tab-btn-active' : ''}`}
        >
          ผลการลงเวลารายวัน ({attendanceData?.items?.length || 0})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('shifts')}
          className={`ent-tab-btn ${activeTab === 'shifts' ? 'ent-tab-btn-active' : ''}`}
        >
          ตารางเวรของฉัน ({shiftsData.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('rawScans')}
          className={`ent-tab-btn ${activeTab === 'rawScans' ? 'ent-tab-btn-active' : ''}`}
        >
          ประวัติการสแกนลายนิ้วมือ ({rawScansData.length})
        </button>
      </div>

      {loading ? (
        <div className="ent-table-wrapper">
          <TableLoadingSkeleton rows={6} cols={6} />
        </div>
      ) : activeTab === 'attendance' ? (
        <div className="ent-table-wrapper">
          {/* Mobile Card View (< md) */}
          <div className="md:hidden divide-y divide-[#E6DFF0]">
            {pagedAttendance.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#746B83]">
                ยังไม่มีข้อมูลผลการลงเวลาในช่วงวันที่เลือก
              </div>
            ) : (
              pagedAttendance.map((row: any) => {
                const rowNotes = (attendanceData?.notes || []).filter(
                  (n: any) => n.attendance_id === row.id
                );
                return (
                  <div key={row.id} className="p-4 space-y-3 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-[15px] text-[#262238]">
                          {formatThaiDate(row.work_date)}
                        </div>
                        <div className="text-[12.5px] text-[#746B83] mt-0.5">
                          {row.shift_name || row.shift_code || '—'} ·{' '}
                          <span className="font-mono tabular-nums">
                            {row.scheduled_start?.slice(11, 16)}–{row.scheduled_end?.slice(11, 16)} น.
                          </span>
                        </div>
                      </div>
                      <AttendanceStatusText
                        status={row.status}
                        secondaryFlags={row.secondary_flags}
                        earlyCheckoutMinutes={row.early_checkout_minutes}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2.5 p-3 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] text-[13px]">
                      <div>
                        <div className="text-[#746B83] text-[12px]">เวลาสแกนเข้า</div>
                        <div className="font-mono font-bold text-[#262238] mt-0.5 tabular-nums">
                          {row.check_in_time ? `${row.check_in_time.slice(11, 16)} น.` : 'ไม่พบสแกนเข้า'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[#746B83] text-[12px]">เวลาสแกนออก</div>
                        <div className="font-mono font-bold text-[#262238] mt-0.5 tabular-nums">
                          {row.check_out_time ? `${row.check_out_time.slice(11, 16)} น.` : 'ไม่พบสแกนออก'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <ReviewStatusLabel status={row.review_status} />
                      <div className="flex items-center gap-3">
                        {row.late_minutes > 0 && (
                          <span className="font-mono font-bold text-[#B87516] tabular-nums">
                            สาย {row.late_minutes} น.
                          </span>
                        )}
                        {Number(row.early_checkout_minutes || 0) > 0 && (
                          <span className="font-mono font-bold text-[#C74455] tabular-nums">
                            ออกก่อน {row.early_checkout_minutes} น.
                          </span>
                        )}
                      </div>
                    </div>

                    {rowNotes.length > 0 && (
                      <div className="p-2.5 rounded-lg bg-[#F2EDFA] border border-[#E6DFF0] text-[12.5px] text-[#543B7A] space-y-1">
                        {rowNotes.map((n: any) => (
                          <div key={n.id}>หมายเหตุ HR: {n.note_text}</div>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => setSelectedRowModal({ row, rowNotes })}
                      className="ent-btn-secondary w-full"
                    >
                      <PanelRightOpen className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                      <span>ดูหลักฐานเวลาสแกน</span>
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
                    label="กะปฏิบัติงาน"
                    sortKey="shift_name"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="py-3.5 px-4 text-[13px] font-semibold">เวลาตามตารางเวร</th>
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
                  <th className="py-3.5 px-4 text-[13px] font-semibold">ผลตรวจ HR / หมายเหตุ</th>
                  <th className="py-3.5 px-4 text-[13px] font-semibold text-right">หลักฐาน</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6DFF0]">
                {pagedAttendance.length === 0 ? (
                  <TableEmptyState colSpan={10} title="ยังไม่มีข้อมูลผลการลงเวลาในช่วงวันที่เลือก" />
                ) : (
                  pagedAttendance.map((row: any) => {
                    const rowNotes = (attendanceData?.notes || []).filter(
                      (n: any) => n.attendance_id === row.id
                    );
                    const earlyMins = Number(row.early_checkout_minutes || 0);
                    return (
                      <tr key={row.id} className="hover:bg-[#F8F7FC] transition-colors">
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-[#262238]">
                            {formatThaiDate(row.work_date)}
                          </div>
                          <div className="text-[12px] font-mono text-[#746B83] tabular-nums mt-0.5">
                            {row.work_date}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 font-semibold text-[#262238]">
                          {row.shift_name || row.shift_code || '—'}
                        </td>
                        <td className="py-3.5 px-4 font-mono tabular-nums text-[#746B83]">
                          {row.scheduled_start?.slice(11, 16)}–{row.scheduled_end?.slice(11, 16)} น.
                        </td>
                        <td className="py-3.5 px-4 font-mono tabular-nums text-[#262238] font-medium">
                          {row.check_in_time ? `${row.check_in_time.slice(11, 16)} น.` : '—'}
                        </td>
                        <td className="py-3.5 px-4 font-mono tabular-nums text-[#262238] font-medium">
                          {row.check_out_time ? `${row.check_out_time.slice(11, 16)} น.` : '—'}
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
                          {rowNotes.map((n: any) => (
                            <div key={n.id} className="text-[12.5px] text-[#543B7A] mt-1">
                              {n.note_text}
                            </div>
                          ))}
                        </td>
                        <td className="py-3.5 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedRowModal({ row, rowNotes })}
                            className="h-9 px-3 text-[13px] bg-white border border-[#E6DFF0] rounded-lg hover:bg-[#F2EDFA] hover:border-[#8E70C9]/50 hover:text-[#543B7A] inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-[#262238] transition-colors cursor-pointer"
                          >
                            <PanelRightOpen className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                            <span>ดูหลักฐาน</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <TablePaginationBar
            totalItems={sortedAttendanceItems.length}
            currentPage={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      ) : activeTab === 'shifts' ? (
        <div className="ent-table-wrapper">
          {/* Sub-bar: List vs Monthly Calendar View Toggle */}
          <div className="px-4 sm:px-5 py-3.5 border-b border-[#E6DFF0] bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-3">
            <div className="text-[13.5px] font-semibold text-[#262238]">
              ตารางเวรที่ได้รับมอบหมายทั้งหมด ({shiftsData.length} รายการ)
            </div>
            <div className="ent-tab-bar">
              <button
                type="button"
                onClick={() => setShiftDisplayMode('list')}
                className={`ent-tab-btn inline-flex items-center gap-1.5 ${
                  shiftDisplayMode === 'list' ? 'ent-tab-btn-active' : ''
                }`}
              >
                <List className="w-4 h-4" aria-hidden="true" />
                <span>มุมมองรายการ</span>
              </button>
              <button
                type="button"
                onClick={() => setShiftDisplayMode('calendar')}
                className={`ent-tab-btn inline-flex items-center gap-1.5 ${
                  shiftDisplayMode === 'calendar' ? 'ent-tab-btn-active' : ''
                }`}
              >
                <CalendarDays className="w-4 h-4" aria-hidden="true" />
                <span>มุมมองปฏิทิน</span>
              </button>
            </div>
          </div>

          {shiftDisplayMode === 'calendar' ? (
            <div className="p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => stepCalendarMonth(-1)}
                  className="ent-btn-secondary h-9 px-3 text-[13px]"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                  <span>เดือนก่อน</span>
                </button>
                <div className="text-[16px] font-bold text-[#262238]">
                  {calendarModel.thaiLabel}
                </div>
                <button
                  type="button"
                  onClick={() => stepCalendarMonth(1)}
                  className="ent-btn-secondary h-9 px-3 text-[13px]"
                >
                  <span>เดือนถัดไป</span>
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>

              <div className="overflow-x-auto">
                <div className="min-w-[640px]">
                  <div className="grid grid-cols-7 border-t border-l border-[#E6DFF0] bg-[#F8F7FC]">
                    {THAI_WEEKDAYS_SHORT.map((dayName, i) => (
                      <div
                        key={dayName}
                        className={`py-2 px-2 text-center text-[12.5px] font-bold border-r border-b border-[#E6DFF0] ${
                          i === 0 || i === 6 ? 'text-[#8E70C9]' : 'text-[#543B7A]'
                        }`}
                      >
                        {dayName}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 border-l border-[#E6DFF0]">
                    {calendarModel.cells.map((cell, idx) => (
                      <div
                        key={cell.ymd || `blank-${idx}`}
                        className={`min-h-[86px] p-2 border-r border-b border-[#E6DFF0] ${
                          cell.ymd ? 'bg-white' : 'bg-[#F8F7FC]/60'
                        }`}
                      >
                        {cell.day !== null && (
                          <>
                            <div className="text-[12px] font-mono font-bold text-[#746B83] tabular-nums mb-1.5">
                              {cell.day}
                            </div>
                            <div className="space-y-1">
                              {cell.shifts.map((s) => (
                                <div
                                  key={s.id}
                                  className="px-2 py-1 rounded-md bg-[#F2EDFA] border border-[#E6DFF0] text-[11.5px] leading-tight"
                                >
                                  <div className="font-bold text-[#543B7A] truncate">
                                    {s.snapshot_shift_code} · {s.snapshot_shift_name}
                                  </div>
                                  <div className="font-mono text-[11px] text-[#746B83] tabular-nums">
                                    {s.snapshot_start_time}–{s.snapshot_end_time}
                                  </div>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <>
              {/* Mobile Card View (< md) */}
              <div className="md:hidden divide-y divide-[#E6DFF0]">
                {shiftsData.length === 0 ? (
                  <div className="p-8 text-center text-[14px] text-[#746B83]">
                    ยังไม่มีตารางเวรที่มอบหมายให้คุณ
                  </div>
                ) : (
                  shiftsData.map((s) => (
                    <div key={s.id} className="p-4 space-y-2 bg-white">
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-[15px] text-[#262238]">
                          {formatThaiDate(s.work_date)}
                        </span>
                        <span className="font-mono text-[12.5px] font-bold text-[#543B7A] bg-[#F2EDFA] px-2.5 py-0.5 rounded-md border border-[#E6DFF0]">
                          {s.snapshot_shift_code}
                        </span>
                      </div>
                      <div className="text-[14px] font-semibold text-[#262238]">
                        {s.snapshot_shift_name}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[13px] pt-1 text-[#746B83]">
                        <div>
                          เวลาเข้า–ออก:{' '}
                          <strong className="font-mono text-[#262238] tabular-nums">
                            {s.snapshot_start_time}–{s.snapshot_end_time} น.
                          </strong>
                        </div>
                        <div>
                          ผ่อนผันสาย: <strong className="text-[#198568] tabular-nums">{s.snapshot_grace_minutes} นาที</strong>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Desktop Table View (>= md) */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-[14px]">
                  <thead>
                    <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                      <th className="py-3.5 px-5 font-semibold text-[13px]">วันที่ปฏิบัติงาน</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสกะ</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">ชื่อกะทำงาน</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">เวลาเริ่ม–สิ้นสุด</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">เวลาผ่อนผันสาย</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">เวลาตัดรอบสแกน</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6DFF0]">
                    {shiftsData.length === 0 ? (
                      <TableEmptyState colSpan={6} title="ยังไม่มีตารางเวรที่มอบหมายให้คุณ" />
                    ) : (
                      shiftsData.map((s) => (
                        <tr key={s.id} className="hover:bg-[#F8F7FC] transition-colors">
                          <td className="py-3.5 px-5">
                            <span className="font-semibold text-[#262238]">{formatThaiDate(s.work_date)}</span>{' '}
                            <span className="font-mono text-[12px] text-[#746B83]">({s.work_date})</span>
                          </td>
                          <td className="py-3.5 px-5 font-mono font-bold text-[#543B7A]">{s.snapshot_shift_code}</td>
                          <td className="py-3.5 px-5 font-semibold text-[#262238]">{s.snapshot_shift_name}</td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-[#262238]">
                            {s.snapshot_start_time} – {s.snapshot_end_time} น.
                          </td>
                          <td className="py-3.5 px-5 tabular-nums text-[#746B83]">{s.snapshot_grace_minutes} นาที</td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-[#746B83]">{s.snapshot_cutoff_time} น.</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="ent-table-wrapper">
          {/* Mobile Card View (< md) */}
          <div className="md:hidden divide-y divide-[#E6DFF0]">
            {rawScansData.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#746B83]">
                ไม่พบข้อมูลสแกนต้นฉบับของคุณ
              </div>
            ) : (
              rawScansData.map((r) => (
                <div key={r.id} className="p-4 space-y-1.5 bg-white">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[14.5px] text-[#262238]">
                      {formatThaiDateTime(r.canonical_bkk_time)}
                    </span>
                    <span className="font-mono text-[12.5px] font-semibold text-[#543B7A]">
                      เครื่อง #{r.machine_no}
                    </span>
                  </div>
                  <div className="text-[13.5px] text-[#262238] font-medium">
                    {r.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'} · รหัสสแกน{' '}
                    <span className="font-mono">{r.enroll_number}</span>
                  </div>
                  <div className="text-[12.5px] font-medium text-[#746B83]">
                    สถานะการใช้จับคู่:{' '}
                    {r.usage_role === 'CHECK_IN' ? (
                      <span className="text-[#198568] font-semibold">
                        ใช้เป็นสแกนเข้า ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                      </span>
                    ) : r.usage_role === 'CHECK_OUT' ? (
                      <span className="text-[#5879BC] font-semibold">
                        ใช้เป็นสแกนออก ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                      </span>
                    ) : (
                      <span>สแกนเพิ่มเติม (ไม่ถูกใช้จับคู่)</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Desktop Table View (>= md) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                  <th className="py-3.5 px-5 font-semibold text-[13px]">วันและเวลาที่สแกน</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">เครื่องสแกน</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสลายนิ้วมือ</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">ประเภทการสแกน</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">การใช้จับคู่กับตารางเวร</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6DFF0]">
                {rawScansData.length === 0 ? (
                  <TableEmptyState colSpan={5} title="ไม่พบข้อมูลสแกนต้นฉบับของคุณ" />
                ) : (
                  rawScansData.map((r) => (
                    <tr key={r.id} className="hover:bg-[#F8F7FC] transition-colors">
                      <td className="py-3.5 px-5">
                        <div className="font-semibold text-[#262238]">
                          {formatThaiDateTime(r.canonical_bkk_time)}
                        </div>
                        <div className="text-[12px] font-mono text-[#746B83] tabular-nums">
                          {r.canonical_bkk_time}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums font-semibold text-[#262238]">
                        เครื่อง #{r.machine_no}
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#262238]">{r.enroll_number}</td>
                      <td className="py-3.5 px-5 font-medium text-[#262238]">
                        <div>{r.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'}</div>
                        <div className="text-[12px] font-mono text-[#746B83]">
                          วิธีสแกน={r.verify_mode} · รหัสงาน={r.work_code}
                        </div>
                      </td>
                      <td className="py-3.5 px-5 text-[13.5px]">
                        {r.usage_role === 'CHECK_IN' ? (
                          <span className="text-[#198568] font-semibold">
                            ใช้เป็นสแกนเข้า ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                          </span>
                        ) : r.usage_role === 'CHECK_OUT' ? (
                          <span className="text-[#5879BC] font-semibold">
                            ใช้เป็นสแกนออก ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                          </span>
                        ) : (
                          <span className="text-[#746B83]">สแกนเพิ่มเติม (ไม่ถูกใช้จับคู่)</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Personal Shift & Raw Scan Evidence Drawer */}
      <SlideOverDrawer
        open={Boolean(selectedRowModal)}
        onClose={() => setSelectedRowModal(null)}
        kickerText="หลักฐานการลงเวลาปฏิบัติงานส่วนบุคคล"
        title={
          selectedRowModal
            ? `วันที่ ${formatThaiDate(selectedRowModal.row.work_date)}`
            : ''
        }
        subtitle={
          selectedRowModal
            ? `กะทำงาน: ${selectedRowModal.row.shift_name} · รหัสบุคลากร: ${user.approvedPersonId}`
            : ''
        }
      >
        {selectedRowModal && (
          <div className="space-y-5">
            <div className="p-4 bg-[#F8F7FC] rounded-xl border border-[#E6DFF0] space-y-4">
              <div>
                <div className="text-[12.5px] text-[#746B83]">เวลาเริ่ม–สิ้นสุดตามตารางเวร</div>
                <div className="font-mono font-bold text-[#262238] text-[15px] mt-1 tabular-nums">
                  {selectedRowModal.row.scheduled_start} ถึง {selectedRowModal.row.scheduled_end}
                </div>
              </div>
              {selectedRowModal.row.leave_type && (
                <div>
                  <div className="text-[12.5px] text-[#746B83]">ช่วงเวลาที่ใช้ประเมินจริง (หักช่วงลาครึ่งวัน)</div>
                  <div className="font-mono font-semibold text-[#543B7A] text-[14px] mt-0.5 tabular-nums">
                    {selectedRowModal.row.evaluated_start_time} ถึง {selectedRowModal.row.evaluated_end_time} (ลา{' '}
                    {selectedRowModal.row.leave_start_time}–{selectedRowModal.row.leave_end_time} น.)
                  </div>
                </div>
              )}
              <div>
                <div className="text-[12.5px] text-[#746B83]">สถานะการลงเวลา / นาทีสาย / ออกก่อนเวลา</div>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <AttendanceStatusText
                    status={selectedRowModal.row.status}
                    secondaryFlags={selectedRowModal.row.secondary_flags}
                    earlyCheckoutMinutes={selectedRowModal.row.early_checkout_minutes}
                  />
                  {selectedRowModal.row.late_minutes > 0 && (
                    <span className="font-mono font-bold text-[#B87516] tabular-nums">
                      (สาย {selectedRowModal.row.late_minutes} นาที)
                    </span>
                  )}
                  {Number(selectedRowModal.row.early_checkout_minutes || 0) > 0 && (
                    <span className="font-mono font-bold text-[#C74455] tabular-nums">
                      (ออกก่อนเวลา {selectedRowModal.row.early_checkout_minutes} นาที)
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-[#E6DFF0]">
                <div className="p-3 rounded-lg bg-white border border-[#E6DFF0]">
                  <div className="text-[12.5px] text-[#746B83]">หลักฐานเวลาสแกนเข้า</div>
                  <div className="font-mono font-semibold text-[#262238] mt-1 tabular-nums">
                    {selectedRowModal.row.check_in_time || 'ไม่พบสแกนเข้า'}
                  </div>
                  <div className="text-[12px] font-mono text-[#746B83]">
                    รหัสอ้างอิงสแกน: #{selectedRowModal.row.check_in_raw_scan_id || '—'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-white border border-[#E6DFF0]">
                  <div className="text-[12.5px] text-[#746B83]">หลักฐานเวลาสแกนออก</div>
                  <div className="font-mono font-semibold text-[#262238] mt-1 tabular-nums">
                    {selectedRowModal.row.check_out_time || 'ไม่พบสแกนออก'}
                  </div>
                  <div className="text-[12px] font-mono text-[#746B83]">
                    รหัสอ้างอิงสแกน: #{selectedRowModal.row.check_out_raw_scan_id || '—'}
                  </div>
                </div>
              </div>
            </div>

            {selectedRowModal.rowNotes?.length > 0 && (
              <div className="space-y-2">
                <div className="font-bold text-[#262238] text-[15px]">
                  หมายเหตุรับรองจากเจ้าหน้าที่งานบุคคล (HR):
                </div>
                {selectedRowModal.rowNotes.map((n: any) => (
                  <div
                    key={n.id}
                    className="p-4 bg-[#F2EDFA] border border-[#E6DFF0] rounded-xl text-[#262238]"
                  >
                    <div className="font-semibold text-[#543B7A]">{n.reason_type}</div>
                    <div className="mt-1">{n.note_text}</div>
                    <div className="text-[12.5px] text-[#746B83] mt-1">
                      บันทึกโดย: {n.created_by}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
