/**
 * ============================================================================
 * หน้าจัดการเครื่องสแกนและตรวจสอบข้อมูลสแกนต้นฉบับ 6 ฟิลด์ (Scanners & Immutable Raw Scans)
 * ไฟล์: frontend/src/pages/RawScansView.tsx
 * ============================================================================
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  RefreshCw,
  Upload,
  Plus,
  PanelRightOpen,
  CheckCircle2,
  AlertTriangle,
  Radio,
  Search,
  Eye,
  CalendarClock,
  Info,
  Clock,
  History,
  ChevronDown,
  ChevronUp,
  Wrench,
  RotateCcw,
  ShieldCheck,
  Lock,
} from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SectionHeader,
  MetricStrip,
  StatusBadge,
  TabBar,
  SlideOverDrawer,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  TableEmptyState,
  TableLoadingSkeleton,
  RequiredMark,
  SharedModal,
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  getCurrentBangkokDateParts,
} from '../utils/thaiFormat.ts';

type SyncHistoryPeriod = 'TODAY' | '7D' | '30D' | 'CUSTOM' | 'ALL';
type ScannerSyncMode = 'TODAY' | 'CUSTOM_RANGE' | 'MONTHLY' | 'FULL_HISTORICAL';
type ScannerTabKey = 'SYNC' | 'DEVICES' | 'SCHEDULES' | 'HISTORY';

const THAI_MONTH_NAMES = [
  'มกราคม',
  'กุมภาพันธ์',
  'มีนาคม',
  'เมษายน',
  'พฤษภาคม',
  'มิถุนายน',
  'กรกฎาคม',
  'สิงหาคม',
  'กันยายน',
  'ตุลาคม',
  'พฤศจิกายน',
  'ธันวาคม',
];

function formatThaiYearMonth(ym?: string | null): string {
  if (!ym || !/^\d{4}-\d{2}$/.test(ym)) return ym || '-';
  const [y, m] = ym.split('-').map(Number);
  const name = THAI_MONTH_NAMES[m - 1] || String(m);
  return `${name} ${y + 543} (${ym})`;
}

function getPreviousYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

function formatJobStageLabel(stage?: string | null): string | null {
  switch (String(stage || '').toUpperCase()) {
    case 'READING_SCANNER':
      return 'ขั้นที่ 1/4 อ่านข้อมูลจากเครื่องสแกน';
    case 'DEDUPLICATING':
      return 'ขั้นที่ 2/4 คัดกรองและตรวจสอบรายการซ้ำ';
    case 'MAPPING':
      return 'ขั้นที่ 3/4 จับคู่รหัสสแกนกับทะเบียนบุคลากร';
    case 'PROCESSING_ATTENDANCE':
      return 'ขั้นที่ 4/4 ประมวลผลเวลาปฏิบัติงานและตารางเวร';
    case 'PARTIAL_SUCCESS':
      return 'เสร็จสิ้นบางส่วน (บางเครื่องเชื่อมต่อไม่ได้)';
    case 'COMPLETED':
      return 'ดำเนินการเสร็จสมบูรณ์';
    case 'FAILED':
      return 'ดำเนินการไม่สำเร็จ';
    default:
      return null;
  }
}

function shiftYmdDays(baseYmd: string, deltaDays: number): string {
  const [y, m, d] = baseYmd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(
    dt.getUTCDate()
  ).padStart(2, '0')}`;
}

function diffYmdDays(startYmd: string, endYmd: string): number {
  const [sy, sm, sd] = startYmd.split('-').map(Number);
  const [ey, em, ed] = endYmd.split('-').map(Number);
  return Math.round((Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / 86_400_000);
}

function isValidCalendarYmd(ymd: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() + 1 === month &&
    dt.getUTCDate() === day
  );
}

function formatSyncScopeLabel(scopeMode?: string | null): string {
  const mode = String(scopeMode || 'ALL').toUpperCase();
  if (mode === 'TODAY') return 'ดึงข้อมูลวันนี้';
  if (mode === 'CUSTOM_RANGE') return 'กำหนดช่วงวันที่และเวลา';
  if (mode === 'MONTHLY') return 'ดึงข้อมูลรายเดือน';
  if (mode === 'FULL_HISTORICAL' || mode === 'ALL' || mode === 'ALL_SUPPORTED') {
    return 'ดึงข้อมูลย้อนหลังทั้งหมด (Admin)';
  }
  return 'ดึงข้อมูลทั้งหมดที่รองรับ';
}

function formatFilterStrategyLabel(strategy?: string | null): string {
  if (strategy === 'BACKEND_POST_READ_FILTER') {
    return 'อ่านจากโปรแกรมเครื่องสแกน แล้วคัดกรองช่วงเวลาบน Backend ก่อนบันทึก';
  }
  if (strategy === 'EXE_DAYS_WINDOW_NO_POST_FILTER') {
    return 'อ่านจากโปรแกรม ScannerSyncCli.exe ตามจำนวนวันสูงสุดโดยไม่ตัดช่วงเวลาย่อย';
  }
  if (strategy === 'ALL_DEVICE_EVENTS_NO_POST_FILTER') {
    return 'อ่านข้อมูลทั้งหมดจากโปรแกรมเครื่องสแกนโดยไม่ตัดช่วงเวลาย่อย';
  }
  return 'ดึงข้อมูลตามรอบปกติ';
}

function renderUsageStatus(rs: any) {
  if (!rs.matched_person_id) {
    return (
      <StatusBadge
        tone="danger"
        label={`ยังไม่ถูกจับคู่ (${rs.mapping_state || 'UNMATCHED'})`}
        compact
      />
    );
  }
  if (rs.usage_role === 'CHECK_IN') {
    return (
      <StatusBadge
        tone="success"
        label={`ใช้เป็น IN (${rs.used_shift_code || `เวร #${rs.used_attendance_id}`})`}
        compact
      />
    );
  }
  if (rs.usage_role === 'CHECK_OUT') {
    return (
      <StatusBadge
        tone="info"
        label={`ใช้เป็น OUT (${rs.used_shift_code || `เวร #${rs.used_attendance_id}`})`}
        compact
      />
    );
  }
  return <StatusBadge tone="neutral" label="สแกนเพิ่มเติม" icon={null} compact />;
}

export function RawScansView({
  mode,
  user,
  onNavigate,
}: {
  mode: 'rawScans' | 'scanners';
  user: AuthUser;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);
  const [activeScannerTab, setActiveScannerTab] = useState<ScannerTabKey>('SYNC');
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);

  const [rawScans, setRawScans] = useState<any[]>([]);
  const [scannerData, setScannerData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [mappingState, setMappingState] = useState('');
  const [scanDateFrom, setScanDateFrom] = useState('');
  const [scanDateTo, setScanDateTo] = useState('');
  const [onlyMultiScan, setOnlyMultiScan] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sync Runs History Filters & Pagination
  const [historyPeriod, setHistoryPeriod] = useState<SyncHistoryPeriod>('30D');
  const [historyDateFrom, setHistoryDateFrom] = useState(initialBkk.monthStartYmd);
  const [historyDateTo, setHistoryDateTo] = useState(initialBkk.todayYmd);
  const [historyMachineNo, setHistoryMachineNo] = useState('');
  const [historyStatus, setHistoryStatus] = useState('ALL');
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState<PageSizeOption>(10);
  const [selectedSyncRunDetail, setSelectedSyncRunDetail] = useState<any | null>(null);

  // Immediate Scanner Sync Controls + Confirm & Reauth & Progress Dialog
  const [syncMode, setSyncMode] = useState<ScannerSyncMode>('TODAY');
  const [syncYearMonth, setSyncYearMonth] = useState(initialBkk.todayYmd.slice(0, 7));
  const [syncDateFrom, setSyncDateFrom] = useState(initialBkk.todayYmd);
  const [syncTimeFrom, setSyncTimeFrom] = useState('00:00');
  const [syncDateTo, setSyncDateTo] = useState(initialBkk.todayYmd);
  const [syncTimeTo, setSyncTimeTo] = useState('23:59');
  const [syncMachineNo, setSyncMachineNo] = useState('');
  const [lastSyncResult, setLastSyncResult] = useState<any | null>(null);
  const [confirmSyncOpen, setConfirmSyncOpen] = useState(false);
  const [impactAcknowledged, setImpactAcknowledged] = useState(false);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [reauthError, setReauthError] = useState<string | null>(null);
  const [syncingHardware, setSyncingHardware] = useState(false);
  const [syncProgressOpen, setSyncProgressOpen] = useState(false);
  const [syncStepLabel, setSyncStepLabel] = useState('กำลังเชื่อมต่อเครื่องสแกนลายนิ้วมือ...');
  const [syncStageLabel, setSyncStageLabel] = useState<string | null>(null);
  const [syncPercent, setSyncPercent] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<'RUNNING' | 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED'>(
    'RUNNING'
  );
  const [syncSummaryText, setSyncSummaryText] = useState<string | null>(null);
  const [syncErrorText, setSyncErrorText] = useState<string | null>(null);

  // Sorting & Pagination for Raw Scans
  const [sortKey, setSortKey] = useState('canonical_bkk_time');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  // Raw Scan Payload Drawer
  const [selectedScanModal, setSelectedScanModal] = useState<any | null>(null);

  // New Scanner Device form (ADMIN only)
  const [machineNo, setMachineNo] = useState(4);
  const [deviceName, setDeviceName] = useState('');
  const [ipAddress, setIpAddress] = useState('192.168.10.104');
  const [locationName, setLocationName] = useState('');

  // New Schedule form (ADMIN only)
  const [scheduleLabel, setScheduleLabel] = useState('');
  const [cronTime, setCronTime] = useState('12:30');

  // 6-Field EXE Contract Payload Ingestion (ADMIN only)
  const [jsonPayloadText, setJsonPayloadText] = useState(() =>
    JSON.stringify(
      [
        {
          machineNo: 1,
          enrollNumber: '1001',
          scanDateTime: `${initialBkk.todayYmd} 07:48:00`,
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
        {
          machineNo: 1,
          enrollNumber: '1001',
          scanDateTime: `${initialBkk.todayYmd} 16:04:00`,
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
      ],
      null,
      2
    )
  );

  const loadSyncHistory = useCallback(async () => {
    try {
      const qs = new URLSearchParams({
        period: historyPeriod,
        status: historyStatus,
        page: String(historyPage),
        pageSize: String(historyPageSize === 'ALL' ? 200 : historyPageSize),
        ...(historyPeriod === 'CUSTOM'
          ? { dateFrom: historyDateFrom, dateTo: historyDateTo }
          : {}),
        ...(historyMachineNo ? { machineNo: historyMachineNo } : {}),
      });
      const res = await apiRequest(`/sync-runs?${qs.toString()}`);
      setHistoryItems(res.items || []);
      setHistoryTotal(Number(res.total || (res.items || []).length));
    } catch {
      // fallback silently
    }
  }, [
    historyPeriod,
    historyStatus,
    historyPage,
    historyPageSize,
    historyDateFrom,
    historyDateTo,
    historyMachineNo,
  ]);

  const loadData = useCallback(
    async (clearError = true) => {
      setLoading(true);
      if (clearError) {
        setError(null);
      }
      try {
        const qs = new URLSearchParams({
          ...(search ? { search } : {}),
          ...(machineFilter ? { machineNo: machineFilter } : {}),
          ...(mappingState ? { mappingState } : {}),
        });
        const [rsRes, scRes] = await Promise.all([
          apiRequest(`/raw-scans?${qs.toString()}`),
          apiRequest('/scanners'),
        ]);
        setRawScans(rsRes.items || []);
        setScannerData(scRes);
      } catch (err) {
        if (err instanceof ApiClientError) {
          setError({ code: err.code, message: err.message });
        } else {
          setError({ message: 'ไม่สามารถดึงข้อมูลสแกนต้นฉบับหรือเครื่องสแกนได้' });
        }
      } finally {
        setLoading(false);
      }
    },
    [search, machineFilter, mappingState]
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    loadSyncHistory();
  }, [loadSyncHistory]);

  // กู้คืนสถานะการซิงก์เครื่องสแกนหากรีเฟรชหน้าจอระหว่างทำงาน
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    async function checkActiveScannerJob() {
      try {
        const res = await apiRequest('/jobs/active?type=SCANNER_MANUAL_SYNC');
        if (res?.inProgress && res?.activeJob) {
          setSyncingHardware(true);
          setSyncProgressOpen(true);
          setSyncStatus('RUNNING');
          setSyncStepLabel(res.activeJob.currentStep || 'กำลังดึงข้อมูลจากเครื่องสแกน...');
          setSyncStageLabel(formatJobStageLabel(res.activeJob.stage));
          setSyncPercent(
            typeof res.activeJob.progressPercent === 'number'
              ? Math.min(99, res.activeJob.progressPercent)
              : null
          );
        } else if (syncingHardware && res?.latestJob && res.latestJob.status !== 'RUNNING') {
          setSyncingHardware(false);
          const latestStatus =
            res.latestJob.status === 'SUCCESS'
              ? 'SUCCESS'
              : res.latestJob.status === 'PARTIAL_SUCCESS'
                ? 'PARTIAL_SUCCESS'
                : 'FAILED';
          setSyncPercent(latestStatus === 'FAILED' ? null : 100);
          setSyncStatus(latestStatus);
          setSyncStageLabel(formatJobStageLabel(res.latestJob.stage || latestStatus));
          setSyncStepLabel(res.latestJob.currentStep || 'ดำเนินการเสร็จสิ้น');
          await loadData(false);
          await loadSyncHistory();
        }
      } catch {
        // ignore
      }
    }
    checkActiveScannerJob();
    if (syncingHardware) {
      timer = setInterval(checkActiveScannerJob, 1500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [syncingHardware, loadData, loadSyncHistory]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('DESC');
    }
    setPage(1);
  }

  const filteredAndSortedScans = useMemo(() => {
    let list = [...rawScans];

    if (scanDateFrom) {
      list = list.filter((s) => String(s.canonical_bkk_time || '').slice(0, 10) >= scanDateFrom);
    }
    if (scanDateTo) {
      list = list.filter((s) => String(s.canonical_bkk_time || '').slice(0, 10) <= scanDateTo);
    }

    if (onlyMultiScan) {
      const counts = new Map<string, number>();
      for (const s of list) {
        const key = `${s.enroll_number}:${String(s.canonical_bkk_time || '').slice(0, 10)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      list = list.filter(
        (s) =>
          (counts.get(`${s.enroll_number}:${String(s.canonical_bkk_time || '').slice(0, 10)}`) ||
            0) > 1
      );
    }

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
  }, [rawScans, scanDateFrom, scanDateTo, onlyMultiScan, sortKey, sortDir]);

  const pagedScans = useMemo(() => {
    if (pageSize === 'ALL') return filteredAndSortedScans;
    const start = (page - 1) * pageSize;
    return filteredAndSortedScans.slice(start, start + pageSize);
  }, [filteredAndSortedScans, page, pageSize]);

  const maxSyncRangeDays = Number(scannerData?.syncRangeCapabilities?.maxRangeDays || 90);
  const devices: any[] = scannerData?.devices || [];
  const schedules: any[] = scannerData?.schedules || [];
  const activeDevicesCount = devices.filter((d) => Number(d.is_enabled) === 1).length;
  const activeSchedulesCount = schedules.filter((s) => Number(s.is_enabled) === 1).length;
  const unmatchedRawCount = useMemo(
    () => rawScans.filter((r) => !r.matched_person_id).length,
    [rawScans]
  );

  const hasActiveRawScanFilters = Boolean(
    search || machineFilter || mappingState || scanDateFrom || scanDateTo || onlyMultiScan
  );

  const isAdmin = user.role === 'ADMIN';
  const defaultCurrentYm = initialBkk.todayYmd.slice(0, 7);
  const defaultPrevYm = getPreviousYearMonth(defaultCurrentYm);
  const roleSyncPolicy = scannerData?.roleSyncPolicy || {
    role: user.role,
    canFullHistorical: isAdmin,
    currentYearMonth: defaultCurrentYm,
    previousYearMonth: defaultPrevYm,
    allowedYearMonths: isAdmin ? null : [defaultCurrentYm, defaultPrevYm],
    earliestAllowedYmd: isAdmin ? null : `${defaultPrevYm}-01`,
    requiresImpactAndPasswordModes: ['MONTHLY', 'FULL_HISTORICAL', 'ALL'],
  };
  const requiresReauth = syncMode === 'MONTHLY' || syncMode === 'FULL_HISTORICAL';

  const syncRangeValidation = useMemo(() => {
    if (syncMode === 'FULL_HISTORICAL') {
      if (!isAdmin) {
        return {
          valid: false,
          message: 'โหมดดึงข้อมูลย้อนหลังทั้งหมดสงวนสิทธิ์เฉพาะผู้ดูแลระบบ (ADMIN) เท่านั้น',
          spanDays: null,
        };
      }
      return { valid: true, message: null as string | null, spanDays: maxSyncRangeDays };
    }
    if (syncMode === 'MONTHLY') {
      if (!/^\d{4}-\d{2}$/.test(syncYearMonth)) {
        return {
          valid: false,
          message: 'กรุณาเลือกเดือนที่ต้องการดึงข้อมูล (รูปแบบ YYYY-MM)',
          spanDays: null,
        };
      }
      if (
        !isAdmin &&
        Array.isArray(roleSyncPolicy.allowedYearMonths) &&
        !roleSyncPolicy.allowedYearMonths.includes(syncYearMonth)
      ) {
        return {
          valid: false,
          message: `สิทธิ์เจ้าหน้าที่ผู้รับผิดชอบ (RESPONSIBLE_STAFF) สามารถดึงข้อมูลย้อนหลังได้เฉพาะเดือนปัจจุบัน (${formatThaiYearMonth(roleSyncPolicy.currentYearMonth)}) และเดือนก่อนหน้า 1 เดือน (${formatThaiYearMonth(roleSyncPolicy.previousYearMonth)}) เท่านั้น`,
          spanDays: null,
        };
      }
      return { valid: true, message: null as string | null, spanDays: 31 };
    }
    if (syncMode !== 'CUSTOM_RANGE') {
      return {
        valid: true,
        message: null as string | null,
        spanDays: syncMode === 'TODAY' ? 1 : null,
      };
    }
    if (!syncDateFrom || !syncDateTo) {
      return {
        valid: false,
        message: 'กรุณาระบุทั้ง "ตั้งแต่วันที่" และ "ถึงวันที่"',
        spanDays: null,
      };
    }
    if (!isValidCalendarYmd(syncDateFrom) || !isValidCalendarYmd(syncDateTo)) {
      return {
        valid: false,
        message: 'รูปแบบวันที่ไม่ถูกต้องตามปฏิทิน กรุณาเลือกวันที่ใหม่',
        spanDays: null,
      };
    }
    if (
      !isAdmin &&
      roleSyncPolicy.earliestAllowedYmd &&
      syncDateFrom < roleSyncPolicy.earliestAllowedYmd
    ) {
      return {
        valid: false,
        message: `สิทธิ์เจ้าหน้าที่ผู้รับผิดชอบดึงข้อมูลย้อนหลังได้ตั้งแต่วันที่ ${formatThaiDate(roleSyncPolicy.earliestAllowedYmd)} เป็นต้นไปเท่านั้น (เดือนปัจจุบันและเดือนก่อนหน้า 1 เดือน)`,
        spanDays: null,
      };
    }
    if (
      !/^\d{2}:\d{2}(:\d{2})?$/.test(syncTimeFrom) ||
      !/^\d{2}:\d{2}(:\d{2})?$/.test(syncTimeTo)
    ) {
      return {
        valid: false,
        message: 'รูปแบบเวลาเริ่มต้นหรือเวลาสิ้นสุดไม่ถูกต้อง (ต้องเป็น HH:mm)',
        spanDays: null,
      };
    }
    const startKey = `${syncDateFrom} ${syncTimeFrom.slice(0, 5)}:00`;
    const endKey = `${syncDateTo} ${syncTimeTo.slice(0, 5)}:00`;
    if (startKey > endKey) {
      return {
        valid: false,
        message: `วันและเวลาเริ่มต้น (${formatThaiDate(syncDateFrom)} ${syncTimeFrom} น.) ต้องไม่มากกว่าวันและเวลาสิ้นสุด (${formatThaiDate(syncDateTo)} ${syncTimeTo} น.)`,
        spanDays: null,
      };
    }
    const spanDays = diffYmdDays(syncDateFrom, syncDateTo) + 1;
    if (spanDays > maxSyncRangeDays) {
      return {
        valid: false,
        message: `ช่วงวันที่ที่เลือก (${spanDays} วัน) เกินขีดจำกัดสูงสุดของระบบ (${maxSyncRangeDays} วันต่อรอบ) กรุณาลดช่วงวันที่ลง`,
        spanDays,
      };
    }
    return { valid: true, message: null as string | null, spanDays };
  }, [
    syncMode,
    isAdmin,
    syncYearMonth,
    roleSyncPolicy.allowedYearMonths,
    roleSyncPolicy.currentYearMonth,
    roleSyncPolicy.previousYearMonth,
    roleSyncPolicy.earliestAllowedYmd,
    syncDateFrom,
    syncTimeFrom,
    syncDateTo,
    syncTimeTo,
    maxSyncRangeDays,
  ]);

  const syncScopeDescription = useMemo(() => {
    const machineText = syncMachineNo
      ? `เครื่องสแกนหมายเลข #${syncMachineNo}`
      : 'ทุกเครื่องสแกนที่เปิดใช้งาน';
    if (syncMode === 'TODAY') {
      return `โหมดดึงข้อมูลวันนี้ (${formatThaiDate(initialBkk.todayYmd)} เวลา 00:00 – 23:59 น. เวลาประเทศไทย) · เป้าหมาย: ${machineText}`;
    }
    if (syncMode === 'MONTHLY') {
      return `โหมดดึงข้อมูลรายเดือน: ประจำเดือน ${formatThaiYearMonth(syncYearMonth)} (วันที่ 1 – สิ้นเดือน · Asia/Bangkok) · เป้าหมาย: ${machineText}`;
    }
    if (syncMode === 'CUSTOM_RANGE') {
      return `โหมดเลือกช่วงวันที่และเวลา: ${formatThaiDate(syncDateFrom)} ${syncTimeFrom} น. ถึง ${formatThaiDate(syncDateTo)} ${syncTimeTo} น. (${syncRangeValidation.spanDays || 1} วัน · เขตเวลา Asia/Bangkok) · เป้าหมาย: ${machineText}`;
    }
    return `โหมดดึงข้อมูลย้อนหลังทั้งหมด (Admin เท่านั้น · สูงสุด ${maxSyncRangeDays} วันตามข้อจำกัดของโปรแกรมอ่านเครื่องสแกน) · เป้าหมาย: ${machineText}`;
  }, [
    syncMode,
    syncYearMonth,
    syncMachineNo,
    initialBkk.todayYmd,
    syncDateFrom,
    syncTimeFrom,
    syncDateTo,
    syncTimeTo,
    syncRangeValidation.spanDays,
    maxSyncRangeDays,
  ]);

  function handleRequestOpenSyncConfirm() {
    if (syncingHardware) return;
    if (!syncRangeValidation.valid) {
      setError({
        code: 'INVALID_DATE_TIME_RANGE',
        message: syncRangeValidation.message || 'ช่วงวันที่และเวลาที่เลือกไม่ถูกต้อง',
      });
      return;
    }
    setError(null);
    setReauthError(null);
    setImpactAcknowledged(false);
    setConfirmPassword('');
    setConfirmSyncOpen(true);
  }

  function handleCloseSyncConfirm() {
    setConfirmSyncOpen(false);
    setImpactAcknowledged(false);
    setConfirmPassword('');
    setReauthError(null);
  }

  async function handleConfirmTriggerHardwareSync() {
    if (!syncRangeValidation.valid) {
      handleCloseSyncConfirm();
      setError({
        code: 'INVALID_DATE_TIME_RANGE',
        message: syncRangeValidation.message || 'ช่วงวันที่และเวลาที่เลือกไม่ถูกต้อง',
      });
      return;
    }

    if (requiresReauth) {
      if (!impactAcknowledged) {
        setReauthError('กรุณาทำเครื่องหมายรับทราบผลกระทบของการดึงข้อมูลย้อนหลังก่อนดำเนินการ');
        return;
      }
      if (!confirmPassword.trim()) {
        setReauthError('กรุณากรอกรหัสผ่านบัญชีปัจจุบันของคุณเพื่อยืนยันตัวตน');
        return;
      }
    }

    const passwordToSend = confirmPassword;
    setReauthError(null);
    setError(null);
    setNotice(null);

    if (!requiresReauth) {
      setConfirmSyncOpen(false);
      setSyncProgressOpen(true);
    }
    setSyncingHardware(true);
    setSyncStatus('RUNNING');
    setSyncStageLabel('ขั้นที่ 1/4 อ่านข้อมูลจากเครื่องสแกน');
    setSyncStepLabel('กำลังเชื่อมต่อเครื่องสแกนและอ่านข้อมูลสแกน 6 ฟิลด์...');
    setSyncPercent(null);
    setSyncSummaryText(null);
    setSyncErrorText(null);

    try {
      const payload: Record<string, unknown> = {
        syncMode,
      };
      if (syncMachineNo) {
        payload.machineNo = Number(syncMachineNo);
      }
      if (syncMode === 'MONTHLY') {
        payload.yearMonth = syncYearMonth;
      } else if (syncMode === 'CUSTOM_RANGE') {
        payload.dateFrom = syncDateFrom;
        payload.timeFrom = syncTimeFrom;
        payload.dateTo = syncDateTo;
        payload.timeTo = syncTimeTo;
      }
      if (requiresReauth) {
        payload.impactAcknowledged = impactAcknowledged;
        payload.confirmPassword = passwordToSend;
      }

      // เคลียร์รหัสผ่านออกจาก state ทันทีหลังเตรียม payload
      setConfirmPassword('');

      const res = await apiRequest('/scanners/sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setConfirmSyncOpen(false);
      setImpactAcknowledged(false);
      setSyncProgressOpen(true);

      const readDevice = Number(res.totalReadFromDevice ?? res.totalRead ?? 0);
      const matchedInRange = Number(res.matchedInRange ?? readDevice);
      const filteredOut = Number(res.filteredOutCount ?? 0);
      const newInserted = Number(res.newInserted ?? 0);
      const dupSkipped = Number(res.duplicatesSkipped ?? 0);
      const failedCount = Number(res.failedCount ?? 0);
      const matchedScansCount = Number(res.matchedScansCount ?? 0);
      const attUpdated = Number(res.attendanceUpdatedCount ?? 0);
      const attCreated = Number(res.attendanceCreatedCount ?? 0);
      const isPartial = res.status === 'PARTIAL_SUCCESS';

      const basePrefix = isPartial ? 'ดึงข้อมูลสำเร็จบางส่วน' : 'ดึงข้อมูลสำเร็จ';
      const summary =
        syncMode === 'FULL_HISTORICAL'
          ? `${basePrefix}: อ่านจากเครื่อง ${readDevice} · บันทึกใหม่ ${newInserted} · ข้ามซ้ำ ${dupSkipped} · จับคู่บุคลากร ${matchedScansCount} · อัปเดตเวร ${attCreated + attUpdated} รายการ${failedCount > 0 ? ` · ไม่สำเร็จ ${failedCount}` : ''}`
          : `${basePrefix}: อ่านจากเครื่อง ${readDevice} · ตรงช่วง ${matchedInRange} (กรองออก ${filteredOut}) · บันทึกใหม่ ${newInserted} · ข้ามซ้ำ ${dupSkipped} · จับคู่บุคลากร ${matchedScansCount} · อัปเดตเวร ${attCreated + attUpdated} รายการ`;

      setLastSyncResult(res);
      setSyncPercent(100);
      setSyncStatus(isPartial ? 'PARTIAL_SUCCESS' : 'SUCCESS');
      setSyncStageLabel(formatJobStageLabel(isPartial ? 'PARTIAL_SUCCESS' : 'COMPLETED'));
      setSyncStepLabel(
        isPartial
          ? 'ดึงข้อมูลสำเร็จบางส่วน (บางเครื่องเชื่อมต่อไม่สำเร็จ แต่บันทึกข้อมูลจากเครื่องที่ปกติเรียบร้อยแล้ว)'
          : 'ดึงข้อมูลจากเครื่องสแกน จับคู่บุคลากร และคำนวณเวลาเสร็จสมบูรณ์'
      );
      setSyncSummaryText(res.warningMessage ? `${summary} — ${res.warningMessage}` : summary);
      setNotice(res.warningMessage ? `${summary} (${res.warningMessage})` : summary);
      await loadData(false);
      await loadSyncHistory();
    } catch (err) {
      setConfirmPassword('');
      const errCode = err instanceof ApiClientError ? err.code : undefined;
      const errMsg =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'ไม่สามารถดึงข้อมูลจากเครื่องสแกนได้';

      const isReauthOrPolicyError =
        requiresReauth &&
        err instanceof ApiClientError &&
        (err.status === 400 ||
          err.status === 401 ||
          err.status === 403 ||
          err.status === 429 ||
          errCode === 'INVALID_CONFIRM_PASSWORD' ||
          errCode === 'REAUTH_PASSWORD_REQUIRED' ||
          errCode === 'IMPACT_ACK_REQUIRED' ||
          errCode === 'REAUTH_RATE_LIMITED');

      if (isReauthOrPolicyError) {
        // คง Modal ยืนยันตัวตนเปิดไว้และแจ้งเตือนภายใน Modal
        setReauthError(errMsg);
        setSyncProgressOpen(false);
      } else {
        setConfirmSyncOpen(false);
        setSyncProgressOpen(true);
        setSyncPercent(null);
        setSyncStatus('FAILED');
        setSyncStageLabel(formatJobStageLabel('FAILED'));
        setSyncStepLabel('ดึงข้อมูลจากเครื่องสแกนไม่สำเร็จ');
        setSyncErrorText(errMsg);
        if (err instanceof ApiClientError) {
          setError({ code: err.code, message: err.message });
        } else {
          setError({ message: errMsg });
        }
        await loadData(false);
        await loadSyncHistory();
      }
    } finally {
      setSyncingHardware(false);
    }
  }

  async function handleInspectSyncRun(runItem: any) {
    try {
      const res = await apiRequest(`/sync-runs/${runItem.id}`);
      setSelectedSyncRunDetail(res.item || runItem);
    } catch {
      setSelectedSyncRunDetail(runItem);
    }
  }

  async function handleIngestContractJson(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const parsed = JSON.parse(jsonPayloadText);
      const res = await apiRequest('/scanners/ingest', {
        method: 'POST',
        body: JSON.stringify({ events: Array.isArray(parsed) ? parsed : [parsed] }),
      });
      setNotice(
        `นำเข้าข้อมูล JSON 6 ฟิลด์สำเร็จ: อ่าน ${res.totalRead} รายการ · เพิ่มใหม่ ${res.newInserted} · ข้ามรายการซ้ำ ${res.duplicatesSkipped} รายการ`
      );
      await loadData(false);
      await loadSyncHistory();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ code: 'JSON_PARSE_ERROR', message: err.message });
      }
    }
  }

  async function handleAddScanner(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/scanners', {
        method: 'POST',
        body: JSON.stringify({
          machineNo: Number(machineNo),
          deviceName,
          ipAddress,
          devicePort: 4370,
          locationName,
        }),
      });
      setDeviceName('');
      setLocationName('');
      setNotice(`ลงทะเบียนเครื่องสแกนหมายเลข #${machineNo} เรียบร้อยแล้ว`);
      await loadData(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleToggleScanner(id: number, currentEnabled: number) {
    setError(null);
    try {
      await apiRequest(`/scanners/${id}/enabled`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: currentEnabled !== 1 }),
      });
      await loadData(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleAddSchedule(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/sync-schedules', {
        method: 'POST',
        body: JSON.stringify({ scheduleLabel, cronTime }),
      });
      setScheduleLabel('');
      setNotice(`เพิ่มตารางเวลาดึงข้อมูลอัตโนมัติ (${cronTime} น.) เรียบร้อยแล้ว`);
      await loadData(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleToggleSchedule(id: number, currentEnabled: number) {
    setError(null);
    try {
      await apiRequest(`/sync-schedules/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ isEnabled: currentEnabled !== 1 }),
      });
      await loadData(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  const lastResultUnmapped =
    lastSyncResult?.unmappedCount ??
    lastSyncResult?.unmatchedCount ??
    unmatchedRawCount;

  return (
    <div className="space-y-6">
      <PageHeader
        category="เครื่องสแกนและข้อมูลต้นฉบับ"
        title={
          mode === 'rawScans'
            ? 'ข้อมูลสแกนลายนิ้วมือต้นฉบับ (Raw Scans)'
            : 'เครื่องสแกนและการดึงข้อมูล'
        }
        subtitle="รับข้อมูลเหตุการณ์สแกน 6 ฟิลด์จากโปรแกรมอ่านเครื่องสแกนของโรงพยาบาล ข้อมูลต้นฉบับถูกคุ้มครองแบบห้ามแก้ไขหรือลบ (Immutable)"
        meta={
          mode === 'rawScans' ? (
            <>
              <span className="inline-flex items-center gap-1.5 text-[#4E3978] font-semibold">
                <ShieldCheck className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                คุ้มครองข้อมูลต้นฉบับ (Read-Only Immutable)
              </span>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                รอเชื่อมโยงรหัสสแกน: <strong className={unmatchedRawCount > 0 ? 'text-[#C74455]' : 'text-[#292638]'}>{unmatchedRawCount} รายการ</strong>
              </span>
            </>
          ) : undefined
        }
        actions={
          <>
            <PageHelpAction
              guideKey={mode === 'scanners' ? 'scanners' : 'rawScans'}
              activeTabKey={mode === 'scanners' ? activeScannerTab : undefined}
              userRole={user.role}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={syncingHardware || (mode === 'scanners' && !syncRangeValidation.valid)}
              onClick={handleRequestOpenSyncConfirm}
              className="ent-btn-primary"
            >
              <RefreshCw className={`w-4 h-4 ${syncingHardware ? 'animate-spin' : ''}`} />
              <span>
                {syncingHardware
                  ? 'กำลังดึงข้อมูลจากเครื่องสแกน...'
                  : 'สั่งดึงข้อมูลจากเครื่องสแกนทันที'}
              </span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {mode === 'scanners' ? (
        <div className="space-y-5">
          {/* Unified Single-Elevation Status Strip */}
          <MetricStrip
            columns={4}
            items={[
              {
                id: 'active-devices',
                label: 'เครื่องสแกนที่เปิดใช้งาน',
                value: activeDevicesCount,
                unit: `/ ${devices.length} เครื่อง`,
                sublabel: 'เชื่อมต่อผ่านพอร์ต 4370',
                tone: activeDevicesCount > 0 ? 'success' : 'default',
                icon: <Radio className="w-4 h-4 text-[#198568]" />,
                onClick: () => setActiveScannerTab('DEVICES'),
                actionHint: 'ดูเครื่อง',
              },
              {
                id: 'active-schedules',
                label: 'รอบดึงข้อมูลอัตโนมัติ',
                value: activeSchedulesCount,
                unit: 'รอบ/วัน',
                sublabel: `ทั้งหมด ${schedules.length} รอบที่ตั้งค่าไว้`,
                tone: 'brand',
                icon: <Clock className="w-4 h-4 text-[#8066B5]" />,
                onClick: () => setActiveScannerTab('SCHEDULES'),
                actionHint: 'จัดการรอบ',
              },
              {
                id: 'last-sync',
                label: 'การดึงข้อมูลล่าสุด',
                value:
                  historyItems[0]?.status === 'SUCCESS'
                    ? 'สำเร็จ'
                    : historyItems[0]?.status === 'PARTIAL_SUCCESS'
                      ? 'สำเร็จบางส่วน'
                      : historyItems[0]
                        ? 'ขัดข้อง'
                        : 'ยังไม่มี',
                sublabel: historyItems[0]?.started_at
                  ? formatThaiDateTime(historyItems[0].started_at)
                  : 'ยังไม่มีประวัติในรอบนี้',
                tone:
                  historyItems[0]?.status === 'SUCCESS'
                    ? 'success'
                    : historyItems[0]?.status === 'PARTIAL_SUCCESS'
                      ? 'warning'
                      : historyItems[0]
                        ? 'danger'
                        : 'default',
                icon: <History className="w-4 h-4 text-[#8066B5]" />,
                onClick: () => setActiveScannerTab('HISTORY'),
                actionHint: 'ดูประวัติ',
              },
              {
                id: 'unmatched-scans',
                label: 'สแกนที่ยังไม่จับคู่บุคลากร',
                value: unmatchedRawCount,
                unit: 'รายการ',
                sublabel: 'รหัสสแกนที่ยังไม่พบในทะเบียนบุคลากร',
                tone: unmatchedRawCount > 0 ? 'warning' : 'default',
                onClick: onNavigate ? () => onNavigate('rawScans') : undefined,
                actionHint: onNavigate ? 'ตรวจสอบ' : undefined,
              },
            ]}
          />

          {/* 4-Tab Underline Navigation Workspace */}
          <div className="his-surface overflow-hidden">
            <div className="px-4 sm:px-6 bg-white">
              <TabBar<ScannerTabKey>
                variant="underline"
                activeKey={activeScannerTab}
                onChange={setActiveScannerTab}
                tabs={[
                  {
                    key: 'SYNC',
                    label: 'ดึงข้อมูลสแกน',
                    icon: <CalendarClock className="w-4 h-4" />,
                  },
                  {
                    key: 'DEVICES',
                    label: 'เครื่องสแกน',
                    icon: <Radio className="w-4 h-4" />,
                    badge: devices.length,
                  },
                  {
                    key: 'SCHEDULES',
                    label: 'รอบอัตโนมัติ',
                    icon: <Clock className="w-4 h-4" />,
                    badge: schedules.length,
                  },
                  {
                    key: 'HISTORY',
                    label: 'ประวัติการดึงข้อมูล',
                    icon: <History className="w-4 h-4" />,
                    badge: historyTotal,
                  },
                ]}
              />
            </div>

            {/* =================================================================
                แท็บ 1: ดึงข้อมูลสแกน (Step-by-step Sync Workspace)
               ================================================================= */}
            {activeScannerTab === 'SYNC' && (
              <div className="divide-y divide-[#E8E4EF]">
                {/* Step 1: Select Sync Mode */}
                <div className="p-5 sm:p-6 space-y-4">
                  <SectionHeader
                    kicker="ขั้นตอนที่ 1"
                    title="เลือกโหมดและช่วงเวลาที่ต้องการดึงข้อมูล"
                    subtitle="ระบบอ่านข้อมูลตามเวลาประเทศไทย (Asia/Bangkok) ตรวจสอบรายการซ้ำ และคำนวณเวลาปฏิบัติงานให้อัตโนมัติ"
                    actions={
                      <span className="text-[12.5px] font-mono text-[#777287]">
                        UTC+07:00 · สูงสุด {maxSyncRangeDays} วัน/รอบ
                      </span>
                    }
                  />

                  <div
                    className={`grid grid-cols-1 md:grid-cols-2 ${isAdmin ? 'xl:grid-cols-4' : 'xl:grid-cols-3'} gap-3`}
                  >
                    {(
                      [
                        {
                          key: 'TODAY',
                          title: 'ดึงข้อมูลวันนี้',
                          desc: `เฉพาะวันนี้ (${formatThaiDate(initialBkk.todayYmd)} 00:00 – 23:59 น.)`,
                          badge: null,
                        },
                        {
                          key: 'CUSTOM_RANGE',
                          title: 'เลือกช่วงวันที่และเวลา',
                          desc: isAdmin
                            ? 'ระบุวัน-เวลาเริ่มต้นและสิ้นสุดเอง (รองรับข้ามวัน/ข้ามเดือน)'
                            : `ระบุวัน-เวลาเองได้ตั้งแต่ ${formatThaiDate(roleSyncPolicy.earliestAllowedYmd || initialBkk.monthStartYmd)} เป็นต้นไป`,
                          badge: null,
                        },
                        {
                          key: 'MONTHLY',
                          title: 'ดึงข้อมูลรายเดือน (Monthly)',
                          desc: isAdmin
                            ? 'เลือกดึงข้อมูลเต็มเดือนปฏิทิน (ยืนยันผลกระทบ + รหัสผ่าน)'
                            : 'ดึงเต็มเดือนได้เฉพาะเดือนปัจจุบันและเดือนก่อนหน้า 1 เดือน',
                          badge: 'ต้องยืนยันรหัสผ่าน',
                        },
                        ...(isAdmin
                          ? [
                              {
                                key: 'FULL_HISTORICAL' as ScannerSyncMode,
                                title: 'ดึงย้อนหลังทั้งหมด (Admin)',
                                desc: `ดึงทั้งหมดเท่าที่โปรแกรมอ่านเครื่องสแกนรองรับ (สูงสุด ${maxSyncRangeDays} วัน)`,
                                badge: 'เฉพาะ Admin · ยืนยันรหัสผ่าน',
                              },
                            ]
                          : []),
                      ] as Array<{
                        key: ScannerSyncMode;
                        title: string;
                        desc: string;
                        badge: string | null;
                      }>
                    ).map((opt) => {
                      const selected = syncMode === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          disabled={syncingHardware}
                          onClick={() => {
                            setSyncMode(opt.key);
                            setError(null);
                          }}
                          className={`p-4 rounded-xl border text-left transition-colors disabled:opacity-60 cursor-pointer flex flex-col justify-between gap-2 ${
                            selected
                              ? 'bg-[#F1ECFA] border-[#8066B5]'
                              : 'bg-white border-[#E8E4EF] hover:border-[#8066B5]/50 hover:bg-[#F8F7FC]'
                          }`}
                        >
                          <div>
                            <div className="flex items-center justify-between gap-2">
                              <span
                                className={`text-[14.5px] font-bold ${
                                  selected ? 'text-[#4E3978]' : 'text-[#292638]'
                                }`}
                              >
                                {opt.title}
                              </span>
                              <span
                                className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                  selected
                                    ? 'border-[#8066B5] bg-[#8066B5]'
                                    : 'border-[#D8D1E6] bg-white'
                                }`}
                              >
                                {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                              </span>
                            </div>
                            <p className="text-[12.5px] text-[#777287] mt-1 leading-snug">
                              {opt.desc}
                            </p>
                          </div>
                          {opt.badge && (
                            <div className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-[#4E3978]">
                              <Lock className="w-3 h-3 shrink-0" />
                              <span>{opt.badge}</span>
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>

                  {/* Monthly Import Picker */}
                  {syncMode === 'MONTHLY' && (
                    <div className="p-4 sm:p-5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-3.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13.5px] font-bold text-[#292638]">
                          เลือกเดือนที่ต้องการดึงข้อมูลจากเครื่องสแกน (Asia/Bangkok)
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                          <button
                            type="button"
                            disabled={syncingHardware}
                            onClick={() => setSyncYearMonth(roleSyncPolicy.currentYearMonth)}
                            className="px-2.5 py-1 rounded-md bg-white border border-[#E8E4EF] hover:bg-[#F1ECFA] text-[#292638] font-medium cursor-pointer"
                          >
                            เดือนปัจจุบัน ({roleSyncPolicy.currentYearMonth})
                          </button>
                          <button
                            type="button"
                            disabled={syncingHardware}
                            onClick={() => setSyncYearMonth(roleSyncPolicy.previousYearMonth)}
                            className="px-2.5 py-1 rounded-md bg-white border border-[#E8E4EF] hover:bg-[#F1ECFA] text-[#292638] font-medium cursor-pointer"
                          >
                            เดือนก่อนหน้า ({roleSyncPolicy.previousYearMonth})
                          </button>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
                        <div>
                          <label htmlFor="sync-year-month" className="ent-label">
                            เดือนและปีที่ต้องการดึงข้อมูล <RequiredMark />
                          </label>
                          {isAdmin ? (
                            <input
                              id="sync-year-month"
                              type="month"
                              disabled={syncingHardware}
                              value={syncYearMonth}
                              onChange={(e) => setSyncYearMonth(e.target.value)}
                              className="ent-input w-full font-mono"
                            />
                          ) : (
                            <select
                              id="sync-year-month"
                              disabled={syncingHardware}
                              value={syncYearMonth}
                              onChange={(e) => setSyncYearMonth(e.target.value)}
                              className="ent-input w-full font-mono"
                            >
                              {(roleSyncPolicy.allowedYearMonths || [
                                roleSyncPolicy.currentYearMonth,
                                roleSyncPolicy.previousYearMonth,
                              ]).map((ym: string) => (
                                <option key={ym} value={ym}>
                                  {formatThaiYearMonth(ym)}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                        <div className="text-[12.5px] text-[#777287] bg-white p-3 rounded-lg border border-[#E8E4EF]">
                          {isAdmin ? (
                            <>
                              ผู้ดูแลระบบ (ADMIN) สามารถเลือกดึงย้อนหลังได้ทุกเดือนภายใต้กรอบข้อมูลของโปรแกรมอ่านสแกน (สูงสุด {maxSyncRangeDays} วัน)
                            </>
                          ) : (
                            <>
                              สิทธิ์เจ้าหน้าที่ผู้รับผิดชอบ (RESPONSIBLE_STAFF) อนุญาตให้ดึงย้อนหลังได้เฉพาะ{' '}
                              <strong className="text-[#292638]">เดือนปัจจุบันและเดือนก่อนหน้า 1 เดือน</strong> ตามเวลาประเทศไทยบนเซิร์ฟเวอร์เท่านั้น
                            </>
                          )}
                        </div>
                      </div>

                      {!syncRangeValidation.valid && syncRangeValidation.message && (
                        <div
                          role="alert"
                          className="p-3 rounded-lg bg-[#FDF2F4] border border-[#C74455]/25 text-[#C74455] text-[13px] font-medium flex items-start gap-2"
                        >
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{syncRangeValidation.message}</span>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Full Historical Honest Notice (ADMIN only) */}
                  {syncMode === 'FULL_HISTORICAL' && isAdmin && (
                    <div className="p-4 rounded-xl bg-[#FEF7EA] border border-[#B87516]/30 text-[13px] text-[#292638] space-y-1.5">
                      <div className="font-bold text-[#B87516] flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>ข้อควรทราบเกี่ยวกับข้อจำกัดของโปรแกรมอ่านเครื่องสแกน (ScannerSyncCli.exe)</span>
                      </div>
                      <p className="leading-relaxed">
                        โปรแกรมอ่านเครื่องสแกนเดิมของโรงพยาบาลรับพารามิเตอร์ <code className="font-mono">--days</code> สูงสุด{' '}
                        <strong>{maxSyncRangeDays} วันย้อนหลัง</strong> (ไม่ได้แก้ไขตัวไฟล์ EXE) ระบบจะดึงข้อมูลทั้งหมดเท่าที่เครื่องและ EXE ส่งคืนมา ตรวจสอบรายการซ้ำอัตโนมัติ (ไม่ลบหรือแก้ไขข้อมูลเดิม) จับคู่รหัสสแกน และคำนวณตารางเวรใหม่เฉพาะวันที่เกี่ยวข้อง โดยต้องยืนยันผลกระทบและกรอกรหัสผ่านผู้ดูแลระบบก่อนเริ่มทำงาน
                      </p>
                    </div>
                  )}

                  {/* Custom Range Inputs */}
                  {syncMode === 'CUSTOM_RANGE' && (
                    <div className="p-4 sm:p-5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[13.5px] font-bold text-[#292638]">
                          กำหนดช่วงวันที่และเวลา (Asia/Bangkok)
                        </span>
                        <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                          <span className="text-[#777287] mr-1">เลือกด่วน:</span>
                          {[
                            {
                              label: 'วันนี้',
                              from: initialBkk.todayYmd,
                              to: initialBkk.todayYmd,
                            },
                            {
                              label: 'เมื่อวาน',
                              from: initialBkk.yesterdayYmd,
                              to: initialBkk.yesterdayYmd,
                            },
                            {
                              label: 'ย้อนหลัง 7 วัน',
                              from: shiftYmdDays(initialBkk.todayYmd, -6),
                              to: initialBkk.todayYmd,
                            },
                            {
                              label: 'ทั้งเดือนนี้',
                              from: initialBkk.monthStartYmd,
                              to: initialBkk.todayYmd,
                            },
                          ].map((preset) => (
                            <button
                              key={preset.label}
                              type="button"
                              disabled={syncingHardware}
                              onClick={() => {
                                setSyncDateFrom(preset.from);
                                setSyncTimeFrom('00:00');
                                setSyncDateTo(preset.to);
                                setSyncTimeTo('23:59');
                              }}
                              className="px-2.5 py-1 rounded-md bg-white border border-[#E8E4EF] hover:bg-[#F1ECFA] hover:border-[#8066B5]/40 text-[#292638] font-medium transition-colors cursor-pointer"
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
                        <div>
                          <label htmlFor="sync-date-from" className="ent-label">
                            ตั้งแต่วันที่ <RequiredMark />
                          </label>
                          <input
                            id="sync-date-from"
                            type="date"
                            min={!isAdmin && roleSyncPolicy.earliestAllowedYmd ? roleSyncPolicy.earliestAllowedYmd : undefined}
                            disabled={syncingHardware}
                            value={syncDateFrom}
                            onChange={(e) => setSyncDateFrom(e.target.value)}
                            className="ent-input w-full font-mono"
                          />
                        </div>
                        <div>
                          <label htmlFor="sync-time-from" className="ent-label">
                            เวลาเริ่มต้น <RequiredMark />
                          </label>
                          <input
                            id="sync-time-from"
                            type="time"
                            disabled={syncingHardware}
                            value={syncTimeFrom}
                            onChange={(e) => setSyncTimeFrom(e.target.value)}
                            className="ent-input w-full font-mono"
                          />
                        </div>
                        <div>
                          <label htmlFor="sync-date-to" className="ent-label">
                            ถึงวันที่ <RequiredMark />
                          </label>
                          <input
                            id="sync-date-to"
                            type="date"
                            min={!isAdmin && roleSyncPolicy.earliestAllowedYmd ? roleSyncPolicy.earliestAllowedYmd : undefined}
                            disabled={syncingHardware}
                            value={syncDateTo}
                            onChange={(e) => setSyncDateTo(e.target.value)}
                            className="ent-input w-full font-mono"
                          />
                        </div>
                        <div>
                          <label htmlFor="sync-time-to" className="ent-label">
                            เวลาสิ้นสุด <RequiredMark />
                          </label>
                          <input
                            id="sync-time-to"
                            type="time"
                            disabled={syncingHardware}
                            value={syncTimeTo}
                            onChange={(e) => setSyncTimeTo(e.target.value)}
                            className="ent-input w-full font-mono"
                          />
                        </div>
                      </div>

                      {!syncRangeValidation.valid && syncRangeValidation.message && (
                        <div
                          role="alert"
                          className="p-3 rounded-lg bg-[#FDF2F4] border border-[#C74455]/25 text-[#C74455] text-[13px] font-medium flex items-start gap-2"
                        >
                          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                          <span>{syncRangeValidation.message}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Step 2: Target Device & Execute Action */}
                <div className="p-5 sm:p-6 bg-[#F8F7FC]/60 space-y-4">
                  <SectionHeader
                    kicker="ขั้นตอนที่ 2"
                    title="เลือกเครื่องสแกนเป้าหมายและเริ่มดึงข้อมูล"
                    subtitle={syncScopeDescription}
                  />

                  <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
                    <div className="w-full md:w-96">
                      <label htmlFor="sync-target-machine" className="ent-label">
                        เครื่องสแกนเป้าหมาย
                      </label>
                      <select
                        id="sync-target-machine"
                        disabled={syncingHardware}
                        value={syncMachineNo}
                        onChange={(e) => setSyncMachineNo(e.target.value)}
                        className="ent-input w-full"
                      >
                        <option value="">ทุกเครื่องสแกนที่เปิดใช้งาน</option>
                        {devices.map((d: any) => (
                          <option key={d.id} value={String(d.machine_no)}>
                            เครื่อง #{d.machine_no} — {d.device_name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <button
                      type="button"
                      disabled={syncingHardware || !syncRangeValidation.valid}
                      onClick={handleRequestOpenSyncConfirm}
                      className="ent-btn-primary w-full md:w-auto h-10 px-5"
                    >
                      <RefreshCw className={`w-4 h-4 ${syncingHardware ? 'animate-spin' : ''}`} />
                      <span>
                        {syncingHardware
                          ? 'กำลังดึงข้อมูลจากเครื่องสแกน...'
                          : syncMode === 'TODAY'
                            ? 'ดึงข้อมูลวันนี้จากเครื่องสแกน'
                            : syncMode === 'MONTHLY'
                              ? `ดึงข้อมูลรายเดือน (${syncYearMonth})`
                              : syncMode === 'CUSTOM_RANGE'
                                ? 'ดึงข้อมูลตามช่วงวันที่และเวลาที่เลือก'
                                : 'ดึงข้อมูลย้อนหลังทั้งหมด (Admin)'}
                      </span>
                    </button>
                  </div>

                  {/* Subtle Explanation Footer */}
                  <div className="flex items-start gap-2 text-[12.5px] text-[#777287] pt-1">
                    <Info className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
                    <span>
                      {scannerData?.syncRangeCapabilities?.explanationTh ||
                        `ระบบอ่านข้อมูลจากโปรแกรมเครื่องสแกนเดิมของโรงพยาบาล แล้วคัดกรองเฉพาะรายการที่มีเวลา (Asia/Bangkok) อยู่ในช่วงที่เลือกบน Backend ก่อนบันทึก รายการนอกช่วงจะไม่ถูกบันทึก`}
                    </span>
                  </div>
                </div>

                {/* Live Sync Result Summary (Explicitly showing New, Duplicates, Matched, Attendance, Partial Warning) */}
                {lastSyncResult && (
                  <div
                    className={`p-5 sm:p-6 space-y-3 ${
                      lastSyncResult.status === 'PARTIAL_SUCCESS'
                        ? 'bg-[#FEF7EA]/80'
                        : 'bg-[#EEF8F4]/70'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div
                        className={`inline-flex items-center gap-2 font-bold text-[14.5px] ${
                          lastSyncResult.status === 'PARTIAL_SUCCESS'
                            ? 'text-[#B87516]'
                            : 'text-[#198568]'
                        }`}
                      >
                        {lastSyncResult.status === 'PARTIAL_SUCCESS' ? (
                          <AlertTriangle className="w-4.5 h-4.5 shrink-0" />
                        ) : (
                          <CheckCircle2 className="w-4.5 h-4.5 shrink-0" />
                        )}
                        <span>
                          {lastSyncResult.status === 'PARTIAL_SUCCESS'
                            ? 'ผลการดึงข้อมูลรอบล่าสุด (สำเร็จบางส่วน)'
                            : 'ผลการดึงข้อมูลรอบล่าสุด'}{' '}
                          (#{lastSyncResult.syncRunId} · {formatSyncScopeLabel(lastSyncResult.syncMode)}
                          {lastSyncResult.yearMonth ? ` · ${lastSyncResult.yearMonth}` : ''})
                        </span>
                      </div>
                      {lastSyncResult.filterFromBkk && lastSyncResult.filterToBkk && (
                        <span className="font-mono text-[12.5px] text-[#292638] tabular-nums">
                          {lastSyncResult.filterFromBkk} ถึง {lastSyncResult.filterToBkk}
                        </span>
                      )}
                    </div>

                    <div className="his-surface grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 divide-y sm:divide-y-0 sm:divide-x divide-[#E8E4EF]">
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">อ่านจากเครื่อง</div>
                        <div className="font-mono font-bold text-[18px] text-[#292638] tabular-nums mt-0.5">
                          {lastSyncResult.totalReadFromDevice ?? lastSyncResult.totalRead ?? 0}
                        </div>
                      </div>
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">ตรงช่วงที่เลือก</div>
                        <div className="font-mono font-bold text-[18px] text-[#4E3978] tabular-nums mt-0.5">
                          {lastSyncResult.matchedInRange ?? lastSyncResult.totalRead ?? 0}
                        </div>
                      </div>
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">บันทึกใหม่</div>
                        <div className="font-mono font-bold text-[18px] text-[#198568] tabular-nums mt-0.5">
                          {lastSyncResult.newInserted ?? 0}
                        </div>
                      </div>
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">ข้ามซ้ำ</div>
                        <div className="font-mono font-bold text-[18px] text-[#777287] tabular-nums mt-0.5">
                          {lastSyncResult.duplicatesSkipped ?? 0}
                        </div>
                      </div>
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">จับคู่บุคลากรได้</div>
                        <div className="font-mono font-bold text-[18px] text-[#198568] tabular-nums mt-0.5">
                          {lastSyncResult.matchedScansCount ?? 0}
                        </div>
                      </div>
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">ยังจับคู่ไม่ได้</div>
                        <div
                          className={`font-mono font-bold text-[18px] tabular-nums mt-0.5 ${
                            Number(lastResultUnmapped) > 0 ? 'text-[#B87516]' : 'text-[#777287]'
                          }`}
                        >
                          {lastResultUnmapped}
                        </div>
                      </div>
                      <div className="p-3">
                        <div className="text-[12px] text-[#777287]">อัปเดตตารางเวร</div>
                        <div className="font-mono font-bold text-[18px] text-[#4E3978] tabular-nums mt-0.5">
                          {Number(lastSyncResult.attendanceCreatedCount ?? 0) +
                            Number(lastSyncResult.attendanceUpdatedCount ?? 0)}
                        </div>
                      </div>
                    </div>

                    {Array.isArray(lastSyncResult.machineResults) &&
                      lastSyncResult.machineResults.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          {lastSyncResult.machineResults.map((mr: any, idx: number) => (
                            <StatusBadge
                              key={`${mr.machineNo}-${idx}`}
                              tone={
                                String(mr.status || '').toUpperCase() === 'OK'
                                  ? 'success'
                                  : 'danger'
                              }
                              label={`เครื่อง #${mr.machineNo}: ${mr.status}${typeof mr.eventsRead === 'number' ? ` (${mr.eventsRead} รายการ)` : ''}${mr.message ? ` — ${mr.message}` : ''}`}
                              compact
                            />
                          ))}
                        </div>
                      )}

                    {lastSyncResult.warningMessage && (
                      <p className="text-[12.5px] font-medium text-[#B87516]">
                        {lastSyncResult.warningMessage}
                      </p>
                    )}

                    {lastSyncResult.exeLimitationWarning && (
                      <p className="text-[12.5px] text-[#777287]">
                        {lastSyncResult.exeLimitationWarning}
                      </p>
                    )}

                    {lastSyncResult.filterModeNotice && (
                      <p className="text-[12.5px] text-[#292638]">{lastSyncResult.filterModeNotice}</p>
                    )}
                  </div>
                )}

                {/* ADMIN-only Collapsible Advanced Tools (6-Field JSON Ingest) */}
                {user.role === 'ADMIN' && (
                  <div className="bg-white">
                    <button
                      type="button"
                      aria-expanded={showAdvancedTools}
                      onClick={() => setShowAdvancedTools((prev) => !prev)}
                      className="w-full px-5 sm:px-6 py-4 flex items-center justify-between gap-3 hover:bg-[#F8F7FC] transition-colors text-left cursor-pointer"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Wrench className="w-4.5 h-4.5 text-[#8066B5] shrink-0" />
                        <div className="min-w-0">
                          <div className="text-[14.5px] font-bold text-[#292638]">
                            เครื่องมือขั้นสูง (สำหรับผู้ดูแลระบบ)
                          </div>
                          <div className="text-[12.5px] text-[#777287]">
                            นำเข้าข้อมูลสแกนตามสัญญา 6 ฟิลด์ด้วยชุดข้อมูล JSON (JSON Ingest จาก ScannerReader.exe)
                          </div>
                        </div>
                      </div>
                      <div className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#4E3978] shrink-0">
                        <span>{showAdvancedTools ? 'ซ่อนเครื่องมือ' : 'เปิดใช้งาน'}</span>
                        {showAdvancedTools ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </div>
                    </button>

                    {showAdvancedTools && (
                      <form
                        onSubmit={handleIngestContractJson}
                        className="px-5 sm:px-6 pb-6 pt-2 space-y-4 border-t border-[#E8E4EF] bg-[#F8F7FC]/40"
                      >
                        <div className="pt-2">
                          <h3 className="text-[15px] font-bold text-[#292638]">
                            นำเข้าข้อมูลสแกนตามสัญญา 6 ฟิลด์ (JSON Ingest)
                          </h3>
                          <p className="text-[13px] text-[#777287] mt-0.5">
                            รองรับการส่งชุดข้อมูลจาก ScannerReader.exe พร้อมตรวจสอบโครงสร้างและคัดกรองรายการซ้ำอัตโนมัติ
                          </p>
                        </div>
                        <textarea
                          rows={7}
                          aria-label="ข้อมูล JSON 6 ฟิลด์ตามสัญญาโปรแกรมอ่านสแกน"
                          value={jsonPayloadText}
                          onChange={(e) => setJsonPayloadText(e.target.value)}
                          className="w-full p-3.5 text-[13px] font-mono border border-[#D8D1E6] rounded-xl bg-white text-[#292638] focus:outline-none focus:border-[#8066B5] focus:ring-2 focus:ring-[#8066B5]/15"
                        />
                        <button type="submit" className="ent-btn-primary w-full sm:w-auto">
                          <Upload className="w-4 h-4" />
                          <span>นำเข้าข้อมูลสแกนและตรวจสอบรายการซ้ำ</span>
                        </button>
                      </form>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* =================================================================
                แท็บ 2: เครื่องสแกน (Clean Hospital Device Directory)
               ================================================================= */}
            {activeScannerTab === 'DEVICES' && (
              <div className="divide-y divide-[#E8E4EF]">
                {loading && devices.length === 0 ? (
                  <div className="p-5">
                    <TableLoadingSkeleton rows={3} cols={5} />
                  </div>
                ) : (
                  <>
                    {/* Mobile View */}
                    <div className="md:hidden divide-y divide-[#E8E4EF]">
                      {devices.length === 0 ? (
                        <div className="p-10 text-center text-[14px] text-[#777287]">
                          ยังไม่มีข้อมูลเครื่องสแกนที่ลงทะเบียนในระบบ
                        </div>
                      ) : (
                        devices.map((d: any) => {
                          const isEnabled = Number(d.is_enabled) === 1;
                          return (
                            <div key={d.id} className="p-4 space-y-2.5 bg-white">
                              <div className="flex items-start justify-between gap-2">
                                <div>
                                  <div className="font-mono text-[12.5px] font-bold text-[#8066B5]">
                                    เครื่อง #{d.machine_no}
                                  </div>
                                  <div className="font-bold text-[15px] text-[#292638]">{d.device_name}</div>
                                  <div className="text-[12.5px] text-[#777287]">{d.location_name}</div>
                                </div>
                                <StatusBadge
                                  tone={isEnabled ? 'success' : 'neutral'}
                                  label={isEnabled ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                                  compact
                                />
                              </div>
                              <div className="flex flex-wrap items-center justify-between gap-2 text-[12.5px] text-[#777287]">
                                <span className="font-mono text-[#292638]">
                                  {d.ip_address}:{d.device_port}
                                </span>
                                <span className="font-mono">
                                  {d.last_success_at
                                    ? formatThaiDateTime(d.last_success_at)
                                    : d.last_sync_status}
                                </span>
                              </div>
                              {user.role === 'ADMIN' && (
                                <button
                                  type="button"
                                  onClick={() => handleToggleScanner(d.id, Number(d.is_enabled))}
                                  className="ent-btn-secondary w-full h-9 text-[13px]"
                                >
                                  {isEnabled ? 'ปิดการใช้งานชั่วคราว' : 'เปิดใช้งานเครื่องนี้'}
                                </button>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>

                    {/* Desktop Directory Table */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="his-table">
                        <thead>
                          <tr>
                            <th>หมายเลขเครื่อง</th>
                            <th>ชื่อเครื่องสแกน · สถานที่ติดตั้ง</th>
                            <th>ที่อยู่เครือข่าย (IP:Port)</th>
                            <th>ซิงก์สำเร็จล่าสุด</th>
                            <th>สถานะ</th>
                            {user.role === 'ADMIN' && <th className="text-right">จัดการ</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {devices.length === 0 ? (
                            <TableEmptyState
                              colSpan={user.role === 'ADMIN' ? 6 : 5}
                              title="ยังไม่มีข้อมูลเครื่องสแกนที่ลงทะเบียนในระบบ"
                            />
                          ) : (
                            devices.map((d: any) => {
                              const isEnabled = Number(d.is_enabled) === 1;
                              return (
                                <tr key={d.id}>
                                  <td className="font-mono font-bold text-[#4E3978] whitespace-nowrap">
                                    #{d.machine_no}
                                  </td>
                                  <td>
                                    <div className="font-semibold text-[#292638]">{d.device_name}</div>
                                    <div className="text-[12.5px] text-[#777287]">{d.location_name}</div>
                                  </td>
                                  <td className="font-mono tabular-nums text-[#292638] whitespace-nowrap">
                                    {d.ip_address}:{d.device_port}
                                  </td>
                                  <td className="font-mono tabular-nums text-[#777287] whitespace-nowrap">
                                    {d.last_success_at
                                      ? formatThaiDateTime(d.last_success_at)
                                      : d.last_sync_status || 'ยังไม่มีประวัติ'}
                                  </td>
                                  <td>
                                    <StatusBadge
                                      tone={isEnabled ? 'success' : 'neutral'}
                                      label={isEnabled ? 'เปิดใช้งานปกติ' : 'ปิดชั่วคราว'}
                                      compact
                                    />
                                  </td>
                                  {user.role === 'ADMIN' && (
                                    <td className="text-right">
                                      <button
                                        type="button"
                                        onClick={() => handleToggleScanner(d.id, Number(d.is_enabled))}
                                        className="ent-btn-secondary h-8 px-3 text-[12.5px]"
                                      >
                                        {isEnabled ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                                      </button>
                                    </td>
                                  )}
                                </tr>
                              );
                            })
                          )}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {user.role === 'ADMIN' && (
                  <form onSubmit={handleAddScanner} className="p-5 sm:p-6 bg-[#F8F7FC]/60 space-y-4">
                    <SectionHeader
                      title="ลงทะเบียนเครื่องสแกนใหม่ (สำหรับผู้ดูแลระบบ)"
                      subtitle="ระบุหมายเลขเครื่องและที่อยู่ IP ในเครือข่ายโรงพยาบาล (พอร์ตมาตรฐาน 4370)"
                    />
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                      <div>
                        <label className="ent-label">
                          หมายเลขเครื่อง (Machine No) <RequiredMark />
                        </label>
                        <input
                          type="number"
                          required
                          value={machineNo}
                          onChange={(e) => setMachineNo(Number(e.target.value))}
                          className="ent-input w-full font-mono"
                        />
                      </div>
                      <div>
                        <label className="ent-label">
                          IP Address <RequiredMark />
                        </label>
                        <input
                          type="text"
                          required
                          value={ipAddress}
                          onChange={(e) => setIpAddress(e.target.value)}
                          className="ent-input w-full font-mono"
                        />
                      </div>
                      <div>
                        <label className="ent-label">
                          ชื่อเรียกเครื่องสแกน <RequiredMark />
                        </label>
                        <input
                          type="text"
                          required
                          value={deviceName}
                          onChange={(e) => setDeviceName(e.target.value)}
                          placeholder="เช่น เครื่องสแกนอาคารผู้ป่วยนอก"
                          className="ent-input w-full"
                        />
                      </div>
                      <div>
                        <label className="ent-label">
                          สถานที่ติดตั้ง <RequiredMark />
                        </label>
                        <input
                          type="text"
                          required
                          value={locationName}
                          onChange={(e) => setLocationName(e.target.value)}
                          placeholder="เช่น ชั้น 1 โถงต้อนรับ"
                          className="ent-input w-full"
                        />
                      </div>
                    </div>
                    <button type="submit" className="ent-btn-secondary w-full sm:w-auto">
                      <Plus className="w-4 h-4 text-[#8066B5]" />
                      <span>เพิ่มเครื่องสแกนเข้าสู่ระบบ</span>
                    </button>
                  </form>
                )}
              </div>
            )}

            {/* =================================================================
                แท็บ 3: รอบอัตโนมัติ (Automated Sync Schedules)
               ================================================================= */}
            {activeScannerTab === 'SCHEDULES' && (
              <div className="divide-y divide-[#E8E4EF]">
                <div className="px-5 sm:px-6 py-4 bg-white">
                  <SectionHeader
                    title={`ตารางเวลาดึงข้อมูลอัตโนมัติ (${schedules.length} รอบ/วัน)`}
                    subtitle="ระบบจะดึงข้อมูลจากทุกเครื่องสแกนที่เปิดใช้งานและคำนวณเวลาปฏิบัติงานให้อัตโนมัติตามเวลาที่กำหนด"
                  />
                </div>

                {user.role === 'ADMIN' && (
                  <form
                    onSubmit={handleAddSchedule}
                    className="p-4 sm:px-6 bg-[#F8F7FC]/60 flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3"
                  >
                    <input
                      type="text"
                      required
                      aria-label="ชื่อรอบดึงข้อมูล"
                      value={scheduleLabel}
                      onChange={(e) => setScheduleLabel(e.target.value)}
                      placeholder="ระบุชื่อรอบ เช่น หลังเข้าเวรเช้า..."
                      className="ent-input flex-1 min-w-0 sm:min-w-[220px]"
                    />
                    <input
                      type="time"
                      required
                      aria-label="เวลาซิงก์ HH:mm"
                      value={cronTime}
                      onChange={(e) => setCronTime(e.target.value)}
                      className="ent-input font-mono w-full sm:w-40"
                    />
                    <button type="submit" className="ent-btn-primary w-full sm:w-auto">
                      <Plus className="w-4 h-4" />
                      <span>เพิ่มรอบซิงก์</span>
                    </button>
                  </form>
                )}

                <div className="overflow-x-auto">
                  <table className="his-table">
                    <thead>
                      <tr>
                        <th>เวลาทำงาน</th>
                        <th>ชื่อรอบการซิงก์</th>
                        <th className="text-right">สถานะ</th>
                      </tr>
                    </thead>
                    <tbody>
                      {schedules.length === 0 ? (
                        <TableEmptyState
                          colSpan={3}
                          title="ยังไม่มีรอบเวลาดึงข้อมูลอัตโนมัติในระบบ"
                        />
                      ) : (
                        schedules.map((s: any) => {
                          const enabled = Number(s.is_enabled) === 1;
                          return (
                            <tr key={s.id}>
                              <td className="font-mono font-bold text-[#4E3978] tabular-nums whitespace-nowrap">
                                {s.cron_time} น.
                              </td>
                              <td className="font-medium text-[#292638]">{s.schedule_label}</td>
                              <td className="text-right">
                                {user.role === 'ADMIN' ? (
                                  <button
                                    type="button"
                                    onClick={() => handleToggleSchedule(s.id, Number(s.is_enabled))}
                                    className={`text-[12.5px] font-semibold px-3 py-1 rounded-md border whitespace-nowrap transition-colors cursor-pointer ${
                                      enabled
                                        ? 'text-[#198568] border-[#198568]/25 bg-[#EEF8F4] hover:bg-[#198568]/10'
                                        : 'text-[#777287] border-[#E8E4EF] bg-white hover:bg-[#F8F7FC]'
                                    }`}
                                  >
                                    {enabled ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                                  </button>
                                ) : (
                                  <StatusBadge
                                    tone={enabled ? 'success' : 'neutral'}
                                    label={enabled ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                                    compact
                                  />
                                )}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* =================================================================
                แท็บ 4: ประวัติการดึงข้อมูล (Sync History)
               ================================================================= */}
            {activeScannerTab === 'HISTORY' && (
              <div>
                <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC]/60 flex flex-col xl:flex-row xl:items-center justify-between gap-3.5">
                  <SectionHeader
                    title="ประวัติการดึงข้อมูลจากเครื่องสแกน"
                    subtitle="กรองตามช่วงเวลา เครื่องสแกน หรือสถานะ แล้วคลิกแต่ละแถวเพื่อดูรายละเอียดเชิงลึก"
                  />

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex flex-wrap items-center p-1 bg-white border border-[#E8E4EF] rounded-lg">
                      {(
                        [
                          { key: 'TODAY', label: 'วันนี้' },
                          { key: '7D', label: '7 วัน' },
                          { key: '30D', label: '30 วัน' },
                          { key: 'CUSTOM', label: 'เลือกช่วงวันที่' },
                          { key: 'ALL', label: 'ทั้งหมด' },
                        ] as Array<{ key: SyncHistoryPeriod; label: string }>
                      ).map((p) => (
                        <button
                          key={p.key}
                          type="button"
                          onClick={() => {
                            setHistoryPeriod(p.key);
                            setHistoryPage(1);
                          }}
                          className={`px-2.5 py-1 rounded-md text-[12.5px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                            historyPeriod === p.key
                              ? 'bg-[#8066B5] text-white'
                              : 'text-[#777287] hover:text-[#292638]'
                          }`}
                        >
                          {p.label}
                        </button>
                      ))}
                    </div>

                    {historyPeriod === 'CUSTOM' && (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="date"
                          aria-label="ตั้งแต่วันที่ประวัติซิงก์"
                          value={historyDateFrom}
                          onChange={(e) => {
                            setHistoryDateFrom(e.target.value);
                            setHistoryPage(1);
                          }}
                          className="ent-input font-mono text-[13px]"
                        />
                        <span className="text-[12.5px] text-[#777287]">ถึง</span>
                        <input
                          type="date"
                          aria-label="ถึงวันที่ประวัติซิงก์"
                          value={historyDateTo}
                          onChange={(e) => {
                            setHistoryDateTo(e.target.value);
                            setHistoryPage(1);
                          }}
                          className="ent-input font-mono text-[13px]"
                        />
                      </div>
                    )}

                    <select
                      aria-label="กรองประวัติตามเครื่องสแกน"
                      value={historyMachineNo}
                      onChange={(e) => {
                        setHistoryMachineNo(e.target.value);
                        setHistoryPage(1);
                      }}
                      className="ent-input text-[13px]"
                    >
                      <option value="">ทุกเครื่องสแกน</option>
                      {devices.map((d: any) => (
                        <option key={d.id} value={String(d.machine_no)}>
                          เครื่อง #{d.machine_no} ({d.device_name})
                        </option>
                      ))}
                    </select>

                    <select
                      aria-label="กรองประวัติตามสถานะ"
                      value={historyStatus}
                      onChange={(e) => {
                        setHistoryStatus(e.target.value);
                        setHistoryPage(1);
                      }}
                      className="ent-input text-[13px]"
                    >
                      <option value="ALL">ทุกสถานะ</option>
                      <option value="SUCCESS">สำเร็จ (SUCCESS)</option>
                      <option value="PARTIAL_SUCCESS">สำเร็จบางส่วน (PARTIAL_SUCCESS)</option>
                      <option value="FAILED">ไม่สำเร็จ (FAILED)</option>
                    </select>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="his-table">
                    <thead>
                      <tr>
                        <th>รหัสรอบ · วันและเวลา</th>
                        <th>ช่องทาง · ช่วงเวลาที่เลือก</th>
                        <th>สถานะ</th>
                        <th className="text-right">อ่าน / ตรงช่วง</th>
                        <th className="text-right">บันทึกใหม่</th>
                        <th className="text-right">ข้ามซ้ำ / ไม่สำเร็จ</th>
                        <th>หมายเหตุ / ข้อผิดพลาด</th>
                        <th className="text-right">รายละเอียด</th>
                      </tr>
                    </thead>
                    <tbody>
                      {historyItems.length === 0 ? (
                        <TableEmptyState
                          colSpan={8}
                          title="ไม่พบประวัติการดึงข้อมูลจากเครื่องสแกนตามเงื่อนไขที่เลือก"
                        />
                      ) : (
                        historyItems.map((r: any) => (
                          <tr
                            key={r.id}
                            onClick={() => handleInspectSyncRun(r)}
                            className="cursor-pointer"
                          >
                            <td className="font-mono tabular-nums whitespace-nowrap">
                              <span className="font-semibold text-[#4E3978]">#{r.id}</span> ·{' '}
                              {formatThaiDateTime(r.started_at)}
                            </td>
                            <td>
                              <div className="font-mono text-[13px] text-[#292638] font-semibold">
                                {r.trigger_mode} · {formatSyncScopeLabel(r.sync_scope_mode)}
                                {r.import_year_month ? ` (${r.import_year_month})` : ''}
                              </div>
                              {r.filter_from_bkk && r.filter_to_bkk ? (
                                <div className="font-mono text-[12px] text-[#8066B5] mt-0.5 tabular-nums">
                                  {r.filter_from_bkk} – {r.filter_to_bkk}
                                </div>
                              ) : (
                                <div className="text-[12px] text-[#777287] mt-0.5">
                                  ไม่จำกัดช่วงเวลาย่อย
                                </div>
                              )}
                            </td>
                            <td className="whitespace-nowrap">
                              <StatusBadge
                                tone={
                                  r.status === 'SUCCESS'
                                    ? 'success'
                                    : r.status === 'PARTIAL_SUCCESS'
                                      ? 'warning'
                                      : 'danger'
                                }
                                label={
                                  r.status === 'SUCCESS'
                                    ? 'สำเร็จ'
                                    : r.status === 'PARTIAL_SUCCESS'
                                      ? 'สำเร็จบางส่วน'
                                      : 'ขัดข้อง'
                                }
                                compact
                              />
                            </td>
                            <td className="text-right font-mono tabular-nums whitespace-nowrap">
                              <span className="font-semibold text-[#292638]">
                                {r.total_events_read}
                              </span>
                              {Number(r.filtered_out_count || 0) > 0 && (
                                <div className="text-[11.5px] text-[#8066B5]">
                                  ตรงช่วง {r.matched_in_range_count ?? r.total_events_read}
                                </div>
                              )}
                            </td>
                            <td className="text-right font-mono tabular-nums font-bold text-[#198568]">
                              {r.new_scans_inserted}
                              {(Number(r.attendance_created_count || 0) > 0 ||
                                Number(r.attendance_updated_count || 0) > 0) && (
                                <div className="text-[11px] font-normal text-[#4E3978]">
                                  เวร +
                                  {Number(r.attendance_created_count || 0) +
                                    Number(r.attendance_updated_count || 0)}
                                </div>
                              )}
                            </td>
                            <td className="text-right font-mono tabular-nums text-[#777287] whitespace-nowrap">
                              <span>{r.duplicate_scans_skipped}</span>
                              {Number(r.failed_events_count || 0) > 0 && (
                                <span className="text-[#C74455] font-semibold">
                                  {' '}
                                  / {r.failed_events_count}
                                </span>
                              )}
                            </td>
                            <td className="text-[#777287] text-[13px]">
                              {r.error_code
                                ? `${r.error_code}: ${r.error_message}`
                                : r.error_message || 'ทำงานปกติ'}
                            </td>
                            <td className="text-right">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleInspectSyncRun(r);
                                }}
                                className="ent-btn-secondary h-8 px-3 text-[12.5px]"
                              >
                                <Eye className="w-3.5 h-3.5 text-[#8066B5]" />
                                <span>รายละเอียด</span>
                              </button>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                <TablePaginationBar
                  totalItems={historyTotal}
                  currentPage={historyPage}
                  pageSize={historyPageSize}
                  onPageChange={setHistoryPage}
                  onPageSizeChange={setHistoryPageSize}
                />
              </div>
            )}
          </div>
        </div>
      ) : (
        /* =================================================================
            โหมด 'rawScans': ข้อมูลสแกนลายนิ้วมือต้นฉบับ (Immutable Raw Scans)
           ================================================================= */
        <div className="space-y-5">
          <div className="his-surface p-4 sm:p-5 space-y-3.5">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3">
              <div className="relative lg:col-span-4">
                <Search
                  className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                  aria-hidden="true"
                />
                <input
                  type="text"
                  aria-label="ค้นหาข้อมูลสแกนต้นฉบับ"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="ค้นหารหัสสแกน, รหัสบุคลากร หรือชื่อ..."
                  className="ent-input ent-input-with-icon pr-4 w-full"
                />
              </div>

              <div className="lg:col-span-2">
                <input
                  type="date"
                  aria-label="ตั้งแต่วันที่สแกน"
                  value={scanDateFrom}
                  onChange={(e) => {
                    setScanDateFrom(e.target.value);
                    setPage(1);
                  }}
                  className="ent-input w-full font-mono text-[13.5px]"
                  title="ตั้งแต่วันที่สแกน"
                />
              </div>

              <div className="lg:col-span-2">
                <input
                  type="date"
                  aria-label="ถึงวันที่สแกน"
                  value={scanDateTo}
                  onChange={(e) => {
                    setScanDateTo(e.target.value);
                    setPage(1);
                  }}
                  className="ent-input w-full font-mono text-[13.5px]"
                  title="ถึงวันที่สแกน"
                />
              </div>

              <div className="lg:col-span-2">
                <select
                  aria-label="กรองตามหมายเลขเครื่องสแกน"
                  value={machineFilter}
                  onChange={(e) => {
                    setMachineFilter(e.target.value);
                    setPage(1);
                  }}
                  className="ent-input w-full"
                >
                  <option value="">ทุกเครื่องสแกน</option>
                  {devices.length > 0 ? (
                    devices.map((d: any) => (
                      <option key={d.id} value={String(d.machine_no)}>
                        เครื่อง #{d.machine_no} ({d.device_name})
                      </option>
                    ))
                  ) : (
                    <>
                      <option value="101">เครื่อง #101 (อาคารผู้ป่วยนอก OPD)</option>
                      <option value="102">เครื่อง #102 (อาคารอุบัติเหตุฉุกเฉิน ER)</option>
                      <option value="103">เครื่อง #103 (อาคารผู้ป่วยใน / บริหาร)</option>
                    </>
                  )}
                </select>
              </div>

              <div className="lg:col-span-2">
                <select
                  aria-label="กรองตามสถานะการเชื่อมโยงบุคลากร"
                  value={mappingState}
                  onChange={(e) => {
                    setMappingState(e.target.value);
                    setPage(1);
                  }}
                  className="ent-input w-full"
                >
                  <option value="">ทุกสถานะการเชื่อมโยง</option>
                  <option value="MATCHED">เชื่อมโยงบุคลากรสำเร็จ</option>
                  <option value="UNMATCHED">ยังไม่พบรหัสสแกนในทะเบียน</option>
                  <option value="CONFLICT">รหัสสแกนซ้ำซ้อน</option>
                </select>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-[#E8E4EF]">
              <label className="inline-flex items-center gap-2.5 text-[13.5px] text-[#292638] cursor-pointer select-none font-medium">
                <input
                  type="checkbox"
                  checked={onlyMultiScan}
                  onChange={(e) => {
                    setOnlyMultiScan(e.target.checked);
                    setPage(1);
                  }}
                  className="w-4 h-4 rounded-xs border-[#D8D1E6] accent-[#8066B5]"
                />
                <span>แสดงเฉพาะผู้ที่สแกนมากกว่า 1 ครั้งในวันเดียวกัน</span>
              </label>

              <div className="flex items-center gap-3 text-[13px] text-[#777287]">
                <span className="tabular-nums">
                  พบ <strong className="text-[#292638]">{filteredAndSortedScans.length}</strong> รายการ
                </span>
                {hasActiveRawScanFilters && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      setMachineFilter('');
                      setMappingState('');
                      setScanDateFrom('');
                      setScanDateTo('');
                      setOnlyMultiScan(false);
                      setPage(1);
                    }}
                    className="inline-flex items-center gap-1 text-[#8066B5] hover:text-[#4E3978] font-semibold cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>ล้างตัวกรอง</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="ent-table-wrapper">
            {/* Mobile View */}
            <div className="md:hidden divide-y divide-[#E8E4EF]">
              {loading ? (
                <div className="p-4">
                  <TableLoadingSkeleton rows={4} cols={2} />
                </div>
              ) : pagedScans.length === 0 ? (
                <div className="py-10 px-4 text-center text-[14px] text-[#777287]">
                  ไม่พบข้อมูลสแกนต้นฉบับตามตัวกรองที่เลือก
                </div>
              ) : (
                pagedScans.map((rs) => (
                  <div key={rs.id} className="p-4 space-y-2.5 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-[12.5px] font-semibold text-[#777287] tabular-nums">
                          ลำดับสแกน #{rs.id} · เครื่อง #{rs.machine_no}
                        </div>
                        <div className="font-bold text-[15px] text-[#292638] tabular-nums mt-0.5">
                          {formatThaiDateTime(rs.canonical_bkk_time)}
                        </div>
                      </div>
                      <StatusBadge tone="brand" label={rs.enroll_number} icon={null} compact />
                    </div>

                    <div className="space-y-1 text-[13px]">
                      <div className="text-[#292638]">
                        {rs.matched_person_id ? (
                          <span className="font-semibold text-[#198568]">
                            {rs.full_name} ({rs.matched_person_id})
                          </span>
                        ) : (
                          <span className="font-semibold text-[#C74455]">
                            ยังไม่พบผู้ถือรหัสนี้ ({rs.mapping_state})
                          </span>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[#777287]">
                          {rs.in_out_mode === 0 ? 'สแกนเข้างาน (0)' : 'สแกนออกงาน (1)'}
                        </span>
                        {renderUsageStatus(rs)}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedScanModal(rs)}
                      className="ent-btn-secondary w-full h-9 text-[13px]"
                    >
                      <PanelRightOpen className="w-4 h-4 text-[#8066B5]" />
                      <span>เปิดดูข้อมูล JSON 6 ฟิลด์ต้นฉบับ</span>
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              {loading ? (
                <div className="p-5">
                  <TableLoadingSkeleton rows={6} cols={7} />
                </div>
              ) : (
                <table className="his-table">
                  <thead>
                    <tr>
                      <SortableHeader
                        label="ลำดับสแกน"
                        sortKey="id"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        label="วันและเวลาที่สแกน"
                        sortKey="canonical_bkk_time"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        label="เครื่องสแกน"
                        sortKey="machine_no"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        label="รหัสสแกน (enrollNumber)"
                        sortKey="enroll_number"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <th>ประเภทสแกน / โหมดยืนยัน</th>
                      <th>บุคลากรและสถานะการใช้จับคู่</th>
                      <th className="text-right">ข้อมูลต้นฉบับ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedScans.length === 0 ? (
                      <TableEmptyState
                        colSpan={7}
                        title="ไม่พบข้อมูลสแกนต้นฉบับตามตัวกรองที่เลือก"
                      />
                    ) : (
                      pagedScans.map((rs) => (
                        <tr key={rs.id}>
                          <td className="font-mono tabular-nums font-semibold text-[#777287]">
                            #{rs.id}
                          </td>
                          <td>
                            <div className="font-semibold text-[#292638] tabular-nums">
                              {formatThaiDateTime(rs.canonical_bkk_time)}
                            </div>
                            <div className="text-[12px] font-mono text-[#777287] tabular-nums mt-0.5">
                              {rs.canonical_bkk_time}
                            </div>
                          </td>
                          <td className="font-mono tabular-nums font-semibold text-[#292638] whitespace-nowrap">
                            เครื่อง #{rs.machine_no}
                          </td>
                          <td className="font-mono tabular-nums">
                            <StatusBadge tone="brand" label={rs.enroll_number} icon={null} compact />
                          </td>
                          <td>
                            <div className="font-medium text-[#292638]">
                              {rs.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'}
                            </div>
                            <div className="text-[12px] font-mono text-[#777287]">
                              verify={rs.verify_mode} · work={rs.work_code}
                            </div>
                          </td>
                          <td>
                            {rs.matched_person_id ? (
                              <div className="space-y-1">
                                <div className="font-semibold text-[#292638]">
                                  {rs.full_name}{' '}
                                  <span className="text-[12px] font-mono font-normal text-[#777287]">
                                    ({rs.matched_person_id})
                                  </span>
                                </div>
                                <div>{renderUsageStatus(rs)}</div>
                              </div>
                            ) : (
                              renderUsageStatus(rs)
                            )}
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => setSelectedScanModal(rs)}
                              className="ent-btn-secondary h-8 px-3 text-[12.5px]"
                            >
                              <PanelRightOpen className="w-3.5 h-3.5 text-[#8066B5]" />
                              <span>ดู JSON</span>
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}
            </div>

            <TablePaginationBar
              totalItems={filteredAndSortedScans.length}
              currentPage={page}
              pageSize={pageSize}
              onPageChange={setPage}
              onPageSizeChange={setPageSize}
            />
          </div>
        </div>
      )}

      {/* Raw Scan 6-Field Contract Slide-Over Inspector Drawer */}
      <SlideOverDrawer
        open={Boolean(selectedScanModal)}
        onClose={() => setSelectedScanModal(null)}
        kickerText="ข้อมูลสแกนต้นฉบับจากเครื่องสแกน (ห้ามแก้ไขหรือลบ)"
        title={
          selectedScanModal
            ? `รายการสแกน #${selectedScanModal.id} · เครื่อง #${selectedScanModal.machine_no}`
            : ''
        }
        subtitle={
          selectedScanModal
            ? `เวลาสแกน: ${formatThaiDateTime(selectedScanModal.canonical_bkk_time)}`
            : ''
        }
      >
        {selectedScanModal && (
          <div className="space-y-5">
            <div className="his-surface divide-y divide-[#E8E4EF]">
              <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[12.5px] text-[#777287]">รหัสลายนิ้วมือ (enrollNumber)</div>
                  <div className="font-mono font-bold text-[16px] text-[#4E3978] mt-0.5 tabular-nums">
                    {selectedScanModal.enroll_number}
                  </div>
                </div>
                <div>
                  <div className="text-[12.5px] text-[#777287]">เวลาสแกนมาตรฐาน (Asia/Bangkok)</div>
                  <div className="font-mono font-semibold text-[15px] text-[#292638] mt-0.5 tabular-nums">
                    {selectedScanModal.canonical_bkk_time}
                  </div>
                </div>
              </div>
              <div className="p-4">
                <div className="text-[12.5px] text-[#777287]">บุคลากรที่เชื่อมโยง</div>
                <div className="font-semibold text-[#292638] mt-0.5">
                  {selectedScanModal.matched_person_id
                    ? `${selectedScanModal.full_name} (${selectedScanModal.matched_person_id})`
                    : `ยังไม่เชื่อมโยงบุคลากร (${selectedScanModal.mapping_state})`}
                </div>
              </div>
              <div className="p-4">
                <div className="text-[12.5px] text-[#777287]">สถานะการใช้จับคู่เวร</div>
                <div className="mt-1">{renderUsageStatus(selectedScanModal)}</div>
              </div>
              <div className="p-4">
                <div className="text-[12.5px] text-[#777287]">
                  รหัสป้องกันข้อมูลซ้ำ (SHA-256 Event Key)
                </div>
                <div className="font-mono text-[12px] text-[#777287] break-all mt-0.5">
                  {selectedScanModal.unique_event_key}
                </div>
              </div>
            </div>

            <div>
              <div className="text-[14px] font-bold text-[#292638] mb-2">
                ข้อมูล JSON 6 ฟิลด์ตามสัญญาจากโปรแกรม ScannerReader.exe
              </div>
              <pre className="p-4 bg-[#292638] text-[#F8F7FC] rounded-xl font-mono text-[12.5px] overflow-x-auto leading-relaxed">
                {selectedScanModal.raw_payload_json}
              </pre>
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {/* Modal แสดงรายละเอียดของรอบการดึงข้อมูลจากเครื่องสแกน */}
      <SharedModal
        open={Boolean(selectedSyncRunDetail)}
        onClose={() => setSelectedSyncRunDetail(null)}
        kickerText="รายละเอียดรอบการดึงข้อมูลจากเครื่องสแกน"
        title={
          selectedSyncRunDetail
            ? `รอบการดึงข้อมูล #${selectedSyncRunDetail.id}`
            : 'รายละเอียดรอบการดึงข้อมูล'
        }
        maxWidthClass="max-w-lg"
      >
        {selectedSyncRunDetail && (
          <div className="his-surface divide-y divide-[#E8E4EF] text-[13.5px]">
            <div className="p-4 space-y-2">
              <div className="flex justify-between gap-3">
                <span className="text-[#777287]">วันและเวลาที่เริ่ม:</span>
                <span className="font-mono font-bold text-[#292638] tabular-nums">
                  {formatThaiDateTime(selectedSyncRunDetail.started_at)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#777287]">ช่องทางการสั่งซิงก์:</span>
                <span className="font-mono text-[#292638]">{selectedSyncRunDetail.trigger_mode}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#777287]">โหมดการดึงข้อมูล:</span>
                <span className="font-semibold text-[#4E3978]">
                  {formatSyncScopeLabel(selectedSyncRunDetail.sync_scope_mode)}
                  {selectedSyncRunDetail.import_year_month
                    ? ` · ${formatThaiYearMonth(selectedSyncRunDetail.import_year_month)}`
                    : ''}
                </span>
              </div>
              {selectedSyncRunDetail.filter_from_bkk && selectedSyncRunDetail.filter_to_bkk && (
                <div className="flex justify-between gap-3">
                  <span className="text-[#777287]">ช่วงเวลาที่เลือก (Asia/Bangkok):</span>
                  <span className="font-mono font-semibold text-[#292638] text-right tabular-nums">
                    {selectedSyncRunDetail.filter_from_bkk} ถึง{' '}
                    {selectedSyncRunDetail.filter_to_bkk}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-[#777287]">กลไกการคัดกรอง:</span>
                <span className="text-[#292638] text-right text-[13px]">
                  {formatFilterStrategyLabel(selectedSyncRunDetail.filter_strategy)}
                </span>
              </div>
              <div className="flex justify-between items-center gap-3">
                <span className="text-[#777287]">สถานะ:</span>
                <StatusBadge
                  tone={
                    selectedSyncRunDetail.status === 'SUCCESS'
                      ? 'success'
                      : selectedSyncRunDetail.status === 'PARTIAL_SUCCESS'
                        ? 'warning'
                        : 'danger'
                  }
                  label={
                    selectedSyncRunDetail.status === 'SUCCESS'
                      ? 'สำเร็จ (SUCCESS)'
                      : selectedSyncRunDetail.status === 'PARTIAL_SUCCESS'
                        ? 'สำเร็จบางส่วน (PARTIAL_SUCCESS)'
                        : 'ขัดข้อง (FAILED)'
                  }
                  compact
                />
              </div>
            </div>

            <div className="p-4 space-y-1.5">
              <div className="flex justify-between">
                <span className="text-[#777287]">จำนวนข้อมูลที่อ่านจากเครื่องทั้งหมด:</span>
                <span className="font-mono font-bold text-[#292638] tabular-nums">
                  {selectedSyncRunDetail.total_events_read} รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">รายการที่ตรงช่วงเวลาที่เลือก:</span>
                <span className="font-mono font-bold text-[#4E3978] tabular-nums">
                  {selectedSyncRunDetail.matched_in_range_count ??
                    selectedSyncRunDetail.total_events_read}{' '}
                  รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">รายการนอกช่วงที่กรองออก (ไม่บันทึก):</span>
                <span className="font-mono text-[#777287] tabular-nums">
                  {selectedSyncRunDetail.filtered_out_count ?? 0} รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">บันทึกสแกนใหม่สำเร็จ:</span>
                <span className="font-mono font-bold text-[#198568] tabular-nums">
                  {selectedSyncRunDetail.new_scans_inserted} รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">ข้ามรายการซ้ำ:</span>
                <span className="font-mono text-[#777287] tabular-nums">
                  {selectedSyncRunDetail.duplicate_scans_skipped} รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">จับคู่บุคลากรสำเร็จ / ซ้ำซ้อน:</span>
                <span className="font-mono text-[#292638] tabular-nums">
                  {selectedSyncRunDetail.matched_scans_count ?? 0} /{' '}
                  {selectedSyncRunDetail.conflict_scans_count ?? 0} รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">อัปเดตตารางเวร (สร้างใหม่ / อัปเดต):</span>
                <span className="font-mono text-[#4E3978] tabular-nums">
                  {selectedSyncRunDetail.attendance_created_count ?? 0} /{' '}
                  {selectedSyncRunDetail.attendance_updated_count ?? 0} รายการ
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777287]">นำเข้าไม่สำเร็จ / ข้อมูลผิดรูปแบบ:</span>
                <span
                  className={`font-mono font-semibold tabular-nums ${
                    Number(selectedSyncRunDetail.failed_events_count || 0) > 0
                      ? 'text-[#C74455]'
                      : 'text-[#777287]'
                  }`}
                >
                  {selectedSyncRunDetail.failed_events_count ?? 0} รายการ
                </span>
              </div>
            </div>

            {selectedSyncRunDetail.machine_results_json && (() => {
              try {
                const parsed = JSON.parse(selectedSyncRunDetail.machine_results_json);
                if (!Array.isArray(parsed) || parsed.length === 0) return null;
                return (
                  <div className="p-4 space-y-2">
                    <div className="text-[#777287] font-semibold">สถานะรายเครื่องสแกน:</div>
                    <div className="space-y-1.5">
                      {parsed.map((mr: any, idx: number) => (
                        <div
                          key={`${mr.machineNo}-${idx}`}
                          className="flex items-center justify-between gap-2 text-[12.5px] bg-[#F8F7FC] px-3 py-1.5 rounded-lg"
                        >
                          <span className="font-mono font-semibold text-[#292638]">
                            เครื่อง #{mr.machineNo}
                          </span>
                          <span
                            className={
                              String(mr.status || '').toUpperCase() === 'OK'
                                ? 'text-[#198568] font-semibold'
                                : 'text-[#C74455] font-semibold'
                            }
                          >
                            {mr.status}
                            {typeof mr.eventsRead === 'number' ? ` (${mr.eventsRead} รายการ)` : ''}
                            {mr.message ? ` — ${mr.message}` : ''}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              } catch {
                return null;
              }
            })()}

            <div className="p-4">
              <div className="text-[#777287] mb-1">หมายเหตุ / ข้อผิดพลาด:</div>
              <div className="font-mono text-[13px] text-[#292638]">
                {selectedSyncRunDetail.error_code
                  ? `${selectedSyncRunDetail.error_code}: ${selectedSyncRunDetail.error_message}`
                  : selectedSyncRunDetail.error_message || 'ดึงข้อมูลและประมวลผลตามปกติ'}
              </div>
            </div>
          </div>
        )}
      </SharedModal>

      {/* Regular ConfirmDialog สำหรับ TODAY และ CUSTOM_RANGE */}
      {!requiresReauth && (
        <ConfirmDialog
          open={confirmSyncOpen}
          title="ยืนยันการดึงข้อมูลจากเครื่องสแกนลายนิ้วมือ"
          description={`${syncScopeDescription} — ระบบจะเชื่อมต่อโปรแกรมอ่านเครื่องสแกนเดิม คัดกรองตามช่วงเวลาที่เลือกบน Backend ป้องกันรายการซ้ำ และคำนวณเวลาปฏิบัติงานให้อัตโนมัติ`}
          confirmLabel="เริ่มดึงข้อมูลจากเครื่องสแกน"
          loading={syncingHardware}
          onConfirm={handleConfirmTriggerHardwareSync}
          onCancel={handleCloseSyncConfirm}
        />
      )}

      {/* Impact Confirmation + Actor Password Reauthentication Modal สำหรับ MONTHLY และ FULL_HISTORICAL */}
      {requiresReauth && (
        <SharedModal
          open={confirmSyncOpen}
          onClose={handleCloseSyncConfirm}
          kickerText="ยืนยันผลกระทบและยืนยันตัวตนก่อนดึงข้อมูลย้อนหลัง"
          title={
            syncMode === 'FULL_HISTORICAL'
              ? 'ยืนยันการดึงข้อมูลย้อนหลังทั้งหมด (Admin เท่านั้น)'
              : `ยืนยันการดึงข้อมูลรายเดือน (${formatThaiYearMonth(syncYearMonth)})`
          }
          maxWidthClass="max-w-xl"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleConfirmTriggerHardwareSync();
            }}
            className="space-y-4"
          >
            <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13.5px] space-y-1.5">
              <div className="font-bold text-[#4E3978]">ขอบเขตการดำเนินการ</div>
              <p className="text-[#292638] leading-relaxed">{syncScopeDescription}</p>
            </div>

            <div className="p-3.5 rounded-xl bg-[#FEF7EA] border border-[#B87516]/30 text-[13px] text-[#292638] space-y-1.5">
              <div className="font-bold text-[#B87516] flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>ผลกระทบและข้อควรรับทราบก่อนดำเนินการ</span>
              </div>
              <ul className="list-disc pl-5 space-y-1 text-[12.5px] leading-relaxed">
                <li>
                  ระบบอาจใช้เวลาประมวลผลนานกว่าปกติ เนื่องจากต้องอ่านข้อมูลย้อนหลัง คัดกรองรายการซ้ำ จับคู่รหัสสแกน และคำนวณตารางเวรใหม่
                </li>
                <li>
                  ข้อมูลสแกนต้นฉบับ (Raw Scans) จะไม่ถูกแก้ไขหรือลบ และรายการที่มีอยู่แล้วจะถูกข้ามอัตโนมัติ (ไม่สร้างข้อมูลซ้ำ)
                </li>
                <li>
                  หมายเหตุ HR, ข้อมูลการลา, สถานะตรวจสอบ HR Review และประวัติการส่งออกจะยังคงอยู่ครบถ้วน
                </li>
                {syncMode === 'FULL_HISTORICAL' && (
                  <li>
                    โปรแกรมอ่านเครื่องสแกนเดิมรองรับสูงสุด {maxSyncRangeDays} วันย้อนหลังต่อคำสั่งตามพารามิเตอร์ <code className="font-mono">--days</code>
                  </li>
                )}
              </ul>
            </div>

            <label className="flex items-start gap-2.5 p-3 rounded-xl border border-[#D8D1E6] bg-white cursor-pointer select-none">
              <input
                type="checkbox"
                checked={impactAcknowledged}
                onChange={(e) => {
                  setImpactAcknowledged(e.target.checked);
                  if (reauthError) setReauthError(null);
                }}
                className="w-4 h-4 mt-0.5 rounded-xs accent-[#8066B5]"
              />
              <span className="text-[13.5px] font-medium text-[#292638] leading-snug">
                ข้าพเจ้ารับทราบขอบเขตและผลกระทบของการดึงข้อมูลย้อนหลังและการประมวลผลเวลาปฏิบัติงานนี้แล้ว
              </span>
            </label>

            <div>
              <label htmlFor="sync-reauth-password" className="ent-label">
                ยืนยันรหัสผ่านบัญชีปัจจุบัน ({user.username}) <RequiredMark />
              </label>
              <input
                id="sync-reauth-password"
                type="password"
                autoComplete="current-password"
                disabled={syncingHardware}
                value={confirmPassword}
                onChange={(e) => {
                  setConfirmPassword(e.target.value);
                  if (reauthError) setReauthError(null);
                }}
                placeholder="กรอกรหัสผ่านของบัญชีที่เข้าสู่ระบบอยู่..."
                className="ent-input w-full"
              />
              <p className="text-[12px] text-[#777287] mt-1">
                ระบบตรวจสอบรหัสผ่านกับบัญชีปัจจุบันของคุณบนเซิร์ฟเวอร์เท่านั้น และจะไม่บันทึกรหัสผ่านไว้ใน Log
              </p>
            </div>

            {reauthError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-[#FDF2F4] border border-[#C74455]/25 text-[#C74455] text-[13px] font-medium flex items-start gap-2"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{reauthError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2.5 pt-2 border-t border-[#E8E4EF]">
              <button
                type="button"
                disabled={syncingHardware}
                onClick={handleCloseSyncConfirm}
                className="ent-btn-secondary"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={syncingHardware || !impactAcknowledged || !confirmPassword.trim()}
                className="ent-btn-primary"
              >
                <Lock className="w-4 h-4" />
                <span>
                  {syncingHardware ? 'กำลังตรวจสอบและดึงข้อมูล...' : 'ยืนยันและเริ่มดึงข้อมูล'}
                </span>
              </button>
            </div>
          </form>
        </SharedModal>
      )}

      <ProgressDialog
        open={syncProgressOpen}
        title="ดึงข้อมูลจากเครื่องสแกนลายนิ้วมือ"
        stepLabel={syncStepLabel}
        stageLabel={syncStageLabel}
        percent={syncPercent}
        status={syncStatus}
        summaryText={syncSummaryText}
        errorMessage={syncErrorText}
        onClose={() => setSyncProgressOpen(false)}
      />
    </div>
  );
}
