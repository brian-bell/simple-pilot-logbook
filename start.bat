@echo off
setlocal

echo.
echo  ====================================================
echo   Simple Pilot Logbook - local agent
echo  ====================================================
echo.

cd /d "%~dp0agent"

echo  Checking Python...
python --version 2>NUL
if errorlevel 1 (
    echo  [ERROR] Python not found. Please install Python 3.11+ ^(64-bit^).
    echo          https://www.python.org/downloads/
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

echo  Installing dependencies...
python -m pip install -r requirements.txt --quiet

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

python main.py

pause
