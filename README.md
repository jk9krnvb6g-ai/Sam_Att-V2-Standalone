# Sam_Att V2 Standalone — ระบบบริหารจัดการเวลาปฏิบัติงาน โรงพยาบาลสามชุก

ระบบบริหารจัดการเวลาปฏิบัติงานรุ่น Standalone ที่สร้างขึ้นใหม่ทั้งหมดตาม Master Development Specification โดย **ไม่ใช้ Central API Gateway** และ **ไม่แก้ไข GitHub Repository เดิม**

## จุดเด่นทางสถาปัตยกรรม
- **Single-Port HTTPS (`4101`):** เสิร์ฟทั้ง Production React SPA (`/Sam_Att/`) และ Express REST API (`/api/Sam_Att/*`) บนพอร์ต HTTPS `4101` เดียวกัน
- **Node.js Target `26.13.1`:** กำหนดใน `.nvmrc`, `package.json` (`engines.node`), และ `.github/workflows/ci.yml`
- **ฐานข้อมูลแยกอิสระ (`samchuk_attendance_v2`):** โครงสร้าง 20 ตารางหลัก (19 ตารางตาม Baseline + `deployment_history`) พร้อมระบบ Fail-Closed ห้ามสลับไปใช้ Mock Data เมื่อฐานข้อมูลหลักหรือ HOSOffice ล่ม
- **การควบคุมสิทธิ์ 3 ระดับ (`ADMIN`, `RESPONSIBLE_STAFF`, `GENERAL_USER`):** บังคับ Own-Only ที่ฝั่ง Server ด้วย `approved_person_id` ป้องกัน IDOR ทุกช่องทาง
- **รักษาสัญญา ScannerReader.exe 6 ฟิลด์:** รองรับ `machineNo`, `enrollNumber`, `scanDateTime`, `verifyMode`, `inOutMode`, `workCode` พร้อมการตัดข้อมูลซ้ำด้วย SHA-256 และการเก็บ Raw Scan แบบ Immutable

## คำสั่งติดตั้งและทดสอบ
```bash
# 1. ติดตั้งแพ็กเกจตาม lockfile
npm ci

# 2. ตรวจสอบ TypeScript Strict Mode
npm run typecheck

# 3. สร้าง Production Frontend Bundle (/Sam_Att/)
npm run build

# 4. รัน Database Migration
npm run db:migrate

# 5. รันชุดทดสอบอัตโนมัติ (Integration, RBAC, IDOR, Attendance, Fail-Closed Tests)
npm test

# 6. เริ่มต้นเซิร์ฟเวอร์ Standalone
npm start
```
