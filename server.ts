/**
 * ============================================================================
 * ไฟล์จุดเริ่มต้นหลักของเซิร์ฟเวอร์ (Main Server Entry Point)
 * ระบบบริหารเวลาปฏิบัติงานบุคลากร โรงพยาบาลสามชุก (Sam_Att V2 Standalone)
 * ============================================================================
 * หน้าที่ของไฟล์นี้:
 * - เรียกใช้ฟังก์ชัน startStandaloneServers() จากโฟลเดอร์ backend/src/server.ts
 * - เปิดให้บริการทั้งหน้าเว็บ (/Sam_Att/) และ Backend API (/api/Sam_Att/*)
 *   บนพอร์ต HTTPS 4101 พอร์ตเดียว โดยไม่ต้องพึ่งพา Central API Gateway
 * - หากเกิดข้อผิดพลาดร้ายแรงตอนเริ่มต้นระบบ จะแสดงข้อความแจ้งเตือนและจบโปรเซสด้วยรหัส 1
 */
import { startStandaloneServers } from './backend/src/server.ts';

startStandaloneServers().catch((err) => {
  console.error('[Sam_Att V2 Standalone] เกิดข้อผิดพลาดร้ายแรงขณะเริ่มต้นเซิร์ฟเวอร์:', err);
  process.exit(1);
});
