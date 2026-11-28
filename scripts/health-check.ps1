<#
.SYNOPSIS
    Sam_Att V2 Standalone - Canonical Production Health Check Wrapper (scripts/health-check.ps1)
.DESCRIPTION
    Delegates directly to the root canonical HealthCheck_Sam_Att.ps1 script so that all
    invocations enforce strict HTTPS TLS certificate verification (trust chain, SAN 10.2.0.23,
    expiration) and strict Windows Service process ownership verification.
    Never uses SkipCertificateCheck or ServerCertificateValidationCallback={$true}.
#>
[CmdletBinding()]
param(
    [string]$HostName = "10.2.0.23",
    [int]$Port = 4101,
    [string]$ServiceName = "SamAttV2Standalone",
    [string]$AppDir = "D:\WebApps\Sam_Att\App",
    [string]$ExpectedVersion = "",
    [string]$ExpectedCommit = "",
    [string]$TrustInternalCaCertPath = "",
    [int]$TimeoutSec = 10,
    [switch]$DiagnosticMode,
    [switch]$SkipServiceCheck,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$rootHealthCheck = Join-Path (Split-Path -Parent $PSScriptRoot) "HealthCheck_Sam_Att.ps1"
if (-not (Test-Path $rootHealthCheck)) {
    throw "CANONICAL_HEALTHCHECK_MISSING: Could not find $rootHealthCheck"
}

$forwardParams = @{
    HostName   = $HostName
    Port       = $Port
    ServiceName = $ServiceName
    AppDir     = $AppDir
    TimeoutSec = $TimeoutSec
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedVersion)) {
    $forwardParams["ExpectedVersion"] = $ExpectedVersion
}
if (-not [string]::IsNullOrWhiteSpace($ExpectedCommit)) {
    $forwardParams["ExpectedCommit"] = $ExpectedCommit
}
if (-not [string]::IsNullOrWhiteSpace($TrustInternalCaCertPath)) {
    $forwardParams["TrustInternalCaCertPath"] = $TrustInternalCaCertPath
}
if ($DiagnosticMode) {
    $forwardParams["DiagnosticMode"] = $true
}
if ($SkipServiceCheck) {
    $forwardParams["SkipServiceCheck"] = $true
}
if ($Json) {
    $forwardParams["Json"] = $true
}

& $rootHealthCheck @forwardParams
exit $LASTEXITCODE
