# รายงานผลการทดสอบระบบ การวิเคราะห์ความล้มเหลวของ CI และการปรับเสถียรภาพขั้นสุดท้าย (`PHASE2_TEST_REPORT.md`)

**โครงการ:** ระบบบันทึกเวลาปฏิบัติงานและประมวลผลเวร (Sam_Att V2 Standalone)  
**หน่วยงาน:** โรงพยาบาลสามชุก  
**รุ่นการทดสอบ:** Phase 2 Final CI Stabilization & Lifecycle Lock Hardening  
**Reviewed Baseline Commit บน GitHub:** `63dfe617411ab456b47c57234cd70c969a112605` (และ `905928f02a375629602a47618dbe5ef5796796db`)  
**GitHub Actions Run ที่ตรวจสอบ:** `https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone/actions/runs/46133338444`

---

## 1. การวิเคราะห์สาเหตุจริงของความล้มเหลวใน GitHub Actions (TASK 1 & TASK 2 — Real CI Failure Investigation)

จากการตรวจสอบผลรันของ GitHub Actions Run `46133338444` (Commit `63dfe61`) และ Run `46131538373` (Commit `905928f`) ผ่าน GitHub REST API (`/actions/runs/46133338444/jobs` และ `/check-runs/*/annotations`) ร่วมกับการจำลองสภาพแวดล้อม Environment Variables เดียวกันทุกประการกับ `.github/workflows/ci.yml` (`NODE_ENV=test`, `SAM_ATT_TEST_ISOLATION=true`, `SAM_ATT_DB_ENGINE=sqlite_sandbox`, `SAM_ATT_DATA_MODE=REAL`):

### 1.1 สถานะของ GitHub Actions Run `46133338444` (ก่อนแก้ไขในรอบนี้)
1. **Job 1: `Build, Typecheck & Test Suite (Ubuntu)` (`job_id: 140943128738`)** — สถานะ: `completed / failure` ที่ขั้นตอน **`Run automated test suite (Isolated SQLite Sandbox in os.tmpdir)`**
2. **Job 2: `Windows Server PowerShell 5.1 & Node.js (22.x LTS)` (`job_id: 140943128952`)** — สถานะ: `completed / failure` ที่ขั้นตอน **`Run automated test suite on Windows Runner`**
3. **Job 3: `Windows Server PowerShell 5.1 & Node.js (26.x (Target Server v26.13.1))` (`job_id: 140943128922`)** — สถานะ: `completed / failure` ที่ขั้นตอน **`Run automated test suite on Windows Runner`**

---

### 1.2 รายการ Failed Tests, Error Message, Stack Trace และ Root Cause จริง

#### ความล้มเหลวชุดที่ 1: Environment Variable Leakage (`SAM_ATT_DATA_MODE: REAL` ใน `ci.yml` ทับโหมด `DEMO` ของไฟล์ทดสอบ 4 ชุด)

- **Failed Test Names (4 Test Suites):**
  1. `Default Shift by Personnel Type — 12 Mandatory Scenarios (PTD-01..PTD-12)` (`backend/tests/default-shift-by-personnel-type.test.ts`)
  2. `Default Shift Template Governance & Resolution (DEF-01..DEF-09)` (`backend/tests/default-shift-templates.test.ts`)
  3. `HOSOffice Personnel Sync — HR_STATUS_ID = 01, Safe Verification & History Preservation (HOS-01..HOS-05)` (`backend/tests/hosoffice-personnel-sync.test.ts`)
  4. `Shift Template Modal & Standard Alert System (UI-01..UI-06)` -> Subtest `UI-06: End-to-end API Create, Edit, Duplicate Failure Preservation, Deactivate/Activate, and Roster Regression` (`backend/tests/shift-template-modal-alert.test.ts`)
- **Error Messages & Stack Traces:**
  - ใน `default-shift-by-personnel-type.test.ts`, `default-shift-templates.test.ts` และ `hosoffice-personnel-sync.test.ts` (`before` hook):
    ```text
    AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
    401 !== 200
        at SuiteContext.<anonymous> (backend/tests/default-shift-templates.test.ts:103:12)
        at SuiteContext.<anonymous> (backend/tests/hosoffice-personnel-sync.test.ts:129:12)
        at SuiteContext.<anonymous> (backend/tests/default-shift-by-personnel-type.test.ts:154:12)
    ```
  - ใน `shift-template-modal-alert.test.ts` (`UI-06`):
    ```text
    AssertionError [ERR_ASSERTION]: The expression evaluated to a falsy value:
      assert.ok(firstPerson?.person_id)
        at TestContext.<anonymous> (backend/tests/shift-template-modal-alert.test.ts:377:12)
    ```
