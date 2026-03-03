# AGENTS.md

## Purpose
This document gives coding agents a fast, reliable way to work in this repository without breaking core behavior.

## Project Summary
- App: `Simple Pilot Logbook`
- Goal: Automatically log Microsoft Flight Simulator flights (takeoff to landing) and display them in a web UI.
- Runtime model: FastAPI backend serves REST API and static frontend; background thread polls SimConnect.

## Tech Stack
- Backend: Python 3.11+, FastAPI, Uvicorn, SimConnect, SQLite
- Frontend: Vanilla HTML/CSS/JavaScript (no build step)
- OS assumptions: Windows 10/11 for live SimConnect integration

## Repository Layout
- `backend/main.py`: FastAPI app, API routes, static mount, worker lifecycle
- `backend/simconnect_worker.py`: flight state machine and SimConnect polling thread
- `backend/database.py`: SQLite schema and CRUD helpers (`backend/logbook.db`)
- `backend/airports.py`: nearest-airport lookup and haversine helpers
- `backend/data/airports.json`: airport dataset
- `frontend/index.html`, `frontend/style.css`, `frontend/app.js`: UI
- `start.bat`: one-click local start on Windows

## Run and Setup
- Preferred quick start:
  - `start.bat`
- Manual start:
  - `cd backend`
  - `python -m pip install -r requirements.txt`
  - `python -m uvicorn main:app --host 0.0.0.0 --port 8080`
- App URL: `http://localhost:8080`

## Agent Workflow Expectations
- Keep changes minimal and focused on the request.
- Preserve API shapes unless the task explicitly asks for API changes.
- If changing API responses, update frontend usage in `frontend/app.js` in the same task.
- Avoid adding new frameworks or build tooling unless explicitly requested.
- Prefer small, readable functions over abstraction-heavy refactors.

## Backend Guardrails
- `SimConnectWorker` is a daemon thread started/stopped via FastAPI lifespan; preserve this lifecycle.
- Keep database access thread-safe: follow the current pattern of short-lived SQLite connections.
- Maintain current flight-state behavior unless explicitly asked:
  - states: `DISCONNECTED -> ON_GROUND -> AIRBORNE`
  - ignore flights shorter than 30 seconds
  - derive landing VS from recent trailing samples
- Treat SimConnect availability as optional on unsupported hosts (offline mode should still allow historical logbook access).

## Frontend Guardrails
- Stay dependency-free (vanilla JS/CSS/HTML).
- Keep table sorting, status polling, modal details, and delete behavior intact.
- Escape user/sim-provided strings before injecting into HTML.
- Maintain responsive behavior for both desktop and mobile.

## Data and Compatibility
- SQLite file is local: `backend/logbook.db`.
- `date` values are ISO-style strings; avoid schema changes unless requested.
- Preserve compatibility with existing records when possible.

## Testing and Validation
No formal automated test suite is currently defined. After code changes, validate manually:
1. Start server and confirm `GET /api/status` and `GET /api/flights` return 200.
2. Confirm frontend loads and table renders.
3. Confirm sorting, modal open/close, and deletion still work.
4. If touching worker logic, verify offline mode still behaves gracefully when MSFS/SimConnect is unavailable.

## Non-Goals (unless requested)
- Migrating to a JS framework
- Replacing SQLite
- Large UI redesigns
- Major architecture rewrites

## Change Notes
When making significant edits, include a brief summary of:
- files changed
- behavior changed
- manual validation performed
- any limitations or follow-ups
