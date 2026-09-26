# Service Install And Uninstall

The local agent can run as a Windows service named `SimplePilotLogbook` so flights are captured and uploaded to the Cloudflare Worker whenever Windows is running.

## Prerequisites
- Windows 10/11
- Python 3.11 64-bit installed at `C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe`
- `agent\.env` filled in with `WORKER_URL` and `AGENT_TOKEN` (see [cloud-deploy.md](cloud-deploy.md))
- Run PowerShell as Administrator

## Install Or Update The Service
From the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

What the script does:
- checks that `agent\.env` exists
- installs agent dependencies (`SimConnect`, `pywin32`)
- tries to run `pywin32_postinstall` when available
- registers or updates the `SimplePilotLogbook` service
- configures the service for automatic startup
- restarts the service

After install, open the logbook URL printed at the end (your `WORKER_URL`) and enter the viewer token.

### Upgrading from the pre-Cloudflare version
The old service ran a local web server from `backend\windows_service.py`. Uninstall it first so the registration points at the new script, then install:

```powershell
.\uninstall_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
.\install_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

Nothing listens on `localhost:8080` any more; the logbook lives at the Worker URL.

## Uninstall The Service
From the repository root:

```powershell
.\uninstall_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

What the script does:
- stops the `SimplePilotLogbook` service if it exists
- removes the service registration

## Troubleshooting
- Service startup traceback: check `agent\service.log`
- Agent activity (heartbeats, deliveries, retries, queued events): `agent\agent.log`
- Service status: `Get-Service SimplePilotLogbook`
- `Missing required setting(s)` in `service.log`: `agent\.env` is incomplete
- `Worker rejected AGENT_TOKEN` in `agent.log`: the token in `agent\.env` does not match the Worker secret (`npx wrangler secret put AGENT_TOKEN`)
- `Delivery failed ... retrying` in `agent.log`: the Worker is unreachable; events stay in `agent\outbox.db` and are sent when it comes back
- Restart manually:

```powershell
& "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe" .\agent\windows_service.py restart
```

## Notes
- The install and uninstall scripts accept `-PythonCommand` so they can target the same interpreter used to install dependencies.
- A missing `pywin32_postinstall` entrypoint is treated as a warning, not a fatal error.
- The service runs as LocalSystem. It needs outbound HTTPS to the Worker and read access to `agent\.env`, which holds the agent token in plain text.
