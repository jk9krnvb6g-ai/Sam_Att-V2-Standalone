# คู่มือการตั้งค่าเครื่องสแกนลายนิ้วมือและ Standby Mode (`SCANNER_CONFIGURATION.md`)

เอกสารนี้อธิบายสถาปัตยกรรมการเชื่อมต่อเครื่องสแกนลายนิ้วมือของโรงพยาบาลสามชุกผ่าน `ScannerSyncCli.exe` รายการ Runtime / Native DLLs ที่ต้องใช้จริง และมาตรการป้องกันการดึงข้อมูลซ้ำซ้อนระหว่างการย้ายเซิร์ฟเวอร์จาก `10.2.0.13` มายัง `10.2.0.23`

---

## 1. สถาปัตยกรรม `ScannerSyncCli.exe`, การตรวจสอบ Binary PE Header และข้อกำหนด Runtime จริง (FIX 04 & Final Safety Patch FIX 05)

จากการตรวจสอบไฟล์ `ScannerReader/ScannerSyncCli.runtimeconfig.json`, `ScannerReader/ScannerSyncCli.deps.json` และการตรวจสอบ **PE Binary Header + Export/Import Table** ของไฟล์ `.exe` และ `.dll` ทั้ง 18 ไฟล์ในโฟลเดอร์ `ScannerReader/`:

- **ผลตรวจสอบ PE Header (Machine Type) ของทั้ง 18 ไฟล์:** ทุกไฟล์มีค่า Machine Type = **`0x014c` (`IMAGE_FILE_MACHINE_I386` / 32-bit `x86`) 100%** ไม่มีไฟล์ 64-bit (`0x8664`) ปะปน
- **Target Framework & Architecture:** `.NETCoreApp,Version=v10.0/win-x86` (**`.NET 10.0 Runtime (32-bit / x86)`**, `Microsoft.NETCore.App` version `10.0.0`)
- **ต้องติดตั้ง `.NET 10.0 Runtime (x86)` หรือ `(x64)` หรือทั้งคู่?:**
  - ต้องติดตั้ง **`.NET 10.0 Runtime (x86 / 32-bit)` เท่านั้น** (พาธ `C:\Program Files (x86)\dotnet\dotnet.exe`)
  - เนื่องจาก `ScannerSyncCli.exe` เป็น 32-bit (`x86`) AppHost และโหลด Native DLL 32-bit (`FK623Attend.dll`, `FKAttend.dll`) ในโปรเซสเดียวกัน (WOW64 บน Windows Server 64-bit) การติดตั้งเฉพาะ `.NET 10.0 Runtime (x64)` จะ**ไม่สามารถ**รัน `ScannerSyncCli.exe` ได้ (ส่วน `.NET 10.0 x64` ไม่จำเป็นสำหรับ `ScannerSyncCli.exe`)
