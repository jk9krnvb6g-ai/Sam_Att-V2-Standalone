<#
.SYNOPSIS
    Sam_Att V2 Standalone - Shared Atomic Lifecycle Lock Engine (scripts/LifecycleLock.ps1)
.DESCRIPTION
    Provides a race-free, OS-atomic file lock mechanism using [System.IO.File]::Open with
    [System.IO.FileMode]::CreateNew and [System.IO.FileShare]::Read so that concurrent
    Install, Deploy, Backup, Rollback, and Uninstall operations can never experience a
    Test-Path + Set-Content check-then-act race condition or an unsafe concurrent delete race.

    Hardened Safety Guarantees (TASK 3):
    1. True Atomic Acquisition: Uses [System.IO.FileMode]::CreateNew (O_CREAT | O_EXCL).
    2. Dual Parameter Binding: Accepts either -Path <lockFile> or -DeploymentsDir <dir>
       (resolving Join-Path $DeploymentsDir "lifecycle.lock").
    3. Unified Lock Handle Properties: Returns a PSCustomObject supporting both camelCase
       and PascalCase properties (acquiredNew / Acquired, reusedParent / ReusedParent,
       lockId / LockId, ownerPid / OwnerPid, ownerStartTimeUtc, operation / Operation,
       path / LockFile, dryRun / DryRun).
    4. Owner PID + Process StartTime Verification: Records ownerStartTimeUtc in the lock JSON
       and compares it against the live process StartTime.ToUniversalTime() to prevent PID reuse
       spoofing.
    5. Safe Stale Lock Recovery (Atomic Rename-to-Trash Tombstone):
       - Never deletes a lock file that is still being written (partial/corrupt JSON within
         a grace window of 5000 ms is treated as active/in-progress, never blindly deleted).
       - Once a lock is positively verified as stale (owner PID does not exist, or live process
         StartTime does not match recorded ownerStartTimeUtc), recovery re-reads the lock file
         to confirm the stale lockId is unchanged, then atomically moves/renames the file to
         "$Path.stale_$($existing.lockId)_$PID" BEFORE deleting the tombstone and retrying
         FileMode.CreateNew. This guarantees a recovering process can never delete a newly
         acquired lock created by another concurrent process.
    6. Strict Lock Ownership Verification on Release:
       - Releasing a child handle (ReusedParent = $true / acquiredNew = $false) is a safe no-op.
       - Releasing a primary handle verifies that the on-disk lock file still has the exact same
         lockId, pid, and ownerStartTimeUtc before atomically renaming and deleting it.
#>

function Get-ProcessStartTimeUtcIso {
    param([int]$TargetPid)
    if ($TargetPid -le 0) { return "" }
    try {
        $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
        if ($null -eq $proc) { return "" }
        if ($null -ne $proc.StartTime) {
            return $proc.StartTime.ToUniversalTime().ToString("o")
        }
        return "ALIVE_NO_STARTTIME"
    } catch {
        # Access denied on StartTime for elevated/system process means the process IS alive
        return "ALIVE_NO_STARTTIME"
    }
}

function Test-LockOwnerProcessAlive {
    param(
        [int]$OwnerPid,
        [string]$RecordedStartTimeUtc
    )
    if ($OwnerPid -le 0) { return $false }
    $proc = Get-Process -Id $OwnerPid -ErrorAction SilentlyContinue
    if ($null -eq $proc) {
        return $false
    }
    if (-not [string]::IsNullOrWhiteSpace($RecordedStartTimeUtc) -and $RecordedStartTimeUtc -ne "ALIVE_NO_STARTTIME") {
        try {
            if ($null -ne $proc.StartTime) {
                $liveUtc = $proc.StartTime.ToUniversalTime()
                $recUtc  = [DateTime]::Parse($RecordedStartTimeUtc).ToUniversalTime()
                $diffSec = [Math]::Abs(($liveUtc - $recUtc).TotalSeconds)
                # If the live process with the same PID started more than 2 seconds apart, PID was recycled
                if ($diffSec -gt 2.0) {
                    return $false
                }
            }
        } catch {
            # If StartTime cannot be read due to permissions, assume alive (fail-safe: do not delete)
            return $true
        }
    }
    return $true
}

