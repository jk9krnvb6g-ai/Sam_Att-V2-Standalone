<#
.SYNOPSIS
    Sam_Att V2 Standalone - Shared Atomic Lifecycle Lock Engine (scripts/LifecycleLock.ps1)
.DESCRIPTION
    Provides an OS-atomic file lock mechanism using [System.IO.File]::Open with
    [System.IO.FileMode]::CreateNew and [System.IO.FileShare]::Read so that concurrent
    Install, Deploy, Backup, Rollback, and Uninstall operations can never experience a
    Test-Path + Set-Content check-then-act race condition (FIX 02).

    Features:
    - True atomic creation via FileMode.CreateNew (only one process can win the OS kernel open).
    - Supports -InheritedLockId (ParentLockId) when a parent lifecycle script (e.g. Deploy_Sam_Att.ps1)
      invokes a child script (e.g. Backup_Sam_Att.ps1 or Rollback_Sam_Att.ps1) by verifying that
      the existing lock file's lockId matches InheritedLockId and its owning PID is alive.
    - Detects and safely cleans up stale locks from crashed PIDs before retrying FileMode.CreateNew.
    - Verifies exact Lock Ownership (lockId + PID) before releasing/deleting the lock file.
#>

function Acquire-AtomicLifecycleLock {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Operation,
        [string]$InheritedLockId = ""
    )

    $lockDir = Split-Path -Parent $Path
    if (-not [string]::IsNullOrWhiteSpace($lockDir) -and -not (Test-Path $lockDir)) {
        New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    }

    # 1. If a ParentLockId / InheritedLockId is supplied, verify the parent holds the lock
    if (-not [string]::IsNullOrWhiteSpace($InheritedLockId) -and (Test-Path $Path)) {
        try {
            $existingRaw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
            $existing = $existingRaw | ConvertFrom-Json
            if ($null -ne $existing -and [string]$existing.lockId -eq $InheritedLockId) {
                return @{
                    acquiredNew = $false
                    lockId      = $InheritedLockId
                    ownerPid    = [int]$existing.pid
                    operation   = [string]$existing.operation
                    path        = $Path
                }
            }
        } catch {
            # fall through to atomic acquisition attempt
        }
    }

    $newLockId = "$Operation-$((Get-Date).ToString('yyyyMMddHHmmssfff'))-$PID-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    $payloadObj = [ordered]@{
        lockId    = $newLockId
        operation = $Operation
        pid       = $PID
        startedAt = (Get-Date).ToString("o")
        user      = [Environment]::UserName
    }
    $jsonBytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($payloadObj | ConvertTo-Json -Depth 4))

    for ($attempt = 1; $attempt -le 2; $attempt++) {
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

            return @{
                acquiredNew = $true
                lockId      = $newLockId
                ownerPid    = $PID
                operation   = $Operation
                path        = $Path
            }
        } catch [System.IO.IOException] {
            if ($null -ne $fs) {
                try { $fs.Dispose() } catch {}
            }
            # Another process already created the lock file or a stale lock file exists
            $existing = $null
            try {
                if (Test-Path $Path) {
                    $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
                    if (-not [string]::IsNullOrWhiteSpace($raw)) {
                        $existing = $raw | ConvertFrom-Json
                    }
                }
            } catch {
                $existing = $null
            }

            if ($null -ne $existing) {
                if (-not [string]::IsNullOrWhiteSpace($InheritedLockId) -and [string]$existing.lockId -eq $InheritedLockId) {
                    return @{
                        acquiredNew = $false
                        lockId      = $InheritedLockId
                        ownerPid    = [int]$existing.pid
                        operation   = [string]$existing.operation
                        path        = $Path
                    }
                }
                $ownerPid = 0
                try { $ownerPid = [int]$existing.pid } catch { $ownerPid = 0 }
                $ownerProc = if ($ownerPid -gt 0) { Get-Process -Id $ownerPid -ErrorAction SilentlyContinue } else { $null }
                if ($null -ne $ownerProc) {
                    throw "LIFECYCLE_LOCK_ACTIVE: Another lifecycle operation ($($existing.operation), lockId=$($existing.lockId), PID=$ownerPid) is currently running since $($existing.startedAt)."
                }
            } elseif ($attempt -eq 1) {
                # Brief pause in case the winning process is mid-write of the JSON bytes
                Start-Sleep -Milliseconds 50
                try {
                    if (Test-Path $Path) {
                        $rawRetry = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
                        if (-not [string]::IsNullOrWhiteSpace($rawRetry)) {
                            $existing = $rawRetry | ConvertFrom-Json
                            $ownerPid = [int]$existing.pid
                            $ownerProc = if ($ownerPid -gt 0) { Get-Process -Id $ownerPid -ErrorAction SilentlyContinue } else { $null }
                            if ($null -ne $ownerProc) {
                                throw "LIFECYCLE_LOCK_ACTIVE: Another lifecycle operation ($($existing.operation), lockId=$($existing.lockId), PID=$ownerPid) is currently running since $($existing.startedAt)."
                            }
                        }
                    }
                } catch {
                    if ($_.Exception.Message -like "LIFECYCLE_LOCK_ACTIVE*") {
                        throw $_
                    }
                }
            }

            # Stale lock detected (owning PID is no longer alive) -> remove once and retry FileMode.CreateNew
            if ($attempt -eq 1) {
                Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
                continue
            }
            throw "LIFECYCLE_LOCK_ACTIVE: Cannot acquire atomic lifecycle lock at $Path because another operation holds the lock."
        } finally {
            if ($null -ne $fs) {
                try { $fs.Dispose() } catch {}
            }
        }
    }

    throw "LIFECYCLE_LOCK_ACTIVE: Failed to acquire atomic lifecycle lock at $Path."
}

function Release-AtomicLifecycleLock {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$LockHandle
    )
    if ($null -eq $LockHandle -or -not $LockHandle.acquiredNew) {
        return
    }
    if (-not (Test-Path $Path)) {
        return
    }
    try {
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        if (-not [string]::IsNullOrWhiteSpace($raw)) {
            $current = $raw | ConvertFrom-Json
            if ($null -ne $current) {
                if ([string]$current.lockId -ne [string]$LockHandle.lockId -or [int]$current.pid -ne [int]$LockHandle.ownerPid) {
                    # Do NOT delete a lock owned by a different lockId or PID!
                    return
                }
            }
        }
        Remove-Item -Path $Path -Force -ErrorAction SilentlyContinue
    } catch {
        # Ignore cleanup errors if already removed
    }
}
