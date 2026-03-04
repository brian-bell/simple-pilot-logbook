# AGENTS.md

## Purpose
This document gives coding agents a fast, reliable way to work in this repository without breaking core behavior.

## Project Summary
- App: `Simple Pilot Logbook`
- Goal: Automatically log Microsoft Flight Simulator flights (takeoff to landing) and display them in a web UI.
- Runtime model: FastAPI backend serves REST API and built frontend assets; background thread polls SimConnect.

## Tech Stack
- Backend: Python 3.11+, FastAPI, Uvicorn, SimConnect, SQLite
- Frontend: React 19 + TanStack Start/Router + TanStack Query + Vite + TypeScript + Tailwind CSS v4
- OS assumptions: Windows 10/11 for live SimConnect integration

## Repository Layout
- `backend/main.py`: FastAPI app, API routes, static mount, worker lifecycle
- `backend/simconnect_worker.py`: flight state machine and SimConnect polling thread
- `backend/database.py`: SQLite schema and CRUD helpers (`backend/logbook.db`)
- `backend/airports.py`: nearest-airport lookup and haversine helpers
- `backend/data/airports.json`: airport dataset
- `frontend/src/routes`: TanStack file routes (`__root.tsx`, `index.tsx`)
- `frontend/src/components`: UI components (table, modal, status banner, etc.)
- `frontend/src/api`: frontend API client, queries, and mutations
- `frontend/src/router.tsx`, `frontend/src/routeTree.gen.ts`: router setup/generated tree
- `frontend/src/client.tsx`: custom client entry for hydration
- `frontend/src/styles/app.css`: app styles
- `frontend/dist/client`: built static frontend served by FastAPI
- `start.bat`: one-click local start on Windows

## Run and Setup
- Preferred quick start:
  - `start.bat`
- Backend only:
  - `cd backend`
  - `python -m pip install -r requirements.txt`
  - `python -m uvicorn main:app --host 0.0.0.0 --port 8080`
- Frontend dev server:
  - `cd frontend`
  - `npm install`
  - `npm run dev`
  - Dev UI URL: `http://localhost:3000` (proxies `/api` to backend)
- Frontend production build:
  - `cd frontend`
  - `npm run build`
  - Output is served from `frontend/dist/client` at `http://localhost:8080`

## Agent Workflow Expectations
- Keep changes minimal and focused on the request.
- Preserve API shapes unless the task explicitly asks for API changes.
- If changing API responses, update frontend usage in `frontend/src/api` and affected components/routes in the same task.
- Avoid introducing additional frontend frameworks beyond the existing TanStack React stack unless explicitly requested.
- Prefer small, readable functions over abstraction-heavy refactors.
- Do not hand-edit `frontend/src/routeTree.gen.ts` (generated file).

## Backend Guardrails
- `SimConnectWorker` is a daemon thread started/stopped via FastAPI lifespan; preserve this lifecycle.
- Keep database access thread-safe: follow the current pattern of short-lived SQLite connections.
- Maintain current flight-state behavior unless explicitly asked:
  - states: `DISCONNECTED -> ON_GROUND -> AIRBORNE`
  - ignore flights shorter than 30 seconds
  - derive landing VS from recent trailing samples
- Treat SimConnect availability as optional on unsupported hosts (offline mode should still allow historical logbook access).

## Frontend Guardrails
- Keep the existing TanStack architecture (Start + Router + Query + React Table).
- Preserve current UX behavior: table sorting, status polling, modal details, and delete flow.
- Keep API access centralized through `frontend/src/api/*` helpers.
- Maintain responsive behavior for both desktop and mobile.
- Keep route definitions file-based under `frontend/src/routes`.
- When changing the app entry/hydration, ensure no runtime dependency on a global `React` symbol.

## Data and Compatibility
- SQLite file is local: `backend/logbook.db`.
- `date` values are ISO-style strings; avoid schema changes unless requested.
- Preserve compatibility with existing records when possible.

## Testing and Validation
No formal automated test suite is currently defined. After code changes, validate manually:
1. Start backend and confirm `GET /api/status` and `GET /api/flights` return 200.
2. Confirm frontend loads in both `http://localhost:3000` (dev) and `http://localhost:8080` (built assets).
3. Confirm sorting, modal open/close, and deletion still work.
4. If touching worker logic, verify offline mode still behaves gracefully when MSFS/SimConnect is unavailable.
5. If touching frontend build/entry files, run `npm run build` and verify output is generated in `frontend/dist/client`.

## Non-Goals (unless requested)
- Replacing SQLite
- Large UI redesigns
- Major architecture rewrites
- Replacing TanStack/React with a different frontend framework

## Change Notes
When making significant edits, include a brief summary of:
- files changed
- behavior changed
- manual validation performed
- any limitations or follow-ups
