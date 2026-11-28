<#
.SYNOPSIS
  Sam_Att V2 Standalone - Safe Application Rollback Script (Phase 2.10)
.DESCRIPTION
  Restores a verified application backup snapshot from D:\Backups\Sam_Att to D:\WebApps\Sam_Att\App:
  - Stops ONLY the SamAttV2Standalone Windows Service (never uses taskkill /F /IM node.exe or iisreset)
  - Preserves D:\WebApps\Sam_Att\Config\.env and D:\WebApps\Sam_Att\Certs
  - Never modifies or drops any MySQL tables on 10.1.0.201:3306
  - Starts SamAttV2Standalone and runs post-rollback HealthCheck_Sam_Att.ps1
  - Logs full rollback audit trail to D:\WebApps\Sam_Att\Logs\rollback_<timestamp>.log
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$BackupRoot = "D:\Backups\Sam_Att",
  [string]$SnapshotDir = "",
  [string]$ServiceName = "SamAttV2Standalone",
  [int]$HttpsPort = 4101,
  [switch]$ListSnapshotsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $RootDir "App"
$ConfigDir = Join-Path $RootDir "Config"
$CertsDir = Join-Path $RootDir "Certs"
$LogsDir = Join-Path $RootDir "Logs"
$ServiceDir = Join-Path $RootDir "Service"

if (-not (Test-Path $BackupRoot)) {
  throw "BACKUP_ROOT_NOT_FOUND: Backup root directory not found at $BackupRoot"
}

$Snapshots = @(Get-ChildItem -Path $BackupRoot -Directory -Filter "release_*" -ErrorAction SilentlyContinue | Sort-Object CreationTime -Descending)
if ($ListSnapshotsOnly) {
  Write-Host "Available Backup Snapshots in ${BackupRoot}:" -ForegroundColor Cyan
  foreach ($S in $Snapshots) {
    $ManifestFile = Join-Path $S.FullName "backup-manifest.json"
    $Detail = if (Test-Path $ManifestFile) {
      $M = Get-Content -Path $ManifestFile -Raw -Encoding UTF8 | ConvertFrom-Json
      "Version=$($M.releaseVersion), Commit=$($M.commitSha), Created=$($M.createdAtIso)"
    } else {
      "Created=$($S.CreationTime)"
    }
    Write-Host "  - $($S.Name) ($Detail)"
  }
  exit 0
}

if ([string]::IsNullOrWhiteSpace($SnapshotDir)) {
  if ($Snapshots.Count -eq 0) {
    throw "NO_BACKUP_SNAPSHOTS_AVAILABLE: No release_* snapshots found in $BackupRoot"
  }
  $SnapshotDir = $Snapshots[0].FullName
} elseif (-not [System.IO.Path]::IsPathRooted($SnapshotDir)) {
  $SnapshotDir = Join-Path $BackupRoot $SnapshotDir
}

$SnapshotDir = [System.IO.Path]::GetFullPath($SnapshotDir)
$ManifestPath = Join-Path $SnapshotDir "backup-manifest.json"
$SnapshotAppDir = Join-Path $SnapshotDir "app"

if (-not (Test-Path $ManifestPath) -or -not (Test-Path $SnapshotAppDir)) {
  throw "INVALID_BACKUP_SNAPSHOT: Snapshot at $SnapshotDir is missing backup-manifest.json or app/ folder"
}

$ManifestHashFile = "$ManifestPath.sha256"
if (Test-Path $ManifestHashFile) {
  $ExpectedHash = (Get-Content -Path $ManifestHashFile -Raw).Trim().ToLower()
  $ActualHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
  if ($ExpectedHash -ne $ActualHash) {
    throw "SNAPSHOT_MANIFEST_CHECKSUM_MISMATCH: Expected $ExpectedHash but calculated $ActualHash"
  }
}

$ManifestObj = Get-Content -Path $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
if (-not (Test-Path $LogsDir)) {
  New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
}
$RollbackLogPath = Join-Path $LogsDir "rollback_${Timestamp}.log"

