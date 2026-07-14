"""Tests for the PostgreSQL database layer."""

import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import database

# ---------------------------------------------------------------------------
# Sample data
# ---------------------------------------------------------------------------

SAMPLE_FLIGHT = {
    "date": "2026-04-01T18:30:00Z",
    "aircraft_title": "Cessna 172",
    "aircraft_registration": "N12345",
    "departure_icao": "KJFK",
    "departure_name": "John F Kennedy Intl",
    "departure_lat": 40.6413,
    "departure_lon": -73.7781,
    "arrival_icao": "KBOS",
    "arrival_name": "Boston Logan Intl",
    "arrival_lat": 42.3656,
    "arrival_lon": -71.0096,
    "distance_nm": 187.0,
    "elapsed_seconds": 3600,
    "max_altitude_ft": 8500.0,
    "landing_vs_fpm": -180.5,
    "landing_g_force": 1.15,
    "notes": "Smooth landing",
}

SAMPLE_FLIGHT_2 = {
    **SAMPLE_FLIGHT,
    "date": "2026-04-02T10:00:00Z",
    "aircraft_title": "Piper PA-28",
    "departure_icao": "KORD",
    "arrival_icao": "KATL",
}


def _insert_sample(data=None):
    """Helper to insert a flight and return its id."""
    return database.insert_flight(data or SAMPLE_FLIGHT)


# ---------------------------------------------------------------------------
# init_db
# ---------------------------------------------------------------------------


def test_init_db_creates_table():
    """After init_db(), the flights table should exist."""
    conn = database._get_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT EXISTS ("
            "  SELECT FROM information_schema.tables"
            "  WHERE table_name = 'flights'"
            ")"
        )
        assert cur.fetchone()[0] is True
    finally:
        database._put_conn(conn)


def test_init_db_idempotent():
    """Calling init_db() a second time should not raise."""
    database.init_db()


# ---------------------------------------------------------------------------
# insert_flight
# ---------------------------------------------------------------------------


def test_insert_flight_returns_id():
    fid = _insert_sample()
    assert isinstance(fid, int)
    assert fid > 0


def test_insert_flight_minimal():
    """Insert with only the required 'date' field; all others None."""
    fid = database.insert_flight({"date": "2026-04-01T12:00:00Z"})
    assert isinstance(fid, int)
    assert fid > 0


# ---------------------------------------------------------------------------
# get_flights
# ---------------------------------------------------------------------------


def test_get_flights_empty():
    assert database.get_flights() == []


def test_get_flights_returns_inserted():
    _insert_sample(SAMPLE_FLIGHT)
    _insert_sample(SAMPLE_FLIGHT_2)
    flights = database.get_flights()
    assert len(flights) == 2
    # Verify dict keys include expected columns
    for key in ("id", "date", "aircraft_title", "departure_icao", "arrival_icao"):
        assert key in flights[0]


def test_get_flights_order():
    """Flights should be returned newest-first by date."""
    _insert_sample(SAMPLE_FLIGHT)   # 2026-04-01
    _insert_sample(SAMPLE_FLIGHT_2) # 2026-04-02
    flights = database.get_flights()
    assert flights[0]["departure_icao"] == "KORD"  # newer flight first
    assert flights[1]["departure_icao"] == "KJFK"


def test_get_flights_pagination():
    for i in range(5):
        _insert_sample({**SAMPLE_FLIGHT, "date": f"2026-04-0{i+1}T12:00:00Z"})
    page = database.get_flights(limit=2, offset=1)
    assert len(page) == 2


# ---------------------------------------------------------------------------
# get_flight
# ---------------------------------------------------------------------------


def test_get_flight_exists():
    fid = _insert_sample()
    flight = database.get_flight(fid)
    assert flight is not None
    assert flight["id"] == fid
    assert flight["aircraft_title"] == "Cessna 172"
    assert flight["departure_icao"] == "KJFK"


def test_get_flight_missing():
    assert database.get_flight(99999) is None


# ---------------------------------------------------------------------------
# delete_flight
# ---------------------------------------------------------------------------


def test_delete_flight_exists():
    fid = _insert_sample()
    assert database.delete_flight(fid) is True
    assert database.get_flight(fid) is None


def test_delete_flight_missing():
    assert database.delete_flight(99999) is False


# ---------------------------------------------------------------------------
# get_flight_count
# ---------------------------------------------------------------------------


def test_get_flight_count_empty():
    assert database.get_flight_count() == 0


def test_get_flight_count_after_inserts():
    _insert_sample(SAMPLE_FLIGHT)
    _insert_sample(SAMPLE_FLIGHT_2)
    _insert_sample(SAMPLE_FLIGHT)
    assert database.get_flight_count() == 3


# ---------------------------------------------------------------------------
# Pool resilience
# ---------------------------------------------------------------------------


def test_pool_recovers_after_error():
    """A failed operation should not exhaust the connection pool."""
    # Force an error by inserting invalid data
    try:
        database.insert_flight({"date": None})  # date is NOT NULL
    except Exception:
        pass
    # Pool should still work
    fid = _insert_sample()
    assert fid > 0
