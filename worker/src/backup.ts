/**
 * Nightly D1 -> R2 backup (cron trigger in wrangler.jsonc).
 *
 * Each run writes two objects under backups/YYYY-MM-DD/:
 *   flights.csv  - the logbook, same format as GET /api/flights/export.csv
 *   logbook.sql  - INSERT OR IGNORE statements for `flights` and `events`; restore
 *                  into a migrated database with `wrangler d1 execute --file`
 * then deletes backup days older than RETENTION_DAYS. agent_status is live state
 * rebuilt by the next heartbeat, so it is not backed up.
 */

import { flightsCsv } from "./export";
import type { Env } from "./types";

const PREFIX = "backups/";
const RETENTION_DAYS = 30;
// 5000 rows per query keeps a large log (about 600 airborne hours of positions)
// under the free plan's 50 D1 queries per invocation.
const PAGE = 5000;
const DAY_MS = 24 * 60 * 60 * 1000;

export async function runBackup(env: Env, now = new Date()): Promise<void> {
  const day = now.toISOString().slice(0, 10);
  const [csv, sql] = await Promise.all([flightsCsv(env), logbookSql(env)]);
  await Promise.all([
    env.BACKUPS.put(`${PREFIX}${day}/flights.csv`, csv, {
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
    }),
    env.BACKUPS.put(`${PREFIX}${day}/logbook.sql`, sql, {
      httpMetadata: { contentType: "application/sql; charset=utf-8" },
    }),
  ]);
  const pruned = await pruneOldBackups(env, now);
  console.log(`backup ${day}: ${csv.length} B csv, ${sql.length} B sql, pruned ${pruned} objects`);
}

function sqlLiteral(value: unknown): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Dump a table in rowid order, PAGE rows per query, as INSERT OR IGNORE lines. */
async function dumpTable(env: Env, table: "flights" | "events", out: string[]): Promise<void> {
  let lastRowid = 0;
  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT rowid AS _rowid, * FROM ${table} WHERE rowid > ?1 ORDER BY rowid LIMIT ?2`,
    )
      .bind(lastRowid, PAGE)
      .all<Record<string, unknown>>();
    const rows = results ?? [];
    for (const { _rowid, ...row } of rows) {
      const cols = Object.keys(row);
      out.push(
        `INSERT OR IGNORE INTO ${table} (${cols.join(", ")}) ` +
          `VALUES (${cols.map((c) => sqlLiteral(row[c])).join(", ")});`,
      );
      lastRowid = Number(_rowid);
    }
    if (rows.length < PAGE) return;
  }
}

async function logbookSql(env: Env): Promise<string> {
  const out = [`-- Simple Pilot Logbook backup ${new Date().toISOString()}`];
  await dumpTable(env, "events", out);
  await dumpTable(env, "flights", out);
  return out.join("\n") + "\n";
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
