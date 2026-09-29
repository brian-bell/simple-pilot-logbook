-- Live "aircraft confirmed on the ground" flag from the agent heartbeat.
-- The public state ON_GROUND also covers the sim menu and loading screens; this
-- column is 1 only after a live sample showed the aircraft sitting on the ground.
ALTER TABLE agent_status ADD COLUMN on_ground INTEGER NOT NULL DEFAULT 0;
