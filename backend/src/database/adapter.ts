/**
 * ============================================================================
 * ไฟล์: backend/src/database/adapter.ts
 * หน้าที่: ตัวจัดการการเชื่อมต่อฐานข้อมูลกลางของระบบ (Database Adapter Layer)
 * ============================================================================
 * อธิบายหลักการทำงาน:
 * 1. รองรับการเชื่อมต่อฐานข้อมูลหลัก MySQL (Production Database: samchuk_attendance_v2)
 *    ผ่าน Connection Pool (`mysql2/promise`) โดยตั้งค่า Timezone เป็น `+07:00` (Asia/Bangkok)
 * 2. มีฟังก์ชัน `dbQuery<T>(sql, params)` สำหรับคำสั่ง SELECT, `dbExecute(sql, params)`
 *    สำหรับคำสั่ง INSERT / UPDATE / DELETE และ `dbTransaction(fn)` สำหรับรัน Transaction (BEGIN/COMMIT/ROLLBACK)
 * 3. บังคับใช้กฎ Append-Only สำหรับตาราง `raw_scans`: ห้ามรันคำสั่ง UPDATE หรือ DELETE บน `raw_scans` เด็ดขาด (แก้ไข P1 ข้อ 08)
 * 4. ป้องกันการรั่วไหลของข้อมูลการเชื่อมต่อฐานข้อมูล (Error Leakage Prevention): ไม่ส่งชื่อ Host/Port/Schema หรือ Stack Trace
 *    กลับไปในข้อความ HTTP Error แก่ผู้ใช้ โดยบันทึกรายละเอียดจริงไว้ใน Server Log เท่านั้น (แก้ไข P1 ข้อ 13–14)
 * ============================================================================
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import {
  loadConfig,
  isAutomatedTestRuntime,
  TestIsolationViolationError,
  assertTestEnvironmentIsolated,
} from '../config/env.ts';
import {
  hashPassword,
  computeRawScanDedupKey,
  hasThaiMojibake,
  repairThaiMojibakeIfCorrupted,
} from '../utils/crypto.ts';

export class DatabaseUnavailableError extends Error {
  public readonly code = 'DB_UNAVAILABLE';
  public readonly statusCode = 503;
  public readonly PublicSafeMessage =
    'ไม่สามารถเชื่อมต่อฐานข้อมูลหลัก Sam_Att ได้ในขณะนี้ (Fail-Closed Mode: ห้ามใช้ข้อมูลจำลอง กรุณาติดต่อผู้ดูแลระบบ)';
  public readonly internalDiagnosticMessage: string;

  constructor(internalDiagnosticMessage: string) {
    super('ไม่สามารถเชื่อมต่อฐานข้อมูลหลัก Sam_Att ได้ในขณะนี้ (Fail-Closed Mode: ห้ามใช้ข้อมูลจำลอง กรุณาติดต่อผู้ดูแลระบบ)');
    this.name = 'DatabaseUnavailableError';
    this.internalDiagnosticMessage = internalDiagnosticMessage;
  }
}

export class ImmutableTableViolationError extends Error {
  public readonly code = 'IMMUTABLE_TABLE_VIOLATION';
  public readonly statusCode = 409;
  constructor(sql: string) {
    super(
      'IMMUTABLE_TABLE_VIOLATION: ห้ามแก้ไข (UPDATE) หรือลบ (DELETE) ข้อมูลในตาราง raw_scans เด็ดขาด กรุณาบันทึกผลการจับคู่ลงตาราง raw_scan_mappings เท่านั้น'
    );
    this.name = 'ImmutableTableViolationError';
    console.error(`[Security Guard] Blocked mutation on immutable table raw_scans: ${sql.slice(0, 120)}`);
  }
}

export interface QueryResultMeta {
  insertId?: number;
  affectedRows?: number;
}

export interface DbTransactionContext {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  execute: (sql: string, params?: unknown[]) => Promise<QueryResultMeta>;
}

let mysqlPool: mysql.Pool | null = null;
let sqliteDb: DatabaseSync | null = null;
let simulatedDown = false;

export function setSimulatedDatabaseDown(down: boolean): void {
  simulatedDown = down;
}

export function isSimulatedDatabaseDown(): boolean {
  return simulatedDown;
}

function assertRawScansImmutable(sql: string): void {
  if (/\b(?:UPDATE|DELETE\s+FROM|TRUNCATE\s+TABLE|DROP\s+TABLE)\s+`?raw_scans`?\b/i.test(sql)) {
    throw new ImmutableTableViolationError(sql);
  }
}

function getSqliteInstance(): DatabaseSync {
  const cfg = loadConfig();
  if (cfg.nodeEnv === 'production' || cfg.dbEngine === 'mysql') {
    throw new DatabaseUnavailableError(
      'REAL_MODE_SQLITE_FALLBACK_FORBIDDEN: ห้ามใช้ SQLite เป็น Fallback ในโหมด Production หรือเมื่อตั้งค่า SAM_ATT_DB_ENGINE=mysql'
    );
  }
  if (isAutomatedTestRuntime()) {
    assertTestEnvironmentIsolated(cfg);
  }
  if (!sqliteDb) {
    const dir = path.dirname(cfg.samAttDb.sqlitePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    sqliteDb = new DatabaseSync(cfg.samAttDb.sqlitePath);
    sqliteDb.exec('PRAGMA foreign_keys = ON;');
    sqliteDb.exec('PRAGMA journal_mode = WAL;');
  }
  return sqliteDb;
}

export function resetSqliteInstanceForTests(customSqlitePath?: string): void {
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch {
      // ignore
    }
    sqliteDb = null;
  }
  if (customSqlitePath) {
    process.env.SAM_ATT_SQLITE_PATH = customSqlitePath;
  }
}

async function getMysqlPool(): Promise<mysql.Pool> {
  const cfg = loadConfig();
  if (isAutomatedTestRuntime() || cfg.nodeEnv === 'test') {
    throw new TestIsolationViolationError([
      `FORBIDDEN_MYSQL_ACCESS_IN_TEST: Automated tests are strictly prohibited from connecting to MySQL (${cfg.samAttDb.host}:${cfg.samAttDb.port}/${cfg.samAttDb.database})`,
    ]);
  }
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: cfg.samAttDb.host,
      port: cfg.samAttDb.port,
      user: cfg.samAttDb.user,
      password: cfg.samAttDb.password,
      database: cfg.samAttDb.database,
      charset: 'utf8mb4',
      dateStrings: true,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 4000,
      timezone: '+07:00',
    });
    mysqlPool.on('connection', (conn) => {
      conn.query('SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci');
    });
  }
  return mysqlPool;
}

/**
 * Translates MySQL DDL into SQLite-compatible relational DDL when executing migrations
 * in the local SQLite relational engine (strictly preserving all tables, columns, FKs, and unique constraints).
 */
