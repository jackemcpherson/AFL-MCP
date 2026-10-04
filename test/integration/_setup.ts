import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

const TABLES_TO_WIPE = [
  "pav_rebuild_queue",
  "identity_repair_operations",
  "player_id_redirects",
  "player_provider_ids",
  "season_provider_inventory",
  "season_provider_ids",
  "stats_refresh_operation_matches",
  "stats_refresh_operations",
  "coach_backfill_progress",
  "match_coaches",
  "coach_import_diagnostics",
  "coach_import_pages",
  "coach_observations",
  "coach_external_match_ids",
  "coach_external_ids",
  "coaches",
  "match_predictions",
  "tipper_predictions",
  "tipper_runs",
  "tipper_game_ids",
  "tipper_reports",
  "tipper_status",
  "weather_refresh_state",
  "match_weather",
  "match_lineups",
  "player_match_stats",
  "player_season_pav",
  "match_stats_refresh",
  "matches",
  "players",
  "venues",
  "teams",
  "seasons",
  "sync_log",
];

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.DB.prepare(
    "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1",
  ).run();
  // Reset dynamic tables between tests; keep seeded `competitions` rows.
  await env.DB.batch(TABLES_TO_WIPE.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(
    "UPDATE public_input_revision SET revision = 0, in_progress = 0, write_started_at = NULL, write_holder = NULL, write_operation = NULL WHERE id = 1",
  ).run();
});
