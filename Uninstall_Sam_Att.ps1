<#
.SYNOPSIS
  Sam_Att V2 Standalone - Safe Uninstaller Script (Phase 2.7)
.DESCRIPTION
  Safely stops and removes ONLY the SamAttV2Standalone Windows Service and optional
  Firewall rule 'Sam_Att V2 HTTPS 4101', while strictly preserving:
  - MySQL Production Database (10.1.0.201:3306 / samchuk_attendance_v2)
  - D:\Backups\Sam_Att
  - D:\WebApps\Sam_Att\Config\.env
  - D:\WebApps\Sam_Att\Certs
  - D:\WebApps\Sam_Att\Logs
#>
[CmdletBinding(SupportsShouldProcess=$true)]
param(
  [string]$RootDir = "D:\WebApps\Sam_Att",
  [string]$ServiceName = "SamAttV2Standalone",
  [string]$FirewallRuleDisplayName = "Sam_Att V2 HTTPS 4101",
  [switch]$RemoveFirewallRule,
  [switch]$RemoveAppDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$AppDir = Join-Path $RootDir "App"
$ServiceDir = Join-Path $RootDir "Service"
$LogsDir = Join-Path $RootDir "Logs"
$ServiceExe = Join-Path $ServiceDir "$ServiceName.exe"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Sam_Att V2 Standalone - Safe Service Uninstaller" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

if (-not $PSCmdlet.ShouldProcess($ServiceName, "Stop and uninstall Windows Service '$ServiceName'")) {
  Write-Host "[Uninstall - WhatIf] Would stop and unregister service '$ServiceName'"
  exit 0
}

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
  } else {
    Write-Host "[Uninstall] Removing service registration via sc.exe delete $ServiceName..."
    & sc.exe delete $ServiceName | Out-Null
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
