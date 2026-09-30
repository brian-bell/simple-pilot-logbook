/**
 * Shared types and small helpers for the Worker.
 */

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  /** R2 bucket for the nightly backup (backup.ts). */
  BACKUPS: R2Bucket;
  /** Secret: bearer token the local agent uses for POST /api/events. */
  AGENT_TOKEN?: string;
  /** Secret: bearer token the browser UI uses for every other /api route. */
  VIEWER_TOKEN?: string;
}

export const EVENT_TYPES = [
  "agent.heartbeat",
  "flight.takeoff",
  "flight.position",
  "flight.landing",
  "flight.import",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface IngestEvent {
  id: string;
  type: EventType;
  ts: string;
  payload: Record<string, unknown>;
}

/** JSON response with no-store caching and optional extra headers. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

/** Parse an integer query parameter, clamping to [min, max] and falling back to `fallback`. */
export function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
