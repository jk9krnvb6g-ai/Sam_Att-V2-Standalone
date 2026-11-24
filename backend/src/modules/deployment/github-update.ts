/**
 * ============================================================================
 * โมดูลศูนย์อัปเดต GitHub และวิเคราะห์ข้อผิดพลาดการอัปเดต (Read-Only GitHub Update Center)
 * ไฟล์: backend/src/modules/deployment/github-update.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. อ่านเวอร์ชันและ Commit ที่ติดตั้งจริงบนเครื่อง (package.json + git read-only)
 * 2. ตรวจสอบสถานะเวอร์ชันจาก GitHub API ของ Repository โรงพยาบาลสามชุกแบบ Read-Only
 *    (Allowlist เฉพาะ https://api.github.com/repos/{owner}/{repo}/... ป้องกัน SSRF)
 * 3. สรุป Changelog ภาษาไทยแบบ Evidence-Based ตามลำดับความน่าเชื่อถือ:
 *    (1) GitHub Releases -> (2) CHANGELOG.md -> (3) GitHub Compare API / Commit History
 * 4. ประเมินความพร้อมก่อนอัปเดต (Readiness Checklist) โดยแยกเงื่อนไขที่บล็อกจริง
 * 5. วิเคราะห์สาเหตุข้อผิดพลาด Deployment (Exit Code / HTTP 422) พร้อมปกปิดข้อมูลลับทุกชนิด
 */

import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { loadConfig } from '../../config/env.ts';
import type { DetailedMigrationInspection } from '../../database/adapter.ts';

export type VersionCheckStatus =
  | 'UP_TO_DATE'
  | 'UPDATE_AVAILABLE'
  | 'DIVERGED_OR_UNKNOWN'
  | 'GITHUB_UNREACHABLE';

export type ReleaseAvailabilityType =
  | 'OFFICIAL_RELEASE'
  | 'COMMITS_WITHOUT_RELEASE'
  | 'NONE';

export type ChangelogSourceType =
  | 'GITHUB_RELEASE'
  | 'CHANGELOG_MD'
  | 'COMMIT_HISTORY'
  | 'NONE';

export type ChangelogCategoryKey =
  | 'features'
  | 'fixes'
  | 'improvements'
  | 'security'
  | 'database'
  | 'breaking';

export interface ChangelogItem {
  text: string;
  originalText: string;
  category: ChangelogCategoryKey;
  commitSha?: string | null;
  releaseTag?: string | null;
  date?: string | null;
  author?: string | null;
}

export interface ChangelogCategoryGroup {
  key: ChangelogCategoryKey;
  labelThai: string;
  items: ChangelogItem[];
}

export interface GitHubReleaseEntry {
  tagName: string;
  name: string;
  publishedAt: string | null;
  htmlUrl: string | null;
  body: string;
  prerelease: boolean;
}

export interface GitHubCommitEntry {
  sha: string;
  shortSha: string;
  message: string;
  subject: string;
  date: string | null;
  author: string | null;
  category: ChangelogCategoryKey;
}

export interface EvidenceBasedChangelog {
  sourceType: ChangelogSourceType;
  sourceLabelThai: string;
  hasOfficialReleaseNotes: boolean;
  isAutoSummarizedThai: boolean;
  transparencyNotice: string | null;
  totalChangesCount: number;
  releasesIncluded: GitHubReleaseEntry[];
  categories: ChangelogCategoryGroup[];
  commits: GitHubCommitEntry[];
}

export interface LocalInstalledState {
  packageVersion: string;
  gitAvailable: boolean;
  branch: string;
  currentCommit: string;
  currentShortCommit: string;
  currentTag: string | null;
  workingTreeClean: boolean;
  dirtyFiles: string[];
  warning: string | null;
}

export interface ReadinessCheckItem {
  id:
    | 'ADMIN_PERMISSION'
    | 'GITHUB_CONNECTIVITY'
    | 'DEPLOYMENT_CONFIG'
    | 'BUILD_REQUIREMENTS'
    | 'DATABASE_MIGRATIONS'
    | 'SAFETY_ISOLATION';
  label: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  blocking: boolean;
  detail: string;
}

export interface DeploymentReadinessReport {
  canExecuteUpdate: boolean;
  requiresMigrationApproval: boolean;
  blockingReasons: string[];
  checks: ReadinessCheckItem[];
}

export interface DeploymentErrorDiagnostics {
  failedStep: string;
  errorCode: string;
  detectedCause: string;
  remediationSteps: string[];
  exitCode: number;
  rolledBack: boolean;
  requiresAdminDatabaseRestore: boolean;
  httpStatus: number;
}

export interface GitHubUpdateCheckResult {
  repository: {
    owner: string;
    name: string;
    fullName: string;
    branch: string;
    htmlUrl: string;
    tokenConfigured: boolean;
  };
  status: VersionCheckStatus;
  statusLabelThai: string;
  statusDescriptionThai: string;
  releaseAvailability: ReleaseAvailabilityType;
  installed: {
    version: string;
    commitSha: string;
    shortCommitSha: string;
    tag: string | null;
    branch: string;
    gitAvailable: boolean;
    workingTreeClean: boolean;
    dirtyFiles: string[];
  };
  remote: {
    reachable: boolean;
    latestReleaseTag: string | null;
    latestReleaseName: string | null;
    latestReleasePublishedAt: string | null;
    targetCommitSha: string;
    targetShortCommitSha: string;
    targetCommitDate: string | null;
    targetCommitMessage: string | null;
    aheadBy: number | null;
    behindBy: number | null;
    compareStatus: 'identical' | 'ahead' | 'behind' | 'diverged' | 'unknown';
    errorCode: string | null;
    errorMessage: string | null;
  };
  changelog: EvidenceBasedChangelog;
  checkedAt: string;
}

export interface GitHubUpdateSummary {
  status: VersionCheckStatus;
  statusLabelThai: string;
  releaseAvailability: ReleaseAvailabilityType;
  installedVersion: string;
  installedCommit: string;
  latestReleaseTag: string | null;
  targetCommit: string;
  aheadBy: number | null;
  hasUpdateAvailable: boolean;
  checkedAt: string;
  cached: boolean;
  errorMessage: string | null;
}

export interface GitHubUpdateTestProviders {
  readLocalState?: () => Promise<LocalInstalledState>;
  fetchGitHub?: (
    url: string,
    headers: Record<string, string>
  ) => Promise<{ ok: boolean; status: number; json?: unknown; text?: string }>;
  platformOverride?: NodeJS.Platform;
  scriptExistsOverride?: boolean;
  nodeVersionOverride?: string;
}

const DEFAULT_REPO_OWNER = 'jk9krnvb6g-ai';
const DEFAULT_REPO_NAME = 'Sam_Att-V2-Standalone';
const DEFAULT_PRODUCTION_BRANCH = 'main';
const GITHUB_API_BASE = 'https://api.github.com';
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;

let testProviders: GitHubUpdateTestProviders | null = null;
let cachedFullCheck: { result: GitHubUpdateCheckResult; expiresAt: number } | null = null;

export function setGitHubUpdateProvidersForTests(
  providers: GitHubUpdateTestProviders | null
): void {
  testProviders = providers;
  cachedFullCheck = null;
}

export function clearGitHubUpdateCache(): void {
  cachedFullCheck = null;
}

const CATEGORY_LABELS_THAI: Record<ChangelogCategoryKey, string> = {
  features: 'ฟีเจอร์ใหม่',
  fixes: 'แก้ไขข้อผิดพลาด',
  improvements: 'ปรับปรุงระบบ',
  security: 'การเปลี่ยนแปลงด้านความปลอดภัย',
  database: 'การเปลี่ยนแปลงฐานข้อมูล',
  breaking: 'การเปลี่ยนแปลงที่อาจกระทบการใช้งาน',
};

const CATEGORY_ORDER: readonly ChangelogCategoryKey[] = [
  'features',
  'fixes',
  'improvements',
  'security',
  'database',
  'breaking',
];

/**
 * อ่านและตรวจสอบค่าตั้งค่า GitHub Repository แบบปลอดภัย (ป้องกัน SSRF / Path Traversal)
 */
export function getGitHubRepoConfig(): {
  owner: string;
  name: string;
  branch: string;
  token: string;
} {
  const rawOwner = (process.env.GITHUB_REPO_OWNER || DEFAULT_REPO_OWNER).trim();
  const rawName = (process.env.GITHUB_REPO_NAME || DEFAULT_REPO_NAME).trim();
  const rawBranch = (
    process.env.GITHUB_PRODUCTION_BRANCH ||
    process.env.GITHUB_BRANCH ||
    DEFAULT_PRODUCTION_BRANCH
  ).trim();

  const owner = /^[A-Za-z0-9_.-]{1,100}$/.test(rawOwner) ? rawOwner : DEFAULT_REPO_OWNER;
  const name = /^[A-Za-z0-9_.-]{1,100}$/.test(rawName) ? rawName : DEFAULT_REPO_NAME;
  const branch =
    /^[A-Za-z0-9._/-]{1,120}$/.test(rawBranch) && !rawBranch.includes('..')
      ? rawBranch
      : DEFAULT_PRODUCTION_BRANCH;
  const token = (process.env.GITHUB_TOKEN || '').trim();

  return { owner, name, branch, token };
}

