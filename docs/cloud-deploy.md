# Cloud Deploy (Cloudflare Worker + D1)

The logbook web app and its API run as a Cloudflare Worker backed by a D1 database. The local agent on the sim PC only sends events to it. Everything here fits in Cloudflare's free plan.

## Prerequisites
- A Cloudflare account (free)
- Node.js 18+ and npm on the machine you deploy from
- This repository checked out

All commands below run from the `worker/` directory.

## One-time setup

1. Install the Worker's dev dependencies:

   ```powershell
   cd worker
   npm install
   ```

2. Log in to Cloudflare (opens a browser):

   ```powershell
   npx wrangler login
   ```

3. Create the D1 database and copy its id into `wrangler.jsonc`:

   ```powershell
   npx wrangler d1 create simple-pilot-logbook
   ```

   Replace `REPLACE_WITH_DATABASE_ID` in `worker/wrangler.jsonc` with the printed `database_id`.

4. Apply the schema:

   ```powershell
   npm run migrate:remote
   ```

5. Generate two random tokens (run twice):

   ```powershell
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

6. Store them as Worker secrets (paste when prompted; they are never committed):

   ```powershell
   npx wrangler secret put AGENT_TOKEN
   npx wrangler secret put VIEWER_TOKEN
   ```

   `AGENT_TOKEN` is what the local agent sends. `VIEWER_TOKEN` is what you type into the web UI.

7. Deploy:

   ```powershell
   npx wrangler deploy
   ```

   Wrangler prints the URL, e.g. `https://simple-pilot-logbook.<account>.workers.dev`.

8. Configure the agent on the sim PC: copy `agent\.env.example` to `agent\.env`, set `WORKER_URL` to that URL and `AGENT_TOKEN` to the first token. Then run `start.bat` once and check `agent\agent.log` shows no token errors, or install the service per [service-install.md](service-install.md).

9. Open the URL in a browser and enter the viewer token when prompted. It is kept in that browser's localStorage; use **Sign out** in the header to forget it.

## Importing the old local logbook

The pre-Cloudflare version stored flights in `backend\logbook.db`. Copy that file somewhere outside the repository first, then from the `agent\` directory:

```powershell
python import_legacy.py --db "C:\path\to\logbook.db" --dry-run
python import_legacy.py --db "C:\path\to\logbook.db" --direct
```

The dry run prints the cleaned rows (aircraft names lose their old `b'...'` wrapper, date-only rows get a full timestamp). `--direct` posts them straight to the Worker using `agent\.env`. Re-running is harmless: every legacy row maps to the same event id, so the Worker reports `inserted_flights: 0` the second time. Use `--skip-ids 1,2` to leave out the seed "Test flight" rows.

## Updating after code changes

- Worker or frontend changed: `cd worker && npx wrangler deploy` (the frontend is uploaded as static assets with the Worker).
- Schema changed: add a file under `worker/migrations/` (`npx wrangler d1 migrations create simple-pilot-logbook <name>`), then `npm run migrate:remote` before deploying.
- Agent changed: pull on the sim PC and restart the service (`python agent\windows_service.py restart` as Administrator) or `start.bat`.

## Local development

```powershell
cd worker
copy .dev.vars.example .dev.vars        # dev tokens: dev-agent / dev-viewer
npm run migrate:local                    # local D1 in worker/.wrangler/state
npm run dev                              # http://localhost:8787
```

Point the agent at it with `WORKER_URL=http://localhost:8787` and `AGENT_TOKEN=dev-agent` in `agent\.env`, then `python agent\main.py`. Without MSFS the status shows "Disconnected" while heartbeats flow.

Handy checks:

```powershell
npx wrangler d1 execute simple-pilot-logbook --local --command "SELECT type, COUNT(*) AS n FROM events GROUP BY type"
curl -H "Authorization: Bearer dev-viewer" http://localhost:8787/api/status
```

## Rotating tokens

Run `npx wrangler secret put AGENT_TOKEN` (or `VIEWER_TOKEN`) with a new value and redeploy is not required — secrets take effect immediately. Then update `agent\.env` and restart the agent, or sign out and back in on the web UI.

## Troubleshooting

- **Web UI keeps asking for a token**: the viewer token does not match the `VIEWER_TOKEN` secret. Check with `curl -H "Authorization: Bearer <token>" https://<worker>/api/status` (expect JSON, not 401).
- **Status shows "Agent offline"**: no heartbeat reached the Worker in the last minute. Check the service is running and `agent\agent.log`.
- **Status shows "Disconnected"**: the agent is running but MSFS is not (or SimConnect could not attach).
- **`Worker rejected AGENT_TOKEN` in agent.log**: `agent\.env` token differs from the `AGENT_TOKEN` secret.
- **`wrangler deploy` complains about the assets directory**: the config points at `../frontend`. If your wrangler version refuses a directory outside `worker/`, move `wrangler.jsonc` to the repository root and change `main`, `assets.directory` and `migrations_dir` to `worker/src/index.ts`, `frontend` and `worker/migrations`.

## Security notes

- Every `/api/*` route requires a bearer token; static HTML/CSS/JS is public but contains no data.
- The viewer token authorises deletes too and is readable by anyone with access to the browser profile. Rotate it if in doubt.
- The agent token sits in plain text in `agent\.env` on the sim PC, the same exposure class as the old local database. Cloudflare Access can be layered in front of the Worker later without code changes.
- Free-plan D1 limits (100k row writes/day, 5M reads/day, 500 MB) are far above this app's steady state of roughly 8.6k heartbeat writes per day plus about 360 position rows per airborne hour.
