import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  List,
  Plus,
  Download,
  RefreshCw,
  Pencil,
  Trash2,
  Eye,
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Lock,
} from 'lucide-react';
import { apiRequest, ApiClientError, downloadHolidaysCsv } from '../../services/api.ts';
import {
  SectionHeader,
  StatusBadge,
  SharedModal,
  ConfirmDialog,
  TableEmptyState,
  TableLoadingSkeleton,
  RequiredMark,
} from '../common/SharedComponents.tsx';
import { useToast } from '../common/ToastContext.tsx';
import { ErrorBanner } from '../StatusText.tsx';
import { formatThaiDate, getCurrentBangkokDateParts, THAI_MONTHS } from '../../utils/thaiFormat.ts';

const THAI_WEEKDAYS_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

const CATEGORY_LABELS: Record<string, string> = {
  NATIONAL: 'วันหยุดราชการ/นักขัตฤกษ์',
  HOSPITAL_ANNOUNCED: 'วันหยุดประกาศโรงพยาบาล',
  SUBSTITUTE: 'วันหยุดชดเชย',
  SPECIAL_POLICY: 'นโยบายพิเศษ',
};

const SCOPE_LABELS: Record<string, string> = {
  ALL: 'ทั้งโรงพยาบาล',
  DEPARTMENT: 'เฉพาะหน่วยงาน',
  PERSON: 'เฉพาะบุคลากร',
};

const POLICY_LABELS: Record<string, string> = {
  EXEMPT: 'ยกเว้นเวรอัตโนมัติ (หยุด)',
  WORK_WITH_OT: 'ปฏิบัติงานปกติ / คิดค่าล่วงเวลา',
  MANDATORY_SHIFT: 'ต้องปฏิบัติงานตามตารางเวร',
};

export interface HospitalHolidaysTabProps {
  canEdit: boolean;
  departments: string[];
  personnel: Array<{ person_id: string; full_name: string; department_name?: string }>;
  onHolidaysChanged?: () => void;
}

