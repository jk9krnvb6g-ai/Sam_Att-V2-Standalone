<#
.SYNOPSIS
  Sam_Att V2 Standalone - Application-Only Production Deployment & Rollback Script (8 Steps)
.DESCRIPTION
  Application-only production deployment script for Sam_Att V2 Standalone from GitHub (origin/main)
  on Windows Server + IIS (Samchuk Hospital).
  - Pure 7-bit ASCII source file to guarantee 100% compatibility with Windows PowerShell 5.1.
  - Database-agnostic / Application-only: NEVER performs database backups, mysqldump/mariadb-dump,
    schema changes, table creation/alteration, data edits, or automatic migrations.
  - Step 1: Preflight Check (Git repo, branch, clean working tree, Node>=22/npm, disk space, .env MySQL check, IIS & Port 4101, service isolation)
  - Step 2: GitHub Version Verification (verify repository, branch, current & target commit; abort if unreachable/diverged)
  - Step 3: Change Impact Analysis (list changed files, classify Frontend/Backend/Config/.env/DB Schema; STOP if DB schema/migration changes detected)
  - Step 4: Install Dependencies (save app-only rollback snapshot, git pull --ff-only, npm ci/install without altering .env or production data)
  - Step 5: Test & Build (TypeScript typecheck, existing automated tests in isolated sandbox, Frontend & Backend build verification)
  - Step 6: Deploy Application (update Sam_Att Frontend/Backend on HTTPS Port 4101 only; never run iisreset or touch Procurement)
  - Step 7: Health Check (Frontend /Sam_Att/, API /api/Sam_Att/health, read-only MySQL connection check, Port 4101 owner, runtime logs)
  - Step 8: Deployment Report (start/end time, commit before/after, changed files, test/build/health results, 8-step PASS/FAIL summary & remediation)
#>
[CmdletBinding()]
param(
  [string]$AppDir = "",
  [string]$Branch = "main",
  [string]$Remote = "origin",
  [int]$Port = 4101,
  [switch]$CheckOnly,
  [string]$RollbackRootDir = "",
  [string]$BackupRootDir = "",
  [switch]$NonInteractive,
  [switch]$SkipTests,
  [string]$MockEnvFile = "",
  [switch]$ApproveMigrations,
  [string]$ApprovedCommit = "",
  [string]$ApprovedMigrations = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$TotalSteps = 8
$DeployStartTime = Get-Date
$DeployEndTime = $null

# ==============================================================================
# 0. Resolve Application Directory & Isolated Rollback Snapshot Path
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
if (-not [string]::IsNullOrWhiteSpace($RollbackRootDir)) {
  $SnapshotRootDir = [System.IO.Path]::GetFullPath($RollbackRootDir)
} elseif (-not [string]::IsNullOrWhiteSpace($BackupRootDir)) {
  $SnapshotRootDir = [System.IO.Path]::GetFullPath($BackupRootDir)
} elseif (-not [string]::IsNullOrWhiteSpace($env:SAM_ATT_DEPLOY_SNAPSHOT_DIR)) {
  $SnapshotRootDir = [System.IO.Path]::GetFullPath($env:SAM_ATT_DEPLOY_SNAPSHOT_DIR)
} else {
  $SnapshotRootDir = "C:\SamAttDeploySnapshots"
}

$Timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$LogFilePath = Join-Path $LogsDir "deploy_sam_att_$Timestamp.log"

$ForbiddenServiceNames = @("Procurement", "ProcurementService", "ProcurementPool", "CentralApiGateway", "SamAttGateway", "W3SVC")
$SensitiveSecretsToMask = New-Object System.Collections.Generic.List[string]
$StepRecords = New-Object System.Collections.Generic.List[object]

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
  $Sanitized = [regex]::Replace($Sanitized, '(?i)(PASSWORD|PWD|SECRET|TOKEN|API_KEY|MYSQL_PWD)\s*=\s*("[^"\r\n]*"|''[^''\r\n]*''|[^\s;&"]+)', '$1=***REDACTED***')
  $Sanitized = [regex]::Replace($Sanitized, '(?i)((?:mysql|https?|ftp)://[^:\s/]+:)([^@\s]+)(@)', '$1***REDACTED***$3')
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
    # Ignore early log write error
  }
}

