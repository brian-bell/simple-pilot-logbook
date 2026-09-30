/**
 * Flight detection state machine. Pure logic: samples and sim events go in,
 * flight events come out through `emit`. No network or disk I/O happens here.
 *
 * Public states (heartbeat / GET /api/status, unchanged):
 *   DISCONNECTED -> ON_GROUND -> AIRBORNE
 *
 * Every 1 Hz sample is first classified:
 *   out   the aircraft is parked at a placeholder position (MSFS 2024 menus and
 *         loading screens put it at lat 0 / lon 0 or lat 0 / lon 90E, sometimes
 *         at 50,000+ ft). Nothing about it is a real flight.
 *   hold  we cannot trust it for transitions (menu/world-map/loading camera,
 *         replay, slew, missing values) but it is no evidence that the flight
 *         ended either (ESC pause, loading a view).
 *   live  a real, flying-or-taxiing aircraft.
 * Only live samples change state. That is what stops the phantom
 * "flights" MSFS 2024 used to produce while sitting in the main menu.
 *
 * The "Sim" system event is logged but deliberately not used for gating:
 * MSFS 2024 does not send SimStop when returning to the main menu (DevSupport
 * #11572), so the flag can be stale in both directions, and a stale "stopped"
 * would silently block every flight.
 *
 * Flight ends
 *   landed    on-ground for 3 s after touchdown (bounces within 15 s merge)
 *   crashed   the sim's Crashed event while flying
 *   ended     90 s of `out` samples, a teleport (Travel To / restart / slew far
 *             away), the sim disconnecting, or the agent stopping
 * Flights shorter than 30 s are discarded whatever the end reason.
 */

import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { findNearestAirport, haversineNm, type NearestAirport } from "./airports.js";
import {
  finiteNum,
  icaoTypeFromAtcModel,
  landingEvent,
  positionEvent,
  takeoffEvent,
  type AgentEvent,
  type AgentStatus,
  type CurrentFlight,
  type FlightRecord,
} from "./events.js";
import type { Logger } from "./log.js";
import type { AircraftUpdate, FrameSample, SimInfo, SimSystemEvent, StateSample } from "./simconnect_client.js";

export const MIN_FLIGHT_SECONDS = 30;
const VS_WINDOW_MS = 6_000;
const TOUCHDOWN_SETTLE_MS = 3_000;
const BOUNCE_MERGE_MS = 15_000;
const ABANDON_AFTER_MS = 90_000;
const RESYNC_GAP_MS = 10_000;
const FRAME_BUFFER_MS = 10_000;
const MAX_PLAUSIBLE_ALT_FT = 100_000;
/** Faster than any aircraft: 0.25 nm/s is 900 kt, scaled by the simulation rate, plus a margin. */
const TELEPORT_NM_PER_S = 0.25;
const TELEPORT_MARGIN_NM = 5;
const MAX_PLAUSIBLE_TOUCHDOWN_FPS = 100; // 6,000 fpm

/**
 * MSFS 2024 CAMERA STATE values that mean "not in a flight" (SDK 1.5+ table):
 * 9 Waiting, 10 World Map, 11 Hangar RTC, 12 Hangar Custom, 13 Menu RTC, 19 Hangar,
 * 27 Transition, 29 Idle, 30 World Map Idle, 33 Worldmap Transition.
 */
const MENU_CAMERA_STATES = new Set([9, 10, 11, 12, 13, 19, 27, 29, 30, 33]);
const REPLAY_CAMERA_STATE = 15;

const CAMERA_NAMES: Record<number, string> = {
  1: "Forced Custom Target",
  2: "Cockpit",
  3: "Chase",
  4: "Fixed On Plane",
  5: "Environment 6DOF",
  6: "Gameplay",
  7: "Showcase",
  8: "Drone Plane",
  9: "Waiting",
  10: "World Map",
  11: "Hangar RTC",
  12: "Hangar Custom",
  13: "Menu RTC",
  14: "In Game RTC",
  15: "Replay",
  16: "Drone Developer",
  17: "Drone Top Down",
  18: "Follow Actor",
  19: "Hangar",
  20: "Old Drone Plane",
  21: "Chase F18",
  22: "Ground",
  23: "Follow Air Traffic",
  24: "First View",
  25: "Drone Photo Mode",
  26: "Third View",
  27: "Transition",
  28: "Catch Object",
  29: "Idle",
  30: "World Map Idle",
  31: "Explore Flightpath Drone",
  32: "Focus Location",
  33: "Worldmap Transition",
};

