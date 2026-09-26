/**
 * GET /api/status — live agent/SimConnect state.
 *
 * Reads the single agent_status row written by heartbeats. Staleness and the
 * elapsed-time extrapolation use only the Worker clock (updated_at is stamped
 * by the Worker), so a skewed PC clock cannot produce a phantom "Disconnected".
 */

import { json } from "./types";
import type { Env } from "./types";

/** Three missed 10-second heartbeats. */
const STALE_SECONDS = 30;

interface StatusRow {
  updated_at: string;
  connected: number;
  state: string;
  current_flight_json: string | null;
}

export async function getStatus(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT updated_at, connected, state, current_flight_json FROM agent_status WHERE id = 1",
  ).first<StatusRow>();

  const offline = {
    connected: false,
    state: "DISCONNECTED",
    current_flight: null,
    agent_seen_at: row?.updated_at ?? null,
  };
  if (!row) return json(offline);

  const seenMs = Date.parse(row.updated_at);
  const ageSec = Number.isFinite(seenMs) ? (Date.now() - seenMs) / 1000 : Number.POSITIVE_INFINITY;
  if (ageSec > STALE_SECONDS) return json(offline);

  let currentFlight: Record<string, unknown> | null = null;
  if (row.current_flight_json) {
    try {
      const parsed: unknown = JSON.parse(row.current_flight_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        currentFlight = parsed as Record<string, unknown>;
      }
    } catch {
      currentFlight = null;
    }
  }

  // Keep the banner's elapsed time ticking between heartbeats.
  if (row.state === "AIRBORNE" && currentFlight && typeof currentFlight.elapsed_seconds === "number") {
    currentFlight.elapsed_seconds += Math.floor(ageSec);
  }

  return json({
    connected: row.connected === 1,
    state: row.state,
    current_flight: currentFlight,
    agent_seen_at: row.updated_at,
  });
}
