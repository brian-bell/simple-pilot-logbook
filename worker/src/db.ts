/**
 * SQL builders and flight-record normalisation.
 *
 * All statements are returned as prepared statements so the ingest handler can
 * run them in a single atomic `env.DB.batch()`.
 */

import type { IngestEvent } from "./types";

/** The logbook columns: the old backend/database.py's 17 in their order, then later additions. */
export const FLIGHT_FIELDS = [
  "date",
  "aircraft_title",
  "aircraft_registration",
  "departure_icao",
  "departure_name",
  "departure_lat",
  "departure_lon",
  "arrival_icao",
  "arrival_name",
  "arrival_lat",
  "arrival_lon",
  "distance_nm",
  "elapsed_seconds",
  "max_altitude_ft",
  "landing_vs_fpm",
  "landing_g_force",
  "notes",
  "aircraft_type",
] as const;

export type FlightField = (typeof FLIGHT_FIELDS)[number];
export type FlightInput = Record<FlightField, string | number | null>;

const STRING_FIELDS: ReadonlySet<string> = new Set([
  "date",
  "aircraft_title",
  "aircraft_registration",
  "departure_icao",
  "departure_name",
  "arrival_icao",
  "arrival_name",
  "notes",
  "aircraft_type",
]);
const INT_FIELDS: ReadonlySet<string> = new Set(["elapsed_seconds"]);
const MAX_STRING = 200;
const MAX_NOTES = 2000;
/** ICAO type designators are at most four characters; allow a little slack. */
const MAX_TYPE = 8;

function asString(raw: unknown, max: number): string | null {
  if (raw == null) return null;
  const s = (typeof raw === "string" ? raw : String(raw)).trim();
  if (s === "") return null;
  return s.length > max ? s.slice(0, max) : s;
}

function asNumber(raw: unknown, integer: boolean): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw);
  else return null;
  if (!Number.isFinite(n)) return null;
  return integer ? Math.trunc(n) : n;
}

/**
 * Whitelist and coerce an incoming flight payload.
 * Returns null when the required `date` is missing; every other field is
 * lenient (bad values become null) so one odd SimVar never dead-letters a landing.
 */
export function normaliseFlight(payload: Record<string, unknown>): FlightInput | null {
  const out = {} as FlightInput;
  for (const field of FLIGHT_FIELDS) {
    const raw = payload[field];
    if (STRING_FIELDS.has(field)) {
      out[field] = asString(raw, field === "notes" ? MAX_NOTES : field === "aircraft_type" ? MAX_TYPE : MAX_STRING);
    } else {
      out[field] = asNumber(raw, INT_FIELDS.has(field));
    }
  }
  if (!out.date) return null;
  return out;
}

/**
 * Insert a flight only if its event has never been seen.
 * Must run BEFORE insertEvent() for the same event inside one batch: the first
 * delivery inserts both rows, a retried delivery finds the event and skips the
 * flight, and a flight the user deleted stays deleted.
 */
export function insertFlightGuarded(db: D1Database, eventId: string, flight: FlightInput): D1PreparedStatement {
  const cols = ["event_id", ...FLIGHT_FIELDS];
  const params = cols.map((_, i) => `?${i + 1}`).join(", ");
  const sql =
    `INSERT INTO flights (${cols.join(", ")}) ` +
    `SELECT ${params} ` +
    `WHERE NOT EXISTS (SELECT 1 FROM events WHERE id = ?1)`;
  return db.prepare(sql).bind(eventId, ...FLIGHT_FIELDS.map((f) => flight[f]));
}

export function insertEvent(db: D1Database, ev: IngestEvent): D1PreparedStatement {
  return db
    .prepare("INSERT OR IGNORE INTO events (id, type, ts, payload) VALUES (?1, ?2, ?3, ?4)")
    .bind(ev.id, ev.type, ev.ts, JSON.stringify(ev.payload));
}

/** Overwrite the single agent_status row. `updated_at` is stamped with the Worker clock. */
export function upsertStatus(db: D1Database, payload: Record<string, unknown>): D1PreparedStatement {
  const connected = payload.connected === true ? 1 : 0;
  const state = typeof payload.state === "string" ? payload.state.slice(0, 32) : "DISCONNECTED";
  const onGround = payload.on_ground === true ? 1 : 0;
  const paused = payload.paused === true ? 1 : 0;
  const cf = payload.current_flight;
  const currentFlightJson = cf && typeof cf === "object" && !Array.isArray(cf) ? JSON.stringify(cf) : null;

  return db
    .prepare(
      "INSERT INTO agent_status (id, updated_at, connected, state, current_flight_json, on_ground, paused) " +
        "VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6) " +
        "ON CONFLICT (id) DO UPDATE SET " +
        "updated_at = excluded.updated_at, connected = excluded.connected, " +
        "state = excluded.state, current_flight_json = excluded.current_flight_json, " +
        "on_ground = excluded.on_ground, paused = excluded.paused",
    )
    .bind(new Date().toISOString(), connected, state, currentFlightJson, onGround, paused);
}
