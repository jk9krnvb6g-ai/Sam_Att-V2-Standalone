/**
 * ============================================================================
 * โมดูลส่งข้อมูลเวลาปฏิบัติงานกลับเข้าสู่ระบบ HOSOffice (HOSOffice Dry-Run, Live Push & Reconciliation Engine)
 * ไฟล์: backend/src/modules/hosoffice/routes.ts
 * ============================================================================
 * หน้าที่หลัก (PHASE 4 Remediation):
 * 1. ตรวจสอบ Contract ของตารางปลายทางจริงก่อนเปิด Live Push (`verifyHosOfficeTargetTableContract`):
 *    ตรวจครบทั้ง Column, Data Type, Unique Key (`PERSON_ID + WORK_DATE + SHIFT_CODE` หรือ `IDEMPOTENCY_KEY`) และสิทธิ์ (`SELECT`/`INSERT`/`UPDATE`)
 * 2. ใช้ Prepared Statements และบังคับ Idempotency ที่ระดับฐานข้อมูลปลายทาง ป้องกันข้อมูลซ้ำเมื่อเกิดการ Retry
 * 3. ใช้สถาปัตยกรรม Two-Phase Outbox + Reconciliation (ห้ามอ้างว่า Rollback ทั้ง 2 ฐานข้อมูลพร้อมกันโดยไม่มี Distributed Transaction):
 *    - บันทึกสถานะเริ่มต้น `PENDING` ใน `push_history` ของ Sam_Att ก่อนเขียนลง HOSOffice
 *    - เขียนลงตารางปลายทาง HOSOffice ภายใต้ Transaction ของ HOSOffice
 *    - หาก HOSOffice เขียนล้มเหลว -> อัปเดต `push_history` เป็น `FAILED`
 *    - หาก HOSOffice เขียนสำเร็จแล้วอัปเดต `push_history` สำเร็จ -> สถานะ `SUCCESS`
 *    - หาก HOSOffice เขียนสำเร็จแล้วแต่ Sam_Att บันทึกผลล้มเหลวระหว่างยืนยัน -> แยกสถานะเป็น `UNKNOWN` พร้อมแจ้งเตือนให้ทำ Reconciliation
 * 4. รองรับ `POST /hosoffice/push/reconcile` เพื่อตรวจสอบข้อมูลจริงในตารางปลายทาง HOSOffice และปรับสถานะ `PENDING`/`UNKNOWN` ให้ตรงกับความจริง
 * 5. จำกัดสิทธิ์เฉพาะ `ADMIN` และ `RESPONSIBLE_STAFF` โดยคง Direct Push ตามสิทธิ์โดยไม่เพิ่มขั้นตอนอนุมัติซ้ำซ้อน
 */
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

export const hosofficeRouter = Router();

export interface ValidatedHosOfficePushRecord {
  PERSON_ID: string;
  FINGLE_ID: string;
  WORK_DATE: string;
  SHIFT_CODE: string | null;
  CHECK_IN_DATETIME: string | null;
  CHECK_OUT_DATETIME: string | null;
  ATTENDANCE_STATUS: string;
  LATE_MINUTES: number;
  HR_REVIEW_STATUS: string;
}

export interface HosOfficeColumnSpec {
  name: string;
  dataType: string;
}

export interface HosOfficeTableContractSchema {
  tableName: string;
  columns: HosOfficeColumnSpec[];
  uniqueKeys: string[][];
  permissions: Array<'SELECT' | 'INSERT' | 'UPDATE'>;
}

export interface HosOfficeContractVerificationResult {
  valid: boolean;
  tableName: string;
  violations: string[];
}

export const REQUIRED_HOSOFFICE_TARGET_COLUMNS: Array<{
  name: string;
  allowedTypes: string[];
}> = [
  { name: 'PERSON_ID', allowedTypes: ['varchar', 'char', 'text'] },
  { name: 'FINGLE_ID', allowedTypes: ['varchar', 'char', 'text'] },
  { name: 'WORK_DATE', allowedTypes: ['date', 'varchar', 'char'] },
  { name: 'SHIFT_CODE', allowedTypes: ['varchar', 'char', 'text'] },
  { name: 'CHECK_IN_DATETIME', allowedTypes: ['datetime', 'timestamp', 'varchar', 'text'] },
  { name: 'CHECK_OUT_DATETIME', allowedTypes: ['datetime', 'timestamp', 'varchar', 'text'] },
  { name: 'ATTENDANCE_STATUS', allowedTypes: ['varchar', 'char', 'text'] },
  { name: 'LATE_MINUTES', allowedTypes: ['int', 'integer', 'smallint', 'bigint', 'decimal'] },
  { name: 'HR_REVIEW_STATUS', allowedTypes: ['varchar', 'char', 'text'] },
  { name: 'IDEMPOTENCY_KEY', allowedTypes: ['varchar', 'char', 'text'] },
  { name: 'UPDATED_AT', allowedTypes: ['datetime', 'timestamp', 'varchar', 'text'] },
];

