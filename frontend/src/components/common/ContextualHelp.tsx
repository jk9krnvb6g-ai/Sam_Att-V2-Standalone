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
          compact ? 'h-9 px-3 text-[13px]' : 'min-h-[38px] px-3.5 py-1.5 text-[13.5px]'
        } rounded-lg border border-[#E8E4EF] bg-[#F1ECFA] hover:bg-[#E9DFF5] hover:border-[#8066B5]/40 text-[#4E3978] font-semibold inline-flex items-center justify-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer`}
        title={`เปิดคู่มือวิธีใช้งานหน้านี้ (${label})`}
      >
        {iconType === 'help' ? (
          <HelpCircle className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
        ) : (
          <BookOpen className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
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
 * รายการขั้นตอนแบบหมายเลขที่กดขยาย/ย่อคำอธิบายได้
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
            className="text-[12.5px] font-semibold text-[#8066B5] hover:text-[#4E3978] hover:underline cursor-pointer"
          >
            {allExpanded ? 'ย่อคำอธิบายทั้งหมด' : 'ขยายคำอธิบายทุกขั้นตอน'}
          </button>
        </div>
      )}

      <ol className="his-surface divide-y divide-[#E8E4EF] overflow-hidden">
        {steps.map((step, idx) => {
          const isOpen = Boolean(expandedIndices[idx]);
          return (
            <li key={`${step.title}-${idx}`} className="bg-white">
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => toggleOne(idx)}
                className="w-full px-4 py-3 flex items-start justify-between gap-3 text-left hover:bg-[#F8F7FC] transition-colors cursor-pointer"
              >
                <div className="flex items-start gap-3 min-w-0">
                  <span className="w-6 h-6 rounded-full bg-[#F1ECFA] text-[#4E3978] font-mono text-[12px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                    {idx + 1}
                  </span>
                  <span className="text-[14px] font-semibold text-[#292638] leading-snug">
                    {step.title}
                  </span>
                </div>
                {isOpen ? (
                  <ChevronUp className="w-4 h-4 text-[#8066B5] shrink-0 mt-1" aria-hidden="true" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-[#777287] shrink-0 mt-1" aria-hidden="true" />
                )}
              </button>

              {isOpen && (
                <div className="px-4 pb-3.5 pt-1 pl-[3.25rem] space-y-2 text-[13.5px] text-[#777287] leading-relaxed">
                  <p className="text-[#292638]">{step.detail}</p>
                  {step.uiLocation && (
                    <div className="text-[12.5px] text-[#4E3978] bg-[#F8F7FC] border border-[#E8E4EF] rounded-lg px-3 py-1.5">
                      <span className="font-semibold">ตำแหน่งบนหน้าจอ:</span> {step.uiLocation}
                    </div>
                  )}
                  {step.note && (
                    <div className="text-[12.5px] text-[#B87516] bg-[#FEF7EA] border border-[#B87516]/20 rounded-lg px-3 py-1.5">
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
      className="fixed inset-0 z-50 bg-[#292638]/35 backdrop-blur-xs flex justify-end"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="contextual-help-drawer-title"
      data-testid="contextual-help-drawer"
    >
      <div
        className="bg-[#F8F7FC] border-l border-[#E8E4EF] w-full max-w-2xl h-full shadow-xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 sm:px-6 py-4 bg-white border-b border-[#E8E4EF] flex items-start justify-between gap-3 shrink-0">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#4E3978]">
              <span>คู่มือการใช้งานประจำหน้า</span>
              <span aria-hidden="true" className="text-[#E8E4EF]">·</span>
              <span className="text-[#8066B5]">{guide.menuLabel}</span>
            </div>
            <h2
              id="contextual-help-drawer-title"
              className="text-[17.5px] sm:text-[19px] font-bold text-[#292638] tracking-tight leading-snug"
            >
              {guide.title}
            </h2>
            <p className="text-[13px] text-[#777287]">
              เปิดอ่านและปิดกลับไปทำงานต่อได้ทันที ข้อมูลที่กรอกค้างไว้ในหน้าจอจะไม่สูญหาย
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg text-[#777287] hover:text-[#292638] hover:bg-[#F1ECFA] transition-colors shrink-0 cursor-pointer"
            title="ปิดคู่มือ (Esc)"
            aria-label="ปิดคู่มือการใช้งาน"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 sm:p-6 overflow-y-auto flex-1 space-y-5 text-[14px]">
          {guide.readinessStatus === 'CONDITIONAL' && guide.readinessNote && (
            <div className="p-3.5 rounded-xl bg-[#FEF7EA] border border-[#B87516]/25 text-[#B87516] flex items-start gap-2.5 text-[13px] leading-relaxed">
              <Info className="w-4.5 h-4.5 shrink-0 mt-0.5 text-[#B87516]" aria-hidden="true" />
              <div>
                <div className="font-bold">{guide.readinessLabel}</div>
                <p className="mt-0.5 text-[#292638]">{guide.readinessNote}</p>
              </div>
            </div>
          )}

          {/* 1-3 รวมในพื้นผิวเดียวคั่นด้วย hairline divider */}
          <div className="his-surface divide-y divide-[#E8E4EF]">
            <div className="p-4">
              <h3 className="text-[14px] font-bold text-[#4E3978]">1. เมนูนี้ใช้ทำอะไร</h3>
              <p className="mt-1 text-[13.5px] text-[#292638] leading-relaxed">
                {guide.whatItDoes}
              </p>
            </div>
            <div className="p-4">
              <h3 className="text-[14px] font-bold text-[#4E3978]">2. ผู้ใช้งานที่มีสิทธิ์</h3>
              <p className="mt-1 text-[13.5px] text-[#292638] leading-relaxed">
                {guide.allowedRolesSummary}
              </p>
            </div>
            <div className="p-4 space-y-2">
              <h3 className="text-[14px] font-bold text-[#4E3978]">3. สิ่งที่ต้องเตรียมก่อนเริ่ม</h3>
              <ul className="space-y-1.5 text-[13.5px] text-[#292638]">
                {guide.prerequisites.map((item, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <CheckCircle2
                      className="w-4 h-4 text-[#198568] shrink-0 mt-0.5"
                      aria-hidden="true"
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex flex-col gap-2">
              <h3 className="text-[14.5px] font-bold text-[#4E3978]">
                4. ขั้นตอนการใช้งานจริงตามลำดับ
              </h3>
              {guide.taskGroups && guide.taskGroups.length > 0 && (
                <div className="ent-tab-bar w-full">
                  <button
                    type="button"
                    onClick={() => setSelectedTaskGroupId('ALL')}
                    className={`ent-tab-btn text-[12.5px] ${
                      selectedTaskGroupId === 'ALL' ? 'ent-tab-btn-active' : ''
                    }`}
                  >
                    ภาพรวมทั้งหมด
                  </button>
                  {guide.taskGroups.map((tg) => (
                    <button
                      key={tg.id}
                      type="button"
                      onClick={() => setSelectedTaskGroupId(tg.id)}
                      className={`ent-tab-btn text-[12.5px] text-left ${
                        selectedTaskGroupId === tg.id ? 'ent-tab-btn-active' : ''
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
                <div className="p-3 rounded-xl bg-[#F1ECFA] border border-[#E8E4EF] text-[13px] text-[#292638]">
                  <span className="font-bold text-[#4E3978]">{activeTaskGroup.label}:</span>{' '}
                  {activeTaskGroup.summary}
                </div>
                <ExpandableStepList steps={activeTaskGroup.steps} defaultExpandedAll />
              </div>
            ) : (
              <ExpandableStepList steps={guide.steps} defaultExpandedAll />
            )}
          </div>

          <div className="his-surface p-4 space-y-2.5">
            <h3 className="text-[14px] font-bold text-[#4E3978]">5. ตัวอย่างการใช้งานจริง</h3>
            <div className="space-y-1.5 text-[13.5px] text-[#292638] leading-relaxed">
              <div>
                <span className="font-semibold text-[#777287]">สถานการณ์:</span>{' '}
                {guide.example.scenario}
              </div>
              <div>
                <span className="font-semibold text-[#777287]">วิธีทำ:</span>{' '}
                {guide.example.action}
              </div>
              <div>
                <span className="font-semibold text-[#198568]">ผลที่ได้:</span>{' '}
                {guide.example.outcome}
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-[#EEF8F4] border border-[#198568]/20 p-4 space-y-2">
            <h3 className="text-[14px] font-bold text-[#198568]">
              6. ผลลัพธ์ที่ควรปรากฏหลังดำเนินการสำเร็จ
            </h3>
            <ul className="space-y-1.5 text-[13.5px] text-[#292638]">
              {guide.expectedResults.map((res, idx) => (
                <li key={idx} className="flex items-start gap-2">
                  <CheckCircle2
                    className="w-4 h-4 text-[#198568] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                  <span>{res}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl bg-[#FEF7EA] border border-[#B87516]/20 p-4 space-y-2">
            <h3 className="text-[14px] font-bold text-[#B87516] flex items-center gap-1.5">
              <AlertTriangle className="w-4 h-4 text-[#B87516] shrink-0" aria-hidden="true" />
              <span>7. ข้อควรระวัง</span>
            </h3>
            <ul className="space-y-1.5 text-[13.5px] text-[#292638] list-disc pl-5">
              {guide.precautions.map((item, idx) => (
                <li key={idx}>{item}</li>
              ))}
            </ul>
          </div>

          <div className="his-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-[#E8E4EF] flex items-center gap-1.5">
              <Wrench className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
              <h3 className="text-[14px] font-bold text-[#4E3978]">
                8. ปัญหาที่พบบ่อยและแนวทางแก้ไข
              </h3>
            </div>
            <div className="divide-y divide-[#E8E4EF]">
              {guide.troubleshooting.map((tb, idx) => (
                <div key={idx} className="px-4 py-3 space-y-1 text-[13.5px]">
                  <div className="font-semibold text-[#292638]">ปัญหา: {tb.problem}</div>
                  <div className="text-[#777287]">แนวทางแก้ไข: {tb.solution}</div>
                </div>
              ))}
            </div>
          </div>

          {onNavigate && visibleRelatedLinks.length > 0 && (
            <div className="his-surface overflow-hidden">
              <div className="px-4 py-3 border-b border-[#E8E4EF]">
                <h3 className="text-[14px] font-bold text-[#4E3978]">เมนูที่เกี่ยวข้อง</h3>
              </div>
              <div className="divide-y divide-[#E8E4EF]">
                {visibleRelatedLinks.map((link) => (
                  <button
                    key={link.view}
                    type="button"
                    onClick={() => handleSafeNavigate(link.view)}
                    className="w-full px-4 py-3 hover:bg-[#F1ECFA]/60 flex items-center justify-between gap-3 text-left transition-colors cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="text-[13.5px] font-bold text-[#4E3978]">{link.label}</div>
                      <div className="text-[12.5px] text-[#777287]">{link.reason}</div>
                    </div>
                    <ArrowRight className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="px-4 sm:px-6 py-3.5 bg-white border-t border-[#E8E4EF] flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2.5 shrink-0">
          <div className="flex flex-wrap items-center gap-2">
            {onNavigate && canRoleAccessView('workflowGuide', userRole) && guideKey !== 'workflowGuide' && (
              <button
                type="button"
                onClick={() => handleSafeNavigate('workflowGuide')}
                className="px-3 py-2 rounded-lg text-[13px] font-semibold text-[#4E3978] bg-[#F1ECFA] hover:bg-[#E9DFF5] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <Compass className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span>ผังขั้นตอนการทำงาน</span>
              </button>
            )}
            {onNavigate && canRoleAccessView('userManual', userRole) && guideKey !== 'userManual' && (
              <button
                type="button"
                onClick={() => handleSafeNavigate('userManual')}
                className="px-3 py-2 rounded-lg text-[13px] font-semibold text-[#4E3978] bg-white border border-[#E8E4EF] hover:bg-[#F8F7FC] inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
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
