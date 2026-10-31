-- One push credential per device. NULL hash means none has been issued.
-- SQLite unique indexes allow many NULLs, so existing rows stay valid.
-- A non-null push_revoked_at keeps the hash on the row; lookup must reject it.

ALTER TABLE devices ADD COLUMN push_token_hash TEXT;
ALTER TABLE devices ADD COLUMN push_revoked_at INTEGER;
CREATE UNIQUE INDEX idx_devices_push_token_hash ON devices(push_token_hash);
