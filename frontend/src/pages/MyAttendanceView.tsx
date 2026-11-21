/**
 * ============================================================================
 * หน้าเวลาปฏิบัติงานของฉัน (Personal Attendance, Shifts & Scans View)
 * ไฟล์: frontend/src/pages/MyAttendanceView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * - เรียกใช้งาน API กลุ่ม /api/Sam_Att/me/* ซึ่งบังคับตรวจสิทธิ์ Own-Only ที่ฝั่ง Backend
 * - แสดงข้อมูลเฉพาะของบุคลากรเจ้าของบัญชีที่ล็อกอินอยู่เท่านั้น แบ่งเป็น 3 แท็บ:
 *   1. ผลการลงเวลารายวัน (พร้อมปุ่มเปิดดูหลักฐานเวลาสแกนและหมายเหตุจากฝ่ายบุคคล)
 *   2. ตารางเวรที่ได้รับมอบหมาย
 *   3. ประวัติการสแกนลายนิ้วมือต้นฉบับของตนเอง
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { PanelRightOpen } from 'lucide-react';
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
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import { type NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  getCurrentBangkokDateParts,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

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
            <div className="text-[13.5px] font-medium text-[#596579]">เวรปฏิบัติงานทั้งหมด</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#273244] tabular-nums">
              {summary.totalShifts} เวร
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-medium text-[#596579]">ลงเวลาปกติ</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#047857] tabular-nums">
              {summary.normalCount} เวร
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-medium text-[#596579]">จำนวนครั้งที่มาสาย</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#B45309] tabular-nums">
              {summary.lateOccurrences} ครั้ง
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-medium text-[#596579]">นาทีสายสะสม</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#273244] tabular-nums">
              {summary.totalLateMinutes} นาที
            </div>
          </div>
          <div className="ent-card p-5 col-span-2 lg:col-span-1">
            <div className="text-[13.5px] font-medium text-[#596579]">ไม่พบสแกน / ไม่สแกนออก</div>
            <div className="mt-1.5 text-[24px] font-bold text-[#B91C1C] tabular-nums">
              {summary.noScanCount} / {summary.missingCheckoutCount}
            </div>
          </div>
        </div>
      )}

      {/* Segmented View Controls */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 p-1.5 bg-[#E7E2E5]/60 rounded-xl w-full sm:w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('attendance')}
          className={`px-4 py-2 text-[13.5px] sm:text-[14px] font-medium rounded-lg transition-colors text-center whitespace-nowrap ${
            activeTab === 'attendance'
              ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
              : 'text-[#596579] hover:text-[#273244]'
          }`}
        >
          ผลการลงเวลารายวัน ({attendanceData?.items?.length || 0})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('shifts')}
          className={`px-4 py-2 text-[13.5px] sm:text-[14px] font-medium rounded-lg transition-colors text-center whitespace-nowrap ${
            activeTab === 'shifts'
              ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
              : 'text-[#596579] hover:text-[#273244]'
          }`}
        >
          ตารางเวรของฉัน ({shiftsData.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('rawScans')}
          className={`px-4 py-2 text-[13.5px] sm:text-[14px] font-medium rounded-lg transition-colors text-center whitespace-nowrap ${
            activeTab === 'rawScans'
              ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
              : 'text-[#596579] hover:text-[#273244]'
          }`}
        >
          ประวัติการสแกนลายนิ้วมือ ({rawScansData.length})
        </button>
      </div>

      {loading ? (
        <div className="ent-card p-12 text-center text-[14.5px] text-[#596579]">
          กำลังโหลดข้อมูลการลงเวลาของคุณ...
        </div>
      ) : activeTab === 'attendance' ? (
        <div className="ent-table-wrapper">
          {/* Mobile Card View (< md) */}
          <div className="md:hidden divide-y divide-[#E7E2E5]">
            {pagedAttendance.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#596579]">
                ยังไม่มีข้อมูลผลการลงเวลาในช่วงวันที่เลือก
              </div>
            ) : (
              pagedAttendance.map((row: any) => {
                const rowNotes = (attendanceData?.notes || []).filter(
                  (n: any) => n.attendance_id === row.id
                );
                return (
                  <div key={row.id} className="p-4 space-y-3 bg-white hover:bg-[#FFF9F9]">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-[15px] text-[#273244]">
                          {formatThaiDate(row.work_date)}
                        </div>
                        <div className="text-[12.5px] text-[#596579] mt-0.5">
                          {row.shift_name || row.shift_code || '—'} ·{' '}
                          <span className="font-mono">
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

                    <div className="grid grid-cols-2 gap-2.5 p-3 rounded-xl bg-[#F8F6F7] border border-[#E7E2E5] text-[13px]">
                      <div>
                        <div className="text-[#596579] text-[12px]">เวลาสแกนเข้า</div>
                        <div className="font-mono font-bold text-[#273244] mt-0.5">
                          {row.check_in_time ? `${row.check_in_time.slice(11, 16)} น.` : 'ไม่พบสแกนเข้า'}
                        </div>
                      </div>
                      <div>
                        <div className="text-[#596579] text-[12px]">เวลาสแกนออก</div>
                        <div className="font-mono font-bold text-[#273244] mt-0.5">
                          {row.check_out_time ? `${row.check_out_time.slice(11, 16)} น.` : 'ไม่พบสแกนออก'}
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
                      <ReviewStatusLabel status={row.review_status} />
                      {row.late_minutes > 0 && (
                        <span className="font-mono font-bold text-[#B45309]">
                          มาสาย {row.late_minutes} นาที
                        </span>
                      )}
                    </div>

                    {rowNotes.length > 0 && (
                      <div className="p-2.5 rounded-lg bg-[#FFF1F3] border border-[#F9E8EB] text-[12.5px] text-[#9F3F50] space-y-1">
                        {rowNotes.map((n: any) => (
                          <div key={n.id}>หมายเหตุ HR: {n.note_text}</div>
                        ))}
                      </div>
                    )}

                    <button
                      type="button"
                      onClick={() => setSelectedRowModal({ row, rowNotes })}
                      className="w-full h-10 px-3.5 text-[13.5px] bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center justify-center gap-2 font-semibold text-[#273244] transition-colors"
                    >
                      <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
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
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
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
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold">เวลาตามตารางเวร</th>
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold">เวลาสแกนเข้า</th>
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold">เวลาสแกนออก</th>
                  <SortableHeader
                    label="นาทีสาย"
                    sortKey="late_minutes"
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
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold">ผลตรวจ HR / หมายเหตุ</th>
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold text-right">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {pagedAttendance.length === 0 ? (
                  <TableEmptyState colSpan={9} title="ยังไม่มีข้อมูลผลการลงเวลาในช่วงวันที่เลือก" />
                ) : (
                  pagedAttendance.map((row: any) => {
                    const rowNotes = (attendanceData?.notes || []).filter(
                      (n: any) => n.attendance_id === row.id
                    );
                    return (
                      <tr key={row.id} className="hover:bg-[#FFF9F9] transition-colors">
                        <td className="py-4 px-4">
                          <div className="font-semibold text-[#273244]">
                            {formatThaiDate(row.work_date)}
                          </div>
                          <div className="text-[12.5px] font-mono text-[#596579] tabular-nums mt-0.5">
                            {row.work_date}
                          </div>
                        </td>
                        <td className="py-4 px-4 font-semibold text-[#273244]">
                          {row.shift_name || row.shift_code || '—'}
                        </td>
                        <td className="py-4 px-4 font-mono tabular-nums text-[#596579]">
                          {row.scheduled_start?.slice(11, 16)} – {row.scheduled_end?.slice(11, 16)} น.
                        </td>
                        <td className="py-4 px-4 font-mono tabular-nums text-[#273244] font-medium">
                          {row.check_in_time ? `${row.check_in_time.slice(11, 16)} น.` : '—'}
                        </td>
                        <td className="py-4 px-4 font-mono tabular-nums text-[#273244] font-medium">
                          {row.check_out_time ? `${row.check_out_time.slice(11, 16)} น.` : '—'}
                        </td>
                        <td className="py-4 px-4 text-right font-mono tabular-nums font-bold text-[#B45309]">
                          {row.late_minutes > 0 ? `${row.late_minutes} นาที` : '0'}
                        </td>
                        <td className="py-4 px-4">
                          <AttendanceStatusText
                            status={row.status}
                            secondaryFlags={row.secondary_flags}
                            earlyCheckoutMinutes={row.early_checkout_minutes}
                          />
                          {row.leave_type && (
                            <div className="text-[12px] text-[#7359B4] mt-0.5">
                              ลาบางส่วน ({row.leave_start_time}–{row.leave_end_time} น.)
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-4">
                          <ReviewStatusLabel status={row.review_status} />
                          {rowNotes.map((n: any) => (
                            <div key={n.id} className="text-[12.5px] text-[#9F3F50] mt-1">
                              {n.note_text}
                            </div>
                          ))}
                        </td>
                        <td className="py-4 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedRowModal({ row, rowNotes })}
                            className="h-9 px-3.5 text-[13.5px] bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-[#273244] transition-colors"
                          >
                            <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
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
          {/* Mobile Card View (< md) */}
          <div className="md:hidden divide-y divide-[#E7E2E5]">
            {shiftsData.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#596579]">
                ยังไม่มีตารางเวรที่มอบหมายให้คุณ
              </div>
            ) : (
              shiftsData.map((s) => (
                <div key={s.id} className="p-4 space-y-2 bg-white">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[15px] text-[#273244]">
                      {formatThaiDate(s.work_date)}
                    </span>
                    <span className="font-mono text-[12.5px] font-bold text-[#9F3F50] bg-[#FFF1F3] px-2.5 py-0.5 rounded-md border border-[#F9E8EB]">
                      {s.snapshot_shift_code}
                    </span>
                  </div>
                  <div className="text-[14px] font-semibold text-[#273244]">
                    {s.snapshot_shift_name}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[13px] pt-1 text-[#596579]">
                    <div>
                      เวลาเข้า–ออก:{' '}
                      <strong className="font-mono text-[#273244]">
                        {s.snapshot_start_time}–{s.snapshot_end_time} น.
                      </strong>
                    </div>
                    <div>
                      ผ่อนผันสาย: <strong className="text-[#047857]">{s.snapshot_grace_minutes} นาที</strong>
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
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">วันที่ปฏิบัติงาน</th>
                  <th className="py-3.5 px-5 font-semibold">รหัสกะ</th>
                  <th className="py-3.5 px-5 font-semibold">ชื่อกะทำงาน</th>
                  <th className="py-3.5 px-5 font-semibold">เวลาเริ่ม–สิ้นสุด</th>
                  <th className="py-3.5 px-5 font-semibold">เวลาผ่อนผันสาย</th>
                  <th className="py-3.5 px-5 font-semibold">เวลาตัดรอบสแกน</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {shiftsData.length === 0 ? (
                  <TableEmptyState colSpan={6} title="ยังไม่มีตารางเวรที่มอบหมายให้คุณ" />
                ) : (
                  shiftsData.map((s) => (
                    <tr key={s.id} className="hover:bg-[#FFF9F9]">
                      <td className="py-4 px-5">
                        <span className="font-semibold text-[#273244]">{formatThaiDate(s.work_date)}</span>{' '}
                        <span className="font-mono text-[12.5px] text-[#596579]">({s.work_date})</span>
                      </td>
                      <td className="py-4 px-5 font-mono font-bold text-[#9F3F50]">{s.snapshot_shift_code}</td>
                      <td className="py-4 px-5 font-semibold text-[#273244]">{s.snapshot_shift_name}</td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#273244]">
                        {s.snapshot_start_time} – {s.snapshot_end_time} น.
                      </td>
                      <td className="py-4 px-5 tabular-nums text-[#596579]">{s.snapshot_grace_minutes} นาที</td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#596579]">{s.snapshot_cutoff_time} น.</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="ent-table-wrapper">
          {/* Mobile Card View (< md) */}
          <div className="md:hidden divide-y divide-[#E7E2E5]">
            {rawScansData.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#596579]">
                ไม่พบข้อมูลสแกนต้นฉบับของคุณ
              </div>
            ) : (
              rawScansData.map((r) => (
                <div key={r.id} className="p-4 space-y-1.5 bg-white">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-[14.5px] text-[#273244]">
                      {formatThaiDateTime(r.canonical_bkk_time)}
                    </span>
                    <span className="font-mono text-[12.5px] font-semibold text-[#9F3F50]">
                      เครื่อง #{r.machine_no}
                    </span>
                  </div>
                  <div className="text-[13.5px] text-[#273244] font-medium">
                    {r.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'} · รหัสสแกน{' '}
                    <span className="font-mono">{r.enroll_number}</span>
                  </div>
                  <div className="text-[12.5px] font-medium text-[#596579]">
                    สถานะการใช้จับคู่:{' '}
                    {r.usage_role === 'CHECK_IN' ? (
                      <span className="text-[#047857] font-semibold">
                        ใช้เป็นสแกนเข้า ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                      </span>
                    ) : r.usage_role === 'CHECK_OUT' ? (
                      <span className="text-[#2563EB] font-semibold">
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
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">วันและเวลาที่สแกน</th>
                  <th className="py-3.5 px-5 font-semibold">เครื่องสแกน</th>
                  <th className="py-3.5 px-5 font-semibold">รหัสลายนิ้วมือ</th>
                  <th className="py-3.5 px-5 font-semibold">ประเภทการสแกน</th>
                  <th className="py-3.5 px-5 font-semibold">การใช้จับคู่กับตารางเวร</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {rawScansData.length === 0 ? (
                  <TableEmptyState colSpan={5} title="ไม่พบข้อมูลสแกนต้นฉบับของคุณ" />
                ) : (
                  rawScansData.map((r) => (
                    <tr key={r.id} className="hover:bg-[#FFF9F9]">
                      <td className="py-4 px-5">
                        <div className="font-semibold text-[#273244]">
                          {formatThaiDateTime(r.canonical_bkk_time)}
                        </div>
                        <div className="text-[12.5px] font-mono text-[#596579] tabular-nums">
                          {r.canonical_bkk_time}
                        </div>
                      </td>
                      <td className="py-4 px-5 font-mono tabular-nums font-semibold text-[#273244]">
                        เครื่อง #{r.machine_no}
                      </td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#273244]">{r.enroll_number}</td>
                      <td className="py-4 px-5 font-medium text-[#273244]">
                        <div>{r.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'}</div>
                        <div className="text-[12px] font-mono text-[#596579]">
                          วิธีสแกน={r.verify_mode} · รหัสงาน={r.work_code}
                        </div>
                      </td>
                      <td className="py-4 px-5 text-[13.5px]">
                        {r.usage_role === 'CHECK_IN' ? (
                          <span className="text-[#047857] font-semibold">
                            ใช้เป็นสแกนเข้า ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                          </span>
                        ) : r.usage_role === 'CHECK_OUT' ? (
                          <span className="text-[#2563EB] font-semibold">
                            ใช้เป็นสแกนออก ({r.used_shift_code || `เวร #${r.used_attendance_id}`})
                          </span>
                        ) : (
                          <span className="text-[#596579]">สแกนเพิ่มเติม (ไม่ถูกใช้จับคู่)</span>
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
            <div className="p-4 bg-[#FFF9F9] rounded-xl border border-[#E7E2E5] space-y-4">
              <div>
                <div className="text-[13px] text-[#596579]">เวลาเริ่ม–สิ้นสุดตามตารางเวร</div>
                <div className="font-mono font-bold text-[#273244] text-[15px] mt-1">
                  {selectedRowModal.row.scheduled_start} ถึง {selectedRowModal.row.scheduled_end}
                </div>
              </div>
              {selectedRowModal.row.leave_type && (
                <div>
                  <div className="text-[13px] text-[#596579]">ช่วงเวลาที่ใช้ประเมินจริง (หักช่วงลาครึ่งวัน)</div>
                  <div className="font-mono font-semibold text-[#7359B4] text-[14px] mt-0.5">
                    {selectedRowModal.row.evaluated_start_time} ถึง {selectedRowModal.row.evaluated_end_time} (ลา{' '}
                    {selectedRowModal.row.leave_start_time}–{selectedRowModal.row.leave_end_time} น.)
                  </div>
                </div>
              )}
              <div>
                <div className="text-[13px] text-[#596579]">สถานะการลงเวลา / นาทีสาย / ออกก่อนเวลา</div>
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  <AttendanceStatusText
                    status={selectedRowModal.row.status}
                    secondaryFlags={selectedRowModal.row.secondary_flags}
                    earlyCheckoutMinutes={selectedRowModal.row.early_checkout_minutes}
                  />
                  {selectedRowModal.row.late_minutes > 0 && (
                    <span className="font-mono font-bold text-[#B45309]">
                      (สาย {selectedRowModal.row.late_minutes} นาที)
                    </span>
                  )}
                  {Number(selectedRowModal.row.early_checkout_minutes || 0) > 0 && (
                    <span className="font-mono font-bold text-[#B91C1C]">
                      (ออกก่อนเวลา {selectedRowModal.row.early_checkout_minutes} นาที)
                    </span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-[#E7E2E5]">
                <div>
                  <div className="text-[13px] text-[#596579]">หลักฐานเวลาสแกนเข้า</div>
                  <div className="font-mono font-semibold text-[#273244] mt-1">
                    {selectedRowModal.row.check_in_time || 'ไม่พบสแกนเข้า'}
                  </div>
                  <div className="text-[12px] font-mono text-[#596579]">
                    รหัสอ้างอิงสแกน: #{selectedRowModal.row.check_in_raw_scan_id || '—'}
                  </div>
                </div>
                <div>
                  <div className="text-[13px] text-[#596579]">หลักฐานเวลาสแกนออก</div>
                  <div className="font-mono font-semibold text-[#273244] mt-1">
                    {selectedRowModal.row.check_out_time || 'ไม่พบสแกนออก'}
                  </div>
                  <div className="text-[12px] font-mono text-[#596579]">
                    รหัสอ้างอิงสแกน: #{selectedRowModal.row.check_out_raw_scan_id || '—'}
                  </div>
                </div>
              </div>
            </div>

            {selectedRowModal.rowNotes?.length > 0 && (
              <div className="space-y-2">
                <div className="font-bold text-[#273244] text-[15px]">
                  หมายเหตุรับรองจากเจ้าหน้าที่งานบุคคล (HR):
                </div>
                {selectedRowModal.rowNotes.map((n: any) => (
                  <div
                    key={n.id}
                    className="p-4 bg-[#FFF1F3] border border-[#F9E8EB] rounded-xl text-[#273244]"
                  >
                    <div className="font-semibold text-[#9F3F50]">{n.reason_type}</div>
                    <div className="mt-1">{n.note_text}</div>
                    <div className="text-[12.5px] text-[#596579] mt-1">
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
