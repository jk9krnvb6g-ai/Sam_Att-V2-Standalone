/**
 * ============================================================================
 * Persistent Disk Job Store & Lock Manager สำหรับ Application-Only Updater
 * ไฟล์: backend/src/modules/deployment/jobStore.ts
 * ============================================================================
 * หน้าที่หลัก:
 * - จัดเก็บสถานะงานอัปเดต/ย้อนกลับ Application ลงดิสก์ (logs/deploy_jobs/job_<id>.json และ latest_job.json)
 *   เพื่อให้สถานะ 8 ขั้นตอนรอดชีวิตข้ามการรีสตาร์ทโปรเซส Sam_Att (Node.js / WinSW)
 * - จัดการไฟล์ Lock (deploy_active.lock) พร้อมตรวจ PID liveness และ stale timeout ป้องกันการกดซ้อนและการค้างถาวร
 * - ปกปิด Token/Password/Secret ทุกครั้งก่อนคืนค่า Log Tail หรือบันทึกลงฐานข้อมูล
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { dbExecute } from '../../database/adapter.ts';
import { writeAuditLog } from '../audit/service.ts';
import { sanitizeDeploymentLog } from './githubUpdateCenter.ts';

export type PersistentDeployJobType = 'APP_UPDATE' | 'APP_ROLLBACK';
export type PersistentDeployJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'ROLLED_BACK'
  | 'NO_CHANGES';
export type PersistentStepStatus = 'PENDING' | 'RUNNING' | 'PASS' | 'FAIL' | 'SKIP';

export interface PersistentDeployStep {
  stepNumber: number;
  key: string;
  name: string;
  labelThai: string;
  status: PersistentStepStatus;
  detail: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface PersistentDeployJob {
  jobId: string;
  jobType: PersistentDeployJobType;
  status: PersistentDeployJobStatus;
  actorUsername: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  pid: number | null;
  currentStepNumber: number;
  currentStepName: string;
  currentStepLabelThai: string;
  progressPercent: number;
  commitBefore: string | null;
  targetCommit: string | null;
  commitAfter: string | null;
  snapshotDir: string | null;
  npmCiExecuted: boolean | null;
  npmCiReason: string | null;
  rolledBack: boolean;
  rollbackSnapshotDir: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  historyRecorded: boolean;
  logFilePath: string | null;
  logTail: string[];
  steps: PersistentDeployStep[];
}

export interface DeployLockInfo {
  locked: boolean;
  acquired?: boolean;
  staleCleaned: boolean;
  lockFilePath: string;
  jobId: string | null;
  pid: number | null;
  startedAt: string | null;
  actorUsername: string | null;
}

export interface AppSnapshotSummary {
  snapshotName: string;
  snapshotDir: string;
  commitBefore: string | null;
  createdAt: string | null;
  hasDist: boolean;
  lockfileHash: string | null;
}

const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;

export const CANONICAL_8_STEPS: Array<{ stepNumber: number; key: string; name: string; labelThai: string }> = [
  { stepNumber: 1, key: 'PREFLIGHT', name: 'Preflight Check', labelThai: 'ตรวจสอบความพร้อมก่อนอัปเดต' },
  { stepNumber: 2, key: 'VERSION_CHECK', name: 'Version Check', labelThai: 'ตรวจสอบเวอร์ชันจาก GitHub' },
  { stepNumber: 3, key: 'PREPARE_SNAPSHOT', name: 'Prepare Snapshot', labelThai: 'เตรียมสำรองสถานะ Application นอก Git Repo' },
  { stepNumber: 4, key: 'UPDATE_SOURCE_DEPS', name: 'Update Source & Deps', labelThai: 'ดึงซอร์สโค้ดและจัดการ Dependencies' },
  { stepNumber: 5, key: 'CHECK_BUILD', name: 'Check & Build', labelThai: 'ตรวจสอบ TypeScript และ Build' },
  { stepNumber: 6, key: 'RESTART_APP', name: 'Restart Application', labelThai: 'รีสตาร์ทบริการ Sam_Att บนพอร์ต 4101' },
  { stepNumber: 7, key: 'HEALTH_CHECK', name: 'Health Check', labelThai: 'ตรวจสอบความพร้อม Frontend / API / MySQL' },
  { stepNumber: 8, key: 'FINAL_REPORT', name: 'Final Report', labelThai: 'สรุปผลการอัปเดต' },
];

export const CANONICAL_ROLLBACK_STEPS: Array<{ stepNumber: number; key: string; name: string; labelThai: string }> = [
  { stepNumber: 1, key: 'ROLLBACK_VALIDATE', name: 'Validate Snapshot', labelThai: 'ตรวจสอบ Snapshot และสิทธิ์ Application Rollback' },
  { stepNumber: 2, key: 'ROLLBACK_STOP', name: 'Stop Sam_Att Process', labelThai: 'หยุดโปรเซส Sam_Att เดิมอย่างปลอดภัย' },
  { stepNumber: 3, key: 'ROLLBACK_RESTORE', name: 'Restore Source & Dist', labelThai: 'ย้อนซอร์สโค้ด (git reset --keep) และไฟล์ Build เดิม' },
  { stepNumber: 4, key: 'ROLLBACK_RESTART', name: 'Restart Sam_Att Process', labelThai: 'เริ่มต้นบริการ Sam_Att บนพอร์ต 4101 ใหม่' },
  { stepNumber: 5, key: 'ROLLBACK_HEALTH', name: 'Health Check & Report', labelThai: 'ตรวจสอบ Health Check หลังย้อนกลับ' },
];

export function createInitialSteps(jobType: PersistentDeployJobType = 'APP_UPDATE'): PersistentDeployStep[] {
  const template = jobType === 'APP_ROLLBACK' ? CANONICAL_ROLLBACK_STEPS : CANONICAL_8_STEPS;
  return template.map((s) => ({
    stepNumber: s.stepNumber,
    key: s.key,
    name: s.name,
    labelThai: s.labelThai,
    status: 'PENDING',
    detail: null,
    startedAt: null,
    completedAt: null,
  }));
}

export function getDeployJobsDir(): string {
  const custom = process.env.SAM_ATT_DEPLOY_JOBS_DIR?.trim();
  const dir = custom
    ? path.resolve(custom)
    : path.resolve(process.cwd(), 'logs', 'deploy_jobs');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function getDeployLockFilePath(): string {
  const custom = process.env.SAM_ATT_DEPLOY_LOCK_FILE?.trim();
  if (custom) {
    const resolved = path.resolve(custom);
    const parent = path.dirname(resolved);
    if (!fs.existsSync(parent)) {
      fs.mkdirSync(parent, { recursive: true });
    }
    return resolved;
  }
  return path.join(getDeployJobsDir(), 'deploy_active.lock');
}

function sanitizeSafeJobId(rawId: string): string {
  const clean = String(rawId || '').trim();
  if (!/^[a-zA-Z0-9_-]{4,80}$/.test(clean)) {
    throw new Error('INVALID_JOB_ID');
  }
  return clean;
}

export function getJobFilePath(jobId: string): string {
  const safeId = sanitizeSafeJobId(jobId);
  const dir = getDeployJobsDir();
  const candidate = path.resolve(dir, `job_${safeId}.json`);
  if (!candidate.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error('PATH_TRAVERSAL_BLOCKED');
  }
  return candidate;
}

export function getLatestJobFilePath(): string {
  return path.join(getDeployJobsDir(), 'latest_job.json');
}

export function generateDeployJobId(prefix = 'appdeploy'): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${filePath}.tmp_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.copyFileSync(tmpPath, filePath);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup error
    }
  }
}

function maskLogTail(lines: string[]): string[] {
  return lines
    .slice(-120)
    .map((line) => sanitizeDeploymentLog(String(line || '')))
    .filter((line) => line.length > 0);
}

export function readSanitizedLogTail(logFilePath: string | null | undefined, maxLines = 120): string[] {
  if (!logFilePath) return [];
  try {
    if (!fs.existsSync(logFilePath)) return [];
    const raw = fs.readFileSync(logFilePath, 'utf8');
    const lines = raw.split(/\r?\n/);
    return maskLogTail(lines.slice(-maxLines));
  } catch {
    return [];
  }
}

export function savePersistentDeployJob(job: PersistentDeployJob): PersistentDeployJob {
  const normalized: PersistentDeployJob = {
    ...job,
    updatedAt: new Date().toISOString(),
    errorMessage: job.errorMessage ? sanitizeDeploymentLog(job.errorMessage) : null,
    logTail: maskLogTail(job.logTail || []),
  };
  const filePath = getJobFilePath(normalized.jobId);
  atomicWriteJson(filePath, normalized);
  atomicWriteJson(getLatestJobFilePath(), normalized);
  return normalized;
}

function normalizeJobFromDisk(raw: Partial<PersistentDeployJob> & Record<string, unknown>): PersistentDeployJob {
  const jobType: PersistentDeployJobType =
    raw.jobType === 'APP_ROLLBACK' ? 'APP_ROLLBACK' : 'APP_UPDATE';
  const defaultSteps = createInitialSteps(jobType);
  const rawSteps = Array.isArray(raw.steps) ? (raw.steps as Array<Partial<PersistentDeployStep>>) : [];
  const mergedSteps: PersistentDeployStep[] = defaultSteps.map((defStep) => {
    const found = rawSteps.find((s) => Number(s?.stepNumber) === defStep.stepNumber);
    if (!found) return defStep;
    const st = String(found.status || 'PENDING').toUpperCase();
    const validStatus: PersistentStepStatus =
      st === 'RUNNING' || st === 'PASS' || st === 'FAIL' || st === 'SKIP' ? st : 'PENDING';
    return {
      stepNumber: defStep.stepNumber,
      key: String(found.key || defStep.key),
      name: String(found.name || defStep.name),
      labelThai: String(found.labelThai || defStep.labelThai),
      status: validStatus,
      detail: found.detail ? sanitizeDeploymentLog(String(found.detail)) : null,
      startedAt: found.startedAt ? String(found.startedAt) : null,
      completedAt: found.completedAt ? String(found.completedAt) : null,
    };
  });

  const rawStatus = String(raw.status || 'PENDING').toUpperCase();
  const validJobStatus: PersistentDeployJobStatus =
    rawStatus === 'RUNNING' ||
    rawStatus === 'SUCCESS' ||
    rawStatus === 'FAILED' ||
    rawStatus === 'ROLLED_BACK' ||
    rawStatus === 'NO_CHANGES'
      ? rawStatus
      : 'PENDING';

  const diskTail = raw.logFilePath ? readSanitizedLogTail(String(raw.logFilePath), 120) : [];
  const embeddedTail = Array.isArray(raw.logTail) ? maskLogTail(raw.logTail.map(String)) : [];

  return {
    jobId: String(raw.jobId || 'unknown'),
    jobType,
    status: validJobStatus,
    actorUsername: String(raw.actorUsername || 'admin'),
    startedAt: String(raw.startedAt || new Date().toISOString()),
    updatedAt: String(raw.updatedAt || new Date().toISOString()),
    completedAt: raw.completedAt ? String(raw.completedAt) : null,
    pid: typeof raw.pid === 'number' && Number.isFinite(raw.pid) ? raw.pid : null,
    currentStepNumber: Number(raw.currentStepNumber || 0),
    currentStepName: String(raw.currentStepName || ''),
    currentStepLabelThai: String(raw.currentStepLabelThai || ''),
    progressPercent: Math.max(0, Math.min(100, Number(raw.progressPercent || 0))),
    commitBefore: raw.commitBefore ? String(raw.commitBefore) : null,
    targetCommit: raw.targetCommit ? String(raw.targetCommit) : null,
    commitAfter: raw.commitAfter ? String(raw.commitAfter) : null,
    snapshotDir: raw.snapshotDir ? String(raw.snapshotDir) : null,
    npmCiExecuted: typeof raw.npmCiExecuted === 'boolean' ? raw.npmCiExecuted : null,
    npmCiReason: raw.npmCiReason ? String(raw.npmCiReason) : null,
    rolledBack: Boolean(raw.rolledBack),
    rollbackSnapshotDir: raw.rollbackSnapshotDir ? String(raw.rollbackSnapshotDir) : null,
    errorCode: raw.errorCode ? String(raw.errorCode) : null,
    errorMessage: raw.errorMessage ? sanitizeDeploymentLog(String(raw.errorMessage)) : null,
    historyRecorded: Boolean(raw.historyRecorded),
    logFilePath: raw.logFilePath ? String(raw.logFilePath) : null,
    logTail: diskTail.length > 0 ? diskTail : embeddedTail,
    steps: mergedSteps,
  };
}

export function readPersistentDeployJob(jobId: string): PersistentDeployJob | null {
  try {
    const filePath = getJobFilePath(jobId);
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return normalizeJobFromDisk(raw);
  } catch {
    return null;
  }
}

export function readLatestPersistentDeployJob(): PersistentDeployJob | null {
  try {
    const latestPath = getLatestJobFilePath();
    if (!fs.existsSync(latestPath)) return null;
    const raw = JSON.parse(fs.readFileSync(latestPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    const normalized = normalizeJobFromDisk(raw);
    if (normalized.jobId && normalized.jobId !== 'unknown') {
      const individual = readPersistentDeployJob(normalized.jobId);
      if (individual) {
        return new Date(individual.updatedAt).getTime() >= new Date(normalized.updatedAt).getTime()
          ? individual
          : normalized;
      }
    }
    return normalized;
  } catch {
    return null;
  }
}

export function createPersistentDeployJob(params: {
  jobId?: string;
  jobType: PersistentDeployJobType;
  actorUsername: string;
  commitBefore?: string | null;
  targetCommit?: string | null;
  logFilePath?: string | null;
  pid?: number | null;
}): PersistentDeployJob {
  const now = new Date().toISOString();
  const jobId = sanitizeSafeJobId(
    params.jobId || generateDeployJobId(params.jobType === 'APP_ROLLBACK' ? 'rollback' : 'appdeploy')
  );
  const steps = createInitialSteps(params.jobType);
  const job: PersistentDeployJob = {
    jobId,
    jobType: params.jobType,
    status: 'PENDING',
    actorUsername: params.actorUsername,
    startedAt: now,
    updatedAt: now,
    completedAt: null,
    pid: params.pid ?? null,
    currentStepNumber: 1,
    currentStepName: steps[0].name,
    currentStepLabelThai: steps[0].labelThai,
    progressPercent: 5,
    commitBefore: params.commitBefore ?? null,
    targetCommit: params.targetCommit ?? null,
    commitAfter: null,
    snapshotDir: null,
    npmCiExecuted: null,
    npmCiReason: null,
    rolledBack: false,
    rollbackSnapshotDir: null,
    errorCode: null,
    errorMessage: null,
    historyRecorded: false,
    logFilePath: params.logFilePath ?? null,
    logTail: [],
    steps,
  };
  return savePersistentDeployJob(job);
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'EPERM') return true;
    return false;
  }
}

export function getDeployLockStatus(): DeployLockInfo {
  const lockFilePath = getDeployLockFilePath();
  if (!fs.existsSync(lockFilePath)) {
    return {
      locked: false,
      staleCleaned: false,
      lockFilePath,
      jobId: null,
      pid: null,
      startedAt: null,
      actorUsername: null,
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(lockFilePath, 'utf8').replace(/^\uFEFF/, '')) as {
      jobId?: string;
      pid?: number;
      startedAt?: string;
      actorUsername?: string;
    };
    const startedMs = raw.startedAt ? new Date(raw.startedAt).getTime() : 0;
    const isExpired = !startedMs || Date.now() - startedMs > DEFAULT_LOCK_STALE_MS;
    const pid = typeof raw.pid === 'number' ? raw.pid : null;
    const pidDead = pid !== null && !isPidAlive(pid);
    const linkedJob = raw.jobId ? readPersistentDeployJob(raw.jobId) : null;
    const jobAlreadyTerminal =
      linkedJob !== null &&
      (linkedJob.status === 'SUCCESS' ||
        linkedJob.status === 'FAILED' ||
        linkedJob.status === 'ROLLED_BACK' ||
        linkedJob.status === 'NO_CHANGES');

    if (isExpired || pidDead || jobAlreadyTerminal) {
      try {
        fs.unlinkSync(lockFilePath);
      } catch {
        // ignore
      }
      return {
        locked: false,
        staleCleaned: true,
        lockFilePath,
        jobId: null,
        pid: null,
        startedAt: null,
        actorUsername: null,
      };
    }

    return {
      locked: true,
      staleCleaned: false,
      lockFilePath,
      jobId: raw.jobId ? String(raw.jobId) : null,
      pid,
      startedAt: raw.startedAt ? String(raw.startedAt) : null,
      actorUsername: raw.actorUsername ? String(raw.actorUsername) : null,
    };
  } catch {
    return {
      locked: true,
      staleCleaned: false,
      lockFilePath,
      jobId: null,
      pid: null,
      startedAt: null,
      actorUsername: null,
    };
  }
}

export function acquireDeployLock(params: {
  jobId: string;
  pid?: number | null;
  actorUsername: string;
  inheritedJobId?: string | null;
}): DeployLockInfo {
  const safeJobId = sanitizeSafeJobId(params.jobId);
  const callerPid = params.pid ?? process.pid;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const status = getDeployLockStatus();
    if (status.locked) {
      // Allow same jobId (e.g., parent handing off PID to spawned child) or explicit inheritedJobId
      if (status.jobId === safeJobId) {
        const updatedPayload = {
          jobId: safeJobId,
          pid: callerPid,
          actorUsername: params.actorUsername,
          startedAt: status.startedAt || new Date().toISOString(),
        };
        atomicWriteJson(status.lockFilePath, updatedPayload);
        return {
          locked: true,
          acquired: true,
          staleCleaned: status.staleCleaned,
          lockFilePath: status.lockFilePath,
          jobId: updatedPayload.jobId,
          pid: updatedPayload.pid,
          startedAt: updatedPayload.startedAt,
          actorUsername: updatedPayload.actorUsername,
        };
      }
      if (params.inheritedJobId && status.jobId === params.inheritedJobId) {
        return {
          ...status,
          locked: true,
          acquired: true,
        };
      }
      return {
        ...status,
        locked: true,
        acquired: false,
      };
    }

    const lockFilePath = status.lockFilePath;
    const dir = path.dirname(lockFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const payload = {
      jobId: safeJobId,
      pid: callerPid,
      actorUsername: params.actorUsername,
      startedAt: new Date().toISOString(),
    };

    try {
      // Atomic exclusive file creation (O_CREAT | O_EXCL via 'wx') -- FIX 02
      const fd = fs.openSync(lockFilePath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return {
        locked: true,
        acquired: true,
        staleCleaned: status.staleCleaned,
        lockFilePath,
        jobId: payload.jobId,
        pid: payload.pid,
        startedAt: payload.startedAt,
        actorUsername: payload.actorUsername,
      };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'EEXIST') {
        const active = getDeployLockStatus();
        if (active.locked) {
          return {
            ...active,
            locked: true,
            acquired: false,
          };
        }
        continue;
      }
      throw err;
    }
  }

  return {
    ...getDeployLockStatus(),
    acquired: false,
  };
}

export function releaseDeployLock(expectedJobId?: string, expectedPid?: number): boolean {
  const lockFilePath = getDeployLockFilePath();
  if (!fs.existsSync(lockFilePath)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(lockFilePath, 'utf8').replace(/^\uFEFF/, '')) as {
      jobId?: string;
      pid?: number;
    };
    if (expectedJobId && raw.jobId && raw.jobId !== expectedJobId) {
      return false;
    }
    if (typeof expectedPid === 'number' && typeof raw.pid === 'number' && raw.pid !== expectedPid) {
      return false;
    }
    fs.unlinkSync(lockFilePath);
    return true;
  } catch {
    return false;
  }
}

export function listAvailableAppSnapshots(snapshotRootDir?: string): AppSnapshotSummary[] {
  const root = path.resolve(
    snapshotRootDir ||
      process.env.SAM_ATT_DEPLOY_SNAPSHOT_DIR ||
      (process.platform === 'win32' ? 'C:\\SamAttDeploySnapshots' : path.join(getDeployJobsDir(), '_snapshots'))
  );
  if (!fs.existsSync(root)) return [];

  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const summaries: AppSnapshotSummary[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !/^app_snapshot_/i.test(ent.name)) continue;
      const fullDir = path.join(root, ent.name);
      const manifestPath = path.join(fullDir, 'snapshot-manifest.json');
      let commitBefore: string | null = null;
      let createdAt: string | null = null;
      let lockfileHash: string | null = null;
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
          commitBefore = m.commitBefore ? String(m.commitBefore) : null;
          createdAt = m.createdAt ? String(m.createdAt) : null;
          lockfileHash = m.lockfileHash ? String(m.lockfileHash) : null;
        } catch {
          // ignore invalid manifest
        }
      }
      if (!createdAt) {
        try {
          createdAt = fs.statSync(fullDir).mtime.toISOString();
        } catch {
          createdAt = null;
        }
      }
      const hasDist = fs.existsSync(path.join(fullDir, 'dist', 'index.html'));
      summaries.push({
        snapshotName: ent.name,
        snapshotDir: fullDir,
        commitBefore,
        createdAt,
        hasDist,
        lockfileHash,
      });
    }
    return summaries.sort((a, b) => (b.snapshotName > a.snapshotName ? 1 : -1)).slice(0, 15);
  } catch {
    return [];
  }
}

export async function syncFinishedDiskJobToHistory(actorFallback = 'admin'): Promise<PersistentDeployJob | null> {
  const latest = readLatestPersistentDeployJob();
  if (!latest) return null;

  const isTerminal =
    latest.status === 'SUCCESS' ||
    latest.status === 'FAILED' ||
    latest.status === 'ROLLED_BACK' ||
    latest.status === 'NO_CHANGES';

  if (!isTerminal || latest.historyRecorded) {
    return latest;
  }

  // ถ้างานจบแล้วและ lock ยังค้างอยู่ (เช่น โปรเซสเดิมถูกหยุดระหว่าง Deploy) ให้ปลด lock อย่างปลอดภัย
  releaseDeployLock(latest.jobId);

  const pkgPath = path.resolve(process.cwd(), 'package.json');
  let releaseVersion = '2.0.0';
  try {
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
      if (parsed.version) releaseVersion = parsed.version;
    }
  } catch {
    // fallback
  }

  const dbStatus = latest.status === 'SUCCESS' || latest.status === 'NO_CHANGES' ? 'SUCCESS' : 'FAILED';
  const recordedCommit = latest.commitAfter || latest.targetCommit || latest.commitBefore || 'unknown';
  const actionType = latest.jobType === 'APP_ROLLBACK' ? 'APP_ROLLBACK' : 'DEPLOY_APP_ONLY';
  const notes = sanitizeDeploymentLog(
    [
      `[JOB ${latest.jobId}] status=${latest.status} (${latest.commitBefore?.slice(0, 8) || '?'} -> ${recordedCommit.slice(0, 8)})`,
      latest.errorCode ? `error=${latest.errorCode}: ${latest.errorMessage || ''}` : '',
      latest.logTail.length > 0 ? latest.logTail.slice(-15).join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 1800)
  );

  try {
    const insertRes = await dbExecute(
      `INSERT INTO deployment_history
         (release_version, commit_sha, artifact_sha256, action_type, status, backup_archive_path, preflight_passed, notes, executed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        releaseVersion,
        recordedCommit.slice(0, 64),
        'app-only-detached-verified',
        actionType,
        dbStatus,
        (latest.rollbackSnapshotDir || latest.snapshotDir || null)?.slice(0, 255) || null,
        latest.status === 'SUCCESS' || latest.status === 'NO_CHANGES' ? 1 : 0,
        notes,
        latest.actorUsername || actorFallback,
      ]
    );

    await writeAuditLog({
      requestId: `deploy-job-${latest.jobId}`,
      actorUsername: latest.actorUsername || actorFallback,
      actorRole: 'ADMIN',
      ipAddress: '127.0.0.1',
      action:
        latest.jobType === 'APP_ROLLBACK'
          ? 'DEPLOYMENT_APP_ROLLBACK_COMPLETED'
          : 'DEPLOYMENT_APP_UPDATE_COMPLETED',
      targetType: 'DEPLOYMENT',
      targetId: String(insertRes.insertId),
      result: dbStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILURE',
      errorCode: latest.errorCode,
      detail: {
        jobId: latest.jobId,
        jobType: latest.jobType,
        status: latest.status,
        commitBefore: latest.commitBefore,
        commitAfter: latest.commitAfter,
        targetCommit: latest.targetCommit,
        snapshotDir: latest.snapshotDir,
        rollbackSnapshotDir: latest.rollbackSnapshotDir,
        npmCiExecuted: latest.npmCiExecuted,
        npmCiReason: latest.npmCiReason,
        rolledBack: latest.rolledBack,
      },
    });
  } catch {
    // อย่าทำให้การอ่าน progress ล้มเหลวถ้าเขียน DB ไม่สำเร็จ
  }

  return savePersistentDeployJob({
    ...latest,
    historyRecorded: true,
  });
}
