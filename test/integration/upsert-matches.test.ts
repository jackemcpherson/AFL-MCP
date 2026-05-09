import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  selectMaxCompletedDate,
  selectNextRound,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

async function setup() {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  return { competitionId, seasonId };
}

describe("upsertMatches", () => {
  it("inserts a completed match with scores", async () => {
    const { competitionId, seasonId } = await setup();
    const match = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, [match]);
    const venueMap = await ensureVenues(env, [match]);

    await upsertMatches(env, [match], { seasonId, teamMap, venueMap });

    const row = await env.DB.prepare(
      "SELECT external_afl_id, home_points, away_points, round, round_type FROM matches",
    ).first<{
      external_afl_id: string;
      home_points: number;
      away_points: number;
      round: string;
      round_type: string;
    }>();
    expect(row).toEqual({
      external_afl_id: "M-1",
      home_points: 80,
      away_points: 69,
      round: "R1",
      round_type: "Regular",
    });
  });

  it("inserts an upcoming fixture (null scores) with the same upsert path", async () => {
    const { competitionId, seasonId } = await setup();
    const upcoming = makeMatch({
      matchId: "M-FUT",
      date: new Date("2026-08-01T10:00:00Z"),
      homePoints: null,
      awayPoints: null,
      homeGoals: null,
      homeBehinds: null,
      awayGoals: null,
      awayBehinds: null,
      margin: null,
      attendance: null,
      status: "Upcoming",
    });
    const teamMap = await ensureTeams(env, competitionId, [upcoming]);
    const venueMap = await ensureVenues(env, [upcoming]);

    await upsertMatches(env, [upcoming], { seasonId, teamMap, venueMap });

    const row = await env.DB.prepare(
      "SELECT external_afl_id, home_points, away_points FROM matches",
    ).first<{
      external_afl_id: string;
      home_points: number | null;
      away_points: number | null;
    }>();
    expect(row).toEqual({ external_afl_id: "M-FUT", home_points: null, away_points: null });
  });

  it("does not clobber a completed match's scores when re-fetched as upcoming (COALESCE)", async () => {
    const { competitionId, seasonId } = await setup();
    const completed = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, [completed]);
    const venueMap = await ensureVenues(env, [completed]);
    await upsertMatches(env, [completed], { seasonId, teamMap, venueMap });

    // Same date+teams (so it hits the unique constraint), but with null scores
    // — simulating a defective upstream re-fetch. Scores should NOT be reset.
    await upsertMatches(
      env,
      [
        makeMatch({
          homePoints: null,
          awayPoints: null,
          homeGoals: null,
          homeBehinds: null,
          awayGoals: null,
          awayBehinds: null,
          margin: null,
        }),
      ],
      { seasonId, teamMap, venueMap },
    );

    const row = await env.DB.prepare("SELECT home_points, away_points FROM matches").first<{
      home_points: number;
      away_points: number;
    }>();
    expect(row).toEqual({ home_points: 80, away_points: 69 });
  });

  it("upserts corrected scores when re-fetched with non-null values (e.g. AFL adjustment)", async () => {
    const { competitionId, seasonId } = await setup();
    const original = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, [original]);
    const venueMap = await ensureVenues(env, [original]);
    await upsertMatches(env, [original], { seasonId, teamMap, venueMap });

    await upsertMatches(env, [makeMatch({ homePoints: 84, awayPoints: 70 })], {
      seasonId,
      teamMap,
      venueMap,
    });

    const row = await env.DB.prepare("SELECT home_points, away_points FROM matches").first<{
      home_points: number;
      away_points: number;
    }>();
    expect(row).toEqual({ home_points: 84, away_points: 70 });
  });

  it("derives 'Opening Round' from roundNumber=0 (no roundCode required)", async () => {
    const { competitionId, seasonId } = await setup();
    const opening = makeMatch({
      matchId: "M-OR",
      roundNumber: 0,
      roundName: null,
      roundCode: null,
      date: new Date("2026-03-06T08:30:00Z"),
    });
    const teamMap = await ensureTeams(env, competitionId, [opening]);
    const venueMap = await ensureVenues(env, [opening]);
    await upsertMatches(env, [opening], { seasonId, teamMap, venueMap });

    const row = await env.DB.prepare("SELECT round, round_number FROM matches").first<{
      round: string;
      round_number: number;
    }>();
    expect(row).toEqual({ round: "Opening Round", round_number: 0 });
  });
});

describe("selectMaxCompletedDate", () => {
  it("returns null when no completed matches exist", async () => {
    const { seasonId } = await setup();
    expect(await selectMaxCompletedDate(env, seasonId)).toBeNull();
  });

  it("returns the latest completed match date", async () => {
    const { competitionId, seasonId } = await setup();
    const m1 = makeMatch({ matchId: "M-1", date: new Date("2026-03-19T08:30:00Z") });
    const m2 = makeMatch({
      matchId: "M-2",
      date: new Date("2026-03-26T08:30:00Z"),
      homeTeam: "Geelong",
      awayTeam: "Sydney",
    });
    const teamMap = await ensureTeams(env, competitionId, [m1, m2]);
    const venueMap = await ensureVenues(env, [m1, m2]);
    await upsertMatches(env, [m1, m2], { seasonId, teamMap, venueMap });

    expect(await selectMaxCompletedDate(env, seasonId)).toBe("2026-03-26");
  });
});

describe("selectNextRound", () => {
  it("returns null when there are no scheduled (uncompleted) matches", async () => {
    const { seasonId } = await setup();
    expect(await selectNextRound(env, seasonId)).toBeNull();
  });

  it("returns the smallest round_number among matches with NULL home_points", async () => {
    const { competitionId, seasonId } = await setup();
    const completed = makeMatch({ matchId: "M-1", roundNumber: 1 });
    const upcoming1 = makeMatch({
      matchId: "M-2",
      roundNumber: 3,
      homeTeam: "Geelong",
      awayTeam: "Sydney",
      date: new Date("2026-04-09T08:30:00Z"),
      homePoints: null,
      awayPoints: null,
    });
    const upcoming2 = makeMatch({
      matchId: "M-3",
      roundNumber: 2,
      homeTeam: "Hawthorn",
      awayTeam: "Melbourne",
      date: new Date("2026-04-02T08:30:00Z"),
      homePoints: null,
      awayPoints: null,
    });
    const matches = [completed, upcoming1, upcoming2];
    const teamMap = await ensureTeams(env, competitionId, matches);
    const venueMap = await ensureVenues(env, matches);
    await upsertMatches(env, matches, { seasonId, teamMap, venueMap });

    expect(await selectNextRound(env, seasonId)).toBe(2);
  });

  it("returns 0 when an Opening Round match is still scheduled (no special-case needed)", async () => {
    const { competitionId, seasonId } = await setup();
    const opening = makeMatch({
      matchId: "M-OR",
      roundNumber: 0,
      roundCode: null,
      roundName: null,
      date: new Date("2026-03-06T08:30:00Z"),
      homePoints: null,
      awayPoints: null,
    });
    const teamMap = await ensureTeams(env, competitionId, [opening]);
    const venueMap = await ensureVenues(env, [opening]);
    await upsertMatches(env, [opening], { seasonId, teamMap, venueMap });

    expect(await selectNextRound(env, seasonId)).toBe(0);
  });
});
