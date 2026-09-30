# AGENTS.md

## Purpose
Use this file for repository-specific rules that help coding agents make safe changes quickly.

## Project Snapshot
- App: `Simple Pilot Logbook`
- Goal: detect MSFS flights automatically on the sim PC and display them in a cloud-hosted web logbook
- Architecture: a Node.js/TypeScript **agent** (Windows service via WinSW) sends events over HTTPS to a **Cloudflare Worker**; the Worker stores them in **D1** and serves the Preact frontend (vendored, no build step) as static assets
- Primary platform: Windows 10/11 for the agent (live SimConnect); the Worker is platform-neutral TypeScript
- Target sim: MSFS 2024 (SU6+). MSFS 2020 only best-effort through the KittyHawk protocol fallback
- How it works (API, event contract, status, flight detection): `docs/architecture.md`

## Key Files
- `agent/src/main.ts`: agent entry point; starts the SimConnect worker + `Sender`, sends a heartbeat every 10 s, graceful shutdown on SIGINT/SIGTERM/SIGBREAK
- `agent/src/simconnect_client.ts`: node-simconnect connection (auto-detection: SimConnect.cfg, named pipe, registry port; then static IPv4 ports from `SimConnect.xml`; `SIMCONNECT_HOST/PORT` override), data definitions, system events, reconnect every 5 s
- `agent/src/flight_detector.ts`: flight state machine (pure logic, injectable clock); sample classification live/hold/out, touchdown metrics, flight endings
- `agent/src/simconnect_worker.ts`: wires client -> detector -> outbox callback; 1 s tick
- `agent/src/events.ts`: event envelopes (`id`, `type`, `ts`, `payload`), `FLIGHT_FIELDS`, `finiteNum`
- `agent/src/outbox.ts`: SQLite outbox (`agent/outbox.db`, `node:sqlite`), same schema as the old Python outbox
- `agent/src/sender.ts`: drains the outbox in batches with retry/backoff; `postNow()` for heartbeats
- `agent/src/config.ts`: reads `agent/.env` (`WORKER_URL`, `AGENT_TOKEN`, optional cadences and SimConnect endpoint)
- `agent/src/airports.ts`: nearest-airport lookup and haversine helpers (bundled `agent/data/airports.json`)
- `agent/src/log.ts`: rotating `agent/agent.log` (1 MB x 3)
- `agent/src/import_volanta.ts`: one-off Volanta history import (`npm run import:volanta`), sends `flight.import` events with ids `volanta:<key>`; dry run unless `--send`
- `agent/service/SimplePilotLogbook.xml.template` plus `install_service.ps1` and `uninstall_service.ps1` at the repo root: WinSW service tooling (WinSW 2.12.0, SHA-256 pinned in the installer)
- `worker/wrangler.jsonc`: Worker config (D1 binding `DB`, R2 binding `BACKUPS`, nightly cron, assets from `../frontend`, `run_worker_first: ["/api/*"]`)
- `worker/migrations/*.sql`: D1 schema (`events`, `flights`, `agent_status`)
- `worker/src/index.ts`: router + auth dispatch; `auth.ts`, `events.ts` (ingest), `flights.ts`, `export.ts` (CSV export), `backup.ts` (nightly D1 -> R2 backup, `scheduled` handler), `status.ts`, `db.ts`, `types.ts` (env, event types, JSON helpers)
- `worker/.dev.vars.example`: local dev tokens (`dev-agent` / `dev-viewer`)
- `frontend/index.html` (import map + mount point), `frontend/style.css`, `frontend/js/*.js` (Preact components, `api.js`, `format.js`, `sort.js`), `frontend/vendor/*.mjs` (pinned Preact, preact/hooks, htm)
- `docs/architecture.md`, `docs/cloud-deploy.md`, `docs/service-install.md`: how it works; deploy and local dev; service install/remove
- `start.bat`: local agent launcher (npm ci on first run, build, run)
- `.claude/launch.json`: `worker-dev` preview config (Windows `cmd`, `wrangler dev` on port 8787)

## Working Rules
- Keep changes minimal and scoped to the request.
- If Worker API behavior changes, update the frontend (`frontend/js/`) in the same task.
- If the event contract changes, update `agent/src/events.ts`, `worker/src/events.ts` and `worker/src/types.ts` together, and the contract in `docs/architecture.md`.
- Do not add frameworks, build tooling, or major abstractions unless explicitly requested (no Hono/Express in the Worker, in the frontend, Preact + htm is the only framework, vendored under `frontend/vendor/` with no bundler, npm install or build step; in the agent, `node-simconnect` is the only runtime dependency and HTTP is the global `fetch`).
- Prefer small readable functions over broad refactors.

