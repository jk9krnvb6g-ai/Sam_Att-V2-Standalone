<#
.SYNOPSIS
    Sam_Att V2 Standalone - Canonical Production Safe Deployment & Upgrade Script (Deploy_Sam_Att.ps1)
.DESCRIPTION
    Performs a safe, application-only update on Windows Server 2025:
    1. Acquires Shared Lifecycle Lock (D:\Deployments\Sam_Att\lifecycle.lock).
    2. Creates a full SHA-256 verified Application Snapshot via Backup_Sam_Att.ps1.
    3. Fetches and resets/pulls latest code from Git (or stages from source folder) without touching Config\.env or Certs.
    4. Runs npm ci ONLY when package-lock.json SHA-256 hash changed or node_modules is missing.
    5. Runs npm run typecheck and npm run build (Checking $LASTEXITCODE at every step).
    6. Runs Read-Only Database Preflight (npm run db:preflight) -- NEVER runs DDL migrations automatically.
    7. Restarts ONLY SamAttV2Standalone service (never kills global node.exe, never touches IIS).
    8. Runs strict HealthCheck_Sam_Att.ps1 (verifying TLS trust, SAN 10.2.0.23, Windows Service PID ownership,
       Database readiness, and ExpectedVersion/ExpectedCommit).
    9. Automatically triggers Rollback_Sam_Att.ps1 (with pre-stop SHA-256 manifest verification) if build,
       preflight, service restart, or health check fails.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupRootDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [string]$ServiceName = "SamAttV2Standalone",
    [string]$Branch = "main",
    [string]$HostName = "10.2.0.23",
    [int]$HttpsPort = 4101,
    [string]$NodeExecutablePath = "",
    [string]$LockFilePath = "",
    [switch]$ForceNpmInstall,
    [switch]$SkipGitPull,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$AppDir     = Join-Path $SamAttRoot "App"
$ConfigDir  = Join-Path $SamAttRoot "Config"
$LogsDir    = Join-Path $SamAttRoot "Logs"
$EnvFile    = Join-Path $ConfigDir ".env"
if ([string]::IsNullOrWhiteSpace($LockFilePath)) {
    $LockFilePath = Join-Path $DeploymentsDir "lifecycle.lock"
}
$isDryRunMode = ($DryRun -or $WhatIfPreference)

if ($isDryRunMode) {
    Write-Host "[DRY-RUN] Would acquire shared lifecycle lock ($LockFilePath), create SHA-256 snapshot in $BackupRootDir, update $AppDir (branch $Branch), verify TypeScript & Vite build, run read-only DB preflight, restart $ServiceName, and run strict HTTPS HealthCheck on https://${HostName}:${HttpsPort}." -ForegroundColor Yellow
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($NodeExecutablePath) -and (Test-Path $NodeExecutablePath)) {
    $resolvedNodeExe = (Resolve-Path $NodeExecutablePath).Path
    $nodeDir = Split-Path -Parent $resolvedNodeExe
    $env:NODE_EXECUTABLE_PATH = $resolvedNodeExe
    $env:PATH = "${nodeDir};$($env:PATH)"
}

$lifecycleLockModule = Join-Path $PSScriptRoot "scripts\LifecycleLock.ps1"
if (-not (Test-Path $lifecycleLockModule)) {
    $lifecycleLockModule = Join-Path $AppDir "scripts\LifecycleLock.ps1"
}
if (-not (Test-Path $lifecycleLockModule)) {
    throw "LIFECYCLE_LOCK_ENGINE_MISSING: Could not find scripts\LifecycleLock.ps1"
}
. $lifecycleLockModule

$lockHandle = Acquire-AtomicLifecycleLock -Path $LockFilePath -Operation "DEPLOY"
$snapshotDir = $null

