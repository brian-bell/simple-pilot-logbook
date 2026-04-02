# AGENTS.md

## Purpose
Use this file for repository-specific rules that help coding agents make safe changes quickly.

## Project Snapshot
- App: `Simple Pilot Logbook`
- Goal: detect MSFS flights automatically and display them in a local web UI
- Runtime: FastAPI serves the API and static frontend; `SimConnectWorker` runs in a background thread
- Primary platform: Windows 10/11 for live SimConnect integration

## Key Files
- `backend/main.py`: FastAPI app, API routes, frontend static mount, lifespan hooks
- `backend/simconnect_worker.py`: SimConnect polling loop and flight state machine
- `backend/database.py`: PostgreSQL (Supabase) schema and CRUD helpers using a connection pool
- `.env`: database connection string (gitignored) — see `docs/setup-db.md`
- `docs/setup-db.md`: Supabase setup instructions
- `backend/airports.py`: nearest-airport lookup and haversine helpers
- `frontend/index.html`, `frontend/style.css`, `frontend/app.js`: vanilla frontend
- `start.bat`: local launcher
- `install_service.ps1`, `uninstall_service.ps1`, `backend/windows_service.py`: Windows service tooling
- `docs/service-install.md`: service install, update, and removal steps

## Working Rules
- Keep changes minimal and scoped to the request.
- Preserve API response shapes unless the task explicitly requires API changes.
- If backend API behavior changes, update `frontend/app.js` in the same task.
- Do not add frameworks, build tooling, or major abstractions unless explicitly requested.
- Prefer small readable functions over broad refactors.

## Backend Guardrails
- Preserve the FastAPI lifespan startup/shutdown flow.
- `SimConnectWorker` must remain a daemon thread started and stopped through app lifecycle hooks.
- Keep PostgreSQL access thread-safe via the `SimpleConnectionPool` in `database.py`.
- Preserve current flight-state behavior unless the user asks for a behavior change:
  - `DISCONNECTED -> ON_GROUND -> AIRBORNE`
  - flights shorter than 30 seconds are ignored
  - landing vertical speed is derived from trailing samples
- Treat SimConnect as optional. Offline mode must still allow historical logbook access.

## Frontend Guardrails
- Keep the frontend dependency-free.
- Preserve status polling, sorting, modal details, and delete behavior.
- Escape user- or sim-provided strings before injecting into HTML.
- Maintain usable desktop and mobile layouts.

## Data And Compatibility
- Database: remote PostgreSQL on Supabase (configured via `DATABASE_URL` in `.env`)
- `date` values are `TIMESTAMPTZ` (serialised as ISO 8601 strings by FastAPI)
- Avoid schema changes unless requested

## Validation
There is no formal automated test suite. After code changes, validate what applies:
1. Ensure `DATABASE_URL` is set in `.env` (see `docs/setup-db.md`).
2. Start the app and confirm `GET /api/status` and `GET /api/flights` return 200.
3. Confirm the frontend loads and renders flights.
4. Confirm sorting, modal open/close, and deletion still work.
5. If worker logic changed, verify offline behavior when MSFS/SimConnect is unavailable.
6. If service tooling changed, follow `docs/service-install.md` and verify install/update/remove behavior.

## Non-Goals
Do not do these unless explicitly requested:
- migrate to a JS framework
- redesign the UI broadly
- rewrite the app architecture

## Change Notes
For significant edits, report:
- files changed
- behavior changed
- validation performed
- limitations or follow-ups