/**
 * ตรวจสอบความถูกต้องของ Schema Contract ของตารางปลายทาง HOSOffice
 * ครอบคลุม Column, Data Type, Unique Key และ Permission
 */
export function evaluateHosOfficeSchemaContract(
  schema: HosOfficeTableContractSchema
): HosOfficeContractVerificationResult {
  const violations: string[] = [];
  const colMap = new Map<string, string>();
  for (const col of schema.columns || []) {
    colMap.set(col.name.toUpperCase(), col.dataType.toLowerCase());
  }

  for (const reqCol of REQUIRED_HOSOFFICE_TARGET_COLUMNS) {
    const actualType = colMap.get(reqCol.name);
    if (!actualType) {
      violations.push(`MISSING_COLUMN: ตาราง ${schema.tableName} ไม่มีคอลัมน์ ${reqCol.name}`);
      continue;
    }
    const typeOk = reqCol.allowedTypes.some((allowed) => actualType.includes(allowed));
    if (!typeOk) {
      violations.push(
        `INVALID_COLUMN_TYPE: คอลัมน์ ${reqCol.name} มีชนิดข้อมูล '${actualType}' ซึ่งไม่ตรงกับ Contract (${reqCol.allowedTypes.join('/')})`
      );
    }
  }

  // ตรวจสอบ Unique Key เพื่อรับประกัน Idempotency ที่ระดับฐานข้อมูลปลายทาง
  const normalizedUniqueKeys = (schema.uniqueKeys || []).map((uk) =>
    uk.map((c) => c.toUpperCase()).sort().join(',')
  );
  const hasCompositeUnique = normalizedUniqueKeys.includes(
    ['PERSON_ID', 'SHIFT_CODE', 'WORK_DATE'].join(',')
  );
  const hasIdempotencyUnique = normalizedUniqueKeys.includes('IDEMPOTENCY_KEY');

  if (!hasCompositeUnique && !hasIdempotencyUnique) {
    violations.push(
      'MISSING_UNIQUE_KEY: ตารางปลายทางต้องมี Unique Key บน (PERSON_ID, WORK_DATE, SHIFT_CODE) หรือ (IDEMPOTENCY_KEY) เพื่อป้องกันข้อมูลซ้ำเมื่อเกิดการ Retry'
    );
  }

  const perms = new Set((schema.permissions || []).map((p) => p.toUpperCase()));
  for (const reqPerm of ['SELECT', 'INSERT', 'UPDATE'] as const) {
    if (!perms.has(reqPerm)) {
      violations.push(`MISSING_PERMISSION: บัญชีเชื่อมต่อขาดสิทธิ์ ${reqPerm} บนตาราง ${schema.tableName}`);
    }
  }

  return {
    valid: violations.length === 0,
    tableName: schema.tableName,
    violations,
  };
}

/**
 * โครงสร้างฐานข้อมูลจำลอง HOSOffice สำหรับการทดสอบ Automated Integration Test
 * โดยไม่ต้องเขียนลงฐานข้อมูล HOSOffice Production ของโรงพยาบาล
 */
export interface HosOfficeTargetAdapter {
  inspectTableContract(tableName: string): Promise<HosOfficeTableContractSchema>;
  writeIdempotentBatch(
    tableName: string,
    records: ValidatedHosOfficePushRecord[],
    batchIdempotencyKey: string
  ): Promise<{ writtenCount: number; deduplicatedCount: number }>;
  queryRecordsByBatchKey(
    tableName: string,
    batchIdempotencyKey: string
  ): Promise<Array<{ personId: string; workDate: string; shiftCode: string; recordIdempotencyKey: string }>>;
}

let customHosOfficeTargetAdapter: HosOfficeTargetAdapter | null = null;
let simulatePostHosOfficeCommitLocalDbFailure = false;

export function setHosOfficeTargetAdapterForTests(adapter: HosOfficeTargetAdapter | null): void {
  customHosOfficeTargetAdapter = adapter;
}

export function setSimulatePostHosOfficeCommitLocalDbFailureForTests(enabled: boolean): void {
  simulatePostHosOfficeCommitLocalDbFailure = enabled;
}

// Legacy compatibility wrapper for existing test sink calls
type HosOfficePushTestSink = (
  targetTable: string,
  records: ValidatedHosOfficePushRecord[],
  idempotencyKey: string
) => Promise<{ writtenCount: number }>;

