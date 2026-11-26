/**
 * ============================================================================
 * ศูนย์ตรวจสอบเวอร์ชัน GitHub, สร้าง Changelog ภาษาไทย และวิเคราะห์ข้อผิดพลาดการอัปเดต
 * (GitHub Update Center: Version Checker, Thai Changelog Builder & Diagnostics)
 * ไฟล์: backend/src/modules/deployment/githubUpdateCenter.ts
 * ============================================================================
 * หลักการสำคัญ:
 * - อ่านข้อมูลเวอร์ชันจากไฟล์จริง (package.json, local Git, GitHub API) ห้ามสมมติหรือสร้างเวอร์ชันจำลอง
 * - GitHub API เป็นแบบ Read-Only และจำกัดปลายทางเฉพาะ https://api.github.com/repos/<owner>/<repo> (ป้องกัน SSRF)
 * - GITHUB_TOKEN (ถ้าตั้งค่า) ใช้เฉพาะฝั่ง Server เท่านั้น ห้ามส่งกลับ Frontend หรือบันทึกลง Log
 * - วิเคราะห์ข้อผิดพลาด Exit Code 1 / HTTP 422 จาก Log จริง พร้อมปกปิดรหัสผ่านและ Secret ทุกชนิด
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { loadConfig } from '../../config/env.ts';
import type { DetailedMigrationInspection } from '../../database/adapter.ts';

export type UpdateStatus =
  | 'UP_TO_DATE'
  | 'UPDATE_AVAILABLE'
  | 'COMMIT_AHEAD_NO_RELEASE'
  | 'HISTORY_DIVERGED'
  | 'LOCAL_GIT_UNAVAILABLE'
  | 'GITHUB_UNREACHABLE';

export type ChangelogCategoryKey =
  | 'features'
  | 'fixes'
  | 'improvements'
  | 'security'
  | 'database'
  | 'breaking';

export type ChangelogSourceType = 'GITHUB_RELEASES' | 'CHANGELOG_MD' | 'COMMIT_HISTORY' | 'NONE';

export interface ChangelogEntry {
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

export interface ThaiChangelogResult {
  sourceType: ChangelogSourceType;
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

export interface GitHubReleaseSummary {
  tagName: string;
  name: string;
  publishedAt: string | null;
  targetCommitish: string;
  prerelease: boolean;
  url: string | null;
  body: string;
}

export interface InstalledVersionInfo {
  packageVersion: string;
  localGitAvailable: boolean;
  branch: string;
  currentCommit: string | null;
  currentCommitShort: string | null;
  installedReleaseTag: string | null;
  workingTreeClean: boolean | null;
  dirtyFiles: string[];
  gitWarning: string | null;
}

export interface GitHubRateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetEpochSec: number | null;
  resetAt: string | null;
  resetAtThai: string | null;
  retryAfterSec?: number | null;
}

export interface GitHubVersionCheckResult {
  repository: string;
  repositoryUrl: string;
  branch: string;
  checkedAt: string;
  status: UpdateStatus;
  statusLabelThai: string;
  hasUpdates: boolean;
  githubReachable: boolean;
  githubError: string | null;
  githubErrorCode: string | null;
  remediationThai: string | null;
  installedVersion: string;
  installedReleaseTag: string | null;
  currentCommit: string;
  currentCommitShort: string;
  latestVersion: string | null;
  latestRelease: Omit<GitHubReleaseSummary, 'body'> | null;
  targetCommit: string;
  targetCommitShort: string;
  latestCommitDate: string | null;
  latestCommitMessage: string | null;
  latestCommitAuthor: string | null;
  commitsBehind: number;
  commitsAhead: number;
  compareStatus: string | null;
  localGitAvailable: boolean;
  workingTreeClean: boolean | null;
  dirtyFiles: string[];
  compareMigrationFiles: string[];
  changelog: ThaiChangelogResult;
  tokenConfigured: boolean;
  tokenMaskedHint: string | null;
  fromCache: boolean;
  cacheExpiresAt: string | null;
  cacheTtlMinutes: number;
  isStale?: boolean;
  staleWarningThai?: string | null;
  lastSuccessfulCheckedAt?: string | null;
  cooldownActive?: boolean;
  cooldownUntil?: string | null;
  cooldownUntilThai?: string | null;
  rateLimit: GitHubRateLimitInfo | null;
}

export interface ReadinessCheckItem {
  id: string;
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  blocking: boolean;
  detail: string;
  remediation?: string | null;
}

export interface DeploymentReadinessReport {
  canDeploy: boolean;
  checkedAt: string;
  blockingFailures: number;
  warnings: number;
  passedCount: number;
  totalChecks: number;
  checks: ReadinessCheckItem[];
}

export interface DeploymentFailureDiagnostic {
  exitCode: number;
  failedStepNumber: number | null;
  failedStepName: string;
  errorCode: string;
  detectedCause: string;
  remediation: string;
  rollbackStatus: 'NO_CHANGES_APPLIED' | 'ROLLED_BACK_CODE' | 'MANUAL_DB_RESTORE_REQUIRED' | 'ROLLBACK_FAILED' | 'UNKNOWN';
  rollbackStatusThai: string;
}

export interface GitHubHttpResponse {
  status: number;
  ok: boolean;
  json: unknown;
  headers?: Record<string, string>;
}

export type GitHubFetcher = (url: string, headers: Record<string, string>, timeoutMs: number) => Promise<GitHubHttpResponse>;

interface CachedVersionCheckEntry {
  cacheKey: string;
  cachedAt: number;
  expiresAt: number;
  payload: GitHubVersionCheckResult;
}

interface RateLimitCooldownState {
  blockedUntilMs: number;
  consecutiveCount: number;
  rateLimit: GitHubRateLimitInfo | null;
  errorCode: string;
  statusLabelThai: string;
  githubError: string;
  remediationThai: string;
}

let customGitHubFetcher: GitHubFetcher | null = null;
const versionCheckCache = new Map<string, CachedVersionCheckEntry>();
const lastKnownGoodCache = new Map<string, GitHubVersionCheckResult>();
const inFlightChecks = new Map<string, Promise<GitHubVersionCheckResult>>();
const rateLimitCooldownMap = new Map<string, RateLimitCooldownState>();
const etagResponseCache = new Map<string, { etag: string; response: GitHubHttpResponse }>();

export function clearGitHubUpdateCache(): void {
  versionCheckCache.clear();
  lastKnownGoodCache.clear();
  inFlightChecks.clear();
  rateLimitCooldownMap.clear();
  etagResponseCache.clear();
}

export function setGitHubFetcherForTests(fetcher: GitHubFetcher | null): void {
  customGitHubFetcher = fetcher;
  clearGitHubUpdateCache();
}

export function hasCustomGitHubFetcherForTests(): boolean {
  return customGitHubFetcher !== null;
}

export function clearGitHubUpdateCacheForTests(): void {
  clearGitHubUpdateCache();
}

const GITHUB_API_PREFIX = 'https://api.github.com/repos/';

function runGitCmd(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

export function readPackageVersion(cwd: string = process.cwd()): string {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (parsed.version && typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // fallback below
  }
  return '2.0.0';
}

export function isValidCommitSha(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[a-f0-9]{7,40}$/i.test(value.trim());
}

export async function readInstalledVersionInfo(
  cwd: string = process.cwd(),
  overrideGit?: {
    available: boolean;
    branch: string;
    currentCommit: string;
    workingTreeClean?: boolean | null;
    dirtyFiles?: string[];
    installedReleaseTag?: string | null;
    warning?: string | null;
  }
): Promise<InstalledVersionInfo> {
  const packageVersion = readPackageVersion(cwd);

  if (overrideGit) {
    const validSha = isValidCommitSha(overrideGit.currentCommit) ? overrideGit.currentCommit.trim() : null;
    return {
      packageVersion,
      localGitAvailable: overrideGit.available,
      branch: overrideGit.branch || 'main',
      currentCommit: validSha,
      currentCommitShort: validSha ? validSha.slice(0, 8) : null,
      installedReleaseTag: overrideGit.installedReleaseTag ?? null,
      workingTreeClean: overrideGit.workingTreeClean ?? (overrideGit.available ? true : null),
      dirtyFiles: overrideGit.dirtyFiles ?? [],
      gitWarning: overrideGit.warning ?? null,
    };
  }

  const [branchRes, headRes, tagRes, statusRes] = await Promise.all([
    runGitCmd(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    runGitCmd(['rev-parse', 'HEAD'], cwd),
    runGitCmd(['describe', '--tags', '--exact-match', 'HEAD'], cwd),
    runGitCmd(['status', '--porcelain', '--untracked-files=no'], cwd),
  ]);

  if (!branchRes.ok || !headRes.ok || !isValidCommitSha(headRes.stdout)) {
    const envCommit = process.env.SAM_ATT_INSTALLED_COMMIT?.trim();
    const fallbackSha = isValidCommitSha(envCommit) ? envCommit! : null;
    return {
      packageVersion,
      localGitAvailable: false,
      branch: loadConfig().github.branch,
      currentCommit: fallbackSha,
      currentCommitShort: fallbackSha ? fallbackSha.slice(0, 8) : null,
      installedReleaseTag: null,
      workingTreeClean: null,
      dirtyFiles: [],
      gitWarning:
        'ไม่พบโฟลเดอร์ .git ในสภาพแวดล้อมปัจจุบัน (ไม่สามารถตรวจสอบ Commit SHA ของเครื่องนี้จาก Git โดยตรงได้)',
    };
  }

  const dirtyFiles = statusRes.ok && statusRes.stdout
    ? statusRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];

  return {
    packageVersion,
    localGitAvailable: true,
    branch: branchRes.stdout || loadConfig().github.branch,
    currentCommit: headRes.stdout,
    currentCommitShort: headRes.stdout.slice(0, 8),
    installedReleaseTag: tagRes.ok && tagRes.stdout ? tagRes.stdout : null,
    workingTreeClean: statusRes.ok ? dirtyFiles.length === 0 : null,
    dirtyFiles,
    gitWarning: null,
  };
}

/**
 * ปกปิดข้อมูลความลับทุกประเภทก่อนส่งกลับ API หรือบันทึกลงฐานข้อมูล/Log
 */
