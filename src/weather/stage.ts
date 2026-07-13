/**
 * The sync pipeline's weather stage (#138, lifecycle locked in #127).
 *
 * Runs on top-of-hour sync passes inside the existing operation lease and is
 * driven entirely by needs-work queries against D1:
 *
 * - Upcoming matches ≤7 days out get a forecast row from the Open-Meteo
 *   Forecast API (`best_match`), refreshed daily and hourly on match day.
 * - Completed matches inside the ~5-day ERA5 publication lag get a fast
 *   observed row from the Historical Forecast API.
 * - Once a match is more than {@link ERA5_LAG_DAYS} days old, its observed
 *   row is (re)written from the archive API with `models=era5_land,era5` —
 *   identical provenance to the backfill, so `match_weather` converges.
 * - Cancelled matches get any stray weather rows deleted.
 *
 * Fail-soft: any error ends the stage for this pass with a `sync_log` row
 * and no retry state — the needs-work queries self-heal next hour.
 */
import { addDaysToIsoDate, toMelbourneDate, toMelbourneTime } from "../lib/time";
import { logSync } from "../sync/log";
import type { Env } from "../types";
import { aggregateWeatherWindow, extractHourlySeries } from "./aggregate";
import {
  ARCHIVE_API,
  FALLBACK_LOCAL_TIME,
  FORECAST_API,
  HISTORICAL_FORECAST_API,
  MATCH_WEATHER_UPSERT,
  OBSERVED_FINAL_SOURCE,
  openMeteoUrl,
  type WeatherKind,
  type WeatherSource,
  weatherMetricValues,
} from "./openmeteo";

/** Forecasts are first fetched when a match is at most this many days out. */
const FORECAST_HORIZON_DAYS = 7;
/**
 * ERA5 reanalysis publication lag (~5 days) plus a safety day: matches older
 * than this get final `era5_land+era5` observed rows from the archive API.
 */
const ERA5_LAG_DAYS = 6;
/**
 * Per-query cap on fetches per hourly pass. Bounds third-party calls if a
 * large observed backlog ever accumulates (the bulk load is the backfill
 * script's job); the needs-work queries drain any remainder hour by hour.
 */
const MAX_FETCHES_PER_QUERY = 25;

interface CandidateRow {
  readonly match_id: number;
  readonly date: string;
  readonly local_time: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly fetched_at: string | null;
}

interface WeatherJob {
  readonly candidate: CandidateRow;
  readonly kind: WeatherKind;
  readonly source: WeatherSource;
  readonly apiBase: string;
  readonly isDualModel: boolean;
}

/** Joins matches to canonical-venue coordinates via `canonical_venue_id`. */
const CANONICAL_VENUE_JOIN = `
  JOIN venues v ON v.id = m.venue_id
  JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id)`;

/**
 * Run the weather stage once: cleanup, needs-work selection, Open-Meteo
 * fetches, and `match_weather` upserts. Never throws — failures are logged
 * to `sync_log` and retried by the next top-of-hour pass.
 *
 * @param env - Worker bindings.
 * @param fetchImpl - `fetch` in production; a stub in tests.
 * @param now - Injected clock for cadence tiers and `fetched_at` stamps.
 */
export async function runWeatherStage(env: Env, fetchImpl: typeof fetch, now: Date): Promise<void> {
  try {
    const cleaned = await cleanupCancelledWeather(env);
    const jobs = await selectNeedsWork(env, now);
    let written = 0;
    // Sequential on purpose: one in-flight request at a time keeps the
    // stage gentle on Open-Meteo's free tier (not a Promise.all candidate).
    for (const job of jobs) {
      await fetchAndStore(env, fetchImpl, job, now);
      written++;
    }
    if (written > 0 || cleaned > 0) {
      await logSync(env, "sync:weather", written + cleaned);
    }
  } catch (err) {
    // Fail-soft (#127): never block match-data sync on an Open-Meteo outage.
    await logSync(env, "sync:weather", 0, describeError(err)).catch((logErr) =>
      console.error("weather stage: failed to record sync_log row", logErr),
    );
  }
}

async function cleanupCancelledWeather(env: Env): Promise<number> {
  const result = await env.DB.prepare(
    "DELETE FROM match_weather WHERE match_id IN (SELECT id FROM matches WHERE status = 'Cancelled')",
  ).run();
  return result.meta.changes;
}

async function selectNeedsWork(env: Env, now: Date): Promise<WeatherJob[]> {
  const [forecast, fastObserved, finalObserved] = await Promise.all([
    selectForecastCandidates(env, now),
    selectFastObservedCandidates(env, now),
    selectFinalObservedCandidates(env, now),
  ]);
  return [
    ...forecast.map(
      (candidate): WeatherJob => ({
        candidate,
        kind: "forecast",
        source: "best_match",
        apiBase: FORECAST_API,
        isDualModel: false,
      }),
    ),
    ...fastObserved.map(
      (candidate): WeatherJob => ({
        candidate,
        kind: "observed",
        source: "historical_forecast",
        apiBase: HISTORICAL_FORECAST_API,
        isDualModel: false,
      }),
    ),
    ...finalObserved.map(
      (candidate): WeatherJob => ({
        candidate,
        kind: "observed",
        source: OBSERVED_FINAL_SOURCE,
        apiBase: ARCHIVE_API,
        isDualModel: true,
      }),
    ),
  ];
}

