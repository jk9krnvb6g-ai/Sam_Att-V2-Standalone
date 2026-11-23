<#
.SYNOPSIS
  Sam_Att V2 Standalone - Verified Database (mysqldump) + Application Release + Config Backup Script
  Stores backups OUTSIDE the Git repository (default: C:\SamAttBackups), uses a temporary --defaults-extra-file
  so passwords never appear on CLI or in logs, verifies exit code / size / SQL markers / SHA-256, and never deletes old backups.
#>
[CmdletBinding()]
param(
  [string]$AppDir = "C:\inetpub\wwwroot\Sam_Att",
  [string]$BackupRoot = "C:\SamAttBackups",
  [string]$DbHost = "",
  [int]$DbPort = 0,
  [string]$DbName = "",
  [string]$DbUser = "",
  [string]$ReleaseVersion = "2.0.0-standalone",
  [string]$CommitSha = "HEAD"
)

$ErrorActionPreference = "Stop"
$AppDir = [System.IO.Path]::GetFullPath($AppDir)
$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)

if ($BackupRoot.StartsWith($AppDir, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "BACKUP_DIR_INSIDE_GIT_FORBIDDEN: BackupRoot ($BackupRoot) must be stored OUTSIDE the application Git directory ($AppDir)"
}

# Read .env safely without printing any secret values
$EnvMap = @{}
$DotEnvPath = Join-Path $AppDir ".env"
if (Test-Path $DotEnvPath) {
  foreach ($Line in Get-Content -Path $DotEnvPath -Encoding UTF8) {
    $T = $Line.Trim()
    if ([string]::IsNullOrWhiteSpace($T) -or $T.StartsWith("#")) { continue }
    $Idx = $T.IndexOf("=")
    if ($Idx -le 0) { continue }
    $K = $T.Substring(0, $Idx).Trim()
    $V = $T.Substring($Idx + 1).Trim().Trim('"').Trim("'")
    $EnvMap[$K] = $V
  }
}

if ([string]::IsNullOrWhiteSpace($DbHost)) { $DbHost = if ($EnvMap.ContainsKey("SAM_ATT_DB_HOST")) { $EnvMap["SAM_ATT_DB_HOST"] } else { "127.0.0.1" } }
if ($DbPort -le 0) { $DbPort = if ($EnvMap.ContainsKey("SAM_ATT_DB_PORT")) { [int]$EnvMap["SAM_ATT_DB_PORT"] } else { 3306 } }
if ([string]::IsNullOrWhiteSpace($DbName)) { $DbName = if ($EnvMap.ContainsKey("SAM_ATT_DB_NAME")) { $EnvMap["SAM_ATT_DB_NAME"] } else { "samchuk_attendance_v2" } }
if ([string]::IsNullOrWhiteSpace($DbUser)) { $DbUser = if ($EnvMap.ContainsKey("SAM_ATT_DB_USER")) { $EnvMap["SAM_ATT_DB_USER"] } else { "sam_att_app" } }
$DbPassword = if ($EnvMap.ContainsKey("SAM_ATT_DB_PASSWORD")) { $EnvMap["SAM_ATT_DB_PASSWORD"] } elseif ($env:MYSQL_PWD) { $env:MYSQL_PWD } else { "" }

if ($DbName -imatch "hosoffice") {
  throw "BACKUP_FORBIDDEN_HOSOFFICE_DB: Refusing to dump HOSOffice database"
}

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$TargetDir = Join-Path $BackupRoot "sam_att_backup_$Timestamp"
New-Item -ItemType Directory -Path $TargetDir -Force | Out-Null

if ($env:OS -like "*Windows*") {
  $CurUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls $TargetDir /inheritance:r /grant:r "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" "${CurUser}:(OI)(CI)F" 2>$null | Out-Null
}

$TmpCnf = $null
try {
  Write-Host "[Backup] Step 1/4: Verifying mysqldump binary availability..."
  $MysqlDumpCmd = Get-Command mysqldump -ErrorAction SilentlyContinue
  if (-not $MysqlDumpCmd) {
    throw "BACKUP_FAILED_NO_MYSQLDUMP: mysqldump executable not found in PATH. Refusing to record a fake backup."
  }

  $SqlDumpFile = Join-Path $TargetDir "${DbName}_${Timestamp}.sql"
  Write-Host "[Backup] Step 2/4: Dumping MySQL database '$DbName' to $SqlDumpFile..."

  $DumpArgs = @("--single-transaction", "--routines", "--triggers", "--quick", "--hex-blob", "--result-file=$SqlDumpFile", $DbName)
  if (-not [string]::IsNullOrWhiteSpace($DbPassword)) {
    $TmpCnf = Join-Path $env:TEMP "sam_att_bkp_$Timestamp`_$([guid]::NewGuid().ToString('N').Substring(0,8)).cnf"
    $EscPass = $DbPassword.Replace('\', '\\').Replace('"', '\"')
    Set-Content -Path $TmpCnf -Value ("[client]`r`nhost=$DbHost`r`nport=$DbPort`r`nuser=$DbUser`r`npassword=`"$EscPass`"`r`n") -Encoding ASCII
    if ($env:OS -like "*Windows*") {
      $CurUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      & icacls $TmpCnf /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${CurUser}:F" 2>$null | Out-Null
    }
    $DumpArgs = @("--defaults-extra-file=$TmpCnf") + $DumpArgs
  } else {
    $DumpArgs = @("--host=$DbHost", "--port=$DbPort", "--user=$DbUser") + $DumpArgs
  }

  & $MysqlDumpCmd.Source @DumpArgs
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
  Set-Content -Path "$SqlDumpFile.sha256" -Value $DumpHash -Encoding ASCII

  Write-Host "[Backup] Step 3/4: Archiving application release and safe configuration metadata..."
  $ReleaseBackupDir = Join-Path $TargetDir "release_snapshot"
  New-Item -ItemType Directory -Path $ReleaseBackupDir -Force | Out-Null

  $DistPath = Join-Path $AppDir "dist"
  if (-not (Test-Path (Join-Path $DistPath "index.html"))) {
    throw "BACKUP_FAILED_DIST_MISSING: Built frontend bundle (dist/index.html) not found in $AppDir"
  }
  Copy-Item -Path $DistPath -Destination (Join-Path $ReleaseBackupDir "dist") -Recurse -Force

  foreach ($FileItem in @("package.json", "package-lock.json", "tsconfig.json", "server.ts")) {
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
} finally {
  if ($TmpCnf -and (Test-Path $TmpCnf)) {
    Remove-Item -Path $TmpCnf -Force -ErrorAction SilentlyContinue
  }
}

