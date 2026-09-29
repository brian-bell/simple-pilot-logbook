-- Live "sim paused during a flight" flag from the agent heartbeat (Pause_EX1).
ALTER TABLE agent_status ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
