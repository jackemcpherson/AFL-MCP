import type { CompetitionCode, Match } from "fitzroy";
import { fetchLineup, fetchMatches, fetchPlayerStats } from "fitzroy";
import { toIsoDate } from "../lib/time";
import type { Env } from "../types";
import { logSync } from "./log";
import { type PavCompetition, recalculatePav } from "./pav";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  selectCompletedCount,
  selectCompletedRoundsWithoutLineups,
  selectHasCompletedMatchWithoutStats,
  selectNextRound,
  selectRoundHasAnyLineups,
  unionPlayers,
  updateSeasonCompleteness,
  upsertLineups,
  upsertMatches,
  upsertPlayers,
  upsertStats,
} from "./upserts";

const FORWARD_DAYS = 3;
const BACKWARD_DAYS = 1;
const SOURCE = "afl-api" as const;

const PAV_COMPETITIONS: ReadonlySet<CompetitionCode> = new Set<CompetitionCode>(["AFLM", "AFLW"]);

/** Per-(competition, year) outcome from a single sync tick. */
export interface BackfillResult {
  readonly competition: CompetitionCode;
  readonly year: number;
  readonly matches: number;
  readonly stats: number;
  readonly lineups: number;
  readonly error?: string;
}

/** Optional knobs for the backfill / admin entry points. */
export interface SyncOptions {
  /** When provided alongside `toYear`, iterates seasons inclusively. */
  readonly fromYear?: number;
  /** Inclusive upper bound for the iteration. */
  readonly toYear?: number;
  /** Skip the cadence gate; for backfills triggered manually. */
  readonly skipShouldRunNow?: boolean;
  /** Skip PAV recalc after stats writes; for label-only relabels. */
  readonly skipPav?: boolean;
}

/**
 * The single sync entry point. Called from the scheduled() cron handler in
 * steady state and from `/mcp/admin/backfill` for one-shot historical loads.
 *
 * - Steady-state: pass `competitions` only; current calendar year is synced
 *   subject to the `shouldRunNow` cadence gate.
 * - Backfill: pass `fromYear`/`toYear` (inclusive) and `skipShouldRunNow:
 *   true` to iterate per-year per-competition.
 *
 * @returns Per-(competition, year) results for backfill observability. The
 * cron handler ignores the return value.
 */
export async function sync(
  env: Env,
  competitions: readonly CompetitionCode[],
  options?: SyncOptions,
): Promise<BackfillResult[]> {
  const now = new Date();
  if (!options?.skipShouldRunNow && !(await shouldRunNow(now, env))) return [];

  // Cron ticks and admin syncs previously had no mutual exclusion —
  // overlapping runs double-fetched upstream data and interleaved PAV
  // recalcs (COR-11). A stale lease (holder crashed) expires after 10 min.
  const holder = crypto.randomUUID();
  if (!(await acquireSyncLease(env, holder))) {
    await logSync(env, "sync:lease", 0, "skipped: another sync holds the lease");
    return [];
  }

  try {
    const seasons: number[] =
      options?.fromYear !== undefined && options.toYear !== undefined
        ? rangeInclusive(options.fromYear, options.toYear)
        : [now.getUTCFullYear()];

    const results: BackfillResult[] = [];
    for (const competition of competitions) {
      for (const season of seasons) {
        results.push(await syncCompetition(env, competition, season, options?.skipPav ?? false));
      }
    }

    // sync_log grew unboundedly (OPT-03); 90 days comfortably covers any
    // debugging horizon while keeping the table tiny.
    await env.DB.prepare("DELETE FROM sync_log WHERE timestamp < datetime('now', '-90 days')")
      .run()
      .catch(() => undefined);

    return results;
  } finally {
    await releaseSyncLease(env, holder);
  }
}

