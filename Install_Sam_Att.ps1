<#
.SYNOPSIS
    Sam_Att V2 Standalone - Windows Server 2025 Production Installer & Lifecycle Manager
.DESCRIPTION
    Supports 4 Modes:
    - FreshInstall : Sets up standard directory structure on Drive D (D:\WebApps\Sam_Att),
                     refuses to overwrite an existing installation unless -Mode Repair or Upgrade is used,
                     runs Preflight, copies application files, prompts or generates production .env
                     outside Git repository (D:\WebApps\Sam_Att\Config\.env) with lossless special-character
                     password quoting and restricted NTFS ACLs, configures TLS certificates in
                     D:\WebApps\Sam_Att\Certs, registers WinSW service SamAttV2Standalone, creates scoped
                     Windows Firewall rule for TCP 4101 only (with explicit administrator-provided
                     FirewallRemoteAddress), starts service, and runs strict HealthCheck.
    - Upgrade      : Performs safe application-only upgrade via Deploy_Sam_Att.ps1.
    - Repair       : Re-applies directory structure, NTFS ACLs, WinSW XML, scoped Firewall Rule,
                     and restarts SamAttV2Standalone without overwriting Config\.env or Certs.
    - PreflightOnly: Runs Preflight_Sam_Att.ps1 and exits without making changes.

    Safety Rules (FIX 01 - FIX 07):
    - Never modifies, migrates, drops, or seeds the production MySQL database.
    - Requires explicit administrator confirmation for DbHost, DbPort, DbName, DbUser.
    - Never opens any firewall port other than TCP 4101 and has NO broad default FirewallRemoteAddress.
    - Keeps SCANNER_AUTO_SCHEDULER_ENABLED=false (Standby Mode) until explicit Cutover approval.
    - Uses Shared Lifecycle Lock (D:\Deployments\Sam_Att\lifecycle.lock).
    - In -DryRun or -WhatIf mode, performs zero modifications to disk, lock files, service, or firewall.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidateSet("FreshInstall", "Upgrade", "Repair", "PreflightOnly")]
    [string]$Mode = "FreshInstall",
    [string]$SamAttRoot = "D:\WebApps\Sam_Att",
    [string]$BackupDir = "D:\Backups\Sam_Att",
    [string]$DeploymentsDir = "D:\Deployments\Sam_Att",
    [string]$ServiceName = "SamAttV2Standalone",
    [string]$NodeExecutablePath = "",
    [int]$HttpsPort = 4101,
    [string]$ServerIpSan = "10.2.0.23",
    [string]$DbHost = "10.1.0.201",
    [int]$DbPort = 3306,
    [string]$DbName = "samchuk_attendance_v2",
    [string]$DbUser = "sam_att_app",
    [string]$DbPassword = "",
    [switch]$ConfirmDatabaseTarget,
    [string]$HosOfficeHost = "10.1.0.201",
    [int]$HosOfficePort = 3306,
    [string]$HosOfficeDbName = "hosoffice",
    [string]$HosOfficeUser = "hosoffice_readonly",
    [string]$HosOfficePassword = "",
    [string]$FirewallRemoteAddress = "",
    [string]$ServiceAccount = "",
    [string]$TrustInternalCaCertPath = "",
    [switch]$GenerateSelfSignedCertIfMissing,
    [switch]$TrustGeneratedCertInLocalMachineRoot,
    [switch]$EnableScannerAutoScheduler,
    [switch]$NonInteractive,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$AppDir     = Join-Path $SamAttRoot "App"
$ConfigDir  = Join-Path $SamAttRoot "Config"
$LogsDir    = Join-Path $SamAttRoot "Logs"
$ServiceDir = Join-Path $SamAttRoot "Service"
$CertsDir   = Join-Path $SamAttRoot "Certs"
$EnvFilePath = Join-Path $ConfigDir ".env"
$CertPath    = Join-Path $CertsDir "server.crt"
$KeyPath     = Join-Path $CertsDir "server.key"
$LockFilePath = Join-Path $DeploymentsDir "lifecycle.lock"

$isDryRunMode = ($DryRun -or $WhatIfPreference)

if ($HttpsPort -ne 4101) {
    throw "FORBIDDEN_FIREWALL_PORT: Production installer only permits TCP port 4101 (requested: $HttpsPort)."
}

function Write-StepHeader {
    param([string]$Step, [string]$Message)
    Write-Host ""
    Write-Host "[$Step] $Message" -ForegroundColor Cyan
}

function Resolve-NodeExecutable {
    param([string]$ExplicitPath)
    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path $ExplicitPath) { return (Resolve-Path $ExplicitPath).Path }
        return $ExplicitPath
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
    return "C:\Program Files\nodejs\node.exe"
}

