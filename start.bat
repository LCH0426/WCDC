@echo off
setlocal
cd /d "%~dp0"
title WCDC

if not exist "target\debug\wcdc-server.exe" if not exist "target\release\wcdc-server.exe" (
  echo Backend binary not found.
  echo Build it first with:
  echo     cargo build -p wcdc-server
  pause
  exit /b 1
)

if not exist "web\dist\index.html" (
  echo Frontend dist not found. Build it first with:
  echo     cd web
  echo     npm install
  echo     npm run build
  pause
  exit /b 1
)

echo.
echo ============================================
echo   WCDC  http://127.0.0.1:8787
echo   Close this window or press Ctrl+C to stop
echo ============================================
echo.

if exist "target\release\wcdc-server.exe" (
  "target\release\wcdc-server.exe"
) else (
  "target\debug\wcdc-server.exe"
)

echo.
echo Server stopped.
pause
