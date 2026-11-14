import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../config/env.ts';
import { hashPassword, computeRawScanDedupKey } from '../utils/crypto.ts';

export class DatabaseUnavailableError extends Error {
  public readonly code = 'DB_UNAVAILABLE';
  public readonly statusCode = 503;
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseUnavailableError';
  }
}

export interface QueryResultMeta {
  insertId?: number;
  affectedRows?: number;
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

function getSqliteInstance(): DatabaseSync {
  const cfg = loadConfig();
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
  if (!mysqlPool) {
    mysqlPool = mysql.createPool({
      host: cfg.samAttDb.host,
      port: cfg.samAttDb.port,
      user: cfg.samAttDb.user,
      password: cfg.samAttDb.password,
      database: cfg.samAttDb.database,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 4000,
      timezone: '+07:00',
    });
  }
  return mysqlPool;
}

/**
 * Translates MySQL DDL into SQLite-compatible relational DDL when executing migrations
 * in the local SQLite relational engine (strictly preserving all 20 tables, columns, FKs, and unique constraints).
 */
function convertMysqlDdlToSqlite(sql: string): string {
  const statements = sql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const converted: string[] = [];
  const extraIndexes: string[] = [];

  for (let stmt of statements) {
    // Strip leading comment lines
    const lines = stmt
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'));
    stmt = lines.join('\n').trim();
    if (!stmt) continue;

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
      converted.push(
        stmt
          .replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT OR IGNORE INTO')
          .replace(/ENGINE=InnoDB[^;]*/gi, '') + ';'
      );
    }
  }

  return [...converted, ...extraIndexes].join('\n');
}

export async function dbQuery<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError(
      'ไม่สามารถเชื่อมต่อฐานข้อมูลหลัก Sam_Att ได้ (Fail-Closed Mode: ห้ามใช้ข้อมูลจำลอง)'
    );
  }

  const cfg = loadConfig();
  if (cfg.dbEngine === 'mysql') {
    try {
      const pool = await getMysqlPool();
      const [rows] = await pool.execute(sql, params as any[]);
      return rows as T[];
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseUnavailableError(
        `MySQL Connection Failed (${cfg.samAttDb.host}:${cfg.samAttDb.port}/${cfg.samAttDb.database}): ${msg}`
      );
    }
  }

  // sqlite_sandbox relational engine
  try {
    const db = getSqliteInstance();
    const normalizedSql = sql.replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT OR IGNORE INTO');
    const stmt = db.prepare(normalizedSql);
    const safeParams = params.map((p) => (p === undefined ? null : p)) as (string | number | null)[];
    return stmt.all(...safeParams) as T[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`SQL Execution Error: ${msg}`);
  }
}

