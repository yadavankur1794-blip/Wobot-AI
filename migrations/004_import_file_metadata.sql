ALTER TABLE imports
  ADD COLUMN IF NOT EXISTS file_size_bytes BIGINT NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'imports_file_size_nonnegative_check'
  ) THEN
    ALTER TABLE imports
      ADD CONSTRAINT imports_file_size_nonnegative_check CHECK (file_size_bytes >= 0);
  END IF;
END
$$;
