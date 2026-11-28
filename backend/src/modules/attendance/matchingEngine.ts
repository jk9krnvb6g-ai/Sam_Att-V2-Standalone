/**
 * ============================================================================
 * ไฟล์: backend/src/modules/attendance/matchingEngine.ts
 * หน้าที่: Global Multi-Shift Attendance Matching Engine (Pure Deterministic Solver)
 * ============================================================================
 * รองรับข้อกำหนด ATT-01 ถึง ATT-16 ครบถ้วน:
 * - ATT-01: ประเมินตารางเวรทุกกะของบุคลากรร่วมกัน (กะเดียว, หลายกะ, กะต่อเนื่อง, กะข้ามวัน)
 * - ATT-02: อ่าน Raw Scan ทั้งชุดก่อนจับคู่ เรียงตาม (canonicalBkkTime ASC, id ASC)
 * - ATT-03: ห้ามใช้ Raw Scan ID ซ้ำ (เป็นได้แค่ IN 1 กะ หรือ OUT 1 กะ หรือสแกนเพิ่มเติม)
 * - ATT-04 / ATT-05: จับคู่ OUT กะแรก และ IN กะถัดไปจากสแกนคนละรายการโดยไม่บังคับระยะห่างขั้นต่ำ
 * - ATT-06 / ATT-07: ใช้สแกนแรกที่เหมาะสมเป็น IN และสแกนแรกที่เหมาะสมเป็น OUT หลังจัดสรรทุกกะแล้ว
 * - ATT-08 / ATT-09: ตรวจกะถัดไปก่อนจัดเป็นสแกนเพิ่มเติม และคืนรายการสแกนที่ใช้/ไม่ได้ใช้ทั้งหมด
 * - ATT-10 / ATT-12: คำนวณ EARLY_CHECKOUT + earlyCheckoutMinutes แยกจาก completeness status (รองรับทั้ง LATE + EARLY_CHECKOUT พร้อมกัน)
 * - ATT-14: รองรับ COMPLETE, NO_SCAN, MISSING_CHECKIN, MISSING_CHECKOUT
 * - ATT-15: รองรับการลาครึ่งวัน (เช้า/บ่าย/กำหนดช่วง) โดยไม่แก้ไขแม่แบบกะ พร้อมตั้งค่าช่วงรับสแกนก่อนเริ่มงานหลังลา
 * - ATT-16: หากมีสแกนเดียวในช่วงทับซ้อน OUT กะแรก / IN กะถัดไป และไม่มีชุดอื่นที่รองรับทั้งคู่ ให้เลือก IN กะถัดไปก่อนโดยไม่ใช้ซ้ำ
 * ============================================================================
 */

export type AttendanceCompletenessStatus =
  | 'COMPLETE'
  | 'IN_PROGRESS'
  | 'LATE_IN_PROGRESS'
  | 'NO_SCAN'
  | 'MISSING_CHECKIN'
  | 'MISSING_CHECKOUT'
  | 'PENDING_MAPPING';

export type LegacyAttendanceStatus =
  | 'NORMAL'
  | 'LATE'
  | 'IN_PROGRESS'
  | 'LATE_IN_PROGRESS'
  | 'NO_SCAN'
  | 'MISSING_CHECKIN'
  | 'MISSING_CHECKOUT'
  | 'NO_SCHEDULE'
  | 'PENDING_MAPPING';

export interface MatchingShiftInput {
  personId: string;
  workDate: string; // YYYY-MM-DD (Bangkok local date)
  shiftAssignmentId: number | null;
  shiftCode: string;
  shiftName: string;
  startTime: string; // HH:mm
  endTime: string;   // HH:mm
  graceMinutes: number;
  cutoffTime: string; // HH:mm
  isCrossMidnight: number;
  mappingStatus: string;
  checkinWindowBeforeMin: number;
  checkinWindowAfterMin: number;
  checkoutWindowBeforeMin: number;
  checkoutWindowAfterMin: number;
}

export interface MatchingRawScanInput {
  id: number;
  personId: string;
  canonicalBkkTime: string; // YYYY-MM-DD HH:mm:ss
  inOutMode?: number;
}

export interface MatchingLeaveInput {
  id: number;
  personId: string;
  workDate: string; // YYYY-MM-DD
  shiftAssignmentId: number | null;
  leaveType: 'HALF_DAY_MORNING' | 'HALF_DAY_AFTERNOON' | 'CUSTOM_PARTIAL' | string;
  leaveStartTime: string; // HH:mm
  leaveEndTime: string;   // HH:mm
  reason?: string | null;
}

export interface MatchingConfig {
  referenceNowBkk: string; // YYYY-MM-DD HH:mm:ss
  halfDayPreCheckinWindowMinutes: number; // e.g., 30, 60, 120
}

