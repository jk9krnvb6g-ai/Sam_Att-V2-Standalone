/**
 * ============================================================================
 * ไฟล์: frontend/src/pages/ReportsView.tsx
 * หน้าที่: หน้าจอรายงานสถิติการมาสาย (Lateness Report) และการส่งข้อมูลเข้า HOSOffice (Direct Push)
 * ============================================================================
 * ประกอบด้วย 2 คอมโพเนนต์หลัก:
 * 1. ReportsView (mode === 'reports'):
 *    - รายงานสรุปสถิติการมาสายของบุคลากรโรงพยาบาลสามชุก รองรับทุกประเภทบุคลากร กลุ่มงาน ค้นหา และสลับลำดับ
 *    - ส่งออกไฟล์ CSV (Export CSV) ที่เปิดอ่านภาษาไทยใน Excel ได้ทันที (UTF-8 BOM)
 * 2. PushView (mode === 'hosofficePush'):
 *    - หน้าจอส่งข้อมูลสรุปเวลาปฏิบัติงานเข้าสู่ระบบ HOSOffice โดยตรงแบบ 4 ขั้นตอน
 *    - มี ConfirmDialog, ProgressDialog, การปิดปุ่มส่งจริงเมื่อถูกล็อกเพื่อความปลอดภัย และการกู้คืนสถานะงาน
 * ============================================================================
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Download,
  Eye,
  Send,
  FileText,
  Search,
  ArrowUpDown,
  Lock,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { apiRequest, downloadLatenessCsv, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  PeriodFilterBar,
  SortableHeader,
  TablePaginationBar,
  SharedModal,
  NotificationBanner,
  TableEmptyState,
  TableLoadingSkeleton,
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
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
  const [notice, setNotice] = useState<string | null>(null);

  const [reportData, setReportData] = useState<any>(null);
  const [pushHistoryData, setPushHistoryData] = useState<any>(null);
  const [previewBatch, setPreviewBatch] = useState<any>(null);
  const [inspectPayloadModal, setInspectPayloadModal] = useState<any | null>(null);
  const [showTechnicalError, setShowTechnicalError] = useState(false);

  // HOSOffice Push Confirm & Progress Dialog state
  const [confirmPushOpen, setConfirmPushOpen] = useState(false);
  const [pushingLive, setPushingLive] = useState(false);
  const [pushProgressOpen, setPushProgressOpen] = useState(false);
  const [pushStepLabel, setPushStepLabel] = useState('กำลังเตรียมชุดข้อมูลส่งกลับ HOSOffice...');
  const [pushPercent, setPushPercent] = useState<number | null>(null);
  const [pushStatus, setPushStatus] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
  const [pushSummary, setPushSummary] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);

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

  // กู้คืนสถานะงานส่งข้อมูลกลับ HOSOffice หากรีเฟรชหน้าจอ
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
      setNotice('ดาวน์โหลดไฟล์รายงาน CSV เรียบร้อยแล้ว');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handlePreviewHosOfficePush() {
    setError(null);
    setNotice(null);
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
      setNotice(
        `จำลองการเตรียมข้อมูลส่งกลับ HOSOffice สำเร็จ: พร้อมส่ง ${res.validCount} รายการ · ไม่ผ่านเกณฑ์ ${res.invalidCount} รายการ (ยังไม่มีการเขียนลงฐานข้อมูล HOSOffice)`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleConfirmLiveHosOfficePush() {
    setConfirmPushOpen(false);
    setError(null);
    setNotice(null);
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
      setNotice(summaryMsg);
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

        {/* Guided 4-Step Progress Bar */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { num: '1', title: 'เลือกช่วงข้อมูล', desc: effectiveRange.thaiPeriodLabel, active: true },
            { num: '2', title: 'ตรวจสอบ Preview', desc: previewBatch ? `พร้อมส่ง ${previewBatch.validCount} รายการ` : 'ยังไม่ได้สร้างชุดจำลอง', active: Boolean(previewBatch) },
            { num: '3', title: 'ยืนยันส่งจริง', desc: livePushEnabled ? 'พร้อมส่งเมื่อตรวจสอบครบ' : 'ล็อกเพื่อความปลอดภัย', active: livePushEnabled && Boolean(previewBatch) },
            { num: '4', title: 'ดูผลและประวัติ', desc: `${pushHistoryData?.items?.length || 0} รอบล่าสุด`, active: (pushHistoryData?.items?.length || 0) > 0 },
          ].map((step) => (
            <div
              key={step.num}
              className={`p-3.5 rounded-xl border ${
                step.active ? 'bg-[#F2EDFA]/70 border-[#E6DFF0]' : 'bg-white border-[#E6DFF0]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-full bg-[#8E70C9] text-white font-mono text-[12px] font-bold flex items-center justify-center shrink-0">
                  {step.num}
                </span>
                <span className="text-[13.5px] font-bold text-[#262238]">{step.title}</span>
              </div>
              <div className="text-[12px] text-[#746B83] mt-1 pl-8 truncate">{step.desc}</div>
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
            <div className="flex flex-wrap items-center gap-2.5 w-full sm:w-auto">
              <button
                type="button"
                onClick={handlePreviewHosOfficePush}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                <Eye className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
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

        {/* Friendly Lock Explanation Banner when Live Push is disabled */}
        {!loading && !livePushEnabled && (
          <div className="ent-card p-4 bg-[#FEF8ED] border-[#F3DFBC] flex items-start gap-3 text-[13.5px]">
            <Lock className="w-4.5 h-4.5 text-[#B87516] shrink-0 mt-0.5" aria-hidden="true" />
            <div className="space-y-0.5">
              <div className="font-bold text-[#B87516]">
                การส่งข้อมูลจริง (Live Push) ถูกล็อกไว้เพื่อความปลอดภัยของฐานข้อมูล HOSOffice
              </div>
              <p className="text-[#262238] leading-relaxed">
                ท่านยังสามารถกด <strong>“ตรวจสอบชุดข้อมูล (Preview)”</strong> เพื่อตรวจสอบความครบถ้วนของข้อมูลได้ตลอดเวลา โดยไม่กระทบฐานข้อมูลปลายทาง หากต้องการเปิดใช้งานส่งจริง โปรดประสานผู้ดูแลระบบส่วนกลาง
              </p>
            </div>
          </div>
        )}

        {/* Friendly Error Banner + Expandable Technical Detail */}
        {error && (
          <div className="rounded-xl border border-[#F3CCD0] bg-[#FDF2F3] p-4 space-y-2 text-[13.5px]">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-4.5 h-4.5 text-[#C74455] shrink-0 mt-0.5" aria-hidden="true" />
                <div>
                  <div className="font-bold text-[#C74455]">ไม่สามารถดำเนินการส่งข้อมูลได้</div>
                  <div className="text-[#262238] mt-0.5">{error.message}</div>
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
              <div className="p-2.5 rounded-lg bg-white border border-[#F3CCD0] font-mono text-[12px] text-[#746B83]">
                Error Code: {error.code}
              </div>
            )}
          </div>
        )}

        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        {/* Step 2 Results: Summary Counts + Valid / Invalid Lists */}
        {previewBatch && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="ent-card p-4">
                <div className="text-[12.5px] font-medium text-[#746B83]">จำนวนข้อมูลที่ตรวจสอบทั้งหมด</div>
                <div className="mt-1 text-[24px] font-bold text-[#262238] tabular-nums">
                  {totalPreviewCount} รายการ
                </div>
              </div>
              <div className="ent-card p-4">
                <div className="text-[12.5px] font-medium text-[#746B83]">พร้อมส่งกลับ HOSOffice</div>
                <div className="mt-1 text-[24px] font-bold text-[#198568] tabular-nums flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                  <span>{previewBatch.validCount} รายการ</span>
                </div>
              </div>
              <div className="ent-card p-4">
                <div className="text-[12.5px] font-medium text-[#746B83]">ไม่พร้อมส่ง (ต้องตรวจสอบก่อน)</div>
                <div className="mt-1 text-[24px] font-bold text-[#C74455] tabular-nums flex items-center gap-2">
                  <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                  <span>{previewBatch.invalidCount} รายการ</span>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              <div className="ent-card p-5 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-[16.5px] font-bold text-[#262238]">
                    รายการที่พร้อมส่ง ({previewBatch.validCount} รายการ)
                  </h2>
                  <button
                    type="button"
                    onClick={() => setInspectPayloadModal(previewBatch)}
                    className="text-[13px] font-semibold text-[#543B7A] hover:text-[#795BB8] hover:underline inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <FileText className="w-4 h-4" aria-hidden="true" />
                    <span>ดูโครงสร้าง Payload เต็มจอ</span>
                  </button>
                </div>
                <pre className="p-4 bg-[#262238] text-[#F8F7FC] rounded-xl text-[12.5px] font-mono overflow-x-auto max-h-72">
                  {JSON.stringify(previewBatch.validItems, null, 2)}
                </pre>
              </div>

              <div className="ent-card p-5 space-y-3">
                <h2 className="text-[16.5px] font-bold text-[#C74455]">
                  รายการที่ไม่พร้อมส่งและเหตุผล ({previewBatch.invalidCount} รายการ)
                </h2>
                {previewBatch.invalidItems?.length === 0 ? (
                  <div className="p-6 rounded-xl bg-[#EDF8F4] border border-[#C2E6DA] text-[13.5px] text-[#198568] font-medium">
                    ข้อมูลทุกรายการผ่านเกณฑ์ความสมบูรณ์ พร้อมสำหรับการส่งกลับ HOSOffice
                  </div>
                ) : (
                  <div className="divide-y divide-[#E6DFF0] text-[13.5px] max-h-72 overflow-y-auto">
                    {previewBatch.invalidItems?.map((inv: any) => (
                      <div key={inv.attendanceId} className="py-3">
                        <div className="font-semibold text-[#262238]">
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
        )}

        {/* Step 4: Push History Table */}
        <div className="ent-table-wrapper">
          <div className="px-5 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC]">
            <h2 className="text-[17px] font-bold text-[#262238]">
              ขั้นที่ 4: ประวัติการตรวจสอบและส่งข้อมูลกลับ HOSOffice
            </h2>
          </div>
          {loading ? (
            <TableLoadingSkeleton rows={4} cols={6} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                    <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสอ้างอิงชุดข้อมูล</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">โหมดการทำงาน</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">ช่วงวันที่ข้อมูล</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px] text-right">ทั้งหมด / ผ่าน / ไม่ผ่าน</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">สถานะ</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">ผู้ดำเนินการ · วันเวลา</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6DFF0]">
                  {!pushHistoryData?.items || pushHistoryData.items.length === 0 ? (
                    <TableEmptyState colSpan={6} title="ยังไม่มีประวัติการสร้างชุดข้อมูลส่งกลับ HOSOffice" />
                  ) : (
                    pushHistoryData.items.map((p: any) => (
                      <tr key={p.id} className="hover:bg-[#F8F7FC]">
                        <td className="py-3.5 px-5 font-mono font-semibold text-[#262238]">
                          {p.idempotency_key}
                        </td>
                        <td className="py-3.5 px-5 font-mono text-[#746B83]">{p.push_mode}</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-[#262238]">
                          {formatThaiDate(p.date_from)} ถึง {formatThaiDate(p.date_to)}
                        </td>
                        <td className="py-3.5 px-5 text-right font-mono tabular-nums">
                          {p.total_records} / <span className="text-[#198568] font-bold">{p.valid_records}</span> /{' '}
                          <span className="text-[#C74455] font-bold">{p.invalid_records}</span>
                        </td>
                        <td className="py-3.5 px-5 font-semibold text-[#543B7A]">{p.status}</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums text-[#746B83]">
                          {p.initiated_by} · {formatThaiDateTime(p.created_at)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
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
              <pre className="p-4 bg-[#262238] text-[#F8F7FC] rounded-xl font-mono text-[12.5px] overflow-x-auto max-h-96">
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

            <button
              type="button"
              onClick={() => setSortDir((d) => (d === 'DESC' ? 'ASC' : 'DESC'))}
              className="ent-btn-secondary w-full sm:w-auto"
              title="สลับลำดับการจัดเรียง"
            >
              <ArrowUpDown className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
              <span>{sortDir === 'DESC' ? 'เรียง: มาก → น้อย' : 'เรียง: น้อย → มาก'}</span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {kpi && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <div className="ent-card p-5">
            <div className="text-[13px] font-semibold text-[#746B83]">
              จำนวนบุคลากรที่มาสาย (ไม่ซ้ำคน)
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#B87516] tabular-nums">
              {kpi.latePeople} คน
            </div>
            <div className="text-[12.5px] text-[#746B83] mt-1 tabular-nums">
              เฉลี่ย {kpi.avgLateMinutesPerLatePerson} นาที/คน
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13px] font-semibold text-[#746B83]">
              จำนวนครั้งที่มาสายรวมทั้งหมด
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#262238] tabular-nums">
              {kpi.lateOccurrences} ครั้ง
            </div>
            <div className="text-[12.5px] text-[#746B83] mt-1 tabular-nums">
              จากเวรปฏิบัติงานทั้งหมด {kpi.totalShifts} เวร
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13px] font-semibold text-[#746B83]">
              นาทีสายสะสมรวมทั้งองค์กร
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#262238] tabular-nums">
              {kpi.totalLateMinutes} นาที
            </div>
            <div className="text-[12.5px] text-[#746B83] mt-1">
              คำนวณหลังหักเวลาผ่อนผันตามกะแล้ว
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13px] font-semibold text-[#746B83]">
              ค่าเฉลี่ยนาทีสายต่อครั้ง
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#543B7A] tabular-nums">
              {kpi.avgLateMinutesPerOccurrence} นาที/ครั้ง
            </div>
            <div className="text-[12.5px] text-[#746B83] mt-1">
              นาทีสายรวม ÷ จำนวนครั้งที่สาย
            </div>
          </div>
        </div>
      )}

      {deptBreakdown.length > 0 && (
        <div className="ent-card p-5 sm:p-6 space-y-4">
          <div>
            <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
              แผนภูมิเปรียบเทียบสถิติการมาสายแยกตามกลุ่มงาน / หน่วยงาน
            </h2>
            <p className="text-[13px] text-[#746B83]">
              แสดงนาทีสายสะสมเทียบกับจำนวนคนที่สายไม่ซ้ำและจำนวนครั้งที่สายในแต่ละหน่วยงาน
            </p>
          </div>
          <div className="space-y-3.5">
            {deptBreakdown.map((d: any) => {
              const barPct = Math.round((Number(d.totalLateMinutes || 0) / maxDeptLateMins) * 100);
              return (
                <div key={d.departmentName} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px]">
                    <span className="font-semibold text-[#262238]">{d.departmentName}</span>
                    <div className="flex flex-wrap items-center gap-3 sm:gap-4 font-mono text-[13px] tabular-nums">
                      <span className="text-[#746B83]">เวรรวม {d.totalShifts} เวร</span>
                      <span className="text-[#B87516] font-semibold">
                        สาย {d.latePeople} คน ({d.lateOccurrences} ครั้ง)
                      </span>
                      <span className="font-bold text-[#543B7A]">
                        รวม {d.totalLateMinutes} นาที
                      </span>
                    </div>
                  </div>
                  <div className="h-3 w-full bg-[#F2EDFA] rounded-full overflow-hidden border border-[#E6DFF0]">
                    <div
                      style={{ width: `${Math.max(d.totalLateMinutes > 0 ? 5 : 0, barPct)}%` }}
                      className="h-full bg-[#8E70C9] rounded-full transition-all"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="ent-table-wrapper">
        <div className="px-4 sm:px-6 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <h2 className="text-[17px] sm:text-[18px] font-bold text-[#262238]">
            ตารางจัดอันดับสถิติการมาสายรายบุคคล ({filteredAndSortedRanking.length} คน)
          </h2>
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#746B83] absolute left-3.5 top-3" aria-hidden="true" />
            <input
              type="text"
              aria-label="ค้นหาชื่อบุคลากรในรายงาน"
              value={rankSearch}
              onChange={(e) => {
                setRankSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาชื่อ หรือ รหัสบุคลากร..."
              className="ent-input pl-10 pr-4 w-full"
            />
          </div>
        </div>

        {loading ? (
          <TableLoadingSkeleton rows={6} cols={6} />
        ) : (
          <>
            <div className="md:hidden divide-y divide-[#E6DFF0]">
              {pagedRanking.length === 0 ? (
                <div className="py-10 px-4 text-center text-[14px] text-[#746B83]">
                  ไม่พบข้อมูลการจัดอันดับในช่วงเวลาที่เลือก
                </div>
              ) : (
                pagedRanking.map((r: any, idx: number) => (
                  <div key={r.personId} className="p-4 space-y-2.5 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-bold text-[15px] text-[#262238]">
                          #{(page - 1) * numericSize + idx + 1} · {r.fullName}
                        </div>
                        <div className="text-[12.5px] text-[#746B83]">
                          {r.departmentName} · {r.personnelTypeName}
                        </div>
                      </div>
                      <span className="font-mono font-bold text-[13.5px] text-[#B87516] bg-[#FEF8ED] px-2.5 py-0.5 rounded-md border border-[#F3DFBC] tabular-nums shrink-0">
                        รวม {r.totalLateMinutes} น.
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 pt-1 text-center font-mono text-[12.5px]">
                      <div className="p-2 rounded-lg bg-[#F8F7FC] border border-[#E6DFF0]">
                        <div className="text-[11px] text-[#746B83] font-sans">เวรทั้งหมด</div>
                        <div className="font-bold text-[#262238] tabular-nums">{r.totalShifts}</div>
                      </div>
                      <div className="p-2 rounded-lg bg-[#FEF8ED] border border-[#F3DFBC]">
                        <div className="text-[11px] text-[#B87516] font-sans">สาย (ครั้ง)</div>
                        <div className="font-bold text-[#B87516] tabular-nums">{r.lateOccurrences} ครั้ง</div>
                      </div>
                      <div className="p-2 rounded-lg bg-[#FDF2F3] border border-[#F3CCD0]">
                        <div className="text-[11px] text-[#C74455] font-sans">ขาด/ลืมออก</div>
                        <div className="font-bold text-[#C74455] tabular-nums">
                          {r.noScanCount}/{r.missingCheckoutCount}
                        </div>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                    <th className="py-3.5 px-4 font-semibold text-[13px]">อันดับ</th>
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
                <tbody className="divide-y divide-[#E6DFF0]">
                  {pagedRanking.length === 0 ? (
                    <TableEmptyState colSpan={8} title="ไม่พบข้อมูลการจัดอันดับในช่วงเวลาที่เลือก" />
                  ) : (
                    pagedRanking.map((r: any, idx: number) => (
                      <tr key={r.personId} className="hover:bg-[#F8F7FC] transition-colors">
                        <td className="py-3.5 px-4 font-mono tabular-nums font-semibold text-[#746B83]">
                          #{(page - 1) * numericSize + idx + 1}
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-semibold text-[14.5px] text-[#262238]">{r.fullName}</div>
                          <div className="text-[12px] font-mono text-[#746B83] mt-0.5">
                            รหัสบุคลากร: {r.personId}
                          </div>
                        </td>
                        <td className="py-3.5 px-4">
                          <div className="font-medium text-[#262238]">{r.departmentName}</div>
                          <div className="text-[12px] text-[#746B83] mt-0.5">{r.personnelTypeName}</div>
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#262238]">
                          {r.totalShifts}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-[#B87516]">
                          {r.lateOccurrences} ครั้ง
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums font-bold text-[#262238]">
                          {r.totalLateMinutes} นาที
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#746B83]">
                          {r.avgLateMinutesPerOccurrence}
                        </td>
                        <td className="py-3.5 px-4 text-right font-mono tabular-nums text-[#C74455] font-semibold">
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