function New-CryptographicHexSecret {
    param([int]$ByteLength = 32)
    $bytes = New-Object byte[] $ByteLength
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
}

function Format-EnvValueSafe {
    param([string]$RawVal)
    if ($null -eq $RawVal) { return "" }
    if ($RawVal -match "[\r\n\0]") {
        throw "INVALID_ENV_VALUE: Value must not contain newline or null character."
    }
    if ($RawVal -eq "") { return "" }
    if ($RawVal -match '[#$&"''\s\\;]') {
        $escaped = $RawVal.Replace('\', '\\').Replace('"', '\"')
        return "`"$escaped`""
    }
    return $RawVal
}

function Read-DotEnvFileSafe {
    param([string]$Path)
    $map = @{}
    if (-not (Test-Path $Path)) { return $map }
    $lines = Get-Content -Path $Path -Encoding UTF8
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) { continue }
        if ($trimmed -match "^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$") {
            $k = $Matches[1].Trim()
            $v = $Matches[2]
            if ($v.Length -ge 2 -and $v.StartsWith('"') -and $v.EndsWith('"')) {
                $inner = $v.Substring(1, $v.Length - 2)
                $v = $inner.Replace('\"', '"').Replace('\\', '\')
            } elseif ($v.Length -ge 2 -and $v.StartsWith("'") -and $v.EndsWith("'")) {
                $inner = $v.Substring(1, $v.Length - 2)
                $v = $inner.Replace("\'", "'").Replace('\\', '\')
            } else {
                $v = $v.Trim()
            }
            $map[$k] = $v
        }
    }
    return $map
}

function Set-RestrictedFileAcl {
    param(
        [string]$TargetPath,
        [string]$ExtraAccount,
        [switch]$IsDirectory
    )
    if (-not (Test-Path $TargetPath)) { return }
    $grantSuffix = if ($IsDirectory) { "(OI)(CI)F" } else { "F" }
    $readSuffix  = if ($IsDirectory) { "(OI)(CI)RX" } else { "R" }

    & icacls $TargetPath /inheritance:r | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "ICACLS_INHERITANCE_FAILED: icacls failed disabling inheritance on $TargetPath (ExitCode=$LASTEXITCODE)"
    }
    & icacls $TargetPath /grant:r "*S-1-5-18:${grantSuffix}" "*S-1-5-32-544:${grantSuffix}" | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "ICACLS_GRANT_FAILED: icacls failed granting SYSTEM/Administrators on $TargetPath (ExitCode=$LASTEXITCODE)"
    }
    if (-not [string]::IsNullOrWhiteSpace($ExtraAccount)) {
        & icacls $TargetPath /grant:r "${ExtraAccount}:${readSuffix}" | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw "ICACLS_SERVICE_ACCOUNT_FAILED: icacls failed granting $ExtraAccount on $TargetPath (ExitCode=$LASTEXITCODE)"
        }
    }
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

# Handle PreflightOnly Mode immediately
$preflightScript = Join-Path $PSScriptRoot "Preflight_Sam_Att.ps1"
if ($Mode -eq "PreflightOnly") {
    & $preflightScript -SamAttRoot $SamAttRoot -BackupDir $BackupDir -DeploymentsDir $DeploymentsDir -NodeExecutablePath $NodeExecutablePath -HttpsPort $HttpsPort -MysqlHost $DbHost -MysqlPort $DbPort
    exit $LASTEXITCODE
}

# Handle Upgrade Mode by delegating to Deploy_Sam_Att.ps1
if ($Mode -eq "Upgrade") {
    $deployScript = Join-Path $PSScriptRoot "Deploy_Sam_Att.ps1"
    if (-not (Test-Path $deployScript)) {
        throw "DEPLOY_SCRIPT_NOT_FOUND: $deployScript not found."
    }
    $deployArgs = @{
        SamAttRoot         = $SamAttRoot
        BackupRootDir      = $BackupDir
        DeploymentsDir     = $DeploymentsDir
        ServiceName        = $ServiceName
        HttpsPort          = $HttpsPort
        HostName           = $ServerIpSan
        NodeExecutablePath = $NodeExecutablePath
    }
    if ($isDryRunMode) { $deployArgs["DryRun"] = $true }
    & $deployScript @deployArgs
    exit $LASTEXITCODE
}

# FreshInstall Guard: Refuse to overwrite existing installation (FIX 07)
if ($Mode -eq "FreshInstall") {
    $existingPkg = Test-Path (Join-Path $AppDir "package.json")
    $existingEnv = Test-Path $EnvFilePath
    $existingSvc = $null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    if ($existingPkg -or $existingEnv -or $existingSvc) {
        throw "EXISTING_INSTALLATION_DETECTED: An existing installation was found (AppPackage=$existingPkg, ConfigEnv=$existingEnv, Service=$existingSvc). FreshInstall refuses to overwrite an existing installation. Use -Mode Repair or -Mode Upgrade."
    }
}

# Firewall Scope Validation (FIX 02 - No broad default allowed!)
if ([string]::IsNullOrWhiteSpace($FirewallRemoteAddress)) {
    if ($NonInteractive -or $isDryRunMode) {
        if ($isDryRunMode -and [string]::IsNullOrWhiteSpace($FirewallRemoteAddress)) {
            $FirewallRemoteAddress = "10.2.0.0/24"
            Write-Host "[DRY-RUN] No -FirewallRemoteAddress supplied; previewing with sample hospital scope '$FirewallRemoteAddress' (In real execution, -FirewallRemoteAddress is mandatory)." -ForegroundColor Yellow
        } else {
            throw "MISSING_FIREWALL_SCOPE: In -NonInteractive mode, you must explicitly specify -FirewallRemoteAddress (for example: -FirewallRemoteAddress '10.2.0.0/24,10.1.0.0/24'). Broad default firewall scopes are prohibited."
        }
    } else {
        Write-Host ""
        Write-Host "--- Windows Firewall Allowed Remote Network Scope (TCP Port 4101 Only) ---" -ForegroundColor Yellow
        $inputScope = Read-Host "Enter allowed remote IP/CIDR scope (e.g. 10.2.0.0/24,10.1.0.0/24)"
        if ([string]::IsNullOrWhiteSpace($inputScope)) {
            throw "MISSING_FIREWALL_SCOPE: FirewallRemoteAddress cannot be empty. Installation aborted."
        }
        $FirewallRemoteAddress = $inputScope.Trim()
    }
}

# Database Target Confirmation (FIX 06)
if ($Mode -eq "FreshInstall") {
    if ($NonInteractive) {
        if (-not $ConfirmDatabaseTarget -and -not $isDryRunMode) {
            throw "DATABASE_TARGET_CONFIRMATION_REQUIRED: In -NonInteractive FreshInstall mode, pass -ConfirmDatabaseTarget after verifying DbHost='$DbHost', DbPort=$DbPort, DbName='$DbName', DbUser='$DbUser'."
        }
        if ([string]::IsNullOrWhiteSpace($DbPassword) -and -not $isDryRunMode) {
            throw "MISSING_DB_PASSWORD: In -NonInteractive FreshInstall mode, -DbPassword is required."
        }
    } elseif (-not $isDryRunMode) {
        Write-Host ""
        Write-Host "--- Production MySQL Database Target Verification (Read-Only Schema Policy) ---" -ForegroundColor Yellow
        $inHost = Read-Host "MySQL Host [$DbHost]"
        if (-not [string]::IsNullOrWhiteSpace($inHost)) { $DbHost = $inHost.Trim() }
        $inPort = Read-Host "MySQL Port [$DbPort]"
        if (-not [string]::IsNullOrWhiteSpace($inPort)) { $DbPort = [int]$inPort.Trim() }
        $inName = Read-Host "MySQL Database Name [$DbName]"
        if (-not [string]::IsNullOrWhiteSpace($inName)) { $DbName = $inName.Trim() }
        $inUser = Read-Host "MySQL Username [$DbUser]"
        if (-not [string]::IsNullOrWhiteSpace($inUser)) { $DbUser = $inUser.Trim() }

        $confirmDb = Read-Host "Confirm connecting to MySQL ${DbHost}:${DbPort}/${DbName} as '${DbUser}'? (type YES to confirm)"
        if ($confirmDb -cne "YES") {
            throw "DATABASE_TARGET_NOT_CONFIRMED: Administrator did not confirm database target with 'YES'."
        }

        if ([string]::IsNullOrWhiteSpace($DbPassword)) {
            $secPwd = Read-Host "Enter MySQL Password for $DbUser@$DbHost" -AsSecureString
            $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPwd)
            $DbPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
        }
        if ([string]::IsNullOrWhiteSpace($HosOfficePassword)) {
            $secHos = Read-Host "Enter HOSOffice MySQL Password for $HosOfficeUser@$HosOfficeHost (or press Enter to set later)" -AsSecureString
            $bstr2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secHos)
            $HosOfficePassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr2)
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr2)
        }
    }
}

$resolvedNodeExe = Resolve-NodeExecutable -ExplicitPath $NodeExecutablePath
$resolvedNodeDir = Split-Path -Parent $resolvedNodeExe
$resolvedNpmCmd  = Join-Path $resolvedNodeDir "npm.cmd"
if (-not (Test-Path $resolvedNpmCmd)) {
    $npmInPath = Get-Command npm -ErrorAction SilentlyContinue
    $resolvedNpmCmd = if ($null -ne $npmInPath) { $npmInPath.Source } else { "npm" }
}
$env:NODE_EXECUTABLE_PATH = $resolvedNodeExe
if (-not [string]::IsNullOrWhiteSpace($resolvedNodeDir) -and (Test-Path $resolvedNodeDir)) {
    $env:PATH = "${resolvedNodeDir};$($env:PATH)"
}

if ($isDryRunMode) {
    Write-Host "=================================================================" -ForegroundColor Yellow
    Write-Host " [DRY-RUN / WHATIF] Sam_Att V2 Standalone Installer ($Mode)" -ForegroundColor Yellow
    Write-Host "=================================================================" -ForegroundColor Yellow
    Write-Host " Target Root           : $SamAttRoot"
    Write-Host " App Directory         : $AppDir"
    Write-Host " Config File           : $EnvFilePath"
    Write-Host " Certs Directory       : $CertsDir"
    Write-Host " Backup Directory      : $BackupDir"
    Write-Host " Lifecycle Lock Path   : $LockFilePath"
    Write-Host " Node.js Executable    : $resolvedNodeExe"
    Write-Host " npm Executable        : $resolvedNpmCmd"
    Write-Host " Database Target       : ${DbUser}@${DbHost}:${DbPort}/${DbName}"
    Write-Host " Firewall Rule         : TCP Port $HttpsPort ONLY -> Scope: $FirewallRemoteAddress"
    Write-Host " Scanner AutoScheduler : $(if ($EnableScannerAutoScheduler) { 'true' } else { 'false (Standby Mode)' })"
    Write-Host " Zero files, lock files, services, or firewall rules were modified." -ForegroundColor Green
    exit 0
}

$lifecycleLockModule = Join-Path $PSScriptRoot "scripts\LifecycleLock.ps1"
if (-not (Test-Path $lifecycleLockModule)) {
    $lifecycleLockModule = Join-Path $AppDir "scripts\LifecycleLock.ps1"
}
if (-not (Test-Path $lifecycleLockModule)) {
    throw "LIFECYCLE_LOCK_ENGINE_MISSING: Could not find scripts\LifecycleLock.ps1"
}
. $lifecycleLockModule

$lockHandle = Acquire-AtomicLifecycleLock -Path $LockFilePath -Operation "INSTALL_$Mode"

try {
    # Step 1: Run Pre-Flight Verification
    Write-StepHeader "1/9" "Running Pre-Flight Verification..."
    $allowPort = ($Mode -eq "Repair")
    & $preflightScript -SamAttRoot $SamAttRoot -BackupDir $BackupDir -DeploymentsDir $DeploymentsDir -NodeExecutablePath $resolvedNodeExe -HttpsPort $HttpsPort -MysqlHost $DbHost -MysqlPort $DbPort -AllowPortOccupiedBySamAtt:$allowPort -SkipDatabaseSchemaCheck
    if ($LASTEXITCODE -ne 0) {
        throw "PREFLIGHT_FAILED: Pre-flight checks did not pass. Resolve blockers before continuing."
    }

    # Step 2: Create Isolated Drive D Directory Structure & Restrict NTFS ACLs (FIX 06)
    Write-StepHeader "2/9" "Creating Standard Directory Structure on Drive D and Applying NTFS ACLs..."
    $dirsToCreate = @($SamAttRoot, $AppDir, $ConfigDir, $LogsDir, $ServiceDir, $CertsDir, $BackupDir, $DeploymentsDir)
    foreach ($d in $dirsToCreate) {
        if (-not (Test-Path $d)) {
            New-Item -ItemType Directory -Path $d -Force | Out-Null
            Write-Host "  Created directory: $d" -ForegroundColor Green
        }
    }
    Set-RestrictedFileAcl -TargetPath $ConfigDir -ExtraAccount $ServiceAccount -IsDirectory
    Set-RestrictedFileAcl -TargetPath $CertsDir -ExtraAccount $ServiceAccount -IsDirectory

    # Step 3: Stage Application Files into D:\WebApps\Sam_Att\App
    Write-StepHeader "3/9" "Staging Application Files into $AppDir..."
    $sourceRoot = $PSScriptRoot
    $resolvedSource = (Resolve-Path $sourceRoot).Path.TrimEnd('\')
    $resolvedTarget = (Resolve-Path $AppDir).Path.TrimEnd('\')

    if ($resolvedSource -ne $resolvedTarget) {
        $roboArgs = @(
            $resolvedSource,
            $resolvedTarget,
            "/E",
            "/XD", "node_modules", "logs",
            "/XF", ".env", "*.sqlite", "*.sqlite-wal", "*.sqlite-shm", "*.key", "*.crt",
            "/NFL", "/NDL", "/NJH", "/NJS", "/NC", "/NS"
        )
        & robocopy @roboArgs | Out-Null
        if ($LASTEXITCODE -ge 8) {
            throw "ROBOCOPY_STAGE_FAILED: Robocopy exited with error code $LASTEXITCODE"
        }
        Write-Host "  Application files copied to $AppDir" -ForegroundColor Green
    } else {
        Write-Host "  Running directly from target AppDir ($AppDir)" -ForegroundColor Gray
    }

    # Step 4: Configure External Production .env (D:\WebApps\Sam_Att\Config\.env) with Lossless Quoting & Strict ACL
    Write-StepHeader "4/9" "Configuring External Production Environment ($EnvFilePath)..."
    if (Test-Path $EnvFilePath) {
        Write-Host "  Existing configuration found at $EnvFilePath (preserved without overwrite)." -ForegroundColor Green
    } else {
        if ([string]::IsNullOrWhiteSpace($HosOfficePassword)) {
            $HosOfficePassword = $DbPassword
        }
        $jwtSecret     = New-CryptographicHexSecret -ByteLength 48
        $scannerToken  = New-CryptographicHexSecret -ByteLength 32
        $autoSchedStr  = if ($EnableScannerAutoScheduler) { "true" } else { "false" }

        $envLines = @(
            "# ============================================================================",
            "# Sam_Att V2 Standalone - Production Configuration (Windows Server 2025)",
            "# Generated: $((Get-Date).ToString('o'))",
            "# Stored outside Git repository at: $EnvFilePath",
            "# ============================================================================",
            "NODE_ENV=production",
            "SAM_ATT_DATA_MODE=REAL",
            "SAM_ATT_DB_ENGINE=mysql",
            "HOST=0.0.0.0",
            "SAM_ATT_HTTPS_PORT=$HttpsPort",
            "PUBLIC_BASE_PATH=/Sam_Att/",
            "API_BASE_PATH=/api/Sam_Att",
            "",
            "# Standard Directory Paths on Drive D",
            "SAM_ATT_ROOT=$(Format-EnvValueSafe $SamAttRoot)",
            "SAM_ATT_APP_DIR=$(Format-EnvValueSafe $AppDir)",
            "SAM_ATT_CONFIG_DIR=$(Format-EnvValueSafe $ConfigDir)",
            "SAM_ATT_LOGS_DIR=$(Format-EnvValueSafe $LogsDir)",
            "SAM_ATT_SERVICE_DIR=$(Format-EnvValueSafe $ServiceDir)",
            "SAM_ATT_CERTS_DIR=$(Format-EnvValueSafe $CertsDir)",
            "SAM_ATT_BACKUP_DIR=$(Format-EnvValueSafe $BackupDir)",
            "SAM_ATT_DEPLOYMENTS_DIR=$(Format-EnvValueSafe $DeploymentsDir)",
            "",
            "# External TLS Certificate Paths",
            "TLS_CERT_PATH=$(Format-EnvValueSafe $CertPath)",
            "TLS_KEY_PATH=$(Format-EnvValueSafe $KeyPath)",
            "",
            "# Primary MySQL Database (samchuk_attendance_v2)",
            "SAM_ATT_DB_HOST=$(Format-EnvValueSafe $DbHost)",
            "SAM_ATT_DB_PORT=$DbPort",
            "SAM_ATT_DB_NAME=$(Format-EnvValueSafe $DbName)",
            "SAM_ATT_DB_USER=$(Format-EnvValueSafe $DbUser)",
            "SAM_ATT_DB_PASSWORD=$(Format-EnvValueSafe $DbPassword)",
            "",
            "# HOSOffice MySQL Database (Read-Only Personnel Sync)",
            "HOSOFFICE_DB_HOST=$(Format-EnvValueSafe $HosOfficeHost)",
            "HOSOFFICE_DB_PORT=$HosOfficePort",
            "HOSOFFICE_DB_NAME=$(Format-EnvValueSafe $HosOfficeDbName)",
            "HOSOFFICE_DB_USER=$(Format-EnvValueSafe $HosOfficeUser)",
            "HOSOFFICE_DB_PASSWORD=$(Format-EnvValueSafe $HosOfficePassword)",
            "HOSOFFICE_HR_PERSON_TABLE=hr_person",
            "HOSOFFICE_LIVE_PUSH_ENABLED=false",
            "",
            "# Cryptographic Secrets (CSPRNG Generated)",
            "JWT_SECRET=$jwtSecret",
            "SESSION_TTL_MINUTES=480",
            "AUTH_RATE_LIMIT_WINDOW_MINUTES=15",
            "AUTH_RATE_LIMIT_MAX_ATTEMPTS=5",
            "SCANNER_INGEST_SHARED_TOKEN=$scannerToken",
            "",
            "# Fingerprint Scanner Configuration (Standby Mode prior to Cutover)",
            "SCANNER_SYNC_ENABLED=true",
            "SCANNER_AUTO_SCHEDULER_ENABLED=$autoSchedStr",
            "SCANNER_READER_EXE_PATH=$(Format-EnvValueSafe (Join-Path $AppDir 'ScannerReader\ScannerSyncCli.exe'))",
            "SCANNER_READER_TIMEOUT_MS=120000",
            "SCANNER_READER_MAX_BUFFER_BYTES=33554432",
            "SCANNER_SYNC_DAYS=3",
            "SCANNER_SYNC_MAX_RANGE_DAYS=90",
            "SCANNER_CLI_PREVIEW_MODE=true",
            "",
            "# GitHub Update Center",
            "GITHUB_REPO=jk9krnvb6g-ai/Sam_Att-V2-Standalone",
            "GITHUB_BRANCH=main"
        )
        $envLines -join "`r`n" | Set-Content -Path $EnvFilePath -Encoding UTF8
        Write-Host "  Created production configuration at $EnvFilePath" -ForegroundColor Green
    }
    Set-RestrictedFileAcl -TargetPath $EnvFilePath -ExtraAccount $ServiceAccount

    # Step 5: Configure TLS Certificates & Strict Private Key ACL (FIX 01 & FIX 06)
    Write-StepHeader "5/9" "Verifying TLS Certificates in $CertsDir..."
    if ((Test-Path $CertPath) -and (Test-Path $KeyPath)) {
        Write-Host "  Existing TLS certificate pair found at $CertsDir" -ForegroundColor Green
    } elseif ($GenerateSelfSignedCertIfMissing) {
        Write-Host "  Generating X.509 v3 Certificate with IP SAN ($ServerIpSan)..." -ForegroundColor Cyan
        Push-Location $AppDir
        try {
            $genScript = "import { ensureTlsCertificates } from './backend/src/server.ts'; ensureTlsCertificates(process.argv[1], process.argv[2], 'production', { allowExplicitGenerateInProduction: true, commonName: process.argv[3], extraIpSans: [process.argv[3]] });"
            & $resolvedNodeExe --import tsx -e $genScript $CertPath $KeyPath $ServerIpSan
            if ($LASTEXITCODE -ne 0) {
                throw "TLS_GENERATION_FAILED: Failed to generate X.509 certificate pair."
            }
            Write-Host "  Generated server.crt and server.key at $CertsDir" -ForegroundColor Green
        } finally {
            Pop-Location
        }
    } else {
        throw "MISSING_TLS_CERTIFICATES: Please place server.crt and server.key in $CertsDir, or re-run with -GenerateSelfSignedCertIfMissing."
    }
    Set-RestrictedFileAcl -TargetPath $KeyPath -ExtraAccount $ServiceAccount

    if (-not [string]::IsNullOrWhiteSpace($TrustInternalCaCertPath)) {
        $thumb = Import-InternalRootCaSafely -CertFilePath $TrustInternalCaCertPath
        Write-Host "  Trusted Internal CA Certificate in Cert:\LocalMachine\Root (Thumbprint: $thumb)" -ForegroundColor Green
    } elseif ($TrustGeneratedCertInLocalMachineRoot -and (Test-Path $CertPath)) {
        $thumb = Import-InternalRootCaSafely -CertFilePath $CertPath
        Write-Host "  Trusted generated Server Certificate in Cert:\LocalMachine\Root (Thumbprint: $thumb)" -ForegroundColor Green
    }

    # Step 6: Install Dependencies, TypeCheck, Lint, Isolated Automated Test Gate, Build Frontend, and Read-Only DB Preflight (FIX 03 & FIX 04)
    Write-StepHeader "6/9" "Running TypeCheck, Lint, Isolated Sandbox Test Gate, Production Build, and Read-Only DB Preflight (using $resolvedNodeExe)..."
    Push-Location $AppDir
    try {
        if (-not (Test-Path (Join-Path $AppDir "node_modules"))) {
            Write-Host "  Running npm ci (via $resolvedNpmCmd)..." -ForegroundColor Cyan
            & $resolvedNpmCmd ci --scripts-prepend-node-path=true
            if ($LASTEXITCODE -ne 0) { throw "NPM_CI_FAILED: npm ci exited with code $LASTEXITCODE" }
        }
        Write-Host "  Running npm run typecheck..." -ForegroundColor Cyan
        & $resolvedNpmCmd run typecheck --scripts-prepend-node-path=true
        if ($LASTEXITCODE -ne 0) { throw "TYPECHECK_FAILED: TypeScript verification failed (ExitCode=$LASTEXITCODE)." }

        Write-Host "  Running npm run lint..." -ForegroundColor Cyan
        & $resolvedNpmCmd run lint --scripts-prepend-node-path=true
        if ($LASTEXITCODE -ne 0) { throw "LINT_FAILED: Lint verification failed (ExitCode=$LASTEXITCODE)." }

        if ($Mode -eq "FreshInstall") {
            Write-Host "  Running Fresh Installation Automated Test Gate in 100% Isolated SQLite Sandbox (disconnected from Production .env and MySQL)..." -ForegroundColor Cyan
            $isolatedSqliteFile = Join-Path ([System.IO.Path]::GetTempPath()) "sam_att_freshinstall_test_$PID.sqlite"
            $isolatedEnvFile    = Join-Path ([System.IO.Path]::GetTempPath()) "sam_att_freshinstall_env_$PID.env"
            @(
                "NODE_ENV=test",
                "SAM_ATT_TEST_ISOLATION=true",
                "SAM_ATT_DB_ENGINE=sqlite_sandbox",
                "SAM_ATT_DATA_MODE=REAL",
                "SAM_ATT_DB_HOST=127.0.0.1",
                "SAM_ATT_SQLITE_PATH=$isolatedSqliteFile"
            ) -join "`r`n" | Set-Content -Path $isolatedEnvFile -Encoding UTF8

            $prevNodeEnv = $env:NODE_ENV
            $prevTestIso = $env:SAM_ATT_TEST_ISOLATION
            $prevDbEng   = $env:SAM_ATT_DB_ENGINE
            $prevDbHost  = $env:SAM_ATT_DB_HOST
            $prevSqlite  = $env:SAM_ATT_SQLITE_PATH
            $prevEnvPath = $env:SAM_ATT_ENV_PATH
            try {
                $env:NODE_ENV               = "test"
                $env:SAM_ATT_TEST_ISOLATION = "true"
                $env:SAM_ATT_DB_ENGINE      = "sqlite_sandbox"
                $env:SAM_ATT_DB_HOST        = "127.0.0.1"
                $env:SAM_ATT_SQLITE_PATH    = $isolatedSqliteFile
                $env:SAM_ATT_ENV_PATH       = $isolatedEnvFile

                & $resolvedNpmCmd test --scripts-prepend-node-path=true
                if ($LASTEXITCODE -ne 0) {
                    throw "FRESH_INSTALL_TEST_GATE_FAILED: Automated test gate failed with exit code $LASTEXITCODE. Installation aborted before service registration."
                }
            } finally {
                $env:NODE_ENV               = $prevNodeEnv
                $env:SAM_ATT_TEST_ISOLATION = $prevTestIso
                $env:SAM_ATT_DB_ENGINE      = $prevDbEng
                $env:SAM_ATT_DB_HOST        = $prevDbHost
                $env:SAM_ATT_SQLITE_PATH    = $prevSqlite
                $env:SAM_ATT_ENV_PATH       = $prevEnvPath
                Remove-Item -Path $isolatedSqliteFile, $isolatedEnvFile -Force -ErrorAction SilentlyContinue
            }
        }

        Write-Host "  Running npm run build..." -ForegroundColor Cyan
        & $resolvedNpmCmd run build --scripts-prepend-node-path=true
        if ($LASTEXITCODE -ne 0) { throw "VITE_BUILD_FAILED: Frontend production build failed (ExitCode=$LASTEXITCODE)." }

        Write-Host "  Running Read-Only Database Preflight (using $resolvedNodeExe and $EnvFilePath)..." -ForegroundColor Cyan
        $env:SAM_ATT_ENV_PATH = $EnvFilePath
        & $resolvedNodeExe --import tsx backend/src/database/cli-preflight.ts
        if ($LASTEXITCODE -ne 0) {
            throw "DATABASE_PREFLIGHT_FAILED: Production MySQL database schema check failed (ExitCode=$LASTEXITCODE). No changes were made to the database."
        }
    } finally {
        Pop-Location
    }

    # Step 7: Configure Scoped Windows Firewall Rule for TCP Port 4101 ONLY (FIX 02)
    Write-StepHeader "7/9" "Configuring Scoped Windows Firewall Rule (TCP Port $HttpsPort Only)..."
    $ruleName = "Sam_Att V2 HTTPS $HttpsPort"
    $remoteAddresses = ($FirewallRemoteAddress -split ",") | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
    if ($remoteAddresses.Count -eq 0) {
        throw "INVALID_FIREWALL_SCOPE: FirewallRemoteAddress resolved to an empty address list."
    }
    $existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($null -ne $existingRule) {
        Set-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort -RemoteAddress $remoteAddresses -Enabled True | Out-Null
        Write-Host "  Updated Windows Firewall Rule '$ruleName' (RemoteAddress: $($remoteAddresses -join ', '))" -ForegroundColor Green
    } else {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Action Allow -Protocol TCP -LocalPort $HttpsPort -RemoteAddress $remoteAddresses -Profile Domain,Private -Description "Sam_Att V2 Standalone HTTPS Port $HttpsPort (Samchuk Hospital)" | Out-Null
        Write-Host "  Created Windows Firewall Rule '$ruleName' (RemoteAddress: $($remoteAddresses -join ', '))" -ForegroundColor Green
    }

    # Step 8: Configure & Register WinSW Windows Service (SamAttV2Standalone) with Configurable NodeExecutablePath (FIX 03 & FIX 04)
    Write-StepHeader "8/9" "Configuring WinSW Windows Service ($ServiceName)..."
    $templateXmlPath = Join-Path $AppDir "scripts\winsw-sam-att.xml"
    $targetXmlPath   = Join-Path $ServiceDir "$ServiceName.xml"
    $targetExePath   = Join-Path $ServiceDir "$ServiceName.exe"

    if (Test-Path $templateXmlPath) {
        $rawXml = Get-Content -Path $templateXmlPath -Raw -Encoding UTF8
        $escapedNodePath = [System.Security.SecurityElement]::Escape($resolvedNodeExe)
        $updatedXml = [regex]::Replace($rawXml, "<executable>.*?</executable>", "<executable>$escapedNodePath</executable>")
        Set-Content -Path $targetXmlPath -Value $updatedXml -Encoding UTF8
        Write-Host "  Deployed WinSW configuration to $targetXmlPath (NodeExecutable=$resolvedNodeExe)" -ForegroundColor Green
    }

    $bundledWinsw = Join-Path $AppDir "Service\WinSW-x64.exe"
    if ((-not (Test-Path $targetExePath)) -and (Test-Path $bundledWinsw)) {
        Copy-Item -Path $bundledWinsw -Destination $targetExePath -Force
    }

    if (Test-Path $targetExePath) {
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if ($null -eq $svc) {
            & $targetExePath install $targetXmlPath | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "WINSW_INSTALL_FAILED: WinSW service installation failed with exit code $LASTEXITCODE"
            }
            Write-Host "  Registered Windows Service '$ServiceName'" -ForegroundColor Green
        }
        Start-Service -Name $ServiceName -ErrorAction Stop
        Write-Host "  Started Windows Service '$ServiceName'" -ForegroundColor Green
        Start-Sleep -Seconds 5
    } else {
        throw "WINSW_BINARY_MISSING: WinSW binary not found at $targetExePath. Place WinSW-x64.exe as $targetExePath and run Install_Sam_Att.ps1 -Mode Repair."
    }

    # Step 9: Post-Install Strict Health Verification (FIX 01 & FIX 03)
    Write-StepHeader "9/9" "Running Strict Production Health Check..."
    $healthScript = Join-Path $AppDir "HealthCheck_Sam_Att.ps1"
    if (Test-Path $healthScript) {
        & $healthScript -HostName $ServerIpSan -Port $HttpsPort -ServiceName $ServiceName -AppDir $AppDir
        if ($LASTEXITCODE -ne 0) {
            throw "POST_INSTALL_HEALTHCHECK_FAILED: Service started, but strict HTTPS/Service HealthCheck did not pass."
        }
    }

    Write-Host ""
    Write-Host "=================================================================" -ForegroundColor Green
    Write-Host " Sam_Att V2 Standalone Installation ($Mode) Completed." -ForegroundColor Green
    Write-Host " URL: https://${ServerIpSan}:${HttpsPort}/Sam_Att/" -ForegroundColor Green
    Write-Host "=================================================================" -ForegroundColor Green
    exit 0
} finally {
    Release-AtomicLifecycleLock -Path $LockFilePath -LockHandle $lockHandle
}
