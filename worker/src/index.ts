/**
 * Simple Pilot Logbook — Cloudflare Worker entry point.
 *
 * - /api/*           JSON API (bearer-token protected, see auth.ts)
 * - everything else  static frontend from ../frontend via Workers Static Assets
 * - cron trigger     nightly D1 -> R2 backup (backup.ts)
 *
 * With `run_worker_first: ["/api/*"]` in wrangler.jsonc, non-API requests never
 * reach this code; the ASSETS fallthrough below is a safety net if that setting
 * is ever changed to a plain `true`.
 */

import { bearerMatches, unauthorized } from "./auth";
import { runBackup } from "./backup";
import { ingestEvents } from "./events";
import { exportFlightsCsv } from "./export";
import { deleteFlight, getFlight, listFlights } from "./flights";
import { getStatus } from "./status";
import { json } from "./types";
import type { Env } from "./types";

const FLIGHT_ID_RE = /^\/api\/flights\/(\d{1,12})$/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    try {
      return await route(request, env, ctx, url);
    } catch (err) {
      console.error("unhandled error", err);
      return json({ error: "internal error" }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runBackup(env));
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const method = request.method.toUpperCase();
  const path = url.pathname;

  const isIngest = method === "POST" && path === "/api/events";
  const requiredToken = isIngest ? env.AGENT_TOKEN : env.VIEWER_TOKEN;
  if (!(await bearerMatches(request, requiredToken))) {
    return unauthorized();
  }

  if (isIngest) return ingestEvents(request, env, ctx);
  if (method === "GET" && path === "/api/status") return getStatus(env);
  if (method === "GET" && path === "/api/flights") return listFlights(env, url.searchParams);
  if (method === "GET" && path === "/api/flights/export.csv") return exportFlightsCsv(env);

  const match = FLIGHT_ID_RE.exec(path);
  if (match) {
    const id = Number(match[1]);
    if (method === "GET") return getFlight(env, id);
    if (method === "DELETE") return deleteFlight(env, id);
  }

  return json({ error: "not found" }, 404);
}
