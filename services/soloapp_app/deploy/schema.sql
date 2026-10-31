BEGIN;
CREATE TABLE IF NOT EXISTS planet_world (
 id bigint PRIMARY KEY CHECK(id=1), owner text NOT NULL DEFAULT '', lease_ms bigint NOT NULL DEFAULT 0,
 epoch bigint NOT NULL DEFAULT 0, checkpoint text NOT NULL DEFAULT '{}', snapshot text NOT NULL DEFAULT '{}'
);
ALTER TABLE planet_world ADD COLUMN IF NOT EXISTS advanced_ms bigint NOT NULL DEFAULT 0;
INSERT INTO planet_world(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS planet_portals(id text PRIMARY KEY, pulse_ms bigint NOT NULL, players text NOT NULL);
CREATE TABLE IF NOT EXISTS planet_signals(id text PRIMARY KEY, target text NOT NULL, expires_ms bigint NOT NULL, payload text NOT NULL);
CREATE INDEX IF NOT EXISTS planet_signals_target ON planet_signals(target);
REVOKE ALL ON planet_world,planet_portals,planet_signals FROM PUBLIC;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['chat_api_local','chat_api_yc','chat_api_home'] LOOP
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
   EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',role_name);
   EXECUTE format('GRANT SELECT,UPDATE ON planet_world TO %I',role_name);
   EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON planet_portals,planet_signals TO %I',role_name);
  END IF;
 END LOOP;
END $$;
COMMIT;