function Record-StepOutcome {
  param(
    [int]$StepNo,
    [string]$Label,
    [string]$Status,
    [string]$Detail = ""
  )
  $SafeDetail = Protect-SensitiveText -InputText $Detail
  $ExistingIdx = -1
  for ($i = 0; $i -lt $StepRecords.Count; $i++) {
    if ($StepRecords[$i].StepNo -eq $StepNo) {
      $ExistingIdx = $i
      break
    }
  }
  $Entry = [PSCustomObject]@{
    StepNo = $StepNo
    Label  = $Label
    Status = $Status
    Detail = $SafeDetail
  }
  if ($ExistingIdx -ge 0) {
    $StepRecords[$ExistingIdx] = $Entry
  } else {
    $StepRecords.Add($Entry) | Out-Null
  }

  $PaddedLabel = $Label.PadRight(28, ' ')
  $Line = "[$StepNo/$TotalSteps] $PaddedLabel $Status"
  $LogMsg = if ([string]::IsNullOrWhiteSpace($SafeDetail)) { $Line } else { "$Line - $SafeDetail" }
  Write-DeployLog -Message $LogMsg -Level $(if ($Status -eq "PASS") { "INFO" } elseif ($Status -eq "SKIP") { "WARN" } else { "ERROR" })
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

function Get-FileSha256Safe {
  param([string]$FilePath)
  if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
    return ""
  }
  $Stream = $null
  $Sha = $null
  try {
    $Sha = [System.Security.Cryptography.SHA256]::Create()
    $Stream = [System.IO.File]::OpenRead($FilePath)
    $HashBytes = $Sha.ComputeHash($Stream)
    return ([System.BitConverter]::ToString($HashBytes) -replace '-', '').ToLower()
  } finally {
    if ($null -ne $Stream) { $Stream.Dispose() }
    if ($null -ne $Sha) { $Sha.Dispose() }
  }
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

function Test-SamAttPortOwnership {
  param(
    [int]$TargetPort = 4101
  )
  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["port4101Owner"]) {
    $MockOwner = [string]$MockConfig.port4101Owner
    if ($MockOwner -eq "FOREIGN_PROCESS") {
      throw "PORT_4101_FOREIGN_PROCESS: Port $TargetPort is owned by a foreign process"
    }
    return [PSCustomObject]@{
      Listening = $true
      Pid       = 4101
      OwnerName = "node.exe (Mock)"
    }
  }

  if (-not ($env:OS -like "*Windows*")) {
    return [PSCustomObject]@{
      Listening = $true
      Pid       = 0
      OwnerName = "non-windows-runtime"
    }
  }

  $NetConn = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $NetConn -or $NetConn.OwningProcess -le 0) {
    throw "HEALTH_PORT_NOT_LISTENING: No process is listening on HTTPS port $TargetPort"
  }

  $ListenPid = [int]$NetConn.OwningProcess
  $ProcWmi = Get-CimInstance Win32_Process -Filter "ProcessId = $ListenPid" -ErrorAction SilentlyContinue
  $ProcName = if ($null -ne $ProcWmi) { [string]$ProcWmi.Name } else { "unknown" }
  $CmdLine = if ($null -ne $ProcWmi) { [string]$ProcWmi.CommandLine } else { "" }

  $IsConfirmedSamAtt = $false
  if ($CmdLine -match "Sam_Att" -or $CmdLine -match "server\.ts") {
    $IsConfirmedSamAtt = $true
  } else {
    try {
      $Probe = Invoke-HttpsProbe -Url "https://127.0.0.1:$TargetPort/api/Sam_Att/health" -ParseJson -TimeoutSec 5
      if ($Probe.StatusCode -eq 200 -and $Probe.Json.service -eq "Sam_Att V2 Standalone") {
        $IsConfirmedSamAtt = $true
      }
    } catch {
      $IsConfirmedSamAtt = $false
    }
  }

  if (-not $IsConfirmedSamAtt) {
    throw "PORT_4101_FOREIGN_PROCESS: Port $TargetPort is held by PID=$ListenPid ($ProcName), not Sam_Att V2 Standalone"
  }

  return [PSCustomObject]@{
    Listening = $true
    Pid       = $ListenPid
    OwnerName = $ProcName
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

      $PortOwner = Test-SamAttPortOwnership -TargetPort $TargetPort

      return [PSCustomObject]@{
        Healthy        = $true
        FrontendUrl    = $FrontendUrl
        ApiUrl         = $HealthUrl
        FrontendStatus = "200 OK"
        ApiStatus      = "200 OK"
        MysqlStatus    = "CONNECTED (READ-ONLY CHECK)"
        DatabaseName   = [string]$Body.database.databaseName
        DatabaseEngine = [string]$Body.database.engine
        DataMode       = if ($null -ne $Body.PSObject.Properties["dataMode"]) { [string]$Body.dataMode } else { "REAL" }
        Port           = $TargetPort
        OwnerPid       = $PortOwner.Pid
        OwnerProcess   = $PortOwner.OwnerName
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

function Get-RemediationHint {
  param(
    [int]$StepNo,
    [string]$ErrorMessage
  )
  if ($ErrorMessage -match "PREFLIGHT_DIRTY_WORKING_TREE") {
    return "Run 'git status' and 'git diff' in $AppDir to inspect local modifications cleanly before deploying (do not force reset uncommitted admin edits)."
  }
  if ($ErrorMessage -match "PREFLIGHT_WRONG_BRANCH") {
    return "Switch repository back to branch '$Branch' ('git checkout $Branch') before retrying deployment."
  }
  if ($ErrorMessage -match "PREFLIGHT_ENV_") {
    return "Verify $AppDir\.env exists and defines valid MySQL connection values (SAM_ATT_DB_*), JWT_SECRET, and SCANNER_INGEST_SHARED_TOKEN without modifying production credentials."
  }
  if ($ErrorMessage -match "PREFLIGHT_PORT_4101_FOREIGN_PROCESS|PORT_4101_FOREIGN_PROCESS") {
    return "Check which process owns TCP port $Port using Get-NetTCPConnection -LocalPort $Port and resolve port conflict manually."
  }
  if ($ErrorMessage -match "GIT_FETCH_FAILED|GITHUB_REPO_MISMATCH|GIT_HISTORY_DIVERGED") {
    return "Check server internet/firewall access to github.com and confirm git remote origin points to jk9krnvb6g-ai/Sam_Att-V2-Standalone without local branch divergence."
  }
  if ($ErrorMessage -match "DB_SCHEMA_CHANGE_BLOCKED") {
    return "Database schema or migration changes were detected in Git diff. Deployment is strictly Application-Only. Apply and verify database schema changes separately as DBA before deploying updated code."
  }
  if ($ErrorMessage -match "NPM_INSTALL_FAILED") {
    return "Verify npm registry connectivity and check file locks on native modules under node_modules."
  }
  if ($ErrorMessage -match "TYPECHECK_FAILED|UNIT_TESTS_FAILED|BUILD_FAILED") {
    return "Inspect TypeScript, automated test, or Vite build errors in $LogFilePath and fix on GitHub branch '$Branch' before re-deploying."
  }
  if ($ErrorMessage -match "MYSQL_DISCONNECTED|WRONG_DB_") {
    return "Verify MySQL server availability, host/port/credentials in .env, and ensure Sam_Att connects to samchuk_attendance_v2 in REAL/mysql mode."
  }
  if ($ErrorMessage -match "HEALTH_CHECK_FAILED|FRONTEND_|API_") {
    return "Check Sam_Att runtime logs in $LogsDir and Windows Service / Node process status on HTTPS port $Port."
  }
  return "Review deployment log '$LogFilePath' around Step $StepNo for full diagnostic output."
}

$State = [ordered]@{
  CurrentStep             = 0
  StepName                = "Initialization"
  RepositoryUrl           = ""
  VersionBefore           = ""
  VersionTarget           = ""
  CommitBefore            = ""
  CommitAfter             = ""
  RemoteCommit            = ""
  GitPulled               = $false
  ChangedFiles            = @()
  FrontendImpactCount     = 0
  BackendImpactCount      = 0
  ConfigImpactCount       = 0
  DbSchemaImpactFiles     = @()
  SnapshotCreated         = $false
  SnapshotDir             = ""
  EnvHashBefore           = ""
  ScannerExePath          = ""
  ScannerExeSha256        = ""
  TypecheckStatus         = "NOT_RUN"
  TestStatus              = "NOT_RUN"
  BuildStatus             = "NOT_RUN"
  IisRoutingMode          = "STANDALONE_DIRECT_4101"
  IisStaticTargetDir      = ""
  BackendProcessMode      = "STANDALONE_NODE_TSX"
  BackendServiceName      = ""
  BackendPm2Name          = ""
  VerifiedSamAttPid       = 0
  BackendRestarted        = $false
  RuntimeStderrLog        = ""
  LogErrorSummary         = "NONE"
  HealthOutcome           = $null
  ExpectedDbEngine        = "mysql"
  ExpectedDbName          = "samchuk_attendance_v2"
  ExpectedDbHost          = "10.1.0.201"
  ExpectedDbPort          = 3306
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
      Write-DeployLog -Message "Restarting isolated Windows Service '$SvcName' (IIS central & Procurement untouched)..."
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
      $State.RuntimeStderrLog = $StdErrLog
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
        $ErrText = if (Test-Path $StdErrLog) { Protect-SensitiveText -InputText (Get-Content -Path $StdErrLog -Raw -ErrorAction SilentlyContinue) } else { "" }
        throw "BACKEND_PROCESS_EXITED_IMMEDIATELY: Sam_Att process exited immediately (ExitCode=$($StartedProc.ExitCode)). Details: $ErrText"
      }
      $State.VerifiedSamAttPid = $StartedProc.Id
      Write-DeployLog -Message "Started Sam_Att V2 Standalone process (New PID=$($State.VerifiedSamAttPid))."
    }
  }
}

