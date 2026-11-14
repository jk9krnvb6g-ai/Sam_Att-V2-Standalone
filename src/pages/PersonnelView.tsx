import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { apiRequest, ApiClientError } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
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
        `ซิงก์ข้อมูลจาก HOSOffice สำเร็จ: นำเข้า ${res.recordsUpserted} รายการ · พบประเด็น Mapping ${res.mappingConflictsFound} รายการ`
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
      ? String(valA || '').localeCompare(String(valB || ''))
      : String(valB || '').localeCompare(String(valA || ''));
  });

  const numericSize = pageSize === 'ALL' ? Math.max(1, sortedItems.length) : pageSize;
  const pagedItems = sortedItems.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            รายชื่อบุคลากร HOSOffice (Personnel Roster & FINGLE_ID Mapping)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            ใช้ HOSOffice ตาราง hr_person เป็น Source of Truth แบบ Read-only · ห้ามแก้ไขชื่อหรือ FINGLE_ID ใน Sam_Att โดยตรง
          </p>
        </div>

        <button
          type="button"
          disabled={syncing}
          onClick={handleSyncHosOffice}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 disabled:opacity-50 flex items-center gap-2 whitespace-nowrap w-fit"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} />
          <span>{syncing ? 'กำลังเชื่อมต่อ HOSOffice...' : 'ซิงก์ข้อมูลบุคลากรจาก HOSOffice (Read-Only)'}</span>
        </button>
      </div>

      <ErrorBanner error={error} />
      <NotificationBanner message={syncNotice} onClose={() => setSyncNotice(null)} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-200/70 rounded-lg">
          <button
            type="button"
            onClick={() => setTab('list')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'list' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            ทะเบียนบุคลากร ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setTab('issues')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'issues' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            ตรวจสอบปัญหา Mapping & ประวัติ Effective Date ({issuesData?.personnelIssues?.length || 0})
          </button>
          <button
            type="button"
            onClick={() => setTab('syncHistory')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              tab === 'syncHistory' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
            }`}
          >
            ประวัติการซิงก์ HOSOffice ({syncLogs.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหา PERSON_ID, ชื่อ, FINGLE_ID..."
              className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-64"
            />
          </div>
          <select
            value={mappingStatus}
            onChange={(e) => {
              setMappingStatus(e.target.value);
              setPage(1);
            }}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
          >
            <option value="">ทุกสถานะ Mapping</option>
            <option value="VALID">VALID (ปกติ)</option>
            <option value="EMPTY_FINGLE_ID">EMPTY_FINGLE_ID (ไม่มีรหัสสแกน)</option>
            <option value="DUPLICATE_FINGLE_ID">DUPLICATE_FINGLE_ID (รหัสซ้ำ)</option>
          </select>
        </div>
      </div>

      {loading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-xs text-slate-500">
          กำลังโหลดข้อมูลบุคลากร...
        </div>
      ) : tab === 'list' ? (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <SortableHeader
                    label="PERSON_ID"
                    sortKey="person_id"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="FINGLE_ID"
                    sortKey="fingle_id"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="ชื่อ-นามสกุล (จาก HOSOffice)"
                    sortKey="full_name"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="ตำแหน่ง"
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
                  <th className="py-2.5 px-3 font-semibold">ประเภทบุคลากร</th>
                  <SortableHeader
                    label="สถานะ Mapping"
                    sortKey="mapping_status"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {pagedItems.map((p) => (
                  <tr key={p.person_id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">{p.person_id}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">
                      {p.fingle_id || <span className="text-red-700 font-semibold">ไม่ระบุ (NULL)</span>}
                    </td>
                    <td className="py-2.5 px-3 font-medium text-slate-900">{p.full_name}</td>
                    <td className="py-2.5 px-3 text-slate-600">{p.position_name || '-'}</td>
                    <td className="py-2.5 px-3 text-slate-700">{p.department_name}</td>
                    <td className="py-2.5 px-3 text-slate-600">{p.personnel_type_name}</td>
                    <td className="py-2.5 px-3">
                      <span
                        className={`font-semibold ${
                          p.mapping_status === 'VALID' ? 'text-emerald-700' : 'text-red-700'
                        }`}
                      >
                        {p.mapping_status}
                      </span>
                      {p.mapping_issue_detail && (
                        <div className="text-[11px] text-red-700">{p.mapping_issue_detail}</div>
                      )}
                    </td>
                  </tr>
                ))}
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
          <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60">
              <h3 className="text-sm font-semibold text-slate-900">
                ประวัติการจับคู่ FINGLE_ID ตามวันที่มีผลบังคับใช้ (Effective-Dated Mapping History)
              </h3>
            </div>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="py-2.5 px-3 font-semibold">PERSON_ID</th>
                  <th className="py-2.5 px-3 font-semibold">ชื่อ-นามสกุล</th>
                  <th className="py-2.5 px-3 font-semibold">FINGLE_ID</th>
                  <th className="py-2.5 px-3 font-semibold">มีผลตั้งแต่ (พ.ศ.)</th>
                  <th className="py-2.5 px-3 font-semibold">สิ้นสุด (พ.ศ.)</th>
                  <th className="py-2.5 px-3 font-semibold">สถานะความขัดแย้ง</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {issuesData?.mappingHistory?.map((m: any) => (
                  <tr key={m.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono font-semibold">{m.person_id}</td>
                    <td className="py-2.5 px-3">{m.full_name}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">{m.fingle_id}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">{formatThaiDate(m.effective_from)}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">
                      {m.effective_to ? formatThaiDate(m.effective_to) : 'ปัจจุบัน'}
                    </td>
                    <td className="py-2.5 px-3 font-mono">{m.conflict_state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-semibold">รหัสรอบซิงก์</th>
                <th className="py-2.5 px-3 font-semibold">เวลาทำงาน (พ.ศ.)</th>
                <th className="py-2.5 px-3 font-semibold">สถานะ</th>
                <th className="py-2.5 px-3 font-semibold text-right">ดึงข้อมูล</th>
                <th className="py-2.5 px-3 font-semibold text-right">Upsert</th>
                <th className="py-2.5 px-3 font-semibold">รหัสข้อผิดพลาด / รายละเอียด</th>
                <th className="py-2.5 px-3 font-semibold">ผู้สั่งซิงก์</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {syncLogs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-500">
                    ยังไม่มีประวัติการสั่งซิงก์ HOSOffice
                  </td>
                </tr>
              ) : (
                syncLogs.map((log) => (
                  <tr key={log.id} className="hover:bg-slate-50">
                    <td className="py-2.5 px-3 font-mono tabular-nums">#{log.id}</td>
                    <td className="py-2.5 px-3 font-mono tabular-nums">{formatThaiDateTime(log.started_at)}</td>
                    <td className="py-2.5 px-3 font-semibold">
                      <span className={log.status === 'SUCCESS' ? 'text-emerald-700' : 'text-red-700'}>
                        {log.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{log.records_fetched}</td>
                    <td className="py-2.5 px-3 text-right tabular-nums">{log.records_upserted}</td>
                    <td className="py-2.5 px-3 text-slate-700">
                      {log.error_code ? `${log.error_code}: ${log.error_message}` : 'สำเร็จปกติ'}
                    </td>
                    <td className="py-2.5 px-3 font-mono">{log.triggered_by}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
