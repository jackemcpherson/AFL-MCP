-- Add an explicit completeness flag to seasons.
-- Source: 2026-05-10 data quality review (Rec #3).
--
-- A season is complete iff it has at least one match AND every match has
-- a non-null home_points (i.e., every match has been played). The sync
-- pipeline keeps this flag in sync after each upsertMatches call.

ALTER TABLE seasons ADD COLUMN is_complete INTEGER NOT NULL DEFAULT 0;

UPDATE seasons SET is_complete = 1
WHERE EXISTS (SELECT 1 FROM matches m WHERE m.season_id = seasons.id)
  AND NOT EXISTS (
    SELECT 1 FROM matches m WHERE m.season_id = seasons.id AND m.home_points IS NULL
  );
