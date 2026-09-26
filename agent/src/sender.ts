/**
 * Delivers events to the Worker's POST /api/events.
 *
 * Sender      background loop that drains the outbox in batches with retry/backoff.
 * postNow()   fire-and-forget single-event POST used for heartbeats (never queued).
 * postJson()  the one HTTP call (global fetch, no third-party dependency).
 *
 * Tokens are never logged; only HTTP status codes and response snippets are.
 */

import type { Config } from "./config.js";
import type { AgentEvent } from "./events.js";
import { getLogger } from "./log.js";
import type { Outbox, OutboxRow } from "./outbox.js";

const log = getLogger("sender");

const USER_AGENT = "simple-pilot-logbook-agent/3.0";
const MAX_BACKOFF_SECONDS = 300;
const TOKEN_RETRY_SECONDS = 60;
const PRUNE_EVERY_IDLE_WAITS = 720; // roughly hourly while idle (5 s waits)

/**
 * POST `body` as JSON to <WORKER_URL>/api/events.
 * Returns [status, snippet]; status 0 means the request never completed
 * (DNS, connection, TLS or timeout error).
 */
export async function postJson(cfg: Config, body: unknown, timeoutMs: number): Promise<[number, string]> {
  try {
    const response = await fetch(`${cfg.workerUrl}/api/events`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.agentToken}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let text = "";
    try {
      text = (await response.text()).slice(0, 2048);
    } catch {
      // best effort only
    }
    return [response.status, text];
  } catch (err) {
    // fetch wraps network errors as "TypeError: fetch failed"; the cause says why.
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const why = e.cause?.code ?? e.cause?.message;
    return [0, why ? `${e.message} (${why})` : `${e.name}: ${e.message}`];
  }
}

/** A resettable, awaitable flag (the Node counterpart of threading.Event + wait(timeout)). */
class Signal {
  private waiter: (() => void) | null = null;
  private flag = false;

  set(): void {
    this.flag = true;
    this.waiter?.();
  }

  /** Resolves true when set (and clears it), false after `ms`. */
  wait(ms: number): Promise<boolean> {
    if (this.flag) {
      this.flag = false;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        resolve(false);
      }, ms);
      this.waiter = () => {
        clearTimeout(timer);
        this.waiter = null;
        this.flag = false;
        resolve(true);
      };
    });
  }
}

