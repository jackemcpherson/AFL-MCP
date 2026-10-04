import type { CompetitionCode, SeasonSelector } from "fitzroy";
import {
  fetchLineup,
  fetchMatches,
  fetchSeasons,
  resolveDefaultSeasonForCompetition,
} from "fitzroy";
import { refreshActiveCoaches } from "../admin/coaching";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { seasonKey } from "../db/seasons";
import { toIsoDate } from "../lib/time";
import type { Env } from "../types";
import { runWeatherStage } from "../weather/stage";
import { acquireOperationLease, releaseOperationLease } from "./lease";
import { logSync } from "./log";
import { correctVerifiedMatch } from "./source-corrections";
import { queueRecentStatsRefresh, rebuildQueuedStatsPav, refreshDueStats } from "./stats-refresh";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  ensureSeason,
  ensureTeams,
  ensureVenues,
  quarantinePlaceholderMatches,
  selectCompletedRoundsWithoutLineups,
  unionPlayers,
  updateSeasonCompleteness,
  upsertLineups,
  upsertMatches,
  upsertPlayers,
} from "./upserts";

const FORWARD_DAYS = 3;
const BACKWARD_DAYS = 1;
const SOURCE = "afl-api" as const;

/** Cron ticks retry lineup-less completed rounds this many days after the match; older gaps are backfill territory. */
const LINEUP_BACKLOG_MAX_AGE_DAYS = 14;
/** Cron ticks look back at most this many completed rounds for missing lineups. */
const LINEUP_BACKLOG_LIMIT = 3;
/** Admin backfills sweep a whole season's worth of lineup-less rounds. */
const BACKFILL_LINEUP_BACKLOG_LIMIT = 40;
/** Fetch the upcoming round's lineups only this close to its first match — rosters publish ~Thursday before the round, so earlier fetches are guaranteed 404s. */
const LINEUP_LOOKAHEAD_DAYS = 5;

/** Per-(competition, year) outcome from a single sync tick. */
export interface BackfillResult {
  readonly competition: CompetitionCode;
  readonly year: number;
  readonly seasonKey?: string;
  readonly matches: number;
  readonly stats: number;
  readonly lineups: number;
  readonly error?: string;
}

/** Optional knobs for the backfill / admin entry points. */
export interface SyncOptions {
  /** Correct fixture metadata without importing player appearances. */
  readonly fixturesOnly?: boolean;
  /** Explicitly recover the identical persisted sync scope. */
  readonly resume?: boolean;
  /** When provided alongside `toYear`, iterates seasons inclusively. */
  readonly fromYear?: number;
  /** Explicit competition-season selector for a bounded backfill. */
  readonly season?: SeasonSelector;
  /** Inclusive upper bound for the iteration. */
  readonly toYear?: number;
  /** Skip the cadence gate; for backfills triggered manually. */
  readonly skipShouldRunNow?: boolean;
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
  if (!(await acquireOperationLease(env, holder))) {
    await logSync(env, "sync:lease", 0, "skipped: another sync holds the lease");
    return [];
  }