export function sanitizeDeploymentLog(text: string, extraSecrets: string[] = []): string {
  let out = String(text || '');
  const cfg = loadConfig();

  const runtimeSecrets = [
    cfg.samAttDb.password,
    cfg.hosofficeDb.password,
    cfg.hosofficeDb.pushWritePassword,
    cfg.auth.jwtSecret,
    cfg.scanner.ingestSharedToken,
    cfg.github.token,
    ...extraSecrets,
  ].filter((s) => typeof s === 'string' && s.length >= 6 && s !== 'CHANGE_ME');

  for (const secret of runtimeSecrets) {
    out = out.split(secret).join('***REDACTED***');
  }

  return out
    .replace(/((?:mysql|https?|ftp):\/\/[^:\s/]+:)([^@\s]+)(@)/gi, '$1***REDACTED***$3')
    .replace(/(Authorization\s*:\s*(?:Bearer|token|Basic)\s+)([^\s"']+)/gi, '$1***REDACTED***')
    .replace(/(\bBearer\s+)([A-Za-z0-9._~+/-]+=*)/gi, '$1***REDACTED***')
    .replace(/\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,})\b/g, '***REDACTED_GITHUB_TOKEN***')
    .replace(/(PASSWORD|PWD|SECRET|TOKEN|API_KEY|MYSQL_PWD)\s*=\s*([^\s;&"']+)/gi, '$1=***REDACTED***')
    .replace(/(--password|-p)\s*=?\s*([^\s;&"']+)/gi, '$1=***REDACTED***');
}

function getTokenScopeFingerprint(token: string): string {
  if (!token) return 'anon';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

function formatThaiResetTime(resetEpochSec: number): string {
  try {
    const dt = new Date(resetEpochSec * 1000);
    return (
      new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(dt) + ' น.'
    );
  } catch {
    return new Date(resetEpochSec * 1000).toISOString();
  }
}

function formatThaiTimestamp(isoOrDate: string | Date): string {
  try {
    const dt = typeof isoOrDate === 'string' ? new Date(isoOrDate) : isoOrDate;
    return (
      new Intl.DateTimeFormat('th-TH', {
        timeZone: 'Asia/Bangkok',
        year: 'numeric',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(dt) + ' น.'
    );
  } catch {
    return typeof isoOrDate === 'string' ? isoOrDate : isoOrDate.toISOString();
  }
}

export function extractRateLimitInfo(headers?: Record<string, string>): GitHubRateLimitInfo | null {
  if (!headers) return null;
  const rawLimit = headers['x-ratelimit-limit'];
  const rawRemaining = headers['x-ratelimit-remaining'];
  const rawReset = headers['x-ratelimit-reset'];
  const rawRetryAfter = headers['retry-after'];

  if (
    rawLimit === undefined &&
    rawRemaining === undefined &&
    rawReset === undefined &&
    rawRetryAfter === undefined
  ) {
    return null;
  }

  const limit = rawLimit !== undefined && /^\d+$/.test(rawLimit.trim()) ? Number(rawLimit.trim()) : null;
  const remaining = rawRemaining !== undefined && /^\d+$/.test(rawRemaining.trim()) ? Number(rawRemaining.trim()) : null;
  const resetEpochSec = rawReset !== undefined && /^\d+$/.test(rawReset.trim()) ? Number(rawReset.trim()) : null;
  let retryAfterSec: number | null = null;
  if (rawRetryAfter !== undefined) {
    const trimmedRetry = rawRetryAfter.trim();
    if (/^\d+$/.test(trimmedRetry)) {
      retryAfterSec = Number(trimmedRetry);
    } else {
      const parsedDate = Date.parse(trimmedRetry);
      if (Number.isFinite(parsedDate)) {
        retryAfterSec = Math.max(1, Math.ceil((parsedDate - Date.now()) / 1000));
      }
    }
  }
  const effectiveResetSec =
    resetEpochSec ?? (retryAfterSec !== null ? Math.ceil((Date.now() + retryAfterSec * 1000) / 1000) : null);
  const resetAt = effectiveResetSec ? new Date(effectiveResetSec * 1000).toISOString() : null;
  const resetAtThai = effectiveResetSec ? formatThaiResetTime(effectiveResetSec) : null;

  return { limit, remaining, resetEpochSec, resetAt, resetAtThai, retryAfterSec };
}

function classifyGitHubHttpFailure(params: {
  status: number;
  json: unknown;
  headers?: Record<string, string>;
  repo: string;
  branch: string;
  tokenConfigured: boolean;
}): {
  errorCode: string;
  statusLabelThai: string;
  githubError: string;
  remediationThai: string;
  rateLimit: GitHubRateLimitInfo | null;
  isRateLimited: boolean;
} {
  const { status, json, headers, repo, branch, tokenConfigured } = params;
  const rateLimit = extractRateLimitInfo(headers);
  const rawGhMsg =
    json && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string'
      ? (json as { message: string }).message
      : `HTTP ${status}`;
  const ghMsg = sanitizeDeploymentLog(rawGhMsg);

  if (status === 401) {
    return {
      errorCode: 'GITHUB_UNAUTHORIZED',
      statusLabelThai: 'GITHUB_TOKEN ไม่ถูกต้องหรือหมดอายุ',
      githubError:
        'GitHub API ปฏิเสธการยืนยันตัวตน (HTTP 401 Unauthorized): ค่า GITHUB_TOKEN ไม่ถูกต้อง ถูกเพิกถอน หรือหมดอายุแล้ว',
      remediationThai:
        'สร้าง Personal Access Token (PAT) ใหม่บน GitHub แล้วกรอกบันทึกในส่วนตั้งค่า GITHUB_TOKEN ด้านล่าง (หรือแก้ไขในไฟล์ .env)',
      rateLimit,
      isRateLimited: false,
    };
  }

  const isRateLimited =
    status === 429 ||
    (status === 403 &&
      (headers?.['x-ratelimit-remaining'] === '0' ||
        Boolean(headers?.['retry-after']) ||
        /rate limit/i.test(rawGhMsg)));

  if (isRateLimited) {
    const resetDetail = rateLimit?.resetAtThai
      ? ` โดยโควตาจะรีเซ็ตเวลา ${rateLimit.resetAtThai}`
      : '';
    const quotaText = rateLimit?.limit ? `${rateLimit.limit.toLocaleString('en-US')} ครั้ง/ชั่วโมง` : tokenConfigured ? '5,000 ครั้ง/ชั่วโมง' : '60 ครั้ง/ชั่วโมง';
    if (!tokenConfigured) {
      return {
        errorCode: 'GITHUB_RATE_LIMITED',
        statusLabelThai: 'เกินโควตาการเรียก GitHub API (Rate Limit)',
        githubError: `GitHub API จำกัดจำนวนครั้งการเรียกแบบไม่ระบุตัวตน (${quotaText})${resetDetail} — แนะนำให้ตั้งค่า GITHUB_TOKEN เพื่อเพิ่มโควตาเป็น 5,000 ครั้ง/ชั่วโมง`,
        remediationThai: rateLimit?.resetAtThai
          ? `กำหนด GITHUB_TOKEN ด้านล่างเพื่อเพิ่มโควตาเป็น 5,000 ครั้ง/ชม. ทันที หรือรอให้โควตารีเซ็ตเวลา ${rateLimit.resetAtThai}`
          : 'กำหนด GITHUB_TOKEN ในฟอร์มด้านล่างเพื่อเพิ่มโควตาเป็น 5,000 ครั้ง/ชม. และลดการยิง API ซ้ำซ้อน',
        rateLimit,
        isRateLimited: true,
      };
    }
    return {
      errorCode: 'GITHUB_RATE_LIMITED',
      statusLabelThai: 'โควตา GitHub API เต็มชั่วคราว (Rate Limit)',
      githubError: `โควตาการเรียก GitHub API ของ Token ปัจจุบัน (${quotaText}) ถูกใช้งานครบแล้ว (HTTP ${status})${resetDetail}`,
      remediationThai: rateLimit?.resetAtThai
        ? `กรุณารอให้โควตา GitHub API รีเซ็ตเวลา ${rateLimit.resetAtThai} แล้วกดตรวจสอบเวอร์ชันล่าสุดใหม่อีกครั้ง`
        : 'กรุณารอสักครู่แล้วกด "ตรวจสอบเวอร์ชันล่าสุดใหม่" อีกครั้ง',
      rateLimit,
      isRateLimited: true,
    };
  }

  if (status === 403) {
    return {
      errorCode: 'GITHUB_FORBIDDEN',
      statusLabelThai: 'ไม่มีสิทธิ์เข้าถึง GitHub Repository (403 Forbidden)',
      githubError: `GitHub API ปฏิเสธสิทธิ์การเข้าถึง ${repo} (HTTP 403: ${ghMsg})`,
      remediationThai:
        'ตรวจสอบสิทธิ์ของ GITHUB_TOKEN (ต้องมีสิทธิ์ repo หรือ Contents: Read) และตรวจสอบว่าไม่ได้ติดข้อจำกัด SSO/องค์กรบน GitHub',
      rateLimit,
      isRateLimited: false,
    };
  }

  if (status === 404) {
    return {
      errorCode: 'GITHUB_NOT_FOUND',
      statusLabelThai: 'ไม่พบ Repository หรือ Token ไม่มีสิทธิ์ repo (404)',
      githubError: tokenConfigured
        ? `ไม่พบ Repository '${repo}' (Branch '${branch}') หรือ GITHUB_TOKEN ปัจจุบันไม่มีสิทธิ์เข้าถึง (HTTP 404 Not Found)`
        : `ไม่พบ Repository '${repo}' (Branch '${branch}') หรือ Repository นี้เป็น Private ซึ่งต้องกำหนด GITHUB_TOKEN ที่มีสิทธิ์ repo (HTTP 404 Not Found)`,
      remediationThai:
        'ตรวจสอบชื่อ Repository/Branch ให้ถูกต้อง และหากเป็น Private Repository กรุณากำหนด GITHUB_TOKEN ที่มีสิทธิ์ repo หรือ Contents: Read-only ในฟอร์มด้านล่าง',
      rateLimit,
      isRateLimited: false,
    };
  }

  return {
    errorCode: `GITHUB_HTTP_${status}`,
    statusLabelThai: `เชื่อมต่อ GitHub ไม่สำเร็จ (HTTP ${status})`,
    githubError: `GitHub API ตอบกลับ HTTP ${status}: ${ghMsg}`,
    remediationThai: 'ตรวจสอบสถานะบริการ GitHub หรือลองกดตรวจสอบเวอร์ชันล่าสุดใหม่อีกครั้ง',
    rateLimit,
    isRateLimited: false,
  };
}

function recordRateLimitCooldown(
  tokenScopeKey: string,
  failure: {
    errorCode: string;
    statusLabelThai: string;
    githubError: string;
    remediationThai: string;
    rateLimit: GitHubRateLimitInfo | null;
    isRateLimited: boolean;
  }
): number | null {
  if (!failure.isRateLimited) return null;
  const now = Date.now();
  const prev = rateLimitCooldownMap.get(tokenScopeKey);
  const consecutiveCount = (prev?.consecutiveCount || 0) + 1;
  let blockedUntilMs: number;

  if (failure.rateLimit?.retryAfterSec && failure.rateLimit.retryAfterSec > 0) {
    blockedUntilMs = now + Math.min(failure.rateLimit.retryAfterSec * 1000, 60 * 60 * 1000);
  } else if (failure.rateLimit?.resetEpochSec) {
    const resetMs = failure.rateLimit.resetEpochSec * 1000;
    blockedUntilMs = resetMs > now ? Math.min(resetMs, now + 2 * 60 * 60 * 1000) : now;
  } else {
    // Bounded exponential backoff (60s -> 120s -> 240s -> 480s -> max 900s)
    const backoffMs = Math.min(15 * 60 * 1000, 60 * 1000 * Math.pow(2, Math.min(consecutiveCount - 1, 4)));
    blockedUntilMs = now + backoffMs;
  }

  if (blockedUntilMs > now) {
    const resetEpochSec = Math.ceil(blockedUntilMs / 1000);
    const enrichedRateLimit: GitHubRateLimitInfo = {
      limit: failure.rateLimit?.limit ?? null,
      remaining: 0,
      resetEpochSec: failure.rateLimit?.resetEpochSec ?? resetEpochSec,
      resetAt: failure.rateLimit?.resetAt ?? new Date(blockedUntilMs).toISOString(),
      resetAtThai: failure.rateLimit?.resetAtThai ?? formatThaiResetTime(resetEpochSec),
      retryAfterSec: failure.rateLimit?.retryAfterSec ?? Math.ceil((blockedUntilMs - now) / 1000),
    };
    rateLimitCooldownMap.set(tokenScopeKey, {
      blockedUntilMs,
      consecutiveCount,
      rateLimit: enrichedRateLimit,
      errorCode: failure.errorCode,
      statusLabelThai: failure.statusLabelThai,
      githubError: failure.githubError,
      remediationThai: failure.remediationThai,
    });
    return blockedUntilMs;
  }
  return null;
}

function classifyGitHubNetworkFailure(err: unknown, timeoutMs: number): {
  errorCode: string;
  statusLabelThai: string;
  githubError: string;
  remediationThai: string;
} {
  const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort|timeout/i.test(err.message));
  const detail = err instanceof Error ? sanitizeDeploymentLog(err.message) : '';
  if (isAbort) {
    return {
      errorCode: 'GITHUB_TIMEOUT',
      statusLabelThai: 'หมดเวลาเชื่อมต่อ api.github.com (Timeout)',
      githubError: `เซิร์ฟเวอร์ไม่สามารถเชื่อมต่อ https://api.github.com ได้ทันภายใน ${timeoutMs} ms (อาจติด Firewall, Proxy หรืออินเทอร์เน็ตขัดข้อง)`,
      remediationThai:
        'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตของเซิร์ฟเวอร์ และตรวจสอบ Firewall ขาออก (HTTPS พอร์ต 443 ไปยัง api.github.com)',
    };
  }
  return {
    errorCode: 'GITHUB_NETWORK_ERROR',
    statusLabelThai: 'เซิร์ฟเวอร์เชื่อมต่อ api.github.com ไม่ได้ (Network/Firewall)',
    githubError: `เซิร์ฟเวอร์ไม่สามารถเชื่อมต่ออินเทอร์เน็ตหรือ https://api.github.com ได้${detail ? ` (${detail})` : ''} กรุณาตรวจสอบเครือข่ายหรือ Firewall`,
    remediationThai:
      'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต DNS และกฎ Firewall ของเซิร์ฟเวอร์ให้อนุญาตเชื่อมต่อไปยัง api.github.com พอร์ต 443',
  };
}

async function fetchGitHubJson(apiPath: string): Promise<GitHubHttpResponse> {
  const cfg = loadConfig();
  const repo = cfg.github.repo;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('INVALID_GITHUB_REPO_FORMAT');
  }
  const normalizedPath = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const fullUrl = `${GITHUB_API_PREFIX}${repo}${normalizedPath}`;
  if (!fullUrl.startsWith(GITHUB_API_PREFIX)) {
    throw new Error('SSRF_BLOCKED_GITHUB_URL');
  }

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Sam-Att-Updater',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (cfg.github.token) {
    headers.Authorization = `Bearer ${cfg.github.token}`;
  }

  const etagKey = `${getTokenScopeFingerprint(cfg.github.token)}::${fullUrl}`;
  const cachedEtagEntry = etagResponseCache.get(etagKey);
  if (cachedEtagEntry?.etag) {
    headers['If-None-Match'] = cachedEtagEntry.etag;
  }

  let response: GitHubHttpResponse;
  if (customGitHubFetcher) {
    response = await customGitHubFetcher(fullUrl, headers, cfg.github.timeoutMs);
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.github.timeoutMs);
    try {
      const res = await fetch(fullUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = { raw: text.slice(0, 500) };
      }
      const headerMap: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        headerMap[k.toLowerCase()] = v;
      });
      response = { status: res.status, ok: res.ok, json, headers: headerMap };
    } finally {
      clearTimeout(timer);
    }
  }

  // Conditional Request 304 Not Modified: ใช้ข้อมูลเดิมใน Cache โดยไม่เสียโควตา Rate Limit
  if (response.status === 304 && cachedEtagEntry) {
    const mergedHeaders = {
      ...(cachedEtagEntry.response.headers || {}),
      ...(response.headers || {}),
    };
    return {
      ...cachedEtagEntry.response,
      headers: mergedHeaders,
    };
  }

  const normalizedHeaders: Record<string, string> = {};
  if (response.headers) {
    for (const [k, v] of Object.entries(response.headers)) {
      normalizedHeaders[k.toLowerCase()] = v;
    }
  }
  const responseEtag = normalizedHeaders.etag;
  if (response.ok && responseEtag) {
    if (etagResponseCache.size >= 100) {
      const firstKey = etagResponseCache.keys().next().value;
      if (firstKey) etagResponseCache.delete(firstKey);
    }
    etagResponseCache.set(etagKey, {
      etag: responseEtag,
      response: { ...response, headers: normalizedHeaders },
    });
  }

  return { ...response, headers: normalizedHeaders };
}

function emptyCategories(): Record<ChangelogCategoryKey, ChangelogEntry[]> {
  return {
    features: [],
    fixes: [],
    improvements: [],
    security: [],
    database: [],
    breaking: [],
  };
}

function classifyChangeCategory(text: string, hintHeading?: string): ChangelogCategoryKey {
  const lowerText = text.toLowerCase().trim();
  const lowerHeading = (hintHeading || '').toLowerCase().trim();
  const combined = `${lowerHeading} ${lowerText}`;

  // 1. Explicit breaking-change markers or headings
  if (
    /^breaking\b|breaking[\s_-]?change|^[a-z]+(\([^)]*\))?!:|กระทบการใช้งาน|incompatible|ต้องตั้งค่าใหม่|migrate manually/i.test(
      lowerText
    ) ||
    /กระทบการใช้งาน|breaking/i.test(lowerHeading)
  ) {
    return 'breaking';
  }

  // 2. Explicit Markdown / Release Note Section Heading takes priority
  if (/ความปลอดภัย|security/i.test(lowerHeading)) return 'security';
  if (/ฐานข้อมูล|database|migration/i.test(lowerHeading)) return 'database';
  if (/แก้ไขข้อผิดพลาด|bug\s*fix|fixes|fixed/i.test(lowerHeading)) return 'fixes';
  if (/ฟีเจอร์ใหม่|features?|added/i.test(lowerHeading)) return 'features';
  if (/กระทบการใช้งาน|breaking/i.test(lowerHeading)) return 'breaking';
  if (/ปรับปรุงระบบ|improvements?|changed/i.test(lowerHeading)) return 'improvements';

  // 3. Conventional commit prefixes or strong domain keywords
  if (/^(security)(\(|:|\s)/i.test(lowerText)) return 'security';
  if (/^(fix|bugfix|hotfix)(\(|:|\s)/i.test(lowerText)) return 'fixes';
  if (/^(feat|feature)(\(|:|\s)/i.test(lowerText)) return 'features';

  if (
    /security|ความปลอดภัย|rbac|auth|reauth|password|token|secret|xss|csrf|ssrf|sql injection|cve|sanitize|redact|acl|permission|สิทธิ์/i.test(
      combined
    )
  ) {
    return 'security';
  }
  if (
    /database|migration|schema|mysql|sql\b|table|column|index|ฐานข้อมูล|ตาราง|คอลัมน์|schema_migrations|backup\.ps1|restore/i.test(
      combined
    )
  ) {
    return 'database';
  }
  if (
    /แก้ไขข้อผิดพลาด|แก้บั๊ก|แก้ปัญหา|แก้ไขปัญหา|422|exit code|crash|bug\b|broken|repair|patch/i.test(
      combined
    )
  ) {
    return 'fixes';
  }
  if (/ฟีเจอร์ใหม่|เพิ่มฟีเจอร์|เพิ่มเมนู|เพิ่มหน้า|เพิ่มความสามารถ|^add\s|^new\s|^support\s/i.test(lowerText)) {
    return 'features';
  }
  return 'improvements';
}

function formatThaiSummaryTitle(rawLine: string, category: ChangelogCategoryKey): { title: string; isAuto: boolean } {
  const cleaned = rawLine
    .replace(/^[-*•]\s*/, '')
    .replace(/^\*\*([^*]+)\*\*\s*:?\s*/, '$1: ')
    .trim();

  // หากข้อความมีภาษาไทยอยู่แล้ว ใช้ข้อความจริงโดยตรงโดยไม่แต่งเติม
  if (/[\u0E00-\u0E7F]/.test(cleaned)) {
    return { title: cleaned, isAuto: false };
  }

  // หากเป็น Conventional Commit / ภาษาอังกฤษ แปลงคำนำหน้าเป็นภาษาไทยที่อ่านง่ายพร้อมคงเนื้อหาจริงไว้ครบถ้วน
  const stripped = cleaned.replace(/^(feat|fix|refactor|perf|chore|docs|style|test|build|ci|security)(\([^)]*\))?!?:\s*/i, '').trim();
  const prefixMap: Record<ChangelogCategoryKey, string> = {
    features: 'ฟีเจอร์ใหม่:',
    fixes: 'แก้ไขข้อผิดพลาด:',
    improvements: 'ปรับปรุงระบบ:',
    security: 'ความปลอดภัย:',
    database: 'ฐานข้อมูล:',
    breaking: 'อาจกระทบการใช้งาน:',
  };
  return {
    title: `${prefixMap[category]} ${stripped || cleaned}`,
    isAuto: true,
  };
}

function parseMarkdownBullets(
  markdown: string,
  sourceRef: string,
  date: string | null,
  url: string | null,
  categories: Record<ChangelogCategoryKey, ChangelogEntry[]>
): { count: number; hasAuto: boolean } {
  let count = 0;
  let hasAuto = false;
  let currentHeading = '';
  const lines = String(markdown || '').split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,4}\s+/.test(line)) {
      currentHeading = line.replace(/^#{1,4}\s+/, '').trim();
      continue;
    }
    if (/^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const content = line.replace(/^([-*•]|\d+\.)\s+/, '').trim();
      if (!content || content.length < 3) continue;
      // ข้ามบรรทัด Full Changelog ลิงก์เปรียบเทียบอย่างเดียว
      if (/^full changelog\s*:/i.test(content)) continue;

      const cat = classifyChangeCategory(content, currentHeading);
      const formatted = formatThaiSummaryTitle(content, cat);
      if (formatted.isAuto) hasAuto = true;
      categories[cat].push({
        id: `${sourceRef}-${cat}-${count + 1}`,
        category: cat,
        title: formatted.title,
        rawText: content,
        sourceRef,
        date,
        url,
        isAutoCategorized: formatted.isAuto,
      });
      count += 1;
    }
  }

  return { count, hasAuto };
}

function parseChangelogMd(
  markdown: string,
  installedVersion: string,
  repoUrl: string,
  categories: Record<ChangelogCategoryKey, ChangelogEntry[]>
): { count: number; hasAuto: boolean; matchedVersions: string[] } {
  const lines = String(markdown || '').split(/\r?\n/);
  const matchedVersions: string[] = [];
  let inRelevantVersion = false;
  let currentVersionRef = 'CHANGELOG.md';
  let currentHeading = '';
  let count = 0;
  let hasAuto = false;

  const cleanInstalled = installedVersion.replace(/^v/i, '').trim();

  for (const raw of lines) {
    const line = raw.trim();
    const versionMatch = line.match(/^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9A-Za-z.-]+|Unreleased)\]?/i);
    if (versionMatch) {
      const ver = versionMatch[1].trim();
      if (ver.replace(/^v/i, '') === cleanInstalled) {
        // หยุดเมื่อถึงเวอร์ชันที่ติดตั้งอยู่แล้ว
        break;
      }
      inRelevantVersion = true;
      currentVersionRef = ver === 'Unreleased' ? 'Unreleased' : `v${ver.replace(/^v/i, '')}`;
      matchedVersions.push(currentVersionRef);
      currentHeading = '';
      continue;
    }

    if (!inRelevantVersion) continue;
    if (/^###\s+/.test(line)) {
      currentHeading = line.replace(/^###\s+/, '').trim();
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      const content = line.replace(/^[-*•]\s+/, '').trim();
      if (!content || content.length < 3) continue;
      const cat = classifyChangeCategory(content, currentHeading);
      const formatted = formatThaiSummaryTitle(content, cat);
      if (formatted.isAuto) hasAuto = true;
      categories[cat].push({
        id: `changelog-${currentVersionRef}-${count + 1}`,
        category: cat,
        title: formatted.title,
        rawText: content,
        sourceRef: currentVersionRef,
        url: `${repoUrl}/blob/main/CHANGELOG.md`,
        isAutoCategorized: formatted.isAuto,
      });
      count += 1;
    }
  }

  return { count, hasAuto, matchedVersions };
}

function normalizeTagVersion(tag: string | null | undefined): string | null {
  if (!tag) return null;
  return tag.trim().replace(/^v/i, '');
}

function selectRelevantReleases(
  releases: GitHubReleaseSummary[],
  installedTag: string | null,
  installedVersion: string,
  compareCommitsSet: Set<string>
): GitHubReleaseSummary[] {
  if (releases.length === 0) return [];
  const normInstalledTag = normalizeTagVersion(installedTag);
  const normPkgVersion = normalizeTagVersion(installedVersion);

  const selected: GitHubReleaseSummary[] = [];
  for (const rel of releases) {
    const normRel = normalizeTagVersion(rel.tagName);
    if (normInstalledTag && normRel === normInstalledTag) {
      break;
    }
    if (!normInstalledTag && normPkgVersion && normRel === normPkgVersion && compareCommitsSet.size === 0) {
      break;
    }
    selected.push(rel);
  }
  return selected;
}

export async function checkGitHubUpdates(options?: {
  forceRefresh?: boolean;
  cwd?: string;
  overrideGit?: {
    available: boolean;
    branch: string;
    currentCommit: string;
    workingTreeClean?: boolean | null;
    dirtyFiles?: string[];
    installedReleaseTag?: string | null;
    warning?: string | null;
  };
}): Promise<GitHubVersionCheckResult> {
  const cfg = loadConfig();
  const repo = cfg.github.repo;
  const repoUrl = `https://github.com/${repo}`;
  const checkedAt = new Date().toISOString();
  const cacheTtlMs = cfg.github.cacheTtlMs;
  const cacheTtlMinutes = Math.max(1, Math.round(cacheTtlMs / 60000));

  const installed = await readInstalledVersionInfo(options?.cwd || process.cwd(), options?.overrideGit);
  const branch = cfg.github.branch || installed.branch || 'main';
  const tokenScopeKey = getTokenScopeFingerprint(cfg.github.token);
  const cacheKey = `${repo}|${branch}|${tokenScopeKey}|${installed.currentCommit || 'none'}`;
  const forceRefresh = Boolean(options?.forceRefresh);

  // 1. ใช้ Shared In-memory Cache (ค่าเริ่มต้น 30 นาที) เมื่อไม่ได้สั่ง ?force=true
  const cachedEntry = versionCheckCache.get(cacheKey);
  if (!forceRefresh && cachedEntry && cachedEntry.expiresAt > Date.now()) {
    return {
      ...cachedEntry.payload,
      fromCache: true,
      isStale: false,
      staleWarningThai: null,
      lastSuccessfulCheckedAt: cachedEntry.payload.checkedAt,
      cooldownActive: false,
      cooldownUntil: null,
      cooldownUntilThai: null,
      cacheExpiresAt: new Date(cachedEntry.expiresAt).toISOString(),
      cacheTtlMinutes,
    };
  }

  const makeEmptyChangelog = (noticeThai: string): ThaiChangelogResult => ({
    sourceType: 'NONE',
    sourceLabelThai: 'ยังไม่มีข้อมูลการเปลี่ยนแปลง',
    hasOfficialReleaseNotes: false,
    isAutomatedThaiSummary: false,
    noticeThai,
    versionRangeLabel: installed.currentCommitShort || installed.packageVersion,
    isMultiVersionJump: false,
    includedReleases: [],
    totalEntries: 0,
    categories: emptyCategories(),
  });

  const buildUnreachableResult = (failure: {
    errorCode: string;
    statusLabelThai: string;
    githubError: string;
    remediationThai: string;
    rateLimit: GitHubRateLimitInfo | null;
    changelogNotice: string;
    cooldownUntilMs?: number | null;
    allowStaleFallback?: boolean;
  }): GitHubVersionCheckResult => {
    const cooldownActive = Boolean(failure.cooldownUntilMs && failure.cooldownUntilMs > Date.now());
    const cooldownUntil = cooldownActive ? new Date(failure.cooldownUntilMs!).toISOString() : null;
    const cooldownUntilThai = cooldownActive
      ? formatThaiResetTime(Math.ceil(failure.cooldownUntilMs! / 1000))
      : null;

    const lastGood = failure.allowStaleFallback !== false ? lastKnownGoodCache.get(cacheKey) : undefined;
    if (lastGood) {
      return {
        ...lastGood,
        checkedAt,
        status: 'GITHUB_UNREACHABLE',
        statusLabelThai: failure.statusLabelThai,
        githubReachable: false,
        githubError: failure.githubError,
        githubErrorCode: failure.errorCode,
        remediationThai: failure.remediationThai,
        tokenConfigured: cfg.github.tokenConfigured,
        tokenMaskedHint: cfg.github.tokenMaskedHint,
        fromCache: true,
        cacheExpiresAt: null,
        cacheTtlMinutes,
        isStale: true,
        staleWarningThai: `ไม่สามารถเชื่อมต่อ GitHub API ได้ (${failure.statusLabelThai}) — กำลังแสดงข้อมูลเวอร์ชันล่าสุดที่บันทึกไว้เมื่อ ${formatThaiTimestamp(lastGood.checkedAt)}`,
        lastSuccessfulCheckedAt: lastGood.checkedAt,
        cooldownActive,
        cooldownUntil,
        cooldownUntilThai,
        rateLimit: failure.rateLimit ?? lastGood.rateLimit,
      };
    }

    return {
      repository: repo,
      repositoryUrl: repoUrl,
      branch,
      checkedAt,
      status: 'GITHUB_UNREACHABLE',
      statusLabelThai: failure.statusLabelThai,
      hasUpdates: false,
      githubReachable: false,
      githubError: failure.githubError,
      githubErrorCode: failure.errorCode,
      remediationThai: failure.remediationThai,
      installedVersion: installed.packageVersion,
      installedReleaseTag: installed.installedReleaseTag,
      currentCommit: installed.currentCommit || 'unknown',
      currentCommitShort: installed.currentCommitShort || 'unknown',
      latestVersion: null,
      latestRelease: null,
      targetCommit: installed.currentCommit || 'unknown',
      targetCommitShort: installed.currentCommitShort || 'unknown',
      latestCommitDate: null,
      latestCommitMessage: null,
      latestCommitAuthor: null,
      commitsBehind: 0,
      commitsAhead: 0,
      compareStatus: null,
      localGitAvailable: installed.localGitAvailable,
      workingTreeClean: installed.workingTreeClean,
      dirtyFiles: installed.dirtyFiles,
      compareMigrationFiles: [],
      changelog: makeEmptyChangelog(failure.changelogNotice),
      tokenConfigured: cfg.github.tokenConfigured,
      tokenMaskedHint: cfg.github.tokenMaskedHint,
      fromCache: false,
      cacheExpiresAt: null,
      cacheTtlMinutes,
      isStale: false,
      staleWarningThai: null,
      lastSuccessfulCheckedAt: null,
      cooldownActive,
      cooldownUntil,
      cooldownUntilThai,
      rateLimit: failure.rateLimit,
    };
  };

  // 2. Rate-Limit Cooldown Guard: หยุดยิง GitHub API จนกว่าจะพ้นเวลา reset (แม้กด refresh ซ้ำในช่วง cooldown)
  const activeCooldown = rateLimitCooldownMap.get(tokenScopeKey);
  if (activeCooldown && activeCooldown.blockedUntilMs > Date.now()) {
    const cooldownThai = formatThaiResetTime(Math.ceil(activeCooldown.blockedUntilMs / 1000));
    return buildUnreachableResult({
      errorCode: activeCooldown.errorCode,
      statusLabelThai: activeCooldown.statusLabelThai,
      githubError: `${activeCooldown.githubError} (ระบบพักการเรียก GitHub API อัตโนมัติถึงเวลา ${cooldownThai} เพื่อป้องกัน Rate Limit)`,
      remediationThai: activeCooldown.remediationThai,
      rateLimit: activeCooldown.rateLimit,
      changelogNotice: 'อยู่ในช่วงพักการเรียก GitHub API ชั่วคราวหลังติด Rate Limit',
      cooldownUntilMs: activeCooldown.blockedUntilMs,
      allowStaleFallback: true,
    });
  } else if (activeCooldown && activeCooldown.blockedUntilMs <= Date.now()) {
    rateLimitCooldownMap.delete(tokenScopeKey);
  }

  // 3. Single-Flight Request Deduplication: รวมคำขอที่เข้ามาพร้อมกันให้ยิง GitHub API เพียงชุดเดียว
  const forceFlightKey = `${cacheKey}|force`;
  const normalFlightKey = `${cacheKey}|normal`;
  if (!forceRefresh) {
    const existingFlight = inFlightChecks.get(forceFlightKey) || inFlightChecks.get(normalFlightKey);
    if (existingFlight) {
      return existingFlight;
    }
  } else {
    const existingForceFlight = inFlightChecks.get(forceFlightKey);
    if (existingForceFlight) {
      return existingForceFlight;
    }
  }

  const flightKey = forceRefresh ? forceFlightKey : normalFlightKey;

  const runLiveCheck = async (): Promise<GitHubVersionCheckResult> => {
    // 1. ตรวจสอบ Branch HEAD Commit จาก GitHub (Read-Only)
    let branchRes: GitHubHttpResponse;
    try {
      branchRes = await fetchGitHubJson(`/commits/${encodeURIComponent(branch)}`);
    } catch (err: unknown) {
      const netErr = classifyGitHubNetworkFailure(err, cfg.github.timeoutMs);
      return buildUnreachableResult({
        ...netErr,
        rateLimit: null,
        changelogNotice: 'ไม่สามารถดึงรายละเอียดการเปลี่ยนแปลงได้เนื่องจากไม่สามารถเชื่อมต่อ api.github.com',
        allowStaleFallback: true,
      });
    }

    let latestRateLimit = extractRateLimitInfo(branchRes.headers);

    if (!branchRes.ok || !branchRes.json || typeof branchRes.json !== 'object') {
      const httpErr = classifyGitHubHttpFailure({
        status: branchRes.status,
        json: branchRes.json,
        headers: branchRes.headers,
        repo,
        branch,
        tokenConfigured: cfg.github.tokenConfigured,
      });
      const cooldownUntilMs = recordRateLimitCooldown(tokenScopeKey, httpErr);
      const allowStale =
        httpErr.errorCode !== 'GITHUB_UNAUTHORIZED' &&
        httpErr.errorCode !== 'GITHUB_FORBIDDEN' &&
        httpErr.errorCode !== 'GITHUB_NOT_FOUND';
      return buildUnreachableResult({
        ...httpErr,
        cooldownUntilMs,
        allowStaleFallback: allowStale,
        changelogNotice: 'ไม่สามารถดึงรายละเอียดการเปลี่ยนแปลงได้เนื่องจาก GitHub API ตอบกลับข้อผิดพลาด',
      });
    }

    const branchData = branchRes.json as {
      sha?: string;
      commit?: {
        message?: string;
        author?: { name?: string; date?: string };
        committer?: { name?: string; date?: string };
      };
      html_url?: string;
    };

  const targetCommit = String(branchData.sha || '').trim();
  const targetCommitShort = targetCommit ? targetCommit.slice(0, 8) : 'unknown';
  const latestCommitMessage = branchData.commit?.message?.split(/\r?\n/)[0]?.trim() || null;
  const latestCommitDate = branchData.commit?.committer?.date || branchData.commit?.author?.date || null;
  const latestCommitAuthor = branchData.commit?.author?.name || branchData.commit?.committer?.name || null;

  // 2. ดึง GitHub Releases (สูงสุด 20 รายการล่าสุด)
  let releases: GitHubReleaseSummary[] = [];
  try {
    const relRes = await fetchGitHubJson('/releases?per_page=20');
    latestRateLimit = extractRateLimitInfo(relRes.headers) || latestRateLimit;
    if (relRes.ok && Array.isArray(relRes.json)) {
      releases = (relRes.json as Array<Record<string, unknown>>)
        .filter((r) => r && r.draft !== true && typeof r.tag_name === 'string')
        .map((r) => ({
          tagName: String(r.tag_name),
          name: String(r.name || r.tag_name),
          publishedAt: typeof r.published_at === 'string' ? r.published_at : null,
          targetCommitish: String(r.target_commitish || branch),
          prerelease: Boolean(r.prerelease),
          url: typeof r.html_url === 'string' ? r.html_url : null,
          body: typeof r.body === 'string' ? r.body : '',
        }));
    } else if (
      relRes.status === 401 ||
      relRes.status === 429 ||
      (relRes.status === 403 &&
        (relRes.headers?.['x-ratelimit-remaining'] === '0' || Boolean(relRes.headers?.['retry-after'])))
    ) {
      const httpErr = classifyGitHubHttpFailure({
        status: relRes.status,
        json: relRes.json,
        headers: relRes.headers,
        repo,
        branch,
        tokenConfigured: cfg.github.tokenConfigured,
      });
      const cooldownUntilMs = recordRateLimitCooldown(tokenScopeKey, httpErr);
      return buildUnreachableResult({
        ...httpErr,
        cooldownUntilMs,
        allowStaleFallback: httpErr.errorCode !== 'GITHUB_UNAUTHORIZED',
        changelogNotice: 'ไม่สามารถดึงข้อมูล Release Notes ได้เนื่องจาก GitHub API ปฏิเสธคำขอ',
      });
    }
  } catch {
    // ไม่ให้ Releases error ชั่วคราวทำให้ version check ทั้งหมดพัง — ดำเนินการต่อด้วย Commit API
  }

  const latestReleaseFull = releases[0] || null;
  const latestRelease = latestReleaseFull
    ? {
        tagName: latestReleaseFull.tagName,
        name: latestReleaseFull.name,
        publishedAt: latestReleaseFull.publishedAt,
        targetCommitish: latestReleaseFull.targetCommitish,
        prerelease: latestReleaseFull.prerelease,
        url: latestReleaseFull.url,
      }
    : null;

  // 3. เปรียบเทียบ Commit ระหว่างเครื่องปัจจุบันกับ GitHub (Compare API)
  let compareStatus: string | null = null;
  let commitsBehind = 0;
  let commitsAhead = 0;
  let compareCommits: Array<{
    sha: string;
    message: string;
    author: string | null;
    date: string | null;
    url: string | null;
  }> = [];
  let compareMigrationFiles: string[] = [];
  let compareNotFound = false;

  const hasVerifiedLocalCommit = isValidCommitSha(installed.currentCommit);

  if (hasVerifiedLocalCommit && targetCommit && installed.currentCommit !== targetCommit) {
    try {
      const cmpRes = await fetchGitHubJson(
        `/compare/${encodeURIComponent(installed.currentCommit!)}...${encodeURIComponent(targetCommit)}`
      );
      latestRateLimit = extractRateLimitInfo(cmpRes.headers) || latestRateLimit;
      if (cmpRes.ok && cmpRes.json && typeof cmpRes.json === 'object') {
        const cmp = cmpRes.json as {
          status?: string;
          ahead_by?: number;
          behind_by?: number;
          commits?: Array<{
            sha?: string;
            html_url?: string;
            commit?: {
              message?: string;
              author?: { name?: string; date?: string };
              committer?: { name?: string; date?: string };
            };
          }>;
          files?: Array<{ filename?: string; status?: string }>;
        };
        compareStatus = cmp.status || null;
        // หมายเหตุ GitHub Compare base...head: ahead_by คือจำนวน commit ที่ head (GitHub) นำหน้า base (เครื่องปัจจุบัน)
        commitsBehind = Number(cmp.ahead_by || 0);
        commitsAhead = Number(cmp.behind_by || 0);
        compareCommits = (cmp.commits || [])
          .filter((c) => c && typeof c.sha === 'string')
          .map((c) => ({
            sha: String(c.sha),
            message: String(c.commit?.message || '').trim(),
            author: c.commit?.author?.name || c.commit?.committer?.name || null,
            date: c.commit?.committer?.date || c.commit?.author?.date || null,
            url: c.html_url || `${repoUrl}/commit/${c.sha}`,
          }));
        compareMigrationFiles = (cmp.files || [])
          .map((f) => String(f?.filename || '').trim())
          .filter((fn) => /^database\/migrations\/.+\.sql$/i.test(fn))
          .map((fn) => path.basename(fn))
          .sort();
      } else if (cmpRes.status === 404) {
        compareNotFound = true;
      } else if (
        cmpRes.status === 401 ||
        cmpRes.status === 429 ||
        (cmpRes.status === 403 &&
          (cmpRes.headers?.['x-ratelimit-remaining'] === '0' || Boolean(cmpRes.headers?.['retry-after'])))
      ) {
        const httpErr = classifyGitHubHttpFailure({
          status: cmpRes.status,
          json: cmpRes.json,
          headers: cmpRes.headers,
          repo,
          branch,
          tokenConfigured: cfg.github.tokenConfigured,
        });
        const cooldownUntilMs = recordRateLimitCooldown(tokenScopeKey, httpErr);
        return buildUnreachableResult({
          ...httpErr,
          cooldownUntilMs,
          allowStaleFallback: httpErr.errorCode !== 'GITHUB_UNAUTHORIZED',
          changelogNotice: 'ไม่สามารถเปรียบเทียบประวัติ Commit ได้เนื่องจาก GitHub API ปฏิเสธคำขอ',
        });
      }
    } catch {
      // fallback safely
    }
  } else if (hasVerifiedLocalCommit && targetCommit && installed.currentCommit === targetCommit) {
    compareStatus = 'identical';
    commitsBehind = 0;
    commitsAhead = 0;
  }

  // 4. คำนวณสถานะเวอร์ชันจริงตามหลักฐาน GitHub
  let status: UpdateStatus;
  let statusLabelThai: string;
  let hasUpdates = false;

  if (!hasVerifiedLocalCommit) {
    status = 'LOCAL_GIT_UNAVAILABLE';
    statusLabelThai = 'ไม่สามารถยืนยัน Commit บนเครื่องปัจจุบัน (ไม่พบ .git)';
    hasUpdates = false;
  } else if (installed.currentCommit === targetCommit || (compareStatus === 'identical' && commitsBehind === 0 && commitsAhead === 0)) {
    status = 'UP_TO_DATE';
    statusLabelThai = 'เป็นเวอร์ชันล่าสุดแล้ว';
    hasUpdates = false;
  } else if (compareNotFound || compareStatus === 'diverged' || (compareStatus === 'ahead' && commitsBehind === 0)) {
    status = 'HISTORY_DIVERGED';
    statusLabelThai = compareNotFound
      ? 'ไม่พบ Commit ของเครื่องปัจจุบันบน GitHub (ประวัติแยกสาย)'
      : 'ประวัติ Commit ของเครื่องปัจจุบันแยกสายจาก GitHub';
    hasUpdates = false;
  } else if (commitsBehind > 0) {
    // ตรวจสอบว่ามี GitHub Release ใหม่ที่ครอบคลุมอัปเดตนี้หรือไม่
    const installedNorm = normalizeTagVersion(installed.installedReleaseTag);
    const latestRelNorm = normalizeTagVersion(latestReleaseFull?.tagName);
    const hasNewerRelease =
      Boolean(latestReleaseFull) &&
      (!installedNorm || latestRelNorm !== installedNorm) &&
      (installed.installedReleaseTag !== null ||
        normalizeTagVersion(installed.packageVersion) !== latestRelNorm);

    if (hasNewerRelease) {
      status = 'UPDATE_AVAILABLE';
      statusLabelThai = `มีเวอร์ชันใหม่พร้อมอัปเดต (${latestReleaseFull!.tagName})`;
      hasUpdates = true;
    } else {
      status = 'COMMIT_AHEAD_NO_RELEASE';
      statusLabelThai = `มี Commit ใหม่ ${commitsBehind} รายการบน Branch ${branch} (ยังไม่มี Release Tag ใหม่)`;
      hasUpdates = true;
    }
  } else {
    status = 'UP_TO_DATE';
    statusLabelThai = 'เป็นเวอร์ชันล่าสุดแล้ว';
    hasUpdates = false;
  }

  // 5. สร้าง Thai Changelog ตามลำดับความสำคัญ: (1) GitHub Releases -> (2) CHANGELOG.md -> (3) GitHub Compare/Commits
  const categories = emptyCategories();
  let sourceType: ChangelogSourceType = 'NONE';
  let sourceLabelThai = 'ไม่มีรายการเปลี่ยนแปลงใหม่';
  let hasOfficialReleaseNotes = false;
  let isAutomatedThaiSummary = false;
  let noticeThai = 'ระบบเป็นเวอร์ชันล่าสุดตรงกับ GitHub แล้ว';
  let includedReleases: ThaiChangelogResult['includedReleases'] = [];
  let isMultiVersionJump = false;
  const versionRangeLabel = hasVerifiedLocalCommit
    ? `${installed.installedReleaseTag || installed.currentCommitShort} → ${
        latestReleaseFull && status === 'UPDATE_AVAILABLE' ? latestReleaseFull.tagName : targetCommitShort
      }`
    : `${installed.packageVersion} (เครื่องปัจจุบัน) ↔ ${latestReleaseFull?.tagName || targetCommitShort} (GitHub)`;

  const compareShaSet = new Set(compareCommits.map((c) => c.sha));

  if (status === 'UPDATE_AVAILABLE' || status === 'COMMIT_AHEAD_NO_RELEASE' || status === 'LOCAL_GIT_UNAVAILABLE') {
    // 5.1 ลำดับที่ 1: GitHub Releases
    const relevantReleases = selectRelevantReleases(
      releases,
      installed.installedReleaseTag,
      installed.packageVersion,
      compareShaSet
    );
    const releasesWithNotes = relevantReleases.filter((r) => r.body && r.body.trim().length > 0);

    if (releasesWithNotes.length > 0 && status !== 'COMMIT_AHEAD_NO_RELEASE') {
      let totalFromReleases = 0;
      let anyAuto = false;
      for (const rel of releasesWithNotes) {
        const parsed = parseMarkdownBullets(rel.body, rel.tagName, rel.publishedAt, rel.url, categories);
        totalFromReleases += parsed.count;
        if (parsed.hasAuto) anyAuto = true;
      }
      if (totalFromReleases > 0) {
        sourceType = 'GITHUB_RELEASES';
        hasOfficialReleaseNotes = true;
        isAutomatedThaiSummary = anyAuto;
        includedReleases = releasesWithNotes.map((r) => ({
          tagName: r.tagName,
          name: r.name,
          publishedAt: r.publishedAt,
          url: r.url,
        }));
        isMultiVersionJump = releasesWithNotes.length > 1;
        sourceLabelThai = isMultiVersionJump
          ? `GitHub Releases (สรุปรวม ${releasesWithNotes.length} เวอร์ชัน)`
          : `GitHub Release (${releasesWithNotes[0].tagName})`;
        noticeThai = anyAuto
          ? 'อ้างอิงจาก Release Notes จริงบน GitHub โดยจัดหมวดหมู่และแปลคำนำหน้าภาษาไทยอัตโนมัติ (สามารถตรวจสอบข้อความต้นฉบับได้ในแต่ละรายการ)'
          : 'อ้างอิงจาก Release Notes อย่างเป็นทางการบน GitHub โดยตรง';
      }
    }

    // 5.2 ลำดับที่ 2: CHANGELOG.md (จาก GitHub API)
    if (sourceType === 'NONE') {
      try {
        const clRes = await fetchGitHubJson(`/contents/CHANGELOG.md?ref=${encodeURIComponent(branch)}`);
        if (clRes.ok && clRes.json && typeof clRes.json === 'object') {
          const contentB64 = String((clRes.json as { content?: string }).content || '').replace(/\s+/g, '');
          if (contentB64) {
            const decoded = Buffer.from(contentB64, 'base64').toString('utf8');
            const parsedCl = parseChangelogMd(decoded, installed.packageVersion, repoUrl, categories);
            if (parsedCl.count > 0) {
              sourceType = 'CHANGELOG_MD';
              hasOfficialReleaseNotes = true;
              isAutomatedThaiSummary = parsedCl.hasAuto;
              isMultiVersionJump = parsedCl.matchedVersions.length > 1;
              sourceLabelThai = `ไฟล์ CHANGELOG.md (${parsedCl.matchedVersions.join(', ')})`;
              noticeThai = parsedCl.hasAuto
                ? 'ดึงจากไฟล์ CHANGELOG.md ใน Repository พร้อมจัดหมวดหมู่ภาษาไทยอัตโนมัติ'
                : 'ดึงจากไฟล์ CHANGELOG.md ใน Repository โดยตรง';
            }
          }
        }
      } catch {
        // 404 หรือไม่มีไฟล์ CHANGELOG.md -> ไปยัง Commit History
      }
    }

    // 5.3 ลำดับที่ 3: GitHub Compare API / Commit History
    if (sourceType === 'NONE' && compareCommits.length > 0) {
      sourceType = 'COMMIT_HISTORY';
      hasOfficialReleaseNotes = false;
      isAutomatedThaiSummary = true;
      sourceLabelThai = `ประวัติ Commit จาก GitHub Compare (${compareCommits.length} รายการ)`;
      noticeThai =
        'ยังไม่มี Release Notes อย่างเป็นทางการสำหรับรุ่นนี้ — ระบบสรุปและจัดหมวดหมู่จากข้อความ Commit จริงบน GitHub แบบอัตโนมัติ';

      let idx = 0;
      for (const c of compareCommits) {
        const subject = c.message.split(/\r?\n/)[0]?.trim() || '';
        if (!subject || /^merge (pull request|branch)/i.test(subject)) continue;
        const cat = classifyChangeCategory(subject);
        const formatted = formatThaiSummaryTitle(subject, cat);
        idx += 1;
        categories[cat].push({
          id: `commit-${c.sha.slice(0, 8)}-${idx}`,
          category: cat,
          title: formatted.title,
          rawText: subject,
          sourceRef: c.sha.slice(0, 8),
          author: c.author,
          date: c.date,
          url: c.url,
          isAutoCategorized: true,
        });
      }
    } else if (sourceType === 'NONE' && status === 'LOCAL_GIT_UNAVAILABLE' && latestCommitMessage) {
      sourceType = 'COMMIT_HISTORY';
      hasOfficialReleaseNotes = false;
      isAutomatedThaiSummary = true;
      sourceLabelThai = `Commit ล่าสุดบน Branch ${branch}`;
      noticeThai =
        'ไม่พบ .git ในเครื่องปัจจุบันจึงไม่สามารถเทียบช่วง Commit ได้ — แสดงข้อมูล Commit ล่าสุดบน GitHub เท่านั้น';
      const cat = classifyChangeCategory(latestCommitMessage);
      const formatted = formatThaiSummaryTitle(latestCommitMessage, cat);
      categories[cat].push({
        id: `head-${targetCommitShort}`,
        category: cat,
        title: formatted.title,
        rawText: latestCommitMessage,
        sourceRef: targetCommitShort,
        author: latestCommitAuthor,
        date: latestCommitDate,
        url: `${repoUrl}/commit/${targetCommit}`,
        isAutoCategorized: true,
      });
    }

    // เพิ่มรายการไฟล์ SQL Migration ที่ตรวจพบจาก Compare API เข้าหมวด "การเปลี่ยนแปลงฐานข้อมูล" เสมอ (หากยังไม่ถูกกล่าวถึง)
    for (const migFile of compareMigrationFiles) {
      const alreadyListed = categories.database.some((entry) => entry.rawText.includes(migFile));
      if (!alreadyListed) {
        categories.database.push({
          id: `mig-${migFile}`,
          category: 'database',
          title: `พบไฟล์ Database Migration ใหม่: ${migFile} (เวอร์ชันนี้ต้องมีการปรับปรุงโครงสร้างฐานข้อมูล กรุณาติดต่อผู้ดูแลระบบก่อนอัปเดต)`,
          rawText: `database/migrations/${migFile}`,
          sourceRef: targetCommitShort,
          url: `${repoUrl}/blob/${branch}/database/migrations/${migFile}`,
          isAutoCategorized: true,
        });
      }
    }
  } else if (status === 'HISTORY_DIVERGED') {
    noticeThai =
      'ไม่สามารถเปรียบเทียบรายการเปลี่ยนแปลงอัตโนมัติได้ เนื่องจากประวัติ Commit บนเครื่องปัจจุบันไม่ตรงกับสายหลักบน GitHub';
  }

  const totalEntries =
    categories.features.length +
    categories.fixes.length +
    categories.improvements.length +
    categories.security.length +
    categories.database.length +
    categories.breaking.length;

  const latestVersionDisplay =
    latestReleaseFull?.tagName || (targetCommitShort !== 'unknown' ? `commit ${targetCommitShort}` : null);

    const nowMs = Date.now();
    const expiresAtMs = nowMs + cacheTtlMs;
    const result: GitHubVersionCheckResult = {
      repository: repo,
      repositoryUrl: repoUrl,
      branch,
      checkedAt,
      status,
      statusLabelThai,
      hasUpdates,
      githubReachable: true,
      githubError: null,
      githubErrorCode: null,
      remediationThai: null,
      installedVersion: installed.packageVersion,
      installedReleaseTag: installed.installedReleaseTag,
      currentCommit: installed.currentCommit || 'unknown',
      currentCommitShort: installed.currentCommitShort || 'unknown',
      latestVersion: latestVersionDisplay,
      latestRelease,
      targetCommit: targetCommit || 'unknown',
      targetCommitShort,
      latestCommitDate,
      latestCommitMessage,
      latestCommitAuthor,
      commitsBehind,
      commitsAhead,
      compareStatus,
      localGitAvailable: installed.localGitAvailable,
      workingTreeClean: installed.workingTreeClean,
      dirtyFiles: installed.dirtyFiles,
      compareMigrationFiles,
      changelog: {
        sourceType,
        sourceLabelThai,
        hasOfficialReleaseNotes,
        isAutomatedThaiSummary,
        noticeThai,
        versionRangeLabel,
        isMultiVersionJump,
        includedReleases,
        totalEntries,
        categories,
      },
      tokenConfigured: cfg.github.tokenConfigured,
      tokenMaskedHint: cfg.github.tokenMaskedHint,
      fromCache: false,
      cacheExpiresAt: new Date(expiresAtMs).toISOString(),
      cacheTtlMinutes,
      isStale: false,
      staleWarningThai: null,
      lastSuccessfulCheckedAt: checkedAt,
      cooldownActive: false,
      cooldownUntil: null,
      cooldownUntilThai: null,
      rateLimit: latestRateLimit,
    };

    rateLimitCooldownMap.delete(tokenScopeKey);
    if (versionCheckCache.size >= 50) {
      const oldestKey = versionCheckCache.keys().next().value;
      if (oldestKey) versionCheckCache.delete(oldestKey);
    }
    versionCheckCache.set(cacheKey, {
      cacheKey,
      cachedAt: nowMs,
      expiresAt: expiresAtMs,
      payload: result,
    });
    if (lastKnownGoodCache.size >= 50) {
      const oldestKey = lastKnownGoodCache.keys().next().value;
      if (oldestKey) lastKnownGoodCache.delete(oldestKey);
    }
    lastKnownGoodCache.set(cacheKey, result);

    return result;
  };

  const flightPromise = runLiveCheck().finally(() => {
    if (inFlightChecks.get(flightKey) === flightPromise) {
      inFlightChecks.delete(flightKey);
    }
  });
  inFlightChecks.set(flightKey, flightPromise);

  return flightPromise;
}

export function evaluateDeploymentReadiness(params: {
  actorRole: string;
  githubCheck: GitHubVersionCheckResult | null;
  dbInspection: DetailedMigrationInspection;
  combinedPendingMigrations: string[];
  hasCustomDeployRunner: boolean;
  cwd?: string;
}): DeploymentReadinessReport {
  const cwd = params.cwd || process.cwd();
  const cfg = loadConfig();
  const checks: ReadinessCheckItem[] = [];

  // 1. สิทธิ์ผู้ดูแลระบบ (ADMIN)
  const isAdmin = params.actorRole === 'ADMIN';
  checks.push({
    id: 'ADMIN_ROLE',
    label: 'สิทธิ์ผู้ดูแลระบบ (ADMIN Role)',
    status: isAdmin ? 'PASS' : 'FAIL',
    blocking: true,
    detail: isAdmin
      ? 'ยืนยันสิทธิ์ผู้ดูแลระบบ (ADMIN) แล้ว สามารถตรวจสอบและอนุมัติการอัปเดตได้'
      : 'บัญชีปัจจุบันไม่ใช่ ADMIN ระบบไม่อนุญาตให้ดำเนินการอัปเดต',
    remediation: isAdmin ? null : 'กรุณาเข้าสู่ระบบด้วยบัญชีผู้ดูแลระบบ (ADMIN)',
  });

  // 2. การเชื่อมต่อ GitHub
  const gh = params.githubCheck;
  if (!gh) {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อ GitHub Repository',
      status: 'WARN',
      blocking: false,
      detail: `ยังไม่ได้ตรวจสอบ GitHub (${cfg.github.repo}) ในรอบนี้`,
      remediation: 'กดปุ่ม "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อดึงสถานะล่าสุดจาก GitHub',
    });
  } else if (!gh.githubReachable) {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อ GitHub Repository',
      status: 'FAIL',
      blocking: true,
      detail: gh.githubError || 'ไม่สามารถเชื่อมต่อ GitHub API ได้',
      remediation:
        gh.remediationThai ||
        'ตรวจสอบอินเทอร์เน็ต/Firewall ของเซิร์ฟเวอร์ หรือตั้งค่า GITHUB_TOKEN ในไฟล์ .env',
    });
  } else if (gh.status === 'HISTORY_DIVERGED') {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อและประวัติ GitHub Repository',
      status: 'FAIL',
      blocking: true,
      detail: 'เชื่อมต่อ GitHub ได้ แต่ประวัติ Commit ของเครื่องปัจจุบันแยกสายจาก Branch หลัก',
      remediation: 'ตรวจสอบ git status / git log บนเซิร์ฟเวอร์ด้วยตนเองก่อนอัปเดต (ห้ามใช้ git reset --hard อัตโนมัติ)',
    });
  } else {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อ GitHub Repository',
      status: 'PASS',
      blocking: false,
      detail: `เชื่อมต่อ ${gh.repository} (Branch: ${gh.branch}) สำเร็จ`,
      remediation: null,
    });
  }

  // 3. สภาพแวดล้อม Windows Server และสคริปต์ Deployment
  const winBat = 'C:\\inetpub\\wwwroot\\Sam_Att\\deployment\\Deploy_Sam_Att.bat';
  const localBat = path.resolve(cwd, 'deployment', 'Deploy_Sam_Att.bat');
  const localPs1 = path.resolve(cwd, 'deployment', 'Deploy_Sam_Att.ps1');
  const scriptExists = fs.existsSync(winBat) || (fs.existsSync(localBat) && fs.existsSync(localPs1));
  const osSupported = process.platform === 'win32' || params.hasCustomDeployRunner;
  checks.push({
    id: 'DEPLOY_ENVIRONMENT',
    label: 'สคริปต์อัปเดตและสภาพแวดล้อมเซิร์ฟเวอร์',
    status: scriptExists && osSupported ? 'PASS' : 'FAIL',
    blocking: true,
    detail: !scriptExists
      ? 'ไม่พบไฟล์ deployment/Deploy_Sam_Att.bat หรือ Deploy_Sam_Att.ps1'
      : !osSupported
        ? `สภาพแวดล้อมปัจจุบันคือ ${process.platform} (การสั่งรัน Deploy_Sam_Att.ps1 รองรับเฉพาะเครื่อง Windows Server จริงเท่านั้น)`
        : 'พบสคริปต์ Safe Deployment ครบถ้วนและพร้อมเรียกทำงานแบบ Non-Interactive',
    remediation: !osSupported
      ? 'บนเครื่อง Preview/Linux สามารถตรวจสอบเวอร์ชันและ Changelog ได้เท่านั้น การอัปเดตจริงต้องทำบน Windows Server ของโรงพยาบาล'
      : !scriptExists
        ? 'ตรวจสอบให้แน่ใจว่าโฟลเดอร์ deployment/ มีไฟล์ Deploy_Sam_Att.bat และ Deploy_Sam_Att.ps1 ครบถ้วน'
        : null,
  });

  // 4. Git Working Tree และ Branch
  if (gh && !gh.localGitAvailable) {
    checks.push({
      id: 'GIT_WORKING_TREE',
      label: 'สถานะ Git Repository และ Working Tree',
      status: 'FAIL',
      blocking: true,
      detail: 'ไม่พบโฟลเดอร์ .git ในไดเรกทอรีรันระบบปัจจุบัน',
      remediation: 'ตรวจสอบว่าติดตั้งระบบผ่าน git clone บนเครื่อง Windows Server ที่ C:\\inetpub\\wwwroot\\Sam_Att',
    });
  } else if (gh && gh.workingTreeClean === false) {
    checks.push({
      id: 'GIT_WORKING_TREE',
      label: 'สถานะ Git Repository และ Working Tree',
      status: 'FAIL',
      blocking: true,
      detail: `พบไฟล์ที่ถูกแก้ไขค้างอยู่ในเครื่อง (${gh.dirtyFiles.slice(0, 5).join(', ')}) — ระบบห้ามทำ git reset --hard อัตโนมัติ`,
      remediation: 'ตรวจสอบและจัดเก็บไฟล์ที่แก้ไขค้างด้วย git status / git diff บนเซิร์ฟเวอร์ให้ Working Tree สะอาดก่อนอัปเดต',
    });
  } else {
    checks.push({
      id: 'GIT_WORKING_TREE',
      label: 'สถานะ Git Repository และ Working Tree',
      status: 'PASS',
      blocking: false,
      detail: `Branch ${gh?.branch || cfg.github.branch} สะอาดพร้อมรับการอัปเดตแบบ fast-forward (--ff-only)`,
      remediation: null,
    });
  }

  // 5. Runtime Node.js และไฟล์หลัก
  const majorNode = Number((process.version.match(/^v(\d+)/) || [])[1] || 0);
  const coreFilesOk =
    fs.existsSync(path.join(cwd, 'package.json')) &&
    fs.existsSync(path.join(cwd, 'server.ts'));
  checks.push({
    id: 'RUNTIME_BUILD_READY',
    label: 'ความพร้อม Runtime (Node.js >= v22) และไฟล์ระบบหลัก',
    status: majorNode >= 22 && coreFilesOk ? 'PASS' : 'FAIL',
    blocking: true,
    detail:
      majorNode >= 22 && coreFilesOk
        ? `Node.js ${process.version} และไฟล์ระบบหลักครบถ้วน`
        : `ตรวจพบ Node.js ${process.version} หรือไฟล์ระบบหลักไม่ครบ (ต้องการ Node.js >= v22.0.0)`,
    remediation: majorNode < 22 ? 'ติดตั้ง Node.js v22 LTS ขึ้นไปบนเซิร์ฟเวอร์' : null,
  });

  // 6. Database Schema / Migration Policy (Application-Only: ห้ามอัปเดตผ่านหน้าเว็บเมื่อมี Schema/Migration เปลี่ยน)
  const mismatchCount = params.dbInspection.checksumMismatches.length;
  const pendingCount = params.combinedPendingMigrations.length;
  if (mismatchCount > 0) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'นโยบายแยกการจัดการฐานข้อมูล (Application-Only Safety)',
      status: 'FAIL',
      blocking: true,
      detail: `ตรวจพบ Checksum ไม่ตรงกัน ${mismatchCount} ไฟล์ (${params.dbInspection.checksumMismatches.map((m) => m.filename).join(', ')})`,
      remediation: 'ห้ามแก้ไขไฟล์ Migration ที่เคยรันแล้ว กรุณาติดต่อผู้ดูแลระบบ/DBA เพื่อตรวจสอบ schema_migrations ก่อนดำเนินการต่อ',
    });
  } else if (pendingCount > 0) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'นโยบายแยกการจัดการฐานข้อมูล (Application-Only Safety)',
      status: 'FAIL',
      blocking: true,
      detail: `เวอร์ชันนี้ต้องมีการปรับปรุงโครงสร้างฐานข้อมูล กรุณาติดต่อผู้ดูแลระบบก่อนอัปเดต (${params.combinedPendingMigrations.join(', ')})`,
      remediation: 'หน้าเว็บนี้สงวนไว้สำหรับอัปเดต Application เท่านั้น กรุณาให้ผู้ดูแลระบบรัน `npm run db:migrate` บนเซิร์ฟเวอร์ให้เสร็จก่อนแล้วจึงกดตรวจสอบเวอร์ชันใหม่',
    });
  } else {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'นโยบายแยกการจัดการฐานข้อมูล (Application-Only Safety)',
      status: 'PASS',
      blocking: false,
      detail: `ไม่มีการเปลี่ยนแปลงโครงสร้างฐานข้อมูลค้างอยู่ (รันแล้ว ${params.dbInspection.appliedMigrations.length} รุ่น) — อัปเดตเฉพาะ Application โดยไม่แตะต้องฐานข้อมูล`,
      remediation: null,
    });
  }

  // 7. นโยบาย Application Snapshot นอก Git Repo และ Isolation Guard
  const snapshotRoot =
    process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR ||
    process.env.SAM_ATT_BACKUP_DIR ||
    'C:\\SamAttDeploySnapshots';
  const snapshotInsideRepo = path.resolve(snapshotRoot).toLowerCase().startsWith(path.resolve(cwd).toLowerCase());
  checks.push({
    id: 'BACKUP_AND_ISOLATION',
    label: 'นโยบายสำรอง Application Snapshot นอก Git Repo และแยกอิสระจากระบบอื่น',
    status: snapshotInsideRepo ? 'FAIL' : 'PASS',
    blocking: snapshotInsideRepo,
    detail: snapshotInsideRepo
      ? `พาธสำรอง Application Snapshot (${snapshotRoot}) อยู่ภายใน Git Repository ซึ่งผิดนโยบายความปลอดภัย`
      : `สำรองไฟล์ dist/ และ Manifest ของ Application ที่ ${snapshotRoot} ก่อน git pull โดยไม่ยุ่งเกี่ยวกับฐานข้อมูล ${cfg.samAttDb.database} และไม่กระทบ Procurement / iisreset`,
    remediation: snapshotInsideRepo
      ? 'ตั้งค่า SAM_ATT_DEPLOY_SNAPSHOT_DIR ให้อยู่นอกโฟลเดอร์โปรเจกต์ เช่น C:\\SamAttDeploySnapshots'
      : null,
  });

  const blockingFailures = checks.filter((c) => c.status === 'FAIL' && c.blocking).length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  const passedCount = checks.filter((c) => c.status === 'PASS').length;
  const isAlreadyUpToDate = Boolean(
    gh &&
      gh.githubReachable &&
      gh.status === 'UP_TO_DATE' &&
      !gh.hasUpdates &&
      pendingCount === 0
  );

  return {
    canDeploy: blockingFailures === 0 && !isAlreadyUpToDate,
    checkedAt: new Date().toISOString(),
    blockingFailures,
    warnings,
    passedCount,
    totalChecks: checks.length,
    checks,
  };
}

