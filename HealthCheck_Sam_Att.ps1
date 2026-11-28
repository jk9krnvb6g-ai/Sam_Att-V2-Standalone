<#
.SYNOPSIS
    Sam_Att V2 Standalone - Strict Production Health Check & Readiness Verifier
.DESCRIPTION
    Verifies Production Health for Sam_Att V2 Standalone on Windows Server (10.2.0.23):
    1. Strict Windows Service verification (SamAttV2Standalone must exist, be Running,
       and own the process listening on TCP Port 4101).
       - SkipServiceCheck is FORBIDDEN unless -DiagnosticMode is explicitly enabled.
    2. Strict HTTPS TLS Certificate verification (X.509 Chain Trust, Hostname/IP SAN match
       for 10.2.0.23, and Expiration NotBefore/NotAfter).
       - Never uses SkipCertificateCheck, ServerCertificateValidationCallback={$true},
         or NODE_TLS_REJECT_UNAUTHORIZED=0 in production health checks.
       - Supports -TrustInternalCaCertPath to safely import an Internal CA / Root Certificate
         into Cert:\LocalMachine\Root with administrator approval before verification.
    3. Endpoints & Database verification:
       - GET https://<HostName>:4101/Sam_Att/
       - GET https://<HostName>:4101/api/Sam_Att/health/live
       - GET https://<HostName>:4101/api/Sam_Att/health/ready
       - GET https://<HostName>:4101/api/Sam_Att/health (database.connected === true)
    4. Release Version & Commit verification (-ExpectedVersion / -ExpectedCommit).
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
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($SkipServiceCheck -and -not $DiagnosticMode) {
    $errMsg = "SKIP_SERVICE_CHECK_FORBIDDEN_IN_PRODUCTION: -SkipServiceCheck is only allowed when -DiagnosticMode is explicitly enabled."
    if ($Json) {
        Write-Output (@{
            ok        = $false
            timestamp = (Get-Date).ToString("o")
            errorCode = "SKIP_SERVICE_CHECK_FORBIDDEN_IN_PRODUCTION"
            errors    = @($errMsg)
        } | ConvertTo-Json -Depth 6)
    } else {
        Write-Host "[FAIL] $errMsg" -ForegroundColor Red
    }
    exit 1
}

function Import-InternalRootCaSafely {
    param([string]$CertFilePath)
    if (-not (Test-Path $CertFilePath)) {
        throw "CA_CERT_FILE_NOT_FOUND: Certificate file not found at $CertFilePath"
    }
    $certObj = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($CertFilePath)
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
        [System.Security.Cryptography.X509Certificates.StoreName]::Root,
        [System.Security.Cryptography.X509Certificates.StoreLocation]::LocalMachine
    )
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        $existing = $store.Certificates.Find(
            [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
            $certObj.Thumbprint,
            $false
        )
        if ($existing.Count -eq 0) {
            $store.Add($certObj)
        }
    } finally {
        $store.Close()
    }
    return $certObj.Thumbprint
}

function Test-CertificateHostSanMatch {
    param(
        [System.Security.Cryptography.X509Certificates.X509Certificate2]$Cert,
        [string]$TargetHost
    )
    $sanExt = $Cert.Extensions | Where-Object { $_.Oid.Value -eq "2.5.29.17" } | Select-Object -First 1
    $sanFormatted = ""
    if ($null -ne $sanExt) {
        $sanFormatted = $sanExt.Format($false)
        if ($sanFormatted -match [regex]::Escape($TargetHost)) {
            return @{ matched = $true; san = $sanFormatted; matchedVia = "SAN" }
        }
    }
    $subject = $Cert.Subject
    if ($subject -match "CN=$([regex]::Escape($TargetHost))(\b|,|$)") {
        return @{ matched = $true; san = $sanFormatted; matchedVia = "SubjectCN" }
    }
    return @{ matched = $false; san = $sanFormatted; matchedVia = "NONE" }
}

