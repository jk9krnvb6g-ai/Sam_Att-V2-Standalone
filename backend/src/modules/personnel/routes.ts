import { Router } from 'express';
import mysql from 'mysql2/promise';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export interface HosOfficeHrPersonRow {
  PERSON_ID: string;
  FINGLE_ID: string | null;
  TITLE_NAME?: string | null;
  FIRST_NAME: string;
  LAST_NAME: string;
  POSITION_NAME?: string | null;
  DEPARTMENT_CODE?: string | null;
  DEPARTMENT_NAME: string;
  WORK_GROUP_NAME?: string | null;
  PERSONNEL_TYPE_CODE: string;
  PERSONNEL_TYPE_NAME: string;
  IS_ACTIVE: number;
}

// Test Double hook strictly for automated integration tests (never enabled automatically in production)
let testDoubleHosOfficeRows: HosOfficeHrPersonRow[] | null = null;
let testDoubleForceOffline = false;

export function setHosOfficeTestDouble(rows: HosOfficeHrPersonRow[] | null, forceOffline = false): void {
  testDoubleHosOfficeRows = rows;
  testDoubleForceOffline = forceOffline;
}

/**
 * Fetches hr_person rows from HOSOffice Read-Only MySQL database.
 * Fails closed if HOSOFFICE_DB_HOST is unconfigured ('CHANGE_ME') or unreachable.
 */
async function fetchFromHosOfficeReadOnly(): Promise<HosOfficeHrPersonRow[]> {
  if (testDoubleForceOffline) {
    const err = new Error('HOSOffice MySQL Server Unreachable (Simulated Offline)');
    (err as Error & { code?: string }).code = 'HOSOFFICE_DB_UNAVAILABLE';
    throw err;
  }

  if (testDoubleHosOfficeRows !== null) {
    return testDoubleHosOfficeRows;
  }

  const cfg = loadConfig();
  if (!cfg.hosofficeDb.host || cfg.hosofficeDb.host === 'CHANGE_ME') {
    const err = new Error(
      'BLOCKED_BY_EXTERNAL_CONTRACT: ยังไม่ได้ตั้งค่า HOSOFFICE_DB_HOST และสิทธิ์ Read-only สำหรับตาราง hr_person (ห้ามจำลองผลสำเร็จ)'
    );
    (err as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
    throw err;
  }

  const conn = await mysql.createConnection({
    host: cfg.hosofficeDb.host,
    port: cfg.hosofficeDb.port,
    user: cfg.hosofficeDb.user,
    password: cfg.hosofficeDb.password,
    database: cfg.hosofficeDb.database,
    charset: 'utf8mb4',
    connectTimeout: 4000,
  });

  try {
    await conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
    const table = cfg.hosofficeDb.hrPersonTable.replace(/[^a-zA-Z0-9_]/g, '');
    const [rows] = await conn.query(
      `SELECT PERSON_ID, FINGLE_ID, TITLE_NAME, FIRST_NAME, LAST_NAME,
              POSITION_NAME, DEPARTMENT_CODE, DEPARTMENT_NAME, WORK_GROUP_NAME,
              PERSONNEL_TYPE_CODE, PERSONNEL_TYPE_NAME, IS_ACTIVE
       FROM ${table}`
    );
    return rows as HosOfficeHrPersonRow[];
  } finally {
    await conn.end();
  }
}

export const personnelRouter = Router();

personnelRouter.get(
  '/personnel',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const search = String(req.query.search || '').trim();
      const department = String(req.query.department || '').trim();
      const personnelType = String(req.query.personnelType || '').trim();
      const mappingStatus = String(req.query.mappingStatus || '').trim();

      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];

      if (search) {
        conditions.push('(person_id LIKE ? OR full_name LIKE ? OR fingle_id LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }
      if (department) {
        conditions.push('department_name = ?');
        params.push(department);
      }
      if (personnelType) {
        conditions.push('personnel_type_code = ?');
        params.push(personnelType);
      }
      if (mappingStatus) {
        conditions.push('mapping_status = ?');
        params.push(mappingStatus);
      }

      const items = await dbQuery(
        `SELECT * FROM personnel WHERE ${conditions.join(' AND ')} ORDER BY person_id ASC`,
        params
      );

      const syncLogs = await dbQuery(
        'SELECT * FROM hosoffice_sync_logs ORDER BY id DESC LIMIT 10'
      );

      res.json({ items, syncLogs });
    } catch (err) {
      next(err);
    }
  }
);

