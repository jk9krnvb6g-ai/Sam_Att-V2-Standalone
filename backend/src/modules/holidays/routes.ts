import { Router } from 'express';
import { dbQuery, dbExecute } from '../../database/adapter.ts';
import { requireAuth, requireRoles } from '../../middleware/auth.ts';
import { sanitizeCsvCell, getCurrentBangkokDateParts } from '../../utils/crypto.ts';
import { writeAuditLog } from '../audit/service.ts';
import { isPeriodClosed } from '../periods/lock.ts';
import { normalizeWorkDateString, type PublicHolidayRow } from '../shifts/routes.ts';
import { reprocessAttendanceRange } from '../attendance/processor.ts';

import {
  loadHospitalHolidaysForRange,
  mapLegacyHolidayTypeToCategory,
  type HospitalHolidayRow,
} from './service.ts';

export const holidaysRouter = Router();

export const ALLOWED_HOLIDAY_SCOPES = new Set(['ALL', 'DEPARTMENT', 'PERSON']);
export const ALLOWED_OVERRIDE_POLICIES = new Set([
  'EXEMPT',
  'EXEMPT_ALL',
  'WORK_WITH_OT',
  'MANDATORY_SHIFT',
]);

// GET /holidays — รายการวันหยุด (รองรับ year, dateFrom, dateTo, category, scopeType, department, personId)
holidaysRouter.get('/holidays', requireAuth, async (req, res, next) => {
  try {
    const bkk = getCurrentBangkokDateParts();
    const yearParam = String(req.query.year || '').trim();
    const dateFrom = req.query.dateFrom
      ? normalizeWorkDateString(req.query.dateFrom)
      : /^\d{4}$/.test(yearParam)
        ? `${yearParam}-01-01`
        : `${bkk.currentYear}-01-01`;
    const dateTo = req.query.dateTo
      ? normalizeWorkDateString(req.query.dateTo)
      : /^\d{4}$/.test(yearParam)
        ? `${yearParam}-12-31`
        : `${Number(bkk.currentYear) + 1}-12-31`;

    const includeInactive = req.query.includeInactive === '1' || req.query.includeInactive === 'true';
    const categoryFilter = String(req.query.category || '').trim().toUpperCase();
    const scopeFilter = String(req.query.scopeType || '').trim().toUpperCase();
    const departmentFilter = String(req.query.department || '').trim();
    const personFilter = String(req.query.personId || '').trim();

    let items = await loadHospitalHolidaysForRange(dateFrom, dateTo, { includeInactive });
    if (categoryFilter) {
      items = items.filter((i) => i.category === categoryFilter);
    }
    if (scopeFilter) {
      items = items.filter((i) => i.scope_type === scopeFilter);
    }
    if (departmentFilter) {
      items = items.filter(
        (i) => i.scope_type === 'ALL' || i.department_name === departmentFilter
      );
    }
    if (personFilter) {
      items = items.filter((i) => i.scope_type === 'ALL' || i.person_id === personFilter);
    }

    res.json({
      items,
      filters: { dateFrom, dateTo, year: yearParam || null, category: categoryFilter || null },
    });
  } catch (err) {
    next(err);
  }
});

