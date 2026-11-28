-- ============================================================================
-- Sam_Att V2 Standalone — Governance, Holidays, Closing & Security Schema (006)
-- Database: samchuk_attendance_v2
-- Timezone Policy: Asia/Bangkok (+07:00)
-- Safety Rule: Additive idempotent DDL only. NEVER DROP, TRUNCATE, or DELETE data.
-- ============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 1. Auth & Password Reset Governance (Phase A3 / B5)
ALTER TABLE users ADD COLUMN must_change_password TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_updated_at DATETIME NULL;

-- 2. Optimistic Locking & Monthly Closing Locks on Attendance (Phase B7 / B8)
ALTER TABLE attendance ADD COLUMN record_version INT NOT NULL DEFAULT 1;
ALTER TABLE attendance ADD COLUMN is_locked_period TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE attendance ADD COLUMN late_scan_review_required TINYINT(1) NOT NULL DEFAULT 0;

-- 3. Hospital Holiday Calendar (Phase B1: multi-scope holiday rules)
CREATE TABLE IF NOT EXISTS hospital_holidays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  holiday_date DATE NOT NULL,
  holiday_name VARCHAR(200) NOT NULL,
  category VARCHAR(32) NOT NULL DEFAULT 'NATIONAL',
  scope_type VARCHAR(32) NOT NULL DEFAULT 'ALL',
  department_name VARCHAR(150) NULL,
  person_id VARCHAR(64) NULL,
  override_policy VARCHAR(32) NOT NULL DEFAULT 'EXEMPT',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  notes VARCHAR(500) NULL,
  created_by VARCHAR(64) NOT NULL DEFAULT 'system',
  updated_by VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hh_date_active (holiday_date, is_active),
  INDEX idx_hh_scope (scope_type, department_name, person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Monthly Attendance Closing Ledger (Phase B8)
CREATE TABLE IF NOT EXISTS attendance_periods (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_ym VARCHAR(7) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL DEFAULT 'OPEN',
  readiness_json LONGTEXT NULL,
  summary_snapshot_json LONGTEXT NULL,
  closed_by VARCHAR(64) NULL,
  closed_at DATETIME NULL,
  reopened_by VARCHAR(64) NULL,
  reopened_at DATETIME NULL,
  reopen_reason VARCHAR(500) NULL,
  updated_by VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ap_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Monthly Closing Transition & Reopen Audit History (Phase B8)
CREATE TABLE IF NOT EXISTS attendance_period_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  period_ym VARCHAR(7) NOT NULL,
  previous_status VARCHAR(32) NOT NULL,
  new_status VARCHAR(32) NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  reason VARCHAR(500) NULL,
  readiness_snapshot_json LONGTEXT NULL,
  acted_by VARCHAR(64) NOT NULL,
  acted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_aph_period (period_ym, acted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. Historical Attendance Completeness Runs Ledger (Phase B3)
CREATE TABLE IF NOT EXISTS completeness_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  department_name VARCHAR(150) NULL,
  expected_count INT NOT NULL DEFAULT 0,
  missing_before_count INT NOT NULL DEFAULT 0,
  processed_count INT NOT NULL DEFAULT 0,
  failed_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'SUCCESS',
  result_summary_json LONGTEXT NULL,
  triggered_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_cr_dates (date_from, date_to)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
