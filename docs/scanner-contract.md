# สัญญาการเชื่อมต่อ Scanner Reader EXE เดิม (6-Field JSON Contract)

## 1. ข้อกำหนดหลัก
- ใช้ไฟล์ `ScannerReader.exe` เดิมของโรงพยาบาลโดย **ไม่แก้ไขไฟล์ EXE**
- ข้อมูลขาเข้าทุกเหตุการณ์ต้องเป็น JSON Object ที่ประกอบด้วย **6 ฟิลด์บังคับ** ดังนี้:

```json
[
  {
    "machineNo": 101,
    "enrollNumber": "1001",
    "scanDateTime": "2026-11-13 07:50:12",
    "verifyMode": 1,
    "inOutMode": 0,
    "workCode": 0
  }
]
```

## 2. การตรวจสอบความถูกต้องและการตัดข้อมูลซ้ำ (Canonical Deduplication)
1. `machineNo`: จำนวนเต็มบวก (`> 0`)
2. `enrollNumber`: รหัสลายนิ้วมือ/ใบหน้า (`FINGLE_ID`) ไม่ว่างเปล่า
3. `scanDateTime`: แปลงให้อยู่ในรูปแบบมาตรฐาน `YYYY-MM-DD HH:mm:ss` ตามโซนเวลา `Asia/Bangkok`
4. `verifyMode`, `inOutMode`, `workCode`: จำนวนเต็ม (`integer`)
5. **Stable Event Dedup Key (`event_dedup_key`):**
   - คำนวณ `SHA-256` จาก `machineNo|enrollNumber|canonicalBkkTime|verifyMode|inOutMode|workCode`
   - หากนำเข้าซ้ำ 2 รอบ ระบบจะข้ามรายการที่มี `event_dedup_key` ซ้ำโดยอัตโนมัติ (Idempotent Import)
6. **Immutability:** ตาราง `raw_scans` เก็บ `raw_payload_json` ต้นฉบับไว้ถาวร และไม่มี API หรือหน้าจอใดอนุญาตให้แก้ไขหรือลบข้อมูลสแกนต้นฉบับ

## 3. สิ่งที่รอข้อมูลจริงจากเจ้าของระบบ (BLOCKED_BY_EXTERNAL_CONTRACT สำหรับ Live Hardware)
- พาธติดตั้งจริงของ `ScannerReader.exe` บน Windows Server (ค่าเริ่มต้นใน `.env.example`: `C:\Sam_Att\bin\ScannerReader.exe`)
- พารามิเตอร์ Command-line ที่ EXE เดิมรองรับ และ Windows Service Account ที่ได้รับอนุญาตให้รัน EXE
