CREATE TABLE alert_levels (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  label TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO alert_levels(id,position,label,created_at,updated_at) VALUES
  ('warning',0,'Warning',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
  ('critical',1,'Critical',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000),
  ('emergency',2,'Emergency',CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000);

CREATE UNIQUE INDEX idx_alert_levels_position ON alert_levels(position);

CREATE TABLE alert_level_entries (
  id TEXT PRIMARY KEY,
  level_id TEXT NOT NULL REFERENCES alert_levels(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('channel','prepare_stop','prepare_quarantine','auto_pause','auto_quarantine')),
  target_id TEXT REFERENCES notification_targets(id) ON DELETE CASCADE,
  repeat_interval_ms INTEGER,
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((kind='channel' AND target_id IS NOT NULL) OR (kind!='channel' AND target_id IS NULL)),
  CHECK ((kind='channel') OR repeat_interval_ms IS NULL)
);

CREATE INDEX idx_alert_level_entries_level
  ON alert_level_entries(level_id,position);
CREATE INDEX idx_alert_level_entries_target
  ON alert_level_entries(target_id);
