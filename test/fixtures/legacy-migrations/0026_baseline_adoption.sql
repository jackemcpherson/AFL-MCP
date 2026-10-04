-- Register the next release's baseline only after the reviewed history applies.
-- D1 applies each migration as one batch; a failed guard rolls back registration.
CREATE TABLE _baseline_adoption_guard (applied_count INTEGER NOT NULL CHECK (applied_count = 25));
INSERT INTO _baseline_adoption_guard (applied_count)
SELECT COUNT(DISTINCT name) FROM d1_migrations WHERE name IN (
    '0001_initial.sql',
    '0002_match_lineups.sql',
    '0003_team_hygiene.sql',
    '0004_integrity_views.sql',
    '0005_seasons_is_complete.sql',
    '0006_unused_venues.sql',
    '0007_lineups_2021_2022_from_stats.sql',
    '0008_round_abbreviation.sql',
    '0009_remove_sdnr_ghost_teams.sql',
    '0010_realign_aflm_2026_r16_r22.sql',
    '0011_match_status.sql',
    '0012_sync_lease.sql',
    '0013_completed_quarter.sql',
    '0014_weather.sql',
    '0015_match_predictions.sql',
    '0016_remove_finals_placeholder_teams.sql',
    '0017_backfill_match_status.sql',
    '0018_merge_duplicate_player_oea.sql',
    '0019_players_is_retired_backfill.sql',
    '0020_drop_legacy_weather_columns.sql',
    '0021_tipper_publication.sql',
    '0022_tipper_reconstructions.sql',
    '0023_consolidate_tipper_backfill.sql',
    '0024_coaching.sql',
    '0025_venue_reference_seed.sql'
);
INSERT INTO d1_migrations (name)
SELECT '0027_baseline.sql' WHERE NOT EXISTS (
    SELECT 1 FROM d1_migrations WHERE name = '0027_baseline.sql'
);
DROP TABLE _baseline_adoption_guard;
