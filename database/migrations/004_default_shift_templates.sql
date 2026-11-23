-- ============================================================================
-- Sam_Att V2 Standalone - Default Shift Templates per Personnel Type Scope
-- Migration: 004_default_shift_templates.sql
-- Safe additive migration only (no DROP, no TRUNCATE, no historical data changes)
-- ============================================================================
SET NAMES utf8mb4;

-- 1. Unique scope-to-default-shift binding table (DB-level UNIQUE prevents race conditions)
CREATE TABLE IF NOT EXISTS personnel_type_default_shifts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  personnel_type_code VARCHAR(64) NOT NULL UNIQUE,
  shift_id INT NOT NULL,
  assigned_by VARCHAR(64) NOT NULL,
  assigned_reason VARCHAR(500) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_ptds_shift_id (shift_id),
  CONSTRAINT fk_ptds_shift FOREIGN KEY (shift_id) REFERENCES shifts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Direct link from personnel_type_rules to shifts(id) without duplicating policy rules
ALTER TABLE personnel_type_rules ADD COLUMN default_shift_id INT NULL;

-- 3. Record linked default_shift_id in personnel_type_rule_history for full auditability
ALTER TABLE personnel_type_rule_history ADD COLUMN default_shift_id INT NULL;
