import { Router } from 'express';
import mysql from 'mysql2/promise';
import { loadConfig, isAutomatedTestRuntime } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import { repairThaiMojibakeIfCorrupted } from '../../utils/crypto.ts';
import {
  startCentralJob,
  updateCentralJobStep,
  completeCentralJob,
  failCentralJob,
} from '../jobs/tracker.ts';

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

// Test Double hooks strictly for automated integration tests (never enabled automatically in production)
let testDoubleHosOfficeRows: HosOfficeHrPersonRow[] | null = null;
let testDoubleForceOffline = false;
let testDoubleSchemaColumns: string[] | null = null;

export function setHosOfficeTestDouble(rows: HosOfficeHrPersonRow[] | null, forceOffline = false): void {
  testDoubleHosOfficeRows = rows;
  testDoubleForceOffline = forceOffline;
}

export function setHosOfficeSchemaColumnsForTests(columns: string[] | null): void {
  testDoubleSchemaColumns = columns;
}

const REQUIRED_HR_PERSON_COLUMN_GROUPS: Array<{ groupName: string; candidates: string[] }> = [
  { groupName: 'PERSON_ID', candidates: ['PERSON_ID', 'ID', 'HR_PERSON_ID', 'PERSON_CODE', 'HR_CID'] },
  { groupName: 'FINGLE_ID', candidates: ['FINGLE_ID', 'FINGER_ID', 'SCAN_ID', 'ENROLL_NUMBER', 'BADGE_NUMBER'] },
  { groupName: 'FIRST_NAME', candidates: ['FIRST_NAME', 'HR_FNAME', 'FNAME'] },
  { groupName: 'LAST_NAME', candidates: ['LAST_NAME', 'HR_LNAME', 'LNAME'] },
];

export function validateHosOfficeHrPersonColumnsContract(availableColumns: string[]): {
  valid: boolean;
  missingGroups: string[];
} {
  const upperSet = new Set(availableColumns.map((c) => c.trim().toUpperCase()));
  const missingGroups: string[] = [];
  for (const grp of REQUIRED_HR_PERSON_COLUMN_GROUPS) {
    const found = grp.candidates.some((cand) => upperSet.has(cand.toUpperCase()));
    if (!found) {
      missingGroups.push(`${grp.groupName} (ต้องมีคอลัมน์ใดคอลัมน์หนึ่ง: ${grp.candidates.join(', ')})`);
    }
  }
  return {
    valid: missingGroups.length === 0,
    missingGroups,
  };
}

interface HosOfficeLookupDictionaries {
  prefixes: Map<string, string>;
  departments: Map<string, string>;
  departmentSubs: Map<string, string>;
  personTypes: Map<string, string>;
  positions: Map<string, string>;
}

const DEFAULT_MOPH_PREFIX_MAP: Record<string, string> = {
  '1': 'นาย',
  '01': 'นาย',
  '001': 'นาย',
  '2': 'นาง',
  '02': 'นาง',
  '002': 'นาง',
  '3': 'นางสาว',
  '03': 'นางสาว',
  '003': 'นางสาว',
  '4': 'ว่าที่ ร.ต.',
  '04': 'ว่าที่ ร.ต.',
  '5': 'ดร.',
  '05': 'ดร.',
  '6': 'นพ.',
  '06': 'นพ.',
  '7': 'พญ.',
  '07': 'พญ.',
  '8': 'ทพ.',
  '08': 'ทพ.',
  '9': 'ทพญ.',
  '09': 'ทพญ.',
  '10': 'ภก.',
  '11': 'ภญ.',
};

const DEFAULT_MOPH_PERSON_TYPE_MAP: Record<string, { code: string; name: string }> = {
  '1': { code: 'CIVIL_SERVANT', name: 'ข้าราชการ' },
  '01': { code: 'CIVIL_SERVANT', name: 'ข้าราชการ' },
  '2': { code: 'PERMANENT_EMP', name: 'ลูกจ้างประจำ' },
  '02': { code: 'PERMANENT_EMP', name: 'ลูกจ้างประจำ' },
  '3': { code: 'GOV_EMPLOYEE', name: 'พนักงานราชการ' },
  '03': { code: 'GOV_EMPLOYEE', name: 'พนักงานราชการ' },
  '4': { code: 'PUBLIC_HEALTH_EMP', name: 'พนักงานกระทรวงสาธารณสุข (พกส.)' },
  '04': { code: 'PUBLIC_HEALTH_EMP', name: 'พนักงานกระทรวงสาธารณสุข (พกส.)' },
  '5': { code: 'TEMP_EMP', name: 'ลูกจ้างชั่วคราว' },
  '05': { code: 'TEMP_EMP', name: 'ลูกจ้างชั่วคราว' },
  '6': { code: 'DAILY_EMP', name: 'ลูกจ้างรายวัน' },
  '06': { code: 'DAILY_EMP', name: 'ลูกจ้างรายวัน' },
};

