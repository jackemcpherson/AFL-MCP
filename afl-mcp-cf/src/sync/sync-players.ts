import type { Env } from "../types"
import type { PlayerStats } from "fitzroy"

export async function syncPlayers(env: Env, stats: PlayerStats[]): Promise<number> {
  const playerMap = new Map<string, PlayerStats>()
  for (const s of stats) {
    if (!playerMap.has(s.playerId)) {
      playerMap.set(s.playerId, s)
    }
  }

  const players = Array.from(playerMap.values())
  let totalAffected = 0

  for (let i = 0; i < players.length; i += 500) {
    const chunk = players.slice(i, i + 500)
    const stmts: D1PreparedStatement[] = []

    for (const p of chunk) {
      // Try to adopt an existing fryzigg record by name if no AFL API record exists yet.
      // This prevents duplicates when a player has both fryzigg and AFL API data.
      stmts.push(env.DB.prepare(
        `UPDATE players SET external_afl_player_id = ?
         WHERE first_name = ? AND surname = ?
           AND external_afl_player_id IS NULL
           AND external_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM players WHERE external_afl_player_id = ?)`
      ).bind(p.playerId, p.givenName, p.surname, p.playerId))

      // Fall back to the standard upsert for new players or if the above didn't match
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

export async function getPlayerIdMap(env: Env): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL"
  ).all<{ id: number; external_afl_player_id: string }>()

  const map = new Map<string, number>()
  for (const r of results) {
    map.set(r.external_afl_player_id, r.id)
  }
  return map
}
