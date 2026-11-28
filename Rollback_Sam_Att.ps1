<#
.SYNOPSIS
    Sam_Att V2 Standalone - Safe Application-Only Rollback Utility (Pre-Stop SHA-256 Integrity Verification)
.DESCRIPTION
    Restores Sam_Att V2 Standalone application files from a verified snapshot in D:\Backups\Sam_Att:
    1. Acquires Shared Lifecycle Lock (D:\Deployments\Sam_Att\lifecycle.lock).
    2. Selects requested snapshot, Last Known Good Release (last_known_good.json), or latest valid snapshot.
    3. VERIFIES snapshot completeness, backup-manifest.json.sha256, and EVERY file's SHA-256 hash
       against backup-manifest.json BEFORE stopping SamAttV2Standalone service (FIX 05).
       - If any file is missing or any SHA-256 hash mismatches, aborts immediately before stopping service.
    4. Stops ONLY SamAttV2Standalone service (never kills global node.exe, never touches IIS).
    5. Restores application files to D:\WebApps\Sam_Att\App while strictly preserving
       D:\WebApps\Sam_Att\Config\.env and D:\WebApps\Sam_Att\Certs.
    6. NEVER restores or modifies any database.
    7. Starts SamAttV2Standalone and runs strict HealthCheck_Sam_Att.ps1.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupRootDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [string]$SnapshotDir = "",
    [string]$ServiceName = "SamAttV2Standalone",
    [string]$HostName = "10.2.0.23",
    [int]$HttpsPort = 4101,
    [string]$LockFilePath = "",
    [string]$ParentLockId = "",
    [switch]$UseLastKnownGood,
    [switch]$DryRun,
    [switch]$SkipServiceRestart
)

$ErrorActionPreference = "Stop"

$AppDir    = Join-Path $SamAttRoot "App"
$ConfigDir = Join-Path $SamAttRoot "Config"
$CertsDir  = Join-Path $SamAttRoot "Certs"
if ([string]::IsNullOrWhiteSpace($LockFilePath)) {
    $LockFilePath = Join-Path $DeploymentsDir "lifecycle.lock"
}
$isDryRunMode = ($DryRun -or $WhatIfPreference)

