/**
 * Minimal logger: rotating file (1 MB x 3 backups, like the old Python agent)
 * plus stdout when a console is attached. No dependencies.
 *
 * Line format matches the old agent.log so existing habits (grep, tail) keep working:
 *   2026-09-26 00:18:56,141  WARNING  simconnect  message
 */

import fs from "node:fs";
import path from "node:path";

type Level = "DEBUG" | "INFO" | "WARNING" | "ERROR";

const LEVEL_RANK: Record<Level, number> = { DEBUG: 10, INFO: 20, WARNING: 30, ERROR: 40 };
const MAX_BYTES = 1_000_000;
const BACKUP_COUNT = 3;

let logPath: string | null = null;
let currentSize = 0;
let minLevel: Level = "INFO";
const toConsole = Boolean(process.stdout.isTTY);

export function setupLogging(filePath: string, level: Level = "INFO"): void {
  logPath = filePath;
  minLevel = level;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  try {
    currentSize = fs.statSync(filePath).size;
  } catch {
    currentSize = 0;
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function timestamp(d = new Date()): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())},${pad(d.getMilliseconds(), 3)}`
  );
}

function rotate(file: string): void {
  for (let i = BACKUP_COUNT - 1; i >= 1; i--) {
    const src = `${file}.${i}`;
    if (fs.existsSync(src)) fs.renameSync(src, `${file}.${i + 1}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
  currentSize = 0;
}

function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  if (typeof arg === "string") return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function write(level: Level, name: string, parts: unknown[]): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  const line = `${timestamp()}  ${level.padEnd(7)}  ${name}  ${parts.map(formatArg).join(" ")}\n`;
  if (toConsole) process.stdout.write(line);
  if (!logPath) return;
  try {
    const bytes = Buffer.byteLength(line);
    if (currentSize + bytes > MAX_BYTES) rotate(logPath);
    fs.appendFileSync(logPath, line, "utf8");
    currentSize += bytes;
  } catch (err) {
    // Logging must never take the agent down; fall back to stderr once per failure.
    process.stderr.write(`log write failed: ${String(err)}\n${line}`);
  }
}

export interface Logger {
  debug(...parts: unknown[]): void;
  info(...parts: unknown[]): void;
  warn(...parts: unknown[]): void;
  error(...parts: unknown[]): void;
}

export function getLogger(name: string): Logger {
  return {
    debug: (...parts) => write("DEBUG", name, parts),
    info: (...parts) => write("INFO", name, parts),
    warn: (...parts) => write("WARNING", name, parts),
    error: (...parts) => write("ERROR", name, parts),
  };
}
