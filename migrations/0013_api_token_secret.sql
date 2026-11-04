-- Store the API token plaintext (sealed with CONTENT_KEY when configured)
-- so the owner can view and copy it at any time, not only at creation.
-- The hash column remains the authentication source of truth.
ALTER TABLE api_tokens ADD COLUMN token_enc TEXT;
