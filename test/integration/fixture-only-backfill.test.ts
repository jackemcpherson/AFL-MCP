import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../../src/index";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import matchItem from "../fixtures/fixture-only-match.json";
import { makeMatch } from "./_fixtures";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("corrects fixtures at the hour without fetching or altering player inputs or weather", async () => {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  const old = makeMatch({ date: new Date("2026-03-19T08:00:00Z") });
  const teamMap = await ensureTeams(env, competitionId, "AFLM", [old]);
  const venueMap = await ensureVenues(env, [old]);
  await upsertMatches(env, [old], { seasonId, teamMap, venueMap });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO players(id,surname,external_id) VALUES(900,'Legacy identity','legacy-900')",
    ),
    env.DB.prepare(
      "INSERT INTO player_match_stats(match_id,player_id,team_id,disposals) SELECT id,900,home_team_id,17 FROM matches",
    ),
  ]);
  const before = await env.DB.prepare("SELECT * FROM player_match_stats").all();
  const unexpected = vi.fn();
  const network = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/WMCTok")) return Response.json({ token: "fixture-token" });
    if (url.includes("/competitions/1/compseasons"))
      return Response.json({ compSeasons: [{ id: 85, name: "2026 Toyota AFL Premiership" }] });
    if (url.includes("/compseasons/85/rounds"))
      return Response.json({
        rounds: [{ id: 1, providerId: "TEST-R1", name: "Round 1", roundNumber: 1 }],
      });
    if (url.endsWith("/matchItems/round/TEST-R1")) return Response.json({ items: [matchItem] });
    unexpected(url);
    throw new Error("Unexpected network request");
  });
  vi.stubGlobal("fetch", network);
  const hour = new Date();
  hour.setUTCHours(hour.getUTCHours() + 1, 0, 0, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(hour);
  const response = await worker.fetch(
    new Request("https://afl.test/mcp/admin/backfill", {
      method: "POST",
      headers: { Authorization: "Bearer fixture-test", "Content-Type": "application/json" },
      body: JSON.stringify({ competition: "AFLM", season: 2026, fixturesOnly: true }),
    }),
    { ...env, ADMIN_TOKEN: "fixture-test" },
    { waitUntil: () => {} } as unknown as ExecutionContext,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ results: [{ matches: 1, stats: 0, lineups: 0 }] });
  expect(await env.DB.prepare("SELECT kickoff_at FROM matches").first("kickoff_at")).toBe(
    "2026-03-19T08:30:00.000Z",
  );
  expect((await env.DB.prepare("SELECT * FROM player_match_stats").all()).results).toEqual(
    before.results,
  );
  expect(unexpected).not.toHaveBeenCalled();
  expect(network).toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM match_stats_refresh").first("n")).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM pav_rebuild_queue").first("n")).toBe(0);
  expect(
    await env.DB.prepare("SELECT in_progress FROM public_input_revision").first("in_progress"),
  ).toBe(0);
});
