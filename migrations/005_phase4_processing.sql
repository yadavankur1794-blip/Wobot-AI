ALTER TABLE imports
  ADD COLUMN IF NOT EXISTS input_encoding TEXT NOT NULL DEFAULT 'utf8',
  ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS finished_at TIMESTAMPTZ;

ALTER TABLE imports
  DROP CONSTRAINT IF EXISTS imports_status_check;

ALTER TABLE imports
  ADD CONSTRAINT imports_status_check CHECK (
    status IN ('QUEUED', 'VALIDATING', 'READY_TO_APPLY', 'APPLYING',
               'CANCEL_REQUESTED', 'CANCELLED', 'COMPLETED', 'FAILED')
  );

CREATE INDEX IF NOT EXISTS imports_processing_idx
  ON imports (status, created_at, updated_at);
