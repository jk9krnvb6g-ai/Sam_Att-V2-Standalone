/**
 * ============================================================================
 * หน้าแดชบอร์ดภาพรวมองค์กร (Organization Attendance Overview Dashboard)
 * ไฟล์: frontend/src/pages/DashboardView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงการ์ดตัวชี้วัดหลัก 4 ด้าน (เวรทั้งหมด, ลงเวลาตรงเวลา, มาสายแยกจำนวนคนไม่ซ้ำ/จำนวนครั้ง, รายการต้องตรวจสอบ)
 * 2. แสดงแถบสัดส่วนสถานะการลงเวลา (คำนวณสัดส่วนรวม 100.0% พอดีโดยไม่นับซ้ำ)
 * 3. แสดงแผง "รายการที่ต้องดูแล" โดยคำนวณตัวเลขจริงจากข้อมูลลงเวลา (รอตรวจ HR / ไม่สแกนเข้า-ออก / ขาดสแกน / ออกก่อนเวลา / ต้องตรวจสอบซ้ำ)
 * 4. แสดงสรุปผลการลงเวลาแยกตามกลุ่มงาน/แผนก และตารางจัดอันดับบุคลากร 4 มุมมอง
 * 5. รองรับการคลิกเจาะลึก (Interactive Drill-Down Modal) และแสดงผลแบบการ์ดบนมือถือ (md:hidden) คู่กับตารางบนคอมพิวเตอร์
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  Search,
  ArrowRight,
  Users,
  CheckCircle2,
  Clock,
  AlertTriangle,
  ClipboardCheck,
  Radio,
} from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../services/api.ts';
import { AttendanceStatusText, ErrorBanner } from '../components/StatusText.tsx';
import {
  PeriodFilterBar,
  SharedModal,
  SortableHeader,
  TablePaginationBar,
  TableEmptyState,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  getCurrentBangkokDateParts,
  type PeriodMode,
} from '../utils/thaiFormat.ts';
import { type NavViewKey } from '../components/layout/Sidebar.tsx';

type RankTabKey = 'LATE_MINS' | 'LATE_FREQ' | 'ON_TIME' | 'INCOMPLETE';

type DrillFilterType =
  | 'ALL'
  | 'NORMAL'
  | 'LATE'
  | 'NO_SCAN'
  | 'MISSING_CHECKIN'
  | 'MISSING_CHECKOUT'
  | 'EARLY_CHECKOUT'
  | 'NEEDS_RE_REVIEW'
  | 'PENDING_REVIEW';

export function DashboardView({
  user,
  onNavigate,
}: {
  user?: AuthUser;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  // Period Filter State (Daily / Monthly / Yearly / Custom) — initialized to real current Asia/Bangkok date
  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState(initialBkk.todayYmd);
  const [monthValue, setMonthValue] = useState(initialBkk.currentYearMonth);
  const [yearValue, setYearValue] = useState(initialBkk.currentYear);
  const [customFrom, setCustomFrom] = useState(initialBkk.monthStartYmd);
  const [customTo, setCustomTo] = useState(initialBkk.monthEndYmd);

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
      setData(null);
      setAttendanceRows([]);
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลสรุปแดชบอร์ดจากฐานข้อมูลได้' });
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
  const availableDepartments: string[] =
    Array.isArray(data?.availableDepartments) && data.availableDepartments.length > 0
      ? data.availableDepartments
      : ['กลุ่มงานการแพทย์', 'กลุ่มงานการพยาบาล', 'กลุ่มงานบริหารทั่วไป', 'กลุ่มงานเภสัชกรรม'];
  const availablePersonnelTypes: Array<{ code: string; name: string }> =
    Array.isArray(data?.availablePersonnelTypes) && data.availablePersonnelTypes.length > 0
      ? data.availablePersonnelTypes
      : [
          { code: 'CIVIL_SERVANT', name: 'ข้าราชการ' },
          { code: 'PUBLIC_HEALTH_EMP', name: 'พนักงานกระทรวงสาธารณสุข (พกส.)' },
          { code: 'TEMP_EMPLOYEE', name: 'ลูกจ้างชั่วคราว' },
        ];

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

  function openKpiDrilldown(filterType: DrillFilterType) {
    let rows = attendanceRows;
    let title = 'รายการลงเวลาทั้งหมดในช่วงเวลาที่เลือก';
    let targetNav: NavViewKey = 'hrAttendance';
    let targetNavLabel = 'ไปที่หน้ารายการลงเวลาทั้งหมด';

    if (filterType === 'NORMAL') {
      rows = attendanceRows.filter((r) => r.status === 'NORMAL');
      title = 'รายการลงเวลาปกติ';
    } else if (filterType === 'LATE') {
      rows = attendanceRows.filter((r) => Number(r.is_late) === 1 || r.status === 'LATE');
      title = `รายการมาสาย (${kpi?.latePeople || 0} คนไม่ซ้ำ · รวม ${kpi?.lateOccurrences || 0} ครั้ง)`;
      targetNav = 'reports';
      targetNavLabel = 'ไปที่หน้ารายงานการมาสาย';
    } else if (filterType === 'NO_SCAN') {
      rows = attendanceRows.filter((r) => r.status === 'NO_SCAN');
      title = 'รายการไม่พบข้อมูลสแกนหลังเวลาตัดรอบ';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'MISSING_CHECKIN') {
      rows = attendanceRows.filter((r) => r.status === 'MISSING_CHECKIN');
      title = 'รายการไม่พบข้อมูลสแกนเข้างาน';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'MISSING_CHECKOUT') {
      rows = attendanceRows.filter((r) => r.status === 'MISSING_CHECKOUT');
      title = 'รายการไม่สแกนออกงาน';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'EARLY_CHECKOUT') {
      rows = attendanceRows.filter(
        (r) =>
          Number(r.early_checkout_indicator || 0) === 1 ||
          Number(r.early_checkout_minutes || 0) > 0 ||
          r.status === 'EARLY_CHECKOUT'
      );
      title = 'รายการออกงานก่อนเวลา';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'NEEDS_RE_REVIEW') {
      rows = attendanceRows.filter((r) => r.review_status === 'NEEDS_RE_REVIEW');
      title = 'รายการที่ต้องตรวจสอบซ้ำ (หลังคำนวณเวลาใหม่)';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'PENDING_REVIEW') {
      rows = attendanceRows.filter(
        (r) => r.review_status === 'PENDING' && (r.status !== 'NORMAL' || Number(r.is_late) === 1)
      );
      title = 'รายการผิดปกติที่รอการตรวจสอบโดยเจ้าหน้าที่ HR';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    }

    setDrillModal({
      title,
      subtitle: `${resolvedRange.thaiPeriodLabel} · แสดงครบทั้งหมด ${rows.length} รายการจากฐานข้อมูลจริง`,
      rows,
      targetNav,
      targetNavLabel,
    });
  }

  // Mutually Exclusive Primary Shift Status Breakdown (Sum === totalShifts === 100%, Zero Double-Counting)
  const totalShiftsCount = Number(kpi?.totalShifts || 0);
  const totalShiftsSafe = Math.max(1, totalShiftsCount);
  const statusNormalCount = attendanceRows.filter((r) => r.status === 'NORMAL').length;
  const statusLateOnlyCount = attendanceRows.filter((r) => r.status === 'LATE').length;
  const statusMissingInCount = attendanceRows.filter((r) => r.status === 'MISSING_CHECKIN').length;
  const statusMissingOutCount = attendanceRows.filter((r) => r.status === 'MISSING_CHECKOUT').length;
  const statusMissingOutAndLateCount = attendanceRows.filter(
    (r) => r.status === 'MISSING_CHECKOUT' && Number(r.is_late) === 1
  ).length;
  const statusNoScanCount = attendanceRows.filter((r) => r.status === 'NO_SCAN').length;
  const statusPendingMappingCount = attendanceRows.filter(
    (r) => r.status === 'PENDING_MAPPING' || r.status === 'NO_SCHEDULE' || r.status === 'EARLY_CHECKOUT'
  ).length;

  // Action-required real indicators from loaded attendance rows
  const earlyCheckoutCount = attendanceRows.filter(
    (r) =>
      Number(r.early_checkout_indicator || 0) === 1 ||
      Number(r.early_checkout_minutes || 0) > 0 ||
      r.status === 'EARLY_CHECKOUT'
  ).length;
  const needsReReviewCount = attendanceRows.filter(
    (r) => r.review_status === 'NEEDS_RE_REVIEW'
  ).length;

  const normalPct = totalShiftsCount > 0 ? Number(((statusNormalCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const lateOnlyPct = totalShiftsCount > 0 ? Number(((statusLateOnlyCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const missingOutPct = totalShiftsCount > 0 ? Number(((statusMissingOutCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const missingInPct = totalShiftsCount > 0 ? Number(((statusMissingInCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const noScanPct = totalShiftsCount > 0 ? Number(((statusNoScanCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const pendingMapPct = totalShiftsCount > 0 ? Number(((statusPendingMappingCount / totalShiftsSafe) * 100).toFixed(1)) : 0;

  return (
    <div className="space-y-6">
      {/* 1. Compact Lavender Welcome & Operational Context Header */}
      <div className="ent-card p-5 sm:p-6 bg-gradient-to-r from-[#F2EDFA]/70 via-white to-white flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#543B7A]">
            <span>ภาพรวมการปฏิบัติงาน · โรงพยาบาลสามชุก</span>
            {data?.dataMode === 'DEMO' && (
              <span className="px-2 py-0.5 rounded-md bg-[#FEF8ED] border border-[#F3DFBC] text-[#B87516] text-[11.5px] font-bold">
                โหมด DEMO
              </span>
            )}
          </div>
          <h1 className="text-[20px] sm:text-[23px] lg:text-[25px] font-bold text-[#262238] tracking-tight leading-snug">
            {user ? `สวัสดีคุณ${user.displayName}` : 'แดชบอร์ดภาพรวมการลงเวลาปฏิบัติงาน'}
          </h1>
          <p className="text-[13.5px] text-[#746B83]">
            ช่วงเวลาที่เลือก: <strong className="text-[#262238]">{resolvedRange.thaiPeriodLabel}</strong>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <PageHelpAction
            guideKey="dashboard"
            userRole={user?.role}
            onNavigate={onNavigate}
          />
          {onNavigate && (
            <>
              <button
                type="button"
                onClick={() => onNavigate('attendanceReview')}
                className="ent-btn-primary"
              >
                <ClipboardCheck className="w-4 h-4" aria-hidden="true" />
                <span>ตรวจสอบรายการค้าง ({kpi?.pendingReviewCount ?? 0})</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('scanners')}
                className="ent-btn-secondary"
              >
                <Radio className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                <span>เครื่องสแกน</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* 2. Period & Department Filter Bar */}
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
              aria-label="กรองตามกลุ่มงานหรือหน่วยงาน"
              value={department}
              onChange={(e) => setDepartment(e.target.value)}
              className="ent-input w-full sm:w-auto"
            >
              <option value="">ทุกกลุ่มงาน / หน่วยงาน</option>
              {availableDepartments.map((dept) => (
                <option key={dept} value={dept}>
                  {dept}
                </option>
              ))}
            </select>

            <select
              aria-label="กรองตามประเภทบุคลากร"
              value={personnelType}
              onChange={(e) => setPersonnelType(e.target.value)}
              className="ent-input w-full sm:w-auto"
            >
              <option value="">ทุกประเภทบุคลากร</option>
              {availablePersonnelTypes.map((pt) => (
                <option key={pt.code} value={pt.code}>
                  {pt.name}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={loadSummary}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              <RefreshCw className="w-4 h-4 text-[#746B83]" aria-hidden="true" />
              <span>รีเฟรช</span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadSummary} />

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="ent-card p-6 h-36 animate-pulse bg-white">
              <div className="h-3.5 w-32 bg-[#EDE5F8] rounded mb-3" />
              <div className="h-7 w-20 bg-[#F2EDFA] rounded mb-6" />
              <div className="h-3 w-full bg-[#F8F7FC] rounded" />
            </div>
          ))}
        </div>
      ) : !error && kpi ? (
        <>
          {data?.isEmptyPeriod && (
            <div className="ent-card p-4 bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-3 text-[13.5px] text-[#746B83]">
              <div>
                <strong className="text-[#262238]">ยังไม่มีข้อมูลสำหรับช่วงเวลาที่เลือก ({resolvedRange.thaiPeriodLabel}):</strong>{' '}
                ตัวเลข 0 ด้านล่างเป็นผลลัพธ์จริงจากฐานข้อมูลโดยไม่มีการแทรกข้อมูลจำลอง
              </div>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('shifts')}
                  className="font-semibold text-[#543B7A] hover:text-[#795BB8] hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>ไปกำหนดตารางเวรหรือประมวลผลเวลา</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {/* 3. 4 Operational KPI Cards (Preserving Exact Formulas & Drilldowns) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Card 1: Personnel & Total Shifts */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-[#746B83]">
                    บุคลากรที่มีตารางเวร
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-[28px] font-bold text-[#262238] tabular-nums leading-none">
                      {kpi.evaluatedPersonnelCount}
                    </span>
                    <span className="text-[13px] text-[#746B83]">
                      คน (จาก {data.activePersonnelTotal} คน)
                    </span>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-[#F2EDFA] flex items-center justify-center text-[#8E70C9] shrink-0">
                  <Users className="w-5 h-5" aria-hidden="true" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E6DFF0] flex items-center justify-between text-[13px]">
                <span className="text-[#746B83]">
                  เวรรวม <strong className="text-[#262238] tabular-nums">{kpi.totalShifts} เวร</strong>
                </span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('ALL')}
                  className="font-semibold text-[#543B7A] hover:text-[#795BB8] hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>ดูทั้งหมด</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Card 2: Normal On-Time Attendance */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-[#746B83]">
                    ลงเวลาปกติ (ตรงเวลา)
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-[28px] font-bold text-[#198568] tabular-nums leading-none">
                      {kpi.normalCount}
                    </span>
                    <span className="text-[13px] text-[#746B83]">
                      เวร ({normalPct}%)
                    </span>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-[#EDF8F4] flex items-center justify-center text-[#198568] shrink-0">
                  <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E6DFF0] flex items-center justify-between text-[13px]">
                <span className="text-[#746B83]">สแกนเข้า–ออกครบตามกะ</span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('NORMAL')}
                  className="font-semibold text-[#198568] hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>ดูรายชื่อ</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Card 3: Lateness (Distinct People vs Occurrences + Total/Avg Minutes) */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-[#746B83]">
                    มาสาย (คนไม่ซ้ำ · จำนวนครั้ง)
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-1.5 flex-wrap">
                    <span className="text-[28px] font-bold text-[#B87516] tabular-nums leading-none">
                      {kpi.latePeople}
                    </span>
                    <span className="text-[13px] font-semibold text-[#262238]">คน</span>
                    <span className="text-[#E6DFF0]">·</span>
                    <span className="text-[19px] font-bold text-[#262238] tabular-nums">
                      {kpi.lateOccurrences}
                    </span>
                    <span className="text-[13px] text-[#746B83]">ครั้ง</span>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-[#FEF8ED] flex items-center justify-center text-[#B87516] shrink-0">
                  <Clock className="w-5 h-5" aria-hidden="true" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E6DFF0] flex items-center justify-between gap-2 text-[13px]">
                <span className="text-[#746B83] tabular-nums truncate">
                  สะสม <strong className="text-[#262238]">{kpi.totalLateMinutes} น.</strong> (เฉลี่ย {kpi.avgLateMinutesPerOccurrence} น.)
                </span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('LATE')}
                  className="font-semibold text-[#B87516] hover:underline inline-flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <span>เจาะลึก</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>

            {/* Card 4: Scan Anomalies (NO_SCAN & MISSING_CHECKOUT) */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13px] font-semibold text-[#746B83]">
                    ไม่พบสแกน · ไม่สแกนออก
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <button
                      type="button"
                      onClick={() => openKpiDrilldown('NO_SCAN')}
                      className="text-left group cursor-pointer"
                    >
                      <span className="text-[28px] font-bold text-[#C74455] tabular-nums leading-none group-hover:underline">
                        {kpi.noScanCount}
                      </span>
                      <span className="text-[13px] text-[#746B83] ml-1">ขาดสแกน</span>
                    </button>
                    <span className="text-[#E6DFF0]">/</span>
                    <button
                      type="button"
                      onClick={() => openKpiDrilldown('MISSING_CHECKOUT')}
                      className="text-left group cursor-pointer"
                    >
                      <span className="text-[22px] font-bold text-[#B87516] tabular-nums leading-none group-hover:underline">
                        {kpi.missingCheckoutCount}
                      </span>
                      <span className="text-[13px] text-[#746B83] ml-1">ไม่สแกนออก</span>
                    </button>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-[#FDF2F3] flex items-center justify-center text-[#C74455] shrink-0">
                  <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E6DFF0] flex items-center justify-between text-[13px]">
                <span className="text-[#746B83]">
                  รอตรวจ HR <strong className="text-[#C74455] tabular-nums">{kpi.pendingReviewCount} รายการ</strong>
                </span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('PENDING_REVIEW')}
                  className="font-semibold text-[#543B7A] hover:text-[#795BB8] hover:underline inline-flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <span>ตรวจรายการ</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {/* 4. Attendance Status Visualization (100% Non-Overlapping) + Action-Required Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Left 2 Columns: Mutually Exclusive 100% Shift Status Breakdown */}
            <div className="lg:col-span-2 ent-card p-5 sm:p-6 flex flex-col justify-between space-y-5">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
                    สัดส่วนสถานะหลักของเวรปฏิบัติงานทั้งหมด
                  </h2>
                  <span className="text-[12.5px] font-semibold text-[#543B7A] bg-[#F2EDFA] px-3 py-1 rounded-lg border border-[#E6DFF0] tabular-nums">
                    ฐานการคำนวณ: {totalShiftsCount} เวร = 100% (ไม่นับซ้ำ)
                  </span>
                </div>
                <p className="text-[13px] text-[#746B83]">
                  จำแนกตามสถานะหลักของแต่ละเวรโดยไม่ซ้อนทับ เพื่อความชัดเจนในการติดตามและตรวจสอบ
                </p>
              </div>

              {/* Stacked Horizontal Bar (Guaranteed Sum === totalShifts) */}
              <div className="space-y-3.5">
                <div className="h-3.5 w-full bg-[#F2EDFA] rounded-lg overflow-hidden flex border border-[#E6DFF0]">
                  {statusNormalCount > 0 && (
                    <div
                      style={{ width: `${(statusNormalCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#198568] transition-all"
                      title={`ลงเวลาปกติ: ${statusNormalCount} เวร (${normalPct}%)`}
                    />
                  )}
                  {statusLateOnlyCount > 0 && (
                    <div
                      style={{ width: `${(statusLateOnlyCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#B87516] transition-all"
                      title={`มาสาย (สแกนเข้า-ออกครบ): ${statusLateOnlyCount} เวร (${lateOnlyPct}%)`}
                    />
                  )}
                  {statusMissingOutCount > 0 && (
                    <div
                      style={{ width: `${(statusMissingOutCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#E5A93C] transition-all"
                      title={`ไม่สแกนออกงาน: ${statusMissingOutCount} เวร (${missingOutPct}%)`}
                    />
                  )}
                  {statusMissingInCount > 0 && (
                    <div
                      style={{ width: `${(statusMissingInCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#D97757] transition-all"
                      title={`ไม่สแกนเข้างาน: ${statusMissingInCount} เวร (${missingInPct}%)`}
                    />
                  )}
                  {statusNoScanCount > 0 && (
                    <div
                      style={{ width: `${(statusNoScanCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#C74455] transition-all"
                      title={`ไม่พบข้อมูลสแกน: ${statusNoScanCount} เวร (${noScanPct}%)`}
                    />
                  )}
                  {statusPendingMappingCount > 0 && (
                    <div
                      style={{ width: `${(statusPendingMappingCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#5879BC] transition-all"
                      title={`สถานะอื่น / รอเชื่อมโยง: ${statusPendingMappingCount} เวร (${pendingMapPct}%)`}
                    />
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('NORMAL')}
                    className="p-3.5 rounded-xl border border-[#E6DFF0] bg-[#F8F7FC] hover:bg-[#F2EDFA] flex items-center justify-between text-left transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-xs bg-[#198568] shrink-0" />
                      <span className="text-[13.5px] font-semibold text-[#262238]">ลงเวลาปกติ</span>
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#198568] tabular-nums">
                      {statusNormalCount} เวร ({normalPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('LATE')}
                    className="p-3.5 rounded-xl border border-[#E6DFF0] bg-[#F8F7FC] hover:bg-[#F2EDFA] flex items-center justify-between text-left transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-xs bg-[#B87516] shrink-0" />
                      <span className="text-[13.5px] font-semibold text-[#262238]">มาสาย (สแกนออกครบ)</span>
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#B87516] tabular-nums">
                      {statusLateOnlyCount} เวร ({lateOnlyPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('MISSING_CHECKOUT')}
                    className="p-3.5 rounded-xl border border-[#E6DFF0] bg-[#F8F7FC] hover:bg-[#F2EDFA] flex items-center justify-between text-left transition-colors cursor-pointer"
                  >
                    <div>
                      <div className="flex items-center gap-2.5">
                        <span className="w-3 h-3 rounded-xs bg-[#E5A93C] shrink-0" />
                        <span className="text-[13.5px] font-semibold text-[#262238]">ไม่สแกนออกงาน</span>
                      </div>
                      {statusMissingOutAndLateCount > 0 && (
                        <div className="text-[11.5px] text-[#746B83] pl-5 mt-0.5">
                          เข้าสายร่วมด้วย {statusMissingOutAndLateCount} เวร
                        </div>
                      )}
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#B87516] tabular-nums shrink-0">
                      {statusMissingOutCount} เวร ({missingOutPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('NO_SCAN')}
                    className="p-3.5 rounded-xl border border-[#E6DFF0] bg-[#F8F7FC] hover:bg-[#F2EDFA] flex items-center justify-between text-left transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-xs bg-[#C74455] shrink-0" />
                      <span className="text-[13.5px] font-semibold text-[#262238]">ไม่พบข้อมูลสแกน</span>
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#C74455] tabular-nums">
                      {statusNoScanCount} เวร ({noScanPct}%)
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: Real Action-Required Panel */}
            <div className="ent-card p-5 sm:p-6 flex flex-col justify-between space-y-4">
              <div className="space-y-0.5">
                <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
                  รายการที่ต้องดูแล
                </h2>
                <p className="text-[13px] text-[#746B83]">
                  สรุปรายการผิดปกติจากฐานข้อมูลจริงเพื่อดำเนินการต่อ
                </p>
              </div>

              <div className="space-y-2 flex-1">
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('PENDING_REVIEW')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-[#F2EDFA] hover:bg-[#EDE5F8] border border-[#E6DFF0] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <span className="text-[13.5px] font-semibold text-[#543B7A]">รอตรวจสอบเหตุผล HR</span>
                  <span className="font-mono font-bold text-[14px] text-[#543B7A] tabular-nums">
                    {kpi.pendingReviewCount} รายการ
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openKpiDrilldown('NO_SCAN')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white hover:bg-[#F8F7FC] border border-[#E6DFF0] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <span className="text-[13.5px] font-medium text-[#262238]">ไม่พบข้อมูลสแกน (NO_SCAN)</span>
                  <span className={`font-mono font-bold text-[13.5px] tabular-nums ${statusNoScanCount > 0 ? 'text-[#C74455]' : 'text-[#746B83]'}`}>
                    {statusNoScanCount}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openKpiDrilldown('MISSING_CHECKIN')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white hover:bg-[#F8F7FC] border border-[#E6DFF0] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <span className="text-[13.5px] font-medium text-[#262238]">ไม่พบสแกนเข้างาน</span>
                  <span className={`font-mono font-bold text-[13.5px] tabular-nums ${statusMissingInCount > 0 ? 'text-[#C74455]' : 'text-[#746B83]'}`}>
                    {statusMissingInCount}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openKpiDrilldown('MISSING_CHECKOUT')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white hover:bg-[#F8F7FC] border border-[#E6DFF0] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <span className="text-[13.5px] font-medium text-[#262238]">ไม่สแกนออกงาน</span>
                  <span className={`font-mono font-bold text-[13.5px] tabular-nums ${statusMissingOutCount > 0 ? 'text-[#B87516]' : 'text-[#746B83]'}`}>
                    {statusMissingOutCount}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openKpiDrilldown('EARLY_CHECKOUT')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white hover:bg-[#F8F7FC] border border-[#E6DFF0] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <span className="text-[13.5px] font-medium text-[#262238]">ออกงานก่อนเวลา</span>
                  <span className={`font-mono font-bold text-[13.5px] tabular-nums ${earlyCheckoutCount > 0 ? 'text-[#C74455]' : 'text-[#746B83]'}`}>
                    {earlyCheckoutCount}
                  </span>
                </button>

                <button
                  type="button"
                  onClick={() => openKpiDrilldown('NEEDS_RE_REVIEW')}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-white hover:bg-[#F8F7FC] border border-[#E6DFF0] flex items-center justify-between text-left transition-colors cursor-pointer"
                >
                  <span className="text-[13.5px] font-medium text-[#262238]">ต้องตรวจสอบซ้ำ</span>
                  <span className={`font-mono font-bold text-[13.5px] tabular-nums ${needsReReviewCount > 0 ? 'text-[#B87516]' : 'text-[#746B83]'}`}>
                    {needsReReviewCount}
                  </span>
                </button>
              </div>

              {/* Compact Scanner Last Sync Footer */}
              <div className="pt-3 border-t border-[#E6DFF0] flex items-center justify-between gap-2 text-[12.5px] text-[#746B83]">
                <div className="truncate">
                  ซิงก์เครื่องสแกนล่าสุด:{' '}
                  <span className="font-mono text-[#262238]">
                    {telemetry?.lastSuccessTimestamp
                      ? formatThaiDateTime(telemetry.lastSuccessTimestamp)
                      : 'ยังไม่มีประวัติ'}
                  </span>
                </div>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('scanners')}
                    className="font-semibold text-[#5879BC] hover:underline shrink-0 cursor-pointer"
                  >
                    ดูสถานะ
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* 5. Department Summary Table */}
          <div className="ent-table-wrapper">
            <div className="px-4 sm:px-6 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
                  สรุปผลการลงเวลาแยกตามกลุ่มงาน / หน่วยงาน
                </h2>
                <p className="text-[13px] text-[#746B83]">
                  เปรียบเทียบจำนวนบุคลากรที่มาสาย (ไม่ซ้ำคน) จำนวนครั้งที่สาย และจำนวนเวรที่ไม่พบข้อมูลสแกน
                </p>
              </div>
              <span className="text-[12.5px] font-medium text-[#746B83]">{resolvedRange.thaiPeriodLabel}</span>
            </div>

            {/* Mobile Card View (< md) */}
            <div className="md:hidden divide-y divide-[#E6DFF0]">
              {data.departmentBreakdown?.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#746B83]">
                  ไม่มีข้อมูลการลงเวลาในช่วงเวลาที่เลือก
                </div>
              ) : (
                data.departmentBreakdown?.map((d: any) => (
                  <div key={d.departmentName} className="p-4 space-y-2.5 bg-white">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[15px] text-[#262238]">{d.departmentName}</span>
                      <span className="font-mono text-[13px] font-semibold text-[#746B83] tabular-nums">
                        {d.totalShifts} เวร
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-[#F8F7FC] border border-[#E6DFF0] text-[12.5px] text-center">
                      <div>
                        <div className="text-[#746B83]">คนสาย</div>
                        <div className="font-mono font-bold text-[#B87516] mt-0.5 tabular-nums">
                          {d.latePeople} คน ({d.lateOccurrences})
                        </div>
                      </div>
                      <div>
                        <div className="text-[#746B83]">นาทีสายสะสม</div>
                        <div className="font-mono font-bold text-[#262238] mt-0.5 tabular-nums">
                          {d.totalLateMinutes} น.
                        </div>
                      </div>
                      <div>
                        <div className="text-[#746B83]">ไม่พบสแกน</div>
                        <div className="font-mono font-bold text-[#C74455] mt-0.5 tabular-nums">
                          {d.noScanCount} เวร
                        </div>
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
                    <th className="py-3.5 px-5 font-semibold text-[13px]">กลุ่มงาน / หน่วยงาน</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px] text-right">เวรปฏิบัติงานทั้งหมด</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px] text-right">จำนวนคนที่สาย (ไม่ซ้ำคน)</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px] text-right">จำนวนครั้งที่สาย</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px] text-right">นาทีสายสะสม</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px] text-right">ไม่พบข้อมูลสแกน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6DFF0]">
                  {data.departmentBreakdown?.length === 0 ? (
                    <TableEmptyState colSpan={6} title="ไม่มีข้อมูลการลงเวลาในช่วงเวลาที่เลือก" />
                  ) : (
                    data.departmentBreakdown?.map((d: any) => (
                      <tr key={d.departmentName} className="hover:bg-[#F8F7FC] transition-colors">
                        <td className="py-3.5 px-5 font-semibold text-[#262238]">{d.departmentName}</td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums text-[#262238]">
                          {d.totalShifts} เวร
                        </td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums text-[#B87516] font-semibold">
                          {d.latePeople} คน
                        </td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums text-[#262238]">
                          {d.lateOccurrences} ครั้ง
                        </td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums font-bold text-[#262238]">
                          {d.totalLateMinutes} นาที
                        </td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums text-[#C74455] font-semibold">
                          {d.noScanCount} เวร
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 6. Personnel Attendance Ranking Table */}
          <div className="ent-table-wrapper">
            <div className="px-4 sm:px-6 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC] flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
              <div>
                <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
                  ตารางสรุปสถิติการลงเวลารายบุคคล
                </h2>
                <p className="text-[13px] text-[#746B83] mt-0.5">
                  จัดเรียงตามนาทีสายสะสม จำนวนครั้งที่มาสาย บุคลากรตรงเวลาดีเด่น หรือรายการไม่สมบูรณ์
                </p>
              </div>

              <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3 w-full xl:w-auto">
                <div className="ent-tab-bar grid grid-cols-2 sm:inline-flex">
                  {[
                    { key: 'LATE_MINS', label: 'นาทีสายสะสม' },
                    { key: 'LATE_FREQ', label: 'จำนวนครั้งสาย' },
                    { key: 'ON_TIME', label: 'ตรงเวลาดีเด่น' },
                    { key: 'INCOMPLETE', label: 'รายการไม่สมบูรณ์' },
                  ].map((t) => (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => {
                        setRankTab(t.key as RankTabKey);
                        setRankPage(1);
                      }}
                      className={`ent-tab-btn ${rankTab === t.key ? 'ent-tab-btn-active' : ''}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="relative w-full sm:w-64">
                  <Search className="w-4 h-4 text-[#746B83] absolute left-3.5 top-3" aria-hidden="true" />
                  <input
                    type="text"
                    aria-label="ค้นหาบุคลากรในตารางจัดอันดับ"
                    value={rankSearch}
                    onChange={(e) => {
                      setRankSearch(e.target.value);
                      setRankPage(1);
                    }}
                    placeholder="ค้นหาชื่อ หรือ รหัสบุคลากร..."
                    className="ent-input pl-10 pr-4 w-full"
                  />
                </div>
              </div>
            </div>

            {/* Mobile Card View (< md) */}
            <div className="md:hidden divide-y divide-[#E6DFF0]">
              {pagedRanking.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#746B83]">
                  ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา
                </div>
              ) : (
                pagedRanking.map((p: any, idx: number) => (
                  <div key={p.personId} className="p-4 space-y-2.5 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-mono text-[12.5px] font-bold text-[#8E70C9] mr-1.5 tabular-nums">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </span>
                        <span className="font-bold text-[15px] text-[#262238]">{p.fullName}</span>
                        <div className="text-[12.5px] text-[#746B83] mt-0.5">
                          <span className="font-mono">{p.personId}</span> · {p.departmentName}
                        </div>
                      </div>
                      <span className="font-mono text-[12.5px] text-[#746B83] shrink-0 tabular-nums">
                        {p.totalShifts} เวร
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-[#F8F7FC] border border-[#E6DFF0] text-[12.5px] text-center">
                      <div>
                        <div className="text-[#746B83]">ครั้งที่สาย</div>
                        <div className="font-mono font-bold text-[#B87516] mt-0.5 tabular-nums">
                          {p.lateOccurrences} ครั้ง
                        </div>
                      </div>
                      <div>
                        <div className="text-[#746B83]">นาทีสายสะสม</div>
                        <div className="font-mono font-bold text-[#262238] mt-0.5 tabular-nums">
                          {p.totalLateMinutes} นาที
                        </div>
                      </div>
                      <div>
                        <div className="text-[#746B83]">ขาด/ไม่สแกนออก</div>
                        <div className="font-mono font-bold text-[#C74455] mt-0.5 tabular-nums">
                          {p.noScanCount}/{p.missingCheckoutCount}
                        </div>
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
                    <th className="py-3.5 px-4 font-semibold text-[13px]">ลำดับ</th>
                    <SortableHeader
                      label="ชื่อ-นามสกุล · รหัสบุคลากร"
                      sortKey="fullName"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                    />
                    <SortableHeader
                      label="กลุ่มงาน / หน่วยงาน"
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
                      label="จำนวนครั้งที่สาย"
                      sortKey="lateOccurrences"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                    <SortableHeader
                      label="นาทีสายสะสม"
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
                      label="ขาดสแกน / ไม่สแกนออก"
                      sortKey="noScanCount"
                      activeSortKey={rankSortKey}
                      sortDir={rankSortDir}
                      onSort={handleSortRanking}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6DFF0]">
                  {pagedRanking.length === 0 ? (
                    <TableEmptyState colSpan={8} title="ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา" />
                  ) : (
                    pagedRanking.map((p: any, idx: number) => (
                      <tr key={p.personId} className="hover:bg-[#F8F7FC] transition-colors">
                        <td className="py-3.5 px-4 font-mono tabular-nums font-semibold text-[#746B83]">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-[14.5px] text-[#262238]">{p.fullName}</div>
                          <div className="text-[12.5px] text-[#746B83] font-mono mt-0.5">
                            {p.personId} · {p.personnelTypeName}
                          </div>
                        </td>
                        <td className="py-3.5 px-4 text-[#262238]">{p.departmentName}</td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#262238]">
                          {p.totalShifts}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-[#B87516]">
                          {p.lateOccurrences} ครั้ง
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold text-[#262238]">
                          {p.totalLateMinutes} นาที
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#746B83]">
                          {p.avgLateMinutesPerOccurrence}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#C74455] font-semibold">
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
        kickerText="รายละเอียดรายเวรจากฐานข้อมูลจริง"
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
              className="ent-btn-primary w-full sm:w-auto"
            >
              <span>{drillModal.targetNavLabel}</span>
              <ArrowRight className="w-4 h-4" aria-hidden="true" />
            </button>
          ) : null
        }
      >
        <div className="border border-[#E6DFF0] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13.5px]">
              <thead>
                <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">วันที่ปฏิบัติงาน</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">ชื่อ-นามสกุล · รหัสบุคลากร</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">กะปฏิบัติงาน</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">เวลาเข้า / เวลาออก</th>
                  <th className="py-3 px-4 font-semibold text-right whitespace-nowrap">นาทีสาย</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6DFF0]">
                {drillModal?.rows.length === 0 ? (
                  <TableEmptyState colSpan={6} title="ไม่มีรายการในหมวดหมู่นี้สำหรับช่วงเวลาที่เลือก" />
                ) : (
                  drillModal?.rows.map((r: any) => (
                    <tr key={r.id} className="hover:bg-[#F8F7FC]">
                      <td className="py-3 px-4 font-mono tabular-nums text-[#262238] whitespace-nowrap">
                        {formatThaiDate(r.work_date)}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-semibold text-[#262238]">{r.full_name}</div>
                        <div className="text-[12px] font-mono text-[#746B83]">{r.person_id}</div>
                      </td>
                      <td className="py-3 px-4 text-[#262238] whitespace-nowrap">{r.shift_name}</td>
                      <td className="py-3 px-4 font-mono tabular-nums text-[#262238] whitespace-nowrap">
                        {r.check_in_time?.slice(11, 16) || '—'} / {r.check_out_time?.slice(11, 16) || '—'}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums font-bold text-[#B87516] whitespace-nowrap">
                        {r.late_minutes > 0 ? `${r.late_minutes} นาที` : '0'}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <AttendanceStatusText
                          status={r.status}
                          secondaryFlags={r.secondary_flags}
                          earlyCheckoutMinutes={r.early_checkout_minutes}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </SharedModal>
    </div>
  );
}
