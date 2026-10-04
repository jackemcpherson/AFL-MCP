-- Verified baseline: archived history is tagged migrations-pre-baseline.
-- AFL-MCP D1 schema and reference seeds (SQLite).
-- Verified from migrations 0027_baseline.sql on 2026-10-04.

CREATE TABLE coach_backfill_progress (
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  season INTEGER NOT NULL,
  cursor TEXT,
  assignments_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, season)
);

CREATE TABLE coach_external_ids (
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  external_coach_id TEXT NOT NULL,
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  display_name TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1)),
  PRIMARY KEY (provider, external_coach_id)
);

CREATE TABLE coach_external_match_ids (
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  external_match_id TEXT NOT NULL,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  PRIMARY KEY (provider, external_match_id)
);

CREATE TABLE coach_import_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  season INTEGER NOT NULL,
  scope TEXT NOT NULL,
  source_url TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE coach_import_pages (
  provider TEXT NOT NULL,
  season INTEGER NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  last_checked_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, season, scope)
);

CREATE TABLE coach_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  external_coach_id TEXT NOT NULL,
  external_match_id TEXT NOT NULL,
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  match_id INTEGER REFERENCES matches(id),
  team_id INTEGER REFERENCES teams(id),
  season INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  match_date TEXT,
  display_name TEXT NOT NULL,
  raw_team TEXT NOT NULL,
  home_points INTEGER,
  away_points INTEGER,
  UNIQUE (provider, external_coach_id, external_match_id, raw_team)
);

CREATE TABLE coaches (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  profile_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE competitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL
);

CREATE TABLE match_coaches (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  observation_id INTEGER NOT NULL REFERENCES coach_observations(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (match_id, team_id)
);

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

CREATE TABLE match_predictions (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  home_win_prob REAL NOT NULL,        -- 0..1, home team's win probability
  predicted_margin REAL NOT NULL,     -- positive = home favoured, one decimal
  model_version TEXT NOT NULL,        -- tipper config id, e.g. 'predha-080 (2641f46f)'
  generated_at TEXT NOT NULL, tipper_run_id INTEGER REFERENCES tipper_runs(id),
  PRIMARY KEY (match_id)
);

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

CREATE TABLE matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  round TEXT NOT NULL,
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
  away_q4_behinds INTEGER, round_abbreviation TEXT, status TEXT, live_period_status TEXT, completed_quarter INTEGER
  CHECK (completed_quarter IS NULL OR completed_quarter BETWEEN 0 AND 4), kickoff_at TEXT, lineups_observed_at TEXT,
  UNIQUE (date, home_team_id, away_team_id)
);

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

CREATE TABLE public_input_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  in_progress INTEGER NOT NULL DEFAULT 0 CHECK (in_progress IN (0, 1)),
  write_started_at TEXT
);

CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  year INTEGER NOT NULL, is_complete INTEGER NOT NULL DEFAULT 0,
  UNIQUE (competition_id, year)
);

CREATE TABLE sync_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  acquired_at TEXT
);

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  rows_affected INTEGER DEFAULT 0,
  error TEXT
);

CREATE TABLE teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  abbreviation TEXT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  UNIQUE (name, competition_id)
);

CREATE TABLE tipper_game_ids (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id),
  game_id INTEGER NOT NULL UNIQUE, year INTEGER NOT NULL, round INTEGER NOT NULL,
  home_team_id INTEGER NOT NULL, away_team_id INTEGER NOT NULL,
  squiggle_home_id INTEGER NOT NULL, squiggle_away_id INTEGER NOT NULL,
  home_name TEXT NOT NULL, away_name TEXT NOT NULL, observed_at TEXT NOT NULL
);

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

CREATE TABLE tipper_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL, week TEXT NOT NULL, observed_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ok','partial','failed')),
  evidence TEXT NOT NULL CHECK(json_valid(evidence)),
  result TEXT CHECK(result IS NULL OR json_valid(result)), error TEXT
);

CREATE TABLE tipper_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition TEXT NOT NULL CHECK (competition IN ('AFLM','AFLW')),
  season INTEGER NOT NULL, round INTEGER NOT NULL,
  started_at TEXT NOT NULL, source_revision TEXT NOT NULL, model_version TEXT NOT NULL,
  published_at TEXT, published_count INTEGER,
  finalized INTEGER NOT NULL DEFAULT 1 CHECK (finalized = 1)
);

