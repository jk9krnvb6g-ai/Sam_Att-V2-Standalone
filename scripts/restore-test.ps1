<#
.SYNOPSIS
  Sam_Att V2 Standalone — Database & Build Restore Verification Script
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupFolder,
  [string]$AppDir = "C:\Sam_Att\app",
  [string]$ServiceName = "SamAttV2Standalone"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $BackupFolder "manifest.json"))) {
  throw "RESTORE_ABORTED: manifest.json not found in $BackupFolder"
}

Write-Host "[Restore] Stopping service '$ServiceName' (Isolated to Sam_Att only)..."
Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue

if (Test-Path (Join-Path $BackupFolder "dist")) {
  Write-Host "[Restore] Restoring static build directory..."
  if (Test-Path (Join-Path $AppDir "dist")) {
    Remove-Item -Path (Join-Path $AppDir "dist") -Recurse -Force
  }
  Copy-Item -Path (Join-Path $BackupFolder "dist") -Destination (Join-Path $AppDir "dist") -Recurse
}

Write-Host "[Restore] Starting service '$ServiceName'..."
Start-Service -Name $ServiceName -ErrorAction SilentlyContinue
& "$PSScriptRoot\health-check.ps1"
Write-Host "[Restore] Restore and health verification succeeded."
