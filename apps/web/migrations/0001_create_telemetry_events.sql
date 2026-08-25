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

CREATE INDEX telemetry_events_received_at_idx
  ON telemetry_events (received_at);

CREATE INDEX telemetry_events_kind_received_at_idx
  ON telemetry_events (kind, received_at);

CREATE INDEX telemetry_events_distro_version_received_at_idx
  ON telemetry_events (distro_version, received_at);
