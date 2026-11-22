import { Router } from 'express';
import mysql from 'mysql2/promise';
import { loadConfig, isAutomatedTestRuntime } from '../../config/env.ts';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import {
  repairThaiMojibakeIfCorrupted,
  getCurrentBangkokDateParts,
} from '../../utils/crypto.ts';
import {
  startCentralJob,
  updateCentralJobStep,
  completeCentralJob,
  failCentralJob,
} from '../jobs/tracker.ts';
import { normalizeWorkDateString } from '../shifts/routes.ts';
import { addDaysYmd } from '../attendance/matchingEngine.ts';
import {
  resolveRawScanPersonnelMappings,
  reprocessAttendanceRange,
  normalizeBkkTimestamp,
} from '../attendance/processor.ts';
import { verifyActorReauthentication } from '../auth/reauth.ts';
import {
  assertRoleAuthorizedForDateRange,
  isValidYmdDate,
  ScannerSyncRangeError,
} from '../scanners/syncRange.ts';

export const ACTIVE_HR_STATUS_ID = '01';

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
  HR_STATUS_ID?: string | null;
}

export interface HosOfficeVerifiedStatusRecord {
  personId: string;
  foundInSource: boolean;
  hrStatusId: string | null;
  isActiveInSource: boolean;
}

export interface HosOfficeFetchResult {
  activeRows: HosOfficeHrPersonRow[];
  verifiedStatuses: Map<string, HosOfficeVerifiedStatusRecord>;
  sourceVerificationExecuted: boolean;
  sourceVerificationWarning: string | null;
  activeSqlExecuted: string;
}

// Test Double hooks strictly for automated integration tests (never enabled automatically in production)
let testDoubleHosOfficeRows: HosOfficeHrPersonRow[] | null = null;
let testDoubleForceOffline = false;
let testDoubleFailStatusVerification = false;
let testDoubleSchemaColumns: string[] | null = null;

export function setHosOfficeTestDouble(
  rows: HosOfficeHrPersonRow[] | null,
  forceOffline = false,
  options?: { failStatusVerification?: boolean }
): void {
  testDoubleHosOfficeRows = rows;
  testDoubleForceOffline = forceOffline;
  testDoubleFailStatusVerification = Boolean(options?.failStatusVerification);
}

export function setHosOfficeSchemaColumnsForTests(columns: string[] | null): void {
  testDoubleSchemaColumns = columns;
}

const PERSON_ID_COLUMN_CANDIDATES = ['PERSON_ID', 'ID', 'HR_PERSON_ID', 'PERSON_CODE', 'HR_CID'];

