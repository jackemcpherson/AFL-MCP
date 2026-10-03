import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

const TABLES_TO_WIPE = [
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
  "match_weather",
  "match_lineups",
  "player_match_stats",
  "player_season_pav",
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
  // Reset dynamic tables between tests; keep seeded `competitions` rows.
  await env.DB.batch(TABLES_TO_WIPE.map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  await env.DB.prepare(
    "UPDATE public_input_revision SET revision = 0, in_progress = 0, write_started_at = NULL WHERE id = 1",
  ).run();
});
