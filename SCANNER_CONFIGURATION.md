# คู่มือการตั้งค่าเครื่องสแกนลายนิ้วมือและ Standby Mode (`SCANNER_CONFIGURATION.md`)

เอกสารนี้อธิบายสถาปัตยกรรมการเชื่อมต่อเครื่องสแกนลายนิ้วมือ ZKTeco (`ScannerReader.exe`) และมาตรการป้องกันการดึงข้อมูลซ้ำซ้อนระหว่างการย้ายเซิร์ฟเวอร์จาก `10.2.0.13` มายัง `10.2.0.23`

---

## 1. สถาปัตยกรรม Scanner Bridge (`ScannerReader.exe`)

- **เทคโนโลยี:** C# (.NET Framework 4.8) คอมไพล์แบบ **32-bit (`x86`)**
- **ตำแหน่งไฟล์ใน Production:** `D:\WebApps\Sam_Att\App\ScannerReader\bin\Release\ScannerReader.exe`
- **COM Component:** `zkemkeeper.ZKEM.1` (`zkemkeeper.dll` 32-bit ลงทะเบียนผ่าน `C:\Windows\SysWOW64\regsvr32.exe`)
- **พอร์ตสื่อสารมาตรฐาน:** TCP `4370`

---

## 2. มาตรการความปลอดภัย: Scanner Standby Mode (`SCANNER_AUTO_SCHEDULER_ENABLED=false`)

ในระหว่างที่เซิร์ฟเวอร์เดิม (`10.2.0.13`) ยังคงเปิดใช้งานและดึงข้อมูลจากเครื่องสแกนลายนิ้วมืออยู่ เซิร์ฟเวอร์ใหม่ (`10.2.0.23`) **จะต้องอยู่ในโหมด Standby** เพื่อไม่ให้ทั้งสองเซิร์ฟเวอร์แย่งกันเชื่อมต่อเครื่องสแกนพร้อมกันที่พอร์ต `4370`

### การตั้งค่าเริ่มต้นใน Production (`10.2.0.23`):
ในไฟล์ `D:\WebApps\Sam_Att\Config\.env` และ `SamAttV2Standalone.xml`:
```dotenv
SCANNER_AUTO_SCHEDULER_ENABLED=false
```

### พฤติกรรมของระบบเมื่อ `SCANNER_AUTO_SCHEDULER_ENABLED=false`:
1. ระบบตั้งเวลาดึงข้อมูลอัตโนมัติ (Background Cron Scheduler) จะ**ไม่ทำงาน**
2. หน้าเว็บ `/Sam_Att/` และ API `/api/Sam_Att/health/ready` ยังคงสถานะ **`ready`** ตามปกติ (พร้อมแจ้ง `"autoSchedulerEnabled": false, "standbyMode": true`)
3. ผู้ดูแลระบบสามารถทดสอบระบบทุกส่วนบน `10.2.0.23` ได้อย่างปลอดภัยโดยไม่รบกวนเครื่องสแกนจริง

---

## 3. การลงทะเบียน `zkemkeeper.dll` (32-bit COM SDK) บน Windows Server 2025

เมื่อต้องการให้เซิร์ฟเวอร์ `10.2.0.23` เชื่อมต่อเครื่องสแกนโดยตรง ให้คัดลอกไฟล์ SDK ของ ZKTeco (32-bit) ไปยัง `C:\Windows\SysWOW64\` แล้วรันคำสั่งใน PowerShell (Run as Administrator):

```powershell
C:\Windows\SysWOW64\regsvr32.exe C:\Windows\SysWOW64\zkemkeeper.dll
```

ตรวจสอบการลงทะเบียน COM Class:

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\Classes\WOW6432Node\CLSID\{00853A19-BD51-419B-9269-2DABE57EB61F}" -ErrorAction SilentlyContinue
```

---

## 4. การเปิดใช้งาน Scanner Auto Scheduler หลัง Cutover

เมื่อหยุดระบบบนเซิร์ฟเวอร์เดิม (`10.2.0.13`) เรียบร้อยแล้วเท่านั้น ให้แก้ไขไฟล์ `D:\WebApps\Sam_Att\Config\.env` บนเครื่อง `10.2.0.23`:

```dotenv
SCANNER_AUTO_SCHEDULER_ENABLED=true
```

และรีสตาร์ทเฉพาะบริการ `SamAttV2Standalone`:

```powershell
Restart-Service -Name SamAttV2Standalone
```