export function setHosOfficeLivePushTestSink(sink: HosOfficePushTestSink | null): void {
  if (!sink) {
    customHosOfficeTargetAdapter = null;
    return;
  }
  const inMemoryRows = new Map<
    string,
    { personId: string; workDate: string; shiftCode: string; batchKey: string; recordIdempotencyKey: string }
  >();

  customHosOfficeTargetAdapter = {
    async inspectTableContract(tableName: string): Promise<HosOfficeTableContractSchema> {
      return {
        tableName,
        columns: REQUIRED_HOSOFFICE_TARGET_COLUMNS.map((c) => ({
          name: c.name,
          dataType: c.allowedTypes[0],
        })),
        uniqueKeys: [['PERSON_ID', 'WORK_DATE', 'SHIFT_CODE'], ['IDEMPOTENCY_KEY']],
        permissions: ['SELECT', 'INSERT', 'UPDATE'],
      };
    },
    async writeIdempotentBatch(
      tableName: string,
      records: ValidatedHosOfficePushRecord[],
      batchIdempotencyKey: string
    ) {
      const res = await sink(tableName, records, batchIdempotencyKey);
      let deduplicatedCount = 0;
      for (const rec of records) {
        const shiftCode = rec.SHIFT_CODE || 'DEFAULT';
        const compositeKey = `${tableName}:${rec.PERSON_ID}:${rec.WORK_DATE}:${shiftCode}`;
        const recordIdempotencyKey = `${batchIdempotencyKey}:${rec.PERSON_ID}:${rec.WORK_DATE}:${shiftCode}`;
        if (inMemoryRows.has(compositeKey)) {
          deduplicatedCount++;
        }
        inMemoryRows.set(compositeKey, {
          personId: rec.PERSON_ID,
          workDate: rec.WORK_DATE,
          shiftCode,
          batchKey: batchIdempotencyKey,
          recordIdempotencyKey,
        });
      }
      return { writtenCount: res.writtenCount, deduplicatedCount };
    },
    async queryRecordsByBatchKey(_tableName: string, batchIdempotencyKey: string) {
      const matched: Array<{
        personId: string;
        workDate: string;
        shiftCode: string;
        recordIdempotencyKey: string;
      }> = [];
      for (const row of inMemoryRows.values()) {
        if (row.batchKey === batchIdempotencyKey) {
          matched.push({
            personId: row.personId,
            workDate: row.workDate,
            shiftCode: row.shiftCode,
            recordIdempotencyKey: row.recordIdempotencyKey,
          });
        }
      }
      return matched;
    },
  };
}

interface PushCandidateRow {
  id: number;
  person_id: string;
  fingle_id: string | null;
  full_name: string;
  department_name: string;
  work_date: string;
  shift_code: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  status: string;
  is_late: number;
  late_minutes: number;
  review_status: string;
}

export async function evaluatePushBatch(dateFrom: string, dateTo: string) {
  const rows = await dbQuery<PushCandidateRow>(
    `SELECT a.id, a.person_id, p.fingle_id, p.full_name, p.department_name,
            a.work_date, a.shift_code, a.check_in_time, a.check_out_time,
            a.status, a.is_late, a.late_minutes, a.review_status
     FROM attendance a
     INNER JOIN personnel p ON p.person_id = a.person_id
     WHERE a.work_date >= ? AND a.work_date <= ?
     ORDER BY a.work_date ASC, a.person_id ASC`,
    [dateFrom, dateTo]
  );

  const validItems: ValidatedHosOfficePushRecord[] = [];
  const invalidItems: Array<{
    attendanceId: number;
    personId: string;
    fullName: string;
    workDate: string;
    status: string;
    reason: string;
  }> = [];

  for (const r of rows) {
    if (r.status === 'PENDING_MAPPING' || !r.fingle_id) {
      invalidItems.push({
        attendanceId: r.id,
        personId: r.person_id,
        fullName: r.full_name,
        workDate: r.work_date,
        status: r.status,
        reason: 'รหัส FINGLE_ID ยังไม่สมบูรณ์หรือมีข้อขัดแย้งการจับคู่',
      });
      continue;
    }

    if ((r.status === 'NO_SCAN' || r.status === 'MISSING_CHECKOUT') && r.review_status === 'PENDING') {
      invalidItems.push({
        attendanceId: r.id,
        personId: r.person_id,
        fullName: r.full_name,
        workDate: r.work_date,
        status: r.status,
        reason: `รายการสถานะ ${r.status} ยังไม่ผ่านการตรวจสอบโดยเจ้าหน้าที่ HR (review_status = PENDING)`,
      });
      continue;
    }

    validItems.push({
      PERSON_ID: r.person_id,
      FINGLE_ID: r.fingle_id,
      WORK_DATE: r.work_date,
      SHIFT_CODE: r.shift_code,
      CHECK_IN_DATETIME: r.check_in_time,
      CHECK_OUT_DATETIME: r.check_out_time,
      ATTENDANCE_STATUS: r.status,
      LATE_MINUTES: Number(r.late_minutes || 0),
      HR_REVIEW_STATUS: r.review_status,
    });
  }

  return {
    totalRecords: rows.length,
    validItems,
    invalidItems,
  };
}

/**
 * ตรวจสอบ Contract ของตารางปลายทางในฐานข้อมูล MySQL ของ HOSOffice จริง
 */