export interface MatchedShiftOutcome {
  personId: string;
  workDate: string;
  shiftAssignmentId: number | null;
  shiftCode: string | null;
  shiftName: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  evaluatedStartTime: string | null;
  evaluatedEndTime: string | null;
  cutoffTimestamp: string | null;
  checkInTime: string | null;
  checkOutTime: string | null;
  checkInRawScanId: number | null;
  checkOutRawScanId: number | null;
  /** Legacy-compatible status column (NORMAL | LATE | NO_SCAN | MISSING_CHECKIN | MISSING_CHECKOUT | PENDING_MAPPING) */
  status: LegacyAttendanceStatus;
  /** Separated completeness status per ATT-12 / ATT-14 (COMPLETE | NO_SCAN | MISSING_CHECKIN | MISSING_CHECKOUT | PENDING_MAPPING) */
  attendanceStatus: AttendanceCompletenessStatus;
  secondaryFlags: string | null;
  isLate: number;
  lateMinutes: number;
  earlyCheckoutIndicator: number;
  earlyCheckoutMinutes: number;
  matchingRule: string;
  leaveId: number | null;
  leaveType: string | null;
  leaveStartTime: string | null;
  leaveEndTime: string | null;
}

export interface MatchingScanAllocation {
  rawScanId: number;
  canonicalBkkTime: string;
  usageRole: 'CHECK_IN' | 'CHECK_OUT' | 'EXTRA_UNUSED';
  workDate: string | null;
  shiftAssignmentId: number | null;
  shiftCode: string | null;
}

export interface GlobalMatchResult {
  outcomes: MatchedShiftOutcome[];
  scanAllocations: MatchingScanAllocation[];
  usedScanIds: Set<number>;
  extraScanIds: number[];
}

export function addDaysYmd(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function toEpochSeconds(bkkTimestamp: string): number {
  const trimmed = String(bkkTimestamp || '').trim();
  const [datePart, rawTimePart = '00:00:00'] = trimmed.split(/[T\s]+/);
  const cleanTime = rawTimePart.replace(/([.,]\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, '');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh = 0, mm = 0, ss = 0] = cleanTime.split(':').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
}

export function toEpochMinutes(bkkTimestamp: string): number {
  const trimmed = String(bkkTimestamp || '').trim();
  const [datePart, rawTimePart = '00:00:00'] = trimmed.split(/[T\s]+/);
  const cleanTime = rawTimePart.replace(/([.,]\d+)?(Z|[+-]\d{2}:?\d{2})?$/i, '');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh = 0, mm = 0] = cleanTime.split(':').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh, mm, 0) / 60000);
}

