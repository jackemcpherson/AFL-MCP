import { fetchMatchResults } from "fitzroy"
import type { Env } from "../types"
import { COMPETITION_CODE } from "../lib/constants"
import { syncNewData } from "./sync-matches"
import { logSync } from "./log"

export async function checkFreshness(env: Env): Promise<void> {
  try {
    const currentYear = new Date().getFullYear()

    const dbLatest = await env.DB.prepare(
      `SELECT MAX(date) as latest FROM matches m JOIN seasons s ON m.season_id = s.id WHERE s.year = ?`
    ).bind(currentYear).first<{ latest: string | null }>()

    const apiResult = await fetchMatchResults({
      source: "afl-api",
      season: currentYear,
      competition: COMPETITION_CODE,
    })

    if (!apiResult.success) return

    const completedMatches = apiResult.data.filter(
      m => m.homePoints !== null && m.homePoints !== undefined
    )
    if (completedMatches.length === 0) return

    const apiLatest = completedMatches
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())[0]

    if (apiLatest && (!dbLatest?.latest || apiLatest.date.toISOString().slice(0, 10) > dbLatest.latest)) {
      await syncNewData(env)
    }
  } catch (err) {
    await logSync(env, "freshness_check", 0, err instanceof Error ? err.message : String(err))
  }
}
