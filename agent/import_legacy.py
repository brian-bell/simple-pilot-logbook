"""
One-off migration: copy flights from the old SQLite logbook (backend/logbook.db)
into the Worker as flight.import events.

    python import_legacy.py --db "C:\\path\\to\\logbook.db" --dry-run
    python import_legacy.py --db "C:\\path\\to\\logbook.db" --direct
    python import_legacy.py --db "C:\\path\\to\\logbook.db" --direct --skip-ids 1,2

Cleans up two artefacts of the old code:
  * aircraft_title / aircraft_registration stored as Python bytes reprs ("b'...'")
  * date-only strings ("2026-03-01") become full ISO timestamps

Safe to re-run: every legacy row maps to a deterministic event id, so the
Worker reports inserted_flights: 0 the second time.

--direct posts straight to the Worker (recommended for the one-off).
Without it, events are queued in the agent's outbox and shipped by the running agent.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

AGENT_DIR = Path(__file__).resolve().parent
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from config import load_config  # noqa: E402
from events import clean_legacy_str, legacy_import_event  # noqa: E402
from outbox import Outbox  # noqa: E402
from sender import post_json  # noqa: E402

_DATE_ONLY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def load_rows(db_path: Path, skip_ids: set[int]) -> list[dict]:
    uri = db_path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = [dict(r) for r in conn.execute("SELECT * FROM flights ORDER BY id").fetchall()]
    finally:
        conn.close()
    return [r for r in rows if int(r["id"]) not in skip_ids]


def clean_row(row: dict) -> dict:
    out = dict(row)
    out["aircraft_title"] = clean_legacy_str(row.get("aircraft_title"))
    out["aircraft_registration"] = clean_legacy_str(row.get("aircraft_registration"))
    date = str(row.get("date") or "").strip()
    if _DATE_ONLY_RE.match(date):
        date = f"{date}T00:00:00+00:00"
    out["date"] = date
    return out


def print_summary(rows: list[dict]) -> None:
    print(f"{'id':>4}  {'date':<25}  {'from':<5} {'to':<5}  {'reg':<8}  title")
    for r in rows:
        print(
            f"{r['id']:>4}  {r['date']:<25}  {(r.get('departure_icao') or '-'):<5} "
            f"{(r.get('arrival_icao') or '-'):<5}  {(r.get('aircraft_registration') or '-'):<8}  "
            f"{r.get('aircraft_title') or '-'}"
        )
    print(f"\n{len(rows)} flight(s)")


def parse_skip_ids(raw: str | None) -> set[int]:
    if not raw:
        return set()
    return {int(part) for part in raw.split(",") if part.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", required=True, type=Path, help="path to the old logbook.db")
    parser.add_argument("--dry-run", action="store_true", help="print the cleaned rows and exit")
    parser.add_argument("--direct", action="store_true", help="POST to the Worker now instead of queuing in the outbox")
    parser.add_argument("--skip-ids", default="", help="comma-separated legacy ids to leave out, e.g. 1,2")
    args = parser.parse_args()

    if not args.db.exists():
        print(f"Database not found: {args.db}", file=sys.stderr)
        return 1

    rows = [clean_row(r) for r in load_rows(args.db, parse_skip_ids(args.skip_ids))]
    print_summary(rows)
    if args.dry_run or not rows:
        return 0

    cfg = load_config()
    events = [legacy_import_event(r) for r in rows]

    if not args.direct:
        outbox = Outbox(cfg.outbox_path)
        queued = sum(1 for e in events if outbox.enqueue(e))
        print(f"\nQueued {queued} new event(s) in {cfg.outbox_path}. The running agent will upload them.")
        return 0

    accepted = inserted = 0
    for start in range(0, len(events), cfg.batch_size):
        batch = events[start : start + cfg.batch_size]
        status, text = post_json(cfg, {"events": batch}, timeout=30.0)
        if not 200 <= status < 300:
            print(f"\nWorker returned HTTP {status}: {text[:300]}", file=sys.stderr)
            print(f"Sent {accepted} of {len(events)} event(s) before the error.", file=sys.stderr)
            return 1
        try:
            result = json.loads(text)
        except ValueError:
            result = {}
        accepted += int(result.get("accepted", len(batch)))
        inserted += int(result.get("inserted_flights", 0))
        print(f"batch {start // cfg.batch_size + 1}: accepted {result.get('accepted')}, new flights {result.get('inserted_flights')}")

    print(f"\nDone. {accepted} event(s) accepted, {inserted} new flight(s) created.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
