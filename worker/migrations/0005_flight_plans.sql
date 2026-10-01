-- Migration number: 0005 	 2026-10-01
-- SimBrief flight plans attached to flights (simbrief.ts), best effort.
-- Keyed by flight_uuid (the flight.takeoff event id, also in the landing payload);
-- GET /api/flights/{id} reaches it through flights.event_id -> events.payload.flight_uuid.

CREATE TABLE IF NOT EXISTS flight_plans (
  flight_uuid            TEXT PRIMARY KEY,
  source                 TEXT    NOT NULL DEFAULT 'simbrief',
  ofp_id                 TEXT,             -- SimBrief params.request_id
  generated_at           TEXT,             -- ISO 8601 UTC
  callsign               TEXT,
  origin_icao            TEXT,
  destination_icao       TEXT,
  alternate_icao         TEXT,
  route                  TEXT,
  cruise_altitude_ft     INTEGER,
  aircraft_type          TEXT,
  aircraft_registration  TEXT,
  route_distance_nm      REAL,
  est_time_enroute_s     INTEGER,
  block_fuel             REAL,
  trip_fuel              REAL,
  fuel_units             TEXT,             -- kgs | lbs
  pdf_url                TEXT,             -- SimBrief-hosted OFP; not archived
  match_note             TEXT,             -- why the plan was accepted
  plan_json              TEXT,             -- trimmed OFP: {"navlog": [...]}
  fetched_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