/**
 * วิเคราะห์สาเหตุจริงของข้อผิดพลาดเมื่อสคริปต์อัปเดตคืน Exit Code != 0 (HTTP 422 / 409)
 */
export function diagnoseDeploymentFailure(
  exitCode: number,
  stdout: string,
  stderr: string
): DeploymentFailureDiagnostic {
  const combined = `${stdout || ''}\n${stderr || ''}`;

  // 1. ดึง Step ที่ล้มเหลวจากรูปแบบ [X/8] StepName FAIL หรือ [X/7] StepName ... FAIL
  const stepFailMatch = combined.match(/\[(\d+)\/(?:7|8)\]\s+([^\.\r\n]+?)\s+(?:\.+\s+)?FAIL\b/i);
  let failedStepNumber: number | null = stepFailMatch ? Number(stepFailMatch[1]) : null;
  let failedStepName = stepFailMatch ? stepFailMatch[2].trim() : 'ไม่ระบุขั้นตอน';

  // 2. ดึง Error Code จริงจาก ERROR [Step]: CODE: detail
  const errorLineMatch = combined.match(/ERROR\s+\[([^\]]+)\]\s*:\s*([A-Z0-9_]+)\s*:\s*([^\r\n]+)/i);
  let errorCode = errorLineMatch ? errorLineMatch[2].trim().toUpperCase() : '';
  const rawDetail = errorLineMatch ? errorLineMatch[3].trim() : '';
  if (errorLineMatch && failedStepName === 'ไม่ระบุขั้นตอน') {
    failedStepName = errorLineMatch[1].trim();
  }

  // Fallback จับ Error Code ที่รู้จักจากข้อความ Output
  if (!errorCode) {
    const knownCodes = [
      'PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED',
      'PREFLIGHT_REPO_NOT_FOUND',
      'PREFLIGHT_DIRTY_WORKING_TREE',
      'PREFLIGHT_WRONG_BRANCH',
      'PREFLIGHT_NODE_MISSING',
      'PREFLIGHT_NODE_VERSION_UNSUPPORTED',
      'PREFLIGHT_NPM_MISSING',
      'PREFLIGHT_LOW_DISK_SPACE',
      'PREFLIGHT_ENV_MISSING',
      'PREFLIGHT_INVALID_DATA_MODE',
      'PREFLIGHT_INVALID_DB_ENGINE',
      'PREFLIGHT_ENV_INCOMPLETE',
      'PREFLIGHT_FORBIDDEN_HOSOFFICE_DB',
      'PREFLIGHT_IIS_PERMISSION_DENIED',
      'PREFLIGHT_PORT_4101_FOREIGN_PROCESS',
      'PREFLIGHT_SNAPSHOT_DIR_INSIDE_GIT',
      'PREFLIGHT_BACKUP_DIR_INSIDE_GIT',
      'PREFLIGHT_BACKUP_DIR_UNWRITABLE',
      'PREFLIGHT_MISSING_CORE_FILE',
      'DEPLOYMENT_ALREADY_IN_PROGRESS',
      'NO_UPDATE_AVAILABLE',
      'GITHUB_REPO_MISMATCH',
      'GIT_LOCAL_HEAD_UNAVAILABLE',
      'GIT_FETCH_FAILED',
      'GIT_REMOTE_HEAD_UNAVAILABLE',
      'GIT_HISTORY_DIVERGED',
      'CHANGE_IMPACT_DIFF_FAILED',
      'CONFIG_ENV_TRACKED_VIOLATION',
      'DB_SCHEMA_CHANGE_BLOCKED',
      'GIT_PULL_FAILED',
      'MIGRATION_APPROVAL_REQUIRED',
      'MIGRATION_APPROVAL_MISMATCH',
      'MIGRATION_CHECKSUM_MISMATCH',
      'BACKUP_FAILED_NO_MYSQLDUMP',
      'BACKUP_FAILED',
      'SNAPSHOT_FAILED',
      'NPM_CI_LOCK_ERROR',
      'NPM_INSTALL_FAILED',
      'PROCESS_STOP_TIMEOUT',
      'SECURITY_ENV_MUTATED_VIOLATION',
      'TYPECHECK_FAILED',
      'UNIT_TESTS_FAILED',
      'BUILD_FAILED',
      'BUILD_ARTIFACT_MISSING',
      'BACKEND_ENTRY_MISSING',
      'SCANNER_EXE_MODIFIED_VIOLATION',
      'SECURITY_ISOLATION_VIOLATION',
      'MIGRATION_EXECUTION_FAILED',
      'POST_MIGRATION_SCHEMA_VERIFICATION_FAILED',
      'HEALTH_CHECK_FAILED',
      'POST_DEPLOY_LOG_ERRORS',
      'BACKEND_START_FAILED',
      'BACKEND_PM2_RESTART_FAILED',
      'BACKEND_PROCESS_EXITED_IMMEDIATELY',
      'BACKEND_SERVICE_NOT_RUNNING',
      'ROLLBACK_FAILED',
      'ROLLBACK_SNAPSHOT_NOT_FOUND',
    ];
    for (const code of knownCodes) {
      if (combined.includes(code)) {
        errorCode = code;
        break;
      }
    }
  }

  // ตรวจจับกรณี Deploy_Sam_Att.bat เจอ net session ล้มเหลวแบบเก่า
  if (!errorCode && /Run as administrator/i.test(combined)) {
    errorCode = 'PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED';
    failedStepNumber = failedStepNumber ?? 1;
    failedStepName = 'Preflight Check';
  }

  if (!errorCode) {
    errorCode = `DEPLOYMENT_EXIT_CODE_${exitCode}`;
  }

  // 3. ประเมินสถานะ Rollback จากแบนเนอร์จริงของสคริปต์
  let rollbackStatus: DeploymentFailureDiagnostic['rollbackStatus'] = 'UNKNOWN';
  let rollbackStatusThai = 'ไม่ทราบสถานะการย้อนกลับ กรุณาตรวจสอบ Log ด้านล่าง';
  if (/DEPLOYMENT ABORTED \(NO SYSTEM CHANGES APPLIED\)/i.test(combined) || (failedStepNumber !== null && failedStepNumber <= 3 && !/ROLLED BACK/i.test(combined))) {
    rollbackStatus = 'NO_CHANGES_APPLIED';
    rollbackStatusThai = 'หยุดก่อนเปลี่ยนแปลงระบบ — โค้ดและฐานข้อมูลเดิมไม่ถูกกระทบ';
  } else if (/ADMIN DB RESTORE REQUIRED|MANUAL_DB_RESTORE_REQUIRED/i.test(combined)) {
    rollbackStatus = 'MANUAL_DB_RESTORE_REQUIRED';
    rollbackStatusThai = 'ย้อนซอร์สโค้ดแล้ว แต่ต้องตรวจสอบและกู้คืนฐานข้อมูล MySQL ด้วยตนเอง (ห้าม Auto-DROP)';
  } else if (/ROLLED BACK SAFELY TO PREVIOUS VERSION/i.test(combined)) {
    rollbackStatus = 'ROLLED_BACK_CODE';
    rollbackStatusThai = 'ระบบย้อนกลับไปยังซอร์สโค้ดเวอร์ชันก่อนหน้าโดยอัตโนมัติแล้ว';
  } else if (/ROLLBACK FAILED/i.test(combined)) {
    rollbackStatus = 'ROLLBACK_FAILED';
    rollbackStatusThai = 'การย้อนกลับอัตโนมัติไม่สำเร็จ ต้องเข้าตรวจสอบบนเซิร์ฟเวอร์โดยด่วน';
  }

  // 4. แปลสาเหตุและแนวทางแก้ไขภาษาไทยตาม Error Code จริง
  const catalog: Record<string, { step?: number; stepName?: string; cause: string; fix: string }> = {
    PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'โปรเซสของบริการ Sam_Att หรือสคริปต์ไม่ได้ทำงานด้วยสิทธิ์ Administrator บน Windows Server',
      fix: 'ตรวจสอบบัญชีของ Windows Service (WinSW) ให้มีสิทธิ์ดูแล Service/IIS ของ Sam_Att หรือคลิกขวา Deploy_Sam_Att.bat แล้วเลือก Run as administrator',
    },
    PREFLIGHT_DIRTY_WORKING_TREE: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'พบไฟล์ที่ถูกแก้ไขหรือลบค้างอยู่ใน Git Working Tree (เช่น bun.lock หรือไฟล์คอนฟิกที่ถูกแก้บนเครื่อง) ระบบจึงระงับการอัปเดตตามนโยบายห้าม git reset --hard อัตโนมัติ',
      fix: 'เปิด PowerShell ใน C:\\inetpub\\wwwroot\\Sam_Att แล้วรัน git status เพื่อตรวจสอบไฟล์ที่เปลี่ยน จากนั้นจัดเก็บหรือย้อนไฟล์ที่ไม่จำเป็นให้ Working Tree สะอาดแล้วลองใหม่',
    },
    PREFLIGHT_WRONG_BRANCH: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'Git Branch ปัจจุบันบนเซิร์ฟเวอร์ไม่ตรงกับ Branch เป้าหมาย (main)',
      fix: 'ตรวจสอบสาขาด้วย git branch บนเซิร์ฟเวอร์และสลับกลับมาที่ main ก่อนสั่งอัปเดต',
    },
    PREFLIGHT_NODE_MISSING: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ไม่พบคำสั่ง Node.js บนเครื่องเซิร์ฟเวอร์',
      fix: 'ติดตั้ง Node.js v22 LTS ขึ้นไปและตรวจสอบ System PATH บน Windows Server',
    },
    PREFLIGHT_NODE_VERSION_UNSUPPORTED: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'เวอร์ชัน Node.js บนเซิร์ฟเวอร์ต่ำกว่าข้อกำหนดขั้นต่ำ (v22.0.0)',
      fix: 'อัปเกรด Node.js เป็น v22 LTS ขึ้นไปบนเซิร์ฟเวอร์ก่อนสั่งอัปเดต',
    },
    PREFLIGHT_LOW_DISK_SPACE: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'พื้นที่ว่างบนดิสก์เหลือน้อยกว่า 500 MB ไม่เพียงพอสำหรับ Snapshot และ Build',
      fix: 'เพิ่มพื้นที่ว่างบนไดรฟ์ที่ติดตั้ง Sam_Att อย่างน้อย 500 MB แล้วลองใหม่อีกครั้ง',
    },
    PREFLIGHT_ENV_MISSING: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ไม่พบไฟล์ .env ในโฟลเดอร์ติดตั้งระบบ',
      fix: 'ตรวจสอบไฟล์ .env ใน C:\\inetpub\\wwwroot\\Sam_Att ให้มีค่าเชื่อมต่อ MySQL และ Secret ครบถ้วน',
    },
    PREFLIGHT_ENV_INCOMPLETE: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ค่าตั้งค่าสำคัญในไฟล์ .env ยังไม่ครบหรือยังเป็นค่า Placeholder (CHANGE_ME / GENERATE_*)',
      fix: 'ตรวจสอบตัวแปร SAM_ATT_DB_*, JWT_SECRET และ SCANNER_INGEST_SHARED_TOKEN ในไฟล์ .env',
    },
    PREFLIGHT_FORBIDDEN_HOSOFFICE_DB: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ค่า SAM_ATT_DB_NAME ในไฟล์ .env ชี้ไปยังฐานข้อมูล HOSOffice ซึ่งเป็นข้อห้าม',
      fix: 'ตรวจสอบให้ SAM_ATT_DB_NAME ชี้ไปยังฐานข้อมูลเฉพาะของระบบ (samchuk_attendance_v2) เท่านั้น',
    },
    PREFLIGHT_INVALID_DATA_MODE: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ไฟล์ .env กำหนด SAM_ATT_DATA_MODE ไม่ใช่ REAL',
      fix: 'แก้ไข SAM_ATT_DATA_MODE=REAL ในไฟล์ .env สำหรับเครื่อง Production',
    },
    PREFLIGHT_INVALID_DB_ENGINE: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ไฟล์ .env ไม่ได้กำหนด SAM_ATT_DB_ENGINE=mysql',
      fix: 'แก้ไข SAM_ATT_DB_ENGINE=mysql ในไฟล์ .env สำหรับเครื่อง Production',
    },
    PREFLIGHT_IIS_PERMISSION_DENIED: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ไม่มีสิทธิ์อ่านค่า IIS ผ่าน appcmd.exe',
      fix: 'รันบริการหรือสคริปต์ด้วยสิทธิ์ Administrator บน Windows Server',
    },
    PREFLIGHT_PORT_4101_FOREIGN_PROCESS: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'พอร์ต 4101 ถูกใช้งานโดยโปรเซสอื่นที่ไม่ใช่ Sam_Att V2 Standalone',
      fix: 'ตรวจสอบโปรเซสที่ถือพอร์ต 4101 บนเซิร์ฟเวอร์ด้วย Get-NetTCPConnection -LocalPort 4101 (ห้ามสั่ง kill โดยไม่ตรวจชื่อโปรเซส)',
    },
    PREFLIGHT_SNAPSHOT_DIR_INSIDE_GIT: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'โฟลเดอร์เก็บ Application Rollback Snapshot ถูกตั้งให้อยู่ภายใน Git Repository',
      fix: 'ตั้งค่า -RollbackRootDir หรือ SAM_ATT_DEPLOY_SNAPSHOT_DIR ให้อยู่นอกโฟลเดอร์ติดตั้ง เช่น C:\\SamAttDeploySnapshots',
    },
    PREFLIGHT_BACKUP_DIR_INSIDE_GIT: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'โฟลเดอร์สำรองข้อมูลถูกตั้งให้อยู่ภายในโฟลเดอร์ Git Repository',
      fix: 'ตั้งค่า SAM_ATT_BACKUP_DIR=C:\\SamAttBackups (อยู่นอก Git Repository)',
    },
    PREFLIGHT_BACKUP_DIR_UNWRITABLE: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'ไม่สามารถสร้างหรือเขียนไฟล์ในโฟลเดอร์สำรองข้อมูลได้',
      fix: 'ตรวจสอบสิทธิ์ NTFS และพื้นที่ว่างในไดรฟ์ของ C:\\SamAttBackups',
    },
    GITHUB_REPO_MISMATCH: {
      step: 2,
      stepName: 'GitHub Version Verification',
      cause: 'Git Remote origin ไม่ตรงกับ Repository jk9krnvb6g-ai/Sam_Att-V2-Standalone',
      fix: 'ตรวจสอบ git remote -v ในโฟลเดอร์ติดตั้งให้ชี้ไปยัง jk9krnvb6g-ai/Sam_Att-V2-Standalone',
    },
    GIT_FETCH_FAILED: {
      step: 2,
      stepName: 'GitHub Version Verification',
      cause: 'ไม่สามารถดึงข้อมูลล่าสุดจาก GitHub (git fetch) ได้',
      fix: 'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต Proxy/Firewall และสิทธิ์เข้าถึง GitHub Repository บนเซิร์ฟเวอร์',
    },
    GIT_HISTORY_DIVERGED: {
      step: 2,
      stepName: 'GitHub Version Verification',
      cause: 'ประวัติ Commit บนเครื่องเซิร์ฟเวอร์แยกสายออกจาก origin/main ไม่สามารถ fast-forward ได้',
      fix: 'ตรวจสอบ git status และ git log บนเซิร์ฟเวอร์ด้วยตนเองก่อนสั่งอัปเดต (ห้ามใช้ git reset --hard)',
    },
    DB_SCHEMA_CHANGE_BLOCKED: {
      step: 3,
      stepName: 'Change Impact Analysis',
      cause: 'ตรวจพบการเปลี่ยนแปลงไฟล์ Database Schema หรือ Migration ในรุ่นเป้าหมาย — Deployment Script แบบ 8 ขั้นตอนจัดการเฉพาะ Application และจะไม่แก้ไขฐานข้อมูล',
      fix: 'ให้ผู้ดูแลระบบ/DBA ตรวจสอบและปรับโครงสร้างฐานข้อมูล samchuk_attendance_v2 แยกต่างหากให้เรียบร้อยก่อนนำโค้ดรุ่นนี้ขึ้นใช้งาน',
    },
    CONFIG_ENV_TRACKED_VIOLATION: {
      step: 3,
      stepName: 'Change Impact Analysis',
      cause: 'พบไฟล์ .env อยู่ในรายการเปลี่ยนแปลงจาก GitHub ซึ่งเสี่ยงต่อการเขียนทับค่า Production',
      fix: 'นำไฟล์ .env ออกจาก Git Commit บน Repository ก่อนสั่งอัปเดต',
    },
    GIT_PULL_FAILED: {
      step: 4,
      stepName: 'Install Dependencies',
      cause: 'คำสั่ง git pull --ff-only ไม่สำเร็จ (อาจมี Commit ในเครื่องที่แยกสายจาก origin/main)',
      fix: 'ตรวจสอบ git status และ git log --oneline -n 5 บนเซิร์ฟเวอร์เพื่อรวมหรือแก้ไขประวัติ Commit ด้วยตนเอง',
    },
    MIGRATION_APPROVAL_REQUIRED: {
      step: 2,
      stepName: 'GitHub Version Verification',
      cause: 'พบไฟล์ Database Migration ใหม่ที่ยังไม่ได้รับการอนุมัติจากผู้ดูแลระบบ',
      fix: 'กดตรวจสอบเวอร์ชันอีกครั้ง ตรวจสอบรายการ Migration และอนุมัติด้วยรหัสผ่าน ADMIN ในหน้าจออัปเดตระบบ',
    },
    MIGRATION_APPROVAL_MISMATCH: {
      step: 2,
      stepName: 'GitHub Version Verification',
      cause: 'รหัส Commit เป้าหมายหรือรายการไฟล์ Migration บน GitHub เปลี่ยนแปลงไปจากตอนที่กดอนุมัติ',
      fix: 'กด "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อโหลด Commit และรายการ Migration ล่าสุด แล้วทำขั้นตอนอนุมัติใหม่',
    },
    MIGRATION_CHECKSUM_MISMATCH: {
      step: 2,
      stepName: 'GitHub Version Verification',
      cause: 'ไฟล์ SQL Migration ที่เคยรันไปแล้วมีค่า SHA-256 Checksum ไม่ตรงกับที่บันทึกไว้ในตาราง schema_migrations',
      fix: 'ห้ามแก้ไขไฟล์ Migration เดิม ให้ตรวจสอบความแตกต่างของไฟล์และฐานข้อมูลโดย DBA ก่อนดำเนินการต่อ',
    },
    BACKUP_FAILED_NO_MYSQLDUMP: {
      step: 3,
      stepName: 'Backup',
      cause: 'ไม่พบโปรแกรม mysqldump.exe บนเครื่อง Windows Server จึงไม่สามารถสำรองฐานข้อมูลก่อนอัปเดตได้',
      fix: 'ติดตั้ง MySQL Client / เพิ่มโฟลเดอร์ bin ของ MySQL ลงใน System PATH หรือกำหนดพาธ mysqldump ให้พร้อมใช้งาน',
    },
    BACKUP_FAILED: {
      step: 3,
      stepName: 'Prepare Snapshot',
      cause: 'การเตรียมสำรองสถานะ Application นอก Git Repository ก่อน git pull ล้มเหลว ระบบจึงยกเลิกทันที',
      fix: 'ตรวจสอบสิทธิ์เขียนไฟล์และพื้นที่ว่างใน C:\\SamAttDeploySnapshots',
    },
    SNAPSHOT_FAILED: {
      step: 3,
      stepName: 'Prepare Snapshot',
      cause: 'ไม่สามารถสร้างโฟลเดอร์ Snapshot สำหรับ Application Rollback นอก Git Repository ได้',
      fix: 'ตรวจสอบพื้นที่ว่างและสิทธิ์ NTFS ของ C:\\SamAttDeploySnapshots',
    },
    NPM_CI_LOCK_ERROR: {
      step: 4,
      stepName: 'Update Source & Deps',
      cause: 'การติดตั้ง Dependencies (npm ci) พบไฟล์ Binary ถูกล็อกบน Windows (EPERM / lightningcss.win32-x64-msvc.node) แม้หยุดโปรเซส Sam_Att และลองใหม่แล้ว',
      fix: 'ตรวจสอบว่าไม่มี Process อื่นเปิดไฟล์ใน node_modules (เช่น Antivirus หรือ Editor) จากนั้นกดอัปเดตอีกครั้ง (ระบบย้อนกลับรุ่นเดิมให้แล้ว)',
    },
    PROCESS_STOP_TIMEOUT: {
      step: 4,
      stepName: 'Update Source & Deps',
      cause: 'ไม่สามารถหยุดโปรเซส Sam_Att ที่ยืนยันตัวตนแล้วภายในเวลาที่กำหนดก่อนอัปเดต Dependencies',
      fix: 'ตรวจสอบสถานะโปรเซส Sam_Att บน Windows Service/Task Manager แล้วลองอัปเดตใหม่อีกครั้ง',
    },
    NO_UPDATE_AVAILABLE: {
      step: 2,
      stepName: 'Version Check',
      cause: 'ระบบเป็นเวอร์ชันล่าสุดแล้ว (Commit บนเครื่องตรงกับ GitHub) จึงไม่ต้องอัปเดตซ้ำ',
      fix: 'ไม่ต้องดำเนินการอัปเดตเพิ่ม จนกว่าจะมี Commit ใหม่บน GitHub',
    },
    DEPLOYMENT_ALREADY_IN_PROGRESS: {
      step: 1,
      stepName: 'Preflight Check',
      cause: 'มีงานอัปเดตหรือย้อนกลับกำลังทำงานอยู่แล้ว ระบบป้องกันการกดทำงานซ้อน',
      fix: 'รอให้งานปัจจุบันเสร็จสิ้นและตรวจสอบความคืบหน้าในหน้าศูนย์อัปเดต',
    },
    ROLLBACK_SNAPSHOT_NOT_FOUND: {
      step: 1,
      stepName: 'Validate Snapshot',
      cause: 'ไม่พบ Application Snapshot ที่ถูกต้องใน C:\\SamAttDeploySnapshots สำหรับการย้อนกลับ',
      fix: 'ตรวจสอบโฟลเดอร์ C:\\SamAttDeploySnapshots บนเซิร์ฟเวอร์ก่อนดำเนินการย้อนกลับ',
    },
    ROLLBACK_FAILED: {
      step: 5,
      stepName: 'Health Check & Report',
      cause: 'การย้อนกลับ Application ไปยัง Snapshot ก่อนหน้าไม่สำเร็จหรือ Health Check ไม่ผ่าน',
      fix: 'เข้าตรวจสอบสถานะ Git, dist/ และ runtime log ในโฟลเดอร์ logs/ บนเซิร์ฟเวอร์โดยด่วน',
    },
    NPM_INSTALL_FAILED: {
      step: 4,
      stepName: 'Update Source & Deps',
      cause: 'การติดตั้งแพ็กเกจ npm ci ล้มเหลว (อาจเกิดจากเครือข่ายหรือไฟล์ล็อกบน Windows)',
      fix: 'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตของเซิร์ฟเวอร์ และดูข้อความผิดพลาดจาก npm ใน Log ด้านล่าง',
    },
    SECURITY_ENV_MUTATED_VIOLATION: {
      step: 4,
      stepName: 'Install Dependencies',
      cause: 'ตรวจพบว่าค่า Checksum ของไฟล์ .env เปลี่ยนแปลงระหว่างขั้นตอนติดตั้ง Dependencies',
      fix: 'ตรวจสอบไฟล์ .env บนเซิร์ฟเวอร์ทันที (ระบบย้อนกลับเวอร์ชันเดิมให้แล้ว)',
    },
    TYPECHECK_FAILED: {
      step: 5,
      stepName: 'Test & Build',
      cause: 'การตรวจสอบชนิดข้อมูล TypeScript (npm run typecheck) ไม่ผ่าน',
      fix: 'ตรวจสอบ Log ของ TypeScript ด้านล่างและแก้ไขโค้ดบน GitHub ก่อนสั่งอัปเดตใหม่ (ระบบย้อนกลับรุ่นเดิมให้แล้ว)',
    },
    UNIT_TESTS_FAILED: {
      step: 5,
      stepName: 'Test & Build',
      cause: 'ชุดทดสอบอัตโนมัติ (npm test) มีบางรายการไม่ผ่าน',
      fix: 'ตรวจสอบผลการทดสอบใน Log ด้านล่างและแก้ไขก่อนนำขึ้นใช้งานจริง (ระบบย้อนกลับรุ่นเดิมให้แล้ว)',
    },
    BUILD_FAILED: {
      step: 5,
      stepName: 'Test & Build',
      cause: 'การคอมไพล์หน้าเว็บ Production (npm run build) ล้มเหลว',
      fix: 'ตรวจสอบข้อความผิดพลาดของ Vite Build ใน Log ด้านล่างและแก้ไขบน GitHub ก่อนลองใหม่',
    },
    BUILD_ARTIFACT_MISSING: {
      step: 5,
      stepName: 'Test & Build',
      cause: 'ไม่พบไฟล์ dist/index.html หรือไฟล์ว่างเปล่าหลังการ Build',
      fix: 'ตรวจสอบ Log ของ Vite Build และพื้นที่ดิสก์บนเซิร์ฟเวอร์',
    },
    BACKEND_ENTRY_MISSING: {
      step: 5,
      stepName: 'Test & Build',
      cause: 'ไม่พบไฟล์ Entry หลักของฝั่ง Backend (server.ts / backend/src/app.ts)',
      fix: 'ตรวจสอบโครงสร้างซอร์สโค้ดใน GitHub Repository ก่อนสั่งอัปเดตใหม่',
    },
    SCANNER_EXE_MODIFIED_VIOLATION: {
      step: 5,
      stepName: 'Test & Build',
      cause: 'ตรวจพบว่าไฟล์ ScannerSyncCli.exe มีการเปลี่ยนแปลง Checksum โดยไม่คาดคิด',
      fix: 'ตรวจสอบไฟล์ในโฟลเดอร์ ScannerReader และคืนค่าจากแหล่งที่เชื่อถือได้',
    },
    MIGRATION_EXECUTION_FAILED: {
      step: 5,
      stepName: 'Typecheck/Test/Build',
      cause: 'การรัน Database Migration ล้มเหลวกลางคัน ระบบไม่รีสตาร์ทบริการด้วยโค้ดใหม่',
      fix: 'ตรวจสอบคำสั่ง SQL ใน Log และตรวจสถานะตารางใน MySQL หากจำเป็นให้ทดสอบกู้คืนจาก Backup ล่าสุดด้วย scripts\\restore-test.ps1',
    },
    POST_MIGRATION_SCHEMA_VERIFICATION_FAILED: {
      step: 5,
      stepName: 'Typecheck/Test/Build',
      cause: 'การตรวจสอบโครงสร้างตารางหลังรัน Migration ไม่ผ่าน',
      fix: 'ตรวจสอบรายงาน --verify-schema ใน Log และตรวจสอบฐานข้อมูลก่อนเปิดใช้งาน',
    },
    BACKEND_START_FAILED: {
      step: 6,
      stepName: 'Deploy Application',
      cause: 'ไม่สามารถเริ่มโปรเซส Sam_Att Backend บนพอร์ต 4101 ได้',
      fix: 'ตรวจสอบสถานะ Windows Service / PM2 / Node process และ Runtime Logs ในโฟลเดอร์ logs/',
    },
    BACKEND_SERVICE_NOT_RUNNING: {
      step: 6,
      stepName: 'Deploy Application',
      cause: 'Windows Service ของ Sam_Att ไม่ได้อยู่ในสถานะ Running หลังสั่งรีสตาร์ท',
      fix: 'ตรวจสอบ Windows Event Viewer และโฟลเดอร์ logs/ บนเซิร์ฟเวอร์',
    },
    HEALTH_CHECK_FAILED: {
      step: 7,
      stepName: 'Health Check',
      cause: 'หลังรีสตาร์ทบริการแล้ว การตรวจสอบ /Sam_Att/ หรือ /api/Sam_Att/health บนพอร์ต 4101 ไม่ผ่านภายในเวลาที่กำหนด',
      fix: 'ตรวจสอบ Log การรันของบริการในโฟลเดอร์ logs/ และตรวจใบรับรอง TLS / การเชื่อมต่อ MySQL',
    },
    POST_DEPLOY_LOG_ERRORS: {
      step: 7,
      stepName: 'Health Check',
      cause: 'ตรวจพบข้อผิดพลาดร้ายแรง (Fatal Runtime Error) ในไฟล์ stderr log หลังเริ่มบริการ',
      fix: 'ตรวจสอบไฟล์ sam_att_runtime_stderr_*.log ในโฟลเดอร์ logs/ (ระบบย้อนกลับรุ่นเดิมให้แล้ว)',
    },
  };

  const entry = catalog[errorCode];
  if (entry) {
    return {
      exitCode,
      failedStepNumber: failedStepNumber ?? entry.step ?? null,
      failedStepName: failedStepName !== 'ไม่ระบุขั้นตอน' ? failedStepName : entry.stepName || failedStepName,
      errorCode,
      detectedCause: rawDetail ? `${entry.cause} (${rawDetail.slice(0, 240)})` : entry.cause,
      remediation: entry.fix,
      rollbackStatus,
      rollbackStatusThai,
    };
  }

  return {
    exitCode,
    failedStepNumber,
    failedStepName,
    errorCode,
    detectedCause: rawDetail
      ? `สคริปต์หยุดทำงานด้วยรหัสออก ${exitCode}: ${rawDetail.slice(0, 260)}`
      : `สคริปต์หยุดทำงานด้วยรหัสออก ${exitCode} กรุณาตรวจสอบรายละเอียดในบันทึกการทำงาน (Console Output)`,
    remediation: 'ตรวจสอบบรรทัด ERROR ในบันทึกการทำงานด้านล่าง และตรวจสอบไฟล์ Log ในโฟลเดอร์ logs/ บนเซิร์ฟเวอร์ก่อนลองอัปเดตอีกครั้ง',
    rollbackStatus,
    rollbackStatusThai,
  };
}