function Invoke-SafeAppRollback {
  param([string]$FailureReason)

  Write-Host ""
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  Write-Host " INITIATING SAFE APP-ONLY ROLLBACK" -ForegroundColor Yellow
  Write-Host "----------------------------------------" -ForegroundColor Yellow
  Write-DeployLog -Message "Initiating Safe Application-Only Rollback due to failure: $FailureReason" -Level "WARN"

  if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateRollbackFailure"] -and $MockConfig.simulateRollbackFailure -eq $true) {
    Write-DeployLog -Message "CRITICAL: Simulated rollback failure triggered." -Level "ERROR"
    return $false
  }

  $RollbackSuccess = $false

  try {
    $VerifiedCommitAfterRollback = $State.CommitBefore
    Push-Location $AppDir
    try {
      # 1. Revert Git commit safely with --keep if git pull had advanced HEAD (never git reset --hard or git clean -fd)
      if ($State.GitPulled -and -not [string]::IsNullOrWhiteSpace($State.CommitBefore) -and ($State.CommitBefore -ne $State.CommitAfter)) {
        Write-DeployLog -Message "Reverting Git working branch '$Branch' safely back to commit $($State.CommitBefore)..."
        if ($null -eq $MockConfig) {
          Invoke-NativeCli -Executable "git" -Arguments @("merge", "--abort") | Out-Null
          $RevertRes = Invoke-NativeCli -Executable "git" -Arguments @("reset", "--keep", $State.CommitBefore)
          if ($RevertRes.ExitCode -ne 0) {
            throw "ROLLBACK_GIT_REVERT_FAILED: Could not safely revert to commit $($State.CommitBefore)"
          }
        }
        $State.CommitAfter = $State.CommitBefore
      }

      if ($null -eq $MockConfig -and -not [string]::IsNullOrWhiteSpace($State.CommitBefore)) {
        $VerifyHeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "HEAD")
        $VerifiedCommitAfterRollback = $VerifyHeadRes.Output
        if ($VerifyHeadRes.ExitCode -ne 0 -or $VerifiedCommitAfterRollback -ne $State.CommitBefore) {
          throw "ROLLBACK_COMMIT_MISMATCH: Expected HEAD $($State.CommitBefore) after rollback, but found '$VerifiedCommitAfterRollback'"
        }
      }

      # 2. Restore application build & manifest snapshot (never touches .env or database)
      if ($State.SnapshotCreated -and -not [string]::IsNullOrWhiteSpace($State.SnapshotDir) -and (Test-Path $State.SnapshotDir)) {
        foreach ($CfgFile in @("package.json", "package-lock.json", "tsconfig.json")) {
          $SnapCfg = Join-Path $State.SnapshotDir $CfgFile
          if (Test-Path $SnapCfg) {
            Copy-Item -Path $SnapCfg -Destination (Join-Path $AppDir $CfgFile) -Force -ErrorAction Stop
          }
        }
        $SnapDist = Join-Path $State.SnapshotDir "dist"
        $TargetDist = Join-Path $AppDir "dist"
        if (Test-Path (Join-Path $SnapDist "index.html")) {
          Write-DeployLog -Message "Restoring dist/ bundle from snapshot $($State.SnapshotDir)..."
          if (Test-Path $TargetDist) {
            Remove-Item -Path $TargetDist -Recurse -Force -ErrorAction Stop
          }
          Copy-Item -Path $SnapDist -Destination $TargetDist -Recurse -Force -ErrorAction Stop
          if (-not (Test-Path (Join-Path $TargetDist "index.html"))) {
            throw "ROLLBACK_DIST_RESTORE_FAILED: dist/index.html missing after restoring snapshot"
          }
        }
      }
    } finally {
      Pop-Location
    }

    # 3. Restart Sam_Att backend only if it had been restarted or failed health probe (never touch Procurement or IIS)
    $VerifiedHealth = $null
    if ($null -ne $MockConfig) {
      if ($State.BackendRestarted) {
        Restart-SamAttBackendOnly -IsRollback $true
      }
      if ($null -ne $MockConfig.PSObject.Properties["postRollbackHealthy"] -and $MockConfig.postRollbackHealthy -eq $false) {
        throw "POST_ROLLBACK_HEALTH_FAILED: System failed Health Check after Rollback"
      }
      $VerifiedHealth = [PSCustomObject]@{
        Healthy      = $true
        ApiStatus    = "200 OK"
        MysqlStatus  = "CONNECTED"
        DatabaseName = $State.ExpectedDbName
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
        $VerifiedHealth = $PostRollbackHealth
      } else {
        Write-DeployLog -Message "Existing Sam_Att backend process was untouched and verified healthy on port $Port."
        $VerifiedHealth = $QuickHealth
      }
    }

    if ($null -eq $VerifiedHealth -or (-not $VerifiedHealth.Healthy)) {
      throw "POST_ROLLBACK_UNVERIFIED: Rollback health verification did not complete"
    }

    $ShortRollbackCommit = if (-not [string]::IsNullOrWhiteSpace($VerifiedCommitAfterRollback)) {
      $VerifiedCommitAfterRollback.Substring(0, [Math]::Min(8, $VerifiedCommitAfterRollback.Length))
    } else {
      "VERIFIED"
    }
    Write-Host "  Rollback Commit : $ShortRollbackCommit (VERIFIED)" -ForegroundColor Cyan
    Write-Host "  Health API      : $($VerifiedHealth.ApiStatus) (MySQL $($VerifiedHealth.MysqlStatus))" -ForegroundColor Cyan
    Write-DeployLog -Message "Rollback verified: Commit=$VerifiedCommitAfterRollback, Health=$($VerifiedHealth.ApiStatus), MySQL=$($VerifiedHealth.MysqlStatus)" -Level "INFO"
    $RollbackSuccess = $true
  } catch {
    $SafeRbErr = Protect-SensitiveText -InputText $_.Exception.Message
    Write-Host "  [ROLLBACK DETAIL] $SafeRbErr" -ForegroundColor Red
    Write-DeployLog -Message "CRITICAL ROLLBACK ERROR: $SafeRbErr" -Level "ERROR"
    $RollbackSuccess = $false
  }

  return $RollbackSuccess
}

