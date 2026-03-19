-- Fix duplicate players in the production database.
--
-- Problem: 432 players were inserted with CD_I IDs in the external_id column,
-- creating duplicates of existing players who have numeric external_ids.
--
-- Strategy:
-- 1. Build a mapping of dupe → original player IDs
-- 2. Reassign player_match_stats (delete if conflict with original)
-- 3. Delete dupe rows from player_season_pav and player_season_summaries
-- 4. Link external_afl_player_id on originals where missing
-- 5. Delete the duplicate player rows

BEGIN;

-- Step 1: Create temp mapping table
CREATE TEMP TABLE dupe_map AS
SELECT
    p2.id AS dupe_id,
    p1.id AS orig_id,
    p2.external_id AS dupe_cd_i_id
FROM players p2
JOIN players p1
    ON LOWER(p1.first_name) = LOWER(p2.first_name)
   AND LOWER(p1.surname) = LOWER(p2.surname)
   AND p1.id < p2.id
WHERE p2.external_id LIKE 'CD_I%'
  AND p2.id >= 10000;

-- Verify mapping looks right
SELECT COUNT(*) AS dupes_to_fix FROM dupe_map;

-- Step 2: Delete player_match_stats for dupes where the original already
-- has stats for the same match (avoid unique constraint violation)
DELETE FROM player_match_stats pms
USING dupe_map dm
WHERE pms.player_id = dm.dupe_id
  AND EXISTS (
      SELECT 1 FROM player_match_stats orig_pms
      WHERE orig_pms.match_id = pms.match_id
        AND orig_pms.player_id = dm.orig_id
  );

-- Reassign remaining dupe stats to original player
UPDATE player_match_stats pms
SET player_id = dm.orig_id
FROM dupe_map dm
WHERE pms.player_id = dm.dupe_id;

-- Step 3: Delete dupe rows from player_season_pav
-- (originals may already have rows for same season+team)
DELETE FROM player_season_pav
WHERE player_id IN (SELECT dupe_id FROM dupe_map);

-- Step 4: Delete dupe rows from player_season_summaries
DELETE FROM player_season_summaries
WHERE player_id IN (SELECT dupe_id FROM dupe_map);

-- Step 5: Clear external_afl_player_id on dupes to avoid unique constraint
-- violation when linking to originals
UPDATE players
SET external_afl_player_id = NULL
WHERE id IN (SELECT dupe_id FROM dupe_map)
  AND external_afl_player_id IS NOT NULL;

-- Step 6: Link external_afl_player_id on originals where missing,
-- but only when no other player already claims that AFL ID
UPDATE players p
SET external_afl_player_id = dm.dupe_cd_i_id
FROM dupe_map dm
WHERE p.id = dm.orig_id
  AND p.external_afl_player_id IS NULL
  AND NOT EXISTS (
      SELECT 1 FROM players p3
      WHERE p3.external_afl_player_id = dm.dupe_cd_i_id
        AND p3.id != p.id
  );

-- Step 7: Delete the duplicate player rows
DELETE FROM players
WHERE id IN (SELECT dupe_id FROM dupe_map);

-- Verify: no more CD_I IDs in external_id for high-ID players
SELECT COUNT(*) AS remaining_dupes
FROM players
WHERE id >= 10000 AND external_id LIKE 'CD_I%';

DROP TABLE dupe_map;

COMMIT;
