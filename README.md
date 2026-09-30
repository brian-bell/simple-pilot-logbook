# Simple Pilot Logbook

Automatically records your Microsoft Flight Simulator flights and shows them in a web logbook you can open from anywhere.

A small Node.js **agent** on the sim PC watches MSFS through SimConnect, detects takeoffs and landings, and sends events to a **Cloudflare Worker**. The Worker stores them in **Cloudflare D1** and serves the logbook web app.

```
 sim PC                                   Cloudflare
 ┌──────────────────────────┐             ┌─────────────────────────────┐
 │ MSFS ──SimConnect──► agent│──HTTPS────► │ Worker  ── /api/* ──► D1     │
 │            (outbox.db)   │  events     │         ── /     ──► frontend│
 └──────────────────────────┘             └─────────────────────────────┘
                                                        ▲ browser (viewer token)
```

## Features

- **Automatic flight recording** — detects takeoffs and landings via SimConnect; no manual input required
- **Per-flight data**: departure airport, arrival airport, straight-line distance (nm), flight duration, maximum altitude, landing vertical speed, landing G-force, aircraft type and registration
- **Live status banner** — shows current aircraft, altitude, and elapsed time while airborne
- **Status indicator** — green when MSFS is connected, red when MSFS is closed or the agent is offline
- **Sortable logbook** — click any column header to sort
- **Detail modal** — click any row for full flight data
- **Hosted logbook** — the web app runs on Cloudflare and works whether or not the sim PC is on
- **Offline resilient agent** — events are queued locally and uploaded when the Worker is reachable again
- **Token protected** — every API call needs a bearer token; the UI asks for a viewer token once per browser

## Requirements

