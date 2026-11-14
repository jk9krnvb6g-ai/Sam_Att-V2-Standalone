import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { RefreshCw, Upload, Plus, Eye } from 'lucide-react';
import { apiRequest, ApiClientError, type AuthUser } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  SharedModal,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { formatThaiDateTime } from '../utils/thaiFormat.ts';

export function RawScansView({
  mode,
  user,
}: {
  mode: 'rawScans' | 'scanners';
  user: AuthUser;
}) {
  const [rawScans, setRawScans] = useState<any[]>([]);
  const [scannerData, setScannerData] = useState<any>(null);
  const [search, setSearch] = useState('');
  const [machineFilter, setMachineFilter] = useState('');
  const [mappingState, setMappingState] = useState('');
  const [onlyMultiScan, setOnlyMultiScan] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Sorting & Pagination for Raw Scans
  const [sortKey, setSortKey] = useState('canonical_bkk_time');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  // Raw Scan Payload Modal
  const [selectedScanModal, setSelectedScanModal] = useState<any | null>(null);

  // New Scanner Device form (ADMIN only)
  const [machineNo, setMachineNo] = useState(104);
  const [deviceName, setDeviceName] = useState('');
  const [ipAddress, setIpAddress] = useState('192.168.10.104');
  const [locationName, setLocationName] = useState('');

  // New Schedule form (ADMIN only)
  const [scheduleLabel, setScheduleLabel] = useState('');
  const [cronTime, setCronTime] = useState('12:30');

  // 6-Field EXE Contract Payload Ingestion Test Harness
  const [jsonPayloadText, setJsonPayloadText] = useState(
    JSON.stringify(
      [
        {
          machineNo: 101,
          enrollNumber: '1001',
          scanDateTime: '2026-11-13 07:48:00',
          verifyMode: 1,
          inOutMode: 0,
          workCode: 0,
        },
        {
          machineNo: 101,
          enrollNumber: '1001',
          scanDateTime: '2026-11-13 16:04:00',
          verifyMode: 1,
          inOutMode: 1,
          workCode: 0,
        },
      ],
      null,
      2
    )
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
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
      list = list.filter((s) => (counts.get(`${s.enroll_number}:${s.canonical_bkk_time.slice(0, 10)}`) || 0) > 1);
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

  async function handleTriggerHardwareSync() {
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest('/scanners/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(
        `ซิงก์จาก ScannerReader.exe สำเร็จ: อ่าน ${res.totalRead} รายการ · เพิ่มใหม่ ${res.newInserted} · ข้ามรายการซ้ำ ${res.duplicatesSkipped}`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
      await loadData();
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
        `นำเข้า 6-Field JSON ตามสัญญา EXE สำเร็จ: อ่าน ${res.totalRead} รายการ · เพิ่มใหม่ ${res.newInserted} · ปฏิเสธรายการซ้ำ (Deduplicated) ${res.duplicatesSkipped} รายการ`
      );
      await loadData();
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
      setNotice(`ลงทะเบียนเครื่องสแกนหมายเลข #${machineNo} สำเร็จ`);
      await loadData();
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
      await loadData();
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
      setNotice(`เพิ่มตารางเวลาซิงก์อัตโนมัติ (${cronTime} น.) สำเร็จ`);
      await loadData();
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
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            {mode === 'rawScans'
              ? 'ข้อมูลสแกนดิบและรอบการ Sync (Raw Scans & 6-Field EXE Contract)'
              : 'เครื่องสแกนและการดึงข้อมูล (Scanner Devices & Sync Schedules)'}
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            ใช้สัญญา 6 ฟิลด์จาก ScannerReader.exe เดิม (machineNo, enrollNumber, scanDateTime, verifyMode, inOutMode, workCode) · ห้ามแก้ไขหรือลบ Raw Scan
          </p>
        </div>

        <button
          type="button"
          onClick={handleTriggerHardwareSync}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 flex items-center gap-2 whitespace-nowrap w-fit"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span>สั่งซิงก์ผ่าน ScannerReader.exe (Sync Now)</span>
        </button>
      </div>

      <ErrorBanner error={error} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {mode === 'scanners' ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* EXE Contract & Ingestion Harness */}
            <form
              onSubmit={handleIngestContractJson}
              className="bg-white border border-slate-200 rounded-lg p-4 space-y-3"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-900">
                  นำเข้า JSON 6 ฟิลด์ตามสัญญา ScannerReader.exe (Contract Ingestion)
                </h3>
                <span className="text-[11px] font-mono text-slate-500">SHA-256 Deduplication</span>
              </div>
              <textarea
                rows={7}
                value={jsonPayloadText}
                onChange={(e) => setJsonPayloadText(e.target.value)}
                className="w-full p-2.5 text-xs font-mono border border-slate-300 rounded-lg bg-slate-50"
              />
              <button
                type="submit"
                className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>ส่งข้อมูลเข้า Endpoint /api/Sam_Att/scanners/ingest</span>
              </button>
            </form>

            {/* Add Scanner Device & Schedule (ADMIN only) */}
            {user.role === 'ADMIN' && (
              <div className="space-y-4">
                <form
                  onSubmit={handleAddScanner}
                  className="bg-white border border-slate-200 rounded-lg p-4 space-y-3"
                >
                  <h3 className="text-sm font-semibold text-slate-900">
                    ลงทะเบียนเครื่องสแกนใหม่ (เฉพาะ ADMIN)
                  </h3>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">หมายเลขเครื่อง (machineNo)</label>
                      <input
                        type="number"
                        required
                        value={machineNo}
                        onChange={(e) => setMachineNo(Number(e.target.value))}
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">IP Address</label>
                      <input
                        type="text"
                        required
                        value={ipAddress}
                        onChange={(e) => setIpAddress(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">ชื่อเครื่องสแกน</label>
                      <input
                        type="text"
                        required
                        value={deviceName}
                        onChange={(e) => setDeviceName(e.target.value)}
                        placeholder="เช่น เครื่องสแกนตึกสงฆ์อาพาธ"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-600 mb-1">สถานที่ติดตั้ง</label>
                      <input
                        type="text"
                        required
                        value={locationName}
                        onChange={(e) => setLocationName(e.target.value)}
                        placeholder="เช่น ชั้น 1 หน้าลิฟต์"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                      />
                    </div>
                  </div>
                  <button
                    type="submit"
                    className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>เพิ่มเครื่องสแกน</span>
                  </button>
                </form>

                <form
                  onSubmit={handleAddSchedule}
                  className="bg-white border border-slate-200 rounded-lg p-4 space-y-3"
                >
                  <h3 className="text-sm font-semibold text-slate-900">
                    กำหนดเวลาซิงก์อัตโนมัติ (Sync Schedules)
                  </h3>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      type="text"
                      required
                      value={scheduleLabel}
                      onChange={(e) => setScheduleLabel(e.target.value)}
                      placeholder="เช่น ซิงก์รอบเที่ยงวัน"
                      className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
                    />
                    <input
                      type="time"
                      required
                      value={cronTime}
                      onChange={(e) => setCronTime(e.target.value)}
                      className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
                    />
                    <button
                      type="submit"
                      className="px-3 py-1.5 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800 whitespace-nowrap"
                    >
                      เพิ่มรอบซิงก์
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">
                  ทะเบียนเครื่องสแกนทั้งหมด ({scannerData?.devices?.length || 0})
                </h3>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2.5 px-3 font-medium">Machine No</th>
                    <th className="py-2.5 px-3 font-medium">ชื่อเครื่อง · สถานที่</th>
                    <th className="py-2.5 px-3 font-medium">IP : Port</th>
                    <th className="py-2.5 px-3 font-medium">สถานะเปิดใช้งาน</th>
                    <th className="py-2.5 px-3 font-medium">ซิงก์สำเร็จล่าสุด</th>
                    {user.role === 'ADMIN' && <th className="py-2.5 px-3 font-medium text-right">สลับสถานะ</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {scannerData?.devices?.map((d: any) => (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono font-bold">#{d.machine_no}</td>
                      <td className="py-2.5 px-3">
                        <div className="font-medium text-slate-900">{d.device_name}</div>
                        <div className="text-[11px] text-slate-500">{d.location_name}</div>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums">
                        {d.ip_address}:{d.device_port}
                      </td>
                      <td className="py-2.5 px-3 font-semibold">
                        <span className={Number(d.is_enabled) === 1 ? 'text-emerald-700' : 'text-slate-500'}>
                          {Number(d.is_enabled) === 1 ? 'ENABLED (เปิดใช้งาน)' : 'DISABLED (ปิด)'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono tabular-nums text-slate-600">
                        {d.last_success_at ? formatThaiDateTime(d.last_success_at) : d.last_sync_status}
                      </td>
                      {user.role === 'ADMIN' && (
                        <td className="py-2.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => handleToggleScanner(d.id, Number(d.is_enabled))}
                            className="px-2.5 py-1 text-xs border border-slate-300 rounded hover:bg-slate-100"
                          >
                            {Number(d.is_enabled) === 1 ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-200">
                <h3 className="text-sm font-semibold text-slate-900">
                  ตารางกำหนดเวลาซิงก์ ({scannerData?.schedules?.length || 0})
                </h3>
              </div>
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <th className="py-2 px-3 font-medium">เวลา</th>
                    <th className="py-2 px-3 font-medium">รายละเอียด</th>
                    <th className="py-2 px-3 font-medium text-right">สถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {scannerData?.schedules?.map((s: any) => (
                    <tr key={s.id}>
                      <td className="py-2 px-3 font-mono font-bold text-teal-900">{s.cron_time} น.</td>
                      <td className="py-2 px-3">{s.schedule_label}</td>
                      <td className="py-2 px-3 text-right">
                        {user.role === 'ADMIN' ? (
                          <button
                            type="button"
                            onClick={() => handleToggleSchedule(s.id, Number(s.is_enabled))}
                            className={`text-xs font-semibold ${
                              Number(s.is_enabled) === 1 ? 'text-emerald-700' : 'text-slate-400'
                            }`}
                          >
                            {Number(s.is_enabled) === 1 ? 'เปิด' : 'ปิด'}
                          </button>
                        ) : (
                          <span>{Number(s.is_enabled) === 1 ? 'เปิด' : 'ปิด'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200">
              <h3 className="text-sm font-semibold text-slate-900">
                ประวัติการซิงก์เครื่องสแกน (sync_runs)
              </h3>
            </div>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <th className="py-2 px-3 font-medium">Run ID · เวลา</th>
                  <th className="py-2 px-3 font-medium">โหมด</th>
                  <th className="py-2 px-3 font-medium">สถานะ</th>
                  <th className="py-2 px-3 font-medium text-right">อ่านทั้งหมด</th>
                  <th className="py-2 px-3 font-medium text-right">เพิ่มใหม่</th>
                  <th className="py-2 px-3 font-medium text-right">ซ้ำ (Skipped)</th>
                  <th className="py-2 px-3 font-medium">รายละเอียด / Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {scannerData?.syncRuns?.map((r: any) => (
                  <tr key={r.id}>
                    <td className="py-2 px-3 font-mono tabular-nums">
                      #{r.id} · {formatThaiDateTime(r.started_at)}
                    </td>
                    <td className="py-2 px-3 font-mono">{r.trigger_mode}</td>
                    <td className="py-2 px-3 font-semibold">
                      <span className={r.status === 'SUCCESS' ? 'text-emerald-700' : 'text-red-700'}>
                        {r.status}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.total_events_read}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-semibold text-teal-800">
                      {r.new_scans_inserted}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums">{r.duplicate_scans_skipped}</td>
                    <td className="py-2 px-3 text-slate-600">
                      {r.error_code ? `${r.error_code}: ${r.error_message}` : 'ปกติ'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="ค้นหา enrollNumber, PERSON_ID หรือชื่อ..."
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-64"
              />
              <select
                value={machineFilter}
                onChange={(e) => {
                  setMachineFilter(e.target.value);
                  setPage(1);
                }}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">ทุกหมายเลขเครื่องสแกน</option>
                <option value="101">เครื่อง #101 (อาคาร OPD)</option>
                <option value="102">เครื่อง #102 (อาคาร ER)</option>
                <option value="103">เครื่อง #103 (อาคารผู้ป่วยใน/บริหาร)</option>
              </select>
              <select
                value={mappingState}
                onChange={(e) => {
                  setMappingState(e.target.value);
                  setPage(1);
                }}
                className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">ทุกสถานะการจับคู่</option>
                <option value="MATCHED">MATCHED (จับคู่สำเร็จ)</option>
                <option value="UNMATCHED">UNMATCHED (ไม่พบ FINGLE_ID)</option>
                <option value="CONFLICT">CONFLICT (รหัสซ้ำ)</option>
              </select>
            </div>

            <label className="inline-flex items-center gap-2 text-xs text-slate-700 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyMultiScan}
                onChange={(e) => {
                  setOnlyMultiScan(e.target.checked);
                  setPage(1);
                }}
                className="rounded border-slate-300 text-teal-800"
              />
              <span>เฉพาะผู้ที่สแกนมากกว่า 1 ครั้งในวันเดียวกัน</span>
            </label>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                    <SortableHeader
                      label="ID"
                      sortKey="id"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="เวลาสแกน (พ.ศ. · Asia/Bangkok)"
                      sortKey="canonical_bkk_time"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="เครื่อง (machineNo)"
                      sortKey="machine_no"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <SortableHeader
                      label="enrollNumber"
                      sortKey="enroll_number"
                      activeSortKey={sortKey}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                    <th className="py-2.5 px-3 font-medium">inOutMode / verifyMode</th>
                    <th className="py-2.5 px-3 font-medium">บุคลากรที่จับคู่ได้</th>
                    <th className="py-2.5 px-3 font-medium text-right">ดู 6-Field JSON</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {loading ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        กำลังโหลดข้อมูล Raw Scans...
                      </td>
                    </tr>
                  ) : pagedScans.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-8 text-center text-slate-500">
                        ไม่พบข้อมูลสแกนต้นฉบับตามตัวกรองที่เลือก
                      </td>
                    </tr>
                  ) : (
                    pagedScans.map((rs) => (
                      <tr key={rs.id} className="hover:bg-slate-50">
                        <td className="py-2.5 px-3 font-mono tabular-nums">#{rs.id}</td>
                        <td className="py-2.5 px-3">
                          <div className="font-medium text-slate-900">
                            {formatThaiDateTime(rs.canonical_bkk_time)}
                          </div>
                          <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                            {rs.canonical_bkk_time}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums">#{rs.machine_no}</td>
                        <td className="py-2.5 px-3 font-mono tabular-nums font-semibold">
                          {rs.enroll_number}
                        </td>
                        <td className="py-2.5 px-3 font-mono tabular-nums">
                          inOut={rs.in_out_mode} · verify={rs.verify_mode} · work={rs.work_code}
                        </td>
                        <td className="py-2.5 px-3">
                          {rs.matched_person_id ? (
                            <span>
                              <span className="font-mono font-semibold text-emerald-700">
                                {rs.matched_person_id}
                              </span>{' '}
                              · {rs.full_name}
                            </span>
                          ) : (
                            <span className="text-red-700 font-semibold">{rs.mapping_state}</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedScanModal(rs)}
                            className="px-2.5 py-1 text-xs bg-slate-100 border border-slate-300 rounded hover:bg-slate-200 inline-flex items-center gap-1 whitespace-nowrap"
                          >
                            <Eye className="w-3 h-3" />
                            <span>JSON ต้นฉบับ</span>
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

      {/* Raw Scan 6-Field Contract Inspector Modal */}
      <SharedModal
        open={Boolean(selectedScanModal)}
        onClose={() => setSelectedScanModal(null)}
        kickerText="ข้อมูลสแกนต้นฉบับแบบ Immutable (6-Field ScannerReader.exe Contract)"
        title={
          selectedScanModal
            ? `Raw Scan ID #${selectedScanModal.id} · เครื่อง #${selectedScanModal.machine_no}`
            : ''
        }
        subtitle={
          selectedScanModal
            ? `SHA-256 Event Dedup Key: ${selectedScanModal.event_dedup_key}`
            : ''
        }
      >
        {selectedScanModal && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200">
              <div>
                <div className="text-slate-500">enrollNumber (FINGLE_ID)</div>
                <div className="font-mono font-bold text-slate-900 mt-0.5">
                  {selectedScanModal.enroll_number}
                </div>
              </div>
              <div>
                <div className="text-slate-500">เวลาสแกน (Asia/Bangkok)</div>
                <div className="font-mono font-semibold text-slate-900 mt-0.5">
                  {selectedScanModal.canonical_bkk_time}
                </div>
              </div>
              <div>
                <div className="text-slate-500">บุคลากรที่จับคู่</div>
                <div className="font-semibold text-teal-800 mt-0.5">
                  {selectedScanModal.matched_person_id
                    ? `${selectedScanModal.matched_person_id} · ${selectedScanModal.full_name}`
                    : selectedScanModal.mapping_state}
                </div>
              </div>
            </div>

            <div>
              <div className="font-semibold text-slate-900 mb-1">
                Original 6-Field JSON Payload (`raw_payload_json`):
              </div>
              <pre className="p-3 bg-slate-900 text-slate-100 rounded-lg font-mono text-xs overflow-x-auto">
                {JSON.stringify(JSON.parse(selectedScanModal.raw_payload_json || '{}'), null, 2)}
              </pre>
            </div>
          </div>
        )}
      </SharedModal>
    </div>
  );
}
