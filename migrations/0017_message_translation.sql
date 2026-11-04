-- Optional SMS translation. translated_content follows the same CONTENT_KEY
-- seal as content and code. source_lang is a plaintext language code.
-- translate_enabled defaults off so existing installs keep today's behavior.
ALTER TABLE messages ADD COLUMN translated_content TEXT;
ALTER TABLE messages ADD COLUMN source_lang TEXT;
ALTER TABLE users ADD COLUMN translate_enabled INTEGER NOT NULL DEFAULT 0;