// GET /holidays/export.csv — ส่งออกรายการวันหยุดเป็น CSV รองรับ UTF-8 BOM
holidaysRouter.get(
  '/holidays/export.csv',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const bkk = getCurrentBangkokDateParts();
      const yearParam = /^\d{4}$/.test(String(req.query.year || ''))
        ? String(req.query.year)
        : bkk.currentYear;
      const dateFrom = req.query.dateFrom
        ? normalizeWorkDateString(req.query.dateFrom)
        : `${yearParam}-01-01`;
      const dateTo = req.query.dateTo
        ? normalizeWorkDateString(req.query.dateTo)
        : `${yearParam}-12-31`;

      const items = await loadHospitalHolidaysForRange(dateFrom, dateTo);
      const headers = [
        'วันที่วันหยุด',
        'ชื่อวันหยุด',
        'ประเภทวันหยุด',
        'ขอบเขตผลบังคับ',
        'หน่วยงาน',
        'รหัสบุคลากร',
        'นโยบายจัดเวร',
        'สถานะ',
        'หมายเหตุ',
      ];
      const lines = [headers.map(sanitizeCsvCell).join(',')];
      for (const h of items) {
        lines.push(
          [
            h.holiday_date,
            h.holiday_name,
            h.category,
            h.scope_type,
            h.department_name || '-',
            h.person_id || '-',
            h.override_policy,
            Number(h.is_active) === 1 ? 'ใช้งาน' : 'ปิดใช้งาน',
            h.notes || '',
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
        action: 'HOLIDAY_EXPORT_CSV',
        targetType: 'HOSPITAL_HOLIDAY',
        targetId: `${dateFrom}..${dateTo}`,
        result: 'SUCCESS',
        detail: { rowCount: items.length },
      });

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="sam_att_holidays_${dateFrom}_${dateTo}.csv"`
      );
      res.send('\uFEFF' + lines.join('\r\n'));
    } catch (err) {
      next(err);
    }
  }
);

async function syncPublicHolidayMirror(params: {
  holidayDate: string;
  holidayName: string;
  category: string;
  scopeType: string;
  isActive: number;
  actorUsername: string;
}): Promise<void> {
  try {
    if (params.scopeType !== 'ALL') {
      return;
    }
    const existing = await dbQuery<{ id: number }>(
      'SELECT id FROM public_holidays WHERE holiday_date = ? LIMIT 1',
      [params.holidayDate]
    );
    if (existing.length > 0) {
      await dbExecute(
        `UPDATE public_holidays
         SET holiday_name = ?, holiday_type = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [params.holidayName, params.category, params.isActive, existing[0].id]
      );
    } else if (params.isActive === 1) {
      await dbExecute(
        `INSERT INTO public_holidays (holiday_date, holiday_name, holiday_type, is_active, created_by)
         VALUES (?, ?, ?, 1, ?)`,
        [params.holidayDate, params.holidayName, params.category, params.actorUsername]
      );
    }
  } catch {
    // Best-effort compatibility sync with legacy table
  }
}

