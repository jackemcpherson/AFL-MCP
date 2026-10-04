CREATE TABLE weather_refresh_state (
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('observed','forecast')),
  source TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  next_retry_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  diagnostic TEXT,
  PRIMARY KEY(match_id,kind,source)
);
