# คู่มือการตั้งค่าระบบ Production (`PRODUCTION_CONFIGURATION.md`)

เอกสารนี้อธิบายการตั้งค่าไฟล์ Environment Variables สำหรับระบบ **Sam_Att V2 Standalone** บนเครื่องแม่ข่าย `10.2.0.23`

---

## 1. ตำแหน่งไฟล์ Configuration มาตรฐาน

ในสภาพแวดล้อม Production ไฟล์ `.env` จะถูกเก็บแยกออกจาก Git Working Tree ที่:

```text
D:\WebApps\Sam_Att\Config\.env
```

**ข้อดีของการแยกไฟล์ไว้ที่ `D:\WebApps\Sam_Att\Config\.env`:**
- เวลาอัปเดตโค้ดผ่าน `Deploy_Sam_Att.ps1` หรือ GitHub Update Center ไฟล์ `.env` จะไม่ถูกเขียนทับหรือถูกลบ
- Windows Service `SamAttV2Standalone` กำหนดตัวแปร `SAM_ATT_ENV_PATH=D:\WebApps\Sam_Att\Config\.env` ทำให้แอปพลิเคชันโหลดค่าจากตำแหน่งนี้โดยอัตโนมัติ

---

## 2. รายการตัวแปรสำคัญใน `D:\WebApps\Sam_Att\Config\.env`

```dotenv
# ==============================================================================
# 1. Runtime & Standard Directories
# ==============================================================================
NODE_ENV=production
TZ=Asia/Bangkok
APP_BASE_PATH=/Sam_Att
API_BASE_PATH=/api/Sam_Att

SAM_ATT_ROOT=D:\WebApps\Sam_Att
SAM_ATT_LOG_DIR=D:\WebApps\Sam_Att\Logs
DEPLOYMENT_BACKUP_DIR=D:\Backups\Sam_Att
SAM_ATT_DEPLOYMENTS_DIR=D:\Deployments\Sam_Att
WINDOWS_SERVICE_NAME=SamAttV2Standalone

# ==============================================================================
# 2. HTTPS Server & TLS Certificates (Port 4101)
# ==============================================================================
HTTPS_ENABLED=true
HTTPS_PORT=4101
HTTP_REDIRECT_PORT=0
SSL_CERT_PATH=D:\WebApps\Sam_Att\Certs\cert.pem
SSL_KEY_PATH=D:\WebApps\Sam_Att\Certs\key.pem
SSL_CA_PATH=
CORS_ALLOWED_ORIGINS=https://10.2.0.23:4101,https://localhost:4101

# ==============================================================================
# 3. Authentication & Security Secrets (ห้ามใช้ค่าเริ่มต้นใน Production)
# ==============================================================================
JWT_SECRET=<รหัสสุ่มความยาวอย่างน้อย 32 ตัวอักษร>
JWT_EXPIRES_IN=8h
INITIAL_ADMIN_PASSWORD=<รหัสผ่านผู้ดูแลระบบเริ่มต้นความยาวอย่างน้อย 10 ตัวอักษร>
SESSION_COOKIE_NAME=sam_att_token

# ==============================================================================
# 4. Primary Database (MySQL Server 10.1.0.201)
# ==============================================================================
SAM_ATT_DB_CLIENT=mysql
SAM_ATT_DB_HOST=10.1.0.201
SAM_ATT_DB_PORT=3306
SAM_ATT_DB_USER=<ชื่อผู้ใช้ MySQL>
SAM_ATT_DB_PASSWORD=<รหัสผ่าน MySQL>
SAM_ATT_DB_NAME=samchuk_attendance_v2
SAM_ATT_DB_POOL_LIMIT=10

# ==============================================================================
# 5. Scanner Integration & Standby Mode
# ==============================================================================
# สำคัญ: ตั้งเป็น false ขณะที่เซิร์ฟเวอร์เดิม 10.2.0.13 ยังทำงานอยู่
# เปลี่ยนเป็น true เฉพาะหลังหยุดระบบบน 10.2.0.13 ในขั้นตอน Cutover แล้วเท่านั้น
SCANNER_AUTO_SCHEDULER_ENABLED=false
SCANNER_READER_EXE_PATH=D:\WebApps\Sam_Att\App\ScannerReader\bin\Release\ScannerReader.exe
SCANNER_PORT=4370
SCANNER_TIMEOUT_MS=15000
SCANNER_RETRY_COUNT=2

# ==============================================================================
# 6. GitHub Update Center
# ==============================================================================
GITHUB_REPO_OWNER=jk9krnvb6g-ai
GITHUB_REPO_NAME=Sam_Att-V2-Standalone
GITHUB_BRANCH=main
GITHUB_TOKEN=
```

---

## 3. ระบบตรวจสอบความปลอดภัยของ Configuration อัตโนมัติ (`validateProductionConfig`)

เมื่อเริ่มต้นระบบในโหมด `NODE_ENV=production` ระบบจะตรวจสอบเงื่อนไขต่อไปนี้ทันที (Fail-Fast):
1. **`JWT_SECRET`** ต้องมีความยาวอย่างน้อย 24 ตัวอักษร และห้ามเป็นค่า Default (`change-me-in-production...`)
2. **`INITIAL_ADMIN_PASSWORD`** ต้องมีความยาวอย่างน้อย 10 ตัวอักษร และห้ามเป็นค่า Default (`ChangeMe@12345`)
3. **`SAM_ATT_DB_CLIENT`** ต้องเป็น `mysql` และต้องระบุ `SAM_ATT_DB_HOST`, `SAM_ATT_DB_USER`, `SAM_ATT_DB_NAME` ครบถ้วน
4. **ใบรับรอง HTTPS (`SSL_CERT_PATH` และ `SSL_KEY_PATH`)** ต้องมีอยู่จริง ไม่หมดอายุ และ Private Key ต้องตรงกับ Public Certificate (`x509.checkPrivateKey`)
5. **การปกปิดข้อมูลความลับ (Secret Redaction):** รหัสผ่านและ Token ทั้งหมดจะถูกซ่อน (`[REDACTED]`) โดยอัตโนมัติในไฟล์ Log และ API Response
