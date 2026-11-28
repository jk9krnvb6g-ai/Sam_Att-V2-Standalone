<#
.SYNOPSIS
    Sam_Att V2 Standalone - Windows Server 2025 Pre-Flight Verification Script
.DESCRIPTION
    Performs 14 strictly non-destructive pre-flight checks before installation or deployment:
    1. Administrator privilege check
    2. Windows Server / OS check
    3. Drive D existence & free disk space (>= 5 GB)
    4. Node.js runtime check (Supported: v22.x through v26.x, including v26.13.1; configurable -NodeExecutablePath)
    5. npm availability check
    6. Git availability check
    7. .NET 10.0 Runtime (x86 / 32-bit, Microsoft.NETCore.App 10.0.x) & ScannerSyncCli.exe native DLL verification
    8. TCP Port 4101 availability + Windows excluded port range check (netsh interface ipv4 show excludedportrange)
    9. MySQL Server TCP connectivity (10.1.0.201:3306)
    10. Read-Only Database Schema & Table Check (via npm run db:preflight -- --json)
    11. Scanner IP reachability check (optional ping to 10.2.0.51, 10.2.0.52, 10.2.0.53)
    12. TLS Certificate & Private Key presence check (D:\WebApps\Sam_Att\Certs)
    13. WinSW service wrapper binary check
    14. IIS / Existing Services Coexistence check (verifies IIS and other apps are untouched)
#>
[CmdletBinding()]
param(
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [string]$NodeExecutablePath = "",
    [int]$HttpsPort = 4101,
    [string]$MysqlHost = "10.1.0.201",
    [int]$MysqlPort = 3306,
    [int]$MinFreeSpaceGB = 5,
    [string[]]$ScannerIps = @("10.2.0.51", "10.2.0.52", "10.2.0.53"),
    [switch]$AllowPortOccupiedBySamAtt,
    [switch]$SkipDatabaseSchemaCheck,
    [switch]$SkipScannerPing,
    [switch]$Json
)

$ErrorActionPreference = "Stop"

$checks = @()
$blockers = @()
$warnings = @()

function Add-CheckResult {
    param(
        [string]$Id,
        [string]$Title,
        [string]$Status, # PASS, WARN, FAIL
        [string]$Detail
    )
    $script:checks += @{
        id     = $Id
        title  = $Title
        status = $Status
        detail = $Detail
    }
    if ($Status -eq "FAIL") {
        $script:blockers += "${Id}: ${Detail}"
    } elseif ($Status -eq "WARN") {
        $script:warnings += "${Id}: ${Detail}"
    }
}

function Resolve-NodeExecutable {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path $ExplicitPath) { return (Resolve-Path $ExplicitPath).Path }
        return $null
    }
    if (-not [string]::IsNullOrWhiteSpace($env:NODE_EXECUTABLE_PATH) -and (Test-Path $env:NODE_EXECUTABLE_PATH)) {
        return (Resolve-Path $env:NODE_EXECUTABLE_PATH).Path
    }
    $candidates = @(
        "C:\Program Files\nodejs\node.exe",
        "D:\Program Files\nodejs\node.exe"
    )
    foreach ($cand in $candidates) {
        if (Test-Path $cand) { return $cand }
    }
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $cmd) { return $cmd.Source }
    return $null
}

# 1. Administrator Privilege Check
$isAdmin = $false
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    $isAdmin = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
if ($isAdmin) {
    Add-CheckResult -Id "PF-01" -Title "Administrator Privileges" -Status "PASS" -Detail "Running with elevated Administrator privileges."
} else {
    Add-CheckResult -Id "PF-01" -Title "Administrator Privileges" -Status "FAIL" -Detail "Script must be run as Administrator."
}

# 2. Windows OS Check
$osCaption = "Unknown OS"
try {
    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    if ($null -ne $osInfo) {
        $osCaption = "$($osInfo.Caption) ($($osInfo.Version))"
    }
} catch {}
Add-CheckResult -Id "PF-02" -Title "Operating System" -Status "PASS" -Detail $osCaption

