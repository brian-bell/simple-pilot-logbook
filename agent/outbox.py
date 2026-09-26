"""
SQLite outbox.

Events are written locally first and deleted only after the Worker has
acknowledged them, so nothing is lost while the PC is offline or the Worker is
unreachable. Heartbeats never go through here.

Each method opens a short-lived connection (the same pattern the old
database.py used) so the SimConnect thread can enqueue while the sender thread
drains without sharing a connection.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable

_SCHEMA = """
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
"""


@dataclass(frozen=True)
class OutboxRow:
    seq: int
    event_id: str
    type: str
    body: str
    attempts: int


class Outbox:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as conn:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.executescript(_SCHEMA)
            conn.commit()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.path), timeout=5.0)
        conn.row_factory = sqlite3.Row
        return conn

    # ------------------------------------------------------------------
    # Producer side
    # ------------------------------------------------------------------

    def enqueue(self, event: dict[str, Any]) -> bool:
        """Store an event. Returns False when an event with the same id is already queued."""
        body = json.dumps(event, separators=(",", ":"), ensure_ascii=False)
        created_at = str(event.get("ts") or datetime.now(timezone.utc).isoformat())
        with closing(self._connect()) as conn, conn:
            cur = conn.execute(
                "INSERT OR IGNORE INTO outbox (event_id, type, body, created_at) VALUES (?, ?, ?, ?)",
                (event["id"], event["type"], body, created_at),
            )
            return cur.rowcount > 0

    # ------------------------------------------------------------------
    # Consumer side
    # ------------------------------------------------------------------

    def next_batch(self, limit: int) -> list[OutboxRow]:
        with closing(self._connect()) as conn:
            rows = conn.execute(
                "SELECT seq, event_id, type, body, attempts FROM outbox "
                "WHERE dead = 0 ORDER BY seq LIMIT ?",
                (int(limit),),
            ).fetchall()
        return [OutboxRow(r["seq"], r["event_id"], r["type"], r["body"], r["attempts"]) for r in rows]

    def ack(self, seqs: Iterable[int]) -> None:
        seqs = list(seqs)
        if not seqs:
            return
        with closing(self._connect()) as conn, conn:
            conn.executemany("DELETE FROM outbox WHERE seq = ?", [(s,) for s in seqs])

    def fail(self, seqs: Iterable[int], error: str) -> None:
        seqs = list(seqs)
        if not seqs:
            return
        with closing(self._connect()) as conn, conn:
            conn.executemany(
                "UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE seq = ?",
                [(error[:500], s) for s in seqs],
            )

    def mark_dead(self, seqs: Iterable[int], error: str) -> None:
        seqs = list(seqs)
        if not seqs:
            return
        with closing(self._connect()) as conn, conn:
            conn.executemany(
                "UPDATE outbox SET dead = 1, attempts = attempts + 1, last_error = ? WHERE seq = ?",
                [(error[:500], s) for s in seqs],
            )

    def pending_count(self) -> int:
        with closing(self._connect()) as conn:
            row = conn.execute("SELECT COUNT(*) FROM outbox WHERE dead = 0").fetchone()
        return int(row[0])

    def prune(self, position_max_age_days: int = 7, dead_keep: int = 1000) -> int:
        """
        Drop stale flight.position rows and excess dead rows.
        Landings are never pruned. Returns the number of rows removed.
        """
        cutoff = (datetime.now(timezone.utc) - timedelta(days=position_max_age_days)).isoformat()
        with closing(self._connect()) as conn, conn:
            removed = conn.execute(
                "DELETE FROM outbox WHERE type = 'flight.position' AND created_at < ?",
                (cutoff,),
            ).rowcount
            removed += conn.execute(
                "DELETE FROM outbox WHERE dead = 1 AND seq NOT IN "
                "(SELECT seq FROM outbox WHERE dead = 1 ORDER BY seq DESC LIMIT ?)",
                (int(dead_keep),),
            ).rowcount
        return int(removed)
