-- Preserve Cloudflare identity provenance separately from UI presentation.
-- display_name remains as a legacy compatibility column for existing queries;
-- new code reads cloudflare_name and name_kind instead.
ALTER TABLE resources ADD COLUMN cloudflare_name TEXT;
ALTER TABLE resources ADD COLUMN name_kind TEXT NOT NULL DEFAULT 'id_only'
  CHECK (name_kind IN ('named','id_only','brolly'));

UPDATE resources
SET cloudflare_name=CASE
      WHEN resource_type IN ('account','product') THEN display_name
      WHEN product_family IN ('workers','r2','pages','vectorize','ai_gateway','workflows','analytics_engine','log_explorer') THEN display_name
      WHEN display_name!=cloudflare_id THEN display_name
      ELSE NULL
    END,
    name_kind=CASE
      WHEN resource_type IN ('account','product') THEN 'brolly'
      WHEN product_family IN ('workers','r2','pages','vectorize','ai_gateway','workflows','analytics_engine','log_explorer') THEN 'named'
      WHEN display_name!=cloudflare_id THEN 'named'
      ELSE 'id_only'
    END;

CREATE INDEX IF NOT EXISTS idx_resources_identity
  ON resources(account_id,product_family,resource_type,cloudflare_name,cloudflare_id,id);
