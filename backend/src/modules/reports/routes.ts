import { Router } from 'express';
import { loadConfig } from '../../config/env.ts';
import { dbQuery } from '../../database/adapter.ts';
import { sanitizeCsvCell, getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { writeAuditLog } from '../audit/service.ts';

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
  let completeCount = 0;
  let lateOccurrences = 0;
  let noScanCount = 0;
  let missingCheckinCount = 0;
  let missingCheckoutCount = 0;
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
    if (r.attendance_status === 'COMPLETE' || r.status === 'NORMAL' || r.status === 'LATE') {
      completeCount++;
    }
    if (r.status === 'NO_SCAN') noScanCount++;
    if (r.status === 'MISSING_CHECKIN' || r.attendance_status === 'MISSING_CHECKIN') {
      missingCheckinCount++;
    }
    if (r.status === 'MISSING_CHECKOUT') missingCheckoutCount++;
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
      completeCount,
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

      res.json({
        filters: { dateFrom, dateTo, department, personnelType, sortOrder },
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
