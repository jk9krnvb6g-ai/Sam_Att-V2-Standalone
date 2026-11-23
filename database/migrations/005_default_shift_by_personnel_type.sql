-- ============================================================================
-- Sam_Att V2 Standalone - Default Shift by Personnel Type (Working Days & Holidays)
-- Migration: 005_default_shift_by_personnel_type.sql
-- Safe additive migration only (no DROP, no TRUNCATE, no historical data changes)
-- ============================================================================
SET NAMES utf8mb4;

-- 1. Working days on which a personnel type's Default Shift applies
--    Digits follow standard JS/ISO weekday numbers: 0=Sunday, 1=Monday ... 6=Saturday
--    Defaults to '1,2,3,4,5,6,0' for backward compatibility with existing rules;
--    administrators can narrow to Mon-Fri ('1,2,3,4,5') or any custom subset.
ALTER TABLE personnel_type_rules ADD COLUMN default_workdays VARCHAR(32) NOT NULL DEFAULT '1,2,3,4,5,6,0';

-- 2. Audit snapshot of default_workdays in personnel_type_rule_history
ALTER TABLE personnel_type_rule_history ADD COLUMN default_workdays VARCHAR(32) NULL;

-- 3. Official public holidays table (Priority 2: Default Shift never overrides public holidays;
--    explicit individual shift_assignments still take Priority 1)
CREATE TABLE IF NOT EXISTS public_holidays (
  id INT AUTO_INCREMENT PRIMARY KEY,
  holiday_date DATE NOT NULL UNIQUE,
  holiday_name VARCHAR(200) NOT NULL,
  holiday_type VARCHAR(32) NOT NULL DEFAULT 'PUBLIC_HOLIDAY',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by VARCHAR(64) NOT NULL DEFAULT 'system',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_public_holidays_date_active (holiday_date, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
