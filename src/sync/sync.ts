import { Schema } from "effect";
import type { CompetitionCode, CompetitionSeason, Match, SeasonSelector } from "fitzroy";
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
import { type FitzroyOutcome, runFitzroy } from "../lib/fitzroy";
import { playedMatch, unsettledMatch } from "../lib/match-state";
import { toSeasonSelector } from "../lib/schemas";
import { toIsoDate, toMelbourneDate } from "../lib/time";
import type { Env } from "../types";
import { runWeatherStage } from "../weather/stage";
import { logSync } from "./log";
import { correctVerifiedMatch } from "./source-corrections";
import { queueRecentStatsRefresh, rebuildQueuedStatsPav, refreshDueStats } from "./stats-refresh";
import {
  buildMatchAflIdMap,
  ensureCompetition,
  lineupSyncSupported,
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
const DAY_MS = 24 * 60 * 60 * 1000;
/** `sync_log` rows older than this are purged on hourly ticks. */
const SYNC_LOG_RETENTION_DAYS = 90;

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
 * The provider's season data cannot be fetched or imported as delivered.
 *
 * The message is application-written and lands in `sync_log`. The sync logs
 * it and moves on to the next competition-season; database errors still
 * propagate.
 *
 * @example
 * throw new SyncSourceError({ message: "Provider season inventory contains duplicate match IDs" });
 */
class SyncSourceError extends SyncSourceErrorBase {}

/** One competition's season discovery, fetched once per sync pass. */
type SeasonDiscovery = FitzroyOutcome<readonly CompetitionSeason[]>;

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
 * - Steady-state: pass `competitions` only; the current and upcoming seasons
 *   (`steadySeasons`) sync subject to the `shouldRunNow` cadence gate.
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
    // Every scope of a competition shares one season discovery per pass.
    const discoveries = new Map<CompetitionCode, SeasonDiscovery>();
    for (const competition of competitions) {
      const discovery: SeasonDiscovery = await runFitzroy(fetchSeasons(competition));
      discoveries.set(competition, discovery);
      if (options?.season !== undefined) scopes.push({ competition, season: options.season });
      else if (options?.fromYear !== undefined && options.toYear !== undefined)
        for (const season of rangeInclusive(options.fromYear, options.toYear))
          scopes.push({ competition, season });
      else {
        const steady = await steadySeasons(env, competition, hourly ? discovery : null, now);
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
    for (const scope of scopes) {
      const discovery = discoveries.get(scope.competition);
      if (discovery === undefined) throw new Error(`No season discovery for ${scope.competition}`);
      results.push(
        await syncCompetition(writer, scope, discovery, now, { isBackfill, fixturesOnly }),
      );
    }

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
    if (!fixturesOnly && hourly) await runWeatherStage(writer, fetch, now);

    // sync_log grew unboundedly (OPT-03); 90 days comfortably covers any
    // debugging horizon while keeping the table tiny. Once an hour is enough.
    // The purge is best-effort, but a failure must stay visible.
    if (hourly)
      await env.DB.prepare("DELETE FROM sync_log WHERE timestamp < ?1")
        .bind(new Date(now.getTime() - SYNC_LOG_RETENTION_DAYS * DAY_MS).toISOString())
        .run()
        .catch((error) => {
          logError("sync_log_purge_failed", error);
        });

    // Fixture score/status changes also invalidate PAV on five-minute ticks.
    // An hourly tick already drained the queue inside refreshDueStats, after
    // every fixture write; nothing since then queues PAV.
    if (!hourly) await rebuildQueuedStatsPav(writer, undefined, operation.holder);
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
 * Stored match dates are Melbourne-local calendar dates, so "has started"
 * compares against the tick's Melbourne date.
 *
 * @param env - Worker bindings.
 * @param competition - Competition to resolve.
 * @param discovery - This pass's season discovery on hourly ticks, or null
 *   when this tick must not add newly listed seasons.
 * @param now - The tick's instant.
 * @returns The current season and any seasons after it.
 * @throws The provider's error when no stored season can stand in.
 */
async function steadySeasons(
  env: Env,
  competition: CompetitionCode,
  discovery: SeasonDiscovery | null,
  now: Date,
): Promise<{ readonly current: SeasonSelector; readonly upcoming: readonly SeasonSelector[] }> {
  const resolved = await runFitzroy(resolveDefaultSeasonForCompetition(competition));
  let current: SeasonSelector;
  if (resolved.success) current = resolved.data;
  else {
    const stored = await env.DB.prepare(
      `SELECT s.season_key FROM seasons s JOIN competitions c ON c.id = s.competition_id
       WHERE c.code = ?1 AND EXISTS (
         SELECT 1 FROM matches m WHERE m.season_id = s.id AND m.date <= ?2)
       ORDER BY s.year DESC, s.season_key DESC LIMIT 1`,
    )
      .bind(competition, toMelbourneDate(now))
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
  // A discovery failure is not fatal here: syncing the current season reports it.
  if (discovery?.success)
    for (const entry of discovery.data) if (entry.year > year) upcoming.add(entry.seasonKey);
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
 *
 * `matches.date` is the Melbourne-local calendar date. The window bounds are
 * UTC dates, which the day of slack on each side absorbs.
 *
 * @param now - The tick's scheduled instant.
 * @param env - Worker bindings.
 * @returns Whether this tick should sync.
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

/** How {@link syncCompetition} runs one scope. */
interface ScopeMode {
  readonly isBackfill: boolean;
  readonly fixturesOnly: boolean;
}

/** One competition-season as the provider delivered it. */
interface ProviderSeason {
  readonly identity: CompetitionSeason;
  readonly providerMatches: readonly Match[];
  readonly matches: readonly Match[];
}

/**
 * Fetch and validate one competition-season from the provider, before any
 * database write.
 *
 * @param scope - The competition-season.
 * @param discovery - This pass's season discovery for the competition.
 * @returns The season's identity, raw fixtures and reviewed fixtures.
 * @throws SyncSourceError for every provider or source-data failure.
 */
async function loadProviderSeason(
  { competition, season }: SyncScope,
  discovery: SeasonDiscovery,
): Promise<ProviderSeason> {
  if (!discovery.success)
    throw new SyncSourceError({
      message: `fetchSeasons failed: ${describeError(discovery.error)}`,
    });
  const identity = discovery.data.find((entry) => entry.seasonKey === String(season));
  if (!identity)
    throw new SyncSourceError({
      message: `No exact ${competition} season ${season}; use season discovery`,
    });
  const matchResult = await runFitzroy(fetchMatches({ source: SOURCE, season, competition }));
  if (!matchResult.success)
    throw new SyncSourceError({
      message: `fetchMatches failed: ${describeError(matchResult.error)}`,
    });
  const providerMatches = matchResult.data;
  if (new Set(providerMatches.map((match) => match.matchId)).size !== providerMatches.length)
    throw new SyncSourceError({
      message: "Provider season inventory contains duplicate match IDs",
    });
  let matches: readonly Match[];
  try {
    matches = providerMatches.map(correctVerifiedMatch);
  } catch (error) {
    throw new SyncSourceError({ message: describeError(error) });
  }
  return { identity, providerMatches, matches };
}

/**
 * Whether the latest `sync_log` row of this type recorded an error.
 *
 * @param env - Worker bindings.
 * @param type - The `sync_log` type.
 * @returns True when the most recent row has a non-null error.
 */
async function lastSyncFailed(env: Env, type: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT error FROM sync_log WHERE type = ?1 ORDER BY timestamp DESC, id DESC LIMIT 1",
  )
    .bind(type)
    .first<{ error: string | null }>();
  return row !== null && row.error !== null;
}

/**
 * Sync one competition-season.
 *
 * Provider and source-data failures log under `sync:<competition>` (or
 * `sync:<competition>:upcoming` for a season that has not started) and
 * return an error result, so the remaining scopes still sync. Database and
 * lease failures log under `sync:<competition>` and propagate, retaining
 * the write marker.
 *
 * A pass that changed statistics or lineups logs a success row, under
 * `sync:<competition>:upcoming` for a season that has not started. So does a
 * steady-state pass of the current season whose previous row was an error,
 * which lets health clear the failure; other no-op passes log nothing.
 *
 * @param env - Fenced writer bindings.
 * @param scope - The competition-season.
 * @param discovery - This pass's season discovery for the competition.
 * @param now - The tick's instant.
 * @param mode - Backfill and fixtures-only switches.
 * @returns The scope's outcome.
 * @throws Database and lease errors.
 */
async function syncCompetition(
  env: Env,
  scope: SyncScope,
  discovery: SeasonDiscovery,
  now: Date,
  { isBackfill, fixturesOnly }: ScopeMode,
): Promise<BackfillResult> {
  const { competition, season, upcoming = false } = scope;
  // A season that has not started logs apart from the competition, so it can
  // neither page health nor clear a current-season failure.
  const logType = upcoming ? `sync:${competition}:upcoming` : `sync:${competition}`;
  const outcome = {
    competition,
    year: seasonYear(season),
    seasonKey: String(season),
  };
  try {
    let provider: ProviderSeason;
    try {
      provider = await loadProviderSeason(scope, discovery);
    } catch (err) {
      if (!(err instanceof SyncSourceError)) throw err;
      // A season that has not started may have no usable fixture yet. That is
      // not a failure of the competition's sync and must not page.
      await logSync(env, logType, 0, err.message);
      return { ...outcome, matches: 0, stats: 0, lineups: 0, error: err.message };
    }
    const { identity, providerMatches, matches: allMatches } = provider;

    const competitionId = await ensureCompetition(env, competition);
    const seasonId = await ensureSeason(env, competitionId, season);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE seasons SET display_name = ?1 WHERE id = ?2 AND display_name IS NOT ?1",
      ).bind(identity.displayName, seasonId),
      env.DB.prepare(
        `INSERT INTO season_provider_ids(season_id, provider, provider_season_id) VALUES (?1, 'afl-api', ?2)
         ON CONFLICT(season_id, provider) DO UPDATE SET provider_season_id = excluded.provider_season_id
         WHERE season_provider_ids.provider_season_id IS NOT excluded.provider_season_id`,
      ).bind(seasonId, String(identity.providerSeasonId)),
    ]);

    // The snapshot is rewritten only when the provider's inventory changed, so
    // `observed_at` records when this inventory was first observed.
    await env.DB.prepare(`INSERT INTO season_provider_inventory(season_id, provider, observed_at, matches_json)
      VALUES (?1, 'afl-api', ?2, ?3) ON CONFLICT(season_id, provider) DO UPDATE SET
      observed_at = excluded.observed_at, matches_json = excluded.matches_json
      WHERE season_provider_inventory.matches_json IS NOT excluded.matches_json`)
      .bind(
        seasonId,
        now.toISOString(),
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

    // Seasons whose lineups upsertLineups would discard are not fetched.
    const fetchLineups =
      !fixturesOnly && lineupSyncSupported(competition, seasonKey(competition, season));
    const lineupBacklogRounds = fetchLineups
      ? await selectCompletedRoundsWithoutLineups(
          env,
          seasonId,
          isBackfill ? BACKFILL_LINEUP_BACKLOG_LIMIT : LINEUP_BACKLOG_LIMIT,
          isBackfill ? null : LINEUP_BACKLOG_MAX_AGE_DAYS,
          now,
        )
      : [];

    const lineupRounds = new Set<number>(lineupBacklogRounds);
    const locked =
      await env.DB.prepare(`SELECT m.external_afl_id FROM matches m JOIN tipper_predictions p ON p.match_id=m.id
      WHERE m.season_id=?1 AND p.run_id=(SELECT MAX(q.run_id) FROM tipper_predictions q WHERE q.match_id=m.id)
      AND julianday(p.kickoff_at)<=julianday(?2)`)
        .bind(seasonId, now.toISOString())
        .all<{ external_afl_id: string }>();
    const lockedIds = new Set(locked.results.map((m) => m.external_afl_id));
    const nowMs = now.getTime();
    for (const match of allMatches) {
      const remaining = match.date.getTime() - nowMs;
      if (
        !fetchLineups ||
        lockedIds.has(match.matchId) ||
        match.status !== "Upcoming" ||
        !Number.isFinite(remaining) ||
        remaining <= 0 ||
        remaining > LINEUP_LOOKAHEAD_DAYS * DAY_MS
      )
        continue;
      // Include later fixtures in rounds already underway. Every five-minute tick
      // refreshes the last 90 minutes; earlier snapshots refresh each 15 minutes.
      if (remaining <= 90 * 60 * 1000 || now.getUTCMinutes() % 15 < 5)
        lineupRounds.add(match.roundNumber);
    }

    const lineupBatches = await Promise.all(
      Array.from(lineupRounds).map((r) => fetchLineupsSafe(env, competition, season, r)),
    );
    const lineups = lineupBatches.flat();

    if (allMatches.length === 0 && lineups.length === 0)
      return { ...outcome, matches: 0, stats: 0, lineups: 0 };

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
        .bind(now.toISOString(), seasonId)
        .run();
      statsAffected = (await refreshDueStats(env, now, undefined, seasonId)).changedRows;
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
    // A no-op pass is not logged, except the first success after a failure:
    // health clears a competition error only on a later success row.
    if (didWork || (!isBackfill && !upcoming && (await lastSyncFailed(env, logType)))) {
      await logSync(env, logType, matchesAffected + statsAffected + lineupsAffected);
    }

    return {
      ...outcome,
      matches: matchesAffected,
      stats: statsAffected,
      ...(statsPending !== null && { statsPending }),
      lineups: lineupsAffected,
    };
  } catch (err) {
    // Database and lease failures always count against the competition.
    await logSync(env, `sync:${competition}`, 0, describeError(err));
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
