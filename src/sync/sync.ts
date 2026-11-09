import { Schema } from "effect";
import type { CompetitionCode, SeasonSelector } from "fitzroy";
import {
  fetchLineup,
  fetchMatches,
  fetchSeasons,
  resolveDefaultSeasonForCompetition,
} from "fitzroy";
import { refreshActiveCoaches } from "../admin/coaching";
import { runOperation } from "../db/operation";
import { seasonKey } from "../db/seasons";
import { describeError, logError, type MessageFields, type TaggedErrorBase } from "../lib/errors";
import { runFitzroy } from "../lib/fitzroy";
import { playedMatch, unsettledMatch } from "../lib/match-state";
import { toSeasonSelector } from "../lib/schemas";
import { toIsoDate } from "../lib/time";
import type { Env } from "../types";
import { runWeatherStage } from "../weather/stage";
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
  /** Backfills only: matches still queued for statistics. Repeat the backfill until zero. */
  readonly statsPending?: number;
  readonly lineups: number;
  readonly error?: string;
}

const SyncSourceErrorBase: TaggedErrorBase<SyncSourceError, "SyncSourceError", MessageFields> =
  Schema.TaggedError<SyncSourceError>()("SyncSourceError", {
    message: Schema.String,
  });

/**
 * The provider's season data cannot be imported as delivered.
 *
 * The message is application-written and lands in `sync_log`.
 *
 * @example
 * throw new SyncSourceError({ message: "Provider season inventory contains duplicate match IDs" });
 */
export class SyncSourceError extends SyncSourceErrorBase {}

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
  /** The tick's instant. The cron passes its scheduled time; defaults to the current time. */
  readonly now?: Date;
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
  const now = options?.now ?? new Date();
  if (!options?.skipShouldRunNow && !(await shouldRunNow(now, env))) return [];
  const isBackfill =
    options?.season !== undefined ||
    (options?.fromYear !== undefined && options.toYear !== undefined);
  const fixturesOnly = options?.fixturesOnly ?? false;
  const hourly = !isBackfill && isHourlyTick(now);

  // Cron ticks and admin syncs share one lease, so overlapping runs cannot
  // double-fetch upstream data or interleave PAV recalcs (COR-11).
  const skipped = async (): Promise<BackfillResult[]> => {
    await logSync(env, "sync:lease", 0, "skipped: another sync holds the lease");
    return [];
  };
  return runOperation(env, skipped, async (operation) => {
    const scopes: SyncScope[] = [];
    let coachingSeason: number | null = null;
    for (const competition of competitions) {
      if (options?.season !== undefined) scopes.push({ competition, season: options.season });
      else if (options?.fromYear !== undefined && options.toYear !== undefined)
        for (const season of rangeInclusive(options.fromYear, options.toYear))
          scopes.push({ competition, season });
      else {
        const steady = await steadySeasons(env, competition, hourly);
        if (competition === "AFLM") coachingSeason = seasonYear(steady.current);
        scopes.push({ competition, season: steady.current });
        for (const season of steady.upcoming) scopes.push({ competition, season, upcoming: true });
      }
    }
    for (const scope of scopes) seasonKey(scope.competition, scope.season);
    const identity = syncIdentity(competitions, isBackfill ? scopes : null, fixturesOnly);
    // A run that dies mid-write (e.g. a D1 connection drop) keeps the marker so
    // readers never see partial inputs. A steady-state run is idempotent and
    // finishes all derived work, so it resumes a stranded steady-state write
    // instead of failing every tick until an operator steps in. Markers from
    // any other operation still require explicit recovery.
    const stranded = options?.resume || isBackfill ? null : await operation.stranded(identity);
    const writer = await operation.write(identity, {
      resume: options?.resume === true || stranded !== null,
      startedAt: now,
    });
    if (stranded !== null)
      await logSync(
        env,
        "sync:recovered",
        0,
        `resumed write left by ${stranded.holder ?? "unknown holder"} since ${stranded.startedAt ?? "unknown time"}`,
      );
    const results: BackfillResult[] = [];
    for (const scope of scopes)
      results.push(await syncCompetition(writer, scope, isBackfill, fixturesOnly));

    if (!isBackfill) await queueRecentStatsRefresh(writer, now);
    if (hourly) {
      const refresh = await refreshDueStats(writer, now);
      await logSync(
        env,
        "sync:stats-refresh",
        refresh.changedRows,
        refresh.failed ? `${refresh.failed} match fetches failed; retries persisted` : undefined,
      );
      // Coach profiles are expensive season-wide reads; the import module
      // enforces its own retry cadence.
      if (coachingSeason !== null) await refreshActiveCoaches(writer, now, coachingSeason);
    }

    // Weather rides the same lease as match data but only on hourly ticks, so
    // the 5-minute cron adds no wasted Open-Meteo calls (#138). Provider
    // failures retry; database failures retain the marker.
    if (!fixturesOnly && isHourlyTick(now)) await runWeatherStage(writer, fetch, now);

    // sync_log grew unboundedly (OPT-03); 90 days comfortably covers any
    // debugging horizon while keeping the table tiny.
    // The purge is best-effort, but a failure must stay visible.
    await env.DB.prepare("DELETE FROM sync_log WHERE timestamp < datetime('now', '-90 days')")
      .run()
      .catch((error) => {
        logError("sync_log_purge_failed", error);
      });

    // Fixture score/status changes also invalidate PAV on five-minute ticks.
    await rebuildQueuedStatsPav(writer, undefined, operation.holder);
    return results;
  });
}