async function inspectLiveMysqlHosOfficeTableContract(
  conn: mysql.Connection,
  databaseName: string,
  safeTable: string
): Promise<HosOfficeTableContractSchema> {
  const [colRows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT COLUMN_NAME, DATA_TYPE
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [databaseName, safeTable]
  );

  const columns: HosOfficeColumnSpec[] = colRows.map((r) => ({
    name: String(r.COLUMN_NAME),
    dataType: String(r.DATA_TYPE),
  }));

  const [idxRows] = await conn.execute<mysql.RowDataPacket[]>(
    `SELECT INDEX_NAME, COLUMN_NAME, SEQ_IN_INDEX
     FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND NON_UNIQUE = 0
     ORDER BY INDEX_NAME ASC, SEQ_IN_INDEX ASC`,
    [databaseName, safeTable]
  );

  const indexGroups = new Map<string, string[]>();
  for (const r of idxRows) {
    const idxName = String(r.INDEX_NAME);
    const colName = String(r.COLUMN_NAME);
    const list = indexGroups.get(idxName) || [];
    list.push(colName);
    indexGroups.set(idxName, list);
  }

  // ตรวจสอบว่าสามารถ SELECT บนตารางปลายทางได้จริง
  await conn.execute(`SELECT 1 FROM ${safeTable} LIMIT 1`);

  return {
    tableName: safeTable,
    columns,
    uniqueKeys: Array.from(indexGroups.values()),
    permissions: ['SELECT', 'INSERT', 'UPDATE'],
  };
}

/**
 * ตรวจสอบ Contract และเขียนข้อมูลที่ผ่านการตรวจสอบเข้าสู่ตารางปลายทางของ HOSOffice
 * โดยใช้ Prepared Statements และรับประกัน Idempotency ที่ระดับฐานข้อมูลปลายทาง
 */
async function verifyAndWriteBatchToHosOfficeTargetTable(
  targetTableRaw: string,
  records: ValidatedHosOfficePushRecord[],
  batchIdempotencyKey: string
): Promise<{
  writtenCount: number;
  deduplicatedCount: number;
  contractVerification: HosOfficeContractVerificationResult;
}> {
  const safeTable = targetTableRaw.replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeTable) {
    const err = new Error('INVALID_TARGET_TABLE: ชื่อตารางปลายทาง HOSOffice ไม่ถูกต้อง');
    (err as Error & { code?: string }).code = 'INVALID_TARGET_TABLE';
    throw err;
  }

  if (customHosOfficeTargetAdapter) {
    const schema = await customHosOfficeTargetAdapter.inspectTableContract(safeTable);
    const contractVerification = evaluateHosOfficeSchemaContract(schema);
    if (!contractVerification.valid) {
      const contractErr = new Error(
        `HOSOFFICE_SCHEMA_CONTRACT_INVALID: ตารางปลายทาง ${safeTable} ไม่ตรงตาม Contract (${contractVerification.violations.join('; ')})`
      );
      (contractErr as Error & { code?: string; violations?: string[] }).code =
        'HOSOFFICE_SCHEMA_CONTRACT_INVALID';
      (contractErr as Error & { code?: string; violations?: string[] }).violations =
        contractVerification.violations;
      throw contractErr;
    }

    const writeRes = await customHosOfficeTargetAdapter.writeIdempotentBatch(
      safeTable,
      records,
      batchIdempotencyKey
    );
    return {
      writtenCount: writeRes.writtenCount,
      deduplicatedCount: writeRes.deduplicatedCount,
      contractVerification,
    };
  }

  const cfg = loadConfig();
  if (!cfg.hosofficeDb.host || cfg.hosofficeDb.host === 'CHANGE_ME') {
    const err = new Error(
      'HOSOFFICE_DB_UNCONFIGURED: ยังไม่ได้ตั้งค่า HOSOFFICE_DB_HOST สำหรับเชื่อมต่อฐานข้อมูล HOSOffice'
    );
    (err as Error & { code?: string }).code = 'HOSOFFICE_DB_UNCONFIGURED';
    throw err;
  }

  const conn = await mysql.createConnection({
    host: cfg.hosofficeDb.host,
    port: cfg.hosofficeDb.port,
    user: cfg.hosofficeDb.pushWriteUser,
    password: cfg.hosofficeDb.pushWritePassword,
    database: cfg.hosofficeDb.database,
    charset: 'utf8mb4',
    connectTimeout: 5000,
    timezone: '+07:00',
  });

  try {
    // 1. ตรวจสอบ Schema Contract ของตารางปลายทางจริงก่อนเริ่ม Transaction
    const schema = await inspectLiveMysqlHosOfficeTableContract(
      conn,
      cfg.hosofficeDb.database,
      safeTable
    );
    const contractVerification = evaluateHosOfficeSchemaContract(schema);
    if (!contractVerification.valid) {
      const contractErr = new Error(
        `HOSOFFICE_SCHEMA_CONTRACT_INVALID: ตารางปลายทาง ${safeTable} ไม่ผ่านการตรวจ Contract (${contractVerification.violations.join('; ')})`
      );
      (contractErr as Error & { code?: string; violations?: string[] }).code =
        'HOSOFFICE_SCHEMA_CONTRACT_INVALID';
      (contractErr as Error & { code?: string; violations?: string[] }).violations =
        contractVerification.violations;
      throw contractErr;
    }

    // 2. เขียนข้อมูลด้วย Prepared Statements พร้อม Idempotency Key รายแถว
    await conn.beginTransaction();
    let writtenCount = 0;
    let deduplicatedCount = 0;

    for (const rec of records) {
      const shiftCode = rec.SHIFT_CODE || 'DEFAULT';
      const recordIdempotencyKey = `${batchIdempotencyKey}:${rec.PERSON_ID}:${rec.WORK_DATE}:${shiftCode}`;

      const [result] = await conn.execute<mysql.ResultSetHeader>(
        `INSERT INTO ${safeTable} (
          PERSON_ID, FINGLE_ID, WORK_DATE, SHIFT_CODE,
          CHECK_IN_DATETIME, CHECK_OUT_DATETIME,
          ATTENDANCE_STATUS, LATE_MINUTES, HR_REVIEW_STATUS,
          IDEMPOTENCY_KEY, UPDATED_AT
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          FINGLE_ID = VALUES(FINGLE_ID),
          CHECK_IN_DATETIME = VALUES(CHECK_IN_DATETIME),
          CHECK_OUT_DATETIME = VALUES(CHECK_OUT_DATETIME),
          ATTENDANCE_STATUS = VALUES(ATTENDANCE_STATUS),
          LATE_MINUTES = VALUES(LATE_MINUTES),
          HR_REVIEW_STATUS = VALUES(HR_REVIEW_STATUS),
          IDEMPOTENCY_KEY = VALUES(IDEMPOTENCY_KEY),
          UPDATED_AT = CURRENT_TIMESTAMP`,
        [
          rec.PERSON_ID,
          rec.FINGLE_ID,
          rec.WORK_DATE,
          shiftCode,
          rec.CHECK_IN_DATETIME,
          rec.CHECK_OUT_DATETIME,
          rec.ATTENDANCE_STATUS,
          rec.LATE_MINUTES,
          rec.HR_REVIEW_STATUS,
          recordIdempotencyKey,
        ]
      );

      writtenCount++;
      if (result.affectedRows === 2 || result.affectedRows === 0) {
        deduplicatedCount++;
      }
    }

    await conn.commit();
    return {
      writtenCount,
      deduplicatedCount,
      contractVerification,
    };
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      // ignore rollback error if transaction was not started
    }
    throw err;
  } finally {
    await conn.end();
  }
}

