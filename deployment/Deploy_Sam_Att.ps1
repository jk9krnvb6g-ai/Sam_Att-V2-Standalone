<#
.SYNOPSIS
  Sam_Att V2 Standalone - One-Click Production Deployment & Rollback Script (Samchuk Hospital)
.DESCRIPTION
  Production deployment script for Sam_Att V2 Standalone from GitHub (origin/main) on Windows Server + IIS.
  - Pure 7-bit ASCII source file to guarantee 100% compatibility with Windows PowerShell 5.1 (without BOM issues).
  - Step 1: Preflight Check (Git repo, branch, clean working tree, Node/npm, disk space, .env REAL/mysql, IIS, Port 4101 owner)
  - Step 2: GitHub Update (git fetch & git pull --ff-only; forbids git reset --hard / git clean -fd; gates migrations)
  - Step 3: Backup (Timestamped backup of dist/ and core configuration with SHA-256 manifest)
  - Step 4: Install Dependencies (npm ci / npm install)
  - Step 5: Typecheck / Test / Build (npm run typecheck, isolated sandbox npm test, npm run build -> dist/index.html)
  - Step 6: IIS / Backend Update (Isolated to Sam_Att on Port 4101 only; never touches Procurement or runs iisreset)
  - Step 7: Health Check & Automatic Safe Rollback (https://localhost:4101/Sam_Att/ and /api/Sam_Att/health)
#>
[CmdletBinding()]
param(
  [string]$AppDir = "",
  [string]$Branch = "main",
  [string]$Remote = "origin",
  [int]$Port = 4101,
  [switch]$CheckOnly,
  [switch]$ApproveMigrations,
  [switch]$NonInteractive,
  [switch]$SkipTests,
  [string]$MockEnvFile = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ==============================================================================
# 0. Resolve Application Directory & Logging Paths
# ==============================================================================
if ([string]::IsNullOrWhiteSpace($AppDir)) {
  $ScriptDir = $PSScriptRoot
  if ([string]::IsNullOrWhiteSpace($ScriptDir)) {
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
  }
  if ((Split-Path -Leaf $ScriptDir) -ieq "deployment") {
    $AppDir = Split-Path -Parent $ScriptDir
  } elseif (Test-Path "C:\inetpub\wwwroot\Sam_Att\package.json") {
    $AppDir = "C:\inetpub\wwwroot\Sam_Att"
  } else {
    $AppDir = (Get-Location).Path
  }
}
$AppDir = [System.IO.Path]::GetFullPath($AppDir)

$LogsDir = Join-Path $AppDir "logs"
$BackupsRootDir = Join-Path $AppDir "backups"
$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFilePath = Join-Path $LogsDir "deploy_sam_att_$Timestamp.log"

$ForbiddenServiceNames = @("Procurement", "ProcurementService", "ProcurementPool", "CentralApiGateway", "SamAttGateway", "W3SVC")
$SensitiveSecretsToMask = New-Object System.Collections.Generic.List[string]

$MockConfig = $null
if (-not [string]::IsNullOrWhiteSpace($MockEnvFile)) {
  if (-not (Test-Path $MockEnvFile)) {
    Write-Error "MOCK_ENV_FILE_NOT_FOUND: Mock environment file not found at $MockEnvFile"
    exit 1
  }
  $MockConfig = Get-Content -Path $MockEnvFile -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Register-SensitiveSecret {
  param([string]$SecretValue)
  if (-not [string]::IsNullOrWhiteSpace($SecretValue) -and $SecretValue.Trim().Length -ge 4) {
    $Trimmed = $SecretValue.Trim()
    if (-not $SensitiveSecretsToMask.Contains($Trimmed)) {
      $SensitiveSecretsToMask.Add($Trimmed) | Out-Null
    }
  }
}

function Protect-SensitiveText {
  param([string]$InputText)
  if ([string]::IsNullOrEmpty($InputText)) {
    return ""
  }
  $Sanitized = $InputText
  foreach ($Secret in $SensitiveSecretsToMask) {
    if (-not [string]::IsNullOrEmpty($Secret)) {
      $Sanitized = $Sanitized.Replace($Secret, "***REDACTED***")
    }
  }
  $Sanitized = [regex]::Replace($Sanitized, '(?i)(PASSWORD|SECRET|TOKEN|API_KEY)\s*=\s*([^\s;&"]+)', '$1=***REDACTED***')
  return $Sanitized
}

function Write-DeployLog {
  param(
    [string]$Message,
    [string]$Level = "INFO"
  )
  $SafeMessage = Protect-SensitiveText -InputText $Message
  $Line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')][$Level] $SafeMessage"
  try {
    if (-not (Test-Path $LogsDir)) {
      New-Item -ItemType Directory -Path $LogsDir -Force | Out-Null
    }
    Add-Content -Path $LogFilePath -Value $Line -Encoding UTF8 -ErrorAction SilentlyContinue
  } catch {
    # Ignore early log error
  }
}

function Write-StepResult {
  param(
    [int]$StepNo,
    [int]$TotalSteps,
    [string]$Label,
    [string]$Status
  )
  $PaddedLabel = $Label.PadRight(22, ' ')
  $Line = "[$StepNo/$TotalSteps] $PaddedLabel $Status"
  Write-DeployLog -Message $Line -Level $(if ($Status -eq "PASS") { "INFO" } else { "ERROR" })
  if ($Status -eq "PASS") {
    Write-Host $Line -ForegroundColor Green
  } elseif ($Status -eq "SKIP") {
    Write-Host $Line -ForegroundColor Yellow
  } else {
    Write-Host $Line -ForegroundColor Red
  }
}

function Read-DotEnvFileSafe {
  param([string]$EnvFilePath)
  $Map = @{}
  if (-not (Test-Path $EnvFilePath)) {
    return $Map
  }
  $Lines = Get-Content -Path $EnvFilePath -Encoding UTF8
  foreach ($RawLine in $Lines) {
    $Trimmed = $RawLine.Trim()
    if ([string]::IsNullOrWhiteSpace($Trimmed) -or $Trimmed.StartsWith("#")) {
      continue
    }
    $EqIdx = $Trimmed.IndexOf("=")
    if ($EqIdx -le 0) {
      continue
    }
    $Key = $Trimmed.Substring(0, $EqIdx).Trim()
    $Val = $Trimmed.Substring($EqIdx + 1).Trim()
    if (($Val.StartsWith('"') -and $Val.EndsWith('"')) -or ($Val.StartsWith("'") -and $Val.EndsWith("'"))) {
      if ($Val.Length -ge 2) {
        $Val = $Val.Substring(1, $Val.Length - 2)
      }
    }
    $Map[$Key] = $Val
    if ($Key -match "(?i)(PASSWORD|SECRET|TOKEN|KEY)") {
      Register-SensitiveSecret -SecretValue $Val
    }
  }
  return $Map
}

function Invoke-NativeCli {
  param(
    [Parameter(Mandatory=$true)][string]$Executable,
    [string[]]$Arguments = @()
  )
  $PrevEap = $ErrorActionPreference
  try {
    $ErrorActionPreference = "Continue"
    $OutputLines = & $Executable @Arguments 2>&1
    $ExitCode = if ($null -ne $LASTEXITCODE) { [int]$LASTEXITCODE } else { 0 }
    $CombinedText = ($OutputLines | ForEach-Object { "$_" }) -join "`r`n"
    return [PSCustomObject]@{
      ExitCode = $ExitCode
      Output   = $CombinedText.Trim()
    }
  } finally {
    $ErrorActionPreference = $PrevEap
  }
}

function Invoke-HttpsProbe {
  param(
    [string]$Url,
    [switch]$ParseJson,
    [int]$TimeoutSec = 10
  )
  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["healthProbe"]) {
    $ProbeCfg = $MockConfig.healthProbe
    if ($Url -like "*/api/Sam_Att/health") {
      if ($ProbeCfg.apiReachable -eq $false) {
        throw "HEALTH_API_UNREACHABLE: Cannot connect to $Url"
      }
      return [PSCustomObject]@{
        StatusCode = [int]$ProbeCfg.apiStatusCode
        Json       = $ProbeCfg.apiPayload
      }
    } else {
      if ($ProbeCfg.frontendReachable -eq $false) {
        throw "FRONTEND_HTTPS_UNREACHABLE: Cannot connect to $Url"
      }
      return [PSCustomObject]@{
        StatusCode = [int]$ProbeCfg.frontendStatusCode
        Content    = [string]$ProbeCfg.frontendContent
      }
    }
  }

  # Use Node.js HTTPS client (rejectUnauthorized: false) to avoid Windows PowerShell 5.1 Schannel / TLS 1.3 self-signed certificate errors
  $NodeProbeScript = @"
const https = require('https');
const req = https.get('$Url', { rejectUnauthorized: false, timeout: $($TimeoutSec * 1000) }, (res) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    console.log(JSON.stringify({ statusCode: res.statusCode || 0, body }));
    process.exit(0);
  });
});
req.on('timeout', () => { req.destroy(new Error('TIMEOUT')); });
req.on('error', (err) => { console.error(err.message); process.exit(2); });
"@

  $NodeRes = Invoke-NativeCli -Executable "node" -Arguments @("-e", $NodeProbeScript)
  if ($NodeRes.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($NodeRes.Output)) {
    throw "HTTPS_PROBE_FAILED: Cannot connect to $Url ($($NodeRes.Output))"
  }

  $JsonLine = ($NodeRes.Output -split "`r?`n" | Where-Object { $_.Trim().StartsWith("{") } | Select-Object -Last 1)
  if ([string]::IsNullOrWhiteSpace($JsonLine)) {
    throw "HTTPS_PROBE_INVALID_OUTPUT: Unexpected probe output from $Url"
  }

  $ProbeObj = $JsonLine | ConvertFrom-Json
  if ($ParseJson) {
    $ParsedBody = $ProbeObj.body | ConvertFrom-Json
    return [PSCustomObject]@{
      StatusCode = [int]$ProbeObj.statusCode
      Json       = $ParsedBody
    }
  }

  return [PSCustomObject]@{
    StatusCode = [int]$ProbeObj.statusCode
    Content    = [string]$ProbeObj.body
  }
}

