import React, { useState } from 'react';
import {
  LayoutDashboard,
  Clock,
  FileBarChart2,
  UserCheck,
  Users,
  CalendarDays,
  BarChart3,
  Radio,
  Fingerprint,
  Send,
  UserCog,
  FileClock,
  Rocket,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  X,
  HeartHandshake,
  Workflow,
  BookOpen,
} from 'lucide-react';
import { type AuthUser, type UserRole } from '../../services/api.ts';

export type NavViewKey =
  | 'dashboard'
  | 'myAttendance'
  | 'hrAttendance'
  | 'attendanceReview'
  | 'personnel'
  | 'shifts'
  | 'reports'
  | 'scanners'
  | 'rawScans'
  | 'hosofficePush'
  | 'adminUsers'
  | 'systemLogs'
  | 'deployment'
  | 'workflowGuide'
  | 'userManual';

interface SidebarNavItem {
  key: NavViewKey;
  label: string;
  subLabel: string;
  roles: UserRole[];
  icon: React.ComponentType<{ className?: string }>;
}

interface SidebarNavGroup {
  id: string;
  title: string;
  items: SidebarNavItem[];
}

export const SIDEBAR_GROUPS: SidebarNavGroup[] = [
  {
    id: 'group_dashboard',
    title: 'ภาพรวม',
    items: [
      {
        key: 'dashboard',
        label: 'แดชบอร์ดภาพรวม',
        subLabel: 'สรุปผลการลงเวลาและรายการที่ต้องดูแล',
        roles: ['ADMIN', 'RESPONSIBLE_STAFF'],
        icon: LayoutDashboard,
      },
      {
        key: 'myAttendance',
        label: 'เวลาปฏิบัติงานของฉัน',
        subLabel: 'ประวัติการลงเวลาและตารางเวรส่วนตัว',
        roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Clock,
      },
    ],
  },
  {
    id: 'group_hr',
    title: 'บริหารเวลาปฏิบัติงาน',
    items: [
      {
        key: 'hrAttendance',
        label: 'รายการลงเวลาทั้งหมด',
        subLabel: 'ข้อมูลเวลาเข้า–ออกงานทั้งโรงพยาบาล',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: FileBarChart2,
      },
      {
        key: 'attendanceReview',
        label: 'ตรวจสอบเวลาและหมายเหตุ',
        subLabel: 'รับรองผลตรวจสอบและคำนวณเวลาใหม่',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: UserCheck,
      },
      {
        key: 'personnel',
        label: 'ทะเบียนบุคลากร',
        subLabel: 'รายชื่อจาก HOSOffice และรหัสสแกน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Users,
      },
      {
        key: 'shifts',
        label: 'ตารางเวรและกะทำงาน',
        subLabel: 'ตารางเวรรายเดือนและแม่แบบกะทำงาน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: CalendarDays,
      },
      {
        key: 'reports',
        label: 'รายงานการมาสาย',
        subLabel: 'สรุปรายงานประจำงวดและส่งออก CSV',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: BarChart3,
      },
    ],
  },
  {
    id: 'group_scanners',
    title: 'เครื่องสแกน',
    items: [
      {
        key: 'scanners',
        label: 'เครื่องสแกนและการดึงข้อมูล',
        subLabel: 'ดึงข้อมูลจากเครื่องสแกนและรอบอัตโนมัติ',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Radio,
      },
      {
        key: 'rawScans',
        label: 'ข้อมูลสแกนต้นฉบับ',
        subLabel: 'ประวัติสแกนลายนิ้วมือต้นฉบับ (Immutable)',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Fingerprint,
      },
    ],
  },
  {
    id: 'group_system',
    title: 'ระบบและผู้ดูแล',
    items: [
      {
        key: 'hosofficePush',
        label: 'ส่งข้อมูล HOSOffice',
        subLabel: 'ตรวจสอบและส่งข้อมูลสรุปกลับ HOSOffice',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Send,
      },
      {
        key: 'adminUsers',
        label: 'ผู้ใช้และสิทธิ์',
        subLabel: 'จัดการบัญชีผู้ใช้และผูกชื่อบุคลากร',
        roles: ['ADMIN'],
        icon: UserCog,
      },
      {
        key: 'systemLogs',
        label: 'ประวัติการใช้งาน',
        subLabel: 'บันทึกการใช้งานและความปลอดภัยระบบ',
        roles: ['ADMIN'],
        icon: FileClock,
      },
      {
        key: 'deployment',
        label: 'อัปเดตระบบ',
        subLabel: 'ตรวจสอบสถานะและอัปเดตระบบ Sam_Att',
        roles: ['ADMIN'],
        icon: Rocket,
      },
    ],
  },
  {
    id: 'group_help',
    title: 'ช่วยเหลือ',
    items: [
      {
        key: 'workflowGuide',
        label: 'ผังขั้นตอนการทำงาน',
        subLabel: 'ภาพรวมลำดับงานและผังขั้นตอนทั้งระบบ',
        roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Workflow,
      },
      {
        key: 'userManual',
        label: 'คู่มือการใช้งาน',
        subLabel: 'คู่มือแบบทีละขั้นตอนและคำถามที่พบบ่อย',
        roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
        icon: BookOpen,
      },
    ],
  },
];

