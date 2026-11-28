/**
 * ============================================================================
 * หน้าแดชบอร์ดภาพรวมองค์กร (Organization Attendance Overview Dashboard)
 * ไฟล์: frontend/src/pages/DashboardView.tsx
 * ============================================================================
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
  PageHeader,
  SectionHeader,
  MetricStrip,
  StatusBadge,
  PeriodFilterBar,
  SharedModal,
  SortableHeader,
  TablePaginationBar,
  TableEmptyState,
  type PageSizeOption,
  type MetricStripItem,
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

  const [rankTab, setRankTab] = useState<RankTabKey>('LATE_MINS');
  const [rankSearch, setRankSearch] = useState('');
  const [rankSortKey, setRankSortKey] = useState('totalLateMinutes');
  const [rankSortDir, setRankSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [rankPage, setRankPage] = useState(1);
  const [rankPageSize, setRankPageSize] = useState<PageSizeOption>(10);

  const [drillModal, setDrillModal] = useState<{
    title: string;
    subtitle: string;
    rows: any[];
    loading?: boolean;
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
      const summaryRes = await apiRequest(`/dashboard/summary?${qs.toString()}`);
      setData(summaryRes);
    } catch (err) {
      setData(null);
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
  const availableDepartments: string[] = Array.isArray(data?.availableDepartments)
    ? data.availableDepartments
    : [];
  const availablePersonnelTypes: Array<{ code: string; name: string }> = Array.isArray(
    data?.availablePersonnelTypes
  )
    ? data.availablePersonnelTypes
    : [];
  const [drillPage, setDrillPage] = useState(1);
  const [drillPageSize, setDrillPageSize] = useState<PageSizeOption>(10);

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

  async function openKpiDrilldown(filterType: DrillFilterType) {
    let title = 'รายการลงเวลาทั้งหมดในช่วงเวลาที่เลือก';
    let targetNav: NavViewKey = 'hrAttendance';
    let targetNavLabel = 'ไปที่หน้ารายการลงเวลาทั้งหมด';
    let endpoint = '/attendance';
    const qs = new URLSearchParams({
      dateFrom: resolvedRange.dateFrom,
      dateTo: resolvedRange.dateTo,
      page: '1',
      pageSize: '100',
      ...(department ? { department } : {}),
      ...(personnelType ? { personnelType } : {}),
    });

    if (filterType === 'NORMAL') {
      qs.set('status', 'NORMAL');
      title = 'รายการลงเวลาปกติ';
    } else if (filterType === 'LATE') {
      qs.set('status', 'LATE');
      title = `รายการมาสาย (${kpi?.latePeople || 0} คนไม่ซ้ำ · รวม ${kpi?.lateOccurrences || 0} ครั้ง)`;
      targetNav = 'reports';
      targetNavLabel = 'ไปที่หน้ารายงานการมาสาย';
    } else if (filterType === 'NO_SCAN') {
      qs.set('status', 'NO_SCAN');
      title = 'รายการไม่พบข้อมูลสแกนหลังเวลาตัดรอบ';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'MISSING_CHECKIN') {
      qs.set('status', 'MISSING_CHECKIN');
      title = 'รายการไม่พบข้อมูลสแกนเข้างาน';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'MISSING_CHECKOUT') {
      qs.set('status', 'MISSING_CHECKOUT');
      title = 'รายการไม่สแกนออกงาน';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'EARLY_CHECKOUT') {
      qs.set('status', 'EARLY_CHECKOUT');
      title = 'รายการออกงานก่อนเวลา';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'NEEDS_RE_REVIEW') {
      qs.set('status', 'NEEDS_RE_REVIEW');
      title = 'รายการที่ต้องตรวจสอบซ้ำ (หลังคำนวณเวลาใหม่)';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    } else if (filterType === 'PENDING_REVIEW') {
      endpoint = '/attendance-review';
      qs.set('reviewStatus', 'PENDING');
      title = 'รายการผิดปกติที่รอการตรวจสอบโดยเจ้าหน้าที่ HR';
      targetNav = 'attendanceReview';
      targetNavLabel = 'ไปที่หน้าตรวจสอบและหมายเหตุ';
    }

    setDrillPage(1);
    setDrillModal({
      title,
      subtitle: `${resolvedRange.thaiPeriodLabel} · กำลังดึงข้อมูลจากฐานข้อมูล...`,
      rows: [],
      loading: true,
      targetNav,
      targetNavLabel,
    });

    try {
      const res = await apiRequest<{ items?: any[]; totalCount?: number }>(
        `${endpoint}?${qs.toString()}`
      );
      const rows = res.items || [];
      const total = Number(res.totalCount ?? rows.length);
      setDrillModal({
        title,
        subtitle:
          total > rows.length
            ? `${resolvedRange.thaiPeriodLabel} · แสดง ${rows.length} จากทั้งหมด ${total} รายการ`
            : `${resolvedRange.thaiPeriodLabel} · แสดงครบทั้งหมด ${rows.length} รายการจากฐานข้อมูลจริง`,
        rows,
        loading: false,
        targetNav,
        targetNavLabel,
      });
    } catch {
      setDrillModal({
        title,
        subtitle: `${resolvedRange.thaiPeriodLabel} · ไม่สามารถดึงข้อมูลรายละเอียดได้`,
        rows: [],
        loading: false,
        targetNav,
        targetNavLabel,
      });
    }
  }

  // Mutually Exclusive Primary Shift Status Breakdown (Sum === totalShifts === 100%)
  const totalShiftsCount = Number(kpi?.totalShifts || 0);
  const totalShiftsSafe = Math.max(1, totalShiftsCount);
  const statusNormalCount = Number(kpi?.normalCount || 0);
  const statusLateOnlyCount = Number(kpi?.lateOnlyCount || 0);
  const statusInProgressCount =
    Number(kpi?.inProgressCount || 0) + Number(kpi?.lateInProgressCount || 0);
  const statusMissingInCount = Number(kpi?.missingCheckinCount || 0);
  const statusMissingOutCount = Number(kpi?.missingCheckoutCount || 0);
  const statusMissingOutAndLateCount = Number(kpi?.missingCheckoutLateCount || 0);
  const statusNoScanCount = Number(kpi?.noScanCount || 0);
  const statusPendingMappingCount = Math.max(
    0,
    totalShiftsCount -
      (statusNormalCount +
        statusLateOnlyCount +
        statusInProgressCount +
        statusMissingInCount +
        statusMissingOutCount +
        statusNoScanCount)
  );

  const earlyCheckoutCount = Number(kpi?.earlyCheckoutCount || 0);
  const needsReReviewCount = Number(kpi?.needsReReviewCount || 0);

  const safePct = (count: number): number => {
    if (totalShiftsCount <= 0 || count <= 0) return 0;
    if (count >= totalShiftsCount) return 100;
    return Math.min(99.9, Number(((count / totalShiftsSafe) * 100).toFixed(1)));
  };

  const normalPct = safePct(statusNormalCount);
  const lateOnlyPct = safePct(statusLateOnlyCount);
  const missingOutPct = safePct(statusMissingOutCount);
  const missingInPct = safePct(statusMissingInCount);
  const noScanPct = safePct(statusNoScanCount);
  const pendingMapPct = safePct(statusPendingMappingCount + statusInProgressCount);

  const scannerOnlineCount = Number(telemetry?.onlineDevices ?? telemetry?.activeDevices ?? 0);
  const scannerTotalCount = Number(telemetry?.totalDevices ?? 0);
  const lastSyncLabel = telemetry?.lastSuccessTimestamp
    ? formatThaiDateTime(telemetry.lastSuccessTimestamp)
    : 'ยังไม่มีประวัติซิงก์';

  const metricItems: MetricStripItem[] = kpi
    ? [
        {
          id: 'personnel',
          label: 'บุคลากรที่มีตารางเวร',
          value: kpi.evaluatedPersonnelCount,
          unit: `คน / ${data.activePersonnelTotal}`,
          sublabel: `เวรรวม ${kpi.totalShifts} เวร`,
          tone: 'default',
          icon: <Users className="w-4 h-4" />,
          onClick: () => openKpiDrilldown('ALL'),
          actionHint: 'ดูทั้งหมด',
        },
        {
          id: 'normal',
          label: 'สแกนเข้า–ออกปกติ',
          value: kpi.normalCount,
          unit: `เวร (${normalPct}%)`,
          sublabel: 'สแกนครบตามตารางเวร',
          tone: 'success',
          icon: <CheckCircle2 className="w-4 h-4 text-[#198568]" />,
          onClick: () => openKpiDrilldown('NORMAL'),
          actionHint: 'ดูรายชื่อ',
        },
        {
          id: 'late',
          label: 'ผู้มาสาย · จำนวนครั้ง',
          value: `${kpi.latePeople} / ${kpi.lateOccurrences}`,
          unit: 'คน / ครั้ง',
          sublabel: `สะสม ${kpi.totalLateMinutes} น. (เฉลี่ย ${kpi.avgLateMinutesPerOccurrence} น.)`,
          tone: 'warning',
          icon: <Clock className="w-4 h-4 text-[#B87516]" />,
          onClick: () => openKpiDrilldown('LATE'),
          actionHint: 'เจาะลึก',
        },
        {
          id: 'anomalies',
          label: 'ไม่พบสแกน · ไม่สแกนออก',
          value: `${kpi.noScanCount} / ${kpi.missingCheckoutCount}`,
          unit: 'เวร',
          sublabel: `รอตรวจสอบ HR ${kpi.pendingReviewCount} รายการ`,
          tone: kpi.noScanCount > 0 ? 'danger' : 'default',
          icon: <AlertTriangle className="w-4 h-4 text-[#C74455]" />,
          onClick: () => openKpiDrilldown('PENDING_REVIEW'),
          actionHint: 'ตรวจรายการ',
        },
        {
          id: 'scanner-sync',
          label: 'เครื่องสแกน · ซิงก์ล่าสุด',
          value:
            scannerTotalCount > 0
              ? `${scannerOnlineCount}/${scannerTotalCount}`
              : telemetry?.lastSuccessTimestamp
                ? 'พร้อมใช้งาน'
                : 'รอซิงก์',
          unit: scannerTotalCount > 0 ? 'เครื่อง' : undefined,
          sublabel: lastSyncLabel,
          tone: 'brand',
          icon: <Radio className="w-4 h-4 text-[#8066B5]" />,
          onClick: onNavigate ? () => onNavigate('scanners') : undefined,
          actionHint: onNavigate ? 'จัดการ' : undefined,
        },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* 1. Clean Institutional Page Header (Zero Gradients) */}
      <PageHeader
        category="ภาพรวมการปฏิบัติงาน · โรงพยาบาลสามชุก"
        title={user ? `สวัสดีคุณ${user.displayName}` : 'แดชบอร์ดภาพรวมการลงเวลาปฏิบัติงาน'}
        subtitle="ติดตามสถานะการลงเวลาปฏิบัติงานของบุคลากร จำนวนผู้สแกนและผู้มาสาย สถานะเครื่องสแกน และรายการที่ต้องตรวจสอบ"
        meta={
          <>
            <span>
              ช่วงเวลาที่แสดง: <strong className="text-[#292638]">{resolvedRange.thaiPeriodLabel}</strong>
            </span>
            <span aria-hidden="true">·</span>
            <span>
              ซิงก์เครื่องสแกนล่าสุด: <strong className="font-mono text-[#292638]">{lastSyncLabel}</strong>
            </span>
            {data?.dataMode === 'DEMO' && (
              <>
                <span aria-hidden="true">·</span>
                <StatusBadge tone="warning" label="โหมด DEMO" compact />
              </>
            )}
          </>
        }
        actions={
          <>
            <PageHelpAction
              guideKey="dashboard"
              userRole={user?.role}
              onNavigate={onNavigate}
            />
            {onNavigate && (
              <>
                <button
                  type="button"
                  onClick={() => onNavigate('scanners')}
                  className="ent-btn-secondary"
                >
                  <Radio className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                  <span>เครื่องสแกน</span>
                </button>
                <button
                  type="button"
                  onClick={() => onNavigate('attendanceReview')}
                  className="ent-btn-primary"
                >
                  <ClipboardCheck className="w-4 h-4" aria-hidden="true" />
                  <span>ตรวจสอบรายการค้าง ({kpi?.pendingReviewCount ?? 0})</span>
                </button>
              </>
            )}
          </>
        }
      />

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
              <RefreshCw className="w-4 h-4 text-[#777287]" aria-hidden="true" />
              <span>รีเฟรช</span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadSummary} />

      {loading ? (
        <div className="his-metric-strip grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 divide-y sm:divide-y-0 sm:divide-x divide-[#E8E4EF]">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="p-5 h-28 animate-pulse bg-white space-y-3">
              <div className="h-3.5 w-28 bg-[#E9DFF5] rounded" />
              <div className="h-7 w-20 bg-[#F1ECFA] rounded" />
              <div className="h-3 w-36 bg-[#F8F7FC] rounded" />
            </div>
          ))}
        </div>
      ) : !error && kpi ? (
        <>
          {data?.isEmptyPeriod && (
            <div className="his-surface px-4 py-3.5 bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-3 text-[13.5px] text-[#777287]">
              <div>
                <strong className="text-[#292638]">
                  ยังไม่มีข้อมูลสำหรับช่วงเวลาที่เลือก ({resolvedRange.thaiPeriodLabel}):
                </strong>{' '}
                ตัวเลข 0 ด้านล่างเป็นผลลัพธ์จริงจากฐานข้อมูลโดยไม่มีการแทรกข้อมูลจำลอง
              </div>
              {onNavigate && (
                <button
                  type="button"
                  onClick={() => onNavigate('shifts')}
                  className="font-semibold text-[#8066B5] hover:text-[#4E3978] hover:underline inline-flex items-center gap-1 cursor-pointer"
                >
                  <span>ไปกำหนดตารางเวรหรือประมวลผลเวลา</span>
                  <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          )}

          {/* 2.5 Today Live Attendance Strip (B2) */}
          {data?.todaySummary && (
            <section
              aria-label="สถานะการปฏิบัติงานวันนี้แบบเรียลไทม์"
              className="his-surface px-5 py-4 flex flex-col xl:flex-row xl:items-center justify-between gap-4 bg-white"
            >
              <div className="space-y-0.5 min-w-0">
                <div className="text-[12px] font-semibold text-[#8066B5]">
                  สรุปสถานะวันนี้ ({formatThaiDate(data.todaySummary.workDate)})
                </div>
                <div className="text-[14.5px] font-bold text-[#292638]">
                  จัดเวรวันนี้ {data.todaySummary.scheduled} เวร · สแกนเข้าแล้ว {data.todaySummary.checkedIn} · กำลังปฏิบัติงาน{' '}
                  {Number(data.todaySummary.inProgress || 0) + Number(data.todaySummary.lateInProgress || 0)}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-4 text-[13px] font-mono tabular-nums">
                <span className="text-[#198568] font-semibold">
                  ครบเข้า–ออก: {data.todaySummary.completed}
                </span>
                <span className="text-[#5879BC] font-semibold">
                  รอสแกนเข้า: {data.todaySummary.awaitingCheckin}
                </span>
                <span className="text-[#C74455] font-semibold">
                  แจ้งเตือน/ขาดสแกน: {data.todaySummary.missingOrAlert}
                </span>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate('hrWorkCenter')}
                    className="ent-btn-secondary h-8 px-3 text-[12.5px] font-sans whitespace-nowrap"
                  >
                    <span>เปิดศูนย์งาน HR วันนี้</span>
                    <ArrowRight className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                  </button>
                )}
              </div>
            </section>
          )}

          {/* 3. Unified Single-Elevation Metric Strip (5 Core Hospital KPIs) */}
          <MetricStrip items={metricItems} columns={5} />

          {/* 4. Attendance Status Breakdown + Action-Required Queue (Hairline Divided, Zero Nested Cards) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
            {/* Left 7 Cols: Mutually Exclusive 100% Shift Status Breakdown */}
            <section className="lg:col-span-7 his-surface flex flex-col justify-between overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8E4EF]">
                <SectionHeader
                  title="สัดส่วนสถานะหลักของเวรปฏิบัติงานทั้งหมด"
                  subtitle="จำแนกตามสถานะหลักของแต่ละเวรโดยไม่ซ้อนทับ เพื่อเปรียบเทียบผู้สแกนครบกับผู้ไม่พบสแกน"
                  actions={
                    <StatusBadge
                      tone="brand"
                      label={`ฐานคำนวณ ${totalShiftsCount} เวร = 100%`}
                      compact
                    />
                  }
                />
              </div>

              <div className="px-5 py-4 space-y-4">
                {/* Stacked Horizontal Bar */}
                <div className="h-3 w-full bg-[#F1ECFA] rounded-full overflow-hidden flex">
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

                {/* Hairline-Divided Breakdown List (Zero Decorative Dots, Proportional Bars) */}
                <div className="divide-y divide-[#E8E4EF] border-t border-[#E8E4EF]">
                  <button
                    type="button"
                    onClick={() => {
                      setDrillPage(1);
                      openKpiDrilldown('NORMAL');
                    }}
                    className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8F7FC] px-2 -mx-2 rounded-md transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-1 h-4 rounded-xs bg-[#198568] shrink-0" aria-hidden="true" />
                      <span className="text-[14px] font-medium text-[#292638]">
                        ลงเวลาปกติ (สแกนเข้า–ออกครบ)
                      </span>
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#198568] tabular-nums shrink-0">
                      {statusNormalCount} เวร ({normalPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setDrillPage(1);
                      openKpiDrilldown('LATE');
                    }}
                    className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8F7FC] px-2 -mx-2 rounded-md transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-1 h-4 rounded-xs bg-[#B87516] shrink-0" aria-hidden="true" />
                      <span className="text-[14px] font-medium text-[#292638]">
                        มาสาย (สแกนออกครบ)
                      </span>
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#B87516] tabular-nums shrink-0">
                      {statusLateOnlyCount} เวร ({lateOnlyPct}%)
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setDrillPage(1);
                      openKpiDrilldown('MISSING_CHECKOUT');
                    }}
                    className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8F7FC] px-2 -mx-2 rounded-md transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2.5">
                        <span className="w-1 h-4 rounded-xs bg-[#E5A93C] shrink-0" aria-hidden="true" />
                        <span className="text-[14px] font-medium text-[#292638]">ไม่สแกนออกงาน</span>
                      </div>
                      {statusMissingOutAndLateCount > 0 && (
                        <div className="text-[12px] text-[#777287] pl-3.5 mt-0.5">
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
                    onClick={() => {
                      setDrillPage(1);
                      openKpiDrilldown('NO_SCAN');
                    }}
                    className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8F7FC] px-2 -mx-2 rounded-md transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <span className="w-1 h-4 rounded-xs bg-[#C74455] shrink-0" aria-hidden="true" />
                      <span className="text-[14px] font-medium text-[#292638]">
                        ไม่พบข้อมูลสแกน (NO_SCAN)
                      </span>
                    </div>
                    <span className="text-[13.5px] font-mono font-bold text-[#C74455] tabular-nums shrink-0">
                      {statusNoScanCount} เวร ({noScanPct}%)
                    </span>
                  </button>

                  {statusMissingInCount > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setDrillPage(1);
                        openKpiDrilldown('MISSING_CHECKIN');
                      }}
                      className="w-full py-3 flex items-center justify-between gap-3 text-left hover:bg-[#F8F7FC] px-2 -mx-2 rounded-md transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        <span className="w-1 h-4 rounded-xs bg-[#D97757] shrink-0" aria-hidden="true" />
                        <span className="text-[14px] font-medium text-[#292638]">ไม่สแกนเข้างาน</span>
                      </div>
                      <span className="text-[13.5px] font-mono font-bold text-[#C74455] tabular-nums shrink-0">
                        {statusMissingInCount} เวร ({missingInPct}%)
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </section>

            {/* Right 5 Cols: Action-Required Queue (Clean Hairline List) */}
            <section className="lg:col-span-5 his-surface flex flex-col justify-between overflow-hidden">
              <div className="px-5 py-4 border-b border-[#E8E4EF]">
                <SectionHeader
                  title="รายการที่ต้องดูแล"
                  subtitle="คลิกแต่ละหัวข้อเพื่อเปิดดูรายชื่อและดำเนินการตรวจสอบ"
                />
              </div>

              <div className="divide-y divide-[#E8E4EF] flex-1">
                <button
                  type="button"
                  onClick={() => openKpiDrilldown('PENDING_REVIEW')}
                  className="w-full px-5 py-3.5 bg-[#F1ECFA]/60 hover:bg-[#F1ECFA] flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                >
                  <span className="text-[14px] font-semibold text-[#4E3978]">
                    รอตรวจสอบเหตุผลโดยเจ้าหน้าที่ HR
                  </span>
                  <span className="font-mono font-bold text-[14px] text-[#4E3978] tabular-nums shrink-0">
                    {kpi.pendingReviewCount} รายการ
                  </span>
                </button>

                {[
                  {
                    key: 'NO_SCAN' as DrillFilterType,
                    label: 'ไม่พบข้อมูลสแกน (NO_SCAN)',
                    count: statusNoScanCount,
                    color: statusNoScanCount > 0 ? 'text-[#C74455]' : 'text-[#777287]',
                  },
                  {
                    key: 'MISSING_CHECKIN' as DrillFilterType,
                    label: 'ไม่พบสแกนเข้างาน',
                    count: statusMissingInCount,
                    color: statusMissingInCount > 0 ? 'text-[#C74455]' : 'text-[#777287]',
                  },
                  {
                    key: 'MISSING_CHECKOUT' as DrillFilterType,
                    label: 'ไม่สแกนออกงาน',
                    count: statusMissingOutCount,
                    color: statusMissingOutCount > 0 ? 'text-[#B87516]' : 'text-[#777287]',
                  },
                  {
                    key: 'EARLY_CHECKOUT' as DrillFilterType,
                    label: 'ออกงานก่อนเวลา',
                    count: earlyCheckoutCount,
                    color: earlyCheckoutCount > 0 ? 'text-[#C74455]' : 'text-[#777287]',
                  },
                  {
                    key: 'NEEDS_RE_REVIEW' as DrillFilterType,
                    label: 'ต้องตรวจสอบซ้ำหลังคำนวณใหม่',
                    count: needsReReviewCount,
                    color: needsReReviewCount > 0 ? 'text-[#B87516]' : 'text-[#777287]',
                  },
                ].map((row) => (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => openKpiDrilldown(row.key)}
                    className="w-full px-5 py-3 hover:bg-[#F8F7FC] flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                  >
                    <span className="text-[13.5px] font-medium text-[#292638]">{row.label}</span>
                    <span className={`font-mono font-bold text-[13.5px] tabular-nums ${row.color}`}>
                      {row.count}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </div>

          {/* 5. Department Summary Table */}
          <div className="ent-table-wrapper">
            <div className="px-5 py-4 border-b border-[#E8E4EF] flex flex-wrap items-center justify-between gap-2 bg-white">
              <SectionHeader
                title="สรุปผลการลงเวลาแยกตามกลุ่มงาน / หน่วยงาน"
                subtitle="เปรียบเทียบจำนวนบุคลากรที่มาสาย (ไม่ซ้ำคน) จำนวนครั้งที่สาย และจำนวนเวรที่ไม่พบข้อมูลสแกน"
              />
              <span className="text-[12.5px] font-medium text-[#777287]">
                {resolvedRange.thaiPeriodLabel}
              </span>
            </div>

            {/* Mobile Card View (< md) */}
            <div className="md:hidden divide-y divide-[#E8E4EF]">
              {data.departmentBreakdown?.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#777287]">
                  ไม่มีข้อมูลการลงเวลาในช่วงเวลาที่เลือก
                </div>
              ) : (
                data.departmentBreakdown?.map((d: any) => (
                  <div key={d.departmentName} className="p-4 space-y-2 bg-white">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[14.5px] text-[#292638]">{d.departmentName}</span>
                      <span className="font-mono text-[13px] font-semibold text-[#777287] tabular-nums">
                        {d.totalShifts} เวร
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-mono tabular-nums">
                      <span className="text-[#B87516] font-semibold">
                        สาย {d.latePeople} คน ({d.lateOccurrences} ครั้ง)
                      </span>
                      <span className="text-[#292638] font-semibold">{d.totalLateMinutes} น.</span>
                      <span className="text-[#C74455] font-semibold">ขาดสแกน {d.noScanCount} เวร</span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table View (>= md) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>กลุ่มงาน / หน่วยงาน</th>
                    <th className="text-right">เวรปฏิบัติงานทั้งหมด</th>
                    <th className="text-right">จำนวนคนที่สาย (ไม่ซ้ำคน)</th>
                    <th className="text-right">จำนวนครั้งที่สาย</th>
                    <th className="text-right">นาทีสายสะสม</th>
                    <th className="text-right">ไม่พบข้อมูลสแกน</th>
                  </tr>
                </thead>
                <tbody>
                  {data.departmentBreakdown?.length === 0 ? (
                    <TableEmptyState colSpan={6} title="ไม่มีข้อมูลการลงเวลาในช่วงเวลาที่เลือก" />
                  ) : (
                    data.departmentBreakdown?.map((d: any) => (
                      <tr key={d.departmentName}>
                        <td className="font-semibold text-[#292638]">{d.departmentName}</td>
                        <td className="text-right font-mono tabular-nums">{d.totalShifts} เวร</td>
                        <td className="text-right font-mono tabular-nums text-[#B87516] font-semibold">
                          {d.latePeople} คน
                        </td>
                        <td className="text-right font-mono tabular-nums">{d.lateOccurrences} ครั้ง</td>
                        <td className="text-right font-mono tabular-nums font-bold">
                          {d.totalLateMinutes} นาที
                        </td>
                        <td className="text-right font-mono tabular-nums text-[#C74455] font-semibold">
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
            <div className="px-5 py-4 border-b border-[#E8E4EF] bg-white flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
              <SectionHeader
                title="ตารางสรุปสถิติการลงเวลารายบุคคล"
                subtitle="จัดเรียงตามนาทีสายสะสม จำนวนครั้งที่มาสาย บุคลากรตรงเวลาดีเด่น หรือรายการไม่สมบูรณ์"
              />

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
                  <Search
                    className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    aria-label="ค้นหาบุคลากรในตารางจัดอันดับ"
                    value={rankSearch}
                    onChange={(e) => {
                      setRankSearch(e.target.value);
                      setRankPage(1);
                    }}
                    placeholder="ค้นหาชื่อ หรือ รหัสบุคลากร..."
                    className="ent-input ent-input-with-icon pr-4 w-full"
                  />
                </div>
              </div>
            </div>

            {/* Mobile View (< md) */}
            <div className="md:hidden divide-y divide-[#E8E4EF]">
              {pagedRanking.length === 0 ? (
                <div className="p-8 text-center text-[14px] text-[#777287]">
                  ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา
                </div>
              ) : (
                pagedRanking.map((p: any, idx: number) => (
                  <div key={p.personId} className="p-4 space-y-2 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="font-mono text-[12.5px] font-bold text-[#8066B5] mr-1.5 tabular-nums">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </span>
                        <span className="font-bold text-[14.5px] text-[#292638]">{p.fullName}</span>
                        <div className="text-[12.5px] text-[#777287] mt-0.5">
                          <span className="font-mono">{p.personId}</span> · {p.departmentName}
                        </div>
                      </div>
                      <span className="font-mono text-[12.5px] text-[#777287] shrink-0 tabular-nums">
                        {p.totalShifts} เวร
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-mono tabular-nums">
                      <span className="text-[#B87516] font-semibold">สาย {p.lateOccurrences} ครั้ง</span>
                      <span className="text-[#292638] font-bold">รวม {p.totalLateMinutes} น.</span>
                      <span className="text-[#C74455] font-semibold">
                        ขาด/ไม่สแกนออก {p.noScanCount}/{p.missingCheckoutCount}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table View (>= md) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>ลำดับ</th>
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
                <tbody>
                  {pagedRanking.length === 0 ? (
                    <TableEmptyState colSpan={8} title="ไม่พบข้อมูลบุคลากรตามเงื่อนไขที่ค้นหา" />
                  ) : (
                    pagedRanking.map((p: any, idx: number) => (
                      <tr key={p.personId}>
                        <td className="font-mono tabular-nums font-semibold text-[#777287]">
                          #{(rankPageSize === 'ALL' ? 0 : (rankPage - 1) * rankPageSize) + idx + 1}
                        </td>
                        <td>
                          <div className="font-semibold text-[14px] text-[#292638]">{p.fullName}</div>
                          <div className="text-[12px] text-[#777287] font-mono mt-0.5">
                            {p.personId} · {p.personnelTypeName}
                          </div>
                        </td>
                        <td>{p.departmentName}</td>
                        <td className="text-right font-mono tabular-nums">{p.totalShifts}</td>
                        <td className="text-right font-mono tabular-nums font-semibold text-[#B87516]">
                          {p.lateOccurrences} ครั้ง
                        </td>
                        <td className="text-right font-mono tabular-nums font-bold">
                          {p.totalLateMinutes} นาที
                        </td>
                        <td className="text-right font-mono tabular-nums text-[#777287]">
                          {p.avgLateMinutesPerOccurrence}
                        </td>
                        <td className="text-right font-mono tabular-nums text-[#C74455] font-semibold">
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
        {(() => {
          const allRows = drillModal?.rows || [];
          const pagedDrillRows =
            drillPageSize === 'ALL'
              ? allRows
              : allRows.slice((drillPage - 1) * drillPageSize, drillPage * drillPageSize);
          return (
            <div className="-mx-5 sm:-mx-6 -my-5">
              <div className="overflow-x-auto">
                <table className="his-table text-[13.5px]">
                  <thead>
                    <tr>
                      <th>วันที่ปฏิบัติงาน</th>
                      <th>ชื่อ-นามสกุล · รหัสบุคลากร</th>
                      <th>กะปฏิบัติงาน</th>
                      <th>เวลาเข้า / เวลาออก</th>
                      <th className="text-right">นาทีสาย</th>
                      <th>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {drillModal?.loading ? (
                      <tr>
                        <td colSpan={6} className="py-10 text-center text-[14px] text-[#777287]">
                          กำลังดึงรายละเอียดรายการลงเวลาจากฐานข้อมูล...
                        </td>
                      </tr>
                    ) : pagedDrillRows.length === 0 ? (
                      <TableEmptyState
                        colSpan={6}
                        title="ไม่มีรายการในหมวดหมู่นี้สำหรับช่วงเวลาที่เลือก"
                      />
                    ) : (
                      pagedDrillRows.map((r: any) => (
                        <tr key={r.id}>
                          <td className="font-mono tabular-nums whitespace-nowrap">
                            {formatThaiDate(r.work_date)}
                          </td>
                          <td>
                            <div className="font-semibold text-[#292638]">{r.full_name}</div>
                            <div className="text-[12px] font-mono text-[#777287]">{r.person_id}</div>
                          </td>
                          <td className="whitespace-nowrap">{r.shift_name}</td>
                          <td className="font-mono tabular-nums whitespace-nowrap">
                            {r.check_in_time?.slice(11, 16) || '—'} /{' '}
                            {r.check_out_time?.slice(11, 16) || '—'}
                          </td>
                          <td className="text-right font-mono tabular-nums font-bold text-[#B87516] whitespace-nowrap">
                            {r.late_minutes > 0 ? `${r.late_minutes} นาที` : '0'}
                          </td>
                          <td className="whitespace-nowrap">
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
              {allRows.length > 0 && (
                <TablePaginationBar
                  totalItems={allRows.length}
                  currentPage={drillPage}
                  pageSize={drillPageSize}
                  onPageChange={setDrillPage}
                  onPageSizeChange={setDrillPageSize}
                />
              )}
            </div>
          );
        })()}
      </SharedModal>
    </div>
  );
}