try {
    if (-not (Test-Path $AppDir)) {
        throw "APP_DIR_NOT_FOUND: $AppDir does not exist. Run Install_Sam_Att.ps1 first."
    }

    # Step 1: Create Pre-Deployment SHA-256 Verified Application Snapshot (FIX 05)
    Write-Host "[1/8] Creating Pre-Deployment Application Snapshot with SHA-256 File Manifest..." -ForegroundColor Cyan
    $backupScript = Join-Path $AppDir "Backup_Sam_Att.ps1"
    if (-not (Test-Path $backupScript)) {
        $backupScript = Join-Path $PSScriptRoot "Backup_Sam_Att.ps1"
    }
    $backupJson = & $backupScript -SamAttRoot $SamAttRoot -BackupRootDir $BackupRootDir -DeploymentsDir $DeploymentsDir -LockFilePath $LockFilePath -ParentLockId $lockHandle.lockId -Json
    if ($LASTEXITCODE -ne 0) {
        throw "PRE_DEPLOY_BACKUP_FAILED: Failed to create application snapshot before deployment."
    }
    $backupMeta = $backupJson | ConvertFrom-Json
    $snapshotDir = $backupMeta.snapshotName
    $fullSnapshotDir = Join-Path $BackupRootDir $snapshotDir
    Write-Host "  Snapshot created: $fullSnapshotDir ($($backupMeta.requiredFilesCount) files hashed)" -ForegroundColor Green

    Push-Location $AppDir
    try {
        $lockFileBefore = ""
        if (Test-Path "package-lock.json") {
            $lockFileBefore = (Get-FileHash "package-lock.json" -Algorithm SHA256).Hash
        }

        # Step 2: Pull Latest Source Code from Git
        if (-not $SkipGitPull -and (Test-Path ".git")) {
            Write-Host "[2/8] Fetching latest source code from Git ($Branch)..." -ForegroundColor Cyan
            & git fetch origin $Branch
            if ($LASTEXITCODE -ne 0) { throw "GIT_FETCH_FAILED: git fetch failed with exit code $LASTEXITCODE" }
            & git reset --hard "origin/$Branch"
            if ($LASTEXITCODE -ne 0) { throw "GIT_RESET_FAILED: git reset failed with exit code $LASTEXITCODE" }
        } else {
            Write-Host "[2/8] Skipping Git pull." -ForegroundColor Gray
        }

        $targetCommit = ""
        if (Test-Path ".git") {
            $gitHead = & git rev-parse --short HEAD 2>$null
            if ($LASTEXITCODE -eq 0 -and $gitHead) {
                $targetCommit = ($gitHead | Select-Object -First 1).Trim()
            }
        }
        $targetVersion = ""
        if (Test-Path "package.json") {
            try {
                $pkgObj = Get-Content "package.json" -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($pkgObj.version) { $targetVersion = [string]$pkgObj.version }
            } catch {}
        }

        # Step 3: Conditional npm ci
        $lockFileAfter = ""
        if (Test-Path "package-lock.json") {
            $lockFileAfter = (Get-FileHash "package-lock.json" -Algorithm SHA256).Hash
        }
        $needNpmCi = $ForceNpmInstall -or (-not (Test-Path "node_modules")) -or ($lockFileBefore -ne $lockFileAfter)
        if ($needNpmCi) {
            Write-Host "[3/8] Installing dependencies (npm ci)..." -ForegroundColor Cyan
            & npm ci
            if ($LASTEXITCODE -ne 0) { throw "NPM_CI_FAILED: npm ci exited with code $LASTEXITCODE" }
        } else {
            Write-Host "[3/8] package-lock.json unchanged; skipping npm ci." -ForegroundColor Gray
        }

        # Step 4: TypeScript Verification
        Write-Host "[4/8] Running TypeScript verification (npm run typecheck)..." -ForegroundColor Cyan
        & npm run typecheck
        if ($LASTEXITCODE -ne 0) { throw "TYPECHECK_FAILED: TypeScript check failed." }

        # Step 5: Build Production Frontend
        Write-Host "[5/8] Building production frontend (npm run build)..." -ForegroundColor Cyan
        & npm run build
        if ($LASTEXITCODE -ne 0) { throw "VITE_BUILD_FAILED: Vite production build failed." }

        # Step 6: Read-Only Database Schema Preflight
        Write-Host "[6/8] Running Read-Only Database Preflight (npm run db:preflight)..." -ForegroundColor Cyan
        if (Test-Path $EnvFile) {
            $env:SAM_ATT_ENV_PATH = $EnvFile
        }
        & npm run db:preflight
        if ($LASTEXITCODE -ne 0) {
            throw "DATABASE_PREFLIGHT_FAILED: Database schema requires manual review before starting new release."
        }
    } finally {
        Pop-Location
    }

    # Step 7: Restart Only SamAttV2Standalone Service
    Write-Host "[7/8] Restarting Windows Service '$ServiceName'..." -ForegroundColor Cyan
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        throw "SERVICE_NOT_INSTALLED: Windows Service '$ServiceName' is not installed."
    }
    if ($svc.Status -eq "Running") {
        Stop-Service -Name $ServiceName -Force -ErrorAction Stop
        Start-Sleep -Seconds 3
    }
    Start-Service -Name $ServiceName -ErrorAction Stop
    Start-Sleep -Seconds 5

    # Step 8: Post-Deploy Strict HealthCheck (FIX 01 & FIX 03)
    Write-Host "[8/8] Verifying Strict Production Health Check..." -ForegroundColor Cyan
    $healthScript = Join-Path $AppDir "HealthCheck_Sam_Att.ps1"
    if (-not (Test-Path $healthScript)) {
        $healthScript = Join-Path $PSScriptRoot "HealthCheck_Sam_Att.ps1"
    }
    $hcParams = @{
        HostName    = $HostName
        Port        = $HttpsPort
        ServiceName = $ServiceName
        AppDir      = $AppDir
    }
    if (-not [string]::IsNullOrWhiteSpace($targetVersion)) { $hcParams["ExpectedVersion"] = $targetVersion }
    if (-not [string]::IsNullOrWhiteSpace($targetCommit)) { $hcParams["ExpectedCommit"] = $targetCommit }
    & $healthScript @hcParams
    if ($LASTEXITCODE -ne 0) {
        throw "POST_DEPLOY_HEALTHCHECK_FAILED: Strict Health check failed after service restart."
    }

    Write-Host "[PASS] Deployment completed and verified (Version=$targetVersion, Commit=$targetCommit)." -ForegroundColor Green
    exit 0
} catch {
    $errMsg = $_.Exception.Message
    Write-Host "[ERROR] Deployment failed: $errMsg" -ForegroundColor Red
    if ($null -ne $fullSnapshotDir -and (Test-Path $fullSnapshotDir)) {
        Write-Host "[ROLLBACK] Initiating automatic application rollback from $fullSnapshotDir..." -ForegroundColor Yellow
        $rollbackScript = Join-Path $AppDir "Rollback_Sam_Att.ps1"
        if (-not (Test-Path $rollbackScript)) {
            $rollbackScript = Join-Path $PSScriptRoot "Rollback_Sam_Att.ps1"
        }
        if (Test-Path $rollbackScript) {
            & $rollbackScript -SamAttRoot $SamAttRoot -BackupRootDir $BackupRootDir -DeploymentsDir $DeploymentsDir -SnapshotDir $fullSnapshotDir -ServiceName $ServiceName -HostName $HostName -HttpsPort $HttpsPort -LockFilePath $LockFilePath -ParentLockId $lockHandle.lockId
        }
    }
    exit 1
} finally {
    Release-AtomicLifecycleLock -Path $LockFilePath -LockHandle $lockHandle
}