function Test-StrictTlsEndpointHandshake {
    param(
        [string]$TargetHost,
        [int]$TargetPort,
        [int]$TimeoutSeconds
    )
    $tcpClient = New-Object System.Net.Sockets.TcpClient
    try {
        $connectTask = $tcpClient.ConnectAsync($TargetHost, $TargetPort)
        if (-not $connectTask.Wait($TimeoutSeconds * 1000)) {
            return @{
                ok     = $false
                errors = @("TLS_TCP_CONNECT_TIMEOUT: Timed out connecting to ${TargetHost}:${TargetPort}")
            }
        }

        $validationState = @{
            policyErrors = [System.Net.Security.SslPolicyErrors]::None
            chainErrors  = @()
            remoteCert   = $null
        }

        $callback = [System.Net.Security.RemoteCertificateValidationCallback]{
            param($sender, $certificate, $chain, $sslPolicyErrors)
            $validationState.policyErrors = $sslPolicyErrors
            if ($null -ne $certificate) {
                $validationState.remoteCert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($certificate)
            }
            if ($null -ne $chain -and $null -ne $chain.ChainStatus) {
                foreach ($st in $chain.ChainStatus) {
                    if ($st.Status -ne [System.Security.Cryptography.X509Certificates.X509ChainStatusFlags]::NoError) {
                        $validationState.chainErrors += "$($st.Status): $($st.StatusInformation.Trim())"
                    }
                }
            }
            return ($sslPolicyErrors -eq [System.Net.Security.SslPolicyErrors]::None)
        }

        $sslStream = New-Object System.Net.Security.SslStream($tcpClient.GetStream(), $false, $callback)
        try {
            $sslStream.AuthenticateAsClient($TargetHost)
        } catch {
            $errList = @("TLS_HANDSHAKE_FAILED: $($_.Exception.Message)")
            if ($validationState.policyErrors -ne [System.Net.Security.SslPolicyErrors]::None) {
                $errList += "TLS_POLICY_ERROR: $($validationState.policyErrors)"
            }
            if ($validationState.chainErrors.Count -gt 0) {
                $errList += ("TLS_CHAIN_UNTRUSTED: " + ($validationState.chainErrors -join "; "))
            }
            return @{
                ok     = $false
                errors = $errList
            }
        } finally {
            $sslStream.Dispose()
        }

        $cert2 = $validationState.remoteCert
        if ($null -eq $cert2) {
            return @{
                ok     = $false
                errors = @("TLS_NO_REMOTE_CERTIFICATE: Server did not present an X.509 certificate")
            }
        }

        $now = Get-Date
        $certErrors = @()
        if ($now -lt $cert2.NotBefore) {
            $certErrors += "TLS_CERT_NOT_YET_VALID: Certificate NotBefore is $($cert2.NotBefore.ToString('o'))"
        }
        if ($now -ge $cert2.NotAfter) {
            $certErrors += "TLS_CERT_EXPIRED: Certificate expired on $($cert2.NotAfter.ToString('o'))"
        }
        $sanCheck = Test-CertificateHostSanMatch -Cert $cert2 -TargetHost $TargetHost
        if (-not $sanCheck.matched) {
            $certErrors += "TLS_HOST_SAN_MISMATCH: Certificate Subject '$($cert2.Subject)' / SAN '$($sanCheck.san)' does not match host '$TargetHost'"
        }
        if ($validationState.policyErrors -ne [System.Net.Security.SslPolicyErrors]::None) {
            $certErrors += "TLS_POLICY_ERROR: $($validationState.policyErrors)"
        }

        return @{
            ok         = ($certErrors.Count -eq 0)
            subject    = $cert2.Subject
            issuer     = $cert2.Issuer
            thumbprint = $cert2.Thumbprint
            notBefore  = $cert2.NotBefore.ToString("o")
            notAfter   = $cert2.NotAfter.ToString("o")
            san        = $sanCheck.san
            matchedVia = $sanCheck.matchedVia
            errors     = $certErrors
        }
    } catch {
        return @{
            ok     = $false
            errors = @("TLS_CONNECTION_ERROR: $($_.Exception.Message)")
        }
    } finally {
        $tcpClient.Close()
    }
}

function Invoke-StrictHttpsEndpoint {
    param([string]$Url, [int]$TimeoutSeconds)
    try {
        $req = [System.Net.HttpWebRequest]::Create($Url)
        $req.Method = "GET"
        $req.Timeout = $TimeoutSeconds * 1000
        $req.ReadWriteTimeout = $TimeoutSeconds * 1000
        $req.KeepAlive = $false
        $resp = $req.GetResponse()
        $statusCode = [int]$resp.StatusCode
        $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
        $content = $reader.ReadToEnd()
        $reader.Close()
        $resp.Close()
        return @{
            ok         = ($statusCode -ge 200 -and $statusCode -lt 300)
            statusCode = $statusCode
            content    = $content
            error      = $null
        }
    } catch {
        return @{
            ok         = $false
            statusCode = 0
            content    = $null
            error      = $_.Exception.Message
        }
    }
}

