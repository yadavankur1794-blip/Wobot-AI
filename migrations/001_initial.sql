CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS merchants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID REFERENCES merchants(id),
  email_normalized TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('MERCHANT_USER', 'PLATFORM_STAFF')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_role_membership_check CHECK (
    (role = 'MERCHANT_USER' AND merchant_id IS NOT NULL)
    OR (role = 'PLATFORM_STAFF' AND merchant_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BYTEA NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS imports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  content_sha256 BYTEA NOT NULL,
  import_order BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,
  original_filename TEXT,
  storage_path TEXT NOT NULL,
  report_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('QUEUED', 'VALIDATING', 'APPLYING', 'CANCEL_REQUESTED', 'CANCELLED', 'COMPLETED', 'FAILED')),
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  attempt BIGINT NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  scanned_rows BIGINT NOT NULL DEFAULT 0,
  valid_rows BIGINT NOT NULL DEFAULT 0,
  rejected_rows BIGINT NOT NULL DEFAULT 0,
  distinct_products BIGINT NOT NULL DEFAULT 0,
  published_rows BIGINT NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, content_sha256)
);

CREATE TABLE IF NOT EXISTS products (
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC NOT NULL,
  currency CHAR(3) NOT NULL,
  stock BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  last_import_order BIGINT NOT NULL,
  last_source_row BIGINT NOT NULL,
  PRIMARY KEY (merchant_id, sku)
);

CREATE TABLE IF NOT EXISTS import_staging (
  import_id UUID NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price NUMERIC NOT NULL,
  currency CHAR(3) NOT NULL,
  stock BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  source_row BIGINT NOT NULL,
  source_line_start BIGINT,
  source_line_end BIGINT,
  PRIMARY KEY (import_id, sku)
);

CREATE INDEX IF NOT EXISTS imports_queue_idx
  ON imports (status, lease_expires_at, created_at);

CREATE INDEX IF NOT EXISTS import_staging_import_idx
  ON import_staging (import_id, sku);
