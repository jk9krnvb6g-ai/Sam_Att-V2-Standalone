import fs from 'fs';
import path from 'path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { loadConfig } from './config/env.ts';
import { dbQuery, DatabaseUnavailableError } from './database/adapter.ts';
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

  app.disable('x-powered-by');
  app.use(attachRequestId);
  app.use(express.json({ limit: '5mb' }));

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // Public Health Endpoint under /api/Sam_Att/health
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
          hosofficeLivePushEnabled: cfg.hosofficePush.livePushEnabled,
        },
        requestId: req.requestId,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(503).json({
        status: 'FAIL_CLOSED',
        error: 'DB_UNAVAILABLE',
        message: msg,
        centralGatewayUsed: false,
        requestId: req.requestId,
      });
    }
  });

  // Mount all domain routers under /api/Sam_Att
  const apiPrefix = cfg.apiBasePath;
  app.use(apiPrefix, authRouter);
  app.use(apiPrefix, personnelRouter);
  app.use(apiPrefix, shiftsRouter);
  app.use(apiPrefix, scannersRouter);
  app.use(apiPrefix, attendanceRouter);
  app.use(apiPrefix, reportsRouter);
  app.use(apiPrefix, hosofficeRouter);
  app.use(apiPrefix, settingsRouter);

  // Unknown API endpoint handler
  app.use(apiPrefix, (req: Request, res: Response) => {
    res.status(404).json({
      error: 'API_ENDPOINT_NOT_FOUND',
      message: `ไม่พบ API Endpoint: ${req.method} ${req.originalUrl}`,
      requestId: req.requestId,
    });
  });

  // Serve Production Frontend Static Build at /Sam_Att/ (and root fallback) when enabled
  const distDir = path.resolve(process.cwd(), 'dist');
  if (options?.serveStaticBuild !== false && fs.existsSync(path.join(distDir, 'index.html'))) {
    app.use('/Sam_Att', express.static(distDir, { index: 'index.html' }));
    app.use('/', express.static(distDir, { index: 'index.html' }));

    app.get('/Sam_Att/*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  // Global Fail-Closed Error Middleware
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DatabaseUnavailableError) {
      res.status(503).json({
        error: err.code,
        message: err.message,
        failClosed: true,
        requestId: req.requestId,
      });
      return;
    }

    const message = err instanceof Error ? err.message : 'เกิดข้อผิดพลาดภายในระบบ';
    res.status(500).json({
      error: 'INTERNAL_SERVER_ERROR',
      message,
      requestId: req.requestId,
    });
  });

  return app;
}
