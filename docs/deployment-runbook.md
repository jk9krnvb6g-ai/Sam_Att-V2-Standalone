# คู่มือการติดตั้ง อัปเดต สำรองข้อมูล และ Rollback (Windows Standalone Runbook)

## 1. กฎเหล็กด้านความปลอดภัยและการแยกอิสระ
1. **ห้ามแตะต้องระบบอื่น:** ห้าม Restart, เปลี่ยน Port, แก้ไขฐานข้อมูล หรือแตะต้อง Service ของระบบจัดซื้อ (`Procurement`) และ `Production Central API Gateway`
2. **ห้ามติดตั้งบน `FILESERVER`:** สคริปต์ `scripts/install-windows.ps1` มีระบบตรวจสอบชื่อเครื่องและยกเลิกทันทีหากรันบน `FILESERVER`
3. **พอร์ตเดียวเท่านั้น:** เปิดเฉพาะ HTTPS Port `4101` (`https://HOST:4101/Sam_Att/` และ `https://HOST:4101/api/Sam_Att/*`)

## 2. ขั้นตอนการติดตั้งครั้งแรกบน Windows Server / VM
```powershell
# 1. คัดลอกไฟล์ .env.example เป็น .env และตั้งค่ารหัสผ่านฐานข้อมูลจริงและใบรับรอง TLS
Copy-Item .env.example .env

# 2. รันสคริปต์ติดตั้ง Windows Service (SamAttV2Standalone)
.\scripts\install-windows.ps1 -InstallDir "C:\Sam_Att\app" -ServiceName "SamAttV2Standalone" -HttpsPort 4101
```

## 3. ขั้นตอนการสำรองข้อมูล (Backup) และอัปเดตพร้อม Automatic Rollback
```powershell
# สำรองข้อมูล MySQL + Build + Manifest
.\scripts\backup.ps1 -AppDir "C:\Sam_Att\app" -BackupRoot "C:\Sam_Att\backups"

# อัปเดตเวอร์ชันใหม่พร้อมตรวจ SHA-256 และ Rollback อัตโนมัติหาก Health Check ไม่ผ่าน
.\scripts\deploy-test.ps1 -ArtifactZipPath "C:\Sam_Att\releases\sam_att_v2.zip" -ExpectedSha256 "<64-HEX-SHA256>"
```
