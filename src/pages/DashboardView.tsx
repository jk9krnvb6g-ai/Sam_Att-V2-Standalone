import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, Search, Eye, ArrowRight } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
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
import { type NavViewKey } from '../components/layout/Sidebar.tsx';

type RankTabKey = 'LATE_MINS' | 'LATE_FREQ' | 'ON_TIME' | 'INCOMPLETE';

export function DashboardView({
  onNavigate,
}: {
  onNavigate?: (view: NavViewKey) => void;
}) {
  // Period Filter State (Daily / Monthly / Yearly / Custom)
  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState('2026-11-13');
  const [monthValue, setMonthValue] = useState('2026-11');
  const [yearValue, setYearValue] = useState('2026');
  const [customFrom, setCustomFrom] = useState('2026-11-01');
  const [customTo, setCustomTo] = useState('2026-11-30');

  const [department, setDepartment] = useState('');
  const [personnelType, setPersonnelType] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [data, setData] = useState<any>(null);
  const [attendanceRows, setAttendanceRows] = useState<any[]>([]);

  // Personnel Ranking Tabs, Search, Sort & Pagination
  const [rankTab, setRankTab] = useState<RankTabKey>('LATE_MINS');
  const [rankSearch, setRankSearch] = useState('');
  const [rankSortKey, setRankSortKey] = useState('totalLateMinutes');
  const [rankSortDir, setRankSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [rankPage, setRankPage] = useState(1);
  const [rankPageSize, setRankPageSize] = useState<PageSizeOption>(10);

  // Drill-down Modal State
  const [drillModal, setDrillModal] = useState<{
    title: string;
    subtitle: string;
    rows: any[];
    targetNav?: NavViewKey;
    targetNavLabel?: string;
  } | null>(null);

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

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        dateFrom: resolvedRange.dateFrom,
        dateTo: resolvedRange.dateTo,
        ...(department ? { department } : {}),
        ...(personnelType ? { personnelType } : {}),
      });
      const [summaryRes, attRes] = await Promise.all([
        apiRequest(`/dashboard/summary?${qs.toString()}`),
        apiRequest(`/attendance?${qs.toString()}`),
      ]);
      setData(summaryRes);
      setAttendanceRows(attRes.items || []);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลสรุป Dashboard ได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [resolvedRange.dateFrom, resolvedRange.dateTo, department, personnelType]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const kpi = data?.kpi;
  const telemetry = data?.scannerTelemetry;

  function handleSortRanking(key: string) {
    if (rankSortKey === key) {
      setRankSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setRankSortKey(key);
      setRankSortDir('DESC');
    }
    setRankPage(1);
  }

  const filteredAndSortedRanking = useMemo(() => {
    const rawList: any[] = data?.ranking || [];
    const q = rankSearch.trim().toLowerCase();
    const searched = q
      ? rawList.filter(
          (p) =>
            String(p.personId).toLowerCase().includes(q) ||
            String(p.fullName).toLowerCase().includes(q) ||
            String(p.departmentName).toLowerCase().includes(q)
        )
      : [...rawList];

    searched.sort((a, b) => {
      if (rankTab === 'ON_TIME' && rankSortKey === 'totalLateMinutes') {
        return a.lateOccurrences - b.lateOccurrences || b.totalShifts - a.totalShifts;
      }
      if (rankTab === 'LATE_FREQ' && rankSortKey === 'totalLateMinutes') {
        return b.lateOccurrences - a.lateOccurrences || b.totalLateMinutes - a.totalLateMinutes;
      }
      if (rankTab === 'INCOMPLETE' && rankSortKey === 'totalLateMinutes') {
        const incA = Number(a.noScanCount || 0) + Number(a.missingCheckoutCount || 0);
        const incB = Number(b.noScanCount || 0) + Number(b.missingCheckoutCount || 0);
        return incB - incA;
      }

      const valA = a[rankSortKey];
      const valB = b[rankSortKey];
      if (typeof valA === 'number' && typeof valB === 'number') {
        return rankSortDir === 'ASC' ? valA - valB : valB - valA;
      }
      return rankSortDir === 'ASC'
        ? String(valA || '').localeCompare(String(valB || ''), 'th')
        : String(valB || '').localeCompare(String(valA || ''), 'th');
    });

    return searched;
  }, [data?.ranking, rankSearch, rankTab, rankSortKey, rankSortDir]);

  const pagedRanking = useMemo(() => {
    if (rankPageSize === 'ALL') return filteredAndSortedRanking;
    const start = (rankPage - 1) * rankPageSize;
    return filteredAndSortedRanking.slice(start, start + rankPageSize);
  }, [filteredAndSortedRanking, rankPage, rankPageSize]);

  function openKpiDrilldown(filterType: 'ALL' | 'NORMAL' | 'LATE' | 'NO_SCAN' | 'MISSING_CHECKOUT' | 'PENDING_REVIEW') {
    let rows = attendanceRows;
    let title = 'รายการลงเวลาทั้งหมดในช่วงที่เลือก';
    let targetNav: NavViewKey = 'hrAttendance';
    let targetNavLabel = 'ไปที่หน้าจัดการ HR และรายงานการลงเวลา';

    if (filterType === 'NORMAL') {
      rows = attendanceRows.filter((r) => r.status === 'NORMAL');
      title = 'รายการลงเวลาปกติ (NORMAL)';
    } else if (filterType === 'LATE') {
      rows = attendanceRows.filter((r) => Number(r.is_late) === 1 || r.status === 'LATE');
      title = `รายการมาสาย (${kpi?.latePeople || 0} คนไม่ซ้ำ · ${kpi?.lateOccurrences || 0} ครั้ง)`;
      targetNav = 'reports';
      targetNavLabel = 'ไปที่หน้ารายงานและจัดอันดับการมาสาย';
    } else if (filterType === 'NO_SCAN') {
      rows = attendanceRows.filter((r) => r.status === 'NO_SCAN');
      title = 'รายการไม่พบสแกนหลังเวลา Cutoff (NO_SCAN)';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบเวลาและบันทึกเหตุผล';
    } else if (filterType === 'MISSING_CHECKOUT') {
      rows = attendanceRows.filter((r) => r.status === 'MISSING_CHECKOUT');
      title = 'รายการขาดสแกนออก (MISSING_CHECKOUT)';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบเวลาและบันทึกเหตุผล';
    } else if (filterType === 'PENDING_REVIEW') {
      rows = attendanceRows.filter(
        (r) => r.review_status === 'PENDING' && (r.status !== 'NORMAL' || Number(r.is_late) === 1)
      );
      title = 'รายการผิดปกติที่รอตรวจสอบโดยเจ้าหน้าที่ HR';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบเวลาและการทำงาน';
    }

    setDrillModal({
      title,
      subtitle: `${resolvedRange.thaiPeriodLabel} · พบทั้งหมด ${rows.length} รายการ`,
      rows,
      targetNav,
      targetNavLabel,
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            แดชบอร์ดภาพรวมการลงเวลาปฏิบัติงาน (Attendance Overview)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            แยกการนับจำนวนคนที่สายไม่ซ้ำ (Distinct Persons) และจำนวนครั้งที่สาย (Occurrences) · คลิกที่การ์ด KPI เพื่อดูรายละเอียดรายเวร
          </p>
        </div>

        {onNavigate && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => onNavigate('attendanceReview')}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              ตรวจสอบรายการผิดปกติ ({kpi?.pendingReviewCount ?? 0})
            </button>
            <button
              type="button"
              onClick={() => onNavigate('scanners')}
              className="px-3 py-1.5 text-xs font-medium bg-white border border-slate-300 text-slate-800 rounded-lg hover:bg-slate-100 transition-colors whitespace-nowrap"
            >
              เครื่องสแกนและการดึงข้อมูล
            </button>
          </div>
        )}
      </div>

      {/* Unified Period & Department Filter Bar */}
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
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="">ทุกกลุ่มงาน / หน่วยงาน</option>
              <option value="กลุ่มงานการแพทย์ / ผู้ป่วยนอก (OPD)">กลุ่มงานการแพทย์ / OPD</option>
              <option value="กลุ่มงานการพยาบาล / อุบัติเหตุ-ฉุกเฉิน (ER)">กลุ่มงานการพยาบาล / ER</option>
              <option value="กลุ่มงานบริหารทั่วไป">กลุ่มงานบริหารทั่วไป</option>
            </select>
            <select
              value={personnelType}
              onChange={(e) => setPersonnelType(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
            >
              <option value="">ทุกประเภทบุคลากร</option>
              <option value="CIVIL_SERVANT">ข้าราชการ</option>
              <option value="PUBLIC_HEALTH_EMP">พนักงานกระทรวงสาธารณสุข (พกส.)</option>
              <option value="TEMP_EMPLOYEE">ลูกจ้างชั่วคราว</option>
            </select>
            <button
              type="button"
              onClick={loadSummary}
              className="px-3 py-1.5 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>รีเฟรชข้อมูล</span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadSummary} />

      {loading ? (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
            <div key={n} className="h-24 bg-white border border-slate-200 rounded-lg p-4 animate-pulse" />
          ))}
        </div>
      ) : kpi ? (
        <>
          {/* Interactive KPI Cards with Click Drill-Down */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <button
              type="button"
              onClick={() => openKpiDrilldown('ALL')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>บุคลากร Active / เวรที่ประเมิน</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                {data.activePersonnelTotal} คน · {kpi.totalShifts} เวร
              </div>
              <div className="mt-1 text-xs text-slate-500">
                มีตารางเวรในช่วงนี้ {kpi.evaluatedPersonnelCount} คน (คลิกดูรายชื่อ)
              </div>
            </button>

            <button
              type="button"
              onClick={() => openKpiDrilldown('NORMAL')}
              className="text-left bg-white border border-slate-200 hover:border-emerald-600 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>ลงเวลาปกติ (NORMAL)</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-emerald-700 tabular-nums">
                {kpi.normalCount} เวร
              </div>
              <div className="mt-1 text-xs text-slate-500">
                สแกนเข้าทันเวลาและมีสแกนออกครบถ้วน
              </div>
            </button>

            <button
              type="button"
              onClick={() => openKpiDrilldown('LATE')}
              className="text-left bg-white border border-slate-200 hover:border-amber-600 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>มาสาย: จำนวนคน vs จำนวนครั้ง</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-amber-700 tabular-nums">
                {kpi.latePeople} คน · {kpi.lateOccurrences} ครั้ง
              </div>
              <div className="mt-1 text-xs text-slate-500">
                COUNT DISTINCT PERSON_ID เทียบจำนวนเวรที่สาย
              </div>
            </button>

            <button
              type="button"
              onClick={() => openKpiDrilldown('LATE')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>นาทีสายรวม / เฉลี่ยต่อครั้ง</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                {kpi.totalLateMinutes} นาที ({kpi.avgLateMinutesPerOccurrence} นาที/ครั้ง)
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                ตัวหาร: {kpi.avgLateMinutesDenominatorLabel}
              </div>
            </button>

            <button
              type="button"
              onClick={() => openKpiDrilldown('NO_SCAN')}
              className="text-left bg-white border border-slate-200 hover:border-red-600 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>ไม่พบสแกนหลัง Cutoff (NO_SCAN)</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-red-700 tabular-nums">
                {kpi.noScanCount} รายการ
              </div>
              <div className="mt-1 text-xs text-slate-500">เฉพาะเวรที่เลยเวลา Cutoff แล้ว</div>
            </button>

            <button
              type="button"
              onClick={() => openKpiDrilldown('MISSING_CHECKOUT')}
              className="text-left bg-white border border-slate-200 hover:border-orange-600 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>ขาดสแกนออก (MISSING_CHECKOUT)</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-orange-700 tabular-nums">
                {kpi.missingCheckoutCount} รายการ
              </div>
              <div className="mt-1 text-xs text-slate-500">มีสแกนเข้าแต่ไม่พบสแกนออก</div>
            </button>

            <button
              type="button"
              onClick={() => openKpiDrilldown('PENDING_REVIEW')}
              className="text-left bg-white border border-slate-200 hover:border-teal-700 rounded-lg p-4 transition-colors"
            >
              <div className="flex items-center justify-between text-xs text-slate-500">
                <span>รอตรวจสอบโดย HR (Pending Review)</span>
                <Eye className="w-3.5 h-3.5 text-slate-400" />
              </div>
              <div className="mt-1 text-2xl font-bold text-slate-900 tabular-nums">
                {kpi.pendingReviewCount} รายการ
              </div>
              <div className="mt-1 text-xs text-slate-500">
                รอจับคู่ FINGLE_ID: {kpi.pendingMappingCount} รายการ
              </div>
            </button>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">สถานะซิงก์เครื่องสแกนล่าสุด</div>
              <div className="mt-1 text-sm font-bold text-slate-900 tabular-nums">
                {telemetry?.lastSuccessTimestamp
                  ? formatThaiDateTime(telemetry.lastSuccessTimestamp)
                  : 'ยังไม่มีประวัติ'}
              </div>
              <div className="mt-1 text-xs text-slate-600 tabular-nums">
                Scan ใหม่รอบล่าสุด: {telemetry?.lastSyncRun?.new_scans_inserted ?? 0} · ซิงก์ล้มเหลวสะสม:{' '}
                {telemetry?.totalFailedSyncs ?? 0}
              </div>
            </div>
          </div>

          {/* Department Summary Table */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-900">
                สรุปผลการลงเวลาแยกตามกลุ่มงาน / หน่วยงาน
              </h3>
              <span className="text-xs text-slate-500">{resolvedRange.thaiPeriodLabel}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2.5 px-3 font-medium">กลุ่มงาน / หน่วยงาน</th>
                    <th className="py-2.5 px-3 font-medium text-right">เวรทั้งหมด</th>
                    <th className="py-2.5 px-3 font-medium text-right">จำนวนคนที่สาย (ไม่ซ้ำ)</th>
                    <th className="py-2.5 px-3 font-medium text-right">จำนวนครั้งที่สาย</th>
                    <th className="py-2.5 px-3 font-medium text-right">นาทีสายรวม</th>
                    <th className="py-2.5 px-3 font-medium text-right">ไม่พบสแกน (NO_SCAN)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {data.departmentBreakdown?.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-6 text-center text-slate-500">
                        ไม่มีข้อมูลการลงเวลาในช่วงวันที่เลือก
                      </td>
                    </tr>
                  ) : (
                    data.departmentBreakdown?.map((d: any) => (
                      <tr key={d.departmentName} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-medium text-slate-900">{d.departmentName}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums">{d.totalShifts}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-amber-700 font-semibold">
                          {d.latePeople} คน
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums">{d.lateOccurrences} ครั้ง</td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-semibold">
                          {d.totalLateMinutes} นาที
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-red-700">
                          {d.noScanCount}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 4-Tab Personnel Ranking Table with Search, Sortable Columns & Pagination */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">
                  ตารางจัดอันดับบุคลากรรายบุคคล (Personnel Attendance Ranking)
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  เลือกดูตามหมวดหมู่: นาทีสายสะสม, จำนวนครั้งที่มาสาย, ตรงเวลาดีเด่น หรือรายการไม่สมบูรณ์
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center p-1 bg-slate-100 rounded-lg">
                  {[
                    { key: 'LATE_MINS', label: 'นาทีสายสะสม' },
                    { key: 'LATE_FREQ', label: 'จำนวนครั้งสาย' },
                    { key: 'ON_TIME', label: 'ตรงเวลาดีเด่น' },
                    { key: 'INCOMPLETE', label: 'ขาดสแกน/ไม่สมบูรณ์' },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => {
                        setRankTab(t.key as RankTabKey);
                        setRankPage(1);
                      }}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                        rankTab === t.key
                          ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
                  <input
                    type="text"
                    value={rankSearch}
                    onChange={(e) => {
                      setRankSearch(e.target.value);
                      setRankPage(1);
                    }}
                    placeholder="ค้นหาชื่อ, PERSON_ID..."
                    className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-52"
                  />
                </div>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2.5 px-3 font-medium">ลำดับ</th>
                    <SortableHeader
                      label="รหัส · ชื่อ-สกุล"
                      sortKey="fullName"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                    />
                    <SortableHeader
                      label="หน่วยงาน"
                      sortKey="departmentName"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                    />
                    <SortableHeader
                      label="เวรทั้งหมด"
                      sortKey="totalShifts"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                    <SortableHeader
                      label="ครั้งที่สาย"
                      sortKey="lateOccurrences"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                    <SortableHeader
                      label="นาทีสายรวม"
                      sortKey="totalLateMinutes"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                    <SortableHeader
                      label="เฉลี่ย (นาที/ครั้ง)"
                      sortKey="avgLateMinutesPerOccurrence"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                    <SortableHeader
                      label="NO_SCAN / ขาดสแกนออก"
                      sortKey="noScanCount"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {pagedRanking.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา
                      </td>
                    </tr>
                  ) : (
                    pagedRanking.map((p: any, idx: number) => (
                      <tr key={p.personId} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-mono tabular-nums font-semibold">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </td>
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-slate-900">{p.fullName}</div>
                          <div className="text-[11px] text-slate-500 font-mono">
                            {p.personId} · {p.personnelTypeName}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 text-slate-700">{p.departmentName}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums">{p.totalShifts}</td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-semibold text-amber-700">
                          {p.lateOccurrences}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums font-bold text-slate-900">
                          {p.totalLateMinutes}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-slate-600">
                          {p.avgLateMinutesPerOccurrence}
                        </td>
                        <td className="py-2.5 px-3 text-right tabular-nums text-red-700">
                          {p.noScanCount} / {p.missingCheckoutCount}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <TablePaginationBar
              totalItems={filteredAndSortedRanking.length}
              currentPage={rankPage}
              pageSize={rankPageSize}
              onPageChange={setRankPage}
              onPageSizeChange={setRankPageSize}
            />
          </div>
        </>
      ) : null}

      {/* KPI Drill-Down Modal */}
      <SharedModal
        open={Boolean(drillModal)}
        onClose={() => setDrillModal(null)}
        kickerText="รายละเอียดข้อมูลจากฐานข้อมูลจริง (KPI Drill-Down)"
        title={drillModal?.title || ''}
        subtitle={drillModal?.subtitle}
        footer={
          drillModal?.targetNav && onNavigate ? (
            <button
              type="button"
              onClick={() => {
                const target = drillModal.targetNav!;
                setDrillModal(null);
                onNavigate(target);
              }}
              className="px-3.5 py-1.5 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <span>{drillModal.targetNavLabel}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          ) : null
        }
      >
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2 px-3 font-medium">วันที่</th>
                <th className="py-2 px-3 font-medium">บุคลากร</th>
                <th className="py-2 px-3 font-medium">กะปฏิบัติงาน</th>
                <th className="py-2 px-3 font-medium">เวลาสแกนเข้า / ออก</th>
                <th className="py-2 px-3 font-medium text-right">นาทีสาย</th>
                <th className="py-2 px-3 font-medium">สถานะ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {drillModal?.rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-6 text-center text-slate-500">
                    ไม่มีรายการในหมวดหมู่นี้สำหรับช่วงวันที่เลือก
                  </td>
                </tr>
              ) : (
                drillModal?.rows.map((r: any) => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="py-2 px-3 font-mono tabular-nums">
                      {formatThaiDate(r.work_date)}
                    </td>
                    <td className="py-2 px-3">
                      <div className="font-medium text-slate-900">{r.full_name}</div>
                      <div className="text-[11px] font-mono text-slate-500">{r.person_id}</div>
                    </td>
                    <td className="py-2 px-3">{r.shift_name}</td>
                    <td className="py-2 px-3 font-mono tabular-nums">
                      {r.check_in_time?.slice(11, 19) || '-'} / {r.check_out_time?.slice(11, 19) || '-'}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums font-bold">
                      {r.late_minutes}
                    </td>
                    <td className="py-2 px-3">
                      <AttendanceStatusText status={r.status} secondaryFlags={r.secondary_flags} />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SharedModal>
    </div>
  );
}
