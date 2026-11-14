# Sam_Att V2 Standalone — System Architecture

## 1. สถาปัตยกรรมหลัก (Single-Port Standalone HTTPS)
- **ไม่มีการใช้ Central API Gateway:** ระบบทำงานเป็น Standalone Node.js + Express Process เดียว
- **พอร์ตมาตรฐานภายนอก:** HTTPS Port `4101` เพียงพอร์ตเดียว (ตั้งค่าผ่าน `PORT` ใน `.env`)
  - Frontend SPA Static Build: `https://HOST:4101/Sam_Att/`
  - Backend REST API: `https://HOST:4101/api/Sam_Att/*`
- **การแยกอิสระ (Isolation Guarantee):** ไม่แตะต้องพอร์ต, เซอร์วิส, ฐานข้อมูล หรือไฟล์ของระบบจัดซื้อ (Procurement), Production Central API Gateway หรือ `FILESERVER`

## 2. การควบคุมสิทธิ์ 3 ระดับ (3-Tier RBAC & Anti-IDOR)
1. **`ADMIN`**: จัดการผู้ใช้และผูก `approved_person_id`, จัดการทะเบียนเครื่องสแกน, ดู Audit Logs, ตรวจสถานะการเชื่อมต่อ, อนุมัติแพ็กเกจอัปเดตด้วยรหัสผ่านยืนยันซ้ำ (Re-authentication)
2. **`RESPONSIBLE_STAFF`**: ซิงก์บุคลากรจาก HOSOffice, จัดการกะและตารางเวร, สั่งซิงก์เครื่องสแกน, ตรวจสอบรายการผิดปกติ, บันทึกหมายเหตุ `NO_SCAN`/`MISSING_CHECKOUT`, สั่ง Reprocess, ดูรายงานและทำ Preview ส่งข้อมูลกลับ HOSOffice
3. **`GENERAL_USER`**: เข้าถึงได้เฉพาะ `/me/attendance`, `/me/shifts`, `/me/raw-scans` ของตนเอง โดยระบบดึง `approved_person_id` จากฐานข้อมูลฝั่ง Server เท่านั้น และบล็อกความพยายามส่ง `personId` อื่นผ่าน Query/Body/Path (`403 FORBIDDEN_IDOR_ATTEMPT`)
