/**
 * ============================================================================
 * หน้า "ผังขั้นตอนการทำงาน" (System-Wide Interactive Workflow Guide)
 * ไฟล์: frontend/src/pages/WorkflowGuideView.tsx
 * ============================================================================
 * แสดงภาพรวมผังการทำงานทั้งระบบของ Sam_Att V2 Standalone:
 * 1. ผังความสัมพันธ์ระหว่างงาน (แยกชัดเจน: ทำตามลำดับ / ทำอิสระ / ทำเมื่อจำเป็น / เฉพาะ ADMIN)
 * 2. การ์ดหมวดงานทั้งหมดตามสิทธิ์ผู้ใช้ (รูปแบบ HOSOffice V2 + โทนสีม่วงอ่อน Sam_Att V2)
 * 3. Timeline แนวตั้งแสดงรายละเอียดแต่ละขั้นตอน + ขั้นตอนย่อยแบบขยาย/ย่อ + ปุ่ม "ไปยังเมนู"
 * 4. กล่อง "จุดที่ต้องระวังในสายงานนี้" เฉพาะแต่ละหมวดงาน
 *
 * ปลอดภัย 100%: ไม่มีการเรียก API ที่แก้ไขข้อมูล และตรวจสอบสิทธิ์ก่อนนำทางทุกปุ่ม
 */

import React, { useMemo, useRef, useState } from 'react';
import {
  ShieldCheck,
  Users,
  CalendarDays,
  Radio,
  Clock,
  ClipboardCheck,
  BarChart3,
  Send,
  UserCheck,
  ArrowRight,
  BookOpen,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Info,
  Lock,
} from 'lucide-react';
import { type AuthUser } from '../services/api.ts';
import { type NavViewKey } from '../components/layout/Sidebar.tsx';
import { PageHeader } from '../components/common/SharedComponents.tsx';
import {
  PageHelpAction,
  ContextualHelpDrawer,
  canRoleAccessView,
} from '../components/common/ContextualHelp.tsx';
import {
  DEPENDENCY_TYPE_META,
  getVisibleWorkflowCategories,
  getVisibleDependencyNodes,
  type WorkflowCategoryIconKey,
  type WorkflowDependencyType,
} from '../data/workflowConfig.ts';
import {
  getGuideEntry,
  ROLE_DISPLAY_NAMES,
  type GuideContextKey,
} from '../data/helpGuides.ts';

function CategoryIcon({
  iconKey,
  className = 'w-5 h-5',
}: {
  iconKey: WorkflowCategoryIconKey;
  className?: string;
}) {
  switch (iconKey) {
    case 'shield':
      return <ShieldCheck className={className} aria-hidden="true" />;
    case 'users':
      return <Users className={className} aria-hidden="true" />;
    case 'calendar':
      return <CalendarDays className={className} aria-hidden="true" />;
    case 'radio':
      return <Radio className={className} aria-hidden="true" />;
    case 'clock':
      return <Clock className={className} aria-hidden="true" />;
    case 'clipboard':
      return <ClipboardCheck className={className} aria-hidden="true" />;
    case 'barChart':
      return <BarChart3 className={className} aria-hidden="true" />;
    case 'send':
      return <Send className={className} aria-hidden="true" />;
    case 'userCheck':
    default:
      return <UserCheck className={className} aria-hidden="true" />;
  }
}

