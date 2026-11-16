<#
.SYNOPSIS
  Sam_Att V2 Standalone — Verified Database & Application Release Restore Script
  Verifies SHA-256 checksums before restore, takes a pre-restore safety snapshot for automatic recovery on failure,
  restores both MySQL database and application release files, and runs post-restore health verification.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupFolder,
  [string]$AppDir = "C:\Sam_Att\app",
  [string]$ServiceName = "Sam_Att_V2_Standalone",
  [string]$DbHost = "127.0.0.1",
  [int]$DbPort = 3306,
  [string]$DbName = "samchuk_attendance_v2",
  [string]$DbUser = "sam_att_app"
)

$ErrorActionPreference = "Stop"

$ManifestPath = Join-Path $BackupFolder "manifest.json"
$ManifestShaPath = Join-Path $BackupFolder "manifest.json.sha256"

if (-not (Test-Path $ManifestPath)) {
  throw "RESTORE_ABORTED_NO_MANIFEST: manifest.json not found in $BackupFolder. Refusing to fabricate backup."
}

if (Test-Path $ManifestShaPath) {
  $ExpectedManifestHash = (Get-Content $ManifestShaPath -Raw).Trim().ToLower()
  $ActualManifestHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
  if ($ActualManifestHash -ne $ExpectedManifestHash) {
    throw "RESTORE_ABORTED_MANIFEST_TAMPERED: manifest.json SHA-256 mismatch ($ActualManifestHash != $ExpectedManifestHash)"
  }
}

$Manifest = Get-Content -Path $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$SqlDumpPath = Join-Path $BackupFolder $Manifest.sqlDumpFileName
$ReleaseSnapshotDir = Join-Path $BackupFolder "release_snapshot"

if (-not (Test-Path $SqlDumpPath)) {
  throw "RESTORE_ABORTED_DUMP_MISSING: SQL dump file '$($Manifest.sqlDumpFileName)' missing from $BackupFolder"
}

$ActualDumpHash = (Get-FileHash -Path $SqlDumpPath -Algorithm SHA256).Hash.ToLower()
if ($ActualDumpHash -ne $Manifest.sqlDumpSha256.ToLower()) {
  throw "RESTORE_ABORTED_DUMP_CHECKSUM_MISMATCH: SQL dump SHA-256 ($ActualDumpHash) does not match manifest ($($Manifest.sqlDumpSha256))"
}

$DistIndexBackup = Join-Path $ReleaseSnapshotDir "dist\index.html"
if (-not (Test-Path $DistIndexBackup)) {
  throw "RESTORE_ABORTED_RELEASE_MISSING: Backed-up dist/index.html missing in $ReleaseSnapshotDir"
}

$ActualIndexHash = (Get-FileHash -Path $DistIndexBackup -Algorithm SHA256).Hash.ToLower()
if ($Manifest.distIndexSha256 -and ($ActualIndexHash -ne $Manifest.distIndexSha256.ToLower())) {
  throw "RESTORE_ABORTED_RELEASE_CHECKSUM_MISMATCH: dist/index.html SHA-256 mismatch"
}

$MysqlCmd = Get-Command mysql -ErrorAction SilentlyContinue
if (-not $MysqlCmd) {
  throw "RESTORE_ABORTED_NO_MYSQL_CLIENT: mysql client executable not found in PATH"
}

# Create a Pre-Restore Safety Snapshot of current AppDir/dist in case midway recovery is needed
$SafetyTempDir = Join-Path $env:TEMP "sam_att_prerestore_safety_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Path $SafetyTempDir -Force | Out-Null
if (Test-Path (Join-Path $AppDir "dist")) {
  Copy-Item -Path (Join-Path $AppDir "dist") -Destination (Join-Path $SafetyTempDir "dist") -Recurse -Force
}

try {
  Write-Host "[Restore] Step 1/4: Stopping Windows Service '$ServiceName' (Isolated to Sam_Att only)..."
  $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($Svc -and $Svc.Status -eq 'Running') {
    Stop-Service -Name $ServiceName -Force
    Start-Sleep -Seconds 2
  }

  Write-Host "[Restore] Step 2/4: Restoring MySQL database '$DbName' from verified dump..."
  Get-Content -Path $SqlDumpPath -Raw -Encoding UTF8 | & mysql --host=$DbHost --port=$DbPort --user=$DbUser $DbName
  if ($LASTEXITCODE -ne 0) {
    throw "RESTORE_DB_FAILED: mysql restore exited with code $LASTEXITCODE"
  }

  Write-Host "[Restore] Step 3/4: Restoring application release artifacts to $AppDir..."
  if (Test-Path (Join-Path $AppDir "dist")) {
    Remove-Item -Path (Join-Path $AppDir "dist") -Recurse -Force
  }
  Copy-Item -Path (Join-Path $ReleaseSnapshotDir "dist") -Destination (Join-Path $AppDir "dist") -Recurse -Force

  Write-Host "[Restore] Step 4/4: Starting service '$ServiceName' and executing Health Check..."
  if ($Svc) {
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
  }
  & "$PSScriptRoot\health-check.ps1"
  if ($LASTEXITCODE -ne 0) {
    throw "RESTORE_HEALTHCHECK_FAILED: Post-restore health check failed"
  }

  Write-Host "[Restore] SUCCESS: Database and release restored to version $($Manifest.releaseVersion)"
} catch {
  Write-Error "[Restore] ERROR during restore: $($_.Exception.Message). Initiating automatic safety recovery..."
  if (Test-Path (Join-Path $SafetyTempDir "dist")) {
    if (Test-Path (Join-Path $AppDir "dist")) {
      Remove-Item -Path (Join-Path $AppDir "dist") -Recurse -Force -ErrorAction SilentlyContinue
    }
    Copy-Item -Path (Join-Path $SafetyTempDir "dist") -Destination (Join-Path $AppDir "dist") -Recurse -Force -ErrorAction SilentlyContinue
  }
  if ($Svc) {
    Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
  }
  throw
} finally {
  if (Test-Path $SafetyTempDir) {
    Remove-Item -Path $SafetyTempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
