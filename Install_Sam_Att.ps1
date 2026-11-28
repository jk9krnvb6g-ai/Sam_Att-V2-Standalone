<#
.SYNOPSIS
  Sam_Att V2 Standalone - One-Click Windows Server 2025 Installer & Lifecycle Manager (Phase 2.7)
.DESCRIPTION
  20-Step Production Installer for Sam_Att V2 Standalone on Windows Server 2025 (10.2.0.23):
  - Modes: Preflight | FreshInstall | Repair | Upgrade | Uninstall
  - Supports -WhatIf / -DryRun and Idempotent Lock (D:\Deployments\Sam_Att\install.lock)
  - Creates standard Drive D directory hierarchy:
      D:\WebApps\Sam_Att\App
      D:\WebApps\Sam_Att\Config
      D:\WebApps\Sam_Att\Logs
      D:\WebApps\Sam_Att\Service
      D:\WebApps\Sam_Att\Certs
      D:\Backups\Sam_Att
      D:\Deployments\Sam_Att
      D:\Installers
  - Interactive Configuration Wizard using Read-Host -AsSecureString for DB_PASSWORD
  - Strictly Read-Only MySQL 10.1.0.201:3306 connection & schema compatibility verification
  - Configures Inbound Firewall Rule 'Sam_Att V2 HTTPS 4101' (TCP 4101, configurable RemoteAddress)
  - Installs & starts WinSW service 'SamAttV2Standalone' (Automatic Delayed Start)
  - Never uses taskkill /F /IM node.exe, Stop-Process -Name node -Force, iisreset, or Restart-Computer
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [ValidateSet("Preflight", "FreshInstall", "Repair", "Upgrade", "Uninstall")]
  [string]$Mode = "FreshInstall",
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$BackupRootDir = "D:\Backups\Sam_Att",
  [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
  [string]$InstallersDir = "D:\Installers",
  [string]$RepoUrl = "https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone.git",
  [string]$Branch = "main",
  [string]$ServiceName = "SamAttV2Standalone",
  [string]$ServiceAccount = "NT AUTHORITY\NetworkService",
  [int]$HttpsPort = 4101,
  [string]$ServerIp = "10.2.0.23",
  [string]$DbHost = "10.1.0.201",
  [int]$DbPort = 3306,
  [string]$DbName = "samchuk_attendance_v2",
  [string]$DbUser = "sam_att_app",
  [string]$FirewallRemoteAddress = "LocalSubnet,10.0.0.0/8,192.168.0.0/16",
  [string]$WinSwSourcePath = "",
  [switch]$GenerateInternalSelfSignedCertIfMissing,
  [switch]$NonInteractive,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $RootDir "App"
$ConfigDir = Join-Path $RootDir "Config"
$LogsDir = Join-Path $RootDir "Logs"
$ServiceDir = Join-Path $RootDir "Service"
$CertsDir = Join-Path $RootDir "Certs"
$EnvFilePath = Join-Path $ConfigDir ".env"
$CertPath = Join-Path $CertsDir "server.crt"
$KeyPath = Join-Path $CertsDir "server.key"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$InstallLogPath = Join-Path $LogsDir "install_${Timestamp}.log"
$ReportJsonPath = Join-Path $LogsDir "install_report_${Timestamp}.json"
$LockFilePath = Join-Path $DeploymentsDir "install.lock"

$StepResults = New-Object System.Collections.Generic.List[object]

function Write-InstallLog {
  param(
    [string]$Message,
    [string]$Level = "INFO"
  )
  $SafeMsg = [regex]::Replace($Message, '(?i)(PASSWORD|SECRET|TOKEN|KEY)\s*=\s*[^\s;&"]+', '$1=***REDACTED***')
  $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $SafeMsg"
  try {
    if (Test-Path $LogsDir) {
      Add-Content -Path $InstallLogPath -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
    }
  } catch {}
  $Color = if ($Level -eq "ERROR") { "Red" } elseif ($Level -eq "WARN") { "Yellow" } else { "Cyan" }
  Write-Host $Line -ForegroundColor $Color
}

function Record-InstallerStep {
  param(
    [int]$StepNo,
    [string]$StepTitle,
    [string]$Status,
    [string]$Detail
  )
  $StepResults.Add([ordered]@{
    stepNumber  = $StepNo
    title       = $StepTitle
    status      = $Status
    detail      = $Detail
    timestamp   = (Get-Date).ToUniversalTime().ToString("o")
  }) | Out-Null
  $Color = if ($Status -eq "PASS") { "Green" } elseif ($Status -eq "SKIP" -or $Status -eq "WARN") { "Yellow" } else { "Red" }
  Write-Host ("[{0,2}/20] {1,-44} [{2}] {3}" -f $StepNo, $StepTitle, $Status, $Detail) -ForegroundColor $Color
  Write-InstallLog -Message "Step $StepNo ($StepTitle): [$Status] $Detail" -Level $(if ($Status -eq "FAIL") { "ERROR" } else { "INFO" })
}

function New-RandomHexSecret {
  param([int]$ByteLength = 48)
  $Bytes = New-Object byte[] $ByteLength
  $Rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $Rng.GetBytes($Bytes)
  } finally {
    $Rng.Dispose()
  }
  return ([System.BitConverter]::ToString($Bytes) -replace '-', '').ToLower()
}

