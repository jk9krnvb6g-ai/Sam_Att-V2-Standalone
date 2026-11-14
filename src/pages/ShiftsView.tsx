import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SharedModal,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { formatThaiDate, formatThaiDateTime } from '../utils/thaiFormat.ts';

export function ShiftsView() {
  const [shifts, setShifts] = useState<any[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [cancellationLogs, setCancellationLogs] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // New Shift Type state
  const [shiftCode, setShiftCode] = useState('');
  const [shiftName, setShiftName] = useState('');
  const [shiftCategory, setShiftCategory] = useState('OFFICIAL');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('16:00');
  const [graceMinutes, setGraceMinutes] = useState(15);
  const [cutoffTime, setCutoffTime] = useState('10:30');

  // New Shift Assignment state
  const [assignPersonId, setAssignPersonId] = useState('SAM-P001');
  const [assignShiftId, setAssignShiftId] = useState(1);
  const [assignDate, setAssignDate] = useState('2026-11-13');

  // Cancel modal state
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState('ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน (บันทึก Audit)');

  // Sorting & Pagination for Assigned Shifts
  const [sortKey, setSortKey] = useState('work_date');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [shRes, saRes, pRes] = await Promise.all([
        apiRequest('/shifts'),
        apiRequest('/shift-assignments?dateFrom=2026-11-01&dateTo=2026-11-30'),
        apiRequest('/personnel'),
      ]);
      setShifts(shRes.items || []);
      setAssignments(saRes.items || []);
      setCancellationLogs(saRes.cancellationLogs || []);
      setPersonnel(pRes.items || []);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลกะและตารางเวรได้' });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('DESC');
    }
    setPage(1);
  }

  async function handleCreateShift(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
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
      setNotice('สร้างประเภทกะใหม่สำเร็จ');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleAssignShift(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/shift-assignments', {
        method: 'POST',
        body: JSON.stringify({
          personId: assignPersonId,
          shiftId: Number(assignShiftId),
          workDate: assignDate,
        }),
      });
      setNotice(
        `มอบหมายตารางเวรให้ ${assignPersonId} วันที่ ${formatThaiDate(assignDate)} สำเร็จ (พร้อม Snapshot กฎกะ)`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

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
      setNotice(`ยกเลิกตารางเวร #${cancelTarget.id} แบบ Soft Cancel และบันทึก Audit เรียบร้อยแล้ว`);
      setCancelTarget(null);
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  const sortedAssignments = [...assignments].sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    return sortDir === 'ASC'
      ? String(valA || '').localeCompare(String(valB || ''))
      : String(valB || '').localeCompare(String(valA || ''));
  });

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedAssignments.length) : pageSize;
  const pagedAssignments = sortedAssignments.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <div className="border-b border-slate-200 pb-4">
        <h2 className="text-lg font-bold text-slate-900">
          ตารางกะและการหมุนเวียน (Shifts & Shift Assignments)
        </h2>
        <p className="text-xs text-slate-600 mt-0.5">
          รองรับกะเช้า/บ่าย/ดึก/ราชการ/กะข้ามเที่ยงคืน · เก็บ Snapshot กฎกะ ณ เวลามอบหมาย · ยกเลิกเวรแบบ Soft Cancel พร้อม Audit
        </p>
      </div>

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* Forms: Create Shift & Assign Shift */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleCreateShift}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs"
        >
          <h3 className="text-sm font-semibold text-slate-900">1. เพิ่มนิยามประเภทกะใหม่</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">รหัสกะ (Shift Code)</label>
              <input
                type="text"
                required
                value={shiftCode}
                onChange={(e) => setShiftCode(e.target.value)}
                placeholder="เช่น ER-2008"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">ชื่อกะ</label>
              <input
                type="text"
                required
                value={shiftName}
                onChange={(e) => setShiftName(e.target.value)}
                placeholder="เช่น เวรฉุกเฉินดึกข้ามวัน"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">เวลาเริ่ม (HH:mm)</label>
              <input
                type="time"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">เวลาสิ้นสุด (HH:mm)</label>
              <input
                type="time"
                required
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Grace Period (นาที)</label>
              <input
                type="number"
                min={0}
                max={120}
                value={graceMinutes}
                onChange={(e) => setGraceMinutes(Number(e.target.value))}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">เวลา Cutoff ตัดสิน NO_SCAN</label>
              <input
                type="time"
                required
                value={cutoffTime}
                onChange={(e) => setCutoffTime(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
          </div>
          <button
            type="submit"
            className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>บันทึกประเภทกะ</span>
          </button>
        </form>

        <form
          onSubmit={handleAssignShift}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs"
        >
          <h3 className="text-sm font-semibold text-slate-900">
            2. มอบหมายเวรรายบุคคล (Shift Assignment)
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">เลือกบุคลากร</label>
              <select
                value={assignPersonId}
                onChange={(e) => setAssignPersonId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                {personnel.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {p.person_id} · {p.full_name} ({p.department_name})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-600 mb-1">เลือกกะปฏิบัติงาน</label>
                <select
                  value={assignShiftId}
                  onChange={(e) => setAssignShiftId(Number(e.target.value))}
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
                >
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.shift_code} · {s.shift_name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-600 mb-1">วันที่ปฏิบัติงาน</label>
                <input
                  type="date"
                  value={assignDate}
                  onChange={(e) => setAssignDate(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono tabular-nums"
                />
              </div>
            </div>
          </div>
          <button
            type="submit"
            className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 flex items-center gap-1.5 whitespace-nowrap"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>มอบหมายตารางเวร</span>
          </button>
        </form>
      </div>

      {/* Shift Definitions Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60">
          <h3 className="text-sm font-semibold text-slate-900">นิยามประเภทกะทั้งหมด ({shifts.length})</h3>
        </div>
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <th className="py-2.5 px-3 font-semibold">รหัสกะ</th>
              <th className="py-2.5 px-3 font-semibold">ชื่อกะ</th>
              <th className="py-2.5 px-3 font-semibold">เวลาเริ่ม–สิ้นสุด</th>
              <th className="py-2.5 px-3 font-semibold">Grace Period</th>
              <th className="py-2.5 px-3 font-semibold">Cutoff NO_SCAN</th>
              <th className="py-2.5 px-3 font-semibold">กะข้ามเที่ยงคืน</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {shifts.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="py-2.5 px-3 font-mono font-semibold">{s.shift_code}</td>
                <td className="py-2.5 px-3 font-medium">{s.shift_name}</td>
                <td className="py-2.5 px-3 font-mono tabular-nums">
                  {s.start_time} – {s.end_time}
                </td>
                <td className="py-2.5 px-3 tabular-nums">{s.grace_minutes} นาที</td>
                <td className="py-2.5 px-3 font-mono tabular-nums">{s.cutoff_time}</td>
                <td className="py-2.5 px-3">
                  {Number(s.is_cross_midnight) === 1 ? 'ข้ามเที่ยงคืน (Cross-Midnight)' : 'ภายในวันเดียว'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Assigned Shifts Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60">
          <h3 className="text-sm font-semibold text-slate-900">
            รายการมอบหมายเวรรายบุคคล ({assignments.length})
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <SortableHeader
                  label="วันที่เวร (พ.ศ.)"
                  sortKey="work_date"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="รหัส · ชื่อบุคลากร"
                  sortKey="person_id"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="กะ (Snapshot)"
                  sortKey="snapshot_shift_name"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th className="py-2.5 px-3 font-semibold">เวลาเริ่ม–ออก</th>
                <SortableHeader
                  label="สถานะ"
                  sortKey="status"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th className="py-2.5 px-3 font-semibold text-right">การจัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    กำลังโหลดตารางเวร...
                  </td>
                </tr>
              ) : (
                pagedAssignments.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono tabular-nums font-medium">
                      {formatThaiDate(a.work_date)}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="font-mono font-semibold">{a.person_id}</span> · {a.full_name}
                    </td>
                    <td className="py-2.5 px-3">{a.snapshot_shift_name}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">
                      {a.snapshot_start_time} – {a.snapshot_end_time}
                    </td>
                    <td className="py-2.5 px-3 font-semibold">
                      <span className={a.status === 'ACTIVE' ? 'text-emerald-700' : 'text-red-700'}>
                        {a.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right">
                      {a.status === 'ACTIVE' && (
                        <button
                          type="button"
                          onClick={() => setCancelTarget(a)}
                          className="px-2.5 py-1 text-xs text-red-700 border border-red-200 rounded-lg hover:bg-red-50 inline-flex items-center gap-1 whitespace-nowrap"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>ยกเลิกเวร (Audit)</span>
                        </button>
                      )}
                    </td>
                  </tr>
                ))
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

      {cancellationLogs.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60">
            <h3 className="text-sm font-semibold text-slate-900">
              ประวัติการยกเลิกตารางเวร (shift_cancellation_logs)
            </h3>
          </div>
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2 px-3 font-semibold">เวลาที่ยกเลิก (พ.ศ.)</th>
                <th className="py-2 px-3 font-semibold">บุคลากร</th>
                <th className="py-2 px-3 font-semibold">วันที่เวร / กะ</th>
                <th className="py-2 px-3 font-semibold">เหตุผล</th>
                <th className="py-2 px-3 font-semibold">ผู้ยกเลิก</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {cancellationLogs.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 px-3 font-mono tabular-nums">{formatThaiDateTime(c.cancelled_at)}</td>
                  <td className="py-2 px-3">{c.person_id} · {c.full_name}</td>
                  <td className="py-2 px-3 font-mono">
                    {formatThaiDate(c.work_date)} ({c.shift_code})
                  </td>
                  <td className="py-2 px-3">{c.cancel_reason}</td>
                  <td className="py-2 px-3 font-mono">{c.cancelled_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <SharedModal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        title={`ยืนยันการยกเลิกตารางเวร (Soft Cancel) #${cancelTarget?.id || ''}`}
        maxWidthClass="max-w-lg"
      >
        {cancelTarget && (
          <form onSubmit={handleConfirmCancelAssignment} className="space-y-4 text-xs">
            <div className="p-3 bg-slate-50 rounded-lg border border-slate-200 space-y-1">
              <div className="font-semibold text-slate-900">
                {cancelTarget.person_id} · {cancelTarget.full_name}
              </div>
              <div className="text-slate-600">
                วันที่เวร: {formatThaiDate(cancelTarget.work_date)} · กะ: {cancelTarget.snapshot_shift_name}
              </div>
            </div>
            <div>
              <label className="block text-slate-700 font-semibold mb-1">
                ระบุเหตุผลการยกเลิกเวร (บังคับระบุเพื่อบันทึก Audit Log)
              </label>
              <textarea
                rows={3}
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded-lg"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="submit"
                className="px-4 py-2 text-xs font-semibold bg-red-700 text-white rounded-lg hover:bg-red-800"
              >
                ยืนยันยกเลิกเวรและบันทึก Audit
              </button>
            </div>
          </form>
        )}
      </SharedModal>
    </div>
  );
}
