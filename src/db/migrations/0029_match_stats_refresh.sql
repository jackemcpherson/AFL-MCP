CREATE TABLE match_stats_refresh (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
  completed_observed_at TEXT NOT NULL,
  attempted_at TEXT,
  succeeded_at TEXT,
  next_retry_at TEXT,
  provider_updated_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  participant_count INTEGER,
  diagnostic TEXT
);
CREATE INDEX idx_match_stats_refresh_due ON match_stats_refresh(next_retry_at, match_id);