function Test-SamAttHealthEndpoint {
  param(
    [int]$TargetPort = 4101,
    [string]$ExpectedDbEngine = "mysql",
    [string]$ExpectedDbName = "samchuk_attendance_v2",
    [int]$MaxRetries = 6,
    [int]$RetryDelaySec = 2
  )
  $FrontendUrl = "https://127.0.0.1:$TargetPort/Sam_Att/"
  $HealthUrl = "https://127.0.0.1:$TargetPort/api/Sam_Att/health"
  $LastError = ""

  for ($Attempt = 1; $Attempt -le $MaxRetries; $Attempt++) {
    try {
      $FrontRes = Invoke-HttpsProbe -Url $FrontendUrl -TimeoutSec 8
      if ($FrontRes.StatusCode -ne 200) {
        throw "FRONTEND_HTTP_STATUS_$($FrontRes.StatusCode): Frontend $FrontendUrl returned HTTP $($FrontRes.StatusCode) (expected 200)"
      }

      $ApiRes = Invoke-HttpsProbe -Url $HealthUrl -ParseJson -TimeoutSec 8
      if ($ApiRes.StatusCode -ne 200) {
        throw "API_HTTP_STATUS_$($ApiRes.StatusCode): Health API returned HTTP $($ApiRes.StatusCode) (expected 200)"
      }

      $Body = $ApiRes.Json
      if ($null -eq $Body) {
        throw "API_INVALID_JSON: Health API did not return valid JSON"
      }
      if ($Body.status -ne "OK") {
        throw "API_STATUS_NOT_OK: Health API reported status=$($Body.status)"
      }
      if ($Body.service -ne "Sam_Att V2 Standalone") {
        throw "API_WRONG_SERVICE: Unexpected service '$($Body.service)' (expected 'Sam_Att V2 Standalone')"
      }
      if ($null -eq $Body.database -or $Body.database.connected -ne $true) {
        throw "MYSQL_DISCONNECTED: Health API reported database.connected != true"
      }
      if ($Body.database.engine -ne $ExpectedDbEngine) {
        throw "WRONG_DB_ENGINE: Database engine is '$($Body.database.engine)' (expected '$ExpectedDbEngine')"
      }
      if ($Body.database.databaseName -ne $ExpectedDbName) {
        throw "WRONG_DB_NAME: Database name is '$($Body.database.databaseName)' (expected '$ExpectedDbName')"
      }
      if ($null -ne $Body.PSObject.Properties["dataMode"] -and $Body.dataMode -ne "REAL") {
        throw "WRONG_DATA_MODE: System is running in '$($Body.dataMode)' mode (expected 'REAL')"
      }

      return [PSCustomObject]@{
        Healthy        = $true
        FrontendStatus = "200 OK"
        ApiStatus      = "200 OK"
        MysqlStatus    = "CONNECTED"
        DatabaseName   = [string]$Body.database.databaseName
        DatabaseEngine = [string]$Body.database.engine
        DataMode       = if ($null -ne $Body.PSObject.Properties["dataMode"]) { [string]$Body.dataMode } else { "REAL" }
        Port           = $TargetPort
      }
    } catch {
      $LastError = $_.Exception.Message
      Write-DeployLog -Message "Health check attempt $Attempt/$MaxRetries failed: $LastError" -Level "WARN"
      if ($Attempt -lt $MaxRetries) {
        Start-Sleep -Seconds $RetryDelaySec
      }
    }
  }

  return [PSCustomObject]@{
    Healthy = $false
    Error   = $LastError
  }
}

