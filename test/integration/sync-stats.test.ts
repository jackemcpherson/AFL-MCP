import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
  upsertPlayers,
  upsertStats,
} from "../../src/sync/upserts";
import { makeMatch, makePlayerStats } from "./_fixtures";

interface SeedResult {
  matchMap: Map<string, number>;
  playerMap: Map<string, number>;
  teamMap: Map<string, number>;
}

async function seedMatchAndPlayers(): Promise<SeedResult> {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  const match = makeMatch();
  const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
  const matchMap = await buildMatchAflIdMap(env, seasonId);
  const playerMap = await upsertPlayers(env, [
    { playerId: "P-1", givenName: "Patrick", surname: "Cripps" },
    { playerId: "P-2", givenName: "Phantom", surname: "Player" },
  ]);
  return { matchMap, playerMap, teamMap };
}

describe("upsertStats", () => {
  it("inserts a stat row for a player who took the field", async () => {
    const { matchMap, playerMap, teamMap } = await seedMatchAndPlayers();

    await upsertStats(
      env,
      [makePlayerStats({ playerId: "P-1", disposals: 25, kicks: 15, timeOnGroundPercentage: 90 })],
      matchMap,
      playerMap,
      teamMap,
    );

    const rows = await env.DB.prepare(
      "SELECT disposals, kicks, time_on_ground_pct FROM player_match_stats",
    ).all<{ disposals: number; kicks: number; time_on_ground_pct: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ disposals: 25, kicks: 15, time_on_ground_pct: 90 });
  });

  it("filters phantom rows where timeOnGroundPercentage and disposals are both falsy", async () => {
    const { matchMap, playerMap, teamMap } = await seedMatchAndPlayers();

    await upsertStats(
      env,
      [
        makePlayerStats({ playerId: "P-2", timeOnGroundPercentage: 0, disposals: 0 }),
        makePlayerStats({ playerId: "P-1", timeOnGroundPercentage: 85, disposals: 18 }),
      ],
      matchMap,
      playerMap,
      teamMap,
    );

    const rows = await env.DB.prepare(
      "SELECT p.external_afl_player_id FROM player_match_stats s JOIN players p ON s.player_id = p.id",
    ).all<{ external_afl_player_id: string }>();
    expect(rows.results.map((r) => r.external_afl_player_id)).toEqual(["P-1"]);
  });

  it("skips silently when the stat row's matchId is unknown to the match map", async () => {
    const { matchMap, playerMap, teamMap } = await seedMatchAndPlayers();

    await upsertStats(
      env,
      [
        makePlayerStats({
          playerId: "P-1",
          matchId: "M-DOES-NOT-EXIST",
          disposals: 25,
          timeOnGroundPercentage: 90,
        }),
      ],
      matchMap,
      playerMap,
      teamMap,
    );

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM player_match_stats").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("is idempotent on a second run and reports zero changes; reports >0 on a real diff", async () => {
    const { matchMap, playerMap, teamMap } = await seedMatchAndPlayers();
    const stat = makePlayerStats({
      playerId: "P-1",
      disposals: 25,
      timeOnGroundPercentage: 90,
    });

    const firstChanges = await upsertStats(env, [stat], matchMap, playerMap, teamMap);
    expect(firstChanges).toBe(1);

    const idempotentChanges = await upsertStats(env, [stat], matchMap, playerMap, teamMap);
    expect(idempotentChanges).toBe(0);

    const updated = makePlayerStats({
      playerId: "P-1",
      disposals: 26,
      timeOnGroundPercentage: 90,
    });
    const diffChanges = await upsertStats(env, [updated], matchMap, playerMap, teamMap);
    expect(diffChanges).toBe(1);

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM player_match_stats").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });

  it("preserves supercoach_score and brownlow_votes when re-fetching with nulls", async () => {
    const { matchMap, playerMap, teamMap } = await seedMatchAndPlayers();

    await upsertStats(
      env,
      [
        makePlayerStats({
          playerId: "P-1",
          disposals: 25,
          timeOnGroundPercentage: 90,
          supercoachScore: 105,
          brownlowVotes: 3,
        }),
      ],
      matchMap,
      playerMap,
      teamMap,
    );

    // Re-run with null supercoach/brownlow (e.g. a mid-week refresh before
    // those columns are populated upstream).
    await upsertStats(
      env,
      [
        makePlayerStats({
          playerId: "P-1",
          disposals: 25,
          timeOnGroundPercentage: 90,
          supercoachScore: null,
          brownlowVotes: null,
        }),
      ],
      matchMap,
      playerMap,
      teamMap,
    );

    const row = await env.DB.prepare(
      "SELECT supercoach_score, brownlow_votes FROM player_match_stats",
    ).first<{ supercoach_score: number | null; brownlow_votes: number | null }>();
    expect(row).toEqual({ supercoach_score: 105, brownlow_votes: 3 });
  });
});
