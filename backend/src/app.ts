/**
 * ============================================================================
 * โมดูลกำหนดเส้นทาง Express Application หลัก (Express App, Security Headers & Sanitized Error Handler)
 * ไฟล์: backend/src/app.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. กำหนด HTTP Security Headers ครบถ้วน: CSP, HSTS, X-Frame-Options, X-Content-Type-Options,
 *    Referrer-Policy และ Permissions-Policy (แก้ไขปัญหา P1 ข้อ 13)
 * 2. ผูกหมายเลขคำขอ (Request ID) เข้ากับทุก HTTP Request
 * 3. เปิดจุดตรวจสอบสถานะระบบ (Health Check) ที่ /api/Sam_Att/health
 * 4. ผูก Router ของทั้ง 8 โมดูลธุรกิจเข้ากับพาธ /api/Sam_Att/*
 * 5. เสิร์ฟไฟล์หน้าเว็บ React ที่ผ่านการ Build แล้ว (โฟลเดอร์ dist/) ที่พาธ /Sam_Att/
 * 6. ดักจับข้อผิดพลาดระดับระบบด้วยกลไก Fail-Closed และป้องกันการรั่วไหลของ Stack Trace
 *    หรือข้อมูลการเชื่อมต่อฐานข้อมูลสู่ผู้ใช้ (Error Leakage Prevention — แก้ไขปัญหา P1 ข้อ 14)
 */
import fs from 'fs';
import path from 'path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { loadConfig } from './config/env.ts';
import { dbQuery, DatabaseUnavailableError, ImmutableTableViolationError } from './database/adapter.ts';
import { attachRequestId } from './middleware/auth.ts';
import { authRouter } from './modules/auth/routes.ts';
import { personnelRouter } from './modules/personnel/routes.ts';
import { shiftsRouter } from './modules/shifts/routes.ts';
import { scannersRouter } from './modules/scanners/routes.ts';
import { attendanceRouter } from './modules/attendance/routes.ts';
import { reportsRouter } from './modules/reports/routes.ts';
import { hosofficeRouter } from './modules/hosoffice/routes.ts';
import { settingsRouter } from './modules/settings/routes.ts';