function Test-SnapshotIntegrityBeforeStop {
    param([string]$TargetSnapshotDir)

    if (-not (Test-Path $TargetSnapshotDir)) {
        throw "SNAPSHOT_NOT_FOUND: Snapshot directory $TargetSnapshotDir does not exist."
    }
    $appSnapDir = Join-Path $TargetSnapshotDir "AppSnapshot"
    $manifestPath = Join-Path $TargetSnapshotDir "backup-manifest.json"
    $manifestShaFile = "$manifestPath.sha256"

    if (-not (Test-Path $appSnapDir)) {
        throw "INVALID_SNAPSHOT: Missing AppSnapshot directory in $TargetSnapshotDir"
    }
    if (-not (Test-Path $manifestPath)) {
        throw "INVALID_SNAPSHOT_MANIFEST: Missing backup-manifest.json in $TargetSnapshotDir"
    }
    if (-not (Test-Path $manifestShaFile)) {
        throw "INVALID_SNAPSHOT_CHECKSUM: Missing backup-manifest.json.sha256 in $TargetSnapshotDir"
    }

    $expectedManifestHash = (Get-Content $manifestShaFile -Raw).Trim()
    $actualManifestHash = (Get-FileHash -Path $manifestPath -Algorithm SHA256).Hash
    if ($expectedManifestHash -ne $actualManifestHash) {
        throw "SNAPSHOT_MANIFEST_CHECKSUM_MISMATCH: Snapshot manifest hash mismatch (expected $expectedManifestHash, got $actualManifestHash)."
    }

    $manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json

    # Verify core required files exist in snapshot
    $coreRequired = @("package.json", "server.ts")
    foreach ($reqRel in $coreRequired) {
        $fullReq = Join-Path $appSnapDir ($reqRel.Replace('/', '\'))
        if (-not (Test-Path $fullReq)) {
            throw "SNAPSHOT_INCOMPLETE: Missing required core file '$reqRel' in $appSnapDir"
        }
    }

    if ($null -eq $manifest.files -or $manifest.files.Count -eq 0) {
        throw "SNAPSHOT_MANIFEST_FILES_EMPTY: backup-manifest.json does not contain a valid 'files' SHA-256 manifest array."
    }

    if ($manifest.requiredFilesCount -and ($manifest.files.Count -ne [int]$manifest.requiredFilesCount)) {
        throw "SNAPSHOT_FILE_COUNT_MISMATCH: Manifest declares requiredFilesCount=$($manifest.requiredFilesCount) but lists $($manifest.files.Count) files."
    }

    $verifiedCount = 0
    foreach ($entry in $manifest.files) {
        $rel = [string]$entry.relativePath
        $expectedSha = [string]$entry.sha256
        if ([string]::IsNullOrWhiteSpace($rel) -or [string]::IsNullOrWhiteSpace($expectedSha)) {
            throw "SNAPSHOT_MANIFEST_CORRUPT_ENTRY: File entry in backup-manifest.json is missing relativePath or sha256."
        }
        $candidatePath = Join-Path $appSnapDir ($rel.Replace('/', '\'))
        if (-not (Test-Path $candidatePath)) {
            throw "SNAPSHOT_FILE_MISSING: Required file '$rel' listed in manifest is missing from $appSnapDir."
        }
        $actualSha = (Get-FileHash -Path $candidatePath -Algorithm SHA256).Hash
        if (-not $actualSha.Equals($expectedSha, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "SNAPSHOT_FILE_HASH_MISMATCH: File '$rel' failed SHA-256 verification (expected $expectedSha, got $actualSha)."
        }
        $verifiedCount++
    }

    return @{
        manifest      = $manifest
        appSnapDir    = $appSnapDir
        verifiedFiles = $verifiedCount
    }
}

# Resolve target snapshot directory
if ([string]::IsNullOrWhiteSpace($SnapshotDir)) {
    $lkgPath = Join-Path $BackupRootDir "last_known_good.json"
    if ($UseLastKnownGood -and (Test-Path $lkgPath)) {
        $lkg = Get-Content $lkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($lkg.snapshotDir -and (Test-Path $lkg.snapshotDir)) {
            $SnapshotDir = [string]$lkg.snapshotDir
        }
    }
    if ([string]::IsNullOrWhiteSpace($SnapshotDir)) {
        if (-not (Test-Path $BackupRootDir)) {
            throw "BACKUP_ROOT_NOT_FOUND: $BackupRootDir does not exist."
        }
        $latest = Get-ChildItem -Path $BackupRootDir -Directory -Filter "app_snapshot_*" | Sort-Object CreationTime -Descending | Select-Object -First 1
        if ($null -eq $latest) {
            throw "NO_SNAPSHOTS_AVAILABLE: No application snapshots found in $BackupRootDir"
        }
        $SnapshotDir = $latest.FullName
    }
}

# Verify snapshot integrity BEFORE acquiring lock or stopping service in DryRun, and before stopping service in real run
$verifiedSnapshot = Test-SnapshotIntegrityBeforeStop -TargetSnapshotDir $SnapshotDir
$manifest = $verifiedSnapshot.manifest
$appSnapDir = $verifiedSnapshot.appSnapDir

if ($isDryRunMode) {
    Write-Host "[DRY-RUN] Verified snapshot integrity ($($verifiedSnapshot.verifiedFiles) files SHA-256 matched) for $SnapshotDir (Version=$($manifest.version), Commit=$($manifest.commitHash)). Would restore to $AppDir without modifying Config\.env, Certs, or MySQL database." -ForegroundColor Yellow
    exit 0
}

$lifecycleLockModule = Join-Path $PSScriptRoot "scripts\LifecycleLock.ps1"
if (-not (Test-Path $lifecycleLockModule)) {
    $lifecycleLockModule = Join-Path $AppDir "scripts\LifecycleLock.ps1"
}
if (-not (Test-Path $lifecycleLockModule)) {
    throw "LIFECYCLE_LOCK_ENGINE_MISSING: Could not find scripts\LifecycleLock.ps1"
}
. $lifecycleLockModule

$lockHandle = Acquire-AtomicLifecycleLock -Path $LockFilePath -Operation "ROLLBACK" -InheritedLockId $ParentLockId

try {
    Write-Host "=================================================================" -ForegroundColor Yellow
    Write-Host " Sam_Att V2 Standalone - Application-Only Rollback" -ForegroundColor Yellow
    Write-Host " Snapshot : $SnapshotDir" -ForegroundColor Yellow
    Write-Host " Version  : $($manifest.version) (Commit: $($manifest.commitHash))" -ForegroundColor Yellow
    Write-Host " Verified : $($verifiedSnapshot.verifiedFiles) files passed SHA-256 integrity check" -ForegroundColor Green
    Write-Host "=================================================================" -ForegroundColor Yellow

    $envFilePath = Join-Path $ConfigDir ".env"
    $envPreHash = if (Test-Path $envFilePath) { (Get-FileHash -Path $envFilePath -Algorithm SHA256).Hash } else { $null }

    # 1. Stop only SamAttV2Standalone Service (ONLY AFTER 100% SHA-256 snapshot verification passed)
    if (-not $SkipServiceRestart) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $svc -and $svc.Status -eq "Running") {
            Write-Host "[1/4] Stopping Windows Service '$ServiceName'..." -ForegroundColor Cyan
            Stop-Service -Name $ServiceName -Force -ErrorAction Stop
            Start-Sleep -Seconds 3
        } else {
            Write-Host "[1/4] Windows Service '$ServiceName' is not running." -ForegroundColor Gray
        }
    }

    # 2. Restore application files to AppDir (preserve node_modules and .git, never touch Config\.env or Certs)
    Write-Host "[2/4] Restoring verified application files to $AppDir..." -ForegroundColor Cyan
    if (-not (Test-Path $AppDir)) {
        New-Item -ItemType Directory -Path $AppDir -Force | Out-Null
    }
    $roboArgs = @(
        $appSnapDir,
        $AppDir,
        "/MIR",
        "/XD", "node_modules", ".git", "logs",
        "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"
    )
    & robocopy @roboArgs | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "ROLLBACK_ROBOCOPY_FAILED: Robocopy failed with exit code $LASTEXITCODE"
    }

    # Verify Config\.env was not altered during rollback
    if ($null -ne $envPreHash -and (Test-Path $envFilePath)) {
        $envPostHash = (Get-FileHash -Path $envFilePath -Algorithm SHA256).Hash
        if ($envPreHash -ne $envPostHash) {
            throw "CONFIG_ENV_MUTATION_DETECTED: Production Config\.env hash changed unexpectedly during rollback."
        }
    }

    # 3. Start SamAttV2Standalone Service
    if (-not $SkipServiceRestart) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -ne $svc) {
            Write-Host "[3/4] Starting Windows Service '$ServiceName'..." -ForegroundColor Cyan
            Start-Service -Name $ServiceName -ErrorAction Stop
            Start-Sleep -Seconds 5
        }
    }

    # 4. Run Strict Production HealthCheck
    $healthScript = Join-Path $PSScriptRoot "HealthCheck_Sam_Att.ps1"
    if (-not (Test-Path $healthScript)) {
        $healthScript = Join-Path $AppDir "HealthCheck_Sam_Att.ps1"
    }
    if ((Test-Path $healthScript) -and -not $SkipServiceRestart) {
        Write-Host "[4/4] Verifying strict system health after rollback..." -ForegroundColor Cyan
        $hcParams = @{
            HostName    = $HostName
            Port        = $HttpsPort
            ServiceName = $ServiceName
            AppDir      = $AppDir
        }
        if ($manifest.version) { $hcParams["ExpectedVersion"] = [string]$manifest.version }
        if ($manifest.commitHash -and $manifest.commitHash -ne "unknown") { $hcParams["ExpectedCommit"] = [string]$manifest.commitHash }
        & $healthScript @hcParams
        if ($LASTEXITCODE -ne 0) {
            throw "ROLLBACK_HEALTHCHECK_FAILED: Health check failed after restoring snapshot $SnapshotDir"
        }
    }

    Write-Host "[PASS] Application rollback completed safely. Database, Config\.env, and Certs were not modified." -ForegroundColor Green
    exit 0
} finally {
    Release-AtomicLifecycleLock -Path $LockFilePath -LockHandle $lockHandle
}
