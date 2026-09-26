/**
 * Agent configuration.
 *
 * Values come from agent/.env (next to the code, never the current working
 * directory, because the Windows service starts with a different cwd) and may
 * be overridden by real environment variables of the same name.
 *
 * Required
 *   WORKER_URL          https://simple-pilot-logbook.<account>.workers.dev
 *   AGENT_TOKEN         bearer token matching the Worker's AGENT_TOKEN secret
 *
 * Optional
 *   HEARTBEAT_SECONDS   default 10
 *   POSITION_SECONDS    default 10   (flight.position cadence while airborne)
 *   BATCH_SIZE          default 20   (the Worker rejects more than 20 events per request)
 *   OUTBOX_PATH         default agent/outbox.db
 *   LOG_PATH            default agent/agent.log
 *   SIMCONNECT_HOST     force a TCP SimConnect endpoint (with SIMCONNECT_PORT)
 *   SIMCONNECT_PORT
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** agent/ — compiled files live in agent/dist, sources in agent/src. */
export const AGENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const ENV_PATH = path.join(AGENT_DIR, ".env");

/** Hard upper bound enforced by the Worker (worker/src/events.ts MAX_EVENTS). */
export const MAX_BATCH_SIZE = 20;

export interface Config {
  workerUrl: string;
  agentToken: string;
  heartbeatSeconds: number;
  positionSeconds: number;
  batchSize: number;
  outboxPath: string;
  logPath: string;
  simconnectHost: string | null;
  simconnectPort: number | null;
}

/** Thrown for incomplete or invalid settings; main.ts prints the message and exits. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/**
 * Parse a minimal KEY=VALUE file. Blank lines and lines starting with '#' are
 * ignored; matching surrounding quotes are stripped from values.
 */
export function readEnvFile(filePath: string): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return values;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

export function loadConfig(envPath: string = ENV_PATH): Config {
  const fileValues = readEnvFile(envPath);
  const get = (key: string): string | undefined => process.env[key] ?? fileValues[key];

  const workerUrl = (get("WORKER_URL") ?? "").trim().replace(/\/+$/, "");
  const agentToken = (get("AGENT_TOKEN") ?? "").trim();

  const missing = [
    ["WORKER_URL", workerUrl],
    ["AGENT_TOKEN", agentToken],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new ConfigError(
      `Missing required setting(s): ${missing.join(", ")}. ` +
        `Create ${envPath} from .env.example or set them as environment variables.`,
    );
  }
  if (!/^https?:\/\//.test(workerUrl)) {
    throw new ConfigError(`WORKER_URL must start with http:// or https:// (got ${JSON.stringify(workerUrl)}).`);
  }

  const getNumber = (key: string, fallback: number, minimum: number): number => {
    const raw = get(key);
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new ConfigError(`${key} must be a number (got ${JSON.stringify(raw)}).`);
    return Math.max(minimum, value);
  };

  const simconnectHost = (get("SIMCONNECT_HOST") ?? "").trim() || null;
  const rawPort = (get("SIMCONNECT_PORT") ?? "").trim();
  let simconnectPort: number | null = null;
  if (rawPort) {
    simconnectPort = Number.parseInt(rawPort, 10);
    if (!Number.isInteger(simconnectPort) || simconnectPort <= 0 || simconnectPort > 65535) {
      throw new ConfigError(`SIMCONNECT_PORT must be a TCP port number (got ${JSON.stringify(rawPort)}).`);
    }
  }
  if ((simconnectHost === null) !== (simconnectPort === null)) {
    throw new ConfigError("Set both SIMCONNECT_HOST and SIMCONNECT_PORT, or neither.");
  }

  return {
    workerUrl,
    agentToken,
    heartbeatSeconds: getNumber("HEARTBEAT_SECONDS", 10, 2),
    positionSeconds: getNumber("POSITION_SECONDS", 10, 2),
    batchSize: Math.trunc(Math.min(MAX_BATCH_SIZE, getNumber("BATCH_SIZE", MAX_BATCH_SIZE, 1))),
    outboxPath: get("OUTBOX_PATH") || path.join(AGENT_DIR, "outbox.db"),
    logPath: get("LOG_PATH") || path.join(AGENT_DIR, "agent.log"),
    simconnectHost,
    simconnectPort,
  };
}
