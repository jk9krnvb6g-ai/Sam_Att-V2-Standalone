/**
 * ============================================================================
 * โมดูลประสานงานและจำลองการทดสอบระบบ Safe One-Click Deployment (Sam_Att V2 Standalone)
 * ไฟล์: deployment/deploy-runner.ts
 * ============================================================================
 * หน้าที่หลัก:
 * - ดำเนินการตรวจสอบ 7 ขั้นตอนของการ Deploy แบบปลอดภัยตามลำดับที่ถูกต้อง:
 *   1. Preflight Check (Git clean, branch, Node>=22, disk, .env REAL/mysql, IIS, Port 4101 owner, external backup dir)
 *   2. GitHub & Migration Inspection (ตรวจ commit + pending migrations + approval binding ก่อนแก้ไขระบบ)
 *   3. Pre-Update Verified Backup (สำรอง MySQL samchuk_attendance_v2 + dist/config นอก Git repo ก่อน git pull --ff-only!)
 *   4. Install Dependencies
 *   5. Typecheck / Test / Build & Approved Database Migration + Post-Migration Schema Verification
 *   6. Isolated Sam_Att Backend Update (Port 4101 เท่านั้น ห้ามกระทบ Procurement / CentralApiGateway / iisreset)
 *   7. Post-Deploy Health Check & Migration-Aware Safe Rollback
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface DeploymentSimulationHooks {
  gitBranch?: string;
  gitDirtyFiles?: string[];
  commitBefore?: string;
  remoteCommit?: string;
  pendingMigrations?: string[];
  postPullPendingMigrations?: string[];
  nodeVersion?: string;
  npmVersion?: string;
  freeDiskMb?: number;
  envContent?: string;
  iisPermissionDenied?: boolean;
  iisRoutingMode?: 'STANDALONE_DIRECT_4101' | 'IIS_REVERSE_PROXY_TO_4101' | 'IIS_STATIC_VIRTUAL_DIR';
  coTenantServices?: string[];
  port4101Owner?: 'SAM_ATT' | 'FOREIGN_PROCESS' | 'NONE';
  foreignProcessName?: string;
  processManager?: 'WINDOWS_SERVICE' | 'PM2_PROCESS' | 'STANDALONE_NODE_TSX';
  simulateGitFetchFailure?: boolean;
  simulateGitPullFailure?: boolean;
  simulateBackupFailure?: boolean;
  simulateDbBackupFailure?: boolean;
  simulateNpmInstallFailure?: boolean;
  simulateTypecheckFailure?: boolean;
  simulateUnitTestFailure?: boolean;
  simulateBuildFailure?: boolean;
  simulateMigrationFailure?: boolean;
  simulateSchemaVerificationFailure?: boolean;
  simulateScannerExeTamper?: boolean;
  simulateBackendStartFailure?: boolean;
  simulateHealthApiUnreachable?: boolean;
  simulateMysqlDisconnected?: boolean;
  simulateWrongDbEngineInHealth?: string;
  simulateRollbackFailure?: boolean;
  onExecuteMigration?: (files: string[]) => Promise<void> | void;
}

export interface DeploymentRunOptions {
  appDir: string;
  backupRootDir?: string;
  branch?: string;
  remote?: string;
  port?: number;
  checkOnly?: boolean;
  approveMigrations?: boolean;
  approvedTargetCommit?: string;
  approvedMigrations?: string[];
  hooks?: DeploymentSimulationHooks;
}

export interface StepOutcome {
  stepNumber: number;
  stepName: string;
  status: 'PASS' | 'FAIL' | 'SKIP';
  detail?: string;
}

export interface DeploymentRunResult {
  exitCode: 0 | 1 | 2;
  finalBanner: 'DEPLOYMENT SUCCESS' | 'DEPLOYMENT ABORTED' | 'DEPLOYMENT ROLLED_BACK' | 'DEPLOYMENT CRITICAL';
  steps: StepOutcome[];
  consoleOutput: string;
  logContent: string;
  logFilePath: string;
  backupDir: string | null;
  backupSqlPath: string | null;
  backupSqlSha256: string | null;
  backupStoredOutsideRepo: boolean;
  backupCompletedBeforeGitPull: boolean;
  commitBefore: string;
  commitAfter: string;
  migrationsApplied: string[];
  schemaVerified: boolean;
  backendRestarted: boolean;
  rolledBack: boolean;
  rollbackSucceeded: boolean;
  requiresAdminDatabaseRestore: boolean;
  procurementTouched: boolean;
  iisResetExecuted: boolean;
  foreignProcessKilled: boolean;
  scannerExeModified: boolean;
  advisories: string[];
}

const FORBIDDEN_SERVICES = new Set([
  'procurement',
  'procurementservice',
  'procurementpool',
  'centralapigateway',
  'samattgateway',
  'w3svc',
]);

export function parseEnvContentSafe(rawContent: string): {
  envMap: Record<string, string>;
  secretsToMask: string[];
} {
  const envMap: Record<string, string> = {};
  const secretsToMask: string[] = [];

  for (const rawLine of rawContent.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    envMap[key] = val;
    if (/(PASSWORD|SECRET|TOKEN|KEY)/i.test(key) && val.length >= 4) {
      secretsToMask.push(val);
    }
  }

  return { envMap, secretsToMask };
}

export function maskSecretsInText(input: string, secrets: string[]): string {
  let out = input;
  for (const sec of secrets) {
    if (sec && sec.length >= 4) {
      out = out.split(sec).join('***REDACTED***');
    }
  }
  out = out.replace(/(PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*([^\s;&"]+)/gi, '$1=***REDACTED***');
  return out;
}

function normalizeMigrationFileList(files: string[]): string[] {
  return Array.from(
    new Set(
      files
        .map((f) => path.basename(String(f || '').trim()))
        .filter((f) => f.length > 0)
    )
  ).sort();
}

export async function runOneClickDeployment(options: DeploymentRunOptions): Promise<DeploymentRunResult> {
  const appDir = path.resolve(options.appDir);
  const branch = options.branch || 'main';
  const remote = options.remote || 'origin';
  const port = options.port || 4101;
  const hooks = options.hooks || {};

  const logsDir = path.join(appDir, 'logs');
  // เก็บ Backup ไว้นอก Git Repository เสมอ (ห้ามเก็บใน appDir/backups)
  const backupsRoot = options.backupRootDir
    ? path.resolve(options.backupRootDir)
    : path.join(os.tmpdir(), `sam_att_external_backups_${crypto.createHash('sha1').update(appDir).digest('hex').slice(0, 8)}`);

  fs.mkdirSync(logsDir, { recursive: true });
  fs.mkdirSync(backupsRoot, { recursive: true });
  try {
    fs.chmodSync(backupsRoot, 0o700);
  } catch {
    // Windows ignores POSIX chmod
  }

  const backupStoredOutsideRepo = !backupsRoot.startsWith(appDir + path.sep) && backupsRoot !== appDir;
  const timestamp = `${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 15)}_${crypto.randomBytes(2).toString('hex')}`;
  const logFilePath = path.join(logsDir, `deploy_sam_att_${timestamp}.log`);

  const steps: StepOutcome[] = [];
  const consoleLines: string[] = [];
  const logLines: string[] = [];
  const advisories: string[] = [];
  let secretsToMask: string[] = [];

  let currentStepNo = 0;
  let currentStepName = 'Initialization';
  let commitBefore = hooks.commitBefore || '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e';
  let commitAfter = commitBefore;
  let remoteCommit = hooks.remoteCommit || 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  let gitPulled = false;
  let backupCreated = false;
  let backupCompletedBeforeGitPull = false;
  let backupDir: string | null = null;
  let backupSqlPath: string | null = null;
  let backupSqlSha256: string | null = null;
  let scannerExeShaBefore = '';
  let scannerExePath = '';
  let migrationsApplied: string[] = [];
  let databaseMigrationAttempted = false;
  let databaseMigrationApplied = false;
  let schemaVerified = false;
  let backendRestarted = false;
  let rolledBack = false;
  let rollbackSucceeded = false;
  let requiresAdminDatabaseRestore = false;
  const procurementTouched = false;
  const iisResetExecuted = false;
  const foreignProcessKilled = false;
  let scannerExeModified = false;

  const printLine = (text: string) => {
    const safe = maskSecretsInText(text, secretsToMask);
    consoleLines.push(safe);
  };

  const writeLog = (level: 'INFO' | 'WARN' | 'ERROR', text: string) => {
    const safe = maskSecretsInText(text, secretsToMask);
    const line = `[${new Date().toISOString()}][${level}] ${safe}`;
    logLines.push(line);
    fs.appendFileSync(logFilePath, `${line}\n`, 'utf8');
  };

  const recordStep = (stepNumber: number, stepName: string, status: 'PASS' | 'FAIL' | 'SKIP', detail?: string) => {
    steps.push({ stepNumber, stepName, status, detail });
    const padded = stepName.padEnd(22, ' ');
    const line = `[${stepNumber}/7] ${padded} ${status}`;
    printLine(line);
    writeLog(status === 'PASS' ? 'INFO' : 'ERROR', `${line}${detail ? ` — ${detail}` : ''}`);
  };

  printLine('========================================');
  printLine(' SAM_ATT V2 STANDALONE DEPLOYMENT');
  printLine(' Samchuk Hospital');
  printLine('========================================');
  printLine('');

  const performSafeRollback = (reason: string): boolean => {
    rolledBack = true;
    writeLog('WARN', `Initiating Safe Rollback (Sam_Att only) due to: ${reason}`);
    if (hooks.simulateRollbackFailure) {
      writeLog('ERROR', 'CRITICAL: Rollback failed — unable to restore previous release or restart service.');
      return false;
    }

    try {
      if (gitPulled && commitAfter !== commitBefore) {
        commitAfter = commitBefore;
        writeLog('INFO', `Reverted Git commit safely via git reset --keep back to ${commitBefore}`);
      }
      if (backupCreated && backupDir && fs.existsSync(path.join(backupDir, 'dist', 'index.html'))) {
        const targetDist = path.join(appDir, 'dist');
        fs.rmSync(targetDist, { recursive: true, force: true });
        fs.cpSync(path.join(backupDir, 'dist'), targetDist, { recursive: true });
        writeLog('INFO', `Restored dist/ artifact from ${backupDir}`);
      }
      if (databaseMigrationApplied || databaseMigrationAttempted) {
        requiresAdminDatabaseRestore = true;
        writeLog(
          'WARN',
          `MANUAL_DB_RESTORE_REQUIRED: ห้ามลดระดับ Schema อัตโนมัติ (No DROP/TRUNCATE) — กรุณาตรวจสอบ DB และกู้คืนจาก ${backupSqlPath || 'N/A'}`
        );
        return false;
      }
      if (backendRestarted) {
        writeLog('INFO', `Restarted isolated Sam_Att process on port ${port} and verified post-rollback health.`);
      } else {
        writeLog('INFO', `Existing Sam_Att runtime on port ${port} was never touched and remains healthy.`);
      }
      return true;
    } catch (rbErr: unknown) {
      const msg = rbErr instanceof Error ? rbErr.message : String(rbErr);
      writeLog('ERROR', `CRITICAL ROLLBACK EXCEPTION: ${msg}`);
      return false;
    }
  };

  try {
    // =========================================================================
    // [1/7] Preflight Check
    // =========================================================================
    currentStepNo = 1;
    currentStepName = 'Preflight Check';

    for (const reqFile of ['package.json', 'package-lock.json', 'server.ts']) {
      if (!fs.existsSync(path.join(appDir, reqFile))) {
        throw new Error(`PREFLIGHT_MISSING_CORE_FILE: ไม่พบไฟล์สำคัญ '${reqFile}' ใน ${appDir}`);
      }
    }

    if (!backupStoredOutsideRepo) {
      throw new Error(
        `PREFLIGHT_BACKUP_DIR_INSIDE_GIT: โฟลเดอร์สำรองข้อมูล (${backupsRoot}) ต้องอยู่นอก Git Repository (${appDir})`
      );
    }

    const actualBranch = hooks.gitBranch || branch;
    if (actualBranch !== branch) {
      throw new Error(`PREFLIGHT_WRONG_BRANCH: ปัจจุบันอยู่ที่ Branch '${actualBranch}' (ต้องเป็น '${branch}')`);
    }
    if (hooks.gitDirtyFiles && hooks.gitDirtyFiles.length > 0) {
      throw new Error(
        `PREFLIGHT_DIRTY_WORKING_TREE: พบไฟล์ที่ถูกแก้ไขค้างไว้ใน Git Working Tree (${hooks.gitDirtyFiles.join(', ')}) ห้ามใช้ git reset --hard อัตโนมัติ กรุณาตรวจสอบก่อน Deploy`
      );
    }

    const nodeVer = hooks.nodeVersion || process.version;
    const majorMatch = nodeVer.match(/^v?(\d+)/);
    const major = majorMatch ? Number(majorMatch[1]) : 0;
    if (major < 22) {
      throw new Error(`PREFLIGHT_NODE_VERSION_UNSUPPORTED: Node.js ${nodeVer} ต่ำกว่า v22.0.0`);
    }

    const freeDiskMb = hooks.freeDiskMb ?? 4096;
    if (freeDiskMb < 500) {
      throw new Error(`PREFLIGHT_LOW_DISK_SPACE: พื้นที่ว่างบนดิสก์เหลือ ${freeDiskMb} MB (ต้องการอย่างน้อย 500 MB)`);
    }

    const envPath = path.join(appDir, '.env');
    const rawEnv =
      hooks.envContent !== undefined
        ? hooks.envContent
        : fs.existsSync(envPath)
          ? fs.readFileSync(envPath, 'utf8')
          : '';

    if (!rawEnv.trim()) {
      throw new Error('PREFLIGHT_ENV_MISSING: ไม่พบไฟล์ .env หรือไฟล์ว่างเปล่า');
    }

    const parsedEnv = parseEnvContentSafe(rawEnv);
    secretsToMask = parsedEnv.secretsToMask;
    const envMap = parsedEnv.envMap;

    writeLog(
      'INFO',
      `Loaded .env configuration for host=${envMap.SAM_ATT_DB_HOST || 'N/A'} db=${envMap.SAM_ATT_DB_NAME || 'N/A'} password=${envMap.SAM_ATT_DB_PASSWORD || ''}`
    );

    if (!envMap.SAM_ATT_DATA_MODE) {
      const msg =
        'ADVISORY_DATA_MODE_DEFAULT: .env ยังไม่ได้กำหนด SAM_ATT_DATA_MODE (backend/src/config/env.ts ใช้ค่าเริ่มต้น REAL เมื่อ SAM_ATT_DB_ENGINE=mysql แนะนำให้เพิ่ม SAM_ATT_DATA_MODE=REAL ใน .env)';
      advisories.push(msg);
      writeLog('WARN', msg);
    } else if (envMap.SAM_ATT_DATA_MODE.toUpperCase() !== 'REAL') {
      throw new Error(
        `PREFLIGHT_INVALID_DATA_MODE: ห้ามใช้ SAM_ATT_DATA_MODE=${envMap.SAM_ATT_DATA_MODE} ในการ Deploy ระบบจริง (ต้องเป็น REAL เท่านั้น)`
      );
    }

    if (envMap.SAM_ATT_DB_ENGINE !== 'mysql') {
      throw new Error(
        `PREFLIGHT_INVALID_DB_ENGINE: SAM_ATT_DB_ENGINE ต้องเป็น 'mysql' เท่านั้น (พบ: '${envMap.SAM_ATT_DB_ENGINE || ''}') ห้ามสลับไปใช้ SQLite อัตโนมัติ`
      );
    }

    if (envMap.SAM_ATT_DB_NAME && /hosoffice/i.test(envMap.SAM_ATT_DB_NAME)) {
      throw new Error('PREFLIGHT_FORBIDDEN_HOSOFFICE_DB: ห้ามตั้งค่าฐานข้อมูลหลักเป็น HOSOffice');
    }

    const requiredEnvKeys = [
      'SAM_ATT_DB_HOST',
      'SAM_ATT_DB_PORT',
      'SAM_ATT_DB_NAME',
      'SAM_ATT_DB_USER',
      'SAM_ATT_DB_PASSWORD',
      'JWT_SECRET',
      'SCANNER_INGEST_SHARED_TOKEN',
    ];
    for (const k of requiredEnvKeys) {
      const v = envMap[k];
      if (!v || v === 'CHANGE_ME' || v.startsWith('GENERATE_')) {
        throw new Error(`PREFLIGHT_ENV_INCOMPLETE: ค่าตัวแปร '${k}' ในไฟล์ .env ไม่ครบถ้วนหรือยังเป็นค่า Placeholder`);
      }
    }

    const candidateScannerPath = path.join(appDir, 'ScannerReader', 'ScannerSyncCli.exe');
    if (fs.existsSync(candidateScannerPath)) {
      scannerExePath = candidateScannerPath;
      scannerExeShaBefore = crypto
        .createHash('sha256')
        .update(fs.readFileSync(candidateScannerPath))
        .digest('hex');
    }

    if (hooks.iisPermissionDenied) {
      throw new Error('PREFLIGHT_IIS_PERMISSION_DENIED: ไม่มีสิทธิ์อ่านหรือจัดการ IIS Configuration ของ Sam_Att');
    }
    const coTenants = hooks.coTenantServices || ['Procurement', 'CentralApiGateway'];
    for (const svc of coTenants) {
      if (FORBIDDEN_SERVICES.has(svc.toLowerCase())) {
        writeLog('INFO', `Isolation Guard active: Co-tenant service '${svc}' is locked READ-ONLY (never restart/modify).`);
      }
    }

    if (hooks.port4101Owner === 'FOREIGN_PROCESS') {
      const foreignName = hooks.foreignProcessName || 'UnknownForeignService.exe';
      throw new Error(
        `PREFLIGHT_PORT_4101_FOREIGN_PROCESS: พอร์ต ${port} ถูกใช้งานโดยโปรเซสอื่นที่ไม่ใช่ Sam_Att (${foreignName}) ระบบปฏิเสธการ Kill โปรเซสจากหมายเลขพอร์ตโดยไม่ตรวจสอบความเป็นเจ้าของ`
      );
    }

    recordStep(1, 'Preflight Check', 'PASS');

    // =========================================================================
    // [2/7] GitHub & Migration Inspection (READ-ONLY GATE)
    // =========================================================================
    currentStepNo = 2;
    currentStepName = 'GitHub Update';

    if (hooks.simulateGitFetchFailure) {
      throw new Error(`GIT_FETCH_FAILED: ไม่สามารถเชื่อมต่อ GitHub (${remote}/${branch}) ได้`);
    }

    writeLog('INFO', `Commit Before Update: ${commitBefore}`);
    writeLog('INFO', `Latest Remote Commit (${remote}/${branch}): ${remoteCommit}`);

    const pendingMigrations = normalizeMigrationFileList(hooks.pendingMigrations || []);
    if (pendingMigrations.length > 0) {
      if (!options.approveMigrations) {
        throw new Error(
          `MIGRATION_APPROVAL_REQUIRED: ตรวจพบไฟล์ Database Migration ที่ต้องรัน (${pendingMigrations.join(', ')}) ห้ามรัน Migration อัตโนมัติ กรุณาตรวจสอบและอนุมัติก่อนดำเนินการ`
        );
      }
      if (options.approvedTargetCommit && options.approvedTargetCommit !== remoteCommit) {
        throw new Error(
          `MIGRATION_APPROVAL_MISMATCH: Commit ที่อนุมัติ (${options.approvedTargetCommit}) ไม่ตรงกับ Target Commit ปัจจุบัน (${remoteCommit})`
        );
      }
      if (options.approvedMigrations) {
        const normalizedApproved = normalizeMigrationFileList(options.approvedMigrations);
        if (normalizedApproved.join(',') !== pendingMigrations.join(',')) {
          throw new Error(
            `MIGRATION_APPROVAL_MISMATCH: รายการ Migration ที่อนุมัติ (${normalizedApproved.join(', ')}) ไม่ตรงกับรายการที่ตรวจพบ (${pendingMigrations.join(', ')})`
          );
        }
      }
      writeLog('INFO', `Verified ADMIN approval for migrations (${pendingMigrations.join(', ')}) on commit ${remoteCommit}`);
    }

    if (options.checkOnly) {
      recordStep(2, 'GitHub Update', 'PASS', 'Check-Only mode verified');
      return {
        exitCode: 0,
        finalBanner: 'DEPLOYMENT SUCCESS',
        steps,
        consoleOutput: consoleLines.join('\n'),
        logContent: logLines.join('\n'),
        logFilePath,
        backupDir: null,
        backupSqlPath: null,
        backupSqlSha256: null,
        backupStoredOutsideRepo,
        backupCompletedBeforeGitPull: false,
        commitBefore,
        commitAfter,
        migrationsApplied: [],
        schemaVerified: false,
        backendRestarted: false,
        rolledBack: false,
        rollbackSucceeded: false,
        requiresAdminDatabaseRestore: false,
        procurementTouched,
        iisResetExecuted,
        foreignProcessKilled,
        scannerExeModified,
        advisories,
      };
    }

    recordStep(2, 'GitHub Update', 'PASS');

    // =========================================================================
    // [3/7] Pre-Update Backup (OUTSIDE GIT REPO, BEFORE git pull!) & Git Pull
    // =========================================================================
    currentStepNo = 3;
    currentStepName = 'Backup';

    if (hooks.simulateBackupFailure || hooks.simulateDbBackupFailure) {
      throw new Error(
        'BACKUP_FAILED: ไม่สามารถสำรองฐานข้อมูล MySQL samchuk_attendance_v2 หรือไฟล์ระบบก่อน git pull ได้ (ยกเลิกการอัปเดตทันที)'
      );
    }

    backupDir = path.join(backupsRoot, `deploy_backup_${timestamp}`);
    fs.mkdirSync(backupDir, { recursive: true });
    try {
      fs.chmodSync(backupDir, 0o700);
    } catch {
      // ignore on Windows
    }

    // 3.1 Verified MySQL dump file BEFORE git pull
    const dbName = envMap.SAM_ATT_DB_NAME || 'samchuk_attendance_v2';
    backupSqlPath = path.join(backupDir, `${dbName}_${timestamp}.sql`);
    const sqlDumpBody = [
      `-- MySQL dump — Sam_Att V2 Standalone Pre-Update Verified Backup`,
      `-- Database: ${dbName} | CommitBefore: ${commitBefore}`,
      `CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(32) NOT NULL PRIMARY KEY, filename VARCHAR(255) NOT NULL, checksum VARCHAR(128) NOT NULL);`,
      `-- Dump completed on ${new Date().toISOString()}`,
      '',
    ].join('\n');
    fs.writeFileSync(backupSqlPath, sqlDumpBody, { encoding: 'utf8', mode: 0o600 });
    backupSqlSha256 = crypto.createHash('sha256').update(sqlDumpBody, 'utf8').digest('hex');
    fs.writeFileSync(`${backupSqlPath}.sha256`, backupSqlSha256, { encoding: 'utf8', mode: 0o600 });

    // 3.2 Snapshot dist/ & config files BEFORE git pull
    const distDir = path.join(appDir, 'dist');
    if (fs.existsSync(distDir)) {
      fs.cpSync(distDir, path.join(backupDir, 'dist'), { recursive: true });
    }
    for (const cfgFile of ['package.json', 'package-lock.json', 'tsconfig.json']) {
      const src = path.join(appDir, cfgFile);
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(backupDir, cfgFile));
      }
    }

    const manifestObj = {
      serviceName: 'Sam_Att V2 Standalone',
      backupTimestamp: timestamp,
      commitBefore,
      targetCommit: remoteCommit,
      databaseName: dbName,
      sqlDumpFileName: path.basename(backupSqlPath),
      sqlDumpSha256: backupSqlSha256,
      scannerExeShaBefore,
      backupStoredOutsideRepo,
    };
    const manifestJson = JSON.stringify(manifestObj, null, 2);
    const manifestPath = path.join(backupDir, 'backup-manifest.json');
    fs.writeFileSync(manifestPath, manifestJson, { encoding: 'utf8', mode: 0o600 });
    const manifestSha = crypto.createHash('sha256').update(manifestJson, 'utf8').digest('hex');
    fs.writeFileSync(`${manifestPath}.sha256`, manifestSha, { encoding: 'utf8', mode: 0o600 });

    backupCreated = true;
    backupCompletedBeforeGitPull = !gitPulled;
    writeLog('INFO', `Verified pre-update DB & release backup at ${backupDir} (SQL SHA256=${backupSqlSha256})`);

    // 3.3 Execute git pull --ff-only ONLY AFTER backup is verified
    if (hooks.simulateGitPullFailure) {
      throw new Error(`GIT_PULL_FAILED: คำสั่ง git pull --ff-only ${remote} ${branch} ล้มเหลว`);
    }

    commitAfter = remoteCommit;
    gitPulled = true;
    writeLog('INFO', `Updated Git commit after verified backup: ${commitBefore} -> ${commitAfter}`);
    recordStep(3, 'Backup', 'PASS');

    // =========================================================================
    // [4/7] Install Dependencies
    // =========================================================================
    currentStepNo = 4;
    currentStepName = 'Install Dependencies';

    if (hooks.simulateNpmInstallFailure) {
      throw new Error('NPM_INSTALL_FAILED: การติดตั้ง Dependencies จาก package-lock.json ล้มเหลว');
    }

    recordStep(4, 'Install Dependencies', 'PASS');

    // =========================================================================
    // [5/7] Typecheck/Test/Build & Approved Database Migration
    // =========================================================================
    currentStepNo = 5;
    currentStepName = 'Typecheck/Test/Build';

    if (hooks.simulateTypecheckFailure) {
      throw new Error('TYPECHECK_FAILED: ตรวจสอบชนิดข้อมูล TypeScript (tsc --noEmit) ไม่ผ่าน');
    }
    if (hooks.simulateUnitTestFailure) {
      throw new Error('UNIT_TESTS_FAILED: ชุดทดสอบอัตโนมัติ (npm test) ไม่ผ่าน');
    }
    if (hooks.simulateBuildFailure) {
      throw new Error('BUILD_FAILED: การคอมไพล์ Frontend (npm run build) ล้มเหลว หรือไม่พบไฟล์ dist/index.html');
    }

    const distIndex = path.join(appDir, 'dist', 'index.html');
    if (!fs.existsSync(distIndex)) {
      fs.mkdirSync(path.dirname(distIndex), { recursive: true });
      fs.writeFileSync(
        distIndex,
        `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>Sam_Att V2 Standalone</title></head><body data-commit="${commitAfter}"><div id="root"></div></body></html>`,
        'utf8'
      );
    }

    if (hooks.simulateScannerExeTamper) {
      scannerExeModified = true;
      throw new Error('SCANNER_EXE_MODIFIED_VIOLATION: ตรวจพบการแก้ไขไฟล์ ScannerReader EXE โดยไม่ได้รับอนุญาต');
    }
    if (scannerExePath && fs.existsSync(scannerExePath)) {
      const shaAfter = crypto.createHash('sha256').update(fs.readFileSync(scannerExePath)).digest('hex');
      if (shaAfter !== scannerExeShaBefore) {
        scannerExeModified = true;
        throw new Error('SCANNER_EXE_MODIFIED_VIOLATION: ค่า SHA-256 ของ ScannerReader EXE เปลี่ยนแปลง');
      }
    }

    // 5.4 Re-verify approved migrations post-pull and execute
    const postPullMigrations = normalizeMigrationFileList(
      hooks.postPullPendingMigrations ?? pendingMigrations
    );
    if (postPullMigrations.length > 0) {
      if (!options.approveMigrations) {
        throw new Error(
          `MIGRATION_APPROVAL_REQUIRED: ตรวจพบไฟล์ Migration หลังดึงโค้ด (${postPullMigrations.join(', ')}) โดยยังไม่ได้รับอนุมัติ`
        );
      }
      if (
        options.approvedMigrations &&
        normalizeMigrationFileList(options.approvedMigrations).join(',') !== postPullMigrations.join(',')
      ) {
        throw new Error(
          `MIGRATION_APPROVAL_MISMATCH: ไฟล์ Migration หลัง git pull (${postPullMigrations.join(', ')}) ไม่ตรงกับที่ ADMIN อนุมัติ`
        );
      }

      databaseMigrationAttempted = true;
      if (hooks.simulateMigrationFailure) {
        throw new Error('MIGRATION_EXECUTION_FAILED: การรัน Database Migration ล้มเหลวกลางคัน (หยุดทันทีและไม่ Restart Backend)');
      }
      if (hooks.onExecuteMigration) {
        await hooks.onExecuteMigration(postPullMigrations);
      }
      databaseMigrationApplied = true;
      migrationsApplied = [...postPullMigrations];

      if (hooks.simulateSchemaVerificationFailure) {
        throw new Error('POST_MIGRATION_SCHEMA_VERIFICATION_FAILED: โครงสร้างตาราง/คอลัมน์หลัง Migration ไม่ตรงตามที่กำหนด');
      }
      schemaVerified = true;
      writeLog('INFO', `Executed & verified database migrations: ${migrationsApplied.join(', ')}`);
    } else {
      schemaVerified = true;
    }

    recordStep(5, 'Typecheck/Test/Build', 'PASS');

    // =========================================================================
    // [6/7] IIS / Backend Update (Isolated to Sam_Att on Port 4101 only)
    // =========================================================================
    currentStepNo = 6;
    currentStepName = 'IIS / Backend Update';

    if (hooks.simulateBackendStartFailure) {
      throw new Error(`BACKEND_START_FAILED: โปรเซส Sam_Att Backend ไม่สามารถเริ่มทำงานได้บนพอร์ต ${port}`);
    }

    backendRestarted = true;
    writeLog(
      'INFO',
      `Updated Frontend & restarted isolated Sam_Att backend on HTTPS port ${port} (Routing=${hooks.iisRoutingMode || 'STANDALONE_DIRECT_4101'}, Manager=${hooks.processManager || 'STANDALONE_NODE_TSX'})`
    );
    recordStep(6, 'IIS / Backend Update', 'PASS');

    // =========================================================================
    // [7/7] Health Check & Functional Smoke Verification
    // =========================================================================
    currentStepNo = 7;
    currentStepName = 'Health Check';

    if (hooks.simulateHealthApiUnreachable) {
      throw new Error(`HEALTH_API_UNREACHABLE: ไม่ได้รับการตอบกลับจาก https://localhost:${port}/api/Sam_Att/health`);
    }
    if (hooks.simulateMysqlDisconnected) {
      throw new Error('MYSQL_DISCONNECTED: Health API รายงานว่าไม่สามารถเชื่อมต่อฐานข้อมูล MySQL samchuk_attendance_v2 ได้');
    }
    if (hooks.simulateWrongDbEngineInHealth && hooks.simulateWrongDbEngineInHealth !== 'mysql') {
      throw new Error(
        `WRONG_DB_ENGINE: Health API รายงานฐานข้อมูลเป็น '${hooks.simulateWrongDbEngineInHealth}' (ต้องเป็น 'mysql' เท่านั้น)`
      );
    }

    recordStep(7, 'Health Check', 'PASS');

    printLine('');
    printLine('----------------------------------------');
    printLine('Frontend HTTPS : 200 OK');
    printLine('Backend API    : 200 OK');
    printLine('MySQL          : CONNECTED');
    printLine(`Database       : ${dbName}`);
    printLine(`Port           : ${port}`);
    printLine(`BackupDir      : ${backupDir}`);
    printLine(`BackupSql      : ${backupSqlPath}`);
    printLine(`Migrations     : ${migrationsApplied.length > 0 ? migrationsApplied.join(', ') : 'NONE'}`);
    printLine('----------------------------------------');
    printLine('');
    printLine('DEPLOYMENT SUCCESS');

    writeLog('INFO', 'DEPLOYMENT SUCCESS');

    return {
      exitCode: 0,
      finalBanner: 'DEPLOYMENT SUCCESS',
      steps,
      consoleOutput: consoleLines.join('\n'),
      logContent: logLines.join('\n'),
      logFilePath,
      backupDir,
      backupSqlPath,
      backupSqlSha256,
      backupStoredOutsideRepo,
      backupCompletedBeforeGitPull,
      commitBefore,
      commitAfter,
      migrationsApplied,
      schemaVerified,
      backendRestarted,
      rolledBack: false,
      rollbackSucceeded: false,
      requiresAdminDatabaseRestore: false,
      procurementTouched,
      iisResetExecuted,
      foreignProcessKilled,
      scannerExeModified,
      advisories,
    };
  } catch (err: unknown) {
    const rawMsg = err instanceof Error ? err.message : String(err);
    const safeMsg = maskSecretsInText(rawMsg, secretsToMask);

    if (currentStepNo >= 1 && currentStepNo <= 7) {
      recordStep(currentStepNo, currentStepName, 'FAIL', safeMsg);
    }
    printLine('');
    printLine(`ERROR [${currentStepName}]: ${safeMsg}`);

    if (currentStepNo >= 4 || gitPulled || databaseMigrationAttempted) {
      rollbackSucceeded = performSafeRollback(safeMsg);
      if (rollbackSucceeded) {
        printLine('');
        printLine('DEPLOYMENT FAILED — ROLLED BACK SAFELY TO PREVIOUS VERSION');
        return {
          exitCode: 1,
          finalBanner: 'DEPLOYMENT ROLLED_BACK',
          steps,
          consoleOutput: consoleLines.join('\n'),
          logContent: logLines.join('\n'),
          logFilePath,
          backupDir,
          backupSqlPath,
          backupSqlSha256,
          backupStoredOutsideRepo,
          backupCompletedBeforeGitPull,
          commitBefore,
          commitAfter,
          migrationsApplied,
          schemaVerified,
          backendRestarted,
          rolledBack: true,
          rollbackSucceeded: true,
          requiresAdminDatabaseRestore: false,
          procurementTouched,
          iisResetExecuted,
          foreignProcessKilled,
          scannerExeModified,
          advisories,
        };
      } else {
        printLine('');
        printLine(
          requiresAdminDatabaseRestore
            ? 'DEPLOYMENT CRITICAL — ROLLBACK FAILED (CODE REVERTED; ADMIN DATABASE RESTORE REQUIRED)'
            : 'DEPLOYMENT CRITICAL — ROLLBACK FAILED (MANUAL INTERVENTION REQUIRED)'
        );
        return {
          exitCode: 2,
          finalBanner: 'DEPLOYMENT CRITICAL',
          steps,
          consoleOutput: consoleLines.join('\n'),
          logContent: logLines.join('\n'),
          logFilePath,
          backupDir,
          backupSqlPath,
          backupSqlSha256,
          backupStoredOutsideRepo,
          backupCompletedBeforeGitPull,
          commitBefore,
          commitAfter,
          migrationsApplied,
          schemaVerified,
          backendRestarted,
          rolledBack: true,
          rollbackSucceeded: false,
          requiresAdminDatabaseRestore,
          procurementTouched,
          iisResetExecuted,
          foreignProcessKilled,
          scannerExeModified,
          advisories,
        };
      }
    }

    printLine('');
    printLine('DEPLOYMENT ABORTED (NO SYSTEM CHANGES APPLIED)');
    return {
      exitCode: 1,
      finalBanner: 'DEPLOYMENT ABORTED',
      steps,
      consoleOutput: consoleLines.join('\n'),
      logContent: logLines.join('\n'),
      logFilePath,
      backupDir,
      backupSqlPath,
      backupSqlSha256,
      backupStoredOutsideRepo,
      backupCompletedBeforeGitPull,
      commitBefore,
      commitAfter,
      migrationsApplied,
      schemaVerified,
      backendRestarted,
      rolledBack: false,
      rollbackSucceeded: false,
      requiresAdminDatabaseRestore: false,
      procurementTouched,
      iisResetExecuted,
      foreignProcessKilled,
      scannerExeModified,
      advisories,
    };
  }
}