function New-LifecycleLockHandleObject {
    param(
        [bool]$Acquired,
        [bool]$AcquiredNew,
        [bool]$ReusedParent,
        [string]$LockId,
        [int]$OwnerPid,
        [string]$OwnerStartTimeUtc,
        [string]$Operation,
        [string]$LockFilePath,
        [bool]$DryRun = $false
    )
    return [PSCustomObject]@{
        # PascalCase properties (used by CI & PowerShell callers)
        Acquired          = $Acquired
        AcquiredNew       = $AcquiredNew
        ReusedParent      = $ReusedParent
        LockId            = $LockId
        OwnerPid          = $OwnerPid
        OwnerStartTimeUtc = $OwnerStartTimeUtc
        Operation         = $Operation
        LockFile          = $LockFilePath
        Path              = $LockFilePath
        DryRun            = $DryRun
        # camelCase aliases
        acquired          = $Acquired
        acquiredNew       = $AcquiredNew
        reusedParent      = $ReusedParent
        lockId            = $LockId
        ownerPid          = $OwnerPid
        ownerStartTimeUtc = $OwnerStartTimeUtc
        operation         = $Operation
        path              = $LockFilePath
        lockFile          = $LockFilePath
        dryRun            = $DryRun
    }
}

function Read-LifecycleLockMetadataSafe {
    param([string]$LockFilePath)
    if (-not (Test-Path $LockFilePath)) {
        return @{ status = "MISSING"; data = $null }
    }
    try {
        $fsRead = [System.IO.File]::Open(
            $LockFilePath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::ReadWrite
        )
        $reader = New-Object System.IO.StreamReader($fsRead, [System.Text.Encoding]::UTF8)
        try {
            $raw = $reader.ReadToEnd()
        } finally {
            $reader.Dispose()
            $fsRead.Dispose()
        }
        if ([string]::IsNullOrWhiteSpace($raw)) {
            return @{ status = "PARTIAL_OR_CORRUPT"; data = $null }
        }
        $parsed = $raw | ConvertFrom-Json
        if ($null -eq $parsed -or [string]::IsNullOrWhiteSpace([string]$parsed.lockId) -or $null -eq $parsed.pid) {
            return @{ status = "PARTIAL_OR_CORRUPT"; data = $null }
        }
        return @{ status = "VALID"; data = $parsed }
    } catch {
        if (-not (Test-Path $LockFilePath)) {
            return @{ status = "MISSING"; data = $null }
        }
        return @{ status = "PARTIAL_OR_CORRUPT"; data = $null }
    }
}

