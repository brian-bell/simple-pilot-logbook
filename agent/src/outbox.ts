/**
 * SQLite outbox (agent/outbox.db).
 *
 * Events are written locally first and deleted only after the Worker has
 * acknowledged them, so nothing is lost while the PC is offline or the Worker
 * is unreachable. Heartbeats never go through here.
 *
 * The schema is identical to the Python agent's, so an existing outbox.db keeps
 * draining after the upgrade. Node runs this on one thread, so a single
 * connection owned by this class is enough (no cross-thread sharing).
 */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AgentEvent } from "./events.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS outbox (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id   TEXT    NOT NULL UNIQUE,
    type       TEXT    NOT NULL,
    body       TEXT    NOT NULL,               -- full event JSON
    created_at TEXT    NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    dead       INTEGER NOT NULL DEFAULT 0      -- 1 = rejected by the Worker as invalid, never retried
);
CREATE INDEX IF NOT EXISTS idx_outbox_dead_seq ON outbox (dead, seq);
`;

export interface OutboxRow {
  seq: number;
  event_id: string;
  type: string;
  body: string;
  attempts: number;
}

export class Outbox {
  private readonly db: DatabaseSync;

  constructor(readonly filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  private transaction(fn: () => void): void {
    this.db.exec("BEGIN");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Store an event. Returns false when an event with the same id is already queued. */
  enqueue(event: AgentEvent): boolean {
    const body = JSON.stringify(event);
    const result = this.db
      .prepare("INSERT OR IGNORE INTO outbox (event_id, type, body, created_at) VALUES (?, ?, ?, ?)")
      .run(event.id, event.type, body, event.ts || new Date().toISOString());
    return Number(result.changes) > 0;
  }

  nextBatch(limit: number): OutboxRow[] {
    return this.db
      .prepare("SELECT seq, event_id, type, body, attempts FROM outbox WHERE dead = 0 ORDER BY seq LIMIT ?")
      .all(Math.trunc(limit)) as unknown as OutboxRow[];
  }

  ack(seqs: number[]): void {
    if (!seqs.length) return;
    const stmt = this.db.prepare("DELETE FROM outbox WHERE seq = ?");
    this.transaction(() => seqs.forEach((s) => stmt.run(s)));
  }

  fail(seqs: number[], error: string): void {
    if (!seqs.length) return;
    const stmt = this.db.prepare("UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?");
    this.transaction(() => seqs.forEach((s) => stmt.run(error.slice(0, 500), s)));
  }

  markDead(seqs: number[], error: string): void {
    if (!seqs.length) return;
    const stmt = this.db.prepare(
      "UPDATE outbox SET dead = 1, attempts = attempts + 1, last_error = ? WHERE seq = ?",
    );
    this.transaction(() => seqs.forEach((s) => stmt.run(error.slice(0, 500), s)));
  }

  pendingCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE dead = 0").get() as { n: number };
    return Number(row.n);
  }

  /**
   * Drop stale flight.position rows and excess dead rows.
   * Landings are never pruned. Returns the number of rows removed.
   */
  prune(positionMaxAgeDays = 7, deadKeep = 1000): number {
    const cutoff = new Date(Date.now() - positionMaxAgeDays * 86_400_000).toISOString();
    let removed = 0;
    this.transaction(() => {
      removed += Number(
        this.db.prepare("DELETE FROM outbox WHERE type = 'flight.position' AND created_at < ?").run(cutoff).changes,
      );
      removed += Number(
        this.db
          .prepare(
            "DELETE FROM outbox WHERE dead = 1 AND seq NOT IN " +
              "(SELECT seq FROM outbox WHERE dead = 1 ORDER BY seq DESC LIMIT ?)",
          )
          .run(Math.trunc(deadKeep)).changes,
      );
    });
    return removed;
  }
}
