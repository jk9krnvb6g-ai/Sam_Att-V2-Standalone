<#
.SYNOPSIS
  Sam_Att V2 Standalone - Safe Uninstaller Script (Phase 2.7 & Final Safety Patch)
.DESCRIPTION
  Safely stops and removes ONLY the SamAttV2Standalone Windows Service and optional
  Firewall rule 'Sam_Att V2 HTTPS 4101' under the Shared Atomic Lifecycle Lock
  (D:\Deployments\Sam_Att\lifecycle.lock), while strictly preserving:
  - MySQL Production Database (10.1.0.201:3306 / samchuk_attendance_v2)
  - D:\Backups\Sam_Att
  - D:\WebApps\Sam_Att\Config\.env
  - D:\WebApps\Sam_Att\Certs
  - D:\WebApps\Sam_Att\Logs
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
  [string]$LockFilePath = "",
  [string]$ParentLockId = "",
  [string]$ServiceName = "SamAttV2Standalone",
  [string]$FirewallRuleDisplayName = "Sam_Att V2 HTTPS 4101",
  [switch]$RemoveFirewallRule,
  [switch]$RemoveAppDirectory,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $RootDir "App"
$ServiceDir = Join-Path $RootDir "Service"
$LogsDir = Join-Path $RootDir "Logs"
$ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"
if ([string]::IsNullOrWhiteSpace($LockFilePath)) {
  $LockFilePath = Join-Path $DeploymentsDir "lifecycle.lock"
}
$isDryRunMode = ($DryRun -or $WhatIfPreference)

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Sam_Att V2 Standalone - Safe Service Uninstaller" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

if ($isDryRunMode -or (-not $PSCmdlet.ShouldProcess($ServiceName, "Stop and uninstall Windows Service '$ServiceName'"))) {
  Write-Host "[Uninstall - DryRun/WhatIf] Would acquire atomic lock at $LockFilePath and stop/unregister service '$ServiceName' without touching database, Config\.env, Certs, or Backups." -ForegroundColor Yellow
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

$lockHandle = Acquire-AtomicLifecycleLock -Path $LockFilePath -Operation "UNINSTALL" -InheritedLockId $ParentLockId

try {
  $ExistingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $ExistingSvc) {
    if ($ExistingSvc.Status -ne "Stopped") {
      Write-Host "[Uninstall] Stopping Windows Service '$ServiceName'..."
      Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
      Start-Sleep -Seconds 3
    }
    if (Test-Path $ServiceExe) {
      Write-Host "[Uninstall] Uninstalling service via WinSW ($ServiceExe)..."
      & $ServiceExe uninstall | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "WINSW_UNINSTALL_FAILED: WinSW uninstall exited with code $LASTEXITCODE"
      }
    } else {
      Write-Host "[Uninstall] Removing service registration via sc.exe delete $ServiceName..."
      & sc.exe delete $ServiceName | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "SC_DELETE_FAILED: sc.exe delete exited with code $LASTEXITCODE"
      }
    }
    Write-Host "[Uninstall] Windows Service '$ServiceName' unregistered." -ForegroundColor Green
  } else {
    Write-Host "[Uninstall] Windows Service '$ServiceName' is not currently registered." -ForegroundColor Yellow
  }

  if ($RemoveFirewallRule) {
    $ExistingRules = @(Get-NetFirewallRule -DisplayName $FirewallRuleDisplayName -ErrorAction SilentlyContinue)
    if ($ExistingRules.Count -gt 0) {
      Write-Host "[Uninstall] Removing Windows Firewall rule '$FirewallRuleDisplayName'..."
      Remove-NetFirewallRule -DisplayName $FirewallRuleDisplayName -ErrorAction SilentlyContinue
    }
  }

  if ($RemoveAppDirectory -and (Test-Path $AppDir)) {
    Write-Host "[Uninstall] Removing application code directory $AppDir (preserving Config, Certs, Logs, and D:\Backups\Sam_Att)..."
    Remove-Item -Path $AppDir -Recurse -Force
  }

  if (Test-Path $LogsDir) {
    $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][INFO] Uninstalled Windows Service '$ServiceName' (RemoveFirewallRule=$RemoveFirewallRule, RemoveAppDirectory=$RemoveAppDirectory). Database, Backups, Config, Certs, and Logs preserved."
    Add-Content -Path (Join-Path $LogsDir "installation.log") -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
  }

  Write-Host "[Uninstall] Completed safely. MySQL database, Backups, Config, Certs, and Logs remain intact." -ForegroundColor Green
  exit 0
} finally {
  Release-AtomicLifecycleLock -Path $LockFilePath -LockHandle $lockHandle
}
