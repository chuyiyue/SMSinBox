-- Per-user push channels. config is JSON. Secrets stay in this table, not in logs.

CREATE TABLE notify_channels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_notify_user ON notify_channels(user_id);