- **Root Cause (สาเหตุที่แท้จริง):**
  - ใน `.github/workflows/ci.yml` ขั้นตอนรัน `npm test` กำหนด Environment Variable ระดับโปรเซสว่า `SAM_ATT_DATA_MODE: REAL` (ขณะที่การรัน `npm test` เปล่าๆ ใน Linux Sandbox ไม่ได้กำหนด `SAM_ATT_DATA_MODE=REAL` ไว้ล่วงหน้า)
  - ไฟล์ทดสอบทั้ง 4 ไฟล์ข้างต้นเป็นชุดทดสอบที่เรียก `seedBaselineAndSyntheticData()` เพื่อจำลองบัญชีผู้ใช้ทดสอบ (`hrstaff`, `user1003`) และข้อมูลบุคลากรจำลอง (`SAM-P001`) บน SQLite Sandbox แต่ในหัวไฟล์กำหนดไว้เพียง `process.env.DEMO_MODE_ENABLED = 'true'` และ `process.env.DB_ENGINE = 'sqlite'` โดย**ไม่ได้กำหนด `process.env.SAM_ATT_DATA_MODE = 'DEMO'` และ `process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox'`**
  - เมื่อ `loadConfig()` ใน `backend/src/config/env.ts` ทำงาน จึงอ่านค่า `process.env.SAM_ATT_DATA_MODE` ที่ส่งมาจาก `ci.yml` (`REAL`) ทำให้ `seedDemoSyntheticData()` ใน `backend/src/database/adapter.ts` ข้ามการสร้างผู้ใช้ `hrstaff` / `user1003` และบุคลากรจำลอง (`SKIPPED_REAL_MODE_OR_PRODUCTION`) ส่งผลให้การล็อกอิน `hrstaff` คืนค่า `401` และ `GET /api/Sam_Att/personnel` คืนรายการว่าง!
- **Affected Source Files:**
  - `backend/tests/default-shift-by-personnel-type.test.ts`
  - `backend/tests/default-shift-templates.test.ts`
  - `backend/tests/hosoffice-personnel-sync.test.ts`
  - `backend/tests/shift-template-modal-alert.test.ts`
- **Corrective Action:**
  - กำหนด `process.env.SAM_ATT_DB_ENGINE = 'sqlite_sandbox'` และ `process.env.SAM_ATT_DATA_MODE = 'DEMO'` อย่างชัดเจนในหัวไฟล์ทดสอบทั้ง 4 ไฟล์ (เหมือนกับไฟล์ทดสอบอื่นๆ อีก 10 ไฟล์) เพื่อป้องกัน Environment Variable Leakage จาก CI Runner โดยไม่ลดทอนการตรวจสอบความปลอดภัยของโหมด `REAL` ใน `phase2-production-readiness.test.ts`

---

#### ความล้มเหลวชุดที่ 2: พารามิเตอร์และโครงสร้าง Handle ของ `Acquire-AtomicLifecycleLock` ใน `scripts/LifecycleLock.ps1`

- **Failed Step Name (ในกรณีรันขั้น PowerShell Validation บน Windows Runner):**
  - `Validate Windows PowerShell 5.1 AST Parsing, Atomic Lifecycle Lock Concurrency, DryRun, HealthCheck & Backup/Rollback Integrity`
- **Root Cause (สาเหตุที่แท้จริง):**
  - ใน Commit `63dfe61` ฟังก์ชัน `Acquire-AtomicLifecycleLock` ใน `scripts/LifecycleLock.ps1` รับเฉพาะพารามิเตอร์ `-Path` และคืนค่า Hashtable ที่มีคีย์ `acquiredNew` / `lockId` (camelCase) แต่สคริปต์ทดสอบใน `.github/workflows/ci.yml` เรียกใช้ด้วยพารามิเตอร์ `-DeploymentsDir $testDeploy` และตรวจสอบพร็อพเพอร์ตี้ `$primaryLock.Acquired`, `$primaryLock.ReusedParent`, `$primaryLock.LockId`, `$primaryLock.LockFile`
  - นอกจากนี้ กลไก Stale Lock Cleanup เดิมใช้ `Remove-Item -Path $Path -Force` โดยตรง ซึ่งหากมี 2 โปรเซสตรวจพบ Stale Lock พร้อมกัน โปรเซสแรกอาจลบและสร้าง Lock ใหม่เสร็จก่อน แล้วโปรเซสที่สองตามมาสั่ง `Remove-Item $Path` ทับ Lock ใหม่ของโปรเซสแรกได้
- **Affected Source Files:**
  - `scripts/LifecycleLock.ps1`
  - `backend/src/modules/deployment/jobStore.ts`
  - `.github/workflows/ci.yml`
  - `backend/tests/phase2-production-readiness.test.ts`
