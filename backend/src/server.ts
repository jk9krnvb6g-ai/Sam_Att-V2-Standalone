/**
 * ============================================================================
 * โมดูลจัดการเซิร์ฟเวอร์หลัก (Standalone HTTPS Server Bootstrapper)
 * ไฟล์: backend/src/server.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. โหลดค่าตั้งค่าจากไฟล์ .env ผ่านฟังก์ชัน loadConfig()
 * 2. รันสคริปต์สร้างตารางฐานข้อมูลอัตโนมัติ (runMigrations)
 * 3. ในโหมดพัฒนา/ทดสอบ (ไม่ใช่ Production) จะเติมข้อมูลทดสอบเริ่มต้น (seedBaselineAndSyntheticData)
 * 4. ตรวจสอบและสร้างใบรับรองความปลอดภัย HTTPS (Self-Signed TLS Certificate) หากยังไม่มี
 * 5. เปิดเซิร์ฟเวอร์ HTTPS พอร์ต 4101 พอร์ตเดียวสำหรับให้บริการทั้ง Frontend (/Sam_Att/) และ API (/api/Sam_Att/*)
 */
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

/**
 * ฟังก์ชันตรวจสอบไฟล์ใบรับรองความปลอดภัย HTTPS (server.crt และ server.key)
 * หากยังไม่มีไฟล์ใบรับรองในโฟลเดอร์ certs/ ระบบจะเรียกใช้ openssl เพื่อสร้างใบรับรองอัตโนมัติ
 */
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

/**
 * ฟังก์ชันเริ่มต้นการทำงานของเซิร์ฟเวอร์ Sam_Att V2 Standalone
 */
export async function startStandaloneServers(): Promise<{
  httpsServer: https.Server;
  previewServer?: http.Server;
}> {
  const cfg = loadConfig();

  // ขั้นตอนที่ 1: รันสร้างตารางฐานข้อมูลทั้งหมด 20 ตาราง และเติมข้อมูลตัวอย่างเฉพาะในโหมดพัฒนา
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

  // ขั้นตอนที่ 2: ตรวจสอบความพร้อมของใบรับรอง HTTPS (TLS)
  ensureTlsCertificates(cfg.tlsCertPath, cfg.tlsKeyPath);

  const distPath = path.resolve(process.cwd(), 'dist');
  const hasBuiltDist = fs.existsSync(path.join(distPath, 'index.html'));

  // ขั้นตอนที่ 3: สร้างอินสแตนซ์ของ Express Application
  const app = createExpressApp({ serveStaticBuild: hasBuiltDist });

  // ขั้นตอนที่ 4: ในโหมดพัฒนา (Development) ให้เชื่อมต่อ Vite Middleware เพื่อคอมไพล์หน้าเว็บแบบสด
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

  // ขั้นตอนที่ 5: เปิดพอร์ตหลัก HTTPS 4101 (ให้บริการทั้งหน้าเว็บ /Sam_Att/ และ API /api/Sam_Att/*)
  const httpsServer = https.createServer(tlsOptions, app);
  await new Promise<void>((resolve) => {
    httpsServer.listen(cfg.port, cfg.host, () => {
      console.log(
        `[Sam_Att V2 Standalone] HTTPS Single-Port Server listening at https://${cfg.host}:${cfg.port}${cfg.publicBasePath} and ${cfg.apiBasePath}`
      );
      resolve();
    });
  });

  // ขั้นตอนที่ 6: ในสภาพแวดล้อมพรีวิว (Port 3000) เปิด HTTP Bridge เพื่อให้หน้าจอ Preview ทำงานได้ทันที
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
