import { fetchLineup } from "fitzroy"
import type { Lineup, LineupPlayer } from "fitzroy"
import type { Env } from "../types"
import { COMPETITION_CODE } from "../lib/constants"
import { normaliseTeam } from "../lib/normalise"
import { buildLookupMap } from "./sync-matches"
import { getPlayerIdMap } from "./sync-players"
import { logSync } from "./log"

export async function syncLineups(env: Env): Promise<void> {
  const currentYear = new Date().getFullYear()

  try {
    const season = await env.DB.prepare(
      "SELECT id FROM seasons WHERE year = ? AND competition_id = (SELECT id FROM competitions WHERE code = ?)"
    ).bind(currentYear, COMPETITION_CODE).first<{ id: number }>()

    if (!season) {
      await logSync(env, "sync_lineups", 0, "No season found for current year")
      return
    }

    const teamIdMap = await buildLookupMap(env, "teams")
    let playerIdMap = await getPlayerIdMap(env)
    const matchAflIdMap = await buildMatchAflIdMap(env, season.id)

    const roundsToFetch = await getRoundsNeedingLineups(env, season.id)
    if (roundsToFetch.length === 0) return

    let totalAffected = 0

    for (const roundNumber of roundsToFetch) {
      const result = await fetchLineup({
        source: "afl-api",
        season: currentYear,
        round: roundNumber,
        competition: COMPETITION_CODE,
      })

      if (!result.success) continue

      const newPlayers = await upsertLineupPlayers(env, result.data, playerIdMap)
      if (newPlayers > 0) {
        playerIdMap = await getPlayerIdMap(env)
      }

      const affected = await upsertLineups(env, result.data, matchAflIdMap, playerIdMap, teamIdMap)
      totalAffected += affected
    }

    await logSync(env, "sync_lineups", totalAffected)
  } catch (err) {
    await logSync(env, "sync_lineups", 0, err instanceof Error ? err.message : String(err))
  }
}

async function getRoundsNeedingLineups(env: Env, seasonId: number): Promise<number[]> {
  const { results: allRounds } = await env.DB.prepare(
    "SELECT DISTINCT round_number FROM matches WHERE season_id = ? AND round_number IS NOT NULL ORDER BY round_number"
  ).bind(seasonId).all<{ round_number: number }>()

  const latest = await env.DB.prepare(
    "SELECT MAX(round_number) as rn FROM matches WHERE season_id = ? AND home_points IS NOT NULL"
  ).bind(seasonId).first<{ rn: number | null }>()

  const currentRound = latest?.rn ?? 0

  const { results: coveredRounds } = await env.DB.prepare(
    `SELECT DISTINCT m.round_number FROM match_lineups ml
     JOIN matches m ON ml.match_id = m.id
     WHERE m.season_id = ? AND m.round_number IS NOT NULL`
  ).bind(seasonId).all<{ round_number: number }>()

  const covered = new Set(coveredRounds.map(r => r.round_number))

  const rounds = allRounds.map(r => r.round_number)

  // Always include round 0 — the lineup API uses round 0 for Opening Round
  // matches even though the matches table may store them as round 1
  if (!rounds.includes(0)) rounds.unshift(0)

  return rounds.filter(rn => !covered.has(rn) || rn >= currentRound)
}

async function buildMatchAflIdMap(env: Env, seasonId: number): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT id, external_afl_id FROM matches WHERE season_id = ? AND external_afl_id IS NOT NULL"
  ).bind(seasonId).all<{ id: number; external_afl_id: string }>()

  const map = new Map<string, number>()
  for (const r of results) {
    map.set(r.external_afl_id, r.id)
  }
  return map
}

async function upsertLineupPlayers(
  env: Env,
  lineups: Lineup[],
  existingPlayerIds: Map<string, number>,
): Promise<number> {
  const newPlayers = new Map<string, LineupPlayer>()

  for (const lineup of lineups) {
    for (const p of [...lineup.homePlayers, ...lineup.awayPlayers]) {
      if (!existingPlayerIds.has(p.playerId) && !newPlayers.has(p.playerId)) {
        newPlayers.set(p.playerId, p)
      }
    }
  }

  if (newPlayers.size === 0) return 0

  const players = Array.from(newPlayers.values())
  let totalAffected = 0

  for (let i = 0; i < players.length; i += 500) {
    const chunk = players.slice(i, i + 500)
    const stmts: D1PreparedStatement[] = []

    for (const p of chunk) {
      // Try to adopt an existing fryzigg record by name first
      stmts.push(env.DB.prepare(
        `UPDATE players SET external_afl_player_id = ?
         WHERE first_name = ? AND surname = ?
           AND external_afl_player_id IS NULL
           AND external_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM players WHERE external_afl_player_id = ?)`
      ).bind(p.playerId, p.givenName, p.surname, p.playerId))

      stmts.push(env.DB.prepare(
        `INSERT INTO players (first_name, surname, external_afl_player_id)
         VALUES (?, ?, ?)
         ON CONFLICT (external_afl_player_id) WHERE external_afl_player_id IS NOT NULL
         DO UPDATE SET first_name = excluded.first_name, surname = excluded.surname`
      ).bind(p.givenName, p.surname, p.playerId))
    }

    const results = await env.DB.batch(stmts)
    totalAffected += results.filter(r => r.success).length
  }

  return totalAffected
}

async function upsertLineups(
  env: Env,
  lineups: Lineup[],
  matchAflIdMap: Map<string, number>,
  playerIdMap: Map<string, number>,
  teamIdMap: Map<string, number>,
): Promise<number> {
  const stmts: D1PreparedStatement[] = []

  for (const lineup of lineups) {
    const matchId = matchAflIdMap.get(lineup.matchId)
    if (!matchId) continue

    const homeTeamId = teamIdMap.get(normaliseTeam(lineup.homeTeam))
    const awayTeamId = teamIdMap.get(normaliseTeam(lineup.awayTeam))

    const sides: Array<{ players: readonly LineupPlayer[]; teamId: number | undefined }> = [
      { players: lineup.homePlayers, teamId: homeTeamId },
      { players: lineup.awayPlayers, teamId: awayTeamId },
    ]

    for (const { players, teamId } of sides) {
      if (!teamId) continue

      for (const p of players) {
        const playerId = playerIdMap.get(p.playerId)
        if (!playerId) continue

        stmts.push(
          env.DB.prepare(
            `INSERT INTO match_lineups (match_id, player_id, team_id, guernsey_number, position, is_emergency, is_substitute)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (match_id, player_id) DO UPDATE SET
               team_id = excluded.team_id,
               guernsey_number = excluded.guernsey_number,
               position = excluded.position,
               is_emergency = excluded.is_emergency,
               is_substitute = excluded.is_substitute`
          ).bind(matchId, playerId, teamId, p.jumperNumber, p.position, p.isEmergency ? 1 : 0, p.isSubstitute ? 1 : 0)
        )
      }
    }
  }

  let totalAffected = 0
  for (let i = 0; i < stmts.length; i += 500) {
    const chunk = stmts.slice(i, i + 500)
    const results = await env.DB.batch(chunk)
    totalAffected += results.filter(r => r.success).length
  }

  return totalAffected
}