/**
 * ปกปิดข้อมูลลับ รหัสผ่าน Token และ Connection String ทุกชนิดก่อนส่งให้ Frontend หรือบันทึกลง Log
 */
export function sanitizeDeploymentSecrets(input: string): string {
  let out = String(input || '');
  if (!out) return '';

  // Mask live env secrets if present (length >= 4)
  const runtimeSecrets = [
    process.env.SAM_ATT_DB_PASSWORD,
    process.env.HOSOFFICE_DB_PASSWORD,
    process.env.HOSOFFICE_PUSH_WRITE_PASSWORD,
    process.env.JWT_SECRET,
    process.env.SCANNER_INGEST_SHARED_TOKEN,
    process.env.GITHUB_TOKEN,
  ];
  for (const secret of runtimeSecrets) {
    if (secret && secret.trim().length >= 4 && secret.trim() !== 'CHANGE_ME') {
      out = out.split(secret.trim()).join('***REDACTED***');
    }
  }

  return out
    .replace(
      /(PASSWORD|PWD|SECRET|TOKEN|API_KEY|MYSQL_PWD|PRIVATE_KEY|ACCESS_KEY)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s;&",)]+)/gi,
      '$1=***REDACTED***'
    )
    .replace(/(--password|-p)\s*=?\s*([^\s;&"]+)/gi, '$1=***REDACTED***')
    .replace(/(Bearer|token)\s+[A-Za-z0-9._\-+/=]{8,}/gi, '$1 ***REDACTED***')
    .replace(/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g, '***REDACTED***')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***REDACTED***')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1***REDACTED***$3');
}

function runGitSafe(
  args: string[],
  cwd: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 12000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
      });
    });
  });
}

export function readInstalledPackageVersion(cwd = process.cwd()): string {
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (parsed.version && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // Fallback below
  }
  return '2.0.0';
}

export async function readLocalInstalledState(cwd = process.cwd()): Promise<LocalInstalledState> {
  if (testProviders?.readLocalState) {
    return testProviders.readLocalState();
  }

  const packageVersion = readInstalledPackageVersion(cwd);
  const [branchRes, headRes, tagRes, dirtyRes] = await Promise.all([
    runGitSafe(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    runGitSafe(['rev-parse', 'HEAD'], cwd),
    runGitSafe(['describe', '--tags', '--exact-match', 'HEAD'], cwd),
    runGitSafe(['status', '--porcelain', '--untracked-files=no'], cwd),
  ]);

  if (!branchRes.ok || !headRes.ok || !headRes.stdout) {
    return {
      packageVersion,
      gitAvailable: false,
      branch: getGitHubRepoConfig().branch,
      currentCommit: 'unknown',
      currentShortCommit: 'unknown',
      currentTag: null,
      workingTreeClean: true,
      dirtyFiles: [],
      warning: 'ไม่พบข้อมูล Git Repository บนเครื่องนี้ (ไม่สามารถอ่าน Commit ที่ติดตั้งจาก .git ได้)',
    };
  }

  const dirtyFiles = dirtyRes.ok && dirtyRes.stdout
    ? dirtyRes.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => Boolean(line) && !line.endsWith('package-lock.json'))
    : [];

  return {
    packageVersion,
    gitAvailable: true,
    branch: branchRes.stdout || getGitHubRepoConfig().branch,
    currentCommit: headRes.stdout,
    currentShortCommit: headRes.stdout.slice(0, 8),
    currentTag: tagRes.ok && tagRes.stdout ? tagRes.stdout : null,
    workingTreeClean: dirtyFiles.length === 0,
    dirtyFiles,
    warning: null,
  };
}

async function fetchGitHubApi(
  apiPath: string,
  token: string
): Promise<{ ok: boolean; status: number; json?: unknown; text?: string }> {
  // Strictly allowlist paths under /repos/{owner}/{repo}/
  if (!apiPath.startsWith('/repos/')) {
    throw new Error('INVALID_GITHUB_API_PATH');
  }
  const url = `${GITHUB_API_BASE}${apiPath}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Sam_Att-V2-Standalone-UpdateCenter',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (testProviders?.fetchGitHub) {
    return testProviders.fetchGitHub(url, headers);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const text = await resp.text();
    let json: unknown = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return {
      ok: resp.ok,
      status: resp.status,
      json,
      text,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function classifyChangelogCategory(rawText: string): ChangelogCategoryKey {
  const lower = rawText.toLowerCase();
  if (
    /breaking[\s-]?change|!:|\bmigration required\b|กระทบการใช้งาน|เปลี่ยนโครงสร้างหลัก|incompatible|deprecated/i.test(
      rawText
    )
  ) {
    return 'breaking';
  }
  if (
    /\b(security|sec|auth|csrf|xss|ssrf|rbac|jwt|redact|secret|password|vulnerability|cve)\b|ความปลอดภัย|สิทธิ์|รหัสผ่าน|ปกปิดข้อมูลลับ/i.test(
      rawText
    )
  ) {
    return 'security';
  }
  if (
    /\b(migration|schema|sql|mysql|database|db:|alter table|create table|index)\b|ฐานข้อมูล|ตาราง|คอลัมน์/i.test(
      rawText
    )
  ) {
    return 'database';
  }
  if (
    /^fix(\(|:|\s)|^bugfix|\b(fix|fixed|bug|hotfix|patch|resolve|resolved|error|422|exit code)\b|แก้ไข|แก้บั๊ก|ข้อผิดพลาด/i.test(
      lower
    )
  ) {
    return 'fixes';
  }
  if (
    /^feat(\(|:|\s)|\b(feat|feature|add|added|new|implement|implemented|introduce)\b|เพิ่มฟีเจอร์|ฟีเจอร์ใหม่|เพิ่มหน้า|เพิ่มเมนู/i.test(
      lower
    )
  ) {
    return 'features';
  }
  return 'improvements';
}

function summarizeLineToThai(rawText: string, category: ChangelogCategoryKey): {
  text: string;
  translatedFromEnglish: boolean;
} {
  const cleaned = rawText
    .replace(/^[-*•]\s*/, '')
    .replace(/^(feat|fix|chore|refactor|perf|docs|style|test|build|ci|sec)(\([^)]+\))?!?:\s*/i, '')
    .trim();

  // If the original message already contains Thai characters, keep it faithful as-is
  if (/[\u0E00-\u0E7F]/.test(cleaned)) {
    return { text: cleaned, translatedFromEnglish: false };
  }

  const prefixByCat: Record<ChangelogCategoryKey, string> = {
    features: 'เพิ่มความสามารถใหม่: ',
    fixes: 'แก้ไขปัญหา: ',
    improvements: 'ปรับปรุงระบบ: ',
    security: 'ปรับปรุงความปลอดภัย: ',
    database: 'เปลี่ยนแปลงฐานข้อมูล: ',
    breaking: 'ข้อควรระวังก่อนอัปเดต: ',
  };

  return {
    text: `${prefixByCat[category]}${cleaned}`,
    translatedFromEnglish: true,
  };
}

function buildCategoryGroups(items: ChangelogItem[]): ChangelogCategoryGroup[] {
  const map = new Map<ChangelogCategoryKey, ChangelogItem[]>();
  for (const key of CATEGORY_ORDER) {
    map.set(key, []);
  }
  for (const item of items) {
    const arr = map.get(item.category);
    if (arr) {
      arr.push(item);
    }
  }
  return CATEGORY_ORDER.map((key) => ({
    key,
    labelThai: CATEGORY_LABELS_THAI[key],
    items: map.get(key) || [],
  })).filter((g) => g.items.length > 0);
}

function parseBulletLinesFromMarkdown(
  markdown: string,
  meta: { releaseTag?: string | null; date?: string | null }
): { items: ChangelogItem[]; translatedAny: boolean } {
  const lines = markdown.split(/\r?\n/);
  let currentHeadingCategory: ChangelogCategoryKey | null = null;
  const items: ChangelogItem[] = [];
  let translatedAny = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    // Detect markdown section headings (## Added / ### แก้ไขข้อผิดพลาด / etc.)
    if (/^#{1,4}\s+/.test(line)) {
      const heading = line.replace(/^#{1,4}\s+/, '').trim();
      if (/breaking|กระทบ/i.test(heading)) currentHeadingCategory = 'breaking';
      else if (/security|ความปลอดภัย/i.test(heading)) currentHeadingCategory = 'security';
      else if (/database|migration|ฐานข้อมูล/i.test(heading)) currentHeadingCategory = 'database';
      else if (/fix|bug|แก้ไข/i.test(heading)) currentHeadingCategory = 'fixes';
      else if (/feat|added|new|ฟีเจอร์/i.test(heading)) currentHeadingCategory = 'features';
      else if (/improv|changed|perf|refactor|ปรับปรุง/i.test(heading))
        currentHeadingCategory = 'improvements';
      else currentHeadingCategory = null;
      continue;
    }

    if (/^[-*•]\s+/.test(line) || /^\d+\.\s+/.test(line)) {
      const content = line.replace(/^([-*•]|\d+\.)\s+/, '').trim();
      if (!content || content.length < 3) continue;
      const cat = currentHeadingCategory || classifyChangelogCategory(content);
      const { text, translatedFromEnglish } = summarizeLineToThai(content, cat);
      if (translatedFromEnglish) translatedAny = true;
      items.push({
        text,
        originalText: content,
        category: cat,
        releaseTag: meta.releaseTag || null,
        date: meta.date || null,
      });
    }
  }

  // If markdown has plain paragraphs without bullets, preserve concise lines honestly
  if (items.length === 0) {
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || /^#{1,4}\s+/.test(line) || /^```/.test(line)) continue;
      const cat = classifyChangelogCategory(line);
      const { text, translatedFromEnglish } = summarizeLineToThai(line, cat);
      if (translatedFromEnglish) translatedAny = true;
      items.push({
        text,
        originalText: line,
        category: cat,
        releaseTag: meta.releaseTag || null,
        date: meta.date || null,
      });
      if (items.length >= 25) break;
    }
  }

  return { items, translatedAny };
}

