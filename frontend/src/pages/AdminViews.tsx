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
  Search,
  PanelRightOpen,
  Terminal,
  RefreshCw,
  Database,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Lock,
  Loader2,
  RotateCcw,
  Pencil,
  KeyRound,
  UserCheck,
  UserX,
  Copy,
  Check,
  Users,
  Download,
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
  ConfirmDialog,
  ProgressDialog,
  type PageSizeOption,
} from '../components/common/SharedComponents.tsx';
import { useToast } from '../components/common/ToastContext.tsx';
import { PageHelpAction } from '../components/common/ContextualHelp.tsx';
import { DeploymentUpdateCenter } from '../components/deployment/DeploymentUpdateCenter.tsx';
import type { NavViewKey, SidebarUpdateBadge } from '../components/layout/Sidebar.tsx';
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
  DEPLOYMENT_BAT_EXECUTED: 'ดำเนินการอัปเดตระบบ Sam_Att',
  DEPLOYMENT_VERSION_CHECKED: 'ตรวจสอบเวอร์ชันจาก GitHub',
  DEPLOYMENT_BLOCKED_MIGRATION_APPROVAL_REQUIRED: 'ระงับการอัปเดต (รออนุมัติ Database Migration)',
  USERS_BULK_CREATED: 'สร้างบัญชีผู้ใช้งานแบบกลุ่ม',
  USERS_BULK_CREATE_BLOCKED: 'ระงับการสร้างบัญชี ADMIN แบบกลุ่ม',
  ATTENDANCE_BULK_REVIEWED: 'ตรวจสอบและรับรองผล HR แบบกลุ่ม',
  ATTENDANCE_PERIOD_CLOSED: 'ปิดรอบบัญชีเวลาประจำเดือน',
  ATTENDANCE_PERIOD_REOPENED: 'เปิดรอบบัญชีเวลาประจำเดือนใหม่',
  ATTENDANCE_PERIOD_STATUS_UPDATED: 'ปรับสถานะรอบบัญชีเวลาประจำเดือน',
  HOSPITAL_HOLIDAY_CREATED: 'เพิ่มวันหยุดโรงพยาบาล',
  HOSPITAL_HOLIDAY_UPDATED: 'แก้ไขวันหยุดโรงพยาบาล',
  HOSPITAL_HOLIDAY_DELETED: 'ยกเลิกวันหยุดโรงพยาบาล',
  COMPLETENESS_BATCH_PROCESSED: 'ประมวลผลความครบถ้วนของข้อมูลเวลา',
};

function sanitizeCsvCell(val: unknown): string {
  const raw = String(val ?? '');
  const trimmedStart = raw.replace(/^[\s]+/, '');
  const safe =
    /^[=+\-@\t\r]/.test(raw) || /^[=+\-@]/.test(trimmedStart) ? `'${raw}` : raw;
  return `"${safe.replace(/"/g, '""')}"`;
}

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
  onNotificationChange,
}: {
  mode: 'users' | 'auditLogs' | 'deployment';
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
  onNotificationChange?: (badge?: SidebarUpdateBadge | null) => void;
}) {
  if (mode === 'deployment') {
    return (
      <DeploymentUpdateCenter
        userRole={userRole}
        onNavigate={onNavigate}
        onNotificationChange={onNotificationChange}
      />
    );
  }
  return (
    <AdminUsersAndAuditViews
      mode={mode}
      userRole={userRole}
      onNavigate={onNavigate}
    />
  );
}

