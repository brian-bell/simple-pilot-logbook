# Simple Pilot Logbook

A lightweight web application that automatically records your Microsoft Flight Simulator flights. The backend connects to MSFS via SimConnect, detects takeoffs and landings, and stores each flight in a local SQLite database. The frontend shows a clean, sortable logbook table.

## Features

- **Automatic flight recording** — detects takeoffs and landings via SimConnect; no manual input required
- **Per-flight data**: departure airport, arrival airport, straight-line distance (nm), flight duration, maximum altitude, landing vertical speed, landing G-force, aircraft type and registration
- **Live status banner** — shows current aircraft, altitude, and elapsed time while airborne
- **SimConnect indicator** — green dot when MSFS is connected, red when offline
- **Sortable logbook** — click any column header to sort
- **Detail modal** — click any row for full flight data
- **Offline resilient** — logbook still shows historical flights when MSFS is not running

## Requirements

| Requirement | Notes |
|---|---|
| Windows 10/11 | SimConnect only runs on Windows |
| Python 3.11+ **64-bit** | 32-bit Python will fail to load SimConnect.dll |
| Microsoft Flight Simulator 2020 or 2024 | Must be running for live data collection |
| SimConnect SDK | Included with MSFS; no extra install needed |

## Quick Start

1. **Clone or download** this repository.
2. Double-click **`start.bat`** — it installs dependencies and opens the logbook in your browser automatically.
3. Load any aircraft in MSFS, take off, fly, and land — the flight will appear in the logbook after touchdown.

## Install As A Windows Service

See [docs/service-install.md](docs/service-install.md) for the full install, update, and uninstall workflow.

Primary install command:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\install_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

Primary uninstall command:

```powershell
.\uninstall_service.ps1 -PythonCommand "C:\Users\bellb\AppData\Local\Programs\Python\Python311\python.exe"
```

If service startup fails, check `backend/service.log` for the Python traceback.

## Backup Configuration

The backend can create append-only SQLite backups once more than 24 hours have
passed since the last successful backup for each target. Old backups are
deleted after 30 days by default.

Supported targets:

- local folder backup, defaulting to `~/Documents/SimplePilotLogbook/backups`
- DigitalOcean Spaces backup via S3-compatible uploads

Configuration is done with environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `LOGBOOK_BACKUP_LOCAL_ENABLED` | `true` | Enable local folder backups |
| `LOGBOOK_BACKUP_LOCAL_DIR` | `~/Documents/SimplePilotLogbook/backups` | Local backup directory |
| `LOGBOOK_BACKUP_SPACES_ENABLED` | `false` | Enable DigitalOcean Spaces backups |
| `LOGBOOK_BACKUP_SPACES_BUCKET` |  | Spaces bucket name |
| `LOGBOOK_BACKUP_SPACES_REGION` | `nyc3` | Spaces region, also used for the endpoint |
| `LOGBOOK_BACKUP_SPACES_KEY` |  | Spaces access key ID |
| `LOGBOOK_BACKUP_SPACES_SECRET` |  | Spaces secret key |
| `LOGBOOK_BACKUP_SPACES_PREFIX` | `logbook-backups` | Object prefix inside the bucket |
| `LOGBOOK_BACKUP_RETENTION_DAYS` | `30` | Retention window for old backups |
| `LOGBOOK_BACKUP_CHECK_INTERVAL_SECONDS` | `3600` | How often the app checks whether a backup is due |
| `LOGBOOK_BACKUP_FILENAME_PREFIX` | `logbook` | Prefix for backup filenames |

The backup worker runs inside the existing FastAPI process. If you install the
app as a Windows service, the backup checks run inside that same service.

For Terraform scaffolding of the Spaces bucket and access key, see
[infra/terraform/README.md](infra/terraform/README.md).

## Manual Start

```bat
cd backend
pip install -r requirements.txt
python -m uvicorn main:app --host 0.0.0.0 --port 8080
```

Then open [http://localhost:8080](http://localhost:8080) in your browser.

## Project Structure

```
simple-pilot-logbook/
├── backend/
│   ├── main.py                  # FastAPI app (API routes + static file serving)
│   ├── database.py              # SQLite init and CRUD helpers
│   ├── simconnect_worker.py     # Background thread — flight state machine
│   ├── airports.py              # Haversine distance + nearest-airport lookup
│   ├── requirements.txt
│   └── data/
│       └── airports.json        # ~29 k airports (mwgg/Airports, open data)
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
├── start.bat                    # Windows one-click launcher
├── install_service.ps1          # Windows service installer
├── uninstall_service.ps1        # Windows service uninstaller
└── README.md
```

## API Reference

All endpoints are served from the same origin as the frontend.

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/status` | SimConnect state + current flight (if airborne) |
| `GET` | `/api/flights` | Paginated flight list (`?limit=&offset=`) |
| `GET` | `/api/flights/{id}` | Single flight detail |
| `POST` | `/api/flights` | Manually add a flight entry (JSON body) |
| `DELETE` | `/api/flights/{id}` | Delete a flight entry |

### `POST /api/flights` body

```json
{
  "date": "2024-12-15T14:30:00Z",
  "aircraft_title": "Cessna 172 Skyhawk",
  "aircraft_registration": "N12345",
  "departure_icao": "KSFO",
  "arrival_icao": "KOAK",
  "distance_nm": 11.2,
  "elapsed_seconds": 1320,
  "max_altitude_ft": 2500,
  "landing_vs_fpm": -150,
  "landing_g_force": 1.12,
  "notes": "First solo cross-country"
}
```

## How Flight Detection Works

The SimConnect worker thread polls MSFS every 2 seconds and implements a simple state machine:

```
DISCONNECTED ──connect──▶ ON_GROUND
ON_GROUND    ──takeoff──▶ AIRBORNE   (records: departure coords, timestamp, aircraft)
AIRBORNE     ──landing──▶ ON_GROUND  (records: arrival coords, peak descent VS, G-force → saves to DB)
```

- Flights shorter than 30 seconds are discarded (prevents false records from runway bumps).
- Landing vertical speed is the most negative reading in the 6-second window before touchdown.
- Departure and arrival airports are identified by finding the nearest airport in the bundled dataset within 10 nm.

## Landing Quality

| Vertical Speed | Rating |
|---|---|
| Better than −200 fpm | Smooth (green) |
| −200 to −400 fpm | Firm (yellow) |
| Worse than −400 fpm | Hard (red) |

## Troubleshooting

**SimConnect shows "Disconnected"**
- Ensure MSFS is running *before* starting the logbook server.
- Use 64-bit Python — run `python -c "import struct; print(struct.calcsize('P')*8)"` and verify it prints `64`.
- The server will automatically reconnect every 5 seconds once MSFS is running.

**No airports shown for departure/arrival**
- The nearest-airport search uses a 10 nm radius. If you spawned in a remote location without a nearby airport, coordinates are stored instead.

**Port 8080 already in use**
- Change the port: `python -m uvicorn main:app --port 8181` and update the `start.bat` accordingly.








