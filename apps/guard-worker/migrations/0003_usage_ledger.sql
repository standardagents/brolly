-- Persistent account-wide usage ledger. Existing assets, incidents, actions,
-- notification deliveries, audit history, and fuse evidence remain intact.

CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  parent_resource_id TEXT,
  product_family TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  cloudflare_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  last_active_at INTEGER,
  coverage_status TEXT NOT NULL DEFAULT 'missing'
    CHECK (coverage_status IN ('complete','partial','sampled','stale','missing')),
  control_capability TEXT NOT NULL DEFAULT 'none'
    CHECK (control_capability IN ('none','runtime_fuse','queue_pause')),
  runtime_fuse_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (runtime_fuse_status IN ('unknown','missing','declared','verified','unhealthy')),
  auto_quarantine_policy TEXT NOT NULL DEFAULT 'inherit'
    CHECK (auto_quarantine_policy IN ('inherit','allow','deny')),
  tier TEXT NOT NULL DEFAULT 'unclassified',
  excluded INTEGER NOT NULL DEFAULT 0,
  collector_key TEXT,
  dataset TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE (account_id, resource_type, cloudflare_id),
  FOREIGN KEY (parent_resource_id) REFERENCES resources(id)
);
CREATE INDEX IF NOT EXISTS idx_resources_parent ON resources(parent_resource_id, product_family);
CREATE INDEX IF NOT EXISTS idx_resources_active ON resources(account_id, last_active_at DESC);
CREATE INDEX IF NOT EXISTS idx_resources_family_type ON resources(account_id, product_family, resource_type);

CREATE TABLE IF NOT EXISTS metric_definitions (
  id TEXT PRIMARY KEY,
  product_family TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  display_name TEXT NOT NULL,
  unit TEXT NOT NULL,
  aggregation_kind TEXT NOT NULL CHECK (aggregation_kind IN ('sum','maximum','latest')),
  billing_mapping TEXT,
  collector_key TEXT NOT NULL,
  finest_scope TEXT NOT NULL,
  pricing_version_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  catalog_version TEXT NOT NULL,
  UNIQUE(product_family,metric_key)
);

CREATE TABLE IF NOT EXISTS collector_capabilities (
  account_id TEXT NOT NULL,
  collector_key TEXT NOT NULL,
  dataset TEXT NOT NULL,
  available INTEGER NOT NULL,
  retention_days INTEGER,
  sampling_behavior TEXT,
  finest_scope TEXT NOT NULL,
  last_verified_at INTEGER NOT NULL,
  error_code TEXT,
  human_explanation TEXT NOT NULL,
  state TEXT NOT NULL,
  watermark_at INTEGER,
  PRIMARY KEY(account_id,collector_key,dataset)
);

CREATE TABLE IF NOT EXISTS collector_state (
  account_id TEXT NOT NULL,
  collector_key TEXT NOT NULL,
  partition_key TEXT NOT NULL DEFAULT '',
  cursor_json TEXT,
  high_watermark_at INTEGER,
  correction_start_at INTEGER,
  lease_holder TEXT,
  lease_expires_at INTEGER,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_eligible_at INTEGER NOT NULL DEFAULT 0,
  last_started_at INTEGER,
  last_completed_at INTEGER,
  last_error TEXT,
  last_status TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(account_id,collector_key,partition_key)
);
CREATE INDEX IF NOT EXISTS idx_collector_state_due ON collector_state(account_id,next_eligible_at,last_status);

CREATE TABLE IF NOT EXISTS billing_cycles (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','sealed','corrected')),
  currency TEXT NOT NULL DEFAULT 'USD',
  authoritative_cost REAL,
  reconciled_at INTEGER,
  approximate INTEGER NOT NULL DEFAULT 0,
  UNIQUE(account_id,starts_at,ends_at)
);
CREATE INDEX IF NOT EXISTS idx_billing_cycles_current ON billing_cycles(account_id,starts_at DESC);

CREATE TABLE IF NOT EXISTS billing_line_items (
  id TEXT PRIMARY KEY,
  billing_cycle_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  charge_period_start INTEGER NOT NULL,
  charge_period_end INTEGER NOT NULL,
  product_family TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  description TEXT NOT NULL,
  consumed_quantity REAL NOT NULL,
  consumed_unit TEXT NOT NULL,
  billed_cost REAL,
  effective_cost REAL,
  list_cost REAL,
  currency TEXT NOT NULL DEFAULT 'USD',
  resource_cloudflare_id TEXT,
  mapped INTEGER NOT NULL DEFAULT 0,
  raw_metadata_json TEXT NOT NULL DEFAULT '{}',
  revised_at INTEGER NOT NULL,
  FOREIGN KEY(billing_cycle_id) REFERENCES billing_cycles(id),
  UNIQUE(account_id,charge_period_start,charge_period_end,product_family,metric_key,resource_cloudflare_id,description,consumed_unit)
);
CREATE INDEX IF NOT EXISTS idx_billing_lines_cycle ON billing_line_items(billing_cycle_id,product_family);

