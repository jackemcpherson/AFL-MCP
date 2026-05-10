-- Re-derive 2021–2022 match_lineups from player_match_stats.
-- Source: 2026-05-10 data quality review (P2 #14, follow-up).
--
-- Background: fitzroy's afl-api source returns the Thursday-night announced
-- team for 2021–2022, so ~2% of match_lineups rows pointed at players who
-- were withdrawn before the match. From 2023 onward the AFL API publishes
-- the post-change team and the mismatch rate drops to ~0.05%. To make the
-- 2021–2022 data behave consistently with the rest of the dataset, this
-- migration rebuilds match_lineups for those two seasons from the
-- player_match_stats table — i.e., from the actual played team rather than
-- the announced team.
--
-- Field sources:
--   guernsey_number ← pms.guernsey_number (100% populated for 2021–2022)
--   position        ← pms.player_position (100% populated)
--   is_emergency    ← 0 (everyone with stats played, so no emergencies)
--   is_substitute   ← 1 when position is INT or SUB (matches the existing
--                     convention used elsewhere in match_lineups)
--
-- The pms `subbed` column is NULL for all 2020+ rows so we can't distinguish
-- the medical sub via that field; the position-based rule is what other
-- years already use.
--
-- One-time historical backfill — do not re-run.

DELETE FROM match_lineups
WHERE match_id IN (
  SELECT m.id FROM matches m
  JOIN seasons s ON s.id = m.season_id
  WHERE s.year IN (2021, 2022)
);

INSERT INTO match_lineups (
  match_id, player_id, team_id, guernsey_number, position, is_emergency, is_substitute
)
SELECT
  pms.match_id,
  pms.player_id,
  pms.team_id,
  pms.guernsey_number,
  pms.player_position,
  0,
  CASE WHEN pms.player_position IN ('INT', 'SUB') THEN 1 ELSE 0 END
FROM player_match_stats pms
JOIN matches m ON m.id = pms.match_id
JOIN seasons s ON s.id = m.season_id
WHERE s.year IN (2021, 2022);
