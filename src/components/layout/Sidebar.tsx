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
  Sliders,
  Rocket,
  ChevronDown,
  ChevronRight,
  X,
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
  | 'settings'
  | 'deployment';

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

const SIDEBAR_GROUPS: SidebarNavGroup[] = [
  {
    id: 'group_dashboard',
    title: 'Dashboard & ข้อมูลส่วนตัว',
    items: [
      {
        key: 'dashboard',
        label: 'แดชบอร์ดภาพรวม',
        subLabel: 'Attendance Overview',
        roles: ['ADMIN', 'RESPONSIBLE_STAFF'],
        icon: LayoutDashboard,
      },
      {
        key: 'myAttendance',
        label: 'เวลาปฏิบัติงานของฉัน',
        subLabel: 'My Attendance (Own-Only)',
        roles: ['GENERAL_USER', 'RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Clock,
      },
    ],
  },
  {
    id: 'group_hr',
    title: 'งานบุคลากรและการลงเวลา',
    items: [
      {
        key: 'hrAttendance',
        label: 'จัดการ HR และรายงานการลงเวลา',
        subLabel: 'HR Attendance & Summary',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: FileBarChart2,
      },
      {
        key: 'attendanceReview',
        label: 'ตรวจสอบเวลาและการทำงาน',
        subLabel: 'Attendance Review & Reprocess',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: UserCheck,
      },
      {
        key: 'personnel',
        label: 'รายชื่อบุคลากร HOSOffice',
        subLabel: 'Personnel Roster & FINGLE_ID',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Users,
      },
      {
        key: 'shifts',
        label: 'ตารางกะและการหมุนเวียน',
        subLabel: 'Shift Management',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: CalendarDays,
      },
      {
        key: 'reports',
        label: 'รายงานและจัดอันดับการมาสาย',
        subLabel: 'Lateness Reports & CSV',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: BarChart3,
      },
    ],
  },
  {
    id: 'group_scanners',
    title: 'เครื่องสแกนและข้อมูลดิบ',
    items: [
      {
        key: 'scanners',
        label: 'เครื่องสแกนและการดึงข้อมูล',
        subLabel: 'Scanner Devices & Sync',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Radio,
      },
      {
        key: 'rawScans',
        label: 'ข้อมูลสแกนดิบและรอบการ Sync',
        subLabel: 'Raw Scans (6-Field EXE)',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Fingerprint,
      },
    ],
  },
  {
    id: 'group_system',
    title: 'ระบบและการตั้งค่า',
    items: [
      {
        key: 'hosofficePush',
        label: 'ส่งข้อมูลไป HOSOffice',
        subLabel: 'HOSOffice Preview & Push',
        roles: ['RESPONSIBLE_STAFF', 'ADMIN'],
        icon: Send,
      },
      {
        key: 'adminUsers',
        label: 'จัดการผู้ใช้งานและผูก PERSON_ID',
        subLabel: 'Users & 3-Role RBAC',
        roles: ['ADMIN'],
        icon: UserCog,
      },
      {
        key: 'systemLogs',
        label: 'ระบบ & ประวัติการทำงาน',
        subLabel: 'System & Audit Logs',
        roles: ['ADMIN'],
        icon: Server,
      },
      {
        key: 'settings',
        label: 'ตั้งค่าระบบและการเชื่อมต่อ',
        subLabel: 'Connections & Health',
        roles: ['ADMIN'],
        icon: Sliders,
      },
      {
        key: 'deployment',
        label: 'Deployment Center (Standalone)',
        subLabel: 'สำรองข้อมูล อัปเดต & Rollback',
        roles: ['ADMIN'],
        icon: Rocket,
      },
    ],
  },
];

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
          className="fixed inset-0 z-40 bg-slate-900/40 backdrop-blur-xs lg:hidden"
          onClick={onCloseMobile}
        />
      )}

      <aside
        className={`fixed lg:static top-0 bottom-0 left-0 z-50 w-72 bg-white border-r border-slate-200 flex flex-col transition-transform duration-200 ease-out shrink-0 ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        <div className="lg:hidden px-4 py-3.5 border-b border-slate-200 flex items-center justify-between">
          <span className="font-bold text-sm text-slate-900">เมนูนำทาง Sam_Att V2 Standalone</span>
          <button
            type="button"
            onClick={onCloseMobile}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-700"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 p-3 space-y-2.5 overflow-y-auto">
          {SIDEBAR_GROUPS.map((group) => {
            const visibleItems = group.items.filter((i) => i.roles.includes(user.role));
            if (visibleItems.length === 0) return null;

            const isExpanded = openGroups[group.id] ?? true;
            const hasActiveChild = visibleItems.some((i) => i.key === activeView);

            return (
              <div
                key={group.id}
                className="rounded-lg border border-slate-200 bg-slate-50/60 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  className={`w-full px-3 py-2 flex items-center justify-between text-xs font-semibold transition-colors ${
                    hasActiveChild
                      ? 'text-teal-900 bg-teal-50/80'
                      : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100/70'
                  }`}
                >
                  <span className="truncate">{group.title}</span>
                  {isExpanded ? (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  )}
                </button>

                {isExpanded && (
                  <div className="p-1.5 space-y-0.5 bg-white">
                    {visibleItems.map((item) => {
                      const Icon = item.icon;
                      const isActive = activeView === item.key;

                      return (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => handleSelect(item.key)}
                          className={`w-full flex items-center gap-2.5 px-2.5 py-2 text-xs rounded-lg transition-colors text-left ${
                            isActive
                              ? 'bg-teal-800 text-white font-semibold'
                              : 'text-slate-700 hover:bg-slate-100'
                          }`}
                        >
                          <Icon
                            className={`w-4 h-4 shrink-0 ${
                              isActive ? 'text-white' : 'text-teal-700'
                            }`}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate leading-tight">{item.label}</div>
                            <div
                              className={`text-[10px] truncate mt-0.5 ${
                                isActive ? 'text-teal-100' : 'text-slate-400'
                              }`}
                            >
                              {item.subLabel}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="p-3 m-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600">
          <div className="text-[11px] font-semibold text-teal-800">สิทธิ์ผู้ใช้งานปัจจุบัน:</div>
          <div className="font-bold text-slate-900 truncate mt-0.5">{user.displayName}</div>
          <div className="text-[11px] text-slate-500 mt-0.5 font-mono">
            {user.role} · ID: {user.approvedPersonId || 'UNMAPPED'}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {user.role === 'GENERAL_USER' && 'เข้าถึงเฉพาะข้อมูลเวลาของตนเองเท่านั้น (Own-Only)'}
            {user.role === 'RESPONSIBLE_STAFF' && 'จัดการเวลา รายงาน HR และเตรียมส่ง HOSOffice'}
            {user.role === 'ADMIN' && 'ดูแลเครื่องสแกน ฐานข้อมูล สิทธิ์ระบบ และ Deployment'}
          </div>
        </div>
      </aside>
    </>
  );
}
