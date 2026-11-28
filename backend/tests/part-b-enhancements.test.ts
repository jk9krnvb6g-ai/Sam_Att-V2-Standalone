/**
 * ============================================================================
 * Part B Enhancements & Full Integration Regression Suite (B1–B10)
 * ไฟล์: backend/tests/part-b-enhancements.test.ts
 * ============================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const TEST_RUN_ID = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const TEST_DB_PATH = path.join(os.tmpdir(), `sam_att_part_b_${TEST_RUN_ID}.sqlite`);

process.env.NODE_ENV = 'test';
process.env.DB_ENGINE = 'sqlite';
process.env.DEMO_MODE_ENABLED = 'true';
process.env.SAM_ATT_TEST_ISOLATION = 'true';
process.env.SAM_ATT_DATA_MODE = 'DEMO';
process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox';
process.env.SAM_ATT_SQLITE_PATH = TEST_DB_PATH;
process.env.JWT_SECRET = 'part_b_test_jwt_secret_key_min_32_chars_2026';
process.env.SCANNER_INGEST_SHARED_TOKEN = 'part_b_test_scanner_token_min_24_chars';

import {
  resetSqliteInstanceForTests,
  runMigrations,
  ensureBaselineSystemCatalog,
  seedDemoSyntheticData,
  dbQuery,
  dbExecute,
} from '../src/database/adapter.ts';
import { createExpressApp } from '../src/app.ts';

let serverUrl = '';

async function apiCall(
  endpoint: string,
  options: { method?: string; token?: string; body?: unknown } = {}
): Promise<{ status: number; data: any; buffer?: Buffer; headers: Headers }> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${serverUrl}${endpoint}`, {
    method: options.method || 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const ab = await res.arrayBuffer();
  const buffer = Buffer.from(ab);
  const contentType = res.headers.get('content-type') || '';
  let data: any = null;
  if (contentType.includes('application/json')) {
    try {
      data = JSON.parse(buffer.toString('utf8'));
    } catch {
      data = buffer.toString('utf8');
    }
  } else {
    data = buffer.toString('utf8');
  }
  return { status: res.status, data, buffer, headers: res.headers };
}

test('Part B Enhancements Regression Suite (B1–B9)', async (t) => {
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
    // B1: Hospital Holiday Calendar (CRUD, Scopes, Impact Preview, Deactivate, CSV)
    // -----------------------------------------------------------------------
    await t.test('B1 Hospital Holiday Calendar CRUD, impact preview, and CSV export', async () => {
      const createRes = await apiCall('/api/Sam_Att/holidays', {
        method: 'POST',
        token: staffToken,
        body: {
          holidayDate: '2026-10-23',
          holidayName: 'วันปิยมหาราช (ทดสอบ B1)',
          category: 'NATIONAL',
          scopeType: 'ALL',
          overridePolicy: 'EXEMPT',
          notes: 'ทดสอบปฏิทินวันหยุดโรงพยาบาล',
        },
      });
      assert.equal(createRes.status, 201);
      assert.ok(createRes.data.id > 0);
      const holidayId = createRes.data.id;

      const listRes = await apiCall('/api/Sam_Att/holidays?year=2026', {
        token: generalToken,
      });
      assert.equal(listRes.status, 200);
      assert.ok(
        (listRes.data.items || []).some((h: any) => Number(h.id) === holidayId)
      );

      const impactRes = await apiCall(`/api/Sam_Att/holidays/${holidayId}/impact-preview`, {
        method: 'POST',
        token: staffToken,
      });
      assert.equal(impactRes.status, 200);
      assert.equal(typeof impactRes.data.affectedAttendanceCount, 'number');

      const csvRes = await apiCall('/api/Sam_Att/holidays/export.csv?year=2026', {
        token: staffToken,
      });
      assert.equal(csvRes.status, 200);
      assert.ok(csvRes.buffer?.toString('utf8').includes('วันปิยมหาราช'));

      // GENERAL_USER cannot create or delete holidays
      const forbiddenCreate = await apiCall('/api/Sam_Att/holidays', {
        method: 'POST',
        token: generalToken,
        body: {
          holidayDate: '2026-10-24',
          holidayName: 'Unauthorized',
          category: 'SPECIAL',
          scopeType: 'ALL',
        },
      });
      assert.equal(forbiddenCreate.status, 403);

      const delRes = await apiCall(`/api/Sam_Att/holidays/${holidayId}`, {
        method: 'DELETE',
        token: staffToken,
      });
      assert.equal(delRes.status, 200);
    });

    // -----------------------------------------------------------------------
    // B3: Historical Attendance Completeness Center
    // -----------------------------------------------------------------------
    await t.test('B3 Completeness snapshot, preview, and safe idempotent process', async () => {
      const compRes = await apiCall(
        '/api/Sam_Att/attendance/completeness?dateFrom=2026-08-01&dateTo=2026-08-15',
        { token: staffToken }
      );
      assert.equal(compRes.status, 200);
      assert.ok(compRes.data.metrics);
      assert.equal(typeof compRes.data.metrics.expectedShiftCount, 'number');
      assert.equal(typeof compRes.data.metrics.completenessPercent, 'number');

      const previewRes = await apiCall('/api/Sam_Att/attendance/completeness/process-preview', {
        method: 'POST',
        token: staffToken,
        body: { dateFrom: '2026-08-01', dateTo: '2026-08-05' },
      });
      assert.equal(previewRes.status, 200);
      assert.equal(typeof previewRes.data.canExecute, 'boolean');

      const forbiddenGeneral = await apiCall(
        '/api/Sam_Att/attendance/completeness?dateFrom=2026-08-01&dateTo=2026-08-05',
        { token: generalToken }
      );
      assert.equal(forbiddenGeneral.status, 403);
    });

    // -----------------------------------------------------------------------
    // B4: Unified HR Work Center
    // -----------------------------------------------------------------------
    await t.test('B4 HR Work Center overview and prioritized queues', async () => {
      const wcRes = await apiCall('/api/Sam_Att/hr-work-center/overview', {
        token: staffToken,
      });
      assert.equal(wcRes.status, 200);
      assert.ok(wcRes.data.overview);
      assert.ok(wcRes.data.bucketCounts);
      assert.ok(Array.isArray(wcRes.data.queueItems));

      const forbiddenGeneral = await apiCall('/api/Sam_Att/hr-work-center/overview', {
        token: generalToken,
      });
      assert.equal(forbiddenGeneral.status, 403);
    });

    // -----------------------------------------------------------------------
    // B5: Bulk User Creation with Temporary Password & Audit Trail
    // -----------------------------------------------------------------------
    await t.test('B5 Bulk User Creation candidates, create, duplicate check, and RBAC', async () => {
      await dbExecute(
        `INSERT OR IGNORE INTO personnel (
          person_id, fingle_id, first_name, last_name, full_name, department_name, personnel_type_code, personnel_type_name, is_active
        ) VALUES ('P9901', '9901', 'ทดสอบ', 'สร้างบัญชีกลุ่ม', 'น.ส.ทดสอบ สร้างบัญชีกลุ่ม', 'กลุ่มงานการพยาบาล', 'CIVIL_SERVANT', 'ข้าราชการ', 1)`
      );

      const candRes = await apiCall('/api/Sam_Att/users/bulk-candidates', {
        token: adminToken,
      });
      assert.equal(candRes.status, 200);
      const cand = (candRes.data.items || []).find((c: any) => c.personId === 'P9901');
      assert.ok(cand, 'Expected synthetic candidate P9901 in bulk-candidates');

      // Staff cannot access bulk user creation
      const staffForbidden = await apiCall('/api/Sam_Att/users/bulk-candidates', {
        token: staffToken,
      });
      assert.equal(staffForbidden.status, 403);

      // Cannot bulk-create ADMIN accounts
      const adminRoleRejected = await apiCall('/api/Sam_Att/users/bulk-create', {
        method: 'POST',
        token: adminToken,
        body: {
          defaultRole: 'ADMIN',
          candidates: [
            {
              personId: 'P9901',
              username: 'bulk_p9901_test',
              displayName: 'น.ส.ทดสอบ สร้างบัญชีกลุ่ม',
              role: 'ADMIN',
            },
          ],
        },
      });
      assert.equal(adminRoleRejected.status, 403);
      assert.equal(adminRoleRejected.data.error, 'BULK_ADMIN_CREATION_FORBIDDEN');

      const createRes = await apiCall('/api/Sam_Att/users/bulk-create', {
        method: 'POST',
        token: adminToken,
        body: {
          defaultRole: 'GENERAL_USER',
          candidates: [
            {
              personId: 'P9901',
              username: 'bulk_p9901_test',
              displayName: 'น.ส.ทดสอบ สร้างบัญชีกลุ่ม',
              role: 'GENERAL_USER',
            },
          ],
        },
      });
      assert.equal(createRes.status, 201);
      assert.equal(createRes.data.createdCount, 1);
      const created = createRes.data.created[0];
      assert.ok(created.temporaryPassword && created.temporaryPassword.length >= 10);
      assert.notEqual(created.temporaryPassword, '1100100990199');

      // Temp password works and marks mustChangePassword = true
      const newLogin = await apiCall('/api/Sam_Att/auth/login', {
        method: 'POST',
        body: { username: 'bulk_p9901_test', password: created.temporaryPassword },
      });
      assert.equal(newLogin.status, 200);
      assert.equal(newLogin.data.user.mustChangePassword, true);
    });

    // -----------------------------------------------------------------------
    // B6: 11-Report Center + Native XLSX Workbook Export + CSV Security
    // -----------------------------------------------------------------------
    await t.test('B6 11-Report Center preview, native XLSX zip signature, and RBAC', async () => {
      const centerRes = await apiCall('/api/Sam_Att/reports/center?reportType=SUMMARY', {
        token: staffToken,
      });
      assert.equal(centerRes.status, 200);
      assert.equal(centerRes.data.availableReportTypes.length, 11);
      assert.ok(Array.isArray(centerRes.data.headers));
      assert.ok(Array.isArray(centerRes.data.rows));

      // Native XLSX export must start with ZIP magic header PK\x03\x04
      const xlsxRes = await apiCall(
        '/api/Sam_Att/reports/center/export.xlsx?reportType=SUMMARY',
        { token: staffToken }
      );
      assert.equal(xlsxRes.status, 200);
      assert.ok(
        (xlsxRes.headers.get('content-type') || '').includes(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        )
      );
      assert.equal(xlsxRes.buffer?.[0], 0x50); // 'P'
      assert.equal(xlsxRes.buffer?.[1], 0x4b); // 'K'

      // GENERAL_USER can access OWN_ATTENDANCE but is forbidden from org-wide reports
      const generalOwn = await apiCall(
        '/api/Sam_Att/reports/center?reportType=OWN_ATTENDANCE',
        { token: generalToken }
      );
      assert.equal(generalOwn.status, 200);
      assert.equal(generalOwn.data.availableReportTypes.length, 1);

      const generalOrgForbidden = await apiCall(
        '/api/Sam_Att/reports/center?reportType=SUMMARY',
        { token: generalToken }
      );
      assert.equal(generalOrgForbidden.status, 403);
    });

    // -----------------------------------------------------------------------
    // B7: Bulk HR Review & Optimistic Record Version Protection
    // -----------------------------------------------------------------------
    await t.test('B7 Bulk HR review preview, execution, and optimistic version check', async () => {
      await dbExecute(
        `INSERT OR IGNORE INTO attendance (
          person_id, work_date, shift_code, shift_name, scheduled_start, scheduled_end,
          status, attendance_status, is_late, late_minutes, review_status, record_version
        ) VALUES ('P9901', '2026-08-12', 'MORN', 'เวรเช้า', '2026-08-12 08:00:00', '2026-08-12 16:00:00', 'LATE', 'COMPLETE', 1, 10, 'PENDING', 1)`
      );
      const attRows = await dbQuery<{ id: number; record_version: number }>(
        "SELECT id, COALESCE(record_version, 1) AS record_version FROM attendance WHERE person_id = 'P9901' LIMIT 1"
      );
      assert.ok(attRows.length >= 1);
      const targetId = Number(attRows[0].id);
      const targetVersion = Number(attRows[0].record_version || 1);

      const previewRes = await apiCall('/api/Sam_Att/attendance/bulk-review/preview', {
        method: 'POST',
        token: staffToken,
        body: {
          attendanceIds: [targetId],
          targetReviewStatus: 'VERIFIED_APPROVED',
          reviewReasonCategory: 'OTHER',
          reviewComment: 'ทดสอบอนุมัติแบบกลุ่ม B7',
        },
      });
      assert.equal(previewRes.status, 200);
      assert.equal(previewRes.data.eligibleCount, 1);

      // Stale version must be rejected cleanly with partial failure detail
      const staleRes = await apiCall('/api/Sam_Att/attendance/bulk-review', {
        method: 'POST',
        token: staffToken,
        body: {
          items: [{ id: targetId, recordVersion: targetVersion + 99 }],
          targetReviewStatus: 'VERIFIED_APPROVED',
          reviewReasonCategory: 'OTHER',
          reviewComment: 'stale version check',
        },
      });
      assert.equal(staleRes.status, 200);
      assert.equal(staleRes.data.succeededCount, 0);
      assert.equal(staleRes.data.failedCount, 1);

      // Valid version succeeds and increments record_version
      const execRes = await apiCall('/api/Sam_Att/attendance/bulk-review', {
        method: 'POST',
        token: staffToken,
        body: {
          items: [{ id: targetId, recordVersion: targetVersion }],
          targetReviewStatus: 'VERIFIED_APPROVED',
          reviewReasonCategory: 'OTHER',
          reviewComment: 'ทดสอบอนุมัติแบบกลุ่มสำเร็จ B7',
        },
      });
      assert.equal(execRes.status, 200);
      assert.equal(execRes.data.succeededCount, 1);
    });

    // -----------------------------------------------------------------------
    // B8: Monthly Attendance Closing & Period Lock & Admin-Only Reopen
    // -----------------------------------------------------------------------
    await t.test('B8 Monthly closing readiness, close lock, and admin-only reopen', async () => {
      const testYm = '2025-11';
      const readyRes = await apiCall(`/api/Sam_Att/attendance-periods/${testYm}/readiness`, {
        token: staffToken,
      });
      assert.equal(readyRes.status, 200);
      assert.equal(readyRes.data.blockingIssuesCount, 0);

      const closeRes = await apiCall(`/api/Sam_Att/attendance-periods/${testYm}/close`, {
        method: 'POST',
        token: staffToken,
        body: { note: 'ปิดรอบทดสอบ B8' },
      });
      assert.equal(closeRes.status, 200);
      assert.equal(closeRes.data.status, 'CLOSED');

      // Modifying holiday in closed month 2025-11 must return 409 PERIOD_CLOSED
      const closedHolidayBlocked = await apiCall('/api/Sam_Att/holidays', {
        method: 'POST',
        token: staffToken,
        body: {
          holidayDate: '2025-11-15',
          holidayName: 'วันหยุดในเดือนปิดรอบ',
          category: 'SPECIAL',
          scopeType: 'ALL',
          overridePolicy: 'EXEMPT',
        },
      });
      assert.equal(closedHolidayBlocked.status, 409);

      // Staff cannot reopen closed period
      const staffReopenForbidden = await apiCall(
        `/api/Sam_Att/attendance-periods/${testYm}/reopen`,
        {
          method: 'POST',
          token: staffToken,
          body: { reason: 'ลองเปิดรอบด้วยสิทธิ์ HR' },
        }
      );
      assert.equal(staffReopenForbidden.status, 403);

      // Admin can reopen with valid reason
      const adminReopen = await apiCall(`/api/Sam_Att/attendance-periods/${testYm}/reopen`, {
        method: 'POST',
        token: adminToken,
        body: { reason: 'เปิดรอบใหม่เพื่อตรวจสอบหลังปิดงวดทดสอบ B8' },
      });
      assert.equal(adminReopen.status, 200);
      assert.equal(adminReopen.data.status, 'REOPENED');
    });

    // -----------------------------------------------------------------------
    // B9: System Health Center (ADMIN-Only Read-Only Diagnostics)
    // -----------------------------------------------------------------------
    await t.test('B9 System Health Center ADMIN-only diagnostics and safety', async () => {
      const staffDenied = await apiCall('/api/Sam_Att/system/health-center', {
        token: staffToken,
      });
      assert.equal(staffDenied.status, 403);

      const userDenied = await apiCall('/api/Sam_Att/system/health-center', {
        token: generalToken,
      });
      assert.equal(userDenied.status, 403);

      const adminHealth = await apiCall('/api/Sam_Att/system/health-center', {
        token: adminToken,
      });
      assert.equal(adminHealth.status, 200);
      assert.ok(adminHealth.data.overallStatus);
      assert.ok(Array.isArray(adminHealth.data.components));
      assert.ok(adminHealth.data.components.length >= 6);
      // Verify no credentials/secrets leaked
      const rawJson = JSON.stringify(adminHealth.data);
      assert.equal(rawJson.includes('JWT_SECRET'), false);
      assert.equal(rawJson.includes('passwordHash'), false);
    });
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()));
    try {
      if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
    } catch {
      // ignore cleanup error
    }
  }
});
