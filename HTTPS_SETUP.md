# คู่มือการตั้งค่าและตรวจสอบใบรับรอง HTTPS บนพอร์ต 4101 (`HTTPS_SETUP.md`)

เอกสารนี้อธิบายการตั้งค่า HTTPS การติดตั้ง Internal CA Certificate อย่างปลอดภัย และการตรวจสอบ Strict HTTPS Health Check สำหรับระบบ **Sam_Att V2 Standalone** บนเครื่องแม่ข่าย `10.2.0.23` (พอร์ต `4101`)

---

## 1. ตำแหน่งไฟล์ใบรับรองมาตรฐานและการจำกัดสิทธิ์ NTFS ACL

```text
D:\WebApps\Sam_Att\Certs\
├── server.crt   # ใบรับรอง X.509 (Public Certificate in PEM format พร้อม IP SAN: 10.2.0.23)
├── server.key   # กุญแจส่วนตัว (Private Key in PEM format — จำกัดสิทธิ์ NTFS ACL เฉพาะ SYSTEM, Administrators และ Service Account)
└── ca.crt       # (ทางเลือก) ใบรับรอง Root CA ภายในโรงพยาบาล
```

ในไฟล์ `D:\WebApps\Sam_Att\Config\.env`:
```dotenv
SAM_ATT_HTTPS_PORT=4101
TLS_CERT_PATH=D:\WebApps\Sam_Att\Certs\server.crt
TLS_KEY_PATH=D:\WebApps\Sam_Att\Certs\server.key
```

เมื่อรัน `Install_Sam_Att.ps1` ระบบจะใช้ `icacls` ปิดการสืบทอดสิทธิ์ (`/inheritance:r`) บน `D:\WebApps\Sam_Att\Certs\server.key` และ `D:\WebApps\Sam_Att\Config\.env` โดยอนุญาตเฉพาะ `SYSTEM`, `Administrators` และบัญชี Windows Service เท่านั้น

---

## 2. การตรวจสอบความถูกต้องของใบรับรองอัตโนมัติ (`validateTlsCertificatePair`)

ก่อนที่เซิร์ฟเวอร์จะเปิดพอร์ต `4101` ในโหมด `NODE_ENV=production` ระบบจะตรวจสอบใบรับรองด้วยโมดูล `node:crypto` (`X509Certificate`) ดังนี้:
1. ตรวจสอบว่าไฟล์ `TLS_CERT_PATH` และ `TLS_KEY_PATH` มีอยู่จริงและอ่านได้
2. ตรวจสอบรูปแบบ PEM ของทั้ง Certificate และ Private Key
3. ตรวจสอบวันหมดอายุ (`NotBefore` / `NotAfter`) ว่าใบรับรองยังไม่หมดอายุ
4. ตรวจสอบความตรงกันทางคณิตศาสตร์ระหว่าง Certificate และ Private Key (`x509.checkPrivateKey(privateKey)`)
5. **Fail-Closed Policy:** ในโหมด Production หากไฟล์ใบรับรองหายหรือคู่กุญแจไม่ตรงกัน ระบบจะ**ไม่สร้างใบรับรองใหม่ทับโดยอัตโนมัติขณะเริ่มเซอร์วิส**

---

## 3. การติดตั้ง Internal CA Certificate อย่างปลอดภัยโดยไม่ปิด TLS Verification (FIX 01)

สคริปต์ `HealthCheck_Sam_Att.ps1`, `scripts/health-check.ps1` และ `deployment/Deploy_Sam_Att.ps1` **ห้ามใช้** `-SkipCertificateCheck`, `ServerCertificateValidationCallback = { $true }`, `rejectUnauthorized: false` หรือ `NODE_TLS_REJECT_UNAUTHORIZED=0` ใน Production

เพื่อให้ Windows PowerShell 5.1 และเบราว์เซอร์บนเครื่องแม่ข่าย `10.2.0.23` เชื่อถือใบรับรองของโรงพยาบาล (Internal CA หรือ Self-Signed Root Certificate ที่มี `IP SAN: 10.2.0.23`) อย่างถูกต้องตามมาตรฐาน X.509 Chain Trust ให้ดำเนินการดังนี้:

### วิธีที่ 1: นำเข้าใบรับรองเข้าสู่ Windows Trusted Root Certification Authorities (`Cert:\LocalMachine\Root`) ผ่าน PowerShell
รันคำสั่งต่อไปนี้ใน PowerShell (Run as Administrator):

```powershell
Import-Certificate -FilePath "D:\WebApps\Sam_Att\Certs\server.crt" -CertStoreLocation "Cert:\LocalMachine\Root"
```
*(หากใช้ Internal Root CA แยกไฟล์ ให้ระบุ `-FilePath "D:\WebApps\Sam_Att\Certs\ca.crt"`)*

### วิธีที่ 2: ให้ `Install_Sam_Att.ps1` หรือ `HealthCheck_Sam_Att.ps1` นำเข้าด้วยพารามิเตอร์ที่ผู้ดูแลระบบอนุมัติ
```powershell
# ระหว่างติดตั้ง
.\Install_Sam_Att.ps1 -Mode FreshInstall -GenerateSelfSignedCertIfMissing -TrustGeneratedCertInLocalMachineRoot -FirewallRemoteAddress "10.2.0.0/24"

# หรือระบุไฟล์ Internal CA เมื่อรัน Health Check
.\HealthCheck_Sam_Att.ps1 -HostName "10.2.0.23" -Port 4101 -TrustInternalCaCertPath "D:\WebApps\Sam_Att\Certs\server.crt"
```

---

## 4. สิ่งที่ `HealthCheck_Sam_Att.ps1` ตรวจสอบใน Production

1. **X.509 Chain Trust:** ใบรับรองต้องอยู่ใน Trusted Root Certification Authorities ของเครื่อง (`SslPolicyErrors::None`)
2. **Hostname / IP SAN Verification:** ใบรับรองต้องมี Subject Alternative Name (OID `2.5.29.17`) หรือ Subject CN ตรงกับ `10.2.0.23`
3. **Expiration Verification:** เวลาปัจจุบันต้องอยู่ระหว่าง `NotBefore` และ `NotAfter`
4. หากใบรับรองหมดอายุ ไม่ตรงกับ IP `10.2.0.23` หรือยังไม่ถูก Trust สคริปต์จะรายงาน **`[FAIL]`** และคืนค่า Exit Code `1` ทันที
