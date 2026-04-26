import type { Env } from "../types"
import { checkFreshness } from "./freshness"
import { syncNewData } from "./sync-matches"
import { recalculatePav } from "./pav"
import { syncLineups } from "./sync-lineups"

const CRON_FRESHNESS = "*/5 * * * *"
const CRON_FULL_SYNC = "0 * * * *"
const CRON_PAV = "0 17 * * *"

export async function handleCron(event: ScheduledEvent, env: Env): Promise<void> {
  const cron = event.cron

  if (cron === CRON_FRESHNESS) {
    if (isMatchWindow()) {
      await checkFreshness(env)
    }
    return
  }

  if (cron === CRON_FULL_SYNC) {
    await syncNewData(env)
    await syncLineups(env)
    return
  }

  if (cron === CRON_PAV) {
    await recalculatePav(env)
    return
  }
}

export function isMatchWindow(): boolean {
  const now = new Date()
  const aestHour = (now.getUTCHours() + 10) % 24
  const day = now.getUTCDay()

  // Thu 6pm -> Mon 1am AEST covers standard match times
  if (day === 4 && aestHour >= 18) return true  // Thursday evening
  if (day === 5 || day === 6) return true         // Friday, Saturday
  if (day === 0) return true                       // Sunday
  if (day === 1 && aestHour <= 1) return true      // Monday early morning
  return false
}