export function createExpressApp(options?: { serveStaticBuild?: boolean }): Express {
  const app = express();
  const cfg = loadConfig();

  // ปิดการแสดงชื่อซอฟต์แวร์เซิร์ฟเวอร์ใน Header เพื่อความปลอดภัย
  app.disable('x-powered-by');

  // แนบรหัสอ้างอิงคำขอ (X-Request-Id) และรองรับการรับข้อมูล JSON ขนาดสูงสุด 5MB
  app.use(attachRequestId);
  app.use(express.json({ limit: '5mb' }));

  // ตั้งค่า HTTP Security Headers มาตรฐานระดับองค์กร (แก้ไขปัญหา P1 ข้อ 13)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );

    if (req.secure || req.headers['x-forwarded-proto'] === 'https' || cfg.nodeEnv === 'production') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  /**
   * จุดตรวจสอบสถานะความพร้อมของระบบ (Public Health Endpoint: GET /api/Sam_Att/health)
   * ทดสอบการคิวรีฐานข้อมูลจริงด้วย SELECT 1 หากฐานข้อมูลล่มจะตอบกลับ HTTP 503 (FAIL_CLOSED)
   * โดยไม่เปิดเผยข้อมูล Host/Port/Password ของฐานข้อมูลแก่ผู้ใช้ภายนอก (แก้ไข P1 ข้อ 14)
   */
  app.get(`${cfg.apiBasePath}/health`, async (req: Request, res: Response) => {
    try {
      const check = await dbQuery<{ ok: number }>('SELECT 1 AS ok');
      res.status(200).json({
        status: 'OK',
        service: 'Sam_Att V2 Standalone',
        version: '2.0.0-standalone',
        targetNodeEngine: '26.13.1',
        runtimeNodeVersion: process.version,
        httpsPort: cfg.port,
        publicBasePath: cfg.publicBasePath,
        apiBasePath: cfg.apiBasePath,
        centralGatewayUsed: false,
        database: {
          connected: check.length > 0,
          engine: cfg.dbEngine,
          databaseName: cfg.samAttDb.database,
        },
        featureFlags: {
          scannerSyncEnabled: cfg.scanner.syncEnabled,
          scannerAutoSchedulerEnabled: cfg.scanner.autoSchedulerEnabled,
          hosofficeLivePushEnabled: cfg.hosofficePush.livePushEnabled,
        },
        requestId: req.requestId,
      });
    } catch (err: unknown) {
      console.error(`[HealthCheck Error][Ref:${req.requestId}]`, err);
      res.status(503).json({
        status: 'FAIL_CLOSED',
        error: 'DB_UNAVAILABLE',
        message: 'ไม่สามารถเชื่อมต่อฐานข้อมูลหลักของระบบได้ในขณะนี้ (Fail-Closed Mode)',
        centralGatewayUsed: false,
        requestId: req.requestId,
      });
    }
  });

  // ผูก Router ของทุกโมดูลเข้าภายใต้พาธ /api/Sam_Att
  const apiPrefix = cfg.apiBasePath;
  app.use(apiPrefix, authRouter);       // โมดูลเข้าสู่ระบบและจัดการผู้ใช้
  app.use(apiPrefix, personnelRouter);  // โมดูลทะเบียนบุคลากรและซิงก์ HOSOffice
  app.use(apiPrefix, shiftsRouter);     // โมดูลแม่แบบกะทำงานและมอบหมายตารางเวร
  app.use(apiPrefix, scannersRouter);   // โมดูลเครื่องสแกนและรับข้อมูลสแกนดิบ 6 ฟิลด์
  app.use(apiPrefix, attendanceRouter); // โมดูลตรวจสอบเวลาปฏิบัติงานและ Reprocess
  app.use(apiPrefix, reportsRouter);    // โมดูลรายงานสถิติการมาสายและส่งออก CSV
  app.use(apiPrefix, hosofficeRouter);  // โมดูลจำลองและส่งข้อมูลกลับ HOSOffice
  app.use(apiPrefix, settingsRouter);   // โมดูลตั้งค่าระบบ บันทึกความปลอดภัย และอัปเดต

  // กรณีเรียก API ที่ไม่มีอยู่ในระบบ ให้ตอบกลับ HTTP 404 แบบ JSON
  app.use(apiPrefix, (req: Request, res: Response) => {
    res.status(404).json({
      error: 'API_ENDPOINT_NOT_FOUND',
      message: `ไม่พบ API Endpoint: ${req.method} ${req.originalUrl}`,
      requestId: req.requestId,
    });
  });

  // เสิร์ฟไฟล์หน้าเว็บ Frontend ที่คอมไพล์แล้ว (โฟลเดอร์ dist/) ที่พาธ /Sam_Att/
  const distDir = path.resolve(process.cwd(), 'dist');
  if (options?.serveStaticBuild !== false && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use('/Sam_Att', express.static(distDir, { index: 'index.html' }));
    app.use('/', express.static(distDir, { index: 'index.html' }));

    app.get('/Sam_Att/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  /**
   * Middleware ดักจับข้อผิดพลาดส่วนกลาง (Global Fail-Closed & Error Sanitization Handler)
   * บันทึกรายละเอียดจริงและ Stack Trace ลง Server Log เท่านั้น ห้ามส่งออกไปให้ Client (แก้ไข P1 ข้อ 14)
   */
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DatabaseUnavailableError) {
      console.error(`[DB Unavailable][Ref:${req.requestId}] ${err.internalDiagnosticMessage}`);
      res.status(503).json({
        error: err.code,
        message: err.PublicSafeMessage,
        failClosed: true,
        requestId: req.requestId,
      });
      return;
    }

    if (err instanceof ImmutableTableViolationError) {
      res.status(409).json({
        error: err.code,
        message: err.message,
        requestId: req.requestId,
      });
      return;
    }

    console.error(`[Unhandled Server Error][Ref:${req.requestId}]`, err);
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message: `เกิดข้อผิดพลาดภายในระบบ กรุณาติดต่อผู้ดูแลระบบ (รหัสอ้างอิง: ${req.requestId})`,
      requestId: req.requestId,
    });
  });

  return app;
}
