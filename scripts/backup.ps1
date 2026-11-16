<#
.SYNOPSIS
  Sam_Att V2 Standalone — Verified Database (mysqldump) + Application Release + Config Backup Script
  Enforces real mysqldump exit code verification, non-zero file size checks, and SHA-256 manifest generation.
#>
[CmdletBinding()]
param(
  [string]$AppDir = "C:\Sam_Att\app",
  [string]$BackupRoot = "C:\Sam_Att\backups",
  [string]$DbHost = "127.0.0.1",
  [int]$DbPort = 3306,
  [string]$DbName = "samchuk_attendance_v2",
  [string]$DbUser = "sam_att_backup",
  [string]$ReleaseVersion = "2.0.0-standalone",
  [string]$CommitSha = "HEAD"
)

$ErrorActionPreference = "Stop"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$TargetDir = Join-Path $BackupRoot "sam_att_backup_$Timestamp"
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

try {
  Write-Host "[Backup] Step 1/4: Verifying mysqldump binary availability..."
  $MysqlDumpCmd = Get-Command mysqldump -ErrorAction SilentlyContinue
  if (-not $MysqlDumpCmd) {
    throw "BACKUP_FAILED_NO_MYSQLDUMP: mysqldump executable not found in PATH. Refusing to record a fake backup."
  }

  $SqlDumpFile = Join-Path $TargetDir "$DbName`_$Timestamp.sql"
  Write-Host "[Backup] Step 2/4: Dumping MySQL database '$DbName' to $SqlDumpFile..."
  & mysqldump --host=$DbHost --port=$DbPort --user=$DbUser --single-transaction --routines --triggers --result-file="$SqlDumpFile" $DbName
  if ($LASTEXITCODE -ne 0) {
    throw "BACKUP_FAILED_MYSQLDUMP_EXIT_CODE: mysqldump failed with exit code $LASTEXITCODE"
  }

  if (-not (Test-Path $SqlDumpFile)) {
    throw "BACKUP_FAILED_DUMP_MISSING: SQL dump file was not created at $SqlDumpFile"
  }
  $DumpInfo = Get-Item $SqlDumpFile
  if ($DumpInfo.Length -le 64) {
    throw "BACKUP_FAILED_DUMP_EMPTY: SQL dump file size ($($DumpInfo.Length) bytes) is invalid or empty"
  }
  $DumpHash = (Get-FileHash -Path $SqlDumpFile -Algorithm SHA256).Hash.ToLower()

  Write-Host "[Backup] Step 3/4: Archiving application release and safe configuration metadata..."
  $ReleaseBackupDir = Join-Path $TargetDir "release_snapshot"
  New-Item -ItemType Directory -Path $ReleaseBackupDir -Force | Out-Null

  $DistPath = Join-Path $AppDir "dist"
  if (-not (Test-Path (Join-Path $DistPath "index.html"))) {
    throw "BACKUP_FAILED_DIST_MISSING: Built frontend bundle (dist/index.html) not found in $AppDir"
  }
  Copy-Item -Path $DistPath -Destination (Join-Path $ReleaseBackupDir "dist") -Recurse -Force

  foreach ($FileItem in @("package.json", "package-lock.json", "server.ts")) {
    $SrcFile = Join-Path $AppDir $FileItem
    if (Test-Path $SrcFile) {
      Copy-Item -Path $SrcFile -Destination (Join-Path $ReleaseBackupDir $FileItem) -Force
    }
  }

  $IndexHtmlHash = (Get-FileHash -Path (Join-Path $ReleaseBackupDir "dist\index.html") -Algorithm SHA256).Hash.ToLower()

  Write-Host "[Backup] Step 4/4: Writing cryptographic backup manifest..."
  $ManifestObj = [ordered]@{
    serviceName        = "Sam_Att_V2_Standalone"
    backupTimestamp    = $Timestamp
    releaseVersion     = $ReleaseVersion
    commitSha          = $CommitSha
    databaseName       = $DbName
    sqlDumpFileName    = (Split-Path $SqlDumpFile -Leaf)
    sqlDumpSizeBytes   = $DumpInfo.Length
    sqlDumpSha256      = $DumpHash
    distIndexSha256    = $IndexHtmlHash
    appDirectory       = $AppDir
    createdBy          = $env:USERNAME
    status             = "VERIFIED_READY"
  }

  $ManifestJson = $ManifestObj | ConvertTo-Json -Depth 5
  $ManifestPath = Join-Path $TargetDir "manifest.json"
  Set-Content -Path $ManifestPath -Value $ManifestJson -Encoding UTF8
  $ManifestHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
  Set-Content -Path (Join-Path $TargetDir "manifest.json.sha256") -Value $ManifestHash -Encoding ASCII

  Write-Host "[Backup] SUCCESS: Backup verified at $TargetDir (Dump SHA-256: $DumpHash)"
  Write-Output $TargetDir
} catch {
  Write-Error "[Backup] FAILED: $($_.Exception.Message)"
  if (Test-Path $TargetDir) {
    Remove-Item -Path $TargetDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  exit 1
}
