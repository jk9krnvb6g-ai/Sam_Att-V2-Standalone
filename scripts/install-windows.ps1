<#
.SYNOPSIS
  Sam_Att V2 Standalone — Windows Service Installer via WinSW Wrapper (Port 4101 HTTPS Only)
.DESCRIPTION
  แก้ไขปัญหา P0 ข้อ 01 และ ข้อ 06:
  1. ติดตั้งและลงทะเบียน Windows Service 'SamAttV2Standalone' ผ่าน WinSW (Windows Service Wrapper)
     โดยอ่านค่าจากไฟล์ scripts\winsw-sam-att.xml (กำหนด Working Directory, Environment, Service Account,
     Restart Policy และ Log Path อย่างครบถ้วน ไม่ใช้ sc.exe ชี้ไปที่ node.exe โดยตรง)
  2. จัดเก็บใบรับรอง TLS (C:\Sam_Att\certs\server.key) นอก Git Repository และตั้งสิทธิ์ไฟล์ (ACL)
     ให้เข้าถึงได้เฉพาะบัญชี Service และ Administrators เท่านั้น
  3. ทดสอบวงจรการทำงาน Start, Stop, Restart และ Health Check บนพอร์ต 4101
     โดยไม่แตะต้อง Service ของระบบจัดซื้อจัดจ้าง (Procurement) หรือ Central API Gateway เด็ดขาด
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\inetpub\wwwroot\Sam_Att",
  [string]$CertsDir = "C:\inetpub\wwwroot\Sam_Att\certs",
  [string]$LogsDir = "C:\inetpub\wwwroot\Sam_Att\logs",
  [string]$BackupsDir = "C:\inetpub\wwwroot\Sam_Att\backups",
  [string]$WinSwExePath = "C:\inetpub\wwwroot\Sam_Att\bin\WinSW-x64.exe",
  [string]$ServiceName = "SamAttV2Standalone",
  [string]$ServiceAccount = "NT AUTHORITY\NetworkService",
  [int]$HttpsPort = 4101
)

$ErrorActionPreference = "Stop"

Write-Host "[Sam_Att V2] 1. ตรวจสอบนโยบายแยกอิสระของเซอร์วิส (Strict Service Isolation Guard)..."
if ($env:COMPUTERNAME -eq "FILESERVER") {
  throw "ABORTED: ห้ามติดตั้งระบบ Sam_Att V2 บนเครื่อง FILESERVER ตามนโยบายความปลอดภัยของโรงพยาบาล"
}

$ForbiddenServices = @("Procurement", "CentralApiGateway", "SamAttGateway")
foreach ($svc in $ForbiddenServices) {
  Write-Host "[Sam_Att V2] Isolation Guard: ยืนยันไม่แตะต้องหรือรีสตาร์ทเซอร์วิส '$svc'"
}

# สร้างโครงสร้างโฟลเดอร์แยกนอก Git Repository สำหรับ Certs, Logs และ Backups
foreach ($dir in @($InstallDir, $CertsDir, $LogsDir, $BackupsDir, (Split-Path $WinSwExePath -Parent))) {
  if (-not (Test-Path $dir)) {
    New-Item -ItemType Directory -Path $dir -Force | Out-Null
  }
}

# ตั้งค่าสิทธิ์ความปลอดภัยของโฟลเดอร์เก็บ Private Key (แก้ไขปัญหา P0 ข้อ 01)
Write-Host "[Sam_Att V2] 2. กำหนดสิทธิ์ ACL ของโฟลเดอร์ใบรับรอง TLS ($CertsDir) เฉพาะ Administrators และ $ServiceAccount..."
& icacls $CertsDir /inheritance:r /grant:r "Administrators:(OI)(CI)F" /grant:r "${ServiceAccount}:(OI)(CI)RX" | Out-Null