function AdminUsersAndAuditViews({
  mode,
  userRole,
  onNavigate,
}: {
  mode: 'users' | 'auditLogs' | 'deployment';
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
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

  // Edit User / Status Toggle / Password Reset state
  const [editUserTarget, setEditUserTarget] = useState<any | null>(null);
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editRole, setEditRole] = useState<UserRole>('GENERAL_USER');
  const [editPersonId, setEditPersonId] = useState('');
  const [editIsActive, setEditIsActive] = useState(true);
  const [editUserError, setEditUserError] = useState<string | null>(null);
  const [savingEditUser, setSavingEditUser] = useState(false);

  const [statusToggleTarget, setStatusToggleTarget] = useState<any | null>(null);
  const [togglingStatus, setTogglingStatus] = useState(false);

  const [resetConfirmTarget, setResetConfirmTarget] = useState<any | null>(null);
  const [resettingPassword, setResettingPassword] = useState(false);
  const [tempPasswordResult, setTempPasswordResult] = useState<{
    username: string;
    displayName: string;
    temporaryPassword: string;
  } | null>(null);
  const [copiedTempPwd, setCopiedTempPwd] = useState(false);
  const [copiedAuditJson, setCopiedAuditJson] = useState(false);

  // B5: Bulk User Creation state
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkLoadingCandidates, setBulkLoadingCandidates] = useState(false);
  const [bulkCandidates, setBulkCandidates] = useState<any[]>([]);
  const [bulkCandidateSummary, setBulkCandidateSummary] = useState<{
    totalActivePersonnel: number;
    alreadyLinkedCount: number;
    availableCandidateCount: number;
  } | null>(null);
  const [bulkSelectedPersonIds, setBulkSelectedPersonIds] = useState<Set<string>>(new Set());
  const [bulkUsernameEdits, setBulkUsernameEdits] = useState<Record<string, string>>({});
  const [bulkDepartmentFilter, setBulkDepartmentFilter] = useState('');
  const [bulkPersonnelTypeFilter, setBulkPersonnelTypeFilter] = useState('');
  const [bulkSearch, setBulkSearch] = useState('');
  const [bulkDefaultRole, setBulkDefaultRole] = useState<'GENERAL_USER' | 'RESPONSIBLE_STAFF'>(
    'GENERAL_USER'
  );
  const [bulkCreating, setBulkCreating] = useState(false);
  const [bulkResult, setBulkResult] = useState<{
    totalRequested: number;
    createdCount: number;
    failedCount: number;
    created: any[];
    failed: any[];
  } | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [logSearch, setLogSearch] = useState('');
  const [logDateFilter, setLogDateFilter] = useState('');
  const [logActorFilter, setLogActorFilter] = useState('');
  const [logActionFilter, setLogActionFilter] = useState('');
  const [logResultFilter, setLogResultFilter] = useState('');
  const [selectedAuditLog, setSelectedAuditLog] = useState<any | null>(null);

  // Safe Deployment & Migration Approval state
  const [deployStatus, setDeployStatus] = useState<any>(null);
  const [migrationInfo, setMigrationInfo] = useState<any>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [confirmDeployOpen, setConfirmDeployOpen] = useState(false);
  const [migrationApprovalOpen, setMigrationApprovalOpen] = useState(false);
  const [migrationImpactAck, setMigrationImpactAck] = useState(false);
  const [migrationConfirmPassword, setMigrationConfirmPassword] = useState('');
  const [migrationApprovalError, setMigrationApprovalError] = useState<string | null>(null);
  const [deployProgressOpen, setDeployProgressOpen] = useState(false);
  const [deployRunning, setDeployRunning] = useState(false);
  const [deployStepLabel, setDeployStepLabel] = useState('เตรียมความพร้อมก่อนอัปเดตระบบ...');
  const [deployPercent, setDeployPercent] = useState<number | null>(null);
  const [deployResultState, setDeployResultState] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
  const [deploySummaryText, setDeploySummaryText] = useState<string | null>(null);
  const [deployErrorText, setDeployErrorText] = useState<string | null>(null);
  const [lastDeployOutput, setLastDeployOutput] = useState<string | null>(null);
  const [lastDeployMeta, setLastDeployMeta] = useState<{
    exitCode?: number;
    backupDir?: string | null;
    backupSqlPath?: string | null;
    commitBefore?: string | null;
    commitAfter?: string | null;
    migrationsApplied?: string[];
    requiresAdminDatabaseRestore?: boolean;
  } | null>(null);
  const [deployPipelineStage, setDeployPipelineStage] = useState<
    | 'IDLE'
    | 'CHECKING'
    | 'AWAITING_MIGRATION_APPROVAL'
    | 'RUNNING'
    | 'SUCCESS'
    | 'FAILED'
    | 'ACTION_REQUIRED'
  >('IDLE');

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
        const [statusRes, migRes] = await Promise.all([
          apiRequest('/deployment/status'),
          apiRequest('/deployment/migrations').catch(() => null),
        ]);
        setDeployStatus(statusRes);
        if (migRes) {
          setMigrationInfo(migRes);
          if (migRes.combinedPendingMigrations?.length > 0) {
            setDeployPipelineStage((prev) => (prev === 'IDLE' ? 'AWAITING_MIGRATION_APPROVAL' : prev));
          }
        }
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

  function openEditUserModal(u: any) {
    setEditUserTarget(u);
    setEditDisplayName(String(u.display_name || ''));
    setEditRole((u.role || 'GENERAL_USER') as UserRole);
    setEditPersonId(String(u.approved_person_id || ''));
    setEditIsActive(Number(u.is_active) === 1);
    setEditUserError(null);
  }

  async function handleSaveEditUser(e: React.FormEvent) {
    e.preventDefault();
    if (!editUserTarget) return;
    setEditUserError(null);
    setSavingEditUser(true);
    try {
      await apiRequest(`/users/${editUserTarget.id}`, {
        method: 'PUT',
        body: JSON.stringify({
          displayName: editDisplayName.trim(),
          role: editRole,
          approvedPersonId: editPersonId || null,
          isActive: editIsActive,
        }),
      });
      setEditUserTarget(null);
      toast.success('บันทึกการแก้ไขบัญชีผู้ใช้งานแล้ว', `อัปเดตข้อมูลของ ${editDisplayName.trim()} เรียบร้อย`);
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถบันทึกการแก้ไขบัญชีได้';
      setEditUserError(msg);
      toast.error('แก้ไขบัญชีไม่สำเร็จ', msg, err instanceof ApiClientError ? err.requestId : undefined);
    } finally {
      setSavingEditUser(false);
    }
  }

  async function handleConfirmToggleUserStatus() {
    if (!statusToggleTarget) return;
    setTogglingStatus(true);
    const nextIsActive = Number(statusToggleTarget.is_active) !== 1;
    try {
      await apiRequest(`/users/${statusToggleTarget.id}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: nextIsActive }),
      });
      toast.success(
        nextIsActive ? 'เปิดใช้งานบัญชีแล้ว' : 'ระงับการใช้งานบัญชีแล้ว',
        `บัญชี ${statusToggleTarget.username}`
      );
      setStatusToggleTarget(null);
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถเปลี่ยนสถานะบัญชีได้';
      toast.error('เปลี่ยนสถานะบัญชีไม่สำเร็จ', msg, err instanceof ApiClientError ? err.requestId : undefined);
    } finally {
      setTogglingStatus(false);
    }
  }

  async function handleConfirmResetPassword() {
    if (!resetConfirmTarget) return;
    setResettingPassword(true);
    try {
      const res = await apiRequest<{
        username: string;
        displayName: string;
        temporaryPassword: string;
      }>(`/users/${resetConfirmTarget.id}/reset-password`, {
        method: 'POST',
      });
      setResetConfirmTarget(null);
      setCopiedTempPwd(false);
      setTempPasswordResult({
        username: res.username,
        displayName: res.displayName,
        temporaryPassword: res.temporaryPassword,
      });
      toast.success(
        'รีเซ็ตรหัสผ่านเรียบร้อยแล้ว',
        `สร้างรหัสผ่านชั่วคราวให้ ${res.username} และบังคับเปลี่ยนเมื่อเข้าสู่ระบบครั้งถัดไป`
      );
      await loadData();
    } catch (err) {
      const msg = err instanceof ApiClientError ? err.message : 'ไม่สามารถรีเซ็ตรหัสผ่านได้';
      toast.error('รีเซ็ตรหัสผ่านไม่สำเร็จ', msg, err instanceof ApiClientError ? err.requestId : undefined);
    } finally {
      setResettingPassword(false);
    }
  }

  async function handleCheckDeploymentUpdates() {
    setCheckingUpdates(true);
    setError(null);
    setNotice(null);
    setDeployPipelineStage('CHECKING');
    try {
      const res = await apiRequest('/deployment/check-updates', { method: 'POST' });
      setMigrationInfo({
        appliedMigrations: res.appliedMigrations || [],
        pendingFiles: res.pendingMigrations || [],
        combinedPendingMigrations: res.pendingMigrations || [],
        pendingDetails: res.pendingMigrationDetails || [],
        checksumMismatches: res.checksumMismatches || [],
        schemaVerification: res.schemaVerification,
        migrationApprovalRequired: Boolean(res.migrationApprovalRequired),
        backupPolicy: res.backupPolicy,
        git: {
          branch: res.branch,
          currentCommit: res.currentCommit,
          targetCommit: res.targetCommit,
          hasUpdates: res.hasUpdates,
          warning: res.gitWarning,
        },
      });
      if (res.checksumMismatches?.length > 0) {
        setDeployPipelineStage('ACTION_REQUIRED');
        setError({
          code: 'MIGRATION_CHECKSUM_MISMATCH',
          message: 'ตรวจพบไฟล์ Migration ที่เคยรันไปแล้วถูกแก้ไขค่า Checksum ระบบระงับการอัปเดตเพื่อความปลอดภัย',
        });
      } else if (res.migrationApprovalRequired) {
        setDeployPipelineStage('AWAITING_MIGRATION_APPROVAL');
        const msg = `ตรวจพบ Database Migration รออนุมัติ (${(res.pendingMigrations || []).join(', ')}) — กรุณาตรวจสอบผลกระทบและอนุมัติด้วยรหัสผ่านผู้ดูแลระบบ`;
        setNotice(msg);
        toast.warning('พบ Database Migration รออนุมัติ', msg);
      } else {
        setDeployPipelineStage('IDLE');
        const msg = res.hasUpdates
          ? 'พบการอัปเดตใหม่จาก GitHub (ไม่มี Database Migration ใหม่) พร้อมอัปเดตระบบอย่างปลอดภัย'
          : 'ตรวจสอบระบบและสถานะ Migration เรียบร้อยแล้ว ไม่พบ Migration ค้างอยู่';
        setNotice(msg);
        toast.success('ตรวจสอบสถานะระบบแล้ว', msg);
      }
    } catch (err) {
      setDeployPipelineStage('FAILED');
      if (err instanceof ApiClientError) {
        setError({ code: err.code, message: err.message });
      } else {
        setError({ message: 'ไม่สามารถตรวจสอบการอัปเดตจากเซิร์ฟเวอร์ได้' });
      }
    } finally {
      setCheckingUpdates(false);
    }
  }

  function handleClickPrimaryUpdateButton() {
    const pendingList: string[] = migrationInfo?.combinedPendingMigrations || [];
    const checksumErrs: any[] = migrationInfo?.checksumMismatches || [];
    if (checksumErrs.length > 0) {
      setError({
        code: 'MIGRATION_CHECKSUM_MISMATCH',
        message: 'ไม่สามารถอัปเดตได้เนื่องจากพบ Checksum ของไฟล์ Migration เดิมไม่ตรงกับฐานข้อมูล',
      });
      return;
    }
    if (pendingList.length > 0) {
      setMigrationImpactAck(false);
      setMigrationConfirmPassword('');
      setMigrationApprovalError(null);
      setMigrationApprovalOpen(true);
      return;
    }
    setConfirmDeployOpen(true);
  }

  async function handleExecuteOneButtonUpdate(approvalPayload?: {
    approveMigrations: true;
    approvedTargetCommit: string;
    approvedMigrationFiles: string[];
    impactAcknowledged: true;
    confirmPassword: string;
  }) {
    if (!approvalPayload) {
      setConfirmDeployOpen(false);
    } else {
      setMigrationApprovalError(null);
    }
    setError(null);
    setNotice(null);
    setDeployRunning(true);
    setDeployPipelineStage('RUNNING');
    setDeployProgressOpen(true);
    setDeployResultState('RUNNING');
    setDeployStepLabel(
      approvalPayload
        ? 'กำลังสำรองฐานข้อมูล MySQL นอก Git Repo · อัปเดตโค้ด · Build · รัน Migration ที่อนุมัติ · ตรวจสอบ Health Check...'
        : 'กำลังสำรองฐานข้อมูล MySQL นอก Git Repo · อัปเดตโค้ด · Build · ตรวจสอบ Health Check...'
    );
    // ห้ามจำลอง % หรือแสดง 100% ก่อน Backend ตอบกลับจริง
    setDeployPercent(null);
    setDeploySummaryText(null);
    setDeployErrorText(null);
    setLastDeployMeta(null);

    try {
      const bodyPayload = approvalPayload
        ? { confirmRun: true, ...approvalPayload }
        : { confirmRun: true };
      const res = await apiRequest('/deployment/run-bat', {
        method: 'POST',
        body: JSON.stringify(bodyPayload),
      });

      if (approvalPayload) {
        setMigrationConfirmPassword('');
        setMigrationApprovalOpen(false);
      }

      setDeployPercent(100);
      setDeployResultState('SUCCESS');
      setDeployPipelineStage('SUCCESS');
      setDeployStepLabel('อัปเดตระบบ Sam_Att และตรวจสอบระบบหลังอัปเดตสำเร็จ');
      setDeploySummaryText(
        res.message || 'อัปเดตระบบ Sam_Att V2 Standalone สำเร็จเรียบร้อยแล้ว (Exit Code: 0)'
      );
      setLastDeployOutput(res.output || null);
      setLastDeployMeta({
        exitCode: res.exitCode ?? 0,
        backupDir: res.backupDir || null,
        backupSqlPath: res.backupSqlPath || null,
        commitBefore: res.commitBefore || null,
        commitAfter: res.commitAfter || null,
        migrationsApplied: res.migrationsApplied || [],
        requiresAdminDatabaseRestore: false,
      });
      setNotice('อัปเดตระบบ Sam_Att สำเร็จเรียบร้อยแล้ว');
      toast.success('อัปเดตระบบ Sam_Att สำเร็จแล้ว', res.message);
      await loadData();
    } catch (err) {
      if (approvalPayload) {
        // ล้างรหัสผ่านทันทีทุกกรณี และคง Modal เปิดไว้หากเป็นรหัสผ่านผิด/ถูกล็อก/ไม่ตรงเงื่อนไข
        setMigrationConfirmPassword('');
      }
      setDeployPercent(null);

      if (err instanceof ApiClientError) {
        const d = err.data || {};
        if (
          approvalPayload &&
          (err.code === 'INVALID_CONFIRM_PASSWORD' ||
            err.code === 'REAUTH_RATE_LIMITED' ||
            err.code === 'IMPACT_CONFIRMATION_REQUIRED' ||
            err.code === 'PASSWORD_CONFIRMATION_REQUIRED' ||
            err.code === 'MIGRATION_APPROVAL_MISMATCH')
        ) {
          setDeployProgressOpen(false);
          setDeployPipelineStage('AWAITING_MIGRATION_APPROVAL');
          setMigrationApprovalError(err.message);
          return;
        }

        if (err.code === 'MIGRATION_APPROVAL_REQUIRED') {
          setDeployProgressOpen(false);
          setDeployPipelineStage('AWAITING_MIGRATION_APPROVAL');
          if (d.pendingMigrations) {
            setMigrationInfo((prev: any) => ({
              ...(prev || {}),
              pendingFiles: d.pendingMigrations,
              combinedPendingMigrations: d.pendingMigrations,
              pendingDetails: d.pendingMigrationDetails || prev?.pendingDetails || [],
              appliedMigrations: d.appliedMigrations || prev?.appliedMigrations || [],
              backupPolicy: d.backupPolicy || prev?.backupPolicy,
              migrationApprovalRequired: true,
              git: {
                ...(prev?.git || {}),
                currentCommit: d.currentCommit || prev?.git?.currentCommit,
                targetCommit: d.targetCommit || prev?.git?.targetCommit,
              },
            }));
          }
          setMigrationImpactAck(false);
          setMigrationConfirmPassword('');
          setMigrationApprovalError(null);
          setMigrationApprovalOpen(true);
          return;
        }

        if (approvalPayload) {
          setMigrationApprovalOpen(false);
        }

        const needsDbRestore = Boolean(d.requiresAdminDatabaseRestore);
        setDeployResultState('FAILED');
        setDeployPipelineStage(needsDbRestore ? 'ACTION_REQUIRED' : 'FAILED');
        setDeployStepLabel(
          needsDbRestore
            ? 'ต้องดำเนินการเพิ่มเติม — โปรดตรวจสอบและกู้คืนฐานข้อมูลหากจำเป็น'
            : `การอัปเดตระบบไม่สำเร็จ${typeof d.exitCode === 'number' ? ` (Exit Code: ${d.exitCode})` : ''}`
        );
        setDeployErrorText(err.message);
        if (d.output || d.errorOutput) {
          setLastDeployOutput([d.output, d.errorOutput].filter(Boolean).join('\n'));
        }
        setLastDeployMeta({
          exitCode: typeof d.exitCode === 'number' ? d.exitCode : 1,
          backupDir: d.backupDir || null,
          backupSqlPath: d.backupSqlPath || null,
          requiresAdminDatabaseRestore: needsDbRestore,
        });
        setError({ code: err.code, message: err.message });
      } else {
        if (approvalPayload) {
          setMigrationApprovalOpen(false);
        }
        setDeployResultState('FAILED');
        setDeployPipelineStage('FAILED');
        setDeployStepLabel('การอัปเดตระบบไม่สำเร็จ');
        const msg = 'เกิดข้อผิดพลาดระหว่างรันสคริปต์อัปเดตระบบ';
        setDeployErrorText(msg);
        setError({ message: msg });
      }
      await loadData();
    } finally {
      setDeployRunning(false);
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
                  setBulkError(null);
                  setBulkResult(null);
                  setBulkSelectedPersonIds(new Set());
                  setBulkUsernameEdits({});
                  setBulkDepartmentFilter('');
                  setBulkPersonnelTypeFilter('');
                  setBulkSearch('');
                  setBulkDefaultRole('GENERAL_USER');
                  setBulkModalOpen(true);
                  setBulkLoadingCandidates(true);
                  apiRequest('/users/bulk-candidates')
                    .then((res) => {
                      setBulkCandidates(res.items || []);
                      setBulkCandidateSummary(res.summary || null);
                    })
                    .catch((err) => {
                      setBulkError(
                        err instanceof ApiClientError
                          ? err.message
                          : 'ไม่สามารถโหลดรายชื่อบุคลากรที่ยังไม่มีบัญชีได้'
                      );
                    })
                    .finally(() => setBulkLoadingCandidates(false));
                }}
                className="ent-btn-secondary"
              >
                <Users className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                <span>สร้างบัญชีผู้ใช้แบบกลุ่ม</span>
              </button>
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
                          <div className="flex items-center gap-1.5">
                            <StatusBadge tone={Number(u.is_active) === 1 ? 'success' : 'danger'}>
                              {Number(u.is_active) === 1 ? 'ใช้งานปกติ' : 'ระงับการใช้งาน'}
                            </StatusBadge>
                            {Number(u.must_change_password || 0) === 1 && (
                              <StatusBadge tone="warning" label="ต้องเปลี่ยนรหัส" compact />
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="pt-2 border-t border-[#F1ECFA] grid grid-cols-3 gap-1.5">
                        <button
                          type="button"
                          onClick={() => openEditUserModal(u)}
                          className="ent-btn-secondary h-8 px-2 text-[12px] justify-center"
                        >
                          <Pencil className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>แก้ไข</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setResetConfirmTarget(u)}
                          className="ent-btn-secondary h-8 px-2 text-[12px] justify-center"
                        >
                          <KeyRound className="w-3.5 h-3.5" aria-hidden="true" />
                          <span>รีเซ็ตรหัส</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setStatusToggleTarget(u)}
                          className="ent-btn-secondary h-8 px-2 text-[12px] justify-center"
                        >
                          {Number(u.is_active) === 1 ? (
                            <UserX className="w-3.5 h-3.5 text-[#C74455]" aria-hidden="true" />
                          ) : (
                            <UserCheck className="w-3.5 h-3.5 text-[#198568]" aria-hidden="true" />
                          )}
                          <span>{Number(u.is_active) === 1 ? 'ระงับ' : 'เปิดใช้'}</span>
                        </button>
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
                      <th className="text-right">จัดการบัญชี</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedUsers.length === 0 ? (
                      <TableEmptyState colSpan={7} title="ไม่พบบัญชีผู้ใช้งานตามเงื่อนไขที่ค้นหา" />
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
                            <div className="flex flex-wrap items-center gap-1.5">
                              <StatusBadge tone={Number(u.is_active) === 1 ? 'success' : 'danger'}>
                                {Number(u.is_active) === 1 ? 'ใช้งานปกติ' : 'ระงับการใช้งาน'}
                              </StatusBadge>
                              {Number(u.must_change_password || 0) === 1 && (
                                <StatusBadge tone="warning" label="ต้องเปลี่ยนรหัส" compact />
                              )}
                            </div>
                          </td>
                          <td className="font-mono tabular-nums text-[#777287]">
                            {u.last_login_at ? formatThaiDateTime(u.last_login_at) : '—'}
                          </td>
                          <td className="text-right">
                            <div className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={() => openEditUserModal(u)}
                                className="ent-btn-secondary h-8 px-2.5 text-[12px]"
                                title="แก้ไขสิทธิ์และข้อมูลบัญชี"
                              >
                                <Pencil className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                                <span>แก้ไข</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setResetConfirmTarget(u)}
                                className="ent-btn-secondary h-8 px-2.5 text-[12px]"
                                title="รีเซ็ตรหัสผ่านชั่วคราว"
                              >
                                <KeyRound className="w-3.5 h-3.5 text-[#B87516]" aria-hidden="true" />
                                <span>รีเซ็ตรหัส</span>
                              </button>
                              <button
                                type="button"
                                onClick={() => setStatusToggleTarget(u)}
                                className="ent-btn-secondary h-8 px-2.5 text-[12px]"
                                title={Number(u.is_active) === 1 ? 'ระงับการใช้งาน' : 'เปิดใช้งานบัญชี'}
                              >
                                {Number(u.is_active) === 1 ? (
                                  <UserX className="w-3.5 h-3.5 text-[#C74455]" aria-hidden="true" />
                                ) : (
                                  <UserCheck className="w-3.5 h-3.5 text-[#198568]" aria-hidden="true" />
                                )}
                                <span>{Number(u.is_active) === 1 ? 'ระงับ' : 'เปิดใช้'}</span>
                              </button>
                            </div>
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

        {/* Edit User Modal */}
        <SharedModal
          open={Boolean(editUserTarget)}
          onClose={() => !savingEditUser && setEditUserTarget(null)}
          kickerText="แก้ไขบัญชีผู้ใช้งานและสิทธิ์การเข้าถึง"
          title={editUserTarget ? `แก้ไขบัญชี ${editUserTarget.username}` : 'แก้ไขบัญชี'}
          subtitle="ปรับระดับสิทธิ์ ชื่อที่แสดง การเชื่อมโยงรหัสบุคลากร และสถานะการใช้งาน (ป้องกันการลดสิทธิ์ผู้ดูแลระบบคนสุดท้าย)"
          maxWidthClass="max-w-xl"
        >
          <form onSubmit={handleSaveEditUser} className="space-y-4">
            {editUserError && (
              <div
                role="alert"
                className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13.5px] font-medium"
              >
                {editUserError}
              </div>
            )}
            <div>
              <label className="ent-label">
                ชื่อ-นามสกุลที่แสดงในระบบ <RequiredMark />
              </label>
              <input
                type="text"
                required
                disabled={savingEditUser}
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                className="ent-input w-full"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="ent-label">
                  ระดับสิทธิ์การใช้งาน <RequiredMark />
                </label>
                <select
                  disabled={savingEditUser}
                  value={editRole}
                  onChange={(e) => setEditRole(e.target.value as UserRole)}
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
                  disabled={savingEditUser}
                  value={editPersonId}
                  onChange={(e) => setEditPersonId(e.target.value)}
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
            <label className="flex items-center gap-2.5 p-3 rounded-xl border border-[#E8E4EF] bg-[#F8F7FC] cursor-pointer">
              <input
                type="checkbox"
                disabled={savingEditUser}
                checked={editIsActive}
                onChange={(e) => setEditIsActive(e.target.checked)}
                className="w-4 h-4 accent-[#8066B5]"
              />
              <span className="text-[13.5px] font-medium text-[#292638]">
                เปิดใช้งานบัญชีผู้ใช้นี้ (Is Active)
              </span>
            </label>
            <div className="flex flex-col-reverse sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
              <button
                type="button"
                disabled={savingEditUser}
                onClick={() => setEditUserTarget(null)}
                className="ent-btn-secondary w-full sm:w-auto"
              >
                ยกเลิก
              </button>
              <button
                type="submit"
                disabled={savingEditUser}
                className="ent-btn-primary w-full sm:w-auto"
              >
                {savingEditUser ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                )}
                <span>{savingEditUser ? 'กำลังบันทึก...' : 'บันทึกการเปลี่ยนแปลง'}</span>
              </button>
            </div>
          </form>
        </SharedModal>

        {/* Status Toggle Confirm Dialog */}
        <ConfirmDialog
          open={Boolean(statusToggleTarget)}
          onCancel={() => !togglingStatus && setStatusToggleTarget(null)}
          onConfirm={handleConfirmToggleUserStatus}
          title={
            Number(statusToggleTarget?.is_active) === 1
              ? 'ยืนยันการระงับการใช้งานบัญชี'
              : 'ยืนยันการเปิดใช้งานบัญชี'
          }
          description={
            statusToggleTarget
              ? `ต้องการ${Number(statusToggleTarget.is_active) === 1 ? 'ระงับการใช้งาน' : 'เปิดใช้งาน'}บัญชี "${statusToggleTarget.username}" (${statusToggleTarget.display_name}) ใช่หรือไม่?`
              : ''
          }
          confirmLabel={
            Number(statusToggleTarget?.is_active) === 1 ? 'ระงับการใช้งาน' : 'เปิดใช้งานบัญชี'
          }
          variant={Number(statusToggleTarget?.is_active) === 1 ? 'danger' : 'primary'}
          loading={togglingStatus}
        />

        {/* Reset Password Confirm Dialog */}
        <ConfirmDialog
          open={Boolean(resetConfirmTarget)}
          onCancel={() => !resettingPassword && setResetConfirmTarget(null)}
          onConfirm={handleConfirmResetPassword}
          title="ยืนยันการรีเซ็ตรหัสผ่านชั่วคราว"
          description={
            resetConfirmTarget
              ? `ระบบจะสร้างรหัสผ่านชั่วคราวแบบสุ่มใหม่ให้บัญชี "${resetConfirmTarget.username}" และบังคับให้เปลี่ยนรหัสผ่านทันทีเมื่อเข้าสู่ระบบครั้งถัดไป`
              : ''
          }
          confirmLabel={resettingPassword ? 'กำลังสร้างรหัสผ่านชั่วคราว...' : 'สร้างรหัสผ่านชั่วคราวใหม่'}
          variant="primary"
          loading={resettingPassword}
        />

        {/* One-Time Temporary Password Modal */}
        <SharedModal
          open={Boolean(tempPasswordResult)}
          onClose={() => setTempPasswordResult(null)}
          kickerText="แสดงเพียงครั้งเดียว (One-Time Temporary Password)"
          title="รหัสผ่านชั่วคราวใหม่พร้อมใช้งาน"
          subtitle="กรุณาคัดลอกและส่งต่อให้เจ้าของบัญชีอย่างปลอดภัย ระบบไม่ได้บันทึกรหัสผ่านนี้ในรูปแบบข้อความธรรมดา"
          maxWidthClass="max-w-md"
        >
          {tempPasswordResult && (
            <div className="space-y-4">
              <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 text-[13.5px]">
                <div className="flex justify-between gap-2">
                  <span className="text-[#777287]">ชื่อบัญชี (Username)</span>
                  <span className="font-mono font-bold text-[#292638]">{tempPasswordResult.username}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="text-[#777287]">ชื่อที่แสดง</span>
                  <span className="font-semibold text-[#292638]">{tempPasswordResult.displayName}</span>
                </div>
              </div>
              <div className="p-4 rounded-xl bg-[#F1ECFA] border border-[#8066B5]/35 flex items-center justify-between gap-3">
                <div>
                  <div className="text-[12px] text-[#4E3978] font-semibold">รหัสผ่านชั่วคราว (ใช้เข้าสู่ระบบครั้งแรก)</div>
                  <div className="font-mono text-[18px] font-bold text-[#292638] tracking-wide mt-0.5 select-all">
                    {tempPasswordResult.temporaryPassword}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(tempPasswordResult.temporaryPassword);
                    setCopiedTempPwd(true);
                  }}
                  className="ent-btn-secondary h-9 px-3 shrink-0"
                >
                  {copiedTempPwd ? (
                    <Check className="w-4 h-4 text-[#198568]" aria-hidden="true" />
                  ) : (
                    <Copy className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                  )}
                  <span>{copiedTempPwd ? 'คัดลอกแล้ว' : 'คัดลอก'}</span>
                </button>
              </div>
              <div className="flex justify-end pt-2 border-t border-[#E8E4EF]">
                <button
                  type="button"
                  onClick={() => setTempPasswordResult(null)}
                  className="ent-btn-primary"
                >
                  ปิดหน้าต่าง
                </button>
              </div>
            </div>
          )}
        </SharedModal>

        {/* B5: Bulk User Creation Modal */}
        <SharedModal
          open={bulkModalOpen}
          onClose={() => !bulkCreating && setBulkModalOpen(false)}
          kickerText="สร้างบัญชีผู้ใช้งานแบบกลุ่ม (Bulk Account Provisioning)"
          title="สร้างบัญชีผู้ใช้จากทะเบียนบุคลากรที่ยังไม่มีบัญชี"
          subtitle="ระบบสร้างรหัสผ่านชั่วคราวแบบสุ่มปลอดภัย (CSPRNG) และบังคับให้เปลี่ยนรหัสผ่านเมื่อเข้าสู่ระบบครั้งแรก"
          maxWidthClass="max-w-5xl"
        >
          {(() => {
            const deptOptions = Array.from(
              new Set(bulkCandidates.map((c) => String(c.departmentName || '')).filter(Boolean))
            ).sort((a, b) => a.localeCompare(b, 'th'));
            const ptOptions = Array.from(
              new Map(
                bulkCandidates
                  .filter((c) => c.personnelTypeCode)
                  .map((c) => [String(c.personnelTypeCode), String(c.personnelTypeName || c.personnelTypeCode)])
              ).entries()
            ).sort((a, b) => a[1].localeCompare(b[1], 'th'));

            const q = bulkSearch.trim().toLowerCase();
            const filteredCandidates = bulkCandidates.filter((c) => {
              if (bulkDepartmentFilter && c.departmentName !== bulkDepartmentFilter) return false;
              if (bulkPersonnelTypeFilter && c.personnelTypeCode !== bulkPersonnelTypeFilter) return false;
              if (q) {
                return (
                  String(c.personId || '').toLowerCase().includes(q) ||
                  String(c.fullName || '').toLowerCase().includes(q) ||
                  String(c.departmentName || '').toLowerCase().includes(q) ||
                  String(bulkUsernameEdits[c.personId] ?? c.suggestedUsername ?? '')
                    .toLowerCase()
                    .includes(q)
                );
              }
              return true;
            });

            const allFilteredSelected =
              filteredCandidates.length > 0 &&
              filteredCandidates.slice(0, 500).every((c) => bulkSelectedPersonIds.has(c.personId));

            function handleDownloadBulkTempPasswordsCsv() {
              if (!bulkResult || !bulkResult.created?.length) return;
              const headers = [
                'รหัสบุคลากร (Person ID)',
                'ชื่อบัญชี (Username)',
                'ชื่อ-นามสกุล',
                'หน่วยงาน',
                'ระดับสิทธิ์',
                'รหัสผ่านชั่วคราว (ใช้ครั้งแรก)',
              ];
              const rows = bulkResult.created.map((acc) =>
                [
                  sanitizeCsvCell(acc.personId),
                  sanitizeCsvCell(acc.username),
                  sanitizeCsvCell(acc.displayName),
                  sanitizeCsvCell(acc.departmentName),
                  sanitizeCsvCell(acc.role),
                  sanitizeCsvCell(acc.temporaryPassword),
                ].join(',')
              );
              const csvContent = `\uFEFF${headers.map(sanitizeCsvCell).join(',')}\n${rows.join('\n')}`;
              const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `sam_att_bulk_temp_passwords_${new Date().toISOString().slice(0, 10)}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            }

            async function handleSubmitBulkCreate() {
              const selectedList = bulkCandidates.filter((c) =>
                bulkSelectedPersonIds.has(c.personId)
              );
              if (selectedList.length === 0) {
                setBulkError('กรุณาเลือกบุคลากรอย่างน้อย 1 รายการ');
                return;
              }
              if (selectedList.length > 500) {
                setBulkError('รองรับการสร้างบัญชีแบบกลุ่มสูงสุด 500 รายการต่อครั้ง');
                return;
              }
              setBulkCreating(true);
              setBulkError(null);
              try {
                const res = await apiRequest('/users/bulk-create', {
                  method: 'POST',
                  body: JSON.stringify({
                    defaultRole: bulkDefaultRole,
                    candidates: selectedList.map((c) => ({
                      personId: c.personId,
                      username: (bulkUsernameEdits[c.personId] ?? c.suggestedUsername).trim(),
                      displayName: c.fullName,
                      role: bulkDefaultRole,
                    })),
                  }),
                });
                setBulkResult(res);
                toast.showSuccess(
                  `สร้างบัญชีผู้ใช้งานสำเร็จ ${res.createdCount} บัญชี`,
                  res.failedCount > 0 ? `ไม่สำเร็จ ${res.failedCount} รายการ` : undefined
                );
                const [freshCandidates, freshUsers] = await Promise.all([
                  apiRequest('/users/bulk-candidates'),
                  apiRequest('/users'),
                ]);
                setBulkCandidates(freshCandidates.items || []);
                setBulkCandidateSummary(freshCandidates.summary || null);
                setUsers(freshUsers.items || []);
                const createdSet = new Set<string>(
                  (res.created || []).map((c: any) => String(c.personId))
                );
                setBulkSelectedPersonIds((prev) => {
                  const next = new Set(prev);
                  createdSet.forEach((pid) => next.delete(pid));
                  return next;
                });
              } catch (err) {
                const msg =
                  err instanceof ApiClientError
                    ? err.message
                    : 'ไม่สามารถสร้างบัญชีผู้ใช้งานแบบกลุ่มได้';
                setBulkError(msg);
                toast.showError('สร้างบัญชีแบบกลุ่มไม่สำเร็จ', msg);
              } finally {
                setBulkCreating(false);
              }
            }

            return (
              <div className="space-y-4">
                {bulkError && (
                  <div
                    role="alert"
                    className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13px] font-medium"
                  >
                    {bulkError}
                  </div>
                )}

                <div className="p-3.5 rounded-xl bg-[#F1ECFA]/70 border border-[#D8D1E6] text-[12.5px] text-[#4E3978] flex flex-wrap items-center justify-between gap-2">
                  <span>
                    เพื่อความปลอดภัย ไม่อนุญาตให้สร้างสิทธิ์ผู้ดูแลระบบ (ADMIN) แบบกลุ่ม — สร้างได้เฉพาะ{' '}
                    <strong>GENERAL_USER</strong> และ <strong>RESPONSIBLE_STAFF</strong> (สูงสุด 500 บัญชี/ครั้ง)
                  </span>
                  {bulkCandidateSummary && (
                    <span className="font-mono font-semibold tabular-nums">
                      ยังไม่มีบัญชี {bulkCandidateSummary.availableCandidateCount} /{' '}
                      {bulkCandidateSummary.totalActivePersonnel} คน
                    </span>
                  )}
                </div>

                {bulkResult ? (
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="p-3.5 rounded-xl bg-[#EEF8F4] border border-[#198568]/20">
                        <div className="text-[12px] font-semibold text-[#198568]">
                          สร้างบัญชีสำเร็จ (ต้องเปลี่ยนรหัสผ่านครั้งแรก)
                        </div>
                        <div className="text-[22px] font-bold font-mono tabular-nums text-[#198568]">
                          {bulkResult.createdCount} บัญชี
                        </div>
                      </div>
                      <div className="p-3.5 rounded-xl bg-[#FEF7EA] border border-[#B87516]/25">
                        <div className="text-[12px] font-semibold text-[#B87516]">
                          ไม่สำเร็จ / ข้าม
                        </div>
                        <div className="text-[22px] font-bold font-mono tabular-nums text-[#B87516]">
                          {bulkResult.failedCount} รายการ
                        </div>
                      </div>
                    </div>

                    {bulkResult.created.length > 0 && (
                      <div className="space-y-2.5">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="text-[13.5px] font-bold text-[#292638]">
                            รหัสผ่านชั่วคราว (แสดงเพียงครั้งเดียว — ระบบไม่ได้บันทึกใน Audit Log)
                          </div>
                          <button
                            type="button"
                            onClick={handleDownloadBulkTempPasswordsCsv}
                            className="ent-btn-primary h-9 px-3.5 text-[13px]"
                          >
                            <Download className="w-4 h-4" aria-hidden="true" />
                            <span>ดาวน์โหลด CSV รหัสผ่านชั่วคราว</span>
                          </button>
                        </div>
                        <div className="overflow-x-auto max-h-60 border border-[#E8E4EF] rounded-xl">
                          <table className="his-table text-[13px]">
                            <thead>
                              <tr>
                                <th>Username</th>
                                <th>ชื่อ-สกุล · หน่วยงาน</th>
                                <th>สิทธิ์</th>
                                <th>รหัสผ่านชั่วคราว</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bulkResult.created.map((acc) => (
                                <tr key={acc.id}>
                                  <td className="font-mono font-bold text-[#292638]">{acc.username}</td>
                                  <td>
                                    <div className="font-semibold text-[#292638]">{acc.displayName}</div>
                                    <div className="text-[12px] text-[#777287]">{acc.departmentName}</div>
                                  </td>
                                  <td>
                                    <RoleLabel role={acc.role} />
                                  </td>
                                  <td className="font-mono font-bold text-[#4E3978] select-all">
                                    {acc.temporaryPassword}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {bulkResult.failed.length > 0 && (
                      <div className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] space-y-2 text-[13px]">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-[#8E2837]">
                            รายการที่ไม่สำเร็จ ({bulkResult.failed.length} รายการ)
                          </span>
                          <button
                            type="button"
                            onClick={() => {
                              const retryIds = new Set(
                                bulkResult.failed
                                  .map((f: any) => String(f.personId || ''))
                                  .filter(Boolean)
                              );
                              setBulkSelectedPersonIds(retryIds);
                              setBulkResult(null);
                            }}
                            className="ent-btn-secondary h-8 px-3 text-[12.5px]"
                          >
                            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                            <span>ลองใหม่เฉพาะรายการที่ล้มเหลว</span>
                          </button>
                        </div>
                        <div className="max-h-32 overflow-y-auto space-y-1 text-[#8E2837]">
                          {bulkResult.failed.map((f: any, idx: number) => (
                            <div key={`${f.personId}-${idx}`}>
                              <span className="font-mono font-semibold">{f.personId || '—'}</span> (
                              {f.username || '—'}): {f.message}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
                      <input
                        type="text"
                        aria-label="ค้นหาบุคลากรในรายการสร้างบัญชีแบบกลุ่ม"
                        value={bulkSearch}
                        onChange={(e) => setBulkSearch(e.target.value)}
                        placeholder="ค้นหาชื่อ รหัส หรือ Username..."
                        className="ent-input w-full"
                      />
                      <select
                        aria-label="กรองตามหน่วยงาน"
                        value={bulkDepartmentFilter}
                        onChange={(e) => setBulkDepartmentFilter(e.target.value)}
                        className="ent-input w-full"
                      >
                        <option value="">ทุกหน่วยงาน ({deptOptions.length})</option>
                        {deptOptions.map((d) => (
                          <option key={d} value={d}>
                            {d}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="กรองตามประเภทบุคลากร"
                        value={bulkPersonnelTypeFilter}
                        onChange={(e) => setBulkPersonnelTypeFilter(e.target.value)}
                        className="ent-input w-full"
                      >
                        <option value="">ทุกประเภทบุคลากร</option>
                        {ptOptions.map(([code, name]) => (
                          <option key={code} value={code}>
                            {name}
                          </option>
                        ))}
                      </select>
                      <select
                        aria-label="กำหนดสิทธิ์เริ่มต้นสำหรับบัญชีที่เลือก"
                        value={bulkDefaultRole}
                        onChange={(e) =>
                          setBulkDefaultRole(
                            e.target.value as 'GENERAL_USER' | 'RESPONSIBLE_STAFF'
                          )
                        }
                        className="ent-input w-full font-semibold"
                      >
                        <option value="GENERAL_USER">สิทธิ์: บุคลากรทั่วไป (GENERAL_USER)</option>
                        <option value="RESPONSIBLE_STAFF">สิทธิ์: เจ้าหน้าที่ HR (RESPONSIBLE_STAFF)</option>
                      </select>
                    </div>

                    {bulkLoadingCandidates ? (
                      <TableLoadingSkeleton rows={5} cols={4} />
                    ) : (
                      <div className="overflow-x-auto max-h-80 border border-[#E8E4EF] rounded-xl">
                        <table className="his-table text-[13px]">
                          <thead>
                            <tr>
                              <th className="w-10 text-center">
                                <input
                                  type="checkbox"
                                  aria-label="เลือกทั้งหมดที่แสดง"
                                  checked={allFilteredSelected}
                                  onChange={() => {
                                    const slice = filteredCandidates.slice(0, 500);
                                    setBulkSelectedPersonIds((prev) => {
                                      const next = new Set(prev);
                                      if (allFilteredSelected) {
                                        slice.forEach((c) => next.delete(c.personId));
                                      } else {
                                        slice.forEach((c) => next.add(c.personId));
                                      }
                                      return next;
                                    });
                                  }}
                                  className="w-4 h-4 accent-[#8066B5] cursor-pointer"
                                />
                              </th>
                              <th>รหัส · ชื่อ-นามสกุล</th>
                              <th>หน่วยงาน · ประเภท</th>
                              <th>ชื่อบัญชีผู้ใช้ (แก้ไขได้)</th>
                              <th>สถานะ</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filteredCandidates.length === 0 ? (
                              <TableEmptyState
                                colSpan={5}
                                title="ไม่พบบุคลากรที่ยังไม่มีบัญชีผู้ใช้ตามตัวกรองที่เลือก"
                              />
                            ) : (
                              filteredCandidates.slice(0, 500).map((c) => {
                                const selected = bulkSelectedPersonIds.has(c.personId);
                                const editedUsername =
                                  bulkUsernameEdits[c.personId] ?? c.suggestedUsername;
                                const showConflict =
                                  c.usernameExists &&
                                  editedUsername.trim().toLowerCase() ===
                                    String(c.suggestedUsername).toLowerCase();
                                return (
                                  <tr
                                    key={c.personId}
                                    className={selected ? 'bg-[#F1ECFA]/40' : undefined}
                                  >
                                    <td className="text-center">
                                      <input
                                        type="checkbox"
                                        aria-label={`เลือก ${c.fullName}`}
                                        checked={selected}
                                        onChange={() => {
                                          setBulkSelectedPersonIds((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(c.personId)) next.delete(c.personId);
                                            else next.add(c.personId);
                                            return next;
                                          });
                                        }}
                                        className="w-4 h-4 accent-[#8066B5] cursor-pointer"
                                      />
                                    </td>
                                    <td>
                                      <div className="font-semibold text-[#292638]">{c.fullName}</div>
                                      <div className="font-mono text-[12px] text-[#777287]">
                                        {c.personId} · สแกน {c.fingleId || '—'}
                                      </div>
                                    </td>
                                    <td>
                                      <div className="text-[#292638]">{c.departmentName}</div>
                                      <div className="text-[12px] text-[#777287]">
                                        {c.personnelTypeName}
                                      </div>
                                    </td>
                                    <td>
                                      <input
                                        type="text"
                                        aria-label={`Username สำหรับ ${c.fullName}`}
                                        value={editedUsername}
                                        onChange={(e) =>
                                          setBulkUsernameEdits((prev) => ({
                                            ...prev,
                                            [c.personId]: e.target.value,
                                          }))
                                        }
                                        className="ent-input h-8 text-[12.5px] font-mono w-44"
                                      />
                                    </td>
                                    <td>
                                      {showConflict ? (
                                        <StatusBadge tone="warning" label="Username ซ้ำ (แก้ก่อนสร้าง)" compact />
                                      ) : (
                                        <StatusBadge tone="success" label="พร้อมสร้าง" compact />
                                      )}
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                )}

                <div className="flex flex-col-reverse sm:flex-row justify-between items-center gap-2.5 pt-3 border-t border-[#E8E4EF]">
                  <span className="text-[12.5px] text-[#777287] tabular-nums">
                    เลือกแล้ว <strong className="text-[#4E3978]">{bulkSelectedPersonIds.size}</strong>{' '}
                    รายการ (สูงสุด 500 รายการต่อครั้ง)
                  </span>
                  <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2.5 w-full sm:w-auto">
                    <button
                      type="button"
                      disabled={bulkCreating}
                      onClick={() => setBulkModalOpen(false)}
                      className="ent-btn-secondary w-full sm:w-auto"
                    >
                      ปิดหน้าต่าง
                    </button>
                    {!bulkResult && (
                      <button
                        type="button"
                        disabled={bulkCreating || bulkSelectedPersonIds.size === 0}
                        onClick={handleSubmitBulkCreate}
                        className="ent-btn-primary w-full sm:w-auto disabled:opacity-50"
                      >
                        {bulkCreating ? (
                          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                        ) : (
                          <Users className="w-4 h-4" aria-hidden="true" />
                        )}
                        <span>
                          {bulkCreating
                            ? 'กำลังสร้างบัญชี...'
                            : `ยืนยันสร้างบัญชี (${bulkSelectedPersonIds.size} บัญชี)`}
                        </span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })()}
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
                        <StatusBadge
                          tone={
                            log.result === 'SUCCESS'
                              ? 'success'
                              : log.result === 'BLOCKED' || log.result === 'PARTIAL_SUCCESS'
                                ? 'warning'
                                : 'danger'
                          }
                        >
                          {log.result === 'SUCCESS'
                            ? 'สำเร็จ'
                            : log.result === 'BLOCKED'
                              ? 'ถูกระงับ (BLOCKED)'
                              : log.result === 'DENIED'
                                ? 'ถูกปฏิเสธ (DENIED)'
                                : log.result}
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
                            <StatusBadge
                              tone={
                                log.result === 'SUCCESS'
                                  ? 'success'
                                  : log.result === 'BLOCKED' || log.result === 'PARTIAL_SUCCESS'
                                    ? 'warning'
                                    : 'danger'
                              }
                            >
                              {log.result === 'SUCCESS'
                                ? 'สำเร็จ'
                                : log.result === 'BLOCKED'
                                  ? 'ถูกระงับ (BLOCKED)'
                                  : log.result === 'DENIED'
                                    ? 'ถูกปฏิเสธ (DENIED)'
                                    : log.result}
                            </StatusBadge>
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => {
                                setCopiedAuditJson(false);
                                setSelectedAuditLog(log);
                              }}
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
          {selectedAuditLog && (() => {
            const rawJson = selectedAuditLog.detail_json || '{}';
            let formattedJson = rawJson;
            try {
              formattedJson = JSON.stringify(JSON.parse(rawJson), null, 2);
            } catch {
              formattedJson = rawJson;
            }
            return (
              <div className="space-y-4 text-[14px]">
                <div className="p-4 bg-[#F8F7FC] border border-[#E8E4EF] rounded-xl space-y-2 font-mono text-[13px]">
                  <div>รหัสคำขอ (Request ID): {selectedAuditLog.request_id}</div>
                  <div>เวลาที่เกิดเหตุการณ์: {formatThaiDateTime(selectedAuditLog.created_at)}</div>
                  <div>
                    ผู้ดำเนินการ: {selectedAuditLog.actor_username} ({selectedAuditLog.actor_role})
                  </div>
                  <div>
                    ผลลัพธ์: {selectedAuditLog.result}
                    {selectedAuditLog.error_code ? ` · ${selectedAuditLog.error_code}` : ''}
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="font-bold text-[#292638]">ข้อมูลรายละเอียด (JSON)</div>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard?.writeText(formattedJson);
                        setCopiedAuditJson(true);
                      }}
                      className="ent-btn-secondary h-8 px-2.5 text-[12px]"
                    >
                      {copiedAuditJson ? (
                        <Check className="w-3.5 h-3.5 text-[#198568]" aria-hidden="true" />
                      ) : (
                        <Copy className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                      )}
                      <span>{copiedAuditJson ? 'คัดลอกแล้ว' : 'คัดลอก JSON'}</span>
                    </button>
                  </div>
                  <pre className="p-4 bg-[#292638] text-[#F8F7FC] rounded-xl font-mono text-[12.5px] overflow-x-auto leading-relaxed">
                    {formattedJson}
                  </pre>
                </div>
              </div>
            );
          })()}
        </SlideOverDrawer>
      </div>
    );
  }

  // =========================================================================
  // โหมด 'deployment': หน้า "อัปเดตระบบ Sam_Att & อนุมัติ Database Migration"
  // =========================================================================
  const latestDeploy = deployStatus?.history?.[0] || null;
  const pendingMigrations: string[] = migrationInfo?.combinedPendingMigrations || [];
  const pendingMigrationDetails: any[] = migrationInfo?.pendingDetails || [];
  const appliedMigrations: any[] = migrationInfo?.appliedMigrations || [];
  const checksumMismatches: any[] = migrationInfo?.checksumMismatches || [];
  const targetCommitSha: string =
    migrationInfo?.git?.targetCommit || migrationInfo?.git?.currentCommit || 'unknown';
  const currentCommitSha: string = migrationInfo?.git?.currentCommit || 'unknown';
  const hasPendingMigrations = pendingMigrations.length > 0;
  const hasChecksumMismatch = checksumMismatches.length > 0;

  const pipelineDisplayLabel: Record<typeof deployPipelineStage, string> = {
    IDLE: 'พร้อมตรวจสอบและอัปเดตระบบ',
    CHECKING: 'กำลังตรวจสอบระบบและ GitHub...',
    AWAITING_MIGRATION_APPROVAL: 'พบ Database Migration ที่ต้องอนุมัติโดยผู้ดูแลระบบ',
    RUNNING: 'กำลังสำรองข้อมูล · อัปเดต Source Code · ติดตั้ง Dependencies · ทดสอบ/Build · รัน Migration · Restart Sam_Att...',
    SUCCESS: 'อัปเดตระบบและตรวจสอบหลังอัปเดตสำเร็จ',
    FAILED: 'การอัปเดตไม่สำเร็จ (ตรวจสอบรายละเอียด Console Output)',
    ACTION_REQUIRED: 'ต้องดำเนินการเพิ่มเติมโดยผู้ดูแลระบบ',
  };

  return (
    <div className="space-y-6">
      <PageHeader
        category="ระบบและผู้ดูแล"
        title="อัปเดตระบบ Sam_Att และอนุมัติ Database Migration"
        subtitle="ตรวจสอบโค้ดและ Migration จาก GitHub สำรองฐานข้อมูล MySQL นอก Git Repo ก่อนอัปเดต และรีสตาร์ทเฉพาะ Sam_Att บนพอร์ต 4101"
        actions={
          <>
            <PageHelpAction
              guideKey="deployment"
              userRole={userRole}
              onNavigate={onNavigate}
            />
            <button
              type="button"
              disabled={checkingUpdates || deployRunning}
              onClick={handleCheckDeploymentUpdates}
              className="ent-btn-secondary"
            >
              <RefreshCw
                className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{checkingUpdates ? 'กำลังตรวจสอบ...' : 'ตรวจสอบอัปเดตและ Migration'}</span>
            </button>
            <button
              type="button"
              disabled={deployRunning || Boolean(deployStatus?.inProgress) || hasChecksumMismatch}
              onClick={handleClickPrimaryUpdateButton}
              className="ent-btn-primary"
            >
              {hasPendingMigrations ? (
                <Lock className="w-4 h-4" aria-hidden="true" />
              ) : (
                <Rocket className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {deployRunning
                  ? 'กำลังอัปเดตระบบ...'
                  : hasPendingMigrations
                    ? `ตรวจสอบและอนุมัติ Migration (${pendingMigrations.length} ไฟล์)`
                    : 'อัปเดตระบบ'}
              </span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={loadData} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* Unified 4-Column System Status Strip */}
      <MetricStrip
        items={[
          {
            label: 'เวอร์ชันและ Commit ปัจจุบัน',
            value:
              currentCommitSha && currentCommitSha !== 'unknown'
                ? currentCommitSha.slice(0, 8)
                : deployStatus?.currentVersion || '2.0.0-standalone',
            subtext: `พอร์ต HTTPS ${deployStatus?.httpsPort || 4101} · ${deployStatus?.currentVersion || '2.0.0-standalone'}`,
            tone: 'primary',
          },
          {
            label: 'สถานะ Database Migration',
            value: hasChecksumMismatch
              ? 'Checksum ไม่ตรงกัน'
              : hasPendingMigrations
                ? `รออนุมัติ ${pendingMigrations.length} ไฟล์`
                : `อัปเดตครบ (${appliedMigrations.length} รุ่น)`,
            subtext: hasPendingMigrations
              ? 'ห้ามรันอัตโนมัติ ต้องอนุมัติด้วยรหัสผ่าน ADMIN'
              : 'ตรวจสอบ schema_migrations แล้ว',
            tone: hasChecksumMismatch ? 'danger' : hasPendingMigrations ? 'warning' : 'success',
          },
          {
            label: 'ผลการอัปเดตล่าสุด',
            value: latestDeploy
              ? latestDeploy.status === 'SUCCESS'
                ? 'สำเร็จ'
                : latestDeploy.status
              : 'พร้อมใช้งาน',
            subtext: `โดย: ${latestDeploy?.executed_by || 'ระบบเริ่มต้น'}`,
            tone: latestDeploy
              ? latestDeploy.status === 'SUCCESS'
                ? 'success'
                : 'danger'
              : 'success',
          },
          {
            label: 'นโยบายสำรองฐานข้อมูล',
            value: 'สำรองก่อน git pull',
            subtext: deployStatus?.backupRootPolicy || 'C:\\SamAttBackups (นอก Git Repo)',
            tone: 'info',
          },
        ]}
      />

      {/* Checksum Mismatch Critical Alert */}
      {hasChecksumMismatch && (
        <div className="p-4 sm:p-5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] space-y-2">
          <div className="flex items-center gap-2 font-bold text-[15px]">
            <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>ระงับการอัปเดตอัตโนมัติ: ตรวจพบไฟล์ Migration ที่เคยรันแล้วถูกแก้ไข (Checksum Mismatch)</span>
          </div>
          <ul className="list-disc pl-6 text-[13.5px] space-y-1 font-mono">
            {checksumMismatches.map((cm: any) => (
              <li key={cm.version}>
                {cm.filename} (recorded: {String(cm.recordedChecksum || '').slice(0, 12)} ≠ current:{' '}
                {String(cm.currentFileChecksum || '').slice(0, 12)})
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pending Migration Gate Card */}
      {hasPendingMigrations && !hasChecksumMismatch && (
        <div className="rounded-xl bg-[#FEF7EA]/55 border border-[#F2DCBA] p-5 sm:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-[#B87516] font-bold text-[15.5px]">
                <AlertTriangle className="w-5 h-5 shrink-0" aria-hidden="true" />
                <span>พบ Database Migration ที่ต้องได้รับการอนุมัติจากผู้ดูแลระบบ ({pendingMigrations.length} ไฟล์)</span>
              </div>
              <p className="text-[13.5px] text-[#5B556B]">
                ระบบล็อกไม่ให้รัน Migration อัตโนมัติ (MIGRATION_APPROVAL_REQUIRED) กรุณาตรวจสอบตารางและคอลัมน์ที่จะเปลี่ยนแปลงด้านล่าง
                ก่อนกดอนุมัติด้วยรหัสผ่านของบัญชีผู้ดูแลระบบ
              </p>
            </div>
            <button
              type="button"
              disabled={deployRunning}
              onClick={handleClickPrimaryUpdateButton}
              className="ent-btn-primary shrink-0"
            >
              <Lock className="w-4 h-4" aria-hidden="true" />
              <span>ตรวจสอบผลกระทบและอนุมัติ Migration</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 py-3.5 border-y border-[#F2DCBA] text-[13px]">
            <div className="space-y-0.5">
              <div className="text-[#777287] font-medium">Commit เป้าหมายที่จะอนุมัติ (Approval Binding)</div>
              <div className="font-mono font-bold text-[#292638] break-all">
                {currentCommitSha.slice(0, 10)} → {targetCommitSha.slice(0, 10)}
              </div>
            </div>
            <div className="space-y-0.5">
              <div className="text-[#777287] font-medium">การสำรองข้อมูลก่อนเริ่มเปลี่ยนแปลง</div>
              <div className="font-semibold text-[#292638]">
                สำรอง MySQL <span className="font-mono">samchuk_attendance_v2</span> + โค้ดเดิมไว้นอก Git Repo ก่อน git pull ทุกครั้ง
              </div>
            </div>
          </div>

          <div className="rounded-xl bg-white border border-[#E8E4EF] divide-y divide-[#E8E4EF] overflow-hidden">
            {pendingMigrations.map((fname) => {
              const detail = pendingMigrationDetails.find((d: any) => d.filename === fname);
              return (
                <div key={fname} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-mono font-bold text-[14px] text-[#4E3978]">{fname}</div>
                    <div className="flex items-center gap-2">
                      {detail?.partiallyApplied && (
                        <StatusBadge tone="warning">
                          พบคอลัมน์บางส่วนแล้ว ({detail.existingColumnsCount}/{detail.columnsAdded?.length || 0})
                        </StatusBadge>
                      )}
                      <StatusBadge tone="primary">รออนุมัติ (Pending)</StatusBadge>
                    </div>
                  </div>
                  {detail ? (
                    <div className="text-[13px] text-[#5B556B] space-y-1.5">
                      <div>
                        <strong className="text-[#292638]">ผลกระทบโครงสร้าง:</strong> {detail.summaryText}
                      </div>
                      {detail.affectedTables?.length > 0 && (
                        <div>
                          <strong className="text-[#292638]">ตารางที่เกี่ยวข้อง:</strong>{' '}
                          <span className="font-mono">{detail.affectedTables.join(', ')}</span>
                        </div>
                      )}
                      {detail.columnsAdded?.length > 0 && (
                        <div className="pt-1">
                          <div className="font-semibold text-[#292638] mb-1">
                            คอลัมน์ที่จะเพิ่ม ({detail.columnsAdded.length} คอลัมน์):
                          </div>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 font-mono text-[12px]">
                            {detail.columnsAdded.map((c: any) => (
                              <div
                                key={`${c.table}.${c.column}`}
                                className="px-2.5 py-1 rounded bg-[#F8F7FC] text-[#292638]"
                              >
                                {c.table}.{c.column} ({c.expectedType})
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {detail.schemaConflicts?.length > 0 && (
                        <div className="p-2.5 rounded-lg bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] font-medium">
                          คำเตือนโครงสร้างไม่ตรงกัน: {detail.schemaConflicts.join(' | ')}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-[13px] text-[#777287]">
                      ไฟล์ Migration ใหม่จาก GitHub Commit เป้าหมาย — ระบบจะตรวจสอบโครงสร้างและรันหลังสำรองฐานข้อมูลเสร็จสมบูรณ์
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Real Pipeline Status & Post-Deploy Summary */}
      <div className="his-surface p-5 sm:p-6 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="space-y-1">
            <div className="text-[12.5px] font-semibold text-[#8066B5]">
              ขั้นตอนการทำงานจริงของระบบอัปเดต (Safe Deployment Pipeline)
            </div>
            <h2 className="text-[16.5px] font-bold text-[#292638]">
              {pipelineDisplayLabel[deployPipelineStage]}
            </h2>
          </div>
          <StatusBadge
            tone={
              deployPipelineStage === 'SUCCESS'
                ? 'success'
                : deployPipelineStage === 'FAILED' || deployPipelineStage === 'ACTION_REQUIRED'
                  ? 'danger'
                  : deployPipelineStage === 'AWAITING_MIGRATION_APPROVAL' ||
                      deployPipelineStage === 'RUNNING' ||
                      deployPipelineStage === 'CHECKING'
                    ? 'warning'
                    : 'primary'
            }
          >
            {deployPipelineStage === 'SUCCESS'
              ? 'สำเร็จ'
              : deployPipelineStage === 'FAILED'
                ? 'ล้มเหลว'
                : deployPipelineStage === 'ACTION_REQUIRED'
                  ? 'ต้องดำเนินการเพิ่มเติม'
                  : deployPipelineStage === 'AWAITING_MIGRATION_APPROVAL'
                    ? 'รออนุมัติ Migration'
                    : deployPipelineStage === 'RUNNING'
                      ? 'กำลังดำเนินการ'
                      : 'พร้อมใช้งาน'}
          </StatusBadge>
        </div>

        <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 text-[12.5px]">
          {[
            '1. ตรวจสอบระบบ & GitHub',
            '2. อนุมัติ Migration (หากมี)',
            '3. สำรอง MySQL นอก Git Repo',
            '4. git pull · ติดตั้ง · ทดสอบ · Build',
            '5. รัน Migration · Restart Sam_Att · Health Check',
          ].map((label) => (
            <li
              key={label}
              className="px-3 py-2.5 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF] text-[#292638] font-medium"
            >
              {label}
            </li>
          ))}
        </ol>

        {lastDeployMeta?.requiresAdminDatabaseRestore && (
          <div className="p-4 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] space-y-1.5 text-[13.5px]">
            <div className="font-bold flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span>ต้องดำเนินการเพิ่มเติมโดยผู้ดูแลระบบ: ห้ามลดระดับ Schema อัตโนมัติ</span>
            </div>
            <p>
              ระบบได้ย้อนซอร์สโค้ดกลับรุ่นเดิมแล้ว แต่เนื่องจากมีการเริ่มหรือรัน Database Migration ไปแล้ว
              กรุณาตรวจสอบสถานะฐานข้อมูลและใช้ไฟล์สำรองด้านล่างกู้คืนผ่าน{' '}
              <code className="font-mono">scripts\restore-test.ps1</code> หากโครงสร้างไม่เข้ากัน
            </p>
            {lastDeployMeta.backupSqlPath && (
              <div className="font-mono text-[12.5px]">
                ไฟล์สำรองฐานข้อมูล: {lastDeployMeta.backupSqlPath}
              </div>
            )}
          </div>
        )}

        {lastDeployMeta && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-[13px] pt-4 border-t border-[#E8E4EF]">
            <div className="space-y-0.5">
              <div className="text-[#777287]">Exit Code จริงจากสคริปต์</div>
              <div
                className={`font-mono font-bold ${
                  lastDeployMeta.exitCode === 0 ? 'text-[#198568]' : 'text-[#C74455]'
                }`}
              >
                {lastDeployMeta.exitCode}
              </div>
            </div>
            <div className="space-y-0.5 sm:border-l sm:border-[#E8E4EF] sm:pl-4">
              <div className="text-[#777287]">โฟลเดอร์สำรองข้อมูล (นอก Git Repo)</div>
              <div className="font-mono text-[12px] font-semibold text-[#292638] break-all">
                {lastDeployMeta.backupDir || 'ยังไม่ได้สร้างในรอบนี้'}
              </div>
            </div>
            <div className="space-y-0.5 sm:border-l sm:border-[#E8E4EF] sm:pl-4">
              <div className="text-[#777287]">Migration ที่รันในรอบนี้</div>
              <div className="font-mono text-[12px] font-semibold text-[#292638]">
                {lastDeployMeta.migrationsApplied?.length
                  ? lastDeployMeta.migrationsApplied.join(', ')
                  : 'ไม่มี'}
              </div>
            </div>
          </div>
        )}

        {(lastDeployOutput || latestDeploy?.rollback_note) && (
          <div className="space-y-2 pt-3 border-t border-[#E8E4EF]">
            <div className="flex items-center gap-2 text-[14px] font-bold text-[#292638]">
              <Terminal className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>ผลการอัปเดตล่าสุด (Console Output)</span>
            </div>
            <pre className="p-4 rounded-xl bg-[#292638] text-[#F8F7FC] font-mono text-[12.5px] overflow-x-auto leading-relaxed max-h-72">
              {lastDeployOutput || latestDeploy?.rollback_note}
            </pre>
          </div>
        )}
      </div>

      {/* Applied Migrations History (schema_migrations) */}
      <div className="his-surface overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC] flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
            <h3 className="text-[15.5px] font-bold text-[#292638]">
              ประวัติ Database Migration ที่ติดตั้งแล้ว (schema_migrations: {appliedMigrations.length} รายการ)
            </h3>
          </div>
          {migrationInfo?.schemaVerification && (
            <StatusBadge tone={migrationInfo.schemaVerification.ok ? 'success' : 'danger'}>
              {migrationInfo.schemaVerification.ok
                ? 'โครงสร้างตารางและคอลัมน์ตรงตาม Schema'
                : `พบข้อผิดพลาด Schema (${migrationInfo.schemaVerification.errors?.length || 0})`}
            </StatusBadge>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="his-table">
            <thead>
              <tr>
                <th>เวอร์ชัน</th>
                <th>ชื่อไฟล์ Migration</th>
                <th>SHA-256 Checksum</th>
                <th>เวลาที่ติดตั้ง</th>
              </tr>
            </thead>
            <tbody>
              {appliedMigrations.length === 0 ? (
                <TableEmptyState
                  colSpan={4}
                  title="ไม่พบประวัติ schema_migrations"
                  description="กดปุ่มตรวจสอบอัปเดตและ Migration เพื่อตรวจสอบสถานะล่าสุด"
                />
              ) : (
                appliedMigrations.map((m: any) => (
                  <tr key={`${m.version}-${m.filename}`}>
                    <td className="font-mono font-bold text-[#4E3978]">{m.version}</td>
                    <td className="font-mono text-[#292638]">{m.filename}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[12px] text-[#777287]">
                          {String(m.checksum || '').slice(0, 14)}
                        </span>
                        <StatusBadge tone={m.checksumMatch ? 'success' : 'danger'}>
                          {m.checksumMatch ? 'ตรงกัน' : 'ไม่ตรงกัน'}
                        </StatusBadge>
                      </div>
                    </td>
                    <td className="font-mono text-[#777287] tabular-nums">
                      {m.appliedAt ? formatThaiDateTime(m.appliedAt) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ประวัติการอัปเดตย้อนหลัง */}
      <div className="his-surface overflow-hidden">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC]">
          <h3 className="text-[15.5px] font-bold text-[#292638]">
            ประวัติการอัปเดตระบบ ({deployStatus?.history?.length || 0} รายการล่าสุด)
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="his-table">
            <thead>
              <tr>
                <th>ครั้งที่ · เวอร์ชัน · Commit</th>
                <th>วันที่และเวลา</th>
                <th>ผู้สั่งอัปเดต</th>
                <th>Backup Path</th>
                <th>สถานะ</th>
              </tr>
            </thead>
            <tbody>
              {!deployStatus?.history || deployStatus.history.length === 0 ? (
                <TableEmptyState
                  colSpan={5}
                  title="ยังไม่มีประวัติการอัปเดตระบบ"
                  description="เมื่อกดปุ่มอัปเดตระบบ ประวัติและผลการอัปเดตจะแสดงที่นี่"
                />
              ) : (
                deployStatus.history.map((h: any) => (
                  <tr key={h.id}>
                    <td className="font-mono font-bold text-[#292638]">
                      #{h.id} · {h.release_version}{' '}
                      {h.commit_sha ? (
                        <span className="text-[12px] text-[#777287]">
                          ({String(h.commit_sha).slice(0, 8)})
                        </span>
                      ) : null}
                    </td>
                    <td className="font-mono text-[#777287] tabular-nums">
                      {h.executed_at ? formatThaiDateTime(h.executed_at) : '—'}
                    </td>
                    <td className="font-mono text-[#292638]">{h.executed_by}</td>
                    <td className="font-mono text-[12px] text-[#777287] max-w-[240px] truncate">
                      {h.backup_archive_path || '—'}
                    </td>
                    <td>
                      <StatusBadge tone={h.status === 'SUCCESS' ? 'success' : 'danger'}>
                        {h.status === 'SUCCESS' ? 'สำเร็จ' : h.status}
                      </StatusBadge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ConfirmDialog ก่อนอัปเดตระบบ (กรณีไม่มี Migration ค้างอยู่) */}
      <ConfirmDialog
        open={confirmDeployOpen}
        title="ยืนยันการอัปเดตระบบ Sam_Att"
        description="ระบบจะสำรองฐานข้อมูล MySQL samchuk_attendance_v2 และไฟล์ระบบไว้นอก Git Repo ก่อนดึงโค้ดล่าสุด ทดสอบ Build และรีสตาร์ทเฉพาะ Sam_Att"
        confirmLabel="ยืนยันอัปเดตระบบทันที"
        loading={deployRunning}
        onConfirm={() => handleExecuteOneButtonUpdate()}
        onCancel={() => setConfirmDeployOpen(false)}
      >
        <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 text-[13.5px] text-[#292638]">
          <div className="font-bold text-[#4E3978]">ขั้นตอนความปลอดภัยที่ระบบจะดำเนินการตามลำดับ:</div>
          <ul className="list-disc pl-5 space-y-1 text-[#777287]">
            <li>ตรวจสอบความพร้อมของระบบและยืนยันว่าไม่มี Database Migration ค้างรออนุมัติ</li>
            <li>สำรองฐานข้อมูล MySQL samchuk_attendance_v2 และไฟล์ระบบไว้นอก Git Repo ก่อน git pull</li>
            <li>ติดตั้ง Dependencies · Typecheck · Automated Tests · Build</li>
            <li>รีสตาร์ทเฉพาะเซอร์วิส Sam_Att บนพอร์ต 4101 โดยไม่กระทบ Procurement และไม่รัน iisreset</li>
          </ul>
        </div>
      </ConfirmDialog>

      {/* Migration Approval Modal (บังคับตรวจสอบผลกระทบ + ยืนยันรหัสผ่านบัญชี ADMIN จริง + ผูก Commit & รายการไฟล์) */}
      <SharedModal
        open={migrationApprovalOpen}
        onClose={() => {
          if (!deployRunning) {
            setMigrationConfirmPassword('');
            setMigrationApprovalOpen(false);
          }
        }}
        kickerText="การอนุมัติเปลี่ยนโครงสร้างฐานข้อมูล (ADMIN ONLY)"
        title="ตรวจสอบผลกระทบและอนุมัติ Database Migration"
        subtitle="การอนุมัตินี้จะถูกผูกไว้กับ Target Commit และรายการไฟล์ Migration ด้านล่างเท่านั้น หากมีไฟล์อื่นเพิ่มเข้ามา ระบบจะปฏิเสธโดยอัตโนมัติ"
        maxWidthClass="max-w-2xl"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!migrationImpactAck) {
              setMigrationApprovalError(
                'กรุณาทำเครื่องหมายยืนยันว่าได้รับทราบผลกระทบของการเปลี่ยนแปลงโครงสร้างฐานข้อมูล'
              );
              return;
            }
            if (!migrationConfirmPassword) {
              setMigrationApprovalError('กรุณากรอกรหัสผ่านของบัญชีผู้ดูแลระบบปัจจุบันเพื่อยืนยันตัวตน');
              return;
            }
            handleExecuteOneButtonUpdate({
              approveMigrations: true,
              approvedTargetCommit: targetCommitSha,
              approvedMigrationFiles: pendingMigrations,
              impactAcknowledged: true,
              confirmPassword: migrationConfirmPassword,
            });
          }}
          className="space-y-4"
        >
          {migrationApprovalError && (
            <div className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13.5px] font-medium">
              {migrationApprovalError}
            </div>
          )}

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 text-[13px]">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-[#777287]">Target Commit ที่อนุมัติ:</span>
              <span className="font-mono font-bold text-[#292638]">{targetCommitSha}</span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-[#777287]">ฐานข้อมูลเป้าหมาย:</span>
              <span className="font-mono font-bold text-[#292638]">
                {migrationInfo?.backupPolicy?.databaseTarget || 'samchuk_attendance_v2'}
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-[#777287]">การสำรองข้อมูลก่อนเริ่ม:</span>
              <span className="font-semibold text-[#1F7A4D]">
                บังคับสำรอง MySQL นอก Git Repo ก่อน git pull และก่อนรัน Migration
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-[#777287]">Migration ที่เคยติดตั้งแล้ว:</span>
              <span className="font-mono text-[#292638]">
                {appliedMigrations.map((m: any) => m.version).join(', ') || '—'}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[13.5px] font-bold text-[#292638]">
              รายการไฟล์ Migration ที่จะอนุมัติ ({pendingMigrations.length} ไฟล์):
            </div>
            <div className="max-h-48 overflow-y-auto space-y-2 pr-1">
              {pendingMigrations.map((fname) => {
                const detail = pendingMigrationDetails.find((d: any) => d.filename === fname);
                return (
                  <div key={fname} className="p-3 rounded-lg bg-white border border-[#E8E4EF] text-[12.5px] space-y-1">
                    <div className="font-mono font-bold text-[#4E3978]">{fname}</div>
                    {detail && (
                      <>
                        <div className="text-[#5B556B]">{detail.summaryText}</div>
                        {detail.columnsAdded?.length > 0 && (
                          <div className="font-mono text-[11.5px] text-[#777287]">
                            คอลัมน์: {detail.columnsAdded.map((c: any) => `${c.table}.${c.column}`).join(', ')}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-[#FFFBEB] border border-[#FCD34D] text-[#92400E] text-[13px] space-y-1">
            <div className="font-bold">คำเตือนด้านความปลอดภัยของฐานข้อมูล:</div>
            <p>
              ระบบจะไม่ลบข้อมูลเดิมหรือรัน DROP/TRUNCATE และจะไม่ลดระดับ Schema อัตโนมัติหากเกิดข้อผิดพลาดหลังเริ่ม Migration
              (ผู้ดูแลระบบสามารถใช้ไฟล์สำรอง MySQL กู้คืนผ่านสคริปต์ restore-test.ps1 ได้)
            </p>
          </div>

          <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] cursor-pointer">
            <input
              type="checkbox"
              checked={migrationImpactAck}
              onChange={(e) => setMigrationImpactAck(e.target.checked)}
              className="mt-1 h-4 w-4 accent-[#7C5CBF]"
            />
            <span className="text-[13.5px] text-[#292638]">
              ข้าพเจ้าได้ตรวจสอบรายการไฟล์ Migration ตาราง และคอลัมน์ที่จะเปลี่ยนแปลงแล้ว
              และยืนยันให้ระบบสำรองข้อมูลก่อนอัปเดตและรัน Migration ตามรายการข้างต้น
            </span>
          </label>

          <div>
            <label className="ent-label">
              รหัสผ่านของบัญชีผู้ดูแลระบบปัจจุบัน (ADMIN Re-authentication) <RequiredMark />
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={migrationConfirmPassword}
              onChange={(e) => setMigrationConfirmPassword(e.target.value)}
              placeholder="กรอกรหัสผ่านบัญชีที่กำลังเข้าสู่ระบบ"
              className="ent-input w-full"
            />
          </div>

          <div className="flex flex-col sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
            <button
              type="button"
              disabled={deployRunning}
              onClick={() => {
                setMigrationConfirmPassword('');
                setMigrationApprovalOpen(false);
              }}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={deployRunning || !migrationImpactAck || !migrationConfirmPassword}
              className="ent-btn-primary w-full sm:w-auto"
            >
              <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
              <span>{deployRunning ? 'กำลังดำเนินการ...' : 'อนุมัติ Migration และเริ่มอัปเดตระบบ'}</span>
            </button>
          </div>
        </form>
      </SharedModal>

      {/* ProgressDialog แสดงความคืบหน้าจริงขณะอัปเดต (ไม่จำลอง 100% ก่อน Backend ยืนยัน) */}
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
            <pre className="p-3 rounded-lg bg-[#292638] text-[#F8F7FC] font-mono text-[11.5px] overflow-x-auto max-h-48">
              {lastDeployOutput}
            </pre>
          ) : undefined
        }
      />
    </div>
  );
}
