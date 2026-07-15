@echo off
REM ============================================================================
REM  Vector - one-time Python dependency setup
REM  Run this ONCE per machine after installing Vector.
REM  Installs Python (if missing) + the libraries the automation scripts need.
REM ============================================================================
setlocal EnableDelayedExpansion
title Vector - Python setup

echo.
echo   Vector - Python dependency setup
echo   ================================
echo.

REM --- 1. Find Python -----------------------------------------------------------
set "PY="
where py        >nul 2>&1 && set "PY=py"
if not defined PY ( where python >nul 2>&1 && set "PY=python" )

if not defined PY (
    echo   Python not found. Installing via winget...
    where winget >nul 2>&1
    if errorlevel 1 (
        echo   [ERROR] winget is not available on this PC.
        echo   Please install Python 3.12 from https://www.python.org/downloads/
        echo   and tick "Add python.exe to PATH", then re-run this script.
        echo.
        pause
        exit /b 1
    )
    winget install -e --id Python.Python.3.12 --accept-source-agreements --accept-package-agreements
    echo.
    echo   Python installed. Close this window and run this script again
    echo   so the new PATH is picked up.
    echo.
    pause
    exit /b 0
)

echo   Using Python: %PY%
%PY% --version
echo.

REM --- 2. Upgrade pip + install packages ---------------------------------------
echo   Installing required libraries...
%PY% -m pip install --upgrade pip
%PY% -m pip install pdfplumber openpyxl requests urllib3 pywin32 pandas

if errorlevel 1 (
    echo.
    echo   [ERROR] Package install failed. Check your internet/proxy and retry.
    echo.
    pause
    exit /b 1
)

echo.
echo   ============================================
echo   Done. You can now launch Vector.
echo   ============================================
echo.
pause