export const ALLOWED_NAV_VIEWS: readonly NavViewKey[] = SIDEBAR_GROUPS.flatMap((g) =>
  g.items.map((item) => item.key)
);

/**
 * ตรวจสอบสิทธิ์และปิดกั้นเส้นทางที่ถูกนำออกแล้ว (เช่น 'settings' หรือ 'connection-status')
 * หากไม่ถูกต้องหรือไม่ตรงสิทธิ์ จะคืนค่าหน้าจอเริ่มต้นที่ปลอดภัยตามบทบาทผู้ใช้
 */
export function resolveSafeNavView(requestedView: unknown, role: UserRole): NavViewKey {
  const defaultView: NavViewKey = role === 'GENERAL_USER' ? 'myAttendance' : 'dashboard';
  if (typeof requestedView !== 'string') {
    return defaultView;
  }
  const normalized = requestedView.trim();
  for (const group of SIDEBAR_GROUPS) {
    for (const item of group.items) {
      if (item.key === normalized && item.roles.includes(role)) {
        return item.key;
      }
    }
  }
  return defaultView;
}

export function getNavBreadcrumb(view: NavViewKey): {
  groupTitle: string;
  itemLabel: string;
  subLabel: string;
} {
  for (const group of SIDEBAR_GROUPS) {
    for (const item of group.items) {
      if (item.key === view) {
        return {
          groupTitle: group.title,
          itemLabel: item.label,
          subLabel: item.subLabel,
        };
      }
    }
  }
  return {
    groupTitle: 'ภาพรวม',
    itemLabel: 'แดชบอร์ดภาพรวม',
    subLabel: '',
  };
}

