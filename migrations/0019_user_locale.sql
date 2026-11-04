-- UI language. zh-CN is the default so existing users keep today's Chinese UI.
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-CN';
