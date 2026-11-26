# Phase 0 — One-Click Application Update Test

เอกสารฉบับนี้สร้างขึ้นเพื่อใช้ทดสอบการทำงานของ **GitHub Update Center (Application-Only)** สำหรับระบบ **Sam_Att V2 Standalone** บนเครื่อง Windows Production Server

- **Baseline Installed Commit:** `04d2bbc`
- **Target Branch:** `main`
- **Update Scope:** Documentation only (Application-Only acceptance test — ไม่มีการแก้ไข Frontend, Backend, Deployment Script, `package.json`, `package-lock.json`, Database Schema, Migration, `.env`, หรือ Business Logic)
- **Expected Update Behavior:**
  1. หน้า **ศูนย์อัปเดตระบบ** ตรวจพบ Commit ใหม่จาก `origin/main` และไม่ติด `DB_SCHEMA_CHANGE_BLOCKED`
  2. ระบบข้ามขั้นตอน `npm ci` (`SKIPPED_LOCKFILE_UNCHANGED`) เนื่องจากไฟล์ Lockfile ไม่เปลี่ยนแปลง
  3. ระบบสำรอง Application Snapshot นอก Git Repo (`C:\SamAttDeploySnapshots`), Build และรีสตาร์ทเฉพาะบริการ Sam_Att บนพอร์ต `4101` พร้อมคงการเชื่อมต่อ Polling จนแล้วเสร็จ
