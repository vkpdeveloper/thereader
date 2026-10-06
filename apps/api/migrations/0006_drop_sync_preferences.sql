-- Reader settings are per-device and no longer synced. The Worker
-- acknowledges legacy `preferences` changes without storing them.
DROP TABLE IF EXISTS sync_preferences;
