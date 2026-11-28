import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery } from '../../database/adapter.ts';
import { sanitizeCsvCell, getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { buildWorkbookBuffer, type ExcelWorkbookSheetSpec } from '../../utils/xlsx.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';
import { loadHospitalHolidaysForRange } from '../holidays/service.ts';
import { evaluateAttendanceLifecycle } from '../attendance/lifecycle.ts';

export const reportsRouter = Router();

interface AttendanceJoinedRow {
  id: number;
  person_id: string;
  work_date: string;
  shift_code: string | null;
  shift_name: string | null;
  check_in_time: string | null;
  check_out_time: string | null;
  status: string;
  attendance_status?: string | null;
  secondary_flags: string | null;
  is_late: number;
  late_minutes: number;
  early_checkout_indicator?: number;
  early_checkout_minutes?: number;
  review_status: string;
  full_name: string;
  department_name: string;
  work_group_name: string | null;
  personnel_type_code: string;
  personnel_type_name: string;
}

async function queryFilteredAttendance(query: Record<string, unknown>): Promise<{
  dateFrom: string;
  dateTo: string;
  department: string;
  personnelType: string;
  rows: AttendanceJoinedRow[];
}> {
  const bkk = getCurrentBangkokDateParts();
  const dateFrom = String(query.dateFrom || bkk.monthStartYmd).trim();
  const dateTo = String(query.dateTo || bkk.monthEndYmd).trim();
  const department = String(query.department || '').trim();
  const personnelType = String(query.personnelType || '').trim();

  const conditions = ['a.work_date >= ?', 'a.work_date <= ?'];
  const params: unknown[] = [dateFrom, dateTo];

  if (department) {
    conditions.push('p.department_name = ?');
    params.push(department);
  }
  if (personnelType) {
    conditions.push('p.personnel_type_code = ?');
    params.push(personnelType);
  }

  const rows = await dbQuery<AttendanceJoinedRow>(
    `SELECT a.*, p.full_name, p.department_name, p.work_group_name,
            p.personnel_type_code, p.personnel_type_name
     FROM attendance a
     INNER JOIN personnel p ON p.person_id = a.person_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.work_date DESC, a.person_id ASC`,
    params
  );

  return { dateFrom, dateTo, department, personnelType, rows };
}

function buildAggregation(rows: AttendanceJoinedRow[]) {
  const distinctPersonSet = new Set<string>();
  const distinctLatePersonSet = new Set<string>();

  let normalCount = 0;
  let lateOnlyCount = 0;
  let completeCount = 0;
  let inProgressCount = 0;
  let lateInProgressCount = 0;
  let lateOccurrences = 0;
  let noScanCount = 0;
  let missingCheckinCount = 0;
  let missingCheckoutCount = 0;
  let missingCheckoutLateCount = 0;
  let earlyCheckoutCount = 0;
  let pendingMappingCount = 0;
  let pendingReviewCount = 0;
  let needsReReviewCount = 0;
  let totalLateMinutes = 0;

  const personRankingMap = new Map<
    string,
    {
      personId: string;
      fullName: string;
      departmentName: string;
      personnelTypeName: string;
      totalShifts: number;
      lateOccurrences: number;
      totalLateMinutes: number;
      noScanCount: number;
      missingCheckoutCount: number;
    }
  >();

  const departmentBreakdownMap = new Map<
    string,
    {
      departmentName: string;
      totalShifts: number;
      latePersonIds: Set<string>;
      lateOccurrences: number;
      totalLateMinutes: number;
      noScanCount: number;
    }
  >();

  for (const r of rows) {
    distinctPersonSet.add(r.person_id);
    const isLateRow = Number(r.is_late) === 1 || r.status === 'LATE';
    const isEarlyCheckoutRow = Number(r.early_checkout_indicator || 0) === 1;
    const lateMin = Number(r.late_minutes || 0);

    if (r.status === 'NORMAL') normalCount++;
    if (r.status === 'LATE') lateOnlyCount++;
    if (r.status === 'IN_PROGRESS' || r.attendance_status === 'IN_PROGRESS') inProgressCount++;
    if (r.status === 'LATE_IN_PROGRESS' || r.attendance_status === 'LATE_IN_PROGRESS') {
      lateInProgressCount++;
    }
    if (r.attendance_status === 'COMPLETE' || r.status === 'NORMAL' || r.status === 'LATE') {
      completeCount++;
    }
    if (r.status === 'NO_SCAN') noScanCount++;
    if (r.status === 'MISSING_CHECKIN' || r.attendance_status === 'MISSING_CHECKIN') {
      missingCheckinCount++;
    }
    if (r.status === 'MISSING_CHECKOUT') {
      missingCheckoutCount++;
      if (isLateRow) missingCheckoutLateCount++;
    }
    if (isEarlyCheckoutRow) earlyCheckoutCount++;
    if (r.status === 'PENDING_MAPPING') pendingMappingCount++;
    if (r.review_status === 'NEEDS_RE_REVIEW') needsReReviewCount++;
    if (
      (r.review_status === 'PENDING' && (r.status !== 'NORMAL' || isLateRow || isEarlyCheckoutRow)) ||
      r.review_status === 'NEEDS_RE_REVIEW'
    ) {
      pendingReviewCount++;
    }

    if (isLateRow) {
      lateOccurrences++;
      distinctLatePersonSet.add(r.person_id);
      totalLateMinutes += lateMin;
    }

    // Per-person ranking
    const existingP = personRankingMap.get(r.person_id) || {
      personId: r.person_id,
      fullName: r.full_name,
      departmentName: r.department_name,
      personnelTypeName: r.personnel_type_name,
      totalShifts: 0,
      lateOccurrences: 0,
      totalLateMinutes: 0,
      noScanCount: 0,
      missingCheckoutCount: 0,
    };
    existingP.totalShifts++;
    if (isLateRow) {
      existingP.lateOccurrences++;
      existingP.totalLateMinutes += lateMin;
    }
    if (r.status === 'NO_SCAN') existingP.noScanCount++;
    if (r.status === 'MISSING_CHECKOUT') existingP.missingCheckoutCount++;
    personRankingMap.set(r.person_id, existingP);

    // Per-department summary
    const existingD = departmentBreakdownMap.get(r.department_name) || {
      departmentName: r.department_name,
      totalShifts: 0,
      latePersonIds: new Set<string>(),
      lateOccurrences: 0,
      totalLateMinutes: 0,
      noScanCount: 0,
    };
    existingD.totalShifts++;
    if (isLateRow) {
      existingD.latePersonIds.add(r.person_id);
      existingD.lateOccurrences++;
      existingD.totalLateMinutes += lateMin;
    }
    if (r.status === 'NO_SCAN') existingD.noScanCount++;
    departmentBreakdownMap.set(r.department_name, existingD);
  }

  const latePeople = distinctLatePersonSet.size;
  const avgLateMinutesPerOccurrence =
    lateOccurrences > 0 ? Number((totalLateMinutes / lateOccurrences).toFixed(2)) : 0;
  const avgLateMinutesPerLatePerson =
    latePeople > 0 ? Number((totalLateMinutes / latePeople).toFixed(2)) : 0;

  const ranking = Array.from(personRankingMap.values())
    .map((p) => ({
      ...p,
      avgLateMinutesPerOccurrence:
        p.lateOccurrences > 0 ? Number((p.totalLateMinutes / p.lateOccurrences).toFixed(2)) : 0,
    }))
    .sort((a, b) => b.totalLateMinutes - a.totalLateMinutes || b.lateOccurrences - a.lateOccurrences);

  const departmentBreakdown = Array.from(departmentBreakdownMap.values()).map((d) => ({
    departmentName: d.departmentName,
    totalShifts: d.totalShifts,
    latePeople: d.latePersonIds.size,
    lateOccurrences: d.lateOccurrences,
    totalLateMinutes: d.totalLateMinutes,
    noScanCount: d.noScanCount,
  }));

  return {
    kpi: {
      evaluatedPersonnelCount: distinctPersonSet.size,
      totalShifts: rows.length,
      normalCount,
      lateOnlyCount,
      completeCount,
      inProgressCount,
      lateInProgressCount,
      latePeople,
      lateOccurrences,
      totalLateMinutes,
      avgLateMinutesPerOccurrence,
      avgLateMinutesDenominatorLabel: 'นาทีสายรวม ÷ จำนวนครั้งที่สาย (late_occurrences)',
      avgLateMinutesPerLatePerson,
      avgLatePerPersonDenominatorLabel: 'นาทีสายรวม ÷ จำนวนคนที่สายไม่ซ้ำ (late_people)',
      noScanCount,
      missingCheckinCount,
      missingCheckoutCount,
      missingCheckoutLateCount,
      earlyCheckoutCount,
      pendingMappingCount,
      pendingReviewCount,
      needsReReviewCount,
    },
    ranking,
    departmentBreakdown,
  };
}

// B2. Dashboard Summary
reportsRouter.get(
  '/dashboard/summary',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const cfg = loadConfig();
      const { dateFrom, dateTo, department, personnelType, rows } = await queryFilteredAttendance(
        req.query as Record<string, unknown>
      );
      const aggregated = buildAggregation(rows);

      const totalPersonnelDb = await dbQuery<{ cnt: number }>(
        'SELECT COUNT(*) as cnt FROM personnel WHERE is_active = 1'
      );
      const distinctDeptRows = await dbQuery<{ department_name: string }>(
        "SELECT DISTINCT department_name FROM personnel WHERE is_active = 1 AND department_name <> '' ORDER BY department_name ASC"
      );
      const distinctTypeRows = await dbQuery<{
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        `SELECT DISTINCT personnel_type_code, personnel_type_name
         FROM personnel
         WHERE is_active = 1 AND personnel_type_code <> ''
         UNION
         SELECT personnel_type_code, personnel_type_name FROM personnel_type_rules
         ORDER BY personnel_type_code ASC`
      );

      const lastSyncRuns = await dbQuery<{
        id: number;
        started_at: string;
        finished_at: string | null;
        status: string;
        new_scans_inserted: number;
        error_code: string | null;
      }>('SELECT id, started_at, finished_at, status, new_scans_inserted, error_code FROM sync_runs ORDER BY id DESC LIMIT 5');

      const lastSuccessRun = await dbQuery<{ finished_at: string }>(
        "SELECT finished_at FROM sync_runs WHERE status = 'SUCCESS' ORDER BY id DESC LIMIT 1"
      );
      const failedRunCount = await dbQuery<{ cnt: number }>(
        "SELECT COUNT(*) as cnt FROM sync_runs WHERE status = 'FAILED'"
      );

      const bkk = getCurrentBangkokDateParts();
      const todayRows = await dbQuery<{
        status: string;
        attendance_status: string | null;
        is_late: number;
        check_in_time: string | null;
        check_out_time: string | null;
      }>(
        `SELECT a.status, a.attendance_status, a.is_late, a.check_in_time, a.check_out_time
         FROM attendance a
         INNER JOIN personnel p ON p.person_id = a.person_id
         WHERE a.work_date = ?
           ${department ? 'AND p.department_name = ?' : ''}
           ${personnelType ? 'AND p.personnel_type_code = ?' : ''}`,
        [bkk.todayYmd, ...(department ? [department] : []), ...(personnelType ? [personnelType] : [])]
      );
      const todayScheduledRows = await dbQuery<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM shift_assignments sa
         INNER JOIN personnel p ON p.person_id = sa.person_id
         WHERE sa.work_date = ? AND sa.status = 'ACTIVE'
           ${department ? 'AND p.department_name = ?' : ''}
           ${personnelType ? 'AND p.personnel_type_code = ?' : ''}`,
        [bkk.todayYmd, ...(department ? [department] : []), ...(personnelType ? [personnelType] : [])]
      );
      const todayScheduled = Math.max(Number(todayScheduledRows[0]?.cnt || 0), todayRows.length);
      const todayCheckedIn = todayRows.filter((r) => Boolean(r.check_in_time)).length;
      const todayInProgress = todayRows.filter(
        (r) => r.status === 'IN_PROGRESS' || r.attendance_status === 'IN_PROGRESS'
      ).length;
      const todayLateInProgress = todayRows.filter(
        (r) => r.status === 'LATE_IN_PROGRESS' || r.attendance_status === 'LATE_IN_PROGRESS'
      ).length;
      const todayCompleted = todayRows.filter(
        (r) =>
          (Boolean(r.check_in_time) && Boolean(r.check_out_time)) ||
          r.attendance_status === 'COMPLETE' ||
          r.status === 'NORMAL' ||
          r.status === 'LATE'
      ).length;
      const todayAlert = todayRows.filter(
        (r) => r.status === 'NO_SCAN' || r.status === 'MISSING_CHECKIN' || r.status === 'MISSING_CHECKOUT'
      ).length;

      res.json({
        dataMode: cfg.dataMode,
        isEmptyPeriod: rows.length === 0,
        filters: { dateFrom, dateTo, department, personnelType },
        availableDepartments: distinctDeptRows.map((d) => d.department_name),
        availablePersonnelTypes: distinctTypeRows.map((t) => ({
          code: t.personnel_type_code,
          name: t.personnel_type_name,
        })),
        activePersonnelTotal: Number(totalPersonnelDb[0]?.cnt || 0),
        ...aggregated,
        todaySummary: {
          workDate: bkk.todayYmd,
          scheduled: todayScheduled,
          checkedIn: todayCheckedIn,
          inProgress: todayInProgress,
          lateInProgress: todayLateInProgress,
          completed: todayCompleted,
          awaitingCheckin: Math.max(0, todayScheduled - todayCheckedIn - todayAlert),
          missingOrAlert: todayAlert,
        },
        scannerTelemetry: {
          lastSyncRun: lastSyncRuns[0] || null,
          lastSuccessTimestamp: lastSuccessRun[0]?.finished_at || null,
          totalFailedSyncs: Number(failedRunCount[0]?.cnt || 0),
          recentSyncRuns: lastSyncRuns,
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// B10. Lateness Report & Ranking
reportsRouter.get(
  '/reports/lateness',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const sortOrder = String(req.query.sortOrder || 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc';
      const { dateFrom, dateTo, department, personnelType, rows } = await queryFilteredAttendance(
        req.query as Record<string, unknown>
      );
      const aggregated = buildAggregation(rows);

      const sortedRanking = [...aggregated.ranking].sort((a, b) => {
        const diff = b.totalLateMinutes - a.totalLateMinutes || b.lateOccurrences - a.lateOccurrences;
        return sortOrder === 'asc' ? -diff : diff;
      });

      const distinctTypeRows = await dbQuery<{
        personnel_type_code: string;
        personnel_type_name: string;
      }>(
        `SELECT DISTINCT personnel_type_code, personnel_type_name
         FROM personnel
         WHERE is_active = 1 AND personnel_type_code <> ''
         UNION
         SELECT personnel_type_code, personnel_type_name FROM personnel_type_rules
         ORDER BY personnel_type_code ASC`
      );

      res.json({
        filters: { dateFrom, dateTo, department, personnelType, sortOrder },
        availablePersonnelTypes: distinctTypeRows.map((t) => ({
          code: t.personnel_type_code,
          name: t.personnel_type_name,
        })),
        kpi: aggregated.kpi,
        ranking: sortedRanking,
        departmentBreakdown: aggregated.departmentBreakdown,
        items: rows,
      });
    } catch (err) {
      next(err);
    }
  }
);

// B10. CSV Export with Formula Injection Protection
reportsRouter.get(
  '/reports/lateness/export.csv',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const { dateFrom, dateTo, department, personnelType, rows } = await queryFilteredAttendance(
        req.query as Record<string, unknown>
      );
      const aggregated = buildAggregation(rows);

      const headers = [
        'PERSON_ID',
        'ชื่อ-สกุล',
        'กลุ่มงาน/หน่วยงาน',
        'ประเภทบุคลากร',
        'จำนวนเวรทั้งหมด',
        'จำนวนครั้งที่สาย (Occurrences)',
        'นาทีสายรวม (Minutes)',
        'นาทีสายเฉลี่ยต่อครั้ง',
        'จำนวนครั้ง NO_SCAN',
        'จำนวนครั้ง MISSING_CHECKOUT',
      ];

      const csvLines = [headers.map(sanitizeCsvCell).join(',')];
      for (const r of aggregated.ranking) {
        csvLines.push(
          [
            r.personId,
            r.fullName,
            r.departmentName,
            r.personnelTypeName,
            r.totalShifts,
            r.lateOccurrences,
            r.totalLateMinutes,
            r.avgLateMinutesPerOccurrence,
            r.noScanCount,
            r.missingCheckoutCount,
          ]
            .map(sanitizeCsvCell)
            .join(',')
        );
      }

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'REPORT_LATENESS_EXPORT_CSV',
        targetType: 'REPORT',
        targetId: `${dateFrom}..${dateTo}`,
        result: 'SUCCESS',
        detail: { dateFrom, dateTo, department, personnelType, rowCount: aggregated.ranking.length },
      });

      const csvContent = '\uFEFF' + csvLines.join('\r\n');
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sam_att_lateness_${dateFrom}_${dateTo}.csv"`
      );
      res.send(csvContent);
    } catch (err) {
      next(err);
    }
  }
);

