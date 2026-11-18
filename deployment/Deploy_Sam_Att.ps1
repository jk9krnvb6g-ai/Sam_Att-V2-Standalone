<#
.SYNOPSIS
  Sam_Att V2 Standalone — One-Click Production Deployment & Rollback Script (Samchuk Hospital)
.DESCRIPTION
  สคริปต์อัปเดตระบบ Sam_Att V2 Standalone จาก GitHub (origin/main) สำหรับ Windows Server + IIS
  - ตรวจสอบความพร้อมก่อนอัปเดตครบถ้วน (Preflight Check)
  - ห้ามใช้ git reset --hard หรือ git clean -fd อัตโนมัติ และหยุดทันทีหากมีไฟล์ถูกแก้ไขค้างไว้
  - รักษาไฟล์ .env, ใบรับรอง TLS (certs/), logs/, backups/, และ ScannerReader EXE เดิม 100%
  - ปกป้องระบบอื่นบนเครื่องเดียวกัน (เช่น Procurement, CentralApiGateway) ห้ามใช้ iisreset และห้ามฆ่าโปรเซสจากหมายเลขพอร์ตอย่างเดียว
  - ห้ามรัน Database Migration อัตโนมัติ (หากมีไฟล์ Migration ใหม่จะแสดงรายการและขออนุมัติแยกต่างหาก)
  - รองรับการสำรองข้อมูล (Backup) และย้อนกลับอัตโนมัติ (Automatic Rollback) พร้อมตรวจสอบ Health Check จริงบนพอร์ต HTTPS 4101
#>
[CmdletBinding()]
param(
  [string]$AppDir = "",
  [string]$Branch = "main",
  [string]$Remote = "origin",
  [int]$Port = 4101,
  [switch]$CheckOnly,
  [switch]$ApproveMigrations,
  [switch]$NonInteractive,
  [switch]$SkipTests,
  [string]$MockEnvFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ==============================================================================
# 0. กำหนดพาธหลักและการตั้งค่าเริ่มต้น
# ==============================================================================
if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $ScriptDir = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($ScriptDir)) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
  }
  if ((Split-Path -Leaf $ScriptDir) -ieq "deployment") {
    $AppDir = Split-Path -Parent $ScriptDir
  } elseif (Test-Path "C:\inetpub\wwwroot\Sam_Att\package.json") {
    $AppDir = "C:\inetpub\wwwroot\Sam_Att"
  } else {
    $AppDir = (Get-Location).Path
  }
}
$AppDir = [System.IO.Path]::GetFullPath($AppDir)

$LogsDir = Join-Path $AppDir "logs"
$BackupsRootDir = Join-Path $AppDir "backups"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFilePath = Join-Path $LogsDir "deploy_sam_att_$Timestamp.log"

$ForbiddenServiceNames = @("Procurement", "ProcurementService", "ProcurementPool", "CentralApiGateway", "SamAttGateway", "W3SVC")
$SensitiveSecretsToMask = New-Object System.Collections.Generic.List[string]

$MockConfig = $null
if (-not [string]::IsNullOrWhiteSpace($MockEnvFile)) {
  if (-not (Test-Path $MockEnvFile)) {
    Write-Error "MOCK_ENV_FILE_NOT_FOUND: ไม่พบไฟล์จำลองการทดสอบที่ $MockEnvFile"
    exit 1
  }
  $MockConfig = Get-Content -Path $MockEnvFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Register-SensitiveSecret {
  param([string]$SecretValue)
  if (-not [string]::IsNullOrWhiteSpace($SecretValue) -and $SecretValue.Trim().Length -ge 4) {
    $Trimmed = $SecretValue.Trim()
    if (-not $SensitiveSecretsToMask.Contains($Trimmed)) {
      $SensitiveSecretsToMask.Add($Trimmed) | Out-Null
    }
  }
}

function Protect-SensitiveText {
  param([string]$InputText)
  if ([string]::IsNullOrEmpty($InputText)) {
    return ""
  }
  $Sanitized = $InputText
  foreach ($Secret in $SensitiveSecretsToMask) {
    if (-not [string]::IsNullOrEmpty($Secret)) {
      $Sanitized = $Sanitized.Replace($Secret, "***REDACTED***")
    }
  }
  $Sanitized = [regex]::Replace($Sanitized, '(?i)(PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*([^\s;&"]+)', '$1=***REDACTED***')
  return $Sanitized
}

function Write-DeployLog {
  param(
    [string]$Message,
    [string]$Level = "INFO"
  )
  $SafeMessage = Protect-SensitiveText -InputText $Message
  $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $SafeMessage"
  try {
    if (-not (Test-Path $LogsDir)) {
      New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
    }
    Add-Content -Path $LogFilePath -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {
    # Ignore log write error during early preflight
  }
}

function Write-StepResult {
  param(
    [int]$StepNo,
    [int]$TotalSteps,
    [string]$Label,
    [string]$Status
  )
  $PaddedLabel = $Label.PadRight(22, ' ')
  $Line = "[$StepNo/$TotalSteps] $PaddedLabel $Status"
  Write-DeployLog -Message $Line -Level $(if ($Status -eq "PASS") { "INFO" } else { "ERROR" })
  if ($Status -eq "PASS") {
    Write-Host $Line -ForegroundColor Green
  } elseif ($Status -eq "SKIP") {
    Write-Host $Line -ForegroundColor Yellow
  } else {
    Write-Host $Line -ForegroundColor Red
  }
}

function Read-DotEnvFileSafe {
  param([string]$EnvFilePath)
  $Map = @{}
  if (-not (Test-Path $EnvFilePath)) {
    return $Map
  }
  $Lines = Get-Content -Path $EnvFilePath -Encoding UTF8
  foreach ($RawLine in $Lines) {
    $Trimmed = $RawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($Trimmed) -or $Trimmed.StartsWith("#")) {
      continue
    }
    $EqIdx = $Trimmed.IndexOf("=")
    if ($EqIdx -le 0) {
      continue
    }
    $Key = $Trimmed.Substring(0, $EqIdx).Trim()
    $Val = $Trimmed.Substring($EqIdx + 1).Trim()
    if (($Val.StartsWith('"') -and $Val.EndsWith('"')) -or ($Val.StartsWith("'") -and $Val.EndsWith("'"))) {
      if ($Val.Length -ge 2) {
        $Val = $Val.Substring(1, $Val.Length - 2)
      }
    }
    $Map[$Key] = $Val
    if ($Key -match "(?i)(PASSWORD|SECRET|TOKEN|KEY)") {
      Register-SensitiveSecret -SecretValue $Val
    }
  }
  return $Map
}

function Invoke-HttpsProbe {
  param(
    [string]$Url,
    [switch]$ParseJson,
    [int]$TimeoutSec = 10
  )
  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["healthProbe"]) {
    $ProbeCfg = $MockConfig.healthProbe
    if ($Url -like "*/api/Sam_Att/health") {
      if ($ProbeCfg.apiReachable -eq $false) {
        throw "HEALTH_API_UNREACHABLE: ไม่สามารถเชื่อมต่อ $Url"
      }
      return [PSCustomObject]@{
        StatusCode = [int]$ProbeCfg.apiStatusCode
        Json       = $ProbeCfg.apiPayload
      }
    } else {
      if ($ProbeCfg.frontendReachable -eq $false) {
        throw "FRONTEND_HTTPS_UNREACHABLE: ไม่สามารถเชื่อมต่อ $Url"
      }
      return [PSCustomObject]@{
        StatusCode = [int]$ProbeCfg.frontendStatusCode
        Content    = [string]$ProbeCfg.frontendContent
      }
    }
  }

  if ($PSVersionTable.PSVersion.Major -ge 6) {
    if ($ParseJson) {
      $Resp = Invoke-WebRequest -Uri $Url -SkipCertificateCheck -TimeoutSec $TimeoutSec -UseBasicParsing
      $Parsed = $Resp.Content | ConvertFrom-Json
      return [PSCustomObject]@{
        StatusCode = [int]$Resp.StatusCode
        Json       = $Parsed
      }
    } else {
      $Resp = Invoke-WebRequest -Uri $Url -SkipCertificateCheck -TimeoutSec $TimeoutSec -UseBasicParsing
      return [PSCustomObject]@{
        StatusCode = [int]$Resp.StatusCode
        Content    = $Resp.Content
      }
    }
  } else {
    # Windows PowerShell 5.1 compatibility for local self-signed HTTPS certificate
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $OldCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
      $Resp = Invoke-WebRequest -Uri $Url -TimeoutSec $TimeoutSec -UseBasicParsing
      if ($ParseJson) {
        $Parsed = $Resp.Content | ConvertFrom-Json
        return [PSCustomObject]@{
          StatusCode = [int]$Resp.StatusCode
          Json       = $Parsed
        }
      }
      return [PSCustomObject]@{
        StatusCode = [int]$Resp.StatusCode
        Content    = $Resp.Content
      }
    } finally {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $OldCallback
    }
  }
}

