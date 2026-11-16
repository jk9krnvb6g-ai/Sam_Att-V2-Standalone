/**
 * ============================================================================
 * หน้าทะเบียนบุคลากร HOSOffice และการตรวจสอบรหัสสแกนนิ้ว (Personnel Roster & Mapping)
 * ไฟล์: frontend/src/pages/PersonnelView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. แสดงรายชื่อบุคลากรที่ซิงก์มาจากตาราง hr_person ของฐานข้อมูล HOSOffice
 * 2. สั่งซิงก์ข้อมูลบุคลากรแบบ Read-Only (POST /api/Sam_Att/personnel/sync)
 * 3. ตรวจสอบและแจ้งเตือนรายการที่มีปัญหาการผูกรหัสลายนิ้วมือ (เช่น ยังไม่มี FINGLE_ID หรือรหัสซ้ำกัน)
 */
import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Search, CheckCircle2, AlertTriangle, Users } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  TableEmptyState,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { formatThaiDate, formatThaiDateTime } from '../utils/thaiFormat.ts';

export function PersonnelView() {
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

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('ASC');
    }
    setPage(1);
  }

  async function handleSyncHosOffice() {
    setSyncing(true);
    setError(null);
    setSyncNotice(null);
    try {
      const res = await apiRequest('/personnel/sync', {
        method: 'POST',
        body: JSON.stringify({ effectiveDate: new Date().toISOString().slice(0, 10) }),
      });
      setSyncNotice(
        `ซิงก์ข้อมูลจากฐานข้อมูล HOSOffice สำเร็จ: อัปเดต ${res.recordsUpserted} รายการ · พบรายการที่ต้องตรวจสอบรหัสสแกน ${res.mappingConflictsFound} รายการ`
      );
      await loadPersonnel();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'การเชื่อมต่อฐานข้อมูล HOSOffice ล้มเหลว' });
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

  return (
    <div className="space-y-6">
      <PageHeader
        category="การบริหารเวลาและบุคลากร"
        title="ทะเบียนบุคลากรและการเชื่อมโยงรหัสสแกน (HOSOffice)"
        subtitle="ดึงข้อมูลบุคลากรแบบอ่านอย่างเดียว (Read-Only) จากตารางบุคลากรหลักของโรงพยาบาล พร้อมตรวจสอบความถูกต้องของรหัสสแกนลายนิ้วมือ (FINGLE_ID)"
        actions={
          <button
            type="button"
            disabled={syncing}
            onClick={handleSyncHosOffice}
            className="ent-btn-primary"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
            <span>
              {syncing ? 'กำลังเชื่อมต่อ HOSOffice...' : 'ซิงก์ข้อมูลบุคลากรจาก HOSOffice'}
            </span>
          </button>
        }
      />

      <ErrorBanner error={error} />
      <NotificationBanner message={syncNotice} onClose={() => setSyncNotice(null)} />

      {/* Summary Directory Strips */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        <div className="ent-card p-5 flex items-center justify-between">
          <div>
            <div className="text-[13.5px] font-medium text-[#596579]">บุคลากรในทะเบียนทั้งหมด</div>
            <div className="mt-1 text-[26px] font-bold text-[#273244] tabular-nums">
              {items.length} คน
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-[#F8F6F7] flex items-center justify-center text-[#596579]">
            <Users className="w-5 h-5" />
          </div>
        </div>

        <div className="ent-card p-5 flex items-center justify-between">
          <div>
            <div className="text-[13.5px] font-medium text-[#596579]">เชื่อมโยงรหัสสแกนสมบูรณ์</div>
            <div className="mt-1 text-[26px] font-bold text-[#047857] tabular-nums">
              {validMappedCount} คน
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-emerald-50 flex items-center justify-center text-[#047857]">
            <CheckCircle2 className="w-5 h-5" />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setTab('issues')}
          className="ent-card p-5 flex items-center justify-between text-left hover:border-[#B45363] transition-colors"
        >
          <div>
            <div className="text-[13.5px] font-medium text-[#596579]">
              พบปัญหาการจับคู่รหัสสแกน (คลิกตรวจสอบ)
            </div>
            <div className="mt-1 text-[26px] font-bold text-[#B91C1C] tabular-nums">
              {issueCount} รายการ
            </div>
          </div>
          <div className="w-11 h-11 rounded-xl bg-red-50 flex items-center justify-center text-[#B91C1C]">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </button>
      </div>

      {/* Filter & View Switcher */}
      <div className="ent-card p-3.5 sm:p-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3.5 sm:gap-4">
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5 p-1 bg-[#F8F6F7] border border-[#E7E2E5] rounded-xl w-full xl:w-auto">
          <button
            type="button"
            onClick={() => setTab('list')}
            className={`px-3.5 py-2 text-[13.5px] font-medium rounded-lg transition-colors text-center whitespace-nowrap ${
              tab === 'list'
                ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
                : 'text-[#596579] hover:text-[#273244]'
            }`}
          >
            รายชื่อบุคลากรทั้งหมด ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('issues')}
            className={`px-3.5 py-2 text-[13.5px] font-medium rounded-lg transition-colors text-center whitespace-nowrap ${
              tab === 'issues'
                ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
                : 'text-[#596579] hover:text-[#273244]'
            }`}
          >
            ตรวจสอบปัญหารหัสสแกน ({issueCount})
          </button>
          <button
            type="button"
            onClick={() => setTab('syncHistory')}
            className={`px-3.5 py-2 text-[13.5px] font-medium rounded-lg transition-colors text-center whitespace-nowrap ${
              tab === 'syncHistory'
                ? 'bg-[#B45363] text-white shadow-2xs font-semibold'
                : 'text-[#596579] hover:text-[#273244]'
            }`}
          >
            ประวัติการซิงก์ HOSOffice ({syncLogs.length})
          </button>
        </div>

        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3 w-full xl:w-auto">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-[#596579] absolute left-3.5 top-3" aria-hidden="true" />
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
            <option value="">ทุกสถานะการจับคู่รหัสสแกน</option>
            <option value="VALID">พร้อมใช้งาน (เชื่อมโยงสมบูรณ์)</option>
            <option value="EMPTY_FINGLE_ID">ยังไม่มีรหัสสแกนลายนิ้วมือ</option>
            <option value="DUPLICATE_FINGLE_ID">รหัสสแกนซ้ำซ้อนกัน</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="ent-card p-12 text-center text-[14.5px] text-[#596579]">
          กำลังโหลดทะเบียนบุคลากร...
        </div>
      ) : tab === 'list' ? (
        <div className="ent-table-wrapper">
          {/* Mobile Card View (< md) */}
          <div className="md:hidden divide-y divide-[#E7E2E5]">
            {pagedItems.length === 0 ? (
              <div className="p-8 text-center text-[14px] text-[#596579]">
                ไม่พบรายชื่อบุคลากรตามเงื่อนไขที่ค้นหา
              </div>
            ) : (
              pagedItems.map((p) => (
                <div key={p.person_id} className="p-4 space-y-2.5 bg-white hover:bg-[#FFF9F9]">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-[15px] text-[#273244]">{p.full_name}</div>
                      <div className="text-[12.5px] font-mono text-[#596579] mt-0.5">
                        รหัสบุคลากร: {p.person_id}
                      </div>
                    </div>
                    {p.fingle_id ? (
                      <span className="font-mono font-bold text-[13.5px] text-[#273244] bg-[#F8F6F7] px-2.5 py-1 rounded-lg border border-[#E7E2E5] shrink-0">
                        สแกน: {p.fingle_id}
                      </span>
                    ) : (
                      <span className="text-[#B91C1C] text-[12.5px] font-semibold bg-red-50 px-2.5 py-1 rounded-lg border border-red-200 shrink-0">
                        ไม่มีรหัสสแกน
                      </span>
                    )}
                  </div>
                  <div className="text-[13.5px] text-[#273244]">
                    {p.position_name || '—'} · <span className="text-[#596579]">{p.department_name}</span>
                  </div>
                  <div className="text-[12.5px] text-[#596579]">{p.personnel_type_name}</div>
                  <div className="pt-1">
                    {p.mapping_status === 'VALID' ? (
                      <div className="inline-flex items-center gap-1.5 text-[13px] text-[#047857] font-semibold">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>พร้อมใช้งาน (เชื่อมโยงปกติ)</span>
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-1.5 text-[13px] text-[#B91C1C] font-semibold">
                        <AlertTriangle className="w-4 h-4 shrink-0" />
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

          {/* Desktop Table View (>= md) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
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
              <tbody className="divide-y divide-[#E7E2E5]">
                {pagedItems.length === 0 ? (
                  <TableEmptyState colSpan={5} title="ไม่พบรายชื่อบุคลากรตามเงื่อนไขที่ค้นหา" />
                ) : (
                  pagedItems.map((p) => (
                    <tr key={p.person_id} className="hover:bg-[#FFF9F9] transition-colors">
                      <td className="py-4 px-4">
                        <div className="font-bold text-[15px] text-[#273244]">{p.full_name}</div>
                        <div className="text-[12.5px] font-mono text-[#596579] mt-0.5">
                          รหัสบุคลากร: {p.person_id}
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="font-medium text-[#273244]">{p.position_name || '—'}</div>
                        <div className="text-[12.5px] text-[#596579] mt-0.5">
                          {p.personnel_type_name}
                        </div>
                      </td>
                      <td className="py-4 px-4 text-[#273244] font-medium">{p.department_name}</td>
                      <td className="py-4 px-4 font-mono tabular-nums">
                        {p.fingle_id ? (
                          <span className="font-bold text-[14.5px] text-[#273244] bg-[#F8F6F7] px-3 py-1 rounded-lg border border-[#E7E2E5]">
                            {p.fingle_id}
                          </span>
                        ) : (
                          <span className="text-[#B91C1C] font-sans text-[13.5px] font-semibold">
                            ยังไม่ระบุรหัสสแกน
                          </span>
                        )}
                      </td>
                      <td className="py-4 px-4">
                        {p.mapping_status === 'VALID' ? (
                          <div className="inline-flex items-center gap-2 text-[#047857] font-semibold">
                            <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                            <span>พร้อมใช้งาน (เชื่อมโยงปกติ)</span>
                          </div>
                        ) : (
                          <div>
                            <div className="inline-flex items-center gap-2 text-[#B91C1C] font-semibold">
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
                              <div className="text-[12.5px] text-[#B91C1C] pl-6 mt-0.5">
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
            <div className="px-6 py-4 border-b border-[#E7E2E5] bg-[#FFF1F3] flex items-center justify-between">
              <div>
                <h2 className="text-[18px] font-bold text-[#273244]">
                  รายการบุคลากรที่พบปัญหาการเชื่อมโยงรหัสสแกน ({issueCount} รายการ)
                </h2>
                <p className="text-[13.5px] text-[#596579]">
                  บุคลากรที่ยังไม่ได้ระบุรหัสสแกนลายนิ้วมือ (EMPTY_FINGLE_ID) หรือมีรหัสสแกนซ้ำซ้อนกันในฐานข้อมูล HOSOffice
                </p>
              </div>
              <span className="px-3 py-1 rounded-lg bg-white border border-[#F9E8EB] text-[13px] font-semibold text-[#9F3F50]">
                ต้องแก้ไขที่ต้นทาง HOSOffice แล้วกดซิงก์ใหม่
              </span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                    <th className="py-3.5 px-5 font-semibold">รหัสบุคลากร</th>
                    <th className="py-3.5 px-5 font-semibold">ชื่อ-นามสกุล</th>
                    <th className="py-3.5 px-5 font-semibold">กลุ่มงาน / หน่วยงาน</th>
                    <th className="py-3.5 px-5 font-semibold">รหัสสแกน (FINGLE_ID)</th>
                    <th className="py-3.5 px-5 font-semibold">สาเหตุที่ตรวจพบ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E2E5]">
                  {!issuesData?.personnelIssues || issuesData.personnelIssues.length === 0 ? (
                    <TableEmptyState
                      colSpan={5}
                      title="ไม่พบปัญหาการเชื่อมโยงรหัสสแกน บุคลากรทุกคนมีรหัส FINGLE_ID ครบถ้วนและไม่ซ้ำซ้อน"
                    />
                  ) : (
                    issuesData.personnelIssues.map((issue: any) => (
                      <tr key={issue.person_id} className="hover:bg-[#FFF9F9]">
                        <td className="py-4 px-5 font-mono font-semibold text-[#273244]">
                          {issue.person_id}
                        </td>
                        <td className="py-4 px-5 font-bold text-[#273244]">{issue.full_name}</td>
                        <td className="py-4 px-5 text-[#273244]">{issue.department_name}</td>
                        <td className="py-4 px-5 font-mono tabular-nums font-semibold text-[#B91C1C]">
                          {issue.fingle_id || 'ยังไม่ระบุรหัส'}
                        </td>
                        <td className="py-4 px-5">
                          <div className="inline-flex items-center gap-1.5 text-[#B91C1C] font-semibold">
                            <AlertTriangle className="w-4 h-4 shrink-0" />
                            <span>
                              {issue.mapping_status === 'EMPTY_FINGLE_ID'
                                ? 'ไม่มีรหัสสแกนลายนิ้วมือ'
                                : issue.mapping_status === 'DUPLICATE_FINGLE_ID'
                                ? 'รหัสสแกนซ้ำซ้อนกัน'
                                : issue.mapping_status}
                            </span>
                          </div>
                          {issue.mapping_issue_detail && (
                            <div className="text-[12.5px] text-[#596579] mt-0.5">
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
            <div className="px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7]">
              <h2 className="text-[18px] font-bold text-[#273244]">
                ประวัติการเชื่อมโยงรหัสสแกนตามวันที่มีผลบังคับใช้
              </h2>
              <p className="text-[13.5px] text-[#596579]">
                ใช้สำหรับอ้างอิงการคำนวณเวลาย้อนหลังเมื่อบุคลากรมีการเปลี่ยนรหัสสแกนลายนิ้วมือ
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                    <th className="py-3.5 px-5 font-semibold">รหัสบุคลากร</th>
                    <th className="py-3.5 px-5 font-semibold">ชื่อ-นามสกุล</th>
                    <th className="py-3.5 px-5 font-semibold">รหัสสแกน (FINGLE_ID)</th>
                    <th className="py-3.5 px-5 font-semibold">มีผลตั้งแต่วันที่</th>
                    <th className="py-3.5 px-5 font-semibold">สิ้นสุดวันที่</th>
                    <th className="py-3.5 px-5 font-semibold">สถานะความถูกต้อง</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E2E5]">
                  {issuesData?.mappingHistory?.map((m: any) => (
                    <tr key={m.id} className="hover:bg-[#FFF9F9]">
                      <td className="py-4 px-5 font-mono font-semibold text-[#273244]">{m.person_id}</td>
                      <td className="py-4 px-5 font-bold text-[#273244]">{m.full_name}</td>
                      <td className="py-4 px-5 font-mono tabular-nums font-semibold text-[#9F3F50]">
                        {m.fingle_id}
                      </td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#273244]">
                        {formatThaiDate(m.effective_from)}
                      </td>
                      <td className="py-4 px-5 font-mono tabular-nums text-[#596579]">
                        {m.effective_to ? formatThaiDate(m.effective_to) : 'ใช้งานอยู่ในปัจจุบัน'}
                      </td>
                      <td className="py-4 px-5 font-semibold">
                        <span
                          className={
                            m.conflict_state === 'NONE' ? 'text-[#047857]' : 'text-[#B91C1C]'
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
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">รอบการซิงก์</th>
                  <th className="py-3.5 px-5 font-semibold">วันและเวลาที่ดำเนินการ</th>
                  <th className="py-3.5 px-5 font-semibold">สถานะ</th>
                  <th className="py-3.5 px-5 font-semibold text-right">จำนวนที่อ่าน</th>
                  <th className="py-3.5 px-5 font-semibold text-right">อัปเดตสำเร็จ</th>
                  <th className="py-3.5 px-5 font-semibold">รายละเอียดผลการเชื่อมต่อ</th>
                  <th className="py-3.5 px-5 font-semibold">ผู้ดำเนินการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {syncLogs.length === 0 ? (
                  <TableEmptyState colSpan={7} title="ยังไม่มีประวัติการสั่งซิงก์ข้อมูลจาก HOSOffice" />
                ) : (
                  syncLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-[#FFF9F9]">
                      <td className="py-4 px-5 font-mono tabular-nums font-semibold">#{log.id}</td>
                      <td className="py-4 px-5 font-mono tabular-nums">{formatThaiDateTime(log.started_at)}</td>
                      <td className="py-4 px-5 font-semibold">
                        <span className={log.status === 'SUCCESS' ? 'text-[#047857]' : 'text-[#B91C1C]'}>
                          {log.status === 'SUCCESS' ? 'สำเร็จ' : 'ไม่สำเร็จ'}
                        </span>
                      </td>
                      <td className="py-4 px-5 text-right font-mono tabular-nums">{log.records_fetched}</td>
                      <td className="py-4 px-5 text-right font-mono tabular-nums font-bold">
                        {log.records_upserted}
                      </td>
                      <td className="py-4 px-5 text-[#596579]">
                        {log.error_code ? `${log.error_code}: ${log.error_message}` : 'ซิงก์ข้อมูลปกติ'}
                      </td>
                      <td className="py-4 px-5 font-mono text-[#596579]">{log.triggered_by}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
