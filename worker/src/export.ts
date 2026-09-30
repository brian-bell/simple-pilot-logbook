/**
 * GET /api/flights/export.csv -> every flight as a CSV download (logbook backup).
 *
 * Columns: id, event_id, the 17 logbook fields, created_at. Oldest flight first
 * so the file reads like a paper logbook and diffs cleanly between backups.
 */

import { FLIGHT_FIELDS } from "./db";
import type { Env } from "./types";

const COLUMNS = ["id", "event_id", ...FLIGHT_FIELDS, "created_at"] as const;

/** Leading characters spreadsheets treat as a formula (CSV injection). */
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: unknown): string {
  if (value == null) return "";
  let s = String(value);
  // Sim-provided strings (aircraft titles, airport names, notes) could start with
  // "=" and run as a formula in Excel/Sheets; numbers are left untouched.
  if (typeof value === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Every flight as CSV text. Also used by the nightly R2 backup (backup.ts). */
export async function flightsCsv(env: Env): Promise<string> {
  const { results } = await env.DB.prepare(
    `SELECT ${COLUMNS.join(", ")} FROM flights ORDER BY date ASC, id ASC`,
  ).all<Record<string, unknown>>();

  const lines = [COLUMNS.join(",")];
  for (const row of results ?? []) {
    lines.push(COLUMNS.map((c) => csvCell(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export async function exportFlightsCsv(env: Env): Promise<Response> {
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(await flightsCsv(env), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="pilot-logbook-${stamp}.csv"`,
      "cache-control": "no-store",
    },
  });
}