# ==============================================================================
# Print Deployment Banner
# ==============================================================================
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " SAM_ATT V2 STANDALONE DEPLOYMENT" -ForegroundColor Cyan
Write-Host " Samchuk Hospital" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-DeployLog -Message "Starting Sam_Att V2 Standalone Deployment in $AppDir (CheckOnly=$CheckOnly)"

$State = [ordered]@{
  CurrentStep           = 0
  StepName              = "Initialization"
  CommitBefore          = ""
  CommitAfter           = ""
  RemoteCommit          = ""
  GitPulled             = $false
  BackupCreated         = $false
  BackupDir             = ""
  ScannerExePath        = ""
  ScannerExeSha256      = ""
  IisRoutingMode        = "STANDALONE_DIRECT_4101"
  IisStaticTargetDir    = ""
  BackendProcessMode    = "STANDALONE_NODE_TSX"
  BackendServiceName    = ""
  BackendPm2Name        = ""
  VerifiedSamAttPid     = 0
  BackendRestarted      = $false
  ExpectedDbEngine      = "mysql"
  ExpectedDbName        = "samchuk_attendance_v2"
  ExpectedDbHost        = "10.1.0.201"
}

function Invoke-SafeRollback {
  param([string]$FailureReason)

  Write-Host ""
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  Write-Host " INITIATING SAFE ROLLBACK (SAM_ATT ONLY)" -ForegroundColor Yellow
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  Write-DeployLog -Message "Initiating Safe Rollback due to failure: $FailureReason" -Level "WARN"

  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateRollbackFailure"] -and $MockConfig.simulateRollbackFailure -eq $true) {
    Write-DeployLog -Message "CRITICAL: Simulated rollback failure triggered." -Level "ERROR"
    return $false
  }

  $RollbackSuccess = $true

  try {
    Push-Location $AppDir
    try {
      # 1. Revert Git commit if git pull had advanced the branch (never git reset --hard or git clean -fd)
      if ($State.GitPulled -and -not [string]::IsNullOrWhiteSpace($State.CommitBefore) -and ($State.CommitBefore -ne $State.CommitAfter)) {
        Write-DeployLog -Message "Reverting Git working branch '$Branch' back to previous commit $($State.CommitBefore)..."
        if ($null -eq $MockConfig) {
          Invoke-NativeCli -Executable "git" -Arguments @("merge", "--abort") | Out-Null
          $RevertRes = Invoke-NativeCli -Executable "git" -Arguments @("reset", "--keep", $State.CommitBefore)
          if ($RevertRes.ExitCode -ne 0) {
            throw "ROLLBACK_GIT_REVERT_FAILED: Could not safely revert to commit $($State.CommitBefore)"
          }
        }
      }

      # 2. Restore dist/ build artifact from Backup
      if ($State.BackupCreated -and -not [string]::IsNullOrWhiteSpace($State.BackupDir) -and (Test-Path $State.BackupDir)) {
        $BackupDist = Join-Path $State.BackupDir "dist"
        $TargetDist = Join-Path $AppDir "dist"
        if (Test-Path (Join-Path $BackupDist "index.html")) {
          Write-DeployLog -Message "Restoring dist/ bundle from backup $($State.BackupDir)..."
          if (Test-Path $TargetDist) {
            Remove-Item -Path $TargetDist -Recurse -Force -ErrorAction Stop
          }
          Copy-Item -Path $BackupDist -Destination $TargetDist -Recurse -Force -ErrorAction Stop
        }
      }
    } finally {
      Pop-Location
    }

    # 3. Verify or Restart Sam_Att backend process only (never touch Procurement or IIS)
    if ($null -ne $MockConfig) {
      Restart-SamAttBackendOnly -IsRollback $true
      if ($null -ne $MockConfig.PSObject.Properties["postRollbackHealthy"] -and $MockConfig.postRollbackHealthy -eq $false) {
        throw "POST_ROLLBACK_HEALTH_FAILED: System failed Health Check after Rollback"
      }
    } else {
      $QuickHealth = Test-SamAttHealthEndpoint -TargetPort $Port -ExpectedDbEngine $State.ExpectedDbEngine -ExpectedDbName $State.ExpectedDbName -MaxRetries 2 -RetryDelaySec 1
      if ($State.BackendRestarted -or (-not $QuickHealth.Healthy)) {
        Write-DeployLog -Message "Restarting Sam_Att backend process after rollback (Mode=$($State.BackendProcessMode))..."
        Restart-SamAttBackendOnly -IsRollback $true
        $PostRollbackHealth = Test-SamAttHealthEndpoint -TargetPort $Port -ExpectedDbEngine $State.ExpectedDbEngine -ExpectedDbName $State.ExpectedDbName -MaxRetries 6 -RetryDelaySec 2
        if (-not $PostRollbackHealth.Healthy) {
          throw "POST_ROLLBACK_HEALTH_FAILED: $($PostRollbackHealth.Error)"
        }
      } else {
        Write-DeployLog -Message "Existing Sam_Att backend process was untouched and remains healthy on port $Port."
      }
    }

    Write-DeployLog -Message "Rollback completed and verified healthy on port $Port." -Level "INFO"
  } catch {
    Write-Host "  [ROLLBACK DETAIL] $($_.Exception.Message)" -ForegroundColor Red
    Write-DeployLog -Message "CRITICAL ROLLBACK ERROR: $($_.Exception.Message)" -Level "ERROR"
    $RollbackSuccess = $false
  }

  return $RollbackSuccess
}

