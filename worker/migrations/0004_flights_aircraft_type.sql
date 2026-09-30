-- Short ICAO aircraft type designator (C172, A20N, B738) parsed by the agent from ATC MODEL.
-- Apply before deploying a Worker that inserts it; older flights keep NULL.
ALTER TABLE flights ADD COLUMN aircraft_type TEXT;
