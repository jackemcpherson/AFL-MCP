/**
 * Golden-value test for the PAV formula (Plan 009).
 *
 * Seeds a deterministic 2-team, 2-match AFLW 2025 season, runs the SQL
 * PAV pipeline, and asserts every PAV component for every player against
 * an independent TypeScript reference implementation of the same formula.
 * Frozen literal snapshot values catch future simultaneous drift in both
 * implementations.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { normaliseTeam } from "../../src/lib/normalise";
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

// ─── Fixture types ─────────────────────────────────────────────────────────────

/** Per-player per-match stats used both for DB seeding and the reference impl. */
interface FixtureStat {
  playerId: string;
  team: string;
  matchId: string;
  goals: number;
  behinds: number;
  marks: number;
  tackles: number;
  hitouts: number;
  goalAssists: number;
  inside50s: number;
  marksInside50: number;
  freesFor: number;
  freesAgainst: number;
  rebound50s: number;
  onePercenters: number;
  /** Maps to `totalClearances` in PlayerStats and `clearances` in DB. */
  clearances: number;
  timeOnGroundPercentage: number;
  disposals: number;
}

/** Match metadata used for both DB seeding and the reference impl. */
interface FixtureMatch {
  matchId: string;
  homeTeam: string;
  awayTeam: string;
  homeGoals: number;
  homeBehinds: number;
  homePoints: number;
  awayGoals: number;
  awayBehinds: number;
  awayPoints: number;
  margin: number;
}

// ─── Reference-implementation internal types ───────────────────────────────────

interface TeamSeasonAgg {
  pts_for: number;
  pts_against: number;
  i50_for: number;
  i50_against: number;
}

interface TeamRatings {
  off_rating: number;
  mid_rating: number;
  def_rating: number | null;
}

interface TeamPavPool {
  team_off_pavs: number;
  team_mid_pavs: number;
  team_def_pavs: number | null;
}

interface PlayerSeasonScore {
  team: string;
  off_score: number;
  def_score: number;
  mid_score: number;
}

interface TeamScoreTotals {
  off: number;
  def: number;
  mid: number;
}

/** PAV row as returned by the SQL query. */
interface SqlPavRow {
  player_id: number;
  team_id: number;
  off_pav: number;
  mid_pav: number;
  def_pav: number;
  total_pav: number;
}

/** PAV row as computed by the reference implementation. */
interface RefPavRow {
  playerId: string;
  team: string;
  off_pav: number;
  mid_pav: number;
  def_pav: number;
  total_pav: number;
}

/** Result of computeExpectedPav — player rows and team pool totals for sanity check. */
interface ExpectedPavResult {
  rows: RefPavRow[];
  teamOffPools: Map<string, number>;
  teamMidPools: Map<string, number>;
  teamDefPools: Map<string, number | null>;
}

// ─── Fixture constants ─────────────────────────────────────────────────────────

const HOME = "Adelaide"; // normalised form of "Adelaide Crows" via TEAM_NAME_MAP
const AWAY = "Brisbane Lions";
const M1 = "GOLDEN-M-1";
const M2 = "GOLDEN-M-2";
const YEAR = 2025;

/**
 * Two completed matches: M1 = Adelaide (home) vs Brisbane (away);
 * M2 = Brisbane (home) vs Adelaide (away).
 * Adelaide wins both, giving asymmetric team ratings.
 */
const FIXTURE_MATCHES: readonly FixtureMatch[] = [
  {
    matchId: M1,
    homeTeam: HOME,
    awayTeam: AWAY,
    homeGoals: 10,
    homeBehinds: 8,
    homePoints: 68,
    awayGoals: 8,
    awayBehinds: 6,
    awayPoints: 54,
    margin: 14,
  },
  {
    matchId: M2,
    homeTeam: AWAY,
    awayTeam: HOME,
    homeGoals: 9,
    homeBehinds: 7,
    homePoints: 61,
    awayGoals: 11,
    awayBehinds: 5,
    awayPoints: 71,
    margin: -10,
  },
];

