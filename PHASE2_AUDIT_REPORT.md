# รายงานการตรวจสอบความพร้อมและความปลอดภัยก่อนขึ้นระบบจริง (`PHASE2_AUDIT_REPORT.md`)

**โครงการ:** ระบบบันทึกเวลาปฏิบัติงานและประมวลผลเวร (Sam_Att V2 Standalone)  
**หน่วยงาน:** โรงพยาบาลสามชุก  
**เครื่องแม่ข่ายเป้าหมาย:** Windows Server 2025 Standard Evaluation (`10.2.0.23`, พอร์ต HTTPS `4101`)  
**ฐานข้อมูลเป้าหมาย:** MySQL (`10.1.0.201:3306` / `samchuk_attendance_v2` — **Read-Only Startup & Preflight Policy**)  
**รุ่นการตรวจสอบ:** Phase 2 Final Production Readiness Hotfix (`FIX 01` – `FIX 08`)

---

## 1. สรุปผลการตรวจสอบและแก้ไข Hotfix (`FIX 01` – `FIX 08`)

| รหัส | หัวข้อการตรวจสอบ | สถานะ | รายละเอียดการแก้ไขและการยืนยันใน Source Code |
| :--- | :--- | :---: | :--- |
| **FIX 01** | **Strict HTTPS Health Check** | **PASS** | ลบ `-SkipCertificateCheck`, `ServerCertificateValidationCallback = { $true }`, `rejectUnauthorized: false` และ `NODE_TLS_REJECT_UNAUTHORIZED=0` ออกจาก `HealthCheck_Sam_Att.ps1`, `scripts/health-check.ps1` และ `deployment/Deploy_Sam_Att.ps1` ทั้งหมด กำหนด Default Host เป็น `10.2.0.23` ตรวจสอบ X.509 Chain Trust, Hostname/IP SAN (`10.2.0.23`) และวันหมดอายุ (`NotBefore`/`NotAfter`) จริงบน Windows PowerShell 5.1 พร้อมจัดทำวิธีนำเข้า Internal CA เข้าสู่ `Cert:\LocalMachine\Root` อย่างปลอดภัย |
| **FIX 02** | **Firewall Scope** | **PASS** | ยกเลิกค่าเริ่มต้นที่เปิดกว้าง (`LocalSubnet,10.0.0.0/8,192.168.0.0/16`) ใน `Install_Sam_Att.ps1` บังคับให้ผู้ดูแลระบบระบุ `-FirewallRemoteAddress` (ทั้งในโหมด Interactive และ `-NonInteractive`) จำกัดการเปิดพอร์ตเฉพาะ TCP `4101` เท่านั้น และไม่แตะต้อง Firewall Rule ของโปรแกรมอื่น |
| **FIX 03** | **Strict Windows Service Health Check** | **PASS** | `HealthCheck_Sam_Att.ps1` และ `scripts/health-check.ps1` รายงาน `FAIL` ทันทีหากไม่พบบริการ `SamAttV2Standalone`, บริการไม่ได้อยู่ในสถานะ `Running`, พอร์ต `4101` ไม่ได้ถูกถือครองโดย Process Tree ของ `SamAttV2Standalone`, Frontend/API/Database ไม่พร้อม หรือ `ExpectedVersion`/`ExpectedCommit` ไม่ตรงกับตัวที่รันจริง และไม่อนุญาตให้ใช้ `-SkipServiceCheck` เว้นแต่ระบุ `-DiagnosticMode` อย่างชัดเจน |
| **FIX 04** | **Runtime Compatibility** | **PASS** | กำหนด `engines.node` เป็น `>=22.0.0 <27.0.0` รองรับทั้ง Node.js `v22.x` LTS และ Node.js `v26.13.1` บนเซิร์ฟเวอร์จริง รองรับการกำหนด `-NodeExecutablePath` แบบยืดหยุ่นโดยไม่ถอนหรือเปลี่ยน Global Node.js อัตโนมัติ และตรวจสอบ `ScannerReader/ScannerSyncCli.runtimeconfig.json` ยืนยันข้อกำหนดจริงคือ **`.NET 10.0 Runtime (x86 / 32-bit)`** (`Microsoft.NETCore.App 10.0.0`, `win-x86`) พร้อมชุด Native DLL 32-bit (`FK623Attend.dll`, `FKAttend.dll`, `Interop.RealSvrOcxTcpLib.dll` ฯลฯ) |
| **FIX 05** | **Backup and Rollback Integrity** | **PASS** | `Backup_Sam_Att.ps1` สร้างรายการ **SHA-256 File Manifest** (`files` array) ครบทุกไฟล์ใน `AppSnapshot` พร้อม `backup-manifest.json.sha256` และอัปเดตตัวชี้ `last_known_good.json` ส่วน `Rollback_Sam_Att.ps1` ตรวจสอบความครบถ้วนและ SHA-256 ของทุกไฟล์**ก่อน**สั่งหยุดบริการ `SamAttV2Standalone` หากไฟล์หายหรือ Hash ไม่ตรงจะยกเลิกทันทีโดยไม่หยุดเซอร์วิส ไม่แตะต้องฐานข้อมูล ไม่เขียนทับ `Config\.env` หรือ `Certs` และใช้ **Shared Lifecycle Lock** (`D:\Deployments\Sam_Att\lifecycle.lock`) ร่วมกันทุกสคริปต์ |
| **FIX 06** | **Database Safety & `.env` Security** | **PASS** | ปิดกั้น `runMigrations` และ `ensureBaselineSystemCatalog` ใน `backend/src/database/adapter.ts` ไม่ให้รัน DDL หรือ DML (`CREATE`/`ALTER`/`DROP`/`INSERT`/`UPDATE`) ตอน Startup ในโหมด Production หรือ MySQL อย่างเด็ดขาด ห้าม Fallback ไปยัง SQLite ใน Production บังคับให้ผู้ดูแลระบบยืนยัน `DbHost`, `DbPort`, `DbName`, `DbUser` ก่อนติดตั้ง รองรับรหัสผ่านที่มี `#`, `$`, `&`, Quotes และช่องว่างแบบ Lossless 100% และจำกัดสิทธิ์ NTFS ACL (`icacls /inheritance:r`) บน `Config\.env` และ `Certs\server.key` |
| **FIX 07** | **Installer & Deployment Final Audit** | **PASS** | รวมศูนย์กลไกการอัปเดตให้ใช้มาตรฐานเดียวกันตรวจสอบ `$LASTEXITCODE` ทุกคำสั่งภายนอก ตรวจสอบพอร์ต `4101` ทั้ง Active Listeners และ Windows TCP Excluded Port Range (`netsh interface ipv4 show excludedportrange protocol=tcp`) ป้องกัน `FreshInstall` ไม่ให้เขียนทับระบบที่ติดตั้งอยู่แล้ว รับรองว่า `-DryRun` และ `-WhatIf` ไม่แก้ไขไฟล์หรือสร้าง Lock File ทิ้งไว้ และคงค่า `SCANNER_AUTO_SCHEDULER_ENABLED=false` จนกว่าจะ Cutover |
| **FIX 08** | **Windows CI and Test Verification** | **PASS** | เพิ่ม Job `windows-production-readiness` (`runs-on: windows-latest`) ใน `.github/workflows/ci.yml` เพื่อทดสอบบน Windows Runner จริง ควบคู่กับชุดทดสอบอัตโนมัติใน `backend/tests/phase2-production-readiness.test.ts` |

