-- How messages.code was produced: 'regex' or 'workers-ai'; NULL when there is no code.
-- Every pre-existing row that has a code came from the keyword regex, so backfill it.
ALTER TABLE messages ADD COLUMN code_source TEXT;
UPDATE messages SET code_source = 'regex' WHERE code IS NOT NULL;
