CREATE TABLE IF NOT EXISTS oauth_states (
  state_hash TEXT PRIMARY KEY,
  verifier TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON oauth_states(expires_at);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS control_deployments (
  id TEXT PRIMARY KEY,
  worker_script TEXT NOT NULL,
  generation INTEGER NOT NULL,
  action_count INTEGER NOT NULL,
  automatic INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_control_deployments_time
  ON control_deployments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_control_deployments_worker_time
  ON control_deployments(worker_script, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_actions_incident_updated
  ON actions(incident_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_actions_target_state
  ON actions(account_id, family, asset_id, state, updated_at DESC);