function pickField(raw: Record<string, unknown>, candidates: string[], fallback = ''): string {
  for (const key of candidates) {
    const val = raw[key] ?? raw[key.toLowerCase()] ?? raw[key.toUpperCase()];
    if (val !== undefined && val !== null && String(val).trim() !== '' && String(val).trim() !== '-') {
      return repairThaiMojibakeIfCorrupted(String(val).trim(), fallback).text;
    }
  }
  return fallback;
}

function lookupByCode(map: Map<string, string> | undefined, code: string): string {
  if (!map || !code) return '';
  const trimmed = code.trim();
  const stripped = trimmed.replace(/^0+/, '') || '0';
  return map.get(trimmed) || map.get(stripped) || map.get(stripped.padStart(2, '0')) || '';
}

export function normalizeHosOfficeRow(
  raw: Record<string, unknown>,
  lookups?: HosOfficeLookupDictionaries
): HosOfficeHrPersonRow {
  const personId = pickField(raw, ['PERSON_ID', 'ID', 'HR_PERSON_ID', 'PERSON_CODE', 'HR_CID']);
  const fingleRaw = pickField(raw, ['FINGLE_ID', 'FINGER_ID', 'SCAN_ID', 'ENROLL_NUMBER', 'BADGE_NUMBER']);

  // 1. คำนำหน้าชื่อ (Title / Prefix): แปลงรหัสตัวเลข (เช่น 01, 02, 03) เป็นคำนำหน้าภาษาไทย และห้ามนำตัวเลขดิบไปต่อหน้าชื่อ
  const explicitTitle = pickField(raw, ['TITLE_NAME', 'HR_PREFIX_NAME', 'PREFIX_NAME', 'PNAME']);
  const rawPrefixId = pickField(raw, ['HR_PREFIX_ID', 'PREFIX_ID', 'TITLE_NAME']);
  let titleName = explicitTitle;
  if (!titleName || /^\d+$/.test(titleName)) {
    const fromDbLookup = lookupByCode(lookups?.prefixes, rawPrefixId);
    const fromDefaultMap = DEFAULT_MOPH_PREFIX_MAP[rawPrefixId] || DEFAULT_MOPH_PREFIX_MAP[rawPrefixId.replace(/^0+/, '')];
    titleName = fromDbLookup || fromDefaultMap || '';
  }
  if (/^\d+$/.test(titleName)) {
    titleName = '';
  }

  const firstName = pickField(raw, ['FIRST_NAME', 'HR_FNAME', 'FNAME']);
  const lastName = pickField(raw, ['LAST_NAME', 'HR_LNAME', 'LNAME']);

  // 2. ตำแหน่ง (Position)
  const rawPosText = pickField(raw, ['POSITION_NAME', 'POSITION_IN_WORK', 'HR_POSITION_NAME']);
  const rawPosId = pickField(raw, ['HR_POSITION_ID', 'POSITION_ID']);
  let positionName = rawPosText;
  if (!positionName || /^\d+$/.test(positionName)) {
    positionName = lookupByCode(lookups?.positions, rawPosId || rawPosText) || (rawPosText && !/^\d+$/.test(rawPosText) ? rawPosText : 'ไม่ระบุตำแหน่ง');
  }

  // 3. กลุ่มงานหลัก (Department)
  const deptCode = pickField(raw, ['DEPARTMENT_CODE', 'HR_DEPARTMENT_ID', 'DEPT_CODE'], 'DEP-GEN');
  const explicitDeptName = pickField(raw, ['DEPARTMENT_NAME', 'HR_DEPARTMENT_NAME', 'DEPT_NAME']);
  let deptName = explicitDeptName || lookupByCode(lookups?.departments, deptCode);
  if (!deptName || /^\d+$/.test(deptName)) {
    deptName = deptCode && deptCode !== 'DEP-GEN' ? `กลุ่มงาน (${deptCode})` : 'ไม่ระบุกลุ่มงาน';
  }

  // 4. หน่วยงานย่อย (Work Group / Department Sub)
  const rawSubId = pickField(raw, ['HR_DEPARTMENT_SUB_ID', 'HR_DEPARTMENT_SUB_SUB_ID']);
  const explicitWorkGroup = pickField(raw, ['WORK_GROUP_NAME', 'HR_DEPARTMENT_SUB_NAME', 'HR_DEPARTMENT_SUB_SUB_NAME']);
  let workGroupName = explicitWorkGroup || lookupByCode(lookups?.departmentSubs, rawSubId);
  if (!workGroupName || /^\d+$/.test(workGroupName)) {
    workGroupName = rawSubId ? `หน่วยงาน (${rawSubId})` : deptName;
  }

  // 5. ประเภทบุคลากร (Personnel Type)
  const rawTypeId = pickField(raw, ['PERSONNEL_TYPE_CODE', 'HR_PERSON_TYPE_ID', 'PERSON_TYPE_CODE'], 'CIVIL_SERVANT');
  const explicitTypeName = pickField(raw, ['PERSONNEL_TYPE_NAME', 'HR_PERSON_TYPE_NAME', 'PERSON_TYPE_NAME']);
  const dbTypeName = lookupByCode(lookups?.personTypes, rawTypeId);
  const mappedType = DEFAULT_MOPH_PERSON_TYPE_MAP[rawTypeId] || DEFAULT_MOPH_PERSON_TYPE_MAP[rawTypeId.replace(/^0+/, '')];

  const personnelTypeCode = mappedType ? mappedType.code : rawTypeId;
  let personnelTypeName = explicitTypeName && !/^\d+$/.test(explicitTypeName)
    ? explicitTypeName
    : dbTypeName || (mappedType ? mappedType.name : rawTypeId);

  if (/^\d+$/.test(personnelTypeName)) {
    personnelTypeName = `ประเภทบุคลากร (${personnelTypeName})`;
  }

  const rawStatus = raw['IS_ACTIVE'] ?? raw['is_active'] ?? raw['HR_STATUS_ID'] ?? raw['hr_status_id'] ?? 1;
  const statusStr = String(rawStatus).trim();
  const isActive = statusStr === '1' || statusStr === '01' || statusStr.toUpperCase() === 'ACTIVE' || statusStr.toUpperCase() === 'TRUE' ? 1 : 0;

  return {
    PERSON_ID: personId,
    FINGLE_ID: fingleRaw ? fingleRaw : null,
    TITLE_NAME: titleName ? titleName : null,
    FIRST_NAME: firstName,
    LAST_NAME: lastName,
    POSITION_NAME: positionName,
    DEPARTMENT_CODE: deptCode,
    DEPARTMENT_NAME: deptName,
    WORK_GROUP_NAME: workGroupName,
    PERSONNEL_TYPE_CODE: personnelTypeCode,
    PERSONNEL_TYPE_NAME: personnelTypeName,
    IS_ACTIVE: isActive,
  };
}

