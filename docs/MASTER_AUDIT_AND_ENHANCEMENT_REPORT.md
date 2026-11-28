# SAM_ATT V2 STANDALONE — MASTER AUDIT, STABILIZATION & ENHANCEMENT REPORT
## PART A + PART B — UNIFIED ACCEPTANCE & WINDOWS SERVER RUNBOOK

- **ระบบ:** Sam_Att V2 Standalone (โรงพยาบาลสามชุก)
- **Repository:** `jk9krnvb6g-ai/Sam_Att-V2-Standalone` (`main`)
- **ฐานข้อมูลหลัก:** `samchuk_attendance_v2` (Timezone: `Asia/Bangkok`)
- **สถานะ HOSOffice Live Push:** ปิดล็อกเพื่อความปลอดภัย (`HOSOFFICE_LIVE_PUSH_ENABLED=false`)
- **สถานะ Phase 0 (GitHub Update Center):** พักการแก้ไขตามข้อกำหนด (`DEFERRED` — ไม่มีการแตะต้องไฟล์ Updater/Worker เดิม)

---

## 1. BASELINE AUDIT & ISSUE REGISTER (PART A)

| Issue ID | หมวด / หน้าจอ | รายละเอียดปัญหาเดิม | สถานะ | การแก้ไขและป้องกัน |
|---|---|---|---|---|
| **A1-01** | Attendance Engine & Lifecycle | การแสดงสถานะ `NORMAL` หรือ `NO_SCAN` ก่อนหมดเวลากะปฏิบัติงานจริง | **FIXED & VERIFIED** | เพิ่ม `evaluateAttendanceLifecycle` (`backend/src/modules/attendance/lifecycle.ts`) แยกสถานะตามเวลาจริง (`NOT_STARTED`, `AWAITING_CHECKIN`, `IN_PROGRESS`, `LATE_IN_PROGRESS`, `COMPLETED`, `MISSING_CHECKOUT`, `NO_SCAN`) อ้างอิงเวลาเซิร์ฟเวอร์ `Asia/Bangkok` |
| **A1-02** | Multiple Conditions & Re-Review | ข้อมูลสายและออกก่อนเวลาทับกัน หรือ Reprocess ทับผลที่ HR อนุมัติแล้ว | **FIXED & VERIFIED** | แยก `status`, `attendance_status`, `is_late`, `late_minutes`, `early_checkout_indicator`, `early_checkout_minutes` และตั้งสถานะ `NEEDS_RE_REVIEW` อัตโนมัติหากผลเวลาเปลี่ยนหลัง HR อนุมัติ |
| **A2-01** | HOSOffice Push History & Preview | ความสอดคล้องของ `/hosoffice/push-history` และ `/hosoffice/push/history` รวมถึง Stale Preview | **FIXED & VERIFIED** | รองรับทั้ง 2 เส้นทางด้วยสิทธิ์เดียวกัน, ใช้ Explicit Allowlist, ตรวจ Hash/Stale Preview และคง `HOSOFFICE_LIVE_PUSH_ENABLED=false` |
| **A3-01** | RBAC, IDOR & Last Admin Guard | ป้องกัน `GENERAL_USER` ดูข้อมูลผู้อื่น, บังคับเปลี่ยนรหัสผ่านชั่วคราว และห้ามลบ/ลดสิทธิ์ ADMIN คนสุดท้าย | **FIXED & VERIFIED** | บังคับ `must_change_password` (`ForcePasswordChangeView`), ป้องกัน IDOR ทุก Endpoint และล็อกการลบ/ปิด/ลดสิทธิ์ ADMIN คนสุดท้ายระดับ Backend |
| **A4-01** | Performance & Bundle Splitting | ขนาด Payload หน้า Dashboard/Attendance และขนาด JS Bundle | **FIXED & VERIFIED** | ใช้ Server-Side Aggregation/Pagination, `AbortController`, และแยก Route-Based Lazy Loading (`React.lazy`) ทุกหน้าหลัก |
| **A5-01** | All 16 Original Pages | ความถูกต้องของเปอร์เซ็นต์ทะเบียนบุคลากร (เช่น `99.6%` แทนการปัดเป็น `100%`), Audit Log แปลไทย, Raw Scans Pagination | **FIXED & VERIFIED** | ปรับการคำนวณเปอร์เซ็นต์แบบไม่ปัดเต็ม 100% หากยังมีรายการขาด, เพิ่มคำแปล Audit Action ภาษาไทยครบทุกกิจกรรม และรักษาความไม่เปลี่ยนแปลงของ `raw_scans` |

---

## 2. PART B — NEW CAPABILITIES & ENHANCEMENTS (B1–B10)

