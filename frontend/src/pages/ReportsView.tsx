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
} from 'lucide-react';
import { apiRequest, downloadLatenessCsv, ApiClientError, type UserRole } from '../services/api.ts';
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

  const [sortKey, setSortKey] = useState('totalLateMinutes');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const [pushPage, setPushPage] = useState(1);
  const [pushPageSize, setPushPageSize] = useState<PageSizeOption>(10);

  function formatPushModeLabel(pushMode?: string): string {
    const m = String(pushMode || '').toUpperCase();
    if (m === 'LIVE' || m === 'DIRECT_PUSH') return 'ส่งข้อมูลจริง (Live)';
    if (m === 'DRY_RUN' || m === 'PREVIEW') return 'จำลองตรวจข้อมูล (Dry-Run)';
    return pushMode || '—';
  }

  function formatPushStatusLabel(status?: string): string {
    const s = String(status || '').toUpperCase();
    if (s === 'SUCCESS' || s === 'PUSHED') return 'ส่งสำเร็จ';
    if (s === 'FAILED') return 'ไม่สำเร็จ';
    if (s === 'PREVIEW' || s === 'DRY_RUN') return 'จำลองแล้ว';
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
      toast.showSuccess('ส่งออกไฟล์รายงาน CSV เรียบร้อยแล้ว');
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? err.message : 'ไม่สามารถส่งออกไฟล์รายงาน CSV ได้';
      setError({ code: err instanceof ApiClientError ? err.code : undefined, message: msg });
      toast.showError('ส่งออกรายงานไม่สำเร็จ', msg);
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
            previewBatch?.idempotencyKey ||
            `LIVE-${effectiveRange.dateFrom}-${effectiveRange.dateTo}`,
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
                        {previewBatch.validItems.slice(0, 50).map((item: any, idx: number) => (
                          <tr key={item.attendanceId || item.personId || idx}>
                            <td className="font-mono tabular-nums whitespace-nowrap">
                              {formatThaiDate(item.workDate || item.work_date)}
                            </td>
                            <td>
                              <div className="font-semibold text-[#292638]">
                                {item.fullName || item.full_name || item.personId || item.person_id}
                              </div>
                              <div className="text-[11.5px] font-mono text-[#777287]">
                                {item.personId || item.person_id}
                              </div>
                            </td>
                            <td className="font-mono tabular-nums whitespace-nowrap text-[#777287]">
                              {String(item.checkInTime || item.check_in_time || '—').slice(11, 16) || '—'} –{' '}
                              {String(item.checkOutTime || item.check_out_time || '—').slice(11, 16) || '—'}
                            </td>
                            <td className="text-right whitespace-nowrap">
                              <StatusBadge tone="success" compact>
                                {item.status || 'พร้อมส่ง'}
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
  // โหมด 'reports': รายงานและสถิติการมาสายประจำงวด
  // =========================================================================
  const kpi = reportData?.kpi;
  const rawRanking: any[] = reportData?.ranking || [];
  const deptBreakdown: any[] = reportData?.departmentBreakdown || [];

  const availableDepartments = useMemo(() => {
    const set = new Set<string>();
    rawRanking.forEach((r) => {
      if (r.departmentName) set.add(String(r.departmentName));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, 'th'));
  }, [rawRanking]);

  const filteredAndSortedRanking = useMemo(() => {
    const q = rankSearch.trim().toLowerCase();
    let list = [...rawRanking];
    if (departmentFilter) {
      list = list.filter((r) => String(r.departmentName || '') === departmentFilter);
    }
    if (q) {
      list = list.filter(
        (r) =>
          String(r.fullName || '').toLowerCase().includes(q) ||
          String(r.personId || '').toLowerCase().includes(q) ||
          String(r.departmentName || '').toLowerCase().includes(q)
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
  }, [rawRanking, departmentFilter, rankSearch, sortKey, sortDir]);

  const numericSize = pageSize === 'ALL' ? Math.max(1, filteredAndSortedRanking.length) : pageSize;
  const pagedRanking = filteredAndSortedRanking.slice((page - 1) * numericSize, page * numericSize);

  const maxDeptLateMins = Math.max(
    1,
    ...deptBreakdown.map((d: any) => Number(d.totalLateMinutes || 0))
  );

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="รายงานและสถิติการมาสาย"
        subtitle="สรุปสถิติการมาสายแยกตามจำนวนคนไม่ซ้ำและจำนวนครั้งที่มาสาย พร้อมเปรียบเทียบตามกลุ่มงานและส่งออกไฟล์ CSV สำหรับงานบริหารบุคคล"
        actions={
          <>
            <PageHelpAction
              guideKey="reports"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              onClick={handleExportCsv}
              className="ent-btn-primary"
            >
              <Download className="w-4 h-4" aria-hidden="true" />
              <span>ส่งออกรายงาน CSV</span>
            </button>
          </>
        }
      />

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
              <option value="CIVIL_SERVANT">ข้าราชการ</option>
              <option value="GOV_EMPLOYEE">พนักงานราชการ</option>
              <option value="PUBLIC_HEALTH_EMP">พนักงานกระทรวงสาธารณสุข (พกส.)</option>
              <option value="PERMANENT_EMP">ลูกจ้างประจำ</option>
              <option value="TEMP_EMPLOYEE">ลูกจ้างชั่วคราว</option>
            </select>

            {availableDepartments.length > 0 && (
              <select
                aria-label="กรองตามกลุ่มงาน"
                value={departmentFilter}
                onChange={(e) => {
                  setDepartmentFilter(e.target.value);
                  setPage(1);
                }}
                className="ent-input w-full sm:w-auto"
              >
                <option value="">ทุกกลุ่มงาน</option>
                {availableDepartments.map((dept) => (
                  <option key={dept} value={dept}>
                    {dept}
                  </option>
                ))}
              </select>
            )}
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />

      {/* Unified Single-Elevation KPI Strip + Explicit Calculation Formula */}
      {kpi && (
        <div className="space-y-2.5">
          <MetricStrip
            columns={4}
            items={[
              {
                id: 'late-people',
                label: 'จำนวนคนที่มาสาย (ไม่ซ้ำคน)',
                value: kpi.latePeople,
                unit: 'คน',
                sublabel: `เฉลี่ย ${kpi.avgLateMinutesPerLatePerson} นาที/คน`,
                tone: 'warning',
                icon: <Users className="w-4 h-4 text-[#B87516]" />,
              },
              {
                id: 'late-occ',
                label: 'จำนวนครั้งที่มาสายรวม',
                value: kpi.lateOccurrences,
                unit: 'ครั้ง',
                sublabel: `จากเวรปฏิบัติงานทั้งหมด ${kpi.totalShifts} เวร`,
                tone: 'default',
                icon: <Clock className="w-4 h-4 text-[#8066B5]" />,
              },
              {
                id: 'late-mins',
                label: 'นาทีสายสะสมรวม',
                value: kpi.totalLateMinutes,
                unit: 'นาที',
                sublabel: 'นับหลังหักเวลาผ่อนผันของแต่ละกะ',
                tone: 'default',
                icon: <BarChart3 className="w-4 h-4 text-[#8066B5]" />,
              },
              {
                id: 'late-avg',
                label: 'ค่าเฉลี่ยนาทีสายต่อครั้ง',
                value: kpi.avgLateMinutesPerOccurrence,
                unit: 'นาที/ครั้ง',
                sublabel: 'นาทีสายรวม ÷ จำนวนครั้งที่สาย',
                tone: 'brand',
              },
            ]}
          />
          <div className="flex items-start sm:items-center gap-2 px-3.5 py-2 rounded-lg bg-[#F1ECFA]/60 border border-[#E8E4EF] text-[12.5px] text-[#4E3978]">
            <Info className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
            <span>
              <strong>วิธีคำนวณค่าเฉลี่ย:</strong> เฉลี่ยต่อครั้ง = นาทีสายรวม ({kpi.totalLateMinutes}) ÷ จำนวนครั้งที่มาสาย ({kpi.lateOccurrences}) · เฉลี่ยต่อคน = นาทีสายรวม ({kpi.totalLateMinutes}) ÷ จำนวนคนที่มาสายไม่ซ้ำคน ({kpi.latePeople})
            </span>
          </div>
        </div>
      )}

      {deptBreakdown.length > 0 && (
        <section className="his-surface p-5 sm:p-6 space-y-4">
          <SectionHeader
            title="เปรียบเทียบสถิติการมาสายแยกตามกลุ่มงาน / หน่วยงาน"
            subtitle="แสดงนาทีสายสะสมเทียบกับจำนวนคนที่สายไม่ซ้ำและจำนวนครั้งที่สายในแต่ละหน่วยงาน"
          />
          <div className="space-y-3.5 pt-1">
            {deptBreakdown.map((d: any) => {
              const barPct = Math.round((Number(d.totalLateMinutes || 0) / maxDeptLateMins) * 100);
              return (
                <div key={d.departmentName} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px]">
                    <span className="font-semibold text-[#292638]">{d.departmentName}</span>
                    <div className="flex flex-wrap items-center gap-3 sm:gap-4 font-mono text-[13px] tabular-nums">
                      <span className="text-[#777287]">เวรรวม {d.totalShifts} เวร</span>
                      <span className="text-[#B87516] font-semibold">
                        สาย {d.latePeople} คน ({d.lateOccurrences} ครั้ง)
                      </span>
                      <span className="font-bold text-[#4E3978]">
                        รวม {d.totalLateMinutes} นาที
                      </span>
                    </div>
                  </div>
                  <div className="h-2.5 w-full bg-[#F1ECFA] rounded-full overflow-hidden">
                    <div
                      style={{ width: `${Math.max(d.totalLateMinutes > 0 ? 4 : 0, barPct)}%` }}
                      className="h-full bg-[#8066B5] rounded-full transition-all"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <div className="ent-table-wrapper">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-white flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <SectionHeader
            title={`ตารางจัดอันดับสถิติการมาสายรายบุคคล (${filteredAndSortedRanking.length} คน)`}
          />
          <div className="relative w-full sm:w-64">
            <Search
              className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              aria-label="ค้นหาชื่อบุคลากรในรายงาน"
              value={rankSearch}
              onChange={(e) => {
                setRankSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาชื่อ หรือ รหัสบุคลากร..."
              className="ent-input ent-input-with-icon pr-4 w-full"
            />
          </div>
        </div>

        {loading ? (
          <TableLoadingSkeleton rows={6} cols={6} />
        ) : (
          <>
            <div className="md:hidden divide-y divide-[#E8E4EF]">
              {pagedRanking.length === 0 ? (
                <div className="py-10 px-4 text-center text-[14px] text-[#777287]">
                  ไม่พบข้อมูลการจัดอันดับในช่วงเวลาที่เลือก
                </div>
              ) : (
                pagedRanking.map((r: any, idx: number) => (
                  <div key={r.personId} className="p-4 space-y-2 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-[14.5px] text-[#292638]">
                          #{(page - 1) * numericSize + idx + 1} · {r.fullName}
                        </div>
                        <div className="text-[12.5px] text-[#777287]">
                          {r.departmentName} · {r.personnelTypeName}
                        </div>
                      </div>
                      <StatusBadge tone="warning" label={`รวม ${r.totalLateMinutes} น.`} compact />
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] font-mono tabular-nums">
                      <span className="text-[#777287]">เวร {r.totalShifts}</span>
                      <span className="text-[#B87516] font-semibold">สาย {r.lateOccurrences} ครั้ง</span>
                      <span className="text-[#C74455] font-semibold">
                        ขาด/ลืมออก {r.noScanCount}/{r.missingCheckoutCount}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>อันดับ</th>
                    <SortableHeader
                      label="ชื่อ-นามสกุล · รหัสบุคลากร"
                      sortKey="fullName"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="กลุ่มงาน · ประเภทบุคลากร"
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
                      label="นาทีสายสะสม"
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
                      label="ขาดสแกน / ไม่สแกนออก"
                      sortKey="noScanCount"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                      align="right"
                    />
                  </tr>
                </thead>
                <tbody>
                  {pagedRanking.length === 0 ? (
                    <TableEmptyState colSpan={8} title="ไม่พบข้อมูลการจัดอันดับในช่วงเวลาที่เลือก" />
                  ) : (
                    pagedRanking.map((r: any, idx: number) => (
                      <tr key={r.personId}>
                        <td className="font-mono tabular-nums font-semibold text-[#777287]">
                          #{(page - 1) * numericSize + idx + 1}
                        </td>
                        <td>
                          <div className="font-semibold text-[14px] text-[#292638]">{r.fullName}</div>
                          <div className="text-[12px] font-mono text-[#777287] mt-0.5">
                            รหัสบุคลากร: {r.personId}
                          </div>
                        </td>
                        <td>
                          <div className="font-medium text-[#292638]">{r.departmentName}</div>
                          <div className="text-[12px] text-[#777287] mt-0.5">{r.personnelTypeName}</div>
                        </td>
                        <td className="text-right font-mono tabular-nums">{r.totalShifts}</td>
                        <td className="text-right font-mono tabular-nums font-semibold text-[#B87516]">
                          {r.lateOccurrences} ครั้ง
                        </td>
                        <td className="text-right font-mono tabular-nums font-bold">
                          {r.totalLateMinutes} นาที
                        </td>
                        <td className="text-right font-mono tabular-nums text-[#777287]">
                          {r.avgLateMinutesPerOccurrence}
                        </td>
                        <td className="text-right font-mono tabular-nums text-[#C74455] font-semibold">
                          {r.noScanCount} / {r.missingCheckoutCount}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        <TablePaginationBar
          currentPage={page}
          pageSize={pageSize}
          totalItems={filteredAndSortedRanking.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>
    </div>
  );
}
