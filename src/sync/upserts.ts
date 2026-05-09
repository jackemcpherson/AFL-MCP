import type { CompetitionCode, Lineup, LineupPlayer, Match, PlayerStats } from "fitzroy";
import { normaliseTeam, normaliseVenue } from "../lib/normalise";
import { toIsoDate, toMelbourneTime } from "../lib/time";
import type { Env } from "../types";

const COMPETITION_NAME: Record<CompetitionCode, string> = {
  AFLM: "AFL Men's",
  AFLW: "AFL Women's",
  VFL: "Victorian Football League",
  VFLW: "VFL Women's",
};

const BATCH_SIZE = 500;

/** Minimal shape needed to upsert a player record. */
export interface PlayerInput {
  readonly playerId: string;
  readonly givenName: string;
  readonly surname: string;
}

/** Context for `upsertMatches`: the season/competition each match belongs to. */
export interface MatchUpsertContext {
  readonly seasonId: number;
  readonly teamMap: Map<string, number>;
  readonly venueMap: Map<string, number>;
}

function deriveRound(m: Match): string {
  if (m.roundCode) return m.roundCode;
  if (m.roundNumber === 0) return "Opening Round";
  if (m.roundType === "Finals") return `F${m.roundNumber}`;
  return `R${m.roundNumber}`;
}

function deriveRoundType(roundType: string): string {
  if (roundType === "HomeAndAway") return "Regular";
  return roundType;
}

/** Union players from stats + lineups, deduped by `playerId`. */
export function unionPlayers(
  stats: readonly PlayerStats[],
  lineups: readonly Lineup[],
): PlayerInput[] {
  const seen = new Map<string, PlayerInput>();
  for (const s of stats) {
    if (!seen.has(s.playerId)) {
      seen.set(s.playerId, {
        playerId: s.playerId,
        givenName: s.givenName,
        surname: s.surname,
      });
    }
  }
  for (const lineup of lineups) {
    for (const p of [...lineup.homePlayers, ...lineup.awayPlayers]) {
      if (!seen.has(p.playerId)) {
        seen.set(p.playerId, {
          playerId: p.playerId,
          givenName: p.givenName,
          surname: p.surname,
        });
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Ensure a competition row exists for the given code and return its id.
 * @throws if the row cannot be located after the insert (database error).
 */
export async function ensureCompetition(env: Env, code: CompetitionCode): Promise<number> {
  await env.DB.prepare("INSERT OR IGNORE INTO competitions (code, name) VALUES (?, ?)")
    .bind(code, COMPETITION_NAME[code])
    .run();
  const row = await env.DB.prepare("SELECT id FROM competitions WHERE code = ?")
    .bind(code)
    .first<{ id: number }>();
  if (!row) throw new Error(`Failed to ensure competition ${code}`);
  return row.id;
}

/**
 * Ensure a season row exists for the given (competition, year) pair and return its id.
 * @throws if the row cannot be located after the insert (database error).
 */
export async function ensureSeason(env: Env, competitionId: number, year: number): Promise<number> {
  await env.DB.prepare("INSERT OR IGNORE INTO seasons (competition_id, year) VALUES (?, ?)")
    .bind(competitionId, year)
    .run();
  const row = await env.DB.prepare("SELECT id FROM seasons WHERE competition_id = ? AND year = ?")
    .bind(competitionId, year)
    .first<{ id: number }>();
  if (!row) throw new Error(`Failed to ensure season ${year}`);
  return row.id;
}

/** Ensure rows exist for every team referenced by `matches`, and return a name → id map. */
export async function ensureTeams(
  env: Env,
  competitionId: number,
  matches: readonly Match[],
): Promise<Map<string, number>> {
  const names = new Set<string>();
  for (const m of matches) {
    names.add(normaliseTeam(m.homeTeam));
    names.add(normaliseTeam(m.awayTeam));
  }
  if (names.size > 0) {
    const stmts = Array.from(names).map((name) =>
      env.DB.prepare("INSERT OR IGNORE INTO teams (name, competition_id) VALUES (?, ?)").bind(
        name,
        competitionId,
      ),
    );
    await env.DB.batch(stmts);
  }
  const { results } = await env.DB.prepare("SELECT id, name FROM teams WHERE competition_id = ?")
    .bind(competitionId)
    .all<{ id: number; name: string }>();
  return new Map(results.map((r) => [r.name, r.id]));
}

/** Ensure rows exist for every venue referenced by `matches`, and return a name → id map. */
export async function ensureVenues(
  env: Env,
  matches: readonly Match[],
): Promise<Map<string, number>> {
  const names = new Set<string>();
  for (const m of matches) names.add(normaliseVenue(m.venue));
  if (names.size > 0) {
    const stmts = Array.from(names).map((name) =>
      env.DB.prepare("INSERT OR IGNORE INTO venues (name) VALUES (?)").bind(name),
    );
    await env.DB.batch(stmts);
  }
  const { results } = await env.DB.prepare("SELECT id, name FROM venues").all<{
    id: number;
    name: string;
  }>();
  return new Map(results.map((r) => [r.name, r.id]));
}

/** Latest "YYYY-MM-DD" of a completed match in the season, or null if none have completed. */
export async function selectMaxCompletedDate(env: Env, seasonId: number): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT MAX(date) as latest FROM matches WHERE season_id = ? AND home_points IS NOT NULL",
  )
    .bind(seasonId)
    .first<{ latest: string | null }>();
  return row?.latest ?? null;
}

/**
 * Smallest `round_number` with at least one not-yet-played match. Opening Round
 * is `round_number = 0` and is correctly returned ahead of R1 when unfinished.
 * Returns null when every match in the season is completed.
 */
export async function selectNextRound(env: Env, seasonId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MIN(round_number) as next FROM matches WHERE season_id = ? AND home_points IS NULL AND round_number IS NOT NULL",
  )
    .bind(seasonId)
    .first<{ next: number | null }>();
  return row?.next ?? null;
}

/** Map fitzroy `external_afl_id` → internal `matches.id` for the given season. */
export async function buildMatchAflIdMap(env: Env, seasonId: number): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT id, external_afl_id FROM matches WHERE season_id = ? AND external_afl_id IS NOT NULL",
  )
    .bind(seasonId)
    .all<{ id: number; external_afl_id: string }>();
  return new Map(results.map((r) => [r.external_afl_id, r.id]));
}