  let consistent = false;
  try {
    const isBackfill =
      options?.season !== undefined ||
      (options?.fromYear !== undefined && options.toYear !== undefined);
    const scopes: { competition: CompetitionCode; season: SeasonSelector }[] = [];
    for (const competition of competitions) {
      const seasons: readonly SeasonSelector[] =
        options?.season !== undefined
          ? [options.season]
          : options?.fromYear !== undefined && options.toYear !== undefined
            ? rangeInclusive(options.fromYear, options.toYear)
            : [await resolveDefaultSeasonForCompetition(competition)];
      for (const season of seasons) {
        seasonKey(competition, season);
        scopes.push({ competition, season });
      }
    }
    const operation = `sync:${options?.fixturesOnly ? "fixtures:" : ""}${JSON.stringify(scopes)}`;
    if (options?.resume) await resumePublicInputWrite(env, holder, operation);
    else await beginPublicInputWrite(env, holder, now, operation);
    const writer = protectOperationWrites(env, holder);
    const results: BackfillResult[] = [];
    for (const { competition, season } of scopes)
      results.push(
        await syncCompetition(writer, competition, season, isBackfill, options?.fixturesOnly),
      );

    if (!isBackfill) await queueRecentStatsRefresh(writer, now);
    if (!isBackfill && now.getUTCMinutes() === 0) {
      const refresh = await refreshDueStats(writer, now);
      await logSync(
        env,
        "sync:stats-refresh",
        refresh.changedRows,
        refresh.failed ? `${refresh.failed} match fetches failed; retries persisted` : undefined,
      );
    }

    // Coach profiles are expensive season-wide reads. Refresh only in the
    // hourly path, with the import module enforcing a 24-hour retry cadence.
    if (!isBackfill && now.getUTCMinutes() === 0 && competitions.includes("AFLM")) {
      await refreshActiveCoaches(writer, now);
    }

    // Weather rides the same lease as match data but self-gates to
    // top-of-hour passes so the 5-minute cron adds no wasted Open-Meteo
    // calls (#138). Provider failures retry; database failures retain the marker.
    if (!options?.fixturesOnly && now.getUTCMinutes() === 0) {
      await runWeatherStage(writer, fetch, now);
    }

    // sync_log grew unboundedly (OPT-03); 90 days comfortably covers any
    // debugging horizon while keeping the table tiny.
    await env.DB.prepare("DELETE FROM sync_log WHERE timestamp < datetime('now', '-90 days')")
      .run()
      .catch(() => undefined);

    // Fixture score/status changes also invalidate PAV on five-minute ticks.
    await rebuildQueuedStatsPav(writer, undefined, holder);
    consistent = true;
    return results;
  } finally {
    try {
      if (consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
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
  season: SeasonSelector,
  isBackfill: boolean,
  fixturesOnly = false,
): Promise<BackfillResult> {
  try {
    const discovered = await fetchSeasons(competition);
    if (!discovered.success) throw discovered.error;
    const identity = discovered.data.find((entry) => entry.seasonKey === String(season));
    if (!identity)
      throw new Error(`No exact ${competition} season ${season}; use season discovery`);
    const matchResult = await fetchMatches({ source: SOURCE, season, competition });
    if (!matchResult.success) {
      const error = `fetchMatches failed: ${describeError(matchResult.error)}`;
      await logSync(env, `sync:${competition}`, 0, error);
      return {
        competition,
        year: Number(String(season).slice(0, 4)),
        seasonKey: String(season),
        matches: 0,
        stats: 0,
        lineups: 0,
        error,
      };
    }
    const providerMatches = matchResult.data;
    const allMatches = providerMatches.map(correctVerifiedMatch);

    const competitionId = await ensureCompetition(env, competition);
    const seasonId = await ensureSeason(env, competitionId, season);
    await env.DB.batch([
      env.DB.prepare("UPDATE seasons SET display_name = ?1 WHERE id = ?2").bind(
        identity.displayName,
        seasonId,
      ),
      env.DB.prepare(
        "INSERT INTO season_provider_ids(season_id, provider, provider_season_id) VALUES (?1, 'afl-api', ?2) ON CONFLICT(season_id, provider) DO UPDATE SET provider_season_id = excluded.provider_season_id",
      ).bind(seasonId, String(identity.providerSeasonId)),
    ]);

    if (new Set(allMatches.map((match) => match.matchId)).size !== allMatches.length) {
      throw new Error("Provider season inventory contains duplicate match IDs");
    }
    await env.DB.prepare(`INSERT INTO season_provider_inventory(season_id, provider, observed_at, matches_json)
      VALUES (?1, 'afl-api', ?2, ?3) ON CONFLICT(season_id, provider) DO UPDATE SET
      observed_at = excluded.observed_at, matches_json = excluded.matches_json`)
      .bind(
        seasonId,
        new Date().toISOString(),
        JSON.stringify(
          providerMatches.map((match) => ({
            matchId: match.matchId,
            homeTeam: match.homeTeam,
            awayTeam: match.awayTeam,
            date: Number.isFinite(match.date.getTime()) ? match.date.toISOString() : null,
            status: match.status,
            homePoints: match.homePoints,
            awayPoints: match.awayPoints,
          })),
        ),
      )
      .run();

    const lineupBacklogRounds = fixturesOnly
      ? []
      : await selectCompletedRoundsWithoutLineups(
          env,
          seasonId,
          isBackfill ? BACKFILL_LINEUP_BACKLOG_LIMIT : LINEUP_BACKLOG_LIMIT,
          isBackfill ? null : LINEUP_BACKLOG_MAX_AGE_DAYS,
        );

    const lineupRounds = new Set<number>(lineupBacklogRounds);
    const locked =
      await env.DB.prepare(`SELECT m.external_afl_id FROM matches m JOIN tipper_predictions p ON p.match_id=m.id
      WHERE m.season_id=? AND p.run_id=(SELECT MAX(q.run_id) FROM tipper_predictions q WHERE q.match_id=m.id)
      AND julianday(p.kickoff_at)<=julianday('now')`)
        .bind(seasonId)
        .all<{ external_afl_id: string }>();
    const lockedIds = new Set(locked.results.map((m) => m.external_afl_id));
    const now = Date.now();
    for (const match of allMatches) {
      const remaining = match.date.getTime() - now;
      if (
        fixturesOnly ||
        lockedIds.has(match.matchId) ||
        match.status !== "Upcoming" ||
        remaining <= 0 ||
        remaining > LINEUP_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000
      )
        continue;
      // Include later fixtures in rounds already underway. Every five-minute tick
      // refreshes the last 90 minutes; earlier snapshots refresh each 15 minutes.
      if (remaining <= 90 * 60 * 1000 || new Date(now).getUTCMinutes() % 15 < 5)
        lineupRounds.add(match.roundNumber);
    }

    const lineupBatches = await Promise.all(
      Array.from(lineupRounds).map((r) => fetchLineupsSafe(env, competition, season, r)),
    );
    const lineups = lineupBatches.flat();

    if (allMatches.length === 0 && lineups.length === 0) {
      return {
        competition,
        year: Number(String(season).slice(0, 4)),
        seasonKey: String(season),
        matches: 0,
        stats: 0,
        lineups: 0,
      };
    }

    // Unresolved finals fixtures ("1st" vs "4th") must not become team or
    // match rows — see quarantinePlaceholderMatches.
    const syncableMatches = await quarantinePlaceholderMatches(
      env,
      competitionId,
      competition,
      allMatches,
    );
    const teamMap = await ensureTeams(env, competitionId, competition, syncableMatches);
    const venueMap = await ensureVenues(env, syncableMatches);
    const playerMap = await upsertPlayers(env, unionPlayers([], lineups));

    const matchesAffected = await upsertMatches(env, syncableMatches, {
      seasonId,
      teamMap,
      venueMap,
    });
    if (matchesAffected > 0) {
      await updateSeasonCompleteness(env, seasonId);
    }
    const matchMap = await buildMatchAflIdMap(env, seasonId);

    let statsAffected = 0;
    if (isBackfill && !fixturesOnly) {
      await env.DB.prepare(`INSERT INTO match_stats_refresh(match_id, completed_observed_at, next_retry_at)
        SELECT id, ?1, ?1 FROM matches WHERE season_id = ?2 AND status = 'Complete' AND external_afl_id IS NOT NULL
        ON CONFLICT(match_id) DO NOTHING`)
        .bind(new Date().toISOString(), seasonId)
        .run();
      statsAffected = (await refreshDueStats(env, new Date(), undefined, seasonId)).changedRows;
    }
    let lineupsAffected = 0;
    if (lineups.length > 0) {
      lineupsAffected = await upsertLineups(env, lineups, matchMap, playerMap, teamMap);
    }
    const didWork = statsAffected > 0 || lineupsAffected > 0;
    if (didWork) {
      await logSync(env, `sync:${competition}`, matchesAffected + statsAffected + lineupsAffected);
    }

    return {
      competition,
      year: Number(String(season).slice(0, 4)),
      seasonKey: String(season),
      matches: matchesAffected,
      stats: statsAffected,
      lineups: lineupsAffected,
    };
  } catch (err) {
    const error = describeError(err);
    await logSync(env, `sync:${competition}`, 0, error);
    throw err;
  }
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
  season: SeasonSelector,
  round: number,
) {
  const result = await fetchLineup({ source: SOURCE, season, round, competition });
  if (!result.success) {
    const message = describeError(result.error);
    // A 404 means the roster is not published yet (or never will be for
    // this round) — the expected pre-release state, not an error worth a
    // sync_log row. Real failures (5xx, timeouts, parse errors) still log.
    if (!message.includes("404")) {
      await logSync(env, `sync:${competition}:lineups`, 0, `fetchLineup failed: ${message}`);
    }
    return [];
  }
  return result.data;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
