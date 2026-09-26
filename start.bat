@echo off
setlocal

echo.
echo  ====================================================
echo   Simple Pilot Logbook - local agent
echo  ====================================================
echo.

cd /d "%~dp0agent"

echo  Checking Node.js...
node --version 2>NUL
if errorlevel 1 (
    echo  [ERROR] Node.js not found. Please install Node.js 22.13 or newer ^(LTS^).
    echo          https://nodejs.org/
    pause
    exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
    echo  [ERROR] Node.js 22.13 or newer is required.
    pause
    exit /b 1
)

if not exist ".env" (
    copy /y ".env.example" ".env" >NUL
    echo  [SETUP] Created agent\.env from .env.example.
    echo          Edit it, set WORKER_URL and AGENT_TOKEN, then run start.bat again.
    echo          See docs\cloud-deploy.md for where those values come from.
    pause
    exit /b 1
)

if not exist "node_modules\node-simconnect" (
    echo  Installing dependencies...
    call npm ci --no-audit --no-fund
    if errorlevel 1 (
        echo  [ERROR] npm ci failed.
        pause
        exit /b 1
    )
)

echo  Building...
call npm run build --silent
if errorlevel 1 (
    echo  [ERROR] Build failed.
    pause
    exit /b 1
)

set "WORKER_URL="
for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
    if /i "%%A"=="WORKER_URL" set "WORKER_URL=%%B"
)
if defined WORKER_URL set "WORKER_URL=%WORKER_URL:"=%"

if defined WORKER_URL (
    echo  Logbook: %WORKER_URL%
    start "" "%WORKER_URL%"
)

echo  Starting agent ^(Ctrl+C or close this window to stop^)
echo.

node --disable-warning=ExperimentalWarning dist\main.js

pause