function Restart-SamAttBackendOnly {
  param([bool]$IsRollback = $false)

  foreach ($Forbidden in $ForbiddenServiceNames) {
    if ($State.BackendServiceName -ieq $Forbidden -or $State.BackendPm2Name -ieq $Forbidden) {
      throw "SECURITY_ISOLATION_VIOLATION: Refusing to touch forbidden service '$Forbidden'"
    }
  }

  if ($null -ne $MockConfig) {
    if ($null -ne $MockConfig.PSObject.Properties["simulateBackendStartFailure"] -and $MockConfig.simulateBackendStartFailure -eq $true -and (-not $IsRollback)) {
      throw "BACKEND_START_FAILED: Sam_Att Backend process failed to start on port $Port"
    }
    $State.BackendRestarted = $true
    Write-DeployLog -Message "[MockMode] Restarted Sam_Att backend isolated process (Mode=$($State.BackendProcessMode), IsRollback=$IsRollback)"
    return
  }

  $State.BackendRestarted = $true

  switch ($State.BackendProcessMode) {
    "WINDOWS_SERVICE" {
      $SvcName = $State.BackendServiceName
      Write-DeployLog -Message "Restarting isolated Windows Service '$SvcName'..."
      Restart-Service -Name $SvcName -Force -ErrorAction Stop
      Start-Sleep -Seconds 3
      $SvcObj = Get-Service -Name $SvcName -ErrorAction Stop
      if ($SvcObj.Status -ne "Running") {
        throw "BACKEND_SERVICE_NOT_RUNNING: Windows Service '$SvcName' is not Running (Status: $($SvcObj.Status))"
      }
    }
    "PM2_PROCESS" {
      $Pm2App = $State.BackendPm2Name
      Write-DeployLog -Message "Reloading isolated PM2 process '$Pm2App'..."
      $Pm2RestartRes = Invoke-NativeCli -Executable "pm2" -Arguments @("restart", $Pm2App, "--update-env")
      if ($Pm2RestartRes.ExitCode -ne 0) {
        throw "BACKEND_PM2_RESTART_FAILED: pm2 restart '$Pm2App' failed (ExitCode=$($Pm2RestartRes.ExitCode))"
      }
      Start-Sleep -Seconds 2
    }
    "STANDALONE_NODE_TSX" {
      if ($State.VerifiedSamAttPid -gt 0) {
        $ExistingProc = Get-Process -Id $State.VerifiedSamAttPid -ErrorAction SilentlyContinue
        if ($null -ne $ExistingProc) {
          Write-DeployLog -Message "Stopping verified Sam_Att Node.js process (PID=$($State.VerifiedSamAttPid))..."
          Stop-Process -Id $State.VerifiedSamAttPid -Force -ErrorAction SilentlyContinue
        }
      }

      # Wait up to 8 seconds for port 4101 to release
      for ($WaitIdx = 1; $WaitIdx -le 8; $WaitIdx++) {
        $StillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -eq $StillListening) {
          break
        }
        $HoldPid = [int]$StillListening.OwningProcess
        $HoldWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $HoldPid" -ErrorAction SilentlyContinue
        if ($null -ne $HoldWmi -and ($HoldWmi.CommandLine -match "Sam_Att" -or $HoldWmi.CommandLine -match "server\.ts")) {
          Stop-Process -Id $HoldPid -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 1
      }

      $StdOutLog = Join-Path $LogsDir "sam_att_runtime_stdout_$Timestamp.log"
      $StdErrLog = Join-Path $LogsDir "sam_att_runtime_stderr_$Timestamp.log"
      $NodeExe = (Get-Command node -ErrorAction Stop).Source

      Write-DeployLog -Message "Starting single Sam_Att V2 Standalone process ($NodeExe --import tsx server.ts) in $AppDir..."
      $StartedProc = Start-Process -FilePath $NodeExe `
        -ArgumentList @("--import", "tsx", "server.ts") `
        -WorkingDirectory $AppDir `
        -RedirectStandardOutput $StdOutLog `
        -RedirectStandardError $StdErrLog `
        -WindowStyle Hidden `
        -PassThru
      Start-Sleep -Seconds 4
      if ($StartedProc.HasExited) {
        $ErrText = if (Test-Path $StdErrLog) { (Get-Content -Path $StdErrLog -Raw -ErrorAction SilentlyContinue) } else { "" }
        throw "BACKEND_PROCESS_EXITED_IMMEDIATELY: Sam_Att process exited immediately (ExitCode=$($StartedProc.ExitCode)). Details: $ErrText"
      }
      $State.VerifiedSamAttPid = $StartedProc.Id
      Write-DeployLog -Message "Started Sam_Att V2 Standalone process (New PID=$($State.VerifiedSamAttPid))."
    }
  }
}

