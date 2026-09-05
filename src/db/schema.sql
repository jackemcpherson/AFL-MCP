-- AFL-MCP D1 Schema (SQLite)
-- Consolidated from PostgreSQL migrations 003-009

CREATE TABLE competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

INSERT INTO competitions (code, name) VALUES ('AFLM', 'AFL Men''s');
INSERT INTO competitions (code, name) VALUES ('AFLW', 'AFL Women''s');

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  year INTEGER NOT NULL,
  is_complete INTEGER NOT NULL DEFAULT 0,
  UNIQUE (competition_id, year)
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  abbreviation TEXT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  UNIQUE (name, competition_id)
);

CREATE TABLE venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  latitude REAL,
  longitude REAL,
  timezone TEXT,                                     -- IANA
  roof TEXT,                                         -- 'retractable' | 'none'
  canonical_venue_id INTEGER REFERENCES venues(id)   -- physical ground: self for canonical rows, another row's id for sponsor-rename aliases, NULL for venues not yet classified (fresh sync inserts). Group by physical ground via COALESCE(canonical_venue_id, id).
);

CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name TEXT,
  surname TEXT NOT NULL,
  external_id TEXT,
  external_afl_player_id TEXT,
  date_of_birth TEXT,
  height_cm INTEGER,
  weight_kg INTEGER,
  is_retired INTEGER DEFAULT 0
);

CREATE UNIQUE INDEX idx_players_external_id ON players(external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX idx_players_external_afl_player_id ON players(external_afl_player_id) WHERE external_afl_player_id IS NOT NULL;

CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  round TEXT NOT NULL,
  round_abbreviation TEXT,
  round_number INTEGER,
  round_type TEXT DEFAULT 'Regular',
  date TEXT NOT NULL,
  local_time TEXT,
  venue_id INTEGER REFERENCES venues(id),
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  home_goals INTEGER,
  home_behinds INTEGER,
  home_points INTEGER,
  away_goals INTEGER,
  away_behinds INTEGER,
  away_points INTEGER,
  margin INTEGER,
  attendance INTEGER,
  external_afltables_id TEXT UNIQUE,
  external_fryzigg_id TEXT UNIQUE,
  external_afl_id TEXT,
  home_rushed_behinds INTEGER,
  away_rushed_behinds INTEGER,
  home_minutes_in_front INTEGER,
  away_minutes_in_front INTEGER,
  home_q1_goals INTEGER,
  home_q1_behinds INTEGER,
  home_q2_goals INTEGER,
  home_q2_behinds INTEGER,
  home_q3_goals INTEGER,
  home_q3_behinds INTEGER,
  home_q4_goals INTEGER,
  home_q4_behinds INTEGER,
  away_q1_goals INTEGER,
  away_q1_behinds INTEGER,
  away_q2_goals INTEGER,
  away_q2_behinds INTEGER,
  away_q3_goals INTEGER,
  away_q3_behinds INTEGER,
  away_q4_goals INTEGER,
  away_q4_behinds INTEGER,
  status TEXT,
  live_period_status TEXT,
  completed_quarter INTEGER CHECK (completed_quarter IS NULL OR completed_quarter BETWEEN 0 AND 4),
  UNIQUE (date, home_team_id, away_team_id)
);

CREATE UNIQUE INDEX idx_matches_external_afl_id ON matches(external_afl_id) WHERE external_afl_id IS NOT NULL;
CREATE INDEX idx_matches_date ON matches(date);
CREATE INDEX idx_matches_season_id ON matches(season_id);
CREATE INDEX idx_matches_home_team_id ON matches(home_team_id);
CREATE INDEX idx_matches_away_team_id ON matches(away_team_id);
CREATE INDEX idx_matches_venue_id ON matches(venue_id);

