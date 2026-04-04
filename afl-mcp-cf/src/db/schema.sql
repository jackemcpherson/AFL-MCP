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
  name TEXT NOT NULL UNIQUE
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
  weather_temp_c REAL,
  weather_type TEXT,
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

CREATE TABLE sync_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  rows_affected INTEGER DEFAULT 0,
  error TEXT
);