function validateHolidayInput(body: Record<string, unknown>): {
  error?: string;
  holidayDate: string;
  holidayName: string;
  category: string;
  scopeType: string;
  departmentName: string | null;
  personId: string | null;
  overridePolicy: string;
  notes: string | null;
  isActive: number;
} {
  const holidayDate = normalizeWorkDateString(body?.holidayDate);
  const holidayName = String(body?.holidayName || '').trim();
  const rawCategory = String(body?.category || body?.holidayType || 'NATIONAL')
    .trim()
    .toUpperCase();
  const category = mapLegacyHolidayTypeToCategory(rawCategory);
  const scopeType = String(body?.scopeType || 'ALL').trim().toUpperCase();
  const departmentName = body?.departmentName ? String(body.departmentName).trim() : null;
  const personId = body?.personId ? String(body.personId).trim() : null;
  const overridePolicy = String(body?.overridePolicy || 'EXEMPT').trim().toUpperCase();
  const notes = body?.notes ? String(body.notes).trim() : null;
  const isActive = body?.isActive === false || body?.isActive === 0 ? 0 : 1;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(holidayDate) || !holidayName) {
    return {
      error: 'กรุณาระบุวันที่วันหยุด (YYYY-MM-DD) และชื่อวันหยุดให้ครบถ้วน',
      holidayDate,
      holidayName,
      category,
      scopeType,
      departmentName,
      personId,
      overridePolicy,
      notes,
      isActive,
    };
  }
  if (!ALLOWED_HOLIDAY_SCOPES.has(scopeType)) {
    return {
      error: 'ขอบเขตวันหยุดต้องเป็น ALL, DEPARTMENT หรือ PERSON เท่านั้น',
      holidayDate,
      holidayName,
      category,
      scopeType,
      departmentName,
      personId,
      overridePolicy,
      notes,
      isActive,
    };
  }
  if (scopeType === 'DEPARTMENT' && !departmentName) {
    return {
      error: 'กรุณาระบุชื่อหน่วยงานสำหรับวันหยุดเฉพาะหน่วยงาน',
      holidayDate,
      holidayName,
      category,
      scopeType,
      departmentName,
      personId,
      overridePolicy,
      notes,
      isActive,
    };
  }
  if (scopeType === 'PERSON' && !personId) {
    return {
      error: 'กรุณาระบุรหัสบุคลากรสำหรับวันหยุดเฉพาะบุคคล',
      holidayDate,
      holidayName,
      category,
      scopeType,
      departmentName,
      personId,
      overridePolicy,
      notes,
      isActive,
    };
  }
  if (!ALLOWED_OVERRIDE_POLICIES.has(overridePolicy)) {
    return {
      error: 'นโยบายวันหยุดไม่ถูกต้อง (EXEMPT, WORK_WITH_OT หรือ MANDATORY_SHIFT)',
      holidayDate,
      holidayName,
      category,
      scopeType,
      departmentName,
      personId,
      overridePolicy,
      notes,
      isActive,
    };
  }

  return {
    holidayDate,
    holidayName,
    category,
    scopeType,
    departmentName: scopeType === 'DEPARTMENT' ? departmentName : null,
    personId: scopeType === 'PERSON' ? personId : null,
    overridePolicy,
    notes,
    isActive,
  };
}

