import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  selectCompletedCount,
  selectHasCompletedMatchWithoutStats,
  selectNextRound,
  upsertMatches,
  upsertPlayers,
  upsertStats,
} from "../../src/sync/upserts";
import { makeMatch, makePlayerStats } from "./_fixtures";

async function setup() {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  return { competitionId, seasonId };
}

describe("upsertMatches", () => {
  it("inserts a completed match with scores", async () => {
    const { competitionId, seasonId } = await setup();
    const match = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
    const venueMap = await ensureVenues(env, [match]);

    await upsertMatches(env, [match], { seasonId, teamMap, venueMap });

    const row = await env.DB.prepare(
      "SELECT external_afl_id, home_points, away_points, round, round_abbreviation, round_type FROM matches",
    ).first<{
      external_afl_id: string;
      home_points: number;
      away_points: number;
      round: string;
      round_abbreviation: string;
      round_type: string;
    }>();
    expect(row).toEqual({
      external_afl_id: "M-1",
      home_points: 80,
      away_points: 69,
      round: "Round 1",
      round_abbreviation: "Rd 1",
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
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [upcoming]);
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
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [completed]);
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
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [original]);
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

  it("returns the change count: real inserts, then 0 on identical re-upsert, then >0 on a real diff", async () => {
    const { competitionId, seasonId } = await setup();
    const match = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
    const venueMap = await ensureVenues(env, [match]);

    const firstChanges = await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
    expect(firstChanges).toBe(1);

    const idempotentChanges = await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
    expect(idempotentChanges).toBe(0);

    const corrected = makeMatch({ homePoints: 84, awayPoints: 70 });
    const diffChanges = await upsertMatches(env, [corrected], { seasonId, teamMap, venueMap });
    expect(diffChanges).toBe(1);

    // A subsequent re-fetch with all-null scores leaves the row unchanged via
    // COALESCE — the WHERE predicate must respect that and report 0 changes.
    const noopRefetch = makeMatch({
      homePoints: null,
      awayPoints: null,
      homeGoals: null,
      homeBehinds: null,
      awayGoals: null,
      awayBehinds: null,
      margin: null,
    });
    const coalesceNoopChanges = await upsertMatches(env, [noopRefetch], {
      seasonId,
      teamMap,
      venueMap,
    });
    expect(coalesceNoopChanges).toBe(0);
  });

  it("derives 'Opening Round' from roundNumber=0 (no roundName/roundCode required)", async () => {
    const { competitionId, seasonId } = await setup();
    const opening = makeMatch({
      matchId: "M-OR",
      roundNumber: 0,
      roundName: null,
      roundCode: null,
      date: new Date("2026-03-06T08:30:00Z"),
    });
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [opening]);
    const venueMap = await ensureVenues(env, [opening]);
    await upsertMatches(env, [opening], { seasonId, teamMap, venueMap });

    const row = await env.DB.prepare(
      "SELECT round, round_abbreviation, round_number FROM matches",
    ).first<{
      round: string;
      round_abbreviation: string;
      round_number: number;
    }>();
    expect(row).toEqual({ round: "Opening Round", round_abbreviation: "OR", round_number: 0 });
  });

  // Issue #80 regression — see CHANGELOG v3.1.0.
  it("realigns a row in place when the AFL revises the fixture (date moves; external_afl_id stable)", async () => {
    const { competitionId, seasonId } = await setup();
    const original = makeMatch({
      matchId: "M-RV",
      date: new Date("2026-06-22T08:30:00Z"),
      homePoints: null,
      awayPoints: null,
    });
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [original]);
    const venueMap = await ensureVenues(env, [original]);
    await upsertMatches(env, [original], { seasonId, teamMap, venueMap });

    const revised = makeMatch({
      matchId: "M-RV",
      date: new Date("2026-06-25T08:30:00Z"),
      homePoints: null,
      awayPoints: null,
    });
    const changes = await upsertMatches(env, [revised], { seasonId, teamMap, venueMap });
    expect(changes).toBe(1);

    const rows = await env.DB.prepare(
      "SELECT id, date, external_afl_id FROM matches WHERE external_afl_id = ?",
    )
      .bind("M-RV")
      .all<{ id: number; date: string; external_afl_id: string }>();
    expect(rows.results.length).toBe(1);
    expect(rows.results[0]?.date).toBe("2026-06-25");
  });

  it("backfills external_afl_id via the (date, home, away) conflict path on historical rows", async () => {
    const { competitionId, seasonId } = await setup();
    const m = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [m]);
    const venueMap = await ensureVenues(env, [m]);

    // Seed a row directly with NULL external_afl_id to simulate historical
    // data loaded from a source (afltables / footywire) that doesn't
    // populate the AFL API id. fitzroy then later returns this match with
    // an external_afl_id and we expect the (date, home, away) clause to
    // COALESCE the new id in rather than failing.
    await env.DB.prepare(
      `INSERT INTO matches (external_afl_id, season_id, date, home_team_id, away_team_id, venue_id, round, round_abbreviation, round_number, round_type)
       VALUES (NULL, ?, ?, ?, ?, ?, 'Round 1', 'Rd 1', 1, 'Regular')`,
    )
      .bind(
        seasonId,
        "2026-03-19",
        teamMap.get("Carlton") ?? null,
        teamMap.get("Richmond") ?? null,
        venueMap.get("MCG") ?? null,
      )
      .run();

    await upsertMatches(env, [makeMatch({ matchId: "M-BF" })], { seasonId, teamMap, venueMap });

    const after = await env.DB.prepare("SELECT id, date, external_afl_id FROM matches").all<{
      id: number;
      date: string;
      external_afl_id: string | null;
    }>();
    expect(after.results.length).toBe(1);
    expect(after.results[0]?.external_afl_id).toBe("M-BF");
  });
});

