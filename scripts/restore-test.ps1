<#
.SYNOPSIS
  Sam_Att V2 Standalone - Verified Database & Application Release Restore Script
  Supports both backup-manifest.json (Deploy_Sam_Att.ps1) and manifest.json (scripts/backup.ps1).
  Verifies SHA-256 checksums before restore, uses temporary --defaults-extra-file (never CLI password),
  takes a pre-restore safety snapshot, restores MySQL database + dist/ files, and runs post-restore health check.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupFolder,
  [string]$AppDir = "C:\inetpub\wwwroot\Sam_Att",
  [string]$ServiceName = "Sam_Att_V2_Standalone",
  [string]$DbHost = "",
  [int]$DbPort = 0,
  [string]$DbName = "",
  [string]$DbUser = ""
)

$ErrorActionPreference = "Stop"

# Read .env safely without printing secrets
$EnvMap = @{}
$DotEnvPath = Join-Path $AppDir ".env"
if (Test-Path $DotEnvPath) {
  foreach ($Line in Get-Content -Path $DotEnvPath -Encoding UTF8) {
    $T = $Line.Trim()
    if ([string]::IsNullOrWhiteSpace($T) -or $T.StartsWith("#")) { continue }
    $Idx = $T.IndexOf("=")
    if ($Idx -le 0) { continue }
    $EnvMap[$T.Substring(0, $Idx).Trim()] = $T.Substring($Idx + 1).Trim().Trim('"').Trim("'")
  }
}

if ([string]::IsNullOrWhiteSpace($DbHost)) { $DbHost = if ($EnvMap.ContainsKey("SAM_ATT_DB_HOST")) { $EnvMap["SAM_ATT_DB_HOST"] } else { "127.0.0.1" } }
if ($DbPort -le 0) { $DbPort = if ($EnvMap.ContainsKey("SAM_ATT_DB_PORT")) { [int]$EnvMap["SAM_ATT_DB_PORT"] } else { 3306 } }
if ([string]::IsNullOrWhiteSpace($DbName)) { $DbName = if ($EnvMap.ContainsKey("SAM_ATT_DB_NAME")) { $EnvMap["SAM_ATT_DB_NAME"] } else { "samchuk_attendance_v2" } }
if ([string]::IsNullOrWhiteSpace($DbUser)) { $DbUser = if ($EnvMap.ContainsKey("SAM_ATT_DB_USER")) { $EnvMap["SAM_ATT_DB_USER"] } else { "sam_att_app" } }
$DbPassword = if ($EnvMap.ContainsKey("SAM_ATT_DB_PASSWORD")) { $EnvMap["SAM_ATT_DB_PASSWORD"] } elseif ($env:MYSQL_PWD) { $env:MYSQL_PWD } else { "" }

if ($DbName -imatch "hosoffice") {
  throw "RESTORE_FORBIDDEN_HOSOFFICE_DB: Refusing to restore into HOSOffice database"
}

$ManifestPath = Join-Path $BackupFolder "backup-manifest.json"
if (-not (Test-Path $ManifestPath)) {
  $ManifestPath = Join-Path $BackupFolder "manifest.json"
}
$ManifestShaPath = "$ManifestPath.sha256"

if (-not (Test-Path $ManifestPath)) {
  throw "RESTORE_ABORTED_NO_MANIFEST: backup-manifest.json or manifest.json not found in $BackupFolder."
}

if (Test-Path $ManifestShaPath) {
  $ExpectedManifestHash = (Get-Content $ManifestShaPath -Raw).Trim().ToLower()
  $ActualManifestHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
  if ($ActualManifestHash -ne $ExpectedManifestHash) {
    throw "RESTORE_ABORTED_MANIFEST_TAMPERED: manifest SHA-256 mismatch ($ActualManifestHash != $ExpectedManifestHash)"
  }
}

$Manifest = Get-Content -Path $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$SqlDumpPath = Join-Path $BackupFolder $Manifest.sqlDumpFileName
$ReleaseDistBackup = Join-Path $BackupFolder "release_snapshot\dist"
if (-not (Test-Path $ReleaseDistBackup)) {
  $ReleaseDistBackup = Join-Path $BackupFolder "dist"
}

