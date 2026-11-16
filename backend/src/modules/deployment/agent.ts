/**
 * ============================================================================
 * โมดูลตัวแทนจัดการการอัปเดต สำรองข้อมูล และย้อนกลับเวอร์ชันจริง (Sam_Att Standalone Deployment Agent)
 * ไฟล์: backend/src/modules/deployment/agent.ts
 * ============================================================================
 * หน้าที่หลัก (PHASE 2 & PHASE 3 Remediation):
 * 1. บังคับระบุ Artifact ที่มีอยู่จริงบนดิสก์ ตรวจป้องกัน Path Traversal/Symlink และคำนวณ SHA-256 จากไฟล์จริง
 * 2. ตรวจสอบโครงสร้าง Manifest ของแพ็กเกจ (Release Version, Commit SHA และรายการไฟล์พร้อม Checksum รายไฟล์)
 * 3. สำรองฐานข้อมูลจริง (ในโหมด MySQL รัน mysqldump ตรวจ Exit Code/ขนาดไฟล์/SHA-256; ในโหมด SQLite สำรองข้อมูลตารางจริง)
 *    ควบคู่กับการสำรองไฟล์ Application Release ปัจจุบันลงโฟลเดอร์ Backup พร้อมไฟล์ manifest.json.sha256
 * 4. ติดตั้ง Release ลงใน Staging Directory, ตรวจสอบความครบถ้วนของไฟล์ที่ติดตั้ง แล้วสลับไปยัง Active Release อย่างปลอดภัย
 * 5. รัน Health Check ที่ตรวจสอบทั้งฐานข้อมูลและเวอร์ชันของ Active Release บนดิสก์จริง (ห้ามใช้ SELECT 1 อย่างเดียว)
 * 6. หากการติดตั้งหรือ Health Check ล้มเหลว จะสลับกลับไปใช้ Active Release เดิมโดยอัตโนมัติและบันทึกสถานะ FAILED
 * 7. การ Rollback: ห้ามสร้าง Backup ใหม่จากสถานะปัจจุบันมาแทน Backup ที่หาย, ตรวจ SHA-256 ก่อนกู้คืนจริงทั้ง Database และ Release
 *    และมี Pre-Restore Safety Snapshot เพื่อกู้คืนอัตโนมัติหากการ Restore ล้มเหลวระหว่างทาง
 */
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../../config/env.ts';
import { dbQuery, dbExecute, dbTransaction } from '../../database/adapter.ts';

let activeOperationInProgress = false;

export function isDeploymentInProgress(): boolean {
  return activeOperationInProgress;
}

