# ประวัติการเปลี่ยนแปลงของระบบ (`CHANGELOG.md`)

---

## [v2.0.0-phase2] — 2026-11-28 (Phase 2: Windows Server 2025 Production Readiness)

### Security & Database Safety
- **100% Read-Only MySQL Startup:** ปิดการรัน `INSERT IGNORE` และ `UPDATE` อัตโนมัติใน `ensureBaselineSystemCatalog()` เมื่อเริ่มต้นระบบในโหมด Production MySQL (`startupReadOnlyOnMysql: true`)
- **Read-Only Database Preflight CLI (`npm run db:preflight`):** เพิ่มระบบตรวจสอบความพร้อมของฐานข้อมูล `samchuk_attendance_v2` บน `10.1.0.201:3306` ด้วยคำสั่ง `SELECT` เท่านั้น (ตรวจสอบ 16 ตารางหลัก, คอลัมน์สำคัญ, Charset `utf8mb4`, Timezone `+07:00` และ `schema_migrations`)
- **Cryptographic TLS Verification:** เพิ่ม `validateTlsCertificatePair()` ตรวจสอบรูปแบบ PEM, วันหมดอายุ และความตรงกันของคู่กุญแจ X.509 Certificate กับ Private Key (`x509.checkPrivateKey`) พร้อมรองรับ SAN `IP:10.2.0.23`

### Architecture & Operational Standards
- **Drive D Standard Directory Layout:** กำหนดมาตรฐานโฟลเดอร์ `D:\WebApps\Sam_Att\{App,Config,Logs,Service,Certs}`, `D:\Backups\Sam_Att` และ `D:\Deployments\Sam_Att`
- **Externalized Production Config:** รองรับการโหลดไฟล์ `D:\WebApps\Sam_Att\Config\.env` แยกออกจาก Git Working Tree เพื่อไม่ให้ถูกเขียนทับระหว่างการ Deploy
- **Scanner Standby Mode by Default in Production:** กำหนดค่าเริ่มต้น `SCANNER_AUTO_SCHEDULER_ENABLED=false` เมื่อ `NODE_ENV=production` เพื่อป้องกันการดึงข้อมูลเครื่องสแกนซ้ำซ้อนกับเซิร์ฟเวอร์เดิม (`10.2.0.13`) ก่อนขั้นตอน Cutover
- **Health Probes & Graceful Shutdown:** เพิ่ม `/api/Sam_Att/health/live`, `/api/Sam_Att/health/ready`, ระบบ Structured JSON Logging พร้อม Size Rotation (10 MB) & Secret Redaction และ Graceful Shutdown สำหรับ Windows Service `SamAttV2Standalone`

### Windows Server 2025 Automation Scripts (PowerShell 5.1)
- เพิ่มสคริปต์ `Install_Sam_Att.bat`, `Install_Sam_Att.ps1`, `Preflight_Sam_Att.ps1`, `Deploy_Sam_Att.ps1`, `Backup_Sam_Att.ps1`, `Rollback_Sam_Att.ps1`, `HealthCheck_Sam_Att.ps1` และ `Uninstall_Sam_Att.ps1`

---

## [v2.0.0-phase0] — 2026-11-26 (Phase 0: GitHub Update Center & Infinite Loop Fix)
- แก้ไขปัญหา Infinite API Request Loop ในหน้า GitHub Update Center
- เพิ่มระบบ Single-Flight Coalescing, GitHub Check Cache TTL 30 นาที และ Rate Limit Cooldown Guard
- รองรับ One-Click Application Update และ Rollback โดยไม่กระทบฐานข้อมูล Production