- **Corrective Action (TASK 3 — Lifecycle Lock Hardening):**
  - ปรับปรุง `scripts/LifecycleLock.ps1` ให้รองรับทั้งพารามิเตอร์ `-Path` และ `-DeploymentsDir` พร้อมคืนค่า `PSCustomObject` ที่มีทั้งพร็อพเพอร์ตี้ PascalCase (`Acquired`, `AcquiredNew`, `ReusedParent`, `LockId`, `OwnerPid`, `OwnerStartTimeUtc`, `LockFile`, `Path`, `DryRun`) และ camelCase ครบถ้วน
  - เพิ่มการบันทึกและตรวจสอบ `ownerStartTimeUtc` (เวลาเริ่มต้นโปรเซสระดับ UTC ของ PID ที่ถือ Lock) คู่กับ `pid` เพื่อป้องกันปัญหา Windows นำหมายเลข PID เดิมกลับมาใช้ซ้ำ (PID Recycling)
  - เปลี่ยนการกู้คืน Stale Lock จากการสั่งลบไฟล์ตรงๆ (`Remove-Item $Path`) เป็น **Atomic Rename-to-Trash Tombstone (`[System.IO.File]::Move($Path, $staleTrash)`)** หลังตรวจสอบซ้ำว่า `lockId` บนดิสก์ยังเป็น Stale Lock ตัวเดิมเท่านั้น จึงลบไฟล์ `$staleTrash` ทำให้โปรเซสที่ตามมาทีหลังไม่สามารถลบไฟล์ Lock ใหม่ของโปรเซสที่ชนะการกู้คืนได้โดยเด็ดขาด
  - เพิ่มการป้องกันไฟล์ Lock ที่เพิ่งถูกสร้างและกำลังอยู่ระหว่างเขียนข้อมูล (`PARTIAL_OR_CORRUPT` ที่มีอายุน้อยกว่า `CorruptLockMaxAgeMs = 5000ms`) ไม่ให้ถูกลบเป็นอันขาด
  - ลบการใช้ `continue-on-error` ออกจาก `.github/workflows/ci.yml` ทั้งหมดตามข้อกำหนด TASK 2

---

## 2. สรุปผลการรันชุดทดสอบหลังแก้ไข (Verification Results)

| รายการตรวจสอบ | ผลลัพธ์ก่อนแก้ไข (Commit `63dfe61` เมื่อรันด้วย CI Env Vars) | ผลลัพธ์หลังแก้ไข (Final CI Stabilization) |
| :--- | :---: | :---: |
| **Total Automated Tests (`npm test` พร้อม CI Env Vars)** | 154 Tests (Pass: 129, **Fail: 4 Suites / 25 Tests**) | **154 Tests (Pass: 154, Fail: 0, Cancelled: 0, Skipped: 0)** |
| **TypeScript Typecheck (`npm run typecheck`)** | PASS | **PASS (0 errors)** |
| **Linter (`npm run lint`)** | PASS | **PASS (0 errors)** |
| **Production Frontend Build (`npm run build`)** | PASS | **PASS** |
| **PowerShell 7-Bit ASCII & Safety Audit (15 Scripts)** | PASS | **PASS (15/15 scripts verified)** |
| **Lifecycle Lock Concurrency, Stale Recovery & Corrupt Guard** | มีจุดเสี่ยง Concurrent Delete & Parameter Mismatch | **PASS (Verified Atomic Move-to-Trash, PID+StartTime, Corrupt Guard)** |

---

## 3. สถานะของแต่ละสภาพแวดล้อม CI ตามความจริง (Honest CI Job Status — TASK 4 & TASK 5)

