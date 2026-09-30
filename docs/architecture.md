# Architecture

How the agent, the Worker and the frontend fit together: the event contract, the HTTP API, live status and flight detection. For deployment see [cloud-deploy.md](cloud-deploy.md); for the Windows service see [service-install.md](service-install.md).

```
 sim PC                                   Cloudflare
 ┌──────────────────────────┐             ┌─────────────────────────────┐
 │ MSFS ──SimConnect──► agent│──HTTPS────► │ Worker  ── /api/* ──► D1     │
 │            (outbox.db)   │  events     │         ── /     ──► frontend│
 └──────────────────────────┘             └─────────────────────────────┘
                                                        ▲ browser (viewer token)
```

## Repository layout

| Path | Contents |
|---|---|
| `agent/` | Node.js/TypeScript agent for the sim PC; `service/` holds the WinSW template, `data/airports.json` the bundled airport list (~29k airports, mwgg/Airports open data) |
| `worker/` | Cloudflare Worker (TypeScript), `wrangler.jsonc`, D1 migrations |
| `frontend/` | Vanilla HTML/CSS/JS, served by Cloudflare as static assets |
| `docs/` | Deploy, service and architecture guides |
| `start.bat`, `install_service.ps1`, `uninstall_service.ps1` | Windows launcher and service scripts |

## Data flow

1. The agent reads the user aircraft through SimConnect and runs the flight state machine.
2. Flight events are written to `agent/outbox.db` first and deleted only after the Worker answers 2xx. Delivery retries with exponential backoff (up to 5 minutes); a request the Worker rejects as invalid dead-letters only the offending event.
3. A heartbeat with the live status goes out every 10 seconds. It is sent directly and dropped on failure, never queued.
4. The Worker stores flight events in D1 (`events`), materialises landings into `flights`, and overwrites the single `agent_status` row on each heartbeat.
5. The browser polls `/api/status` and `/api/flights` with the viewer token.

## HTTP API

All `/api/*` routes require `Authorization: Bearer <token>` and return JSON. The static frontend is public.

| Method | Path | Token | Description |
|--------|------|-------|-------------|
| `POST` | `/api/events` | agent | Ingest 1–20 events (see below) |
| `GET` | `/api/status` | viewer | Live state + current flight (if airborne) |
| `GET` | `/api/flights` | viewer | Paginated flight list (`?limit=&offset=`, default 100, max 500) |
| `GET` | `/api/flights/{id}` | viewer | Single flight detail |
| `DELETE` | `/api/flights/{id}` | viewer | Delete a flight entry (its events are kept) |

The agent token is accepted only for `POST /api/events` and the viewer token only for the other routes. If a secret is unset, every request for that role is rejected.

### `POST /api/events`

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

| Type | Sent by the agent | Stored as |
|---|---|---|
| `agent.heartbeat` | every 10 s | `agent_status` row only |
| `flight.takeoff` | at liftoff; its `id` is the `flight_uuid` shared by later events | `events` |
| `flight.position` | every 10 s while airborne (lat/lon/alt/vs/ground speed in knots) | `events` |
| `flight.landing` | when the flight ends | `events` + one `flights` row |
| `flight.import` | not sent; manual back-fill with the landing payload | `events` + one `flights` row |

Every event is idempotent on its `id`, so retries never duplicate a flight. A request is validated and written atomically; an invalid event returns `400 {"error": "...", "index": n}`. On success the response is `{"accepted": n, "inserted_flights": m}`.

### `GET /api/status`

```json
{ "connected": true, "state": "AIRBORNE", "on_ground": false, "paused": false,
  "current_flight": { "departure_icao": "KSFO", "aircraft_title": "…", "elapsed_seconds": 420, "altitude_ft": 2500, "…": "…" },
  "agent_seen_at": "2026-09-25T20:15:02Z" }
```

