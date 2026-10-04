import { describe, expect, it } from "vitest";
import { correctVerifiedMatch } from "../src/sync/source-corrections";
import { makeMatch } from "./integration/_fixtures";

describe("reviewed provider discrepancies", () => {
  it("does not import Adelaide-Geelong's cancelled 2015 fixture as a played draw", () => {
    const match = makeMatch({
      matchId: "CD_M20150141408",
      season: 2015,
      homeTeam: "Adelaide Crows",
      awayTeam: "Geelong Cats",
      homePoints: 0,
      awayPoints: 0,
      margin: 0,
    });
    expect(correctVerifiedMatch(match)).toMatchObject({
      status: "Cancelled",
      homePoints: null,
      awayPoints: null,
      margin: null,
      q1Home: null,
    });
    expect(match.status).toBe("Complete");
  });

  it("preserves the 2015 Grand Final historical perspective and transposes scores together", () => {
    const quarter = { goals: 5, behinds: 3, points: 33 };
    const match = makeMatch({
      matchId: "CD_M20150142701",
      season: 2015,
      homeTeam: "Hawthorn",
      awayTeam: "West Coast Eagles",
      homePoints: 107,
      awayPoints: 61,
      margin: 46,
      q1Home: quarter,
      q1Away: null,
    });
    const corrected = correctVerifiedMatch(match);
    expect(corrected).toMatchObject({
      homeTeam: "West Coast Eagles",
      awayTeam: "Hawthorn",
      homePoints: 61,
      awayPoints: 107,
      margin: -46,
      q1Home: null,
      q1Away: quarter,
    });
    expect(correctVerifiedMatch(corrected)).toEqual(corrected);
  });

  it("fails closed if a reviewed source ID acquires unexpected participants", () => {
    expect(() =>
      correctVerifiedMatch(makeMatch({ matchId: "CD_M20150142701", season: 2015 })),
    ).toThrow(/participant mapping/);
  });
});
