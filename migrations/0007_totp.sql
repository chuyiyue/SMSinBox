-- 批次 4：管理员两步验证（TOTP）。
-- 只追加，不改已有行：未启用 TOTP 的账号照旧用密码登录。
-- Secrets stay sealed: AES-GCM `enc1:` when CONTENT_KEY is set, otherwise
-- `plain:` (same trade-off as devices.secret). Never write them to logs.
-- Recovery codes are stored as SHA-256 hashes and consumed once.
-- totp_last_counter remembers the last accepted time step so a code cannot be
-- replayed (NULL on a fresh enrollment, set from the first verified login).

ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending_created_at INTEGER;
ALTER TABLE users ADD COLUMN totp_enabled_at INTEGER;
ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;

CREATE TABLE totp_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  used_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE UNIQUE INDEX idx_totp_recovery_user_hash ON totp_recovery_codes(user_id, code_hash);
CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id);

-- Short-lived ticket issued after the password step; exchanged for a session
-- with a TOTP or recovery code.
CREATE TABLE totp_tickets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX idx_totp_tickets_expires ON totp_tickets(expires_at);
CREATE INDEX idx_totp_tickets_user ON totp_tickets(user_id);
