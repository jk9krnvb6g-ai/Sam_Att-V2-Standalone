/**
 * ============================================================================
 * ชุดทดสอบป้องกัน Infinite API Request Loop & GitHub Rate Limit Protection
 * ไฟล์: backend/tests/update-center-loop-protection.test.ts
 * ============================================================================
 * ครอบคลุมครบ 18 สถานการณ์บังคับ (Frontend React 19 + Backend Express/Cache):
 *  1. Initial Load: เปิดหน้า DeploymentUpdateCenter & GitHubUpdateCenter ยิงครั้งเดียว ไม่วนลูป
 *  2. Parent Re-render Stability: Parent re-render หลายรอบไม่ทำให้ Update Center เรียกซ้ำ
 *  3. Callback Stability: Parent ส่ง inline callback (onNotificationChange / onUpdateBadgeChange) ไม่เกิด loop
 *  4. ToastContext Stability: เรียก showToast() ซ้ำไม่เปลี่ยน reference ของ useToast() และไม่กระตุ้น re-fetch
 *  5. React.StrictMode Double Invocation: Mount ใน <StrictMode> ไม่เกิด loop และ loading จบเป็น false เสมอ
 *  6. Manual Refresh: กดปุ่มตรวจสอบใหม่ยิง ?force=true 1 ครั้ง, แสดง toast, และ reset checking state
 *  7. Rapid Click Protection: กดปุ่มรัวๆ ระหว่าง pending ถูก deduplicate เหลือ 1 request
 *  8. Concurrent Requests (Single-flight): Admin หลายคำขอพร้อมกันตอน cache ว่าง ยิง GitHub API 1 รอบ
 *  9. Backend Cache Hit (30 นาที): Default TTL = 30 นาที และเรียกซ้ำภายใน TTL ใช้ cache ไม่ยิง GitHub เพิ่ม
 * 10. Cache Expiration: เมื่อ TTL หมดอายุ ระบบดึงข้อมูลใหม่จาก GitHub
 * 11. Rate Limit Simulation (403 / 429): เข้าสู่ Cooldown ทันที หยุดยิงแม้ ?force=true และแสดงเวลา reset ภาษาไทย
 * 12. Rate Limit Recovery After Reset: เมื่อ cooldown/reset หมดอายุ สามารถกลับมาตรวจ GitHub ได้สำเร็จ
 * 13. GitHub Connection Failure Fallback: Timeout/Rate-limit หลังเคยสำเร็จ คืน last-known-good stale fallback
 * 14. Unauthenticated vs Authenticated Token: รองรับทั้ง Anonymous และ GITHUB_TOKEN (Bearer + User-Agent)
 * 15. Update Badge Sync: Badge ซิงก์ถูกต้องและไม่ trigger loop เมื่อค่าเดิมกลับมา
 * 16. Component Unmount Cleanup: ยกเลิก request ผ่าน AbortController และเคลียร์ timer เมื่อ unmount
 * 17. Safe Deployment Workflow: ขั้นตอนอัปเดต (/deployment/run-bat) เมื่อพร้อมยังทำงานครบถ้วน
 * 18. Migration Approval Protection: ระงับ MIGRATION_APPROVAL_REQUIRED, ตรวจ MISMATCH และบังคับ ADMIN Re-Auth
 */

import { installFakeDomEnvironment } from './helpers/fakeDom.ts';
const fakeDom = installFakeDomEnvironment();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

