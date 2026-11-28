# รายงานผลการทดสอบระบบและความพร้อมก่อนติดตั้งจริง (`PHASE2_TEST_REPORT.md`)

**โครงการ:** ระบบบันทึกเวลาปฏิบัติงานและประมวลผลเวร (Sam_Att V2 Standalone)  
**รุ่นการทดสอบ:** Phase 2 Final Production Readiness Hotfix (`FIX 01` – `FIX 08`)

---

## 1. การแยกแยะสภาพแวดล้อมการทดสอบตามความจริง (Test Environment Transparency — FIX 08)

เพื่อให้ผู้ดูแลระบบโรงพยาบาลสามชุกทราบขอบเขตการทดสอบอย่างโปร่งใสและตรงไปตรงมา รายงานนี้แยกผลการทดสอบออกเป็น 3 ส่วนชัดเจน ดังนี้:

| สภาพแวดล้อม | สถานะการรัน | สิ่งที่ได้รับการทดสอบและยืนยันแล้ว |
| :--- | :---: | :--- |
| **1. Linux Sandbox Automated Verification** (ในสภาพแวดล้อม Build/Test ปัจจุบัน) | **รันจริงแล้ว (PASS 100%)** | - `npm run typecheck` และ `npm run lint` (`tsc --noEmit` ผ่าน 0 errors)<br>- `npm run build` (`vite build` สร้าง Production Bundle สำเร็จ)<br>- `npm test` (รันชุดทดสอบอัตโนมัติทั้งหมด 14 ไฟล์ทดสอบ ผ่านครบ 100% บน Isolated SQLite Sandbox ใน `os.tmpdir()`)<br>- ทดสอบ Lossless `.env` Password Quoting/Parsing สำหรับรหัสผ่านที่มี `#`, `$`, `&`, Quotes และช่องว่าง<br>- ทดสอบ Read-Only Database Startup & Preflight Guard (ยืนยัน 0 DDL/DML ในโหมด Production)<br>- ทดสอบ X.509 Certificate + Private Key Matching, IP SAN `10.2.0.23` และ Strict TLS Handshake<br>- ตรวจสอบโครงสร้าง 7-bit ASCII และกฎความปลอดภัยของไฟล์ `.ps1` ทั้ง 14 ไฟล์ |
| **2. GitHub Actions Windows Runner (`windows-latest`)** (กำหนดใน `.github/workflows/ci.yml`) | **กำหนดใน CI Workflow พร้อมทำงานอัตโนมัติเมื่อ Push ขึ้น GitHub** | - รัน `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` บน Windows Server Runner<br>- ตรวจสอบไวยากรณ์ PowerShell 5.1 ด้วย `[System.Management.Automation.Language.Parser]::ParseFile` ทุกสคริปต์<br>- ทดสอบ `Install_Sam_Att.ps1 -DryRun` (ยืนยันไม่ทิ้งไฟล์หรือ `lifecycle.lock`)<br>- ทดสอบ `HealthCheck_Sam_Att.ps1 -SkipServiceCheck` (ยืนยัน Fail-Closed เมื่อไม่ระบุ `-DiagnosticMode`)<br>- ทดสอบ `Backup_Sam_Att.ps1` และ `Rollback_Sam_Att.ps1` (ยืนยันการตรวจจับไฟล์ที่ถูกแก้ไขด้วย SHA-256 Manifest ก่อนหยุด Service) |
| **3. เครื่องแม่ข่าย Windows Server 2025 จริงของโรงพยาบาล (`10.2.0.23`)** | **รอผู้ดูแลระบบรันจริงบนเครื่อง `10.2.0.23`** | - การเชื่อมต่อเครือข่ายจริงไปยัง MySQL (`10.1.0.201:3306`) และเครื่องสแกนลายนิ้วมือ (`10.2.0.51`–`53:5005`)<br>- การตรวจสอบ `.NET 10.0 Runtime (x86)` ที่ติดตั้งบนเครื่องแม่ข่ายจริง<br>- การลงทะเบียน Windows Service `SamAttV2Standalone` ผ่าน WinSW และการตั้งค่า NTFS ACL / Windows Firewall จริง |

---

## 2. สรุปผลการรันชุดทดสอบอัตโนมัติ (Automated Test Suite Results)

| ลำดับ | ชุดไฟล์ทดสอบ (`backend/tests/*.test.ts`) | ขอบเขตการตรวจสอบ | ผลลัพธ์ |
| :---: | :--- | :--- | :---: |
| 1 | `sam-att.test.ts` | ระบบยืนยันตัวตน RBAC, Audit Log, Health API และความถูกต้องของ API พื้นฐาน | **PASS** |
| 2 | `attendance-matching.test.ts` | อัลกอริทึมจับคู่เวลาเข้า-ออกงาน กะปกติ กะข้ามเที่ยงคืน และการคำนวณสาย/ออกก่อน | **PASS** |
| 3 | `scanner-sync.test.ts` | การนำเข้าข้อมูลสแกนนิ้ว การป้องกันข้อมูลซ้ำ (Idempotent Deduplication) และการจัดการ Timeout | **PASS** |
| 4 | `historical-sync-mapping.test.ts` | การซิงก์ข้อมูลย้อนหลังและการผูกรหัสเครื่องสแกนกับรหัสบุคลากร | **PASS** |
| 5 | `hosoffice-personnel-sync.test.ts` | การซิงก์ข้อมูลบุคลากรจาก HOSOffice แบบ Read-Only | **PASS** |
| 6 | `safe-deployment-migration.test.ts` | การตรวจสอบ Schema ฐานข้อมูลและระบบป้องกันคำสั่งทำลายข้อมูล | **PASS** |
| 7 | `default-shift-templates.test.ts` | แม่แบบกะการทำงานมาตรฐาน | **PASS** |
| 8 | `shift-template-modal-alert.test.ts` | การตรวจสอบเงื่อนไขเวลาของแม่แบบกะทำงาน | **PASS** |
| 9 | `default-shift-by-personnel-type.test.ts` | การกำหนดกะเริ่มต้นตามประเภทบุคลากร | **PASS** |
| 10 | `github-update-center.test.ts` | ศูนย์อัปเดตระบบผ่าน GitHub (Application-Only Update & Rollback) | **PASS** |
| 11 | `update-center-loop-protection.test.ts` | ระบบป้องกันการสั่งอัปเดตซ้ำเมื่อ Commit ตรงกันและระบบล็อกการอัปเดตซ้อน | **PASS** |
| 12 | `part-a-stabilization.test.ts` | การบังคับ Fail-Closed Production Config, Ephemeral Secret และการบล็อก SQLite Fallback | **PASS** |
| 13 | `part-b-enhancements.test.ts` | การปรับปรุงประสิทธิภาพและ UX ของระบบจัดการเวลาปฏิบัติงาน | **PASS** |
| 14 | `phase2-production-readiness.test.ts` | **Phase 2 & Hotfix (`FIX 01`–`FIX 08`):** โครงสร้าง Drive D, Strict HTTPS TLS & SAN `10.2.0.23`, Scoped Firewall TCP `4101`, Strict Service PID Ownership, Node 22/26 & `.NET 10.0 x86`, SHA-256 Snapshot Manifest & Pre-Stop Rollback Verification, Lossless `.env` Special-Char Password Parsing, Read-Only DB Startup Guard และ Windows CI Job | **PASS** |
