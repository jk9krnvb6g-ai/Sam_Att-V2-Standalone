# โครงสร้างระบบฝั่งหน้าเว็บผู้ใช้งาน (Frontend Architecture)
## Sam_Att V2 Standalone — Frontend (`frontend/`)

โฟลเดอร์ `frontend/` บรรจุซอร์สโค้ดส่วนติดต่อผู้ใช้งาน (UI) ทั้งหมด พัฒนาด้วย **React 19 + TypeScript + Tailwind CSS v4** ออกแบบตามแนวคิด **Human-Centered Healthcare Enterprise** รองรับทั้งหน้าจอคอมพิวเตอร์และโทรศัพท์มือถืออย่างสมบูรณ์

---

## แผนผังไฟล์และหน้าที่การทำงาน

```text
frontend/
└── src/
    ├── main.tsx                      # จุดเริ่มต้น (Entry Point) ของ React สำหรับ Mount เข้ากับ #root ใน index.html
    ├── App.tsx                       # โครงสร้างหลักของแอป: หน้า Login, แถบเมนูซ้าย, แถบเมนูมือถือด้านล่าง และการสลับหน้าตามสิทธิ์
    ├── index.css                     # ระบบสี (Soft Rose + Warm Slate), ฟอนต์ภาษาไทย Sarabun และคลาสมาตรฐาน .ent-*
    ├── services/
    │   └── api.ts                    # ตัวจัดการเรียก API (/api/Sam_Att/*), จัดเก็บ JWT Token และแปลงข้อผิดพลาด
    ├── utils/
    │   └── thaiFormat.ts             # ฟังก์ชันแปลงวันที่/เวลาเป็นภาษาไทย (พ.ศ.) และคำนวณช่วงวันที่จากตัวกรอง
    ├── components/
    │   ├── StatusText.tsx            # ป้ายแสดงสถานะการลงเวลา (StatusBadge), ป้ายสิทธิ์ผู้ใช้ และกล่องแจ้งเตือนข้อผิดพลาด
    │   ├── common/
    │   │   ├── SharedComponents.tsx  # คอมโพเนนต์กลางที่ใช้ร่วมกันทุกหน้า (PageHeader, PeriodFilterBar, Pagination, Modal, Drawer)
    │   │   └── ToastContext.tsx      # ระบบแจ้งเตือนแบบ Floating Toast (useMemo Context ป้องกันการ Re-render/Loop)
    │   └── deployment/
    │       ├── DeploymentUpdateCenter.tsx # ศูนย์อัปเดตระบบ & อนุมัติ Migration (StrictMode/AbortController/Dedup Safe)
    │       └── GitHubUpdateCenter.tsx     # คอนโซลอัปเดตระบบจาก GitHub พร้อม Changelog ภาษาไทยและ Rate-Limit Guard
    └── pages/
        ├── DashboardView.tsx         # หน้าภาพรวมองค์กร, แถบสัดส่วน 100%, ตารางสรุปแผนก และหน้าต่างเจาะลึก (Drill-Down)
        ├── MyAttendanceView.tsx      # หน้าเวลาปฏิบัติงานของฉัน (สำหรับบุคลากรทุกคนดูผลลงเวลา ตารางเวร และสแกนของตนเอง)
        ├── HrAttendanceView.tsx      # หน้าตรวจสอบเวลาปฏิบัติงานสำหรับ HR, จำลอง/สั่ง Reprocess และบันทึกหมายเหตุ
        ├── PersonnelView.tsx         # หน้าทะเบียนบุคลากร HOSOffice, ตรวจสอบสถานะรหัสสแกนนิ้ว และกติกาเวลาตามประเภทบุคลากร
        ├── ShiftsView.tsx            # หน้าจัดการแม่แบบกะทำงาน, มอบหมายตารางเวรรายบุคคล และยกเลิกเวรพร้อมบันทึกประวัติ
        ├── RawScansView.tsx          # หน้าจัดการเครื่องสแกน, ตารางซิงก์อัตโนมัติ และตรวจสอบข้อมูลสแกนต้นฉบับ 6 ฟิลด์
        ├── ReportsView.tsx           # หน้ารายงานสถิติการมาสาย, แผนภูมิเปรียบเทียบแผนก, ส่งออก CSV และส่งข้อมูลกลับ HOSOffice
        └── AdminViews.tsx            # หน้าสำหรับผู้ดูแลระบบ: จัดการผู้ใช้, บันทึกความปลอดภัย (Audit Logs), ตั้งค่าระบบ และอัปเดต
```
