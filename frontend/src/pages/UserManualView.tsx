/**
 * ============================================================================
 * หน้า "คู่มือการใช้งาน" (Central Searchable User Manual & FAQ Hub)
 * ไฟล์: frontend/src/pages/UserManualView.tsx
 * ============================================================================
 * ศูนย์รวมคู่มือการใช้งานทั้งหมดของ Sam_Att V2 Standalone:
 * - ค้นหาหัวข้อคู่มือ ขั้นตอน และคำถามที่พบบ่อยแบบเรียลไทม์ (รองรับภาษาไทย/อังกฤษ)
 * - กรองตามหมวดหมู่และแสดงเฉพาะเนื้อหาที่ตรงกับบทบาทผู้ใช้ (ADMIN / RESPONSIBLE_STAFF / GENERAL_USER)
 * - แสดงเนื้อหาครบ 8 หัวข้อมาตรฐาน พร้อมขั้นตอนแบบขยาย/ย่อ (ดึงข้อมูลจาก helpGuides.ts ชุดเดียวไม่ซ้ำซ้อน)
 * - มีลิงก์ไปยังหน้าการทำงานจริงเฉพาะหน้าที่ผู้ใช้มีสิทธิ์ (ห้ามเรียก API เปลี่ยนแปลงข้อมูล)
 */

import React, { useMemo, useState } from 'react';
import {
  Search,
  BookOpen,
  Workflow,
  ArrowRight,
  CheckCircle2,
  AlertTriangle,
  Wrench,
  Info,
  HelpCircle,
  ChevronDown,
  ChevronUp,
  X,
} from 'lucide-react';
import { type AuthUser } from '../services/api.ts';
import { type NavViewKey } from '../components/layout/Sidebar.tsx';
import { PageHeader, TabBar, StatusBadge } from '../components/common/SharedComponents.tsx';
import {
  PageHelpAction,
  ExpandableStepList,
  canRoleAccessView,
} from '../components/common/ContextualHelp.tsx';
import {
  getVisibleGuidesForRole,
  getVisibleFaqsForRole,
  getVisibleManualCategoriesForRole,
  ROLE_DISPLAY_NAMES,
  type GuideContextKey,
  type ManualCategoryId,
} from '../data/helpGuides.ts';

