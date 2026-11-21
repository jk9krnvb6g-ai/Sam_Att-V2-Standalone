/**
 * ============================================================================
 * คอมโพเนนต์กลางสำหรับคู่มือการใช้งานประจำหน้า (Central Contextual Help Component)
 * ไฟล์: frontend/src/components/common/ContextualHelp.tsx
 * ============================================================================
 * - ใช้งานร่วมกันทุกหน้าในระบบ Sam_Att V2 Standalone
 * - เปิด-ปิดแบบ Slide-Over Drawer ด้านข้างโดยไม่รีเซ็ตหรือทำให้ข้อมูลในฟอร์มที่กรอกไว้สูญหาย
 * - รองรับการเปลี่ยนเนื้อหาตาม Tab ที่กำลังใช้งาน (activeTabKey)
 * - ไม่มีการเรียก API ที่เปลี่ยนแปลงข้อมูลใด ๆ (Read-Only Pure Guidance)
 * - ตรวจสอบสิทธิ์ผู้ใช้งาน (userRole) ก่อนแสดงลิงก์นำทางไปยังหน้าอื่นทุกครั้ง
 */

import React, { useEffect, useState } from 'react';
import {
  BookOpen,
  HelpCircle,
  X,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Compass,
  Info,
  Wrench,
} from 'lucide-react';
import { type UserRole } from '../../services/api.ts';
import { SIDEBAR_GROUPS, type NavViewKey } from '../layout/Sidebar.tsx';
import {
  getGuideEntry,
  type GuideContextKey,
  type GuideStep,
} from '../../data/helpGuides.ts';

export function canRoleAccessView(view: NavViewKey, role?: UserRole | null): boolean {
  if (!role) return false;
  for (const group of SIDEBAR_GROUPS) {
    for (const item of group.items) {
      if (item.key === view) {
        return item.roles.includes(role);
      }
    }
  }
  return false;
}

/**
 * ปุ่มมาตรฐาน "วิธีใช้งานหน้านี้" สำหรับวางบริเวณ Header ของทุกหน้า
 * จัดการสถานะเปิด-ปิด Drawer ภายในตัวเองเพื่อไม่กระทบ State ของฟอร์มในหน้านั้น
 */
export function PageHelpAction({
  guideKey,
  activeTabKey,
  userRole,
  onNavigate,
  label = 'วิธีใช้งานหน้านี้',
  iconType = 'book',
  compact = false,
}: {
  guideKey: GuideContextKey;
  activeTabKey?: string;
  userRole?: UserRole | null;
  onNavigate?: (view: NavViewKey) => void;
  label?: string;
  iconType?: 'book' | 'help';
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid={`contextual-help-btn-${guideKey}`}
        className={`${
          compact ? 'h-9 px-3 text-[13px]' : 'min-h-[42px] px-3.5 py-2 text-[13.5px]'
        } rounded-lg border border-[#D5CEE6] bg-[#FAF8FF] hover:bg-[#E9DDF8]/70 hover:border-[#A78BFA] text-[#694C8C] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer`}
        title={`เปิดคู่มือวิธีใช้งานหน้านี้ (${label})`}
      >
        {iconType === 'help' ? (
          <HelpCircle className="w-4 h-4 text-[#694C8C] shrink-0" aria-hidden="true" />
        ) : (
          <BookOpen className="w-4 h-4 text-[#694C8C] shrink-0" aria-hidden="true" />
        )}
        <span>{label}</span>
      </button>

      <ContextualHelpDrawer
        open={open}
        onClose={() => setOpen(false)}
        guideKey={guideKey}
        activeTabKey={activeTabKey}
        userRole={userRole}
        onNavigate={onNavigate}
      />
    </>
  );
}

/**
 * รายการขั้นตอนแบบหมายเลขที่กดขยาย/ย่อคำอธิบายได้ (ใช้ร่วมกันทั้ง Drawer และหน้าคู่มือเต็ม)
 */
