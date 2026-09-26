/**
 * POST /api/events — ingest a batch of agent events.
 *
 * Body: { "events": [ { id, type, ts, payload }, ... ] }, 1..MAX_EVENTS items.
 * Every event is idempotent on its client-generated id, so the agent can retry
 * freely. All statements for one request run in a single atomic D1 batch.
 */

import { insertEvent, insertFlightGuarded, normaliseFlight, upsertStatus } from "./db";
import { EVENT_TYPES, json } from "./types";
import type { Env, EventType, IngestEvent } from "./types";

const MAX_BODY_BYTES = 1_000_000;
/** 20 events x 2 statements + 1 heartbeat upsert = 41, under D1's 50-queries-per-invocation free limit. */
const MAX_EVENTS = 20;

export async function ingestEvents(request: Request, env: Env): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const events = (parsed as { events?: unknown } | null)?.events;
  if (!Array.isArray(events) || events.length === 0) {
    return json({ error: "events must be a non-empty array" }, 400);
  }
  if (events.length > MAX_EVENTS) {
    return json({ error: `at most ${MAX_EVENTS} events per request` }, 400);
  }

  const stmts: D1PreparedStatement[] = [];
  const flightStmtIdx: number[] = [];
  let heartbeat: IngestEvent | null = null;

  for (let i = 0; i < events.length; i++) {
    const ev = validateEvent(events[i]);
    if (!ev) return json({ error: "invalid event", index: i }, 400);

    switch (ev.type) {
      case "agent.heartbeat":
        heartbeat = ev; // only the last heartbeat in a batch matters
        break;

      case "flight.takeoff":
      case "flight.position":
        stmts.push(insertEvent(env.DB, ev));
        break;

      case "flight.landing":
      case "flight.import": {
        const flight = normaliseFlight(ev.payload);
        if (!flight) return json({ error: "date required", index: i }, 400);
        flightStmtIdx.push(stmts.length);
        stmts.push(insertFlightGuarded(env.DB, ev.id, flight));
        stmts.push(insertEvent(env.DB, ev));
        break;
      }
    }
  }

  if (heartbeat) stmts.push(upsertStatus(env.DB, heartbeat.payload));

  const results = stmts.length > 0 ? await env.DB.batch(stmts) : [];
  const insertedFlights = flightStmtIdx.reduce(
    (n, idx) => n + ((results[idx]?.meta?.changes ?? 0) > 0 ? 1 : 0),
    0,
  );

  return json({ accepted: events.length, inserted_flights: insertedFlights });
}

function validateEvent(raw: unknown): IngestEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { id, type, ts, payload } = raw as Record<string, unknown>;

  if (typeof id !== "string" || id.length < 1 || id.length > 64) return null;
  if (typeof type !== "string" || !(EVENT_TYPES as readonly string[]).includes(type)) return null;
  if (typeof ts !== "string" || ts.length < 1 || ts.length > 64) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  return { id, type: type as EventType, ts, payload: payload as Record<string, unknown> };
}