function Acquire-AtomicLifecycleLock {
    [CmdletBinding()]
    param(
        [string]$Path = "",
        [string]$DeploymentsDir = "",
        [Parameter(Mandatory = $true)][string]$Operation,
        [string]$InheritedLockId = "",
        [int]$CorruptLockMaxAgeMs = 5000
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        if (-not [string]::IsNullOrWhiteSpace($DeploymentsDir)) {
            $Path = Join-Path $DeploymentsDir "lifecycle.lock"
        } else {
            throw "LIFECYCLE_LOCK_PATH_MISSING: Must specify either -Path or -DeploymentsDir."
        }
    }

    $lockDir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($lockDir) -and -not (Test-Path $lockDir)) {
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    }

    $selfStartTimeUtc = Get-ProcessStartTimeUtcIso -TargetPid $PID
    $newLockId = "$Operation-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmssfff'))-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    $payloadObj = [ordered]@{
        lockId            = $newLockId
        operation         = $Operation
        pid               = $PID
        ownerStartTimeUtc = $selfStartTimeUtc
        startedAt         = (Get-Date).ToUniversalTime().ToString("o")
        user              = [Environment]::UserName
    }
    $jsonBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($payloadObj | ConvertTo-Json -Depth 4))

    for ($attempt = 1; $attempt -le 3; $attempt++) {
        # 1. Attempt OS-atomic exclusive creation first (FileMode.CreateNew)
        $fs = $null
        try {
            $fs = [System.IO.File]::Open(
                $Path,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::Read
            )
            $fs.Write($jsonBytes, 0, $jsonBytes.Length)
            $fs.Flush($true)
            $fs.Close()
            $fs.Dispose()
            $fs = $null

            return New-LifecycleLockHandleObject `
                -Acquired $true `
                -AcquiredNew $true `
                -ReusedParent $false `
                -LockId $newLockId `
                -OwnerPid $PID `
                -OwnerStartTimeUtc $selfStartTimeUtc `
                -Operation $Operation `
                -LockFilePath $Path
        } catch [System.IO.IOException] {
            if ($null -ne $fs) {
                try { $fs.Dispose() } catch {}
            }

            # 2. File already exists -> Inspect lock metadata safely
            $meta = Read-LifecycleLockMetadataSafe -LockFilePath $Path
            if ($meta.status -eq "MISSING") {
                continue
            }

            if ($meta.status -eq "PARTIAL_OR_CORRUPT") {
                # Wait briefly in case the winning process is currently flushing JSON bytes
                Start-Sleep -Milliseconds 60
                $meta = Read-LifecycleLockMetadataSafe -LockFilePath $Path
                if ($meta.status -eq "MISSING") {
                    continue
                }
            }

            if ($meta.status -eq "PARTIAL_OR_CORRUPT") {
                # Check file age before deciding whether it is an abandoned corrupt file
                $ageMs = 0
                try {
                    $fi = Get-Item -LiteralPath $Path -ErrorAction Stop
                    $ageMs = ((Get-Date).ToUniversalTime() - $fi.LastWriteTimeUtc).TotalMilliseconds
                } catch {
                    $ageMs = 0
                }
                if ($ageMs -lt $CorruptLockMaxAgeMs) {
                    throw "LIFECYCLE_LOCK_ACTIVE: Lock file '$Path' is currently being initialized or held by another active process (age=$([Math]::Round($ageMs))ms)."
                }
                # File is older than CorruptLockMaxAgeMs and still corrupt -> isolate via atomic move
                $corruptTrash = "$Path.corrupt_$PID`_$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
                try {
                    [System.IO.File]::Move($Path, $corruptTrash)
                    Remove-Item -LiteralPath $corruptTrash -Force -ErrorAction SilentlyContinue
                } catch {
                    # Another process already rotated or replaced it
                }
                continue
            }

            # 3. Valid JSON metadata found
            $existing = $meta.data
            $existingLockId = [string]$existing.lockId
            $existingOp     = [string]$existing.operation
            $existingStart  = [string]$existing.ownerStartTimeUtc
            $ownerPid       = 0
            [void][int]::TryParse([string]$existing.pid, [ref]$ownerPid)

            $isOwnerAlive = Test-LockOwnerProcessAlive -OwnerPid $ownerPid -RecordedStartTimeUtc $existingStart

            # Check ParentLockId / InheritedLockId reuse
            if (-not [string]::IsNullOrWhiteSpace($InheritedLockId) -and $existingLockId -eq $InheritedLockId) {
                if (-not $isOwnerAlive) {
                    throw "LIFECYCLE_PARENT_LOCK_STALE: Parent lock '$InheritedLockId' (PID=$ownerPid) is no longer alive."
                }
                return New-LifecycleLockHandleObject `
                    -Acquired $true `
                    -AcquiredNew $false `
                    -ReusedParent $true `
                    -LockId $InheritedLockId `
                    -OwnerPid $ownerPid `
                    -OwnerStartTimeUtc $existingStart `
                    -Operation $existingOp `
                    -LockFilePath $Path
            }

            if ($isOwnerAlive) {
                throw "LIFECYCLE_LOCK_ACTIVE: Another lifecycle operation ($existingOp, lockId=$existingLockId, PID=$ownerPid) is currently running since $($existing.startedAt)."
            }

            # 4. Positively verified stale lock (owner process is dead or PID was recycled)
            # Re-verify that the on-disk lock file STILL contains the exact same stale lockId before moving
            $recheck = Read-LifecycleLockMetadataSafe -LockFilePath $Path
            if ($recheck.status -eq "VALID" -and [string]$recheck.data.lockId -eq $existingLockId) {
                $staleTrash = "$Path.stale_$($existingLockId)_$PID`_$([Guid]::NewGuid().ToString('N').Substring(0, 6))"
                try {
                    # Atomic rename ensures only ONE recovering process can claim cleanup of this stale file,
                    # and never deletes a fresh lock created by another process!
                    [System.IO.File]::Move($Path, $staleTrash)
                    Remove-Item -LiteralPath $staleTrash -Force -ErrorAction SilentlyContinue
                } catch {
                    # Another process beat us to moving the stale lock; retry acquisition in next loop iteration
                }
                continue
            }
        }
    }

    throw "LIFECYCLE_LOCK_ACTIVE: Cannot acquire atomic lifecycle lock at '$Path' after retry."
}