/**
 * Upcoming (not started, not cancelled) matches within the forecast horizon,
 * with their current forecast row's `fetched_at` for tier staleness checks.
 * Postponed matches need no special case: the tiers compute from the current
 * match datetime, so a fixture change self-corrects within a day.
 */
async function selectForecastCandidates(env: Env, now: Date): Promise<CandidateRow[]> {
  const today = toMelbourneDate(now);
  const nowMelbourne = `${today} ${toMelbourneTime(now)}`;
  const horizon = addDaysToIsoDate(today, FORECAST_HORIZON_DAYS);
  const rows = await env.DB.prepare(
    `SELECT m.id AS match_id, m.date, m.local_time, cv.latitude, cv.longitude, w.fetched_at
     FROM matches m
     ${CANONICAL_VENUE_JOIN}
     LEFT JOIN match_weather w ON w.match_id = m.id AND w.kind = 'forecast'
     WHERE (m.status IS NULL OR m.status NOT IN ('Complete', 'Cancelled'))
       AND m.date || ' ' || COALESCE(m.local_time, '23:59:59') > ?1
       AND m.date <= ?2
       AND cv.latitude IS NOT NULL AND cv.longitude IS NOT NULL
     ORDER BY m.date, m.id`,
  )
    .bind(nowMelbourne, horizon)
    .all<CandidateRow>();
  return rows.results.filter((row) => forecastIsStale(row, now)).slice(0, MAX_FETCHES_PER_QUERY);
}

/**
 * Refresh tiers (#127): hourly on match day (Melbourne), otherwise daily.
 * `fetched_at` is a UTC ISO timestamp, so hour boundaries compare directly
 * and day boundaries compare via the Melbourne calendar date.
 */
function forecastIsStale(row: CandidateRow, now: Date): boolean {
  if (row.fetched_at === null) return true;
  const fetched = new Date(row.fetched_at);
  if (row.date === toMelbourneDate(now)) {
    const hourStart = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
    );
    return fetched.getTime() < hourStart;
  }
  return toMelbourneDate(fetched) < toMelbourneDate(now);
}

/**
 * Completed matches still inside the ERA5 lag window with no observed row:
 * fast-written from the Historical Forecast API on the first hourly pass
 * after completion.
 */
async function selectFastObservedCandidates(env: Env, now: Date): Promise<CandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS match_id, m.date, m.local_time, cv.latitude, cv.longitude, NULL AS fetched_at
     FROM matches m
     ${CANONICAL_VENUE_JOIN}
     LEFT JOIN match_weather w ON w.match_id = m.id AND w.kind = 'observed'
     WHERE m.status = 'Complete'
       AND w.match_id IS NULL
       AND m.date > ?1
       AND cv.latitude IS NOT NULL AND cv.longitude IS NOT NULL
     ORDER BY m.date DESC, m.id
     LIMIT ?2`,
  )
    .bind(finalCutoffDate(now), MAX_FETCHES_PER_QUERY)
    .all<CandidateRow>();
  return rows.results;
}

/**
 * The latest Melbourne date that counts as "more than {@link ERA5_LAG_DAYS}
 * days old" (#127: observed rows upgrade once the match is >6 days old, so
 * a match dated exactly 6 days ago keeps its interim row for one more day).
 */
function finalCutoffDate(now: Date): string {
  return addDaysToIsoDate(toMelbourneDate(now), -(ERA5_LAG_DAYS + 1));
}

/**
 * Completed matches past the ERA5 lag whose observed row is missing or not
 * yet on the final `era5_land+era5` provenance: one idempotent (re)write
 * from the archive API. Pre-status legacy rows count as completed when they
 * have points.
 */
async function selectFinalObservedCandidates(env: Env, now: Date): Promise<CandidateRow[]> {
  const rows = await env.DB.prepare(
    `SELECT m.id AS match_id, m.date, m.local_time, cv.latitude, cv.longitude, NULL AS fetched_at
     FROM matches m
     ${CANONICAL_VENUE_JOIN}
     LEFT JOIN match_weather w ON w.match_id = m.id AND w.kind = 'observed'
     WHERE (m.status = 'Complete' OR (m.status IS NULL AND m.home_points IS NOT NULL))
       AND m.date <= ?1
       AND (w.match_id IS NULL OR w.source <> ?2)
       AND cv.latitude IS NOT NULL AND cv.longitude IS NOT NULL
     ORDER BY m.date DESC, m.id
     LIMIT ?3`,
  )
    .bind(finalCutoffDate(now), OBSERVED_FINAL_SOURCE, MAX_FETCHES_PER_QUERY)
    .all<CandidateRow>();
  return rows.results;
}

async function fetchAndStore(
  env: Env,
  fetchImpl: typeof fetch,
  job: WeatherJob,
  now: Date,
): Promise<void> {
  const url = openMeteoUrl(job.apiBase, job.candidate, job.isDualModel);
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo ${response.status} for match ${job.candidate.match_id}`);
  }
  const series = extractHourlySeries(await response.json());
  const scheduledStart = `${job.candidate.date}T${job.candidate.local_time ?? FALLBACK_LOCAL_TIME}`;
  const metrics = aggregateWeatherWindow(series, scheduledStart);
  await env.DB.prepare(MATCH_WEATHER_UPSERT)
    .bind(
      job.candidate.match_id,
      job.kind,
      ...weatherMetricValues(metrics),
      job.source,
      now.toISOString(),
    )
    .run();
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
