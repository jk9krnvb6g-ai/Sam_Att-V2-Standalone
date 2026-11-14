import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Eye } from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../services/api.ts';
import { AttendanceStatusText, ErrorBanner } from '../components/StatusText.tsx';
import {
  PeriodFilterBar,
  SharedModal,
  SortableHeader,
  TablePaginationBar,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

export function MyAttendanceView({ user }: { user: AuthUser }) {
  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState('2026-11-13');
  const [monthValue, setMonthValue] = useState('2026-11');
  const [yearValue, setYearValue] = useState('2026');
  const [customFrom, setCustomFrom] = useState('2026-11-01');
  const [customTo, setCustomTo] = useState('2026-11-30');

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

  // Detail Modal for inspecting a single shift & its raw scan trace
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
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-bold text-slate-900">
          เวลาปฏิบัติงานของฉัน (My Attendance — ข้อมูลส่วนบุคคล Own-Only)
        </h2>
        <p className="text-xs text-slate-600 mt-0.5">
          แสดงเฉพาะข้อมูลที่ผูกกับรหัสบุคลากรของคุณ ({user.approvedPersonId || 'ยังไม่ได้ผูก PERSON_ID'}) โดยตรวจสอบสิทธิ์ที่ฝั่ง Server เท่านั้น
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
      />

      <ErrorBanner error={error} onRetry={loadOwnData} />

      {summary && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="bg-white border border-slate-200 rounded-lg p-3.5">
            <div className="text-xs text-slate-500">เวรปฏิบัติงานทั้งหมด</div>
            <div className="mt-1 text-xl font-bold text-slate-900 tabular-nums">
              {summary.totalShifts} เวร
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-3.5">
            <div className="text-xs text-slate-500">ลงเวลาปกติ (NORMAL)</div>
            <div className="mt-1 text-xl font-bold text-emerald-700 tabular-nums">
              {summary.normalCount} เวร
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-3.5">
            <div className="text-xs text-slate-500">จำนวนครั้งที่มาสาย</div>
            <div className="mt-1 text-xl font-bold text-amber-700 tabular-nums">
              {summary.lateOccurrences} ครั้ง
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-3.5">
            <div className="text-xs text-slate-500">นาทีสายสะสม</div>
            <div className="mt-1 text-xl font-bold text-slate-900 tabular-nums">
              {summary.totalLateMinutes} นาที
            </div>
          </div>
          <div className="bg-white border border-slate-200 rounded-lg p-3.5">
            <div className="text-xs text-slate-500">NO_SCAN / ขาดสแกนออก</div>
            <div className="mt-1 text-xl font-bold text-red-700 tabular-nums">
              {summary.noScanCount} / {summary.missingCheckoutCount}
            </div>
          </div>
        </div>
      )}

      {/* Segmented View Controls */}
      <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg w-fit">
        <button
          type="button"
          onClick={() => setActiveTab('attendance')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'attendance'
              ? 'bg-white text-slate-900 shadow-2xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          ผลการลงเวลารายวัน ({attendanceData?.items?.length || 0})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('shifts')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'shifts'
              ? 'bg-white text-slate-900 shadow-2xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          ตารางเวรของฉัน ({shiftsData.length})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('rawScans')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
            activeTab === 'rawScans'
              ? 'bg-white text-slate-900 shadow-2xs font-semibold'
              : 'text-slate-600 hover:text-slate-900'
          }`}
        >
          ประวัติสแกนต้นฉบับ (Raw Scans: {rawScansData.length})
        </button>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-lg p-8 text-center text-xs text-slate-500">
          กำลังโหลดข้อมูลการลงเวลาของคุณ...
        </div>
      ) : activeTab === 'attendance' ? (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <SortableHeader
                    label="วันที่ปฏิบัติงาน (พ.ศ.)"
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
                  <th className="py-2.5 px-3 font-medium">เวลาตามตารางเวร</th>
                  <th className="py-2.5 px-3 font-medium">เวลาสแกนเข้า</th>
                  <th className="py-2.5 px-3 font-medium">เวลาสแกนออก</th>
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
                  <th className="py-2.5 px-3 font-medium">ผลตรวจ HR / หมายเหตุ</th>
                  <th className="py-2.5 px-3 font-medium text-right">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {pagedAttendance.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="py-8 text-center text-slate-500">
                      ยังไม่มีข้อมูลผลการลงเวลาในช่วงวันที่เลือก
                    </td>
                  </tr>
                ) : (
                  pagedAttendance.map((row: any) => {
                    const rowNotes = (attendanceData?.notes || []).filter(
                      (n: any) => n.attendance_id === row.id
                    );
                    return (
                      <tr key={row.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-slate-900">
                            {formatThaiDate(row.work_date)}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                            {row.work_date}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-medium">
                          {row.shift_name || row.shift_code || '-'}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                          {row.scheduled_start?.slice(11, 16)} – {row.scheduled_end?.slice(11, 16)} น.
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums">
                          {row.check_in_time ? formatThaiDateTime(row.check_in_time) : '-'}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums">
                          {row.check_out_time ? formatThaiDateTime(row.check_out_time) : '-'}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold">
                          {row.late_minutes}
                        </td>
                        <td className="py-2.5 px-3">
                          <AttendanceStatusText
                            status={row.status}
                            secondaryFlags={row.secondary_flags}
                          />
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="text-slate-700 font-medium">{row.review_status}</div>
                          {rowNotes.map((n: any) => (
                            <div key={n.id} className="text-[11px] text-teal-800">
                              [{n.reason_type}] {n.note_text}
                            </div>
                          ))}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedRowModal({ row, rowNotes })}
                            className="px-2.5 py-1 text-xs bg-slate-100 border border-slate-300 rounded hover:bg-slate-200 inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Eye className="w-3 h-3" />
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
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-medium">วันที่ปฏิบัติงาน (พ.ศ.)</th>
                <th className="py-2.5 px-3 font-medium">รหัสกะ</th>
                <th className="py-2.5 px-3 font-medium">ชื่อกะ</th>
                <th className="py-2.5 px-3 font-medium">เวลาเริ่ม–สิ้นสุด</th>
                <th className="py-2.5 px-3 font-medium">อนุโลมสาย (Grace)</th>
                <th className="py-2.5 px-3 font-medium">Cutoff NO_SCAN</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {shiftsData.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-3">
                    <span className="font-medium text-slate-900">{formatThaiDate(s.work_date)}</span>{' '}
                    <span className="font-mono text-slate-500">({s.work_date})</span>
                  </td>
                  <td className="py-2.5 px-3 font-mono font-semibold">{s.snapshot_shift_code}</td>
                  <td className="py-2.5 px-3 font-medium">{s.snapshot_shift_name}</td>
                  <td className="py-2.5 px-3 font-mono tabular-nums">
                    {s.snapshot_start_time} – {s.snapshot_end_time} น.
                  </td>
                  <td className="py-2.5 px-3 tabular-nums">{s.snapshot_grace_minutes} นาที</td>
                  <td className="py-2.5 px-3 font-mono tabular-nums">{s.snapshot_cutoff_time} น.</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-medium">เวลาสแกน (พ.ศ. · Asia/Bangkok)</th>
                <th className="py-2.5 px-3 font-medium">หมายเลขเครื่อง</th>
                <th className="py-2.5 px-3 font-medium">รหัสลายนิ้วมือ (enrollNumber)</th>
                <th className="py-2.5 px-3 font-medium">โหมดเข้า/ออก (inOutMode)</th>
                <th className="py-2.5 px-3 font-medium">verifyMode / workCode</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rawScansData.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-3">
                    <div className="font-medium text-slate-900">
                      {formatThaiDateTime(r.canonical_bkk_time)}
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                      {r.canonical_bkk_time}
                    </div>
                  </td>
                  <td className="py-2.5 px-3 font-mono tabular-nums">เครื่อง #{r.machine_no}</td>
                  <td className="py-2.5 px-3 font-mono tabular-nums">{r.enroll_number}</td>
                  <td className="py-2.5 px-3 font-mono">
                    {r.in_out_mode === 0 ? '0 · สแกนเข้า (Check-In)' : '1 · สแกนออก (Check-Out)'}
                  </td>
                  <td className="py-2.5 px-3 font-mono tabular-nums">
                    verify={r.verify_mode} · work={r.work_code}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Shift & Raw Scan Evidence Modal */}
      <SharedModal
        open={Boolean(selectedRowModal)}
        onClose={() => setSelectedRowModal(null)}
        kickerText="หลักฐานการคำนวณเวลาปฏิบัติงานส่วนบุคคล"
        title={
          selectedRowModal
            ? `วันที่ ${formatThaiDate(selectedRowModal.row.work_date)} · ${selectedRowModal.row.shift_name}`
            : ''
        }
        subtitle={`รหัสบุคลากร: ${user.approvedPersonId} · Rule Version: ${selectedRowModal?.row?.rule_version || 'v2.1.0-tz-bkk'}`}
      >
        {selectedRowModal && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-slate-50 p-3.5 rounded-lg border border-slate-200">
              <div>
                <div className="text-slate-500">เวลาเริ่ม–สิ้นสุดตามตารางเวร</div>
                <div className="font-mono font-semibold text-slate-900 mt-0.5">
                  {selectedRowModal.row.scheduled_start} ถึง {selectedRowModal.row.scheduled_end}
                </div>
              </div>
              <div>
                <div className="text-slate-500">สถานะการลงเวลา / นาทีสาย</div>
                <div className="mt-0.5 flex items-center gap-2">
                  <AttendanceStatusText
                    status={selectedRowModal.row.status}
                    secondaryFlags={selectedRowModal.row.secondary_flags}
                  />
                  <span className="font-mono font-bold text-amber-800">
                    ({selectedRowModal.row.late_minutes} นาที)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-slate-500">หลักฐานสแกนเข้า (Raw Scan In)</div>
                <div className="font-mono text-slate-900 mt-0.5">
                  {selectedRowModal.row.check_in_time || 'ไม่พบสแกนเข้า'} (Scan ID:{' '}
                  {selectedRowModal.row.check_in_raw_scan_id || '-'})
                </div>
              </div>
              <div>
                <div className="text-slate-500">หลักฐานสแกนออก (Raw Scan Out)</div>
                <div className="font-mono text-slate-900 mt-0.5">
                  {selectedRowModal.row.check_out_time || 'ไม่พบสแกนออก'} (Scan ID:{' '}
                  {selectedRowModal.row.check_out_raw_scan_id || '-'})
                </div>
              </div>
            </div>

            {selectedRowModal.rowNotes?.length > 0 && (
              <div className="space-y-1.5">
                <div className="font-semibold text-slate-900">หมายเหตุจากเจ้าหน้าที่ HR:</div>
                {selectedRowModal.rowNotes.map((n: any) => (
                  <div
                    key={n.id}
                    className="p-2.5 bg-teal-50/70 border border-teal-200 rounded-lg text-teal-950"
                  >
                    <span className="font-semibold">[{n.reason_type}]</span> {n.note_text} (บันทึกโดย{' '}
                    {n.created_by})
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </SharedModal>
    </div>
  );
}