function Test-ProcessBelongsToServiceTree {
    param(
        [int]$ListeningPid,
        [int]$ServicePid,
        [string]$ExpectedAppDir
    )
    if ($ListeningPid -le 0 -or $ServicePid -le 0) {
        return @{ owned = $false; reason = "INVALID_PID (ListeningPid=$ListeningPid, ServicePid=$ServicePid)" }
    }
    if ($ListeningPid -eq $ServicePid) {
        return @{ owned = $true; reason = "DIRECT_SERVICE_PID_MATCH" }
    }

    $visited = @{}
    $currentPid = $ListeningPid
    for ($depth = 0; $depth -lt 8; $depth++) {
        if ($visited.ContainsKey($currentPid)) { break }
        $visited[$currentPid] = $true
        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $currentPid" -ErrorAction SilentlyContinue
        if ($null -eq $procInfo) { break }
        $parentPid = [int]$procInfo.ParentProcessId
        if ($parentPid -eq $ServicePid) {
            return @{
                owned       = $true
                reason      = "CHILD_OF_SERVICE_PID"
                processName = $procInfo.Name
                commandLine = $procInfo.CommandLine
            }
        }
        if ($parentPid -le 0 -or $parentPid -eq $currentPid) { break }
        $currentPid = $parentPid
    }

    $listenProc = Get-CimInstance Win32_Process -Filter "ProcessId = $ListeningPid" -ErrorAction SilentlyContinue
    $procDesc = if ($null -ne $listenProc) { "$($listenProc.Name) (PID=$ListeningPid, ParentPID=$($listenProc.ParentProcessId))" } else { "PID=$ListeningPid" }
    return @{
        owned  = $false
        reason = "PORT_NOT_OWNED_BY_SERVICE: Port Listener $procDesc is not in the process tree of $ServiceName (ServicePID=$ServicePid)"
    }
}

$errors = @()

if (-not [string]::IsNullOrWhiteSpace($TrustInternalCaCertPath)) {
    try {
        $importedThumb = Import-InternalRootCaSafely -CertFilePath $TrustInternalCaCertPath
        if (-not $Json) {
            Write-Host "[OK] Imported Internal CA certificate into LocalMachine\Root (Thumbprint: $importedThumb)" -ForegroundColor Green
        }
    } catch {
        $errors += "CA_IMPORT_FAILED: $($_.Exception.Message)"
    }
}

# 1. Resolve ExpectedVersion and ExpectedCommit if not explicitly supplied
$resolvedExpectedVersion = $ExpectedVersion
if ([string]::IsNullOrWhiteSpace($resolvedExpectedVersion) -and (Test-Path (Join-Path $AppDir "package.json"))) {
    try {
        $pkgObj = Get-Content (Join-Path $AppDir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($pkgObj.version) { $resolvedExpectedVersion = [string]$pkgObj.version }
    } catch {}
}

$resolvedExpectedCommit = $ExpectedCommit
if ([string]::IsNullOrWhiteSpace($resolvedExpectedCommit) -and (Test-Path (Join-Path $AppDir ".git"))) {
    try {
        $gitOut = & git -C $AppDir rev-parse --short HEAD 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($gitOut)) {
            $resolvedExpectedCommit = ($gitOut | Select-Object -First 1).Trim()
        }
    } catch {}
}

# 2. Strict Windows Service & Port Ownership Check (FIX 03)
$serviceStatus = "SKIPPED_DIAGNOSTIC"
$servicePid = 0
$listeningPid = 0
$portOwnedByService = $false