function Test-SamAttHealthEndpoint {
  param(
    [int]$TargetPort = 4101,
    [string]$ExpectedDbEngine = "mysql",
    [string]$ExpectedDbName = "samchuk_attendance_v2",
    [int]$MaxRetries = 6,
    [int]$RetryDelaySec = 2
  )
  $FrontendUrl = "https://localhost:$TargetPort/Sam_Att/"
  $HealthUrl = "https://localhost:$TargetPort/api/Sam_Att/health"
  $LastError = ""

  for ($Attempt = 1; $Attempt -le $MaxRetries; $Attempt++) {
    try {
      $FrontRes = Invoke-HttpsProbe -Url $FrontendUrl -TimeoutSec 8
      if ($FrontRes.StatusCode -ne 200) {
        throw "FRONTEND_HTTP_STATUS_$($FrontRes.StatusCode): หน้าเว็บ $FrontendUrl ตอบกลับ HTTP $($FrontRes.StatusCode) (ต้องการ 200)"
      }

      $ApiRes = Invoke-HttpsProbe -Url $HealthUrl -ParseJson -TimeoutSec 8
      if ($ApiRes.StatusCode -ne 200) {
        throw "API_HTTP_STATUS_$($ApiRes.StatusCode): Health API ตอบกลับ HTTP $($ApiRes.StatusCode) (ต้องการ 200)"
      }

      $Body = $ApiRes.Json
      if ($null -eq $Body) {
        throw "API_INVALID_JSON: Health API ไม่ได้ตอบกลับเป็น JSON ที่ถูกต้อง"
      }
      if ($Body.status -ne "OK") {
        throw "API_STATUS_NOT_OK: Health API รายงาน status=$($Body.status)"
      }
      if ($Body.service -ne "Sam_Att V2 Standalone") {
        throw "API_WRONG_SERVICE: บริการที่ตอบกลับไม่ใช่ Sam_Att V2 Standalone (ได้รับ: $($Body.service))"
      }
      if ($null -eq $Body.database -or $Body.database.connected -ne $true) {
        throw "MYSQL_DISCONNECTED: Health API รายงานว่าไม่สามารถเชื่อมต่อฐานข้อมูลได้ (database.connected != true)"
      }
      if ($Body.database.engine -ne $ExpectedDbEngine) {
        throw "WRONG_DB_ENGINE: ระบบไม่ได้ใช้ฐานข้อมูล '$ExpectedDbEngine' (ได้รับ: $($Body.database.engine))"
      }
      if ($Body.database.databaseName -ne $ExpectedDbName) {
        throw "WRONG_DB_NAME: ชื่อฐานข้อมูลไม่ตรงกับ '$ExpectedDbName' (ได้รับ: $($Body.database.databaseName))"
      }
      if ($null -ne $Body.PSObject.Properties["dataMode"] -and $Body.dataMode -ne "REAL") {
        throw "WRONG_DATA_MODE: ระบบไม่ได้ทำงานในโหมด REAL (ได้รับ: $($Body.dataMode))"
      }

      return [PSCustomObject]@{
        Healthy        = $true
        FrontendStatus = "200 OK"
        ApiStatus      = "200 OK"
        MysqlStatus    = "CONNECTED"
        DatabaseName   = [string]$Body.database.databaseName
        DatabaseEngine = [string]$Body.database.engine
        DataMode       = if ($null -ne $Body.PSObject.Properties["dataMode"]) { [string]$Body.dataMode } else { "REAL" }
        Port           = $TargetPort
      }
    } catch {
      $LastError = $_.Exception.Message
      Write-DeployLog -Message "Health check attempt $Attempt/$MaxRetries failed: $LastError" -Level "WARN"
      if ($Attempt -lt $MaxRetries) {
        Start-Sleep -Seconds $RetryDelaySec
      }
    }
  }

  return [PSCustomObject]@{
    Healthy = $false
    Error   = $LastError
  }
}

# ==============================================================================
# แสดงส่วนหัวของระบบ Deployment
# ==============================================================================
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " SAM_ATT V2 STANDALONE DEPLOYMENT" -ForegroundColor Cyan
Write-Host " Samchuk Hospital" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-DeployLog -Message "Starting Sam_Att V2 Standalone Deployment in $AppDir (CheckOnly=$CheckOnly)"

$State = [ordered]@{
  CurrentStep           = 0
  StepName              = "Initialization"
  CommitBefore          = ""
  CommitAfter           = ""
  RemoteCommit          = ""
  GitPulled             = $false
  BackupCreated         = $false
  BackupDir             = ""
  ScannerExePath        = ""
  ScannerExeSha256      = ""
  IisRoutingMode        = "STANDALONE_DIRECT_4101"
  IisStaticTargetDir    = ""
  BackendProcessMode    = "STANDALONE_NODE_TSX"
  BackendServiceName    = ""
  BackendPm2Name        = ""
  VerifiedSamAttPid     = 0
  ExpectedDbEngine      = "mysql"
  ExpectedDbName        = "samchuk_attendance_v2"
  ExpectedDbHost        = "10.1.0.201"
}