export const NOTE_STARTED_IN_AIR = "Started in the air";
export const NOTE_CRASHED = "Crashed";
export const NOTE_ENDED = "Ended without landing";

type Phase = "DISCONNECTED" | "SYNC" | "ON_GROUND" | "AIRBORNE" | "TOUCHDOWN";
type SampleClass = "live" | "hold" | "out";
type EndReason = "landed" | "crashed" | "ended";

export interface Clock {
  /** Monotonic milliseconds, same base as StateSample.mono. */
  mono(): number;
  /** Wall-clock epoch milliseconds. */
  wall(): number;
}

const systemClock: Clock = { mono: () => performance.now(), wall: () => Date.now() };

interface LiveSample extends StateSample {
  wall: number;
  lat: number;
  lon: number;
  onGround: boolean;
}

interface Touchdown {
  firstContactMono: number;
  lastContactMono: number;
  wall: number;
  lat: number;
  lon: number;
  /** Most negative VERTICAL SPEED in the 6 s before first contact. */
  windowVsFpm: number | null;
  /** First PLANE TOUCHDOWN NORMAL VELOCITY that differs from the pre-contact value. */
  touchdownFps: number | null;
  peakG: number | null;
}

interface Flight {
  uuid: string;
  takeoffWall: number;
  departure: NearestAirport | null;
  departureLat: number;
  departureLon: number;
  aircraftTitle: string | null;
  aircraftRegistration: string | null;
  aircraftType: string | null;
  livery: string | null;
  maxAltFt: number;
  notes: string[];
  lastLive: LiveSample;
  /** PLANE TOUCHDOWN NORMAL VELOCITY before the (next) touchdown, to tell a fresh value from a stale one. */
  touchdownBaselineFps: number | null;
  touchdown: Touchdown | null;
  lastPositionMono: number;
}

export interface DetectorOptions {
  positionSeconds: number;
  emit: (event: AgentEvent) => void;
  log: Logger;
  clock?: Clock;
  nearestAirport?: (lat: number, lon: number) => NearestAirport | null;
}

export class FlightDetector {
  private phase: Phase = "DISCONNECTED";
  private flight: Flight | null = null;
  private sim: SimInfo | null = null;
  private simRunning: boolean | null = null;
  private aircraft: { title: string | null; atcId: string | null; icaoType: string | null; livery: string | null } = {
    title: null,
    atcId: null,
    icaoType: null,
    livery: null,
  };
  private vsWindow: Array<{ mono: number; vs: number }> = [];
  private frames: FrameSample[] = [];
  private lastClassKey: string | null = null;
  private lastLiveMono: number | null = null;
  private lastLive: LiveSample | null = null;
  private outSinceMono: number | null = null;
  private lastSimRate: number | null = null;
  private lastSample: StateSample | null = null;
  /** Set when a pause starts while a flight or a parked aircraft is live; cleared by unpause or the main menu. */
  private pausedInFlight = false;

  private readonly clock: Clock;
  private readonly nearest: (lat: number, lon: number) => NearestAirport | null;
  private readonly positionMs: number;

  constructor(private readonly opts: DetectorOptions) {
    this.clock = opts.clock ?? systemClock;
    this.nearest = opts.nearestAirport ?? ((lat, lon) => findNearestAirport(lat, lon));
    this.positionMs = Math.max(1, opts.positionSeconds) * 1000;
  }

  // ------------------------------------------------------------------
  // Inputs
  // ------------------------------------------------------------------

  connected(info: SimInfo): void {
    this.sim = info;
    this.simRunning = null;
    this.phase = "SYNC";
    this.pausedInFlight = false;
    this.resetSampling();
  }

  /** The sim went away. A flight in progress is closed with what we know. */
  disconnected(reason: string): void {
    this.endFlightInProgress(`sim disconnected (${reason})`);
    this.phase = "DISCONNECTED";
    this.pausedInFlight = false;
    this.sim = null;
    this.resetSampling();
  }