function Write-DeploymentReport {
  param(
    [bool]$Succeeded,
    [string]$FailureReason = "",
    [string]$Remediation = ""
  )
  $DeployEndTime = Get-Date
  $DurationSec = [math]::Round(($DeployEndTime - $DeployStartTime).TotalSeconds, 2)
  $ShortBefore = if (-not [string]::IsNullOrWhiteSpace($State.CommitBefore)) { $State.CommitBefore.Substring(0, [Math]::Min(8, $State.CommitBefore.Length)) } else { "unknown" }
  $ShortAfter = if (-not [string]::IsNullOrWhiteSpace($State.CommitAfter)) { $State.CommitAfter.Substring(0, [Math]::Min(8, $State.CommitAfter.Length)) } elseif (-not [string]::IsNullOrWhiteSpace($State.RemoteCommit)) { $State.RemoteCommit.Substring(0, [Math]::Min(8, $State.RemoteCommit.Length)) } else { "unknown" }

  Write-Host ""
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host " STEP 8 - DEPLOYMENT REPORT" -ForegroundColor Cyan
  Write-Host "========================================" -ForegroundColor Cyan
  Write-Host "Start Time     : $($DeployStartTime.ToString('yyyy-MM-dd HH:mm:ss'))"
  Write-Host "End Time       : $($DeployEndTime.ToString('yyyy-MM-dd HH:mm:ss')) (${DurationSec}s)"
  Write-Host "Version        : $($State.VersionBefore) -> $(if (-not [string]::IsNullOrWhiteSpace($State.VersionTarget)) { $State.VersionTarget } else { $State.VersionBefore })"
  Write-Host "Commit         : $ShortBefore -> $ShortAfter"
  Write-Host "CommitBefore   : $($State.CommitBefore)"
  Write-Host "CommitAfter    : $(if (-not [string]::IsNullOrWhiteSpace($State.CommitAfter)) { $State.CommitAfter } else { $State.CommitBefore })"
  Write-Host "Changed Files  : $($State.ChangedFiles.Count) (Frontend=$($State.FrontendImpactCount), Backend=$($State.BackendImpactCount), Config=$($State.ConfigImpactCount), DbSchema=$($State.DbSchemaImpactFiles.Count))"
  if ($State.ChangedFiles.Count -gt 0) {
    $PreviewFiles = @($State.ChangedFiles | Select-Object -First 20)
    foreach ($Cf in $PreviewFiles) {
      Write-Host "  - $Cf"
    }
    if ($State.ChangedFiles.Count -gt 20) {
      Write-Host "  ... and $($State.ChangedFiles.Count - 20) more files"
    }
  }
  Write-Host "Typecheck      : $($State.TypecheckStatus)"
  Write-Host "Tests          : $($State.TestStatus)"
  Write-Host "Build          : $($State.BuildStatus)"
  if ($null -ne $State.HealthOutcome -and $State.HealthOutcome.Healthy) {
    Write-Host "Frontend HTTPS : $($State.HealthOutcome.FrontendStatus) ($($State.HealthOutcome.FrontendUrl))"
    Write-Host "Backend API    : $($State.HealthOutcome.ApiStatus) ($($State.HealthOutcome.ApiUrl))"
    Write-Host "MySQL          : $($State.HealthOutcome.MysqlStatus)"
    Write-Host "Database       : $($State.HealthOutcome.DatabaseName)"
    Write-Host "Port           : $($State.HealthOutcome.Port) (OwnerPID=$($State.HealthOutcome.OwnerPid), Process=$($State.HealthOutcome.OwnerProcess))"
    Write-Host "Runtime Logs   : $($State.LogErrorSummary)"
  } else {
    Write-Host "Health Check   : $(if ($Succeeded) { 'VERIFIED' } else { 'FAILED / NOT REACHED' })"
  }
  Write-Host ""
  Write-Host "Step Summary:" -ForegroundColor Cyan
  for ($Idx = 1; $Idx -le $TotalSteps; $Idx++) {
    $Matched = $null
    foreach ($Rec in $StepRecords) {
      if ($Rec.StepNo -eq $Idx) { $Matched = $Rec; break }
    }
    if ($null -ne $Matched) {
      $StatusStr = $Matched.Status
      $Lbl = $Matched.Label.PadRight(28, ' ')
      Write-Host ("  [$Idx/$TotalSteps] $Lbl : $StatusStr")
      Write-DeployLog -Message "Report Step [$Idx/$TotalSteps] $($Matched.Label): $StatusStr ($($Matched.Detail))"
    } else {
      Write-Host ("  [$Idx/$TotalSteps] (Not Executed)              : SKIP")
      Write-DeployLog -Message "Report Step [$Idx/$TotalSteps]: SKIP"
    }
  }
  if (-not $Succeeded -and -not [string]::IsNullOrWhiteSpace($FailureReason)) {
    Write-Host ""
    Write-Host "Failure Cause  : $FailureReason" -ForegroundColor Red
    if (-not [string]::IsNullOrWhiteSpace($Remediation)) {
      Write-Host "Remediation    : $Remediation" -ForegroundColor Yellow
    }
  }
  if ($State.SnapshotCreated -and -not [string]::IsNullOrWhiteSpace($State.SnapshotDir)) {
    Write-Host "SnapshotDir    : $($State.SnapshotDir)"
  }
  Write-Host "Log File       : $LogFilePath"
  Write-Host "----------------------------------------" -ForegroundColor Cyan
}

# ==============================================================================
# Print Deployment Banner
# ==============================================================================
Write-Host "========================================" -ForegroundColor Cyan
Write-Host " SAM_ATT V2 STANDALONE DEPLOYMENT (8-STEP APP-ONLY)" -ForegroundColor Cyan
Write-Host " Samchuk Hospital (HTTPS Port $Port)" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-DeployLog -Message "Starting Sam_Att V2 Standalone 8-Step Application-Only Deployment in $AppDir (CheckOnly=$CheckOnly)"
if ($ApproveMigrations -or -not [string]::IsNullOrWhiteSpace($ApprovedCommit) -or -not [string]::IsNullOrWhiteSpace($ApprovedMigrations)) {
  Write-DeployLog -Message "NOTICE: Legacy migration approval flags were passed, but Deploy_Sam_Att.ps1 is strictly Application-Only (8 Steps) and never executes database backups, schema edits, or migrations." -Level "WARN"
}