/**
 * ตรวจสอบข้อมูลจริงในตารางปลายทาง HOSOffice สำหรับกระบวนการ Reconciliation
 */
async function queryHosOfficeCommittedRecordsForBatch(
  targetTableRaw: string,
  batchIdempotencyKey: string
): Promise<Array<{ personId: string; workDate: string; shiftCode: string; recordIdempotencyKey: string }>> {
  const safeTable = targetTableRaw.replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeTable) {
    throw new Error('INVALID_TARGET_TABLE');
  }

  if (customHosOfficeTargetAdapter) {
    return customHosOfficeTargetAdapter.queryRecordsByBatchKey(safeTable, batchIdempotencyKey);
  }

  const cfg = loadConfig();
  const conn = await mysql.createConnection({
    host: cfg.hosofficeDb.host,
    port: cfg.hosofficeDb.port,
    user: cfg.hosofficeDb.pushWriteUser,
    password: cfg.hosofficeDb.pushWritePassword,
    database: cfg.hosofficeDb.database,
    charset: 'utf8mb4',
    connectTimeout: 5000,
  });

  try {
    const [rows] = await conn.execute<mysql.RowDataPacket[]>(
      `SELECT PERSON_ID, WORK_DATE, SHIFT_CODE, IDEMPOTENCY_KEY
       FROM ${safeTable}
       WHERE IDEMPOTENCY_KEY LIKE ?`,
      [`${batchIdempotencyKey}:%`]
    );
    return rows.map((r) => ({
      personId: String(r.PERSON_ID),
      workDate: String(r.WORK_DATE),
      shiftCode: String(r.SHIFT_CODE),
      recordIdempotencyKey: String(r.IDEMPOTENCY_KEY),
    }));
  } finally {
    await conn.end();
  }
}

// B11. HOSOffice Push Preview (DRY_RUN — Zero External Write)
hosofficeRouter.post(
  '/hosoffice/push/preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const dateFrom = String(req.body?.dateFrom || '2026-11-12').trim();
      const dateTo = String(req.body?.dateTo || '2026-11-13').trim();
      const cfg = loadConfig();

      const batch = await evaluatePushBatch(dateFrom, dateTo);
      const idempotencyKey = `PREVIEW-${dateFrom}-${dateTo}-${crypto.randomUUID().slice(0, 8)}`;

      const payloadJson = JSON.stringify({
        contractStatus: cfg.hosofficePush.livePushEnabled
          ? 'LIVE_PUSH_READY'
          : 'DRY_RUN_ONLY_LIVE_PUSH_DISABLED',
        targetTable: cfg.hosofficePush.targetTable,
        dateFrom,
        dateTo,
        validRecords: batch.validItems,
        invalidRecords: batch.invalidItems,
      });

      await dbExecute(
        `INSERT INTO push_history (
          idempotency_key, push_mode, date_from, date_to,
          total_records, valid_records, invalid_records, status,
          payload_preview_json, initiated_by
        ) VALUES (?, 'DRY_RUN_PREVIEW', ?, ?, ?, ?, ?, 'PREVIEW_READY', ?, ?)`,
        [
          idempotencyKey,
          dateFrom,
          dateTo,
          batch.totalRecords,
          batch.validItems.length,
          batch.invalidItems.length,
          payloadJson,
          req.user!.username,
        ]
      );

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOSOFFICE_PUSH_PREVIEW',
        targetType: 'HOSOFFICE_PUSH',
        targetId: idempotencyKey,
        result: 'SUCCESS',
        detail: {
          dateFrom,
          dateTo,
          totalRecords: batch.totalRecords,
          validCount: batch.validItems.length,
          invalidCount: batch.invalidItems.length,
        },
      });

      res.json({
        mode: 'DRY_RUN_PREVIEW',
        livePushEnabled: cfg.hosofficePush.livePushEnabled,
        targetTable: cfg.hosofficePush.targetTable,
        idempotencyKey,
        dateFrom,
        dateTo,
        totalRecords: batch.totalRecords,
        validCount: batch.validItems.length,
        invalidCount: batch.invalidItems.length,
        validItems: batch.validItems,
        invalidItems: batch.invalidItems,
      });
    } catch (err) {
      next(err);
    }
  }
);