---

## 2. สรุปผลการตรวจสอบและแก้ไข Final Safety Patch (`FIX 01` – `FIX 05`)

| รหัส | หัวข้อการตรวจสอบ | สถานะ | รายละเอียดการแก้ไขและการยืนยันใน Source Code |
| :--- | :--- | :---: | :--- |
| **FINAL FIX 01** | **Absolute Production Database Startup Safety** | **PASS** | ตัดเงื่อนไข `SAM_ATT_AUTO_MIGRATE=true` ที่อาจเปิดช่องให้ Production Server Startup รัน DDL/DML ออกทั้งหมดใน `backend/src/database/adapter.ts` และ `backend/src/config/env.ts` หาก `NODE_ENV=production` พบ `SAM_ATT_AUTO_MIGRATE=true` (หรือ `1`/`yes`) ระบบจะ **Fail-Closed ทันที** ด้วยรหัส `PRODUCTION_AUTO_MIGRATE_FORBIDDEN` ทั้งใน `validateProductionConfig()`, `runMigrations()` และ `ensureBaselineSystemCatalog()` การรัน Migration อนุญาตเฉพาะผ่าน CLI ผู้ดูแลระบบที่ระบุ `allowProductionCliMigration: true` (`npm run db:migrate`) เท่านั้น |
| **FINAL FIX 02** | **Atomic Lifecycle Lock** | **PASS** | สร้างศูนย์กลาง Lock Engine แบบ Atomic ที่ `scripts/LifecycleLock.ps1` โดยใช้ `[System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)` (และ `fs.openSync(lockFilePath, 'wx')` ใน `backend/src/modules/deployment/jobStore.ts`) แทน `Test-Path` + `Set-Content` ให้ `Install_Sam_Att.ps1`, `Deploy_Sam_Att.ps1`, `Backup_Sam_Att.ps1`, `Rollback_Sam_Att.ps1`, `Uninstall_Sam_Att.ps1` และ `deployment/Deploy_Sam_Att.ps1` ใช้กลไกเดียวกันทั้งหมด รองรับ `-ParentLockId` (`InheritedLockId`) และตรวจสอบความเป็นเจ้าของ (`lockId` + `ownerPid`) ก่อนปลดล็อกทุกครั้ง |
| **FINAL FIX 03** | **Node.js Runtime Verification** | **PASS** | เพิ่ม Windows CI Matrix (`22.x` และ `26.x`) ใน `.github/workflows/ci.yml` และปรับ `Install_Sam_Att.ps1`, `Preflight_Sam_Att.ps1`, `Deploy_Sam_Att.ps1` ให้ผูก `$resolvedNodeExe` และ `$resolvedNpmCmd` จากโฟลเดอร์เดียวกัน พร้อมส่ง `--scripts-prepend-node-path=true` และเรียก `& $resolvedNodeExe --import tsx backend/src/database/cli-preflight.ts` โดยตรง เพื่อให้ทั้ง Build, Test, Preflight และ Windows Service (`SamAttV2Standalone.xml`) ใช้ Node.js ตัวที่เลือก (`v26.13.1` บนเซิร์ฟเวอร์จริง) ตรงกัน 100% |
| **FINAL FIX 04** | **Fresh Installation Test Gate** | **PASS** | ปรับ `Install_Sam_Att.ps1` Step 6 ให้รัน `npm run typecheck`, `npm run lint`, **Isolated Automated Test Gate (`npm test`)** และ `npm run build` พร้อมตรวจ `$LASTEXITCODE` ทุกขั้นตอนก่อนลงทะเบียนและสตาร์ท Windows Service โดยบังคับ `NODE_ENV=test`, `SAM_ATT_TEST_ISOLATION=true`, `SAM_ATT_DB_ENGINE=sqlite_sandbox` และใช้ไฟล์ชั่วคราวใน `$env:TEMP` เพื่อรับประกันว่าชุดทดสอบจะไม่แตะต้องฐานข้อมูล Production MySQL (`10.1.0.201`) หรือ `Config\.env` จริงอย่างเด็ดขาด |
| **FINAL FIX 05** | **Scanner Runtime Confirmation** | **PASS** | ตรวจสอบ Binary PE Header ของ `ScannerReader/ScannerSyncCli.exe` และไฟล์ `.dll` ทั้ง 17 ไฟล์ใน `ScannerReader/` ยืนยันว่าทุกไฟล์เป็น **32-bit `x86` (`IMAGE_FILE_MACHINE_I386 = 0x014c`) 100%** จึงต้องใช้ **`.NET 10.0 Runtime (x86 / 32-bit)` เท่านั้น** และจากการตรวจ PE Export/Import Table ยืนยันว่าไม่มี DLL ใด Export `DllRegisterServer` โดย `ScannerSyncCli.dll` เรียก `FK623Attend.dll` ผ่าน Win32 P/Invoke (`SetDllDirectory`) โดยตรง จึง**ไม่ต้องรัน `regsvr32`** บนเซิร์ฟเวอร์จริง |

---

## 3. การรับรองการอยู่ร่วมกับระบบอื่นบนเซิร์ฟเวอร์ (Multi-System Coexistence Guarantee)

1. **ห้ามฆ่าโปรเซสแบบเหวี่ยงแห:** ตรวจสอบด้วย Automated Test ยืนยันว่าไม่มีคำสั่ง `taskkill /F /IM node.exe` หรือ `Stop-Process -Name node` ในสคริปต์ใดๆ
2. **ห้ามรบกวน IIS และบริการอื่น:** ไม่มีคำสั่ง `iisreset`, ไม่หยุด `W3SVC` และไม่แก้ไขกฎไฟร์วอลล์ของแอปพลิเคชันอื่น
3. **ห้ามรีสตาร์ทเครื่องแม่ข่าย:** ไม่มีคำสั่ง `Restart-Computer` หรือ `shutdown` ในทุกสคริปต์