function Release-AtomicLifecycleLock {
    [CmdletBinding()]
    param(
        [string]$Path = "",
        [Parameter(Mandatory = $true)]$LockHandle
    )

    if ($null -eq $LockHandle) {
        return
    }

    # Resolve DryRun / ReusedParent / AcquiredNew flags safely across PSCustomObject or Hashtable
    $isDryRun = $false
    $isReusedParent = $false
    $isAcquired = $false
    $handleLockId = ""
    $handlePid = 0
    $handleStartUtc = ""

    if ($LockHandle -is [hashtable]) {
        if ($LockHandle.ContainsKey("DryRun")) { $isDryRun = [bool]$LockHandle["DryRun"] }
        elseif ($LockHandle.ContainsKey("dryRun")) { $isDryRun = [bool]$LockHandle["dryRun"] }

        if ($LockHandle.ContainsKey("ReusedParent")) { $isReusedParent = [bool]$LockHandle["ReusedParent"] }
        elseif ($LockHandle.ContainsKey("reusedParent")) { $isReusedParent = [bool]$LockHandle["reusedParent"] }

        if ($LockHandle.ContainsKey("AcquiredNew")) { $isAcquired = [bool]$LockHandle["AcquiredNew"] }
        elseif ($LockHandle.ContainsKey("acquiredNew")) { $isAcquired = [bool]$LockHandle["acquiredNew"] }
        elseif ($LockHandle.ContainsKey("Acquired")) { $isAcquired = [bool]$LockHandle["Acquired"] -and (-not $isReusedParent) }

        if ($LockHandle.ContainsKey("LockId")) { $handleLockId = [string]$LockHandle["LockId"] }
        elseif ($LockHandle.ContainsKey("lockId")) { $handleLockId = [string]$LockHandle["lockId"] }

        if ($LockHandle.ContainsKey("OwnerPid")) { $handlePid = [int]$LockHandle["OwnerPid"] }
        elseif ($LockHandle.ContainsKey("ownerPid")) { $handlePid = [int]$LockHandle["ownerPid"] }

        if ($LockHandle.ContainsKey("OwnerStartTimeUtc")) { $handleStartUtc = [string]$LockHandle["OwnerStartTimeUtc"] }
        elseif ($LockHandle.ContainsKey("ownerStartTimeUtc")) { $handleStartUtc = [string]$LockHandle["ownerStartTimeUtc"] }

        if ([string]::IsNullOrWhiteSpace($Path)) {
            if ($LockHandle.ContainsKey("LockFile")) { $Path = [string]$LockHandle["LockFile"] }
            elseif ($LockHandle.ContainsKey("Path")) { $Path = [string]$LockHandle["Path"] }
            elseif ($LockHandle.ContainsKey("path")) { $Path = [string]$LockHandle["path"] }
        }
    } else {
        if ($null -ne $LockHandle.PSObject.Properties["DryRun"]) { $isDryRun = [bool]$LockHandle.DryRun }
        if ($null -ne $LockHandle.PSObject.Properties["ReusedParent"]) { $isReusedParent = [bool]$LockHandle.ReusedParent }
        if ($null -ne $LockHandle.PSObject.Properties["AcquiredNew"]) {
            $isAcquired = [bool]$LockHandle.AcquiredNew
        } elseif ($null -ne $LockHandle.PSObject.Properties["Acquired"]) {
            $isAcquired = ([bool]$LockHandle.Acquired) -and (-not $isReusedParent)
        }
        if ($null -ne $LockHandle.PSObject.Properties["LockId"]) { $handleLockId = [string]$LockHandle.LockId }
        if ($null -ne $LockHandle.PSObject.Properties["OwnerPid"]) { $handlePid = [int]$LockHandle.OwnerPid }
        if ($null -ne $LockHandle.PSObject.Properties["OwnerStartTimeUtc"]) { $handleStartUtc = [string]$LockHandle.OwnerStartTimeUtc }
        if ([string]::IsNullOrWhiteSpace($Path)) {
            if ($null -ne $LockHandle.PSObject.Properties["LockFile"] -and -not [string]::IsNullOrWhiteSpace([string]$LockHandle.LockFile)) {
                $Path = [string]$LockHandle.LockFile
            } elseif ($null -ne $LockHandle.PSObject.Properties["Path"] -and -not [string]::IsNullOrWhiteSpace([string]$LockHandle.Path)) {
                $Path = [string]$LockHandle.Path
            }
        }
    }

    if ($isDryRun -or $isReusedParent -or (-not $isAcquired)) {
        return
    }
    if ([string]::IsNullOrWhiteSpace($Path) -or (-not (Test-Path $Path))) {
        return
    }

    try {
        $meta = Read-LifecycleLockMetadataSafe -LockFilePath $Path
        if ($meta.status -ne "VALID") {
            # Never blindly delete a lock file whose ownership cannot be positively verified
            return
        }
        $current = $meta.data
        $onDiskLockId = [string]$current.lockId
        $onDiskPid    = 0
        [void][int]::TryParse([string]$current.pid, [ref]$onDiskPid)
        $onDiskStart  = [string]$current.ownerStartTimeUtc

        if ($onDiskLockId -ne $handleLockId -or $onDiskPid -ne $handlePid) {
            return
        }
        if (-not [string]::IsNullOrWhiteSpace($handleStartUtc) -and -not [string]::IsNullOrWhiteSpace($onDiskStart)) {
            if ($onDiskStart -ne $handleStartUtc) {
                return
            }
        }

        $releaseTrash = "$Path.rel_$($handleLockId)_$PID"
        [System.IO.File]::Move($Path, $releaseTrash)
        Remove-Item -LiteralPath $releaseTrash -Force -ErrorAction SilentlyContinue
    } catch {
        # Ignore cleanup errors if already released
    }
}
