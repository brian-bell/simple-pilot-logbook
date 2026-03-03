"""
SQLite persistence layer for the pilot logbook.

Each function opens and closes its own connection to remain thread-safe
(the SimConnect worker thread writes, FastAPI threads read simultaneously).
"""

import sqlite3
from pathlib import Path
from typing import Any

DB_PATH = Path(__file__).parent / "logbook.db"

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS flights (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    date                   TEXT    NOT NULL,
    aircraft_title         TEXT,
    aircraft_registration  TEXT,
    departure_icao         TEXT,
    departure_name         TEXT,
    departure_lat          REAL,
    departure_lon          REAL,
    arrival_icao           TEXT,
    arrival_name           TEXT,
    arrival_lat            REAL,
    arrival_lon            REAL,
    distance_nm            REAL,
    elapsed_seconds        INTEGER,
    max_altitude_ft        REAL,
    landing_vs_fpm         REAL,
    landing_g_force        REAL,
    notes                  TEXT,
    created_at             TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
"""


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with _connect() as conn:
        conn.executescript(_CREATE_SQL)


def insert_flight(data: dict[str, Any]) -> int:
    cols = [
        "date", "aircraft_title", "aircraft_registration",
        "departure_icao", "departure_name", "departure_lat", "departure_lon",
        "arrival_icao", "arrival_name", "arrival_lat", "arrival_lon",
        "distance_nm", "elapsed_seconds", "max_altitude_ft",
        "landing_vs_fpm", "landing_g_force", "notes",
    ]
    placeholders = ", ".join("?" for _ in cols)
    col_list = ", ".join(cols)
    values = [data.get(c) for c in cols]

    with _connect() as conn:
        cur = conn.execute(
            f"INSERT INTO flights ({col_list}) VALUES ({placeholders})",
            values,
        )
        return cur.lastrowid


def get_flights(limit: int = 100, offset: int = 0) -> list[dict]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM flights ORDER BY date DESC, id DESC LIMIT ? OFFSET ?",
            (limit, offset),
        ).fetchall()
    return [dict(r) for r in rows]


def get_flight(flight_id: int) -> dict | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM flights WHERE id = ?", (flight_id,)
        ).fetchone()
    return dict(row) if row else None


def delete_flight(flight_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM flights WHERE id = ?", (flight_id,))
    return cur.rowcount > 0


def get_flight_count() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) FROM flights").fetchone()
    return row[0]
