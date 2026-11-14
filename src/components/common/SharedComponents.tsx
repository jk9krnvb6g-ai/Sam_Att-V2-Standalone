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
} from 'lucide-react';
import { type PeriodMode, resolvePeriodRange } from '../../utils/thaiFormat.ts';

export type PageSizeOption = 10 | 50 | 100 | 'ALL';

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
      className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className={`bg-white border border-slate-200 w-full ${maxWidthClass} max-h-[90vh] sm:rounded-xl rounded-t-xl shadow-xl flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-start justify-between gap-4 shrink-0">
          <div className="space-y-0.5">
            {kickerText && (
              <div className="text-[11px] font-semibold text-teal-800">{kickerText}</div>
            )}
            <h3 className="text-base font-bold text-slate-900 tracking-tight">{title}</h3>
            {subtitle && <p className="text-xs text-slate-600">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/60 transition-colors"
            title="ปิดหน้าต่าง (Esc)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 space-y-4 text-xs">{children}</div>

        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between gap-3 shrink-0">
          <span className="text-[11px] text-slate-500">
            กดปุ่ม Esc หรือคลิกพื้นที่ด้านนอกเพื่อปิดหน้าต่าง
          </span>
          <div className="flex items-center gap-2">
            {footer}
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg transition-colors whitespace-nowrap"
            >
              ปิดหน้าต่าง
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
      onClick={() => onSort(sortKey)}
      className="py-2.5 px-3 font-medium cursor-pointer select-none hover:bg-slate-100 transition-colors whitespace-nowrap"
    >
      <div className={`inline-flex items-center gap-1 w-full ${justifyClass}`}>
        <span className={isActive ? 'text-teal-900 font-bold' : 'text-slate-600'}>{label}</span>
        {isActive ? (
          sortDir === 'ASC' ? (
            <ArrowUp className="w-3 h-3 text-teal-700 shrink-0" />
          ) : (
            <ArrowDown className="w-3 h-3 text-teal-700 shrink-0" />
          )
        ) : (
          <ArrowUpDown className="w-3 h-3 text-slate-300 shrink-0" />
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
    <div className="px-4 py-3 bg-white border-t border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-slate-500 font-medium">แสดง:</span>
        <div className="inline-flex items-center bg-slate-100 rounded-lg p-0.5">
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
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                  active
                    ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        <span className="text-slate-500">แถว / หน้า</span>
        {extraControls && (
          <>
            <span className="text-slate-300 mx-1">·</span>
            {extraControls}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="text-slate-600 tabular-nums">
          แสดง <strong className="text-slate-900">{startItem}</strong> ถึง{' '}
          <strong className="text-slate-900">{endItem}</strong> จากทั้งหมด{' '}
          <strong className="text-teal-800">{totalItems}</strong> รายการ
        </span>

        {pageSize !== 'ALL' && totalPages > 1 && (
          <div className="inline-flex items-center gap-1">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
              className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700"
              title="หน้าก่อนหน้า"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </button>
            <span className="px-2.5 py-1 text-xs tabular-nums font-semibold text-slate-700">
              หน้า {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
              className="p-1.5 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40 text-slate-700"
              title="หน้าถัดไป"
            >
              <ChevronRight className="w-3.5 h-3.5" />
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
    { key: 'CUSTOM', label: 'ช่วงวันที่' },
  ];

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-3.5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center p-1 bg-slate-100 rounded-lg">
          {modes.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onModeChange(m.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                mode === m.key
                  ? 'bg-white text-slate-900 shadow-2xs font-semibold'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>

        {mode === 'DAILY' && (
          <input
            type="date"
            value={dailyDate}
            onChange={(e) => onDailyDateChange(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
          />
        )}

        {mode === 'MONTHLY' && (
          <input
            type="month"
            value={monthValue}
            onChange={(e) => onMonthValueChange(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
          />
        )}

        {mode === 'YEARLY' && (
          <select
            value={yearValue}
            onChange={(e) => onYearValueChange(e.target.value)}
            className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
          >
            <option value="2026">พ.ศ. 2569 (2026)</option>
            <option value="2025">พ.ศ. 2568 (2025)</option>
          </select>
        )}

        {mode === 'CUSTOM' && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customFrom}
              onChange={(e) => onCustomFromChange(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
            />
            <span className="text-xs text-slate-500">ถึง</span>
            <input
              type="date"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white font-mono tabular-nums"
            />
          </div>
        )}

        <div className="inline-flex items-center gap-1.5 text-xs text-slate-600 pl-1">
          <Calendar className="w-3.5 h-3.5 text-teal-700" />
          <span className="font-medium text-slate-800">{resolved.thaiPeriodLabel}</span>
        </div>
      </div>

      {extraFilters && <div className="flex flex-wrap items-center gap-2">{extraFilters}</div>}
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
    <div className="border border-emerald-300 bg-emerald-50 px-4 py-3 rounded-lg text-xs text-emerald-950 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 font-medium">
        <CheckCircle2 className="w-4 h-4 text-emerald-700 shrink-0" />
        <span>{message}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="text-emerald-800 hover:text-emerald-950 font-semibold whitespace-nowrap"
      >
        รับทราบ
      </button>
    </div>
  );
}