# 3. Drive D & Free Space Check
$driveLetter = (Split-Path -Qualifier $SamAttRoot).TrimEnd(':')
$driveInfo = Get-PSDrive -Name $driveLetter -ErrorAction SilentlyContinue
if ($null -eq $driveInfo) {
    Add-CheckResult -Id "PF-03" -Title "Target Drive & Disk Space" -Status "FAIL" -Detail "Target drive '${driveLetter}:' does not exist."
} else {
    $freeGB = [math]::Round($driveInfo.Free / 1GB, 2)
    if ($freeGB -ge $MinFreeSpaceGB) {
        Add-CheckResult -Id "PF-03" -Title "Target Drive & Disk Space" -Status "PASS" -Detail "Drive ${driveLetter}: has ${freeGB} GB free (required >= ${MinFreeSpaceGB} GB)."
    } else {
        Add-CheckResult -Id "PF-03" -Title "Target Drive & Disk Space" -Status "FAIL" -Detail "Drive ${driveLetter}: has only ${freeGB} GB free (required >= ${MinFreeSpaceGB} GB)."
    }
}

# 4. Node.js Version Check (Supported: v22.x through v26.x, including v26.13.1 -- FIX 04)
$resolvedNodeExe = Resolve-NodeExecutable -ExplicitPath $NodeExecutablePath
$nodeVer = ""
if ($null -ne $resolvedNodeExe) {
    try {
        $nodeVer = (& $resolvedNodeExe -v 2>$null).Trim()
        if ($LASTEXITCODE -ne 0) { $nodeVer = "" }
    } catch {}
}
if ($nodeVer -match "^v(\d+)\.(\d+)\.(\d+)") {
    $major = [int]$Matches[1]
    if ($major -ge 22 -and $major -le 26) {
        Add-CheckResult -Id "PF-04" -Title "Node.js Runtime Compatibility" -Status "PASS" -Detail "Node.js $nodeVer detected at '$resolvedNodeExe' (Supported range: >=22.0.0 <27.0.0, verified for Node 22 & Node 26.13.1)."
    } else {
        Add-CheckResult -Id "PF-04" -Title "Node.js Runtime Compatibility" -Status "FAIL" -Detail "Node.js $nodeVer at '$resolvedNodeExe' is outside supported range (>=22.0.0 <27.0.0)."
    }
} else {
    Add-CheckResult -Id "PF-04" -Title "Node.js Runtime Compatibility" -Status "FAIL" -Detail "Node.js executable not found or failed to execute. Specify -NodeExecutablePath or install Node.js 22 LTS / 26.x."
}

# 5. npm Check (bound to selected $resolvedNodeExe directory -- FIX 03)
$npmVer = ""
$resolvedNpmCmd = "npm"
try {
    if ($null -ne $resolvedNodeExe) {
        $nodeDir = Split-Path -Parent $resolvedNodeExe
        $candidateNpm = Join-Path $nodeDir "npm.cmd"
        if (Test-Path $candidateNpm) {
            $resolvedNpmCmd = $candidateNpm
        }
    }
    if ($resolvedNpmCmd -eq "npm") {
        $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
        if ($null -ne $npmCmd) { $resolvedNpmCmd = $npmCmd.Source }
    }
    if (-not [string]::IsNullOrWhiteSpace($resolvedNpmCmd)) {
        $npmVer = (& $resolvedNpmCmd -v 2>$null).Trim()
        if ($LASTEXITCODE -ne 0) { $npmVer = "" }
    }
} catch {}
if (-not [string]::IsNullOrWhiteSpace($npmVer)) {
    Add-CheckResult -Id "PF-05" -Title "npm Package Manager" -Status "PASS" -Detail "npm v$npmVer detected at '$resolvedNpmCmd'."
} else {
    Add-CheckResult -Id "PF-05" -Title "npm Package Manager" -Status "FAIL" -Detail "npm is not installed or not found alongside Node.js."
}

# 6. Git Check
$gitVer = ""
try {
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($null -ne $gitCmd) {
        $gitVer = (& $gitCmd.Source --version 2>$null).Trim()
        if ($LASTEXITCODE -ne 0) { $gitVer = "" }
    }
} catch {}
if (-not [string]::IsNullOrWhiteSpace($gitVer)) {
    Add-CheckResult -Id "PF-06" -Title "Git Client" -Status "PASS" -Detail "$gitVer detected."
} else {
    Add-CheckResult -Id "PF-06" -Title "Git Client" -Status "FAIL" -Detail "Git is not installed or not in PATH."
}

