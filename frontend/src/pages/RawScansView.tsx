/**
 * ============================================================================
 * หน้าจัดการเครื่องสแกนและตรวจสอบข้อมูลสแกนต้นฉบับ 6 ฟิลด์ (Scanners & Immutable Raw Scans)
 * ไฟล์: frontend/src/pages/RawScansView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. โหมด 'scanners':
 *    - แสดงสถานะเครื่องสแกนนิ้ว, ตั้งเวลาดึงข้อมูลอัตโนมัติ (Sync Schedules)
 *    - สั่งดึงข้อมูลจากเครื่องสแกนทันที พร้อม ConfirmDialog และ ProgressDialog แบบเรียลไทม์ (Section 7.2)
 *    - ประวัติการดึงข้อมูลจากเครื่องสแกน รองรับการกรอง วันนี้ / 7 วันย้อนหลัง / 30 วันย้อนหลัง /
 *      เลือกช่วงวันที่เอง / กรองเครื่องสแกน / กรองสถานะ และคลิกดูรายละเอียดของแต่ละรอบได้ (Section 7.1)
 * 2. โหมด 'rawScans': แสดงข้อมูลสแกนลายนิ้วมือต้นฉบับแบบห้ามแก้ไข/ลบ (Immutable)
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
} from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SlideOverDrawer,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  TableEmptyState,
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
type ScannerSyncMode = 'TODAY' | 'CUSTOM_RANGE' | 'ALL';

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
  const [rawScans, setRawScans] = useState<any[]>([]);
  const [scannerData, setScannerData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [mappingState, setMappingState] = useState('');
  const [onlyMultiScan, setOnlyMultiScan] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sync Runs History Filters & Pagination (Section 7.1)
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

  // Immediate Scanner Sync Date/Time Range Controls + Confirm & Progress Dialog (Section 7.2)
  const [syncMode, setSyncMode] = useState<ScannerSyncMode>('TODAY');
  const [syncDateFrom, setSyncDateFrom] = useState(initialBkk.todayYmd);
  const [syncTimeFrom, setSyncTimeFrom] = useState('00:00');
  const [syncDateTo, setSyncDateTo] = useState(initialBkk.todayYmd);
  const [syncTimeTo, setSyncTimeTo] = useState('23:59');
  const [syncMachineNo, setSyncMachineNo] = useState('');
  const [lastSyncResult, setLastSyncResult] = useState<any | null>(null);
  const [confirmSyncOpen, setConfirmSyncOpen] = useState(false);
  const [syncingHardware, setSyncingHardware] = useState(false);
  const [syncProgressOpen, setSyncProgressOpen] = useState(false);
  const [syncStepLabel, setSyncStepLabel] = useState('กำลังเชื่อมต่อเครื่องสแกนลายนิ้วมือ...');
  const [syncPercent, setSyncPercent] = useState<number | null>(null);
  const [syncStatus, setSyncStatus] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
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

  // 6-Field EXE Contract Payload Ingestion
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
      // fallback to scannerData.syncRuns if needed
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

  const loadData = useCallback(async (clearError = true) => {
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
  }, [search, machineFilter, mappingState]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    loadSyncHistory();
  }, [loadSyncHistory]);

  // กู้คืนสถานะการซิงก์เครื่องสแกนหากรีเฟรชหน้าจอระหว่างทำงาน (Section 7.2 & 9)
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
          setSyncPercent(
            typeof res.activeJob.progressPercent === 'number' ? res.activeJob.progressPercent : null
          );
        } else if (syncingHardware && res?.latestJob && res.latestJob.status !== 'RUNNING') {
          setSyncingHardware(false);
          setSyncPercent(res.latestJob.status === 'SUCCESS' ? 100 : null);
          setSyncStatus(res.latestJob.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED');
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
    if (onlyMultiScan) {
      const counts = new Map<string, number>();
      for (const s of list) {
        const key = `${s.enroll_number}:${s.canonical_bkk_time.slice(0, 10)}`;
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      list = list.filter(
        (s) => (counts.get(`${s.enroll_number}:${s.canonical_bkk_time.slice(0, 10)}`) || 0) > 1
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
  }, [rawScans, onlyMultiScan, sortKey, sortDir]);

  const pagedScans = useMemo(() => {
    if (pageSize === 'ALL') return filteredAndSortedScans;
    const start = (page - 1) * pageSize;
    return filteredAndSortedScans.slice(start, start + pageSize);
  }, [filteredAndSortedScans, page, pageSize]);

  const maxSyncRangeDays = Number(scannerData?.syncRangeCapabilities?.maxRangeDays || 90);

  const syncRangeValidation = useMemo(() => {
    if (syncMode !== 'CUSTOM_RANGE') {
      return { valid: true, message: null as string | null, spanDays: syncMode === 'TODAY' ? 1 : null };
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
    if (!/^\d{2}:\d{2}(:\d{2})?$/.test(syncTimeFrom) || !/^\d{2}:\d{2}(:\d{2})?$/.test(syncTimeTo)) {
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
  }, [syncMode, syncDateFrom, syncTimeFrom, syncDateTo, syncTimeTo, maxSyncRangeDays]);

  const syncScopeDescription = useMemo(() => {
    const machineText = syncMachineNo
      ? `เครื่องสแกนหมายเลข #${syncMachineNo}`
      : 'ทุกเครื่องสแกนที่เปิดใช้งาน';
    if (syncMode === 'TODAY') {
      return `โหมดดึงข้อมูลวันนี้ (${formatThaiDate(initialBkk.todayYmd)} เวลา 00:00 – 23:59 น. เวลาประเทศไทย) · เป้าหมาย: ${machineText}`;
    }
    if (syncMode === 'CUSTOM_RANGE') {
      return `โหมดเลือกช่วงวันที่และเวลา: ${formatThaiDate(syncDateFrom)} ${syncTimeFrom} น. ถึง ${formatThaiDate(syncDateTo)} ${syncTimeTo} น. (${syncRangeValidation.spanDays || 1} วัน · เขตเวลา Asia/Bangkok) · เป้าหมาย: ${machineText}`;
    }
    return `โหมดดึงข้อมูลทั้งหมดที่เครื่องรองรับ (สูงสุด ${maxSyncRangeDays} วันย้อนหลังตามข้อจำกัดของโปรแกรมอ่านเครื่องสแกน) · เป้าหมาย: ${machineText}`;
  }, [
    syncMode,
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
    setConfirmSyncOpen(true);
  }

  async function handleConfirmTriggerHardwareSync() {
    if (!syncRangeValidation.valid) {
      setConfirmSyncOpen(false);
      setError({
        code: 'INVALID_DATE_TIME_RANGE',
        message: syncRangeValidation.message || 'ช่วงวันที่และเวลาที่เลือกไม่ถูกต้อง',
      });
      return;
    }

    setConfirmSyncOpen(false);
    setError(null);
    setNotice(null);
    setSyncingHardware(true);
    setSyncProgressOpen(true);
    setSyncStatus('RUNNING');
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
      if (syncMode === 'CUSTOM_RANGE') {
        payload.dateFrom = syncDateFrom;
        payload.timeFrom = syncTimeFrom;
        payload.dateTo = syncDateTo;
        payload.timeTo = syncTimeTo;
      }

      const res = await apiRequest('/scanners/sync', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      const readDevice = Number(res.totalReadFromDevice ?? res.totalRead ?? 0);
      const matchedInRange = Number(res.matchedInRange ?? readDevice);
      const filteredOut = Number(res.filteredOutCount ?? 0);
      const newInserted = Number(res.newInserted ?? 0);
      const dupSkipped = Number(res.duplicatesSkipped ?? 0);
      const failedCount = Number(res.failedCount ?? 0);

      const summary =
        syncMode === 'ALL'
          ? `ดึงข้อมูลสำเร็จ: อ่านจากเครื่อง ${readDevice} รายการ · บันทึกใหม่ ${newInserted} รายการ · ข้ามรายการซ้ำ ${dupSkipped} รายการ${failedCount > 0 ? ` · นำเข้าไม่สำเร็จ ${failedCount} รายการ` : ''}`
          : `ดึงข้อมูลสำเร็จ: อ่านจากเครื่อง ${readDevice} รายการ · ตรงช่วงที่เลือก ${matchedInRange} รายการ (กรองนอกช่วงออก ${filteredOut} รายการ) · บันทึกใหม่ ${newInserted} รายการ · ข้ามซ้ำ ${dupSkipped} รายการ${failedCount > 0 ? ` · ไม่สำเร็จ ${failedCount} รายการ` : ''}`;

      setLastSyncResult(res);
      setSyncPercent(100);
      setSyncStatus('SUCCESS');
      setSyncStepLabel('ดึงข้อมูลจากเครื่องสแกนและคำนวณเวลาเสร็จสมบูรณ์');
      setSyncSummaryText(summary);
      setNotice(summary);
      await loadData(false);
      await loadSyncHistory();
    } catch (err) {
      const errMsg =
        err instanceof ApiClientError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'ไม่สามารถดึงข้อมูลจากเครื่องสแกนได้';
      setSyncPercent(null);
      setSyncStatus('FAILED');
      setSyncStepLabel('ดึงข้อมูลจากเครื่องสแกนไม่สำเร็จ');
      setSyncErrorText(errMsg);
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: errMsg });
      }
      await loadData(false);
      await loadSyncHistory();
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

  return (
    <div className="space-y-6">
      <PageHeader
        category="เครื่องสแกนและข้อมูลต้นฉบับ"
        title={
          mode === 'rawScans'
            ? 'ข้อมูลสแกนลายนิ้วมือต้นฉบับ (Raw Scans)'
            : 'เครื่องสแกนและรอบการดึงข้อมูลอัตโนมัติ'
        }
        subtitle="รับข้อมูลเหตุการณ์สแกน 6 ฟิลด์จากโปรแกรมอ่านเครื่องสแกนเดิมของโรงพยาบาล (ข้อมูลต้นฉบับถูกคุ้มครองแบบห้ามแก้ไขหรือลบ)"
        actions={
          <>
            <PageHelpAction
              guideKey={mode === 'scanners' ? 'scanners' : 'rawScans'}
              userRole={user.role}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={syncingHardware || (mode === 'scanners' && !syncRangeValidation.valid)}
              onClick={handleRequestOpenSyncConfirm}
              className="ent-btn-primary disabled:opacity-60"
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
        <div className="space-y-6">
          {/* Scanner Device Status Cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {scannerData?.devices?.map((d: any) => {
              const isEnabled = Number(d.is_enabled) === 1;
              return (
                <div key={d.id} className="ent-card p-5 flex flex-col justify-between space-y-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-mono text-[13px] font-bold text-[#7359B4]">
                        เครื่องสแกนหมายเลข #{d.machine_no}
                      </div>
                      <h3 className="text-[16.5px] font-bold text-[#273244] mt-0.5">
                        {d.device_name}
                      </h3>
                      <p className="text-[13.5px] text-[#596579]">{d.location_name}</p>
                    </div>
                    <div
                      className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                        isEnabled
                          ? 'bg-emerald-50 text-[#047857]'
                          : 'bg-[#FAF9FD] text-[#596579]'
                      }`}
                    >
                      <Radio className="w-5 h-5" />
                    </div>
                  </div>

                  <div className="pt-3 border-t border-[#E7E2F0] space-y-1.5 text-[13.5px]">
                    <div className="flex items-center justify-between">
                      <span className="text-[#596579]">ที่อยู่เครือข่าย:</span>
                      <span className="font-mono text-[#273244] tabular-nums">
                        {d.ip_address}:{d.device_port}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#596579]">ซิงก์สำเร็จล่าสุด:</span>
                      <span className="font-mono text-[#273244] tabular-nums">
                        {d.last_success_at ? formatThaiDateTime(d.last_success_at) : d.last_sync_status}
                      </span>
                    </div>
                    <div className="flex items-center justify-between pt-2">
                      <span
                        className={`font-semibold ${
                          isEnabled ? 'text-[#047857]' : 'text-[#596579]'
                        }`}
                      >
                        {isEnabled ? 'เปิดใช้งานปกติ' : 'ปิดการดึงข้อมูลชั่วคราว'}
                      </span>
                      {user.role === 'ADMIN' && (
                        <button
                          type="button"
                          onClick={() => handleToggleScanner(d.id, Number(d.is_enabled))}
                          className="px-3 py-1.5 text-[13px] font-semibold border border-[#D5CEE6] rounded-lg bg-white hover:bg-[#FAF9FD] text-[#273244]"
                        >
                          {isEnabled ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* =================================================================
              แผงควบคุมการดึงข้อมูลจากเครื่องสแกนแบบเลือกช่วงวันที่และเวลา (Asia/Bangkok)
             ================================================================= */}
          <div className="ent-card p-5 sm:p-6 space-y-5 border-[#DDD3F2] bg-white">
            <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3 border-b border-[#E7E2F0] pb-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-[#F3EEFC] text-[#7359B4] flex items-center justify-center shrink-0">
                  <CalendarClock className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-[18px] font-bold text-[#273244]">
                    ดึงข้อมูลจากเครื่องสแกนลายนิ้วมือ (เลือกช่วงวันที่และเวลา)
                  </h2>
                  <p className="text-[13.5px] text-[#596579] mt-0.5">
                    เลือกโหมดการดึงข้อมูลและกำหนดช่วงวันที่/เวลาตามเวลาประเทศไทย (Asia/Bangkok) พร้อมตรวจสอบรายการซ้ำและคำนวณเวลาปฏิบัติงานอัตโนมัติ
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold">
                <span className="px-2.5 py-1 rounded-md bg-[#FAF9FD] border border-[#E7E2F0] text-[#596579] font-mono">
                  เขตเวลา: Asia/Bangkok (UTC+07:00)
                </span>
                <span className="px-2.5 py-1 rounded-md bg-[#F3EEFC] border border-[#DDD3F2] text-[#7359B4]">
                  สูงสุด {maxSyncRangeDays} วัน/รอบ
                </span>
              </div>
            </div>

            {/* โหมดการดึงข้อมูล 3 รูปแบบ */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {(
                [
                  {
                    key: 'TODAY',
                    title: 'ดึงข้อมูลวันนี้',
                    desc: `เฉพาะวันนี้ (${formatThaiDate(initialBkk.todayYmd)} 00:00 – 23:59 น.)`,
                  },
                  {
                    key: 'CUSTOM_RANGE',
                    title: 'เลือกช่วงวันที่และเวลา',
                    desc: 'กำหนดวัน-เวลาเริ่มต้นและสิ้นสุดเอง (รองรับข้ามวัน/ข้ามเดือน)',
                  },
                  {
                    key: 'ALL',
                    title: 'ดึงข้อมูลทั้งหมดที่เครื่องรองรับ',
                    desc: `ดึงทั้งหมดตามกรอบสูงสุดที่โปรแกรมอ่านสแกนรองรับ (สูงสุด ${maxSyncRangeDays} วัน)`,
                  },
                ] as Array<{ key: ScannerSyncMode; title: string; desc: string }>
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
                    className={`p-4 rounded-xl border text-left transition-colors disabled:opacity-60 ${
                      selected
                        ? 'bg-[#F3EEFC] border-[#8B73C7] ring-1 ring-[#8B73C7]/30'
                        : 'bg-[#FAF9FD] border-[#E7E2F0] hover:border-[#C7B9E6]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`text-[15px] font-bold ${
                          selected ? 'text-[#7359B4]' : 'text-[#273244]'
                        }`}
                      >
                        {opt.title}
                      </span>
                      <span
                        className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${
                          selected ? 'border-[#7359B4] bg-[#7359B4]' : 'border-[#B9B0CF] bg-white'
                        }`}
                      >
                        {selected && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                      </span>
                    </div>
                    <p className="text-[13px] text-[#596579] mt-1 leading-snug">{opt.desc}</p>
                  </button>
                );
              })}
            </div>

            {/* ฟอร์มเลือกช่วงวันที่และเวลา (CUSTOM_RANGE) */}
            {syncMode === 'CUSTOM_RANGE' && (
              <div className="p-4 sm:p-5 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-[14px] font-bold text-[#273244]">
                    กำหนดช่วงวันที่และเวลา (Asia/Bangkok)
                  </span>
                  <div className="flex flex-wrap items-center gap-1.5 text-[12.5px]">
                    <span className="text-[#596579] mr-1">เลือกด่วน:</span>
                    <button
                      type="button"
                      disabled={syncingHardware}
                      onClick={() => {
                        setSyncDateFrom(initialBkk.todayYmd);
                        setSyncTimeFrom('00:00');
                        setSyncDateTo(initialBkk.todayYmd);
                        setSyncTimeTo('23:59');
                      }}
                      className="px-2.5 py-1 rounded-md bg-white border border-[#D5CEE6] hover:bg-[#F3EEFC] text-[#273244] font-medium"
                    >
                      วันนี้
                    </button>
                    <button
                      type="button"
                      disabled={syncingHardware}
                      onClick={() => {
                        setSyncDateFrom(initialBkk.yesterdayYmd);
                        setSyncTimeFrom('00:00');
                        setSyncDateTo(initialBkk.yesterdayYmd);
                        setSyncTimeTo('23:59');
                      }}
                      className="px-2.5 py-1 rounded-md bg-white border border-[#D5CEE6] hover:bg-[#F3EEFC] text-[#273244] font-medium"
                    >
                      เมื่อวาน
                    </button>
                    <button
                      type="button"
                      disabled={syncingHardware}
                      onClick={() => {
                        setSyncDateFrom(shiftYmdDays(initialBkk.todayYmd, -6));
                        setSyncTimeFrom('00:00');
                        setSyncDateTo(initialBkk.todayYmd);
                        setSyncTimeTo('23:59');
                      }}
                      className="px-2.5 py-1 rounded-md bg-white border border-[#D5CEE6] hover:bg-[#F3EEFC] text-[#273244] font-medium"
                    >
                      ย้อนหลัง 7 วัน
                    </button>
                    <button
                      type="button"
                      disabled={syncingHardware}
                      onClick={() => {
                        setSyncDateFrom(initialBkk.monthStartYmd);
                        setSyncTimeFrom('00:00');
                        setSyncDateTo(initialBkk.todayYmd);
                        setSyncTimeTo('23:59');
                      }}
                      className="px-2.5 py-1 rounded-md bg-white border border-[#D5CEE6] hover:bg-[#F3EEFC] text-[#273244] font-medium"
                    >
                      ทั้งเดือนนี้
                    </button>
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
                    className="p-3 rounded-lg bg-red-50 border border-red-200 text-[#B91C1C] text-[13.5px] font-medium flex items-start gap-2"
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <span>{syncRangeValidation.message}</span>
                  </div>
                )}
              </div>
            )}

            {/* เลือกเครื่องสแกนเป้าหมาย + ปุ่มสั่งดึงข้อมูล */}
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
              <div className="w-full md:w-80">
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
                  {scannerData?.devices?.map((d: any) => (
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
                className="ent-btn-primary w-full md:w-auto disabled:opacity-60"
              >
                <RefreshCw className={`w-4 h-4 ${syncingHardware ? 'animate-spin' : ''}`} />
                <span>
                  {syncingHardware
                    ? 'กำลังดึงข้อมูลจากเครื่องสแกน...'
                    : syncMode === 'TODAY'
                      ? 'ดึงข้อมูลวันนี้จากเครื่องสแกน'
                      : syncMode === 'CUSTOM_RANGE'
                        ? 'ดึงข้อมูลตามช่วงวันที่และเวลาที่เลือก'
                        : 'ดึงข้อมูลทั้งหมดที่เครื่องรองรับ'}
                </span>
              </button>
            </div>

            {/* คำอธิบายกลไกการทำงานจริงของโปรแกรมอ่านเครื่องสแกน (Transparent Capability Info) */}
            <div className="p-3.5 rounded-xl bg-[#F7F4FC] border border-[#DDD3F2] text-[13px] text-[#45396B] flex items-start gap-2.5 leading-relaxed">
              <Info className="w-4 h-4 text-[#7359B4] shrink-0 mt-0.5" />
              <div>
                <span className="font-bold">กลไกการคัดกรองข้อมูลจริงของระบบ: </span>
                {scannerData?.syncRangeCapabilities?.explanationTh ||
                  `ระบบอ่านข้อมูลจากโปรแกรมเครื่องสแกนเดิมของโรงพยาบาล แล้วคัดกรองเฉพาะรายการสแกนที่มีเวลา (scanDateTime เขตเวลา Asia/Bangkok) อยู่ในช่วงวันที่และเวลาที่เลือกบน Backend ก่อนบันทึกลงฐานข้อมูล รายการนอกช่วงจะไม่ถูกบันทึก และเลือกช่วงได้สูงสุด ${maxSyncRangeDays} วันต่อรอบ`}
              </div>
            </div>

            {/* สรุปผลลัพธ์จริงของการดึงข้อมูลรอบล่าสุด */}
            {lastSyncResult && (
              <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="inline-flex items-center gap-2 text-[#047857] font-bold text-[14.5px]">
                    <CheckCircle2 className="w-4.5 h-4.5" />
                    <span>
                      สรุปผลการดึงข้อมูลรอบล่าสุด (#{lastSyncResult.syncRunId} ·{' '}
                      {formatSyncScopeLabel(lastSyncResult.syncMode)})
                    </span>
                  </div>
                  {lastSyncResult.filterFromBkk && lastSyncResult.filterToBkk && (
                    <span className="font-mono text-[12.5px] text-[#273244] bg-white px-2.5 py-0.5 rounded-md border border-emerald-200">
                      {lastSyncResult.filterFromBkk} ถึง {lastSyncResult.filterToBkk}
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 text-[13px]">
                  <div className="p-2.5 rounded-lg bg-white border border-emerald-100">
                    <div className="text-[#596579]">อ่านจากเครื่อง</div>
                    <div className="font-mono font-bold text-[17px] text-[#273244] mt-0.5">
                      {lastSyncResult.totalReadFromDevice ?? lastSyncResult.totalRead ?? 0}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-emerald-100">
                    <div className="text-[#596579]">ตรงช่วงที่เลือก</div>
                    <div className="font-mono font-bold text-[17px] text-[#7359B4] mt-0.5">
                      {lastSyncResult.matchedInRange ?? lastSyncResult.totalRead ?? 0}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-emerald-100">
                    <div className="text-[#596579]">กรองนอกช่วงออก</div>
                    <div className="font-mono font-bold text-[17px] text-[#596579] mt-0.5">
                      {lastSyncResult.filteredOutCount ?? 0}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-emerald-100">
                    <div className="text-[#596579]">บันทึกสแกนใหม่</div>
                    <div className="font-mono font-bold text-[17px] text-[#047857] mt-0.5">
                      {lastSyncResult.newInserted ?? 0}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-emerald-100">
                    <div className="text-[#596579]">ข้ามรายการซ้ำ</div>
                    <div className="font-mono font-bold text-[17px] text-[#596579] mt-0.5">
                      {lastSyncResult.duplicatesSkipped ?? 0}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-lg bg-white border border-emerald-100">
                    <div className="text-[#596579]">นำเข้าไม่สำเร็จ</div>
                    <div
                      className={`font-mono font-bold text-[17px] mt-0.5 ${
                        Number(lastSyncResult.failedCount ?? 0) > 0
                          ? 'text-[#B91C1C]'
                          : 'text-[#596579]'
                      }`}
                    >
                      {lastSyncResult.failedCount ?? 0}
                    </div>
                  </div>
                </div>
                {lastSyncResult.filterModeNotice && (
                  <p className="text-[12.5px] text-[#273244]">{lastSyncResult.filterModeNotice}</p>
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 6-Field Contract JSON Ingestion Form */}
            <form onSubmit={handleIngestContractJson} className="ent-card p-6 space-y-4">
              <div className="border-b border-[#E7E2F0] pb-3 flex items-center justify-between">
                <div>
                  <h2 className="text-[18px] font-bold text-[#273244]">
                    นำเข้าข้อมูลสแกนตามสัญญา 6 ฟิลด์ (JSON Ingest)
                  </h2>
                  <p className="text-[13.5px] text-[#596579]">
                    รองรับการส่งชุดข้อมูลจาก ScannerReader.exe พร้อมระบบคัดกรองข้อมูลซ้ำอัตโนมัติ
                  </p>
                </div>
              </div>
              <textarea
                rows={7}
                aria-label="ข้อมูล JSON 6 ฟิลด์ตามสัญญาโปรแกรมอ่านสแกน"
                value={jsonPayloadText}
                onChange={(e) => setJsonPayloadText(e.target.value)}
                className="w-full p-3.5 text-[13.5px] font-mono border border-[#D5CEE6] rounded-xl bg-[#FAF9FD] text-[#273244]"
              />
              <button type="submit" className="ent-btn-primary w-full sm:w-auto">
                <Upload className="w-4 h-4" />
                <span>นำเข้าข้อมูลสแกนและตรวจสอบรายการซ้ำ</span>
              </button>
            </form>

            {/* Admin Controls: Add Scanner & Add Sync Schedule */}
            <div className="space-y-6">
              {user.role === 'ADMIN' && (
                <form onSubmit={handleAddScanner} className="ent-card p-4 sm:p-6 space-y-4">
                  <div className="border-b border-[#E7E2F0] pb-2.5">
                    <h2 className="text-[18px] font-bold text-[#273244]">
                      ลงทะเบียนเครื่องสแกนใหม่ (สำหรับผู้ดูแลระบบ)
                    </h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
                    <Plus className="w-4 h-4 text-[#8B73C7]" />
                    <span>เพิ่มเครื่องสแกนเข้าสู่ระบบ</span>
                  </button>
                </form>
              )}

              {/* Sync Schedules Card */}
              <div className="ent-table-wrapper">
                <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2F0] bg-[#FAF9FD] flex items-center justify-between">
                  <h2 className="text-[17px] font-bold text-[#273244]">
                    ตารางเวลาดึงข้อมูลอัตโนมัติ ({scannerData?.schedules?.length || 0} รอบ/วัน)
                  </h2>
                </div>

                {user.role === 'ADMIN' && (
                  <form
                    onSubmit={handleAddSchedule}
                    className="p-4 border-b border-[#E7E2F0] bg-[#FAF9FD] flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2.5"
                  >
                    <input
                      type="text"
                      required
                      aria-label="ชื่อรอบดึงข้อมูล"
                      value={scheduleLabel}
                      onChange={(e) => setScheduleLabel(e.target.value)}
                      placeholder="ระบุชื่อรอบ เช่น หลังเข้าเวรเช้า..."
                      className="ent-input flex-1 min-w-0 sm:min-w-[180px]"
                    />
                    <input
                      type="time"
                      required
                      aria-label="เวลาซิงก์ HH:mm"
                      value={cronTime}
                      onChange={(e) => setCronTime(e.target.value)}
                      className="ent-input font-mono w-full sm:w-auto"
                    />
                    <button type="submit" className="ent-btn-primary w-full sm:w-auto">
                      เพิ่มรอบซิงก์
                    </button>
                  </form>
                )}

                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse text-[14px]">
                    <thead>
                      <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
                        <th className="py-3 px-4 sm:px-5 font-semibold">เวลาทำงาน</th>
                        <th className="py-3 px-4 sm:px-5 font-semibold">ชื่อรอบการซิงก์</th>
                        <th className="py-3 px-4 sm:px-5 font-semibold text-right">สถานะ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E7E2F0]">
                      {scannerData?.schedules?.map((s: any) => (
                        <tr key={s.id} className="hover:bg-[#FAF9FD]">
                          <td className="py-3.5 px-4 sm:px-5 font-mono font-bold text-[#7359B4]">
                            {s.cron_time} น.
                          </td>
                          <td className="py-3.5 px-4 sm:px-5 text-[#273244] font-medium">
                            {s.schedule_label}
                          </td>
                          <td className="py-3.5 px-4 sm:px-5 text-right">
                            {user.role === 'ADMIN' ? (
                              <button
                                type="button"
                                onClick={() => handleToggleSchedule(s.id, Number(s.is_enabled))}
                                className={`text-[13.5px] font-semibold px-3 py-1 rounded-lg border whitespace-nowrap ${
                                  Number(s.is_enabled) === 1
                                    ? 'text-[#047857] border-emerald-200 bg-emerald-50/70'
                                    : 'text-[#596579] border-[#D5CEE6] bg-white'
                                }`}
                              >
                                {Number(s.is_enabled) === 1 ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                              </button>
                            ) : (
                              <span className="font-semibold text-[#047857]">
                                {Number(s.is_enabled) === 1 ? 'เปิดใช้งาน' : 'ปิดชั่วคราว'}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </div>

          {/* =================================================================
              Section 7.1: ประวัติการดึงข้อมูลจากเครื่องสแกน + ตัวกรองย้อนหลัง
             ================================================================= */}
          <div className="ent-table-wrapper">
            <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2F0] bg-[#FAF9FD] flex flex-col xl:flex-row xl:items-center justify-between gap-3.5">
              <div>
                <h2 className="text-[18px] font-bold text-[#273244]">
                  ประวัติการดึงข้อมูลจากเครื่องสแกน
                </h2>
                <p className="text-[13px] text-[#596579]">
                  เลือกดูประวัติย้อนหลัง กรองตามเครื่องสแกนและสถานะ หรือคลิกที่แถวเพื่อดูรายละเอียดของรอบนั้น
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="inline-flex items-center p-1 bg-white border border-[#E7E2F0] rounded-lg">
                  {(
                    [
                      { key: 'TODAY', label: 'วันนี้' },
                      { key: '7D', label: '7 วันย้อนหลัง' },
                      { key: '30D', label: '30 วันย้อนหลัง' },
                      { key: 'CUSTOM', label: 'เลือกช่วงวันที่เอง' },
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
                      className={`px-2.5 py-1 rounded-md text-[12.5px] font-semibold transition-colors whitespace-nowrap ${
                        historyPeriod === p.key
                          ? 'bg-[#8B73C7] text-white'
                          : 'text-[#596579] hover:text-[#273244]'
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
                    <span className="text-[12.5px] text-[#596579]">ถึง</span>
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
                  {scannerData?.devices?.map((d: any) => (
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
                  <option value="FAILED">ไม่สำเร็จ (FAILED)</option>
                </select>
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
                    <th className="py-3.5 px-5 font-semibold">รหัสรอบ · วันและเวลา</th>
                    <th className="py-3.5 px-5 font-semibold">ช่องทาง · ช่วงเวลาที่เลือก</th>
                    <th className="py-3.5 px-5 font-semibold">สถานะ</th>
                    <th className="py-3.5 px-5 font-semibold text-right">อ่าน / ตรงช่วง</th>
                    <th className="py-3.5 px-5 font-semibold text-right">บันทึกใหม่</th>
                    <th className="py-3.5 px-5 font-semibold text-right">ข้ามซ้ำ / ไม่สำเร็จ</th>
                    <th className="py-3.5 px-5 font-semibold">หมายเหตุ / ข้อผิดพลาด</th>
                    <th className="py-3.5 px-5 font-semibold text-right">รายละเอียด</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E2F0]">
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
                        className="hover:bg-[#FAF9FD] cursor-pointer transition-colors"
                      >
                        <td className="py-4 px-5 font-mono tabular-nums text-[#273244] whitespace-nowrap">
                          #{r.id} · {formatThaiDateTime(r.started_at)}
                        </td>
                        <td className="py-4 px-5">
                          <div className="font-mono text-[13px] text-[#273244] font-semibold">
                            {r.trigger_mode} · {formatSyncScopeLabel(r.sync_scope_mode)}
                          </div>
                          {r.filter_from_bkk && r.filter_to_bkk ? (
                            <div className="font-mono text-[12px] text-[#7359B4] mt-0.5">
                              {r.filter_from_bkk} – {r.filter_to_bkk}
                            </div>
                          ) : (
                            <div className="text-[12px] text-[#596579] mt-0.5">
                              ไม่จำกัดช่วงเวลาย่อย
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-5 font-semibold whitespace-nowrap">
                          <span
                            className={
                              r.status === 'SUCCESS' ? 'text-[#047857]' : 'text-[#B91C1C]'
                            }
                          >
                            {r.status === 'SUCCESS' ? 'สำเร็จ' : 'ขัดข้อง'}
                          </span>
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums whitespace-nowrap">
                          <span className="font-semibold text-[#273244]">{r.total_events_read}</span>
                          {Number(r.filtered_out_count || 0) > 0 && (
                            <div className="text-[11.5px] text-[#7359B4]">
                              ตรงช่วง {r.matched_in_range_count ?? r.total_events_read}
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums font-bold text-[#047857]">
                          {r.new_scans_inserted}
                        </td>
                        <td className="py-4 px-5 text-right font-mono tabular-nums text-[#596579] whitespace-nowrap">
                          <span>{r.duplicate_scans_skipped}</span>
                          {Number(r.failed_events_count || 0) > 0 && (
                            <span className="text-[#B91C1C] font-semibold">
                              {' '}
                              / {r.failed_events_count}
                            </span>
                          )}
                        </td>
                        <td className="py-4 px-5 text-[#596579]">
                          {r.error_code ? `${r.error_code}: ${r.error_message}` : 'ทำงานปกติ'}
                        </td>
                        <td className="py-4 px-5 text-right">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleInspectSyncRun(r);
                            }}
                            className="h-8 px-3 rounded-lg border border-[#D5CEE6] bg-white hover:bg-[#F3EEFC] text-[12.5px] font-semibold text-[#7359B4] inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Eye className="w-3.5 h-3.5" />
                            <span>ดูรายละเอียด</span>
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
        </div>
      ) : (
        <div className="space-y-5">
          {/* Raw Scans Filter Bar */}
          <div className="ent-card p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-3 w-full lg:w-auto">
              <div className="relative w-full sm:w-72">
                <Search className="w-4 h-4 text-[#596579] absolute left-3.5 top-3" aria-hidden="true" />
                <input
                  type="text"
                  aria-label="ค้นหาข้อมูลสแกนต้นฉบับ"
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="ค้นหารหัสสแกน, รหัสบุคลากร หรือชื่อ..."
                  className="ent-input pl-10 pr-4 w-full"
                />
              </div>
              <select
                aria-label="กรองตามหมายเลขเครื่องสแกน"
                value={machineFilter}
                onChange={(e) => {
                  setMachineFilter(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกเครื่องสแกน</option>
                <option value="101">เครื่อง #101 (อาคารผู้ป่วยนอก OPD)</option>
                <option value="102">เครื่อง #102 (อาคารอุบัติเหตุฉุกเฉิน ER)</option>
                <option value="103">เครื่อง #103 (อาคารผู้ป่วยใน / บริหาร)</option>
              </select>
              <select
                aria-label="กรองตามสถานะการเชื่อมโยงบุคลากร"
                value={mappingState}
                onChange={(e) => {
                  setMappingState(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกสถานะการเชื่อมโยง</option>
                <option value="MATCHED">เชื่อมโยงบุคลากรสำเร็จ</option>
                <option value="UNMATCHED">ยังไม่พบรหัสสแกนในทะเบียน</option>
                <option value="CONFLICT">รหัสสแกนซ้ำซ้อน</option>
              </select>
            </div>

            <label className="inline-flex items-center gap-2.5 text-[14px] text-[#273244] cursor-pointer select-none font-medium">
              <input
                type="checkbox"
                checked={onlyMultiScan}
                onChange={(e) => {
                  setOnlyMultiScan(e.target.checked);
                  setPage(1);
                }}
                className="w-4 h-4 rounded-xs border-[#D5CEE6] accent-[#8B73C7]"
              />
              <span>แสดงเฉพาะผู้ที่สแกนมากกว่า 1 ครั้งในวันเดียวกัน</span>
            </label>
          </div>

          <div className="ent-table-wrapper">
            <div className="md:hidden divide-y divide-[#E7E2F0]">
              {loading ? (
                <div className="py-10 text-center text-[14.5px] text-[#596579]">
                  กำลังโหลดข้อมูลสแกนต้นฉบับ...
                </div>
              ) : pagedScans.length === 0 ? (
                <div className="py-10 px-4 text-center text-[14.5px] text-[#596579]">
                  ไม่พบข้อมูลสแกนต้นฉบับตามตัวกรองที่เลือก
                </div>
              ) : (
                pagedScans.map((rs) => (
                  <div key={rs.id} className="p-4 space-y-3 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono text-[13px] font-semibold text-[#596579]">
                          ลำดับสแกน #{rs.id} · เครื่อง #{rs.machine_no}
                        </div>
                        <div className="font-bold text-[15.5px] text-[#273244] mt-0.5">
                          {formatThaiDateTime(rs.canonical_bkk_time)}
                        </div>
                      </div>
                      <span className="font-mono font-bold text-[13.5px] text-[#7359B4] bg-[#F3EEFC] px-2.5 py-1 rounded-md border border-[#E7E2F0]">
                        {rs.enroll_number}
                      </span>
                    </div>

                    <div className="p-3 rounded-lg bg-[#FAF9FD] border border-[#E7E2F0] text-[13.5px] space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[#596579]">ประเภทสแกน:</span>
                        <span className="font-semibold text-[#273244]">
                          {rs.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[#596579]">บุคลากรที่เชื่อมโยง:</span>
                        {rs.matched_person_id ? (
                          <span className="font-bold text-[#047857]">
                            {rs.full_name} ({rs.matched_person_id})
                          </span>
                        ) : (
                          <span className="font-semibold text-[#B91C1C]">
                            ยังไม่พบผู้ถือรหัสนี้ ({rs.mapping_state})
                          </span>
                        )}
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[#596579]">สถานะการใช้จับคู่:</span>
                        {rs.usage_role === 'CHECK_IN' ? (
                          <span className="font-semibold text-[#047857]">
                            ใช้เป็นสแกนเข้า ({rs.used_shift_code || `เวร #${rs.used_attendance_id}`})
                          </span>
                        ) : rs.usage_role === 'CHECK_OUT' ? (
                          <span className="font-semibold text-[#2563EB]">
                            ใช้เป็นสแกนออก ({rs.used_shift_code || `เวร #${rs.used_attendance_id}`})
                          </span>
                        ) : (
                          <span className="text-[#596579]">สแกนเพิ่มเติม</span>
                        )}
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedScanModal(rs)}
                      className="w-full h-10 px-3.5 text-[13.5px] bg-white border border-[#D5CEE6] rounded-lg hover:bg-[#F3EEFC] hover:border-[#8B73C7] hover:text-[#7359B4] inline-flex items-center justify-center gap-1.5 font-semibold text-[#273244] transition-colors"
                    >
                      <PanelRightOpen className="w-4 h-4 text-[#8B73C7]" />
                      <span>เปิดดูข้อมูล JSON 6 ฟิลด์ต้นฉบับ</span>
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
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
                    <th className="py-3.5 px-4 text-[13.5px] font-semibold">ประเภทสแกน / โหมดยืนยัน</th>
                    <th className="py-3.5 px-4 text-[13.5px] font-semibold">บุคลากรที่เชื่อมโยง</th>
                    <th className="py-3.5 px-4 text-[13.5px] font-semibold text-right">ข้อมูลต้นฉบับ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E2F0]">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="py-12 text-center text-[14.5px] text-[#596579]">
                        กำลังโหลดข้อมูลสแกนต้นฉบับ...
                      </td>
                    </tr>
                  ) : pagedScans.length === 0 ? (
                    <TableEmptyState colSpan={7} title="ไม่พบข้อมูลสแกนต้นฉบับตามตัวกรองที่เลือก" />
                  ) : (
                    pagedScans.map((rs) => (
                      <tr key={rs.id} className="hover:bg-[#FAF9FD] transition-colors">
                        <td className="py-4 px-4 font-mono tabular-nums font-semibold text-[#596579]">
                          #{rs.id}
                        </td>
                        <td className="py-4 px-4">
                          <div className="font-semibold text-[#273244]">
                            {formatThaiDateTime(rs.canonical_bkk_time)}
                          </div>
                          <div className="text-[12.5px] font-mono text-[#596579] tabular-nums mt-0.5">
                            {rs.canonical_bkk_time}
                          </div>
                        </td>
                        <td className="py-4 px-4 font-mono tabular-nums font-semibold text-[#273244]">
                          เครื่อง #{rs.machine_no}
                        </td>
                        <td className="py-4 px-4 font-mono tabular-nums">
                          <span className="font-bold text-[#7359B4] bg-[#F3EEFC] px-2.5 py-1 rounded-md border border-[#E7E2F0]">
                            {rs.enroll_number}
                          </span>
                        </td>
                        <td className="py-4 px-4 text-[#273244]">
                          <div className="font-medium">
                            {rs.in_out_mode === 0 ? 'สแกนเข้างาน (โหมด 0)' : 'สแกนออกงาน (โหมด 1)'}
                          </div>
                          <div className="text-[12.5px] font-mono text-[#596579]">
                            verify={rs.verify_mode} · work={rs.work_code}
                          </div>
                        </td>
                        <td className="py-4 px-4">
                          {rs.matched_person_id ? (
                            <div className="inline-flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-[#047857] shrink-0" />
                              <div>
                                <div className="font-bold text-[#273244]">{rs.full_name}</div>
                                <div className="text-[12.5px] font-mono text-[#596579]">
                                  {rs.matched_person_id}
                                </div>
                                <div className="text-[12px] mt-0.5">
                                  {rs.usage_role === 'CHECK_IN' ? (
                                    <span className="text-[#047857] font-semibold">
                                      ใช้เป็นสแกนเข้า ({rs.used_shift_code || `เวร #${rs.used_attendance_id}`})
                                    </span>
                                  ) : rs.usage_role === 'CHECK_OUT' ? (
                                    <span className="text-[#2563EB] font-semibold">
                                      ใช้เป็นสแกนออก ({rs.used_shift_code || `เวร #${rs.used_attendance_id}`})
                                    </span>
                                  ) : (
                                    <span className="text-[#596579]">สแกนเพิ่มเติม (ไม่ถูกใช้จับคู่)</span>
                                  )}
                                </div>
                              </div>
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1.5 text-[#B91C1C] font-semibold">
                              <AlertTriangle className="w-4 h-4 shrink-0" />
                              <span>ยังไม่พบผู้ถือรหัสนี้ ({rs.mapping_state})</span>
                            </div>
                          )}
                        </td>
                        <td className="py-4 px-4 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedScanModal(rs)}
                            className="h-9 px-3.5 text-[13.5px] bg-white border border-[#D5CEE6] rounded-lg hover:bg-[#F3EEFC] hover:border-[#8B73C7] hover:text-[#7359B4] inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-[#273244] transition-colors"
                          >
                            <PanelRightOpen className="w-4 h-4 text-[#8B73C7]" />
                            <span>ดูข้อมูล JSON</span>
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-[#FAF9FD] p-4 rounded-xl border border-[#E7E2F0]">
              <div>
                <div className="text-[13px] text-[#596579]">รหัสลายนิ้วมือ (enrollNumber)</div>
                <div className="font-mono font-bold text-[16px] text-[#7359B4] mt-0.5">
                  {selectedScanModal.enroll_number}
                </div>
              </div>
              <div>
                <div className="text-[13px] text-[#596579]">เวลาสแกนมาตรฐาน (Asia/Bangkok)</div>
                <div className="font-mono font-semibold text-[15px] text-[#273244] mt-0.5">
                  {selectedScanModal.canonical_bkk_time}
                </div>
              </div>
              <div className="sm:col-span-2 pt-2 border-t border-[#E7E2F0]">
                <div className="text-[13px] text-[#596579]">บุคลากรที่เชื่อมโยง</div>
                <div className="font-bold text-[#273244] mt-0.5">
                  {selectedScanModal.matched_person_id
                    ? `${selectedScanModal.full_name} (${selectedScanModal.matched_person_id})`
                    : `ยังไม่เชื่อมโยงบุคลากร (${selectedScanModal.mapping_state})`}
                </div>
              </div>
              <div className="sm:col-span-2 pt-2 border-t border-[#E7E2F0]">
                <div className="text-[13px] text-[#596579]">รหัสป้องกันข้อมูลซ้ำ (SHA-256 Event Key)</div>
                <div className="font-mono text-[12px] text-[#596579] break-all mt-0.5">
                  {selectedScanModal.unique_event_key}
                </div>
              </div>
            </div>

            <div>
              <div className="text-[14px] font-bold text-[#273244] mb-2">
                ข้อมูล JSON 6 ฟิลด์ตามสัญญาจากโปรแกรม ScannerReader.exe
              </div>
              <pre className="p-4 bg-[#273244] text-white rounded-xl font-mono text-[13px] overflow-x-auto leading-relaxed">
                {selectedScanModal.raw_payload_json}
              </pre>
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {/* Modal แสดงรายละเอียดของรอบการดึงข้อมูลจากเครื่องสแกน (Section 7.1) */}
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
          <div className="space-y-3 text-[14px]">
            <div className="p-4 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] space-y-2">
              <div className="flex justify-between gap-3">
                <span className="text-[#596579]">วันและเวลาที่เริ่ม:</span>
                <span className="font-mono font-bold text-[#273244]">
                  {formatThaiDateTime(selectedSyncRunDetail.started_at)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#596579]">ช่องทางการสั่งซิงก์:</span>
                <span className="font-mono text-[#273244]">{selectedSyncRunDetail.trigger_mode}</span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#596579]">โหมดการดึงข้อมูล:</span>
                <span className="font-semibold text-[#7359B4]">
                  {formatSyncScopeLabel(selectedSyncRunDetail.sync_scope_mode)}
                </span>
              </div>
              {selectedSyncRunDetail.filter_from_bkk && selectedSyncRunDetail.filter_to_bkk && (
                <div className="flex justify-between gap-3">
                  <span className="text-[#596579]">ช่วงเวลาที่เลือก (Asia/Bangkok):</span>
                  <span className="font-mono font-semibold text-[#273244] text-right">
                    {selectedSyncRunDetail.filter_from_bkk} ถึง{' '}
                    {selectedSyncRunDetail.filter_to_bkk}
                  </span>
                </div>
              )}
              <div className="flex justify-between gap-3">
                <span className="text-[#596579]">กลไกการคัดกรอง:</span>
                <span className="text-[#273244] text-right text-[13px]">
                  {formatFilterStrategyLabel(selectedSyncRunDetail.filter_strategy)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-[#596579]">สถานะ:</span>
                <span
                  className={`font-bold ${
                    selectedSyncRunDetail.status === 'SUCCESS'
                      ? 'text-[#047857]'
                      : 'text-[#B91C1C]'
                  }`}
                >
                  {selectedSyncRunDetail.status === 'SUCCESS' ? 'สำเร็จ (SUCCESS)' : 'ขัดข้อง (FAILED)'}
                </span>
              </div>
              <div className="pt-2 border-t border-[#E7E2F0] space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-[#596579]">จำนวนข้อมูลที่อ่านจากเครื่องทั้งหมด:</span>
                  <span className="font-mono font-bold text-[#273244]">
                    {selectedSyncRunDetail.total_events_read} รายการ
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#596579]">รายการที่ตรงช่วงเวลาที่เลือก:</span>
                  <span className="font-mono font-bold text-[#7359B4]">
                    {selectedSyncRunDetail.matched_in_range_count ?? selectedSyncRunDetail.total_events_read}{' '}
                    รายการ
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#596579]">รายการนอกช่วงที่กรองออก (ไม่บันทึก):</span>
                  <span className="font-mono text-[#596579]">
                    {selectedSyncRunDetail.filtered_out_count ?? 0} รายการ
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#596579]">บันทึกสแกนใหม่สำเร็จ:</span>
                  <span className="font-mono font-bold text-[#047857]">
                    {selectedSyncRunDetail.new_scans_inserted} รายการ
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#596579]">ข้ามรายการซ้ำ:</span>
                  <span className="font-mono text-[#596579]">
                    {selectedSyncRunDetail.duplicate_scans_skipped} รายการ
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#596579]">นำเข้าไม่สำเร็จ / ข้อมูลผิดรูปแบบ:</span>
                  <span
                    className={`font-mono font-semibold ${
                      Number(selectedSyncRunDetail.failed_events_count || 0) > 0
                        ? 'text-[#B91C1C]'
                        : 'text-[#596579]'
                    }`}
                  >
                    {selectedSyncRunDetail.failed_events_count ?? 0} รายการ
                  </span>
                </div>
              </div>
              <div className="pt-2 border-t border-[#E7E2F0]">
                <div className="text-[#596579] mb-1">หมายเหตุ / ข้อผิดพลาด:</div>
                <div className="font-mono text-[13px] text-[#273244]">
                  {selectedSyncRunDetail.error_code
                    ? `${selectedSyncRunDetail.error_code}: ${selectedSyncRunDetail.error_message}`
                    : 'ดึงข้อมูลและประมวลผลตามปกติ'}
                </div>
              </div>
            </div>
          </div>
        )}
      </SharedModal>

      {/* ConfirmDialog ก่อนสั่งดึงข้อมูลจากเครื่องสแกนทันที (Section 7.2) */}
      <ConfirmDialog
        open={confirmSyncOpen}
        title="ยืนยันการดึงข้อมูลจากเครื่องสแกนลายนิ้วมือ"
        description={`${syncScopeDescription} — ระบบจะเชื่อมต่อโปรแกรมอ่านเครื่องสแกนเดิม คัดกรองตามช่วงเวลาที่เลือกบน Backend ป้องกันรายการซ้ำ และคำนวณเวลาปฏิบัติงานให้อัตโนมัติ`}
        confirmLabel="เริ่มดึงข้อมูลจากเครื่องสแกน"
        loading={syncingHardware}
        onConfirm={handleConfirmTriggerHardwareSync}
        onCancel={() => setConfirmSyncOpen(false)}
      />

      {/* ProgressDialog แสดงสถานะการดึงข้อมูลจากเครื่องสแกน (Section 7.2) */}
      <ProgressDialog
        open={syncProgressOpen}
        title="ดึงข้อมูลจากเครื่องสแกนลายนิ้วมือ"
        stepLabel={syncStepLabel}
        percent={syncPercent}
        status={syncStatus}
        summaryText={syncSummaryText}
        errorMessage={syncErrorText}
        onClose={() => setSyncProgressOpen(false)}
      />
    </div>
  );
}
