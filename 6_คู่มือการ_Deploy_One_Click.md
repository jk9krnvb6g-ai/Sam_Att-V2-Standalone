# 6. คู่มือการใช้งานระบบ One-Click Deployment (`Deploy_Sam_Att.bat`)
## ระบบบริหารเวลาปฏิบัติงานบุคลากร โรงพยาบาลสามชุก — Sam_Att V2 Standalone

เอกสารนี้อธิบายขั้นตอนการใช้งานระบบ **One-Click Deployment** สำหรับผู้ดูแลระบบโรงพยาบาลสามชุก เพื่อดึงโค้ดล่าสุดจาก GitHub (`origin/main`), คอมไพล์หน้าเว็บ, สำรองข้อมูล และรีสตาร์ทเฉพาะบริการ **Sam_Att V2 Standalone (HTTPS Port 4101)** โดยไม่กระทบระบบอื่นบนเครื่องแม่ข่าย (เช่น ระบบจัดซื้อจัดจ้าง `Procurement`)

---

## 1. ตำแหน่งไฟล์ Deployment

ในโฟลเดอร์ติดตั้ง `C:\inetpub\wwwroot\Sam_Att` มีไฟล์สำหรับจัดการการอัปเดตดังนี้:

| ไฟล์ | หน้าที่ |
| :--- | :--- |
| `C:\inetpub\wwwroot\Sam_Att\Deploy_Sam_Att.bat` | ไฟล์ทางลัดหลักสำหรับคลิกขวา **Run as administrator** (หรือดับเบิลคลิก) ที่โฟลเดอร์ราก |
| `C:\inetpub\wwwroot\Sam_Att\deployment\Deploy_Sam_Att.bat` | ไฟล์ Entry Point สำหรับตรวจสอบสิทธิ์และเรียกใช้งาน PowerShell Deployment Script |
| `C:\inetpub\wwwroot\Sam_Att\deployment\Deploy_Sam_Att.ps1` | สคริปต์หลัก 7 ขั้นตอน (Preflight, GitHub Pull, Backup, Dependencies, Typecheck/Test/Build, IIS/Backend Restart, Health Check & Automatic Rollback) |
| `C:\inetpub\wwwroot\Sam_Att\deployment\deploy-runner.ts` | เอ็นจินตรวจสอบและชุดจำลองการทดสอบความล้มเหลว 15 สถานการณ์ |

---

## 2. วิธีใช้งานปกติ (One-Click Deployment)

1. รีโมตเข้าสู่เครื่องแม่ข่าย Windows Server ของโรงพยาบาลสามชุก
2. เปิดโฟลเดอร์ `C:\inetpub\wwwroot\Sam_Att`
3. คลิกขวาที่ไฟล์ **`Deploy_Sam_Att.bat`** แล้วเลือก **"Run as administrator"**
4. ระบบจะดำเนินการตรวจสอบและอัปเดตอัตโนมัติครบ 7 ขั้นตอน พร้อมแสดงผลบนหน้าจอ:

```text
========================================
 SAM_ATT V2 STANDALONE DEPLOYMENT
 Samchuk Hospital
========================================

[1/7] Preflight Check       PASS
[2/7] GitHub Update         PASS
[3/7] Backup                PASS
[4/7] Install Dependencies  PASS
[5/7] Typecheck/Test/Build  PASS
[6/7] IIS / Backend Update  PASS
[7/7] Health Check          PASS

----------------------------------------
Frontend HTTPS : 200 OK
Backend API    : 200 OK
MySQL          : CONNECTED
Database       : samchuk_attendance_v2
Port           : 4101
----------------------------------------

DEPLOYMENT SUCCESS
```

---

## 3. โหมดตรวจสอบความพร้อมอย่างเดียว (`-CheckOnly`)

หากผู้ดูแลระบบต้องการตรวจสอบความพร้อมของเครื่องแม่ข่าย, สถานะไฟล์ `.env`, สถานะพอร์ต `4101`, และเปรียบเทียบเลข Commit ปัจจุบันกับ GitHub **โดยไม่แก้ไขไฟล์หรือรีสตาร์ทระบบ** สามารถรันคำสั่งใน PowerShell ได้ดังนี้:

```powershell
cd C:\inetpub\wwwroot\Sam_Att
powershell -ExecutionPolicy Bypass -File .\deployment\Deploy_Sam_Att.ps1 -CheckOnly
```

---

## 4. กรณีมีการเปลี่ยนแปลงโครงสร้างตารางฐานข้อมูล (`-ApproveMigrations`)