CREATE TABLE IF NOT EXISTS pricing_versions (
  id TEXT PRIMARY KEY,
  product_family TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  unit_price REAL NOT NULL,
  included_quantity REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  source_url TEXT NOT NULL,
  source_metadata_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(product_family,metric_key,effective_from)
);

CREATE TABLE IF NOT EXISTS usage_accumulator_shards (
  account_id TEXT NOT NULL,
  product_family TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  local_day TEXT NOT NULL,
  billing_cycle_id TEXT NOT NULL,
  resource_hash_bucket INTEGER NOT NULL,
  split_depth INTEGER NOT NULL DEFAULT 0,
  split_segment INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL DEFAULT '{}',
  source_watermarks_json TEXT NOT NULL DEFAULT '{}',
  quality_flags_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,product_family,scope_type,local_day,billing_cycle_id,resource_hash_bucket,split_depth,split_segment)
);

CREATE TABLE IF NOT EXISTS usage_daily (
  resource_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  period_start_at INTEGER NOT NULL,
  period_end_at INTEGER NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  estimated_cost_usd REAL,
  authoritative_allocated_cost_usd REAL,
  completeness TEXT NOT NULL,
  sampling_json TEXT NOT NULL DEFAULT '{}',
  sealed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  revised_at INTEGER NOT NULL,
  PRIMARY KEY(resource_id,local_day),
  FOREIGN KEY(resource_id) REFERENCES resources(id)
);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(local_day,resource_id);

CREATE TABLE IF NOT EXISTS usage_cycle_totals (
  resource_id TEXT NOT NULL,
  billing_cycle_id TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  estimated_cost_usd REAL,
  authoritative_allocated_cost_usd REAL,
  completeness TEXT NOT NULL,
  sampling_json TEXT NOT NULL DEFAULT '{}',
  sealed INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  revised_at INTEGER NOT NULL,
  PRIMARY KEY(resource_id,billing_cycle_id),
  FOREIGN KEY(resource_id) REFERENCES resources(id),
  FOREIGN KEY(billing_cycle_id) REFERENCES billing_cycles(id)
);

CREATE TABLE IF NOT EXISTS monitor_runs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  completed_at INTEGER,
  duration_ms INTEGER,
  graphql_queries INTEGER NOT NULL DEFAULT 0,
  rest_requests INTEGER NOT NULL DEFAULT 0,
  datasets_queried INTEGER NOT NULL DEFAULT 0,
  rows_returned INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  samples_normalized INTEGER NOT NULL DEFAULT 0,
  continuation_json TEXT,
  errors_json TEXT NOT NULL DEFAULT '[]',
  deferred_collectors_json TEXT NOT NULL DEFAULT '[]',
  coverage_status TEXT NOT NULL DEFAULT 'partial',
  status TEXT NOT NULL DEFAULT 'running'
);
CREATE INDEX IF NOT EXISTS idx_monitor_runs_time ON monitor_runs(account_id,started_at DESC);

CREATE TABLE IF NOT EXISTS monitor_usage_daily (
  account_id TEXT NOT NULL,
  local_day TEXT NOT NULL,
  graphql_queries INTEGER NOT NULL DEFAULT 0,
  graphql_query_budget INTEGER NOT NULL DEFAULT 0,
  rest_requests INTEGER NOT NULL DEFAULT 0,
  rest_request_budget INTEGER NOT NULL DEFAULT 0,
  d1_rows_read INTEGER NOT NULL DEFAULT 0,
  d1_rows_written INTEGER NOT NULL DEFAULT 0,
  worker_requests INTEGER NOT NULL DEFAULT 0,
  worker_cpu_ms REAL NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0,
  storage_bytes INTEGER,
  storage_capacity_bytes INTEGER,
  deferred_collectors_json TEXT NOT NULL DEFAULT '[]',
  oldest_resource_day TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id,local_day)
);

