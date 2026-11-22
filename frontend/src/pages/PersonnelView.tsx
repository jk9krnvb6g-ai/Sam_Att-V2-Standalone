/**
 * ============================================================================
 * หน้าทะเบียนบุคลากร HOSOffice และการตรวจสอบรหัสสแกนนิ้ว (Personnel Roster & Mapping)
 * ไฟล์: frontend/src/pages/PersonnelView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงรายชื่อบุคลากรที่ซิงก์มาจากตาราง hr_person ของฐานข้อมูล HOSOffice
 * 2. สั่งซิงก์ข้อมูลบุคลากรแบบ Read-Only (POST /api/Sam_Att/personnel/sync)
 *    พร้อม ConfirmDialog, ProgressDialog และการกู้คืนสถานะงานอัตโนมัติเมื่อรีเฟรชหน้า
 * 3. ตรวจสอบและแจ้งเตือนรายการที่มีปัญหาการผูกรหัสลายนิ้วมือ (เช่น ยังไม่มี FINGLE_ID หรือรหัสซ้ำกัน)
 */
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, Search, CheckCircle2, AlertTriangle, Clock, History, Lock, ShieldCheck } from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  MetricStrip,
  TabBar,
  FilterBar,
  StatusBadge,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  TableEmptyState,
  TableLoadingSkeleton,
  ConfirmDialog,
  ProgressDialog,
  SharedModal,
  RequiredMark,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  getCurrentBangkokDateParts,
} from '../utils/thaiFormat.ts';

