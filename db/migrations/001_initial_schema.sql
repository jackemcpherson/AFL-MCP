-- AFL-MCP: Initial database schema
-- Normalised schema for AFL match results, player stats, and related entities.

BEGIN;

-- Track applied migrations
CREATE TABLE IF NOT EXISTS schema_migrations (
    version     INTEGER PRIMARY KEY,
    filename    TEXT NOT NULL,
    applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Competitions (AFLM, future AFLW)
CREATE TABLE competitions (
    id      SERIAL PRIMARY KEY,
    code    VARCHAR(10) NOT NULL UNIQUE,   -- 'AFLM', 'AFLW'
    name    VARCHAR(100) NOT NULL          -- 'AFL Men''s', 'AFL Women''s'
);

INSERT INTO competitions (code, name) VALUES
    ('AFLM', 'AFL Men''s'),
    ('AFLW', 'AFL Women''s');

-- Seasons
CREATE TABLE seasons (
    id              SERIAL PRIMARY KEY,
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    year            INTEGER NOT NULL,
    UNIQUE (competition_id, year)
);

-- Teams
CREATE TABLE teams (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    abbreviation    VARCHAR(20),
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    UNIQUE (name, competition_id)
);

-- Venues
CREATE TABLE venues (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(200) NOT NULL UNIQUE
);

-- Players
CREATE TABLE players (
    id              SERIAL PRIMARY KEY,
    first_name      VARCHAR(100),
    surname         VARCHAR(100) NOT NULL,
    team_id         INTEGER REFERENCES teams(id),
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    external_id     VARCHAR(50),
    date_of_birth   DATE,
    height_cm       INTEGER,
    weight_kg       INTEGER,
    UNIQUE (external_id, competition_id)
);

-- Matches
CREATE TABLE matches (
    id                  SERIAL PRIMARY KEY,
    season_id           INTEGER NOT NULL REFERENCES seasons(id),
    round               VARCHAR(20) NOT NULL,
    round_number        INTEGER,
    round_type          VARCHAR(20) DEFAULT 'Regular',
    date                DATE,
    venue_id            INTEGER REFERENCES venues(id),
    home_team_id        INTEGER NOT NULL REFERENCES teams(id),
    away_team_id        INTEGER NOT NULL REFERENCES teams(id),
    home_goals          INTEGER,
    home_behinds        INTEGER,
    home_points         INTEGER,
    away_goals          INTEGER,
    away_behinds        INTEGER,
    away_points         INTEGER,
    margin              INTEGER,
    external_game_id    VARCHAR(50),
    UNIQUE (external_game_id)
);

-- Player match statistics
CREATE TABLE player_match_stats (
    id                          SERIAL PRIMARY KEY,
    match_id                    INTEGER NOT NULL REFERENCES matches(id),
    player_id                   INTEGER NOT NULL REFERENCES players(id),
    team_id                     INTEGER NOT NULL REFERENCES teams(id),
    -- Time
    time_on_ground_pct          NUMERIC(5,1),
    -- Core stats
    kicks                       INTEGER,
    handballs                   INTEGER,
    disposals                   INTEGER,
    marks                       INTEGER,
    bounces                     INTEGER,
    tackles                     INTEGER,
    -- Possessions
    contested_possessions       INTEGER,
    uncontested_possessions     INTEGER,
    total_possessions           INTEGER,
    -- Inside 50
    inside_50s                  INTEGER,
    marks_inside_50             INTEGER,
    contested_marks             INTEGER,
    -- Hitouts / defence
    hitouts                     INTEGER,
    one_percenters              INTEGER,
    -- Efficiency
    disposal_efficiency         NUMERIC(5,1),
    clangers                    INTEGER,
    -- Free kicks
    frees_for                   INTEGER,
    frees_against               INTEGER,
    -- Scoring
    goals                       INTEGER,
    behinds                     INTEGER,
    goal_assists                INTEGER,
    shots_at_goal               INTEGER,
    score_involvements          INTEGER,
    -- Clearances
    centre_clearances           INTEGER,
    stoppage_clearances         INTEGER,
    total_clearances            INTEGER,
    -- Other
    rebound_50s                 INTEGER,
    turnovers                   INTEGER,
    intercepts                  INTEGER,
    tackles_inside_50           INTEGER,
    -- Advanced (fryzigg)
    metres_gained               INTEGER,
    pressure_acts               INTEGER,
    effective_kicks             INTEGER,
    kick_efficiency             NUMERIC(5,1),
    ground_ball_gets            INTEGER,
    intercept_marks             INTEGER,
    f50_ground_ball_gets        INTEGER,
    score_launches              INTEGER,
    -- Fantasy
    fantasy_points              INTEGER,
    supercoach_score            INTEGER,
    UNIQUE (match_id, player_id)
);

-- Indexes for common query patterns
CREATE INDEX idx_matches_date ON matches(date);
CREATE INDEX idx_matches_season_id ON matches(season_id);
CREATE INDEX idx_matches_home_team ON matches(home_team_id);
CREATE INDEX idx_matches_away_team ON matches(away_team_id);
CREATE INDEX idx_matches_venue ON matches(venue_id);

CREATE INDEX idx_player_match_stats_match ON player_match_stats(match_id);
CREATE INDEX idx_player_match_stats_player ON player_match_stats(player_id);
CREATE INDEX idx_player_match_stats_team ON player_match_stats(team_id);

CREATE INDEX idx_players_surname ON players(surname);
CREATE INDEX idx_players_team ON players(team_id);
CREATE INDEX idx_players_competition ON players(competition_id);
CREATE INDEX idx_players_external_id ON players(external_id);

CREATE INDEX idx_seasons_competition ON seasons(competition_id);
CREATE INDEX idx_seasons_year ON seasons(year);

COMMIT;
