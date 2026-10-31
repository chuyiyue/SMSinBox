-- Bookkeeping for the single-admin inbox.
-- This file does not choose an admin and does not delete users, sessions,
-- devices, or messages. Wrangler applies SQL without ADMIN_USERNAME, so
-- guessing a survivor here could drop the real account.
-- The next successful login of that username runs the merge in the worker:
--   1. point devices.user_id and notify_channels.user_id at that admin
--   2. delete every other session (do not attach old cookies to the admin)
--   3. delete every other user row
-- Messages, token_hash, and push_token_hash stay put. The users table stays.

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
