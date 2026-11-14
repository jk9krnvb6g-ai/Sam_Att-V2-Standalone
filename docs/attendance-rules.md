# กฎธุรกิจการคำนวณเวลาปฏิบัติงาน (Attendance Calculation & Reprocess Rules)

## 1. โซนเวลาและเวอร์ชันกฎ
- **Timezone:** `Asia/Bangkok` (`UTC+07:00`)
- **Rule Version ปัจจุบัน:** `v2.1.0-tz-bkk`

## 2. การจับคู่บุคลากรตามช่วงเวลาที่มีผล (Effective-Dated FINGLE_ID Mapping)
- ระบบค้นหา `person_id` จากตาราง `fingerprint_mappings` โดยเปรียบเทียบ `enroll_number = fingle_id` และวันที่สแกนต้องอยู่ในช่วง `effective_from <= scanDate <= effective_to`
- หากรหัส `FINGLE_ID` ว่างเปล่าหรือซ้ำซ้อนกันมากกว่า 1 คนในวันเดียวกัน ระบบจะกำหนดสถานะเป็น `PENDING_MAPPING` โดยไม่ผูกข้อมูลสแกนผิดบุคคล

## 3. นิยามสถานะการลงเวลา (Attendance Statuses)
1. **`NORMAL`**: พบสแกนเข้าภายในช่วงเวลาที่กำหนด (`<= start_time + grace_minutes`) และพบสแกนออกหลังสิ้นสุดเวร
2. **`LATE`**: เวลาสแกนเข้าเกินกว่า `start_time + grace_minutes` โดยคำนวณ `late_minutes = check_in_minute - scheduled_start_minute`
3. **`MISSING_CHECKOUT`**: พบสแกนเข้า แต่เมื่อเลยเวลาสิ้นสุดเวรแล้วยังไม่พบสแกนออก (หากมาสายในวันเดียวกัน ระบบจะคงค่า `is_late = 1`, `late_minutes > 0` และบันทึก `secondary_flags = 'LATE_AND_MISSING_CHECKOUT'` เพื่อไม่ให้สูญเสียข้อเท็จจริงว่ามาสาย)
4. **`NO_SCAN`**: ไม่พบสแกนเข้า และเวลาปัจจุบันได้ผ่านเกณฑ์ `cutoff_time` ของกะนั้นแล้ว (**ห้ามตัดสิน `NO_SCAN` ก่อนถึงเวลา Cutoff**)
5. **`PENDING_MAPPING`**: บุคลากรยังมีปัญหาการจับคู่ `FINGLE_ID` (`EMPTY_FINGLE_ID` หรือ `DUPLICATE_FINGLE_ID`)

## 4. กฎการคำนวณใน Dashboard และรายงาน
- **`late_people` (จำนวนคนที่มาสายไม่ซ้ำ):** `COUNT(DISTINCT person_id)` ของรายการที่มี `is_late = 1`
- **`late_occurrences` (จำนวนครั้งที่มาสาย):** จำนวนเวรทั้งหมดที่มี `is_late = 1`
- **`avgLateMinutesPerOccurrence`:** `นาทีสายรวม ÷ จำนวนครั้งที่สาย (late_occurrences)`
- **`avgLateMinutesPerLatePerson`:** `นาทีสายรวม ÷ จำนวนคนที่สายไม่ซ้ำ (late_people)`
