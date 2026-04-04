import type { PlayerStats } from "fitzroy"
import type { Env } from "../types"
import { normaliseTeam } from "../lib/normalise"

export async function syncStats(
  env: Env,
  stats: PlayerStats[],
  teamIdMap: Map<string, number>,
  playerIdMap: Map<string, number>,
): Promise<number> {
  const matchLookup = await buildMatchLookup(env)

  let totalAffected = 0

  for (let i = 0; i < stats.length; i += 500) {
    const chunk = stats.slice(i, i + 500)
    const stmts: D1PreparedStatement[] = []

    for (const s of chunk) {
      const playerId = playerIdMap.get(s.playerId)
      if (!playerId) continue

      const homeTeam = s.homeTeam ? normaliseTeam(s.homeTeam) : null
      const awayTeam = s.awayTeam ? normaliseTeam(s.awayTeam) : null
      const dateStr = s.date ? s.date.toISOString().slice(0, 10) : null

      if (!homeTeam || !awayTeam || !dateStr) continue

      const homeTeamId = teamIdMap.get(homeTeam)
      const awayTeamId = teamIdMap.get(awayTeam)
      if (!homeTeamId || !awayTeamId) continue

      const matchKey = `${dateStr}|${homeTeamId}|${awayTeamId}`
      const matchId = matchLookup.get(matchKey)
      if (!matchId) continue

      const playerTeam = normaliseTeam(s.team)
      const playerTeamId = teamIdMap.get(playerTeam)

      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO player_match_stats (
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
          spoils, hitouts_to_advantage, hitout_win_pct, hitout_to_advantage_rate,
          ground_ball_gets, f50_ground_ball_gets,
          intercept_marks, marks_on_lead,
          contested_possession_rate,
          contest_off_one_on_ones, contest_off_wins, contest_off_wins_pct,
          contest_def_one_on_ones, contest_def_losses, contest_def_loss_pct,
          centre_bounce_attendances, kickins, kickins_playon,
          ruck_contests, score_launches, supercoach_score
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
          ?, ?, ?, ?,
          ?, ?,
          ?, ?,
          ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )`
      ).bind(
        matchId,
        playerId,
        playerTeamId ?? null,
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
        s.hitoutToAdvantageRate,
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
      ))
    }

    if (stmts.length > 0) {
      const results = await env.DB.batch(stmts)
      totalAffected += results.filter(r => r.success).length
    }
  }

  return totalAffected
}

async function buildMatchLookup(env: Env): Promise<Map<string, number>> {
  // Scoped to current year to avoid loading entire match history
  const currentYear = new Date().getFullYear()
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.date, m.home_team_id, m.away_team_id
     FROM matches m
     JOIN seasons s ON m.season_id = s.id
     WHERE s.year = ?`
  ).bind(currentYear).all<{ id: number; date: string; home_team_id: number; away_team_id: number }>()

  const map = new Map<string, number>()
  for (const r of results) {
    const key = `${r.date}|${r.home_team_id}|${r.away_team_id}`
    map.set(key, r.id)
  }
  return map
}
