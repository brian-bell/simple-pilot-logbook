# Service Install And Uninstall

The local agent can run as a Windows service named `SimplePilotLogbook` so flights are captured and uploaded to the Cloudflare Worker whenever Windows is running. The agent is a Node.js app; [WinSW](https://github.com/winsw/winsw) 2.12.0 hosts it as a service.

## Prerequisites
- Windows 10/11
- Node.js 22.13 or newer with npm (`node --version`)
- `agent\.env` filled in with `WORKER_URL` and `AGENT_TOKEN` (see [cloud-deploy.md](cloud-deploy.md))
- Run PowerShell as Administrator

## Install Or Update The Service
From the repository root:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install_service.ps1
```

Pass `-NodeCommand "C:\path\to\node.exe"` to pick a specific Node installation; by default the `node.exe` on `PATH` is used and its full path is written into the service configuration.

What the script does:
- checks that `agent\.env` exists and Node.js is 22.13 or newer
- runs `npm ci` and `npm run build` in `agent\`
- removes an older registration of `SimplePilotLogbook` that points somewhere else (the previous Python/pywin32 service)
- downloads `WinSW-x64.exe` 2.12.0 into `agent\service\SimplePilotLogbook.exe` on first install and verifies its SHA-256
- renders `agent\service\SimplePilotLogbook.xml` from the committed `.xml.template` (Node path, agent folder, automatic start, restart on failure, rolling logs)
- registers the service (or refreshes it on update) and starts it

After install, open the logbook URL printed at the end (your `WORKER_URL`) and enter the viewer token.

Updating after `git pull`: run `.\install_service.ps1` again. It rebuilds the agent and restarts the service.

### Upgrading from the Python agent
Just run `.\install_service.ps1`. It detects the old `pythonservice.exe` registration, stops and deletes it, and installs the Node service under the same name. The outbox (`agent\outbox.db`) keeps its schema, so any queued events are sent by the new agent.

Do not run `start.bat` while any `SimplePilotLogbook` service (old or new) is running, or two agents will record the same flights.

## Uninstall The Service
From the repository root:

```powershell
.\uninstall_service.ps1
```

What the script does:
- stops the `SimplePilotLogbook` service if it exists
- removes the registration through WinSW (or `sc.exe delete` for an older registration)

`agent\.env`, `agent\outbox.db` and the logs are left in place.

## Troubleshooting
- Agent activity (SimConnect connection, flight detection, deliveries, retries): `agent\agent.log`
- Service wrapper and process output: `agent\service\SimplePilotLogbook.wrapper.log`, `.out.log`, `.err.log`
- Service status: `Get-Service SimplePilotLogbook` or `.\agent\service\SimplePilotLogbook.exe status`
- `Missing required setting(s)` in `SimplePilotLogbook.err.log`: `agent\.env` is incomplete. The service restarts every 10 seconds until it is fixed.
- `Worker rejected AGENT_TOKEN` in `agent.log`: the token in `agent\.env` does not match the Worker secret (`npx wrangler secret put AGENT_TOKEN`)
- `Delivery failed ... retrying` in `agent.log`: the Worker is unreachable; events stay in `agent\outbox.db` and are sent when it comes back
- `MSFS not reachable` in `agent.log`: MSFS is not running, or its SimConnect pipe/port is not reachable from the service account. See the SimConnect notes in the README.
- Restart manually (as Administrator):

```powershell
.\agent\service\SimplePilotLogbook.exe restart
```

## Notes
- The service runs as LocalSystem. It needs outbound HTTPS to the Worker, access to the MSFS SimConnect named pipe or local TCP port, and read access to `agent\.env`, which holds the agent token in plain text.
- If you switch Node versions with nvm, the service keeps using the path recorded at install time. With nvm4w that path (`C:\nvm4w\nodejs\node.exe`) is a link to the active version; rerun `install_service.ps1` after switching so dependencies are rebuilt for it.
