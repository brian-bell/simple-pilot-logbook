# AGENTS.md

## Purpose
Use this file for repository-specific rules that help coding agents make safe changes quickly.

## Project Snapshot
- App: `Simple Pilot Logbook`
- Goal: detect MSFS flights automatically on the sim PC and display them in a cloud-hosted web logbook
- Architecture: a Python **agent** (Windows service) sends events over HTTPS to a **Cloudflare Worker**; the Worker stores them in **D1** and serves the vanilla frontend as static assets
- Primary platform: Windows 10/11 for the agent (live SimConnect); the Worker is platform-neutral TypeScript

## Key Files
- `agent/main.py`: agent entry point; starts `SimConnectWorker` + `Sender`, sends a heartbeat every 10 s
- `agent/simconnect_worker.py`: SimConnect polling loop and flight state machine; emits events through a callback
- `agent/events.py`: event envelopes (`id`, `type`, `ts`, `payload`), `decode_simvar_str`, `clean_legacy_str`
- `agent/outbox.py`: SQLite outbox (`agent/outbox.db`) using short-lived connections
- `agent/sender.py`: drains the outbox in batches with retry/backoff; `post_now()` for heartbeats
- `agent/config.py`: reads `agent/.env` (`WORKER_URL`, `AGENT_TOKEN`, optional cadences)
- `agent/airports.py`: nearest-airport lookup and haversine helpers (bundled `agent/data/airports.json`)
- `agent/import_legacy.py`: one-off migration of the old `backend/logbook.db`
- `agent/windows_service.py`, `install_service.ps1`, `uninstall_service.ps1`: Windows service tooling
- `worker/wrangler.jsonc`: Worker config (D1 binding `DB`, assets from `../frontend`, `run_worker_first: ["/api/*"]`)
- `worker/migrations/*.sql`: D1 schema (`events`, `flights`, `agent_status`)
- `worker/src/index.ts`: router + auth dispatch; `auth.ts`, `events.ts` (ingest), `flights.ts`, `status.ts`, `db.ts`
- `frontend/index.html`, `frontend/style.css`, `frontend/app.js`: vanilla frontend
- `docs/cloud-deploy.md`, `docs/service-install.md`: deploy, local dev, service install/remove
- `start.bat`: local agent launcher

## Working Rules
- Keep changes minimal and scoped to the request.
- Preserve API response shapes unless the task explicitly requires API changes.
- If Worker API behavior changes, update `frontend/app.js` in the same task.
- If the event contract changes, update `agent/events.py` and `worker/src/events.ts` together.
- Do not add frameworks, build tooling, or major abstractions unless explicitly requested (no Hono/Express in the Worker, no JS framework in the frontend, stdlib HTTP in the agent).
- Prefer small readable functions over broad refactors.

## Agent Guardrails
- `SimConnectWorker` must remain a daemon thread; it emits events via `on_event` and never does network I/O itself.
- Keep SQLite access thread-safe by following the short-lived connection pattern in `agent/outbox.py`.
- Preserve current flight-state behavior unless the user asks for a behavior change:
  - `DISCONNECTED -> ON_GROUND -> AIRBORNE`
  - flights shorter than 30 seconds are ignored
  - landing vertical speed is derived from trailing samples
- Treat SimConnect as optional: the agent must start and heartbeat on hosts without SimConnect/MSFS.
- String SimVars arrive as `bytes`; always pass them through `decode_simvar_str`.
- Events go to the outbox first and are deleted only after a 2xx from the Worker. Heartbeats are send-or-drop and never queued.
- Never log `AGENT_TOKEN` (or any token). Log status codes and response snippets only.
- Config is read from `agent/.env` next to the code, not from the current working directory.

## Worker Guardrails
- Every `/api/*` route requires a bearer token: `AGENT_TOKEN` only for `POST /api/events`, `VIEWER_TOKEN` for everything else. No cross-acceptance; an unset secret must fail closed.
- Ingest is idempotent on event `id`. Keep the statement order in `events.ts`: guarded flight insert **before** the event insert, all inside one `env.DB.batch()`.
- Max 20 events per request (D1 free plan allows 50 queries per invocation).
- `GET /api/status`, `GET /api/flights`, `GET /api/flights/{id}`, `DELETE /api/flights/{id}` keep their current response shapes; adding fields is fine, renaming or removing is not.
- Static assets are served by Cloudflare with `run_worker_first: ["/api/*"]`; keep the `env.ASSETS.fetch` fallthrough in `index.ts`.
- Schema changes go through new files in `worker/migrations/`; never edit an applied migration.

## Frontend Guardrails
- Keep the frontend dependency-free.
- All API calls go through `apiFetch()`; a 401 must show the sign-in overlay, not a "Disconnected" state.
- Preserve status polling, sorting, modal details, and delete behavior.
- Escape user- or sim-provided strings before injecting into HTML (`escHtml`); use `textContent` for messages.
- Maintain usable desktop and mobile layouts.

## Data And Compatibility
- Source of truth: D1 (`flights` table, same 17 columns as the old SQLite schema plus `event_id`).
- Local agent state: `agent/outbox.db` (gitignored); the old `backend/logbook.db` is only read by `import_legacy.py`.
- `date` values are ISO-style strings.
- Avoid schema changes unless requested.

## Validation
There is no formal automated test suite. After code changes, validate what applies:
1. Worker: `cd worker && npx tsc --noEmit && npx wrangler deploy --dry-run`.
2. Worker: `npm run migrate:local && npm run dev`, then confirm `GET /api/status` and `GET /api/flights` return 401 without a token and 200 with the viewer token; `POST /api/events` twice with the same event inserts one flight.
3. Frontend: open `http://localhost:8787`, sign in, confirm flights render; sorting, modal open/close, and deletion still work.
4. Agent: `python -m py_compile agent/*.py`; run `python agent/main.py` against the local Worker and confirm heartbeats arrive (status not "Agent offline").
5. If worker logic changed, verify offline behavior when MSFS/SimConnect is unavailable.
6. If service tooling changed, follow `docs/service-install.md` and verify install/update/remove behavior.

## Non-Goals
Do not do these unless explicitly requested:
- migrate to a JS framework
- replace D1 or the SQLite outbox
- redesign the UI broadly
- rewrite the app architecture

## Change Notes
For significant edits, report:
- files changed
- behavior changed
- validation performed
- limitations or follow-ups