## Agent Guardrails
- `flight_detector.ts` stays pure: no network, disk or SimConnect calls; it only emits events through its `emit` callback. Only `sender.ts` talks to the Worker.
- SimConnect callbacks must never throw into node-simconnect; keep the `safe()` wrappers and the permanent `error` listeners (an unhandled `error` event crashes Node).
- Preserve current flight-state behavior unless the user asks for a behavior change:
  - public states `DISCONNECTED -> ON_GROUND -> AIRBORNE` (heartbeat and `/api/status` shape unchanged)
  - only `live` samples change state; `out` = MSFS 2024 placeholder position (lat 0 / lon 0 or 90E) or implausible altitude; `hold` = menu/loading camera, replay, slew, missing values
  - the `Sim` system event is logged only, never used for gating (MSFS 2024 does not send SimStop on return to the main menu)
  - flight time (`elapsed_seconds`) excludes time paused (Pause_EX1) between takeoff and the end
  - flights shorter than 30 seconds of flight time are ignored, whatever the ending
  - landing VS from `PLANE TOUCHDOWN NORMAL VELOCITY` at first contact, falling back to the trailing 6 s vertical-speed window; landing G is the per-frame peak up to 3 s after touchdown; bounces within 15 s merge
  - flights without a touchdown are recorded with notes `Crashed` or `Ended without landing`; agent started mid-air adds `Started in the air`
- Treat SimConnect as optional: the agent must start and heartbeat when MSFS is closed, and must not spam the log while waiting (one line, then every 5 minutes).
- Fixed-size SimVar strings are read as NUL-padded UTF-8 (`readFixedString`), not through node-simconnect's latin1 string readers.
- Events go to the outbox first and are deleted only after a 2xx from the Worker. Heartbeats are send-or-drop and never queued. The one-off Volanta importer posts directly instead: the export file is its durable copy and its fixed event ids make a re-run finish an interrupted import.
- Never log `AGENT_TOKEN` (or any token). Log status codes and response snippets only.
- Config is read from `agent/.env` next to the code (`AGENT_DIR` from `import.meta.url`), not from the current working directory.
- `node:sqlite` still prints an ExperimentalWarning on Node 22/24; every launcher passes `--disable-warning=ExperimentalWarning`.

## Worker Guardrails
- Every `/api/*` route requires a bearer token: `AGENT_TOKEN` only for `POST /api/events`, `VIEWER_TOKEN` for everything else. No cross-acceptance; an unset secret must fail closed.
- Ingest is idempotent on event `id`. Keep the statement order in `events.ts`: guarded flight insert **before** the event insert, all inside one `env.DB.batch()`.
- Max 20 events per request (D1 free plan allows 50 queries per invocation).
- Unless the task explicitly requires an API change, `GET /api/status`, `GET /api/flights`, `GET /api/flights/{id}` and `DELETE /api/flights/{id}` keep their current response shapes; adding fields is fine, renaming or removing is not.
- Static assets are served by Cloudflare with `run_worker_first: ["/api/*"]`; keep the `env.ASSETS.fetch` fallthrough in `index.ts`.
- Schema changes go through new files in `worker/migrations/`; never edit an applied migration.

## Frontend Guardrails
- The only frontend dependencies are the three pinned files in `frontend/vendor/` (Preact, preact/hooks, htm), loaded through the import map in `index.html`. No CDN at runtime, no bundler, no npm install, no build step. Upgrading them means replacing the files and their version headers together.
- Components use function components, hooks and htm tagged templates (`html` from `js/html.js`). No JSX, no class components.
- All API calls go through `apiFetch()`; a 401 must show the sign-in overlay, not a "Disconnected" state.
- Preserve status polling, sorting, modal details, and delete behavior.
- Render sim- or user-provided strings as htm interpolations, which escape them. Never use `dangerouslySetInnerHTML` or `innerHTML`.
- Keep `style.css` class names as the styling contract; no CSS-in-JS.
- Maintain usable desktop and mobile layouts.

## Data And Compatibility
- Source of truth: D1 (`flights` table, the old SQLite schema's 17 columns plus `event_id` and `aircraft_type`).
- Local agent state: `agent/outbox.db` (gitignored). There is no `backend/` anymore; the retired `backend/logbook.db` importer is in git history at commit `84af342`.
- `date` values are ISO-style strings.
- Avoid schema changes unless requested.

## Validation
There is no formal automated test suite. After code changes, validate what applies:
1. Worker: `cd worker && npx tsc --noEmit && npx wrangler deploy --dry-run`.
2. Worker: `npm run migrate:local && npm run dev`, then confirm `GET /api/status` and `GET /api/flights` return 401 without a token and 200 with the viewer token; `POST /api/events` twice with the same event inserts one flight.
3. Frontend: open `http://localhost:8787`, sign in, confirm flights render; sorting, modal open/close, and deletion still work.
4. Agent: `cd agent && npm run check && npm run build`; run `npm start` against the local Worker (env vars `WORKER_URL`/`AGENT_TOKEN` override `agent/.env`) and confirm heartbeats arrive (status not "Agent offline"). Detector changes: drive `FlightDetector` with a fake clock through the menu-phantom, landing, bounce, crash, menu-quit, ESC-pause and teleport cases.
5. If worker logic changed, verify offline behavior when MSFS/SimConnect is unavailable.
6. If service tooling changed, follow `docs/service-install.md` and verify install/update/remove behavior.

## Non-Goals
Do not do these unless explicitly requested:
- migrate to a different JS framework or add a frontend build step
- replace D1 or the SQLite outbox
- redesign the UI broadly
- rewrite the app architecture

## Change Notes
For significant edits, report:
- files changed
- behavior changed
- validation performed
- limitations or follow-ups