export function UserManualView({
  user,
  onNavigate,
}: {
  user: AuthUser;
  onNavigate: (view: NavViewKey) => void;
}) {
  const allVisibleGuides = useMemo(() => getVisibleGuidesForRole(user.role), [user.role]);
  const allVisibleFaqs = useMemo(() => getVisibleFaqsForRole(user.role), [user.role]);
  const visibleCategories = useMemo(
    () => getVisibleManualCategoriesForRole(user.role),
    [user.role]
  );

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<'ALL' | 'FAQ' | ManualCategoryId>('ALL');
  const [selectedGuideKey, setSelectedGuideKey] = useState<GuideContextKey>(
    () => allVisibleGuides[0]?.key || 'myAttendance'
  );
  const [selectedTaskGroupId, setSelectedTaskGroupId] = useState<string>('ALL');
  const [openFaqIds, setOpenFaqIds] = useState<Record<string, boolean>>({});

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredGuides = useMemo(() => {
    return allVisibleGuides.filter((guide) => {
      if (
        selectedCategory !== 'ALL' &&
        selectedCategory !== 'FAQ' &&
        guide.manualCategory !== selectedCategory
      ) {
        return false;
      }
      if (!normalizedQuery) return true;
      const haystack = [
        guide.title,
        guide.menuLabel,
        guide.shortDesc,
        guide.whatItDoes,
        ...guide.searchKeywords,
        ...guide.steps.map((s) => `${s.title} ${s.detail}`),
        ...guide.troubleshooting.map((t) => `${t.problem} ${t.solution}`),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [allVisibleGuides, selectedCategory, normalizedQuery]);

  const filteredFaqs = useMemo(() => {
    if (!normalizedQuery) return allVisibleFaqs;
    return allVisibleFaqs.filter((faq) => {
      const haystack = [faq.question, faq.answer, ...faq.keywords].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [allVisibleFaqs, normalizedQuery]);

  const activeGuide =
    filteredGuides.find((g) => g.key === selectedGuideKey) || filteredGuides[0] || null;

  const activeTaskGroup =
    activeGuide && selectedTaskGroupId !== 'ALL'
      ? activeGuide.taskGroups?.find((tg) => tg.id === selectedTaskGroupId) || null
      : null;

  function handleSelectGuide(key: GuideContextKey) {
    setSelectedGuideKey(key);
    setSelectedTaskGroupId('ALL');
  }

  function handleSafeNavigate(view: NavViewKey) {
    if (!canRoleAccessView(view, user.role)) return;
    onNavigate(view);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        category="ช่วยเหลือ"
        title="คู่มือการใช้งานระบบ Sam_Att V2"
        subtitle={`ศูนย์รวมคู่มือแบบ Step-by-Step และคำถามที่พบบ่อยสำหรับสิทธิ์ ${ROLE_DISPLAY_NAMES[user.role]} — เปิดอ่านเรียนรู้ได้ตลอดเวลาโดยไม่มีผลต่อข้อมูลจริง`}
        actions={
          <>
            <PageHelpAction
              guideKey="userManual"
              userRole={user.role}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              onClick={() => handleSafeNavigate('workflowGuide')}
              className="ent-btn-primary"
            >
              <Workflow className="w-4 h-4" aria-hidden="true" />
              <span>ดูผังขั้นตอนการทำงาน</span>
            </button>
          </>
        }
      />

      {/* แถบค้นหาและเลือกหมวดหมู่ */}
      <div className="his-surface p-4 sm:p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหาหัวข้อคู่มือ ขั้นตอน หรือปัญหาที่พบ เช่น NO_SCAN, Excel, มาสาย, เครื่องสแกน, HOSOffice..."
              aria-label="ค้นหาหัวข้อคู่มือการใช้งาน"
              className="ent-input pl-10 pr-10 w-full"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-[#777287] hover:text-[#292638] hover:bg-[#F1ECFA] cursor-pointer"
                aria-label="ล้างคำค้นหา"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="text-[13px] text-[#777287] tabular-nums shrink-0">
            พบ <strong className="text-[#4E3978]">{filteredGuides.length}</strong> หัวข้อคู่มือ ·{' '}
            <strong className="text-[#4E3978]">{filteredFaqs.length}</strong> คำถามที่พบบ่อย
          </div>
        </div>

        {/* แถบหมวดหมู่คู่มือแบบ Underline */}
        <div className="border-b border-[#E8E4EF]">
          <TabBar
            variant="underline"
            activeKey={selectedCategory}
            onChange={(k) => setSelectedCategory(k as 'ALL' | 'FAQ' | ManualCategoryId)}
            items={[
              { key: 'ALL', label: 'คู่มือทั้งหมด', count: allVisibleGuides.length },
              ...visibleCategories.map((cat) => ({
                key: cat.id,
                label: cat.label,
              })),
              { key: 'FAQ', label: 'คำถามที่พบบ่อย', count: allVisibleFaqs.length },
            ]}
          />
        </div>
      </div>

      {/* ส่วนเนื้อหาคู่มือแบบ Master-Detail */}
      {selectedCategory !== 'FAQ' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* คอลัมน์ซ้าย: รายการหัวข้อคู่มือตามเมนูจริง */}
          <aside className="lg:col-span-4 his-surface overflow-hidden lg:sticky lg:top-20">
            <div className="px-4 py-3.5 bg-[#F8F7FC] border-b border-[#E8E4EF] flex items-center justify-between">
              <span className="text-[14px] font-bold text-[#292638]">
                หัวข้อคู่มือตามเมนูจริง
              </span>
              <span className="text-[12.5px] font-mono text-[#4E3978] font-semibold tabular-nums">
                {filteredGuides.length} หัวข้อ
              </span>
            </div>

            {filteredGuides.length === 0 ? (
              <div className="p-6 text-center space-y-2 text-[13.5px] text-[#777287]">
                <p>ไม่พบหัวข้อคู่มือที่ตรงกับคำค้นหา “{searchQuery}”</p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategory('ALL');
                  }}
                  className="text-[#4E3978] font-semibold hover:underline cursor-pointer"
                >
                  ล้างการค้นหาและแสดงทั้งหมด
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[#F1ECFA] max-h-[580px] overflow-y-auto">
                {filteredGuides.map((g, idx) => {
                  const isSelected = activeGuide?.key === g.key;
                  return (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => handleSelectGuide(g.key)}
                      className={`w-full px-4 py-3.5 text-left transition-colors cursor-pointer flex items-start gap-3 ${
                        isSelected
                          ? 'bg-[#F1ECFA] text-[#4E3978]'
                          : 'bg-white hover:bg-[#F8F7FC] text-[#292638]'
                      }`}
                    >
                      <span
                        className={`w-6 h-6 rounded-full font-mono text-[12px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums ${
                          isSelected
                            ? 'bg-[#8066B5] text-white'
                            : 'bg-[#E9DFF5] text-[#4E3978]'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-bold leading-snug">{g.menuLabel}</div>
                        <div className="text-[12.5px] text-[#777287] mt-0.5 line-clamp-2 leading-snug">
                          {g.shortDesc}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[#777287] tabular-nums">
                          <span>{g.steps.length} ขั้นตอน</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              g.readinessStatus === 'READY'
                                ? 'text-[#198568] font-semibold'
                                : 'text-[#B87516] font-semibold'
                            }
                          >
                            {g.readinessStatus === 'READY' ? 'พร้อมใช้งาน' : 'มีเงื่อนไขระบบ'}
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </aside>

          {/* คอลัมน์ขวา: รายละเอียดคู่มือครบทั้ง 8 ส่วน */}
          <article className="lg:col-span-8 space-y-5">
            {activeGuide ? (
              <div className="his-surface overflow-hidden">
                <div className="p-5 sm:p-6 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#4E3978]">
                      <span>{activeGuide.menuLabel}</span>
                      <StatusBadge
                        tone={activeGuide.readinessStatus === 'READY' ? 'success' : 'warning'}
                      >
                        {activeGuide.readinessLabel}
                      </StatusBadge>
                    </div>
                    <h2 className="text-[19px] sm:text-[21px] font-bold text-[#292638] leading-snug">
                      {activeGuide.title}
                    </h2>
                    <p className="text-[13.5px] text-[#777287] leading-relaxed">
                      {activeGuide.shortDesc}
                    </p>
                  </div>

                  {activeGuide.targetView &&
                    activeGuide.targetView !== 'userManual' &&
                    canRoleAccessView(activeGuide.targetView, user.role) && (
                      <button
                        type="button"
                        onClick={() => handleSafeNavigate(activeGuide.targetView!)}
                        className="ent-btn-primary shrink-0"
                      >
                        <span>เปิดหน้านี้เพื่อใช้งาน</span>
                        <ArrowRight className="w-4 h-4 shrink-0" aria-hidden="true" />
                      </button>
                    )}
                </div>

                <div className="p-5 sm:p-6 space-y-6">
                  {activeGuide.readinessStatus === 'CONDITIONAL' && activeGuide.readinessNote && (
                    <div className="p-4 rounded-xl bg-[#FEF7EA] border border-[#F2DCBA] text-[#B87516] flex items-start gap-2.5 text-[13.5px] leading-relaxed">
                      <Info className="w-5 h-5 shrink-0 mt-0.5" aria-hidden="true" />
                      <div>
                        <div className="font-bold">{activeGuide.readinessLabel}</div>
                        <p className="mt-0.5 text-[#292638]">{activeGuide.readinessNote}</p>
                      </div>
                    </div>
                  )}

                  {/* 1. เมนูนี้ใช้ทำอะไร & 2. ผู้ใช้งานที่มีสิทธิ์ */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pb-5 border-b border-[#E8E4EF]">
                    <div className="space-y-1.5">
                      <h3 className="text-[14.5px] font-bold text-[#4E3978]">
                        1. เมนูนี้ใช้ทำอะไร
                      </h3>
                      <p className="text-[13.5px] text-[#292638] leading-relaxed">
                        {activeGuide.whatItDoes}
                      </p>
                    </div>
                    <div className="space-y-1.5 md:border-l md:border-[#E8E4EF] md:pl-6">
                      <h3 className="text-[14.5px] font-bold text-[#4E3978]">
                        2. ผู้ใช้งานที่มีสิทธิ์
                      </h3>
                      <p className="text-[13.5px] text-[#292638] leading-relaxed">
                        {activeGuide.allowedRolesSummary}
                      </p>
                    </div>
                  </div>

                  {/* 3. สิ่งที่ต้องเตรียมก่อนเริ่ม */}
                  <div className="space-y-2">
                    <h3 className="text-[15px] font-bold text-[#4E3978]">
                      3. สิ่งที่ต้องเตรียมก่อนเริ่ม
                    </h3>
                    <ul className="space-y-1.5 text-[13.5px] text-[#292638]">
                      {activeGuide.prerequisites.map((pre, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          <CheckCircle2
                            className="w-4 h-4 text-[#198568] shrink-0 mt-0.5"
                            aria-hidden="true"
                          />
                          <span>{pre}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* 4. ขั้นตอนการใช้งานจริงตามลำดับ */}
                  <div className="space-y-3 pt-4 border-t border-[#E8E4EF]">
                    <div className="space-y-2">
                      <h3 className="text-[15px] font-bold text-[#4E3978]">
                        4. ขั้นตอนการใช้งานจริงตามลำดับ (กดเพื่อขยาย/ย่อแต่ละขั้นตอน)
                      </h3>

                      {activeGuide.taskGroups && activeGuide.taskGroups.length > 0 && (
                        <div className="ent-tab-bar w-full">
                          <button
                            type="button"
                            onClick={() => setSelectedTaskGroupId('ALL')}
                            className={`ent-tab-btn text-[13px] ${
                              selectedTaskGroupId === 'ALL' ? 'ent-tab-btn-active' : ''
                            }`}
                          >
                            ขั้นตอนหลักทั้งหมด
                          </button>
                          {activeGuide.taskGroups.map((tg) => (
                            <button
                              key={tg.id}
                              type="button"
                              onClick={() => setSelectedTaskGroupId(tg.id)}
                              className={`ent-tab-btn text-[13px] text-left ${
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
                      <div className="space-y-3">
                        <div className="p-3.5 rounded-xl bg-[#F1ECFA] border border-[#E8E4EF] text-[13.5px] text-[#292638]">
                          <strong className="text-[#4E3978]">{activeTaskGroup.label}:</strong>{' '}
                          {activeTaskGroup.summary}
                        </div>
                        <ExpandableStepList steps={activeTaskGroup.steps} defaultExpandedAll />
                      </div>
                    ) : (
                      <ExpandableStepList steps={activeGuide.steps} defaultExpandedAll />
                    )}
                  </div>

                  {/* 5. ตัวอย่างการใช้งานจริง */}
                  <div className="pt-5 border-t border-[#E8E4EF] space-y-2.5">
                    <h3 className="text-[15px] font-bold text-[#4E3978]">
                      5. ตัวอย่างการใช้งานจริง
                    </h3>
                    <div className="p-4 rounded-lg bg-[#F8F7FC] space-y-1.5 text-[13.5px] text-[#292638] leading-relaxed">
                      <div>
                        <span className="font-semibold text-[#777287]">สถานการณ์:</span>{' '}
                        {activeGuide.example.scenario}
                      </div>
                      <div>
                        <span className="font-semibold text-[#777287]">วิธีดำเนินการ:</span>{' '}
                        {activeGuide.example.action}
                      </div>
                      <div>
                        <span className="font-semibold text-[#198568]">ผลลัพธ์ที่ได้:</span>{' '}
                        {activeGuide.example.outcome}
                      </div>
                    </div>
                  </div>

                  {/* 6. ผลลัพธ์ที่ควรปรากฏ & 7. ข้อควรระวัง */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5 pt-5 border-t border-[#E8E4EF]">
                    <div className="p-4 rounded-lg bg-[#EEF8F4]/65 space-y-2">
                      <h3 className="text-[14.5px] font-bold text-[#198568]">
                        6. ผลลัพธ์หลังทำสำเร็จ
                      </h3>
                      <ul className="space-y-1.5 text-[13.5px] text-[#292638]">
                        {activeGuide.expectedResults.map((res, idx) => (
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

                    <div className="p-4 rounded-lg bg-[#FEF7EA]/75 space-y-2">
                      <h3 className="text-[14.5px] font-bold text-[#B87516] flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />
                        <span>7. ข้อควรระวัง</span>
                      </h3>
                      <ul className="space-y-1.5 text-[13.5px] text-[#292638] list-disc pl-5">
                        {activeGuide.precautions.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* 8. ปัญหาที่พบบ่อยและแนวทางแก้ไข */}
                  <div className="space-y-3 pt-5 border-t border-[#E8E4EF]">
                    <h3 className="text-[15px] font-bold text-[#4E3978] flex items-center gap-1.5">
                      <Wrench className="w-4 h-4 text-[#8066B5] shrink-0" aria-hidden="true" />
                      <span>8. ปัญหาที่พบบ่อยและแนวทางแก้ไข</span>
                    </h3>
                    <div className="divide-y divide-[#F1ECFA]">
                      {activeGuide.troubleshooting.map((tb, idx) => (
                        <div key={idx} className="py-3 first:pt-1 last:pb-0 space-y-1 text-[13.5px]">
                          <div className="font-semibold text-[#292638]">ปัญหา: {tb.problem}</div>
                          <div className="text-[#777287]">แนวทางแก้ไข: {tb.solution}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="his-surface p-10 text-center text-[#777287]">
                เลือกหัวข้อคู่มือจากรายการด้านซ้ายเพื่ออ่านรายละเอียด
              </div>
            )}
          </article>
        </div>
      )}

      {/* FAQ Accordion */}
      <section aria-labelledby="manual-faq-heading" className="his-surface overflow-hidden">
        <div className="px-5 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#E9DFF5] text-[#4E3978] flex items-center justify-center shrink-0">
              <HelpCircle className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="manual-faq-heading" className="text-[16px] font-bold text-[#292638]">
                คำถามที่พบบ่อยและแนวทางแก้ปัญหาเบื้องต้น (FAQ)
              </h2>
              <p className="text-[13px] text-[#777287]">
                รวมปัญหาที่เจ้าหน้าที่โรงพยาบาลพบบ่อยพร้อมคำตอบที่ทำตามได้ทันที
              </p>
            </div>
          </div>
          <span className="text-[13px] font-mono font-semibold text-[#4E3978] tabular-nums">
            {filteredFaqs.length} ข้อ
          </span>
        </div>

        <div className="divide-y divide-[#F1ECFA]">
          {filteredFaqs.length === 0 ? (
            <div className="p-8 text-center text-[14px] text-[#777287]">
              ไม่พบคำถามที่ตรงกับคำค้นหา “{searchQuery}”
            </div>
          ) : (
            filteredFaqs.map((faq, idx) => {
              const isOpen = Boolean(openFaqIds[faq.id]) || Boolean(normalizedQuery);
              const canGoToView =
                faq.relatedView && canRoleAccessView(faq.relatedView, user.role);

              return (
                <div key={faq.id} className="bg-white">
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() =>
                      setOpenFaqIds((prev) => ({ ...prev, [faq.id]: !prev[faq.id] }))
                    }
                    className="w-full px-5 py-4 flex items-start justify-between gap-4 text-left hover:bg-[#F8F7FC] transition-colors cursor-pointer"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="w-6 h-6 rounded-full bg-[#E9DFF5] text-[#4E3978] font-mono text-[12px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                        {idx + 1}
                      </span>
                      <span className="text-[14.5px] font-semibold text-[#292638] leading-snug">
                        {faq.question}
                      </span>
                    </div>
                    {isOpen ? (
                      <ChevronUp className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-[#777287] shrink-0 mt-0.5" aria-hidden="true" />
                    )}
                  </button>

                  {isOpen && (
                    <div className="px-5 pb-4 pl-14 space-y-3 text-[13.5px] text-[#777287] leading-relaxed">
                      <p className="text-[#292638]">{faq.answer}</p>
                      <div className="flex flex-wrap items-center gap-2.5">
                        {faq.relatedGuideKey && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCategory('ALL');
                              handleSelectGuide(faq.relatedGuideKey!);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className="text-[13px] font-semibold text-[#4E3978] hover:text-[#6E54A3] hover:underline inline-flex items-center gap-1 cursor-pointer"
                          >
                            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>อ่านคู่มือหัวข้อที่เกี่ยวข้อง</span>
                          </button>
                        )}
                        {canGoToView && (
                          <button
                            type="button"
                            onClick={() => handleSafeNavigate(faq.relatedView!)}
                            className="ent-btn-soft h-8 px-3 text-[12.5px]"
                          >
                            <span>ไปยังเมนูจริง</span>
                            <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>
    </div>
  );
}
