import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  unionPlayers,
  upsertLineups,
  upsertMatches,
  upsertPlayers,
} from "../../src/sync/upserts";
import { makeLineup, makeLineupPlayer, makeMatch, makePlayerStats } from "./_fixtures";

async function setup() {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  const match = makeMatch();
  const teamMap = await ensureTeams(env, competitionId, [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
  const matchMap = await buildMatchAflIdMap(env, seasonId);
  return { matchMap, teamMap };
}

describe("upsertLineups", () => {
  it("inserts one row per player per match, marking emergencies and substitutes", async () => {
    const { matchMap, teamMap } = await setup();
    const lineup = makeLineup({
      homePlayers: [
        makeLineupPlayer({ playerId: "P-1", givenName: "Patrick", surname: "Cripps" }),
        makeLineupPlayer({
          playerId: "P-2",
          givenName: "Sam",
          surname: "Walsh",
          isEmergency: true,
        }),
      ],
      awayPlayers: [
        makeLineupPlayer({
          playerId: "P-3",
          givenName: "Dustin",
          surname: "Martin",
          isSubstitute: true,
        }),
      ],
    });
    const playerMap = await upsertPlayers(env, unionPlayers([], [lineup]));

    await upsertLineups(env, [lineup], matchMap, playerMap, teamMap);

    const rows = await env.DB.prepare(
      "SELECT p.external_afl_player_id, ml.is_emergency, ml.is_substitute FROM match_lineups ml JOIN players p ON ml.player_id = p.id ORDER BY p.external_afl_player_id",
    ).all<{ external_afl_player_id: string; is_emergency: number; is_substitute: number }>();

    expect(rows.results).toHaveLength(3);
    expect(rows.results).toEqual([
      { external_afl_player_id: "P-1", is_emergency: 0, is_substitute: 0 },
      { external_afl_player_id: "P-2", is_emergency: 1, is_substitute: 0 },
      { external_afl_player_id: "P-3", is_emergency: 0, is_substitute: 1 },
    ]);
  });

  it("upserts an emergency-flag change on re-fetch (substitute confirmed at T-60)", async () => {
    const { matchMap, teamMap } = await setup();
    const initial = makeLineup({
      homePlayers: [
        makeLineupPlayer({ playerId: "P-1" }),
        makeLineupPlayer({ playerId: "P-2", isEmergency: true }),
      ],
    });
    const playerMap = await upsertPlayers(env, unionPlayers([], [initial]));
    await upsertLineups(env, [initial], matchMap, playerMap, teamMap);

    // Re-fetch: P-2 promoted from emergency to substitute (the AFL T-60 reveal)
    const updated = makeLineup({
      homePlayers: [
        makeLineupPlayer({ playerId: "P-1" }),
        makeLineupPlayer({ playerId: "P-2", isEmergency: false, isSubstitute: true }),
      ],
    });
    await upsertLineups(env, [updated], matchMap, playerMap, teamMap);

    const row = await env.DB.prepare(
      "SELECT is_emergency, is_substitute FROM match_lineups ml JOIN players p ON ml.player_id = p.id WHERE p.external_afl_player_id = 'P-2'",
    ).first<{ is_emergency: number; is_substitute: number }>();
    expect(row).toEqual({ is_emergency: 0, is_substitute: 1 });
  });

  it("skips silently when matchId is unknown to the match map", async () => {
    const { matchMap, teamMap } = await setup();
    const orphaned = makeLineup({
      matchId: "M-DOES-NOT-EXIST",
      homePlayers: [makeLineupPlayer({ playerId: "P-1" })],
    });
    const playerMap = await upsertPlayers(env, unionPlayers([], [orphaned]));

    await upsertLineups(env, [orphaned], matchMap, playerMap, teamMap);

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM match_lineups").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });
});

describe("unionPlayers", () => {
  it("merges players from stats and lineups by playerId", async () => {
    const lineup = makeLineup({
      homePlayers: [makeLineupPlayer({ playerId: "P-1" })],
      awayPlayers: [makeLineupPlayer({ playerId: "P-2" })],
    });

    const merged = unionPlayers([], [lineup]);
    expect(merged.map((p) => p.playerId).sort()).toEqual(["P-1", "P-2"]);
  });

  it("dedupes when the same playerId appears in both sources", async () => {
    const lineup = makeLineup({
      homePlayers: [makeLineupPlayer({ playerId: "P-1", givenName: "Patrick" })],
    });
    const merged = unionPlayers([makePlayerStats({ playerId: "P-1" })], [lineup]);
    expect(merged).toHaveLength(1);
  });
});
