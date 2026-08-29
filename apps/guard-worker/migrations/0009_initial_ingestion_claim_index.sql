-- Initial import claims filter and sort on immutable slice metadata. This
-- expression index keeps each paced claim from scanning the whole job.
CREATE INDEX IF NOT EXISTS idx_backfill_slices_initial_claim
ON backfill_slices(
  backfill_job_id,
  status,
  COALESCE(json_extract(scope_key,'$.persistenceRetry'),0),
  COALESCE(json_extract(scope_key,'$.priority'),10000),
  COALESCE(json_array_length(json_extract(scope_key,'$.zoneIds')),0),
  ends_at DESC
);
