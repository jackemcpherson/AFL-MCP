-- Player Approximate Value (PAV) table
-- Stores pre-computed HPN PAV ratings per player per season per team.
-- Players who change teams mid-season get separate rows per stint.

CREATE TABLE IF NOT EXISTS player_season_pav (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL REFERENCES players(id),
    season_id       INTEGER NOT NULL REFERENCES seasons(id),
    team_id         INTEGER NOT NULL REFERENCES teams(id),
    off_pav         NUMERIC(6,2),
    mid_pav         NUMERIC(6,2),
    def_pav         NUMERIC(6,2),
    total_pav       NUMERIC(6,2),
    UNIQUE (player_id, season_id, team_id)
);

CREATE INDEX idx_pav_season ON player_season_pav(season_id);
CREATE INDEX idx_pav_total ON player_season_pav(total_pav DESC);
