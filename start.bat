@echo off
setlocal

echo.
echo  ====================================================
echo   Simple Pilot Logbook
echo  ====================================================
echo.

set "ROOT_DIR=%~dp0"
set "FRONTEND_DIR=%ROOT_DIR%frontend"
set "FRONTEND_DIST=%FRONTEND_DIR%\dist\index.html"

if not exist "%FRONTEND_DIST%" (
    echo  Frontend build not found. Attempting to build it...
    where npm >NUL 2>NUL
    if errorlevel 1 (
        echo  [WARN] npm not found. The backend will start, but the web UI will not load
        echo         until you build the frontend in "%FRONTEND_DIR%".
    ) else (
        pushd "%FRONTEND_DIR%"
        call npm install
        if errorlevel 1 (
            echo  [ERROR] Frontend dependency install failed.
            popd
            pause
            exit /b 1
        )
        call npm run build
        if errorlevel 1 (
            echo  [ERROR] Frontend build failed.
            popd
            pause
            exit /b 1
        )
        popd
    )
)

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