// POST /holidays — สร้างหรือบันทึกวันหยุดโรงพยาบาล
holidaysRouter.post(
  '/holidays',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const parsed = validateHolidayInput((req.body || {}) as Record<string, unknown>);
      if (parsed.error) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: parsed.error,
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(parsed.holidayDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถเพิ่มหรือแก้ไขวันหยุดในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      if (parsed.scopeType === 'PERSON' && parsed.personId) {
        const personExists = await dbQuery<{ person_id: string }>(
          'SELECT person_id FROM personnel WHERE person_id = ? LIMIT 1',
          [parsed.personId]
        );
        if (personExists.length === 0) {
          res.status(404).json({
            error: 'PERSONNEL_NOT_FOUND',
            message: `ไม่พบรหัสบุคลากร ${parsed.personId} ในระบบ`,
            requestId: req.requestId,
          });
          return;
        }
      }

      const existing = await dbQuery<HospitalHolidayRow>(
        `SELECT * FROM hospital_holidays
         WHERE holiday_date = ? AND scope_type = ?
           AND COALESCE(department_name, '') = COALESCE(?, '')
           AND COALESCE(person_id, '') = COALESCE(?, '')
         LIMIT 1`,
        [parsed.holidayDate, parsed.scopeType, parsed.departmentName, parsed.personId]
      );

      let holidayId: number;
      if (existing.length > 0) {
        holidayId = Number(existing[0].id);
        await dbExecute(
          `UPDATE hospital_holidays
           SET holiday_name = ?, category = ?, override_policy = ?, is_active = ?,
               notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            parsed.holidayName,
            parsed.category,
            parsed.overridePolicy,
            parsed.isActive,
            parsed.notes,
            req.user!.username,
            holidayId,
          ]
        );
      } else {
        const ins = await dbExecute(
          `INSERT INTO hospital_holidays (
            holiday_date, holiday_name, category, scope_type, department_name, person_id,
            override_policy, is_active, notes, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            parsed.holidayDate,
            parsed.holidayName,
            parsed.category,
            parsed.scopeType,
            parsed.departmentName,
            parsed.personId,
            parsed.overridePolicy,
            parsed.isActive,
            parsed.notes,
            req.user!.username,
            req.user!.username,
          ]
        );
        holidayId = Number(ins.insertId);
      }

      await syncPublicHolidayMirror({
        holidayDate: parsed.holidayDate,
        holidayName: parsed.holidayName,
        category: parsed.category,
        scopeType: parsed.scopeType,
        isActive: parsed.isActive,
        actorUsername: req.user!.username,
      });

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: existing.length > 0 ? 'HOSPITAL_HOLIDAY_UPDATED' : 'HOSPITAL_HOLIDAY_CREATED',
        targetType: 'HOSPITAL_HOLIDAY',
        targetId: String(holidayId),
        result: 'SUCCESS',
        detail: parsed,
      });

      res.status(201).json({
        id: holidayId,
        holidayDate: parsed.holidayDate,
        holidayName: parsed.holidayName,
        holidayType: parsed.category,
        category: parsed.category,
        scopeType: parsed.scopeType,
        departmentName: parsed.departmentName,
        personId: parsed.personId,
        overridePolicy: parsed.overridePolicy,
        notes: parsed.notes,
        isActive: parsed.isActive,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// PUT /holidays/:id — แก้ไขวันหยุดพร้อมตรวจเดือนปิดรอบ
holidaysRouter.put(
  '/holidays/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).json({ error: 'VALIDATION_ERROR', message: 'รหัสวันหยุดไม่ถูกต้อง' });
        return;
      }

      const existingRows = await dbQuery<HospitalHolidayRow>(
        'SELECT * FROM hospital_holidays WHERE id = ? LIMIT 1',
        [id]
      );
      if (existingRows.length === 0) {
        res.status(404).json({
          error: 'HOLIDAY_NOT_FOUND',
          message: 'ไม่พบข้อมูลวันหยุดที่ต้องการแก้ไข',
          requestId: req.requestId,
        });
        return;
      }
      const prev = existingRows[0];
      const parsed = validateHolidayInput({
        holidayDate: req.body?.holidayDate ?? prev.holiday_date,
        holidayName: req.body?.holidayName ?? prev.holiday_name,
        category: req.body?.category ?? prev.category,
        scopeType: req.body?.scopeType ?? prev.scope_type,
        departmentName:
          req.body?.departmentName !== undefined ? req.body.departmentName : prev.department_name,
        personId: req.body?.personId !== undefined ? req.body.personId : prev.person_id,
        overridePolicy: req.body?.overridePolicy ?? prev.override_policy,
        notes: req.body?.notes !== undefined ? req.body.notes : prev.notes,
        isActive: req.body?.isActive !== undefined ? req.body.isActive : prev.is_active,
      });

      if (parsed.error) {
        res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: parsed.error,
          requestId: req.requestId,
        });
        return;
      }

      const prevLock = await isPeriodClosed(prev.holiday_date);
      const nextLock = await isPeriodClosed(parsed.holidayDate);
      if (prevLock.closed || nextLock.closed) {
        const ym = prevLock.closed ? prevLock.periodYm : nextLock.periodYm;
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถแก้ไขวันหยุดในงวดเดือน ${ym} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: ym,
          requestId: req.requestId,
        });
        return;
      }

      await dbExecute(
        `UPDATE hospital_holidays
         SET holiday_date = ?, holiday_name = ?, category = ?, scope_type = ?,
             department_name = ?, person_id = ?, override_policy = ?, is_active = ?,
             notes = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          parsed.holidayDate,
          parsed.holidayName,
          parsed.category,
          parsed.scopeType,
          parsed.departmentName,
          parsed.personId,
          parsed.overridePolicy,
          parsed.isActive,
          parsed.notes,
          req.user!.username,
          id,
        ]
      );

      await syncPublicHolidayMirror({
        holidayDate: parsed.holidayDate,
        holidayName: parsed.holidayName,
        category: parsed.category,
        scopeType: parsed.scopeType,
        isActive: parsed.isActive,
        actorUsername: req.user!.username,
      });

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOSPITAL_HOLIDAY_UPDATED',
        targetType: 'HOSPITAL_HOLIDAY',
        targetId: String(id),
        result: 'SUCCESS',
        detail: { previousDate: normalizeWorkDateString(prev.holiday_date), ...parsed },
      });

      res.json({
        status: 'UPDATED',
        id,
        holidayDate: parsed.holidayDate,
        holidayName: parsed.holidayName,
        category: parsed.category,
        scopeType: parsed.scopeType,
        departmentName: parsed.departmentName,
        personId: parsed.personId,
        overridePolicy: parsed.overridePolicy,
        isActive: parsed.isActive,
        notes: parsed.notes,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);

// DELETE /holidays/:id — ปิดการใช้งานวันหยุด (Soft Deactivate)
holidaysRouter.delete(
  '/holidays/:id',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (id >= 1_000_000) {
        const legacyId = id - 1_000_000;
        const legacyRows = await dbQuery<PublicHolidayRow>(
          'SELECT * FROM public_holidays WHERE id = ? LIMIT 1',
          [legacyId]
        );
        if (legacyRows.length === 0) {
          res.status(404).json({ error: 'HOLIDAY_NOT_FOUND', message: 'ไม่พบข้อมูลวันหยุดที่ต้องการลบ' });
          return;
        }
        const lock = await isPeriodClosed(legacyRows[0].holiday_date);
        if (lock.closed) {
          res.status(409).json({
            error: 'PERIOD_CLOSED',
            message: `ไม่สามารถลบวันหยุดในงวดเดือน ${lock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
            periodYm: lock.periodYm,
          });
          return;
        }
        await dbExecute(
          'UPDATE public_holidays SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [legacyId]
        );
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'PUBLIC_HOLIDAY_DEACTIVATED',
          targetType: 'PUBLIC_HOLIDAY',
          targetId: String(legacyId),
          result: 'SUCCESS',
          detail: {
            holidayDate: normalizeWorkDateString(legacyRows[0].holiday_date),
            holidayName: legacyRows[0].holiday_name,
          },
        });
        res.json({ status: 'DEACTIVATED', id, requestId: req.requestId });
        return;
      }

      const existing = await dbQuery<HospitalHolidayRow>(
        'SELECT * FROM hospital_holidays WHERE id = ? LIMIT 1',
        [id]
      );
      if (existing.length > 0) {
        const hDate = normalizeWorkDateString(existing[0].holiday_date);
        const lock = await isPeriodClosed(hDate);
        if (lock.closed) {
          res.status(409).json({
            error: 'PERIOD_CLOSED',
            message: `ไม่สามารถลบวันหยุดในงวดเดือน ${lock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
            periodYm: lock.periodYm,
          });
          return;
        }
        await dbExecute(
          'UPDATE hospital_holidays SET is_active = 0, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [req.user!.username, id]
        );
        if (existing[0].scope_type === 'ALL') {
          await syncPublicHolidayMirror({
            holidayDate: hDate,
            holidayName: existing[0].holiday_name,
            category: existing[0].category,
            scopeType: 'ALL',
            isActive: 0,
            actorUsername: req.user!.username,
          });
        }
        await writeAuditLog({
          requestId: req.requestId,
          actorUsername: req.user!.username,
          actorRole: req.user!.role,
          ipAddress: req.ip || '127.0.0.1',
          action: 'HOSPITAL_HOLIDAY_DEACTIVATED',
          targetType: 'HOSPITAL_HOLIDAY',
          targetId: String(id),
          result: 'SUCCESS',
          detail: { holidayDate: hDate, holidayName: existing[0].holiday_name },
        });
        res.json({ status: 'DEACTIVATED', id, requestId: req.requestId });
        return;
      }

      // Fallback check on legacy public_holidays with raw id
      const phRows = await dbQuery<PublicHolidayRow>(
        'SELECT * FROM public_holidays WHERE id = ? LIMIT 1',
        [id]
      );
      if (phRows.length === 0) {
        res.status(404).json({
          error: 'HOLIDAY_NOT_FOUND',
          message: 'ไม่พบข้อมูลวันหยุดราชการที่ต้องการลบ',
          requestId: req.requestId,
        });
        return;
      }
      const phLock = await isPeriodClosed(phRows[0].holiday_date);
      if (phLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถลบวันหยุดในงวดเดือน ${phLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: phLock.periodYm,
        });
        return;
      }
      await dbExecute(
        'UPDATE public_holidays SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id]
      );
      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'PUBLIC_HOLIDAY_DEACTIVATED',
        targetType: 'PUBLIC_HOLIDAY',
        targetId: String(id),
        result: 'SUCCESS',
        detail: {
          holidayDate: normalizeWorkDateString(phRows[0].holiday_date),
          holidayName: phRows[0].holiday_name,
        },
      });
      res.json({ status: 'DEACTIVATED', id, requestId: req.requestId });
    } catch (err) {
      next(err);
    }
  }
);

async function resolveHolidayByIdOrDraft(
  idParam: string | number,
  draftBody?: Record<string, unknown>
): Promise<{
  id: number;
  holidayDate: string;
  holidayName: string;
  scopeType: string;
  departmentName: string | null;
  personId: string | null;
  overridePolicy: string;
} | null> {
  const numericId = Number(idParam);
  if (numericId > 0) {
    const rows = await dbQuery<HospitalHolidayRow>(
      'SELECT * FROM hospital_holidays WHERE id = ? LIMIT 1',
      [numericId]
    );
    if (rows.length > 0) {
      const r = rows[0];
      return {
        id: Number(r.id),
        holidayDate: normalizeWorkDateString(r.holiday_date),
        holidayName: r.holiday_name,
        scopeType: String(r.scope_type || 'ALL').toUpperCase(),
        departmentName: r.department_name || null,
        personId: r.person_id || null,
        overridePolicy: String(r.override_policy || 'EXEMPT').toUpperCase(),
      };
    }
  }
  if (draftBody && draftBody.holidayDate) {
    return {
      id: 0,
      holidayDate: normalizeWorkDateString(draftBody.holidayDate),
      holidayName: String(draftBody.holidayName || ''),
      scopeType: String(draftBody.scopeType || 'ALL').toUpperCase(),
      departmentName: draftBody.departmentName ? String(draftBody.departmentName).trim() : null,
      personId: draftBody.personId ? String(draftBody.personId).trim() : null,
      overridePolicy: String(draftBody.overridePolicy || 'EXEMPT').toUpperCase(),
    };
  }
  return null;
}

// POST /holidays/:id/impact-preview — พรีวิวผลกระทบต่อการลงเวลาและการประมวลผลย้อนหลัง
holidaysRouter.post(
  '/holidays/:id/impact-preview',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const target = await resolveHolidayByIdOrDraft(req.params.id, req.body);
      if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target.holidayDate)) {
        res.status(404).json({
          error: 'HOLIDAY_NOT_FOUND',
          message: 'ไม่พบวันหยุดหรือวันที่สำหรับวิเคราะห์ผลกระทบ',
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(target.holidayDate);
      const attConditions = ['a.work_date = ?'];
      const attParams: unknown[] = [target.holidayDate];
      if (target.scopeType === 'DEPARTMENT' && target.departmentName) {
        attConditions.push('p.department_name = ?');
        attParams.push(target.departmentName);
      } else if (target.scopeType === 'PERSON' && target.personId) {
        attConditions.push('a.person_id = ?');
        attParams.push(target.personId);
      }

      const affectedAttendance = await dbQuery<{
        id: number;
        person_id: string;
        full_name: string;
        department_name: string;
        shift_code: string | null;
        status: string;
        review_status: string;
      }>(
        `SELECT a.id, a.person_id, p.full_name, p.department_name, a.shift_code, a.status, a.review_status
         FROM attendance a
         INNER JOIN personnel p ON p.person_id = a.person_id
         WHERE ${attConditions.join(' AND ')}
         ORDER BY p.full_name ASC`,
        attParams
      );

      const shiftConditions = ['sa.work_date = ?', "sa.status = 'ACTIVE'"];
      const shiftParams: unknown[] = [target.holidayDate];
      if (target.scopeType === 'DEPARTMENT' && target.departmentName) {
        shiftConditions.push('p.department_name = ?');
        shiftParams.push(target.departmentName);
      } else if (target.scopeType === 'PERSON' && target.personId) {
        shiftConditions.push('sa.person_id = ?');
        shiftParams.push(target.personId);
      }
      const explicitShifts = await dbQuery<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM shift_assignments sa
         INNER JOIN personnel p ON p.person_id = sa.person_id
         WHERE ${shiftConditions.join(' AND ')}`,
        shiftParams
      );

      res.json({
        holiday: target,
        periodClosed: periodLock.closed,
        periodYm: periodLock.periodYm,
        affectedAttendanceCount: affectedAttendance.length,
        explicitShiftAssignmentCount: Number(explicitShifts[0]?.cnt || 0),
        reviewedRecordsCount: affectedAttendance.filter(
          (a) => a.review_status === 'REVIEWED' || a.review_status === 'VERIFIED_APPROVED'
        ).length,
        sampleAffectedAttendance: affectedAttendance.slice(0, 20),
        canReprocess: !periodLock.closed,
      });
    } catch (err) {
      next(err);
    }
  }
);

