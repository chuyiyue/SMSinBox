-- Device pins (sidebar) and user-defined device groups.
-- pinned_at: when the owner pinned the device to the sidebar (NULL = not
-- pinned; the sidebar shows at most 5). group_id: the device group the
-- owner filed the device under (NULL = ungrouped).
ALTER TABLE devices ADD COLUMN pinned_at INTEGER;
ALTER TABLE devices ADD COLUMN group_id TEXT;

CREATE TABLE IF NOT EXISTS device_groups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_device_groups_user ON device_groups (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_devices_group ON devices (group_id);
