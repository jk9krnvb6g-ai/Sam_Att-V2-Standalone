/**
 * ============================================================================
 * หน้าแดชบอร์ดภาพรวมองค์กร (Organization Attendance Overview Dashboard)
 * ไฟล์: frontend/src/pages/DashboardView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงการ์ดตัวชี้วัดหลัก 4 ด้าน (เวรทั้งหมด, ลงเวลาตรงเวลา, มาสายแยกจำนวนคนไม่ซ้ำ/จำนวนครั้ง, รายการต้องตรวจสอบ)
 * 2. แสดงแถบสัดส่วนสถานะการลงเวลา (คำนวณสัดส่วนรวม 100.0% พอดีโดยไม่นับซ้ำ)
 * 3. แสดงสรุปผลการลงเวลาแยกตามกลุ่มงาน/แผนก และตารางจัดอันดับบุคลากร 4 มุมมอง
 * 4. รองรับการคลิกเจาะลึก (Interactive Drill-Down Modal) เพื่อดูรายการเวรจริงของแต่ละสถานะหรือแต่ละแผนก
 * 5. แสดงผลแบบการ์ดบนมือถือ (md:hidden) คู่กับตารางบนคอมพิวเตอร์ (hidden md:block)
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

  function openKpiDrilldown(
    filterType: 'ALL' | 'NORMAL' | 'LATE' | 'NO_SCAN' | 'MISSING_CHECKOUT' | 'PENDING_REVIEW'
  ) {
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
      targetNavLabel = 'ไปที่หน้ารายงานและสถิติการมาสาย';
    } else if (filterType === 'NO_SCAN') {
      rows = attendanceRows.filter((r) => r.status === 'NO_SCAN');
      title = 'รายการไม่พบข้อมูลสแกนหลังเวลาตัดรอบ';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบเวลาและบันทึกเหตุผล';
    } else if (filterType === 'MISSING_CHECKOUT') {
      rows = attendanceRows.filter((r) => r.status === 'MISSING_CHECKOUT');
      title = 'รายการไม่สแกนออกงาน';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบเวลาและบันทึกเหตุผล';
    } else if (filterType === 'PENDING_REVIEW') {
      rows = attendanceRows.filter(
        (r) => r.review_status === 'PENDING' && (r.status !== 'NORMAL' || Number(r.is_late) === 1)
      );
      title = 'รายการผิดปกติที่รอการตรวจสอบโดยเจ้าหน้าที่ HR';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบเวลาและบันทึกเหตุผล';
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
  const statusMissingOutCount = attendanceRows.filter((r) => r.status === 'MISSING_CHECKOUT').length;
  const statusMissingOutAndLateCount = attendanceRows.filter(
    (r) => r.status === 'MISSING_CHECKOUT' && Number(r.is_late) === 1
  ).length;
  const statusNoScanCount = attendanceRows.filter((r) => r.status === 'NO_SCAN').length;
  const statusPendingMappingCount = attendanceRows.filter(
    (r) => r.status === 'PENDING_MAPPING' || r.status === 'NO_SCHEDULE'
  ).length;

  const normalPct = totalShiftsCount > 0 ? Number(((statusNormalCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const lateOnlyPct = totalShiftsCount > 0 ? Number(((statusLateOnlyCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const missingOutPct = totalShiftsCount > 0 ? Number(((statusMissingOutCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const noScanPct = totalShiftsCount > 0 ? Number(((statusNoScanCount / totalShiftsSafe) * 100).toFixed(1)) : 0;
  const pendingMapPct = totalShiftsCount > 0 ? Number(((statusPendingMappingCount / totalShiftsSafe) * 100).toFixed(1)) : 0;

  return (
    <div className="space-y-6">
      {/* 1. Welcome & Operational Context Header */}
      <div className="ent-card p-4 sm:p-6 bg-gradient-to-r from-[#FFF1F3] via-white to-white border border-[#F9E8EB] flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4 sm:gap-5">
        <div className="space-y-1.5 min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[13px] sm:text-[13.5px] font-semibold text-[#9F3F50]">
            <span>ภาพรวมการปฏิบัติงาน · โรงพยาบาลสามชุก</span>
            {data?.dataMode === 'DEMO' && (
              <span className="px-2 py-0.5 rounded-md bg-amber-100 border border-amber-300 text-[#92400E] text-[12px] font-bold">
                โหมดข้อมูลตัวอย่าง (DEMO)
              </span>
            )}
          </div>
          <h1 className="text-[21px] sm:text-[24px] lg:text-[27px] font-bold text-[#273244] tracking-tight">
            {user ? `สวัสดีคุณ${user.displayName}` : 'แดชบอร์ดบริหารเวลาปฏิบัติงาน'}
          </h1>
          <p className="text-[13.5px] sm:text-[14.5px] text-[#596579] leading-relaxed">
            ข้อมูลประจำช่วง <strong className="text-[#273244]">{resolvedRange.thaiPeriodLabel}</strong> · แยกการนับจำนวนบุคลากรที่มาสายไม่ซ้ำคน ออกจากจำนวนครั้งที่มาสายอย่างชัดเจน
          </p>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center xl:justify-end gap-2.5 sm:gap-3 xl:max-w-[54%]">
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
                className="ent-btn-primary w-full sm:w-auto"
              >
                <ClipboardCheck className="w-4 h-4" />
                <span>ตรวจสอบรายการค้าง ({kpi?.pendingReviewCount ?? 0} รายการ)</span>
              </button>
              <button
                type="button"
                onClick={() => onNavigate('scanners')}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                <Radio className="w-4 h-4 text-[#B45363]" />
                <span>สถานะเครื่องสแกน</span>
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
              <RefreshCw className="w-4 h-4 text-[#596579]" />
              <span>รีเฟรชข้อมูล</span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadSummary} />

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="ent-card p-6 h-36 animate-pulse bg-white" />
          ))}
        </div>
      ) : !error && kpi ? (
        <>
          {data?.isEmptyPeriod && (
            <div className="ent-card p-4 bg-[#FFF9F9] border border-[#E7E2E5] flex flex-wrap items-center justify-between gap-3 text-[13.5px] text-[#596579]">
              <div>
                <strong className="text-[#273244]">ยังไม่มีข้อมูลสำหรับช่วงเวลาที่เลือก ({resolvedRange.thaiPeriodLabel}):</strong>{' '}
                ตัวเลข 0 ด้านล่างเป็นผลลัพธ์จริงจากฐานข้อมูลโดยไม่มีการแทรกข้อมูลจำลอง
              </div>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('shifts')}
                  className="font-semibold text-[#9F3F50] hover:underline inline-flex items-center gap-1"
                >
                  <span>ไปกำหนดตารางเวรหรือประมวลผลเวลา</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
          {/* 3. What is happening? — 4 Operational KPI Cards (preserving all 8 metrics & drill-downs) */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            {/* Card 1: Personnel & Total Shifts */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold text-[#596579]">
                    บุคลากรที่มีตารางเวร
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-[28px] font-bold text-[#273244] tabular-nums leading-none">
                      {kpi.evaluatedPersonnelCount}
                    </span>
                    <span className="text-[14px] text-[#596579]">
                      คน (จากบุคลากร {data.activePersonnelTotal} คน)
                    </span>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-[#F8F6F7] flex items-center justify-center text-[#596579] shrink-0">
                  <Users className="w-5 h-5" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E7E2E5] flex items-center justify-between text-[13.5px]">
                <span className="text-[#596579]">
                  เวรปฏิบัติงานรวม <strong className="text-[#273244] tabular-nums">{kpi.totalShifts} เวร</strong>
                </span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('ALL')}
                  className="font-semibold text-[#9F3F50] hover:underline inline-flex items-center gap-1"
                >
                  <span>ดูทั้ง {kpi.totalShifts} เวร</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Card 2: Normal On-Time Attendance */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold text-[#596579]">
                    ลงเวลาปกติ (สแกนครบตรงเวลา)
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-[28px] font-bold text-[#047857] tabular-nums leading-none">
                      {kpi.normalCount}
                    </span>
                    <span className="text-[14px] text-[#596579]">
                      เวร ({normalPct}% ของเวรทั้งหมด)
                    </span>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-[#047857] shrink-0">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E7E2E5] flex items-center justify-between text-[13.5px]">
                <span className="text-[#596579]">สแกนเข้าและออกครบตามเกณฑ์กะ</span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('NORMAL')}
                  className="font-semibold text-[#047857] hover:underline inline-flex items-center gap-1"
                >
                  <span>ดูรายชื่อ</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Card 3: Lateness (Distinct People vs Occurrences + Total/Avg Minutes) */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold text-[#596579]">
                    ผู้มาสาย (คนไม่ซ้ำ · จำนวนครั้ง)
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <span className="text-[28px] font-bold text-[#B45309] tabular-nums leading-none">
                      {kpi.latePeople}
                    </span>
                    <span className="text-[14px] font-semibold text-[#273244]">คนไม่ซ้ำ</span>
                    <span className="text-[#D5CDD2]">·</span>
                    <span className="text-[18px] font-bold text-[#273244] tabular-nums">
                      {kpi.lateOccurrences}
                    </span>
                    <span className="text-[14px] text-[#596579]">ครั้ง</span>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-[#B45309] shrink-0">
                  <Clock className="w-5 h-5" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E7E2E5] flex items-center justify-between text-[13.5px]">
                <span className="text-[#596579] tabular-nums">
                  สายสะสม <strong className="text-[#273244]">{kpi.totalLateMinutes} นาที</strong> (เฉลี่ย {kpi.avgLateMinutesPerOccurrence} นาที/ครั้ง)
                </span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('LATE')}
                  className="font-semibold text-[#B45309] hover:underline inline-flex items-center gap-1 shrink-0"
                >
                  <span>เจาะลึก</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Card 4: Scan Anomalies (NO_SCAN & MISSING_CHECKOUT) */}
            <div className="ent-card p-5 flex flex-col justify-between space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-[13.5px] font-semibold text-[#596579]">
                    ไม่พบสแกน · ไม่สแกนออกงาน
                  </div>
                  <div className="mt-1.5 flex items-baseline gap-2">
                    <button
                      type="button"
                      onClick={() => openKpiDrilldown('NO_SCAN')}
                      className="text-left group"
                    >
                      <span className="text-[28px] font-bold text-[#B91C1C] tabular-nums leading-none group-hover:underline">
                        {kpi.noScanCount}
                      </span>
                      <span className="text-[13.5px] text-[#596579] ml-1">ขาดสแกน</span>
                    </button>
                    <span className="text-[#D5CDD2] mx-1">/</span>
                    <button
                      type="button"
                      onClick={() => openKpiDrilldown('MISSING_CHECKOUT')}
                      className="text-left group"
                    >
                      <span className="text-[24px] font-bold text-[#B45309] tabular-nums leading-none group-hover:underline">
                        {kpi.missingCheckoutCount}
                      </span>
                      <span className="text-[13.5px] text-[#596579] ml-1">ไม่สแกนออก</span>
                    </button>
                  </div>
                </div>
                <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center text-[#B91C1C] shrink-0">
                  <AlertTriangle className="w-5 h-5" />
                </div>
              </div>

              <div className="pt-3 border-t border-[#E7E2E5] flex items-center justify-between text-[13.5px]">
                <span className="text-[#596579]">
                  รอตรวจสอบเหตุผล <strong className="text-[#B91C1C] tabular-nums">{kpi.pendingReviewCount} รายการ</strong>
                </span>
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('PENDING_REVIEW')}
                  className="font-semibold text-[#9F3F50] hover:underline inline-flex items-center gap-1 shrink-0"
                >
                  <span>ตรวจรายการ</span>
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>

          {/* 4. Attendance Status Visualization + Action-Required Panel */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
            {/* Left 2 Columns: Mutually Exclusive 100% Shift Status Breakdown */}
            <div className="lg:col-span-2 ent-card p-6 flex flex-col justify-between space-y-5">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-[18px] font-bold text-[#273244]">
                    สัดส่วนสถานะหลักของเวรปฏิบัติงานทั้งหมด
                  </h2>
                  <span className="text-[13.5px] font-semibold text-[#9F3F50] bg-[#FFF1F3] px-3 py-1 rounded-lg border border-[#F9E8EB] tabular-nums">
                    ฐานการคำนวณ: {totalShiftsCount} เวร = 100% (ไม่นับซ้ำ)
                  </span>
                </div>
                <p className="text-[13.5px] text-[#596579]">
                  จำแนกตามสถานะหลักของแต่ละเวร เพื่อไม่ให้นำจำนวนคนหรือจำนวนครั้งที่มาสายซ้อนทับกับเวรที่ไม่สแกนออกงาน
                </p>
              </div>

              {/* Stacked Horizontal Bar (Guaranteed Sum === totalShifts) */}
              <div className="space-y-3">
                <div className="h-4 w-full bg-[#F8F6F7] rounded-lg overflow-hidden flex border border-[#E7E2E5]">
                  {statusNormalCount > 0 && (
                    <div
                      style={{ width: `${(statusNormalCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#047857] transition-all"
                      title={`ลงเวลาปกติ: ${statusNormalCount} เวร (${normalPct}%)`}
                    />
                  )}
                  {statusLateOnlyCount > 0 && (
                    <div
                      style={{ width: `${(statusLateOnlyCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#B45309] transition-all"
                      title={`มาสาย (สแกนเข้า-ออกครบ): ${statusLateOnlyCount} เวร (${lateOnlyPct}%)`}
                    />
                  )}
                  {statusMissingOutCount > 0 && (
                    <div
                      style={{ width: `${(statusMissingOutCount / totalShiftsSafe) * 100}%` }}
                      className="bg-amber-400 transition-all"
                      title={`ไม่สแกนออกงาน: ${statusMissingOutCount} เวร (${missingOutPct}%)`}
                    />
                  )}
                  {statusNoScanCount > 0 && (
                    <div
                      style={{ width: `${(statusNoScanCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#B91C1C] transition-all"
                      title={`ไม่พบข้อมูลสแกน: ${statusNoScanCount} เวร (${noScanPct}%)`}
                    />
                  )}
                  {statusPendingMappingCount > 0 && (
                    <div
                      style={{ width: `${(statusPendingMappingCount / totalShiftsSafe) * 100}%` }}
                      className="bg-[#2563EB] transition-all"
                      title={`รอเชื่อมโยงรหัสสแกน: ${statusPendingMappingCount} เวร (${pendingMapPct}%)`}
                    />
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('NORMAL')}
                    className="p-3.5 rounded-xl border border-[#E7E2E5] bg-[#FFF9F9] hover:bg-[#F8F6F7] flex items-center justify-between text-left transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-xs bg-[#047857] shrink-0" />
                      <span className="text-[14px] font-semibold text-[#273244]">ลงเวลาปกติ</span>
                    </div>
                    <span className="text-[14px] font-mono font-bold text-[#047857] tabular-nums">
                      {statusNormalCount} เวร ({normalPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('LATE')}
                    className="p-3.5 rounded-xl border border-[#E7E2E5] bg-[#FFF9F9] hover:bg-[#F8F6F7] flex items-center justify-between text-left transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-xs bg-[#B45309] shrink-0" />
                      <span className="text-[14px] font-semibold text-[#273244]">มาสาย (สแกนออกครบ)</span>
                    </div>
                    <span className="text-[14px] font-mono font-bold text-[#B45309] tabular-nums">
                      {statusLateOnlyCount} เวร ({lateOnlyPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('MISSING_CHECKOUT')}
                    className="p-3.5 rounded-xl border border-[#E7E2E5] bg-[#FFF9F9] hover:bg-[#F8F6F7] flex items-center justify-between text-left transition-colors"
                  >
                    <div>
                      <div className="flex items-center gap-2.5">
                        <span className="w-3 h-3 rounded-xs bg-amber-400 shrink-0" />
                        <span className="text-[14px] font-semibold text-[#273244]">ไม่สแกนออกงาน</span>
                      </div>
                      {statusMissingOutAndLateCount > 0 && (
                        <div className="text-[12px] text-[#596579] pl-5 mt-0.5">
                          (เข้าสายร่วมด้วย {statusMissingOutAndLateCount} เวร นับรวมในสถิติสาย {kpi.lateOccurrences} ครั้ง)
                        </div>
                      )}
                    </div>
                    <span className="text-[14px] font-mono font-bold text-[#B45309] tabular-nums shrink-0">
                      {statusMissingOutCount} เวร ({missingOutPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => openKpiDrilldown('NO_SCAN')}
                    className="p-3.5 rounded-xl border border-[#E7E2E5] bg-[#FFF9F9] hover:bg-[#F8F6F7] flex items-center justify-between text-left transition-colors"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="w-3 h-3 rounded-xs bg-[#B91C1C] shrink-0" />
                      <span className="text-[14px] font-semibold text-[#273244]">ไม่พบข้อมูลสแกน</span>
                    </div>
                    <span className="text-[14px] font-mono font-bold text-[#B91C1C] tabular-nums">
                      {statusNoScanCount} เวร ({noScanPct}%)
                    </span>
                  </button>
                </div>
              </div>
            </div>

            {/* Right Column: What requires attention & What to do next? (Action-Required Panel) */}
            <div className="ent-card p-6 flex flex-col justify-between space-y-4">
              <div className="space-y-1">
                <h2 className="text-[18px] font-bold text-[#273244]">
                  สิ่งที่ต้องดูแลและดำเนินการต่อ
                </h2>
                <p className="text-[13.5px] text-[#596579]">
                  รายการงานสำคัญสำหรับเจ้าหน้าที่บริหารเวลาปฏิบัติงาน
                </p>
              </div>

              <div className="space-y-3 flex-1">
                <div className="p-4 rounded-xl bg-[#FFF1F3] border border-[#F9E8EB] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-bold text-[#9F3F50]">
                      1. รายการรอตรวจสอบเหตุผล HR
                    </span>
                    <span className="text-[15px] font-mono font-bold text-[#9F3F50] tabular-nums">
                      {kpi.pendingReviewCount} รายการ
                    </span>
                  </div>
                  <p className="text-[13px] text-[#596579] leading-snug">
                    ตรวจสอบใบลา หนังสือส่งตัวไปราชการ หรือบันทึกหมายเหตุการลืมสแกนออกงาน
                  </p>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('attendanceReview')}
                      className="text-[13.5px] font-semibold text-[#9F3F50] hover:underline inline-flex items-center gap-1.5 pt-1"
                    >
                      <span>ไปที่หน้าตรวจสอบเวลาและหมายเหตุ</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="p-4 rounded-xl bg-[#F8F6F7] border border-[#E7E2E5] space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-bold text-[#273244]">
                      2. สถานะการดึงข้อมูลเครื่องสแกน
                    </span>
                    <span className="text-[13px] font-mono text-[#047857] font-semibold">
                      ซิงก์ล้มเหลว: {telemetry?.totalFailedSyncs ?? 0} ครั้ง
                    </span>
                  </div>
                  <div className="text-[13px] text-[#596579] font-mono">
                    ซิงก์สำเร็จล่าสุด:{' '}
                    {telemetry?.lastSuccessTimestamp
                      ? formatThaiDateTime(telemetry.lastSuccessTimestamp)
                      : 'ยังไม่มีประวัติการซิงก์'}
                  </div>
                  {onNavigate && (
                    <button
                      type="button"
                      onClick={() => onNavigate('scanners')}
                      className="text-[13.5px] font-semibold text-[#2563EB] hover:underline inline-flex items-center gap-1.5 pt-1"
                    >
                      <span>จัดการเครื่องสแกนและรอบดึงข้อมูล</span>
                      <ArrowRight className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 5. Department Summary Table */}
          <div className="ent-table-wrapper">
            <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7] flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-[17px] sm:text-[18px] font-bold text-[#273244]">
                  สรุปผลการลงเวลาแยกตามกลุ่มงาน / หน่วยงาน
                </h2>
                <p className="text-[13px] sm:text-[13.5px] text-[#596579]">
                  เปรียบเทียบจำนวนบุคลากรที่มาสาย (ไม่ซ้ำคน) จำนวนครั้งที่สาย และจำนวนเวรที่ไม่พบข้อมูลสแกน
                </p>
              </div>
              <span className="text-[13px] font-medium text-[#596579]">{resolvedRange.thaiPeriodLabel}</span>
            </div>

            {/* Mobile Card View (< md) */}
            <div className="md:hidden divide-y divide-[#E7E2E5]">
              {data.departmentBreakdown?.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#596579]">
                  ไม่มีข้อมูลการลงเวลาในช่วงเวลาที่เลือก
                </div>
              ) : (
                data.departmentBreakdown?.map((d: any) => (
                  <div key={d.departmentName} className="p-4 space-y-2.5 bg-white">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[15px] text-[#273244]">{d.departmentName}</span>
                      <span className="font-mono text-[13px] font-semibold text-[#596579]">
                        {d.totalShifts} เวร
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-[#F8F6F7] border border-[#E7E2E5] text-[12.5px] text-center">
                      <div>
                        <div className="text-[#596579]">คนสาย</div>
                        <div className="font-mono font-bold text-[#B45309] mt-0.5">
                          {d.latePeople} คน ({d.lateOccurrences} ครั้ง)
                        </div>
                      </div>
                      <div>
                        <div className="text-[#596579]">นาทีสายสะสม</div>
                        <div className="font-mono font-bold text-[#273244] mt-0.5">
                          {d.totalLateMinutes} นาที
                        </div>
                      </div>
                      <div>
                        <div className="text-[#596579]">ไม่พบสแกน</div>
                        <div className="font-mono font-bold text-[#B91C1C] mt-0.5">
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
                  <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                    <th className="py-3.5 px-5 font-semibold">กลุ่มงาน / หน่วยงาน</th>
                    <th className="py-3.5 px-5 font-semibold text-right">เวรปฏิบัติงานทั้งหมด</th>
                    <th className="py-3.5 px-5 font-semibold text-right">จำนวนคนที่สาย (ไม่ซ้ำคน)</th>
                    <th className="py-3.5 px-5 font-semibold text-right">จำนวนครั้งที่สาย</th>
                    <th className="py-3.5 px-5 font-semibold text-right">นาทีสายสะสม</th>
                    <th className="py-3.5 px-5 font-semibold text-right">ไม่พบข้อมูลสแกน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E2E5]">
                  {data.departmentBreakdown?.length === 0 ? (
                    <TableEmptyState colSpan={6} title="ไม่มีข้อมูลการลงเวลาในช่วงเวลาที่เลือก" />
                  ) : (
                    data.departmentBreakdown?.map((d: any) => (
                      <tr key={d.departmentName} className="hover:bg-[#FFF9F9] transition-colors">
                        <td className="py-4 px-5 font-semibold text-[#273244]">{d.departmentName}</td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums text-[#273244]">
                          {d.totalShifts} เวร
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums text-[#B45309] font-semibold">
                          {d.latePeople} คน
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums text-[#273244]">
                          {d.lateOccurrences} ครั้ง
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums font-bold text-[#273244]">
                          {d.totalLateMinutes} นาที
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums text-[#B91C1C] font-semibold">
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
            <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7] flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
              <div>
                <h2 className="text-[17px] sm:text-[18px] font-bold text-[#273244]">
                  ตารางสรุปสถิติการลงเวลารายบุคคล
                </h2>
                <p className="text-[13px] sm:text-[13.5px] text-[#596579] mt-0.5">
                  เลือกจัดเรียงตามนาทีสายสะสม จำนวนครั้งที่มาสาย บุคลากรตรงเวลาดีเด่น หรือรายการที่ไม่สมบูรณ์
                </p>
              </div>

              <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-3 w-full xl:w-auto">
                <div className="grid grid-cols-2 sm:inline-flex items-center p-1 bg-[#E7E2E5]/60 rounded-lg gap-1 sm:gap-0">
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
                      className={`px-3 py-1.5 text-[13px] sm:text-[13.5px] font-medium rounded-md transition-colors text-center whitespace-nowrap ${
                        rankTab === t.key
                          ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
                          : 'text-[#596579] hover:text-[#273244]'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>

                <div className="relative w-full sm:w-64">
                  <Search className="w-4 h-4 text-[#596579] absolute left-3.5 top-3" aria-hidden="true" />
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
            <div className="md:hidden divide-y divide-[#E7E2E5]">
              {pagedRanking.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#596579]">
                  ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา
                </div>
              ) : (
                pagedRanking.map((p: any, idx: number) => (
                  <div key={p.personId} className="p-4 space-y-2.5 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-mono text-[12.5px] font-bold text-[#9F3F50] mr-1.5">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </span>
                        <span className="font-bold text-[15px] text-[#273244]">{p.fullName}</span>
                        <div className="text-[12.5px] text-[#596579] mt-0.5">
                          <span className="font-mono">{p.personId}</span> · {p.departmentName}
                        </div>
                      </div>
                      <span className="font-mono text-[12.5px] text-[#596579] shrink-0">
                        {p.totalShifts} เวร
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 p-2.5 rounded-lg bg-[#F8F6F7] border border-[#E7E2E5] text-[12.5px] text-center">
                      <div>
                        <div className="text-[#596579]">ครั้งที่สาย</div>
                        <div className="font-mono font-bold text-[#B45309] mt-0.5">
                          {p.lateOccurrences} ครั้ง
                        </div>
                      </div>
                      <div>
                        <div className="text-[#596579]">นาทีสายสะสม</div>
                        <div className="font-mono font-bold text-[#273244] mt-0.5">
                          {p.totalLateMinutes} นาที
                        </div>
                      </div>
                      <div>
                        <div className="text-[#596579]">ขาด/ไม่สแกนออก</div>
                        <div className="font-mono font-bold text-[#B91C1C] mt-0.5">
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
                  <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                    <th className="py-3.5 px-4 font-semibold">ลำดับ</th>
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
                <tbody className="divide-y divide-[#E7E2E5]">
                  {pagedRanking.length === 0 ? (
                    <TableEmptyState colSpan={8} title="ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา" />
                  ) : (
                    pagedRanking.map((p: any, idx: number) => (
                      <tr key={p.personId} className="hover:bg-[#FFF9F9] transition-colors">
                        <td className="py-4 px-4 font-mono tabular-nums font-semibold text-[#596579]">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </td>
                        <td className="py-4 px-4">
                          <div className="font-bold text-[14.5px] text-[#273244]">{p.fullName}</div>
                          <div className="text-[12.5px] text-[#596579] font-mono mt-0.5">
                            {p.personId} · {p.personnelTypeName}
                          </div>
                        </td>
                        <td className="py-4 px-4 text-[#273244]">{p.departmentName}</td>
                        <td className="py-4 px-4 text-right font-mono tabular-nums text-[#273244]">
                          {p.totalShifts}
                        </td>
                        <td className="py-4 px-4 text-right font-mono tabular-nums font-semibold text-[#B45309]">
                          {p.lateOccurrences} ครั้ง
                        </td>
                        <td className="py-4 px-4 text-right font-mono tabular-nums font-bold text-[#273244]">
                          {p.totalLateMinutes} นาที
                        </td>
                        <td className="py-4 px-4 text-right font-mono tabular-nums text-[#596579]">
                          {p.avgLateMinutesPerOccurrence}
                        </td>
                        <td className="py-4 px-4 text-right font-mono tabular-nums text-[#B91C1C] font-semibold">
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
              <ArrowRight className="w-4 h-4" />
            </button>
          ) : null
        }
      >
        <div className="border border-[#E7E2E5] rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[13.5px] sm:text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">วันที่ปฏิบัติงาน</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">ชื่อ-นามสกุล · รหัสบุคลากร</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">กะปฏิบัติงาน</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">เวลาเข้า / เวลาออก</th>
                  <th className="py-3 px-4 font-semibold text-right whitespace-nowrap">นาทีสาย</th>
                  <th className="py-3 px-4 font-semibold whitespace-nowrap">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {drillModal?.rows.length === 0 ? (
                  <TableEmptyState colSpan={6} title="ไม่มีรายการในหมวดหมู่นี้สำหรับช่วงเวลาที่เลือก" />
                ) : (
                  drillModal?.rows.map((r: any) => (
                    <tr key={r.id} className="hover:bg-[#FFF9F9]">
                      <td className="py-3.5 px-4 font-mono tabular-nums text-[#273244] whitespace-nowrap">
                        {formatThaiDate(r.work_date)}
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-bold text-[#273244]">{r.full_name}</div>
                        <div className="text-[12.5px] font-mono text-[#596579]">{r.person_id}</div>
                      </td>
                      <td className="py-3.5 px-4 text-[#273244] whitespace-nowrap">{r.shift_name}</td>
                      <td className="py-3.5 px-4 font-mono tabular-nums text-[#273244] whitespace-nowrap">
                        {r.check_in_time?.slice(11, 16) || '—'} / {r.check_out_time?.slice(11, 16) || '—'}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold text-[#B45309] whitespace-nowrap">
                        {r.late_minutes > 0 ? `${r.late_minutes} นาที` : '0'}
                      </td>
                      <td className="py-3.5 px-4 whitespace-nowrap">
                        <AttendanceStatusText status={r.status} secondaryFlags={r.secondary_flags} />
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
