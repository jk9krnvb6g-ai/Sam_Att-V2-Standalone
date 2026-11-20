/**
 * ============================================================================
 * ไฟล์: frontend/src/pages/AdminViews.tsx
 * หน้าที่: หน้าจอจัดการระบบสำหรับผู้ดูแลระบบ (ADMIN)
 * ============================================================================
 * ประกอบด้วย:
 * 1. UsersView (mode === 'users'): จัดการบัญชีผู้ใช้งานระบบและผูกชื่อบุคลากร
 * 2. AuditView (mode === 'auditLogs'): ประวัติการใช้งานและบันทึกความปลอดภัย (Immutable Audit Trail)
 * 3. DeploymentView (mode === 'deployment'): หน้า "อัปเดตระบบ Sam_Att" แบบปุ่มเดียว (Section 12)
 *    เรียกใช้ C:\inetpub\wwwroot\Sam_Att\deployment\Deploy_Sam_Att.bat อย่างปลอดภัยสำหรับ ADMIN เท่านั้น
 * ============================================================================
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  Rocket,
  CheckCircle2,
  Search,
  PanelRightOpen,
  Clock,
  Terminal,
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
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { formatThaiDateTime } from '../utils/thaiFormat.ts';

export function AdminViews({
  mode,
}: {
  mode: 'users' | 'auditLogs' | 'deployment';
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
  const [newPersonId, setNewPersonId] = useState('');

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [selectedAuditLog, setSelectedAuditLog] = useState<any | null>(null);

  // Simple One-Button Deployment state (Section 12)
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

  if (mode === 'users') {
    return (
      <div className="space-y-6">
        <PageHeader
          category="ระบบและผู้ดูแลส่วนกลาง"
          title="จัดการบัญชีผู้ใช้งานและสิทธิ์การเข้าถึง"
          subtitle="กำหนดสิทธิ์การใช้งาน 3 ระดับ (ผู้ดูแลระบบ, เจ้าหน้าที่งานบุคคล, บุคลากรทั่วไป) และเชื่อมโยงบัญชีเข้ากับรหัสบุคลากรของโรงพยาบาล"
        />

        <ErrorBanner error={error} onRetry={loadData} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        <form onSubmit={handleCreateUser} className="ent-card p-6 space-y-5">
          <div className="border-b border-[#E7E2F0] pb-3">
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
          <div className="px-4 sm:px-6 py-4 border-b border-[#E7E2F0] bg-[#FAF9FD]">
            <h2 className="text-[18px] font-bold text-[#273244]">
              รายชื่อบัญชีผู้ใช้งานทั้งหมด ({users.length} บัญชี)
            </h2>
          </div>

          <div className="md:hidden divide-y divide-[#E7E2F0]">
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
                <div className="p-3 rounded-lg bg-[#FAF9FD] border border-[#E7E2F0] text-[13.5px] space-y-1">
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

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
                  <th className="py-3.5 px-5 font-semibold">ชื่อบัญชีผู้ใช้งาน</th>
                  <th className="py-3.5 px-5 font-semibold">ชื่อ-นามสกุล</th>
                  <th className="py-3.5 px-5 font-semibold">ระดับสิทธิ์</th>
                  <th className="py-3.5 px-5 font-semibold">บุคลากรที่เชื่อมโยง</th>
                  <th className="py-3.5 px-5 font-semibold">สถานะบัญชี</th>
                  <th className="py-3.5 px-5 font-semibold">เข้าใช้งานล่าสุด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E7E2F0]">
                {users.map((u) => (
                  <tr key={u.id} className="hover:bg-[#FAF9FD]">
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
                          <span className="font-mono text-[13px] text-[#7359B4]">
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
          category="ระบบและผู้ดูแลส่วนกลาง"
          title="ประวัติการใช้งานและบันทึกความปลอดภัย (Audit Logs)"
          subtitle="บันทึกทุกกิจกรรมการเข้าสู่ระบบ การตรวจสอบเวลา การซิงก์ข้อมูล และการอัปเดตระบบ (พร้อมปิดบังรหัสผ่านอัตโนมัติ)"
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
          <div className="md:hidden divide-y divide-[#E7E2F0]">
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
                      <div className="font-mono font-bold text-[14.5px] text-[#7359B4]">
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
                  <div className="p-3 rounded-lg bg-[#FAF9FD] border border-[#E7E2F0] text-[13.5px] space-y-1 font-mono">
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
                    className="w-full h-10 px-3.5 text-[13.5px] font-semibold text-[#273244] bg-white border border-[#D5CEE6] rounded-lg hover:bg-[#F3EEFC] hover:border-[#8B73C7] hover:text-[#7359B4] inline-flex items-center justify-center gap-1.5"
                  >
                    <PanelRightOpen className="w-4 h-4 text-[#8B73C7]" />
                    <span>ดูข้อมูลรายละเอียด JSON</span>
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse text-[14px]">
              <thead>
                <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
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
              <tbody className="divide-y divide-[#E7E2F0]">
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
                    <tr key={log.id} className="hover:bg-[#FAF9FD] transition-colors">
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
                      <td className="py-4 px-4 font-mono font-semibold text-[#7359B4]">
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
                          className="h-9 px-3.5 text-[13.5px] font-semibold text-[#273244] bg-white border border-[#D5CEE6] rounded-lg hover:bg-[#F3EEFC] hover:border-[#8B73C7] hover:text-[#7359B4] inline-flex items-center gap-1.5"
                        >
                          <PanelRightOpen className="w-4 h-4 text-[#8B73C7]" />
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
              <div className="p-4 bg-[#FAF9FD] border border-[#E7E2F0] rounded-xl space-y-2 font-mono text-[13.5px]">
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

  // =========================================================================
  // โหมด 'deployment': หน้า "อัปเดตระบบ Sam_Att" แบบปุ่มเดียว (Section 12)
  // =========================================================================
  const latestDeploy = deployStatus?.history?.[0] || null;

  return (
    <div className="space-y-6">
      <PageHeader
        category="ระบบและผู้ดูแลส่วนกลาง"
        title="อัปเดตระบบ Sam_Att"
        subtitle="อัปเดตระบบ Sam_Att V2 Standalone อัตโนมัติด้วยปุ่มเดียว (ดึงโค้ดล่าสุด · สำรองฐานข้อมูล · Build · รีสตาร์ทเฉพาะเซอร์วิส Sam_Att บนพอร์ต 4101 โดยไม่กระทบ Procurement)"
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* การ์ดหลัก: สถานะปัจจุบันและปุ่มอัปเดตระบบเพียงปุ่มเดียว */}
      <div className="ent-card p-6 sm:p-8 space-y-6">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 pb-6 border-b border-[#E7E2F0]">
          <div className="space-y-2">
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#F3EEFC] text-[#7359B4] text-[13px] font-semibold">
              <Rocket className="w-4 h-4" />
              <span>ระบบอัปเดตอัตโนมัติ (Deploy_Sam_Att.bat)</span>
            </div>
            <h2 className="text-[22px] font-bold text-[#273244]">
              พร้อมอัปเดตระบบ Sam_Att V2 Standalone
            </h2>
            <p className="text-[14px] text-[#596579] max-w-2xl">
              เมื่อกดปุ่ม <strong className="text-[#273244]">“อัปเดตระบบ”</strong> ระบบจะเรียกใช้สคริปต์มาตรฐาน{' '}
              <code className="font-mono text-[13px] bg-[#FAF9FD] px-2 py-0.5 rounded border border-[#E7E2F0]">
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
              className="ent-btn-primary h-12 px-7 text-[15px] shadow-sm w-full sm:w-auto"
            >
              <Rocket className="w-5 h-5" />
              <span>{deployRunning ? 'กำลังอัปเดตระบบ...' : 'อัปเดตระบบ'}</span>
            </button>
          </div>
        </div>

        {/* ข้อมูลสำคัญ 3 รายการตามข้อกำหนด 12.1 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="p-4 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] space-y-1">
            <div className="text-[13px] font-medium text-[#596579]">เวอร์ชันปัจจุบัน</div>
            <div className="text-[20px] font-bold font-mono text-[#273244]">
              {deployStatus?.currentVersion || '2.0.0-standalone'}
            </div>
            <div className="text-[12.5px] text-[#596579]">
              พอร์ต HTTPS {deployStatus?.httpsPort || 4101} · แยกอิสระจากระบบอื่น
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] space-y-1">
            <div className="text-[13px] font-medium text-[#596579]">สถานะการอัปเดตล่าสุด</div>
            <div className="flex items-center gap-2 pt-0.5">
              {latestDeploy ? (
                <span
                  className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-[14px] font-bold border ${
                    latestDeploy.status === 'SUCCESS'
                      ? 'bg-emerald-50 text-[#047857] border-emerald-200'
                      : 'bg-red-50 text-[#B91C1C] border-red-200'
                  }`}
                >
                  <CheckCircle2 className="w-4 h-4" />
                  <span>{latestDeploy.status === 'SUCCESS' ? 'อัปเดตสำเร็จ (SUCCESS)' : latestDeploy.status}</span>
                </span>
              ) : (
                <span className="text-[15px] font-semibold text-[#047857]">
                  พร้อมใช้งาน (ยังไม่เคยสั่งอัปเดตผ่านหน้าเว็บ)
                </span>
              )}
            </div>
            <div className="text-[12.5px] text-[#596579]">
              ผู้ดำเนินการล่าสุด: {latestDeploy?.executed_by || 'ระบบเริ่มต้น'}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] space-y-1">
            <div className="text-[13px] font-medium text-[#596579]">วันที่อัปเดตล่าสุด</div>
            <div className="text-[17px] font-bold font-mono text-[#273244] flex items-center gap-2 pt-0.5">
              <Clock className="w-4 h-4 text-[#8B73C7] shrink-0" />
              <span>
                {latestDeploy?.executed_at
                  ? formatThaiDateTime(latestDeploy.executed_at)
                  : 'ติดตั้งรุ่นเริ่มต้น'}
              </span>
            </div>
            <div className="text-[12.5px] text-[#596579]">
              สำรองข้อมูลอัตโนมัติก่อนอัปเดตทุกครั้ง
            </div>
          </div>
        </div>

        {/* ผลการอัปเดตล่าสุด (Console Output) */}
        {(lastDeployOutput || latestDeploy?.rollback_note) && (
          <div className="space-y-2 pt-2">
            <div className="flex items-center gap-2 text-[14px] font-bold text-[#273244]">
              <Terminal className="w-4 h-4 text-[#7359B4]" />
              <span>ผลการอัปเดตล่าสุด</span>
            </div>
            <pre className="p-4 rounded-xl bg-[#273244] text-white font-mono text-[12.5px] overflow-x-auto leading-relaxed max-h-72">
              {lastDeployOutput || latestDeploy?.rollback_note}
            </pre>
          </div>
        )}
      </div>

      {/* ประวัติการอัปเดตย้อนหลังแบบเข้าใจง่าย */}
      <div className="ent-table-wrapper">
        <div className="px-5 py-4 border-b border-[#E7E2F0] bg-[#FAF9FD]">
          <h3 className="text-[16.5px] font-bold text-[#273244]">
            ประวัติการอัปเดตระบบ ({deployStatus?.history?.length || 0} รายการล่าสุด)
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-[14px]">
            <thead>
              <tr className="border-b border-[#E7E2F0] bg-[#FAF9FD] text-[#273244]">
                <th className="py-3 px-5 font-semibold">ครั้งที่ · เวอร์ชัน</th>
                <th className="py-3 px-5 font-semibold">วันที่และเวลา</th>
                <th className="py-3 px-5 font-semibold">ผู้สั่งอัปเดต</th>
                <th className="py-3 px-5 font-semibold">สถานะ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E7E2F0]">
              {!deployStatus?.history || deployStatus.history.length === 0 ? (
                <TableEmptyState
                  colSpan={4}
                  title="ยังไม่มีประวัติการอัปเดตระบบ"
                  description="เมื่อกดปุ่มอัปเดตระบบ ประวัติและผลการอัปเดตจะแสดงที่นี่"
                />
              ) : (
                deployStatus.history.map((h: any) => (
                  <tr key={h.id} className="hover:bg-[#FAF9FD]">
                    <td className="py-3.5 px-5 font-mono font-bold text-[#273244]">
                      #{h.id} · {h.release_version}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-[#596579]">
                      {h.executed_at ? formatThaiDateTime(h.executed_at) : '—'}
                    </td>
                    <td className="py-3.5 px-5 font-mono text-[#273244]">{h.executed_by}</td>
                    <td className="py-3.5 px-5">
                      <span
                        className={`font-semibold text-[12.5px] px-2.5 py-1 rounded-md border ${
                          h.status === 'SUCCESS'
                            ? 'text-[#047857] bg-emerald-50 border-emerald-200'
                            : 'text-[#B91C1C] bg-red-50 border-red-200'
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
        <div className="p-4 rounded-xl bg-[#FAF9FD] border border-[#E7E2F0] space-y-2 text-[13.5px] text-[#273244]">
          <div className="font-bold text-[#7359B4]">ขั้นตอนที่ระบบจะดำเนินการโดยอัตโนมัติ:</div>
          <ul className="list-disc pl-5 space-y-1 text-[#596579]">
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
            <pre className="p-3 rounded-lg bg-[#273244] text-white font-mono text-[11.5px] overflow-x-auto max-h-48">
              {lastDeployOutput}
            </pre>
          ) : undefined
        }
      />
    </div>
  );
}
