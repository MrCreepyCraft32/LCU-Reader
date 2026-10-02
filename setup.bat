@echo off
cd /d "%~dp0"
echo ============================================
echo   LCU Reader  -  Downloading dependencies
echo ============================================
echo.

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found on PATH.
  echo         Install Node.js first: https://nodejs.org
  echo         then re-run this file.
  pause
  exit /b 1
)

echo Running: npm.cmd install
echo (this downloads Electron + electron-builder into .\node_modules)
echo.
call npm.cmd install
if errorlevel 1 (
  echo.
  echo [ERROR] npm install failed. Check your internet connection and retry.
  pause
  exit /b 1
)

echo.
echo ============================================
echo   Done. Next steps:
echo     - run.bat     = launch the app
echo     - build.bat   = build the portable .exe
echo ============================================
pause