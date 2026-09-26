/**
 * SimConnect client built on node-simconnect (pure SimConnect protocol over a
 * named pipe or TCP; no SimConnect.dll or SDK needed).
 *
 * Responsibilities
 * - find the sim's SimConnect endpoint and (re)connect every 5 s while it is closed
 * - register the data definitions and system events the flight detector needs
 * - decode incoming packets into plain samples and hand them to callbacks
 *
 * It never talks to the Worker and never throws into its caller: every callback
 * is wrapped, and connection problems end in `disconnected()` plus a retry.
 */

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  DataRequestFlag,
  Protocol,
  SimConnectConnection,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectPeriod,
  type ConnectionOptions,
  type RawBuffer,
  type RecvException,
  type RecvOpen,
} from "node-simconnect";
import type { Config } from "./config.js";
import { getLogger } from "./log.js";

const log = getLogger("simconnect");

const APP_NAME = "Simple Pilot Logbook";
const OPEN_TIMEOUT_MS = 10_000;
const RETRY_MS = 5_000;
/** Reconnect when the sim says it is running and unpaused but no 1 Hz sample arrived for this long. */
const STALL_MS = 120_000;
/** Repeat the "still waiting for MSFS" line at most this often. */
const WAIT_LOG_EVERY_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** 1 Hz snapshot of the user aircraft. `mono` is performance.now() at receipt. */
export interface StateSample {
  mono: number;
  onGround: boolean | null;
  lat: number | null;
  lon: number | null;
  altitudeFt: number | null;
  altAglFt: number | null;
  vsFpm: number | null;
  groundSpeedKt: number | null;
  gForce: number | null;
  cameraState: number | null;
  slew: boolean | null;
  simRate: number | null;
  touchdownNormalFps: number | null;
}

/** Per-visual-frame data, sent only when G force (> 0.05), on-ground or touchdown velocity change. */
export interface FrameSample {
  mono: number;
  gForce: number | null;
  onGround: boolean | null;
  touchdownNormalFps: number | null;
}

export interface AircraftUpdate {
  title?: string | null;
  atcId?: string | null;
  livery?: string | null;
}

export interface SimInfo {
  /** "MSFS 2024", "MSFS 2020" or the raw application name. */
  label: string;
  applicationName: string;
  version: string;
  simconnectVersion: string;
  protocol: string;
  endpoint: string;
}

export type SimSystemEvent =
  | { kind: "sim"; running: boolean }
  | { kind: "pause"; flags: number }
  | { kind: "crashed" }
  | { kind: "crashReset" }
  | { kind: "flightLoaded"; file: string }
  | { kind: "aircraftLoaded"; file: string };

export interface SimConnectHandlers {
  connected(info: SimInfo): void;
  disconnected(reason: string): void;
  state(sample: StateSample): void;
  frame(sample: FrameSample): void;
  aircraft(update: AircraftUpdate): void;
  systemEvent(event: SimSystemEvent): void;
}

// ---------------------------------------------------------------------------
// Data definitions
// ---------------------------------------------------------------------------

type FieldKind = "f64" | "i32" | "s64" | "s256";

interface FieldSpec {
  key: string;
  name: string;
  units: string | null;
  kind: FieldKind;
  epsilon?: number;
}

interface FieldState extends FieldSpec {
  sendId: number;
  failed: boolean;
}

const enum DefId {
  STATE = 1,
  AIRCRAFT = 2,
  LIVERY = 3,
  TOUCHDOWN = 4,
}

const enum EventId {
  SIM = 1,
  PAUSE_EX1 = 2,
  CRASHED = 3,
  CRASH_RESET = 4,
  FLIGHT_LOADED = 5,
  AIRCRAFT_LOADED = 6,
}