function convertMysqlDdlToSqlite(sql: string): string {
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const converted: string[] = [];
  const extraIndexes: string[] = [];

  for (let stmt of statements) {
    const lines = stmt
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'));
    stmt = lines.join('\n').trim();
    if (!stmt) continue;
    if (/^SET\s+(NAMES|CHARACTER\s+SET)\b/i.test(stmt)) {
      continue;
    }

    const tableMatch = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)\s*\(([\s\S]*)\)\s*ENGINE=/i.exec(stmt);
    if (tableMatch) {
      const tableName = tableMatch[1];
      const body = tableMatch[2];
      const bodyLines = body
        .split('\n')
        .map((l) => l.trim().replace(/,$/, ''))
        .filter((l) => l.length > 0);

      const keepLines: string[] = [];
      for (const line of bodyLines) {
        const idxMatch = /^INDEX\s+(\w+)\s*\(([^)]+)\)$/i.exec(line);
        if (idxMatch) {
          extraIndexes.push(`CREATE INDEX IF NOT EXISTS ${idxMatch[1]} ON ${tableName} (${idxMatch[2]});`);
          continue;
        }
        const uqMatch = /^UNIQUE\s+KEY\s+(\w+)\s*\(([^)]+)\)$/i.exec(line);
        if (uqMatch) {
          keepLines.push(`CONSTRAINT ${uqMatch[1]} UNIQUE (${uqMatch[2]})`);
          continue;
        }
        const transformed = line
          .replace(/\bINT\s+AUTO_INCREMENT\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT')
          .replace(/\bTINYINT\(1\)/gi, 'INTEGER')
          .replace(/\bDATETIME\b/gi, 'TEXT')
          .replace(/\bDATE\b/gi, 'TEXT');
        keepLines.push(transformed);
      }

      converted.push(`CREATE TABLE IF NOT EXISTS ${tableName} (\n  ${keepLines.join(',\n  ')}\n);`);
    } else {
      const cleanedStmt = stmt
        .replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE[\s\S]*$/i, '')
        .replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT OR IGNORE INTO')
        .replace(/^INSERT\s+INTO/i, 'INSERT OR IGNORE INTO')
        .replace(/ENGINE=InnoDB[^;]*/gi, '')
        .trim();
      converted.push(cleanedStmt + ';');
    }
  }

  return [...converted, ...extraIndexes].join('\n');
}

export async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError('Simulated database outage');
  }

  const safeParams = params.map((p) => (p === undefined ? null : p));
  const cfg = loadConfig();
  if (cfg.dbEngine === 'mysql') {
    try {
      const pool = await getMysqlPool();
      const [rows] = await pool.execute(sql, safeParams as any[]);
      return rows as T[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Sam_Att DB Error] MySQL query failed: ${msg}`);
      throw new DatabaseUnavailableError(msg);
    }
  }

  try {
    const db = getSqliteInstance();
    const normalizedSql = sql.replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT OR IGNORE INTO');
    const stmt = db.prepare(normalizedSql);
    return stmt.all(...(safeParams as (string | number | null)[])) as T[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Sam_Att DB Error] SQL query execution failed: ${msg}`);
    throw new Error('เกิดข้อผิดพลาดในการประมวลผลคำสั่งฐานข้อมูล');
  }
}

