import React from 'react';
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
  updateAvailableBadge = false,
}: {
  user: AuthUser;
  activeView: NavViewKey;
  onSelectView: (view: NavViewKey) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  updateAvailableBadge?: boolean;
}) {
  function handleSelect(key: NavViewKey) {
    onSelectView(key);
    onCloseMobile();
  }

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-[#292638]/35 backdrop-blur-xs lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="เมนูนำทางหลัก"
        className={`fixed lg:sticky lg:top-0 lg:h-screen top-0 bottom-0 left-0 z-50 bg-white border-r border-[#E8E4EF] flex flex-col shrink-0 transition-[width,transform] duration-200 ease-out ${
          collapsed ? 'w-[264px] lg:w-[74px]' : 'w-[264px]'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        {/* Top Brand Area — Full-Height HIS Navigation Rail */}
        <div
          className={`h-[60px] border-b border-[#E8E4EF] flex items-center shrink-0 ${
            collapsed ? 'px-3 lg:justify-center justify-between' : 'px-4 justify-between'
          }`}
        >
          <a
            href="/Sam_Att/"
            className="flex items-center gap-2.5 min-w-0 group"
            title="Sam_Att V2 Standalone — โรงพยาบาลสามชุก"
          >
            <div className="w-8 h-8 rounded-lg bg-[#8066B5] text-white flex items-center justify-center group-hover:bg-[#6E54A3] transition-colors shrink-0">
              <HeartHandshake className="w-4.5 h-4.5" />
            </div>
            {!collapsed && (
              <div className="min-w-0">
                <div className="text-[14.5px] font-bold tracking-tight text-[#292638] leading-tight truncate">
                  โรงพยาบาลสามชุก
                </div>
                <div className="text-[11.5px] font-medium text-[#777287] leading-tight truncate">
                  Sam_Att V2 · เวลาปฏิบัติงาน
                </div>
              </div>
            )}
          </a>

          <button
            type="button"
            onClick={onCloseMobile}
            className="lg:hidden p-1.5 rounded-lg text-[#777287] hover:text-[#292638] hover:bg-[#F1ECFA] cursor-pointer"
            aria-label="ปิดเมนูนำทาง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Groups — Clean, scannable, zero unnecessary accordions */}
        <nav
          className={`flex-1 overflow-y-auto py-4 ${
            collapsed ? 'px-2.5 space-y-3' : 'px-3 space-y-5'
          }`}
        >
          {SIDEBAR_GROUPS.map((group, groupIndex) => {
            const visibleItems = group.items.filter((i) => i.roles.includes(user.role));
            if (visibleItems.length === 0) return null;

            return (
              <div
                key={group.id}
                className={
                  collapsed && groupIndex > 0
                    ? 'pt-3 border-t border-[#E8E4EF] space-y-1'
                    : 'space-y-1'
                }
              >
                {!collapsed && (
                  <div className="px-3 pb-1 text-[12px] font-semibold text-[#777287]">
                    {group.title}
                  </div>
                )}

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
                        className={`relative w-full flex items-center rounded-lg transition-colors cursor-pointer ${
                          collapsed
                            ? 'justify-center px-2 py-2.5'
                            : 'gap-2.5 px-3 py-2 text-left'
                        } ${
                          isActive
                            ? 'bg-[#F1ECFA] text-[#4E3978] font-semibold'
                            : 'text-[#292638] hover:bg-[#F8F7FC] font-medium'
                        }`}
                      >
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r-full bg-[#8066B5]"
                          />
                        )}
                        <Icon
                          className={`w-[18px] h-[18px] shrink-0 ${
                            isActive ? 'text-[#8066B5]' : 'text-[#777287]'
                          }`}
                        />
                        {!collapsed && (
                          <span className="text-[14px] leading-snug whitespace-nowrap truncate flex-1">
                            {item.label}
                          </span>
                        )}
                        {item.key === 'deployment' &&
                          user.role === 'ADMIN' &&
                          updateAvailableBadge &&
                          (!collapsed ? (
                            <span
                              aria-label="มีเวอร์ชันใหม่บน GitHub"
                              className="px-1.5 py-0.5 rounded bg-[#8066B5] text-white text-[10.5px] font-semibold leading-none shrink-0"
                            >
                              ใหม่
                            </span>
                          ) : (
                            <span
                              aria-label="มีเวอร์ชันใหม่บน GitHub"
                              className="absolute top-1.5 right-2 w-2 h-2 rounded-full bg-[#8066B5]"
                            />
                          ))}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        {/* Minimal Flat Sidebar Footer — Identity + Collapse Toggle */}
        <div
          className={`border-t border-[#E8E4EF] px-3 py-3 flex items-center shrink-0 bg-white ${
            collapsed ? 'justify-center' : 'justify-between gap-2'
          }`}
        >
          {!collapsed && (
            <div className="min-w-0 pl-1">
              <div className="text-[13px] font-semibold text-[#292638] truncate">
                {user.displayName}
              </div>
              <div className="text-[11.5px] text-[#777287] flex items-center gap-1.5 truncate">
                <span>
                  {user.role === 'GENERAL_USER' && 'บุคลากรทั่วไป'}
                  {user.role === 'RESPONSIBLE_STAFF' && 'งานบุคคล (HR)'}
                  {user.role === 'ADMIN' && 'ผู้ดูแลระบบ'}
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono tabular-nums">
                  {user.approvedPersonId || 'ยังไม่ผูก'}
                </span>
              </div>
            </div>
          )}

          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              title={collapsed ? 'ขยายแถบเมนูด้านข้าง' : 'ย่อแถบเมนูด้านข้าง'}
              aria-label={collapsed ? 'ขยายแถบเมนูด้านข้าง' : 'ย่อแถบเมนูด้านข้าง'}
              className="hidden lg:inline-flex p-2 rounded-lg text-[#777287] hover:text-[#4E3978] hover:bg-[#F1ECFA] transition-colors shrink-0 cursor-pointer"
            >
              {collapsed ? (
                <PanelLeftOpen className="w-4 h-4" />
              ) : (
                <PanelLeftClose className="w-4 h-4" />
              )}
            </button>
          )}
        </div>
      </aside>
    </>
  );
}