| Feature ID | ชื่อความสามารถ | ไฟล์หลัก (Backend / Frontend) | สถานะ |
|---|---|---|---|
| **B-01** | **Hospital Holiday Calendar** (ปฏิทินวันหยุดโรงพยาบาลหลายขอบเขต: ทั้ง รพ. / เฉพาะหน่วยงาน / เฉพาะบุคคล พร้อม Impact Preview & Reprocess) | `backend/src/modules/holidays/routes.ts`, `backend/src/modules/holidays/service.ts`, `frontend/src/components/shifts/HospitalHolidaysTab.tsx` | **COMPLETED & TESTED** |
| **B-02** | **Advanced Attendance Lifecycle Experience** (การ์ดสถานะวันนี้แบบเรียลไทม์ ไทม์ไลน์กะ และเวลาที่เหลือก่อนตัดรอบ) | `backend/src/modules/attendance/lifecycle.ts`, `frontend/src/pages/MyAttendanceView.tsx`, `frontend/src/pages/DashboardView.tsx` | **COMPLETED & TESTED** |
| **B-03** | **Historical Attendance Completeness Center** (ศูนย์ตรวจสอบความครบถ้วนย้อนหลัง พรีวิว และเติมข้อมูลแบบ Idempotent พร้อม Retry รายการล้มเหลว) | `backend/src/modules/attendance/completeness.ts`, `frontend/src/pages/CompletenessView.tsx` | **COMPLETED & TESTED** |
| **B-04** | **HR Work Center** (ศูนย์ปฏิบัติงาน HR รายวัน จัดลำดับคิวงาน `URGENT` / `TODAY` / `PENDING` / `COMPLETED` และ Saved Filter Presets) | `backend/src/modules/hr/workCenter.ts`, `frontend/src/pages/HrWorkCenterView.tsx` | **COMPLETED & TESTED** |
| **B-05** | **Bulk User Creation** (สร้างบัญชีผู้ใช้แบบกลุ่มจากทะเบียนบุคลากร รหัสผ่านชั่วคราวแบบสุ่มปลอดภัย บังคับเปลี่ยนรหัสครั้งแรก และส่งออก CSV ป้องกัน Formula Injection) | `backend/src/modules/auth/routes.ts`, `frontend/src/pages/AdminViews.tsx` | **COMPLETED & TESTED** |
| **B-06** | **Excel Export & 11-Report Center** (ศูนย์รายงานมาตรฐาน 11 ประเภท พร้อมส่งออกไฟล์ `.xlsx` แท้แบบหลายชีตด้วย `xlsxBuilder.ts` และ `.csv` UTF-8 BOM) | `backend/src/utils/xlsxBuilder.ts`, `backend/src/modules/reports/routes.ts`, `frontend/src/pages/ReportsView.tsx` | **COMPLETED & TESTED** |
| **B-07** | **Bulk HR Review & Approval** (ตรวจสอบและรับรองผลหลายรายการพร้อมกัน ตรวจ `record_version` ป้องกันการอนุมัติชนกัน และบล็อกเดือนที่ปิดรอบแล้ว) | `backend/src/modules/attendance/routes.ts`, `frontend/src/pages/HrAttendanceView.tsx` | **COMPLETED & TESTED** |
| **B-08** | **Monthly Attendance Closing** (ระบบปิดรอบประจำเดือน `OPEN` / `REVIEWING` / `READY_TO_CLOSE` / `CLOSED` / `REOPENED` ล็อกการแก้ไขย้อนหลัง และ Reopen เฉพาะ ADMIN) | `backend/src/modules/periods/routes.ts`, `frontend/src/pages/MonthlyClosingView.tsx` | **COMPLETED & TESTED** |
| **B-09** | **System Health Center** (ศูนย์ตรวจสอบสถานะระบบสำหรับ ADMIN แบบ Read-Only ครบ 8 องค์ประกอบ โดยไม่เปิดเผย Secrets และไม่สั่งแก้ระบบอัตโนมัติ) | `backend/src/modules/settings/routes.ts`, `frontend/src/pages/SystemHealthView.tsx` | **COMPLETED & TESTED** |
| **B-10** | **Smart Navigation & Documentation Sync** (จัดหมวดหมู่ Sidebar ใหม่ให้เข้าใจง่าย เชื่อมโยงคู่มือประจำหน้า `helpGuides.ts` และผังงาน `workflowConfig.ts` ครบทุกหน้า) | `frontend/src/components/layout/Sidebar.tsx`, `frontend/src/App.tsx`, `frontend/src/data/helpGuides.ts`, `frontend/src/data/workflowConfig.ts` | **COMPLETED & TESTED** |

---

