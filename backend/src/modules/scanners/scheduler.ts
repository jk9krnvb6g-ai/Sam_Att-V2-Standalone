/**
 * ============================================================================
 * โมดูลตั้งเวลาดึงข้อมูลสแกนนิ้วอัตโนมัติ (Automatic Scanner Sync Scheduler)
 * ไฟล์: backend/src/modules/scanners/scheduler.ts
 * ============================================================================
 * หน้าที่หลัก (แก้ไขปัญหา P1 ข้อ 09):
 * 1. อ่านตาราง `sync_schedules` ที่เปิดใช้งาน (`is_enabled = 1`) เช่น รอบเวลา 00:00 น. และ 08:00 น. (Asia/Bangkok)
 * 2. ป้องกันการทำงานซ้อนกัน (Concurrency Mutex Lock) หากมีการซิงก์กำลังทำงานอยู่จะข้ามรอบซ้อนทันที
 * 3. เรียกใช้งาน `ScannerReader.exe` เดิมโดยไม่แก้ไขตัวไฟล์ EXE บันทึกประวัติลง `sync_runs`
 *    และเมื่อซิงก์สำเร็จจะสั่งคำนวณเวลาปฏิบัติงานใหม่ (`reprocessAttendanceRange`) โดยอัตโนมัติ
 */
import { dbQuery } from '../../database/adapter.ts';
import { loadConfig } from '../../config/env.ts';
import { getBangkokNowString } from '../attendance/processor.ts';
import { executeScannerReaderSync, isScannerSyncLocked } from './routes.ts';

let schedulerTimer: NodeJS.Timeout | null = null;
const executedScheduleKeys = new Set<string>(); // รูปแบบ: YYYY-MM-DD|HH:mm|scheduleId

export interface SchedulerStatus {
  enabled: boolean;
  timerActive: boolean;
  syncCurrentlyRunning: boolean;
  lastCheckedBkkTime: string | null;
  lastTriggeredKey: string | null;
  executedCount: number;
}

let lastCheckedBkkTime: string | null = null;
let lastTriggeredKey: string | null = null;
let executedCount = 0;

/**
 * ตรวจสอบว่าถึงเวลาซิงก์ตามตาราง `sync_schedules` หรือไม่
 * @param customBkkNow เวลาอ้างอิงในรูปแบบ 'YYYY-MM-DD HH:mm:ss' (ใช้สำหรับการทดสอบอัตโนมัติ หรือปล่อยว่างเพื่อใช้เวลาจริง Asia/Bangkok)
 */
export async function evaluateDueSyncSchedules(customBkkNow?: string): Promise<{
  checkedAtBkk: string;
  triggeredSchedules: Array<{
    scheduleId: number;
    scheduleLabel: string;
    cronTime: string;
    status: string;
    syncRunId?: number;
    error?: string;
  }>;
  skippedReason?: string;
}> {
  const bkkNow = customBkkNow || getBangkokNowString();
  lastCheckedBkkTime = bkkNow;
  const currentDate = bkkNow.slice(0, 10); // YYYY-MM-DD
  const currentHm = bkkNow.slice(11, 16);  // HH:mm

  if (isScannerSyncLocked()) {
    return {
      checkedAtBkk: bkkNow,
      triggeredSchedules: [],
      skippedReason: 'CONCURRENT_SYNC_IN_PROGRESS',
    };
  }

  const activeSchedules = await dbQuery<{
    id: number;
    schedule_label: string;
    cron_time: string;
    is_enabled: number;
  }>('SELECT id, schedule_label, cron_time, is_enabled FROM sync_schedules WHERE is_enabled = 1 ORDER BY cron_time ASC');

  const dueSchedules = activeSchedules.filter((s) => s.cron_time.trim() === currentHm);
  const triggeredSchedules: Array<{
    scheduleId: number;
    scheduleLabel: string;
    cronTime: string;
    status: string;
    syncRunId?: number;
    error?: string;
  }> = [];

  for (const sched of dueSchedules) {
    const dedupKey = `${currentDate}|${sched.cron_time}|${sched.id}`;
    if (executedScheduleKeys.has(dedupKey)) {
      continue;
    }

    executedScheduleKeys.add(dedupKey);
    lastTriggeredKey = dedupKey;
    executedCount++;

    try {
      const outcome = await executeScannerReaderSync({
        triggerMode: `SCHEDULED_AUTO_SYNC (${sched.cron_time})`,
        actorUsername: 'system_scheduler',
        actorRole: 'SYSTEM',
        machineNo: null,
      });
      triggeredSchedules.push({
        scheduleId: sched.id,
        scheduleLabel: sched.schedule_label,
        cronTime: sched.cron_time,
        status: 'SUCCESS',
        syncRunId: outcome.syncRunId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      triggeredSchedules.push({
        scheduleId: sched.id,
        scheduleLabel: sched.schedule_label,
        cronTime: sched.cron_time,
        status: 'FAILED',
        error: msg,
      });
    }
  }

  return {
    checkedAtBkk: bkkNow,
    triggeredSchedules,
  };
}

/**
 * เริ่มต้น Background Scheduler ภายในโปรเซสของ Backend
 */
export function startAutomaticScannerScheduler(intervalMs = 30000): void {
  const cfg = loadConfig();
  if (!cfg.scanner.autoSchedulerEnabled) {
    return;
  }
  if (schedulerTimer) {
    return;
  }
  schedulerTimer = setInterval(() => {
    evaluateDueSyncSchedules().catch((err) => {
      console.error('[Scanner Scheduler] Background check error:', err instanceof Error ? err.message : String(err));
    });
  }, intervalMs);
  if (typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}

export function stopAutomaticScannerScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

export function resetSchedulerHistoryForTests(): void {
  executedScheduleKeys.clear();
  lastCheckedBkkTime = null;
  lastTriggeredKey = null;
  executedCount = 0;
}

export function getScannerSchedulerStatus(): SchedulerStatus {
  const cfg = loadConfig();
  return {
    enabled: cfg.scanner.autoSchedulerEnabled,
    timerActive: schedulerTimer !== null,
    syncCurrentlyRunning: isScannerSyncLocked(),
    lastCheckedBkkTime,
    lastTriggeredKey,
    executedCount,
  };
}
