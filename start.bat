@echo off
setlocal

echo.
echo  ====================================================
echo   Simple Pilot Logbook
echo  ====================================================
echo.

cd /d "%~dp0backend"

echo  Checking Python...
python --version 2>NUL
if errorlevel 1 (
    echo  [ERROR] Python not found. Please install Python 3.11+ ^(64-bit^).
    echo          https://www.python.org/downloads/
    pause
    exit /b 1
)

echo  Installing dependencies...
python -m pip install -r requirements.txt --quiet

echo  Starting server on http://localhost:8080
echo  (Press Ctrl+C or close this window to stop)
echo.

start "" "http://localhost:8080"

python -m uvicorn main:app --host 0.0.0.0 --port 8080

pause
