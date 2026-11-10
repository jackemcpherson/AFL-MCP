-- Health, recovery checks and the lineup-rejection dedupe read sync_log by
-- type and recency; the hourly purge deletes by timestamp. Without indexes
-- each read scans the whole log.
CREATE INDEX IF NOT EXISTS idx_sync_log_type_timestamp ON sync_log(type, timestamp);
CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
