-- Store the device push secret (sealed with CONTENT_KEY when configured)
-- so the owner can view the push URL at any time, not only once at issue.
-- The hash columns remain the authentication source of truth.
ALTER TABLE devices ADD COLUMN push_token_enc TEXT;
