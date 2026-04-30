-- Match lineups: announced team selections per round
-- One row per player per match (distinct from player_match_stats which tracks who actually played)

CREATE TABLE match_lineups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  guernsey_number INTEGER,
  position TEXT,
  is_emergency INTEGER NOT NULL DEFAULT 0,
  is_substitute INTEGER NOT NULL DEFAULT 0,
  UNIQUE (match_id, player_id)
);

CREATE INDEX idx_ml_match_id ON match_lineups(match_id);
CREATE INDEX idx_ml_player_id ON match_lineups(player_id);
CREATE INDEX idx_ml_team_match ON match_lineups(team_id, match_id);
