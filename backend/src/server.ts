import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execFileSync } from 'child_process';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { loadConfig } from './config/env.ts';
import { runMigrations, seedBaselineAndSyntheticData } from './database/adapter.ts';
import { reprocessAttendanceRange } from './modules/attendance/processor.ts';
import { createExpressApp } from './app.ts';

export function ensureTlsCertificates(certPath: string, keyPath: string): void {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return;
  }
  const certDir = path.dirname(certPath);
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true });
  }
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    keyPath,
    '-out',
    certPath,
    '-days',
    '365',
    '-subj',
    '/C=TH/ST=Suphanburi/L=Samchuk/O=SamchukHospital/OU=IT/CN=localhost',
  ]);
}

export async function startStandaloneServers(): Promise<{
  httpsServer: https.Server;
  previewServer?: http.Server;
}> {
  const cfg = loadConfig();

  // Initialize database schema migrations and baseline seed in non-prod
  await runMigrations();
  if (cfg.nodeEnv !== 'production') {
    await seedBaselineAndSyntheticData();
    await reprocessAttendanceRange({
      dateFrom: '2026-11-12',
      dateTo: '2026-11-13',
      referenceNowBkk: '2026-11-13 18:00:00',
      actorUsername: 'system_startup',
    });
  }

  ensureTlsCertificates(cfg.tlsCertPath, cfg.tlsKeyPath);

  const distPath = path.resolve(process.cwd(), 'dist');
  const hasBuiltDist = fs.existsSync(path.join(distPath, 'index.html'));

  // Create primary Express app
  const app = createExpressApp({ serveStaticBuild: hasBuiltDist });

  // In development when dist isn't built or for live preview, also attach Vite middleware fallback
  if (cfg.nodeEnv !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    if (hasBuiltDist) {
      app.use('/Sam_Att', express.static(distPath));
    }
    app.use(vite.middlewares);
  }

  const tlsOptions = {
    key: fs.readFileSync(cfg.tlsKeyPath),
    cert: fs.readFileSync(cfg.tlsCertPath),
  };

  // 1. Primary Standalone Single-Port HTTPS Listener on Port 4101 (Frontend /Sam_Att/ + API /api/Sam_Att/*)
  const httpsServer = https.createServer(tlsOptions, app);
  await new Promise<void>((resolve) => {
    httpsServer.listen(cfg.port, cfg.host, () => {
      console.log(
        `[Sam_Att V2 Standalone] HTTPS Single-Port Server listening at https://${cfg.host}:${cfg.port}${cfg.publicBasePath} and ${cfg.apiBasePath}`
      );
      resolve();
    });
  });

  // 2. In AI Studio container environment, also bind Port 3000 so the live preview iframe works seamlessly
  let previewServer: http.Server | undefined;
  if (cfg.nodeEnv !== 'production' && cfg.previewHttpPort !== cfg.port) {
    previewServer = http.createServer(app);
    await new Promise<void>((resolve) => {
      previewServer!.listen(cfg.previewHttpPort, '0.0.0.0', () => {
        console.log(
          `[Sam_Att V2 Standalone] Preview bridge listening on http://0.0.0.0:${cfg.previewHttpPort}`
        );
        resolve();
      });
    });
  }

  return { httpsServer, previewServer };
}
