import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Download, Eye, Send, FileText } from 'lucide-react';
import { apiRequest, downloadLatenessCsv, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PeriodFilterBar,
  SortableHeader,
  TablePaginationBar,
  SharedModal,
  NotificationBanner,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

export function ReportsView({ mode }: { mode: 'reports' | 'hosofficePush' }) {
  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState('2026-11-13');
  const [monthValue, setMonthValue] = useState('2026-11');
  const [yearValue, setYearValue] = useState('2026');
  const [customFrom, setCustomFrom] = useState('2026-11-01');
  const [customTo, setCustomTo] = useState('2026-11-30');
  const [personnelType, setPersonnelType] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [reportData, setReportData] = useState<any>(null);
  const [pushHistoryData, setPushHistoryData] = useState<any>(null);
  const [previewBatch, setPreviewBatch] = useState<any>(null);
  const [inspectPayloadModal, setInspectPayloadModal] = useState<any | null>(null);

  // Sorting & Pagination for Ranking Table
  const [sortKey, setSortKey] = useState('totalLateMinutes');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const effectiveRange = useMemo(
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
      if (mode === 'reports') {
        const qs = new URLSearchParams({
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
          sortOrder: sortDir === 'ASC' ? 'asc' : 'desc',
          ...(personnelType ? { personnelType } : {}),
        });
        const res = await apiRequest(`/reports/lateness?${qs.toString()}`);
        setReportData(res);
      } else {
        const res = await apiRequest('/hosoffice/push-history');
        setPushHistoryData(res);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลรายงานได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [mode, effectiveRange.dateFrom, effectiveRange.dateTo, personnelType, sortDir]);

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

  async function handleExportCsv() {
    setError(null);
    try {
      await downloadLatenessCsv({
        dateFrom: effectiveRange.dateFrom,
        dateTo: effectiveRange.dateTo,
        personnelType: personnelType || undefined,
      });
      setNotice('ส่งออกไฟล์ CSV สำเร็จ (พร้อมระบบป้องกัน CSV Formula Injection)');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handlePreviewHosOfficePush() {
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest('/hosoffice/push/preview', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
        }),
      });
      setPreviewBatch(res);
      setNotice(
        `สร้าง Preview (DRY_RUN) สำเร็จ: พร้อมส่ง ${res.validCount} รายการ · ไม่ผ่านเกณฑ์ ${res.invalidCount} รายการ (ไม่มีการเขียนลงฐานข้อมูล HOSOffice)`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleLiveHosOfficePush() {
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/hosoffice/push', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
          idempotencyKey:
            previewBatch?.idempotencyKey ||
            `LIVE-${effectiveRange.dateFrom}-${effectiveRange.dateTo}`,
        }),
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  if (mode === 'hosofficePush') {
    return (
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              ส่งข้อมูลไป HOSOffice (HOSOffice Push & Dry-Run Preview)
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              โหมดเริ่มต้นเป็น DRY_RUN Preview เพื่อความปลอดภัย · ปุ่มส่งข้อมูลจริง (Live Push) ถูกล็อกด้วย Feature Flag จนกว่าเจ้าของระบบจะอนุมัติ Schema ปลายทาง
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handlePreviewHosOfficePush}
              className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Eye className="w-3.5 h-3.5" />
              <span>1. ตรวจสอบและสร้าง Preview (DRY_RUN)</span>
            </button>
            <button
              type="button"
              onClick={handleLiveHosOfficePush}
              className="px-3.5 py-2 text-xs font-semibold bg-amber-700 text-white rounded-lg hover:bg-amber-800 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <Send className="w-3.5 h-3.5" />
              <span>
                2. ส่งข้อมูลจริง (Live Push:{' '}
                {pushHistoryData?.livePushEnabled ? 'ENABLED' : 'LOCKED_BY_FLAG'})
              </span>
            </button>
          </div>
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

        <ErrorBanner error={error} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        {previewBatch && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 shadow-2xs">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  ตัวอย่าง Payload พร้อมส่ง ({previewBatch.validCount} รายการ)
                </h3>
                <button
                  type="button"
                  onClick={() => setInspectPayloadModal(previewBatch)}
                  className="text-xs font-medium text-teal-800 hover:underline inline-flex items-center gap-1"
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>ขยายดูเต็มจอ</span>
                </button>
              </div>
              <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg text-[11px] font-mono overflow-x-auto max-h-64">
                {JSON.stringify(previewBatch.validItems, null, 2)}
              </pre>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 shadow-2xs">
              <h3 className="text-sm font-semibold text-red-800">
                รายการที่ไม่ผ่านเกณฑ์ Validation ก่อนส่ง ({previewBatch.invalidCount} รายการ)
              </h3>
              <div className="divide-y divide-slate-200 text-xs max-h-64 overflow-y-auto">
                {previewBatch.invalidItems?.map((inv: any) => (
                  <div key={inv.attendanceId} className="py-2">
                    <div className="font-semibold text-slate-900">
                      #{inv.attendanceId} · {inv.personId} · {inv.fullName} ({formatThaiDate(inv.workDate)})
                    </div>
                    <div className="text-red-700">{inv.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60">
            <h3 className="text-sm font-semibold text-slate-900">
              ประวัติการทำ Preview และ Push (push_history)
            </h3>
          </div>
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-semibold">Idempotency Key</th>
                <th className="py-2.5 px-3 font-semibold">โหมด</th>
                <th className="py-2.5 px-3 font-semibold">ช่วงวันที่ (พ.ศ.)</th>
                <th className="py-2.5 px-3 font-semibold text-right">ทั้งหมด / ผ่าน / ไม่ผ่าน</th>
                <th className="py-2.5 px-3 font-semibold">สถานะ</th>
                <th className="py-2.5 px-3 font-semibold">ผู้ดำเนินการ · เวลา</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {pushHistoryData?.items?.map((p: any) => (
                <tr key={p.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-3 font-mono font-semibold">{p.idempotency_key}</td>
                  <td className="py-2.5 px-3 font-mono">{p.push_mode}</td>
                  <td className="py-2.5 px-3 font-mono tabular-nums">
                    {formatThaiDate(p.date_from)} ถึง {formatThaiDate(p.date_to)}
                  </td>
                  <td className="py-2.5 px-3 text-right font-mono tabular-nums">
                    {p.total_records} / <span className="text-emerald-700">{p.valid_records}</span> /{' '}
                    <span className="text-red-700">{p.invalid_records}</span>
                  </td>
                  <td className="py-2.5 px-3 font-semibold text-teal-800">{p.status}</td>
                  <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                    {p.initiated_by} · {formatThaiDateTime(p.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <SharedModal
          open={Boolean(inspectPayloadModal)}
          onClose={() => setInspectPayloadModal(null)}
          title={`รายละเอียด HOSOffice Dry-Run Payload (${inspectPayloadModal?.idempotencyKey || ''})`}
          maxWidthClass="max-w-3xl"
        >
          {inspectPayloadModal && (
            <div className="space-y-3 text-xs">
              <pre className="p-4 bg-slate-900 text-slate-100 rounded-xl font-mono text-xs overflow-x-auto max-h-96">
                {JSON.stringify(inspectPayloadModal, null, 2)}
              </pre>
            </div>
          )}
        </SharedModal>
      </div>
    );
  }

  const kpi = reportData?.kpi;
  const rawRanking: any[] = reportData?.ranking || [];

  const sortedRanking = [...rawRanking].sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    if (typeof valA === 'number' && typeof valB === 'number') {
      return sortDir === 'ASC' ? valA - valB : valB - valA;
    }
    return sortDir === 'ASC'
      ? String(valA || '').localeCompare(String(valB || ''))
      : String(valB || '').localeCompare(String(valA || ''));
  });

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedRanking.length) : pageSize;
  const pagedRanking = sortedRanking.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            รายงานและจัดอันดับการมาสาย (Reports & Lateness Ranking)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            ใช้ชุดตัวกรองและสูตรคำนวณเดียวกับ Dashboard · แยกจำนวนคนที่สายไม่ซ้ำและจำนวนครั้งที่สาย · รองรับส่งออก CSV ที่ปลอดภัยจาก Formula Injection
          </p>
        </div>

        <button
          type="button"
          onClick={handleExportCsv}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5 whitespace-nowrap w-fit"
        >
          <Download className="w-3.5 h-3.5" />
          <span>ส่งออก CSV (Formula-Safe)</span>
        </button>
      </div>

      <PeriodFilterBar
        mode={periodMode}
        onModeChange={(m) => {
          setPeriodMode(m);
          setPage(1);
        }}
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
          <select
            value={personnelType}
            onChange={(e) => {
              setPersonnelType(e.target.value);
              setPage(1);
            }}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
          >
            <option value="">ทุกประเภทบุคลากร</option>
            <option value="CIVIL_SERVANT">ข้าราชการ</option>
            <option value="PUBLIC_HEALTH_EMP">พนักงานกระทรวงสาธารณสุข (พกส.)</option>
            <option value="TEMP_EMPLOYEE">ลูกจ้างชั่วคราว</option>
          </select>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {kpi && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
            <div className="text-xs text-slate-500">จำนวนคนที่สายไม่ซ้ำ (late_people)</div>
            <div className="mt-1 text-2xl font-bold text-amber-700 tabular-nums">{kpi.latePeople} คน</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
            <div className="text-xs text-slate-500">จำนวนครั้งที่สายรวม (late_occurrences)</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{kpi.lateOccurrences} ครั้ง</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
            <div className="text-xs text-slate-500">นาทีสายรวมทั้งหมด</div>
            <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">{kpi.totalLateMinutes} นาที</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-2xs">
            <div className="text-xs text-slate-500">ค่าเฉลี่ยนาทีสายต่อครั้ง</div>
            <div className="mt-1 text-2xl font-bold text-teal-800 tabular-nums">
              {kpi.avgLateMinutesPerOccurrence} นาที/ครั้ง
            </div>
          </div>
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-semibold">อันดับ</th>
                <SortableHeader
                  label="PERSON_ID · ชื่อ-สกุล"
                  sortKey="fullName"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="หน่วยงาน · ประเภท"
                  sortKey="departmentName"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
                <SortableHeader
                  label="เวรทั้งหมด"
                  sortKey="totalShifts"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="จำนวนครั้งที่สาย"
                  sortKey="lateOccurrences"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="นาทีสายรวม"
                  sortKey="totalLateMinutes"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="เฉลี่ย (นาที/ครั้ง)"
                  sortKey="avgLateMinutesPerOccurrence"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
                <SortableHeader
                  label="NO_SCAN"
                  sortKey="noScanCount"
                  activeSortKey={sortKey}
                  sortDir={sortDir}
                  onSort={handleSort}
                  align="right"
                />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500">
                    กำลังประมวลผลรายงาน...
                  </td>
                </tr>
              ) : (
                pagedRanking.map((r: any, idx: number) => (
                  <tr key={r.personId} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono tabular-nums font-semibold">
                      #{(page - 1) * numericSize + idx + 1}
                    </td>
                    <td className="py-2.5 px-3">
                      <span className="font-mono font-semibold">{r.personId}</span> · {r.fullName}
                    </td>
                    <td className="py-2.5 px-3 text-slate-600">
                      {r.departmentName} · {r.personnelTypeName}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{r.totalShifts}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-amber-700">
                      {r.lateOccurrences}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums font-bold text-slate-900">
                      {r.totalLateMinutes}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">
                      {r.avgLateMinutesPerOccurrence}
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums text-red-700">
                      {r.noScanCount} / {r.missingCheckoutCount}
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
          totalItems={sortedRanking.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
}