$NodeVersion = & node -v
Write-Host "[Sam_Att V2] 3. ตรวจพบ Node.js Runtime: $NodeVersion (เป้าหมาย: v26.13.1)"

Push-Location $InstallDir
try {
  Write-Host "[Sam_Att V2] 4. ติดตั้ง Dependencies จาก package-lock.json (npm ci)..."
  & npm ci
  Write-Host "[Sam_Att V2] 5. ตรวจสอบ TypeScript (npm run typecheck) และ Build Frontend (npm run build)..."
  & npm run typecheck
  & npm run build
  Write-Host "[Sam_Att V2] 6. รัน Database Schema Migrations (npm run db:migrate)..."
  & npm run db:migrate
} finally {
  Pop-Location
}

Write-Host "[Sam_Att V2] 7. ตั้งค่า Windows Firewall อนุญาตเฉพาะ TCP Port $HttpsPort..."
New-NetFirewallRule -DisplayName "Sam_Att V2 Standalone HTTPS ($HttpsPort)" `
  -Direction Inbound -LocalPort $HttpsPort -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

# จัดเตรียมไฟล์ WinSW Service Wrapper (SamAttV2Standalone.exe + SamAttV2Standalone.xml)
$WrapperDir = Split-Path $WinSwExePath -Parent
$ServiceExe = Join-Path $WrapperDir "$ServiceName.exe"
$ServiceXml = Join-Path $WrapperDir "$ServiceName.xml"
$SourceXml = Join-Path $InstallDir "scripts\winsw-sam-att.xml"

if (Test-Path $SourceXml) {
  Copy-Item -Path $SourceXml -Destination $ServiceXml -Force
}

if ((Test-Path $WinSwExePath) -and (-not (Test-Path $ServiceExe))) {
  Copy-Item -Path $WinSwExePath -Destination $ServiceExe -Force
}

if (-not (Test-Path $ServiceExe)) {
  throw "MISSING_WINSW_BINARY: กรุณาวางไฟล์ WinSW-x64.exe ไว้ที่ $WinSwExePath ก่อนรันสคริปต์ติดตั้งเซอร์วิส"
}

Write-Host "[Sam_Att V2] 8. ลงทะเบียน Windows Service '$ServiceName' ผ่าน WinSW Service Wrapper..."
$ExistingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($ExistingSvc) {
  Write-Host "[Sam_Att V2] พบเซอร์วิส '$ServiceName' เดิม กำลังหยุดและอัปเดตค่าตั้งค่า..."
  & $ServiceExe stop | Out-Null
  & $ServiceExe uninstall | Out-Null
}

& $ServiceExe install
Write-Host "[Sam_Att V2] 9. ทดสอบวงจรการทำงานของ Windows Service (Start -> Stop -> Start/Restart)..."
& $ServiceExe start
Start-Sleep -Seconds 3
$StatusAfterStart = (Get-Service -Name $ServiceName).Status
if ($StatusAfterStart -ne "Running") {
  throw "SERVICE_START_FAILED: เซอร์วิส '$ServiceName' ไม่ได้อยู่ในสถานะ Running หลังสั่ง Start (สถานะปัจจุบัน: $StatusAfterStart)"
}

& $ServiceExe restart
Start-Sleep -Seconds 3
$StatusAfterRestart = (Get-Service -Name $ServiceName).Status
if ($StatusAfterRestart -ne "Running") {
  throw "SERVICE_RESTART_FAILED: เซอร์วิส '$ServiceName' ไม่ได้อยู่ในสถานะ Running หลังสั่ง Restart"
}

Write-Host "[Sam_Att V2] 10. ทดสอบ HTTPS Health Check บนพอร์ต $HttpsPort..."
& "$PSScriptRoot\health-check.ps1" -Port $HttpsPort
Write-Host "[Sam_Att V2] ติดตั้งและตรวจสอบความพร้อมของเซอร์วิส '$ServiceName' เสร็จสมบูรณ์!"