export class Sender {
  private readonly wakeSignal = new Signal();
  /** Set only by stop(): backoff sleeps wait on this, so new events do not cut a backoff short. */
  private readonly stopSignal = new Signal();
  private stopped = false;
  private batchSize: number;
  private consecutiveFailures = 0;
  private pruneCountdown = 0;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly outbox: Outbox,
  ) {
    this.batchSize = Math.max(1, cfg.batchSize);
  }

  start(): void {
    this.loop = this.run().catch((err) => log.error("Sender loop crashed:", err));
  }

  /** Called by the producer after enqueue(). */
  wake(): void {
    this.wakeSignal.set();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopSignal.set();
    this.wakeSignal.set();
    await this.loop;
  }

  /** Send one event immediately without queuing (heartbeats). Never throws. */
  async postNow(event: AgentEvent, timeoutMs = 5000): Promise<boolean> {
    const [status, text] = await postJson(this.cfg, { events: [event] }, timeoutMs);
    const ok = status >= 200 && status < 300;
    if (!ok) log.debug(`postNow ${event.type} -> HTTP ${status} ${text.slice(0, 200)}`);
    return ok;
  }

  private async run(): Promise<void> {
    this.prune();
    while (!this.stopped) {
      const batch = this.outbox.nextBatch(this.batchSize);
      if (!batch.length) {
        await this.wakeSignal.wait(5000);
        if (++this.pruneCountdown >= PRUNE_EVERY_IDLE_WAITS) this.prune();
        continue;
      }
      const delaySeconds = await this.deliver(batch);
      if (delaySeconds > 0 && !this.stopped) await this.stopSignal.wait(delaySeconds * 1000);
    }
  }

  private prune(): void {
    this.pruneCountdown = 0;
    try {
      const removed = this.outbox.prune();
      if (removed) log.info(`Pruned ${removed} stale outbox row(s).`);
    } catch (err) {
      log.error("Outbox prune failed:", err);
    }
  }

  /** Send one batch. Returns how long to wait (seconds) before the next attempt (0 = go on). */
  private async deliver(batch: OutboxRow[]): Promise<number> {
    const seqs = batch.map((row) => row.seq);
    let events: AgentEvent[];
    try {
      events = batch.map((row) => JSON.parse(row.body) as AgentEvent);
    } catch (err) {
      this.outbox.markDead(seqs, `corrupt body: ${String(err)}`);
      log.error(`Dead-lettered ${seqs.length} corrupt outbox row(s): ${String(err)}`);
      return 0;
    }

    const [status, text] = await postJson(this.cfg, { events }, 15_000);

    if (status >= 200 && status < 300) {
      this.outbox.ack(seqs);
      this.consecutiveFailures = 0;
      // Grow back towards the configured size after a 413 or a rejected-batch shrink.
      this.batchSize = Math.min(this.cfg.batchSize, Math.max(1, this.batchSize * 2));
      log.info(`Delivered ${events.length} event(s): ${summarise(events)}`);
      return 0;
    }

    this.consecutiveFailures += 1;

    if (status === 400 || status === 422) {
      const errorBody = workerErrorBody(text);
      if (errorBody) return this.handleRejected(batch, status, text, errorBody);
      // A 400 that is not the Worker's JSON error (proxy, captive portal, edge
      // error page) says nothing about the events: treat it as transient below.
    }

    if (status === 413) {
      if (batch.length === 1) {
        this.outbox.markDead(seqs, text || "payload too large");
        log.error(`Event ${batch[0].event_id} is too large for the Worker (HTTP 413). Dead-lettered.`);
        return 0;
      }
      this.batchSize = Math.max(1, Math.floor(this.batchSize / 2));
      this.outbox.fail(seqs, text);
      log.warn(`Batch too large (HTTP 413); reducing batch size to ${this.batchSize}.`);
      return 1;
    }

    if (status === 401 || status === 403) {
      this.outbox.fail(seqs, "token rejected");
      log.error(
        `Worker rejected AGENT_TOKEN (HTTP ${status}). Check agent/.env. Retrying in ${TOKEN_RETRY_SECONDS} s.`,
      );
      return TOKEN_RETRY_SECONDS;
    }

    this.outbox.fail(seqs, text || "network error");
    const delay =
      Math.min(MAX_BACKOFF_SECONDS, 2 ** Math.min(this.consecutiveFailures, 8)) + Math.random();
    log.warn(
      `Delivery failed (${status ? `HTTP ${status}` : text.slice(0, 200)}). ` +
        `${this.outbox.pendingCount()} event(s) queued; retrying in ${Math.round(delay)} s.`,
    );
    return delay;
  }

  /**
   * The Worker validates a request atomically, so one malformed event fails the
   * whole batch. Dead-letter only the offending event and let the others retry.
   */
  private handleRejected(batch: OutboxRow[], status: number, text: string, errorBody: WorkerError): number {
    const index = errorBody.index;
    if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < batch.length) {
      const bad = batch[index];
      this.outbox.markDead([bad.seq], text);
      log.error(
        `Worker rejected event ${bad.event_id} as invalid (HTTP ${status}): ${text.slice(0, 300)}. ` +
          `Dead-lettered it; ${batch.length - 1} other event(s) in the batch will be retried.`,
      );
      return 0;
    }

    if (batch.length > 1) {
      this.batchSize = Math.max(1, Math.floor(batch.length / 2));
      this.outbox.fail(
        batch.map((row) => row.seq),
        text,
      );
      log.warn(
        `Worker rejected a ${batch.length}-event batch (HTTP ${status}) without naming the event: ` +
          `${text.slice(0, 200)}. Retrying in batches of ${this.batchSize} to isolate it.`,
      );
      return 0;
    }

    this.outbox.markDead([batch[0].seq], text);
    log.error(`Worker rejected event ${batch[0].event_id} as invalid (HTTP ${status}): ${text.slice(0, 300)}. Dead-lettered.`);
    return 0;
  }
}

interface WorkerError {
  error: string;
  index?: unknown;
}

/** The parsed body when it is the Worker's own validation error ({"error": "...", "index"?: n}). */
function workerErrorBody(text: string): WorkerError | null {
  try {
    const body = JSON.parse(text) as unknown;
    if (body && typeof body === "object" && !Array.isArray(body) && typeof (body as WorkerError).error === "string") {
      return body as WorkerError;
    }
  } catch {
    // not JSON
  }
  return null;
}

function summarise(events: AgentEvent[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.type ?? "?", (counts.get(e.type ?? "?") ?? 0) + 1);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k} x${v}`)
    .join(", ");
}
