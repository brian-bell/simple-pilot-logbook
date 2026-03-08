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
- `backend/database.py`: SQLite schema and CRUD helpers using short-lived connections
- `backend/airports.py`: nearest-airport lookup and haversine helpers
- `frontend/index.html`, `frontend/style.css`, `frontend/app.js`: vanilla frontend
- `start.bat`: local launcher
- `install_service.ps1`, `uninstall_service.ps1`, `backend/windows_service.py`: Windows service tooling
- `backend/secrets_store.py`: read secrets from Windows Credential Manager (keyring) with env-var fallback
- `manage_secrets.py`: CLI helper to set/get/delete/list secrets in the credential store
- `docs/adrs/001-secret-management.md`: ADR for secret management approach
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
- Keep SQLite access thread-safe by following the current short-lived connection pattern.
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
- Local database path: `backend/logbook.db`
- `date` values are ISO-style strings
- Avoid schema changes unless requested
- Preserve compatibility with existing logbook records when possible

## Validation
There is no formal automated test suite. After code changes, validate what applies:
1. Start the app and confirm `GET /api/status` and `GET /api/flights` return 200.
2. Confirm the frontend loads and renders flights.
3. Confirm sorting, modal open/close, and deletion still work.
4. If worker logic changed, verify offline behavior when MSFS/SimConnect is unavailable.
5. If service tooling changed, follow `docs/service-install.md` and verify install/update/remove behavior.

## Non-Goals
Do not do these unless explicitly requested:
- migrate to a JS framework
- replace SQLite
- redesign the UI broadly
- rewrite the app architecture

## Change Notes
For significant edits, report:
- files changed
- behavior changed
- validation performed
- limitations or follow-ups
