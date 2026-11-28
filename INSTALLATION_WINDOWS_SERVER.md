# คู่มือการติดตั้งบน Windows Server 2025 (`INSTALLATION_WINDOWS_SERVER.md`)

เอกสารนี้อธิบายขั้นตอนการติดตั้งระบบ **Sam_Att V2 Standalone** บนเครื่องแม่ข่าย **Windows Server 2025 Standard Evaluation (`10.2.0.23`)**

---

## 1. ขั้นตอนเตรียมความพร้อมก่อนติดตั้ง (Pre-Installation)

1. เข้าสู่ระบบ Windows Server `10.2.0.23` ด้วยสิทธิ์ **Administrator**
2. ตรวจสอบว่ามีไดรฟ์ `D:\` พร้อมพื้นที่ว่างอย่างน้อย 10 GB
3. ติดตั้งโปรแกรมพื้นฐานบนเครื่องแม่ข่าย:
   - **Node.js LTS** (แนะนำ v22.x หรือ v24.x 64-bit)
   - **Git for Windows**
   - **.NET Framework 4.8 Runtime / Developer Pack** (สำหรับ `ScannerReader.exe`)
   - **WinSW (Windows Service Wrapper x64)** วางไว้ที่ `D:\WebApps\Sam_Att\Service\SamAttV2Standalone.exe` หรือ `D:\Installers\winsw.exe`

---

## 2. การตรวจสอบความพร้อมแบบ Read-Only (Preflight Check)

ก่อนติดตั้งจริง ให้เปิด **Windows PowerShell (Run as Administrator)** ไปยังโฟลเดอร์โปรเจกต์ แล้วรันคำสั่ง:

```powershell
.\Preflight_Sam_Att.ps1 -MySqlHost 10.1.0.201 -MySqlPort 3306
```

หรือจำลองการติดตั้งโดยไม่แก้ไขระบบ (`-DryRun`):

```powershell
.\Install_Sam_Att.ps1 -Mode Preflight -DryRun
```

สคริปต์จะตรวจสอบ:
- สิทธิ์ Administrator, Windows Server OS, Timezone (`SE Asia Standard Time` / `Asia/Bangkok`)
- พื้นที่ว่างบน `D:\`
- เวอร์ชันของ Node.js, npm, Git, .NET Framework 4.8
- พอร์ต `4101` ว่าว่างหรือไม่
- การเชื่อมต่อ TCP ไปยัง MySQL `10.1.0.201:3306`
- ตรวจสอบ Schema ของฐานข้อมูล `samchuk_attendance_v2` แบบ **Read-Only 100%** (`npm run db:preflight`)

---

## 3. การติดตั้งระบบแบบ One-Click (Fresh Install)

สามารถคลิกขวาที่ไฟล์ `Install_Sam_Att.bat` แล้วเลือก **Run as administrator** หรือรันผ่าน PowerShell:

```powershell
.\Install_Sam_Att.ps1 -Mode FreshInstall
```

### สิ่งที่ Installer ดำเนินการอัตโนมัติ (20 ขั้นตอน):
1. สร้างโครงสร้างโฟลเดอร์มาตรฐานบน `D:\WebApps\Sam_Att`, `D:\Backups\Sam_Att`, `D:\Deployments\Sam_Att`
2. รับค่าตั้งค่าที่จำเป็น (MySQL User/Password แบบ SecureString ไม่แสดงรหัสผ่านบนหน้าจอ) และสร้างไฟล์ `D:\WebApps\Sam_Att\Config\.env` (พร้อมตั้ง `SCANNER_AUTO_SCHEDULER_ENABLED=false` เป็นค่าเริ่มต้นเพื่อป้องกันการชนกับเครื่องเดิม `10.2.0.13`)
3. ตรวจสอบหรือสร้างใบรับรอง HTTPS (`D:\WebApps\Sam_Att\Certs\cert.pem` และ `key.pem`) ที่มี SAN `IP:10.2.0.23`
4. คัดลอก Source Code ไปยัง `D:\WebApps\Sam_Att\App`
5. ติดตั้ง Dependencies (`npm ci`), ตรวจสอบ TypeScript (`npm run lint`) และ Build Frontend (`npm run build`)
6. คอมไพล์หรือตรวจสอบ `ScannerReader.exe` (32-bit x86)
7. รัน Read-Only Database Preflight (`npm run db:preflight`) เพื่อยืนยันความพร้อมของฐานข้อมูล `samchuk_attendance_v2` โดยไม่แก้ไขข้อมูล
8. ตั้งค่า Windows Firewall Rule ชื่อ **`Sam_Att V2 HTTPS 4101`** (Inbound TCP Port `4101`)
9. ลงทะเบียนและเริ่มทำงาน Windows Service **`SamAttV2Standalone`** (Automatic Delayed Start)
10. รัน `HealthCheck_Sam_Att.ps1` และบันทึกผลลงไฟล์ `D:\WebApps\Sam_Att\Logs\install-report.json`

---

## 4. โหมดการทำงานอื่นของ Installer

- **ซ่อมแซมระบบ (Repair):**
  ```powershell
  .\Install_Sam_Att.ps1 -Mode Repair
  ```
- **อัปเกรดระบบ (Upgrade):**
  ```powershell
  .\Install_Sam_Att.ps1 -Mode Upgrade
  ```
- **ถอนการติดตั้งเฉพาะ Service (Uninstall):**
  ```powershell
  .\Install_Sam_Att.ps1 -Mode Uninstall
  ```

---

## 5. การตรวจสอบหลังติดตั้งเสร็จสมบูรณ์

รันคำสั่งตรวจสอบสุขภาพระบบ:

```powershell
.\HealthCheck_Sam_Att.ps1
```

และเปิดเบราว์เซอร์เข้าใช้งานที่:
- **หน้าเว็บผู้ใช้งาน:** `https://10.2.0.23:4101/Sam_Att/`
- **ตรวจสอบสถานะ API:** `https://10.2.0.23:4101/api/Sam_Att/health`