/**
 * Upsert players keyed by `external_afl_player_id`. First tries to adopt an
 * existing fryzigg-only row by name match (so legacy data carries forward
 * without duplication); then inserts/updates by AFL id.
 */
export async function upsertPlayers(
  env: Env,
  players: readonly PlayerInput[],
): Promise<Map<string, number>> {
  for (let i = 0; i < players.length; i += BATCH_SIZE) {
    const chunk = players.slice(i, i + BATCH_SIZE);
    const stmts: D1PreparedStatement[] = [];
    for (const p of chunk) {
      stmts.push(
        env.DB.prepare(
          `UPDATE players SET external_afl_player_id = ?
           WHERE first_name = ? AND surname = ?
             AND external_afl_player_id IS NULL
             AND external_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM players WHERE external_afl_player_id = ?)`,
        ).bind(p.playerId, p.givenName, p.surname, p.playerId),
      );
      stmts.push(
        env.DB.prepare(
          `INSERT INTO players (first_name, surname, external_afl_player_id)
           VALUES (?, ?, ?)
           ON CONFLICT (external_afl_player_id) WHERE external_afl_player_id IS NOT NULL
           DO UPDATE SET first_name = excluded.first_name, surname = excluded.surname`,
        ).bind(p.givenName, p.surname, p.playerId),
      );
    }
    await env.DB.batch(stmts);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL",
  ).all<{ id: number; external_afl_player_id: string }>();
  return new Map(results.map((r) => [r.external_afl_player_id, r.id]));
}

/**
 * Upsert matches (completed + upcoming). Score/quarter/weather/attendance use
 * COALESCE so an upcoming-status re-fetch never clobbers a completed match's
 * data with NULLs.
 */