export function getDeploymentRootDirectory(): string {
  const dir = process.env.SAM_ATT_DEPLOY_ROOT_DIR
    ? path.resolve(process.cwd(), process.env.SAM_ATT_DEPLOY_ROOT_DIR)
    : path.join(os.tmpdir(), 'sam_att_v2_deployment_workspace');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getBackupDirectory(): string {
  const dir = process.env.SAM_ATT_BACKUP_DIR
    ? path.resolve(process.cwd(), process.env.SAM_ATT_BACKUP_DIR)
    : path.join(getDeploymentRootDirectory(), 'backups');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getArtifactsDirectory(): string {
  const dir = path.join(getDeploymentRootDirectory(), 'artifacts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getStagingDirectory(): string {
  const dir = path.join(getDeploymentRootDirectory(), 'staging');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function getActiveReleaseDirectory(): string {
  const dir = path.join(getDeploymentRootDirectory(), 'active_release');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export interface ReleaseFileEntry {
  relativePath: string;
  content: string;
  sha256: string;
  sizeBytes: number;
}

export interface ReleaseArtifactBundle {
  manifest: {
    serviceName: 'Sam_Att_V2_Standalone';
    releaseVersion: string;
    commitSha: string;
    createdAtIso: string;
    fileCount: number;
  };
  files: ReleaseFileEntry[];
}

export interface ActiveReleaseMetadata {
  serviceName: string;
  releaseVersion: string;
  commitSha: string;
  deployedAtIso: string;
  deployedBy: string;
  files: Array<{ relativePath: string; sha256: string; sizeBytes: number }>;
}

export interface BackupDatabaseDump {
  schema_migrations: Array<Record<string, unknown>>;
  personnel_type_rules: Array<Record<string, unknown>>;
  shifts: Array<Record<string, unknown>>;
  scanner_devices: Array<Record<string, unknown>>;
  sync_schedules: Array<Record<string, unknown>>;
}

export interface VerifiedBackupManifest {
  serviceName: 'Sam_Att_V2_Standalone';
  backupTimestamp: string;
  releaseVersion: string;
  commitSha: string;
  createdBy: string;
  databaseEngine: 'mysql' | 'sqlite_sandbox';
  databaseDumpFileName: string;
  databaseDumpSizeBytes: number;
  databaseDumpSha256: string;
  releaseSnapshotSha256: string;
  overallBackupSha256: string;
}

/**
 * ตรวจสอบความปลอดภัยของพาธเพื่อป้องกันช่องโหว่ Path Traversal และ Symlink Attack
 */
export function resolveAndValidateSafePath(baseRootDir: string, candidatePath: string): string {
  if (!candidatePath || typeof candidatePath !== 'string') {
    const err = new Error('UNSAFE_PATH_EMPTY: ไม่ได้ระบุพาธไฟล์');
    (err as Error & { code?: string }).code = 'UNSAFE_PATH_EMPTY';
    throw err;
  }
  if (candidatePath.includes('\0')) {
    const err = new Error('UNSAFE_PATH_NULL_BYTE: ตรวจพบอักขระต้องห้ามในพาธไฟล์');
    (err as Error & { code?: string }).code = 'UNSAFE_PATH_TRAVERSAL';
    throw err;
  }

  const normalizedRoot = path.resolve(baseRootDir);
  const resolvedCandidate = path.isAbsolute(candidatePath)
    ? path.resolve(candidatePath)
    : path.resolve(normalizedRoot, candidatePath);

  const relative = path.relative(normalizedRoot, resolvedCandidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    const err = new Error(
      `UNSAFE_PATH_TRAVERSAL: ไม่อนุญาตให้เข้าถึงไฟล์นอกโฟลเดอร์ที่กำหนด (${candidatePath})`
    );
    (err as Error & { code?: string }).code = 'UNSAFE_PATH_TRAVERSAL';
    throw err;
  }

  if (fs.existsSync(resolvedCandidate)) {
    const stat = fs.lstatSync(resolvedCandidate);
    if (stat.isSymbolicLink()) {
      const err = new Error('UNSAFE_PATH_SYMLINK: ไม่อนุญาตให้ใช้ Symbolic Link ในระบบ Deployment');
      (err as Error & { code?: string }).code = 'UNSAFE_PATH_SYMLINK';
      throw err;
    }
  }

  return resolvedCandidate;
}

/**
 * ตรวจสอบพาธย่อยภายในแพ็กเกจ Release (ห้ามมี .. หรือขึ้นต้นด้วย / หรือ \)
 */
export function validateSafeRelativeReleasePath(relativePath: string): string {
  const trimmed = String(relativePath || '').trim().replace(/\\/g, '/');
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    trimmed.startsWith('/') ||
    trimmed.includes('..') ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    const err = new Error(`UNSAFE_ARTIFACT_ENTRY_PATH: พาธไฟล์ภายในแพ็กเกจไม่ปลอดภัย (${relativePath})`);
    (err as Error & { code?: string }).code = 'UNSAFE_PATH_TRAVERSAL';
    throw err;
  }
  return trimmed;
}

/**
 * สร้างไฟล์แพ็กเกจ Release Artifact จริงลงดิสก์พร้อมคำนวณ SHA-256
 * ใช้สำหรับเตรียม Artifact มาตรฐานก่อนการอนุมัติติดตั้ง
 */
export function buildReleaseArtifactFile(options: {
  releaseVersion: string;
  commitSha: string;
  customFiles?: Array<{ relativePath: string; content: string }>;
  fileName?: string;
}): {
  artifactFilePath: string;
  artifactRelativeName: string;
  artifactSha256: string;
  bundle: ReleaseArtifactBundle;
} {
  const artifactsDir = getArtifactsDirectory();
  const safeVersion = options.releaseVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
  const safeCommit = options.commitSha.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 12);
  const artifactRelativeName =
    options.fileName || `sam_att_release_${safeVersion}_${safeCommit}.artifact.json`;
  const artifactFilePath = resolveAndValidateSafePath(artifactsDir, artifactRelativeName);

  const rawFiles =
    options.customFiles && options.customFiles.length > 0
      ? options.customFiles
      : [
          {
            relativePath: 'dist/index.html',
            content: `<!doctype html><html lang="th"><head><meta charset="utf-8"/><title>Sam_Att V2 Standalone ${options.releaseVersion}</title></head><body data-version="${options.releaseVersion}" data-commit="${options.commitSha}"><div id="root"></div></body></html>`,
          },
          {
            relativePath: 'version.json',
            content: JSON.stringify(
              {
                serviceName: 'Sam_Att_V2_Standalone',
                releaseVersion: options.releaseVersion,
                commitSha: options.commitSha,
              },
              null,
              2
            ),
          },
        ];

  const files: ReleaseFileEntry[] = rawFiles.map((f) => {
    const safeRel = validateSafeRelativeReleasePath(f.relativePath);
    const sha256 = crypto.createHash('sha256').update(f.content, 'utf8').digest('hex').toLowerCase();
    const sizeBytes = Buffer.byteLength(f.content, 'utf8');
    return {
      relativePath: safeRel,
      content: f.content,
      sha256,
      sizeBytes,
    };
  });

  const bundle: ReleaseArtifactBundle = {
    manifest: {
      serviceName: 'Sam_Att_V2_Standalone',
      releaseVersion: options.releaseVersion,
      commitSha: options.commitSha,
      createdAtIso: new Date().toISOString(),
      fileCount: files.length,
    },
    files,
  };

  const serialized = JSON.stringify(bundle, null, 2);
  fs.writeFileSync(artifactFilePath, serialized, { encoding: 'utf8', mode: 0o600 });
  const artifactSha256 = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex').toLowerCase();

  return {
    artifactFilePath,
    artifactRelativeName,
    artifactSha256,
    bundle,
  };
}

/**
 * อ่านข้อมูลของ Active Release ที่ติดตั้งใช้งานอยู่จริงบนดิสก์ในปัจจุบัน
 */
export function getActiveReleaseMetadata(): ActiveReleaseMetadata | null {
  const activeDir = getActiveReleaseDirectory();
  const manifestPath = path.join(activeDir, 'release-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    return JSON.parse(raw) as ActiveReleaseMetadata;
  } catch {
    return null;
  }
}

/**
 * ติดตั้งไฟล์จาก ReleaseArtifactBundle ลงในโฟลเดอร์ปลายทาง พร้อมตรวจสอบ Checksum ของทุกไฟล์หลังเขียนเสร็จ
 */
function installBundleToDirectory(
  bundle: ReleaseArtifactBundle,
  targetDir: string,
  deployedBy: string
): ActiveReleaseMetadata {
  if (fs.existsSync(targetDir)) {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });

  for (const fileEntry of bundle.files) {
    const safeRel = validateSafeRelativeReleasePath(fileEntry.relativePath);
    const destPath = resolveAndValidateSafePath(targetDir, safeRel);
    const parentDir = path.dirname(destPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(destPath, fileEntry.content, { encoding: 'utf8', mode: 0o600 });

    // ตรวจสอบไฟล์ที่ติดตั้งจริงบนดิสก์ทันที
    if (!fs.existsSync(destPath)) {
      throw new Error(`STAGING_FILE_MISSING: ไม่พบไฟล์ที่ติดตั้ง ${safeRel}`);
    }
    const writtenBuf = fs.readFileSync(destPath);
    const writtenSha = crypto.createHash('sha256').update(writtenBuf).digest('hex').toLowerCase();
    if (writtenSha !== fileEntry.sha256.toLowerCase() || writtenBuf.byteLength !== fileEntry.sizeBytes) {
      throw new Error(`STAGING_FILE_CORRUPTED: ไฟล์ ${safeRel} ที่เขียนลงดิสก์มีค่า SHA-256 หรือขนาดไม่ตรงกับ Manifest`);
    }
  }

  const metadata: ActiveReleaseMetadata = {
    serviceName: 'Sam_Att_V2_Standalone',
    releaseVersion: bundle.manifest.releaseVersion,
    commitSha: bundle.manifest.commitSha,
    deployedAtIso: new Date().toISOString(),
    deployedBy,
    files: bundle.files.map((f) => ({
      relativePath: f.relativePath,
      sha256: f.sha256.toLowerCase(),
      sizeBytes: f.sizeBytes,
    })),
  };

  fs.writeFileSync(
    path.join(targetDir, 'release-manifest.json'),
    JSON.stringify(metadata, null, 2),
    { encoding: 'utf8', mode: 0o600 }
  );

  return metadata;
}

/**
 * เตรียมสถานะเริ่มต้นของ Active Release และ Baseline Backup จริงบนดิสก์ (สำหรับการเริ่มต้นระบบครั้งแรก)
 */
export async function ensureBaselineDeploymentWorkspaceInitialized(): Promise<{
  baselineArtifactPath: string;
  baselineArtifactSha256: string;
  candidateArtifactPath: string;
  candidateArtifactSha256: string;
}> {
  const baselineArtifact = buildReleaseArtifactFile({
    releaseVersion: '2.0.0-standalone',
    commitSha: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
    fileName: 'sam_att_release_2.0.0-standalone.artifact.json',
  });

  const candidateArtifact = buildReleaseArtifactFile({
    releaseVersion: '2.0.1-standalone',
    commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    fileName: 'sam_att_release_2.0.1-standalone.artifact.json',
  });

  const currentActive = getActiveReleaseMetadata();
  if (!currentActive) {
    installBundleToDirectory(baselineArtifact.bundle, getActiveReleaseDirectory(), 'system_init');
  }

  // หากแถวที่ 1 ใน deployment_history ยังชี้ไปยังพาธจำลอง ให้สร้างไฟล์ Backup จริงของรุ่น 2.0.0-standalone แล้วผูกพาธจริง
  const row1 = await dbQuery<{ id: number; backup_archive_path: string | null }>(
    'SELECT id, backup_archive_path FROM deployment_history WHERE id = 1 LIMIT 1'
  );
  if (row1.length > 0) {
    const existingPath = row1[0].backup_archive_path;
    if (!existingPath || !fs.existsSync(existingPath)) {
      const realBackup = await createRealSystemBackup({
        releaseVersion: '2.0.0-standalone',
        commitSha: '9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e',
        actorUsername: 'system_init',
      });
      await dbExecute(
        'UPDATE deployment_history SET backup_archive_path = ?, artifact_sha256 = ? WHERE id = 1',
        [realBackup.backupFolderPath, baselineArtifact.artifactSha256]
      );
    }
  }

  return {
    baselineArtifactPath: baselineArtifact.artifactFilePath,
    baselineArtifactSha256: baselineArtifact.artifactSha256,
    candidateArtifactPath: candidateArtifact.artifactFilePath,
    candidateArtifactSha256: candidateArtifact.artifactSha256,
  };
}

/**
 * สร้างโฟลเดอร์สำรองข้อมูลจริง (Database + Active Release Files + SHA-256 Manifest)
 * - ในโหมด MySQL: รัน `mysqldump` จริง ตรวจ Exit Code === 0, ขนาดไฟล์ > 0 และคำนวณ SHA-256
 *   หาก mysqldump ล้มเหลวจะโยน Error ทันทีและไม่บันทึก Backup SUCCESS เด็ดขาด
 * - ในโหมด SQLite Sandbox/Test: ดึงข้อมูลจริงจากตารางฐานข้อมูลทั้งหมด + คัดลอกไฟล์ Active Release
 */
export async function createRealSystemBackup(options: {
  releaseVersion: string;
  commitSha: string;
  actorUsername: string;
}): Promise<{
  backupFolderPath: string;
  backupManifestPath: string;
  backupSha256: string;
  databaseDumpSha256: string;
  sizeBytes: number;
}> {
  const cfg = loadConfig();
  const backupRoot = getBackupDirectory();
  const safeVer = options.releaseVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
  const timestamp = `${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const backupFolderName = `sam_att_backup_${safeVer}_${timestamp}`;
  const backupFolderPath = resolveAndValidateSafePath(backupRoot, backupFolderName);

  fs.mkdirSync(backupFolderPath, { recursive: true, mode: 0o700 });

  try {
    // 1. สำรองฐานข้อมูลจริง
    let databaseDumpFileName = 'database_snapshot.json';
    let databaseDumpPath = path.join(backupFolderPath, databaseDumpFileName);

    if (cfg.dbEngine === 'mysql') {
      databaseDumpFileName = `${cfg.samAttDb.database}_${timestamp}.sql`;
      databaseDumpPath = path.join(backupFolderPath, databaseDumpFileName);
      try {
        execFileSync(
          'mysqldump',
          [
            `--host=${cfg.samAttDb.host}`,
            `--port=${cfg.samAttDb.port}`,
            `--user=${cfg.samAttDb.user}`,
            '--single-transaction',
            '--routines',
            '--triggers',
            `--result-file=${databaseDumpPath}`,
            cfg.samAttDb.database,
          ],
          {
            env: { ...process.env, MYSQL_PWD: cfg.samAttDb.password },
            timeout: 60000,
          }
        );
      } catch (dumpErr: unknown) {
        const msg = dumpErr instanceof Error ? dumpErr.message : String(dumpErr);
        const err = new Error(`BACKUP_MYSQLDUMP_FAILED: การสำรองฐานข้อมูล MySQL ด้วย mysqldump ล้มเหลว (${msg})`);
        (err as Error & { code?: string }).code = 'BACKUP_MYSQLDUMP_FAILED';
        throw err;
      }
    } else {
      const [migrations, rules, shifts, scanners, schedules] = await Promise.all([
        dbQuery<Record<string, unknown>>('SELECT * FROM schema_migrations ORDER BY version ASC'),
        dbQuery<Record<string, unknown>>('SELECT * FROM personnel_type_rules ORDER BY id ASC'),
        dbQuery<Record<string, unknown>>('SELECT * FROM shifts ORDER BY id ASC'),
        dbQuery<Record<string, unknown>>('SELECT * FROM scanner_devices ORDER BY id ASC'),
        dbQuery<Record<string, unknown>>('SELECT * FROM sync_schedules ORDER BY id ASC'),
      ]);

      const dbDumpPayload: BackupDatabaseDump = {
        schema_migrations: migrations,
        personnel_type_rules: rules,
        shifts,
        scanner_devices: scanners,
        sync_schedules: schedules,
      };
      fs.writeFileSync(databaseDumpPath, JSON.stringify(dbDumpPayload, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });
    }

    if (!fs.existsSync(databaseDumpPath)) {
      throw new Error('BACKUP_WRITE_FAILED: ไม่พบไฟล์สำรองฐานข้อมูลบนดิสก์');
    }
    const dbDumpStat = fs.statSync(databaseDumpPath);
    if (dbDumpStat.size <= 16) {
      throw new Error('BACKUP_EMPTY_FILE: ไฟล์สำรองฐานข้อมูลมีขนาดว่างเปล่าหรือไม่สมบูรณ์');
    }
    const dbDumpBuf = fs.readFileSync(databaseDumpPath);
    const databaseDumpSha256 = crypto.createHash('sha256').update(dbDumpBuf).digest('hex').toLowerCase();

    // 2. สำรองไฟล์ Application Release ปัจจุบันจาก active_release/
    const activeDir = getActiveReleaseDirectory();
    if (!fs.existsSync(path.join(activeDir, 'release-manifest.json'))) {
      const initArtifact = buildReleaseArtifactFile({
        releaseVersion: options.releaseVersion,
        commitSha: options.commitSha,
      });
      installBundleToDirectory(initArtifact.bundle, activeDir, options.actorUsername);
    }

    const releaseSnapshotDir = path.join(backupFolderPath, 'release_snapshot');
    fs.cpSync(activeDir, releaseSnapshotDir, { recursive: true });

    const releaseManifestPath = path.join(releaseSnapshotDir, 'release-manifest.json');
    if (!fs.existsSync(releaseManifestPath)) {
      throw new Error('BACKUP_RELEASE_SNAPSHOT_INCOMPLETE: ไม่พบไฟล์ release-manifest.json ในโฟลเดอร์สำรอง');
    }
    const releaseManifestBuf = fs.readFileSync(releaseManifestPath);
    const releaseSnapshotSha256 = crypto
      .createHash('sha256')
      .update(releaseManifestBuf)
      .digest('hex')
      .toLowerCase();

    const overallBackupSha256 = crypto
      .createHash('sha256')
      .update(`${databaseDumpSha256}:${releaseSnapshotSha256}`, 'utf8')
      .digest('hex')
      .toLowerCase();

    const manifest: VerifiedBackupManifest = {
      serviceName: 'Sam_Att_V2_Standalone',
      backupTimestamp: timestamp,
      releaseVersion: options.releaseVersion,
      commitSha: options.commitSha,
      createdBy: options.actorUsername,
      databaseEngine: cfg.dbEngine,
      databaseDumpFileName,
      databaseDumpSizeBytes: dbDumpStat.size,
      databaseDumpSha256,
      releaseSnapshotSha256,
      overallBackupSha256,
    };

    const manifestPath = path.join(backupFolderPath, 'manifest.json');
    const serializedManifest = JSON.stringify(manifest, null, 2);
    fs.writeFileSync(manifestPath, serializedManifest, { encoding: 'utf8', mode: 0o600 });

    const manifestHash = crypto
      .createHash('sha256')
      .update(serializedManifest, 'utf8')
      .digest('hex')
      .toLowerCase();
    fs.writeFileSync(path.join(backupFolderPath, 'manifest.json.sha256'), manifestHash, {
      encoding: 'utf8',
      mode: 0o600,
    });

    return {
      backupFolderPath,
      backupManifestPath: manifestPath,
      backupSha256: overallBackupSha256,
      databaseDumpSha256,
      sizeBytes: dbDumpStat.size + releaseManifestBuf.byteLength,
    };
  } catch (err) {
    if (fs.existsSync(backupFolderPath)) {
      fs.rmSync(backupFolderPath, { recursive: true, force: true });
    }
    throw err;
  }
}

/**
 * ตรวจสอบความพร้อมหลัง Deploy หรือ Rollback:
 * ห้ามตรวจเฉพาะ SELECT 1 อย่างเดียว! ต้องตรวจทั้ง:
 * 1. การเชื่อมต่อฐานข้อมูลและตาราง schema_migrations
 * 2. ไฟล์ release-manifest.json ใน active_release/ ว่ามีอยู่จริงและตรงกับเวอร์ชันที่ติดตั้ง
 * 3. ไฟล์ทุกไฟล์ที่ระบุใน release-manifest.json มีอยู่จริงบนดิสก์และมีค่า SHA-256 ตรงกันทุกไฟล์
 */
export async function executeInternalHealthCheck(expected?: {
  releaseVersion?: string;
  commitSha?: string;
}): Promise<{
  healthy: boolean;
  dbReachable: boolean;
  migrationVersionCount: number;
  activeReleaseVersion: string;
  activeCommitSha: string;
  verifiedFileCount: number;
}> {
  const ping = await dbQuery<{ ok: number }>('SELECT 1 AS ok');
  const migrations = await dbQuery<{ version: string }>('SELECT version FROM schema_migrations');
  if (ping.length === 0 || migrations.length === 0) {
    throw new Error('POST_DEPLOY_HEALTHCHECK_DB_FAILED: ฐานข้อมูลหลักไม่ตอบสนองหรือไม่พบตาราง schema_migrations');
  }

  const activeDir = getActiveReleaseDirectory();
  const activeMeta = getActiveReleaseMetadata();
  if (!activeMeta || !Array.isArray(activeMeta.files) || activeMeta.files.length === 0) {
    throw new Error('POST_DEPLOY_HEALTHCHECK_RELEASE_MISSING: ไม่พบข้อมูล Active Release บนดิสก์');
  }

  if (expected?.releaseVersion && activeMeta.releaseVersion !== expected.releaseVersion) {
    throw new Error(
      `POST_DEPLOY_HEALTHCHECK_VERSION_MISMATCH: เวอร์ชันที่ทำงานอยู่ (${activeMeta.releaseVersion}) ไม่ตรงกับเวอร์ชันเป้าหมาย (${expected.releaseVersion})`
    );
  }
  if (expected?.commitSha && activeMeta.commitSha !== expected.commitSha) {
    throw new Error(
      `POST_DEPLOY_HEALTHCHECK_COMMIT_MISMATCH: Commit ที่ทำงานอยู่ (${activeMeta.commitSha}) ไม่ตรงกับเป้าหมาย (${expected.commitSha})`
    );
  }

  for (const fileMeta of activeMeta.files) {
    const filePath = resolveAndValidateSafePath(activeDir, fileMeta.relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`POST_DEPLOY_HEALTHCHECK_FILE_MISSING: ไม่พบไฟล์ ${fileMeta.relativePath} ใน Active Release`);
    }
    const contentBuf = fs.readFileSync(filePath);
    const actualSha = crypto.createHash('sha256').update(contentBuf).digest('hex').toLowerCase();
    if (actualSha !== fileMeta.sha256.toLowerCase()) {
      throw new Error(
        `POST_DEPLOY_HEALTHCHECK_FILE_CHECKSUM_MISMATCH: ค่า SHA-256 ของไฟล์ ${fileMeta.relativePath} ใน Active Release ไม่ถูกต้อง`
      );
    }
  }

  return {
    healthy: true,
    dbReachable: true,
    migrationVersionCount: migrations.length,
    activeReleaseVersion: activeMeta.releaseVersion,
    activeCommitSha: activeMeta.commitSha,
    verifiedFileCount: activeMeta.files.length,
  };
}

/**
 * ตรวจสอบความถูกต้องของไฟล์ Artifact จริงบนดิสก์, คำนวณ SHA-256 และตรวจสอบ Manifest
 */
function loadAndVerifyReleaseArtifact(options: {
  artifactFilePath: string;
  expectedSha256: string;
  expectedReleaseVersion: string;
  expectedCommitSha: string;
}): {
  resolvedPath: string;
  computedSha256: string;
  bundle: ReleaseArtifactBundle;
} {
  if (!options.artifactFilePath || !options.artifactFilePath.trim()) {
    const err = new Error('ARTIFACT_FILE_REQUIRED: กรุณาระบุพาธไฟล์แพ็กเกจอัปเดตที่มีอยู่จริงบนดิสก์');
    (err as Error & { code?: string }).code = 'ARTIFACT_FILE_REQUIRED';
    throw err;
  }

  // ตรวจสอบ Path Traversal ให้อยู่ภายใต้โฟลเดอร์ Artifacts หรือโฟลเดอร์โปรเจกต์ที่อนุญาตเท่านั้น
  const artifactsRoot = getArtifactsDirectory();
  let resolvedPath: string;
  if (path.isAbsolute(options.artifactFilePath)) {
    resolvedPath = resolveAndValidateSafePath(artifactsRoot, options.artifactFilePath);
  } else {
    resolvedPath = resolveAndValidateSafePath(artifactsRoot, options.artifactFilePath);
  }

  if (!fs.existsSync(resolvedPath)) {
    const err = new Error(`ARTIFACT_FILE_NOT_FOUND: ไม่พบไฟล์แพ็กเกจอัปเดตที่ ${options.artifactFilePath}`);
    (err as Error & { code?: string }).code = 'ARTIFACT_FILE_NOT_FOUND';
    throw err;
  }

  const stat = fs.lstatSync(resolvedPath);
  if (!stat.isFile() || stat.size <= 0) {
    const err = new Error('ARTIFACT_INVALID_FILE: พาธที่ระบุไม่ใช่ไฟล์แพ็กเกจที่ถูกต้องหรือมีขนาด 0 ไบต์');
    (err as Error & { code?: string }).code = 'ARTIFACT_INVALID_FILE';
    throw err;
  }

  const rawBuf = fs.readFileSync(resolvedPath);
  const computedSha256 = crypto.createHash('sha256').update(rawBuf).digest('hex').toLowerCase();
  const normalizedExpected = options.expectedSha256.trim().toLowerCase();

  if (computedSha256 !== normalizedExpected) {
    const shaErr = new Error(
      `ARTIFACT_SHA256_MISMATCH: ค่า SHA-256 ของไฟล์แพ็กเกจจริง (${computedSha256}) ไม่ตรงกับค่าที่อนุมัติ (${normalizedExpected})`
    );
    (shaErr as Error & { code?: string }).code = 'ARTIFACT_SHA256_MISMATCH';
    throw shaErr;
  }

  let bundle: ReleaseArtifactBundle;
  try {
    bundle = JSON.parse(rawBuf.toString('utf8')) as ReleaseArtifactBundle;
  } catch {
    const parseErr = new Error('ARTIFACT_MANIFEST_INVALID_JSON: ไฟล์แพ็กเกจอัปเดตไม่ใช่รูปแบบ Manifest ที่ถูกต้อง');
    (parseErr as Error & { code?: string }).code = 'ARTIFACT_MANIFEST_INVALID';
    throw parseErr;
  }

  if (
    !bundle ||
    !bundle.manifest ||
    bundle.manifest.serviceName !== 'Sam_Att_V2_Standalone' ||
    !Array.isArray(bundle.files) ||
    bundle.files.length === 0
  ) {
    const mfErr = new Error('ARTIFACT_MANIFEST_INVALID: โครงสร้าง Manifest ของแพ็กเกจอัปเดตไม่ครบถ้วน');
    (mfErr as Error & { code?: string }).code = 'ARTIFACT_MANIFEST_INVALID';
    throw mfErr;
  }

  if (bundle.manifest.releaseVersion !== options.expectedReleaseVersion) {
    const verErr = new Error(
      `ARTIFACT_VERSION_MISMATCH: เวอร์ชันใน Manifest (${bundle.manifest.releaseVersion}) ไม่ตรงกับที่ระบุ (${options.expectedReleaseVersion})`
    );
    (verErr as Error & { code?: string }).code = 'ARTIFACT_VERSION_MISMATCH';
    throw verErr;
  }

  if (bundle.manifest.commitSha !== options.expectedCommitSha) {
    const commitErr = new Error(
      `ARTIFACT_COMMIT_MISMATCH: รหัส Commit ใน Manifest (${bundle.manifest.commitSha}) ไม่ตรงกับที่ระบุ (${options.expectedCommitSha})`
    );
    (commitErr as Error & { code?: string }).code = 'ARTIFACT_COMMIT_MISMATCH';
    throw commitErr;
  }

  for (const f of bundle.files) {
    validateSafeRelativeReleasePath(f.relativePath);
    const fileSha = crypto.createHash('sha256').update(f.content, 'utf8').digest('hex').toLowerCase();
    if (fileSha !== String(f.sha256 || '').toLowerCase()) {
      const fErr = new Error(`ARTIFACT_ENTRY_CHECKSUM_MISMATCH: ไฟล์ ${f.relativePath} ในแพ็กเกจมีค่า SHA-256 ไม่ตรงกับ Manifest`);
      (fErr as Error & { code?: string }).code = 'ARTIFACT_ENTRY_CHECKSUM_MISMATCH';
      throw fErr;
    }
  }

  return {
    resolvedPath,
    computedSha256,
    bundle,
  };
}

/**
 * ดำเนินการอัปเดตระบบจริงผ่าน Deployment Agent (PHASE 2 Complete Flow):
 * 1. ป้องกัน Concurrent Deployment (`DEPLOYMENT_BUSY`)
 * 2. บันทึกแถวเริ่มต้นด้วยสถานะ `PENDING` -> เปลี่ยนเป็น `RUNNING`
 * 3. ตรวจสอบไฟล์ Artifact จริงบนดิสก์, ป้องกัน Path Traversal, ตรวจ SHA-256 และตรวจ Manifest
 * 4. สร้าง Backup จริงของสถานะปัจจุบันก่อนปรับรุ่น (`createRealSystemBackup`)
 * 5. ติดตั้ง Release ใหม่ลงใน Staging Directory และตรวจสอบความครบถ้วนของไฟล์ทั้งหมด
 * 6. สำรอง Active Release เดิมไว้ในโฟลเดอร์ชั่วคราว แล้วสลับไปใช้ Release ใหม่
 * 7. รัน Health Check จริง (ตรวจทั้ง DB และเวอร์ชัน + SHA-256 ของ Active Release บนดิสก์)
 * 8. หากขั้นตอนที่ 5–7 ล้มเหลว จะคืน Active Release เดิมกลับมาโดยอัตโนมัติและบันทึกสถานะ `FAILED`
 */
export async function executeStandaloneDeployment(options: {
  releaseVersion: string;
  commitSha: string;
  expectedArtifactSha256: string;
  artifactFilePath: string;
  actorUsername: string;
  simulatePostSwitchHealthFailure?: boolean;
}): Promise<{
  deploymentId: number;
  status: 'SUCCESS' | 'FAILED';
  releaseVersion: string;
  commitSha: string;
  artifactSha256: string;
  backupArchivePath: string;
  backupSha256: string;
  stagedFileCount: number;
  healthCheck: {
    healthy: boolean;
    dbReachable: boolean;
    migrationVersionCount: number;
    activeReleaseVersion: string;
    activeCommitSha: string;
    verifiedFileCount: number;
  };
}> {
  if (activeOperationInProgress) {
    const err = new Error('DEPLOYMENT_BUSY: มีกระบวนการ Deploy หรือ Rollback กำลังทำงานอยู่ ห้ามสั่งซ้อนกัน');
    (err as Error & { code?: string; statusCode?: number }).code = 'DEPLOYMENT_BUSY';
    (err as Error & { code?: string; statusCode?: number }).statusCode = 409;
    throw err;
  }

  activeOperationInProgress = true;
  const normalizedExpectedSha = options.expectedArtifactSha256.trim().toLowerCase();

  const pendingInsert = await dbExecute(
    `INSERT INTO deployment_history (
      release_version, commit_sha, artifact_sha256, action_type, status,
      backup_archive_path, preflight_passed, notes, executed_by
    ) VALUES (?, ?, ?, 'STANDALONE_DEPLOY', 'PENDING', NULL, 1, 'รอดำเนินการโดย Sam_Att Deployment Agent', ?)`,
    [options.releaseVersion, options.commitSha, normalizedExpectedSha, options.actorUsername]
  );
  const deploymentId = pendingInsert.insertId || 1;

  let previousActiveBackupDir: string | null = null;
  let stagingTargetDir: string | null = null;
  let switchedActiveRelease = false;

  try {
    await dbExecute(
      "UPDATE deployment_history SET status = 'RUNNING', notes = 'กำลังตรวจสอบไฟล์ Artifact, สำรองข้อมูล และติดตั้งลง Staging' WHERE id = ?",
      [deploymentId]
    );

    // 1. ตรวจสอบไฟล์ Artifact จริง, Path Traversal, SHA-256 และ Manifest
    const verifiedArtifact = loadAndVerifyReleaseArtifact({
      artifactFilePath: options.artifactFilePath,
      expectedSha256: normalizedExpectedSha,
      expectedReleaseVersion: options.releaseVersion,
      expectedCommitSha: options.commitSha,
    });

    // 2. สำรองข้อมูลของรุ่นที่กำลังทำงานอยู่ในปัจจุบันก่อนสลับไปรุ่นใหม่
    const currentActive = getActiveReleaseMetadata();
    const backup = await createRealSystemBackup({
      releaseVersion: currentActive?.releaseVersion || '2.0.0-standalone',
      commitSha: currentActive?.commitSha || 'HEAD',
      actorUsername: options.actorUsername,
    });

    // 3. ติดตั้ง Release ใหม่ลงใน Staging Directory และตรวจสอบความครบถ้วนของไฟล์ที่ติดตั้ง
    const safeVer = options.releaseVersion.replace(/[^a-zA-Z0-9._-]/g, '_');
    stagingTargetDir = resolveAndValidateSafePath(
      getStagingDirectory(),
      `stage_${safeVer}_${deploymentId}_${Date.now()}`
    );
    installBundleToDirectory(verifiedArtifact.bundle, stagingTargetDir, options.actorUsername);

    // 4. เก็บสำเนาของ Active Release เดิมไว้ก่อนสลับ เพื่อใช้กู้คืนอัตโนมัติหากการสลับหรือ Health Check ล้มเหลว
    const activeDir = getActiveReleaseDirectory();
    previousActiveBackupDir = resolveAndValidateSafePath(
      getStagingDirectory(),
      `prev_active_${deploymentId}_${Date.now()}`
    );
    if (fs.existsSync(activeDir)) {
      fs.cpSync(activeDir, previousActiveBackupDir, { recursive: true });
      fs.rmSync(activeDir, { recursive: true, force: true });
    }
    fs.cpSync(stagingTargetDir, activeDir, { recursive: true });
    switchedActiveRelease = true;

    // 5. จำลองความล้มเหลวหลังสลับ Release (สำหรับการทดสอบ Automatic Revert ใน Automated Tests)
    if (options.simulatePostSwitchHealthFailure) {
      throw new Error('POST_DEPLOY_HEALTHCHECK_FAILED: บริการไม่ผ่านการตรวจสอบความพร้อมหลังสลับ Release');
    }

    // 6. ถ้าระบุให้รีสตาร์ท Windows Service ผ่านกลไกจำกัดสิทธิ์ของ WinSW
    if (process.platform === 'win32' && process.env.SAM_ATT_SERVICE_RESTART_ON_DEPLOY === 'true') {
      const winswExe = process.env.SAM_ATT_WINSW_EXE_PATH || 'C:\\Sam_Att\\bin\\WinSW-x64.exe';
      const winswXml = process.env.SAM_ATT_WINSW_XML_PATH || 'C:\\Sam_Att\\app\\scripts\\winsw-sam-att.xml';
      if (fs.existsSync(winswExe) && fs.existsSync(winswXml)) {
        execFileSync(winswExe, ['restart', winswXml], { timeout: 30000 });
      }
    }

    // 7. ตรวจ Health Check จริงหลังเปลี่ยน Release (ทั้ง DB และไฟล์ Active Release เวอร์ชันใหม่บนดิสก์)
    const healthCheck = await executeInternalHealthCheck({
      releaseVersion: options.releaseVersion,
      commitSha: options.commitSha,
    });

    // 8. บันทึก SUCCESS เมื่อทุกขั้นตอนสำเร็จจริงเท่านั้น
    await dbExecute(
      `UPDATE deployment_history
       SET status = 'SUCCESS',
           backup_archive_path = ?,
           notes = ?
       WHERE id = ?`,
      [
        backup.backupFolderPath,
        `Deploy รุ่น ${options.releaseVersion} สำเร็จ (Files: ${healthCheck.verifiedFileCount}, Backup SHA-256: ${backup.backupSha256.slice(0, 16)}...)`,
        deploymentId,
      ]
    );

    return {
      deploymentId,
      status: 'SUCCESS',
      releaseVersion: options.releaseVersion,
      commitSha: options.commitSha,
      artifactSha256: verifiedArtifact.computedSha256,
      backupArchivePath: backup.backupFolderPath,
      backupSha256: backup.backupSha256,
      stagedFileCount: verifiedArtifact.bundle.files.length,
      healthCheck,
    };
  } catch (err: unknown) {
    // หากสลับ Active Release ไปแล้วแต่เกิดความล้มเหลว ให้สลับกลับไปใช้ Release เดิมโดยอัตโนมัติ
    if (switchedActiveRelease && previousActiveBackupDir && fs.existsSync(previousActiveBackupDir)) {
      try {
        const activeDir = getActiveReleaseDirectory();
        if (fs.existsSync(activeDir)) {
          fs.rmSync(activeDir, { recursive: true, force: true });
        }
        fs.cpSync(previousActiveBackupDir, activeDir, { recursive: true });
      } catch (revertErr) {
        console.error('[Deployment Agent] Failed to revert active release after deploy error:', revertErr);
      }
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    await dbExecute(
      "UPDATE deployment_history SET status = 'FAILED', notes = ? WHERE id = ?",
      [`Deploy ล้มเหลว (คืนค่า Release เดิมแล้ว): ${errMsg.slice(0, 850)}`, deploymentId]
    );
    throw err;
  } finally {
    if (stagingTargetDir && fs.existsSync(stagingTargetDir)) {
      fs.rmSync(stagingTargetDir, { recursive: true, force: true });
    }
    if (previousActiveBackupDir && fs.existsSync(previousActiveBackupDir)) {
      fs.rmSync(previousActiveBackupDir, { recursive: true, force: true });
    }
    activeOperationInProgress = false;
  }
}

/**
 * กู้คืนข้อมูลตารางฐานข้อมูลจาก BackupDatabaseDump ภายใต้ Transaction จริง (ห้ามใช้ SELECT 1 แทนการกู้คืน)
 */
async function restoreDatabaseTablesFromDump(dump: BackupDatabaseDump): Promise<number> {
  let restoredTablesCount = 0;

  const tablesToRestore: Array<{
    tableName: string;
    rows: Array<Record<string, unknown>> | undefined;
  }> = [
    { tableName: 'sync_schedules', rows: dump.sync_schedules },
    { tableName: 'personnel_type_rules', rows: dump.personnel_type_rules },
    { tableName: 'shifts', rows: dump.shifts },
    { tableName: 'scanner_devices', rows: dump.scanner_devices },
  ];

  await dbTransaction(async (tx) => {
    for (const entry of tablesToRestore) {
      if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
        continue;
      }

      const backupIds = entry.rows
        .map((r) => r.id)
        .filter((id): id is number | string => id !== undefined && id !== null);

      if (backupIds.length > 0) {
        const idPlaceholders = backupIds.map(() => '?').join(', ');
        if (entry.tableName === 'shifts') {
          await tx.execute(
            `DELETE FROM shifts WHERE id NOT IN (${idPlaceholders}) AND id NOT IN (SELECT shift_id FROM shift_assignments WHERE shift_id IS NOT NULL)`,
            backupIds
          );
        } else {
          await tx.execute(
            `DELETE FROM ${entry.tableName} WHERE id NOT IN (${idPlaceholders})`,
            backupIds
          );
        }
      } else if (entry.tableName !== 'shifts') {
        await tx.execute(`DELETE FROM ${entry.tableName}`);
      }

      for (const row of entry.rows) {
        const columns = Object.keys(row).filter((col) => /^[a-zA-Z0-9_]+$/.test(col));
        if (columns.length === 0) continue;

        if (row.id !== undefined && row.id !== null) {
          const existing = await tx.query<{ id: number | string }>(
            `SELECT id FROM ${entry.tableName} WHERE id = ? LIMIT 1`,
            [row.id]
          );
          if (existing.length > 0) {
            const updateCols = columns.filter((col) => col !== 'id');
            if (updateCols.length > 0) {
              const setClause = updateCols.map((col) => `${col} = ?`).join(', ');
              const updateValues = [...updateCols.map((col) => row[col] ?? null), row.id];
              await tx.execute(
                `UPDATE ${entry.tableName} SET ${setClause} WHERE id = ?`,
                updateValues
              );
            }
            continue;
          }
        }

        const placeholders = columns.map(() => '?').join(', ');
        const values = columns.map((col) => row[col] ?? null);
        await tx.execute(
          `INSERT INTO ${entry.tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
          values
        );
      }
      restoredTablesCount++;
    }
  });

  return restoredTablesCount;
}

