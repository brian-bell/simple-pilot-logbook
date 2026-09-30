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

/** GET /api/flights/:id -> flight row or 404 */
export async function getFlight(env: Env, id: number): Promise<Response> {
  const row = await env.DB.prepare("SELECT * FROM flights WHERE id = ?1").bind(id).first();
  if (!row) return json(NOT_FOUND, 404);
  return json(row);
}

/** DELETE /api/flights/:id -> { deleted: id } or 404. Event rows are kept for audit. */
export async function deleteFlight(env: Env, id: number): Promise<Response> {
  const result = await env.DB.prepare("DELETE FROM flights WHERE id = ?1").bind(id).run();
  if ((result.meta?.changes ?? 0) === 0) return json(NOT_FOUND, 404);
  return json({ deleted: id });
}
