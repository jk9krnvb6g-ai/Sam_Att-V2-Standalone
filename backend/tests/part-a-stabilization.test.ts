/**
 * ============================================================================
 * Part A Stabilization & Hardening Regression Suite
 * ไฟล์: backend/tests/part-a-stabilization.test.ts
 * ============================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TEST_RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `sam_att_part_a_${TEST_RUN_ID}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_TEST_ISOLATION = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'part_a_test_jwt_secret_key_min_32_chars_2026';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'part_a_test_scanner_token_min_24_chars';

import {
  resetSqliteInstanceForTests,
  runMigrations,
  ensureBaselineSystemCatalog,
  seedDemoSyntheticData,
  dbQuery,
  dbExecute,
} from '../src/database/adapter.ts';
import { createExpressApp } from '../src/app.ts';
import { evaluateAttendanceLifecycle } from '../src/modules/attendance/lifecycle.ts';
import { setHosOfficeLivePushTestSink } from '../src/modules/hosoffice/routes.ts';
import { getCurrentBangkokDateParts } from '../src/utils/crypto.ts';

let serverUrl = '';

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

test('Part A Stabilization Suite (A1–A5)', async (t) => {
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

  try {
    const adminLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'admin', password: 'Admin@SamAtt2026' },
    });
    assert.equal(adminLogin.status, 200);
    const adminToken: string = adminLogin.data.token;

    const staffLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'hrstaff', password: 'Staff@SamAtt2026' },
    });
    assert.equal(staffLogin.status, 200);
    const staffToken: string = staffLogin.data.token;

    const userLogin = await apiCall('/api/Sam_Att/auth/login', {
      method: 'POST',
      body: { username: 'user1003', password: 'User@SamAtt2026' },
    });
    assert.equal(userLogin.status, 200);
    const generalToken: string = userLogin.data.token;

    // -----------------------------------------------------------------------
    // A1: Attendance Lifecycle Evaluator (Asia/Bangkok)
    // -----------------------------------------------------------------------
    await t.test('A1.1 Lifecycle evaluates NOT_STARTED and AWAITING_CHECKIN with countdown', () => {
      const pre = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        cutoffTime: '17:00',
        checkinWindowBeforeMin: 60,
        referenceNowBkk: '2026-08-10 06:30:00',
      });
      assert.equal(pre.lifecycleState, 'NOT_STARTED');
      assert.equal(pre.isFinalized, false);

      const awaiting = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        cutoffTime: '08:00',
        checkinWindowBeforeMin: 120,
        referenceNowBkk: '2026-08-10 07:45:00',
      });
      assert.equal(awaiting.lifecycleState, 'AWAITING_CHECKIN');
      assert.equal(awaiting.isFinalized, false);
      assert.equal(awaiting.remainingCheckinWindowMinutes, 15);
    });

    await t.test('A1.2 Lifecycle evaluates IN_PROGRESS and LATE_IN_PROGRESS mid-shift', () => {
      const inProg = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        cutoffTime: '17:00',
        checkInTime: '2026-08-10 07:55:00',
        isLate: 0,
        referenceNowBkk: '2026-08-10 11:00:00',
      });
      assert.equal(inProg.lifecycleState, 'IN_PROGRESS');
      assert.equal(inProg.isFinalized, false);
      assert.equal(inProg.isPushEligibleLifecycle, false);
      assert.equal(inProg.remainingShiftMinutes, 300);

      const lateInProg = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        cutoffTime: '17:00',
        checkInTime: '2026-08-10 08:25:00',
        isLate: 1,
        lateMinutes: 25,
        referenceNowBkk: '2026-08-10 11:00:00',
      });
      assert.equal(lateInProg.lifecycleState, 'LATE_IN_PROGRESS');
      assert.equal(lateInProg.isFinalized, false);
      assert.equal(lateInProg.phases.length, 5);
    });

    await t.test('A1.3 Lifecycle evaluates COMPLETE, MISSING_CHECKOUT, NO_SCAN, cross-midnight, holiday, leave', () => {
      const complete = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        checkInTime: '2026-08-10 07:50:00',
        checkOutTime: '2026-08-10 16:05:00',
        status: 'NORMAL',
        referenceNowBkk: '2026-08-10 17:00:00',
      });
      assert.equal(complete.lifecycleState, 'COMPLETE');
      assert.equal(complete.isFinalized, true);
      assert.equal(complete.isPushEligibleLifecycle, true);

      const crossMidnight = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '00:00',
        endTime: '08:00',
        cutoffTime: '09:00',
        isCrossMidnight: 0,
        checkInTime: '2026-08-10 00:02:00',
        referenceNowBkk: '2026-08-10 04:00:00',
      });
      assert.equal(crossMidnight.lifecycleState, 'IN_PROGRESS');

      const missingOut = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        cutoffTime: '17:00',
        checkInTime: '2026-08-10 07:55:00',
        status: 'MISSING_CHECKOUT',
        referenceNowBkk: '2026-08-10 18:00:00',
      });
      assert.equal(missingOut.lifecycleState, 'MISSING_CHECKOUT');
      assert.equal(missingOut.isFinalized, true);

      const noScan = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        startTime: '08:00',
        endTime: '16:00',
        cutoffTime: '17:00',
        status: 'NO_SCAN',
        referenceNowBkk: '2026-08-10 18:00:00',
      });
      assert.equal(noScan.lifecycleState, 'NO_SCAN');

      const holidayOff = evaluateAttendanceLifecycle({
        workDate: '2026-08-12',
        holidayName: 'วันแม่แห่งชาติ',
        holidayPolicy: 'EXEMPT_ALL',
        referenceNowBkk: '2026-08-12 09:00:00',
      });
      assert.equal(holidayOff.lifecycleState, 'OFF_DAY');

      const approvedLeave = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        leaveType: 'HALF_DAY_MORNING',
        status: 'NORMAL',
        checkInTime: '2026-08-10 12:55:00',
        checkOutTime: '2026-08-10 16:05:00',
        referenceNowBkk: '2026-08-10 18:00:00',
      });
      assert.equal(approvedLeave.lifecycleState, 'COMPLETE');

      const fullLeave = evaluateAttendanceLifecycle({
        workDate: '2026-08-10',
        leaveType: 'FULL_DAY',
        referenceNowBkk: '2026-08-10 10:00:00',
      });
      assert.equal(fullLeave.lifecycleState, 'APPROVED_LEAVE');
    });

    // -----------------------------------------------------------------------
    // A2: HOSOffice Push History Alias, Preview Hash & Non-Final Blocking
    // -----------------------------------------------------------------------
    await t.test('A2.1 GET /hosoffice/push-history alias works and enforces RBAC', async () => {
      const denied = await apiCall('/api/Sam_Att/hosoffice/push-history', { token: generalToken });
      assert.equal(denied.status, 403);

      const ok = await apiCall('/api/Sam_Att/hosoffice/push-history', { token: staffToken });
      assert.equal(ok.status, 200);
      assert.ok(Array.isArray(ok.data.items));
    });

    await t.test('A2.2 HOSOffice preview returns previewId + dataHash and detects stale change (409)', async () => {
      const bkk = getCurrentBangkokDateParts();
      const preview1 = await apiCall('/api/Sam_Att/hosoffice/push/preview', {
        method: 'POST',
        token: adminToken,
        body: { dateFrom: bkk.monthStartYmd, dateTo: bkk.monthEndYmd },
      });
      assert.equal(preview1.status, 200);
      assert.ok(preview1.data.previewId);
      assert.ok(preview1.data.dataHash);

      // Insert a non-final IN_PROGRESS row for today and verify preview excludes it & changes hash
      await dbExecute(
        `INSERT INTO attendance (
           person_id, work_date, shift_code, shift_name, scheduled_start, scheduled_end,
           check_in_time, check_out_time, status, attendance_status, is_late, late_minutes, review_status
         ) VALUES ('SAM-P001', ?, 'D1', 'เวรเช้า', ?, ?, ?, NULL, 'IN_PROGRESS', 'IN_PROGRESS', 0, 0, 'PENDING')`,
        [
          bkk.todayYmd,
          `${bkk.todayYmd} 08:00:00`,
          `${bkk.todayYmd} 16:00:00`,
          `${bkk.todayYmd} 07:55:00`,
        ]
      );

      const preview2 = await apiCall('/api/Sam_Att/hosoffice/push/preview', {
        method: 'POST',
        token: adminToken,
        body: { dateFrom: bkk.monthStartYmd, dateTo: bkk.monthEndYmd },
      });
      assert.equal(preview2.status, 200);
      const hasInProgressBlocked = (preview2.data.invalidItems || []).some(
        (item: any) =>
          item.personId === 'SAM-P001' &&
          item.workDate === bkk.todayYmd &&
          typeof item.reason === 'string' &&
          item.reason.includes('IN_PROGRESS')
      );
      assert.ok(hasInProgressBlocked, 'IN_PROGRESS row must be blocked from HOSOffice push');

      // Test stale preview guard when live push is enabled with test sink
      const prevLive = process.env.HOSOFFICE_LIVE_PUSH_ENABLED;
      const prevTable = process.env.HOSOFFICE_PUSH_TARGET_TABLE;
      process.env.HOSOFFICE_LIVE_PUSH_ENABLED = 'true';
      process.env.HOSOFFICE_PUSH_TARGET_TABLE = 'hr_attendance_sync';
      setHosOfficeLivePushTestSink(async (_t, recs) => ({ writtenCount: recs.length }));
      try {
        const staleAttempt = await apiCall('/api/Sam_Att/hosoffice/push', {
          method: 'POST',
          token: adminToken,
          body: {
            dateFrom: bkk.monthStartYmd,
            dateTo: bkk.monthEndYmd,
            idempotencyKey: `LIVE-STALE-${Date.now()}`,
            previewId: preview1.data.previewId,
            dataHash: preview1.data.dataHash,
          },
        });
        assert.equal(staleAttempt.status, 409);
        assert.equal(staleAttempt.data.error, 'PREVIEW_STALE_DATA_CHANGED');
      } finally {
        setHosOfficeLivePushTestSink(null);
        process.env.HOSOFFICE_LIVE_PUSH_ENABLED = prevLive;
        process.env.HOSOFFICE_PUSH_TARGET_TABLE = prevTable;
        await dbExecute(
          "DELETE FROM attendance WHERE person_id = 'SAM-P001' AND work_date = ? AND status = 'IN_PROGRESS'",
          [bkk.todayYmd]
        );
      }
    });

    // -----------------------------------------------------------------------
    // A3: Auth Hardening, User Edit, Last Admin, Reset Password & Forced Change
    // -----------------------------------------------------------------------
    await t.test('A3.1 Reject weak password on create user (400)', async () => {
      const res = await apiCall('/api/Sam_Att/users', {
        method: 'POST',
        token: adminToken,
        body: {
          username: 'weakuser',
          password: 'password',
          displayName: 'Weak User',
          role: 'GENERAL_USER',
        },
      });
      assert.equal(res.status, 400);
    });

    await t.test('A3.2 Cannot disable self or disable/demote last active ADMIN (409)', async () => {
      const usersRes = await apiCall('/api/Sam_Att/users', { token: adminToken });
      assert.equal(usersRes.status, 200);
      const adminRow = (usersRes.data.items || []).find((u: any) => u.username === 'admin');
      assert.ok(adminRow);

      const selfDisable = await apiCall(`/api/Sam_Att/users/${adminRow.id}/status`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: false },
      });
      assert.equal(selfDisable.status, 409);
      assert.equal(selfDisable.data.error, 'CANNOT_DISABLE_SELF');

      const demoteLastAdmin = await apiCall(`/api/Sam_Att/users/${adminRow.id}`, {
        method: 'PUT',
        token: adminToken,
        body: { role: 'RESPONSIBLE_STAFF' },
      });
      assert.equal(demoteLastAdmin.status, 409);
      assert.equal(demoteLastAdmin.data.error, 'LAST_ADMIN_PROTECTED');
    });

    await t.test('A3.3 Partial PUT /users/:id, Reset Password CSPRNG, Forced Password Change Gate, and No Secret in Audit', async () => {
      const created = await apiCall('/api/Sam_Att/users', {
        method: 'POST',
        token: adminToken,
        body: {
          username: 'nurse_test_a3',
          password: 'InitUser@2026',
          displayName: 'พยาบาล ทดสอบ',
          role: 'GENERAL_USER',
          approvedPersonId: 'SAM-P003',
        },
      });
      assert.equal(created.status, 201);
      const targetUserId = created.data.id;

      // Partial PUT without password preserves account & updates displayName
      const updated = await apiCall(`/api/Sam_Att/users/${targetUserId}`, {
        method: 'PUT',
        token: adminToken,
        body: { displayName: 'พยาบาล ทดสอบ (แก้ไข)' },
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.data.displayName, 'พยาบาล ทดสอบ (แก้ไข)');

      // Non-existent ID returns 404
      const notFound = await apiCall('/api/Sam_Att/users/999999', {
        method: 'PUT',
        token: adminToken,
        body: { displayName: 'Missing' },
      });
      assert.equal(notFound.status, 404);

      // Reset password returns one-time CSPRNG temporary password and sets mustChangePassword = 1
      const resetRes = await apiCall(`/api/Sam_Att/users/${targetUserId}/reset-password`, {
        method: 'POST',
        token: adminToken,
      });
      assert.equal(resetRes.status, 200);
      const tempPw: string = resetRes.data.temporaryPassword;
      assert.ok(typeof tempPw === 'string' && tempPw.length >= 12);
      assert.equal(resetRes.data.mustChangePassword, true);

      // Login with temporary password -> mustChangePassword = true
      const tempLogin = await apiCall('/api/Sam_Att/auth/login', {
        method: 'POST',
        body: { username: 'nurse_test_a3', password: tempPw },
      });
      assert.equal(tempLogin.status, 200);
      assert.equal(tempLogin.data.user.mustChangePassword, true);
      const lockedToken: string = tempLogin.data.token;

      // Accessing regular endpoints while mustChangePassword=true -> 403 PASSWORD_CHANGE_REQUIRED
      const blockedMe = await apiCall('/api/Sam_Att/me/attendance', { token: lockedToken });
      assert.equal(blockedMe.status, 403);
      assert.equal(blockedMe.data.error, 'PASSWORD_CHANGE_REQUIRED');

      // Weak new password rejected
      const weakChange = await apiCall('/api/Sam_Att/auth/change-password', {
        method: 'POST',
        token: lockedToken,
        body: { currentPassword: tempPw, newPassword: 'password' },
      });
      assert.equal(weakChange.status, 400);

      // Valid password change unlocks session
      const newPw = 'UpdatedNurse@2026!';
      const goodChange = await apiCall('/api/Sam_Att/auth/change-password', {
        method: 'POST',
        token: lockedToken,
        body: { currentPassword: tempPw, newPassword: newPw },
      });
      assert.equal(goodChange.status, 200);
      assert.equal(goodChange.data.mustChangePassword, false);

      const unlockedMe = await apiCall('/api/Sam_Att/me/attendance', { token: lockedToken });
      assert.equal(unlockedMe.status, 200);

      // Verify neither temporaryPassword nor newPassword appears anywhere in audit_logs
      const logs = await dbQuery<{ detail_json: string | null }>(
        'SELECT detail_json FROM audit_logs ORDER BY id DESC LIMIT 30'
      );
      for (const row of logs) {
        const txt = String(row.detail_json || '');
        assert.ok(!txt.includes(tempPw), 'Temporary password leaked to audit_logs!');
        assert.ok(!txt.includes(newPw), 'New password leaked to audit_logs!');
      }
    });

    // -----------------------------------------------------------------------
    // A4: Raw Scans Server Pagination (> 200 records)
    // -----------------------------------------------------------------------
    await t.test('A4.1 GET /raw-scans supports true server pagination beyond 200 rows', async () => {
      for (let i = 0; i < 215; i++) {
        const hh = String(Math.floor(i / 60) + 6).padStart(2, '0');
        const mm = String(i % 60).padStart(2, '0');
        const ts = `2026-05-01 ${hh}:${mm}:00`;
        const key = `part_a_pag_${i}_${TEST_RUN_ID}`;
        await dbExecute(
          `INSERT INTO raw_scans (
             event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
             verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state
           ) VALUES (?, 1, '99100', ?, ?, 1, 0, 0, '{}', NULL, 'IMMUTABLE_RAW')`,
          [key, ts, ts]
        );
      }

      const page3 = await apiCall(
        '/api/Sam_Att/raw-scans?dateFrom=2026-05-01&dateTo=2026-05-01&search=99100&page=3&pageSize=50',
        { token: staffToken }
      );
      assert.equal(page3.status, 200);
      assert.equal(page3.data.totalCount, 215);
      assert.equal(page3.data.page, 3);
      assert.equal(page3.data.pageSize, 50);
      assert.equal(page3.data.totalPages, 5);
      assert.equal(page3.data.items.length, 50);
    });

    // -----------------------------------------------------------------------
    // A5: Paginated Attendance, Tab Counts, Today Summary & Own-Only RBAC
    // -----------------------------------------------------------------------
    await t.test('A5.1 GET /attendance & /attendance-review return paginated items and tabCounts', async () => {
      const bkk = getCurrentBangkokDateParts();
      const attPage = await apiCall(
        `/api/Sam_Att/attendance?dateFrom=${bkk.monthStartYmd}&dateTo=${bkk.monthEndYmd}&page=1&pageSize=5`,
        { token: staffToken }
      );
      assert.equal(attPage.status, 200);
      assert.ok(attPage.data.tabCounts);
      assert.equal(typeof attPage.data.tabCounts.all, 'number');
      assert.ok(attPage.data.items.length <= 5);

      const revPage = await apiCall(
        `/api/Sam_Att/attendance-review?dateFrom=${bkk.monthStartYmd}&dateTo=${bkk.monthEndYmd}&reviewStatus=PENDING&page=1&pageSize=10`,
        { token: staffToken }
      );
      assert.equal(revPage.status, 200);
      assert.ok(revPage.data.tabCounts);
    });

    await t.test('A5.2 GET /dashboard/summary includes todaySummary & breakdown KPIs; GENERAL_USER gets 403', async () => {
      const denied = await apiCall('/api/Sam_Att/dashboard/summary', { token: generalToken });
      assert.equal(denied.status, 403);

      const bkk = getCurrentBangkokDateParts();
      const res = await apiCall(
        `/api/Sam_Att/dashboard/summary?dateFrom=${bkk.monthStartYmd}&dateTo=${bkk.monthEndYmd}`,
        { token: staffToken }
      );
      assert.equal(res.status, 200);
      assert.ok(res.data.todaySummary);
      assert.equal(res.data.todaySummary.workDate, bkk.todayYmd);
      assert.equal(typeof res.data.kpi.lateOnlyCount, 'number');
      assert.equal(typeof res.data.kpi.inProgressCount, 'number');
    });
  } finally {
    await new Promise<void>((resolve) => {
      if (typeof (srv as any).closeAllConnections === 'function') {
        (srv as any).closeAllConnections();
      }
      srv.close(() => resolve());
    });
    resetSqliteInstanceForTests(':memory:');
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    } catch {
      // ignore cleanup error
    }
  }
});
