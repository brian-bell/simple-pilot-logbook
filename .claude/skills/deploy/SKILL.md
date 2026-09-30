---
name: deploy
description: Deploy the Cloudflare Worker (API + frontend) from main to production, applying D1 migrations first and verifying the live site. Use when asked to deploy, ship or release the Worker or frontend.
---

# Deploy the Worker

Deploys `main` to the production Worker at `https://simple-pilot-logbook.bellbm.workers.dev`. The frontend is uploaded as static assets with the Worker, so one deploy covers both. One-time setup (D1, R2 bucket, secrets) is in `docs/cloud-deploy.md`; this skill is the repeatable update.

## When a deploy is needed
Only when something under `worker/` or `frontend/` changed since the last deploy. Agent-only (`agent/`) or docs changes need no deploy; the agent is updated on the sim PC per `docs/service-install.md`.

## Credentials
`CLOUDFLARE_API_TOKEN` must come from the environment (or `npx wrangler login` on a desktop). Never print, echo or log it, and never write it to a file. If it is missing, stop and say so.

## Steps
Stop at the first failure and report it; do not deploy past a red step.

1. Get the latest `main` on a clean worktree, so no local edits or untracked files under `worker/` or `frontend/` get deployed:
   ```sh
   git status --porcelain    # must print nothing; otherwise stop
   git fetch origin main && git checkout main && git pull --ff-only origin main
   git rev-parse HEAD        # the commit being deployed
   ```
   In a fresh clone, `git checkout main` may report the branch is behind `origin/main`; that is expected, and the `pull --ff-only` brings it up to date.
2. Checks (the agent is not part of the Worker deploy, so only the Worker is checked):
   ```sh
   cd worker && npm ci && npx tsc --noEmit && npx wrangler deploy --dry-run
   ```
3. Migrations (still in `worker/`), before the deploy so a Worker that writes a new column never runs without it:
   ```sh
   npm run migrate:remote
   npx wrangler d1 migrations list simple-pilot-logbook --remote
   ```
   If the apply fails, or the list shows anything other than "No migrations to apply!", stop without deploying.
4. Deploy, and note the `Current Version ID` it prints:
   ```sh
   npx wrangler deploy
   ```
5. Verify:
   ```sh
   npx wrangler deployments status   # Version(s) must show (100%) with the version id from step 4
   curl -s -o /dev/null -w "%{http_code}\n" https://simple-pilot-logbook.bellbm.workers.dev/api/status   # expect 401
   curl -s -o /dev/null -w "%{http_code}\n" https://simple-pilot-logbook.bellbm.workers.dev/            # expect 200
   ```
   The deployments status confirms the new version is the one serving all traffic. A 401 on `/api/status` without a token confirms the Worker is live and auth fails closed; 200 on `/` confirms the frontend assets are served.
6. Record the deployed commit wherever the last deploy is tracked, so it is not deployed again. For Claude, that is the `ci-agent-last-handled-sha` project memory read by the hourly CI routine: set `last_handled_sha` to the commit from step 1 and note the version id and status codes.

## Report
The deployed commit SHA, the Worker version id wrangler printed, any migrations applied, the deployments status result, and the two status codes.
