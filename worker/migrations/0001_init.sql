-- Migration number: 0001 	 2026-09-25
-- Initial schema for the Simple Pilot Logbook Worker.

-- Append-only event log. Everything the agent sends except heartbeats lands here.
CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,                 -- client-generated uuid4 (uuid5 for legacy imports)
  type        TEXT NOT NULL,                    -- flight.takeoff | flight.position | flight.landing | flight.import
  ts          TEXT NOT NULL,                    -- ISO 8601 UTC from the agent clock
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  payload     TEXT NOT NULL                     -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events (type, ts);

-- Materialised logbook. Same columns as the old backend/database.py plus event_id.
-- No foreign key to events on purpose: a future retention job on events must not break this.
CREATE TABLE IF NOT EXISTS flights (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id               TEXT    NOT NULL UNIQUE,
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
  created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_flights_date ON flights (date DESC, id DESC);

-- Single-row live status, overwritten by every agent heartbeat.
CREATE TABLE IF NOT EXISTS agent_status (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  updated_at          TEXT    NOT NULL,         -- Worker clock, not agent clock
  connected           INTEGER NOT NULL DEFAULT 0,
  state               TEXT    NOT NULL DEFAULT 'DISCONNECTED',
  current_flight_json TEXT
);
INSERT OR IGNORE INTO agent_status (id, updated_at, connected, state, current_flight_json)
VALUES (1, '1970-01-01T00:00:00Z', 0, 'DISCONNECTED', NULL);