export function Sidebar({
  user,
  activeView,
  onSelectView,
  mobileOpen,
  onCloseMobile,
  collapsed = false,
  onToggleCollapse,
}: {
  user: AuthUser;
  activeView: NavViewKey;
  onSelectView: (view: NavViewKey) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({
    group_dashboard: true,
    group_hr: true,
    group_scanners: true,
    group_system: true,
    group_help: true,
  });

  function toggleGroup(id: string) {
    setOpenGroups((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function handleSelect(key: NavViewKey) {
    onSelectView(key);
    onCloseMobile();
  }

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[#262238]/35 backdrop-blur-xs lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="เมนูนำทางหลัก"
        className={`fixed lg:sticky lg:top-[64px] lg:h-[calc(100vh-64px)] top-0 bottom-0 left-0 z-50 bg-white border-r border-[#E6DFF0] flex flex-col shrink-0 transition-transform duration-200 ease-out ${
          collapsed ? 'w-64 lg:w-[76px]' : 'w-[260px]'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        {/* Mobile Drawer Header */}
        <div className="lg:hidden px-4 py-3.5 border-b border-[#E6DFF0] flex items-center justify-between bg-[#F8F7FC]">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-lg bg-[#8E70C9] text-white flex items-center justify-center shrink-0">
              <HeartHandshake className="w-4 h-4" />
            </div>
            <span className="font-bold text-[15px] text-[#262238] truncate">
              โรงพยาบาลสามชุก
            </span>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            className="p-1.5 rounded-lg text-[#746B83] hover:text-[#262238] hover:bg-[#EDE5F8] cursor-pointer"
            aria-label="ปิดเมนูนำทาง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Desktop Expand / Collapse Utility Row */}
        {onToggleCollapse && (
          <div
            className={`hidden lg:flex items-center border-b border-[#E6DFF0] px-3 py-2.5 ${
              collapsed ? 'justify-center' : 'justify-between'
            }`}
          >
            {!collapsed && (
              <span className="text-[12px] font-semibold text-[#746B83] px-1.5 truncate">
                เมนูระบบ Sam_Att V2
              </span>
            )}
            <button
              type="button"
              onClick={onToggleCollapse}
              title={collapsed ? 'ขยายแถบเมนูด้านข้าง' : 'ย่อแถบเมนูด้านข้าง'}
              aria-label={collapsed ? 'ขยายแถบเมนูด้านข้าง' : 'ย่อแถบเมนูด้านข้าง'}
              className="p-1.5 rounded-lg text-[#746B83] hover:text-[#543B7A] hover:bg-[#F2EDFA] transition-colors cursor-pointer"
            >
              {collapsed ? (
                <PanelLeftOpen className="w-4 h-4" />
              ) : (
                <PanelLeftClose className="w-4 h-4" />
              )}
            </button>
          </div>
        )}

        {/* Navigation Groups */}
        <nav
          className={`flex-1 overflow-y-auto py-3.5 ${
            collapsed ? 'px-2.5 space-y-3' : 'px-3 space-y-4'
          }`}
        >
          {SIDEBAR_GROUPS.map((group, groupIndex) => {
            const visibleItems = group.items.filter((i) => i.roles.includes(user.role));
            if (visibleItems.length === 0) return null;

            const isExpanded = collapsed ? true : (openGroups[group.id] ?? true);

            return (
              <div
                key={group.id}
                className={
                  collapsed && groupIndex > 0
                    ? 'pt-2.5 border-t border-[#E6DFF0] space-y-1'
                    : 'space-y-1'
                }
              >
                {!collapsed && (
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    onClick={() => toggleGroup(group.id)}
                    className="w-full px-2.5 py-1 flex items-center justify-between text-[12px] font-semibold text-[#746B83] hover:text-[#543B7A] rounded-md transition-colors cursor-pointer"
                  >
                    <span className="truncate">{group.title}</span>
                    {isExpanded ? (
                      <ChevronDown className="w-3.5 h-3.5 text-[#746B83]/80 shrink-0" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 text-[#746B83]/80 shrink-0" />
                    )}
                  </button>
                )}

                {isExpanded && (
                  <div className="space-y-0.5">
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeView === item.key;

                      return (
                        <button
                          key={item.key}
                          type="button"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => handleSelect(item.key)}
                          title={collapsed ? `${item.label} — ${item.subLabel}` : item.subLabel}
                          className={`w-full flex items-center rounded-xl transition-colors cursor-pointer ${
                            collapsed
                              ? 'justify-center px-2 py-2.5'
                              : 'gap-2.5 px-3 py-2 text-left'
                          } ${
                            isActive
                              ? 'bg-[#EDE5F8] text-[#543B7A] font-semibold'
                              : 'text-[#262238] hover:bg-[#F2EDFA]/70 font-medium'
                          }`}
                        >
                          <Icon
                            className={`w-[18px] h-[18px] shrink-0 ${
                              isActive ? 'text-[#543B7A]' : 'text-[#746B83]'
                            }`}
                          />
                          {!collapsed && (
                            <span className="text-[14px] leading-snug whitespace-nowrap truncate">
                              {item.label}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Compact Footer Identity */}
        {!collapsed && (
          <div className="px-3.5 py-3 m-3 bg-[#F8F7FC] border border-[#E6DFF0] rounded-xl space-y-1">
            <div className="text-[13.5px] font-bold text-[#262238] truncate">{user.displayName}</div>
            <div className="text-[12px] text-[#746B83] flex items-center gap-1.5 truncate">
              <span>
                {user.role === 'GENERAL_USER' && 'บุคลากรทั่วไป'}
                {user.role === 'RESPONSIBLE_STAFF' && 'เจ้าหน้าที่งานบุคคล'}
                {user.role === 'ADMIN' && 'ผู้ดูแลระบบ'}
              </span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">
                {user.approvedPersonId || 'ยังไม่ผูก'}
              </span>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}
