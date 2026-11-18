/**
 * ============================================================================
 * หน้าจัดการเครื่องสแกนและตรวจสอบข้อมูลสแกนต้นฉบับ 6 ฟิลด์ (Scanners & Immutable Raw Scans)
 * ไฟล์: frontend/src/pages/RawScansView.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. โหมด 'scanners': แสดงสถานะเครื่องสแกนนิ้ว, ตั้งเวลาดึงข้อมูลอัตโนมัติ (Sync Schedules),
 *    สั่งดึงข้อมูลจาก ScannerReader.exe ทันที และนำเข้า JSON 6 ฟิลด์ตามสัญญา
 * 2. โหมด 'rawScans': แสดงข้อมูลสแกนลายนิ้วมือต้นฉบับแบบห้ามแก้ไข/ลบ (Immutable)
 *    พร้อมแผงตรวจสอบ JSON 6 ฟิลด์ต้นฉบับและค่า SHA-256 Event Key
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
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { formatThaiDateTime, getCurrentBangkokDateParts } from '../utils/thaiFormat.ts';

export function RawScansView({
  mode,
  user,
}: {
  mode: 'rawScans' | 'scanners';
  user: AuthUser;
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

  // 6-Field EXE Contract Payload Ingestion Test Harness
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

  const [syncingHardware, setSyncingHardware] = useState(false);

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

  async function handleTriggerHardwareSync() {
    setError(null);
    setNotice(null);
    setSyncingHardware(true);
    try {
      const res = await apiRequest('/scanners/sync', {
        method: 'POST',
        body: JSON.stringify({}),
      });
      setNotice(
        `ดึงข้อมูลจากโปรแกรม ScannerSyncCli.exe สำเร็จ: อ่าน ${res.totalRead} รายการ · เพิ่มใหม่ ${res.newInserted} · ข้ามรายการซ้ำ ${res.duplicatesSkipped}`
      );
      await loadData(false);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else if (err instanceof Error) {
        setError({ message: err.message });
      }
      await loadData(false);
    } finally {
      setSyncingHardware(false);
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
          <button
            type="button"
            disabled={syncingHardware}
            onClick={handleTriggerHardwareSync}
            className="ent-btn-primary disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${syncingHardware ? 'animate-spin' : ''}`} />
            <span>{syncingHardware ? 'กำลังดึงข้อมูลจากเครื่องสแกน...' : 'สั่งดึงข้อมูลจากเครื่องสแกนทันที'}</span>
          </button>
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
                      <div className="font-mono text-[13px] font-bold text-[#9F3F50]">
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
                          : 'bg-[#F8F6F7] text-[#596579]'
                      }`}
                    >
                      <Radio className="w-5 h-5" />
                    </div>
                  </div>

                  <div className="pt-3 border-t border-[#E7E2E5] space-y-1.5 text-[13.5px]">
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
                          className="px-3 py-1.5 text-[13px] font-semibold border border-[#D5CDD2] rounded-lg bg-white hover:bg-[#F8F6F7] text-[#273244]"
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

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* 6-Field Contract JSON Ingestion Form */}
            <form onSubmit={handleIngestContractJson} className="ent-card p-6 space-y-4">
              <div className="border-b border-[#E7E2E5] pb-3 flex items-center justify-between">
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
                className="w-full p-3.5 text-[13.5px] font-mono border border-[#D5CDD2] rounded-xl bg-[#F8F6F7] text-[#273244]"
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
                  <div className="border-b border-[#E7E2E5] pb-2.5">
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
                    <Plus className="w-4 h-4 text-[#B45363]" />
                    <span>เพิ่มเครื่องสแกนเข้าสู่ระบบ</span>
                  </button>
                </form>
              )}

              {/* Sync Schedules Card */}
              <div className="ent-table-wrapper">
                <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7] flex items-center justify-between">
                  <h2 className="text-[17px] font-bold text-[#273244]">
                    ตารางเวลาดึงข้อมูลอัตโนมัติ ({scannerData?.schedules?.length || 0} รอบ/วัน)
                  </h2>
                </div>

                {user.role === 'ADMIN' && (
                  <form
                    onSubmit={handleAddSchedule}
                    className="p-4 border-b border-[#E7E2E5] bg-[#FFF9F9] flex flex-col sm:flex-row sm:flex-wrap items-stretch sm:items-center gap-2.5"
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
                      <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                        <th className="py-3 px-4 sm:px-5 font-semibold">เวลาทำงาน</th>
                        <th className="py-3 px-4 sm:px-5 font-semibold">ชื่อรอบการซิงก์</th>
                        <th className="py-3 px-4 sm:px-5 font-semibold text-right">สถานะ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#E7E2E5]">
                      {scannerData?.schedules?.map((s: any) => (
                        <tr key={s.id} className="hover:bg-[#FFF9F9]">
                          <td className="py-3.5 px-4 sm:px-5 font-mono font-bold text-[#9F3F50]">
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
                                    : 'text-[#596579] border-[#D5CDD2] bg-white'
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

          {/* Sync Runs History Table */}
          <div className="ent-table-wrapper">
            <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7]">
              <h2 className="text-[18px] font-bold text-[#273244]">
                ประวัติการดึงข้อมูลจากเครื่องสแกน
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                    <th className="py-3.5 px-5 font-semibold">รหัสรอบ · วันและเวลา</th>
                    <th className="py-3.5 px-5 font-semibold">ช่องทางการดึงข้อมูล</th>
                    <th className="py-3.5 px-5 font-semibold">สถานะ</th>
                    <th className="py-3.5 px-5 font-semibold text-right">อ่านทั้งหมด</th>
                    <th className="py-3.5 px-5 font-semibold text-right">บันทึกใหม่</th>
                    <th className="py-3.5 px-5 font-semibold text-right">ข้ามรายการซ้ำ</th>
                    <th className="py-3.5 px-5 font-semibold">หมายเหตุ / ข้อผิดพลาด</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#E7E2E5]">
                  {scannerData?.syncRuns?.map((r: any) => (
                    <tr key={r.id} className="hover:bg-[#FFF9F9]">
                      <td className="py-4 px-5 font-mono tabular-nums text-[#273244]">
                        #{r.id} · {formatThaiDateTime(r.started_at)}
                      </td>
                      <td className="py-4 px-5 font-mono text-[#596579]">{r.trigger_mode}</td>
                      <td className="py-4 px-5 font-semibold">
                        <span className={r.status === 'SUCCESS' ? 'text-[#047857]' : 'text-[#B91C1C]'}>
                          {r.status === 'SUCCESS' ? 'สำเร็จ' : 'ขัดข้อง'}
                        </span>
                      </td>
                      <td className="py-4 px-5 text-right font-mono tabular-nums">{r.total_events_read}</td>
                      <td className="py-4 px-5 text-right font-mono tabular-nums font-bold text-[#047857]">
                        {r.new_scans_inserted}
                      </td>
                      <td className="py-4 px-5 text-right font-mono tabular-nums text-[#596579]">
                        {r.duplicate_scans_skipped}
                      </td>
                      <td className="py-4 px-5 text-[#596579]">
                        {r.error_code ? `${r.error_code}: ${r.error_message}` : 'ทำงานปกติ'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
                className="w-4 h-4 rounded-xs border-[#D5CDD2] accent-[#B45363]"
              />
              <span>แสดงเฉพาะผู้ที่สแกนมากกว่า 1 ครั้งในวันเดียวกัน</span>
            </label>
          </div>

          <div className="ent-table-wrapper">
            {/* Mobile Card List View (< 768px) */}
            <div className="md:hidden divide-y divide-[#E7E2E5]">
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
                      <span className="font-mono font-bold text-[13.5px] text-[#9F3F50] bg-[#FFF1F3] px-2.5 py-1 rounded-md border border-[#F9E8EB]">
                        {rs.enroll_number}
                      </span>
                    </div>

                    <div className="p-3 rounded-lg bg-[#FFF9F9] border border-[#E7E2E5] text-[13.5px] space-y-1.5">
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
                    </div>

                    <button
                      type="button"
                      onClick={() => setSelectedScanModal(rs)}
                      className="w-full h-10 px-3.5 text-[13.5px] bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center justify-center gap-1.5 font-semibold text-[#273244] transition-colors"
                    >
                      <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
                      <span>เปิดดูข้อมูล JSON 6 ฟิลด์ต้นฉบับ</span>
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table View (>= 768px) */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left border-collapse text-[14px]">
                <thead>
                  <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
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
                <tbody className="divide-y divide-[#E7E2E5]">
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
                      <tr key={rs.id} className="hover:bg-[#FFF9F9] transition-colors">
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
                          <span className="font-bold text-[#9F3F50] bg-[#FFF1F3] px-2.5 py-1 rounded-md border border-[#F9E8EB]">
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
                            className="h-9 px-3.5 text-[13.5px] bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-[#273244] transition-colors"
                          >
                            <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 bg-[#FFF9F9] p-4 rounded-xl border border-[#E7E2E5]">
              <div>
                <div className="text-[13px] text-[#596579]">รหัสลายนิ้วมือ (enrollNumber)</div>
                <div className="font-mono font-bold text-[16px] text-[#9F3F50] mt-0.5">
                  {selectedScanModal.enroll_number}
                </div>
              </div>
              <div>
                <div className="text-[13px] text-[#596579]">เวลาสแกนมาตรฐาน (Asia/Bangkok)</div>
                <div className="font-mono font-semibold text-[15px] text-[#273244] mt-0.5">
                  {selectedScanModal.canonical_bkk_time}
                </div>
              </div>
              <div className="sm:col-span-2 pt-2 border-t border-[#E7E2E5]">
                <div className="text-[13px] text-[#596579]">บุคลากรที่เชื่อมโยง</div>
                <div className="font-bold text-[#273244] mt-0.5">
                  {selectedScanModal.matched_person_id
                    ? `${selectedScanModal.full_name} (${selectedScanModal.matched_person_id})`
                    : `ยังไม่เชื่อมโยงบุคลากร (${selectedScanModal.mapping_state})`}
                </div>
              </div>
              <div className="sm:col-span-2 pt-2 border-t border-[#E7E2E5]">
                <div className="text-[13px] text-[#596579]">รหัสป้องกันข้อมูลซ้ำ (SHA-256 Event Key)</div>
                <div className="font-mono text-[12px] text-[#596579] break-all mt-0.5">
                  {selectedScanModal.event_dedup_key}
                </div>
              </div>
            </div>

            <div>
              <div className="font-bold text-[#273244] mb-2">
                ข้อมูล 6 ฟิลด์ต้นฉบับจากโปรแกรม ScannerReader.exe:
              </div>
              <pre className="p-4 bg-[#273244] text-white rounded-xl font-mono text-[13px] overflow-x-auto">
                {JSON.stringify(JSON.parse(selectedScanModal.raw_payload_json || '{}'), null, 2)}
              </pre>
            </div>
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
