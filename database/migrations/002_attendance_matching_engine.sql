-- ============================================================================
-- Sam_Att V2 Standalone — Attendance Matching Engine Schema Migration (002)
-- Database: samchuk_attendance_v2
-- Timezone Policy: Asia/Bangkok (+07:00)
-- Safety Rule: Additive idempotent DDL only. No DROP or TRUNCATE statements.
-- ============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 1. Extend shifts with explicit IN-after and OUT-before acceptance windows (ATT-06, ATT-07, ATT-10)
ALTER TABLE shifts ADD COLUMN checkin_window_after_min INT NOT NULL DEFAULT 240;
ALTER TABLE shifts ADD COLUMN checkout_window_before_min INT NOT NULL DEFAULT 180;

-- 2. Extend attendance with separated completeness status, early checkout, leave evaluation, and review metadata (ATT-10..ATT-15)
ALTER TABLE attendance ADD COLUMN attendance_status VARCHAR(32) NOT NULL DEFAULT 'COMPLETE';
ALTER TABLE attendance ADD COLUMN evaluated_start_time VARCHAR(32) NULL;
ALTER TABLE attendance ADD COLUMN evaluated_end_time VARCHAR(32) NULL;
ALTER TABLE attendance ADD COLUMN early_checkout_indicator TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN early_checkout_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN review_reason VARCHAR(500) NULL;
ALTER TABLE attendance ADD COLUMN reviewed_by VARCHAR(64) NULL;
ALTER TABLE attendance ADD COLUMN reviewed_at DATETIME NULL;
ALTER TABLE attendance ADD COLUMN matching_rule VARCHAR(128) NULL;
ALTER TABLE attendance ADD COLUMN processed_at DATETIME NULL;
ALTER TABLE attendance ADD COLUMN leave_id INT NULL;
ALTER TABLE attendance ADD COLUMN leave_type VARCHAR(32) NULL;
ALTER TABLE attendance ADD COLUMN leave_start_time VARCHAR(5) NULL;
ALTER TABLE attendance ADD COLUMN leave_end_time VARCHAR(5) NULL;

-- 3. Extend attendance_notes with re-review flag when reprocess changes a reviewed shift (ATT-13)
ALTER TABLE attendance_notes ADD COLUMN needs_re_review TINYINT(1) NOT NULL DEFAULT 0;

-- 4. attendance_raw_scan_usage: Database-level anti-reuse constraint (ATT-03) and scan traceability (ATT-09)
CREATE TABLE IF NOT EXISTS attendance_raw_scan_usage (
  raw_scan_id INT NOT NULL PRIMARY KEY,
  attendance_id INT NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  shift_assignment_id INT NULL,
  shift_code VARCHAR(32) NULL,
  usage_role VARCHAR(16) NOT NULL,
  matched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_arsu_attendance (attendance_id),
  INDEX idx_arsu_person_date (person_id, work_date),
  CONSTRAINT fk_arsu_raw_scan FOREIGN KEY (raw_scan_id) REFERENCES raw_scans(id),
  CONSTRAINT fk_arsu_attendance FOREIGN KEY (attendance_id) REFERENCES attendance(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. attendance_leaves: Half-day and partial-day leave intervals without altering shift templates (ATT-15)
CREATE TABLE IF NOT EXISTS attendance_leaves (
  id INT AUTO_INCREMENT PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  shift_assignment_id INT NULL,
  leave_type VARCHAR(32) NOT NULL,
  leave_start_time VARCHAR(5) NOT NULL,
  leave_end_time VARCHAR(5) NOT NULL,
  reason VARCHAR(500) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_att_leaves_person_date (person_id, work_date, status),
  CONSTRAINT fk_att_leaves_person FOREIGN KEY (person_id) REFERENCES personnel(person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. attendance_settings: Central configurable matching rules (e.g., half-day pre-checkin window: 30/60/120 min) (ATT-15)
CREATE TABLE IF NOT EXISTS attendance_settings (
  setting_key VARCHAR(64) NOT NULL PRIMARY KEY,
  setting_value VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. attendance_matching_history: Audit trail of matching result changes across Reprocess runs (ATT-13)
CREATE TABLE IF NOT EXISTS attendance_matching_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  shift_assignment_id INT NULL,
  previous_check_in_raw_scan_id INT NULL,
  new_check_in_raw_scan_id INT NULL,
  previous_check_out_raw_scan_id INT NULL,
  new_check_out_raw_scan_id INT NULL,
  previous_status VARCHAR(32) NULL,
  new_status VARCHAR(32) NOT NULL,
  previous_attendance_status VARCHAR(32) NULL,
  new_attendance_status VARCHAR(32) NOT NULL,
  previous_late_minutes INT NOT NULL DEFAULT 0,
  new_late_minutes INT NOT NULL DEFAULT 0,
  previous_early_checkout_minutes INT NOT NULL DEFAULT 0,
  new_early_checkout_minutes INT NOT NULL DEFAULT 0,
  previous_review_status VARCHAR(32) NULL,
  new_review_status VARCHAR(32) NOT NULL,
  matching_rule VARCHAR(128) NULL,
  change_reason VARCHAR(500) NULL,
  rule_version VARCHAR(64) NOT NULL,
  triggered_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_amh_attendance (attendance_id),
  INDEX idx_amh_person_date (person_id, work_date),
  CONSTRAINT fk_amh_attendance FOREIGN KEY (attendance_id) REFERENCES attendance(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO attendance_settings (setting_key, setting_value, description, updated_by)
VALUES (
  'half_day_pre_checkin_window_minutes',
  '60',
  'ช่วงเวลารับสแกนเข้าก่อนเวลาเริ่มปฏิบัติงานหลังลาครึ่งวันเช้า (นาที เช่น 30, 60, 120)',
  'system_baseline'
);