CREATE TABLE player_match_stats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  player_id INTEGER NOT NULL REFERENCES players(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  guernsey_number INTEGER,
  player_position TEXT,
  subbed TEXT,
  time_on_ground_pct REAL,
  kicks INTEGER,
  handballs INTEGER,
  disposals INTEGER,
  effective_disposals INTEGER,
  disposal_efficiency_pct REAL,
  marks INTEGER,
  bounces INTEGER,
  tackles INTEGER,
  one_percenters INTEGER,
  clangers INTEGER,
  contested_possessions INTEGER,
  uncontested_possessions INTEGER,
  goals INTEGER,
  behinds INTEGER,
  goal_assists INTEGER,
  shots_at_goal INTEGER,
  score_involvements INTEGER,
  score_launches INTEGER,
  centre_clearances INTEGER,
  stoppage_clearances INTEGER,
  clearances INTEGER,
  contested_marks INTEGER,
  marks_inside_fifty INTEGER,
  intercept_marks INTEGER,
  marks_on_lead INTEGER,
  free_kicks_for INTEGER,
  free_kicks_against INTEGER,
  hitouts INTEGER,
  hitouts_to_advantage INTEGER,
  hitout_win_pct REAL,
  ruck_contests INTEGER,
  inside_fifties INTEGER,
  rebounds INTEGER,
  turnovers INTEGER,
  intercepts INTEGER,
  metres_gained INTEGER,
  pressure_acts INTEGER,
  def_half_pressure_acts INTEGER,
  tackles_inside_fifty INTEGER,
  spoils INTEGER,
  contest_def_losses INTEGER,
  contest_def_one_on_ones INTEGER,
  contest_off_one_on_ones INTEGER,
  contest_off_wins INTEGER,
  effective_kicks INTEGER,
  ground_ball_gets INTEGER,
  f50_ground_ball_gets INTEGER,
  brownlow_votes INTEGER,
  rating_points REAL,
  afl_fantasy_score INTEGER,
  supercoach_score INTEGER,
  goal_accuracy REAL,
  goal_efficiency REAL,
  shot_efficiency REAL,
  kick_efficiency REAL,
  kick_to_handball_ratio REAL,
  contested_possession_rate REAL,
  contest_def_loss_pct REAL,
  contest_off_wins_pct REAL,
  centre_bounce_attendances INTEGER,
  kickins INTEGER,
  kickins_playon INTEGER,
  interchange_counts INTEGER,
  total_possessions INTEGER,
  UNIQUE (match_id, player_id)
);

CREATE INDEX idx_pms_match_id ON player_match_stats(match_id);
CREATE INDEX idx_pms_player_id ON player_match_stats(player_id);
CREATE INDEX idx_pms_team_id ON player_match_stats(team_id);
CREATE INDEX idx_pms_player_team ON player_match_stats(player_id, team_id);

CREATE TABLE player_season_pav (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL REFERENCES players(id),
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  off_pav REAL,
  mid_pav REAL,
  def_pav REAL,
  total_pav REAL,
  UNIQUE (player_id, season_id, team_id)
);

CREATE INDEX idx_pav_season_total ON player_season_pav(season_id, total_pav DESC);

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

-- Match-window weather from Open-Meteo (migration 0014). Up to two rows per
-- match: kind='forecast' (overwritten in place per refresh, kept after the
-- match) and kind='observed'. Metrics are a 3-hour window from scheduled
-- start plus prior-24h rainfall.
CREATE TABLE match_weather (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  kind TEXT NOT NULL CHECK (kind IN ('observed','forecast')),
  temp_c REAL,               -- 3h mean from scheduled start
  precip_mm REAL,            -- 3h total, match window
  precip_24h_prior_mm REAL,  -- ground condition
  wind_speed_kmh REAL,       -- 3h max
  wind_gust_kmh REAL,        -- 3h max
  humidity_pct REAL,         -- 3h mean
  source TEXT NOT NULL,      -- 'era5_land+era5' | 'historical_forecast' | 'best_match'
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (match_id, kind)
);

-- Match predictions from the tipper model (migration 0015). One row per
-- match, overwritten on regeneration. Written by tipper via the D1 REST
-- API; this Worker only reads it.
CREATE TABLE match_predictions (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  home_win_prob REAL NOT NULL,        -- 0..1, home team's win probability
  predicted_margin REAL NOT NULL,     -- positive = home favoured, one decimal
  model_version TEXT NOT NULL,        -- tipper config id, e.g. 'predha-080 (2641f46f)'
  generated_at TEXT NOT NULL,
  PRIMARY KEY (match_id)
);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  rows_affected INTEGER DEFAULT 0,
  error TEXT
);

-- Single-row lease for cron/admin sync mutual exclusion (migration 0012).
CREATE TABLE sync_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  acquired_at TEXT
);

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