export async function upsertMatches(
  env: Env,
  matches: readonly Match[],
  ctx: MatchUpsertContext,
): Promise<number> {
  let affected = 0;
  for (let i = 0; i < matches.length; i += BATCH_SIZE) {
    const chunk = matches.slice(i, i + BATCH_SIZE);
    const stmts = chunk.map((m) => buildMatchUpsert(env, m, ctx));
    const results = await env.DB.batch(stmts);
    affected += results.filter((r) => r.success).length;
  }
  return affected;
}

function buildMatchUpsert(env: Env, m: Match, ctx: MatchUpsertContext): D1PreparedStatement {
  const homeTeam = normaliseTeam(m.homeTeam);
  const awayTeam = normaliseTeam(m.awayTeam);
  const venue = normaliseVenue(m.venue);
  const homeTeamId = ctx.teamMap.get(homeTeam) ?? null;
  const awayTeamId = ctx.teamMap.get(awayTeam) ?? null;
  const venueId = ctx.venueMap.get(venue) ?? null;
  const dateStr = toIsoDate(m.date);
  const localTime = toMelbourneTime(m.date);

  return env.DB.prepare(
    `INSERT INTO matches (
      external_afl_id, season_id, round_number, round_type, round,
      date, local_time, venue_id, home_team_id, away_team_id,
      home_goals, home_behinds, home_points,
      away_goals, away_behinds, away_points,
      margin, attendance,
      home_rushed_behinds, away_rushed_behinds,
      home_minutes_in_front, away_minutes_in_front,
      home_q1_goals, home_q1_behinds,
      home_q2_goals, home_q2_behinds,
      home_q3_goals, home_q3_behinds,
      home_q4_goals, home_q4_behinds,
      away_q1_goals, away_q1_behinds,
      away_q2_goals, away_q2_behinds,
      away_q3_goals, away_q3_behinds,
      away_q4_goals, away_q4_behinds,
      weather_temp_c, weather_type
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?,
      ?, ?
    )
    ON CONFLICT (date, home_team_id, away_team_id) DO UPDATE SET
      external_afl_id = COALESCE(excluded.external_afl_id, matches.external_afl_id),
      round_number = excluded.round_number,
      round_type = excluded.round_type,
      round = excluded.round,
      local_time = excluded.local_time,
      venue_id = COALESCE(excluded.venue_id, matches.venue_id),
      home_goals = COALESCE(excluded.home_goals, matches.home_goals),
      home_behinds = COALESCE(excluded.home_behinds, matches.home_behinds),
      home_points = COALESCE(excluded.home_points, matches.home_points),
      away_goals = COALESCE(excluded.away_goals, matches.away_goals),
      away_behinds = COALESCE(excluded.away_behinds, matches.away_behinds),
      away_points = COALESCE(excluded.away_points, matches.away_points),
      margin = COALESCE(excluded.margin, matches.margin),
      attendance = COALESCE(excluded.attendance, matches.attendance),
      home_rushed_behinds = COALESCE(excluded.home_rushed_behinds, matches.home_rushed_behinds),
      away_rushed_behinds = COALESCE(excluded.away_rushed_behinds, matches.away_rushed_behinds),
      home_minutes_in_front = COALESCE(excluded.home_minutes_in_front, matches.home_minutes_in_front),
      away_minutes_in_front = COALESCE(excluded.away_minutes_in_front, matches.away_minutes_in_front),
      home_q1_goals = COALESCE(excluded.home_q1_goals, matches.home_q1_goals),
      home_q1_behinds = COALESCE(excluded.home_q1_behinds, matches.home_q1_behinds),
      home_q2_goals = COALESCE(excluded.home_q2_goals, matches.home_q2_goals),
      home_q2_behinds = COALESCE(excluded.home_q2_behinds, matches.home_q2_behinds),
      home_q3_goals = COALESCE(excluded.home_q3_goals, matches.home_q3_goals),
      home_q3_behinds = COALESCE(excluded.home_q3_behinds, matches.home_q3_behinds),
      home_q4_goals = COALESCE(excluded.home_q4_goals, matches.home_q4_goals),
      home_q4_behinds = COALESCE(excluded.home_q4_behinds, matches.home_q4_behinds),
      away_q1_goals = COALESCE(excluded.away_q1_goals, matches.away_q1_goals),
      away_q1_behinds = COALESCE(excluded.away_q1_behinds, matches.away_q1_behinds),
      away_q2_goals = COALESCE(excluded.away_q2_goals, matches.away_q2_goals),
      away_q2_behinds = COALESCE(excluded.away_q2_behinds, matches.away_q2_behinds),
      away_q3_goals = COALESCE(excluded.away_q3_goals, matches.away_q3_goals),
      away_q3_behinds = COALESCE(excluded.away_q3_behinds, matches.away_q3_behinds),
      away_q4_goals = COALESCE(excluded.away_q4_goals, matches.away_q4_goals),
      away_q4_behinds = COALESCE(excluded.away_q4_behinds, matches.away_q4_behinds),
      weather_temp_c = COALESCE(excluded.weather_temp_c, matches.weather_temp_c),
      weather_type = COALESCE(excluded.weather_type, matches.weather_type)`,
  ).bind(
    m.matchId,
    ctx.seasonId,
    m.roundNumber,
    deriveRoundType(m.roundType),
    deriveRound(m),
    dateStr,
    localTime,
    venueId,
    homeTeamId,
    awayTeamId,
    m.homeGoals,
    m.homeBehinds,
    m.homePoints,
    m.awayGoals,
    m.awayBehinds,
    m.awayPoints,
    m.margin,
    m.attendance,
    m.homeRushedBehinds,
    m.awayRushedBehinds,
    m.homeMinutesInFront,
    m.awayMinutesInFront,
    m.q1Home?.goals ?? null,
    m.q1Home?.behinds ?? null,
    m.q2Home?.goals ?? null,
    m.q2Home?.behinds ?? null,
    m.q3Home?.goals ?? null,
    m.q3Home?.behinds ?? null,
    m.q4Home?.goals ?? null,
    m.q4Home?.behinds ?? null,
    m.q1Away?.goals ?? null,
    m.q1Away?.behinds ?? null,
    m.q2Away?.goals ?? null,
    m.q2Away?.behinds ?? null,
    m.q3Away?.goals ?? null,
    m.q3Away?.behinds ?? null,
    m.q4Away?.goals ?? null,
    m.q4Away?.behinds ?? null,
    m.weatherTempCelsius,
    m.weatherType,
  );
}

