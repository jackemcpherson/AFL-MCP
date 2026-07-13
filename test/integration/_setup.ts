import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach } from "vitest";

const TABLES_TO_WIPE = [
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
});