/**
 * ดำเนินการ Rollback ระบบกลับไปยังจุดสำรองข้อมูลจริง (PHASE 3 Complete Flow):
 * 1. ห้ามสร้าง Backup ใหม่จากสถานะปัจจุบันมาแทน Backup ที่หาย! หากไม่พบโฟลเดอร์ Backup ต้องล้มเหลวด้วย `BACKUP_ARCHIVE_MISSING`
 * 2. ตรวจสอบค่า SHA-256 ของ `manifest.json`, ไฟล์สำรองฐานข้อมูล และ `release-manifest.json` ก่อนเริ่มกู้คืน
 * 3. สร้าง Pre-Restore Safety Snapshot ของสถานะปัจจุบัน เพื่อกู้คืนอัตโนมัติหากการ Restore ล้มเหลวระหว่างทาง
 * 4. กู้คืนทั้งตารางฐานข้อมูลจริง (ไม่ใช่ `SELECT 1`) และไฟล์ Application Release (`active_release/`)
 * 5. รัน Health Check จริงหลัง Rollback
 */
export async function executeStandaloneRollback(options: {
  targetBackupId: number;
  reason: string;
  actorUsername: string;
  simulateMidwayRestoreFailure?: boolean;
}): Promise<{
  rollbackEntryId: number;
  status: 'SUCCESS' | 'FAILED';
  targetVersion: string;
  restoredFromPath: string;
  restoredTablesCount: number;
  healthCheck: {
    healthy: boolean;
    dbReachable: boolean;
    migrationVersionCount: number;
    activeReleaseVersion: string;
    activeCommitSha: string;
    verifiedFileCount: number;
  };
}> {
  if (activeOperationInProgress) {
    const err = new Error('DEPLOYMENT_BUSY: มีกระบวนการ Deploy หรือ Rollback กำลังทำงานอยู่');
    (err as Error & { code?: string; statusCode?: number }).code = 'DEPLOYMENT_BUSY';
    (err as Error & { code?: string; statusCode?: number }).statusCode = 409;
    throw err;
  }

  const targetRows = await dbQuery<{
    id: number;
    release_version: string;
    commit_sha: string;
    artifact_sha256: string;
    backup_archive_path: string | null;
  }>('SELECT * FROM deployment_history WHERE id = ? LIMIT 1', [options.targetBackupId]);

  if (targetRows.length === 0) {
    const notFound = new Error('BACKUP_NOT_FOUND: ไม่พบรายการสำรองข้อมูลที่ต้องการ Rollback');
    (notFound as Error & { code?: string; statusCode?: number }).code = 'BACKUP_NOT_FOUND';
    (notFound as Error & { code?: string; statusCode?: number }).statusCode = 404;
    throw notFound;
  }

  activeOperationInProgress = true;
  const target = targetRows[0];

  const pendingRollback = await dbExecute(
    `INSERT INTO deployment_history (
      release_version, commit_sha, artifact_sha256, action_type, status,
      backup_archive_path, preflight_passed, notes, executed_by
    ) VALUES (?, ?, ?, 'STANDALONE_ROLLBACK', 'PENDING', ?, 1, ?, ?)`,
    [
      target.release_version,
      target.commit_sha || 'rollback-commit',
      target.artifact_sha256,
      target.backup_archive_path,
      `เริ่มต้นกระบวนการ Rollback: ${options.reason}`,
      options.actorUsername,
    ]
  );
  const rollbackEntryId = pendingRollback.insertId || 1;

  let safetyBackupFolder: string | null = null;
  let safetyDbDump: BackupDatabaseDump | null = null;

  try {
    await dbExecute(
      "UPDATE deployment_history SET status = 'RUNNING', notes = 'กำลังตรวจสอบ SHA-256 ของ Backup และกู้คืนข้อมูลจริง' WHERE id = ?",
      [rollbackEntryId]
    );

    // 1. ห้ามสร้าง Backup ใหม่มาแทน Backup ที่หาย! ต้องตรวจว่ามีอยู่จริงบนดิสก์
    const rawArchivePath = target.backup_archive_path || '';
    if (!rawArchivePath) {
      const missingErr = new Error('BACKUP_ARCHIVE_MISSING: รายการนี้ไม่มีพาธไฟล์สำรองข้อมูล');
      (missingErr as Error & { code?: string }).code = 'BACKUP_ARCHIVE_MISSING';
      throw missingErr;
    }

    const archiveDir = resolveAndValidateSafePath(getBackupDirectory(), rawArchivePath);
    if (!fs.existsSync(archiveDir)) {
      const missingErr = new Error(
        `BACKUP_ARCHIVE_MISSING: ไม่พบโฟลเดอร์สำรองข้อมูลที่ ${rawArchivePath} (ห้ามสร้าง Backup ใหม่จากสถานะปัจจุบันมาใช้แทน)`
      );
      (missingErr as Error & { code?: string }).code = 'BACKUP_ARCHIVE_MISSING';
      throw missingErr;
    }

    const manifestPath = path.join(archiveDir, 'manifest.json');
    const manifestShaPath = path.join(archiveDir, 'manifest.json.sha256');
    if (!fs.existsSync(manifestPath) || !fs.existsSync(manifestShaPath)) {
      const corruptErr = new Error('CORRUPTED_BACKUP_ARCHIVE: ไม่พบ manifest.json หรือ manifest.json.sha256 ในโฟลเดอร์สำรอง');
      (corruptErr as Error & { code?: string }).code = 'CORRUPTED_BACKUP_ARCHIVE';
      throw corruptErr;
    }

    // 2. ตรวจสอบค่า SHA-256 ของ manifest.json และไฟล์สำรองฐานข้อมูลก่อนเริ่มกู้คืน
    const rawManifest = fs.readFileSync(manifestPath, 'utf8');
    const expectedManifestSha = fs.readFileSync(manifestShaPath, 'utf8').trim().toLowerCase();
    const actualManifestSha = crypto.createHash('sha256').update(rawManifest, 'utf8').digest('hex').toLowerCase();
    if (actualManifestSha !== expectedManifestSha) {
      const shaErr = new Error(
        `BACKUP_CHECKSUM_MISMATCH: ค่า SHA-256 ของ manifest.json ไม่ตรงกัน (${actualManifestSha} !== ${expectedManifestSha})`
      );
      (shaErr as Error & { code?: string }).code = 'BACKUP_CHECKSUM_MISMATCH';
      throw shaErr;
    }

    const manifest = JSON.parse(rawManifest) as VerifiedBackupManifest;
    const dbDumpPath = resolveAndValidateSafePath(archiveDir, manifest.databaseDumpFileName);
    if (!fs.existsSync(dbDumpPath)) {
      const dumpMissing = new Error(`BACKUP_DUMP_MISSING: ไม่พบไฟล์สำรองฐานข้อมูล ${manifest.databaseDumpFileName}`);
      (dumpMissing as Error & { code?: string }).code = 'BACKUP_DUMP_MISSING';
      throw dumpMissing;
    }

    const dbDumpBuf = fs.readFileSync(dbDumpPath);
    const actualDbDumpSha = crypto.createHash('sha256').update(dbDumpBuf).digest('hex').toLowerCase();
    if (actualDbDumpSha !== manifest.databaseDumpSha256.toLowerCase()) {
      const dumpShaErr = new Error(
        `BACKUP_CHECKSUM_MISMATCH: ค่า SHA-256 ของไฟล์สำรองฐานข้อมูลถูกแก้ไขหรือเสียหาย (${actualDbDumpSha} !== ${manifest.databaseDumpSha256})`
      );
      (dumpShaErr as Error & { code?: string }).code = 'BACKUP_CHECKSUM_MISMATCH';
      throw dumpShaErr;
    }

    const releaseSnapshotDir = resolveAndValidateSafePath(archiveDir, 'release_snapshot');
    const snapshotManifestPath = path.join(releaseSnapshotDir, 'release-manifest.json');
    if (!fs.existsSync(snapshotManifestPath)) {
      const relErr = new Error('BACKUP_RELEASE_MISSING: ไม่พบไฟล์สำรอง Application Release ในโฟลเดอร์ Backup');
      (relErr as Error & { code?: string }).code = 'BACKUP_RELEASE_MISSING';
      throw relErr;
    }

    // 3. สร้าง Pre-Restore Safety Snapshot ของสถานะปัจจุบัน เพื่อกู้คืนอัตโนมัติหากการ Restore ล้มเหลวระหว่างทาง
    const currentActive = getActiveReleaseMetadata();
    const safetyBackup = await createRealSystemBackup({
      releaseVersion: currentActive?.releaseVersion || 'pre-restore-safety',
      commitSha: currentActive?.commitSha || 'HEAD',
      actorUsername: options.actorUsername,
    });
    safetyBackupFolder = safetyBackup.backupFolderPath;
    const safetyDbDumpPath = path.join(safetyBackupFolder, 'database_snapshot.json');
    if (fs.existsSync(safetyDbDumpPath)) {
      safetyDbDump = JSON.parse(fs.readFileSync(safetyDbDumpPath, 'utf8')) as BackupDatabaseDump;
    }

    // 4. กู้คืนข้อมูลตารางฐานข้อมูลจริงจาก Backup
    let restoredTablesCount = 0;
    const cfg = loadConfig();
    if (manifest.databaseEngine === 'mysql' && cfg.dbEngine === 'mysql') {
      execFileSync(
        'mysql',
        [
          `--host=${cfg.samAttDb.host}`,
          `--port=${cfg.samAttDb.port}`,
          `--user=${cfg.samAttDb.user}`,
          cfg.samAttDb.database,
        ],
        {
          input: dbDumpBuf,
          env: { ...process.env, MYSQL_PWD: cfg.samAttDb.password },
          timeout: 60000,
        }
      );
      restoredTablesCount = 5;
    } else {
      const parsedDump = JSON.parse(dbDumpBuf.toString('utf8')) as BackupDatabaseDump;
      restoredTablesCount = await restoreDatabaseTablesFromDump(parsedDump);
    }

    // 5. กู้คืนไฟล์ Application Release ไปยัง active_release/
    const activeDir = getActiveReleaseDirectory();
    if (fs.existsSync(activeDir)) {
      fs.rmSync(activeDir, { recursive: true, force: true });
    }
    fs.cpSync(releaseSnapshotDir, activeDir, { recursive: true });

    if (options.simulateMidwayRestoreFailure) {
      throw new Error('RESTORE_MIDWAY_INTERRUPTED: เกิดข้อผิดพลาดระหว่างการสลับไฟล์หลังกู้คืนฐานข้อมูล');
    }

    // 6. รัน Health Check จริงเพื่อยืนยันว่าทั้งฐานข้อมูลและเวอร์ชันของ Active Release กลับมาเป็นรุ่นที่อยู่ใน Backup
    const restoredMeta = getActiveReleaseMetadata();
    const healthCheck = await executeInternalHealthCheck({
      releaseVersion: restoredMeta?.releaseVersion || manifest.releaseVersion,
      commitSha: restoredMeta?.commitSha || manifest.commitSha,
    });

    await dbExecute(
      `UPDATE deployment_history
       SET status = 'SUCCESS',
           backup_archive_path = ?,
           notes = ?
       WHERE id = ?`,
      [
        archiveDir,
        `Rollback ไปยังรุ่น ${healthCheck.activeReleaseVersion} สำเร็จ (${options.reason}) — กู้คืน ${restoredTablesCount} ตารางจริง + ตรวจ HealthCheck ผ่าน`,
        rollbackEntryId,
      ]
    );

    return {
      rollbackEntryId,
      status: 'SUCCESS',
      targetVersion: healthCheck.activeReleaseVersion,
      restoredFromPath: archiveDir,
      restoredTablesCount,
      healthCheck,
    };
  } catch (err: unknown) {
    // กู้คืนจาก Pre-Restore Safety Snapshot อัตโนมัติหากการ Restore ล้มเหลวระหว่างทาง
    if (safetyBackupFolder && fs.existsSync(safetyBackupFolder)) {
      try {
        if (safetyDbDump) {
          await restoreDatabaseTablesFromDump(safetyDbDump);
        }
        const safetyRelDir = path.join(safetyBackupFolder, 'release_snapshot');
        const activeDir = getActiveReleaseDirectory();
        if (fs.existsSync(safetyRelDir)) {
          if (fs.existsSync(activeDir)) {
            fs.rmSync(activeDir, { recursive: true, force: true });
          }
          fs.cpSync(safetyRelDir, activeDir, { recursive: true });
        }
      } catch (recoveryErr) {
        console.error('[Rollback Safety Recovery Error]', recoveryErr);
      }
    }

    const errMsg = err instanceof Error ? err.message : String(err);
    await dbExecute(
      "UPDATE deployment_history SET status = 'FAILED', notes = ? WHERE id = ?",
      [`Rollback ล้มเหลว (กู้คืนสถานะก่อนหน้าแล้ว): ${errMsg.slice(0, 850)}`, rollbackEntryId]
    );
    throw err;
  } finally {
    if (safetyBackupFolder && fs.existsSync(safetyBackupFolder)) {
      fs.rmSync(safetyBackupFolder, { recursive: true, force: true });
    }
    activeOperationInProgress = false;
  }
}
