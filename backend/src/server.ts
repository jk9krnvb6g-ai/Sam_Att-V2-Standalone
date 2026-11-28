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
import crypto from 'crypto';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { loadConfig, validateProductionConfig } from './config/env.ts';
import {
  runMigrations,
  ensureBaselineSystemCatalog,
  seedDemoSyntheticData,
  closeDatabaseConnections,
} from './database/adapter.ts';
import { reprocessAttendanceRange } from './modules/attendance/processor.ts';
import {
  startAutomaticScannerScheduler,
  stopAutomaticScannerScheduler,
} from './modules/scanners/scheduler.ts';
import { createExpressApp } from './app.ts';
import { appLogger } from './utils/logger.ts';

function encodeDerLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len <= 0xff) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, (len >> 8) & 0xff, len & 0xff]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeDerLength(content.length), content]);
}

function derSequence(items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derInteger(bytes: Buffer): Buffer {
  const normalized = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes;
  return derTag(0x02, normalized);
}

function derUtcTime(date: Date): Buffer {
  const yy = String(date.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mi = String(date.getUTCMinutes()).padStart(2, '0');
  const ss = String(date.getUTCSeconds()).padStart(2, '0');
  return derTag(0x17, Buffer.from(`${yy}${mm}${dd}${hh}${mi}${ss}Z`, 'ascii'));
}

function parseIpv4Bytes(ip: string): Buffer | null {
  const parts = ip.trim().split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(nums);
}

/**
 * สร้างใบรับรอง X.509 v3 Self-Signed และ RSA 2048-bit Private Key ด้วย Pure Node.js (`node:crypto`)
 * รองรับ SAN สำหรับ DNS:localhost, IP:127.0.0.1 และ IP:10.2.0.23 (หรือ IP เซิร์ฟเวอร์ที่ระบุ)
 */
export function generateSelfSignedX509CertAndKey(
  commonName = 'localhost',
  extraIpSans: string[] = ['10.2.0.23']
): { certPem: string; keyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sha256RsaAlgId = derSequence([
    derTag(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
    Buffer.from([0x05, 0x00]),
  ]);

  const rdnOrg = derSet([
    derSequence([
      derTag(0x06, Buffer.from([0x55, 0x04, 0x0a])),
      derTag(0x0c, Buffer.from('SamchukHospital', 'utf8')),
    ]),
  ]);
  const rdnCn = derSet([
    derSequence([
      derTag(0x06, Buffer.from([0x55, 0x04, 0x03])),
      derTag(0x0c, Buffer.from(commonName, 'utf8')),
    ]),
  ]);
  const nameSeq = derSequence([rdnOrg, rdnCn]);

  const now = new Date();
  const notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(now.getTime() + 3650 * 24 * 60 * 60 * 1000);
  const validitySeq = derSequence([derUtcTime(notBefore), derUtcTime(notAfter)]);

  // SubjectAltName (2.5.29.17): DNS:localhost, IP:127.0.0.1, plus extra IP SANs (e.g. 10.2.0.23)
  const sanEntries: Buffer[] = [
    derTag(0x82, Buffer.from('localhost', 'ascii')),
    derTag(0x87, Buffer.from([127, 0, 0, 1])),
  ];
  const seenIps = new Set<string>(['127.0.0.1']);
  for (const ip of extraIpSans) {
    if (!ip || seenIps.has(ip.trim())) continue;
    const ipBuf = parseIpv4Bytes(ip);
    if (ipBuf) {
      seenIps.add(ip.trim());
      sanEntries.push(derTag(0x87, ipBuf));
    }
  }
  const sanValue = derSequence(sanEntries);
  const sanExt = derSequence([
    derTag(0x06, Buffer.from([0x55, 0x1d, 0x11])),
    derTag(0x04, sanValue),
  ]);
  const extensions = derTag(0xa3, derSequence([sanExt]));

  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] &= 0x7f;
  if (serialBytes[0] === 0) serialBytes[0] = 1;

  const tbsCertificate = derSequence([
    derTag(0xa0, derTag(0x02, Buffer.from([0x02]))), // v3
    derInteger(serialBytes),
    sha256RsaAlgId,
    nameSeq,
    validitySeq,
    nameSeq,
    publicKey,
    extensions,
  ]);

  const signature = crypto.sign('sha256', tbsCertificate, privateKey);
  const certDer = derSequence([
    tbsCertificate,
    sha256RsaAlgId,
    derTag(0x03, Buffer.concat([Buffer.from([0x00]), signature])),
  ]);

  const b64Lines = certDer.toString('base64').match(/.{1,64}/g) || [];
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64Lines.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { certPem, keyPem: privateKey };
}

/**
 * ฟังก์ชันตรวจสอบไฟล์ใบรับรองความปลอดภัย HTTPS (server.crt และ server.key)
 * - หากมีไฟล์อยู่แล้วจะใช้งานไฟล์เดิมทันทีโดยไม่เขียนทับ
 * - ในโหมด Production ปกติ (เมื่อไม่ได้ระบุ allowExplicitGenerateInProduction) ห้ามสร้าง Self-Signed Certificate อัตโนมัติ
 *   เพื่อให้ validateProductionConfig() ทำงานแบบ Fail-Closed หากผู้ดูแลระบบยังไม่ได้วางใบรับรองใน D:\WebApps\Sam_Att\Certs
 */
export function ensureTlsCertificates(
  certPath: string,
  keyPath: string,
  nodeEnv = process.env.NODE_ENV || 'development',
  options?: { allowExplicitGenerateInProduction?: boolean; commonName?: string; extraIpSans?: string[] }
): void {
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return;
  }
  if (nodeEnv === 'production' && !options?.allowExplicitGenerateInProduction) {
    return;
  }
  const certDir = path.dirname(certPath);
  if (!fs.existsSync(certDir)) {
    fs.mkdirSync(certDir, { recursive: true, mode: 0o700 });
  }
  const keyDir = path.dirname(keyPath);
  if (!fs.existsSync(keyDir)) {
    fs.mkdirSync(keyDir, { recursive: true, mode: 0o700 });
  }

  const { certPem, keyPem } = generateSelfSignedX509CertAndKey(
    options?.commonName || '10.2.0.23',
    options?.extraIpSans || ['10.2.0.23']
  );
  fs.writeFileSync(certPath, certPem, { encoding: 'utf8' });
  fs.writeFileSync(keyPath, keyPem, { encoding: 'utf8', mode: 0o600 });

  try {
    fs.chmodSync(keyPath, 0o600);
  } catch {
    // ignore on platforms without POSIX chmod
  }
}

let shutdownHandlersRegistered = false;

export async function gracefulShutdownServers(
  signal: string,
  servers: { httpsServer?: https.Server; previewServer?: http.Server }
): Promise<void> {
  appLogger.info('SERVER_SHUTDOWN_INITIATED', `Received ${signal}. Stopping Sam_Att V2 Standalone gracefully...`, {
    signal,
  });
  stopAutomaticScannerScheduler();

  const closeServer = (srv?: http.Server | https.Server) =>
    new Promise<void>((resolve) => {
      if (!srv || !srv.listening) {
        resolve();
        return;
      }
      srv.close(() => resolve());
    });

  await Promise.all([closeServer(servers.httpsServer), closeServer(servers.previewServer)]);
  await closeDatabaseConnections();
  appLogger.info('SERVER_SHUTDOWN_COMPLETED', 'Sam_Att V2 Standalone shut down cleanly.', { signal });
}

/**
 * ฟังก์ชันเริ่มต้นการทำงานของเซิร์ฟเวอร์ Sam_Att V2 Standalone
 */
export async function startStandaloneServers(): Promise<{
  httpsServer: https.Server;
  previewServer?: http.Server;
}> {
  const cfg = loadConfig();

  // ขั้นตอนที่ 1: เตรียมใบรับรอง HTTPS เฉพาะโหมดพัฒนา/ทดสอบ (ในโหมด Production จะไม่สร้างใบรับรองอัตโนมัติ)
  ensureTlsCertificates(cfg.tlsCertPath, cfg.tlsKeyPath, cfg.nodeEnv);

  // ขั้นตอนที่ 2: ตรวจสอบความถูกต้องของค่าตั้งค่าและคู่ใบรับรอง TLS ก่อนเปิด Listener (Fail-Closed Production Validation)
  validateProductionConfig(cfg);

  // ขั้นตอนที่ 3: ตรวจสอบสถานะฐานข้อมูลแบบ Read-Only (MySQL Production/Standalone ห้ามแก้ Schema หรือ Insert ข้อมูลอัตโนมัติตอน Startup)
  await runMigrations({ startupReadOnlyOnMysql: true });
  await ensureBaselineSystemCatalog({ startupReadOnlyOnMysql: true });

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

  // ขั้นตอนที่ 4: เริ่มต้น Background Scheduler สำหรับดึงข้อมูลสแกนนิ้วอัตโนมัติ (ใน Production เริ่มในโหมด Standby เว้นแต่เปิด SCANNER_AUTO_SCHEDULER_ENABLED=true)
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
      const msg = `[Sam_Att V2 Standalone] HTTPS Single-Port Server listening at https://${cfg.host}:${cfg.port}${cfg.publicBasePath} and ${cfg.apiBasePath}`;
      console.log(msg);
      appLogger.info('SERVER_STARTED', msg, {
        nodeEnv: cfg.nodeEnv,
        dataMode: cfg.dataMode,
        port: cfg.port,
        dbEngine: cfg.dbEngine,
        scannerAutoSchedulerEnabled: cfg.scanner.autoSchedulerEnabled,
      });
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

  if (!shutdownHandlersRegistered && cfg.nodeEnv !== 'test') {
    shutdownHandlersRegistered = true;
    const onSignal = (sig: string) => {
      gracefulShutdownServers(sig, { httpsServer, previewServer })
        .catch(() => {})
        .finally(() => {
          process.exit(0);
        });
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }

  return { httpsServer, previewServer };
}