if (-not $SkipServiceCheck) {
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -eq $svc) {
        $serviceStatus = "NOT_FOUND"
        $errors += "SERVICE_NOT_FOUND: Windows Service '$ServiceName' is not installed."
    } else {
        $serviceStatus = [string]$svc.Status
        if ($svc.Status -ne "Running") {
            $errors += "SERVICE_NOT_RUNNING: Windows Service '$ServiceName' status is $($svc.Status) (expected Running)."
        } else {
            $wmiSvc = Get-CimInstance Win32_Service -Filter "Name = '$ServiceName'" -ErrorAction SilentlyContinue
            if ($null -ne $wmiSvc) {
                $servicePid = [int]$wmiSvc.ProcessId
            }
            if ($servicePid -le 0) {
                $errors += "SERVICE_PID_INVALID: Could not resolve active ProcessId for running service '$ServiceName'."
            }
        }
    }

    $tcpListeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($null -eq $tcpListeners) {
        $errors += "PORT_NOT_LISTENING: No process is listening on TCP port $Port."
    } else {
        $firstListener = $tcpListeners | Select-Object -First 1
        $listeningPid = [int]$firstListener.OwningProcess
        if ($servicePid -gt 0) {
            $ownership = Test-ProcessBelongsToServiceTree -ListeningPid $listeningPid -ServicePid $servicePid -ExpectedAppDir $AppDir
            $portOwnedByService = [bool]$ownership.owned
            if (-not $portOwnedByService) {
                $errors += $ownership.reason
            }
        }
    }
}

# 3. Strict HTTPS TLS Certificate Check (FIX 01)
$tlsCheck = Test-StrictTlsEndpointHandshake -TargetHost $HostName -TargetPort $Port -TimeoutSeconds $TimeoutSec
if (-not $tlsCheck.ok) {
    foreach ($tlsErr in $tlsCheck.errors) {
        $errors += $tlsErr
    }
}

# 4. HTTPS Application & API Readiness Checks (FIX 01 & FIX 03)
$baseUrl = "https://${HostName}:${Port}"
$frontendRes = Invoke-StrictHttpsEndpoint -Url "$baseUrl/Sam_Att/" -TimeoutSeconds $TimeoutSec
$liveRes     = Invoke-StrictHttpsEndpoint -Url "$baseUrl/api/Sam_Att/health/live" -TimeoutSeconds $TimeoutSec
$readyRes    = Invoke-StrictHttpsEndpoint -Url "$baseUrl/api/Sam_Att/health/ready" -TimeoutSeconds $TimeoutSec
$healthRes   = Invoke-StrictHttpsEndpoint -Url "$baseUrl/api/Sam_Att/health" -TimeoutSeconds $TimeoutSec

if (-not $frontendRes.ok) {
    $errors += "FRONTEND_CHECK_FAILED: GET $baseUrl/Sam_Att/ failed ($($frontendRes.error))"
}
if (-not $liveRes.ok) {
    $errors += "LIVENESS_CHECK_FAILED: GET $baseUrl/api/Sam_Att/health/live failed ($($liveRes.error))"
}
if (-not $readyRes.ok) {
    $errors += "READINESS_CHECK_FAILED: GET $baseUrl/api/Sam_Att/health/ready failed ($($readyRes.error))"
}
if (-not $healthRes.ok) {
    $errors += "MAIN_HEALTH_CHECK_FAILED: GET $baseUrl/api/Sam_Att/health failed ($($healthRes.error))"
}

$readyJson = $null
$healthJson = $null
$dbConnected = $false
$reportedVersion = ""
$reportedCommit = ""

if ($readyRes.ok -and $readyRes.content) {
    try {
        $readyJson = $readyRes.content | ConvertFrom-Json
        if ($readyJson.readiness -ne "READY" -and $readyJson.status -ne "OK") {
            $errors += "API_NOT_READY: /api/Sam_Att/health/ready returned status=$($readyJson.status)"
        }
        if ($null -ne $readyJson.database) {
            $dbConnected = ($readyJson.database.connected -eq $true)
        }
    } catch {
        $errors += "INVALID_READY_JSON: Failed to parse JSON from /api/Sam_Att/health/ready"
    }
}

if ($healthRes.ok -and $healthRes.content) {
    try {
        $healthJson = $healthRes.content | ConvertFrom-Json
        if ($null -ne $healthJson.database -and $healthJson.database.connected -eq $true) {
            $dbConnected = $true
        }
        if ($healthJson.version) { $reportedVersion = [string]$healthJson.version }
        if ($healthJson.commitHash) { $reportedCommit = [string]$healthJson.commitHash }
    } catch {
        $errors += "INVALID_HEALTH_JSON: Failed to parse JSON from /api/Sam_Att/health"
    }
}

if ($liveRes.ok -and $liveRes.content -and ([string]::IsNullOrWhiteSpace($reportedVersion) -or [string]::IsNullOrWhiteSpace($reportedCommit))) {
    try {
        $liveJson = $liveRes.content | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($reportedVersion) -and $liveJson.version) {
            $reportedVersion = [string]$liveJson.version
        }
        if ([string]::IsNullOrWhiteSpace($reportedCommit) -and $liveJson.commitHash) {
            $reportedCommit = [string]$liveJson.commitHash
        }
    } catch {}
}

