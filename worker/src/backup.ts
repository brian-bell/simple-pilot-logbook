/**
 * Nightly D1 -> R2 backup (cron trigger in wrangler.jsonc).
 *
 * Each run writes:
 *   backups/YYYY-MM-DD/flights.csv  - the logbook, same format as GET /api/flights/export.csv
 *   backups/YYYY-MM-DD/flights.sql  - INSERT OR IGNORE statements for `flights`
 *   backups/events/events-NNNNNN.sql - INSERT OR IGNORE statements for `events`, one
 *                                      object per EVENT_CHUNK rowids
 * then deletes daily folders older than RETENTION_DAYS.
 *
 * The event log is append-only and grows without bound, so it is backed up
 * incrementally: a chunk is rewritten only while it is still filling, and a run
 * touches at most MAX_CHUNKS_PER_RUN chunks. That keeps every run well under the
 * free plan's 50 D1 queries per invocation however long the log gets; a backlog
 * (first run on a big database) catches up over the following nights. Event
 * chunks are never pruned. agent_status is live state rebuilt by the next
 * heartbeat, so it is not backed up.
 */

import { flightsCsv } from "./export";
import type { Env } from "./types";

const PREFIX = "backups/";
const EVENTS_PREFIX = `${PREFIX}events/`;
const RETENTION_DAYS = 30;
const EVENT_CHUNK = 5000;
const MAX_CHUNKS_PER_RUN = 20;
const FLIGHTS_PAGE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SQL_TYPE = { httpMetadata: { contentType: "application/sql; charset=utf-8" } };

export async function runBackup(env: Env, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const [csv, sql] = await Promise.all([flightsCsv(env), flightsSql(env)]);
  await Promise.all([
    env.BACKUPS.put(`${PREFIX}${day}/flights.csv`, csv, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
    }),
    env.BACKUPS.put(`${PREFIX}${day}/flights.sql`, sql, SQL_TYPE),
  ]);
  const chunks = await backupEvents(env);
  const pruned = await pruneOldBackups(env, now);
  console.log(`backup ${day}: ${csv.length} B csv, ${sql.length} B sql, ${chunks} event chunks, pruned ${pruned}`);
}

function sqlLiteral(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function insertLine(table: string, row: Record<string, unknown>): string {
  const cols = Object.keys(row);
  return (
    `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) ` +
    `VALUES (${cols.map((c) => sqlLiteral(row[c])).join(", ")});`
  );
}

/** The whole flights table (small: one row per flight), paged by id. */
async function flightsSql(env: Env): Promise<string> {
  const out = [`-- Simple Pilot Logbook flights backup ${new Date().toISOString()}`];
  let lastId = 0;
  for (;;) {
    const { results } = await env.DB.prepare("SELECT * FROM flights WHERE id > ?1 ORDER BY id LIMIT ?2")
      .bind(lastId, FLIGHTS_PAGE)
      .all<Record<string, unknown>>();
    const rows = results ?? [];
    for (const row of rows) {
      out.push(insertLine("flights", row));
      lastId = Number(row.id);
    }
    if (rows.length < FLIGHTS_PAGE) return out.join("\n") + "\n";
  }
}

const chunkKey = (n: number) => `${EVENTS_PREFIX}events-${String(n).padStart(6, "0")}.sql`;

/** Highest event chunk number already in R2, or -1 when there is none. */
async function lastEventChunk(env: Env): Promise<number> {
  let last = -1;
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list({ prefix: EVENTS_PREFIX, cursor });
    for (const obj of page.objects) {
      const m = /events-(\d+)\.sql$/.exec(obj.key);
      if (m) last = Math.max(last, Number(m[1]));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return last;
}

/**
 * Write event chunks from the last (possibly still filling) chunk onwards.
 * Chunk n holds rowids n*EVENT_CHUNK+1 .. (n+1)*EVENT_CHUNK. Returns the number written.
 */
async function backupEvents(env: Env): Promise<number> {
  const maxRow = await env.DB.prepare("SELECT MAX(rowid) AS m FROM events").first<{ m: number | null }>();
  const maxRowid = Number(maxRow?.m ?? 0);
  if (maxRowid === 0) return 0;

  const first = Math.max(0, await lastEventChunk(env));
  const last = Math.min(Math.floor((maxRowid - 1) / EVENT_CHUNK), first + MAX_CHUNKS_PER_RUN - 1);
  for (let n = first; n <= last; n++) {
    const { results } = await env.DB.prepare(
      "SELECT * FROM events WHERE rowid > ?1 AND rowid <= ?2 ORDER BY rowid",
    )
      .bind(n * EVENT_CHUNK, (n + 1) * EVENT_CHUNK)
      .all<Record<string, unknown>>();
    const lines = (results ?? []).map((row) => insertLine("events", row));
    await env.BACKUPS.put(chunkKey(n), lines.join("\n") + "\n", SQL_TYPE);
  }
  return last - first + 1;
}

/** Delete objects under backups/YYYY-MM-DD/ whose day is older than RETENTION_DAYS. */
async function pruneOldBackups(env: Env, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.BACKUPS.list({ prefix: PREFIX, cursor });
    for (const obj of page.objects) {
      const day = obj.key.slice(PREFIX.length, PREFIX.length + 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day) && day < cutoff) stale.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  // R2 delete() takes at most 1000 keys per call.
  for (let i = 0; i < stale.length; i += 1000) {
    await env.BACKUPS.delete(stale.slice(i, i + 1000));
  }
  return stale.length;
}
