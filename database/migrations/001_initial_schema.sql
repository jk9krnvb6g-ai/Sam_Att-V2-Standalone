-- ============================================================================
-- Sam_Att V2 Standalone — MySQL 8+ Baseline Schema Migration (001)
-- Database: samchuk_attendance_v2
-- Timezone Policy: Asia/Bangkok (+07:00)
-- Safety Rule: Additive idempotent DDL only. No DROP or TRUNCATE statements.
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(64) NOT NULL PRIMARY KEY,
  filename VARCHAR(255) NOT NULL,
  checksum VARCHAR(64) NOT NULL,
  applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 1. personnel: Snapshot from HOSOffice hr_person (Source of Truth)
CREATE TABLE IF NOT EXISTS personnel (
  person_id VARCHAR(64) NOT NULL PRIMARY KEY,
  fingle_id VARCHAR(64) NULL,
  title_name VARCHAR(64) NULL,
  first_name VARCHAR(128) NOT NULL,
  last_name VARCHAR(128) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  position_name VARCHAR(150) NULL,
  department_code VARCHAR(64) NULL,
  department_name VARCHAR(150) NOT NULL,
  work_group_name VARCHAR(150) NULL,
  personnel_type_code VARCHAR(64) NOT NULL,
  personnel_type_name VARCHAR(150) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  mapping_status VARCHAR(32) NOT NULL DEFAULT 'VALID',
  mapping_issue_detail VARCHAR(500) NULL,
  last_synced_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_personnel_fingle (fingle_id),
  INDEX idx_personnel_dept (department_name),
  INDEX idx_personnel_type (personnel_type_code),
  INDEX idx_personnel_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. users: System Accounts, Password Hash, 3-Tier Role, Approved PERSON_ID Mapping
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(150) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('ADMIN', 'RESPONSIBLE_STAFF', 'GENERAL_USER')),
  approved_person_id VARCHAR(64) NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_role (role),
  INDEX idx_users_person_id (approved_person_id),
  CONSTRAINT fk_users_personnel FOREIGN KEY (approved_person_id) REFERENCES personnel(person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. fingerprint_mappings: Effective-Dated FINGLE_ID <-> PERSON_ID Mapping History
CREATE TABLE IF NOT EXISTS fingerprint_mappings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  fingle_id VARCHAR(64) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  conflict_state VARCHAR(32) NOT NULL DEFAULT 'NONE',
  conflict_reason VARCHAR(500) NULL,
  source VARCHAR(64) NOT NULL DEFAULT 'HOSOFFICE_SYNC',
  created_by VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_fp_map_lookup (fingle_id, effective_from, effective_to),
  INDEX idx_fp_map_person (person_id),
  CONSTRAINT fk_fp_map_personnel FOREIGN KEY (person_id) REFERENCES personnel(person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. personnel_type_rules: Attendance & Policy Rules per Personnel Type
CREATE TABLE IF NOT EXISTS personnel_type_rules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  personnel_type_code VARCHAR(64) NOT NULL UNIQUE,
  personnel_type_name VARCHAR(150) NOT NULL,
  default_grace_minutes INT NOT NULL DEFAULT 15,
  CheckinWindowBeforeMinutes INT NOT NULL DEFAULT 120,
  CheckoutWindowAfterMinutes INT NOT NULL DEFAULT 240,
  require_checkout TINYINT(1) NOT NULL DEFAULT 1,
  allow_overlapping_shifts TINYINT(1) NOT NULL DEFAULT 0,
  rule_version VARCHAR(32) NOT NULL DEFAULT 'v2.1.0',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. shifts: Shift Definitions (Morning, Afternoon, Night, Official, Special, Cross-Midnight)
CREATE TABLE IF NOT EXISTS shifts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_code VARCHAR(32) NOT NULL UNIQUE,
  shift_name VARCHAR(128) NOT NULL,
  shift_category VARCHAR(32) NOT NULL,
  start_time VARCHAR(5) NOT NULL,
  end_time VARCHAR(5) NOT NULL,
  grace_minutes INT NOT NULL DEFAULT 15,
  cutoff_time VARCHAR(5) NOT NULL,
  is_cross_midnight TINYINT(1) NOT NULL DEFAULT 0,
  checkin_window_before_min INT NOT NULL DEFAULT 120,
  checkout_window_after_min INT NOT NULL DEFAULT 240,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 6. shift_assignments: Individual Daily Shift Assignments + Rule Snapshot
CREATE TABLE IF NOT EXISTS shift_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  shift_id INT NOT NULL,
  work_date DATE NOT NULL,
  snapshot_shift_code VARCHAR(32) NOT NULL,
  snapshot_shift_name VARCHAR(128) NOT NULL,
  snapshot_start_time VARCHAR(5) NOT NULL,
  snapshot_end_time VARCHAR(5) NOT NULL,
  snapshot_grace_minutes INT NOT NULL,
  snapshot_cutoff_time VARCHAR(5) NOT NULL,
  snapshot_is_cross_midnight TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
  assigned_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sa_person_date (person_id, work_date),
  INDEX idx_sa_work_date (work_date),
  CONSTRAINT fk_sa_personnel FOREIGN KEY (person_id) REFERENCES personnel(person_id),
  CONSTRAINT fk_sa_shift FOREIGN KEY (shift_id) REFERENCES shifts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 7. shift_cancellation_logs: Audit Trail for Cancelled Shift Assignments
CREATE TABLE IF NOT EXISTS shift_cancellation_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  shift_assignment_id INT NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  shift_code VARCHAR(32) NOT NULL,
  cancel_reason VARCHAR(500) NOT NULL,
  cancelled_by VARCHAR(64) NOT NULL,
  cancelled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_scl_assignment FOREIGN KEY (shift_assignment_id) REFERENCES shift_assignments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 8. scanner_devices: Registered Biometric/Fingerprint Scanner Devices
CREATE TABLE IF NOT EXISTS scanner_devices (
  id INT AUTO_INCREMENT PRIMARY KEY,
  machine_no INT NOT NULL UNIQUE,
  device_name VARCHAR(128) NOT NULL,
  ip_address VARCHAR(128) NOT NULL,
  device_port INT NOT NULL DEFAULT 4370,
  location_name VARCHAR(255) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  last_sync_at DATETIME NULL,
  last_success_at DATETIME NULL,
  last_sync_status VARCHAR(32) NOT NULL DEFAULT 'NEVER_RUN',
  last_error_message VARCHAR(500) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 9. sync_schedules: Configured Automatic Scanner Sync Times
CREATE TABLE IF NOT EXISTS sync_schedules (
  id INT AUTO_INCREMENT PRIMARY KEY,
  schedule_label VARCHAR(128) NOT NULL,
  cron_time VARCHAR(16) NOT NULL,
  is_enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_by VARCHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 10. sync_runs: Execution History of Scanner Sync Operations
CREATE TABLE IF NOT EXISTS sync_runs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  trigger_mode VARCHAR(32) NOT NULL,
  machine_no INT NULL,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  status VARCHAR(32) NOT NULL,
  total_events_read INT NOT NULL DEFAULT 0,
  new_scans_inserted INT NOT NULL DEFAULT 0,
  duplicate_scans_skipped INT NOT NULL DEFAULT 0,
  unmatched_scans_count INT NOT NULL DEFAULT 0,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  triggered_by VARCHAR(64) NOT NULL,
  INDEX idx_sync_runs_started (started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 11. raw_scans: Immutable Original Scan Events from Scanner Reader EXE (6-Field Contract)
CREATE TABLE IF NOT EXISTS raw_scans (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_dedup_key VARCHAR(64) NOT NULL UNIQUE,
  machine_no INT NOT NULL,
  enroll_number VARCHAR(64) NOT NULL,
  scan_date_time VARCHAR(32) NOT NULL,
  canonical_bkk_time VARCHAR(32) NOT NULL,
  verify_mode INT NOT NULL,
  in_out_mode INT NOT NULL,
  work_code INT NOT NULL,
  raw_payload_json TEXT NOT NULL,
  matched_person_id VARCHAR(64) NULL,
  mapping_state VARCHAR(32) NOT NULL DEFAULT 'UNMATCHED',
  sync_run_id INT NULL,
  imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_raw_scans_enroll_time (enroll_number, canonical_bkk_time),
  INDEX idx_raw_scans_person_time (matched_person_id, canonical_bkk_time),
  INDEX idx_raw_scans_machine (machine_no),
  CONSTRAINT fk_raw_scans_sync_run FOREIGN KEY (sync_run_id) REFERENCES sync_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 12. attendance: Derived Daily/Shift Attendance Calculation Results
CREATE TABLE IF NOT EXISTS attendance (
  id INT AUTO_INCREMENT PRIMARY KEY,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  shift_assignment_id INT NULL,
  shift_code VARCHAR(32) NULL,
  shift_name VARCHAR(128) NULL,
  scheduled_start VARCHAR(32) NULL,
  scheduled_end VARCHAR(32) NULL,
  cutoff_timestamp VARCHAR(32) NULL,
  check_in_time VARCHAR(32) NULL,
  check_out_time VARCHAR(32) NULL,
  check_in_raw_scan_id INT NULL,
  check_out_raw_scan_id INT NULL,
  status VARCHAR(32) NOT NULL,
  secondary_flags VARCHAR(128) NULL,
  is_late TINYINT(1) NOT NULL DEFAULT 0,
  late_minutes INT NOT NULL DEFAULT 0,
  review_status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  rule_version VARCHAR(32) NOT NULL DEFAULT 'v2.1.0-tz-bkk',
  calculated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_attendance_person_date_shift (person_id, work_date, shift_assignment_id),
  INDEX idx_attendance_work_date (work_date),
  INDEX idx_attendance_status (status),
  INDEX idx_attendance_late (is_late, work_date),
  CONSTRAINT fk_attendance_person FOREIGN KEY (person_id) REFERENCES personnel(person_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 13. attendance_notes: Separate Reason/Note Records (Preserved Across Reprocess)
CREATE TABLE IF NOT EXISTS attendance_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  reason_type VARCHAR(64) NOT NULL,
  note_text VARCHAR(1000) NOT NULL,
  visible_to_employee TINYINT(1) NOT NULL DEFAULT 1,
  created_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_att_notes_attendance (attendance_id),
  CONSTRAINT fk_att_notes_attendance FOREIGN KEY (attendance_id) REFERENCES attendance(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 14. hr_review_history: HR Verification & Approval Log (Preserved Across Reprocess)
CREATE TABLE IF NOT EXISTS hr_review_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  attendance_id INT NOT NULL,
  person_id VARCHAR(64) NOT NULL,
  work_date DATE NOT NULL,
  previous_review_status VARCHAR(32) NOT NULL,
  new_review_status VARCHAR(32) NOT NULL,
  review_reason_category VARCHAR(64) NOT NULL,
  review_comment VARCHAR(1000) NOT NULL,
  reviewed_by VARCHAR(64) NOT NULL,
  reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hr_review_attendance (attendance_id),
  CONSTRAINT fk_hr_review_attendance FOREIGN KEY (attendance_id) REFERENCES attendance(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 15. push_history: HOSOffice Dry-Run Preview & Live Push Batch History
CREATE TABLE IF NOT EXISTS push_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  push_mode VARCHAR(32) NOT NULL,
  date_from DATE NOT NULL,
  date_to DATE NOT NULL,
  total_records INT NOT NULL DEFAULT 0,
  valid_records INT NOT NULL DEFAULT 0,
  invalid_records INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL,
  payload_preview_json TEXT NOT NULL,
  error_detail VARCHAR(1000) NULL,
  initiated_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 16. hosoffice_sync_logs: Personnel Sync History from HOSOffice
CREATE TABLE IF NOT EXISTS hosoffice_sync_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  status VARCHAR(32) NOT NULL,
  records_fetched INT NOT NULL DEFAULT 0,
  records_upserted INT NOT NULL DEFAULT 0,
  mapping_conflicts_found INT NOT NULL DEFAULT 0,
  error_code VARCHAR(64) NULL,
  error_message VARCHAR(1000) NULL,
  triggered_by VARCHAR(64) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 17. audit_logs: System-Wide Security & Operational Audit Trail
CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  request_id VARCHAR(64) NOT NULL,
  actor_username VARCHAR(64) NOT NULL,
  actor_role VARCHAR(32) NOT NULL,
  ip_address VARCHAR(64) NOT NULL,
  action VARCHAR(128) NOT NULL,
  target_type VARCHAR(64) NOT NULL,
  target_id VARCHAR(128) NULL,
  result VARCHAR(32) NOT NULL,
  error_code VARCHAR(64) NULL,
  detail_json TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_created (created_at),
  INDEX idx_audit_action (action),
  INDEX idx_audit_actor (actor_username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 18. revoked_sessions: Revoked JWT / Session Tokens (Logout & Forced Revocation)
CREATE TABLE IF NOT EXISTS revoked_sessions (
  jti VARCHAR(128) NOT NULL PRIMARY KEY,
  username VARCHAR(64) NOT NULL,
  revoked_reason VARCHAR(128) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_revoked_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 19. auth_rate_limits: Brute-Force Login Rate Limiting & Lockout State
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  rate_key VARCHAR(128) NOT NULL PRIMARY KEY,
  failed_attempts INT NOT NULL DEFAULT 0,
  first_failed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  locked_until DATETIME NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 20. deployment_history: Standalone Windows Service Release, Backup & Rollback Ledger
CREATE TABLE IF NOT EXISTS deployment_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  release_version VARCHAR(64) NOT NULL,
  commit_sha VARCHAR(64) NOT NULL,
  artifact_sha256 VARCHAR(64) NOT NULL,
  action_type VARCHAR(32) NOT NULL,
  status VARCHAR(32) NOT NULL,
  backup_archive_path VARCHAR(255) NULL,
  preflight_passed TINYINT(1) NOT NULL DEFAULT 0,
  notes VARCHAR(1000) NULL,
  executed_by VARCHAR(64) NOT NULL,
  executed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
