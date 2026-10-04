import type { Match } from "fitzroy";

/** Reviewed source discrepancies, retained separately from raw provider inventories. */
export const VERIFIED_MATCH_CORRECTIONS = {
  CD_M20150141408: {
    correction: "Cancelled fixture; provider Complete/0-0 is not a played draw",
    evidence:
      "https://www.afl.com.au/news/197577/crows-clash-with-geelong-abandoned-remainder-of-round-14-to-go-ahead",
  },
  CD_M20150142701: {
    correction: "Retain the historical West Coast home perspective and existing match identity",
    evidence: "https://afltables.com/afl/seas/2015.html",
    corroboration:
      "https://www.afl.com.au/news/198688/grand-final-match-report-hot-hawks-scorch-past-eagles-to-complete-three-peat",
  },
} as const;

/**
 * Apply only reviewed source-ID corrections. Raw provider evidence is stored first.
 * @param match - Exact provider fixture.
 * @returns The fixture in the stored historical perspective, with known cancellation respected.
 */
export function correctVerifiedMatch(match: Match): Match {
  if (match.competition !== "AFLM" || match.season !== 2015) return match;
  if (match.matchId === "CD_M20150141408")
    return {
      ...match,
      status: "Cancelled",
      homeGoals: null,
      homeBehinds: null,
      homePoints: null,
      awayGoals: null,
      awayBehinds: null,
      awayPoints: null,
      margin: null,
      q1Home: null,
      q2Home: null,
      q3Home: null,
      q4Home: null,
      q1Away: null,
      q2Away: null,
      q3Away: null,
      q4Away: null,
      completedQuarter: null,
    };
  if (match.matchId !== "CD_M20150142701") return match;
  if (match.homeTeam === "West Coast Eagles") return match;
  if (match.homeTeam !== "Hawthorn" || match.awayTeam !== "West Coast Eagles")
    throw new Error("Reviewed 2015 Grand Final participant mapping no longer matches provider");
  const pairs = [
    ["homeTeam", "awayTeam"],
    ["homeGoals", "awayGoals"],
    ["homeBehinds", "awayBehinds"],
    ["homePoints", "awayPoints"],
    ["homeRushedBehinds", "awayRushedBehinds"],
    ["homeMinutesInFront", "awayMinutesInFront"],
    ["q1Home", "q1Away"],
    ["q2Home", "q2Away"],
    ["q3Home", "q3Away"],
    ["q4Home", "q4Away"],
  ] as const;
  const names = new Map<string, string>(
    pairs.flatMap(([home, away]) => [
      [home, away],
      [away, home],
    ]),
  );
  const swapped = Object.fromEntries(
    Object.entries(match).map(([key, value]) => [names.get(key) ?? key, value]),
  );
  return { ...match, ...swapped, margin: match.margin === null ? null : -match.margin };
}
