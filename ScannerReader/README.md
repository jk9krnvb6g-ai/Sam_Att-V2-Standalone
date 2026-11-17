# โฟลเดอร์ `ScannerReader` — ชุดโปรแกรมดึงข้อมูลสแกนนิ้วของโรงพยาบาลสามชุก (`ScannerSyncCli.exe`)

โฟลเดอร์นี้บรรจุโปรแกรมดึงข้อมูลเครื่องสแกนลายนิ้วมือ (`ScannerSyncCli.exe`) พร้อมไฟล์ `.dll` ของชุด SDK เครื่องสแกนนิ้วครบทั้งหมด 21 ไฟล์

## รายการไฟล์ที่อยู่ในโฟลเดอร์นี้ (ตรวจสอบครบถ้วนแล้ว)

- **ไฟล์โปรแกรมหลัก (.NET 10.0 x86):**
  - `ScannerSyncCli.exe`
  - `ScannerSyncCli.dll`
  - `ScannerSyncCli.deps.json`
  - `ScannerSyncCli.runtimeconfig.json`
  - `ScannerSyncCli.pdb`
- **ไฟล์ SDK เครื่องสแกนลายนิ้วมือและใบหน้า (FKAttend / FK623 / RealSvr):**
  - `FK623Attend.dll`
  - `FKAttend.dll`
  - `FKPwdEncDec.dll`
  - `FKViaDev.dll`
  - `LFWViaDev.dll`
  - `FpDataConv.dll`
  - `FaceDataConv.dll`
  - `UniversalOfflineSDK.dll`
  - `Interop.RealSvrOcxTcpLib.dll`
  - `LIBCURL.DLL`
  - `mb.dll`
  - `ShockwaveFlashObjects.dll`
  - `stdole.dll`
- **ไฟล์เชื่อมต่อฐานข้อมูลและระบบ (.NET Libraries):**
  - `MySqlConnector.dll`
  - `Microsoft.Extensions.DependencyInjection.Abstractions.dll`
  - `Microsoft.Extensions.Logging.Abstractions.dll`

## เครื่องสแกนนิ้วที่ตั้งค่าอยู่ใน `ScannerSyncCli.exe`

1. **เครื่องที่ 1 (`--machine 1`):** `192.168.111.163` (Port `5005`)
2. **เครื่องที่ 2 (`--machine 2`):** `192.168.111.164` (Port `5005`)
3. **เครื่องที่ 3 (`--machine 3`):** `192.168.111.165` (Port `5005`)

## การเชื่อมต่อกับระบบ Sam_Att V2 Standalone

1. ระบบ Backend ตรวจพบ `./ScannerReader/ScannerSyncCli.exe` ในโฟลเดอร์นี้โดยอัตโนมัติ
2. เวลาสั่งซิงก์ ระบบจะรัน `ScannerSyncCli.exe` โดยกำหนด Working Directory (`cwd`) ให้เป็นโฟลเดอร์ `ScannerReader/` เพื่อให้โหลด `.dll` ทุกตัวในโฟลเดอร์นี้ได้ทันที
3. ระบบรองรับโครงสร้าง JSON ที่ `ScannerSyncCli.exe` ส่งออกมา (`{ success, totalRead, totalNew, duplicates, unmapped, affectedDates, machines, scans }`) โดยนำ `scans` ทั้ง 6 ฟิลด์ (`machineNo`, `enrollNumber`, `scanDateTime`, `verifyMode`, `inOutMode`, `workCode`) เข้าตาราง `raw_scans` แบบ Append-Only และอัปเดตสถานะของเครื่องสแกนแต่ละเครื่องจากฟิลด์ `machines` อัตโนมัติ
4. เมื่อนำไปรันบนเครื่อง Windows Server ของโรงพยาบาล ให้ตั้งค่าในไฟล์ `.env` ดังนี้:
   ```env
   SCANNER_SYNC_ENABLED=true
   SCANNER_AUTO_SCHEDULER_ENABLED=true
   SCANNER_READER_EXE_PATH=./ScannerReader/ScannerSyncCli.exe
   SCANNER_SYNC_DAYS=3
   SCANNER_CLI_PREVIEW_MODE=true
   ```
   *(หมายเหตุ: บนเครื่อง Windows Server ต้องติดตั้ง **.NET 10.0 Runtime (x86 / 32-bit)** เพื่อให้รัน `ScannerSyncCli.exe` และโหลดไฟล์ `.dll` แบบ 32-bit ได้)*