- **การตรวจสอบ COM Registration (`regsvr32`):**
  - จากการตรวจสอบ PE Export Table ของ DLL ทั้ง 17 ไฟล์ใน `ScannerReader/` **ไม่มีไฟล์ใด Export ฟังก์ชัน `DllRegisterServer`**
  - จากการตรวจสอบ Import Table ของ `ScannerSyncCli.dll` ตัวโปรแกรมเรียกใช้ **`FK623Attend.dll`** โดยตรงผ่าน Win32 P/Invoke (`SetDllDirectory` ใน `kernel32.dll` -> `FK_ConnectNet`, `FK_DisConnect`, `FK_LoadGeneralLogData`, `FK_GetGeneralLogData_StringID`, `FK_GetLogDataIsSupportStringID`) และเชื่อมต่อ MySQL ผ่าน `MySqlConnector.dll` โดยไม่ได้เรียก `CoCreateInstance` ของ COM
  - **สรุป:** **ไม่ต้องรัน `regsvr32`** ลงทะเบียน COM DLL ใดๆ บน Production Server เพียงวางไฟล์ทั้ง 18 ไฟล์ไว้ในโฟลเดอร์ `D:\WebApps\Sam_Att\App\ScannerReader\` เดียวกันก็ทำงานได้ทันทีเมื่อมี `.NET 10.0 Runtime (x86)`
- **ตำแหน่งไฟล์ใน Production:** `D:\WebApps\Sam_Att\App\ScannerReader\ScannerSyncCli.exe`
- **พาธ .NET Host ที่ต้องการบน Windows Server (64-bit):** `C:\Program Files (x86)\dotnet\dotnet.exe`
- **เครื่องสแกนลายนิ้วมือของโรงพยาบาลสามชุก (พอร์ต TCP `5005`):**
  1. เครื่องที่ 1 (`10.2.0.51:5005`) — อาคารผู้ป่วยนอก (OPD)
  2. เครื่องที่ 2 (`10.2.0.52:5005`) — อาคารอุบัติเหตุฉุกเฉิน (ER)
  3. เครื่องที่ 3 (`10.2.0.53:5005`) — อาคารสำนักงานบริหาร

### รายการไฟล์และผลการตรวจสอบ PE Header / COM Registration ในโฟลเดอร์ `ScannerReader/`

| ไฟล์ใน `ScannerReader/` | PE Machine Type | ชนิดไบนารี | Export `DllRegisterServer` | บทบาทจริงในการทำงานของ `ScannerSyncCli.exe` |
| :--- | :---: | :---: | :---: | :--- |
| `ScannerSyncCli.exe` | `0x014c` (`x86`) | Native .NET 10.0 AppHost | ไม่มี | ตัวรันหลัก (32-bit AppHost โหลด `ScannerSyncCli.dll`) |
| `ScannerSyncCli.dll` | `0x014c` (`x86`) | Managed .NET 10.0 Assembly | ไม่มี | ลอจิกหลัก เรียก P/Invoke `FK623Attend.dll` และบันทึกผ่าน `MySqlConnector.dll` |
| `FK623Attend.dll` | `0x014c` (`x86`) | Native Win32 DLL | ไม่มี | **ไดรเวอร์หลัก** ที่ถูก P/Invoke (`FK_ConnectNet`, `FK_LoadGeneralLogData` ฯลฯ) |
| `FKAttend.dll` | `0x014c` (`x86`) | Native Win32 DLL | ไม่มี | Core Protocol ของตระกูลเครื่องสแกน FK |
| `FKPwdEncDec.dll`, `FKViaDev.dll`, `LFWViaDev.dll`, `FpDataConv.dll`, `FaceDataConv.dll`, `UniversalOfflineSDK.dll`, `LIBCURL.DLL`, `mb.dll` | `0x014c` (`x86`) | Native Win32 Helper DLLs | ไม่มี | ไลบรารีประกอบของชุด SDK เครื่องสแกนนิ้ว (โหลดในโฟลเดอร์เดียวกันผ่าน `SetDllDirectory`) |
| `MySqlConnector.dll` (2.6.2), `Microsoft.Extensions.*.dll` (8.0.2) | `0x014c` (`x86`) | Managed .NET Assemblies | ไม่มี | ไดรเวอร์เชื่อมต่อฐานข้อมูล MySQL และ Logging |
| `Interop.RealSvrOcxTcpLib.dll`, `ShockwaveFlashObjects.dll`, `stdole.dll` | `0x014c` (`x86`) | Managed COM Interop Wrappers | ไม่มี | ไฟล์ Wrapper ที่ติดมากับชุด SDK เดิม (ไม่ได้ถูกเรียกใช้ในโหมด TCP Polling ของ `ScannerSyncCli.dll` และไม่ต้อง `regsvr32`) |

> **กฎความปลอดภัย:** สคริปต์ติดตั้ง (`Install_Sam_Att.ps1`) และสคริปต์ตรวจสอบความพร้อม (`Preflight_Sam_Att.ps1`) จะตรวจสอบการมีอยู่ของ `.NET 10.0 Runtime (x86)` และไฟล์ DLL ทั้งหมดแบบ Read-Only เท่านั้น **ห้ามติดตั้ง Runtime หรือรัน `regsvr32` บน Production Server โดยอัตโนมัติ**

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
