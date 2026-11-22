/**
 * ============================================================================
 * ชุดคอมโพเนนต์กลางที่ใช้ร่วมกันทุกหน้า (Modern HIS Shared UI Design System)
 * ไฟล์: frontend/src/components/common/SharedComponents.tsx
 * ============================================================================
 * หลักการออกแบบ:
 * - Single-elevation flat surfaces (#FFFFFF + 1px solid #E8E4EF) บนพื้นหลัง #F8F7FC
 * - Primary Purple #8066B5 / Dark #4E3978 / Soft Lavender #F1ECFA / Light #E9DFF5
 * - Text Primary #292638 / Text Secondary #777287
 * - รองรับ Desktop-first 1440px พร้อม Responsive Tablet/Mobile โดยไม่บีบหัวข้อหรือปุ่ม
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
  Info,
  Loader2,
  Inbox,
} from 'lucide-react';
import { type PeriodMode, resolvePeriodRange } from '../../utils/thaiFormat.ts';

export type PageSizeOption = 10 | 50 | 100 | 'ALL';

/* -------------------------------------------------------------------------- */
/* 1. PageHeader — ป้องกันการบีบหัวข้อแม้มีหลายปุ่มในหน้านั้น                    */
/* -------------------------------------------------------------------------- */
export function PageHeader({
  category,
  title,
  subtitle,
  meta,
  actions,
}: {
  category?: string;
  title: string;
  subtitle?: string;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-5 border-b border-[#E8E4EF]">
      <div className="flex flex-col xl:flex-row xl:items-start xl:justify-between gap-4">
        <div className="space-y-1 min-w-0 flex-1">
          {category && (
            <div className="text-[12.5px] font-semibold text-[#8066B5] tracking-wide">
              {category}
            </div>
          )}
          <h1 className="text-[22px] sm:text-[25px] font-bold text-[#292638] tracking-tight leading-snug">
            {title}
          </h1>
          {subtitle && (
            <p className="text-[13.5px] sm:text-[14px] text-[#777287] leading-relaxed max-w-3xl">
              {subtitle}
            </p>
          )}
          {meta && (
            <div className="pt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-[#777287]">
              {meta}
            </div>
          )}
        </div>
        {actions && (
          <div className="flex flex-wrap items-center xl:justify-end gap-2 shrink-0 w-full xl:w-auto">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. SectionHeader — หัวข้อหมวดย่อยที่สะอาด ชัดเจน ไม่ซ้อนกล่องซ้ำซ้อน          */
/* -------------------------------------------------------------------------- */
export function SectionHeader({
  title,
  subtitle,
  kicker,
  actions,
  className = '',
}: {
  title: string;
  subtitle?: string;
  kicker?: string;
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-end justify-between gap-2.5 ${className}`}
    >
      <div className="min-w-0 space-y-0.5">
        {kicker && (
          <div className="text-[11.5px] font-semibold text-[#8066B5] uppercase tracking-wider">
            {kicker}
          </div>
        )}
        <h2 className="text-[16.5px] sm:text-[17.5px] font-bold text-[#292638] leading-snug">
          {title}
        </h2>
        {subtitle && (
          <p className="text-[13px] text-[#777287] leading-relaxed">{subtitle}</p>
        )}
      </div>
      {actions && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. StatusBadge — ป้ายสถานะมาตรฐาน HIS (สี + ไอคอน + ข้อความชัดเจน)            */
/* -------------------------------------------------------------------------- */
export type StatusTone =
  | 'success'
  | 'warning'
  | 'danger'
  | 'info'
  | 'brand'
  | 'primary'
  | 'neutral';

export function StatusBadge({
  tone = 'neutral',
  label,
  children,
  icon,
  dot = false,
  compact = false,
}: {
  tone?: StatusTone;
  label?: React.ReactNode;
  children?: React.ReactNode;
  icon?: React.ReactNode;
  dot?: boolean;
  compact?: boolean;
}) {
  const normalizedTone = tone === 'primary' ? 'brand' : tone;
  const toneStyles: Record<Exclude<StatusTone, 'primary'>, string> = {
    success: 'bg-[#EEF8F4] text-[#198568] border-[#198568]/20',
    warning: 'bg-[#FEF7EA] text-[#B87516] border-[#B87516]/25',
    danger: 'bg-[#FDF2F4] text-[#C74455] border-[#C74455]/25',
    info: 'bg-[#EFF4FB] text-[#5879BC] border-[#5879BC]/25',
    brand: 'bg-[#F1ECFA] text-[#4E3978] border-[#8066B5]/25',
    neutral: 'bg-[#F8F7FC] text-[#777287] border-[#E8E4EF]',
  };

  const dotColors: Record<Exclude<StatusTone, 'primary'>, string> = {
    success: 'bg-[#198568]',
    warning: 'bg-[#B87516]',
    danger: 'bg-[#C74455]',
    info: 'bg-[#5879BC]',
    brand: 'bg-[#8066B5]',
    neutral: 'bg-[#777287]',
  };

  const DefaultIcon =
    normalizedTone === 'success'
      ? CheckCircle2
      : normalizedTone === 'warning'
        ? AlertTriangle
        : normalizedTone === 'danger'
          ? AlertCircle
          : normalizedTone === 'info'
            ? Info
            : null;

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border font-semibold whitespace-nowrap ${
        compact ? 'px-2 py-0.5 text-[12px]' : 'px-2.5 py-1 text-[12.5px]'
      } ${toneStyles[normalizedTone]}`}
    >
      {icon !== undefined ? (
        icon
      ) : dot ? (
        <span
          className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColors[normalizedTone]}`}
          aria-hidden="true"
        />
      ) : DefaultIcon ? (
        <DefaultIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      ) : null}
      <span>{label ?? children}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. MetricStrip — แถบ KPI รวมระดับเดียว แทนกล่อง KPI แยกย่อยที่รกตา             */
/* -------------------------------------------------------------------------- */
export interface MetricStripItem {
  id?: string;
  label: string;
  value: React.ReactNode;
  unit?: string;
  sublabel?: React.ReactNode;
  subtext?: React.ReactNode;
  tone?: 'default' | 'neutral' | 'brand' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  icon?: React.ReactNode;
  onClick?: () => void;
  actionHint?: string;
}

export function MetricStrip({
  items,
  columns,
}: {
  items: MetricStripItem[];
  columns?: 2 | 3 | 4 | 5;
}) {
  const colCount = columns ?? Math.min(Math.max(items.length, 2), 5);
  const gridClass =
    colCount === 2
      ? 'grid-cols-1 sm:grid-cols-2'
      : colCount === 3
        ? 'grid-cols-1 sm:grid-cols-3'
        : colCount === 4
          ? 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4'
          : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5';

  const valueColor: Record<'default' | 'brand' | 'success' | 'warning' | 'danger' | 'info', string> = {
    default: 'text-[#292638]',
    brand: 'text-[#4E3978]',
    success: 'text-[#198568]',
    warning: 'text-[#B87516]',
    danger: 'text-[#C74455]',
    info: 'text-[#5879BC]',
  };

  return (
    <section className="his-metric-strip" aria-label="สรุปตัวชี้วัดสำคัญ">
      <div
        className={`grid ${gridClass} divide-y sm:divide-y-0 sm:divide-x divide-[#E8E4EF]`}
      >
        {items.map((item, idx) => {
          const clickable = Boolean(item.onClick);
          const rawTone = item.tone ?? 'default';
          const normalizedTone =
            rawTone === 'primary'
              ? 'brand'
              : rawTone === 'neutral'
                ? 'default'
                : rawTone;
          const secondaryLine = item.sublabel ?? item.subtext;
          const Wrapper = clickable ? 'button' : 'div';
          return (
            <Wrapper
              key={item.id ?? `${item.label}-${idx}`}
              {...(clickable
                ? {
                    type: 'button' as const,
                    onClick: item.onClick,
                  }
                : {})}
              className={`px-4 sm:px-5 py-4 text-left flex flex-col justify-between gap-2 min-w-0 ${
                clickable
                  ? 'hover:bg-[#F8F7FC] transition-colors cursor-pointer group'
                  : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-semibold text-[#777287] truncate">
                  {item.label}
                </span>
                {item.icon && (
                  <span className="text-[#8066B5] shrink-0" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
              </div>

              <div className="flex items-baseline gap-1.5 min-w-0">
                <span
                  className={`text-[22px] sm:text-[24px] font-bold font-mono tabular-nums tracking-tight leading-tight ${valueColor[normalizedTone]}`}
                >
                  {item.value}
                </span>
                {item.unit && (
                  <span className="text-[13px] font-medium text-[#777287]">
                    {item.unit}
                  </span>
                )}
              </div>

              {(secondaryLine || item.actionHint) && (
                <div className="flex items-center justify-between gap-2 text-[12px] text-[#777287] min-w-0">
                  <span className="truncate">{secondaryLine}</span>
                  {item.actionHint && (
                    <span className="text-[#8066B5] font-semibold shrink-0 group-hover:underline">
                      {item.actionHint}
                    </span>
                  )}
                </div>
              )}
            </Wrapper>
          );
        })}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. FilterBar — แถบตัวกรองมาตรฐานที่วางคอนโทรลเป็นระเบียบ                       */
/* -------------------------------------------------------------------------- */
export function FilterBar({
  children,
  rightSlot,
  className = '',
}: {
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`his-surface px-4 py-3.5 flex flex-col lg:flex-row lg:items-center justify-between gap-3 ${className}`}
    >
      <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5 flex-1 min-w-0">
        {children}
      </div>
      {rightSlot && (
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {rightSlot}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 6. TabBar — แถบแท็บมาตรฐาน (Underline หรือ Segmented)                          */
/* -------------------------------------------------------------------------- */
export interface TabItem<T extends string = string> {
  key: T;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  count?: string | number;
}

export function TabBar<T extends string>({
  tabs,
  items,
  activeKey,
  onChange,
  variant = 'underline',
  className = '',
}: {
  tabs?: TabItem<T>[];
  items?: TabItem<T>[];
  activeKey: T;
  onChange: (key: T) => void;
  variant?: 'underline' | 'segmented';
  className?: string;
}) {
  const list = tabs ?? items ?? [];

  if (variant === 'segmented') {
    return (
      <div role="tablist" className={`ent-tab-bar ${className}`}>
        {list.map((tab) => {
          const active = tab.key === activeKey;
          const badgeVal = tab.badge ?? tab.count;
          return (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.key)}
              className={`ent-tab-btn ${active ? 'ent-tab-btn-active' : ''}`}
            >
              {tab.icon && <span aria-hidden="true">{tab.icon}</span>}
              <span>{tab.label}</span>
              {badgeVal !== undefined && (
                <span
                  className={`font-mono text-[11.5px] px-1.5 py-0.5 rounded ${
                    active
                      ? 'bg-white/20 text-white'
                      : 'bg-white text-[#4E3978] border border-[#E8E4EF]'
                  }`}
                >
                  {badgeVal}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div role="tablist" className={`his-tab-underline-bar ${className}`}>
      {list.map((tab) => {
        const active = tab.key === activeKey;
        const badgeVal = tab.badge ?? tab.count;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.key)}
            className={`his-tab-underline-btn ${
              active ? 'his-tab-underline-btn-active' : ''
            }`}
          >
            {tab.icon && (
              <span
                className={active ? 'text-[#8066B5]' : 'text-[#777287]'}
                aria-hidden="true"
              >
                {tab.icon}
              </span>
            )}
            <span>{tab.label}</span>
            {badgeVal !== undefined && (
              <span
                className={`font-mono text-[11.5px] px-1.5 py-0.5 rounded ${
                  active
                    ? 'bg-[#E9DFF5] text-[#4E3978]'
                    : 'bg-[#F8F7FC] text-[#777287] border border-[#E8E4EF]'
                }`}
              >
                {badgeVal}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* 7. EmptyState & TableEmptyState                                            */
/* -------------------------------------------------------------------------- */
export function EmptyState({
  title = 'ไม่พบข้อมูลในช่วงเวลาที่เลือก',
  description = 'ลองปรับเปลี่ยนช่วงวันที่ หรือล้างตัวกรองการค้นหาด้านบนเพื่อดูข้อมูลทั้งหมด',
  action,
  icon,
}: {
  title?: string;
  description?: string;
  action?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="his-surface py-12 px-6 flex flex-col items-center justify-center text-center gap-2">
      <div className="w-11 h-11 rounded-full bg-[#F1ECFA] flex items-center justify-center text-[#8066B5]">
        {icon || <Inbox className="w-5 h-5" aria-hidden="true" />}
      </div>
      <div className="text-[15px] font-semibold text-[#292638] mt-1">{title}</div>
      <div className="text-[13.5px] text-[#777287] max-w-md leading-relaxed">
        {description}
      </div>
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}

export function RequiredMark() {
  return (
    <span className="text-[#C74455] ml-1 font-bold" title="ข้อมูลจำเป็นต้องกรอก" aria-hidden="true">
      *
    </span>
  );
}

export function TableEmptyState({
  colSpan,
  title = 'ไม่พบข้อมูลในช่วงเวลาที่เลือก',
  description = 'ลองปรับเปลี่ยนช่วงวันที่ หรือล้างตัวกรองการค้นหาด้านบนเพื่อดูข้อมูลทั้งหมด',
}: {
  colSpan: number;
  title?: string;
  description?: string;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="py-12 px-4 sm:px-6 text-center">
        <div className="flex flex-col items-center justify-center gap-2 text-[#777287]">
          <div className="w-11 h-11 rounded-full bg-[#F1ECFA] flex items-center justify-center text-[#8066B5]">
            <Inbox className="w-5 h-5" aria-hidden="true" />
          </div>
          <div className="text-[15px] font-semibold text-[#292638] mt-1">{title}</div>
          <div className="text-[13.5px] text-[#777287] max-w-md">{description}</div>
        </div>
      </td>
    </tr>
  );
}

export function TableLoadingSkeleton({
  rows = 5,
  columns,
  cols,
}: {
  rows?: number;
  columns?: number;
  cols?: number;
}) {
  const colCount = Math.max(1, Math.min(cols ?? columns ?? 6, 6));
  const gridColsClass =
    colCount === 1
      ? 'grid-cols-1'
      : colCount === 2
        ? 'grid-cols-2'
        : colCount === 3
          ? 'grid-cols-3'
          : colCount === 4
            ? 'grid-cols-2 sm:grid-cols-4'
            : colCount === 5
              ? 'grid-cols-2 sm:grid-cols-5'
              : 'grid-cols-2 sm:grid-cols-6';

  return (
    <div
      className="ent-table-wrapper p-4 sm:p-5 space-y-3"
      aria-busy="true"
      aria-label="กำลังโหลดข้อมูล"
    >
      <div className="h-4 w-48 bg-[#E9DFF5] rounded animate-pulse" />
      <div className="space-y-2.5 pt-2">
        {Array.from({ length: rows }).map((_, rIdx) => (
          <div key={rIdx} className={`grid gap-3 ${gridColsClass}`}>
            {Array.from({ length: colCount }).map((__, cIdx) => (
              <div
                key={cIdx}
                className="h-7 bg-[#F1ECFA] rounded-md animate-pulse"
              />
            ))}
          </div>
        ))}
      </div>
    </div>
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
      className="fixed inset-0 z-50 bg-[#292638]/40 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shared-modal-title"
    >
      <div
        className={`bg-white border border-[#E8E4EF] w-full ${maxWidthClass} max-h-[92vh] sm:max-h-[90vh] sm:rounded-xl rounded-t-2xl shadow-lg flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 sm:px-6 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 min-w-0">
            {kickerText && (
              <div className="text-[12px] font-semibold text-[#8066B5]">{kickerText}</div>
            )}
            <h3
              id="shared-modal-title"
              className="text-[17px] sm:text-[18px] font-bold text-[#292638] tracking-tight"
            >
              {title}
            </h3>
            {subtitle && <p className="text-[13px] text-[#777287]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[#777287] hover:text-[#292638] hover:bg-[#E9DFF5] transition-colors shrink-0 cursor-pointer"
            title="ปิดหน้าต่าง (Esc)"
            aria-label="ปิดหน้าต่าง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5 text-[14px]">{children}</div>

        <div className="px-4 sm:px-6 py-3.5 bg-[#F8F7FC] border-t border-[#E8E4EF] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0">
          <span className="hidden sm:inline text-[12.5px] text-[#777287]">
            กดปุ่ม Esc หรือคลิกพื้นที่ด้านนอกเพื่อปิดหน้าต่าง
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
      className="fixed inset-0 z-50 bg-[#292638]/35 backdrop-blur-xs flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="slide-drawer-title"
    >
      <div
        className="bg-white border-l border-[#E8E4EF] w-full max-w-xl h-full shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 sm:px-6 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 min-w-0">
            {kickerText && (
              <div className="text-[12px] font-semibold text-[#8066B5]">{kickerText}</div>
            )}
            <h3
              id="slide-drawer-title"
              className="text-[17.5px] sm:text-[18.5px] font-bold text-[#292638] tracking-tight"
            >
              {title}
            </h3>
            {subtitle && <p className="text-[13px] text-[#777287]">{subtitle}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[#777287] hover:text-[#292638] hover:bg-[#E9DFF5] transition-colors shrink-0 cursor-pointer"
            title="ปิดแผงรายละเอียด (Esc)"
            aria-label="ปิดแผงรายละเอียด"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5 text-[14px]">{children}</div>

        <div className="px-4 sm:px-6 py-3.5 bg-[#F8F7FC] border-t border-[#E8E4EF] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 shrink-0">
          <span className="hidden sm:inline text-[12.5px] text-[#777287]">
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
      className="py-3 px-4 text-[13px] font-semibold cursor-pointer select-none hover:bg-[#F1ECFA]/70 transition-colors whitespace-nowrap"
    >
      <div className={`inline-flex items-center gap-1.5 w-full ${justifyClass}`}>
        <span className={isActive ? 'text-[#4E3978] font-bold' : 'text-[#292638]'}>{label}</span>
        {isActive ? (
          sortDir === 'ASC' ? (
            <ArrowUp className="w-3.5 h-3.5 text-[#8066B5] shrink-0" aria-hidden="true" />
          ) : (
            <ArrowDown className="w-3.5 h-3.5 text-[#8066B5] shrink-0" aria-hidden="true" />
          )
        ) : (
          <ArrowUpDown className="w-3.5 h-3.5 text-[#777287]/60 shrink-0" aria-hidden="true" />
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
    <div className="px-4 sm:px-5 py-3 bg-[#F8F7FC] border-t border-[#E8E4EF] flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between sm:justify-start gap-2.5">
        <span className="text-[#777287] font-medium">แถวต่อหน้า:</span>
        <div className="inline-flex items-center bg-[#F1ECFA] rounded-lg p-0.5 border border-[#E8E4EF]">
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
                className={`px-2.5 py-1 rounded-md text-[12.5px] font-medium transition-colors whitespace-nowrap cursor-pointer ${
                  active
                    ? 'bg-white text-[#4E3978] font-semibold'
                    : 'text-[#777287] hover:text-[#292638]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {extraControls && (
          <>
            <span className="hidden sm:inline text-[#E8E4EF] mx-1">·</span>
            {extraControls}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between sm:justify-end gap-3">
        <span className="text-[#777287] tabular-nums">
          แสดง <strong className="text-[#292638]">{startItem}</strong>–
          <strong className="text-[#292638]">{endItem}</strong> จาก{' '}
          <strong className="text-[#4E3978]">{totalItems}</strong> รายการ
        </span>

        {pageSize !== 'ALL' && totalPages > 1 && (
          <div className="inline-flex items-center gap-1.5">
            <button
              type="button"
              disabled={safePage <= 1}
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
              className="p-1.5 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F1ECFA] disabled:opacity-40 text-[#292638] cursor-pointer"
              title="หน้าก่อนหน้า"
              aria-label="หน้าก่อนหน้า"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="px-2 py-1 text-[13px] tabular-nums font-semibold text-[#292638]">
              หน้า {safePage} / {totalPages}
            </span>
            <button
              type="button"
              disabled={safePage >= totalPages}
              onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
              className="p-1.5 rounded-lg border border-[#E8E4EF] bg-white hover:bg-[#F1ECFA] disabled:opacity-40 text-[#292638] cursor-pointer"
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
    <div className="his-surface px-4 py-3 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-3">
      <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5">
        <div className="grid grid-cols-2 sm:inline-flex items-center p-1 bg-[#F1ECFA] border border-[#E8E4EF] rounded-lg gap-1 sm:gap-0.5">
          {modes.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => onModeChange(m.key)}
              className={`px-3 py-1.5 text-[13px] font-semibold rounded-md transition-colors text-center whitespace-nowrap cursor-pointer ${
                mode === m.key
                  ? 'bg-[#8066B5] text-white'
                  : 'text-[#777287] hover:text-[#292638]'
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
            <span className="text-[13px] text-[#777287] text-center">ถึง</span>
            <input
              type="date"
              aria-label="ถึงวันที่"
              value={customTo}
              onChange={(e) => onCustomToChange(e.target.value)}
              className="ent-input font-mono tabular-nums w-full sm:w-auto"
            />
          </div>
        )}

        <div className="inline-flex items-center gap-1.5 text-[13px] text-[#4E3978] px-1.5 py-1">
          <Calendar className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
          <span className="font-semibold truncate">{resolved.thaiPeriodLabel}</span>
        </div>
      </div>

      {extraFilters && (
        <div className="flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2 w-full xl:w-auto">
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
      className="border border-[#198568]/25 bg-[#EEF8F4] px-4 sm:px-5 py-3 rounded-xl text-[13.5px] text-[#292638] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div className="flex items-start sm:items-center gap-2.5 font-medium">
        <CheckCircle2 className="w-5 h-5 text-[#198568] shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="px-3 py-1.5 bg-white border border-[#198568]/25 rounded-lg text-[13px] text-[#198568] hover:bg-[#198568]/5 font-semibold whitespace-nowrap w-full sm:w-auto text-center cursor-pointer"
      >
        รับทราบ
      </button>
    </div>
  );
}

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
      className="border border-[#C74455]/25 bg-[#FDF2F4] px-4 sm:px-5 py-3 rounded-xl text-[13.5px] text-[#C74455] flex flex-col sm:flex-row sm:items-center justify-between gap-3"
    >
      <div className="flex items-start sm:items-center gap-2.5 font-medium">
        <AlertCircle className="w-5 h-5 text-[#C74455] shrink-0 mt-0.5 sm:mt-0" aria-hidden="true" />
        <span>{message}</span>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="px-3 py-1.5 bg-white border border-[#C74455]/25 rounded-lg text-[13px] text-[#C74455] hover:bg-[#C74455]/5 font-semibold whitespace-nowrap w-full sm:w-auto text-center cursor-pointer"
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
      ? 'ent-btn-danger'
      : variant === 'warning'
        ? 'min-h-[38px] px-4 py-2 rounded-lg text-[14px] font-semibold bg-[#B87516] text-white hover:bg-[#9E6310] disabled:opacity-50 inline-flex items-center justify-center gap-2 cursor-pointer'
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
        <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[14px] text-[#292638]">
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
        <div className="p-4 rounded-xl bg-[#FEF7EA] border border-[#B87516]/25 text-[#B87516] flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
          <div className="text-[14px] font-medium leading-relaxed text-[#292638]">{message}</div>
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
  stageLabel,
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
  stageLabel?: string | null;
  percent?: number | null;
  status?: 'RUNNING' | 'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILED';
  summaryText?: string | null;
  errorMessage?: string | null;
  details?: React.ReactNode;
  onClose: () => void;
}) {
  if (!open) return null;
  const hasMeasuredPercent = typeof percent === 'number' && Number.isFinite(percent);
  const rawPercent = hasMeasuredPercent ? Math.max(0, Math.min(100, Math.round(percent))) : null;
  const safePercent =
    rawPercent !== null && status === 'RUNNING' ? Math.min(99, rawPercent) : rawPercent;

  return (
    <div
      className="fixed inset-0 z-50 bg-[#292638]/40 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="progress-dialog-title"
    >
      <div className="bg-white border border-[#E8E4EF] w-full max-w-lg rounded-xl shadow-lg overflow-hidden">
        <div className="px-6 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex items-center justify-between">
          <div>
            <div className="text-[12px] font-semibold text-[#8066B5]">
              {stageLabel ? `สถานะการทำงาน · ${stageLabel}` : 'สถานะการทำงานของระบบ'}
            </div>
            <h3 id="progress-dialog-title" className="text-[17.5px] font-bold text-[#292638]">
              {title}
            </h3>
          </div>
          {status !== 'RUNNING' && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-lg text-[#777287] hover:text-[#292638] hover:bg-[#E9DFF5] cursor-pointer"
              aria-label="ปิดหน้าต่าง"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-3 text-[14px]">
            <div className="flex items-center gap-2.5 font-semibold text-[#292638]">
              {status === 'RUNNING' && (
                <Loader2 className="w-4.5 h-4.5 text-[#8066B5] animate-spin shrink-0" />
              )}
              {status === 'SUCCESS' && (
                <CheckCircle2 className="w-5 h-5 text-[#198568] shrink-0" />
              )}
              {status === 'PARTIAL_SUCCESS' && (
                <AlertTriangle className="w-5 h-5 text-[#B87516] shrink-0" />
              )}
              {status === 'FAILED' && <AlertCircle className="w-5 h-5 text-[#C74455] shrink-0" />}
              <span>{stepLabel}</span>
            </div>
            {safePercent !== null ? (
              <span className="font-mono font-bold text-[#4E3978] shrink-0 tabular-nums">
                {safePercent}%
              </span>
            ) : (
              <span className="text-[12.5px] font-semibold text-[#4E3978] shrink-0">
                {status === 'RUNNING'
                  ? 'กำลังดำเนินการ'
                  : status === 'SUCCESS'
                    ? 'เสร็จสิ้น'
                    : status === 'PARTIAL_SUCCESS'
                      ? 'สำเร็จบางส่วน'
                      : 'ไม่สำเร็จ'}
              </span>
            )}
          </div>

          <div className="w-full h-2.5 bg-[#F1ECFA] rounded-full overflow-hidden border border-[#E8E4EF]">
            {safePercent !== null ? (
              <div
                className={`h-full transition-all duration-300 ${
                  status === 'FAILED'
                    ? 'bg-[#C74455]'
                    : status === 'PARTIAL_SUCCESS'
                      ? 'bg-[#B87516]'
                      : status === 'SUCCESS'
                        ? 'bg-[#198568]'
                        : 'bg-[#8066B5]'
                }`}
                style={{ width: `${safePercent}%` }}
              />
            ) : (
              <div
                className={`h-full w-full ${
                  status === 'FAILED'
                    ? 'bg-[#C74455]'
                    : status === 'PARTIAL_SUCCESS'
                      ? 'bg-[#B87516]'
                      : status === 'SUCCESS'
                        ? 'bg-[#198568]'
                        : 'bg-[#8066B5]/70 animate-pulse'
                }`}
              />
            )}
          </div>

          {summaryText && status === 'SUCCESS' && (
            <div className="p-3.5 rounded-xl bg-[#EEF8F4] border border-[#198568]/25 text-[13.5px] text-[#198568] font-medium">
              {summaryText}
            </div>
          )}

          {summaryText && status === 'PARTIAL_SUCCESS' && (
            <div className="p-3.5 rounded-xl bg-[#FEF7EA] border border-[#B87516]/25 text-[13.5px] text-[#B87516] font-medium">
              {summaryText}
            </div>
          )}

          {errorMessage && status === 'FAILED' && (
            <div className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#C74455]/25 text-[13.5px] text-[#C74455] font-medium">
              {errorMessage}
            </div>
          )}

          {details}
        </div>

        <div className="px-6 py-3.5 bg-[#F8F7FC] border-t border-[#E8E4EF] flex items-center justify-between gap-3">
          <span className="text-[12.5px] text-[#777287]">
            {status === 'RUNNING'
              ? 'กำลังดำเนินการ กรุณาอย่าปิดหน้าต่าง...'
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
