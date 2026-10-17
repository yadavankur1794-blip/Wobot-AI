CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions (user_id);

CREATE INDEX IF NOT EXISTS sessions_expiry_idx
  ON sessions (expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_expiry_after_creation_check
  CHECK (expires_at > created_at);
