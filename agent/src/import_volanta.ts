/**
 * One-off import: Volanta flight history -> Worker, as flight.import events.
 *
 *   npm run build
 *   npm run import:volanta -- <unzipped export dir>                 # dry run, nothing sent
 *   npm run import:volanta -- <unzipped export dir> --csv preview.csv
 *   npm run import:volanta -- <unzipped export dir> --send
 *
 * The export directory is the unzipped Volanta export: it holds flights/*.export
 * (one JSON file per flight) and aircraft.export. Track points are not sent.
 *
 * Safe to re-run: every Volanta flight maps to the event id "volanta:<key>", so
 * the Worker reports inserted_flights: 0 the second time and a flight deleted in
 * the logbook stays deleted.
 *
 * With --send, WORKER_URL and AGENT_TOKEN come from agent/.env or the
 * environment. If VIEWER_TOKEN is also set, the existing logbook is read first
 * and the import stops when a Volanta flight starts within 10 minutes of a
 * flight recorded elsewhere (pass --allow-overlap to send anyway).
 */

import fs from "node:fs";
import path from "node:path";
import { findNearestAirport } from "./airports.js";
import { ConfigError, loadConfig, readEnvFile, ENV_PATH } from "./config.js";
import type { Config } from "./config.js";
import { finiteNum, icaoTypeFromAtcModel, makeEvent } from "./events.js";
import type { AgentEvent, FlightRecord } from "./events.js";
import { postJson } from "./sender.js";

/** Same threshold as the agent's flight detector. */
const MIN_FLIGHT_SECONDS = 30;
/** Touchdowns within this window of the first one are the same landing (bounces). */
const BOUNCE_WINDOW_MS = 15_000;
const OVERLAP_WINDOW_MS = 10 * 60_000;
const ID_PREFIX = "volanta:";
const IMPORT_NOTE = "Imported from Volanta";

interface VolantaAirport {
  name?: string | null;
  latitude?: number | null;
  longitude?: number | null;
}

interface VolantaPosition {
  time?: string;
  latitude?: number;
  longitude?: number;
  altitude?: number;
  ground_status?: boolean;
}

interface VolantaEvent {
  time?: string;
  landingRate?: number;
  gForce?: number;
}

interface VolantaFlight {
  key: string;
  flight_status?: string;
  origin_icao?: string | null;
  arrival_icao?: string | null;
  source?: VolantaAirport | null;
  target?: VolantaAirport | null;
  plane_name?: string | null;
  plane_reg?: string | null;
  aircraft_code?: string | null;
  departure_time?: string | null;
  on_blocks_time?: string | null;
  creation_time?: string | null;
  real_flight_time?: number | null;
  total_block_time?: number | null;
  flight_distance?: number | null;
  call_sign?: string | null;
  flight_route?: string | null;
  positions?: VolantaPosition[] | null;
  event_list?: VolantaEvent[] | null;
}

interface Skipped {
  key: string;
  reason: string;
}