async function acquireSyncLease(env: Env, holder: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE sync_lease SET holder = ?1, acquired_at = datetime('now')
     WHERE id = 1 AND (holder IS NULL OR acquired_at < datetime('now', '-10 minutes'))`,
  )
    .bind(holder)
    .run();
  return result.meta.changes === 1;
}

async function releaseSyncLease(env: Env, holder: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE sync_lease SET holder = NULL, acquired_at = NULL WHERE id = 1 AND holder = ?1",
  )
    .bind(holder)
    .run();
}

/**
 * Cadence gate. Always runs at the top of the hour. Otherwise runs only when
 * a match is scheduled within ±a few days (date-granular: ~`BACKWARD_DAYS`
 * past + `FORWARD_DAYS` future). The forward window is wide enough to catch
 * Thursday-evening lineup releases for the upcoming weekend; the backward
 * window keeps polling through games that have just finished.
 */
export async function shouldRunNow(now: Date, env: Env): Promise<boolean> {
  if (now.getUTCMinutes() === 0) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  const from = toIsoDate(new Date(now.getTime() - BACKWARD_DAYS * dayMs));
  const to = toIsoDate(new Date(now.getTime() + FORWARD_DAYS * dayMs));
  const row = await env.DB.prepare("SELECT 1 FROM matches WHERE date BETWEEN ?1 AND ?2 LIMIT 1")
    .bind(from, to)
    .first();
  return row !== null;
}

async function syncCompetition(
  env: Env,
  competition: CompetitionCode,
  season: number,
  skipPav: boolean,
): Promise<BackfillResult> {
  try {
    const matchResult = await fetchMatches({ source: SOURCE, season, competition });
    if (!matchResult.success) {
      const error = `fetchMatches failed: ${describeError(matchResult.error)}`;
      await logSync(env, `sync:${competition}`, 0, error);
      return { competition, year: season, matches: 0, stats: 0, lineups: 0, error };
    }
    const allMatches = matchResult.data;

    const competitionId = await ensureCompetition(env, competition);
    const seasonId = await ensureSeason(env, competitionId, season);

    const apiCompletedCount = countCompleted(allMatches);
    const [dbCompletedCount, hasStatsBacklog, nextRound, lineupBacklogRounds] = await Promise.all([
      selectCompletedCount(env, seasonId),
      selectHasCompletedMatchWithoutStats(env, seasonId),
      selectNextRound(env, seasonId),
      // Look back up to 3 completed rounds for any that have no lineups yet,
      // so the lineup fetch self-heals after a missed release window.
      selectCompletedRoundsWithoutLineups(env, seasonId, 3),
    ]);
    // Fetch stats when the API has more completed matches than we've recorded,
    // OR when any previously-completed match still lacks stats (self-heals same-day
    // multi-match completions and recovers from partial write failures).
    const shouldFetchStats = apiCompletedCount > dbCompletedCount || hasStatsBacklog;

    const lineupRounds = new Set<number>(lineupBacklogRounds);
    if (nextRound !== null) {
      // Once the upcoming round has lineups stored, refresh on a 15-minute
      // cadence instead of every 5-minute tick (OPT-03): a 3x cut in
      // upstream lineup calls while still catching late team changes
      // within 15 minutes. First acquisition never waits for the cadence.
      const hasAny = await selectRoundHasAnyLineups(env, seasonId, nextRound);
      const onCadence = new Date().getUTCMinutes() % 15 < 5;
      if (!hasAny || onCadence) lineupRounds.add(nextRound);
    }

    const [lineupBatches, stats] = await Promise.all([
      Promise.all(
        Array.from(lineupRounds).map((r) => fetchLineupsSafe(env, competition, season, r)),
      ),
      shouldFetchStats ? fetchPlayerStatsSafe(env, competition, season) : [],
    ]);
    const lineups = lineupBatches.flat();

    if (allMatches.length === 0 && lineups.length === 0) {
      return { competition, year: season, matches: 0, stats: 0, lineups: 0 };
    }

    const teamMap = await ensureTeams(env, competitionId, competition, allMatches);
    const venueMap = await ensureVenues(env, allMatches);
    const playerMap = await upsertPlayers(env, unionPlayers(stats, lineups));

    const matchesAffected = await upsertMatches(env, allMatches, {
      seasonId,
      teamMap,
      venueMap,
    });
    if (matchesAffected > 0) {
      await updateSeasonCompleteness(env, seasonId);
    }
    const matchMap = await buildMatchAflIdMap(env, seasonId);

    let statsAffected = 0;
    let lineupsAffected = 0;
    if (stats.length > 0) {
      statsAffected = await upsertStats(env, stats, matchMap, playerMap, teamMap);
    }
    if (lineups.length > 0) {
      lineupsAffected = await upsertLineups(env, lineups, matchMap, playerMap, teamMap);
    }
    if (statsAffected > 0 && !skipPav && PAV_COMPETITIONS.has(competition)) {
      await recalculatePav(env, competition as PavCompetition, season);
    }

    const didWork = statsAffected > 0 || lineupsAffected > 0;
    if (didWork) {
      await logSync(env, `sync:${competition}`, matchesAffected + statsAffected + lineupsAffected);
    }

    return {
      competition,
      year: season,
      matches: matchesAffected,
      stats: statsAffected,
      lineups: lineupsAffected,
    };
  } catch (err) {
    const error = describeError(err);
    await logSync(env, `sync:${competition}`, 0, error);
    return { competition, year: season, matches: 0, stats: 0, lineups: 0, error };
  }
}

function countCompleted(matches: readonly Match[]): number {
  let n = 0;
  for (const m of matches) if (m.homePoints !== null) n++;
  return n;
}

function rangeInclusive(from: number, to: number): number[] {
  const out: number[] = [];
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  for (let y = lo; y <= hi; y++) out.push(y);
  return out;
}

async function fetchLineupsSafe(
  env: Env,
  competition: CompetitionCode,
  season: number,
  round: number,
) {
  const result = await fetchLineup({ source: SOURCE, season, round, competition });
  if (!result.success) {
    await logSync(
      env,
      `sync:${competition}:lineups`,
      0,
      `fetchLineup failed: ${describeError(result.error)}`,
    );
    return [];
  }
  return result.data;
}

async function fetchPlayerStatsSafe(env: Env, competition: CompetitionCode, season: number) {
  const result = await fetchPlayerStats({ source: SOURCE, season, competition });
  if (!result.success) {
    await logSync(
      env,
      `sync:${competition}:stats`,
      0,
      `fetchPlayerStats failed: ${describeError(result.error)}`,
    );
    return [];
  }
  // fitzroy v3 returns a partial-result envelope; failed games are worth a
  // sync_log row but must not block the games that did parse.
  if (result.data.failedMatchIds.length > 0) {
    await logSync(
      env,
      `sync:${competition}:stats`,
      0,
      `partial season stats: ${result.data.failedMatchIds.length} game(s) failed (${result.data.failedMatchIds.join(", ")})`,
    );
  }
  return result.data.stats;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
