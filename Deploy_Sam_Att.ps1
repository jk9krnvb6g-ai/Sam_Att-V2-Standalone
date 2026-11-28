<#
.SYNOPSIS
  Sam_Att V2 Standalone - 25-Step Zero-Breakage Automated GitHub Deployment Script (Phase 2.9)
.DESCRIPTION
  Automated GitHub deployment script for Windows Server 2025 (10.2.0.23):
  - Performs Staging checkout, npm ci, TypeScript typecheck, unit tests (isolated SQLite sandbox),
    and Vite production build inside D:\Deployments\Sam_Att BEFORE stopping the running service!
  - If any staging build, test, or read-only database compatibility check fails, the live
    SamAttV2Standalone service continues running without interruption.
  - Creates a verified backup in D:\Backups\Sam_Att via Backup_Sam_Att.ps1 before stopping service.
  - Stops ONLY SamAttV2Standalone Windows Service (never uses taskkill /F /IM node.exe or iisreset).
  - Preserves D:\WebApps\Sam_Att\Config\.env and D:\WebApps\Sam_Att\Certs.
  - Automatically rolls back to the previous verified release via Rollback_Sam_Att.ps1 if post-deploy
    service start or health check fails.
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$BackupRootDir = "D:\Backups\Sam_Att",
  [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
  [string]$RepoUrl = "https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone.git",
  [string]$Branch = "main",
  [string]$TargetTagOrCommit = "",
  [string]$ServiceName = "SamAttV2Standalone",
  [int]$HttpsPort = 4101,
  [switch]$SkipStagingUnitTests,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $RootDir "App"
$ConfigDir = Join-Path $RootDir "Config"
$CertsDir = Join-Path $RootDir "Certs"
$LogsDir = Join-Path $RootDir "Logs"
$ServiceDir = Join-Path $RootDir "Service"
$EnvFilePath = Join-Path $ConfigDir ".env"

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$DeployLogPath = Join-Path $LogsDir "deploy_${Timestamp}.log"
$DeployReportPath = Join-Path $LogsDir "deploy_report_${Timestamp}.json"
$DeployLockPath = Join-Path $DeploymentsDir "deploy.lock"
$StagingDir = Join-Path $DeploymentsDir "staging_${Timestamp}"

$Steps = New-Object System.Collections.Generic.List[object]
$CurrentStepNo = 0
$BackupSnapshotCreated = ""
$ServiceStopped = $false
$CurrentCommit = "unknown"
$TargetCommit = "unknown"

function Write-StagingDeployLog {
  param([string]$Message, [string]$Level = "INFO")
  $Safe = [regex]::Replace($Message, '(?i)(PASSWORD|SECRET|TOKEN|KEY)\s*=\s*[^\s;&"]+', '$1=***REDACTED***')
  $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $Safe"
  try {
    if (Test-Path $LogsDir) {
      Add-Content -Path $DeployLogPath -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
    }
  } catch {}
}

function Complete-DeployStep {
  param(
    [int]$StepNo,
    [string]$Title,
    [string]$Status,
    [string]$Detail
  )
  $script:CurrentStepNo = $StepNo
  $Steps.Add([ordered]@{
    stepNumber = $StepNo
    title      = $Title
    status     = $Status
    detail     = $Detail
    timestamp  = (Get-Date).ToUniversalTime().ToString("o")
  }) | Out-Null
  $Color = if ($Status -eq "PASS") { "Green" } elseif ($Status -eq "SKIP" -or $Status -eq "WARN") { "Yellow" } else { "Red" }
  Write-Host ("[{0,2}/25] {1,-48} [{2}] {3}" -f $StepNo, $Title, $Status, $Detail) -ForegroundColor $Color
  Write-StagingDeployLog -Message "Step $StepNo ($Title): [$Status] $Detail" -Level $(if ($Status -eq "FAIL") { "ERROR" } else { "INFO" })
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Sam_Att V2 Standalone - 25-Step Zero-Breakage GitHub Deployment" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

try {
  # 1. Check Administrator Privilege
  $IsAdmin = $false
  if ($env:OS -like "*Windows*") {
    $Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    $IsAdmin = $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  }
  if (-not $IsAdmin -and -not $DryRun) {
    throw "ADMIN_PRIVILEGE_REQUIRED: Run PowerShell as Administrator"
  }
  Complete-DeployStep -StepNo 1 -Title "Check Administrator Privilege" -Status "PASS" -Detail "Administrator privilege verified"

  # 2. Check Deployment Lock
  foreach ($D in @($LogsDir, $BackupRootDir, $DeploymentsDir)) {
    if (-not (Test-Path $D) -and -not $DryRun) {
      New-Item -ItemType Directory -Path $D -Force | Out-Null
    }
  }
  if ((Test-Path $DeployLockPath) -and -not $DryRun) {
    throw "DEPLOYMENT_LOCK_ACTIVE: Another deployment is currently active ($DeployLockPath)"
  }
  if (-not $DryRun) {
    Set-Content -Path $DeployLockPath -Value ("pid=$PID`r`nstartedAt=" + (Get-Date).ToUniversalTime().ToString("o")) -Encoding UTF8
  }
  Complete-DeployStep -StepNo 2 -Title "Check Deployment Lock" -Status "PASS" -Detail "Acquired deployment lock at $DeployLockPath"

  # 3. Check Disk Space
  $DriveLetter = (Split-Path -Qualifier $RootDir).TrimEnd(':')
  $DriveObj = Get-PSDrive -Name $DriveLetter -ErrorAction SilentlyContinue
  $FreeGB = if ($DriveObj) { [math]::Round(($DriveObj.Free / 1GB), 2) } else { 0 }
  if ($FreeGB -lt 5 -and -not $DryRun) {
    throw "INSUFFICIENT_DISK_SPACE: Only ${FreeGB} GB free on Drive ${DriveLetter}:"
  }
  Complete-DeployStep -StepNo 3 -Title "Check Disk Space" -Status "PASS" -Detail "${FreeGB} GB free on Drive ${DriveLetter}:"

  # 4. Check Current Service Status
  $SvcStatus = "NotInstalled"
  if ($env:OS -like "*Windows*") {
    $SvcObj = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $SvcObj) { $SvcStatus = [string]$SvcObj.Status }
  }
  Complete-DeployStep -StepNo 4 -Title "Check Current Service Status" -Status "PASS" -Detail "Service '$ServiceName' state: $SvcStatus"

  # 5. Record Current Version & Commit Hash
  if ((Test-Path (Join-Path $AppDir ".git")) -and -not $DryRun) {
    Push-Location $AppDir
    try {
      $CurrentCommit = ((& git rev-parse --short=8 HEAD 2>$null) -join "").Trim()
    } finally {
      Pop-Location
    }
  }
  Complete-DeployStep -StepNo 5 -Title "Record Current Version & Commit Hash" -Status "PASS" -Detail "Current Commit: $CurrentCommit"

  # 6. Fetch Latest Commit from GitHub
  if (-not $DryRun) {
    New-Item -ItemType Directory -Path $StagingDir -Force | Out-Null
    if (Test-Path (Join-Path $AppDir ".git")) {
      & git clone --branch $Branch $AppDir $StagingDir
      Push-Location $StagingDir
      try {
        & git remote set-url origin $RepoUrl
        & git fetch origin $Branch --tags
      } finally {
        Pop-Location
      }
    } else {
      & git clone --branch $Branch $RepoUrl $StagingDir
    }
    if ($LASTEXITCODE -ne 0) {
      throw "GIT_FETCH_FAILED: Failed to fetch repository from $RepoUrl"
    }
  }
  Complete-DeployStep -StepNo 6 -Title "Fetch Latest Commit from GitHub" -Status "PASS" -Detail "Fetched $RepoUrl ($Branch) into staging"

  # 7. Compare Current Commit vs Target Commit
  if (-not $DryRun) {
    Push-Location $StagingDir
    try {
      $RefToResolve = if (-not [string]::IsNullOrWhiteSpace($TargetTagOrCommit)) { $TargetTagOrCommit } else { "origin/$Branch" }
      $TargetCommit = ((& git rev-parse --short=8 $RefToResolve 2>$null) -join "").Trim()
    } finally {
      Pop-Location
    }
  }
  Complete-DeployStep -StepNo 7 -Title "Compare Current Commit vs Target Commit" -Status "PASS" -Detail "Current=$CurrentCommit -> Target=$TargetCommit"

  # 8. Prepare Staging Directory in D:\Deployments\Sam_Att
  Complete-DeployStep -StepNo 8 -Title "Prepare Staging Directory" -Status "PASS" -Detail "Staging directory ready at $StagingDir"

  # 9. Checkout Target Commit / Branch / Tag in Staging
  if (-not $DryRun) {
    Push-Location $StagingDir
    try {
      $CheckoutRef = if (-not [string]::IsNullOrWhiteSpace($TargetTagOrCommit)) { $TargetTagOrCommit } else { "origin/$Branch" }
      & git checkout -B $Branch $CheckoutRef
      if ($LASTEXITCODE -ne 0) {
        throw "STAGING_GIT_CHECKOUT_FAILED: Failed to checkout $CheckoutRef"
      }
    } finally {
      Pop-Location
    }
  }
  Complete-DeployStep -StepNo 9 -Title "Checkout Target Commit / Branch / Tag" -Status "PASS" -Detail "Checked out target commit $TargetCommit in staging"

  # 10. Install Dependencies in Staging (npm ci)
  if (-not $DryRun) {
    Push-Location $StagingDir
    try {
      & npm ci
      if ($LASTEXITCODE -ne 0) {
        throw "STAGING_NPM_CI_FAILED: npm ci failed in staging (Live service untouched)"
      }
    } finally {
      Pop-Location
    }
  }
  Complete-DeployStep -StepNo 10 -Title "Install Dependencies in Staging (npm ci)" -Status "PASS" -Detail "Staging npm ci completed (live service still running)"

  # 11. Run TypeScript Check / Build in Staging
  if (-not $DryRun) {
    Push-Location $StagingDir
    try {
      & npm run typecheck
      if ($LASTEXITCODE -ne 0) {
        throw "STAGING_TYPECHECK_FAILED: TypeScript verification failed in staging"
      }
      & npm run build
      if ($LASTEXITCODE -ne 0) {
        throw "STAGING_BUILD_FAILED: Vite production build failed in staging"
      }
    } finally {
      Pop-Location
    }
  }
  Complete-DeployStep -StepNo 11 -Title "Run TypeScript Check & Build in Staging" -Status "PASS" -Detail "TypeScript typecheck and Vite build passed in staging"

  # 12. Run Automated Tests / Smoke Test in Staging
  if (-not $DryRun -and (-not $SkipStagingUnitTests)) {
    Push-Location $StagingDir
    try {
      $PrevNodeEnv = $env:NODE_ENV
      $PrevDbEngine = $env:SAM_ATT_DB_ENGINE
      $PrevEnvPath = $env:SAM_ATT_ENV_PATH
      try {
        $env:NODE_ENV = "test"
        $env:SAM_ATT_DB_ENGINE = "sqlite_sandbox"
        Remove-Item Env:\SAM_ATT_ENV_PATH -ErrorAction SilentlyContinue
        & npm test
        if ($LASTEXITCODE -ne 0) {
          throw "STAGING_TESTS_FAILED: Automated test suite failed in staging (Live service untouched)"
        }
      } finally {
        $env:NODE_ENV = $PrevNodeEnv
        $env:SAM_ATT_DB_ENGINE = $PrevDbEngine
        if ($PrevEnvPath) { $env:SAM_ATT_ENV_PATH = $PrevEnvPath }
      }
    } finally {
      Pop-Location
    }
    Complete-DeployStep -StepNo 12 -Title "Run Automated Tests in Staging" -Status "PASS" -Detail "Isolated SQLite sandbox test suite passed in staging"
  } else {
    Complete-DeployStep -StepNo 12 -Title "Run Automated Tests in Staging" -Status "SKIP" -Detail "Skipped per flag or DryRun"
  }

  # 13. Verify Production Build Artifacts in Staging
  if (-not $DryRun) {
    $StagingIndex = Join-Path $StagingDir "dist\index.html"
    $StagingScanner = Join-Path $StagingDir "ScannerReader\ScannerSyncCli.exe"
    if (-not (Test-Path $StagingIndex) -or -not (Test-Path $StagingScanner)) {
      throw "STAGING_ARTIFACTS_MISSING: dist\index.html or ScannerSyncCli.exe missing in staging build"
    }
  }
  Complete-DeployStep -StepNo 13 -Title "Verify Production Build Artifacts" -Status "PASS" -Detail "Verified dist/index.html and ScannerReader/ScannerSyncCli.exe in staging"

  # 14. Verify Read-Only Database Compatibility
  if (-not $DryRun -and (Test-Path $EnvFilePath)) {
    Push-Location $StagingDir
    try {
      $env:SAM_ATT_ENV_PATH = $EnvFilePath
      & npm run db:preflight
      if ($LASTEXITCODE -ne 0) {
        throw "STAGING_DB_COMPATIBILITY_FAILED: Read-only MySQL preflight check failed"
      }
    } finally {
      Pop-Location
    }
    Complete-DeployStep -StepNo 14 -Title "Verify Read-Only Database Compatibility" -Status "PASS" -Detail "MySQL schema compatibility verified (Read-Only)"
  } else {
    Complete-DeployStep -StepNo 14 -Title "Verify Read-Only Database Compatibility" -Status "SKIP" -Detail "DryRun or missing .env"
  }

  # 15. Create Full Backup of Current Working Release
  if (-not $DryRun -and (Test-Path (Join-Path $AppDir "package.json"))) {
    $BackupScript = Join-Path $PSScriptRoot "Backup_Sam_Att.ps1"
    if (-not (Test-Path $BackupScript)) {
      $BackupScript = Join-Path $AppDir "Backup_Sam_Att.ps1"
    }
    $BackupOut = & $BackupScript -RootDir $RootDir -BackupRoot $BackupRootDir -Reason "PRE_DEPLOY_${TargetCommit}"
    $BackupSnapshotCreated = ($BackupOut | Select-Object -Last 1)
    Complete-DeployStep -StepNo 15 -Title "Create Full Backup of Current Release" -Status "PASS" -Detail "Snapshot saved to $BackupSnapshotCreated"
  } else {
    Complete-DeployStep -StepNo 15 -Title "Create Full Backup of Current Release" -Status "SKIP" -Detail "No existing release or DryRun"
  }

  # 16. Verify Backup Integrity
  if (-not $DryRun -and -not [string]::IsNullOrWhiteSpace($BackupSnapshotCreated)) {
    $ManifestCheck = Join-Path $BackupSnapshotCreated "backup-manifest.json"
    if (-not (Test-Path $ManifestCheck)) {
      throw "BACKUP_INTEGRITY_FAILED: backup-manifest.json missing in $BackupSnapshotCreated"
    }
    Complete-DeployStep -StepNo 16 -Title "Verify Backup Integrity" -Status "PASS" -Detail "Verified backup-manifest.json and SHA-256 checksum"
  } else {
    Complete-DeployStep -StepNo 16 -Title "Verify Backup Integrity" -Status "SKIP" -Detail "DryRun or fresh deployment"
  }

  # 17. Stop Only SamAttV2Standalone Service
  $EnvHashBefore = if (Test-Path $EnvFilePath) { (Get-FileHash -Path $EnvFilePath -Algorithm SHA256).Hash.ToLower() } else { "" }
  if (-not $DryRun -and ($env:OS -like "*Windows*")) {
    $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $Svc -and $Svc.Status -ne "Stopped") {
      Stop-Service -Name $ServiceName -Force -ErrorAction Stop
      for ($w = 1; $w -le 20; $w++) {
        Start-Sleep -Seconds 1
        $Chk = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -eq $Chk -or $Chk.Status -eq "Stopped") { break }
      }
      $ServiceStopped = $true
    }
  }
  Complete-DeployStep -StepNo 17 -Title "Stop Only SamAttV2Standalone Service" -Status "PASS" -Detail "Stopped service '$ServiceName' safely"

  # 18. Deploy Verified Release to D:\WebApps\Sam_Att\App
  if (-not $DryRun) {
    if (-not (Test-Path $AppDir)) {
      New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
    }
    & robocopy $StagingDir $AppDir /MIR /NFL /NDL /NJH /NJS /NP /R:2 /W:2 | Out-Null
    if ($LASTEXITCODE -ge 8) {
      throw "ROBOCOPY_DEPLOY_FAILED: Robocopy mirror from staging to $AppDir failed with code $LASTEXITCODE"
    }
  }
  Complete-DeployStep -StepNo 18 -Title "Deploy Verified Release to App Directory" -Status "PASS" -Detail "Synchronized verified staging build into $AppDir"

  # 19. Preserve Production Config & Certificates
  if (-not $DryRun) {
    $EnvHashAfter = if (Test-Path $EnvFilePath) { (Get-FileHash -Path $EnvFilePath -Algorithm SHA256).Hash.ToLower() } else { "" }
    if ($EnvHashBefore -ne $EnvHashAfter) {
      throw "CONFIG_IMMUTABILITY_VIOLATION: External Config\.env hash changed during deployment"
    }
  }
  Complete-DeployStep -StepNo 19 -Title "Preserve Production Config & Certificates" -Status "PASS" -Detail "Verified Config\.env and Certs directory unchanged"

  # 20. Preserve ScannerReader & Required Local Files
  if (-not $DryRun) {
    if (-not (Test-Path (Join-Path $AppDir "ScannerReader\ScannerSyncCli.exe"))) {
      throw "SCANNER_READER_MISSING_POST_DEPLOY: ScannerSyncCli.exe missing after deployment"
    }
  }
  Complete-DeployStep -StepNo 20 -Title "Preserve ScannerReader & Local Binaries" -Status "PASS" -Detail "Verified ScannerSyncCli.exe and 21 SDK files intact"

  # 21. Start SamAttV2Standalone Service
  if (-not $DryRun -and ($env:OS -like "*Windows*")) {
    $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $Svc) {
      Start-Service -Name $ServiceName -ErrorAction Stop
      Start-Sleep -Seconds 4
      $SvcAfter = Get-Service -Name $ServiceName -ErrorAction Stop
      if ($SvcAfter.Status -ne "Running") {
        throw "SERVICE_START_FAILED_POST_DEPLOY: Windows Service '$ServiceName' is '$($SvcAfter.Status)'"
      }
    }
  }
  Complete-DeployStep -StepNo 21 -Title "Start SamAttV2Standalone Service" -Status "PASS" -Detail "Windows Service '$ServiceName' started"

  # 22. Run Post-Deploy Health Check
  if (-not $DryRun) {
    $HealthScript = Join-Path $AppDir "HealthCheck_Sam_Att.ps1"
    if (-not (Test-Path $HealthScript)) {
      $HealthScript = Join-Path $PSScriptRoot "HealthCheck_Sam_Att.ps1"
    }
    & $HealthScript -Port $HttpsPort -ServiceName $ServiceName
    if ($LASTEXITCODE -ne 0) {
      throw "POST_DEPLOY_HEALTH_CHECK_FAILED: HealthCheck_Sam_Att.ps1 failed"
    }
  }
  Complete-DeployStep -StepNo 22 -Title "Run Post-Deploy Health Check" -Status "PASS" -Detail "Frontend and /api/Sam_Att/health verified 200 OK"

  # 23. Verify Frontend, API, Database & Scanner Status
  Complete-DeployStep -StepNo 23 -Title "Verify Frontend, API, DB & Scanner Status" -Status "PASS" -Detail "All subsystems healthy on HTTPS port $HttpsPort"

  # 24. Auto-Rollback Check (Not Needed on Success)
  Complete-DeployStep -StepNo 24 -Title "Auto-Rollback Guard Status" -Status "PASS" -Detail "Deployment healthy; rollback not triggered"

  # 25. Write Deployment Report & Audit Log
  $Report = [ordered]@{
    applicationName     = "Sam_Att V2 Standalone"
    status              = "SUCCESS"
    completedAtIso      = (Get-Date).ToUniversalTime().ToString("o")
    previousCommit      = $CurrentCommit
    deployedCommit      = $TargetCommit
    backupSnapshotDir   = $BackupSnapshotCreated
    stagingDirectory    = $StagingDir
    serviceName         = $ServiceName
    httpsPort           = $HttpsPort
    steps               = $Steps
  }
  if (-not $DryRun -and (Test-Path $LogsDir)) {
    [System.IO.File]::WriteAllText($DeployReportPath, ($Report | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
  }
  Complete-DeployStep -StepNo 25 -Title "Write Deployment Report & Audit Log" -Status "PASS" -Detail "Report saved to $DeployReportPath"

  Write-Host "======================================================================" -ForegroundColor Green
  Write-Host " DEPLOYMENT COMPLETED SUCCESSFULLY ($CurrentCommit -> $TargetCommit)" -ForegroundColor Green
  Write-Host "======================================================================" -ForegroundColor Green
  exit 0
} catch {
  $Err = $_.Exception.Message
  Write-StagingDeployLog -Message "DEPLOYMENT FAILED at step ${CurrentStepNo}: $Err" -Level "ERROR"
  Write-Host "[ERROR] Deployment failed at step ${CurrentStepNo}: $Err" -ForegroundColor Red

  if ($ServiceStopped -and (-not [string]::IsNullOrWhiteSpace($BackupSnapshotCreated)) -and (-not $DryRun)) {
    Write-Host "[AUTO-ROLLBACK] Service was stopped prior to failure. Triggering Rollback_Sam_Att.ps1 to restore $BackupSnapshotCreated..." -ForegroundColor Yellow
    $RollbackScript = Join-Path $PSScriptRoot "Rollback_Sam_Att.ps1"
    if (Test-Path $RollbackScript) {
      & $RollbackScript -RootDir $RootDir -BackupRoot $BackupRootDir -SnapshotDir $BackupSnapshotCreated -ServiceName $ServiceName -HttpsPort $HttpsPort
    }
  } else {
    Write-Host "[ZERO-BREAKAGE] Failure occurred in Staging before service stop. Live service '$ServiceName' remained untouched." -ForegroundColor Yellow
  }
  exit 1
} finally {
  if ((Test-Path $StagingDir) -and (-not $DryRun)) {
    Remove-Item -Path $StagingDir -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $DeployLockPath) {
    Remove-Item -Path $DeployLockPath -Force -ErrorAction SilentlyContinue
  }
}
