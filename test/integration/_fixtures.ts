import type { Lineup, LineupPlayer, Match, PlayerStats } from "fitzroy";

/**
 * Build a Match with sensible defaults; pass overrides to vary fields under
 * test. Defaults to a completed match (homePoints/awayPoints set) so tests
 * that don't care about completion status get realistic data; pass
 * `homePoints: null` etc. to simulate an upcoming fixture.
 */
export function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    matchId: "M-1",
    season: 2026,
    roundNumber: 1,
    roundType: "HomeAndAway",
    roundName: "Round 1",
    roundCode: "R1",
    date: new Date("2026-03-19T08:30:00Z"),
    venue: "MCG",
    homeTeam: "Carlton",
    awayTeam: "Richmond",
    homeGoals: 12,
    homeBehinds: 8,
    homePoints: 80,
    awayGoals: 10,
    awayBehinds: 9,
    awayPoints: 69,
    margin: 11,
    q1Home: null,
    q2Home: null,
    q3Home: null,
    q4Home: null,
    q1Away: null,
    q2Away: null,
    q3Away: null,
    q4Away: null,
    status: "Complete",
    livePeriodStatus: null,
    attendance: 60000,
    weatherTempCelsius: 18,
    weatherType: "Clear",
    venueState: "VIC",
    venueTimezone: "Australia/Melbourne",
    homeRushedBehinds: null,
    awayRushedBehinds: null,
    homeMinutesInFront: null,
    awayMinutesInFront: null,
    source: "afl-api",
    competition: "AFLM",
    ...overrides,
  };
}

/** Build a PlayerStats fixture with all numeric fields zeroed by default. */
export function makePlayerStats(overrides: Partial<PlayerStats> = {}): PlayerStats {
  const numericNulls = [
    "kicks",
    "handballs",
    "disposals",
    "marks",
    "goals",
    "behinds",
    "tackles",
    "hitouts",
    "freesFor",
    "freesAgainst",
    "contestedPossessions",
    "uncontestedPossessions",
    "contestedMarks",
    "intercepts",
    "centreClearances",
    "stoppageClearances",
    "totalClearances",
    "inside50s",
    "rebound50s",
    "clangers",
    "turnovers",
    "onePercenters",
    "bounces",
    "goalAssists",
    "disposalEfficiency",
    "metresGained",
    "goalAccuracy",
    "marksInside50",
    "tacklesInside50",
    "shotsAtGoal",
    "scoreInvolvements",
    "totalPossessions",
    "timeOnGroundPercentage",
    "ratingPoints",
    "goalEfficiency",
    "shotEfficiency",
    "interchangeCounts",
    "brownlowVotes",
    "supercoachScore",
    "dreamTeamPoints",
    "effectiveDisposals",
    "effectiveKicks",
    "kickEfficiency",
    "kickToHandballRatio",
    "pressureActs",
    "defHalfPressureActs",
    "spoils",
    "hitoutsToAdvantage",
    "hitoutWinPercentage",
    "hitoutToAdvantageRate",
    "groundBallGets",
    "f50GroundBallGets",
    "interceptMarks",
    "marksOnLead",
    "contestedPossessionRate",
    "contestOffOneOnOnes",
    "contestOffWins",
    "contestOffWinsPercentage",
    "contestDefOneOnOnes",
    "contestDefLosses",
    "contestDefLossPercentage",
    "centreBounceAttendances",
    "kickins",
    "kickinsPlayon",
    "ruckContests",
    "scoreLaunches",
  ] as const;

  const stats = {
    matchId: "M-1",
    season: 2026,
    roundNumber: 1,
    team: "Carlton",
    competition: "AFLM" as const,
    date: new Date("2026-03-19T08:30:00Z"),
    homeTeam: "Carlton",
    awayTeam: "Richmond",
    playerId: "P-1",
    givenName: "Patrick",
    surname: "Cripps",
    displayName: "P. Cripps",
    jumperNumber: 9,
    position: "MID",
    source: "afl-api" as const,
  } as Partial<PlayerStats>;

  for (const field of numericNulls) {
    (stats as Record<string, number | null>)[field] = 0;
  }

  return { ...(stats as PlayerStats), ...overrides };
}

/** Build a LineupPlayer with defaults. */
export function makeLineupPlayer(overrides: Partial<LineupPlayer> = {}): LineupPlayer {
  return {
    playerId: "P-1",
    givenName: "Patrick",
    surname: "Cripps",
    displayName: "P. Cripps",
    jumperNumber: 9,
    matchPosition: "MID",
    isEmergency: false,
    isSubstitute: false,
    ...overrides,
  };
}

/** Build a Lineup with defaults; supply player arrays via overrides. */
export function makeLineup(overrides: Partial<Lineup> = {}): Lineup {
  return {
    matchId: "M-1",
    season: 2026,
    roundNumber: 1,
    homeTeam: "Carlton",
    awayTeam: "Richmond",
    homePlayers: [],
    awayPlayers: [],
    competition: "AFLM",
    ...overrides,
  };
}

/** Wrap a value in fitzroy's success Result. */
export function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/** Wrap an error string in fitzroy's failure Result. */
export function err(message: string): { success: false; error: Error } {
  return { success: false, error: new Error(message) };
}
