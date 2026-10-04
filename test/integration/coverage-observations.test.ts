import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import { observeCoverage } from "../../src/mcp/tools/coverage";
import { ensureCompetition, ensureSeason } from "../../src/sync/upserts";

it("distinguishes an empty stored season from uncaptured and captured provider inventories", async () => {
  const competition = await ensureCompetition(env, "AFLW");
  const season = await ensureSeason(env, competition, "2022-S6");
  const empty = await observeCoverage(env, "AFLW", "2022-S6");
  expect(empty.inventory).toMatchObject({
    provider_matches: null,
    stored_matches: 0,
    participant_rows: 0,
  });
  await env.DB.prepare(
    "INSERT INTO season_provider_inventory(season_id,provider,observed_at,matches_json) VALUES(?1,'afl-api',?2,?3)",
  )
    .bind(
      season,
      "2026-10-04T00:00:00Z",
      JSON.stringify(Array.from({ length: 75 }, (_, id) => ({ id }))),
    )
    .run();
  // Use an explicit uncached reader to compare the same scope with direct SQL.
  const noCache = { match: async () => undefined, put: async () => {} } as unknown as Cache;
  const observed = await observeCoverage(env, "AFLW", "2022-S6", noCache);
  const stored = await env.DB.prepare("SELECT count(*) AS n FROM matches WHERE season_id=?1")
    .bind(season)
    .first("n");
  expect(observed.inventory).toMatchObject({
    provider_matches: 75,
    stored_matches: stored,
    eligible_completed_matches: 0,
  });
  await expect(observeCoverage(env, "AFLW", 2022, noCache)).rejects.toThrow("Ambiguous");
});

it("rejects a coverage observation during an abandoned public input write", async () => {
  const competition = await ensureCompetition(env, "VFL");
  await ensureSeason(env, competition, 2026);
  await env.DB.prepare(
    "UPDATE public_input_revision SET in_progress=1,write_started_at='2000-01-01'",
  ).run();
  await expect(observeCoverage(env, "VFL", 2026)).rejects.toThrow("unfinished input write");
});
