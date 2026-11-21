/**
 * ============================================================================
 * ไฟล์: frontend/src/pages/AdminViews.tsx
 * หน้าที่: หน้าจอจัดการระบบสำหรับผู้ดูแลระบบ (ADMIN)
 * ============================================================================
 * ประกอบด้วย:
 * 1. UsersView (mode === 'users'): จัดการบัญชีผู้ใช้งานระบบ 3 ระดับและผูกชื่อบุคลากร (Modal Form)
 * 2. AuditView (mode === 'auditLogs'): ประวัติการใช้งานและบันทึกความปลอดภัยพร้อมคำแปลกิจกรรมภาษาไทยและตัวกรองครบชุด
 * 3. DeploymentView (mode === 'deployment'): หน้า "อัปเดตระบบ Sam_Att" แบบปุ่มเดียว (Deploy_Sam_Att.bat)
 * ============================================================================
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  Plus,
  Rocket,
  CheckCircle2,
  Search,
  PanelRightOpen,
  Clock,
  Terminal,
  ShieldCheck,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner, RoleLabel } from '../components/StatusText.tsx';
import {
  PageHeader,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SlideOverDrawer,
  SharedModal,
  TableEmptyState,
  TableLoadingSkeleton,
  RequiredMark,
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import { formatThaiDateTime } from '../utils/thaiFormat.ts';

const AUDIT_ACTION_THAI_LABELS: Record<string, string> = {
  AUTH_LOGIN_SUCCESS: 'เข้าสู่ระบบสำเร็จ',
  AUTH_LOGIN_FAILED: 'เข้าสู่ระบบไม่สำเร็จ',
  AUTH_LOGOUT: 'ออกจากระบบ',
  USER_CREATE: 'สร้างบัญชีผู้ใช้งานใหม่',
  USER_UPDATE: 'แก้ไขบัญชีผู้ใช้งาน',
  PERSONNEL_SYNC: 'ซิงก์ทะเบียนบุคลากรจาก HOSOffice',
  SCANNER_SYNC: 'ดึงข้อมูลจากเครื่องสแกนลายนิ้วมือ',
  SCANNER_INGEST: 'นำเข้าข้อมูลสแกนต้นฉบับ (Raw Scan)',
  SHIFT_TEMPLATE_CREATE: 'สร้างแม่แบบกะทำงาน',
  SHIFT_TEMPLATE_UPDATE: 'แก้ไขแม่แบบกะทำงาน',
  SHIFT_ASSIGN: 'จัดตารางเวรบุคลากร',
  SHIFT_BULK_ASSIGN: 'จัดตารางเวรหลายคนพร้อมกัน',
  SHIFT_IMPORT_EXCEL: 'นำเข้าตารางเวรจาก Excel',
  ATTENDANCE_REPROCESS: 'ประมวลผลเวลาปฏิบัติงานใหม่ (Reprocess)',
  ATTENDANCE_NOTE_ADD: 'บันทึกหมายเหตุ HR',
  ATTENDANCE_REVIEW: 'รับรองผลการตรวจสอบ HR',
  ATTENDANCE_LEAVE_CREATE: 'บันทึกการลาครึ่งวัน',
  HOSOFFICE_PUSH_PREVIEW: 'จำลองชุดข้อมูลส่งกลับ HOSOffice',
  HOSOFFICE_PUSH_LIVE: 'ส่งข้อมูลจริงกลับ HOSOffice',
  DEPLOYMENT_RUN_BAT: 'อัปเดตระบบ Sam_Att',
};

function getAuditActionThaiLabel(action: string): string {
  if (!action) return 'กิจกรรมระบบ';
  if (AUDIT_ACTION_THAI_LABELS[action]) return AUDIT_ACTION_THAI_LABELS[action];
  const upper = action.toUpperCase();
  if (upper.includes('LOGIN')) return 'การเข้าสู่ระบบ';
  if (upper.includes('SHIFT')) return 'จัดการตารางเวรและกะทำงาน';
  if (upper.includes('SCANNER') || upper.includes('RAW_SCAN')) return 'การดึง/นำเข้าข้อมูลสแกน';
  if (upper.includes('PERSONNEL')) return 'จัดการทะเบียนบุคลากร';
  if (upper.includes('REPROCESS')) return 'คำนวณเวลาปฏิบัติงานใหม่';
  if (upper.includes('NOTE') || upper.includes('REVIEW')) return 'ตรวจสอบเวลาและหมายเหตุ HR';
  if (upper.includes('PUSH')) return 'ส่งข้อมูลกลับ HOSOffice';
  if (upper.includes('DEPLOY')) return 'อัปเดตระบบ Sam_Att';
  if (upper.includes('USER')) return 'จัดการบัญชีผู้ใช้งาน';
  return action;
}

export function AdminViews({
  mode,
  userRole,
  onNavigate,
}: {
  mode: 'users' | 'auditLogs' | 'deployment';
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [createUserModalOpen, setCreateUserModalOpen] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('GENERAL_USER');
  const [newPersonId, setNewPersonId] = useState('');

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [logDateFilter, setLogDateFilter] = useState('');
  const [logActorFilter, setLogActorFilter] = useState('');
  const [logActionFilter, setLogActionFilter] = useState('');
  const [logResultFilter, setLogResultFilter] = useState('');
  const [selectedAuditLog, setSelectedAuditLog] = useState<any | null>(null);

  // Simple One-Button Deployment state
  const [deployStatus, setDeployStatus] = useState<any>(null);
  const [confirmDeployOpen, setConfirmDeployOpen] = useState(false);
  const [deployProgressOpen, setDeployProgressOpen] = useState(false);
  const [deployRunning, setDeployRunning] = useState(false);
  const [deployStepLabel, setDeployStepLabel] = useState('เตรียมความพร้อมก่อนอัปเดตระบบ...');
  const [deployPercent, setDeployPercent] = useState<number | null>(null);
  const [deployResultState, setDeployResultState] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
  const [deploySummaryText, setDeploySummaryText] = useState<string | null>(null);
  const [deployErrorText, setDeployErrorText] = useState<string | null>(null);
  const [lastDeployOutput, setLastDeployOutput] = useState<string | null>(null);

  // Sorting & Pagination for Audit Logs
  const [sortKey, setSortKey] = useState('created_at');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (mode === 'users') {
        const [uRes, pRes] = await Promise.all([apiRequest('/users'), apiRequest('/personnel')]);
        setUsers(uRes.items || []);
        setPersonnel(pRes.items || []);
      } else if (mode === 'auditLogs') {
        const qs = new URLSearchParams(logSearch ? { search: logSearch } : {});
        const res = await apiRequest(`/system-logs?${qs.toString()}`);
        setAuditLogs(res.items || []);
      } else if (mode === 'deployment') {
        const res = await apiRequest('/deployment/status');
        setDeployStatus(res);
      }
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถโหลดข้อมูลส่วนผู้ดูแลระบบได้' });
      }
    } finally {
      setLoading(false);
    }
  }, [mode, logSearch]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setSortKey(key);
      setSortDir('DESC');
    }
    setPage(1);
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setCreatingUser(true);
    try {
      await apiRequest('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername,
          password: newPassword,
          displayName: newDisplayName,
          role: newRole,
          approvedPersonId: newPersonId || null,
        }),
      });
      setNewUsername('');
      setNewPassword('');
      setNewDisplayName('');
      setNewRole('GENERAL_USER');
      setNewPersonId('');
      setCreateUserModalOpen(false);
      setNotice('สร้างบัญชีผู้ใช้งานใหม่และผูกชื่อบุคลากรเรียบร้อยแล้ว');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    } finally {
      setCreatingUser(false);
    }
  }

  async function handleExecuteOneButtonUpdate() {
    setConfirmDeployOpen(false);
    setError(null);
    setNotice(null);
    setDeployRunning(true);
    setDeployProgressOpen(true);
    setDeployResultState('RUNNING');
    setDeployStepLabel('กำลังรันสคริปต์ Deploy_Sam_Att.bat (สำรองข้อมูล · อัปเดต · ตรวจสอบระบบ)...');
    setDeployPercent(null);
    setDeploySummaryText(null);
    setDeployErrorText(null);

    try {
      const res = await apiRequest('/deployment/run-bat', {
        method: 'POST',
        body: JSON.stringify({ confirmRun: true }),
      });
      setDeployPercent(100);
      setDeployResultState('SUCCESS');
      setDeployStepLabel('อัปเดตระบบ Sam_Att สำเร็จ');
      setDeploySummaryText(
        res.message || 'อัปเดตระบบ Sam_Att V2 Standalone สำเร็จเรียบร้อยแล้ว (Exit Code: 0)'
      );
      setLastDeployOutput(res.output || null);
      setNotice('อัปเดตระบบ Sam_Att สำเร็จเรียบร้อยแล้ว');
      await loadData();
    } catch (err) {
      setDeployPercent(null);
      setDeployResultState('FAILED');
      setDeployStepLabel('การอัปเดตระบบไม่สำเร็จ');
      const msg =
        err instanceof ApiClientError
          ? err.message
          : 'เกิดข้อผิดพลาดระหว่างรันสคริปต์อัปเดตระบบ';
      setDeployErrorText(msg);
      setError({ message: msg });
      await loadData();
    } finally {
      setDeployRunning(false);
    }
  }

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => {
      if (userRoleFilter && u.role !== userRoleFilter) return false;
      if (!q) return true;
      return (
        String(u.username || '').toLowerCase().includes(q) ||
        String(u.display_name || '').toLowerCase().includes(q) ||
        String(u.full_name || '').toLowerCase().includes(q) ||
        String(u.approved_person_id || '').toLowerCase().includes(q)
      );
    });
  }, [users, userSearch, userRoleFilter]);

  const availableAuditActors = useMemo(() => {
    const set = new Set<string>();
    auditLogs.forEach((l) => {
      if (l.actor_username) set.add(String(l.actor_username));
    });
    return Array.from(set).sort();
  }, [auditLogs]);

  const availableAuditActions = useMemo(() => {
    const set = new Set<string>();
    auditLogs.forEach((l) => {
      if (l.action) set.add(String(l.action));
    });
    return Array.from(set).sort();
  }, [auditLogs]);

  const filteredAndSortedLogs = useMemo(() => {
    let list = [...auditLogs];
    if (logDateFilter) {
      list = list.filter((l) => String(l.created_at || '').slice(0, 10) === logDateFilter);
    }
    if (logActorFilter) {
      list = list.filter((l) => String(l.actor_username || '') === logActorFilter);
    }
    if (logActionFilter) {
      list = list.filter((l) => String(l.action || '') === logActionFilter);
    }
    if (logResultFilter) {
      list = list.filter((l) =>
        logResultFilter === 'SUCCESS' ? l.result === 'SUCCESS' : l.result !== 'SUCCESS'
      );
    }
    list.sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      return sortDir === 'ASC'
        ? String(valA || '').localeCompare(String(valB || ''), 'th')
        : String(valB || '').localeCompare(String(valA || ''), 'th');
    });
    return list;
  }, [auditLogs, logDateFilter, logActorFilter, logActionFilter, logResultFilter, sortKey, sortDir]);

  // =========================================================================
  // โหมด 'users': ผู้ใช้งานและสิทธิ์
  // =========================================================================
  if (mode === 'users') {
    return (
      <div className="space-y-6">
        <PageHeader
          category="ระบบและผู้ดูแล"
          title="ผู้ใช้งานและสิทธิ์การเข้าถึง"
          subtitle="จัดการบัญชีผู้ใช้ทั้ง 3 ระดับ (ผู้ดูแลระบบ, เจ้าหน้าที่งานบุคคล, บุคลากรทั่วไป) และเชื่อมโยงบัญชีเข้ากับรหัสบุคลากรของโรงพยาบาล"
          actions={
            <>
              <PageHelpAction
                guideKey="adminUsers"
                userRole={userRole}
                onNavigate={onNavigate}
              />
              <button
                type="button"
                onClick={() => setCreateUserModalOpen(true)}
                className="ent-btn-primary"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>เพิ่มบัญชีผู้ใช้งาน</span>
              </button>
            </>
          }
        />

        <ErrorBanner error={error} onRetry={loadData} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        {/* Filter Bar */}
        <div className="ent-card p-3.5 sm:p-4 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-[#746B83] absolute left-3.5 top-3" aria-hidden="true" />
            <input
              type="text"
              aria-label="ค้นหาบัญชีผู้ใช้"
              value={userSearch}
              onChange={(e) => setUserSearch(e.target.value)}
              placeholder="ค้นหา Username, ชื่อ-นามสกุล, รหัสบุคลากร..."
              className="ent-input pl-10 pr-4 w-full"
            />
          </div>
          <select
            aria-label="กรองตามระดับสิทธิ์"
            value={userRoleFilter}
            onChange={(e) => setUserRoleFilter(e.target.value)}
            className="ent-input w-full sm:w-auto"
          >
            <option value="">ทุกระดับสิทธิ์ (3 ระดับ)</option>
            <option value="ADMIN">ผู้ดูแลระบบ (ADMIN)</option>
            <option value="RESPONSIBLE_STAFF">เจ้าหน้าที่งานบุคคล (HR)</option>
            <option value="GENERAL_USER">บุคลากรทั่วไป (User)</option>
          </select>
        </div>

        <div className="ent-table-wrapper">
          <div className="px-4 sm:px-6 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC]">
            <h2 className="text-[17px] font-bold text-[#262238]">
              รายชื่อบัญชีผู้ใช้งานทั้งหมด ({filteredUsers.length} บัญชี)
            </h2>
          </div>

          {loading ? (
            <TableLoadingSkeleton rows={5} cols={6} />
          ) : (
            <>
              <div className="md:hidden divide-y divide-[#E6DFF0]">
                {filteredUsers.length === 0 ? (
                  <div className="p-8 text-center text-[14px] text-[#746B83]">
                    ไม่พบบัญชีผู้ใช้งานตามเงื่อนไขที่ค้นหา
                  </div>
                ) : (
                  filteredUsers.map((u) => (
                    <div key={u.id} className="p-4 space-y-2 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold text-[15px] text-[#262238]">{u.display_name}</div>
                          <div className="font-mono text-[13px] font-semibold text-[#746B83]">
                            #{u.id} · {u.username}
                          </div>
                        </div>
                        <RoleLabel role={u.role} />
                      </div>
                      <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E6DFF0] text-[13px] space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#746B83]">บุคลากรที่เชื่อมโยง:</span>
                          {u.approved_person_id ? (
                            <span className="font-semibold text-[#262238]">
                              {u.full_name} ({u.approved_person_id})
                            </span>
                          ) : (
                            <span className="text-[#C74455] font-medium">ยังไม่ผูกชื่อบุคลากร</span>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#746B83]">สถานะบัญชี:</span>
                          {Number(u.is_active) === 1 ? (
                            <span className="text-[#198568] font-semibold">ใช้งานปกติ</span>
                          ) : (
                            <span className="text-[#C74455] font-semibold">ระงับการใช้งาน</span>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-[14px]">
                  <thead>
                    <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                      <th className="py-3.5 px-5 font-semibold text-[13px]">ชื่อบัญชีผู้ใช้งาน</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">ชื่อ-นามสกุล</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">ระดับสิทธิ์</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">บุคลากรที่เชื่อมโยง</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">สถานะบัญชี</th>
                      <th className="py-3.5 px-5 font-semibold text-[13px]">เข้าใช้งานล่าสุด</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6DFF0]">
                    {filteredUsers.length === 0 ? (
                      <TableEmptyState colSpan={6} title="ไม่พบบัญชีผู้ใช้งานตามเงื่อนไขที่ค้นหา" />
                    ) : (
                      filteredUsers.map((u) => (
                        <tr key={u.id} className="hover:bg-[#F8F7FC]">
                          <td className="py-3.5 px-5 font-mono font-bold text-[#262238]">
                            #{u.id} · {u.username}
                          </td>
                          <td className="py-3.5 px-5 font-semibold text-[#262238]">{u.display_name}</td>
                          <td className="py-3.5 px-5">
                            <RoleLabel role={u.role} />
                          </td>
                          <td className="py-3.5 px-5">
                            {u.approved_person_id ? (
                              <div>
                                <span className="font-semibold text-[#262238]">{u.full_name}</span>{' '}
                                <span className="font-mono text-[12.5px] text-[#543B7A]">
                                  ({u.approved_person_id})
                                </span>
                              </div>
                            ) : (
                              <span className="text-[#C74455] font-medium">ยังไม่ผูกชื่อบุคลากร</span>
                            )}
                          </td>
                          <td className="py-3.5 px-5 font-semibold">
                            {Number(u.is_active) === 1 ? (
                              <span className="text-[#198568]">ใช้งานปกติ</span>
                            ) : (
                              <span className="text-[#C74455]">ระงับการใช้งาน</span>
                            )}
                          </td>
                          <td className="py-3.5 px-5 font-mono tabular-nums text-[#746B83]">
                            {u.last_login_at ? formatThaiDateTime(u.last_login_at) : '—'}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Create User Modal split into Account Information & Authorization */}
        <SharedModal
          open={createUserModalOpen}
          onClose={() => setCreateUserModalOpen(false)}
          kickerText="ระบบผู้ใช้งานและสิทธิ์การเข้าถึง"
          title="เพิ่มบัญชีผู้ใช้งานใหม่"
          subtitle="สำหรับบุคลากรทั่วไป ระบบจะใช้รหัสบุคลากรที่ผูกไว้นี้เพื่อจำกัดให้ดูได้เฉพาะข้อมูลเวลาของตนเองเท่านั้น"
          maxWidthClass="max-w-2xl"
        >
          <form onSubmit={handleCreateUser} className="space-y-6">
            {/* Section 1: Account Information */}
            <div className="space-y-4">
              <div className="text-[13.5px] font-bold text-[#543B7A] border-b border-[#E6DFF0] pb-1.5">
                1. ข้อมูลบัญชีผู้ใช้ (Account Information)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="ent-label">
                    ชื่อบัญชีผู้ใช้ (Username) <RequiredMark />
                  </label>
                  <input
                    type="text"
                    required
                    value={newUsername}
                    onChange={(e) => setNewUsername(e.target.value)}
                    placeholder="เช่น user1005"
                    className="ent-input w-full font-mono"
                  />
                </div>
                <div>
                  <label className="ent-label">
                    รหัสผ่าน (อย่างน้อย 8 ตัวอักษร) <RequiredMark />
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    className="ent-input w-full"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="ent-label">
                    ชื่อ-นามสกุลที่แสดงในระบบ <RequiredMark />
                  </label>
                  <input
                    type="text"
                    required
                    value={newDisplayName}
                    onChange={(e) => setNewDisplayName(e.target.value)}
                    placeholder="ระบุชื่อ-นามสกุล"
                    className="ent-input w-full"
                  />
                </div>
              </div>
            </div>

            {/* Section 2: Authorization */}
            <div className="space-y-4">
              <div className="text-[13.5px] font-bold text-[#543B7A] border-b border-[#E6DFF0] pb-1.5">
                2. สิทธิ์การเข้าถึงและการเชื่อมโยงบุคลากร (Authorization)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="ent-label">
                    ระดับสิทธิ์การใช้งาน <RequiredMark />
                  </label>
                  <select
                    value={newRole}
                    onChange={(e) => setNewRole(e.target.value as UserRole)}
                    className="ent-input w-full"
                  >
                    <option value="GENERAL_USER">บุคลากรทั่วไป (ดูเฉพาะตนเอง)</option>
                    <option value="RESPONSIBLE_STAFF">เจ้าหน้าที่งานบุคคล (HR)</option>
                    <option value="ADMIN">ผู้ดูแลระบบ (ADMIN)</option>
                  </select>
                </div>
                <div>
                  <label className="ent-label">เชื่อมโยงชื่อบุคลากร (HOSOffice)</label>
                  <select
                    value={newPersonId}
                    onChange={(e) => setNewPersonId(e.target.value)}
                    className="ent-input w-full"
                  >
                    <option value="">-- ยังไม่เชื่อมโยง --</option>
                    {personnel.map((p) => (
                      <option key={p.person_id} value={p.person_id}>
                        {p.full_name} ({p.person_id})
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E6DFF0]">
              <button
                type="button"
                onClick={() => setCreateUserModalOpen(false)}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={creatingUser}
                className="ent-btn-primary w-full sm:w-auto"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>{creatingUser ? 'กำลังสร้างบัญชี...' : 'ยืนยันสร้างบัญชีผู้ใช้งาน'}</span>
              </button>
            </div>
          </form>
        </SharedModal>
      </div>
    );
  }

  // =========================================================================
  // โหมด 'auditLogs': ประวัติการใช้งานระบบ
  // =========================================================================
  if (mode === 'auditLogs') {
    const numericSize = pageSize === 'ALL' ? Math.max(1, filteredAndSortedLogs.length) : pageSize;
    const pagedLogs = filteredAndSortedLogs.slice((page - 1) * numericSize, page * numericSize);

    return (
      <div className="space-y-6">
        <PageHeader
          category="ระบบและผู้ดูแล"
          title="ประวัติการใช้งานระบบ (Audit Logs)"
          subtitle="บันทึกทุกกิจกรรมการเข้าสู่ระบบ การตรวจสอบเวลา การซิงก์ข้อมูล และการอัปเดตระบบแบบอ่านอย่างเดียว (พร้อมปิดบังรหัสผ่านอัตโนมัติ)"
          actions={
            <PageHelpAction
              guideKey="systemLogs"
              userRole={userRole}
              onNavigate={onNavigate}
            />
          }
        />

        {/* Comprehensive Audit Filter Bar */}
        <div className="ent-card p-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative">
            <Search className="w-4 h-4 text-[#746B83] absolute left-3.5 top-3" aria-hidden="true" />
            <input
              type="text"
              aria-label="ค้นหาประวัติการใช้งาน"
              value={logSearch}
              onChange={(e) => {
                setLogSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาคำสำคัญ, รหัสอ้างอิง..."
              className="ent-input pl-10 pr-4 w-full"
            />
          </div>

          <input
            type="date"
            aria-label="กรองตามวันที่"
            value={logDateFilter}
            onChange={(e) => {
              setLogDateFilter(e.target.value);
              setPage(1);
            }}
            className="ent-input font-mono w-full"
          />

          <select
            aria-label="กรองตามผู้ดำเนินการ"
            value={logActorFilter}
            onChange={(e) => {
              setLogActorFilter(e.target.value);
              setPage(1);
            }}
            className="ent-input w-full"
          >
            <option value="">ผู้ดำเนินการทั้งหมด</option>
            {availableAuditActors.map((actor) => (
              <option key={actor} value={actor}>
                {actor}
              </option>
            ))}
          </select>

          <select
            aria-label="กรองตามประเภทกิจกรรม"
            value={logActionFilter}
            onChange={(e) => {
              setLogActionFilter(e.target.value);
              setPage(1);
            }}
            className="ent-input w-full"
          >
            <option value="">กิจกรรมทั้งหมด</option>
            {availableAuditActions.map((act) => (
              <option key={act} value={act}>
                {getAuditActionThaiLabel(act)}
              </option>
            ))}
          </select>

          <select
            aria-label="กรองตามผลลัพธ์"
            value={logResultFilter}
            onChange={(e) => {
              setLogResultFilter(e.target.value);
              setPage(1);
            }}
            className="ent-input w-full"
          >
            <option value="">ทุกผลลัพธ์</option>
            <option value="SUCCESS">สำเร็จ (SUCCESS)</option>
            <option value="FAILED">ไม่สำเร็จ / ผิดพลาด</option>
          </select>
        </div>

        <ErrorBanner error={error} onRetry={loadData} />

        <div className="ent-table-wrapper">
          {loading ? (
            <TableLoadingSkeleton rows={6} cols={6} />
          ) : (
            <>
              <div className="md:hidden divide-y divide-[#E6DFF0]">
                {pagedLogs.length === 0 ? (
                  <div className="py-10 px-4 text-center text-[14px] text-[#746B83]">
                    ไม่พบประวัติการใช้งานตามตัวกรองที่เลือก
                  </div>
                ) : (
                  pagedLogs.map((log) => (
                    <div key={log.id} className="p-4 space-y-2.5 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold text-[14.5px] text-[#543B7A]">
                            {getAuditActionThaiLabel(log.action)}
                          </div>
                          <div className="text-[12px] font-mono text-[#746B83]">{log.action}</div>
                          <div className="text-[12.5px] font-mono text-[#746B83] mt-0.5 tabular-nums">
                            {formatThaiDateTime(log.created_at)}
                          </div>
                        </div>
                        <span
                          className={`text-[12.5px] font-bold px-2.5 py-0.5 rounded-md border shrink-0 ${
                            log.result === 'SUCCESS'
                              ? 'text-[#198568] bg-[#EDF8F4] border-[#C2E6DA]'
                              : 'text-[#C74455] bg-[#FDF2F3] border-[#F3CCD0]'
                          }`}
                        >
                          {log.result === 'SUCCESS' ? 'สำเร็จ' : log.result}
                        </span>
                      </div>
                      <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E6DFF0] text-[13px] space-y-1 font-mono">
                        <div className="flex items-center justify-between">
                          <span className="text-[#746B83] font-sans">ผู้ดำเนินการ:</span>
                          <span className="font-bold text-[#262238]">
                            {log.actor_username} ({log.actor_role})
                          </span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[#746B83] font-sans">เป้าหมาย:</span>
                          <span className="text-[#262238]">
                            {log.target_type}:{log.target_id || '—'}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedAuditLog(log)}
                        className="ent-btn-secondary w-full"
                      >
                        <PanelRightOpen className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                        <span>ดูข้อมูลรายละเอียด JSON</span>
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-left border-collapse text-[14px]">
                  <thead>
                    <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                      <SortableHeader
                        label="วันและเวลา · รหัสอ้างอิง"
                        sortKey="created_at"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        label="ผู้ดำเนินการ · สิทธิ์"
                        sortKey="actor_username"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <SortableHeader
                        label="กิจกรรม (ภาษาไทย / รหัส)"
                        sortKey="action"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <th className="py-3.5 px-4 text-[13px] font-semibold">ข้อมูลเป้าหมาย</th>
                      <SortableHeader
                        label="ผลลัพธ์"
                        sortKey="result"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <th className="py-3.5 px-4 text-[13px] font-semibold text-right">รายละเอียด</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#E6DFF0]">
                    {pagedLogs.length === 0 ? (
                      <TableEmptyState colSpan={6} title="ไม่พบประวัติการใช้งานตามตัวกรองที่เลือก" />
                    ) : (
                      pagedLogs.map((log) => (
                        <tr key={log.id} className="hover:bg-[#F8F7FC] transition-colors">
                          <td className="py-3.5 px-4 font-mono tabular-nums">
                            <div className="font-semibold text-[#262238]">
                              {formatThaiDateTime(log.created_at)}
                            </div>
                            <div className="text-[12px] text-[#746B83]">
                              ID: {String(log.request_id || '').slice(0, 12)}
                            </div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-bold text-[#262238] font-mono">{log.actor_username}</div>
                            <div className="text-[12px] text-[#746B83]">{log.actor_role}</div>
                          </td>
                          <td className="py-3.5 px-4">
                            <div className="font-semibold text-[#543B7A]">
                              {getAuditActionThaiLabel(log.action)}
                            </div>
                            <div className="font-mono text-[11.5px] text-[#746B83]">{log.action}</div>
                          </td>
                          <td className="py-3.5 px-4 font-mono text-[#746B83] text-[13px]">
                            {log.target_type}:{log.target_id || '—'}
                          </td>
                          <td className="py-3.5 px-4 font-semibold">
                            <span
                              className={
                                log.result === 'SUCCESS' ? 'text-[#198568]' : 'text-[#C74455]'
                              }
                            >
                              {log.result === 'SUCCESS' ? 'สำเร็จ' : log.result}
                            </span>
                          </td>
                          <td className="py-3.5 px-4 text-right">
                            <button
                              type="button"
                              onClick={() => setSelectedAuditLog(log)}
                              className="h-9 px-3 text-[13px] font-semibold text-[#262238] bg-white border border-[#E6DFF0] rounded-lg hover:bg-[#F2EDFA] hover:border-[#8E70C9]/50 hover:text-[#543B7A] inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <PanelRightOpen className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
                              <span>ดูข้อมูล</span>
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <TablePaginationBar
            currentPage={page}
            pageSize={pageSize}
            totalItems={filteredAndSortedLogs.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>

        <SlideOverDrawer
          open={Boolean(selectedAuditLog)}
          onClose={() => setSelectedAuditLog(null)}
          kickerText="รายละเอียดบันทึกการตรวจสอบระบบ"
          title={selectedAuditLog ? getAuditActionThaiLabel(selectedAuditLog.action) : ''}
          subtitle={
            selectedAuditLog ? `รายการ #${selectedAuditLog.id} · ${selectedAuditLog.action}` : ''
          }
        >
          {selectedAuditLog && (
            <div className="space-y-4 text-[14px]">
              <div className="p-4 bg-[#F8F7FC] border border-[#E6DFF0] rounded-xl space-y-2 font-mono text-[13px]">
                <div>รหัสคำขอ (Request ID): {selectedAuditLog.request_id}</div>
                <div>เวลาที่เกิดเหตุการณ์: {formatThaiDateTime(selectedAuditLog.created_at)}</div>
                <div>
                  ผู้ดำเนินการ: {selectedAuditLog.actor_username} ({selectedAuditLog.actor_role})
                </div>
              </div>
              <div>
                <div className="font-bold text-[#262238] mb-2">ข้อมูลรายละเอียด (JSON):</div>
                <pre className="p-4 bg-[#262238] text-[#F8F7FC] rounded-xl font-mono text-[12.5px] overflow-x-auto">
                  {selectedAuditLog.detail_json || '{}'}
                </pre>
              </div>
            </div>
          )}
        </SlideOverDrawer>
      </div>
    );
  }

  // =========================================================================
  // โหมด 'deployment': หน้า "อัปเดตระบบ Sam_Att" แบบปุ่มเดียว
  // =========================================================================
  const latestDeploy = deployStatus?.history?.[0] || null;

  return (
    <div className="space-y-6">
      <PageHeader
        category="ระบบและผู้ดูแล"
        title="อัปเดตระบบ Sam_Att"
        subtitle="อัปเดตระบบ Sam_Att V2 Standalone อัตโนมัติด้วยปุ่มเดียว (สำรองฐานข้อมูล · Build · รีสตาร์ทเฉพาะเซอร์วิส Sam_Att บนพอร์ต 4101 โดยไม่กระทบระบบอื่น)"
        actions={
          <PageHelpAction
            guideKey="deployment"
            userRole={userRole}
            onNavigate={onNavigate}
          />
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* การ์ดหลัก: สถานะปัจจุบันและปุ่มอัปเดตระบบ */}
      <div className="ent-card p-6 sm:p-7 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-[#E6DFF0]">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#543B7A]">
              <Rocket className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
              <span>ระบบอัปเดตอัตโนมัติ (Deploy_Sam_Att.bat)</span>
            </div>
            <h2 className="text-[20px] sm:text-[22px] font-bold text-[#262238]">
              พร้อมอัปเดตระบบ Sam_Att V2 Standalone
            </h2>
            <p className="text-[13.5px] text-[#746B83] max-w-2xl leading-relaxed">
              เมื่อกดปุ่ม <strong className="text-[#262238]">“อัปเดตระบบ”</strong> ระบบจะเรียกใช้สคริปต์มาตรฐาน{' '}
              <code className="font-mono text-[12.5px] bg-[#F8F7FC] text-[#543B7A] px-2 py-0.5 rounded border border-[#E6DFF0]">
                C:\inetpub\wwwroot\Sam_Att\deployment\Deploy_Sam_Att.bat
              </code>{' '}
              เพื่อตรวจสอบความพร้อม สำรองข้อมูล อัปเดตโค้ด และตรวจสอบ Health Check อัตโนมัติ
            </p>
          </div>

          <div className="shrink-0">
            <button
              type="button"
              disabled={deployRunning || Boolean(deployStatus?.inProgress)}
              onClick={() => setConfirmDeployOpen(true)}
              className="ent-btn-primary h-11 px-6 text-[14.5px] w-full sm:w-auto"
            >
              <Rocket className="w-4.5 h-4.5" aria-hidden="true" />
              <span>{deployRunning ? 'กำลังอัปเดตระบบ...' : 'อัปเดตระบบ'}</span>
            </button>
          </div>
        </div>

        {/* 4 Status Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] space-y-1">
            <div className="text-[12.5px] font-medium text-[#746B83]">เวอร์ชันปัจจุบัน</div>
            <div className="text-[18px] font-bold font-mono text-[#262238]">
              {deployStatus?.currentVersion || '2.0.0-standalone'}
            </div>
            <div className="text-[12px] text-[#746B83]">
              พอร์ต HTTPS {deployStatus?.httpsPort || 4101}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] space-y-1">
            <div className="text-[12.5px] font-medium text-[#746B83]">สถานะระบบ</div>
            <div className="flex items-center gap-1.5 pt-0.5 text-[15px] font-bold text-[#198568]">
              <ShieldCheck className="w-4.5 h-4.5 shrink-0" aria-hidden="true" />
              <span>{deployStatus?.inProgress ? 'กำลังอัปเดต...' : 'ทำงานปกติ'}</span>
            </div>
            <div className="text-[12px] text-[#746B83]">แยกอิสระจาก Procurement</div>
          </div>

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] space-y-1">
            <div className="text-[12.5px] font-medium text-[#746B83]">สถานะการอัปเดตล่าสุด</div>
            <div className="pt-0.5">
              {latestDeploy ? (
                <span
                  className={`inline-flex items-center gap-1.5 text-[14.5px] font-bold ${
                    latestDeploy.status === 'SUCCESS' ? 'text-[#198568]' : 'text-[#C74455]'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" />
                  <span>{latestDeploy.status === 'SUCCESS' ? 'สำเร็จ (SUCCESS)' : latestDeploy.status}</span>
                </span>
              ) : (
                <span className="text-[14.5px] font-semibold text-[#198568]">พร้อมใช้งาน</span>
              )}
            </div>
            <div className="text-[12px] text-[#746B83]">
              โดย: {latestDeploy?.executed_by || 'ระบบเริ่มต้น'}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] space-y-1">
            <div className="text-[12.5px] font-medium text-[#746B83]">วันที่อัปเดตล่าสุด</div>
            <div className="text-[15px] font-bold font-mono text-[#262238] flex items-center gap-1.5 pt-0.5 tabular-nums">
              <Clock className="w-4 h-4 text-[#8E70C9] shrink-0" aria-hidden="true" />
              <span>
                {latestDeploy?.executed_at
                  ? formatThaiDateTime(latestDeploy.executed_at)
                  : 'ติดตั้งรุ่นเริ่มต้น'}
              </span>
            </div>
            <div className="text-[12px] text-[#746B83]">สำรองข้อมูลก่อนอัปเดตทุกครั้ง</div>
          </div>
        </div>

        {/* ผลการอัปเดตล่าสุด (Console Output) */}
        {(lastDeployOutput || latestDeploy?.rollback_note) && (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 text-[14px] font-bold text-[#262238]">
              <Terminal className="w-4 h-4 text-[#8E70C9]" aria-hidden="true" />
              <span>ผลการอัปเดตล่าสุด</span>
            </div>
            <pre className="p-4 rounded-xl bg-[#262238] text-[#F8F7FC] font-mono text-[12.5px] overflow-x-auto leading-relaxed max-h-72">
              {lastDeployOutput || latestDeploy?.rollback_note}
            </pre>
          </div>
        )}
      </div>

      {/* ประวัติการอัปเดตย้อนหลัง */}
      <div className="ent-table-wrapper">
        <div className="px-5 py-4 border-b border-[#E6DFF0] bg-[#F8F7FC]">
          <h3 className="text-[16.5px] font-bold text-[#262238]">
            ประวัติการอัปเดตระบบ ({deployStatus?.history?.length || 0} รายการล่าสุด)
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[#E6DFF0] bg-[#F8F7FC] text-[#543B7A]">
                <th className="py-3 px-5 font-semibold text-[13px]">ครั้งที่ · เวอร์ชัน</th>
                <th className="py-3 px-5 font-semibold text-[13px]">วันที่และเวลา</th>
                <th className="py-3 px-5 font-semibold text-[13px]">ผู้สั่งอัปเดต</th>
                <th className="py-3 px-5 font-semibold text-[13px]">สถานะ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E6DFF0]">
              {!deployStatus?.history || deployStatus.history.length === 0 ? (
                <TableEmptyState
                  colSpan={4}
                  title="ยังไม่มีประวัติการอัปเดตระบบ"
                  description="เมื่อกดปุ่มอัปเดตระบบ ประวัติและผลการอัปเดตจะแสดงที่นี่"
                />
              ) : (
                deployStatus.history.map((h: any) => (
                  <tr key={h.id} className="hover:bg-[#F8F7FC]">
                    <td className="py-3.5 px-5 font-mono font-bold text-[#262238]">
                      #{h.id} · {h.release_version}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-[#746B83] tabular-nums">
                      {h.executed_at ? formatThaiDateTime(h.executed_at) : '—'}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-[#262238]">{h.executed_by}</td>
                    <td className="py-3.5 px-5">
                      <span
                        className={`font-semibold text-[12.5px] px-2.5 py-1 rounded-md border ${
                          h.status === 'SUCCESS'
                            ? 'text-[#198568] bg-[#EDF8F4] border-[#C2E6DA]'
                            : 'text-[#C74455] bg-[#FDF2F3] border-[#F3CCD0]'
                        }`}
                      >
                        {h.status === 'SUCCESS' ? 'สำเร็จ' : h.status}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ConfirmDialog ก่อนอัปเดตระบบ */}
      <ConfirmDialog
        open={confirmDeployOpen}
        title="ยืนยันการอัปเดตระบบ Sam_Att"
        description="ระบบจะรันสคริปต์ Deploy_Sam_Att.bat เพื่อดึงโค้ดล่าสุด สำรองฐานข้อมูล และอัปเดตระบบอัตโนมัติ"
        confirmLabel="ยืนยันอัปเดตระบบทันที"
        loading={deployRunning}
        onConfirm={handleExecuteOneButtonUpdate}
        onCancel={() => setConfirmDeployOpen(false)}
      >
        <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E6DFF0] space-y-2 text-[13.5px] text-[#262238]">
          <div className="font-bold text-[#543B7A]">ขั้นตอนที่ระบบจะดำเนินการโดยอัตโนมัติ:</div>
          <ul className="list-disc pl-5 space-y-1 text-[#746B83]">
            <li>ตรวจสอบความพร้อมของระบบ (Preflight Check) และสำรองฐานข้อมูล</li>
            <li>อัปเดตซอร์สโค้ดและ Build ระบบ Frontend / Backend ใหม่</li>
            <li>รีสตาร์ทเฉพาะเซอร์วิส Sam_Att บนพอร์ต 4101 โดยไม่กระทบระบบ Procurement</li>
          </ul>
        </div>
      </ConfirmDialog>

      {/* ProgressDialog แสดงความคืบหน้าขณะอัปเดต */}
      <ProgressDialog
        open={deployProgressOpen}
        title="กำลังอัปเดตระบบ Sam_Att V2 Standalone"
        stepLabel={deployStepLabel}
        percent={deployPercent}
        status={deployResultState}
        summaryText={deploySummaryText}
        errorMessage={deployErrorText}
        onClose={() => setDeployProgressOpen(false)}
        details={
          lastDeployOutput ? (
            <pre className="p-3 rounded-lg bg-[#262238] text-[#F8F7FC] font-mono text-[11.5px] overflow-x-auto max-h-48">
              {lastDeployOutput}
            </pre>
          ) : undefined
        }
      />
    </div>
  );
}
