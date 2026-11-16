# โครงสร้างระบบฝั่งเซิร์ฟเวอร์ (Backend Architecture)
## Sam_Att V2 Standalone — Backend (`backend/`)

โฟลเดอร์ `backend/` บรรจุซอร์สโค้ดฝั่งเซิร์ฟเวอร์ทั้งหมด พัฒนาด้วย **Node.js + Express + TypeScript** ทำหน้าที่ให้บริการ REST API ภายใต้พาธ `/api/Sam_Att/*` และเสิร์ฟหน้าเว็บ `/Sam_Att/` บนพอร์ต HTTPS `4101` พอร์ตเดียว

---

## แผนผังไฟล์และหน้าที่การทำงาน

```text
backend/
├── src/
│   ├── server.ts                     # เปิดเซิร์ฟเวอร์ HTTPS พอร์ต 4101, สร้างใบรับรอง TLS และรัน Migration เริ่มต้น
│   ├── app.ts                        # ตั้งค่า Express Middleware, ผูก Router ทุกโมดูลเข้ากับ /api/Sam_Att/*
│   ├── config/
│   │   └── env.ts                    # โหลดค่าตั้งค่าจาก .env และบังคับโหมดฐานข้อมูล MySQL ใน Production
│   ├── database/
│   │   ├── adapter.ts                # ตัวเชื่อมต่อฐานข้อมูล MySQL / SQLite พร้อมกลไก Fail-Closed (503)
│   │   └── cli-migrate.ts            # คำสั่ง CLI สำหรับรันสร้างตารางฐานข้อมูล (npm run db:migrate)
│   ├── middleware/
│   │   └── auth.ts                   # ตรวจสอบ JWT, ตรวจสอบสิทธิ์ 3 ระดับ (RBAC) และป้องกัน IDOR (Own-Only)
│   ├── utils/
│   │   └── crypto.ts                 # เข้ารหัสรหัสผ่าน scrypt, สร้าง/ตรวจ JWT HS256, คำนวณ SHA-256 6 ฟิลด์
│   └── modules/
│       ├── auth/routes.ts            # API เข้าสู่ระบบ (/auth/login), ออกจากระบบ (/auth/logout), เช็กเซสชัน (/auth/me)
│       ├── personnel/routes.ts       # API ทะเบียนบุคลากร, กติกากะตามประเภทบุคลากร และซิงก์จาก HOSOffice
│       ├── shifts/routes.ts          # API แม่แบบกะทำงาน, มอบหมายตารางเวรรายวัน และยกเลิกเวรแบบ Soft-Cancel
│       ├── scanners/routes.ts        # API ทะเบียนเครื่องสแกน, ตารางเวลาซิงก์ และรับข้อมูลสแกนดิบ 6 ฟิลด์
│       ├── attendance/
│       │   ├── processor.ts          # อัลกอริทึมจับคู่รหัสสแกนและคำนวณเวลาเข้า-ออกงาน/เวลาสาย/เวรข้ามวัน
│       │   └── routes.ts             # API แดชบอร์ด, ตรวจสอบเวลา HR, ข้อมูลของฉัน (/me/*) และสั่ง Reprocess
│       ├── reports/routes.ts         # API รายงานสถิติการมาสายและดาวน์โหลดไฟล์ CSV
│       ├── hosoffice/routes.ts       # API จำลองการส่งข้อมูล (Dry-Run Preview) และส่งข้อมูลจริงกลับ HOSOffice
│       ├── audit/service.ts          # บริการบันทึกประวัติความปลอดภัยลงตาราง audit_logs พร้อมปิดบังรหัสผ่าน
│       └── settings/routes.ts        # API จัดการผู้ใช้งาน, ดู Audit Logs, ทดสอบการเชื่อมต่อ และศูนย์อัปเดต
└── tests/
    └── sam-att.test.ts               # ชุดทดสอบอัตโนมัติ 8 หมวด (Integration & Security Test Suite)
```
