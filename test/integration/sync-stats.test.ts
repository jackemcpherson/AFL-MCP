import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncStats } from "../../src/sync/sync-stats";
import { makePlayerStats } from "./_fixtures";

interface SeedResult {
  teamIdMap: Map<string, number>;
  playerIdMap: Map<string, number>;
}

async function seedMatchContext(): Promise<SeedResult> {
  const competition = await env.DB.prepare(
    "SELECT id FROM competitions WHERE code = 'AFLM'",
  ).first<{
    id: number;
  }>();
  const competitionId = competition?.id;
  if (!competitionId) throw new Error("AFLM competition seed missing");

  await env.DB.prepare("INSERT INTO seasons (competition_id, year) VALUES (?, ?)")
    .bind(competitionId, 2026)
    .run();
  const season = await env.DB.prepare(
    "SELECT id FROM seasons WHERE competition_id = ? AND year = ?",
  )
    .bind(competitionId, 2026)
    .first<{ id: number }>();
  const seasonId = season?.id;
  if (!seasonId) throw new Error("season insert failed");

  for (const name of ["Carlton", "Richmond"]) {
    await env.DB.prepare("INSERT INTO teams (name, competition_id) VALUES (?, ?)")
      .bind(name, competitionId)
      .run();
  }
  const teamRows = await env.DB.prepare("SELECT id, name FROM teams WHERE competition_id = ?")
    .bind(competitionId)
    .all<{ id: number; name: string }>();
  const teamIdMap = new Map(teamRows.results.map((r) => [r.name, r.id] as const));

  await env.DB.prepare("INSERT INTO venues (name) VALUES (?)").bind("MCG").run();
  const venue = await env.DB.prepare("SELECT id FROM venues WHERE name = ?")
    .bind("MCG")
    .first<{ id: number }>();

  await env.DB.prepare(
    "INSERT INTO matches (season_id, round, round_number, date, venue_id, home_team_id, away_team_id, home_points, away_points) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      seasonId,
      "Round 1",
      1,
      "2026-03-19",
      venue?.id ?? null,
      teamIdMap.get("Carlton"),
      teamIdMap.get("Richmond"),
      80,
      69,
    )
    .run();

  await env.DB.prepare(
    "INSERT INTO players (first_name, surname, external_afl_player_id) VALUES (?, ?, ?)",
  )
    .bind("Patrick", "Cripps", "P-1")
    .run();
  await env.DB.prepare(
    "INSERT INTO players (first_name, surname, external_afl_player_id) VALUES (?, ?, ?)",
  )
    .bind("Phantom", "Player", "P-2")
    .run();

  const playerRows = await env.DB.prepare("SELECT id, external_afl_player_id FROM players").all<{
    id: number;
    external_afl_player_id: string;
  }>();
  const playerIdMap = new Map(
    playerRows.results.map((r) => [r.external_afl_player_id, r.id] as const),
  );

  return { teamIdMap, playerIdMap };
}

describe("syncStats (current pipeline)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-09T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("inserts a stat row for a player who took the field", async () => {
    const { teamIdMap, playerIdMap } = await seedMatchContext();

    await syncStats(
      env,
      [
        makePlayerStats({
          playerId: "P-1",
          team: "Carlton",
          homeTeam: "Carlton",
          awayTeam: "Richmond",
          date: new Date("2026-03-19T08:30:00Z"),
          disposals: 25,
          kicks: 15,
          timeOnGroundPercentage: 90,
        }),
      ],
      teamIdMap,
      playerIdMap,
    );

    const rows = await env.DB.prepare(
      "SELECT disposals, kicks, time_on_ground_pct FROM player_match_stats",
    ).all<{ disposals: number; kicks: number; time_on_ground_pct: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({ disposals: 25, kicks: 15, time_on_ground_pct: 90 });
  });

  it("filters phantom rows where timeOnGroundPercentage and disposals are both falsy", async () => {
    const { teamIdMap, playerIdMap } = await seedMatchContext();

    await syncStats(
      env,
      [
        makePlayerStats({
          playerId: "P-2",
          team: "Carlton",
          homeTeam: "Carlton",
          awayTeam: "Richmond",
          date: new Date("2026-03-19T08:30:00Z"),
          timeOnGroundPercentage: 0,
          disposals: 0,
        }),
        makePlayerStats({
          playerId: "P-1",
          team: "Carlton",
          homeTeam: "Carlton",
          awayTeam: "Richmond",
          date: new Date("2026-03-19T08:30:00Z"),
          timeOnGroundPercentage: 85,
          disposals: 18,
        }),
      ],
      teamIdMap,
      playerIdMap,
    );

    const rows = await env.DB.prepare(
      "SELECT p.external_afl_player_id FROM player_match_stats s JOIN players p ON s.player_id = p.id",
    ).all<{ external_afl_player_id: string }>();
    expect(rows.results.map((r) => r.external_afl_player_id)).toEqual(["P-1"]);
  });

  it("skips a stat row whose match has no row in matches (silently)", async () => {
    const { teamIdMap, playerIdMap } = await seedMatchContext();

    await syncStats(
      env,
      [
        makePlayerStats({
          playerId: "P-1",
          team: "Carlton",
          homeTeam: "Carlton",
          awayTeam: "Richmond",
          // Date that does NOT match the seeded match (which is 2026-03-19)
          date: new Date("2099-01-01T00:00:00Z"),
          disposals: 25,
          timeOnGroundPercentage: 90,
        }),
      ],
      teamIdMap,
      playerIdMap,
    );

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM player_match_stats").first<{
      n: number;
    }>();
    expect(count?.n).toBe(0);
  });

  it("is idempotent on a second run with the same stat row", async () => {
    const { teamIdMap, playerIdMap } = await seedMatchContext();
    const stat = makePlayerStats({
      playerId: "P-1",
      team: "Carlton",
      homeTeam: "Carlton",
      awayTeam: "Richmond",
      date: new Date("2026-03-19T08:30:00Z"),
      disposals: 25,
      timeOnGroundPercentage: 90,
    });

    await syncStats(env, [stat], teamIdMap, playerIdMap);
    await syncStats(env, [stat], teamIdMap, playerIdMap);

    const count = await env.DB.prepare("SELECT COUNT(*) as n FROM player_match_stats").first<{
      n: number;
    }>();
    expect(count?.n).toBe(1);
  });
});
