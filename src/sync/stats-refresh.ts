import {
  type CompetitionCode,
  fetchPlayerStats,
  type PlayerStats,
  type SeasonSelector,
} from "fitzroy";
import { normaliseTeamForMatch } from "../lib/normalise";
import type { Env } from "../types";
import { calculatePav } from "./pav";
import { statFieldCapabilities } from "./stat-capabilities";
import { STAT_COLUMNS, upsertPlayers, upsertStats } from "./upserts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
/** Maximum matches in an hourly refresh, across all competitions. */
export const MAX_STATS_REFRESH_MATCHES = 20;

interface RefreshMatch {
  readonly id: number;
  readonly external_afl_id: string;
  readonly season_id: number;
  readonly year: number;
  readonly season_key: string;
  readonly code: CompetitionCode;
  readonly completed_observed_at: string;
  readonly failures: number;
  readonly home_team_id: number;
  readonly away_team_id: number;
  readonly home_name: string;
  readonly away_name: string;
}

/** Persisted refresh outcome, with failed fetches isolated from successful matches. */
export interface StatsRefreshReport {
  readonly attempted: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly changedRows: number;
}

/**
 * Calculate the next fetch after success or failure. The clock starts when a
 * completed match is first observed, never from an invented completion time.
 * @param completedAt - First observed completed status.
 * @param now - Fetch timestamp.
 * @param failures - Consecutive failures, zero after success.
 * @returns Next retry time, or null after the final successful day-30 refresh.
 */
export function nextStatsRefresh(completedAt: Date, now: Date, failures: number): string | null {
  if (failures > 0)
    return new Date(
      now.getTime() + Math.min(2 ** Math.min(failures - 1, 5), 24) * HOUR,
    ).toISOString();
  const age = now.getTime() - completedAt.getTime();
  if (age < 2 * DAY)
    return new Date(Math.min(now.getTime() + HOUR, completedAt.getTime() + 2 * DAY)).toISOString();
  if (age < 14 * DAY)
    return new Date(Math.min(now.getTime() + DAY, completedAt.getTime() + 14 * DAY)).toISOString();
  if (age < 30 * DAY) return new Date(completedAt.getTime() + 30 * DAY).toISOString();
  return null;
}

/**
 * Queue recent completed matches without resetting existing retry schedules.
 * Historical imports use the explicit admin queue rather than an unbounded cron sweep.
 * @param env - Worker bindings.
 * @param now - Observation time.

 * @returns Resolves after persisting recent completed matches without resetting checkpoints.
 * @throws If the queue write fails.
 * @example
 * await queueRecentStatsRefresh(writer, new Date());
 */
export async function queueRecentStatsRefresh(env: Env, now: Date): Promise<void> {
  await env.DB.prepare(`INSERT INTO match_stats_refresh (match_id, completed_observed_at, next_retry_at)
    SELECT id, ?1, ?1 FROM matches WHERE status = 'Complete' AND external_afl_id IS NOT NULL
    AND date >= date(?1, '-30 days') AND date <= date(?1)
    ON CONFLICT(match_id) DO NOTHING`)
    .bind(now.toISOString())
    .run();
}

/**
 * Refresh at most 20 queued matches, oldest due first. Call under the shared
 * lease and public write marker. Database failures propagate, retaining that marker.
 * @param env - Worker bindings.
 * @param now - Timestamp for attempts, successful fetches and retries.
 * @param fetchStats - Provider fetch function; injected for captured-fixture tests.
 * @param seasonId - Optional exact season scope for an operator refresh.
 * @param operationId - Persisted operation whose pending matches restrict the fetch.
 * @param holder - Lease owner used to fence explicit PAV replacements.
 * @returns Counts of independently completed fetches and changed statistic rows.

 * @throws If approval, recovery, lease ownership or a database operation fails.
 * @example
 * await refreshDueStats(writer, new Date(), undefined, seasonId, operationId, holder); */
