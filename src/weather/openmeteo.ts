/**
 * Shared Open-Meteo write-path pieces for the sync weather stage
 * (src/weather/stage.ts) and the local backfill script
 * (scripts/backfill-weather.ts): endpoint constants, the request URL
 * builder, and the `match_weather` upsert generated from a single column
 * manifest (the src/sync/columns.ts convention), so the two write paths
 * cannot diverge.
 */
import { addDaysToIsoDate } from "../lib/time";
import {
  type ColumnDef,
  insertColumnList,
  placeholderList,
  updateSetClause,
} from "../sync/columns";
import { OPEN_METEO_HOURLY_VARIABLES, type WeatherMetrics } from "./aggregate";

/** Row kind in `match_weather`. */
export type WeatherKind = "observed" | "forecast";

/** Provenance recorded in `match_weather.source`. */
export type WeatherSource = "best_match" | "historical_forecast" | "era5_land+era5";

/**
 * Final observed provenance: dual-model reanalysis, written by the backfill
 * and by the sync stage's >6-day upgrade path, so `match_weather` converges
 * to uniform data (#127).
 */
export const OBSERVED_FINAL_SOURCE: WeatherSource = "era5_land+era5";

/**
 * Scheduled start for legacy rows lacking `local_time` (coverage says the
 * column is complete, so this is a belt-and-braces fallback): 13:00 puts
 * the 3h window in a typical afternoon-bounce slot rather than midnight.
 */
export const FALLBACK_LOCAL_TIME = "13:00:00";

/** Forecast API (`best_match` model) for upcoming matches. */
export const FORECAST_API = "https://api.open-meteo.com/v1/forecast";
/** Archived forecast model output; bridges the ~5-day ERA5 publication lag. */
export const HISTORICAL_FORECAST_API = "https://historical-forecast-api.open-meteo.com/v1/forecast";
/** ERA5/ERA5-Land reanalysis archive for final observed rows. */
export const ARCHIVE_API = "https://archive-api.open-meteo.com/v1/archive";

/** Coordinates plus the Melbourne-local match date for one hourly request. */
export interface WeatherRequest {
  readonly latitude: number;
  readonly longitude: number;
  /** Melbourne-local match date "YYYY-MM-DD". */
  readonly date: string;
}

/**
 * Build an Open-Meteo hourly request URL.
 *
 * Always a three-day window: the prior day covers the prior-24h
 * precipitation window and the day after keeps midnight-crossing match
 * windows complete (a 22:40 start needs 00:00 on the next day).
 * `timezone=Australia/Melbourne` always, because D1 match timestamps are
 * Melbourne-local regardless of venue (#126).
 *
 * @param apiBase - One of {@link FORECAST_API}, {@link HISTORICAL_FORECAST_API},
 *   or {@link ARCHIVE_API}.
 * @param request - Canonical-venue coordinates and the match date.
 * @param isDualModel - Request `models=era5_land,era5` (archive calls only):
 *   temp/humidity/wind from ERA5-Land, precipitation from ERA5 (#130).
 * @returns The full request URL.
 */
export function openMeteoUrl(
  apiBase: string,
  request: WeatherRequest,
  isDualModel: boolean,
): string {
  const params = new URLSearchParams({
    latitude: String(request.latitude),
    longitude: String(request.longitude),
    hourly: OPEN_METEO_HOURLY_VARIABLES,
    timezone: "Australia/Melbourne",
    start_date: addDaysToIsoDate(request.date, -1),
    end_date: addDaysToIsoDate(request.date, 1),
  });
  if (isDualModel) params.set("models", "era5_land,era5");
  return `${apiBase}?${params.toString()}`;
}

// ── match_weather upsert (single column manifest) ────────────────────

const MATCH_WEATHER_MANIFEST: readonly ColumnDef[] = [
  { name: "match_id", kind: "key" },
  { name: "kind", kind: "key" },
  { name: "temp_c", kind: "replace" },
  { name: "precip_mm", kind: "replace" },
  { name: "precip_24h_prior_mm", kind: "replace" },
  { name: "wind_speed_kmh", kind: "replace" },
  { name: "wind_gust_kmh", kind: "replace" },
  { name: "humidity_pct", kind: "replace" },
  { name: "source", kind: "replace" },
  { name: "fetched_at", kind: "replace" },
];

/**
 * The `match_weather` upsert with a caller-supplied VALUES tuple: `?`
 * placeholders from the sync stage, escaped literals from the backfill's
 * generated SQL artifacts. Value order is the manifest order —
 * `match_id, kind, <the six metrics>, source, fetched_at` (metrics via
 * {@link weatherMetricValues}).
 *
 * @param valuesTuple - Comma-separated VALUES entries in manifest order.
 * @returns The full INSERT ... ON CONFLICT (match_id, kind) DO UPDATE
 *   statement.
 */
export function matchWeatherUpsertSql(valuesTuple: string): string {
  return `INSERT INTO match_weather (${insertColumnList(MATCH_WEATHER_MANIFEST)})
   VALUES (${valuesTuple})
   ON CONFLICT (match_id, kind) DO UPDATE SET
      ${updateSetClause("match_weather", MATCH_WEATHER_MANIFEST)}`;
}

/** The `match_weather` upsert with `?` placeholders, for D1 `.bind()`. */
export const MATCH_WEATHER_UPSERT = matchWeatherUpsertSql(placeholderList(MATCH_WEATHER_MANIFEST));

/**
 * Metric values in manifest column order (the columns between the
 * `(match_id, kind)` key and the `(source, fetched_at)` provenance pair).
 *
 * @param metrics - Aggregated window metrics.
 * @returns Values ready to bind or escape, in upsert order.
 */
export function weatherMetricValues(metrics: WeatherMetrics): readonly (number | null)[] {
  return [
    metrics.tempC,
    metrics.precipMm,
    metrics.precip24hPriorMm,
    metrics.windSpeedKmh,
    metrics.windGustKmh,
    metrics.humidityPct,
  ];
}
