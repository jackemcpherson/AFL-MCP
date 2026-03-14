-- AFL-MCP: Add pgvector support and embedding tables
-- Requires pgvector extension to be enabled on the PostgreSQL instance.

BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

-- Player season summaries with embeddings
CREATE TABLE player_season_summaries (
    id              SERIAL PRIMARY KEY,
    player_id       INTEGER NOT NULL REFERENCES players(id),
    season_id       INTEGER NOT NULL REFERENCES seasons(id),
    summary_text    TEXT NOT NULL,
    embedding       vector(384),
    UNIQUE (player_id, season_id)
);

-- Match summaries with embeddings
CREATE TABLE match_summaries (
    id              SERIAL PRIMARY KEY,
    match_id        INTEGER NOT NULL REFERENCES matches(id) UNIQUE,
    summary_text    TEXT NOT NULL,
    embedding       vector(384)
);

-- HNSW indexes for fast approximate nearest neighbour search
CREATE INDEX idx_player_season_embedding ON player_season_summaries
    USING hnsw (embedding vector_cosine_ops);

CREATE INDEX idx_match_summary_embedding ON match_summaries
    USING hnsw (embedding vector_cosine_ops);

COMMIT;
