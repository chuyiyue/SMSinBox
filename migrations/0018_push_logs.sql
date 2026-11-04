CREATE TABLE push_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel_id TEXT,
  channel_name TEXT NOT NULL,
  channel_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  message_id TEXT,
  sender TEXT,
  preview TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_push_logs_user_created ON push_logs(user_id, created_at DESC);