// B6. Native Multi-Sheet Excel Export for Lateness Report
reportsRouter.get(
  '/reports/lateness/export.xlsx',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const { dateFrom, dateTo, department, personnelType, rows } = await queryFilteredAttendance(
        req.query as Record<string, unknown>
      );
      const aggregated = buildAggregation(rows);

      const sheets: ExcelWorkbookSheetSpec[] = [
        {
          name: 'สรุปภาพรวม',
          title: 'รายงานสถิติการมาสาย — โรงพยาบาลสามชุก',
          subtitle: `ช่วงวันที่ ${dateFrom} ถึง ${dateTo}${department ? ` | หน่วยงาน: ${department}` : ''}`,
          headers: ['ตัวชี้วัด', 'จำนวน / ค่า', 'หน่วย'],
          rows: [
            ['จำนวนบุคลากรที่ประมวลผล', aggregated.kpi.evaluatedPersonnelCount, 'คน'],
            ['จำนวนเวรทั้งหมด', aggregated.kpi.totalShifts, 'เวร'],
            ['จำนวนบุคลากรที่มาสาย (ไม่ซ้ำ)', aggregated.kpi.latePeople, 'คน'],
            ['จำนวนครั้งที่มาสายรวม', aggregated.kpi.lateOccurrences, 'ครั้ง'],
            ['นาทีสายรวมทั้งหมด', aggregated.kpi.totalLateMinutes, 'นาที'],
            ['นาทีสายเฉลี่ยต่อครั้ง', aggregated.kpi.avgLateMinutesPerOccurrence, 'นาที/ครั้ง'],
            ['ไม่สแกน (NO_SCAN)', aggregated.kpi.noScanCount, 'รายการ'],
            ['ขาดสแกนออก (MISSING_CHECKOUT)', aggregated.kpi.missingCheckoutCount, 'รายการ'],
          ],
          autoFilter: false,
        },
        {
          name: 'อันดับการมาสายรายบุคคล',
          title: 'อันดับการมาสายรายบุคคล',
          subtitle: `ช่วงวันที่ ${dateFrom} ถึง ${dateTo}`,
          headers: [
            'รหัสบุคลากร',
            'ชื่อ-สกุล',
            'กลุ่มงาน/หน่วยงาน',
            'ประเภทบุคลากร',
            'เวรทั้งหมด',
            'ครั้งที่สาย',
            'นาทีสายรวม',
            'นาทีสายเฉลี่ยต่อครั้ง',
            'NO_SCAN',
            'ขาดสแกนออก',
          ],
          rows: aggregated.ranking.map((r) => [
            r.personId,
            r.fullName,
            r.departmentName,
            r.personnelTypeName,
            r.totalShifts,
            r.lateOccurrences,
            r.totalLateMinutes,
            r.avgLateMinutesPerOccurrence,
            r.noScanCount,
            r.missingCheckoutCount,
          ]),
        },
      ];

      const xlsxBuffer = buildWorkbookBuffer(sheets);
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'REPORT_LATENESS_EXPORT_XLSX',
        targetType: 'REPORT',
        targetId: `${dateFrom}..${dateTo}`,
        result: 'SUCCESS',
        detail: { dateFrom, dateTo, department, personnelType, rowCount: aggregated.ranking.length },
      });

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sam_att_lateness_${dateFrom}_${dateTo}.xlsx"`
      );
      res.send(xlsxBuffer);
    } catch (err) {
      next(err);
    }
  }
);

