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
  Search,
  PanelRightOpen,
  Loader2,
  RotateCcw,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner, RoleLabel } from '../components/StatusText.tsx';
import {
  PageHeader,
  MetricStrip,
  FilterBar,
  StatusBadge,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SlideOverDrawer,
  SharedModal,
  TableEmptyState,
  TableLoadingSkeleton,
  RequiredMark,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { useToast } from '../components/common/ToastContext.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import type { NavViewKey } from '../components/layout/Sidebar.tsx';
import { formatThaiDateTime } from '../utils/thaiFormat.ts';
import { GitHubUpdateCenter } from '../components/deployment/GitHubUpdateCenter.tsx';

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
  onUpdateBadgeChange,
}: {
  mode: 'users' | 'auditLogs' | 'deployment';
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
  onUpdateBadgeChange?: (hasUpdate: boolean) => void;
}) {
  const toast = useToast();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState('');
  const [userSortKey, setUserSortKey] = useState('id');
  const [userSortDir, setUserSortDir] = useState<'ASC' | 'DESC'>('ASC');
  const [userPage, setUserPage] = useState(1);
  const [userPageSize, setUserPageSize] = useState<PageSizeOption>(10);
  const [createUserModalOpen, setCreateUserModalOpen] = useState(false);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createUserError, setCreateUserError] = useState<string | null>(null);
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

  // Sorting & Pagination for Audit Logs
  const [sortKey, setSortKey] = useState('created_at');
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSizeOption>(10);

  const loadData = useCallback(async () => {
    if (mode === 'deployment') {
      setLoading(false);
      return;
    }
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

  function handleUserSort(key: string) {
    if (userSortKey === key) {
      setUserSortDir((prev) => (prev === 'ASC' ? 'DESC' : 'ASC'));
    } else {
      setUserSortKey(key);
      setUserSortDir('ASC');
    }
    setUserPage(1);
  }

  async function handleCreateUser(e: React.FormEvent) {
    e.preventDefault();
    setCreateUserError(null);
    setCreatingUser(true);
    try {
      await apiRequest('/users', {
        method: 'POST',
        body: JSON.stringify({
          username: newUsername.trim(),
          password: newPassword,
          displayName: newDisplayName.trim(),
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
      toast.success('สร้างบัญชีผู้ใช้งานเรียบร้อยแล้ว', 'ผูกสิทธิ์การเข้าถึงและข้อมูลบุคลากรแล้ว');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setCreateUserError(err.message);
        toast.error('ไม่สามารถสร้างบัญชีผู้ใช้งานได้', err.message, err.requestId);
      } else {
        setCreateUserError('ไม่สามารถเชื่อมต่อระบบเพื่อสร้างบัญชีผู้ใช้งานได้');
      }
    } finally {
      setCreatingUser(false);
    }
  }

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    const list = users.filter((u) => {
      if (userRoleFilter && u.role !== userRoleFilter) return false;
      if (!q) return true;
      return (
        String(u.username || '').toLowerCase().includes(q) ||
        String(u.display_name || '').toLowerCase().includes(q) ||
        String(u.full_name || '').toLowerCase().includes(q) ||
        String(u.approved_person_id || '').toLowerCase().includes(q)
      );
    });
    return [...list].sort((a, b) => {
      if (userSortKey === 'id' || userSortKey === 'is_active') {
        const diff = Number(a[userSortKey] ?? 0) - Number(b[userSortKey] ?? 0);
        return userSortDir === 'ASC' ? diff : -diff;
      }
      const valA = String(a[userSortKey] || '');
      const valB = String(b[userSortKey] || '');
      return userSortDir === 'ASC'
        ? valA.localeCompare(valB, 'th')
        : valB.localeCompare(valA, 'th');
    });
  }, [users, userSearch, userRoleFilter, userSortKey, userSortDir]);

  const userStats = useMemo(() => {
    const adminHr = users.filter((u) => u.role === 'ADMIN' || u.role === 'RESPONSIBLE_STAFF').length;
    const general = users.filter((u) => u.role === 'GENERAL_USER').length;
    const unlinked = users.filter((u) => !u.approved_person_id).length;
    return { total: users.length, adminHr, general, unlinked };
  }, [users]);

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

  const auditStats = useMemo(() => {
    const ok = filteredAndSortedLogs.filter((l) => l.result === 'SUCCESS').length;
    const fail = filteredAndSortedLogs.length - ok;
    return {
      total: filteredAndSortedLogs.length,
      ok,
      fail,
      actors: availableAuditActors.length,
    };
  }, [filteredAndSortedLogs, availableAuditActors.length]);

  // =========================================================================
  // โหมด 'users': ผู้ใช้งานและสิทธิ์
  // =========================================================================
  if (mode === 'users') {
    const numericUserSize =
      userPageSize === 'ALL' ? Math.max(1, filteredUsers.length) : userPageSize;
    const pagedUsers = filteredUsers.slice(
      (userPage - 1) * numericUserSize,
      userPage * numericUserSize
    );
    const hasUserFilter = Boolean(userSearch || userRoleFilter);

    return (
      <div className="space-y-6">
        <PageHeader
          category="ระบบและผู้ดูแล"
          title="ผู้ใช้งานและสิทธิ์การเข้าถึง"
          subtitle="จัดการบัญชีผู้ใช้ทั้ง 3 ระดับและเชื่อมโยงบัญชีเข้ากับรหัสบุคลากรของโรงพยาบาล"
          actions={
            <>
              <PageHelpAction
                guideKey="adminUsers"
                userRole={userRole}
                onNavigate={onNavigate}
              />
              <button
                type="button"
                onClick={() => {
                  setCreateUserError(null);
                  setCreateUserModalOpen(true);
                }}
                className="ent-btn-primary"
              >
                <Plus className="w-4 h-4" aria-hidden="true" />
                <span>เพิ่มบัญชีผู้ใช้งาน</span>
              </button>
            </>
          }
        />

        <ErrorBanner error={error} onRetry={loadData} />

        <MetricStrip
          items={[
            {
              label: 'บัญชีผู้ใช้ทั้งหมด',
              value: `${userStats.total} บัญชี`,
              subtext: 'รองรับสิทธิ์ RBAC 3 ระดับ',
              tone: 'primary',
            },
            {
              label: 'ผู้ดูแลระบบ / งานบุคคล',
              value: `${userStats.adminHr} บัญชี`,
              subtext: 'ADMIN และ RESPONSIBLE_STAFF',
              tone: 'info',
            },
            {
              label: 'บุคลากรทั่วไป (Own-Only)',
              value: `${userStats.general} บัญชี`,
              subtext: 'ดูเฉพาะเวลาปฏิบัติงานของตนเอง',
              tone: 'success',
            },
            {
              label: 'ยังไม่ผูกชื่อบุคลากร',
              value: `${userStats.unlinked} บัญชี`,
              subtext: userStats.unlinked > 0 ? 'ควรผูก approvedPersonId ให้ครบ' : 'เชื่อมโยงครบทุกบัญชี',
              tone: userStats.unlinked > 0 ? 'warning' : 'success',
            },
          ]}
        />

        {/* Filter Bar */}
        <FilterBar>
          <div className="relative flex-1 min-w-[240px]">
            <Search
              className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            />
            <input
              type="text"
              aria-label="ค้นหาบัญชีผู้ใช้"
              value={userSearch}
              onChange={(e) => {
                setUserSearch(e.target.value);
                setUserPage(1);
              }}
              placeholder="ค้นหา Username, ชื่อ-นามสกุล, รหัสบุคลากร..."
              className="ent-input pl-10 pr-4 w-full"
            />
          </div>
          <select
            aria-label="กรองตามระดับสิทธิ์"
            value={userRoleFilter}
            onChange={(e) => {
              setUserRoleFilter(e.target.value);
              setUserPage(1);
            }}
            className="ent-input w-full sm:w-64"
          >
            <option value="">ทุกระดับสิทธิ์ (3 ระดับ)</option>
            <option value="ADMIN">ผู้ดูแลระบบ (ADMIN)</option>
            <option value="RESPONSIBLE_STAFF">เจ้าหน้าที่งานบุคคล (HR)</option>
            <option value="GENERAL_USER">บุคลากรทั่วไป (User)</option>
          </select>
          {hasUserFilter && (
            <button
              type="button"
              onClick={() => {
                setUserSearch('');
                setUserRoleFilter('');
                setUserPage(1);
              }}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              <span>ล้างตัวกรอง</span>
            </button>
          )}
        </FilterBar>

        <div className="his-surface overflow-hidden">
          <div className="px-4 sm:px-5 py-3.5 border-b border-[#E8E4EF] bg-[#F8F7FC]">
            <h2 className="text-[15.5px] font-bold text-[#292638]">
              รายชื่อบัญชีผู้ใช้งานทั้งหมด ({filteredUsers.length} บัญชี)
            </h2>
          </div>

          {loading ? (
            <TableLoadingSkeleton rows={5} cols={6} />
          ) : (
            <>
              <div className="md:hidden divide-y divide-[#E8E4EF]">
                {pagedUsers.length === 0 ? (
                  <div className="p-8 text-center text-[14px] text-[#777287]">
                    ไม่พบบัญชีผู้ใช้งานตามเงื่อนไขที่ค้นหา
                  </div>
                ) : (
                  pagedUsers.map((u) => (
                    <div key={u.id} className="p-4 space-y-2.5 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold text-[15px] text-[#292638]">{u.display_name}</div>
                          <div className="font-mono text-[13px] font-semibold text-[#777287] tabular-nums">
                            #{u.id} · {u.username}
                          </div>
                        </div>
                        <RoleLabel role={u.role} />
                      </div>
                      <div className="pt-2 border-t border-[#F1ECFA] text-[13px] space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#777287]">บุคลากรที่เชื่อมโยง</span>
                          {u.approved_person_id ? (
                            <span className="font-semibold text-[#292638]">
                              {u.full_name} ({u.approved_person_id})
                            </span>
                          ) : (
                            <span className="text-[#C74455] font-medium">ยังไม่ผูกชื่อบุคลากร</span>
                          )}
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#777287]">สถานะบัญชี</span>
                          <StatusBadge tone={Number(u.is_active) === 1 ? 'success' : 'danger'}>
                            {Number(u.is_active) === 1 ? 'ใช้งานปกติ' : 'ระงับการใช้งาน'}
                          </StatusBadge>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="his-table">
                  <thead>
                    <tr>
                      <SortableHeader
                        label="ชื่อบัญชีผู้ใช้งาน"
                        sortKey="username"
                        activeSortKey={userSortKey}
                        sortDir={userSortDir}
                        onSort={handleUserSort}
                      />
                      <SortableHeader
                        label="ชื่อ-นามสกุล"
                        sortKey="display_name"
                        activeSortKey={userSortKey}
                        sortDir={userSortDir}
                        onSort={handleUserSort}
                      />
                      <SortableHeader
                        label="ระดับสิทธิ์"
                        sortKey="role"
                        activeSortKey={userSortKey}
                        sortDir={userSortDir}
                        onSort={handleUserSort}
                      />
                      <th>บุคลากรที่เชื่อมโยง</th>
                      <SortableHeader
                        label="สถานะบัญชี"
                        sortKey="is_active"
                        activeSortKey={userSortKey}
                        sortDir={userSortDir}
                        onSort={handleUserSort}
                      />
                      <SortableHeader
                        label="เข้าใช้งานล่าสุด"
                        sortKey="last_login_at"
                        activeSortKey={userSortKey}
                        sortDir={userSortDir}
                        onSort={handleUserSort}
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {pagedUsers.length === 0 ? (
                      <TableEmptyState colSpan={6} title="ไม่พบบัญชีผู้ใช้งานตามเงื่อนไขที่ค้นหา" />
                    ) : (
                      pagedUsers.map((u) => (
                        <tr key={u.id}>
                          <td className="font-mono font-bold text-[#292638] tabular-nums">
                            #{u.id} · {u.username}
                          </td>
                          <td className="font-semibold text-[#292638]">{u.display_name}</td>
                          <td>
                            <RoleLabel role={u.role} />
                          </td>
                          <td>
                            {u.approved_person_id ? (
                              <div>
                                <span className="font-semibold text-[#292638]">{u.full_name}</span>{' '}
                                <span className="font-mono text-[12.5px] text-[#4E3978]">
                                  ({u.approved_person_id})
                                </span>
                              </div>
                            ) : (
                              <span className="text-[#C74455] font-medium">ยังไม่ผูกชื่อบุคลากร</span>
                            )}
                          </td>
                          <td>
                            <StatusBadge tone={Number(u.is_active) === 1 ? 'success' : 'danger'}>
                              {Number(u.is_active) === 1 ? 'ใช้งานปกติ' : 'ระงับการใช้งาน'}
                            </StatusBadge>
                          </td>
                          <td className="font-mono tabular-nums text-[#777287]">
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

          <TablePaginationBar
            currentPage={userPage}
            pageSize={userPageSize}
            totalItems={filteredUsers.length}
            onPageChange={setUserPage}
            onPageSizeChange={setUserPageSize}
          />
        </div>

        {/* Create User Modal split into Account Information & Authorization */}
        <SharedModal
          open={createUserModalOpen}
          onClose={() => {
            if (!creatingUser) {
              setCreateUserError(null);
              setCreateUserModalOpen(false);
            }
          }}
          kickerText="ระบบผู้ใช้งานและสิทธิ์การเข้าถึง"
          title="เพิ่มบัญชีผู้ใช้งานใหม่"
          subtitle="สำหรับบุคลากรทั่วไป ระบบจะใช้รหัสบุคลากรที่ผูกไว้นี้เพื่อจำกัดให้ดูได้เฉพาะข้อมูลเวลาของตนเองเท่านั้น"
          maxWidthClass="max-w-2xl"
        >
          <form onSubmit={handleCreateUser} className="space-y-6">
            {createUserError && (
              <div
                role="alert"
                className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13.5px] font-medium"
              >
                {createUserError}
              </div>
            )}
            {/* Section 1: Account Information */}
            <div className="space-y-4">
              <div className="text-[13.5px] font-bold text-[#4E3978] border-b border-[#E8E4EF] pb-1.5">
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
              <div className="text-[13.5px] font-bold text-[#4E3978] border-b border-[#E8E4EF] pb-1.5">
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

            <div className="flex flex-col sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
              <button
                type="button"
                disabled={creatingUser}
                onClick={() => {
                  setCreateUserError(null);
                  setCreateUserModalOpen(false);
                }}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={creatingUser}
                className="ent-btn-primary w-full sm:w-auto"
              >
                {creatingUser ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Plus className="w-4 h-4" aria-hidden="true" />
                )}
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
    const hasAuditFilter = Boolean(
      logSearch || logDateFilter || logActorFilter || logActionFilter || logResultFilter
    );

    return (
      <div className="space-y-6">
        <PageHeader
          category="ระบบและผู้ดูแล"
          title="ประวัติการใช้งานระบบ (Audit Logs)"
          subtitle="บันทึกกิจกรรมการเข้าสู่ระบบ การตรวจสอบเวลา การซิงก์ข้อมูล และการอัปเดตระบบแบบอ่านอย่างเดียว"
          actions={
            <PageHelpAction
              guideKey="systemLogs"
              userRole={userRole}
              onNavigate={onNavigate}
            />
          }
        />

        <MetricStrip
          items={[
            {
              label: 'รายการบันทึกที่แสดง',
              value: `${auditStats.total.toLocaleString('th-TH')} รายการ`,
              subtext: 'จัดเก็บแบบ Read-Only Audit Trail',
              tone: 'primary',
            },
            {
              label: 'ดำเนินการสำเร็จ',
              value: `${auditStats.ok.toLocaleString('th-TH')} รายการ`,
              subtext: 'ผลลัพธ์ SUCCESS',
              tone: 'success',
            },
            {
              label: 'ไม่สำเร็จ / ผิดพลาด',
              value: `${auditStats.fail.toLocaleString('th-TH')} รายการ`,
              subtext: auditStats.fail > 0 ? 'ควรตรวจสอบรายละเอียด JSON' : 'ไม่พบเหตุการณ์ผิดพลาด',
              tone: auditStats.fail > 0 ? 'danger' : 'success',
            },
            {
              label: 'บัญชีผู้ดำเนินการ',
              value: `${auditStats.actors.toLocaleString('th-TH')} บัญชี`,
              subtext: 'ที่ปรากฏในประวัติการใช้งาน',
            },
          ]}
        />

        {/* Comprehensive Audit Filter Bar */}
        <div className="his-surface p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
            <div className="relative">
              <Search
                className="w-4 h-4 text-[#777287] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none"
                aria-hidden="true"
              />
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
          {hasAuditFilter && (
            <div className="flex justify-end pt-2 border-t border-[#F1ECFA]">
              <button
                type="button"
                onClick={() => {
                  setLogSearch('');
                  setLogDateFilter('');
                  setLogActorFilter('');
                  setLogActionFilter('');
                  setLogResultFilter('');
                  setPage(1);
                }}
                className="ent-btn-secondary h-8 px-3 text-[12.5px]"
              >
                <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ล้างตัวกรองทั้งหมด</span>
              </button>
            </div>
          )}
        </div>

        <ErrorBanner error={error} onRetry={loadData} />

        <div className="his-surface overflow-hidden">
          {loading ? (
            <TableLoadingSkeleton rows={6} cols={6} />
          ) : (
            <>
              <div className="md:hidden divide-y divide-[#E8E4EF]">
                {pagedLogs.length === 0 ? (
                  <div className="py-10 px-4 text-center text-[14px] text-[#777287]">
                    ไม่พบประวัติการใช้งานตามตัวกรองที่เลือก
                  </div>
                ) : (
                  pagedLogs.map((log) => (
                    <div key={log.id} className="p-4 space-y-2.5 bg-white">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-bold text-[14.5px] text-[#4E3978]">
                            {getAuditActionThaiLabel(log.action)}
                          </div>
                          <div className="text-[12px] font-mono text-[#777287]">{log.action}</div>
                          <div className="text-[12.5px] font-mono text-[#777287] mt-0.5 tabular-nums">
                            {formatThaiDateTime(log.created_at)}
                          </div>
                        </div>
                        <StatusBadge tone={log.result === 'SUCCESS' ? 'success' : 'danger'}>
                          {log.result === 'SUCCESS' ? 'สำเร็จ' : log.result}
                        </StatusBadge>
                      </div>
                      <div className="pt-2 border-t border-[#F1ECFA] text-[13px] space-y-1 font-mono">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#777287] font-sans">ผู้ดำเนินการ</span>
                          <span className="font-bold text-[#292638]">
                            {log.actor_username} ({log.actor_role})
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#777287] font-sans">เป้าหมาย</span>
                          <span className="text-[#292638]">
                            {log.target_type}:{log.target_id || '—'}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedAuditLog(log)}
                        className="ent-btn-secondary w-full"
                      >
                        <PanelRightOpen className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                        <span>ดูข้อมูลรายละเอียด JSON</span>
                      </button>
                    </div>
                  ))
                )}
              </div>

              <div className="hidden md:block overflow-x-auto">
                <table className="his-table">
                  <thead>
                    <tr>
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
                      <th>ข้อมูลเป้าหมาย</th>
                      <SortableHeader
                        label="ผลลัพธ์"
                        sortKey="result"
                        activeSortKey={sortKey}
                        sortDir={sortDir}
                        onSort={handleSort}
                      />
                      <th className="text-right">รายละเอียด</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedLogs.length === 0 ? (
                      <TableEmptyState colSpan={6} title="ไม่พบประวัติการใช้งานตามตัวกรองที่เลือก" />
                    ) : (
                      pagedLogs.map((log) => (
                        <tr key={log.id}>
                          <td className="font-mono tabular-nums">
                            <div className="font-semibold text-[#292638]">
                              {formatThaiDateTime(log.created_at)}
                            </div>
                            <div className="text-[12px] text-[#777287]">
                              ID: {String(log.request_id || '').slice(0, 12)}
                            </div>
                          </td>
                          <td>
                            <div className="font-bold text-[#292638] font-mono">{log.actor_username}</div>
                            <div className="text-[12px] text-[#777287]">{log.actor_role}</div>
                          </td>
                          <td>
                            <div className="font-semibold text-[#4E3978]">
                              {getAuditActionThaiLabel(log.action)}
                            </div>
                            <div className="font-mono text-[11.5px] text-[#777287]">{log.action}</div>
                          </td>
                          <td className="font-mono text-[#777287] text-[13px]">
                            {log.target_type}:{log.target_id || '—'}
                          </td>
                          <td>
                            <StatusBadge tone={log.result === 'SUCCESS' ? 'success' : 'danger'}>
                              {log.result === 'SUCCESS' ? 'สำเร็จ' : log.result}
                            </StatusBadge>
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => setSelectedAuditLog(log)}
                              className="ent-btn-secondary h-8 px-3 text-[12.5px] whitespace-nowrap"
                            >
                              <PanelRightOpen className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
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
              <div className="p-4 bg-[#F8F7FC] border border-[#E8E4EF] rounded-xl space-y-2 font-mono text-[13px]">
                <div>รหัสคำขอ (Request ID): {selectedAuditLog.request_id}</div>
                <div>เวลาที่เกิดเหตุการณ์: {formatThaiDateTime(selectedAuditLog.created_at)}</div>
                <div>
                  ผู้ดำเนินการ: {selectedAuditLog.actor_username} ({selectedAuditLog.actor_role})
                </div>
              </div>
              <div>
                <div className="font-bold text-[#292638] mb-2">ข้อมูลรายละเอียด (JSON)</div>
                <pre className="p-4 bg-[#292638] text-[#F8F7FC] rounded-xl font-mono text-[12.5px] overflow-x-auto">
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
  // โหมด 'deployment': ศูนย์อัปเดตระบบจาก GitHub (GitHub Update Center)
  // =========================================================================
  return (
    <GitHubUpdateCenter
      userRole={userRole}
      onNavigate={onNavigate}
      onUpdateBadgeChange={onUpdateBadgeChange}
    />
  );
}
