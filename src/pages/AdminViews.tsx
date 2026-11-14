import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Shield, Activity, CheckCircle2, RotateCcw, Search } from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../services/api.ts';
import { ErrorBanner, RoleLabel } from '../components/StatusText.tsx';
import {
  SortableHeader,
  TablePaginationBar,
  NotificationBanner,
  SharedModal,
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
      setNotice('สร้างบัญชีผู้ใช้งานและผูก PERSON_ID สำเร็จ');
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
      setNotice('รัน Preflight Check สำหรับ Sam_Att V2 Standalone สำเร็จ');
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
        `อนุมัติแพ็กเกจอัปเดตสำเร็จ (Deployment ID #${res.deploymentId}) พร้อมบันทึกค่า SHA-256 และเตรียม Backup ที่ ${res.backupArchivePath}`
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
          reason: 'สั่ง Rollback กลับไปยัง Snapshot เสถียรผ่านหน้าผู้ดูแลระบบ',
        }),
      });
      setNotice(
        `บันทึกคำสั่ง Rollback ไปยังเวอร์ชัน ${res.targetVersion} สำเร็จ (รัน scripts/restore-test.ps1 บน Windows Server เพื่อสลับไฟล์จริง)`
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
        <div className="border-b border-slate-200 pb-4">
          <h2 className="text-lg font-bold text-slate-900">
            จัดการผู้ใช้งานและผูก PERSON_ID (Users & 3-Role RBAC)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            กำหนดสิทธิ์ ADMIN · RESPONSIBLE_STAFF · GENERAL_USER และผูก approved_person_id สำหรับบังคับ Own-Only
          </p>
        </div>

        <ErrorBanner error={error} onRetry={loadData} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        <form
          onSubmit={handleCreateUser}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs"
        >
          <h3 className="text-sm font-semibold text-slate-900">สร้างบัญชีผู้ใช้งานใหม่</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Username</label>
              <input
                type="text"
                required
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="เช่น user1005"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg font-mono"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">รหัสผ่าน (อย่างน้อย 8 ตัว)</label>
              <input
                type="password"
                required
                minLength={8}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">ชื่อที่แสดง</label>
              <input
                type="text"
                required
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="ชื่อ-สกุล"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">บทบาท (3 Roles เท่านั้น)</label>
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value as UserRole)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="GENERAL_USER">GENERAL_USER</option>
                <option value="RESPONSIBLE_STAFF">RESPONSIBLE_STAFF</option>
                <option value="ADMIN">ADMIN</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">ผูก PERSON_ID</label>
              <select
                value={newPersonId}
                onChange={(e) => setNewPersonId(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white"
              >
                <option value="">-- ไม่ผูก PERSON_ID --</option>
                {personnel.map((p) => (
                  <option key={p.person_id} value={p.person_id}>
                    {p.person_id} · {p.full_name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <button
            type="submit"
            className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>สร้างบัญชีและอนุมัติ PERSON_ID</span>
          </button>
        </form>

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                <th className="py-2.5 px-3 font-semibold">ID · Username</th>
                <th className="py-2.5 px-3 font-semibold">ชื่อที่แสดง</th>
                <th className="py-2.5 px-3 font-semibold">บทบาท (Role)</th>
                <th className="py-2.5 px-3 font-semibold">PERSON_ID ที่ผูกอนุมัติแล้ว</th>
                <th className="py-2.5 px-3 font-semibold">สถานะบัญชี</th>
                <th className="py-2.5 px-3 font-semibold">เข้าใช้ล่าสุด (พ.ศ.)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-50">
                  <td className="py-2.5 px-3 font-mono font-semibold">
                    #{u.id} · {u.username}
                  </td>
                  <td className="py-2.5 px-3 font-medium">{u.display_name}</td>
                  <td className="py-2.5 px-3">
                    <RoleLabel role={u.role} />
                  </td>
                  <td className="py-2.5 px-3 font-mono">
                    {u.approved_person_id ? (
                      <span>
                        <span className="font-semibold text-teal-800">{u.approved_person_id}</span> ·{' '}
                        {u.full_name}
                      </span>
                    ) : (
                      <span className="text-red-700">ยังไม่ผูก PERSON_ID</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-semibold">
                    {Number(u.is_active) === 1 ? (
                      <span className="text-emerald-700">ACTIVE</span>
                    ) : (
                      <span className="text-red-700">DISABLED</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 font-mono tabular-nums text-slate-500">
                    {u.last_login_at ? formatThaiDateTime(u.last_login_at) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (mode === 'auditLogs') {
    const sortedLogs = [...auditLogs].sort((a, b) => {
      const valA = a[sortKey];
      const valB = b[sortKey];
      return sortDir === 'ASC'
        ? String(valA || '').localeCompare(String(valB || ''))
        : String(valB || '').localeCompare(String(valA || ''));
    });

    const numericSize = pageSize === 'ALL' ? Math.max(1, sortedLogs.length) : pageSize;
    const pagedLogs = sortedLogs.slice((page - 1) * numericSize, page * numericSize);

    return (
      <div className="space-y-6">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              ระบบ & ประวัติการทำงาน (System & Audit Logs)
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">
              บันทึกทุกเหตุการณ์สำคัญพร้อม Request ID และ IP Address · คัดกรองและปิดบังรหัสผ่าน/Token อัตโนมัติ
            </p>
          </div>

          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              value={logSearch}
              onChange={(e) => {
                setLogSearch(e.target.value);
                setPage(1);
              }}
              placeholder="ค้นหาผู้ใช้งาน, Request ID, Target..."
              className="pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded-lg bg-white w-64"
            />
          </div>
        </div>

        <ErrorBanner error={error} onRetry={loadData} />

        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
                  <SortableHeader
                    label="เวลา (พ.ศ.) · Request ID"
                    sortKey="created_at"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="ผู้ใช้งาน · Role"
                    sortKey="actor_username"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <SortableHeader
                    label="Action"
                    sortKey="action"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="py-2.5 px-3 font-semibold">Target</th>
                  <SortableHeader
                    label="ผลลัพธ์"
                    sortKey="result"
                    activeSortKey={sortKey}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                  <th className="py-2.5 px-3 font-semibold text-right">รายละเอียด</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-500">
                      กำลังโหลด Audit Logs...
                    </td>
                  </tr>
                ) : (
                  pagedLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50">
                      <td className="py-2.5 px-3 font-mono tabular-nums">
                        <div>{formatThaiDateTime(log.created_at)}</div>
                        <div className="text-[11px] text-slate-400">{log.request_id.slice(0, 12)}</div>
                      </td>
                      <td className="py-2.5 px-3 font-mono">
                        <div className="font-semibold text-slate-900">{log.actor_username}</div>
                        <div className="text-[11px] text-slate-500">{log.actor_role}</div>
                      </td>
                      <td className="py-2.5 px-3 font-mono font-semibold text-slate-900">{log.action}</td>
                      <td className="py-2.5 px-3 font-mono text-slate-600">
                        {log.target_type}:{log.target_id || '-'}
                      </td>
                      <td className="py-2.5 px-3 font-semibold">
                        <span
                          className={
                            log.result === 'SUCCESS' ? 'text-emerald-700' : 'text-red-700'
                          }
                        >
                          {log.result}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right">
                        <button
                          type="button"
                          onClick={() => setSelectedAuditLog(log)}
                          className="px-2.5 py-1 text-xs font-medium text-teal-800 border border-slate-300 rounded-lg hover:bg-slate-50"
                        >
                          ดู JSON
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

        <SharedModal
          open={Boolean(selectedAuditLog)}
          onClose={() => setSelectedAuditLog(null)}
          title={`รายละเอียด Audit Log #${selectedAuditLog?.id || ''} (${selectedAuditLog?.action || ''})`}
          maxWidthClass="max-w-xl"
        >
          {selectedAuditLog && (
            <div className="space-y-3 text-xs">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-1 font-mono">
                <div>Request ID: {selectedAuditLog.request_id}</div>
                <div>เวลา: {formatThaiDateTime(selectedAuditLog.created_at)}</div>
                <div>ผู้ดำเนินการ: {selectedAuditLog.actor_username} ({selectedAuditLog.actor_role})</div>
              </div>
              <pre className="p-4 bg-slate-900 text-slate-100 rounded-xl font-mono text-xs overflow-x-auto">
                {selectedAuditLog.detail_json || '{}'}
              </pre>
            </div>
          )}
        </SharedModal>
      </div>
    );
  }

  if (mode === 'settings') {
    return (
      <div className="space-y-6">
        <div className="border-b border-slate-200 pb-4">
          <h2 className="text-lg font-bold text-slate-900">
            ตั้งค่าระบบและการเชื่อมต่อ (System Settings & Connection Health)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            แสดงเฉพาะค่าตั้งต้นที่ปลอดภัย (ไม่ส่งรหัสผ่านหรือ Secret กลับไปยัง Browser) · ทดสอบการเชื่อมต่อแบบ Fail-Closed
          </p>
        </div>

        <ErrorBanner error={error} />
        <NotificationBanner message={notice} onClose={() => setNotice(null)} />

        {connections && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
              <h3 className="text-sm font-semibold text-slate-900">
                1. โครงสร้างระบบและ Single-Port HTTPS Listener
              </h3>
              <dl className="divide-y divide-slate-200 text-xs">
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">เวอร์ชันระบบ / สถาปัตยกรรม</dt>
                  <dd className="font-mono font-semibold">{connections.system.version}</dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">Node.js Target (.nvmrc / engines.node)</dt>
                  <dd className="font-mono font-semibold text-teal-800">
                    {connections.system.targetNodeEngine} (Runtime: {connections.system.runtimeNodeVersion})
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">HTTPS Port เดียวสำหรับ Frontend & API</dt>
                  <dd className="font-mono tabular-nums font-bold">Port {connections.system.httpsPort}</dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">Frontend Base URL / API Base URL</dt>
                  <dd className="font-mono">
                    {connections.system.publicBasePath} · {connections.system.apiBasePath}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">ใช้ Central API Gateway หรือไม่</dt>
                  <dd className="font-semibold text-emerald-700">ไม่ใช้ (Standalone 100%)</dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">สถานะใบรับรอง TLS (server.crt / server.key)</dt>
                  <dd className="font-semibold text-emerald-700">
                    {connections.tls.certificateReady ? 'พร้อมใช้งาน (Active)' : 'ไม่พบไฟล์'}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
              <h3 className="text-sm font-semibold text-slate-900">
                2. สถานะฐานข้อมูล Sam_Att, HOSOffice และ ScannerReader.exe
              </h3>
              <dl className="divide-y divide-slate-200 text-xs">
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">ฐานข้อมูลหลัก Sam_Att</dt>
                  <dd className="font-mono">
                    {connections.samAttDatabase.database} ({connections.samAttDatabase.engine})
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">ฐานข้อมูล HOSOffice (hr_person)</dt>
                  <dd className="font-mono">
                    {connections.hosofficeDatabase.host}:{connections.hosofficeDatabase.port}/
                    {connections.hosofficeDatabase.database}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">สถานะสัญญา HOSOffice</dt>
                  <dd className="font-semibold text-amber-800">
                    {health?.hosofficeDb?.status}
                  </dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">Path ของ ScannerReader.exe เดิม</dt>
                  <dd className="font-mono">{connections.scannerIntegration.readerExePath}</dd>
                </div>
                <div className="py-2 flex justify-between">
                  <dt className="text-slate-600">สถานะสัญญา ScannerReader.exe</dt>
                  <dd className="font-semibold text-amber-800">
                    {health?.scannerExe?.status}
                  </dd>
                </div>
              </dl>

              <div className="pt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => handleTestConnection('sam_att_db')}
                  className="px-3 py-1.5 text-xs font-medium bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5"
                >
                  <Activity className="w-3.5 h-3.5" />
                  <span>ทดสอบฐานข้อมูล Sam_Att</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleTestConnection('hosoffice_db')}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-900"
                >
                  ทดสอบเชื่อมต่อ HOSOffice
                </button>
                <button
                  type="button"
                  onClick={() => handleTestConnection('scanner_exe')}
                  className="px-3 py-1.5 text-xs font-medium bg-slate-800 text-white rounded-lg hover:bg-slate-900"
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
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            Deployment Center (Standalone Windows Service Deployment)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            ทำงานเฉพาะกับเซอร์วิส SamAttV2Standalone บนพอร์ต 4101 เท่านั้น · ห้ามแตะต้องระบบจัดซื้อ (Procurement), Central Gateway หรือ FILESERVER
          </p>
        </div>

        <button
          type="button"
          onClick={handleRunPreflight}
          className="px-3.5 py-2 text-xs font-semibold bg-teal-800 text-white rounded-lg hover:bg-teal-900 inline-flex items-center gap-1.5 whitespace-nowrap w-fit"
        >
          <CheckCircle2 className="w-3.5 h-3.5" />
          <span>รันการตรวจสอบความพร้อมก่อนอัปเดต (Run Preflight)</span>
        </button>
      </div>

      <ErrorBanner error={error} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {preflightData && (
        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-2 shadow-2xs">
          <h3 className="text-sm font-semibold text-slate-900">
            ผลการตรวจสอบ Preflight Checks: {preflightData.preflightPassed ? 'ผ่านทุกข้อ (PASSED)' : 'ไม่ผ่าน'}
          </h3>
          <div className="divide-y divide-slate-200 text-xs">
            {preflightData.checks?.map((c: any) => (
              <div key={c.id} className="py-2 flex items-center justify-between">
                <div>
                  <span className="font-semibold text-slate-900">{c.label}</span>
                  <span className="ml-2 text-slate-500">({c.detail})</span>
                </div>
                <span className={c.passed ? 'text-emerald-700 font-bold' : 'text-red-700 font-bold'}>
                  {c.passed ? 'PASS' : 'FAIL'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <form
          onSubmit={handleApproveDeployment}
          className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs"
        >
          <div className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-teal-800" />
            <h3 className="text-sm font-semibold text-slate-900">
              อนุมัติแพ็กเกจอัปเดตด้วยรหัสผ่าน ADMIN (Re-Authentication & SHA-256 Pinning)
            </h3>
          </div>
          <p className="text-xs text-slate-600">
            ไม่อนุญาตให้รันคำสั่ง Shell จาก Browser โดยตรง · การอนุมัติจะบันทึก Commit SHA และ SHA-256 ลงฐานข้อมูลเพื่อให้สคริปต์ PowerShell (`scripts/deploy-test.ps1`) ตรวจสอบก่อนอัปเดต
          </p>
          <div className="space-y-2.5">
            <div>
              <label className="block text-xs text-slate-600 mb-1">Commit SHA ที่ต้องการ Pin</label>
              <input
                type="text"
                required
                value={commitSha}
                onChange={(e) => setCommitSha(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">Artifact SHA-256 Checksum (64 Hex)</label>
              <input
                type="text"
                required
                value={artifactSha256}
                onChange={(e) => setArtifactSha256(e.target.value)}
                className="w-full px-2.5 py-1.5 text-xs font-mono border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-600 mb-1">
                ยืนยันรหัสผ่าน ADMIN (Re-authentication)
              </label>
              <input
                type="password"
                required
                value={adminPassword}
                onChange={(e) => setAdminPassword(e.target.value)}
                placeholder="ใส่รหัสผ่านของ admin เพื่อยืนยัน"
                className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg"
              />
            </div>
          </div>
          <button
            type="submit"
            className="px-3.5 py-2 text-xs font-semibold bg-slate-900 text-white rounded-lg hover:bg-slate-800"
          >
            ยืนยันอนุมัติแพ็กเกจอัปเดต (Approve Release Manifest)
          </button>
        </form>

        <div className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-2xs">
          <h3 className="text-sm font-semibold text-slate-900">
            สคริปต์ PowerShell สำหรับ Windows Server (ในโฟลเดอร์ scripts/)
          </h3>
          <div className="space-y-2 text-xs font-mono bg-slate-50 p-3 rounded-lg border border-slate-200">
            <div>1. scripts/install-windows.ps1 — ติดตั้งเซอร์วิส SamAttV2Standalone พอร์ต 4101</div>
            <div>2. scripts/backup.ps1 — สำรองฐานข้อมูล MySQL + ไฟล์ .env + Build</div>
            <div>3. scripts/deploy-test.ps1 — ตรวจ SHA-256, สำรองข้อมูล, สลับเวอร์ชัน และ Rollback อัตโนมัติหาก Health ไม่ผ่าน</div>
            <div>4. scripts/restore-test.ps1 — ทดสอบกู้คืนฐานข้อมูลและไฟล์ระบบ</div>
            <div>5. scripts/health-check.ps1 — ตรวจ HTTPS 4101 /Sam_Att/ และ /api/Sam_Att/health</div>
          </div>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/60">
          <h3 className="text-sm font-semibold text-slate-900">
            ประวัติการติดตั้ง สำรองข้อมูล และ Rollback (deployment_history)
          </h3>
        </div>
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50 text-slate-600">
              <th className="py-2.5 px-3 font-semibold">ID · เวอร์ชัน</th>
              <th className="py-2.5 px-3 font-semibold">ประเภทคำสั่ง</th>
              <th className="py-2.5 px-3 font-semibold">Commit / SHA-256</th>
              <th className="py-2.5 px-3 font-semibold">พาธไฟล์สำรองข้อมูล (Backup)</th>
              <th className="py-2.5 px-3 font-semibold">สถานะ</th>
              <th className="py-2.5 px-3 font-semibold text-right">สั่ง Rollback</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200">
            {deployStatus?.history?.map((h: any) => (
              <tr key={h.id} className="hover:bg-slate-50">
                <td className="py-2.5 px-3 font-mono font-semibold">
                  #{h.id} · {h.release_version}
                </td>
                <td className="py-2.5 px-3 font-mono">{h.action_type}</td>
                <td className="py-2.5 px-3 font-mono text-[11px] text-slate-500">
                  {h.commit_sha.slice(0, 10)} · {h.artifact_sha256.slice(0, 12)}...
                </td>
                <td className="py-2.5 px-3 font-mono text-[11px]">{h.backup_archive_path || '-'}</td>
                <td className="py-2.5 px-3 font-semibold text-teal-800">{h.status}</td>
                <td className="py-2.5 px-3 text-right">
                  <button
                    type="button"
                    onClick={() => handleRollback(h.id)}
                    className="px-2.5 py-1 text-xs border border-slate-300 rounded-lg hover:bg-slate-100 inline-flex items-center gap-1 whitespace-nowrap"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Rollback มารุ่นนี้</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
