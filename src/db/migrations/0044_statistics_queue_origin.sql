ALTER TABLE match_stats_refresh ADD COLUMN origin TEXT NOT NULL DEFAULT 'operator' CHECK(origin IN ('operator','scheduled'));
