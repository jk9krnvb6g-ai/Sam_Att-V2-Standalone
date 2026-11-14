<#
.SYNOPSIS
  Sam_Att V2 Standalone — One-Time Windows Service Installer (Port 4101 HTTPS Only)
.DESCRIPTION
  Installs and configures the SamAttV2Standalone Windows Service on Port 4101.
  Strictly isolated: NEVER touches Procurement, Central API Gateway, or FILESERVER.
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "C:\Sam_Att\app",
  [string]$ServiceName = "SamAttV2Standalone",
  [int]$HttpsPort = 4101
)

$ErrorActionPreference = "Stop"

Write-Host "[Sam_Att V2] Checking strict service isolation policy..."
if ($env:COMPUTERNAME -eq "FILESERVER") {
  throw "ABORTED: Installation on FILESERVER is strictly prohibited by system policy."
}

$ForbiddenServices = @("Procurement", "CentralApiGateway", "SamAttGateway")
foreach ($svc in $ForbiddenServices) {
  Write-Host "[Sam_Att V2] Policy Guard: Service '$svc' will NOT be touched or restarted."
}

if (-not (Test-Path $InstallDir)) {
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$NodeVersion = & node -v
Write-Host "[Sam_Att V2] Detected Node.js runtime: $NodeVersion (Target: v26.13.1)"

Push-Location $InstallDir
try {
  Write-Host "[Sam_Att V2] Installing locked dependencies (npm ci)..."
  & npm ci
  Write-Host "[Sam_Att V2] Running TypeScript verification & Frontend build..."
  & npm run typecheck
  & npm run build
  Write-Host "[Sam_Att V2] Running database schema migrations..."
  & npm run db:migrate
} finally {
  Pop-Location
}

Write-Host "[Sam_Att V2] Configuring Windows Firewall rule for TCP Port $HttpsPort..."
New-NetFirewallRule -DisplayName "Sam_Att V2 Standalone HTTPS ($HttpsPort)" `
  -Direction Inbound -LocalPort $HttpsPort -Protocol TCP -Action Allow -ErrorAction SilentlyContinue | Out-Null

Write-Host "[Sam_Att V2] Registering Windows Service '$ServiceName'..."
$ExistingSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if (-not $ExistingSvc) {
  $BinPath = "`"$((Get-Command node).Source)`" --import tsx `"$InstallDir\server.ts`""
  sc.exe create $ServiceName binPath= $BinPath start= auto DisplayName= "Sam_Att V2 Standalone HTTPS Server (4101)" | Out-Null
}

Start-Service -Name $ServiceName
Write-Host "[Sam_Att V2] Service '$ServiceName' started. Executing HTTPS health check..."
& "$PSScriptRoot\health-check.ps1" -Port $HttpsPort