personnelRouter.get(
  '/personnel/mapping-issues',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const personnelIssues = await dbQuery(
        "SELECT * FROM personnel WHERE mapping_status != 'VALID' ORDER BY person_id ASC"
      );
      const mappingHistory = await dbQuery(
        `SELECT fm.*, p.full_name, p.department_name
         FROM fingerprint_mappings fm
         LEFT JOIN personnel p ON p.person_id = fm.person_id
         ORDER BY fm.id DESC`
      );
      const unmatchedRawScans = await dbQuery(
        `SELECT rs.enroll_number, COUNT(*) as scan_count,
                MIN(rs.canonical_bkk_time) as first_seen,
                MAX(rs.canonical_bkk_time) as last_seen
         FROM raw_scans rs
         LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
         WHERE COALESCE(rsm.mapping_state, 'UNMATCHED') != 'MATCHED'
         GROUP BY rs.enroll_number`
      );

      res.json({
        personnelIssues,
        mappingHistory,
        unmatchedRawScans,
      });
    } catch (err) {
      next(err);
    }
  }
);

personnelRouter.post(
  '/personnel/sync',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    const actor = req.user!.username;
    const effectiveDate = String(req.body?.effectiveDate || new Date().toISOString().slice(0, 10));

    try {
      const externalRows = await fetchFromHosOfficeReadOnly();

      // Detect duplicate FINGLE_ID across active personnel in the incoming batch
      const activeFingleCounts = new Map<string, string[]>();
      for (const row of externalRows) {
        const fid = row.FINGLE_ID ? String(row.FINGLE_ID).trim() : '';
        if (fid && Number(row.IS_ACTIVE) === 1) {
          const list = activeFingleCounts.get(fid) || [];
          list.push(row.PERSON_ID);
          activeFingleCounts.set(fid, list);
        }
      }

      let upsertedCount = 0;
      let conflictsFound = 0;

      for (const row of externalRows) {
        const personId = String(row.PERSON_ID).trim();
        const fingleId = row.FINGLE_ID ? String(row.FINGLE_ID).trim() : null;
        const fullName = `${row.TITLE_NAME || ''}${row.FIRST_NAME} ${row.LAST_NAME}`.trim();

        let mappingStatus = 'VALID';
        let issueDetail: string | null = null;

        if (!fingleId) {
          mappingStatus = 'EMPTY_FINGLE_ID';
          issueDetail = 'ไม่พบรหัส FINGLE_ID ในฐานข้อมูล HOSOffice (hr_person)';
          conflictsFound++;
        } else {
          const claimants = activeFingleCounts.get(fingleId) || [];
          if (claimants.length > 1) {
            mappingStatus = 'DUPLICATE_FINGLE_ID';
            issueDetail = `รหัส FINGLE_ID ${fingleId} ซ้ำกันระหว่างบุคลากร: ${claimants.join(', ')}`;
            conflictsFound++;
          }
        }

        const existing = await dbQuery<{ person_id: string; fingle_id: string | null }>(
          'SELECT person_id, fingle_id FROM personnel WHERE person_id = ? LIMIT 1',
          [personId]
        );

        if (existing.length === 0) {
          await dbExecute(
            `INSERT INTO personnel (
              person_id, fingle_id, title_name, first_name, last_name, full_name,
              position_name, department_code, department_name, work_group_name,
              personnel_type_code, personnel_type_name, is_active, mapping_status, mapping_issue_detail, last_synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
            [
              personId,
              fingleId,
              row.TITLE_NAME || null,
              row.FIRST_NAME,
              row.LAST_NAME,
              fullName,
              row.POSITION_NAME || null,
              row.DEPARTMENT_CODE || null,
              row.DEPARTMENT_NAME,
              row.WORK_GROUP_NAME || null,
              row.PERSONNEL_TYPE_CODE,
              row.PERSONNEL_TYPE_NAME,
              Number(row.IS_ACTIVE) ? 1 : 0,
              mappingStatus,
              issueDetail,
            ]
          );
        } else {
          await dbExecute(
            `UPDATE personnel
             SET fingle_id = ?, title_name = ?, first_name = ?, last_name = ?, full_name = ?,
                 position_name = ?, department_code = ?, department_name = ?, work_group_name = ?,
                 personnel_type_code = ?, personnel_type_name = ?, is_active = ?,
                 mapping_status = ?, mapping_issue_detail = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE person_id = ?`,
            [
              fingleId,
              row.TITLE_NAME || null,
              row.FIRST_NAME,
              row.LAST_NAME,
              fullName,
              row.POSITION_NAME || null,
              row.DEPARTMENT_CODE || null,
              row.DEPARTMENT_NAME,
              row.WORK_GROUP_NAME || null,
              row.PERSONNEL_TYPE_CODE,
              row.PERSONNEL_TYPE_NAME,
              Number(row.IS_ACTIVE) ? 1 : 0,
              mappingStatus,
              issueDetail,
              personId,
            ]
          );
        }
        upsertedCount++;

        // Maintain effective-dated fingerprint_mappings without corrupting historical mappings
        if (fingleId) {
          const conflictState = mappingStatus === 'DUPLICATE_FINGLE_ID' ? 'DUPLICATE_CONFLICT' : 'NONE';
          const activeMappings = await dbQuery<{ id: number; fingle_id: string }>(
            'SELECT id, fingle_id FROM fingerprint_mappings WHERE person_id = ? AND effective_to IS NULL',
            [personId]
          );

          const sameMapping = activeMappings.find((m) => m.fingle_id === fingleId);
          if (!sameMapping) {
            // Close previous open mapping as of day before effectiveDate
            for (const oldMap of activeMappings) {
              await dbExecute(
                'UPDATE fingerprint_mappings SET effective_to = ? WHERE id = ?',
                [effectiveDate, oldMap.id]
              );
            }
            await dbExecute(
              `INSERT INTO fingerprint_mappings (
                person_id, fingle_id, effective_from, effective_to, conflict_state, conflict_reason, source, created_by
              ) VALUES (?, ?, ?, NULL, ?, ?, 'HOSOFFICE_SYNC', ?)`,
              [personId, fingleId, effectiveDate, conflictState, issueDetail, actor]
            );
          } else {
            await dbExecute(
              'UPDATE fingerprint_mappings SET conflict_state = ?, conflict_reason = ? WHERE id = ?',
              [conflictState, issueDetail, sameMapping.id]
            );
          }
        }
      }

      await dbExecute(
        `INSERT INTO hosoffice_sync_logs (
          finished_at, status, records_fetched, records_upserted, mapping_conflicts_found, triggered_by
        ) VALUES (CURRENT_TIMESTAMP, 'SUCCESS', ?, ?, ?, ?)`,
        [externalRows.length, upsertedCount, conflictsFound, actor]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: actor,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOSOFFICE_PERSONNEL_SYNC',
        targetType: 'HOSOFFICE_HR_PERSON',
        result: 'SUCCESS',
        detail: {
          recordsFetched: externalRows.length,
          upsertedCount,
          conflictsFound,
          effectiveDate,
        },
      });

      res.json({
        status: 'SUCCESS',
        recordsFetched: externalRows.length,
        recordsUpserted: upsertedCount,
        mappingConflictsFound: conflictsFound,
        effectiveDate,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || 'HOSOFFICE_SYNC_FAILED';
      const message = err instanceof Error ? err.message : String(err);

      await dbExecute(
        `INSERT INTO hosoffice_sync_logs (
          finished_at, status, records_fetched, records_upserted, mapping_conflicts_found,
          error_code, error_message, triggered_by
        ) VALUES (CURRENT_TIMESTAMP, 'FAILED', 0, 0, 0, ?, ?, ?)`,
        [code, message, actor]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: actor,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOSOFFICE_PERSONNEL_SYNC',
        targetType: 'HOSOFFICE_HR_PERSON',
        result: 'FAILURE',
        errorCode: code,
        detail: { message },
      });

      res.status(503).json({
        error: code,
        message,
        failClosed: true,
        requestId: req.requestId,
      });
    }
  }
);