CREATE TABLE tipper_status (
  id INTEGER PRIMARY KEY CHECK(id=1), activated_at TEXT NOT NULL,
  scheduler_at TEXT, reporting_at TEXT
);

CREATE TABLE venues (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
, latitude REAL, longitude REAL, timezone TEXT, roof TEXT, canonical_venue_id INTEGER REFERENCES venues(id));

CREATE INDEX idx_coach_diagnostics_open ON coach_import_diagnostics(provider, season, resolved_at);

CREATE UNIQUE INDEX idx_coach_diagnostics_scope_source ON coach_import_diagnostics(provider, season, scope, source_url);

CREATE INDEX idx_coach_observations_match ON coach_observations(match_id, provider);

CREATE INDEX idx_coach_observations_season ON coach_observations(season, provider);

CREATE INDEX idx_match_coaches_coach ON match_coaches(coach_id, match_id);

CREATE INDEX idx_matches_away_team_id ON matches(away_team_id);

CREATE INDEX idx_matches_date ON matches(date);

CREATE UNIQUE INDEX idx_matches_external_afl_id ON matches(external_afl_id) WHERE external_afl_id IS NOT NULL;

CREATE INDEX idx_matches_home_team_id ON matches(home_team_id);

CREATE INDEX idx_matches_season_id ON matches(season_id);

CREATE INDEX idx_matches_venue_id ON matches(venue_id);

CREATE INDEX idx_ml_match_id ON match_lineups(match_id);

CREATE INDEX idx_ml_player_id ON match_lineups(player_id);

CREATE INDEX idx_ml_team_match ON match_lineups(team_id, match_id);

CREATE INDEX idx_pav_season_total ON player_season_pav(season_id, total_pav DESC);

CREATE UNIQUE INDEX idx_players_external_afl_player_id ON players(external_afl_player_id) WHERE external_afl_player_id IS NOT NULL;

CREATE UNIQUE INDEX idx_players_external_id ON players(external_id) WHERE external_id IS NOT NULL;

CREATE INDEX idx_pms_match_id ON player_match_stats(match_id);

CREATE INDEX idx_pms_player_id ON player_match_stats(player_id);

CREATE INDEX idx_pms_player_team ON player_match_stats(player_id, team_id);

CREATE INDEX idx_pms_team_id ON player_match_stats(team_id);

CREATE INDEX matches_kickoff ON matches(kickoff_at, status);

CREATE INDEX tipper_predictions_match ON tipper_predictions(match_id,run_id DESC);

CREATE INDEX tipper_reports_week ON tipper_reports(season,week,id);

CREATE INDEX tipper_runs_round ON tipper_runs(competition,season,round,id);

CREATE VIEW v_integrity_brownlow AS
SELECT m.id AS match_id, m.date, m.round, x.total
FROM matches m
JOIN (
  SELECT pms.match_id, SUM(pms.brownlow_votes) AS total
  FROM player_match_stats pms
  GROUP BY pms.match_id
) x ON x.match_id = m.id
WHERE m.round_type = 'Regular'
  AND x.total > 0
  AND x.total != 6;

CREATE VIEW v_integrity_disposals AS
SELECT pms.id AS row_id, pms.match_id, pms.player_id, pms.kicks, pms.handballs, pms.disposals
FROM player_match_stats pms
WHERE pms.kicks IS NOT NULL
  AND pms.handballs IS NOT NULL
  AND pms.disposals IS NOT NULL
  AND pms.disposals != pms.kicks + pms.handballs;

CREATE VIEW v_integrity_margin AS
SELECT m.id AS match_id, m.home_points, m.away_points, m.margin
FROM matches m
WHERE m.margin IS NOT NULL
  AND m.home_points IS NOT NULL
  AND m.away_points IS NOT NULL
  AND m.margin != m.home_points - m.away_points;

CREATE VIEW v_integrity_match_points AS
SELECT m.id AS match_id,
       m.home_goals, m.home_behinds, m.home_points,
       m.away_goals, m.away_behinds, m.away_points