export async function refreshDueStats(
  env: Env,
  now: Date,
  fetchStats: typeof fetchPlayerStats = fetchPlayerStats,
  seasonId?: number,
  operationId?: string,
  holder?: string,
): Promise<StatsRefreshReport> {
  const due = await env.DB.prepare(`SELECT m.id, m.external_afl_id, m.season_id,
    m.home_team_id, m.away_team_id, h.name AS home_name, a.name AS away_name,
    s.year, s.season_key, c.code, r.completed_observed_at, r.failures
    FROM match_stats_refresh r JOIN matches m ON m.id = r.match_id
    JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
    JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
    WHERE r.next_retry_at <= ?1 AND m.status = 'Complete' AND (?2 IS NULL OR s.id = ?2)
    AND (?4 IS NULL OR EXISTS (SELECT 1 FROM stats_refresh_operation_matches o
      WHERE o.match_id = m.id AND o.operation_id = ?4 AND o.status = 'pending'))
    ORDER BY r.next_retry_at, m.id LIMIT ?3`)
    .bind(now.toISOString(), seasonId ?? null, MAX_STATS_REFRESH_MATCHES, operationId ?? null)
    .all<RefreshMatch>();
  let succeeded = 0;
  let failed = 0;
  let changedRows = 0;
  for (const match of due.results) {
    await env.DB.prepare("UPDATE match_stats_refresh SET attempted_at = ?1 WHERE match_id = ?2")
      .bind(now.toISOString(), match.id)
      .run();
    let stats: readonly PlayerStats[];
    try {
      const result = await fetchStats({
        source: "afl-api",
        competition: match.code,
        season: match.season_key as SeasonSelector,
        matchId: match.external_afl_id,
      });
      if (!result.success) throw result.error;
      if (result.data.failedMatchIds.length)
        throw new Error("Provider reported failed match statistics");
      stats = result.data.stats;
      if (!stats.length) throw new Error("Provider returned no participants");
      const teams = new Set([match.home_name, match.away_name]);
      const seen = new Set<string>();
      for (const row of stats) {
        if (
          row.matchId !== match.external_afl_id ||
          row.competition !== match.code ||
          row.season !== match.year ||
          !teams.has(normaliseTeamForMatch(row.team, row.competition, row.season)) ||
          seen.has(row.playerId)
        ) {
          throw new Error("Provider participant scope or identity mismatch");
        }
        seen.add(row.playerId);
      }
    } catch (error) {
      failed++;
      await env.DB.prepare(`UPDATE match_stats_refresh SET failures = failures + 1,
        next_retry_at = ?1, diagnostic = ?2 WHERE match_id = ?3`)
        .bind(
          nextStatsRefresh(new Date(match.completed_observed_at), now, match.failures + 1),
          error instanceof Error ? error.message : "Provider fetch failed",
          match.id,
        )
        .run();
      continue;
    }
    // No participant deletion: this provider envelope does not establish a complete roster.
    const players = await upsertPlayers(env, stats);
    const changes = await upsertStats(
      env,
      stats,
      new Map([[match.external_afl_id, match.id]]),
      players,
      new Map([
        [match.home_name, match.home_team_id],
        [match.away_name, match.away_team_id],
      ]),
    );
    changedRows += changes;
    const capability = statFieldCapabilities(match.code, match.season_key);
    const supported = STAT_COLUMNS.map((column) => column.name).filter((name) =>
      capability.supported.includes(name),
    );
    const missing = supported.length
      ? await env.DB.prepare(
          `SELECT ${supported.map((name) => `SUM(${name} IS NULL) AS ${name}`).join(",")} FROM player_match_stats WHERE match_id=?1`,
        )
          .bind(match.id)
          .first<Record<string, number>>()
      : {};
    const diagnostic = JSON.stringify({
      participantCompleteness: "unverified",
      capabilityEvidence: capability.evidence,
      missingSupportedFields: Object.fromEntries(
        Object.entries(missing ?? {}).filter(([, count]) => count > 0),
      ),
    });
    await env.DB.prepare(`UPDATE match_stats_refresh SET succeeded_at = ?1, next_retry_at = ?2,
      failures = 0, participant_count = ?3, diagnostic = ?5 WHERE match_id = ?4`)
      .bind(
        now.toISOString(),
        nextStatsRefresh(new Date(match.completed_observed_at), now, 0),
        stats.length,
        match.id,
        diagnostic,
      )
      .run();
    await env.DB.prepare(
      "UPDATE stats_refresh_operation_matches SET status = 'complete' WHERE match_id = ?1",
    )
      .bind(match.id)
      .run();
    succeeded++;
  }
  await rebuildQueuedStatsPav(env, seasonId, holder);
  return { attempted: due.results.length, succeeded, failed, changedRows };
}

/**
 * Finish bounded derived work for changed fixture or statistic inputs.
 * @param env - Bindings under the public write marker.
 * @param seasonId - Optional exact season scope.
 * @param holder - Lease owner for explicit PAV replacement fencing.
 * @returns Resolves after the scoped statistics queue is empty.
 * @throws If replacement fails or bounded work remains. The caller must retain its marker.
 * @example
 * await rebuildQueuedStatsPav(writer, undefined, holder);
 */
export async function rebuildQueuedStatsPav(
  env: Env,
  seasonId?: number,
  holder?: string,
): Promise<void> {
  // Database triggers queue only changed PAV inputs, in the same transaction as the input.
  // A failed replacement leaves the queue intact, even if the match fetch checkpoint committed.
  const pending = await env.DB.prepare(`SELECT s.id, s.season_key, c.code FROM pav_rebuild_queue q
    JOIN seasons s ON s.id=q.season_id JOIN competitions c ON c.id=s.competition_id
    WHERE (?1 IS NULL OR s.id=?1) AND q.reason='statistics' ORDER BY s.id LIMIT ?2`)
    .bind(seasonId ?? null, MAX_STATS_REFRESH_MATCHES)
    .all<{ id: number; season_key: string; code: CompetitionCode }>();
  for (const season of pending.results) {
    if (season.code === "AFLM" || season.code === "AFLW")
      await calculatePav(env, season.season_key, season.code, holder);
    await env.DB.prepare("DELETE FROM pav_rebuild_queue WHERE season_id=?1 AND reason='statistics'")
      .bind(season.id)
      .run();
  }
  const remaining = await env.DB.prepare(
    "SELECT 1 FROM pav_rebuild_queue WHERE reason='statistics' AND (?1 IS NULL OR season_id=?1) LIMIT 1",
  )
    .bind(seasonId ?? null)
    .first();
  if (remaining) throw new Error("Statistics PAV rebuilds remain; resume the marked operation");
}
