CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS assets (
  account_id TEXT NOT NULL,
  family TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT,
  scope TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'unclassified',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  discovered_at INTEGER NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, family, asset_id)
);

CREATE TABLE IF NOT EXISTS metric_coverage (
  family TEXT NOT NULL,
  metric TEXT NOT NULL,
  finest_scope TEXT NOT NULL,
  state TEXT NOT NULL,
  detail TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (family, metric)
);

CREATE TABLE IF NOT EXISTS metric_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  family TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  unit TEXT NOT NULL,
  value REAL NOT NULL,
  estimated_cost_usd REAL,
  source TEXT NOT NULL,
  sampled INTEGER NOT NULL DEFAULT 0,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_asset_metric_time
  ON metric_samples(account_id, family, asset_id, metric, end_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_identity
  ON metric_samples(account_id, family, asset_id, metric, source, start_at, end_at);
CREATE INDEX IF NOT EXISTS idx_samples_end_at ON metric_samples(end_at);

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  incident_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  family TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  metric TEXT NOT NULL,
  observed REAL NOT NULL,
  threshold_value REAL,
  expected REAL,
  reason TEXT NOT NULL,
  proposed_action TEXT NOT NULL,
  status TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  occurrences INTEGER NOT NULL,
  last_notified_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_incidents_open ON incidents(status, severity, last_seen DESC);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  family TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  rollback_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_targets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  minimum_severity TEXT NOT NULL DEFAULT 'warning',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_rate
  ON notification_deliveries(target_id, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);

CREATE TABLE IF NOT EXISTS cron_lease (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