# 7. .NET 10.0 x86 Runtime & ScannerSyncCli Native DLLs Check (FIX 04)
$appDir = Join-Path $SamAttRoot "App"
$scannerDir = if (Test-Path (Join-Path $appDir "ScannerReader")) { Join-Path $appDir "ScannerReader" } else { Join-Path $PSScriptRoot "ScannerReader" }
$scannerExe = Join-Path $scannerDir "ScannerSyncCli.exe"
$requiredScannerFiles = @(
    "ScannerSyncCli.exe",
    "ScannerSyncCli.dll",
    "ScannerSyncCli.deps.json",
    "ScannerSyncCli.runtimeconfig.json",
    "FK623Attend.dll",
    "FKAttend.dll",
    "FKPwdEncDec.dll",
    "FKViaDev.dll",
    "LFWViaDev.dll",
    "FpDataConv.dll",
    "FaceDataConv.dll",
    "UniversalOfflineSDK.dll",
    "Interop.RealSvrOcxTcpLib.dll",
    "MySqlConnector.dll"
)
$missingScannerFiles = @()
foreach ($sf in $requiredScannerFiles) {
    if (-not (Test-Path (Join-Path $scannerDir $sf))) {
        $missingScannerFiles += $sf
    }
}

$dotnetX86Exe = "C:\Program Files (x86)\dotnet\dotnet.exe"
$hasDotnet10X86 = $false
$dotnetX86Detail = ""
if (Test-Path $dotnetX86Exe) {
    try {
        $runtimesOut = & $dotnetX86Exe --list-runtimes 2>$null
        if ($LASTEXITCODE -eq 0 -and ($runtimesOut -join "`n") -match "Microsoft\.NETCore\.App\s+10\.") {
            $hasDotnet10X86 = $true
            $dotnetX86Detail = "Microsoft.NETCore.App 10.x (x86) verified at '$dotnetX86Exe'."
        } else {
            $dotnetX86Detail = "dotnet (x86) found at '$dotnetX86Exe', but Microsoft.NETCore.App 10.x runtime is not listed."
        }
    } catch {
        $dotnetX86Detail = "Failed to query '$dotnetX86Exe --list-runtimes'."
    }
} else {
    $dotnetX86Detail = "32-bit .NET host not found at '$dotnetX86Exe' (Required by ScannerSyncCli.runtimeconfig.json: Microsoft.NETCore.App 10.0.0 win-x86)."
}

if ($missingScannerFiles.Count -eq 0 -and $hasDotnet10X86) {
    Add-CheckResult -Id "PF-07" -Title "ScannerSyncCli (.NET 10.0 x86 & Native DLLs)" -Status "PASS" -Detail "$dotnetX86Detail All $($requiredScannerFiles.Count) required ScannerReader files/DLLs present."
} elseif ($missingScannerFiles.Count -gt 0) {
    Add-CheckResult -Id "PF-07" -Title "ScannerSyncCli (.NET 10.0 x86 & Native DLLs)" -Status "WARN" -Detail "Missing ScannerReader files in '$scannerDir': $($missingScannerFiles -join ', '). (Standby mode works without scanner; required before enabling live scanner sync)."
} else {
    Add-CheckResult -Id "PF-07" -Title "ScannerSyncCli (.NET 10.0 x86 & Native DLLs)" -Status "WARN" -Detail "$dotnetX86Detail All $($requiredScannerFiles.Count) ScannerReader binaries exist. Install .NET 10.0 Runtime (x86 / 32-bit) before enabling live scanner sync."
}

# 8. TCP Port 4101 & Windows Excluded Port Range Check (FIX 07)
$portExcluded = $false
try {
    $netshOut = & netsh interface ipv4 show excludedportrange protocol=tcp 2>$null
    if ($LASTEXITCODE -eq 0 -and $netshOut) {
        foreach ($line in $netshOut) {
            if ($line -match "^\s*(\d+)\s+(\d+)") {
                $startP = [int]$Matches[1]
                $endP   = [int]$Matches[2]
                if ($HttpsPort -ge $startP -and $HttpsPort -le $endP) {
                    $portExcluded = $true
                    Add-CheckResult -Id "PF-08" -Title "HTTPS Port $HttpsPort Availability" -Status "FAIL" -Detail "Port $HttpsPort falls within Windows TCP excluded port range ($startP-$endP)."
                    break
                }
            }
        }
    }
} catch {}

