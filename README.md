# Sam_Att V2 Standalone — โรงพยาบาลสามชุก

ระบบบันทึกเวลาปฏิบัติงานและบริหารจัดการตารางเวรบุคลากร โรงพยาบาลสามชุก (Samchuk Hospital Attendance System V2 — Independent Standalone Application)

---

## 1. ข้อมูลระบบและสถาปัตยกรรม (Production Architecture)

| รายการ | รายละเอียด |
| :--- | :--- |
| **ชื่อระบบ** | Sam_Att V2 Standalone |
| **หน่วยงาน** | โรงพยาบาลสามชุก |
| **เวอร์ชัน** | v2.0.0 (Phase 2 Production Readiness) |
| **Windows Server (ใหม่)** | Windows Server 2025 Standard Evaluation (`10.2.0.23`) |
| **Windows Server (เดิม)** | `10.2.0.13` |
| **Runtime Mode** | Independent Standalone Node.js Application (ไม่พึ่งพา IIS) |
| **Windows Service ID** | `SamAttV2Standalone` (`Sam_Att V2 Standalone` — WinSW, Automatic Delayed Start) |
| **HTTPS Port** | `4101` |
| **Frontend URL** | `https://10.2.0.23:4101/Sam_Att/` |
| **API Base URL** | `https://10.2.0.23:4101/api/Sam_Att/` |
| **Health Check Endpoints** | `/api/Sam_Att/health`, `/api/Sam_Att/health/live`, `/api/Sam_Att/health/ready`, `/Sam_Att/health` |
| **MySQL Server** | `10.1.0.201:3306` (Database: `samchuk_attendance_v2`, Engine: `InnoDB`, Charset: `utf8mb4`) |
| **Scanner Bridge** | `ScannerReader.exe` (.NET Framework 4.8, 32-bit x86, COM ProgID `zkemkeeper.ZKEM.1`) |
| **Timezone** | `Asia/Bangkok` (UTC+07:00) |

---

## 2. โครงสร้างโฟลเดอร์มาตรฐานบน Drive D (Production Standard Layout)

```text
D:\WebApps\Sam_Att\
├── App\            # Source Code, Production Build (dist/), node_modules, ScannerReader
├── Config\         # Production .env (แยกนอก Git Working Tree เพื่อความปลอดภัยในการ Deploy)
├── Logs\           # application.log, error.log, scanner.log, security-audit.log, deployment.log, service logs
├── Service\        # SamAttV2Standalone.exe (WinSW) และ SamAttV2Standalone.xml
└── Certs\          # cert.pem, key.pem, ca.pem (HTTPS TLS Certificate & Private Key)

D:\Backups\Sam_Att\      # Application Release Snapshots & backup-manifest.json (เก็บอย่างน้อย 5 Releases / 30 วัน)
D:\Deployments\Sam_Att\  # Staging Workspace สำหรับ Build & Test ก่อนสลับเข้า Production
D:\Installers\           # ไฟล์ติดตั้งพื้นฐานของเครื่องแม่ข่าย
```

---

## 3. สคริปต์ติดตั้งและบริหารจัดการอัตโนมัติ (PowerShell 5.1 Automation)

| ไฟล์สคริปต์ | หน้าที่ |
| :--- | :--- |
| `Install_Sam_Att.bat` / `Install_Sam_Att.ps1` | ตัวติดตั้งแบบ One-Click บน Windows Server 2025 รองรับโหมด `Preflight`, `FreshInstall`, `Repair`, `Upgrade`, `Uninstall` และ `-DryRun` |
| `Preflight_Sam_Att.ps1` | ตรวจสอบความพร้อมของเครื่องแม่ข่ายและฐานข้อมูล MySQL (`10.1.0.201:3306`) แบบ **Read-Only 100%** |
| `Deploy_Sam_Att.ps1` | อัปเดตระบบจาก GitHub แบบ **Zero-Breakage Staging Build** (Build และ Test ใน `D:\Deployments\Sam_Att` ก่อนหยุด Service) พร้อม Auto-Rollback |
| `Backup_Sam_Att.ps1` | สำรอง Application Release, WinSW Config และ Metadata พร้อมตรวจสอบ SHA-256 และนโยบายเก็บย้อนหลัง |
| `Rollback_Sam_Att.ps1` | ย้อนกลับ Application ไปยัง Snapshot ก่อนหน้าอย่างปลอดภัยโดยไม่กระทบฐานข้อมูลหรือ `.env` |
| `HealthCheck_Sam_Att.ps1` | ตรวจสอบสถานะ Windows Service `SamAttV2Standalone`, HTTPS 4101, Frontend, API, MySQL และ Scanner Standby Mode |
| `Uninstall_Sam_Att.ps1` | ถอนการติดตั้งเฉพาะ Windows Service `SamAttV2Standalone` โดยรักษาข้อมูลฐานข้อมูล, Config, Certs, Logs และ Backups |

---

## 4. สารบัญเอกสารคู่มือ (Phase 2 Production Documentation)

1. [INSTALLATION_WINDOWS_SERVER.md](./INSTALLATION_WINDOWS_SERVER.md) — คู่มือการติดตั้งบน Windows Server 2025 (`10.2.0.23`)
2. [SERVER_REQUIREMENTS.md](./SERVER_REQUIREMENTS.md) — ข้อกำหนดด้าน Hardware, OS, Software และ Network
3. [PRODUCTION_CONFIGURATION.md](./PRODUCTION_CONFIGURATION.md) — คู่มือการตั้งค่า `D:\WebApps\Sam_Att\Config\.env`
4. [DATABASE_SAFETY.md](./DATABASE_SAFETY.md) — มาตรการความปลอดภัยฐานข้อมูล MySQL (`10.1.0.201`) แบบ Read-Only Preflight
5. [SCANNER_CONFIGURATION.md](./SCANNER_CONFIGURATION.md) — การตั้งค่าเครื่องสแกนลายนิ้วมือ, SDK 32-bit และ Standby Mode
6. [HTTPS_SETUP.md](./HTTPS_SETUP.md) — การติดตั้งและตรวจสอบใบรับรอง HTTPS บนพอร์ต `4101`
7. [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md) — คู่มือการอัปเดตระบบจาก GitHub (CLI และ GitHub Update Center)
8. [BACKUP_ROLLBACK.md](./BACKUP_ROLLBACK.md) — คู่มือการสำรองระบบและการย้อนกลับ (Rollback)
9. [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — คู่มือการแก้ไขปัญหาและการอ่านไฟล์ Log
10. [PRODUCTION_CHECKLIST.md](./PRODUCTION_CHECKLIST.md) — รายการตรวจสอบก่อนเปิดใช้งานจริง
11. [MIGRATION_CUTOVER.md](./MIGRATION_CUTOVER.md) — แผนการย้ายระบบจากเซิร์ฟเวอร์เดิม (`10.2.0.13`) มายังเซิร์ฟเวอร์ใหม่ (`10.2.0.23`)
12. [PHASE2_AUDIT_REPORT.md](./PHASE2_AUDIT_REPORT.md) — รายงานผลการตรวจสอบ Source Code และการแก้ไขใน Phase 2
13. [PHASE2_TEST_REPORT.md](./PHASE2_TEST_REPORT.md) — รายงานผลการทดสอบอัตโนมัติ (Automated Test Matrix)
14. [CHANGELOG.md](./CHANGELOG.md) — ประวัติการเปลี่ยนแปลงของระบบ
