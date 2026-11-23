/**
 * ============================================================================
 * หน้าต่าง Modal Popup สำหรับเพิ่มและแก้ไขแม่แบบกะทำงาน (Unified Shift Template Modal)
 * ไฟล์: frontend/src/components/shifts/ShiftTemplateModal.tsx
 * ============================================================================
 * รองรับทั้งโหมดสร้างแม่แบบกะใหม่ (Create) และแก้ไขแม่แบบกะเดิม (Edit) ใน Modal เดียวกัน:
 * - ความกว้างเหมาะสม 780px บน Desktop และปรับสัดส่วน Responsive บนมือถือ
 * - ปิดด้วยปุ่ม X, ปุ่มยกเลิก, คลิกพื้นหลัง หรือปุ่ม ESC พร้อมเตือนยืนยันเมื่อมีข้อมูลค้างยังไม่บันทึก
 * - ป้องกันการกดบันทึกซ้ำ (Disable ปุ่มและล็อกระหว่างกำลังส่งคำขอไปยัง API)
 * - ตรวจสอบ Required Fields และรูปแบบเวลา พร้อมข้อความผิดพลาดระดับฟิลด์ชัดเจน
 * - หากบันทึกล้มเหลว Modal จะไม่ปิดและคงค่าที่ผู้ใช้กรอกไว้ทั้งหมด
 * - รักษากฎ Default Shift Governance ครบถ้วนทั้งฝั่ง Create และ Edit
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Clock,
  Loader2,
  Lock,
  Moon,
  Plus,
  Save,
  ShieldCheck,
  Star,
  Sun,
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
  createInitialShiftTemplateFormValues,
  isShiftTemplateFormDirty,
  mapShiftTemplateApiErrorToFields,
  validateShiftTemplateForm,
  type ActiveDefaultBindingInfo,
  type ShiftTemplateFieldErrors,
  type ShiftTemplateFieldKey,
  type ShiftTemplateFormValues,
  type ShiftTemplateModalMode,
} from '../../utils/shiftTemplateForm.ts';

export interface ShiftTemplateModalProps {
  open: boolean;
  mode: ShiftTemplateModalMode;
  initialShift: any | null;
  personnelTypeRules: any[];
  defaultBindingByTypeCode: Map<string, ActiveDefaultBindingInfo>;
  onClose: () => void;
  onSaved: (summary: {
    mode: ShiftTemplateModalMode;
    shiftName: string;
    shiftCode: string;
    isDefaultBound: boolean;
  }) => void;
  onErrorToast: (err: { message: string; detail?: string; requestId?: string }) => void;
  onRequestChangeDefault: (options: { scopeCode?: string; shiftId?: number }) => void;
}

const INPUT_BASE_CLASS =
  'w-full h-10 px-3 rounded-lg border bg-white text-[13.5px] text-[#292638] transition-colors focus:outline-none focus:ring-2';

function getInputClass(hasError: boolean, extra = ''): string {
  return `${INPUT_BASE_CLASS} ${
    hasError
      ? 'border-[#C74455] focus:border-[#C74455] focus:ring-[#C74455]/20 bg-[#FFFBFB]'
      : 'border-[#D8D1E6] focus:border-[#8066B5] focus:ring-[#8066B5]/20'
  } ${extra}`;
}

export function ShiftTemplateModal({
  open,
  mode,
  initialShift,
  personnelTypeRules,
  defaultBindingByTypeCode,
  onClose,
  onSaved,
  onErrorToast,
  onRequestChangeDefault,
}: ShiftTemplateModalProps) {
  const [initialValues, setInitialValues] = useState<ShiftTemplateFormValues>(() =>
    createInitialShiftTemplateFormValues(mode, initialShift)
  );
  const [values, setValues] = useState<ShiftTemplateFormValues>(() =>
    createInitialShiftTemplateFormValues(mode, initialShift)
  );
  const [fieldErrors, setFieldErrors] = useState<ShiftTemplateFieldErrors>({});
  const [submitError, setSubmitError] = useState<{
    code?: string;
    message: string;
    requestId?: string;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [pendingSwitchDefaultAction, setPendingSwitchDefaultAction] = useState<{
    scopeCode?: string;
    shiftId?: number;
  } | null>(null);

  const submittingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // รีเซ็ตค่าฟอร์มเฉพาะตอนเปิดหน้าต่างใหม่หรือสลับโหมด/แม่แบบกะเป้าหมาย
  useEffect(() => {
    if (!open) {
      setDiscardConfirmOpen(false);
      setPendingSwitchDefaultAction(null);
      return;
    }
    const nextInit = createInitialShiftTemplateFormValues(mode, initialShift);
    setInitialValues(nextInit);
    setValues(nextInit);
    setFieldErrors({});
    setSubmitError(null);
    setDiscardConfirmOpen(false);
    setPendingSwitchDefaultAction(null);

    const focusTimer = window.setTimeout(() => {
      nameInputRef.current?.focus();
    }, 60);
    return () => window.clearTimeout(focusTimer);
  }, [open, mode, initialShift?.id]);

  const isDirty = useMemo(
    () => isShiftTemplateFormDirty(initialValues, values, mode),
    [initialValues, values, mode]
  );

  const isCrossMidnight = useMemo(() => {
    if (!values.startTime || !values.endTime) return false;
    return values.endTime <= values.startTime;
  }, [values.startTime, values.endTime]);

  const selectedCreateScopeNorm = String(values.createDefaultScopeCode || '')
    .trim()
    .toUpperCase();
  const selectedCreateScopeExistingDefault = selectedCreateScopeNorm
    ? defaultBindingByTypeCode.get(selectedCreateScopeNorm) || null
    : null;

  const existingBoundCodesInEdit = useMemo(() => {
    if (mode !== 'edit' || !initialShift || !Array.isArray(initialShift.default_personnel_types)) {
      return [] as string[];
    }
    return initialShift.default_personnel_types
      .map((d: any) =>
        String(d.personnelTypeCode || d.personnel_type_code || '')
          .trim()
          .toUpperCase()
      )
      .filter(Boolean);
  }, [mode, initialShift]);

  function updateField<K extends keyof ShiftTemplateFormValues>(
    key: K,
    nextVal: ShiftTemplateFormValues[K],
    clearErrorKey?: ShiftTemplateFieldKey
  ) {
    setValues((prev) => ({ ...prev, [key]: nextVal }));
    if (clearErrorKey && fieldErrors[clearErrorKey]) {
      setFieldErrors((prev) => {
        const copy = { ...prev };
        delete copy[clearErrorKey];
        return copy;
      });
    }
    if (submitError) {
      setSubmitError(null);
    }
  }

  function toggleEditDefaultScope(code: string) {
    const norm = String(code || '').trim().toUpperCase();
    setValues((prev) => {
      const exists = prev.editSelectedDefaultScopes.includes(norm);
      return {
        ...prev,
        editSelectedDefaultScopes: exists
          ? prev.editSelectedDefaultScopes.filter((c) => c !== norm)
          : [...prev.editSelectedDefaultScopes, norm],
      };
    });
    if (fieldErrors.defaultShift) {
      setFieldErrors((prev) => {
        const copy = { ...prev };
        delete copy.defaultShift;
        return copy;
      });
    }
  }

  function handleRequestClose() {
    if (saving || submittingRef.current) return;
    if (isDirty) {
      setPendingSwitchDefaultAction(null);
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }

  function handleRequestSwitchToChangeDefault(options: { scopeCode?: string; shiftId?: number }) {
    if (saving || submittingRef.current) return;
    if (isDirty) {
      setPendingSwitchDefaultAction(options);
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
    onRequestChangeDefault(options);
  }

  function handleConfirmDiscard() {
    const nextAction = pendingSwitchDefaultAction;
    setDiscardConfirmOpen(false);
    setPendingSwitchDefaultAction(null);
    onClose();
    if (nextAction) {
      onRequestChangeDefault(nextAction);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || submittingRef.current) return;

    const validation = validateShiftTemplateForm(
      values,
      mode,
      defaultBindingByTypeCode,
      mode === 'edit' ? Number(initialShift?.id) : null
    );

    if (!validation.valid) {
      setFieldErrors(validation.fieldErrors);
      setSubmitError({
        code: 'VALIDATION_ERROR',
        message:
          validation.formError || 'กรุณาตรวจสอบข้อมูลที่กรอกให้ครบถ้วนและถูกต้องก่อนบันทึก',
      });
      return;
    }

    submittingRef.current = true;
    setSaving(true);
    setFieldErrors({});
    setSubmitError(null);

    const cleanedName = cleanShiftDisplayName(values.shiftName);
    const trimmedCode = values.shiftCode.trim();

    try {
      if (mode === 'create') {
        const bindDefault = Boolean(
          values.createIsDefault && selectedCreateScopeNorm && !selectedCreateScopeExistingDefault
        );
        await apiRequest('/shifts', {
          method: 'POST',
          body: JSON.stringify({
            shiftCode: trimmedCode,
            shiftName: cleanedName,
            shiftCategory: values.shiftCategory,
            startTime: values.startTime,
            endTime: values.endTime,
            graceMinutes: Number(values.graceMinutes),
            cutoffTime: values.cutoffTime,
            isDefault: bindDefault,
            defaultPersonnelTypeCodes: bindDefault ? [selectedCreateScopeNorm] : [],
            defaultReason: values.defaultReason.trim() || undefined,
          }),
        });
        onSaved({
          mode: 'create',
          shiftName: cleanedName,
          shiftCode: trimmedCode,
          isDefaultBound: bindDefault,
        });
      } else {
        if (!initialShift?.id) {
          throw new Error('ไม่พบรหัสแม่แบบกะที่ต้องการแก้ไข');
        }
        const newlyAddedScopes = values.editSelectedDefaultScopes.filter(
          (code) => !existingBoundCodesInEdit.includes(code)
        );
        await apiRequest(`/shifts/${initialShift.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            shiftCode: trimmedCode,
            shiftName: cleanedName,
            shiftCategory: values.shiftCategory,
            startTime: values.startTime,
            endTime: values.endTime,
            graceMinutes: Number(values.graceMinutes),
            cutoffTime: values.cutoffTime,
            isActive: values.isActive,
            isDefault: newlyAddedScopes.length > 0,
            defaultPersonnelTypeCodes: newlyAddedScopes,
            defaultReason: values.defaultReason.trim() || undefined,
          }),
        });
        onSaved({
          mode: 'edit',
          shiftName: cleanedName,
          shiftCode: trimmedCode,
          isDefaultBound: newlyAddedScopes.length > 0,
        });
      }
    } catch (err) {
      // บันทึกไม่สำเร็จ: ห้ามปิด Modal และคงค่าที่ผู้ใช้กรอกไว้ทั้งหมด
      if (err instanceof ApiClientError) {
        const mapped = mapShiftTemplateApiErrorToFields({
          code: err.code,
          message: err.message,
        });
        setFieldErrors(mapped.fieldErrors);
        setSubmitError({
          code: err.code,
          message: mapped.formError,
          requestId: err.requestId,
        });
        onErrorToast({
          message:
            mode === 'create'
              ? 'ไม่สามารถเพิ่มแม่แบบกะทำงานได้'
              : 'ไม่สามารถบันทึกการแก้ไขแม่แบบกะทำงานได้',
          detail: mapped.formError,
          requestId: err.requestId,
        });
      } else {
        const fallbackMsg =
          err instanceof Error && err.message
            ? err.message
            : 'เกิดข้อผิดพลาดในการเชื่อมต่อระบบ กรุณาตรวจสอบข้อมูลและลองใหม่อีกครั้ง';
        setSubmitError({ message: fallbackMsg });
        onErrorToast({
          message:
            mode === 'create'
              ? 'ไม่สามารถเพิ่มแม่แบบกะทำงานได้'
              : 'ไม่สามารถบันทึกการแก้ไขแม่แบบกะทำงานได้',
          detail: fallbackMsg,
        });
      }
    } finally {
      submittingRef.current = false;
      setSaving(false);
    }
  }

  const modalTitle =
    mode === 'create'
      ? 'เพิ่มแม่แบบกะทำงานใหม่'
      : initialShift
        ? `แก้ไขแม่แบบกะ: ${cleanShiftDisplayName(initialShift.shift_name)}`
        : 'แก้ไขแม่แบบกะทำงาน';

  const modalKicker =
    mode === 'create'
      ? 'จัดการแม่แบบกะทำงาน · สร้างแม่แบบใหม่'
      : `จัดการแม่แบบกะทำงาน · รหัส ${String(initialShift?.shift_code || '')}`;

  return (
    <>
      <SharedModal
        open={open}
        onClose={handleRequestClose}
        kickerText={modalKicker}
        title={modalTitle}
        maxWidthClass="max-w-[780px]"
        hideDefaultCloseButton
        disableEscapeClose={saving || discardConfirmOpen}
        closeOnBackdrop={!saving && !discardConfirmOpen}
        overlayClassName="bg-black/45 backdrop-blur-[1px]"
        footerHint={
          isDirty
            ? 'มีการแก้ไขข้อมูลที่ยังไม่บันทึก'
            : 'กรอกข้อมูลที่มีเครื่องหมาย * ให้ครบถ้วนก่อนบันทึก'
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
              form="shift-template-modal-form"
              disabled={saving}
              className="h-10 px-5 rounded-lg bg-[#8066B5] hover:bg-[#6E54A3] disabled:opacity-60 text-white text-[13.5px] font-semibold inline-flex items-center justify-center gap-2 transition-colors shadow-xs"
            >
              {saving ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  <span>กำลังบันทึกข้อมูล...</span>
                </>
              ) : mode === 'create' ? (
                <>
                  <Plus className="w-4 h-4" aria-hidden="true" />
                  <span>บันทึกแม่แบบกะใหม่</span>
                </>
              ) : (
                <>
                  <Save className="w-4 h-4" aria-hidden="true" />
                  <span>บันทึกการแก้ไขแม่แบบกะ</span>
                </>
              )}
            </button>
          </>
        }
      >
        <form
          id="shift-template-modal-form"
          noValidate
          onSubmit={handleSubmit}
          className="space-y-5 text-[13.5px]"
        >
          {/* แถบสรุปประเภทเวลาและคำแนะนำด้านบน */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] px-3.5 py-2.5">
            <p className="text-[12.5px] text-[#5D576E] leading-relaxed">
              ระบุชื่อกะโดยไม่ต้องพิมพ์วงเล็บเวลาต่อท้าย ระบบจะแสดงเวลาเริ่ม–เลิกงานให้อัตโนมัติ
            </p>
            <span
              className={`inline-flex items-center gap-1.5 text-[12px] font-semibold px-2.5 py-1 rounded-md border shrink-0 self-start sm:self-center ${
                isCrossMidnight
                  ? 'bg-[#EEF5FD] border-[#C5DCF7] text-[#1D579B]'
                  : 'bg-[#F1ECFA] border-[#D8D1E6] text-[#4E3978]'
              }`}
            >
              {isCrossMidnight ? (
                <Moon className="w-3.5 h-3.5" aria-hidden="true" />
              ) : (
                <Sun className="w-3.5 h-3.5" aria-hidden="true" />
              )}
              <span>
                {isCrossMidnight ? 'เวรข้ามเที่ยงคืน (+1 วัน)' : 'เวรภายในวันเดียว'}
              </span>
            </span>
          </div>

          {/* แถบแจ้งเตือนข้อผิดพลาดระดับฟอร์ม / API */}
          {submitError && <ErrorBanner error={submitError} />}

          {/* ส่วนที่ 1: ข้อมูลพื้นฐานของแม่แบบกะทำงาน */}
          <div className="space-y-4">
            <div className="text-[13px] font-bold text-[#4E3978] flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>ข้อมูลแม่แบบกะทำงานและช่วงเวลาปฏิบัติงาน</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* ชื่อแม่แบบกะทำงาน */}
              <div className="sm:col-span-2">
                <label
                  htmlFor="stm-shift-name"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  ชื่อแม่แบบกะทำงาน <RequiredMark />
                </label>
                <input
                  ref={nameInputRef}
                  id="stm-shift-name"
                  type="text"
                  maxLength={120}
                  disabled={saving}
                  value={values.shiftName}
                  onChange={(e) => updateField('shiftName', e.target.value, 'shiftName')}
                  placeholder="เช่น เวรปกติ, เวรเช้า, เวรบ่าย, เวรดึก"
                  aria-invalid={Boolean(fieldErrors.shiftName)}
                  className={getInputClass(Boolean(fieldErrors.shiftName))}
                />
                {fieldErrors.shiftName && (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.shiftName}
                  </p>
                )}
              </div>

              {/* รหัสกะ */}
              <div>
                <label
                  htmlFor="stm-shift-code"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  รหัสกะ {mode === 'edit' ? '(ไม่สามารถแก้ไขได้หลังสร้าง)' : '(ข้อมูลรอง)'}{' '}
                  <RequiredMark />
                </label>
                <input
                  id="stm-shift-code"
                  type="text"
                  maxLength={32}
                  disabled={saving || mode === 'edit'}
                  readOnly={mode === 'edit'}
                  value={values.shiftCode}
                  onChange={(e) => updateField('shiftCode', e.target.value, 'shiftCode')}
                  placeholder="เช่น ER-2008"
                  aria-invalid={Boolean(fieldErrors.shiftCode)}
                  className={getInputClass(
                    Boolean(fieldErrors.shiftCode),
                    `font-mono ${mode === 'edit' ? 'bg-[#F5F3FA] text-[#5D576E] cursor-not-allowed' : ''}`
                  )}
                />
                {fieldErrors.shiftCode ? (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.shiftCode}
                  </p>
                ) : (
                  <p className="text-[11.5px] text-[#777287] mt-1">
                    {mode === 'edit'
                      ? 'รหัสกะถูกใช้อ้างอิงกับตารางเวรและรายงานย้อนหลังจึงไม่สามารถเปลี่ยนได้'
                      : 'ใช้ตัวอักษรภาษาอังกฤษ ตัวเลข หรือขีด (-, _) 2–32 ตัวอักษร'}
                  </p>
                )}
              </div>

              {/* หมวดหมู่กะ */}
              <div>
                <label
                  htmlFor="stm-shift-category"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  หมวดหมู่กะ <RequiredMark />
                </label>
                <select
                  id="stm-shift-category"
                  disabled={saving}
                  value={values.shiftCategory}
                  onChange={(e) => updateField('shiftCategory', e.target.value, 'shiftCategory')}
                  aria-invalid={Boolean(fieldErrors.shiftCategory)}
                  className={getInputClass(Boolean(fieldErrors.shiftCategory))}
                >
                  <option value="OFFICIAL">เวรราชการ</option>
                  <option value="MORNING">เวรเช้า</option>
                  <option value="AFTERNOON">เวรบ่าย</option>
                  <option value="NIGHT">เวรดึก</option>
                  <option value="CROSS_MIDNIGHT">เวรข้ามวัน</option>
                  <option value="SPECIAL">เวรพิเศษ</option>
                </select>
                {fieldErrors.shiftCategory && (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.shiftCategory}
                  </p>
                )}
              </div>

              {/* เวลาเริ่มงาน */}
              <div>
                <label
                  htmlFor="stm-start-time"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  เวลาเริ่มงาน (24 ชม.) <RequiredMark />
                </label>
                <input
                  id="stm-start-time"
                  type="time"
                  disabled={saving}
                  value={values.startTime}
                  onChange={(e) => updateField('startTime', e.target.value, 'startTime')}
                  aria-invalid={Boolean(fieldErrors.startTime)}
                  className={getInputClass(Boolean(fieldErrors.startTime), 'font-mono tabular-nums')}
                />
                {fieldErrors.startTime && (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.startTime}
                  </p>
                )}
              </div>

              {/* เวลาเลิกงาน */}
              <div>
                <label
                  htmlFor="stm-end-time"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  เวลาเลิกงาน (24 ชม.) <RequiredMark />
                </label>
                <input
                  id="stm-end-time"
                  type="time"
                  disabled={saving}
                  value={values.endTime}
                  onChange={(e) => updateField('endTime', e.target.value, 'endTime')}
                  aria-invalid={Boolean(fieldErrors.endTime)}
                  className={getInputClass(Boolean(fieldErrors.endTime), 'font-mono tabular-nums')}
                />
                {fieldErrors.endTime && (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.endTime}
                  </p>
                )}
              </div>

              {/* เวลาผ่อนผันการมาสาย */}
              <div>
                <label
                  htmlFor="stm-grace-minutes"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  เวลาผ่อนผันการมาสาย (นาที) <RequiredMark />
                </label>
                <input
                  id="stm-grace-minutes"
                  type="number"
                  min={0}
                  max={180}
                  step={1}
                  disabled={saving}
                  value={values.graceMinutes}
                  onChange={(e) => updateField('graceMinutes', e.target.value, 'graceMinutes')}
                  aria-invalid={Boolean(fieldErrors.graceMinutes)}
                  className={getInputClass(
                    Boolean(fieldErrors.graceMinutes),
                    'font-mono tabular-nums'
                  )}
                />
                {fieldErrors.graceMinutes ? (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.graceMinutes}
                  </p>
                ) : (
                  <p className="text-[11.5px] text-[#777287] mt-1">
                    กำหนดได้ตั้งแต่ 0 ถึง 180 นาที
                  </p>
                )}
              </div>

              {/* เวลาตัดรอบสแกน */}
              <div>
                <label
                  htmlFor="stm-cutoff-time"
                  className="block text-[13px] font-semibold text-[#292638] mb-1.5"
                >
                  เวลาตัดรอบสแกน <RequiredMark />
                </label>
                <input
                  id="stm-cutoff-time"
                  type="time"
                  disabled={saving}
                  value={values.cutoffTime}
                  onChange={(e) => updateField('cutoffTime', e.target.value, 'cutoffTime')}
                  aria-invalid={Boolean(fieldErrors.cutoffTime)}
                  className={getInputClass(Boolean(fieldErrors.cutoffTime), 'font-mono tabular-nums')}
                />
                {fieldErrors.cutoffTime && (
                  <p className="text-[12px] text-[#C74455] font-medium mt-1" role="alert">
                    {fieldErrors.cutoffTime}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* สถานะเปิดใช้งาน (แสดงเฉพาะโหมดแก้ไข) */}
          {mode === 'edit' && (
            <div className="space-y-1">
              <label
                className={`flex items-start gap-2.5 p-3 rounded-lg border transition-colors ${
                  fieldErrors.isActive
                    ? 'border-[#C74455] bg-[#FFFBFB]'
                    : 'border-[#E8E4EF] bg-[#F8F7FC]'
                }`}
              >
                <input
                  type="checkbox"
                  disabled={saving}
                  checked={values.isActive}
                  onChange={(e) => updateField('isActive', e.target.checked, 'isActive')}
                  className="mt-0.5 h-4 w-4 rounded border-[#D8D1E6] text-[#8066B5] focus:ring-[#8066B5]"
                />
                <div className="text-[13px] leading-snug">
                  <span className="font-semibold text-[#292638]">เปิดใช้งานแม่แบบกะนี้</span>
                  {Number(initialShift?.is_default ?? 0) === 1 && !values.isActive && (
                    <p className="text-[12px] text-amber-800 font-medium mt-0.5">
                      หมายเหตุ: แม่แบบนี้ถูกใช้เป็นกะเริ่มต้นอยู่ ระบบจะไม่อนุญาตให้ปิดใช้งานจนกว่าจะเปลี่ยนหรือยกเลิกกะเริ่มต้นก่อน
                    </p>
                  )}
                </div>
              </label>
              {fieldErrors.isActive && (
                <p className="text-[12px] text-[#C74455] font-medium" role="alert">
                  {fieldErrors.isActive}
                </p>
              )}
            </div>
          )}

          {/* ส่วนที่ 2: การใช้งานเป็นกะเริ่มต้น (Default Shift Governance) */}
          <div
            className={`rounded-xl border p-4 space-y-3.5 ${
              fieldErrors.defaultShift
                ? 'border-[#C74455] bg-[#FFFBFB]'
                : 'border-[#D8D1E6] bg-[#F8F7FC]'
            }`}
          >
            <div>
              <h3 className="text-[14px] font-bold text-[#292638] flex items-center gap-1.5">
                <Star className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                <span>การใช้งานเป็นกะเริ่มต้น (Default Shift)</span>
              </h3>
              <p className="text-[12px] text-[#777287] mt-0.5 leading-relaxed">
                {mode === 'create'
                  ? 'กะเริ่มต้นจะถูกใช้โดยอัตโนมัติสำหรับบุคลากรในประเภทที่กำหนดในวันที่ไม่ได้จัดเวรรายวัน (มีได้เพียง 1 กะเริ่มต้นต่อ 1 ประเภทบุคลากร)'
                  : 'สามารถกำหนดเป็นกะเริ่มต้นได้เฉพาะประเภทบุคลากรที่ยังไม่มีกะเริ่มต้น หากประเภทใดมีกะเริ่มต้นอื่นอยู่แล้ว ระบบจะป้องกันการกำหนดซ้ำและแสดงชื่อกะเริ่มต้นปัจจุบัน'}
              </p>
            </div>

            {mode === 'create' ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 items-start">
                  <div>
                    <label
                      htmlFor="stm-create-default-scope"
                      className="block text-[12.5px] font-semibold text-[#292638] mb-1.5"
                    >
                      ขอบเขตประเภทบุคลากรสำหรับกำหนดกะเริ่มต้น
                    </label>
                    <select
                      id="stm-create-default-scope"
                      disabled={saving}
                      value={values.createDefaultScopeCode}
                      onChange={(e) => {
                        const nextCode = e.target.value;
                        const existing = defaultBindingByTypeCode.get(
                          String(nextCode || '').trim().toUpperCase()
                        );
                        setValues((prev) => ({
                          ...prev,
                          createDefaultScopeCode: nextCode,
                          createIsDefault: !nextCode || existing ? false : prev.createIsDefault,
                        }));
                        if (fieldErrors.defaultShift) {
                          setFieldErrors((prev) => {
                            const copy = { ...prev };
                            delete copy.defaultShift;
                            return copy;
                          });
                        }
                      }}
                      className="w-full h-10 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[13px] text-[#292638] focus:outline-none focus:border-[#8066B5]"
                    >
                      <option value="">
                        -- ไม่ผูกเป็นกะเริ่มต้น (สร้างเป็นแม่แบบกะทั่วไป) --
                      </option>
                      {personnelTypeRules.map((rule) => {
                        const code = String(rule.personnel_type_code || '').trim().toUpperCase();
                        const binding = defaultBindingByTypeCode.get(code);
                        return (
                          <option key={code} value={code}>
                            {rule.personnel_type_name} ({code}) —{' '}
                            {binding
                              ? `มีกะเริ่มต้นแล้ว: ${cleanShiftDisplayName(binding.shiftName)} (${binding.startTime}–${binding.endTime})`
                              : 'ยังไม่มีกะเริ่มต้น'}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  <div className="pt-0.5 md:pt-6">
                    <label
                      className={`flex items-start gap-2.5 p-3 rounded-lg border transition-colors ${
                        !selectedCreateScopeNorm || Boolean(selectedCreateScopeExistingDefault)
                          ? 'border-[#E8E4EF] bg-white/75 text-[#777287] cursor-not-allowed'
                          : values.createIsDefault
                            ? 'border-[#8066B5] bg-[#F1ECFA]/60 text-[#292638] cursor-pointer'
                            : 'border-[#D8D1E6] bg-white text-[#292638] cursor-pointer hover:border-[#8066B5]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={
                          Boolean(values.createIsDefault) &&
                          Boolean(selectedCreateScopeNorm) &&
                          !selectedCreateScopeExistingDefault
                        }
                        disabled={
                          saving ||
                          !selectedCreateScopeNorm ||
                          Boolean(selectedCreateScopeExistingDefault)
                        }
                        onChange={(e) =>
                          updateField('createIsDefault', e.target.checked, 'defaultShift')
                        }
                        className="mt-0.5 h-4 w-4 rounded border-[#D8D1E6] text-[#8066B5] focus:ring-[#8066B5]"
                      />
                      <div className="text-[12.5px] leading-snug">
                        <div className="font-semibold flex items-center gap-1.5">
                          <span>กำหนดเป็นกะเริ่มต้น (Default Shift)</span>
                          {selectedCreateScopeExistingDefault && (
                            <Lock className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />
                          )}
                        </div>
                        <div className="text-[11.5px] text-[#777287] mt-0.5">
                          {!selectedCreateScopeNorm
                            ? 'เลือกประเภทบุคลากรด้านซ้ายเพื่อตรวจสอบสถานะก่อนเปิดใช้งาน'
                            : selectedCreateScopeExistingDefault
                              ? 'ไม่สามารถเลือกซ้ำได้ เนื่องจากประเภทบุคลากรนี้มีกะเริ่มต้นอยู่แล้ว'
                              : 'ประเภทบุคลากรนี้ยังไม่มีกะเริ่มต้น สามารถกำหนดเป็นกะเริ่มต้นได้ทันที'}
                        </div>
                      </div>
                    </label>
                  </div>
                </div>

                {selectedCreateScopeExistingDefault && (
                  <div className="rounded-lg border border-amber-300 bg-amber-50/90 px-3.5 py-3 text-[12.5px] text-amber-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-1">
                      <div className="font-bold flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
                        <span>
                          กะเริ่มต้นที่ใช้งานอยู่ปัจจุบัน:{' '}
                          {cleanShiftDisplayName(selectedCreateScopeExistingDefault.shiftName)} (
                          <span className="font-mono">
                            {selectedCreateScopeExistingDefault.shiftCode}
                          </span>{' '}
                          · {selectedCreateScopeExistingDefault.startTime}–
                          {selectedCreateScopeExistingDefault.endTime} น.)
                        </span>
                      </div>
                      <p className="text-amber-900 leading-relaxed">
                        ระบบป้องกันการกำหนดกะเริ่มต้นซ้ำทั้งหน้าจอ API และฐานข้อมูล หากต้องการเปลี่ยนกะเริ่มต้น ให้สร้างแม่แบบกะนี้ก่อนแล้วใช้เมนู “จัดการ/เปลี่ยนกะเริ่มต้น”
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() =>
                        handleRequestSwitchToChangeDefault({
                          scopeCode: selectedCreateScopeNorm,
                        })
                      }
                      className="h-9 px-3 rounded-lg border border-amber-400 bg-white hover:bg-amber-100 text-amber-950 font-semibold text-[12px] inline-flex items-center gap-1.5 shrink-0"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" />
                      <span>เปลี่ยนกะเริ่มต้นของประเภทนี้</span>
                    </button>
                  </div>
                )}

                {selectedCreateScopeNorm &&
                  !selectedCreateScopeExistingDefault &&
                  values.createIsDefault && (
                    <div className="rounded-lg border border-[#8066B5]/40 bg-[#F1ECFA]/60 px-3.5 py-3 space-y-2 text-[12.5px] text-[#292638]">
                      <div className="font-semibold text-[#4E3978] flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4 text-[#4E3978] shrink-0" aria-hidden="true" />
                        <span>ผลกระทบเมื่อกำหนดเป็นกะเริ่มต้น</span>
                      </div>
                      <p className="text-[#4E3978]/90 leading-relaxed">
                        บุคลากรในประเภทที่เลือกซึ่งยังไม่ได้รับการจัดเวรรายวันจะใช้กะนี้เป็นกะทำงานอัตโนมัติ โดยไม่แก้ไขหรือลบตารางเวรและข้อมูลสแกนย้อนหลังใด ๆ
                      </p>
                      <div>
                        <label
                          htmlFor="stm-default-reason"
                          className="block text-[12px] font-semibold text-[#292638] mb-1"
                        >
                          เหตุผลในการกำหนดกะเริ่มต้น (บันทึกใน Audit Log — ไม่บังคับ)
                        </label>
                        <input
                          id="stm-default-reason"
                          type="text"
                          disabled={saving}
                          value={values.defaultReason}
                          onChange={(e) => updateField('defaultReason', e.target.value)}
                          placeholder="เช่น กำหนดกะเริ่มต้นสำหรับบุคลากรกลุ่มใหม่ตามประกาศโรงพยาบาล"
                          className="w-full h-9 px-3 rounded-lg border border-[#D8D1E6] bg-white text-[12.5px] text-[#292638]"
                        />
                      </div>
                    </div>
                  )}
              </>
            ) : (
              <>
                <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                  {personnelTypeRules.map((rule) => {
                    const code = String(rule.personnel_type_code || '').trim().toUpperCase();
                    const binding = defaultBindingByTypeCode.get(code);
                    const isBoundToThis =
                      binding && Number(binding.shiftId) === Number(initialShift?.id);
                    const isBoundToOther =
                      binding && Number(binding.shiftId) !== Number(initialShift?.id);
                    const isChecked = values.editSelectedDefaultScopes.includes(code);

                    return (
                      <div
                        key={code}
                        className={`rounded-lg border px-3 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2 ${
                          isBoundToThis
                            ? 'border-[#8066B5]/50 bg-[#F1ECFA]/60'
                            : isBoundToOther
                              ? 'border-[#E8E4EF] bg-white/75'
                              : 'border-[#D8D1E6] bg-white'
                        }`}
                      >
                        <label
                          className={`flex items-start gap-2.5 ${
                            isBoundToOther || isBoundToThis || saving
                              ? 'cursor-not-allowed'
                              : 'cursor-pointer'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            disabled={
                              saving || Boolean(isBoundToOther) || Boolean(isBoundToThis)
                            }
                            onChange={() => toggleEditDefaultScope(code)}
                            className="mt-0.5 h-4 w-4 rounded border-[#D8D1E6] text-[#8066B5]"
                          />
                          <div className="text-[12.5px] leading-snug">
                            <div className="font-semibold text-[#292638] flex items-center gap-1.5 flex-wrap">
                              <span>{rule.personnel_type_name}</span>
                              <span className="font-mono text-[11.5px] text-[#777287]">
                                ({code})
                              </span>
                              {isBoundToOther && (
                                <Lock className="w-3.5 h-3.5 text-amber-700" aria-hidden="true" />
                              )}
                            </div>
                            {isBoundToThis ? (
                              <div className="text-[12px] text-[#4E3978] font-medium">
                                กำลังใช้แม่แบบกะนี้เป็นกะเริ่มต้นอยู่ในปัจจุบัน
                              </div>
                            ) : isBoundToOther ? (
                              <div className="text-[12px] text-amber-900">
                                มีกะเริ่มต้นอยู่แล้ว:{' '}
                                <strong>{cleanShiftDisplayName(binding.shiftName)}</strong> (
                                <span className="font-mono">{binding.shiftCode}</span> ·{' '}
                                {binding.startTime}–{binding.endTime} น.) — ไม่สามารถกำหนดซ้ำได้
                              </div>
                            ) : (
                              <div className="text-[12px] text-emerald-700 font-medium">
                                ยังไม่มีกะเริ่มต้น — ติ๊กเพื่อกำหนดเป็นกะเริ่มต้น (Default Shift)
                              </div>
                            )}
                          </div>
                        </label>

                        {isBoundToOther && initialShift?.id && (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() =>
                              handleRequestSwitchToChangeDefault({
                                scopeCode: code,
                                shiftId: Number(initialShift.id),
                              })
                            }
                            className="h-8 px-2.5 rounded-md border border-[#D8D1E6] bg-white hover:bg-[#F1ECFA] text-[#4E3978] text-[11.5px] font-semibold inline-flex items-center gap-1 shrink-0 self-start sm:self-center"
                          >
                            <ArrowRightLeft className="w-3.5 h-3.5" />
                            <span>เปลี่ยนมาใช้กะนี้</span>
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="text-[12px] text-[#4E3978] bg-white border border-[#E8E4EF] rounded-lg px-3 py-2 flex items-start gap-2">
                  <ShieldCheck
                    className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>
                    การแก้ไขแม่แบบกะทำงานจะไม่กระทบตารางเวรรายวันที่เคยจัดไว้ (Snapshot) และไม่แก้ไขข้อมูลสแกนดิบหรือประวัติการลงเวลาย้อนหลัง
                  </span>
                </div>
              </>
            )}

            {fieldErrors.defaultShift && (
              <p className="text-[12px] text-[#C74455] font-medium" role="alert">
                {fieldErrors.defaultShift}
              </p>
            )}
          </div>
        </form>
      </SharedModal>

      {/* หน้าต่างยืนยันก่อนปิด Modal เมื่อมีข้อมูลแก้ไขค้างไว้ยังไม่บันทึก */}
      <ConfirmDialog
        open={discardConfirmOpen}
        onCancel={() => {
          setDiscardConfirmOpen(false);
          setPendingSwitchDefaultAction(null);
        }}
        onConfirm={handleConfirmDiscard}
        variant="warning"
        title="ยืนยันปิดหน้าต่างโดยไม่บันทึก?"
        description="คุณมีการกรอกหรือแก้ไขข้อมูลแม่แบบกะทำงานที่ยังไม่ได้บันทึก หากปิดหน้าต่างตอนนี้ ข้อมูลที่แก้ไขค้างไว้จะหายไป"
        cancelLabel="กลับไปแก้ไขต่อ"
        confirmLabel="ยืนยันปิดโดยไม่บันทึก"
      />
    </>
  );
}
