/**
 * ============================================================================
 * หน้า "ผังขั้นตอนการทำงาน" (System-Wide Interactive Workflow Guide)
 * ไฟล์: frontend/src/pages/WorkflowGuideView.tsx
 * ============================================================================
 * แสดงภาพรวมผังการทำงานทั้งระบบของ Sam_Att V2 Standalone:
 * 1. ผังความสัมพันธ์ระหว่างงานแบบ Responsive Grid (ลดการเลื่อนแนวนอน)
 * 2. การ์ดหมวดงานทั้งหมดตามสิทธิ์ผู้ใช้ในโทนสีม่วงอ่อน (Lavender Design System)
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
        category="ช่วยเหลือ"
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
          ส่วนที่ 1: ผังลำดับความสัมพันธ์ของงานทั้งระบบ (Responsive Grid Flow)
         ===================================================================== */}
      <section
        aria-labelledby="workflow-relationship-heading"
        className="ent-card p-5 sm:p-6 space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
          <div className="space-y-1">
            <h2
              id="workflow-relationship-heading"
              className="text-[17.5px] sm:text-[18.5px] font-bold text-[#262238]"
            >
              ภาพรวมความสัมพันธ์ระหว่างขั้นตอนการทำงาน
            </h2>
            <p className="text-[13.5px] text-[#746B83] leading-relaxed">
              ไม่จำเป็นต้องทำทุกขั้นตอนทุกวัน — แยกประเภทงานชัดเจนระหว่างงานตามลำดับ งานอิสระ และงานเฉพาะเมื่อจำเป็น
            </p>
          </div>

          <div className="ent-tab-bar self-start">
            <button
              type="button"
              onClick={() => setDependencyFilter('ALL')}
              className={`ent-tab-btn text-[12.5px] ${
                dependencyFilter === 'ALL' ? 'ent-tab-btn-active' : ''
              }`}
            >
              แสดงทั้งหมด
            </button>
            {visibleDependencyTypes.map((dt) => {
              const meta = DEPENDENCY_TYPE_META[dt];
              return (
                <button
                  key={dt}
                  type="button"
                  onClick={() => setDependencyFilter(dt)}
                  className={`ent-tab-btn text-[12.5px] ${
                    dependencyFilter === dt ? 'ent-tab-btn-active' : ''
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Responsive Process Grid — No horizontal scroll required */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {dependencyNodes.map((node) => {
            const meta = DEPENDENCY_TYPE_META[node.dependencyType];
            const isDimmed =
              dependencyFilter !== 'ALL' && node.dependencyType !== dependencyFilter;
            const isCurrentCategory = node.categoryId === selectedCategory?.id;

            return (
              <button
                key={node.id}
                type="button"
                onClick={() => handleSelectCategory(node.categoryId, node.stepId)}
                className={`p-3.5 rounded-xl border text-left transition-all cursor-pointer flex flex-col justify-between gap-2.5 ${
                  isCurrentCategory
                    ? 'bg-[#F2EDFA] border-[#8E70C9] ring-1 ring-[#8E70C9]/30'
                    : 'bg-white border-[#E6DFF0] hover:border-[#8E70C9]/60 hover:bg-[#F8F7FC]'
                } ${isDimmed ? 'opacity-35' : 'opacity-100'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="w-6 h-6 rounded-full bg-[#EDE5F8] text-[#543B7A] font-mono text-[12px] font-bold flex items-center justify-center tabular-nums shrink-0">
                    {node.order}
                  </span>
                  <span className={`text-[11.5px] font-semibold ${meta.textColor} truncate`}>
                    {meta.label}
                  </span>
                </div>
                <div>
                  <div className="text-[13.5px] font-bold text-[#262238] leading-snug">
                    {node.label}
                  </div>
                  <div className="text-[12px] text-[#746B83] mt-0.5 leading-snug">
                    {node.shortNote}
                  </div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Legend */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 pt-3 border-t border-[#E6DFF0] text-[12.5px]">
          {visibleDependencyTypes.map((dt) => {
            const meta = DEPENDENCY_TYPE_META[dt];
            return (
              <div key={dt} className="px-3 py-2 rounded-lg bg-[#F8F7FC] space-y-0.5">
                <div className={`font-bold ${meta.textColor}`}>{meta.label}</div>
                <div className="text-[#746B83] leading-snug">{meta.shortDesc}</div>
              </div>
            );
          })}
        </div>
      </section>

      {/* =====================================================================
          ส่วนที่ 2: การ์ดหมวดงานทั้งหมด
         ===================================================================== */}
      <section aria-labelledby="workflow-categories-heading" className="space-y-3.5">
        <div>
          <h2
            id="workflow-categories-heading"
            className="text-[17.5px] sm:text-[18.5px] font-bold text-[#262238]"
          >
            เลือกหมวดงานเพื่อดูลำดับขั้นตอน ({categories.length} หมวดตามสิทธิ์ของคุณ)
          </h2>
          <p className="text-[13.5px] text-[#746B83]">
            คลิกที่การ์ดหมวดงานเพื่อแสดง Timeline ขั้นตอนการทำงานและจุดที่ต้องระวังด้านล่าง
          </p>
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
                className={`p-5 rounded-xl border text-left transition-all flex flex-col justify-between gap-4 cursor-pointer ${
                  isSelected
                    ? 'bg-[#F2EDFA]/70 border-[#8E70C9] ring-1 ring-[#8E70C9]/30'
                    : 'bg-white border-[#E6DFF0] hover:border-[#8E70C9]/60 hover:bg-[#F8F7FC]'
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
                      <div className="text-[12px] font-semibold text-[#543B7A] tabular-nums">
                        หมวดที่ {cat.number}
                      </div>
                      <div className="text-[12px] text-[#746B83] tabular-nums">
                        {cat.steps.length} ขั้นตอน
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1">
                    <h3 className="text-[15px] font-bold text-[#262238] leading-snug">
                      {cat.title}
                    </h3>
                    <p className="text-[13px] text-[#746B83] leading-relaxed line-clamp-3">
                      {cat.shortDesc}
                    </p>
                  </div>
                </div>

                <div className="pt-3 border-t border-[#E6DFF0] flex items-center justify-between text-[13px] font-semibold">
                  <span className={isSelected ? 'text-[#543B7A]' : 'text-[#746B83]'}>
                    {isSelected ? 'กำลังแสดงด้านล่าง' : 'ดูขั้นตอนการทำงาน'}
                  </span>
                  <ArrowRight
                    className={`w-4 h-4 transition-transform ${
                      isSelected ? 'text-[#8E70C9] translate-x-0.5' : 'text-[#746B83]'
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
          ส่วนที่ 3 & 4: Timeline แนวตั้งของหมวดที่เลือก + จุดที่ต้องระวัง
         ===================================================================== */}
      {selectedCategory && (
        <section
          ref={timelineRef}
          aria-labelledby="selected-category-timeline-heading"
          className="ent-card overflow-hidden"
        >
          <div className="px-5 sm:px-6 py-5 bg-[#F8F7FC] border-b border-[#E6DFF0] flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="flex items-start gap-3.5">
              <div
                className={`w-11 h-11 rounded-xl ${selectedCategory.accentBg} ${selectedCategory.accentText} border ${selectedCategory.accentBorder} flex items-center justify-center shrink-0 mt-0.5`}
              >
                <CategoryIcon iconKey={selectedCategory.iconKey} className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <div className="text-[12.5px] font-semibold text-[#543B7A]">
                  หมวดที่ {selectedCategory.number} · {selectedCategory.steps.length} ขั้นตอน
                </div>
                <h2
                  id="selected-category-timeline-heading"
                  className="text-[19px] sm:text-[21px] font-bold text-[#262238]"
                >
                  {selectedCategory.title}
                </h2>
                <p className="text-[13.5px] text-[#746B83]">{selectedCategory.shortDesc}</p>
              </div>
            </div>
          </div>

          <div className="p-5 sm:p-6 lg:p-7 grid grid-cols-1 lg:grid-cols-3 gap-6 lg:gap-8">
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
                      {!isLast && (
                        <span
                          aria-hidden="true"
                          className="absolute left-[18px] sm:left-[20px] top-10 bottom-[-24px] w-[2px] bg-[#EDE5F8]"
                        />
                      )}

                      <span
                        aria-hidden="true"
                        className={`absolute left-0 top-1 w-9 h-9 sm:w-10 sm:h-10 rounded-full font-mono text-[14px] font-bold flex items-center justify-center tabular-nums border-2 ${
                          isHighlighted
                            ? 'bg-[#8E70C9] text-white border-[#8E70C9]'
                            : 'bg-[#EDE5F8] text-[#543B7A] border-white ring-1 ring-[#E6DFF0]'
                        }`}
                      >
                        {step.stepNumber}
                      </span>

                      <div
                        className={`rounded-xl border p-4 sm:p-5 space-y-3.5 transition-colors ${
                          isHighlighted
                            ? 'bg-[#F8F7FC] border-[#8E70C9]'
                            : 'bg-white border-[#E6DFF0]'
                        }`}
                      >
                        <div className="space-y-1.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
                            <span className={`font-bold ${meta.textColor}`}>{meta.label}</span>
                            <span aria-hidden="true" className="text-[#E6DFF0]">·</span>
                            <span className="text-[#746B83]">{step.frequencyHint}</span>
                            <span aria-hidden="true" className="text-[#E6DFF0]">·</span>
                            <span
                              className={`font-semibold ${
                                step.readinessStatus === 'READY'
                                  ? 'text-[#198568]'
                                  : 'text-[#B87516]'
                              }`}
                            >
                              {step.readinessLabel}
                            </span>
                          </div>

                          <h3 className="text-[16px] sm:text-[17px] font-bold text-[#262238] leading-snug">
                            {step.title}
                          </h3>
                          <p className="text-[13.5px] sm:text-[14px] text-[#746B83] leading-relaxed">
                            {step.description}
                          </p>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-[#F2EDFA] text-[13px]">
                          <div>
                            <div className="font-semibold text-[#543B7A]">
                              บทบาทผู้ใช้งานที่เกี่ยวข้อง
                            </div>
                            <div className="text-[#262238] mt-0.5">{step.roleLabel}</div>
                          </div>
                          <div>
                            <div className="font-semibold text-[#543B7A]">
                              สิ่งที่ต้องเตรียมก่อนเริ่ม
                            </div>
                            <ul className="mt-0.5 space-y-1 text-[#262238]">
                              {step.prerequisites.map((pre, pIdx) => (
                                <li key={pIdx} className="flex items-start gap-1.5">
                                  <CheckCircle2
                                    className="w-3.5 h-3.5 text-[#198568] shrink-0 mt-1"
                                    aria-hidden="true"
                                  />
                                  <span>{pre}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>

                        <div className="pt-2 border-t border-[#F2EDFA]">
                          <button
                            type="button"
                            aria-expanded={isChecklistOpen}
                            onClick={() =>
                              setExpandedStepChecklist((prev) => ({
                                ...prev,
                                [step.id]: !prev[step.id],
                              }))
                            }
                            className="text-[13px] font-semibold text-[#543B7A] hover:text-[#795BB8] hover:underline inline-flex items-center gap-1.5 cursor-pointer"
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
                            <ol className="mt-2.5 space-y-1.5 pl-4 list-decimal text-[13px] text-[#262238] bg-[#F8F7FC] border border-[#E6DFF0] rounded-xl p-3.5">
                              {linkedGuide.steps.map((sub, sIdx) => (
                                <li key={sIdx} className="leading-relaxed">
                                  <span className="font-semibold">{sub.title}:</span>{' '}
                                  <span className="text-[#746B83]">{sub.detail}</span>
                                </li>
                              ))}
                            </ol>
                          )}
                        </div>

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
                            <div className="px-3.5 py-2 rounded-lg bg-[#F8F7FC] border border-[#E6DFF0] text-[13px] text-[#746B83] inline-flex items-center gap-2">
                              <Lock className="w-4 h-4 shrink-0" aria-hidden="true" />
                              <span>จำกัดสิทธิ์เฉพาะ {step.roleLabel}</span>
                            </div>
                          )}

                          <button
                            type="button"
                            onClick={() => setDrawerGuideKey(step.guideKey)}
                            className="ent-btn-secondary"
                          >
                            <BookOpen className="w-4 h-4 text-[#8E70C9] shrink-0" aria-hidden="true" />
                            <span>ดูวิธีใช้งานละเอียด</span>
                          </button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>

            <aside className="space-y-4">
              <div className="rounded-xl bg-[#FEF8ED] border border-[#F3DFBC] p-4 sm:p-5 space-y-3">
                <div className="flex items-center gap-2 text-[#B87516]">
                  <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />
                  <h3 className="text-[15px] font-bold">จุดที่ต้องระวังในสายงานนี้</h3>
                </div>
                <ul className="space-y-2 text-[13.5px] text-[#262238] leading-relaxed list-disc pl-5">
                  {selectedCategory.precautions.map((item, idx) => (
                    <li key={idx}>{item}</li>
                  ))}
                </ul>
              </div>

              <div className="rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] p-4 sm:p-5 space-y-2">
                <div className="flex items-center gap-2 text-[#543B7A]">
                  <Info className="w-4.5 h-4.5 text-[#8E70C9] shrink-0" aria-hidden="true" />
                  <h3 className="text-[14.5px] font-bold">วิธีใช้งานร่วมกับคู่มือประจำหน้า</h3>
                </div>
                <p className="text-[13px] text-[#746B83] leading-relaxed">
                  เมื่อกดปุ่ม <strong className="text-[#262238]">“ไปยังเมนู”</strong> เพื่อไปปฏิบัติงานจริง ท่านสามารถกดปุ่ม{' '}
                  <strong className="text-[#543B7A]">“วิธีใช้งานหน้านี้”</strong> บริเวณส่วนหัวของทุกหน้าเพื่อเปิดดูขั้นตอนข้างหน้าจอได้ตลอดเวลา โดยไม่ทำให้ข้อมูลที่กำลังกรอกหายไป
                </p>
              </div>
            </aside>
          </div>
        </section>
      )}

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