function Invoke-SafeRollback {
  param([string]$FailureReason)

  Write-Host ""
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  Write-Host " INITIATING SAFE ROLLBACK (SAM_ATT ONLY)" -ForegroundColor Yellow
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  Write-DeployLog -Message "Initiating Safe Rollback due to failure: $FailureReason" -Level "WARN"

  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateRollbackFailure"] -and $MockConfig.simulateRollbackFailure -eq $true) {
    Write-DeployLog -Message "CRITICAL: Simulated rollback failure triggered." -Level "ERROR"
    return $false
  }

  $RollbackSuccess = $true

  try {
    Push-Location $AppDir
    try {
      # 1. คืนค่า Git Commit เดิมเฉพาะกรณีที่ดึงโค้ดใหม่ลงมาแล้ว (ห้ามใช้ git reset --hard หรือ git clean -fd)
      if ($State.GitPulled -and -not [string]::IsNullOrWhiteSpace($State.CommitBefore) -and ($State.CommitBefore -ne $State.CommitAfter)) {
        Write-DeployLog -Message "Reverting Git working branch '$Branch' back to previous commit $($State.CommitBefore)..."
        if ($null -eq $MockConfig) {
          & git merge --abort 2>$null
          & git reset --keep $State.CommitBefore
          if ($LASTEXITCODE -ne 0) {
            throw "ROLLBACK_GIT_REVERT_FAILED: ไม่สามารถย้อนกลับไปยัง Commit $($State.CommitBefore) ได้อย่างปลอดภัย"
          }
        }
      }

      # 2. คืนค่าไฟล์ Build (dist/) และไฟล์สำคัญจาก Backup
      if ($State.BackupCreated -and -not [string]::IsNullOrWhiteSpace($State.BackupDir) -and (Test-Path $State.BackupDir)) {
        $BackupDist = Join-Path $State.BackupDir "dist"
        $TargetDist = Join-Path $AppDir "dist"
        if (Test-Path (Join-Path $BackupDist "index.html")) {
          Write-DeployLog -Message "Restoring dist/ bundle from backup $($State.BackupDir)..."
          if (Test-Path $TargetDist) {
            Remove-Item -Path $TargetDist -Recurse -Force -ErrorAction Stop
          }
          Copy-Item -Path $BackupDist -Destination $TargetDist -Recurse -Force -ErrorAction Stop
        }
      }
    } finally {
      Pop-Location
    }

    # 3. รีสตาร์ทเฉพาะโปรเซสของ Sam_Att เท่านั้น (ห้ามแตะต้อง Procurement หรือ IIS ทั้งเครื่อง)
    Write-DeployLog -Message "Restarting Sam_Att backend process after rollback (Mode=$($State.BackendProcessMode))..."
    Restart-SamAttBackendOnly -IsRollback $true

    # 4. ตรวจสอบ Health Check หลัง Rollback
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["postRollbackHealthy"]) {
      if ($MockConfig.postRollbackHealthy -eq $false) {
        throw "POST_ROLLBACK_HEALTH_FAILED: ระบบยังไม่ผ่าน Health Check หลังการ Rollback"
      }
    } else {
      $PostRollbackHealth = Test-SamAttHealthEndpoint -TargetPort $Port -ExpectedDbEngine $State.ExpectedDbEngine -ExpectedDbName $State.ExpectedDbName -MaxRetries 5 -RetryDelaySec 2
      if (-not $PostRollbackHealth.Healthy) {
        throw "POST_ROLLBACK_HEALTH_FAILED: $($PostRollbackHealth.Error)"
      }
    }

    Write-DeployLog -Message "Rollback completed and verified healthy on port $Port." -Level "INFO"
  } catch {
    Write-DeployLog -Message "CRITICAL ROLLBACK ERROR: $($_.Exception.Message)" -Level "ERROR"
    $RollbackSuccess = $false
  }

  return $RollbackSuccess
}

function Restart-SamAttBackendOnly {
  param([bool]$IsRollback = $false)

  # กฎเหล็ก: ห้ามแตะต้อง Procurement, CentralApiGateway หรือ W3SVC เด็ดขาด
  foreach ($Forbidden in $ForbiddenServiceNames) {
    if ($State.BackendServiceName -ieq $Forbidden -or $State.BackendPm2Name -ieq $Forbidden) {
      throw "SECURITY_ISOLATION_VIOLATION: ห้ามจัดการเซอร์วิสต้องห้าม '$Forbidden'"
    }
  }

  if ($null -ne $MockConfig) {
    if ($null -ne $MockConfig.PSObject.Properties["simulateBackendStartFailure"] -and $MockConfig.simulateBackendStartFailure -eq $true -and (-not $IsRollback)) {
      throw "BACKEND_START_FAILED: โปรเซส Sam_Att Backend ไม่สามารถเริ่มทำงานได้บนพอร์ต $Port"
    }
    Write-DeployLog -Message "[MockMode] Restarted Sam_Att backend isolated process (Mode=$($State.BackendProcessMode), IsRollback=$IsRollback)"
    return
  }

  switch ($State.BackendProcessMode) {
    "WINDOWS_SERVICE" {
      $SvcName = $State.BackendServiceName
      Write-DeployLog -Message "Restarting isolated Windows Service '$SvcName'..."
      Restart-Service -Name $SvcName -Force -ErrorAction Stop
      Start-Sleep -Seconds 3
      $SvcObj = Get-Service -Name $SvcName -ErrorAction Stop
      if ($SvcObj.Status -ne "Running") {
        throw "BACKEND_SERVICE_NOT_RUNNING: Windows Service '$SvcName' ไม่อยู่ในสถานะ Running (สถานะปัจจุบัน: $($SvcObj.Status))"
      }
    }
    "PM2_PROCESS" {
      $Pm2App = $State.BackendPm2Name
      Write-DeployLog -Message "Reloading isolated PM2 process '$Pm2App'..."
      & pm2 restart $Pm2App --update-env
      if ($LASTEXITCODE -ne 0) {
        throw "BACKEND_PM2_RESTART_FAILED: คำสั่ง pm2 restart '$Pm2App' ล้มเหลว (ExitCode=$LASTEXITCODE)"
      }
      Start-Sleep -Seconds 2
    }
    "STANDALONE_NODE_TSX" {
      # หยุดเฉพาะ PID ที่ผ่านการตรวจสอบยืนยันแล้วว่าเป็น Sam_Att server.ts เท่านั้น (ห้ามฆ่าจากพอร์ตอย่างเดียว)
      if ($State.VerifiedSamAttPid -gt 0) {
        $ExistingProc = Get-Process -Id $State.VerifiedSamAttPid -ErrorAction SilentlyContinue
        if ($null -ne $ExistingProc) {
          Write-DeployLog -Message "Stopping verified Sam_Att Node.js process (PID=$($State.VerifiedSamAttPid))..."
          Stop-Process -Id $State.VerifiedSamAttPid -Force -ErrorAction Stop
          Start-Sleep -Seconds 2
        }
      }

      $StdOutLog = Join-Path $LogsDir "sam_att_runtime_stdout.log"
      $StdErrLog = Join-Path $LogsDir "sam_att_runtime_stderr.log"
      $NpmCmd = if ($env:OS -like "*Windows*") { "npm.cmd" } else { "npm" }

      Write-DeployLog -Message "Starting single Sam_Att V2 Standalone process (npm start -> tsx server.ts) in $AppDir..."
      $StartedProc = Start-Process -FilePath $NpmCmd `
        -ArgumentList @("start") `
        -WorkingDirectory $AppDir `
        -RedirectStandardOutput $StdOutLog `
        -RedirectStandardError $StdErrLog `
        -WindowStyle Hidden `
        -PassThru
      Start-Sleep -Seconds 3
      if ($StartedProc.HasExited) {
        throw "BACKEND_PROCESS_EXITED_IMMEDIATELY: โปรเซส Sam_Att จบการทำงานทันที (ExitCode=$($StartedProc.ExitCode)) กรุณาตรวจสอบ $StdErrLog"
      }
      $State.VerifiedSamAttPid = $StartedProc.Id
      Write-DeployLog -Message "Started Sam_Att V2 Standalone process (New PID=$($State.VerifiedSamAttPid))."
    }
  }
}

