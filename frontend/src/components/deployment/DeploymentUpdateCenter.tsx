/**
 * ============================================================================
 * ศูนย์อัปเดตระบบจาก GitHub และจัดการ Database Migration อย่างปลอดภัย
 * (GitHub Update Center & Safe Deployment Control)
 * ไฟล์: frontend/src/components/deployment/DeploymentUpdateCenter.tsx
 * ============================================================================
 * 5 ส่วนหลักตามสถาปัตยกรรม HIS โรงพยาบาลสามชุก:
 * A. สถานะเวอร์ชัน (Installed vs Latest GitHub, Commit SHA, เวลาที่ตรวจสอบล่าสุด)
 * B. รายละเอียดการเปลี่ยนแปลง (Thai Changelog 6 หมวดหมู่จากแหล่งข้อมูลจริง)
 * C. ตรวจสอบความพร้อมก่อนอัปเดต (Readiness Gate Checklist 7 ข้อ)
 * D. ดำเนินการอัปเดต + Migration Approval Modal + วิเคราะห์ข้อผิดพลาด + แนวทาง Rollback
 * E. ประวัติการอัปเดตและ Log ที่ปกปิดข้อมูลความลับ
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  ExternalLink,
  Eye,
  EyeOff,
  GitBranch,
  GitCommitHorizontal,
  History,
  Info,
  KeyRound,
  Loader2,
  Lock,
  PanelRightOpen,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Terminal,
  Trash2,
  WifiOff,
  Wrench,
  XCircle,
} from 'lucide-react';
import { apiRequest, ApiClientError, type UserRole } from '../../services/api.ts';
import { ErrorBanner } from '../StatusText.tsx';
import {
  ConfirmDialog,
  MetricStrip,
  NotificationBanner,
  PageHeader,
  ProgressDialog,
  RequiredMark,
  SharedModal,
  SlideOverDrawer,
  StatusBadge,
  TableEmptyState,
  TableLoadingSkeleton,
} from '../common/SharedComponents.tsx';
import { useToast } from '../common/ToastContext.tsx';
import { PageHelpAction } from '../common/ContextualHelp.tsx';
import type { NavViewKey, SidebarUpdateBadge } from '../layout/Sidebar.tsx';
import { formatThaiDateTime } from '../../utils/thaiFormat.ts';

type ChangelogCategoryKey =
  | 'features'
  | 'fixes'
  | 'improvements'
  | 'security'
  | 'database'
  | 'breaking';

interface ChangelogEntry {
  id: string;
  category: ChangelogCategoryKey;
  title: string;
  rawText: string;
  sourceRef: string;
  author?: string | null;
  date?: string | null;
  url?: string | null;
  isAutoCategorized: boolean;
}

interface ThaiChangelogResult {
  sourceType: 'GITHUB_RELEASES' | 'CHANGELOG_MD' | 'COMMIT_HISTORY' | 'NONE';
  sourceLabelThai: string;
  hasOfficialReleaseNotes: boolean;
  isAutomatedThaiSummary: boolean;
  noticeThai: string;
  versionRangeLabel: string;
  isMultiVersionJump: boolean;
  includedReleases: Array<{
    tagName: string;
    name: string;
    publishedAt: string | null;
    url: string | null;
  }>;
  totalEntries: number;
  categories: Record<ChangelogCategoryKey, ChangelogEntry[]>;
}

interface ReadinessCheckItem {
  id: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  blocking: boolean;
  detail: string;
  remediation?: string | null;
}

interface DeploymentReadinessReport {
  canDeploy: boolean;
  checkedAt: string;
  blockingFailures: number;
  warnings: number;
  passedCount: number;
  totalChecks: number;
  checks: ReadinessCheckItem[];
}

interface DeploymentFailureDiagnostic {
  exitCode: number;
  failedStepNumber: number | null;
  failedStepName: string;
  errorCode: string;
  detectedCause: string;
  remediation: string;
  rollbackStatus: string;
  rollbackStatusThai: string;
}

const CHANGELOG_CATEGORY_META: Array<{
  key: ChangelogCategoryKey;
  label: string;
  tone: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
}> = [
  { key: 'features', label: 'ฟีเจอร์ใหม่', tone: 'primary' },
  { key: 'fixes', label: 'แก้ไขข้อผิดพลาด', tone: 'success' },
  { key: 'improvements', label: 'ปรับปรุงระบบ', tone: 'info' },
  { key: 'security', label: 'การเปลี่ยนแปลงด้านความปลอดภัย', tone: 'warning' },
  { key: 'database', label: 'การเปลี่ยนแปลงฐานข้อมูล', tone: 'warning' },
  { key: 'breaking', label: 'การเปลี่ยนแปลงที่อาจกระทบการใช้งาน', tone: 'danger' },
];

function getStatusBadgeProps(status: string | undefined): {
  tone: 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';
  label: string;
} {
  switch (status) {
    case 'UP_TO_DATE':
      return { tone: 'success', label: 'เป็นเวอร์ชันล่าสุดแล้ว' };
    case 'UPDATE_AVAILABLE':
      return { tone: 'primary', label: 'มีเวอร์ชันใหม่พร้อมอัปเดต' };
    case 'COMMIT_AHEAD_NO_RELEASE':
      return { tone: 'info', label: 'มี Commit ใหม่ (ยังไม่มี Release Tag)' };
    case 'HISTORY_DIVERGED':
      return { tone: 'warning', label: 'ประวัติ Commit แยกสายจาก GitHub' };
    case 'LOCAL_GIT_UNAVAILABLE':
      return { tone: 'warning', label: 'ไม่พบ .git ในเครื่องปัจจุบัน' };
    case 'GITHUB_UNREACHABLE':
      return { tone: 'danger', label: 'ไม่สามารถเชื่อมต่อ GitHub ได้' };
    default:
      return { tone: 'neutral', label: 'รอตรวจสอบเวอร์ชัน' };
  }
}

export function DeploymentUpdateCenter({
  userRole,
  onNavigate,
  onNotificationChange,
}: {
  userRole?: UserRole;
  onNavigate?: (view: NavViewKey) => void;
  onNotificationChange?: (badge?: SidebarUpdateBadge | null) => void;
}) {
  const { showToast } = useToast();

  const [loading, setLoading] = useState(true);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [error, setError] = useState<{ code?: string; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [deployStatus, setDeployStatus] = useState<any>(null);
  const [checkResult, setCheckResult] = useState<any>(null);
  const [readiness, setReadiness] = useState<DeploymentReadinessReport | null>(null);

  // Expandable changelog categories
  const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({
    features: true,
    fixes: true,
    improvements: true,
    security: true,
    database: true,
    breaking: true,
  });

  // Deployment execution & diagnostic state
  const [deployRunning, setDeployRunning] = useState(false);
  const [deployResult, setDeployResult] = useState<any>(null);
  const [deployConfirmOpen, setDeployConfirmOpen] = useState(false);
  const [deployProgressOpen, setDeployProgressOpen] = useState(false);
  const [deployProgressStatus, setDeployProgressStatus] = useState<'RUNNING' | 'SUCCESS' | 'FAILED'>('RUNNING');
  const [deployProgressStep, setDeployProgressStep] = useState('');
  const [deployProgressError, setDeployProgressError] = useState<string | null>(null);

  // Migration Approval Modal State (Commit/File Binding + ADMIN Password Re-auth)
  const [migrationModalOpen, setMigrationModalOpen] = useState(false);
  const [migrationImpactChecked, setMigrationImpactChecked] = useState(false);
  const [migrationAdminPassword, setMigrationAdminPassword] = useState('');
  const [migrationModalError, setMigrationModalError] = useState<string | null>(null);

  // GitHub Token configuration state (Admin-only .env persistence)
  const [tokenPanelOpen, setTokenPanelOpen] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [savingToken, setSavingToken] = useState(false);
  const [tokenFormError, setTokenFormError] = useState<string | null>(null);

  // History Detail Drawer
  const [selectedHistoryRow, setSelectedHistoryRow] = useState<any | null>(null);

  // Lifecycle, Concurrency & Stale-Response Protection Refs
  const onNotificationChangeRef = useRef(onNotificationChange);
  useEffect(() => {
    onNotificationChangeRef.current = onNotificationChange;
  }, [onNotificationChange]);

  const mountedRef = useRef(true);
  const activeControllerRef = useRef<AbortController | null>(null);
  const inFlightCheckRef = useRef<Promise<void> | null>(null);
  const inFlightForceRef = useRef(false);
  const requestSeqRef = useRef(0);

  const runVersionCheck = useCallback(
    async (opts: { force: boolean; showToastOnResult: boolean; isInitial: boolean }) => {
      if (inFlightCheckRef.current) {
        if (!opts.force || inFlightForceRef.current) {
          return inFlightCheckRef.current;
        }
        // Manual force check supersedes an older non-forced initial load
        activeControllerRef.current?.abort();
      }

      const seq = ++requestSeqRef.current;
      const controller = new AbortController();
      activeControllerRef.current = controller;
      inFlightForceRef.current = opts.force;

      if (opts.isInitial) {
        setLoading(true);
      } else {
        setCheckingUpdates(true);
        setNotice(null);
      }
      setError(null);

      let task!: Promise<void>;
      task = (async () => {
        try {
          const checkEndpoint = opts.force
            ? '/deployment/check-updates?force=true'
            : '/deployment/check-updates';

          const [statusRes, checkRes] = await Promise.all([
            apiRequest('/deployment/status', { signal: controller.signal }),
            apiRequest(checkEndpoint, {
              method: 'POST',
              body: JSON.stringify({ force: opts.force }),
              signal: controller.signal,
            }).catch((checkErr) => {
              if (
                opts.force ||
                controller.signal.aborted ||
                (checkErr instanceof Error && checkErr.name === 'AbortError')
              ) {
                throw checkErr;
              }
              return null;
            }),
          ]);

          if (controller.signal.aborted || !mountedRef.current || seq !== requestSeqRef.current) {
            return;
          }

          setDeployStatus(statusRes);
          if (checkRes) {
            setCheckResult(checkRes);
            if (checkRes.readiness) {
              setReadiness(checkRes.readiness);
            }
            if (
              checkRes.githubReachable === false &&
              (checkRes.githubErrorCode === 'GITHUB_RATE_LIMITED' ||
                checkRes.githubErrorCode === 'GITHUB_UNAUTHORIZED' ||
                checkRes.githubErrorCode === 'GITHUB_NOT_FOUND')
            ) {
              setTokenPanelOpen(true);
            }
            onNotificationChangeRef.current?.({
              hasUpdate: Boolean(checkRes.hasUpdates),
              label: checkRes.statusLabelThai,
              githubReachable: checkRes.githubReachable,
            });
          } else {
            const readRes = await apiRequest<DeploymentReadinessReport>('/deployment/readiness', {
              signal: controller.signal,
            }).catch(() => null);
            if (controller.signal.aborted || !mountedRef.current || seq !== requestSeqRef.current) {
              return;
            }
            if (readRes) setReadiness(readRes);
          }

          if (opts.showToastOnResult && checkRes) {
            if (!checkRes.githubReachable) {
              showToast({
                type: 'error',
                title: checkRes.statusLabelThai || 'เชื่อมต่อ GitHub ไม่สำเร็จ',
                message: checkRes.githubError || 'ไม่สามารถดึงข้อมูลจาก GitHub ได้ในขณะนี้',
              });
            } else if (checkRes.pendingMigrations?.length > 0) {
              showToast({
                type: 'warning',
                title: `พบ Database Migration ${checkRes.pendingMigrations.length} ไฟล์`,
                message: 'กรุณาตรวจสอบรายละเอียดและอนุมัติด้วยรหัสผ่านผู้ดูแลระบบก่อนอัปเดต',
              });
            } else if (checkRes.hasUpdates) {
              showToast({
                type: 'info',
                title: checkRes.statusLabelThai || 'พบอัปเดตใหม่บน GitHub',
                message: `Commit เป้าหมาย: ${checkRes.targetCommitShort}`,
              });
            } else {
              showToast({
                type: 'success',
                title: checkRes.statusLabelThai || 'ตรวจสอบเวอร์ชันเรียบร้อย',
                message: `ตรวจสอบล่าสุดเมื่อ ${formatThaiDateTime(checkRes.checkedAt)}`,
              });
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
            setError({
              message: opts.isInitial
                ? 'ไม่สามารถโหลดข้อมูลศูนย์อัปเดตระบบได้'
                : 'เกิดข้อผิดพลาดขณะตรวจสอบเวอร์ชันจาก GitHub',
            });
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
            setLoading(false);
            setCheckingUpdates(false);
          }
        }
      })();

      inFlightCheckRef.current = task;
      return task;
    },
    [showToast]
  );

  const loadInitialData = useCallback(async () => {
    return runVersionCheck({ force: false, showToastOnResult: false, isInitial: true });
  }, [runVersionCheck]);

  useEffect(() => {
    mountedRef.current = true;
    void loadInitialData();
    return () => {
      mountedRef.current = false;
      activeControllerRef.current?.abort();
      activeControllerRef.current = null;
      inFlightCheckRef.current = null;
      inFlightForceRef.current = false;
    };
  }, [loadInitialData]);

  async function handleRecheckVersion() {
    await runVersionCheck({ force: true, showToastOnResult: true, isInitial: false });
  }

  async function handleSaveGitHubToken(e: React.FormEvent) {
    e.preventDefault();
    setTokenFormError(null);
    const trimmed = tokenInput.trim();
    if (!trimmed) {
      setTokenFormError('กรุณากรอก GITHUB_TOKEN (เช่น ghp_... หรือ github_pat_...) ก่อนบันทึก');
      return;
    }
    setSavingToken(true);
    try {
      const res = await apiRequest<any>('/deployment/github-token', {
        method: 'POST',
        body: JSON.stringify({ token: trimmed }),
      });
      if (!mountedRef.current) return;
      setTokenInput('');
      setShowTokenInput(false);
      setDeployStatus((prev: any) => ({
        ...(prev || {}),
        tokenConfigured: Boolean(res.tokenConfigured),
        tokenMaskedHint: res.tokenMaskedHint || null,
        envFileExists: true,
      }));
      if (res.checkResult) {
        setCheckResult(res.checkResult);
        onNotificationChangeRef.current?.({
          hasUpdate: Boolean(res.checkResult.hasUpdates),
          label: res.checkResult.statusLabelThai,
          githubReachable: res.checkResult.githubReachable,
        });
      }
      if (res.readiness) {
        setReadiness(res.readiness);
      }

      if (res.checkResult?.githubReachable) {
        setNotice(res.message || 'บันทึก GITHUB_TOKEN และเชื่อมต่อ GitHub สำเร็จแล้ว');
        setTokenPanelOpen(false);
        showToast({
          type: 'success',
          title: 'บันทึก GITHUB_TOKEN สำเร็จ',
          message: 'โหลดค่าใหม่และเชื่อมต่อ GitHub API เรียบร้อยแล้ว (โควตา 5,000 ครั้ง/ชั่วโมง)',
        });
      } else {
        setTokenFormError(
          res.checkResult?.githubError ||
            'บันทึก GITHUB_TOKEN ลงไฟล์ .env แล้ว แต่การเชื่อมต่อ GitHub ยังไม่สำเร็จ'
        );
        showToast({
          type: 'warning',
          title: 'บันทึก Token แล้ว แต่ยังเชื่อมต่อ GitHub ไม่ผ่าน',
          message: res.checkResult?.statusLabelThai || 'กรุณาตรวจสอบ Token หรือเครือข่ายเซิร์ฟเวอร์',
        });
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiClientError) {
        setTokenFormError(err.message);
        showToast({ type: 'error', title: 'ไม่สามารถบันทึก GITHUB_TOKEN ได้', message: err.message });
      } else {
        setTokenFormError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์เพื่อบันทึก GITHUB_TOKEN ได้');
      }
    } finally {
      if (mountedRef.current) {
        setSavingToken(false);
      }
    }
  }

  async function handleClearGitHubToken() {
    setTokenFormError(null);
    setSavingToken(true);
    try {
      const res = await apiRequest<any>('/deployment/github-token', {
        method: 'POST',
        body: JSON.stringify({ clear: true }),
      });
      if (!mountedRef.current) return;
      setTokenInput('');
      setShowTokenInput(false);
      setDeployStatus((prev: any) => ({
        ...(prev || {}),
        tokenConfigured: false,
        tokenMaskedHint: null,
      }));
      if (res.checkResult) {
        setCheckResult(res.checkResult);
        onNotificationChangeRef.current?.({
          hasUpdate: Boolean(res.checkResult.hasUpdates),
          label: res.checkResult.statusLabelThai,
          githubReachable: res.checkResult.githubReachable,
        });
      }
      if (res.readiness) {
        setReadiness(res.readiness);
      }
      setNotice('ล้างค่า GITHUB_TOKEN จากไฟล์ .env เรียบร้อยแล้ว (สลับกลับเป็นโหมดสาธารณะ 60 ครั้ง/ชั่วโมง)');
      showToast({
        type: 'info',
        title: 'ล้างค่า GITHUB_TOKEN แล้ว',
        message: 'ระบบใช้การตรวจสอบแบบไม่ระบุตัวตน (เฉพาะ Public Repository)',
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (err instanceof ApiClientError) {
        setTokenFormError(err.message);
      } else {
        setTokenFormError('ไม่สามารถล้างค่า GITHUB_TOKEN ได้');
      }
    } finally {
      if (mountedRef.current) {
        setSavingToken(false);
      }
    }
  }

  async function executeSafeDeployment(payload: {
    approveMigrations?: boolean;
    approvedTargetCommit?: string;
    approvedMigrationFiles?: string[];
    impactAcknowledged?: boolean;
    confirmPassword?: string;
  }) {
    setDeployRunning(true);
    setDeployConfirmOpen(false);
    setDeployProgressOpen(true);
    setDeployProgressStatus('RUNNING');
    setDeployProgressError(null);
    setDeployProgressStep(
      payload.approveMigrations
        ? 'กำลังยืนยันการอนุมัติ Migration, สำรองฐานข้อมูล MySQL นอก Git Repo และเริ่มอัปเดตระบบ...'
        : 'กำลังตรวจสอบความพร้อม, สำรองฐานข้อมูล MySQL นอก Git Repo และรันสคริปต์อัปเดต...'
    );
    setError(null);
    setNotice(null);

    try {
      const res = await apiRequest<any>('/deployment/run-bat', {
        method: 'POST',
        body: JSON.stringify({
          confirmRun: true,
          ...payload,
        }),
      });
      setMigrationModalOpen(false);
      setMigrationAdminPassword('');
      setMigrationImpactChecked(false);
      setDeployResult(res);
      setDeployProgressStatus('SUCCESS');
      setDeployProgressStep(res.message || 'อัปเดตระบบและตรวจสอบ Health Check สำเร็จ');
      setNotice(
        `${res.message || 'อัปเดตระบบสำเร็จ'}${res.backupDir ? ` · Backup: ${res.backupDir}` : ''}`
      );
      showToast({
        type: 'success',
        title: 'อัปเดตระบบสำเร็จ',
        message: 'สำรองข้อมูล อัปเดตซอร์สโค้ด และตรวจสอบ Health Check เรียบร้อยแล้ว',
      });
      await loadInitialData();
    } catch (err) {
      if (err instanceof ApiClientError) {
        const body = err.data as any;
        if (err.code === 'MIGRATION_APPROVAL_REQUIRED') {
          setDeployProgressOpen(false);
          setMigrationModalOpen(true);
          setMigrationModalError(null);
          showToast({
            type: 'warning',
            title: 'ต้องอนุมัติ Database Migration',
            message: 'กรุณาตรวจสอบรายการและยืนยันด้วยรหัสผ่านผู้ดูแลระบบ',
          });
        } else if (
          err.code === 'INVALID_CONFIRM_PASSWORD' ||
          err.code === 'CONFIRM_PASSWORD_REQUIRED' ||
          err.code === 'IMPACT_ACK_REQUIRED' ||
          err.code === 'REAUTH_RATE_LIMITED' ||
          err.code === 'MIGRATION_APPROVAL_MISMATCH'
        ) {
          setDeployProgressOpen(false);
          setMigrationModalOpen(true);
          setMigrationModalError(err.message);
          showToast({ type: 'error', title: 'การอนุมัติไม่ผ่าน', message: err.message });
        } else {
          setDeployResult({
            status: 'FAILED',
            error: err.code,
            exitCode: body?.exitCode ?? 1,
            diagnostic: body?.diagnostic || null,
            output: body?.output || '',
            errorOutput: body?.errorOutput || '',
            backupDir: body?.backupDir || null,
            backupSqlPath: body?.backupSqlPath || null,
            requiresAdminDatabaseRestore: Boolean(body?.requiresAdminDatabaseRestore),
            message: err.message,
          });
          setDeployProgressStatus('FAILED');
          setDeployProgressStep(
            body?.diagnostic?.failedStepName
              ? `ล้มเหลวที่ขั้นตอน ${body.diagnostic.failedStepName} (${body.diagnostic.errorCode})`
              : 'การอัปเดตระบบไม่สำเร็จ'
          );
          setDeployProgressError(err.message);
          setError({ code: err.code, message: err.message });
          showToast({ type: 'error', title: 'อัปเดตระบบไม่สำเร็จ', message: err.message });
          await loadInitialData();
        }
      } else {
        setDeployProgressStatus('FAILED');
        setDeployProgressStep('การอัปเดตระบบไม่สำเร็จ');
        setDeployProgressError('เกิดข้อผิดพลาดขณะเชื่อมต่อเซิร์ฟเวอร์อัปเดต');
        setError({ message: 'เกิดข้อผิดพลาดขณะสั่งอัปเดตระบบ' });
      }
    } finally {
      setDeployRunning(false);
    }
  }

  function handleClickUpdateButton() {
    if (!canRunUpdate) return;
    if (pendingMigrations.length > 0) {
      setMigrationModalError(null);
      setMigrationAdminPassword('');
      setMigrationImpactChecked(false);
      setMigrationModalOpen(true);
    } else {
      setDeployConfirmOpen(true);
    }
  }

  async function handleConfirmMigrationApproval(e: React.FormEvent) {
    e.preventDefault();
    setMigrationModalError(null);
    if (!migrationImpactChecked) {
      setMigrationModalError('กรุณาทำเครื่องหมายรับทราบผลกระทบต่อฐานข้อมูลก่อนอนุมัติ');
      return;
    }
    if (!migrationAdminPassword.trim()) {
      setMigrationModalError('กรุณากรอกรหัสผ่านบัญชีผู้ดูแลระบบ (ADMIN) เพื่อยืนยันตัวตน');
      return;
    }
    await executeSafeDeployment({
      approveMigrations: true,
      approvedTargetCommit: targetCommitSha,
      approvedMigrationFiles: pendingMigrations,
      impactAcknowledged: true,
      confirmPassword: migrationAdminPassword,
    });
  }

  const repository = checkResult?.repository || deployStatus?.repository || 'jk9krnvb6g-ai/Sam_Att-V2-Standalone';
  const repositoryUrl = checkResult?.repositoryUrl || deployStatus?.repositoryUrl || `https://github.com/${repository}`;
  const branch = checkResult?.branch || deployStatus?.branch || 'main';
  const installedVersion = checkResult?.installedVersion || deployStatus?.installedVersion || '2.0.0';
  const latestVersion = checkResult?.latestVersion || null;
  const currentCommitSha = checkResult?.currentCommit || deployStatus?.currentCommit || 'unknown';
  const currentCommitShort = checkResult?.currentCommitShort || deployStatus?.currentCommitShort || 'unknown';
  const targetCommitSha = checkResult?.targetCommit || currentCommitSha;
  const targetCommitShort = checkResult?.targetCommitShort || currentCommitShort;
  const updateStatus: string | undefined = checkResult?.status;
  const statusBadge = getStatusBadgeProps(updateStatus);
  const changelog: ThaiChangelogResult | null = checkResult?.changelog || null;
  const pendingMigrations: string[] = checkResult?.pendingMigrations || [];
  const pendingMigrationDetails: any[] = checkResult?.pendingMigrationDetails || [];
  const checksumMismatches: any[] = checkResult?.checksumMismatches || [];
  const hasChecksumMismatch = checksumMismatches.length > 0;
  const historyRows: any[] = deployStatus?.history || [];

  const blockingReasons = useMemo(() => {
    if (!readiness) return [];
    return readiness.checks.filter((c) => c.status === 'FAIL' && c.blocking);
  }, [readiness]);

  const canRunUpdate =
    Boolean(readiness?.canDeploy) &&
    !hasChecksumMismatch &&
    !deployRunning &&
    !Boolean(deployStatus?.inProgress);

  const diagnostic: DeploymentFailureDiagnostic | null = deployResult?.diagnostic || null;

  const tokenConfigured: boolean = Boolean(
    checkResult?.tokenConfigured ?? deployStatus?.tokenConfigured
  );
  const tokenMaskedHint: string | null =
    checkResult?.tokenMaskedHint ?? deployStatus?.tokenMaskedHint ?? null;
  const rateLimit = checkResult?.rateLimit || null;

  return (
    <div className="space-y-6">
      <PageHeader
        category="ระบบและผู้ดูแล"
        title="ศูนย์อัปเดตระบบ (GitHub Update Center)"
        subtitle="ตรวจสอบเวอร์ชันและรายละเอียดการเปลี่ยนแปลงจาก GitHub ตรวจความพร้อมก่อนอัปเดต อนุมัติ Database Migration และดูประวัติการอัปเดต"
        actions={
          <>
            <PageHelpAction guideKey="deployment" userRole={userRole} onNavigate={onNavigate} />
            <button
              type="button"
              disabled={checkingUpdates || deployRunning}
              onClick={handleRecheckVersion}
              className="ent-btn-secondary"
            >
              <RefreshCw
                className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`}
                aria-hidden="true"
              />
              <span>{checkingUpdates ? 'กำลังตรวจสอบ...' : 'ตรวจสอบเวอร์ชันล่าสุดใหม่'}</span>
            </button>
            <button
              type="button"
              disabled={!canRunUpdate}
              onClick={handleClickUpdateButton}
              title={
                !canRunUpdate && blockingReasons.length > 0
                  ? `ยังไม่พร้อมอัปเดต: ${blockingReasons[0].label}`
                  : 'เริ่มขั้นตอนอัปเดตระบบอย่างปลอดภัย'
              }
              className="ent-btn-primary"
            >
              {pendingMigrations.length > 0 ? (
                <Lock className="w-4 h-4" aria-hidden="true" />
              ) : (
                <Rocket className="w-4 h-4" aria-hidden="true" />
              )}
              <span>
                {deployRunning
                  ? 'กำลังอัปเดตระบบ...'
                  : pendingMigrations.length > 0
                    ? `อนุมัติ Migration (${pendingMigrations.length}) และอัปเดต`
                    : 'อัปเดตระบบ'}
              </span>
            </button>
          </>
        }
      />

      <ErrorBanner error={error} onRetry={handleRecheckVersion} />
      <NotificationBanner message={notice} onClose={() => setNotice(null)} />

      {/* ===================================================================
          ส่วน A: สถานะเวอร์ชัน (Version Status & GitHub Token / Cache)
         =================================================================== */}
      <section aria-labelledby="section-version-status" className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="section-version-status" className="text-[16px] font-bold text-[#292638]">
              1. สถานะเวอร์ชันและการเชื่อมต่อ GitHub
            </h2>
            <StatusBadge tone={statusBadge.tone}>{statusBadge.label}</StatusBadge>
            {checkResult?.fromCache && (
              <StatusBadge tone="info">
                จาก Cache เซิร์ฟเวอร์ (ไม่เสียโควตา)
              </StatusBadge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-[#777287]">
            <a
              href={repositoryUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 font-mono text-[#4E3978] hover:underline"
            >
              <GitBranch className="w-3.5 h-3.5" aria-hidden="true" />
              <span>{repository}</span>
              <span>({branch})</span>
              <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
            {checkResult?.checkedAt && (
              <span className="inline-flex items-center gap-1 font-mono tabular-nums">
                <Clock className="w-3.5 h-3.5" aria-hidden="true" />
                <span>ตรวจล่าสุด: {formatThaiDateTime(checkResult.checkedAt)}</span>
              </span>
            )}
          </div>
        </div>

        {/* Auth Mode, Rate Limit Quota & Cache Status Strip + Token Setup Toggle */}
        <div className="p-3.5 sm:px-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3 text-[13px]">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[#5B556B]">
            <span className="inline-flex items-center gap-1.5">
              <KeyRound className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
              <span className="font-semibold text-[#292638]">สิทธิ์เชื่อมต่อ GitHub:</span>
              {tokenConfigured ? (
                <StatusBadge tone="success">
                  ตั้งค่า GITHUB_TOKEN แล้ว (5,000 ครั้ง/ชม.{tokenMaskedHint ? ` · ${tokenMaskedHint}` : ''})
                </StatusBadge>
              ) : (
                <StatusBadge tone="warning">
                  โหมดไม่ระบุตัวตน (60 ครั้ง/ชม.)
                </StatusBadge>
              )}
            </span>

            {rateLimit && (rateLimit.limit !== null || rateLimit.remaining !== null) && (
              <span className="font-mono text-[12.5px] text-[#4E3978]">
                โควตาคงเหลือ: {rateLimit.remaining ?? '?'} / {rateLimit.limit ?? '?'}
                {rateLimit.resetAtThai ? ` · รีเซ็ต ${rateLimit.resetAtThai}` : ''}
              </span>
            )}

            {checkResult?.cacheTtlMinutes && (
              <span className="text-[12px] text-[#777287]">
                แคชอัตโนมัติ {checkResult.cacheTtlMinutes} นาที + ETag (ประหยัดโควตาเมื่อรีเฟรชหน้า)
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              setTokenFormError(null);
              setTokenPanelOpen((prev) => !prev);
            }}
            className="ent-btn-secondary h-8 px-3 text-[12.5px] shrink-0 self-start lg:self-auto"
          >
            <KeyRound className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
            <span>
              {tokenPanelOpen
                ? 'ซ่อนการตั้งค่า GITHUB_TOKEN'
                : tokenConfigured
                  ? 'เปลี่ยน / ล้าง GITHUB_TOKEN'
                  : 'ตั้งค่า GITHUB_TOKEN'}
            </span>
          </button>
        </div>

        {/* GitHub Unreachable Explicit Alert with Distinct Cause, Rate-Limit Cooldown & Stale Fallback Notice */}
        {checkResult && checkResult.githubReachable === false && (
          <div
            role="alert"
            className="p-4 sm:p-5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] space-y-2.5"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 font-bold text-[14.5px]">
                {checkResult.githubErrorCode === 'GITHUB_TIMEOUT' ||
                checkResult.githubErrorCode === 'GITHUB_NETWORK_ERROR' ? (
                  <WifiOff className="w-5 h-5 shrink-0" aria-hidden="true" />
                ) : (
                  <XCircle className="w-5 h-5 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {checkResult.statusLabelThai || 'ไม่สามารถเชื่อมต่อ GitHub เพื่อตรวจสอบเวอร์ชันล่าสุดได้'}
                  {checkResult.githubErrorCode ? ` (${checkResult.githubErrorCode})` : ''}
                </span>
              </div>
              {(checkResult.cooldownUntilThai || rateLimit?.resetAtThai) &&
                checkResult.githubErrorCode === 'GITHUB_RATE_LIMITED' && (
                  <StatusBadge tone="warning">
                    รีเซ็ตโควตาเวลา {checkResult.cooldownUntilThai || rateLimit.resetAtThai}
                  </StatusBadge>
                )}
            </div>
            <p className="text-[13.5px] leading-relaxed">{checkResult.githubError}</p>
            {checkResult.isStale && checkResult.staleWarningThai && (
              <div className="text-[13px] bg-[#FEF7EA] border border-[#F2DCBA] rounded-lg px-3.5 py-2.5 text-[#7C4E0E]">
                <span className="font-bold">ข้อมูลแคชล่าสุด: </span>
                {checkResult.staleWarningThai}
              </div>
            )}
            {checkResult.remediationThai && (
              <div className="text-[13px] bg-white/80 border border-[#E5B8BF]/60 rounded-lg px-3.5 py-2.5 text-[#4E3978]">
                <span className="font-bold">แนวทางแก้ไข: </span>
                {checkResult.remediationThai}
              </div>
            )}
          </div>
        )}

        {/* Admin UI Form to Save / Update / Clear GITHUB_TOKEN directly into Server .env */}
        {tokenPanelOpen && (
          <form
            onSubmit={handleSaveGitHubToken}
            className="p-4 sm:p-5 rounded-xl bg-white border border-[#D8CEEA] shadow-xs space-y-3.5"
          >
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <div>
                <h3 className="text-[14.5px] font-bold text-[#292638] flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                  <span>ตั้งค่า GITHUB_TOKEN (บันทึกลงไฟล์ .env ฝั่ง Server และโหลดทันที)</span>
                </h3>
                <p className="text-[12.5px] text-[#777287] mt-0.5">
                  ใช้สิทธิ์แบบอ่านอย่างเดียว (<span className="font-mono">Contents: Read-only</span> หรือ{' '}
                  <span className="font-mono">repo</span> สำหรับ Private Repository) เพื่อเพิ่มโควตาเป็น 5,000 ครั้ง/ชั่วโมง — Token จะถูกเก็บเฉพาะฝั่ง Server ไม่ส่งกลับไปยังเบราว์เซอร์
                </p>
              </div>
            </div>

            {tokenFormError && (
              <div
                role="alert"
                className="p-3 rounded-lg bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13px]"
              >
                {tokenFormError}
              </div>
            )}

            <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-end">
              <div className="flex-1">
                <label htmlFor="github-token-input" className="ent-label">
                  GitHub Personal Access Token (GITHUB_TOKEN)
                </label>
                <div className="relative">
                  <input
                    id="github-token-input"
                    type={showTokenInput ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    placeholder={
                      tokenConfigured
                        ? `กำลังใช้งาน (${tokenMaskedHint || 'ตั้งค่าแล้ว'}) — วาง Token ใหม่เพื่อแทนที่`
                        : 'วาง Token เช่น github_pat_... หรือ ghp_...'
                    }
                    className="ent-input w-full pr-10 font-mono text-[13px]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowTokenInput((prev) => !prev)}
                    aria-label={showTokenInput ? 'ซ่อน Token' : 'แสดง Token'}
                    className="absolute inset-y-0 right-0 px-3 flex items-center text-[#777287] hover:text-[#292638]"
                  >
                    {showTokenInput ? (
                      <EyeOff className="w-4 h-4" aria-hidden="true" />
                    ) : (
                      <Eye className="w-4 h-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  type="submit"
                  disabled={savingToken || !tokenInput.trim()}
                  className="ent-btn-primary whitespace-nowrap"
                >
                  {savingToken ? (
                    <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <KeyRound className="w-4 h-4" aria-hidden="true" />
                  )}
                  <span>{savingToken ? 'กำลังบันทึก...' : 'บันทึกและตรวจสอบทันที'}</span>
                </button>
                {tokenConfigured && (
                  <button
                    type="button"
                    disabled={savingToken}
                    onClick={handleClearGitHubToken}
                    className="ent-btn-secondary whitespace-nowrap text-[#8E2837]"
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                    <span>ล้าง Token</span>
                  </button>
                )}
              </div>
            </div>
          </form>
        )}

        <MetricStrip
          items={[
            {
              label: 'เวอร์ชันที่ติดตั้งปัจจุบัน',
              value: checkResult?.installedReleaseTag
                ? `${checkResult.installedReleaseTag} (v${installedVersion})`
                : `v${installedVersion}`,
              subtext:
                currentCommitShort !== 'unknown'
                  ? `Commit ปัจจุบัน: ${currentCommitShort}`
                  : 'ไม่พบ .git ในเครื่องปัจจุบัน',
              tone: 'primary',
            },
            {
              label: 'เวอร์ชันล่าสุดบน GitHub',
              value: checkResult?.githubReachable
                ? latestVersion || targetCommitShort
                : 'เชื่อมต่อไม่ได้',
              subtext: checkResult?.githubReachable
                ? checkResult?.latestRelease?.publishedAt
                  ? `Release เมื่อ ${formatThaiDateTime(checkResult.latestRelease.publishedAt)}`
                  : checkResult?.latestCommitDate
                    ? `Commit ล่าสุด ${formatThaiDateTime(checkResult.latestCommitDate)}`
                    : `Branch ${branch}`
                : 'ไม่สามารถดึงข้อมูลจาก GitHub',
              tone: !checkResult?.githubReachable
                ? 'danger'
                : checkResult?.hasUpdates
                  ? 'primary'
                  : 'success',
            },
            {
              label: 'การเปรียบเทียบ Commit',
              value:
                currentCommitShort !== 'unknown' && targetCommitShort !== 'unknown'
                  ? `${currentCommitShort} → ${targetCommitShort}`
                  : targetCommitShort !== 'unknown'
                    ? `เป้าหมาย: ${targetCommitShort}`
                    : 'รอตรวจสอบ',
              subtext:
                checkResult?.commitsBehind > 0
                  ? `ตามหลัง GitHub ${checkResult.commitsBehind} Commit`
                  : checkResult?.status === 'UP_TO_DATE'
                    ? 'ตรงกับ GitHub Branch ล่าสุด'
                    : checkResult?.statusLabelThai || '—',
              tone:
                checkResult?.commitsBehind > 0
                  ? 'info'
                  : checkResult?.status === 'HISTORY_DIVERGED'
                    ? 'warning'
                    : 'success',
            },
            {
              label: 'สถานะ Database Migration',
              value: hasChecksumMismatch
                ? 'Checksum ไม่ตรงกัน'
                : pendingMigrations.length > 0
                  ? `รออนุมัติ ${pendingMigrations.length} ไฟล์`
                  : `พร้อมใช้งาน (${checkResult?.appliedMigrations?.length ?? 0} รุ่น)`,
              subtext:
                pendingMigrations.length > 0
                  ? 'ต้องอนุมัติด้วยรหัสผ่าน ADMIN ก่อนรัน'
                  : 'สำรอง MySQL นอก Git Repo ก่อนอัปเดตเสมอ',
              tone: hasChecksumMismatch
                ? 'danger'
                : pendingMigrations.length > 0
                  ? 'warning'
                  : 'success',
            },
          ]}
        />
      </section>

      {/* ===================================================================
          ส่วน B: รายละเอียดการเปลี่ยนแปลง (Thai Changelog)
         =================================================================== */}
      <section aria-labelledby="section-changelog" className="his-surface overflow-hidden">
        <div className="px-5 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 id="section-changelog" className="text-[15.5px] font-bold text-[#292638]">
              2. รายละเอียดการเปลี่ยนแปลง (Changelog ภาษาไทย)
            </h2>
            <p className="text-[13px] text-[#777287] mt-0.5">
              {changelog?.noticeThai || 'กด "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อดึงรายการเปลี่ยนแปลงจาก GitHub'}
            </p>
          </div>
          {changelog && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <StatusBadge tone={changelog.hasOfficialReleaseNotes ? 'success' : 'info'}>
                แหล่งข้อมูล: {changelog.sourceLabelThai}
              </StatusBadge>
              {changelog.isMultiVersionJump && (
                <StatusBadge tone="primary">สรุปรวมหลายเวอร์ชัน</StatusBadge>
              )}
            </div>
          )}
        </div>

        <div className="p-5 space-y-4">
          {loading ? (
            <TableLoadingSkeleton rows={3} cols={3} />
          ) : !changelog || changelog.totalEntries === 0 ? (
            <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13.5px] text-[#5B556B] flex items-start gap-3">
              <Info className="w-5 h-5 text-[#8066B5] shrink-0 mt-0.5" aria-hidden="true" />
              <div className="space-y-1">
                <div className="font-semibold text-[#292638]">
                  {checkResult?.status === 'UP_TO_DATE'
                    ? 'ไม่มีรายการเปลี่ยนแปลงเพิ่มเติม — ระบบเป็นเวอร์ชันล่าสุดแล้ว'
                    : 'ยังไม่มีรายการเปลี่ยนแปลงที่สามารถสรุปได้'}
                </div>
                <p className="text-[13px] text-[#777287]">
                  {changelog?.noticeThai || 'กดปุ่ม "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อดึงข้อมูลล่าสุดจาก GitHub'}
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {changelog.isAutomatedThaiSummary && (
                <div className="px-3.5 py-2.5 rounded-lg bg-[#F1ECFA]/60 border border-[#E8E4EF] text-[12.5px] text-[#4E3978] flex items-center gap-2">
                  <Info className="w-4 h-4 shrink-0 text-[#8066B5]" aria-hidden="true" />
                  <span>
                    {changelog.hasOfficialReleaseNotes
                      ? 'รายการบางส่วนถูกจัดหมวดหมู่ภาษาไทยอัตโนมัติจาก Release Notes ต้นฉบับ (แสดงข้อความต้นฉบับและรหัสอ้างอิงกำกับทุกข้อ)'
                      : 'ยังไม่มี Release Notes อย่างเป็นทางการ — รายการด้านล่างสร้างจากประวัติ Commit จริงบน GitHub พร้อมจัดหมวดหมู่ภาษาไทยอัตโนมัติ'}
                  </span>
                </div>
              )}

              {CHANGELOG_CATEGORY_META.map((cat) => {
                const items = changelog.categories[cat.key] || [];
                if (items.length === 0) return null;
                const isOpen = expandedCategories[cat.key] !== false;
                return (
                  <div key={cat.key} className="border border-[#E8E4EF] rounded-xl overflow-hidden bg-white">
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedCategories((prev) => ({ ...prev, [cat.key]: !isOpen }))
                      }
                      className="w-full px-4 py-3 bg-[#F8F7FC] hover:bg-[#F1ECFA]/70 flex items-center justify-between gap-2 text-left transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-2.5">
                        {isOpen ? (
                          <ChevronDown className="w-4 h-4 text-[#8066B5]" aria-hidden="true" />
                        ) : (
                          <ChevronRight className="w-4 h-4 text-[#777287]" aria-hidden="true" />
                        )}
                        <span className="font-bold text-[14px] text-[#292638]">{cat.label}</span>
                        <StatusBadge tone={cat.tone}>{items.length} รายการ</StatusBadge>
                      </div>
                    </button>
                    {isOpen && (
                      <ul className="divide-y divide-[#F1ECFA] px-4 py-1">
                        {items.map((item) => (
                          <li key={item.id} className="py-2.5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                            <div className="space-y-0.5 min-w-0">
                              <div className="text-[13.5px] font-medium text-[#292638] leading-snug">
                                {item.title}
                              </div>
                              {item.rawText !== item.title && (
                                <div className="text-[12px] font-mono text-[#777287] break-words">
                                  ต้นฉบับ: {item.rawText}
                                </div>
                              )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0 text-[12px] font-mono text-[#777287]">
                              {item.url ? (
                                <a
                                  href={item.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-[#F1ECFA] text-[#4E3978] hover:bg-[#E9DFF5]"
                                >
                                  <GitCommitHorizontal className="w-3.5 h-3.5" aria-hidden="true" />
                                  <span>{item.sourceRef}</span>
                                </a>
                              ) : (
                                <span className="px-2 py-0.5 rounded bg-[#F8F7FC] border border-[#E8E4EF]">
                                  {item.sourceRef}
                                </span>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* ===================================================================
          ส่วน C: ตรวจสอบความพร้อมก่อนอัปเดต (Readiness Gate Checklist)
         =================================================================== */}
      <section aria-labelledby="section-readiness" className="his-surface overflow-hidden">
        <div className="px-5 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 id="section-readiness" className="text-[15.5px] font-bold text-[#292638] flex items-center gap-2">
              <ShieldCheck className="w-4.5 h-4.5 text-[#8066B5]" aria-hidden="true" />
              <span>3. ตรวจสอบความพร้อมก่อนอัปเดต (Readiness Gate)</span>
            </h2>
            <p className="text-[13px] text-[#777287] mt-0.5">
              ปุ่ม "อัปเดตระบบ" จะเปิดใช้งานได้เมื่อเงื่อนไขความปลอดภัยหลักผ่านครบทุกข้อเท่านั้น
            </p>
          </div>
          {readiness && (
            <StatusBadge tone={readiness.canDeploy ? 'success' : 'danger'}>
              {readiness.canDeploy
                ? `ผ่านเกณฑ์พร้อมอัปเดต (${readiness.passedCount}/${readiness.totalChecks})`
                : `ยังไม่พร้อมอัปเดต (ติดเงื่อนไข ${readiness.blockingFailures} ข้อ)`}
            </StatusBadge>
          )}
        </div>

        <div className="divide-y divide-[#E8E4EF]">
          {!readiness ? (
            <div className="p-5 text-[13.5px] text-[#777287]">กำลังประเมินความพร้อมของระบบ...</div>
          ) : (
            readiness.checks.map((chk) => (
              <div
                key={chk.id}
                className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5 bg-white"
              >
                <div className="flex items-start gap-3 min-w-0">
                  {chk.status === 'PASS' && (
                    <CheckCircle2 className="w-5 h-5 text-[#198568] shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  {chk.status === 'WARN' && (
                    <AlertTriangle className="w-5 h-5 text-[#B87516] shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  {chk.status === 'FAIL' && (
                    <XCircle className="w-5 h-5 text-[#C74455] shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                  <div className="space-y-0.5 min-w-0">
                    <div className="font-semibold text-[14px] text-[#292638]">{chk.label}</div>
                    <div className="text-[13px] text-[#5B556B]">{chk.detail}</div>
                    {chk.remediation && (
                      <div className="text-[12.5px] text-[#4E3978] pt-0.5">
                        แนวทางแก้ไข: {chk.remediation}
                      </div>
                    )}
                  </div>
                </div>
                <div className="shrink-0 self-start">
                  <StatusBadge
                    tone={chk.status === 'PASS' ? 'success' : chk.status === 'WARN' ? 'warning' : 'danger'}
                  >
                    {chk.status === 'PASS'
                      ? 'ผ่าน'
                      : chk.status === 'WARN'
                        ? 'ต้องตรวจสอบ'
                        : chk.blocking
                          ? 'ระงับการอัปเดต'
                          : 'ไม่ผ่าน'}
                  </StatusBadge>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Checksum Mismatch Alert */}
      {hasChecksumMismatch && (
        <div
          role="alert"
          className="p-4 sm:p-5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] space-y-2"
        >
          <div className="flex items-center gap-2 font-bold text-[15px]">
            <ShieldAlert className="w-5 h-5 shrink-0" aria-hidden="true" />
            <span>ระงับการอัปเดต: ตรวจพบไฟล์ Migration ที่เคยรันแล้วถูกแก้ไข (Checksum Mismatch)</span>
          </div>
          <ul className="list-disc pl-6 text-[13px] font-mono space-y-1">
            {checksumMismatches.map((cm: any) => (
              <li key={cm.version}>
                {cm.filename} (recorded: {String(cm.recordedChecksum || '').slice(0, 12)} ≠ current:{' '}
                {String(cm.currentFileChecksum || '').slice(0, 12)})
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Pending Migration Gate */}
      {pendingMigrations.length > 0 && !hasChecksumMismatch && (
        <div className="rounded-xl bg-[#FEF7EA]/60 border border-[#F2DCBA] p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-[#B87516] font-bold text-[15px]">
                <Database className="w-5 h-5 shrink-0" aria-hidden="true" />
                <span>พบ Database Migration รออนุมัติ ({pendingMigrations.length} ไฟล์)</span>
              </div>
              <p className="text-[13.5px] text-[#5B556B]">
                ระบบล็อกไม่ให้รัน Migration อัตโนมัติ (MIGRATION_APPROVAL_REQUIRED) ผู้ดูแลระบบต้องตรวจสอบรายการด้านล่างและอนุมัติด้วยรหัสผ่าน ADMIN พร้อมผูกกับ Target Commit ({targetCommitShort})
              </p>
            </div>
            <button
              type="button"
              disabled={!canRunUpdate}
              onClick={handleClickUpdateButton}
              className="ent-btn-primary shrink-0"
            >
              <Lock className="w-4 h-4" aria-hidden="true" />
              <span>ตรวจสอบและอนุมัติ Migration</span>
            </button>
          </div>
          <div className="bg-white rounded-lg border border-[#F2DCBA] divide-y divide-[#F1ECFA]">
            {pendingMigrations.map((filename) => {
              const detail = pendingMigrationDetails.find((d: any) => d.filename === filename);
              return (
                <div key={filename} className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                  <div>
                    <div className="font-mono font-bold text-[13.5px] text-[#292638]">{filename}</div>
                    {detail?.affectedTables?.length > 0 && (
                      <div className="text-[12.5px] text-[#777287]">
                        ตารางที่เกี่ยวข้อง: {detail.affectedTables.join(', ')}
                      </div>
                    )}
                  </div>
                  <StatusBadge tone="warning">รออนุมัติจาก ADMIN</StatusBadge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ===================================================================
          ส่วน D: ดำเนินการอัปเดต ผลการวิเคราะห์ข้อผิดพลาด และแนวทาง Rollback
         =================================================================== */}
      <section aria-labelledby="section-deploy-action" className="his-surface p-5 space-y-5">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 id="section-deploy-action" className="text-[15.5px] font-bold text-[#292638]">
              4. ดำเนินการอัปเดตและแนวทางกู้คืน (Rollback Safety)
            </h2>
            <p className="text-[13px] text-[#777287] mt-0.5">
              สำรองฐานข้อมูล <span className="font-mono">{checkResult?.backupPolicy?.databaseTarget || 'samchuk_attendance_v2'}</span> ไว้ที่{' '}
              <span className="font-mono">{checkResult?.backupPolicy?.defaultBackupRoot || 'C:\\SamAttBackups'}</span> ก่อน git pull เสมอ และไม่แตะต้อง Procurement หรือรัน iisreset
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <button
              type="button"
              disabled={checkingUpdates || deployRunning}
              onClick={handleRecheckVersion}
              className="ent-btn-secondary"
            >
              <RefreshCw className={`w-4 h-4 ${checkingUpdates ? 'animate-spin' : ''}`} aria-hidden="true" />
              <span>ตรวจสอบเวอร์ชันล่าสุดใหม่</span>
            </button>
            <button
              type="button"
              disabled={!canRunUpdate}
              onClick={handleClickUpdateButton}
              className="ent-btn-primary"
            >
              <Rocket className="w-4 h-4" aria-hidden="true" />
              <span>{deployRunning ? 'กำลังอัปเดต...' : 'อัปเดตระบบ'}</span>
            </button>
          </div>
        </div>

        {/* Clear explanation when Update button is disabled */}
        {!canRunUpdate && blockingReasons.length > 0 && (
          <div className="p-3.5 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] text-[13px] text-[#5B556B]">
            <span className="font-semibold text-[#292638]">ปุ่มอัปเดตถูกปิดชั่วคราวเนื่องจาก: </span>
            {blockingReasons.map((b) => b.label).join(', ')} — กรุณาแก้ไขตามรายการในส่วนที่ 3 ก่อนดำเนินการ
          </div>
        )}

        {/* Structured Failure Diagnostic Panel (HTTP 422 / Exit Code 1) */}
        {diagnostic && (
          <div
            role="alert"
            className="rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] p-4 sm:p-5 space-y-3 text-[#292638]"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-[#8E2837] font-bold text-[15px]">
                <Wrench className="w-5 h-5 shrink-0" aria-hidden="true" />
                <span>
                  วิเคราะห์สาเหตุการอัปเดตไม่สำเร็จ (Exit Code: {diagnostic.exitCode} · {diagnostic.errorCode})
                </span>
              </div>
              <StatusBadge tone="danger">
                ขั้นตอนที่ {diagnostic.failedStepNumber ?? '?'}: {diagnostic.failedStepName}
              </StatusBadge>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[13.5px]">
              <div className="p-3.5 rounded-lg bg-white border border-[#E5B8BF]/60 space-y-1">
                <div className="text-[12px] font-bold text-[#8E2837]">สาเหตุที่ตรวจพบ</div>
                <div className="text-[#292638] leading-relaxed">{diagnostic.detectedCause}</div>
              </div>
              <div className="p-3.5 rounded-lg bg-white border border-[#E5B8BF]/60 space-y-1">
                <div className="text-[12px] font-bold text-[#4E3978]">แนวทางแก้ไขที่แนะนำ</div>
                <div className="text-[#292638] leading-relaxed">{diagnostic.remediation}</div>
              </div>
            </div>
            <div className="text-[13px] text-[#5B556B] bg-white/80 px-3.5 py-2.5 rounded-lg border border-[#E5B8BF]/50">
              <span className="font-semibold text-[#292638]">สถานะการย้อนกลับ: </span>
              {diagnostic.rollbackStatusThai}
              {deployResult?.backupDir && (
                <span className="block font-mono text-[12px] text-[#4E3978] mt-1">
                  Backup Path: {deployResult.backupDir}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Masked Execution Console Output (when available) */}
        {deployResult && (deployResult.output || deployResult.errorOutput) && (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[13px] font-bold text-[#4E3978]">
              <Terminal className="w-4 h-4" aria-hidden="true" />
              <span>บันทึกการทำงานล่าสุด (ปกปิดรหัสผ่านและ Token อัตโนมัติ)</span>
            </div>
            <pre className="p-4 rounded-xl bg-[#292638] text-[#F8F7FC] text-[12px] font-mono overflow-x-auto max-h-64 whitespace-pre-wrap">
              {[deployResult.output, deployResult.errorOutput].filter(Boolean).join('\n--- STDERR ---\n')}
            </pre>
          </div>
        )}

        {/* Rollback Separation Policy (Source Code vs Database) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-[#E8E4EF]">
          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1.5">
            <div className="font-bold text-[13.5px] text-[#4E3978]">
              การย้อนกลับซอร์สโค้ด (Source Code Rollback)
            </div>
            <p className="text-[13px] text-[#5B556B] leading-relaxed">
              หากขั้น Install, Typecheck, Test, Build หรือ Health Check ล้มเหลว สคริปต์จะย้อนกลับไปยัง Commit และโฟลเดอร์ <span className="font-mono">dist/</span> เดิมโดยอัตโนมัติ (โดยไม่ใช้ <span className="font-mono">git reset --hard</span>)
            </p>
          </div>
          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-1.5">
            <div className="font-bold text-[13.5px] text-[#4E3978]">
              การกู้คืนฐานข้อมูล (Database Restore — แยกส่วนชัดเจน)
            </div>
            <p className="text-[13px] text-[#5B556B] leading-relaxed">
              ห้ามรันคำสั่ง DROP หรือกู้คืนฐานข้อมูลทับอัตโนมัติ หากเกิดข้อผิดพลาดหลัง Migration ให้ผู้ดูแลระบบทดสอบและกู้คืนจากไฟล์ Backup ใน <span className="font-mono">C:\SamAttBackups</span> ผ่าน <span className="font-mono">scripts\restore-test.ps1</span>
            </p>
          </div>
        </div>
      </section>

      {/* ===================================================================
          ส่วน E: ประวัติการอัปเดต (Update History)
         =================================================================== */}
      <section aria-labelledby="section-history" className="his-surface overflow-hidden">
        <div className="px-5 py-4 bg-[#F8F7FC] border-b border-[#E8E4EF] flex items-center justify-between gap-2">
          <h2 id="section-history" className="text-[15.5px] font-bold text-[#292638] flex items-center gap-2">
            <History className="w-4.5 h-4.5 text-[#8066B5]" aria-hidden="true" />
            <span>5. ประวัติการอัปเดตระบบ ({historyRows.length} รายการล่าสุด)</span>
          </h2>
        </div>

        {loading ? (
          <TableLoadingSkeleton rows={4} cols={6} />
        ) : (
          <>
            {/* Mobile Card View */}
            <div className="md:hidden divide-y divide-[#E8E4EF]">
              {historyRows.length === 0 ? (
                <div className="p-8 text-center text-[13.5px] text-[#777287]">
                  ยังไม่มีประวัติการอัปเดตระบบ
                </div>
              ) : (
                historyRows.map((row) => (
                  <div key={row.id} className="p-4 space-y-2 bg-white">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-mono font-bold text-[13.5px] text-[#292638]">
                          v{row.release_version} · {String(row.commit_sha || '').slice(0, 8)}
                        </div>
                        <div className="text-[12.5px] font-mono text-[#777287]">
                          {row.executed_at ? formatThaiDateTime(row.executed_at) : '—'}
                        </div>
                      </div>
                      <StatusBadge tone={row.status === 'SUCCESS' ? 'success' : 'danger'}>
                        {row.status === 'SUCCESS' ? 'สำเร็จ' : row.status}
                      </StatusBadge>
                    </div>
                    <div className="text-[12.5px] text-[#5B556B]">
                      ผู้ดำเนินการ: <span className="font-semibold text-[#292638]">{row.executed_by}</span>
                    </div>
                    {row.backup_archive_path && (
                      <div className="text-[12px] font-mono text-[#777287] break-all">
                        Backup: {row.backup_archive_path}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={() => setSelectedHistoryRow(row)}
                      className="ent-btn-secondary w-full h-8 text-[12.5px]"
                    >
                      <PanelRightOpen className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                      <span>ดูรายละเอียดและ Log</span>
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="his-table">
                <thead>
                  <tr>
                    <th>วันและเวลา</th>
                    <th>ผู้ดำเนินการ</th>
                    <th>เวอร์ชัน / Commit</th>
                    <th>ประเภท</th>
                    <th>สถานะ</th>
                    <th>Backup Path</th>
                    <th className="text-right">รายละเอียด</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.length === 0 ? (
                    <TableEmptyState colSpan={7} title="ยังไม่มีประวัติการอัปเดตระบบ" />
                  ) : (
                    historyRows.map((row) => (
                      <tr key={row.id}>
                        <td className="font-mono text-[13px] tabular-nums whitespace-nowrap">
                          {row.executed_at ? formatThaiDateTime(row.executed_at) : '—'}
                        </td>
                        <td className="font-semibold text-[#292638] font-mono">{row.executed_by}</td>
                        <td className="font-mono text-[13px]">
                          <div className="font-bold text-[#292638]">{row.release_version}</div>
                          <div className="text-[12px] text-[#777287]">
                            {String(row.commit_sha || '').slice(0, 10)}
                          </div>
                        </td>
                        <td className="text-[12.5px] text-[#5B556B]">{row.action_type}</td>
                        <td>
                          <StatusBadge tone={row.status === 'SUCCESS' ? 'success' : 'danger'}>
                            {row.status === 'SUCCESS' ? 'สำเร็จ' : row.status}
                          </StatusBadge>
                        </td>
                        <td className="font-mono text-[12px] text-[#777287] max-w-[260px] truncate" title={row.backup_archive_path || ''}>
                          {row.backup_archive_path || '—'}
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            onClick={() => setSelectedHistoryRow(row)}
                            className="ent-btn-secondary h-8 px-3 text-[12.5px] whitespace-nowrap"
                          >
                            <PanelRightOpen className="w-3.5 h-3.5 text-[#8066B5]" aria-hidden="true" />
                            <span>ดู Log</span>
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
      </section>

      {/* Confirm Standard Update Dialog (No Pending Migrations) */}
      <ConfirmDialog
        open={deployConfirmOpen}
        onCancel={() => !deployRunning && setDeployConfirmOpen(false)}
        onConfirm={() => executeSafeDeployment({})}
        title="ยืนยันการอัปเดตระบบ Sam_Att V2 Standalone"
        description={`ระบบจะสำรองฐานข้อมูล MySQL นอก Git Repository (${checkResult?.backupPolicy?.defaultBackupRoot || 'C:\\SamAttBackups'}) ก่อนดึงโค้ด Commit ${targetCommitShort} จาก GitHub และรีสตาร์ทเฉพาะบริการ Sam_Att บนพอร์ต 4101 โดยไม่แตะต้อง Procurement`}
        confirmLabel={deployRunning ? 'กำลังดำเนินการ...' : 'ยืนยันอัปเดตระบบ'}
        cancelLabel="ยกเลิก"
        variant="primary"
        loading={deployRunning}
      />

      {/* Migration Approval Modal (Target Commit & File Binding + ADMIN Re-auth) */}
      <SharedModal
        open={migrationModalOpen}
        onClose={() => {
          if (!deployRunning) {
            setMigrationModalOpen(false);
            setMigrationAdminPassword('');
            setMigrationModalError(null);
          }
        }}
        kickerText="ขั้นตอนความปลอดภัยก่อนเปลี่ยนโครงสร้างฐานข้อมูล"
        title="อนุมัติ Database Migration และอัปเดตระบบ"
        subtitle="การอนุมัติจะผูกกับ Target Commit และรายการไฟล์ SQL ด้านล่างอย่างเคร่งครัด"
        maxWidthClass="max-w-2xl"
        disableEscapeClose={deployRunning}
      >
        <form onSubmit={handleConfirmMigrationApproval} className="space-y-5">
          {migrationModalError && (
            <div
              role="alert"
              className="p-3.5 rounded-xl bg-[#FDF2F4] border border-[#E5B8BF] text-[#8E2837] text-[13.5px] font-medium"
            >
              {migrationModalError}
            </div>
          )}

          <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 text-[13px]">
            <div className="flex flex-wrap justify-between gap-2">
              <span className="text-[#777287]">Target Commit ที่ผูกการอนุมัติ:</span>
              <span className="font-mono font-bold text-[#4E3978]">{targetCommitSha}</span>
            </div>
            <div>
              <span className="text-[#777287]">ไฟล์ Migration ที่จะรัน ({pendingMigrations.length} ไฟล์):</span>
              <ul className="list-disc pl-5 mt-1 font-mono font-semibold text-[#292638] space-y-0.5">
                {pendingMigrations.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>

          <label className="flex items-start gap-2.5 p-3.5 rounded-xl bg-[#FEF7EA]/70 border border-[#F2DCBA] cursor-pointer">
            <input
              type="checkbox"
              checked={migrationImpactChecked}
              onChange={(e) => setMigrationImpactChecked(e.target.checked)}
              className="mt-1 rounded border-[#B87516] text-[#8066B5] focus:ring-[#8066B5]"
            />
            <span className="text-[13.5px] text-[#292638] leading-relaxed">
              ข้าพเจ้าได้ตรวจสอบรายการไฟล์ Database Migration ข้างต้นแล้ว และรับทราบว่าระบบจะสำรองฐานข้อมูล MySQL ไว้นอก Git Repo ก่อนดำเนินการเปลี่ยนแปลงโครงสร้างตาราง
            </span>
          </label>

          <div>
            <label className="ent-label">
              ยืนยันรหัสผ่านบัญชีผู้ดูแลระบบ (ADMIN) ที่กำลังใช้งาน <RequiredMark />
            </label>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={migrationAdminPassword}
              onChange={(e) => setMigrationAdminPassword(e.target.value)}
              placeholder="กรอกรหัสผ่านบัญชีผู้ดูแลระบบ"
              className="ent-input w-full"
            />
            <p className="text-[12px] text-[#777287] mt-1">
              รหัสผ่านใช้เพื่อยืนยันตัวตนเท่านั้น จะไม่ถูกบันทึกใน Log หรือฐานข้อมูล
            </p>
          </div>

          <div className="flex flex-col sm:flex-row justify-end gap-2.5 pt-3 border-t border-[#E8E4EF]">
            <button
              type="button"
              disabled={deployRunning}
              onClick={() => {
                setMigrationModalOpen(false);
                setMigrationAdminPassword('');
              }}
              className="ent-btn-secondary w-full sm:w-auto"
            >
              ยกเลิก
            </button>
            <button
              type="submit"
              disabled={deployRunning || !migrationImpactChecked || !migrationAdminPassword.trim()}
              className="ent-btn-primary w-full sm:w-auto"
            >
              {deployRunning ? (
                <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
              ) : (
                <Lock className="w-4 h-4" aria-hidden="true" />
              )}
              <span>{deployRunning ? 'กำลังอัปเดตระบบ...' : 'ยืนยันอนุมัติและอัปเดตระบบ'}</span>
            </button>
          </div>
        </form>
      </SharedModal>

      {/* Non-Simulated Progress Dialog */}
      <ProgressDialog
        open={deployProgressOpen}
        title="กำลังดำเนินการอัปเดตระบบ Sam_Att"
        stageLabel="Safe Deployment"
        stepLabel={deployProgressStep}
        status={deployProgressStatus}
        errorMessage={deployProgressError}
        onClose={() => setDeployProgressOpen(false)}
      />

      {/* History Detail Slide-Over Drawer */}
      <SlideOverDrawer
        open={Boolean(selectedHistoryRow)}
        onClose={() => setSelectedHistoryRow(null)}
        kickerText="รายละเอียดประวัติการอัปเดตระบบ"
        title={
          selectedHistoryRow
            ? `รุ่น ${selectedHistoryRow.release_version} (${selectedHistoryRow.status})`
            : ''
        }
        subtitle={
          selectedHistoryRow
            ? `รหัสรายการ #${selectedHistoryRow.id} · โดย ${selectedHistoryRow.executed_by}`
            : ''
        }
      >
        {selectedHistoryRow && (
          <div className="space-y-4 text-[13.5px]">
            <div className="p-4 rounded-xl bg-[#F8F7FC] border border-[#E8E4EF] space-y-2 font-mono text-[12.5px]">
              <div>
                เวลาดำเนินการ:{' '}
                {selectedHistoryRow.executed_at
                  ? formatThaiDateTime(selectedHistoryRow.executed_at)
                  : '—'}
              </div>
              <div>ผู้ดำเนินการ: {selectedHistoryRow.executed_by}</div>
              <div>ประเภท: {selectedHistoryRow.action_type}</div>
              <div>Commit SHA: {selectedHistoryRow.commit_sha}</div>
              <div>Backup Path: {selectedHistoryRow.backup_archive_path || '—'}</div>
              <div>Artifact / SQL SHA-256: {selectedHistoryRow.artifact_sha256 || '—'}</div>
            </div>
            <div>
              <div className="font-bold text-[#292638] mb-2">
                บันทึกการทำงาน / สาเหตุข้อผิดพลาด (Masked Log)
              </div>
              <pre className="p-4 rounded-xl bg-[#292638] text-[#F8F7FC] font-mono text-[12px] overflow-x-auto whitespace-pre-wrap">
                {selectedHistoryRow.notes || 'ไม่มีบันทึกเพิ่มเติม'}
              </pre>
            </div>
          </div>
        )}
      </SlideOverDrawer>
    </div>
  );
}
