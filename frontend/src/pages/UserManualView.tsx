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
import { PageHeader } from '../components/common/SharedComponents.tsx';
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
        category="ช่วยเหลือและคู่มือการใช้งาน"
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
      <div className="rounded-2xl bg-white border border-[#E7E2F0] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col md:flex-row md:items-center gap-3">
          <div className="relative flex-1">
            <Search
              className="w-4.5 h-4.5 text-[#596579] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="ค้นหาหัวข้อคู่มือ ขั้นตอน หรือปัญหาที่พบ เช่น NO_SCAN, Excel, มาสาย, เครื่องสแกน, HOSOffice..."
              aria-label="ค้นหาหัวข้อคู่มือการใช้งาน"
              className="ent-input ent-input-with-icon w-full pr-10"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-[#596579] hover:text-[#273244] hover:bg-[#F3EEFC] cursor-pointer"
                aria-label="ล้างคำค้นหา"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="text-[13px] text-[#596579] tabular-nums shrink-0">
            พบ <strong className="text-[#694C8C]">{filteredGuides.length}</strong> หัวข้อคู่มือ ·{' '}
            <strong className="text-[#694C8C]">{filteredFaqs.length}</strong> คำถามที่พบบ่อย
          </div>
        </div>

        {/* ปุ่มหมวดหมู่คู่มือ */}
        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#FAF8FF] border border-[#E7E2F0] rounded-xl">
          <button
            type="button"
            onClick={() => setSelectedCategory('ALL')}
            className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              selectedCategory === 'ALL'
                ? 'bg-[#694C8C] text-white shadow-2xs'
                : 'text-[#596579] hover:text-[#273244]'
            }`}
          >
            คู่มือทั้งหมด ({allVisibleGuides.length})
          </button>

          {visibleCategories.map((cat) => (
            <button
              key={cat.id}
              type="button"
              onClick={() => setSelectedCategory(cat.id)}
              className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
                selectedCategory === cat.id
                  ? 'bg-[#694C8C] text-white shadow-2xs'
                  : 'text-[#596579] hover:text-[#273244]'
              }`}
            >
              {cat.label}
            </button>
          ))}

          <button
            type="button"
            onClick={() => setSelectedCategory('FAQ')}
            className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors whitespace-nowrap cursor-pointer ${
              selectedCategory === 'FAQ'
                ? 'bg-[#694C8C] text-white shadow-2xs'
                : 'text-[#596579] hover:text-[#273244]'
            }`}
          >
            คำถามที่พบบ่อย ({allVisibleFaqs.length})
          </button>
        </div>
      </div>

      {/* ส่วนเนื้อหาคู่มือแบบ Master-Detail (ซ่อนเฉพาะเมื่อเลือกแท็บ FAQ ล้วน) */}
      {selectedCategory !== 'FAQ' && (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* คอลัมน์ซ้าย: รายการหัวข้อคู่มือตามเมนูจริง */}
          <aside className="lg:col-span-4 rounded-2xl bg-white border border-[#E7E2F0] overflow-hidden lg:sticky lg:top-24">
            <div className="px-4 py-3.5 bg-[#FAF8FF] border-b border-[#E7E2F0] flex items-center justify-between">
              <span className="text-[14px] font-bold text-[#273244]">
                หัวข้อคู่มือตามเมนูจริง
              </span>
              <span className="text-[12.5px] font-mono text-[#694C8C] font-semibold tabular-nums">
                {filteredGuides.length} หัวข้อ
              </span>
            </div>

            {filteredGuides.length === 0 ? (
              <div className="p-6 text-center space-y-2 text-[13.5px] text-[#596579]">
                <p>ไม่พบหัวข้อคู่มือที่ตรงกับคำค้นหา “{searchQuery}”</p>
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedCategory('ALL');
                  }}
                  className="text-[#694C8C] font-semibold hover:underline cursor-pointer"
                >
                  ล้างการค้นหาและแสดงทั้งหมด
                </button>
              </div>
            ) : (
              <div className="divide-y divide-[#F3EEFC] max-h-[540px] overflow-y-auto">
                {filteredGuides.map((g, idx) => {
                  const isSelected = activeGuide?.key === g.key;
                  return (
                    <button
                      key={g.key}
                      type="button"
                      onClick={() => handleSelectGuide(g.key)}
                      className={`w-full px-4 py-3.5 text-left transition-colors cursor-pointer flex items-start gap-3 ${
                        isSelected
                          ? 'bg-[#F3EEFC]/80 text-[#694C8C]'
                          : 'bg-white hover:bg-[#FAF8FF] text-[#273244]'
                      }`}
                    >
                      <span
                        className={`w-6 h-6 rounded-full font-mono text-[12px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums ${
                          isSelected
                            ? 'bg-[#694C8C] text-white'
                            : 'bg-[#E9DDF8] text-[#694C8C]'
                        }`}
                      >
                        {idx + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[14px] font-bold leading-snug">{g.menuLabel}</div>
                        <div className="text-[12.5px] text-[#596579] mt-0.5 line-clamp-2 leading-snug">
                          {g.shortDesc}
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-[#596579] tabular-nums">
                          <span>{g.steps.length} ขั้นตอน</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              g.readinessStatus === 'READY'
                                ? 'text-[#047857] font-semibold'
                                : 'text-[#B45309] font-semibold'
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
              <div className="rounded-2xl bg-white border border-[#E7E2F0] overflow-hidden">
                {/* หัวเรื่องของคู่มือที่เลือก */}
                <div className="p-5 sm:p-6 bg-[#FAF8FF] border-b border-[#E7E2F0] flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#694C8C]">
                      <span>{activeGuide.menuLabel}</span>
                      <span aria-hidden="true" className="text-[#D5CEE6]">·</span>
                      <span
                        className={
                          activeGuide.readinessStatus === 'READY'
                            ? 'text-[#047857]'
                            : 'text-[#B45309]'
                        }
                      >
                        {activeGuide.readinessLabel}
                      </span>
                    </div>
                    <h2 className="text-[19px] sm:text-[22px] font-bold text-[#273244] leading-snug">
                      {activeGuide.title}
                    </h2>
                    <p className="text-[13.5px] text-[#596579] leading-relaxed">
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
                  {/* สถานะความพร้อมใช้งาน (กรณีมีเงื่อนไขตามจริง) */}
                  {activeGuide.readinessStatus === 'CONDITIONAL' && activeGuide.readinessNote && (
                    <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-[#92400E] flex items-start gap-2.5 text-[13.5px] leading-relaxed">
                      <Info className="w-5 h-5 text-[#B45309] shrink-0 mt-0.5" aria-hidden="true" />
                      <div>
                        <div className="font-bold">{activeGuide.readinessLabel}</div>
                        <p className="mt-0.5">{activeGuide.readinessNote}</p>
                      </div>
                    </div>
                  )}

                  {/* 1. เมนูนี้ใช้ทำอะไร & 2. ผู้ใช้งานที่มีสิทธิ์ */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl bg-[#FAF8FF] border border-[#E7E2F0] space-y-1.5">
                      <h3 className="text-[14.5px] font-bold text-[#694C8C]">
                        1. เมนูนี้ใช้ทำอะไร
                      </h3>
                      <p className="text-[13.5px] text-[#273244] leading-relaxed">
                        {activeGuide.whatItDoes}
                      </p>
                    </div>
                    <div className="p-4 rounded-xl bg-[#FAF8FF] border border-[#E7E2F0] space-y-1.5">
                      <h3 className="text-[14.5px] font-bold text-[#694C8C]">
                        2. ผู้ใช้งานที่มีสิทธิ์
                      </h3>
                      <p className="text-[13.5px] text-[#273244] leading-relaxed">
                        {activeGuide.allowedRolesSummary}
                      </p>
                    </div>
                  </div>

                  {/* 3. สิ่งที่ต้องเตรียมก่อนเริ่ม */}
                  <div className="space-y-2">
                    <h3 className="text-[15px] font-bold text-[#694C8C]">
                      3. สิ่งที่ต้องเตรียมก่อนเริ่ม
                    </h3>
                    <ul className="space-y-1.5 text-[14px] text-[#273244]">
                      {activeGuide.prerequisites.map((pre, idx) => (
                        <li key={idx} className="flex items-start gap-2">
                          <CheckCircle2
                            className="w-4 h-4 text-[#047857] shrink-0 mt-1"
                            aria-hidden="true"
                          />
                          <span>{pre}</span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  {/* 4. ขั้นตอนการใช้งานจริงตามลำดับ */}
                  <div className="space-y-3 pt-4 border-t border-[#F3EEFC]">
                    <div className="space-y-2">
                      <h3 className="text-[15.5px] font-bold text-[#694C8C]">
                        4. ขั้นตอนการใช้งานจริงตามลำดับ (กดเพื่อขยาย/ย่อแต่ละขั้นตอน)
                      </h3>

                      {activeGuide.taskGroups && activeGuide.taskGroups.length > 0 && (
                        <div className="flex flex-wrap items-center gap-1.5 p-1 bg-[#FAF8FF] border border-[#E7E2F0] rounded-xl">
                          <button
                            type="button"
                            onClick={() => setSelectedTaskGroupId('ALL')}
                            className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors cursor-pointer ${
                              selectedTaskGroupId === 'ALL'
                                ? 'bg-[#694C8C] text-white'
                                : 'text-[#596579] hover:text-[#273244]'
                            }`}
                          >
                            ขั้นตอนหลักทั้งหมด
                          </button>
                          {activeGuide.taskGroups.map((tg) => (
                            <button
                              key={tg.id}
                              type="button"
                              onClick={() => setSelectedTaskGroupId(tg.id)}
                              className={`px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors cursor-pointer text-left ${
                                selectedTaskGroupId === tg.id
                                  ? 'bg-[#694C8C] text-white'
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
                      <div className="space-y-3">
                        <div className="p-3.5 rounded-xl bg-[#F3EEFC] border border-[#E2D9F3] text-[13.5px] text-[#273244]">
                          <strong className="text-[#694C8C]">{activeTaskGroup.label}:</strong>{' '}
                          {activeTaskGroup.summary}
                        </div>
                        <ExpandableStepList steps={activeTaskGroup.steps} defaultExpandedAll />
                      </div>
                    ) : (
                      <ExpandableStepList steps={activeGuide.steps} defaultExpandedAll />
                    )}
                  </div>

                  {/* 5. ตัวอย่างการใช้งานจริง */}
                  <div className="p-4 sm:p-5 rounded-xl bg-[#FAF8FF] border border-[#E7E2F0] space-y-2">
                    <h3 className="text-[15px] font-bold text-[#694C8C]">
                      5. ตัวอย่างการใช้งานจริง
                    </h3>
                    <div className="space-y-1.5 text-[14px] text-[#273244] leading-relaxed">
                      <div>
                        <span className="font-semibold text-[#596579]">สถานการณ์:</span>{' '}
                        {activeGuide.example.scenario}
                      </div>
                      <div>
                        <span className="font-semibold text-[#596579]">วิธีดำเนินการ:</span>{' '}
                        {activeGuide.example.action}
                      </div>
                      <div>
                        <span className="font-semibold text-[#047857]">ผลลัพธ์ที่ได้:</span>{' '}
                        {activeGuide.example.outcome}
                      </div>
                    </div>
                  </div>

                  {/* 6. ผลลัพธ์ที่ควรปรากฏ & 7. ข้อควรระวัง */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 rounded-xl bg-emerald-50/60 border border-emerald-200 space-y-2">
                      <h3 className="text-[14.5px] font-bold text-[#065F46]">
                        6. ผลลัพธ์หลังทำสำเร็จ
                      </h3>
                      <ul className="space-y-1.5 text-[13.5px] text-[#273244]">
                        {activeGuide.expectedResults.map((res, idx) => (
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

                    <div className="p-4 rounded-xl bg-amber-50/70 border border-amber-200 space-y-2">
                      <h3 className="text-[14.5px] font-bold text-[#92400E] flex items-center gap-1.5">
                        <AlertTriangle className="w-4 h-4 text-[#B45309] shrink-0" aria-hidden="true" />
                        <span>7. ข้อควรระวัง</span>
                      </h3>
                      <ul className="space-y-1.5 text-[13.5px] text-[#273244] list-disc pl-5">
                        {activeGuide.precautions.map((item, idx) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>

                  {/* 8. ปัญหาที่พบบ่อยและแนวทางแก้ไข */}
                  <div className="space-y-3 pt-4 border-t border-[#F3EEFC]">
                    <h3 className="text-[15px] font-bold text-[#694C8C] flex items-center gap-1.5">
                      <Wrench className="w-4 h-4 shrink-0" aria-hidden="true" />
                      <span>8. ปัญหาที่พบบ่อยและแนวทางแก้ไข</span>
                    </h3>
                    <div className="space-y-2.5">
                      {activeGuide.troubleshooting.map((tb, idx) => (
                        <div
                          key={idx}
                          className="p-3.5 rounded-xl bg-[#FAF8FF] border border-[#E7E2F0] space-y-1 text-[13.5px]"
                        >
                          <div className="font-semibold text-[#273244]">ปัญหา: {tb.problem}</div>
                          <div className="text-[#596579]">แนวทางแก้ไข: {tb.solution}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-2xl bg-white border border-[#E7E2F0] p-10 text-center text-[#596579]">
                เลือกหัวข้อคู่มือจากรายการด้านซ้ายเพื่ออ่านรายละเอียด
              </div>
            )}
          </article>
        </div>
      )}

      {/* =====================================================================
          หัวข้อที่ 11: คำถามที่พบบ่อยและแนวทางแก้ปัญหาเบื้องต้น (FAQ Accordion)
         ===================================================================== */}
      <section
        aria-labelledby="manual-faq-heading"
        className="rounded-2xl bg-white border border-[#E7E2F0] overflow-hidden"
      >
        <div className="px-5 py-4 bg-[#FAF8FF] border-b border-[#E7E2F0] flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#E9DDF8] text-[#694C8C] flex items-center justify-center shrink-0">
              <HelpCircle className="w-5 h-5" aria-hidden="true" />
            </div>
            <div>
              <h2 id="manual-faq-heading" className="text-[17.5px] font-bold text-[#273244]">
                คำถามที่พบบ่อยและแนวทางแก้ปัญหาเบื้องต้น (FAQ)
              </h2>
              <p className="text-[13px] text-[#596579]">
                รวมปัญหาที่เจ้าหน้าที่โรงพยาบาลพบบ่อยพร้อมคำตอบที่ทำตามได้ทันที
              </p>
            </div>
          </div>
          <span className="text-[13px] font-mono font-semibold text-[#694C8C] tabular-nums">
            {filteredFaqs.length} ข้อ
          </span>
        </div>

        <div className="divide-y divide-[#F3EEFC]">
          {filteredFaqs.length === 0 ? (
            <div className="p-8 text-center text-[14px] text-[#596579]">
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
                    className="w-full px-5 py-4 flex items-start justify-between gap-4 text-left hover:bg-[#FAF8FF] transition-colors cursor-pointer"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      <span className="w-6 h-6 rounded-full bg-[#E9DDF8] text-[#694C8C] font-mono text-[12px] font-bold flex items-center justify-center shrink-0 mt-0.5 tabular-nums">
                        {idx + 1}
                      </span>
                      <span className="text-[14.5px] font-semibold text-[#273244] leading-snug">
                        {faq.question}
                      </span>
                    </div>
                    {isOpen ? (
                      <ChevronUp className="w-4.5 h-4.5 text-[#694C8C] shrink-0 mt-0.5" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="w-4.5 h-4.5 text-[#596579] shrink-0 mt-0.5" aria-hidden="true" />
                    )}
                  </button>

                  {isOpen && (
                    <div className="px-5 pb-4 pl-14 space-y-3 text-[13.5px] text-[#596579] leading-relaxed">
                      <p>{faq.answer}</p>
                      <div className="flex flex-wrap items-center gap-2.5">
                        {faq.relatedGuideKey && (
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedCategory('ALL');
                              handleSelectGuide(faq.relatedGuideKey!);
                              window.scrollTo({ top: 0, behavior: 'smooth' });
                            }}
                            className="text-[13px] font-semibold text-[#694C8C] hover:underline inline-flex items-center gap-1 cursor-pointer"
                          >
                            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>อ่านคู่มือหัวข้อที่เกี่ยวข้อง</span>
                          </button>
                        )}
                        {canGoToView && (
                          <button
                            type="button"
                            onClick={() => handleSafeNavigate(faq.relatedView!)}
                            className="text-[13px] font-semibold text-[#694C8C] bg-[#F3EEFC] hover:bg-[#E9DDF8] px-3 py-1 rounded-lg inline-flex items-center gap-1 transition-colors cursor-pointer"
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