export async function dbExecute(sql: string, params: unknown[] = []): Promise<QueryResultMeta> {
  if (simulatedDown) {
    throw new DatabaseUnavailableError(
      'ไม่สามารถเชื่อมต่อฐานข้อมูลหลัก Sam_Att ได้ (Fail-Closed Mode: ห้ามใช้ข้อมูลจำลอง)'
    );
  }

  const cfg = loadConfig();
  if (cfg.dbEngine === 'mysql') {
    try {
      const pool = await getMysqlPool();
      const [result] = await pool.execute(sql, params as any[]);
      const header = result as mysql.ResultSetHeader;
      return {
        insertId: header.insertId,
        affectedRows: header.affectedRows,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new DatabaseUnavailableError(
        `MySQL Execution Failed (${cfg.samAttDb.host}:${cfg.samAttDb.port}/${cfg.samAttDb.database}): ${msg}`
      );
    }
  }

  const db = getSqliteInstance();
  const normalizedSql = sql.replace(/INSERT\s+IGNORE\s+INTO/gi, 'INSERT OR IGNORE INTO');
  const stmt = db.prepare(normalizedSql);
  const safeParams = params.map((p) => (p === undefined ? null : p)) as (string | number | null)[];
  const res = stmt.run(...safeParams);
  return {
    insertId: Number(res.lastInsertRowid),
    affectedRows: Number(res.changes),
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
    const statements = rawSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      await pool.query(stmt);
    }
    const [existing] = await pool.execute('SELECT version FROM schema_migrations WHERE version = ?', ['001']);
    if ((existing as unknown[]).length === 0) {
      await pool.execute(
        'INSERT INTO schema_migrations (version, filename, checksum) VALUES (?, ?, ?)',
        ['001', '001_initial_schema.sql', checksum]
      );
      applied.push('001_initial_schema.sql');
    }
    return { applied, totalTables: 20 };
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
 * Seeds baseline rules, shifts, scanners, and synthetic non-PII accounts/records
 * in non-production environments so the system can be verified end-to-end.
 */
export async function seedBaselineAndSyntheticData(): Promise<void> {
  const cfg = loadConfig();
  if (cfg.nodeEnv === 'production') {
    return;
  }

  const seedFile = path.resolve(process.cwd(), 'database/seeds/001_synthetic_test_seed.sql');
  if (fs.existsSync(seedFile)) {
    const seedSql = fs.readFileSync(seedFile, 'utf8');
    if (cfg.dbEngine === 'sqlite_sandbox') {
      const db = getSqliteInstance();
      db.exec(convertMysqlDdlToSqlite(seedSql));
    }
  }

  // Check if users already exist
  const existingUsers = await dbQuery<{ id: number }>('SELECT id FROM users LIMIT 1');
  if (existingUsers.length > 0) {
    return;
  }

  // Insert synthetic non-PII personnel records representing HOSOffice synced snapshot
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

  // Seed 3 role accounts (ADMIN, RESPONSIBLE_STAFF, GENERAL_USER)
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

  // Seed sample shift assignments for 2026-11-12 and 2026-11-13
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
  }

  // Create an initial sync_run record for synthetic EXE test harness import
  const syncRun = await dbExecute(
    `INSERT INTO sync_runs (
      trigger_mode, machine_no, started_at, finished_at, status,
      total_events_read, new_scans_inserted, duplicate_scans_skipped, unmatched_scans_count, triggered_by
    ) VALUES ('EXE_CONTRACT_HARNESS', 101, '2026-11-13 08:05:00', '2026-11-13 08:05:02', 'SUCCESS', 11, 11, 0, 1, 'hrstaff')`
  );

  // Seed 6-field Raw Scan events strictly following the EXE Contract
  const rawScanEvents = [
    // 2026-11-12: SAM-P001 (1001) NORMAL (07:50 - 16:05)
    { machineNo: 101, enrollNumber: '1001', scanDateTime: '2026-11-12 07:50:12', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P001', state: 'MATCHED' },
    { machineNo: 101, enrollNumber: '1001', scanDateTime: '2026-11-12 16:05:44', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P001', state: 'MATCHED' },
    // 2026-11-12: SAM-P002 (1002) Morning NORMAL + Night Cross-Midnight (19:55 -> 2026-11-13 08:06)
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-12 07:52:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-12 16:02:10', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-12 19:55:18', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    { machineNo: 102, enrollNumber: '1002', scanDateTime: '2026-11-13 08:06:30', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P002', state: 'MATCHED' },
    // 2026-11-12: SAM-P003 (1003) LATE (08:28 - 16:10, 28 mins late)
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-12 08:28:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-12 16:10:00', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    // 2026-11-12: SAM-P004 (1004) MISSING_CHECKOUT + LATE (08:22 in, no checkout)
    { machineNo: 101, enrollNumber: '1004', scanDateTime: '2026-11-12 08:22:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P004', state: 'MATCHED' },
    // 2026-11-13: SAM-P003 (1003) LATE again (08:35 in, 16:05 out -> 35 mins late)
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-13 08:35:00', verifyMode: 1, inOutMode: 0, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    { machineNo: 103, enrollNumber: '1003', scanDateTime: '2026-11-13 16:05:00', verifyMode: 1, inOutMode: 1, workCode: 0, personId: 'SAM-P003', state: 'MATCHED' },
    // Unmatched scan from unknown enrollNumber 9999
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
    await dbExecute(
      `INSERT IGNORE INTO raw_scans (
        event_dedup_key, machine_no, enroll_number, scan_date_time, canonical_bkk_time,
        verify_mode, in_out_mode, work_code, raw_payload_json, matched_person_id, mapping_state, sync_run_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        ev.personId,
        ev.state,
        syncRun.insertId || 1,
      ]
    );
  }

  // Record initial deployment baseline entry
  await dbExecute(
    `INSERT INTO deployment_history (
      release_version, commit_sha, artifact_sha256, action_type, status,
      backup_archive_path, preflight_passed, notes, executed_by
    ) VALUES (
      '2.0.0-standalone', 'initial-standalone-build',
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'INITIAL_INSTALL', 'SUCCESS',
      'C:\\Sam_Att\\backups\\sam_att_v2_initial_20261113.bak',
      1, 'ติดตั้งระบบ Sam_Att V2 Standalone เบื้องต้น (HTTPS Port 4101)', 'admin'
    )`
  );
}
