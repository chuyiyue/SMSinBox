-- Owner-defined sidebar order for device groups: the devices page lists
-- groups by sort_order (ties fall back to creation order), and the group
-- menu's move up/down swaps neighbouring values.
ALTER TABLE device_groups ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