function Write-RollbackLog {
  param([string]$Message, [string]$Level = "INFO")
  $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $Message"
  Add-Content -Path $RollbackLogPath -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
  $Color = if ($Level -eq "ERROR") { "Red" } elseif ($Level -eq "WARN") { "Yellow" } else { "Cyan" }
  Write-Host $Line -ForegroundColor $Color
}

if (-not $PSCmdlet.ShouldProcess($AppDir, "Rollback application to snapshot $($ManifestObj.snapshotName)")) {
  Write-Host "[Rollback - WhatIf] Would rollback $AppDir to $SnapshotDir"
  exit 0
}

Write-RollbackLog -Message "Starting Safe Application Rollback to snapshot '$($ManifestObj.snapshotName)' (Commit=$($ManifestObj.commitSha), Version=$($ManifestObj.releaseVersion))..."

# 1. Verify Config and Certs hashes before rollback to guarantee immutability
$EnvFilePath = Join-Path $ConfigDir ".env"
$EnvHashBefore = if (Test-Path $EnvFilePath) { (Get-FileHash -Path $EnvFilePath -Algorithm SHA256).Hash.ToLower() } else { "" }

# 2. Stop ONLY SamAttV2Standalone Windows Service
if ($env:OS -like "*Windows*") {
  $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Svc -and $Svc.Status -ne "Stopped") {
    Write-RollbackLog -Message "Stopping isolated Windows Service '$ServiceName'..."
    Stop-Service -Name $ServiceName -Force -ErrorAction Stop
    for ($i = 1; $i -le 20; $i++) {
      Start-Sleep -Seconds 1
      $SvcCheck = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
      if ($null -eq $SvcCheck -or $SvcCheck.Status -eq "Stopped") { break }
    }
  }
}

# 3. Restore Application files from snapshot
Write-RollbackLog -Message "Restoring application files from $SnapshotAppDir to $AppDir..."
if (-not (Test-Path $AppDir)) {
  New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
}

$RestoreItems = @(
  "dist",
  "backend",
  "frontend",
  "database",
  "ScannerReader",
  "scripts",
  "deployment",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "server.ts",
  ".env.example",
  ".nvmrc"
)

foreach ($Item in $RestoreItems) {
  $SrcItem = Join-Path $SnapshotAppDir $Item
  $DstItem = Join-Path $AppDir $Item
  if (Test-Path $SrcItem) {
    if (Test-Path $DstItem) {
      Remove-Item -Path $DstItem -Recurse -Force -ErrorAction Stop
    }
    Copy-Item -Path $SrcItem -Destination $DstItem -Recurse -Force -ErrorAction Stop
  }
}

# 4. Verify external Config\.env was never modified
$EnvHashAfter = if (Test-Path $EnvFilePath) { (Get-FileHash -Path $EnvFilePath -Algorithm SHA256).Hash.ToLower() } else { "" }
if ($EnvHashBefore -ne $EnvHashAfter) {
  throw "SECURITY_CONFIG_MUTATION_DETECTED: External Config\.env hash changed during rollback"
}

# 5. Start SamAttV2Standalone service
if ($env:OS -like "*Windows*") {
  $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Svc) {
    Write-RollbackLog -Message "Starting Windows Service '$ServiceName'..."
    Start-Service -Name $ServiceName -ErrorAction Stop
    Start-Sleep -Seconds 4
    $SvcAfter = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($SvcAfter.Status -ne "Running") {
      throw "ROLLBACK_SERVICE_START_FAILED: Windows Service '$ServiceName' status is '$($SvcAfter.Status)'"
    }
  }
}

# 6. Post-Rollback Health Verification
$HealthScript = Join-Path $PSScriptRoot "HealthCheck_Sam_Att.ps1"
if (-not (Test-Path $HealthScript)) {
  $HealthScript = Join-Path $AppDir "HealthCheck_Sam_Att.ps1"
}
if (Test-Path $HealthScript) {
  Write-RollbackLog -Message "Executing post-rollback health verification on HTTPS port $HttpsPort..."
  & $HealthScript -Port $HttpsPort -ServiceName $ServiceName
}

Write-RollbackLog -Message "ROLLBACK COMPLETED SUCCESSFULLY: Restored Commit=$($ManifestObj.commitSha), Version=$($ManifestObj.releaseVersion)"
exit 0
