/**
 * ============================================================================
 * ชุดคอมโพเนนต์กลางที่ใช้ร่วมกันทุกหน้า (Shared Enterprise UI Components)
 * ไฟล์: frontend/src/components/common/SharedComponents.tsx
 * ============================================================================
 * ประกอบด้วย:
 * 1. PageHeader: ส่วนหัวของแต่ละหน้า แสดงหมวดหมู่ ชื่อหน้า คำอธิบาย และปุ่มคำสั่งหลัก
 * 2. PeriodFilterBar: แถบเลือกช่วงเวลา 4 โหมด (รายวัน / รายเดือน / รายปี / กำหนดช่วงวันที่)
 * 3. SortableHeader: หัวคอลัมน์ตารางที่คลิกเรียงลำดับข้อมูล (ASC / DESC) ได้
 * 4. TablePaginationBar: แถบแบ่งหน้าตาราง (แสดง 10, 50, 100 หรือทั้งหมด)
 * 5. SharedModal & SlideOverDrawer: หน้าต่างป๊อปอัพและแผงลิ้นชักด้านข้างที่รองรับปุ่ม ESC
 * 6. ConfirmDialog, ProgressDialog, WarningDialog, SuccessToast, ErrorToast (มาตรฐานข้อ 8.5)
 */
import React, { useEffect } from 'react';
import {
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Calendar,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  Loader2,
  Inbox,
} from 'lucide-react';
import { type PeriodMode, resolvePeriodRange } from '../../utils/thaiFormat.ts';

export type PageSizeOption = 10 | 50 | 100 | 'ALL';

export function PageHeader({
  category,
  title,
  subtitle,
  actions,
}: {
  category?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-3.5 sm:gap-4 pb-4 sm:pb-5 border-b border-[#E7E2F0]">
      <div className="space-y-1.5 min-w-0 flex-1">
        {category && (
          <div className="text-[12.5px] sm:text-[13px] font-semibold text-[#7359B4] tracking-normal">
            {category}
          </div>
        )}
        <h1 className="text-[20px] sm:text-[24px] lg:text-[26px] font-bold text-[#273244] tracking-tight leading-snug">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[13.5px] sm:text-[14.5px] text-[#596579] leading-relaxed max-w-4xl">
            {subtitle}
          </p>
        )}
      </div>
      {actions && (
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center xl:justify-end gap-2.5 w-full xl:w-auto xl:max-w-[56%] [&>button]:w-full sm:[&>button]:w-auto [&>div]:w-full sm:[&>div]:w-auto">
          {actions}
        </div>
      )}
    </div>
  );
}

export function RequiredMark() {
  return (
    <span className="text-[#B91C1C] ml-1 font-bold" title="ข้อมูลจำเป็นต้องกรอก" aria-hidden="true">
      *
    </span>
  );
}

export function TableEmptyState({
  colSpan,
  title = 'ไม่พบรายการข้อมูลตามเงื่อนไขที่เลือก',
  description = 'ลองปรับเปลี่ยนช่วงเวลา หรือล้างตัวกรองการค้นหาด้านบนเพื่อดูข้อมูลทั้งหมด',
}: {
  colSpan: number;
  title?: string;
  description?: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-12 px-4 sm:px-6 text-center">
        <div className="flex flex-col items-center justify-center gap-2 text-[#596579]">
          <div className="w-11 h-11 rounded-full bg-[#F3EEFC] flex items-center justify-center text-[#7359B4]">
            <Inbox className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="text-[15px] font-semibold text-[#273244] mt-1">{title}</div>
          <div className="text-[13.5px] text-[#596579] max-w-md">{description}</div>
        </div>
      </td>
    </tr>
  );
}

export interface SharedModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  kickerText?: string;
  maxWidthClass?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}