FROM matches m
WHERE (
  m.home_points IS NOT NULL
  AND m.home_goals IS NOT NULL
  AND m.home_behinds IS NOT NULL
  AND m.home_points != m.home_goals * 6 + m.home_behinds
) OR (
  m.away_points IS NOT NULL
  AND m.away_goals IS NOT NULL
  AND m.away_behinds IS NOT NULL
  AND m.away_points != m.away_goals * 6 + m.away_behinds
);

CREATE VIEW v_integrity_quarter_scores AS
SELECT m.id AS match_id
FROM matches m
WHERE m.home_q1_goals IS NOT NULL AND (
  m.home_goals != m.home_q1_goals + m.home_q2_goals + m.home_q3_goals + m.home_q4_goals
  OR m.home_behinds != m.home_q1_behinds + m.home_q2_behinds + m.home_q3_behinds + m.home_q4_behinds
  OR m.away_goals != m.away_q1_goals + m.away_q2_goals + m.away_q3_goals + m.away_q4_goals
  OR m.away_behinds != m.away_q1_behinds + m.away_q2_behinds + m.away_q3_behinds + m.away_q4_behinds
);

CREATE TRIGGER public_input_coach_name_update AFTER UPDATE OF display_name ON coaches
WHEN OLD.display_name IS NOT NEW.display_name AND EXISTS (
  SELECT 1 FROM match_coaches WHERE coach_id = NEW.id
) BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_coaches_delete AFTER DELETE ON match_coaches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_coaches_insert AFTER INSERT ON match_coaches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_coaches_update AFTER UPDATE OF coach_id, observation_id ON match_coaches
WHEN OLD.coach_id IS NOT NEW.coach_id OR OLD.observation_id IS NOT NEW.observation_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_competition_update AFTER UPDATE OF code ON competitions
WHEN OLD.code IS NOT NEW.code BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_matches_delete AFTER DELETE ON matches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_matches_insert AFTER INSERT ON matches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_matches_update AFTER UPDATE OF
  season_id, round, round_abbreviation, round_number, round_type, date, status, local_time,
  home_team_id, away_team_id, home_goals, home_behinds, home_points,
  away_goals, away_behinds, away_points, margin
ON matches WHEN
  OLD.season_id IS NOT NEW.season_id OR OLD.round IS NOT NEW.round OR
  OLD.round_abbreviation IS NOT NEW.round_abbreviation OR OLD.round_number IS NOT NEW.round_number OR
  OLD.round_type IS NOT NEW.round_type OR OLD.date IS NOT NEW.date OR
  OLD.status IS NOT NEW.status OR OLD.local_time IS NOT NEW.local_time OR
  OLD.home_team_id IS NOT NEW.home_team_id OR OLD.away_team_id IS NOT NEW.away_team_id OR
  OLD.home_goals IS NOT NEW.home_goals OR OLD.home_behinds IS NOT NEW.home_behinds OR
  OLD.home_points IS NOT NEW.home_points OR OLD.away_goals IS NOT NEW.away_goals OR
  OLD.away_behinds IS NOT NEW.away_behinds OR OLD.away_points IS NOT NEW.away_points OR
  OLD.margin IS NOT NEW.margin
BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_observation_url_update AFTER UPDATE OF source_url ON coach_observations
WHEN OLD.source_url IS NOT NEW.source_url AND EXISTS (
  SELECT 1 FROM match_coaches WHERE observation_id = NEW.id
) BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_season_update AFTER UPDATE OF year, competition_id ON seasons
WHEN OLD.year IS NOT NEW.year OR OLD.competition_id IS NOT NEW.competition_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_team_update AFTER UPDATE OF name, competition_id ON teams
WHEN OLD.name IS NOT NEW.name OR OLD.competition_id IS NOT NEW.competition_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

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

INSERT INTO competitions (id, code, name) VALUES (1, 'AFLM', 'AFL Men''s');
INSERT INTO competitions (id, code, name) VALUES (2, 'AFLW', 'AFL Women''s');
INSERT INTO sync_lease (id, holder, acquired_at) VALUES (1, NULL, NULL);
INSERT INTO public_input_revision (id, revision, in_progress, write_started_at) VALUES (1, 0, 0, NULL);

