# มาตรการความปลอดภัยฐานข้อมูล Production (`DATABASE_SAFETY.md`)

เอกสารนี้อธิบายกลไกการป้องกันฐานข้อมูล Production **`samchuk_attendance_v2`** บนเครื่องแม่ข่าย MySQL **`10.1.0.201:3306`**

---

## 1. กฎเหล็กด้านความปลอดภัยฐานข้อมูล (Non-Negotiable Database Safety Rules)

1. **Zero Automatic Mutation on Production Startup:**
   - เมื่อเริ่มต้นระบบในโหมด `NODE_ENV=production` และ `SAM_ATT_DB_CLIENT=mysql` แอปพลิเคชันจะ**ไม่รันคำสั่ง** `CREATE TABLE`, `ALTER TABLE`, `DROP TABLE`, `TRUNCATE`, `INSERT`, `UPDATE` หรือ `DELETE` ใด ๆ โดยอัตโนมัติในขั้นตอน Startup (`initializeDatabase({ startupReadOnlyOnMysql: true })`)
   - ฟังก์ชัน `ensureBaselineSystemCatalog` ถูกบล็อกไม่ให้แก้ไขตารางหรือข้อมูลตั้งต้นเมื่อ `startupReadOnlyOnMysql === true`
2. **Read-Only Production Database Preflight (`npm run db:preflight`):**
   - ใช้คำสั่ง `SELECT` เท่านั้นในการตรวจสอบความพร้อมของฐานข้อมูลก่อนเริ่มหรืออัปเดตระบบ
   - ตรวจสอบการเชื่อมต่อ, ชื่อฐานข้อมูล (`samchuk_attendance_v2`), Character Set (`utf8mb4`), Timezone (`+07:00`), ตารางหลักทั้ง 16 ตาราง, คอลัมน์สำคัญ, จำนวนแถวข้อมูลเบื้องต้น และสถานะ `schema_migrations`
3. **Database Schema Change Block in One-Click Update:**
   - ระบบ GitHub Update Center จะตรวจสอบรายการไฟล์ที่เปลี่ยนแปลงระหว่าง Commit ปัจจุบันกับ Commit ใหม่ หากพบการแก้ไขไฟล์ใน `database/migrations/*` หรือ `schema.sql` ระบบจะบล็อกการอัปเดตอัตโนมัติ (`DB_SCHEMA_CHANGE_BLOCKED`) เพื่อป้องกันความเสียหายต่อฐานข้อมูล Production
4. **HOSOffice / HOSxP Read-Only Enforcement:**
   - การเชื่อมต่อฐานข้อมูลภายนอก HOSxP (`HOSXP_DB_*`) ผ่านฟังก์ชัน `hosxpQuery` บังคับให้รันเฉพาะคำสั่ง `SELECT` หรือ `SHOW` เท่านั้น หากมีคำสั่งแก้ไขข้อมูล ระบบจะโยนข้อผิดพลาด `HOSXP_READ_ONLY_VIOLATION` ทันที

---

## 2. การใช้งานคำสั่ง Read-Only Database Preflight

สามารถรันตรวจสอบฐานข้อมูลได้ตลอดเวลาโดยไม่กระทบข้อมูลจริง:

```powershell
# รันผ่าน npm script ในโฟลเดอร์ D:\WebApps\Sam_Att\App
npm run db:preflight

# หรือแสดงผลเป็น JSON
npm run db:preflight -- --json

# หรือรันผ่าน PowerShell Preflight Script
.\Preflight_Sam_Att.ps1 -MySqlHost 10.1.0.201 -MySqlPort 3306
```

---

## 3. รายการตารางหลักที่ตรวจสอบใน Read-Only Preflight (16 Core Tables)

- `users`
- `personnel`
- `personnel_type_rules`
- `shifts`
- `shift_assignments`
- `scanner_devices`
- `sync_schedules`
- `sync_runs`
- `raw_scans`
- `raw_scan_mappings`
- `fingerprint_mappings`
- `attendance`
- `attendance_notes`
- `hr_review_history`
- `deployment_history`
- `audit_logs`
