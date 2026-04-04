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
    const stmts = chunk.map(p =>
      env.DB.prepare(
        `INSERT INTO players (first_name, surname, external_afl_player_id)
         VALUES (?, ?, ?)
         ON CONFLICT (external_afl_player_id) WHERE external_afl_player_id IS NOT NULL
         DO UPDATE SET first_name = excluded.first_name, surname = excluded.surname`
      ).bind(p.givenName, p.surname, p.playerId)
    )
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
