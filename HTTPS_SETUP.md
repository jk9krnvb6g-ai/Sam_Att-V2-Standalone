# คู่มือการตั้งค่าและตรวจสอบใบรับรอง HTTPS บนพอร์ต 4101 (`HTTPS_SETUP.md`)

เอกสารนี้อธิบายการตั้งค่า HTTPS สำหรับระบบ **Sam_Att V2 Standalone** บนเครื่องแม่ข่าย `10.2.0.23` (พอร์ต `4101`)

---

## 1. ตำแหน่งไฟล์ใบรับรองมาตรฐานบน Drive D

```text
D:\WebApps\Sam_Att\Certs\
├── cert.pem     # ใบรับรอง X.509 (Public Certificate in PEM format)
├── key.pem      # กุญแจส่วนตัว (Private Key in PEM format)
└── ca.pem       # (ทางเลือก) ใบรับรองตัวกลาง / Root CA Chain
```

ในไฟล์ `D:\WebApps\Sam_Att\Config\.env`:
```dotenv
HTTPS_ENABLED=true
HTTPS_PORT=4101
SSL_CERT_PATH=D:\WebApps\Sam_Att\Certs\cert.pem
SSL_KEY_PATH=D:\WebApps\Sam_Att\Certs\key.pem
SSL_CA_PATH=
```

---

## 2. การตรวจสอบความถูกต้องของใบรับรองอัตโนมัติ (`validateTlsCertificatePair`)

ก่อนที่เซิร์ฟเวอร์จะเปิดพอร์ต `4101` ในโหมด `NODE_ENV=production` ระบบจะตรวจสอบใบรับรองด้วยโมดูล `node:crypto` (`X509Certificate`) ดังนี้:
1. ตรวจสอบว่าไฟล์ `SSL_CERT_PATH` และ `SSL_KEY_PATH` มีอยู่จริงและอ่านได้
2. ตรวจสอบรูปแบบ PEM ของทั้ง Certificate และ Private Key
3. ตรวจสอบวันหมดอายุ (`validTo`) ว่าใบรับรองยังไม่หมดอายุ
4. ตรวจสอบความตรงกันทางคณิตศาสตร์ระหว่าง Certificate และ Private Key (`x509.checkPrivateKey(privateKey)`)
5. **หมายเหตุสำคัญ:** ในโหมด Production หากไฟล์ใบรับรองหายหรือคู่กุญแจไม่ตรงกัน ระบบจะ**ไม่สร้างใบรับรองใหม่ทับโดยอัตโนมัติขณะรันเซอร์วิส** แต่จะแจ้งข้อผิดพลาดอย่างชัดเจนเพื่อความปลอดภัย (ยกเว้นสั่งสร้างผ่าน `Install_Sam_Att.ps1` ในขั้นตอนติดตั้งครั้งแรก)

---

## 3. การใช้งานใบรับรองภายในองค์กรหรือสร้างใบรับรองสำหรับ IP `10.2.0.23`

### กรณีที่ 1: มีใบรับรองของโรงพยาบาล (Hospital CA / Commercial SSL)
วางไฟล์ `cert.pem` และ `key.pem` ลงใน `D:\WebApps\Sam_Att\Certs\` แล้วรัน `.\Install_Sam_Att.ps1 -Mode FreshInstall` ระบบจะตรวจสอบและใช้งานใบรับรองนั้นทันทีโดยไม่เขียนทับ

### กรณีที่ 2: ให้ Installer สร้างใบรับรอง Self-Signed ที่รองรับ `IP:10.2.0.23`
หากยังไม่มีไฟล์ใน `D:\WebApps\Sam_Att\Certs\` เมื่อรัน `.\Install_Sam_Att.ps1 -Mode FreshInstall` ระบบจะสร้างใบรับรอง X.509 v3 (RSA 2048-bit, SHA-256) ที่มี Subject Alternative Name (SAN) ครอบคลุม:
- `DNS:localhost`
- `IP:127.0.0.1`
- `IP:10.2.0.23`
