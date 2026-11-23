/**
 * ============================================================================
 * หน้าต่าง Modal Popup สำหรับเพิ่มและแก้ไขแม่แบบกะทำงาน (Unified Shift Template Modal)
 * ไฟล์: frontend/src/components/shifts/ShiftTemplateModal.tsx
 * ============================================================================
 * หน้าที่เฉพาะของฟอร์มแม่แบบกะทำงาน:
 * - จัดการ 7 ข้อมูลหลัก: ชื่อแม่แบบกะ, รหัสกะ, หมวดหมู่กะ, เวลาเริ่มงาน, เวลาเลิกงาน,
 *   เวลาผ่อนผันการมาสาย, เวลาตัดรอบสแกน (และสถานะเปิดใช้งานในโหมดแก้ไข)
 * - ไม่มี Checkbox หรือ Toggle สำหรับกำหนด Default Shift ในหน้านี้
 *   (การกำหนดกะเริ่มต้นจัดการจุดเดียวในตาราง "กะเริ่มต้นตามประเภทบุคลากร")
 * - ความกว้างเหมาะสม 780px บน Desktop และปรับสัดส่วน Responsive บนมือถือ
 * - รองรับปิดด้วยปุ่ม X, ยกเลิก, คลิกพื้นหลัง หรือ ESC พร้อมยืนยันเมื่อมีข้อมูลค้าง
 * - ล็อกปุ่มระหว่างบันทึก ป้องกันการกดซ้ำ และคงข้อมูลไว้ครบถ้วนหากบันทึกล้มเหลว
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock,
  Info,
  Loader2,
  Moon,
  Plus,
  Save,
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
  type ShiftTemplateFieldErrors,
  type ShiftTemplateFieldKey,
  type ShiftTemplateFormValues,
  type ShiftTemplateModalMode,
} from '../../utils/shiftTemplateForm.ts';

export interface ShiftTemplateModalProps {
  open: boolean;
  mode: ShiftTemplateModalMode;
  initialShift: any | null;
  onClose: () => void;
  onSaved: (summary: {
    mode: ShiftTemplateModalMode;
    shiftName: string;
    shiftCode: string;
  }) => void;
  onErrorToast: (err: { message: string; detail?: string; requestId?: string }) => void;
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
  onClose,
  onSaved,
  onErrorToast,
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

  const submittingRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) {
      setDiscardConfirmOpen(false);
      return;
    }
    const nextInit = createInitialShiftTemplateFormValues(mode, initialShift);
    setInitialValues(nextInit);
    setValues(nextInit);
    setFieldErrors({});
    setSubmitError(null);
    setDiscardConfirmOpen(false);

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

  const referencedPersonnelTypes = useMemo(() => {
    if (mode !== 'edit' || !initialShift || !Array.isArray(initialShift.default_personnel_types)) {
      return [] as Array<{ code: string; name: string }>;
    }
    return initialShift.default_personnel_types
      .map((d: any) => ({
        code: String(d.personnelTypeCode || d.personnel_type_code || '').trim().toUpperCase(),
        name: String(d.personnelTypeName || d.personnel_type_name || d.personnelTypeCode || '').trim(),
      }))
      .filter((d: { code: string; name: string }) => Boolean(d.code));
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

  function handleRequestClose() {
    if (saving || submittingRef.current) return;
    if (isDirty) {
      setDiscardConfirmOpen(true);
      return;
    }
    onClose();
  }

  function handleConfirmDiscard() {
    setDiscardConfirmOpen(false);
    onClose();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || submittingRef.current) return;

    const validation = validateShiftTemplateForm(values, mode);
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
          }),
        });
        onSaved({
          mode: 'create',
          shiftName: cleanedName,
          shiftCode: trimmedCode,
        });
      } else {
        if (!initialShift?.id) {
          throw new Error('ไม่พบรหัสแม่แบบกะที่ต้องการแก้ไข');
        }
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
          }),
        });
        onSaved({
          mode: 'edit',
          shiftName: cleanedName,
          shiftCode: trimmedCode,
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
              แม่แบบกะทำงานหนึ่งรายการสามารถนำไปใช้จัดเวรหรือกำหนดเป็นกะเริ่มต้นได้กับบุคลากรหลายประเภท
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

          {/* ข้อมูลแม่แบบกะทำงานและช่วงเวลาปฏิบัติงาน (7 ฟิลด์หลัก) */}
          <div className="space-y-4">
            <div className="text-[13px] font-bold text-[#4E3978] flex items-center gap-1.5">
              <Clock className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>ข้อมูลแม่แบบกะทำงานและช่วงเวลาปฏิบัติงาน</span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* 1. ชื่อแม่แบบกะทำงาน */}
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

              {/* 2. รหัสกะ */}
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

              {/* 3. หมวดหมู่กะ */}
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

              {/* 4. เวลาเริ่มงาน */}
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

              {/* 5. เวลาเลิกงาน */}
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

              {/* 6. เวลาผ่อนผันการมาสาย */}
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

              {/* 7. เวลาตัดรอบสแกน */}
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
            <div className="space-y-2.5">
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
                  {referencedPersonnelTypes.length > 0 && !values.isActive && (
                    <p className="text-[12px] text-amber-800 font-medium mt-0.5">
                      หมายเหตุ: แม่แบบนี้ถูกใช้เป็นกะเริ่มต้นของ{' '}
                      {referencedPersonnelTypes
                        .map((r: { code: string; name: string }) => r.name)
                        .join(', ')}{' '}
                      กรุณาเปลี่ยนกะเริ่มต้นของประเภทบุคลากรดังกล่าวก่อนปิดใช้งาน
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

          {/* ข้อมูลอ้างอิงการกำหนดกะเริ่มต้น (อ่านอย่างเดียว ไม่มีการตั้งค่าซ้ำซ้อน) */}
          <div className="rounded-lg border border-[#E8E4EF] bg-[#FAF9FD] px-3.5 py-2.5 flex items-start gap-2.5 text-[12.5px] text-[#5D576E]">
            <Info className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
            <div className="leading-relaxed">
              {mode === 'edit' && referencedPersonnelTypes.length > 0 ? (
                <span>
                  แม่แบบกะนี้กำลังถูกใช้เป็นกะเริ่มต้นของ:{' '}
                  <strong className="text-[#292638]">
                    {referencedPersonnelTypes
                      .map((r: { code: string; name: string }) => r.name)
                      .join(', ')}
                  </strong>{' '}
                  · หากต้องการเปลี่ยนกะเริ่มต้น ให้แก้ไขที่หัวข้อ{' '}
                  <strong className="text-[#4E3978]">“กะเริ่มต้นตามประเภทบุคลากร”</strong>
                </span>
              ) : (
                <span>
                  การกำหนดกะเริ่มต้นและวันทำงานจะตั้งค่าจุดเดียวที่หัวข้อ{' '}
                  <strong className="text-[#4E3978]">“กะเริ่มต้นตามประเภทบุคลากร”</strong>{' '}
                  เพื่อป้องกันการตั้งค่าซ้ำซ้อน
                </span>
              )}
            </div>
          </div>
        </form>
      </SharedModal>

      {/* หน้าต่างยืนยันเมื่อปิด Modal ขณะมีข้อมูลแก้ไขค้างไว้ */}
      <ConfirmDialog
        open={discardConfirmOpen}
        variant="warning"
        title="มีข้อมูลที่แก้ไขแต่ยังไม่บันทึก"
        description="คุณต้องการปิดหน้าต่างนี้และละทิ้งการเปลี่ยนแปลงที่ยังไม่ได้บันทึกหรือไม่?"
        confirmLabel="ปิดโดยไม่บันทึก"
        cancelLabel="กลับไปแก้ไขต่อ"
        onConfirm={handleConfirmDiscard}
        onCancel={() => setDiscardConfirmOpen(false)}
      />
    </>
  );
}