/** One competition-season a sync covers. */
interface SyncScope {
  readonly competition: CompetitionCode;
  readonly season: SeasonSelector;
  /** A season that has not started yet, synced ahead of its first match. */
  readonly upcoming?: boolean;
}

function seasonYear(season: SeasonSelector): number {
  return Number(String(season).slice(0, 4));
}

/**
 * The seasons a steady-state sync covers for one competition.
 *
 * `current` is the latest season that has started. The provider only reports
 * a season as current from its first bounce, so syncing it alone would load a
 * new season's fixture after its opening match began: no lineup snapshot, no
 * forecast and no fixture row beforehand. `upcoming` closes that gap with
 * every later season. Discovery asks the provider on hourly ticks; in
 * between, a later season already stored with unsettled matches stays in
 * scope, so its lineups keep the five-minute cadence.
 *
 * If the provider cannot name the current season (a newly listed season
 * without round dates fails the whole resolution), the latest stored season
 * that has started stands in, so one undated season cannot halt every sync.
 *
 * @param env - Worker bindings.
 * @param competition - Competition to resolve.
 * @param hourly - Whether this tick may ask the provider for new seasons.
 * @returns The current season and any seasons after it.
 * @throws The provider's error when no stored season can stand in.
 */
async function steadySeasons(
  env: Env,
  competition: CompetitionCode,
  hourly: boolean,
): Promise<{ readonly current: SeasonSelector; readonly upcoming: readonly SeasonSelector[] }> {
  const resolved = await runFitzroy(resolveDefaultSeasonForCompetition(competition));
  let current: SeasonSelector;
  if (resolved.success) current = resolved.data;
  else {
    const stored = await env.DB.prepare(
      `SELECT s.season_key FROM seasons s JOIN competitions c ON c.id = s.competition_id
       WHERE c.code = ?1 AND EXISTS (
         SELECT 1 FROM matches m WHERE m.season_id = s.id AND m.date <= date('now'))
       ORDER BY s.year DESC, s.season_key DESC LIMIT 1`,
    )
      .bind(competition)
      .first<string>("season_key");
    if (stored === null) throw resolved.error;
    await logSync(
      env,
      "sync:season-fallback",
      0,
      `${competition}: ${describeError(resolved.error)}; using stored season ${stored}`,
    );
    current = toSeasonSelector(stored);
  }
  const year = seasonYear(current);
  const later = await env.DB.prepare(
    `SELECT s.season_key FROM seasons s JOIN competitions c ON c.id = s.competition_id
     WHERE c.code = ?1 AND s.year > ?2 AND EXISTS (
       SELECT 1 FROM matches m WHERE m.season_id = s.id AND ${unsettledMatch("m")})
     ORDER BY s.year, s.season_key`,
  )
    .bind(competition, year)
    .all<{ season_key: string }>();
  const upcoming = new Set(later.results.map((row) => row.season_key));
  if (hourly) {
    // A discovery failure is not fatal here: syncing the current season makes
    // the same call and reports it.
    const discovered = await runFitzroy(fetchSeasons(competition));
    if (discovered.success)
      for (const entry of discovered.data) if (entry.year > year) upcoming.add(entry.seasonKey);
  }
  return { current, upcoming: [...upcoming].sort().map((key) => toSeasonSelector(key)) };
}

