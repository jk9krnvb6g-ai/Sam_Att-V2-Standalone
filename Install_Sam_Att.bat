@echo off
setlocal EnableExtensions

REM ============================================================================
REM Sam_Att V2 Standalone - One-Click Windows Server 2025 Installer Entry Point
REM Target Server : 10.2.0.23 (HTTPS Port 4101)
REM Service ID    : SamAttV2Standalone (WinSW)
REM Root Directory: D:\WebApps\Sam_Att
REM ============================================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
set "PS_SCRIPT=%SCRIPT_DIR%\Install_Sam_Att.ps1"

echo ============================================================================
echo  Sam_Att V2 Standalone - Windows Server 2025 One-Click Installer
echo ============================================================================

net session >nul 2>&1
if not "%errorLevel%"=="0" (
  echo [ERROR] PREFLIGHT_ADMIN_PRIVILEGE_REQUIRED: Administrator privilege required.
  echo [HINT]  Please right-click Install_Sam_Att.bat and select "Run as administrator".
  exit /b 1
)

if not exist "%PS_SCRIPT%" (
  echo [ERROR] Installer script not found at "%PS_SCRIPT%"
  exit /b 1
)

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" %*
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [FAILED] Installation exited with error code %EXIT_CODE%.
  exit /b %EXIT_CODE%
)

echo.
echo [SUCCESS] Sam_Att V2 Standalone installation workflow finished cleanly.
exit /b 0
