/**
 * ============================================================================
 * คอมโพเนนต์โครงสร้างหลักของแอปพลิเคชัน (Main Application Shell & Router)
 * ไฟล์: frontend/src/App.tsx
 * ============================================================================
 * หน้าที่หลัก:
 * 1. กู้คืนเซสชันผู้ใช้งานอัตโนมัติตอนเปิดหน้าเว็บด้วย GET /api/Sam_Att/auth/me
 * 2. กำหนดหน้าเริ่มต้นตามระดับสิทธิ์:
 *    - GENERAL_USER (บุคลากรทั่วไป) -> เปิดหน้า 'myAttendance' (เวลาปฏิบัติงานของฉัน) เสมอ
 *    - ADMIN / RESPONSIBLE_STAFF -> เปิดหน้า 'dashboard' (ภาพรวมองค์กร)
 * 3. จัดการโครงสร้างหน้าจอแบบ Responsive:
 *    - บนคอมพิวเตอร์ (>= 1024px): แสดงแถบเมนูด้านซ้าย (Sidebar) คงที่
 *    - บนมือถือ (< 1024px): แสดงปุ่มเปิดเมนู Drawer และแถบนำทางด่วนด้านล่าง (Bottom Quick-Access Bar)
 */

import React, { useEffect, useState } from 'react';
import {
  LogOut,
  Menu,
  ChevronRight,
  HeartHandshake,
  LayoutDashboard,
  UserCheck,
  Clock,
  CalendarDays,
  Grid,
} from 'lucide-react';
import {
  apiRequest,
  getStoredToken,
  setStoredToken,
  type AuthUser,
} from './services/api.ts';
import { RoleLabel } from './components/StatusText.tsx';
import {
  Sidebar,
  getNavBreadcrumb,
  resolveSafeNavView,
  type NavViewKey,
} from './components/layout/Sidebar.tsx';
import { LoginView } from './pages/LoginView.tsx';
import { DashboardView } from './pages/DashboardView.tsx';
import { MyAttendanceView } from './pages/MyAttendanceView.tsx';
import { PersonnelView } from './pages/PersonnelView.tsx';
import { ShiftsView } from './pages/ShiftsView.tsx';
import { HrAttendanceView } from './pages/HrAttendanceView.tsx';
import { RawScansView } from './pages/RawScansView.tsx';
import { ReportsView } from './pages/ReportsView.tsx';
import { AdminViews } from './pages/AdminViews.tsx';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [dataMode, setDataMode] = useState<'REAL' | 'DEMO'>('REAL');
  const [activeView, setActiveView] = useState<NavViewKey>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [initializing, setInitializing] = useState(true);

  // ปิดการเข้าถึงเส้นทางหน้าตั้งค่าระบบหรือตรวจสอบสถานะการเชื่อมต่อเดิมหากผู้ใช้พิมพ์ URL/Hash โดยตรง
  useEffect(() => {
    const rawPath = window.location.pathname || '';
    const rawHash = window.location.hash || '';
    const isBlockedSettingsUrl =
      /(?:^|\/)(settings|connection-status|connections)(?:\/|$)/i.test(rawPath) ||
      /^#\/?(settings|connection-status|connections)(?:\/|$)/i.test(rawHash);
    if (isBlockedSettingsUrl) {
      const basePath = rawPath.startsWith('/Sam_Att') ? '/Sam_Att/' : '/';
      window.history.replaceState(null, '', basePath);
    }
  }, []);

  useEffect(() => {
    async function restoreSession() {
      try {
        const health = await apiRequest<{ dataMode?: 'REAL' | 'DEMO' }>('/health');
        if (health.dataMode === 'DEMO' || health.dataMode === 'REAL') {
          setDataMode(health.dataMode);
        }
      } catch {
        // ignore health check failure during bootstrap
      }

      const token = getStoredToken();
      if (!token) {
        setInitializing(false);
        return;
      }
      try {
        const res = await apiRequest<{ user: AuthUser; dataMode?: 'REAL' | 'DEMO' }>('/auth/me');
        if (res.dataMode === 'DEMO' || res.dataMode === 'REAL') {
          setDataMode(res.dataMode);
        }
        setUser(res.user);
        setActiveView(resolveSafeNavView(res.user.role === 'GENERAL_USER' ? 'myAttendance' : 'dashboard', res.user.role));
      } catch {
        setStoredToken(null);
      } finally {
        setInitializing(false);
      }
    }
    restoreSession();
  }, []);

  async function handleLogout() {
    try {
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch {
      // ignore if already expired
    }
    setStoredToken(null);
    setUser(null);
  }

  function handleLoginSuccess(loggedInUser: AuthUser, resolvedMode?: 'REAL' | 'DEMO') {
    if (resolvedMode === 'DEMO' || resolvedMode === 'REAL') {
      setDataMode(resolvedMode);
    }
    setUser(loggedInUser);
    setActiveView(loggedInUser.role === 'GENERAL_USER' ? 'myAttendance' : 'dashboard');
  }

  if (initializing) {
    return (
      <div className="min-h-screen bg-[#FAF9FD] flex items-center justify-center p-4 text-center text-[15px] text-[#596579]">
        กำลังเตรียมพื้นที่ทำงานระบบบริหารเวลาปฏิบัติงาน โรงพยาบาลสามชุก...
      </div>
    );
  }

  if (!user) {
    return <LoginView dataMode={dataMode} onLoginSuccess={handleLoginSuccess} />;
  }

  const breadcrumb = getNavBreadcrumb(activeView);
  const isStaffOrAdmin = user.role === 'ADMIN' || user.role === 'RESPONSIBLE_STAFF';

  return (
    <div className="min-h-screen bg-[#FAF9FD] flex flex-col overflow-x-hidden">
      {dataMode === 'DEMO' && (
        <div
          role="status"
          aria-label="แถบแจ้งเตือนโหมดข้อมูลตัวอย่าง"
          className="bg-amber-50 border-b border-amber-200 px-4 py-2 text-center text-[13px] font-semibold text-[#B45309] flex flex-wrap items-center justify-center gap-2"
        >
          <span className="px-2 py-0.5 rounded-md bg-amber-200/80 text-[#92400E] font-bold">
            โหมดข้อมูลตัวอย่าง (DEMO)
          </span>
          <span>
            ระบบกำลังแสดงข้อมูลจำลองในฐานข้อมูลแยกเฉพาะสำหรับการทดสอบ ไม่ปะปนกับข้อมูลจริงและปิดการส่งข้อมูลเข้า HOSOffice จริง
          </span>
        </div>
      )}
      {/* Topbar: Responsive height (60px mobile, 68px desktop) */}
      <header className="bg-white border-b border-[#E7E2F0] px-3 sm:px-6 lg:px-8 h-[60px] sm:h-[68px] flex items-center justify-between gap-2 sm:gap-4 lg:gap-8 sticky top-0 z-20">
        {/* Zone 1: Mobile Drawer Toggle + Hospital Brand Identity */}
        <div className="flex items-center gap-2.5 sm:gap-3.5 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden p-2 text-[#273244] hover:bg-[#F3EEFC] rounded-lg shrink-0"
            aria-label="เปิดเมนูนำทาง"
          >
            <Menu className="w-5 h-5" />
          </button>
          <a
            href="/Sam_Att/"
            className="flex items-center gap-2.5 sm:gap-3 group min-w-0"
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-[#8B73C7] text-white flex items-center justify-center shadow-2xs group-hover:bg-[#7359B4] transition-colors shrink-0">
              <HeartHandshake className="w-4.5 h-4.5 sm:w-5 sm:h-5" />
            </div>
            <div className="min-w-0">
              <div className="text-[14.5px] sm:text-[15.5px] font-bold tracking-tight text-[#273244] leading-tight truncate">
                โรงพยาบาลสามชุก
              </div>
              <div className="hidden md:block text-[12.5px] text-[#596579] leading-tight truncate">
                ระบบบริหารเวลาปฏิบัติงานบุคลากร
              </div>
              <div className="md:hidden text-[12px] font-semibold text-[#7359B4] leading-tight truncate">
                {breadcrumb.itemLabel}
              </div>
            </div>
          </a>
        </div>

        {/* Zone 2: Contextual Breadcrumb & Current Staff Identity */}
        <div className="hidden md:flex items-center justify-between flex-1 min-w-0 text-[13.5px] text-[#596579] gap-4">
          <nav aria-label="ตำแหน่งหน้าจอปัจจุบัน" className="flex items-center gap-2 truncate pl-2">
            <span className="text-[#596579] truncate">{breadcrumb.groupTitle}</span>
            <ChevronRight className="w-4 h-4 text-[#596579]/60 shrink-0" aria-hidden="true" />
            <span className="font-semibold text-[#7359B4] truncate">{breadcrumb.itemLabel}</span>
          </nav>

          <div className="hidden xl:flex items-center gap-3.5 whitespace-nowrap shrink-0 border-l border-[#E7E2F0] pl-5">
            <span className="font-semibold text-[#273244] text-[14px]">{user.displayName}</span>
            <span aria-hidden="true" className="text-[#D5CEE6]">·</span>
            <RoleLabel role={user.role} />
            <span aria-hidden="true" className="text-[#D5CEE6]">·</span>
            <span className="font-mono text-[13px] text-[#596579]">
              รหัส: {user.approvedPersonId || 'ยังไม่ผูก'}
            </span>
          </div>
        </div>

        {/* Zone 3: Primary Session Action (Logout) */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={handleLogout}
            className="h-9 sm:h-[42px] px-2.5 sm:px-4 text-[13px] sm:text-[14px] font-semibold text-[#273244] bg-white border border-[#E7E2F0] rounded-lg hover:bg-[#F3EEFC] inline-flex items-center gap-1.5"
            title="ออกจากระบบ"
          >
            <LogOut className="w-4 h-4 text-[#596579] shrink-0" />
            <span className="hidden xs:inline sm:inline">ออกจากระบบ</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Canvas: 256px Sidebar + Spacious Content Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row">
        <Sidebar
          user={user}
          activeView={activeView}
          onSelectView={(v) => setActiveView(resolveSafeNavView(v, user.role))}
          mobileOpen={mobileMenuOpen}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <main className="flex-1 p-3.5 sm:p-6 lg:p-8 pb-24 lg:pb-8 max-w-[1440px] w-full mx-auto min-w-0">
          {activeView === 'dashboard' && (
            <DashboardView
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'myAttendance' && <MyAttendanceView user={user} />}
          {activeView === 'personnel' && <PersonnelView />}
          {activeView === 'shifts' && <ShiftsView userRole={user.role} />}
          {activeView === 'hrAttendance' && <HrAttendanceView mode="management" />}
          {activeView === 'attendanceReview' && <HrAttendanceView mode="review" />}
          {activeView === 'rawScans' && <RawScansView mode="rawScans" user={user} />}
          {activeView === 'scanners' && <RawScansView mode="scanners" user={user} />}
          {activeView === 'reports' && <ReportsView mode="reports" />}
          {activeView === 'hosofficePush' && <ReportsView mode="hosofficePush" />}
          {activeView === 'adminUsers' && <AdminViews mode="users" />}
          {activeView === 'systemLogs' && <AdminViews mode="auditLogs" />}
          {activeView === 'deployment' && <AdminViews mode="deployment" />}
        </main>
      </div>

      {/* Mobile & Tablet Fixed Bottom Quick-Access Bar */}
      <nav
        aria-label="แถบเมนูลัดสำหรับมือถือ"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-[#E7E2F0] px-2 py-1.5 shadow-lg"
      >
        <div className="grid grid-cols-5 gap-1 max-w-md mx-auto">
          {isStaffOrAdmin ? (
            <>
              <button
                type="button"
                onClick={() => setActiveView('dashboard')}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-lg text-[11.5px] font-semibold transition-colors ${
                  activeView === 'dashboard'
                    ? 'bg-[#F3EEFC] text-[#7359B4]'
                    : 'text-[#596579] hover:text-[#273244]'
                }`}
              >
                <LayoutDashboard className="w-4.5 h-4.5 mb-0.5" />
                <span className="truncate w-full text-center">ภาพรวม</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveView('attendanceReview')}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-lg text-[11.5px] font-semibold transition-colors ${
                  activeView === 'attendanceReview' || activeView === 'hrAttendance'
                    ? 'bg-[#F3EEFC] text-[#7359B4]'
                    : 'text-[#596579] hover:text-[#273244]'
                }`}
              >
                <UserCheck className="w-4.5 h-4.5 mb-0.5" />
                <span className="truncate w-full text-center">ตรวจเวลา</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveView('myAttendance')}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-lg text-[11.5px] font-semibold transition-colors ${
                  activeView === 'myAttendance'
                    ? 'bg-[#F3EEFC] text-[#7359B4]'
                    : 'text-[#596579] hover:text-[#273244]'
                }`}
              >
                <Clock className="w-4.5 h-4.5 mb-0.5" />
                <span className="truncate w-full text-center">เวลาของฉัน</span>
              </button>
              <button
                type="button"
                onClick={() => setActiveView('shifts')}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-lg text-[11.5px] font-semibold transition-colors ${
                  activeView === 'shifts'
                    ? 'bg-[#F3EEFC] text-[#7359B4]'
                    : 'text-[#596579] hover:text-[#273244]'
                }`}
              >
                <CalendarDays className="w-4.5 h-4.5 mb-0.5" />
                <span className="truncate w-full text-center">ตารางเวร</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-lg text-[11.5px] font-semibold transition-colors ${
                  mobileMenuOpen
                    ? 'bg-[#8B73C7] text-white'
                    : 'text-[#7359B4] bg-[#F3EEFC] hover:bg-[#E7E2F0]'
                }`}
              >
                <Grid className="w-4.5 h-4.5 mb-0.5" />
                <span className="truncate w-full text-center">เมนูทั้งหมด</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setActiveView('myAttendance')}
                className={`col-span-3 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-[13px] font-semibold transition-colors ${
                  activeView === 'myAttendance'
                    ? 'bg-[#F3EEFC] text-[#7359B4]'
                    : 'text-[#596579] hover:text-[#273244]'
                }`}
              >
                <Clock className="w-4.5 h-4.5" />
                <span>เวลาปฏิบัติงานของฉัน</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="col-span-2 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-[13px] font-semibold text-[#7359B4] bg-[#F3EEFC]"
              >
                <Grid className="w-4.5 h-4.5" />
                <span>ข้อมูลผู้ใช้</span>
              </button>
            </>
          )}
        </div>
      </nav>
    </div>
  );
}