// POST /holidays/:id/reprocess — ประมวลผลเวลาใหม่ตามวันหยุด (บล็อกหากเดือนปิดรอบแล้ว)
holidaysRouter.post(
  '/holidays/:id/reprocess',
  requireAuth,
  requireRoles('ADMIN', 'RESPONSIBLE_STAFF'),
  async (req, res, next) => {
    try {
      const target = await resolveHolidayByIdOrDraft(req.params.id, req.body);
      if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target.holidayDate)) {
        res.status(404).json({
          error: 'HOLIDAY_NOT_FOUND',
          message: 'ไม่พบวันหยุดที่ต้องการประมวลผลเวลาใหม่',
          requestId: req.requestId,
        });
        return;
      }

      const periodLock = await isPeriodClosed(target.holidayDate);
      if (periodLock.closed) {
        res.status(409).json({
          error: 'PERIOD_CLOSED',
          message: `ไม่สามารถประมวลผลเวลาใหม่ในงวดเดือน ${periodLock.periodYm} ได้เนื่องจากปิดรอบบัญชีเวลาแล้ว`,
          periodYm: periodLock.periodYm,
          requestId: req.requestId,
        });
        return;
      }

      const result = await reprocessAttendanceRange({
        dateFrom: target.holidayDate,
        dateTo: target.holidayDate,
        personId: target.scopeType === 'PERSON' && target.personId ? target.personId : undefined,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        requestId: req.requestId,
        ipAddress: req.ip || '127.0.0.1',
      });

      await writeAuditLog({
        requestId: req.requestId,
        actorUsername: req.user!.username,
        actorRole: req.user!.role,
        ipAddress: req.ip || '127.0.0.1',
        action: 'HOLIDAY_REPROCESSED',
        targetType: 'HOSPITAL_HOLIDAY',
        targetId: String(target.id),
        result: 'SUCCESS',
        detail: {
          holidayDate: target.holidayDate,
          scopeType: target.scopeType,
          totalProcessed: result.totalProcessed,
          changedCount: result.changedCount,
        },
      });

      res.json({
        status: 'REPROCESSED',
        holiday: target,
        reprocessResult: result,
        requestId: req.requestId,
      });
    } catch (err) {
      next(err);
    }
  }
);