| สภาพแวดล้อม / CI Job | สถานะจริงในปัจจุบัน | รายละเอียดตามความจริง |
| :--- | :---: | :--- |
| **1. Local Linux Container (Ubuntu / Node.js `v22.22.0`)** | **รันจริงแล้ว — PASS 100% (`154/154` Tests, `0` Failures)** | รันด้วยคำสั่งและ Environment Variables เดียวกับ GitHub Actions Ubuntu Job ทุกประการ (`NODE_ENV=test`, `SAM_ATT_TEST_ISOLATION=true`, `SAM_ATT_DB_ENGINE=sqlite_sandbox`, `SAM_ATT_DATA_MODE=REAL`):<br>- `npm run typecheck`: **PASS**<br>- `npm run lint`: **PASS**<br>- `npm test`: **154 passed, 0 failed (7 suites)**<br>- `npm run build`: **PASS** |
| **2. GitHub Actions — Ubuntu (`Node.js 22`)** | **รอ Push Commit ใหม่ขึ้น GitHub เพื่อทริกเกอร์ Workflow รอบใหม่** | บน GitHub Run `46133338444` (Commit `63dfe61`) สถานะคือ `failure` จากปัญหา `SAM_ATT_DATA_MODE=REAL` ที่แก้ไขเรียบร้อยแล้วใน Workspace นี้ เมื่อ Push Commit ใหม่ขึ้น GitHub ชุดทดสอบทั้ง 154 ข้อจะทำงานด้วย Env Isolation ที่แก้ไขแล้ว |
| **3. GitHub Actions — Windows (`Node.js 22.x LTS`)** | **รอ Push Commit ใหม่ขึ้น GitHub เพื่อทริกเกอร์ Workflow รอบใหม่** | บน GitHub Run `46133338444` (Commit `63dfe61`) สถานะคือ `failure` ที่ขั้นตอน `npm test` จากสาเหตุเดียวกัน และได้รับการแก้ไขทั้ง `npm test` และ `scripts/LifecycleLock.ps1` (`-DeploymentsDir`, PascalCase properties, Atomic Move-to-Trash Stale Recovery) เรียบร้อยแล้ว |
| **4. GitHub Actions — Windows (`Node.js 26.x / Target v26.13.1`)** | **รอ Push Commit ใหม่ขึ้น GitHub เพื่อทริกเกอร์ Workflow รอบใหม่** | ลบ `continue-on-error` ออกจาก `.github/workflows/ci.yml` แล้ว และแก้ไขทั้ง `npm test` และ PowerShell Lifecycle Lock Test เรียบร้อยแล้ว |

> **หมายเหตุความซื่อสัตย์ (Strict Honesty Rule — TASK 4):** เนื่องจากสภาพแวดล้อม AI Studio Build ไม่ได้ Push Commit ขึ้น GitHub Repository โดยอัตโนมัติในระหว่างรัน Tool จึงยังไม่สามารถอ้างอิง Run ID ใหม่บน GitHub Actions ว่า `PASS` ได้จนกว่าผู้ดูแลระบบจะ Sync/Push โค้ดชุดนี้ขึ้น GitHub (`jk9krnvb6g-ai/Sam_Att-V2-Standalone`) และให้ GitHub Actions รัน Workflow รอบใหม่จนเสร็จสิ้น

---

## 4. รายชื่อไฟล์ที่แก้ไขในรอบนี้ (Files Modified)

1. `backend/tests/default-shift-by-personnel-type.test.ts` — กำหนด `SAM_ATT_DB_ENGINE = 'sqlite_sandbox'` และ `SAM_ATT_DATA_MODE = 'DEMO'` ป้องกัน Env Leakage จาก CI
2. `backend/tests/default-shift-templates.test.ts` — กำหนด `SAM_ATT_DB_ENGINE = 'sqlite_sandbox'` และ `SAM_ATT_DATA_MODE = 'DEMO'` ป้องกัน Env Leakage จาก CI
3. `backend/tests/hosoffice-personnel-sync.test.ts` — กำหนด `SAM_ATT_DB_ENGINE = 'sqlite_sandbox'` และ `SAM_ATT_DATA_MODE = 'DEMO'` ป้องกัน Env Leakage จาก CI
4. `backend/tests/shift-template-modal-alert.test.ts` — กำหนด `SAM_ATT_DB_ENGINE = 'sqlite_sandbox'` และ `SAM_ATT_DATA_MODE = 'DEMO'` ป้องกัน Env Leakage จาก CI
5. `scripts/LifecycleLock.ps1` — ปรับปรุง Atomic Lifecycle Lock ให้รองรับ `-Path` และ `-DeploymentsDir`, ตรวจสอบ `ownerStartTimeUtc` คู่กับ `pid`, ป้องกันการลบไฟล์ Corrupt/Partial ที่กำลังเขียน (`<5000ms`), และใช้ Atomic Rename-to-Trash (`[System.IO.File]::Move`) ในการกู้คืน Stale Lock และปลดล็อก
6. `backend/src/modules/deployment/jobStore.ts` — ปรับปรุงการกู้คืน Stale Lock, Corrupt Lock Guard (`>5000ms`) และการปลดล็อกให้ใช้ Atomic Rename-to-Trash (`fs.renameSync`) เช่นเดียวกัน
7. `backend/tests/phase2-production-readiness.test.ts` — เพิ่ม Regression Tests สำหรับ Concurrent Lock Acquisition, Stale Lock Recovery ภายใต้ Contention, Partial/Corrupt Lock Protection และ Unauthorized Release Protection
8. `.github/workflows/ci.yml` — ลบ `continue-on-error` ออกทั้งหมด และเพิ่มชุดทดสอบ PowerShell สำหรับ Stale Lock Recovery และ Partial/Corrupt Lock Guard บน Windows Runner
9. `PHASE2_TEST_REPORT.md` — บันทึกรายงานผลการตรวจสอบความล้มเหลวของ CI, Root Cause และผลการทดสอบจริง