/**
 * Whether a tick carries the hourly stages (statistics refresh, coaching,
 * weather). Callers pass the tick's scheduled time, so a late start still
 * counts for the hour it was scheduled in.
 *
 * @param now - The tick's scheduled instant.
 * @returns True at the top of the hour.
 */
export function isHourlyTick(now: Date): boolean {
  return now.getUTCMinutes() === 0;
}

/**
 * The persisted identity a sync writes under, matched exactly on recovery.
 *
 * A steady-state sync is named by its competitions alone. Naming the resolved
 * seasons would stop the cron recovering its own stranded write whenever a
 * competition's default season rolls over in between. A backfill is named by
 * its exact scopes, because resuming it must repeat the same reviewed work.
 *
 * @param competitions - Competitions in this sync.
 * @param scopes - Exact competition-seasons of a backfill, or null in steady state.
 * @param fixturesOnly - Whether player appearances are skipped.
 * @returns The `write_operation` value.
 */
export function syncIdentity(
  competitions: readonly CompetitionCode[],
  scopes: readonly { competition: CompetitionCode; season: SeasonSelector }[] | null,
  fixturesOnly: boolean,
): string {
  const kind = fixturesOnly ? "sync:fixtures:" : "sync:";
  return scopes === null
    ? `${kind}steady:${competitions.join(",")}`
    : `${kind}${JSON.stringify(scopes)}`;
}

/**
 * Cadence gate. Always runs at the top of the hour. Otherwise runs only when
 * a match is scheduled within ±a few days (date-granular: ~`BACKWARD_DAYS`
 * past + `FORWARD_DAYS` future). The forward window is wide enough to catch
 * Thursday-evening lineup releases for the upcoming weekend; the backward
 * window keeps polling through games that have just finished.
 */
export async function shouldRunNow(now: Date, env: Env): Promise<boolean> {
  if (isHourlyTick(now)) return true;
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
  { competition, season, upcoming = false }: SyncScope,
  isBackfill: boolean,
  fixturesOnly = false,
): Promise<BackfillResult> {
  try {
    const discovered = await runFitzroy(fetchSeasons(competition));
    if (!discovered.success) throw discovered.error;
    const identity = discovered.data.find((entry) => entry.seasonKey === String(season));
    if (!identity)
      throw new SyncSourceError({
        message: `No exact ${competition} season ${season}; use season discovery`,
      });
    const matchResult = await runFitzroy(fetchMatches({ source: SOURCE, season, competition }));
    if (!matchResult.success) {
      const error = `fetchMatches failed: ${describeError(matchResult.error)}`;
      // A season that has not started may have no usable fixture yet. That is
      // not a failure of the competition's sync and must not page.
      await logSync(
        env,
        upcoming ? `sync:${competition}:upcoming` : `sync:${competition}`,
        0,
        error,
      );
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
      throw new SyncSourceError({
        message: "Provider season inventory contains duplicate match IDs",
      });
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
    let statsPending: number | null = null;
    if (isBackfill && !fixturesOnly) {
      await env.DB.prepare(`INSERT INTO match_stats_refresh(match_id, completed_observed_at, next_retry_at)
        SELECT m.id, ?1, ?1 FROM matches m WHERE m.season_id = ?2 AND ${playedMatch("m")} AND m.external_afl_id IS NOT NULL
        ON CONFLICT(match_id) DO NOTHING`)
        .bind(new Date().toISOString(), seasonId)
        .run();
      statsAffected = (await refreshDueStats(env, new Date(), undefined, seasonId)).changedRows;
      // One pass fetches a bounded batch, so say how much of the season is left.
      statsPending = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM match_stats_refresh r JOIN matches m ON m.id = r.match_id
         WHERE m.season_id = ?1 AND r.next_retry_at IS NOT NULL`,
      )
        .bind(seasonId)
        .first<number>("n");
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
      ...(statsPending !== null && { statsPending }),
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
  const result = await runFitzroy(fetchLineup({ source: SOURCE, season, round, competition }));
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