describe("selectCompletedCount", () => {
  it("returns 0 when no completed matches exist", async () => {
    const { seasonId } = await setup();
    expect(await selectCompletedCount(env, seasonId)).toBe(0);
  });

  it("counts only matches with non-null home_points", async () => {
    const { competitionId, seasonId } = await setup();
    const completed = makeMatch({ matchId: "M-1", date: new Date("2026-03-19T08:30:00Z") });
    const alsoCompleted = makeMatch({
      matchId: "M-2",
      date: new Date("2026-03-26T08:30:00Z"),
      homeTeam: "Geelong",
      awayTeam: "Sydney",
    });
    const upcoming = makeMatch({
      matchId: "M-3",
      date: new Date("2026-04-02T08:30:00Z"),
      homeTeam: "Hawthorn",
      awayTeam: "Essendon",
      homePoints: null,
      awayPoints: null,
      homeGoals: null,
      homeBehinds: null,
      awayGoals: null,
      awayBehinds: null,
      margin: null,
    });
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [
      completed,
      alsoCompleted,
      upcoming,
    ]);
    const venueMap = await ensureVenues(env, [completed, alsoCompleted, upcoming]);
    await upsertMatches(env, [completed, alsoCompleted, upcoming], { seasonId, teamMap, venueMap });

    expect(await selectCompletedCount(env, seasonId)).toBe(2);
  });
});

describe("selectHasCompletedMatchWithoutStats", () => {
  it("returns false when no matches exist", async () => {
    const { seasonId } = await setup();
    expect(await selectHasCompletedMatchWithoutStats(env, seasonId)).toBe(false);
  });

  it("returns true when a completed match has no player_match_stats rows", async () => {
    const { competitionId, seasonId } = await setup();
    const match = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
    const venueMap = await ensureVenues(env, [match]);
    await upsertMatches(env, [match], { seasonId, teamMap, venueMap });

    expect(await selectHasCompletedMatchWithoutStats(env, seasonId)).toBe(true);
  });

  it("returns false once a completed match has at least one stat row", async () => {
    const { competitionId, seasonId } = await setup();
    const match = makeMatch();
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [match]);
    const venueMap = await ensureVenues(env, [match]);
    await upsertMatches(env, [match], { seasonId, teamMap, venueMap });
    const matchMap = await buildMatchAflIdMap(env, seasonId);
    const playerMap = await upsertPlayers(env, [
      { playerId: "P-1", givenName: "Patrick", surname: "Cripps" },
    ]);
    await upsertStats(
      env,
      [makePlayerStats({ playerId: "P-1", disposals: 25, timeOnGroundPercentage: 90 })],
      matchMap,
      playerMap,
      teamMap,
    );

    expect(await selectHasCompletedMatchWithoutStats(env, seasonId)).toBe(false);
  });

  it("ignores upcoming matches (home_points IS NULL)", async () => {
    const { competitionId, seasonId } = await setup();
    const upcoming = makeMatch({
      matchId: "M-UP",
      homePoints: null,
      awayPoints: null,
      homeGoals: null,
      homeBehinds: null,
      awayGoals: null,
      awayBehinds: null,
      margin: null,
    });
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [upcoming]);
    const venueMap = await ensureVenues(env, [upcoming]);
    await upsertMatches(env, [upcoming], { seasonId, teamMap, venueMap });

    expect(await selectHasCompletedMatchWithoutStats(env, seasonId)).toBe(false);
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
    const teamMap = await ensureTeams(env, competitionId, "AFLM", matches);
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
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [opening]);
    const venueMap = await ensureVenues(env, [opening]);
    await upsertMatches(env, [opening], { seasonId, teamMap, venueMap });

    expect(await selectNextRound(env, seasonId)).toBe(0);
  });
});