function normalizeSemverTag(tag: string): string {
  return tag.trim().replace(/^v/i, '').replace(/-standalone$/i, '');
}

function compareSemverLoose(a: string, b: string): number {
  const pa = normalizeSemverTag(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = normalizeSemverTag(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va !== vb) return va > vb ? 1 : -1;
  }
  return 0;
}

function parseChangelogMdBetweenVersions(
  markdown: string,
  installedVersion: string
): { items: ChangelogItem[]; translatedAny: boolean; matchedSections: string[] } {
  const lines = markdown.split(/\r?\n/);
  const sections: Array<{ version: string; date: string | null; bodyLines: string[] }> = [];
  let current: { version: string; date: string | null; bodyLines: string[] } | null = null;

  for (const line of lines) {
    const match = line.match(/^##\s+\[?v?([0-9]+\.[0-9]+\.[0-9]+[^\s\]]*)\]?(?:\s*[-–—]\s*([0-9-]+))?/i);
    if (match) {
      current = {
        version: match[1].trim(),
        date: match[2] ? match[2].trim() : null,
        bodyLines: [],
      };
      sections.push(current);
      continue;
    }
    if (current) {
      current.bodyLines.push(line);
    }
  }

  const relevantSections = sections.filter((s) => compareSemverLoose(s.version, installedVersion) > 0);
  const chosenSections = relevantSections.length > 0 ? relevantSections : sections.slice(0, 3);
  const items: ChangelogItem[] = [];
  let translatedAny = false;

  for (const sec of chosenSections) {
    const parsed = parseBulletLinesFromMarkdown(sec.bodyLines.join('\n'), {
      releaseTag: `v${sec.version}`,
      date: sec.date,
    });
    if (parsed.translatedAny) translatedAny = true;
    items.push(...parsed.items);
  }

  return {
    items,
    translatedAny,
    matchedSections: chosenSections.map((s) => s.version),
  };
}

function buildEvidenceBasedChangelog(params: {
  status: VersionCheckStatus;
  installedVersion: string;
  installedTag: string | null;
  releases: GitHubReleaseEntry[];
  changelogMdText: string | null;
  commits: GitHubCommitEntry[];
}): EvidenceBasedChangelog {
  const { status, installedVersion, installedTag, releases, changelogMdText, commits } = params;

  if (status === 'GITHUB_UNREACHABLE') {
    return {
      sourceType: 'NONE',
      sourceLabelThai: 'ไม่สามารถเชื่อมต่อ GitHub ได้',
      hasOfficialReleaseNotes: false,
      isAutoSummarizedThai: false,
      transparencyNotice: 'ไม่สามารถดึงรายละเอียดการเปลี่ยนแปลงจาก GitHub ได้ในขณะนี้',
      totalChangesCount: 0,
      releasesIncluded: [],
      categories: [],
      commits: [],
    };
  }

  if (status === 'UP_TO_DATE') {
    return {
      sourceType: 'NONE',
      sourceLabelThai: 'ระบบเป็นเวอร์ชันล่าสุดแล้ว',
      hasOfficialReleaseNotes: releases.length > 0,
      isAutoSummarizedThai: false,
      transparencyNotice: null,
      totalChangesCount: 0,
      releasesIncluded: [],
      categories: [],
      commits: [],
    };
  }

  // Filter releases newer than currently installed version/tag (supports cumulative multi-version diff)
  const newerReleases = releases.filter((rel) => {
    if (installedTag && rel.tagName === installedTag) return false;
    return compareSemverLoose(rel.tagName, installedVersion) > 0;
  });

  // Priority 1: GitHub Releases with real release notes
  const releasesWithNotes = newerReleases.filter((r) => r.body && r.body.trim().length > 0);
  if (releasesWithNotes.length > 0) {
    const allItems: ChangelogItem[] = [];
    let translatedAny = false;
    for (const rel of releasesWithNotes) {
      const parsed = parseBulletLinesFromMarkdown(rel.body, {
        releaseTag: rel.tagName,
        date: rel.publishedAt,
      });
      if (parsed.translatedAny) translatedAny = true;
      allItems.push(...parsed.items);
    }
    if (allItems.length > 0) {
      return {
        sourceType: 'GITHUB_RELEASE',
        sourceLabelThai:
          releasesWithNotes.length > 1
            ? `GitHub Releases สะสม ${releasesWithNotes.length} เวอร์ชัน`
            : `GitHub Release (${releasesWithNotes[0].tagName})`,
        hasOfficialReleaseNotes: true,
        isAutoSummarizedThai: translatedAny,
        transparencyNotice: translatedAny
          ? 'ข้อความบางรายการถูกจัดหมวดหมู่และสรุปเป็นภาษาไทยจาก Release Notes จริงบน GitHub (สามารถดูข้อความต้นฉบับได้)'
          : null,
        totalChangesCount: allItems.length,
        releasesIncluded: releasesWithNotes,
        categories: buildCategoryGroups(allItems),
        commits,
      };
    }
  }

  // Priority 2: CHANGELOG.md from repository
  if (changelogMdText && changelogMdText.trim().length > 0) {
    const parsedMd = parseChangelogMdBetweenVersions(changelogMdText, installedVersion);
    if (parsedMd.items.length > 0) {
      return {
        sourceType: 'CHANGELOG_MD',
        sourceLabelThai:
          parsedMd.matchedSections.length > 1
            ? `ไฟล์ CHANGELOG.md (สะสม ${parsedMd.matchedSections.length} รุ่น)`
            : 'ไฟล์ CHANGELOG.md จาก Repository',
        hasOfficialReleaseNotes: true,
        isAutoSummarizedThai: parsedMd.translatedAny,
        transparencyNotice: parsedMd.translatedAny
          ? 'รายละเอียดถูกดึงจากไฟล์ CHANGELOG.md จริง และจัดหมวดหมู่/สรุปบางส่วนเป็นภาษาไทย'
          : null,
        totalChangesCount: parsedMd.items.length,
        releasesIncluded: newerReleases,
        categories: buildCategoryGroups(parsedMd.items),
        commits,
      };
    }
  }

  // Priority 3: Real GitHub Compare API / Commit History
  if (commits.length > 0) {
    const items: ChangelogItem[] = [];
    let translatedAny = false;
    for (const c of commits) {
      const { text, translatedFromEnglish } = summarizeLineToThai(c.subject, c.category);
      if (translatedFromEnglish) translatedAny = true;
      items.push({
        text,
        originalText: c.subject,
        category: c.category,
        commitSha: c.shortSha,
        date: c.date,
        author: c.author,
      });
    }

    return {
      sourceType: 'COMMIT_HISTORY',
      sourceLabelThai: `ประวัติ Commit จริงบน GitHub (${commits.length} รายการ)`,
      hasOfficialReleaseNotes: false,
      isAutoSummarizedThai: translatedAny,
      transparencyNotice:
        'Repository ยังไม่มี Official Release Notes สำหรับรุ่นนี้ ระบบจึงแสดงรายละเอียดจากประวัติ Commit จริงบน GitHub และจัดกลุ่มเป็นภาษาไทยเพื่อให้อ่านง่าย (ไม่ใช่บันทึก Release Notes อย่างเป็นทางการ)',
      totalChangesCount: items.length,
      releasesIncluded: newerReleases,
      categories: buildCategoryGroups(items),
      commits,
    };
  }

  return {
    sourceType: 'NONE',
    sourceLabelThai: 'ไม่พบรายละเอียดการเปลี่ยนแปลงเพิ่มเติม',
    hasOfficialReleaseNotes: false,
    isAutoSummarizedThai: false,
    transparencyNotice: 'ยังไม่มี Release Notes หรือรายการ Commit ที่แตกต่างกันให้แสดง',
    totalChangesCount: 0,
    releasesIncluded: newerReleases,
    categories: [],
    commits: [],
  };
}

/**
 * ตรวจสอบเวอร์ชันและดึง Changelog จาก GitHub แบบ Read-Only (ไม่ดาวน์โหลดและไม่ติดตั้งอัตโนมัติ)
 */
export async function checkGitHubUpdateReadOnly(options?: {
  forceRefresh?: boolean;
  cwd?: string;
}): Promise<GitHubUpdateCheckResult> {
  const now = Date.now();
  if (!options?.forceRefresh && cachedFullCheck && cachedFullCheck.expiresAt > now) {
    return cachedFullCheck.result;
  }

  const repoCfg = getGitHubRepoConfig();
  const local = await readLocalInstalledState(options?.cwd || process.cwd());
  const checkedAt = new Date().toISOString();
  const repoInfo = {
    owner: repoCfg.owner,
    name: repoCfg.name,
    fullName: `${repoCfg.owner}/${repoCfg.name}`,
    branch: repoCfg.branch,
    htmlUrl: `https://github.com/${repoCfg.owner}/${repoCfg.name}`,
    tokenConfigured: Boolean(repoCfg.token),
  };

  try {
    // 1. Fetch latest commit on configured production branch
    const branchCommitResp = await fetchGitHubApi(
      `/repos/${repoCfg.owner}/${repoCfg.name}/commits/${encodeURIComponent(repoCfg.branch)}`,
      repoCfg.token
    );

    if (!branchCommitResp.ok || !branchCommitResp.json || typeof branchCommitResp.json !== 'object') {
      const rateLimited = branchCommitResp.status === 403 || branchCommitResp.status === 429;
      const errCode = rateLimited
        ? 'GITHUB_RATE_LIMITED'
        : branchCommitResp.status === 404
          ? 'GITHUB_REPO_OR_BRANCH_NOT_FOUND'
          : `GITHUB_HTTP_${branchCommitResp.status || 'ERROR'}`;
      const errMsg = rateLimited
        ? 'GitHub API จำกัดจำนวนคำขอชั่วคราว (Rate Limit) — แนะนำให้ตั้งค่า GITHUB_TOKEN ในไฟล์ .env บนเซิร์ฟเวอร์'
        : branchCommitResp.status === 404
          ? `ไม่พบ Repository หรือ Branch "${repoCfg.branch}" บน GitHub (${repoCfg.owner}/${repoCfg.name})`
          : `ไม่สามารถเชื่อมต่อ GitHub API ได้ในขณะนี้ (HTTP ${branchCommitResp.status || 'ERR'})`;

      const unreachableResult: GitHubUpdateCheckResult = {
        repository: repoInfo,
        status: 'GITHUB_UNREACHABLE',
        statusLabelThai: 'ไม่สามารถตรวจสอบ GitHub ได้',
        statusDescriptionThai: errMsg,
        releaseAvailability: 'NONE',
        installed: {
          version: local.packageVersion,
          commitSha: local.currentCommit,
          shortCommitSha: local.currentShortCommit,
          tag: local.currentTag,
          branch: local.branch,
          gitAvailable: local.gitAvailable,
          workingTreeClean: local.workingTreeClean,
          dirtyFiles: local.dirtyFiles,
        },
        remote: {
          reachable: false,
          latestReleaseTag: null,
          latestReleaseName: null,
          latestReleasePublishedAt: null,
          targetCommitSha: 'unknown',
          targetShortCommitSha: 'unknown',
          targetCommitDate: null,
          targetCommitMessage: null,
          aheadBy: null,
          behindBy: null,
          compareStatus: 'unknown',
          errorCode: errCode,
          errorMessage: errMsg,
        },
        changelog: buildEvidenceBasedChangelog({
          status: 'GITHUB_UNREACHABLE',
          installedVersion: local.packageVersion,
          installedTag: local.currentTag,
          releases: [],
          changelogMdText: null,
          commits: [],
        }),
        checkedAt,
      };
      return unreachableResult;
    }

    const headObj = branchCommitResp.json as {
      sha?: string;
      commit?: {
        message?: string;
        author?: { date?: string; name?: string };
        committer?: { date?: string; name?: string };
      };
    };
    const targetCommitSha = String(headObj.sha || '').trim() || 'unknown';
    const targetShortCommitSha = targetCommitSha !== 'unknown' ? targetCommitSha.slice(0, 8) : 'unknown';
    const targetCommitDate =
      headObj.commit?.committer?.date || headObj.commit?.author?.date || null;
    const targetCommitMessage = headObj.commit?.message
      ? String(headObj.commit.message).split(/\r?\n/)[0].trim()
      : null;

    // 2. Fetch releases & CHANGELOG.md in parallel (best effort; non-fatal if absent)
    const [releasesResp, changelogFileResp] = await Promise.all([
      fetchGitHubApi(`/repos/${repoCfg.owner}/${repoCfg.name}/releases?per_page=15`, repoCfg.token).catch(
        () => ({ ok: false, status: 0, json: undefined, text: undefined })
      ),
      fetchGitHubApi(
        `/repos/${repoCfg.owner}/${repoCfg.name}/contents/CHANGELOG.md?ref=${encodeURIComponent(repoCfg.branch)}`,
        repoCfg.token
      ).catch(() => ({ ok: false, status: 0, json: undefined, text: undefined })),
    ]);

    const releases: GitHubReleaseEntry[] = Array.isArray(releasesResp.json)
      ? (releasesResp.json as Array<Record<string, unknown>>)
          .filter((r) => r && !r.draft)
          .map((r) => ({
            tagName: String(r.tag_name || '').trim(),
            name: String(r.name || r.tag_name || '').trim(),
            publishedAt: r.published_at ? String(r.published_at) : null,
            htmlUrl: r.html_url ? String(r.html_url) : null,
            body: String(r.body || ''),
            prerelease: Boolean(r.prerelease),
          }))
          .filter((r) => Boolean(r.tagName))
      : [];

    const latestRelease = releases[0] || null;

    let changelogMdText: string | null = null;
    if (
      changelogFileResp.ok &&
      changelogFileResp.json &&
      typeof changelogFileResp.json === 'object'
    ) {
      const contentObj = changelogFileResp.json as { content?: string; encoding?: string };
      if (contentObj.content && contentObj.encoding === 'base64') {
        try {
          changelogMdText = Buffer.from(
            contentObj.content.replace(/\s+/g, ''),
            'base64'
          ).toString('utf8');
        } catch {
          changelogMdText = null;
        }
      }
    }

    // 3. Compare installed commit against target commit on GitHub
    let compareStatus: 'identical' | 'ahead' | 'behind' | 'diverged' | 'unknown' = 'unknown';
    let aheadBy: number | null = null;
    let behindBy: number | null = null;
    let commits: GitHubCommitEntry[] = [];

    if (local.gitAvailable && local.currentCommit !== 'unknown' && targetCommitSha !== 'unknown') {
      if (local.currentCommit === targetCommitSha) {
        compareStatus = 'identical';
        aheadBy = 0;
        behindBy = 0;
      } else {
        const compareResp = await fetchGitHubApi(
          `/repos/${repoCfg.owner}/${repoCfg.name}/compare/${encodeURIComponent(
            local.currentCommit
          )}...${encodeURIComponent(targetCommitSha)}`,
          repoCfg.token
        ).catch(() => ({ ok: false, status: 0, json: undefined, text: undefined }));

        if (compareResp.ok && compareResp.json && typeof compareResp.json === 'object') {
          const cmp = compareResp.json as {
            status?: string;
            ahead_by?: number;
            behind_by?: number;
            commits?: Array<{
              sha?: string;
              commit?: {
                message?: string;
                author?: { name?: string; date?: string };
              };
            }>;
          };
          const rawStatus = String(cmp.status || '').toLowerCase();
          if (
            rawStatus === 'identical' ||
            rawStatus === 'ahead' ||
            rawStatus === 'behind' ||
            rawStatus === 'diverged'
          ) {
            compareStatus = rawStatus;
          }
          aheadBy = typeof cmp.ahead_by === 'number' ? cmp.ahead_by : null;
          behindBy = typeof cmp.behind_by === 'number' ? cmp.behind_by : null;
          if (Array.isArray(cmp.commits)) {
            commits = cmp.commits.map((c) => {
              const sha = String(c.sha || '').trim();
              const fullMsg = String(c.commit?.message || '').trim();
              const subject = fullMsg.split(/\r?\n/)[0].trim();
              return {
                sha,
                shortSha: sha.slice(0, 8),
                message: fullMsg,
                subject,
                date: c.commit?.author?.date || null,
                author: c.commit?.author?.name || null,
                category: classifyChangelogCategory(fullMsg),
              };
            });
          }
        } else {
          // 404 or unknown base commit in remote history -> diverged/unknown
          compareStatus = 'diverged';
        }
      }
    }

    // If commits list is empty and we're not up-to-date, fetch recent branch commits for honest visibility
    if (commits.length === 0 && compareStatus !== 'identical') {
      const recentResp = await fetchGitHubApi(
        `/repos/${repoCfg.owner}/${repoCfg.name}/commits?sha=${encodeURIComponent(repoCfg.branch)}&per_page=15`,
        repoCfg.token
      ).catch(() => ({ ok: false, status: 0, json: undefined, text: undefined }));

      if (recentResp.ok && Array.isArray(recentResp.json)) {
        commits = (
          recentResp.json as Array<{
            sha?: string;
            commit?: { message?: string; author?: { name?: string; date?: string } };
          }>
        ).map((c) => {
          const sha = String(c.sha || '').trim();
          const fullMsg = String(c.commit?.message || '').trim();
          const subject = fullMsg.split(/\r?\n/)[0].trim();
          return {
            sha,
            shortSha: sha.slice(0, 8),
            message: fullMsg,
            subject,
            date: c.commit?.author?.date || null,
            author: c.commit?.author?.name || null,
            category: classifyChangelogCategory(fullMsg),
          };
        });
      }
    }

    // 4. Classify into the 4 strict statuses
    let status: VersionCheckStatus;
    let statusLabelThai: string;
    let statusDescriptionThai: string;
    let releaseAvailability: ReleaseAvailabilityType = 'NONE';

    const hasNewerOfficialRelease =
      Boolean(latestRelease) &&
      (!local.currentTag || latestRelease!.tagName !== local.currentTag) &&
      compareSemverLoose(latestRelease!.tagName, local.packageVersion) > 0;

    if (!local.gitAvailable || local.currentCommit === 'unknown') {
      status = 'DIVERGED_OR_UNKNOWN';
      statusLabelThai = 'ไม่สามารถยืนยัน Commit ที่ติดตั้งได้';
      statusDescriptionThai =
        'ไม่พบข้อมูล .git บนเครื่องปัจจุบัน จึงไม่สามารถเปรียบเทียบ Commit กับ GitHub ได้โดยตรง (แสดงสถานะล่าสุดจาก GitHub เพื่ออ้างอิง)';
      releaseAvailability = hasNewerOfficialRelease ? 'OFFICIAL_RELEASE' : 'COMMITS_WITHOUT_RELEASE';
    } else if (local.branch !== repoCfg.branch) {
      status = 'DIVERGED_OR_UNKNOWN';
      statusLabelThai = 'เวอร์ชันแตกต่างหรืออยู่คนละ Branch';
      statusDescriptionThai = `เครื่องปัจจุบันอยู่ที่ Branch "${local.branch}" ซึ่งแตกต่างจาก Production Branch "${repoCfg.branch}" กรุณาตรวจสอบก่อนอัปเดต`;
    } else if (compareStatus === 'identical') {
      status = 'UP_TO_DATE';
      statusLabelThai = 'เป็นเวอร์ชันล่าสุดแล้ว';
      statusDescriptionThai = `Commit ที่ติดตั้งอยู่ (${local.currentShortCommit}) ตรงกับ GitHub Branch ${repoCfg.branch} ล่าสุดแล้ว`;
      releaseAvailability = 'NONE';
    } else if (compareStatus === 'ahead') {
      status = 'UPDATE_AVAILABLE';
      releaseAvailability = hasNewerOfficialRelease
        ? 'OFFICIAL_RELEASE'
        : 'COMMITS_WITHOUT_RELEASE';
      statusLabelThai =
        releaseAvailability === 'OFFICIAL_RELEASE'
          ? `มีเวอร์ชันใหม่ (${latestRelease!.tagName})`
          : 'มีอัปเดตใหม่บน GitHub (ยังไม่มี Release Tag)';
      statusDescriptionThai =
        releaseAvailability === 'OFFICIAL_RELEASE'
          ? `พบ GitHub Release ใหม่ ${latestRelease!.tagName} และมีการเปลี่ยนแปลงใหม่ ${aheadBy ?? commits.length} Commit บน Branch ${repoCfg.branch}`
          : `พบการเปลี่ยนแปลงใหม่ ${aheadBy ?? commits.length} Commit บน Branch ${repoCfg.branch} (ยังไม่มีการสร้าง GitHub Release Tag ใหม่)`;
    } else {
      status = 'DIVERGED_OR_UNKNOWN';
      statusLabelThai = 'เวอร์ชันแตกต่างหรือประวัติ Commit ไม่ตรงกัน';
      statusDescriptionThai =
        compareStatus === 'behind'
          ? `เครื่องปัจจุบันมี Commit ที่นำหน้า GitHub อยู่ ${behindBy ?? 0} รายการ กรุณาตรวจสอบก่อนดำเนินการ`
          : 'ประวัติ Commit บนเครื่องปัจจุบันไม่ตรงกับ GitHub (Diverged หรือ Commit ไม่อยู่ใน Branch หลัก) ระบบระงับการอัปเดตอัตโนมัติเพื่อความปลอดภัย';
    }

    const changelog = buildEvidenceBasedChangelog({
      status,
      installedVersion: local.packageVersion,
      installedTag: local.currentTag,
      releases,
      changelogMdText,
      commits,
    });

    const result: GitHubUpdateCheckResult = {
      repository: repoInfo,
      status,
      statusLabelThai,
      statusDescriptionThai,
      releaseAvailability,
      installed: {
        version: local.packageVersion,
        commitSha: local.currentCommit,
        shortCommitSha: local.currentShortCommit,
        tag: local.currentTag,
        branch: local.branch,
        gitAvailable: local.gitAvailable,
        workingTreeClean: local.workingTreeClean,
        dirtyFiles: local.dirtyFiles,
      },
      remote: {
        reachable: true,
        latestReleaseTag: latestRelease?.tagName || null,
        latestReleaseName: latestRelease?.name || null,
        latestReleasePublishedAt: latestRelease?.publishedAt || null,
        targetCommitSha,
        targetShortCommitSha,
        targetCommitDate,
        targetCommitMessage,
        aheadBy,
        behindBy,
        compareStatus,
        errorCode: null,
        errorMessage: null,
      },
      changelog,
      checkedAt,
    };

    cachedFullCheck = {
      result,
      expiresAt: now + SUMMARY_CACHE_TTL_MS,
    };

    return result;
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const isTimeout = /abort|timeout/i.test(rawMsg);
    const errMsg = isTimeout
      ? 'การเชื่อมต่อ GitHub หมดเวลา (Timeout เกิน 10 วินาที) กรุณาตรวจสอบอินเทอร์เน็ตหรือ Firewall ของเซิร์ฟเวอร์'
      : 'ไม่สามารถเชื่อมต่อ GitHub API ได้ในขณะนี้ กรุณาตรวจสอบการเชื่อมต่อเครือข่ายของเซิร์ฟเวอร์';

    return {
      repository: repoInfo,
      status: 'GITHUB_UNREACHABLE',
      statusLabelThai: 'ไม่สามารถตรวจสอบ GitHub ได้',
      statusDescriptionThai: errMsg,
      releaseAvailability: 'NONE',
      installed: {
        version: local.packageVersion,
        commitSha: local.currentCommit,
        shortCommitSha: local.currentShortCommit,
        tag: local.currentTag,
        branch: local.branch,
        gitAvailable: local.gitAvailable,
        workingTreeClean: local.workingTreeClean,
        dirtyFiles: local.dirtyFiles,
      },
      remote: {
        reachable: false,
        latestReleaseTag: null,
        latestReleaseName: null,
        latestReleasePublishedAt: null,
        targetCommitSha: 'unknown',
        targetShortCommitSha: 'unknown',
        targetCommitDate: null,
        targetCommitMessage: null,
        aheadBy: null,
        behindBy: null,
        compareStatus: 'unknown',
        errorCode: isTimeout ? 'GITHUB_TIMEOUT' : 'GITHUB_NETWORK_ERROR',
        errorMessage: errMsg,
      },
      changelog: buildEvidenceBasedChangelog({
        status: 'GITHUB_UNREACHABLE',
        installedVersion: local.packageVersion,
        installedTag: local.currentTag,
        releases: [],
        changelogMdText: null,
        commits: [],
      }),
      checkedAt,
    };
  }
}

export async function getGitHubUpdateSummaryReadOnly(options?: {
  forceRefresh?: boolean;
}): Promise<GitHubUpdateSummary> {
  const wasCached =
    !options?.forceRefresh && Boolean(cachedFullCheck && cachedFullCheck.expiresAt > Date.now());
  const full = await checkGitHubUpdateReadOnly({ forceRefresh: options?.forceRefresh });
  return {
    status: full.status,
    statusLabelThai: full.statusLabelThai,
    releaseAvailability: full.releaseAvailability,
    installedVersion: full.installed.version,
    installedCommit: full.installed.shortCommitSha,
    latestReleaseTag: full.remote.latestReleaseTag,
    targetCommit: full.remote.targetShortCommitSha,
    aheadBy: full.remote.aheadBy,
    hasUpdateAvailable: full.status === 'UPDATE_AVAILABLE',
    checkedAt: full.checkedAt,
    cached: wasCached,
    errorMessage: full.remote.errorMessage,
  };
}

/**
 * ประเมินความพร้อมระบบก่อนอนุญาตให้กดปุ่มอัปเดต (Readiness Checklist)
 */
export function evaluateDeploymentReadiness(params: {
  githubCheck: GitHubUpdateCheckResult;
  dbInspection: DetailedMigrationInspection;
  combinedPendingMigrations: string[];
  deploymentInProgress: boolean;
  cwd?: string;
}): DeploymentReadinessReport {
  const { githubCheck, dbInspection, combinedPendingMigrations, deploymentInProgress } = params;
  const cwd = params.cwd || process.cwd();
  const cfg = loadConfig();

  const platform = testProviders?.platformOverride || process.platform;
  const isWindows = platform === 'win32';
  const nodeVersion = testProviders?.nodeVersionOverride || process.version;
  const nodeMajor = parseInt(nodeVersion.replace(/^v/i, '').split('.')[0] || '0', 10);
  const nodeVersionOk = nodeMajor >= 22;

  const localBat = path.resolve(cwd, 'deployment', 'Deploy_Sam_Att.bat');
  const localPs1 = path.resolve(cwd, 'deployment', 'Deploy_Sam_Att.ps1');
  const winBat = 'C:\\inetpub\\wwwroot\\Sam_Att\\deployment\\Deploy_Sam_Att.bat';
  const scriptsExist =
    typeof testProviders?.scriptExistsOverride === 'boolean'
      ? testProviders.scriptExistsOverride
      : (fs.existsSync(localBat) && fs.existsSync(localPs1)) || fs.existsSync(winBat);

  const backupRoot = (process.env.SAM_ATT_BACKUP_DIR || 'C:\\SamAttBackups').trim();
  const backupInsideRepo =
    path.resolve(backupRoot).toLowerCase().startsWith(path.resolve(cwd).toLowerCase());

  const checks: ReadinessCheckItem[] = [];

  // 1. ADMIN Permission
  checks.push({
    id: 'ADMIN_PERMISSION',
    label: 'สิทธิ์ผู้ดูแลระบบ (ADMIN Role)',
    status: 'PASS',
    blocking: false,
    detail: 'ผ่านการยืนยันตัวตนในสิทธิ์ผู้ดูแลระบบ (ADMIN Only)',
  });

  // 2. GitHub Connectivity & Version Alignment
  if (githubCheck.status === 'GITHUB_UNREACHABLE') {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อ GitHub Repository',
      status: 'FAIL',
      blocking: true,
      detail: githubCheck.remote.errorMessage || 'ไม่สามารถเชื่อมต่อ GitHub ได้ในขณะนี้',
    });
  } else if (githubCheck.status === 'DIVERGED_OR_UNKNOWN') {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อ GitHub และประวัติ Commit',
      status: 'FAIL',
      blocking: true,
      detail: githubCheck.statusDescriptionThai,
    });
  } else {
    checks.push({
      id: 'GITHUB_CONNECTIVITY',
      label: 'การเชื่อมต่อ GitHub Repository',
      status: 'PASS',
      blocking: false,
      detail: `เชื่อมต่อ ${githubCheck.repository.fullName} (${githubCheck.repository.branch}) สำเร็จ`,
    });
  }

  // 3. Deployment Configuration & OS
  if (!scriptsExist) {
    checks.push({
      id: 'DEPLOYMENT_CONFIG',
      label: 'สคริปต์อัปเดตและค่าตั้งค่า Deployment',
      status: 'FAIL',
      blocking: true,
      detail: 'ไม่พบไฟล์ deployment/Deploy_Sam_Att.bat หรือ Deploy_Sam_Att.ps1',
    });
  } else if (!isWindows) {
    checks.push({
      id: 'DEPLOYMENT_CONFIG',
      label: 'สภาพแวดล้อมเซิร์ฟเวอร์ Windows Server',
      status: 'FAIL',
      blocking: true,
      detail: `ระบบกำลังรันบน ${platform} — การสั่งอัปเดตผ่านสคริปต์ Deploy_Sam_Att รองรับเฉพาะ Windows Server เท่านั้น`,
    });
  } else if (backupInsideRepo) {
    checks.push({
      id: 'DEPLOYMENT_CONFIG',
      label: 'โฟลเดอร์สำรองข้อมูลนอก Git Repository',
      status: 'FAIL',
      blocking: true,
      detail: `SAM_ATT_BACKUP_DIR (${backupRoot}) อยู่ภายในโฟลเดอร์ Git Repository ต้องย้ายออกนอก Repo`,
    });
  } else {
    checks.push({
      id: 'DEPLOYMENT_CONFIG',
      label: 'สคริปต์อัปเดตและสภาพแวดล้อม Windows Server',
      status: 'PASS',
      blocking: false,
      detail: `พบสคริปต์ Deployment ครบถ้วน และสำรองข้อมูลไว้ที่ ${backupRoot}`,
    });
  }

  // 4. Build Requirements & Working Tree
  const lockExists = fs.existsSync(path.join(cwd, 'package-lock.json'));
  if (!nodeVersionOk) {
    checks.push({
      id: 'BUILD_REQUIREMENTS',
      label: 'ความพร้อม Node.js, Dependencies และ Working Tree',
      status: 'FAIL',
      blocking: true,
      detail: `Node.js ปัจจุบันคือ ${nodeVersion} (ต้องใช้เวอร์ชัน >= v22.0.0)`,
    });
  } else if (!githubCheck.installed.workingTreeClean) {
    checks.push({
      id: 'BUILD_REQUIREMENTS',
      label: 'ความพร้อม Git Working Tree',
      status: 'FAIL',
      blocking: true,
      detail: `พบไฟล์ที่ถูกแก้ไขค้างไว้ในเครื่อง (${githubCheck.installed.dirtyFiles.slice(0, 3).join(', ')}) กรุณาตรวจสอบก่อนอัปเดต`,
    });
  } else if (!lockExists) {
    checks.push({
      id: 'BUILD_REQUIREMENTS',
      label: 'ความพร้อมไฟล์ Dependency Lockfile',
      status: 'WARN',
      blocking: false,
      detail: `Node.js ${nodeVersion} พร้อมใช้งาน แต่ไม่พบ package-lock.json ในโฟลเดอร์ระบบ`,
    });
  } else {
    checks.push({
      id: 'BUILD_REQUIREMENTS',
      label: 'ความพร้อม Node.js, Build และ Working Tree',
      status: 'PASS',
      blocking: false,
      detail: `Node.js ${nodeVersion} · package-lock.json พร้อมใช้งาน · Git Working Tree สะอาด`,
    });
  }

  // 5. Database Migrations & Checksums
  if (dbInspection.checksumMismatches.length > 0) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'สถานะ Database Migration และ Checksum',
      status: 'FAIL',
      blocking: true,
      detail: `พบไฟล์ Migration ที่เคยรันไปแล้วมีค่า Checksum ไม่ตรงกัน (${dbInspection.checksumMismatches.length} ไฟล์) ระบบระงับการอัปเดต`,
    });
  } else if (!dbInspection.schemaVerification.ok) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'ความถูกต้องของโครงสร้างฐานข้อมูล',
      status: 'FAIL',
      blocking: true,
      detail: `พบโครงสร้างฐานข้อมูลไม่ตรงตาม Schema (${dbInspection.schemaVerification.errors.slice(0, 2).join('; ')})`,
    });
  } else if (combinedPendingMigrations.length > 0) {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'สถานะ Database Migration',
      status: 'WARN',
      blocking: false,
      detail: `พบ Migration ใหม่ ${combinedPendingMigrations.length} ไฟล์ (${combinedPendingMigrations.join(', ')}) ต้องอนุมัติด้วยรหัสผ่าน ADMIN ก่อนรัน`,
    });
  } else {
    checks.push({
      id: 'DATABASE_MIGRATIONS',
      label: 'สถานะ Database Migration และ Schema',
      status: 'PASS',
      blocking: false,
      detail: `ติดตั้งครบ ${dbInspection.appliedMigrations.length} รุ่น · Checksum และ Schema ถูกต้อง`,
    });
  }

  // 6. Safety & Isolation
  checks.push({
    id: 'SAFETY_ISOLATION',
    label: 'การแยกอิสระจาก Procurement / HOSOffice',
    status: 'PASS',
    blocking: false,
    detail: `จำกัดเฉพาะ Sam_Att พอร์ต ${cfg.port} และฐานข้อมูล ${cfg.samAttDb.database} (ไม่แตะต้อง Procurement และไม่รัน iisreset)`,
  });

  const blockingReasons = checks.filter((c) => c.blocking).map((c) => c.detail);
  if (deploymentInProgress) {
    blockingReasons.unshift('กำลังมีการอัปเดตระบบทำงานอยู่ในขณะนี้ กรุณารอให้เสร็จสิ้นก่อน');
  }

  return {
    canExecuteUpdate: blockingReasons.length === 0,
    requiresMigrationApproval: combinedPendingMigrations.length > 0,
    blockingReasons,
    checks,
  };
}