const REQUIRED_HR_PERSON_COLUMN_GROUPS: Array<{ groupName: string; candidates: string[] }> = [
  { groupName: 'PERSON_ID', candidates: PERSON_ID_COLUMN_CANDIDATES },
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

export function resolveHosOfficeHrPersonMeta(availableColumns: string[]): {
  personIdColumn: string | null;
  hasHrStatusIdColumn: boolean;
} {
  const normalizedByUpper = new Map<string, string>();
  for (const col of availableColumns) {
    const trimmed = col.trim();
    if (/^[A-Za-z0-9_]+$/.test(trimmed)) {
      normalizedByUpper.set(trimmed.toUpperCase(), trimmed);
    }
  }
  let personIdColumn: string | null = null;
  for (const cand of PERSON_ID_COLUMN_CANDIDATES) {
    const match = normalizedByUpper.get(cand);
    if (match) {
      personIdColumn = match;
      break;
    }
  }
  return {
    personIdColumn,
    hasHrStatusIdColumn: normalizedByUpper.has('HR_STATUS_ID'),
  };
}

export function isActiveHrStatusId(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return String(value).trim() === ACTIVE_HR_STATUS_ID;
}

export function normalizeHrStatusId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

export function buildActiveHrPersonSelectSql(tableName: string): string {
  const safeTable = String(tableName || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeTable) {
    throw new Error('INVALID_HOSOFFICE_TABLE_NAME');
  }
  return `SELECT * FROM ${safeTable} WHERE HR_STATUS_ID = '${ACTIVE_HR_STATUS_ID}'`;
}

export function buildVerifyHrStatusSelectSql(
  tableName: string,
  personIdColumn: string,
  idCount: number
): string {
  const safeTable = String(tableName || '').replace(/[^a-zA-Z0-9_]/g, '');
  const safePersonIdCol = String(personIdColumn || '').replace(/[^a-zA-Z0-9_]/g, '');
  if (!safeTable) {
    throw new Error('INVALID_HOSOFFICE_TABLE_NAME');
  }
  if (!safePersonIdCol || !PERSON_ID_COLUMN_CANDIDATES.includes(safePersonIdCol.toUpperCase())) {
    throw new Error('INVALID_HOSOFFICE_PERSON_ID_COLUMN');
  }
  if (!Number.isInteger(idCount) || idCount <= 0) {
    throw new Error('INVALID_STATUS_CHECK_BATCH_SIZE');
  }
  const placeholders = Array.from({ length: idCount }, () => '?').join(', ');
  return `SELECT ${safePersonIdCol} AS PERSON_ID, HR_STATUS_ID FROM ${safeTable} WHERE ${safePersonIdCol} IN (${placeholders})`;
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

  const hasHrStatusKey = 'HR_STATUS_ID' in raw || 'hr_status_id' in raw;
  let hrStatusId: string | null;
  let isActive: number;

  if (hasHrStatusKey) {
    hrStatusId = normalizeHrStatusId(raw['HR_STATUS_ID'] ?? raw['hr_status_id']);
    isActive = isActiveHrStatusId(hrStatusId) ? 1 : 0;
  } else {
    const rawStatus = raw['IS_ACTIVE'] ?? raw['is_active'] ?? 1;
    const statusStr = String(rawStatus).trim();
    isActive =
      statusStr === '1' ||
      statusStr === '01' ||
      statusStr.toUpperCase() === 'ACTIVE' ||
      statusStr.toUpperCase() === 'TRUE'
        ? 1
        : 0;
    hrStatusId = isActive === 1 ? ACTIVE_HR_STATUS_ID : null;
  }

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
    HR_STATUS_ID: hrStatusId,
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
 * Fetches active hr_person rows (WHERE HR_STATUS_ID = '01') from HOSOffice Read-Only MySQL database,
 * and verifies source HR_STATUS_ID strictly Read-Only for any previously-synced active personnel
 * missing from the '01' result set (so we NEVER guess Inactive without verifying the source row).
 *
 * Fails closed with BLOCKED_BY_EXTERNAL_CONTRACT if:
 * 1. HOSOFFICE_DB_HOST / credentials are unconfigured ('CHANGE_ME')
 * 2. Running in automated test runtime without an explicit test double (prevents accidental connection to production HOSOffice DB)
 * 3. External table schema in HOSOffice does not satisfy required column contract including HR_STATUS_ID (verified BEFORE touching internal tables)
 */
export async function fetchFromHosOfficeReadOnly(
  existingActivePersonIds: string[] = []
): Promise<HosOfficeFetchResult> {
  if (testDoubleForceOffline) {
    const err = new Error('HOSOffice MySQL Server Unreachable (Simulated Offline)');
    (err as Error & { code?: string }).code = 'HOSOFFICE_DB_UNAVAILABLE';
    throw err;
  }

  if (testDoubleSchemaColumns !== null) {
    const contractCheck = validateHosOfficeHrPersonColumnsContract(testDoubleSchemaColumns);
    const metaCheck = resolveHosOfficeHrPersonMeta(testDoubleSchemaColumns);
    if (!contractCheck.valid || !metaCheck.hasHrStatusIdColumn || !metaCheck.personIdColumn) {
      const missingDetails = [...contractCheck.missingGroups];
      if (!metaCheck.hasHrStatusIdColumn) {
        missingDetails.push('HR_STATUS_ID (จำเป็นสำหรับคัดกรองบุคลากรสถานะทำงานปกติ = 01)');
      }
      const err = new Error(
        `BLOCKED_BY_EXTERNAL_CONTRACT: โครงสร้างตาราง hr_person ของ HOSOffice ไม่ตรงตามสัญญาเชื่อมต่อ (ไม่พบคอลัมน์: ${missingDetails.join('; ')})`
      );
      (err as Error & { code?: string }).code = 'BLOCKED_BY_EXTERNAL_CONTRACT';
      throw err;
    }
  }

  if (testDoubleHosOfficeRows !== null) {
    const activeSqlExecuted = buildActiveHrPersonSelectSql('hr_person');
    const sourceById = new Map<string, { row: HosOfficeHrPersonRow; hrStatusId: string | null }>();
    const activeRows: HosOfficeHrPersonRow[] = [];

    for (const row of testDoubleHosOfficeRows) {
      const pid = String(row.PERSON_ID || '').trim();
      if (!pid) continue;
      const hasHrStatus = 'HR_STATUS_ID' in row;
      const hrStatusId = hasHrStatus
        ? normalizeHrStatusId(row.HR_STATUS_ID)
        : Number(row.IS_ACTIVE) === 1
          ? ACTIVE_HR_STATUS_ID
          : null;
      sourceById.set(pid, { row, hrStatusId });
      if (isActiveHrStatusId(hrStatusId)) {
        activeRows.push({
          ...row,
          PERSON_ID: pid,
          IS_ACTIVE: 1,
          HR_STATUS_ID: ACTIVE_HR_STATUS_ID,
        });
      }
    }

    const fetchedIdSet = new Set(activeRows.map((r) => r.PERSON_ID));
    const missingIds = existingActivePersonIds
      .map((id) => String(id).trim())
      .filter((id) => Boolean(id) && !fetchedIdSet.has(id));

    const verifiedStatuses = new Map<string, HosOfficeVerifiedStatusRecord>();
    if (missingIds.length > 0 && testDoubleFailStatusVerification) {
      return {
        activeRows,
        verifiedStatuses,
        sourceVerificationExecuted: false,
        sourceVerificationWarning:
          'ไม่สามารถตรวจสอบสถานะ HR_STATUS_ID ต้นทางจาก HOSOffice ได้ ระบบจึงคงสถานะบุคลากรเดิมไว้โดยไม่ปรับเป็นไม่ปฏิบัติงาน',
        activeSqlExecuted,
      };
    }

    for (const pid of missingIds) {
      const match = sourceById.get(pid);
      if (match) {
        verifiedStatuses.set(pid, {
          personId: pid,
          foundInSource: true,
          hrStatusId: match.hrStatusId,
          isActiveInSource: isActiveHrStatusId(match.hrStatusId),
        });
      } else {
        verifiedStatuses.set(pid, {
          personId: pid,
          foundInSource: false,
          hrStatusId: null,
          isActiveInSource: false,
        });
      }
    }

    return {
      activeRows,
      verifiedStatuses,
      sourceVerificationExecuted: true,
      sourceVerificationWarning: null,
      activeSqlExecuted,
    };
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
    const hrPersonMeta = resolveHosOfficeHrPersonMeta(colList);
    if (!contractCheck.valid || !hrPersonMeta.hasHrStatusIdColumn || !hrPersonMeta.personIdColumn) {
      const missingDetails = [...contractCheck.missingGroups];
      if (!hrPersonMeta.hasHrStatusIdColumn) {
        missingDetails.push('HR_STATUS_ID (จำเป็นสำหรับคัดกรองบุคลากรสถานะทำงานปกติ = 01)');
      }
      const err = new Error(
        `BLOCKED_BY_EXTERNAL_CONTRACT: โครงสร้างตาราง ${table} ของ HOSOffice ไม่ครบตามสัญญาเชื่อมต่อ (ไม่พบคอลัมน์: ${missingDetails.join('; ')})`
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

    // ดึงเฉพาะบุคลากรที่มีสถานะทำงานปกติจาก hosoffice.hr_person (WHERE HR_STATUS_ID = '01') แบบ Read-Only
    const activeSqlExecuted = buildActiveHrPersonSelectSql(table);
    const [rows] = await conn.query(activeSqlExecuted);
    const rawList = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    const activeRows = rawList
      .map((r) => normalizeHosOfficeRow(r, lookups))
      .filter((r) => Boolean(r.PERSON_ID) && isActiveHrStatusId(r.HR_STATUS_ID));

    // ตรวจสอบสถานะต้นทางจริง (Read-Only) สำหรับบุคลากรที่เคยซิงก์ไว้แล้วแต่ไม่พบในผล Query HR_STATUS_ID = '01'
    const fetchedIdSet = new Set(activeRows.map((r) => String(r.PERSON_ID).trim()));
    const missingIds = Array.from(
      new Set(
        existingActivePersonIds
          .map((id) => String(id).trim())
          .filter((id) => Boolean(id) && !fetchedIdSet.has(id))
      )
    );

    const verifiedStatuses = new Map<string, HosOfficeVerifiedStatusRecord>();
    let sourceVerificationExecuted = true;
    let sourceVerificationWarning: string | null = null;

    if (missingIds.length > 0) {
      try {
        const CHUNK_SIZE = 200;
        const foundStatusById = new Map<string, string | null>();
        for (let i = 0; i < missingIds.length; i += CHUNK_SIZE) {
          const chunk = missingIds.slice(i, i + CHUNK_SIZE);
          const verifySql = buildVerifyHrStatusSelectSql(
            table,
            hrPersonMeta.personIdColumn,
            chunk.length
          );
          const [statusRows] = await conn.execute(verifySql, chunk);
          if (Array.isArray(statusRows)) {
            for (const sr of statusRows as Record<string, unknown>[]) {
              const pid = String(sr['PERSON_ID'] ?? sr['person_id'] ?? '').trim();
              if (!pid) continue;
              const statusVal = normalizeHrStatusId(sr['HR_STATUS_ID'] ?? sr['hr_status_id']);
              foundStatusById.set(pid, statusVal);
            }
          }
        }

        for (const pid of missingIds) {
          if (foundStatusById.has(pid)) {
            const verifiedStatus = foundStatusById.get(pid) ?? null;
            verifiedStatuses.set(pid, {
              personId: pid,
              foundInSource: true,
              hrStatusId: verifiedStatus,
              isActiveInSource: isActiveHrStatusId(verifiedStatus),
            });
          } else {
            verifiedStatuses.set(pid, {
              personId: pid,
              foundInSource: false,
              hrStatusId: null,
              isActiveInSource: false,
            });
          }
        }
      } catch (verifyErr: unknown) {
        // หากตรวจสอบสถานะต้นทางไม่สำเร็จ ห้ามคาดเดาหรือปรับบุคลากรเป็น Inactive
        sourceVerificationExecuted = false;
        sourceVerificationWarning = `ไม่สามารถตรวจสอบสถานะ HR_STATUS_ID ต้นทางจาก HOSOffice ได้ ระบบจึงคงสถานะบุคลากรเดิมไว้ (${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)})`;
      }
    }

    return {
      activeRows,
      verifiedStatuses,
      sourceVerificationExecuted,
      sourceVerificationWarning,
      activeSqlExecuted,
    };
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

interface HistoricalMappingConflictItem {
  mappingId: number;
  personId: string;
  fullName: string | null;
  fingleId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  conflictState: string;
}

async function analyzeRetroactiveMappingImpact(
  mappingId: number,
  proposedEffectiveFrom: string,
  proposedEffectiveTo: string | null
) {
  const targetRows = await dbQuery<{
    id: number;
    person_id: string;
    fingle_id: string;
    effective_from: unknown;
    effective_to: unknown;
    original_effective_from: unknown;
    conflict_state: string;
    conflict_reason: string | null;
    source: string;
    full_name: string | null;
    department_name: string | null;
  }>(
    `SELECT fm.*, p.full_name, p.department_name
     FROM fingerprint_mappings fm
     LEFT JOIN personnel p ON p.person_id = fm.person_id
     WHERE fm.id = ? LIMIT 1`,
    [mappingId]
  );

  if (targetRows.length === 0) {
    return null;
  }

  const target = targetRows[0];
  const fingleId = String(target.fingle_id || '').trim();
  const currentEffectiveFrom = normalizeWorkDateString(target.effective_from);
  const currentEffectiveTo =
    target.effective_to !== null &&
    target.effective_to !== undefined &&
    String(target.effective_to).trim() !== ''
      ? normalizeWorkDateString(target.effective_to)
      : null;

  const otherMappingsRaw = await dbQuery<{
    id: number;
    person_id: string;
    fingle_id: string;
    effective_from: unknown;
    effective_to: unknown;
    conflict_state: string;
    full_name: string | null;
  }>(
    `SELECT fm.id, fm.person_id, fm.fingle_id, fm.effective_from, fm.effective_to, fm.conflict_state, p.full_name
     FROM fingerprint_mappings fm
     LEFT JOIN personnel p ON p.person_id = fm.person_id
     WHERE TRIM(fm.fingle_id) = ? AND fm.id != ?`,
    [fingleId, mappingId]
  );

  const proposedEndBound = proposedEffectiveTo || '9999-12-31';
  const conflicts: HistoricalMappingConflictItem[] = [];
  const otherNormalized = otherMappingsRaw.map((m) => ({
    id: Number(m.id),
    personId: String(m.person_id || '').trim(),
    fullName: m.full_name || null,
    fingleId: String(m.fingle_id || '').trim(),
    effectiveFrom: normalizeWorkDateString(m.effective_from),
    effectiveTo:
      m.effective_to !== null && m.effective_to !== undefined && String(m.effective_to).trim() !== ''
        ? normalizeWorkDateString(m.effective_to)
        : null,
    conflictState: String(m.conflict_state || 'NONE').trim().toUpperCase(),
  }));

  for (const other of otherNormalized) {
    const otherEndBound = other.effectiveTo || '9999-12-31';
    if (proposedEffectiveFrom <= otherEndBound && other.effectiveFrom <= proposedEndBound) {
      conflicts.push({
        mappingId: other.id,
        personId: other.personId,
        fullName: other.fullName,
        fingleId: other.fingleId,
        effectiveFrom: other.effectiveFrom,
        effectiveTo: other.effectiveTo,
        conflictState: other.conflictState,
      });
    }
  }

  const scans = await dbQuery<{
    id: number;
    canonical_bkk_time: unknown;
    mapping_state: string | null;
    matched_person_id: string | null;
  }>(
    `SELECT rs.id, rs.canonical_bkk_time, rsm.mapping_state, rsm.matched_person_id
     FROM raw_scans rs
     LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
     WHERE TRIM(rs.enroll_number) = ?
     ORDER BY rs.canonical_bkk_time ASC, rs.id ASC`,
    [fingleId]
  );

  let willBecomeMatchedCount = 0;
  let alreadyMatchedCount = 0;
  let willBecomeUnmatchedCount = 0;
  let blockedByConflictCount = 0;
  let outOfRangeRemainingUnmatchedCount = 0;
  let earliestScanDate: string | null = null;
  let latestScanDate: string | null = null;
  const affectedDates = new Set<string>();

  for (const s of scans) {
    const scanDate = normalizeBkkTimestamp(s.canonical_bkk_time).slice(0, 10);
    if (!scanDate) continue;
    if (!earliestScanDate || scanDate < earliestScanDate) earliestScanDate = scanDate;
    if (!latestScanDate || scanDate > latestScanDate) latestScanDate = scanDate;

    const inProposed =
      scanDate >= proposedEffectiveFrom &&
      (!proposedEffectiveTo || scanDate <= proposedEffectiveTo);
    const inCurrent =
      scanDate >= currentEffectiveFrom &&
      (!currentEffectiveTo || scanDate <= currentEffectiveTo);
    const currentState = String(s.mapping_state || 'UNMATCHED').toUpperCase();
    const otherCoversDate = otherNormalized.some(
      (o) => scanDate >= o.effectiveFrom && (!o.effectiveTo || scanDate <= o.effectiveTo)
    );

    if (inProposed) {
      if (otherCoversDate || String(target.conflict_state || 'NONE').toUpperCase() !== 'NONE') {
        blockedByConflictCount++;
      } else if (
        currentState === 'MATCHED' &&
        String(s.matched_person_id || '').trim() === String(target.person_id).trim()
      ) {
        alreadyMatchedCount++;
      } else {
        willBecomeMatchedCount++;
        affectedDates.add(scanDate);
      }
    } else if (inCurrent && currentState === 'MATCHED') {
      willBecomeUnmatchedCount++;
      affectedDates.add(scanDate);
    } else if (currentState !== 'MATCHED') {
      outOfRangeRemainingUnmatchedCount++;
    }
  }

  const sortedAffected = Array.from(affectedDates).sort();
  const targetHasConflictState =
    String(target.conflict_state || 'NONE').trim().toUpperCase() !== 'NONE';
  const canApprove = conflicts.length === 0 && !targetHasConflictState;

  return {
    mapping: {
      id: Number(target.id),
      personId: String(target.person_id).trim(),
      fullName: target.full_name || null,
      departmentName: target.department_name || null,
      fingleId,
      currentEffectiveFrom,
      currentEffectiveTo,
      originalEffectiveFrom: target.original_effective_from
        ? normalizeWorkDateString(target.original_effective_from)
        : currentEffectiveFrom,
      conflictState: String(target.conflict_state || 'NONE').toUpperCase(),
      conflictReason: target.conflict_reason,
      source: target.source,
    },
    proposedEffectiveFrom,
    proposedEffectiveTo,
    canApprove,
    blockReason: !canApprove
      ? targetHasConflictState
        ? `รายการจับคู่นี้มีสถานะความขัดแย้ง (${target.conflict_state}) อยู่แล้ว ไม่สามารถอนุมัติย้อนหลังได้จนกว่าจะแก้ไขความซ้ำซ้อน`
        : `พบรหัส FINGLE_ID ${fingleId} ซ้อนทับกับบุคลากรรายอื่นในช่วงวันที่ที่ขอปรับ (${conflicts.length} รายการ) ระบบไม่อนุญาตให้บังคับจับคู่ทับซ้อน`
      : null,
    conflicts,
    totalRawScansForFingleId: scans.length,
    willBecomeMatchedCount,
    alreadyMatchedCount,
    willBecomeUnmatchedCount,
    blockedByConflictCount,
    outOfRangeRemainingUnmatchedCount,
    earliestScanDate,
    latestScanDate,
    affectedDateFrom: sortedAffected[0] ?? null,
    affectedDateTo: sortedAffected[sortedAffected.length - 1] ?? null,
    impactSummary: {
      totalRawScansForFingleId: scans.length,
      willBecomeMatchedCount,
      alreadyMatchedCount,
      willBecomeUnmatchedCount,
      blockedByConflictCount,
      outOfRangeRemainingUnmatchedCount,
      earliestScanDate,
      latestScanDate,
      affectedDateFrom: sortedAffected[0] ?? null,
      affectedDateTo: sortedAffected[sortedAffected.length - 1] ?? null,
    },
  };
}

async function loadMappingHistoryWithUnmatchedStats() {
  const mappingHistory = await dbQuery<{
    id: number;
    person_id: string;
    fingle_id: string;
    effective_from: unknown;
    effective_to: unknown;
    original_effective_from?: unknown;
    retroactive_adjusted_by?: string | null;
    retroactive_adjusted_at?: string | null;
    retroactive_reason?: string | null;
    conflict_state: string;
    conflict_reason: string | null;
    source: string;
    created_by: string | null;
    created_at: string;
    full_name: string | null;
    department_name: string | null;
  }>(
    `SELECT fm.*, p.full_name, p.department_name
     FROM fingerprint_mappings fm
     LEFT JOIN personnel p ON p.person_id = fm.person_id
     ORDER BY fm.id DESC`
  );

  const scanAggRows = await dbQuery<{
    enroll_number: string;
    canonical_bkk_time: unknown;
    mapping_state: string | null;
  }>(
    `SELECT rs.enroll_number, rs.canonical_bkk_time, COALESCE(rsm.mapping_state, 'UNMATCHED') AS mapping_state
     FROM raw_scans rs
     LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id`
  );

  const scansByFingle = new Map<string, Array<{ scanDate: string; state: string }>>();
  for (const r of scanAggRows) {
    const fid = String(r.enroll_number || '').trim();
    const scanDate = normalizeBkkTimestamp(r.canonical_bkk_time).slice(0, 10);
    if (!fid || !scanDate) continue;
    const list = scansByFingle.get(fid) || [];
    list.push({ scanDate, state: String(r.mapping_state || 'UNMATCHED').toUpperCase() });
    scansByFingle.set(fid, list);
  }

  return mappingHistory.map((m) => {
    const fid = String(m.fingle_id || '').trim();
    const effFrom = normalizeWorkDateString(m.effective_from);
    const effTo =
      m.effective_to !== null && m.effective_to !== undefined && String(m.effective_to).trim() !== ''
        ? normalizeWorkDateString(m.effective_to)
        : null;
    const allScans = scansByFingle.get(fid) || [];
    let unmatchedBeforeEffectiveCount = 0;
    let earliestUnmatchedDate: string | null = null;
    let latestUnmatchedDate: string | null = null;
    for (const s of allScans) {
      if (s.state !== 'MATCHED' && s.scanDate < effFrom) {
        unmatchedBeforeEffectiveCount++;
        if (!earliestUnmatchedDate || s.scanDate < earliestUnmatchedDate) {
          earliestUnmatchedDate = s.scanDate;
        }
        if (!latestUnmatchedDate || s.scanDate > latestUnmatchedDate) {
          latestUnmatchedDate = s.scanDate;
        }
      }
    }
    return {
      ...m,
      effective_from: effFrom,
      effective_to: effTo,
      original_effective_from: m.original_effective_from
        ? normalizeWorkDateString(m.original_effective_from)
        : null,
      total_scans_for_fingle_id: allScans.length,
      unmatched_before_effective_count: unmatchedBeforeEffectiveCount,
      earliest_unmatched_date: earliestUnmatchedDate,
      latest_unmatched_date: latestUnmatchedDate,
    };
  });
}

personnelRouter.get(
  '/personnel/mapping-issues',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const personnelIssues = await dbQuery(
        "SELECT * FROM personnel WHERE mapping_status != 'VALID' ORDER BY person_id ASC"
      );
      const mappingHistory = await loadMappingHistoryWithUnmatchedStats();
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

personnelRouter.get(
  '/personnel/mappings',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (_req, res, next) => {
    try {
      const items = await loadMappingHistoryWithUnmatchedStats();
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

personnelRouter.post(
  '/personnel/mappings/:id/retroactive-preview',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const mappingId = Number(req.params.id);
      if (!Number.isInteger(mappingId) || mappingId <= 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รหัสการจับคู่ลายนิ้วมือไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const proposedEffectiveFrom = String(req.body?.proposedEffectiveFrom || '').trim();
      const rawProposedTo = req.body?.proposedEffectiveTo;
      const proposedEffectiveTo =
        rawProposedTo !== undefined && rawProposedTo !== null && String(rawProposedTo).trim() !== ''
          ? String(rawProposedTo).trim()
          : null;

      if (!isValidYmdDate(proposedEffectiveFrom)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุวันที่มีผลใหม่ (proposedEffectiveFrom) ในรูปแบบ YYYY-MM-DD ที่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      if (proposedEffectiveTo && !isValidYmdDate(proposedEffectiveTo)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'วันที่สิ้นสุดผล (proposedEffectiveTo) ไม่ถูกต้องตามปฏิทิน',
          requestId: req.requestId,
        });
        return;
      }

      if (proposedEffectiveTo && proposedEffectiveFrom > proposedEffectiveTo) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'วันที่มีผลต้องไม่มากกว่าวันที่สิ้นสุดผล',
          requestId: req.requestId,
        });
        return;
      }

      const preview = await analyzeRetroactiveMappingImpact(
        mappingId,
        proposedEffectiveFrom,
        proposedEffectiveTo
      );
      if (!preview) {
        res.status(404).json({
          error: 'MAPPING_NOT_FOUND',
          message: 'ไม่พบข้อมูลการจับคู่รหัสลายนิ้วมือที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      res.json(preview);
    } catch (err) {
      next(err);
    }
  }
);

personnelRouter.post(
  '/personnel/mappings/:id/retroactive-approve',
  requireAuth,
  requireRoles('ADMIN'),
  async (req, res, next) => {
    try {
      const mappingId = Number(req.params.id);
      if (!Number.isInteger(mappingId) || mappingId <= 0) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'รหัสการจับคู่ลายนิ้วมือไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      const proposedEffectiveFrom = String(req.body?.proposedEffectiveFrom || '').trim();
      const rawProposedTo = req.body?.proposedEffectiveTo;
      const proposedEffectiveTo =
        rawProposedTo !== undefined && rawProposedTo !== null && String(rawProposedTo).trim() !== ''
          ? String(rawProposedTo).trim()
          : null;
      const reason = String(req.body?.reason || '').trim();
      const reprocessAttendance = req.body?.reprocessAttendance !== false;

      if (!isValidYmdDate(proposedEffectiveFrom)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุวันที่มีผลใหม่ (proposedEffectiveFrom) ในรูปแบบ YYYY-MM-DD ที่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }
      if (proposedEffectiveTo && !isValidYmdDate(proposedEffectiveTo)) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'วันที่สิ้นสุดผล (proposedEffectiveTo) ไม่ถูกต้องตามปฏิทิน',
          requestId: req.requestId,
        });
        return;
      }
      if (proposedEffectiveTo && proposedEffectiveFrom > proposedEffectiveTo) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'วันที่มีผลต้องไม่มากกว่าวันที่สิ้นสุดผล',
          requestId: req.requestId,
        });
        return;
      }
      if (reason.length < 5) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'กรุณาระบุเหตุผลการปรับวันที่มีผลย้อนหลังอย่างน้อย 5 ตัวอักษร',
          requestId: req.requestId,
        });
        return;
      }

      const analysis = await analyzeRetroactiveMappingImpact(
        mappingId,
        proposedEffectiveFrom,
        proposedEffectiveTo
      );
      if (!analysis) {
        res.status(404).json({
          error: 'MAPPING_NOT_FOUND',
          message: 'ไม่พบข้อมูลการจับคู่รหัสลายนิ้วมือที่เลือก',
          requestId: req.requestId,
        });
        return;
      }

      // ห้ามบังคับ UNMATCHED -> MATCHED เมื่อมีความซ้ำซ้อนหรือทับซ้อนกับบุคลากรรายอื่น
      if (!analysis.canApprove) {
        res.status(409).json({
          error: 'HISTORICAL_MAPPING_CONFLICT',
          message: analysis.blockReason,
          conflicts: analysis.conflicts,
          requestId: req.requestId,
        });
        return;
      }

      // ยืนยันการรับทราบผลกระทบและรหัสผ่านของผู้ดูแลระบบที่ล็อกอินอยู่จริงเท่านั้น
      const reauth = await verifyActorReauthentication({
        userId: req.user!.id,
        username: req.user!.username,
        role: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        requestId: req.requestId,
        operationName: 'FINGERPRINT_MAPPING_RETROACTIVE_APPROVE',
        targetType: 'FINGERPRINT_MAPPING',
        targetId: String(mappingId),
        confirmPassword: req.body?.confirmPassword,
        impactAcknowledged: req.body?.impactAcknowledged,
      });

      if (!reauth.ok) {
        res.status(reauth.statusCode || 401).json({
          error: reauth.errorCode,
          message: reauth.message,
          lockedUntil: reauth.lockedUntil ?? undefined,
          requestId: req.requestId,
        });
        return;
      }

      await dbExecute(
        `UPDATE fingerprint_mappings
         SET original_effective_from = COALESCE(original_effective_from, effective_from),
             effective_from = ?,
             effective_to = ?,
             retroactive_adjusted_by = ?,
             retroactive_adjusted_at = CURRENT_TIMESTAMP,
             retroactive_reason = ?
         WHERE id = ?`,
        [proposedEffectiveFrom, proposedEffectiveTo, req.user!.username, reason, mappingId]
      );

      const resolveFrom =
        analysis.impactSummary.earliestScanDate &&
        analysis.impactSummary.earliestScanDate < proposedEffectiveFrom
          ? analysis.impactSummary.earliestScanDate
          : proposedEffectiveFrom;
      const bkkToday = getCurrentBangkokDateParts().todayYmd;
      const resolveTo =
        analysis.impactSummary.latestScanDate && analysis.impactSummary.latestScanDate > bkkToday
          ? analysis.impactSummary.latestScanDate
          : bkkToday;

      const mappingResolution = await resolveRawScanPersonnelMappings(resolveFrom, resolveTo, {
        fingleId: analysis.mapping.fingleId,
      });

      let reprocessResult: unknown = null;
      if (
        reprocessAttendance &&
        analysis.impactSummary.affectedDateFrom &&
        analysis.impactSummary.affectedDateTo
      ) {
        reprocessResult = await reprocessAttendanceRange({
          dateFrom: addDaysYmd(analysis.impactSummary.affectedDateFrom, -1),
          dateTo: analysis.impactSummary.affectedDateTo,
          personId: analysis.mapping.personId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          requestId: req.requestId,
          ipAddress: req.ip || '127.0.0.1',
        });
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'FINGERPRINT_MAPPING_RETROACTIVE_APPROVED',
        targetType: 'FINGERPRINT_MAPPING',
        targetId: String(mappingId),
        result: 'SUCCESS',
        detail: {
          personId: analysis.mapping.personId,
          fingleId: analysis.mapping.fingleId,
          previousEffectiveFrom: analysis.mapping.currentEffectiveFrom,
          newEffectiveFrom: proposedEffectiveFrom,
          previousEffectiveTo: analysis.mapping.currentEffectiveTo,
          newEffectiveTo: proposedEffectiveTo,
          reason,
          mappingResolution,
          reprocessed: Boolean(reprocessResult),
        },
      });

      res.json({
        status: 'APPROVED',
        mappingId,
        personId: analysis.mapping.personId,
        fingleId: analysis.mapping.fingleId,
        previousEffectiveFrom: analysis.mapping.currentEffectiveFrom,
        newEffectiveFrom: proposedEffectiveFrom,
        newEffectiveTo: proposedEffectiveTo,
        reason,
        mappingResolution,
        reprocessResult,
      });
    } catch (err) {
      next(err);
    }
  }
);

