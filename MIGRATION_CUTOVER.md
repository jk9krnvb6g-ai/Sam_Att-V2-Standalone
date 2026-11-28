# แผนการย้ายระบบและสลับใช้งานจริง (`MIGRATION_CUTOVER.md`)

เอกสารนี้อธิบายขั้นตอนการย้ายระบบ **Sam_Att V2 Standalone** จากเซิร์ฟเวอร์เดิม (**`10.2.0.13`**) มายังเซิร์ฟเวอร์ใหม่ (**`10.2.0.23`** — Windows Server 2025) โดยใช้ฐานข้อมูล MySQL เดิม (**`10.1.0.201:3306` / `samchuk_attendance_v2`**) อย่างปลอดภัยไร้รอยต่อ

---

## ระยะที่ 1: การติดตั้งและทดสอบคู่ขนานในโหมด Standby (Parallel Standby Phase)

ในระยะนี้ เซิร์ฟเวอร์เดิม (`10.2.0.13`) ยังคงเป็นเครื่องหลักที่ดึงข้อมูลจากเครื่องสแกนลายนิ้วมือตามรอบเวลาปกติ

1. **ติดตั้งระบบบนเซิร์ฟเวอร์ใหม่ (`10.2.0.23`):**
   - รัน `.\Preflight_Sam_Att.ps1 -MySqlHost 10.1.0.201 -MySqlPort 3306`
   - รัน `.\Install_Sam_Att.ps1 -Mode FreshInstall`
2. **ยืนยันว่า `10.2.0.23` อยู่ในโหมด Scanner Standby:**
   - ตรวจสอบว่าใน `D:\WebApps\Sam_Att\Config\.env` กำหนดค่า:
     ```dotenv
     SCANNER_AUTO_SCHEDULER_ENABLED=false
     ```
   - ตรวจสอบผลลัพธ์จาก `https://10.2.0.23:4101/api/Sam_Att/health` ต้องแสดง `"scanner": { "autoSchedulerEnabled": false, "standbyMode": true }`
3. **ทดสอบการใช้งานผ่านหน้าเว็บ `https://10.2.0.23:4101/Sam_Att/`:**
   - ทดสอบเข้าสู่ระบบ ดูรายงานการลงเวลา ตารางเวร และศูนย์อัปเดตระบบ (GitHub Update Center)
   - ยืนยันว่าข้อมูลจากฐานข้อมูล `10.1.0.201` แสดงผลถูกต้องครบถ้วน

---

## ระยะที่ 2: การสลับระบบเข้าใช้งานจริง (Cutover Window)

ดำเนินการในช่วงเวลาที่ไม่มีการซิงก์เครื่องสแกนลายนิ้วมือ (เช่น หลังรอบซิงก์เสร็จสิ้น):

1. **หยุดบริการบนเซิร์ฟเวอร์เดิม (`10.2.0.13`):**
   - เข้าไปยังเซิร์ฟเวอร์เดิม `10.2.0.13`
   - หยุด Windows Service หรือโปรเซสของ Sam_Att บนเครื่อง `10.2.0.13` และตั้ง Startup Type เป็น `Disabled` เพื่อไม่ให้เครื่องเดิมกลับมาดึงข้อมูลเครื่องสแกนซ้ำ
2. **ลงทะเบียน SDK เครื่องสแกนและเปิดใช้งาน Scheduler บนเซิร์ฟเวอร์ใหม่ (`10.2.0.23`):**
   - ยืนยันว่าลงทะเบียน `zkemkeeper.dll` (32-bit) บน `10.2.0.23` แล้ว:
     ```powershell
     C:\Windows\SysWOW64\regsvr32.exe C:\Windows\SysWOW64\zkemkeeper.dll
     ```
   - แก้ไขไฟล์ `D:\WebApps\Sam_Att\Config\.env` บนเครื่อง `10.2.0.23`:
     ```dotenv
     SCANNER_AUTO_SCHEDULER_ENABLED=true
     ```
   - แก้ไขไฟล์ `D:\WebApps\Sam_Att\Service\SamAttV2Standalone.xml` ให้ `<env name="SCANNER_AUTO_SCHEDULER_ENABLED" value="true" />`
   - รีสตาร์ทบริการบนเครื่อง `10.2.0.23`:
     ```powershell
     Restart-Service -Name SamAttV2Standalone
     ```
3. **ตรวจสอบหลัง Cutover:**
   - รัน `.\HealthCheck_Sam_Att.ps1` บน `10.2.0.23`
   - ทดสอบกดซิงก์เครื่องสแกนลายนิ้วมือแบบ Manual (โหมด `TODAY`) ผ่านหน้าเว็บ `https://10.2.0.23:4101/Sam_Att/` เพื่อยืนยันการเชื่อมต่อพอร์ต `4370`
   - แจ้งผู้ใช้งานเปลี่ยน Bookmark มายัง `https://10.2.0.23:4101/Sam_Att/`

---

## ระยะที่ 3: แผนย้อนกลับฉุกเฉิน (Emergency Cutover Rollback Plan)

หากพบปัญหาด้านเครือข่ายระหว่าง `10.2.0.23` กับเครื่องสแกนลายนิ้วมือในช่วง Cutover:
1. ตั้งค่า `SCANNER_AUTO_SCHEDULER_ENABLED=false` บน `10.2.0.23` แล้วรัน `Restart-Service -Name SamAttV2Standalone`
2. เปิดบริการ Sam_Att บนเครื่องเดิม `10.2.0.13` กลับมาทำงานได้ทันที เนื่องจากโครงสร้างฐานข้อมูล MySQL บน `10.1.0.201` ไม่มีการเปลี่ยนแปลงใด ๆ ทั้งสิ้น