/**
 * วิเคราะห์ผลลัพธ์ความล้มเหลวของสคริปต์ Deployment เพื่อแยกสาเหตุที่แท้จริง (แทน Exit Code: 1 แบบคลุมเครือ)
 */
export function diagnoseDeploymentFailure(params: {
  exitCode: number;
  stdout: string;
  stderr: string;
  requiresAdminDatabaseRestore: boolean;
  migrationApprovalRequired: boolean;
}): DeploymentErrorDiagnostics {
  const combined = `${params.stdout}\n${params.stderr}`;
  const rolledBack = /ROLLED BACK SAFELY TO PREVIOUS VERSION/i.test(combined);

  // Detect active step from PowerShell output markers: [N/7] <Label> FAIL or ERROR [<StepName>]:
  let failedStep = 'ไม่ระบุขั้นตอน (ตรวจสอบ Console Output ด้านล่าง)';
  const stepErrMatch = combined.match(/ERROR \[([^\]]+)\]:/i);
  const stepFailMatch = combined.match(/\[(\d)\/7\]\s+([A-Za-z0-9 /\-]+?)\s+FAIL/i);
  if (stepFailMatch) {
    failedStep = `ขั้นตอนที่ ${stepFailMatch[1]}/7: ${stepFailMatch[2].trim()}`;
  } else if (stepErrMatch) {
    failedStep = `ขั้นตอน: ${stepErrMatch[1].trim()}`;
  }

  const patterns: Array<{
    regex: RegExp;
    code: string;
    step?: string;
    cause: string;
    remediation: string[];
    httpStatus: number;
  }> = [
    {
      regex: /MIGRATION_APPROVAL_REQUIRED/i,
      code: 'MIGRATION_APPROVAL_REQUIRED',
      step: 'ขั้นตอนที่ 2/7: ตรวจสอบ GitHub และ Database Migration',
      cause: 'ตรวจพบไฟล์ Database Migration ที่รอการอนุมัติ ระบบไม่อนุญาตให้รัน Migration อัตโนมัติ',
      remediation: [
        'กดปุ่ม "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อดูรายการตารางและคอลัมน์ที่จะเปลี่ยนแปลง',
        'ตรวจสอบผลกระทบและยืนยันการอนุมัติ Migration ด้วยรหัสผ่านของบัญชี ADMIN',
      ],
      httpStatus: 409,
    },
    {
      regex: /MIGRATION_APPROVAL_MISMATCH/i,
      code: 'MIGRATION_APPROVAL_MISMATCH',
      step: 'ขั้นตอนที่ 2/7: ยืนยันความตรงกันของสิทธิ์อนุมัติ Migration',
      cause: 'รายการไฟล์ Migration หรือ Commit เป้าหมายที่อนุมัติไม่ตรงกับ Commit ล่าสุดบน GitHub (อาจมี Commit ใหม่ระหว่างดำเนินการ หรือพารามิเตอร์ไม่ตรงกัน)',
      remediation: [
        'กด "ตรวจสอบเวอร์ชันอีกครั้ง" เพื่อดึง Commit และรายการ Migration ล่าสุด',
        'ตรวจสอบรายละเอียดและกดอนุมัติ Migration ใหม่อีกครั้ง',
      ],
      httpStatus: 409,
    },
    {
      regex: /MIGRATION_CHECKSUM_MISMATCH/i,
      code: 'MIGRATION_CHECKSUM_MISMATCH',
      step: 'ขั้นตอนที่ 2/7: ตรวจสอบ Checksum ของ Migration เดิม',
      cause: 'ไฟล์ Migration ที่เคยติดตั้งในฐานข้อมูลแล้วถูกแก้ไข ทำให้ค่า SHA-256 Checksum ไม่ตรงกัน',
      remediation: [
        'ห้ามแก้ไขไฟล์ Migration เดิมที่เคยรันไปแล้ว ให้ตรวจสอบประวัติ Git และคืนค่าไฟล์เดิม',
        'หากต้องการปรับโครงสร้างฐานข้อมูล ให้สร้างไฟล์ Migration หมายเลขถัดไปแทน',
      ],
      httpStatus: 409,
    },
    {
      regex: /PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED|Run as administrator/i,
      code: 'PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED',
      step: 'ขั้นตอนที่ 1/7: ตรวจสอบสิทธิ์ผู้ดูแลเครื่อง Windows Server',
      cause: 'บัญชีที่ใช้รันเซอร์วิส Sam_Att ไม่มีสิทธิ์ Administrator ของ Windows ทำให้สคริปต์ไม่สามารถตรวจสอบ IIS หรือรีสตาร์ท Windows Service ได้',
      remediation: [
        'ตรวจสอบว่า Windows Service SamAttV2Standalone รันภายใต้บัญชี LocalSystem หรือบัญชีที่มีสิทธิ์ควบคุมเซอร์วิส',
        'หรือเข้า Remote Desktop ที่เครื่องเซิร์ฟเวอร์ แล้วคลิกขวาไฟล์ deployment\\Deploy_Sam_Att.bat เลือก "Run as administrator"',
      ],
      httpStatus: 422,
    },
    {
      regex: /PREFLIGHT_IIS_PERMISSION_DENIED/i,
      code: 'PREFLIGHT_IIS_PERMISSION_DENIED',
      step: 'ขั้นตอนที่ 1/7: ตรวจสอบการตั้งค่า IIS (Read-Only)',
      cause: 'ไม่มีสิทธิ์อ่านค่าตั้งค่า IIS ผ่าน appcmd.exe เพื่อตรวจสอบ Co-tenancy Guard',
      remediation: [
        'ให้รันเซอร์วิส Sam_Att ด้วยสิทธิ์ที่สามารถอ่านค่า IIS ได้ หรือรัน Deploy_Sam_Att.bat ด้วยสิทธิ์ Administrator บนเครื่องเซิร์ฟเวอร์',
      ],
      httpStatus: 422,
    },
    {
      regex: /PREFLIGHT_DIRTY_WORKING_TREE/i,
      code: 'PREFLIGHT_DIRTY_WORKING_TREE',
      step: 'ขั้นตอนที่ 1/7: ตรวจสอบความสะอาดของ Git Working Tree',
      cause: 'พบไฟล์โค้ดในเครื่องเซิร์ฟเวอร์ถูกแก้ไขค้างไว้ ระบบห้ามใช้ git reset --hard อัตโนมัติเพื่อป้องกันข้อมูลสูญหาย',
      remediation: [
        'เปิด PowerShell ในโฟลเดอร์ติดตั้งแล้วรันคำสั่ง git status และ git diff เพื่อตรวจสอบไฟล์ที่ถูกแก้ไข',
        'สำรองหรือยกเลิกการแก้ไขที่ไม่ต้องการให้เรียบร้อย แล้วจึงกดอัปเดตระบบอีกครั้ง',
      ],
      httpStatus: 422,
    },
    {
      regex: /PREFLIGHT_ENV_INCOMPLETE|PREFLIGHT_ENV_MISSING|PREFLIGHT_INVALID_DATA_MODE|PREFLIGHT_INVALID_DB_ENGINE/i,
      code: 'PREFLIGHT_ENV_INVALID',
      step: 'ขั้นตอนที่ 1/7: ตรวจสอบไฟล์ .env สำหรับ Production',
      cause: 'ไฟล์ .env บนเซิร์ฟเวอร์ไม่ครบถ้วน ยังมีค่า Placeholder (CHANGE_ME) หรือไม่ได้ตั้งเป็น REAL / mysql',
      remediation: [
        'ตรวจสอบไฟล์ .env ในโฟลเดอร์ติดตั้งให้ตั้งค่า SAM_ATT_DATA_MODE=REAL และ SAM_ATT_DB_ENGINE=mysql',
        'ตรวจสอบค่า SAM_ATT_DB_*, JWT_SECRET และ SCANNER_INGEST_SHARED_TOKEN ให้ครบถ้วนโดยไม่มีคำว่า CHANGE_ME',
      ],
      httpStatus: 422,
    },
    {
      regex: /PREFLIGHT_BACKUP_DIR_INSIDE_GIT|PREFLIGHT_BACKUP_DIR_UNWRITABLE/i,
      code: 'PREFLIGHT_BACKUP_DIR_INVALID',
      step: 'ขั้นตอนที่ 1/7: ตรวจสอบโฟลเดอร์สำรองข้อมูลนอก Git Repo',
      cause: 'โฟลเดอร์สำรองข้อมูล (SAM_ATT_BACKUP_DIR) อยู่ภายใน Git Repository หรือไม่มีสิทธิ์เขียนไฟล์',
      remediation: [
        'กำหนด SAM_ATT_BACKUP_DIR=C:\\SamAttBackups (หรือไดรฟ์อื่นนอกโฟลเดอร์ติดตั้ง) และตรวจสอบสิทธิ์เขียนของบัญชีเซอร์วิส',
      ],
      httpStatus: 422,
    },
    {
      regex: /PREFLIGHT_PORT_4101_FOREIGN_PROCESS/i,
      code: 'PREFLIGHT_PORT_4101_FOREIGN_PROCESS',
      step: 'ขั้นตอนที่ 1/7: ตรวจสอบความเป็นเจ้าของพอร์ต 4101',
      cause: 'พบโปรเซสอื่นที่ไม่ใช่ Sam_Att ใช้งานพอร์ต 4101 อยู่ ระบบไม่บังคับปิดโปรเซสที่ไม่รู้จักเพื่อความปลอดภัยของระบบร่วมเครื่อง',
      remediation: [
        'ตรวจสอบโปรเซสที่ถือพอร์ต 4101 ด้วยคำสั่ง Get-NetTCPConnection -LocalPort 4101 บนเซิร์ฟเวอร์ก่อนดำเนินการ',
      ],
      httpStatus: 422,
    },
    {
      regex: /BACKUP_FAILED_NO_MYSQLDUMP/i,
      code: 'BACKUP_FAILED_NO_MYSQLDUMP',
      step: 'ขั้นตอนที่ 3/7: สำรองฐานข้อมูล MySQL ก่อนอัปเดต',
      cause: 'ไม่พบโปรแกรม mysqldump.exe ใน PATH หรือโฟลเดอร์มาตรฐานของ MySQL/MariaDB ระบบยกเลิกก่อนดึงโค้ดเพื่อความปลอดภัย',
      remediation: [
        'ติดตั้ง MySQL Client / mysqldump หรือกำหนดพาธเต็มในไฟล์ .env เช่น MYSQLDUMP_PATH=C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
      ],
      httpStatus: 422,
    },
    {
      regex: /BACKUP_FAILED/i,
      code: 'BACKUP_FAILED',
      step: 'ขั้นตอนที่ 3/7: สำรองฐานข้อมูล MySQL ก่อนอัปเดต',
      cause: 'ไม่สามารถสร้างไฟล์สำรองฐานข้อมูล MySQL ที่สมบูรณ์ก่อนเริ่มอัปเดตได้ ระบบยกเลิกทันทีโดยยังไม่เปลี่ยนแปลงโค้ด',
      remediation: [
        'ตรวจสอบการเชื่อมต่อฐานข้อมูล MySQL สิทธิ์ของผู้ใช้ฐานข้อมูล และพื้นที่ดิสก์ในโฟลเดอร์สำรองข้อมูล',
      ],
      httpStatus: 422,
    },
    {
      regex: /GIT_FETCH_FAILED|GIT_PULL_FAILED/i,
      code: 'GIT_SYNC_FAILED',
      step: 'ขั้นตอนที่ 2–3/7: ดึงข้อมูลจาก GitHub',
      cause: 'ไม่สามารถดึงโค้ดจาก GitHub ได้ (เครือข่ายขัดข้อง สิทธิ์เข้าถึง Repository หรือไม่สามารถ fast-forward branch ได้)',
      remediation: [
        'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ต/Proxy จากเครื่องเซิร์ฟเวอร์ไปยัง github.com',
        'ตรวจสอบสถานะ git status และ git log บนเซิร์ฟเวอร์หาก branch มีการแยกสาย (diverged)',
      ],
      httpStatus: 422,
    },
    {
      regex: /NPM_INSTALL_FAILED/i,
      code: 'NPM_INSTALL_FAILED',
      step: 'ขั้นตอนที่ 4/7: ติดตั้ง Dependencies (npm ci / npm install)',
      cause: 'การติดตั้งแพ็กเกจ npm ล้มเหลว (อาจเกิดจากเครือข่าย npm registry หรือไฟล์ native module ถูกล็อกอยู่บน Windows)',
      remediation: [
        'ตรวจสอบการเชื่อมต่ออินเทอร์เน็ตไปยัง registry.npmjs.org และดูรายละเอียดใน Console Output',
        'ระบบได้ย้อนกลับไปยังโค้ดรุ่นเดิมแล้ว (หาก Rollback สำเร็จ)',
      ],
      httpStatus: 422,
    },
    {
      regex: /TYPECHECK_FAILED/i,
      code: 'TYPECHECK_FAILED',
      step: 'ขั้นตอนที่ 5/7: ตรวจสอบ TypeScript (npm run typecheck)',
      cause: 'พบข้อผิดพลาดด้าน TypeScript ในซอร์สโค้ดรุ่นเป้าหมาย ระบบหยุดก่อน Build และย้อนกลับรุ่นเดิมอัตโนมัติ',
      remediation: [
        'ตรวจสอบบรรทัดที่เกิดข้อผิดพลาดใน Console Output และแก้ไขใน Repository ก่อนปล่อยอัปเดตใหม่',
      ],
      httpStatus: 422,
    },
    {
      regex: /UNIT_TESTS_FAILED/i,
      code: 'UNIT_TESTS_FAILED',
      step: 'ขั้นตอนที่ 5/7: ทดสอบอัตโนมัติ (npm test)',
      cause: 'ชุดทดสอบอัตโนมัติไม่ผ่าน ระบบระงับการขึ้นรุ่นใหม่และย้อนกลับรุ่นเดิมอัตโนมัติเพื่อป้องกันปัญหาบนระบบจริง',
      remediation: [
        'ตรวจสอบชื่อเคสทดสอบที่ไม่ผ่านใน Console Output และแก้ไขในซอร์สโค้ดก่อนอัปเดตอีกครั้ง',
      ],
      httpStatus: 422,
    },
    {
      regex: /BUILD_FAILED|BUILD_ARTIFACT_MISSING|BUILD_ARTIFACT_EMPTY/i,
      code: 'BUILD_FAILED',
      step: 'ขั้นตอนที่ 5/7: Build ระบบฝั่ง Frontend (npm run build)',
      cause: 'ไม่สามารถสร้างไฟล์ dist/index.html สำหรับ Production ได้ ระบบย้อนกลับรุ่นเดิมอัตโนมัติ',
      remediation: [
        'ตรวจสอบข้อผิดพลาดของ Vite Build ใน Console Output และพื้นที่ว่างบนดิสก์',
      ],
      httpStatus: 422,
    },
    {
      regex: /MIGRATION_EXECUTION_FAILED|POST_MIGRATION_SCHEMA_VERIFICATION_FAILED|MANUAL_DB_RESTORE_REQUIRED/i,
      code: 'MANUAL_DB_RESTORE_REQUIRED',
      step: 'ขั้นตอนที่ 5/7: รัน Database Migration และตรวจโครงสร้าง Schema',
      cause: 'เกิดข้อผิดพลาดระหว่างหรือหลังรัน Database Migration ระบบย้อนเฉพาะซอร์สโค้ดและห้ามลดระดับ Schema อัตโนมัติ',
      remediation: [
        'ตรวจสอบสถานะตารางในฐานข้อมูล samchuk_attendance_v2 ด้วยตนเอง',
        'หากโครงสร้างฐานข้อมูลไม่เข้ากับโค้ดรุ่นเดิม ให้กู้คืนจากไฟล์สำรอง MySQL นอก Git Repo ผ่าน scripts\\restore-test.ps1',
      ],
      httpStatus: 422,
    },
    {
      regex: /BACKEND_.*FAILED|BACKEND_SERVICE_NOT_RUNNING|BACKEND_PROCESS_EXITED/i,
      code: 'BACKEND_RESTART_FAILED',
      step: 'ขั้นตอนที่ 6/7: รีสตาร์ทบริการ Sam_Att บนพอร์ต 4101',
      cause: 'ไม่สามารถรีสตาร์ทเซอร์วิสหรือโปรเซสของ Sam_Att ได้หลัง Build เสร็จสิ้น',
      remediation: [
        'ตรวจสอบสถานะ Windows Service SamAttV2Standalone และไฟล์ log ในโฟลเดอร์ logs/ ของระบบ',
      ],
      httpStatus: 422,
    },
    {
      regex: /HEALTH_CHECK_FAILED|HTTPS_PROBE_FAILED|MYSQL_DISCONNECTED/i,
      code: 'HEALTH_CHECK_FAILED',
      step: 'ขั้นตอนที่ 7/7: ตรวจสอบ Health Check หลังอัปเดต',
      cause: 'หลังรีสตาร์ทระบบแล้ว ไม่สามารถเชื่อมต่อ https://127.0.0.1:4101/api/Sam_Att/health หรือฐานข้อมูล MySQL ไม่ตอบสนอง',
      remediation: [
        'ตรวจสอบใบรับรอง TLS, สถานะฐานข้อมูล MySQL และไฟล์ log ในโฟลเดอร์ logs/',
      ],
      httpStatus: 422,
    },
  ];

  for (const p of patterns) {
    if (p.regex.test(combined)) {
      return {
        failedStep: p.step || failedStep,
        errorCode: p.code,
        detectedCause: p.cause,
        remediationSteps: p.remediation,
        exitCode: params.exitCode,
        rolledBack,
        requiresAdminDatabaseRestore:
          params.requiresAdminDatabaseRestore || p.code === 'MANUAL_DB_RESTORE_REQUIRED',
        httpStatus: p.httpStatus,
      };
    }
  }

  return {
    failedStep,
    errorCode: params.requiresAdminDatabaseRestore
      ? 'MANUAL_DB_RESTORE_REQUIRED'
      : params.migrationApprovalRequired
        ? 'MIGRATION_APPROVAL_REQUIRED'
        : 'DEPLOYMENT_EXECUTION_FAILED',
    detectedCause: params.requiresAdminDatabaseRestore
      ? `การอัปเดตล้มเหลวหลังเริ่มรัน Migration (Exit Code: ${params.exitCode}) ระบบได้ย้อนซอร์สโค้ดแล้ว แต่ต้องให้ผู้ดูแลระบบตรวจสอบฐานข้อมูล`
      : `สคริปต์อัปเดตสิ้นสุดด้วย Exit Code: ${params.exitCode} กรุณาตรวจสอบข้อความใน Console Output ด้านล่างเพื่อดูสาเหตุละเอียด`,
    remediationSteps: [
      'ตรวจสอบข้อความ ERROR บรรทัดล่าสุดใน Console Output ด้านล่าง',
      'ตรวจสอบไฟล์บันทึกการทำงานในโฟลเดอร์ logs/deploy_sam_att_*.log บนเครื่องเซิร์ฟเวอร์',
    ],
    exitCode: params.exitCode,
    rolledBack,
    requiresAdminDatabaseRestore: params.requiresAdminDatabaseRestore,
    httpStatus: params.migrationApprovalRequired ? 409 : 422,
  };
}
