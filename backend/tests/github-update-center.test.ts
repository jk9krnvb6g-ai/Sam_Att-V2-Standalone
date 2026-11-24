/**
 * ============================================================================
 * ชุดทดสอบอัตโนมัติ: GitHub Update Center, Thai Changelog & Deployment Diagnostics
 * ไฟล์: backend/tests/github-update-center.test.ts
 * ============================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const TEST_RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `sam_att_gh_update_${TEST_RUN_ID}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.SAM_ATT_TEST_ISOLATION = 'true';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'test_github_update_center_secret_0123456789abcdef0123456789abcdef';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'test_github_update_center_scanner_token_24';

import {
  resetSqliteInstanceForTests,
  ensureBaselineSystemCatalog,
  inspectMigrationsDetailedReadOnly,
  runMigrations,
  seedDemoSyntheticData,
} from '../src/database/adapter.ts';
import { createExpressApp } from '../src/app.ts';
import {
  setDeployBatRunnerForTests,
  setDeploymentGitInspectorForTests,
} from '../src/modules/settings/routes.ts';
import {
  checkGitHubUpdateReadOnly,
  diagnoseDeploymentFailure,
  evaluateDeploymentReadiness,
  sanitizeDeploymentSecrets,
  setGitHubUpdateProvidersForTests,
  type LocalInstalledState,
} from '../src/modules/deployment/github-update.ts';

let server: Server;
let baseUrl = '';
let adminToken = '';
let staffToken = '';
let userToken = '';

const CLEAN_LOCAL_STATE: LocalInstalledState = {
  packageVersion: '2.0.0',
  gitAvailable: true,
  branch: 'main',
  currentCommit: '1111111111111111111111111111111111111111',
  currentShortCommit: '11111111',
  currentTag: 'v2.0.0',
  workingTreeClean: true,
  dirtyFiles: [],
  warning: null,
};

async function apiJson(
  urlPath: string,
  options: { method?: string; token?: string; body?: unknown } = {}
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const resp = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await resp.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  return { status: resp.status, data };
}

test.before(async () => {
  resetSqliteInstanceForTests(TEST_DB_PATH);
  await runMigrations();
  await ensureBaselineSystemCatalog();
  await seedDemoSyntheticData();
  const app = createExpressApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}/api/Sam_Att`;
      resolve();
    });
  });

  const adminLogin = await apiJson('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'Admin@SamAtt2026' },
  });
  assert.equal(adminLogin.status, 200);
  adminToken = adminLogin.data.token;

  const staffLogin = await apiJson('/auth/login', {
    method: 'POST',
    body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
  });
  assert.equal(staffLogin.status, 200);
  staffToken = staffLogin.data.token;

  const userLogin = await apiJson('/auth/login', {
    method: 'POST',
    body: { username: 'user1003', password: 'User@SamAtt2026' },
  });
  assert.equal(userLogin.status, 200);
  userToken = userLogin.data.token;
});

test.after(async () => {
  setGitHubUpdateProvidersForTests(null);
  setDeployBatRunnerForTests(null);
  setDeploymentGitInspectorForTests(null);
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  resetSqliteInstanceForTests();
  try {
    if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  } catch {
    // ignore cleanup error
  }
});

test.afterEach(() => {
  setGitHubUpdateProvidersForTests(null);
  setDeployBatRunnerForTests(null);
  setDeploymentGitInspectorForTests(null);
});

test('1. Version Check: UP_TO_DATE when installed commit matches GitHub HEAD', async () => {
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return {
          ok: true,
          status: 200,
          json: {
            sha: CLEAN_LOCAL_STATE.currentCommit,
            commit: { message: 'chore: release v2.0.0', author: { date: '2026-11-20T08:00:00Z' } },
          },
        };
      }
      if (url.includes('/releases')) {
        return {
          ok: true,
          status: 200,
          json: [
            {
              tag_name: 'v2.0.0',
              name: 'v2.0.0',
              published_at: '2026-11-20T08:00:00Z',
              html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.0.0',
              body: '- Initial standalone release',
              draft: false,
              prerelease: false,
            },
          ],
        };
      }
      return { ok: false, status: 404 };
    },
  });

  const res = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  assert.equal(res.status, 'UP_TO_DATE');
  assert.equal(res.releaseAvailability, 'NONE');
  assert.equal(res.remote.compareStatus, 'identical');
  assert.equal(res.changelog.sourceType, 'NONE');
  assert.equal(res.changelog.totalChangesCount, 0);
});

test('2. Version Check: UPDATE_AVAILABLE with cumulative multi-version GitHub Releases (6 Thai categories)', async () => {
  const targetSha = '3333333333333333333333333333333333333333';
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return {
          ok: true,
          status: 200,
          json: {
            sha: targetSha,
            commit: { message: 'feat: release v2.2.0', author: { date: '2026-11-23T09:00:00Z' } },
          },
        };
      }
      if (url.includes('/releases')) {
        return {
          ok: true,
          status: 200,
          json: [
            {
              tag_name: 'v2.2.0',
              name: 'Sam_Att v2.2.0',
              published_at: '2026-11-23T09:00:00Z',
              html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.2.0',
              body: [
                '## Added',
                '- เพิ่มศูนย์อัปเดต GitHub Update Center พร้อมแจ้งเตือนผู้ดูแลระบบ',
                '## Security',
                '- ปรับปรุงการปกปิดรหัสผ่านและ Token ใน Deployment Log',
                '## Breaking Changes',
                '- ต้องอัปเดตตัวแปร GITHUB_PRODUCTION_BRANCH หากใช้ branch อื่น',
              ].join('\n'),
              draft: false,
              prerelease: false,
            },
            {
              tag_name: 'v2.1.0',
              name: 'Sam_Att v2.1.0',
              published_at: '2026-11-22T09:00:00Z',
              html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.1.0',
              body: [
                '## Fixed',
                '- แก้ไขปัญหา HTTP 422 และ Exit Code 1 จากพารามิเตอร์ Windows',
                '## Database',
                '- เพิ่ม Migration 005 สำหรับ Default Shift ตามประเภทบุคลากร',
                '## Improved',
                '- ปรับปรุงหน้าตารางเวรและ Modal ให้ใช้งานง่ายขึ้น',
              ].join('\n'),
              draft: false,
              prerelease: false,
            },
            {
              tag_name: 'v2.0.0',
              name: 'Sam_Att v2.0.0',
              published_at: '2026-11-20T08:00:00Z',
              body: '- Baseline release',
              draft: false,
              prerelease: false,
            },
          ],
        };
      }
      if (url.includes('/compare/')) {
        return {
          ok: true,
          status: 200,
          json: {
            status: 'ahead',
            ahead_by: 4,
            behind_by: 0,
            commits: [
              {
                sha: '2222222222222222222222222222222222222222',
                commit: { message: 'fix: deploy script exit code 1', author: { name: 'Dev', date: '2026-11-22T08:00:00Z' } },
              },
              {
                sha: targetSha,
                commit: { message: 'feat: github update center', author: { name: 'Dev', date: '2026-11-23T08:00:00Z' } },
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    },
  });

  const res = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  assert.equal(res.status, 'UPDATE_AVAILABLE');
  assert.equal(res.releaseAvailability, 'OFFICIAL_RELEASE');
  assert.equal(res.remote.latestReleaseTag, 'v2.2.0');
  assert.equal(res.changelog.sourceType, 'GITHUB_RELEASE');
  assert.equal(res.changelog.hasOfficialReleaseNotes, true);
  assert.equal(res.changelog.releasesIncluded.length, 2);

  const catKeys = res.changelog.categories.map((c) => c.key);
  assert.ok(catKeys.includes('features'));
  assert.ok(catKeys.includes('fixes'));
  assert.ok(catKeys.includes('improvements'));
  assert.ok(catKeys.includes('security'));
  assert.ok(catKeys.includes('database'));
  assert.ok(catKeys.includes('breaking'));
});

test('3. Version Check: UPDATE_AVAILABLE via Commits without Official Release shows honest fallback notice', async () => {
  const targetSha = '4444444444444444444444444444444444444444';
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return {
          ok: true,
          status: 200,
          json: { sha: targetSha, commit: { message: 'fix: handle comma in ApprovedMigrations' } },
        };
      }
      if (url.includes('/releases')) {
        return { ok: true, status: 200, json: [] };
      }
      if (url.includes('/contents/CHANGELOG.md')) {
        return { ok: false, status: 404 };
      }
      if (url.includes('/compare/')) {
        return {
          ok: true,
          status: 200,
          json: {
            status: 'ahead',
            ahead_by: 2,
            behind_by: 0,
            commits: [
              {
                sha: '44444444aaaa4444444444444444444444444444',
                commit: {
                  message: 'fix: handle comma splitting in Deploy_Sam_Att.ps1',
                  author: { name: 'AdminDev', date: '2026-11-23T10:00:00Z' },
                },
              },
              {
                sha: targetSha,
                commit: {
                  message: 'feat: add readiness checklist for Windows Server',
                  author: { name: 'AdminDev', date: '2026-11-23T11:00:00Z' },
                },
              },
            ],
          },
        };
      }
      return { ok: false, status: 404 };
    },
  });

  const res = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  assert.equal(res.status, 'UPDATE_AVAILABLE');
  assert.equal(res.releaseAvailability, 'COMMITS_WITHOUT_RELEASE');
  assert.equal(res.changelog.sourceType, 'COMMIT_HISTORY');
  assert.equal(res.changelog.hasOfficialReleaseNotes, false);
  assert.equal(res.changelog.isAutoSummarizedThai, true);
  assert.ok(res.changelog.transparencyNotice && res.changelog.transparencyNotice.includes('Official Release Notes'));
  assert.equal(res.changelog.commits.length, 2);
});

test('4. Changelog Priority 2: CHANGELOG.md is used when GitHub Releases are empty', async () => {
  const targetSha = '5555555555555555555555555555555555555555';
  const mdContent = [
    '# Changelog',
    '## [2.1.0] - 2026-11-23',
    '### Fixed',
    '- แก้ไขข้อผิดพลาดการตรวจสอบพารามิเตอร์สคริปต์อัปเดต',
    '### Added',
    '- เพิ่มประวัติและตัวกรองการอัปเดตระบบ',
    '## [2.0.0] - 2026-11-01',
    '- Initial version',
  ].join('\n');

  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return { ok: true, status: 200, json: { sha: targetSha, commit: { message: 'docs: changelog' } } };
      }
      if (url.includes('/releases')) {
        return { ok: true, status: 200, json: [] };
      }
      if (url.includes('/contents/CHANGELOG.md')) {
        return {
          ok: true,
          status: 200,
          json: { encoding: 'base64', content: Buffer.from(mdContent, 'utf8').toString('base64') },
        };
      }
      if (url.includes('/compare/')) {
        return { ok: true, status: 200, json: { status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] } };
      }
      return { ok: false, status: 404 };
    },
  });

  const res = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  assert.equal(res.status, 'UPDATE_AVAILABLE');
  assert.equal(res.changelog.sourceType, 'CHANGELOG_MD');
  assert.equal(res.changelog.hasOfficialReleaseNotes, true);
  assert.equal(res.changelog.totalChangesCount, 2);
});

test('5. Version Check: DIVERGED_OR_UNKNOWN blocks automated update in readiness report', async () => {
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    platformOverride: 'win32',
    scriptExistsOverride: true,
    nodeVersionOverride: 'v22.14.0',
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return {
          ok: true,
          status: 200,
          json: { sha: '9999999999999999999999999999999999999999', commit: { message: 'diverged' } },
        };
      }
      if (url.includes('/compare/')) {
        return { ok: true, status: 200, json: { status: 'diverged', ahead_by: 3, behind_by: 2, commits: [] } };
      }
      return { ok: false, status: 404 };
    },
  });

  const gh = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  assert.equal(gh.status, 'DIVERGED_OR_UNKNOWN');

  const dbInspection = await inspectMigrationsDetailedReadOnly();
  const readiness = evaluateDeploymentReadiness({
    githubCheck: gh,
    dbInspection,
    combinedPendingMigrations: [],
    deploymentInProgress: false,
  });
  assert.equal(readiness.canExecuteUpdate, false);
  assert.ok(readiness.blockingReasons.length >= 1);
});

test('6. Version Check: GITHUB_UNREACHABLE handles network/rate-limit failure cleanly without fabricating version', async () => {
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    platformOverride: 'win32',
    scriptExistsOverride: true,
    nodeVersionOverride: 'v22.14.0',
    fetchGitHub: async () => ({ ok: false, status: 403, json: { message: 'API rate limit exceeded' } }),
  });

  const gh = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  assert.equal(gh.status, 'GITHUB_UNREACHABLE');
  assert.equal(gh.remote.reachable, false);
  assert.equal(gh.remote.errorCode, 'GITHUB_RATE_LIMITED');
  assert.equal(gh.remote.targetCommitSha, 'unknown');

  const dbInspection = await inspectMigrationsDetailedReadOnly();
  const readiness = evaluateDeploymentReadiness({
    githubCheck: gh,
    dbInspection,
    combinedPendingMigrations: [],
    deploymentInProgress: false,
  });
  assert.equal(readiness.canExecuteUpdate, false);
});

test('7. RBAC: ADMIN allowed on Update Center APIs, while RESPONSIBLE_STAFF and GENERAL_USER receive 403', async () => {
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return { ok: true, status: 200, json: { sha: CLEAN_LOCAL_STATE.currentCommit, commit: { message: 'ok' } } };
      }
      return { ok: true, status: 200, json: [] };
    },
  });

  // Unauthenticated
  const unauth = await apiJson('/deployment/update-summary');
  assert.equal(unauth.status, 401);

  // Non-ADMIN roles strictly forbidden
  for (const token of [staffToken, userToken]) {
    const sumRes = await apiJson('/deployment/update-summary', { token });
    assert.equal(sumRes.status, 403);
    const chkRes = await apiJson('/deployment/check-updates', { method: 'POST', token });
    assert.equal(chkRes.status, 403);
    const runRes = await apiJson('/deployment/run-bat', {
      method: 'POST',
      token,
      body: { confirmRun: true },
    });
    assert.equal(runRes.status, 403);
  }

  // ADMIN succeeds
  const adminSummary = await apiJson('/deployment/update-summary?refresh=true', { token: adminToken });
  assert.equal(adminSummary.status, 200);
  assert.equal(adminSummary.data.status, 'UP_TO_DATE');
  assert.equal(adminSummary.data.hasUpdateAvailable, false);

  const adminCheck = await apiJson('/deployment/check-updates', { method: 'POST', token: adminToken });
  assert.equal(adminCheck.status, 200);
  assert.equal(adminCheck.data.versionStatus, 'UP_TO_DATE');
  assert.ok(Array.isArray(adminCheck.data.readiness.checks));
});

test('8. Deployment Diagnostics & Secret Redaction: HTTP 422 + Exit Code 1 classifies root cause and masks all secrets', async () => {
  setDeploymentGitInspectorForTests(async () => ({
    available: true,
    branch: 'main',
    currentCommit: 'aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111',
    targetCommit: 'bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222',
    hasUpdates: true,
    gitMigrationFiles: [],
    warning: null,
  }));

  const leakedRaw = [
    '[1/7] Preflight Check        FAIL',
    'ERROR [Preflight Check]: PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED: Administrator privileges required.',
    'MYSQL_PWD=SuperSecretHospitalPwd999',
    'Authorization: Bearer ghp_1234567890abcdef1234567890abcdef1234',
    'Connection: mysql://sam_att_app:DbPassSecret777@10.1.0.201:3306/samchuk_attendance_v2',
  ].join('\n');

  setDeployBatRunnerForTests(async (scriptPath) => ({
    exitCode: 1,
    stdout: leakedRaw,
    stderr: '',
    scriptPath,
    durationMs: 120,
  }));

  const res = await apiJson('/deployment/run-bat', {
    method: 'POST',
    token: adminToken,
    body: { confirmRun: true },
  });

  assert.equal(res.status, 422);
  assert.equal(res.data.exitCode, 1);
  assert.equal(res.data.error, 'PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED');
  assert.equal(res.data.diagnostics.errorCode, 'PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED');
  assert.ok(res.data.diagnostics.failedStep.includes('1/7'));
  assert.ok(Array.isArray(res.data.diagnostics.remediationSteps));
  assert.ok(res.data.diagnostics.remediationSteps.length >= 1);

  const serialized = JSON.stringify(res.data);
  assert.ok(!serialized.includes('SuperSecretHospitalPwd999'));
  assert.ok(!serialized.includes('ghp_1234567890abcdef1234567890abcdef1234'));
  assert.ok(!serialized.includes('DbPassSecret777'));
  assert.ok(serialized.includes('***REDACTED***'));

  // Verify direct sanitizer covers GitHub fine-grained PAT & bearer tokens too
  const masked = sanitizeDeploymentSecrets(
    'GITHUB_TOKEN=github_pat_11AAAAAA_BBBBBBBBBBBBBBBBBBBBBB Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'
  );
  assert.ok(!masked.includes('github_pat_'));
  assert.ok(!masked.includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('9. Rollback Separation Diagnostics & PowerShell 7-bit ASCII Integrity Guard', () => {
  const preMigFail = diagnoseDeploymentFailure({
    exitCode: 1,
    stdout:
      '[5/7] Typecheck/Test/Build   FAIL\nERROR [Typecheck/Test/Build]: BUILD_FAILED: vite build error\nDEPLOYMENT FAILED - ROLLED BACK SAFELY TO PREVIOUS VERSION',
    stderr: '',
    requiresAdminDatabaseRestore: false,
    migrationApprovalRequired: false,
  });
  assert.equal(preMigFail.errorCode, 'BUILD_FAILED');
  assert.equal(preMigFail.rolledBack, true);
  assert.equal(preMigFail.requiresAdminDatabaseRestore, false);

  const postMigFail = diagnoseDeploymentFailure({
    exitCode: 2,
    stdout:
      '[5/7] Typecheck/Test/Build   FAIL\nERROR [Typecheck/Test/Build]: MIGRATION_EXECUTION_FAILED\nMANUAL_DB_RESTORE_REQUIRED',
    stderr: '',
    requiresAdminDatabaseRestore: true,
    migrationApprovalRequired: false,
  });
  assert.equal(postMigFail.errorCode, 'MANUAL_DB_RESTORE_REQUIRED');
  assert.equal(postMigFail.requiresAdminDatabaseRestore, true);

  // Guard: Deploy_Sam_Att.ps1 must stay 100% 7-bit ASCII for Windows PowerShell 5.1 compatibility
  const ps1Path = path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.ps1');
  const ps1Text = fs.readFileSync(ps1Path, 'utf8');
  assert.ok(/^[\x00-\x7F]*$/.test(ps1Text), 'Deploy_Sam_Att.ps1 must be pure 7-bit ASCII');
});

test('10. Readiness Checklist: Clean Windows environment passes; dirty working tree blocks update', async () => {
  const dbInspection = await inspectMigrationsDetailedReadOnly();

  // Case A: Clean Windows Server + reachable GitHub -> ready
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => CLEAN_LOCAL_STATE,
    platformOverride: 'win32',
    scriptExistsOverride: true,
    nodeVersionOverride: 'v22.14.0',
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return { ok: true, status: 200, json: { sha: '6666666666666666666666666666666666666666', commit: { message: 'feat: ready' } } };
      }
      if (url.includes('/compare/')) {
        return { ok: true, status: 200, json: { status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] } };
      }
      return { ok: true, status: 200, json: [] };
    },
  });
  const ghReady = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  const readinessPass = evaluateDeploymentReadiness({
    githubCheck: ghReady,
    dbInspection,
    combinedPendingMigrations: [],
    deploymentInProgress: false,
  });
  assert.equal(readinessPass.canExecuteUpdate, true);
  assert.equal(readinessPass.blockingReasons.length, 0);

  // Case B: Dirty working tree -> blocked
  setGitHubUpdateProvidersForTests({
    readLocalState: async () => ({
      ...CLEAN_LOCAL_STATE,
      workingTreeClean: false,
      dirtyFiles: ['M server.ts'],
    }),
    platformOverride: 'win32',
    scriptExistsOverride: true,
    nodeVersionOverride: 'v22.14.0',
    fetchGitHub: async (url) => {
      if (url.includes('/commits/main')) {
        return { ok: true, status: 200, json: { sha: '6666666666666666666666666666666666666666', commit: { message: 'feat: ready' } } };
      }
      if (url.includes('/compare/')) {
        return { ok: true, status: 200, json: { status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] } };
      }
      return { ok: true, status: 200, json: [] };
    },
  });
  const ghDirty = await checkGitHubUpdateReadOnly({ forceRefresh: true });
  const readinessDirty = evaluateDeploymentReadiness({
    githubCheck: ghDirty,
    dbInspection,
    combinedPendingMigrations: [],
    deploymentInProgress: false,
  });
  assert.equal(readinessDirty.canExecuteUpdate, false);
  assert.ok(readinessDirty.blockingReasons.some((r) => r.includes('server.ts')));
});