/**
 * Upsert per-match player stats. Phantom rows (no time on ground AND no
 * disposals) are filtered — these are emergencies/late withdrawals who never
 * took the field but appear in the API.
 */
export async function upsertStats(
  env: Env,
  stats: readonly PlayerStats[],
  matchMap: Map<string, number>,
  playerMap: Map<string, number>,
  teamMap: Map<string, number>,
): Promise<number> {
  let affected = 0;
  for (let i = 0; i < stats.length; i += BATCH_SIZE) {
    const chunk = stats.slice(i, i + BATCH_SIZE);
    const stmts: D1PreparedStatement[] = [];
    for (const s of chunk) {
      const playerId = playerMap.get(s.playerId);
      if (!playerId) continue;
      if (!s.timeOnGroundPercentage && !s.disposals) continue;
      const matchId = matchMap.get(s.matchId);
      if (!matchId) continue;
      const teamId = teamMap.get(normaliseTeam(s.team)) ?? null;
      stmts.push(buildStatUpsert(env, s, matchId, playerId, teamId));
    }
    if (stmts.length > 0) {
      const results = await env.DB.batch(stmts);
      affected += results.filter((r) => r.success).length;
    }
  }
  return affected;
}

function buildStatUpsert(
  env: Env,
  s: PlayerStats,
  matchId: number,
  playerId: number,
  teamId: number | null,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO player_match_stats (
      match_id, player_id, team_id, guernsey_number, player_position,
      kicks, handballs, disposals, marks, goals, behinds, tackles, hitouts,
      free_kicks_for, free_kicks_against,
      contested_possessions, uncontested_possessions, contested_marks,
      intercepts, centre_clearances, stoppage_clearances, clearances,
      inside_fifties, rebounds, clangers, turnovers,
      one_percenters, bounces, goal_assists,
      disposal_efficiency_pct, metres_gained,
      goal_accuracy, marks_inside_fifty, tackles_inside_fifty,
      shots_at_goal, score_involvements, total_possessions,
      time_on_ground_pct, afl_fantasy_score, rating_points,
      goal_efficiency, shot_efficiency, interchange_counts,
      effective_disposals, effective_kicks, kick_efficiency,
      kick_to_handball_ratio, pressure_acts, def_half_pressure_acts,
      spoils, hitouts_to_advantage, hitout_win_pct,
      ground_ball_gets, f50_ground_ball_gets,
      intercept_marks, marks_on_lead,
      contested_possession_rate,
      contest_off_one_on_ones, contest_off_wins, contest_off_wins_pct,
      contest_def_one_on_ones, contest_def_losses, contest_def_loss_pct,
      centre_bounce_attendances, kickins, kickins_playon,
      ruck_contests, score_launches, supercoach_score, brownlow_votes
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?,
      ?, ?,
      ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?
    )
    ON CONFLICT (match_id, player_id) DO UPDATE SET
      team_id = excluded.team_id,
      guernsey_number = excluded.guernsey_number,
      player_position = excluded.player_position,
      kicks = excluded.kicks,
      handballs = excluded.handballs,
      disposals = excluded.disposals,
      marks = excluded.marks,
      goals = excluded.goals,
      behinds = excluded.behinds,
      tackles = excluded.tackles,
      hitouts = excluded.hitouts,
      free_kicks_for = excluded.free_kicks_for,
      free_kicks_against = excluded.free_kicks_against,
      contested_possessions = excluded.contested_possessions,
      uncontested_possessions = excluded.uncontested_possessions,
      contested_marks = excluded.contested_marks,
      intercepts = excluded.intercepts,
      centre_clearances = excluded.centre_clearances,
      stoppage_clearances = excluded.stoppage_clearances,
      clearances = excluded.clearances,
      inside_fifties = excluded.inside_fifties,
      rebounds = excluded.rebounds,
      clangers = excluded.clangers,
      turnovers = excluded.turnovers,
      one_percenters = excluded.one_percenters,
      bounces = excluded.bounces,
      goal_assists = excluded.goal_assists,
      disposal_efficiency_pct = excluded.disposal_efficiency_pct,
      metres_gained = excluded.metres_gained,
      goal_accuracy = excluded.goal_accuracy,
      marks_inside_fifty = excluded.marks_inside_fifty,
      tackles_inside_fifty = excluded.tackles_inside_fifty,
      shots_at_goal = excluded.shots_at_goal,
      score_involvements = excluded.score_involvements,
      total_possessions = excluded.total_possessions,
      time_on_ground_pct = excluded.time_on_ground_pct,
      afl_fantasy_score = excluded.afl_fantasy_score,
      rating_points = excluded.rating_points,
      goal_efficiency = excluded.goal_efficiency,
      shot_efficiency = excluded.shot_efficiency,
      interchange_counts = excluded.interchange_counts,
      effective_disposals = excluded.effective_disposals,
      effective_kicks = excluded.effective_kicks,
      kick_efficiency = excluded.kick_efficiency,
      kick_to_handball_ratio = excluded.kick_to_handball_ratio,
      pressure_acts = excluded.pressure_acts,
      def_half_pressure_acts = excluded.def_half_pressure_acts,
      spoils = excluded.spoils,
      hitouts_to_advantage = excluded.hitouts_to_advantage,
      hitout_win_pct = excluded.hitout_win_pct,
      ground_ball_gets = excluded.ground_ball_gets,
      f50_ground_ball_gets = excluded.f50_ground_ball_gets,
      intercept_marks = excluded.intercept_marks,
      marks_on_lead = excluded.marks_on_lead,
      contested_possession_rate = excluded.contested_possession_rate,
      contest_off_one_on_ones = excluded.contest_off_one_on_ones,
      contest_off_wins = excluded.contest_off_wins,
      contest_off_wins_pct = excluded.contest_off_wins_pct,
      contest_def_one_on_ones = excluded.contest_def_one_on_ones,
      contest_def_losses = excluded.contest_def_losses,
      contest_def_loss_pct = excluded.contest_def_loss_pct,
      centre_bounce_attendances = excluded.centre_bounce_attendances,
      kickins = excluded.kickins,
      kickins_playon = excluded.kickins_playon,
      ruck_contests = excluded.ruck_contests,
      score_launches = excluded.score_launches,
      supercoach_score = COALESCE(excluded.supercoach_score, player_match_stats.supercoach_score),
      brownlow_votes = COALESCE(excluded.brownlow_votes, player_match_stats.brownlow_votes)`,
  ).bind(
    matchId,
    playerId,
    teamId,
    s.jumperNumber,
    s.position,
    s.kicks,
    s.handballs,
    s.disposals,
    s.marks,
    s.goals,
    s.behinds,
    s.tackles,
    s.hitouts,
    s.freesFor,
    s.freesAgainst,
    s.contestedPossessions,
    s.uncontestedPossessions,
    s.contestedMarks,
    s.intercepts,
    s.centreClearances,
    s.stoppageClearances,
    s.totalClearances,
    s.inside50s,
    s.rebound50s,
    s.clangers,
    s.turnovers,
    s.onePercenters,
    s.bounces,
    s.goalAssists,
    s.disposalEfficiency,
    s.metresGained,
    s.goalAccuracy,
    s.marksInside50,
    s.tacklesInside50,
    s.shotsAtGoal,
    s.scoreInvolvements,
    s.totalPossessions,
    s.timeOnGroundPercentage,
    s.dreamTeamPoints,
    s.ratingPoints,
    s.goalEfficiency,
    s.shotEfficiency,
    s.interchangeCounts,
    s.effectiveDisposals,
    s.effectiveKicks,
    s.kickEfficiency,
    s.kickToHandballRatio,
    s.pressureActs,
    s.defHalfPressureActs,
    s.spoils,
    s.hitoutsToAdvantage,
    s.hitoutWinPercentage,
    s.groundBallGets,
    s.f50GroundBallGets,
    s.interceptMarks,
    s.marksOnLead,
    s.contestedPossessionRate,
    s.contestOffOneOnOnes,
    s.contestOffWins,
    s.contestOffWinsPercentage,
    s.contestDefOneOnOnes,
    s.contestDefLosses,
    s.contestDefLossPercentage,
    s.centreBounceAttendances,
    s.kickins,
    s.kickinsPlayon,
    s.ruckContests,
    s.scoreLaunches,
    s.supercoachScore,
    s.brownlowVotes,
  );
}

/** Upsert per-match lineups (one row per player per match). */
export async function upsertLineups(
  env: Env,
  lineups: readonly Lineup[],
  matchMap: Map<string, number>,
  playerMap: Map<string, number>,
  teamMap: Map<string, number>,
): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  for (const lineup of lineups) {
    const matchId = matchMap.get(lineup.matchId);
    if (!matchId) continue;
    const homeTeamId = teamMap.get(normaliseTeam(lineup.homeTeam));
    const awayTeamId = teamMap.get(normaliseTeam(lineup.awayTeam));
    const sides: Array<{ players: readonly LineupPlayer[]; teamId: number | undefined }> = [
      { players: lineup.homePlayers, teamId: homeTeamId },
      { players: lineup.awayPlayers, teamId: awayTeamId },
    ];
    for (const { players, teamId } of sides) {
      if (!teamId) continue;
      for (const p of players) {
        const playerId = playerMap.get(p.playerId);
        if (!playerId) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO match_lineups (match_id, player_id, team_id, guernsey_number, position, is_emergency, is_substitute)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (match_id, player_id) DO UPDATE SET
               team_id = excluded.team_id,
               guernsey_number = excluded.guernsey_number,
               position = excluded.position,
               is_emergency = excluded.is_emergency,
               is_substitute = excluded.is_substitute`,
          ).bind(
            matchId,
            playerId,
            teamId,
            p.jumperNumber,
            p.matchPosition,
            p.isEmergency ? 1 : 0,
            p.isSubstitute ? 1 : 0,
          ),
        );
      }
    }
  }
  let affected = 0;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    const chunk = stmts.slice(i, i + BATCH_SIZE);
    const results = await env.DB.batch(chunk);
    affected += results.filter((r) => r.success).length;
  }
  return affected;
}
