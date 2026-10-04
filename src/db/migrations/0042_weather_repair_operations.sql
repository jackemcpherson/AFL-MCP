CREATE TABLE weather_repair_operations (
  manifest_digest TEXT PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','complete'))
);