## 3. PHASE 0 KNOWN ISSUES (FROZEN / DEFERRED PER SECTION 04)

ตามข้อกำหนด Section 04 ระบบ **GitHub Update Center (Phase 0)** ถูกพักการแก้ไขและบันทึกเป็น Known Issues เพื่อดำเนินการแยกต่างหากภายหลัง:
1. การกด One-Click Update บน Windows Server ค้างที่ 5% หลังสร้าง Deployment Job
2. Progress API ถูกเรียกต่อเนื่องแต่ Checklist Step Names ไม่แสดงผล
3. การรัน Detached Worker (`deploy-runner.ts` / `Deploy_Sam_Att.ps1`) และการซิงก์สถานะ Job ข้ามโปรเซสบน Windows Server ยังต้องรอการตรวจสอบแยกต่างหาก
4. การทดสอบ Application Rollback ข้าม Commit บนเครื่อง Production จริงยังไม่ได้รับการยืนยัน

*(ไม่มีการแก้ไขไฟล์ในชุด Deployment Updater และคงการป้องกันไม่ให้รัน `npm test` หรือ Auto-Migrate บน Production Startup)*

---

## 4. DATABASE MIGRATION & WINDOWS SERVER DEPLOYMENT CHECKLIST

### 4.1 ไฟล์ Migration ที่เพิ่มใหม่ (Additive & Idempotent 100%)
- ไฟล์: `database/migrations/006_part_b_governance.sql`
- **ผลกระทบ:**
  - เพิ่มคอลัมน์ `must_change_password`, `password_updated_at` ในตาราง `users`
  - เพิ่มคอลัมน์ `record_version`, `is_locked_period`, `late_scan_review_required` ในตาราง `attendance`
  - สร้างตารางใหม่ 4 ตาราง: `hospital_holidays`, `attendance_periods`, `attendance_period_history`, `completeness_runs`
  - **ไม่มีคำสั่ง `DROP`, `TRUNCATE` หรือการลบข้อมูลเดิมใด ๆ**

### 4.2 ขั้นตอนสำหรับผู้ดูแลระบบบน Windows Server (`C:\inetpub\wwwroot\Sam_Att`)

1. **สำรองฐานข้อมูลก่อนรัน Migration (แนะนำทุกครั้ง):**
   ```powershell
   mysqldump -h 10.1.0.201 -u <DB_USER> -p samchuk_attendance_v2 > C:\SamAttBackups\pre_migration_006.sql
   ```
2. **ตรวจสอบและรัน Migration ผ่าน CLI อย่างปลอดภัย (เมื่อได้รับอนุมัติ):**
   ```powershell
   cd C:\inetpub\wwwroot\Sam_Att
   npm run db:migrate
   ```
3. **คอมไพล์ Frontend และตรวจสอบ TypeScript:**
   ```powershell
   npm run lint
   npm run build
   ```
4. **รายการทดสอบยอมรับระบบ (UAT Checklist บน Windows Server จริง):**
   - เข้าเมนู **ตารางเวร กะ และวันหยุด** → แท็บ **4. ปฏิทินวันหยุดโรงพยาบาล** ทดสอบเพิ่มวันหยุดและกดดู Impact Preview
   - เข้าเมนู **ศูนย์ปฏิบัติงาน HR** ตรวจสอบตัวเลขสรุปวันนี้และคิวงานแยกตามความเร่งด่วน
   - เข้าเมนู **ตรวจความครบถ้วนย้อนหลัง** เลือกช่วงวันที่และกดพรีวิวความครบถ้วน
   - เข้าเมนู **ตรวจสอบเวลาและหมายเหตุ** ทดสอบติ๊กเลือกรายการหลายแถวแล้วกด **ตรวจสอบแบบกลุ่ม (Bulk HR Review)**
   - เข้าเมนู **ปิดรอบประจำเดือน** ตรวจสอบ Readiness (Blocking Issues vs Warnings)
   - เข้าเมนู **ศูนย์รายงานและส่งออก** ทดสอบเลือกทั้ง 11 รายงานและกดดาวน์โหลดไฟล์ **Excel (.xlsx)** เปิดใน Microsoft Excel
   - เข้าเมนู **ผู้ใช้และสิทธิ์** (เฉพาะ ADMIN) ทดสอบปุ่ม **สร้างบัญชีผู้ใช้แบบกลุ่ม** และดาวน์โหลดไฟล์รหัสผ่านชั่วคราว
   - เข้าเมนู **ศูนย์ตรวจสอบสถานะระบบ** (เฉพาะ ADMIN) ตรวจสอบสถานะการเชื่อมต่อฐานข้อมูล เครื่องสแกน และพื้นที่ดิสก์
