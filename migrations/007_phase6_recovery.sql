CREATE INDEX IF NOT EXISTS imports_lease_expiry_idx
  ON imports (lease_expires_at, status)
  WHERE lease_owner IS NOT NULL;