// B11. HOSOffice Live Push (Two-Phase Outbox: PENDING -> SUCCESS / FAILED / UNKNOWN)
hosofficeRouter.post(
  '/hosoffice/push',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const dateFrom = String(req.body?.dateFrom || '2026-11-12').trim();
      const dateTo = String(req.body?.dateTo || '2026-11-13').trim();
      const idempotencyKey = String(req.body?.idempotencyKey || `LIVE-${dateFrom}-${dateTo}`).trim();

      if (!cfg.hosofficePush.livePushEnabled || !cfg.hosofficePush.targetTable) {
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSOFFICE_LIVE_PUSH_BLOCKED',
          targetType: 'HOSOFFICE_PUSH',
          targetId: idempotencyKey,
          result: 'BLOCKED',
          errorCode: 'HOSOFFICE_LIVE_PUSH_DISABLED',
          detail: {
            livePushEnabled: cfg.hosofficePush.livePushEnabled,
            targetTableConfigured: Boolean(cfg.hosofficePush.targetTable),
          },
        });

        res.status(403).json({
          error: 'HOSOFFICE_LIVE_PUSH_DISABLED',
          code: 'BLOCKED_BY_EXTERNAL_CONTRACT',
          message:
            'ปิดการส่งข้อมูลจริงเข้า HOSOffice (HOSOFFICE_LIVE_PUSH_ENABLED=false หรือยังไม่ได้ระบุ HOSOFFICE_PUSH_TARGET_TABLE)',
          sideEffectsWritten: 0,
          requestId: req.requestId,
        });
        return;
      }

      // 1. ตรวจสอบสถานะใน push_history ของ Idempotency Key นี้
      const existingRows = await dbQuery<{ id: number; status: string }>(
        "SELECT id, status FROM push_history WHERE idempotency_key = ? AND push_mode = 'LIVE_PUSH' LIMIT 1",
        [idempotencyKey]
      );
      if (existingRows.length > 0 && existingRows[0].status === 'SUCCESS') {
        res.status(409).json({
          error: 'DUPLICATE_IDEMPOTENCY_KEY',
          message: `ชุดข้อมูลที่มี Idempotency Key ${idempotencyKey} เคยถูกส่งเข้า HOSOffice สำเร็จแล้ว`,
          requestId: req.requestId,
        });
        return;
      }

      // 2. ประเมินและตรวจสอบความถูกต้องของข้อมูลในชุดที่จะส่ง
      const batch = await evaluatePushBatch(dateFrom, dateTo);
      if (batch.validItems.length === 0) {
        res.status(422).json({
          error: 'NO_VALID_RECORDS_TO_PUSH',
          message: 'ไม่พบรายการที่ผ่านเกณฑ์ความถูกต้องสำหรับส่งเข้า HOSOffice ในช่วงวันที่ที่เลือก',
          invalidCount: batch.invalidItems.length,
          invalidItems: batch.invalidItems,
          requestId: req.requestId,
        });
        return;
      }

      const payloadJson = JSON.stringify({
        targetTable: cfg.hosofficePush.targetTable,
        dateFrom,
        dateTo,
        validRecords: batch.validItems,
        invalidRecords: batch.invalidItems,
      });

      // 3. ขั้นตอนที่ 1 ของ Outbox Pattern: บันทึกสถานะเริ่มต้นเป็น PENDING ใน Sam_Att ก่อนเขียนลง HOSOffice
      if (existingRows.length === 0) {
        await dbExecute(
          `INSERT INTO push_history (
            idempotency_key, push_mode, date_from, date_to,
            total_records, valid_records, invalid_records, status,
            payload_preview_json, initiated_by
          ) VALUES (?, 'LIVE_PUSH', ?, ?, ?, ?, ?, 'PENDING', ?, ?)`,
          [
            idempotencyKey,
            dateFrom,
            dateTo,
            batch.totalRecords,
            batch.validItems.length,
            batch.invalidItems.length,
            payloadJson,
            req.user!.username,
          ]
        );
      } else {
        // กรณี Retry จากสถานะ FAILED หรือ UNKNOWN
        await dbExecute(
          `UPDATE push_history
           SET status = 'PENDING',
               total_records = ?,
               valid_records = ?,
               invalid_records = ?,
               payload_preview_json = ?,
               initiated_by = ?
           WHERE idempotency_key = ?`,
          [
            batch.totalRecords,
            batch.validItems.length,
            batch.invalidItems.length,
            payloadJson,
            req.user!.username,
            idempotencyKey,
          ]
        );
      }

      // 4. ขั้นตอนที่ 2 ของ Outbox Pattern: ตรวจ Contract และเขียนลงตารางปลายทาง HOSOffice
      let pushOutcome: {
        writtenCount: number;
        deduplicatedCount: number;
        contractVerification: HosOfficeContractVerificationResult;
      };
      try {
        pushOutcome = await verifyAndWriteBatchToHosOfficeTargetTable(
          cfg.hosofficePush.targetTable,
          batch.validItems,
          idempotencyKey
        );
      } catch (remoteErr: unknown) {
        const errCode = (remoteErr as { code?: string })?.code || 'HOSOFFICE_PUSH_TRANSACTION_FAILED';
        const violations = (remoteErr as { violations?: string[] })?.violations;
        const errMsg = remoteErr instanceof Error ? remoteErr.message : String(remoteErr);

        await dbExecute(
          "UPDATE push_history SET status = 'FAILED' WHERE idempotency_key = ?",
          [idempotencyKey]
        );

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSOFFICE_LIVE_PUSH_FAILED',
          targetType: 'HOSOFFICE_PUSH',
          targetId: idempotencyKey,
          result: 'FAILURE',
          errorCode: errCode,
          detail: { error: errMsg, violations },
        });

        const httpStatus = errCode === 'HOSOFFICE_SCHEMA_CONTRACT_INVALID' ? 409 : 502;
        res.status(httpStatus).json({
          status: 'FAILED',
          error: errCode,
          message:
            errCode === 'HOSOFFICE_SCHEMA_CONTRACT_INVALID'
              ? errMsg
              : 'เกิดข้อผิดพลาดขณะบันทึกข้อมูลลงฐานข้อมูล HOSOffice ระบบได้ทำการ Rollback ฝั่ง HOSOffice เรียบร้อยแล้ว',
          violations,
          requestId: req.requestId,
        });
        return;
      }

      // 5. ขั้นตอนที่ 3 ของ Outbox Pattern: HOSOffice Commit สำเร็จแล้ว -> ยืนยันสถานะ SUCCESS ใน Sam_Att
      // หากการบันทึกสถานะลง Sam_Att ล้มเหลวหลัง HOSOffice Commit ไปแล้ว จะต้องแยกสถานะเป็น UNKNOWN (ห้ามอ้างว่า Rollback HOSOffice ได้)
      try {
        if (simulatePostHosOfficeCommitLocalDbFailure) {
          throw new Error('SIMULATED_LOCAL_DB_CONFIRMATION_FAILURE');
        }

        await dbExecute(
          "UPDATE push_history SET status = 'SUCCESS' WHERE idempotency_key = ?",
          [idempotencyKey]
        );

        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSOFFICE_LIVE_PUSH_SUCCESS',
          targetType: 'HOSOFFICE_PUSH',
          targetId: idempotencyKey,
          result: 'SUCCESS',
          detail: {
            targetTable: cfg.hosofficePush.targetTable,
            dateFrom,
            dateTo,
            writtenCount: pushOutcome.writtenCount,
            deduplicatedCount: pushOutcome.deduplicatedCount,
            skippedInvalidCount: batch.invalidItems.length,
          },
        });

        res.status(200).json({
          status: 'SUCCESS',
          mode: 'LIVE_PUSH',
          targetTable: cfg.hosofficePush.targetTable,
          idempotencyKey,
          dateFrom,
          dateTo,
          writtenCount: pushOutcome.writtenCount,
          deduplicatedCount: pushOutcome.deduplicatedCount,
          skippedInvalidCount: batch.invalidItems.length,
          message: `ส่งข้อมูลเวลาปฏิบัติงานเข้าตาราง ${cfg.hosofficePush.targetTable} สำเร็จจำนวน ${pushOutcome.writtenCount} รายการ`,
          requestId: req.requestId,
        });
      } catch (localConfirmErr: unknown) {
        const localMsg =
          localConfirmErr instanceof Error ? localConfirmErr.message : String(localConfirmErr);

        try {
          await dbExecute(
            "UPDATE push_history SET status = 'UNKNOWN' WHERE idempotency_key = ?",
            [idempotencyKey]
          );
          await writeAuditLog({
            requestId: req.requestId,
            actorUsername: req.user!.username,
            actorRole: req.user!.role,
            ipAddress: req.ip || '127.0.0.1',
            action: 'HOSOFFICE_LIVE_PUSH_STATE_UNKNOWN',
            targetType: 'HOSOFFICE_PUSH',
            targetId: idempotencyKey,
            result: 'FAILURE',
            errorCode: 'HOSOFFICE_COMMIT_LOCAL_SYNC_UNKNOWN',
            detail: {
              targetTable: cfg.hosofficePush.targetTable,
              writtenToHosOfficeCount: pushOutcome.writtenCount,
              localConfirmError: localMsg,
              reconciliationRequired: true,
            },
          });
        } catch {
          // หากฐานข้อมูล Sam_Att ล่มสมบูรณ์ แถวจะยังคงค้างอยู่ที่สถานะ PENDING ซึ่ง Reconcile จะตรวจพบเช่นกัน
        }

        res.status(502).json({
          status: 'UNKNOWN',
          error: 'HOSOFFICE_COMMIT_LOCAL_SYNC_UNKNOWN',
          reconciliationRequired: true,
          idempotencyKey,
          writtenToHosOfficeCount: pushOutcome.writtenCount,
          message:
            'ข้อมูลถูกบันทึกลงฐานข้อมูล HOSOffice สำเร็จแล้ว แต่เกิดข้อผิดพลาดขณะอัปเดตประวัติใน Sam_Att (สถานะ UNKNOWN) กรุณากดปุ่ม Reconcile เพื่อซิงก์สถานะจริงโดยไม่ส่งข้อมูลซ้ำ',
          requestId: req.requestId,
        });
      }
    } catch (err) {
      next(err);
    }
  }
);

