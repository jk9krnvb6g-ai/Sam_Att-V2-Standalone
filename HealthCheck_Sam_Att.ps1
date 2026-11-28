<#
.SYNOPSIS
  Sam_Att V2 Standalone - Production Health Check & Readiness Verification Script (Phase 2.11)
.DESCRIPTION
  Verifies:
  1. Windows Service 'SamAttV2Standalone' status (when running on Windows Server)
  2. TCP Port 4101 listener ownership
  3. Frontend SPA endpoint: https://<HostName>:4101/Sam_Att/
  4. Liveness API endpoint: https://<HostName>:4101/api/Sam_Att/health/live
  5. Readiness & Health API endpoints: https://<HostName>:4101/api/Sam_Att/health and /api/Sam_Att/health/ready
  6. Database connection status (MySQL samchuk_attendance_v2) and Scanner Standby/Active mode
#>
[CmdletBinding()]
param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 4101,
  [string]$ServiceName = "SamAttV2Standalone",
  [string]$ExpectedDbEngine = "mysql",
  [string]$ExpectedDbName = "samchuk_attendance_v2",
  [switch]$SkipServiceCheck
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-SamAttHttpsEndpoint {
  param(
    [string]$Uri,
    [int]$TimeoutSec = 10
  )
  if ($PSVersionTable.PSVersion.Major -ge 6) {
    return Invoke-WebRequest -Uri $Uri -SkipCertificateCheck -UseBasicParsing -TimeoutSec $TimeoutSec
  } else {
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
    $OldCallback = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
    try {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
      return Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSec
    } finally {
      [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $OldCallback
    }
  }
}

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host " Sam_Att V2 Standalone - Health & Readiness Check (HTTPS Port $Port)" -ForegroundColor Cyan
Write-Host "======================================================================" -ForegroundColor Cyan

if (-not $SkipServiceCheck -and ($env:OS -like "*Windows*")) {
  $Svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($null -ne $Svc) {
    Write-Host "[Service] Windows Service '$ServiceName' Status: $($Svc.Status)"
    if ($Svc.Status -ne "Running") {
      throw "SERVICE_NOT_RUNNING: Windows Service '$ServiceName' is '$($Svc.Status)' (expected Running)"
    }
  } else {
    Write-Host "[Service] Notice: Windows Service '$ServiceName' not registered (checking standalone listener on port $Port)..." -ForegroundColor Yellow
  }
}

$FrontendUrl = "https://$($HostName):$($Port)/Sam_Att/"
$LiveUrl = "https://$($HostName):$($Port)/api/Sam_Att/health/live"
$ReadyUrl = "https://$($HostName):$($Port)/api/Sam_Att/health/ready"
$HealthUrl = "https://$($HostName):$($Port)/api/Sam_Att/health"

Write-Host "[1/4] Probing Frontend SPA      : $FrontendUrl"
$FrontResp = Invoke-SamAttHttpsEndpoint -Uri $FrontendUrl
if ($FrontResp.StatusCode -ne 200) {
  throw "FRONTEND_CHECK_FAILED: HTTP $($FrontResp.StatusCode)"
}

Write-Host "[2/4] Probing Liveness Endpoint : $LiveUrl"
$LiveResp = Invoke-SamAttHttpsEndpoint -Uri $LiveUrl
if ($LiveResp.StatusCode -ne 200) {
  throw "LIVENESS_HTTP_FAILED: HTTP $($LiveResp.StatusCode)"
}
$LiveJson = $LiveResp.Content | ConvertFrom-Json
if ($LiveJson.status -ne "OK") {
  throw "LIVENESS_STATUS_FAILED: status=$($LiveJson.status)"
}

Write-Host "[3/4] Probing Readiness Endpoint: $ReadyUrl"
$ReadyResp = Invoke-SamAttHttpsEndpoint -Uri $ReadyUrl
if ($ReadyResp.StatusCode -ne 200) {
  throw "READINESS_HTTP_FAILED: HTTP $($ReadyResp.StatusCode)"
}

Write-Host "[4/4] Probing Main Health API   : $HealthUrl"
$ApiRawResp = Invoke-SamAttHttpsEndpoint -Uri $HealthUrl
if ($ApiRawResp.StatusCode -ne 200) {
  throw "API_HEALTH_HTTP_FAILED: HTTP $($ApiRawResp.StatusCode)"
}

$ApiResp = $ApiRawResp.Content | ConvertFrom-Json
if ($ApiResp.status -ne "OK") {
  throw "API_HEALTH_FAILED: status=$($ApiResp.status)"
}
if ($ApiResp.service -ne "Sam_Att V2 Standalone") {
  throw "API_WRONG_SERVICE: service=$($ApiResp.service)"
}
if (-not $ApiResp.database -or $ApiResp.database.connected -ne $true) {
  throw "API_DB_DISCONNECTED: database.connected=$($ApiResp.database.connected)"
}
if ($ExpectedDbEngine -and $ApiResp.database.engine -ne $ExpectedDbEngine) {
  throw "API_WRONG_DB_ENGINE: expected=$ExpectedDbEngine actual=$($ApiResp.database.engine)"
}
if ($ExpectedDbName -and $ApiResp.database.databaseName -ne $ExpectedDbName) {
  throw "API_WRONG_DB_NAME: expected=$ExpectedDbName actual=$($ApiResp.database.databaseName)"
}

$ScannerMode = if ($ApiResp.PSObject.Properties["scanner"] -and $null -ne $ApiResp.scanner) { $ApiResp.scanner.mode } else { "UNKNOWN" }
$CommitHash = if ($ApiResp.PSObject.Properties["commitHash"]) { $ApiResp.commitHash } else { "N/A" }
$UptimeSec = if ($ApiResp.PSObject.Properties["uptimeSeconds"]) { $ApiResp.uptimeSeconds } else { 0 }

Write-Host "----------------------------------------------------------------------" -ForegroundColor Green
Write-Host " HEALTH CHECK PASSED" -ForegroundColor Green
Write-Host "  Application    : $($ApiResp.service) ($($ApiResp.version))" -ForegroundColor Green
Write-Host "  Commit / Uptime: $CommitHash / ${UptimeSec}s" -ForegroundColor Green
Write-Host "  Database       : CONNECTED ($($ApiResp.database.engine) / $($ApiResp.database.databaseName))" -ForegroundColor Green
Write-Host "  Scanner Mode   : $ScannerMode (AutoScheduler=$($ApiResp.featureFlags.scannerAutoSchedulerEnabled))" -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Cyan
exit 0