export function HospitalHolidaysTab({
  canEdit,
  departments,
  personnel,
  onHolidaysChanged,
}: HospitalHolidaysTabProps) {
  const initialBkk = useMemo(() => getCurrentBangkokDateParts(), []);
  const toast = useToast();

  const [yearFilter, setYearFilter] = useState(initialBkk.currentYear);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [scopeFilter, setScopeFilter] = useState('');
  const [displayMode, setDisplayMode] = useState<'table' | 'calendar'>('table');
  const [calendarMonth, setCalendarMonth] = useState(initialBkk.currentYearMonth);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [holidays, setHolidays] = useState<any[]>([]);

  // Create / Edit Modal
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [editingHoliday, setEditingHoliday] = useState<any | null>(null);
  const [holidayDate, setHolidayDate] = useState(initialBkk.todayYmd);
  const [holidayName, setHolidayName] = useState('');
  const [category, setCategory] = useState('NATIONAL');
  const [scopeType, setScopeType] = useState<'ALL' | 'DEPARTMENT' | 'PERSON'>('ALL');
  const [departmentName, setDepartmentName] = useState('');
  const [personId, setPersonId] = useState('');
  const [overridePolicy, setOverridePolicy] = useState<'EXEMPT' | 'WORK_WITH_OT' | 'MANDATORY_SHIFT'>('EXEMPT');
  const [notes, setNotes] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Deactivate confirm
  const [deactivateTarget, setDeactivateTarget] = useState<any | null>(null);
  const [deactivating, setDeactivating] = useState(false);

  // Impact Preview & Reprocess Modal
  const [impactTarget, setImpactTarget] = useState<any | null>(null);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactData, setImpactData] = useState<any | null>(null);
  const [impactError, setImpactError] = useState<string | null>(null);
  const [reprocessing, setReprocessing] = useState(false);

  const loadHolidays = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        year: yearFilter,
        ...(categoryFilter ? { category: categoryFilter } : {}),
        ...(scopeFilter ? { scopeType: scopeFilter } : {}),
      });
      const res = await apiRequest<{ items: any[] }>(`/holidays?${qs.toString()}`);
      setHolidays(res.items || []);
    } catch (err) {
      setError(
        err instanceof ApiClientError
          ? { code: err.code, message: err.message }
          : { message: 'ไม่สามารถโหลดข้อมูลปฏิทินวันหยุดโรงพยาบาลได้' }
      );
    } finally {
      setLoading(false);
    }
  }, [yearFilter, categoryFilter, scopeFilter]);

  useEffect(() => {
    loadHolidays();
  }, [loadHolidays]);

  function openCreateModal() {
    setEditingHoliday(null);
    setHolidayDate(`${yearFilter}-${initialBkk.todayYmd.slice(5)}`);
    setHolidayName('');
    setCategory('NATIONAL');
    setScopeType('ALL');
    setDepartmentName(departments[0] || '');
    setPersonId('');
    setOverridePolicy('EXEMPT');
    setNotes('');
    setFormError(null);
    setFormModalOpen(true);
  }

  function openEditModal(h: any) {
    setEditingHoliday(h);
    setHolidayDate(String(h.holiday_date || '').slice(0, 10));
    setHolidayName(String(h.holiday_name || ''));
    setCategory(String(h.category || 'NATIONAL'));
    setScopeType((h.scope_type || 'ALL') as 'ALL' | 'DEPARTMENT' | 'PERSON');
    setDepartmentName(String(h.department_name || ''));
    setPersonId(String(h.person_id || ''));
    setOverridePolicy((h.override_policy === 'EXEMPT_ALL' ? 'EXEMPT' : h.override_policy || 'EXEMPT') as 'EXEMPT' | 'WORK_WITH_OT' | 'MANDATORY_SHIFT');
    setNotes(String(h.notes || ''));
    setFormError(null);
    setFormModalOpen(true);
  }

  async function handleSaveHoliday(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      const payload = {
        holidayDate,
        holidayName: holidayName.trim(),
        category,
        scopeType,
        departmentName: scopeType === 'DEPARTMENT' ? departmentName : null,
        personId: scopeType === 'PERSON' ? personId.trim() : null,
        overridePolicy,
        notes: notes.trim() || null,
      };
      if (editingHoliday && Number(editingHoliday.id) < 1_000_000) {
        await apiRequest(`/holidays/${editingHoliday.id}`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
        toast.showSuccess('อัปเดตวันหยุดโรงพยาบาลเรียบร้อยแล้ว');
      } else {
        await apiRequest('/holidays', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        toast.showSuccess('บันทึกวันหยุดโรงพยาบาลเรียบร้อยแล้ว');
      }
      setFormModalOpen(false);
      await loadHolidays();
      onHolidaysChanged?.();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถบันทึกวันหยุดได้';
      setFormError(msg);
      toast.showError('บันทึกวันหยุดไม่สำเร็จ', msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleConfirmDeactivate() {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await apiRequest(`/holidays/${deactivateTarget.id}`, { method: 'DELETE' });
      toast.showSuccess('ปิดใช้งานวันหยุดเรียบร้อยแล้ว');
      setDeactivateTarget(null);
      await loadHolidays();
      onHolidaysChanged?.();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถปิดใช้งานวันหยุดได้';
      toast.showError('ปิดใช้งานวันหยุดไม่สำเร็จ', msg);
      setDeactivateTarget(null);
    } finally {
      setDeactivating(false);
    }
  }

  async function openImpactPreview(h: any) {
    setImpactTarget(h);
    setImpactData(null);
    setImpactError(null);
    setImpactLoading(true);
    try {
      const res = await apiRequest(`/holidays/${h.id}/impact-preview`, {
        method: 'POST',
        body: JSON.stringify({
          holidayDate: String(h.holiday_date).slice(0, 10),
          holidayName: h.holiday_name,
          scopeType: h.scope_type,
          departmentName: h.department_name,
          personId: h.person_id,
          overridePolicy: h.override_policy,
        }),
      });
      setImpactData(res);
    } catch (err) {
      setImpactError(err instanceof ApiClientError ? err.message : 'ไม่สามารถวิเคราะห์ผลกระทบวันหยุดได้');
    } finally {
      setImpactLoading(false);
    }
  }

  async function handleReprocessHoliday() {
    if (!impactTarget) return;
    setReprocessing(true);
    setImpactError(null);
    try {
      const res = await apiRequest(`/holidays/${impactTarget.id}/reprocess`, {
        method: 'POST',
        body: JSON.stringify({
          holidayDate: String(impactTarget.holiday_date).slice(0, 10),
          holidayName: impactTarget.holiday_name,
          scopeType: impactTarget.scope_type,
          departmentName: impactTarget.department_name,
          personId: impactTarget.person_id,
          overridePolicy: impactTarget.override_policy,
        }),
      });
      toast.showSuccess(
        'ประมวลผลเวลาตามวันหยุดเรียบร้อยแล้ว',
        `ประมวลผล ${res?.reprocessResult?.totalProcessed ?? 0} รายการ`
      );
      setImpactTarget(null);
      onHolidaysChanged?.();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถประมวลผลเวลาใหม่ได้';
      setImpactError(msg);
      toast.showError('ประมวลผลเวลาใหม่ไม่สำเร็จ', msg);
    } finally {
      setReprocessing(false);
    }
  }

  async function handleExportCsv() {
    try {
      await downloadHolidaysCsv({ year: yearFilter });
      toast.showSuccess('ส่งออกปฏิทินวันหยุด CSV เรียบร้อยแล้ว');
    } catch (err) {
      toast.showError(
        'ส่งออก CSV ไม่สำเร็จ',
        err instanceof ApiClientError ? err.message : undefined
      );
    }
  }

  const calendarModel = useMemo(() => {
    const [yrStr, moStr] = calendarMonth.split('-');
    const yr = Number(yrStr) || Number(initialBkk.currentYear);
    const mo = Number(moStr) || 1;
    const firstWeekday = new Date(Date.UTC(yr, mo - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(yr, mo, 0)).getUTCDate();

    const byDate = new Map<string, any[]>();
    for (const h of holidays) {
      const key = String(h.holiday_date || '').slice(0, 10);
      const list = byDate.get(key) || [];
      list.push(h);
      byDate.set(key, list);
    }

    const cells: Array<{ ymd: string | null; day: number | null; items: any[] }> = [];
    for (let i = 0; i < firstWeekday; i++) {
      cells.push({ ymd: null, day: null, items: [] });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const ymd = `${yr}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      cells.push({ ymd, day: d, items: byDate.get(ymd) || [] });
    }
    const thaiLabel = `${THAI_MONTHS[mo - 1] || ''} พ.ศ. ${yr + 543}`;
    return { yr, mo, thaiLabel, cells };
  }, [calendarMonth, holidays, initialBkk.currentYear]);

  function stepCalendarMonth(delta: number) {
    const dt = new Date(Date.UTC(calendarModel.yr, calendarModel.mo - 1 + delta, 1));
    setCalendarMonth(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`);
  }

  return (
    <div className="space-y-5">
      <div className="his-surface p-4 sm:p-5 space-y-4">
        <SectionHeader
          title="ปฏิทินวันหยุดโรงพยาบาลและข้อยกเว้นรายหน่วยงาน/บุคคล"
          subtitle="ลำดับการมีผล: เฉพาะบุคลากร (PERSON) > เฉพาะหน่วยงาน (DEPARTMENT) > ทั้งโรงพยาบาล (ALL)"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              {canEdit && (
                <>
                  <button
                    type="button"
                    onClick={handleExportCsv}
                    className="ent-btn-secondary whitespace-nowrap"
                  >
                    <Download className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                    <span>ส่งออก CSV</span>
                  </button>
                  <button
                    type="button"
                    onClick={openCreateModal}
                    className="ent-btn-primary whitespace-nowrap"
                  >
                    <Plus className="w-4 h-4" aria-hidden="true" />
                    <span>เพิ่มวันหยุดโรงพยาบาล</span>
                  </button>
                </>
              )}
            </div>
          }
        />

        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 pt-3 border-t border-[#E8E4EF]">
          <div className="flex flex-wrap items-center gap-2.5">
            <select
              aria-label="ปี ค.ศ./พ.ศ."
              value={yearFilter}
              onChange={(e) => {
                setYearFilter(e.target.value);
                setCalendarMonth(`${e.target.value}-${calendarMonth.slice(5)}`);
              }}
              className="ent-input w-auto"
            >
              {[
                String(Number(initialBkk.currentYear) - 1),
                initialBkk.currentYear,
                String(Number(initialBkk.currentYear) + 1),
              ].map((y) => (
                <option key={y} value={y}>
                  พ.ศ. {Number(y) + 543} ({y})
                </option>
              ))}
            </select>

            <select
              aria-label="กรองตามประเภทวันหยุด"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="ent-input w-auto"
            >
              <option value="">ทุกประเภทวันหยุด</option>
              {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>

            <select
              aria-label="กรองตามขอบเขตผลบังคับ"
              value={scopeFilter}
              onChange={(e) => setScopeFilter(e.target.value)}
              className="ent-input w-auto"
            >
              <option value="">ทุกขอบเขต</option>
              {Object.entries(SCOPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={loadHolidays}
              className="ent-btn-secondary"
            >
              <RefreshCw className="w-4 h-4 text-[#777287]" aria-hidden="true" />
              <span>รีเฟรช</span>
            </button>
          </div>

          <div className="ent-tab-bar self-start">
            <button
              type="button"
              onClick={() => setDisplayMode('table')}
              className={`ent-tab-btn inline-flex items-center gap-1.5 ${
                displayMode === 'table' ? 'ent-tab-btn-active' : ''
              }`}
            >
              <List className="w-3.5 h-3.5" aria-hidden="true" />
              <span>ตารางรายการ</span>
            </button>
            <button
              type="button"
              onClick={() => setDisplayMode('calendar')}
              className={`ent-tab-btn inline-flex items-center gap-1.5 ${
                displayMode === 'calendar' ? 'ent-tab-btn-active' : ''
              }`}
            >
              <CalendarDays className="w-3.5 h-3.5" aria-hidden="true" />
              <span>ปฏิทินรายเดือน</span>
            </button>
          </div>
        </div>
      </div>

      <ErrorBanner error={error} onRetry={loadHolidays} />

      {loading ? (
        <div className="his-surface overflow-hidden">
          <TableLoadingSkeleton rows={5} cols={6} />
        </div>
      ) : displayMode === 'calendar' ? (
        <div className="his-surface p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => stepCalendarMonth(-1)}
              className="ent-btn-secondary h-9 px-3 text-[13px]"
            >
              <ChevronLeft className="w-4 h-4" aria-hidden="true" />
              <span>เดือนก่อน</span>
            </button>
            <div className="text-[16px] font-bold text-[#292638]">{calendarModel.thaiLabel}</div>
            <button
              type="button"
              onClick={() => stepCalendarMonth(1)}
              className="ent-btn-secondary h-9 px-3 text-[13px]"
            >
              <span>เดือนถัดไป</span>
              <ChevronRight className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[680px]">
              <div className="grid grid-cols-7 border-t border-l border-[#E8E4EF] bg-[#F8F7FC]">
                {THAI_WEEKDAYS_SHORT.map((d, i) => (
                  <div
                    key={d}
                    className={`py-2 px-2 text-center text-[12.5px] font-bold border-r border-b border-[#E8E4EF] ${
                      i === 0 || i === 6 ? 'text-[#8066B5]' : 'text-[#4E3978]'
                    }`}
                  >
                    {d}
                  </div>
                ))}
              </div>
              <div className="grid grid-cols-7 border-l border-[#E8E4EF]">
                {calendarModel.cells.map((cell, idx) => (
                  <div
                    key={cell.ymd || `blank-${idx}`}
                    className={`min-h-[96px] p-2 border-r border-b border-[#E8E4EF] ${
                      cell.ymd ? 'bg-white' : 'bg-[#F8F7FC]/60'
                    }`}
                  >
                    {cell.day !== null && (
                      <>
                        <div className="text-[12px] font-mono font-bold text-[#777287] tabular-nums mb-1.5">
                          {cell.day}
                        </div>
                        <div className="space-y-1">
                          {cell.items.map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              onClick={() => canEdit && openEditModal(h)}
                              className="w-full text-left px-2 py-1 rounded-md bg-[#F1ECFA] border border-[#D8D1E6] hover:border-[#8066B5] text-[11.5px] leading-tight cursor-pointer"
                            >
                              <div className="font-bold text-[#4E3978] truncate">{h.holiday_name}</div>
                              <div className="text-[10.5px] text-[#777287] truncate">
                                {SCOPE_LABELS[h.scope_type] || h.scope_type} · {h.override_policy}
                              </div>
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="his-surface overflow-hidden">
          <div className="overflow-x-auto">
            <table className="his-table">
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อวันหยุด</th>
                  <th>ประเภท</th>
                  <th>ขอบเขตผลบังคับ</th>
                  <th>นโยบายจัดเวร</th>
                  <th>หมายเหตุ</th>
                  {canEdit && <th className="text-right">จัดการ</th>}
                </tr>
              </thead>
              <tbody>
                {holidays.length === 0 ? (
                  <TableEmptyState
                    colSpan={canEdit ? 7 : 6}
                    title="ยังไม่มีรายการวันหยุดโรงพยาบาลในปีที่เลือก"
                  />
                ) : (
                  holidays.map((h) => {
                    const isLegacy = Number(h.id) >= 1_000_000;
                    return (
                      <tr key={h.id}>
                        <td>
                          <div className="font-semibold text-[#292638]">
                            {formatThaiDate(h.holiday_date)}
                          </div>
                          <div className="font-mono text-[12px] text-[#777287] tabular-nums">
                            {String(h.holiday_date).slice(0, 10)}
                          </div>
                        </td>
                        <td className="font-semibold text-[#292638]">{h.holiday_name}</td>
                        <td className="text-[13px] text-[#292638]">
                          {CATEGORY_LABELS[h.category] || h.category}
                        </td>
                        <td className="text-[13px]">
                          <div className="font-semibold text-[#4E3978]">
                            {SCOPE_LABELS[h.scope_type] || h.scope_type}
                          </div>
                          {h.scope_type === 'DEPARTMENT' && h.department_name && (
                            <div className="text-[12px] text-[#777287]">{h.department_name}</div>
                          )}
                          {h.scope_type === 'PERSON' && h.person_id && (
                            <div className="font-mono text-[12px] text-[#777287]">{h.person_id}</div>
                          )}
                        </td>
                        <td>
                          <StatusBadge
                            tone={
                              h.override_policy === 'EXEMPT' || h.override_policy === 'EXEMPT_ALL'
                                ? 'brand'
                                : h.override_policy === 'WORK_WITH_OT'
                                  ? 'warning'
                                  : 'info'
                            }
                            label={POLICY_LABELS[h.override_policy] || h.override_policy}
                            compact
                          />
                        </td>
                        <td className="text-[12.5px] text-[#777287] max-w-[220px] truncate">
                          {h.notes || '—'}
                        </td>
                        {canEdit && (
                          <td className="text-right whitespace-nowrap space-x-1.5">
                            <button
                              type="button"
                              onClick={() => openImpactPreview(h)}
                              className="ent-btn-secondary h-8 px-2.5 text-[12px]"
                              title="วิเคราะห์ผลกระทบและประมวลผลใหม่"
                            >
                              <Eye className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                              <span>ผลกระทบ</span>
                            </button>
                            {!isLegacy && (
                              <button
                                type="button"
                                onClick={() => openEditModal(h)}
                                className="ent-btn-secondary h-8 px-2.5 text-[12px]"
                                title="แก้ไขวันหยุด"
                              >
                                <Pencil className="w-3.5 h-3.5 text-[#4E3978]" aria-hidden="true" />
                                <span>แก้ไข</span>
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setDeactivateTarget(h)}
                              className="h-8 px-2.5 rounded-md border border-[#C74455]/30 bg-[#FDF2F4] hover:bg-[#FCE6EA] text-[#C74455] text-[12px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                            >
                              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                              <span>ปิดใช้</span>
                            </button>
                          </td>
                        )}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create / Edit Holiday Modal */}
      <SharedModal
        open={formModalOpen}
        onClose={() => !saving && setFormModalOpen(false)}
        kickerText="ปฏิทินวันหยุดโรงพยาบาล"
        title={editingHoliday ? 'แก้ไขข้อมูลวันหยุดโรงพยาบาล' : 'เพิ่มวันหยุดโรงพยาบาลใหม่'}
        maxWidthClass="max-w-lg"
      >
        <form onSubmit={handleSaveHoliday} className="space-y-4">
          {formError && (
            <div className="p-3 rounded-lg bg-[#FDF2F4] border border-[#C74455]/30 text-[13px] text-[#C74455] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{formError}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                วันที่ <RequiredMark />
              </label>
              <input
                type="date"
                required
                value={holidayDate}
                onChange={(e) => setHolidayDate(e.target.value)}
                className="ent-input w-full"
              />
            </div>
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                ประเภทวันหยุด <RequiredMark />
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="ent-input w-full"
              >
                {Object.entries(CATEGORY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-[13px] font-semibold text-[#292638] mb-1">
              ชื่อวันหยุด <RequiredMark />
            </label>
            <input
              type="text"
              required
              value={holidayName}
              onChange={(e) => setHolidayName(e.target.value)}
              placeholder="เช่น วันขึ้นปีใหม่, วันหยุดประกาศโรงพยาบาล"
              className="ent-input w-full"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                ขอบเขตผลบังคับ <RequiredMark />
              </label>
              <select
                value={scopeType}
                onChange={(e) => setScopeType(e.target.value as 'ALL' | 'DEPARTMENT' | 'PERSON')}
                className="ent-input w-full"
              >
                <option value="ALL">ทั้งโรงพยาบาล (ALL)</option>
                <option value="DEPARTMENT">เฉพาะหน่วยงาน (DEPARTMENT)</option>
                <option value="PERSON">เฉพาะบุคลากร (PERSON)</option>
              </select>
            </div>

            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                นโยบายการจัดเวร <RequiredMark />
              </label>
              <select
                value={overridePolicy}
                onChange={(e) =>
                  setOverridePolicy(e.target.value as 'EXEMPT' | 'WORK_WITH_OT' | 'MANDATORY_SHIFT')
                }
                className="ent-input w-full"
              >
                <option value="EXEMPT">ยกเว้นเวรอัตโนมัติ (EXEMPT)</option>
                <option value="WORK_WITH_OT">ปฏิบัติงาน/คิด OT (WORK_WITH_OT)</option>
                <option value="MANDATORY_SHIFT">ต้องขึ้นเวรตามปกติ (MANDATORY_SHIFT)</option>
              </select>
            </div>
          </div>

          {scopeType === 'DEPARTMENT' && (
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                เลือกกลุ่มงาน / หน่วยงาน <RequiredMark />
              </label>
              <select
                required
                value={departmentName}
                onChange={(e) => setDepartmentName(e.target.value)}
                className="ent-input w-full"
              >
                <option value="">-- เลือกหน่วยงาน --</option>
                {departments.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </div>
          )}

          {scopeType === 'PERSON' && (
            <div>
              <label className="block text-[13px] font-semibold text-[#292638] mb-1">
                เลือกบุคลากร <RequiredMark />
              </label>
              <select
                required
                value={personId}
                onChange={(e) => setPersonId(e.target.value)}
                className="ent-input w-full"
              >
                <option value="">-- เลือกบุคลากร --</option>
                {personnel.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {p.person_id} · {p.full_name} ({p.department_name || '-'})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-[13px] font-semibold text-[#292638] mb-1">
              หมายเหตุเพิ่มเติม
            </label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="คำอธิบายหรือเลขที่คำสั่งโรงพยาบาล..."
              className="ent-input w-full py-2"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-[#E8E4EF]">
            <button
              type="button"
              onClick={() => setFormModalOpen(false)}
              disabled={saving}
              className="ent-btn-secondary"
            >
              ยกเลิก
            </button>
            <button type="submit" disabled={saving} className="ent-btn-primary">
              {saving ? 'กำลังบันทึก...' : 'บันทึกวันหยุด'}
            </button>
          </div>
        </form>
      </SharedModal>

      {/* Impact Preview & Reprocess Modal */}
      <SharedModal
        open={Boolean(impactTarget)}
        onClose={() => !reprocessing && setImpactTarget(null)}
        kickerText="วิเคราะห์ผลกระทบวันหยุดต่อตารางเวรและเวลาปฏิบัติงาน"
        title={
          impactTarget
            ? `${impactTarget.holiday_name} (${formatThaiDate(impactTarget.holiday_date)})`
            : ''
        }
        maxWidthClass="max-w-xl"
      >
        <div className="space-y-4">
          {impactLoading ? (
            <TableLoadingSkeleton rows={3} cols={3} />
          ) : impactError ? (
            <div className="p-3.5 rounded-lg bg-[#FDF2F4] border border-[#C74455]/30 text-[13.5px] text-[#C74455] flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{impactError}</span>
            </div>
          ) : impactData ? (
            <>
              {impactData.periodClosed && (
                <div className="p-3.5 rounded-lg bg-[#FDF2F4] border border-[#C74455]/30 text-[13px] text-[#C74455] flex items-start gap-2">
                  <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    งวดเดือน {impactData.periodYm} ปิดรอบบัญชีเวลาแล้ว จึงไม่สามารถสั่งประมวลผลเวลาใหม่ในวันนี้ได้
                  </span>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3 border border-[#E8E4EF] rounded-xl divide-x divide-[#E8E4EF] bg-[#F8F7FC]">
                <div className="p-3.5">
                  <div className="text-[12px] text-[#777287]">รายการลงเวลาที่เกี่ยวข้อง</div>
                  <div className="text-[20px] font-bold font-mono text-[#292638] tabular-nums mt-0.5">
                    {impactData.affectedAttendanceCount}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="text-[12px] text-[#777287]">เวรที่จัดไว้แล้ว</div>
                  <div className="text-[20px] font-bold font-mono text-[#4E3978] tabular-nums mt-0.5">
                    {impactData.explicitShiftAssignmentCount}
                  </div>
                </div>
                <div className="p-3.5">
                  <div className="text-[12px] text-[#777287]">HR ตรวจแล้ว</div>
                  <div className="text-[20px] font-bold font-mono text-[#198568] tabular-nums mt-0.5">
                    {impactData.reviewedRecordsCount}
                  </div>
                </div>
              </div>

              {Array.isArray(impactData.sampleAffectedAttendance) &&
                impactData.sampleAffectedAttendance.length > 0 && (
                  <div className="border border-[#E8E4EF] rounded-xl overflow-hidden max-h-60 overflow-y-auto">
                    <table className="his-table">
                      <thead>
                        <tr>
                          <th>บุคลากร</th>
                          <th>หน่วยงาน</th>
                          <th>กะ</th>
                          <th>สถานะ</th>
                        </tr>
                      </thead>
                      <tbody>
                        {impactData.sampleAffectedAttendance.map((a: any) => (
                          <tr key={a.id}>
                            <td className="font-medium text-[#292638]">{a.full_name}</td>
                            <td className="text-[12.5px] text-[#777287]">{a.department_name}</td>
                            <td className="font-mono text-[12.5px]">{a.shift_code || '—'}</td>
                            <td className="font-mono text-[12.5px]">{a.status}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

              <div className="flex justify-end gap-2 pt-2 border-t border-[#E8E4EF]">
                <button
                  type="button"
                  onClick={() => setImpactTarget(null)}
                  disabled={reprocessing}
                  className="ent-btn-secondary"
                >
                  ปิดหน้าต่าง
                </button>
                <button
                  type="button"
                  disabled={!impactData.canReprocess || reprocessing}
                  onClick={handleReprocessHoliday}
                  className="ent-btn-primary"
                >
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                  <span>
                    {reprocessing ? 'กำลังประมวลผลใหม่...' : 'ยืนยันประมวลผลเวลาใหม่ในวันนี้'}
                  </span>
                </button>
              </div>
            </>
          ) : null}
        </div>
      </SharedModal>

      <ConfirmDialog
        open={Boolean(deactivateTarget)}
        onCancel={() => !deactivating && setDeactivateTarget(null)}
        onConfirm={handleConfirmDeactivate}
        title="ยืนยันการปิดใช้งานวันหยุด"
        description={
          deactivateTarget
            ? `ต้องการปิดใช้งานวันหยุด "${deactivateTarget.holiday_name}" (${formatThaiDate(deactivateTarget.holiday_date)}) ใช่หรือไม่?`
            : ''
        }
        confirmLabel={deactivating ? 'กำลังดำเนินการ...' : 'ยืนยันปิดใช้งาน'}
        cancelLabel="ยกเลิก"
        variant="danger"
        loading={deactivating}
      />
    </div>
  );
}
