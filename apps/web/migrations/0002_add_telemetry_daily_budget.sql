-- A database-enforced ceiling protects D1 even when edge rate limits are bypassed across locations.
-- This arrives as its own migration because 0001 was already applied to production without it, and
-- `wrangler d1 migrations apply` never re-runs a recorded file.
CREATE TABLE telemetry_daily_budget (
  day TEXT PRIMARY KEY,
  event_count INTEGER NOT NULL CHECK (event_count >= 0 AND event_count <= 10000)
) STRICT, WITHOUT ROWID;

-- The guard is a `SELECT RAISE(...) WHERE ...` rather than the more usual `SELECT CASE WHEN ...
-- THEN RAISE(...) END`: D1's remote SQL parser ends the trigger body at the first bare `END`, so a
-- `CASE ... END` inside it truncates the statement and the migration fails with `incomplete input:
-- SQLITE_ERROR`. Local wrangler applies either form, so only a remote apply catches the difference.
CREATE TRIGGER telemetry_events_daily_budget
BEFORE INSERT ON telemetry_events
BEGIN
  INSERT INTO telemetry_daily_budget (day, event_count)
  VALUES (date('now'), 1)
  ON CONFLICT(day) DO UPDATE
    SET event_count = event_count + 1
    WHERE event_count < 10000;

  SELECT RAISE(ABORT, 'daily telemetry event limit reached') WHERE changes() = 0;
END;
