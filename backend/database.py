"""
PostgreSQL (Supabase) persistence layer for the pilot logbook.

Uses a connection pool for efficiency over the network.  Each public
function borrows a connection, executes its query, and returns the
connection to the pool in a try/finally block.
"""

import os
from typing import Any, Optional

import psycopg2
import psycopg2.extras
import psycopg2.pool
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.environ.get("DATABASE_URL")

_pool = None  # type: psycopg2.pool.SimpleConnectionPool | None

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS flights (
    id                     SERIAL PRIMARY KEY,
    date                   TIMESTAMPTZ NOT NULL,
    aircraft_title         TEXT,
    aircraft_registration  TEXT,
    departure_icao         TEXT,
    departure_name         TEXT,
    departure_lat          DOUBLE PRECISION,
    departure_lon          DOUBLE PRECISION,
    arrival_icao           TEXT,
    arrival_name           TEXT,
    arrival_lat            DOUBLE PRECISION,
    arrival_lon            DOUBLE PRECISION,
    distance_nm            DOUBLE PRECISION,
    elapsed_seconds        INTEGER,
    max_altitude_ft        DOUBLE PRECISION,
    landing_vs_fpm         DOUBLE PRECISION,
    landing_g_force        DOUBLE PRECISION,
    notes                  TEXT,
    created_at             TIMESTAMPTZ DEFAULT NOW()
);
"""


def _get_conn():
    if _pool is None:
        raise RuntimeError("Database not initialised – call init_db() first.")
    return _pool.getconn()


def _put_conn(conn):
    if _pool is not None:
        _pool.putconn(conn)


def init_db() -> None:
    global _pool
    if not DATABASE_URL:
        raise RuntimeError(
            "DATABASE_URL is not set. See docs/setup-db.md for setup instructions."
        )
    if _pool is None:
        _pool = psycopg2.pool.SimpleConnectionPool(1, 5, dsn=DATABASE_URL)
    conn = _get_conn()
    try:
        conn.execute(_CREATE_SQL)
        conn.commit()
    finally:
        _put_conn(conn)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.closeall()
        _pool = None


def insert_flight(data: dict[str, Any]) -> int:
    cols = [
        "date", "aircraft_title", "aircraft_registration",
        "departure_icao", "departure_name", "departure_lat", "departure_lon",
        "arrival_icao", "arrival_name", "arrival_lat", "arrival_lon",
        "distance_nm", "elapsed_seconds", "max_altitude_ft",
        "landing_vs_fpm", "landing_g_force", "notes",
    ]
    placeholders = ", ".join("%s" for _ in cols)
    col_list = ", ".join(cols)
    values = [data.get(c) for c in cols]

    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"INSERT INTO flights ({col_list}) VALUES ({placeholders}) RETURNING id",
            values,
        )
        flight_id = cur.fetchone()[0]
        conn.commit()
        return flight_id
    except Exception:
        conn.rollback()
        raise
    finally:
        _put_conn(conn)


def get_flights(limit: int = 100, offset: int = 0) -> list[dict]:
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute(
            "SELECT * FROM flights ORDER BY date DESC, id DESC LIMIT %s OFFSET %s",
            (limit, offset),
        )
        return [dict(row) for row in cur.fetchall()]
    finally:
        _put_conn(conn)


def get_flight(flight_id: int) -> Optional[dict]:
    conn = _get_conn()
    try:
        cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
        cur.execute("SELECT * FROM flights WHERE id = %s", (flight_id,))
        row = cur.fetchone()
        return dict(row) if row else None
    finally:
        _put_conn(conn)


def delete_flight(flight_id: int) -> bool:
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("DELETE FROM flights WHERE id = %s", (flight_id,))
        deleted = cur.rowcount > 0
        conn.commit()
        return deleted
    except Exception:
        conn.rollback()
        raise
    finally:
        _put_conn(conn)


def get_flight_count() -> int:
    conn = _get_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT COUNT(*) FROM flights")
        return cur.fetchone()[0]
    finally:
        _put_conn(conn)
