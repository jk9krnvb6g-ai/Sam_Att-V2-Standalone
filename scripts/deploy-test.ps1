<#
.SYNOPSIS
    Sam_Att V2 Standalone - Safe Deployment Wrapper (scripts/deploy-test.ps1)
.DESCRIPTION
    Canonical wrapper that delegates to root Deploy_Sam_Att.ps1 so that all deployments
    use the single canonical deployment engine, shared lifecycle lock, full SHA-256 snapshot
    manifest, read-only DB preflight (never running automatic db:migrate), and strict HTTPS
    HealthCheck.
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
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$rootDeploy = Join-Path (Split-Path -Parent $PSScriptRoot) "Deploy_Sam_Att.ps1"
if (-not (Test-Path $rootDeploy)) {
    throw "CANONICAL_DEPLOY_MISSING: Could not find $rootDeploy"
}

$forwardParams = @{
    SamAttRoot     = $SamAttRoot
    BackupRootDir  = $BackupRootDir
    DeploymentsDir = $DeploymentsDir
    ServiceName    = $ServiceName
    Branch         = $Branch
    HostName       = $HostName
    HttpsPort      = $HttpsPort
}
if ($DryRun -or $WhatIfPreference) {
    $forwardParams["DryRun"] = $true
}

& $rootDeploy @forwardParams
exit $LASTEXITCODE
