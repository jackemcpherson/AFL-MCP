import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { calculatePav } from "../../src/sync/pav";
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

interface PavRow {
  off_pav: number;
  mid_pav: number;
  def_pav: number;
  total_pav: number;
}

/**
 * Seed an AFLW season with one match and stats good enough for the PAV
 * formula to produce non-zero output. The formula leans on team
 * inside-50s (must be > 0) and player goal_assists / marks_inside_fifty /
 * one_percenters; we populate them with modest non-zero values.
 */
async function seedAflwMatch(year: number): Promise<void> {
  const competitionId = await ensureCompetition(env, "AFLW");
  const seasonId = await ensureSeason(env, competitionId, year);
  const match = makeMatch({
    competition: "AFLW",
    season: year,
    matchId: "AFLW-PAV-1",
    roundCode: "Week 1",
    roundType: "HomeAndAway",
    homeTeam: "Geelong Cats",
    awayTeam: "Melbourne",
    homeGoals: 5,
    homeBehinds: 4,
    homePoints: 34,
    awayGoals: 4,
    awayBehinds: 5,
    awayPoints: 29,
    margin: 5,
  });
  const teamMap = await ensureTeams(env, competitionId, "AFLW", [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
  const matchMap = await buildMatchAflIdMap(env, seasonId);

  const players = Array.from({ length: 6 }, (_, i) => ({
    playerId: `AFLW-P-${i + 1}`,
    givenName: `Player`,
    surname: `Number${i + 1}`,
  }));
  const playerMap = await upsertPlayers(env, players);

  const homeStats = players.slice(0, 3).map((p, i) =>
    makePlayerStats({
      matchId: "AFLW-PAV-1",
      season: year,
      playerId: p.playerId,
      team: "Geelong Cats",
      homeTeam: "Geelong Cats",
      awayTeam: "Melbourne",
      timeOnGroundPercentage: 90,
      disposals: 18 + i,
      kicks: 10 + i,
      handballs: 8,
      marks: 5,
      tackles: 3,
      goals: i,
      behinds: 1,
      goalAssists: 1,
      inside50s: 4 + i,
      marksInside50: 1,
      onePercenters: 2,
      freesFor: 1,
      freesAgainst: 1,
      hitouts: i === 0 ? 12 : 0,
      totalClearances: 4,
      rebound50s: 1,
    }),
  );
  const awayStats = players.slice(3, 6).map((p, i) =>
    makePlayerStats({
      matchId: "AFLW-PAV-1",
      season: year,
      playerId: p.playerId,
      team: "Melbourne",
      homeTeam: "Geelong Cats",
      awayTeam: "Melbourne",
      timeOnGroundPercentage: 88,
      disposals: 17 + i,
      kicks: 9 + i,
      handballs: 8,
      marks: 4,
      tackles: 4,
      goals: i === 2 ? 2 : 1,
      behinds: 1,
      goalAssists: 1,
      inside50s: 3 + i,
      marksInside50: 1,
      onePercenters: 2,
      freesFor: 1,
      freesAgainst: 1,
      hitouts: i === 0 ? 10 : 0,
      totalClearances: 3,
      rebound50s: 1,
    }),
  );

  await upsertStats(env, [...homeStats, ...awayStats], matchMap, playerMap, teamMap);
}

describe("calculatePav for AFLW", () => {
  it("produces non-zero PAV rows for each team in a seeded AFLW season", async () => {
    await seedAflwMatch(2025);

    const upserts = await calculatePav(env, 2025, "AFLW");
    expect(upserts).toBeGreaterThan(0);

    const rows = await env.DB.prepare(
      `SELECT psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav
         FROM player_season_pav psp
         JOIN seasons s ON psp.season_id = s.id
         JOIN competitions c ON s.competition_id = c.id
         WHERE c.code = 'AFLW' AND s.year = 2025`,
    ).all<PavRow>();

    // 6 stat rows → up to 6 PAV rows (one per player_id × team_id).
    expect(rows.results.length).toBeGreaterThan(0);
    // At least one row should have a non-zero total_pav — i.e. the formula
    // wired up end-to-end.
    expect(rows.results.some((r) => r.total_pav > 0)).toBe(true);
  });

  it("does NOT produce PAV rows for AFLM if only AFLW data is seeded", async () => {
    await seedAflwMatch(2025);
    await calculatePav(env, 2025, "AFLW");

    const aflmRows = await env.DB.prepare(
      `SELECT COUNT(*) AS n
         FROM player_season_pav psp
         JOIN seasons s ON psp.season_id = s.id
         JOIN competitions c ON s.competition_id = c.id
         WHERE c.code = 'AFLM'`,
    ).first<{ n: number }>();
    expect(aflmRows?.n).toBe(0);
  });

  it("rejects calculatePav for AFLW years before 2017", async () => {
    await expect(calculatePav(env, 2016, "AFLW")).rejects.toThrow(/AFLW is supported from 2017/);
  });
});