export function SharedModal({
  open,
  onClose,
  title,
  subtitle,
  kickerText,
  maxWidthClass = 'max-w-4xl',
  children,
  footer,
}: SharedModalProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#273244]/45 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shared-modal-title"
    >
      <div
        className={`bg-white border border-[#E7E2F0] w-full ${maxWidthClass} max-h-[92vh] sm:max-h-[90vh] sm:rounded-xl rounded-t-2xl shadow-2xl flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 sm:px-6 py-4 bg-[#FAF9FD] border-b border-[#E7E2F0] flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 min-w-0">
            {kickerText && (
              <div className="text-[12.5px] font-semibold text-[#7359B4]">{kickerText}</div>
            )}
            <h3
              id="shared-modal-title"
              className="text-[17px] sm:text-[18px] font-bold text-[#273244] tracking-tight"
            >
              {title}
            </h3>
            {subtitle && <p className="text-[13px] sm:text-[13.5px] text-[#596579]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[#596579] hover:text-[#273244] hover:bg-[#F3EEFC] transition-colors shrink-0"
            title="ปิดหน้าต่าง (Esc)"
            aria-label="ปิดหน้าต่าง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5 text-[14px]">{children}</div>

        <div className="px-4 sm:px-6 py-3.5 bg-[#FAF9FD] border-t border-[#E7E2F0] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0">
          <span className="hidden sm:inline text-[12.5px] text-[#596579]">
            กดปุ่ม Esc บนคีย์บอร์ด หรือคลิกพื้นที่ด้านนอกเพื่อปิดหน้าต่าง
          </span>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto sm:ml-auto">
            {footer}
            <button
              type="button"
              onClick={onClose}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ปิดหน้าต่าง
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SlideOverDrawer({
  open,
  onClose,
  title,
  subtitle,
  kickerText,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  kickerText?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#273244]/40 backdrop-blur-xs flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="slide-drawer-title"
    >
      <div
        className="bg-white border-l border-[#E7E2F0] w-full max-w-xl h-full shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 sm:px-6 py-4 sm:py-5 bg-[#FAF9FD] border-b border-[#E7E2F0] flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 min-w-0">
            {kickerText && (
              <div className="text-[12.5px] font-semibold text-[#7359B4]">{kickerText}</div>
            )}
            <h3
              id="slide-drawer-title"
              className="text-[17.5px] sm:text-[19px] font-bold text-[#273244] tracking-tight"
            >
              {title}
            </h3>
            {subtitle && <p className="text-[13px] sm:text-[13.5px] text-[#596579]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[#596579] hover:text-[#273244] hover:bg-[#F3EEFC] transition-colors shrink-0"
            title="ปิดแผงรายละเอียด (Esc)"
            aria-label="ปิดแผงรายละเอียด"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5 text-[14px]">{children}</div>

        <div className="px-4 sm:px-6 py-3.5 sm:py-4 bg-[#FAF9FD] border-t border-[#E7E2F0] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0">
          <span className="hidden sm:inline text-[12.5px] text-[#596579]">
            กดปุ่ม Esc เพื่อปิดแผงรายละเอียด
          </span>
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto sm:ml-auto">
            {footer}
            <button
              type="button"
              onClick={onClose}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ปิดแผงนี้
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SortableHeader({
  label,
  sortKey,
  activeSortKey,
  sortDir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: string;
  activeSortKey: string;
  sortDir: 'ASC' | 'DESC';
  onSort: (key: string) => void;
  align?: 'left' | 'right' | 'center';
}) {
  const isActive = activeSortKey === sortKey;
  const justifyClass =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';

  return (
    <th
      scope="col"
      aria-sort={isActive ? (sortDir === 'ASC' ? 'ascending' : 'descending') : 'none'}
      onClick={() => onSort(sortKey)}
      className="py-3.5 px-4 text-[13.5px] font-semibold cursor-pointer select-none hover:bg-[#F3EEFC]/60 transition-colors whitespace-nowrap"
    >
      <div className={`inline-flex items-center gap-1.5 w-full ${justifyClass}`}>
        <span className={isActive ? 'text-[#7359B4] font-bold' : 'text-[#273244]'}>{label}</span>
        {isActive ? (
          sortDir === 'ASC' ? (
            <ArrowUp className="w-3.5 h-3.5 text-[#8B73C7] shrink-0" aria-hidden="true" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5 text-[#8B73C7] shrink-0" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown className="w-3.5 h-3.5 text-[#596579]/60 shrink-0" aria-hidden="true" />
        )}
      </div>
    </th>
  );
}

export function TablePaginationBar({
  totalItems,
  currentPage,
  pageSize,
  onPageChange,
  onPageSizeChange,
  extraControls,
}: {
  totalItems: number;
  currentPage: number;
  pageSize: PageSizeOption;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: PageSizeOption) => void;
  extraControls?: React.ReactNode;
}) {
  const numericPageSize = pageSize === 'ALL' ? Math.max(1, totalItems) : pageSize;
  const totalPages = Math.max(1, Math.ceil(totalItems / numericPageSize));
  const safePage = Math.min(currentPage, totalPages);
  const startItem = totalItems === 0 ? 0 : (safePage - 1) * numericPageSize + 1;
  const endItem = totalItems === 0 ? 0 : Math.min(totalItems, safePage * numericPageSize);

  const pageOptions: { label: string; value: PageSizeOption }[] = [
    { label: '10', value: 10 },
    { label: '50', value: 50 },
    { label: '100', value: 100 },
    { label: 'ทั้งหมด', value: 'ALL' },
  ];

  return (
    <div className="px-4 sm:px-5 py-3.5 bg-[#FAF9FD] border-t border-[#E7E2F0] flex flex-col sm:flex-row sm:items-center justify-between gap-3.5 text-[13.5px]">
      <div className="flex flex-wrap items-center justify-between sm:justify-start gap-2.5">
        <span className="text-[#596579] font-medium">แถวต่อหน้า:</span>
        <div className="inline-flex items-center bg-[#E7E2F0]/70 rounded-lg p-1">
          {pageOptions.map((opt) => {
            const active = pageSize === opt.value;
            return (
              <button
                key={String(opt.value)}
                type="button"
                onClick={() => {
                  onPageSizeChange(opt.value);
                  onPageChange(1);
                }}
                className={`px-2.5 sm:px-3 py-1 rounded-md text-[13px] font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-white text-[#7359B4] shadow-2xs font-semibold'
                    : 'text-[#596579] hover:text-[#273244]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {extraControls && (
          <>
            <span className="hidden sm:inline text-[#D5CEE6] mx-1">·</span>
            {extraControls}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between sm:justify-end gap-3">
        <span className="text-[#596579] tabular-nums text-[13px] sm:text-[13.5px]">
          แสดง <strong className="text-[#273244]">{startItem}</strong>–
          <strong className="text-[#273244]">{endItem}</strong> จาก{' '}
          <strong className="text-[#7359B4]">{totalItems}</strong> รายการ
        </span>

        {pageSize !== 'ALL' && totalPages > 1 && (
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
              className="p-2 rounded-lg border border-[#D5CEE6] bg-white hover:bg-[#FAF9FD] disabled:opacity-40 text-[#273244]"
              title="หน้าก่อนหน้า"
              aria-label="หน้าก่อนหน้า"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-2.5 py-1.5 text-[13px] sm:text-[13.5px] tabular-nums font-semibold text-[#273244]">
              หน้า {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
              className="p-2 rounded-lg border border-[#D5CEE6] bg-white hover:bg-[#FAF9FD] disabled:opacity-40 text-[#273244]"
              title="หน้าถัดไป"
              aria-label="หน้าถัดไป"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function PeriodFilterBar({
  mode,
  onModeChange,
  dailyDate,
  onDailyDateChange,
  monthValue,
  onMonthValueChange,
  yearValue,
  onYearValueChange,
  customFrom,
  onCustomFromChange,
  customTo,
  onCustomToChange,
  extraFilters,
}: {
  mode: PeriodMode;
  onModeChange: (m: PeriodMode) => void;
  dailyDate: string;
  onDailyDateChange: (d: string) => void;
  monthValue: string;
  onMonthValueChange: (m: string) => void;
  yearValue: string;
  onYearValueChange: (y: string) => void;
  customFrom: string;
  onCustomFromChange: (d: string) => void;
  customTo: string;
  onCustomToChange: (d: string) => void;
  extraFilters?: React.ReactNode;
}) {
  const resolved = resolvePeriodRange({
    mode,
    dailyDate,
    monthValue,
    yearValue,
    customFrom,
    customTo,
  });

  const modes: { key: PeriodMode; label: string }[] = [
    { key: 'DAILY', label: 'รายวัน' },
    { key: 'MONTHLY', label: 'รายเดือน' },
    { key: 'YEARLY', label: 'รายปี' },
    { key: 'CUSTOM', label: 'กำหนดช่วงวันที่' },
  ];

  return (
    <div className="ent-card p-3.5 sm:p-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3.5 sm:gap-4">
      <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 sm:gap-3">
        <span className="text-[13.5px] sm:text-[14px] font-semibold text-[#273244] pl-0.5">
          มุมมองช่วงเวลา:
        </span>
        <div className="grid grid-cols-2 sm:inline-flex items-center p-1 bg-[#FAF9FD] border border-[#E7E2F0] rounded-lg gap-1 sm:gap-0">
          {modes.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onModeChange(m.key)}
              className={`px-3 py-1.5 text-[13px] sm:text-[13.5px] font-medium rounded-md transition-colors text-center whitespace-nowrap ${
                mode === m.key
                  ? 'bg-[#8B73C7] text-white shadow-2xs font-semibold'
                  : 'text-[#596579] hover:text-[#273244]'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === 'DAILY' && (
          <input
            type="date"
            aria-label="เลือกวันที่"
            value={dailyDate}
            onChange={(e) => onDailyDateChange(e.target.value)}
            className="ent-input font-mono tabular-nums w-full sm:w-auto"
          />
        )}

        {mode === 'MONTHLY' && (
          <input
            type="month"
            aria-label="เลือกเดือน"
            value={monthValue}
            onChange={(e) => onMonthValueChange(e.target.value)}
            className="ent-input font-mono tabular-nums w-full sm:w-auto"
          />
        )}

        {mode === 'YEARLY' && (
          <select
            aria-label="เลือกปี พ.ศ."
            value={yearValue}
            onChange={(e) => onYearValueChange(e.target.value)}
            className="ent-input font-mono tabular-nums w-full sm:w-auto"
          >
            <option value="2026">พ.ศ. 2569 (2026)</option>
            <option value="2025">พ.ศ. 2568 (2025)</option>
          </select>
        )}

        {mode === 'CUSTOM' && (
          <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2 w-full sm:w-auto">
            <input
              type="date"
              aria-label="ตั้งแต่วันที่"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              className="ent-input font-mono tabular-nums w-full sm:w-auto"
            />
            <span className="text-[13px] text-[#596579] text-center">ถึง</span>
            <input
              type="date"
              aria-label="ถึงวันที่"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="ent-input font-mono tabular-nums w-full sm:w-auto"
            />
          </div>
        )}

        <div className="inline-flex items-center gap-2 text-[13px] sm:text-[13.5px] text-[#273244] bg-[#F3EEFC] px-3.5 py-2 rounded-lg border border-[#E7E2F0] w-full sm:w-auto">
          <Calendar className="w-4 h-4 text-[#7359B4] shrink-0" aria-hidden="true" />
          <span className="font-semibold truncate">{resolved.thaiPeriodLabel}</span>
        </div>
      </div>

      {extraFilters && (
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 w-full xl:w-auto">
          {extraFilters}
        </div>
      )}
    </div>
  );
}

export function NotificationBanner({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  if (!message) return null;

  return (
    <div
      role="status"
      className="border border-emerald-300 bg-emerald-50/90 px-4 sm:px-5 py-3.5 rounded-xl text-[13.5px] sm:text-[14px] text-emerald-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div className="flex items-start sm:items-center gap-2.5 font-medium">
        <CheckCircle2 className="w-5 h-5 text-[#047857] shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="px-3.5 py-1.5 bg-white border border-emerald-300 rounded-lg text-[13px] text-[#047857] hover:bg-emerald-100 font-semibold whitespace-nowrap w-full sm:w-auto text-center"
      >
        รับทราบ
      </button>
    </div>
  );
}

// ============================================================================
// มาตรฐาน Dialog / Alert / Toast กลางทั้งระบบ (Section 8.5)
// ============================================================================

export function SuccessToast({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  return <NotificationBanner message={message} onClose={onClose} />;
}

export function ErrorToast({
  message,
  onClose,
}: {
  message: string | null;
  onClose: () => void;
}) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="border border-red-300 bg-red-50/95 px-4 sm:px-5 py-3.5 rounded-xl text-[13.5px] sm:text-[14px] text-[#B91C1C] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div className="flex items-start sm:items-center gap-2.5 font-medium">
        <AlertCircle className="w-5 h-5 text-[#B91C1C] shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="px-3.5 py-1.5 bg-white border border-red-300 rounded-lg text-[13px] text-[#B91C1C] hover:bg-red-100 font-semibold whitespace-nowrap w-full sm:w-auto text-center"
      >
        รับทราบ
      </button>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = 'ยืนยันการดำเนินการ',
  cancelLabel = 'ยกเลิก',
  variant = 'primary',
  loading = false,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'primary' | 'danger' | 'warning';
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  if (!open) return null;
  const btnClass =
    variant === 'danger'
      ? 'min-h-[42px] px-4 py-2 rounded-lg text-[14px] font-semibold bg-[#B91C1C] text-white hover:bg-red-800 disabled:opacity-50 inline-flex items-center justify-center gap-2'
      : variant === 'warning'
        ? 'min-h-[42px] px-4 py-2 rounded-lg text-[14px] font-semibold bg-[#B45309] text-white hover:bg-amber-800 disabled:opacity-50 inline-flex items-center justify-center gap-2'
        : 'ent-btn-primary';

  return (
    <SharedModal
      open={open}
      onClose={loading ? () => {} : onCancel}
      title={title}
      subtitle={description}
      kickerText="ยืนยันการดำเนินการ"
      maxWidthClass="max-w-lg"
      footer={
        <button
          type="button"
          disabled={loading}
          onClick={onConfirm}
          className={btnClass}
        >
          {loading && <Loader2 className="w-4 h-4 animate-spin" />}
          <span>{confirmLabel}</span>
        </button>
      }
    >
      {children || (
        <div className="p-3.5 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] text-[14px] text-[#273244]">
          กรุณาตรวจสอบรายละเอียดให้ถูกต้องก่อนกดยืนยันการดำเนินการ
        </div>
      )}
    </SharedModal>
  );
}

export function WarningDialog({
  open,
  title,
  message,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  message: string;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <SharedModal
      open={open}
      onClose={onClose}
      title={title}
      kickerText="แจ้งเตือนความซ้ำซ้อน / ข้อควรระวัง"
      maxWidthClass="max-w-lg"
    >
      <div className="space-y-3">
        <div className="p-4 rounded-xl bg-amber-50 border border-amber-300 text-[#B45309] flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-[14px] font-medium leading-relaxed">{message}</div>
        </div>
        {children}
      </div>
    </SharedModal>
  );
}

export function ProgressDialog({
  open,
  title,
  stepLabel,
  percent,
  status = 'RUNNING',
  summaryText,
  errorMessage,
  details,
  onClose,
}: {
  open: boolean;
  title: string;
  stepLabel: string;
  percent?: number | null;
  status?: 'RUNNING' | 'SUCCESS' | 'FAILED';
  summaryText?: string | null;
  errorMessage?: string | null;
  details?: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  const hasMeasuredPercent = typeof percent === 'number' && Number.isFinite(percent);
  const safePercent = hasMeasuredPercent ? Math.max(0, Math.min(100, Math.round(percent))) : null;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#273244]/45 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="progress-dialog-title"
    >
      <div className="bg-white border border-[#E7E2F0] w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-6 py-4 bg-[#FAF9FD] border-b border-[#E7E2F0] flex items-center justify-between">
          <div>
            <div className="text-[12px] font-semibold text-[#7359B4]">สถานะการทำงานของระบบ</div>
            <h3 id="progress-dialog-title" className="text-[18px] font-bold text-[#273244]">
              {title}
            </h3>
          </div>
          {status !== 'RUNNING' && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#596579] hover:text-[#273244] hover:bg-[#F3EEFC]"
              aria-label="ปิดหน้าต่าง"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 text-[14px]">
            <div className="flex items-center gap-2.5 font-semibold text-[#273244]">
              {status === 'RUNNING' && <Loader2 className="w-4.5 h-4.5 text-[#8B73C7] animate-spin shrink-0" />}
              {status === 'SUCCESS' && <CheckCircle2 className="w-5 h-5 text-[#047857] shrink-0" />}
              {status === 'FAILED' && <AlertCircle className="w-5 h-5 text-[#B91C1C] shrink-0" />}
              <span>{stepLabel}</span>
            </div>
            {safePercent !== null ? (
              <span className="font-mono font-bold text-[#7359B4] shrink-0">{safePercent}%</span>
            ) : (
              <span className="text-[12.5px] font-semibold text-[#7359B4] shrink-0">
                {status === 'RUNNING'
                  ? 'กำลังดำเนินการ'
                  : status === 'SUCCESS'
                    ? 'เสร็จสิ้น'
                    : 'ไม่สำเร็จ'}
              </span>
            )}
          </div>

          <div className="w-full h-3 bg-[#F3EEFC] rounded-full overflow-hidden border border-[#E7E2F0]">
            {safePercent !== null ? (
              <div
                className={`h-full transition-all duration-300 ${
                  status === 'FAILED'
                    ? 'bg-[#B91C1C]'
                    : status === 'SUCCESS'
                      ? 'bg-[#047857]'
                      : 'bg-[#8B73C7]'
                }`}
                style={{ width: `${safePercent}%` }}
              />
            ) : (
              <div
                className={`h-full w-full ${
                  status === 'FAILED'
                    ? 'bg-[#B91C1C]'
                    : status === 'SUCCESS'
                      ? 'bg-[#047857]'
                      : 'bg-[#8B73C7]/70 animate-pulse'
                }`}
              />
            )}
          </div>

          {summaryText && status === 'SUCCESS' && (
            <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-[13.5px] text-[#047857] font-medium">
              {summaryText}
            </div>
          )}

          {errorMessage && status === 'FAILED' && (
            <div className="p-3.5 rounded-xl bg-red-50 border border-red-200 text-[13.5px] text-[#B91C1C] font-medium">
              {errorMessage}
            </div>
          )}

          {details}
        </div>

        <div className="px-6 py-3.5 bg-[#FAF9FD] border-t border-[#E7E2F0] flex items-center justify-between">
          <span className="text-[12.5px] text-[#596579]">
            {status === 'RUNNING'
              ? 'กำลังดำเนินการ กรุณาอย่าปิดหน้าต่างหรือกดซ้ำ...'
              : 'ดำเนินการเสร็จสิ้น สามารถปิดหน้าต่างนี้ได้'}
          </span>
          {status !== 'RUNNING' && (
            <button type="button" onClick={onClose} className="ent-btn-primary">
              ปิดหน้าต่าง
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