CREATE TABLE IF NOT EXISTS backfill_jobs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  requested_start_at INTEGER NOT NULL,
  requested_end_at INTEGER NOT NULL,
  newest_first INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending',
  paused_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backfill_slices (
  id TEXT PRIMARY KEY,
  backfill_job_id TEXT NOT NULL,
  collector_key TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT '',
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL,
  cursor_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER NOT NULL DEFAULT 0,
  coverage_status TEXT NOT NULL DEFAULT 'missing',
  error TEXT,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(backfill_job_id) REFERENCES backfill_jobs(id),
  UNIQUE(backfill_job_id,collector_key,scope_key,starts_at,ends_at)
);
CREATE INDEX IF NOT EXISTS idx_backfill_slices_due ON backfill_slices(status,ends_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  target_resource_id TEXT,
  target_selector_json TEXT,
  metric_definition_id TEXT NOT NULL,
  measurement TEXT NOT NULL CHECK (measurement IN ('usage','estimated_cost','billed_cost')),
  period TEXT NOT NULL CHECK (period IN ('day','billing_cycle')),
  notification_target_ids_json TEXT NOT NULL DEFAULT '[]',
  auto_quarantine INTEGER NOT NULL DEFAULT 0,
  auto_quarantine_contributors INTEGER NOT NULL DEFAULT 0,
  confirmation_window_ms INTEGER NOT NULL DEFAULT 300000,
  enabled INTEGER NOT NULL DEFAULT 1,
  retired INTEGER NOT NULL DEFAULT 0,
  legacy_policy_key TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(target_resource_id) REFERENCES resources(id),
  FOREIGN KEY(metric_definition_id) REFERENCES metric_definitions(id)
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_metric ON alert_rules(account_id,metric_definition_id,period,enabled);

CREATE TABLE IF NOT EXISTS alert_lines (
  id TEXT PRIMARY KEY,
  alert_rule_id TEXT NOT NULL,
  level_id TEXT,
  label TEXT NOT NULL COLLATE NOCASE,
  color TEXT NOT NULL,
  priority INTEGER NOT NULL,
  threshold_value REAL NOT NULL,
  action TEXT CHECK (action IS NULL OR action IN ('notify','quarantine')),
  repeat_interval_ms INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  retired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(alert_rule_id) REFERENCES alert_rules(id) ON DELETE CASCADE,
  FOREIGN KEY(level_id) REFERENCES alert_levels(id) ON DELETE SET NULL,
  UNIQUE(alert_rule_id,level_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_lines_rule ON alert_lines(alert_rule_id,enabled,priority);

CREATE TABLE IF NOT EXISTS alert_instances (
  id TEXT PRIMARY KEY,
  alert_rule_id TEXT NOT NULL,
  alert_line_id TEXT NOT NULL,
  target_resource_id TEXT NOT NULL,
  period_start_at INTEGER NOT NULL,
  period_end_at INTEGER NOT NULL,
  observed_value REAL NOT NULL,
  threshold_value REAL NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  data_quality TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','expired','resolved')),
  first_breached_at INTEGER NOT NULL,
  last_breached_at INTEGER NOT NULL,
  next_notification_at INTEGER,
  notification_count INTEGER NOT NULL DEFAULT 0,
  acknowledged_at INTEGER,
  acknowledged_by TEXT,
  linked_action_id TEXT,
  historical INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(alert_rule_id) REFERENCES alert_rules(id),
  FOREIGN KEY(alert_line_id) REFERENCES alert_lines(id),
  FOREIGN KEY(target_resource_id) REFERENCES resources(id),
  FOREIGN KEY(linked_action_id) REFERENCES actions(id),
  UNIQUE(alert_rule_id,alert_line_id,target_resource_id,period_start_at,period_end_at)
);
CREATE INDEX IF NOT EXISTS idx_alert_instances_open ON alert_instances(status,next_notification_at,last_breached_at DESC);

CREATE TABLE IF NOT EXISTS contributor_candidates (
  alert_instance_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  scan_watermark_at INTEGER NOT NULL,
  consecutive_wins INTEGER NOT NULL DEFAULT 1,
  evidence_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(alert_instance_id,resource_id),
  FOREIGN KEY(alert_instance_id) REFERENCES alert_instances(id),
  FOREIGN KEY(resource_id) REFERENCES resources(id)
);

ALTER TABLE actions ADD COLUMN alert_instance_id TEXT;
ALTER TABLE actions ADD COLUMN evidence_quality TEXT NOT NULL DEFAULT 'complete';
ALTER TABLE actions ADD COLUMN automatic INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_deliveries ADD COLUMN alert_instance_id TEXT;

INSERT INTO settings(key,value,updated_at) VALUES('usage_ledger_schema','2026-08-13.1',unixepoch('now') * 1000)
ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at;
