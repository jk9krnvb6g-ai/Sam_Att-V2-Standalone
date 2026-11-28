# ข้อกำหนดเครื่องแม่ข่ายและสภาพแวดล้อม (`SERVER_REQUIREMENTS.md`)

เอกสารนี้ระบุข้อกำหนดด้าน Hardware, Operating System, Software และ Network สำหรับเครื่องแม่ข่าย **Sam_Att V2 Standalone** (`10.2.0.23`)

---

## 1. ข้อกำหนดด้าน Hardware และ Operating System

| รายการ | ข้อกำหนดขั้นต่ำ / มาตรฐานที่ใช้งานจริง |
| :--- | :--- |
| **Operating System** | Windows Server 2025 Standard Evaluation (64-bit) |
| **Server IP Address** | `10.2.0.23` |
| **CPU** | 4 vCPU ขึ้นไป (x64 Architecture) |
| **RAM** | 8 GB ขึ้นไป (แนะนำ 16 GB) |
| **System Drive (`C:\`)** | พื้นที่ว่างอย่างน้อย 20 GB สำหรับ OS และ Runtime |
| **Application Drive (`D:\`)** | พื้นที่ว่างอย่างน้อย 20 GB สำหรับ `D:\WebApps\Sam_Att`, `D:\Backups\Sam_Att`, `D:\Deployments\Sam_Att` |
| **Timezone** | `SE Asia Standard Time` (`UTC+07:00` Bangkok, Hanoi, Jakarta / `Asia/Bangkok`) |

---

## 2. ซอฟต์แวร์พื้นฐานที่ต้องติดตั้ง (Required Software)

1. **Node.js Runtime (64-bit):**
   - เวอร์ชันที่รองรับ: Node.js LTS `v22.x` หรือ `v24.x` (เช่น `v24.13.0`)
   - ต้องมี `node.exe` และ `npm.cmd` อยู่ใน System `PATH`
2. **Git for Windows (64-bit):**
   - ใช้สำหรับดึง Source Code และตรวจสอบ Commit SHA จาก GitHub Repository (`https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone`)
3. **.NET Framework 4.8:**
   - ใช้สำหรับรันและคอมไพล์ `ScannerReader.exe` (`csc.exe` / MSBuild กำหนด PlatformTarget = `x86`)
4. **WinSW (Windows Service Wrapper v2.x / v3.x x64):**
   - ใช้สำหรับรัน Node.js เป็น Windows Service ภายใต้ชื่อ `SamAttV2Standalone`
   - วางไฟล์ Executable ไว้ที่ `D:\WebApps\Sam_Att\Service\SamAttV2Standalone.exe`
5. **ZKTeco 32-bit COM SDK (`zkemkeeper.dll`):**
   - ใช้สำหรับเชื่อมต่อเครื่องสแกนลายนิ้วมือ ZKTeco (เมื่อต้องการเปิดใช้งานโหมดซิงก์เครื่องสแกนบนเซิร์ฟเวอร์นี้)
   - ลงทะเบียนผ่าน `C:\Windows\SysWOW64\regsvr32.exe zkemkeeper.dll`

---

## 3. ข้อกำหนดด้านเครือข่ายและไฟร์วอลล์ (Network & Firewall Requirements)

| ทิศทาง | ต้นทาง | ปลายทาง | พอร์ต / โปรโตคอล | วัตถุประสงค์ |
| :--- | :--- | :--- | :--- | :--- |
| **Inbound** | เครือข่ายภายใน รพ.สามชุก (Clients) | `10.2.0.23` | **TCP `4101`** (HTTPS) | เข้าใช้งานหน้าเว็บ `/Sam_Att/` และ API `/api/Sam_Att/` |
| **Outbound** | `10.2.0.23` | `10.1.0.201` | **TCP `3306`** (MySQL) | เชื่อมต่อฐานข้อมูล `samchuk_attendance_v2` |
| **Outbound** | `10.2.0.23` | `10.1.0.201` (หรือ HOSxP DB) | **TCP `3306`** (MySQL Read-Only) | ซิงก์ข้อมูลบุคลากรจาก HOSOffice/HOSxP (เฉพาะ SELECT) |
| **Outbound** | `10.2.0.23` | IP เครื่องสแกนลายนิ้วมือ | **TCP `4370`** (ZKTeco) | ดึงข้อมูลเวลาเข้า-ออกงานจากเครื่องสแกน |
| **Outbound** | `10.2.0.23` | `github.com` / `api.github.com` | **TCP `443`** (HTTPS) | ตรวจสอบและอัปเดตเวอร์ชันผ่าน GitHub Update Center |
