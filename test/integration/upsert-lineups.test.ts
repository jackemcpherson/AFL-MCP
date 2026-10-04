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
  const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
  const matchMap = await buildMatchAflIdMap(env, seasonId);
  return { matchMap, teamMap };
}

function completeLineup() {
  return makeLineup({
    homePlayers: Array.from({ length: 23 }, (_, i) => makeLineupPlayer({ playerId: `H-${i}` })),
    awayPlayers: Array.from({ length: 23 }, (_, i) => makeLineupPlayer({ playerId: `A-${i}` })),
  });
}
describe("atomic lineup replacement", () => {
  it("removes departed players and records observation time", async () => {
    const { matchMap, teamMap } = await setup();
    const initial = completeLineup();
    const replacement = {
      ...completeLineup(),
      homePlayers: [makeLineupPlayer({ playerId: "NEW" }), ...initial.homePlayers.slice(1)],
    };
    const players = await upsertPlayers(env, unionPlayers([], [initial, replacement]));
    expect(await upsertLineups(env, [initial], matchMap, players, teamMap)).toBe(46);
    expect(await upsertLineups(env, [replacement], matchMap, players, teamMap)).toBe(46);
    const rows = await env.DB.prepare(
      "SELECT p.external_afl_player_id FROM match_lineups ml JOIN players p ON p.id=ml.player_id",
    ).all<{ external_afl_player_id: string }>();
    expect(rows.results.map((r) => r.external_afl_player_id)).toContain("NEW");
    expect(rows.results.map((r) => r.external_afl_player_id)).not.toContain("H-0");
    expect(await env.DB.prepare("SELECT lineups_observed_at FROM matches").first()).toMatchObject({
      lineups_observed_at: expect.any(String),
    });
  });
  it("preserves valid snapshots on incomplete, duplicate or misowned responses", async () => {
    const { matchMap, teamMap } = await setup();
    const initial = completeLineup();
    const players = await upsertPlayers(env, unionPlayers([], [initial]));
    await upsertLineups(env, [initial], matchMap, players, teamMap);
    for (const kind of ["partial", "duplicate", "ownership"]) {
      const base = completeLineup();
      const invalid =
        kind === "partial"
          ? { ...base, homePlayers: base.homePlayers.slice(1) }
          : kind === "duplicate"
            ? {
                ...base,
                awayPlayers: [makeLineupPlayer({ playerId: "H-0" }), ...base.awayPlayers.slice(1)],
              }
            : { ...base, homeTeam: base.awayTeam, awayTeam: base.homeTeam };
      expect(await upsertLineups(env, [invalid], matchMap, players, teamMap)).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM match_lineups").first()).toEqual({
        n: 46,
      });
    }
  });
  it("rolls back deletion if replacement insertion fails", async () => {
    const { matchMap, teamMap } = await setup();
    const initial = completeLineup();
    const players = await upsertPlayers(env, unionPlayers([], [initial]));
    await upsertLineups(env, [initial], matchMap, players, teamMap);
    await env.DB.prepare(
      "CREATE TRIGGER fail_lineup BEFORE INSERT ON match_lineups BEGIN SELECT RAISE(ABORT,'injected'); END",
    ).run();
    try {
      await expect(upsertLineups(env, [initial], matchMap, players, teamMap)).rejects.toThrow();
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM match_lineups").first()).toEqual({
        n: 46,
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_lineup").run();
    }
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

it("accepts season-seven rosters only when every player-team appearance agrees", async () => {
  const competitionId = await ensureCompetition(env, "AFLW");
  const seasonId = await ensureSeason(env, competitionId, "2022-S7");
  const match = makeMatch({ competition: "AFLW", season: 2022, seasonKey: "2022-S7" });
  const teamMap = await ensureTeams(env, competitionId, "AFLW", [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
  const matchMap = await buildMatchAflIdMap(env, seasonId);
  const lineup = makeLineup({
    competition: "AFLW",
    season: 2022,
    seasonKey: "2022-S7",
    homePlayers: Array.from({ length: 21 }, (_, i) => makeLineupPlayer({ playerId: `S7H-${i}` })),
    awayPlayers: Array.from({ length: 21 }, (_, i) => makeLineupPlayer({ playerId: `S7A-${i}` })),
  });
  const players = await upsertPlayers(env, unionPlayers([], [lineup]));
  expect(await upsertLineups(env, [lineup], matchMap, players, teamMap)).toBe(0);
  const matchId = matchMap.get(lineup.matchId);
  await env.DB.batch([
    ...[...lineup.homePlayers].map((p) =>
      env.DB.prepare(
        "INSERT INTO player_match_stats(match_id,player_id,team_id) VALUES(?1,?2,?3)",
      ).bind(matchId, players.get(p.playerId), teamMap.get(lineup.homeTeam)),
    ),
    ...lineup.awayPlayers.map((p) =>
      env.DB.prepare(
        "INSERT INTO player_match_stats(match_id,player_id,team_id) VALUES(?1,?2,?3)",
      ).bind(matchId, players.get(p.playerId), teamMap.get(lineup.awayTeam)),
    ),
  ]);
  expect(await upsertLineups(env, [lineup], matchMap, players, teamMap)).toBe(42);
  const emergency = makeLineupPlayer({ playerId: "S7-EMG", isEmergency: true });
  const withEmergency = { ...lineup, homePlayers: [...lineup.homePlayers, emergency] };
  const expandedPlayers = await upsertPlayers(env, unionPlayers([], [withEmergency]));
  await env.DB.prepare(
    "INSERT INTO player_match_stats(match_id,player_id,team_id) VALUES(?1,?2,?3)",
  )
    .bind(matchId, expandedPlayers.get(emergency.playerId), teamMap.get(lineup.homeTeam))
    .run();
  expect(await upsertLineups(env, [withEmergency], matchMap, expandedPlayers, teamMap)).toBe(0);
  await env.DB.prepare("DELETE FROM player_match_stats WHERE player_id=?1")
    .bind(expandedPlayers.get(emergency.playerId))
    .run();
  await env.DB.prepare("UPDATE player_match_stats SET team_id=?1 WHERE player_id=?2")
    .bind(teamMap.get(lineup.awayTeam), players.get("S7H-0"))
    .run();
  expect(await upsertLineups(env, [lineup], matchMap, players, teamMap)).toBe(0);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM match_lineups").first("n")).toBe(42);
  expect(
    await upsertLineups(env, [{ ...lineup, seasonKey: "2022-S6" }], matchMap, players, teamMap),
  ).toBe(0);
});
