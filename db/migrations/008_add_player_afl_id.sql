-- Track AFL API player IDs (CD_I format) separately from fryzigg numeric IDs.
-- Players loaded from AFL API have external_afl_player_id but may lack external_id.
-- Players loaded from fryzigg have external_id but lack external_afl_player_id.
-- Cross-source matching populates both columns for players appearing in both sources.

ALTER TABLE players ADD COLUMN IF NOT EXISTS external_afl_player_id VARCHAR(50);

CREATE UNIQUE INDEX IF NOT EXISTS idx_players_external_afl_player_id
    ON players (external_afl_player_id)
    WHERE external_afl_player_id IS NOT NULL;

-- Allow AFL-only players to be inserted without a fryzigg external_id.
ALTER TABLE players ALTER COLUMN external_id DROP NOT NULL;
