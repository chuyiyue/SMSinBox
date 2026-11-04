-- Owner-written remark on a push channel: set at creation, editable
-- later, shown on the channel card. Empty string means no remark.
ALTER TABLE notify_channels ADD COLUMN note TEXT NOT NULL DEFAULT '';
