-- AFL-MCP: Schema redesign
-- Fixes: player team tracking, missing columns, dead columns, dual external IDs,
--        venue normalisation, SMALLINT types for stat columns.
-- This is a destructive migration — all data must be reloaded from CSVs.

BEGIN;

-- Drop existing tables in dependency order
DROP TABLE IF EXISTS match_summaries CASCADE;
DROP TABLE IF EXISTS player_season_summaries CASCADE;
DROP TABLE IF EXISTS player_match_stats CASCADE;
DROP TABLE IF EXISTS matches CASCADE;
DROP TABLE IF EXISTS players CASCADE;
DROP TABLE IF EXISTS seasons CASCADE;
DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS venues CASCADE;
DROP TABLE IF EXISTS competitions CASCADE;

-- ============================================================
-- COMPETITIONS
-- ============================================================
CREATE TABLE competitions (
    id      SERIAL PRIMARY KEY,
    code    VARCHAR(10)  NOT NULL UNIQUE,
    name    VARCHAR(100) NOT NULL
);

INSERT INTO competitions (code, name) VALUES
    ('AFLM', 'AFL Men''s'),
    ('AFLW', 'AFL Women''s');

-- ============================================================
-- SEASONS
-- ============================================================
CREATE TABLE seasons (
    id              SERIAL PRIMARY KEY,
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    year            INTEGER NOT NULL,
    UNIQUE (competition_id, year)
);

-- ============================================================
-- TEAMS
-- ============================================================
CREATE TABLE teams (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    abbreviation    VARCHAR(20),
    competition_id  INTEGER NOT NULL REFERENCES competitions(id),
    UNIQUE (name, competition_id)
);

-- ============================================================
-- VENUES
-- ============================================================
CREATE TABLE venues (
    id      SERIAL PRIMARY KEY,
    name    VARCHAR(200) NOT NULL UNIQUE
);

-- ============================================================
-- PLAYERS
-- A player is a person. No team_id — team membership is tracked
-- per-match in player_match_stats. external_id is the fryzigg
-- player_id (unique per person, stable across team changes).
-- ============================================================
CREATE TABLE players (
    id              SERIAL PRIMARY KEY,
    first_name      VARCHAR(100),
    surname         VARCHAR(100) NOT NULL,
    external_id     VARCHAR(50)  NOT NULL UNIQUE,
    date_of_birth   DATE,
    height_cm       SMALLINT,
    weight_kg       SMALLINT,
    is_retired      BOOLEAN DEFAULT FALSE
);

-- ============================================================
-- MATCHES
-- Stores both external ID systems:
--   external_afltables_id: "Game" from results.csv
--   external_fryzigg_id:   "match_id" from player_stats.csv
-- Match metadata (time, attendance, weather) stored inline.
-- ============================================================
CREATE TABLE matches (
    id                      SERIAL PRIMARY KEY,
    season_id               INTEGER     NOT NULL REFERENCES seasons(id),
    round                   VARCHAR(20) NOT NULL,
    round_number            SMALLINT,
    round_type              VARCHAR(20) DEFAULT 'Regular',
    date                    DATE        NOT NULL,
    local_time              TIME,
    venue_id                INTEGER     REFERENCES venues(id),
    home_team_id            INTEGER     NOT NULL REFERENCES teams(id),
    away_team_id            INTEGER     NOT NULL REFERENCES teams(id),
    home_goals              SMALLINT,
    home_behinds            SMALLINT,
    home_points             SMALLINT,
    away_goals              SMALLINT,
    away_behinds            SMALLINT,
    away_points             SMALLINT,
    margin                  SMALLINT,
    attendance              INTEGER,
    weather_temp_c          NUMERIC(4,1),
    weather_type            VARCHAR(50),
    external_afltables_id   VARCHAR(50) UNIQUE,
    external_fryzigg_id     VARCHAR(50) UNIQUE
);

