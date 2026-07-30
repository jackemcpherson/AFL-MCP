import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  quarantinePlaceholderMatches,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

async function setup() {
  const competitionId = await ensureCompetition(env, "AFLM");
  const seasonId = await ensureSeason(env, competitionId, 2026);
  return { competitionId, seasonId };
}

function makePlaceholderFinal(matchId: string, homeTeam: string, awayTeam: string) {
  return makeMatch({
    matchId,
    homeTeam,
    awayTeam,
    date: new Date("2026-08-31T09:00:00Z"),
    roundNumber: 26,
    roundName: "Qualifying & Elimination Finals",
    roundType: "Finals",
    status: "Upcoming",
    homeGoals: null,
    homeBehinds: null,
    homePoints: null,
    awayGoals: null,
    awayBehinds: null,
    awayPoints: null,
    margin: null,
    attendance: null,
  });
}

describe("quarantinePlaceholderMatches", () => {
  it("filters placeholder finals out and passes real matches through", async () => {
    const { competitionId } = await setup();
    const real = makeMatch({ matchId: "M-REAL" });
    const ghost = makePlaceholderFinal("M-GHOST", "1st", "4th");

    const syncable = await quarantinePlaceholderMatches(env, competitionId, "AFLM", [real, ghost]);

    expect(syncable.map((m) => m.matchId)).toEqual(["M-REAL"]);
  });

  it("returns the input untouched and logs nothing when no placeholders exist", async () => {
    const { competitionId } = await setup();
    const matches = [makeMatch()];

    const syncable = await quarantinePlaceholderMatches(env, competitionId, "AFLM", matches);

    expect(syncable).toEqual(matches);
    const log = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sync_log WHERE type LIKE 'sync:placeholder-match:%'",
    ).first<{ n: number }>();
    expect(log?.n).toBe(0);
  });

  it("writes one sync:placeholder-match log row naming the placeholders", async () => {
    const { competitionId } = await setup();
    const ghost1 = makePlaceholderFinal("M-G1", "5th", "Lowest-ranked WF Winner");
    const ghost2 = makePlaceholderFinal("M-G2", "Loser of QF1", "Winner of EF1");

    await quarantinePlaceholderMatches(env, competitionId, "AFLM", [ghost1, ghost2]);

    const row = await env.DB.prepare(
      "SELECT type, rows_affected, error FROM sync_log WHERE type = 'sync:placeholder-match:AFLM'",
    ).first<{ type: string; rows_affected: number; error: string }>();
    expect(row?.rows_affected).toBe(2);
    expect(row?.error).toContain("5th");
    expect(row?.error).toContain("Winner of EF1");
  });

  it("self-heals placeholder team and match rows written by a pre-guard Worker", async () => {
    const { competitionId, seasonId } = await setup();
    // Simulate the pre-guard behaviour: placeholder names become team rows
    // and the placeholder fixture becomes a matches row.
    const ghost = makePlaceholderFinal("M-GHOST", "1st", "4th");
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [ghost]);
    const venueMap = await ensureVenues(env, [ghost]);
    await upsertMatches(env, [ghost], { seasonId, teamMap, venueMap });

    const before = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM teams WHERE name IN ('1st','4th')) AS teams, (SELECT COUNT(*) FROM matches WHERE external_afl_id = 'M-GHOST') AS matches",
    ).first<{ teams: number; matches: number }>();
    expect(before).toEqual({ teams: 2, matches: 1 });

    // Next sync tick with the guard in place: rows are removed.
    await quarantinePlaceholderMatches(env, competitionId, "AFLM", [ghost]);

    const after = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM teams WHERE name IN ('1st','4th')) AS teams, (SELECT COUNT(*) FROM matches WHERE external_afl_id = 'M-GHOST') AS matches",
    ).first<{ teams: number; matches: number }>();
    expect(after).toEqual({ teams: 0, matches: 0 });
  });

  it("does not delete real teams or their matches", async () => {
    const { competitionId, seasonId } = await setup();
    const real = makeMatch({ matchId: "M-REAL" });
    const teamMap = await ensureTeams(env, competitionId, "AFLM", [real]);
    const venueMap = await ensureVenues(env, [real]);
    await upsertMatches(env, [real], { seasonId, teamMap, venueMap });

    const ghost = makePlaceholderFinal("M-GHOST", "Winner of PF1", "Winner of PF2");
    await quarantinePlaceholderMatches(env, competitionId, "AFLM", [real, ghost]);

    const counts = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM teams WHERE name IN ('Carlton','Richmond')) AS teams, (SELECT COUNT(*) FROM matches WHERE external_afl_id = 'M-REAL') AS matches",
    ).first<{ teams: number; matches: number }>();
    expect(counts).toEqual({ teams: 2, matches: 1 });
  });
});