ตามกฎความปลอดภัยของโรงพยาบาล สคริปต์ **จะไม่รัน Database Migration อัตโนมัติ**
- หากใน Commit ใหม่มีการเพิ่มหรือแก้ไขไฟล์ใน `database/migrations/*.sql` สคริปต์จะหยุดในขั้นตอนที่ `[2/7]` พร้อมแสดงรายชื่อไฟล์ Migration ที่ตรวจพบ
- เมื่อผู้ดูแลระบบตรวจสอบไฟล์ SQL และอนุมัติแล้ว ให้รันด้วยพารามิเตอร์ `-ApproveMigrations`:

```powershell
cd C:\inetpub\wwwroot\Sam_Att
powershell -ExecutionPolicy Bypass -File .\deployment\Deploy_Sam_Att.ps1 -ApproveMigrations
```
และรันคำสั่งอัปเดตตารางเมื่อได้รับอนุมัติ:
```powershell
npm run db:migrate
```

---

## 5. กฎความปลอดภัยและการแยกอิสระ (Isolation & Safety Guarantees)

1. **รักษาไฟล์ตั้งค่าและข้อมูลสำคัญ 100%**:
   - ไม่ลบหรือเขียนทับไฟล์ `.env`, ใบรับรอง `certs\server.crt` / `certs\server.key`, โฟลเดอร์ `logs\`, โฟลเดอร์ `backups\`, และไฟล์ `ScannerReader\ScannerSyncCli.exe`
2. **ห้ามใช้คำสั่งทำลายโค้ดในเครื่อง**:
   - ไม่ใช้ `git reset --hard` หรือ `git clean -fd` อัตโนมัติ หากตรวจพบไฟล์ถูกแก้ไขค้างไว้ในเครื่อง (`Dirty Working Tree`) ระบบจะหยุดและแจ้งรายชื่อไฟล์ทันที
3. **ไม่กระทบระบบจัดซื้อจัดจ้าง (`Procurement`) หรือระบบอื่นบนเครื่องเดียวกัน**:
   - ห้ามใช้คำสั่ง `iisreset` หรือรีสตาร์ท IIS ทั้งเครื่องเด็ดขาด
   - ห้ามหยุดโปรเซสจากเลขพอร์ต `4101` เพียงอย่างเดียว โดยต้องตรวจสอบ Command Line / Service Name และ `/api/Sam_Att/health` ยืนยันว่าเป็นโปรเซสของ `Sam_Att V2 Standalone` เท่านั้น
4. **การย้อนกลับอัตโนมัติเมื่อเกิดข้อผิดพลาด (`Automatic Safe Rollback`)**:
   - หากขั้นตอนการติดตั้ง Dependencies, Typecheck, Tests, Build, การเริ่มโปรเซส Backend หรือ Health Check ไม่ผ่าน ระบบจะย้อนกลับไปยัง Commit และชุดไฟล์ `dist\` ก่อนหน้าในโฟลเดอร์ `backups\deploy_backup_<timestamp>` โดยอัตโนมัติ แล้วตรวจสอบ Health Check ซ้ำอีกครั้ง
5. **การปกป้องความลับในไฟล์ Log**:
   - ไฟล์ Log ทุกไฟล์ใน `C:\inetpub\wwwroot\Sam_Att\logs\deploy_sam_att_<timestamp>.log` จะถูกปิดบังรหัสผ่าน (`***REDACTED***`) โดยไม่แสดง `SAM_ATT_DB_PASSWORD`, `HOSOFFICE_DB_PASSWORD`, `JWT_SECRET` หรือ `SCANNER_INGEST_SHARED_TOKEN`

---

## 6. แนวทางการลงทะเบียน Windows Service ครั้งแรก (กรณีรันด้วย `tsx server.ts` แบบ Manual)

หากปัจจุบันเซิร์ฟเวอร์รันโปรเซสผ่าน `tsx server.ts` โดยยังไม่ได้ลงทะเบียนเป็น Windows Service สคริปต์ `Deploy_Sam_Att.ps1` จะตรวจจับโปรเซส `server.ts` ของ `Sam_Att` และรีสตาร์ทเฉพาะ PID ดังกล่าวได้อย่างปลอดภัย

ทั้งนี้ หากต้องการให้ระบบเริ่มทำงานอัตโนมัติเมื่อบูตเครื่อง Windows Server แนะนำให้ลงทะเบียนผ่าน WinSW (เฉพาะครั้งแรกครั้งเดียว) ด้วยคำสั่ง:

```powershell
cd C:\inetpub\wwwroot\Sam_Att
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
```
โดย WinSW จะสร้างเซอร์วิสชื่อ `SamAttV2Standalone` ซึ่งแยกอิสระจากระบบอื่นบนเครื่องแม่ข่าย 100%
