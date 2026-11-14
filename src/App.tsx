/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { LogOut, Menu } from 'lucide-react';
import {
  apiRequest,
  getStoredToken,
  setStoredToken,
  type AuthUser,
} from './services/api.ts';
import { RoleLabel } from './components/StatusText.tsx';
import { Sidebar, type NavViewKey } from './components/layout/Sidebar.tsx';
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
  const [activeView, setActiveView] = useState<NavViewKey>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [initializing, setInitializing] = useState(true);

  useEffect(() => {
    async function restoreSession() {
      const token = getStoredToken();
      if (!token) {
        setInitializing(false);
        return;
      }
      try {
        const res = await apiRequest<{ user: AuthUser }>('/auth/me');
        setUser(res.user);
        setActiveView(res.user.role === 'GENERAL_USER' ? 'myAttendance' : 'dashboard');
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

  function handleLoginSuccess(loggedInUser: AuthUser) {
    setUser(loggedInUser);
    setActiveView(loggedInUser.role === 'GENERAL_USER' ? 'myAttendance' : 'dashboard');
  }

  if (initializing) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        กำลังตรวจสอบเซสชันและการเชื่อมต่อ Sam_Att V2 Standalone...
      </div>
    );
  }

  if (!user) {
    return <LoginView onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Top Bar Contract: 3 Clean Zones separated by gap-8 */}
      <header className="bg-white border-b border-slate-200 px-4 lg:px-6 py-3.5 flex items-center justify-between gap-4 lg:gap-8 sticky top-0 z-20">
        {/* Zone 1: Mobile Drawer Toggle + Single text element wordmark */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="lg:hidden p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg"
            aria-label="เปิดเมนูนำทาง"
          >
            <Menu className="w-5 h-5" />
          </button>
          <a
            href="/Sam_Att/"
            className="text-sm lg:text-base font-bold tracking-tight text-slate-900 whitespace-nowrap"
          >
            Sam_Att V2 Standalone · โรงพยาบาลสามชุก
          </a>
        </div>

        {/* Zone 2: Concise contextual user identity text */}
        <div className="hidden md:flex items-center gap-4 text-xs text-slate-600 whitespace-nowrap shrink-0">
          <span>ผู้ใช้งาน: {user.displayName}</span>
          <span aria-hidden="true">·</span>
          <RoleLabel role={user.role} />
          <span aria-hidden="true">·</span>
          <span className="font-mono">PERSON_ID: {user.approvedPersonId || 'UNMAPPED'}</span>
        </div>

        {/* Zone 3: 1 Primary Action (Logout) */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleLogout}
            className="px-3.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 border border-slate-300 rounded-lg hover:bg-slate-200 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>ออกจากระบบ</span>
          </button>
        </div>
      </header>

      {/* Main Workspace Canvas: Collapsible 4-Group Sidebar + Content Viewport */}
      <div className="flex-1 flex flex-col lg:flex-row">
        <Sidebar
          user={user}
          activeView={activeView}
          onSelectView={(v) => setActiveView(v)}
          mobileOpen={mobileMenuOpen}
          onCloseMobile={() => setMobileMenuOpen(false)}
        />

        <main className="flex-1 p-4 lg:p-6 max-w-7xl w-full mx-auto">
          {activeView === 'dashboard' && (
            <DashboardView onNavigate={(view) => setActiveView(view as NavViewKey)} />
          )}
          {activeView === 'myAttendance' && <MyAttendanceView user={user} />}
          {activeView === 'personnel' && <PersonnelView />}
          {activeView === 'shifts' && <ShiftsView />}
          {activeView === 'hrAttendance' && <HrAttendanceView mode="management" />}
          {activeView === 'attendanceReview' && <HrAttendanceView mode="review" />}
          {activeView === 'rawScans' && <RawScansView mode="rawScans" user={user} />}
          {activeView === 'scanners' && <RawScansView mode="scanners" user={user} />}
          {activeView === 'reports' && <ReportsView mode="reports" />}
          {activeView === 'hosofficePush' && <ReportsView mode="hosofficePush" />}
          {activeView === 'adminUsers' && <AdminViews mode="users" />}
          {activeView === 'systemLogs' && <AdminViews mode="auditLogs" />}
          {activeView === 'settings' && <AdminViews mode="settings" />}
          {activeView === 'deployment' && <AdminViews mode="deployment" />}
        </main>
      </div>
    </div>
  );
}
