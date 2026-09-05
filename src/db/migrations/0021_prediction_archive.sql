-- Prospective tipper prediction and lineup archive (Task 41).
--
-- Additive and expand-contract safe: the previous AFL-MCP Worker never
-- reads prediction_archive. Existing match_predictions consumers are unchanged.
-- Tipper skips archive writes with a warning until this migration is applied.
--
-- One immutable capture per match and model. Tipper uses INSERT only, never
-- UPDATE, REPLACE or DELETE. A repeated capture key cannot replace evidence.
-- The row includes the round's field snapshot filtered to this game's sources,
-- so a capture retains all sources without duplicating the whole round per game.
-- Weather stays in match_weather; join by match_id and kind = 'forecast'.

CREATE TABLE prediction_archive (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  model_version TEXT NOT NULL,
  captured_at TEXT NOT NULL,          -- UTC ISO-8601, after prediction completes
  competition TEXT NOT NULL,
  season_year INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  round_first_kickoff TEXT NOT NULL,  -- Melbourne wall time, YYYY-MM-DDTHH:MM:SS
  match_kickoff TEXT NOT NULL,        -- Melbourne wall time; NULL time becomes midnight
  is_primary INTEGER NOT NULL CHECK (is_primary IN (0, 1)),
  home_win_prob REAL NOT NULL CHECK (home_win_prob BETWEEN 0 AND 1),
  predicted_margin REAL NOT NULL,     -- published precision, positive = home favoured
  lineups_json TEXT NOT NULL CHECK (json_valid(lineups_json)),
  inputs_json TEXT NOT NULL CHECK (json_valid(inputs_json)),
  field_json TEXT CHECK (field_json IS NULL OR json_valid(field_json)),
  field_captured_at TEXT,             -- NULL when Squiggle capture failed
  PRIMARY KEY (match_id, model_version, captured_at)
);

CREATE INDEX idx_prediction_archive_season
  ON prediction_archive (competition, season_year, match_id, captured_at);
