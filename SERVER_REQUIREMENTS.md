# ข้อกำหนดเครื่องแม่ข่ายและสภาพแวดล้อม (`SERVER_REQUIREMENTS.md`)

เอกสารนี้ระบุข้อกำหนดด้าน Hardware, Operating System, Runtime, Native DLLs และ Network สำหรับเครื่องแม่ข่าย **Sam_Att V2 Standalone** (`10.2.0.23`)

---

## 1. ข้อกำหนดด้าน Hardware และ Operating System

| รายการ | ข้อกำหนดขั้นต่ำ / มาตรฐานที่ใช้งานจริง |
| :--- | :--- |
| **Operating System** | Windows Server 2025 Standard Evaluation (64-bit) |
| **Server IP Address** | `10.2.0.23` |
| **CPU** | 4 vCPU ขึ้นไป (x64 Architecture) |
| **RAM** | 8 GB ขึ้นไป (แนะนำ 16 GB) |
| **System Drive (`C:\`)** | พื้นที่ว่างอย่างน้อย 20 GB สำหรับ OS และ Runtimes |
| **Application Drive (`D:\`)** | พื้นที่ว่างอย่างน้อย 20 GB (ขั้นต่ำที่ Preflight บังคับ >= 5 GB) สำหรับ `D:\WebApps\Sam_Att`, `D:\Backups\Sam_Att`, `D:\Deployments\Sam_Att` |
| **Timezone** | `SE Asia Standard Time` (`UTC+07:00` Bangkok, Hanoi, Jakarta / `Asia/Bangkok`) |

---

## 2. ซอฟต์แวร์และ Runtime ที่ต้องติดตั้ง (Verified Runtime Compatibility — FIX 03 & FIX 05)

1. **Node.js Runtime (64-bit):**
   - **เวอร์ชันที่รองรับ (`package.json -> engines.node`):** `>=22.0.0 <27.0.0`
   - **การตรวจสอบความเข้ากันได้ตามความจริง (Honest Verification Status):**
     - **Node.js `v22.22.0` LTS:** รันชุดทดสอบอัตโนมัติ (`npm run typecheck`, `npm run lint`, `npm test` 154 tests, `npm run build`) ผ่านจริง 100% ในสภาพแวดล้อม Build/Test ปัจจุบัน
     - **Node.js `22.x` และ `26.x` บน GitHub Actions Windows Matrix:** กำหนดใน `.github/workflows/ci.yml` (`runs-on: windows-latest`)
     - **Node.js `v26.13.1` (เวอร์ชันที่ติดตั้งจริงบน Windows Server `10.2.0.23`):** สคริปต์ `Preflight_Sam_Att.ps1`, `Install_Sam_Att.ps1` และ `Deploy_Sam_Att.ps1` ผูกการใช้งาน `node.exe` และ `npm.cmd` เข้ากับพาธ `-NodeExecutablePath` ที่เลือกโดยตรง (รวมถึงขั้นตอน `npm run typecheck`, `npm run lint`, Isolated `npm test`, `npm run build`, `cli-preflight.ts` และ `SamAttV2Standalone.xml`) เพื่อให้การตรวจสอบและการรัน Windows Service บนเครื่องจริงใช้ Node.js `v26.13.1` ตัวเดียวกันทั้งหมด
2. **Git for Windows (64-bit):**
   - ใช้สำหรับดึง Source Code และตรวจสอบ Commit SHA จาก GitHub Repository (`https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone`)
3. **.NET 10.0 Runtime (x86 / 32-bit เท่านั้น) สำหรับ `ScannerSyncCli.exe` (ยืนยันจาก PE Header `0x014c`):**
   - จากการตรวจสอบ PE Binary Header ของ `ScannerSyncCli.exe` และไฟล์ `.dll` ทั้ง 17 ไฟล์ใน `ScannerReader/` ทุกไฟล์มีค่า Machine Type = **`0x014c` (`IMAGE_FILE_MACHINE_I386` / 32-bit `x86`) 100%** และ `ScannerSyncCli.deps.json` ระบุ `.NETCoreApp,Version=v10.0/win-x86`
   - **ต้องติดตั้งเฉพาะ `.NET 10.0 Runtime (x86 / 32-bit)`** ที่พาธ `C:\Program Files (x86)\dotnet\dotnet.exe` (การติดตั้งเฉพาะ x64 จะไม่สามารถบูต 32-bit AppHost `ScannerSyncCli.exe` ได้)
   - **ไม่ต้องรัน `regsvr32` ลงทะเบียน COM DLL:** จากการตรวจ PE Export/Import Table ของ DLL ทั้ง 17 ไฟล์ ไม่มีไฟล์ใด Export `DllRegisterServer` และ `ScannerSyncCli.dll` เรียกใช้ `FK623Attend.dll` ผ่าน Win32 P/Invoke (`SetDllDirectory` + `FK_ConnectNet` / `FK_LoadGeneralLogData`) โดยตรง
4. **WinSW (Windows Service Wrapper v2.x / v3.x x64):**
   - ใช้สำหรับรัน Node.js เป็น Windows Service ภายใต้ชื่อ `SamAttV2Standalone`
   - วางไฟล์ Executable ไว้ที่ `D:\WebApps\Sam_Att\Service\SamAttV2Standalone.exe` คู่กับ `SamAttV2Standalone.xml`

---

## 3. ข้อกำหนดด้านเครือข่ายและไฟร์วอลล์ (Scoped Firewall Policy — FIX 02)

| ทิศทาง | ต้นทาง (Allowed Remote Scope) | ปลายทาง | พอร์ต / โปรโตคอล | วัตถุประสงค์ |
| :--- | :--- | :--- | :--- | :--- |
| **Inbound** | เฉพาะเครือข่ายภายใน รพ.สามชุก ที่ผู้ดูแลระบบระบุใน `-FirewallRemoteAddress` (เช่น `10.2.0.0/24,10.1.0.0/24`) | `10.2.0.23` | **TCP `4101`** (HTTPS เท่านั้น) | เข้าใช้งานหน้าเว็บ `/Sam_Att/` และ API `/api/Sam_Att/` |
| **Outbound** | `10.2.0.23` | `10.1.0.201` | **TCP `3306`** (MySQL) | เชื่อมต่อฐานข้อมูล `samchuk_attendance_v2` |
| **Outbound** | `10.2.0.23` | `10.1.0.201` | **TCP `3306`** (MySQL Read-Only) | ซิงก์ข้อมูลบุคลากรจาก HOSOffice (`hr_person` เฉพาะ SELECT) |
| **Outbound** | `10.2.0.23` | `10.2.0.51`, `10.2.0.52`, `10.2.0.53` | **TCP `5005`** | ดึงข้อมูลเวลาเข้า-ออกงานจากเครื่องสแกนลายนิ้วมือ |
| **Outbound** | `10.2.0.23` | `github.com` / `api.github.com` | **TCP `443`** (HTTPS) | ตรวจสอบและอัปเดตเวอร์ชันผ่าน GitHub Update Center |

> **กฎความปลอดภัย Firewall (FIX 02):** `Install_Sam_Att.ps1` ยกเลิกค่าเริ่มต้นที่เปิดกว้าง (`LocalSubnet,10.0.0.0/8,192.168.0.0/16`) แล้ว ผู้ดูแลระบบต้องระบุ `-FirewallRemoteAddress` ให้ตรงกับวงเครือข่ายของโรงพยาบาลเท่านั้น และสคริปต์จะไม่เปิดพอร์ตอื่นนอกจาก TCP `4101`
