# รายงานผลการทดสอบระบบและความพร้อมก่อนติดตั้งจริง (`PHASE2_TEST_REPORT.md`)

**โครงการ:** ระบบบันทึกเวลาปฏิบัติงานและประมวลผลเวร (Sam_Att V2 Standalone)  
**รุ่นการทดสอบ:** Phase 2 Final Production Readiness Hotfix (`FIX 01` – `FIX 08`)

---

## 1. การแยกแยะสภาพแวดล้อมการทดสอบตามความจริง (Test Environment Transparency — FIX 08)

เพื่อให้ผู้ดูแลระบบโรงพยาบาลสามชุกทราบขอบเขตการทดสอบอย่างโปร่งใสและตรงไปตรงมา รายงานนี้แยกผลการทดสอบออกเป็น 3 ส่วนชัดเจน ดังนี้:

| สภาพแวดล้อม | สถานะการรัน | สิ่งที่ได้รับการทดสอบและยืนยันแล้ว |
| :--- | :---: | :--- |
| **1. Linux Sandbox Automated Verification** (รันจริงบน **Node.js `v22.22.0`** ในสภาพแวดล้อม Build/Test ปัจจุบัน) | **รันจริงแล้ว (PASS 100% — 154 Tests, 0 Failures)** | - `npm run typecheck` และ `npm run lint` (`tsc --noEmit` ผ่าน 0 errors)<br>- `npm run build` (`vite build` สร้าง Production Bundle สำเร็จ)<br>- `npm test` (รันชุดทดสอบอัตโนมัติทั้งหมด 154 รายการทดสอบ ผ่านครบ 100% บน Isolated SQLite Sandbox ใน `os.tmpdir()`)<br>- **Final Safety Patch FIX 01:** ทดสอบ `NODE_ENV=production` + `SAM_ATT_AUTO_MIGRATE=true` ยืนยัน Fail-Closed ด้วย `PRODUCTION_AUTO_MIGRATE_FORBIDDEN` ทั้งใน `validateProductionConfig`, `runMigrations` และ `ensureBaselineSystemCatalog`<br>- **Final Safety Patch FIX 02:** ทดสอบ Concurrency 8 โปรเซส/งานพร้อมกันบน Atomic File Lock (`wx` / `FileMode.CreateNew`), การสืบทอด `ParentLockId` และการป้องกันผู้ที่ไม่ได้ถือ Lock ลบไฟล์ Lock<br>- **Final Safety Patch FIX 03 & 04:** ตรวจสอบการผูก `$resolvedNodeExe` และการรัน Isolated Test Gate (`npm test` บน `sqlite_sandbox` ใน `$env:TEMP`) ใน `Install_Sam_Att.ps1`<br>- **Final Safety Patch FIX 05:** ตรวจสอบ PE Binary Header ของไฟล์ใน `ScannerReader/` ยืนยัน Machine Type `0x014c` (32-bit `x86`) ทุกไฟล์ |
| **2. GitHub Actions Windows Runner (`windows-latest`)** (กำหนดใน `.github/workflows/ci.yml` — Matrix `22.x` และ `26.x`) | **กำหนดใน CI Workflow (ยังไม่ถูกรันใน Linux Container นี้ จะทำงานเมื่อ Push ขึ้น GitHub)** | - รัน Matrix ทดสอบบน `windows-latest` สำหรับ Node.js `22.x` และ `26.x` (`npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`)<br>- ตรวจสอบไวยากรณ์ PowerShell 5.1 ด้วย `[System.Management.Automation.Language.Parser]::ParseFile` ทุกสคริปต์ (รวม `scripts/LifecycleLock.ps1`)<br>- รันทดสอบ PowerShell Atomic Lifecycle Lock Concurrency (`Acquire-AtomicLifecycleLock` / `Release-AtomicLifecycleLock`), `ParentLockId` และการตรวจสอบ Ownership บน Windows PowerShell จริง<br>- ทดสอบ `Install_Sam_Att.ps1 -DryRun`, `HealthCheck_Sam_Att.ps1 -SkipServiceCheck` และ `Backup_Sam_Att.ps1` + `Rollback_Sam_Att.ps1` (SHA-256 Manifest Verification ก่อนหยุด Service) |
| **3. เครื่องแม่ข่าย Windows Server 2025 จริงของโรงพยาบาล (`10.2.0.23`, ติดตั้ง Node.js `v26.13.1`)** | **รอผู้ดูแลระบบรันจริงบนเครื่อง `10.2.0.23`** | - **หมายเหตุความโปร่งใส:** ในสภาพแวดล้อม Linux Container ปัจจุบันใช้ Node.js `v22.22.0` จึงยังไม่ได้รันไบนารี Node.js `v26.13.1` ของ Windows บนเครื่องจริง การยืนยันขั้นสุดท้ายบน Node.js `v26.13.1` จะเกิดขึ้นเมื่อผู้ดูแลระบบรัน `Preflight_Sam_Att.ps1` และ `Install_Sam_Att.ps1` (ซึ่งเพิ่มขั้นตอน Fresh Installation Test Gate รัน `npm run typecheck`, `npm run lint`, Isolated `npm test` และ `npm run build` ด้วย `node.exe` `v26.13.1` ของเครื่องจริงโดยอัตโนมัติก่อนลงทะเบียน Windows Service) |

---

## 2. สรุปผลการรันชุดทดสอบอัตโนมัติ (Automated Test Suite Results — 154/154 PASS)

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
| 14 | `phase2-production-readiness.test.ts` | **Phase 2 Hotfix (`FIX 01`–`FIX 08`) & Final Safety Patch (`FIX 01`–`FIX 05`):** โครงสร้าง Drive D, Strict HTTPS TLS & SAN `10.2.0.23`, Scoped Firewall TCP `4101`, Strict Service PID Ownership, Fail-Closed `PRODUCTION_AUTO_MIGRATE_FORBIDDEN`, Atomic Lifecycle Lock Concurrency (`FileMode.CreateNew` / `wx`) & Ownership, Selected Node.js Runtime Binding, Fresh Install Isolated Test Gate และ ScannerReader PE Binary Header (`0x014c` x86) Verification | **PASS** |
