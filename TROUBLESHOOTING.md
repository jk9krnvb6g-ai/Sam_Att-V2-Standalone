# คู่มือการแก้ไขปัญหาและการอ่านไฟล์ Log (`TROUBLESHOOTING.md`)

เอกสารนี้รวบรวมวิธีตรวจสอบและแก้ไขปัญหาที่พบบ่อยของระบบ **Sam_Att V2 Standalone** บนเครื่องแม่ข่าย `10.2.0.23`

---

## 1. ตำแหน่งไฟล์ Log มาตรฐาน (`D:\WebApps\Sam_Att\Logs`)

ระบบบันทึก Log ในรูปแบบ **Structured JSON** พร้อมระบบหมุนเวียนไฟล์อัตโนมัติ (Size-Based Rotation 10 MB, เก็บย้อนหลัง 5 ไฟล์) และปกปิดรหัสผ่าน/Token (`[REDACTED]`):

| ไฟล์ Log | รายละเอียด |
| :--- | :--- |
| `D:\WebApps\Sam_Att\Logs\application.log` | เหตุการณ์การทำงานทั่วไป การเริ่มต้นระบบ และการเชื่อมต่อฐานข้อมูล |
| `D:\WebApps\Sam_Att\Logs\error.log` | ข้อผิดพลาดระดับ `ERROR` ทั้งหมดของระบบ |
| `D:\WebApps\Sam_Att\Logs\scanner.log` | ประวัติการเชื่อมต่อเครื่องสแกนลายนิ้วมือ และสถานะ Standby Mode |
| `D:\WebApps\Sam_Att\Logs\security-audit.log` | ประวัติการเข้าสู่ระบบ การแก้ไขสิทธิ์ และการดำเนินการของผู้ดูแลระบบ |
| `D:\WebApps\Sam_Att\Logs\deployment.log` | ประวัติการติดตั้ง การอัปเดตจาก GitHub และการ Rollback |
| `D:\WebApps\Sam_Att\Logs\service.out.log` / `service.err.log` | Log มาตรฐานจาก WinSW (`SamAttV2Standalone`) |

---

## 2. คำสั่งตรวจสอบสถานะระบบเบื้องต้น

```powershell
# 1. ตรวจสอบสุขภาพระบบครบวงจร
.\HealthCheck_Sam_Att.ps1

# 2. ตรวจสอบสถานะ Windows Service
Get-Service -Name SamAttV2Standalone

# 3. ดู Log ล่าสุด 50 บรรทัด
Get-Content "D:\WebApps\Sam_Att\Logs\error.log" -Tail 50
Get-Content "D:\WebApps\Sam_Att\Logs\application.log" -Tail 50
```

---

## 3. แนวทางแก้ไขปัญหาที่พบบ่อย

### ปัญหาที่ 1: บริการ `SamAttV2Standalone` สตาร์ทไม่ขึ้น
- **สาเหตุที่พบบ่อย:**
  1. ค่า `JWT_SECRET` หรือ `INITIAL_ADMIN_PASSWORD` ใน `D:\WebApps\Sam_Att\Config\.env` ยังเป็นค่า Default
  2. ไฟล์ใบรับรอง `D:\WebApps\Sam_Att\Certs\cert.pem` หรือ `key.pem` ไม่มีอยู่ หรือคู่กุญแจไม่ตรงกัน
  3. พอร์ต `4101` ถูกใช้งานโดยโปรเซสอื่น
- **วิธีแก้ไข:**
  - เปิดดู `D:\WebApps\Sam_Att\Logs\service.err.log` และ `error.log`
  - รัน `.\Preflight_Sam_Att.ps1` เพื่อตรวจสอบสาเหตุแบบละเอียด

### ปัญหาที่ 2: เชื่อมต่อฐานข้อมูล MySQL (`10.1.0.201:3306`) ไม่ได้
- **วิธีตรวจสอบ:**
  ```powershell
  Test-NetConnection -ComputerName 10.1.0.201 -Port 3306
  npm run db:preflight
  ```
- ตรวจสอบว่า MySQL User ได้รับสิทธิ์เชื่อมต่อจาก IP `10.2.0.23` (`GRANT SELECT, INSERT, UPDATE, DELETE ON samchuk_attendance_v2.* TO 'user'@'10.2.0.23';`)

### ปัญหาที่ 3: GitHub Update Center แจ้ง `GITHUB_RATE_LIMITED`
- **วิธีแก้ไข:**
  - ระบบมี Cache TTL 30 นาที และ Single-Flight Coalescing ป้องกันการยิงซ้ำอัตโนมัติอยู่แล้ว
  - หากต้องการเพิ่มโควตาจาก 60 ครั้ง/ชั่วโมง เป็น 5,000 ครั้ง/ชั่วโมง ให้กำหนด `GITHUB_TOKEN=<Personal Access Token แบบ Read-Only>` ใน `D:\WebApps\Sam_Att\Config\.env` แล้วรีสตาร์ทบริการ `SamAttV2Standalone`
