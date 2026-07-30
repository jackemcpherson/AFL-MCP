-- Merge the duplicate player records for Hewago Oea (Gold Coast).
--
-- Cross-source unification missed him: the fitzroy-sourced row
-- (external_id 13009, 12 stat rows, 4 lineups, height 177cm) and the
-- AFL-API-sourced row (external_afl_player_id CD_I1009320, 82 stat rows,
-- 23 lineups) share the same name and date of birth (2001-11-13).
-- Every stat, lineup, and PAV row on the fitzroy record duplicates a match
-- the AFL API record already covers (verified 2026-07-30), so the merge
-- deletes the duplicates and moves the fitzroy external_id onto the
-- surviving row so future fitzroy syncs resolve to it.
--
-- Keyed on external ids, not row ids; every statement is a no-op on a
-- database where the duplicate does not exist. The loser row is removed
-- before the winner takes external_id 13009, satisfying the partial
-- UNIQUE index on players.external_id.
--
-- Triage note for the other same-name pairs found in the same audit:
-- Tom O'Sullivan x3 (CD_I291345 / CD_I1001022 / CD_I1027792) and the
-- Purcell/Hosking AFLW-VFLW pairs each carry DISTINCT AFL API ids, so
-- they are treated as different people absent contrary evidence.

DELETE FROM player_match_stats
WHERE player_id = (
  SELECT id FROM players
  WHERE external_id = '13009' AND external_afl_player_id IS NULL AND surname = 'Oea'
);

DELETE FROM match_lineups
WHERE player_id = (
  SELECT id FROM players
  WHERE external_id = '13009' AND external_afl_player_id IS NULL AND surname = 'Oea'
);

DELETE FROM player_season_pav
WHERE player_id = (
  SELECT id FROM players
  WHERE external_id = '13009' AND external_afl_player_id IS NULL AND surname = 'Oea'
);

DELETE FROM players
WHERE external_id = '13009' AND external_afl_player_id IS NULL AND surname = 'Oea';

UPDATE players
SET external_id = '13009',
    height_cm = COALESCE(height_cm, 177)
WHERE external_afl_player_id = 'CD_I1009320'
  AND external_id IS NULL;
