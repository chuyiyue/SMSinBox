-- API tokens for external REST API and MCP server access
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  permissions TEXT NOT NULL DEFAULT '[]',
  device_scope TEXT NOT NULL DEFAULT '[]',
  expires_at INTEGER,
  disabled_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE INDEX api_tokens_user_id ON api_tokens (user_id);
CREATE INDEX api_tokens_token_hash ON api_tokens (token_hash);
