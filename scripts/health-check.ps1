<#
.SYNOPSIS
  Sam_Att V2 Standalone — Single-Port HTTPS (4101) Smoke & Health Verification
#>
[CmdletBinding()]
param(
  [string]$HostName = "localhost",
  [int]$Port = 4101,
  [string]$ExpectedDbEngine = "mysql",
  [string]$ExpectedDbName = "samchuk_attendance_v2"
)

$ErrorActionPreference = "Stop"

$FrontendUrl = "https://$($HostName):$($Port)/Sam_Att/"
$ApiHealthUrl = "https://$($HostName):$($Port)/api/Sam_Att/health"

Write-Host "[HealthCheck] Probing Frontend SPA: $FrontendUrl"
if ($PSVersionTable.PSVersion.Major -ge 6) {
  $FrontendResp = Invoke-WebRequest -Uri $FrontendUrl -SkipCertificateCheck -UseBasicParsing -TimeoutSec 10
  $ApiRawResp = Invoke-WebRequest -Uri $ApiHealthUrl -SkipCertificateCheck -UseBasicParsing -TimeoutSec 10
} else {
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12
  $OldCb = [System.Net.ServicePointManager]::ServerCertificateValidationCallback
  try {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }
    $FrontendResp = Invoke-WebRequest -Uri $FrontendUrl -UseBasicParsing -TimeoutSec 10
    $ApiRawResp = Invoke-WebRequest -Uri $ApiHealthUrl -UseBasicParsing -TimeoutSec 10
  } finally {
    [System.Net.ServicePointManager]::ServerCertificateValidationCallback = $OldCb
  }
}

if ($FrontendResp.StatusCode -ne 200) {
  throw "FRONTEND_CHECK_FAILED: HTTP $($FrontendResp.StatusCode)"
}

Write-Host "[HealthCheck] Probing API Health: $ApiHealthUrl"
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

Write-Host "[HealthCheck] PASS: Frontend (/Sam_Att/ = 200 OK) and API (/api/Sam_Att/health = 200 OK, MySQL=$($ApiResp.database.databaseName)) healthy on HTTPS Port $Port."

