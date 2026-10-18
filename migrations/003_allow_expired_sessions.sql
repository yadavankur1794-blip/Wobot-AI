ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_expiry_after_creation_check;
