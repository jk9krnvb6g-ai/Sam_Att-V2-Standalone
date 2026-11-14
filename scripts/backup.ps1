<#
.SYNOPSIS
  Sam_Att V2 Standalone — Database + Config + Build + Manifest Backup Script
#>
[CmdletBinding()]
param(
  [string]$AppDir = "C:\Sam_Att\app",
  [string]$BackupRoot = "C:\Sam_Att\backups",
  [string]$DbHost = "127.0.0.1",
  [int]$DbPort = 3306,
  [string]$DbName = "samchuk_attendance_v2",
  [string]$DbUser = "sam_att_backup"
)

$ErrorActionPreference = "Stop"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$TargetDir = Join-Path $BackupRoot "sam_att_backup_$Timestamp"
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

Write-Host "[Backup] Backing up configuration and static build artifacts to $TargetDir..."
if (Test-Path (Join-Path $AppDir "dist")) {
  Copy-Item -Path (Join-Path $AppDir "dist") -Destination (Join-Path $TargetDir "dist") -Recurse
}
if (Test-Path (Join-Path $AppDir "package.json")) {
  Copy-Item -Path (Join-Path $AppDir "package.json") -Destination (Join-Path $TargetDir "package.json")
}

$SqlDumpFile = Join-Path $TargetDir "$DbName`_$Timestamp.sql"
if (Get-Command mysqldump -ErrorAction SilentlyContinue) {
  Write-Host "[Backup] Dumping MySQL database '$DbName'..."
  & mysqldump --host=$DbHost --port=$DbPort --user=$DbUser --single-transaction --routines --triggers $DbName > $SqlDumpFile
} else {
  Write-Host "[Backup] mysqldump not in PATH; recording backup manifest."
}

$Manifest = @{
  backupTimestamp = $Timestamp
  databaseName    = $DbName
  appDirectory    = $AppDir
  createdBy       = $env:USERNAME
} | ConvertTo-Json
Set-Content -Path (Join-Path $TargetDir "manifest.json") -Value $Manifest -Encoding UTF8

Write-Host "[Backup] Completed successfully: $TargetDir"
Write-Output $TargetDir
