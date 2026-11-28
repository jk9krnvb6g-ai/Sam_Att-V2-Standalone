/**
 * ============================================================================
 * หน้า: ศูนย์ปิดรอบเวลาปฏิบัติงานประจำเดือน (Monthly Closing & Period Lock) (B8)
 * ไฟล์: frontend/src/pages/MonthlyClosingView.tsx
 * ============================================================================
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Lock,
  Unlock,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  ArrowRight,
  Loader2,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner } from '../components/StatusText.tsx';
import {
  PageHeader,
  SectionHeader,
  MetricStrip,
  StatusBadge,
  SharedModal,
  RequiredMark,
  TableEmptyState,
  TableLoadingSkeleton,
} from '../components/common/SharedComponents.tsx';
import { useToast } from '../components/common/ToastContext.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import { formatThaiDateTime, getCurrentBangkokDateParts } from '../utils/thaiFormat.ts';

function getPeriodStatusTone(status?: string): 'success' | 'warning' | 'danger' | 'brand' | 'info' {
  const s = String(status || '').toUpperCase();
  if (s === 'CLOSED') return 'danger';
  if (s === 'READY_TO_CLOSE') return 'success';
  if (s === 'REVIEWING') return 'info';
  if (s === 'REOPENED') return 'warning';
  return 'brand';
}

function getPeriodStatusThai(status?: string): string {
  const s = String(status || '').toUpperCase();
  if (s === 'CLOSED') return 'ปิดรอบแล้ว (CLOSED · ถูกล็อก)';
  if (s === 'READY_TO_CLOSE') return 'พร้อมปิดรอบ (READY_TO_CLOSE)';
  if (s === 'REVIEWING') return 'กำลังตรวจสอบงวด (REVIEWING)';
  if (s === 'REOPENED') return 'เปิดรอบใหม่ (REOPENED)';
  return 'เปิดใช้งาน (OPEN)';
}

export function MonthlyClosingView({
  userRole,
  onNavigate,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);
  const toast = useToast();

  const [selectedYm, setSelectedYm] = useState(initialBkk.currentYearMonth);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [periodsData, setPeriodsData] = useState<any>(null);
  const [readiness, setReadiness] = useState<any>(null);

  const [updatingStatus, setUpdatingStatus] = useState(false);
  const [closeModalOpen, setCloseModalOpen] = useState(false);
  const [closeNote, setCloseNote] = useState('');
  const [closing, setClosing] = useState(false);

  const [reopenModalOpen, setReopenModalOpen] = useState(false);
  const [reopenReason, setReopenReason] = useState('');
  const [reopening, setReopening] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listRes, readyRes] = await Promise.all([
        apiRequest('/attendance-periods'),
        apiRequest(`/attendance-periods/${selectedYm}/readiness`),
      ]);
      setPeriodsData(listRes);
      setReadiness(readyRes);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถโหลดข้อมูลความพร้อมก่อนปิดรอบเดือนได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [selectedYm]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  async function handleChangePreCloseStatus(nextStatus: 'REVIEWING' | 'READY_TO_CLOSE' | 'OPEN') {
    setUpdatingStatus(true);
    setError(null);
    try {
      await apiRequest(`/attendance-periods/${selectedYm}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: nextStatus }),
      });
      toast.showSuccess(`ปรับสถานะงวดเดือน ${selectedYm} เป็น ${nextStatus} แล้ว`);
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถเปลี่ยนสถานะงวดเดือนได้';
      setError({ code: err instanceof ApiClientError ? err.code : undefined, message: msg });
      toast.showError('เปลี่ยนสถานะไม่สำเร็จ', msg);
    } finally {
      setUpdatingStatus(false);
    }
  }

  async function handleConfirmClosePeriod(e: React.FormEvent) {
    e.preventDefault();
    setClosing(true);
    setError(null);
    try {
      const res = await apiRequest(`/attendance-periods/${selectedYm}/close`, {
        method: 'POST',
        body: JSON.stringify({ note: closeNote.trim() || 'ปิดรอบเวลาปฏิบัติงานประจำเดือน' }),
      });
      setCloseModalOpen(false);
      setCloseNote('');
      toast.showSuccess(`ปิดรอบเดือน ${selectedYm} สำเร็จ`, res.message);
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถปิดรอบเดือนได้';
      setError({ code: err instanceof ApiClientError ? err.code : undefined, message: msg });
      toast.showError('ปิดรอบเดือนไม่สำเร็จ', msg);
    } finally {
      setClosing(false);
    }
  }

  async function handleConfirmReopenPeriod(e: React.FormEvent) {
    e.preventDefault();
    if (reopenReason.trim().length < 5) {
      toast.showError('กรุณาระบุเหตุผล', 'ต้องระบุเหตุผลอย่างน้อย 5 ตัวอักษร');
      return;
    }
    setReopening(true);
    setError(null);
    try {
      const res = await apiRequest(`/attendance-periods/${selectedYm}/reopen`, {
        method: 'POST',
        body: JSON.stringify({ reason: reopenReason.trim() }),
      });
      setReopenModalOpen(false);
      setReopenReason('');
      toast.showSuccess(`เปิดรอบเดือน ${selectedYm} ใหม่แล้ว`, res.warning);
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถเปิดรอบเดือนใหม่ได้';
      setError({ code: err instanceof ApiClientError ? err.code : undefined, message: msg });
      toast.showError('เปิดรอบใหม่ไม่สำเร็จ', msg);
    } finally {
      setReopening(false);
    }
  }

  const currentStatus = String(readiness?.currentStatus || 'OPEN').toUpperCase();
  const isClosed = currentStatus === 'CLOSED';
  const blockingIssues: any[] = readiness?.blockingIssues || [];
  const warnings: any[] = readiness?.warnings || [];
  const summary = readiness?.summary;
  const periodHistory: any[] = readiness?.history || periodsData?.history || [];

  return (
    <div className="space-y-6">
      <PageHeader
        category="บริหารเวลาปฏิบัติงาน"
        title="ศูนย์ปิดรอบเวลาปฏิบัติงานประจำเดือน (Period Lock)"
        subtitle="ตรวจสอบรายการติดขัดก่อนปิดบัญชีเวลาประจำเดือน ล็อกรายการไม่ให้ถูกแก้ไขหรือ Reprocess ทับ และสงวนสิทธิ์เปิดรอบใหม่เฉพาะผู้ดูแลระบบ"
        actions={
          <>
            <PageHelpAction
              guideKey="monthlyClosing"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={loading}
              onClick={loadData}
              className="ent-btn-secondary"
            >
              <RefreshCw className={`w-4 h-4 text-[#8066B5] ${loading ? 'animate-spin' : ''}`} />
              <span>ตรวจสอบความพร้อมใหม่</span>
            </button>
            {isClosed && userRole === 'ADMIN' && (
              <button
                type="button"
                onClick={() => setReopenModalOpen(true)}
                className="ent-btn-secondary"
              >
                <Unlock className="w-4 h-4 text-[#B87516]" />
                <span>เปิดรอบเดือนใหม่ (ADMIN)</span>
              </button>
            )}
            {!isClosed && (
              <button
                type="button"
                disabled={loading || !readiness?.canClose}
                onClick={() => setCloseModalOpen(true)}
                className="ent-btn-primary disabled:opacity-50"
              >
                <Lock className="w-4 h-4" />
                <span>ปิดรอบเดือน {selectedYm}</span>
              </button>
            )}
          </>
        }
      />

      {/* Month & Pre-close Status Controls */}
      <section className="his-surface p-4 sm:p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <label htmlFor="closing-month-input" className="ent-label">
              เลือกงวดเดือนที่ตรวจสอบ
            </label>
            <input
              id="closing-month-input"
              type="month"
              value={selectedYm}
              onChange={(e) => setSelectedYm(e.target.value)}
              className="ent-input font-mono tabular-nums"
            />
          </div>
          <div className="pt-5">
            <StatusBadge
              tone={getPeriodStatusTone(currentStatus)}
              label={getPeriodStatusThai(currentStatus)}
            />
          </div>
        </div>

        {!isClosed && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] text-[#777287] mr-1">เปลี่ยนสถานะงวด:</span>
            <button
              type="button"
              disabled={updatingStatus || currentStatus === 'REVIEWING'}
              onClick={() => handleChangePreCloseStatus('REVIEWING')}
              className="ent-btn-secondary h-8 px-3 text-[12.5px] disabled:opacity-50"
            >
              กำลังตรวจงวด (REVIEWING)
            </button>
            <button
              type="button"
              disabled={updatingStatus || currentStatus === 'READY_TO_CLOSE'}
              onClick={() => handleChangePreCloseStatus('READY_TO_CLOSE')}
              className="ent-btn-secondary h-8 px-3 text-[12.5px] disabled:opacity-50"
            >
              พร้อมปิดรอบ (READY_TO_CLOSE)
            </button>
          </div>
        )}
      </section>

      <ErrorBanner error={error} onRetry={loadData} />

      {summary && (
        <MetricStrip
          columns={5}
          items={[
            {
              id: 'total-shifts',
              label: 'ตารางเวรในงวด',
              value: summary.totalShiftAssignments,
              unit: 'เวร',
              sublabel: `ผลลงเวลา ${summary.totalAttendanceRecords} รายการ`,
              tone: 'brand',
            },
            {
              id: 'complete',
              label: 'ลงเวลาครบถ้วน',
              value: summary.completeCount,
              unit: 'รายการ',
              sublabel: `รับรองผล HR แล้ว ${summary.approvedCount} รายการ`,
              tone: 'success',
            },
            {
              id: 'late-missing',
              label: 'มาสาย / ขาดสแกน',
              value: summary.lateCount + summary.noScanCount + summary.missingScanCount,
              unit: 'รายการ',
              sublabel: `สาย ${summary.lateCount} · ขาด ${summary.noScanCount + summary.missingScanCount}`,
              tone:
                summary.noScanCount + summary.missingScanCount > 0 ? 'warning' : 'default',
            },
            {
              id: 'blocking',
              label: 'รายการติดขัด (ห้ามปิดรอบ)',
              value: readiness.blockingIssuesCount,
              unit: 'รายการ',
              sublabel: blockingIssues.length === 0 ? 'ผ่านเกณฑ์พร้อมปิดรอบ' : 'ต้องแก้ก่อนปิดรอบ',
              tone: readiness.blockingIssuesCount > 0 ? 'danger' : 'success',
            },
            {
              id: 'warnings',
              label: 'คำเตือนประกอบ (Warnings)',
              value: readiness.warningsCount,
              unit: 'รายการ',
              sublabel: `สแกนเข้าหลังปิด ${summary.lateScanReviewRequiredCount} รายการ`,
              tone: readiness.warningsCount > 0 ? 'warning' : 'success',
            },
          ]}
        />
      )}

      {/* Blocking Issues vs Warnings Panels */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <section className="his-surface overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-[#E8E4EF] flex items-center justify-between gap-2">
            <SectionHeader
              title={`รายการติดขัดที่ต้องแก้ไขก่อนปิดรอบ (${blockingIssues.length} หัวข้อ)`}
              subtitle="หากยังมีหัวข้อติดขัด ปุ่มปิดรอบเดือนจะถูกปิดกั้นเพื่อป้องกันข้อมูลไม่ครบ"
            />
          </div>
          <div className="p-5 flex-1">
            {loading ? (
              <TableLoadingSkeleton rows={3} cols={2} />
            ) : blockingIssues.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#EEF8F4] border border-[#198568]/20 text-[13.5px] text-[#198568] font-medium flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <span>ไม่พบรายการติดขัด งวดเดือนนี้พร้อมสำหรับการปิดรอบและล็อกข้อมูล</span>
              </div>
            ) : (
              <div className="divide-y divide-[#E8E4EF] -my-2">
                {blockingIssues.map((issue) => (
                  <div key={issue.code} className="py-3 flex items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <AlertCircle className="w-4 h-4 text-[#C74455] shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-[13.5px] text-[#292638]">
                          {issue.labelThai}
                        </div>
                        <div className="font-mono text-[12px] text-[#C74455] font-bold">
                          จำนวน {issue.count} รายการ ({issue.code})
                        </div>
                      </div>
                    </div>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() => onNavigate(issue.targetView as NavViewKey)}
                        className="ent-btn-secondary h-8 px-3 text-[12px] shrink-0"
                      >
                        <span>แก้ไข</span>
                        <ArrowRight className="w-3.5 h-3.5 text-[#8066B5]" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <section className="his-surface overflow-hidden flex flex-col">
          <div className="px-5 py-4 border-b border-[#E8E4EF]">
            <SectionHeader
              title={`คำเตือนและข้อสังเกต (${warnings.length} หัวข้อ)`}
              subtitle="รายการเพื่อการสอบทานเพิ่มเติมก่อนยืนยันปิดงวด"
            />
          </div>
          <div className="p-5 flex-1">
            {loading ? (
              <TableLoadingSkeleton rows={3} cols={2} />
            ) : warnings.length === 0 ? (
              <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13.5px] text-[#777287]">
                ไม่มีคำเตือนเพิ่มเติมสำหรับงวดเดือน {selectedYm}
              </div>
            ) : (
              <div className="divide-y divide-[#E8E4EF] -my-2">
                {warnings.map((w) => (
                  <div key={w.code} className="py-3 flex items-center justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <AlertTriangle className="w-4 h-4 text-[#B87516] shrink-0 mt-0.5" />
                      <div>
                        <div className="font-semibold text-[13.5px] text-[#292638]">
                          {w.labelThai}
                        </div>
                        <div className="font-mono text-[12px] text-[#B87516] font-bold">
                          จำนวน {w.count} รายการ ({w.code})
                        </div>
                      </div>
                    </div>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() => onNavigate(w.targetView as NavViewKey)}
                        className="ent-btn-secondary h-8 px-3 text-[12px] shrink-0"
                      >
                        <span>ตรวจสอบ</span>
                        <ArrowRight className="w-3.5 h-3.5 text-[#8066B5]" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      {/* Period Closing History Table */}
      <div className="his-surface overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC]">
          <h2 className="text-[16px] font-bold text-[#292638]">
            ประวัติการเปลี่ยนสถานะ ปิดรอบ และเปิดรอบเดือนใหม่ ({periodHistory.length} รายการ)
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="his-table text-[13px]">
            <thead>
              <tr>
                <th>วันเวลาที่ดำเนินการ</th>
                <th>งวดเดือน</th>
                <th>กิจกรรม</th>
                <th>สถานะเดิม → ใหม่</th>
                <th>เหตุผล / หมายเหตุ</th>
                <th>ผู้ดำเนินการ</th>
              </tr>
            </thead>
            <tbody>
              {periodHistory.length === 0 ? (
                <TableEmptyState colSpan={6} title="ยังไม่มีประวัติการปิดรอบเดือน" />
              ) : (
                periodHistory.map((h) => (
                  <tr key={h.id}>
                    <td className="font-mono tabular-nums text-[#777287] whitespace-nowrap">
                      {formatThaiDateTime(h.acted_at || h.created_at)}
                    </td>
                    <td className="font-mono font-bold text-[#292638]">{h.period_ym}</td>
                    <td className="font-mono text-[12px] text-[#4E3978]">{h.action_type}</td>
                    <td className="font-mono text-[12.5px]">
                      {h.previous_status} → <strong>{h.new_status}</strong>
                    </td>
                    <td>{h.reason || '—'}</td>
                    <td className="font-mono text-[#777287]">{h.acted_by}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Close & Lock Modal */}
      <SharedModal
        open={closeModalOpen}
        onClose={() => !closing && setCloseModalOpen(false)}
        kickerText="ยืนยันการปิดรอบบัญชีเวลาประจำเดือน"
        title={`ปิดรอบเดือน ${selectedYm} และล็อกรายการลงเวลา`}
        subtitle="เมื่อปิดรอบแล้ว ข้อมูลในเดือนนี้จะถูกล็อกไม่ให้แก้ไขวันหยุด หมายเหตุ ผลตรวจ HR หรือ Reprocess ทับ (ไม่มีการส่งข้อมูลเข้า HOSOffice โดยอัตโนมัติ)"
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleConfirmClosePeriod} className="space-y-4">
          <div>
            <label className="ent-label">หมายเหตุประกอบการปิดรอบเดือน</label>
            <input
              type="text"
              value={closeNote}
              onChange={(e) => setCloseNote(e.target.value)}
              placeholder="เช่น ตรวจสอบครบถ้วนประจำเดือนแล้ว"
              className="ent-input w-full"
            />
          </div>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
            <button
              type="button"
              disabled={closing}
              onClick={() => setCloseModalOpen(false)}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={closing}
              className="ent-btn-primary w-full sm:w-auto"
            >
              {closing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Lock className="w-4 h-4" />}
              <span>{closing ? 'กำลังปิดรอบ...' : 'ยืนยันปิดรอบและล็อกเดือนนี้'}</span>
            </button>
          </div>
        </form>
      </SharedModal>

      {/* Reopen Period Modal (ADMIN only) */}
      <SharedModal
        open={reopenModalOpen}
        onClose={() => !reopening && setReopenModalOpen(false)}
        kickerText="สงวนสิทธิ์ผู้ดูแลระบบ (ADMIN Only)"
        title={`เปิดรอบเดือน ${selectedYm} ใหม่ (Reopen)`}
        subtitle="คำเตือน: รายงานหรือตัวเลขสรุปของเดือนนี้ที่ส่งออกไว้ก่อนหน้าอาจเปลี่ยนแปลงได้หลังเปิดรอบและแก้ไขข้อมูล"
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleConfirmReopenPeriod} className="space-y-4">
          <div>
            <label className="ent-label">
              เหตุผลในการเปิดรอบเดือนใหม่ (อย่างน้อย 5 ตัวอักษร) <RequiredMark />
            </label>
            <textarea
              required
              minLength={5}
              rows={3}
              value={reopenReason}
              onChange={(e) => setReopenReason(e.target.value)}
              placeholder="ระบุเหตุผลที่ชัดเจน เช่น แก้ไขตารางเวรย้อนหลังตามบันทึกข้อความ..."
              className="ent-input w-full py-2"
            />
          </div>
          <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
            <button
              type="button"
              disabled={reopening}
              onClick={() => setReopenModalOpen(false)}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={reopening}
              className="ent-btn-primary w-full sm:w-auto"
            >
              {reopening ? <Loader2 className="w-4 h-4 animate-spin" /> : <Unlock className="w-4 h-4" />}
              <span>{reopening ? 'กำลังเปิดรอบใหม่...' : 'ยืนยันเปิดรอบเดือนใหม่'}</span>
            </button>
          </div>
        </form>
      </SharedModal>
    </div>
  );
}
