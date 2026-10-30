-- SMSinBox MVP schema.
-- messages.content_hash stores the dedup key:
-- sha256(device_id + from + normalized content + floor(received_at / 60s))

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  secret TEXT,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  from_number TEXT NOT NULL,
  to_number TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  code TEXT,
  raw_payload TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (device_id) REFERENCES devices(id)
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE rate_limits (
  token_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (token_hash, window_start)
);

CREATE INDEX idx_devices_user ON devices(user_id);
CREATE INDEX idx_messages_device_received ON messages(device_id, received_at DESC);
CREATE INDEX idx_messages_code ON messages(code);
CREATE INDEX idx_messages_created ON messages(created_at);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