/**
 * 16 stat records — 4 players × 2 teams × 2 matches.
 * Every player has timeOnGroundPercentage > 0 (phantom-filter safe).
 * Stats are deliberately varied across all PAV coefficients:
 * hitouts, rebounds, onePercenters, marksInside50, goalAssists,
 * freesFor/Against, clearances, tackles are all non-zero somewhere.
 */
const FIXTURE_STATS: readonly FixtureStat[] = [
  // ── Match 1, Adelaide (home) ──────────────────────────────────────────
  // P1: midfielder
  {
    playerId: "GOLDEN-P-1",
    team: HOME,
    matchId: M1,
    goals: 0,
    behinds: 1,
    marks: 6,
    tackles: 8,
    hitouts: 0,
    goalAssists: 2,
    inside50s: 6,
    marksInside50: 1,
    freesFor: 2,
    freesAgainst: 1,
    rebound50s: 1,
    onePercenters: 1,
    clearances: 8,
    timeOnGroundPercentage: 90,
    disposals: 25,
  },
  // P2: key forward
  {
    playerId: "GOLDEN-P-2",
    team: HOME,
    matchId: M1,
    goals: 3,
    behinds: 2,
    marks: 4,
    tackles: 2,
    hitouts: 0,
    goalAssists: 0,
    inside50s: 4,
    marksInside50: 2,
    freesFor: 1,
    freesAgainst: 0,
    rebound50s: 0,
    onePercenters: 0,
    clearances: 1,
    timeOnGroundPercentage: 85,
    disposals: 14,
  },
  // P3: defender
  {
    playerId: "GOLDEN-P-3",
    team: HOME,
    matchId: M1,
    goals: 0,
    behinds: 0,
    marks: 8,
    tackles: 3,
    hitouts: 0,
    goalAssists: 0,
    inside50s: 1,
    marksInside50: 0,
    freesFor: 1,
    freesAgainst: 1,
    rebound50s: 8,
    onePercenters: 6,
    clearances: 2,
    timeOnGroundPercentage: 92,
    disposals: 18,
  },
  // P4: ruckman (hitouts exercised)
  {
    playerId: "GOLDEN-P-4",
    team: HOME,
    matchId: M1,
    goals: 1,
    behinds: 0,
    marks: 3,
    tackles: 4,
    hitouts: 20,
    goalAssists: 0,
    inside50s: 3,
    marksInside50: 0,
    freesFor: 0,
    freesAgainst: 1,
    rebound50s: 2,
    onePercenters: 2,
    clearances: 4,
    timeOnGroundPercentage: 80,
    disposals: 12,
  },
  // ── Match 1, Brisbane (away) ──────────────────────────────────────────
  // P5: midfielder
  {
    playerId: "GOLDEN-P-5",
    team: AWAY,
    matchId: M1,
    goals: 0,
    behinds: 2,
    marks: 5,
    tackles: 6,
    hitouts: 0,
    goalAssists: 2,
    inside50s: 5,
    marksInside50: 1,
    freesFor: 1,
    freesAgainst: 2,
    rebound50s: 1,
    onePercenters: 1,
    clearances: 7,
    timeOnGroundPercentage: 89,
    disposals: 23,
  },
  // P6: key forward
  {
    playerId: "GOLDEN-P-6",
    team: AWAY,
    matchId: M1,
    goals: 4,
    behinds: 1,
    marks: 3,
    tackles: 1,
    hitouts: 0,
    goalAssists: 1,
    inside50s: 3,
    marksInside50: 2,
    freesFor: 0,
    freesAgainst: 1,
    rebound50s: 0,
    onePercenters: 0,
    clearances: 0,
    timeOnGroundPercentage: 82,
    disposals: 12,
  },
  // P7: defender
  {
    playerId: "GOLDEN-P-7",
    team: AWAY,
    matchId: M1,
    goals: 0,
    behinds: 0,
    marks: 7,
    tackles: 4,
    hitouts: 0,
    goalAssists: 0,
    inside50s: 2,
    marksInside50: 0,
    freesFor: 2,
    freesAgainst: 0,
    rebound50s: 9,
    onePercenters: 5,
    clearances: 3,
    timeOnGroundPercentage: 91,
    disposals: 17,
  },
  // P8: ruckman
  {
    playerId: "GOLDEN-P-8",
    team: AWAY,
    matchId: M1,
    goals: 0,
    behinds: 0,
    marks: 2,
    tackles: 2,
    hitouts: 18,
    goalAssists: 0,
    inside50s: 2,
    marksInside50: 0,
    freesFor: 1,
    freesAgainst: 1,
    rebound50s: 0,
    onePercenters: 2,
    clearances: 3,
    timeOnGroundPercentage: 77,
    disposals: 8,
  },
  // ── Match 2, Brisbane (home) ──────────────────────────────────────────
  // P5: midfielder
  {
    playerId: "GOLDEN-P-5",
    team: AWAY,
    matchId: M2,
    goals: 1,
    behinds: 1,
    marks: 4,
    tackles: 5,
    hitouts: 0,
    goalAssists: 1,
    inside50s: 4,
    marksInside50: 0,
    freesFor: 2,
    freesAgainst: 1,
    rebound50s: 2,
    onePercenters: 0,
    clearances: 5,
    timeOnGroundPercentage: 88,
    disposals: 20,
  },
  // P6: key forward
  {
    playerId: "GOLDEN-P-6",
    team: AWAY,
    matchId: M2,
    goals: 3,
    behinds: 2,
    marks: 4,
    tackles: 2,
    hitouts: 0,
    goalAssists: 0,
    inside50s: 4,
    marksInside50: 1,
    freesFor: 1,
    freesAgainst: 0,
    rebound50s: 0,
    onePercenters: 1,
    clearances: 1,
    timeOnGroundPercentage: 84,
    disposals: 14,
  },
  // P7: defender
  {
    playerId: "GOLDEN-P-7",
    team: AWAY,
    matchId: M2,
    goals: 0,
    behinds: 0,
    marks: 6,
    tackles: 3,
    hitouts: 0,
    goalAssists: 0,
    inside50s: 1,
    marksInside50: 0,
    freesFor: 1,
    freesAgainst: 1,
    rebound50s: 8,
    onePercenters: 4,
    clearances: 2,
    timeOnGroundPercentage: 90,
    disposals: 16,
  },
  // P8: ruckman
  {
    playerId: "GOLDEN-P-8",
    team: AWAY,
    matchId: M2,
    goals: 1,
    behinds: 0,
    marks: 3,
    tackles: 3,
    hitouts: 15,
    goalAssists: 1,
    inside50s: 3,
    marksInside50: 0,
    freesFor: 0,
    freesAgainst: 2,
    rebound50s: 1,
    onePercenters: 1,
    clearances: 4,
    timeOnGroundPercentage: 79,
    disposals: 10,
  },
  // ── Match 2, Adelaide (away) ──────────────────────────────────────────
  // P1: midfielder
  {
    playerId: "GOLDEN-P-1",
    team: HOME,
    matchId: M2,
    goals: 1,
    behinds: 0,
    marks: 5,
    tackles: 7,
    hitouts: 0,
    goalAssists: 1,
    inside50s: 5,
    marksInside50: 0,
    freesFor: 1,
    freesAgainst: 2,
    rebound50s: 2,
    onePercenters: 0,
    clearances: 6,
    timeOnGroundPercentage: 88,
    disposals: 22,
  },
  // P2: key forward
  {
    playerId: "GOLDEN-P-2",
    team: HOME,
    matchId: M2,
    goals: 4,
    behinds: 1,
    marks: 5,
    tackles: 1,
    hitouts: 0,
    goalAssists: 1,
    inside50s: 5,
    marksInside50: 3,
    freesFor: 2,
    freesAgainst: 1,
    rebound50s: 0,
    onePercenters: 1,
    clearances: 0,
    timeOnGroundPercentage: 87,
    disposals: 16,
  },
  // P3: defender
  {
    playerId: "GOLDEN-P-3",
    team: HOME,
    matchId: M2,
    goals: 0,
    behinds: 1,
    marks: 7,
    tackles: 4,
    hitouts: 0,
    goalAssists: 0,
    inside50s: 2,
    marksInside50: 0,
    freesFor: 0,
    freesAgainst: 2,
    rebound50s: 7,
    onePercenters: 5,
    clearances: 1,
    timeOnGroundPercentage: 91,
    disposals: 17,
  },
  // P4: ruckman
  {
    playerId: "GOLDEN-P-4",
    team: HOME,
    matchId: M2,
    goals: 0,
    behinds: 1,
    marks: 2,
    tackles: 3,
    hitouts: 18,
    goalAssists: 1,
    inside50s: 2,
    marksInside50: 1,
    freesFor: 1,
    freesAgainst: 0,
    rebound50s: 1,
    onePercenters: 3,
    clearances: 3,
    timeOnGroundPercentage: 78,
    disposals: 10,
  },
];