const SYSTEM_EVENTS: Array<[EventId, string]> = [
  [EventId.SIM, "Sim"],
  [EventId.PAUSE_EX1, "Pause_EX1"],
  [EventId.CRASHED, "Crashed"],
  [EventId.CRASH_RESET, "CrashReset"],
  [EventId.FLIGHT_LOADED, "FlightLoaded"],
  [EventId.AIRCRAFT_LOADED, "AircraftLoaded"],
];

interface DefinitionSpec {
  id: DefId;
  label: string;
  period: SimConnectPeriod;
  flags: DataRequestFlag;
  fields: FieldSpec[];
}

const DEFINITIONS: DefinitionSpec[] = [
  {
    id: DefId.STATE,
    label: "state",
    period: SimConnectPeriod.SECOND,
    flags: DataRequestFlag.DATA_REQUEST_FLAG_DEFAULT,
    fields: [
      { key: "onGround", name: "SIM ON GROUND", units: "Bool", kind: "i32" },
      { key: "lat", name: "PLANE LATITUDE", units: "Degrees", kind: "f64" },
      { key: "lon", name: "PLANE LONGITUDE", units: "Degrees", kind: "f64" },
      { key: "altitudeFt", name: "PLANE ALTITUDE", units: "Feet", kind: "f64" },
      { key: "altAglFt", name: "PLANE ALT ABOVE GROUND", units: "Feet", kind: "f64" },
      { key: "vsFpm", name: "VERTICAL SPEED", units: "Feet per minute", kind: "f64" },
      { key: "groundSpeedKt", name: "GROUND VELOCITY", units: "Knots", kind: "f64" },
      { key: "gForce", name: "G FORCE", units: "GForce", kind: "f64" },
      { key: "cameraState", name: "CAMERA STATE", units: "Enum", kind: "i32" },
      { key: "slew", name: "IS SLEW ACTIVE", units: "Bool", kind: "i32" },
      { key: "simRate", name: "SIMULATION RATE", units: "Number", kind: "f64" },
      { key: "touchdownNormalFps", name: "PLANE TOUCHDOWN NORMAL VELOCITY", units: "Feet per second", kind: "f64" },
    ],
  },
  {
    id: DefId.AIRCRAFT,
    label: "aircraft",
    period: SimConnectPeriod.SECOND,
    flags: DataRequestFlag.DATA_REQUEST_FLAG_CHANGED,
    fields: [
      { key: "title", name: "TITLE", units: null, kind: "s256" },
      { key: "atcId", name: "ATC ID", units: null, kind: "s64" },
    ],
  },
  {
    // MSFS 2024 only; its own definition so an unknown name cannot shift the others.
    id: DefId.LIVERY,
    label: "livery",
    period: SimConnectPeriod.SECOND,
    flags: DataRequestFlag.DATA_REQUEST_FLAG_CHANGED,
    fields: [{ key: "livery", name: "LIVERY NAME", units: null, kind: "s256" }],
  },
  {
    id: DefId.TOUCHDOWN,
    label: "touchdown",
    period: SimConnectPeriod.VISUAL_FRAME,
    flags: DataRequestFlag.DATA_REQUEST_FLAG_CHANGED,
    fields: [
      { key: "gForce", name: "G FORCE", units: "GForce", kind: "f64", epsilon: 0.05 },
      { key: "onGround", name: "SIM ON GROUND", units: "Bool", kind: "i32" },
      {
        key: "touchdownNormalFps",
        name: "PLANE TOUCHDOWN NORMAL VELOCITY",
        units: "Feet per second",
        kind: "f64",
        epsilon: 0.01,
      },
    ],
  },
];

const DATA_TYPE: Record<FieldKind, SimConnectDataType> = {
  f64: SimConnectDataType.FLOAT64,
  i32: SimConnectDataType.INT32,
  s64: SimConnectDataType.STRING64,
  s256: SimConnectDataType.STRING256,
};

const STRING_BYTES: Partial<Record<FieldKind, number>> = { s64: 64, s256: 256 };

