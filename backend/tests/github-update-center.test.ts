/**
 * ============================================================================
 * ชุดทดสอบศูนย์อัปเดตระบบจาก GitHub และการวินิจฉัยข้อผิดพลาด Deployment
 * (GitHub Update Center, Thai Changelog, RBAC & HTTP 422 / Exit Code 1 Diagnostics)
 * ไฟล์: backend/tests/github-update-center.test.ts
 * ============================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TEST_RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `sam_att_gh_update_${TEST_RUN_ID}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_TEST_ISOLATION = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'gh_update_test_jwt_secret_key_min_32_chars_2026';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'gh_update_test_scanner_token_min_24_chars';

import {
  resetSqliteInstanceForTests,
  dbQuery,
  ensureBaselineSystemCatalog,
  runMigrations,
  seedDemoSyntheticData,
} from '../src/database/adapter.ts';
import { createExpressApp } from '../src/app.ts';
import {
  setDeployBatRunnerForTests,
  setDeploymentGitInspectorForTests,
} from '../src/modules/settings/routes.ts';
import {
  setGitHubFetcherForTests,
  clearGitHubUpdateCacheForTests,
  sanitizeDeploymentLog,
  diagnoseDeploymentFailure,
  type GitHubHttpResponse,
} from '../src/modules/deployment/githubUpdateCenter.ts';

let serverUrl = '';
let closeServer: () => Promise<void> = async () => {};
let adminToken = '';
let staffToken = '';
let generalToken = '';

async function apiCall(
  endpoint: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${serverUrl}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

test('GitHub Update Center, Thai Changelog, RBAC & 422 Diagnostics Suite', async (t) => {
  resetSqliteInstanceForTests(TEST_DB_PATH);
  await runMigrations();
  await ensureBaselineSystemCatalog();
  await seedDemoSyntheticData();

  const app = createExpressApp();
  const srv = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${addr.port}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      if (typeof (srv as any).closeAllConnections === 'function') {
        (srv as any).closeAllConnections();
      }
      srv.close(() => resolve());
    });

  try {
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminLogin.status, 200);
    adminToken = adminLogin.data.token;

    const staffLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(staffLogin.status, 200);
    staffToken = staffLogin.data.token;

    const userLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(userLogin.status, 200);
    generalToken = userLogin.data.token;

    // -----------------------------------------------------------------------
    // 1. UP_TO_DATE Scenario
    // -----------------------------------------------------------------------
    await t.test('1. UP_TO_DATE when installed commit matches GitHub branch HEAD', async () => {
      const sha = '1111222233334444555566667777888899990000';
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: {
              sha,
              commit: {
                message: 'chore: release v2.0.0',
                author: { name: 'Samchuk Dev', date: '2026-11-20T08:00:00Z' },
              },
            },
          };
        }
        if (url.includes('/releases')) {
          return {
            status: 200,
            ok: true,
            json: [
              {
                tag_name: 'v2.0.0',
                name: 'v2.0.0',
                published_at: '2026-11-20T08:00:00Z',
                target_commitish: 'main',
                draft: false,
                prerelease: false,
                html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.0.0',
                body: '- Initial release',
              },
            ],
          };
        }
        return { status: 404, ok: false, json: { message: 'Not Found' } };
      });

      try {
        const res = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'UP_TO_DATE');
        assert.equal(res.data.hasUpdates, false);
        assert.equal(res.data.githubReachable, true);
        assert.equal(res.data.commitsBehind, 0);
        assert.equal(res.data.changelog.sourceType, 'NONE');
        assert.ok(res.data.checkedAt);
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -----------------------------------------------------------------------
    // 2. UPDATE_AVAILABLE with Official Multi-Version GitHub Releases + Thai Categorization
    // -----------------------------------------------------------------------
    await t.test('2. UPDATE_AVAILABLE aggregates multi-version GitHub Releases into 6 Thai changelog categories', async () => {
      const oldSha = '1111222233334444555566667777888899990001';
      const newSha = 'aaaa222233334444555566667777888899990002';
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: oldSha,
        targetCommit: newSha,
        hasUpdates: true,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: {
              sha: newSha,
              commit: {
                message: 'feat: release v2.2.0',
                author: { name: 'Samchuk Dev', date: '2026-11-24T09:00:00Z' },
              },
            },
          };
        }
        if (url.includes('/releases')) {
          return {
            status: 200,
            ok: true,
            json: [
              {
                tag_name: 'v2.2.0',
                name: 'v2.2.0 GitHub Update Center',
                published_at: '2026-11-24T09:00:00Z',
                target_commitish: 'main',
                draft: false,
                prerelease: false,
                html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.2.0',
                body: [
                  '### ฟีเจอร์ใหม่',
                  '- เพิ่มหน้าศูนย์อัปเดตระบบจาก GitHub พร้อมแจ้งเตือนเฉพาะ ADMIN',
                  '### แก้ไขข้อผิดพลาด',
                  '- fix: resolve HTTP 422 and Exit Code 1 when bun.lock was removed during build',
                  '### ความปลอดภัย',
                  '- security: mask GitHub tokens and MySQL URIs in deployment logs',
                ].join('\n'),
              },
              {
                tag_name: 'v2.1.0',
                name: 'v2.1.0 Shift Rules',
                published_at: '2026-11-22T09:00:00Z',
                target_commitish: 'main',
                draft: false,
                prerelease: false,
                html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.1.0',
                body: [
                  '- database: add personnel_type_rules default shift column',
                  '- BREAKING: remove legacy default shift checkbox from shift template modal',
                ].join('\n'),
              },
              {
                tag_name: 'v2.0.0',
                name: 'v2.0.0',
                published_at: '2026-11-20T09:00:00Z',
                target_commitish: 'main',
                draft: false,
                prerelease: false,
                html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/releases/tag/v2.0.0',
                body: '- Initial baseline',
              },
            ],
          };
        }
        if (url.includes(`/compare/${oldSha}...${newSha}`)) {
          return {
            status: 200,
            ok: true,
            json: {
              status: 'ahead',
              ahead_by: 4,
              behind_by: 0,
              commits: [{ sha: newSha, commit: { message: 'feat: release v2.2.0' } }],
              files: [],
            },
          };
        }
        return { status: 404, ok: false, json: { message: 'Not Found' } };
      });

      try {
        const res = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'UPDATE_AVAILABLE');
        assert.equal(res.data.hasUpdates, true);
        assert.equal(res.data.latestVersion, 'v2.2.0');
        assert.equal(res.data.commitsBehind, 4);
        assert.equal(res.data.changelog.sourceType, 'GITHUB_RELEASES');
        assert.equal(res.data.changelog.hasOfficialReleaseNotes, true);
        assert.equal(res.data.changelog.isMultiVersionJump, true);
        assert.ok(res.data.changelog.categories.features.length >= 1);
        assert.ok(res.data.changelog.categories.fixes.length >= 1);
        assert.ok(res.data.changelog.categories.security.length >= 1);
        assert.ok(res.data.changelog.categories.database.length >= 1);
        assert.ok(res.data.changelog.categories.breaking.length >= 1);

        // Notification endpoint for ADMIN reports hasUpdate=true
        const notifRes = await apiCall('/api/Sam_Att/deployment/update-notification?force=1', {
          token: adminToken,
        });
        assert.equal(notifRes.status, 200);
        assert.equal(notifRes.data.hasUpdate, true);
        assert.equal(notifRes.data.latestVersion, 'v2.2.0');
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -----------------------------------------------------------------------
    // 3. COMMIT_AHEAD_NO_RELEASE + Commit History Fallback + Migration Detection
    // -----------------------------------------------------------------------
    await t.test('3. COMMIT_AHEAD_NO_RELEASE uses Commit History when no Release/CHANGELOG exists and detects SQL migrations', async () => {
      const oldSha = '2222222233334444555566667777888899990001';
      const newSha = 'bbbb222233334444555566667777888899990002';
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: oldSha,
        targetCommit: newSha,
        hasUpdates: true,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: {
              sha: newSha,
              commit: {
                message: 'fix: handle shift cutoff midnight edge case',
                author: { name: 'Samchuk Dev', date: '2026-11-24T10:00:00Z' },
              },
            },
          };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [] };
        }
        if (url.includes('/contents/CHANGELOG.md')) {
          return { status: 404, ok: false, json: { message: 'Not Found' } };
        }
        if (url.includes(`/compare/${oldSha}...${newSha}`)) {
          return {
            status: 200,
            ok: true,
            json: {
              status: 'ahead',
              ahead_by: 2,
              behind_by: 0,
              commits: [
                {
                  sha: 'bbbb111100000000000000000000000000000001',
                  html_url: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/commit/bbbb1111',
                  commit: {
                    message: 'feat: add late report department filter',
                    author: { name: 'Dev', date: '2026-11-24T09:30:00Z' },
                  },
                },
                {
                  sha: newSha,
                  html_url: `https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/commit/${newSha}`,
                  commit: {
                    message: 'fix: handle shift cutoff midnight edge case',
                    author: { name: 'Dev', date: '2026-11-24T10:00:00Z' },
                  },
                },
              ],
              files: [{ filename: 'database/migrations/004_future_index.sql', status: 'added' }],
            },
          };
        }
        return { status: 404, ok: false, json: { message: 'Not Found' } };
      });

      try {
        const res = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.status, 'COMMIT_AHEAD_NO_RELEASE');
        assert.equal(res.data.hasUpdates, true);
        assert.equal(res.data.changelog.sourceType, 'COMMIT_HISTORY');
        assert.equal(res.data.changelog.hasOfficialReleaseNotes, false);
        assert.equal(res.data.changelog.isAutomatedThaiSummary, true);
        assert.ok(res.data.pendingMigrations.includes('004_future_index.sql'));
        assert.ok(res.data.changelog.categories.database.some((e: any) => e.rawText.includes('004_future_index.sql')));
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -----------------------------------------------------------------------
    // 4. CHANGELOG.md Fallback Priority
    // -----------------------------------------------------------------------
    await t.test('4. Falls back to remote CHANGELOG.md when GitHub Releases has no body notes', async () => {
      const oldSha = '3333222233334444555566667777888899990001';
      const newSha = 'cccc222233334444555566667777888899990002';
      const mdContent = [
        '# Changelog',
        '## [2.1.0] - 2026-11-24',
        '### Added',
        '- เพิ่มตารางสรุปเวลาปฏิบัติงานประจำเดือน',
        '### Fixed',
        '- แก้ไขการคำนวณเวลามาสายข้ามวัน',
        '## [2.0.0] - 2026-11-01',
        '- รุ่นเริ่มต้น',
      ].join('\n');

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: oldSha,
        targetCommit: newSha,
        hasUpdates: true,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
        if (url.endsWith('/commits/main')) {
          return { status: 200, ok: true, json: { sha: newSha, commit: { message: 'release 2.1.0' } } };
        }
        if (url.includes('/releases')) {
          return {
            status: 200,
            ok: true,
            json: [{ tag_name: 'v2.1.0', name: 'v2.1.0', body: '', draft: false, prerelease: false }],
          };
        }
        if (url.includes('/contents/CHANGELOG.md')) {
          return {
            status: 200,
            ok: true,
            json: { content: Buffer.from(mdContent, 'utf8').toString('base64') },
          };
        }
        if (url.includes('/compare/')) {
          return { status: 200, ok: true, json: { status: 'ahead', ahead_by: 1, behind_by: 0, commits: [], files: [] } };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        const res = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res.status, 200);
        assert.equal(res.data.changelog.sourceType, 'CHANGELOG_MD');
        assert.equal(res.data.changelog.hasOfficialReleaseNotes, true);
        assert.equal(res.data.changelog.totalEntries, 2);
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -----------------------------------------------------------------------
    // 5. GITHUB_UNREACHABLE & HISTORY_DIVERGED
    // -----------------------------------------------------------------------
    await t.test('5. GITHUB_UNREACHABLE (HTTP 503 & Rate Limit) and HISTORY_DIVERGED fail honestly and block deployment', async () => {
      const localSha = '4444222233334444555566667777888899990001';
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: localSha,
        targetCommit: localSha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));

      // 5a. Rate Limit 403
      setGitHubFetcherForTests(async () => ({
        status: 403,
        ok: false,
        json: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0' },
      }));

      try {
        const rateRes = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(rateRes.status, 200);
        assert.equal(rateRes.data.status, 'GITHUB_UNREACHABLE');
        assert.equal(rateRes.data.githubReachable, false);
        assert.equal(rateRes.data.githubErrorCode, 'GITHUB_RATE_LIMITED');
        assert.equal(rateRes.data.hasUpdates, false);
        assert.equal(rateRes.data.readiness.canDeploy, false);

        // 5b. Diverged commit history
        const remoteSha = 'dddd222233334444555566667777888899990009';
        setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
          if (url.endsWith('/commits/main')) {
            return { status: 200, ok: true, json: { sha: remoteSha, commit: { message: 'remote commit' } } };
          }
          if (url.includes('/releases')) {
            return { status: 200, ok: true, json: [] };
          }
          if (url.includes('/compare/')) {
            return {
              status: 200,
              ok: true,
              json: { status: 'diverged', ahead_by: 2, behind_by: 1, commits: [], files: [] },
            };
          }
          return { status: 404, ok: false, json: {} };
        });

        const divRes = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(divRes.status, 200);
        assert.equal(divRes.data.status, 'HISTORY_DIVERGED');
        assert.equal(divRes.data.hasUpdates, false);
        assert.equal(divRes.data.readiness.canDeploy, false);
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // -----------------------------------------------------------------------
    // 6. Strict RBAC Enforcement (ADMIN allowed, HR & GENERAL_USER blocked 403)
    // -----------------------------------------------------------------------
    await t.test('6. Strictly enforces ADMIN-only RBAC across all Update Center endpoints', async () => {
      for (const token of [staffToken, generalToken]) {
        const nRes = await apiCall('/api/Sam_Att/deployment/update-notification', { token });
        assert.equal(nRes.status, 403);
        const rRes = await apiCall('/api/Sam_Att/deployment/readiness', { token });
        assert.equal(rRes.status, 403);
        const cRes = await apiCall('/api/Sam_Att/deployment/check-updates', { method: 'POST', token });
        assert.equal(cRes.status, 403);
        const bRes = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token,
          body: { confirmRun: true },
        });
        assert.equal(bRes.status, 403);
      }
    });

    // -----------------------------------------------------------------------
    // 7. HTTP 422 / Exit Code 1 Structured Diagnostics + Secret Redaction
    // -----------------------------------------------------------------------
    await t.test('7. HTTP 422 / Exit Code 1 returns structured step diagnostics and masks all secrets', async () => {
      const secretUrl = 'mysql://sam_att_app:SuperSecretDBPass99!@10.1.0.201/samchuk_attendance_v2';
      const secretGhToken = 'ghp_1234567890abcdefghijklmnopQRSTUVWX';
      const secretBearer = 'Bearer eyJhbGciOiJIUzI1NiJ9.supersecretpayload.signature';

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: '1111222233334444555566667777888899990001',
        targetCommit: 'eeee222233334444555566667777888899990002',
        hasUpdates: true,
        gitMigrationFiles: [],
      }));

      setDeployBatRunnerForTests(async (scriptPath) => ({
        exitCode: 1,
        stdout: [
          '[1/7] Preflight Check ........................ FAIL',
          'ERROR [Preflight Check]: PREFLIGHT_DIRTY_WORKING_TREE: Local modifications detected (D bun.lock)',
          `DEBUG_CONN=${secretUrl}`,
          `Authorization: ${secretBearer}`,
          `GITHUB_TOKEN=${secretGhToken}`,
          'DEPLOYMENT ABORTED (NO SYSTEM CHANGES APPLIED)',
        ].join('\n'),
        stderr: `SAM_ATT_DB_PASSWORD=TopSecretPass123!`,
        scriptPath,
        durationMs: 125,
      }));

      try {
        const res = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true },
        });
        assert.equal(res.status, 422);
        assert.equal(res.data.status, 'FAILED');
        assert.equal(res.data.exitCode, 1);
        assert.equal(res.data.error, 'PREFLIGHT_DIRTY_WORKING_TREE');
        assert.equal(res.data.diagnostic.failedStepNumber, 1);
        assert.equal(res.data.diagnostic.failedStepName, 'Preflight Check');
        assert.equal(res.data.diagnostic.errorCode, 'PREFLIGHT_DIRTY_WORKING_TREE');
        assert.equal(res.data.diagnostic.rollbackStatus, 'NO_CHANGES_APPLIED');
        assert.ok(res.data.diagnostic.remediation.includes('git status'));

        // Verify zero secret leakage in HTTP response & deployment_history DB row
        const serialized = JSON.stringify(res.data);
        assert.ok(!serialized.includes('SuperSecretDBPass99!'));
        assert.ok(!serialized.includes(secretGhToken));
        assert.ok(!serialized.includes('supersecretpayload'));
        assert.ok(!serialized.includes('TopSecretPass123!'));

        const historyRows = await dbQuery<{ notes: string }>(
          'SELECT notes FROM deployment_history WHERE id = ?',
          [res.data.deploymentId]
        );
        assert.equal(historyRows.length, 1);
        const notes = String(historyRows[0].notes || '');
        assert.ok(notes.includes('PREFLIGHT_DIRTY_WORKING_TREE'));
        assert.ok(!notes.includes('SuperSecretDBPass99!'));
        assert.ok(!notes.includes(secretGhToken));
        assert.ok(!notes.includes('TopSecretPass123!'));
      } finally {
        setDeployBatRunnerForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -----------------------------------------------------------------------
    // 8. Diagnostic parser & Script invariants (no bun.lock deletion, pure 7-bit ASCII)
    // -----------------------------------------------------------------------
    await t.test('8. Diagnostic parser covers common Exit Code 1 causes and Deploy_Sam_Att.ps1 fixes bun.lock while staying 7-bit ASCII', async () => {
      const d1 = diagnoseDeploymentFailure(
        1,
        '[3/7] Backup ........................ FAIL\nERROR [Backup]: BACKUP_FAILED_NO_MYSQLDUMP: mysqldump.exe not found',
        ''
      );
      assert.equal(d1.errorCode, 'BACKUP_FAILED_NO_MYSQLDUMP');
      assert.equal(d1.failedStepNumber, 3);
      assert.ok(d1.remediation.includes('MySQL'));

      const d2 = diagnoseDeploymentFailure(
        1,
        '[WARNING] Please right-click Deploy_Sam_Att.bat and select: "Run as administrator"',
        ''
      );
      assert.equal(d2.errorCode, 'PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED');

      const sanitized = sanitizeDeploymentLog(
        'https://user:Pass123@github.com/org/repo ghp_abcdefghijklmnopqrstuvwxyz123456'
      );
      assert.ok(!sanitized.includes('Pass123'));
      assert.ok(!sanitized.includes('ghp_abcdefghijklmnopqrstuvwxyz123456'));

      const ps1 = fs.readFileSync(path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.ps1'), 'utf8');
      assert.ok(/^[\x00-\x7F]*$/.test(ps1), 'Deploy_Sam_Att.ps1 MUST remain strictly 7-bit ASCII');
      assert.ok(
        !ps1.includes('Remove-Item -Path (Join-Path $AppDir "bun.lock")'),
        'Deploy_Sam_Att.ps1 must no longer delete tracked bun.lock during build'
      );

      const bat = fs.readFileSync(path.resolve(process.cwd(), 'deployment', 'Deploy_Sam_Att.bat'), 'utf8');
      assert.ok(bat.includes('PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED'));
    });

    // -----------------------------------------------------------------------
    // 9. GITHUB_TOKEN Authorization Header, User-Agent & Anonymous Fallback
    // -----------------------------------------------------------------------
    await t.test('9. Sends Bearer GITHUB_TOKEN & User-Agent: Sam-Att-Updater when configured, and falls back to anonymous calls cleanly', async () => {
      const sha = '5555222233334444555566667777888899990005';
      const prevToken = process.env.GITHUB_TOKEN;
      const recordedHeaders: Array<Record<string, string>> = [];

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));

      setGitHubFetcherForTests(async (url, headers): Promise<GitHubHttpResponse> => {
        recordedHeaders.push({ ...headers });
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: { sha, commit: { message: 'chore: token test' } },
            headers: {
              'x-ratelimit-limit': headers.Authorization ? '5000' : '60',
              'x-ratelimit-remaining': headers.Authorization ? '4999' : '59',
              'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800),
            },
          };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [] };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        // 9a. With GITHUB_TOKEN
        const testTok = 'ghp_1234567890abcdefABCDEF1234567890xy';
        process.env.GITHUB_TOKEN = testTok;
        clearGitHubUpdateCacheForTests();

        const authRes = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
          body: { force: true },
        });
        assert.equal(authRes.status, 200);
        assert.equal(authRes.data.githubReachable, true);
        assert.equal(authRes.data.tokenConfigured, true);
        assert.ok(authRes.data.tokenMaskedHint?.includes('90xy'));
        assert.equal(authRes.data.rateLimit?.limit, 5000);
        assert.ok(!JSON.stringify(authRes.data).includes(testTok), 'Raw GITHUB_TOKEN must never leak to response');

        assert.ok(recordedHeaders.length >= 1);
        assert.equal(recordedHeaders[0]['User-Agent'], 'Sam-Att-Updater');
        assert.equal(recordedHeaders[0].Authorization, `Bearer ${testTok}`);

        // 9b. Without GITHUB_TOKEN (Anonymous Fallback)
        recordedHeaders.length = 0;
        delete process.env.GITHUB_TOKEN;
        clearGitHubUpdateCacheForTests();

        const anonRes = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
          body: { force: true },
        });
        assert.equal(anonRes.status, 200);
        assert.equal(anonRes.data.githubReachable, true);
        assert.equal(anonRes.data.tokenConfigured, false);
        assert.equal(anonRes.data.tokenMaskedHint, null);
        assert.equal(anonRes.data.rateLimit?.limit, 60);
        assert.ok(recordedHeaders.length >= 1);
        assert.equal(recordedHeaders[0]['User-Agent'], 'Sam-Att-Updater');
        assert.equal(recordedHeaders[0].Authorization, undefined);
      } finally {
        if (prevToken !== undefined) {
          process.env.GITHUB_TOKEN = prevToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });

    // -----------------------------------------------------------------------
    // 10. In-Memory Cache (10 min), ?force=true Bypass & ETag / 304 Support
    // -----------------------------------------------------------------------
    await t.test('10. Caches results on normal page refresh, bypasses on ?force=true, and reuses ETag 304 payloads', async () => {
      const sha = '6666222233334444555566667777888899990006';
      let fetchCount = 0;
      let commitCalls = 0;
      const seenIfNoneMatch: Array<string | undefined> = [];

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));

      setGitHubFetcherForTests(async (url, headers): Promise<GitHubHttpResponse> => {
        fetchCount += 1;
        if (url.endsWith('/commits/main')) {
          commitCalls += 1;
          seenIfNoneMatch.push(headers['If-None-Match']);
          if (commitCalls === 1) {
            return {
              status: 200,
              ok: true,
              json: { sha, commit: { message: 'feat: initial cached commit' } },
              headers: {
                etag: 'W/"etag-commit-main-v1"',
                'x-ratelimit-limit': '60',
                'x-ratelimit-remaining': '58',
              },
            };
          }
          assert.equal(headers['If-None-Match'], 'W/"etag-commit-main-v1"');
          return {
            status: 304,
            ok: false,
            json: null,
            headers: {
              etag: 'W/"etag-commit-main-v1"',
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '58',
            },
          };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [], headers: { etag: '"etag-rel-v1"' } };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        // Call 1 (populate cache)
        const r1 = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
          body: { force: false },
        });
        assert.equal(r1.status, 200);
        assert.equal(r1.data.fromCache, false);
        const callsAfterFirst = fetchCount;
        assert.equal(commitCalls, 1);

        // Call 2 (normal page refresh without ?force=true -> hits in-memory cache, zero GitHub API calls!)
        const r2 = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
          body: { force: false },
        });
        assert.equal(r2.status, 200);
        assert.equal(r2.data.fromCache, true);
        assert.equal(fetchCount, callsAfterFirst, 'Cached page reload must not invoke GitHub API');

        // Call 3 (manual ?force=true -> bypasses in-memory cache, sends If-None-Match & accepts 304)
        const r3 = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
          body: { force: true },
        });
        assert.equal(r3.status, 200);
        assert.equal(r3.data.fromCache, false);
        assert.equal(r3.data.status, 'UP_TO_DATE');
        assert.equal(r3.data.targetCommit, sha);
        assert.equal(commitCalls, 2);
        assert.equal(seenIfNoneMatch[1], 'W/"etag-commit-main-v1"');
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // -----------------------------------------------------------------------
    // 11. Granular GitHub Error Classification (401, 403/429 Reset Time, 404, Timeout, Network)
    // -----------------------------------------------------------------------
    await t.test('11. Classifies 401, 403/429 with x-ratelimit-reset, 404, Timeout, and Network failures accurately', async () => {
      const sha = '7777222233334444555566667777888899990007';
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));

      try {
        // 11a. 401 Unauthorized
        setGitHubFetcherForTests(async () => ({
          status: 401,
          ok: false,
          json: { message: 'Bad credentials' },
        }));
        const res401 = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res401.data.githubReachable, false);
        assert.equal(res401.data.githubErrorCode, 'GITHUB_UNAUTHORIZED');
        assert.ok(res401.data.githubError.includes('401'));

        // 11b. 429 Too Many Requests with x-ratelimit-reset
        const resetSec = 1795600000;
        setGitHubFetcherForTests(async () => ({
          status: 429,
          ok: false,
          json: { message: 'API rate limit exceeded' },
          headers: {
            'x-ratelimit-limit': '60',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(resetSec),
          },
        }));
        const res429 = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res429.data.githubReachable, false);
        assert.equal(res429.data.githubErrorCode, 'GITHUB_RATE_LIMITED');
        assert.equal(res429.data.rateLimit?.resetEpochSec, resetSec);
        assert.ok(res429.data.rateLimit?.resetAtThai);
        assert.ok(res429.data.githubError.includes(res429.data.rateLimit.resetAtThai));

        // 11c. 404 Not Found (missing repo / missing repo scope for Private Repo)
        setGitHubFetcherForTests(async () => ({
          status: 404,
          ok: false,
          json: { message: 'Not Found' },
        }));
        const res404 = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(res404.data.githubReachable, false);
        assert.equal(res404.data.githubErrorCode, 'GITHUB_NOT_FOUND');
        assert.ok(res404.data.githubError.includes('404'));
        assert.ok(res404.data.remediationThai.includes('repo'));

        // 11d. Timeout (AbortError)
        setGitHubFetcherForTests(async () => {
          const err = new Error('The operation was aborted due to timeout');
          err.name = 'AbortError';
          throw err;
        });
        const resTimeout = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(resTimeout.data.githubReachable, false);
        assert.equal(resTimeout.data.githubErrorCode, 'GITHUB_TIMEOUT');
        assert.ok(resTimeout.data.githubError.includes('Firewall') || resTimeout.data.remediationThai.includes('Firewall'));

        // 11e. Network Error (ENOTFOUND / ECONNREFUSED)
        setGitHubFetcherForTests(async () => {
          throw new Error('getaddrinfo ENOTFOUND api.github.com');
        });
        const resNet = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(resNet.data.githubReachable, false);
        assert.equal(resNet.data.githubErrorCode, 'GITHUB_NETWORK_ERROR');
        assert.ok(resNet.data.remediationThai.includes('api.github.com'));
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // -----------------------------------------------------------------------
    // 12. Admin UI GITHUB_TOKEN Persistence (.env), RBAC, Validation & Hot Reload
    // -----------------------------------------------------------------------
    await t.test('12. Persists GITHUB_TOKEN to isolated .env with RBAC, injection validation, hot reload & zero secret leakage', async () => {
      const tempEnvFile = path.join(os.tmpdir(), `sam_att_test_env_${TEST_RUN_ID}.env`);
      const prevEnvPath = process.env.SAM_ATT_ENV_PATH;
      const prevToken = process.env.GITHUB_TOKEN;
      const sha = '8888222233334444555566667777888899990008';

      fs.writeFileSync(
        tempEnvFile,
        'NODE_ENV=test\nSAM_ATT_DB_HOST=127.0.0.1\nGITHUB_TOKEN=\n',
        'utf8'
      );
      process.env.SAM_ATT_ENV_PATH = tempEnvFile;
      delete process.env.GITHUB_TOKEN;

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url, headers): Promise<GitHubHttpResponse> => {
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: { sha, commit: { message: 'chore: hot reload check' } },
            headers: {
              'x-ratelimit-limit': headers.Authorization ? '5000' : '60',
              'x-ratelimit-remaining': headers.Authorization ? '4998' : '59',
            },
          };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [] };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        // 12a. Non-ADMIN RBAC blocked
        for (const nonAdminTok of [staffToken, generalToken]) {
          const forbidden = await apiCall('/api/Sam_Att/deployment/github-token', {
            method: 'POST',
            token: nonAdminTok,
            body: { token: 'ghp_1234567890abcdefghijklmnop' },
          });
          assert.equal(forbidden.status, 403);
        }

        // 12b. Blocks newline / injection / placeholder tokens
        const injRes = await apiCall('/api/Sam_Att/deployment/github-token', {
          method: 'POST',
          token: adminToken,
          body: { token: 'ghp_validprefix\nJWT_SECRET=hacked_secret' },
        });
        assert.equal(injRes.status, 400);
        assert.equal(injRes.data.error, 'INVALID_GITHUB_TOKEN_FORMAT');
        assert.ok(!fs.readFileSync(tempEnvFile, 'utf8').includes('hacked_secret'));

        // 12c. Valid ADMIN save persists .env, hot-reloads process.env, re-verifies GitHub & masks audit log
        const validNewToken = 'github_pat_11AAABBB0000111122223333_XYZ987';
        const saveRes = await apiCall('/api/Sam_Att/deployment/github-token', {
          method: 'POST',
          token: adminToken,
          body: { token: validNewToken },
        });
        assert.equal(saveRes.status, 200);
        assert.equal(saveRes.data.success, true);
        assert.equal(saveRes.data.tokenConfigured, true);
        assert.ok(saveRes.data.tokenMaskedHint?.includes('Z987'));
        assert.equal(saveRes.data.checkResult.githubReachable, true);
        assert.equal(saveRes.data.checkResult.rateLimit?.limit, 5000);
        assert.equal(process.env.GITHUB_TOKEN, validNewToken);

        const savedEnvText = fs.readFileSync(tempEnvFile, 'utf8');
        assert.ok(savedEnvText.includes('SAM_ATT_DB_HOST=127.0.0.1'), 'Existing .env keys must remain intact');
        assert.ok(savedEnvText.includes(`GITHUB_TOKEN=${validNewToken}`));

        // Zero raw token leakage in HTTP response or audit_logs
        assert.ok(!JSON.stringify(saveRes.data).includes(validNewToken));
        const auditRows = await dbQuery<{ action: string; target_id: string; detail_json: string }>(
          "SELECT action, target_id, detail_json FROM audit_logs WHERE action = 'GITHUB_TOKEN_UPDATED' ORDER BY id DESC LIMIT 1"
        );
        assert.equal(auditRows.length, 1);
        assert.ok(!JSON.stringify(auditRows[0]).includes(validNewToken));

        // 12d. Clear GITHUB_TOKEN cleanly
        const clearRes = await apiCall('/api/Sam_Att/deployment/github-token', {
          method: 'POST',
          token: adminToken,
          body: { clear: true },
        });
        assert.equal(clearRes.status, 200);
        assert.equal(clearRes.data.cleared, true);
        assert.equal(clearRes.data.tokenConfigured, false);
        assert.equal(clearRes.data.tokenMaskedHint, null);
        assert.equal(clearRes.data.checkResult.rateLimit?.limit, 60);
        assert.equal(process.env.GITHUB_TOKEN, undefined);

        const clearedEnvText = fs.readFileSync(tempEnvFile, 'utf8');
        assert.ok(clearedEnvText.includes('SAM_ATT_DB_HOST=127.0.0.1'));
        assert.ok(/GITHUB_TOKEN=\s*(?:\r?\n|$)/.test(clearedEnvText));
        assert.ok(!clearedEnvText.includes(validNewToken));
      } finally {
        if (prevEnvPath !== undefined) {
          process.env.SAM_ATT_ENV_PATH = prevEnvPath;
        } else {
          delete process.env.SAM_ATT_ENV_PATH;
        }
        if (prevToken !== undefined) {
          process.env.GITHUB_TOKEN = prevToken;
        } else {
          delete process.env.GITHUB_TOKEN;
        }
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
        try {
          fs.rmSync(tempEnvFile, { force: true });
        } catch {
          // ignore
        }
      }
    });
  } finally {
    await closeServer();
    try {
      fs.rmSync(TEST_DB_PATH, { force: true });
    } catch {
      // ignore
    }
  }
});
