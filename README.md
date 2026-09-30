# Simple Pilot Logbook

Automatically records your Microsoft Flight Simulator flights and shows them in a web logbook you can open from anywhere.

A small Node.js **agent** on the sim PC watches MSFS through SimConnect, detects takeoffs and landings, and sends events to a **Cloudflare Worker**. The Worker stores them in **Cloudflare D1** and serves the logbook web app. See [docs/architecture.md](docs/architecture.md) for how it works.

## Features

- **Automatic flight recording** — detects takeoffs and landings via SimConnect; no manual input required
- **Per-flight data**: departure airport, arrival airport, straight-line distance (nm), flight duration, maximum altitude, landing vertical speed, landing G-force, aircraft type and registration
- **Live status** — the header shows In Flight, On Ground, Paused, Connected, Disconnected (MSFS closed) or Agent offline; while airborne a banner shows the aircraft, altitude and elapsed time
- **Sortable logbook** — click any column header to sort
- **Detail modal** — click any row for full flight data
- **Backups** — **Export CSV** downloads the whole logbook; a nightly job also copies it to Cloudflare R2
- **Hosted logbook** — the web app runs on Cloudflare and works whether or not the sim PC is on
- **Offline resilient agent** — events are queued locally and uploaded when the Worker is reachable again
- **Token protected** — every API call needs a bearer token; the UI asks for a viewer token once per browser

## Requirements

| Component | Requirement | Notes |
|---|---|---|
| Agent (sim PC) | Windows 10/11 | SimConnect only runs on Windows |
| Agent (sim PC) | Node.js 22.13+ and npm | Talks SimConnect directly through [node-simconnect](https://github.com/EvenAR/node-simconnect); no SimConnect SDK or DLL needed |
| Agent (sim PC) | Microsoft Flight Simulator 2024 | Built for SU6 (1.8.x) and later. MSFS 2020 is supported best-effort through the older SimConnect protocol |
| Worker | Cloudflare account (free plan is enough) | D1, R2 (nightly backup) and Workers Static Assets |
| Deploying | Node.js 22+ and npm | Only on the machine you deploy from; wrangler 4.141 requires Node 22 |

## Quick Start

1. **Deploy the Worker** once — follow [docs/cloud-deploy.md](docs/cloud-deploy.md). You end up with a URL like `https://simple-pilot-logbook.<account>.workers.dev` and two tokens.
2. **Configure the agent**: copy `agent\.env.example` to `agent\.env`, set `WORKER_URL` and `AGENT_TOKEN`.
3. **Start the agent**: double-click **`start.bat`** (installs dependencies, builds, opens the logbook, runs the agent), or install it as a Windows service per [docs/service-install.md](docs/service-install.md).
4. **Open the logbook URL**, enter the viewer token, then fly. Flights appear after touchdown.

## Landing Quality

| Vertical Speed | Rating |
|---|---|
| Better than −200 fpm | Smooth (green) |
| −200 to −400 fpm | Firm (yellow) |
| Worse than −400 fpm | Hard (red) |

## Troubleshooting

The agent writes everything it does to `agent\agent.log`.

**Status shows "Agent offline"**
- The Worker has not received a heartbeat for over a minute. Check the agent is running (`start.bat` window or `Get-Service SimplePilotLogbook`) and look at `agent.log`.

**Status shows "Disconnected"**
- The agent is running but MSFS is not, or SimConnect could not attach. Start MSFS; the agent reconnects every 5 seconds and logs `Connected to MSFS 2024 via ...` once attached.
- To force an endpoint, set `SIMCONNECT_HOST` and `SIMCONNECT_PORT` in `agent\.env`. See [SimConnect connection](docs/architecture.md#simconnect-connection) for what auto-detection tries.

**A flight was not recorded, or recorded oddly**
- `agent.log` has a `Sample live/hold/out: ...` line each time the sample classification changes. It shows why a sample was ignored (placeholder position, menu camera, slew, replay). See [Flight detection](docs/architecture.md#flight-detection).

**Web UI keeps asking for a token**
- The viewer token does not match the Worker's `VIEWER_TOKEN` secret. See [docs/cloud-deploy.md](docs/cloud-deploy.md#troubleshooting).

**`Worker rejected AGENT_TOKEN` in agent.log**
- `agent\.env` has a different token than the Worker's `AGENT_TOKEN` secret. Fix `.env` and restart the agent; queued events are sent automatically.

**No airports shown for departure/arrival**
- The nearest-airport search uses a 10 nm radius. If you spawned in a remote location without a nearby airport, only coordinates are stored.

Service-specific problems are covered in [docs/service-install.md](docs/service-install.md#troubleshooting).