- `state` is `DISCONNECTED`, `ON_GROUND` or `AIRBORNE`. `ON_GROUND` also covers the sim menu and loading screens; `on_ground` is true only once a live sample showed the aircraft sitting on the ground.
- `paused` is true while the sim is paused during a flight.
- If the last heartbeat is more than 30 seconds old, the Worker reports the disconnected shape regardless of the stored row. While airborne, `elapsed_seconds` is extrapolated between heartbeats with the Worker clock.
- The frontend header shows Paused, In Flight, On Ground, Connected, or Disconnected. It shows **Agent offline** instead of Disconnected when `agent_seen_at` is more than a minute old.

## Flight detection

The agent subscribes to the user aircraft once per second (position, altitude, on-ground flag, vertical speed, ground speed, G, camera state, slew, touchdown velocity), to a per-frame stream that only reports changes in G force and touchdown values, and to the sim's `Sim`, `Pause_EX1`, `Crashed`, `CrashReset`, `FlightLoaded` and `AircraftLoaded` events. Nothing is polled.

```
DISCONNECTED ──connect──▶ ON_GROUND
ON_GROUND    ──takeoff──▶ AIRBORNE   (emits flight.takeoff: departure airport, timestamp, aircraft)
AIRBORNE     ──10 s────▶ AIRBORNE   (emits flight.position)
AIRBORNE     ──landing──▶ ON_GROUND  (emits flight.landing 3 s after touchdown)
```

- **Only real flying counts.** Each sample is classified `live`, `hold` or `out`, and only `live` samples change state. MSFS 2024 parks the aircraft at a placeholder position (lat 0 / lon 0 or lat 0 / lon 90E, sometimes above 50,000 ft) in the main menu and on loading screens; those samples are `out`. Menu, world-map and loading camera states, replays, slew mode and missing values are `hold`. This is what prevents "flights" departing from nowhere and landing thousands of miles away.
- **Landing vertical speed** comes from `PLANE TOUCHDOWN NORMAL VELOCITY` at the first contact. If the sim does not update it, the most negative vertical speed in the 6 seconds before touchdown is used. A bounce within 15 s counts as the same landing.
- **Landing G-force** is the peak G from the per-frame stream between just before touchdown and 3 seconds after it.
- **Flights that do not end with a landing** are still recorded. A crash reported by the sim gets `notes = "Crashed"` and the crash site as arrival. Quitting to the main menu (90 s at the placeholder position), teleporting (Travel To, restart), MSFS closing or the agent stopping mid-flight give `notes = "Ended without landing"` with no arrival. If the agent starts while you are already airborne, the flight has no departure airport and `notes = "Started in the air"`.
- Flights shorter than 30 seconds are discarded whatever the ending.
- Departure and arrival airports are the nearest airport in the bundled dataset within 10 nm; otherwise only coordinates are stored.
- Duration is wall-clock time from takeoff to touchdown. Pauses are logged (`Pause_EX1`) but not subtracted.
- The `Sim` event is logged only: MSFS 2024 does not send SimStop when returning to the main menu.

## SimConnect connection

The agent tries node-simconnect's auto-detection first (`SimConnect.cfg`, the named pipe, the registry port), then any static IPv4 port declared in `SimConnect.xml` (`%APPDATA%\Microsoft Flight Simulator 2024\` or the Store package's `LocalCache`, checked for every user profile). Setting both `SIMCONNECT_HOST` and `SIMCONNECT_PORT` in `agent\.env` forces a single TCP endpoint. It retries every 5 seconds and logs `MSFS not reachable` once, then every 5 minutes, while waiting. Once attached, `agent.log` shows `Connected to MSFS 2024 via ...`.

## Storage

- **D1** (`worker/migrations/`): `events` (append-only log of everything except heartbeats), `flights` (the logbook: 17 flight columns plus `event_id` and `created_at`), `agent_status` (one row, overwritten by heartbeats).
- **Agent outbox** (`agent/outbox.db`, `node:sqlite`): pending events with retry and dead-letter bookkeeping. Roughly hourly, undelivered `flight.position` rows older than 7 days and all but the newest 1,000 dead-lettered rows are pruned; landings are never pruned.

The one-off importer for the pre-Cloudflare `backend/logbook.db` was retired with the Python agent; it is in git history at commit `84af342`.
