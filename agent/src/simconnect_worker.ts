/**
 * Glue between the SimConnect client and the flight detector.
 *
 * The client pushes samples and sim events; the detector turns them into flight
 * events, which go to `onEvent` (the outbox). A 1 s timer drives the detector's
 * time-based transitions even when the sim stops sending data (paused).
 * No network I/O happens here; only sender.ts talks to the Worker.
 */

import type { Config } from "./config.js";
import type { AgentEvent, AgentStatus } from "./events.js";
import { FlightDetector } from "./flight_detector.js";
import { getLogger } from "./log.js";
import { SimConnectClient } from "./simconnect_client.js";

const log = getLogger("flight");

export class SimConnectWorker {
  private readonly detector: FlightDetector;
  private readonly client: SimConnectClient;
  private ticker: NodeJS.Timeout | null = null;

  constructor(cfg: Config, onEvent: (event: AgentEvent) => void) {
    this.detector = new FlightDetector({
      positionSeconds: cfg.positionSeconds,
      log,
      emit: (event) => {
        try {
          onEvent(event);
        } catch (err) {
          // A queuing problem must never kill flight detection.
          log.error(`Failed to queue ${event.type} event:`, err);
        }
      },
    });

    this.client = new SimConnectClient(cfg, {
      connected: (info) => this.detector.connected(info),
      disconnected: (reason) => this.detector.disconnected(reason),
      state: (sample) => this.detector.state(sample),
      frame: (sample) => this.detector.frame(sample),
      aircraft: (update) => this.detector.aircraftUpdate(update),
      systemEvent: (event) => this.detector.systemEvent(event),
    });
  }

  start(): void {
    this.client.start();
    this.ticker = setInterval(() => {
      try {
        this.detector.tick();
      } catch (err) {
        log.error("Flight detector tick failed:", err);
      }
    }, 1000);
  }

  /** Stops SimConnect and queues a flight still in progress. */
  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    this.client.stop();
    this.detector.shutdown();
  }

  getStatus(): AgentStatus {
    return this.detector.status();
  }
}