export const REPORT_CENTER_TYPES = [
  { key: 'SUMMARY', labelThai: '1. รายงานสรุปภาพรวมการปฏิบัติงาน', adminOnlyOrg: true },
  { key: 'DAILY_ATTENDANCE', labelThai: '2. รายงานลงเวลารายวันแบบละเอียด', adminOnlyOrg: true },
  { key: 'LATENESS', labelThai: '3. รายงานสถิติและอันดับการมาสาย', adminOnlyOrg: true },
  { key: 'EARLY_CHECKOUT', labelThai: '4. รายงานออกก่อนเวลากะ (Early Checkout)', adminOnlyOrg: true },
  { key: 'MISSING_SCANS', labelThai: '5. รายงานไม่สแกน / ขาดสแกนเข้า-ออก', adminOnlyOrg: true },
  { key: 'IN_PROGRESS_TODAY', labelThai: '6. รายงานผู้ปฏิบัติงานระหว่างกะวันนี้', adminOnlyOrg: true },
  { key: 'HOLIDAY_WORK', labelThai: '7. รายงานการปฏิบัติงานในวันหยุด', adminOnlyOrg: true },
  { key: 'HALF_DAY_LEAVE', labelThai: '8. รายงานการลาครึ่งวัน / ลาบางส่วน', adminOnlyOrg: true },
  { key: 'DEPARTMENT_SUMMARY', labelThai: '9. รายงานสรุปแยกตามกลุ่มงาน/หน่วยงาน', adminOnlyOrg: true },
  { key: 'HR_REVIEW_AUDIT', labelThai: '10. รายงานผลการตรวจสอบโดย HR', adminOnlyOrg: true },
  { key: 'OWN_ATTENDANCE', labelThai: '11. รายงานเวลาปฏิบัติงานส่วนบุคคล', adminOnlyOrg: false },
] as const;

