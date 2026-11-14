import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Play, Eye, CheckCircle2, FileText, Search } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
import { AttendanceStatusText, ErrorBanner } from '../components/StatusText.tsx';
import {
  PeriodFilterBar,
  SharedModal,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

export function HrAttendanceView({ mode }: { mode: 'management' | 'review' }) {
  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState('2026-11-13');
  const [monthValue, setMonthValue] = useState('2026-11');
  const [yearValue, setYearValue] = useState('2026');
  const [customFrom, setCustomFrom] = useState('2026-11-01');
  const [customTo, setCustomTo] = useState('2026-11-30');

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

  // Modal review state
  const [selectedRow, setSelectedRow] = useState<any | null>(null);
  const [reasonType, setReasonType] = useState('OFFICIAL_DUTY');
  const [noteText, setNoteText] = useState('');
  const [reviewComment, setReviewComment] = useState('');

  // Reprocess Preview / Execute state
  const [reprocessFrom, setReprocessFrom] = useState('2026-11-12');
  const [reprocessTo, setReprocessTo] = useState('2026-11-13');
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
      setNotice(`บันทึกหมายเหตุสำหรับรายการ #${selectedRow.id} สำเร็จ (โดยไม่แก้ไข Raw Scan ต้นฉบับ)`);
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
      setNotice(`บันทึกผลการตรวจสอบ HR สำหรับรายการ #${selectedRow.id} สำเร็จ`);
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
      const res = await apiRequest('/attendance/reprocess/preview', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: reprocessFrom,
          dateTo: reprocessTo,
          referenceNowBkk: '2026-11-13 18:00:00',
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
      const res = await apiRequest('/attendance/reprocess', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: reprocessFrom,
          dateTo: reprocessTo,
          referenceNowBkk: '2026-11-13 18:00:00',
        }),
      });
      setPreviewResult(null);
      setNotice(
        `คำนวณซ้ำ (Reprocess) สำเร็จ: ประมวลผล ${res.totalProcessed} เวร (อัปเดต ${res.updatedCount}, เพิ่มใหม่ ${res.insertedCount}) โดยคงข้อมูล Raw Scan และหมายเหตุ HR เดิมครบถ้วน`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-slate-900">
          {mode === 'management'
            ? 'จัดการ HR และรายงานการลงเวลาทั้งองค์กร (HR Attendance Management)'
            : 'ตรวจสอบเวลาและการทำงาน บันทึกเหตุผล และ Reprocess (Attendance Review)'}
        </h2>
        <p className="text-xs text-slate-600 mt-0.5">
          ข้อมูลคำนวณแบบ Deterministic จาก Raw Scan + Shift Snapshot · การเพิ่มหมายเหตุหรือ Reprocess จะไม่แก้ไข Raw Scan ต้นทาง
        </p>
      </div>

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
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="">ทุกสถานะการลงเวลา</option>
              <option value="NORMAL">NORMAL · ปกติ</option>
              <option value="LATE">LATE · มาสาย</option>
              <option value="NO_SCAN">NO_SCAN · ไม่พบสแกน</option>
              <option value="MISSING_CHECKOUT">MISSING_CHECKOUT · ขาดสแกนออก</option>
              <option value="PENDING_MAPPING">PENDING_MAPPING · รอจับคู่ FINGLE_ID</option>
            </select>
            <div className="relative">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="ค้นหา PERSON_ID หรือชื่อ..."
                className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-52"
              />
            </div>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {mode === 'review' && (
        <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                คำนวณผลเวลาปฏิบัติงานซ้ำ (Deterministic Reprocess Preview & Execute)
              </h3>
              <p className="text-xs text-slate-600">
                ใช้เมื่อมีการปรับตารางเวรหรืออัปเดต FINGLE_ID Mapping โดยจะรักษาหมายเหตุและประวัติตรวจ HR เดิมไว้ทั้งหมด
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={reprocessFrom}
                onChange={(e) => setReprocessFrom(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              <span className="text-xs text-slate-500">ถึง</span>
              <input
                type="date"
                value={reprocessTo}
                onChange={(e) => setReprocessTo(e.target.value)}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono tabular-nums"
              />
              <button
                type="button"
                onClick={handlePreviewReprocess}
                className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-900 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Eye className="w-3.5 h-3.5" />
                <span>1. ดูตัวอย่างผลกระทบ (Preview)</span>
              </button>
              <button
                type="button"
                onClick={handleExecuteReprocess}
                className="px-3 py-1.5 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Play className="w-3.5 h-3.5" />
                <span>2. ยืนยันคำนวณซ้ำ (Confirm Reprocess)</span>
              </button>
            </div>
          </div>

          {previewResult && (
            <div className="border border-slate-200 bg-slate-50 rounded-lg p-3 text-xs space-y-1">
              <div className="font-semibold text-slate-900">
                ผลการจำลอง Reprocess ({formatThaiDate(previewResult.dateFrom)} ถึง{' '}
                {formatThaiDate(previewResult.dateTo)}):
              </div>
              <div className="text-slate-700 tabular-nums">
                ประเมินทั้งหมด {previewResult.totalEvaluated} เวร · รายการใหม่ {previewResult.newRecordsCount} · เปลี่ยนแปลง{' '}
                {previewResult.changedCount} · คงเดิม {previewResult.unchangedCount}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Main Attendance Table with Sortable Headers & Pagination */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <SortableHeader
                  label="ID · วันที่ (พ.ศ.)"
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
                <th className="py-2.5 px-3 font-medium">เวลาเข้า (Raw Scan ID)</th>
                <th className="py-2.5 px-3 font-medium">เวลาออก (Raw Scan ID)</th>
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
                <SortableHeader
                  label="สถานะตรวจ HR"
                  sortKey="review_status"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th className="py-2.5 px-3 font-medium text-right">การจัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-500">
                    กำลังโหลดรายการลงเวลา...
                  </td>
                </tr>
              ) : pagedItems.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-8 text-center text-slate-500">
                    ไม่พบรายการลงเวลาตามตัวกรองที่เลือก
                  </td>
                </tr>
              ) : (
                pagedItems.map((row) => {
                  const rowNotes = notes.filter((n) => n.attendance_id === row.id);
                  return (
                    <tr key={row.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3">
                        <div className="font-semibold text-slate-900">
                          {formatThaiDate(row.work_date)}
                        </div>
                        <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                          #{row.id} · {row.work_date}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900">{row.full_name}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {row.person_id} · FINGLE:{row.fingle_id || '-'} · {row.department_name}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium">{row.shift_name}</div>
                        <div className="text-[11px] font-mono text-slate-500">
                          {row.scheduled_start?.slice(11, 16)} – {row.scheduled_end?.slice(11, 16)} น.
                        </div>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">
                        {row.check_in_time ? (
                          <>
                            <div>{formatThaiDateTime(row.check_in_time)}</div>
                            <div className="text-[11px] text-slate-500">Scan #{row.check_in_raw_scan_id}</div>
                          </>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">
                        {row.check_out_time ? (
                          <>
                            <div>{formatThaiDateTime(row.check_out_time)}</div>
                            <div className="text-[11px] text-slate-500">Scan #{row.check_out_raw_scan_id}</div>
                          </>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono tabular-nums font-bold">
                        {row.late_minutes}
                      </td>
                      <td className="py-2.5 px-3">
                        <AttendanceStatusText
                          status={row.status}
                          secondaryFlags={row.secondary_flags}
                        />
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="font-semibold text-slate-800">{row.review_status}</div>
                        {rowNotes.map((n) => (
                          <div key={n.id} className="text-[11px] text-teal-800">
                            [{n.reason_type}] {n.note_text}
                          </div>
                        ))}
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedRow(row)}
                          className="px-2.5 py-1 text-xs font-medium bg-slate-100 border border-slate-300 rounded hover:bg-slate-200 whitespace-nowrap"
                        >
                          {mode === 'review' ? 'ตรวจสอบ / หมายเหตุ' : 'ดูหลักฐาน'}
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

      {/* Review & Note Entry Modal */}
      <SharedModal
        open={Boolean(selectedRow)}
        onClose={() => setSelectedRow(null)}
        kickerText="ตรวจสอบหลักฐาน Raw Scan และบันทึกหมายเหตุ HR (ไม่แก้ไขเวลาสแกนต้นฉบับ)"
        title={
          selectedRow
            ? `#${selectedRow.id} · ${selectedRow.full_name} (${formatThaiDate(selectedRow.work_date)})`
            : ''
        }
        subtitle={
          selectedRow
            ? `${selectedRow.shift_name} · รหัสบุคลากร: ${selectedRow.person_id} · FINGLE_ID: ${selectedRow.fingle_id || '-'}`
            : ''
        }
      >
        {selectedRow && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-200">
              <div>
                <div className="text-slate-500">เวลาสแกนเข้า</div>
                <div className="font-mono font-semibold mt-0.5">
                  {selectedRow.check_in_time || 'ไม่พบสแกนเข้า'} (Scan #{selectedRow.check_in_raw_scan_id || '-'})
                </div>
              </div>
              <div>
                <div className="text-slate-500">เวลาสแกนออก</div>
                <div className="font-mono font-semibold mt-0.5">
                  {selectedRow.check_out_time || 'ไม่พบสแกนออก'} (Scan #{selectedRow.check_out_raw_scan_id || '-'})
                </div>
              </div>
              <div>
                <div className="text-slate-500">สถานะปัจจุบัน</div>
                <div className="mt-0.5">
                  <AttendanceStatusText
                    status={selectedRow.status}
                    secondaryFlags={selectedRow.secondary_flags}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  ประเภทเหตุผล (Reason Category)
                </label>
                <select
                  value={reasonType}
                  onChange={(e) => setReasonType(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  <option value="OFFICIAL_DUTY">ไปราชการ / อบรมภายนอก</option>
                  <option value="ANNUAL_LEAVE">ลาพักผ่อน / ลากิจ / ลาป่วย</option>
                  <option value="FORGOT_CHECKOUT_VERIFIED">ลืมสแกนออก (มีหลักฐานปฏิบัติงานจริง)</option>
                  <option value="SCANNER_ISSUE">เครื่องสแกนขัดข้องชั่วคราว</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  รายละเอียดหมายเหตุ (บันทึกแยกในตาราง attendance_notes)
                </label>
                <input
                  type="text"
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  placeholder="ระบุเลขที่หนังสืออนุมัติ / รายละเอียด..."
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                ความเห็นผู้ตรวจสอบ HR (บันทึกใน hr_review_history)
              </label>
              <input
                type="text"
                value={reviewComment}
                onChange={(e) => setReviewComment(e.target.value)}
                placeholder="เช่น ตรวจสอบใบลา/หนังสือส่งตัวถูกต้องตามระเบียบ..."
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-2">
              <button
                type="button"
                onClick={handleAddNote}
                className="px-3.5 py-2 text-xs font-medium bg-slate-900 text-white rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>บันทึกหมายเหตุ (Add Note)</span>
              </button>
              <button
                type="button"
                onClick={handleConfirmReview}
                className="px-3.5 py-2 text-xs font-semibold bg-emerald-700 text-white rounded-lg hover:bg-emerald-800 inline-flex items-center gap-1.5"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>ยืนยันผลตรวจสอบ HR (Approve Review)</span>
              </button>
            </div>
          </div>
        )}
      </SharedModal>

      {mode === 'review' && reviewHistory.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200">
            <h3 className="text-sm font-semibold text-slate-900">
              ประวัติการตรวจสอบโดยเจ้าหน้าที่ HR (hr_review_history)
            </h3>
          </div>
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2 px-3 font-medium">เวลาตรวจสอบ</th>
                <th className="py-2 px-3 font-medium">Attendance ID · บุคลากร</th>
                <th className="py-2 px-3 font-medium">การเปลี่ยนสถานะตรวจ</th>
                <th className="py-2 px-3 font-medium">ความเห็น</th>
                <th className="py-2 px-3 font-medium">ผู้ตรวจ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {reviewHistory.map((h) => (
                <tr key={h.id}>
                  <td className="py-2 px-3 font-mono tabular-nums">
                    {formatThaiDateTime(h.reviewed_at)}
                  </td>
                  <td className="py-2 px-3 font-mono">
                    #{h.attendance_id} · {h.person_id} ({formatThaiDate(h.work_date)})
                  </td>
                  <td className="py-2 px-3 font-mono">
                    {h.previous_review_status} → {h.new_review_status}
                  </td>
                  <td className="py-2 px-3">{h.review_comment}</td>
                  <td className="py-2 px-3 font-mono">{h.reviewed_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
