-- 1 when content, code, and raw_payload are AES-GCM ciphertext (enc1:...).
-- Older rows stay 0 and remain plaintext.

ALTER TABLE messages ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;