// ─── Reference implementation ──────────────────────────────────────────────────

/** Round a number to 2 decimal places, matching SQL ROUND(x, 2). */
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/**
 * Independent TypeScript reference implementation of the HPN PAV formula.
 * Follows the same steps as PAV_SELECT_SQL in src/sync/pav.ts, derived
 * independently from the formula description rather than translated line-by-line.
 *
 * @param matches - Completed matches in the fixture season.
 * @param stats - Per-player per-match stats; all must pass the phantom filter.
 * @returns Player PAV rows and team pool totals for sanity checks.
 */
function computeExpectedPav(
  matches: readonly FixtureMatch[],
  stats: readonly FixtureStat[],
): ExpectedPavResult {
  // Step 1: Team inside-50s per match (key: `${matchId}|${team}`)
  const teamMatchI50 = new Map<string, number>();
  for (const s of stats) {
    const key = `${s.matchId}|${s.team}`;
    teamMatchI50.set(key, (teamMatchI50.get(key) ?? 0) + s.inside50s);
  }

  // Step 2: Team season aggregates
  const teamSeason = new Map<string, TeamSeasonAgg>();
  for (const m of matches) {
    const homeI50 = teamMatchI50.get(`${m.matchId}|${m.homeTeam}`) ?? 0;
    const awayI50 = teamMatchI50.get(`${m.matchId}|${m.awayTeam}`) ?? 0;

    if (!teamSeason.has(m.homeTeam)) {
      teamSeason.set(m.homeTeam, { pts_for: 0, pts_against: 0, i50_for: 0, i50_against: 0 });
    }
    if (!teamSeason.has(m.awayTeam)) {
      teamSeason.set(m.awayTeam, { pts_for: 0, pts_against: 0, i50_for: 0, i50_against: 0 });
    }

    const home = teamSeason.get(m.homeTeam)!;
    home.pts_for += m.homePoints;
    home.pts_against += m.awayPoints;
    home.i50_for += homeI50;
    home.i50_against += awayI50;

    const away = teamSeason.get(m.awayTeam)!;
    away.pts_for += m.awayPoints;
    away.pts_against += m.homePoints;
    away.i50_for += awayI50;
    away.i50_against += homeI50;
  }

  // Step 3: League average pts per inside-50, team count
  let totalPtsFor = 0;
  let totalI50For = 0;
  for (const ts of teamSeason.values()) {
    totalPtsFor += ts.pts_for;
    totalI50For += ts.i50_for;
  }
  const leagueAvg = totalPtsFor / totalI50For;
  const numTeams = teamSeason.size;

  // Step 4: Team ratings (off / mid / defence transform)
  const teamRatings = new Map<string, TeamRatings>();
  for (const [team, ts] of teamSeason) {
    const off_rating = ts.i50_for === 0 ? 0 : ts.pts_for / ts.i50_for / leagueAvg;
    const mid_rating = ts.i50_against === 0 ? 0 : ts.i50_for / ts.i50_against;
    const dn = ts.i50_against === 0 ? 0 : ts.pts_against / ts.i50_against / leagueAvg;
    // Defence transform: 100 × (2 − dn); NULL when dn = 0
    const def_rating: number | null = dn === 0 ? null : 100 * (2 - dn);
    teamRatings.set(team, { off_rating, mid_rating, def_rating });
  }

  // Step 5: League totals → proportional team PAV pools
  let tot_off = 0;
  let tot_mid = 0;
  let tot_def = 0;
  for (const tr of teamRatings.values()) {
    tot_off += tr.off_rating;
    tot_mid += tr.mid_rating;
    if (tr.def_rating !== null) tot_def += tr.def_rating;
  }

  const pool = numTeams * 100;
  const teamPavPools = new Map<string, TeamPavPool>();
  for (const [team, tr] of teamRatings) {
    teamPavPools.set(team, {
      team_off_pavs: tot_off === 0 ? 0 : (tr.off_rating / tot_off) * pool,
      team_mid_pavs: tot_mid === 0 ? 0 : (tr.mid_rating / tot_mid) * pool,
      team_def_pavs:
        tr.def_rating !== null && tot_def > 0 ? (tr.def_rating / tot_def) * pool : null,
    });
  }

  // Steps 6-7: Player raw season scores
  // Phantom filter: time_on_ground_pct > 0 OR disposals > 0
  const playerScores = new Map<string, PlayerSeasonScore>();
  for (const s of stats) {
    if (s.timeOnGroundPercentage <= 0 && s.disposals <= 0) continue;

    if (!playerScores.has(s.playerId)) {
      playerScores.set(s.playerId, { team: s.team, off_score: 0, def_score: 0, mid_score: 0 });
    }

    const ps = playerScores.get(s.playerId)!;
    const player_points = 6 * s.goals + s.behinds;
    const fkDiff = s.freesFor - s.freesAgainst;

    ps.off_score +=
      player_points + 0.25 * s.hitouts + 3 * s.goalAssists + s.inside50s + s.marksInside50 + fkDiff;

    ps.def_score +=
      20 * s.rebound50s +
      12 * s.onePercenters +
      (s.marks - 4 * s.marksInside50 + 2 * fkDiff) -
      (2 / 3) * s.hitouts;

    ps.mid_score += 15 * s.inside50s + 20 * s.clearances + 3 * s.tackles + 1.5 * s.hitouts + fkDiff;
  }

  // Step 8: Team total raw scores
  const teamScores = new Map<string, TeamScoreTotals>();
  for (const ps of playerScores.values()) {
    if (!teamScores.has(ps.team)) {
      teamScores.set(ps.team, { off: 0, def: 0, mid: 0 });
    }
    const ts = teamScores.get(ps.team)!;
    ts.off += ps.off_score;
    ts.def += ps.def_score;
    ts.mid += ps.mid_score;
  }

  // Step 9: Player PAV — proportional share of each team's pool
  // Round components to 2dp; total_pav = ROUND(unrounded_sum, 2)
  const rows: RefPavRow[] = [];
  for (const [playerId, ps] of playerScores) {
    const ts = teamScores.get(ps.team)!;
    const tp = teamPavPools.get(ps.team)!;

    const off_pav_raw = ts.off === 0 ? 0 : (ps.off_score / ts.off) * tp.team_off_pavs;
    const mid_pav_raw = ts.mid === 0 ? 0 : (ps.mid_score / ts.mid) * tp.team_mid_pavs;
    const def_pav_raw =
      ts.def !== 0 && tp.team_def_pavs !== null ? (ps.def_score / ts.def) * tp.team_def_pavs : 0;

    rows.push({
      playerId,
      team: ps.team,
      off_pav: round2(off_pav_raw),
      mid_pav: round2(mid_pav_raw),
      def_pav: round2(def_pav_raw),
      total_pav: round2(off_pav_raw + mid_pav_raw + def_pav_raw),
    });
  }

  // Build pool maps for the pool-sum sanity test
  const teamOffPools = new Map<string, number>();
  const teamMidPools = new Map<string, number>();
  const teamDefPools = new Map<string, number | null>();
  for (const [team, tp] of teamPavPools) {
    teamOffPools.set(team, tp.team_off_pavs);
    teamMidPools.set(team, tp.team_mid_pavs);
    teamDefPools.set(team, tp.team_def_pavs);
  }

  return { rows, teamOffPools, teamMidPools, teamDefPools };
}