-- Replayable venue reference data, verified against production on 2026-10-04.
-- Names are the sync identity. Never assume the same numeric IDs in a fresh D1.
-- Preserve existing venue IDs and resolve canonical aliases after all inserts.

INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('MCG', -37.82, 144.9834, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Marvel Stadium', -37.8165, 144.9475, 'Australia/Melbourne', 'retractable')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Subiaco', -31.9442, 115.8299, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Football Park', -34.8797, 138.4956, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Gabba', -27.4858, 153.0381, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Princes Park', -37.7841, 144.9617, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('SCG', -33.8915, 151.2247, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Kardinia Park', -38.158, 144.3546, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Adelaide Oval', -34.9156, 138.5961, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Carrara', -28.0063, 153.367, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Waverley Park', -37.9256, 145.1866, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Perth Stadium', -31.9512, 115.8891, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Sydney Showground', -33.8434, 151.0678, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Casey Fields', -38.1073, 145.311, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Mission Whitten Oval', -37.7994, 144.8886, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Victoria Park', -37.7986, 144.9989, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('ETU Stadium', -37.8336, 144.9395, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('UTAS Stadium', -41.4256, 147.139, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Arden Street Oval', -37.7986, 144.9413, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('DSV Stadium', -37.8655, 144.8975, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Windy Hill', -37.7517, 144.9198, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Box Hill City Oval', -37.8137, 145.1174, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Wilson Storage Trevor Barker Beach Oval', -37.9455, 145.0027, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Western Oval', -37.7994, 144.8886, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Manuka Oval', -35.3182, 149.1345, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Kinetic Stadium', -38.1417, 145.1286, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Preston City Oval', -37.739, 145.0045, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Melbourne Avalon Airport Oval', -37.903, 144.656, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Brighton Homes Arena', -27.672, 152.906, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('W.A.C.A.', -31.9598, 115.8798, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Accor Stadium', -33.8474, 151.0631, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Fankhauser Reserve', -27.957, 153.375, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('To Be Confirmed', NULL, NULL, NULL, NULL)
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blacktown ISP', -33.7692, 150.8593, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('RSEA Park', -37.9366, 145.041, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Barry Plant Park', -37.7448, 144.97, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Swinburne Centre', -37.8225, 144.9866, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('TIO Stadium', -12.3992, 130.8872, 'Australia/Darwin', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Fremantle Oval', -32.0561, 115.7492, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Norwood Oval', -34.9202, 138.632, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('NEC Hangar', -37.724, 144.901, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('KGM Centre', -37.8243, 144.981, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Deakin University', -38.198, 144.296, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Henson Park', -33.9074, 151.158, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Tramway Oval', -33.8917, 151.2219, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Ninja Stadium', -42.8772, 147.3736, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Mineral Resources Park', -31.967, 115.905, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Moorabbin Oval', -37.9366, 145.041, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Domain Stadium', -31.9442, 115.8299, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Alberton Oval', -34.844, 138.52, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Mars Stadium', -37.5382, 143.8465, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blundstone Arena', -42.8772, 147.3736, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Cazalys Stadium', -16.936, 145.749, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('North Hobart Oval', -42.869, 147.318, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Moreton Bay Central Sports Complex', -27.157, 152.957, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('La Trobe University', -37.722, 145.048, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Traeger Park', -23.7081, 133.8745, 'Australia/Darwin', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Thomas Farms Oval', -34.946, 138.601, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Barossa Park', -34.6014, 138.8892, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('South Pine Sports Complex', -27.319, 152.98, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Hickey Park', -27.4075, 153.009, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Sullivan Logistics Stadium', -31.9366, 115.8419, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Great Barrier Reef Arena', -21.155, 149.178, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Kennedy Community Centre', -37.98, 145.13, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Graham Rd', -27.346, 153.024, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Austworld Centre Oval', -28.005, 153.364, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Wonthaggi Recreation Reserve', -38.608, 145.593, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Bill Lawry Oval', -37.77, 145.003, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Cockburn ARC Oval', -32.122, 115.845, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Tom Wills Oval', -33.842, 151.07, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('North Hobart', -42.869, 147.318, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Olympic Park Oval', -37.8243, 144.981, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('North Sydney Oval', -33.838, 151.208, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Jiangwan Stadium', 31.307, 121.517, 'Asia/Shanghai', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Wellington', -41.273, 174.7859, 'Pacific/Auckland', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Richmond Oval', -34.9445, 138.555, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Holm Park Recreation Reserve', -38.04, 145.375, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('C.ex Coffs International Stadium', -30.32, 153.109, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Highgate Recreation Reserve', -37.607, 144.915, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Hands Oval', -33.3336, 115.6519, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Thebarton Oval', -34.913, 138.566, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Drummoyne Oval', -33.852, 151.154, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Morwell Recreation Reserve', -38.232, 146.402, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Maroochydore', -26.644, 153.064, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Lakeside Oval Sydney', -33.8917, 151.2219, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('KFC Oval - Queens Park', -38.167, 144.332, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Dial Park', -41.129, 146.07, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Riverway Stadium', -19.3135, 146.739, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Bruce Stadium', -35.2496, 149.1013, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blacktown', -33.7692, 150.8593, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Rushton Park', -32.532, 115.725, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Ted Summerton Recreational Reserve', -38.176, 146.261, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Queen Elizabeth Oval', -36.76, 144.279, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Robertson Oval', -35.119, 147.37, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Magain Stadium', -35.144, 138.499, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Reid Oval Warrnambool', -38.379, 142.48, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Bond University', -28.076, 153.413, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Albury Sports Ground', -36.079, 146.92, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Central Reserve', -38.339, 143.588, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Narrandera Sports Ground', -34.748, 146.548, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Barossa Oval', -34.6014, 138.8892, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Summit Sports Park', -35.075, 138.88, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Unley Oval', -34.946, 138.601, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Victor George Kailis Oval', -32.122, 115.845, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blacktown International Sportspark', -33.7692, 150.8593, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Avalon Airport Oval', -37.903, 144.656, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;

UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'MCG') WHERE name = 'MCG';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Marvel Stadium') WHERE name = 'Marvel Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Subiaco') WHERE name = 'Subiaco';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Football Park') WHERE name = 'Football Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Gabba') WHERE name = 'Gabba';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Princes Park') WHERE name = 'Princes Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'SCG') WHERE name = 'SCG';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Kardinia Park') WHERE name = 'Kardinia Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Adelaide Oval') WHERE name = 'Adelaide Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Carrara') WHERE name = 'Carrara';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Waverley Park') WHERE name = 'Waverley Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Perth Stadium') WHERE name = 'Perth Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Sydney Showground') WHERE name = 'Sydney Showground';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Casey Fields') WHERE name = 'Casey Fields';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mission Whitten Oval') WHERE name = 'Mission Whitten Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Victoria Park') WHERE name = 'Victoria Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'ETU Stadium') WHERE name = 'ETU Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'UTAS Stadium') WHERE name = 'UTAS Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Arden Street Oval') WHERE name = 'Arden Street Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'DSV Stadium') WHERE name = 'DSV Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Windy Hill') WHERE name = 'Windy Hill';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Box Hill City Oval') WHERE name = 'Box Hill City Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Wilson Storage Trevor Barker Beach Oval') WHERE name = 'Wilson Storage Trevor Barker Beach Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mission Whitten Oval') WHERE name = 'Western Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Manuka Oval') WHERE name = 'Manuka Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Kinetic Stadium') WHERE name = 'Kinetic Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Preston City Oval') WHERE name = 'Preston City Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Melbourne Avalon Airport Oval') WHERE name = 'Melbourne Avalon Airport Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Brighton Homes Arena') WHERE name = 'Brighton Homes Arena';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'W.A.C.A.') WHERE name = 'W.A.C.A.';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Accor Stadium') WHERE name = 'Accor Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Fankhauser Reserve') WHERE name = 'Fankhauser Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'To Be Confirmed') WHERE name = 'To Be Confirmed';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Blacktown ISP') WHERE name = 'Blacktown ISP';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'RSEA Park') WHERE name = 'RSEA Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Barry Plant Park') WHERE name = 'Barry Plant Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Swinburne Centre') WHERE name = 'Swinburne Centre';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'TIO Stadium') WHERE name = 'TIO Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Fremantle Oval') WHERE name = 'Fremantle Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Norwood Oval') WHERE name = 'Norwood Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'NEC Hangar') WHERE name = 'NEC Hangar';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'KGM Centre') WHERE name = 'KGM Centre';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Deakin University') WHERE name = 'Deakin University';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Henson Park') WHERE name = 'Henson Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Tramway Oval') WHERE name = 'Tramway Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Ninja Stadium') WHERE name = 'Ninja Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mineral Resources Park') WHERE name = 'Mineral Resources Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'RSEA Park') WHERE name = 'Moorabbin Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Subiaco') WHERE name = 'Domain Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Alberton Oval') WHERE name = 'Alberton Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mars Stadium') WHERE name = 'Mars Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Ninja Stadium') WHERE name = 'Blundstone Arena';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Cazalys Stadium') WHERE name = 'Cazalys Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'North Hobart Oval') WHERE name = 'North Hobart Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Moreton Bay Central Sports Complex') WHERE name = 'Moreton Bay Central Sports Complex';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'La Trobe University') WHERE name = 'La Trobe University';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Traeger Park') WHERE name = 'Traeger Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Thomas Farms Oval') WHERE name = 'Thomas Farms Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Barossa Park') WHERE name = 'Barossa Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'South Pine Sports Complex') WHERE name = 'South Pine Sports Complex';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Hickey Park') WHERE name = 'Hickey Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Sullivan Logistics Stadium') WHERE name = 'Sullivan Logistics Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Great Barrier Reef Arena') WHERE name = 'Great Barrier Reef Arena';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Kennedy Community Centre') WHERE name = 'Kennedy Community Centre';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Graham Rd') WHERE name = 'Graham Rd';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Austworld Centre Oval') WHERE name = 'Austworld Centre Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Wonthaggi Recreation Reserve') WHERE name = 'Wonthaggi Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Bill Lawry Oval') WHERE name = 'Bill Lawry Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Cockburn ARC Oval') WHERE name = 'Cockburn ARC Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Tom Wills Oval') WHERE name = 'Tom Wills Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'North Hobart Oval') WHERE name = 'North Hobart';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'KGM Centre') WHERE name = 'Olympic Park Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'North Sydney Oval') WHERE name = 'North Sydney Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Jiangwan Stadium') WHERE name = 'Jiangwan Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Wellington') WHERE name = 'Wellington';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Richmond Oval') WHERE name = 'Richmond Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Holm Park Recreation Reserve') WHERE name = 'Holm Park Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'C.ex Coffs International Stadium') WHERE name = 'C.ex Coffs International Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Highgate Recreation Reserve') WHERE name = 'Highgate Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Hands Oval') WHERE name = 'Hands Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Thebarton Oval') WHERE name = 'Thebarton Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Drummoyne Oval') WHERE name = 'Drummoyne Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Morwell Recreation Reserve') WHERE name = 'Morwell Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Maroochydore') WHERE name = 'Maroochydore';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Tramway Oval') WHERE name = 'Lakeside Oval Sydney';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'KFC Oval - Queens Park') WHERE name = 'KFC Oval - Queens Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Dial Park') WHERE name = 'Dial Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Riverway Stadium') WHERE name = 'Riverway Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Bruce Stadium') WHERE name = 'Bruce Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Blacktown ISP') WHERE name = 'Blacktown';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Rushton Park') WHERE name = 'Rushton Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Ted Summerton Recreational Reserve') WHERE name = 'Ted Summerton Recreational Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Queen Elizabeth Oval') WHERE name = 'Queen Elizabeth Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Robertson Oval') WHERE name = 'Robertson Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Magain Stadium') WHERE name = 'Magain Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Reid Oval Warrnambool') WHERE name = 'Reid Oval Warrnambool';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Bond University') WHERE name = 'Bond University';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Albury Sports Ground') WHERE name = 'Albury Sports Ground';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Central Reserve') WHERE name = 'Central Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Narrandera Sports Ground') WHERE name = 'Narrandera Sports Ground';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Barossa Park') WHERE name = 'Barossa Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Summit Sports Park') WHERE name = 'Summit Sports Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Thomas Farms Oval') WHERE name = 'Unley Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Cockburn ARC Oval') WHERE name = 'Victor George Kailis Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Blacktown ISP') WHERE name = 'Blacktown International Sportspark';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Melbourne Avalon Airport Oval') WHERE name = 'Avalon Airport Oval';
