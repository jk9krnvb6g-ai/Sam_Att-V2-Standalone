<#
.SYNOPSIS
  Sam_Att V2 Standalone — Atomic Release Deployment with SHA-256 Verification & Automatic Rollback
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$ArtifactZipPath,
  [Parameter(Mandatory=$true)][string]$ExpectedSha256,
  [string]$AppDir = "C:\Sam_Att\app",
  [string]$ServiceName = "SamAttV2Standalone",
  [int]$HttpsPort = 4101
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ArtifactZipPath)) {
  throw "DEPLOY_ABORTED: Artifact file not found at $ArtifactZipPath"
}

$ActualHash = (Get-FileHash -Path $ArtifactZipPath -Algorithm SHA256).Hash.ToLower()
if ($ActualHash -ne $ExpectedSha256.ToLower()) {
  throw "DEPLOY_ABORTED: SHA-256 mismatch! Expected=$ExpectedSha256 Actual=$ActualHash"
}

Write-Host "[Deploy] Step 1: Creating pre-deployment backup..."
$BackupDir = & "$PSScriptRoot\backup.ps1" -AppDir $AppDir

try {
  Write-Host "[Deploy] Step 2: Stopping '$ServiceName' only..."
  Stop-Service -Name $ServiceName -ErrorAction SilentlyContinue

  Write-Host "[Deploy] Step 3: Extracting verified release package..."
  Expand-Archive -Path $ArtifactZipPath -DestinationPath $AppDir -Force

  Push-Location $AppDir
  try {
    & npm ci --omit=dev
    & npm run db:migrate
  } finally {
    Pop-Location
  }

  Write-Host "[Deploy] Step 4: Starting '$ServiceName' and running HTTPS health check..."
  Start-Service -Name $ServiceName
  & "$PSScriptRoot\health-check.ps1" -Port $HttpsPort
  Write-Host "[Deploy] Deployment of verified artifact $ActualHash SUCCEEDED."
} catch {
  Write-Warning "[Deploy] Deployment failed ($($_.Exception.Message)). Triggering AUTOMATIC ROLLBACK from $BackupDir..."
  & "$PSScriptRoot\restore-test.ps1" -BackupFolder $BackupDir -AppDir $AppDir -ServiceName $ServiceName
  throw "DEPLOYMENT_ROLLED_BACK: Automatic rollback completed after failure."
}
