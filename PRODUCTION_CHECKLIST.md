# รายการตรวจสอบความพร้อมก่อนเปิดใช้งานจริง (`PRODUCTION_CHECKLIST.md`)

ใช้รายการตรวจสอบนี้เพื่อยืนยันความพร้อมของระบบ **Sam_Att V2 Standalone** บนเครื่องแม่ข่าย **Windows Server 2025 (`10.2.0.23`)**

---

## 1. โครงสร้างพื้นฐานและเครื่องแม่ข่าย (`10.2.0.23`)
- [ ] ระบบปฏิบัติการเป็น Windows Server 2025 Standard Evaluation (`10.2.0.23`)
- [ ] Timezone ตั้งเป็น `SE Asia Standard Time` (`UTC+07:00` / `Asia/Bangkok`)
- [ ] โฟลเดอร์มาตรฐานถูกสร้างครบถ้วน:
  - [ ] `D:\WebApps\Sam_Att\App`
  - [ ] `D:\WebApps\Sam_Att\Config`
  - [ ] `D:\WebApps\Sam_Att\Logs`
  - [ ] `D:\WebApps\Sam_Att\Service`
  - [ ] `D:\WebApps\Sam_Att\Certs`
  - [ ] `D:\Backups\Sam_Att`
  - [ ] `D:\Deployments\Sam_Att`
- [ ] ติดตั้ง Node.js LTS, Git for Windows, .NET Framework 4.8 และ WinSW เรียบร้อยแล้ว

## 2. การตั้งค่าความปลอดภัยและใบรับรอง HTTPS
- [ ] ไฟล์ `D:\WebApps\Sam_Att\Config\.env` กำหนด `NODE_ENV=production`
- [ ] `JWT_SECRET` มีความยาวอย่างน้อย 24 ตัวอักษร และไม่ใช่ค่า Default
- [ ] `INITIAL_ADMIN_PASSWORD` มีความยาวอย่างน้อย 10 ตัวอักษร และไม่ใช่ค่า Default
- [ ] ไฟล์ `D:\WebApps\Sam_Att\Certs\cert.pem` และ `key.pem` ผ่านการตรวจสอบคู่กุญแจและยังไม่หมดอายุ
- [ ] Windows Firewall เปิด Inbound Rule `Sam_Att V2 HTTPS 4101` (TCP Port `4101`)

## 3. ความปลอดภัยฐานข้อมูล MySQL (`10.1.0.201:3306`)
- [ ] ทดสอบ `Test-NetConnection -ComputerName 10.1.0.201 -Port 3306` สำเร็จ
- [ ] รัน `npm run db:preflight` ผ่านทั้งหมด (`"ok": true`, `"readOnlyMode": true`, ครบ 16 ตารางหลัก, `"missingTables": []`, `"missingColumns": []`)
- [ ] ยืนยันว่าระบบไม่ได้รัน Auto-Migration หรือแก้ไขข้อมูลใด ๆ ตอน Startup

## 4. สถานะเครื่องสแกนลายนิ้วมือ (Scanner Standby Mode)
- [ ] ขณะที่เซิร์ฟเวอร์เดิม (`10.2.0.13`) ยังทำงานอยู่ ต้องตั้งค่า `SCANNER_AUTO_SCHEDULER_ENABLED=false` บน `10.2.0.23`
- [ ] คอมไพล์ `ScannerReader.exe` (32-bit x86) เรียบร้อยแล้ว

## 5. การทำงานของ Windows Service และ Health Checks
- [ ] Windows Service `SamAttV2Standalone` มีสถานะ `Running` และตั้งเป็น `Automatic (Delayed Start)`
- [ ] รัน `.\HealthCheck_Sam_Att.ps1` ผ่านทุกข้อ:
  - [ ] `GET https://10.2.0.23:4101/api/Sam_Att/health/live` -> HTTP 200 (`"status": "alive"`)
  - [ ] `GET https://10.2.0.23:4101/api/Sam_Att/health/ready` -> HTTP 200 (`"status": "ready"`)
  - [ ] `GET https://10.2.0.23:4101/api/Sam_Att/health` -> HTTP 200 (`"status": "ok"`)
  - [ ] `GET https://10.2.0.23:4101/Sam_Att/` -> HTTP 200 (โหลดหน้าเว็บ SPA สำเร็จ)
