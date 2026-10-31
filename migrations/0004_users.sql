-- role is admin or member. disabled_at set means the account cannot log in.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN disabled_at INTEGER;
