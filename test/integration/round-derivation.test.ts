import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  upsertMatches,
} from "../../src/sync/upserts";
import { makeMatch } from "./_fixtures";

interface RoundRow {
  round: string;
  round_abbreviation: string;
  round_number: number | null;
  round_type: string;
}

async function setup(competition: "AFLM" | "AFLW" | "VFL" | "VFLW", year: number) {
  const competitionId = await ensureCompetition(env, competition);
  const seasonId = await ensureSeason(env, competitionId, year);
  return { competitionId, seasonId };
}

async function upsertOne(
  competition: "AFLM" | "AFLW" | "VFL" | "VFLW",
  season: number,
  overrides: Parameters<typeof makeMatch>[0],
) {
  const { competitionId, seasonId } = await setup(competition, season);
  const match = makeMatch({
    competition,
    season,
    matchId: `M-${competition}-${overrides?.roundName ?? overrides?.roundNumber}`,
    homeTeam: `Home${competition}`,
    awayTeam: `Away${competition}`,
    ...overrides,
  });
  const teamMap = await ensureTeams(env, competitionId, [match]);
  const venueMap = await ensureVenues(env, [match]);
  await upsertMatches(env, [match], { seasonId, teamMap, venueMap });

  return env.DB.prepare(
    `SELECT m.round, m.round_abbreviation, m.round_number, m.round_type
       FROM matches m
       JOIN seasons s ON m.season_id = s.id
       WHERE s.id = ?`,
  )
    .bind(seasonId)
    .first<RoundRow>();
}

// Mirrors R fitzRoy: long-form `round` matches AFL API's `round.name`,
// and `round_abbreviation` matches AFL API's `round.abbreviation`.
describe("deriveRound + deriveRoundAbbreviation (via upsertMatches)", () => {
  describe("AFLM", () => {
    it("regular round: round='Round 1', round_abbreviation='Rd 1'", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: "Round 1",
        roundNumber: 1,
        roundType: "HomeAndAway",
      });
      expect(row).toEqual({
        round: "Round 1",
        round_abbreviation: "Rd 1",
        round_number: 1,
        round_type: "Regular",
      });
    });

    it("Opening Round: round='Opening Round', round_abbreviation='OR'", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: "Opening Round",
        roundNumber: 0,
        roundType: "HomeAndAway",
      });
      expect(row).toEqual({
        round: "Opening Round",
        round_abbreviation: "OR",
        round_number: 0,
        round_type: "Regular",
      });
    });

    it("falls back to 'Opening Round'/'OR' when roundName is null and rn=0", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: null,
        roundCode: null,
        roundNumber: 0,
        roundType: "HomeAndAway",
      });
      expect(row).toEqual({
        round: "Opening Round",
        round_abbreviation: "OR",
        round_number: 0,
        round_type: "Regular",
      });
    });

    it("Finals Week 1: round='Finals Week 1', round_abbreviation='FW1'", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: "Finals Week 1",
        roundNumber: 25,
        roundType: "Finals",
        date: new Date("2026-09-04T08:30:00Z"),
      });
      expect(row).toEqual({
        round: "Finals Week 1",
        round_abbreviation: "FW1",
        round_number: 25,
        round_type: "Finals",
      });
    });

    it("Semi Finals → SF", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: "Semi Finals",
        roundNumber: 26,
        roundType: "Finals",
        date: new Date("2026-09-11T08:30:00Z"),
      });
      expect(row?.round).toBe("Semi Finals");
      expect(row?.round_abbreviation).toBe("SF");
    });

    it("Preliminary Finals → PF", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: "Preliminary Finals",
        roundNumber: 27,
        roundType: "Finals",
        date: new Date("2026-09-18T08:30:00Z"),
      });
      expect(row?.round).toBe("Preliminary Finals");
      expect(row?.round_abbreviation).toBe("PF");
    });

    it("Grand Final → GF", async () => {
      const row = await upsertOne("AFLM", 2026, {
        roundName: "Grand Final",
        roundNumber: 28,
        roundType: "Finals",
        date: new Date("2026-09-26T08:30:00Z"),
      });
      expect(row?.round).toBe("Grand Final");
      expect(row?.round_abbreviation).toBe("GF");
    });
  });

  describe("AFLW", () => {
    it("regular round: round='Round 1', round_abbreviation='Rd 1'", async () => {
      const row = await upsertOne("AFLW", 2025, {
        roundName: "Round 1",
        roundNumber: 1,
        roundType: "HomeAndAway",
        date: new Date("2025-08-22T08:30:00Z"),
      });
      expect(row).toEqual({
        round: "Round 1",
        round_abbreviation: "Rd 1",
        round_number: 1,
        round_type: "Regular",
      });
    });
  });

  describe("VFL", () => {
    it("regular round → Rd N", async () => {
      const row = await upsertOne("VFL", 2025, {
        roundName: "Round 1",
        roundNumber: 1,
        roundType: "HomeAndAway",
        date: new Date("2025-04-04T08:30:00Z"),
      });
      expect(row?.round).toBe("Round 1");
      expect(row?.round_abbreviation).toBe("Rd 1");
    });

    it("Wildcard → WC", async () => {
      const row = await upsertOne("VFL", 2025, {
        roundName: "Wildcard",
        roundNumber: 22,
        roundType: "HomeAndAway",
        date: new Date("2025-08-22T08:30:00Z"),
      });
      expect(row).toEqual({
        round: "Wildcard",
        round_abbreviation: "WC",
        round_number: 22,
        round_type: "Regular",
      });
    });
  });

  describe("VFLW", () => {
    it("regular round → Rd N", async () => {
      const row = await upsertOne("VFLW", 2025, {
        roundName: "Round 1",
        roundNumber: 1,
        roundType: "HomeAndAway",
        date: new Date("2025-04-19T08:30:00Z"),
      });
      expect(row?.round).toBe("Round 1");
      expect(row?.round_abbreviation).toBe("Rd 1");
    });
  });
});
