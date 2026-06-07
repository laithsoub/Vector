@echo off
cd /d "%~dp0"
title Vector - Setup

echo.
echo ============================================================
echo   Vector  ^|  Setup
echo ============================================================
echo.

:: [0] Kill running instances
echo [0/5] Stopping any running instances...
taskkill /f /im node.exe >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3000"') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo       OK

:: [1] Check Node.js
echo [1/5] Checking Node.js...
call node -v >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo ERROR: Node.js not found.
    echo        Install Node 22 LTS from https://nodejs.org/
    pause & exit /b 1
)
for /f %%i in ('node -v') do set NODEVER=%%i
echo       OK: %NODEVER%

:: [2] Check LibreOffice (optional - needed for Word/Excel files)
echo [2/5] Checking LibreOffice...
set LO_FOUND=0
where soffice >nul 2>&1
if %ERRORLEVEL% EQU 0 set LO_FOUND=1
if exist "C:\Program Files\LibreOffice\program\soffice.exe" set LO_FOUND=1
if exist "%USERPROFILE%\Downloads\LibreOfficePortable\App\libreoffice\program\soffice.exe" set LO_FOUND=1
if %LO_FOUND% EQU 1 (
    echo       OK: LibreOffice found
) else (
    echo       WARNING: LibreOffice not found - only PDF files will be processed
    echo       Get the portable version: portableapps.com/apps/office/libreoffice_portable
)

:: [3] Corporate SSL fix + npm check
echo [3/5] Checking npm + applying SSL fix...
for /f %%i in ('npm -v') do set NPMVER=%%i
echo       OK: npm %NPMVER%
call npm config set strict-ssl false --location project
call npm config set registry https://registry.npmjs.org --location project
set NODE_TLS_REJECT_UNAUTHORIZED=0

:: [4] Install dependencies
echo [4/5] Installing dependencies...
if exist node_modules rmdir /s /q node_modules >nul 2>&1
if exist package-lock.json del /q package-lock.json
:: Playwright uses your system Edge — no browser download needed (no admin required)
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: npm install failed.
    echo        Check your internet connection or ask IT about proxy settings.
    pause & exit /b 1
)
echo       OK

:: [5] Build UI
echo [5/5] Building UI...
if exist dist rmdir /s /q dist
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: UI build failed.
    pause & exit /b 1
)
echo       OK

echo.
echo ============================================================
echo   Done! Launch Vector from the Vector shortcut.
echo ============================================================
echo.
pause
