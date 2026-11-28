# คู่มือการสำรองระบบและการย้อนกลับ (`BACKUP_ROLLBACK.md`)

เอกสารนี้อธิบายการสำรอง Application Release (`Backup_Sam_Att.ps1`) และการย้อนกลับระบบ (`Rollback_Sam_Att.ps1`) บนเครื่องแม่ข่าย `10.2.0.23`

---

## 1. โครงสร้างการสำรองข้อมูล (`D:\Backups\Sam_Att`)

ทุกครั้งที่มีการอัปเดตหรือสั่งสำรองข้อมูล ระบบจะสร้างโฟลเดอร์ Snapshot ภายใต้ `D:\Backups\Sam_Att`:

```text
D:\Backups\Sam_Att\
└── release_20261128_143000_04d2bbc\
    ├── app\                     # สำเนาโค้ด, dist/, package.json, ScannerReader
    ├── service\                 # สำเนาไฟล์ SamAttV2Standalone.xml
    ├── config-sanitized.env     # สำเนาโครงสร้าง Config ที่ลบค่า Secret ออกแล้วเพื่อการตรวจสอบ
    └── backup-manifest.json     # ข้อมูล Commit SHA, Timestamp, จำนวนไฟล์ และ SHA-256 Hash
```

### นโยบายการเก็บรักษา (Retention Policy)
- ระบบจะเก็บ Snapshot ย้อนหลัง**อย่างน้อย 5 Releases ล่าสุด** และเก็บ Snapshot ที่มีอายุไม่เกิน **30 วัน**
- โฟลเดอร์ `D:\WebApps\Sam_Att\Config\.env` (ตัวจริง) และ `D:\WebApps\Sam_Att\Certs` จะถูกเก็บรักษาไว้ที่เดิมเสมอ ไม่ถูกลบระหว่างการ Deploy หรือ Rollback

---

## 2. การสั่งสำรองระบบด้วยตนเอง (Manual Application Backup)

```powershell
.\Backup_Sam_Att.ps1 -Label "before-maintenance"
```

---

## 3. การสั่งย้อนกลับระบบ (Application Rollback)

หากต้องการย้อนกลับไปยัง Snapshot ล่าสุดที่ผ่านการตรวจสอบ `backup-manifest.json`:

```powershell
# ย้อนกลับไปยัง Snapshot ล่าสุดอัตโนมัติ
.\Rollback_Sam_Att.ps1

# หรือระบุพาธของ Snapshot ที่ต้องการย้อนกลับโดยเฉพาะ
.\Rollback_Sam_Att.ps1 -SnapshotPath "D:\Backups\Sam_Att\release_20261128_143000_04d2bbc"
```

### ขั้นตอนการทำงานของ `Rollback_Sam_Att.ps1`:
1. ตรวจสอบความสมบูรณ์ของ `backup-manifest.json` และโฟลเดอร์ `app\`
2. หยุดเฉพาะ Windows Service `SamAttV2Standalone`
3. คืนค่าไฟล์ Application ไปยัง `D:\WebApps\Sam_Att\App` (โดยไม่แก้ไขฐานข้อมูล MySQL และไม่ทับ `D:\WebApps\Sam_Att\Config\.env`)
4. เริ่มทำงาน Windows Service `SamAttV2Standalone`
5. รัน `HealthCheck_Sam_Att.ps1` เพื่อยืนยันว่าระบบกลับมาออนไลน์ที่ `https://10.2.0.23:4101/Sam_Att/`
