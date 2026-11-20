/**
 * ============================================================================
 * ไฟล์: frontend/src/pages/ReportsView.tsx
 * หน้าที่: หน้าจอรายงานสถิติการมาสาย (Lateness Report) และการส่งข้อมูลเข้า HOSOffice (Direct Push)
 * ============================================================================
 * ประกอบด้วย 2 คอมโพเนนต์หลัก:
 * 1. ReportsView (mode === 'reports'):
 *    - รายงานสรุปสถิติการมาสายของบุคลากรโรงพยาบาลสามชุก รองรับทุกประเภทบุคลากร
 *    - ส่งออกไฟล์ CSV (Export CSV) ที่เปิดอ่านภาษาไทยใน Excel ได้ทันที (UTF-8 BOM)
 * 2. PushView (mode === 'hosofficePush'):
 *    - หน้าจอส่งข้อมูลสรุปเวลาปฏิบัติงานเข้าสู่ระบบ HOSOffice โดยตรง (Direct Push)
 *    - มี ConfirmDialog, ProgressDialog และการกู้คืนสถานะงานอัตโนมัติเมื่อรีเฟรชหน้า (Section 11)
 * ============================================================================
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { Download, Eye, Send, FileText } from 'lucide-react';
import { apiRequest, downloadLatenessCsv, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  PeriodFilterBar,
  SortableHeader,
  TablePaginationBar,
  SharedModal,
  NotificationBanner,
  TableEmptyState,
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  resolvePeriodRange,
  getCurrentBangkokDateParts,
  type PeriodMode,
} from '../utils/thaiFormat.ts';

export function ReportsView({ mode }: { mode: 'reports' | 'hosofficePush' }) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  const [periodMode, setPeriodMode] = useState<PeriodMode>('MONTHLY');
  const [dailyDate, setDailyDate] = useState(initialBkk.todayYmd);
  const [monthValue, setMonthValue] = useState(initialBkk.currentYearMonth);
  const [yearValue, setYearValue] = useState(initialBkk.currentYear);
  const [customFrom, setCustomFrom] = useState(initialBkk.monthStartYmd);
  const [customTo, setCustomTo] = useState(initialBkk.monthEndYmd);
  const [personnelType, setPersonnelType] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [reportData, setReportData] = useState<any>(null);
  const [pushHistoryData, setPushHistoryData] = useState<any>(null);
  const [previewBatch, setPreviewBatch] = useState<any>(null);
  const [inspectPayloadModal, setInspectPayloadModal] = useState<any | null>(null);

  // HOSOffice Push Confirm & Progress Dialog state (Section 11)
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

  // กู้คืนสถานะงานส่งข้อมูลกลับ HOSOffice หากรีเฟรชหน้าจอ (Section 9 & 11)
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

  if (mode === 'hosofficePush') {
    return (
      <div className="space-y-6">
        <PageHeader
          category="ตั้งค่าระบบและส่วนกลาง"
          title="ส่งข้อมูลสรุปเวลาปฏิบัติงานกลับ HOSOffice"
          subtitle="ตรวจสอบความสมบูรณ์ของข้อมูลด้วยโหมดจำลอง (Dry-Run Preview) ก่อนส่งข้อมูลจริง โดยระบบล็อกการเขียนข้อมูลจริงไว้จนกว่าจะได้รับการอนุมัติโครงสร้างตารางปลายทาง"
          actions={
            <>
              <button
                type="button"
                onClick={handlePreviewHosOfficePush}
                className="ent-btn-secondary"
              >
                <Eye className="w-4 h-4 text-[#8B73C7]" />
                <span>1. ตรวจสอบและสร้างชุดข้อมูลจำลอง (Preview)</span>
              </button>
              <button
                type="button"
                disabled={pushingLive}
                onClick={() => setConfirmPushOpen(true)}
                className="ent-btn-primary"
              >
                <Send className="w-4 h-4" />
                <span>
                  2. ส่งข้อมูลจริงไปยัง HOSOffice (
                  {pushHistoryData?.livePushEnabled ? 'เปิดใช้งาน' : 'ล็อกเพื่อความปลอดภัย'})
                </span>
              </button>
            </>
          }
        />

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
            <div className="ent-card p-6 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-[18px] font-bold text-[#273244]">
                  รายการที่ผ่านเกณฑ์พร้อมส่ง ({previewBatch.validCount} รายการ)
                </h2>
                <button
                  type="button"
                  onClick={() => setInspectPayloadModal(previewBatch)}
                  className="text-[13.5px] font-semibold text-[#7359B4] hover:underline inline-flex items-center gap-1.5"
                >
                  <FileText className="w-4 h-4" />
                  <span>ขยายดูข้อมูลเต็มจอ</span>
                </button>
              </div>
              <pre className="p-4 bg-[#273244] text-white rounded-xl text-[13px] font-mono overflow-x-auto max-h-72">
                {JSON.stringify(previewBatch.validItems, null, 2)}
              </pre>
            </div>

            <div className="ent-card p-6 space-y-3">
              <h2 className="text-[18px] font-bold text-[#B91C1C]">
                รายการที่ไม่ผ่านเกณฑ์ตรวจสอบก่อนส่ง ({previewBatch.invalidCount} รายการ)
              </h2>
              <div className="divide-y divide-[#E7E2F0] text-[14px] max-h-72 overflow-y-auto">
                {previewBatch.invalidItems?.map((inv: any) => (
                  <div key={inv.attendanceId} className="py-3">
                    <div className="font-bold text-[#273244]">
                      เวร #{inv.attendanceId} · {inv.fullName} ({inv.personId}) —{' '}
                      {formatThaiDate(inv.workDate)}
                    </div>
                    <div className="text-[#B91C1C] mt-0.5">{inv.reason}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="ent-table-wrapper">
          <div className="px-6 py-4 border-b border-[#E7E2F0] bg-[#FAF9FD]">
            <h2 className="text-[18px] font-bold text-[#273244]">
              ประวัติการตรวจสอบและส่งข้อมูลกลับ HOSOffice
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">รหัสอ้างอิงชุดข้อมูล</th>
                  <th className="py-3.5 px-5 font-semibold">โหมดการทำงาน</th>
                  <th className="py-3.5 px-5 font-semibold">ช่วงวันที่ข้อมูล</th>
                  <th className="py-3.5 px-5 font-semibold text-right">ทั้งหมด / ผ่าน / ไม่ผ่าน</th>
                  <th className="py-3.5 px-5 font-semibold">สถานะ</th>
                  <th className="py-3.5 px-5 font-semibold">ผู้ดำเนินการ · วันเวลา</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2F0]">
                {pushHistoryData?.items?.length === 0 ? (
                  <TableEmptyState colSpan={6} title="ยังไม่มีประวัติการสร้างชุดข้อมูลส่งกลับ HOSOffice" />
                ) : (
                  pushHistoryData?.items?.map((p: any) => (
                    <tr key={p.id} className="hover:bg-[#FAF9FD]">
                      <td className="py-4 px-5 font-mono font-semibold text-[#273244]">
                        {p.idempotency_key}
                      </td>
                      <td className="py-4 px-5 font-mono text-[#596579]">{p.push_mode}</td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#273244]">
                        {formatThaiDate(p.date_from)} ถึง {formatThaiDate(p.date_to)}
                      </td>
                      <td className="py-4 px-5 text-right font-mono tabular-nums">
                        {p.total_records} / <span className="text-[#047857] font-bold">{p.valid_records}</span> /{' '}
                        <span className="text-[#B91C1C] font-bold">{p.invalid_records}</span>
                      </td>
                      <td className="py-4 px-5 font-semibold text-[#7359B4]">{p.status}</td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#596579]">
                        {p.initiated_by} · {formatThaiDateTime(p.created_at)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <SharedModal
          open={Boolean(inspectPayloadModal)}
          onClose={() => setInspectPayloadModal(null)}
          title={`รายละเอียดชุดข้อมูลเตรียมส่ง HOSOffice (${inspectPayloadModal?.idempotencyKey || ''})`}
          maxWidthClass="max-w-3xl"
        >
          {inspectPayloadModal && (
            <div className="space-y-3 text-[14px]">
              <pre className="p-4 bg-[#273244] text-white rounded-xl font-mono text-[13px] overflow-x-auto max-h-96">
                {JSON.stringify(inspectPayloadModal, null, 2)}
              </pre>
            </div>
          )}
        </SharedModal>

        {/* ConfirmDialog ก่อนส่งข้อมูลกลับ HOSOffice (Section 11) */}
        <ConfirmDialog
          open={confirmPushOpen}
          title="ยืนยันการส่งข้อมูลสรุปเวลาปฏิบัติงานกลับ HOSOffice"
          description={`ช่วงวันที่ ${formatThaiDate(effectiveRange.dateFrom)} ถึง ${formatThaiDate(effectiveRange.dateTo)}`}
          confirmLabel="ยืนยันส่งข้อมูลกลับ HOSOffice"
          loading={pushingLive}
          onConfirm={handleConfirmLiveHosOfficePush}
          onCancel={() => setConfirmPushOpen(false)}
        />

        {/* ProgressDialog แสดงสถานะการส่งข้อมูลกลับ HOSOffice (Section 11) */}
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

  const kpi = reportData?.kpi;
  const rawRanking: any[] = reportData?.ranking || [];
  const deptBreakdown: any[] = reportData?.departmentBreakdown || [];

  const sortedRanking = [...rawRanking].sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    if (typeof valA === 'number' && typeof valB === 'number') {
      return sortDir === 'ASC' ? valA - valB : valB - valA;
    }
    return sortDir === 'ASC'
      ? String(valA || '').localeCompare(String(valB || ''), 'th')
      : String(valB || '').localeCompare(String(valA || ''), 'th');
  });

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedRanking.length) : pageSize;
  const pagedRanking = sortedRanking.slice((page - 1) * numericSize, page * numericSize);

  const maxDeptLateMins = Math.max(
    1,
    ...deptBreakdown.map((d: any) => Number(d.totalLateMinutes || 0))
  );

  return (
    <div className="space-y-6">
      <PageHeader
        category="การบริหารเวลาและบุคลากร"
        title="รายงานและสถิติการมาสายประจำงวด"
        subtitle="สรุปสถิติการมาสายแยกตามจำนวนคนไม่ซ้ำและจำนวนครั้งที่มาสาย พร้อมเปรียบเทียบตามกลุ่มงานและส่งออกไฟล์ CSV สำหรับงานบริหารบุคคล"
        actions={
          <button
            type="button"
            onClick={handleExportCsv}
            className="ent-btn-primary"
          >
            <Download className="w-4 h-4" />
            <span>ดาวน์โหลดรายงาน CSV</span>
          </button>
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
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {kpi && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-semibold text-[#596579]">
              จำนวนบุคลากรที่มาสาย (ไม่ซ้ำคน)
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#B45309] tabular-nums">
              {kpi.latePeople} คน
            </div>
            <div className="text-[12.5px] text-[#596579] mt-1">
              เฉลี่ย {kpi.avgLateMinutesPerLatePerson} นาที/คน
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-semibold text-[#596579]">
              จำนวนครั้งที่มาสายรวมทั้งหมด
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#273244] tabular-nums">
              {kpi.lateOccurrences} ครั้ง
            </div>
            <div className="text-[12.5px] text-[#596579] mt-1">
              จากเวรปฏิบัติงานทั้งหมด {kpi.totalShifts} เวร
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-semibold text-[#596579]">
              นาทีสายสะสมรวมทั้งองค์กร
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#273244] tabular-nums">
              {kpi.totalLateMinutes} นาที
            </div>
            <div className="text-[12.5px] text-[#596579] mt-1">
              คำนวณหลังหักเวลาผ่อนผันตามกะแล้ว
            </div>
          </div>
          <div className="ent-card p-5">
            <div className="text-[13.5px] font-semibold text-[#596579]">
              ค่าเฉลี่ยนาทีสายต่อครั้ง
            </div>
            <div className="mt-1.5 text-[28px] font-bold text-[#7359B4] tabular-nums">
              {kpi.avgLateMinutesPerOccurrence} นาที/ครั้ง
            </div>
            <div className="text-[12.5px] text-[#596579] mt-1">
              นาทีสายรวม ÷ จำนวนครั้งที่สาย
            </div>
          </div>
        </div>
      )}

      {deptBreakdown.length > 0 && (
        <div className="ent-card p-4 sm:p-6 space-y-4">
          <div>
            <h2 className="text-[18px] font-bold text-[#273244]">
              แผนภูมิเปรียบเทียบสถิติการมาสายแยกตามกลุ่มงาน / หน่วยงาน
            </h2>
            <p className="text-[13.5px] text-[#596579]">
              แสดงนาทีสายสะสมเทียบกับจำนวนคนที่สายไม่ซ้ำและจำนวนครั้งที่สายในแต่ละหน่วยงาน
            </p>
          </div>
          <div className="space-y-3.5">
            {deptBreakdown.map((d: any) => {
              const barPct = Math.round((Number(d.totalLateMinutes || 0) / maxDeptLateMins) * 100);
              return (
                <div key={d.departmentName} className="space-y-1.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[14px]">
                    <span className="font-bold text-[#273244]">{d.departmentName}</span>
                    <div className="flex flex-wrap items-center gap-3 sm:gap-4 font-mono text-[13px] sm:text-[13.5px] tabular-nums">
                      <span className="text-[#596579]">เวรรวม {d.totalShifts} เวร</span>
                      <span className="text-[#B45309] font-semibold">
                        สาย {d.latePeople} คน ({d.lateOccurrences} ครั้ง)
                      </span>
                      <span className="font-bold text-[#7359B4]">
                        รวม {d.totalLateMinutes} นาที
                      </span>
                    </div>
                  </div>
                  <div className="h-3 w-full bg-[#FAF9FD] rounded-full overflow-hidden border border-[#E7E2F0]">
                    <div
                      style={{ width: `${Math.max(d.totalLateMinutes > 0 ? 6 : 0, barPct)}%` }}
                      className="h-full bg-[#8B73C7] rounded-full transition-all"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="ent-table-wrapper">
        <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2F0] bg-[#FAF9FD]">
          <h2 className="text-[18px] font-bold text-[#273244]">
            ตารางจัดอันดับสถิติการมาสายรายบุคคล
          </h2>
        </div>

        <div className="md:hidden divide-y divide-[#E7E2F0]">
          {loading ? (
            <div className="py-10 text-center text-[14.5px] text-[#596579]">
              กำลังประมวลผลรายงาน...
            </div>
          ) : pagedRanking.length === 0 ? (
            <div className="py-10 px-4 text-center text-[14.5px] text-[#596579]">
              ไม่พบข้อมูลการจัดอันดับในช่วงเวลาที่เลือก
            </div>
          ) : (
            pagedRanking.map((r: any, idx: number) => (
              <div key={r.personId} className="p-4 space-y-2.5 bg-white">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-[15.5px] text-[#273244]">
                      #{(page - 1) * numericSize + idx + 1} · {r.fullName}
                    </div>
                    <div className="text-[13px] text-[#596579]">
                      {r.departmentName} · {r.personnelTypeName}
                    </div>
                  </div>
                  <span className="font-mono font-bold text-[14px] text-[#B45309] bg-amber-50 px-2.5 py-0.5 rounded-md border border-amber-200">
                    รวม {r.totalLateMinutes} นาที
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 pt-1 text-center font-mono text-[13px]">
                  <div className="p-2 rounded-lg bg-[#FAF9FD] border border-[#E7E2F0]">
                    <div className="text-[11.5px] text-[#596579]">เวรทั้งหมด</div>
                    <div className="font-bold text-[#273244]">{r.totalShifts}</div>
                  </div>
                  <div className="p-2 rounded-lg bg-amber-50/70 border border-amber-200">
                    <div className="text-[11.5px] text-[#B45309]">สาย (ครั้ง)</div>
                    <div className="font-bold text-[#B45309]">{r.lateOccurrences} ครั้ง</div>
                  </div>
                  <div className="p-2 rounded-lg bg-red-50/70 border border-red-200">
                    <div className="text-[11.5px] text-[#B91C1C]">ขาด/ลืมออก</div>
                    <div className="font-bold text-[#B91C1C]">
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
              <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
                <th className="py-3.5 px-4 font-semibold">อันดับ</th>
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
            <tbody className="divide-y divide-[#E7E2F0]">
              {loading ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-[14.5px] text-[#596579]">
                    กำลังประมวลผลรายงาน...
                  </td>
                </tr>
              ) : pagedRanking.length === 0 ? (
                <TableEmptyState colSpan={8} title="ไม่พบข้อมูลการจัดอันดับในช่วงเวลาที่เลือก" />
              ) : (
                pagedRanking.map((r: any, idx: number) => (
                  <tr key={r.personId} className="hover:bg-[#FAF9FD] transition-colors">
                    <td className="py-4 px-4 font-mono tabular-nums font-semibold text-[#596579]">
                      #{(page - 1) * numericSize + idx + 1}
                    </td>
                    <td className="py-4 px-4">
                      <div className="font-bold text-[15px] text-[#273244]">{r.fullName}</div>
                      <div className="text-[12.5px] font-mono text-[#596579] mt-0.5">
                        รหัสบุคลากร: {r.personId}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <div className="font-medium text-[#273244]">{r.departmentName}</div>
                      <div className="text-[12.5px] text-[#596579] mt-0.5">{r.personnelTypeName}</div>
                    </td>
                    <td className="py-4 px-4 text-right font-mono tabular-nums text-[#273244]">
                      {r.totalShifts}
                    </td>
                    <td className="py-4 px-4 text-right font-mono tabular-nums font-semibold text-[#B45309]">
                      {r.lateOccurrences} ครั้ง
                    </td>
                    <td className="py-4 px-4 text-right font-mono tabular-nums font-bold text-[#273244]">
                      {r.totalLateMinutes} นาที
                    </td>
                    <td className="py-4 px-4 text-right font-mono tabular-nums text-[#596579]">
                      {r.avgLateMinutesPerOccurrence}
                    </td>
                    <td className="py-4 px-4 text-right font-mono tabular-nums text-[#B91C1C] font-semibold">
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
