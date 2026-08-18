CREATE TABLE notification_providers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL UNIQUE CHECK (kind IN ('twilio','cloudflare_email','resend','postmark')),
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

ALTER TABLE notification_targets ADD COLUMN provider_id TEXT
  REFERENCES notification_providers(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_notification_targets_label
  ON notification_targets(label COLLATE NOCASE);
CREATE INDEX idx_notification_targets_provider
  ON notification_targets(provider_id);
