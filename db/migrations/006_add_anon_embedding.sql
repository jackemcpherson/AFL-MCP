-- Add anonymous embedding column for stat-profile similarity search.
-- This embedding is generated from a summary that strips player name
-- and team name, so "find similar" matches on statistical profile
-- rather than team identity.

ALTER TABLE player_season_summaries
    ADD COLUMN IF NOT EXISTS anon_embedding vector(384);

CREATE INDEX IF NOT EXISTS idx_player_season_anon_embedding
    ON player_season_summaries USING hnsw (anon_embedding vector_cosine_ops);
