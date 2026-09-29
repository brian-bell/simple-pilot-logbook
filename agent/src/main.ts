/**
 * Simple Pilot Logbook – local agent entry point.
 *
 * Watches MSFS through SimConnect (SimConnectWorker), queues flight events in a
 * local SQLite outbox, and ships them to the Cloudflare Worker (Sender). A
 * heartbeat carrying the live status goes out every HEARTBEAT_SECONDS.
 *
 *   npm run build && npm start          run in the foreground, Ctrl+C to stop
 *   install_service.ps1 (repo root)     run as the SimplePilotLogbook Windows service
 *
 * Configuration lives in agent/.env — see .env.example.
 */

import { ConfigError, loadConfig, type Config } from "./config.js";
import { heartbeatEvent } from "./events.js";
import { getLogger, setupLogging } from "./log.js";
import { Outbox } from "./outbox.js";
import { Sender } from "./sender.js";
import { SimConnectWorker } from "./simconnect_worker.js";

const log = getLogger("agent");

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      // No log file yet: stderr ends up in the console or the service's .err.log.
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}

async function main(): Promise<void> {
  const cfg = readConfig();
  setupLogging(cfg.logPath);
  log.info(`Agent starting (Node ${process.version}). Worker: ${cfg.workerUrl}`);

  const outbox = new Outbox(cfg.outboxPath);
  const pending = outbox.pendingCount();
  if (pending) log.info(`${pending} event(s) waiting in the outbox from a previous run.`);

  const sender = new Sender(cfg, outbox);
  sender.start();

  const worker = new SimConnectWorker(cfg, (event) => {
    if (outbox.enqueue(event)) sender.wake();
  });
  worker.start();

  let beating = false;
  const beat = async (): Promise<void> => {
    if (beating) return; // never overlap heartbeats on a slow network
    beating = true;
    try {
      await sender.postNow(heartbeatEvent(worker.getStatus(), outbox.pendingCount()));
    } finally {
      beating = false;
    }
  };
  void beat();
  const heartbeatTimer = setInterval(() => void beat(), cfg.heartbeatSeconds * 1000);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info(`Agent stopping (${signal}).`);
    clearInterval(heartbeatTimer);
    worker.stop(); // queues a flight still in progress
    await Promise.race([sender.stop(), new Promise((resolve) => setTimeout(resolve, 5000))]);
    // Best-effort final heartbeat so the UI flips to offline immediately.
    await sender.postNow(
      heartbeatEvent({ connected: false, state: "DISCONNECTED", on_ground: false, paused: false, current_flight: null }, outbox.pendingCount()),
      3000,
    );
    log.info(`Agent stopped. ${outbox.pendingCount()} event(s) still queued.`);
    outbox.close();
    process.exit(0);
  };

  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

process.on("unhandledRejection", (reason) => {
  log.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  log.error("Uncaught exception; exiting so the service manager restarts the agent:", err);
  process.exit(1);
});

main().catch((err) => {
  log.error("Agent failed to start:", err);
  console.error(err);
  process.exit(1);
});