/** Volanta writes UTC timestamps without a zone suffix; normalise to the agent's toISOString() form. */
function utcIso(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const hasZone = /(Z|[+-]\d\d:\d\d)$/.test(raw);
  const ms = Date.parse(hasZone ? raw : `${raw}Z`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** MSFS 2024 menu placeholder (lat 0 / lon 0 or 90E) or an implausible altitude, as in the flight detector. */
function isPlaceholder(p: VolantaPosition): boolean {
  const lat = p.latitude ?? 0;
  const lon = p.longitude ?? 0;
  if ((p.altitude ?? 0) > 60_000) return true;
  return Math.abs(lat) < 0.01 && (Math.abs(lon) < 0.01 || Math.abs(lon - 90) < 0.01);
}

function loadAircraftTypes(exportDir: string): Map<string, string> {
  const types = new Map<string, string>();
  try {
    const rows = JSON.parse(fs.readFileSync(path.join(exportDir, "aircraft.export"), "utf8")) as Array<{
      registration?: string;
      aircraft_type_icao?: string;
    }>;
    for (const row of rows) {
      const reg = text(row.registration)?.toUpperCase();
      const type = icaoTypeFromAtcModel(row.aircraft_type_icao);
      if (reg && type) types.set(reg, type);
    }
  } catch {
    // optional file
  }
  return types;
}

/** The unzipped export may be the volanta-export folder itself or its parent. */
function resolveExportDir(arg: string): string {
  for (const dir of [arg, path.join(arg, "volanta-export")]) {
    if (fs.existsSync(path.join(dir, "flights"))) return dir;
  }
  throw new Error(`No flights/ folder in ${arg}. Unzip the Volanta export and pass that folder.`);
}

function toFlight(
  v: VolantaFlight,
  aircraftTypes: Map<string, string>,
): { flight: FlightRecord; extra: Record<string, unknown> } | string {
  if (v.flight_status !== "Completed") return `status ${v.flight_status ?? "unknown"}`;

  const positions = (v.positions ?? [])
    .filter((p) => typeof p.time === "string" && !isPlaceholder(p))
    .sort((a, b) => (a.time! < b.time! ? -1 : a.time! > b.time! ? 1 : 0));
  const firstAirborne = positions.find((p) => p.ground_status === false);
  if (!firstAirborne) return "never took off";

  const elapsed = finiteNum(v.real_flight_time);
  if (elapsed === null || elapsed < MIN_FLIGHT_SECONDS) return `flight time ${Math.floor(elapsed ?? 0)} s`;

  const date = utcIso(firstAirborne.time) ?? utcIso(v.departure_time) ?? utcIso(v.creation_time);
  if (!date) return "no date";

  const touchdowns = (v.event_list ?? [])
    .filter((e) => typeof e.landingRate === "number" && typeof e.time === "string")
    .map((e) => ({ ...e, ms: Date.parse(utcIso(e.time) ?? "") }))
    .filter((e) => Number.isFinite(e.ms))
    .sort((a, b) => a.ms - b.ms);
  const first = touchdowns[0];
  const landing = first ? touchdowns.filter((e) => e.ms - first.ms <= BOUNCE_WINDOW_MS) : [];
  const gValues = landing.map((e) => finiteNum(e.gForce)).filter((g): g is number => g !== null);

  const last = positions[positions.length - 1];
  const endedInAir = last.ground_status === false;

  let arrivalIcao = text(v.arrival_icao);
  let arrivalName = text(v.target?.name);
  let arrivalLat = finiteNum(v.target?.latitude);
  let arrivalLon = finiteNum(v.target?.longitude);
  if (!arrivalIcao) {
    // Like the agent: a flight that ended in the air has no arrival at all; one
    // that ended on the ground keeps its stop position and the nearest airport.
    arrivalName = null;
    arrivalLat = endedInAir ? null : finiteNum(last.latitude);
    arrivalLon = endedInAir ? null : finiteNum(last.longitude);
    const nearest = arrivalLat !== null && arrivalLon !== null ? findNearestAirport(arrivalLat, arrivalLon) : null;
    if (nearest) {
      arrivalIcao = nearest.icao;
      arrivalName = nearest.name || null;
      arrivalLat = nearest.lat;
      arrivalLon = nearest.lon;
    }
  }

  const registration = text(v.plane_reg);
  const aircraftType =
    icaoTypeFromAtcModel(v.aircraft_code) ?? (registration ? aircraftTypes.get(registration.toUpperCase()) ?? null : null);
  const altitudes = positions.map((p) => finiteNum(p.altitude)).filter((a): a is number => a !== null);

  const flight: FlightRecord = {
    date,
    aircraft_title: text(v.plane_name),
    aircraft_registration: registration,
    departure_icao: text(v.origin_icao),
    departure_name: text(v.source?.name),
    departure_lat: finiteNum(v.source?.latitude),
    departure_lon: finiteNum(v.source?.longitude),
    arrival_icao: arrivalIcao,
    arrival_name: arrivalName,
    arrival_lat: arrivalLat,
    arrival_lon: arrivalLon,
    distance_nm: finiteNum(v.flight_distance, 1),
    elapsed_seconds: Math.round(elapsed),
    max_altitude_ft: altitudes.length ? Math.round(Math.max(...altitudes)) : null,
    landing_vs_fpm: first ? finiteNum(first.landingRate, 1) : null,
    landing_g_force: gValues.length ? Math.round(Math.max(...gValues) * 100) / 100 : null,
    notes: endedInAir && !text(v.arrival_icao) ? `${IMPORT_NOTE}. Ended without landing` : IMPORT_NOTE,
    aircraft_type: aircraftType,
  };

  // Not logbook columns: the Worker keeps them in the events table with the payload.
  const extra = {
    source: "volanta",
    volanta_key: v.key,
    call_sign: text(v.call_sign),
    flight_route: text(v.flight_route),
    block_seconds: finiteNum(v.total_block_time, 0),
    off_blocks: utcIso(v.departure_time),
    on_blocks: utcIso(v.on_blocks_time),
  };
  return { flight, extra };
}

function readFlights(exportDir: string): { events: AgentEvent[]; skipped: Skipped[] } {
  const aircraftTypes = loadAircraftTypes(exportDir);
  const flightsDir = path.join(exportDir, "flights");
  const events: AgentEvent[] = [];
  const skipped: Skipped[] = [];

  for (const name of fs.readdirSync(flightsDir).filter((n) => n.endsWith(".export")).sort()) {
    const fallbackKey = name.replace(/\.export$/, "");
    let v: VolantaFlight;
    try {
      v = JSON.parse(fs.readFileSync(path.join(flightsDir, name), "utf8")) as VolantaFlight;
    } catch {
      skipped.push({ key: fallbackKey, reason: "unreadable JSON" });
      continue;
    }
    v.key = text(v.key) ?? fallbackKey;
    const result = toFlight(v, aircraftTypes);
    if (typeof result === "string") {
      skipped.push({ key: v.key, reason: result });
      continue;
    }
    events.push(makeEvent("flight.import", { ...result.flight, ...result.extra }, `${ID_PREFIX}${v.key}`));
  }
  events.sort((a, b) => String(a.payload.date).localeCompare(String(b.payload.date)));
  return { events, skipped };
}

function duration(seconds: unknown): string {
  const s = typeof seconds === "number" ? seconds : 0;
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
}

function printSummary(events: AgentEvent[], skipped: Skipped[]): void {
  const cell = (v: unknown, w: number) => String(v ?? "-").slice(0, w).padEnd(w);
  console.log(`${cell("date", 20)} ${cell("from", 5)} ${cell("to", 5)} ${cell("type", 5)} ${cell("time", 6)} notes`);
  for (const { payload: p } of events) {
    console.log(
      `${cell(String(p.date).slice(0, 16).replace("T", " "), 20)} ${cell(p.departure_icao, 5)} ${cell(p.arrival_icao, 5)} ` +
        `${cell(p.aircraft_type, 5)} ${cell(duration(p.elapsed_seconds), 6)} ${p.notes}`,
    );
  }
  console.log(`\n${events.length} flight(s) to import, ${skipped.length} skipped:`);
  for (const s of skipped) console.log(`  ${s.key}  ${s.reason}`);
}

function writeCsv(file: string, events: AgentEvent[]): void {
  const cols = ["event_id", ...Object.keys(events[0]?.payload ?? {})];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.join(","), ...events.map((e) => cols.map((c) => esc(c === "event_id" ? e.id : e.payload[c])).join(","))];
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
  console.log(`Wrote ${events.length} row(s) to ${file}`);
}

/** Dates of logbook flights not imported from Volanta, read with the viewer token. */
async function existingFlightDates(cfg: Config, viewerToken: string): Promise<number[]> {
  const dates: number[] = [];
  for (let offset = 0; ; offset += 500) {
    const res = await fetch(`${cfg.workerUrl}/api/flights?limit=500&offset=${offset}`, {
      headers: { Authorization: `Bearer ${viewerToken}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`GET /api/flights returned HTTP ${res.status}`);
    const body = (await res.json()) as { flights: Array<{ date?: string; event_id?: string }>; total: number };
    for (const f of body.flights) {
      if (f.event_id?.startsWith(ID_PREFIX)) continue;
      const ms = Date.parse(utcIso(f.date) ?? "");
      if (Number.isFinite(ms)) dates.push(ms);
    }
    if (body.flights.length === 0 || offset + body.flights.length >= body.total) return dates;
  }
}

async function send(cfg: Config, events: AgentEvent[]): Promise<boolean> {
  let inserted = 0;
  for (let start = 0; start < events.length; start += cfg.batchSize) {
    const batch = events.slice(start, start + cfg.batchSize);
    const [status, body] = await postJson(cfg, { events: batch }, 30_000);
    if (status < 200 || status >= 300) {
      console.error(`\nWorker returned HTTP ${status}: ${body.slice(0, 300)}`);
      console.error(`Sent ${start} of ${events.length} event(s) before the error. Re-running is safe.`);
      return false;
    }
    let result: { accepted?: number; inserted_flights?: number } = {};
    try {
      result = JSON.parse(body);
    } catch {
      // keep the counters at zero
    }
    inserted += result.inserted_flights ?? 0;
    console.log(`batch ${start / cfg.batchSize + 1}: accepted ${result.accepted}, new flights ${result.inserted_flights}`);
  }
  console.log(`\nDone. ${events.length} event(s) accepted, ${inserted} new flight(s) created.`);
  return true;
}

async function main(argv: string[]): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const csvIdx = argv.indexOf("--csv");
  const csvPath = csvIdx >= 0 ? argv[csvIdx + 1] : undefined;
  const dirArg = argv.find((a, i) => !a.startsWith("--") && (csvIdx < 0 || i !== csvIdx + 1));
  if (!dirArg || (csvIdx >= 0 && !csvPath)) {
    console.error("Usage: npm run import:volanta -- <unzipped export dir> [--csv file] [--send] [--allow-overlap]");
    return 2;
  }

  const { events, skipped } = readFlights(resolveExportDir(dirArg));
  printSummary(events, skipped);
  if (csvPath) writeCsv(csvPath, events);
  if (!flags.has("--send")) {
    console.log("\nDry run: nothing sent. Add --send to import.");
    return 0;
  }
  if (events.length === 0) return 0;

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const viewerToken = (process.env.VIEWER_TOKEN ?? readEnvFile(ENV_PATH).VIEWER_TOKEN ?? "").trim();
  if (!viewerToken) {
    console.warn("VIEWER_TOKEN not set: skipping the overlap check against existing flights.");
  } else if (!flags.has("--allow-overlap")) {
    const existing = await existingFlightDates(cfg, viewerToken);
    const overlaps = events.filter((e) => {
      const ms = Date.parse(String(e.payload.date));
      return existing.some((d) => Math.abs(d - ms) <= OVERLAP_WINDOW_MS);
    });
    if (overlaps.length) {
      console.error(`\n${overlaps.length} Volanta flight(s) start within 10 minutes of an existing flight:`);
      for (const e of overlaps) console.error(`  ${e.payload.date}  ${e.payload.departure_icao ?? "-"}  ${e.id}`);
      console.error("Nothing sent. Delete the duplicates first, or pass --allow-overlap.");
      return 1;
    }
    console.log(`Overlap check passed against ${existing.length} existing flight(s).`);
  }

  console.log(`\nSending ${events.length} event(s) to ${cfg.workerUrl}`);
  return (await send(cfg, events)) ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
