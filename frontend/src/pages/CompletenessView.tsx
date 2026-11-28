/**
 * ============================================================================
 * หน้า: ศูนย์ตรวจสอบความครบถ้วนและเติมข้อมูลเวลาปฏิบัติงานย้อนหลัง (B3)
 * ไฟล์: frontend/src/pages/CompletenessView.tsx
 * ============================================================================
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Eye,
  Play,
  RotateCcw,
  Loader2,
  Lock,
  ArrowRight,
  Search,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SectionHeader,
  MetricStrip,
  StatusBadge,
  SharedModal,
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

const GAP_TYPE_LABELS: Record<string, { label: string; tone: 'warning' | 'danger' | 'info' | 'brand' }> = {
  MISSING_ATTENDANCE: { label: 'มีเวรแต่ยังไม่มีผลลงเวลา', tone: 'warning' },
  UNPROCESSED_SCAN: { label: 'มีสแกนดิบค้างประมวลผล', tone: 'info' },
  MISSING_MAPPING: { label: 'ยังไม่ผูกรหัสสแกน (FINGLE_ID)', tone: 'danger' },
  CONFLICT_MAPPING: { label: 'รหัสสแกนซ้ำซ้อน (Conflict)', tone: 'danger' },
  LATE_SCAN_CLOSED: { label: 'สแกนเข้ามาภายหลังในเดือนปิดรอบ', tone: 'brand' },
};

export function CompletenessView({
  userRole,
  onNavigate,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);
  const toast = useToast();

  const [dateFrom, setDateFrom] = useState(initialBkk.monthStartYmd);
  const [dateTo, setDateTo] = useState(initialBkk.todayYmd);
  const [department, setDepartment] = useState('');
  const [personnelType, setPersonnelType] = useState('');
  const [gapFilter, setGapFilter] = useState('');
  const [search, setSearch] = useState('');

  const [filterOptions, setFilterOptions] = useState<{
    departments: string[];
    personnelTypes: Array<{ code: string; name: string }>;
  }>({ departments: [], personnelTypes: [] });

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [snapshot, setSnapshot] = useState<any>(null);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  // Process modal state
  const [processModalOpen, setProcessModalOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<any>(null);
  const [processing, setProcessing] = useState(false);
  const [processResult, setProcessResult] = useState<any>(null);
  const [modalError, setModalError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ items?: any[] }>('/personnel')
      .then((res) => {
        if (cancelled) return;
        const list = res.items || [];
        const depts = new Set<string>();
        const pts = new Map<string, string>();
        for (const p of list) {
          if (p.department_name) depts.add(String(p.department_name));
          if (p.personnel_type_code) {
            pts.set(String(p.personnel_type_code), String(p.personnel_type_name || p.personnel_type_code));
          }
        }
        setFilterOptions({
          departments: Array.from(depts).sort((a, b) => a.localeCompare(b, 'th')),
          personnelTypes: Array.from(pts.entries())
            .map(([code, name]) => ({ code, name }))
            .sort((a, b) => a.name.localeCompare(b.name, 'th')),
        });
      })
      .catch(() => {
        // ignore non-blocking options load
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        dateFrom,
        dateTo,
        ...(department ? { department } : {}),
        ...(personnelType ? { personnelType } : {}),
      });
      const res = await apiRequest(`/attendance/completeness?${qs.toString()}`);
      setSnapshot(res);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถตรวจสอบความครบถ้วนของข้อมูลเวลาได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [dateFrom, dateTo, department, personnelType]);

  useEffect(() => {
    loadSnapshot();
  }, [loadSnapshot]);

  async function openProcessPreviewModal() {
    setProcessModalOpen(true);
    setProcessResult(null);
    setModalError(null);
    setPreviewLoading(true);
    try {
      const res = await apiRequest('/attendance/completeness/process-preview', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom,
          dateTo,
          ...(department ? { department } : {}),
          ...(personnelType ? { personnelType } : {}),
        }),
      });
      setPreviewData(res);
    } catch (err) {
      setModalError(
        err instanceof ApiClientError ? err.message : 'ไม่สามารถพรีวิวผลกระทบการเติมข้อมูลได้'
      );
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleRunCompletenessProcess(targets?: Array<{ personId: string; workDate: string }>) {
    setProcessing(true);
    setModalError(null);
    try {
      const res = await apiRequest('/attendance/completeness/process', {
        method: 'POST',
        body: JSON.stringify({
          dateFrom,
          dateTo,
          ...(department ? { department } : {}),
          ...(personnelType ? { personnelType } : {}),
          ...(targets && targets.length > 0 ? { targets } : {}),
        }),
      });
      setProcessResult(res);
      toast.showSuccess(
        'ประมวลผลเติมข้อมูลความครบถ้วนเรียบร้อยแล้ว',
        res.failedItems?.length > 0
          ? `ไม่สำเร็จ ${res.failedItems.length} รายการ (สามารถกดลองใหม่เฉพาะรายการที่ล้มเหลวได้)`
          : undefined
      );
      await loadSnapshot();
    } catch (err) {
      const msg =
        err instanceof ApiClientError
          ? err.message
          : 'ไม่สามารถประมวลผลเติมข้อมูลความครบถ้วนได้';
      setModalError(msg);
      toast.showError('ประมวลผลความครบถ้วนไม่สำเร็จ', msg);
    } finally {
      setProcessing(false);
    }
  }

  const metrics = snapshot?.metrics;
  const closedPeriods: string[] = snapshot?.closedPeriods || [];
  const rawGaps: any[] = snapshot?.gapItems || [];
  const recentRuns: any[] = snapshot?.recentRuns || [];

  const filteredGaps = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rawGaps.filter((g) => {
      if (gapFilter && g.gapType !== gapFilter) return false;
      if (q) {
        return (
          String(g.fullName || '').toLowerCase().includes(q) ||
          String(g.personId || '').toLowerCase().includes(q) ||
          String(g.fingleId || '').toLowerCase().includes(q) ||
          String(g.departmentName || '').toLowerCase().includes(q) ||
          String(g.reasonThai || '').toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [rawGaps, gapFilter, search]);

  const numericSize = pageSize === 'ALL' ? Math.max(1, filteredGaps.length) : pageSize;
  const pagedGaps = filteredGaps.slice((page - 1) * numericSize, page * numericSize);

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="ศูนย์ตรวจสอบความครบถ้วนและเติมข้อมูลเวลา"
        subtitle="ตรวจสอบช่องว่างระหว่างตารางเวร ข้อมูลสแกนดิบ และการจับคู่ลงเวลาโดยไม่สร้างแถวหลอก พร้อมสั่งเติมข้อมูลย้อนหลังอย่างปลอดภัย"
        actions={
          <>
            <PageHelpAction
              guideKey="completeness"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={loading}
              onClick={loadSnapshot}
              className="ent-btn-secondary"
            >
              <RefreshCw className={`w-4 h-4 text-[#8066B5] ${loading ? 'animate-spin' : ''}`} />
              <span>รีเฟรชผลตรวจ</span>
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={openProcessPreviewModal}
              className="ent-btn-primary"
            >
              <Play className="w-4 h-4" aria-hidden="true" />
              <span>พรีวิวและเติมข้อมูลที่ขาด</span>
            </button>
          </>
        }
      />

      {/* Filter Card */}
      <section className="his-surface p-4 flex flex-col xl:flex-row xl:items-end justify-between gap-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 flex-1">
          <div>
            <label className="ent-label">ตั้งแต่วันที่ (สูงสุด 93 วัน)</label>
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
            <label className="ent-label">กลุ่มงาน / หน่วยงาน</label>
            <select
              value={department}
              onChange={(e) => {
                setDepartment(e.target.value);
                setPage(1);
              }}
              className="ent-input w-full"
            >
              <option value="">ทุกหน่วยงาน</option>
              {filterOptions.departments.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="ent-label">ประเภทบุคลากร</label>
            <select
              value={personnelType}
              onChange={(e) => {
                setPersonnelType(e.target.value);
                setPage(1);
              }}
              className="ent-input w-full"
            >
              <option value="">ทุกประเภทบุคลากร</option>
              {filterOptions.personnelTypes.map((pt) => (
                <option key={pt.code} value={pt.code}>
                  {pt.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <ErrorBanner error={error} onRetry={loadSnapshot} />

      {closedPeriods.length > 0 && (
        <div
          role="status"
          className="p-4 rounded-xl bg-[#FEF7EA] border border-[#B87516]/30 flex items-start gap-3 text-[13.5px] text-[#292638]"
        >
          <Lock className="w-5 h-5 text-[#B87516] shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <div className="font-bold text-[#B87516]">
              ช่วงวันที่ที่เลือกครอบคลุมเดือนที่ปิดรอบบัญชีแล้ว: {closedPeriods.join(', ')}
            </div>
            <div className="text-[#777287] mt-0.5">
              ระบบอนุญาตให้ตรวจดูรายการช่องว่างแบบอ่านอย่างเดียว แต่จะป้องกันการประมวลผลอัตโนมัติในเดือนที่ปิดรอบแล้วจนกว่าผู้ดูแลระบบจะเปิดรอบใหม่
            </div>
          </div>
        </div>
      )}

      {metrics && (
        <MetricStrip
          columns={5}
          items={[
            {
              id: 'expected',
              label: 'เวรที่คาดว่าต้องมี',
              value: metrics.expectedShiftCount,
              unit: 'เวร',
              sublabel: `ตรวจจากบุคลากร ${metrics.totalPersonnelEvaluated} คน`,
              tone: 'brand',
            },
            {
              id: 'existing',
              label: 'มีผลลงเวลาแล้ว',
              value: metrics.existingAttendanceCount,
              unit: 'รายการ',
              sublabel: `รอ HR ตรวจ ${metrics.pendingReviewCount} รายการ`,
              tone: 'success',
            },
            {
              id: 'missing-att',
              label: 'ขาดผลลงเวลา (Gap)',
              value: metrics.missingAttendanceCount,
              unit: 'เวร',
              sublabel: 'ยังไม่ถูกสร้างใน attendance',
              tone: metrics.missingAttendanceCount > 0 ? 'warning' : 'success',
            },
            {
              id: 'unprocessed-scan',
              label: 'สแกนค้างจับคู่',
              value: metrics.unprocessedScanCount,
              unit: 'สแกน',
              sublabel: 'ผูกชื่อแล้วแต่ยังไม่ลงเวลา',
              tone: metrics.unprocessedScanCount > 0 ? 'info' : 'success',
            },
            {
              id: 'mapping-issues',
              label: 'ไม่ผูก / ซ้ำ FINGLE_ID',
              value: metrics.missingMappingCount + metrics.conflictCount,
              unit: 'รายการ',
              sublabel: `ไม่พบ ${metrics.missingMappingCount} · ซ้ำซ้อน ${metrics.conflictCount}`,
              tone: metrics.missingMappingCount + metrics.conflictCount > 0 ? 'danger' : 'success',
            },
          ]}
        />
      )}

      {/* Gap Items Table */}
      <div className="ent-table-wrapper">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-white flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <SectionHeader
            title={`รายการช่องว่างและข้อมูลที่ต้องตรวจสอบ (${filteredGaps.length} รายการ)`}
            subtitle="แสดงช่องว่างจริงจากการเปรียบเทียบตารางเวรและข้อมูลสแกนต้นฉบับ โดยไม่สร้างข้อมูลลงเวลาเทียม"
          />
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            <select
              aria-label="กรองตามประเภทช่องว่าง"
              value={gapFilter}
              onChange={(e) => {
                setGapFilter(e.target.value);
                setPage(1);
              }}
              className="ent-input w-full sm:w-52"
            >
              <option value="">ทุกประเภทปัญหา</option>
              <option value="MISSING_ATTENDANCE">ขาดผลลงเวลา</option>
              <option value="UNPROCESSED_SCAN">มีสแกนค้างประมวลผล</option>
              <option value="MISSING_MAPPING">ยังไม่ผูก FINGLE_ID</option>
              <option value="CONFLICT_MAPPING">FINGLE_ID ซ้ำซ้อน</option>
            </select>
            <div className="relative w-full sm:w-60">
              <Search className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                aria-label="ค้นหาในรายการช่องว่าง"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="ค้นหาชื่อ รหัส หรือ FINGLE_ID..."
                className="ent-input ent-input-with-icon pr-4 w-full"
              />
            </div>
          </div>
        </div>

        {loading ? (
          <TableLoadingSkeleton rows={6} cols={5} />
        ) : (
          <div className="overflow-x-auto">
            <table className="his-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ประเภทช่องว่าง</th>
                  <th>บุคลากร · รหัสสแกน</th>
                  <th>กะ / หน่วยงาน</th>
                  <th>รายละเอียดสาเหตุ</th>
                  <th className="text-right">แก้ไขที่เมนู</th>
                </tr>
              </thead>
              <tbody>
                {pagedGaps.length === 0 ? (
                  <TableEmptyState
                    colSpan={6}
                    title="ไม่พบช่องว่างความครบถ้วนในช่วงวันที่และตัวกรองที่เลือก"
                  />
                ) : (
                  pagedGaps.map((g, idx) => {
                    const meta = GAP_TYPE_LABELS[g.gapType] || {
                      label: g.gapType,
                      tone: 'neutral' as const,
                    };
                    const targetView: NavViewKey =
                      g.gapType === 'MISSING_MAPPING' || g.gapType === 'CONFLICT_MAPPING'
                        ? 'personnel'
                        : 'attendanceReview';
                    return (
                      <tr key={`${g.gapType}-${g.workDate}-${g.personId || g.fingleId || idx}`}>
                        <td className="font-mono tabular-nums whitespace-nowrap font-semibold text-[#292638]">
                          {formatThaiDate(g.workDate)}
                        </td>
                        <td>
                          <StatusBadge tone={meta.tone} label={meta.label} compact />
                        </td>
                        <td>
                          <div className="font-semibold text-[#292638]">
                            {g.fullName || 'ยังไม่ระบุตัวบุคคล'}
                          </div>
                          <div className="font-mono text-[12px] text-[#777287]">
                            {g.personId ? `รหัส ${g.personId}` : 'ไม่มี Person ID'}
                            {g.fingleId ? ` · สแกน ${g.fingleId}` : ''}
                          </div>
                        </td>
                        <td>
                          <div className="text-[#292638]">{g.departmentName || '—'}</div>
                          <div className="font-mono text-[12px] text-[#777287]">
                            {g.shiftCode ? `${g.shiftCode} (${g.shiftName || ''})` : '—'}
                          </div>
                        </td>
                        <td className="text-[13px] text-[#292638]">{g.reasonThai}</td>
                        <td className="text-right">
                          {onNavigate && (
                            <button
                              type="button"
                              onClick={() => onNavigate(targetView)}
                              className="ent-btn-secondary h-8 px-3 text-[12px] whitespace-nowrap"
                            >
                              <span>
                                {targetView === 'personnel' ? 'ไปแก้ทะเบียน' : 'ไปหน้าตรวจเวลา'}
                              </span>
                              <ArrowRight className="w-3.5 h-3.5 text-[#8066B5]" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}

        <TablePaginationBar
          currentPage={page}
          pageSize={pageSize}
          totalItems={filteredGaps.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      </div>

      {/* Recent Completeness Runs */}
      {recentRuns.length > 0 && (
        <div className="his-surface overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC]">
            <h2 className="text-[16px] font-bold text-[#292638]">
              ประวัติการประมวลผลเติมข้อมูลความครบถ้วนล่าสุด
            </h2>
          </div>
          <div className="overflow-x-auto">
            <table className="his-table text-[13px]">
              <thead>
                <tr>
                  <th>วันเวลาที่ประมวลผล</th>
                  <th>ช่วงวันที่</th>
                  <th>หน่วยงาน</th>
                  <th className="text-right">คาดการณ์ / มีแล้ว / ขาดก่อนทำ</th>
                  <th className="text-right">ประมวลผลสำเร็จ</th>
                  <th>สถานะ</th>
                  <th>ผู้ดำเนินการ</th>
                </tr>
              </thead>
              <tbody>
                {recentRuns.map((run) => (
                  <tr key={run.id}>
                    <td className="font-mono tabular-nums text-[#777287]">
                      {formatThaiDateTime(run.completed_at || run.created_at)}
                    </td>
                    <td className="font-mono tabular-nums whitespace-nowrap">
                      {formatThaiDate(run.date_from)} – {formatThaiDate(run.date_to)}
                    </td>
                    <td>{run.department_name || run.department_filter || 'ทุกหน่วยงาน'}</td>
                    <td className="text-right font-mono tabular-nums">
                      {run.expected_count ?? run.expected_shifts ?? 0} /{' '}
                      {(run.expected_count ?? run.expected_shifts ?? 0) -
                        (run.missing_before_count ?? run.missing_attendance_before ?? 0)}{' '}
                      /{' '}
                      <span className="text-[#B87516] font-semibold">
                        {run.missing_before_count ?? run.missing_attendance_before ?? 0}
                      </span>
                    </td>
                    <td className="text-right font-mono tabular-nums font-bold text-[#198568]">
                      {run.processed_count}
                    </td>
                    <td>
                      <StatusBadge
                        tone={
                          run.status === 'COMPLETED'
                            ? 'success'
                            : run.status === 'PARTIAL'
                              ? 'warning'
                              : 'danger'
                        }
                        label={run.status}
                        compact
                      />
                    </td>
                    <td className="font-mono text-[#777287]">{run.triggered_by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Preview & Backfill Process Modal */}
      <SharedModal
        open={processModalOpen}
        onClose={() => !processing && setProcessModalOpen(false)}
        kickerText="พรีวิวและเติมข้อมูลความครบถ้วนย้อนหลัง"
        title={`ประมวลผลความครบถ้วน (${formatThaiDate(dateFrom)} – ${formatThaiDate(dateTo)})`}
        subtitle="ระบบจะเชื่อมโยง FINGLE_ID ที่เพิ่งอัปเดตและจับคู่สแกนกับเวรที่ยังขาดโดยไม่แก้ไขข้อมูลสแกนต้นฉบับ (raw_scans)"
        maxWidthClass="max-w-2xl"
      >
        <div className="space-y-4">
          {modalError && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#C74455]/25 text-[#C74455] text-[13px] font-medium"
            >
              {modalError}
            </div>
          )}

          {previewLoading ? (
            <div className="py-8 flex items-center justify-center gap-2 text-[14px] text-[#777287]">
              <Loader2 className="w-5 h-5 animate-spin text-[#8066B5]" />
              <span>กำลังจำลองผลกระทบการประมวลผลความครบถ้วน...</span>
            </div>
          ) : previewData ? (
            <div className="space-y-3">
              {!previewData.canExecute && previewData.blockedReasonThai && (
                <div className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#C74455]/30 text-[#C74455] text-[13px] font-medium flex items-start gap-2">
                  <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{previewData.blockedReasonThai}</span>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[12px] text-[#777287]">ขาดผลลงเวลา</div>
                  <div className="text-[20px] font-bold font-mono tabular-nums text-[#B87516]">
                    {previewData.metrics?.missingAttendanceCount ?? 0} เวร
                  </div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[12px] text-[#777287]">สแกนดิบค้างประมวลผล</div>
                  <div className="text-[20px] font-bold font-mono tabular-nums text-[#4E3978]">
                    {previewData.metrics?.unprocessedScanCount ?? 0} สแกน
                  </div>
                </div>
                <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[12px] text-[#777287]">ปัญหา FINGLE_ID</div>
                  <div className="text-[20px] font-bold font-mono tabular-nums text-[#C74455]">
                    {(previewData.metrics?.missingMappingCount ?? 0) +
                      (previewData.metrics?.conflictCount ?? 0)}{' '}
                    รายการ
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {processResult && (
            <div className="p-4 rounded-xl bg-[#EEF8F4] border border-[#198568]/25 space-y-2 text-[13px]">
              <div className="font-bold text-[#198568] flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                <span>ผลดำเนินการ: {processResult.status}</span>
              </div>
              <div className="text-[#292638] tabular-nums">
                ขาดผลลงเวลาก่อนทำ {processResult.beforeMetrics?.missingAttendanceCount ?? 0} เวร → คงเหลือ{' '}
                {processResult.afterSnapshot?.metrics?.missingAttendanceCount ?? 0} เวร
              </div>
              {processResult.failedItems?.length > 0 && (
                <div className="pt-2 border-t border-[#198568]/20 space-y-2">
                  <div className="font-semibold text-[#C74455] flex items-center gap-1.5">
                    <AlertTriangle className="w-4 h-4" />
                    <span>พบรายการที่ไม่สำเร็จ {processResult.failedItems.length} รายการ</span>
                  </div>
                  <button
                    type="button"
                    disabled={processing}
                    onClick={() => {
                      const retryTargets = processResult.failedItems
                        .filter((f: any) => f.personId)
                        .map((f: any) => ({ personId: f.personId, workDate: f.workDate }));
                      void handleRunCompletenessProcess(retryTargets);
                    }}
                    className="ent-btn-secondary h-8 px-3 text-[12.5px]"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>ลองประมวลผลเฉพาะรายการที่ล้มเหลว</span>
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
            <button
              type="button"
              disabled={processing}
              onClick={() => setProcessModalOpen(false)}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ปิดหน้าต่าง
            </button>
            <button
              type="button"
              disabled={processing || previewLoading || previewData?.canExecute === false}
              onClick={() => handleRunCompletenessProcess()}
              className="ent-btn-primary w-full sm:w-auto disabled:opacity-50"
            >
              {processing ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Eye className="w-4 h-4" />
              )}
              <span>{processing ? 'กำลังประมวลผล...' : 'ยืนยันเติมข้อมูลที่ขาด'}</span>
            </button>
          </div>
        </div>
      </SharedModal>
    </div>
  );
}