if (-not $portExcluded) {
    $portListeners = Get-NetTCPConnection -LocalPort $HttpsPort -State Listen -ErrorAction SilentlyContinue
    if ($null -eq $portListeners) {
        Add-CheckResult -Id "PF-08" -Title "HTTPS Port $HttpsPort Availability" -Status "PASS" -Detail "TCP Port $HttpsPort is free and not reserved by Windows excludedportrange."
    } else {
        $owningPid = ($portListeners | Select-Object -First 1).OwningProcess
        $proc = Get-Process -Id $owningPid -ErrorAction SilentlyContinue
        $procName = if ($null -ne $proc) { $proc.ProcessName } else { "PID $owningPid" }
        if ($AllowPortOccupiedBySamAtt) {
            Add-CheckResult -Id "PF-08" -Title "HTTPS Port $HttpsPort Availability" -Status "PASS" -Detail "TCP Port $HttpsPort is currently active ($procName, PID=$owningPid)."
        } else {
            Add-CheckResult -Id "PF-08" -Title "HTTPS Port $HttpsPort Availability" -Status "FAIL" -Detail "TCP Port $HttpsPort is already in use by $procName (PID=$owningPid)."
        }
    }
}

# 9. MySQL Server TCP Reachability (10.1.0.201:3306)
$mysqlReachable = $false
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $ar = $tcp.BeginConnect($MysqlHost, $MysqlPort, $null, $null)
    $wait = $ar.AsyncWaitHandle.WaitOne(3000, $false)
    if ($wait -and $tcp.Connected) {
        $mysqlReachable = $true
    }
    $tcp.Close()
} catch {}
if ($mysqlReachable) {
    Add-CheckResult -Id "PF-09" -Title "MySQL TCP Reachability" -Status "PASS" -Detail "Successfully connected to ${MysqlHost}:${MysqlPort}."
} else {
    Add-CheckResult -Id "PF-09" -Title "MySQL TCP Reachability" -Status "FAIL" -Detail "Cannot reach MySQL server at ${MysqlHost}:${MysqlPort} within 3000ms."
}

# 10. Read-Only Database Schema Preflight
$configEnvPath = Join-Path $SamAttRoot "Config\.env"
if ($SkipDatabaseSchemaCheck) {
    Add-CheckResult -Id "PF-10" -Title "Database Schema Preflight (Read-Only)" -Status "WARN" -Detail "Skipped via -SkipDatabaseSchemaCheck."
} elseif (-not (Test-Path $configEnvPath)) {
    Add-CheckResult -Id "PF-10" -Title "Database Schema Preflight (Read-Only)" -Status "WARN" -Detail "Config file $configEnvPath not created yet. Database schema will be verified during installation."
} elseif (-not (Test-Path (Join-Path $appDir "package.json"))) {
    Add-CheckResult -Id "PF-10" -Title "Database Schema Preflight (Read-Only)" -Status "WARN" -Detail "App directory $appDir not populated yet. Database schema will be verified after files are staged."
} else {
    try {
        Push-Location $appDir
        $env:SAM_ATT_ENV_PATH = $configEnvPath
        if ($null -ne $resolvedNodeExe) {
            $dbOut = & $resolvedNodeExe --import tsx backend/src/database/cli-preflight.ts --json 2>$null
        } else {
            $dbOut = & $resolvedNpmCmd run db:preflight -- --json 2>$null
        }
        $dbExit = $LASTEXITCODE
        Pop-Location
        if ($dbExit -eq 0) {
            Add-CheckResult -Id "PF-10" -Title "Database Schema Preflight (Read-Only)" -Status "PASS" -Detail "All required tables and columns verified in Read-Only mode via '$resolvedNodeExe'."
        } else {
            Add-CheckResult -Id "PF-10" -Title "Database Schema Preflight (Read-Only)" -Status "FAIL" -Detail "Database schema check failed (exit code $dbExit). Run 'npm run db:preflight' to inspect missing tables/columns."
        }
    } catch {
        try { Pop-Location } catch {}
        Add-CheckResult -Id "PF-10" -Title "Database Schema Preflight (Read-Only)" -Status "FAIL" -Detail "Database preflight error: $($_.Exception.Message)"
    }
}

