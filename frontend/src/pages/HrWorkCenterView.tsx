/**
 * ============================================================================
 * หน้า: ศูนย์ปฏิบัติการ HR รายวัน (Unified Daily HR Work Center) (B4)
 * ไฟล์: frontend/src/pages/HrWorkCenterView.tsx
 * ============================================================================
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  RefreshCw,
  ArrowRight,
  Bookmark,
  Trash2,
  Lock,
  ShieldCheck,
  Radio,
  Search,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { AttendanceStatusText, ErrorBanner, ReviewStatusLabel } from '../components/StatusText.tsx';
import {
  PageHeader,
  SectionHeader,
  MetricStrip,
  StatusBadge,
  TableEmptyState,
  TableLoadingSkeleton,
  TablePaginationBar,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { useToast } from '../components/common/ToastContext.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import {
  formatThaiDate,
  formatThaiDateTime,
  getCurrentBangkokDateParts,
} from '../utils/thaiFormat.ts';

type QueueBucketTab = 'URGENT' | 'TODAY' | 'PENDING' | 'COMPLETED' | 'ALL';

interface FilterPreset {
  id: string;
  name: string;
  department: string;
}

const PRESET_STORAGE_KEY = 'sam_att_hr_work_center_presets_v1';

export function HrWorkCenterView({
  userRole,
  onNavigate,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);
  const toast = useToast();

  const [targetDate, setTargetDate] = useState(initialBkk.todayYmd);
  const [dateFrom, setDateFrom] = useState(initialBkk.monthStartYmd);
  const [dateTo, setDateTo] = useState(initialBkk.todayYmd);
  const [department, setDepartment] = useState('');
  const [activeTab, setActiveTab] = useState<QueueBucketTab>('URGENT');
  const [search, setSearch] = useState('');

  const [departments, setDepartments] = useState<string[]>([]);
  const [presets, setPresets] = useState<FilterPreset[]>(() => {
    try {
      const raw = localStorage.getItem(PRESET_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  });
  const [presetName, setPresetName] = useState('');

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [data, setData] = useState<any>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ items?: any[] }>('/personnel')
      .then((res) => {
        if (cancelled) return;
        const set = new Set<string>();
        for (const p of res.items || []) {
          if (p.department_name) set.add(String(p.department_name));
        }
        setDepartments(Array.from(set).sort((a, b) => a.localeCompare(b, 'th')));
      })
      .catch(() => {
        // non-blocking
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        date: targetDate,
        dateFrom,
        dateTo,
        ...(department ? { department } : {}),
      });
      const res = await apiRequest(`/hr-work-center/overview?${qs.toString()}`);
      setData(res);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถโหลดข้อมูลศูนย์ปฏิบัติการ HR ได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [targetDate, dateFrom, dateTo, department]);

  useEffect(() => {
    loadOverview();
  }, [loadOverview]);

  function handleSavePreset() {
    const label = presetName.trim() || department || 'ตัวกรองทั้งหมด';
    const next: FilterPreset[] = [
      { id: `${Date.now()}`, name: label, department },
      ...presets.slice(0, 5),
    ];
    setPresets(next);
    setPresetName('');
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage quota errors
    }
    toast.showSuccess(`บันทึกมุมมอง "${label}" แล้ว`);
  }

  function handleDeletePreset(id: string) {
    const next = presets.filter((p) => p.id !== id);
    setPresets(next);
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  const overview = data?.overview;
  const bucketCounts = data?.bucketCounts || { URGENT: 0, TODAY: 0, PENDING: 0, COMPLETED: 0 };
  const queueItems: any[] = data?.queueItems || [];

  const filteredQueue = useMemo(() => {
    const q = search.trim().toLowerCase();
    return queueItems.filter((item) => {
      if (activeTab !== 'ALL' && item.priorityBucket !== activeTab) return false;
      if (q) {
        return (
          String(item.fullName || '').toLowerCase().includes(q) ||
          String(item.personId || '').toLowerCase().includes(q) ||
          String(item.departmentName || '').toLowerCase().includes(q) ||
          String(item.reasonThai || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [queueItems, activeTab, search]);

  const numericSize = pageSize === 'ALL' ? Math.max(1, filteredQueue.length) : pageSize;
  const pagedQueue = filteredQueue.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="ศูนย์ปฏิบัติการ HR รายวัน"
        subtitle="รวมสถานะการลงเวลาประจำวัน คิวงานเร่งด่วน การซิงก์เครื่องสแกน สถานะปิดรอบเดือน และความพร้อมของ HOSOffice Preview ในหน้าเดียว"
        actions={
          <>
            <PageHelpAction
              guideKey="hrWorkCenter"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={loading}
              onClick={loadOverview}
              className="ent-btn-primary"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              <span>รีเฟรชศูนย์ปฏิบัติการ</span>
            </button>
          </>
        }
      />

      {/* Governance Readiness Strip */}
      {data && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div className="his-surface p-4 flex items-start gap-3">
            <Lock
              className={`w-5 h-5 shrink-0 mt-0.5 ${
                data.periodStatus?.closed ? 'text-[#C74455]' : 'text-[#198568]'
              }`}
            />
            <div className="min-w-0">
              <div className="text-[12px] text-[#777287]">สถานะรอบบัญชีเดือนปัจจุบัน</div>
              <div className="font-bold text-[14.5px] text-[#292638] mt-0.5 flex items-center gap-2">
                <span className="font-mono">{data.periodStatus?.periodYm}</span>
                <StatusBadge
                  tone={data.periodStatus?.closed ? 'danger' : 'success'}
                  label={data.periodStatus?.closed ? 'ปิดรอบแล้ว (CLOSED)' : data.periodStatus?.status || 'OPEN'}
                  compact
                />
              </div>
            </div>
          </div>

          <div className="his-surface p-4 flex items-start gap-3">
            <Radio className="w-5 h-5 text-[#8066B5] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-[12px] text-[#777287]">การดึงข้อมูลเครื่องสแกนล่าสุด</div>
              <div className="font-semibold text-[13.5px] text-[#292638] mt-0.5">
                {data.lastScannerSync
                  ? `${data.lastScannerSync.status} · ${formatThaiDateTime(data.lastScannerSync.completed_at)}`
                  : 'ยังไม่มีประวัติซิงก์ในระบบ'}
              </div>
            </div>
          </div>

          <div className="his-surface p-4 flex items-start gap-3">
            <ShieldCheck className="w-5 h-5 text-[#4E3978] shrink-0 mt-0.5" />
            <div className="min-w-0">
              <div className="text-[12px] text-[#777287]">สถานะการส่งข้อมูล HOSOffice</div>
              <div className="font-semibold text-[13px] text-[#4E3978] mt-0.5">
                {data.hosofficePreviewReadiness?.modeLabelThai}
              </div>
              <div className="text-[12px] text-[#777287] font-mono tabular-nums mt-0.5">
                รับรองแล้ว {data.hosofficePreviewReadiness?.approvedRecordsInRange ?? 0} รายการ
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Filter & Preset Controls */}
      <section className="his-surface p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="ent-label">วันที่ติดตามสถานะวันนี้</label>
            <input
              type="date"
              value={targetDate}
              onChange={(e) => {
                setTargetDate(e.target.value);
                setPage(1);
              }}
              className="ent-input font-mono tabular-nums w-full"
            />
          </div>
          <div>
            <label className="ent-label">คิวงานตั้งแต่วันที่</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => {
                setDateFrom(e.target.value);
                setPage(1);
              }}
              className="ent-input font-mono tabular-nums w-full"
            />
          </div>
          <div>
            <label className="ent-label">ถึงวันที่</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => {
                setDateTo(e.target.value);
                setPage(1);
              }}
              className="ent-input font-mono tabular-nums w-full"
            />
          </div>
          <div>
            <label className="ent-label">หน่วยงาน / กลุ่มงาน</label>
            <select
              value={department}
              onChange={(e) => {
                setDepartment(e.target.value);
                setPage(1);
              }}
              className="ent-input w-full"
            >
              <option value="">ทุกหน่วยงาน</option>
              {departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-[#E8E4EF]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold text-[#777287]">มุมมองที่บันทึกไว้:</span>
            {presets.length === 0 ? (
              <span className="text-[12px] text-[#777287]">ยังไม่มีมุมมองที่บันทึก</span>
            ) : (
              presets.map((p) => (
                <div
                  key={p.id}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#E8E4EF] bg-[#F8F7FC] px-2.5 py-1 text-[12px]"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setDepartment(p.department);
                      setPage(1);
                    }}
                    className="font-semibold text-[#4E3978] hover:underline cursor-pointer"
                  >
                    {p.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`ลบมุมมอง ${p.name}`}
                    onClick={() => handleDeletePreset(p.id)}
                    className="text-[#777287] hover:text-[#C74455] cursor-pointer"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              placeholder="ตั้งชื่อมุมมอง..."
              className="ent-input h-8 text-[12.5px] w-40"
            />
            <button
              type="button"
              onClick={handleSavePreset}
              className="ent-btn-secondary h-8 px-3 text-[12.5px]"
            >
              <Bookmark className="w-3.5 h-3.5 text-[#8066B5]" />
              <span>บันทึกตัวกรอง</span>
            </button>
          </div>
        </div>
      </section>

      <ErrorBanner error={error} onRetry={loadOverview} />

      {overview && (
        <MetricStrip
          columns={5}
          items={[
            {
              id: 'scheduled',
              label: 'เวรวันนี้ทั้งหมด',
              value: overview.scheduledToday,
              unit: 'เวร',
              sublabel: `กำลังปฏิบัติงาน ${overview.inProgress} เวร`,
              tone: 'brand',
            },
            {
              id: 'completed',
              label: 'สแกนครบถ้วนวันนี้',
              value: overview.completed,
              unit: 'เวร',
              sublabel: `มาสายวันนี้ ${overview.late} เวร`,
              tone: 'success',
            },
            {
              id: 'missing',
              label: 'ขาดสแกน / ไม่ครบวันนี้',
              value: overview.missingScan,
              unit: 'เวร',
              sublabel: `ข้อมูลไม่สมบูรณ์ ${overview.incompleteData} รายการ`,
              tone: overview.missingScan > 0 ? 'danger' : 'success',
              onClick: onNavigate ? () => onNavigate('completeness') : undefined,
            },
            {
              id: 'pending-hr',
              label: 'คิวรอ HR ตรวจสอบ',
              value: overview.pendingReview,
              unit: 'รายการ',
              sublabel: `สแกนเข้าเดือนปิดรอบ ${overview.lateScanReviewRequiredCount}`,
              tone: overview.pendingReview > 0 ? 'warning' : 'success',
              onClick: onNavigate ? () => onNavigate('attendanceReview') : undefined,
            },
            {
              id: 'unmatched',
              label: 'สแกนยังไม่ผูก / ซ้ำซ้อน',
              value: overview.unmatchedRawScans + overview.conflictRawScans,
              unit: 'สแกน',
              sublabel: `ไม่พบ ${overview.unmatchedRawScans} · ซ้ำ ${overview.conflictRawScans}`,
              tone:
                overview.unmatchedRawScans + overview.conflictRawScans > 0 ? 'danger' : 'success',
              onClick: onNavigate ? () => onNavigate('personnel') : undefined,
            },
          ]}
        />
      )}

      {/* Priority Queue Switcher & Table */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="ent-tab-bar" role="tablist" aria-label="จัดลำดับความสำคัญคิวงาน HR">
            {(
              [
                { key: 'URGENT', label: 'เร่งด่วน', count: bucketCounts.URGENT },
                { key: 'TODAY', label: 'วันนี้', count: bucketCounts.TODAY },
                { key: 'PENDING', label: 'รอ HR ตรวจ', count: bucketCounts.PENDING },
                { key: 'COMPLETED', label: 'เสร็จสิ้นแล้ว', count: bucketCounts.COMPLETED },
                { key: 'ALL', label: 'ทั้งหมด', count: queueItems.length },
              ] as Array<{ key: QueueBucketTab; label: string; count: number }>
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeTab === t.key}
                onClick={() => {
                  setActiveTab(t.key);
                  setPage(1);
                }}
                className={`ent-tab-btn ${activeTab === t.key ? 'ent-tab-btn-active' : ''}`}
              >
                <span>{t.label}</span>
                <span className="font-mono text-[12px] tabular-nums opacity-85">({t.count})</span>
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              aria-label="ค้นหาในคิวงาน HR"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาชื่อ รหัส หรือสาเหตุ..."
              className="ent-input ent-input-with-icon pr-4 w-full"
            />
          </div>
        </div>

        <div className="ent-table-wrapper">
          <div className="px-5 py-4 border-b border-[#E8E4EF] bg-white">
            <SectionHeader
              title={`คิวงานที่ต้องดำเนินการ (${filteredQueue.length} รายการ)`}
              subtitle="กดปุ่มทางขวาเพื่อเปิดหน้าตรวจสอบหรือบันทึกหมายเหตุสำหรับรายการนั้นได้ทันที"
            />
          </div>

          {loading ? (
            <TableLoadingSkeleton rows={6} cols={6} />
          ) : (
            <div className="overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>วันที่เวร</th>
                    <th>บุคลากร · หน่วยงาน</th>
                    <th>กะ</th>
                    <th>สถานะลงเวลา</th>
                    <th>ผลตรวจ HR</th>
                    <th>สาเหตุ / ประเด็น</th>
                    <th className="text-right">ดำเนินการ</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedQueue.length === 0 ? (
                    <TableEmptyState
                      colSpan={7}
                      title="ไม่มีรายการคิวงานในหมวดหมู่นี้"
                    />
                  ) : (
                    pagedQueue.map((item) => (
                      <tr key={`${item.attendanceId}-${item.workDate}`}>
                        <td className="font-mono tabular-nums font-semibold whitespace-nowrap text-[#292638]">
                          {formatThaiDate(item.workDate)}
                        </td>
                        <td>
                          <div className="font-semibold text-[#292638]">{item.fullName}</div>
                          <div className="text-[12px] text-[#777287]">
                            <span className="font-mono">{item.personId}</span> · {item.departmentName}
                          </div>
                        </td>
                        <td className="font-mono text-[#292638]">{item.shiftCode || '—'}</td>
                        <td>
                          <AttendanceStatusText status={item.status} />
                        </td>
                        <td>
                          <ReviewStatusLabel status={item.reviewStatus} />
                        </td>
                        <td className="text-[13px] text-[#292638]">{item.reasonThai}</td>
                        <td className="text-right">
                          {onNavigate && (
                            <button
                              type="button"
                              onClick={() => onNavigate((item.targetView as NavViewKey) || 'attendanceReview')}
                              className="ent-btn-secondary h-8 px-3 text-[12px] whitespace-nowrap"
                            >
                              <span>ตรวจสอบ</span>
                              <ArrowRight className="w-3.5 h-3.5 text-[#8066B5]" />
                            </button>
                          )}
                        </td>
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
            totalItems={filteredQueue.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      </div>
    </div>
  );
}
