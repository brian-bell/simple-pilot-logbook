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
  on_ground: number;
  paused: number;
}

export async function getStatus(env: Env): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT updated_at, connected, state, current_flight_json, on_ground, paused FROM agent_status WHERE id = 1",
  ).first<StatusRow>();

  const offline = {
    connected: false,
    state: "DISCONNECTED",
    on_ground: false,
    paused: false,
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

  // Keep the banner's elapsed time ticking between heartbeats (the agent stops the clock while paused).
  if (row.state === "AIRBORNE" && row.paused !== 1 && currentFlight && typeof currentFlight.elapsed_seconds === "number") {
    currentFlight.elapsed_seconds += Math.floor(ageSec);
  }

  return json({
    connected: row.connected === 1,
    state: row.state,
    on_ground: row.connected === 1 && row.state === "ON_GROUND" && row.on_ground === 1,
    paused: row.connected === 1 && row.paused === 1,
    current_flight: currentFlight,
    agent_seen_at: row.updated_at,
  });
}