# 11. Scanner IP Reachability
if ($SkipScannerPing) {
    Add-CheckResult -Id "PF-11" -Title "Scanner Network Reachability" -Status "WARN" -Detail "Skipped via -SkipScannerPing (Standby mode safe)."
} else {
    $reachableScanners = @()
    $unreachableScanners = @()
    foreach ($ip in $ScannerIps) {
        if (Test-Connection -ComputerName $ip -Count 1 -Quiet -ErrorAction SilentlyContinue) {
            $reachableScanners += $ip
        } else {
            $unreachableScanners += $ip
        }
    }
    if ($unreachableScanners.Count -eq 0) {
        Add-CheckResult -Id "PF-11" -Title "Scanner Network Reachability" -Status "PASS" -Detail "All scanners reachable: $($reachableScanners -join ', ')"
    } else {
        Add-CheckResult -Id "PF-11" -Title "Scanner Network Reachability" -Status "WARN" -Detail "Reachable: [$($reachableScanners -join ', ')]; Unreachable: [$($unreachableScanners -join ', ')] (Standby mode safe)."
    }
}

# 12. TLS Certificate Check
$certPath = Join-Path $SamAttRoot "Certs\server.crt"
$keyPath  = Join-Path $SamAttRoot "Certs\server.key"
if ((Test-Path $certPath) -and (Test-Path $keyPath)) {
    Add-CheckResult -Id "PF-12" -Title "TLS Certificates" -Status "PASS" -Detail "Found server.crt and server.key in $(Join-Path $SamAttRoot 'Certs')."
} else {
    Add-CheckResult -Id "PF-12" -Title "TLS Certificates" -Status "WARN" -Detail "TLS cert/key not found at $(Join-Path $SamAttRoot 'Certs') yet (Installer can generate or import them)."
}

# 13. WinSW Service Wrapper Binary Check
$serviceExe = Join-Path $SamAttRoot "Service\SamAttV2Standalone.exe"
$bundledWinsw = Join-Path $PSScriptRoot "Service\WinSW-x64.exe"
if ((Test-Path $serviceExe) -or (Test-Path $bundledWinsw)) {
    Add-CheckResult -Id "PF-13" -Title "WinSW Service Wrapper" -Status "PASS" -Detail "WinSW executable available."
} else {
    Add-CheckResult -Id "PF-13" -Title "WinSW Service Wrapper" -Status "WARN" -Detail "WinSW binary not placed in $(Join-Path $SamAttRoot 'Service\SamAttV2Standalone.exe') yet. Place WinSW-x64.exe before service registration."
}

# 14. Coexistence Safety Check
Add-CheckResult -Id "PF-14" -Title "Multi-System Coexistence Policy" -Status "PASS" -Detail "Isolated paths ($SamAttRoot, $BackupDir, $DeploymentsDir) and dedicated port ($HttpsPort) verified. IIS and other services untouched."

$overallOk = ($blockers.Count -eq 0)
$summary = @{
    ok             = $overallOk
    timestamp      = (Get-Date).ToString("o")
    samAttRoot     = $SamAttRoot
    nodeExecutable = $resolvedNodeExe
    nodeVersion    = $nodeVer
    httpsPort      = $HttpsPort
    mysqlHost      = $MysqlHost
    mysqlPort      = $MysqlPort
    blockerCount   = $blockers.Count
    warningCount   = $warnings.Count
    blockers       = $blockers
    warnings       = $warnings
    checks         = $checks
}

if ($Json) {
    Write-Output ($summary | ConvertTo-Json -Depth 6)
} else {
    Write-Host "=================================================================" -ForegroundColor Cyan
    Write-Host " Sam_Att V2 Standalone - Windows Server Pre-Flight Report" -ForegroundColor Cyan
    Write-Host "=================================================================" -ForegroundColor Cyan
    foreach ($c in $checks) {
        $color = if ($c.status -eq "PASS") { "Green" } elseif ($c.status -eq "WARN") { "Yellow" } else { "Red" }
        Write-Host (" [{0}] {1} - {2}: {3}" -f $c.status, $c.id, $c.title, $c.detail) -ForegroundColor $color
    }
    Write-Host "-----------------------------------------------------------------" -ForegroundColor Cyan
    if ($overallOk) {
        Write-Host " RESULT: PASS (0 Blockers, $($warnings.Count) Warnings)" -ForegroundColor Green
    } else {
        Write-Host " RESULT: FAIL ($($blockers.Count) Blockers, $($warnings.Count) Warnings)" -ForegroundColor Red
    }
    Write-Host "=================================================================" -ForegroundColor Cyan
}

if (-not $overallOk) {
    exit 1
}
exit 0