  /** The agent is shutting down. Queue what we have so the flight is not lost. */
  shutdown(): void {
    this.endFlightInProgress("agent stopping");
    this.phase = "DISCONNECTED";
  }

  aircraftUpdate(update: AircraftUpdate): void {
    const before = { ...this.aircraft };
    if (update.title !== undefined) this.aircraft.title = update.title;
    if (update.atcId !== undefined) this.aircraft.atcId = update.atcId;
    if (update.atcModel !== undefined) this.aircraft.icaoType = icaoTypeFromAtcModel(update.atcModel);
    if (update.livery !== undefined) this.aircraft.livery = update.livery;
    if (
      before.title !== this.aircraft.title ||
      before.atcId !== this.aircraft.atcId ||
      before.icaoType !== this.aircraft.icaoType ||
      before.livery !== this.aircraft.livery
    ) {
      this.opts.log.info(
        `Aircraft: ${this.aircraft.title ?? "?"} | ATC ID ${this.aircraft.atcId ?? "?"} | ` +
          `type ${this.aircraft.icaoType ?? "?"}${update.atcModel !== undefined ? ` (ATC MODEL ${update.atcModel ?? "?"})` : ""} | livery ${this.aircraft.livery ?? "?"}`,
      );
    }
  }

  systemEvent(event: SimSystemEvent): void {
    const log = this.opts.log;
    switch (event.kind) {
      case "sim":
        if (this.simRunning !== event.running) log.info(`Sim ${event.running ? "running" : "stopped"}.`);
        this.simRunning = event.running;
        break;
      case "pause":
        log.info(`Pause_EX1 flags=${event.flags} (${describePause(event.flags)}).`);
        // Samples stop while paused, so decide from what was live when the pause began.
        this.pausedInFlight =
          event.flags !== 0 &&
          this.outSinceMono === null &&
          (this.pausedInFlight || this.flight !== null || this.liveOnGround());
        break;
      case "crashed":
        log.warn("Sim reported a crash.");
        if (this.flight) {
          this.finish("crashed", this.clock.mono());
          this.phase = "SYNC"; // the sim resets the aircraft; the next live sample decides
        }
        break;
      case "crashReset":
        log.info("Crash reset.");
        break;
      case "flightLoaded":
        log.info(`Flight loaded: ${event.file || "?"}`);
        break;
      case "aircraftLoaded":
        log.info(`Aircraft loaded: ${event.file || "?"}`);
        break;
    }
  }

  frame(sample: FrameSample): void {
    this.frames.push(sample);
    const cutoff = sample.mono - FRAME_BUFFER_MS;
    while (this.frames.length && this.frames[0].mono < cutoff) this.frames.shift();

    const td = this.flight?.touchdown;
    if (td && sample.mono >= td.firstContactMono - 500 && sample.mono <= td.lastContactMono + TOUCHDOWN_SETTLE_MS) {
      this.absorbTouchdownValues(td, sample.gForce, sample.touchdownNormalFps);
    }
  }

  state(sample: StateSample): void {
    this.lastSample = sample;
    this.noteSimRate(sample.simRate);

    const [cls, key, detail] = this.classify(sample);
    if (key !== this.lastClassKey) {
      // Logged on change only (not every second): these lines are how the gating is tuned.
      this.opts.log.info(`Sample ${cls}: ${detail}`);
      this.lastClassKey = key;
    }

    if (cls === "out") {
      this.pausedInFlight = false; // placeholder position: back in the main menu
      this.outSinceMono ??= sample.mono;
      if (this.flight && sample.mono - this.outSinceMono >= ABANDON_AFTER_MS) {
        this.opts.log.info("Aircraft has been out of the flight for 90 s.");
        this.finish("ended", sample.mono);
        this.phase = "SYNC";
      }
      this.tick();
      return;
    }
    this.outSinceMono = null;
    if (cls === "hold") {
      this.tick();
      return;
    }

    const live = { ...sample, wall: this.clock.wall() } as LiveSample;
    this.onLive(live);
    this.tick();
  }

  /** Called every second by the worker, and after every sample, for time-based transitions. */
  tick(): void {
    const td = this.flight?.touchdown;
    if (this.phase === "TOUCHDOWN" && td && this.clock.mono() - td.lastContactMono >= TOUCHDOWN_SETTLE_MS) {
      this.finish("landed", this.clock.mono());
      this.phase = "ON_GROUND";
    }
  }

