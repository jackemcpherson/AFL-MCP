-- Remove ghost team rows created by fitzroy 2.1.0 returning indigenous
-- Sir Doug Nicholls Round (SDNR) names for AFLM 2026 R10/R11.
-- Source: 2026-05-22, issue #78.
--
-- Root cause: fitzroy 2.1.0 surfaced Walyalup / Kuwarna / Narrm /
-- Yartapuulti / Euro-Yroke / Waalitj Marawar verbatim. `ensureTeams`
-- created new team rows for each. `buildMatchUpsert` then failed the
-- UNIQUE constraint on `external_afl_id` (the existing fixture row had
-- canonical home_team_id / away_team_id), so R10/R11 matches never had
-- `home_points` populated and stats/lineups sync skipped them.
--
-- Verified zero FK references in matches / player_match_stats /
-- match_lineups / pav_seasonal before deletion. v3.0.1 ships
-- TEAM_NAME_MAP entries plus fitzroy@2.2.0, so these rows cannot be
-- recreated by subsequent syncs. The DELETE is idempotent — re-running
-- it after the rows are gone is a no-op.
DELETE FROM teams
WHERE name IN (
    'Kuwarna',
    'Walyalup',
    'Narrm',
    'Yartapuulti',
    'Euro-Yroke',
    'Waalitj Marawar'
  )
  AND competition_id = (SELECT id FROM competitions WHERE code = 'AFLM');