// ─── DB seeding ────────────────────────────────────────────────────────────────

/**
 * Seeds the deterministic golden fixture into the test DB and returns maps
 * needed to correlate SQL rows (integer IDs) with fixture player IDs.
 *
 * @returns playerMap (aflId → DB id) and teamMap (name → DB id).
 */
async function seedGoldenFixture(): Promise<{
  playerMap: Map<string, number>;
  teamMap: Map<string, number>;
}> {
  const competitionId = await ensureCompetition(env, "AFLW");
  const seasonId = await ensureSeason(env, competitionId, YEAR);

  const matchObjects = FIXTURE_MATCHES.map((fm) =>
    makeMatch({
      matchId: fm.matchId,
      competition: "AFLW",
      season: YEAR,
      roundCode: fm.matchId === M1 ? "R1" : "R2",
      roundNumber: fm.matchId === M1 ? 1 : 2,
      roundType: "HomeAndAway",
      homeTeam: fm.homeTeam,
      awayTeam: fm.awayTeam,
      homeGoals: fm.homeGoals,
      homeBehinds: fm.homeBehinds,
      homePoints: fm.homePoints,
      awayGoals: fm.awayGoals,
      awayBehinds: fm.awayBehinds,
      awayPoints: fm.awayPoints,
      margin: fm.margin,
    }),
  );

  const teamMap = await ensureTeams(env, competitionId, "AFLW", matchObjects);
  const venueMap = await ensureVenues(env, matchObjects);
  await upsertMatches(env, matchObjects, { seasonId, teamMap, venueMap });
  const matchMap = await buildMatchAflIdMap(env, seasonId);

  // 8 unique players
  const playerDefs = Array.from({ length: 8 }, (_, i) => ({
    playerId: `GOLDEN-P-${i + 1}`,
    givenName: "Golden",
    surname: `Player${i + 1}`,
  }));
  const playerMap = await upsertPlayers(env, playerDefs);

  // Build match lookup by matchId for seeding stats
  const matchByMatchId = new Map<string, FixtureMatch>(
    FIXTURE_MATCHES.map((fm) => [fm.matchId, fm]),
  );

  const allStats = FIXTURE_STATS.map((s) => {
    const fm = matchByMatchId.get(s.matchId)!;
    return makePlayerStats({
      matchId: s.matchId,
      season: YEAR,
      playerId: s.playerId,
      givenName: "Golden",
      surname: s.playerId.replace("GOLDEN-", ""),
      displayName: s.playerId,
      team: s.team,
      homeTeam: fm.homeTeam,
      awayTeam: fm.awayTeam,
      competition: "AFLW",
      goals: s.goals,
      behinds: s.behinds,
      marks: s.marks,
      tackles: s.tackles,
      hitouts: s.hitouts,
      goalAssists: s.goalAssists,
      inside50s: s.inside50s,
      marksInside50: s.marksInside50,
      freesFor: s.freesFor,
      freesAgainst: s.freesAgainst,
      rebound50s: s.rebound50s,
      onePercenters: s.onePercenters,
      totalClearances: s.clearances,
      timeOnGroundPercentage: s.timeOnGroundPercentage,
      disposals: s.disposals,
    });
  });

  await upsertStats(env, allStats, matchMap, playerMap, teamMap);

  return { playerMap, teamMap };
}

