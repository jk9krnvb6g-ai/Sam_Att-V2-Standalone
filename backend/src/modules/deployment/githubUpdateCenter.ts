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

let customGitHubFetcher: GitHubFetcher | null = null;
let cachedNotificationResult: { expiresAt: number; payload: GitHubVersionCheckResult } | null = null;

export function setGitHubFetcherForTests(fetcher: GitHubFetcher | null): void {
  customGitHubFetcher = fetcher;
  cachedNotificationResult = null;
}

export function hasCustomGitHubFetcherForTests(): boolean {
  return customGitHubFetcher !== null;
}

export function clearGitHubUpdateCacheForTests(): void {
  cachedNotificationResult = null;
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
    'User-Agent': 'Sam_Att-V2-Standalone-UpdateCenter',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (cfg.github.token) {
    headers.Authorization = `Bearer ${cfg.github.token}`;
  }

  if (customGitHubFetcher) {
    return customGitHubFetcher(fullUrl, headers, cfg.github.timeoutMs);
  }

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
    return { status: res.status, ok: res.ok, json, headers: headerMap };
  } finally {
    clearTimeout(timer);
  }
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

  // ใช้ cache สั้นๆ 5 นาทีเฉพาะกรณีไม่ใช่ forceRefresh และไม่ได้ส่ง overrideGit
  if (!options?.forceRefresh && !options?.overrideGit && cachedNotificationResult && cachedNotificationResult.expiresAt > Date.now()) {
    return cachedNotificationResult.payload;
  }

  const installed = await readInstalledVersionInfo(options?.cwd || process.cwd(), options?.overrideGit);
  const branch = cfg.github.branch || installed.branch || 'main';

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

  // 1. ตรวจสอบ Branch HEAD Commit จาก GitHub (Read-Only)
  let branchRes: GitHubHttpResponse;
  try {
    branchRes = await fetchGitHubJson(`/commits/${encodeURIComponent(branch)}`);
  } catch (err: unknown) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || /abort|timeout/i.test(err.message));
    const result: GitHubVersionCheckResult = {
      repository: repo,
      repositoryUrl: repoUrl,
      branch,
      checkedAt,
      status: 'GITHUB_UNREACHABLE',
      statusLabelThai: 'ไม่สามารถเชื่อมต่อ GitHub ได้',
      hasUpdates: false,
      githubReachable: false,
      githubError: isAbort
        ? `หมดเวลาการเชื่อมต่อ GitHub API (${cfg.github.timeoutMs} ms) กรุณาตรวจสอบการเชื่อมต่ออินเทอร์เน็ตหรือ Firewall ของเซิร์ฟเวอร์`
        : 'ไม่สามารถเชื่อมต่อ GitHub API ได้ในขณะนี้ กรุณาตรวจสอบเครือข่ายหรือ Firewall ของโรงพยาบาล',
      githubErrorCode: isAbort ? 'GITHUB_TIMEOUT' : 'GITHUB_NETWORK_ERROR',
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
      changelog: makeEmptyChangelog('ไม่สามารถดึงรายละเอียดการเปลี่ยนแปลงได้เนื่องจากไม่สามารถเชื่อมต่อ GitHub'),
      tokenConfigured: cfg.github.tokenConfigured,
    };
    return result;
  }

  if (!branchRes.ok || !branchRes.json || typeof branchRes.json !== 'object') {
    const ghMsg =
      typeof (branchRes.json as { message?: string } | null)?.message === 'string'
        ? (branchRes.json as { message: string }).message
        : `HTTP ${branchRes.status}`;
    const isRateLimited =
      branchRes.status === 403 &&
      (branchRes.headers?.['x-ratelimit-remaining'] === '0' || /rate limit/i.test(ghMsg));
    const result: GitHubVersionCheckResult = {
      repository: repo,
      repositoryUrl: repoUrl,
      branch,
      checkedAt,
      status: 'GITHUB_UNREACHABLE',
      statusLabelThai: isRateLimited
        ? 'เกินโควต้าการเรียก GitHub API (Rate Limit)'
        : `เชื่อมต่อ GitHub ไม่สำเร็จ (HTTP ${branchRes.status})`,
      hasUpdates: false,
      githubReachable: false,
      githubError: isRateLimited
        ? 'GitHub API จำกัดจำนวนครั้งการเรียกแบบไม่ระบุตัวตน (60 ครั้ง/ชั่วโมง) แนะนำให้กำหนด GITHUB_TOKEN ในไฟล์ .env ของฝั่ง Server'
        : `GitHub API ตอบกลับ HTTP ${branchRes.status}: ${ghMsg}`,
      githubErrorCode: isRateLimited ? 'GITHUB_RATE_LIMITED' : `GITHUB_HTTP_${branchRes.status}`,
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
      changelog: makeEmptyChangelog('ไม่สามารถดึงรายละเอียดการเปลี่ยนแปลงได้เนื่องจาก GitHub API ตอบกลับข้อผิดพลาด'),
      tokenConfigured: cfg.github.tokenConfigured,
    };
    return result;
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
    }
  } catch {
    // ไม่ให้ Releases error ทำให้ version check ทั้งหมดพัง — ดำเนินการต่อด้วย Commit API
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
          title: `พบไฟล์ Database Migration ใหม่: ${migFile} (ต้องให้ผู้ดูแลระบบตรวจสอบและอนุมัติก่อนรัน)`,
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
  };

  if (!options?.overrideGit) {
    cachedNotificationResult = {
      expiresAt: Date.now() + 5 * 60 * 1000,
      payload: result,
    };
  }

  return result;
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
      remediation: 'ตรวจสอบอินเทอร์เน็ต/Firewall ของเซิร์ฟเวอร์ หรือตั้งค่า GITHUB_TOKEN ในไฟล์ .env',
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

  // 6. Database Migrations & Checksums
  const mismatchCount = params.dbInspection.checksumMismatches.length;
  const pendingCount = params.combinedPendingMigrations.length;
  if (mismatchCount > 0) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'ความถูกต้องของ Database Migration & Checksum',
      status: 'FAIL',
      blocking: true,
      detail: `ตรวจพบ Checksum ไม่ตรงกัน ${mismatchCount} ไฟล์ (${params.dbInspection.checksumMismatches.map((m) => m.filename).join(', ')})`,
      remediation: 'ห้ามแก้ไขไฟล์ Migration ที่เคยรันแล้ว ตรวจสอบ schema_migrations และไฟล์ใน database/migrations/ ก่อนดำเนินการต่อ',
    });
  } else if (pendingCount > 0) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'ความถูกต้องของ Database Migration & Checksum',
      status: 'WARN',
      blocking: false,
      detail: `พบ Migration ใหม่ ${pendingCount} ไฟล์ (${params.combinedPendingMigrations.join(', ')}) — ต้องอนุมัติด้วยรหัสผ่าน ADMIN ก่อนรัน`,
      remediation: 'ตรวจสอบผลกระทบต่อตารางและยืนยันอนุมัติ Migration ในขั้นตอนถัดไป',
    });
  } else {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'ความถูกต้องของ Database Migration & Checksum',
      status: 'PASS',
      blocking: false,
      detail: `Checksum ถูกต้องครบถ้วน (รันแล้ว ${params.dbInspection.appliedMigrations.length} รุ่น ไม่มี Migration ค้าง)`,
      remediation: null,
    });
  }

  // 7. นโยบาย Backup นอก Git Repo และ Isolation Guard
  const backupRoot = process.env.SAM_ATT_BACKUP_DIR || 'C:\\SamAttBackups';
  const backupInsideRepo = path.resolve(backupRoot).toLowerCase().startsWith(path.resolve(cwd).toLowerCase());
  checks.push({
    id: 'BACKUP_AND_ISOLATION',
    label: 'นโยบายสำรองข้อมูลนอก Git Repo และแยกอิสระจากระบบอื่น',
    status: backupInsideRepo ? 'FAIL' : 'PASS',
    blocking: backupInsideRepo,
    detail: backupInsideRepo
      ? `พาธสำรองข้อมูล (${backupRoot}) อยู่ภายใน Git Repository ซึ่งผิดนโยบายความปลอดภัย`
      : `สำรองฐานข้อมูล ${cfg.samAttDb.database} ที่ ${backupRoot} ก่อน git pull และรีสตาร์ทเฉพาะ Sam_Att (ไม่แตะ Procurement / iisreset)`,
    remediation: backupInsideRepo ? 'ตั้งค่า SAM_ATT_BACKUP_DIR ให้อยู่นอกโฟลเดอร์โปรเจกต์ เช่น C:\\SamAttBackups' : null,
  });

  const blockingFailures = checks.filter((c) => c.status === 'FAIL' && c.blocking).length;
  const warnings = checks.filter((c) => c.status === 'WARN').length;
  const passedCount = checks.filter((c) => c.status === 'PASS').length;

  return {
    canDeploy: blockingFailures === 0,
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

  // 1. ดึง Step ที่ล้มเหลวจากรูปแบบ [X/7] StepName ... FAIL
  const stepFailMatch = combined.match(/\[(\d+)\/7\]\s+([^\.\r\n]+?)\s+\.+\s+FAIL/i);
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
      'PREFLIGHT_DIRTY_WORKING_TREE',
      'PREFLIGHT_WRONG_BRANCH',
      'PREFLIGHT_NODE_MISSING',
      'PREFLIGHT_NODE_VERSION_UNSUPPORTED',
      'PREFLIGHT_ENV_MISSING',
      'PREFLIGHT_INVALID_DATA_MODE',
      'PREFLIGHT_INVALID_DB_ENGINE',
      'PREFLIGHT_ENV_INCOMPLETE',
      'PREFLIGHT_IIS_PERMISSION_DENIED',
      'PREFLIGHT_PORT_4101_FOREIGN_PROCESS',
      'PREFLIGHT_BACKUP_DIR_INSIDE_GIT',
      'PREFLIGHT_BACKUP_DIR_UNWRITABLE',
      'PREFLIGHT_MISSING_CORE_FILE',
      'GIT_FETCH_FAILED',
      'GIT_PULL_FAILED',
      'MIGRATION_APPROVAL_REQUIRED',
      'MIGRATION_APPROVAL_MISMATCH',
      'MIGRATION_CHECKSUM_MISMATCH',
      'BACKUP_FAILED_NO_MYSQLDUMP',
      'BACKUP_FAILED',
      'NPM_INSTALL_FAILED',
      'TYPECHECK_FAILED',
      'UNIT_TESTS_FAILED',
      'BUILD_FAILED',
      'MIGRATION_EXECUTION_FAILED',
      'POST_MIGRATION_SCHEMA_VERIFICATION_FAILED',
      'HEALTH_CHECK_FAILED',
      'BACKEND_PROCESS_EXITED_IMMEDIATELY',
      'BACKEND_SERVICE_NOT_RUNNING',
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
  if (/DEPLOYMENT ABORTED \(NO SYSTEM CHANGES APPLIED\)/i.test(combined) || (failedStepNumber !== null && failedStepNumber <= 2)) {
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
    GIT_FETCH_FAILED: {
      step: 2,
      stepName: 'GitHub Update',
      cause: 'ไม่สามารถดึงข้อมูลล่าสุดจาก GitHub (git fetch) ได้',
      fix: 'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต Proxy/Firewall และสิทธิ์เข้าถึง GitHub Repository บนเซิร์ฟเวอร์',
    },
    GIT_PULL_FAILED: {
      step: 3,
      stepName: 'Backup',
      cause: 'คำสั่ง git pull --ff-only ไม่สำเร็จ (อาจมี Commit ในเครื่องที่แยกสายจาก origin/main)',
      fix: 'ตรวจสอบ git status และ git log --oneline -n 5 บนเซิร์ฟเวอร์เพื่อรวมหรือแก้ไขประวัติ Commit ด้วยตนเอง',
    },
    MIGRATION_APPROVAL_REQUIRED: {
      step: 2,
      stepName: 'GitHub Update',
      cause: 'พบไฟล์ Database Migration ใหม่ที่ยังไม่ได้รับการอนุมัติจากผู้ดูแลระบบ',
      fix: 'กดตรวจสอบเวอร์ชันอีกครั้ง ตรวจสอบรายการ Migration และอนุมัติด้วยรหัสผ่าน ADMIN ในหน้าจออัปเดตระบบ',
    },
    MIGRATION_APPROVAL_MISMATCH: {
      step: 2,
      stepName: 'GitHub Update',
      cause: 'รหัส Commit เป้าหมายหรือรายการไฟล์ Migration บน GitHub เปลี่ยนแปลงไปจากตอนที่กดอนุมัติ',
      fix: 'กด "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อโหลด Commit และรายการ Migration ล่าสุด แล้วทำขั้นตอนอนุมัติใหม่',
    },
    MIGRATION_CHECKSUM_MISMATCH: {
      step: 2,
      stepName: 'GitHub Update',
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
      stepName: 'Backup',
      cause: 'การสำรองฐานข้อมูล MySQL หรือไฟล์ก่อนอัปเดตล้มเหลว ระบบจึงยกเลิกทันทีก่อน git pull',
      fix: 'ตรวจสอบการเชื่อมต่อ MySQL, รหัสผ่านใน .env และพื้นที่ว่างใน C:\\SamAttBackups',
    },
    NPM_INSTALL_FAILED: {
      step: 4,
      stepName: 'Install Dependencies',
      cause: 'การติดตั้งแพ็กเกจ npm ล้มเหลว (อาจเกิดจากเครือข่ายหรือไฟล์ล็อกบน Windows)',
      fix: 'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตของเซิร์ฟเวอร์ และดูข้อความผิดพลาดจาก npm ใน Log ด้านล่าง',
    },
    TYPECHECK_FAILED: {
      step: 5,
      stepName: 'Typecheck/Test/Build',
      cause: 'การตรวจสอบชนิดข้อมูล TypeScript (npm run typecheck) ไม่ผ่าน',
      fix: 'ตรวจสอบ Log ของ TypeScript ด้านล่างและแก้ไขโค้ดบน GitHub ก่อนสั่งอัปเดตใหม่ (ระบบย้อนกลับรุ่นเดิมให้แล้ว)',
    },
    UNIT_TESTS_FAILED: {
      step: 5,
      stepName: 'Typecheck/Test/Build',
      cause: 'ชุดทดสอบอัตโนมัติ (npm test) มีบางรายการไม่ผ่าน',
      fix: 'ตรวจสอบผลการทดสอบใน Log ด้านล่างและแก้ไขก่อนนำขึ้นใช้งานจริง (ระบบย้อนกลับรุ่นเดิมให้แล้ว)',
    },
    BUILD_FAILED: {
      step: 5,
      stepName: 'Typecheck/Test/Build',
      cause: 'การคอมไพล์หน้าเว็บ Production (npm run build) ล้มเหลว',
      fix: 'ตรวจสอบข้อความผิดพลาดของ Vite Build ใน Log ด้านล่างและแก้ไขบน GitHub ก่อนลองใหม่',
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
    HEALTH_CHECK_FAILED: {
      step: 7,
      stepName: 'Health Check',
      cause: 'หลังรีสตาร์ทบริการแล้ว การตรวจสอบ /api/Sam_Att/health บนพอร์ต 4101 ไม่ผ่านภายในเวลาที่กำหนด',
      fix: 'ตรวจสอบ Log การรันของบริการในโฟลเดอร์ logs/ และตรวจใบรับรอง TLS / การเชื่อมต่อ MySQL',
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