personnelRouter.post(
  '/personnel/mappings/resolve-unmatched',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const dateFrom = String(req.body?.dateFrom || bkk.monthStartYmd).trim();
      const dateTo = String(req.body?.dateTo || bkk.todayYmd).trim();
      const fingleId = req.body?.fingleId ? String(req.body.fingleId).trim() : undefined;
      const reprocessAttendance = req.body?.reprocessAttendance !== false;

      if (!isValidYmdDate(dateFrom) || !isValidYmdDate(dateTo) || dateFrom > dateTo) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'ช่วงวันที่สำหรับตรวจสอบการจับคู่สแกนค้างไม่ถูกต้อง',
          requestId: req.requestId,
        });
        return;
      }

      try {
        assertRoleAuthorizedForDateRange({
          role: req.user!.role,
          syncMode: 'CUSTOM_RANGE',
          dateFrom,
          dateTo,
        });
      } catch (authErr: unknown) {
        if (authErr instanceof ScannerSyncRangeError) {
          res.status(authErr.statusCode).json({
            error: authErr.code,
            message: authErr.message,
            requestId: req.requestId,
          });
          return;
        }
        throw authErr;
      }

      const mappingResolution = await resolveRawScanPersonnelMappings(dateFrom, dateTo, {
        fingleId,
      });

      let reprocessResult: unknown = null;
      if (reprocessAttendance) {
        reprocessResult = await reprocessAttendanceRange({
          dateFrom,
          dateTo,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          requestId: req.requestId,
          ipAddress: req.ip || '127.0.0.1',
        });
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'RAW_SCAN_MAPPINGS_RESOLVED',
        targetType: 'RAW_SCAN_MAPPINGS',
        targetId: `${dateFrom}..${dateTo}`,
        result: 'SUCCESS',
        detail: {
          dateFrom,
          dateTo,
          fingleId: fingleId || null,
          mappingResolution,
          reprocessed: Boolean(reprocessResult),
        },
      });

      res.json({
        status: 'RESOLVED',
        dateFrom,
        dateTo,
        mappingResolution,
        reprocessResult,
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
    const rawEff = String(req.body?.effectiveDate || '').trim();
    const effectiveDate =
      rawEff && isValidYmdDate(rawEff) ? rawEff : getCurrentBangkokDateParts().todayYmd;

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
      const existingActiveRows = await dbQuery<{ person_id: string }>(
        'SELECT person_id FROM personnel WHERE is_active = 1'
      );
      const existingActivePersonIds = existingActiveRows
        .map((r) => String(r.person_id).trim())
        .filter(Boolean);

      const fetchResult = await fetchFromHosOfficeReadOnly(existingActivePersonIds);
      const externalRows = fetchResult.activeRows;

      if (trackedJobId) {
        updateCentralJobStep(trackedJobId, {
          currentStep: `ดึงรายชื่อบุคลากรสถานะปกติ (HR_STATUS_ID = '01') จาก HOSOffice สำเร็จ (${externalRows.length} รายการ) กำลังอัปเดตทะเบียนบุคลากร...`,
          processedCount: 0,
          totalCount: externalRows.length,
        });
      }

      // Detect duplicate FINGLE_ID across active (HR_STATUS_ID = '01') personnel in the incoming batch
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
      let reactivatedCount = 0;
      let conflictsFound = 0;
      const syncedActivePersonIds = new Set<string>();

      for (const row of externalRows) {
        const personId = String(row.PERSON_ID).trim();
        syncedActivePersonIds.add(personId);
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

        const existing = await dbQuery<{
          person_id: string;
          fingle_id: string | null;
          is_active: number;
        }>(
          'SELECT person_id, fingle_id, is_active FROM personnel WHERE person_id = ? LIMIT 1',
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
              1,
              mappingStatus,
              issueDetail,
            ]
          );
        } else {
          if (Number(existing[0].is_active) === 0) {
            reactivatedCount++;
          }
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
              1,
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
          const activeMappings = await dbQuery<{
            id: number;
            fingle_id: string;
            effective_from: unknown;
          }>(
            'SELECT id, fingle_id, effective_from FROM fingerprint_mappings WHERE person_id = ? AND effective_to IS NULL',
            [personId]
          );

          const sameMapping = activeMappings.find((m) => String(m.fingle_id).trim() === fingleId);
          if (!sameMapping) {
            // ปิด mapping เก่าให้สิ้นสุดก่อนหน้า effectiveDate 1 วัน เพื่อไม่ให้เกิดช่วงทับซ้อน 1 วัน
            for (const oldMap of activeMappings) {
              const oldFrom = normalizeWorkDateString(oldMap.effective_from);
              const prevDay = addDaysYmd(effectiveDate, -1);
              const closeTo = prevDay >= oldFrom ? prevDay : oldFrom;
              await dbExecute(
                'UPDATE fingerprint_mappings SET effective_to = ? WHERE id = ?',
                [closeTo, oldMap.id]
              );
            }
            await dbExecute(
              `INSERT INTO fingerprint_mappings (
                person_id, fingle_id, effective_from, effective_to, original_effective_from, conflict_state, conflict_reason, source, created_by
              ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'HOSOFFICE_SYNC', ?)`,
              [personId, fingleId, effectiveDate, effectiveDate, conflictState, issueDetail, actor]
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
            stage: 'SYNCING_PERSONNEL',
            currentStep: `กำลังอัปเดตทะเบียนบุคลากร (${upsertedCount}/${externalRows.length} คน) โดยคงตารางเวรเดิมไว้ครบถ้วน...`,
            processedCount: upsertedCount,
            totalCount: externalRows.length,
          });
        }
      }

      // ตรวจสอบบุคลากรที่เคยซิงก์ไว้แล้วแต่ไม่พบในผล Query HR_STATUS_ID = '01'
      // กฎความปลอดภัย: ปรับ is_active = 0 เฉพาะเมื่อยืนยันสถานะต้นทางจริงจาก HOSOffice แล้วว่า HR_STATUS_ID != '01' เท่านั้น
      // ห้ามถือว่าบุคลากรที่หายจากผล Query เป็น Inactive ทันที และห้ามลบ/แก้ไขประวัติ Raw Scan, Mapping, Attendance, Leave, Notes หรือ Push History
      const missingPreviouslyActiveIds = existingActivePersonIds.filter(
        (pid) => !syncedActivePersonIds.has(pid)
      );
      let deactivatedCount = 0;
      const deactivatedPersonnel: Array<{ personId: string; verifiedHrStatusId: string | null }> = [];
      const unverifiedMissingPersonIds: string[] = [];

      if (missingPreviouslyActiveIds.length > 0) {
        if (fetchResult.sourceVerificationExecuted) {
          for (const pid of missingPreviouslyActiveIds) {
            const verified = fetchResult.verifiedStatuses.get(pid);
            if (verified && verified.foundInSource && !verified.isActiveInSource) {
              await dbExecute(
                `UPDATE personnel
                 SET is_active = 0,
                     last_synced_at = CURRENT_TIMESTAMP,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE person_id = ? AND is_active = 1`,
                [pid]
              );
              deactivatedCount++;
              deactivatedPersonnel.push({
                personId: pid,
                verifiedHrStatusId: verified.hrStatusId,
              });
            } else if (!verified || !verified.foundInSource) {
              // ยังไม่พบข้อมูลยืนยันสถานะต้นทางจริง -> ห้ามปรับเป็น Inactive
              unverifiedMissingPersonIds.push(pid);
            }
          }
        } else {
          // ตรวจสอบสถานะต้นทางไม่สำเร็จ -> คงสถานะเดิมทุกราย ห้ามเดาเป็น Inactive
          unverifiedMissingPersonIds.push(...missingPreviouslyActiveIds);
        }
      }

      // ตรวจสอบและจับคู่ข้อมูลสแกนค้างที่อยู่ในช่วงวันที่มีผล (ไม่ย้อนหลังอัตโนมัติเกิน effective_from)
      let autoMappingResolution: {
        totalEvaluated: number;
        newlyMatched: number;
        matchedCount: number;
        unmatchedCount: number;
        conflictCount: number;
      } | null = null;
      try {
        const pendingScanBounds = await dbQuery<{ min_ts: unknown; max_ts: unknown }>(
          `SELECT MIN(rs.canonical_bkk_time) AS min_ts, MAX(rs.canonical_bkk_time) AS max_ts
           FROM raw_scans rs
           LEFT JOIN raw_scan_mappings rsm ON rsm.raw_scan_id = rs.id
           WHERE COALESCE(rsm.mapping_state, 'UNMATCHED') != 'MATCHED'`
        );
        const minTs = normalizeBkkTimestamp(pendingScanBounds[0]?.min_ts);
        const maxTs = normalizeBkkTimestamp(pendingScanBounds[0]?.max_ts);
        if (minTs && maxTs) {
          const resolveFrom = minTs.slice(0, 10);
          const resolveTo = maxTs.slice(0, 10);
          autoMappingResolution = await resolveRawScanPersonnelMappings(resolveFrom, resolveTo);
          if (autoMappingResolution.newlyMatched > 0) {
            await reprocessAttendanceRange({
              dateFrom: addDaysYmd(resolveFrom, -1),
              dateTo: resolveTo,
              actorUsername: actor,
              actorRole: req.user!.role,
              requestId: req.requestId,
              ipAddress: req.ip || '127.0.0.1',
            });
          }
        }
      } catch {
        // ไม่ให้ขั้นตอนตรวจสอบสแกนค้างทำให้การซิงก์บุคลากรหลักล้มเหลว
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
            hrStatusFilter: ACTIVE_HR_STATUS_ID,
            recordsFetched: externalRows.length,
            recordsUpserted: upsertedCount,
            reactivatedCount,
            deactivatedCount,
            unverifiedMissingCount: unverifiedMissingPersonIds.length,
            mappingConflictsFound: conflictsFound,
            effectiveDate,
            autoMappingResolution,
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
          hrStatusFilter: ACTIVE_HR_STATUS_ID,
          recordsFetched: externalRows.length,
          upsertedCount,
          reactivatedCount,
          deactivatedCount,
          deactivatedPersonnel,
          unverifiedMissingCount: unverifiedMissingPersonIds.length,
          sourceVerificationExecuted: fetchResult.sourceVerificationExecuted,
          sourceVerificationWarning: fetchResult.sourceVerificationWarning,
          conflictsFound,
          effectiveDate,
        },
      });

      res.json({
        status: 'SUCCESS',
        jobId: trackedJobId,
        hrStatusFilter: ACTIVE_HR_STATUS_ID,
        recordsFetched: externalRows.length,
        recordsUpserted: upsertedCount,
        reactivatedCount,
        deactivatedCount,
        deactivatedPersonnel,
        unverifiedMissingCount: unverifiedMissingPersonIds.length,
        unverifiedMissingPersonIds,
        sourceVerificationExecuted: fetchResult.sourceVerificationExecuted,
        sourceVerificationWarning: fetchResult.sourceVerificationWarning,
        mappingConflictsFound: conflictsFound,
        effectiveDate,
        autoMappingResolution,
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
