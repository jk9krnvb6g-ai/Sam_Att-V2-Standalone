# คู่มือการอัปเดตระบบจาก GitHub (`DEPLOYMENT_GUIDE.md`)

เอกสารนี้อธิบายขั้นตอนการอัปเดตระบบ **Sam_Att V2 Standalone** จาก GitHub Repository (`https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone`, Branch `main`) แบบ **Zero-Breakage Staging Deployment**

---

## 1. หลักการอัปเดตแบบ Zero-Breakage Staging Deployment

เพื่อไม่ให้ระบบที่ใช้งานจริง (`D:\WebApps\Sam_Att\App` และเซอร์วิส `SamAttV2Standalone`) หยุดทำงานหากเกิดข้อผิดพลาดระหว่างดาวน์โหลดโค้ดหรือคอมไพล์ กระบวนการอัปเดตจะทำงานดังนี้:

1. **Pre-Check & Lock:** ตรวจสอบไฟล์ Lock (`D:\Deployments\Sam_Att\deploy.lock`) และตรวจสอบสุขภาพระบบปัจจุบัน
2. **Staging Build & Test (ขณะที่ระบบจริงยังเปิดให้บริการตามปกติ):**
   - เตรียมโฟลเดอร์ชั่วคราวใน `D:\Deployments\Sam_Att\staging_<timestamp>`
   - ดึงโค้ดล่าสุดจาก GitHub (`main`)
   - ตรวจสอบว่าไม่มีการแก้ไขไฟล์ Database Schema (`database/migrations/*`)
   - รัน `npm ci`, `npm run lint` (TypeScript Check), `npm run build` (Frontend Production Build) และ `npm run db:preflight` (Read-Only MySQL Verification) ในโฟลเดอร์ Staging
   - **หากขั้นตอนใดใน Staging ล้มเหลว ระบบจะยกเลิกการอัปเดตทันทีโดยที่เซอร์วิส `SamAttV2Standalone` ไม่เคยถูกหยุดเลย**
3. **Backup Current Release:** สำรองโค้ดปัจจุบันจาก `D:\WebApps\Sam_Att\App` ไปยัง `D:\Backups\Sam_Att\release_<timestamp>_<commit>`
4. **Controlled Service Switch:**
   - หยุดเฉพาะ Windows Service `SamAttV2Standalone` (ห้ามใช้ `taskkill /F /IM node.exe`)
   - คัดลอกไฟล์ที่ผ่านการ Build และตรวจสอบแล้วจาก Staging ไปยัง `D:\WebApps\Sam_Att\App` (โดยไม่แตะต้อง `D:\WebApps\Sam_Att\Config\.env` และ `D:\WebApps\Sam_Att\Certs`)
   - เริ่มทำงาน Windows Service `SamAttV2Standalone`
5. **Post-Deploy Health Verification & Auto-Rollback:**
   - ตรวจสอบ `/api/Sam_Att/health/live`, `/api/Sam_Att/health/ready`, `/api/Sam_Att/health` และ `/Sam_Att/`
   - หากไม่ผ่าน Health Check ระบบจะรัน `Rollback_Sam_Att.ps1` เพื่อนำเวอร์ชันก่อนหน้ากลับมาทำงานโดยอัตโนมัติ

---

## 2. วิธีอัปเดตระบบ (เลือกได้ 2 ช่องทาง)

### ช่องทางที่ 1: อัปเดตผ่านหน้าเว็บ (GitHub Update Center)
1. เข้าสู่ระบบผู้ดูแลระบบที่ `https://10.2.0.23:4101/Sam_Att/`
2. ไปที่เมนู **ศูนย์อัปเดตระบบ (GitHub Update Center)**
3. กดปุ่ม **ตรวจสอบอัปเดตล่าสุด** เพื่อดูรายการ Commit ที่เปลี่ยนแปลง
4. กดปุ่ม **อัปเดตระบบทันที (One-Click Update)**

### ช่องทางที่ 2: อัปเดตผ่าน PowerShell (Run as Administrator)
```powershell
# ตรวจสอบการอัปเดตแบบจำลอง (Dry Run)
.\Deploy_Sam_Att.ps1 -Branch main -DryRun

# อัปเดตระบบจริงจาก Branch main
.\Deploy_Sam_Att.ps1 -Branch main
```
