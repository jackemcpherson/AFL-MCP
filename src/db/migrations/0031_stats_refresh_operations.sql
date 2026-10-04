CREATE TABLE stats_refresh_operations (
  id TEXT PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  match_id INTEGER REFERENCES matches(id),
  manifest_digest TEXT NOT NULL,
  requested_at TEXT NOT NULL
);
CREATE TABLE stats_refresh_operation_matches (
  operation_id TEXT NOT NULL REFERENCES stats_refresh_operations(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'complete')),
  PRIMARY KEY(operation_id, match_id)
);
