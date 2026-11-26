/**
 * ============================================================================
 * ศูนย์อัปเดตระบบจาก GitHub (GitHub Update Center & Safe Deployment Console)
 * ไฟล์: frontend/src/components/deployment/GitHubUpdateCenter.tsx
 * ============================================================================
 * แสดงผลเฉพาะผู้ดูแลระบบ (ADMIN Only):
 *   A. สถานะเวอร์ชันและเปรียบเทียบ Commit กับ GitHub จริง (Read-Only)
 *   B. รายละเอียดการเปลี่ยนแปลงภาษาไทยแบบ Evidence-Based (6 หมวดหมู่ + ประวัติ Commit)
 *   C. ตรวจสอบความพร้อมก่อนอัปเดต (Readiness Checklist & Migration Gate)
 *   D. ดำเนินการอัปเดตอย่างปลอดภัย + วิเคราะห์ข้อผิดพลาด + นโยบาย Rollback แยกโค้ด/ฐานข้อมูล
 *   E. ประวัติการอัปเดตระบบและประวัติ Database Migration พร้อมดู Log ที่ปกปิดข้อมูลลับแล้ว
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Database,
  ExternalLink,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Info,
  Lock,
  PanelRightOpen,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  XCircle,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../../services/api.ts';
import { ErrorBanner } from '../StatusText.tsx';
import {
  ConfirmDialog,
  NotificationBanner,
  PageHeader,
  ProgressDialog,
  RequiredMark,
  SharedModal,
  SlideOverDrawer,
  StatusBadge,
  TableEmptyState,
  TablePaginationBar,
  type PageSizeOption,
} from '../common/SharedComponents.tsx';
import { useToast } from '../common/ToastContext.tsx';
import { PageHelpAction } from '../common/ContextualHelp.tsx';
import type { NavViewKey } from '../layout/Sidebar.tsx';
import { formatThaiDateTime } from '../../utils/thaiFormat.ts';

interface DeploymentDiagnostics {
  failedStep: string;
  errorCode: string;
  detectedCause: string;
  remediationSteps: string[];
  exitCode: number;
  rolledBack: boolean;
  requiresAdminDatabaseRestore: boolean;
}

interface ReadinessItem {
  id: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  blocking: boolean;
  detail: string;
}

interface ChangelogItem {
  text: string;
  originalText: string;
  category: string;
  commitSha?: string | null;
  releaseTag?: string | null;
  date?: string | null;
  author?: string | null;
}

interface ChangelogCategory {
  key: string;
  labelThai: string;
  items: ChangelogItem[];
}

export function GitHubUpdateCenter({
  userRole,
  onNavigate,
  onUpdateBadgeChange,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
  onUpdateBadgeChange?: (hasUpdate: boolean) => void;
}) {
  const toast = useToast();
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [deployStatus, setDeployStatus] = useState<any>(null);
  const [updateReport, setUpdateReport] = useState<any>(null);

  // Changelog UI expansion state
  const [showOriginalCommitList, setShowOriginalCommitList] = useState(false);
  const [showAppliedMigrations, setShowAppliedMigrations] = useState(false);
  const [selectedHistoryRow, setSelectedHistoryRow] = useState<any | null>(null);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPageSize, setHistoryPageSize] = useState<PageSizeOption>(10);

  // Safe Update Execution & Migration Approval Modal state
  const [confirmDeployOpen, setConfirmDeployOpen] = useState(false);
  const [migrationApprovalOpen, setMigrationApprovalOpen] = useState(false);
  const [migrationImpactAck, setMigrationImpactAck] = useState(false);
  const [migrationConfirmPassword, setMigrationConfirmPassword] = useState('');
  const [migrationApprovalError, setMigrationApprovalError] = useState<string | null>(null);

  const [deployProgressOpen, setDeployProgressOpen] = useState(false);
  const [deployRunning, setDeployRunning] = useState(false);
  const [deployStepLabel, setDeployStepLabel] = useState('เตรียมความพร้อมก่อนอัปเดตระบบ...');
  const [deployPercent, setDeployPercent] = useState<number | null>(null);
  const [deployResultState, setDeployResultState] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>(
    'RUNNING'
  );
  const [deploySummaryText, setDeploySummaryText] = useState<string | null>(null);
  const [deployErrorText, setDeployErrorText] = useState<string | null>(null);
  const [lastDeployOutput, setLastDeployOutput] = useState<string | null>(null);
  const [lastDiagnostics, setLastDiagnostics] = useState<DeploymentDiagnostics | null>(null);
  const [lastDeployMeta, setLastDeployMeta] = useState<{
    exitCode?: number;
    backupDir?: string | null;
    backupSqlPath?: string | null;
    commitBefore?: string | null;
    commitAfter?: string | null;
    migrationsApplied?: string[];
    requiresAdminDatabaseRestore?: boolean;
  } | null>(null);

  const onUpdateBadgeChangeRef = useRef(onUpdateBadgeChange);
  useEffect(() => {
    onUpdateBadgeChangeRef.current = onUpdateBadgeChange;
  }, [onUpdateBadgeChange]);

  const toastRef = useRef(toast);
  useEffect(() => {
    toastRef.current = toast;
  }, [toast]);

  const mountedRef = useRef(true);
  const activeControllerRef = useRef<AbortController | null>(null);
  const inFlightCheckRef = useRef<Promise<void> | null>(null);
  const inFlightForceRef = useRef(false);
  const requestSeqRef = useRef(0);

  const refreshStatusAndCheck = useCallback(
    async (opts?: { showToast?: boolean; force?: boolean }) => {
      const force = Boolean(opts?.force);
      if (inFlightCheckRef.current) {
        if (!force || inFlightForceRef.current) {
          return inFlightCheckRef.current;
        }
        activeControllerRef.current?.abort();
      }

      const seq = ++requestSeqRef.current;
      const controller = new AbortController();
      activeControllerRef.current = controller;
      inFlightForceRef.current = force;

      setCheckingUpdates(true);
      setError(null);
      if (opts?.showToast) {
        setNotice(null);
      }

      let task!: Promise<void>;
      task = (async () => {
        try {
          const checkEndpoint = force
            ? '/deployment/check-updates?force=true'
            : '/deployment/check-updates';

          const [statusRes, checkRes] = await Promise.all([
            apiRequest('/deployment/status', { signal: controller.signal }),
            apiRequest(checkEndpoint, {
              method: 'POST',
              body: JSON.stringify({ force }),
              signal: controller.signal,
            }),
          ]);

          if (controller.signal.aborted || !mountedRef.current || seq !== requestSeqRef.current) {
            return;
          }

          setDeployStatus(statusRes);
          setUpdateReport(checkRes);

          const isUpdateAvail =
            Boolean(checkRes?.hasUpdates) || checkRes?.versionStatus === 'UPDATE_AVAILABLE';
          onUpdateBadgeChangeRef.current?.(isUpdateAvail);

          if (opts?.showToast) {
            const currentToast = toastRef.current;
            if (checkRes?.versionStatus === 'GITHUB_UNREACHABLE' || checkRes?.githubReachable === false) {
              currentToast.warning(
                'ไม่สามารถตรวจสอบ GitHub ได้',
                checkRes?.githubError ||
                  checkRes?.statusDescriptionThai ||
                  'กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตของเซิร์ฟเวอร์'
              );
            } else if (checkRes?.checksumMismatches?.length > 0) {
              currentToast.error(
                'พบ Checksum ของ Migration ไม่ตรงกัน',
                'ระบบระงับการอัปเดตเพื่อความปลอดภัย กรุณาตรวจสอบรายละเอียด'
              );
            } else if (checkRes?.migrationApprovalRequired) {
              const msg = `ตรวจพบ Database Migration รออนุมัติ (${(checkRes.pendingMigrations || []).join(', ')})`;
              setNotice(msg);
              currentToast.warning('พบ Database Migration รออนุมัติ', msg);
            } else if (isUpdateAvail) {
              const msg = checkRes?.statusLabelThai || 'พบอัปเดตใหม่บน GitHub';
              setNotice(msg);
              currentToast.info('พบเวอร์ชันใหม่บน GitHub', checkRes?.statusDescriptionThai || msg);
            } else if (checkRes?.versionStatus === 'UP_TO_DATE' || checkRes?.status === 'UP_TO_DATE') {
              setNotice('ระบบเป็นเวอร์ชันล่าสุดตรงกับ GitHub แล้ว');
              currentToast.success('ตรวจสอบเวอร์ชันแล้ว', 'ระบบเป็นเวอร์ชันล่าสุดแล้ว');
            } else {
              setNotice(checkRes?.statusDescriptionThai || 'ตรวจสอบสถานะระบบเรียบร้อยแล้ว');
              currentToast.info('ตรวจสอบเวอร์ชันแล้ว', checkRes?.statusLabelThai || 'ตรวจสอบเรียบร้อยแล้ว');
            }
          }
        } catch (err) {
          if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
            return;
          }
          if (!mountedRef.current || seq !== requestSeqRef.current) {
            return;
          }
          if (err instanceof ApiClientError) {
            setError({ code: err.code, message: err.message });
          } else {
            setError({ message: 'ไม่สามารถโหลดข้อมูลศูนย์อัปเดตระบบได้' });
          }
        } finally {
          if (inFlightCheckRef.current === task) {
            inFlightCheckRef.current = null;
            inFlightForceRef.current = false;
          }
          if (activeControllerRef.current === controller) {
            activeControllerRef.current = null;
          }
          if (mountedRef.current && seq === requestSeqRef.current) {
            setCheckingUpdates(false);
            setLoadingInitial(false);
          }
        }
      })();

      inFlightCheckRef.current = task;
      return task;
    },
    []
  );

  useEffect(() => {
    mountedRef.current = true;
    void refreshStatusAndCheck({ showToast: false, force: false });
    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      inFlightCheckRef.current = null;
      inFlightForceRef.current = false;
    };
  }, [refreshStatusAndCheck]);

  // Derived real values from backend response
  const github = updateReport?.github || null;
  const changelog = updateReport?.changelog || null;
  const readiness = updateReport?.readiness || null;
  const versionStatus: string = updateReport?.versionStatus || 'DIVERGED_OR_UNKNOWN';
  const releaseAvailability: string = updateReport?.releaseAvailability || 'NONE';

  const pendingMigrations: string[] = updateReport?.pendingMigrations || [];
  const pendingMigrationDetails: any[] = updateReport?.pendingMigrationDetails || [];
  const appliedMigrations: any[] = updateReport?.appliedMigrations || [];
  const checksumMismatches: any[] = updateReport?.checksumMismatches || [];
  const hasPendingMigrations = pendingMigrations.length > 0;
  const hasChecksumMismatch = checksumMismatches.length > 0;

  const installedVersion: string =
    github?.installed?.version || deployStatus?.packageVersion || '2.0.0';
  const currentCommitSha: string =
    updateReport?.currentCommit || github?.installed?.commitSha || 'unknown';
  const targetCommitSha: string =
    updateReport?.targetCommit || github?.remote?.targetCommitSha || 'unknown';
  const latestReleaseTag: string | null = github?.remote?.latestReleaseTag || null;
  const checkedAt: string | null = updateReport?.checkedAt || null;
  const repoFullName: string =
    github?.repository?.fullName ||
    deployStatus?.repository?.fullName ||
    'jk9krnvb6g-ai/Sam_Att-V2-Standalone';
  const repoBranch: string =
    github?.repository?.branch || deployStatus?.repository?.branch || 'main';
  const repoHtmlUrl: string =
    github?.repository?.htmlUrl || `https://github.com/${repoFullName}`;

  const readinessChecks: ReadinessItem[] = readiness?.checks || [];
  const blockingReasons: string[] = readiness?.blockingReasons || [];
  const canExecuteUpdate =
    Boolean(readiness?.canExecuteUpdate) &&
    !deployRunning &&
    !Boolean(deployStatus?.inProgress) &&
    !hasChecksumMismatch;

  const historyItems: any[] = deployStatus?.history || [];
  const pagedHistory = useMemo(() => {
    if (historyPageSize === 'ALL') return historyItems;
    const start = (historyPage - 1) * historyPageSize;
    return historyItems.slice(start, start + historyPageSize);
  }, [historyItems, historyPage, historyPageSize]);

  function handleClickPrimaryUpdateButton() {
    if (!canExecuteUpdate) {
      return;
    }
    if (hasChecksumMismatch) {
      setError({
        code: 'MIGRATION_CHECKSUM_MISMATCH',
        message: 'ไม่สามารถอัปเดตได้เนื่องจากพบ Checksum ของไฟล์ Migration เดิมไม่ตรงกับฐานข้อมูล',
      });
      return;
    }
    if (hasPendingMigrations) {
      setMigrationImpactAck(false);
      setMigrationConfirmPassword('');
      setMigrationApprovalError(null);
      setMigrationApprovalOpen(true);
      return;
    }
    setConfirmDeployOpen(true);
  }

  async function handleExecuteSafeUpdate(approvalPayload?: {
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
    setDeployProgressOpen(true);
    setDeployResultState('RUNNING');
    setDeployStepLabel(
      approvalPayload
        ? 'กำลังสำรองฐานข้อมูล MySQL นอก Git Repo · อัปเดตโค้ด · Build · รัน Migration ที่อนุมัติ · ตรวจ Health Check...'
        : 'กำลังสำรองฐานข้อมูล MySQL นอก Git Repo · อัปเดตโค้ด · Build · ตรวจ Health Check...'
    );
    setDeployPercent(null);
    setDeploySummaryText(null);
    setDeployErrorText(null);
    setLastDiagnostics(null);
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
      setDeployStepLabel('อัปเดตระบบ Sam_Att และตรวจสอบหลังอัปเดตสำเร็จ');
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
      await refreshStatusAndCheck({ showToast: false });
    } catch (err) {
      if (approvalPayload) {
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
          setMigrationApprovalError(err.message);
          return;
        }

        if (err.code === 'MIGRATION_APPROVAL_REQUIRED') {
          setDeployProgressOpen(false);
          if (d.pendingMigrations) {
            setUpdateReport((prev: any) => ({
              ...(prev || {}),
              pendingMigrations: d.pendingMigrations,
              pendingMigrationDetails: d.pendingMigrationDetails || prev?.pendingMigrationDetails || [],
              appliedMigrations: d.appliedMigrations || prev?.appliedMigrations || [],
              currentCommit: d.currentCommit || prev?.currentCommit,
              targetCommit: d.targetCommit || prev?.targetCommit,
              migrationApprovalRequired: true,
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
        setDeployStepLabel(
          d.diagnostics?.failedStep ||
            (needsDbRestore
              ? 'ต้องดำเนินการเพิ่มเติม — โปรดตรวจสอบและกู้คืนฐานข้อมูลหากจำเป็น'
              : `การอัปเดตระบบไม่สำเร็จ${typeof d.exitCode === 'number' ? ` (Exit Code: ${d.exitCode})` : ''}`)
        );
        setDeployErrorText(err.message);
        if (d.diagnostics) {
          setLastDiagnostics(d.diagnostics);
        }
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
        setDeployStepLabel('การอัปเดตระบบไม่สำเร็จ');
        const msg = 'เกิดข้อผิดพลาดระหว่างรันสคริปต์อัปเดตระบบ';
        setDeployErrorText(msg);
        setError({ message: msg });
      }

      try {
        const statusRes = await apiRequest('/deployment/status');
        setDeployStatus(statusRes);
      } catch {
        // Keep last loaded status
      }
    } finally {
      setDeployRunning(false);
    }
  }

  function getStatusTone(st: string): 'success' | 'primary' | 'warning' | 'danger' {
    if (st === 'UP_TO_DATE') return 'success';
    if (st === 'UPDATE_AVAILABLE') return 'primary';
    if (st === 'GITHUB_UNREACHABLE') return 'danger';
    return 'warning';
  }

  function getCategoryTone(catKey: string): 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
    switch (catKey) {
      case 'features':
        return 'primary';
      case 'fixes':
        return 'info';
      case 'security':
        return 'warning';
      case 'database':
        return 'warning';
      case 'breaking':
        return 'danger';
      default:
        return 'neutral';
    }
  }

  const rawCategories = changelog?.categories;
  const changelogCategories: ChangelogCategory[] = Array.isArray(rawCategories)
    ? rawCategories
    : rawCategories && typeof rawCategories === 'object'
      ? Object.entries(rawCategories)
          .filter(([, items]) => Array.isArray(items) && items.length > 0)
          .map(([key, items]) => ({
            key,
            labelThai: key,
            items: items as any[],
          }))
      : [];
  const changelogCommits: any[] = Array.isArray(changelog?.commits) ? changelog.commits : [];
  const changelogReleases: any[] = Array.isArray(changelog?.releasesIncluded)
    ? changelog.releasesIncluded
    : [];

  return (
    <div className="space-y-6">
      <PageHeader
        category="ระบบและผู้ดูแล"
        title="ศูนย์อัปเดตระบบ (GitHub Update Center)"
        subtitle={`ตรวจสอบเวอร์ชันและรายละเอียดการเปลี่ยนแปลงจาก GitHub (${repoFullName} · branch ${repoBranch}) พร้อมตรวจสอบความพร้อมและอัปเดตเฉพาะ Sam_Att อย่างปลอดภัย`}
        actions={
          <>
            <PageHelpAction guideKey="deployment" userRole={userRole} onNavigate={onNavigate} />
            <button
              type="button"
              disabled={checkingUpdates || deployRunning}
              onClick={() => refreshStatusAndCheck({ showToast: true, force: true })}
              className="ent-btn-secondary"
            >
              <RefreshCw
                className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{checkingUpdates ? 'กำลังตรวจสอบ...' : 'ตรวจสอบเวอร์ชันอีกครั้ง'}</span>
            </button>
            <button
              type="button"
              disabled={!canExecuteUpdate}
              onClick={handleClickPrimaryUpdateButton}
              title={
                !canExecuteUpdate && blockingReasons.length > 0
                  ? blockingReasons[0]
                  : undefined
              }
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
                    ? `อนุมัติ Migration และอัปเดต (${pendingMigrations.length} ไฟล์)`
                    : 'อัปเดตระบบ'}
              </span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={() => refreshStatusAndCheck({ showToast: false })} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* =================================================================== */}
      {/* A. สถานะเวอร์ชัน (Version Status) */}
      {/* =================================================================== */}
      <section className="his-surface p-5 sm:p-6 space-y-5" aria-label="สถานะเวอร์ชันระบบ">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-[12.5px] font-semibold text-[#8066B5]">
              <span>A. สถานะเวอร์ชันและแหล่งข้อมูล GitHub</span>
              <span aria-hidden="true">·</span>
              <a
                href={repoHtmlUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 hover:underline font-mono text-[12px]"
              >
                <span>{repoFullName}</span>
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            </div>
            <h2 className="text-[17px] font-bold text-[#292638]">
              {loadingInitial
                ? 'กำลังตรวจสอบเวอร์ชันจาก GitHub...'
                : updateReport?.statusLabelThai || 'ยังไม่ได้ตรวจสอบสถานะเวอร์ชัน'}
            </h2>
            {!loadingInitial && updateReport?.statusDescriptionThai && (
              <p className="text-[13.5px] text-[#5B556B]">{updateReport.statusDescriptionThai}</p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <StatusBadge tone={loadingInitial ? 'neutral' : getStatusTone(versionStatus)}>
              {loadingInitial
                ? 'กำลังตรวจสอบ'
                : versionStatus === 'UP_TO_DATE'
                  ? 'เป็นเวอร์ชันล่าสุดแล้ว'
                  : versionStatus === 'UPDATE_AVAILABLE'
                    ? releaseAvailability === 'OFFICIAL_RELEASE'
                      ? 'มีเวอร์ชันใหม่ (Release)'
                      : 'มีอัปเดตใหม่ (Commit)'
                    : versionStatus === 'GITHUB_UNREACHABLE'
                      ? 'เชื่อมต่อ GitHub ไม่ได้'
                      : 'เวอร์ชันแตกต่าง / ไม่ตรงกัน'}
            </StatusBadge>
          </div>
        </div>

        {/* Version & Commit Comparison Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1">
            <div className="text-[12px] font-medium text-[#777287] flex items-center gap-1.5">
              <GitCommitHorizontal className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
              <span>เวอร์ชันที่ติดตั้งปัจจุบัน</span>
            </div>
            <div className="text-[16px] font-bold text-[#292638] font-mono">
              v{installedVersion}
            </div>
            <div className="text-[12px] text-[#5B556B] font-mono">
              Commit: {currentCommitSha !== 'unknown' ? currentCommitSha.slice(0, 8) : 'ไม่พบข้อมูล .git'}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1">
            <div className="text-[12px] font-medium text-[#777287] flex items-center gap-1.5">
              <Rocket className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
              <span>เวอร์ชันล่าสุดบน GitHub</span>
            </div>
            <div className="text-[16px] font-bold text-[#4E3978] font-mono">
              {github?.remote?.reachable
                ? latestReleaseTag || 'ยังไม่มี Release Tag'
                : 'ไม่สามารถอ่านได้'}
            </div>
            <div className="text-[12px] text-[#5B556B] font-mono">
              Target: {targetCommitSha !== 'unknown' ? targetCommitSha.slice(0, 8) : '—'}
              {typeof github?.remote?.aheadBy === 'number' && github.remote.aheadBy > 0
                ? ` (+${github.remote.aheadBy} commits)`
                : ''}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1">
            <div className="text-[12px] font-medium text-[#777287] flex items-center gap-1.5">
              <GitBranch className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
              <span>Branch เป้าหมาย / สภาพแวดล้อม</span>
            </div>
            <div className="text-[15px] font-bold text-[#292638] font-mono">
              {repoBranch} · HTTPS :{deployStatus?.httpsPort || 4101}
            </div>
            <div className="text-[12px] text-[#5B556B]">
              Node {deployStatus?.runtimeNodeVersion || '—'} ·{' '}
              {deployStatus?.isWindowsServer ? 'Windows Server' : deployStatus?.osPlatform || '—'}
            </div>
          </div>

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1">
            <div className="text-[12px] font-medium text-[#777287] flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
              <span>ตรวจสอบล่าสุดเมื่อ</span>
            </div>
            <div className="text-[14.5px] font-bold text-[#292638] tabular-nums">
              {checkedAt ? formatThaiDateTime(checkedAt) : '—'}
            </div>
            <div className="text-[12px] text-[#5B556B]">
              {github?.repository?.tokenConfigured
                ? 'เชื่อมต่อผ่าน Server GITHUB_TOKEN'
                : 'เชื่อมต่อ GitHub Public Read-Only'}
            </div>
          </div>
        </div>
      </section>

      {/* =================================================================== */}
      {/* B. รายละเอียดการเปลี่ยนแปลงภาษาไทย (Evidence-Based Thai Changelog) */}
      {/* =================================================================== */}
      <section className="his-surface p-5 sm:p-6 space-y-4" aria-label="รายละเอียดการเปลี่ยนแปลง">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="text-[12.5px] font-semibold text-[#8066B5]">
              B. รายละเอียดการเปลี่ยนแปลงภาษาไทย (Changelog)
            </div>
            <h2 className="text-[16.5px] font-bold text-[#292638]">
              {changelog?.sourceLabelThai || 'รายละเอียดการเปลี่ยนแปลงของเวอร์ชันเป้าหมาย'}
            </h2>
          </div>
          {changelog?.sourceType && changelog.sourceType !== 'NONE' && (
            <StatusBadge tone={changelog.hasOfficialReleaseNotes ? 'success' : 'info'}>
              {changelog.sourceType === 'GITHUB_RELEASE'
                ? 'แหล่งข้อมูล: GitHub Releases'
                : changelog.sourceType === 'CHANGELOG_MD'
                  ? 'แหล่งข้อมูล: CHANGELOG.md'
                  : 'แหล่งข้อมูล: ประวัติ Commit จริง'}
            </StatusBadge>
          )}
        </div>

        {changelog?.transparencyNotice && (
          <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13px] text-[#5B556B] flex items-start gap-2.5">
            <Info className="w-4 h-4 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
            <span>{changelog.transparencyNotice}</span>
          </div>
        )}

        {changelogReleases.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="text-[#777287] font-medium">เวอร์ชันที่รวมในการอัปเดตนี้:</span>
            {changelogReleases.map((rel: any) => (
              <span
                key={rel.tagName}
                className="px-2.5 py-1 rounded-lg bg-[#F1ECFA] text-[#4E3978] font-mono font-semibold"
              >
                {rel.tagName}
                {rel.publishedAt ? ` (${formatThaiDateTime(rel.publishedAt).split(' ')[0]})` : ''}
              </span>
            ))}
          </div>
        )}

        {changelogCategories.length === 0 ? (
          <div className="p-5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13.5px] text-[#777287] text-center">
            {versionStatus === 'UP_TO_DATE'
              ? 'ไม่มีรายการเปลี่ยนแปลงเพิ่มเติม เนื่องจากระบบเป็นเวอร์ชันล่าสุดแล้ว'
              : versionStatus === 'GITHUB_UNREACHABLE'
                ? 'ไม่สามารถแสดงรายละเอียดการเปลี่ยนแปลงได้ เนื่องจากไม่สามารถเชื่อมต่อ GitHub'
                : 'ไม่พบรายการเปลี่ยนแปลงเพิ่มเติมระหว่างเวอร์ชันปัจจุบันกับเป้าหมาย'}
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {changelogCategories.map((cat) => (
              <div
                key={cat.key}
                className="p-4 rounded-xl bg-white border border-[#E8E4EF] space-y-2.5"
              >
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-[14.5px] font-bold text-[#292638]">{cat.labelThai}</h3>
                  <StatusBadge tone={getCategoryTone(cat.key)}>
                    {cat.items.length} รายการ
                  </StatusBadge>
                </div>
                <ul className="space-y-2 text-[13.5px] text-[#292638]">
                  {cat.items.map((item, idx) => (
                    <li
                      key={`${cat.key}-${idx}`}
                      className="pl-3 border-l-2 border-[#E8E4EF] space-y-0.5"
                    >
                      <div className="leading-snug">{item.text}</div>
                      <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-[#777287] font-mono">
                        {item.releaseTag && <span>{item.releaseTag}</span>}
                        {item.commitSha && <span>#{item.commitSha}</span>}
                        {item.author && <span>โดย {item.author}</span>}
                        {item.originalText !== item.text && (
                          <span className="truncate max-w-full" title={item.originalText}>
                            ต้นฉบับ: {item.originalText}
                          </span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}

        {changelogCommits.length > 0 && (
          <div className="pt-2 border-t border-[#E8E4EF]">
            <button
              type="button"
              onClick={() => setShowOriginalCommitList((v) => !v)}
              className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[#4E3978] hover:text-[#8066B5] cursor-pointer"
            >
              {showOriginalCommitList ? (
                <ChevronUp className="w-4 h-4" aria-hidden="true" />
              ) : (
                <ChevronDown className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {showOriginalCommitList
                  ? 'ซ่อนรายการ Commit ต้นฉบับจาก GitHub'
                  : `ดูรายการ Commit ต้นฉบับทั้งหมด (${changelogCommits.length} รายการ)`}
              </span>
            </button>

            {showOriginalCommitList && (
              <div className="mt-3 rounded-xl border border-[#E8E4EF] overflow-x-auto">
                <table className="his-table">
                  <thead>
                    <tr>
                      <th>Commit</th>
                      <th>ข้อความต้นฉบับ</th>
                      <th>ผู้บันทึก</th>
                      <th>วันที่</th>
                    </tr>
                  </thead>
                  <tbody>
                    {changelogCommits.map((c) => (
                      <tr key={c.sha}>
                        <td className="font-mono font-bold text-[#4E3978]">{c.shortSha}</td>
                        <td className="text-[13px] text-[#292638]">{c.subject}</td>
                        <td className="text-[12.5px] text-[#777287]">{c.author || '—'}</td>
                        <td className="font-mono text-[12px] text-[#777287] tabular-nums whitespace-nowrap">
                          {c.date ? formatThaiDateTime(c.date) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* C. ตรวจสอบความพร้อมก่อนอัปเดต (Readiness Checklist & Migration Gate) */}
      {/* =================================================================== */}
      <section className="his-surface p-5 sm:p-6 space-y-4" aria-label="ตรวจสอบความพร้อมก่อนอัปเดต">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <div className="text-[12.5px] font-semibold text-[#8066B5]">
              C. ตรวจสอบความพร้อมก่อนอัปเดต (Readiness Checklist)
            </div>
            <h2 className="text-[16.5px] font-bold text-[#292638]">
              เงื่อนไขความปลอดภัยและความพร้อมของเซิร์ฟเวอร์
            </h2>
          </div>
          <StatusBadge tone={canExecuteUpdate ? 'success' : 'warning'}>
            {canExecuteUpdate
              ? hasPendingMigrations
                ? 'พร้อมอัปเดต (ต้องอนุมัติ Migration)'
                : 'ผ่านเกณฑ์พร้อมอัปเดต'
              : `ยังไม่พร้อมอัปเดต (${blockingReasons.length} เงื่อนไข)`}
          </StatusBadge>
        </div>

        <div className="divide-y divide-[#E8E4EF] rounded-xl border border-[#E8E4EF] bg-white overflow-hidden">
          {readinessChecks.map((item) => (
            <div
              key={item.id}
              className="px-4 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                {item.status === 'PASS' ? (
                  <CheckCircle2
                    className="w-4.5 h-4.5 text-[#198568] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                ) : item.status === 'WARN' ? (
                  <AlertTriangle
                    className="w-4.5 h-4.5 text-[#B87516] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                ) : (
                  <XCircle
                    className="w-4.5 h-4.5 text-[#C74455] shrink-0 mt-0.5"
                    aria-hidden="true"
                  />
                )}
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-[#292638]">{item.label}</div>
                  <div className="text-[13px] text-[#5B556B] break-words">{item.detail}</div>
                </div>
              </div>
              <div className="shrink-0">
                <StatusBadge
                  tone={
                    item.status === 'PASS'
                      ? 'success'
                      : item.status === 'WARN'
                        ? 'warning'
                        : 'danger'
                  }
                >
                  {item.status === 'PASS'
                    ? 'ผ่าน'
                    : item.status === 'WARN'
                      ? 'ต้องตรวจสอบ'
                      : 'ไม่ผ่าน (บล็อก)'}
                </StatusBadge>
              </div>
            </div>
          ))}
        </div>

        {/* Checksum Mismatch Critical Alert */}
        {hasChecksumMismatch && (
          <div className="p-4 sm:p-5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] space-y-2">
            <div className="flex items-center gap-2 font-bold text-[14.5px]">
              <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
              <span>ระงับการอัปเดต: ตรวจพบไฟล์ Migration ที่เคยรันแล้วถูกแก้ไข (Checksum Mismatch)</span>
            </div>
            <ul className="list-disc pl-6 text-[13px] space-y-1 font-mono">
              {checksumMismatches.map((cm: any) => (
                <li key={cm.version}>
                  {cm.filename} (recorded: {String(cm.recordedChecksum || '').slice(0, 12)} ≠ current:{' '}
                  {String(cm.currentFileChecksum || '').slice(0, 12)})
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pending Migration Gate Details */}
        {hasPendingMigrations && !hasChecksumMismatch && (
          <div className="rounded-xl bg-[#FEF7EA]/60 border border-[#F2DCBA] p-4 sm:p-5 space-y-3.5">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-[#B87516] font-bold text-[14.5px]">
                  <AlertTriangle className="w-4.5 h-4.5 shrink-0" aria-hidden="true" />
                  <span>พบ Database Migration รอการอนุมัติ ({pendingMigrations.length} ไฟล์)</span>
                </div>
                <p className="text-[13px] text-[#5B556B]">
                  ระบบไม่อนุญาตให้รัน Migration อัตโนมัติ ต้องตรวจสอบผลกระทบและยืนยันด้วยรหัสผ่านของบัญชี ADMIN
                </p>
              </div>
              <button
                type="button"
                disabled={!canExecuteUpdate}
                onClick={handleClickPrimaryUpdateButton}
                className="ent-btn-primary shrink-0"
              >
                <Lock className="w-4 h-4" aria-hidden="true" />
                <span>ตรวจสอบและอนุมัติ Migration</span>
              </button>
            </div>

            <div className="rounded-xl bg-white border border-[#E8E4EF] divide-y divide-[#E8E4EF]">
              {pendingMigrations.map((fname) => {
                const detail = pendingMigrationDetails.find((d: any) => d.filename === fname);
                return (
                  <div key={fname} className="p-3.5 space-y-1.5 text-[13px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-bold text-[#4E3978]">{fname}</span>
                      <StatusBadge tone="warning">รออนุมัติ (Pending)</StatusBadge>
                    </div>
                    {detail ? (
                      <div className="text-[#5B556B] space-y-1">
                        <div>
                          <strong className="text-[#292638]">ผลกระทบโครงสร้าง:</strong> {detail.summaryText}
                        </div>
                        {detail.affectedTables?.length > 0 && (
                          <div>
                            <strong className="text-[#292638]">ตารางที่เกี่ยวข้อง:</strong>{' '}
                            <span className="font-mono">{detail.affectedTables.join(', ')}</span>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[#777287]">
                        ไฟล์ Migration ใหม่จาก Commit เป้าหมาย — ระบบจะสำรองฐานข้อมูลก่อนดำเนินการ
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* D. ดำเนินการอัปเดต วิเคราะห์ข้อผิดพลาด และนโยบาย Rollback */}
      {/* =================================================================== */}
      <section className="his-surface p-5 sm:p-6 space-y-5" aria-label="ดำเนินการอัปเดตและวิเคราะห์ข้อผิดพลาด">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
          <div>
            <div className="text-[12.5px] font-semibold text-[#8066B5]">
              D. ดำเนินการอัปเดตอย่างปลอดภัยและนโยบายการย้อนกลับ
            </div>
            <h2 className="text-[16.5px] font-bold text-[#292638]">
              ขั้นตอนอัปเดต Sam_Att V2 Standalone (แยกอิสระจาก Procurement / HOSOffice)
            </h2>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={checkingUpdates || deployRunning}
              onClick={() => refreshStatusAndCheck({ showToast: true, force: true })}
              className="ent-btn-secondary"
            >
              <RefreshCw
                className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>ตรวจสอบเวอร์ชันอีกครั้ง</span>
            </button>
            <button
              type="button"
              disabled={!canExecuteUpdate}
              onClick={handleClickPrimaryUpdateButton}
              className="ent-btn-primary"
            >
              <Rocket className="w-4 h-4" aria-hidden="true" />
              <span>{deployRunning ? 'กำลังอัปเดตระบบ...' : 'อัปเดตระบบ'}</span>
            </button>
          </div>
        </div>

        {!canExecuteUpdate && blockingReasons.length > 0 && (
          <div className="p-4 rounded-xl bg-[#FEF7EA]/70 border border-[#F2DCBA] text-[13px] text-[#7C4E0E] space-y-1">
            <div className="font-bold">ปุ่ม "อัปเดตระบบ" ถูกปิดชั่วคราวเนื่องจากเงื่อนไขต่อไปนี้ยังไม่ผ่าน:</div>
            <ul className="list-disc pl-5 space-y-0.5">
              {blockingReasons.map((reason, idx) => (
                <li key={idx}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Structured Failure Diagnostics Panel */}
        {lastDiagnostics && (
          <div className="p-4 sm:p-5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-bold text-[15px]">
                <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
                <span>วิเคราะห์สาเหตุการอัปเดตไม่สำเร็จ ({lastDiagnostics.errorCode})</span>
              </div>
              <StatusBadge tone="danger">Exit Code: {lastDiagnostics.exitCode}</StatusBadge>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[13.5px] bg-white/80 rounded-lg p-3.5 border border-[#E5B8BF]/70">
              <div>
                <div className="text-[12px] text-[#777287] font-medium">ขั้นตอนที่ล้มเหลว</div>
                <div className="font-semibold text-[#292638]">{lastDiagnostics.failedStep}</div>
              </div>
              <div>
                <div className="text-[12px] text-[#777287] font-medium">สถานะการย้อนกลับโค้ด</div>
                <div className="font-semibold text-[#292638]">
                  {lastDiagnostics.requiresAdminDatabaseRestore
                    ? 'ย้อนโค้ดแล้ว — ต้องให้ผู้ดูแลระบบตรวจสอบฐานข้อมูล'
                    : lastDiagnostics.rolledBack
                      ? 'ระบบย้อนซอร์สโค้ดกลับรุ่นเดิมเรียบร้อยแล้ว'
                      : 'หยุดก่อนแก้ไขระบบ (ไม่มีการเปลี่ยนแปลงไฟล์)'}
                </div>
              </div>
              <div className="md:col-span-2">
                <div className="text-[12px] text-[#777287] font-medium">สาเหตุที่ตรวจพบ</div>
                <div className="text-[#292638]">{lastDiagnostics.detectedCause}</div>
              </div>
            </div>

            {lastDiagnostics.remediationSteps?.length > 0 && (
              <div className="text-[13px] space-y-1">
                <div className="font-bold">แนวทางแก้ไขที่แนะนำ:</div>
                <ol className="list-decimal pl-5 space-y-1 text-[#6F1D2A]">
                  {lastDiagnostics.remediationSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {/* Source Code Rollback vs Database Restore Policy */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 text-[13px]">
          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1">
            <div className="font-bold text-[#4E3978] flex items-center gap-1.5">
              <ShieldCheck className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>1. การย้อนกลับซอร์สโค้ด (Source Code Rollback)</span>
            </div>
            <p className="text-[#5B556B] leading-relaxed">
              หากการติดตั้ง Dependencies, Typecheck, Test หรือ Build ล้มเหลว ระบบจะย้อน Git Commit และไฟล์{' '}
              <code className="font-mono">dist/</code> กลับรุ่นก่อนหน้าโดยอัตโนมัติ (ไม่ใช้{' '}
              <code className="font-mono">git reset --hard</code>) และรีสตาร์ทเฉพาะ Sam_Att พอร์ต 4101 โดยไม่รัน{' '}
              <code className="font-mono">iisreset</code>
            </p>
          </div>
          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1">
            <div className="font-bold text-[#4E3978] flex items-center gap-1.5">
              <Database className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span>2. การกู้คืนฐานข้อมูล (Database Backup Restore)</span>
            </div>
            <p className="text-[#5B556B] leading-relaxed">
              ระบบสำรอง MySQL <code className="font-mono">samchuk_attendance_v2</code> พร้อม SHA-256 ไว้นอก Git Repo (
              <code className="font-mono">{deployStatus?.backupRootPolicy || 'C:\\SamAttBackups'}</code>) ก่อน{' '}
              <code className="font-mono">git pull</code> ทุกครั้ง และห้ามลดระดับ Schema หรือ DROP ตารางอัตโนมัติ
              หากจำเป็นต้องกู้คืนให้ใช้ <code className="font-mono">scripts\restore-test.ps1</code> ภายใต้การตรวจสอบของ DBA
            </p>
          </div>
        </div>

        {/* Last Execution Output (Sanitized) */}
        {(lastDeployMeta || lastDeployOutput) && (
          <div className="space-y-3 pt-3 border-t border-[#E8E4EF]">
            {lastDeployMeta && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-[13px]">
                <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[#777287] text-[12px]">Exit Code ล่าสุด</div>
                  <div
                    className={`font-mono font-bold ${
                      lastDeployMeta.exitCode === 0 ? 'text-[#198568]' : 'text-[#C74455]'
                    }`}
                  >
                    {lastDeployMeta.exitCode}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[#777287] text-[12px]">โฟลเดอร์สำรองข้อมูล</div>
                  <div className="font-mono text-[12px] text-[#292638] break-all">
                    {lastDeployMeta.backupDir || 'ยังไม่ได้สร้างในรอบนี้'}
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-[#F8F7FC] border border-[#E8E4EF]">
                  <div className="text-[#777287] text-[12px]">Migration ที่รันในรอบนี้</div>
                  <div className="font-mono text-[12px] text-[#292638]">
                    {lastDeployMeta.migrationsApplied?.length
                      ? lastDeployMeta.migrationsApplied.join(', ')
                      : 'ไม่มี'}
                  </div>
                </div>
              </div>
            )}

            {lastDeployOutput && (
              <div className="space-y-1.5">
                <div className="flex items-center gap-2 text-[13.5px] font-bold text-[#292638]">
                  <Terminal className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                  <span>ผลลัพธ์การอัปเดตล่าสุด (ปกปิดข้อมูลลับแล้ว)</span>
                </div>
                <pre className="p-4 rounded-xl bg-[#292638] text-[#F8F7FC] font-mono text-[12px] overflow-x-auto leading-relaxed max-h-72">
                  {lastDeployOutput}
                </pre>
              </div>
            )}
          </div>
        )}
      </section>

      {/* =================================================================== */}
      {/* E. ประวัติการอัปเดตระบบ & ประวัติ Database Migration */}
      {/* =================================================================== */}
      <section className="his-surface overflow-hidden" aria-label="ประวัติการอัปเดตระบบ">
        <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[12px] font-semibold text-[#8066B5]">
              E. ประวัติการอัปเดตระบบ (Deployment History)
            </div>
            <h3 className="text-[15.5px] font-bold text-[#292638]">
              รายการอัปเดตและการตรวจสอบย้อนหลัง ({historyItems.length} รายการ)
            </h3>
          </div>
          <button
            type="button"
            onClick={() => setShowAppliedMigrations((v) => !v)}
            className="ent-btn-secondary h-8 px-3 text-[12.5px]"
          >
            <Database className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
            <span>
              {showAppliedMigrations
                ? 'ซ่อนตาราง schema_migrations'
                : `ดูประวัติ Migration (${appliedMigrations.length} รุ่น)`}
            </span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="his-table">
            <thead>
              <tr>
                <th>ครั้งที่ · เวอร์ชัน · Commit</th>
                <th>วันที่และเวลา</th>
                <th>ผู้ดำเนินการ</th>
                <th>ประเภท</th>
                <th>สถานะ</th>
                <th className="text-right">รายละเอียด / Log</th>
              </tr>
            </thead>
            <tbody>
              {pagedHistory.length === 0 ? (
                <TableEmptyState
                  colSpan={6}
                  title="ยังไม่มีประวัติการอัปเดตระบบ"
                  description="เมื่อมีการดำเนินการอัปเดตระบบ ประวัติและบันทึกที่ปลอดภัยจะแสดงที่นี่"
                />
              ) : (
                pagedHistory.map((h: any) => (
                  <tr key={h.id}>
                    <td className="font-mono font-bold text-[#292638]">
                      #{h.id} · {h.release_version}{' '}
                      {h.commit_sha ? (
                        <span className="text-[12px] text-[#777287]">
                          ({String(h.commit_sha).slice(0, 8)})
                        </span>
                      ) : null}
                    </td>
                    <td className="font-mono text-[#777287] tabular-nums whitespace-nowrap">
                      {h.executed_at ? formatThaiDateTime(h.executed_at) : '—'}
                    </td>
                    <td className="font-mono text-[#292638]">{h.executed_by}</td>
                    <td className="font-mono text-[12px] text-[#5B556B]">{h.action_type || 'DEPLOY'}</td>
                    <td>
                      <StatusBadge tone={h.status === 'SUCCESS' ? 'success' : 'danger'}>
                        {h.status === 'SUCCESS' ? 'สำเร็จ' : h.status}
                      </StatusBadge>
                    </td>
                    <td className="text-right">
                      <button
                        type="button"
                        onClick={() => setSelectedHistoryRow(h)}
                        className="ent-btn-secondary h-8 px-3 text-[12.5px] whitespace-nowrap"
                      >
                        <PanelRightOpen className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                        <span>ดูบันทึก</span>
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <TablePaginationBar
          currentPage={historyPage}
          pageSize={historyPageSize}
          totalItems={historyItems.length}
          onPageChange={setHistoryPage}
          onPageSizeChange={setHistoryPageSize}
        />
      </section>

      {/* Expandable Applied Migrations Table */}
      {showAppliedMigrations && (
        <div className="his-surface overflow-hidden">
          <div className="px-5 py-4 border-b border-[#E8E4EF] bg-[#F8F7FC] flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <h3 className="text-[15px] font-bold text-[#292638]">
                ประวัติ Database Migration ที่ติดตั้งแล้ว (schema_migrations: {appliedMigrations.length} รุ่น)
              </h3>
            </div>
            {updateReport?.schemaVerification && (
              <StatusBadge tone={updateReport.schemaVerification.ok ? 'success' : 'danger'}>
                {updateReport.schemaVerification.ok
                  ? 'โครงสร้างฐานข้อมูลตรงตาม Schema'
                  : `พบข้อผิดพลาด Schema (${updateReport.schemaVerification.errors?.length || 0})`}
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
                  <TableEmptyState colSpan={4} title="ไม่พบประวัติ schema_migrations" />
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
      )}

      {/* History Log Drawer (reads real `notes` column, safely redacted on server) */}
      <SlideOverDrawer
        open={Boolean(selectedHistoryRow)}
        onClose={() => setSelectedHistoryRow(null)}
        kickerText="รายละเอียดประวัติการอัปเดตระบบ"
        title={
          selectedHistoryRow
            ? `รายการ #${selectedHistoryRow.id} · ${selectedHistoryRow.release_version}`
            : ''
        }
        subtitle={
          selectedHistoryRow
            ? `${selectedHistoryRow.action_type || 'DEPLOY'} · ${selectedHistoryRow.status}`
            : ''
        }
      >
        {selectedHistoryRow && (
          <div className="space-y-4 text-[13.5px]">
            <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 font-mono text-[12.5px]">
              <div>ผู้ดำเนินการ: {selectedHistoryRow.executed_by}</div>
              <div>
                เวลาที่ดำเนินการ:{' '}
                {selectedHistoryRow.executed_at
                  ? formatThaiDateTime(selectedHistoryRow.executed_at)
                  : '—'}
              </div>
              <div>Commit SHA: {selectedHistoryRow.commit_sha || '—'}</div>
              <div className="break-all">
                Backup Path: {selectedHistoryRow.backup_archive_path || '—'}
              </div>
            </div>
            <div>
              <div className="font-bold text-[#292638] mb-2">บันทึกการทำงานและข้อผิดพลาด (Sanitized Log)</div>
              <pre className="p-4 rounded-xl bg-[#292638] text-[#F8F7FC] font-mono text-[12px] overflow-x-auto whitespace-pre-wrap leading-relaxed">
                {selectedHistoryRow.notes || 'ไม่มีบันทึกข้อความเพิ่มเติม'}
              </pre>
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {/* ConfirmDialog ก่อนอัปเดตระบบ (กรณีไม่มี Migration ค้างอยู่) */}
      <ConfirmDialog
        open={confirmDeployOpen}
        title="ยืนยันการอัปเดตระบบ Sam_Att"
        description="ระบบจะสำรองฐานข้อมูล MySQL samchuk_attendance_v2 และไฟล์ระบบไว้นอก Git Repo ก่อนดึงโค้ดล่าสุด ทดสอบ Build และรีสตาร์ทเฉพาะ Sam_Att"
        confirmLabel="ยืนยันอัปเดตระบบทันที"
        loading={deployRunning}
        onConfirm={() => handleExecuteSafeUpdate()}
        onCancel={() => setConfirmDeployOpen(false)}
      >
        <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 text-[13px] text-[#292638]">
          <div className="font-bold text-[#4E3978]">ขั้นตอนความปลอดภัยที่ระบบจะดำเนินการตามลำดับ:</div>
          <ul className="list-disc pl-5 space-y-1 text-[#5B556B]">
            <li>ตรวจสอบความพร้อมของระบบและยืนยันว่าไม่มี Database Migration ค้างรออนุมัติ</li>
            <li>สำรองฐานข้อมูล MySQL samchuk_attendance_v2 และไฟล์ระบบไว้นอก Git Repo ก่อน git pull</li>
            <li>ติดตั้ง Dependencies · Typecheck · Automated Tests · Build</li>
            <li>รีสตาร์ทเฉพาะเซอร์วิส Sam_Att บนพอร์ต 4101 โดยไม่กระทบ Procurement และไม่รัน iisreset</li>
          </ul>
        </div>
      </ConfirmDialog>

      {/* Migration Approval Modal (ผูก Commit + รายการไฟล์ + รับทราบผลกระทบ + รหัสผ่าน ADMIN จริง) */}
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
              setMigrationApprovalError(
                'กรุณากรอกรหัสผ่านของบัญชีผู้ดูแลระบบปัจจุบันเพื่อยืนยันตัวตน'
              );
              return;
            }
            handleExecuteSafeUpdate({
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
                {updateReport?.backupPolicy?.databaseTarget || 'samchuk_attendance_v2'}
              </span>
            </div>
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-[#777287]">การสำรองข้อมูลก่อนเริ่ม:</span>
              <span className="font-semibold text-[#198568]">
                บังคับสำรอง MySQL นอก Git Repo ก่อน git pull และก่อนรัน Migration
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-[13.5px] font-bold text-[#292638]">
              รายการไฟล์ Migration ที่จะอนุมัติ ({pendingMigrations.length} ไฟล์):
            </div>
            <div className="max-h-44 overflow-y-auto space-y-2 pr-1">
              {pendingMigrations.map((fname) => {
                const detail = pendingMigrationDetails.find((d: any) => d.filename === fname);
                return (
                  <div
                    key={fname}
                    className="p-3 rounded-lg bg-white border border-[#E8E4EF] text-[12.5px] space-y-1"
                  >
                    <div className="font-mono font-bold text-[#4E3978]">{fname}</div>
                    {detail && <div className="text-[#5B556B]">{detail.summaryText}</div>}
                  </div>
                );
              })}
            </div>
          </div>

          <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] cursor-pointer">
            <input
              type="checkbox"
              checked={migrationImpactAck}
              onChange={(e) => setMigrationImpactAck(e.target.checked)}
              className="mt-1 h-4 w-4 accent-[#8066B5]"
            />
            <span className="text-[13px] text-[#292638]">
              ข้าพเจ้าได้ตรวจสอบรายการไฟล์ Migration และผลกระทบโครงสร้างฐานข้อมูลแล้ว
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

      {/* ProgressDialog แสดงความคืบหน้าจริงขณะอัปเดต */}
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
            <pre className="p-3 rounded-lg bg-[#292638] text-[#F8F7FC] font-mono text-[11.5px] max-h-48 overflow-auto">
              {lastDeployOutput}
            </pre>
          ) : null
        }
      />
    </div>
  );
}