const ALLOWED_REPORT_CENTER_KEYS = new Set<string>(REPORT_CENTER_TYPES.map((t) => t.key));

async function buildReportCenterDataset(params: {
  reportType: string;
  dateFrom: string;
  dateTo: string;
  department: string;
  personnelType: string;
  ownPersonId?: string | null;
}): Promise<{
  reportType: string;
  titleThai: string;
  subtitleThai: string;
  summaryRows: Array<{ metric: string; value: number | string; unit: string }>;
  headers: string[];
  rows: Array<Array<string | number>>;
}> {
  const bkk = getCurrentBangkokDateParts();
  const reportType = params.reportType.toUpperCase();
  const catalogMeta = REPORT_CENTER_TYPES.find((t) => t.key === reportType)!;
  const dateFrom = params.dateFrom;
  const dateTo = params.dateTo;
  const department = params.department;
  const personnelType = params.personnelType;
  const subtitleThai = `ช่วงวันที่ ${dateFrom} ถึง ${dateTo}${department ? ` | หน่วยงาน: ${department}` : ''}${personnelType ? ` | ประเภท: ${personnelType}` : ''}`;

  const conditions = ['a.work_date >= ?', 'a.work_date <= ?'];
  const sqlParams: unknown[] = [dateFrom, dateTo];
  if (params.ownPersonId) {
    conditions.push('a.person_id = ?');
    sqlParams.push(params.ownPersonId);
  }
  if (department) {
    conditions.push('p.department_name = ?');
    sqlParams.push(department);
  }
  if (personnelType) {
    conditions.push('p.personnel_type_code = ?');
    sqlParams.push(personnelType);
  }

  const attendanceRows = await dbQuery<
    AttendanceJoinedRow & {
      scheduled_start?: string | null;
      scheduled_end?: string | null;
      reviewed_by?: string | null;
      reviewed_at?: string | null;
      review_reason?: string | null;
      leave_type?: string | null;
      leave_start_time?: string | null;
      leave_end_time?: string | null;
    }
  >(
    `SELECT a.*, p.full_name, p.department_name, p.work_group_name,
            p.personnel_type_code, p.personnel_type_name
     FROM attendance a
     INNER JOIN personnel p ON p.person_id = a.person_id
     WHERE ${conditions.join(' AND ')}
     ORDER BY a.work_date DESC, p.department_name ASC, a.person_id ASC`,
    sqlParams
  );

  const agg = buildAggregation(attendanceRows);
  const baseSummary: Array<{ metric: string; value: number | string; unit: string }> = [
    { metric: 'จำนวนบุคลากรในรายงาน', value: agg.kpi.evaluatedPersonnelCount, unit: 'คน' },
    { metric: 'จำนวนเวรทั้งหมด', value: agg.kpi.totalShifts, unit: 'เวร' },
    { metric: 'ครบถ้วน (COMPLETE)', value: agg.kpi.completeCount, unit: 'รายการ' },
    { metric: 'มาสายรวม', value: agg.kpi.lateOccurrences, unit: 'ครั้ง' },
    { metric: 'นาทีสายรวม', value: agg.kpi.totalLateMinutes, unit: 'นาที' },
    { metric: 'ไม่สแกน / ขาดสแกนเข้า-ออก', value: agg.kpi.noScanCount + agg.kpi.missingCheckinCount + agg.kpi.missingCheckoutCount, unit: 'รายการ' },
    { metric: 'ออกก่อนเวลากะ', value: agg.kpi.earlyCheckoutCount, unit: 'รายการ' },
    { metric: 'รอ HR ตรวจสอบ', value: agg.kpi.pendingReviewCount, unit: 'รายการ' },
  ];

  const ymd = (v: unknown) => String(v || '').slice(0, 10);
  const hhmm = (v: unknown) => (v ? String(v).slice(11, 16) : '-');

  switch (reportType) {
    case 'SUMMARY': {
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: baseSummary,
        headers: ['หน่วยงาน', 'จำนวนเวร', 'จำนวนคนสาย', 'ครั้งที่สาย', 'นาทีสายรวม', 'ไม่สแกน (NO_SCAN)'],
        rows: agg.departmentBreakdown.map((d) => [
          d.departmentName,
          d.totalShifts,
          d.latePeople,
          d.lateOccurrences,
          d.totalLateMinutes,
          d.noScanCount,
        ]),
      };
    }

    case 'LATENESS': {
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: baseSummary,
        headers: [
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'ประเภทบุคลากร',
          'เวรทั้งหมด',
          'ครั้งที่สาย',
          'นาทีสายรวม',
          'นาทีสายเฉลี่ย/ครั้ง',
        ],
        rows: agg.ranking.map((r) => [
          r.personId,
          r.fullName,
          r.departmentName,
          r.personnelTypeName,
          r.totalShifts,
          r.lateOccurrences,
          r.totalLateMinutes,
          r.avgLateMinutesPerOccurrence,
        ]),
      };
    }

    case 'EARLY_CHECKOUT': {
      const filtered = attendanceRows.filter((r) => Number(r.early_checkout_indicator || 0) === 1);
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: [
          { metric: 'จำนวนรายการออกก่อนเวลากะ', value: filtered.length, unit: 'รายการ' },
          {
            metric: 'นาทีออกก่อนเวลารวม',
            value: filtered.reduce((sum, r) => sum + Number(r.early_checkout_minutes || 0), 0),
            unit: 'นาที',
          },
        ],
        headers: [
          'วันที่',
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'รหัสกะ',
          'เวลาเข้า',
          'เวลาออก',
          'ออกก่อน (นาที)',
          'สถานะตรวจ HR',
        ],
        rows: filtered.map((r) => [
          ymd(r.work_date),
          r.person_id,
          r.full_name,
          r.department_name,
          r.shift_code || '-',
          hhmm(r.check_in_time),
          hhmm(r.check_out_time),
          Number(r.early_checkout_minutes || 0),
          r.review_status,
        ]),
      };
    }

    case 'MISSING_SCANS': {
      const filtered = attendanceRows.filter((r) =>
        ['NO_SCAN', 'MISSING_CHECKIN', 'MISSING_CHECKOUT', 'PENDING_MAPPING'].includes(
          String(r.status || '').toUpperCase()
        )
      );
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: [
          { metric: 'ไม่สแกน / ขาดสแกนรวม', value: filtered.length, unit: 'รายการ' },
          { metric: 'NO_SCAN', value: agg.kpi.noScanCount, unit: 'รายการ' },
          { metric: 'MISSING_CHECKIN', value: agg.kpi.missingCheckinCount, unit: 'รายการ' },
          { metric: 'MISSING_CHECKOUT', value: agg.kpi.missingCheckoutCount, unit: 'รายการ' },
        ],
        headers: [
          'วันที่',
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'รหัสกะ',
          'สถานะ',
          'เวลาเข้า',
          'เวลาออก',
          'สถานะตรวจ HR',
        ],
        rows: filtered.map((r) => [
          ymd(r.work_date),
          r.person_id,
          r.full_name,
          r.department_name,
          r.shift_code || '-',
          r.status,
          hhmm(r.check_in_time),
          hhmm(r.check_out_time),
          r.review_status,
        ]),
      };
    }

    case 'IN_PROGRESS_TODAY': {
      const todayRows = attendanceRows.filter((r) => {
        if (ymd(r.work_date) !== bkk.todayYmd) return false;
        const lc = evaluateAttendanceLifecycle({
          workDate: bkk.todayYmd,
          scheduledStart: r.scheduled_start,
          scheduledEnd: r.scheduled_end,
          checkInTime: r.check_in_time,
          checkOutTime: r.check_out_time,
          status: r.status,
          attendanceStatus: r.attendance_status,
          isLate: r.is_late,
          lateMinutes: r.late_minutes,
          referenceNowBkk: bkk.nowDateTimeBkk,
        });
        return !lc.isFinalized;
      });
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai: `วันที่ ${bkk.todayYmd} (${bkk.nowDateTimeBkk.slice(11, 16)} น.)`,
        summaryRows: [{ metric: 'อยู่ระหว่างปฏิบัติงาน / รอสแกนวันนี้', value: todayRows.length, unit: 'รายการ' }],
        headers: [
          'วันที่',
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'กะ',
          'สถานะ',
          'สแกนเข้า',
          'สาย (นาที)',
        ],
        rows: todayRows.map((r) => [
          ymd(r.work_date),
          r.person_id,
          r.full_name,
          r.department_name,
          r.shift_code || '-',
          r.status,
          hhmm(r.check_in_time),
          Number(r.late_minutes || 0),
        ]),
      };
    }

    case 'HOLIDAY_WORK': {
      const holidays = await loadHospitalHolidaysForRange(dateFrom, dateTo);
      const holidayByDate = new Map<string, string[]>();
      for (const h of holidays) {
        const list = holidayByDate.get(h.holiday_date) || [];
        list.push(`${h.holiday_name} (${h.override_policy})`);
        holidayByDate.set(h.holiday_date, list);
      }
      const holidayAttendance = attendanceRows.filter((r) => holidayByDate.has(ymd(r.work_date)));
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: [
          { metric: 'จำนวนวันหยุดในช่วง', value: holidays.length, unit: 'วัน' },
          { metric: 'การปฏิบัติงานในวันหยุด', value: holidayAttendance.length, unit: 'เวร' },
        ],
        headers: [
          'วันที่',
          'ชื่อวันหยุด/นโยบาย',
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'รหัสกะ',
          'สแกนเข้า',
          'สแกนออก',
          'สถานะ',
        ],
        rows: holidayAttendance.map((r) => [
          ymd(r.work_date),
          (holidayByDate.get(ymd(r.work_date)) || []).join(', '),
          r.person_id,
          r.full_name,
          r.department_name,
          r.shift_code || '-',
          hhmm(r.check_in_time),
          hhmm(r.check_out_time),
          r.status,
        ]),
      };
    }

    case 'HALF_DAY_LEAVE': {
      const leaveConds = ["l.status = 'ACTIVE'", 'l.work_date >= ?', 'l.work_date <= ?'];
      const leaveParams: unknown[] = [dateFrom, dateTo];
      if (department) {
        leaveConds.push('p.department_name = ?');
        leaveParams.push(department);
      }
      if (personnelType) {
        leaveConds.push('p.personnel_type_code = ?');
        leaveParams.push(personnelType);
      }
      const leaves = await dbQuery<{
        work_date: string;
        person_id: string;
        full_name: string;
        department_name: string;
        leave_type: string;
        leave_start_time: string;
        leave_end_time: string;
        reason: string | null;
        created_by: string;
      }>(
        `SELECT l.work_date, l.person_id, p.full_name, p.department_name,
                l.leave_type, l.leave_start_time, l.leave_end_time, l.reason, l.created_by
         FROM attendance_leaves l
         INNER JOIN personnel p ON p.person_id = l.person_id
         WHERE ${leaveConds.join(' AND ')}
         ORDER BY l.work_date DESC, p.full_name ASC`,
        leaveParams
      );
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: [{ metric: 'จำนวนการลาครึ่งวัน/บางส่วนทั้งหมด', value: leaves.length, unit: 'รายการ' }],
        headers: ['วันที่', 'รหัสบุคลากร', 'ชื่อ-สกุล', 'หน่วยงาน', 'ประเภทการลา', 'ช่วงเวลา', 'เหตุผล', 'ผู้บันทึก'],
        rows: leaves.map((l) => [
          ymd(l.work_date),
          l.person_id,
          l.full_name,
          l.department_name,
          l.leave_type,
          `${l.leave_start_time}-${l.leave_end_time}`,
          l.reason || '-',
          l.created_by,
        ]),
      };
    }

    case 'DEPARTMENT_SUMMARY': {
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: [
          { metric: 'จำนวนกลุ่มงาน/หน่วยงาน', value: agg.departmentBreakdown.length, unit: 'หน่วยงาน' },
          ...baseSummary,
        ],
        headers: ['กลุ่มงาน/หน่วยงาน', 'จำนวนเวรทั้งหมด', 'จำนวนคนที่สาย', 'ครั้งที่สายรวม', 'นาทีสายรวม', 'จำนวน NO_SCAN'],
        rows: agg.departmentBreakdown.map((d) => [
          d.departmentName,
          d.totalShifts,
          d.latePeople,
          d.lateOccurrences,
          d.totalLateMinutes,
          d.noScanCount,
        ]),
      };
    }

    case 'HR_REVIEW_AUDIT': {
      const reviewConds = ['h.work_date >= ?', 'h.work_date <= ?'];
      const reviewParams: unknown[] = [dateFrom, dateTo];
      if (department) {
        reviewConds.push('p.department_name = ?');
        reviewParams.push(department);
      }
      const historyRows = await dbQuery<{
        work_date: string;
        person_id: string;
        full_name: string;
        department_name: string;
        previous_review_status: string;
        new_review_status: string;
        review_reason_category: string;
        review_comment: string;
        reviewed_by: string;
        reviewed_at: string;
      }>(
        `SELECT h.work_date, h.person_id, p.full_name, p.department_name,
                h.previous_review_status, h.new_review_status,
                h.review_reason_category, h.review_comment, h.reviewed_by, h.reviewed_at
         FROM hr_review_history h
         INNER JOIN personnel p ON p.person_id = h.person_id
         WHERE ${reviewConds.join(' AND ')}
         ORDER BY h.id DESC LIMIT 1000`,
        reviewParams
      );
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: [{ metric: 'จำนวนประวัติการตรวจสอบ HR', value: historyRows.length, unit: 'รายการ' }],
        headers: [
          'วันที่เวร',
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'สถานะเดิม',
          'สถานะใหม่',
          'หมวดเหตุผล',
          'ความเห็น HR',
          'ผู้ตรวจสอบ',
        ],
        rows: historyRows.map((h) => [
          ymd(h.work_date),
          h.person_id,
          h.full_name,
          h.department_name,
          h.previous_review_status,
          h.new_review_status,
          h.review_reason_category,
          h.review_comment,
          h.reviewed_by,
        ]),
      };
    }

    case 'OWN_ATTENDANCE':
    case 'DAILY_ATTENDANCE':
    default: {
      return {
        reportType,
        titleThai: catalogMeta.labelThai,
        subtitleThai,
        summaryRows: baseSummary,
        headers: [
          'วันที่',
          'รหัสบุคลากร',
          'ชื่อ-สกุล',
          'หน่วยงาน',
          'กะ',
          'สแกนเข้า',
          'สแกนออก',
          'สถานะ',
          'สาย (นาที)',
          'ออกก่อน (นาที)',
          'ผลตรวจ HR',
        ],
        rows: attendanceRows.map((r) => [
          ymd(r.work_date),
          r.person_id,
          r.full_name,
          r.department_name,
          r.shift_code || '-',
          hhmm(r.check_in_time),
          hhmm(r.check_out_time),
          r.status,
          Number(r.late_minutes || 0),
          Number(r.early_checkout_minutes || 0),
          r.review_status,
        ]),
      };
    }
  }
}

