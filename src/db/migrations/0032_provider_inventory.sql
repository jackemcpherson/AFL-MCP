CREATE TABLE season_provider_inventory (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  provider TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  matches_json TEXT NOT NULL CHECK(json_valid(matches_json)),
  PRIMARY KEY(season_id, provider)
);
