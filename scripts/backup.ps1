<#
.SYNOPSIS
    Sam_Att V2 Standalone - Application Snapshot Backup Wrapper (scripts/backup.ps1)
.DESCRIPTION
    Canonical wrapper that delegates to root Backup_Sam_Att.ps1 so that all backups
    use the full SHA-256 File Manifest, last_known_good.json pointer, and Shared Lifecycle Lock
    in D:\Backups\Sam_Att (or legacy external root C:\SamAttBackups), while rejecting
    BACKUP_DIR_INSIDE_GIT_FORBIDDEN and never exposing credentials on CLI (if a DBA ever runs
    manual DB dumps, --defaults-extra-file= must be used instead of -p).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupRootDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [int]$RetentionCount = 10,
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$repoRoot = (Split-Path -Parent $PSScriptRoot).TrimEnd('\', '/')
$resolvedBackupRoot = [System.IO.Path]::GetFullPath($BackupRootDir).TrimEnd('\', '/')
if ($resolvedBackupRoot.StartsWith($repoRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "BACKUP_DIR_INSIDE_GIT_FORBIDDEN: BackupRootDir ($resolvedBackupRoot) must reside outside the Git repository ($repoRoot), such as D:\Backups\Sam_Att or C:\SamAttBackups."
}

$rootBackup = Join-Path $repoRoot "Backup_Sam_Att.ps1"
if (-not (Test-Path $rootBackup)) {
    throw "CANONICAL_BACKUP_MISSING: Could not find $rootBackup"
}

$forwardParams = @{
    SamAttRoot     = $SamAttRoot
    BackupRootDir  = $BackupRootDir
    DeploymentsDir = $DeploymentsDir
    RetentionCount = $RetentionCount
}
if ($DryRun -or $WhatIfPreference) {
    $forwardParams["DryRun"] = $true
}
if ($Json) {
    $forwardParams["Json"] = $true
}

& $rootBackup @forwardParams
exit $LASTEXITCODE