| Component | Requirement | Notes |
|---|---|---|
| Agent (sim PC) | Windows 10/11 | SimConnect only runs on Windows |
| Agent (sim PC) | Node.js 22.13+ and npm | Talks SimConnect directly through [node-simconnect](https://github.com/EvenAR/node-simconnect); no SimConnect SDK or DLL needed |
| Agent (sim PC) | Microsoft Flight Simulator 2024 | Built for SU6 (1.8.x) and later. MSFS 2020 is supported best-effort through the older SimConnect protocol |
| Worker | Cloudflare account (free plan is enough) | D1 + Workers Static Assets |
| Deploying | Node.js 22+ and npm | Only on the machine you deploy from; wrangler 4.141 requires Node 22 |

## Quick Start

1. **Deploy the Worker** once — follow [docs/cloud-deploy.md](docs/cloud-deploy.md) (`wrangler login`, create the D1 database, set the two token secrets, `wrangler deploy`). You end up with a URL like `https://simple-pilot-logbook.<account>.workers.dev`.
2. **Configure the agent**: copy `agent\.env.example` to `agent\.env`, set `WORKER_URL` and `AGENT_TOKEN`.
3. **Start the agent**: double-click **`start.bat`** (installs dependencies, builds, opens the logbook, runs the agent), or install it as a Windows service per [docs/service-install.md](docs/service-install.md).
4. **Open the logbook URL**, enter the viewer token, then fly. Flights appear after touchdown.

Migrating from the old local-only version? The one-off `import_legacy.py` importer was retired with the Python agent; it is in git history at commit `84af342` if you still need it.

## Project Structure

```
simple-pilot-logbook/
├── agent/                       # Node.js (TypeScript) agent on the sim PC
│   ├── src/main.ts              # entry point: SimConnect worker + sender + heartbeat loop
│   ├── src/simconnect_client.ts # node-simconnect connection, data definitions, system events
│   ├── src/flight_detector.ts   # takeoff/landing state machine (pure logic, no I/O)
│   ├── src/simconnect_worker.ts # wires the client to the detector and the outbox
│   ├── src/events.ts            # event envelopes shared with the Worker contract
│   ├── src/outbox.ts            # SQLite outbox (agent/outbox.db, node:sqlite) so nothing is lost offline
│   ├── src/sender.ts            # batches outbox → POST /api/events with retry/backoff
│   ├── src/config.ts            # reads agent/.env (WORKER_URL, AGENT_TOKEN, ...)
│   ├── src/airports.ts          # haversine distance + nearest-airport lookup
│   ├── src/log.ts               # rotating agent.log
│   ├── service/                 # WinSW service template (install_service.ps1 fills it in)
│   ├── package.json, tsconfig.json
│   ├── .env.example
│   └── data/airports.json       # ~29 k airports (mwgg/Airports, open data)
├── worker/                      # Cloudflare Worker (TypeScript) + D1
│   ├── wrangler.jsonc           # bindings: D1 "DB", static assets from ../frontend
│   ├── migrations/0001_init.sql # events, flights, agent_status tables
│   └── src/                     # index.ts (router), auth.ts, events.ts, flights.ts, status.ts, db.ts
├── frontend/                    # vanilla HTML/CSS/JS served by the Worker as static assets
│   ├── index.html
│   ├── style.css
│   └── app.js
├── docs/
│   ├── cloud-deploy.md          # Worker + D1 setup, local dev
│   └── service-install.md       # Windows service install/uninstall
├── start.bat                    # Windows one-click agent launcher
├── install_service.ps1          # Windows service installer
├── uninstall_service.ps1        # Windows service uninstaller
└── README.md
```

## API Reference

All `/api/*` routes require `Authorization: Bearer <token>` and return JSON. The static frontend is public.

| Method | Path | Token | Description |
|--------|------|-------|-------------|
| `POST` | `/api/events` | agent | Ingest 1–20 events (see below) |
| `GET` | `/api/status` | viewer | Live state + current flight (if airborne) |
| `GET` | `/api/flights` | viewer | Paginated flight list (`?limit=&offset=`) |
| `GET` | `/api/flights/export.csv` | viewer | Download every flight as CSV (backup) |
| `GET` | `/api/flights/{id}` | viewer | Single flight detail |
| `DELETE` | `/api/flights/{id}` | viewer | Delete a flight entry (its events are kept) |

### `POST /api/events` body

```json
{
  "events": [
    {
      "id": "6f1c2a3e-…",
      "type": "flight.landing",
      "ts": "2026-09-25T20:15:02+00:00",
      "payload": {
        "date": "2026-09-25T19:40:11+00:00",
        "aircraft_title": "Cessna 172 Skyhawk",
        "aircraft_registration": "N12345",
        "departure_icao": "KSFO",
        "arrival_icao": "KOAK",
        "distance_nm": 11.2,
        "elapsed_seconds": 1320,
        "max_altitude_ft": 2500,
        "landing_vs_fpm": -150,
        "landing_g_force": 1.12,
        "notes": null
      }
    }
  ]
}
```

Event types: `agent.heartbeat` (updates live status, not stored), `flight.takeoff`, `flight.position`, `flight.landing`, `flight.import` (manual back-fill; same payload as a landing). Every event is idempotent on its `id`, so retries never duplicate a flight. The response is `{"accepted": n, "inserted_flights": m}`.

## How Flight Detection Works

The agent subscribes to the user aircraft once per second (position, altitude, on-ground flag, vertical speed, ground speed, G, camera state, slew, touchdown velocity), to a per-frame stream that only reports changes in G force and touchdown values, and to the sim's `Sim`, `Pause_EX1`, `Crashed`, `FlightLoaded` and `AircraftLoaded` events. Nothing is polled.

```
DISCONNECTED ──connect──▶ ON_GROUND
ON_GROUND    ──takeoff──▶ AIRBORNE   (emits flight.takeoff: departure airport, timestamp, aircraft)
AIRBORNE     ──10 s────▶ AIRBORNE   (emits flight.position: lat/lon/alt/vs/ground speed in knots)
AIRBORNE     ──landing──▶ ON_GROUND  (emits flight.landing 3 s after touchdown)
```

- **Only real flying counts.** MSFS 2024 parks the aircraft at a placeholder position (lat 0 / lon 0 or lat 0 / lon 90E, sometimes above 50,000 ft) in the main menu and on loading screens. Those samples, menu/world-map/loading camera states, replays and slew mode never start or end a flight. This is what used to create "flights" departing from nowhere and landing 7,000+ nm away.
- **Landing vertical speed** comes from the sim's `PLANE TOUCHDOWN NORMAL VELOCITY` at the first contact. If the sim does not update it, the most negative vertical speed in the 6 seconds before touchdown is used. A bounce within 15 s counts as the same landing.
- **Landing G-force** is the peak G from the per-frame stream between just before touchdown and 3 seconds after it.
- **Flights that do not end with a landing** are still recorded. A crash reported by the sim gets `notes = "Crashed"` and the crash site as arrival. Quitting to the main menu (90 s at the placeholder position), teleporting (Travel To, restart), MSFS closing or the agent stopping mid-flight give `notes = "Ended without landing"` with no arrival. If the agent starts while you are already airborne, the flight has no departure airport and `notes = "Started in the air"`.
- Flights shorter than 30 seconds are discarded whatever the ending.
- Departure and arrival airports are the nearest airport in the bundled dataset within 10 nm.
- Duration is wall-clock time from takeoff to touchdown; pauses are logged (`Pause_EX1`) but not subtracted yet.
- Events are written to `agent/outbox.db` first and deleted only after the Worker acknowledges them. A heartbeat with the live status goes out every 10 seconds and is never queued.

## Landing Quality

| Vertical Speed | Rating |
|---|---|
| Better than −200 fpm | Smooth (green) |
| −200 to −400 fpm | Firm (yellow) |
| Worse than −400 fpm | Hard (red) |

## Troubleshooting

**Status shows "Agent offline"**
- The Worker has not received a heartbeat for over a minute. Check the agent is running (`start.bat` window or `Get-Service SimplePilotLogbook`) and look at `agent\agent.log`.

**Status shows "Disconnected"**
- The agent is running but MSFS is not, or SimConnect could not attach. Start MSFS; the agent reconnects every 5 seconds.
- `agent\agent.log` shows `Connected to MSFS 2024 via ...` once attached. The agent tries node-simconnect's auto-detection first (`SimConnect.cfg`, the named pipe, the registry port), then any static IPv4 port declared in `SimConnect.xml` (`%APPDATA%\Microsoft Flight Simulator 2024\` or the Store package's `LocalCache`, checked for every user profile). To force an endpoint, set `SIMCONNECT_HOST` and `SIMCONNECT_PORT` in `agent\.env`.

**A flight was not recorded, or recorded oddly**
- `agent\agent.log` has a `Sample live/hold/out: ...` line each time the classification changes, with the camera state and position. They show why a sample was ignored (placeholder position, menu camera, slew, replay).

**Web UI keeps asking for a token**
- The viewer token does not match the Worker's `VIEWER_TOKEN` secret. See [docs/cloud-deploy.md](docs/cloud-deploy.md).

**`Worker rejected AGENT_TOKEN` in agent.log**
- `agent\.env` has a different token than the Worker's `AGENT_TOKEN` secret. Fix `.env` and restart the agent; queued events are sent automatically.

**No airports shown for departure/arrival**
- The nearest-airport search uses a 10 nm radius. If you spawned in a remote location without a nearby airport, coordinates are stored instead.
