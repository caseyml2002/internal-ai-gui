-- 使用者會話表：以 user_hash 隔離，每個 ZTNA 使用者只能存取自己的會話
CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  user_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  messages TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ai_sessions_user
  ON ai_sessions(user_hash, updated_at DESC);
