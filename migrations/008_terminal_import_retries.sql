ALTER TABLE imports
  DROP CONSTRAINT IF EXISTS imports_merchant_id_content_sha256_key;

CREATE UNIQUE INDEX IF NOT EXISTS imports_active_content_sha256_idx
  ON imports (merchant_id, content_sha256)
  WHERE status NOT IN ('FAILED', 'CANCELLED');
