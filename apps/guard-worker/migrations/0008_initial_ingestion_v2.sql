-- Range-based initial imports coexist with legacy daily jobs so already
-- imported ledger history is preserved during an upgrade.
CREATE UNIQUE INDEX IF NOT EXISTS idx_backfill_initial_v2_job
  ON backfill_jobs(account_id) WHERE kind='initial_v2';

-- Cycle lookups previously scanned every day and bucket for a product family,
-- exhausting the D1 read budget while historical observations were applied.
CREATE INDEX IF NOT EXISTS idx_usage_shards_cycle_bucket_day
  ON usage_accumulator_shards(
    account_id,product_family,scope_type,billing_cycle_id,resource_hash_bucket,local_day DESC
  );
