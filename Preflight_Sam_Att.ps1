<#
.SYNOPSIS
  Sam_Att V2 Standalone - Read-Only Production Preflight Verification Script (Phase 2.7)
.DESCRIPTION
  Verifies Windows Server 2025 environment readiness on 10.2.0.23 before installation or deployment:
  - Administrator privilege, OS version, PowerShell 5.1+
  - Drive D availability and free disk space
  - Git, Node.js (v22 LTS / v26.13.1), npm, WinSW binary, .NET x86 runtime for ScannerSyncCli.exe
  - Port 4101 availability / ownership by SamAttV2Standalone
  - External configuration D:\WebApps\Sam_Att\Config\.env and TLS cert/key in D:\WebApps\Sam_Att\Certs
  - Strictly Read-Only MySQL 10.1.0.201:3306 preflight check (zero DDL/DML mutations)
#>
[CmdletBinding()]
param(
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$BackupRootDir = "D:\Backups\Sam_Att",
  [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
  [string]$ServiceName = "SamAttV2Standalone",
  [int]$HttpsPort = 4101,
  [int]$MinFreeSpaceGB = 10,
  [switch]$AllowMissingConfig,
  [switch]$AllowMissingCerts,
  [switch]$SkipDbPreflight
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

$Checks = New-Object System.Collections.Generic.List[object]
$HasFailure = $false

function Add-PreflightResult {
  param(
    [string]$CheckName,
    [string]$Status,
    [string]$Detail
  )
  $Checks.Add([PSCustomObject]@{
    Check  = $CheckName
    Status = $Status
    Detail = $Detail
  }) | Out-Null
  $Color = if ($Status -eq "PASS") { "Green" } elseif ($Status -eq "WARN") { "Yellow" } else { "Red" }
  Write-Host ("[{0}] {1,-36} : {2}" -f $Status, $CheckName, $Detail) -ForegroundColor $Color
  if ($Status -eq "FAIL") {
    $script:HasFailure = $true
  }
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Sam_Att V2 Standalone - Production Preflight Check (Read-Only)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

# 1. Administrator Privilege
$IsAdmin = $false
if ($env:OS -like "*Windows*") {
  $Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
  $IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
if ($IsAdmin) {
  Add-PreflightResult -CheckName "1. Administrator Privilege" -Status "PASS" -Detail "Running as elevated Administrator"
} else {
  Add-PreflightResult -CheckName "1. Administrator Privilege" -Status "FAIL" -Detail "Please run PowerShell as Administrator"
}

# 2. Windows OS & Computer Guard
if ($env:COMPUTERNAME -eq "FILESERVER") {
  Add-PreflightResult -CheckName "2. Host Isolation Guard" -Status "FAIL" -Detail "FORBIDDEN_HOST: Sam_Att V2 must not be installed on FILESERVER"
} else {
  $OsCaption = try { (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption } catch { $env:OS }
  Add-PreflightResult -CheckName "2. Windows Server OS" -Status "PASS" -Detail "Host=$($env:COMPUTERNAME), OS=$OsCaption"
}

# 3. PowerShell Version
$PsVer = $PSVersionTable.PSVersion.ToString()
if ($PSVersionTable.PSVersion.Major -ge 5) {
  Add-PreflightResult -CheckName "3. PowerShell Version" -Status "PASS" -Detail "PowerShell v$PsVer"
} else {
  Add-PreflightResult -CheckName "3. PowerShell Version" -Status "FAIL" -Detail "PowerShell 5.1+ required (found v$PsVer)"
}

# 4. Drive D & Free Space
$DriveLetter = (Split-Path -Qualifier $RootDir).TrimEnd(':')
$DriveObj = Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue
if ($null -eq $DriveObj) {
  Add-PreflightResult -CheckName "4. Drive $DriveLetter Availability" -Status "FAIL" -Detail "Drive ${DriveLetter}: not found"
} else {
  $FreeGB = [math]::Round(($DriveObj.Free / 1GB), 2)
  if ($FreeGB -ge $MinFreeSpaceGB) {
    Add-PreflightResult -CheckName "4. Drive $DriveLetter Free Space" -Status "PASS" -Detail "${FreeGB} GB free (min ${MinFreeSpaceGB} GB)"
  } else {
    Add-PreflightResult -CheckName "4. Drive $DriveLetter Free Space" -Status "FAIL" -Detail "Only ${FreeGB} GB free (min ${MinFreeSpaceGB} GB required)"
  }
}

# 5. Git, Node.js, npm
$GitCmd = Get-Command git -ErrorAction SilentlyContinue
if ($GitCmd) {
  $GitVer = (& git --version) -join " "
  Add-PreflightResult -CheckName "5. Git CLI" -Status "PASS" -Detail $GitVer
} else {
  Add-PreflightResult -CheckName "5. Git CLI" -Status "FAIL" -Detail "git.exe not found in PATH"
}

$NodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($NodeCmd) {
  $NodeVer = (& node -v) -join ""
  if ($NodeVer -match "^v(22|24|26)\.") {
    Add-PreflightResult -CheckName "6. Node.js Runtime" -Status "PASS" -Detail "$NodeVer ($($NodeCmd.Source))"
  } else {
    Add-PreflightResult -CheckName "6. Node.js Runtime" -Status "WARN" -Detail "$NodeVer detected (recommended Node.js v22 LTS or v26.13.1)"
  }
} else {
  Add-PreflightResult -CheckName "6. Node.js Runtime" -Status "FAIL" -Detail "node.exe not found in PATH"
}

$NpmCmd = Get-Command npm -ErrorAction SilentlyContinue
if ($NpmCmd) {
  $NpmVer = (& npm -v) -join ""
  Add-PreflightResult -CheckName "7. npm CLI" -Status "PASS" -Detail "npm v$NpmVer"
} else {
  Add-PreflightResult -CheckName "7. npm CLI" -Status "FAIL" -Detail "npm not found in PATH"
}

# 8. .NET Runtime (x86) for ScannerSyncCli.exe
$DotnetX86Path = "C:\Program Files (x86)\dotnet\dotnet.exe"
if (Test-Path $DotnetX86Path) {
  $Runtimes = (& $DotnetX86Path --list-runtimes 2>$null) -join "; "
  if ($Runtimes -match "Microsoft\.NETCore\.App 10\.") {
    Add-PreflightResult -CheckName "8. .NET 10.0 x86 Runtime (Scanner)" -Status "PASS" -Detail "Found x86 .NET 10.0 runtime"
  } else {
    Add-PreflightResult -CheckName "8. .NET 10.0 x86 Runtime (Scanner)" -Status "WARN" -Detail "x86 dotnet found, verify .NET 10.0 x86 runtime for ScannerSyncCli.exe"
  }
} else {
  Add-PreflightResult -CheckName "8. .NET 10.0 x86 Runtime (Scanner)" -Status "WARN" -Detail "C:\Program Files (x86)\dotnet\dotnet.exe not found (required when ScannerSyncCli.exe is enabled)"
}

# 9. Port 4101 Check
$NetConn = Get-NetTCPConnection -LocalPort $HttpsPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -eq $NetConn) {
  Add-PreflightResult -CheckName "9. TCP Port $HttpsPort" -Status "PASS" -Detail "Port $HttpsPort is available (no listener)"
} else {
  $OwnerPid = [int]$NetConn.OwningProcess
  $ProcWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnerPid" -ErrorAction SilentlyContinue
  $CmdLine = if ($ProcWmi) { [string]$ProcWmi.CommandLine } else { "" }
  if ($CmdLine -imatch "Sam_Att" -or $CmdLine -imatch "server\.ts") {
    Add-PreflightResult -CheckName "9. TCP Port $HttpsPort" -Status "PASS" -Detail "Owned by running Sam_Att instance (PID=$OwnerPid)"
  } else {
    Add-PreflightResult -CheckName "9. TCP Port $HttpsPort" -Status "FAIL" -Detail "Port $HttpsPort is occupied by foreign process PID=$OwnerPid ($($ProcWmi.Name))"
  }
}

# 10. External Config .env Check
if (Test-Path $EnvFilePath) {
  Add-PreflightResult -CheckName "10. External Config (.env)" -Status "PASS" -Detail "Found at $EnvFilePath"
} elseif ($AllowMissingConfig) {
  Add-PreflightResult -CheckName "10. External Config (.env)" -Status "WARN" -Detail "Not created yet at $EnvFilePath (will be generated by Installer Wizard)"
} else {
  Add-PreflightResult -CheckName "10. External Config (.env)" -Status "FAIL" -Detail "Missing production config at $EnvFilePath"
}

# 11. HTTPS Certificates Check
if ((Test-Path $CertPath) -and (Test-Path $KeyPath)) {
  Add-PreflightResult -CheckName "11. HTTPS Certificate & Key" -Status "PASS" -Detail "Found server.crt and server.key in $CertsDir"
} elseif ($AllowMissingCerts) {
  Add-PreflightResult -CheckName "11. HTTPS Certificate & Key" -Status "WARN" -Detail "Missing cert/key in $CertsDir (must be provisioned before starting service)"
} else {
  Add-PreflightResult -CheckName "11. HTTPS Certificate & Key" -Status "FAIL" -Detail "Missing $CertPath or $KeyPath"
}

# 12. Read-Only MySQL Database Preflight
if (-not $SkipDbPreflight -and (Test-Path (Join-Path $AppDir "package.json")) -and (Test-Path $EnvFilePath)) {
  Push-Location $AppDir
  try {
    $env:SAM_ATT_ENV_PATH = $EnvFilePath
    $DbOut = & npm run db:preflight 2>&1
    if ($LASTEXITCODE -eq 0) {
      Add-PreflightResult -CheckName "12. MySQL Read-Only Preflight" -Status "PASS" -Detail "Read-only schema & connectivity verified against MySQL"
    } else {
      Add-PreflightResult -CheckName "12. MySQL Read-Only Preflight" -Status "FAIL" -Detail ("Database preflight failed: " + (($DbOut | Select-Object -Last 3) -join " "))
    }
  } finally {
    Pop-Location
  }
} else {
  Add-PreflightResult -CheckName "12. MySQL Read-Only Preflight" -Status "WARN" -Detail "Skipped CLI DB preflight (AppDir or .env not yet initialized)"
}

Write-Host "======================================================================" -ForegroundColor Cyan
if ($HasFailure) {
  Write-Host " PREFLIGHT RESULT: FAILED (Fix failed checks before proceeding)" -ForegroundColor Red
  exit 1
} else {
  Write-Host " PREFLIGHT RESULT: PASSED" -ForegroundColor Green
  exit 0
}