if (-not (Test-Path $SqlDumpPath)) {
  throw "RESTORE_ABORTED_DUMP_MISSING: SQL dump file '$($Manifest.sqlDumpFileName)' missing from $BackupFolder"
}

$ActualDumpHash = (Get-FileHash -Path $SqlDumpPath -Algorithm SHA256).Hash.ToLower()
if ($ActualDumpHash -ne $Manifest.sqlDumpSha256.ToLower()) {
  throw "RESTORE_ABORTED_DUMP_CHECKSUM_MISMATCH: SQL dump SHA-256 ($ActualDumpHash) does not match manifest ($($Manifest.sqlDumpSha256))"
}

$MysqlCmd = Get-Command mysql -ErrorAction SilentlyContinue
if (-not $MysqlCmd) {
  throw "RESTORE_ABORTED_NO_MYSQL_CLIENT: mysql client executable not found in PATH"
}

$SafetyTempDir = Join-Path $env:TEMP "sam_att_prerestore_safety_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
New-Item -ItemType Directory -Path $SafetyTempDir -Force | Out-Null
if (Test-Path (Join-Path $AppDir "dist")) {
  Copy-Item -Path (Join-Path $AppDir "dist") -Destination (Join-Path $SafetyTempDir "dist") -Recurse -Force
}

$TmpCnf = $null
try {
  Write-Host "[Restore] Step 1/4: Stopping Windows Service '$ServiceName' (Isolated to Sam_Att only; Procurement untouched)..."
  $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($Svc -and $Svc.Status -eq 'Running') {
    Stop-Service -Name $ServiceName -Force
    Start-Sleep -Seconds 2
  }

  Write-Host "[Restore] Step 2/4: Restoring MySQL database '$DbName' from verified dump ($SqlDumpPath)..."
  $MysqlArgs = @($DbName)
  if (-not [string]::IsNullOrWhiteSpace($DbPassword)) {
    $TmpCnf = Join-Path $env:TEMP "sam_att_restore_$(Get-Date -Format 'yyyyMMdd_HHmmss')_$([guid]::NewGuid().ToString('N').Substring(0,8)).cnf"
    $EscPass = $DbPassword.Replace('\', '\\').Replace('"', '\"')
    Set-Content -Path $TmpCnf -Value ("[client]`r`nhost=$DbHost`r`nport=$DbPort`r`nuser=$DbUser`r`npassword=`"$EscPass`"`r`n") -Encoding ASCII
    if ($env:OS -like "*Windows*") {
      $CurUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
      & icacls $TmpCnf /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" "${CurUser}:F" 2>$null | Out-Null
    }
    $MysqlArgs = @("--defaults-extra-file=$TmpCnf", $DbName)
  } else {
    $MysqlArgs = @("--host=$DbHost", "--port=$DbPort", "--user=$DbUser", $DbName)
  }

  Get-Content -Path $SqlDumpPath -Raw -Encoding UTF8 | & $MysqlCmd.Source @MysqlArgs
  if ($LASTEXITCODE -ne 0) {
    throw "RESTORE_DB_FAILED: mysql restore exited with code $LASTEXITCODE"
  }

  Write-Host "[Restore] Step 3/4: Restoring application release artifacts to $AppDir..."
  if (Test-Path (Join-Path $ReleaseDistBackup "index.html")) {
    if (Test-Path (Join-Path $AppDir "dist")) {
      Remove-Item -Path (Join-Path $AppDir "dist") -Recurse -Force
    }
    Copy-Item -Path $ReleaseDistBackup -Destination (Join-Path $AppDir "dist") -Recurse -Force
  }

  Write-Host "[Restore] Step 4/4: Starting service '$ServiceName' and executing Health Check..."
  if ($Svc) {
    Start-Service -Name $ServiceName
    Start-Sleep -Seconds 3
  }
  & "$PSScriptRoot\health-check.ps1"
  if ($LASTEXITCODE -ne 0) {
    throw "RESTORE_HEALTHCHECK_FAILED: Post-restore health check failed"
  }

  Write-Host "[Restore] SUCCESS: Database and release restored from verified backup $BackupFolder"
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
  if ($TmpCnf -and (Test-Path $TmpCnf)) {
    Remove-Item -Path $TmpCnf -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $SafetyTempDir) {
    Remove-Item -Path $SafetyTempDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

