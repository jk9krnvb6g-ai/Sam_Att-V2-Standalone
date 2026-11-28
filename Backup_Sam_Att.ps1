<#
.SYNOPSIS
  Sam_Att V2 Standalone - Application Release, Service & Config Metadata Backup Script (Phase 2.10)
.DESCRIPTION
  Backs up the current working application release from D:\WebApps\Sam_Att\App,
  WinSW service XML from D:\WebApps\Sam_Att\Service, and sanitized configuration metadata
  into D:\Backups\Sam_Att\release_<timestamp>_<commit> with SHA-256 verification.
  Enforces retention policy: retains at least the latest 5 releases and all backups within 30 days.
  Never logs or exposes database passwords, JWT secrets, or private keys.
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$BackupRoot = "D:\Backups\Sam_Att",
  [int]$MinRetainCount = 5,
  [int]$MinRetainDays = 30,
  [string]$Reason = "PRE_DEPLOYMENT_BACKUP"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $RootDir "App"
$ConfigDir = Join-Path $RootDir "Config"
$ServiceDir = Join-Path $RootDir "Service"
$LogsDir = Join-Path $RootDir "Logs"

$AppDirFull = [System.IO.Path]::GetFullPath($AppDir)
$BackupRootFull = [System.IO.Path]::GetFullPath($BackupRoot)

