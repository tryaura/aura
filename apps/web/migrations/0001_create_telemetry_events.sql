CREATE TABLE telemetry_events (
  id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL DEFAULT (unixepoch()),
  occurred_at TEXT NOT NULL,
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  kind TEXT NOT NULL CHECK (
    kind IN ('check-run', 'command-failed', 'fix-run', 'setup-run', 'undo-run')
  ),
  command TEXT NOT NULL CHECK (command IN ('check', 'setup', 'undo')),
  distro_version TEXT,
  exit_code INTEGER NOT NULL CHECK (exit_code >= 0),
  duration_ms REAL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  event_json TEXT NOT NULL CHECK (json_valid(event_json))
) STRICT;

-- A database-enforced ceiling protects D1 even when edge rate limits are bypassed across locations.
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

CREATE INDEX telemetry_events_received_at_idx
  ON telemetry_events (received_at);

CREATE INDEX telemetry_events_kind_received_at_idx
  ON telemetry_events (kind, received_at);

CREATE INDEX telemetry_events_distro_version_received_at_idx
  ON telemetry_events (distro_version, received_at);