async function loadOptionalLookupTable(
  conn: mysql.Connection,
  tableName: string,
  idCandidates: string[],
  nameCandidates: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const [rows] = await conn.query(`SELECT * FROM ${tableName}`);
    if (Array.isArray(rows)) {
      for (const r of rows as Record<string, unknown>[]) {
        const idVal = pickField(r, idCandidates);
        const nameVal = pickField(r, nameCandidates);
        if (idVal && nameVal) {
          map.set(idVal, nameVal);
          map.set(idVal.replace(/^0+/, '') || '0', nameVal);
          map.set(idVal.padStart(2, '0'), nameVal);
        }
      }
    }
  } catch {
    // Ignore if optional lookup table does not exist or user only has SELECT on hr_person
  }
  return map;
}

/**
 * Fetches hr_person rows from HOSOffice Read-Only MySQL database.
 * Fails closed with BLOCKED_BY_EXTERNAL_CONTRACT if:
 * 1. HOSOFFICE_DB_HOST / credentials are unconfigured ('CHANGE_ME')
 * 2. Running in automated test runtime without an explicit test double (prevents accidental connection to production HOSOffice DB)
 * 3. External table schema in HOSOffice does not satisfy required column contract (verified BEFORE touching internal tables)
 */
async function fetchFromHosOfficeReadOnly(): Promise<HosOfficeHrPersonRow[]> {
  if (testDoubleForceOffline) {
    const err = new Error('HOSOffice MySQL Server Unreachable (Simulated Offline)');
    (err as Error & { code?: string }).code = 'HOSOFFICE_DB_UNAVAILABLE';
    throw err;
  }

  if (testDoubleSchemaColumns !== null) {
    const contractCheck = validateHosOfficeHrPersonColumnsContract(testDoubleSchemaColumns);
    if (!contractCheck.valid) {
      const err = new Error(
        `BLOCKED_BY_EXTERNAL_CONTRACT: โครงสร้างตาราง hr_person ของ HOSOffice ไม่ตรงตามสัญญาเชื่อมต่อ (ไม่พบคอลัมน์: ${contractCheck.missingGroups.join('; ')})`
      );
      (err as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
      throw err;
    }
  }

  if (testDoubleHosOfficeRows !== null) {
    return testDoubleHosOfficeRows;
  }

  const cfg = loadConfig();
  if (
    isAutomatedTestRuntime() ||
    cfg.nodeEnv === 'test' ||
    !cfg.hosofficeDb.host ||
    cfg.hosofficeDb.host === 'CHANGE_ME' ||
    !cfg.hosofficeDb.user ||
    !cfg.hosofficeDb.password ||
    cfg.hosofficeDb.password === 'CHANGE_ME' ||
    !cfg.hosofficeDb.hrPersonTable
  ) {
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

    // ตรวจสอบ External Contract ของตาราง hr_person จาก INFORMATION_SCHEMA.COLUMNS ก่อนเข้าถึงข้อมูลหรือแก้ไขตารางภายใน
    const [colRows] = await conn.execute(
      `SELECT COLUMN_NAME AS column_name
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [cfg.hosofficeDb.database, table]
    );
    const colList = Array.isArray(colRows)
      ? (colRows as Array<{ column_name?: string; COLUMN_NAME?: string }>).map(
          (c) => String(c.column_name ?? c.COLUMN_NAME ?? '')
        )
      : [];

    if (colList.length === 0) {
      const err = new Error(
        `BLOCKED_BY_EXTERNAL_CONTRACT: ไม่พบตาราง ${table} หรือไม่มีสิทธิ์อ่านโครงสร้างตารางในฐานข้อมูล HOSOffice (${cfg.hosofficeDb.database})`
      );
      (err as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
      throw err;
    }

    const contractCheck = validateHosOfficeHrPersonColumnsContract(colList);
    if (!contractCheck.valid) {
      const err = new Error(
        `BLOCKED_BY_EXTERNAL_CONTRACT: โครงสร้างตาราง ${table} ของ HOSOffice ไม่ครบตามสัญญาเชื่อมต่อ (ไม่พบคอลัมน์: ${contractCheck.missingGroups.join('; ')})`
      );
      (err as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
      throw err;
    }

    // โหลดตารางอ้างอิง (Lookup Tables) ของ HOSOffice หากมีสิทธิ์อ่าน เพื่อแปลงรหัสตัวเลขเป็นชื่อภาษาไทยจริง
    const [prefixes, departments, departmentSubs, personTypes, positions] = await Promise.all([
      loadOptionalLookupTable(conn, 'hr_prefix', ['HR_PREFIX_ID', 'PREFIX_ID', 'ID'], ['HR_PREFIX_NAME', 'PREFIX_NAME', 'NAME']),
      loadOptionalLookupTable(conn, 'hr_department', ['HR_DEPARTMENT_ID', 'DEPARTMENT_ID', 'ID'], ['HR_DEPARTMENT_NAME', 'DEPARTMENT_NAME', 'NAME']),
      loadOptionalLookupTable(conn, 'hr_department_sub', ['HR_DEPARTMENT_SUB_ID', 'DEPARTMENT_SUB_ID', 'ID'], ['HR_DEPARTMENT_SUB_NAME', 'DEPARTMENT_SUB_NAME', 'NAME']),
      loadOptionalLookupTable(conn, 'hr_person_type', ['HR_PERSON_TYPE_ID', 'PERSON_TYPE_ID', 'ID'], ['HR_PERSON_TYPE_NAME', 'PERSON_TYPE_NAME', 'NAME']),
      loadOptionalLookupTable(conn, 'hr_position', ['HR_POSITION_ID', 'POSITION_ID', 'ID'], ['HR_POSITION_NAME', 'POSITION_NAME', 'NAME']),
    ]);

    const lookups: HosOfficeLookupDictionaries = {
      prefixes,
      departments,
      departmentSubs,
      personTypes,
      positions,
    };

    const [rows] = await conn.query(`SELECT * FROM ${table}`);
    const rawList = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    return rawList.map((r) => normalizeHosOfficeRow(r, lookups)).filter((r) => Boolean(r.PERSON_ID));
  } catch (err: unknown) {
    const rawCode = (err as { code?: string })?.code || '';
    if (rawCode === 'ER_BAD_FIELD_ERROR' || rawCode === 'ER_NO_SUCH_TABLE' || rawCode === 'ER_TABLEACCESS_DENIED_ERROR') {
      const contractErr = new Error(
        `BLOCKED_BY_EXTERNAL_CONTRACT: ตาราง ${cfg.hosofficeDb.hrPersonTable} ในฐานข้อมูล HOSOffice มีโครงสร้างคอลัมน์หรือสิทธิ์ไม่ตรงตามสัญญาเชื่อมต่อ (${rawCode})`
      );
      (contractErr as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
      throw contractErr;
    }
    throw err;
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
  async (req, res, _next) => {
    const actor = req.user!.username;
    const effectiveDate = String(req.body?.effectiveDate || new Date().toISOString().slice(0, 10));

    let trackedJobId: string | null = null;
    try {
      const job = startCentralJob({
        jobType: 'HOSOFFICE_PERSONNEL_SYNC',
        actorUsername: actor,
        initialStep: 'กำลังเชื่อมต่อฐานข้อมูล HOSOffice และตรวจสอบโครงสร้างตาราง hr_person...',
      });
      trackedJobId = job.jobId;
    } catch (lockErr: unknown) {
      const activeJob = (lockErr as { activeJob?: unknown })?.activeJob;
      res.status(409).json({
        error: 'SYNC_ALREADY_RUNNING',
        message: 'กำลังซิงก์ข้อมูลบุคลากรจาก HOSOffice อยู่แล้ว กรุณารอให้เสร็จสิ้นก่อน',
        activeJob,
        requestId: req.requestId,
      });
      return;
    }

    try {
      const externalRows = await fetchFromHosOfficeReadOnly();

      if (trackedJobId) {
        updateCentralJobStep(trackedJobId, {
          currentStep: `ดึงรายชื่อจาก HOSOffice สำเร็จ (${externalRows.length} รายการ) กำลังอัปเดตทะเบียนบุคลากร...`,
          processedCount: 0,
          totalCount: externalRows.length,
        });
      }

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
        if (trackedJobId && (upsertedCount % 25 === 0 || upsertedCount === externalRows.length)) {
          updateCentralJobStep(trackedJobId, {
            currentStep: `กำลังอัปเดตทะเบียนบุคลากร (${upsertedCount}/${externalRows.length} คน) โดยคงตารางเวรเดิมไว้ครบถ้วน...`,
            processedCount: upsertedCount,
            totalCount: externalRows.length,
          });
        }
      }

      await dbExecute(
        `INSERT INTO hosoffice_sync_logs (
          finished_at, status, records_fetched, records_upserted, mapping_conflicts_found, triggered_by
        ) VALUES (CURRENT_TIMESTAMP, 'SUCCESS', ?, ?, ?, ?)`,
        [externalRows.length, upsertedCount, conflictsFound, actor]
      );

      if (trackedJobId) {
        completeCentralJob(trackedJobId, {
          currentStep: 'ซิงก์ข้อมูลบุคลากรจาก HOSOffice เสร็จสมบูรณ์',
          processedCount: upsertedCount,
          totalCount: externalRows.length,
          resultSummary: {
            recordsFetched: externalRows.length,
            recordsUpserted: upsertedCount,
            mappingConflictsFound: conflictsFound,
            effectiveDate,
          },
        });
      }

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
        jobId: trackedJobId,
        recordsFetched: externalRows.length,
        recordsUpserted: upsertedCount,
        mappingConflictsFound: conflictsFound,
        effectiveDate,
      });
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code || 'HOSOFFICE_SYNC_FAILED';
      const message = err instanceof Error ? err.message : String(err);

      if (trackedJobId) {
        failCentralJob(trackedJobId, {
          currentStep: 'การซิงก์ข้อมูลบุคลากรจาก HOSOffice ล้มเหลว',
          errorCode: code,
          errorMessage: message,
        });
      }

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
        jobId: trackedJobId,
        failClosed: true,
        requestId: req.requestId,
      });
    }
  }
);
