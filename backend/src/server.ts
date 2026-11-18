/**
 * ============================================================================
 * โมดูลจัดการเซิร์ฟเวอร์หลัก (Standalone HTTPS Server Bootstrapper)
 * ไฟล์: backend/src/server.ts
 * ============================================================================
 * หน้าที่หลัก:
 * 1. โหลดและตรวจสอบค่าตั้งค่าจากไฟล์ .env ผ่าน `loadConfig()` และ `validateProductionConfig()`
 *    หากในโหมด Production ตั้งค่าไม่ครบหรือใช้ Secret ไม่ปลอดภัยจะหยุดทำงานแบบ Fail-Closed ทันที (แก้ไข P1 ข้อ 15)
 * 2. รันสคริปต์สร้างตารางฐานข้อมูลอัตโนมัติ (`runMigrations`)
 * 3. ในโหมดพัฒนา/ทดสอบ (ไม่ใช่ Production) จะเติมข้อมูลทดสอบเริ่มต้นและสร้างใบรับรองชั่วคราวใน `os.tmpdir()`
 *    (ไม่สร้างไฟล์ `.key` หรือ `.sqlite` ทิ้งไว้ในโฟลเดอร์ Git Repository — แก้ไข P0 ข้อ 01–02)
 * 4. เริ่มต้นการทำงานของระบบตั้งเวลาซิงก์เครื่องสแกนอัตโนมัติ (`startAutomaticScannerScheduler` — แก้ไข P1 ข้อ 09)
 * 5. เปิดเซิร์ฟเวอร์ HTTPS พอร์ต 4101 พอร์ตเดียวสำหรับให้บริการทั้ง Frontend (/Sam_Att/) และ API (/api/Sam_Att/*)
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';
import { execFileSync } from 'child_process';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { loadConfig, validateProductionConfig } from './config/env.ts';
import {
  runMigrations,
  ensureBaselineSystemCatalog,
  seedDemoSyntheticData,
} from './database/adapter.ts';
import { reprocessAttendanceRange } from './modules/attendance/processor.ts';
import { startAutomaticScannerScheduler } from './modules/scanners/scheduler.ts';
import { createExpressApp } from './app.ts';

/**
 * ฟังก์ชันตรวจสอบไฟล์ใบรับรองความปลอดภัย HTTPS (server.crt และ server.key)
 * - ในโหมด Production: บังคับให้ต้องมีไฟล์ใบรับรองจริงที่จัดเก็บนอก Repository อยู่แล้ว ห้ามสร้างเองอัตโนมัติ (Fail-Closed)
 * - ในโหมด Development/Test: สร้างใบรับรองชั่วคราวใน `os.tmpdir()` พร้อมกำหนดสิทธิ์ไฟล์ `0o600` (เฉพาะเจ้าของโปรเซส)
 */
export function ensureTlsCertificates(certPath: string, keyPath: string, nodeEnv = process.env.NODE_ENV || 'development'): void {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return;
  }
  if (nodeEnv === 'production') {
    throw new Error(
      `MISSING_PRODUCTION_TLS_CERT: ไม่พบไฟล์ใบรับรอง TLS สำหรับโหมดใช้งานจริงที่ ${certPath} หรือ ${keyPath}`
    );
  }
  const certDir = path.dirname(certPath);
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  }

  const opensslArgs = [
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
  ];

  const candidateOpenSslBins = [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\openssl.exe',
  ];

  let generated = false;
  for (const bin of candidateOpenSslBins) {
    try {
      execFileSync(bin, opensslArgs, { stdio: 'ignore' });
      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        generated = true;
        break;
      }
    } catch {
      // try next candidate
    }
  }

  if (!generated) {
    const localCert = path.resolve(process.cwd(), 'certs', 'server.crt');
    const localKey = path.resolve(process.cwd(), 'certs', 'server.key');
    if (fs.existsSync(localCert) && fs.existsSync(localKey)) {
      fs.copyFileSync(localCert, certPath);
      fs.copyFileSync(localKey, keyPath);
      generated = true;
    }
  }

  if (!generated) {
    throw new Error(`OPENSSL_UNAVAILABLE: Unable to generate test TLS certificate at ${certPath}`);
  }

  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
}

/**
 * ฟังก์ชันเริ่มต้นการทำงานของเซิร์ฟเวอร์ Sam_Att V2 Standalone
 */
export async function startStandaloneServers(): Promise<{
  httpsServer: https.Server;
  previewServer?: http.Server;
}> {
  const cfg = loadConfig();

  // ขั้นตอนที่ 1: ตรวจสอบความถูกต้องของค่าตั้งค่าก่อนเปิด Listener (Fail-Closed Production Validation — แก้ไข P1 ข้อ 15)
  validateProductionConfig(cfg);

  // ขั้นตอนที่ 2: ตรวจสอบความพร้อมของใบรับรอง HTTPS (TLS)
  ensureTlsCertificates(cfg.tlsCertPath, cfg.tlsKeyPath, cfg.nodeEnv);

  // ขั้นตอนที่ 3: รันสร้างตารางฐานข้อมูลทั้งหมด และเตรียมข้อมูลตั้งต้นที่จำเป็นของระบบ (System Baseline Catalog)
  // ห้ามเติมข้อมูลจำลอง (Synthetic Data) ในโหมด REAL หรือ Production เด็ดขาด
  await runMigrations();
  await ensureBaselineSystemCatalog();

  if (cfg.dataMode === 'DEMO' && cfg.nodeEnv !== 'production' && cfg.dbEngine === 'sqlite_sandbox') {
    const demoSeed = await seedDemoSyntheticData();
    if (demoSeed.seeded) {
      await reprocessAttendanceRange({
        dateFrom: '2026-11-12',
        dateTo: '2026-11-13',
        referenceNowBkk: '2026-11-13 18:00:00',
        actorUsername: 'system_demo_startup',
      });
    }
  }

  // ขั้นตอนที่ 4: เริ่มต้น Background Scheduler สำหรับดึงข้อมูลสแกนนิ้วอัตโนมัติตามตาราง sync_schedules (00:00 และ 08:00 น.)
  startAutomaticScannerScheduler();

  const distPath = path.resolve(process.cwd(), 'dist');
  const hasBuiltDist = fs.existsSync(path.join(distPath, 'index.html'));

  // ขั้นตอนที่ 5: สร้างอินสแตนซ์ของ Express Application
  const app = createExpressApp({ serveStaticBuild: hasBuiltDist });

  // ขั้นตอนที่ 6: ในโหมดพัฒนา (Development) ให้เชื่อมต่อ Vite Middleware
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

  // ขั้นตอนที่ 7: เปิดพอร์ตหลัก HTTPS 4101 (ให้บริการทั้งหน้าเว็บ /Sam_Att/ และ API /api/Sam_Att/*)
  const httpsServer = https.createServer(tlsOptions, app);
  await new Promise<void>((resolve) => {
    httpsServer.listen(cfg.port, cfg.host, () => {
      console.log(
        `[Sam_Att V2 Standalone] HTTPS Single-Port Server listening at https://${cfg.host}:${cfg.port}${cfg.publicBasePath} and ${cfg.apiBasePath}`
      );
      resolve();
    });
  });

  // ขั้นตอนที่ 8: ในสภาพแวดล้อมพรีวิว (Port 3000) เปิด HTTP Bridge เพื่อให้หน้าจอ Preview ทำงานได้ทันที
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
