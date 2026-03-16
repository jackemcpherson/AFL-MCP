-- Track AFL API external IDs and data provenance
ALTER TABLE matches ADD COLUMN IF NOT EXISTS external_afl_id VARCHAR(50);
CREATE UNIQUE INDEX IF NOT EXISTS idx_matches_external_afl_id
    ON matches (external_afl_id) WHERE external_afl_id IS NOT NULL;

-- Performance index for tuple-based lookups (used by enrichment and dedup)
CREATE INDEX IF NOT EXISTS idx_matches_date_teams_lookup
    ON matches (date, home_team_id, away_team_id);

-- Natural key constraint for source-agnostic dedup.
-- Only added if no duplicates exist; safe to re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'uq_matches_date_teams'
    ) THEN
        -- Verify no duplicates before adding constraint
        IF NOT EXISTS (
            SELECT date, home_team_id, away_team_id
            FROM matches
            GROUP BY date, home_team_id, away_team_id
            HAVING COUNT(*) > 1
        ) THEN
            ALTER TABLE matches ADD CONSTRAINT uq_matches_date_teams
                UNIQUE (date, home_team_id, away_team_id);
        ELSE
            RAISE WARNING 'Skipping uq_matches_date_teams: duplicate (date, home_team_id, away_team_id) rows exist';
        END IF;
    END IF;
END $$;