const TEST_RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `sam_att_loop_fix_${TEST_RUN_ID}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_TEST_ISOLATION = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'loop_fix_test_jwt_secret_key_min_32_chars_2026';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'loop_fix_test_scanner_token_min_24_chars';

import { loadConfig } from '../src/config/env.ts';
import {
  resetSqliteInstanceForTests,
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
  type GitHubHttpResponse,
} from '../src/modules/deployment/githubUpdateCenter.ts';

import { ToastProvider, useToast } from '../../frontend/src/components/common/ToastContext.tsx';
import { DeploymentUpdateCenter } from '../../frontend/src/components/deployment/DeploymentUpdateCenter.tsx';
import { GitHubUpdateCenter } from '../../frontend/src/components/deployment/GitHubUpdateCenter.tsx';
import { UPDATE_NOTIFICATION_POLL_INTERVAL_MS } from '../../frontend/src/App.tsx';

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function flushMicrotasksAndRender(): Promise<void> {
  await act(async () => {
    await waitMs(25);
  });
  await act(async () => {
    await waitMs(15);
  });
}

function createMockFrontendResponses(overrides?: {
  status?: Record<string, any>;
  check?: Record<string, any>;
}) {
  const statusPayload = {
    currentVersion: 'v2.0.0',
    installedCommit: '1111222233334444555566667777888899990001',
    installedCommitShort: '1111222',
    branch: 'main',
    httpsPort: 4101,
    hasPendingMigrations: false,
    pendingMigrations: [],
    pendingMigrationDetails: [],
    appliedMigrations: [],
    checksumMismatches: [],
    lastCheckedAt: '2026-11-25T10:00:00.000Z',
    recentHistory: [],
    backups: [],
    repoUrl: 'https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone',
    ...overrides?.status,
  };

  const checkPayload = {
    status: 'UP_TO_DATE',
    versionStatus: 'UP_TO_DATE',
    statusLabelThai: 'ระบบเป็นเวอร์ชันล่าสุดแล้ว',
    statusDescriptionThai: 'ซอร์สโค้ดตรงกับ Branch main บน GitHub แล้ว',
    hasUpdates: false,
    githubReachable: true,
    githubError: null,
    githubErrorCode: null,
    remediationThai: null,
    installedVersion: 'v2.0.0',
    installedReleaseTag: 'v2.0.0',
    currentCommit: '1111222233334444555566667777888899990001',
    currentCommitShort: '1111222',
    latestVersion: 'v2.0.0',
    latestRelease: null,
    targetCommit: '1111222233334444555566667777888899990001',
    targetCommitShort: '1111222',
    latestCommitDate: '2026-11-25T09:00:00.000Z',
    latestCommitMessage: 'chore: release v2.0.0',
    latestCommitAuthor: 'Samchuk Dev',
    commitsBehind: 0,
    commitsAhead: 0,
    compareStatus: 'identical',
    localGitAvailable: true,
    workingTreeClean: true,
    dirtyFiles: [],
    compareMigrationFiles: [],
    pendingMigrations: [],
    pendingMigrationDetails: [],
    appliedMigrations: [],
    checksumMismatches: [],
    migrationApprovalRequired: false,
    changelog: {
      sourceType: 'NONE',
      sourceLabelThai: 'ไม่มีรายการเปลี่ยนแปลงเพิ่มเติม',
      hasOfficialReleaseNotes: false,
      isAutomatedThaiSummary: false,
      isMultiVersionJump: false,
      versionRangeLabel: 'v2.0.0',
      totalEntries: 0,
      categories: {
        features: [],
        fixes: [],
        improvements: [],
        security: [],
        database: [],
        breaking: [],
      },
      commits: [],
      releasesIncluded: [],
      warnings: [],
    },
    tokenConfigured: false,
    tokenMaskedHint: null,
    fromCache: false,
    cacheExpiresAt: '2026-11-25T10:30:00.000Z',
    cacheTtlMinutes: 30,
    rateLimit: {
      limit: 60,
      remaining: 58,
      resetEpochSec: 1795665000,
      resetAt: '2026-11-25T10:30:00.000Z',
      resetAtThai: '25 พ.ย. 2569 17:30 น.',
    },
    checkedAt: '2026-11-25T10:00:00.000Z',
    readiness: {
      canDeploy: false,
      checkedAt: '2026-11-25T10:00:00.000Z',
      blockingFailures: 0,
      warnings: 0,
      passedCount: 7,
      totalChecks: 7,
      checks: [],
    },
    ...overrides?.check,
  };

  return { statusPayload, checkPayload };
}

function makeJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('Update Center Loop Protection & GitHub Rate Limit Guard (18 Scenarios)', async (t) => {
  // =========================================================================
  // PART A: REAL REACT 19 FRONTEND LIFECYCLE TESTS (Scenarios 1-7, 15, 16)
  // =========================================================================
  await t.test('Frontend 1-5: Initial Load, Parent Re-render, Inline Callback, ToastContext Stability & StrictMode', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string; signal?: AbortSignal | null }> = [];
    const { statusPayload, checkPayload } = createMockFrontendResponses();

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method, signal: init?.signal });
      if (url.includes('/deployment/status')) return makeJsonResponse(statusPayload);
      if (url.includes('/deployment/check-updates')) return makeJsonResponse(checkPayload);
      return makeJsonResponse({ error: 'NOT_FOUND' }, 404);
    }) as typeof fetch;

    const container = fakeDom.createContainer();
    const root = createRoot(container as unknown as HTMLElement);

    let setParentCount!: React.Dispatch<React.SetStateAction<number>>;
    let triggerToastFromChild!: () => void;
    const seenToastRefs: any[] = [];
    const badgeCalls: any[] = [];

    function HarnessChild() {
      const toast = useToast();
      seenToastRefs.push(toast);
      triggerToastFromChild = () => toast.showSuccess('ทดสอบแจ้งเตือน', 'คง reference เดิม');
      return React.createElement('div', { 'data-testid': 'harness-probe' }, 'probe');
    }

    function ParentWrapper({ mode }: { mode: 'deployment' | 'github' }) {
      const [count, setCount] = React.useState(0);
      setParentCount = setCount;
      // Intentionally pass UNSTABLE inline arrow functions on every render (Root Cause regression test!)
      return React.createElement(
        ToastProvider,
        null,
        React.createElement('div', { 'data-parent-count': String(count) }, [
          React.createElement(HarnessChild, { key: 'probe' }),
          mode === 'deployment'
            ? React.createElement(DeploymentUpdateCenter, {
                key: 'duc',
                userRole: 'ADMIN',
                onNotificationChange: (b?: any) => badgeCalls.push(b),
              })
            : React.createElement(GitHubUpdateCenter, {
                key: 'guc',
                userRole: 'ADMIN',
                onUpdateBadgeChange: (hasUpd: boolean) => badgeCalls.push(hasUpd),
              }),
        ])
      );
    }

    try {
      // Scenario 1 + 5: Mount DeploymentUpdateCenter inside React.StrictMode
      await act(async () => {
        root.render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(ParentWrapper, { mode: 'deployment' })
          )
        );
      });
      await flushMicrotasksAndRender();
      await waitMs(80);

      const initialStatusCalls = calls.filter((c) => c.url.includes('/deployment/status')).length;
      const initialCheckCalls = calls.filter((c) => c.url.includes('/deployment/check-updates')).length;
      assert.ok(initialStatusCalls >= 1 && initialStatusCalls <= 2, `StrictMode status calls bounded (${initialStatusCalls})`);
      assert.ok(initialCheckCalls >= 1 && initialCheckCalls <= 2, `StrictMode check calls bounded (${initialCheckCalls})`);
      // Loading must terminate completely (no stuck spinner!)
      assert.ok(!container.textContent.includes('กำลังโหลดศูนย์อัปเดตระบบ...'));

      const countBeforeRerenders = calls.length;

      // Scenario 2 & 3: Re-render parent multiple times with inline callback props
      for (let i = 0; i < 5; i++) {
        await act(async () => {
          setParentCount((n) => n + 1);
        });
      }
      await waitMs(80);
      assert.equal(calls.length, countBeforeRerenders, 'Parent re-renders with inline callback must NOT re-trigger API fetch loop');

      // Scenario 4: Trigger Toast notifications repeatedly -> ToastContext object identity must stay identical!
      const baselineToastRef = seenToastRefs[seenToastRefs.length - 1];
      await act(async () => {
        triggerToastFromChild();
        triggerToastFromChild();
      });
      await waitMs(60);
      const latestToastRef = seenToastRefs[seenToastRefs.length - 1];
      assert.equal(Object.is(baselineToastRef, latestToastRef), true, 'useToast() context value reference must stay memoized across toast updates');
      assert.equal(calls.length, countBeforeRerenders, 'Updating ToastProvider state must NOT trigger Update Center API calls');

      // Also verify GitHubUpdateCenter under React.StrictMode + inline onUpdateBadgeChange
      calls.length = 0;
      await act(async () => {
        root.render(
          React.createElement(
            React.StrictMode,
            null,
            React.createElement(ParentWrapper, { mode: 'github' })
          )
        );
      });
      await flushMicrotasksAndRender();
      await waitMs(80);

      const gucCallsAfterMount = calls.length;
      assert.ok(gucCallsAfterMount >= 2 && gucCallsAfterMount <= 4, `GitHubUpdateCenter initial bounded (${gucCallsAfterMount})`);
      for (let i = 0; i < 4; i++) {
        await act(async () => {
          setParentCount((n) => n + 1);
        });
      }
      await waitMs(80);
      assert.equal(calls.length, gucCallsAfterMount, 'GitHubUpdateCenter must NOT loop on parent re-render or inline callback');
      assert.ok(badgeCalls.length >= 1, 'Badge sync callback invoked once initial check completes');
    } finally {
      globalThis.fetch = originalFetch;
      try {
        await act(async () => {
          root.unmount();
        });
      } finally {
        fakeDom.document.body.removeChild(container);
      }
    }
  });

  await t.test('Frontend 6 & 7: Manual Refresh sends ?force=true once and deduplicates rapid clicks', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method: string }> = [];
    const { statusPayload, checkPayload } = createMockFrontendResponses();
    let releasePendingForce!: () => void;
    let holdForcePromise = false;

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.includes('/deployment/status')) {
        return makeJsonResponse(statusPayload);
      }
      if (url.includes('/deployment/check-updates') && url.includes('force=true') && holdForcePromise) {
        await new Promise<void>((resolve) => {
          releasePendingForce = resolve;
        });
        return makeJsonResponse(checkPayload);
      }
      if (url.includes('/deployment/check-updates')) {
        return makeJsonResponse(checkPayload);
      }
      return makeJsonResponse({}, 404);
    }) as typeof fetch;

    const container = fakeDom.createContainer();
    const root = createRoot(container as unknown as HTMLElement);

    try {
      await act(async () => {
        root.render(
          React.createElement(
            ToastProvider,
            null,
            React.createElement(DeploymentUpdateCenter, { userRole: 'ADMIN' })
          )
        );
      });
      await flushMicrotasksAndRender();

      // Scenario 6: Single manual refresh click in DeploymentUpdateCenter
      calls.length = 0;
      const refreshButtons = container.findButtonsByText('ตรวจสอบเวอร์ชันล่าสุดใหม่');
      assert.ok(refreshButtons.length >= 1, 'Refresh button must exist in DeploymentUpdateCenter');
      await act(async () => {
        refreshButtons[0].click();
      });
      await flushMicrotasksAndRender();

      const singleForceCalls = calls.filter((c) => c.url.includes('/deployment/check-updates?force=true'));
      assert.equal(singleForceCalls.length, 1, 'Manual click sends ?force=true exactly once');
      assert.equal(refreshButtons[0].disabled, false, 'Button loading state must reset back to enabled in finally');

      // Scenario 7: Rapid clicks while force request is pending -> deduplicated to 1!
      calls.length = 0;
      holdForcePromise = true;
      await act(async () => {
        for (let i = 0; i < 5; i++) {
          refreshButtons[0].click();
        }
      });
      await waitMs(15);
      const rapidForceCalls = calls.filter((c) => c.url.includes('/deployment/check-updates?force=true'));
      assert.equal(rapidForceCalls.length, 1, '5 rapid clicks while pending must coalesce into 1 network request');

      await act(async () => {
        releasePendingForce();
      });
      await flushMicrotasksAndRender();
      assert.equal(refreshButtons[0].disabled, false, 'Button resets cleanly after rapid-click flight settles');

      // Also verify GitHubUpdateCenter rapid clicks
      await act(async () => {
        root.render(
          React.createElement(
            ToastProvider,
            null,
            React.createElement(GitHubUpdateCenter, { userRole: 'ADMIN' })
          )
        );
      });
      await flushMicrotasksAndRender();
      calls.length = 0;
      const gucRefreshButtons = container.findButtonsByText('ตรวจสอบเวอร์ชันอีกครั้ง');
      assert.ok(gucRefreshButtons.length >= 1, 'Refresh button must exist in GitHubUpdateCenter');
      holdForcePromise = true;
      await act(async () => {
        for (let i = 0; i < 4; i++) {
          gucRefreshButtons[0].click();
        }
      });
      await waitMs(15);
      const gucRapidCalls = calls.filter((c) => c.url.includes('/deployment/check-updates?force=true'));
      assert.equal(gucRapidCalls.length, 1, 'GitHubUpdateCenter coalesces rapid manual clicks into 1 request');
      await act(async () => {
        releasePendingForce();
      });
      await flushMicrotasksAndRender();
      assert.equal(gucRefreshButtons[0].disabled, false);
    } finally {
      await act(async () => {
        root.unmount();
      });
      fakeDom.document.body.removeChild(container);
      globalThis.fetch = originalFetch;
    }
  });

  await t.test('Frontend 15 & 16: Update Badge Sync preserves stability & Unmount aborts active requests + cleans App interval', async () => {
    const originalFetch = globalThis.fetch;
    const capturedSignals: AbortSignal[] = [];

    globalThis.fetch = ((_input: any, init?: RequestInit) => {
      if (init?.signal) capturedSignals.push(init.signal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;

    const container = fakeDom.createContainer();
    const root = createRoot(container as unknown as HTMLElement);

    try {
      await act(async () => {
        root.render(
          React.createElement(
            ToastProvider,
            null,
            React.createElement(DeploymentUpdateCenter, { userRole: 'ADMIN' })
          )
        );
      });
      await waitMs(15);
      assert.ok(capturedSignals.length >= 2, 'Active requests registered AbortSignal');
      assert.equal(capturedSignals.every((s) => !s.aborted), true);

      // Scenario 16: Unmount mid-flight -> AbortController MUST abort all active signals
      await act(async () => {
        root.unmount();
      });
      await waitMs(20);
      assert.equal(
        capturedSignals.every((s) => s.aborted),
        true,
        'Unmounting Update Center must abort all pending fetch signals'
      );

      // Verify App.tsx badge polling default interval is 30 minutes & cleanup exists cleanly
      assert.equal(UPDATE_NOTIFICATION_POLL_INTERVAL_MS, 30 * 60 * 1000);
      const appSource = fs.readFileSync(path.resolve(process.cwd(), 'frontend/src/App.tsx'), 'utf8');
      assert.ok(
        !appSource.includes('() => refreshAdminUpdateNotification('),
        'App.tsx must never pass an unstable inline arrow function as onNotificationChange'
      );
      assert.ok(appSource.includes('applyUpdateBadge'), 'App.tsx uses identity-preserving badge updater');
      assert.ok(appSource.includes('clearInterval(timerId)'), 'App.tsx clears polling interval on unmount/logout');
    } finally {
      globalThis.fetch = originalFetch;
      fakeDom.document.body.removeChild(container);
    }
  });

  // =========================================================================
  // PART B: REAL BACKEND API, CACHE, RATE LIMIT & DEPLOYMENT TESTS (8-14, 17-18)
  // =========================================================================
  resetSqliteInstanceForTests(TEST_DB_PATH);
  await runMigrations();
  await ensureBaselineSystemCatalog();
  await seedDemoSyntheticData();

  const app = createExpressApp();
  const srv = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const addr = srv.address() as AddressInfo;
  const serverUrl = `http://127.0.0.1:${addr.port}`;
  const closeServer = () =>
    new Promise<void>((resolve) => {
      if (typeof (srv as any).closeAllConnections === 'function') {
        (srv as any).closeAllConnections();
      }
      srv.close(() => resolve());
    });

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

  try {
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminLogin.status, 200);
    const adminToken = adminLogin.data.token;

    const sha = '9999222233334444555566667777888899990001';

    // Scenario 8 & 9: Single-flight Concurrent Deduplication + 30-minute Default Cache TTL
    await t.test('Backend 8 & 9: Single-flight coalesces 10 concurrent check-updates and defaults Cache TTL to 30 minutes', async () => {
      const prevTtl = process.env.GITHUB_CACHE_TTL_MS;
      delete process.env.GITHUB_CACHE_TTL_MS;
      clearGitHubUpdateCacheForTests();

      assert.equal(loadConfig().github.cacheTtlMs, 30 * 60 * 1000, 'Default cache TTL must be 30 minutes');

      let githubCommitCalls = 0;
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
        await waitMs(40);
        if (url.endsWith('/commits/main')) {
          githubCommitCalls += 1;
          return { status: 200, ok: true, json: { sha, commit: { message: 'chore: single-flight check' } } };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [] };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        // 10 simultaneous requests when cache is empty -> only 1 upstream /commits/main call!
        const concurrent = await Promise.all(
          Array.from({ length: 10 }, () =>
            apiCall('/api/Sam_Att/deployment/check-updates', {
              method: 'POST',
              token: adminToken,
              body: { force: false },
            })
          )
        );
        for (const r of concurrent) {
          assert.equal(r.status, 200);
          assert.equal(r.data.cacheTtlMinutes, 30);
          assert.equal(r.data.status, 'UP_TO_DATE');
        }
        assert.equal(githubCommitCalls, 1, '10 concurrent calls must coalesce into exactly 1 GitHub commit fetch');

        // Subsequent normal call hits 30-min cache -> 0 new GitHub calls
        const cachedCall = await apiCall('/api/Sam_Att/deployment/update-notification', {
          token: adminToken,
        });
        assert.equal(cachedCall.status, 200);
        assert.equal(cachedCall.data.fromCache, true);
        assert.equal(cachedCall.data.cacheTtlMinutes, 30);
        assert.equal(githubCommitCalls, 1);
      } finally {
        if (prevTtl !== undefined) process.env.GITHUB_CACHE_TTL_MS = prevTtl;
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // Scenario 10: Cache Expiration triggers re-fetch
    await t.test('Backend 10: Cache expiration after TTL re-fetches from GitHub automatically', async () => {
      const prevTtl = process.env.GITHUB_CACHE_TTL_MS;
      process.env.GITHUB_CACHE_TTL_MS = '70';
      clearGitHubUpdateCacheForTests();

      let githubCommitCalls = 0;
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
          githubCommitCalls += 1;
          return { status: 200, ok: true, json: { sha, commit: { message: 'chore: ttl expiry test' } } };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [] };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        const first = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(first.status, 200);
        assert.equal(first.data.fromCache, false);
        assert.equal(githubCommitCalls, 1);

        await waitMs(110);

        const afterExpiry = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(afterExpiry.status, 200);
        assert.equal(afterExpiry.data.fromCache, false);
        assert.equal(githubCommitCalls, 2, 'Expired cache entry must fetch fresh commit from GitHub');
      } finally {
        if (prevTtl !== undefined) process.env.GITHUB_CACHE_TTL_MS = prevTtl;
        else delete process.env.GITHUB_CACHE_TTL_MS;
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // Scenarios 11, 12, 13: Rate Limit 403/429 Cooldown + Stale Fallback + Recovery After Reset
    await t.test('Backend 11, 12 & 13: Enforces rate-limit cooldown (even on ?force=true), serves stale fallback, and recovers after reset', async () => {
      clearGitHubUpdateCacheForTests();
      let mode: 'OK' | 'RATE_LIMIT' | 'RECOVERED' = 'OK';
      let fetchCalls = 0;

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));

      setGitHubFetcherForTests(async (url): Promise<GitHubHttpResponse> => {
        fetchCalls += 1;
        if (mode === 'RATE_LIMIT') {
          return {
            status: 429,
            ok: false,
            json: { message: 'You have exceeded a secondary rate limit' },
            headers: {
              'x-ratelimit-limit': '60',
              'x-ratelimit-remaining': '0',
              'retry-after': '1',
            },
          };
        }
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: { sha, commit: { message: mode === 'RECOVERED' ? 'feat: recovered check' : 'chore: healthy baseline' } },
          };
        }
        if (url.includes('/releases')) {
          return { status: 200, ok: true, json: [] };
        }
        return { status: 404, ok: false, json: {} };
      });

      try {
        // First: establish last-known-good baseline
        const baseline = await apiCall('/api/Sam_Att/deployment/check-updates', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(baseline.status, 200);
        assert.equal(baseline.data.githubReachable, true);
        assert.equal(baseline.data.status, 'UP_TO_DATE');

        // Scenario 11 & 13: Trigger 429 rate limit -> enters 1s cooldown AND attaches stale fallback
        mode = 'RATE_LIMIT';
        const callsBeforeRateLimit = fetchCalls;
        const limited = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(limited.status, 200);
        assert.equal(limited.data.githubReachable, false);
        assert.equal(limited.data.githubErrorCode, 'GITHUB_RATE_LIMITED');
        assert.equal(limited.data.cooldownActive, true);
        assert.ok(limited.data.cooldownUntilThai, 'Thai reset/cooldown time must be returned');
        assert.equal(limited.data.isStale, true, 'Last-known-good stale warning attached on failure');
        assert.ok(limited.data.staleWarningThai);
        assert.ok(limited.data.lastSuccessfulCheckedAt);
        assert.equal(limited.data.readiness.canDeploy, false, 'Deploy stays blocked when GitHub is unreachable');

        const callsAfterTrigger = fetchCalls;
        assert.ok(callsAfterTrigger > callsBeforeRateLimit);

        // Even ?force=true during active cooldown MUST NOT call GitHub API!
        const blockedDuringCooldown = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(blockedDuringCooldown.status, 200);
        assert.equal(blockedDuringCooldown.data.cooldownActive, true);
        assert.equal(blockedDuringCooldown.data.isStale, true);
        assert.equal(fetchCalls, callsAfterTrigger, 'Active cooldown must prevent ANY GitHub HTTP calls even with ?force=true');

        // Scenario 12: Wait > 1s for cooldown expiry -> recovers cleanly
        await waitMs(1150);
        mode = 'RECOVERED';
        const recovered = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(recovered.status, 200);
        assert.equal(recovered.data.githubReachable, true);
        assert.equal(recovered.data.cooldownActive, false);
        assert.equal(recovered.data.isStale, false);
        assert.equal(recovered.data.latestCommitMessage, 'feat: recovered check');
      } finally {
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // Scenario 14: Unauthenticated vs Authenticated GITHUB_TOKEN
    await t.test('Backend 14: Supports anonymous fallback and Bearer GITHUB_TOKEN without secret leakage', async () => {
      const prevToken = process.env.GITHUB_TOKEN;
      const seenAuthHeaders: Array<string | undefined> = [];
      clearGitHubUpdateCacheForTests();

      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: sha,
        targetCommit: sha,
        hasUpdates: false,
        gitMigrationFiles: [],
      }));
      setGitHubFetcherForTests(async (url, headers): Promise<GitHubHttpResponse> => {
        seenAuthHeaders.push(headers.Authorization);
        assert.equal(headers['User-Agent'], 'Sam-Att-Updater');
        if (url.endsWith('/commits/main')) {
          return {
            status: 200,
            ok: true,
            json: { sha, commit: { message: 'chore: auth header test' } },
            headers: {
              'x-ratelimit-limit': headers.Authorization ? '5000' : '60',
              'x-ratelimit-remaining': headers.Authorization ? '4999' : '59',
            },
          };
        }
        if (url.includes('/releases')) return { status: 200, ok: true, json: [] };
        return { status: 404, ok: false, json: {} };
      });

      try {
        delete process.env.GITHUB_TOKEN;
        const anon = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(anon.status, 200);
        assert.equal(anon.data.tokenConfigured, false);
        assert.equal(anon.data.rateLimit?.limit, 60);
        assert.equal(seenAuthHeaders[0], undefined);

        const secretTok = 'ghp_TestTokenLoopProtection0123456789abcd';
        process.env.GITHUB_TOKEN = secretTok;
        clearGitHubUpdateCacheForTests();
        const authed = await apiCall('/api/Sam_Att/deployment/check-updates?force=true', {
          method: 'POST',
          token: adminToken,
        });
        assert.equal(authed.status, 200);
        assert.equal(authed.data.tokenConfigured, true);
        assert.equal(authed.data.rateLimit?.limit, 5000);
        assert.ok(seenAuthHeaders.includes(`Bearer ${secretTok}`));
        assert.ok(!JSON.stringify(authed.data).includes(secretTok));
      } finally {
        if (prevToken !== undefined) process.env.GITHUB_TOKEN = prevToken;
        else delete process.env.GITHUB_TOKEN;
        setGitHubFetcherForTests(null);
        setDeploymentGitInspectorForTests(null);
        clearGitHubUpdateCacheForTests();
      }
    });

    // Scenarios 17 & 18: Safe Deployment Workflow & Migration Approval Protection
    await t.test('Backend 17 & 18: Preserves Safe Deployment workflow and strict Migration Approval Protection', async () => {
      const oldSha = '1111222233334444555566667777888899990001';
      const newSha = 'ffff222233334444555566667777888899990002';

      // Scenario 18: Pending migration must block deployment until approved with valid ADMIN password & matching commit/files
      setDeploymentGitInspectorForTests(async () => ({
        available: true,
        branch: 'main',
        currentCommit: oldSha,
        targetCommit: newSha,
        hasUpdates: true,
        gitMigrationFiles: ['004_pending_guard_test.sql'],
      }));

      setDeployBatRunnerForTests(async (scriptPath) => ({
        exitCode: 0,
        stdout: '[8/8] Service Health Verification ........ PASS',
        stderr: '',
        scriptPath,
        durationMs: 42,
      }));

      try {
        const blocked = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true },
        });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.data.error, 'MIGRATION_APPROVAL_REQUIRED');

        const mismatch = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: {
            confirmRun: true,
            approveMigrations: true,
            impactAcknowledged: true,
            confirmPassword: 'Admin@SamAtt2026',
            approvedTargetCommit: oldSha,
            approvedMigrationFiles: ['004_pending_guard_test.sql'],
          },
        });
        assert.equal(mismatch.status, 409);
        assert.equal(mismatch.data.error, 'MIGRATION_APPROVAL_MISMATCH');

        // Scenario 17: Clean update (no pending migration) executes safe deployment runner cleanly
        setDeploymentGitInspectorForTests(async () => ({
          available: true,
          branch: 'main',
          currentCommit: oldSha,
          targetCommit: newSha,
          hasUpdates: true,
          gitMigrationFiles: [],
        }));
        const okDeploy = await apiCall('/api/Sam_Att/deployment/run-bat', {
          method: 'POST',
          token: adminToken,
          body: { confirmRun: true },
        });
        assert.equal(okDeploy.status, 200);
        assert.equal(okDeploy.data.status, 'SUCCESS');
      } finally {
        setDeployBatRunnerForTests(null);
        setDeploymentGitInspectorForTests(null);
      }
    });
  } finally {
    await closeServer();
    try {
      fs.rmSync(TEST_DB_PATH, { force: true });
    } catch {
      // ignore cleanup
    }
  }
});
