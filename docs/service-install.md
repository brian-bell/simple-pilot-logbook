# Service Install And Uninstall

This app can run as a Windows service named `SimplePilotLogbook`.

## Prerequisites
- Windows 10/11
- Python 3.11 64-bit installed at `C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe`
- Run PowerShell as Administrator

## Install Or Update The Service
From the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

What the script does:
- installs backend dependencies
- installs `pywin32`
- tries to run `pywin32_postinstall` when available
- registers or updates the `SimplePilotLogbook` service
- configures the service for automatic startup
- restarts the service

After install, open [http://localhost:8080](http://localhost:8080).

## Uninstall The Service
From the repository root:

```powershell
.\uninstall_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

What the script does:
- stops the `SimplePilotLogbook` service if it exists
- removes the service registration

## Troubleshooting
- Service startup traceback: check `backend/service.log`
- Service status: `Get-Service SimplePilotLogbook`
- Restart manually:

```powershell
& "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe" .\backend\windows_service.py restart
```

## Notes
- The install and uninstall scripts accept `-PythonCommand` so they can target the same interpreter used to install dependencies.
- A missing `pywin32_postinstall` entrypoint is treated as a warning, not a fatal error.

