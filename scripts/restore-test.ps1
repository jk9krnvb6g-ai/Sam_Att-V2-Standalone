<#
.SYNOPSIS
    Sam_Att V2 Standalone - Safe Application Rollback Wrapper (scripts/restore-test.ps1)
.DESCRIPTION
    Canonical wrapper that delegates to root Rollback_Sam_Att.ps1 so that all restores
    verify every file's SHA-256 hash against backup-manifest.json before stopping the
    SamAttV2Standalone service, preserve Config\.env and Certs, and never overwrite or
    restore the MySQL database (if a DBA ever runs manual MySQL CLI verification,
    --defaults-extra-file= is used instead of inline passwords).
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
    [switch]$UseLastKnownGood,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$rootRollback = Join-Path (Split-Path -Parent $PSScriptRoot) "Rollback_Sam_Att.ps1"
if (-not (Test-Path $rootRollback)) {
    throw "CANONICAL_ROLLBACK_MISSING: Could not find $rootRollback"
}

$forwardParams = @{
    SamAttRoot     = $SamAttRoot
    BackupRootDir  = $BackupRootDir
    DeploymentsDir = $DeploymentsDir
    ServiceName    = $ServiceName
    HostName       = $HostName
    HttpsPort      = $HttpsPort
}
if (-not [string]::IsNullOrWhiteSpace($SnapshotDir)) {
    $forwardParams["SnapshotDir"] = $SnapshotDir
}
if ($UseLastKnownGood) {
    $forwardParams["UseLastKnownGood"] = $true
}
if ($DryRun -or $WhatIfPreference) {
    $forwardParams["DryRun"] = $true
}

& $rootRollback @forwardParams
exit $LASTEXITCODE
