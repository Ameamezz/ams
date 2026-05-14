@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo.
echo ==== AmiyaPlayer One-Click Build ====
echo.

echo [1/4] Checking Node.js and npm...
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not in PATH.
  echo Install Node.js LTS first, then rerun this script.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm is not available in PATH.
  pause
  exit /b 1
)

echo [2/4] Installing dependencies if needed...
if not exist "node_modules" (
  call npm ci
  if errorlevel 1 goto :build_failed
) else (
  echo node_modules exists, skipping install.
)

echo [3/4] Building portable package...
call npm run build
if errorlevel 1 goto :build_failed

echo [4/4] Collecting output file...
set "OUTPUT_EXE="
for /f "delims=" %%I in ('dir /b /a:-d /o:-d "dist\*.exe" 2^>nul') do (
  if not defined OUTPUT_EXE set "OUTPUT_EXE=%cd%\dist\%%I"
)

if not defined OUTPUT_EXE (
  for /f "delims=" %%I in ('dir /b /a:-d /o:-d "dist\win-unpacked\*.exe" 2^>nul') do (
    if not defined OUTPUT_EXE set "OUTPUT_EXE=%cd%\dist\win-unpacked\%%I"
  )
)

if not defined OUTPUT_EXE (
  echo [WARN] Build finished, but no EXE was found automatically.
  echo Please check the dist folder manually.
  explorer "%cd%\dist"
  pause
  exit /b 0
)

if not exist "release" mkdir "release"
for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%T"

set "BASENAME=AmiyaPlayer-portable-!STAMP!.exe"
copy /Y "!OUTPUT_EXE!" "release\!BASENAME!" >nul

echo.
echo Build succeeded.
echo Primary EXE: !OUTPUT_EXE!
echo Share file : %cd%\release\!BASENAME!
echo.

explorer "%cd%\release"
exit /b 0

:build_failed
echo.
echo [ERROR] Build failed. Please check the logs above.
pause
exit /b 1