export function PersonnelView({
  userRole,
  onNavigate,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const [search, setSearch] = useState('');
  const [mappingStatus, setMappingStatus] = useState('');
  const [tab, setTab] = useState<'list' | 'issues' | 'syncHistory'>('list');
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [items, setItems] = useState<any[]>([]);
  const [syncLogs, setSyncLogs] = useState<any[]>([]);
  const [issuesData, setIssuesData] = useState<any>(null);

  // Confirm & Progress Dialog state
  const [confirmSyncOpen, setConfirmSyncOpen] = useState(false);
  const [progressOpen, setProgressOpen] = useState(false);
  const [progressStep, setProgressStep] = useState('กำลังเตรียมเชื่อมต่อฐานข้อมูล HOSOffice...');
  const [progressPercent, setProgressPercent] = useState<number | null>(null);
  const [progressStatus, setProgressStatus] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
  const [progressSummary, setProgressSummary] = useState<string | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);

  // Sorting & Pagination
  const [sortKey, setSortKey] = useState('person_id');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  // Resolve unmatched raw scans state
  const [resolveDateFrom, setResolveDateFrom] = useState(initialBkk.monthStartYmd);
  const [resolveDateTo, setResolveDateTo] = useState(initialBkk.todayYmd);
  const [resolvingUnmatched, setResolvingUnmatched] = useState(false);

  // ADMIN-only Retroactive Historical Mapping Preview & Approval Modal state
  const [retroMappingTarget, setRetroMappingTarget] = useState<any | null>(null);
  const [retroEffectiveFrom, setRetroEffectiveFrom] = useState('');
  const [retroEffectiveTo, setRetroEffectiveTo] = useState('');
  const [retroPreview, setRetroPreview] = useState<any | null>(null);
  const [retroPreviewLoading, setRetroPreviewLoading] = useState(false);
  const [retroReason, setRetroReason] = useState('');
  const [retroReprocess, setRetroReprocess] = useState(true);
  const [retroImpactAck, setRetroImpactAck] = useState(false);
  const [retroPassword, setRetroPassword] = useState('');
  const [retroSubmitting, setRetroSubmitting] = useState(false);
  const [retroError, setRetroError] = useState<string | null>(null);

  const loadPersonnel = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        ...(search ? { search } : {}),
        ...(mappingStatus ? { mappingStatus } : {}),
      });
      const [listRes, issuesRes] = await Promise.all([
        apiRequest(`/personnel?${qs.toString()}`),
        apiRequest('/personnel/mapping-issues'),
      ]);
      setItems(listRes.items || []);
      setSyncLogs(listRes.syncLogs || []);
      setIssuesData(issuesRes);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถดึงข้อมูลบุคลากรได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [search, mappingStatus]);

  useEffect(() => {
    loadPersonnel();
  }, [loadPersonnel]);

  // กู้คืนสถานะงานซิงก์หากเปิดหน้าจอขณะกำลังซิงก์อยู่
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    async function checkActiveSyncJob() {
      try {
        const res = await apiRequest('/jobs/active?type=HOSOFFICE_PERSONNEL_SYNC');
        if (res?.inProgress && res?.activeJob) {
          setSyncing(true);
          setProgressOpen(true);
          setProgressStatus('RUNNING');
          setProgressStep(res.activeJob.currentStep || 'กำลังซิงก์ข้อมูลบุคลากรจาก HOSOffice...');
          setProgressPercent(
            typeof res.activeJob.progressPercent === 'number' ? res.activeJob.progressPercent : null
          );
        } else if (syncing && res?.latestJob && res.latestJob.status !== 'RUNNING') {
          setSyncing(false);
          setProgressPercent(res.latestJob.status === 'SUCCESS' ? 100 : null);
          setProgressStatus(res.latestJob.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED');
          setProgressStep(res.latestJob.currentStep || 'ดำเนินการเสร็จสิ้น');
          await loadPersonnel();
        }
      } catch {
        // ignore background poll error
      }
    }
    checkActiveSyncJob();
    if (syncing) {
      timer = setInterval(checkActiveSyncJob, 1500);
    }
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [syncing, loadPersonnel]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('ASC');
    }
    setPage(1);
  }

  async function handleConfirmSyncHosOffice() {
    setConfirmSyncOpen(false);
    setSyncing(true);
    setError(null);
    setSyncNotice(null);
    setProgressOpen(true);
    setProgressStatus('RUNNING');
    setProgressStep('กำลังเชื่อมต่อฐานข้อมูล HOSOffice และดึงรายชื่อบุคลากร...');
    setProgressPercent(null);
    setProgressSummary(null);
    setProgressError(null);

    try {
      const bkkToday = getCurrentBangkokDateParts().todayYmd;
      const res = await apiRequest('/personnel/sync', {
        method: 'POST',
        body: JSON.stringify({ effectiveDate: bkkToday }),
      });
      const newlyMatched = Number(res.autoMappingResolution?.newlyMatched || 0);
      const deactivatedCount = Number(res.deactivatedCount || 0);
      const reactivatedCount = Number(res.reactivatedCount || 0);
      const unverifiedMissingCount = Number(res.unverifiedMissingCount || 0);
      const summaryParts = [
        `ซิงก์ข้อมูลจากฐานข้อมูล HOSOffice (สถานะปกติ HR_STATUS_ID = '01') สำเร็จ: อ่าน ${res.recordsFetched} รายการ`,
        `อัปเดต ${res.recordsUpserted} รายการ`,
        `พบปัญหารหัสสแกน ${res.mappingConflictsFound} รายการ`,
      ];
      if (deactivatedCount > 0) {
        summaryParts.push(`ปรับสถานะไม่ปฏิบัติงาน (ยืนยันต้นทางแล้ว) ${deactivatedCount} คน`);
      }
      if (reactivatedCount > 0) {
        summaryParts.push(`คืนสถานะปฏิบัติงาน ${reactivatedCount} คน`);
      }
      if (unverifiedMissingCount > 0) {
        summaryParts.push(`คงสถานะเดิม (ยังไม่พบข้อมูลยืนยันต้นทาง) ${unverifiedMissingCount} คน`);
      }
      if (newlyMatched > 0) {
        summaryParts.push(`จับคู่สแกนค้างอัตโนมัติเพิ่ม ${newlyMatched} รายการ`);
      }
      const summaryMsg = summaryParts.join(' · ');
      setProgressPercent(100);
      setProgressStatus('SUCCESS');
      setProgressStep('ซิงก์ข้อมูลบุคลากรสำเร็จ');
      setProgressSummary(summaryMsg);
      setSyncNotice(summaryMsg);
      await loadPersonnel();
    } catch (err) {
      const errMsg =
        err instanceof ApiClientError
          ? err.message
          : 'การเชื่อมต่อฐานข้อมูล HOSOffice ล้มเหลว';
      setProgressPercent(null);
      setProgressStatus('FAILED');
      setProgressStep('ซิงก์ข้อมูลบุคลากรไม่สำเร็จ');
      setProgressError(errMsg);
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: errMsg });
      }
      await loadPersonnel();
    } finally {
      setSyncing(false);
    }
  }

  async function handleResolveUnmatchedScans() {
    if (!resolveDateFrom || !resolveDateTo) return;
    setResolvingUnmatched(true);
    setError(null);
    setSyncNotice(null);
    try {
      const res = await apiRequest('/personnel/mappings/resolve-unmatched', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom: resolveDateFrom,
          dateTo: resolveDateTo,
          reprocessAttendance: true,
        }),
      });
      const attCount = Number(res.reprocess?.processedCount || 0);
      setSyncNotice(
        `ตรวจสอบสแกนค้างสำเร็จ (${formatThaiDate(resolveDateFrom)} – ${formatThaiDate(resolveDateTo)}): จับคู่เพิ่ม ${res.newlyMatched ?? 0} รายการ · ยังไม่พบ ${res.stillUnmatched ?? 0} รายการ · ซ้ำซ้อน ${res.conflicts ?? 0} รายการ${attCount > 0 ? ` · ประมวลผลเวรใหม่ ${attCount} รายการ` : ''}`
      );
      await loadPersonnel();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถตรวจสอบและจับคู่สแกนค้างได้' });
      }
    } finally {
      setResolvingUnmatched(false);
    }
  }

  function handleOpenRetroModal(mappingRow: any) {
    setRetroMappingTarget(mappingRow);
    setRetroEffectiveFrom(mappingRow.earliest_unmatched_date || mappingRow.effective_from || '');
    setRetroEffectiveTo(mappingRow.effective_to || '');
    setRetroPreview(null);
    setRetroReason('');
    setRetroReprocess(true);
    setRetroImpactAck(false);
    setRetroPassword('');
    setRetroError(null);
  }

  function handleCloseRetroModal() {
    setRetroMappingTarget(null);
    setRetroPreview(null);
    setRetroPassword('');
    setRetroImpactAck(false);
    setRetroError(null);
  }

  async function handlePreviewRetroMapping() {
    if (!retroMappingTarget || !retroEffectiveFrom) return;
    setRetroPreviewLoading(true);
    setRetroError(null);
    setRetroPreview(null);
    try {
      const res = await apiRequest(
        `/personnel/mappings/${retroMappingTarget.id}/retroactive-preview`,
        {
          method: 'POST',
          body: JSON.stringify({
            proposedEffectiveFrom: retroEffectiveFrom,
            ...(retroEffectiveTo ? { proposedEffectiveTo: retroEffectiveTo } : {}),
          }),
        }
      );
      setRetroPreview(res.preview || res);
    } catch (err) {
      setRetroError(
        err instanceof ApiClientError
          ? err.message
          : 'ไม่สามารถจำลองผลกระทบการปรับวันที่มีผลย้อนหลังได้'
      );
    } finally {
      setRetroPreviewLoading(false);
    }
  }

  async function handleApproveRetroMapping(e: React.FormEvent) {
    e.preventDefault();
    if (!retroMappingTarget || !retroPreview?.canApprove) return;
    if (retroReason.trim().length < 5) {
      setRetroError('กรุณาระบุเหตุผลการปรับวันที่มีผลย้อนหลังอย่างน้อย 5 ตัวอักษร');
      return;
    }
    if (!retroImpactAck) {
      setRetroError('กรุณาทำเครื่องหมายรับทราบผลกระทบก่อนอนุมัติ');
      return;
    }
    if (!retroPassword.trim()) {
      setRetroError('กรุณากรอกรหัสผ่านผู้ดูแลระบบปัจจุบันเพื่อยืนยันตัวตน');
      return;
    }

    const pwd = retroPassword;
    setRetroPassword('');
    setRetroSubmitting(true);
    setRetroError(null);
    try {
      const res = await apiRequest(
        `/personnel/mappings/${retroMappingTarget.id}/retroactive-approve`,
        {
          method: 'POST',
          body: JSON.stringify({
            proposedEffectiveFrom: retroEffectiveFrom,
            ...(retroEffectiveTo ? { proposedEffectiveTo: retroEffectiveTo } : {}),
            reason: retroReason.trim(),
            reprocessAttendance: retroReprocess,
            impactAcknowledged: true,
            confirmPassword: pwd,
          }),
        }
      );
      const newlyMatched = Number(res.mappingResolution?.newlyMatched || 0);
      const processed = Number(res.reprocess?.processedCount || 0);
      setSyncNotice(
        `อนุมัติปรับวันที่มีผลย้อนหลังของ ${retroMappingTarget.full_name} (FINGLE_ID ${retroMappingTarget.fingle_id}) เป็น ${formatThaiDate(retroEffectiveFrom)} สำเร็จ: จับคู่สแกนเพิ่ม ${newlyMatched} รายการ${processed > 0 ? ` · ประมวลผลเวรใหม่ ${processed} รายการ` : ''}`
      );
      handleCloseRetroModal();
      await loadPersonnel();
    } catch (err) {
      setRetroError(
        err instanceof ApiClientError
          ? err.message
          : 'ไม่สามารถอนุมัติปรับวันที่มีผลย้อนหลังได้'
      );
    } finally {
      setRetroSubmitting(false);
    }
  }

  const sortedItems = [...items].sort((a, b) => {
    const valA = a[sortKey];
    const valB = b[sortKey];
    return sortDir === 'ASC'
      ? String(valA || '').localeCompare(String(valB || ''), 'th')
      : String(valB || '').localeCompare(String(valA || ''), 'th');
  });

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedItems.length) : pageSize;
  const pagedItems = sortedItems.slice((page - 1) * numericSize, page * numericSize);

  const validMappedCount = items.filter((p) => p.mapping_status === 'VALID').length;
  const issueCount = issuesData?.personnelIssues?.length || 0;
  const latestSyncLog = syncLogs[0] || null;

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="ทะเบียนบุคลากร HOSOffice"
        subtitle="ดึงข้อมูลบุคลากรแบบอ่านอย่างเดียว (Read-Only) จากตารางหลักของโรงพยาบาล พร้อมตรวจสอบความถูกต้องของรหัสสแกนลายนิ้วมือ (FINGLE_ID)"
        meta={
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-[#777287]">
            <Clock className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
            <span>ซิงก์ล่าสุด:</span>
            <span className="font-mono text-[#292638] font-medium tabular-nums">
              {latestSyncLog ? formatThaiDateTime(latestSyncLog.started_at) : 'ยังไม่มีประวัติการซิงก์'}
            </span>
            <span className="text-[#D8D1E6]" aria-hidden="true">·</span>
            <span>โหมด Read-Only (แก้ไขข้อมูลที่ต้นทาง HOSOffice)</span>
          </div>
        }
        actions={
          <>
            <PageHelpAction
              guideKey="personnel"
              activeTabKey={tab}
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={syncing}
              onClick={() => setConfirmSyncOpen(true)}
              className="ent-btn-primary"
            >
              <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>
                {syncing ? 'กำลังซิงก์ข้อมูลจาก HOSOffice...' : 'ซิงก์บุคลากรจาก HOSOffice'}
              </span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} />
      <NotificationBanner message={syncNotice} onClose={() => setSyncNotice(null)} />

      {/* Unified 4-Column Metric Strip */}
      <MetricStrip
        items={[
          {
            label: 'บุคลากรในทะเบียนทั้งหมด',
            value: `${items.length.toLocaleString('th-TH')} คน`,
            subtext: 'ซิงก์จาก hr_person (HOSOffice)',
            tone: 'primary',
          },
          {
            label: 'เชื่อมโยงรหัสสแกนสมบูรณ์',
            value: `${validMappedCount.toLocaleString('th-TH')} คน`,
            subtext:
              items.length > 0
                ? `${Math.round((validMappedCount / items.length) * 100)}% ของทะเบียนทั้งหมด`
                : 'พร้อมจับคู่สแกนลายนิ้วมือ',
            tone: 'success',
          },
          {
            label: 'พบปัญหาการจับคู่รหัสสแกน',
            value: `${issueCount.toLocaleString('th-TH')} รายการ`,
            subtext: issueCount > 0 ? 'คลิกเพื่อดูรายการที่ต้องแก้ไข' : 'ไม่พบปัญหารหัสซ้ำหรือว่าง',
            tone: issueCount > 0 ? 'danger' : 'success',
            onClick: () => setTab('issues'),
          },
          {
            label: 'สถานะการซิงก์ล่าสุด',
            value: latestSyncLog
              ? latestSyncLog.status === 'SUCCESS'
                ? 'สำเร็จ'
                : 'ไม่สำเร็จ'
              : 'ยังไม่มีประวัติ',
            subtext: latestSyncLog
              ? latestSyncLog.status === 'SUCCESS'
                ? `อัปเดต ${latestSyncLog.records_upserted} รายการ`
                : latestSyncLog.error_code || 'เชื่อมต่อไม่สำเร็จ'
              : 'กดซิงก์เพื่อดึงรายชื่อล่าสุด',
            tone: latestSyncLog
              ? latestSyncLog.status === 'SUCCESS'
                ? 'success'
                : 'danger'
              : 'neutral',
            onClick: () => setTab('syncHistory'),
          },
        ]}
      />

      {/* Underline Navigation Tabs */}
      <div className="border-b border-[#E8E4EF]">
        <TabBar
          variant="underline"
          activeKey={tab}
          onChange={(k) => setTab(k as 'list' | 'issues' | 'syncHistory')}
          items={[
            { key: 'list', label: 'รายชื่อบุคลากรทั้งหมด', count: items.length },
            { key: 'issues', label: 'รายการที่มีปัญหารหัสสแกน', count: issueCount },
            { key: 'syncHistory', label: 'ประวัติการซิงก์ HOSOffice', count: syncLogs.length },
          ]}
        />
      </div>

      {/* Filter Bar (visible on main list) */}
      {tab === 'list' && (
        <FilterBar>
          <div className="relative flex-1 min-w-[240px]">
            <Search
              className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              aria-label="ค้นหาบุคลากร"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาชื่อ-นามสกุล, รหัสบุคลากร, รหัสสแกน (FINGLE_ID)..."
              className="ent-input pl-10 pr-4 w-full"
            />
          </div>
          <select
            aria-label="กรองตามสถานะการจับคู่รหัสสแกน"
            value={mappingStatus}
            onChange={(e) => {
              setMappingStatus(e.target.value);
              setPage(1);
            }}
            className="ent-input w-full sm:w-64"
          >
            <option value="">ทุกสถานะรหัสสแกน</option>
            <option value="VALID">พร้อมใช้งาน (เชื่อมโยงสมบูรณ์)</option>
            <option value="EMPTY_FINGLE_ID">ยังไม่มีรหัสสแกนลายนิ้วมือ</option>
            <option value="DUPLICATE_FINGLE_ID">รหัสสแกนซ้ำซ้อนกัน</option>
          </select>
        </FilterBar>
      )}

      {loading ? (
        <div className="his-surface overflow-hidden">
          <TableLoadingSkeleton rows={6} cols={5} />
        </div>
      ) : tab === 'list' ? (
        <div className="his-surface overflow-hidden">
          <div className="md:hidden divide-y divide-[#E8E4EF]">
            {pagedItems.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#777287]">
                ไม่พบรายชื่อบุคลากรตามเงื่อนไขที่ค้นหา
              </div>
            ) : (
              pagedItems.map((p) => (
                <div key={p.person_id} className="p-4 space-y-2.5 bg-white">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-[15px] text-[#292638]">{p.full_name}</div>
                      <div className="text-[12.5px] font-mono text-[#777287] mt-0.5">
                        รหัสบุคลากร: {p.person_id}
                      </div>
                    </div>
                    {p.fingle_id ? (
                      <StatusBadge tone="primary">
                        <span className="font-mono">สแกน: {p.fingle_id}</span>
                      </StatusBadge>
                    ) : (
                      <StatusBadge tone="danger">ไม่มีรหัสสแกน</StatusBadge>
                    )}
                  </div>
                  <div className="text-[13.5px] text-[#292638]">
                    {p.position_name || '—'} ·{' '}
                    <span className="text-[#777287]">{p.department_name}</span>
                  </div>
                  <div className="text-[12.5px] text-[#777287]">{p.personnel_type_name}</div>
                  <div className="pt-1">
                    {p.mapping_status === 'VALID' ? (
                      <StatusBadge
                        tone="success"
                        icon={<CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
                      >
                        พร้อมใช้งาน (เชื่อมโยงปกติ)
                      </StatusBadge>
                    ) : (
                      <StatusBadge
                        tone="danger"
                        icon={<AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />}
                      >
                        {p.mapping_status === 'EMPTY_FINGLE_ID'
                          ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                          : p.mapping_status === 'DUPLICATE_FINGLE_ID'
                            ? 'รหัสสแกนซ้ำซ้อนกัน'
                            : p.mapping_status}
                      </StatusBadge>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="his-table">
              <thead>
                <tr>
                  <SortableHeader
                    label="ชื่อ-นามสกุล · รหัสบุคลากร"
                    sortKey="full_name"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="ตำแหน่งและประเภทบุคลากร"
                    sortKey="position_name"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="กลุ่มงาน / หน่วยงาน"
                    sortKey="department_name"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="รหัสสแกน (FINGLE_ID)"
                    sortKey="fingle_id"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="สถานะการเชื่อมโยงรหัสสแกน"
                    sortKey="mapping_status"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody>
                {pagedItems.length === 0 ? (
                  <TableEmptyState colSpan={5} title="ไม่พบรายชื่อบุคลากรตามเงื่อนไขที่ค้นหา" />
                ) : (
                  pagedItems.map((p) => (
                    <tr key={p.person_id}>
                      <td>
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-[14px] text-[#292638]">{p.full_name}</span>
                          {Number(p.is_active) === 0 && (
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold bg-[#F3F2F7] text-[#666079] border border-[#DDD8E8]">
                              ไม่ปฏิบัติงาน (HR_STATUS ≠ 01)
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] font-mono text-[#777287] mt-0.5">
                          รหัสบุคลากร: {p.person_id}
                        </div>
                      </td>
                      <td>
                        <div className="font-medium text-[#292638]">{p.position_name || '—'}</div>
                        <div className="text-[12.5px] text-[#777287] mt-0.5">
                          {p.personnel_type_name}
                        </div>
                      </td>
                      <td className="text-[#292638] font-medium">{p.department_name}</td>
                      <td className="font-mono tabular-nums">
                        {p.fingle_id ? (
                          <span className="font-semibold text-[13.5px] text-[#4E3978] bg-[#F1ECFA] px-2.5 py-1 rounded-md border border-[#E8E4EF]">
                            {p.fingle_id}
                          </span>
                        ) : (
                          <span className="text-[#C74455] font-sans text-[13px] font-medium">
                            ยังไม่ระบุรหัสสแกน
                          </span>
                        )}
                      </td>
                      <td>
                        {p.mapping_status === 'VALID' ? (
                          <StatusBadge
                            tone="success"
                            icon={<CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />}
                          >
                            พร้อมใช้งาน
                          </StatusBadge>
                        ) : (
                          <div className="space-y-1">
                            <StatusBadge
                              tone="danger"
                              icon={<AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />}
                            >
                              {p.mapping_status === 'EMPTY_FINGLE_ID'
                                ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                                : p.mapping_status === 'DUPLICATE_FINGLE_ID'
                                  ? 'รหัสสแกนซ้ำซ้อนกัน'
                                  : p.mapping_status}
                            </StatusBadge>
                            {p.mapping_issue_detail && (
                              <div className="text-[12px] text-[#C74455]">
                                {p.mapping_issue_detail}
                              </div>
                            )}
                          </div>
                        )}
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
            totalItems={sortedItems.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      ) : tab === 'issues' ? (
        <div className="space-y-6">
          <div className="his-surface overflow-hidden">
            <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-bold text-[#292638]">
                  รายการบุคลากรที่พบปัญหาการเชื่อมโยงรหัสสแกน ({issueCount} รายการ)
                </h2>
                <p className="text-[13px] text-[#777287] mt-0.5">
                  บุคลากรที่ยังไม่ได้ระบุรหัสสแกนลายนิ้วมือ (EMPTY_FINGLE_ID) หรือมีรหัสสแกนซ้ำซ้อนกันในฐานข้อมูล HOSOffice
                </p>
              </div>
              <StatusBadge tone="primary">ต้องแก้ไขที่ต้นทาง HOSOffice แล้วกดซิงก์ใหม่</StatusBadge>
            </div>
            <div className="overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>รหัสบุคลากร</th>
                    <th>ชื่อ-นามสกุล</th>
                    <th>กลุ่มงาน / หน่วยงาน</th>
                    <th>รหัสสแกน (FINGLE_ID)</th>
                    <th>สาเหตุที่ตรวจพบ</th>
                  </tr>
                </thead>
                <tbody>
                  {!issuesData?.personnelIssues || issuesData.personnelIssues.length === 0 ? (
                    <TableEmptyState
                      colSpan={5}
                      title="ไม่พบปัญหาการเชื่อมโยงรหัสสแกน บุคลากรทุกคนมีรหัส FINGLE_ID ครบถ้วนและไม่ซ้ำซ้อน"
                    />
                  ) : (
                    issuesData.personnelIssues.map((issue: any) => (
                      <tr key={issue.person_id}>
                        <td className="font-mono font-semibold text-[#292638]">
                          {issue.person_id}
                        </td>
                        <td className="font-semibold text-[#292638]">{issue.full_name}</td>
                        <td className="text-[#292638]">{issue.department_name}</td>
                        <td className="font-mono tabular-nums font-semibold text-[#C74455]">
                          {issue.fingle_id || 'ยังไม่ระบุรหัส'}
                        </td>
                        <td>
                          <StatusBadge
                            tone="danger"
                            icon={<AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />}
                          >
                            {issue.mapping_status === 'EMPTY_FINGLE_ID'
                              ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                              : issue.mapping_status === 'DUPLICATE_FINGLE_ID'
                                ? 'รหัสสแกนซ้ำซ้อนกัน'
                                : issue.mapping_status}
                          </StatusBadge>
                          {issue.mapping_issue_detail && (
                            <div className="text-[12px] text-[#777287] mt-1">
                              {issue.mapping_issue_detail}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="his-surface overflow-hidden">
            <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC] flex flex-col lg:flex-row lg:items-center justify-between gap-3">
              <div>
                <h2 className="text-[16px] font-bold text-[#292638]">
                  ประวัติการเชื่อมโยงรหัสสแกนตามวันที่มีผลบังคับใช้
                </h2>
                <p className="text-[13px] text-[#777287] mt-0.5">
                  ใช้สำหรับอ้างอิงการคำนวณเวลาย้อนหลังเมื่อบุคลากรมีการเปลี่ยนรหัสสแกนลายนิ้วมือ หรือมีสแกนย้อนหลังก่อนวันที่มีผลเริ่มต้น
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="date"
                  aria-label="ตั้งแต่วันที่ตรวจสอบสแกนค้าง"
                  value={resolveDateFrom}
                  onChange={(e) => setResolveDateFrom(e.target.value)}
                  className="ent-input font-mono text-[12.5px] h-9"
                />
                <span className="text-[12.5px] text-[#777287]">ถึง</span>
                <input
                  type="date"
                  aria-label="ถึงวันที่ตรวจสอบสแกนค้าง"
                  value={resolveDateTo}
                  onChange={(e) => setResolveDateTo(e.target.value)}
                  className="ent-input font-mono text-[12.5px] h-9"
                />
                <button
                  type="button"
                  disabled={resolvingUnmatched || !resolveDateFrom || !resolveDateTo}
                  onClick={handleResolveUnmatchedScans}
                  className="ent-btn-secondary h-9 px-3 text-[12.5px]"
                >
                  <ShieldCheck className="w-4 h-4 text-[#8066B5]" />
                  <span>{resolvingUnmatched ? 'กำลังตรวจสอบ...' : 'ตรวจสอบและจับคู่สแกนค้าง'}</span>
                </button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>รหัสบุคลากร</th>
                    <th>ชื่อ-นามสกุล</th>
                    <th>รหัสสแกน (FINGLE_ID)</th>
                    <th>มีผลตั้งแต่วันที่</th>
                    <th>สิ้นสุดวันที่</th>
                    <th>สแกนค้างก่อนวันที่มีผล</th>
                    <th>สถานะความถูกต้อง</th>
                    {userRole === 'ADMIN' && <th className="text-right">จัดการย้อนหลัง (Admin)</th>}
                  </tr>
                </thead>
                <tbody>
                  {issuesData?.mappingHistory?.map((m: any) => {
                    const unmatchedBefore = Number(m.unmatched_before_effective_count || 0);
                    return (
                      <tr key={m.id}>
                        <td className="font-mono font-semibold text-[#292638]">{m.person_id}</td>
                        <td>
                          <div className="font-semibold text-[#292638]">{m.full_name}</div>
                          {m.retroactive_adjusted_by && (
                            <div className="text-[11.5px] text-[#8066B5] mt-0.5">
                              ปรับย้อนหลังโดย {m.retroactive_adjusted_by}
                              {m.original_effective_from
                                ? ` (เดิม ${formatThaiDate(m.original_effective_from)})`
                                : ''}
                              {m.retroactive_reason ? ` · ${m.retroactive_reason}` : ''}
                            </div>
                          )}
                        </td>
                        <td className="font-mono tabular-nums font-semibold text-[#4E3978]">
                          {m.fingle_id}
                        </td>
                        <td className="font-mono tabular-nums text-[#292638]">
                          {formatThaiDate(m.effective_from)}
                        </td>
                        <td className="font-mono tabular-nums text-[#777287]">
                          {m.effective_to ? formatThaiDate(m.effective_to) : 'ใช้งานอยู่ในปัจจุบัน'}
                        </td>
                        <td>
                          {unmatchedBefore > 0 ? (
                            <div className="space-y-0.5">
                              <StatusBadge tone="warning" compact>
                                ค้าง {unmatchedBefore} รายการ
                              </StatusBadge>
                              {m.earliest_unmatched_date && (
                                <div className="text-[11.5px] font-mono text-[#777287]">
                                  {formatThaiDate(m.earliest_unmatched_date)}
                                  {m.latest_unmatched_date &&
                                  m.latest_unmatched_date !== m.earliest_unmatched_date
                                    ? ` – ${formatThaiDate(m.latest_unmatched_date)}`
                                    : ''}
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="text-[12.5px] text-[#777287]">ไม่มี</span>
                          )}
                        </td>
                        <td>
                          <StatusBadge tone={m.conflict_state === 'NONE' ? 'success' : 'danger'} dot>
                            {m.conflict_state === 'NONE' ? 'ปกติ' : m.conflict_state}
                          </StatusBadge>
                        </td>
                        {userRole === 'ADMIN' && (
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => handleOpenRetroModal(m)}
                              className="ent-btn-secondary h-8 px-3 text-[12.5px]"
                            >
                              <History className="w-3.5 h-3.5 text-[#8066B5]" />
                              <span>ปรับวันที่มีผลย้อนหลัง</span>
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="his-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="his-table">
              <thead>
                <tr>
                  <th>รอบการซิงก์</th>
                  <th>วันและเวลาที่ดำเนินการ</th>
                  <th>สถานะ</th>
                  <th className="text-right">จำนวนที่อ่าน</th>
                  <th className="text-right">อัปเดตสำเร็จ</th>
                  <th>รายละเอียดผลการเชื่อมต่อ</th>
                  <th>ผู้ดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {syncLogs.length === 0 ? (
                  <TableEmptyState colSpan={7} title="ยังไม่มีประวัติการสั่งซิงก์ข้อมูลจาก HOSOffice" />
                ) : (
                  syncLogs.map((log) => (
                    <tr key={log.id}>
                      <td className="font-mono tabular-nums font-semibold text-[#292638]">
                        #{log.id}
                      </td>
                      <td className="font-mono tabular-nums text-[#292638]">
                        {formatThaiDateTime(log.started_at)}
                      </td>
                      <td>
                        <StatusBadge tone={log.status === 'SUCCESS' ? 'success' : 'danger'} dot>
                          {log.status === 'SUCCESS' ? 'สำเร็จ' : 'ไม่สำเร็จ'}
                        </StatusBadge>
                      </td>
                      <td className="text-right font-mono tabular-nums">{log.records_fetched}</td>
                      <td className="text-right font-mono tabular-nums font-bold text-[#292638]">
                        {log.records_upserted}
                      </td>
                      <td className="text-[#777287]">
                        {log.error_code
                          ? `${log.error_code}: ${log.error_message}`
                          : 'ซิงก์ข้อมูลปกติ'}
                      </td>
                      <td className="font-mono text-[#777287]">{log.triggered_by}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ConfirmDialog ก่อนซิงก์ HOSOffice */}
      <ConfirmDialog
        open={confirmSyncOpen}
        title="ยืนยันการซิงก์ข้อมูลบุคลากรจาก HOSOffice"
        description="ระบบจะดึงข้อมูลบุคลากรแบบอ่านอย่างเดียว (Read-Only) จากฐานข้อมูล HOSOffice โดยไม่ทับตารางเวรที่แก้ไขไว้"
        confirmLabel="เริ่มซิงก์ข้อมูลบุคลากร"
        loading={syncing}
        onConfirm={handleConfirmSyncHosOffice}
        onCancel={() => setConfirmSyncOpen(false)}
      />

      {/* ProgressDialog แสดงสถานะการซิงก์ HOSOffice */}
      <ProgressDialog
        open={progressOpen}
        title="ซิงก์ข้อมูลบุคลากรจาก HOSOffice"
        stepLabel={progressStep}
        percent={progressPercent}
        status={progressStatus}
        summaryText={progressSummary}
        errorMessage={progressError}
        onClose={() => setProgressOpen(false)}
      />

      {/* ADMIN-only Retroactive Historical Mapping Preview & Approval Modal */}
      {userRole === 'ADMIN' && (
        <SharedModal
          open={Boolean(retroMappingTarget)}
          onClose={handleCloseRetroModal}
          kickerText="ผู้ดูแลระบบเท่านั้น · ตรวจสอบผลกระทบและป้องกันรหัสชนซ้ำ"
          title={
            retroMappingTarget
              ? `ปรับวันที่มีผลย้อนหลัง: ${retroMappingTarget.full_name} (FINGLE_ID ${retroMappingTarget.fingle_id})`
              : 'ปรับวันที่มีผลย้อนหลัง'
          }
          maxWidthClass="max-w-2xl"
        >
          {retroMappingTarget && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13px] grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <div className="text-[#777287]">รหัสบุคลากร</div>
                  <div className="font-mono font-bold text-[#292638]">
                    {retroMappingTarget.person_id}
                  </div>
                </div>
                <div>
                  <div className="text-[#777287]">รหัสสแกน (FINGLE_ID)</div>
                  <div className="font-mono font-bold text-[#4E3978]">
                    {retroMappingTarget.fingle_id}
                  </div>
                </div>
                <div>
                  <div className="text-[#777287]">วันที่มีผลเดิม</div>
                  <div className="font-mono font-semibold text-[#292638]">
                    {formatThaiDate(retroMappingTarget.effective_from)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 items-end">
                <div>
                  <label htmlFor="retro-effective-from" className="ent-label">
                    วันที่มีผลบังคับใช้ใหม่ (ตั้งแต่) <RequiredMark />
                  </label>
                  <input
                    id="retro-effective-from"
                    type="date"
                    value={retroEffectiveFrom}
                    onChange={(e) => {
                      setRetroEffectiveFrom(e.target.value);
                      setRetroPreview(null);
                    }}
                    className="ent-input w-full font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="retro-effective-to" className="ent-label">
                    วันที่สิ้นสุด (ไม่บังคับ — เว้นว่างหากยังใช้งานอยู่)
                  </label>
                  <input
                    id="retro-effective-to"
                    type="date"
                    value={retroEffectiveTo}
                    onChange={(e) => {
                      setRetroEffectiveTo(e.target.value);
                      setRetroPreview(null);
                    }}
                    className="ent-input w-full font-mono"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={retroPreviewLoading || !retroEffectiveFrom}
                  onClick={handlePreviewRetroMapping}
                  className="ent-btn-secondary"
                >
                  <ShieldCheck className="w-4 h-4 text-[#8066B5]" />
                  <span>
                    {retroPreviewLoading
                      ? 'กำลังตรวจสอบผลกระทบและชนซ้ำ...'
                      : 'ตรวจสอบผลกระทบและชนซ้ำ (Preview)'}
                  </span>
                </button>
              </div>

              {retroPreview && (
                <div className="space-y-4 border-t border-[#E8E4EF] pt-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div className="p-3 rounded-lg bg-[#EEF8F4] border border-[#198568]/20">
                      <div className="text-[11.5px] text-[#777287]">จะจับคู่ได้เพิ่ม</div>
                      <div className="font-mono font-bold text-[18px] text-[#198568]">
                        {retroPreview.willBecomeMatchedCount ?? 0}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF]">
                      <div className="text-[11.5px] text-[#777287]">จับคู่ไว้แล้ว</div>
                      <div className="font-mono font-bold text-[18px] text-[#292638]">
                        {retroPreview.alreadyMatchedCount ?? 0}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#FDF2F4] border border-[#C74455]/20">
                      <div className="text-[11.5px] text-[#777287]">ติดขัดชนซ้ำ</div>
                      <div className="font-mono font-bold text-[18px] text-[#C74455]">
                        {retroPreview.blockedByConflictCount ?? 0}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#FEF7EA] border border-[#B87516]/20">
                      <div className="text-[11.5px] text-[#777287]">ยังค้างนอกช่วง</div>
                      <div className="font-mono font-bold text-[18px] text-[#B87516]">
                        {retroPreview.outOfRangeRemainingUnmatchedCount ?? 0}
                      </div>
                    </div>
                  </div>

                  {!retroPreview.canApprove ? (
                    <div
                      role="alert"
                      className="p-4 rounded-xl bg-[#FDF2F4] border border-[#C74455]/30 space-y-2"
                    >
                      <div className="font-bold text-[#C74455] text-[13.5px] flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                        <span>ไม่อนุญาตให้อนุมัติ: พบการถือครองรหัสสแกนซ้ำซ้อนในช่วงเวลาดังกล่าว</span>
                      </div>
                      <div className="text-[12.5px] text-[#292638] space-y-1">
                        {(retroPreview.conflicts || []).map((c: any, idx: number) => (
                          <div key={idx} className="font-mono">
                            • รหัสบุคลากร {c.person_id} ({c.full_name}) ถือครองรหัสนี้ช่วง{' '}
                            {formatThaiDate(c.effective_from)} ถึง{' '}
                            {c.effective_to ? formatThaiDate(c.effective_to) : 'ปัจจุบัน'}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <form onSubmit={handleApproveRetroMapping} className="space-y-3.5">
                      <div>
                        <label htmlFor="retro-reason" className="ent-label">
                          เหตุผลการปรับวันที่มีผลย้อนหลัง (อย่างน้อย 5 ตัวอักษร) <RequiredMark />
                        </label>
                        <textarea
                          id="retro-reason"
                          rows={2}
                          required
                          value={retroReason}
                          onChange={(e) => setRetroReason(e.target.value)}
                          placeholder="เช่น บุคลากรเริ่มใช้งานรหัสสแกนตั้งแต่วันที่ 1 พ.ย. แต่เพิ่งบันทึกลง HOSOffice"
                          className="ent-input w-full"
                        />
                      </div>

                      <label className="flex items-center gap-2 text-[13px] text-[#292638] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={retroReprocess}
                          onChange={(e) => setRetroReprocess(e.target.checked)}
                          className="w-4 h-4 accent-[#8066B5]"
                        />
                        <span>ประมวลผลตารางเวรและเวลาปฏิบัติงานในช่วงวันที่ได้รับผลกระทบให้อัตโนมัติ</span>
                      </label>

                      <label className="flex items-start gap-2.5 p-3 rounded-xl border border-[#D8D1E6] bg-[#F8F7FC] cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={retroImpactAck}
                          onChange={(e) => setRetroImpactAck(e.target.checked)}
                          className="w-4 h-4 mt-0.5 accent-[#8066B5]"
                        />
                        <span className="text-[13px] font-medium text-[#292638]">
                          ข้าพเจ้ารับทราบผลกระทบของการปรับวันที่มีผลย้อนหลัง การจับคู่สแกนค้าง และการประมวลผลเวลาปฏิบัติงานใหม่แล้ว
                        </span>
                      </label>

                      <div>
                        <label htmlFor="retro-password" className="ent-label">
                          ยืนยันรหัสผ่านผู้ดูแลระบบปัจจุบัน <RequiredMark />
                        </label>
                        <input
                          id="retro-password"
                          type="password"
                          autoComplete="current-password"
                          value={retroPassword}
                          onChange={(e) => setRetroPassword(e.target.value)}
                          placeholder="กรอกรหัสผ่านบัญชี ADMIN ปัจจุบัน..."
                          className="ent-input w-full"
                        />
                      </div>

                      <div className="flex justify-end gap-2 pt-2 border-t border-[#E8E4EF]">
                        <button
                          type="button"
                          disabled={retroSubmitting}
                          onClick={handleCloseRetroModal}
                          className="ent-btn-secondary"
                        >
                          ยกเลิก
                        </button>
                        <button
                          type="submit"
                          disabled={
                            retroSubmitting ||
                            retroReason.trim().length < 5 ||
                            !retroImpactAck ||
                            !retroPassword.trim()
                          }
                          className="ent-btn-primary"
                        >
                          <Lock className="w-4 h-4" />
                          <span>
                            {retroSubmitting
                              ? 'กำลังอนุมัติและประมวลผล...'
                              : 'อนุมัติปรับวันที่มีผลย้อนหลัง'}
                          </span>
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              )}

              {retroError && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-[#FDF2F4] border border-[#C74455]/25 text-[#C74455] text-[13px] font-medium flex items-start gap-2"
                >
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{retroError}</span>
                </div>
              )}
            </div>
          )}
        </SharedModal>
      )}
    </div>
  );
}
