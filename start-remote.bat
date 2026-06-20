@echo off
REM YTS Remote bridge launcher (Windows)
cd /d "%~dp0"
echo.
echo ============================================
echo   YTS REMOTE BRIDGE
echo ============================================
echo.

REM Check node_modules
if not exist "node_modules" (
    echo Installing dependencies (first run only)...
    call npm install
    if errorlevel 1 (
        echo.
        echo ERROR: npm install failed.
        pause
        exit /b 1
    )
)

echo Starting server...
echo.
node server.js
pause
