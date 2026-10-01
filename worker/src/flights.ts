/**
 * Flight read/delete routes. Response shapes match the old FastAPI backend so
 * the frontend only needed an auth layer.
 */

import { clampInt, json } from "./types";
import type { Env } from "./types";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** GET /api/flights?limit=&offset= -> { flights, total, limit, offset } */
export async function listFlights(env: Env, params: URLSearchParams): Promise<Response> {
  const limit = clampInt(params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const offset = clampInt(params.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const [rows, count] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM flights ORDER BY date DESC, id DESC LIMIT ?1 OFFSET ?2").bind(limit, offset),
    env.DB.prepare("SELECT COUNT(*) AS n FROM flights"),
  ]);

  const total = Number((count.results?.[0] as { n?: number } | undefined)?.n ?? 0);
  return json({ flights: rows.results ?? [], total, limit, offset });
}

/** Same 404 body the old FastAPI backend produced, for clients that inspect `detail`. */
const NOT_FOUND = { detail: "Flight not found" };

/** The plan is keyed by the takeoff's flight_uuid, which the landing event's payload carries. */
const PLAN_SQL =
  "SELECT p.* FROM flights f " +
  "JOIN events e ON e.id = f.event_id " +
  "JOIN flight_plans p ON p.flight_uuid = json_extract(e.payload, '$.flight_uuid') " +
  "WHERE f.id = ?1";

/** GET /api/flights/:id -> flight row plus `flight_plan` (SimBrief, or null), or 404 */
export async function getFlight(env: Env, id: number): Promise<Response> {
  const [flight, plan] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM flights WHERE id = ?1").bind(id),
    env.DB.prepare(PLAN_SQL).bind(id),
  ]);
  const row = flight.results?.[0];
  if (!row) return json(NOT_FOUND, 404);
  return json({ ...row, flight_plan: planView(plan.results?.[0] as Record<string, unknown> | undefined) });
}

/** plan_json (the trimmed OFP) is returned parsed, as `navlog`. */
function planView(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!row) return null;
  const { plan_json, ...plan } = row;
  let navlog: unknown = [];
  try {
    navlog = (JSON.parse(String(plan_json)) as { navlog?: unknown }).navlog ?? [];
  } catch {
    // keep the summary columns even if the stored JSON is unreadable
  }
  return { ...plan, navlog };
}

/** DELETE /api/flights/:id -> { deleted: id } or 404. Event rows are kept for audit. */
export async function deleteFlight(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare("DELETE FROM flights WHERE id = ?1").bind(id).run();
  if ((result.meta?.changes ?? 0) === 0) return json(NOT_FOUND, 404);
  return json({ deleted: id });
}
