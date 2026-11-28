/**
 * ============================================================================
 * ไฟล์: backend/src/modules/attendance/lifecycle.ts
 * หน้าที่: Attendance Lifecycle & Window Evaluator (Asia/Bangkok Single Source of Truth)
 * ============================================================================
 */
import { getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { addDaysYmd, toEpochMinutes } from './matchingEngine.ts';

export type AttendanceLifecycleState =
  | 'NOT_STARTED'
  | 'AWAITING_CHECKIN'
  | 'IN_PROGRESS'
  | 'LATE_IN_PROGRESS'
  | 'COMPLETE'
  | 'MISSING_CHECKOUT'
  | 'MISSING_CHECKIN'
  | 'NO_SCAN'
  | 'PENDING_MAPPING'
  | 'OFF_DAY'
  | 'APPROVED_LEAVE'
  | 'OFFICIAL_DUTY'
  | 'NO_SHIFT';

export const NON_FINAL_LIFECYCLE_STATES = new Set<AttendanceLifecycleState>([
  'NOT_STARTED',
  'AWAITING_CHECKIN',
  'IN_PROGRESS',
  'LATE_IN_PROGRESS',
]);

export interface LifecycleEvaluationInput {
  workDate: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  evaluatedStart?: string | null;
  evaluatedEnd?: string | null;
  cutoffTimestamp?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  cutoffTime?: string | null;
  isCrossMidnight?: number | boolean | null;
  checkinWindowBeforeMin?: number | null;
  checkInTime?: string | null;
  checkOutTime?: string | null;
  status?: string | null;
  attendanceStatus?: string | null;
  isLate?: number | boolean | null;
  lateMinutes?: number | null;
  earlyCheckoutIndicator?: number | boolean | null;
  earlyCheckoutMinutes?: number | null;
  mappingStatus?: string | null;
  reviewReason?: string | null;
  holidayName?: string | null;
  holidayPolicy?: string | null;
  leaveType?: string | null;
  referenceNowBkk?: string;
}

export interface LifecycleTimelinePhase {
  key: 'PRE_WINDOW' | 'CHECKIN' | 'IN_SHIFT' | 'CHECKOUT' | 'CUTOFF_CLOSED';
  labelThai: string;
  at: string | null;
  completed: boolean;
  active: boolean;
}

export interface LifecycleEvaluationResult {
  lifecycleState: AttendanceLifecycleState;
  thaiLabel: string;
  isFinalized: boolean;
  isPushEligibleLifecycle: boolean;
  remainingCheckinWindowMinutes: number | null;
  remainingShiftMinutes: number | null;
  checkinWindowOpensAt: string | null;
  evaluatedStart: string | null;
  evaluatedEnd: string | null;
  cutoffTimestamp: string | null;
  phases: LifecycleTimelinePhase[];
}

export const LIFECYCLE_LABELS_THAI: Record<AttendanceLifecycleState, string> = {
  NOT_STARTED: 'ยังไม่ถึงเวลาเข้างาน',
  AWAITING_CHECKIN: 'รอสแกนเข้างาน',
  IN_PROGRESS: 'กำลังปฏิบัติงาน',
  LATE_IN_PROGRESS: 'เข้างานสาย (กำลังปฏิบัติงาน)',
  COMPLETE: 'ลงเวลาครบเข้า–ออก',
  MISSING_CHECKOUT: 'ไม่สแกนออกงาน',
  MISSING_CHECKIN: 'ไม่สแกนเข้างาน',
  NO_SCAN: 'ไม่พบข้อมูลสแกน',
  PENDING_MAPPING: 'รอเชื่อมโยงรหัสสแกน',
  OFF_DAY: 'วันหยุด / นอกวันทำการ',
  APPROVED_LEAVE: 'ลางานที่ได้รับอนุมัติ',
  OFFICIAL_DUTY: 'ไปราชการ',
  NO_SHIFT: 'ไม่มีตารางเวร',
};

function resolveTs(
  workDate: string,
  explicitTs: string | null | undefined,
  hmFallback: string | null | undefined,
  isNextDay = false
): string | null {
  if (explicitTs && explicitTs.trim()) return explicitTs.trim().slice(0, 19);
  if (!hmFallback || !hmFallback.trim()) return null;
  const parts = hmFallback.trim().split(':');
  const hh = String(Number(parts[0] || 0)).padStart(2, '0');
  const mm = String(Number(parts[1] || 0)).padStart(2, '0');
  const day = isNextDay ? addDaysYmd(workDate, 1) : workDate;
  return `${day} ${hh}:${mm}:00`;
}

export function evaluateAttendanceLifecycle(
  input: LifecycleEvaluationInput
): LifecycleEvaluationResult {
  const bkkNow = input.referenceNowBkk || getCurrentBangkokDateParts().nowDateTimeBkk;
  const nowMin = toEpochMinutes(bkkNow);
  const workDate = String(input.workDate).slice(0, 10);

  const startHm = (input.startTime || (input.scheduledStart ? input.scheduledStart.slice(11, 16) : '') || '08:00').trim();
  const endHm = (input.endTime || (input.scheduledEnd ? input.scheduledEnd.slice(11, 16) : '') || '16:00').trim();
  const isCross =
    Number(input.isCrossMidnight || 0) === 1 || (Boolean(startHm && endHm) && endHm <= startHm);

  const evalStart = resolveTs(
    workDate,
    input.evaluatedStart || input.scheduledStart,
    startHm,
    false
  );
  const evalEnd = resolveTs(
    workDate,
    input.evaluatedEnd || input.scheduledEnd,
    endHm,
    isCross
  );
  const cutoffHm = (input.cutoffTime || (input.cutoffTimestamp ? input.cutoffTimestamp.slice(11, 16) : '') || endHm).trim();
  const cutoffNextDay = isCross && cutoffHm < startHm;
  const cutoffTs = resolveTs(workDate, input.cutoffTimestamp, cutoffHm, cutoffNextDay);

  const startMin = evalStart ? toEpochMinutes(evalStart) : null;
  const endMin = evalEnd ? toEpochMinutes(evalEnd) : null;
  const cutoffMin = cutoffTs ? toEpochMinutes(cutoffTs) : endMin;
  const windowBeforeMin = Math.max(0, Number(input.checkinWindowBeforeMin ?? 120));
  const checkinWindowOpensMin = startMin !== null ? startMin - windowBeforeMin : null;
  const checkinWindowOpensAt =
    checkinWindowOpensMin !== null
      ? (() => {
          const dt = new Date(checkinWindowOpensMin * 60000);
          return `${dt.toISOString().slice(0, 10)} ${String(dt.getUTCHours()).padStart(2, '0')}:${String(dt.getUTCMinutes()).padStart(2, '0')}:00`;
        })()
      : null;

  const hasIn = Boolean(input.checkInTime);
  const hasOut = Boolean(input.checkOutTime);
  const isLate = Number(input.isLate || 0) === 1 || input.status === 'LATE' || input.status === 'LATE_IN_PROGRESS';
  const rawStatus = String(input.status || '').toUpperCase();
  const rawAttStatus = String(input.attendanceStatus || '').toUpperCase();

  let lifecycleState: AttendanceLifecycleState;

  const normHolidayPolicy = String(input.holidayPolicy || '').toUpperCase();
  const normLeaveType = String(input.leaveType || '').toUpperCase();
  const isFullLeave = ['FULL_DAY', 'PERSONAL_HOLIDAY', 'DAY_OFF'].includes(normLeaveType);

  if ((normHolidayPolicy === 'EXEMPT' || normHolidayPolicy === 'EXEMPT_ALL') && !hasIn && !hasOut) {
    lifecycleState = 'OFF_DAY';
  } else if (isFullLeave && !hasIn && !hasOut) {
    lifecycleState = 'APPROVED_LEAVE';
  } else if (rawStatus === 'PENDING_MAPPING' || rawAttStatus === 'PENDING_MAPPING' || (input.mappingStatus && input.mappingStatus !== 'VALID')) {
    lifecycleState = 'PENDING_MAPPING';
  } else if (rawStatus === 'OFFICIAL_DUTY') {
    lifecycleState = 'OFFICIAL_DUTY';
  } else if (rawStatus === 'APPROVED_LEAVE') {
    lifecycleState = 'APPROVED_LEAVE';
  } else if (rawStatus === 'OFF_DAY') {
    lifecycleState = 'OFF_DAY';
  } else if (rawStatus === 'NO_SHIFT' || rawStatus === 'NO_SCHEDULE') {
    lifecycleState = 'NO_SHIFT';
  } else if (hasIn && hasOut) {
    lifecycleState = 'COMPLETE';
  } else if (!hasIn && hasOut) {
    lifecycleState = 'MISSING_CHECKIN';
  } else if (hasIn && !hasOut) {
    if (endMin !== null && nowMin < endMin) {
      lifecycleState = isLate ? 'LATE_IN_PROGRESS' : 'IN_PROGRESS';
    } else {
      lifecycleState = 'MISSING_CHECKOUT';
    }
  } else {
    // Neither IN nor OUT
    if (rawStatus === 'NO_SCAN' || rawAttStatus === 'NO_SCAN') {
      if (cutoffMin !== null && nowMin < cutoffMin) {
        lifecycleState =
          checkinWindowOpensMin !== null && nowMin >= checkinWindowOpensMin
            ? 'AWAITING_CHECKIN'
            : 'NOT_STARTED';
      } else {
        lifecycleState = 'NO_SCAN';
      }
    } else if (cutoffMin !== null && nowMin >= cutoffMin) {
      lifecycleState = 'NO_SCAN';
    } else if (checkinWindowOpensMin !== null && nowMin >= checkinWindowOpensMin) {
      lifecycleState = 'AWAITING_CHECKIN';
    } else {
      lifecycleState = 'NOT_STARTED';
    }
  }

  const remainingCheckinWindowMinutes =
    !hasIn && cutoffMin !== null && nowMin < cutoffMin ? Math.max(0, cutoffMin - nowMin) : 0;
  const remainingShiftMinutes =
    endMin !== null && nowMin < endMin ? Math.max(0, endMin - nowMin) : 0;

  const isFinalized = !NON_FINAL_LIFECYCLE_STATES.has(lifecycleState);

  const phases: LifecycleTimelinePhase[] = [
    {
      key: 'PRE_WINDOW',
      labelThai: 'เปิดรับสแกนเข้างาน',
      at: checkinWindowOpensAt,
      completed: checkinWindowOpensMin !== null && nowMin >= checkinWindowOpensMin,
      active: lifecycleState === 'NOT_STARTED',
    },
    {
      key: 'CHECKIN',
      labelThai: hasIn ? 'สแกนเข้างานแล้ว' : 'กำหนดเข้างาน / ปิดรับเข้างาน',
      at: hasIn ? String(input.checkInTime) : cutoffTs,
      completed: hasIn,
      active: lifecycleState === 'AWAITING_CHECKIN',
    },
    {
      key: 'IN_SHIFT',
      labelThai: isLate ? `ระหว่างปฏิบัติงาน (สาย ${Number(input.lateMinutes || 0)} นาที)` : 'ระหว่างปฏิบัติงาน',
      at: evalStart,
      completed: hasOut || (endMin !== null && nowMin >= endMin && hasIn),
      active: lifecycleState === 'IN_PROGRESS' || lifecycleState === 'LATE_IN_PROGRESS',
    },
    {
      key: 'CHECKOUT',
      labelThai: hasOut ? 'สแกนออกงานแล้ว' : 'กำหนดออกงาน',
      at: hasOut ? String(input.checkOutTime) : evalEnd,
      completed: hasOut,
      active: lifecycleState === 'MISSING_CHECKOUT',
    },
    {
      key: 'CUTOFF_CLOSED',
      labelThai: LIFECYCLE_LABELS_THAI[lifecycleState],
      at: evalEnd,
      completed: isFinalized,
      active: isFinalized,
    },
  ];

  return {
    lifecycleState,
    thaiLabel: LIFECYCLE_LABELS_THAI[lifecycleState],
    isFinalized,
    isPushEligibleLifecycle: isFinalized && lifecycleState !== 'PENDING_MAPPING',
    remainingCheckinWindowMinutes:
      lifecycleState === 'NOT_STARTED' || lifecycleState === 'AWAITING_CHECKIN'
        ? remainingCheckinWindowMinutes
        : null,
    remainingShiftMinutes:
      lifecycleState === 'IN_PROGRESS' || lifecycleState === 'LATE_IN_PROGRESS' || lifecycleState === 'AWAITING_CHECKIN'
        ? remainingShiftMinutes
        : null,
    checkinWindowOpensAt,
    evaluatedStart: evalStart,
    evaluatedEnd: evalEnd,
    cutoffTimestamp: cutoffTs,
    phases,
  };
}