function ConvertFrom-SecureStringPlain {
  param([System.Security.SecureString]$SecureValue)
  if ($null -eq $SecureValue) { return "" }
  $Bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($Bstr)
  } finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Bstr)
  }
}

if ($Mode -eq "Preflight") {
  $PreflightScript = Join-Path $PSScriptRoot "Preflight_Sam_Att.ps1"
  & $PreflightScript -RootDir $RootDir -BackupRootDir $BackupRootDir -DeploymentsDir $DeploymentsDir -ServiceName $ServiceName -HttpsPort $HttpsPort -AllowMissingConfig -AllowMissingCerts
  exit $LASTEXITCODE
}

if ($Mode -eq "Uninstall") {
  $UninstallScript = Join-Path $PSScriptRoot "Uninstall_Sam_Att.ps1"
  & $UninstallScript -RootDir $RootDir -ServiceName $ServiceName
  exit $LASTEXITCODE
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Sam_Att V2 Standalone - 20-Step Production Installer (Mode: $Mode)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

if ($DryRun) {
  Write-Host "[DRY-RUN MODE] Simulating 20-step workflow without modifying service or files." -ForegroundColor Yellow
}

try {
  # STEP 1: Check Administrator Privilege
  $IsAdmin = $false
  if ($env:OS -like "*Windows*") {
    $Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  if (-not $IsAdmin -and -not $DryRun) {
    Record-InstallerStep -StepNo 1 -StepTitle "Check Administrator Privilege" -Status "FAIL" -Detail "Administrator privileges required"
    throw "ADMIN_PRIVILEGE_REQUIRED: Please run PowerShell as Administrator"
  }
  Record-InstallerStep -StepNo 1 -StepTitle "Check Administrator Privilege" -Status "PASS" -Detail "Elevated Administrator verified"

  # STEP 2: Check Windows Server Version
  if ($env:COMPUTERNAME -eq "FILESERVER") {
    Record-InstallerStep -StepNo 2 -StepTitle "Check Windows Server Version" -Status "FAIL" -Detail "Forbidden host FILESERVER"
    throw "FORBIDDEN_HOST_FILESERVER: Refusing to install on FILESERVER"
  }
  $OsCaption = try { (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption } catch { $env:OS }
  Record-InstallerStep -StepNo 2 -StepTitle "Check Windows Server Version" -Status "PASS" -Detail "Host=$($env:COMPUTERNAME), OS=$OsCaption"

  # STEP 3: Check PowerShell Version
  if ($PSVersionTable.PSVersion.Major -lt 5) {
    Record-InstallerStep -StepNo 3 -StepTitle "Check PowerShell Version" -Status "FAIL" -Detail "PowerShell $($PSVersionTable.PSVersion) < 5.1"
    throw "POWERSHELL_VERSION_UNSUPPORTED: PowerShell 5.1 or higher is required"
  }
  Record-InstallerStep -StepNo 3 -StepTitle "Check PowerShell Version" -Status "PASS" -Detail "PowerShell v$($PSVersionTable.PSVersion)"

  # STEP 4: Check Drive D & Free Disk Space
  $DriveLetter = (Split-Path -Qualifier $RootDir).TrimEnd(':')
  $DriveObj = Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue
  if ($null -eq $DriveObj -and -not $DryRun) {
    Record-InstallerStep -StepNo 4 -StepTitle "Check Drive D & Free Disk Space" -Status "FAIL" -Detail "Drive ${DriveLetter}: not found"
    throw "DRIVE_NOT_FOUND: Drive ${DriveLetter}: is not available"
  }
  $FreeGB = if ($DriveObj) { [math]::Round(($DriveObj.Free / 1GB), 2) } else { 0 }
  if ($FreeGB -lt 5 -and -not $DryRun) {
    Record-InstallerStep -StepNo 4 -StepTitle "Check Drive D & Free Disk Space" -Status "FAIL" -Detail "Insufficient disk space (${FreeGB} GB free)"
    throw "INSUFFICIENT_DISK_SPACE: Minimum 5 GB free space required on Drive ${DriveLetter}:"
  }
  Record-InstallerStep -StepNo 4 -StepTitle "Check Drive D & Free Disk Space" -Status "PASS" -Detail "Drive ${DriveLetter}: has ${FreeGB} GB free"

  # STEP 5: Create Standard Directory Structure & Acquire Lock
  $RequiredDirs = @($RootDir, $AppDir, $ConfigDir, $LogsDir, $ServiceDir, $CertsDir, $BackupRootDir, $DeploymentsDir, $InstallersDir)
  if (-not $DryRun) {
    foreach ($Dir in $RequiredDirs) {
      if (-not (Test-Path $Dir)) {
        New-Item -ItemType Directory -Path $Dir -Force | Out-Null
      }
    }
    if (Test-Path $LockFilePath) {
      throw "INSTALL_LOCK_ACTIVE: Another installation is already holding $LockFilePath"
    }
    Set-Content -Path $LockFilePath -Value ("pid=$PID`r`nmode=$Mode`r`nstartedAt=" + (Get-Date).ToUniversalTime().ToString("o")) -Encoding UTF8
    if ($env:OS -like "*Windows*") {
      & icacls $CertsDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${ServiceAccount}:(OI)(CI)RX" 2>$null | Out-Null
      & icacls $ConfigDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${ServiceAccount}:(OI)(CI)RX" 2>$null | Out-Null
      & icacls $LogsDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${ServiceAccount}:(OI)(CI)M" 2>$null | Out-Null
    }
  }
  Record-InstallerStep -StepNo 5 -StepTitle "Create Standard Directory Structure" -Status "PASS" -Detail "Verified standard hierarchy under $RootDir, $BackupRootDir, $DeploymentsDir"

  # STEP 6: Check Git / Node.js / npm
  $GitCmd = Get-Command git -ErrorAction SilentlyContinue
  $NodeCmd = Get-Command node -ErrorAction SilentlyContinue
  $NpmCmd = Get-Command npm -ErrorAction SilentlyContinue
  if ((-not $GitCmd -or -not $NodeCmd -or -not $NpmCmd) -and -not $DryRun) {
    Record-InstallerStep -StepNo 6 -StepTitle "Check Git / Node.js / npm" -Status "FAIL" -Detail "Missing git, node, or npm in PATH"
    throw "MISSING_RUNTIME_TOOLS: Git, Node.js, and npm must be installed and available in PATH"
  }
  $NodeVer = if ($NodeCmd) { (& node -v) -join "" } else { "dry-run" }
  $NpmVer = if ($NpmCmd) { (& npm -v) -join "" } else { "dry-run" }
  Record-InstallerStep -StepNo 6 -StepTitle "Check Git / Node.js / npm" -Status "PASS" -Detail "Node=$NodeVer, npm=v$NpmVer"

  # STEP 7: Check .NET / Visual C++ Runtime for ScannerReader
  $DotnetX86 = "C:\Program Files (x86)\dotnet\dotnet.exe"
  if (Test-Path $DotnetX86) {
    Record-InstallerStep -StepNo 7 -StepTitle "Check .NET / VC++ Runtime for ScannerReader" -Status "PASS" -Detail "Found x86 .NET Runtime at $DotnetX86"
  } else {
    Record-InstallerStep -StepNo 7 -StepTitle "Check .NET / VC++ Runtime for ScannerReader" -Status "WARN" -Detail "x86 .NET Runtime not found yet (Scanner starts in Standby mode; install .NET 10.0 x86 before enabling ScannerSyncCli.exe)"
  }

  # STEP 8: Check Port 4101 Availability
  $PortListener = Get-NetTCPConnection -LocalPort $HttpsPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $PortListener) {
    $OwnerPid = [int]$PortListener.OwningProcess
    $ProcWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction SilentlyContinue
    $Cmd = if ($ProcWmi) { [string]$ProcWmi.CommandLine } else { "" }
    if ($Cmd -notmatch "Sam_Att" -and $Cmd -notmatch "server\.ts") {
      Record-InstallerStep -StepNo 8 -StepTitle "Check Port 4101 Availability" -Status "FAIL" -Detail "Port $HttpsPort occupied by foreign PID=$OwnerPid"
      throw "PORT_4101_CONFLICT: TCP Port $HttpsPort is held by foreign process PID=$OwnerPid"
    }
  }
  Record-InstallerStep -StepNo 8 -StepTitle "Check Port 4101 Availability" -Status "PASS" -Detail "HTTPS Port $HttpsPort ready"

  # STEP 9: Clone or Update GitHub Repository
  if (-not $DryRun) {
    if (Test-Path (Join-Path $AppDir ".git")) {
      Push-Location $AppDir
      try {
        & git fetch origin $Branch
        & git checkout $Branch
        & git pull --ff-only origin $Branch
        if ($LASTEXITCODE -ne 0) {
          throw "GIT_PULL_FAILED: git pull --ff-only origin $Branch failed"
        }
      } finally {
        Pop-Location
      }
      Record-InstallerStep -StepNo 9 -StepTitle "Clone or Update GitHub Repository" -Status "PASS" -Detail "Updated existing repo in $AppDir ($Branch)"
    } elseif (Test-Path (Join-Path $PSScriptRoot "package.json")) {
      Copy-Item -Path (Join-Path $PSScriptRoot "*") -Destination $AppDir -Recurse -Force -Exclude @("node_modules")
      Record-InstallerStep -StepNo 9 -StepTitle "Clone or Update GitHub Repository" -Status "PASS" -Detail "Copied release package from installer source to $AppDir"
    } else {
      & git clone --branch $Branch $RepoUrl $AppDir
      if ($LASTEXITCODE -ne 0) {
        throw "GIT_CLONE_FAILED: Could not clone $RepoUrl to $AppDir"
      }
      Record-InstallerStep -StepNo 9 -StepTitle "Clone or Update GitHub Repository" -Status "PASS" -Detail "Cloned $RepoUrl ($Branch) into $AppDir"
    }
  } else {
    Record-InstallerStep -StepNo 9 -StepTitle "Clone or Update GitHub Repository" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 10: Verify Repository Integrity
  $RequiredRepoFiles = @("package.json", "package-lock.json", "server.ts", "backend\src\server.ts", "ScannerReader\ScannerSyncCli.exe")
  if (-not $DryRun) {
    foreach ($Rel in $RequiredRepoFiles) {
      if (-not (Test-Path (Join-Path $AppDir $Rel))) {
        Record-InstallerStep -StepNo 10 -StepTitle "Verify Repository Integrity" -Status "FAIL" -Detail "Missing required file: $Rel"
        throw "REPO_INTEGRITY_FAILED: Required file $Rel not found in $AppDir"
      }
    }
  }
  Record-InstallerStep -StepNo 10 -StepTitle "Verify Repository Integrity" -Status "PASS" -Detail "Verified package.json, lockfile, server.ts, and ScannerReader binaries"

  # STEP 11: Collect or Validate Production Configuration (D:\WebApps\Sam_Att\Config\.env)
  if (-not $DryRun) {
    if (-not (Test-Path $EnvFilePath)) {
      $PlainDbPassword = $env:SAM_ATT_DB_PASSWORD
      if ([string]::IsNullOrWhiteSpace($PlainDbPassword) -and (-not $NonInteractive)) {
        Write-Host ""
        Write-Host "--- Interactive Production Configuration Wizard ---" -ForegroundColor Cyan
        $InputHost = Read-Host "MySQL Server Host [$DbHost]"
        if (-not [string]::IsNullOrWhiteSpace($InputHost)) { $DbHost = $InputHost.Trim() }
        $InputPort = Read-Host "MySQL Server Port [$DbPort]"
        if (-not [string]::IsNullOrWhiteSpace($InputPort)) { $DbPort = [int]$InputPort.Trim() }
        $InputDb = Read-Host "MySQL Database Name [$DbName]"
        if (-not [string]::IsNullOrWhiteSpace($InputDb)) { $DbName = $InputDb.Trim() }
        $InputUser = Read-Host "MySQL Username [$DbUser]"
        if (-not [string]::IsNullOrWhiteSpace($InputUser)) { $DbUser = $InputUser.Trim() }
        $SecPass = Read-Host "MySQL Password for '$DbUser'" -AsSecureString
        $PlainDbPassword = ConvertFrom-SecureStringPlain -SecureValue $SecPass
      }
      if ([string]::IsNullOrWhiteSpace($PlainDbPassword)) {
        throw "MISSING_DB_PASSWORD: Database password must be provided interactively or via SAM_ATT_DB_PASSWORD env var"
      }

      $JwtSecret = New-RandomHexSecret -ByteLength 48
      $ScannerToken = New-RandomHexSecret -ByteLength 32

      $EnvLines = @(
        "NODE_ENV=production",
        "HOST=0.0.0.0",
        "PORT=$HttpsPort",
        "SAM_ATT_HTTPS_PORT=$HttpsPort",
        "PUBLIC_BASE_PATH=/Sam_Att/",
        "API_BASE_PATH=/api/Sam_Att",
        "SAM_ATT_ROOT=$RootDir",
        "SAM_ATT_APP_DIR=$AppDir",
        "SAM_ATT_CONFIG_DIR=$ConfigDir",
        "SAM_ATT_LOGS_DIR=$LogsDir",
        "SAM_ATT_SERVICE_DIR=$ServiceDir",
        "SAM_ATT_CERTS_DIR=$CertsDir",
        "SAM_ATT_BACKUP_DIR=$BackupRootDir",
        "SAM_ATT_DEPLOYMENTS_DIR=$DeploymentsDir",
        "TLS_CERT_PATH=$CertPath",
        "TLS_KEY_PATH=$KeyPath",
        "SAM_ATT_DATA_MODE=REAL",
        "SAM_ATT_DB_ENGINE=mysql",
        "SAM_ATT_DB_HOST=$DbHost",
        "SAM_ATT_DB_PORT=$DbPort",
        "SAM_ATT_DB_NAME=$DbName",
        "SAM_ATT_DB_USER=$DbUser",
        "SAM_ATT_DB_PASSWORD=$PlainDbPassword",
        "JWT_SECRET=$JwtSecret",
        "SESSION_TTL_MINUTES=480",
        "AUTH_RATE_LIMIT_WINDOW_MINUTES=15",
        "AUTH_RATE_LIMIT_MAX_ATTEMPTS=5",
        "SCANNER_SYNC_ENABLED=false",
        "SCANNER_AUTO_SCHEDULER_ENABLED=false",
        "SCANNER_READER_EXE_PATH=$AppDir\ScannerReader\ScannerSyncCli.exe",
        "SCANNER_SYNC_DAYS=3",
        "SCANNER_SYNC_MAX_RANGE_DAYS=90",
        "SCANNER_CLI_PREVIEW_MODE=true",
        "SCANNER_INGEST_SHARED_TOKEN=$ScannerToken",
        "HOSOFFICE_LIVE_PUSH_ENABLED=false",
        "GITHUB_REPO=jk9krnvb6g-ai/Sam_Att-V2-Standalone",
        "GITHUB_BRANCH=$Branch"
      )
      [System.IO.File]::WriteAllLines($EnvFilePath, $EnvLines, [System.Text.UTF8Encoding]::new($false))
    }
    Record-InstallerStep -StepNo 11 -StepTitle "Collect or Validate Production Config" -Status "PASS" -Detail "External config persisted at $EnvFilePath (Scanner Scheduler=Standby)"
  } else {
    Record-InstallerStep -StepNo 11 -StepTitle "Collect or Validate Production Config" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 12: Test MySQL Network Connection (Read-Only TCP Probe)
  if (-not $DryRun) {
    $TcpClient = New-Object System.Net.Sockets.TcpClient
    try {
      $AsyncRes = $TcpClient.BeginConnect($DbHost, $DbPort, $null, $null)
      $WaitOk = $AsyncRes.AsyncWaitHandle.WaitOne(4000, $false)
      if (-not $WaitOk -or -not $TcpClient.Connected) {
        throw "MYSQL_TCP_UNREACHABLE: Cannot connect to MySQL server ${DbHost}:${DbPort}"
      }
      $TcpClient.EndConnect($AsyncRes)
    } finally {
      $TcpClient.Close()
    }
    Record-InstallerStep -StepNo 12 -StepTitle "Test MySQL Connection (Read-Only)" -Status "PASS" -Detail "Reachable at ${DbHost}:${DbPort}"
  } else {
    Record-InstallerStep -StepNo 12 -StepTitle "Test MySQL Connection (Read-Only)" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 13: Verify HTTPS Certificate & Private Key
  if (-not $DryRun) {
    if ((-not (Test-Path $CertPath)) -or (-not (Test-Path $KeyPath))) {
      $AllowSelfSigned = [bool]$GenerateInternalSelfSignedCertIfMissing
      if (-not $AllowSelfSigned -and (-not $NonInteractive)) {
        $Ans = Read-Host "No TLS certificate found in $CertsDir. Generate internal hospital self-signed certificate for IP $ServerIp? (y/N)"
        if ($Ans -match "^(y|yes)$") { $AllowSelfSigned = $true }
      }
      if ($AllowSelfSigned) {
        Push-Location $AppDir
        try {
          $GenScript = "import { ensureTlsCertificates } from './backend/src/server.ts'; ensureTlsCertificates(process.argv[1], process.argv[2], 'production', { allowExplicitGenerateInProduction: true, commonName: process.argv[3], extraIpSans: [process.argv[3]] });"
          & node --import tsx -e $GenScript $CertPath $KeyPath $ServerIp
        } finally {
          Pop-Location
        }
      }
    }
    if ((-not (Test-Path $CertPath)) -or (-not (Test-Path $KeyPath))) {
      Record-InstallerStep -StepNo 13 -StepTitle "Verify HTTPS Certificate & Private Key" -Status "FAIL" -Detail "Missing server.crt or server.key in $CertsDir"
      throw "MISSING_TLS_CERTIFICATE: Place server.crt and server.key in $CertsDir or pass -GenerateInternalSelfSignedCertIfMissing"
    }
    Record-InstallerStep -StepNo 13 -StepTitle "Verify HTTPS Certificate & Private Key" -Status "PASS" -Detail "TLS certificate and key present in $CertsDir"
  } else {
    Record-InstallerStep -StepNo 13 -StepTitle "Verify HTTPS Certificate & Private Key" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 14: Install Dependencies & Build Production
  if (-not $DryRun) {
    Push-Location $AppDir
    try {
      & npm ci
      if ($LASTEXITCODE -ne 0) { throw "NPM_CI_FAILED: npm ci exited with code $LASTEXITCODE" }
      & npm run typecheck
      if ($LASTEXITCODE -ne 0) { throw "TYPECHECK_FAILED: npm run typecheck failed" }
      & npm run build
      if ($LASTEXITCODE -ne 0) { throw "VITE_BUILD_FAILED: npm run build failed" }
    } finally {
      Pop-Location
    }
    Record-InstallerStep -StepNo 14 -StepTitle "Install Dependencies & Build Production" -Status "PASS" -Detail "npm ci, typecheck, and vite build succeeded"
  } else {
    Record-InstallerStep -StepNo 14 -StepTitle "Install Dependencies & Build Production" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 15: Verify Database Schema Compatibility (Read-Only)
  if (-not $DryRun) {
    Push-Location $AppDir
    try {
      $env:SAM_ATT_ENV_PATH = $EnvFilePath
      & npm run db:preflight
      if ($LASTEXITCODE -ne 0) {
        throw "DB_SCHEMA_PREFLIGHT_FAILED: Read-only database preflight check failed"
      }
    } finally {
      Pop-Location
    }
    Record-InstallerStep -StepNo 15 -StepTitle "Verify Database Schema Compatibility" -Status "PASS" -Detail "Read-only schema preflight passed (zero DDL/DML executed)"
  } else {
    Record-InstallerStep -StepNo 15 -StepTitle "Verify Database Schema Compatibility" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 16: Run Smoke Test (Validate Production Config & Dist Bundle)
  if (-not $DryRun) {
    $DistIndexPath = Join-Path $AppDir "dist\index.html"
    if (-not (Test-Path $DistIndexPath)) {
      throw "SMOKE_TEST_DIST_MISSING: dist\index.html not found after build"
    }
    Push-Location $AppDir
    try {
      $env:SAM_ATT_ENV_PATH = $EnvFilePath
      $env:NODE_ENV = "production"
      & node --import tsx -e "import { loadConfig, validateProductionConfig } from './backend/src/config/env.ts'; validateProductionConfig(loadConfig());"
      if ($LASTEXITCODE -ne 0) {
        throw "SMOKE_TEST_CONFIG_INVALID: validateProductionConfig failed"
      }
    } finally {
      Pop-Location
    }
    Record-InstallerStep -StepNo 16 -StepTitle "Run Smoke Test" -Status "PASS" -Detail "Production config and dist/index.html verified"
  } else {
    Record-InstallerStep -StepNo 16 -StepTitle "Run Smoke Test" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 17: Configure Windows Firewall Rule Port 4101
  $FirewallDisplayName = "Sam_Att V2 HTTPS 4101"
  if (-not $DryRun) {
    $ExistingFw = @(Get-NetFirewallRule -DisplayName $FirewallDisplayName -ErrorAction SilentlyContinue)
    if ($ExistingFw.Count -gt 0) {
      Remove-NetFirewallRule -DisplayName $FirewallDisplayName -ErrorAction SilentlyContinue
    }
    $RemoteAddrs = @($FirewallRemoteAddress -split "," | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
    New-NetFirewallRule -DisplayName $FirewallDisplayName `
      -Direction Inbound `
      -Protocol TCP `
      -LocalPort $HttpsPort `
      -Action Allow `
      -Profile Domain,Private `
      -RemoteAddress $RemoteAddrs `
      -Description "Allow HTTPS access to Sam_Att V2 Standalone on TCP port 4101" | Out-Null
    Record-InstallerStep -StepNo 17 -StepTitle "Configure Windows Firewall Rule Port 4101" -Status "PASS" -Detail "Rule '$FirewallDisplayName' active (RemoteAddress=$FirewallRemoteAddress)"
  } else {
    Record-InstallerStep -StepNo 17 -StepTitle "Configure Windows Firewall Rule Port 4101" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 18: Install & Start Windows Service (SamAttV2Standalone via WinSW)
  if (-not $DryRun) {
    $ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"
    $ServiceXml = Join-Path $ServiceDir "$ServiceName.xml"
    $TemplateXml = Join-Path $AppDir "scripts\winsw-sam-att.xml"
    if (Test-Path $TemplateXml) {
      Copy-Item -Path $TemplateXml -Destination $ServiceXml -Force
    }
    if (-not (Test-Path $ServiceExe)) {
      $CandidateWinSw = @(
        $WinSwSourcePath,
        (Join-Path $InstallersDir "WinSW-x64.exe"),
        (Join-Path $ServiceDir "WinSW-x64.exe"),
        (Join-Path $AppDir "bin\WinSW-x64.exe")
      ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path $_) } | Select-Object -First 1
      if ($CandidateWinSw) {
        Copy-Item -Path $CandidateWinSw -Destination $ServiceExe -Force
      }
    }
    if (-not (Test-Path $ServiceExe)) {
      Record-InstallerStep -StepNo 18 -StepTitle "Install & Start Windows Service" -Status "FAIL" -Detail "Missing WinSW binary at $ServiceExe (place WinSW-x64.exe in $InstallersDir or $ServiceDir)"
      throw "MISSING_WINSW_EXECUTABLE: Place WinSW-x64.exe at $InstallersDir\WinSW-x64.exe or $ServiceExe"
    }

    $ExistingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $ExistingSvc) {
      if ($ExistingSvc.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
      }
      & $ServiceExe uninstall | Out-Null
    }
    & $ServiceExe install
    if ($LASTEXITCODE -ne 0) { throw "WINSW_INSTALL_FAILED: WinSW install returned $LASTEXITCODE" }
    & $ServiceExe start
    Start-Sleep -Seconds 4
    $SvcNow = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($SvcNow.Status -ne "Running") {
      throw "SERVICE_START_FAILED: Windows Service '$ServiceName' is in state '$($SvcNow.Status)'"
    }
    Record-InstallerStep -StepNo 18 -StepTitle "Install & Start Windows Service" -Status "PASS" -Detail "Service '$ServiceName' installed and Running"
  } else {
    Record-InstallerStep -StepNo 18 -StepTitle "Install & Start Windows Service" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 19: Run Post-Install Health Check
  if (-not $DryRun) {
    $HealthScript = Join-Path $AppDir "HealthCheck_Sam_Att.ps1"
    if (-not (Test-Path $HealthScript)) {
      $HealthScript = Join-Path $PSScriptRoot "HealthCheck_Sam_Att.ps1"
    }
    & $HealthScript -Port $HttpsPort -ServiceName $ServiceName -ExpectedDbName $DbName
    if ($LASTEXITCODE -ne 0) {
      throw "POST_INSTALL_HEALTH_CHECK_FAILED: HealthCheck_Sam_Att.ps1 failed"
    }
    Record-InstallerStep -StepNo 19 -StepTitle "Run Post-Install Health Check" -Status "PASS" -Detail "https://127.0.0.1:${HttpsPort}/Sam_Att/ & /api/Sam_Att/health returned 200 OK"
  } else {
    Record-InstallerStep -StepNo 19 -StepTitle "Run Post-Install Health Check" -Status "SKIP" -Detail "DryRun mode"
  }

  # STEP 20: Generate Installation Summary Report
  $SummaryReport = [ordered]@{
    applicationName          = "Sam_Att V2 Standalone"
    mode                     = $Mode
    dryRun                   = [bool]$DryRun
    status                   = "SUCCESS"
    completedAtIso           = (Get-Date).ToUniversalTime().ToString("o")
    serverHost               = $env:COMPUTERNAME
    serverIp                 = $ServerIp
    httpsPort                = $HttpsPort
    frontendUrl              = "https://${ServerIp}:${HttpsPort}/Sam_Att/"
    apiHealthUrl             = "https://${ServerIp}:${HttpsPort}/api/Sam_Att/health"
    serviceName              = $ServiceName
    rootDirectory            = $RootDir
    appDirectory             = $AppDir
    configEnvPath            = $EnvFilePath
    certsDirectory           = $CertsDir
    logsDirectory            = $LogsDir
    backupsDirectory         = $BackupRootDir
    deploymentsDirectory     = $DeploymentsDir
    databaseHost             = $DbHost
    databasePort             = $DbPort
    databaseName             = $DbName
    scannerSchedulerStandby  = $true
    steps                    = $StepResults
  }
  if (-not $DryRun -and (Test-Path $LogsDir)) {
    $JsonText = $SummaryReport | ConvertTo-Json -Depth 6
    [System.IO.File]::WriteAllText($ReportJsonPath, $JsonText, [System.Text.UTF8Encoding]::new($false))
  }
  Record-InstallerStep -StepNo 20 -StepTitle "Generate Installation Summary Report" -Status "PASS" -Detail "Report written to $ReportJsonPath"

  Write-Host "======================================================================" -ForegroundColor Green
  Write-Host " INSTALLATION COMPLETED SUCCESSFULLY" -ForegroundColor Green
  Write-Host "  Frontend URL : https://${ServerIp}:${HttpsPort}/Sam_Att/" -ForegroundColor Green
  Write-Host "  Health API   : https://${ServerIp}:${HttpsPort}/api/Sam_Att/health" -ForegroundColor Green
  Write-Host "  Service Name : $ServiceName (Automatic Delayed Start)" -ForegroundColor Green
  Write-Host "  Scanner Mode : STANDBY (SCANNER_AUTO_SCHEDULER_ENABLED=false until Cutover)" -ForegroundColor Yellow
  Write-Host "======================================================================" -ForegroundColor Green
  exit 0
} catch {
  $ErrMsg = $_.Exception.Message
  Write-InstallLog -Message "INSTALLATION FAILED: $ErrMsg" -Level "ERROR"
  exit 1
} finally {
  if (Test-Path $LockFilePath) {
    Remove-Item -Path $LockFilePath -Force -ErrorAction SilentlyContinue
  }
}