export async function dbExecute(sql: string, params: unknown[] = []): Promise<QueryResultMeta> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError('Simulated database outage');
  }

  // บังคับใช้กฎ Append-Only สำหรับตาราง raw_scans (แก้ไข P1 ข้อ 08)
  assertRawScansImmutable(sql);

  const safeParams = params.map((p) => (p === undefined ? null : p));
  const cfg = loadConfig();
  if (cfg.dbEngine === 'mysql') {
    try {
      const pool = await getMysqlPool();
      const [result] = await pool.execute(sql, safeParams as any[]);
      const header = result as mysql.ResultSetHeader;
      return {
        insertId: header.insertId,
        affectedRows: header.affectedRows,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Sam_Att DB Error] MySQL execute failed: ${msg}`);
      throw new DatabaseUnavailableError(msg);
    }
  }

  const db = getSqliteInstance();
  const normalizedSql = sql.replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT OR IGNORE INTO');
  const stmt = db.prepare(normalizedSql);
  const res = stmt.run(...(safeParams as (string | number | null)[]));
  return {
    insertId: Number(res.lastInsertRowid),
    affectedRows: Number(res.changes),
  };
}

/**
 * รันชุดคำสั่งภายใต้ Database Transaction เดียวกัน (BEGIN -> COMMIT หรือ ROLLBACK เมื่อเกิดข้อผิดพลาด)
 * รองรับทั้ง MySQL Connection Transaction และ SQLite Transaction (แก้ไข P0 ข้อ 07 และ P1 ข้อ 16)
 */
export async function dbTransaction<T>(
  work: (tx: DbTransactionContext) => Promise<T>
): Promise<T> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError('Simulated database outage');
  }

  const cfg = loadConfig();
  if (cfg.dbEngine === 'mysql') {
    const pool = await getMysqlPool();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const txContext: DbTransactionContext = {
        query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
          const safeParams = params.map((p) => (p === undefined ? null : p));
          const [rows] = await conn.execute(sql, safeParams as any[]);
          return rows as R[];
        },
        execute: async (sql: string, params: unknown[] = []) => {
          assertRawScansImmutable(sql);
          const safeParams = params.map((p) => (p === undefined ? null : p));
          const [result] = await conn.execute(sql, safeParams as any[]);
          const header = result as mysql.ResultSetHeader;
          return {
            insertId: header.insertId,
            affectedRows: header.affectedRows,
          };
        },
      };
      const outcome = await work(txContext);
      await conn.commit();
      return outcome;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  const db = getSqliteInstance();
  db.exec('BEGIN IMMEDIATE TRANSACTION;');
  try {
    const txContext: DbTransactionContext = {
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        return dbQuery<R>(sql, params);
      },
      execute: async (sql: string, params: unknown[] = []) => {
        return dbExecute(sql, params);
      },
    };
    const outcome = await work(txContext);
    db.exec('COMMIT;');
    return outcome;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // ignore rollback if already rolled back
    }
    throw err;
  }
}

export async function checkPendingMigrationsReadOnly(): Promise<{
  appliedVersions: string[];
  pendingFiles: string[];
}> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError('Database unavailable during read-only migration check.');
  }

  const migrationsDir = path.resolve(process.cwd(), 'database/migrations');
  const allFiles = fs.existsSync(migrationsDir)
    ? fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort()
    : [];

  let appliedVersions: string[] = [];
  try {
    const rows = await dbQuery<{ version: string; filename: string }>(
      'SELECT version, filename FROM schema_migrations ORDER BY version ASC'
    );
    appliedVersions = rows.map((r) => String(r.version));
  } catch {
    appliedVersions = [];
  }

  const pendingFiles = allFiles.filter((file) => {
    const match = file.match(/^(\d+)_/);
    const ver = match ? match[1] : file;
    return !appliedVersions.includes(ver) && !appliedVersions.includes(file);
  });

  return {
    appliedVersions,
    pendingFiles,
  };
}

export async function runMigrations(): Promise<{ applied: string[]; totalTables: number }> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError('Database unavailable during migration check.');
  }

  const cfg = loadConfig();
  const migrationFile = path.resolve(process.cwd(), 'database/migrations/001_initial_schema.sql');
  const rawSql = fs.readFileSync(migrationFile, 'utf8');
  const checksum = crypto.createHash('sha256').update(rawSql).digest('hex');
  const applied: string[] = [];

  if (cfg.dbEngine === 'mysql') {
    const pool = await getMysqlPool();
    try {
      const [existing] = await pool.execute('SELECT version FROM schema_migrations WHERE version = ?', ['001']);
      if ((existing as unknown[]).length > 0) {
        return { applied: [], totalTables: 21 };
      }
    } catch {
      // schema_migrations does not exist yet
    }

    const isExplicitMigrateCli = process.argv.some((arg) => arg.includes('cli-migrate'));
    if (cfg.nodeEnv === 'production' && process.env.SAM_ATT_AUTO_MIGRATE !== 'true' && !isExplicitMigrateCli) {
      console.log(
        '[Sam_Att DB] Production safety policy: Skipping automatic DDL migration during server startup. Run `npm run db:migrate` with admin approval when schema changes are needed.'
      );
      return { applied: [], totalTables: 21 };
    }

    const statements = rawSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    const [existingAfter] = await pool.execute('SELECT version FROM schema_migrations WHERE version = ?', ['001']);
    if ((existingAfter as unknown[]).length === 0) {
      await pool.execute(
        'INSERT INTO schema_migrations (version, filename, checksum) VALUES (?, ?, ?)',
        ['001', '001_initial_schema.sql', checksum]
      );
      applied.push('001_initial_schema.sql');
    }
    return { applied, totalTables: 21 };
  }

  const db = getSqliteInstance();
  const sqliteSql = convertMysqlDdlToSqlite(rawSql);
  db.exec(sqliteSql);

  const existing = await dbQuery<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version = ?',
    ['001']
  );
  if (existing.length === 0) {
    await dbExecute(
      'INSERT INTO schema_migrations (version, filename, checksum) VALUES (?, ?, ?)',
      ['001', '001_initial_schema.sql', checksum]
    );
    applied.push('001_initial_schema.sql');
  }

  const tables = await dbQuery<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  );
  return { applied, totalTables: tables.length };
}

/**
 * ฟังก์ชันเตรียมข้อมูลตั้งต้นที่จำเป็นของระบบ (System Baseline Catalog):
 * - ปลอดภัยสำหรับทั้งโหมด REAL และโหมด DEMO (Idempotent 100%)
 * - บันทึกเฉพาะกฎประเภทบุคลากร 3 ประเภท, แม่แบบกะทำงานมาตรฐาน 5 กะ,
 *   เครื่องสแกนนิ้วจริงของ รพ.สามชุก (หมายเลข 1, 2, 3) และตารางเวลาซิงก์อัตโนมัติ (00:00, 08:00)
 * - หากตาราง users ยังว่างเปล่า จะสร้างบัญชีผู้ดูแลระบบเริ่มต้น 'admin' (โดยไม่ผูกกับบุคลากรจำลอง SAM-P001 ในโหมด REAL)
 * - ตรวจสอบและซ่อมแซมข้อความภาษาไทยของข้อมูลตั้งต้นที่อาจเพี้ยน (Mojibake เช่น "เธเธนเน...") จากการรัน SQL บน Windows ที่ไม่ได้ระบุ UTF-8
 */
export async function ensureBaselineSystemCatalog(): Promise<void> {
  // 0. Safe additive schema upgrades for existing databases (MySQL / SQLite)
  const additiveAlterStatements = [
    "ALTER TABLE personnel_type_rules ADD COLUMN default_start_time VARCHAR(5) NOT NULL DEFAULT '08:00'",
    "ALTER TABLE personnel_type_rules ADD COLUMN default_end_time VARCHAR(5) NOT NULL DEFAULT '16:00'",
    "ALTER TABLE personnel_type_rules ADD COLUMN default_cutoff_time VARCHAR(5) NOT NULL DEFAULT '11:00'",
    "ALTER TABLE personnel_type_rules ADD COLUMN effective_from DATE NOT NULL DEFAULT '2026-01-01'",
    'ALTER TABLE personnel_type_rules ADD COLUMN is_active TINYINT(1) NOT NULL DEFAULT 1',
  ];
  for (const alterSql of additiveAlterStatements) {
    try {
      await dbExecute(alterSql);
    } catch {
      // Column already exists
    }
  }

  const cfg = loadConfig();
  if (cfg.dbEngine === 'mysql') {
    await dbExecute(`
      CREATE TABLE IF NOT EXISTS personnel_type_rule_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        rule_id INT NOT NULL,
        personnel_type_code VARCHAR(64) NOT NULL,
        personnel_type_name VARCHAR(150) NOT NULL,
        default_start_time VARCHAR(5) NOT NULL,
        default_end_time VARCHAR(5) NOT NULL,
        default_grace_minutes INT NOT NULL,
        default_cutoff_time VARCHAR(5) NOT NULL,
        effective_from DATE NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        action_type VARCHAR(32) NOT NULL,
        changed_by VARCHAR(64) NOT NULL,
        changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ptrh_code_eff (personnel_type_code, effective_from)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await dbExecute(`
      CREATE TABLE IF NOT EXISTS shift_daily_overrides (
        id INT AUTO_INCREMENT PRIMARY KEY,
        person_id VARCHAR(64) NOT NULL,
        work_date DATE NOT NULL,
        override_state VARCHAR(32) NOT NULL,
        reason TEXT NULL,
        updated_by VARCHAR(64) NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_sdo_person_date (person_id, work_date),
        INDEX idx_sdo_date (work_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    await dbExecute(`
      CREATE TABLE IF NOT EXISTS shift_import_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        filename VARCHAR(255) NOT NULL,
        total_rows INT NOT NULL DEFAULT 0,
        valid_rows INT NOT NULL DEFAULT 0,
        invalid_rows INT NOT NULL DEFAULT 0,
        imported_count INT NOT NULL DEFAULT 0,
        skipped_count INT NOT NULL DEFAULT 0,
        imported_by VARCHAR(64) NOT NULL,
        summary_json LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
  }

  const baselineRules = [
    {
      code: 'CIVIL_SERVANT',
      name: 'ข้าราชการ',
      startTime: '08:00',
      endTime: '16:00',
      grace: 15,
      cutoffTime: '11:00',
      effectiveFrom: '2026-01-01',
      before: 120,
      after: 240,
      reqOut: 1,
      overlap: 0,
      version: 'v2.2.0-bkk',
    },
    {
      code: 'PUBLIC_HEALTH_EMP',
      name: 'พนักงานกระทรวงสาธารณสุข (พกส.)',
      startTime: '08:00',
      endTime: '16:00',
      grace: 15,
      cutoffTime: '11:00',
      effectiveFrom: '2026-01-01',
      before: 120,
      after: 240,
      reqOut: 1,
      overlap: 1,
      version: 'v2.2.0-bkk',
    },
    {
      code: 'TEMP_EMPLOYEE',
      name: 'ลูกจ้างชั่วคราว (รายเดือน/รายวัน)',
      startTime: '08:00',
      endTime: '16:00',
      grace: 10,
      cutoffTime: '11:00',
      effectiveFrom: '2026-01-01',
      before: 120,
      after: 240,
      reqOut: 1,
      overlap: 1,
      version: 'v2.2.0-bkk',
    },
    {
      code: 'GOV_EMPLOYEE',
      name: 'พนักงานราชการ',
      startTime: '08:00',
      endTime: '16:00',
      grace: 15,
      cutoffTime: '11:00',
      effectiveFrom: '2026-01-01',
      before: 120,
      after: 240,
      reqOut: 1,
      overlap: 0,
      version: 'v2.2.0-bkk',
    },
    {
      code: 'PERMANENT_EMP',
      name: 'ลูกจ้างประจำ',
      startTime: '07:30',
      endTime: '16:00',
      grace: 0,
      cutoffTime: '11:00',
      effectiveFrom: '2026-01-01',
      before: 120,
      after: 240,
      reqOut: 1,
      overlap: 0,
      version: 'v2.2.0-bkk',
    },
  ];

  for (const r of baselineRules) {
    await dbExecute(
      `INSERT IGNORE INTO personnel_type_rules (
        personnel_type_code, personnel_type_name, default_start_time, default_end_time,
        default_grace_minutes, default_cutoff_time, effective_from, is_active,
        CheckinWindowBeforeMinutes, CheckoutWindowAfterMinutes, require_checkout,
        allow_overlapping_shifts, rule_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        r.code,
        r.name,
        r.startTime,
        r.endTime,
        r.grace,
        r.cutoffTime,
        r.effectiveFrom,
        r.before,
        r.after,
        r.reqOut,
        r.overlap,
        r.version,
      ]
    );
    const existingRule = await dbQuery<{
      personnel_type_name: string;
      default_start_time: string | null;
      default_cutoff_time: string | null;
    }>(
      'SELECT personnel_type_name, default_start_time, default_cutoff_time FROM personnel_type_rules WHERE personnel_type_code = ? LIMIT 1',
      [r.code]
    );
    if (existingRule.length > 0) {
      if (hasThaiMojibake(existingRule[0].personnel_type_name)) {
        await dbExecute(
          'UPDATE personnel_type_rules SET personnel_type_name = ? WHERE personnel_type_code = ?',
          [r.name, r.code]
        );
      }
      if (!existingRule[0].default_start_time || !existingRule[0].default_cutoff_time) {
        await dbExecute(
          `UPDATE personnel_type_rules
           SET default_start_time = ?, default_end_time = ?, default_grace_minutes = ?, default_cutoff_time = ?
           WHERE personnel_type_code = ?`,
          [r.startTime, r.endTime, r.grace, r.cutoffTime, r.code]
        );
      }
    }
  }

  const baselineShifts = [
    { id: 1, code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', cat: 'OFFICIAL', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { id: 2, code: 'MOR-0816', name: 'กะเช้า (08:00–16:00)', cat: 'MORNING', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { id: 3, code: 'AFT-1600', name: 'กะบ่าย (16:00–00:00)', cat: 'AFTERNOON', start: '16:00', end: '00:00', grace: 15, cutoff: '18:30', cross: 1 },
    { id: 4, code: 'NIG-0008', name: 'กะดึก (00:00–08:00)', cat: 'NIGHT', start: '00:00', end: '08:00', grace: 15, cutoff: '02:30', cross: 0 },
    { id: 5, code: 'EXT-2008', name: 'กะพิเศษข้ามวัน 12 ชม. (20:00–08:00)', cat: 'SPECIAL', start: '20:00', end: '08:00', grace: 15, cutoff: '22:00', cross: 1 },
    { id: 6, code: 'MORAFT-0800', name: 'กะเช้า–บ่าย (08:00–00:00)', cat: 'SPECIAL', start: '08:00', end: '00:00', grace: 15, cutoff: '11:00', cross: 1 },
    { id: 7, code: 'AFTNIG-1608', name: 'กะบ่าย–ดึก (16:00–08:00)', cat: 'CROSS_MIDNIGHT', start: '16:00', end: '08:00', grace: 15, cutoff: '18:00', cross: 1 },
    { id: 8, code: 'FULL-0808', name: 'กะทั้งวัน (08:00–08:00)', cat: 'CROSS_MIDNIGHT', start: '08:00', end: '08:00', grace: 15, cutoff: '11:00', cross: 1 },
    { id: 9, code: 'MOR-0730', name: 'กะเช้าลูกจ้างประจำ (07:30–16:00)', cat: 'MORNING', start: '07:30', end: '16:00', grace: 0, cutoff: '11:00', cross: 0 },
  ];

  for (const s of baselineShifts) {
    await dbExecute(
      `INSERT IGNORE INTO shifts (
        id, shift_code, shift_name, shift_category, start_time, end_time,
        grace_minutes, cutoff_time, is_cross_midnight, checkin_window_before_min, checkout_window_after_min, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 120, 240, 1)`,
      [s.id, s.code, s.name, s.cat, s.start, s.end, s.grace, s.cutoff, s.cross]
    );
    const existingShift = await dbQuery<{ shift_name: string }>(
      'SELECT shift_name FROM shifts WHERE shift_code = ? LIMIT 1',
      [s.code]
    );
    if (existingShift.length > 0 && hasThaiMojibake(existingShift[0].shift_name)) {
      await dbExecute('UPDATE shifts SET shift_name = ? WHERE shift_code = ?', [s.name, s.code]);
    }
  }

  const realHospitalScanners = [
    { machineNo: 1, name: 'เครื่องสแกนนิ้ว รพ.สามชุก เครื่องที่ 1 (CMiF68S)', ip: '192.168.111.163', port: 5005, loc: 'จุดลงเวลาเครื่องที่ 1 (192.168.111.163)', status: 'READY' },
    { machineNo: 2, name: 'เครื่องสแกนนิ้ว รพ.สามชุก เครื่องที่ 2 (CMiF68S)', ip: '192.168.111.164', port: 5005, loc: 'จุดลงเวลาเครื่องที่ 2 (192.168.111.164)', status: 'READY' },
    { machineNo: 3, name: 'เครื่องสแกนนิ้ว รพ.สามชุก เครื่องที่ 3 (CMiF68S)', ip: '192.168.111.165', port: 5005, loc: 'จุดลงเวลาเครื่องที่ 3 (192.168.111.165)', status: 'READY' },
  ];

  for (const dev of realHospitalScanners) {
    await dbExecute(
      `INSERT IGNORE INTO scanner_devices (
        machine_no, device_name, ip_address, device_port, location_name, is_enabled, last_sync_status
      ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [dev.machineNo, dev.name, dev.ip, dev.port, dev.loc, dev.status]
    );
    const existingDev = await dbQuery<{ device_name: string; location_name: string }>(
      'SELECT device_name, location_name FROM scanner_devices WHERE machine_no = ? LIMIT 1',
      [dev.machineNo]
    );
    if (
      existingDev.length > 0 &&
      (hasThaiMojibake(existingDev[0].device_name) || hasThaiMojibake(existingDev[0].location_name))
    ) {
      await dbExecute(
        'UPDATE scanner_devices SET device_name = ?, location_name = ? WHERE machine_no = ?',
        [dev.name, dev.loc, dev.machineNo]
      );
    }
  }

  const baselineSchedules = [
    { id: 1, label: 'ซิงก์รอบเที่ยงคืนหลังปิดผลัดบ่าย', cron: '00:00' },
    { id: 2, label: 'ซิงก์รอบเช้าหลังเข้าเวรราชการ/เวรเช้า', cron: '08:00' },
  ];

  for (const sch of baselineSchedules) {
    await dbExecute(
      `INSERT IGNORE INTO sync_schedules (
        id, schedule_label, cron_time, is_enabled, updated_by
      ) VALUES (?, ?, ?, 1, 'system_baseline')`,
      [sch.id, sch.label, sch.cron]
    );
    const existingSch = await dbQuery<{ schedule_label: string }>(
      'SELECT schedule_label FROM sync_schedules WHERE id = ? LIMIT 1',
      [sch.id]
    );
    if (existingSch.length > 0 && hasThaiMojibake(existingSch[0].schedule_label)) {
      await dbExecute('UPDATE sync_schedules SET schedule_label = ? WHERE id = ?', [
        sch.label,
        sch.id,
      ]);
    }
  }

  // ซ่อมแซมชื่อที่แสดง (display_name) ของบัญชีผู้ใช้หากเกิด Mojibake จากการ Import SQL บน Windows
  const allUsers = await dbQuery<{ id: number; username: string; display_name: string }>(
    'SELECT id, username, display_name FROM users'
  );
  const canonicalUserNames: Record<string, string> = {
    admin: 'ผู้ดูแลระบบหลัก (System Admin)',
    hrstaff: 'เจ้าหน้าที่ทรัพยากรบุคคล (HR Staff)',
    user1003: 'นายวีระชัย สายตรง (บุคลากรทั่วไป)',
    user1004: 'น.ส.ชุติมา ใจดี (บุคลากรทั่วไป)',
  };

  for (const u of allUsers) {
    if (hasThaiMojibake(u.display_name)) {
      const repaired = repairThaiMojibakeIfCorrupted(
        u.display_name,
        canonicalUserNames[u.username] || 'ผู้ใช้งานระบบ'
      );
      if (repaired.wasCorrupted && repaired.text !== u.display_name) {
        await dbExecute('UPDATE users SET display_name = ? WHERE id = ?', [repaired.text, u.id]);
      }
    }
  }

  // ในโหมด REAL หากยังไม่มีบัญชีผู้ใช้ใดๆ เลย ให้สร้างเฉพาะบัญชี admin เริ่มต้น (ไม่ผูกกับบุคลากรจำลอง SAM-P001)
  if (cfg.dataMode === 'REAL' && allUsers.length === 0) {
    const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD || 'Admin@SamAtt2026';
    await dbExecute(
      `INSERT IGNORE INTO users (
        username, password_hash, display_name, role, approved_person_id, is_active
      ) VALUES ('admin', ?, 'ผู้ดูแลระบบหลัก (System Admin)', 'ADMIN', NULL, 1)`,
      [hashPassword(initialAdminPassword)]
    );
  }
}

/**
 * สร้างข้อมูลจำลอง (Synthetic Demo Data) สำหรับโหมด DEMO เท่านั้น:
 * - ห้ามทำงานเด็ดขาดหาก SAM_ATT_DATA_MODE !== 'DEMO' หรือ NODE_ENV === 'production' หรือใช้ฐานข้อมูล MySQL จริง
 */
export async function seedDemoSyntheticData(): Promise<{
  seeded: boolean;
  reason?: string;
}> {
  const cfg = loadConfig();
  if (cfg.nodeEnv === 'production' || cfg.dataMode !== 'DEMO' || cfg.dbEngine !== 'sqlite_sandbox') {
    return {
      seeded: false,
      reason: 'SKIPPED_REAL_MODE_OR_PRODUCTION',
    };
  }

  const demoScanners = [
    { id: 1, machineNo: 101, name: 'เครื่องสแกนอาคารผู้ป่วยนอก ชั้น 1 (Test)', ip: '192.168.10.101', port: 4370, loc: 'โถงเวชระเบียน OPD', status: 'READY_WAITING_EXE' },
    { id: 2, machineNo: 102, name: 'เครื่องสแกนอาคารอุบัติเหตุ-ฉุกเฉิน ER (Test)', ip: '192.168.10.102', port: 4370, loc: 'หน้าห้องฉุกเฉิน ER', status: 'READY_WAITING_EXE' },
    { id: 3, machineNo: 103, name: 'เครื่องสแกนอาคารผู้ป่วยในและบริหาร ชั้น 2 (Test)', ip: '192.168.10.103', port: 4370, loc: 'หน้ากลุ่มงานบริหารทั่วไป', status: 'READY_WAITING_EXE' },
  ];

  for (const dev of demoScanners) {
    await dbExecute(
      `INSERT IGNORE INTO scanner_devices (
        machine_no, device_name, ip_address, device_port, location_name, is_enabled, last_sync_status
      ) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [dev.machineNo, dev.name, dev.ip, dev.port, dev.loc, dev.status]
    );
  }

  const existingDemoPersonnel = await dbQuery<{ person_id: string }>(
    "SELECT person_id FROM personnel WHERE person_id = 'SAM-P001' LIMIT 1"
  );
  if (existingDemoPersonnel.length > 0) {
    return { seeded: false, reason: 'ALREADY_SEEDED' };
  }

  const syntheticPersonnel = [
    {
      person_id: 'SAM-P001',
      fingle_id: '1001',
      title_name: 'นพ.',
      first_name: 'กิตติพงศ์',
      last_name: 'เวชกิจบริรักษ์ (ข้อมูลทดสอบ)',
      full_name: 'นพ.กิตติพงศ์ เวชกิจบริรักษ์ (ข้อมูลทดสอบ)',
      position_name: 'นายแพทย์ชำนาญการ',
      department_code: 'DEP-OPD',
      department_name: 'กลุ่มงานการแพทย์ / ผู้ป่วยนอก (OPD)',
      work_group_name: 'กลุ่มงานการแพทย์',
      personnel_type_code: 'CIVIL_SERVANT',
      personnel_type_name: 'ข้าราชการ',
      is_active: 1,
      mapping_status: 'VALID',
      mapping_issue_detail: null,
    },
    {
      person_id: 'SAM-P002',
      fingle_id: '1002',
      title_name: 'พว.',
      first_name: 'ศิริพร',
      last_name: 'รัตนากร (ข้อมูลทดสอบ)',
      full_name: 'พว.ศิริพร รัตนากร (ข้อมูลทดสอบ)',
      position_name: 'พยาบาลวิชาชีพชำนาญการ',
      department_code: 'DEP-ER',
      department_name: 'กลุ่มงานการพยาบาล / อุบัติเหตุ-ฉุกเฉิน (ER)',
      work_group_name: 'กลุ่มงานการพยาบาล',
      personnel_type_code: 'CIVIL_SERVANT',
      personnel_type_name: 'ข้าราชการ',
      is_active: 1,
      mapping_status: 'VALID',
      mapping_issue_detail: null,
    },
    {
      person_id: 'SAM-P003',
      fingle_id: '1003',
      title_name: 'นาย',
      first_name: 'วีระชัย',
      last_name: 'สายตรง (ข้อมูลทดสอบ)',
      full_name: 'นายวีระชัย สายตรง (ข้อมูลทดสอบ)',
      position_name: 'เจ้าพนักงานเวชสถิติ',
      department_code: 'DEP-ADM',
      department_name: 'กลุ่มงานบริหารทั่วไป',
      work_group_name: 'กลุ่มงานบริหารทั่วไป',
      personnel_type_code: 'PUBLIC_HEALTH_EMP',
      personnel_type_name: 'พนักงานกระทรวงสาธารณสุข (พกส.)',
      is_active: 1,
      mapping_status: 'VALID',
      mapping_issue_detail: null,
    },
    {
      person_id: 'SAM-P004',
      fingle_id: '1004',
      title_name: 'น.ส.',
      first_name: 'ชุติมา',
      last_name: 'ใจดี (ข้อมูลทดสอบ)',
      full_name: 'น.ส.ชุติมา ใจดี (ข้อมูลทดสอบ)',
      position_name: 'นักวิชาการสาธารณสุข',
      department_code: 'DEP-OPD',
      department_name: 'กลุ่มงานการแพทย์ / ผู้ป่วยนอก (OPD)',
      work_group_name: 'กลุ่มงานการแพทย์',
      personnel_type_code: 'TEMP_EMPLOYEE',
      personnel_type_name: 'ลูกจ้างชั่วคราว (รายเดือน/รายวัน)',
      is_active: 1,
      mapping_status: 'VALID',
      mapping_issue_detail: null,
    },
    {
      person_id: 'SAM-P005',
      fingle_id: null,
      title_name: 'นาย',
      first_name: 'สมหมาย',
      last_name: 'รอลงลายนิ้วมือ (ข้อมูลทดสอบ)',
      full_name: 'นายสมหมาย รอลงลายนิ้วมือ (ข้อมูลทดสอบ)',
      position_name: 'พนักงานช่วยเหลือคนไข้',
      department_code: 'DEP-ER',
      department_name: 'กลุ่มงานการพยาบาล / อุบัติเหตุ-ฉุกเฉิน (ER)',
      work_group_name: 'กลุ่มงานการพยาบาล',
      personnel_type_code: 'TEMP_EMPLOYEE',
      personnel_type_name: 'ลูกจ้างชั่วคราว (รายเดือน/รายวัน)',
      is_active: 1,
      mapping_status: 'EMPTY_FINGLE_ID',
      mapping_issue_detail: 'ไม่พบรหัส FINGLE_ID ในตาราง hr_person ของ HOSOffice',
    },
  ];

  for (const p of syntheticPersonnel) {
    await dbExecute(
      `INSERT IGNORE INTO personnel (
        person_id, fingle_id, title_name, first_name, last_name, full_name,
        position_name, department_code, department_name, work_group_name,
        personnel_type_code, personnel_type_name, is_active, mapping_status, mapping_issue_detail
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.person_id,
        p.fingle_id,
        p.title_name,
        p.first_name,
        p.last_name,
        p.full_name,
        p.position_name,
        p.department_code,
        p.department_name,
        p.work_group_name,
        p.personnel_type_code,
        p.personnel_type_name,
        p.is_active,
        p.mapping_status,
        p.mapping_issue_detail,
      ]
    );

    if (p.fingle_id) {
      await dbExecute(
        `INSERT INTO fingerprint_mappings (
          person_id, fingle_id, effective_from, effective_to, conflict_state, source, created_by
        ) VALUES (?, ?, '2026-01-01', NULL, 'NONE', 'INITIAL_SEED', 'system')`,
        [p.person_id, p.fingle_id]
      );
    }
  }

  const accounts = [
    {
      username: 'admin',
      password: 'Admin@SamAtt2026',
      display_name: 'ผู้ดูแลระบบหลัก (System Admin)',
      role: 'ADMIN',
      approved_person_id: 'SAM-P001',
    },
    {
      username: 'hrstaff',
      password: 'Staff@SamAtt2026',
      display_name: 'เจ้าหน้าที่ทรัพยากรบุคคล (HR Staff)',
      role: 'RESPONSIBLE_STAFF',
      approved_person_id: 'SAM-P002',
    },
    {
      username: 'user1003',
      password: 'User@SamAtt2026',
      display_name: 'นายวีระชัย สายตรง (บุคลากรทั่วไป)',
      role: 'GENERAL_USER',
      approved_person_id: 'SAM-P003',
    },
    {
      username: 'user1004',
      password: 'User@SamAtt2026',
      display_name: 'น.ส.ชุติมา ใจดี (บุคลากรทั่วไป)',
      role: 'GENERAL_USER',
      approved_person_id: 'SAM-P004',
    },
  ];

  for (const acc of accounts) {
    await dbExecute(
      `INSERT IGNORE INTO users (
        username, password_hash, display_name, role, approved_person_id, is_active
      ) VALUES (?, ?, ?, ?, ?, 1)`,
      [acc.username, hashPassword(acc.password), acc.display_name, acc.role, acc.approved_person_id]
    );
  }

  const assignments = [
    { person_id: 'SAM-P001', shift_id: 1, work_date: '2026-11-12', code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { person_id: 'SAM-P002', shift_id: 2, work_date: '2026-11-12', code: 'MOR-0816', name: 'เวรเช้า (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { person_id: 'SAM-P003', shift_id: 1, work_date: '2026-11-12', code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { person_id: 'SAM-P004', shift_id: 1, work_date: '2026-11-12', code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { person_id: 'SAM-P001', shift_id: 1, work_date: '2026-11-13', code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { person_id: 'SAM-P002', shift_id: 5, work_date: '2026-11-12', code: 'EXT-2008', name: 'เวรข้ามวัน 12 ชม. (20:00–08:00)', start: '20:00', end: '08:00', grace: 15, cutoff: '22:00', cross: 1 },
    { person_id: 'SAM-P003', shift_id: 1, work_date: '2026-11-13', code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
    { person_id: 'SAM-P004', shift_id: 1, work_date: '2026-11-13', code: 'OFF-0816', name: 'เวรราชการปกติ (08:00–16:00)', start: '08:00', end: '16:00', grace: 15, cutoff: '10:30', cross: 0 },
  ];

  for (const a of assignments) {
    await dbExecute(
      `INSERT INTO shift_assignments (
        person_id, shift_id, work_date, snapshot_shift_code, snapshot_shift_name,
        snapshot_start_time, snapshot_end_time, snapshot_grace_minutes, snapshot_cutoff_time,
        snapshot_is_cross_midnight, status, assigned_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'hrstaff')`,
      [a.person_id, a.shift_id, a.work_date, a.code, a.name, a.start, a.end, a.grace, a.cutoff, a.cross]
    );
    await dbExecute(
      `INSERT IGNORE INTO shift_daily_overrides (person_id, work_date, override_state, reason, updated_by)
       VALUES (?, ?, 'CUSTOM_ASSIGNED', 'ข้อมูลตารางเวรตั้งต้น (Demo Seed)', 'hrstaff')`,
      [a.person_id, a.work_date]
    );
  }

  // SAM-P002 พักเวรในวันที่ 2026-11-13 หลังลงเวรดึกข้ามวัน และ SAM-P005 ยังไม่มีเวรในช่วงทดสอบ
  const demoClearedDays = [
    { person_id: 'SAM-P002', work_date: '2026-11-13', reason: 'วันหยุดพักเวรหลังลงกะข้ามเที่ยงคืน' },
    { person_id: 'SAM-P005', work_date: '2026-11-12', reason: 'รอผูก FINGLE_ID ก่อนจัดตารางเวร' },
    { person_id: 'SAM-P005', work_date: '2026-11-13', reason: 'รอผูก FINGLE_ID ก่อนจัดตารางเวร' },
  ];
  for (const cd of demoClearedDays) {
    await dbExecute(
      `INSERT IGNORE INTO shift_daily_overrides (person_id, work_date, override_state, reason, updated_by)
       VALUES (?, ?, 'CLEARED_ALL_SHIFTS', ?, 'hrstaff')`,
      [cd.person_id, cd.work_date, cd.reason]
    );
  }

  const syncRun = await dbExecute(
    `INSERT INTO sync_runs (
      trigger_mode, machine_no, started_at, finished_at, status,
      total_events_read, new_scans_inserted, duplicate_scans_skipped, unmatched_scans_count, triggered_by
    ) VALUES ('EXE_CONTRACT_HARNESS', 101, '2026-11-13 08:05:00', '2026-11-13 08:05:02', 'SUCCESS', 11, 11, 0, 1, 'hrstaff')`
  );

  const rawScanEvents = [
    { machineNo: 101, enrollNumber: '1001', scanDateTime: '2026-11-12 07:50:12', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P001', state: 'MATCHED' },
    { machineNo: 101, enrollNumber: '1001', scanDateTime: '2026-11-12 16:05:44', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P001', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-12 07:52:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-12 16:02:10', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-12 19:55:18', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-13 08:06:30', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-12 08:28:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-12 16:10:00', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    { machineNo: 101, enrollNumber: '1004', scanDateTime: '2026-11-12 08:22:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P004', state: 'MATCHED' },
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-13 08:35:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-13 16:05:00', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    { machineNo: 101, enrollNumber: '9999', scanDateTime: '2026-11-13 07:59:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: null, state: 'UNMATCHED' },
  ];

  for (const ev of rawScanEvents) {
    const { dedupKey, canonicalBkkTime } = computeRawScanDedupKey(ev);
    const payload = JSON.stringify({
      machineNo: ev.machineNo,
      enrollNumber: ev.enrollNumber,
      scanDateTime: ev.scanDateTime,
      verifyMode: ev.verifyMode,
      inOutMode: ev.inOutMode,
      workCode: ev.workCode,
    });
    const inserted = await dbExecute(
      `INSERT IGNORE INTO raw_scans (
        event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
        verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'IMMUTABLE_RAW', ?)`,
      [
        dedupKey,
        ev.machineNo,
        ev.enrollNumber,
        ev.scanDateTime,
        canonicalBkkTime,
        ev.verifyMode,
        ev.inOutMode,
        ev.workCode,
        payload,
        syncRun.insertId || 1,
      ]
    );
    if (inserted.insertId) {
      await dbExecute(
        `INSERT IGNORE INTO raw_scan_mappings (
          raw_scan_id, event_dedup_key, enroll_number, matched_person_id, mapping_state, mapping_rule_note
        ) VALUES (?, ?, ?, ?, ?, 'INITIAL_SEED_MAPPING')`,
        [inserted.insertId, dedupKey, ev.enrollNumber, ev.personId, ev.state]
      );
    }
  }

  await dbExecute(
    `INSERT INTO deployment_history (
      release_version, commit_sha, artifact_sha256, action_type, status,
      backup_archive_path, preflight_passed, notes, executed_by
    ) VALUES (
      '2.0.0-standalone', 'initial-standalone-build',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'INITIAL_INSTALL', 'SUCCESS',
      'C:\\inetpub\\wwwroot\\Sam_Att\\backups\\sam_att_v2_initial_20261113.bak',
      1, 'ติดตั้งระบบ Sam_Att V2 Standalone เบื้องต้น (HTTPS Port 4101)', 'admin'
    )`
  );

  return { seeded: true };
}

/**
 * ฟังก์ชันเตรียมข้อมูลระบบ:
 * - ในโหมด REAL: เตรียมเฉพาะข้อมูลตั้งต้นที่จำเป็นของระบบ (ensureBaselineSystemCatalog) ห้ามสร้างข้อมูลจำลองเด็ดขาด
 * - ในโหมด DEMO (เฉพาะการพัฒนา/ทดสอบบน sqlite_sandbox): เตรียมข้อมูลตั้งต้นพร้อมข้อมูลจำลองสำหรับการสาธิต
 */
export async function seedBaselineAndSyntheticData(): Promise<void> {
  await ensureBaselineSystemCatalog();
  const cfg = loadConfig();
  if (cfg.dataMode === 'DEMO' && cfg.nodeEnv !== 'production' && cfg.dbEngine === 'sqlite_sandbox') {
    await seedDemoSyntheticData();
  }
}

/**
 * ฟังก์ชันตรวจสอบข้อมูลจำลองตกค้างและปัญหาภาษาไทยเพี้ยน (Read-Only Data Integrity & Synthetic Data Audit)
 * ทำงานแบบอ่านอย่างเดียว (SELECT เท่านั้น) ห้ามลบ แก้ไข หรือ TRUNCATE ข้อมูลใดๆ ในฐานข้อมูล
 */
export async function inspectDatabaseIntegrityReadOnly() {
  const cfg = loadConfig();

  const syntheticPersonnel = await dbQuery<{
    person_id: string;
    full_name: string;
    fingle_id: string | null;
    department_name: string;
  }>(
    `SELECT person_id, full_name, fingle_id, department_name
     FROM personnel
     WHERE person_id IN ('SAM-P001', 'SAM-P002', 'SAM-P003', 'SAM-P004', 'SAM-P005')
        OR full_name LIKE '%(ข้อมูลทดสอบ)%'
     ORDER BY person_id ASC`
  );

  const syntheticUsers = await dbQuery<{
    id: number;
    username: string;
    display_name: string;
    role: string;
    approved_person_id: string | null;
  }>(
    `SELECT id, username, display_name, role, approved_person_id
     FROM users
     WHERE username IN ('hrstaff', 'user1003', 'user1004')
        OR approved_person_id IN ('SAM-P001', 'SAM-P002', 'SAM-P003', 'SAM-P004', 'SAM-P005')
     ORDER BY id ASC`
  );

  const syntheticScanners = await dbQuery<{
    id: number;
    machine_no: number;
    device_name: string;
    ip_address: string;
  }>(
    `SELECT id, machine_no, device_name, ip_address
     FROM scanner_devices
     WHERE machine_no IN (101, 102, 103)
        OR device_name LIKE '%(Test)%'
     ORDER BY machine_no ASC`
  );

  const syntheticRawScanCountRows = await dbQuery<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM raw_scans WHERE machine_no IN (101, 102, 103)`
  );
  const syntheticAssignmentCountRows = await dbQuery<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM shift_assignments WHERE person_id IN ('SAM-P001', 'SAM-P002', 'SAM-P003', 'SAM-P004', 'SAM-P005')`
  );
  const syntheticAttendanceCountRows = await dbQuery<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM attendance WHERE person_id IN ('SAM-P001', 'SAM-P002', 'SAM-P003', 'SAM-P004', 'SAM-P005')`
  );
  const syntheticFpMappingCountRows = await dbQuery<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM fingerprint_mappings WHERE person_id IN ('SAM-P001', 'SAM-P002', 'SAM-P003', 'SAM-P004', 'SAM-P005')`
  );

  // ตรวจสอบ Mojibake ในตารางสำคัญแบบ Read-Only
  const allUsers = await dbQuery<{ id: number; username: string; display_name: string }>(
    'SELECT id, username, display_name FROM users'
  );
  const allPersonnel = await dbQuery<{ person_id: string; full_name: string; department_name: string }>(
    'SELECT person_id, full_name, department_name FROM personnel'
  );
  const allShifts = await dbQuery<{ id: number; shift_code: string; shift_name: string }>(
    'SELECT id, shift_code, shift_name FROM shifts'
  );

  const mojibakeFindings: Array<{
    table: string;
    recordKey: string;
    column: string;
    corruptedValue: string;
    suggestedCleanValue: string;
  }> = [];

  for (const u of allUsers) {
    if (hasThaiMojibake(u.display_name)) {
      const rep = repairThaiMojibakeIfCorrupted(u.display_name);
      mojibakeFindings.push({
        table: 'users',
        recordKey: u.username,
        column: 'display_name',
        corruptedValue: u.display_name,
        suggestedCleanValue: rep.text,
      });
    }
  }

  for (const p of allPersonnel) {
    if (hasThaiMojibake(p.full_name)) {
      const rep = repairThaiMojibakeIfCorrupted(p.full_name);
      mojibakeFindings.push({
        table: 'personnel',
        recordKey: p.person_id,
        column: 'full_name',
        corruptedValue: p.full_name,
        suggestedCleanValue: rep.text,
      });
    }
    if (hasThaiMojibake(p.department_name)) {
      const rep = repairThaiMojibakeIfCorrupted(p.department_name);
      mojibakeFindings.push({
        table: 'personnel',
        recordKey: p.person_id,
        column: 'department_name',
        corruptedValue: p.department_name,
        suggestedCleanValue: rep.text,
      });
    }
  }

  for (const s of allShifts) {
    if (hasThaiMojibake(s.shift_name)) {
      const rep = repairThaiMojibakeIfCorrupted(s.shift_name);
      mojibakeFindings.push({
        table: 'shifts',
        recordKey: s.shift_code,
        column: 'shift_name',
        corruptedValue: s.shift_name,
        suggestedCleanValue: rep.text,
      });
    }
  }

  const syntheticRawScanCount = Number(syntheticRawScanCountRows[0]?.cnt || 0);
  const syntheticAssignmentCount = Number(syntheticAssignmentCountRows[0]?.cnt || 0);
  const syntheticAttendanceCount = Number(syntheticAttendanceCountRows[0]?.cnt || 0);
  const syntheticFpMappingCount = Number(syntheticFpMappingCountRows[0]?.cnt || 0);

  const hasSyntheticRecords =
    syntheticPersonnel.length > 0 ||
    syntheticUsers.length > 0 ||
    syntheticScanners.length > 0 ||
    syntheticRawScanCount > 0 ||
    syntheticAssignmentCount > 0 ||
    syntheticAttendanceCount > 0;

  return {
    inspectedAt: new Date().toISOString(),
    readOnlyMode: true,
    readOnlyInspection: true,
    dataMode: cfg.dataMode,
    dbEngine: cfg.dbEngine,
    hasSyntheticRecords,
    warningInRealMode: cfg.dataMode === 'REAL' && hasSyntheticRecords,
    syntheticSummary: {
      personnelCount: syntheticPersonnel.length,
      usersCount: syntheticUsers.length,
      scannerDevicesCount: syntheticScanners.length,
      fingerprintMappingsCount: syntheticFpMappingCount,
      shiftAssignmentsCount: syntheticAssignmentCount,
      attendanceCount: syntheticAttendanceCount,
      rawScansCount: syntheticRawScanCount,
    },
    syntheticRecordsFound: {
      personnelCount: syntheticPersonnel.length,
      testUsersCount: syntheticUsers.length,
      demoScannersCount: syntheticScanners.length,
      syntheticRawScansCount: syntheticRawScanCount,
      syntheticShiftAssignmentsCount: syntheticAssignmentCount,
      syntheticAttendanceCount: syntheticAttendanceCount,
    },
    syntheticRecords: {
      personnel: syntheticPersonnel,
      users: syntheticUsers,
      scannerDevices: syntheticScanners,
    },
    foreignKeyDependencies: [
      'users.approved_person_id -> personnel.person_id',
      'fingerprint_mappings.person_id -> personnel.person_id',
      'shift_assignments.person_id -> personnel.person_id',
      'attendance.person_id -> personnel.person_id',
      'attendance_notes.attendance_id -> attendance.id',
      'hr_review_history.attendance_id -> attendance.id',
      'raw_scan_mappings.raw_scan_id -> raw_scans.id (ตาราง raw_scans เป็น Immutable ห้าม DELETE โดยอัตโนมัติ)',
    ],
    mojibakeDetected: mojibakeFindings,
    mojibakeAudit: {
      corruptedCount: mojibakeFindings.length,
      findings: mojibakeFindings,
    },
    recommendation: hasSyntheticRecords
      ? `ตรวจพบบุคลากรจำลอง ${syntheticPersonnel.length} รายการ และสแกนดิบจำลอง ${syntheticRawScanCount} แถว ระบบทำงานแบบ Read-Only (ไม่รัน DELETE/TRUNCATE อัตโนมัติ) ในโหมด REAL แนะนำให้ใช้ฐานข้อมูล MySQL จริง (samchuk_attendance_v2) ที่สร้างจาก 001_initial_schema.sql + 001_real_system_baseline.sql`
      : 'ไม่พบข้อมูลบุคลากรจำลองหรือข้อความภาษาไทยเพี้ยนในฐานข้อมูลปัจจุบัน',
  };
}