  // ------------------------------------------------------------------
  // Output
  // ------------------------------------------------------------------

  /**
   * Parked with a recent live sample. Menu, loading and placeholder samples leave the
   * phase at ON_GROUND (only the next live sample resyncs), so a stale one means "not in a flight".
   */
  private liveOnGround(): boolean {
    return this.phase === "ON_GROUND" && this.lastLiveMono !== null && this.clock.mono() - this.lastLiveMono < RESYNC_GAP_MS;
  }

  status(): AgentStatus {
    if (this.phase === "DISCONNECTED") {
      return { connected: false, state: "DISCONNECTED", on_ground: false, paused: false, current_flight: null };
    }
    const f = this.flight;
    if (!f) {
      return { connected: true, state: "ON_GROUND", on_ground: this.liveOnGround(), paused: this.pausedInFlight, current_flight: null };
    }
    const current: CurrentFlight = {
      departure_icao: f.departure?.icao ?? null,
      departure_name: f.departure?.name ?? null,
      departure_lat: f.departureLat,
      departure_lon: f.departureLon,
      aircraft_title: f.aircraftTitle,
      aircraft_registration: f.aircraftRegistration,
      aircraft_type: f.aircraftType,
      elapsed_seconds: Math.max(0, Math.trunc((this.clock.wall() - f.takeoffWall) / 1000)),
      altitude_ft: finiteNum(f.lastLive.altitudeFt, 0),
    };
    return { connected: true, state: "AIRBORNE", on_ground: false, paused: this.pausedInFlight, current_flight: current };
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  private resetSampling(): void {
    this.vsWindow = [];
    this.frames = [];
    this.lastClassKey = null;
    this.lastLiveMono = null;
    this.lastLive = null;
    this.outSinceMono = null;
  }

  /** Returns [class, stable key for change logging, human-readable detail]. */
  private classify(s: StateSample): [SampleClass, string, string] {
    const cam = s.cameraState;
    const camText = cam === null ? "camera ?" : `camera ${cam} ${CAMERA_NAMES[cam] ?? "(unknown)"}`;
    const pos =
      s.lat === null || s.lon === null
        ? "position ?"
        : `${s.lat.toFixed(4)},${s.lon.toFixed(4)} ${Math.round(s.altitudeFt ?? 0)} ft`;

    if (s.lat === null || s.lon === null || s.onGround === null) {
      return ["hold", "missing", `missing values (${pos}, ${camText})`];
    }
    if (isPlaceholderPosition(s.lat, s.lon)) {
      return ["out", `placeholder:${cam}`, `placeholder position ${pos} (${camText})`];
    }
    if (s.altitudeFt !== null && Math.abs(s.altitudeFt) > MAX_PLAUSIBLE_ALT_FT) {
      return ["out", `altitude:${cam}`, `implausible altitude ${pos} (${camText})`];
    }
    if (s.slew) return ["hold", "slew", `slew active (${pos}, ${camText})`];
    if (cam !== null && MENU_CAMERA_STATES.has(cam)) {
      return ["hold", `camera:${cam}`, `menu/loading ${camText} (${pos})`];
    }
    if (cam === REPLAY_CAMERA_STATE) return ["hold", "replay", `replay (${pos})`];
    return ["live", `live:${s.onGround ? "ground" : "air"}`, `${s.onGround ? "on ground" : "airborne"} ${pos}, ${camText}`];
  }

  private noteSimRate(rate: number | null): void {
    if (rate === null || rate === this.lastSimRate) return;
    if (this.lastSimRate !== null) this.opts.log.info(`Simulation rate ${this.lastSimRate}x -> ${rate}x.`);
    this.lastSimRate = rate;
  }

  private onLive(s: LiveSample): void {
    const prev = this.lastLive;
    const gapMs = this.lastLiveMono === null ? Infinity : s.mono - this.lastLiveMono;
    const jumpNm = prev ? haversineNm(prev.lat, prev.lon, s.lat, s.lon) : 0;
    const rate = Math.max(1, this.lastSimRate ?? 1);
    const teleported =
      prev !== null && jumpNm > TELEPORT_MARGIN_NM + (TELEPORT_NM_PER_S * rate * Math.max(gapMs, 1000)) / 1000;

    this.lastLiveMono = s.mono;
    this.lastLive = s;

    if (teleported) {
      this.opts.log.info(`Position jumped ${jumpNm.toFixed(1)} nm in ${(gapMs / 1000).toFixed(0)} s.`);
      this.vsWindow = [];
      if (this.flight) this.finish("ended", s.mono);
      this.phase = "SYNC";
    } else if (gapMs >= RESYNC_GAP_MS) {
      this.vsWindow = []; // stale across a pause or loading screen
      if (this.phase === "ON_GROUND") this.phase = "SYNC";
    }

    if (s.vsFpm !== null) {
      this.vsWindow.push({ mono: s.mono, vs: s.vsFpm });
      while (this.vsWindow.length && s.mono - this.vsWindow[0].mono > VS_WINDOW_MS) this.vsWindow.shift();
    }

    if ((this.phase === "AIRBORNE" || this.phase === "TOUCHDOWN") && !this.flight) this.phase = "SYNC";

    switch (this.phase) {
      case "DISCONNECTED":
      case "SYNC":
        if (s.onGround) {
          this.phase = "ON_GROUND";
          this.opts.log.info(`On ground at ${s.lat.toFixed(4)},${s.lon.toFixed(4)}.`);
        } else {
          this.startFlight(s, true);
        }
        break;
      case "ON_GROUND":
        if (!s.onGround) this.startFlight(s, false);
        break;
      case "AIRBORNE":
        this.trackAirborne(s);
        if (s.onGround) this.touchdown(s);
        break;
      case "TOUCHDOWN":
        if (this.flight) this.flight.lastLive = s;
        if (!s.onGround) {
          // Bounce: stay in the same flight and keep the first contact's numbers.
          this.opts.log.info("Bounced back into the air.");
          this.phase = "AIRBORNE";
          this.trackAirborne(s);
        } else if (this.flight?.touchdown) {
          this.absorbTouchdownValues(this.flight.touchdown, s.gForce, s.touchdownNormalFps);
        }
        break;
    }
  }

  private startFlight(s: LiveSample, startedInAir: boolean): void {
    const departure = startedInAir ? null : this.nearest(s.lat, s.lon);
    const flight: Flight = {
      uuid: randomUUID(),
      takeoffWall: s.wall,
      departure,
      departureLat: s.lat,
      departureLon: s.lon,
      aircraftTitle: this.aircraft.title,
      aircraftRegistration: this.aircraft.atcId,
      aircraftType: this.aircraft.icaoType,
      livery: this.aircraft.livery,
      maxAltFt: s.altitudeFt ?? 0,
      notes: startedInAir ? [NOTE_STARTED_IN_AIR] : [],
      lastLive: s,
      touchdownBaselineFps: s.touchdownNormalFps,
      touchdown: null,
      lastPositionMono: s.mono, // first position event follows one interval after takeoff
    };
    this.flight = flight;
    this.phase = "AIRBORNE";
    this.opts.log.info(
      startedInAir
        ? `Already airborne at ${s.lat.toFixed(4)},${s.lon.toFixed(4)} (${Math.round(s.altitudeFt ?? 0)} ft); starting a flight.`
        : `Takeoff from ${departure?.icao ?? "?"} at ${s.lat.toFixed(4)},${s.lon.toFixed(4)}.`,
    );
    this.opts.emit(
      takeoffEvent({
        flight_uuid: flight.uuid,
        takeoff_ts: new Date(flight.takeoffWall).toISOString(),
        departure_icao: departure?.icao ?? null,
        departure_name: departure?.name ?? null,
        departure_lat: s.lat,
        departure_lon: s.lon,
        aircraft_title: flight.aircraftTitle,
        aircraft_registration: flight.aircraftRegistration,
        aircraft_type: flight.aircraftType,
        livery: flight.livery,
        altitude_ft: finiteNum(s.altitudeFt),
        started_in_air: startedInAir,
        sim: this.simDescription(),
      }),
    );
  }

  private trackAirborne(s: LiveSample): void {
    const f = this.flight;
    if (!f) return;
    f.lastLive = s;
    if (s.altitudeFt !== null) f.maxAltFt = Math.max(f.maxAltFt, s.altitudeFt);
    f.aircraftTitle ??= this.aircraft.title;
    f.aircraftRegistration ??= this.aircraft.atcId;
    f.aircraftType ??= this.aircraft.icaoType;
    f.livery ??= this.aircraft.livery;

    if (f.touchdown && s.mono - f.touchdown.lastContactMono > TOUCHDOWN_SETTLE_MS) {
      // The last contact's value has settled: a later contact must differ from it to count as fresh.
      f.touchdownBaselineFps = s.touchdownNormalFps;
      // A touch-and-go long after the previous contact starts a fresh landing record.
      if (s.mono - f.touchdown.lastContactMono > BOUNCE_MERGE_MS) f.touchdown = null;
    }

    if (s.mono - f.lastPositionMono >= this.positionMs) {
      f.lastPositionMono = s.mono;
      this.opts.emit(
        positionEvent(f.uuid, s.lat, s.lon, s.altitudeFt, s.vsFpm, s.groundSpeedKt, (s.wall - f.takeoffWall) / 1000),
      );
    }
  }

  private touchdown(s: LiveSample): void {
    const f = this.flight;
    if (!f) return;
    f.lastLive = s;
    // The 1 Hz sample can lag the real contact by up to a second: find it in the frame stream.
    const since = (this.lastLiveBeforeMono(s) ?? s.mono - 1500) - 250;
    const contactFrame = this.frames.find((fr) => fr.mono >= since && fr.onGround === true);
    const contactMono = Math.min(contactFrame?.mono ?? s.mono, s.mono);

    if (f.touchdown && contactMono - f.touchdown.lastContactMono <= BOUNCE_MERGE_MS) {
      f.touchdown.lastContactMono = contactMono; // bounce: same landing, keep the first contact's values
    } else {
      const window = this.vsWindow.filter((v) => v.mono <= contactMono + 250).map((v) => v.vs);
      f.touchdown = {
        firstContactMono: contactMono,
        lastContactMono: contactMono,
        wall: s.wall - (s.mono - contactMono),
        lat: s.lat,
        lon: s.lon,
        windowVsFpm: window.length ? Math.min(...window) : null,
        touchdownFps: null,
        peakG: null,
      };
      for (const fr of this.frames) {
        if (fr.mono >= contactMono - 500) this.absorbTouchdownValues(f.touchdown, fr.gForce, fr.touchdownNormalFps);
      }
    }
    this.absorbTouchdownValues(f.touchdown, s.gForce, s.touchdownNormalFps);
    this.phase = "TOUCHDOWN";
    this.opts.log.info(`Touchdown at ${s.lat.toFixed(4)},${s.lon.toFixed(4)}.`);
  }

  /** mono of the live sample before `s` (the vsWindow keeps them). */
  private lastLiveBeforeMono(s: LiveSample): number | null {
    for (let i = this.vsWindow.length - 1; i >= 0; i--) {
      if (this.vsWindow[i].mono < s.mono) return this.vsWindow[i].mono;
    }
    return null;
  }

  private absorbTouchdownValues(td: Touchdown, g: number | null, fps: number | null): void {
    const f = this.flight;
    if (g !== null && Number.isFinite(g)) td.peakG = td.peakG === null ? g : Math.max(td.peakG, g);
    if (
      td.touchdownFps === null &&
      fps !== null &&
      Number.isFinite(fps) &&
      fps !== f?.touchdownBaselineFps &&
      Math.abs(fps) > 0 &&
      Math.abs(fps) <= MAX_PLAUSIBLE_TOUCHDOWN_FPS
    ) {
      td.touchdownFps = fps;
    }
  }

  private endFlightInProgress(why: string): void {
    if (!this.flight) return;
    this.opts.log.info(`Closing the flight in progress: ${why}.`);
    // A pending touchdown is a real landing; anything else ended without one.
    this.finish(this.phase === "TOUCHDOWN" ? "landed" : "ended", this.clock.mono());
  }

  private finish(reason: EndReason, nowMono: number): void {
    const f = this.flight;
    if (!f) return;
    this.flight = null;
    const td = f.touchdown;
    const landed = reason === "landed" && td !== null;

    const endWall = landed ? td.wall : f.lastLive.wall;
    const elapsed = Math.max(0, Math.trunc((endWall - f.takeoffWall) / 1000));
    if (elapsed < MIN_FLIGHT_SECONDS) {
      this.opts.log.info(`Flight too short (${elapsed} s, ${reason}); discarding.`);
      return;
    }

    const notes = [...f.notes];
    if (reason === "crashed") notes.push(NOTE_CRASHED);
    if (reason === "ended") notes.push(NOTE_ENDED);

    // Crashes are recorded where they happened; "ended" flights have no arrival.
    const arrLat = landed ? td.lat : reason === "crashed" ? f.lastLive.lat : null;
    const arrLon = landed ? td.lon : reason === "crashed" ? f.lastLive.lon : null;
    const arrival = arrLat !== null && arrLon !== null ? this.nearest(arrLat, arrLon) : null;
    const distance =
      arrLat !== null && arrLon !== null ? finiteNum(haversineNm(f.departureLat, f.departureLon, arrLat, arrLon), 1) : null;

    let vsFpm: number | null = null;
    let vsSource: string | null = null;
    let gForce: number | null = null;
    if (td && reason !== "ended") {
      if (td.touchdownFps !== null) {
        vsFpm = -Math.abs(td.touchdownFps) * 60;
        vsSource = "touchdown_normal_velocity";
      } else if (td.windowVsFpm !== null) {
        vsFpm = td.windowVsFpm;
        vsSource = "vertical_speed_window";
      }
      gForce = td.peakG;
    } else if (reason === "crashed") {
      gForce = this.peakFrameG(nowMono - 3000, nowMono);
    }

    const record: FlightRecord = {
      date: new Date(f.takeoffWall).toISOString(),
      aircraft_title: f.aircraftTitle ?? this.aircraft.title,
      aircraft_registration: f.aircraftRegistration ?? this.aircraft.atcId,
      departure_icao: f.departure?.icao ?? null,
      departure_name: f.departure?.name ?? null,
      departure_lat: f.departureLat,
      departure_lon: f.departureLon,
      arrival_icao: arrival?.icao ?? null,
      arrival_name: arrival?.name ?? null,
      arrival_lat: arrLat,
      arrival_lon: arrLon,
      distance_nm: distance,
      elapsed_seconds: elapsed,
      max_altitude_ft: finiteNum(f.maxAltFt, 0),
      landing_vs_fpm: finiteNum(vsFpm, 1),
      landing_g_force: finiteNum(gForce, 2),
      notes: notes.length ? notes.join("; ") : null,
      aircraft_type: f.aircraftType ?? this.aircraft.icaoType,
    };

    this.opts.emit(
      landingEvent(record, {
        flight_uuid: f.uuid,
        end_reason: reason,
        landing_vs_source: vsSource,
        livery: f.livery,
        sim: this.simDescription(),
      }),
    );
    this.opts.log.info(
      `Flight ${record.departure_icao ?? "?"} -> ${record.arrival_icao ?? "?"} (${elapsed} s, ${reason}` +
        `${record.landing_vs_fpm !== null ? `, ${record.landing_vs_fpm} fpm` : ""}` +
        `${record.landing_g_force !== null ? `, ${record.landing_g_force} G` : ""}) queued for upload.`,
    );
  }

  private peakFrameG(fromMono: number, toMono: number): number | null {
    let peak: number | null = null;
    for (const fr of this.frames) {
      if (fr.mono >= fromMono && fr.mono <= toMono && fr.gForce !== null) {
        peak = peak === null ? fr.gForce : Math.max(peak, fr.gForce);
      }
    }
    return peak;
  }

  private simDescription(): string | null {
    return this.sim ? `${this.sim.label} ${this.sim.version}` : null;
  }
}

/** MSFS 2024 parks the user aircraft here in menus and loading screens. */
export function isPlaceholderPosition(lat: number, lon: number): boolean {
  return Math.abs(lat) < 1e-3 && (Math.abs(lon) < 1e-3 || Math.abs(lon - 90) < 1e-3);
}

function describePause(flags: number): string {
  if (flags === 0) return "unpaused";
  const parts: string[] = [];
  if (flags & 1) parts.push("pause");
  if (flags & 2) parts.push("pause with sound");
  if (flags & 4) parts.push("active pause");
  if (flags & 8) parts.push("sim paused");
  return parts.join(" + ") || `unknown ${flags}`;
}
