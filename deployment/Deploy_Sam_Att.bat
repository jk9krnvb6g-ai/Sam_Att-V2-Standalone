@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul 2>&1
title Sam_Att V2 Standalone - One-Click Deployment (Samchuk Hospital)

REM ============================================================================
REM Sam_Att V2 Standalone — One-Click Production Deployment Entry Point
REM Location: C:\inetpub\wwwroot\Sam_Att\deployment\Deploy_Sam_Att.bat
REM Target  : HTTPS Port 4101 (/Sam_Att/ and /api/Sam_Att/)
REM Safety  : Isolated to Sam_Att only. Never touches Procurement or IIS Reset.
REM ============================================================================

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"
for %%I in ("%SCRIPT_DIR%\..") do set "APP_DIR=%%~fI"
set "PS_SCRIPT=%SCRIPT_DIR%\Deploy_Sam_Att.ps1"

if not exist "%PS_SCRIPT%" (
    echo [ERROR] ไม่พบไฟล์สคริปต์ PowerShell: "%PS_SCRIPT%"
    echo Deployment Aborted [Error Code: 1]
    if "%SAM_ATT_NO_PAUSE%"=="" pause
    exit /b 1
)

REM ตรวจสอบสิทธิ์ Administrator บน Windows Server (ข้ามเฉพาะโหมดทดสอบอัตโนมัติ)
if "%SAM_ATT_SKIP_ADMIN_CHECK%"=="" (
    net session >nul 2>&1
    if not "!ERRORLEVEL!"=="0" (
        echo ========================================================================
        echo [WARNING] กรุณาคลิกขวาที่ไฟล์ Deploy_Sam_Att.bat แล้วเลือก "Run as administrator"
        echo เพื่อตรวจสอบ IIS Configuration และจัดการเซอร์วิส Sam_Att บนพอร์ต 4101
        echo ========================================================================
        echo.
        if "%SAM_ATT_NO_PAUSE%"=="" pause
        exit /b 1
    )
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS_SCRIPT%" -AppDir "%APP_DIR%" %*
set "DEPLOY_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%DEPLOY_EXIT_CODE%"=="0" (
    echo [SUMMARY] อัปเดตระบบ Sam_Att V2 Standalone สำเร็จสมบูรณ์ ^(Exit Code: 0^)
) else if "%DEPLOY_EXIT_CODE%"=="2" (
    echo [CRITICAL] การอัปเดตและการย้อนกลับ ^(Rollback^) ล้มเหลว กรุณาตรวจสอบไฟล์ Log ใน "%APP_DIR%\logs" ^(Exit Code: 2^)
) else (
    echo [ERROR] การอัปเดตระบบหยุดทำงานหรือย้อนกลับไปยังรุ่นเดิมแล้ว ^(Exit Code: %DEPLOY_EXIT_CODE%^)
)

if "%SAM_ATT_NO_PAUSE%"=="" (
    echo.
    pause
)

exit /b %DEPLOY_EXIT_CODE%
