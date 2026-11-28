# รายงานผลการทดสอบอัตโนมัติ Phase 2 (`PHASE2_TEST_REPORT.md`)

เอกสารนี้รายงานผลการรันชุดทดสอบอัตโนมัติ (Automated Test Matrix) ของระบบ **Sam_Att V2 Standalone** พร้อมแยกแยะรายการที่ทดสอบจริงในสภาพแวดล้อม Automated CI/Sandbox และรายการที่ต้องรันตรวจสอบบนเครื่องแม่ข่าย Windows Server 2025 (`10.2.0.23`) จริงอย่างโปร่งใส

---

## 1. สรุปผลการรันชุดทดสอบอัตโนมัติ (Automated Test Execution Summary)

- **คำสั่งที่รันทดสอบ:**
  - `npm test`
  - `node --import tsx --test backend/tests/phase2-production-readiness.test.ts`
  - `npm run db:preflight -- --json`
  - `npm run lint` (`tsc --noEmit`)
  - `npm run build` (`vite build`)
- **ผลลัพธ์รวม:** **ผ่านทั้งหมด 149 Tests (Pass: 149, Fail: 0)**

---

## 2. รายละเอียดชุดทดสอบที่ผ่านการยืนยันแล้ว (Verified Automated Test Suites)

| ชุดทดสอบ (Test File) | จำนวนหัวข้อ | สิ่งที่ได้รับการยืนยัน | สถานะ |
| :--- | :---: | :--- | :---: |
| `backend/tests/phase2-production-readiness.test.ts` | 6 Suites | 1. พาธมาตรฐาน `D:\WebApps\Sam_Att\*` และ `SCANNER_AUTO_SCHEDULER_ENABLED=false` ใน Production<br>2. การตรวจสอบคู่กุญแจ X.509 Certificate & Private Key, SAN `IP:10.2.0.23` และการบล็อกการสร้าง Cert ทับอัตโนมัติใน Production<br>3. `runProductionDatabasePreflightReadOnly()` ตรวจสอบ 16 ตารางหลักและคอลัมน์แบบ Read-Only 100%<br>4. `/api/Sam_Att/health`, `/health/live`, `/health/ready`, `/Sam_Att/health` และ JSON 404 separation<br>5. Structured Logger (`redactSecretsFromText` และ Size-based Log Rotation)<br>6. ตรวจสอบสคริปต์ PowerShell 5.1 และ `winsw-sam-att.xml` ว่าเป็น 7-bit ASCII 100%, ไม่มี `taskkill /F /IM node.exe` และไม่มี `iisreset` | **PASS** |
| `backend/tests/update-center-loop-protection.test.ts` | 8 Suites (18 Scenarios) | ป้องกัน Infinite API Request Loop ในหน้า GitHub Update Center, Single-Flight Request Coalescing, Cache TTL 30 นาที, Rate Limit Cooldown และการบล็อก Database Schema Changes (`DB_SCHEMA_CHANGE_BLOCKED`) | **PASS** |
| `backend/tests/deployment.test.ts` | 9 Suites | ตรวจสอบระบบ One-Click Application Deployment, Snapshot Backup, Rollback, Service Control เฉพาะ `SamAttV2Standalone` | **PASS** |
| `backend/tests/scanner-sync.test.ts` | 11 Suites (SCAN-01..20) | ตรวจสอบการเชื่อมต่อ `ScannerReader.exe`, Multi-Day Buffer, Timeout 120s, Fail-Closed JSON Parsing, Mutex Lock และ Diagnostic Logging | **PASS** |
| `backend/tests/attendance-engine.test.ts` | 16 Suites (ATT-01..16) | ตรวจสอบเครื่องยนต์จับคู่เวลาเข้า-ออกงาน กะดึกข้ามวัน กะควบ และการคำนวณสาย/กลับก่อน | **PASS** |
| `backend/tests/shift-template-modal.test.ts` | 6 Suites (UI-01..06) | ตรวจสอบการจัดการเทมเพลตตารางเวรและระบบแจ้งเตือนมาตรฐาน | **PASS** |
| `backend/tests/system.test.ts` | Core Integration | ตรวจสอบ Authentication, RBAC, Roster, Reports, Audit Logs และ Read-Only HOSxP Guard | **PASS** |

---

## 3. รายการที่ต้องรันตรวจสอบบนเครื่องแม่ข่ายจริง (`10.2.0.23` Live Verification)

เนื่องจากสภาพแวดล้อมพัฒนาและทดสอบอัตโนมัติทำงานบน Linux Sandbox รายการต่อไปนี้จึงได้รับการตรวจสอบระดับ Static Verification / Mock Integration แล้ว และ**ต้องรันยืนยันจริงบนเครื่อง Windows Server 2025 (`10.2.0.23`)** ตามคู่มือ `INSTALLATION_WINDOWS_SERVER.md`:

1. การรัน `.\Preflight_Sam_Att.ps1 -MySqlHost 10.1.0.201 -MySqlPort 3306` เพื่อเชื่อมต่อฐานข้อมูล MySQL จริงบน `10.1.0.201`
2. การรัน `.\Install_Sam_Att.ps1 -Mode FreshInstall` เพื่อลงทะเบียน Windows Service `SamAttV2Standalone` ผ่าน WinSW และเปิด Windows Firewall พอร์ต `4101`
3. การลงทะเบียน `C:\Windows\SysWOW64\regsvr32.exe zkemkeeper.dll` และการเปิด `SCANNER_AUTO_SCHEDULER_ENABLED=true` หลังหยุดเซิร์ฟเวอร์เดิม `10.2.0.13` ในขั้นตอน Cutover