// ─── Tests ─────────────────────────────────────────────────────────────────────

describe("PAV golden values", () => {
  it("calculatePav returns exactly 8 rows for the seeded fixture", async () => {
    await seedGoldenFixture();
    const upserts = await calculatePav(env, YEAR, "AFLW");
    expect(upserts).toBe(8);
  });

  it("SQL output matches the independent reference implementation for all 8 players", async () => {
    const { playerMap, teamMap } = await seedGoldenFixture();
    await calculatePav(env, YEAR, "AFLW");

    const { results: sqlRows } = await env.DB.prepare(
      `SELECT psp.player_id, psp.team_id,
              psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav
         FROM player_season_pav psp
         JOIN seasons s ON psp.season_id = s.id
         JOIN competitions c ON s.competition_id = c.id
         WHERE c.code = 'AFLW' AND s.year = ${YEAR}`,
    ).all<SqlPavRow>();

    expect(sqlRows).toHaveLength(8);

    const { rows: refRows } = computeExpectedPav(FIXTURE_MATCHES, FIXTURE_STATS);
    expect(refRows).toHaveLength(8);

    for (const ref of refRows) {
      const dbPlayerId = playerMap.get(ref.playerId);
      const dbTeamId = teamMap.get(normaliseTeam(ref.team));
      expect(dbPlayerId).toBeDefined();
      expect(dbTeamId).toBeDefined();

      const sql = sqlRows.find((r) => r.player_id === dbPlayerId && r.team_id === dbTeamId);
      expect(sql).toBeDefined();
      if (!sql) continue; // narrowing — expect above already fails

      expect(sql.off_pav).toBeCloseTo(ref.off_pav, 2);
      expect(sql.mid_pav).toBeCloseTo(ref.mid_pav, 2);
      expect(sql.def_pav).toBeCloseTo(ref.def_pav, 2);
      expect(sql.total_pav).toBeCloseTo(ref.total_pav, 2);
    }
  });

  it("SQL total_pav values match frozen golden literals", async () => {
    const { playerMap } = await seedGoldenFixture();
    await calculatePav(env, YEAR, "AFLW");

    const { results: sqlRows } = await env.DB.prepare(
      `SELECT psp.player_id, psp.total_pav
         FROM player_season_pav psp
         JOIN seasons s ON psp.season_id = s.id
         JOIN competitions c ON s.competition_id = c.id
         WHERE c.code = 'AFLW' AND s.year = ${YEAR}
         ORDER BY psp.player_id`,
    ).all<{ player_id: number; total_pav: number }>();

    expect(sqlRows).toHaveLength(8);

    /*
     * GOLDEN VALUES — frozen 2026-07-03 from fixture commit e6b5e77.
     * If PAV_SELECT_SQL or FIXTURE_STATS change, these literals MUST be
     * updated in the same PR so any silent double-drift is caught.
     * Values were captured from a first-pass test run and verified against
     * the reference implementation above.
     *
     * Player order (sorted by DB player_id, which follows insertion order):
     *   GOLDEN-P-1 (Adelaide [normalised], mid)
     *   GOLDEN-P-2 (Adelaide [normalised], forward)
     *   GOLDEN-P-3 (Adelaide [normalised], defender)
     *   GOLDEN-P-4 (Adelaide [normalised], ruck)
     *   GOLDEN-P-5 (Brisbane Lions, mid)
     *   GOLDEN-P-6 (Brisbane Lions, forward)
     *   GOLDEN-P-7 (Brisbane Lions, defender)
     *   GOLDEN-P-8 (Brisbane Lions, ruck)
     */
    // Frozen 2026-07-03 against commit e6b5e77. If PAV_SELECT_SQL or
    // FIXTURE_STATS change, update these literals in the same PR.
    const GOLDEN_TOTAL_PAV: Record<string, number> = {
      "GOLDEN-P-1": 89.41, // Adelaide [normalised], mid
      "GOLDEN-P-2": 73.16, // Adelaide [normalised], forward
      "GOLDEN-P-3": 87.43, // Adelaide [normalised], defender
      "GOLDEN-P-4": 68.83, // Adelaide [normalised], ruck
      "GOLDEN-P-5": 72.67, // Brisbane Lions, mid
      "GOLDEN-P-6": 63.88, // Brisbane Lions, forward
      "GOLDEN-P-7": 97.04, // Brisbane Lions, defender
      "GOLDEN-P-8": 47.57, // Brisbane Lions, ruck
    };

    // Reverse-map DB player_id → fixture playerId
    const dbIdToFixtureId = new Map<number, string>();
    for (const [fixtureId, dbId] of playerMap) {
      dbIdToFixtureId.set(dbId, fixtureId);
    }

    for (const row of sqlRows) {
      const fixtureId = dbIdToFixtureId.get(row.player_id);
      expect(fixtureId).toBeDefined();
      if (!fixtureId) continue;
      const golden = GOLDEN_TOTAL_PAV[fixtureId];
      expect(golden).toBeDefined();
      if (golden === undefined) continue;
      expect(row.total_pav).toBeCloseTo(golden, 2);
    }
  });

  it("empty AFLW season produces zero upserts and no PAV rows", async () => {
    // Seed competition + season but no matches/stats
    const competitionId = await ensureCompetition(env, "AFLW");
    await ensureSeason(env, competitionId, YEAR);

    const upserts = await calculatePav(env, YEAR, "AFLW");
    expect(upserts).toBe(0);

    const { results } = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM player_season_pav psp
         JOIN seasons s ON psp.season_id = s.id
         JOIN competitions c ON s.competition_id = c.id
         WHERE c.code = 'AFLW' AND s.year = ${YEAR}`,
    ).all<{ n: number }>();
    const row = results[0];
    expect(row?.n).toBe(0);
  });

  it("pool-sum sanity: each team's off_pav rows sum to the team off pool (±0.05)", async () => {
    const { teamMap } = await seedGoldenFixture();
    await calculatePav(env, YEAR, "AFLW");

    const { results: sqlRows } = await env.DB.prepare(
      `SELECT psp.team_id, psp.off_pav, psp.mid_pav
         FROM player_season_pav psp
         JOIN seasons s ON psp.season_id = s.id
         JOIN competitions c ON s.competition_id = c.id
         WHERE c.code = 'AFLW' AND s.year = ${YEAR}`,
    ).all<{ team_id: number; off_pav: number; mid_pav: number }>();

    const { teamOffPools, teamMidPools } = computeExpectedPav(FIXTURE_MATCHES, FIXTURE_STATS);

    for (const [teamName, teamDbId] of teamMap) {
      const teamRows = sqlRows.filter((r) => r.team_id === teamDbId);
      expect(teamRows.length).toBeGreaterThan(0);

      const sqlOffSum = teamRows.reduce((acc, r) => acc + r.off_pav, 0);
      const sqlMidSum = teamRows.reduce((acc, r) => acc + r.mid_pav, 0);

      // teamName is normalised (from teamMap keys); pools are keyed by fixture team names
      // which are already normalised (HOME = "Adelaide", AWAY = "Brisbane Lions").
      const refOffPool = teamOffPools.get(teamName) ?? 0;
      const refMidPool = teamMidPools.get(teamName) ?? 0;

      expect(Math.abs(sqlOffSum - refOffPool)).toBeLessThan(0.05);
      expect(Math.abs(sqlMidSum - refMidPool)).toBeLessThan(0.05);
    }
  });
});