if (-not $dbConnected) {
    $errors += "DATABASE_NOT_READY: Database connection is not healthy (database.connected != true)."
}

# 5. Version & Commit Verification (FIX 03)
if (-not [string]::IsNullOrWhiteSpace($resolvedExpectedVersion)) {
    if ([string]::IsNullOrWhiteSpace($reportedVersion) -or $reportedVersion -ne $resolvedExpectedVersion) {
        $errors += "VERSION_MISMATCH: Expected version '$resolvedExpectedVersion' but running service reported '$reportedVersion'."
    }
}

if (-not [string]::IsNullOrWhiteSpace($resolvedExpectedCommit)) {
    if ([string]::IsNullOrWhiteSpace($reportedCommit) -or $reportedCommit -eq "unknown") {
        $errors += "COMMIT_MISMATCH: Expected commit '$resolvedExpectedCommit' but running service reported '$reportedCommit'."
    } elseif (-not ($reportedCommit.StartsWith($resolvedExpectedCommit, [System.StringComparison]::OrdinalIgnoreCase) -or $resolvedExpectedCommit.StartsWith($reportedCommit, [System.StringComparison]::OrdinalIgnoreCase))) {
        $errors += "COMMIT_MISMATCH: Expected commit '$resolvedExpectedCommit' but running service reported '$reportedCommit'."
    }
}

$overallOk = ($errors.Count -eq 0)

$report = @{
    ok                 = $overallOk
    timestamp          = (Get-Date).ToString("o")
    host               = $HostName
    port               = $Port
    serviceName        = $ServiceName
    serviceStatus      = $serviceStatus
    servicePid         = $servicePid
    listeningPid       = $listeningPid
    portOwnedByService = $portOwnedByService
    tlsCertificate     = $tlsCheck
    frontendStatus     = $frontendRes.statusCode
    livenessStatus     = $liveRes.statusCode
    readinessStatus    = $readyRes.statusCode
    mainHealthStatus   = $healthRes.statusCode
    databaseConnected  = $dbConnected
    expectedVersion    = $resolvedExpectedVersion
    reportedVersion    = $reportedVersion
    expectedCommit     = $resolvedExpectedCommit
    reportedCommit     = $reportedCommit
    errors             = $errors
}

if ($Json) {
    Write-Output ($report | ConvertTo-Json -Depth 7)
} else {
    Write-Host "=================================================================" -ForegroundColor Cyan
    Write-Host " Sam_Att V2 Standalone - Strict Production Health Check" -ForegroundColor Cyan
    Write-Host "=================================================================" -ForegroundColor Cyan
    Write-Host "Target Endpoint    : $baseUrl"
    Write-Host "Windows Service    : $ServiceName ($serviceStatus, ServicePID=$servicePid, PortPID=$listeningPid, Owned=$portOwnedByService)"
    Write-Host "TLS Certificate    : $(if ($tlsCheck.ok) { 'TRUSTED & VALID' } else { 'FAILED' }) (Subject=$($tlsCheck.subject), ValidUntil=$($tlsCheck.notAfter))"
    Write-Host "Frontend (/Sam_Att): HTTP $($frontendRes.statusCode)"
    Write-Host "Liveness (/live)   : HTTP $($liveRes.statusCode)"
    Write-Host "Readiness (/ready) : HTTP $($readyRes.statusCode)"
    Write-Host "Main Health        : HTTP $($healthRes.statusCode) (DatabaseConnected=$dbConnected)"
    Write-Host "Release Version    : Reported='$reportedVersion' Expected='$resolvedExpectedVersion'"
    Write-Host "Release Commit     : Reported='$reportedCommit' Expected='$resolvedExpectedCommit'"
    if ($errors.Count -gt 0) {
        Write-Host "-----------------------------------------------------------------" -ForegroundColor Red
        foreach ($e in $errors) {
            Write-Host " [FAIL] $e" -ForegroundColor Red
        }
    } else {
        Write-Host "-----------------------------------------------------------------" -ForegroundColor Green
        Write-Host " [PASS] All Production Health & TLS Trust Checks Succeeded." -ForegroundColor Green
    }
    Write-Host "=================================================================" -ForegroundColor Cyan
}

if (-not $overallOk) {
    exit 1
}
exit 0