export function fromEpochMinutes(epochMinutes: number): string {
  const dt = new Date(epochMinutes * 60000);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  const hh = String(dt.getUTCHours()).padStart(2, '0');
  const min = String(dt.getUTCMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:00`;
}

function normalizeHm(timeStr: string): string {
  const parts = String(timeStr || '00:00').trim().split(':');
  const hh = String(Number(parts[0] || 0)).padStart(2, '0');
  const mm = String(Number(parts[1] || 0)).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface PreparedShift {
  input: MatchingShiftInput;
  scheduledStartTs: string;
  scheduledEndTs: string;
  scheduledStartMin: number;
  scheduledEndMin: number;
  evaluatedStartTs: string;
  evaluatedEndTs: string;
  evaluatedStartMin: number;
  evaluatedEndMin: number;
  cutoffTs: string;
  cutoffMin: number;
  inWindowStartSec: number;
  inWindowEndSec: number;
  outWindowStartSec: number;
  outWindowEndSec: number;
  appliedLeave: MatchingLeaveInput | null;
}

interface PreparedScan {
  id: number;
  personId: string;
  canonicalBkkTime: string;
  epochSec: number;
  epochMin: number;
  inOutMode?: number;
}

/**
 * Resolves the effective evaluation interval and acceptance windows for a shift,
 * applying any matching half-day / partial leave WITHOUT altering the shift template.
 */
function prepareShiftWindow(
  shift: MatchingShiftInput,
  leaves: MatchingLeaveInput[],
  halfDayPreCheckinWindowMinutes: number
): PreparedShift {
  const startHm = normalizeHm(shift.startTime);
  const endHm = normalizeHm(shift.endTime);
  const cutoffHm = normalizeHm(shift.cutoffTime);

  const scheduledStartTs = `${shift.workDate} ${startHm}:00`;
  const isCross = Number(shift.isCrossMidnight) === 1 || endHm <= startHm;
  const endDay = isCross ? addDaysYmd(shift.workDate, 1) : shift.workDate;
  const scheduledEndTs = `${endDay} ${endHm}:00`;

  const scheduledStartMin = toEpochMinutes(scheduledStartTs);
  const scheduledEndMin = toEpochMinutes(scheduledEndTs);

  // Find active leave targeting this shiftAssignmentId (priority 1) or matching person+workDate with null shiftAssignmentId (priority 2)
  let appliedLeave: MatchingLeaveInput | null = null;
  if (shift.shiftAssignmentId !== null) {
    appliedLeave =
      leaves.find(
        (lv) =>
          lv.personId === shift.personId &&
          lv.workDate === shift.workDate &&
          lv.shiftAssignmentId !== null &&
          Number(lv.shiftAssignmentId) === Number(shift.shiftAssignmentId)
      ) || null;
  }
  if (!appliedLeave) {
    appliedLeave =
      leaves.find(
        (lv) =>
          lv.personId === shift.personId &&
          lv.workDate === shift.workDate &&
          lv.shiftAssignmentId === null
      ) || null;
  }

  let evaluatedStartMin = scheduledStartMin;
  let evaluatedEndMin = scheduledEndMin;
  let hasMorningLeaveShift = false;
  let hasAfternoonLeaveShift = false;

  if (appliedLeave) {
    const lvStartHm = normalizeHm(appliedLeave.leaveStartTime);
    const lvEndHm = normalizeHm(appliedLeave.leaveEndTime);
    const lvStartDay =
      isCross && lvStartHm < startHm ? addDaysYmd(shift.workDate, 1) : shift.workDate;
    const lvEndDay =
      lvEndHm <= lvStartHm || (isCross && lvEndHm < startHm)
        ? addDaysYmd(lvStartDay, lvEndHm <= lvStartHm ? 1 : 0)
        : lvStartDay;
    const lvStartMin = toEpochMinutes(`${lvStartDay} ${lvStartHm}:00`);
    const lvEndMin = toEpochMinutes(`${lvEndDay} ${lvEndHm}:00`);

    // Only apply leave if it actually overlaps [scheduledStartMin, scheduledEndMin]
    if (lvEndMin > scheduledStartMin && lvStartMin < scheduledEndMin) {
      if (
        appliedLeave.leaveType === 'HALF_DAY_MORNING' ||
        (lvStartMin <= scheduledStartMin && lvEndMin < scheduledEndMin)
      ) {
        // Morning / start-of-shift leave: work begins at lvEndMin
        evaluatedStartMin = Math.min(scheduledEndMin - 1, Math.max(scheduledStartMin, lvEndMin));
        hasMorningLeaveShift = true;
      } else if (
        appliedLeave.leaveType === 'HALF_DAY_AFTERNOON' ||
        (lvStartMin > scheduledStartMin && lvEndMin >= scheduledEndMin)
      ) {
        // Afternoon / end-of-shift leave: work ends at lvStartMin
        evaluatedEndMin = Math.max(scheduledStartMin + 1, Math.min(scheduledEndMin, lvStartMin));
        hasAfternoonLeaveShift = true;
      } else {
        // Partial leave inside shift: choose boundary closest to leave
        if (lvStartMin - scheduledStartMin <= scheduledEndMin - lvEndMin) {
          evaluatedStartMin = Math.min(scheduledEndMin - 1, lvEndMin);
          hasMorningLeaveShift = true;
        } else {
          evaluatedEndMin = Math.max(scheduledStartMin + 1, lvStartMin);
          hasAfternoonLeaveShift = true;
        }
      }
    } else {
      appliedLeave = null;
    }
  }

  const evaluatedStartTs = fromEpochMinutes(evaluatedStartMin);
  const evaluatedEndTs = fromEpochMinutes(evaluatedEndMin);

  // Cutoff timestamp for NO_SCAN evaluation
  let cutoffMin: number;
  if (hasMorningLeaveShift) {
    // Shift cutoff proportionally relative to evaluatedStartMin
    const baseCutoffDay = cutoffHm < startHm ? addDaysYmd(shift.workDate, 1) : shift.workDate;
    const baseCutoffOffset = Math.max(
      60,
      toEpochMinutes(`${baseCutoffDay} ${cutoffHm}:00`) - scheduledStartMin
    );
    cutoffMin = Math.min(evaluatedEndMin, evaluatedStartMin + baseCutoffOffset);
  } else {
    const cutoffDay = cutoffHm < startHm ? addDaysYmd(shift.workDate, 1) : shift.workDate;
    cutoffMin = Math.min(evaluatedEndMin, toEpochMinutes(`${cutoffDay} ${cutoffHm}:00`));
  }
  const cutoffTs = fromEpochMinutes(cutoffMin);

  const effectiveDurationMin = Math.max(30, evaluatedEndMin - evaluatedStartMin);
  const configuredInBefore = Number.isFinite(shift.checkinWindowBeforeMin)
    ? Math.max(0, shift.checkinWindowBeforeMin)
    : 120;
  const configuredInAfter = Number.isFinite(shift.checkinWindowAfterMin)
    ? Math.max(30, shift.checkinWindowAfterMin)
    : 240;
  const configuredOutBefore = Number.isFinite(shift.checkoutWindowBeforeMin)
    ? Math.max(30, shift.checkoutWindowBeforeMin)
    : 180;
  const configuredOutAfter = Number.isFinite(shift.checkoutWindowAfterMin)
    ? Math.max(30, shift.checkoutWindowAfterMin)
    : 240;

  // ATT-15: Morning half-day leave uses central pre-checkin window setting (30 / 60 / 120 min)
  const effectiveInBefore = hasMorningLeaveShift
    ? Math.max(0, halfDayPreCheckinWindowMinutes)
    : configuredInBefore;

  // ATT-06: Support 3-4h IN after shift start, bounded cleanly inside remaining work span without colliding with OUT end
  const maxInAfterForDuration =
    hasMorningLeaveShift || hasAfternoonLeaveShift
      ? Math.max(30, Math.floor(effectiveDurationMin * 0.6))
      : Math.max(30, Math.min(configuredInAfter, effectiveDurationMin - 60));
  const effectiveInAfter = Math.min(configuredInAfter, maxInAfterForDuration);

  // ATT-07 / ATT-10 / ATT-15: Checkout window before end (up to 3h for 8h shift, scaled cleanly for half-day)
  const maxOutBeforeForDuration =
    hasMorningLeaveShift || hasAfternoonLeaveShift
      ? Math.max(30, Math.floor(effectiveDurationMin * 0.5))
      : Math.max(30, Math.min(configuredOutBefore, effectiveDurationMin - 60));
  const effectiveOutBefore = Math.min(configuredOutBefore, maxOutBeforeForDuration);

  const inWindowStartMin = evaluatedStartMin - effectiveInBefore;
  const inWindowEndMin = Math.min(evaluatedEndMin - 1, evaluatedStartMin + effectiveInAfter);
  const outWindowStartMin = Math.max(evaluatedStartMin + 1, evaluatedEndMin - effectiveOutBefore);
  const outWindowEndMin = evaluatedEndMin + configuredOutAfter;

  return {
    input: shift,
    scheduledStartTs,
    scheduledEndTs,
    scheduledStartMin,
    scheduledEndMin,
    evaluatedStartTs,
    evaluatedEndTs,
    evaluatedStartMin,
    evaluatedEndMin,
    cutoffTs,
    cutoffMin,
    inWindowStartSec: inWindowStartMin * 60,
    inWindowEndSec: inWindowEndMin * 60 + 59,
    outWindowStartSec: outWindowStartMin * 60,
    outWindowEndSec: outWindowEndMin * 60 + 59,
    appliedLeave,
  };
}

interface DpValue {
  matchedSlots: number;
  matchedInSlots: number;
  /** Assigned scan index (0..N-1) or -1 if null, for each slot 0..slotIndex */
  assignments: number[];
}

/**
 * Lexicographic optimality comparator for two DP assignments of identical prefix length:
 * 1. More total valid matched slots wins (ATT-04, ATT-05, ATT-08: supports both shifts when distinct scans exist)
 * 2. More IN slots matched wins (ATT-16: single scan in overlap prioritizes next shift IN over previous shift OUT)
 * 3. Slot-by-slot earliest valid scan wins (ATT-06 first valid IN, ATT-07 first valid OUT, TC-23)
 */
function isBetterDp(candidate: DpValue, currentBest: DpValue | null): boolean {
  if (!currentBest) return true;
  if (candidate.matchedSlots !== currentBest.matchedSlots) {
    return candidate.matchedSlots > currentBest.matchedSlots;
  }
  if (candidate.matchedInSlots !== currentBest.matchedInSlots) {
    return candidate.matchedInSlots > currentBest.matchedInSlots;
  }
  const len = candidate.assignments.length;
  for (let s = 0; s < len; s++) {
    const a = candidate.assignments[s];
    const b = currentBest.assignments[s];
    if (a === b) continue;
    const isInSlot = s % 2 === 0;
    if (a !== -1 && b !== -1) {
      // Both filled: earlier scan index wins (ATT-06 / ATT-07)
      return a < b;
    }
    // One filled, one empty: prefer filling IN slots over OUT slots (ATT-16), or earlier shift
    if (isInSlot) {
      return a !== -1;
    }
    return a !== -1;
  }
  return false;
}

/**
 * Solves a connected cluster of chronologically ordered shifts for ONE person
 * using exact dynamic programming over (slotIndex, lastUsedScanIndex).
 * Guarantees:
 * - Zero scan reuse (ATT-03)
 * - Strict window compliance (ATT-06, ATT-07, TC-28)
 * - IN strictly precedes OUT in real timestamp within each shift (Section 4.3)
 * - Consecutive shifts can be 1 minute apart with distinct scans (ATT-04, ATT-05)
 * - Single-scan overlap prioritizes next shift IN (ATT-16)
 * - Earliest valid IN and earliest valid OUT selected (ATT-06, ATT-07, TC-02, TC-03, TC-23)
 */
function solveShiftCluster(
  clusterShifts: PreparedShift[],
  clusterScans: PreparedScan[]
): {
  shiftPairs: Array<{ inScan: PreparedScan | null; outScan: PreparedScan | null; ruleNote: string }>;
} {
  const K = clusterShifts.length;
  const N = clusterScans.length;
  const totalSlots = K * 2;

  if (N === 0) {
    return {
      shiftPairs: clusterShifts.map(() => ({
        inScan: null,
        outScan: null,
        ruleNote: 'NO_RAW_SCANS_IN_WINDOW',
      })),
    };
  }

  // Precompute valid scan indices per slot
  const slotCandidates: number[][] = [];
  for (let k = 0; k < K; k++) {
    const sh = clusterShifts[k];
    const inCands: number[] = [];
    const outCands: number[] = [];
    for (let i = 0; i < N; i++) {
      const sec = clusterScans[i].epochSec;
      if (sec >= sh.inWindowStartSec && sec <= sh.inWindowEndSec) {
        inCands.push(i);
      }
      if (sec >= sh.outWindowStartSec && sec <= sh.outWindowEndSec) {
        outCands.push(i);
      }
    }
    slotCandidates.push(inCands, outCands);
  }

  // DP state keyed by lastUsedScanIdx (-1 .. N-1) plus whether previous slot (IN of same shift) was filled
  // Key encoding: `${lastUsed}:${prevSlotScanIdx}` -> simplifies exact check for IN < OUT real timestamp!
  // Actually for an IN slot (even), we don't need prevSlotScanIdx; for an OUT slot (odd), we only need lastUsed & inScanIdxOfSameShift.
  // Because N per cluster is small (typically <= 40), keeping Map<number, DpValue> where key = lastUsed (-1..N-1)
  // AND at even slot storing the shift's IN scan directly in assignments[slot-1] works cleanly!
  // Wait: two states with the SAME lastUsed could differ on whether assignments[2k] was lastUsed vs an earlier slot.
  // So key by `${lastUsed}:${sameShiftInIdx}` at odd slots, and `${lastUsed}` at even slots!
  let currentLayer = new Map<string, DpValue>();
  currentLayer.set('-1', {
    matchedSlots: 0,
    matchedInSlots: 0,
    assignments: [],
  });

  for (let slot = 0; slot < totalSlots; slot++) {
    const isInSlot = slot % 2 === 0;
    const cands = slotCandidates[slot];
    const nextLayer = new Map<string, DpValue>();

    const offer = (key: string, val: DpValue) => {
      const existing = nextLayer.get(key) || null;
      if (isBetterDp(val, existing)) {
        nextLayer.set(key, val);
      }
    };

    for (const [stateKey, dpVal] of currentLayer.entries()) {
      const lastUsed = Number(stateKey.split(':')[0]);
      const sameShiftInIdx = isInSlot ? -1 : dpVal.assignments[slot - 1];

      // Option 1: Leave this slot unmatched (-1)
      const skipKey = isInSlot ? `${lastUsed}:-1` : `${lastUsed}`;
      offer(skipKey, {
        matchedSlots: dpVal.matchedSlots,
        matchedInSlots: dpVal.matchedInSlots,
        assignments: [...dpVal.assignments, -1],
      });

      // Option 2: Assign a candidate scan j > lastUsed
      for (const j of cands) {
        if (j <= lastUsed) continue;

        if (!isInSlot && sameShiftInIdx !== -1) {
          // Section 4.3: IN must strictly precede OUT in real timestamp within the same shift
          if (clusterScans[j].epochSec <= clusterScans[sameShiftInIdx].epochSec) {
            continue;
          }
        }

        const nextKey = isInSlot ? `${j}:${j}` : `${j}`;
        offer(nextKey, {
          matchedSlots: dpVal.matchedSlots + 1,
          matchedInSlots: dpVal.matchedInSlots + (isInSlot ? 1 : 0),
          assignments: [...dpVal.assignments, j],
        });
      }
    }

    currentLayer = nextLayer;
  }

  // Pick global best across final layer
  let best: DpValue | null = null;
  for (const val of currentLayer.values()) {
    if (isBetterDp(val, best)) {
      best = val;
    }
  }

  const finalAssign = best ? best.assignments : new Array<number>(totalSlots).fill(-1);
  const shiftPairs: Array<{ inScan: PreparedScan | null; outScan: PreparedScan | null; ruleNote: string }> = [];

  for (let k = 0; k < K; k++) {
    const inIdx = finalAssign[k * 2];
    const outIdx = finalAssign[k * 2 + 1];
    const inScan = inIdx >= 0 ? clusterScans[inIdx] : null;
    const outScan = outIdx >= 0 ? clusterScans[outIdx] : null;

    // Annotate matching rule for auditability
    let ruleNote = 'GLOBAL_FIRST_VALID_IN_OUT';
    if (K > 1) {
      // Detect if ATT-16 overlap priority applied (this shift lost OUT while next shift gained IN from an overlap scan)
      if (!outScan && k + 1 < K) {
        const nextInIdx = finalAssign[(k + 1) * 2];
        if (nextInIdx >= 0 && slotCandidates[k * 2 + 1].includes(nextInIdx)) {
          ruleNote = 'ATT16_OVERLAP_PRIORITIZED_NEXT_SHIFT_IN';
        } else {
          ruleNote = 'GLOBAL_MULTI_SHIFT_ALLOCATED';
        }
      } else if (inScan && k > 0 && slotCandidates[(k - 1) * 2 + 1].includes(inIdx)) {
        const prevOutIdx = finalAssign[(k - 1) * 2 + 1];
        ruleNote =
          prevOutIdx === -1
            ? 'ATT16_OVERLAP_PRIORITIZED_NEXT_SHIFT_IN'
            : 'ATT04_CONSECUTIVE_DISTINCT_OUT_IN';
      } else {
        ruleNote = 'GLOBAL_MULTI_SHIFT_ALLOCATED';
      }
    } else if (!inScan && !outScan) {
      ruleNote = 'NO_VALID_SCAN_IN_WINDOW';
    } else if (!inScan && outScan) {
      ruleNote = 'ATT14_OUT_ONLY_MISSING_CHECKIN';
    } else if (inScan && !outScan) {
      ruleNote = 'ATT14_IN_ONLY_MISSING_CHECKOUT';
    }

    if (clusterShifts[k].appliedLeave) {
      ruleNote = `${ruleNote}|ATT15_HALF_DAY_LEAVE`;
    }

    shiftPairs.push({ inScan, outScan, ruleNote });
  }

  return { shiftPairs };
}

/**
 * Runs global multi-shift attendance matching for ONE person across all loaded shifts and raw scans.
 */
export function matchPersonShiftsGlobally(params: {
  shifts: MatchingShiftInput[];
  rawScans: MatchingRawScanInput[];
  leaves: MatchingLeaveInput[];
  config: MatchingConfig;
}): GlobalMatchResult {
  const nowMin = toEpochMinutes(params.config.referenceNowBkk);
  const halfDayPreWindow = Number.isFinite(params.config.halfDayPreCheckinWindowMinutes)
    ? Math.max(0, params.config.halfDayPreCheckinWindowMinutes)
    : 60;

  // Separate PENDING_MAPPING shifts (do not consume scans)
  const pendingShifts: MatchingShiftInput[] = [];
  const validShiftInputs: MatchingShiftInput[] = [];
  for (const sh of params.shifts) {
    if (sh.mappingStatus && sh.mappingStatus !== 'VALID') {
      pendingShifts.push(sh);
    } else {
      validShiftInputs.push(sh);
    }
  }

  // Prepare & sort valid shifts chronologically (ATT-01)
  const preparedShifts = validShiftInputs
    .map((sh) => prepareShiftWindow(sh, params.leaves, halfDayPreWindow))
    .sort(
      (a, b) =>
        a.evaluatedStartMin - b.evaluatedStartMin ||
        a.evaluatedEndMin - b.evaluatedEndMin ||
        (a.input.shiftAssignmentId ?? 0) - (b.input.shiftAssignmentId ?? 0) ||
        a.input.shiftCode.localeCompare(b.input.shiftCode)
    );

  // Prepare & sort raw scans strictly by (canonicalBkkTime ASC, id ASC) (ATT-02, TC-29)
  const preparedScans: PreparedScan[] = [...params.rawScans]
    .map((s) => ({
      id: Number(s.id),
      personId: s.personId,
      canonicalBkkTime: s.canonicalBkkTime,
      epochSec: toEpochSeconds(s.canonicalBkkTime),
      epochMin: toEpochMinutes(s.canonicalBkkTime),
      inOutMode: s.inOutMode,
    }))
    .sort((a, b) => a.epochSec - b.epochSec || a.id - b.id);

  // Partition shifts into connected components based on shared candidate raw scans
  // (keeps DP tiny and fast even across full-month ranges!)
  const shiftScanIndices: Set<number>[] = preparedShifts.map((sh) => {
    const set = new Set<number>();
    for (let i = 0; i < preparedScans.length; i++) {
      const sec = preparedScans[i].epochSec;
      const inMatch = sec >= sh.inWindowStartSec && sec <= sh.inWindowEndSec;
      const outMatch = sec >= sh.outWindowStartSec && sec <= sh.outWindowEndSec;
      if (inMatch || outMatch) {
        set.add(i);
      }
    }
    return set;
  });

  const clusters: number[][] = [];
  let curCluster: number[] = [];
  let curScanUnion = new Set<number>();

  for (let k = 0; k < preparedShifts.length; k++) {
    const shScans = shiftScanIndices[k];
    let overlapsCluster = false;
    for (const idx of shScans) {
      if (curScanUnion.has(idx)) {
        overlapsCluster = true;
        break;
      }
    }
    if (curCluster.length === 0 || overlapsCluster) {
      curCluster.push(k);
      for (const idx of shScans) curScanUnion.add(idx);
    } else {
      clusters.push(curCluster);
      curCluster = [k];
      curScanUnion = new Set<number>(shScans);
    }
  }
  if (curCluster.length > 0) {
    clusters.push(curCluster);
  }

  const outcomes: MatchedShiftOutcome[] = [];
  const usedScanIds = new Set<number>();
  const scanUsageMap = new Map<
    number,
    {
      usageRole: 'CHECK_IN' | 'CHECK_OUT';
      workDate: string;
      shiftAssignmentId: number | null;
      shiftCode: string;
    }
  >();

  // Solve each connected shift cluster globally
  for (const cluster of clusters) {
    const clusterShifts = cluster.map((idx) => preparedShifts[idx]);
    const relevantScanIdxSet = new Set<number>();
    for (const idx of cluster) {
      for (const sIdx of shiftScanIndices[idx]) {
        relevantScanIdxSet.add(sIdx);
      }
    }
    const relevantScanIndices = Array.from(relevantScanIdxSet).sort((a, b) => a - b);
    const clusterScans = relevantScanIndices.map((sIdx) => preparedScans[sIdx]);

    const { shiftPairs } = solveShiftCluster(clusterShifts, clusterScans);

    for (let c = 0; c < clusterShifts.length; c++) {
      const sh = clusterShifts[c];
      const { inScan, outScan, ruleNote } = shiftPairs[c];

      if (inScan) {
        usedScanIds.add(inScan.id);
        scanUsageMap.set(inScan.id, {
          usageRole: 'CHECK_IN',
          workDate: sh.input.workDate,
          shiftAssignmentId: sh.input.shiftAssignmentId,
          shiftCode: sh.input.shiftCode,
        });
      }
      if (outScan) {
        usedScanIds.add(outScan.id);
        scanUsageMap.set(outScan.id, {
          usageRole: 'CHECK_OUT',
          workDate: sh.input.workDate,
          shiftAssignmentId: sh.input.shiftAssignmentId,
          shiftCode: sh.input.shiftCode,
        });
      }

      // Compute Lateness (ATT-06, ATT-15)
      let isLate = 0;
      let lateMinutes = 0;
      if (inScan) {
        const rawDiffMin = inScan.epochMin - sh.evaluatedStartMin;
        isLate = rawDiffMin > Number(sh.input.graceMinutes) ? 1 : 0;
        lateMinutes = isLate ? Math.max(0, rawDiffMin) : 0;
      }

      // Compute Early Checkout (ATT-10, ATT-15)
      let earlyCheckoutIndicator = 0;
      let earlyCheckoutMinutes = 0;
      if (outScan) {
        const earlyDiffMin = sh.evaluatedEndMin - outScan.epochMin;
        if (earlyDiffMin > 0) {
          earlyCheckoutIndicator = 1;
          earlyCheckoutMinutes = earlyDiffMin;
        }
      }

      // Determine Completeness Status & Legacy Status (ATT-10, ATT-12, ATT-14)
      if (!inScan && !outScan) {
        // Before cutoff -> shift not yet due for NO_SCAN
        if (nowMin < sh.cutoffMin) {
          continue;
        }
        outcomes.push({
          personId: sh.input.personId,
          workDate: sh.input.workDate,
          shiftAssignmentId: sh.input.shiftAssignmentId,
          shiftCode: sh.input.shiftCode,
          shiftName: sh.input.shiftName,
          scheduledStart: sh.scheduledStartTs,
          scheduledEnd: sh.scheduledEndTs,
          evaluatedStartTime: sh.evaluatedStartTs,
          evaluatedEndTime: sh.evaluatedEndTs,
          cutoffTimestamp: sh.cutoffTs,
          checkInTime: null,
          checkOutTime: null,
          checkInRawScanId: null,
          checkOutRawScanId: null,
          status: 'NO_SCAN',
          attendanceStatus: 'NO_SCAN',
          secondaryFlags: null,
          isLate: 0,
          lateMinutes: 0,
          earlyCheckoutIndicator: 0,
          earlyCheckoutMinutes: 0,
          matchingRule: ruleNote,
          leaveId: sh.appliedLeave?.id ?? null,
          leaveType: sh.appliedLeave?.leaveType ?? null,
          leaveStartTime: sh.appliedLeave?.leaveStartTime ?? null,
          leaveEndTime: sh.appliedLeave?.leaveEndTime ?? null,
        });
        continue;
      }

      if (!inScan && outScan) {
        // ATT-14 / TC-16: Has OUT, missing IN -> MISSING_CHECKIN
        outcomes.push({
          personId: sh.input.personId,
          workDate: sh.input.workDate,
          shiftAssignmentId: sh.input.shiftAssignmentId,
          shiftCode: sh.input.shiftCode,
          shiftName: sh.input.shiftName,
          scheduledStart: sh.scheduledStartTs,
          scheduledEnd: sh.scheduledEndTs,
          evaluatedStartTime: sh.evaluatedStartTs,
          evaluatedEndTime: sh.evaluatedEndTs,
          cutoffTimestamp: sh.cutoffTs,
          checkInTime: null,
          checkOutTime: outScan.canonicalBkkTime,
          checkInRawScanId: null,
          checkOutRawScanId: outScan.id,
          status: 'MISSING_CHECKIN',
          attendanceStatus: 'MISSING_CHECKIN',
          secondaryFlags: earlyCheckoutIndicator ? 'EARLY_CHECKOUT' : null,
          isLate: 0,
          lateMinutes: 0,
          earlyCheckoutIndicator,
          earlyCheckoutMinutes,
          matchingRule: ruleNote,
          leaveId: sh.appliedLeave?.id ?? null,
          leaveType: sh.appliedLeave?.leaveType ?? null,
          leaveStartTime: sh.appliedLeave?.leaveStartTime ?? null,
          leaveEndTime: sh.appliedLeave?.leaveEndTime ?? null,
        });
        continue;
      }

      if (inScan && !outScan) {
        // ATT-14 / TC-15: Has IN, missing OUT -> IN_PROGRESS / LATE_IN_PROGRESS before evaluatedEndMin, MISSING_CHECKOUT after
        const isPastEnd = nowMin >= sh.evaluatedEndMin;
        const activeStatus: LegacyAttendanceStatus = isPastEnd
          ? 'MISSING_CHECKOUT'
          : isLate
            ? 'LATE_IN_PROGRESS'
            : 'IN_PROGRESS';
        const activeAttStatus: AttendanceCompletenessStatus = isPastEnd
          ? 'MISSING_CHECKOUT'
          : isLate
            ? 'LATE_IN_PROGRESS'
            : 'IN_PROGRESS';
        outcomes.push({
          personId: sh.input.personId,
          workDate: sh.input.workDate,
          shiftAssignmentId: sh.input.shiftAssignmentId,
          shiftCode: sh.input.shiftCode,
          shiftName: sh.input.shiftName,
          scheduledStart: sh.scheduledStartTs,
          scheduledEnd: sh.scheduledEndTs,
          evaluatedStartTime: sh.evaluatedStartTs,
          evaluatedEndTime: sh.evaluatedEndTs,
          cutoffTimestamp: sh.cutoffTs,
          checkInTime: inScan.canonicalBkkTime,
          checkOutTime: null,
          checkInRawScanId: inScan.id,
          checkOutRawScanId: null,
          status: activeStatus,
          attendanceStatus: activeAttStatus,
          secondaryFlags: isPastEnd && isLate ? 'LATE_AND_MISSING_CHECKOUT' : null,
          isLate,
          lateMinutes,
          earlyCheckoutIndicator: 0,
          earlyCheckoutMinutes: 0,
          matchingRule: ruleNote,
          leaveId: sh.appliedLeave?.id ?? null,
          leaveType: sh.appliedLeave?.leaveType ?? null,
          leaveStartTime: sh.appliedLeave?.leaveStartTime ?? null,
          leaveEndTime: sh.appliedLeave?.leaveEndTime ?? null,
        });
        continue;
      }

      // Both IN and OUT present -> COMPLETE (with independent LATE and EARLY_CHECKOUT indicators!)
      const secondaryFlags =
        isLate && earlyCheckoutIndicator
          ? 'LATE_AND_EARLY_CHECKOUT'
          : earlyCheckoutIndicator
            ? 'EARLY_CHECKOUT'
            : null;

      outcomes.push({
        personId: sh.input.personId,
        workDate: sh.input.workDate,
        shiftAssignmentId: sh.input.shiftAssignmentId,
        shiftCode: sh.input.shiftCode,
        shiftName: sh.input.shiftName,
        scheduledStart: sh.scheduledStartTs,
        scheduledEnd: sh.scheduledEndTs,
        evaluatedStartTime: sh.evaluatedStartTs,
        evaluatedEndTime: sh.evaluatedEndTs,
        cutoffTimestamp: sh.cutoffTs,
        checkInTime: inScan!.canonicalBkkTime,
        checkOutTime: outScan!.canonicalBkkTime,
        checkInRawScanId: inScan!.id,
        checkOutRawScanId: outScan!.id,
        status: isLate ? 'LATE' : 'NORMAL',
        attendanceStatus: 'COMPLETE',
        secondaryFlags,
        isLate,
        lateMinutes,
        earlyCheckoutIndicator,
        earlyCheckoutMinutes,
        matchingRule: ruleNote,
        leaveId: sh.appliedLeave?.id ?? null,
        leaveType: sh.appliedLeave?.leaveType ?? null,
        leaveStartTime: sh.appliedLeave?.leaveStartTime ?? null,
        leaveEndTime: sh.appliedLeave?.leaveEndTime ?? null,
      });
    }
  }

  // Append PENDING_MAPPING shifts (do not consume any raw scans)
  for (const sh of pendingShifts) {
    const prep = prepareShiftWindow(sh, params.leaves, halfDayPreWindow);
    outcomes.push({
      personId: sh.personId,
      workDate: sh.workDate,
      shiftAssignmentId: sh.shiftAssignmentId,
      shiftCode: sh.shiftCode,
      shiftName: sh.shiftName,
      scheduledStart: prep.scheduledStartTs,
      scheduledEnd: prep.scheduledEndTs,
      evaluatedStartTime: prep.evaluatedStartTs,
      evaluatedEndTime: prep.evaluatedEndTs,
      cutoffTimestamp: prep.cutoffTs,
      checkInTime: null,
      checkOutTime: null,
      checkInRawScanId: null,
      checkOutRawScanId: null,
      status: 'PENDING_MAPPING',
      attendanceStatus: 'PENDING_MAPPING',
      secondaryFlags: sh.mappingStatus,
      isLate: 0,
      lateMinutes: 0,
      earlyCheckoutIndicator: 0,
      earlyCheckoutMinutes: 0,
      matchingRule: 'PENDING_PERSONNEL_MAPPING',
      leaveId: prep.appliedLeave?.id ?? null,
      leaveType: prep.appliedLeave?.leaveType ?? null,
      leaveStartTime: prep.appliedLeave?.leaveStartTime ?? null,
      leaveEndTime: prep.appliedLeave?.leaveEndTime ?? null,
    });
  }

  // Build full scan allocation list (ATT-09: track used vs extra unused scans)
  const scanAllocations: MatchingScanAllocation[] = [];
  const extraScanIds: number[] = [];
  for (const s of preparedScans) {
    const usage = scanUsageMap.get(s.id);
    if (usage) {
      scanAllocations.push({
        rawScanId: s.id,
        canonicalBkkTime: s.canonicalBkkTime,
        usageRole: usage.usageRole,
        workDate: usage.workDate,
        shiftAssignmentId: usage.shiftAssignmentId,
        shiftCode: usage.shiftCode,
      });
    } else {
      extraScanIds.push(s.id);
      scanAllocations.push({
        rawScanId: s.id,
        canonicalBkkTime: s.canonicalBkkTime,
        usageRole: 'EXTRA_UNUSED',
        workDate: null,
        shiftAssignmentId: null,
        shiftCode: null,
      });
    }
  }

  return {
    outcomes,
    scanAllocations,
    usedScanIds,
    extraScanIds,
  };
}
