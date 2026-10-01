/**
 * Best-effort SimBrief flight plan attachment.
 *
 * When a flight.takeoff event is first ingested, the Worker fetches the
 * pilot's latest OFP (SimBrief only exposes the latest one) and stores it in
 * flight_plans if it plausibly belongs to this flight. Runs in ctx.waitUntil
 * after the ingest batch, so a SimBrief failure never affects ingest; nothing
 * is retried. Disabled unless the SIMBRIEF_USERID secret is set.
 */

import type { Env, IngestEvent } from "./types";

const FETCH_URL = "https://www.simbrief.com/api/xml.fetcher.php";
const FETCH_TIMEOUT_MS = 10_000;
/** A plan generated more than this before takeoff is someone else's flight (or yesterday's). */
const MAX_PLAN_AGE_MS = 24 * 60 * 60 * 1000;
/** Clock-skew slack: a plan generated after takeoff belongs to a later flight. */
const AFTER_TAKEOFF_SLACK_MS = 5 * 60 * 1000;
/** Liftoff point within this distance of the planned origin counts as the same airport. */
const ORIGIN_RADIUS_NM = 10;
const MAX_FIXES = 1000;
const MAX_ROUTE = 2000;

type Obj = Record<string, unknown>;

export async function attachSimbriefPlan(env: Env, takeoff: IngestEvent): Promise<void> {
  const userId = env.SIMBRIEF_USERID?.trim();
  if (!userId || !/^\d{1,12}$/.test(userId)) return;
  const flightUuid = takeoff.id;
  try {
    const res = await fetch(`${FETCH_URL}?userid=${userId}&json=v2`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const ofp = (await res.json().catch(() => null)) as Obj | null;
    const status = str(obj(ofp?.fetch).status);
    if (!res.ok || !ofp || status !== "Success") {
      console.log(`simbrief ${flightUuid}: fetch failed (${res.status} ${status ?? "no status"})`);
      return;
    }
    const match = matchPlan(ofp, takeoff);
    if (!match.ok) {
      console.log(`simbrief ${flightUuid}: latest plan not attached: ${match.note}`);
      return;
    }
    await insertPlan(env.DB, flightUuid, ofp, match.note);
    console.log(`simbrief ${flightUuid}: attached OFP ${str(obj(ofp.params).request_id)} (${match.note})`);
  } catch (err) {
    console.log(`simbrief ${flightUuid}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Does the latest OFP belong to the flight that just took off? */
export function matchPlan(ofp: Obj, takeoff: IngestEvent): { ok: boolean; note: string } {
  const p = takeoff.payload;
  const takeoffMs = Date.parse(str(p.takeoff_ts) ?? takeoff.ts);
  const generatedMs = parseTime(obj(ofp.params).time_generated);
  if (!Number.isFinite(takeoffMs) || generatedMs === null) return { ok: false, note: "no timestamps" };
  if (generatedMs > takeoffMs + AFTER_TAKEOFF_SLACK_MS) return { ok: false, note: "generated after takeoff" };
  if (generatedMs < takeoffMs - MAX_PLAN_AGE_MS) return { ok: false, note: "generated over 24 h before takeoff" };

  const origin = obj(ofp.origin);
  const originIcao = str(origin.icao_code)?.toUpperCase() ?? null;
  const depIcao = str(p.departure_icao)?.toUpperCase() ?? null;
  if (originIcao && depIcao === originIcao) return { ok: true, note: `departure matches origin ${originIcao}` };

  if (p.started_in_air === true) return { ok: true, note: "started in the air, origin unverified" };

  const oLat = num(origin.pos_lat);
  const oLon = num(origin.pos_long);
  const dLat = num(p.departure_lat);
  const dLon = num(p.departure_lon);
  if (oLat !== null && oLon !== null && dLat !== null && dLon !== null) {
    const nm = haversineNm(oLat, oLon, dLat, dLon);
    if (nm <= ORIGIN_RADIUS_NM) return { ok: true, note: `liftoff ${nm.toFixed(1)} nm from origin ${originIcao ?? "?"}` };
  }
  return { ok: false, note: `departure ${depIcao ?? "unknown"} is not origin ${originIcao ?? "unknown"}` };
}

function insertPlan(db: D1Database, flightUuid: string, ofp: Obj, matchNote: string): Promise<D1Result> {
  const params = obj(ofp.params);
  const general = obj(ofp.general);
  const atc = obj(ofp.atc);
  const aircraft = obj(ofp.aircraft);
  const times = obj(ofp.times);
  const fuel = obj(ofp.fuel);
  const files = obj(ofp.files);
  const alternate = obj(list(ofp.alternate)[0]);

  const generatedMs = parseTime(params.time_generated);
  const callsign = str(atc.callsign) ?? joinOrNull(str(general.icao_airline), str(general.flight_number));
  const pdfLink = str(obj(files.pdf).link);
  const directory = str(files.directory);
  const pdfUrl = pdfLink && directory?.startsWith("https://") ? directory + pdfLink : null;

  const row: Record<string, string | number | null> = {
    flight_uuid: flightUuid,
    ofp_id: str(params.request_id),
    generated_at: generatedMs === null ? null : new Date(generatedMs).toISOString(),
    callsign,
    origin_icao: str(obj(ofp.origin).icao_code),
    destination_icao: str(obj(ofp.destination).icao_code),
    alternate_icao: str(alternate.icao_code),
    route: str(general.route)?.slice(0, MAX_ROUTE) ?? null,
    cruise_altitude_ft: int(general.initial_altitude),
    aircraft_type: str(aircraft.icaocode) ?? str(aircraft.icao_code),
    aircraft_registration: str(aircraft.reg),
    route_distance_nm: num(general.route_distance),
    est_time_enroute_s: hmsSeconds(times.est_time_enroute),
    block_fuel: num(fuel.plan_ramp),
    trip_fuel: num(fuel.enroute_burn),
    fuel_units: str(params.units),
    pdf_url: pdfUrl,
    match_note: matchNote,
    plan_json: JSON.stringify({ navlog: navlog(ofp) }),
  };
  const cols = Object.keys(row);
  return db
    .prepare(
      `INSERT OR IGNORE INTO flight_plans (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`,
    )
    .bind(...cols.map((c) => row[c]))
    .run();
}

/** The navlog fixes, trimmed to what a route map needs. */
function navlog(ofp: Obj): Obj[] {
  // json=v2 returns an array; the older json=1 shape nests it under navlog.fix.
  const fixes = Array.isArray(ofp.navlog) ? ofp.navlog : list(obj(ofp.navlog).fix);
  return fixes.slice(0, MAX_FIXES).map((raw) => {
    const f = obj(raw);
    return {
      ident: str(f.ident),
      type: str(f.type),
      lat: num(f.pos_lat),
      lon: num(f.pos_long),
      altitude_ft: int(f.altitude_feet),
      stage: str(f.stage),
      via: str(f.via_airway),
    };
  });
}

// ---------------------------------------------------------------------------
// Value helpers: SimBrief sends everything as strings, single items unwrapped.
// ---------------------------------------------------------------------------

function obj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

/** Arrays stay arrays; a single object (or numeric-keyed object) becomes a list. */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (!v || typeof v !== "object") return [];
  const o = v as Obj;
  return "0" in o ? Object.values(o) : [o];
}

function str(v: unknown): string | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  return s === "" ? null : s.slice(0, 200);
}

function num(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

/** ISO string, or unix seconds in older responses. */
function parseTime(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const ms = /^\d+$/.test(s) ? Number(s) * 1000 : Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

/** "03:39:52" -> 13192; plain seconds pass through. */
function hmsSeconds(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const m = /^(\d+):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  return int(s);
}

function joinOrNull(a: string | null, b: string | null): string | null {
  return a && b ? a + b : null;
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a)));
}