-- ============================================================
-- PLAYER MATCH STATS
-- Per-player per-match statistics. team_id is the authoritative
-- record of which team a player represented in each game.
-- ALL fryzigg stat columns are included.
-- ============================================================
CREATE TABLE player_match_stats (
    id                              SERIAL PRIMARY KEY,
    match_id                        INTEGER NOT NULL REFERENCES matches(id),
    player_id                       INTEGER NOT NULL REFERENCES players(id),
    team_id                         INTEGER NOT NULL REFERENCES teams(id),

    -- Per-game metadata
    guernsey_number                 SMALLINT,
    player_position                 VARCHAR(20),
    subbed                          VARCHAR(30),

    -- Time
    time_on_ground_pct              NUMERIC(5,1),

    -- Core stats
    kicks                           SMALLINT,
    handballs                       SMALLINT,
    disposals                       SMALLINT,
    effective_disposals             SMALLINT,
    disposal_efficiency_pct         NUMERIC(5,1),
    marks                           SMALLINT,
    bounces                         SMALLINT,
    tackles                         SMALLINT,
    one_percenters                  SMALLINT,
    clangers                        SMALLINT,

    -- Possessions
    contested_possessions           SMALLINT,
    uncontested_possessions         SMALLINT,

    -- Goals and scoring
    goals                           SMALLINT,
    behinds                         SMALLINT,
    goal_assists                    SMALLINT,
    shots_at_goal                   SMALLINT,
    score_involvements              SMALLINT,
    score_launches                  SMALLINT,

    -- Clearances
    centre_clearances               SMALLINT,
    stoppage_clearances             SMALLINT,
    clearances                      SMALLINT,

    -- Marks detail
    contested_marks                 SMALLINT,
    marks_inside_fifty              SMALLINT,
    intercept_marks                 SMALLINT,
    marks_on_lead                   SMALLINT,

    -- Free kicks
    free_kicks_for                  SMALLINT,
    free_kicks_against              SMALLINT,

    -- Hitouts
    hitouts                         SMALLINT,
    hitouts_to_advantage            SMALLINT,
    hitout_win_pct                  NUMERIC(5,1),
    ruck_contests                   SMALLINT,

    -- Territory
    inside_fifties                  SMALLINT,
    rebounds                        SMALLINT,
    turnovers                       SMALLINT,
    intercepts                      SMALLINT,
    metres_gained                   INTEGER,

    -- Pressure and contest
    pressure_acts                   SMALLINT,
    def_half_pressure_acts          SMALLINT,
    tackles_inside_fifty            SMALLINT,
    spoils                          SMALLINT,
    contest_def_losses              SMALLINT,
    contest_def_one_on_ones         SMALLINT,
    contest_off_one_on_ones         SMALLINT,
    contest_off_wins                SMALLINT,

    -- Kicks detail
    effective_kicks                 SMALLINT,

    -- Ground ball
    ground_ball_gets                SMALLINT,
    f50_ground_ball_gets            SMALLINT,

    -- Awards and ratings
    brownlow_votes                  SMALLINT,
    rating_points                   NUMERIC(6,1),

    -- Fantasy
    afl_fantasy_score               SMALLINT,
    supercoach_score                SMALLINT,

    UNIQUE (match_id, player_id)
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_matches_date           ON matches(date);
CREATE INDEX idx_matches_season         ON matches(season_id);
CREATE INDEX idx_matches_home_team      ON matches(home_team_id);
CREATE INDEX idx_matches_away_team      ON matches(away_team_id);
CREATE INDEX idx_matches_venue          ON matches(venue_id);

CREATE INDEX idx_pms_match              ON player_match_stats(match_id);
CREATE INDEX idx_pms_player             ON player_match_stats(player_id);
CREATE INDEX idx_pms_team               ON player_match_stats(team_id);
CREATE INDEX idx_pms_player_team        ON player_match_stats(player_id, team_id);

CREATE INDEX idx_players_surname        ON players(surname);

CREATE INDEX idx_seasons_competition    ON seasons(competition_id);
CREATE INDEX idx_seasons_year           ON seasons(year);

-- ============================================================
-- EMBEDDING TABLES (recreate after CASCADE drop)
-- ============================================================
CREATE TABLE player_season_summaries (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL REFERENCES players(id),
    season_id       INTEGER NOT NULL REFERENCES seasons(id),
    summary_text    TEXT NOT NULL,
    embedding       vector(384),
    UNIQUE (player_id, season_id)
);

CREATE TABLE match_summaries (
    id              SERIAL PRIMARY KEY,
    match_id        INTEGER NOT NULL REFERENCES matches(id) UNIQUE,
    summary_text    TEXT NOT NULL,
    embedding       vector(384)
);

CREATE INDEX idx_player_season_embedding ON player_season_summaries
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_match_summary_embedding ON match_summaries
    USING hnsw (embedding vector_cosine_ops);

COMMIT;
