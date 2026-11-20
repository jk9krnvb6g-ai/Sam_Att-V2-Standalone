import crypto from 'crypto';
import { nowBkkString } from '../../utils/crypto.ts';

export type CentralJobType =
  | 'HOSOFFICE_PERSONNEL_SYNC'
  | 'HOSOFFICE_LIVE_PUSH'
  | 'SCANNER_MANUAL_SYNC';

export type CentralJobStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN';

export interface CentralJobState {
  jobId: string;
  jobType: CentralJobType;
  status: CentralJobStatus;
  currentStep: string;
  processedCount: number | null;
  totalCount: number | null;
  progressPercent: number | null;
  startedAt: string;
  finishedAt: string | null;
  actorUsername: string;
  errorCode: string | null;
  errorMessage: string | null;
  resultSummary: Record<string, unknown> | null;
}

const jobsById = new Map<string, CentralJobState>();
const latestJobByType = new Map<CentralJobType, string>();

const MAX_RETAINED_JOBS = 100;

function pruneOldJobs(): void {
  if (jobsById.size <= MAX_RETAINED_JOBS) return;
  const entries = Array.from(jobsById.entries());
  for (const [id, job] of entries) {
    if (job.status !== 'RUNNING' && job.status !== 'PENDING') {
      jobsById.delete(id);
      if (jobsById.size <= MAX_RETAINED_JOBS) break;
    }
  }
}

export function getActiveJobByType(jobType: CentralJobType): CentralJobState | null {
  const latestId = latestJobByType.get(jobType);
  if (!latestId) return null;
  const job = jobsById.get(latestId);
  if (!job) return null;
  if (job.status === 'RUNNING' || job.status === 'PENDING') {
    return { ...job };
  }
  return null;
}

export function getLatestJobByType(jobType: CentralJobType): CentralJobState | null {
  const latestId = latestJobByType.get(jobType);
  if (!latestId) return null;
  const job = jobsById.get(latestId);
  return job ? { ...job } : null;
}

export function getJobById(jobId: string): CentralJobState | null {
  const job = jobsById.get(String(jobId || '').trim());
  return job ? { ...job } : null;
}

export function listRecentJobs(limit = 20): CentralJobState[] {
  const all = Array.from(jobsById.values());
  return all
    .slice(Math.max(0, all.length - limit))
    .reverse()
    .map((j) => ({ ...j }));
}

export function startCentralJob(params: {
  jobType: CentralJobType;
  actorUsername: string;
  initialStep: string;
  totalCount?: number | null;
}): CentralJobState {
  const active = getActiveJobByType(params.jobType);
  if (active) {
    const err = new Error(
      `JOB_ALREADY_RUNNING: งานประเภท ${params.jobType} กำลังทำงานอยู่แล้ว (${active.jobId})`
    ) as Error & { code?: string; activeJob?: CentralJobState };
    err.code = 'JOB_ALREADY_RUNNING';
    err.activeJob = active;
    throw err;
  }

  pruneOldJobs();
  const jobId = `JOB-${params.jobType.slice(0, 6)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const totalCount =
    typeof params.totalCount === 'number' && params.totalCount > 0 ? params.totalCount : null;

  const state: CentralJobState = {
    jobId,
    jobType: params.jobType,
    status: 'RUNNING',
    currentStep: params.initialStep,
    processedCount: totalCount !== null ? 0 : null,
    totalCount,
    progressPercent: totalCount !== null ? 0 : null,
    startedAt: nowBkkString(),
    finishedAt: null,
    actorUsername: params.actorUsername || 'system',
    errorCode: null,
    errorMessage: null,
    resultSummary: null,
  };

  jobsById.set(jobId, state);
  latestJobByType.set(params.jobType, jobId);
  return { ...state };
}

export function updateCentralJobStep(
  jobId: string,
  update: {
    currentStep?: string;
    processedCount?: number | null;
    totalCount?: number | null;
  }
): CentralJobState | null {
  const job = jobsById.get(jobId);
  if (!job) return null;

  if (typeof update.currentStep === 'string' && update.currentStep.trim()) {
    job.currentStep = update.currentStep.trim();
  }
  if (update.totalCount !== undefined) {
    job.totalCount =
      typeof update.totalCount === 'number' && update.totalCount >= 0 ? update.totalCount : null;
  }
  if (update.processedCount !== undefined) {
    job.processedCount =
      typeof update.processedCount === 'number' && update.processedCount >= 0
        ? update.processedCount
        : null;
  }

  if (
    typeof job.processedCount === 'number' &&
    typeof job.totalCount === 'number' &&
    job.totalCount > 0
  ) {
    job.progressPercent = Math.min(
      100,
      Math.max(0, Math.round((job.processedCount / job.totalCount) * 100))
    );
  } else {
    job.progressPercent = null;
  }

  return { ...job };
}

export function completeCentralJob(
  jobId: string,
  params: {
    currentStep?: string;
    processedCount?: number | null;
    totalCount?: number | null;
    resultSummary?: Record<string, unknown> | null;
  } = {}
): CentralJobState | null {
  const job = jobsById.get(jobId);
  if (!job) return null;

  job.status = 'SUCCESS';
  job.currentStep = params.currentStep || 'ดำเนินการเสร็จสมบูรณ์';
  if (params.totalCount !== undefined) {
    job.totalCount = params.totalCount;
  }
  if (params.processedCount !== undefined) {
    job.processedCount = params.processedCount;
  } else if (typeof job.totalCount === 'number') {
    job.processedCount = job.totalCount;
  }

  if (
    typeof job.processedCount === 'number' &&
    typeof job.totalCount === 'number' &&
    job.totalCount > 0
  ) {
    job.progressPercent = 100;
  }
  job.finishedAt = nowBkkString();
  job.resultSummary = params.resultSummary || null;
  return { ...job };
}

export function failCentralJob(
  jobId: string,
  params: {
    status?: 'FAILED' | 'UNKNOWN';
    currentStep?: string;
    errorCode: string;
    errorMessage: string;
    resultSummary?: Record<string, unknown> | null;
  }
): CentralJobState | null {
  const job = jobsById.get(jobId);
  if (!job) return null;

  job.status = params.status || 'FAILED';
  job.currentStep = params.currentStep || 'พบข้อผิดพลาดในการดำเนินการ';
  job.errorCode = params.errorCode;
  job.errorMessage = params.errorMessage;
  job.finishedAt = nowBkkString();
  if (params.resultSummary !== undefined) {
    job.resultSummary = params.resultSummary;
  }
  return { ...job };
}

export function resetCentralJobsForTests(): void {
  jobsById.clear();
  latestJobByType.clear();
}
