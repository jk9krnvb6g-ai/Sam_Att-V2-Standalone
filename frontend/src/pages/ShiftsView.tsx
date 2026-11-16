/**
 * ============================================================================
 * หน้าบริหารจัดการแม่แบบกะทำงานและตารางเวรปฏิบัติงาน (Shift Templates & Assignments)
 * ไฟล์: frontend/src/pages/ShiftsView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงและสร้างแม่แบบกะทำงาน (เวรราชการ, เวรเช้า, เวรบ่าย, เวรดึกข้ามเที่ยงคืน)
 * 2. มอบหมายตารางเวรรายบุคคล พร้อมจัดเก็บค่า Snapshot เวลาเริ่ม-เลิกงานและนาทีผ่อนผันประจำเวร
 * 3. ยกเลิกตารางเวรแบบบันทึกประวัติ (Soft Cancel) พร้อมระบุเหตุผลเพื่อความโปร่งใสในการตรวจสอบ
 */
import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Trash2, Clock, Moon, Sun } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SharedModal,
  TableEmptyState,
  RequiredMark,
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
  const [cancelReason, setCancelReason] = useState(
    'ยกเลิกตารางเวรตามคำสั่งหัวหน้ากลุ่มงาน (บันทึกประวัติการตรวจสอบ)'
  );

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
        setError({ message: 'ไม่สามารถดึงข้อมูลกะทำงานและตารางเวรได้' });
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
      setNotice('สร้างแม่แบบกะปฏิบัติงานใหม่เรียบร้อยแล้ว');
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
        `มอบหมายตารางเวรให้รหัส ${assignPersonId} วันที่ ${formatThaiDate(assignDate)} เรียบร้อยแล้ว`
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
      setNotice(`ยกเลิกตารางเวร #${cancelTarget.id} และบันทึกเหตุผลในระบบตรวจสอบเรียบร้อยแล้ว`);
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
      ? String(valA || '').localeCompare(String(valB || ''), 'th')
      : String(valB || '').localeCompare(String(valA || ''), 'th');
  });

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedAssignments.length) : pageSize;
  const pagedAssignments = sortedAssignments.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <PageHeader
        category="การบริหารเวลาและบุคลากร"
        title="ตารางเวรและแม่แบบกะทำงาน"
        subtitle="กำหนดเวลามาตรฐาน 24 ชั่วโมง เวลาผ่อนผันการมาสาย และเวลาตัดรอบสแกน (รองรับเวรเช้า บ่าย ดึก และเวรข้ามเที่ยงคืน)"
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* 1. Shift Templates Gallery */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[19px] font-bold text-[#273244]">
            แม่แบบกะทำงานที่เปิดใช้งาน ({shifts.length} รูปแบบ)
          </h2>
          <span className="text-[13.5px] text-[#596579]">
            รูปแบบเวลา 24 ชั่วโมง (ระบบบันทึกค่า Snapshot ณ วันที่มอบหมายเวร)
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {shifts.map((s) => {
            const isCross = Number(s.is_cross_midnight) === 1;
            return (
              <div
                key={s.id}
                className="ent-card p-5 flex flex-col justify-between space-y-4 hover:border-[#B45363]/50 transition-colors"
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[13px] font-bold text-[#9F3F50] bg-[#FFF1F3] px-2.5 py-1 rounded-md border border-[#F9E8EB]">
                      {s.shift_code}
                    </span>
                    <span className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-[#596579]">
                      {isCross ? (
                        <>
                          <Moon className="w-3.5 h-3.5 text-[#2563EB]" />
                          <span className="text-[#2563EB]">กะข้ามเที่ยงคืน (+1 วัน)</span>
                        </>
                      ) : (
                        <>
                          <Sun className="w-3.5 h-3.5 text-[#047857]" />
                          <span>ภายในวันเดียว</span>
                        </>
                      )}
                    </span>
                  </div>
                  <h3 className="text-[16.5px] font-bold text-[#273244]">{s.shift_name}</h3>
                </div>

                <div className="pt-3 border-t border-[#E7E2E5] space-y-1.5 text-[13.5px]">
                  <div className="flex items-center justify-between">
                    <span className="text-[#596579]">ช่วงเวลาทำงาน:</span>
                    <span className="font-mono font-bold text-[#273244] tabular-nums">
                      {s.start_time} – {s.end_time} น.
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#596579]">เวลาผ่อนผันสาย:</span>
                    <span className="font-mono font-semibold text-[#047857] tabular-nums">
                      {s.grace_minutes} นาที
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#596579]">เวลาตัดรอบขาดสแกน:</span>
                    <span className="font-mono font-semibold text-[#B45309] tabular-nums">
                      {s.cutoff_time} น.
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Forms: Assign Shift & Create Shift Template */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Form A: Assign Shift to Personnel */}
        <form
          onSubmit={handleAssignShift}
          className="ent-card p-6 space-y-5 flex flex-col justify-between"
        >
          <div className="space-y-4">
            <div className="border-b border-[#E7E2E5] pb-3">
              <h2 className="text-[18px] font-bold text-[#273244]">
                1. มอบหมายตารางเวรรายบุคคล
              </h2>
              <p className="text-[13.5px] text-[#596579] mt-0.5">
                เลือกบุคลากร กะทำงาน และวันที่ปฏิบัติงาน (ระบบจะจัดเก็บ Snapshot เวลาเริ่ม–เลิกงานไว้กับเวรนั้นโดยตรง)
              </p>
            </div>

            <div>
              <label htmlFor="assign-person" className="ent-label">
                เลือกบุคลากร <RequiredMark />
              </label>
              <select
                id="assign-person"
                value={assignPersonId}
                onChange={(e) => setAssignPersonId(e.target.value)}
                className="ent-input w-full"
              >
                {personnel.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {p.full_name} ({p.person_id} · {p.department_name})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="assign-shift" className="ent-label">
                  เลือกกะปฏิบัติงาน <RequiredMark />
                </label>
                <select
                  id="assign-shift"
                  value={assignShiftId}
                  onChange={(e) => setAssignShiftId(Number(e.target.value))}
                  className="ent-input w-full"
                >
                  {shifts.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.shift_name} ({s.start_time}–{s.end_time} น.)
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="assign-date" className="ent-label">
                  วันที่ปฏิบัติงาน <RequiredMark />
                </label>
                <input
                  id="assign-date"
                  type="date"
                  value={assignDate}
                  onChange={(e) => setAssignDate(e.target.value)}
                  className="ent-input w-full font-mono tabular-nums"
                />
              </div>
            </div>
          </div>

          <button type="submit" className="ent-btn-primary w-full sm:w-fit">
            <Plus className="w-4 h-4" />
            <span>บันทึกการมอบหมายตารางเวร</span>
          </button>
        </form>

        {/* Form B: Create New Shift Template */}
        <form onSubmit={handleCreateShift} className="ent-card p-4 sm:p-6 space-y-5">
          <div className="border-b border-[#E7E2E5] pb-3">
            <h2 className="text-[18px] font-bold text-[#273244]">
              2. เพิ่มแม่แบบกะทำงานใหม่
            </h2>
            <p className="text-[13.5px] text-[#596579] mt-0.5">
              กำหนดเวลาเริ่ม–ออกงาน (หากเวลาสิ้นสุดน้อยกว่าหรือเท่ากับเวลาเริ่ม ระบบจะตั้งเป็นกะข้ามเที่ยงคืนอัตโนมัติ)
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="shift-code" className="ent-label">
                รหัสกะทำงาน <RequiredMark />
              </label>
              <input
                id="shift-code"
                type="text"
                required
                value={shiftCode}
                onChange={(e) => setShiftCode(e.target.value)}
                placeholder="เช่น ER-2008"
                className="ent-input w-full font-mono"
              />
            </div>
            <div>
              <label htmlFor="shift-name" className="ent-label">
                ชื่อกะปฏิบัติงาน <RequiredMark />
              </label>
              <input
                id="shift-name"
                type="text"
                required
                value={shiftName}
                onChange={(e) => setShiftName(e.target.value)}
                placeholder="เช่น เวรฉุกเฉินดึกข้ามวัน"
                className="ent-input w-full"
              />
            </div>
            <div>
              <label htmlFor="shift-start" className="ent-label">
                เวลาเริ่มงาน (24 ชม.) <RequiredMark />
              </label>
              <input
                id="shift-start"
                type="time"
                required
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                className="ent-input w-full font-mono"
              />
            </div>
            <div>
              <label htmlFor="shift-end" className="ent-label">
                เวลาเลิกงาน (24 ชม.) <RequiredMark />
              </label>
              <input
                id="shift-end"
                type="time"
                required
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                className="ent-input w-full font-mono"
              />
            </div>
            <div>
              <label htmlFor="shift-grace" className="ent-label">
                เวลาผ่อนผันสาย (นาที) <RequiredMark />
              </label>
              <input
                id="shift-grace"
                type="number"
                min={0}
                max={120}
                value={graceMinutes}
                onChange={(e) => setGraceMinutes(Number(e.target.value))}
                className="ent-input w-full font-mono"
              />
            </div>
            <div>
              <label htmlFor="shift-cutoff" className="ent-label">
                เวลาตัดรอบขาดสแกน <RequiredMark />
              </label>
              <input
                id="shift-cutoff"
                type="time"
                required
                value={cutoffTime}
                onChange={(e) => setCutoffTime(e.target.value)}
                className="ent-input w-full font-mono"
              />
            </div>
          </div>

          <button type="submit" className="ent-btn-secondary w-full sm:w-fit">
            <Clock className="w-4 h-4 text-[#B45363]" />
            <span>สร้างแม่แบบกะทำงานใหม่</span>
          </button>
        </form>
      </div>

      {/* 3. Assigned Shifts Table */}
      <div className="ent-table-wrapper">
        <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7] flex items-center justify-between">
          <div>
            <h2 className="text-[18px] font-bold text-[#273244]">
              ตารางเวรที่มอบหมายแล้ว ({assignments.length} รายการ)
            </h2>
            <p className="text-[13.5px] text-[#596579]">
              หากต้องการยกเลิกเวร ระบบจะใช้การยกเลิกแบบบันทึกประวัติ (Soft Cancel) เพื่อความโปร่งใสในการตรวจสอบ
            </p>
          </div>
        </div>

        {/* Mobile Card List View (< 768px) */}
        <div className="md:hidden divide-y divide-[#E7E2E5]">
          {loading ? (
            <div className="py-10 text-center text-[14.5px] text-[#596579]">
              กำลังโหลดตารางเวร...
            </div>
          ) : pagedAssignments.length === 0 ? (
            <div className="py-10 px-4 text-center text-[14.5px] text-[#596579]">
              ยังไม่มีรายการมอบหมายตารางเวร
            </div>
          ) : (
            pagedAssignments.map((a) => (
              <div key={a.id} className="p-4 space-y-2.5 bg-white">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-[15.5px] text-[#273244]">{a.full_name}</div>
                    <div className="text-[13px] font-mono text-[#596579]">
                      รหัสบุคลากร: {a.person_id}
                    </div>
                  </div>
                  <span
                    className={`text-[13px] font-bold px-2.5 py-0.5 rounded-md border ${
                      a.status === 'ACTIVE'
                        ? 'text-[#047857] bg-emerald-50 border-emerald-200'
                        : 'text-[#B91C1C] bg-red-50 border-red-200'
                    }`}
                  >
                    {a.status === 'ACTIVE' ? 'ใช้งานปกติ' : 'ยกเลิกแล้ว'}
                  </span>
                </div>
                <div className="p-3 rounded-lg bg-[#FFF9F9] border border-[#E7E2E5] text-[13.5px] space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[#596579]">วันที่ปฏิบัติงาน:</span>
                    <span className="font-mono font-bold text-[#273244]">
                      {formatThaiDate(a.work_date)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#596579]">กะปฏิบัติงาน:</span>
                    <span className="font-semibold text-[#273244]">
                      {a.snapshot_shift_name} ({a.snapshot_shift_code})
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[#596579]">ช่วงเวลาตาม Snapshot:</span>
                    <span className="font-mono text-[#273244]">
                      {a.snapshot_start_time} – {a.snapshot_end_time} น.
                    </span>
                  </div>
                </div>
                {a.status === 'ACTIVE' && (
                  <button
                    type="button"
                    onClick={() => setCancelTarget(a)}
                    className="w-full h-10 px-3.5 text-[13.5px] text-[#B91C1C] bg-white border border-red-200 rounded-lg hover:bg-red-50 inline-flex items-center justify-center gap-1.5 font-semibold transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                    <span>ยกเลิกตารางเวร</span>
                  </button>
                )}
              </div>
            ))
          )}
        </div>

        {/* Desktop Table View (>= 768px) */}
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
                  label="ชื่อ-นามสกุล · รหัสบุคลากร"
                  sortKey="person_id"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="กะปฏิบัติงานที่มอบหมาย"
                  sortKey="snapshot_shift_name"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th className="py-3.5 px-4 text-[13.5px] font-semibold">ช่วงเวลาตาม Snapshot</th>
                <SortableHeader
                  label="สถานะตารางเวร"
                  sortKey="status"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <th className="py-3.5 px-4 text-[13.5px] font-semibold text-right">การจัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E2E5]">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-12 text-center text-[14.5px] text-[#596579]">
                    กำลังโหลดตารางเวร...
                  </td>
                </tr>
              ) : pagedAssignments.length === 0 ? (
                <TableEmptyState colSpan={6} title="ยังไม่มีรายการมอบหมายตารางเวร" />
              ) : (
                pagedAssignments.map((a) => (
                  <tr key={a.id} className="hover:bg-[#FFF9F9] transition-colors">
                    <td className="py-4 px-4 font-mono tabular-nums font-semibold text-[#273244]">
                      {formatThaiDate(a.work_date)}
                    </td>
                    <td className="py-4 px-4">
                      <div className="font-bold text-[15px] text-[#273244]">{a.full_name}</div>
                      <div className="text-[12.5px] font-mono text-[#596579] mt-0.5">
                        รหัสบุคลากร: {a.person_id}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <div className="font-semibold text-[#273244]">{a.snapshot_shift_name}</div>
                      <div className="text-[12.5px] font-mono text-[#596579]">
                        รหัสกะ: {a.snapshot_shift_code}
                      </div>
                    </td>
                    <td className="py-4 px-4 font-mono tabular-nums text-[#273244]">
                      {a.snapshot_start_time} – {a.snapshot_end_time} น.
                    </td>
                    <td className="py-4 px-4 font-semibold">
                      <span className={a.status === 'ACTIVE' ? 'text-[#047857]' : 'text-[#B91C1C]'}>
                        {a.status === 'ACTIVE' ? 'ใช้งานปกติ' : 'ยกเลิกแล้ว'}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-right">
                      {a.status === 'ACTIVE' && (
                        <button
                          type="button"
                          onClick={() => setCancelTarget(a)}
                          className="h-9 px-3.5 text-[13.5px] text-[#B91C1C] bg-white border border-red-200 rounded-lg hover:bg-red-50 inline-flex items-center gap-1.5 whitespace-nowrap font-semibold transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                          <span>ยกเลิกตารางเวร</span>
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

      {/* 4. Cancellation History Table */}
      {cancellationLogs.length > 0 && (
        <div className="ent-table-wrapper">
          <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7]">
            <h2 className="text-[18px] font-bold text-[#273244]">
              ประวัติการยกเลิกตารางเวรย้อนหลัง
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">วันและเวลาที่ยกเลิก</th>
                  <th className="py-3.5 px-5 font-semibold">บุคลากร</th>
                  <th className="py-3.5 px-5 font-semibold">วันที่เวร / กะทำงาน</th>
                  <th className="py-3.5 px-5 font-semibold">เหตุผลการยกเลิก</th>
                  <th className="py-3.5 px-5 font-semibold">ผู้ดำเนินการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {cancellationLogs.map((c) => (
                  <tr key={c.id} className="hover:bg-[#FFF9F9]">
                    <td className="py-3.5 px-5 font-mono tabular-nums">{formatThaiDateTime(c.cancelled_at)}</td>
                    <td className="py-3.5 px-5 font-semibold text-[#273244]">
                      {c.full_name} ({c.person_id})
                    </td>
                    <td className="py-3.5 px-5 font-mono">
                      {formatThaiDate(c.work_date)} ({c.shift_code})
                    </td>
                    <td className="py-3.5 px-5 text-[#273244]">{c.cancel_reason}</td>
                    <td className="py-3.5 px-5 font-mono text-[#596579]">{c.cancelled_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Soft-Cancel Confirmation Modal */}
      <SharedModal
        open={Boolean(cancelTarget)}
        onClose={() => setCancelTarget(null)}
        kickerText="การยกเลิกตารางเวรพร้อมบันทึกประวัติการตรวจสอบ"
        title={`ยืนยันการยกเลิกตารางเวร #${cancelTarget?.id || ''}`}
        maxWidthClass="max-w-lg"
      >
        {cancelTarget && (
          <form onSubmit={handleConfirmCancelAssignment} className="space-y-4 text-[14px]">
            <div className="p-4 bg-[#FFF9F9] rounded-xl border border-[#E7E2E5] space-y-1">
              <div className="font-bold text-[15px] text-[#273244]">
                {cancelTarget.full_name} ({cancelTarget.person_id})
              </div>
              <div className="text-[#596579]">
                วันที่เวร: {formatThaiDate(cancelTarget.work_date)} · กะ: {cancelTarget.snapshot_shift_name}
              </div>
            </div>
            <div>
              <label className="ent-label">
                ระบุเหตุผลการยกเลิกเวร <RequiredMark />
              </label>
              <textarea
                rows={3}
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full p-3.5 border border-[#D5CDD2] rounded-lg text-[14px] text-[#273244]"
              />
            </div>
            <div className="flex justify-end gap-2.5 pt-3 border-t border-[#E7E2E5]">
              <button
                type="submit"
                className="w-full sm:w-auto h-10.5 px-5 text-[14px] font-semibold bg-[#B91C1C] text-white rounded-lg hover:bg-red-800 transition-colors"
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