export function ExpandableStepList({
  steps,
  defaultExpandedAll = true,
}: {
  steps: GuideStep[];
  defaultExpandedAll?: boolean;
}) {
  const [expandedIndices, setExpandedIndices] = useState<Record<number, boolean>>(() => {
    const init: Record<number, boolean> = {};
    steps.forEach((_, idx) => {
      init[idx] = defaultExpandedAll || idx === 0;
    });
    return init;
  });

  useEffect(() => {
    const next: Record<number, boolean> = {};
    steps.forEach((_, idx) => {
      next[idx] = defaultExpandedAll || idx === 0;
    });
    setExpandedIndices(next);
  }, [steps, defaultExpandedAll]);

  const allExpanded = steps.length > 0 && steps.every((_, i) => expandedIndices[i]);

  function toggleOne(idx: number) {
    setExpandedIndices((prev) => ({ ...prev, [idx]: !prev[idx] }));
  }

  function toggleAll() {
    const target = !allExpanded;
    const next: Record<number, boolean> = {};
    steps.forEach((_, idx) => {
      next[idx] = target;
    });
    setExpandedIndices(next);
  }

  return (
    <div className="space-y-2.5">
      {steps.length > 1 && (
        <div className="flex justify-end">
          <button
            type="button"
            onClick={toggleAll}
            className="text-[12.5px] font-semibold text-[#694C8C] hover:underline cursor-pointer"
          >
            {allExpanded ? 'ย่อคำอธิบายทั้งหมด' : 'ขยายคำอธิบายทุกขั้นตอน'}
          </button>
        </div>
      )}

      <ol className="space-y-2">
        {steps.map((step, idx) => {
          const isOpen = Boolean(expandedIndices[idx]);
          return (
            <li
              key={`${step.title}-${idx}`}
              className="rounded-xl border border-[#E7E2F0] bg-white overflow-hidden"
            >
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggleOne(idx)}
                className="w-full px-3.5 py-3 flex items-start justify-between gap-3 text-left hover:bg-[#FAF8FF] transition-colors cursor-pointer"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <span className="w-6 h-6 rounded-full bg-[#E9DDF8] text-[#694C8C] font-mono text-[12.5px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="text-[14px] font-semibold text-[#273244] leading-snug">
                    {step.title}
                  </span>
                </div>
                {isOpen ? (
                  <ChevronUp className="w-4 h-4 text-[#694C8C] shrink-0 mt-1" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-[#596579] shrink-0 mt-1" aria-hidden="true" />
                )}
              </button>

              {isOpen && (
                <div className="px-3.5 pb-3.5 pt-0.5 pl-[3.25rem] space-y-2 text-[13.5px] text-[#596579] leading-relaxed border-t border-[#F3EEFC]">
                  <p>{step.detail}</p>
                  {step.uiLocation && (
                    <div className="text-[12.5px] text-[#694C8C] bg-[#FAF8FF] border border-[#E9DDF8] rounded-lg px-2.5 py-1.5">
                      <span className="font-semibold">ตำแหน่งบนหน้าจอ:</span> {step.uiLocation}
                    </div>
                  )}
                  {step.note && (
                    <div className="text-[12.5px] text-[#B45309] bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5">
                      <span className="font-semibold">หมายเหตุ:</span> {step.note}
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * แผงลิ้นชักคู่มือการใช้งานประจำหน้า (Slide-Over Contextual Help Drawer)
 * แสดงครบทั้ง 8 หัวข้อมาตรฐานโดยไม่กระทบสถานะฟอร์มที่กำลังกรอกอยู่
 */
export function ContextualHelpDrawer({
  open,
  onClose,
  guideKey,
  activeTabKey,
  userRole,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  guideKey: GuideContextKey;
  activeTabKey?: string;
  userRole?: UserRole | null;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const guide = getGuideEntry(guideKey);
  const [selectedTaskGroupId, setSelectedTaskGroupId] = useState<string>('ALL');

  // อัปเดตกลุ่มงานที่เน้นตาม Tab ปัจจุบันของหน้าจอเมื่อเปิด Drawer
  useEffect(() => {
    if (!open) return;
    if (activeTabKey && guide.taskGroups?.length) {
      const matched = guide.taskGroups.find((tg) => tg.tabKey === activeTabKey);
      if (matched) {
        setSelectedTaskGroupId(matched.id);
        return;
      }
    }
    setSelectedTaskGroupId('ALL');
  }, [open, activeTabKey, guideKey, guide.taskGroups]);

  // รองรับปุ่ม ESC เพื่อปิดแผงคู่มือ
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

  const activeTaskGroup =
    selectedTaskGroupId !== 'ALL'
      ? guide.taskGroups?.find((tg) => tg.id === selectedTaskGroupId) || null
      : null;

  const visibleRelatedLinks = (guide.relatedLinks || []).filter((link) =>
    canRoleAccessView(link.view, userRole)
  );

  function handleSafeNavigate(view: NavViewKey) {
    if (!onNavigate || !canRoleAccessView(view, userRole)) return;
    onClose();
    onNavigate(view);
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-[#273244]/40 backdrop-blur-xs flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="contextual-help-drawer-title"
      data-testid="contextual-help-drawer"
    >
      <div
        className="bg-[#FAF8FF] border-l border-[#E7E2F0] w-full max-w-2xl h-full shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-4 sm:px-6 py-4 bg-white border-b border-[#E7E2F0] flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#694C8C]">
              <span>คู่มือการใช้งานประจำหน้า</span>
              <span aria-hidden="true" className="text-[#D5CEE6]">·</span>
              <span>{guide.menuLabel}</span>
            </div>
            <h2
              id="contextual-help-drawer-title"
              className="text-[17.5px] sm:text-[19px] font-bold text-[#273244] tracking-tight leading-snug"
            >
              {guide.title}
            </h2>
            <p className="text-[13px] text-[#596579]">
              เปิดอ่านและปิดกลับไปทำงานต่อได้ทันที ข้อมูลที่กรอกค้างไว้ในหน้าจอจะไม่สูญหาย
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[#596579] hover:text-[#273244] hover:bg-[#F3EEFC] transition-colors shrink-0 cursor-pointer"
            title="ปิดคู่มือ (Esc)"
            aria-label="ปิดคู่มือการใช้งาน"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5 text-[14px]">
          {/* สถานะความพร้อมใช้งานตามจริง */}
          {guide.readinessStatus === 'CONDITIONAL' && guide.readinessNote && (
            <div className="p-3.5 rounded-xl bg-amber-50 border border-amber-200 text-[#92400E] flex items-start gap-2.5 text-[13px] leading-relaxed">
              <Info className="w-4.5 h-4.5 shrink-0 mt-0.5 text-[#B45309]" aria-hidden="true" />
              <div>
                <div className="font-bold">{guide.readinessLabel}</div>
                <p className="mt-0.5">{guide.readinessNote}</p>
              </div>
            </div>
          )}

          {/* 1. เมนูนี้ใช้ทำอะไร & 2. ผู้ใช้งานที่มีสิทธิ์ */}
          <div className="rounded-xl bg-white border border-[#E7E2F0] p-4 space-y-3">
            <div>
              <h3 className="text-[14px] font-bold text-[#694C8C]">1. เมนูนี้ใช้ทำอะไร</h3>
              <p className="mt-1 text-[13.5px] text-[#273244] leading-relaxed">
                {guide.whatItDoes}
              </p>
            </div>
            <div className="pt-3 border-t border-[#F3EEFC]">
              <h3 className="text-[14px] font-bold text-[#694C8C]">2. ผู้ใช้งานที่มีสิทธิ์</h3>
              <p className="mt-1 text-[13.5px] text-[#273244] leading-relaxed">
                {guide.allowedRolesSummary}
              </p>
            </div>
          </div>

          {/* 3. สิ่งที่ต้องเตรียมก่อนเริ่ม */}
          <div className="rounded-xl bg-white border border-[#E7E2F0] p-4 space-y-2">
            <h3 className="text-[14px] font-bold text-[#694C8C]">3. สิ่งที่ต้องเตรียมก่อนเริ่ม</h3>
            <ul className="space-y-1.5 text-[13.5px] text-[#273244]">
              {guide.prerequisites.map((item, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <CheckCircle2
                    className="w-4 h-4 text-[#047857] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 4. ขั้นตอนการใช้งานจริงตามลำดับ (รองรับการสลับตาม Tab / งานย่อย) */}
          <div className="space-y-3">
            <div className="flex flex-col gap-2">
              <h3 className="text-[14.5px] font-bold text-[#694C8C]">
                4. ขั้นตอนการใช้งานจริงตามลำดับ
              </h3>
              {guide.taskGroups && guide.taskGroups.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#E9DDF8]/50 border border-[#E7E2F0] rounded-lg">
                  <button
                    type="button"
                    onClick={() => setSelectedTaskGroupId('ALL')}
                    className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors cursor-pointer ${
                      selectedTaskGroupId === 'ALL'
                        ? 'bg-white text-[#694C8C] shadow-2xs'
                        : 'text-[#596579] hover:text-[#273244]'
                    }`}
                  >
                    ภาพรวมทั้งหมด
                  </button>
                  {guide.taskGroups.map((tg) => (
                    <button
                      key={tg.id}
                      type="button"
                      onClick={() => setSelectedTaskGroupId(tg.id)}
                      className={`px-3 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors cursor-pointer text-left ${
                        selectedTaskGroupId === tg.id
                          ? 'bg-white text-[#694C8C] shadow-2xs'
                          : 'text-[#596579] hover:text-[#273244]'
                      }`}
                    >
                      {tg.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {activeTaskGroup ? (
              <div className="space-y-2.5">
                <div className="p-3 rounded-xl bg-[#F3EEFC] border border-[#E2D9F3] text-[13px] text-[#273244]">
                  <span className="font-bold text-[#694C8C]">{activeTaskGroup.label}:</span>{' '}
                  {activeTaskGroup.summary}
                </div>
                <ExpandableStepList steps={activeTaskGroup.steps} defaultExpandedAll />
              </div>
            ) : (
              <ExpandableStepList steps={guide.steps} defaultExpandedAll />
            )}
          </div>

          {/* 5. ตัวอย่างการใช้งานจริง */}
          <div className="rounded-xl bg-white border border-[#E7E2F0] p-4 space-y-2.5">
            <h3 className="text-[14px] font-bold text-[#694C8C]">5. ตัวอย่างการใช้งานจริง</h3>
            <div className="space-y-1.5 text-[13.5px] text-[#273244] leading-relaxed">
              <div>
                <span className="font-semibold text-[#596579]">สถานการณ์:</span>{' '}
                {guide.example.scenario}
              </div>
              <div>
                <span className="font-semibold text-[#596579]">วิธีทำ:</span>{' '}
                {guide.example.action}
              </div>
              <div>
                <span className="font-semibold text-[#047857]">ผลที่ได้:</span>{' '}
                {guide.example.outcome}
              </div>
            </div>
          </div>

          {/* 6. ผลลัพธ์ที่ควรปรากฏหลังดำเนินการสำเร็จ */}
          <div className="rounded-xl bg-emerald-50/60 border border-emerald-200 p-4 space-y-2">
            <h3 className="text-[14px] font-bold text-[#065F46]">
              6. ผลลัพธ์ที่ควรปรากฏหลังดำเนินการสำเร็จ
            </h3>
            <ul className="space-y-1.5 text-[13.5px] text-[#273244]">
              {guide.expectedResults.map((res, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <CheckCircle2
                    className="w-4 h-4 text-[#047857] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>{res}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* 7. ข้อควรระวัง */}
          <div className="rounded-xl bg-amber-50/70 border border-amber-200 p-4 space-y-2">
            <h3 className="text-[14px] font-bold text-[#92400E] flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-[#B45309] shrink-0" aria-hidden="true" />
              <span>7. ข้อควรระวัง</span>
            </h3>
            <ul className="space-y-1.5 text-[13.5px] text-[#273244] list-disc pl-5">
              {guide.precautions.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          {/* 8. ปัญหาที่พบบ่อยและแนวทางแก้ไข */}
          <div className="rounded-xl bg-white border border-[#E7E2F0] p-4 space-y-3">
            <h3 className="text-[14px] font-bold text-[#694C8C] flex items-center gap-1.5">
              <Wrench className="w-4 h-4 text-[#694C8C] shrink-0" aria-hidden="true" />
              <span>8. ปัญหาที่พบบ่อยและแนวทางแก้ไข</span>
            </h3>
            <div className="space-y-2.5">
              {guide.troubleshooting.map((tb, idx) => (
                <div
                  key={idx}
                  className="p-3 rounded-lg bg-[#FAF8FF] border border-[#E7E2F0] space-y-1 text-[13.5px]"
                >
                  <div className="font-semibold text-[#273244]">ปัญหา: {tb.problem}</div>
                  <div className="text-[#596579]">แนวทางแก้ไข: {tb.solution}</div>
                </div>
              ))}
            </div>
          </div>

          {/* หน้าที่เกี่ยวข้อง (เฉพาะหน้าที่ผู้ใช้มีสิทธิ์เข้าถึง) */}
          {onNavigate && visibleRelatedLinks.length > 0 && (
            <div className="rounded-xl bg-white border border-[#E7E2F0] p-4 space-y-2.5">
              <h3 className="text-[14px] font-bold text-[#694C8C]">เมนูที่เกี่ยวข้อง</h3>
              <div className="space-y-2">
                {visibleRelatedLinks.map((link) => (
                  <button
                    key={link.view}
                    type="button"
                    onClick={() => handleSafeNavigate(link.view)}
                    className="w-full p-3 rounded-lg border border-[#E7E2F0] bg-[#FAF8FF] hover:bg-[#F3EEFC] hover:border-[#A78BFA] flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-bold text-[#694C8C]">{link.label}</div>
                      <div className="text-[12.5px] text-[#596579]">{link.reason}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#694C8C] shrink-0" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 sm:px-6 py-3.5 bg-white border-t border-[#E7E2F0] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {onNavigate && canRoleAccessView('workflowGuide', userRole) && guideKey !== 'workflowGuide' && (
              <button
                type="button"
                onClick={() => handleSafeNavigate('workflowGuide')}
                className="px-3 py-2 rounded-lg text-[13px] font-semibold text-[#694C8C] bg-[#F3EEFC] hover:bg-[#E9DDF8] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <Compass className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>ผังขั้นตอนการทำงาน</span>
              </button>
            )}
            {onNavigate && canRoleAccessView('userManual', userRole) && guideKey !== 'userManual' && (
              <button
                type="button"
                onClick={() => handleSafeNavigate('userManual')}
                className="px-3 py-2 rounded-lg text-[13px] font-semibold text-[#694C8C] bg-white border border-[#D5CEE6] hover:bg-[#FAF8FF] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <BookOpen className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>เปิดศูนย์คู่มือทั้งหมด</span>
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onClose}
            className="ent-btn-primary w-full sm:w-auto"
          >
            ปิดคู่มือและทำงานต่อ
          </button>
        </div>
      </div>
    </div>
  );
}
