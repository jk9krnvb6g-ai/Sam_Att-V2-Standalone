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
import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Search, CheckCircle2, AlertTriangle, Users, Clock } from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  TableEmptyState,
  TableLoadingSkeleton,
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import { formatThaiDate, formatThaiDateTime } from '../utils/thaiFormat.ts';

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

  // Sorting & Pagination
  const [sortKey, setSortKey] = useState('person_id');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

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
      const res = await apiRequest('/personnel/sync', {
        method: 'POST',
        body: JSON.stringify({ effectiveDate: new Date().toISOString().slice(0, 10) }),
      });
      const summaryMsg = `ซิงก์ข้อมูลจากฐานข้อมูล HOSOffice สำเร็จ: อ่าน ${res.recordsFetched} รายการ · อัปเดต ${res.recordsUpserted} รายการ · พบปัญหารหัสสแกน ${res.mappingConflictsFound} รายการ`;
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

      {/* Last Sync & Read-Only Status Strip */}
      <div className="ent-card px-4 sm:px-5 py-3 bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-2 text-[13px] text-[#746B83]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5 font-semibold text-[#543B7A]">
            <Clock className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
            <span>ซิงก์ล่าสุด:</span>
          </span>
          <span className="font-mono text-[#262238] tabular-nums">
            {latestSyncLog ? formatThaiDateTime(latestSyncLog.started_at) : 'ยังไม่มีประวัติการซิงก์'}
          </span>
          {latestSyncLog && (
            <>
              <span className="text-[#E6DFF0]" aria-hidden="true">·</span>
              <span
                className={`font-semibold ${
                  latestSyncLog.status === 'SUCCESS' ? 'text-[#198568]' : 'text-[#C74455]'
                }`}
              >
                {latestSyncLog.status === 'SUCCESS'
                  ? `สำเร็จ (อัปเดต ${latestSyncLog.records_upserted} รายการ)`
                  : `ไม่สำเร็จ (${latestSyncLog.error_code || 'ERROR'})`}
              </span>
            </>
          )}
        </div>
        <span className="text-[12.5px] font-medium text-[#746B83]">
          โหมด Read-Only · แก้ไขชื่อ/รหัสสแกนได้ที่ต้นทาง HOSOffice เท่านั้น
        </span>
      </div>

      {/* 3 Summary KPI Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="ent-card p-5 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium text-[#746B83]">บุคลากรในทะเบียนทั้งหมด</div>
            <div className="mt-1 text-[26px] font-bold text-[#262238] tabular-nums">
              {items.length} คน
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-[#F2EDFA] flex items-center justify-center text-[#8E70C9]">
            <Users className="w-5 h-5" aria-hidden="true" />
          </div>
        </div>

        <div className="ent-card p-5 flex items-center justify-between">
          <div>
            <div className="text-[13px] font-medium text-[#746B83]">เชื่อมโยงรหัสสแกนสมบูรณ์</div>
            <div className="mt-1 text-[26px] font-bold text-[#198568] tabular-nums">
              {validMappedCount} คน
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-[#EDF8F4] flex items-center justify-center text-[#198568]">
            <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setTab('issues')}
          className="ent-card p-5 flex items-center justify-between text-left hover:border-[#8E70C9]/60 transition-colors cursor-pointer"
        >
          <div>
            <div className="text-[13px] font-medium text-[#746B83]">
              พบปัญหาการจับคู่รหัสสแกน (คลิกตรวจสอบ)
            </div>
            <div className="mt-1 text-[26px] font-bold text-[#C74455] tabular-nums">
              {issueCount} รายการ
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-[#FDF2F3] flex items-center justify-center text-[#C74455]">
            <AlertTriangle className="w-5 h-5" aria-hidden="true" />
          </div>
        </button>
      </div>

      {/* Filter & View Switcher */}
      <div className="ent-card p-3.5 sm:p-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3.5">
        <div className="ent-tab-bar w-full xl:w-auto flex-col sm:flex-row">
          <button
            type="button"
            onClick={() => setTab('list')}
            className={`ent-tab-btn ${tab === 'list' ? 'ent-tab-btn-active' : ''}`}
          >
            รายชื่อบุคลากรทั้งหมด ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('issues')}
            className={`ent-tab-btn ${tab === 'issues' ? 'ent-tab-btn-active' : ''}`}
          >
            รายการที่มีปัญหา ({issueCount})
          </button>
          <button
            type="button"
            onClick={() => setTab('syncHistory')}
            className={`ent-tab-btn ${tab === 'syncHistory' ? 'ent-tab-btn-active' : ''}`}
          >
            ประวัติการซิงก์ ({syncLogs.length})
          </button>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 w-full xl:w-auto">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#746B83] absolute left-3.5 top-3" aria-hidden="true" />
            <input
              type="text"
              aria-label="ค้นหาบุคลากร"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาชื่อ, รหัสบุคลากร, รหัสสแกน..."
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
            className="ent-input w-full sm:w-auto"
          >
            <option value="">ทุกสถานะรหัสสแกน</option>
            <option value="VALID">พร้อมใช้งาน (เชื่อมโยงสมบูรณ์)</option>
            <option value="EMPTY_FINGLE_ID">ยังไม่มีรหัสสแกนลายนิ้วมือ</option>
            <option value="DUPLICATE_FINGLE_ID">รหัสสแกนซ้ำซ้อนกัน</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="ent-table-wrapper">
          <TableLoadingSkeleton rows={6} cols={5} />
        </div>
      ) : tab === 'list' ? (
        <div className="ent-table-wrapper">
          <div className="md:hidden divide-y divide-[#E6DFF0]">
            {pagedItems.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#746B83]">
                ไม่พบรายชื่อบุคลากรตามเงื่อนไขที่ค้นหา
              </div>
            ) : (
              pagedItems.map((p) => (
                <div key={p.person_id} className="p-4 space-y-2.5 bg-white">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-[15px] text-[#262238]">{p.full_name}</div>
                      <div className="text-[12.5px] font-mono text-[#746B83] mt-0.5">
                        รหัสบุคลากร: {p.person_id}
                      </div>
                    </div>
                    {p.fingle_id ? (
                      <span className="font-mono font-bold text-[13px] text-[#543B7A] bg-[#F2EDFA] px-2.5 py-1 rounded-lg border border-[#E6DFF0] shrink-0">
                        สแกน: {p.fingle_id}
                      </span>
                    ) : (
                      <span className="text-[#C74455] text-[12.5px] font-semibold bg-[#FDF2F3] px-2.5 py-1 rounded-lg border border-[#F3CCD0] shrink-0">
                        ไม่มีรหัสสแกน
                      </span>
                    )}
                  </div>
                  <div className="text-[13.5px] text-[#262238]">
                    {p.position_name || '—'} · <span className="text-[#746B83]">{p.department_name}</span>
                  </div>
                  <div className="text-[12.5px] text-[#746B83]">{p.personnel_type_name}</div>
                  <div className="pt-1">
                    {p.mapping_status === 'VALID' ? (
                      <div className="inline-flex items-center gap-1.5 text-[13px] text-[#198568] font-semibold">
                        <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>พร้อมใช้งาน (เชื่อมโยงปกติ)</span>
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 text-[13px] text-[#C74455] font-semibold">
                        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>
                          {p.mapping_status === 'EMPTY_FINGLE_ID'
                            ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                            : p.mapping_status === 'DUPLICATE_FINGLE_ID'
                              ? 'รหัสสแกนซ้ำซ้อนกัน'
                              : p.mapping_status}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
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
              <tbody className="divide-y divide-[#E6DFF0]">
                {pagedItems.length === 0 ? (
                  <TableEmptyState colSpan={5} title="ไม่พบรายชื่อบุคลากรตามเงื่อนไขที่ค้นหา" />
                ) : (
                  pagedItems.map((p) => (
                    <tr key={p.person_id} className="hover:bg-[#F8F7FC] transition-colors">
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-[14.5px] text-[#262238]">{p.full_name}</div>
                        <div className="text-[12px] font-mono text-[#746B83] mt-0.5">
                          รหัสบุคลากร: {p.person_id}
                        </div>
                      </td>
                      <td className="py-3.5 px-4">
                        <div className="font-medium text-[#262238]">{p.position_name || '—'}</div>
                        <div className="text-[12.5px] text-[#746B83] mt-0.5">
                          {p.personnel_type_name}
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-[#262238] font-medium">{p.department_name}</td>
                      <td className="py-3.5 px-4 font-mono tabular-nums">
                        {p.fingle_id ? (
                          <span className="font-bold text-[14px] text-[#543B7A] bg-[#F2EDFA] px-2.5 py-1 rounded-lg border border-[#E6DFF0]">
                            {p.fingle_id}
                          </span>
                        ) : (
                          <span className="text-[#C74455] font-sans text-[13px] font-semibold">
                            ยังไม่ระบุรหัสสแกน
                          </span>
                        )}
                      </td>
                      <td className="py-3.5 px-4">
                        {p.mapping_status === 'VALID' ? (
                          <div className="inline-flex items-center gap-2 text-[#198568] font-semibold">
                            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span>พร้อมใช้งาน (เชื่อมโยงปกติ)</span>
                          </div>
                        ) : (
                          <div>
                            <div className="inline-flex items-center gap-2 text-[#C74455] font-semibold">
                              <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                              <span>
                                {p.mapping_status === 'EMPTY_FINGLE_ID'
                                  ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                                  : p.mapping_status === 'DUPLICATE_FINGLE_ID'
                                    ? 'รหัสสแกนซ้ำซ้อนกัน'
                                    : p.mapping_status}
                              </span>
                            </div>
                            {p.mapping_issue_detail && (
                              <div className="text-[12px] text-[#C74455] pl-6 mt-0.5">
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
          <div className="ent-table-wrapper">
            <div className="px-5 py-4 border-b border-[#E6DFF0] bg-[#F2EDFA] flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[17px] font-bold text-[#262238]">
                  รายการบุคลากรที่พบปัญหาการเชื่อมโยงรหัสสแกน ({issueCount} รายการ)
                </h2>
                <p className="text-[13px] text-[#746B83]">
                  บุคลากรที่ยังไม่ได้ระบุรหัสสแกนลายนิ้วมือ (EMPTY_FINGLE_ID) หรือมีรหัสสแกนซ้ำซ้อนกันในฐานข้อมูล HOSOffice
                </p>
              </div>
              <span className="px-3 py-1 rounded-lg bg-white border border-[#E6DFF0] text-[12.5px] font-semibold text-[#543B7A]">
                ต้องแก้ไขที่ต้นทาง HOSOffice แล้วกดซิงก์ใหม่
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                    <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสบุคลากร</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">ชื่อ-นามสกุล</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">กลุ่มงาน / หน่วยงาน</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสสแกน (FINGLE_ID)</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">สาเหตุที่ตรวจพบ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6DFF0]">
                  {!issuesData?.personnelIssues || issuesData.personnelIssues.length === 0 ? (
                    <TableEmptyState
                      colSpan={5}
                      title="ไม่พบปัญหาการเชื่อมโยงรหัสสแกน บุคลากรทุกคนมีรหัส FINGLE_ID ครบถ้วนและไม่ซ้ำซ้อน"
                    />
                  ) : (
                    issuesData.personnelIssues.map((issue: any) => (
                      <tr key={issue.person_id} className="hover:bg-[#F8F7FC]">
                        <td className="py-3.5 px-5 font-mono font-semibold text-[#262238]">
                          {issue.person_id}
                        </td>
                        <td className="py-3.5 px-5 font-semibold text-[#262238]">{issue.full_name}</td>
                        <td className="py-3.5 px-5 text-[#262238]">{issue.department_name}</td>
                        <td className="py-3.5 px-5 font-mono tabular-nums font-semibold text-[#C74455]">
                          {issue.fingle_id || 'ยังไม่ระบุรหัส'}
                        </td>
                        <td className="py-3.5 px-5">
                          <div className="inline-flex items-center gap-1.5 text-[#C74455] font-semibold">
                            <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span>
                              {issue.mapping_status === 'EMPTY_FINGLE_ID'
                                ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                                : issue.mapping_status === 'DUPLICATE_FINGLE_ID'
                                  ? 'รหัสสแกนซ้ำซ้อนกัน'
                                  : issue.mapping_status}
                            </span>
                          </div>
                          {issue.mapping_issue_detail && (
                            <div className="text-[12.5px] text-[#746B83] mt-0.5">
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

          <div className="ent-table-wrapper">
            <div className="px-5 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC]">
              <h2 className="text-[17px] font-bold text-[#262238]">
                ประวัติการเชื่อมโยงรหัสสแกนตามวันที่มีผลบังคับใช้
              </h2>
              <p className="text-[13px] text-[#746B83]">
                ใช้สำหรับอ้างอิงการคำนวณเวลาย้อนหลังเมื่อบุคลากรมีการเปลี่ยนรหัสสแกนลายนิ้วมือ
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                    <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสบุคลากร</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">ชื่อ-นามสกุล</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">รหัสสแกน (FINGLE_ID)</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">มีผลตั้งแต่วันที่</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">สิ้นสุดวันที่</th>
                    <th className="py-3.5 px-5 font-semibold text-[13px]">สถานะความถูกต้อง</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E6DFF0]">
                  {issuesData?.mappingHistory?.map((m: any) => (
                    <tr key={m.id} className="hover:bg-[#F8F7FC]">
                      <td className="py-3.5 px-5 font-mono font-semibold text-[#262238]">{m.person_id}</td>
                      <td className="py-3.5 px-5 font-semibold text-[#262238]">{m.full_name}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums font-semibold text-[#543B7A]">
                        {m.fingle_id}
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#262238]">
                        {formatThaiDate(m.effective_from)}
                      </td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#746B83]">
                        {m.effective_to ? formatThaiDate(m.effective_to) : 'ใช้งานอยู่ในปัจจุบัน'}
                      </td>
                      <td className="py-3.5 px-5 font-semibold">
                        <span
                          className={
                            m.conflict_state === 'NONE' ? 'text-[#198568]' : 'text-[#C74455]'
                          }
                        >
                          {m.conflict_state === 'NONE' ? 'ปกติ' : m.conflict_state}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ) : (
        <div className="ent-table-wrapper">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                  <th className="py-3.5 px-5 font-semibold text-[13px]">รอบการซิงก์</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">วันและเวลาที่ดำเนินการ</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">สถานะ</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px] text-right">จำนวนที่อ่าน</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px] text-right">อัปเดตสำเร็จ</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">รายละเอียดผลการเชื่อมต่อ</th>
                  <th className="py-3.5 px-5 font-semibold text-[13px]">ผู้ดำเนินการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E6DFF0]">
                {syncLogs.length === 0 ? (
                  <TableEmptyState colSpan={7} title="ยังไม่มีประวัติการสั่งซิงก์ข้อมูลจาก HOSOffice" />
                ) : (
                  syncLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-[#F8F7FC]">
                      <td className="py-3.5 px-5 font-mono tabular-nums font-semibold text-[#262238]">#{log.id}</td>
                      <td className="py-3.5 px-5 font-mono tabular-nums text-[#262238]">{formatThaiDateTime(log.started_at)}</td>
                      <td className="py-3.5 px-5 font-semibold">
                        <span className={log.status === 'SUCCESS' ? 'text-[#198568]' : 'text-[#C74455]'}>
                          {log.status === 'SUCCESS' ? 'สำเร็จ' : 'ไม่สำเร็จ'}
                        </span>
                      </td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums">{log.records_fetched}</td>
                      <td className="py-3.5 px-5 text-right font-mono tabular-nums font-bold text-[#262238]">
                        {log.records_upserted}
                      </td>
                      <td className="py-3.5 px-5 text-[#746B83]">
                        {log.error_code ? `${log.error_code}: ${log.error_message}` : 'ซิงก์ข้อมูลปกติ'}
                      </td>
                      <td className="py-3.5 px-5 font-mono text-[#746B83]">{log.triggered_by}</td>
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
    </div>
  );
}