function resolveValidatedReportCenterParams(req: {
  query: Record<string, unknown>;
  user?: { role: string; approvedPersonId?: string | null };
}):
  | {
      errorStatus: number;
      errorCode: string;
      message: string;
    }
  | {
      reportType: string;
      dateFrom: string;
      dateTo: string;
      department: string;
      personnelType: string;
      ownPersonId: string | null;
    } {
  const bkk = getCurrentBangkokDateParts();
  const reportType = String(req.query.reportType || 'SUMMARY').trim().toUpperCase();
  if (!ALLOWED_REPORT_CENTER_KEYS.has(reportType)) {
    return {
      errorStatus: 400,
      errorCode: 'INVALID_REPORT_TYPE',
      message: `ไม่พบประเภทรายงาน ${reportType}`,
    };
  }

  const role = req.user?.role || 'GENERAL_USER';
  if (role === 'GENERAL_USER') {
    if (reportType !== 'OWN_ATTENDANCE') {
      return {
        errorStatus: 403,
        errorCode: 'FORBIDDEN',
        message: 'ผู้ใช้งานทั่วไปสามารถเรียกดูได้เฉพาะรายงานเวลาปฏิบัติงานส่วนบุคคล (OWN_ATTENDANCE) เท่านั้น',
      };
    }
    if (!req.user?.approvedPersonId) {
      return {
        errorStatus: 403,
        errorCode: 'PERSONNEL_MAPPING_REQUIRED',
        message: 'บัญชีของคุณยังไม่ได้ผูกรหัสบุคลากรจึงยังไม่สามารถดูรายงานส่วนบุคคลได้',
      };
    }
  }

  return {
    reportType,
    dateFrom: String(req.query.dateFrom || bkk.monthStartYmd).trim(),
    dateTo: String(req.query.dateTo || bkk.monthEndYmd).trim(),
    department: role === 'GENERAL_USER' ? '' : String(req.query.department || '').trim(),
    personnelType: role === 'GENERAL_USER' ? '' : String(req.query.personnelType || '').trim(),
    ownPersonId: role === 'GENERAL_USER' ? String(req.user!.approvedPersonId) : null,
  };
}

