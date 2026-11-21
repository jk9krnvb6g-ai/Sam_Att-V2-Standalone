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
  Server,
  Rocket,
  ChevronDown,
  ChevronRight,
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
    title: 'ภาพรวมและข้อมูลส่วนตัว',
    items: [
      {
        key: 'dashboard',
        label: 'แดชบอร์ดภาพรวม',
        subLabel: 'สรุปผลการลงเวลาและงานที่ต้องดูแล',
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
    title: 'การบริหารเวลาและบุคลากร',
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
        subLabel: 'รับรองผลตรวจสอบและคำนวณเวลาซ้ำ',
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
        subLabel: 'แม่แบบกะทำงานและการมอบหมายเวร',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: CalendarDays,
      },
      {
        key: 'reports',
        label: 'รายงานและสถิติการมาสาย',
        subLabel: 'สรุปรายงานประจำงวดและส่งออก CSV',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: BarChart3,
      },
    ],
  },
  {
    id: 'group_scanners',
    title: 'เครื่องสแกนและข้อมูลต้นฉบับ',
    items: [
      {
        key: 'scanners',
        label: 'เครื่องสแกนและรอบดึงข้อมูล',
        subLabel: 'สถานะอุปกรณ์และตารางเวลาซิงก์',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Radio,
      },
      {
        key: 'rawScans',
        label: 'ข้อมูลสแกนต้นฉบับ',
        subLabel: 'ประวัติสแกนลายนิ้วมือจากเครื่องอ่าน',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Fingerprint,
      },
    ],
  },
  {
    id: 'group_system',
    title: 'ระบบและผู้ดูแลส่วนกลาง',
    items: [
      {
        key: 'hosofficePush',
        label: 'ส่งข้อมูลกลับ HOSOffice',
        subLabel: 'ตรวจสอบข้อมูลก่อนส่งกลับระบบหลัก',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Send,
      },
      {
        key: 'adminUsers',
        label: 'ผู้ใช้งานและสิทธิ์ระบบ',
        subLabel: 'จัดการบัญชีผู้ใช้และผูกชื่อบุคลากร',
        roles: ['ADMIN'],
        icon: UserCog,
      },
      {
        key: 'systemLogs',
        label: 'ประวัติการใช้งานระบบ',
        subLabel: 'บันทึกการตรวจสอบและเหตุการณ์สำคัญ',
        roles: ['ADMIN'],
        icon: Server,
      },
      {
        key: 'deployment',
        label: 'อัปเดตระบบ Sam_Att',
        subLabel: 'อัปเดตระบบอัตโนมัติด้วยปุ่มเดียว',
        roles: ['ADMIN'],
        icon: Rocket,
      },
    ],
  },
  {
    id: 'group_help',
    title: 'ช่วยเหลือและคู่มือการใช้งาน',
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
        subLabel: 'ศูนย์รวมคู่มือแบบทีละขั้นและคำถามที่พบบ่อย',
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
    groupTitle: 'ระบบบริหารเวลาปฏิบัติงาน',
    itemLabel: 'ภาพรวมระบบ',
    subLabel: '',
  };
}

export function Sidebar({
  user,
  activeView,
  onSelectView,
  mobileOpen,
  onCloseMobile,
}: {
  user: AuthUser;
  activeView: NavViewKey;
  onSelectView: (view: NavViewKey) => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
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
          className="fixed inset-0 z-40 bg-[#273244]/40 backdrop-blur-xs lg:hidden"
          onClick={onCloseMobile}
          aria-hidden="true"
        />
      )}

      <aside
        aria-label="เมนูนำทางหลัก"
        className={`fixed lg:static top-0 bottom-0 left-0 z-50 w-64 bg-white border-r border-[#E7E2F0] flex flex-col transition-transform duration-200 ease-out shrink-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Mobile Drawer Header */}
        <div className="lg:hidden px-5 py-4 border-b border-[#E7E2F0] flex items-center justify-between bg-[#FAF9FD]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#8B73C7] text-white flex items-center justify-center">
              <HeartHandshake className="w-4 h-4" />
            </div>
            <span className="font-bold text-[15px] text-[#273244]">โรงพยาบาลสามชุก</span>
          </div>
          <button
            type="button"
            onClick={onCloseMobile}
            className="p-1.5 rounded-lg text-[#596579] hover:text-[#273244] hover:bg-[#F3EEFC]"
            aria-label="ปิดเมนูนำทาง"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation Groups */}
        <nav className="flex-1 px-3.5 py-4 space-y-5 overflow-y-auto">
          {SIDEBAR_GROUPS.map((group) => {
            const visibleItems = group.items.filter((i) => i.roles.includes(user.role));
            if (visibleItems.length === 0) return null;

            const isExpanded = openGroups[group.id] ?? true;

            return (
              <div key={group.id} className="space-y-1">
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  onClick={() => toggleGroup(group.id)}
                  className="w-full px-3 py-1.5 flex items-center justify-between text-[12.5px] font-semibold text-[#596579] hover:text-[#273244] rounded-lg transition-colors"
                >
                  <span className="truncate">{group.title}</span>
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-[#596579]/70 shrink-0" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-[#596579]/70 shrink-0" />
                  )}
                </button>

                {isExpanded && (
                  <div className="space-y-1">
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeView === item.key;

                      return (
                        <button
                          key={item.key}
                          type="button"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => handleSelect(item.key)}
                          title={item.subLabel}
                          className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-[14.5px] rounded-xl transition-colors text-left ${
                            isActive
                              ? 'bg-[#F3EEFC] text-[#7359B4] font-semibold shadow-2xs'
                              : 'text-[#273244] hover:bg-[#FAF9FD] font-medium'
                          }`}
                        >
                          <Icon
                            className={`w-4.5 h-4.5 shrink-0 ${
                              isActive ? 'text-[#8B73C7]' : 'text-[#596579]'
                            }`}
                          />
                          <span className="truncate leading-snug">{item.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Readable Current User Card */}
        <div className="p-4 m-3.5 bg-[#FAF9FD] border border-[#E7E2F0] rounded-xl space-y-1.5">
          <div className="text-[12px] font-semibold text-[#7359B4]">ผู้ปฏิบัติงานปัจจุบัน</div>
          <div className="text-[14.5px] font-bold text-[#273244] truncate">{user.displayName}</div>
          <div className="text-[12.5px] text-[#596579] font-mono">
            รหัสบุคลากร: {user.approvedPersonId || 'ยังไม่ผูกชื่อบุคลากร'}
          </div>
          <div className="text-[12.5px] text-[#596579] leading-snug pt-1.5 border-t border-[#E7E2F0]">
            {user.role === 'GENERAL_USER' && 'สิทธิ์: ดูข้อมูลเวลาของตนเอง'}
            {user.role === 'RESPONSIBLE_STAFF' && 'สิทธิ์: เจ้าหน้าที่บริหารงานบุคคล (HR)'}
            {user.role === 'ADMIN' && 'สิทธิ์: ผู้ดูแลระบบทั้งหมด'}
          </div>
        </div>
      </aside>
    </>
  );
}
