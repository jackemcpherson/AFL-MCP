import { env } from "cloudflare:test";
import type { fetchPlayerStats, PlayerStats } from "fitzroy";
import { expect, it } from "vitest";
import { queueRecentStatsRefresh, refreshDueStats } from "../../src/sync/stats-refresh";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import grandFinal from "../fixtures/grand-final-2026-transformed.json";
import { makeMatch, makePlayerStats } from "./_fixtures";

async function seed(count = 1) {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  const matches = Array.from({ length: count }, (_, i) =>
    makeMatch({
      matchId: `M-${i}`,
      date: new Date(Date.UTC(2026, 8, 1 + i, 8)),
    }),
  );
  const teamMap = await ensureTeams(env, competitionId, "AFLM", matches);
  const venueMap = await ensureVenues(env, matches);
  await upsertMatches(env, matches, { seasonId, teamMap, venueMap });
  return seasonId;
}

it("enriches all 46 existing participants without another completed match and retains known values", async () => {
  await seed();
  const now = new Date("2026-09-02T00:00:00Z");
  await queueRecentStatsRefresh(env, now);
  let pressure: number | null = null;
  const fetchStats: typeof fetchPlayerStats = async (query) => ({
    success: true,
    data: {
      stats: Array.from({ length: 46 }, (_, i) =>
        makePlayerStats({
          matchId: query.matchId ?? "missing",
          playerId: `P-${i}`,
          team: i < 23 ? "Carlton" : "Richmond",
          disposals: 10,
          timeOnGroundPercentage: 75,
          pressureActs: pressure,
        }),
      ),
      failedMatchIds: [],
    },
  });
  expect((await refreshDueStats(env, now, fetchStats)).changedRows).toBe(46);
  pressure = 12;
  expect(
    (await refreshDueStats(env, new Date("2026-09-02T01:00:00Z"), fetchStats)).changedRows,
  ).toBe(46);
  pressure = null;
  expect(
    (await refreshDueStats(env, new Date("2026-09-02T02:00:00Z"), fetchStats)).changedRows,
  ).toBe(0);
  expect(
    await env.DB.prepare("SELECT COUNT(*) FROM player_match_stats WHERE pressure_acts = 12").first(
      "COUNT(*)",
    ),
  ).toBe(46);
  pressure = 13;
  expect(
    (await refreshDueStats(env, new Date("2026-09-02T03:00:00Z"), fetchStats)).changedRows,
  ).toBe(46);
});

it("bounds a pass to 20 matches and isolates provider failures with persisted retries", async () => {
  await seed(22);
  const now = new Date("2026-09-23T00:00:00Z");
  await queueRecentStatsRefresh(env, now);
  const fetchStats: typeof fetchPlayerStats = async (query) =>
    query.matchId === "M-0"
      ? { success: false, error: new Error("captured provider failure") }
      : {
          success: true,
          data: {
            stats: [makePlayerStats({ matchId: query.matchId ?? "missing", disposals: 10 })],
            failedMatchIds: [],
          },
        };
  const first = await refreshDueStats(env, now, fetchStats);
  expect(first).toMatchObject({ attempted: 20, succeeded: 19, failed: 1 });
  const retry = await env.DB.prepare(
    "SELECT failures, next_retry_at FROM match_stats_refresh WHERE failures > 0",
  ).first();
  expect(retry).toEqual({ failures: 1, next_retry_at: "2026-09-23T01:00:00.000Z" });
  expect((await refreshDueStats(env, now, fetchStats)).attempted).toBe(2);
});

it("queues PAV only for input changes and preserves rebuild work after failure", async () => {
  await seed();
  const now = new Date("2026-09-02T00:00:00Z");
  await queueRecentStatsRefresh(env, now);
  const fetchStats: typeof fetchPlayerStats = async (query) => ({
    success: true,
    data: {
      stats: [makePlayerStats({ matchId: query.matchId ?? "missing", kicks: 8, disposals: 8 })],
      failedMatchIds: [],
    },
  });
  await refreshDueStats(env, now, fetchStats);
  await env.DB.prepare("UPDATE player_match_stats SET pressure_acts=20").run();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM pav_rebuild_queue").first("n")).toBe(0);
  await env.DB.prepare("UPDATE player_match_stats SET goals=COALESCE(goals,0)+1").run();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM pav_rebuild_queue").first("n")).toBe(1);
  // Failure after the fetch checkpoint must not drop the pending rebuild.
  const season = await env.DB.prepare(
    "SELECT season_id,team_id FROM player_match_stats JOIN matches ON matches.id=match_id",
  ).first<{ season_id: number; team_id: number }>();
  if (!season) throw new Error("Missing fixture");
  await env.DB.prepare(
    "INSERT INTO player_season_pav(player_id,season_id,team_id,total_pav) SELECT player_id,?1,?2,99 FROM player_match_stats",
  )
    .bind(season.season_id, season.team_id)
    .run();
  await env.DB.prepare(
    "CREATE TRIGGER fail_refresh_pav BEFORE DELETE ON player_season_pav BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  ).run();
  try {
    await expect(refreshDueStats(env, now, fetchStats)).rejects.toThrow("injected failure");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM pav_rebuild_queue").first("n")).toBe(1);
  } finally {
    await env.DB.prepare("DROP TRIGGER fail_refresh_pav").run();
  }
  expect((await refreshDueStats(env, now, fetchStats)).attempted).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM pav_rebuild_queue").first("n")).toBe(0);
});

it("recovers the captured 2026 Grand Final's 46 enriched appearances", async () => {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  const matches = [
    makeMatch({
      matchId: "CD_M20260142901",
      date: new Date("2026-09-26T04:30:00Z"),
      homeTeam: "Fremantle",
      awayTeam: "Brisbane Lions",
    }),
  ];
  const teamMap = await ensureTeams(env, competitionId, "AFLM", matches);
  const venueMap = await ensureVenues(env, matches);
  await upsertMatches(env, matches, { seasonId, teamMap, venueMap });
  const now = new Date("2026-09-27T00:00:00Z");
  await queueRecentStatsRefresh(env, now);
  let enriched = false;
  const fetchStats: typeof fetchPlayerStats = async () => ({
    success: true,
    data: {
      stats: (grandFinal as PlayerStats[]).map((row) =>
        enriched ? row : { ...row, pressureActs: null, spoils: null, ratingPoints: null },
      ),
      failedMatchIds: [],
    },
  });
  expect((await refreshDueStats(env, now, fetchStats)).changedRows).toBe(46);
  enriched = true;
  expect(
    (await refreshDueStats(env, new Date(now.getTime() + 3600000), fetchStats)).changedRows,
  ).toBe(46);
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM matches WHERE status='Complete'").first("n"),
  ).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT count(*) AS n FROM player_match_stats WHERE pressure_acts IS NOT NULL AND spoils IS NOT NULL AND rating_points IS NOT NULL",
    ).first("n"),
  ).toBe(46);
});
