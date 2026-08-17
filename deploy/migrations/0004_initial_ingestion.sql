-- Initial onboarding ingestion uses the existing backfill tables.  The kind
-- keeps the one-shot job distinct from operator-created historical imports;
-- next_eligible_at makes retry backoff durable across Worker isolates.
ALTER TABLE backfill_jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE backfill_slices ADD COLUMN next_eligible_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_backfill_slices_eligible
  ON backfill_slices(status,next_eligible_at,ends_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_backfill_initial_job
  ON backfill_jobs(account_id) WHERE kind='initial';
