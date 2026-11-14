<#
.SYNOPSIS
  Sam_Att V2 Standalone — Single-Port HTTPS (4101) Smoke & Health Verification
#>
[CmdletBinding()]
param(
  [string]$HostName = "127.0.0.1",
  [int]$Port = 4101
)

$ErrorActionPreference = "Stop"

$FrontendUrl = "https://$($HostName):$($Port)/Sam_Att/"
$ApiHealthUrl = "https://$($HostName):$($Port)/api/Sam_Att/health"

Write-Host "[HealthCheck] Probing Frontend SPA: $FrontendUrl"
$FrontendResp = Invoke-WebRequest -Uri $FrontendUrl -SkipCertificateCheck -UseBasicParsing -TimeoutSec 10
if ($FrontendResp.StatusCode -ne 200) {
  throw "FRONTEND_CHECK_FAILED: HTTP $($FrontendResp.StatusCode)"
}

Write-Host "[HealthCheck] Probing API Health: $ApiHealthUrl"
$ApiResp = Invoke-RestMethod -Uri $ApiHealthUrl -SkipCertificateCheck -TimeoutSec 10
if ($ApiResp.status -ne "OK") {
  throw "API_HEALTH_FAILED: $($ApiResp | ConvertTo-Json -Compress)"
}

Write-Host "[HealthCheck] PASS: Frontend (/Sam_Att/) and API (/api/Sam_Att/health) healthy on HTTPS Port $Port."