try {
  # ============================================================================
  # STEP 1 - Preflight Check
  # ============================================================================
  $State.CurrentStep = 1
  $State.StepName = "Preflight Check"

  # 1.1 Verify repository directory and core files
  if (-not (Test-Path $AppDir)) {
    throw "PREFLIGHT_REPO_NOT_FOUND: Installation directory not found at $AppDir"
  }
  foreach ($ReqFile in @(".git", "package.json", "package-lock.json", "server.ts")) {
    if (-not (Test-Path (Join-Path $AppDir $ReqFile))) {
      throw "PREFLIGHT_MISSING_CORE_FILE: Required file or folder '$ReqFile' missing in $AppDir"
    }
  }

  Push-Location $AppDir
  try {
    # 1.2 Verify Git Branch and clean Working Tree
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["gitBranch"]) {
      $CurrentBranch = [string]$MockConfig.gitBranch
    } else {
      $BranchRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "--abbrev-ref", "HEAD")
      $CurrentBranch = $BranchRes.Output
      if ($BranchRes.ExitCode -ne 0) {
        throw "PREFLIGHT_GIT_ERROR: Failed to determine Git branch ($CurrentBranch)"
      }
    }
    if ($CurrentBranch -ne $Branch) {
      throw "PREFLIGHT_WRONG_BRANCH: Current branch is '$CurrentBranch' (expected '$Branch')"
    }

    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["gitDirtyFiles"]) {
      $DirtyOutput = [string]$MockConfig.gitDirtyFiles
    } else {
      Invoke-NativeCli -Executable "git" -Arguments @("checkout", "--", "package-lock.json") | Out-Null
      $DirtyRes = Invoke-NativeCli -Executable "git" -Arguments @("status", "--porcelain", "--untracked-files=no")
      $DirtyOutput = $DirtyRes.Output
    }
    if (-not [string]::IsNullOrWhiteSpace($DirtyOutput)) {
      throw "PREFLIGHT_DIRTY_WORKING_TREE: Local modifications detected in Git working tree. Inspect before deploying (automatic git reset --hard is forbidden):`n$DirtyOutput"
    }

    # 1.3 Verify Node.js and npm
    $NodeRes = Invoke-NativeCli -Executable "node" -Arguments @("-v")
    $NodeVerRaw = $NodeRes.Output
    if ($NodeRes.ExitCode -ne 0 -or -not ($NodeVerRaw -match "^v(\d+)\.")) {
      throw "PREFLIGHT_NODE_MISSING: Node.js not found ($NodeVerRaw)"
    }
    $NodeMajor = [int]$Matches[1]
    if ($NodeMajor -lt 22) {
      throw "PREFLIGHT_NODE_VERSION_UNSUPPORTED: Detected Node.js $NodeVerRaw (requires >= v22.0.0)"
    }
    $NpmVerRes = Invoke-NativeCli -Executable "npm" -Arguments @("-v")
    $NpmVerRaw = $NpmVerRes.Output
    if ($NpmVerRes.ExitCode -ne 0) {
      throw "PREFLIGHT_NPM_MISSING: npm command not found"
    }
    Write-DeployLog -Message "Runtime verified: Node.js=$NodeVerRaw, npm=$NpmVerRaw"

    # 1.4 Verify available disk space (>= 500 MB)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["freeDiskMb"]) {
      $FreeDiskMb = [double]$MockConfig.freeDiskMb
    } else {
      $DriveRoot = [System.IO.Path]::GetPathRoot($AppDir)
      $DriveInfo = New-Object System.IO.DriveInfo($DriveRoot)
      $FreeDiskMb = [math]::Round($DriveInfo.AvailableFreeSpace / 1MB, 2)
    }
    if ($FreeDiskMb -lt 500) {
      throw "PREFLIGHT_LOW_DISK_SPACE: Available disk space is $FreeDiskMb MB (requires at least 500 MB)"
    }

    # 1.5 Verify .env file and REAL Mode / MySQL settings (never overwrite or delete .env)
    $DotEnvPath = Join-Path $AppDir ".env"
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["customEnvFile"]) {
      $DotEnvPath = [string]$MockConfig.customEnvFile
    }
    if (-not (Test-Path $DotEnvPath)) {
      throw "PREFLIGHT_ENV_MISSING: .env file not found at $DotEnvPath"
    }

    $EnvMap = Read-DotEnvFileSafe -EnvFilePath $DotEnvPath

    if (-not $EnvMap.ContainsKey("SAM_ATT_DATA_MODE") -or [string]::IsNullOrWhiteSpace($EnvMap["SAM_ATT_DATA_MODE"])) {
      Write-Host "  [ADVISORY] SAM_ATT_DATA_MODE is not explicitly set in .env (backend/src/config/env.ts defaults to REAL when SAM_ATT_DB_ENGINE=mysql; consider adding SAM_ATT_DATA_MODE=REAL to .env)" -ForegroundColor Yellow
      Write-DeployLog -Message "ADVISORY: SAM_ATT_DATA_MODE not explicitly set in .env; defaults to REAL when SAM_ATT_DB_ENGINE=mysql." -Level "WARN"
    } elseif ($EnvMap["SAM_ATT_DATA_MODE"].ToUpper() -ne "REAL") {
      throw "PREFLIGHT_INVALID_DATA_MODE: SAM_ATT_DATA_MODE in .env is '$($EnvMap["SAM_ATT_DATA_MODE"])' (must be REAL for production deployment; DEMO is forbidden)"
    }

    $DbEngineVal = if ($EnvMap.ContainsKey("SAM_ATT_DB_ENGINE")) { $EnvMap["SAM_ATT_DB_ENGINE"] } else { "mysql" }
    if ($DbEngineVal -ne "mysql") {
      throw "PREFLIGHT_INVALID_DB_ENGINE: SAM_ATT_DB_ENGINE in .env must be 'mysql' (found '$DbEngineVal'). Automatic fallback to SQLite is forbidden."
    }

    foreach ($ReqEnvKey in @("SAM_ATT_DB_HOST", "SAM_ATT_DB_PORT", "SAM_ATT_DB_NAME", "SAM_ATT_DB_USER", "SAM_ATT_DB_PASSWORD", "JWT_SECRET", "SCANNER_INGEST_SHARED_TOKEN")) {
      if (-not $EnvMap.ContainsKey($ReqEnvKey) -or [string]::IsNullOrWhiteSpace($EnvMap[$ReqEnvKey]) -or $EnvMap[$ReqEnvKey] -eq "CHANGE_ME" -or $EnvMap[$ReqEnvKey] -like "GENERATE_*") {
        throw "PREFLIGHT_ENV_INCOMPLETE: Required variable '$ReqEnvKey' in .env is missing or still set to a placeholder value"
      }
    }

    $State.ExpectedDbEngine = $DbEngineVal
    $State.ExpectedDbName = $EnvMap["SAM_ATT_DB_NAME"]
    $State.ExpectedDbHost = $EnvMap["SAM_ATT_DB_HOST"]

    # Record ScannerReader EXE SHA-256 to guarantee it is never modified
    $ScannerRel = if ($EnvMap.ContainsKey("SCANNER_READER_EXE_PATH") -and -not [string]::IsNullOrWhiteSpace($EnvMap["SCANNER_READER_EXE_PATH"])) {
      $EnvMap["SCANNER_READER_EXE_PATH"]
    } else {
      "ScannerReader\ScannerSyncCli.exe"
    }
    $ResolvedScannerPath = if ([System.IO.Path]::IsPathRooted($ScannerRel)) { $ScannerRel } else { Join-Path $AppDir $ScannerRel }
    if (Test-Path $ResolvedScannerPath) {
      $State.ScannerExePath = $ResolvedScannerPath
      $State.ScannerExeSha256 = (Get-FileHash -Path $ResolvedScannerPath -Algorithm SHA256).Hash.ToLower()
      Write-DeployLog -Message "ScannerReader binary verified at $ResolvedScannerPath (SHA256=$($State.ScannerExeSha256))"
    }

    # 1.6 Inspect IIS Configuration (never run iisreset or touch Procurement)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["iisPermissionDenied"] -and $MockConfig.iisPermissionDenied -eq $true) {
      throw "PREFLIGHT_IIS_PERMISSION_DENIED: Insufficient permissions to inspect IIS configuration. Please Run as Administrator."
    }
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["iisRoutingMode"]) {
      $State.IisRoutingMode = [string]$MockConfig.iisRoutingMode
    } else {
      $State.IisRoutingMode = "STANDALONE_DIRECT_4101"
      $AppCmdPath = Join-Path $env:SystemRoot "System32\inetsrv\appcmd.exe"
      if ($env:OS -like "*Windows*" -and (Test-Path $AppCmdPath)) {
        $AppCmdRes = Invoke-NativeCli -Executable $AppCmdPath -Arguments @("list", "app")
        if ($AppCmdRes.ExitCode -ne 0) {
          throw "PREFLIGHT_IIS_PERMISSION_DENIED: Cannot read IIS configuration via appcmd.exe. Please right-click and Run as Administrator."
        }
        if ($AppCmdRes.Output -match "Procurement") {
          Write-DeployLog -Message "IIS Co-tenancy Guard: Detected Procurement on same server - locked READ-ONLY (never restart/modify)."
        }
      }
    }

    # 1.7 Verify Port 4101 and Backend Process Ownership
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["port4101Owner"]) {
      $OwnerType = [string]$MockConfig.port4101Owner
      if ($OwnerType -eq "FOREIGN_PROCESS") {
        throw "PREFLIGHT_PORT_4101_FOREIGN_PROCESS: Port $Port is occupied by a foreign process not owned by Sam_Att (killing by port number alone is forbidden)"
      }
      if ($null -ne $MockConfig.PSObject.Properties["processManager"]) {
        $State.BackendProcessMode = [string]$MockConfig.processManager
      }
    } else {
      $WinSvc = Get-Service -Name "SamAttV2Standalone", "Sam_Att_V2_Standalone" -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($null -ne $WinSvc) {
        $State.BackendProcessMode = "WINDOWS_SERVICE"
        $State.BackendServiceName = $WinSvc.Name
        Write-DeployLog -Message "Detected Sam_Att Windows Service: $($WinSvc.Name) (Status=$($WinSvc.Status))"
      } else {
        $Pm2Cmd = Get-Command pm2 -ErrorAction SilentlyContinue
        if ($null -ne $Pm2Cmd) {
          $Pm2Res = Invoke-NativeCli -Executable "pm2" -Arguments @("jlist")
          $Pm2ListJson = $Pm2Res.Output
          if ($Pm2ListJson.StartsWith("[")) {
            $Pm2Apps = $Pm2ListJson | ConvertFrom-Json
            foreach ($App in $Pm2Apps) {
              if ($App.name -in @("Sam_Att", "sam-att-v2-standalone", "SamAttV2Standalone")) {
                $State.BackendProcessMode = "PM2_PROCESS"
                $State.BackendPm2Name = $App.name
                Write-DeployLog -Message "Detected Sam_Att PM2 process: $($App.name)"
                break
              }
            }
          }
        }
      }

      if ($env:OS -like "*Windows*") {
        $NetConn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($null -ne $NetConn -and $NetConn.OwningProcess -gt 0) {
          $ListenPid = [int]$NetConn.OwningProcess
          $ProcWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $ListenPid" -ErrorAction SilentlyContinue
          $ProcName = if ($null -ne $ProcWmi) { [string]$ProcWmi.Name } else { "" }
          $CmdLine = if ($null -ne $ProcWmi) { [string]$ProcWmi.CommandLine } else { "" }

          $IsConfirmedSamAtt = $false
          if ($CmdLine -match "Sam_Att" -or $CmdLine -match "server\.ts") {
            $IsConfirmedSamAtt = $true
          } else {
            try {
              $Probe = Invoke-HttpsProbe -Url "https://localhost:$Port/api/Sam_Att/health" -ParseJson -TimeoutSec 5
              if ($Probe.StatusCode -eq 200 -and $Probe.Json.service -eq "Sam_Att V2 Standalone") {
                $IsConfirmedSamAtt = $true
              }
            } catch {
              $IsConfirmedSamAtt = $false
            }
          }

          if (-not $IsConfirmedSamAtt) {
            throw "PREFLIGHT_PORT_4101_FOREIGN_PROCESS: Port $Port is in use by a foreign process (PID=$ListenPid, Name=$ProcName). Aborting to protect co-tenant services."
          }
          $State.VerifiedSamAttPid = $ListenPid
          Write-DeployLog -Message "Verified Port $Port is owned by Sam_Att V2 Standalone (PID=$ListenPid, Mode=$($State.BackendProcessMode))."
        }
      }
    }

    # 1.8 Verify Backup directory is writable
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateBackupDirUnwritable"] -and $MockConfig.simulateBackupDirUnwritable -eq $true) {
      throw "PREFLIGHT_BACKUP_DIR_UNWRITABLE: Backup directory $BackupsRootDir is not writable"
    }
    if (-not (Test-Path $BackupsRootDir)) {
      New-Item -ItemType Directory -Path $BackupsRootDir -Force -ErrorAction Stop | Out-Null
    }
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 1 -TotalSteps 7 -Label "Preflight Check" -Status "PASS"

  # ============================================================================
  # STEP 2 - GitHub Update
  # ============================================================================
  $State.CurrentStep = 2
  $State.StepName = "GitHub Update"

  Push-Location $AppDir
  try {
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateGitFetchFailure"] -and $MockConfig.simulateGitFetchFailure -eq $true) {
      throw "GIT_FETCH_FAILED: Cannot connect to GitHub ($Remote/$Branch)"
    }

    $HeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "HEAD")
    $State.CommitBefore = $HeadRes.Output
    if ($null -eq $MockConfig) {
      $FetchRes = Invoke-NativeCli -Executable "git" -Arguments @("fetch", $Remote, $Branch)
      if ($FetchRes.ExitCode -ne 0) {
        throw "GIT_FETCH_FAILED: git fetch $Remote $Branch failed: $($FetchRes.Output)"
      }
      $RemoteHeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "$Remote/$Branch")
      $State.RemoteCommit = $RemoteHeadRes.Output
    } else {
      $State.RemoteCommit = if ($null -ne $MockConfig.PSObject.Properties["remoteCommit"]) { [string]$MockConfig.remoteCommit } else { $State.CommitBefore }
    }

    Write-DeployLog -Message "Commit Before Update : $($State.CommitBefore)"
    Write-DeployLog -Message "Remote Target Commit : $($State.RemoteCommit)"

    $PendingMigrations = @()
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["pendingMigrations"]) {
      $PendingMigrations = @($MockConfig.pendingMigrations)
    } elseif ($State.CommitBefore -ne $State.RemoteCommit) {
      $DiffRes = Invoke-NativeCli -Executable "git" -Arguments @("diff", "--name-only", "$($State.CommitBefore)..$($State.RemoteCommit)", "--", "database/migrations/")
      if (-not [string]::IsNullOrWhiteSpace($DiffRes.Output)) {
        $PendingMigrations = $DiffRes.Output -split "`r?`n"
      }
    }

    if ($PendingMigrations.Count -gt 0 -and (-not $ApproveMigrations)) {
      $MigList = ($PendingMigrations -join ", ")
      throw "MIGRATION_APPROVAL_REQUIRED: Database migration changes detected ($MigList). Automatic migration is forbidden. Please review and run with -ApproveMigrations."
    }

    if ($CheckOnly) {
      Write-StepResult -StepNo 2 -TotalSteps 7 -Label "GitHub Update" -Status "PASS"
      Write-Host ""
      Write-Host "----------------------------------------" -ForegroundColor Cyan
      Write-Host " CHECK-ONLY MODE COMPLETED (NO CHANGES)" -ForegroundColor Cyan
      Write-Host " Current Commit : $($State.CommitBefore)"
      Write-Host " Remote Commit  : $($State.RemoteCommit)"
      Write-Host " IIS Routing    : $($State.IisRoutingMode)"
      Write-Host " Process Mode   : $($State.BackendProcessMode)"
      Write-Host "----------------------------------------" -ForegroundColor Cyan
      exit 0
    }

    if ($null -eq $MockConfig) {
      $PullRes = Invoke-NativeCli -Executable "git" -Arguments @("pull", "--ff-only", $Remote, $Branch)
      if ($PullRes.ExitCode -ne 0) {
        throw "GIT_PULL_FAILED: git pull --ff-only failed (automatic git reset --hard is forbidden): $($PullRes.Output)"
      }
      $AfterHeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "HEAD")
      $State.CommitAfter = $AfterHeadRes.Output
    } else {
      $State.CommitAfter = $State.RemoteCommit
    }
    $State.GitPulled = $true
    Write-DeployLog -Message "Git pull completed: $($State.CommitBefore) -> $($State.CommitAfter)"
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 2 -TotalSteps 7 -Label "GitHub Update" -Status "PASS"

  # ============================================================================
  # STEP 3 - Backup
  # ============================================================================
  $State.CurrentStep = 3
  $State.StepName = "Backup"

  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateBackupFailure"] -and $MockConfig.simulateBackupFailure -eq $true) {
    throw "BACKUP_FAILED: Failed to create pre-deployment backup. Aborting deployment."
  }

  $BackupDir = Join-Path $BackupsRootDir "deploy_backup_$Timestamp"
  New-Item -ItemType Directory -Path $BackupDir -Force -ErrorAction Stop | Out-Null
  $State.BackupDir = $BackupDir

  $DistDir = Join-Path $AppDir "dist"
  if (Test-Path $DistDir) {
    Copy-Item -Path $DistDir -Destination (Join-Path $BackupDir "dist") -Recurse -Force -ErrorAction Stop
  }

  foreach ($CfgFile in @("package.json", "package-lock.json", "tsconfig.json")) {
    $SrcPath = Join-Path $AppDir $CfgFile
    if (Test-Path $SrcPath) {
      Copy-Item -Path $SrcPath -Destination (Join-Path $BackupDir $CfgFile) -Force -ErrorAction Stop
    }
  }

  # Remove any legacy .ts files inside backups/ from earlier runs so tsc never scans them
  Get-ChildItem -Path $BackupsRootDir -Filter "*.ts" -Recurse -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

  $BackupManifest = [ordered]@{
    serviceName          = "Sam_Att V2 Standalone"
    backupTimestamp      = $Timestamp
    commitBefore         = $State.CommitBefore
    commitAfter          = $State.CommitAfter
    iisRoutingMode       = $State.IisRoutingMode
    backendProcessMode   = $State.BackendProcessMode
    scannerExeSha256     = $State.ScannerExeSha256
    appDirectory         = $AppDir
  }
  $ManifestPath = Join-Path $BackupDir "backup-manifest.json"
  ($BackupManifest | ConvertTo-Json -Depth 5) | Set-Content -Path $ManifestPath -Encoding UTF8 -ErrorAction Stop
  if (-not (Test-Path $ManifestPath)) {
    throw "BACKUP_MANIFEST_MISSING: backup-manifest.json missing in backup folder"
  }
  $ManifestHash = (Get-FileHash -Path $ManifestPath -Algorithm SHA256).Hash.ToLower()
  Set-Content -Path "$ManifestPath.sha256" -Value $ManifestHash -Encoding ASCII -ErrorAction Stop
  $State.BackupCreated = $true
  Write-DeployLog -Message "Created verified pre-deployment backup at $BackupDir (Manifest SHA256=$ManifestHash)"

  Write-StepResult -StepNo 3 -TotalSteps 7 -Label "Backup" -Status "PASS"

  # ============================================================================
  # STEP 4 - Install Dependencies
  # ============================================================================
  $State.CurrentStep = 4
  $State.StepName = "Install Dependencies"

  Push-Location $AppDir
  try {
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateNpmInstallFailure"] -and $MockConfig.simulateNpmInstallFailure -eq $true) {
        throw "NPM_INSTALL_FAILED: Dependency installation from package-lock.json failed"
      }
    } else {
      Write-DeployLog -Message "Installing npm dependencies from package-lock.json..."
      $NpmCiRes = Invoke-NativeCli -Executable "npm" -Arguments @("ci", "--no-audit", "--no-fund")
      if ($NpmCiRes.ExitCode -ne 0) {
        Write-DeployLog -Message "npm ci returned code $($NpmCiRes.ExitCode) (retrying with npm install --no-package-lock --no-audit --no-fund due to Windows native module file lock)..." -Level "WARN"
        $NpmInstRes = Invoke-NativeCli -Executable "npm" -Arguments @("install", "--no-package-lock", "--no-audit", "--no-fund")
        if ($NpmInstRes.ExitCode -ne 0) {
          throw "NPM_INSTALL_FAILED: npm dependency installation failed: $($NpmInstRes.Output)"
        }
        Invoke-NativeCli -Executable "git" -Arguments @("checkout", "--", "package-lock.json") | Out-Null
      }
    }
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 4 -TotalSteps 7 -Label "Install Dependencies" -Status "PASS"

  # ============================================================================
  # STEP 5 - Typecheck / Test / Build
  # ============================================================================
  $State.CurrentStep = 5
  $State.StepName = "Typecheck/Test/Build"

  Push-Location $AppDir
  try {
    # 5.1 TypeScript Typecheck
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateTypecheckFailure"] -and $MockConfig.simulateTypecheckFailure -eq $true) {
        throw "TYPECHECK_FAILED: TypeScript typecheck (npm run typecheck) failed"
      }
    } else {
      Write-DeployLog -Message "Running TypeScript typecheck (npm run typecheck)..."
      $TcRes = Invoke-NativeCli -Executable "npm" -Arguments @("run", "typecheck")
      if ($TcRes.ExitCode -ne 0) {
        throw "TYPECHECK_FAILED: TypeScript typecheck failed:`n$($TcRes.Output)"
      }
    }

    # 5.2 Automated Unit & Integration Tests (isolated SQLite sandbox; never touches production MySQL)
    if (-not $SkipTests) {
      if ($null -ne $MockConfig) {
        if ($null -ne $MockConfig.PSObject.Properties["simulateTestFailure"] -and $MockConfig.simulateTestFailure -eq $true) {
          throw "UNIT_TESTS_FAILED: Automated test suite (npm test) failed"
        }
      } else {
        Write-DeployLog -Message "Running automated verification test suite (npm test) in isolated SQLite sandbox..."
        $PrevEngine = $env:SAM_ATT_DB_ENGINE
        $PrevMode = $env:SAM_ATT_DATA_MODE
        $PrevNodeEnv = $env:NODE_ENV
        try {
          $env:SAM_ATT_DB_ENGINE = "sqlite_sandbox"
          $env:SAM_ATT_DATA_MODE = "DEMO"
          $env:NODE_ENV = "test"
          $TestRes = Invoke-NativeCli -Executable "npm" -Arguments @("test")
          if ($TestRes.ExitCode -ne 0) {
            throw "UNIT_TESTS_FAILED: Automated tests failed:`n$($TestRes.Output)"
          }
        } finally {
          $env:SAM_ATT_DB_ENGINE = $PrevEngine
          $env:SAM_ATT_DATA_MODE = $PrevMode
          $env:NODE_ENV = $PrevNodeEnv
        }
      }
    }

    # 5.3 Production Frontend Build (vite build -> dist/index.html)
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateBuildFailure"] -and $MockConfig.simulateBuildFailure -eq $true) {
        throw "BUILD_FAILED: Frontend production build (npm run build) failed"
      }
    } else {
      Write-DeployLog -Message "Running Frontend production build (npm run build)..."
      if (Test-Path (Join-Path $AppDir "bun.lock")) {
        Remove-Item -Path (Join-Path $AppDir "bun.lock") -Force -ErrorAction SilentlyContinue
      }
      $BuildRes = Invoke-NativeCli -Executable "npm" -Arguments @("run", "build")
      if ($BuildRes.ExitCode -ne 0) {
        throw "BUILD_FAILED: npm run build failed:`n$($BuildRes.Output)"
      }
    }

    $BuiltIndexHtml = Join-Path $AppDir "dist\index.html"
    if (-not (Test-Path $BuiltIndexHtml)) {
      throw "BUILD_ARTIFACT_MISSING: dist\index.html not found after build"
    }
    if ((Get-Item $BuiltIndexHtml).Length -le 32) {
      throw "BUILD_ARTIFACT_EMPTY: dist\index.html is empty or invalid"
    }

    if (-not [string]::IsNullOrWhiteSpace($State.ScannerExePath) -and (Test-Path $State.ScannerExePath)) {
      $CurrentScannerSha = (Get-FileHash -Path $State.ScannerExePath -Algorithm SHA256).Hash.ToLower()
      if ($CurrentScannerSha -ne $State.ScannerExeSha256) {
        throw "SCANNER_EXE_MODIFIED_VIOLATION: ScannerReader EXE checksum changed unexpectedly"
      }
    }
  } finally {
    Pop-Location
  }

  Write-StepResult -StepNo 5 -TotalSteps 7 -Label "Typecheck/Test/Build" -Status "PASS"

  # ============================================================================
  # STEP 6 - IIS / Backend Update
  # ============================================================================
  $State.CurrentStep = 6
  $State.StepName = "IIS / Backend Update"

  if ($State.IisRoutingMode -eq "IIS_STATIC_VIRTUAL_DIR" -and -not [string]::IsNullOrWhiteSpace($State.IisStaticTargetDir)) {
    Write-DeployLog -Message "Updating static IIS folder for Sam_Att only at $($State.IisStaticTargetDir)..."
    Copy-Item -Path (Join-Path $AppDir "dist\*") -Destination $State.IisStaticTargetDir -Recurse -Force -ErrorAction Stop
  } else {
    Write-DeployLog -Message "IIS Routing Mode is $($State.IisRoutingMode): Frontend (/Sam_Att/) and API (/api/Sam_Att/) are served from $AppDir\dist via HTTPS Port $Port without restarting IIS or Procurement."
  }

  Restart-SamAttBackendOnly -IsRollback $false

  Write-StepResult -StepNo 6 -TotalSteps 7 -Label "IIS / Backend Update" -Status "PASS"

  # ============================================================================
  # STEP 7 - Health Check
  # ============================================================================
  $State.CurrentStep = 7
  $State.StepName = "Health Check"

  $HealthOutcome = Test-SamAttHealthEndpoint `
    -TargetPort $Port `
    -ExpectedDbEngine $State.ExpectedDbEngine `
    -ExpectedDbName $State.ExpectedDbName `
    -MaxRetries $(if ($null -ne $MockConfig) { 1 } else { 8 }) `
    -RetryDelaySec $(if ($null -ne $MockConfig) { 0 } else { 2 })

  if (-not $HealthOutcome.Healthy) {
    throw "HEALTH_CHECK_FAILED: $($HealthOutcome.Error)"
  }

  Write-StepResult -StepNo 7 -TotalSteps 7 -Label "Health Check" -Status "PASS"

  Write-Host ""
  Write-Host "----------------------------------------" -ForegroundColor Cyan
  Write-Host "Frontend HTTPS : $($HealthOutcome.FrontendStatus)"
  Write-Host "Backend API    : $($HealthOutcome.ApiStatus)"
  Write-Host "MySQL          : $($HealthOutcome.MysqlStatus)"
  Write-Host "Database       : $($HealthOutcome.DatabaseName)"
  Write-Host "Port           : $($HealthOutcome.Port)"
  if ($State.CommitBefore -ne "" -and $State.CommitAfter -ne "") {
    Write-Host "Commit         : $($State.CommitBefore.Substring(0, [Math]::Min(8, $State.CommitBefore.Length))) -> $($State.CommitAfter.Substring(0, [Math]::Min(8, $State.CommitAfter.Length)))"
  }
  Write-Host "----------------------------------------" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "DEPLOYMENT SUCCESS" -ForegroundColor Green
  Write-DeployLog -Message "DEPLOYMENT SUCCESS on Port $Port (Database=$($HealthOutcome.DatabaseName), Commit=$($State.CommitAfter))"
  exit 0

} catch {
  $ErrMessage = Protect-SensitiveText -InputText $_.Exception.Message
  if ($State.CurrentStep -ge 1 -and $State.CurrentStep -le 7) {
    Write-StepResult -StepNo $State.CurrentStep -TotalSteps 7 -Label $State.StepName -Status "FAIL"
  }
  Write-Host ""
  Write-Host "ERROR [$($State.StepName)]: $ErrMessage" -ForegroundColor Red
  Write-DeployLog -Message "FAILED at Step $($State.CurrentStep) ($($State.StepName)): $ErrMessage" -Level "ERROR"

  if ($State.CurrentStep -ge 4 -or $State.GitPulled) {
    $RolledBack = Invoke-SafeRollback -FailureReason $ErrMessage
    if ($RolledBack) {
      Write-Host ""
      Write-Host "DEPLOYMENT FAILED - ROLLED BACK SAFELY TO PREVIOUS VERSION" -ForegroundColor Yellow
      exit 1
    } else {
      Write-Host ""
      Write-Host "DEPLOYMENT CRITICAL - ROLLBACK FAILED (MANUAL INTERVENTION REQUIRED)" -ForegroundColor Red
      exit 2
    }
  }

  Write-Host ""
  Write-Host "DEPLOYMENT ABORTED (NO SYSTEM CHANGES APPLIED)" -ForegroundColor Yellow
  exit 1
}
