<#
.SYNOPSIS
    Sam_Att V2 Standalone - Application Snapshot Backup Utility (Strict SHA-256 File Manifest & Shared Lifecycle Lock)
.DESCRIPTION
    Creates a timestamped application snapshot in D:\Backups\Sam_Att\app_snapshot_<yyyyMMdd_HHmmss>:
    - Acquires Shared Lifecycle Lock (D:\Deployments\Sam_Att\lifecycle.lock) so Install, Deploy,
      Backup, and Rollback never run concurrently (supports -ParentLockId when called by Deploy_Sam_Att.ps1).
    - Snapshots App source & compiled dist/, Config/.env, and Service/SamAttV2Standalone.xml.
    - Generates a complete SHA-256 File Manifest (files array with relativePath, sizeBytes, sha256)
      covering all required application files in AppSnapshot, plus backup-manifest.json.sha256.
    - Updates D:\Backups\Sam_Att\last_known_good.json pointer when -MarkAsLastKnownGood is specified (default true).
    - NEVER runs mysqldump or modifies any database.
    - Supports -WhatIf / -DryRun with zero disk or lock modifications.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupRootDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [string]$LockFilePath = "",
    [string]$ParentLockId = "",
    [int]$RetentionCount = 10,
    [switch]$MarkAsLastKnownGood = $true,
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$AppDir     = Join-Path $SamAttRoot "App"
$ConfigDir  = Join-Path $SamAttRoot "Config"
$ServiceDir = Join-Path $SamAttRoot "Service"
if ([string]::IsNullOrWhiteSpace($LockFilePath)) {
    $LockFilePath = Join-Path $DeploymentsDir "lifecycle.lock"
}

$isDryRunMode = ($DryRun -or $WhatIfPreference)
$timestamp = (Get-Date).ToString("yyyyMMdd_HHmmss")
$snapshotName = "app_snapshot_$timestamp"
$snapshotDir = Join-Path $BackupRootDir $snapshotName

if ($isDryRunMode) {
    $dryReport = @{
        ok            = $true
        dryRun        = $true
        snapshotName  = $snapshotName
        snapshotDir   = $snapshotDir
        lockFilePath  = $LockFilePath
        message       = "DryRun/WhatIf: Would create application snapshot at $snapshotDir with full SHA-256 file manifest without touching disk or lock files."
    }
    if ($Json) {
        Write-Output ($dryReport | ConvertTo-Json -Depth 5)
    } else {
        Write-Host "[DRY-RUN] $($dryReport.message)" -ForegroundColor Yellow
    }
    exit 0
}

