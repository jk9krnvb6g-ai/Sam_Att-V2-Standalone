-- ============================================================================
-- Sam_Att V2 Standalone — Synthetic Non-PII Test Seed Data (001)
-- Used strictly for automated test verification & non-production sandbox.
-- Contains ZERO real hospital personnel data or real secrets.
-- ============================================================================

INSERT IGNORE INTO personnel_type_rules (
  personnel_type_code, personnel_type_name, default_grace_minutes,
  CheckinWindowBeforeMinutes, CheckoutWindowAfterMinutes, require_checkout,
  allow_overlapping_shifts, rule_version
) VALUES
  ('CIVIL_SERVANT', 'ข้าราชการ', 15, 120, 240, 1, 0, 'v2.1.0-tz-bkk'),
  ('PUBLIC_HEALTH_EMP', 'พนักงานกระทรวงสาธารณสุข (พกส.)', 15, 120, 240, 1, 1, 'v2.1.0-tz-bkk'),
  ('TEMP_EMPLOYEE', 'ลูกจ้างชั่วคราว (รายเดือน/รายวัน)', 10, 120, 240, 1, 1, 'v2.1.0-tz-bkk');

INSERT IGNORE INTO shifts (
  id, shift_code, shift_name, shift_category, start_time, end_time,
  grace_minutes, cutoff_time, is_cross_midnight, checkin_window_before_min, checkout_window_after_min, is_active
) VALUES
  (1, 'OFF-0816', 'เวรราชการปกติ (08:00–16:00)', 'OFFICIAL', '08:00', '16:00', 15, '10:30', 0, 120, 240, 1),
  (2, 'MOR-0816', 'เวรเช้า (08:00–16:00)', 'MORNING', '08:00', '16:00', 15, '10:30', 0, 120, 240, 1),
  (3, 'AFT-1600', 'เวรบ่าย (16:00–00:00)', 'AFTERNOON', '16:00', '00:00', 15, '18:30', 1, 120, 240, 1),
  (4, 'NIG-0008', 'เวรดึก (00:00–08:00)', 'NIGHT', '00:00', '08:00', 15, '02:30', 0, 120, 240, 1),
  (5, 'EXT-2008', 'เวรข้ามวัน 12 ชม. (20:00–08:00)', 'SPECIAL', '20:00', '08:00', 15, '22:00', 1, 120, 240, 1);

INSERT IGNORE INTO scanner_devices (
  id, machine_no, device_name, ip_address, device_port, location_name,
  is_enabled, last_sync_status
) VALUES
  (1, 101, 'เครื่องสแกนอาคารผู้ป่วยนอก ชั้น 1 (Test)', '192.168.10.101', 4370, 'โถงเวชระเบียน OPD', 1, 'READY_WAITING_EXE'),
  (2, 102, 'เครื่องสแกนอาคารอุบัติเหตุ-ฉุกเฉิน ER (Test)', '192.168.10.102', 4370, 'หน้าห้องฉุกเฉิน ER', 1, 'READY_WAITING_EXE'),
  (3, 103, 'เครื่องสแกนอาคารผู้ป่วยในและบริหาร ชั้น 2 (Test)', '192.168.10.103', 4370, 'หน้ากลุ่มงานบริหารทั่วไป', 1, 'READY_WAITING_EXE'),
  (4, 1, 'เครื่องสแกนนิ้ว รพ.สามชุก เครื่องที่ 1 (CMiF68S)', '192.168.111.163', 5005, 'จุดลงเวลาเครื่องที่ 1 (192.168.111.163)', 1, 'READY'),
  (5, 2, 'เครื่องสแกนนิ้ว รพ.สามชุก เครื่องที่ 2 (CMiF68S)', '192.168.111.164', 5005, 'จุดลงเวลาเครื่องที่ 2 (192.168.111.164)', 1, 'READY'),
  (6, 3, 'เครื่องสแกนนิ้ว รพ.สามชุก เครื่องที่ 3 (CMiF68S)', '192.168.111.165', 5005, 'จุดลงเวลาเครื่องที่ 3 (192.168.111.165)', 1, 'READY');

INSERT IGNORE INTO sync_schedules (
  id, schedule_label, cron_time, is_enabled, updated_by
) VALUES
  (1, 'ซิงก์รอบเที่ยงคืนหลังปิดผลัดบ่าย', '00:00', 1, 'system_seed'),
  (2, 'ซิงก์รอบเช้าหลังเข้าเวรราชการ/เวรเช้า', '08:00', 1, 'system_seed');
