/**
 * Event envelopes sent to the Worker, plus small value helpers.
 *
 * Envelope: {"id": <uuid>, "type": <str>, "ts": <ISO UTC>, "payload": {...}}
 *
 * The id is generated client-side so the Worker can de-duplicate retries.
 * Keep this contract in sync with worker/src/events.ts and worker/src/types.ts.
 */

import { randomUUID } from "node:crypto";

/** The 18 logbook columns, same order as the Worker's FLIGHT_FIELDS. */
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
export type FlightRecord = Record<FlightField, string | number | null>;

export type EventType = "agent.heartbeat" | "flight.takeoff" | "flight.position" | "flight.landing";

export interface AgentEvent {
  id: string;
  type: EventType;
  ts: string;
  payload: Record<string, unknown>;
}

/** Live status shared by the heartbeat and GET /api/status (fields may be added, never renamed or removed). */
export interface AgentStatus {
  connected: boolean;
  state: "DISCONNECTED" | "ON_GROUND" | "AIRBORNE";
  /** True only once a live sample confirmed the aircraft on the ground (not in the menu or while loading). */
  on_ground: boolean;
  /** True while the sim is paused during a flight (Pause_EX1), not in the main menu. */
  paused: boolean;
  current_flight: CurrentFlight | null;
}

export interface CurrentFlight {
  departure_icao: string | null;
  departure_name: string | null;
  departure_lat: number | null;
  departure_lon: number | null;
  aircraft_title: string | null;
  aircraft_registration: string | null;
  aircraft_type: string | null;
  elapsed_seconds: number;
  altitude_ft: number | null;
}

export function utcNowIso(): string {
  return new Date().toISOString();
}

export function makeEvent(type: EventType, payload: Record<string, unknown>, id?: string): AgentEvent {
  return { id: id ?? randomUUID(), type, ts: utcNowIso(), payload };
}

/** Number for a SimVar reading, or null when missing, non-numeric, NaN or infinite. */
export function finiteNum(value: unknown, digits?: number): number | null {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  if (digits === undefined) return n;
  const factor = 10 ** digits;
  return Math.round(n * factor) / factor;
}

/** Trim a SimVar string (fixed-size strings arrive NUL-padded); empty becomes null. */
export function cleanSimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\0/g, "").trim();
  return text || null;
}

/**
 * Short ICAO type designator (C172, A20N, B738) from the ATC MODEL SimVar, or null.
 * MSFS often returns a localisation key instead of the bare code, e.g.
 * "TT:ATCCOM.AC_MODEL_C172.0.text", "TT:ATCCOM.AC_MODEL C172.0.text" or "$$:A320".
 */
export function icaoTypeFromAtcModel(value: unknown): string | null {
  const text = cleanSimString(value);
  if (!text) return null;
  const key = /AC_MODEL[_ ]([A-Za-z0-9]+)\.\d+\.text$/i.exec(text);
  const code = (key ? key[1] : text.replace(/^(TT|\$\$):/, "")).trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{1,3}$/.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function heartbeatEvent(status: AgentStatus, outboxPending: number): AgentEvent {
  return makeEvent("agent.heartbeat", {
    connected: Boolean(status.connected),
    state: status.state || "DISCONNECTED",
    on_ground: Boolean(status.on_ground),
    paused: Boolean(status.paused),
    current_flight: status.current_flight,
    outbox_pending: Math.trunc(outboxPending),
  });
}

export interface TakeoffInfo {
  flight_uuid: string;
  takeoff_ts: string;
  departure_icao: string | null;
  departure_name: string | null;
  departure_lat: number | null;
  departure_lon: number | null;
  aircraft_title: string | null;
  aircraft_registration: string | null;
  aircraft_type: string | null;
  livery: string | null;
  altitude_ft: number | null;
  started_in_air: boolean;
  sim: string | null;
}

/** The takeoff event's id doubles as the flight_uuid shared by positions and the landing. */
export function takeoffEvent(info: TakeoffInfo): AgentEvent {
  return makeEvent("flight.takeoff", { ...info }, info.flight_uuid);
}

export function positionEvent(
  flightUuid: string,
  lat: number | null,
  lon: number | null,
  altitudeFt: number | null,
  vsFpm: number | null,
  groundSpeedKt: number | null,
  elapsedSeconds: number,
): AgentEvent {
  return makeEvent("flight.position", {
    flight_uuid: flightUuid,
    lat: finiteNum(lat),
    lon: finiteNum(lon),
    altitude_ft: finiteNum(altitudeFt, 0),
    vs_fpm: finiteNum(vsFpm, 0),
    ground_speed_kt: finiteNum(groundSpeedKt, 1),
    elapsed_seconds: Math.trunc(elapsedSeconds),
  });
}

/** `record` is the 18-field logbook row; `extra` carries flight_uuid and diagnostics. */
export function landingEvent(record: FlightRecord, extra: Record<string, unknown>): AgentEvent {
  return makeEvent("flight.landing", { ...record, ...extra });
}
