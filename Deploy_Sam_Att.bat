@echo off
setlocal EnableExtensions
chcp 65001 >nul 2>&1
title Sam_Att V2 Standalone - One-Click Deployment (Samchuk Hospital)

REM ============================================================================
REM Sam_Att V2 Standalone - Root One-Click Deployment Launcher
REM Location: C:\inetpub\wwwroot\Sam_Att\Deploy_Sam_Att.bat
REM Delegates directly to deployment\Deploy_Sam_Att.bat
REM ============================================================================

set "ROOT_DIR=%~dp0"
if "%ROOT_DIR:~-1%"=="\" set "ROOT_DIR=%ROOT_DIR:~0,-1%"
set "TARGET_BAT=%ROOT_DIR%\deployment\Deploy_Sam_Att.bat"

if not exist "%TARGET_BAT%" (
    echo [ERROR] File not found: "%TARGET_BAT%"
    if "%SAM_ATT_NO_PAUSE%"=="" pause
    exit /b 1
)

call "%TARGET_BAT%" %*
exit /b %ERRORLEVEL%
