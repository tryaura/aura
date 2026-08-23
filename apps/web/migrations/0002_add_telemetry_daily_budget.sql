-- A database-enforced ceiling protects D1 even when edge rate limits are bypassed across locations.
-- This arrives as its own migration because 0001 was already applied to production without it, and
-- `wrangler d1 migrations apply` never re-runs a file it has recorded.
CREATE TABLE telemetry_daily_budget (
  day TEXT PRIMARY KEY,
  event_count INTEGER NOT NULL CHECK (event_count >= 0 AND event_count <= 10000)
) STRICT, WITHOUT ROWID;

CREATE TRIGGER telemetry_events_daily_budget
BEFORE INSERT ON telemetry_events
BEGIN
  INSERT INTO telemetry_daily_budget (day, event_count)
  VALUES (date('now'), 1)
  ON CONFLICT(day) DO UPDATE
    SET event_count = event_count + 1
    WHERE event_count < 10000;

  SELECT CASE
    WHEN changes() = 0 THEN RAISE(ABORT, 'daily telemetry event limit reached')
  END;
END;