try {
  # ============================================================================
  # STEP 1 — Preflight Check
  # ============================================================================
  $State.CurrentStep = 1
  $State.StepName = "Preflight Check"

  # 1.1 ตรวจสอบโฟลเดอร์ Repository
  if (-not (Test-Path $AppDir)) {
    throw "PREFLIGHT_REPO_NOT_FOUND: ไม่พบโฟลเดอร์ติดตั้งที่ $AppDir"
  }
  foreach ($ReqFile in @(".git", "package.json", "package-lock.json", "server.ts")) {
    if (-not (Test-Path (Join-Path $AppDir $ReqFile))) {
      throw "PREFLIGHT_MISSING_CORE_FILE: ไม่พบไฟล์หรือโฟลเดอร์สำคัญ '$ReqFile' ใน $AppDir"
    }
  }

  Push-Location $AppDir
  try {
    # 1.2 ตรวจสอบ Git Branch และ Working Tree (ห้ามมี Local Changes ค้าง)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["gitBranch"]) {
      $CurrentBranch = [string]$MockConfig.gitBranch
    } else {
      $CurrentBranch = (& git rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -ne 0) {
        throw "PREFLIGHT_GIT_ERROR: ไม่สามารถตรวจสอบ Git Branch ได้ ($CurrentBranch)"
      }
    }
    if ($CurrentBranch -ne $Branch) {
      throw "PREFLIGHT_WRONG_BRANCH: ปัจจุบันอยู่ที่ Branch '$CurrentBranch' (ต้องเป็น '$Branch' เท่านั้น)"
    }

    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["gitDirtyFiles"]) {
      $DirtyOutput = [string]$MockConfig.gitDirtyFiles
    } else {
      $DirtyOutput = (& git status --porcelain --untracked-files=no 2>&1 | Out-String).Trim()
    }
    if (-not [string]::IsNullOrWhiteSpace($DirtyOutput)) {
      throw "PREFLIGHT_DIRTY_WORKING_TREE: พบไฟล์ที่ถูกแก้ไขค้างไว้ใน Git Working Tree กรุณาตรวจสอบก่อน Deploy (ห้ามใช้ git reset --hard อัตโนมัติ):`n$DirtyOutput"
    }

    # 1.3 ตรวจสอบ Node.js และ npm
    $NodeVerRaw = (& node -v 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not ($NodeVerRaw -match "^v(\d+)\.")) {
      throw "PREFLIGHT_NODE_MISSING: ไม่พบ Node.js ในระบบ ($NodeVerRaw)"
    }
    $NodeMajor = [int]$Matches[1]
    if ($NodeMajor -lt 22) {
      throw "PREFLIGHT_NODE_VERSION_UNSUPPORTED: พบ Node.js $NodeVerRaw (ต้องการ Node.js >= v22.0.0)"
    }
    $NpmVerRaw = (& npm -v 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      throw "PREFLIGHT_NPM_MISSING: ไม่พบคำสั่ง npm ในระบบ"
    }
    Write-DeployLog -Message "Runtime verified: Node.js=$NodeVerRaw, npm=$NpmVerRaw"

    # 1.4 ตรวจสอบพื้นที่ว่างบนดิสก์ (อย่างน้อย 500 MB)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["freeDiskMb"]) {
      $FreeDiskMb = [double]$MockConfig.freeDiskMb
    } else {
      $DriveRoot = [System.IO.Path]::GetPathRoot($AppDir)
      $DriveInfo = New-Object System.IO.DriveInfo($DriveRoot)
      $FreeDiskMb = [math]::Round($DriveInfo.AvailableFreeSpace / 1MB, 2)
    }
    if ($FreeDiskMb -lt 500) {
      throw "PREFLIGHT_LOW_DISK_SPACE: พื้นที่ว่างบนดิสก์เหลือเพียง $FreeDiskMb MB (ต้องการอย่างน้อย 500 MB สำหรับการสำรองข้อมูลและ Build)"
    }

    # 1.5 ตรวจสอบไฟล์ .env และการตั้งค่า REAL Mode / MySQL (ห้ามแก้ไขหรือลบ .env เด็ดขาด)
    $DotEnvPath = Join-Path $AppDir ".env"
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["customEnvFile"]) {
      $DotEnvPath = [string]$MockConfig.customEnvFile
    }
    if (-not (Test-Path $DotEnvPath)) {
      throw "PREFLIGHT_ENV_MISSING: ไม่พบไฟล์ .env ที่ $DotEnvPath (ห้าม Deploy โดยไม่มีไฟล์ .env ของระบบ)"
    }

    $EnvMap = Read-DotEnvFileSafe -EnvFilePath $DotEnvPath

    # ตรวจสอบ SAM_ATT_DATA_MODE
    if (-not $EnvMap.ContainsKey("SAM_ATT_DATA_MODE") -or [string]::IsNullOrWhiteSpace($EnvMap["SAM_ATT_DATA_MODE"])) {
      Write-Host "  [คำแนะนำ] ไฟล์ .env ยังไม่ได้ระบุ SAM_ATT_DATA_MODE อย่างชัดเจน (โค้ด backend/src/config/env.ts จะใช้ค่าเริ่มต้นเป็น REAL เมื่อใช้ฐานข้อมูล mysql แนะนำให้เพิ่ม SAM_ATT_DATA_MODE=REAL ในไฟล์ .env)" -ForegroundColor Yellow
      Write-DeployLog -Message "ADVISORY: SAM_ATT_DATA_MODE not explicitly set in .env; backend/src/config/env.ts defaults to REAL when SAM_ATT_DB_ENGINE=mysql." -Level "WARN"
    } elseif ($EnvMap["SAM_ATT_DATA_MODE"].ToUpper() -ne "REAL") {
      throw "PREFLIGHT_INVALID_DATA_MODE: ค่า SAM_ATT_DATA_MODE ใน .env คือ '$($EnvMap["SAM_ATT_DATA_MODE"])' (สำหรับการ Deploy ใช้งานจริงต้องเป็น REAL เท่านั้น ห้ามใช้ DEMO)"
    }

    # ตรวจสอบ SAM_ATT_DB_ENGINE=mysql (ห้ามเปลี่ยนเป็น SQLite อัตโนมัติ)
    $DbEngineVal = if ($EnvMap.ContainsKey("SAM_ATT_DB_ENGINE")) { $EnvMap["SAM_ATT_DB_ENGINE"] } else { "" }
    if ($DbEngineVal -ne "mysql") {
      throw "PREFLIGHT_INVALID_DB_ENGINE: ค่า SAM_ATT_DB_ENGINE ใน .env ต้องเป็น 'mysql' เท่านั้น (พบค่า: '$DbEngineVal') ห้ามใช้ SQLite ใน Production"
    }

    foreach ($ReqEnvKey in @("SAM_ATT_DB_HOST", "SAM_ATT_DB_PORT", "SAM_ATT_DB_NAME", "SAM_ATT_DB_USER", "SAM_ATT_DB_PASSWORD", "JWT_SECRET", "SCANNER_INGEST_SHARED_TOKEN")) {
      if (-not $EnvMap.ContainsKey($ReqEnvKey) -or [string]::IsNullOrWhiteSpace($EnvMap[$ReqEnvKey]) -or $EnvMap[$ReqEnvKey] -eq "CHANGE_ME" -or $EnvMap[$ReqEnvKey] -like "GENERATE_*") {
        throw "PREFLIGHT_ENV_INCOMPLETE: ค่าตัวแปร '$ReqEnvKey' ในไฟล์ .env ไม่ครบถ้วนหรือยังเป็นค่าเริ่มต้นที่ไม่อนุญาต"
      }
    }

    $State.ExpectedDbEngine = $EnvMap["SAM_ATT_DB_ENGINE"]
    $State.ExpectedDbName = $EnvMap["SAM_ATT_DB_NAME"]
    $State.ExpectedDbHost = $EnvMap["SAM_ATT_DB_HOST"]

    # ตรวจสอบ ScannerReader EXE ว่ามีอยู่จริงและบันทึกค่า SHA-256 เพื่อรับประกันว่าไม่ถูกแก้ไข
    $ScannerRel = if ($EnvMap.ContainsKey("SCANNER_READER_EXE_PATH") -and -not [string]::IsNullOrWhiteSpace($EnvMap["SCANNER_READER_EXE_PATH"])) {
      $EnvMap["SCANNER_READER_EXE_PATH"]
    } else {
      "ScannerReader\ScannerSyncCli.exe"
    }
    $ResolvedScannerPath = if ([System.IO.Path]::IsPathRooted($ScannerRel)) { $ScannerRel } else { Join-Path $AppDir $ScannerRel }
    if (Test-Path $ResolvedScannerPath) {
      $State.ScannerExePath = $ResolvedScannerPath
      $State.ScannerExeSha256 = (Get-FileHash -Path $ResolvedScannerPath -Algorithm SHA256).Hash.ToLower()
      Write-DeployLog -Message "ScannerReader binary verified at $ResolvedScannerPath (SHA256=$($State.ScannerExeSha256))"
    }

    # 1.6 ตรวจสอบสิทธิ์และโครงสร้าง IIS (ห้าม Restart IIS หรือแตะต้อง Procurement)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["iisPermissionDenied"] -and $MockConfig.iisPermissionDenied -eq $true) {
      throw "PREFLIGHT_IIS_PERMISSION_DENIED: ไม่มีสิทธิ์เข้าถึงหรือตรวจสอบโครงสร้าง IIS ของ Sam_Att กรุณารันด้วยสิทธิ์ Administrator"
    }
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["iisRoutingMode"]) {
      $State.IisRoutingMode = [string]$MockConfig.iisRoutingMode
    } else {
      # ตรวจสอบว่า Sam_Att ให้บริการผ่าน Single-Port HTTPS 4101 โดยตรง (หรือผ่าน IIS URL Rewrite Reverse Proxy ไปยัง 4101)
      $State.IisRoutingMode = "STANDALONE_DIRECT_4101"
      $AppCmdPath = Join-Path $env:SystemRoot "System32\inetsrv\appcmd.exe"
      if ($env:OS -like "*Windows*" -and (Test-Path $AppCmdPath)) {
        $IisApps = (& $AppCmdPath list app 2>$null | Out-String)
        if ($LASTEXITCODE -ne 0) {
          throw "PREFLIGHT_IIS_PERMISSION_DENIED: ไม่สามารถอ่านค่า IIS Configuration ด้วย appcmd.exe ได้ กรุณาคลิกขวา Run as Administrator"
        }
        if ($IisApps -match "Procurement") {
          Write-DeployLog -Message "IIS Co-tenancy Guard: ตรวจพบระบบ Procurement บน IIS เครื่องเดียวกัน — ล็อกสถานะห้ามแก้ไขหรือรีสตาร์ท AppPool ของ Procurement เด็ดขาด"
        }
      }
    }

    # 1.7 ตรวจสอบพอร์ต 4101 และความเป็นเจ้าของโปรเซส (Process Ownership Verification)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["port4101Owner"]) {
      $OwnerType = [string]$MockConfig.port4101Owner
      if ($OwnerType -eq "FOREIGN_PROCESS") {
        throw "PREFLIGHT_PORT_4101_FOREIGN_PROCESS: พอร์ต $Port ถูกใช้งานโดยโปรเซสอื่นที่ไม่ใช่ Sam_Att (ห้ามหยุดโปรเซสจากเลขพอร์ตโดยไม่ตรวจสอบความเป็นเจ้าของ)"
      }
      if ($null -ne $MockConfig.PSObject.Properties["processManager"]) {
        $State.BackendProcessMode = [string]$MockConfig.processManager
      }
    } else {
      # ตรวจสอบ Windows Service ของ Sam_Att ก่อน
      $WinSvc = Get-Service -Name "SamAttV2Standalone", "Sam_Att_V2_Standalone" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -ne $WinSvc) {
        $State.BackendProcessMode = "WINDOWS_SERVICE"
        $State.BackendServiceName = $WinSvc.Name
        Write-DeployLog -Message "Detected Sam_Att Windows Service: $($WinSvc.Name) (Status=$($WinSvc.Status))"
      } else {
        # ตรวจสอบ PM2 เฉพาะกรณีมีโปรเซสชื่อ Sam_Att
        $Pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
        if ($null -ne $Pm2Cmd) {
          $Pm2ListJson = (& pm2 jlist 2>$null | Out-String).Trim()
          if ($Pm2ListJson.StartsWith("[")) {
            $Pm2Apps = $Pm2ListJson | ConvertFrom-Json
            foreach ($App in $Pm2Apps) {
              if ($App.name -in @("Sam_Att", "sam-att-v2-standalone", "SamAttV2Standalone")) {
                $State.BackendProcessMode = "PM2_PROCESS"
                $State.BackendPm2Name = $App.name
                Write-DeployLog -Message "Detected Sam_Att PM2 process: $($App.name)"
                break
              }
            }
          }
        }
      }

      # ตรวจสอบผู้ถือครองพอร์ต 4101 จริง
      if ($env:OS -like "*Windows*") {
        $NetConn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $NetConn -and $NetConn.OwningProcess -gt 0) {
          $ListenPid = [int]$NetConn.OwningProcess
          $ProcWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $ListenPid" -ErrorAction SilentlyContinue
          $ProcName = if ($null -ne $ProcWmi) { [string]$ProcWmi.Name } else { "" }
          $CmdLine = if ($null -ne $ProcWmi) { [string]$ProcWmi.CommandLine } else { "" }

          # ตรวจสอบว่า CommandLine เป็นของ Sam_Att หรือ Health API ยืนยันว่าเป็น Sam_Att V2 Standalone
          $IsConfirmedSamAtt = $false
          if ($CmdLine -match "Sam_Att" -or $CmdLine -match "server\.ts") {
            $IsConfirmedSamAtt = $true
          } else {
            try {
              $Probe = Invoke-HttpsProbe -Url "https://localhost:$Port/api/Sam_Att/health" -ParseJson -TimeoutSec 5
              if ($Probe.StatusCode -eq 200 -and $Probe.Json.service -eq "Sam_Att V2 Standalone") {
                $IsConfirmedSamAtt = $true
              }
            } catch {
              $IsConfirmedSamAtt = $false
            }
          }

          if (-not $IsConfirmedSamAtt) {
            throw "PREFLIGHT_PORT_4101_FOREIGN_PROCESS: พอร์ต $Port ถูกใช้งานโดยโปรเซสอื่นที่ไม่ใช่ Sam_Att (PID=$ListenPid, Name=$ProcName) ระบบหยุดทำงานทันทีเพื่อความปลอดภัย"
          }
          $State.VerifiedSamAttPid = $ListenPid
          Write-DeployLog -Message "Verified Port $Port is owned by Sam_Att V2 Standalone (PID=$ListenPid, Mode=$($State.BackendProcessMode))."
        }
      }
    }

    # 1.8 ตรวจสอบสิทธิ์การเขียนโฟลเดอร์ Backup
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateBackupDirUnwritable"] -and $MockConfig.simulateBackupDirUnwritable -eq $true) {
      throw "PREFLIGHT_BACKUP_DIR_UNWRITABLE: ไม่สามารถสร้างหรือเขียนไฟล์ในโฟลเดอร์สำรองข้อมูล $BackupsRootDir ได้"
    }
    if (-not (Test-Path $BackupsRootDir)) {
      New-Item -ItemType Directory -Path $BackupsRootDir -Force -ErrorAction Stop | Out-Null
    }
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 1 -TotalSteps 7 -Label "Preflight Check" -Status "PASS"

  # ============================================================================
  # STEP 2 — GitHub Update
  # ============================================================================
  $State.CurrentStep = 2
  $State.StepName = "GitHub Update"

  Push-Location $AppDir
  try {
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateGitFetchFailure"] -and $MockConfig.simulateGitFetchFailure -eq $true) {
      throw "GIT_FETCH_FAILED: ไม่สามารถเชื่อมต่อ GitHub ($Remote/$Branch) ได้ กรุณาตรวจสอบการเชื่อมต่อเครือข่าย"
    }

    $State.CommitBefore = (& git rev-parse HEAD 2>&1 | Out-String).Trim()
    if ($null -eq $MockConfig) {
      $FetchOut = (& git fetch $Remote $Branch 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -ne 0) {
        throw "GIT_FETCH_FAILED: คำสั่ง git fetch $Remote $Branch ล้มเหลว: $FetchOut"
      }
      $State.RemoteCommit = (& git rev-parse "$Remote/$Branch" 2>&1 | Out-String).Trim()
    } else {
      $State.RemoteCommit = if ($null -ne $MockConfig.PSObject.Properties["remoteCommit"]) { [string]$MockConfig.remoteCommit } else { $State.CommitBefore }
    }

    Write-DeployLog -Message "Commit Before Update : $($State.CommitBefore)"
    Write-DeployLog -Message "Remote Target Commit : $($State.RemoteCommit)"

    # ตรวจสอบว่ามีไฟล์ Database Migration เปลี่ยนแปลงหรือไม่ (ห้ามรัน Migration อัตโนมัติ!)
    $PendingMigrations = @()
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["pendingMigrations"]) {
      $PendingMigrations = @($MockConfig.pendingMigrations)
    } elseif ($State.CommitBefore -ne $State.RemoteCommit) {
      $DiffMigrations = (& git diff --name-only "$($State.CommitBefore)..$($State.RemoteCommit)" -- database/migrations/ 2>$null | Out-String).Trim()
      if (-not [string]::IsNullOrWhiteSpace($DiffMigrations)) {
        $PendingMigrations = $DiffMigrations -split "`r?`n"
      }
    }

    if ($PendingMigrations.Count -gt 0 -and (-not $ApproveMigrations)) {
      $MigList = ($PendingMigrations -join ", ")
      throw "MIGRATION_APPROVAL_REQUIRED: ตรวจพบการเปลี่ยนแปลงไฟล์โครงสร้างฐานข้อมูล ($MigList) ตามกฎความปลอดภัยห้ามรัน Migration อัตโนมัติ กรุณาตรวจสอบไฟล์และรันพร้อมพารามิเตอร์ -ApproveMigrations เมื่อได้รับอนุมัติ"
    }

    if ($CheckOnly) {
      Write-StepResult -StepNo 2 -TotalSteps 7 -Label "GitHub Update" -Status "PASS"
      Write-Host ""
      Write-Host "----------------------------------------" -ForegroundColor Cyan
      Write-Host " CHECK-ONLY MODE COMPLETED (NO CHANGES)" -ForegroundColor Cyan
      Write-Host " Current Commit : $($State.CommitBefore)"
      Write-Host " Remote Commit  : $($State.RemoteCommit)"
      Write-Host " IIS Routing    : $($State.IisRoutingMode)"
      Write-Host " Process Mode   : $($State.BackendProcessMode)"
      Write-Host "----------------------------------------" -ForegroundColor Cyan
      exit 0
    }

    if ($null -eq $MockConfig) {
      $PullOut = (& git pull --ff-only $Remote $Branch 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -ne 0) {
        throw "GIT_PULL_FAILED: ไม่สามารถดึงโค้ดด้วย git pull --ff-only ได้ (ห้ามใช้ git reset --hard อัตโนมัติ): $PullOut"
      }
      $State.CommitAfter = (& git rev-parse HEAD 2>&1 | Out-String).Trim()
    } else {
      $State.CommitAfter = $State.RemoteCommit
    }
    $State.GitPulled = $true
    Write-DeployLog -Message "Git pull completed: $($State.CommitBefore) -> $($State.CommitAfter)"
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 2 -TotalSteps 7 -Label "GitHub Update" -Status "PASS"

  # ============================================================================
  # STEP 3 — Backup
  # ============================================================================
  $State.CurrentStep = 3
  $State.StepName = "Backup"

  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateBackupFailure"] -and $MockConfig.simulateBackupFailure -eq $true) {
    throw "BACKUP_FAILED: ไม่สามารถสร้างชุดสำรองข้อมูลก่อนการอัปเดตได้ ยกเลิกการ Deploy ทันที"
  }

  $BackupDir = Join-Path $BackupsRootDir "deploy_backup_$Timestamp"
  New-Item -ItemType Directory -Path $BackupDir -Force -ErrorAction Stop | Out-Null
  $State.BackupDir = $BackupDir

  $DistDir = Join-Path $AppDir "dist"
  if (Test-Path $DistDir) {
    Copy-Item -Path $DistDir -Destination (Join-Path $BackupDir "dist") -Recurse -Force -ErrorAction Stop
  }

  foreach ($CfgFile in @("package.json", "package-lock.json", "server.ts", "vite.config.ts", "tsconfig.json")) {
    $SrcPath = Join-Path $AppDir $CfgFile
    if (Test-Path $SrcPath) {
      Copy-Item -Path $SrcPath -Destination (Join-Path $BackupDir $CfgFile) -Force -ErrorAction Stop
    }
  }

  $BackupManifest = [ordered]@{
    serviceName          = "Sam_Att V2 Standalone"
    backupTimestamp      = $Timestamp
    commitBefore         = $State.CommitBefore
    commitAfter          = $State.CommitAfter
    iisRoutingMode       = $State.IisRoutingMode
    backendProcessMode   = $State.BackendProcessMode
    scannerExeSha256     = $State.ScannerExeSha256
    appDirectory         = $AppDir
  }
  $ManifestPath = Join-Path $BackupDir "backup-manifest.json"
  ($BackupManifest | ConvertTo-Json -Depth 5) | Set-Content -Path $ManifestPath -Encoding UTF8 -ErrorAction Stop
  if (-not (Test-Path $ManifestPath)) {
    throw "BACKUP_MANIFEST_MISSING: ไม่พบไฟล์ backup-manifest.json ในโฟลเดอร์สำรองข้อมูล"
  }
  $ManifestHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
  Set-Content -Path "$ManifestPath.sha256" -Value $ManifestHash -Encoding ASCII -ErrorAction Stop
  $State.BackupCreated = $true
  Write-DeployLog -Message "Created verified pre-deployment backup at $BackupDir (Manifest SHA256=$ManifestHash)"

  Write-StepResult -StepNo 3 -TotalSteps 7 -Label "Backup" -Status "PASS"

  # ============================================================================
  # STEP 4 — Install Dependencies
  # ============================================================================
  $State.CurrentStep = 4
  $State.StepName = "Install Dependencies"

  Push-Location $AppDir
  try {
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateNpmInstallFailure"] -and $MockConfig.simulateNpmInstallFailure -eq $true) {
        throw "NPM_INSTALL_FAILED: การติดตั้ง Dependencies จาก package-lock.json ล้มเหลว"
      }
    } else {
      Write-DeployLog -Message "Installing npm dependencies from package-lock.json..."
      $NpmOut = (& npm ci --no-audit --no-fund 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) {
        Write-DeployLog -Message "npm ci returned code $LASTEXITCODE (checking if Windows file lock on running native module; retrying with npm install --no-audit --no-fund)..." -Level "WARN"
        $NpmOut = (& npm install --no-audit --no-fund 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
          throw "NPM_INSTALL_FAILED: การติดตั้ง Dependencies ล้มเหลว: $NpmOut"
        }
      }
    }
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 4 -TotalSteps 7 -Label "Install Dependencies" -Status "PASS"

  # ============================================================================
  # STEP 5 — Typecheck / Test / Build
  # ============================================================================
  $State.CurrentStep = 5
  $State.StepName = "Typecheck/Test/Build"

  Push-Location $AppDir
  try {
    # 5.1 TypeScript Typecheck
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateTypecheckFailure"] -and $MockConfig.simulateTypecheckFailure -eq $true) {
        throw "TYPECHECK_FAILED: ตรวจพบข้อผิดพลาดในการตรวจสอบชนิดข้อมูล TypeScript (npm run typecheck)"
      }
    } else {
      Write-DeployLog -Message "Running TypeScript typecheck (npm run typecheck)..."
      $TcOut = (& npm run typecheck 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) {
        throw "TYPECHECK_FAILED: ตรวจสอบ TypeScript ไม่ผ่าน:`n$TcOut"
      }
    }

    # 5.2 Automated Unit & Integration Tests (รันใน Sandbox แยกอิสระ ไม่แตะต้อง MySQL จริง)
    if (-not $SkipTests) {
      if ($null -ne $MockConfig) {
        if ($null -ne $MockConfig.PSObject.Properties["simulateTestFailure"] -and $MockConfig.simulateTestFailure -eq $true) {
          throw "UNIT_TESTS_FAILED: ชุดทดสอบอัตโนมัติ (npm test) ไม่ผ่านการตรวจสอบ"
        }
      } else {
        Write-DeployLog -Message "Running automated verification test suite (npm test) in isolated SQLite sandbox..."
        $PrevEngine = $env:SAM_ATT_DB_ENGINE
        $PrevMode = $env:SAM_ATT_DATA_MODE
        $PrevNodeEnv = $env:NODE_ENV
        try {
          $env:SAM_ATT_DB_ENGINE = "sqlite_sandbox"
          $env:SAM_ATT_DATA_MODE = "DEMO"
          $env:NODE_ENV = "test"
          $TestOut = (& npm test 2>&1 | Out-String)
          if ($LASTEXITCODE -ne 0) {
            throw "UNIT_TESTS_FAILED: ชุดทดสอบอัตโนมัติไม่ผ่าน:`n$TestOut"
          }
        } finally {
          $env:SAM_ATT_DB_ENGINE = $PrevEngine
          $env:SAM_ATT_DATA_MODE = $PrevMode
          $env:NODE_ENV = $PrevNodeEnv
        }
      }
    }

    # 5.3 Production Frontend Build (vite build -> dist/index.html)
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateBuildFailure"] -and $MockConfig.simulateBuildFailure -eq $true) {
        throw "BUILD_FAILED: การคอมไพล์ Frontend (npm run build) ล้มเหลว หรือไม่พบไฟล์ dist/index.html"
      }
    } else {
      Write-DeployLog -Message "Running Frontend production build (npm run build)..."
      # ลบไฟล์ bun.lock หากมีเพื่อไม่ให้ขัดแย้งกับนโยบาย Single Lockfile
      if (Test-Path (Join-Path $AppDir "bun.lock")) {
        Remove-Item -Path (Join-Path $AppDir "bun.lock") -Force -ErrorAction SilentlyContinue
      }
      $BuildOut = (& npm run build 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) {
        throw "BUILD_FAILED: คำสั่ง npm run build ล้มเหลว:`n$BuildOut"
      }
    }

    $BuiltIndexHtml = Join-Path $AppDir "dist\index.html"
    if (-not (Test-Path $BuiltIndexHtml)) {
      throw "BUILD_ARTIFACT_MISSING: ไม่พบไฟล์ dist\index.html หลังการ Build"
    }
    if ((Get-Item $BuiltIndexHtml).Length -le 32) {
      throw "BUILD_ARTIFACT_EMPTY: ไฟล์ dist\index.html มีขนาดไม่ถูกต้อง"
    }

    # ยืนยันว่าไฟล์ ScannerReader EXE ไม่ถูกเปลี่ยนแปลง
    if (-not [string]::IsNullOrWhiteSpace($State.ScannerExePath) -and (Test-Path $State.ScannerExePath)) {
      $CurrentScannerSha = (Get-FileHash -Path $State.ScannerExePath -Algorithm SHA256).Hash.ToLower()
      if ($CurrentScannerSha -ne $State.ScannerExeSha256) {
        throw "SCANNER_EXE_MODIFIED_VIOLATION: ตรวจพบการเปลี่ยนแปลงไฟล์ ScannerReader EXE โดยไม่ได้รับอนุญาต"
      }
    }
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 5 -TotalSteps 7 -Label "Typecheck/Test/Build" -Status "PASS"

  # ============================================================================
  # STEP 6 — IIS / Backend Update
  # ============================================================================
  $State.CurrentStep = 6
  $State.StepName = "IIS / Backend Update"

  # 6.1 อัปเดต Frontend ตามสถาปัตยกรรม IIS ที่ตรวจพบ (ห้ามใช้ iisreset และห้ามแตะ Procurement)
  if ($State.IisRoutingMode -eq "IIS_STATIC_VIRTUAL_DIR" -and -not [string]::IsNullOrWhiteSpace($State.IisStaticTargetDir)) {
    Write-DeployLog -Message "Updating static IIS folder for Sam_Att only at $($State.IisStaticTargetDir)..."
    Copy-Item -Path (Join-Path $AppDir "dist\*") -Destination $State.IisStaticTargetDir -Recurse -Force -ErrorAction Stop
  } else {
    Write-DeployLog -Message "IIS Routing Mode is $($State.IisRoutingMode): Frontend (/Sam_Att/) and API (/api/Sam_Att/) are served from $AppDir\dist via HTTPS Port $Port without restarting IIS or Procurement."
  }

  # 6.2 รีสตาร์ทเฉพาะโปรเซสของ Sam_Att V2 Standalone
  Restart-SamAttBackendOnly -IsRollback $false

  Write-StepResult -StepNo 6 -TotalSteps 7 -Label "IIS / Backend Update" -Status "PASS"

  # ============================================================================
  # STEP 7 — Health Check
  # ============================================================================
  $State.CurrentStep = 7
  $State.StepName = "Health Check"

  $HealthOutcome = Test-SamAttHealthEndpoint `
    -TargetPort $Port `
    -ExpectedDbEngine $State.ExpectedDbEngine `
    -ExpectedDbName $State.ExpectedDbName `
    -MaxRetries $(if ($null -ne $MockConfig) { 1 } else { 8 }) `
    -RetryDelaySec $(if ($null -ne $MockConfig) { 0 } else { 2 })

  if (-not $HealthOutcome.Healthy) {
    throw "HEALTH_CHECK_FAILED: $($HealthOutcome.Error)"
  }

  Write-StepResult -StepNo 7 -TotalSteps 7 -Label "Health Check" -Status "PASS"

  Write-Host ""
  Write-Host "----------------------------------------" -ForegroundColor Cyan
  Write-Host "Frontend HTTPS : $($HealthOutcome.FrontendStatus)"
  Write-Host "Backend API    : $($HealthOutcome.ApiStatus)"
  Write-Host "MySQL          : $($HealthOutcome.MysqlStatus)"
  Write-Host "Database       : $($HealthOutcome.DatabaseName)"
  Write-Host "Port           : $($HealthOutcome.Port)"
  if ($State.CommitBefore -ne "" -and $State.CommitAfter -ne "") {
    Write-Host "Commit         : $($State.CommitBefore.Substring(0, [Math]::Min(8, $State.CommitBefore.Length))) -> $($State.CommitAfter.Substring(0, [Math]::Min(8, $State.CommitAfter.Length)))"
  }
  Write-Host "----------------------------------------" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "DEPLOYMENT SUCCESS" -ForegroundColor Green
  Write-DeployLog -Message "DEPLOYMENT SUCCESS on Port $Port (Database=$($HealthOutcome.DatabaseName), Commit=$($State.CommitAfter))"
  exit 0

} catch {
  $ErrMessage = Protect-SensitiveText -InputText $_.Exception.Message
  if ($State.CurrentStep -ge 1 -and $State.CurrentStep -le 7) {
    Write-StepResult -StepNo $State.CurrentStep -TotalSteps 7 -Label $State.StepName -Status "FAIL"
  }
  Write-Host ""
  Write-Host "ERROR [$($State.StepName)]: $ErrMessage" -ForegroundColor Red
  Write-DeployLog -Message "FAILED at Step $($State.CurrentStep) ($($State.StepName)): $ErrMessage" -Level "ERROR"

  # หากผ่านขั้นตอน Preflight และเริ่มเปลี่ยนแปลงโค้ดหรือโปรเซสแล้ว ให้ดำเนินการ Rollback อัตโนมัติ
  if ($State.CurrentStep -ge 4 -or $State.GitPulled) {
    $RolledBack = Invoke-SafeRollback -FailureReason $ErrMessage
    if ($RolledBack) {
      Write-Host ""
      Write-Host "DEPLOYMENT FAILED — ROLLED BACK SAFELY TO PREVIOUS VERSION" -ForegroundColor Yellow
      exit 1
    } else {
      Write-Host ""
      Write-Host "DEPLOYMENT CRITICAL — ROLLBACK FAILED (MANUAL INTERVENTION REQUIRED)" -ForegroundColor Red
      exit 2
    }
  }

  Write-Host ""
  Write-Host "DEPLOYMENT ABORTED (NO SYSTEM CHANGES APPLIED)" -ForegroundColor Yellow
  exit 1
}
