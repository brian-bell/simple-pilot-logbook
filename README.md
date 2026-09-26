# Simple Pilot Logbook

Automatically records your Microsoft Flight Simulator flights and shows them in a web logbook you can open from anywhere.

A small Python **agent** on the sim PC watches MSFS through SimConnect, detects takeoffs and landings, and sends events to a **Cloudflare Worker**. The Worker stores them in **Cloudflare D1** and serves the logbook web app.

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
| Agent (sim PC) | Python 3.11+ **64-bit** | 32-bit Python will fail to load SimConnect.dll |
| Agent (sim PC) | Microsoft Flight Simulator 2020 or 2024 | Must be running for live data collection |
| Worker | Cloudflare account (free plan is enough) | D1 + Workers Static Assets |
| Deploying | Node.js 18+ and npm | Only on the machine you deploy from |

## Quick Start

1. **Deploy the Worker** once — follow [docs/cloud-deploy.md](docs/cloud-deploy.md) (`wrangler login`, create the D1 database, set the two token secrets, `wrangler deploy`). You end up with a URL like `https://simple-pilot-logbook.<account>.workers.dev`.
2. **Configure the agent**: copy `agent\.env.example` to `agent\.env`, set `WORKER_URL` and `AGENT_TOKEN`.
3. **Start the agent**: double-click **`start.bat`** (installs dependencies, opens the logbook, runs the agent), or install it as a Windows service per [docs/service-install.md](docs/service-install.md).
4. **Open the logbook URL**, enter the viewer token, then fly. Flights appear after touchdown.

Migrating from the old local-only version? `agent\import_legacy.py` copies `backend\logbook.db` into D1 — see the cloud deploy doc.

## Project Structure

```
simple-pilot-logbook/
├── agent/                       # Python service on the sim PC
│   ├── main.py                  # entry point: SimConnect worker + sender + heartbeat loop
│   ├── simconnect_worker.py     # 2 s SimConnect poll, takeoff/landing state machine, emits events
│   ├── events.py                # event envelopes, SimVar string decoding, legacy cleanup
│   ├── outbox.py                # SQLite outbox (agent/outbox.db) so nothing is lost offline
│   ├── sender.py                # batches outbox → POST /api/events with retry/backoff
│   ├── config.py                # reads agent/.env (WORKER_URL, AGENT_TOKEN, ...)
│   ├── airports.py              # haversine distance + nearest-airport lookup
│   ├── import_legacy.py         # one-off migration of the old logbook.db
│   ├── windows_service.py       # Windows service host
│   ├── requirements.txt
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
│   ├── cloud-deploy.md          # Worker + D1 setup, local dev, legacy import
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

The agent polls MSFS every 2 seconds and implements a simple state machine:

```
DISCONNECTED ──connect──▶ ON_GROUND
ON_GROUND    ──takeoff──▶ AIRBORNE   (emits flight.takeoff: departure coords, timestamp, aircraft)
AIRBORNE     ──10 s────▶ AIRBORNE   (emits flight.position: lat/lon/alt/vs/gs)
AIRBORNE     ──landing──▶ ON_GROUND  (emits flight.landing: arrival coords, peak descent VS, G-force)
```

- Flights shorter than 30 seconds are discarded (prevents false records from runway bumps).
- Landing vertical speed is the most negative reading in the 6-second window before touchdown.
- Departure and arrival airports are identified by finding the nearest airport in the bundled dataset within 10 nm.
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
- Use 64-bit Python — run `python -c "import struct; print(struct.calcsize('P')*8)"` and verify it prints `64`.

**Web UI keeps asking for a token**
- The viewer token does not match the Worker's `VIEWER_TOKEN` secret. See [docs/cloud-deploy.md](docs/cloud-deploy.md).

**`Worker rejected AGENT_TOKEN` in agent.log**
- `agent\.env` has a different token than the Worker's `AGENT_TOKEN` secret. Fix `.env` and restart the agent; queued events are sent automatically.

**No airports shown for departure/arrival**
- The nearest-airport search uses a 10 nm radius. If you spawned in a remote location without a nearby airport, coordinates are stored instead.
