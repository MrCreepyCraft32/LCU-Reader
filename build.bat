@echo off
cd /d "%~dp0"
echo ============================================
echo   LCU Reader  -  Building portable .exe
echo ============================================
echo.

if not exist "node_modules" (
  echo [ERROR] Dependencies not installed yet.
  echo         Run setup.bat first, then run this again.
  pause
  exit /b 1
)

echo Running: npm.cmd run dist
echo (output: .\dist\LCU-Reader-1.0.0-portable.exe)
echo.
call npm.cmd run dist
if errorlevel 1 (
  echo.
  echo [ERROR] Build failed.
  pause
  exit /b 1
)

echo.
echo Done. Your exe is in: .\dist\LCU-Reader-1.0.0-portable.exe
pause