function Acquire-SharedLifecycleLock {
    param([string]$Path, [string]$Operation, [string]$InheritedLockId)
    $lockDir = Split-Path -Parent $Path
    if (-not (Test-Path $lockDir)) {
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    }
    if (Test-Path $Path) {
        try {
            $existing = Get-Content $Path -Raw -Encoding UTF8 | ConvertFrom-Json
            if (-not [string]::IsNullOrWhiteSpace($InheritedLockId) -and $existing.lockId -eq $InheritedLockId) {
                return @{ acquiredNew = $false; lockId = $InheritedLockId }
            }
            $ownerPid = [int]$existing.pid
            $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
            if ($null -ne $proc) {
                throw "LIFECYCLE_LOCK_ACTIVE: Another lifecycle operation ($($existing.operation), lockId=$($existing.lockId), PID=$ownerPid) is currently running since $($existing.startedAt)."
            }
        } catch {
            if ($_.Exception.Message -like "LIFECYCLE_LOCK_ACTIVE*") {
                throw $_
            }
        }
        Remove-Item $Path -Force -ErrorAction SilentlyContinue
    }
    $newLockId = "$Operation-$((Get-Date).ToString('yyyyMMddHHmmss'))-$PID"
    $payload = @{
        lockId    = $newLockId
        operation = $Operation
        pid       = $PID
        startedAt = (Get-Date).ToString("o")
        user      = [Environment]::UserName
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -Path $Path -Encoding UTF8
    return @{ acquiredNew = $true; lockId = $newLockId }
}

function Release-SharedLifecycleLock {
    param([string]$Path, [hashtable]$LockHandle)
    if ($null -ne $LockHandle -and $LockHandle.acquiredNew -and (Test-Path $Path)) {
        Remove-Item $Path -Force -ErrorAction SilentlyContinue
    }
}

$lockHandle = Acquire-SharedLifecycleLock -Path $LockFilePath -Operation "BACKUP" -InheritedLockId $ParentLockId

try {
    if (-not (Test-Path $AppDir)) {
        throw "APP_DIR_NOT_FOUND: Application directory $AppDir does not exist."
    }
    $requiredCorePaths = @(
        (Join-Path $AppDir "package.json"),
        (Join-Path $AppDir "server.ts")
    )
    foreach ($reqPath in $requiredCorePaths) {
        if (-not (Test-Path $reqPath)) {
            throw "MISSING_REQUIRED_APP_FILE: Required application file not found at $reqPath"
        }
    }

    if (-not (Test-Path $BackupRootDir)) {
        New-Item -ItemType Directory -Path $BackupRootDir -Force | Out-Null
    }
    New-Item -ItemType Directory -Path $snapshotDir -Force | Out-Null

    $appSnapDir     = Join-Path $snapshotDir "AppSnapshot"
    $configSnapDir  = Join-Path $snapshotDir "ConfigSnapshot"
    $serviceSnapDir = Join-Path $snapshotDir "ServiceSnapshot"

    New-Item -ItemType Directory -Path $appSnapDir -Force | Out-Null
    New-Item -ItemType Directory -Path $configSnapDir -Force | Out-Null
    New-Item -ItemType Directory -Path $serviceSnapDir -Force | Out-Null

    # Copy application code & compiled dist (exclude node_modules and .git for clean fast snapshots)
    $roboArgs = @(
        $AppDir,
        $appSnapDir,
        "/MIR",
        "/XD", "node_modules", ".git", "logs",
        "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"
    )
    & robocopy @roboArgs | Out-Null
    if ($LASTEXITCODE -ge 8) {
        throw "BACKUP_ROBOCOPY_FAILED: Robocopy failed with exit code $LASTEXITCODE"
    }

    $envPath = Join-Path $ConfigDir ".env"
    if (Test-Path $envPath) {
        Copy-Item -Path $envPath -Destination (Join-Path $configSnapDir ".env.backup") -Force
    }

    $xmlPath = Join-Path $ServiceDir "SamAttV2Standalone.xml"
    if (Test-Path $xmlPath) {
        Copy-Item -Path $xmlPath -Destination (Join-Path $serviceSnapDir "SamAttV2Standalone.xml") -Force
    }

    $commitHash = "unknown"
    if (Test-Path (Join-Path $AppDir ".git")) {
        try {
            $gitOut = & git -C $AppDir rev-parse HEAD 2>$null
            if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($gitOut)) {
                $commitHash = ($gitOut | Select-Object -First 1).Trim()
            }
        } catch {}
    }

    $pkgVersion = "2.0.0"
    $pkgPath = Join-Path $AppDir "package.json"
    if (Test-Path $pkgPath) {
        try {
            $pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($pkg.version) { $pkgVersion = [string]$pkg.version }
        } catch {}
    }

    # Generate full SHA-256 File Manifest for every file in AppSnapshot (FIX 05)
    $allSnapshotFiles = Get-ChildItem -Path $appSnapDir -Recurse -File | Sort-Object FullName
    if ($allSnapshotFiles.Count -eq 0) {
        throw "EMPTY_APP_SNAPSHOT: No application files were copied to $appSnapDir"
    }

    $normalizedRoot = (Resolve-Path $appSnapDir).Path.TrimEnd('\', '/')
    $fileManifestList = @()
    foreach ($fileItem in $allSnapshotFiles) {
        $relPath = $fileItem.FullName.Substring($normalizedRoot.Length).TrimStart('\', '/').Replace('\', '/')
        $hashVal = (Get-FileHash -Path $fileItem.FullName -Algorithm SHA256).Hash
        $fileManifestList += @{
            relativePath = $relPath
            sizeBytes    = [int64]$fileItem.Length
            sha256       = $hashVal
        }
    }

    $envBackupPath = Join-Path $configSnapDir ".env.backup"
    $envSha256 = if (Test-Path $envBackupPath) { (Get-FileHash -Path $envBackupPath -Algorithm SHA256).Hash } else { $null }

    $manifest = @{
        snapshotName       = $snapshotName
        createdAt          = (Get-Date).ToString("o")
        samAttRoot         = $SamAttRoot
        appDir             = $AppDir
        version            = $pkgVersion
        commitHash         = $commitHash
        databaseTouched    = $false
        requiredFilesCount = $fileManifestList.Count
        envBackupSha256    = $envSha256
        files              = $fileManifestList
    }
    $manifestPath = Join-Path $snapshotDir "backup-manifest.json"
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -Path $manifestPath -Encoding UTF8

    $manifestHash = (Get-FileHash -Path $manifestPath -Algorithm SHA256).Hash
    Set-Content -Path "$manifestPath.sha256" -Value $manifestHash -Encoding ASCII

    # Update Last Known Good Release pointer (FIX 05)
    if ($MarkAsLastKnownGood) {
        $lkgPath = Join-Path $BackupRootDir "last_known_good.json"
        $lkgPayload = @{
            snapshotName       = $snapshotName
            snapshotDir        = $snapshotDir
            version            = $pkgVersion
            commitHash         = $commitHash
            manifestSha256     = $manifestHash
            requiredFilesCount = $fileManifestList.Count
            updatedAt          = (Get-Date).ToString("o")
        }
        $lkgPayload | ConvertTo-Json -Depth 4 | Set-Content -Path $lkgPath -Encoding UTF8
    }

    # Prune old snapshots beyond RetentionCount
    $allSnapshots = Get-ChildItem -Path $BackupRootDir -Directory -Filter "app_snapshot_*" | Sort-Object CreationTime -Descending
    if ($allSnapshots.Count -gt $RetentionCount) {
        $toRemove = $allSnapshots | Select-Object -Skip $RetentionCount
        foreach ($old in $toRemove) {
            Remove-Item -Path $old.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    if ($Json) {
        Write-Output ($manifest | ConvertTo-Json -Depth 6)
    } else {
        Write-Host "[OK] Created Application Snapshot: $snapshotDir (Version=$pkgVersion, Commit=$commitHash, Files=$($fileManifestList.Count), ManifestSHA256=$manifestHash)" -ForegroundColor Green
    }
    exit 0
} finally {
    Release-SharedLifecycleLock -Path $LockFilePath -LockHandle $lockHandle
}
