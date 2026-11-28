/**
 * ============================================================================
 * ไฟล์: frontend/src/pages/ReportsView.tsx
 * หน้าที่: หน้าจอรายงานสถิติการมาสาย (Lateness Report) และการส่งข้อมูลเข้า HOSOffice (Direct Push)
 * ============================================================================
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Download,
  Eye,
  Send,
  FileText,
  Search,
  Lock,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Clock,
  Users,
  BarChart3,
  Info,
  FileSpreadsheet,
} from 'lucide-react';
import {
  apiRequest,
  downloadReportCenterXlsx,
  downloadReportCenterCsv,
  ApiClientError,
  type UserRole,
} from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SectionHeader,
  MetricStrip,
  StatusBadge,
  PeriodFilterBar,
  SortableHeader,
  TablePaginationBar,
  SharedModal,
  TableEmptyState,
  TableLoadingSkeleton,
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { useToast } from '../components/common/ToastContext.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  getCurrentBangkokDateParts,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

export function ReportsView({
  mode,
  userRole,
  onNavigate,
}: {
  mode: 'reports' | 'hosofficePush';
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);
  const toast = useToast();

  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState(initialBkk.todayYmd);
  const [monthValue, setMonthValue] = useState(initialBkk.currentYearMonth);
  const [yearValue, setYearValue] = useState(initialBkk.currentYear);
  const [customFrom, setCustomFrom] = useState(initialBkk.monthStartYmd);
  const [customTo, setCustomTo] = useState(initialBkk.monthEndYmd);
  const [personnelType, setPersonnelType] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [rankSearch, setRankSearch] = useState('');
  const [reportType, setReportType] = useState<string>(
    userRole === 'GENERAL_USER' ? 'OWN_ATTENDANCE' : 'SUMMARY'
  );
  const [exportingFormat, setExportingFormat] = useState<'xlsx' | 'csv' | null>(null);
  const [filterOptions, setFilterOptions] = useState<{
    departments: string[];
    personnelTypes: Array<{ code: string; name: string }>;
  }>({ departments: [], personnelTypes: [] });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);

  const [reportData, setReportData] = useState<any>(null);
  const [pushHistoryData, setPushHistoryData] = useState<any>(null);
  const [previewBatch, setPreviewBatch] = useState<any>(null);
  const [inspectPayloadModal, setInspectPayloadModal] = useState<any | null>(null);
  const [showTechnicalError, setShowTechnicalError] = useState(false);

  const [confirmPushOpen, setConfirmPushOpen] = useState(false);
  const [pushingLive, setPushingLive] = useState(false);
  const [pushProgressOpen, setPushProgressOpen] = useState(false);
  const [pushStepLabel, setPushStepLabel] = useState('กำลังเตรียมชุดข้อมูลส่งกลับ HOSOffice...');
  const [pushPercent, setPushPercent] = useState<number | null>(null);
  const [pushStatus, setPushStatus] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
  const [pushSummary, setPushSummary] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

  const [sortColIdx, setSortColIdx] = useState<number | null>(null);
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const [pushPage, setPushPage] = useState(1);
  const [pushPageSize, setPushPageSize] = useState<PageSizeOption>(10);

  function formatPushModeLabel(pushMode?: string): string {
    const m = String(pushMode || '').toUpperCase();
    if (m === 'LIVE' || m === 'LIVE_PUSH' || m === 'DIRECT_PUSH') return 'ส่งข้อมูลจริง (Live)';
    if (m === 'DRY_RUN' || m === 'DRY_RUN_PREVIEW' || m === 'PREVIEW') return 'จำลองตรวจข้อมูล (Dry-Run)';
    return pushMode || '—';
  }

  function formatPushStatusLabel(status?: string): string {
    const s = String(status || '').toUpperCase();
    if (s === 'SUCCESS' || s === 'PUSHED') return 'ส่งสำเร็จ';
    if (s === 'FAILED') return 'ไม่สำเร็จ';
    if (s === 'UNKNOWN') return 'รอตรวจสอบสถานะ';
    if (s === 'PREVIEW' || s === 'PREVIEW_READY' || s === 'DRY_RUN') return 'จำลองแล้ว';
    return status || '—';
  }

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

  useEffect(() => {
    if (userRole === 'GENERAL_USER') {
      setReportType('OWN_ATTENDANCE');
      setDepartmentFilter('');
      setPersonnelType('');
    }
  }, [userRole]);

  useEffect(() => {
    if (mode !== 'reports' || userRole === 'GENERAL_USER') return;
    let cancelled = false;
    apiRequest<{ items?: any[] }>('/personnel')
      .then((res) => {
        if (cancelled) return;
        const list = res.items || [];
        const deptSet = new Set<string>();
        const ptMap = new Map<string, string>();
        for (const p of list) {
          if (p.department_name) deptSet.add(String(p.department_name));
          if (p.personnel_type_code) {
            ptMap.set(
              String(p.personnel_type_code),
              String(p.personnel_type_name || p.personnel_type_code)
            );
          }
        }
        setFilterOptions({
          departments: Array.from(deptSet).sort((a, b) => a.localeCompare(b, 'th')),
          personnelTypes: Array.from(ptMap.entries())
            .map(([code, name]) => ({ code, name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'th')),
        });
      })
      .catch(() => {
        // non-blocking metadata load
      });
    return () => {
      cancelled = true;
    };
  }, [mode, userRole]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === 'reports') {
        const effectiveType = userRole === 'GENERAL_USER' ? 'OWN_ATTENDANCE' : reportType;
        const qs = new URLSearchParams({
          reportType: effectiveType,
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
          ...(userRole !== 'GENERAL_USER' && departmentFilter ? { department: departmentFilter } : {}),
          ...(userRole !== 'GENERAL_USER' && personnelType ? { personnelType } : {}),
        });
        const res = await apiRequest(`/reports/center?${qs.toString()}`);
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
  }, [
    mode,
    userRole,
    reportType,
    effectiveRange.dateFrom,
    effectiveRange.dateTo,
    departmentFilter,
    personnelType,
  ]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (mode !== 'hosofficePush') return;
    let timer: ReturnType<typeof setInterval> | null = null;
    async function checkActivePushJob() {
      try {
        const res = await apiRequest('/jobs/active?type=HOSOFFICE_LIVE_PUSH');
        if (res?.inProgress && res?.activeJob) {
          setPushingLive(true);
          setPushProgressOpen(true);
          setPushStatus('RUNNING');
          setPushStepLabel(res.activeJob.currentStep || 'กำลังส่งข้อมูลกลับ HOSOffice...');
          setPushPercent(
            typeof res.activeJob.progressPercent === 'number' ? res.activeJob.progressPercent : null
          );
        } else if (pushingLive && res?.latestJob && res.latestJob.status !== 'RUNNING') {
          setPushingLive(false);
          setPushPercent(res.latestJob.status === 'SUCCESS' ? 100 : null);
          setPushStatus(res.latestJob.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED');
          setPushStepLabel(res.latestJob.currentStep || 'ดำเนินการเสร็จสิ้น');
          await loadData();
        }
      } catch {
        // ignore
      }
    }
    checkActivePushJob();
    if (pushingLive) {
      timer = setInterval(checkActivePushJob, 1500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [mode, pushingLive, loadData]);

  function handleSortColumn(colIdx: number) {
    if (sortColIdx === colIdx) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortColIdx(colIdx);
      setSortDir('DESC');
    }
    setPage(1);
  }

  async function handleExportReport(format: 'xlsx' | 'csv') {
    setError(null);
    setExportingFormat(format);
    const effectiveType = userRole === 'GENERAL_USER' ? 'OWN_ATTENDANCE' : reportType;
    try {
      if (format === 'xlsx') {
        await downloadReportCenterXlsx({
          reportType: effectiveType,
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
          department: userRole !== 'GENERAL_USER' ? departmentFilter || undefined : undefined,
          personnelType: userRole !== 'GENERAL_USER' ? personnelType || undefined : undefined,
        });
        toast.showSuccess('ส่งออกไฟล์ Excel (.xlsx) เรียบร้อยแล้ว');
      } else {
        await downloadReportCenterCsv({
          reportType: effectiveType,
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
          department: userRole !== 'GENERAL_USER' ? departmentFilter || undefined : undefined,
          personnelType: userRole !== 'GENERAL_USER' ? personnelType || undefined : undefined,
        });
        toast.showSuccess('ส่งออกไฟล์รายงาน CSV เรียบร้อยแล้ว');
      }
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? err.message
          : format === 'xlsx'
            ? 'ไม่สามารถส่งออกไฟล์ Excel (.xlsx) ได้'
            : 'ไม่สามารถส่งออกไฟล์รายงาน CSV ได้';
      setError({ code: err instanceof ApiClientError ? err.code : undefined, message: msg });
      toast.showError('ส่งออกรายงานไม่สำเร็จ', msg);
    } finally {
      setExportingFormat(null);
    }
  }

  async function handlePreviewHosOfficePush() {
    setError(null);
    setShowTechnicalError(false);
    try {
      const res = await apiRequest('/hosoffice/push/preview', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
        }),
      });
      setPreviewBatch(res);
      toast.showSuccess(
        'จำลองชุดข้อมูลส่งกลับ HOSOffice สำเร็จ',
        `พร้อมส่ง ${res.validCount} รายการ · ไม่ผ่านเกณฑ์ ${res.invalidCount} รายการ (ยังไม่เขียนลง HOSOffice)`
      );
      await loadData();
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : 'ไม่สามารถจำลองชุดข้อมูลส่งกลับ HOSOffice ได้';
      setError({ code: err instanceof ApiClientError ? err.code : undefined, message: msg });
      toast.showError('จำลองข้อมูลไม่สำเร็จ', msg);
    }
  }

  async function handleConfirmLiveHosOfficePush() {
    setConfirmPushOpen(false);
    setError(null);
    setShowTechnicalError(false);
    setPushingLive(true);
    setPushProgressOpen(true);
    setPushStatus('RUNNING');
    setPushStepLabel('กำลังตรวจสอบสิทธิ์และส่งข้อมูลสรุปเวลาปฏิบัติงานกลับ HOSOffice...');
    setPushPercent(null);
    setPushSummary(null);
    setPushError(null);

    try {
      const res = await apiRequest('/hosoffice/push', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: effectiveRange.dateFrom,
          dateTo: effectiveRange.dateTo,
          idempotencyKey:
            previewBatch?.idempotencyKey
              ? String(previewBatch.idempotencyKey).replace(/^PREVIEW-/, 'LIVE-')
              : `LIVE-${effectiveRange.dateFrom}-${effectiveRange.dateTo}`,
          ...(previewBatch?.previewId ? { previewId: previewBatch.previewId } : {}),
          ...(previewBatch?.dataHash ? { dataHash: previewBatch.dataHash } : {}),
        }),
      });
      const summaryMsg =
        res.message || `ส่งข้อมูลกลับ HOSOffice สำเร็จ (${res.pushedRecords ?? 0} รายการ)`;
      setPushPercent(100);
      setPushStatus('SUCCESS');
      setPushStepLabel('ส่งข้อมูลกลับ HOSOffice สำเร็จ');
      setPushSummary(summaryMsg);
      toast.showSuccess('ส่งข้อมูลกลับ HOSOffice สำเร็จ', summaryMsg);
      await loadData();
    } catch (err) {
      const errMsg =
        err instanceof ApiClientError
          ? err.message
          : 'ไม่สามารถส่งข้อมูลกลับ HOSOffice ได้';
      setPushPercent(null);
      setPushStatus('FAILED');
      setPushStepLabel('การส่งข้อมูลกลับ HOSOffice ไม่สำเร็จ');
      setPushError(errMsg);
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: errMsg });
      }
      toast.showError('ส่งข้อมูลกลับ HOSOffice ไม่สำเร็จ', errMsg);
      await loadData();
    } finally {
      setPushingLive(false);
    }
  }

  // =========================================================================
  // โหมด 'hosofficePush': ส่งข้อมูลกลับ HOSOffice แบบ 4 ขั้นตอน
  // =========================================================================
  if (mode === 'hosofficePush') {
    const livePushEnabled = Boolean(pushHistoryData?.livePushEnabled);
    const totalPreviewCount = previewBatch
      ? Number(previewBatch.validCount || 0) + Number(previewBatch.invalidCount || 0)
      : 0;

    return (
      <div className="space-y-6">
        <PageHeader
          category="ระบบและผู้ดูแล"
          title="ส่งข้อมูลกลับ HOSOffice"
          subtitle="ตรวจสอบความสมบูรณ์ของข้อมูลด้วยโหมดจำลอง (Dry-Run Preview) ก่อนส่งข้อมูลจริงตามลำดับขั้นตอนอย่างปลอดภัย"
          actions={
            <PageHelpAction
              guideKey="hosofficePush"
              userRole={userRole}
              onNavigate={onNavigate}
            />
          }
        />

        {/* Unified Single-Elevation 4-Step Horizontal Stepper */}
        <div className="his-surface grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 divide-y sm:divide-y-0 sm:divide-x divide-[#E8E4EF] overflow-hidden">
          {[
            { num: '1', title: 'เลือกช่วงข้อมูล', desc: effectiveRange.thaiPeriodLabel, active: true },
            {
              num: '2',
              title: 'ตรวจสอบ Preview',
              desc: previewBatch ? `พร้อมส่ง ${previewBatch.validCount} รายการ` : 'ยังไม่ได้สร้างชุดจำลอง',
              active: Boolean(previewBatch),
            },
            {
              num: '3',
              title: 'ยืนยันส่งจริง',
              desc: livePushEnabled ? 'พร้อมส่งเมื่อตรวจสอบครบ' : 'ล็อกเพื่อความปลอดภัย',
              active: livePushEnabled && Boolean(previewBatch),
            },
            {
              num: '4',
              title: 'ดูผลและประวัติ',
              desc: `${pushHistoryData?.items?.length || 0} รอบล่าสุด`,
              active: (pushHistoryData?.items?.length || 0) > 0,
            },
          ].map((step) => (
            <div
              key={step.num}
              className={`px-4 py-3.5 ${step.active ? 'bg-[#F1ECFA]/50' : 'bg-white'}`}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className={`w-6 h-6 rounded-full font-mono text-[12px] font-bold flex items-center justify-center shrink-0 ${
                    step.active
                      ? 'bg-[#8066B5] text-white'
                      : 'bg-[#F1ECFA] text-[#4E3978]'
                  }`}
                >
                  {step.num}
                </span>
                <span className="text-[13.5px] font-bold text-[#292638]">{step.title}</span>
              </div>
              <div className="text-[12.5px] text-[#777287] mt-1 pl-8.5 truncate">{step.desc}</div>
            </div>
          ))}
        </div>

        {/* Step 1: Select Date Range & Trigger Preview / Live Push */}
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
            <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
              <button
                type="button"
                onClick={handlePreviewHosOfficePush}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                <Eye className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                <span>ขั้นที่ 2: ตรวจสอบชุดข้อมูล (Preview)</span>
              </button>
              <button
                type="button"
                disabled={pushingLive || !livePushEnabled}
                onClick={() => setConfirmPushOpen(true)}
                className="ent-btn-primary w-full sm:w-auto"
                title={
                  livePushEnabled
                    ? 'ยืนยันส่งข้อมูลจริงไปยัง HOSOffice'
                    : 'ระบบปิดการส่งข้อมูลจริงไว้เพื่อความปลอดภัย'
                }
              >
                {livePushEnabled ? (
                  <Send className="w-4 h-4" aria-hidden="true" />
                ) : (
                  <Lock className="w-4 h-4" aria-hidden="true" />
                )}
                <span>
                  {livePushEnabled
                    ? 'ขั้นที่ 3: ส่งข้อมูลจริงไปยัง HOSOffice'
                    : 'ส่งข้อมูลจริง (ล็อกเพื่อความปลอดภัย)'}
                </span>
              </button>
            </div>
          }
        />

        {!loading && !livePushEnabled && (
          <div className="rounded-xl p-4 bg-[#FEF7EA] border border-[#B87516]/25 flex items-start gap-3 text-[13.5px]">
            <Lock className="w-4.5 h-4.5 text-[#B87516] shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5">
              <div className="font-bold text-[#B87516]">
                การส่งข้อมูลจริง (Live Push) ถูกล็อกไว้เพื่อความปลอดภัยของฐานข้อมูล HOSOffice
              </div>
              <p className="text-[#292638] leading-relaxed">
                ท่านยังสามารถกด <strong>“ตรวจสอบชุดข้อมูล (Preview)”</strong> เพื่อตรวจสอบความครบถ้วนของข้อมูลได้ตลอดเวลา
                โดยไม่กระทบฐานข้อมูลปลายทาง หากต้องการเปิดใช้งานส่งจริง โปรดประสานผู้ดูแลระบบส่วนกลาง
              </p>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-[#C74455]/25 bg-[#FDF2F4] p-4 space-y-2 text-[13.5px]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4.5 h-4.5 text-[#C74455] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <div className="font-bold text-[#C74455]">ไม่สามารถดำเนินการส่งข้อมูลได้</div>
                  <div className="text-[#292638] mt-0.5">{error.message}</div>
                </div>
              </div>
              {error.code && (
                <button
                  type="button"
                  onClick={() => setShowTechnicalError((prev) => !prev)}
                  className="text-[12px] font-semibold text-[#C74455] hover:underline inline-flex items-center gap-1 shrink-0 cursor-pointer"
                >
                  <span>รายละเอียดทางเทคนิค</span>
                  {showTechnicalError ? (
                    <ChevronUp className="w-3.5 h-3.5" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
                  )}
                </button>
              )}
            </div>
            {showTechnicalError && error.code && (
              <div className="p-2.5 rounded-lg bg-white border border-[#C74455]/20 font-mono text-[12px] text-[#777287]">
                Error Code: {error.code}
              </div>
            )}
          </div>
        )}

        {previewBatch && (
          <div className="space-y-5">
            <MetricStrip
              columns={3}
              items={[
                {
                  id: 'total-preview',
                  label: 'จำนวนข้อมูลที่ตรวจสอบทั้งหมด',
                  value: totalPreviewCount,
                  unit: 'รายการ',
                  tone: 'default',
                },
                {
                  id: 'valid-preview',
                  label: 'พร้อมส่งกลับ HOSOffice',
                  value: previewBatch.validCount,
                  unit: 'รายการ',
                  tone: 'success',
                  icon: <CheckCircle2 className="w-4 h-4 text-[#198568]" />,
                },
                {
                  id: 'invalid-preview',
                  label: 'ไม่พร้อมส่ง (ต้องตรวจสอบก่อน)',
                  value: previewBatch.invalidCount,
                  unit: 'รายการ',
                  tone: Number(previewBatch.invalidCount) > 0 ? 'danger' : 'default',
                  icon: <AlertTriangle className="w-4 h-4 text-[#C74455]" />,
                },
              ]}
            />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="his-surface overflow-hidden flex flex-col">
                <div className="px-5 py-4 border-b border-[#E8E4EF] flex items-center justify-between gap-3">
                  <SectionHeader
                    title={`รายการที่พร้อมส่ง (${previewBatch.validCount} รายการ)`}
                  />
                  <button
                    type="button"
                    onClick={() => setInspectPayloadModal(previewBatch)}
                    className="ent-btn-secondary h-8 px-3 text-[12.5px] shrink-0"
                  >
                    <FileText className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                    <span>ดู JSON Payload</span>
                  </button>
                </div>
                {!previewBatch.validItems || previewBatch.validItems.length === 0 ? (
                  <div className="p-6 text-center text-[13.5px] text-[#777287]">
                    ไม่มีรายการที่พร้อมส่งในช่วงวันที่ที่เลือก
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-72">
                    <table className="his-table text-[13px]">
                      <thead>
                        <tr>
                          <th>วันที่</th>
                          <th>บุคลากร</th>
                          <th>เข้า–ออก</th>
                          <th className="text-right">สถานะ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(previewBatch.previewItems || previewBatch.validItems).slice(0, 50).map((item: any, idx: number) => (
                          <tr key={item.attendanceId || item.PERSON_ID || item.personId || idx}>
                            <td className="font-mono tabular-nums whitespace-nowrap">
                              {formatThaiDate(item.workDate || item.work_date || item.WORK_DATE)}
                            </td>
                            <td>
                              <div className="font-semibold text-[#292638]">
                                {item.fullName || item.full_name || item.PERSON_ID || item.personId || item.person_id}
                              </div>
                              <div className="text-[11.5px] font-mono text-[#777287]">
                                {item.personId || item.person_id || item.PERSON_ID}
                              </div>
                            </td>
                            <td className="font-mono tabular-nums whitespace-nowrap text-[#777287]">
                              {String(item.checkInTime || item.check_in_time || item.CHECK_IN_DATETIME || '—').slice(11, 16) || '—'} –{' '}
                              {String(item.checkOutTime || item.check_out_time || item.CHECK_OUT_DATETIME || '—').slice(11, 16) || '—'}
                            </td>
                            <td className="text-right whitespace-nowrap">
                              <StatusBadge tone="success" compact>
                                {item.status || item.ATTENDANCE_STATUS || 'พร้อมส่ง'}
                              </StatusBadge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {previewBatch.validItems.length > 50 && (
                      <div className="px-4 py-2 text-[12px] text-[#777287] bg-[#F8F7FC] border-t border-[#E8E4EF]">
                        แสดง 50 รายการแรกจากทั้งหมด {previewBatch.validItems.length} รายการ (กดปุ่ม &ldquo;ดู JSON Payload&rdquo; เพื่อดูทั้งหมด)
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="his-surface overflow-hidden flex flex-col">
                <div className="px-5 py-4 border-b border-[#E8E4EF]">
                  <SectionHeader
                    title={`รายการที่ไม่พร้อมส่งและเหตุผล (${previewBatch.invalidCount} รายการ)`}
                  />
                </div>
                <div className="p-5 flex-1">
                  {previewBatch.invalidItems?.length === 0 ? (
                    <div className="p-4 rounded-xl bg-[#EEF8F4] border border-[#198568]/20 text-[13.5px] text-[#198568] font-medium">
                      ข้อมูลทุกรายการผ่านเกณฑ์ความสมบูรณ์ พร้อมสำหรับการส่งกลับ HOSOffice
                    </div>
                  ) : (
                    <div className="divide-y divide-[#E8E4EF] text-[13.5px] max-h-72 overflow-y-auto -my-2">
                      {previewBatch.invalidItems?.map((inv: any) => (
                        <div key={inv.attendanceId} className="py-3">
                          <div className="font-semibold text-[#292638]">
                            เวร #{inv.attendanceId} · {inv.fullName} ({inv.personId}) —{' '}
                            {formatThaiDate(inv.workDate)}
                          </div>
                          <div className="text-[#C74455] text-[13px] mt-0.5">{inv.reason}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Push History Table */}
        <div className="ent-table-wrapper">
          <div className="px-5 py-4 border-b border-[#E8E4EF] bg-white">
            <SectionHeader title="ขั้นที่ 4: ประวัติการตรวจสอบและส่งข้อมูลกลับ HOSOffice" />
          </div>
          {loading ? (
            <TableLoadingSkeleton rows={4} cols={6} />
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="his-table">
                  <thead>
                    <tr>
                      <th>รหัสอ้างอิงชุดข้อมูล</th>
                      <th>โหมดการทำงาน</th>
                      <th>ช่วงวันที่ข้อมูล</th>
                      <th className="text-right">ทั้งหมด / ผ่าน / ไม่ผ่าน</th>
                      <th>สถานะ</th>
                      <th>ผู้ดำเนินการ · วันเวลา</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!pushHistoryData?.items || pushHistoryData.items.length === 0 ? (
                      <TableEmptyState colSpan={6} title="ยังไม่มีประวัติการสร้างชุดข้อมูลส่งกลับ HOSOffice" />
                    ) : (
                      (pushPageSize === 'ALL'
                        ? pushHistoryData.items
                        : pushHistoryData.items.slice(
                            (pushPage - 1) * pushPageSize,
                            pushPage * pushPageSize
                          )
                      ).map((p: any) => (
                        <tr key={p.id}>
                          <td className="font-mono font-semibold text-[#292638]">{p.idempotency_key}</td>
                          <td className="text-[#292638] font-medium whitespace-nowrap">
                            {formatPushModeLabel(p.push_mode)}
                          </td>
                          <td className="font-mono tabular-nums whitespace-nowrap">
                            {formatThaiDate(p.date_from)} ถึง {formatThaiDate(p.date_to)}
                          </td>
                          <td className="text-right font-mono tabular-nums whitespace-nowrap">
                            {p.total_records} /{' '}
                            <span className="text-[#198568] font-bold">{p.valid_records}</span> /{' '}
                            <span className="text-[#C74455] font-bold">{p.invalid_records}</span>
                          </td>
                          <td>
                            <StatusBadge
                              tone={
                                p.status === 'SUCCESS' || p.status === 'PUSHED'
                                  ? 'success'
                                  : p.status === 'FAILED'
                                    ? 'danger'
                                    : 'brand'
                              }
                              label={formatPushStatusLabel(p.status)}
                              compact
                            />
                          </td>
                          <td className="font-mono tabular-nums text-[#777287] whitespace-nowrap">
                            {p.initiated_by} · {formatThaiDateTime(p.created_at)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <TablePaginationBar
                totalItems={pushHistoryData?.items?.length || 0}
                currentPage={pushPage}
                pageSize={pushPageSize}
                onPageChange={setPushPage}
                onPageSizeChange={setPushPageSize}
              />
            </>
          )}
        </div>

        <SharedModal
          open={Boolean(inspectPayloadModal)}
          onClose={() => setInspectPayloadModal(null)}
          title={`รายละเอียดชุดข้อมูลเตรียมส่ง HOSOffice (${inspectPayloadModal?.idempotencyKey || ''})`}
          maxWidthClass="max-w-3xl"
        >
          {inspectPayloadModal && (
            <div className="space-y-3 text-[14px]">
              <pre className="p-4 bg-[#292638] text-[#F8F7FC] rounded-xl font-mono text-[12.5px] overflow-x-auto max-h-96">
                {JSON.stringify(inspectPayloadModal, null, 2)}
              </pre>
            </div>
          )}
        </SharedModal>

        <ConfirmDialog
          open={confirmPushOpen}
          title="ยืนยันการส่งข้อมูลสรุปเวลาปฏิบัติงานกลับ HOSOffice"
          description={`ช่วงวันที่ ${formatThaiDate(effectiveRange.dateFrom)} ถึง ${formatThaiDate(effectiveRange.dateTo)}`}
          confirmLabel="ยืนยันส่งข้อมูลกลับ HOSOffice"
          loading={pushingLive}
          onConfirm={handleConfirmLiveHosOfficePush}
          onCancel={() => setConfirmPushOpen(false)}
        />

        <ProgressDialog
          open={pushProgressOpen}
          title="ส่งข้อมูลสรุปเวลาปฏิบัติงานกลับ HOSOffice"
          stepLabel={pushStepLabel}
          percent={pushPercent}
          status={pushStatus}
          summaryText={pushSummary}
          errorMessage={pushError}
          onClose={() => setPushProgressOpen(false)}
        />
      </div>
    );
  }

  // =========================================================================
  // โหมด 'reports': ศูนย์รายงานมาตรฐาน 11 ประเภท พร้อมส่งออก Excel (.xlsx) และ CSV
  // =========================================================================
  const availableReportTypes: Array<{ key: string; labelThai: string; adminOnlyOrg: boolean }> =
    reportData?.availableReportTypes || [
      ...(userRole === 'GENERAL_USER'
        ? []
        : [
            { key: 'SUMMARY', labelThai: '1. รายงานสรุปภาพรวมการปฏิบัติงาน', adminOnlyOrg: true },
            { key: 'DAILY_ATTENDANCE', labelThai: '2. รายงานลงเวลารายวันแบบละเอียด', adminOnlyOrg: true },
            { key: 'LATENESS', labelThai: '3. รายงานสถิติและอันดับการมาสาย', adminOnlyOrg: true },
            { key: 'EARLY_CHECKOUT', labelThai: '4. รายงานออกก่อนเวลากะ (Early Checkout)', adminOnlyOrg: true },
            { key: 'MISSING_SCANS', labelThai: '5. รายงานไม่สแกน / ขาดสแกนเข้า-ออก', adminOnlyOrg: true },
            { key: 'IN_PROGRESS_TODAY', labelThai: '6. รายงานผู้ปฏิบัติงานระหว่างกะวันนี้', adminOnlyOrg: true },
            { key: 'HOLIDAY_WORK', labelThai: '7. รายงานการปฏิบัติงานในวันหยุด', adminOnlyOrg: true },
            { key: 'HALF_DAY_LEAVE', labelThai: '8. รายงานการลาครึ่งวัน / ลาบางส่วน', adminOnlyOrg: true },
            { key: 'DEPARTMENT_SUMMARY', labelThai: '9. รายงานสรุปแยกตามกลุ่มงาน/หน่วยงาน', adminOnlyOrg: true },
            { key: 'HR_REVIEW_AUDIT', labelThai: '10. รายงานผลการตรวจสอบโดย HR', adminOnlyOrg: true },
          ]),
      { key: 'OWN_ATTENDANCE', labelThai: '11. รายงานเวลาปฏิบัติงานส่วนบุคคล', adminOnlyOrg: false },
    ];

  const summaryRows: Array<{ metric: string; value: number | string; unit: string }> =
    reportData?.summaryRows || [];
  const headers: string[] = reportData?.headers || [];
  const rawRows: Array<Array<string | number>> = reportData?.rows || [];

  const filteredAndSortedRows = useMemo(() => {
    const q = rankSearch.trim().toLowerCase();
    let list = [...rawRows];
    if (q) {
      list = list.filter((row) =>
        row.some((cell) => String(cell ?? '').toLowerCase().includes(q))
      );
    }
    if (sortColIdx !== null && sortColIdx >= 0 && sortColIdx < headers.length) {
      list.sort((a, b) => {
        const valA = a[sortColIdx];
        const valB = b[sortColIdx];
        const numA = typeof valA === 'number' ? valA : Number.NaN;
        const numB = typeof valB === 'number' ? valB : Number.NaN;
        if (!Number.isNaN(numA) && !Number.isNaN(numB)) {
          return sortDir === 'ASC' ? numA - numB : numB - numA;
        }
        return sortDir === 'ASC'
          ? String(valA ?? '').localeCompare(String(valB ?? ''), 'th')
          : String(valB ?? '').localeCompare(String(valA ?? ''), 'th');
      });
    }
    return list;
  }, [rawRows, rankSearch, sortColIdx, sortDir, headers.length]);

  const numericSize = pageSize === 'ALL' ? Math.max(1, filteredAndSortedRows.length) : pageSize;
  const pagedRows = filteredAndSortedRows.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="ศูนย์รายงานและส่งออก Excel"
        subtitle={
          userRole === 'GENERAL_USER'
            ? 'ดูพรีวิวและดาวน์โหลดรายงานเวลาปฏิบัติงานส่วนบุคคลเป็นไฟล์ Excel (.xlsx) หรือ CSV'
            : 'เลือกรายงานมาตรฐานโรงพยาบาล 11 ประเภท กรองตามงวดวันที่ หน่วยงาน ประเภทบุคลากร ดูพรีวิว และส่งออกไฟล์ Excel (.xlsx) แบบหลายชีตหรือ CSV'
        }
        actions={
          <>
            <PageHelpAction
              guideKey="reports"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={exportingFormat !== null || loading}
              onClick={() => handleExportReport('csv')}
              className="ent-btn-secondary"
            >
              <Download className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>{exportingFormat === 'csv' ? 'กำลังส่งออก CSV...' : 'ส่งออก CSV'}</span>
            </button>
            <button
              type="button"
              disabled={exportingFormat !== null || loading}
              onClick={() => handleExportReport('xlsx')}
              className="ent-btn-primary"
            >
              <FileSpreadsheet className="w-4 h-4" aria-hidden="true" />
              <span>
                {exportingFormat === 'xlsx' ? 'กำลังสร้าง Excel...' : 'ดาวน์โหลด Excel (.xlsx)'}
              </span>
            </button>
          </>
        }
      />

      {/* Report Type Selector Card */}
      <section className="his-surface p-4 sm:p-5 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-[#8066B5]">
              เลือกประเภทรายงานมาตรฐาน
            </div>
            <h2 className="text-[16px] font-bold text-[#292638]">
              {reportData?.titleThai ||
                availableReportTypes.find((t) => t.key === reportType)?.labelThai ||
                'รายงานเวลาปฏิบัติงาน'}
            </h2>
            {reportData?.subtitleThai && (
              <p className="text-[12.5px] text-[#777287] mt-0.5">{reportData.subtitleThai}</p>
            )}
          </div>
          <div className="w-full lg:w-[380px]">
            <label htmlFor="report-type-select" className="sr-only">
              เลือกประเภทรายงาน
            </label>
            <select
              id="report-type-select"
              aria-label="เลือกประเภทรายงาน"
              value={userRole === 'GENERAL_USER' ? 'OWN_ATTENDANCE' : reportType}
              disabled={userRole === 'GENERAL_USER'}
              onChange={(e) => {
                setReportType(e.target.value);
                setSortColIdx(null);
                setPage(1);
              }}
              className="ent-input w-full font-semibold"
            >
              {availableReportTypes.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.labelThai}
                </option>
              ))}
            </select>
          </div>
        </div>

        {userRole !== 'GENERAL_USER' && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 pt-2 border-t border-[#E8E4EF]">
            {availableReportTypes.map((t) => {
              const active = reportType === t.key;
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => {
                    setReportType(t.key);
                    setSortColIdx(null);
                    setPage(1);
                  }}
                  className={`px-3 py-2 rounded-lg border text-left text-[12.5px] font-medium transition-colors cursor-pointer truncate ${
                    active
                      ? 'bg-[#F1ECFA] border-[#8066B5] text-[#4E3978] font-semibold'
                      : 'bg-[#F8F7FC] border-[#E8E4EF] text-[#292638] hover:bg-[#F1ECFA]/60'
                  }`}
                  title={t.labelThai}
                >
                  {t.labelThai}
                </button>
              );
            })}
          </div>
        )}
      </section>

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
          userRole !== 'GENERAL_USER' ? (
            <>
              <select
                aria-label="กรองตามประเภทบุคลากร"
                value={personnelType}
                onChange={(e) => {
                  setPersonnelType(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกประเภทบุคลากร</option>
                {filterOptions.personnelTypes.map((pt) => (
                  <option key={pt.code} value={pt.code}>
                    {pt.name}
                  </option>
                ))}
              </select>

              <select
                aria-label="กรองตามกลุ่มงาน"
                value={departmentFilter}
                onChange={(e) => {
                  setDepartmentFilter(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกกลุ่มงาน / หน่วยงาน</option>
                {filterOptions.departments.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            </>
          ) : undefined
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />

      {/* Summary Strip */}
      {summaryRows.length > 0 && (
        <MetricStrip
          columns={summaryRows.length <= 2 ? 2 : summaryRows.length === 3 ? 3 : 4}
          items={summaryRows.slice(0, 8).map((s, idx) => ({
            id: `summary-${idx}`,
            label: s.metric,
            value: s.value,
            unit: s.unit,
            tone: idx === 0 ? 'brand' : 'default',
            icon:
              idx === 0 ? (
                <Users className="w-4 h-4 text-[#8066B5]" />
              ) : idx === 1 ? (
                <Clock className="w-4 h-4 text-[#8066B5]" />
              ) : (
                <BarChart3 className="w-4 h-4 text-[#8066B5]" />
              ),
          }))}
        />
      )}

      {/* Preview Table */}
      <div className="ent-table-wrapper">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionHeader
            title={`พรีวิวข้อมูลรายงาน (${filteredAndSortedRows.length} รายการ)`}
            subtitle="ไฟล์ Excel (.xlsx) ที่ดาวน์โหลดจะแยกชีตสรุปภาพรวมและชีตรายละเอียดให้ครบถ้วนโดยป้องกันสูตรอันตรายอัตโนมัติ"
          />
          <div className="relative w-full sm:w-64">
            <Search
              className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              aria-label="ค้นหาในพรีวิวรายงาน"
              value={rankSearch}
              onChange={(e) => {
                setRankSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาชื่อ รหัส หรือหน่วยงาน..."
              className="ent-input ent-input-with-icon pr-4 w-full"
            />
          </div>
        </div>

        {loading ? (
          <TableLoadingSkeleton rows={6} cols={Math.max(headers.length, 5)} />
        ) : (
          <div className="overflow-x-auto">
            <table className="his-table">
              <thead>
                <tr>
                  <th className="w-12 text-center">#</th>
                  {headers.map((header, idx) => {
                    const isActive = sortColIdx === idx;
                    return (
                      <th
                        key={`${header}-${idx}`}
                        scope="col"
                        onClick={() => handleSortColumn(idx)}
                        className="cursor-pointer select-none hover:bg-[#F1ECFA]/70 whitespace-nowrap"
                      >
                        <span className={isActive ? 'text-[#4E3978] font-bold' : ''}>
                          {header}
                        </span>
                        {isActive && (
                          <span className="ml-1 text-[#8066B5] font-mono text-[11px]">
                            {sortDir === 'ASC' ? '▲' : '▼'}
                          </span>
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pagedRows.length === 0 ? (
                  <TableEmptyState
                    colSpan={Math.max(headers.length + 1, 2)}
                    title="ไม่พบข้อมูลรายงานตามตัวกรองและช่วงวันที่ที่เลือก"
                  />
                ) : (
                  pagedRows.map((row, rIdx) => (
                    <tr key={`row-${(page - 1) * numericSize + rIdx}`}>
                      <td className="text-center font-mono tabular-nums text-[#777287] text-[12.5px]">
                        {(page - 1) * numericSize + rIdx + 1}
                      </td>
                      {row.map((cell, cIdx) => {
                        const isNum = typeof cell === 'number';
                        const str = String(cell ?? '—');
                        const isTimestampLike = /^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(str);
                        return (
                          <td
                            key={`cell-${rIdx}-${cIdx}`}
                            className={
                              isNum
                                ? 'font-mono tabular-nums font-semibold text-[#292638] whitespace-nowrap'
                                : isTimestampLike
                                  ? 'font-mono tabular-nums text-[#292638] whitespace-nowrap'
                                  : 'text-[#292638]'
                            }
                          >
                            {str || '—'}
                          </td>
                        );
                      })}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        <TablePaginationBar
          currentPage={page}
          pageSize={pageSize}
          totalItems={filteredAndSortedRows.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
}
