/**
 * ============================================================================
 * หน้าต่าง Modal Popup สำหรับกำหนด/แก้ไขกะเริ่มต้นตามประเภทบุคลากร
 * ไฟล์: frontend/src/components/shifts/PersonnelTypeDefaultModal.tsx
 * ============================================================================
 * เป็นจุดเดียวในการตั้งค่า Default Shift ของแต่ละประเภทบุคลากร:
 * - เลือกแม่แบบกะเริ่มต้นจากรายการแม่แบบกะจริงที่เปิดใช้งาน (ได้สูงสุด 1 กะต่อประเภท)
 * - หรือเลือก "ไม่กำหนดกะเริ่มต้น" (เมื่อไม่มีตารางเวรรายวันจะแสดง "ยังไม่กำหนดกะ")
 * - กำหนดวันทำงานที่ให้ใช้กะเริ่มต้น (เช่น จันทร์–ศุกร์, จันทร์–เสาร์, ทุกวัน หรือเลือกวันเอง)
 * - บันทึกผู้แก้ไขและเวลาใน Audit Log โดยไม่ลบแม่แบบกะเดิม ไม่เปลี่ยนตารางเวรย้อนหลัง
 *   ไม่แก้ไขผล Attendance ที่ประมวลผลแล้ว และไม่แตะข้อมูลสแกนดิบ
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Loader2,
  Save,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react';
import { apiRequest, ApiClientError } from '../../services/api.ts';
import { ErrorBanner } from '../StatusText.tsx';
import {
  ConfirmDialog,
  RequiredMark,
  SharedModal,
} from '../common/SharedComponents.tsx';
import { cleanShiftDisplayName } from '../../utils/shiftDisplay.ts';
import {
  formatDefaultWorkdaysThai,
  isPersonnelTypeDefaultFormDirty,
  parseWorkdaysCsv,
  serializeWorkdays,
  validatePersonnelTypeDefaultForm,
  WEEKDAY_OPTIONS,
  WORKDAY_PRESETS,
  type PersonnelTypeDefaultFieldKey,
  type PersonnelTypeDefaultFormValues,
} from '../../utils/shiftTemplateForm.ts';

export interface PersonnelTypeDefaultModalProps {
  open: boolean;
  rule: any | null;
  activeShifts: any[];
  onClose: () => void;
  onSaved: (summary: {
    personnelTypeCode: string;
    personnelTypeName: string;
    defaultShiftName: string | null;
    defaultWorkdaysLabel: string;
  }) => void;
  onErrorToast: (err: { message: string; detail?: string; requestId?: string }) => void;
}

function createInitialValues(rule: any | null): PersonnelTypeDefaultFormValues {
  if (!rule) {
    return {
      personnelTypeName: '',
      defaultShiftId: null,
      defaultWorkdays: [1, 2, 3, 4, 5, 6, 0],
      effectiveFrom: '2026-01-01',
      reason: '',
      isActive: true,
    };
  }
  const hasDefault =
    rule.default_shift_id !== null &&
    rule.default_shift_id !== undefined &&
    Number(rule.default_shift_id) > 0;
  return {
    personnelTypeName: String(rule.personnel_type_name || '').trim(),
    defaultShiftId: hasDefault ? Number(rule.default_shift_id) : null,
    defaultWorkdays: parseWorkdaysCsv(rule.default_workdays),
    effectiveFrom: String(rule.effective_from || '2026-01-01').slice(0, 10),
    reason: '',
    isActive: Number(rule.is_active ?? 1) === 1,
  };
}

export function PersonnelTypeDefaultModal({
  open,
  rule,
  activeShifts,
  onClose,
  onSaved,
  onErrorToast,
}: PersonnelTypeDefaultModalProps) {
  const [initialValues, setInitialValues] = useState<PersonnelTypeDefaultFormValues>(() =>
    createInitialValues(rule)
  );
  const [values, setValues] = useState<PersonnelTypeDefaultFormValues>(() =>
    createInitialValues(rule)
  );
  const [fieldErrors, setFieldErrors] = useState<
    Partial<Record<PersonnelTypeDefaultFieldKey, string>>
  >({});
  const [submitError, setSubmitError] = useState<{
    code?: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);

  const submittingRef = useRef(false);

  useEffect(() => {
    if (!open) {
      setDiscardConfirmOpen(false);
      setOverwriteConfirmOpen(false);
      return;
    }
    const nextInit = createInitialValues(rule);
    setInitialValues(nextInit);
    setValues(nextInit);
    setFieldErrors({});
    setSubmitError(null);
    setDiscardConfirmOpen(false);
    setOverwriteConfirmOpen(false);
  }, [open, rule?.id, rule?.default_shift_id, rule?.default_workdays]);

  const isDirty = useMemo(
    () => isPersonnelTypeDefaultFormDirty(initialValues, values),
    [initialValues, values]
  );

  const selectedShift = useMemo(
    () =>
      values.defaultShiftId !== null
        ? activeShifts.find((s) => Number(s.id) === Number(values.defaultShiftId)) || null
        : null,
    [activeShifts, values.defaultShiftId]
  );

  const previousShiftName = useMemo(() => {
    if (!rule || !rule.default_shift_id) return null;
    if (rule.default_shift_name) {
      return `${cleanShiftDisplayName(rule.default_shift_name)} (${rule.default_shift_code || ''})`;
    }
    const matched = activeShifts.find((s) => Number(s.id) === Number(rule.default_shift_id));
    return matched
      ? `${cleanShiftDisplayName(matched.shift_name)} (${matched.shift_code})`
      : `รหัสกะ #${rule.default_shift_id}`;
  }, [rule, activeShifts]);

  const currentWorkdaysCsv = useMemo(
    () => serializeWorkdays(values.defaultWorkdays),
    [values.defaultWorkdays]
  );

  const currentWorkdaysLabel = useMemo(
    () => formatDefaultWorkdaysThai(currentWorkdaysCsv),
    [currentWorkdaysCsv]
  );

  function toggleWeekday(dayVal: number) {
    setValues((prev) => {
      const exists = prev.defaultWorkdays.includes(dayVal);
      const nextDays = exists
        ? prev.defaultWorkdays.filter((d) => d !== dayVal)
        : [...prev.defaultWorkdays, dayVal];
      return {
        ...prev,
        defaultWorkdays: parseWorkdaysCsv(serializeWorkdays(nextDays)),
      };
    });
    if (fieldErrors.defaultWorkdays) {
      setFieldErrors((prev) => {
        const copy = { ...prev };
        delete copy.defaultWorkdays;
        return copy;
      });
    }
    if (submitError) setSubmitError(null);
  }

  function applyWorkdayPreset(days: number[]) {
    setValues((prev) => ({
      ...prev,
      defaultWorkdays: [...days],
    }));
    if (fieldErrors.defaultWorkdays) {
      setFieldErrors((prev) => {
        const copy = { ...prev };
        delete copy.defaultWorkdays;
        return copy;
      });
    }
    if (submitError) setSubmitError(null);
  }

  function handleRequestClose() {
    if (saving || submittingRef.current) return;
    if (isDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }

  async function executeSave() {
    if (!rule?.id || saving || submittingRef.current) return;

    submittingRef.current = true;
    setSaving(true);
    setSubmitError(null);

    try {
      await apiRequest(`/personnel-type-rules/${rule.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          personnelTypeName: values.personnelTypeName.trim(),
          defaultShiftId: values.defaultShiftId,
          defaultWorkdays:
            values.defaultShiftId !== null ? currentWorkdaysCsv : '1,2,3,4,5,6,0',
          effectiveFrom: values.effectiveFrom,
          reason: values.reason.trim() || undefined,
          isActive: values.isActive,
        }),
      });

      onSaved({
        personnelTypeCode: String(rule.personnel_type_code || '').trim().toUpperCase(),
        personnelTypeName: values.personnelTypeName.trim(),
        defaultShiftName: selectedShift ? cleanShiftDisplayName(selectedShift.shift_name) : null,
        defaultWorkdaysLabel:
          values.defaultShiftId !== null ? currentWorkdaysLabel : 'ไม่กำหนดกะเริ่มต้น',
      });
    } catch (err) {
      if (err instanceof ApiClientError) {
        setSubmitError({
          code: err.code,
          message: err.message,
          requestId: err.requestId,
        });
        onErrorToast({
          message: 'ไม่สามารถบันทึกกะเริ่มต้นตามประเภทบุคลากรได้',
          detail: err.message,
          requestId: err.requestId,
        });
      } else {
        const fallbackMsg =
          err instanceof Error && err.message
            ? err.message
            : 'เกิดข้อผิดพลาดในการบันทึกกะเริ่มต้น กรุณาลองใหม่อีกครั้ง';
        setSubmitError({ message: fallbackMsg });
        onErrorToast({
          message: 'ไม่สามารถบันทึกกะเริ่มต้นตามประเภทบุคลากรได้',
          detail: fallbackMsg,
        });
      }
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || submittingRef.current) return;

    const validation = validatePersonnelTypeDefaultForm(values);
    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      setSubmitError({
        code: 'VALIDATION_ERROR',
        message:
          validation.formError || 'กรุณาตรวจสอบข้อมูลการตั้งค่ากะเริ่มต้นให้ครบถ้วนก่อนบันทึก',
      });
      return;
    }

    const hadPreviousDefault = initialValues.defaultShiftId !== null;
    const isChangingDefault =
      (initialValues.defaultShiftId ?? null) !== (values.defaultShiftId ?? null);

    if (hadPreviousDefault && isChangingDefault) {
      setOverwriteConfirmOpen(true);
      return;
    }

    void executeSave();
  }

  const ruleCode = String(rule?.personnel_type_code || '').trim().toUpperCase();
  const modalTitle = rule
    ? `กำหนดกะเริ่มต้น: ${rule.personnel_type_name}`
    : 'กำหนดกะเริ่มต้นตามประเภทบุคลากร';

  return (
    <>
      <SharedModal
        open={open && Boolean(rule)}
        onClose={handleRequestClose}
        kickerText={`กะเริ่มต้นตามประเภทบุคลากร · รหัส ${ruleCode}`}
        title={modalTitle}
        maxWidthClass="max-w-[760px]"
        hideDefaultCloseButton
        disableEscapeClose={saving || discardConfirmOpen || overwriteConfirmOpen}
        closeOnBackdrop={!saving && !discardConfirmOpen && !overwriteConfirmOpen}
        overlayClassName="bg-black/45 backdrop-blur-[1px]"
        footerHint={
          isDirty
            ? 'มีการแก้ไขข้อมูลที่ยังไม่บันทึก'
            : 'เลือกแม่แบบกะเริ่มต้นและวันทำงานที่มีผล หรือเลือก "ไม่กำหนดกะเริ่มต้น"'
        }
        footer={
          <>
            <button
              type="button"
              disabled={saving}
              onClick={handleRequestClose}
              className="h-10 px-4 rounded-lg border border-[#D8D1E6] bg-white hover:bg-[#F8F7FC] disabled:opacity-50 text-[#292638] text-[13.5px] font-semibold transition-colors"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              form="personnel-type-default-modal-form"
              disabled={saving}
              className="h-10 px-5 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] disabled:opacity-60 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors shadow-xs"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>กำลังบันทึก...</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" aria-hidden="true" />
                  <span>บันทึกกะเริ่มต้น</span>
                </>
              )}
            </button>
          </>
        }
      >
        <form
          id="personnel-type-default-modal-form"
          noValidate
          onSubmit={handleSubmit}
          className="space-y-5 text-[13.5px]"
        >
          {submitError && <ErrorBanner error={submitError} />}

          {/* สรุปสถานะปัจจุบัน */}
          <div className="rounded-lg border border-[#E8E4EF] bg-[#F8F7FC] px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <div className="text-[12px] font-semibold text-[#777287]">กะเริ่มต้นปัจจุบัน</div>
              <div className="text-[13.5px] font-bold text-[#292638] mt-0.5">
                {previousShiftName ? previousShiftName : 'ยังไม่กำหนดกะเริ่มต้น'}
              </div>
            </div>
            <div className="text-left sm:text-right">
              <div className="text-[12px] font-semibold text-[#777287]">วันทำงานที่มีผลเดิม</div>
              <div className="text-[13px] font-semibold text-[#4E3978] mt-0.5">
                {previousShiftName
                  ? formatDefaultWorkdaysThai(rule?.default_workdays)
                  : '—'}
              </div>
            </div>
          </div>

          {/* ชื่อประเภทบุคลากรและวันที่มีผล */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label
                htmlFor="ptd-type-name"
                className="block text-[13px] font-semibold text-[#292638] mb-1.5"
              >
                ชื่อประเภทบุคลากร <RequiredMark />
              </label>
              <input
                id="ptd-type-name"
                type="text"
                disabled={saving}
                value={values.personnelTypeName}
                onChange={(e) => {
                  setValues((prev) => ({ ...prev, personnelTypeName: e.target.value }));
                  if (fieldErrors.personnelTypeName) {
                    setFieldErrors((prev) => ({ ...prev, personnelTypeName: undefined }));
                  }
                }}
                className={`w-full h-10 px-3 rounded-lg border bg-white text-[13.5px] text-[#292638] focus:outline-none focus:ring-2 ${
                  fieldErrors.personnelTypeName
                    ? 'border-[#C74455] focus:ring-[#C74455]/20'
                    : 'border-[#D8D1E6] focus:border-[#8066B5] focus:ring-[#8066B5]/20'
                }`}
              />
              {fieldErrors.personnelTypeName && (
                <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                  {fieldErrors.personnelTypeName}
                </p>
              )}
            </div>

            <div>
              <label
                htmlFor="ptd-effective-from"
                className="block text-[13px] font-semibold text-[#292638] mb-1.5"
              >
                วันที่มีผลบังคับใช้ <RequiredMark />
              </label>
              <input
                id="ptd-effective-from"
                type="date"
                disabled={saving}
                value={values.effectiveFrom}
                onChange={(e) => {
                  setValues((prev) => ({ ...prev, effectiveFrom: e.target.value }));
                  if (fieldErrors.effectiveFrom) {
                    setFieldErrors((prev) => ({ ...prev, effectiveFrom: undefined }));
                  }
                }}
                className={`w-full h-10 px-3 rounded-lg border bg-white text-[13.5px] font-mono tabular-nums text-[#292638] focus:outline-none focus:ring-2 ${
                  fieldErrors.effectiveFrom
                    ? 'border-[#C74455] focus:ring-[#C74455]/20'
                    : 'border-[#D8D1E6] focus:border-[#8066B5] focus:ring-[#8066B5]/20'
                }`}
              />
              {fieldErrors.effectiveFrom && (
                <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                  {fieldErrors.effectiveFrom}
                </p>
              )}
            </div>
          </div>

          {/* เลือกแม่แบบกะเริ่มต้น (ได้สูงสุด 1 กะ หรือไม่กำหนด) */}
          <div className="space-y-2">
            <label
              htmlFor="ptd-default-shift"
              className="text-[13px] font-bold text-[#4E3978] flex items-center gap-1.5"
            >
              <Clock className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>เลือกแม่แบบกะเริ่มต้นสำหรับประเภทบุคลากรนี้</span>
            </label>
            <select
              id="ptd-default-shift"
              disabled={saving}
              value={values.defaultShiftId !== null ? String(values.defaultShiftId) : ''}
              onChange={(e) => {
                const raw = e.target.value;
                const nextId = raw ? Number(raw) : null;
                setValues((prev) => ({
                  ...prev,
                  defaultShiftId: nextId,
                  defaultWorkdays:
                    nextId !== null && prev.defaultWorkdays.length === 0
                      ? [1, 2, 3, 4, 5]
                      : prev.defaultWorkdays,
                }));
                if (submitError) setSubmitError(null);
              }}
              className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13.5px] text-[#292638] focus:outline-none focus:border-[#8066B5] focus:ring-2 focus:ring-[#8066B5]/20"
            >
              <option value="">-- ไม่กำหนดกะเริ่มต้น (ต้องจัดตารางเวรรายบุคคล) --</option>
              {activeShifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {cleanShiftDisplayName(s.shift_name)} ({s.shift_code}) — {s.start_time}–
                  {s.end_time} น. (ผ่อนผัน {s.grace_minutes} นาที)
                </option>
              ))}
            </select>

            {selectedShift ? (
              <div className="rounded-lg border border-[#D8D1E6] bg-[#F1ECFA]/60 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2 text-[12.5px]">
                <div className="flex items-center gap-2 text-[#4E3978] font-semibold">
                  <CheckCircle2 className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
                  <span>
                    {cleanShiftDisplayName(selectedShift.shift_name)} ({selectedShift.shift_code})
                  </span>
                </div>
                <span className="font-mono tabular-nums text-[#292638] font-semibold">
                  {selectedShift.start_time}–{selectedShift.end_time} น. · ผ่อนผัน{' '}
                  {selectedShift.grace_minutes} นาที · ตัดรอบ {selectedShift.cutoff_time} น.
                </span>
              </div>
            ) : (
              <p className="text-[12px] text-[#777287] leading-relaxed">
                เมื่อเลือก “ไม่กำหนดกะเริ่มต้น” บุคลากรในประเภทนี้จะแสดงสถานะ{' '}
                <strong className="text-[#292638]">“ยังไม่กำหนดกะ”</strong> ในวันที่ไม่มีตารางเวรรายบุคคล
                และระบบจะไม่คำนวณเป็น NO_SCAN หรือ LATE โดยอัตโนมัติ
              </p>
            )}
          </div>

          {/* วันทำงานที่ให้ใช้กะเริ่มต้น */}
          <div
            className={`rounded-xl border p-4 space-y-3 ${
              values.defaultShiftId === null
                ? 'border-[#E8E4EF] bg-[#FAF9FD] opacity-65'
                : fieldErrors.defaultWorkdays
                  ? 'border-[#C74455] bg-[#FFFBFB]'
                  : 'border-[#D8D1E6] bg-[#F8F7FC]'
            }`}
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div className="text-[13px] font-bold text-[#292638] flex items-center gap-1.5">
                <CalendarDays className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                <span>วันทำงานที่ให้ใช้กะเริ่มต้น</span>
              </div>
              {values.defaultShiftId !== null && (
                <span className="text-[12px] font-semibold text-[#4E3978]">
                  ที่เลือก: {currentWorkdaysLabel}
                </span>
              )}
            </div>

            {/* ปุ่มชุดวันทำงานมาตรฐาน */}
            <div className="flex flex-wrap gap-2">
              {WORKDAY_PRESETS.map((preset) => {
                const isSelected = currentWorkdaysCsv === preset.csv;
                return (
                  <button
                    key={preset.key}
                    type="button"
                    disabled={saving || values.defaultShiftId === null}
                    onClick={() => applyWorkdayPreset(preset.days)}
                    className={`h-8 px-3 rounded-lg text-[12px] font-semibold border transition-colors ${
                      isSelected && values.defaultShiftId !== null
                        ? 'bg-[#8066B5] border-[#8066B5] text-white'
                        : 'bg-white border-[#D8D1E6] text-[#292638] hover:border-[#8066B5] hover:bg-[#F1ECFA]/40'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>

            {/* เลือกวันรายวัน */}
            <div className="grid grid-cols-7 gap-1.5">
              {WEEKDAY_OPTIONS.map((day) => {
                const checked = values.defaultWorkdays.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    disabled={saving || values.defaultShiftId === null}
                    onClick={() => toggleWeekday(day.value)}
                    aria-pressed={checked}
                    className={`h-10 rounded-lg border text-[13px] font-semibold transition-colors ${
                      checked && values.defaultShiftId !== null
                        ? 'bg-[#F1ECFA] border-[#8066B5] text-[#4E3978]'
                        : 'bg-white border-[#D8D1E6] text-[#777287] hover:border-[#8066B5]/60'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                    title={day.fullLabel}
                  >
                    {day.shortLabel}
                  </button>
                );
              })}
            </div>

            {fieldErrors.defaultWorkdays ? (
              <p className="text-[12px] text-[#C74455] font-medium" role="alert">
                {fieldErrors.defaultWorkdays}
              </p>
            ) : (
              <p className="text-[11.5px] text-[#777287] leading-relaxed">
                วันที่ไม่อยู่ในวันทำงานที่เลือก วันหยุดราชการ วันหยุดเฉพาะบุคคล และวันที่ยกเลิกเวร
                จะไม่ถูกนำกะเริ่มต้นไปทับ (ยกเว้นมีการจัดตารางเวรรายบุคคลโดยเฉพาะ)
              </p>
            )}
          </div>

          {/* เหตุผลในการแก้ไข (Audit Log) */}
          <div>
            <label
              htmlFor="ptd-reason"
              className="text-[13px] font-semibold text-[#292638] mb-1.5 flex items-center gap-1.5"
            >
              <SlidersHorizontal className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
              <span>เหตุผลในการเปลี่ยนแปลง (บันทึกผู้แก้ไขและเวลาลง Audit Log — ไม่บังคับ)</span>
            </label>
            <input
              id="ptd-reason"
              type="text"
              maxLength={300}
              disabled={saving}
              value={values.reason}
              onChange={(e) => setValues((prev) => ({ ...prev, reason: e.target.value }))}
              placeholder="เช่น ปรับกะเริ่มต้นกลุ่มข้าราชการเป็นเวรราชการ จันทร์–ศุกร์"
              className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5] focus:ring-2 focus:ring-[#8066B5]/20"
            />
          </div>

          {/* ข้อความยืนยันความปลอดภัยต่อข้อมูลย้อนหลัง */}
          <div className="rounded-lg border border-[#D8D1E6] bg-[#FAF9FD] px-3.5 py-2.5 flex items-start gap-2.5 text-[12px] text-[#5D576E] leading-relaxed">
            <ShieldCheck className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              การเปลี่ยนกะเริ่มต้นจะไม่ลบแม่แบบกะเดิม ไม่แก้ไขตารางเวรรายบุคคลย้อนหลัง
              ไม่ปรับผลเวลาทำงานที่ประมวลผลแล้วโดยอัตโนมัติ และไม่แก้ไขข้อมูลสแกนดิบ
              (หากต้องการคำนวณย้อนหลังให้สั่ง Reprocess ผ่านหน้าประมวลผลโดยผู้มีสิทธิ์)
            </span>
          </div>
        </form>
      </SharedModal>

      {/* ยืนยันก่อนเปลี่ยนหรือล้างกะเริ่มต้นเดิม */}
      <ConfirmDialog
        open={overwriteConfirmOpen}
        variant={values.defaultShiftId === null ? 'warning' : 'primary'}
        title={
          values.defaultShiftId === null
            ? 'ยืนยันการยกเลิกกะเริ่มต้นของประเภทบุคลากรนี้'
            : 'ยืนยันการเปลี่ยนกะเริ่มต้น'
        }
        description={
          values.defaultShiftId === null
            ? `ประเภทบุคลากร "${values.personnelTypeName}" จะเปลี่ยนจาก "${previousShiftName}" เป็น "ไม่กำหนดกะเริ่มต้น" โดยไม่กระทบตารางเวรรายบุคคลและข้อมูลย้อนหลัง ต้องการดำเนินการต่อหรือไม่?`
            : `ประเภทบุคลากร "${values.personnelTypeName}" จะเปลี่ยนกะเริ่มต้นจาก "${previousShiftName}" เป็น "${
                selectedShift ? cleanShiftDisplayName(selectedShift.shift_name) : ''
              }" (${currentWorkdaysLabel}) โดยไม่ลบแม่แบบกะเดิมและไม่แก้ข้อมูลย้อนหลัง ต้องการบันทึกหรือไม่?`
        }
        confirmLabel={
          values.defaultShiftId === null ? 'ยืนยันไม่กำหนดกะเริ่มต้น' : 'ยืนยันเปลี่ยนกะเริ่มต้น'
        }
        cancelLabel="กลับไปตรวจสอบ"
        loading={saving}
        onConfirm={() => {
          setOverwriteConfirmOpen(false);
          void executeSave();
        }}
        onCancel={() => setOverwriteConfirmOpen(false)}
      />

      {/* ยืนยันก่อนปิดเมื่อมีการแก้ไขค้างไว้ */}
      <ConfirmDialog
        open={discardConfirmOpen}
        variant="warning"
        title="มีข้อมูลที่แก้ไขแต่ยังไม่บันทึก"
        description="คุณต้องการปิดหน้าต่างนี้และละทิ้งการเปลี่ยนแปลงที่ยังไม่ได้บันทึกหรือไม่?"
        confirmLabel="ปิดโดยไม่บันทึก"
        cancelLabel="กลับไปแก้ไขต่อ"
        onConfirm={() => {
          setDiscardConfirmOpen(false);
          onClose();
        }}
        onCancel={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}
