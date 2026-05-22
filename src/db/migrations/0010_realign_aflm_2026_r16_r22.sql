-- Realign AFLM 2026 rounds 16–22 with the AFL's revised fixture.
-- Source: 2026-05-22, issue #80.
--
-- The AFL moved game dates for AFLM 2026 R16–R22 after the original
-- fixture was ingested. The 61 existing rows in `matches` still hold
-- the old dates. fitzroy returns the new dates, but our upsert's
-- `ON CONFLICT (date, home_team_id, away_team_id)` key doesn't match
-- (dates differ), so the fallback INSERT hits the `external_afl_id`
-- UNIQUE index and the whole sync batch rolls back — every cron tick.
--
-- Delete the 61 stale rows. They're all future games with no
-- player_match_stats / match_lineups references (verified via MCP
-- query before writing this migration), so deletion is FK-safe.
-- On the next cron tick fitzroy re-inserts them with the corrected
-- dates via the normal insert path.
--
-- Permanent fix for the underlying conflict-key bug is tracked in
-- issue #80 and will replace this one-off cleanup.
DELETE FROM matches
WHERE id IN (
  SELECT m.id
  FROM matches m
  JOIN seasons s ON m.season_id = s.id
  JOIN competitions c ON s.competition_id = c.id
  WHERE c.code = 'AFLM'
    AND s.year = 2026
    AND m.round_number BETWEEN 16 AND 22
    AND m.home_points IS NULL
);
