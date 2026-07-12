import { describe, expect, it } from "vitest";
import {
  type BrownlowMatchRecord,
  type BrownlowPlayerRecord,
  resolveBrownlowSeason,
} from "../src/admin/brownlow";
import { makePlayerStats } from "./integration/_fixtures";

const regularMatch: BrownlowMatchRecord = {
  matchId: 10,
  date: "2026-03-19",
  roundType: "Regular",
  homeTeamId: 1,
  homeTeam: "GWS Giants",
  awayTeamId: 2,
  awayTeam: "Richmond",
};

function player(
  playerId: number,
  givenName: string,
  surname: string,
  overrides: Partial<BrownlowPlayerRecord> = {},
): BrownlowPlayerRecord {
  return { matchId: 10, teamId: 1, playerId, givenName, surname, ...overrides };
}

function vote(
  votes: number,
  givenName: string,
  surname: string,
  overrides: Parameters<typeof makePlayerStats>[0] = {},
) {
  return makePlayerStats({
    matchId: "AT_20260319",
    team: "GWS",
    givenName,
    surname,
    brownlowVotes: votes,
    source: "afl-tables",
    ...overrides,
  });
}

describe("resolveBrownlowSeason", () => {
  it("resolves exact, normalized, prefix/stem, and unique season names without round keys", () => {
    const players = [
      player(1, "Patrick", "Exact"),
      player(2, "alice", "Oneil"),
      player(3, "Alex", "Prefix"),
      player(4, "Season", "Fallback", { matchId: 99 }),
    ];
    const result = resolveBrownlowSeason(
      2026,
      [
        vote(3, "Patrick", "Exact"),
        vote(1, "Alice", "O'Neil"),
        vote(1, "Alexander", "Prefix"),
        vote(1, "Season", "Fallback"),
      ],
      0,
      [regularMatch],
      players,
    );

    expect(result.summary.resolution).toEqual({
      exact: 1,
      normalized: 1,
      surname: 1,
      seasonFallback: 1,
      unresolvedMatch: 0,
      unresolvedPlayer: 0,
      ambiguous: 0,
    });
    expect(result.summary.regularMatchTotals).toEqual({ zero: 0, six: 1, other: 0 });
    expect(result.summary.eligible).toBe(true);
    expect(result.writes.map(({ playerId }) => playerId)).toEqual([1, 2, 3, 4]);
  });

  it("never chooses among ambiguous names", () => {
    const result = resolveBrownlowSeason(
      2026,
      [vote(3, "Alex", "Smith")],
      0,
      [regularMatch],
      [player(1, "Alexander", "Smith"), player(2, "Alexandra", "Smith")],
    );
    expect(result.summary.resolution.ambiguous).toBe(1);
    expect(result.summary.eligible).toBe(false);
    expect(result.writes).toEqual([]);
  });

  it("never overwrites or chooses among duplicate match keys", () => {
    const duplicate = { ...regularMatch, matchId: 11, awayTeamId: 3, awayTeam: "Collingwood" };
    const result = resolveBrownlowSeason(
      2026,
      [vote(3, "Patrick", "Exact")],
      0,
      [regularMatch, duplicate],
      [player(1, "Patrick", "Exact")],
    );
    expect(result.summary.resolution.ambiguous).toBe(1);
    expect(result.summary.resolution.unresolvedMatch).toBe(0);
    expect(result.summary.eligible).toBe(false);
    expect(result.writes).toEqual([]);
  });

  it("counts missing matches and unresolved players without guessing", () => {
    const result = resolveBrownlowSeason(
      2026,
      [vote(3, "No", "Match", { matchId: "AT_20260320" }), vote(3, "No", "Player")],
      0,
      [regularMatch],
      [],
    );
    expect(result.summary.resolution.unresolvedMatch).toBe(1);
    expect(result.summary.resolution.unresolvedPlayer).toBe(1);
    expect(result.summary.eligible).toBe(false);
  });

  it("blocks partial envelopes and non-six regular totals", () => {
    const result = resolveBrownlowSeason(
      2026,
      [vote(3, "Patrick", "Exact")],
      1,
      [regularMatch],
      [player(1, "Patrick", "Exact")],
    );
    expect(result.summary.failedMatchCount).toBe(1);
    expect(result.summary.regularMatchTotals.other).toBe(1);
    expect(result.summary.eligible).toBe(false);
  });

  it("rejects positive finals votes", () => {
    const final = { ...regularMatch, roundType: "Finals" };
    const result = resolveBrownlowSeason(
      2026,
      [vote(3, "Patrick", "Exact")],
      0,
      [final],
      [player(1, "Patrick", "Exact")],
    );
    expect(result.summary.positiveVoteRows).toBe(1);
    expect(result.summary.eligible).toBe(false);
    expect(result.writes).toEqual([]);
  });

  it("treats a wholly zero-vote season as unpublished", () => {
    const result = resolveBrownlowSeason(
      2026,
      [vote(0, "Patrick", "Exact")],
      0,
      [regularMatch],
      [player(1, "Patrick", "Exact")],
    );
    expect(result.summary.notPublished).toBe(true);
    expect(result.summary.eligible).toBe(false);
    expect(result.summary.positiveVoteRows).toBe(0);
    expect(result.writes).toEqual([]);
  });
});
