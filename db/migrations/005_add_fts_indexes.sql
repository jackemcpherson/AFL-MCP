-- Full-text search indexes for hybrid semantic search (vector + keyword).
-- These GIN indexes support ts_rank queries on summary text.

CREATE INDEX IF NOT EXISTS idx_match_summaries_fts
    ON match_summaries USING gin(to_tsvector('english', summary_text));

CREATE INDEX IF NOT EXISTS idx_player_season_summaries_fts
    ON player_season_summaries USING gin(to_tsvector('english', summary_text));
