-- Additive. Apply through AFL-MCP before activating the new Tipper publisher.
ALTER TABLE matches ADD COLUMN kickoff_at TEXT;
ALTER TABLE matches ADD COLUMN lineups_observed_at TEXT;
CREATE INDEX matches_kickoff ON matches(kickoff_at, status);
CREATE TABLE tipper_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition TEXT NOT NULL CHECK (competition IN ('AFLM','AFLW')),
  season INTEGER NOT NULL, round INTEGER NOT NULL,
  started_at TEXT NOT NULL, source_revision TEXT NOT NULL, model_version TEXT NOT NULL,
  published_at TEXT, published_count INTEGER,
  finalized INTEGER NOT NULL DEFAULT 1 CHECK (finalized = 1)
);
CREATE INDEX tipper_runs_round ON tipper_runs(competition,season,round,id);
CREATE TABLE tipper_predictions (
  run_id INTEGER NOT NULL REFERENCES tipper_runs(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  season_id INTEGER NOT NULL, round_number INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL, away_team_id INTEGER NOT NULL,
  venue_id INTEGER, external_afl_id TEXT, kickoff_at TEXT NOT NULL,
  margin REAL NOT NULL, home_probability REAL NOT NULL CHECK(home_probability BETWEEN .01 AND .99),
  winner TEXT NOT NULL CHECK(winner IN ('home','away')),
  issued_margin REAL NOT NULL, issued_probability REAL NOT NULL,
  provisional INTEGER NOT NULL CHECK(provisional IN (0,1)),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  observed_at TEXT NOT NULL, published_at TEXT NOT NULL,
  PRIMARY KEY(run_id,match_id)
);
CREATE INDEX tipper_predictions_match ON tipper_predictions(match_id,run_id DESC);
ALTER TABLE match_predictions ADD COLUMN tipper_run_id INTEGER REFERENCES tipper_runs(id);
CREATE TABLE tipper_game_ids (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id),
  game_id INTEGER NOT NULL UNIQUE, year INTEGER NOT NULL, round INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL, away_team_id INTEGER NOT NULL,
  squiggle_home_id INTEGER NOT NULL, squiggle_away_id INTEGER NOT NULL,
  home_name TEXT NOT NULL, away_name TEXT NOT NULL, observed_at TEXT NOT NULL
);
CREATE TABLE tipper_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL, week TEXT NOT NULL, observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','partial','failed')),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT
);
CREATE INDEX tipper_reports_week ON tipper_reports(season,week,id);
CREATE TABLE tipper_status (
  id INTEGER PRIMARY KEY CHECK(id=1), activated_at TEXT NOT NULL,
  scheduler_at TEXT, reporting_at TEXT
);
-- Never invent kickoff times for legacy rows. A source refresh populates them.
CREATE TRIGGER tipper_fixture_change AFTER UPDATE OF season_id,round_number,
  home_team_id,away_team_id,venue_id,external_afl_id,kickoff_at ON matches
WHEN OLD.season_id IS NOT NEW.season_id OR OLD.round_number IS NOT NEW.round_number
  OR OLD.home_team_id IS NOT NEW.home_team_id OR OLD.away_team_id IS NOT NEW.away_team_id
  OR OLD.venue_id IS NOT NEW.venue_id OR OLD.external_afl_id IS NOT NEW.external_afl_id
  OR OLD.kickoff_at IS NOT NEW.kickoff_at
BEGIN
  DELETE FROM match_predictions WHERE match_id=NEW.id;
  DELETE FROM tipper_game_ids WHERE match_id=NEW.id;
  UPDATE matches SET lineups_observed_at=NULL WHERE id=NEW.id AND lineups_observed_at IS NOT NULL;
END;