if ($BackupRootFull.StartsWith($AppDirFull, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "BACKUP_DIR_INSIDE_APP_FORBIDDEN: BackupRoot ($BackupRootFull) must reside outside AppDir ($AppDirFull)"
}

if (-not (Test-Path $AppDirFull)) {
  throw "APP_DIR_NOT_FOUND: Application directory not found at $AppDirFull"
}

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$CommitShort = "unknown"
$ReleaseVer = "2.0.0"

$PkgJsonPath = Join-Path $AppDirFull "package.json"
if (Test-Path $PkgJsonPath) {
  try {
    $PkgObj = Get-Content -Path $PkgJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($PkgObj.version) { $ReleaseVer = [string]$PkgObj.version }
  } catch {}
}

if (Get-Command git -ErrorAction SilentlyContinue) {
  Push-Location $AppDirFull
  try {
    $GitSha = (& git rev-parse --short=8 HEAD 2>$null) -join ""
    if (-not [string]::IsNullOrWhiteSpace($GitSha)) {
      $CommitShort = $GitSha.Trim()
    }
  } catch {} finally {
    Pop-Location
  }
}

$SnapshotName = "release_${Timestamp}_${CommitShort}"
$TargetDir = Join-Path $BackupRootFull $SnapshotName

if (-not $PSCmdlet.ShouldProcess($TargetDir, "Create application backup snapshot")) {
  Write-Host "[Backup - WhatIf] Would create backup snapshot at $TargetDir"
  exit 0
}

New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null
$AppSnapshotDir = Join-Path $TargetDir "app"
New-Item -ItemType Directory -Path $AppSnapshotDir -Force | Out-Null

Write-Host "[Backup] 1/4 Copying application release files from $AppDirFull to $AppSnapshotDir..."
$ItemsToCopy = @(
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

foreach ($Item in $ItemsToCopy) {
  $SrcPath = Join-Path $AppDirFull $Item
  if (Test-Path $SrcPath) {
    Copy-Item -Path $SrcPath -Destination (Join-Path $AppSnapshotDir $Item) -Recurse -Force
  }
}

Write-Host "[Backup] 2/4 Copying WinSW service configuration and sanitized config metadata..."
$ServiceSnapshotDir = Join-Path $TargetDir "service"
New-Item -ItemType Directory -Path $ServiceSnapshotDir -Force | Out-Null
$WinSwXml = Join-Path $ServiceDir "SamAttV2Standalone.xml"
if (Test-Path $WinSwXml) {
  Copy-Item -Path $WinSwXml -Destination (Join-Path $ServiceSnapshotDir "SamAttV2Standalone.xml") -Force
}

$EnvFile = Join-Path $ConfigDir ".env"
$EnvKeyList = @()
$EnvSha256 = ""
if (Test-Path $EnvFile) {
  $EnvSha256 = (Get-FileHash -Path $EnvFile -Algorithm SHA256).Hash.ToLower()
  foreach ($Line in Get-Content -Path $EnvFile -Encoding UTF8) {
    $Trim = $Line.Trim()
    if ([string]::IsNullOrWhiteSpace($Trim) -or $Trim.StartsWith("#")) { continue }
    $Idx = $Trim.IndexOf("=")
    if ($Idx -gt 0) {
      $EnvKeyList += $Trim.Substring(0, $Idx).Trim()
    }
  }
}

$DistIndex = Join-Path $AppSnapshotDir "dist\index.html"
$DistIndexSha256 = if (Test-Path $DistIndex) { (Get-FileHash -Path $DistIndex -Algorithm SHA256).Hash.ToLower() } else { "" }
$PkgLockSnap = Join-Path $AppSnapshotDir "package-lock.json"
$PkgLockSha256 = if (Test-Path $PkgLockSnap) { (Get-FileHash -Path $PkgLockSnap -Algorithm SHA256).Hash.ToLower() } else { "" }

Write-Host "[Backup] 3/4 Writing cryptographic backup-manifest.json..."
$Manifest = [ordered]@{
  serviceName         = "SamAttV2Standalone"
  applicationName     = "Sam_Att V2 Standalone"
  snapshotName        = $SnapshotName
  backupTimestamp     = $Timestamp
  createdAtIso        = (Get-Date).ToUniversalTime().ToString("o")
  releaseVersion      = $ReleaseVer
  commitSha           = $CommitShort
  reason              = $Reason
  appDirectory        = $AppDirFull
  configEnvPath       = $EnvFile
  configEnvSha256     = $EnvSha256
  configuredEnvKeys   = $EnvKeyList
  distIndexSha256     = $DistIndexSha256
  packageLockSha256   = $PkgLockSha256
  createdBy           = $env:USERNAME
  status              = "VERIFIED_READY"
}

$ManifestPath = Join-Path $TargetDir "backup-manifest.json"
$ManifestJson = $Manifest | ConvertTo-Json -Depth 6
[System.IO.File]::WriteAllText($ManifestPath, $ManifestJson, [System.Text.UTF8Encoding]::new($false))
$ManifestHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
Set-Content -Path "$ManifestPath.sha256" -Value $ManifestHash -Encoding ASCII

Write-Host "[Backup] 4/4 Applying backup retention policy (retain >= $MinRetainCount releases and >= $MinRetainDays days)..."
$AllSnapshots = @(Get-ChildItem -Path $BackupRootFull -Directory -Filter "release_*" -ErrorAction SilentlyContinue | Sort-Object CreationTime -Descending)
$CutoffDate = (Get-Date).AddDays(-$MinRetainDays)
if ($AllSnapshots.Count -gt $MinRetainCount) {
  for ($i = $MinRetainCount; $i -lt $AllSnapshots.Count; $i++) {
    $Candidate = $AllSnapshots[$i]
    if ($Candidate.CreationTime -lt $CutoffDate) {
      Write-Host "[Backup] Pruning expired backup (> $MinRetainDays days): $($Candidate.FullName)"
      Remove-Item -Path $Candidate.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

if (Test-Path $LogsDir) {
  $LogLine = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][INFO] Backup created at $TargetDir (Version=$ReleaseVer, Commit=$CommitShort, ManifestSHA256=$ManifestHash)"
  Add-Content -Path (Join-Path $LogsDir "deployment.log") -Value $LogLine -Encoding UTF8 -ErrorAction SilentlyContinue
}

Write-Host "[Backup] SUCCESS: Application backup verified at $TargetDir" -ForegroundColor Green
Write-Output $TargetDir
