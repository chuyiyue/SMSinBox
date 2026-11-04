-- Remember which client created each login session so the session list can
-- show the browser, device type, and IP address. Older rows stay NULL and
-- render as unknown.
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