/** Fixed-size SimConnect strings are NUL-padded UTF-8. */
function readFixedString(buf: RawBuffer, bytes: number): string {
  const raw = buf.readBytes(bytes);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8").trim();
}

function readFields(buf: RawBuffer, fields: FieldState[]): Record<string, number | string | null> {
  const out: Record<string, number | string | null> = {};
  for (const field of fields) {
    if (field.failed) {
      out[field.key] = null; // the sim rejected this datum, so it is absent from the packet
      continue;
    }
    switch (field.kind) {
      case "f64":
        out[field.key] = buf.readFloat64();
        break;
      case "i32":
        out[field.key] = buf.readInt32();
        break;
      default:
        out[field.key] = readFixedString(buf, STRING_BYTES[field.kind] ?? 256);
    }
  }
  return out;
}

const num = (v: number | string | null | undefined): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const bool = (v: number | string | null | undefined): boolean | null => (typeof v === "number" ? v !== 0 : null);
const str = (v: number | string | null | undefined): string | null => (typeof v === "string" && v ? v : null);

// ---------------------------------------------------------------------------
// Endpoint discovery
// ---------------------------------------------------------------------------

interface Endpoint {
  label: string;
  /** undefined = node-simconnect auto-detection (SimConnect.cfg, the named pipe, then the registry port). */
  options?: ConnectionOptions;
}

/**
 * SimConnect.xml files MSFS 2024 writes. Under the Windows service (LocalSystem)
 * %APPDATA% and %LOCALAPPDATA% are the system profile, so every user profile is checked too.
 */
