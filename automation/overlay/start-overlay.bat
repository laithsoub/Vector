@echo off
:: ─── Launches the floating EL Pricer overlay over Outlook ─────────────────
:: Expects the Vector server to already be running on port 3000.
:: If not, the overlay waits up to 20s before erroring out.
cd /d "%~dp0"
title EL Pricer Overlay

:: Quick dependency check — surface a friendly hint if pywebview/pystray missing.
python -c "import webview, pystray, PIL" >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Missing Python dependencies for the overlay.
    echo Run:
    echo     pip install pywebview pystray pillow
    echo.
    pause
    exit /b 1
)

:: Run the overlay. -u so logs flush immediately to the console.
python -u outlook_overlay.py
