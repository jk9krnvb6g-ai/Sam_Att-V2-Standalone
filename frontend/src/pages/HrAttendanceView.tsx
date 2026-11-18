/**
 * ============================================================================
 * หน้าตรวจสอบเวลาปฏิบัติงานและประมวลผลเวลาใหม่สำหรับ HR (HR Attendance Review & Reprocess)
 * ไฟล์: frontend/src/pages/HrAttendanceView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงรายการผลการลงเวลารายกะของบุคลากรทั้งโรงพยาบาล พร้อมตัวกรองช่วงเวลาและสถานะ
 * 2. รองรับการจำลองผลก่อนประมวลผลใหม่ (Preview Reprocess) และการสั่งประมวลผลเวลาใหม่ (Execute Reprocess)
 *    โดยไม่แก้ไขข้อมูลสแกนต้นฉบับ (raw_scans) และไม่ลบหมายเหตุเดิม
 * 3. เปิดแผงด้านข้าง (Slide-Over Drawer) เพื่อบันทึกหมายเหตุชี้แจงรายเวรและบันทึกผลการตรวจทานของ HR
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Play, Eye, CheckCircle2, FileText, Search, PanelRightOpen } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
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
  RequiredMark,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
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
  FORGOT_CHECKOUT_VERIFIED: 'ลืมสแกนออก (มีหลักฐานปฏิบัติงานจริง)',
  SCANNER_ISSUE: 'เครื่องสแกนขัดข้องชั่วคราว',
  LEAVE_OR_OFFICIAL: 'ลา / ไปราชการตามอนุมัติ',
};

export function HrAttendanceView({ mode }: { mode: 'management' | 'review' }) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState(initialBkk.todayYmd);
  const [monthValue, setMonthValue] = useState(initialBkk.currentYearMonth);
  const [yearValue, setYearValue] = useState(initialBkk.currentYear);
  const [customFrom, setCustomFrom] = useState(initialBkk.monthStartYmd);
  const [customTo, setCustomTo] = useState(initialBkk.monthEndYmd);

  const [statusFilter, setStatusFilter] = useState('');
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
  const [reasonType, setReasonType] = useState('OFFICIAL_DUTY');
  const [noteText, setNoteText] = useState('');
  const [reviewComment, setReviewComment] = useState('');

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

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('DESC');
    }
    setPage(1);
  }

  const sortedItems = useMemo(() => {
    const list = [...items];
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
  }, [items, sortKey, sortDir]);

  const pagedItems = useMemo(() => {
    if (pageSize === 'ALL') return sortedItems;
    const start = (page - 1) * pageSize;
    return sortedItems.slice(start, start + pageSize);
  }, [sortedItems, page, pageSize]);

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
        category="การบริหารเวลาและบุคลากร"
        title={
          mode === 'management'
            ? 'รายการลงเวลาปฏิบัติงานทั้งหมด'
            : 'ตรวจสอบเวลาปฏิบัติงาน บันทึกเหตุผล และคำนวณเวลาซ้ำ'
        }
        subtitle="ตรวจสอบเวลาสแกนเข้า–ออกงานเทียบกับตารางเวร บันทึกหมายเหตุการลาหรือไปราชการ และรับรองผลตรวจสอบโดยไม่แก้ไขข้อมูลสแกนต้นฉบับ"
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
              <option value="NO_SCAN">ไม่พบข้อมูลสแกน</option>
              <option value="MISSING_CHECKOUT">ไม่สแกนออกงาน</option>
              <option value="PENDING_MAPPING">รอเชื่อมโยงรหัสสแกน</option>
            </select>
            <div className="relative w-full sm:w-64">
              <Search className="w-4 h-4 text-[#596579] absolute left-3.5 top-3" aria-hidden="true" />
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
        <div className="ent-card p-4 sm:p-6 space-y-4">
          <div className="flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
            <div className="space-y-1">
              <h2 className="text-[17px] sm:text-[18px] font-bold text-[#273244]">
                คำนวณผลเวลาปฏิบัติงานซ้ำ (Reprocess)
              </h2>
              <p className="text-[13.5px] sm:text-[14px] text-[#596579]">
                ใช้เมื่อมีการปรับตารางเวรหรืออัปเดตการเชื่อมโยงรหัสสแกน โดยจะรักษาหมายเหตุและประวัติการตรวจสอบของเจ้าหน้าที่ไว้ครบถ้วน
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
                <span className="text-[13.5px] text-[#596579] text-center">ถึง</span>
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
                <Eye className="w-4 h-4 text-[#B45363]" />
                <span>1. ดูตัวอย่างผลกระทบ</span>
              </button>
              <button
                type="button"
                onClick={handleExecuteReprocess}
                className="ent-btn-primary w-full sm:w-auto"
              >
                <Play className="w-4 h-4" />
                <span>2. ยืนยันคำนวณเวลาซ้ำ</span>
              </button>
            </div>
          </div>

          {previewResult && (
            <div className="border border-[#F9E8EB] bg-[#FFF1F3] rounded-xl p-4 text-[13.5px] sm:text-[14px] space-y-1">
              <div className="font-bold text-[#9F3F50]">
                ผลการจำลองการคำนวณซ้ำ ({formatThaiDate(previewResult.dateFrom)} ถึง{' '}
                {formatThaiDate(previewResult.dateTo)}):
              </div>
              <div className="text-[#273244] tabular-nums">
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
        {/* Mobile Card View (< md) */}
        <div className="md:hidden divide-y divide-[#E7E2E5]">
          {loading ? (
            <div className="p-8 text-center text-[14px] text-[#596579]">
              กำลังโหลดข้อมูลการลงเวลาปฏิบัติงาน...
            </div>
          ) : pagedItems.length === 0 ? (
            <div className="p-8 text-center text-[14px] text-[#596579]">
              ไม่พบรายการลงเวลาตามตัวกรองที่เลือก
            </div>
          ) : (
            pagedItems.map((row) => {
              const rowNotes = notes.filter((n) => n.attendance_id === row.id);
              return (
                <div key={row.id} className="p-4 space-y-3 bg-white hover:bg-[#FFF9F9]">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-bold text-[15px] text-[#273244]">{row.full_name}</div>
                      <div className="text-[12.5px] text-[#596579] mt-0.5">
                        <span className="font-mono">{row.person_id}</span> · สแกน{' '}
                        <span className="font-mono">{row.fingle_id || '—'}</span>
                      </div>
                      <div className="text-[12.5px] text-[#596579] truncate">
                        {row.department_name}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-semibold text-[13.5px] text-[#273244]">
                        {formatThaiDate(row.work_date)}
                      </div>
                      <div className="text-[12px] font-mono text-[#596579]">
                        {row.shift_name} ({row.scheduled_start?.slice(11, 16)}–
                        {row.scheduled_end?.slice(11, 16)})
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5 p-3 rounded-xl bg-[#F8F6F7] border border-[#E7E2E5] text-[13px]">
                    <div>
                      <div className="text-[#596579] text-[12px]">เวลาสแกนเข้า</div>
                      {row.check_in_time ? (
                        <div className="font-mono font-bold text-[#273244] mt-0.5">
                          {row.check_in_time.slice(11, 16)} น.
                        </div>
                      ) : (
                        <div className="font-semibold text-[#B91C1C] mt-0.5">ไม่พบสแกนเข้า</div>
                      )}
                    </div>
                    <div>
                      <div className="text-[#596579] text-[12px]">เวลาสแกนออก</div>
                      {row.check_out_time ? (
                        <div className="font-mono font-bold text-[#273244] mt-0.5">
                          {row.check_out_time.slice(11, 16)} น.
                        </div>
                      ) : (
                        <div className="font-semibold text-[#B45309] mt-0.5">ไม่พบสแกนออก</div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <AttendanceStatusText
                        status={row.status}
                        secondaryFlags={row.secondary_flags}
                      />
                      {row.late_minutes > 0 && (
                        <span className="font-mono text-[13px] font-bold text-[#B45309] bg-amber-50 px-2 py-0.5 rounded-md border border-amber-200">
                          สาย {row.late_minutes} นาที
                        </span>
                      )}
                    </div>
                    <ReviewStatusLabel status={row.review_status} />
                  </div>

                  {rowNotes.length > 0 && (
                    <div className="p-2.5 rounded-lg bg-[#FFF1F3] border border-[#F9E8EB] text-[12.5px] text-[#9F3F50] space-y-1">
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
                    className="w-full h-10 px-3.5 text-[13.5px] font-semibold bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center justify-center gap-2 text-[#273244] transition-colors"
                  >
                    <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
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
              <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
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
                  label="สถานะการลงเวลา"
                  sortKey="status"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="การตรวจสอบ HR"
                  sortKey="review_status"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th className="py-3.5 px-4 text-[13.5px] font-semibold text-right">รายละเอียด</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E2E5]">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-[14.5px] text-[#596579]">
                    กำลังโหลดข้อมูลการลงเวลาปฏิบัติงาน...
                  </td>
                </tr>
              ) : pagedItems.length === 0 ? (
                <TableEmptyState colSpan={9} title="ไม่พบรายการลงเวลาตามตัวกรองที่เลือก" />
              ) : (
                pagedItems.map((row) => {
                  const rowNotes = notes.filter((n) => n.attendance_id === row.id);
                  return (
                    <tr key={row.id} className="hover:bg-[#FFF9F9] transition-colors">
                      <td className="py-4 px-4">
                        <div className="font-semibold text-[#273244]">
                          {formatThaiDate(row.work_date)}
                        </div>
                        <div className="text-[12.5px] font-mono text-[#596579] tabular-nums mt-0.5">
                          เวร #{row.id}
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="font-bold text-[15px] text-[#273244]">{row.full_name}</div>
                        <div className="text-[12.5px] text-[#596579] mt-0.5">
                          <span className="font-mono">{row.person_id}</span> · รหัสสแกน{' '}
                          <span className="font-mono">{row.fingle_id || '—'}</span> · {row.department_name}
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="font-semibold text-[#273244]">{row.shift_name}</div>
                        <div className="text-[12.5px] font-mono text-[#596579] tabular-nums mt-0.5">
                          {row.scheduled_start?.slice(11, 16)} – {row.scheduled_end?.slice(11, 16)} น.
                        </div>
                      </td>
                      <td className="py-4 px-4 font-mono tabular-nums">
                        {row.check_in_time ? (
                          <div>
                            <div className="font-semibold text-[#273244]">
                              {row.check_in_time.slice(11, 16)} น.
                            </div>
                            <div className="text-[12px] text-[#596579]">
                              อ้างอิงสแกน #{row.check_in_raw_scan_id}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[#B91C1C] font-sans text-[13.5px] font-medium">
                            ไม่พบสแกนเข้า
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-4 font-mono tabular-nums">
                        {row.check_out_time ? (
                          <div>
                            <div className="font-semibold text-[#273244]">
                              {row.check_out_time.slice(11, 16)} น.
                            </div>
                            <div className="text-[12px] text-[#596579]">
                              อ้างอิงสแกน #{row.check_out_raw_scan_id}
                            </div>
                          </div>
                        ) : (
                          <span className="text-[#B45309] font-sans text-[13.5px] font-medium">
                            ไม่พบสแกนออก
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-4 text-right font-mono tabular-nums">
                        {row.late_minutes > 0 ? (
                          <span className="font-bold text-[#B45309] text-[14.5px]">
                            {row.late_minutes} นาที
                          </span>
                        ) : (
                          <span className="text-[#596579]">0</span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        <AttendanceStatusText
                          status={row.status}
                          secondaryFlags={row.secondary_flags}
                        />
                      </td>
                      <td className="py-4 px-4">
                        <ReviewStatusLabel status={row.review_status} />
                        {rowNotes.map((n) => (
                          <div key={n.id} className="text-[12.5px] text-[#9F3F50] mt-1">
                            {REASON_LABELS[n.reason_type] || n.reason_type}: {n.note_text}
                          </div>
                        ))}
                      </td>
                      <td className="py-4 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedRow(row)}
                          className="h-9 px-3.5 text-[13.5px] font-semibold bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center gap-1.5 whitespace-nowrap text-[#273244] transition-colors"
                        >
                          <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
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

        <TablePaginationBar
          totalItems={sortedItems.length}
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
            <div className="p-4 rounded-xl bg-[#FFF9F9] border border-[#E7E2E5] space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E7E2E5] pb-3">
                <div>
                  <div className="text-[12.5px] text-[#596579]">รหัสบุคลากร / รหัสลายนิ้วมือ</div>
                  <div className="font-mono font-bold text-[#273244] text-[14.5px] mt-0.5">
                    {selectedRow.person_id} · รหัสสแกน {selectedRow.fingle_id || '—'}
                  </div>
                </div>
                <AttendanceStatusText
                  status={selectedRow.status}
                  secondaryFlags={selectedRow.secondary_flags}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[13.5px]">
                <div className="p-3 rounded-lg bg-white border border-[#E7E2E5]">
                  <div className="text-[#596579]">หลักฐานเวลาสแกนเข้า</div>
                  <div className="font-mono font-semibold text-[#273244] mt-1">
                    {selectedRow.check_in_time
                      ? formatThaiDateTime(selectedRow.check_in_time)
                      : 'ไม่พบข้อมูลสแกนเข้า'}
                  </div>
                  <div className="font-mono text-[12px] text-[#596579] mt-0.5">
                    รหัสอ้างอิง Raw Scan: #{selectedRow.check_in_raw_scan_id || '—'}
                  </div>
                </div>

                <div className="p-3 rounded-lg bg-white border border-[#E7E2E5]">
                  <div className="text-[#596579]">หลักฐานเวลาสแกนออก</div>
                  <div className="font-mono font-semibold text-[#273244] mt-1">
                    {selectedRow.check_out_time
                      ? formatThaiDateTime(selectedRow.check_out_time)
                      : 'ไม่พบข้อมูลสแกนออก'}
                  </div>
                  <div className="font-mono text-[12px] text-[#596579] mt-0.5">
                    รหัสอ้างอิง Raw Scan: #{selectedRow.check_out_raw_scan_id || '—'}
                  </div>
                </div>
              </div>
            </div>

            {/* HR Note & Verification Form */}
            <div className="space-y-4">
              <div className="border-b border-[#E7E2E5] pb-2">
                <h4 className="text-[16px] font-bold text-[#273244]">
                  บันทึกเหตุผลและรับรองผลการตรวจสอบ
                </h4>
                <p className="text-[13px] text-[#596579]">
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
                  <FileText className="w-4 h-4 text-[#B45363]" />
                  <span>บันทึกหมายเหตุ</span>
                </button>
                <button
                  type="button"
                  onClick={handleConfirmReview}
                  className="ent-btn-primary w-full sm:w-auto"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>ยืนยันรับรองผลตรวจสอบ HR</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {mode === 'review' && reviewHistory.length > 0 && (
        <div className="ent-table-wrapper">
          <div className="px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7]">
            <h2 className="text-[18px] font-bold text-[#273244]">
              ประวัติการรับรองผลตรวจสอบล่าสุดโดยเจ้าหน้าที่ HR
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">วันและเวลาที่ตรวจสอบ</th>
                  <th className="py-3.5 px-5 font-semibold">รหัสเวร · บุคลากร</th>
                  <th className="py-3.5 px-5 font-semibold">ผลการพิจารณา</th>
                  <th className="py-3.5 px-5 font-semibold">ความเห็นเจ้าหน้าที่</th>
                  <th className="py-3.5 px-5 font-semibold">ผู้ตรวจสอบ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {reviewHistory.map((h) => (
                  <tr key={h.id} className="hover:bg-[#FFF9F9]">
                    <td className="py-3.5 px-5 font-mono tabular-nums text-[#273244]">
                      {formatThaiDateTime(h.reviewed_at)}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-[#273244]">
                      เวร #{h.attendance_id} · {h.person_id} ({formatThaiDate(h.work_date)})
                    </td>
                    <td className="py-3.5 px-5">
                      <ReviewStatusLabel status={h.new_review_status} />
                    </td>
                    <td className="py-3.5 px-5 text-[#273244]">{h.review_comment}</td>
                    <td className="py-3.5 px-5 font-mono text-[#596579]">{h.reviewed_by}</td>
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
