<#
.SYNOPSIS
    Sam_Att V2 Standalone - Windows Service Installer Wrapper (scripts/install-windows.ps1)
.DESCRIPTION
    Canonical wrapper that delegates to root Install_Sam_Att.ps1 so that all service
    installations enforce strict firewall scope, external D:\WebApps\Sam_Att\Config\.env
    isolation, read-only database preflight (never running automatic db:migrate), and
    shared lifecycle locking.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet("FreshInstall", "Upgrade", "Repair", "PreflightOnly")]
    [string]$Mode = "FreshInstall",
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [string]$ServiceName = "SamAttV2Standalone",
    [string]$NodeExecutablePath = "",
    [int]$HttpsPort = 4101,
    [string]$ServerIpSan = "10.2.0.23",
    [string]$FirewallRemoteAddress = "",
    [switch]$NonInteractive,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$rootInstaller = Join-Path (Split-Path -Parent $PSScriptRoot) "Install_Sam_Att.ps1"
if (-not (Test-Path $rootInstaller)) {
    throw "CANONICAL_INSTALLER_MISSING: Could not find $rootInstaller"
}

$forwardParams = @{
    Mode           = $Mode
    SamAttRoot     = $SamAttRoot
    BackupDir      = $BackupDir
    DeploymentsDir = $DeploymentsDir
    ServiceName    = $ServiceName
    HttpsPort      = $HttpsPort
    ServerIpSan    = $ServerIpSan
}
if (-not [string]::IsNullOrWhiteSpace($NodeExecutablePath)) {
    $forwardParams["NodeExecutablePath"] = $NodeExecutablePath
}
if (-not [string]::IsNullOrWhiteSpace($FirewallRemoteAddress)) {
    $forwardParams["FirewallRemoteAddress"] = $FirewallRemoteAddress
}
if ($NonInteractive) {
    $forwardParams["NonInteractive"] = $true
}
if ($DryRun -or $WhatIfPreference) {
    $forwardParams["DryRun"] = $true
}

& $rootInstaller @forwardParams
exit $LASTEXITCODE
