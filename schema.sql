
CREATE TABLE IF NOT EXISTS ai_audit_logs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  user_email TEXT NOT NULL,
  user_hash TEXT NOT NULL,
  user_sub TEXT,
  team TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  gateway_id TEXT NOT NULL,
  prompt_chars INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_message TEXT,
  client_ip TEXT,
  country TEXT
);

CREATE INDEX IF NOT EXISTS idx_ai_audit_user_hash ON ai_audit_logs(user_hash);
CREATE INDEX IF NOT EXISTS idx_ai_audit_created_at ON ai_audit_logs(created_at);
