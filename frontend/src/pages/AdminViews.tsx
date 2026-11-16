/**
 * ============================================================================
 * ไฟล์: frontend/src/pages/AdminViews.tsx
 * หน้าที่: หน้าจอจัดการระบบสำหรับผู้ดูแลระบบ (ADMIN) และผู้รับผิดชอบ (RESPONSIBLE_STAFF)
 * ============================================================================
 * ประกอบด้วย 3 คอมโพเนนต์หลัก:
 * 1. ScannersView:
 *    - จัดการทะเบียนเครื่องสแกนลายนิ้วมือ (Scanner Devices) และการตั้งเวลาซิงก์อัตโนมัติ (00:00 / 08:00 น.)
 *    - ปุ่มสั่งดึงข้อมูลจากเครื่องสแกนทันที (Trigger Scanner Sync)
 * 2. UsersView (เฉพาะ ADMIN):
 *    - จัดการบัญชีผู้ใช้งานระบบ (App Users) กำหนดระดับสิทธิ์ 3 ระดับ (ADMIN, RESPONSIBLE_STAFF, GENERAL_USER)
 *    - ผูกบัญชีผู้ใช้งานเข้ากับรหัสบุคลากร (PERSON_ID) เพื่อใช้บังคับสิทธิ์ Own-Only
 * 3. AuditView:
 *    - ตรวจสอบประวัติการใช้งานระบบและแก้ไขข้อมูล (Immutable Audit Trail)
 *    - ตรวจสอบสถานะความพร้อมของฐานข้อมูล (System Health Check)
 * ============================================================================
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  Shield,
  Activity,
  CheckCircle2,
  RotateCcw,
  Search,
  PanelRightOpen,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner, RoleLabel } from '../components/StatusText.tsx';
import {
  PageHeader,
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SlideOverDrawer,
  TableEmptyState,
  RequiredMark,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { formatThaiDateTime } from '../utils/thaiFormat.ts';

export function AdminViews({
  mode,
}: {
  mode: 'users' | 'auditLogs' | 'settings' | 'deployment';
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Users state
  const [users, setUsers] = useState<any[]>([]);
  const [personnel, setPersonnel] = useState<any[]>([]);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('GENERAL_USER');
  const [newPersonId, setNewPersonId] = useState('SAM-P005');

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [selectedAuditLog, setSelectedAuditLog] = useState<any | null>(null);

  // Settings state
  const [connections, setConnections] = useState<any>(null);
  const [health, setHealth] = useState<any>(null);

  // Deployment state
  const [deployStatus, setDeployStatus] = useState<any>(null);
  const [preflightData, setPreflightData] = useState<any>(null);
  const [adminPassword, setAdminPassword] = useState('');
  const [commitSha, setCommitSha] = useState('38a7f4195f613a458aae3961fc22a74522630c57');
  const [artifactSha256, setArtifactSha256] = useState(
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );

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
      } else if (mode === 'settings') {
        const [cRes, hRes] = await Promise.all([
          apiRequest('/settings/connections'),
          apiRequest('/settings/connections/health'),
        ]);
        setConnections(cRes);
        setHealth(hRes);
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
      setNotice('สร้างบัญชีผู้ใช้งานใหม่และผูกชื่อบุคลากรเรียบร้อยแล้ว');
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleTestConnection(target: 'sam_att_db' | 'hosoffice_db' | 'scanner_exe') {
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest('/settings/connections/test', {
        method: 'POST',
        body: JSON.stringify({ target }),
      });
      setNotice(`[${target}] ${res.message}`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleRunPreflight() {
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest('/deployment/preflight', { method: 'POST' });
      setPreflightData(res);
      setNotice('ตรวจสอบความพร้อมของระบบก่อนอัปเดต (Preflight Check) เรียบร้อยแล้ว');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleApproveDeployment(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest('/deployment/approve', {
        method: 'POST',
        body: JSON.stringify({
          adminPassword,
          releaseVersion: '2.0.1-standalone',
          commitSha,
          artifactSha256,
        }),
      });
      setAdminPassword('');
      setNotice(
        `อนุมัติแพ็กเกจอัปเดตสำเร็จ (รหัสการติดตั้ง #${res.deploymentId}) พร้อมเตรียมไฟล์สำรองข้อมูลที่ ${res.backupArchivePath}`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  async function handleRollback(backupId: number) {
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest('/deployment/rollback', {
        method: 'POST',
        body: JSON.stringify({
          targetBackupId: backupId,
          reason: 'สั่งย้อนกลับเวอร์ชันผ่านศูนย์ควบคุมของผู้ดูแลระบบ',
        }),
      });
      setNotice(
        `บันทึกคำสั่งย้อนกลับไปยังเวอร์ชัน ${res.targetVersion} เรียบร้อยแล้ว (รันสคริปต์ scripts/restore-test.ps1 บนเซิร์ฟเวอร์เพื่อสลับไฟล์จริง)`
      );
      await loadData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      }
    }
  }

  if (mode === 'users') {
    return (
      <div className="space-y-6">
        <PageHeader
          category="ตั้งค่าระบบและส่วนกลาง"
          title="จัดการบัญชีผู้ใช้งานและสิทธิ์การเข้าถึง"
          subtitle="กำหนดสิทธิ์การใช้งาน 3 ระดับ (ผู้ดูแลระบบ, เจ้าหน้าที่งานบุคคล, บุคลากรทั่วไป) และเชื่อมโยงบัญชีเข้ากับรหัสบุคลากรของโรงพยาบาล"
        />

        <ErrorBanner error={error} onRetry={loadData} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        <form onSubmit={handleCreateUser} className="ent-card p-6 space-y-5">
          <div className="border-b border-[#E7E2E5] pb-3">
            <h2 className="text-[18px] font-bold text-[#273244]">เพิ่มบัญชีผู้ใช้งานใหม่</h2>
            <p className="text-[13.5px] text-[#596579]">
              สำหรับบุคลากรทั่วไป ระบบจะใช้รหัสบุคลากรที่ผูกไว้นี้เพื่อจำกัดให้ดูได้เฉพาะข้อมูลเวลาของตนเองเท่านั้น
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
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
                รหัสผ่าน (อย่างน้อย 8 ตัว) <RequiredMark />
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
            <div>
              <label className="ent-label">
                ชื่อ-นามสกุลที่แสดง <RequiredMark />
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
          <button type="submit" className="ent-btn-primary w-full sm:w-auto">
            <Plus className="w-4 h-4" />
            <span>สร้างบัญชีผู้ใช้งาน</span>
          </button>
        </form>

        <div className="ent-table-wrapper">
          <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7]">
            <h2 className="text-[18px] font-bold text-[#273244]">
              รายชื่อบัญชีผู้ใช้งานทั้งหมด ({users.length} บัญชี)
            </h2>
          </div>

          {/* Mobile Card List View (< 768px) */}
          <div className="md:hidden divide-y divide-[#E7E2E5]">
            {users.map((u) => (
              <div key={u.id} className="p-4 space-y-2 bg-white">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-[15.5px] text-[#273244]">{u.display_name}</div>
                    <div className="font-mono text-[13px] font-semibold text-[#596579]">
                      #{u.id} · {u.username}
                    </div>
                  </div>
                  <RoleLabel role={u.role} />
                </div>
                <div className="p-3 rounded-lg bg-[#FFF9F9] border border-[#E7E2E5] text-[13.5px] space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#596579]">บุคลากรที่เชื่อมโยง:</span>
                    {u.approved_person_id ? (
                      <span className="font-semibold text-[#273244]">
                        {u.full_name} ({u.approved_person_id})
                      </span>
                    ) : (
                      <span className="text-[#B91C1C] font-medium">ยังไม่ผูกชื่อบุคลากร</span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[#596579]">สถานะบัญชี:</span>
                    {Number(u.is_active) === 1 ? (
                      <span className="text-[#047857] font-semibold">ใช้งานปกติ</span>
                    ) : (
                      <span className="text-[#B91C1C] font-semibold">ระงับการใช้งาน</span>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop Table View (>= 768px) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">ชื่อบัญชีผู้ใช้งาน</th>
                  <th className="py-3.5 px-5 font-semibold">ชื่อ-นามสกุล</th>
                  <th className="py-3.5 px-5 font-semibold">ระดับสิทธิ์</th>
                  <th className="py-3.5 px-5 font-semibold">บุคลากรที่เชื่อมโยง</th>
                  <th className="py-3.5 px-5 font-semibold">สถานะบัญชี</th>
                  <th className="py-3.5 px-5 font-semibold">เข้าใช้งานล่าสุด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-[#FFF9F9]">
                    <td className="py-4 px-5 font-mono font-bold text-[#273244]">
                      #{u.id} · {u.username}
                    </td>
                    <td className="py-4 px-5 font-bold text-[#273244]">{u.display_name}</td>
                    <td className="py-4 px-5">
                      <RoleLabel role={u.role} />
                    </td>
                    <td className="py-4 px-5">
                      {u.approved_person_id ? (
                        <div>
                          <span className="font-semibold text-[#273244]">{u.full_name}</span>{' '}
                          <span className="font-mono text-[13px] text-[#9F3F50]">
                            ({u.approved_person_id})
                          </span>
                        </div>
                      ) : (
                        <span className="text-[#B91C1C] font-medium">ยังไม่ผูกชื่อบุคลากร</span>
                      )}
                    </td>
                    <td className="py-4 px-5 font-semibold">
                      {Number(u.is_active) === 1 ? (
                        <span className="text-[#047857]">ใช้งานปกติ</span>
                      ) : (
                        <span className="text-[#B91C1C]">ระงับการใช้งาน</span>
                      )}
                    </td>
                    <td className="py-4 px-5 font-mono tabular-nums text-[#596579]">
                      {u.last_login_at ? formatThaiDateTime(u.last_login_at) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  if (mode === 'auditLogs') {
    const sortedLogs = [...auditLogs].sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      return sortDir === 'ASC'
        ? String(valA || '').localeCompare(String(valB || ''), 'th')
        : String(valB || '').localeCompare(String(valA || ''), 'th');
    });

    const numericSize = pageSize === 'ALL' ? Math.max(1, sortedLogs.length) : pageSize;
    const pagedLogs = sortedLogs.slice((page - 1) * numericSize, page * numericSize);

    return (
      <div className="space-y-6">
        <PageHeader
          category="ตั้งค่าระบบและส่วนกลาง"
          title="ประวัติการใช้งานและบันทึกความปลอดภัย (Audit Logs)"
          subtitle="บันทึกทุกกิจกรรมการเข้าสู่ระบบ การตรวจสอบเวลา การซิงก์ข้อมูล และการอนุมัติอัปเดตระบบ (พร้อมปิดบังรหัสผ่านอัตโนมัติ)"
          actions={
            <div className="relative w-full sm:w-72">
              <Search className="w-4 h-4 text-[#596579] absolute left-3.5 top-3" aria-hidden="true" />
              <input
                type="text"
                aria-label="ค้นหาประวัติการใช้งาน"
                value={logSearch}
                onChange={(e) => {
                  setLogSearch(e.target.value);
                  setPage(1);
                }}
                placeholder="ค้นหาชื่อผู้ใช้, กิจกรรม, รหัสอ้างอิง..."
                className="ent-input pl-10 pr-4 w-full"
              />
            </div>
          }
        />

        <ErrorBanner error={error} onRetry={loadData} />

        <div className="ent-table-wrapper">
          {/* Mobile Card List View (< 768px) */}
          <div className="md:hidden divide-y divide-[#E7E2E5]">
            {loading ? (
              <div className="py-10 text-center text-[14.5px] text-[#596579]">
                กำลังโหลดบันทึกประวัติการใช้งาน...
              </div>
            ) : pagedLogs.length === 0 ? (
              <div className="py-10 px-4 text-center text-[14.5px] text-[#596579]">
                ไม่พบประวัติการใช้งานตามคำค้นหา
              </div>
            ) : (
              pagedLogs.map((log) => (
                <div key={log.id} className="p-4 space-y-2.5 bg-white">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-mono font-bold text-[14.5px] text-[#9F3F50]">
                        {log.action}
                      </div>
                      <div className="text-[13px] font-mono text-[#596579]">
                        {formatThaiDateTime(log.created_at)}
                      </div>
                    </div>
                    <span
                      className={`text-[13px] font-bold px-2.5 py-0.5 rounded-md border ${
                        log.result === 'SUCCESS'
                          ? 'text-[#047857] bg-emerald-50 border-emerald-200'
                          : 'text-[#B91C1C] bg-red-50 border-red-200'
                      }`}
                    >
                      {log.result === 'SUCCESS' ? 'สำเร็จ' : log.result}
                    </span>
                  </div>
                  <div className="p-3 rounded-lg bg-[#FFF9F9] border border-[#E7E2E5] text-[13.5px] space-y-1 font-mono">
                    <div className="flex items-center justify-between">
                      <span className="text-[#596579] font-sans">ผู้ดำเนินการ:</span>
                      <span className="font-bold text-[#273244]">
                        {log.actor_username} ({log.actor_role})
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[#596579] font-sans">เป้าหมาย:</span>
                      <span className="text-[#273244]">
                        {log.target_type}:{log.target_id || '—'}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedAuditLog(log)}
                    className="w-full h-10 px-3.5 text-[13.5px] font-semibold text-[#273244] bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center justify-center gap-1.5"
                  >
                    <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
                    <span>ดูข้อมูลรายละเอียด JSON</span>
                  </button>
                </div>
              ))
            )}
          </div>

          {/* Desktop Table View (>= 768px) */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
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
                    label="ประเภทกิจกรรม"
                    sortKey="action"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold">ข้อมูลเป้าหมาย</th>
                  <SortableHeader
                    label="ผลลัพธ์"
                    sortKey="result"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="py-3.5 px-4 text-[13.5px] font-semibold text-right">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2E5]">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-12 text-center text-[14.5px] text-[#596579]">
                      กำลังโหลดบันทึกประวัติการใช้งาน...
                    </td>
                  </tr>
                ) : pagedLogs.length === 0 ? (
                  <TableEmptyState colSpan={6} title="ไม่พบประวัติการใช้งานตามคำค้นหา" />
                ) : (
                  pagedLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-[#FFF9F9] transition-colors">
                      <td className="py-4 px-4 font-mono tabular-nums">
                        <div className="font-semibold text-[#273244]">
                          {formatThaiDateTime(log.created_at)}
                        </div>
                        <div className="text-[12px] text-[#596579]">
                          ID: {log.request_id.slice(0, 12)}
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        <div className="font-bold text-[#273244] font-mono">{log.actor_username}</div>
                        <div className="text-[12.5px] text-[#596579]">{log.actor_role}</div>
                      </td>
                      <td className="py-4 px-4 font-mono font-semibold text-[#9F3F50]">
                        {log.action}
                      </td>
                      <td className="py-4 px-4 font-mono text-[#596579]">
                        {log.target_type}:{log.target_id || '—'}
                      </td>
                      <td className="py-4 px-4 font-semibold">
                        <span
                          className={
                            log.result === 'SUCCESS' ? 'text-[#047857]' : 'text-[#B91C1C]'
                          }
                        >
                          {log.result === 'SUCCESS' ? 'สำเร็จ' : log.result}
                        </span>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedAuditLog(log)}
                          className="h-9 px-3.5 text-[13.5px] font-semibold text-[#273244] bg-white border border-[#D5CDD2] rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center gap-1.5"
                        >
                          <PanelRightOpen className="w-4 h-4 text-[#B45363]" />
                          <span>ดูข้อมูล</span>
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <TablePaginationBar
            currentPage={page}
            pageSize={pageSize}
            totalItems={sortedLogs.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>

        <SlideOverDrawer
          open={Boolean(selectedAuditLog)}
          onClose={() => setSelectedAuditLog(null)}
          kickerText="รายละเอียดบันทึกการตรวจสอบระบบ"
          title={`รายการบันทึก #${selectedAuditLog?.id || ''}`}
          subtitle={selectedAuditLog?.action || ''}
        >
          {selectedAuditLog && (
            <div className="space-y-4 text-[14px]">
              <div className="p-4 bg-[#FFF9F9] border border-[#E7E2E5] rounded-xl space-y-2 font-mono text-[13.5px]">
                <div>รหัสคำขอ (Request ID): {selectedAuditLog.request_id}</div>
                <div>เวลาที่เกิดเหตุการณ์: {formatThaiDateTime(selectedAuditLog.created_at)}</div>
                <div>
                  ผู้ดำเนินการ: {selectedAuditLog.actor_username} ({selectedAuditLog.actor_role})
                </div>
              </div>
              <div>
                <div className="font-bold text-[#273244] mb-2">ข้อมูลรายละเอียด (JSON):</div>
                <pre className="p-4 bg-[#273244] text-white rounded-xl font-mono text-[13px] overflow-x-auto">
                  {selectedAuditLog.detail_json || '{}'}
                </pre>
              </div>
            </div>
          )}
        </SlideOverDrawer>
      </div>
    );
  }

  if (mode === 'settings') {
    return (
      <div className="space-y-6">
        <PageHeader
          category="ตั้งค่าระบบและส่วนกลาง"
          title="ตั้งค่าระบบและตรวจสอบสถานะการเชื่อมต่อ"
          subtitle="ตรวจสอบความพร้อมของฐานข้อมูลและการเชื่อมต่อกับระบบภายนอก (ระบบไม่ส่งรหัสผ่านหรือกุญแจลับกลับมายังหน้าเว็บเบราว์เซอร์)"
        />

        <ErrorBanner error={error} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        {connections && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="ent-card p-4 sm:p-6 space-y-4">
              <h2 className="text-[18px] font-bold text-[#273244] border-b border-[#E7E2E5] pb-3">
                1. ข้อมูลสถาปัตยกรรมระบบและพอร์ตเชื่อมต่อ
              </h2>
              <dl className="divide-y divide-[#E7E2E5] text-[14px]">
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">รุ่นของระบบ (Version)</dt>
                  <dd className="font-mono font-bold text-[#273244]">
                    {connections.system.version}
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">เวอร์ชัน Node.js เป้าหมาย</dt>
                  <dd className="font-mono font-semibold text-[#9F3F50]">
                    {connections.system.targetNodeEngine} (รันจริง:{' '}
                    {connections.system.runtimeNodeVersion})
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">พอร์ต HTTPS หลักของระบบ</dt>
                  <dd className="font-mono tabular-nums font-bold text-[#273244]">
                    พอร์ต {connections.system.httpsPort}
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">พาธหน้าเว็บ / พาธ API</dt>
                  <dd className="font-mono text-[#273244]">
                    {connections.system.publicBasePath} · {connections.system.apiBasePath}
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">รูปแบบการทำงาน</dt>
                  <dd className="font-semibold text-[#047857]">
                    ระบบแยกอิสระ (Standalone — ไม่พึ่งพา Central Gateway)
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">สถานะใบรับรองความปลอดภัย (TLS)</dt>
                  <dd className="font-semibold text-[#047857]">
                    {connections.tls.certificateReady ? 'พร้อมใช้งาน' : 'ไม่พบไฟล์ใบรับรอง'}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="ent-card p-4 sm:p-6 space-y-4">
              <h2 className="text-[18px] font-bold text-[#273244] border-b border-[#E7E2E5] pb-3">
                2. สถานะฐานข้อมูลและโปรแกรมอ่านเครื่องสแกน
              </h2>
              <dl className="divide-y divide-[#E7E2E5] text-[14px]">
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">ฐานข้อมูลระบบลงเวลา (Sam_Att)</dt>
                  <dd className="font-mono font-semibold text-[#273244]">
                    {connections.samAttDatabase.database} ({connections.samAttDatabase.engine})
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">ฐานข้อมูลบุคลากร (HOSOffice)</dt>
                  <dd className="font-mono text-[#273244]">
                    {connections.hosofficeDatabase.host}:{connections.hosofficeDatabase.port}/
                    {connections.hosofficeDatabase.database}
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">สถานะสัญญาเชื่อมต่อ HOSOffice</dt>
                  <dd className="font-semibold text-[#B45309]">{health?.hosofficeDb?.status}</dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">ตำแหน่งไฟล์โปรแกรมอ่านสแกน</dt>
                  <dd className="font-mono text-[#273244] break-all">
                    {connections.scannerIntegration.readerExePath}
                  </dd>
                </div>
                <div className="py-3 flex flex-col sm:flex-row sm:justify-between gap-1 sm:gap-4">
                  <dt className="text-[#596579]">สถานะโปรแกรม ScannerReader.exe</dt>
                  <dd className="font-semibold text-[#B45309]">{health?.scannerExe?.status}</dd>
                </div>
              </dl>

              <div className="pt-3 flex flex-col sm:flex-row sm:flex-wrap gap-2.5">
                <button
                  type="button"
                  onClick={() => handleTestConnection('sam_att_db')}
                  className="ent-btn-primary w-full sm:w-auto"
                >
                  <Activity className="w-4 h-4" />
                  <span>ทดสอบฐานข้อมูล Sam_Att</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTestConnection('hosoffice_db')}
                  className="ent-btn-secondary w-full sm:w-auto"
                >
                  ทดสอบเชื่อมต่อ HOSOffice
                </button>
                <button
                  type="button"
                  onClick={() => handleTestConnection('scanner_exe')}
                  className="ent-btn-secondary w-full sm:w-auto"
                >
                  ตรวจสอบไฟล์ ScannerReader.exe
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        category="ตั้งค่าระบบและส่วนกลาง"
        title="ศูนย์ควบคุมการอัปเดต สำรองข้อมูล และย้อนกลับเวอร์ชัน"
        subtitle="ควบคุมการอัปเดตเฉพาะเซอร์วิสระบบลงเวลาบนพอร์ต 4101 โดยไม่กระทบต่อระบบงานอื่นของโรงพยาบาล"
        actions={
          <button
            type="button"
            onClick={handleRunPreflight}
            className="ent-btn-primary"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>ตรวจสอบความพร้อมของระบบก่อนอัปเดต</span>
          </button>
        }
      />

      <ErrorBanner error={error} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {preflightData && (
        <div className="ent-card p-4 sm:p-6 space-y-3">
          <h2 className="text-[18px] font-bold text-[#273244]">
            ผลการตรวจสอบความพร้อมก่อนอัปเดต:{' '}
            <span className={preflightData.preflightPassed ? 'text-[#047857]' : 'text-[#B91C1C]'}>
              {preflightData.preflightPassed ? 'ผ่านเกณฑ์ครบทุกข้อ' : 'ไม่ผ่านเกณฑ์'}
            </span>
          </h2>
          <div className="divide-y divide-[#E7E2E5] text-[14px]">
            {preflightData.checks?.map((c: any) => (
              <div key={c.id} className="py-3 flex items-center justify-between gap-4">
                <div>
                  <span className="font-semibold text-[#273244]">{c.label}</span>
                  <span className="ml-2 text-[#596579]">({c.detail})</span>
                </div>
                <span className={c.passed ? 'text-[#047857] font-bold' : 'text-[#B91C1C] font-bold'}>
                  {c.passed ? 'ผ่าน' : 'ไม่ผ่าน'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form onSubmit={handleApproveDeployment} className="ent-card p-4 sm:p-6 space-y-4">
          <div className="flex items-center gap-2.5 border-b border-[#E7E2E5] pb-3">
            <Shield className="w-5 h-5 text-[#B45363]" />
            <h2 className="text-[18px] font-bold text-[#273244]">
              อนุมัติแพ็กเกจอัปเดตระบบด้วยรหัสผ่านผู้ดูแลระบบ
            </h2>
          </div>
          <p className="text-[13.5px] text-[#596579] leading-relaxed">
            บันทึกเลข Commit และรหัสตรวจสอบความถูกต้อง (SHA-256) ลงฐานข้อมูล เพื่อให้สคริปต์อัปเดตบนเซิร์ฟเวอร์ตรวจสอบก่อนติดตั้งจริง
          </p>
          <div className="space-y-3.5">
            <div>
              <label className="ent-label">
                รหัส Commit SHA ที่ต้องการอนุมัติ <RequiredMark />
              </label>
              <input
                type="text"
                required
                value={commitSha}
                onChange={(e) => setCommitSha(e.target.value)}
                className="ent-input w-full font-mono"
              />
            </div>
            <div>
              <label className="ent-label">
                รหัสตรวจสอบไฟล์แพ็กเกจ (SHA-256 Checksum) <RequiredMark />
              </label>
              <input
                type="text"
                required
                value={artifactSha256}
                onChange={(e) => setArtifactSha256(e.target.value)}
                className="ent-input w-full font-mono"
              />
            </div>
            <div>
              <label className="ent-label">
                ยืนยันรหัสผ่านของผู้ดูแลระบบ (ADMIN) <RequiredMark />
              </label>
              <input
                type="password"
                required
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="ระบุรหัสผ่านของ admin เพื่อยืนยันการอนุมัติ"
                className="ent-input w-full"
              />
            </div>
          </div>
          <button type="submit" className="ent-btn-primary w-full sm:w-auto">
            ยืนยันการอนุมัติแพ็กเกจอัปเดต
          </button>
        </form>

        <div className="ent-card p-4 sm:p-6 space-y-4">
          <h2 className="text-[18px] font-bold text-[#273244] border-b border-[#E7E2E5] pb-3">
            ชุดสคริปต์จัดการเซอร์วิสบนเซิร์ฟเวอร์โรงพยาบาล
          </h2>
          <p className="text-[13.5px] text-[#596579]">
            สคริปต์มาตรฐานสำหรับผู้ดูแลระบบในการติดตั้ง สำรองข้อมูล และสลับเวอร์ชันอย่างปลอดภัย:
          </p>
          <div className="space-y-2.5 text-[13.5px] font-mono bg-[#FFF9F9] p-4 rounded-xl border border-[#E7E2E5] text-[#273244]">
            <div>1. scripts/install-windows.ps1 — ติดตั้งเซอร์วิสพอร์ต 4101</div>
            <div>2. scripts/backup.ps1 — สำรองฐานข้อมูลและไฟล์ระบบ</div>
            <div>3. scripts/deploy-test.ps1 — ตรวจสอบ SHA-256 และอัปเดต</div>
            <div>4. scripts/restore-test.ps1 — กู้คืนข้อมูลจากชุดสำรอง</div>
            <div>5. scripts/health-check.ps1 — ตรวจสอบสถานะ HTTPS 4101</div>
          </div>
        </div>
      </div>

      <div className="ent-table-wrapper">
        <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2E5] bg-[#F8F6F7]">
          <h2 className="text-[18px] font-bold text-[#273244]">
            ประวัติการอนุมัติอัปเดต สำรองข้อมูล และย้อนกลับเวอร์ชัน
          </h2>
        </div>

        {/* Mobile Card List View (< 768px) */}
        <div className="md:hidden divide-y divide-[#E7E2E5]">
          {deployStatus?.history?.map((h: any) => (
            <div key={h.id} className="p-4 space-y-2.5 bg-white">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-mono font-bold text-[15px] text-[#273244]">
                    #{h.id} · {h.release_version}
                  </div>
                  <div className="font-mono text-[13px] text-[#596579]">{h.action_type}</div>
                </div>
                <span className="font-semibold text-[13px] text-[#047857] bg-emerald-50 px-2.5 py-0.5 rounded-md border border-emerald-200">
                  {h.status}
                </span>
              </div>
              <div className="p-3 rounded-lg bg-[#FFF9F9] border border-[#E7E2E5] text-[13px] font-mono space-y-1">
                <div className="break-all">Commit: {h.commit_sha.slice(0, 14)}</div>
                <div className="break-all text-[#596579]">
                  Backup: {h.backup_archive_path || '—'}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRollback(h.id)}
                className="w-full h-10 px-3.5 text-[13.5px] border border-[#D5CDD2] bg-white rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center justify-center gap-1.5 font-semibold text-[#273244] transition-colors"
              >
                <RotateCcw className="w-4 h-4 text-[#B45363]" />
                <span>ย้อนกลับมารุ่นนี้</span>
              </button>
            </div>
          ))}
        </div>

        {/* Desktop Table View (>= 768px) */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-left border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[#E7E2E5] bg-[#F8F6F7] text-[#273244]">
                <th className="py-3.5 px-5 font-semibold">รหัส · รุ่นระบบ</th>
                <th className="py-3.5 px-5 font-semibold">ประเภทคำสั่ง</th>
                <th className="py-3.5 px-5 font-semibold">รหัส Commit / SHA-256</th>
                <th className="py-3.5 px-5 font-semibold">พาธไฟล์สำรองข้อมูล</th>
                <th className="py-3.5 px-5 font-semibold">สถานะ</th>
                <th className="py-3.5 px-5 font-semibold text-right">การจัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E2E5]">
              {deployStatus?.history?.map((h: any) => (
                <tr key={h.id} className="hover:bg-[#FFF9F9]">
                  <td className="py-4 px-5 font-mono font-bold text-[#273244]">
                    #{h.id} · {h.release_version}
                  </td>
                  <td className="py-4 px-5 font-mono text-[#596579]">{h.action_type}</td>
                  <td className="py-4 px-5 font-mono text-[13px] text-[#596579]">
                    {h.commit_sha.slice(0, 10)} · {h.artifact_sha256.slice(0, 12)}...
                  </td>
                  <td className="py-4 px-5 font-mono text-[13px] text-[#273244]">
                    {h.backup_archive_path || '—'}
                  </td>
                  <td className="py-4 px-5 font-semibold text-[#047857]">{h.status}</td>
                  <td className="py-4 px-5 text-right">
                    <button
                      type="button"
                      onClick={() => handleRollback(h.id)}
                      className="h-9 px-3.5 text-[13.5px] border border-[#D5CDD2] bg-white rounded-lg hover:bg-[#FFF1F3] hover:border-[#B45363] hover:text-[#9F3F50] inline-flex items-center gap-1.5 whitespace-nowrap font-semibold text-[#273244] transition-colors"
                    >
                      <RotateCcw className="w-4 h-4 text-[#B45363]" />
                      <span>ย้อนกลับมารุ่นนี้</span>
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