// B6. Unified 11-Report Center Preview
reportsRouter.get('/reports/center', requireAuth, async (req, res, next) => {
  try {
    const resolved = resolveValidatedReportCenterParams({
      query: req.query as Record<string, unknown>,
      user: req.user,
    });
    if ('errorStatus' in resolved) {
      res.status(resolved.errorStatus).json({
        error: resolved.errorCode,
        message: resolved.message,
        requestId: req.requestId,
      });
      return;
    }

    const dataset = await buildReportCenterDataset(resolved);
    const role = req.user!.role;
    const availableTypes = REPORT_CENTER_TYPES.filter((t) =>
      role === 'GENERAL_USER' ? !t.adminOnlyOrg : true
    );

    res.json({
      availableReportTypes: availableTypes,
      filters: {
        reportType: resolved.reportType,
        dateFrom: resolved.dateFrom,
        dateTo: resolved.dateTo,
        department: resolved.department,
        personnelType: resolved.personnelType,
      },
      ...dataset,
      totalRows: dataset.rows.length,
      requestId: req.requestId,
    });
  } catch (err) {
    next(err);
  }
});

// B6. Native Multi-Sheet Excel (.xlsx) Export for All 11 Report Types
reportsRouter.get('/reports/center/export.xlsx', requireAuth, async (req, res, next) => {
  try {
    const resolved = resolveValidatedReportCenterParams({
      query: req.query as Record<string, unknown>,
      user: req.user,
    });
    if ('errorStatus' in resolved) {
      res.status(resolved.errorStatus).json({
        error: resolved.errorCode,
        message: resolved.message,
        requestId: req.requestId,
      });
      return;
    }

    const dataset = await buildReportCenterDataset(resolved);
    const sheets: ExcelWorkbookSheetSpec[] = [
      {
        name: 'สรุปภาพรวม',
        title: `${dataset.titleThai} — โรงพยาบาลสามชุก`,
        subtitle: dataset.subtitleThai,
        headers: ['ตัวชี้วัดสรุป', 'ค่า / จำนวน', 'หน่วย'],
        rows: dataset.summaryRows.map((s) => [s.metric, s.value, s.unit]),
        autoFilter: false,
      },
      {
        name: 'รายละเอียดรายงาน',
        title: dataset.titleThai,
        subtitle: dataset.subtitleThai,
        headers: dataset.headers,
        rows: dataset.rows,
      },
    ];

    const xlsxBuffer = buildWorkbookBuffer(sheets);

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'REPORT_CENTER_EXPORT_XLSX',
      targetType: 'REPORT',
      targetId: `${resolved.reportType}:${resolved.dateFrom}..${resolved.dateTo}`,
      result: 'SUCCESS',
      detail: {
        reportType: resolved.reportType,
        dateFrom: resolved.dateFrom,
        dateTo: resolved.dateTo,
        department: resolved.department,
        rowCount: dataset.rows.length,
      },
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="sam_att_${resolved.reportType.toLowerCase()}_${resolved.dateFrom}_${resolved.dateTo}.xlsx"`
    );
    res.send(xlsxBuffer);
  } catch (err) {
    next(err);
  }
});

// B6. CSV Export for All 11 Report Types (UTF-8 BOM + Formula Injection Protection)
reportsRouter.get('/reports/center/export.csv', requireAuth, async (req, res, next) => {
  try {
    const resolved = resolveValidatedReportCenterParams({
      query: req.query as Record<string, unknown>,
      user: req.user,
    });
    if ('errorStatus' in resolved) {
      res.status(resolved.errorStatus).json({
        error: resolved.errorCode,
        message: resolved.message,
        requestId: req.requestId,
      });
      return;
    }

    const dataset = await buildReportCenterDataset(resolved);
    const lines = [
      dataset.headers.map(sanitizeCsvCell).join(','),
      ...dataset.rows.map((r) => r.map(sanitizeCsvCell).join(',')),
    ];

    await writeAuditLog({
      requestId: req.requestId,
      actorUsername: req.user!.username,
      actorRole: req.user!.role,
      ipAddress: req.ip || '127.0.0.1',
      action: 'REPORT_CENTER_EXPORT_CSV',
      targetType: 'REPORT',
      targetId: `${resolved.reportType}:${resolved.dateFrom}..${resolved.dateTo}`,
      result: 'SUCCESS',
      detail: {
        reportType: resolved.reportType,
        dateFrom: resolved.dateFrom,
        dateTo: resolved.dateTo,
        rowCount: dataset.rows.length,
      },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="sam_att_${resolved.reportType.toLowerCase()}_${resolved.dateFrom}_${resolved.dateTo}.csv"`
    );
    res.send('\uFEFF' + lines.join('\r\n'));
  } catch (err) {
    next(err);
  }
});