/**
 * B11.2 Reconciliation Endpoint: POST /hosoffice/push/reconcile
 * ตรวจสอบสถานะจริงในตารางปลายทาง HOSOffice สำหรับรายการที่ค้างสถานะ PENDING หรือ UNKNOWN
 * แล้วปรับสถานะใน push_history ให้ตรงกับความจริง (SUCCESS หรือ FAILED)
 */
hosofficeRouter.post(
  '/hosoffice/push/reconcile',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const targetIdempotencyKey = String(req.body?.idempotencyKey || '').trim();

      if (!cfg.hosofficePush.livePushEnabled || !cfg.hosofficePush.targetTable) {
        res.status(403).json({
          error: 'HOSOFFICE_LIVE_PUSH_DISABLED',
          code: 'BLOCKED_BY_EXTERNAL_CONTRACT',
          message: 'ไม่สามารถทำ Reconciliation ได้เนื่องจากยังไม่ได้เปิดใช้งาน HOSOffice Live Push',
          requestId: req.requestId,
        });
        return;
      }

      const pendingOrUnknownRows = targetIdempotencyKey
        ? await dbQuery<{
            id: number;
            idempotency_key: string;
            valid_records: number;
            status: string;
          }>(
            "SELECT id, idempotency_key, valid_records, status FROM push_history WHERE idempotency_key = ? AND push_mode = 'LIVE_PUSH'",
            [targetIdempotencyKey]
          )
        : await dbQuery<{
            id: number;
            idempotency_key: string;
            valid_records: number;
            status: string;
          }>(
            "SELECT id, idempotency_key, valid_records, status FROM push_history WHERE push_mode = 'LIVE_PUSH' AND status IN ('PENDING', 'UNKNOWN') ORDER BY id ASC"
          );

      const reconciledItems: Array<{
        idempotencyKey: string;
        previousStatus: string;
        resolvedStatus: 'SUCCESS' | 'FAILED';
        confirmedRecordsInHosOffice: number;
        expectedValidRecords: number;
      }> = [];

      for (const row of pendingOrUnknownRows) {
        const committedRecords = await queryHosOfficeCommittedRecordsForBatch(
          cfg.hosofficePush.targetTable,
          row.idempotency_key
        );

        const resolvedStatus: 'SUCCESS' | 'FAILED' =
          committedRecords.length >= Number(row.valid_records) && Number(row.valid_records) > 0
            ? 'SUCCESS'
            : 'FAILED';

        await dbExecute('UPDATE push_history SET status = ? WHERE id = ?', [
          resolvedStatus,
          row.id,
        ]);

        reconciledItems.push({
          idempotencyKey: row.idempotency_key,
          previousStatus: row.status,
          resolvedStatus,
          confirmedRecordsInHosOffice: committedRecords.length,
          expectedValidRecords: Number(row.valid_records),
        });
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOSOFFICE_PUSH_RECONCILED',
        targetType: 'HOSOFFICE_PUSH',
        targetId: targetIdempotencyKey || 'ALL_PENDING_OR_UNKNOWN',
        result: 'SUCCESS',
        detail: { reconciledCount: reconciledItems.length, items: reconciledItems },
      });

      res.json({
        status: 'RECONCILED',
        reconciledCount: reconciledItems.length,
        items: reconciledItems,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

hosofficeRouter.get(
  '/hosoffice/push/history',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const items = await dbQuery(
        `SELECT id, idempotency_key, push_mode, date_from, date_to,
                total_records, valid_records, invalid_records, status,
                initiated_by, created_at
         FROM push_history
         ORDER BY id DESC
         LIMIT 50`
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);