try {
  # ============================================================================
  # STEP 1 - Preflight Check
  # ============================================================================
  $State.CurrentStep = 1
  $State.StepName = "Preflight Check"

  if (-not (Test-Path $AppDir)) {
    throw "PREFLIGHT_REPO_NOT_FOUND: Installation directory not found at $AppDir"
  }
  foreach ($ReqFile in @(".git", "package.json", "package-lock.json", "server.ts")) {
    if (-not (Test-Path (Join-Path $AppDir $ReqFile))) {
      throw "PREFLIGHT_MISSING_CORE_FILE: Required file or folder '$ReqFile' missing in $AppDir"
    }
  }

  $PkgRaw = Get-Content -Path (Join-Path $AppDir "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($null -ne $PkgRaw -and $null -ne $PkgRaw.PSObject.Properties["version"]) {
    $State.VersionBefore = [string]$PkgRaw.version
  }

  Push-Location $AppDir
  try {
    # 1.1 Git branch & clean working tree
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
      $DirtyRes = Invoke-NativeCli -Executable "git" -Arguments @("status", "--porcelain", "--untracked-files=no")
      $DirtyOutput = $DirtyRes.Output
    }
    if (-not [string]::IsNullOrWhiteSpace($DirtyOutput)) {
      throw "PREFLIGHT_DIRTY_WORKING_TREE: Local modifications detected in Git working tree. Automatic git reset --hard is forbidden:`n$DirtyOutput"
    }

    # 1.2 Node.js >= 22 and npm
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

    # 1.3 Available disk space (>= 500 MB)
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

    # 1.4 Verify .env & MySQL connection settings (read-only; NEVER expose password or overwrite .env)
    $DotEnvPath = Join-Path $AppDir ".env"
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["customEnvFile"]) {
      $DotEnvPath = [string]$MockConfig.customEnvFile
    }
    if (-not (Test-Path $DotEnvPath)) {
      throw "PREFLIGHT_ENV_MISSING: .env file not found at $DotEnvPath"
    }
    $State.EnvHashBefore = Get-FileSha256Safe -FilePath $DotEnvPath

    $EnvMap = Read-DotEnvFileSafe -EnvFilePath $DotEnvPath
    if (-not $EnvMap.ContainsKey("SAM_ATT_DATA_MODE") -or [string]::IsNullOrWhiteSpace($EnvMap["SAM_ATT_DATA_MODE"])) {
      Write-DeployLog -Message "ADVISORY: SAM_ATT_DATA_MODE not explicitly set in .env; backend defaults to REAL when SAM_ATT_DB_ENGINE=mysql." -Level "WARN"
    } elseif ($EnvMap["SAM_ATT_DATA_MODE"].ToUpper() -ne "REAL") {
      throw "PREFLIGHT_INVALID_DATA_MODE: SAM_ATT_DATA_MODE in .env is '$($EnvMap["SAM_ATT_DATA_MODE"])' (must be REAL)"
    }

    $DbEngineVal = if ($EnvMap.ContainsKey("SAM_ATT_DB_ENGINE")) { $EnvMap["SAM_ATT_DB_ENGINE"] } else { "mysql" }
    if ($DbEngineVal -ne "mysql") {
      throw "PREFLIGHT_INVALID_DB_ENGINE: SAM_ATT_DB_ENGINE in .env must be 'mysql' (found '$DbEngineVal')"
    }

    foreach ($ReqEnvKey in @("SAM_ATT_DB_HOST", "SAM_ATT_DB_PORT", "SAM_ATT_DB_NAME", "SAM_ATT_DB_USER", "SAM_ATT_DB_PASSWORD", "JWT_SECRET", "SCANNER_INGEST_SHARED_TOKEN")) {
      if (-not $EnvMap.ContainsKey($ReqEnvKey) -or [string]::IsNullOrWhiteSpace($EnvMap[$ReqEnvKey]) -or $EnvMap[$ReqEnvKey] -eq "CHANGE_ME" -or $EnvMap[$ReqEnvKey] -like "GENERATE_*") {
        throw "PREFLIGHT_ENV_INCOMPLETE: Required variable '$ReqEnvKey' in .env is missing or set to a placeholder"
      }
    }

    if ($EnvMap["SAM_ATT_DB_NAME"] -imatch "hosoffice") {
      throw "PREFLIGHT_FORBIDDEN_HOSOFFICE_DB: SAM_ATT_DB_NAME must not target HOSOffice database"
    }

    $State.ExpectedDbEngine = $DbEngineVal
    $State.ExpectedDbName = $EnvMap["SAM_ATT_DB_NAME"]
    $State.ExpectedDbHost = $EnvMap["SAM_ATT_DB_HOST"]
    $State.ExpectedDbPort = [int]$EnvMap["SAM_ATT_DB_PORT"]
    Write-DeployLog -Message "Verified .env MySQL config (Host=$($State.ExpectedDbHost):$($State.ExpectedDbPort), DB=$($State.ExpectedDbName), User=$($EnvMap["SAM_ATT_DB_USER"]), Password=***REDACTED***)."

    # Record ScannerReader EXE checksum so we verify it stays untouched
    $ScannerRel = if ($EnvMap.ContainsKey("SCANNER_READER_EXE_PATH") -and -not [string]::IsNullOrWhiteSpace($EnvMap["SCANNER_READER_EXE_PATH"])) {
      $EnvMap["SCANNER_READER_EXE_PATH"]
    } else {
      "ScannerReader\ScannerSyncCli.exe"
    }
    $ResolvedScannerPath = if ([System.IO.Path]::IsPathRooted($ScannerRel)) { $ScannerRel } else { Join-Path $AppDir $ScannerRel }
    if (Test-Path $ResolvedScannerPath) {
      $State.ScannerExePath = $ResolvedScannerPath
      $State.ScannerExeSha256 = Get-FileSha256Safe -FilePath $ResolvedScannerPath
      Write-DeployLog -Message "ScannerReader binary verified at $ResolvedScannerPath (SHA256=$($State.ScannerExeSha256))"
    }

    # 1.5 Verify IIS & Isolation Guard (never run iisreset or modify Procurement)
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
          throw "PREFLIGHT_IIS_PERMISSION_DENIED: Cannot read IIS configuration via appcmd.exe. Please Run as Administrator."
        }
        if ($AppCmdRes.Output -match "Procurement") {
          Write-DeployLog -Message "IIS Co-tenancy Guard: Detected Procurement on same server - locked READ-ONLY (never restart/modify)."
        }
      }
    }

    # 1.6 Verify Port 4101 & Process Ownership (never affect other services)
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["port4101Owner"]) {
      $OwnerType = [string]$MockConfig.port4101Owner
      if ($OwnerType -eq "FOREIGN_PROCESS") {
        throw "PREFLIGHT_PORT_4101_FOREIGN_PROCESS: Port $Port is occupied by a foreign process not owned by Sam_Att"
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
              $Probe = Invoke-HttpsProbe -Url "https://127.0.0.1:$Port/api/Sam_Att/health" -ParseJson -TimeoutSec 5
              if ($Probe.StatusCode -eq 200 -and $Probe.Json.service -eq "Sam_Att V2 Standalone") {
                $IsConfirmedSamAtt = $true
              }
            } catch {
              $IsConfirmedSamAtt = $false
            }
          }
          if (-not $IsConfirmedSamAtt) {
            throw "PREFLIGHT_PORT_4101_FOREIGN_PROCESS: Port $Port is in use by a foreign process (PID=$ListenPid, Name=$ProcName). Aborting to protect other services."
          }
          $State.VerifiedSamAttPid = $ListenPid
          Write-DeployLog -Message "Verified Port $Port owned by Sam_Att (PID=$ListenPid, Mode=$($State.BackendProcessMode))."
        }
      }
    }

    # 1.7 Ensure Rollback Snapshot directory is outside Git repository
    if ($null -eq $MockConfig -and $SnapshotRootDir.StartsWith($AppDir, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "PREFLIGHT_SNAPSHOT_DIR_INSIDE_GIT: App rollback snapshot directory '$SnapshotRootDir' must reside outside Git repository '$AppDir'"
    }
    if (-not (Test-Path $SnapshotRootDir)) {
      New-Item -ItemType Directory -Path $SnapshotRootDir -Force -ErrorAction Stop | Out-Null
    }
  } finally {
    Pop-Location
  }

  Record-StepOutcome -StepNo 1 -Label "Preflight Check" -Status "PASS" -Detail "Node $NodeVerRaw, Branch $Branch, Port $Port"

  # ============================================================================
  # STEP 2 - GitHub Version Verification
  # ============================================================================
  $State.CurrentStep = 2
  $State.StepName = "GitHub Version Verification"

  Push-Location $AppDir
  try {
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["simulateGitFetchFailure"] -and $MockConfig.simulateGitFetchFailure -eq $true) {
      throw "GIT_FETCH_FAILED: Cannot connect to GitHub ($Remote/$Branch)"
    }

    if ($null -eq $MockConfig) {
      $RemoteUrlRes = Invoke-NativeCli -Executable "git" -Arguments @("remote", "get-url", $Remote)
      if ($RemoteUrlRes.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($RemoteUrlRes.Output)) {
        throw "GITHUB_REPO_MISMATCH: Git remote '$Remote' is not configured"
      }
      $State.RepositoryUrl = $RemoteUrlRes.Output.Trim()
      if ($State.RepositoryUrl -notmatch "jk9krnvb6g-ai/Sam_Att-V2-Standalone") {
        throw "GITHUB_REPO_MISMATCH: Remote URL '$($State.RepositoryUrl)' does not match jk9krnvb6g-ai/Sam_Att-V2-Standalone"
      }

      $HeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "HEAD")
      if ($HeadRes.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($HeadRes.Output)) {
        throw "GIT_LOCAL_HEAD_UNAVAILABLE: Unable to resolve local HEAD commit"
      }
      $State.CommitBefore = $HeadRes.Output.Trim()

      $FetchRes = Invoke-NativeCli -Executable "git" -Arguments @("fetch", $Remote, $Branch)
      if ($FetchRes.ExitCode -ne 0) {
        throw "GIT_FETCH_FAILED: git fetch $Remote $Branch failed: $($FetchRes.Output)"
      }

      $RemoteHeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "$Remote/$Branch")
      if ($RemoteHeadRes.ExitCode -ne 0 -or [string]::IsNullOrWhiteSpace($RemoteHeadRes.Output)) {
        throw "GIT_REMOTE_HEAD_UNAVAILABLE: Unable to resolve $Remote/$Branch commit"
      }
      $State.RemoteCommit = $RemoteHeadRes.Output.Trim()

      # Verify history is fast-forwardable (not diverged)
      if ($State.CommitBefore -ne $State.RemoteCommit) {
        $MergeBaseRes = Invoke-NativeCli -Executable "git" -Arguments @("merge-base", "--is-ancestor", $State.CommitBefore, $State.RemoteCommit)
        if ($MergeBaseRes.ExitCode -ne 0) {
          throw "GIT_HISTORY_DIVERGED: Local commit $($State.CommitBefore) is not an ancestor of $Remote/$Branch ($($State.RemoteCommit)). Resolve manually before deploying."
        }
      }

      $RemotePkgRes = Invoke-NativeCli -Executable "git" -Arguments @("show", "$Remote/${Branch}:package.json")
      if ($RemotePkgRes.ExitCode -eq 0 -and -not [string]::IsNullOrWhiteSpace($RemotePkgRes.Output)) {
        try {
          $RemotePkgObj = $RemotePkgRes.Output | ConvertFrom-Json
          if ($null -ne $RemotePkgObj.PSObject.Properties["version"]) {
            $State.VersionTarget = [string]$RemotePkgObj.version
          }
        } catch {
          $State.VersionTarget = $State.VersionBefore
        }
      }
    } else {
      $State.RepositoryUrl = "https://github.com/jk9krnvb6g-ai/Sam_Att-V2-Standalone"
      $State.CommitBefore = if ($null -ne $MockConfig.PSObject.Properties["commitBefore"]) { [string]$MockConfig.commitBefore } else { "9f1cdc1000000000000000000000000000000001" }
      $State.RemoteCommit = if ($null -ne $MockConfig.PSObject.Properties["remoteCommit"]) { [string]$MockConfig.remoteCommit } else { $State.CommitBefore }
      $State.VersionTarget = if ($null -ne $MockConfig.PSObject.Properties["targetVersion"]) { [string]$MockConfig.targetVersion } else { $State.VersionBefore }
    }

    if ([string]::IsNullOrWhiteSpace($State.VersionTarget)) {
      $State.VersionTarget = $State.VersionBefore
    }

    Write-Host "  Repository     : $($State.RepositoryUrl) ($Branch)"
    Write-Host "  Current        : v$($State.VersionBefore) ($($State.CommitBefore))"
    Write-Host "  Target         : v$($State.VersionTarget) ($($State.RemoteCommit))"
  } finally {
    Pop-Location
  }

  Record-StepOutcome -StepNo 2 -Label "GitHub Version Verification" -Status "PASS" -Detail "$($State.CommitBefore.Substring(0, [Math]::Min(8, $State.CommitBefore.Length))) -> $($State.RemoteCommit.Substring(0, [Math]::Min(8, $State.RemoteCommit.Length)))"

  # ============================================================================
  # STEP 3 - Change Impact Analysis
  # ============================================================================
  $State.CurrentStep = 3
  $State.StepName = "Change Impact Analysis"

  $ChangedFileList = New-Object System.Collections.Generic.List[string]
  $DbImpactList = New-Object System.Collections.Generic.List[string]
  $FrontCount = 0
  $BackCount = 0
  $CfgCount = 0

  Push-Location $AppDir
  try {
    if ($null -ne $MockConfig -and $null -ne $MockConfig.PSObject.Properties["changedFiles"]) {
      foreach ($Cf in @($MockConfig.changedFiles)) {
        $TrimCf = [string]$Cf
        if (-not [string]::IsNullOrWhiteSpace($TrimCf)) {
          $ChangedFileList.Add($TrimCf.Trim()) | Out-Null
        }
      }
    } elseif ($State.CommitBefore -ne $State.RemoteCommit) {
      $DiffFilesRes = Invoke-NativeCli -Executable "git" -Arguments @("diff", "--name-only", "$($State.CommitBefore)..$($State.RemoteCommit)")
      if ($DiffFilesRes.ExitCode -ne 0) {
        throw "CHANGE_IMPACT_DIFF_FAILED: Could not compute changed files between $($State.CommitBefore) and $($State.RemoteCommit)"
      }
      foreach ($Line in ($DiffFilesRes.Output -split "`r?`n")) {
        $CleanLine = $Line.Trim()
        if (-not [string]::IsNullOrWhiteSpace($CleanLine)) {
          $ChangedFileList.Add($CleanLine) | Out-Null
        }
      }
    }

    foreach ($RelPath in $ChangedFileList) {
      if ($RelPath -match "^frontend/" -or $RelPath -eq "index.html" -or $RelPath -eq "vite.config.ts") {
        $FrontCount++
      }
      if ($RelPath -match "^backend/" -or $RelPath -eq "server.ts") {
        $BackCount++
      }
      if ($RelPath -match "^\.env" -or $RelPath -in @("package.json", "package-lock.json", "tsconfig.json") -or $RelPath -match "^deployment/" -or $RelPath -match "^scripts/") {
        $CfgCount++
      }
      if ($RelPath -match "^database/.*\.sql$" -or $RelPath -match "^database/.*schema" -or $RelPath -match "^backend/src/database/.*migrat") {
        $DbImpactList.Add($RelPath) | Out-Null
      }
      if ($RelPath -eq ".env") {
        throw "CONFIG_ENV_TRACKED_VIOLATION: .env file must not be overwritten by Git updates"
      }
    }

    $State.ChangedFiles = @($ChangedFileList)
    $State.FrontendImpactCount = $FrontCount
    $State.BackendImpactCount = $BackCount
    $State.ConfigImpactCount = $CfgCount
    $State.DbSchemaImpactFiles = @($DbImpactList)

    Write-DeployLog -Message "Impact Analysis: TotalChanged=$($ChangedFileList.Count), Frontend=$FrontCount, Backend=$BackCount, Config=$CfgCount, DbSchema=$($DbImpactList.Count)"

    if ($DbImpactList.Count -gt 0) {
      $ImpactJoined = ($DbImpactList -join ", ")
      throw "DB_SCHEMA_CHANGE_BLOCKED: Database schema/migration file changes detected ($ImpactJoined). Deployment is strictly Application-Only and will NOT alter tables or run migrations. Administrator must inspect and apply database changes separately before deploying this release."
    }
  } finally {
    Pop-Location
  }

  Record-StepOutcome -StepNo 3 -Label "Change Impact Analysis" -Status "PASS" -Detail "Files=$($State.ChangedFiles.Count) (FE=$FrontCount, BE=$BackCount, Cfg=$CfgCount, DB=0)"

  if ($CheckOnly) {
    for ($SkipIdx = 4; $SkipIdx -le 7; $SkipIdx++) {
      $SkipLabels = @{
        4 = "Install Dependencies"
        5 = "Test & Build"
        6 = "Deploy Application"
        7 = "Health Check"
      }
      Record-StepOutcome -StepNo $SkipIdx -Label $SkipLabels[$SkipIdx] -Status "SKIP" -Detail "CheckOnly mode"
    }
    Record-StepOutcome -StepNo 8 -Label "Deployment Report" -Status "PASS" -Detail "CheckOnly mode completed cleanly (no files changed)"
    Write-DeploymentReport -Succeeded $true
    exit 0
  }

  # ============================================================================
  # STEP 4 - Install Dependencies (Application-Only Snapshot + Git Pull + npm)
  # ============================================================================
  $State.CurrentStep = 4
  $State.StepName = "Install Dependencies"

  # 4.1 Save Application-Only rollback snapshot (dist/, package manifests; ZERO database dump)
  $SnapDir = Join-Path $SnapshotRootDir "app_snapshot_$Timestamp"
  New-Item -ItemType Directory -Path $SnapDir -Force -ErrorAction Stop | Out-Null
  $State.SnapshotDir = $SnapDir

  $DistDir = Join-Path $AppDir "dist"
  if (Test-Path $DistDir) {
    Copy-Item -Path $DistDir -Destination (Join-Path $SnapDir "dist") -Recurse -Force -ErrorAction Stop
  }
  foreach ($CfgFile in @("package.json", "package-lock.json", "tsconfig.json")) {
    $SrcCfg = Join-Path $AppDir $CfgFile
    if (Test-Path $SrcCfg) {
      Copy-Item -Path $SrcCfg -Destination (Join-Path $SnapDir $CfgFile) -Force -ErrorAction Stop
    }
  }
  $State.SnapshotCreated = $true
  Write-DeployLog -Message "Created application-only rollback snapshot at $SnapDir (no database backup created)."

  Push-Location $AppDir
  try {
    # 4.2 Pull latest commits cleanly with --ff-only
    if ($null -eq $MockConfig) {
      $PullRes = Invoke-NativeCli -Executable "git" -Arguments @("pull", "--ff-only", $Remote, $Branch)
      if ($PullRes.ExitCode -ne 0) {
        throw "GIT_PULL_FAILED: git pull --ff-only failed (git reset --hard is forbidden): $($PullRes.Output)"
      }
      $AfterHeadRes = Invoke-NativeCli -Executable "git" -Arguments @("rev-parse", "HEAD")
      $State.CommitAfter = $AfterHeadRes.Output.Trim()
    } else {
      if ($null -ne $MockConfig.PSObject.Properties["simulateGitPullFailure"] -and $MockConfig.simulateGitPullFailure -eq $true) {
        throw "GIT_PULL_FAILED: Simulated git pull --ff-only failure"
      }
      $State.CommitAfter = $State.RemoteCommit
    }
    $State.GitPulled = $true
    Write-DeployLog -Message "Git pull --ff-only succeeded: $($State.CommitBefore) -> $($State.CommitAfter)"

    # 4.3 Install dependencies cleanly without altering versions unnecessarily
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateNpmInstallFailure"] -and $MockConfig.simulateNpmInstallFailure -eq $true) {
        throw "NPM_INSTALL_FAILED: Dependency installation from package-lock.json failed"
      }
    } else {
      Write-DeployLog -Message "Installing npm dependencies via npm ci --no-audit --no-fund..."
      $NpmCiRes = Invoke-NativeCli -Executable "npm" -Arguments @("ci", "--no-audit", "--no-fund")
      if ($NpmCiRes.ExitCode -ne 0) {
        Write-DeployLog -Message "npm ci returned exit $($NpmCiRes.ExitCode); retrying with npm install --no-package-lock --no-audit --no-fund..." -Level "WARN"
        $NpmInstRes = Invoke-NativeCli -Executable "npm" -Arguments @("install", "--no-package-lock", "--no-audit", "--no-fund")
        if ($NpmInstRes.ExitCode -ne 0) {
          throw "NPM_INSTALL_FAILED: npm dependency installation failed: $($NpmInstRes.Output)"
        }
        Invoke-NativeCli -Executable "git" -Arguments @("checkout", "--", "package-lock.json") | Out-Null
      }
    }

    # Verify .env was never modified or overwritten
    $EnvHashNow = Get-FileSha256Safe -FilePath (Join-Path $AppDir ".env")
    if (-not [string]::IsNullOrWhiteSpace($State.EnvHashBefore) -and ($null -eq $MockConfig -or -not $MockConfig.PSObject.Properties["customEnvFile"])) {
      if ($EnvHashNow -ne $State.EnvHashBefore) {
        throw "SECURITY_ENV_MUTATED_VIOLATION: Production .env checksum changed unexpectedly during Step 4"
      }
    }
  } finally {
    Pop-Location
  }

  Record-StepOutcome -StepNo 4 -Label "Install Dependencies" -Status "PASS" -Detail "git pull --ff-only + npm dependencies ready"

  # ============================================================================
  # STEP 5 - Test & Build (TypeScript + Existing Tests + Production Build)
  # ============================================================================
  $State.CurrentStep = 5
  $State.StepName = "Test & Build"

  Push-Location $AppDir
  try {
    # 5.1 TypeScript check
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateTypecheckFailure"] -and $MockConfig.simulateTypecheckFailure -eq $true) {
        $State.TypecheckStatus = "FAIL"
        throw "TYPECHECK_FAILED: TypeScript typecheck (npm run typecheck) failed"
      }
      $State.TypecheckStatus = "PASS (Mock)"
    } else {
      Write-DeployLog -Message "Running TypeScript typecheck (npm run typecheck)..."
      $TcRes = Invoke-NativeCli -Executable "npm" -Arguments @("run", "typecheck")
      if ($TcRes.ExitCode -ne 0) {
        $State.TypecheckStatus = "FAIL"
        throw "TYPECHECK_FAILED: TypeScript typecheck failed:`n$($TcRes.Output)"
      }
      $State.TypecheckStatus = "PASS"
    }

    # 5.2 Automated tests in isolated SQLite sandbox (never writes to production MySQL)
    if ($SkipTests) {
      $State.TestStatus = "SKIPPED (-SkipTests)"
    } elseif ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateTestFailure"] -and $MockConfig.simulateTestFailure -eq $true) {
        $State.TestStatus = "FAIL"
        throw "UNIT_TESTS_FAILED: Automated test suite (npm test) failed"
      }
      $State.TestStatus = "PASS (Mock)"
    } else {
      Write-DeployLog -Message "Running automated tests (npm test) in isolated SQLite sandbox..."
      $PrevEngine = $env:SAM_ATT_DB_ENGINE
      $PrevMode = $env:SAM_ATT_DATA_MODE
      $PrevNodeEnv = $env:NODE_ENV
      $PrevTestIso = $env:SAM_ATT_TEST_ISOLATION
      $PrevHosHost = $env:HOSOFFICE_DB_HOST
      $PrevHosPass = $env:HOSOFFICE_DB_PASSWORD
      $PrevHosPush = $env:HOSOFFICE_LIVE_PUSH_ENABLED
      try {
        $env:SAM_ATT_TEST_ISOLATION = "true"
        $env:SAM_ATT_DB_ENGINE = "sqlite_sandbox"
        $env:SAM_ATT_DATA_MODE = "DEMO"
        $env:NODE_ENV = "test"
        $env:HOSOFFICE_DB_HOST = "CHANGE_ME"
        $env:HOSOFFICE_DB_PASSWORD = "CHANGE_ME"
        $env:HOSOFFICE_LIVE_PUSH_ENABLED = "false"
        $TestRes = Invoke-NativeCli -Executable "npm" -Arguments @("test")
        if ($TestRes.ExitCode -ne 0) {
          $State.TestStatus = "FAIL"
          throw "UNIT_TESTS_FAILED: Automated tests failed:`n$($TestRes.Output)"
        }
        $State.TestStatus = "PASS"
      } finally {
        $env:SAM_ATT_TEST_ISOLATION = $PrevTestIso
        $env:SAM_ATT_DB_ENGINE = $PrevEngine
        $env:SAM_ATT_DATA_MODE = $PrevMode
        $env:NODE_ENV = $PrevNodeEnv
        $env:HOSOFFICE_DB_HOST = $PrevHosHost
        $env:HOSOFFICE_DB_PASSWORD = $PrevHosPass
        $env:HOSOFFICE_LIVE_PUSH_ENABLED = $PrevHosPush
      }
    }

    # 5.3 Frontend Vite production build & Backend entry verification
    if ($null -ne $MockConfig) {
      if ($null -ne $MockConfig.PSObject.Properties["simulateBuildFailure"] -and $MockConfig.simulateBuildFailure -eq $true) {
        $State.BuildStatus = "FAIL"
        throw "BUILD_FAILED: Frontend production build (npm run build) failed"
      }
      $State.BuildStatus = "PASS (Mock)"
    } else {
      Write-DeployLog -Message "Running production build (npm run build)..."
      $BuildRes = Invoke-NativeCli -Executable "npm" -Arguments @("run", "build")
      if ($BuildRes.ExitCode -ne 0) {
        $State.BuildStatus = "FAIL"
        throw "BUILD_FAILED: npm run build failed:`n$($BuildRes.Output)"
      }
      $State.BuildStatus = "PASS"
    }

    $BuiltIndexHtml = Join-Path $AppDir "dist\index.html"
    if (-not (Test-Path $BuiltIndexHtml) -or (Get-Item $BuiltIndexHtml).Length -le 32) {
      $State.BuildStatus = "FAIL"
      throw "BUILD_ARTIFACT_MISSING: dist\index.html missing or empty after build"
    }
    foreach ($BackendEntry in @("server.ts", "backend\src\app.ts", "backend\src\server.ts")) {
      if (-not (Test-Path (Join-Path $AppDir $BackendEntry))) {
        $State.BuildStatus = "FAIL"
        throw "BACKEND_ENTRY_MISSING: Required backend file '$BackendEntry' missing after update"
      }
    }

    if (-not [string]::IsNullOrWhiteSpace($State.ScannerExePath) -and (Test-Path $State.ScannerExePath)) {
      $CurrentScannerSha = Get-FileSha256Safe -FilePath $State.ScannerExePath
      if ($CurrentScannerSha -ne $State.ScannerExeSha256) {
        throw "SCANNER_EXE_MODIFIED_VIOLATION: ScannerReader EXE checksum changed unexpectedly"
      }
    }
  } finally {
    Pop-Location
  }

  Record-StepOutcome -StepNo 5 -Label "Test & Build" -Status "PASS" -Detail "Typecheck=$($State.TypecheckStatus), Tests=$($State.TestStatus), Build=$($State.BuildStatus)"

  # ============================================================================
  # STEP 6 - Deploy Application (Sam_Att Frontend/Backend Only; Port 4101)
  # ============================================================================
  $State.CurrentStep = 6
  $State.StepName = "Deploy Application"

  if ($State.IisRoutingMode -eq "IIS_STATIC_VIRTUAL_DIR" -and -not [string]::IsNullOrWhiteSpace($State.IisStaticTargetDir)) {
    Write-DeployLog -Message "Updating static IIS folder for Sam_Att only at $($State.IisStaticTargetDir)..."
    Copy-Item -Path (Join-Path $AppDir "dist\*") -Destination $State.IisStaticTargetDir -Recurse -Force -ErrorAction Stop
  } else {
    Write-DeployLog -Message "Serving Sam_Att Frontend (/Sam_Att/) and Backend API (/api/Sam_Att/) on HTTPS Port $Port (Procurement & IIS W3SVC untouched)."
  }

  Restart-SamAttBackendOnly -IsRollback $false

  Record-StepOutcome -StepNo 6 -Label "Deploy Application" -Status "PASS" -Detail "Port=$Port, Mode=$($State.BackendProcessMode), Isolated=True"

  # ============================================================================
  # STEP 7 - Health Check (Frontend, API, Read-Only MySQL Connection, Port 4101, Logs)
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
  $State.HealthOutcome = $HealthOutcome

  # Inspect runtime stderr log for post-deploy errors without touching database
  if (-not [string]::IsNullOrWhiteSpace($State.RuntimeStderrLog) -and (Test-Path $State.RuntimeStderrLog)) {
    $ErrLines = @(Get-Content -Path $State.RuntimeStderrLog -ErrorAction SilentlyContinue | Where-Object { $_ -match "(?i)(UnhandledPromiseRejection|EADDRINUSE|FATAL|SyntaxError|ReferenceError)" })
    if ($ErrLines.Count -gt 0) {
      $FirstSafeErr = Protect-SensitiveText -InputText ([string]$ErrLines[0])
      $State.LogErrorSummary = "FOUND $($ErrLines.Count) runtime error(s): $FirstSafeErr"
      throw "POST_DEPLOY_LOG_ERRORS: Detected runtime error in stderr log: $FirstSafeErr"
    } else {
      $State.LogErrorSummary = "CLEAN (0 fatal runtime errors in $($State.RuntimeStderrLog))"
    }
  } else {
    $State.LogErrorSummary = "CLEAN (No fatal errors)"
  }

  Record-StepOutcome -StepNo 7 -Label "Health Check" -Status "PASS" -Detail "Frontend=200, API=200, MySQL=CONNECTED (Read-Only), Port=$Port (PID=$($HealthOutcome.OwnerPid))"

  # ============================================================================
  # STEP 8 - Deployment Report
  # ============================================================================
  $State.CurrentStep = 8
  $State.StepName = "Deployment Report"

  Record-StepOutcome -StepNo 8 -Label "Deployment Report" -Status "PASS" -Detail "All 8 steps completed"
  Write-DeploymentReport -Succeeded $true

  Write-Host ""
  Write-Host "DEPLOYMENT SUCCESS" -ForegroundColor Green
  Write-DeployLog -Message "DEPLOYMENT SUCCESS on Port $Port (Database=$($HealthOutcome.DatabaseName), Commit=$($State.CommitAfter))"
  exit 0

} catch {
  $ErrMessage = Protect-SensitiveText -InputText $_.Exception.Message
  $RemediationText = Get-RemediationHint -StepNo $State.CurrentStep -ErrorMessage $ErrMessage

  if ($State.CurrentStep -ge 1 -and $State.CurrentStep -le $TotalSteps) {
    Record-StepOutcome -StepNo $State.CurrentStep -Label $State.StepName -Status "FAIL" -Detail $ErrMessage
  }
  Write-Host ""
  Write-Host "ERROR [$($State.StepName)]: $ErrMessage" -ForegroundColor Red
  Write-DeployLog -Message "FAILED at Step $($State.CurrentStep) ($($State.StepName)): $ErrMessage" -Level "ERROR"

  if ($State.CurrentStep -ge 4 -or $State.GitPulled) {
    $RolledBack = Invoke-SafeAppRollback -FailureReason $ErrMessage
    Write-DeploymentReport -Succeeded $false -FailureReason $ErrMessage -Remediation $RemediationText
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

  Write-DeploymentReport -Succeeded $false -FailureReason $ErrMessage -Remediation $RemediationText
  Write-Host ""
  Write-Host "DEPLOYMENT ABORTED (NO SYSTEM CHANGES APPLIED)" -ForegroundColor Yellow
  exit 1
}
