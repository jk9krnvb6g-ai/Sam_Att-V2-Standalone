# คู่มือการตั้งค่าเครื่องสแกนลายนิ้วมือและ Standby Mode (`SCANNER_CONFIGURATION.md`)

เอกสารนี้อธิบายสถาปัตยกรรมการเชื่อมต่อเครื่องสแกนลายนิ้วมือของโรงพยาบาลสามชุกผ่าน `ScannerSyncCli.exe` รายการ Runtime / Native DLLs ที่ต้องใช้จริง และมาตรการป้องกันการดึงข้อมูลซ้ำซ้อนระหว่างการย้ายเซิร์ฟเวอร์จาก `10.2.0.13` มายัง `10.2.0.23`

---

## 1. สถาปัตยกรรม `ScannerSyncCli.exe` และข้อกำหนด Runtime จริง (FIX 04)

จากการตรวจสอบไฟล์ `ScannerReader/ScannerSyncCli.runtimeconfig.json` และ `ScannerReader/ScannerSyncCli.deps.json`:

- **Target Framework & Architecture:** `.NETCoreApp,Version=v10.0/win-x86` (**`.NET 10.0 Runtime (32-bit / x86)`**, `Microsoft.NETCore.App` version `10.0.0`)
- **ตำแหน่งไฟล์ใน Production:** `D:\WebApps\Sam_Att\App\ScannerReader\ScannerSyncCli.exe`
- **พาธ .NET Host ที่ต้องการบน Windows Server (64-bit):** `C:\Program Files (x86)\dotnet\dotnet.exe`
- **เครื่องสแกนลายนิ้วมือของโรงพยาบาลสามชุก (พอร์ต TCP `5005`):**
  1. เครื่องที่ 1 (`10.2.0.51:5005`) — อาคารผู้ป่วยนอก (OPD)
  2. เครื่องที่ 2 (`10.2.0.52:5005`) — อาคารอุบัติเหตุฉุกเฉิน (ER)
  3. เครื่องที่ 3 (`10.2.0.53:5005`) — อาคารสำนักงานบริหาร

### รายการไฟล์และ Native / Managed 32-bit DLLs ในโฟลเดอร์ `ScannerReader/`
```text
ScannerReader/
├── ScannerSyncCli.exe
├── ScannerSyncCli.dll
├── ScannerSyncCli.deps.json
├── ScannerSyncCli.runtimeconfig.json
├── FK623Attend.dll
├── FKAttend.dll
├── FKPwdEncDec.dll
├── FKViaDev.dll
├── LFWViaDev.dll
├── FpDataConv.dll
├── FaceDataConv.dll
├── UniversalOfflineSDK.dll
├── Interop.RealSvrOcxTcpLib.dll
├── LIBCURL.DLL
├── mb.dll
├── ShockwaveFlashObjects.dll
├── stdole.dll
├── MySqlConnector.dll (v2.6.2)
├── Microsoft.Extensions.DependencyInjection.Abstractions.dll (v8.0.2)
└── Microsoft.Extensions.Logging.Abstractions.dll (v8.0.2)
```

> **กฎความปลอดภัย:** สคริปต์ติดตั้ง (`Install_Sam_Att.ps1`) และสคริปต์ตรวจสอบความพร้อม (`Preflight_Sam_Att.ps1`) จะตรวจสอบการมีอยู่ของ `.NET 10.0 Runtime (x86)` และไฟล์ DLL ทั้งหมดแบบ Read-Only เท่านั้น **ห้ามติดตั้ง Runtime หรือรัน `regsvr32` ลงทะเบียน COM DLL โดยอัตโนมัติโดยไม่ได้รับอนุมัติจากผู้ดูแลระบบ**

---

## 2. มาตรการความปลอดภัย: Scanner Standby Mode (`SCANNER_AUTO_SCHEDULER_ENABLED=false`)

ในระหว่างที่เซิร์ฟเวอร์เดิม (`10.2.0.13`) ยังคงเปิดใช้งานและดึงข้อมูลจากเครื่องสแกนลายนิ้วมืออยู่ เซิร์ฟเวอร์ใหม่ (`10.2.0.23`) **จะต้องอยู่ในโหมด Standby** เพื่อไม่ให้ทั้งสองเซิร์ฟเวอร์แย่งกันเชื่อมต่อเครื่องสแกนพร้อมกัน

### การตั้งค่าเริ่มต้นใน Production (`10.2.0.23`):
ในไฟล์ `D:\WebApps\Sam_Att\Config\.env` และ `D:\WebApps\Sam_Att\Service\SamAttV2Standalone.xml`:
```dotenv
SCANNER_AUTO_SCHEDULER_ENABLED=false
```

### พฤติกรรมของระบบเมื่อ `SCANNER_AUTO_SCHEDULER_ENABLED=false`:
1. ระบบตั้งเวลาดึงข้อมูลอัตโนมัติ (Background Cron Scheduler) จะ**ไม่ทำงาน** (อยู่ในโหมด `STANDBY`)
2. หน้าเว็บ `/Sam_Att/` และ API `/api/Sam_Att/health/ready` ยังคงสถานะ **`READY`** ตามปกติ (พร้อมแจ้ง `"autoSchedulerEnabled": false, "status": "READY_OR_STANDBY"`)
3. ผู้ดูแลระบบสามารถทดสอบระบบทุกส่วนบน `10.2.0.23` ได้อย่างปลอดภัยโดยไม่รบกวนเครื่องสแกนจริงและไม่กระทบเซิร์ฟเวอร์ `10.2.0.13`

---

## 3. การตรวจสอบความพร้อมของ `.NET 10.0 Runtime (x86)` บน Windows Server

ผู้ดูแลระบบสามารถตรวจสอบว่าเครื่องแม่ข่าย `10.2.0.23` มี `.NET 10.0 Runtime (x86)` พร้อมหรือยังด้วยคำสั่ง:

```powershell
& "C:\Program Files (x86)\dotnet\dotnet.exe" --list-runtimes
```
ต้องพบรายการ `Microsoft.NETCore.App 10.0.x` ในผลลัพธ์

---

## 4. การเปิดใช้งาน Scanner Auto Scheduler หลังได้รับอนุมัติ Cutover

เมื่อหยุดระบบซิงก์สแกนนิ้วบนเซิร์ฟเวอร์เดิม (`10.2.0.13`) และได้รับอนุมัติ Cutover เรียบร้อยแล้วเท่านั้น ให้แก้ไขไฟล์ `D:\WebApps\Sam_Att\Config\.env` บนเครื่อง `10.2.0.23`:

```dotenv
SCANNER_AUTO_SCHEDULER_ENABLED=true
```
*(และปรับ `<env name="SCANNER_AUTO_SCHEDULER_ENABLED" value="true" />` ใน `D:\WebApps\Sam_Att\Service\SamAttV2Standalone.xml` หากกำหนดไว้ใน XML)* จากนั้นรีสตาร์ทเฉพาะบริการ `SamAttV2Standalone`:

```powershell
Restart-Service -Name SamAttV2Standalone
```
