-- ============================================================================
-- Sam_Att V2 Standalone — Historical Import, Mapping Audit & Sync Stats (003)
-- Database: samchuk_attendance_v2
-- Timezone Policy: Asia/Bangkok (+07:00)
-- Safety Rule: Additive idempotent DDL only. NEVER DROP, TRUNCATE, or DELETE data.
-- ============================================================================

SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 1. Extend sync_runs with mapping & attendance processing counters + per-machine partial results
ALTER TABLE sync_runs ADD COLUMN matched_scans_count INT NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN conflict_scans_count INT NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN attendance_created_count INT NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN attendance_updated_count INT NOT NULL DEFAULT 0;
ALTER TABLE sync_runs ADD COLUMN machine_results_json TEXT NULL;
ALTER TABLE sync_runs ADD COLUMN import_year_month VARCHAR(7) NULL;

-- 2. Extend fingerprint_mappings with ADMIN retroactive approval audit metadata
ALTER TABLE fingerprint_mappings ADD COLUMN original_effective_from DATE NULL;
ALTER TABLE fingerprint_mappings ADD COLUMN retroactive_adjusted_by VARCHAR(64) NULL;
ALTER TABLE fingerprint_mappings ADD COLUMN retroactive_adjusted_at DATETIME NULL;
ALTER TABLE fingerprint_mappings ADD COLUMN retroactive_reason VARCHAR(500) NULL;
ALTER TABLE fingerprint_mappings ADD COLUMN updated_at DATETIME NULL;