export function WorkflowGuideView({
  user,
  onNavigate,
}: {
  user: AuthUser;
  onNavigate: (view: NavViewKey) => void;
}) {
  const categories = useMemo(() => getVisibleWorkflowCategories(user.role), [user.role]);
  const dependencyNodes = useMemo(() => getVisibleDependencyNodes(user.role), [user.role]);

  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(
    () => categories[0]?.id || ''
  );
  const [highlightedStepId, setHighlightedStepId] = useState<string | null>(null);
  const [dependencyFilter, setDependencyFilter] = useState<'ALL' | WorkflowDependencyType>('ALL');
  const [expandedStepChecklist, setExpandedStepChecklist] = useState<Record<string, boolean>>({});
  const [drawerGuideKey, setDrawerGuideKey] = useState<GuideContextKey | null>(null);

  const timelineRef = useRef<HTMLDivElement | null>(null);

  const selectedCategory =
    categories.find((c) => c.id === selectedCategoryId) || categories[0] || null;

  const visibleDependencyTypes: WorkflowDependencyType[] = useMemo(() => {
    const base: WorkflowDependencyType[] = ['SEQUENTIAL', 'INDEPENDENT', 'AS_NEEDED'];
    if (user.role === 'ADMIN') base.push('ADMIN_ONLY');
    return base;
  }, [user.role]);

  function handleSelectCategory(catId: string, focusStepId?: string | null) {
    setSelectedCategoryId(catId);
    setHighlightedStepId(focusStepId || null);
    if (timelineRef.current) {
      timelineRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function handleSafeNavigate(view: NavViewKey) {
    if (!canRoleAccessView(view, user.role)) return;
    onNavigate(view);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        category="ช่วยเหลือและคู่มือการใช้งาน"
        title="ผังขั้นตอนการทำงานทั้งระบบ"
        subtitle={`แสดงลำดับการทำงานและความเชื่อมโยงของระบบ Sam_Att V2 สำหรับสิทธิ์ ${ROLE_DISPLAY_NAMES[user.role]} — คลิกเลือกหมวดงานเพื่อดูขั้นตอนและกดไปยังเมนูจริงได้ทันที`}
        actions={
          <>
            <PageHelpAction
              guideKey="workflowGuide"
              userRole={user.role}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              onClick={() => handleSafeNavigate('userManual')}
              className="ent-btn-primary"
            >
              <BookOpen className="w-4 h-4" aria-hidden="true" />
              <span>เปิดคู่มือการใช้งาน</span>
            </button>
          </>
        }
      />

      {/* =====================================================================
          ส่วนที่ 1: ผังลำดับความสัมพันธ์ของงานทั้งระบบ (Dependency Overview)
         ===================================================================== */}
      <section
        aria-labelledby="workflow-relationship-heading"
        className="rounded-2xl bg-white border border-[#E7E2F0] p-4 sm:p-6 space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
          <div className="space-y-1">
            <h2
              id="workflow-relationship-heading"
              className="text-[17.5px] sm:text-[18.5px] font-bold text-[#273244]"
            >
              ภาพรวมความสัมพันธ์ระหว่างขั้นตอนการทำงาน
            </h2>
            <p className="text-[13.5px] text-[#596579] leading-relaxed">
              ไม่จำเป็นต้องดำเนินการทุกขั้นตอนทุกวัน — ระบบแบ่งประเภทงานชัดเจนระหว่างงานที่ต้องทำตามลำดับ งานที่ดูได้อิสระ และงานที่ทำเฉพาะเมื่อจำเป็น
            </p>
          </div>

          {/* ตัวกรองเน้นประเภทความสัมพันธ์ */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#FAF8FF] border border-[#E7E2F0] rounded-lg self-start">
            <button
              type="button"
              onClick={() => setDependencyFilter('ALL')}
              className={`px-2.5 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                dependencyFilter === 'ALL'
                  ? 'bg-[#694C8C] text-white'
                  : 'text-[#596579] hover:text-[#273244]'
              }`}
            >
              แสดงทั้งหมด
            </button>
            {visibleDependencyTypes.map((dt) => {
              const meta = DEPENDENCY_TYPE_META[dt];
              const isActive = dependencyFilter === dt;
              return (
                <button
                  key={dt}
                  type="button"
                  onClick={() => setDependencyFilter(dt)}
                  className={`px-2.5 py-1.5 rounded-md text-[12.5px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                    isActive
                      ? 'bg-[#694C8C] text-white'
                      : 'text-[#596579] hover:text-[#273244]'
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* เส้นทางการไหลของงาน (Interactive Process Flow) */}
        <div className="overflow-x-auto pb-1">
          <div className="flex flex-wrap lg:flex-nowrap items-stretch gap-2.5 min-w-0">
            {dependencyNodes.map((node, idx) => {
              const meta = DEPENDENCY_TYPE_META[node.dependencyType];
              const isDimmed =
                dependencyFilter !== 'ALL' && node.dependencyType !== dependencyFilter;
              const isCurrentCategory = node.categoryId === selectedCategory?.id;

              return (
                <React.Fragment key={node.id}>
                  <button
                    type="button"
                    onClick={() => handleSelectCategory(node.categoryId, node.stepId)}
                    className={`flex-1 min-w-[148px] sm:min-w-[162px] p-3 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-2 ${
                      isCurrentCategory
                        ? 'bg-[#FAF8FF] border-[#694C8C] ring-1 ring-[#A78BFA]/50'
                        : 'bg-white border-[#E7E2F0] hover:border-[#A78BFA] hover:bg-[#FAF8FF]'
                    } ${isDimmed ? 'opacity-35' : 'opacity-100'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="w-6 h-6 rounded-full bg-[#E9DDF8] text-[#694C8C] font-mono text-[12px] font-bold flex items-center justify-center tabular-nums shrink-0">
                        {node.order}
                      </span>
                      <span className={`text-[11px] font-semibold ${meta.textColor} truncate`}>
                        {meta.label}
                      </span>
                    </div>
                    <div>
                      <div className="text-[13.5px] font-bold text-[#273244] leading-snug">
                        {node.label}
                      </div>
                      <div className="text-[12px] text-[#596579] mt-0.5 leading-snug">
                        {node.shortNote}
                      </div>
                    </div>
                  </button>

                  {idx < dependencyNodes.length - 1 && (
                    <div
                      className="hidden lg:flex items-center justify-center text-[#A78BFA] shrink-0"
                      aria-hidden="true"
                    >
                      <ArrowRight className="w-4 h-4" />
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* คำอธิบายประเภทขั้นตอนแบบสั้นกระชับ */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-2 border-t border-[#F3EEFC] text-[12.5px]">
          {visibleDependencyTypes.map((dt) => {
            const meta = DEPENDENCY_TYPE_META[dt];
            return (
              <div
                key={dt}
                className="px-3 py-2 rounded-lg bg-[#FAF8FF] border border-[#E7E2F0] space-y-0.5"
              >
                <div className={`font-bold ${meta.textColor}`}>{meta.label}</div>
                <div className="text-[#596579] leading-snug">{meta.shortDesc}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* =====================================================================
          ส่วนที่ 2: การ์ดหมวดงานทั้งหมด (Category Cards — สไตล์ HOSOffice V2)
         ===================================================================== */}
      <section aria-labelledby="workflow-categories-heading" className="space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2
              id="workflow-categories-heading"
              className="text-[17.5px] sm:text-[18.5px] font-bold text-[#273244]"
            >
              เลือกหมวดงานเพื่อดูลำดับขั้นตอน ({categories.length} หมวดตามสิทธิ์ของคุณ)
            </h2>
            <p className="text-[13.5px] text-[#596579]">
              คลิกที่การ์ดหมวดงานเพื่อแสดง Timeline ขั้นตอนการทำงานและจุดที่ต้องระวังด้านล่าง
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {categories.map((cat) => {
            const isSelected = selectedCategory?.id === cat.id;
            return (
              <button
                key={cat.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => handleSelectCategory(cat.id, null)}
                className={`p-4 sm:p-5 rounded-2xl border text-left transition-all flex flex-col justify-between gap-4 cursor-pointer ${
                  isSelected
                    ? 'bg-[#FAF8FF] border-[#694C8C] shadow-sm ring-1 ring-[#A78BFA]/60'
                    : 'bg-white border-[#E7E2F0] hover:border-[#A78BFA] hover:bg-[#FAF8FF]/60'
                }`}
              >
                <div className="space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <div
                      className={`w-10 h-10 rounded-xl ${cat.accentBg} ${cat.accentText} border ${cat.accentBorder} flex items-center justify-center shrink-0`}
                    >
                      <CategoryIcon iconKey={cat.iconKey} className="w-5 h-5" />
                    </div>
                    <div className="text-right">
                      <div className="text-[12px] font-semibold text-[#694C8C] tabular-nums">
                        หมวดที่ {cat.number}
                      </div>
                      <div className="text-[12px] text-[#596579] tabular-nums">
                        {cat.steps.length} ขั้นตอน
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <h3 className="text-[15.5px] font-bold text-[#273244] leading-snug">
                      {cat.title}
                    </h3>
                    <p className="text-[13px] text-[#596579] leading-relaxed line-clamp-3">
                      {cat.shortDesc}
                    </p>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#F3EEFC] flex items-center justify-between text-[13px] font-semibold">
                  <span className={isSelected ? 'text-[#694C8C]' : 'text-[#596579]'}>
                    {isSelected ? 'กำลังแสดงขั้นตอนด้านล่าง' : 'คลิกดูขั้นตอนการทำงาน'}
                  </span>
                  <ArrowRight
                    className={`w-4 h-4 transition-transform ${
                      isSelected ? 'text-[#694C8C] translate-x-0.5' : 'text-[#596579]'
                    }`}
                    aria-hidden="true"
                  />
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* =====================================================================
          ส่วนที่ 3 & 4: Timeline แนวตั้งของหมวดที่เลือก + จุดที่ต้องระวังในสายงานนี้
         ===================================================================== */}
      {selectedCategory && (
        <section
          ref={timelineRef}
          aria-labelledby="selected-category-timeline-heading"
          className="rounded-2xl bg-white border border-[#E7E2F0] overflow-hidden"
        >
          {/* หัวข้อหมวดที่เลือก */}
          <div className="px-4 sm:px-6 py-5 bg-[#FAF8FF] border-b border-[#E7E2F0] flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <div
                className={`w-11 h-11 rounded-xl ${selectedCategory.accentBg} ${selectedCategory.accentText} border ${selectedCategory.accentBorder} flex items-center justify-center shrink-0 mt-0.5`}
              >
                <CategoryIcon iconKey={selectedCategory.iconKey} className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <div className="text-[12.5px] font-semibold text-[#694C8C]">
                  หมวดที่ {selectedCategory.number} · ลำดับขั้นตอนการทำงานทั้งหมด{' '}
                  {selectedCategory.steps.length} ขั้นตอน
                </div>
                <h2
                  id="selected-category-timeline-heading"
                  className="text-[19px] sm:text-[21px] font-bold text-[#273244]"
                >
                  {selectedCategory.title}
                </h2>
                <p className="text-[13.5px] text-[#596579]">{selectedCategory.shortDesc}</p>
              </div>
            </div>
          </div>

          {/* พื้นที่หลัก: Timeline แนวตั้ง + แผงข้อควรระวัง */}
          <div className="p-4 sm:p-6 lg:p-7 grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
            {/* ซ้าย 2 คอลัมน์: Timeline แนวตั้ง */}
            <div className="lg:col-span-2">
              <ol className="relative space-y-5">
                {selectedCategory.steps.map((step, idx) => {
                  const isLast = idx === selectedCategory.steps.length - 1;
                  const meta = DEPENDENCY_TYPE_META[step.dependencyType];
                  const canAccess = canRoleAccessView(step.targetView, user.role);
                  const linkedGuide = getGuideEntry(step.guideKey);
                  const isChecklistOpen = Boolean(expandedStepChecklist[step.id]);
                  const isHighlighted = highlightedStepId === step.id;

                  return (
                    <li key={step.id} className="relative pl-12 sm:pl-14">
                      {/* เส้นเชื่อมแนวตั้งระหว่างขั้นตอน */}
                      {!isLast && (
                        <span
                          aria-hidden="true"
                          className="absolute left-[18px] sm:left-[20px] top-10 bottom-[-24px] w-[2px] bg-[#E9DDF8]"
                        />
                      )}

                      {/* วงกลมหมายเลขขั้นตอน */}
                      <span
                        aria-hidden="true"
                        className={`absolute left-0 top-1 w-9 h-9 sm:w-10 sm:h-10 rounded-full font-mono text-[14px] font-bold flex items-center justify-center tabular-nums border-2 ${
                          isHighlighted
                            ? 'bg-[#694C8C] text-white border-[#694C8C]'
                            : 'bg-[#E9DDF8] text-[#694C8C] border-white ring-1 ring-[#D5CEE6]'
                        }`}
                      >
                        {step.stepNumber}
                      </span>

                      {/* การ์ดรายละเอียดของแต่ละขั้นตอน */}
                      <div
                        className={`rounded-xl border p-4 sm:p-5 space-y-3.5 transition-colors ${
                          isHighlighted
                            ? 'bg-[#FAF8FF] border-[#694C8C]'
                            : 'bg-white border-[#E7E2F0]'
                        }`}
                      >
                        {/* หัวขั้นตอนและเมตาดาตา */}
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px]">
                            <span className={`font-bold ${meta.textColor}`}>{meta.label}</span>
                            <span aria-hidden="true" className="text-[#D5CEE6]">·</span>
                            <span className="text-[#596579]">{step.frequencyHint}</span>
                            <span aria-hidden="true" className="text-[#D5CEE6]">·</span>
                            <span
                              className={`font-semibold ${
                                step.readinessStatus === 'READY'
                                  ? 'text-[#047857]'
                                  : 'text-[#B45309]'
                              }`}
                            >
                              {step.readinessLabel}
                            </span>
                          </div>

                          <h3 className="text-[16px] sm:text-[17px] font-bold text-[#273244] leading-snug">
                            {step.title}
                          </h3>
                          <p className="text-[13.5px] sm:text-[14px] text-[#596579] leading-relaxed">
                            {step.description}
                          </p>
                        </div>

                        {/* บทบาทที่เกี่ยวข้อง และสิ่งที่ต้องเตรียม */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-[#F3EEFC] text-[13px]">
                          <div>
                            <div className="font-semibold text-[#694C8C]">
                              บทบาทผู้ใช้งานที่เกี่ยวข้อง
                            </div>
                            <div className="text-[#273244] mt-0.5">{step.roleLabel}</div>
                          </div>
                          <div>
                            <div className="font-semibold text-[#694C8C]">
                              สิ่งที่ต้องเตรียมก่อนเริ่ม
                            </div>
                            <ul className="mt-0.5 space-y-1 text-[#273244]">
                              {step.prerequisites.map((pre, pIdx) => (
                                <li key={pIdx} className="flex items-start gap-1.5">
                                  <CheckCircle2
                                    className="w-3.5 h-3.5 text-[#047857] shrink-0 mt-1"
                                    aria-hidden="true"
                                  />
                                  <span>{pre}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        {/* รายการขั้นตอนย่อยแบบขยาย/ย่อ (ดึงตรงจาก helpGuides.ts ไม่ซ้ำซ้อน) */}
                        <div className="pt-2 border-t border-[#F3EEFC]">
                          <button
                            type="button"
                            aria-expanded={isChecklistOpen}
                            onClick={() =>
                              setExpandedStepChecklist((prev) => ({
                                ...prev,
                                [step.id]: !prev[step.id],
                              }))
                            }
                            className="text-[13px] font-semibold text-[#694C8C] hover:underline inline-flex items-center gap-1.5 cursor-pointer"
                          >
                            {isChecklistOpen ? (
                              <>
                                <ChevronUp className="w-4 h-4" aria-hidden="true" />
                                <span>ซ่อนสรุปขั้นตอนย่อย ({linkedGuide.steps.length} ขั้นตอน)</span>
                              </>
                            ) : (
                              <>
                                <ChevronDown className="w-4 h-4" aria-hidden="true" />
                                <span>ดูสรุปขั้นตอนย่อยในหน้านี้ ({linkedGuide.steps.length} ขั้นตอน)</span>
                              </>
                            )}
                          </button>

                          {isChecklistOpen && (
                            <ol className="mt-2.5 space-y-1.5 pl-4 list-decimal text-[13px] text-[#273244] bg-[#FAF8FF] border border-[#E9DDF8] rounded-xl p-3.5">
                              {linkedGuide.steps.map((sub, sIdx) => (
                                <li key={sIdx} className="leading-relaxed">
                                  <span className="font-semibold">{sub.title}:</span>{' '}
                                  <span className="text-[#596579]">{sub.detail}</span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>

                        {/* ปุ่มดำเนินการ: ไปยังเมนูจริง + ดูวิธีใช้งานละเอียด */}
                        <div className="pt-2 flex flex-col sm:flex-row flex-wrap items-stretch sm:items-center gap-2.5">
                          {canAccess ? (
                            <button
                              type="button"
                              onClick={() => handleSafeNavigate(step.targetView)}
                              className="ent-btn-primary"
                            >
                              <span>ไปยังเมนู: {step.targetMenuLabel}</span>
                              <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
                            </button>
                          ) : (
                            <div className="px-3.5 py-2 rounded-lg bg-slate-100 border border-slate-200 text-[13px] text-[#596579] inline-flex items-center gap-2">
                              <Lock className="w-4 h-4 shrink-0" aria-hidden="true" />
                              <span>จำกัดสิทธิ์เฉพาะ {step.roleLabel}</span>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => setDrawerGuideKey(step.guideKey)}
                            className="ent-btn-secondary"
                          >
                            <BookOpen className="w-4 h-4 text-[#694C8C] shrink-0" aria-hidden="true" />
                            <span>ดูวิธีใช้งานละเอียด</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            {/* ขวา 1 คอลัมน์: จุดที่ต้องระวังในสายงานนี้ + คำแนะนำการเรียนรู้ */}
            <aside className="space-y-4">
              <div className="rounded-xl bg-amber-50/80 border border-amber-200 p-4 sm:p-5 space-y-3">
                <div className="flex items-center gap-2 text-[#92400E]">
                  <AlertTriangle className="w-5 h-5 text-[#B45309] shrink-0" aria-hidden="true" />
                  <h3 className="text-[15.5px] font-bold">จุดที่ต้องระวังในสายงานนี้</h3>
                </div>
                <ul className="space-y-2.5 text-[13.5px] text-[#273244] leading-relaxed list-disc pl-5">
                  {selectedCategory.precautions.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl bg-[#FAF8FF] border border-[#E7E2F0] p-4 sm:p-5 space-y-2.5">
                <div className="flex items-center gap-2 text-[#694C8C]">
                  <Info className="w-4.5 h-4.5 shrink-0" aria-hidden="true" />
                  <h3 className="text-[14.5px] font-bold">วิธีใช้งานร่วมกับคู่มือประจำหน้า</h3>
                </div>
                <p className="text-[13px] text-[#596579] leading-relaxed">
                  เมื่อกดปุ่ม <strong>“ไปยังเมนู”</strong> เพื่อไปปฏิบัติงานจริง ท่านสามารถกดปุ่ม{' '}
                  <strong className="text-[#694C8C]">“วิธีใช้งานหน้านี้”</strong> บริเวณส่วนหัวของทุกหน้าเพื่อเปิดดูขั้นตอนข้างหน้าจอได้ตลอดเวลา โดยไม่ทำให้ข้อมูลที่กำลังกรอกหายไป
                </p>
              </div>
            </aside>
          </div>
        </section>
      )}

      {/* แผงคู่มือละเอียดเมื่อกด "ดูวิธีใช้งานละเอียด" จากขั้นตอนใน Timeline */}
      {drawerGuideKey && (
        <ContextualHelpDrawer
          open={Boolean(drawerGuideKey)}
          onClose={() => setDrawerGuideKey(null)}
          guideKey={drawerGuideKey}
          userRole={user.role}
          onNavigate={onNavigate}
        />
      )}
    </div>
  );
}
