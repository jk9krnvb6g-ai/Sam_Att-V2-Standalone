/**
 * ============================================================================
 * คอมโพเนนต์โครงสร้างหลักของแอปพลิเคชัน (Main Application Shell & Router)
 * ไฟล์: frontend/src/App.tsx
 * ============================================================================
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
import { WorkflowGuideView } from './pages/WorkflowGuideView.tsx';
import { UserManualView } from './pages/UserManualView.tsx';

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [dataMode, setDataMode] = useState<'REAL' | 'DEMO'>('REAL');
  const [activeView, setActiveView] = useState<NavViewKey>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
        setActiveView(
          resolveSafeNavView(
            res.user.role === 'GENERAL_USER' ? 'myAttendance' : 'dashboard',
            res.user.role
          )
        );
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
      <div className="min-h-screen bg-[#F8F7FC] flex items-center justify-center p-4 text-center text-[15px] text-[#746B83]">
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
    <div className="min-h-screen bg-[#F8F7FC] flex flex-col overflow-x-hidden">
      {dataMode === 'DEMO' && (
        <div
          role="status"
          aria-label="แถบแจ้งเตือนโหมดข้อมูลตัวอย่าง"
          className="bg-[#FDF7EB] border-b border-[#B87516]/25 px-4 py-1.5 text-center text-[12.5px] font-medium text-[#B87516] flex flex-wrap items-center justify-center gap-2"
        >
          <span className="font-bold">โหมดข้อมูลตัวอย่าง (DEMO)</span>
          <span aria-hidden="true">·</span>
          <span>ฐานข้อมูลจำลองเพื่อการทดสอบ ไม่ปะปนกับข้อมูลจริงและปิดการส่งข้อมูล HOSOffice จริง</span>
        </div>
      )}

      {/* Streamlined Top Header: Brand + Breadcrumb + User Identity + Logout */}
      <header className="bg-white border-b border-[#E6DFF0] px-3 sm:px-5 lg:px-6 h-[60px] lg:h-[64px] flex items-center justify-between gap-4 sticky top-0 z-30">
        {/* Left: Brand & Breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden p-2 text-[#262238] hover:bg-[#F2EDFA] rounded-lg shrink-0 cursor-pointer"
            aria-label="เปิดเมนูนำทาง"
          >
            <Menu className="w-5 h-5" />
          </button>

          <a
            href="/Sam_Att/"
            className="flex items-center gap-2.5 group shrink-0"
          >
            <div className="w-8 h-8 rounded-lg bg-[#8E70C9] text-white flex items-center justify-center group-hover:bg-[#795BB8] transition-colors shrink-0">
              <HeartHandshake className="w-4.5 h-4.5" />
            </div>
            <span className="text-[15px] font-bold tracking-tight text-[#262238] whitespace-nowrap">
              โรงพยาบาลสามชุก
            </span>
          </a>

          <span className="hidden md:block h-5 w-px bg-[#E6DFF0] shrink-0" aria-hidden="true" />

          <nav
            aria-label="ตำแหน่งหน้าจอปัจจุบัน"
            className="hidden md:flex items-center gap-1.5 text-[13.5px] text-[#746B83] min-w-0 truncate"
          >
            <span className="truncate">{breadcrumb.groupTitle}</span>
            <ChevronRight className="w-3.5 h-3.5 text-[#746B83]/60 shrink-0" aria-hidden="true" />
            <span className="font-semibold text-[#543B7A] truncate">{breadcrumb.itemLabel}</span>
          </nav>
        </div>

        {/* Right: User Identity + Role + Logout */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="hidden md:flex items-center gap-2.5 text-[13.5px] whitespace-nowrap">
            <span className="font-semibold text-[#262238] max-w-[200px] truncate">
              {user.displayName}
            </span>
            <span aria-hidden="true" className="text-[#E6DFF0]">·</span>
            <RoleLabel role={user.role} />
          </div>

          <button
            type="button"
            onClick={handleLogout}
            className="h-9 px-3 text-[13.5px] font-semibold text-[#262238] bg-white border border-[#E6DFF0] rounded-lg hover:bg-[#F2EDFA] hover:border-[#8E70C9] hover:text-[#543B7A] inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            title="ออกจากระบบ"
          >
            <LogOut className="w-4 h-4 text-[#746B83] shrink-0" />
            <span className="hidden sm:inline">ออกจากระบบ</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Canvas: Collapsible Sidebar + Content Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row min-w-0">
        <Sidebar
          user={user}
          activeView={activeView}
          onSelectView={(v) => setActiveView(resolveSafeNavView(v, user.role))}
          mobileOpen={mobileMenuOpen}
          onCloseMobile={() => setMobileMenuOpen(false)}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((c) => !c)}
        />

        <main className="flex-1 p-4 sm:p-5 lg:p-6 xl:p-7 pb-24 lg:pb-8 max-w-[1480px] w-full mx-auto min-w-0">
          {activeView === 'dashboard' && (
            <DashboardView
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'myAttendance' && (
            <MyAttendanceView
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'personnel' && (
            <PersonnelView
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'shifts' && (
            <ShiftsView
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'hrAttendance' && (
            <HrAttendanceView
              mode="management"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'attendanceReview' && (
            <HrAttendanceView
              mode="review"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'rawScans' && (
            <RawScansView
              mode="rawScans"
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'scanners' && (
            <RawScansView
              mode="scanners"
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'reports' && (
            <ReportsView
              mode="reports"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'hosofficePush' && (
            <ReportsView
              mode="hosofficePush"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'adminUsers' && (
            <AdminViews
              mode="users"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'systemLogs' && (
            <AdminViews
              mode="auditLogs"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'deployment' && (
            <AdminViews
              mode="deployment"
              userRole={user.role}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'workflowGuide' && (
            <WorkflowGuideView
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
          {activeView === 'userManual' && (
            <UserManualView
              user={user}
              onNavigate={(view) => setActiveView(resolveSafeNavView(view, user.role))}
            />
          )}
        </main>
      </div>

      {/* Mobile & Tablet Compact Bottom Quick-Access Bar */}
      <nav
        aria-label="แถบเมนูลัดสำหรับมือถือ"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-30 bg-white/95 backdrop-blur-md border-t border-[#E6DFF0] px-2 py-1.5 shadow-sm"
      >
        <div className="grid grid-cols-5 gap-1 max-w-md mx-auto">
          {isStaffOrAdmin ? (
            <>
              <button
                type="button"
                onClick={() => setActiveView('dashboard')}
                className={`flex flex-col items-center justify-center py-1.5 px-1 rounded-lg text-[11.5px] font-semibold transition-colors ${
                  activeView === 'dashboard'
                    ? 'bg-[#EDE5F8] text-[#543B7A]'
                    : 'text-[#746B83] hover:text-[#262238]'
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
                    ? 'bg-[#EDE5F8] text-[#543B7A]'
                    : 'text-[#746B83] hover:text-[#262238]'
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
                    ? 'bg-[#EDE5F8] text-[#543B7A]'
                    : 'text-[#746B83] hover:text-[#262238]'
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
                    ? 'bg-[#EDE5F8] text-[#543B7A]'
                    : 'text-[#746B83] hover:text-[#262238]'
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
                    ? 'bg-[#8E70C9] text-white'
                    : 'text-[#543B7A] bg-[#F2EDFA] hover:bg-[#EDE5F8]'
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
                    ? 'bg-[#EDE5F8] text-[#543B7A]'
                    : 'text-[#746B83] hover:text-[#262238]'
                }`}
              >
                <Clock className="w-4.5 h-4.5" />
                <span>เวลาปฏิบัติงานของฉัน</span>
              </button>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(true)}
                className="col-span-2 flex items-center justify-center gap-2 py-2 px-3 rounded-lg text-[13px] font-semibold text-[#543B7A] bg-[#F2EDFA]"
              >
                <Grid className="w-4.5 h-4.5" />
                <span>เมนู / คู่มือ</span>
              </button>
            </>
          )}
        </div>
      </nav>
    </div>
  );
}