function simConnectXmlCandidates(): string[] {
  const rel = path.join("Microsoft Flight Simulator 2024", "SimConnect.xml");
  const storeRel = path.join("Packages", "Microsoft.Limitless_8wekyb3d8bbwe", "LocalCache", "SimConnect.xml");
  const candidates = new Set<string>();
  if (process.env.APPDATA) candidates.add(path.join(process.env.APPDATA, rel));
  if (process.env.LOCALAPPDATA) {
    candidates.add(path.join(process.env.LOCALAPPDATA, storeRel));
  }
  const usersDir = path.join(process.env.SystemDrive ?? "C:", "\\", "Users");
  try {
    for (const entry of fs.readdirSync(usersDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      candidates.add(path.join(usersDir, entry.name, "AppData", "Roaming", rel));
      candidates.add(path.join(usersDir, entry.name, "AppData", "Local", storeRel));
    }
  } catch {
    // no access to C:\Users; the env-based candidates remain
  }
  return [...candidates];
}

/** Static, local IPv4 ports declared in SimConnect.xml (port 0 means dynamic and is skipped). */
function staticIpv4Ports(): number[] {
  const ports = new Set<number>();
  for (const file of simConnectXmlCandidates()) {
    let xml: string;
    try {
      xml = fs.readFileSync(file, "latin1");
    } catch {
      continue;
    }
    for (const block of xml.match(/<SimConnect\.Comm>[\s\S]*?<\/SimConnect\.Comm>/gi) ?? []) {
      const protocol = /<Protocol>\s*([^<]+?)\s*<\/Protocol>/i.exec(block)?.[1];
      const port = Number.parseInt(/<Port>\s*([^<]+?)\s*<\/Port>/i.exec(block)?.[1] ?? "", 10);
      if (protocol?.toUpperCase() === "IPV4" && Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
    }
  }
  return [...ports];
}

async function resolveEndpoints(cfg: Config): Promise<Endpoint[]> {
  if (cfg.simconnectHost && cfg.simconnectPort) {
    return [
      {
        label: `TCP ${cfg.simconnectHost}:${cfg.simconnectPort} (from .env)`,
        options: { host: cfg.simconnectHost, port: cfg.simconnectPort },
      },
    ];
  }
  // Auto-detection always goes first: it covers SimConnect.cfg and the registry port even when no pipe is visible.
  const endpoints: Endpoint[] = [{ label: "auto-detect (SimConnect.cfg, named pipe, registry port)" }];
  for (const port of staticIpv4Ports()) {
    endpoints.push({ label: `TCP 127.0.0.1:${port} (SimConnect.xml)`, options: { host: "127.0.0.1", port } });
  }
  return endpoints;
}

function simLabel(open: RecvOpen): string {
  switch (open.applicationVersionMajor) {
    case 12:
      return "MSFS 2024";
    case 11:
      return "MSFS 2020";
    default:
      return open.applicationName || `SimConnect app v${open.applicationVersionMajor}`;
  }
}

/** Connection failures that mean "nothing is listening", as opposed to a protocol problem. */
function isNotRunningError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "ECONNREFUSED" || code === "ENOENT" || code === "EPIPE" || code === "ECONNRESET";
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class SimConnectClient {
  private conn: SimConnectConnection | null = null;
  private stopped = true;
  private retryTimer: NodeJS.Timeout | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private definitions = new Map<DefId, FieldState[]>();
  private sendLabels = new Map<number, string>();
  private lastStateMono = 0;
  private simRunning: boolean | null = null;
  private pauseFlags = 0;
  private waitingSince: number | null = null;
  private lastWaitLog = 0;
  private attempts = 0;

  constructor(
    private readonly cfg: Config,
    private readonly handlers: SimConnectHandlers,
  ) {}

  start(): void {
    this.stopped = false;
    this.scheduleConnect(0);
    this.watchdog = setInterval(() => this.checkStall(), 10_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.retryTimer = this.watchdog = null;
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      try {
        conn.close();
      } catch {
        // ignore
      }
    }
  }

  // ------------------------------------------------------------------
  // Connecting
  // ------------------------------------------------------------------

  private scheduleConnect(delayMs: number): void {
    if (this.stopped) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connectCycle().catch((err) => {
        log.error("Unexpected error while connecting to SimConnect:", err);
        this.scheduleConnect(RETRY_MS);
      });
    }, delayMs);
  }

  private async connectCycle(): Promise<void> {
    if (this.stopped || this.conn) return;
    this.attempts += 1;
    const endpoints = await resolveEndpoints(this.cfg);
    const failures: string[] = [];

    for (const endpoint of endpoints) {
      for (const protocol of [Protocol.SunRise, Protocol.KittyHawk]) {
        try {
          const { conn, recvOpen } = await this.tryOpen(endpoint, protocol);
          if (this.stopped) {
            conn.close();
            return;
          }
          this.onOpened(conn, recvOpen, endpoint, protocol);
          return;
        } catch (err) {
          failures.push(`${endpoint.label} [${Protocol[protocol]}]: ${(err as Error).message}`);
          if (isNotRunningError(err)) break; // nothing listening: the older protocol will not help
        }
      }
    }

    this.logWaiting(failures.join("; "));
    this.scheduleConnect(RETRY_MS);
  }

  private logWaiting(reason: string): void {
    const now = Date.now();
    if (this.waitingSince === null) {
      this.waitingSince = now;
      this.lastWaitLog = now;
      log.info(`MSFS not reachable (${reason}). Retrying every ${RETRY_MS / 1000} s.`);
    } else if (now - this.lastWaitLog >= WAIT_LOG_EVERY_MS) {
      this.lastWaitLog = now;
      const minutes = Math.round((now - this.waitingSince) / 60_000);
      log.info(`Still waiting for MSFS (${minutes} min, ${this.attempts} attempts). Last result: ${reason}`);
    }
  }

  private tryOpen(endpoint: Endpoint, protocol: Protocol): Promise<{ conn: SimConnectConnection; recvOpen: RecvOpen }> {
    const conn = new SimConnectConnection(APP_NAME, protocol);
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          conn.close();
        } catch {
          // ignore
        }
        reject(err);
      };
      const timer = setTimeout(() => fail(new Error("open timed out")), OPEN_TIMEOUT_MS);

      conn.once("open", (recvOpen) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ conn, recvOpen });
      });
      // Permanent listeners: an unhandled 'error' on an EventEmitter would crash the process.
      conn.on("error", (err) => {
        if (!settled) fail(err);
        else this.onConnectionLost(conn, `connection error: ${err.message}`);
      });
      conn.on("close", () => {
        if (!settled) fail(new Error("connection closed during open"));
        else this.onConnectionLost(conn, "connection closed");
      });
      conn.once("exception", (ex) => {
        if (!settled) fail(new Error(`SimConnect exception during open: ${ex.exceptionName}`));
      });

      try {
        conn.connect(endpoint.options);
      } catch (err) {
        fail(err as Error);
      }
    });
  }

  private onOpened(conn: SimConnectConnection, open: RecvOpen, endpoint: Endpoint, protocol: Protocol): void {
    this.conn = conn;
    this.waitingSince = null;
    this.attempts = 0;
    this.simRunning = null;
    this.pauseFlags = 0;
    this.lastStateMono = performance.now();

    const info: SimInfo = {
      label: simLabel(open),
      applicationName: open.applicationName,
      version: [
        open.applicationVersionMajor,
        open.applicationVersionMinor,
        open.applicationBuildMajor,
        open.applicationBuildMinor,
      ].join("."),
      simconnectVersion: [
        open.simConnectVersionMajor,
        open.simConnectVersionMinor,
        open.simConnectBuildMajor,
        open.simConnectBuildMinor,
      ].join("."),
      protocol: Protocol[protocol] ?? String(protocol),
      endpoint: endpoint.label,
    };
    log.info(
      `Connected to ${info.label} via ${info.endpoint} ` +
        `(${info.applicationName} ${info.version}, SimConnect ${info.simconnectVersion}, protocol ${info.protocol}).`,
    );

    conn.on("exception", (ex) => this.onException(ex));
    conn.on("quit", () => this.onConnectionLost(conn, "simulator quit"));
    conn.on("event", (ev) => this.onEvent(ev.clientEventId, ev.data));
    conn.on("eventFilename", (ev) => this.onFilenameEvent(ev.clientEventId, ev.fileName));
    conn.on("simObjectData", (data) => this.onData(data.requestID, data.data));

    try {
      this.register(conn);
    } catch (err) {
      log.error("Failed to register SimConnect requests:", err);
      this.onConnectionLost(conn, "registration failed");
      return;
    }
    this.safe(() => this.handlers.connected(info));
  }

  private register(conn: SimConnectConnection): void {
    this.definitions.clear();
    this.sendLabels.clear();

    for (const [id, name] of SYSTEM_EVENTS) {
      this.sendLabels.set(conn.subscribeToSystemEvent(id, name), `subscribe ${name}`);
    }

    for (const def of DEFINITIONS) {
      const states: FieldState[] = [];
      def.fields.forEach((field, index) => {
        const sendId = conn.addToDataDefinition(def.id, field.name, field.units, DATA_TYPE[field.kind], field.epsilon ?? 0);
        states.push({ ...field, sendId, failed: false });
        this.sendLabels.set(sendId, `${def.label}[${index}] ${field.name}`);
      });
      this.definitions.set(def.id, states);
      const requestSendId = conn.requestDataOnSimObject(
        def.id, // request id = definition id
        def.id,
        SimConnectConstants.OBJECT_ID_USER,
        def.period,
        def.flags,
      );
      this.sendLabels.set(requestSendId, `request ${def.label}`);
    }
  }

  private onConnectionLost(conn: SimConnectConnection, reason: string): void {
    if (this.conn !== conn) return; // stale connection or already handled
    this.conn = null;
    try {
      conn.close();
    } catch {
      // ignore
    }
    log.warn(`SimConnect disconnected: ${reason}.`);
    this.safe(() => this.handlers.disconnected(reason));
    this.scheduleConnect(RETRY_MS);
  }

  private checkStall(): void {
    const conn = this.conn;
    if (!conn || this.simRunning !== true || this.pauseFlags !== 0) return;
    const silentMs = performance.now() - this.lastStateMono;
    if (silentMs > STALL_MS) {
      this.onConnectionLost(conn, `no data for ${Math.round(silentMs / 1000)} s while the sim reports running`);
    }
  }

  // ------------------------------------------------------------------
  // Incoming packets
  // ------------------------------------------------------------------

  private onException(ex: RecvException): void {
    const label = this.sendLabels.get(ex.sendId);
    for (const fields of this.definitions.values()) {
      const field = fields.find((f) => f.sendId === ex.sendId);
      if (field) {
        field.failed = true;
        log.warn(`SimConnect ${ex.exceptionName} for ${label}; the value will be reported as missing.`);
        return;
      }
    }
    log.warn(`SimConnect exception ${ex.exceptionName}${label ? ` for ${label}` : ""} (send id ${ex.sendId}, index ${ex.index}).`);
  }

  private onEvent(id: number, data: number): void {
    switch (id) {
      case EventId.SIM:
        this.simRunning = data === 1;
        this.emitEvent({ kind: "sim", running: data === 1 });
        break;
      case EventId.PAUSE_EX1:
        this.pauseFlags = data;
        this.emitEvent({ kind: "pause", flags: data });
        break;
      case EventId.CRASHED:
        this.emitEvent({ kind: "crashed" });
        break;
      case EventId.CRASH_RESET:
        this.emitEvent({ kind: "crashReset" });
        break;
      default:
        break;
    }
  }

  private onFilenameEvent(id: number, file: string): void {
    const clean = (file ?? "").replace(/\0/g, "").trim();
    if (id === EventId.FLIGHT_LOADED) this.emitEvent({ kind: "flightLoaded", file: clean });
    else if (id === EventId.AIRCRAFT_LOADED) this.emitEvent({ kind: "aircraftLoaded", file: clean });
  }

  private emitEvent(event: SimSystemEvent): void {
    this.safe(() => this.handlers.systemEvent(event));
  }

  private onData(requestId: number, buf: RawBuffer): void {
    const fields = this.definitions.get(requestId as DefId);
    if (!fields) return;
    let v: Record<string, number | string | null>;
    try {
      v = readFields(buf, fields);
    } catch (err) {
      log.warn(`Could not decode SimConnect data for request ${requestId}: ${(err as Error).message}`);
      return;
    }
    const mono = performance.now();

    switch (requestId) {
      case DefId.STATE:
        this.lastStateMono = mono;
        this.safe(() =>
          this.handlers.state({
            mono,
            onGround: bool(v.onGround),
            lat: num(v.lat),
            lon: num(v.lon),
            altitudeFt: num(v.altitudeFt),
            altAglFt: num(v.altAglFt),
            vsFpm: num(v.vsFpm),
            groundSpeedKt: num(v.groundSpeedKt),
            gForce: num(v.gForce),
            cameraState: num(v.cameraState),
            slew: bool(v.slew),
            simRate: num(v.simRate),
            touchdownNormalFps: num(v.touchdownNormalFps),
          }),
        );
        break;
      case DefId.AIRCRAFT:
        this.safe(() => this.handlers.aircraft({ title: str(v.title), atcId: str(v.atcId) }));
        break;
      case DefId.LIVERY:
        this.safe(() => this.handlers.aircraft({ livery: str(v.livery) }));
        break;
      case DefId.TOUCHDOWN:
        this.safe(() =>
          this.handlers.frame({
            mono,
            gForce: num(v.gForce),
            onGround: bool(v.onGround),
            touchdownNormalFps: num(v.touchdownNormalFps),
          }),
        );
        break;
      default:
        break;
    }
  }

  /** A handler bug must never break the SimConnect connection. */
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.error("SimConnect handler failed:", err);
    }
  }
}
