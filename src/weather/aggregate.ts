/**
 * Pure aggregation of Open-Meteo hourly responses into the six match-window
 * metrics stored in `match_weather`. Shared by the sync weather stage
 * (src/weather/stage.ts) and the local backfill script
 * (scripts/backfill-weather.ts) so the two write paths cannot diverge.
 *
 * All timestamps are naive local strings: D1 stores Melbourne-local dates
 * and every Open-Meteo call passes `timezone=Australia/Melbourne`, so the
 * hourly `time` axis and the scheduled start already share a clock and no
 * timezone math happens here.
 */

import { z } from "zod";

/**
 * Open-Meteo hourly payload: a local-time axis plus one value array per
 * requested variable (plain keys on single-model responses, model-suffixed
 * keys like `temperature_2m_era5_land` on dual-model archive responses).
 * Non-hourly top-level fields (latitude, elevation, ...) are ignored.
 */
export const OpenMeteoPayloadSchema = z.object({
  hourly: z.object({ time: z.array(z.string()) }).catchall(z.array(z.number().nullable())),
});

/** Parsed Open-Meteo hourly payload (the external API boundary). */
export type OpenMeteoPayload = z.infer<typeof OpenMeteoPayloadSchema>;

/** One hourly variable series extracted from an Open-Meteo response. */
export interface HourlySeries {
  /** Local hourly timestamps, e.g. "2026-07-18T19:00". */
  readonly time: readonly string[];
  readonly temperatureC: readonly (number | null)[];
  readonly precipitationMm: readonly (number | null)[];
  readonly humidityPct: readonly (number | null)[];
  readonly windSpeedKmh: readonly (number | null)[];
  readonly windGustKmh: readonly (number | null)[];
}

/**
 * The six `match_weather` metrics. A metric is null when every hour in its
 * window was null or missing (nulls pass through rather than becoming 0).
 */
export interface WeatherMetrics {
  readonly tempC: number | null;
  readonly precipMm: number | null;
  readonly precip24hPriorMm: number | null;
  readonly windSpeedKmh: number | null;
  readonly windGustKmh: number | null;
  readonly humidityPct: number | null;
}

/** Hourly variables requested from every Open-Meteo endpoint. */
export const OPEN_METEO_HOURLY_VARIABLES =
  "temperature_2m,precipitation,relative_humidity_2m,wind_speed_10m,wind_gusts_10m";

const MATCH_WINDOW_HOURS = 3;
const PRIOR_WINDOW_HOURS = 24;

// Preference order per variable for dual-model archive responses
// (`models=era5_land,era5` suffixes every key): temp/humidity/wind come from
// ERA5-Land (~9 km), precipitation from ERA5 (~31 km) because ERA5-Land
// serves none (#130). Plain keys cover the single-model forecast APIs.
const TEMPERATURE_KEYS = ["temperature_2m", "temperature_2m_era5_land", "temperature_2m_era5"];
const PRECIPITATION_KEYS = ["precipitation", "precipitation_era5", "precipitation_era5_land"];
const HUMIDITY_KEYS = [
  "relative_humidity_2m",
  "relative_humidity_2m_era5_land",
  "relative_humidity_2m_era5",
];
const WIND_SPEED_KEYS = ["wind_speed_10m", "wind_speed_10m_era5_land", "wind_speed_10m_era5"];
const WIND_GUST_KEYS = ["wind_gusts_10m", "wind_gusts_10m_era5_land", "wind_gusts_10m_era5"];

/**
 * Extract the canonical hourly series from a raw Open-Meteo JSON payload.
 *
 * Handles both single-model responses (plain variable keys) and dual-model
 * archive responses (model-suffixed keys), preferring ERA5-Land for
 * temp/humidity/wind and ERA5 for precipitation. A variable absent from the
 * payload (or present but all-null) yields an all-null series so partial
 * responses are written as-is.
 *
 * @param payload - Parsed JSON body from an Open-Meteo hourly endpoint.
 * @returns The five variable series aligned to the `hourly.time` axis.
 * @throws When the payload has no `hourly.time` array (e.g. an API error body).
 */
export function extractHourlySeries(payload: unknown): HourlySeries {
  const parsed = OpenMeteoPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(`Unexpected Open-Meteo payload: ${parsed.error.message}`);
  }
  const { time, ...variables } = parsed.data.hourly;
  return {
    time,
    temperatureC: readSeries(variables, TEMPERATURE_KEYS, time.length),
    precipitationMm: readSeries(variables, PRECIPITATION_KEYS, time.length),
    humidityPct: readSeries(variables, HUMIDITY_KEYS, time.length),
    windSpeedKmh: readSeries(variables, WIND_SPEED_KEYS, time.length),
    windGustKmh: readSeries(variables, WIND_GUST_KEYS, time.length),
  };
}

/**
 * Aggregate an hourly series into the six `match_weather` metrics.
 *
 * The match window is the three hourly samples starting at the hour
 * containing the scheduled start (a 19:40 start uses 19:00, 20:00, 21:00 —
 * crossing midnight when the fixture does). The prior window is the 24
 * hourly samples immediately before the match window. Temperature and
 * humidity are means, precipitation is a total, wind speed and gust are
 * maxima. Null or missing hours are skipped; a window with no data at all
 * yields null.
 *
 * @param series - Hourly series from {@link extractHourlySeries}.
 * @param scheduledStart - Melbourne-local start, "YYYY-MM-DDTHH:MM:SS"
 *   ("T" or space separated; seconds optional).
 * @returns The six metrics, each null when its window had no data.
 */
export function aggregateWeatherWindow(
  series: HourlySeries,
  scheduledStart: string,
): WeatherMetrics {
  const index = new Map<string, number>();
  for (const [i, t] of series.time.entries()) index.set(t, i);

  const startHour = floorHour(scheduledStart);
  const windowIndexes = hourOffsets(startHour, 0, MATCH_WINDOW_HOURS, index);
  const priorIndexes = hourOffsets(startHour, -PRIOR_WINDOW_HOURS, PRIOR_WINDOW_HOURS, index);

  return {
    tempC: round(mean(pick(series.temperatureC, windowIndexes)), 1),
    precipMm: round(sum(pick(series.precipitationMm, windowIndexes)), 2),
    precip24hPriorMm: round(sum(pick(series.precipitationMm, priorIndexes)), 2),
    windSpeedKmh: max(pick(series.windSpeedKmh, windowIndexes)),
    windGustKmh: max(pick(series.windGustKmh, windowIndexes)),
    humidityPct: round(mean(pick(series.humidityPct, windowIndexes)), 1),
  };
}

function readSeries(
  variables: Record<string, readonly (number | null)[]>,
  keys: readonly string[],
  length: number,
): readonly (number | null)[] {
  // Prefer the first candidate that carries actual data, then any present
  // array (all-null), then a synthesized all-null series.
  let fallback: readonly (number | null)[] | undefined;
  for (const key of keys) {
    const value = variables[key];
    if (value === undefined) continue;
    if (value.some((v) => v !== null)) return value;
    fallback ??= value;
  }
  return fallback ?? new Array<number | null>(length).fill(null);
}

/** Truncate "YYYY-MM-DD[T ]HH:MM(:SS)" to its hour as UTC-interpreted parts. */
function floorHour(dateTime: string): number {
  const parts = dateTime.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})/);
  if (!parts) throw new Error(`Unparseable scheduled start: ${dateTime}`);
  const [, y, mo, d, h] = parts;
  return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h));
}

/** Format a UTC-interpreted epoch back to Open-Meteo's "YYYY-MM-DDTHH:00". */
function formatHour(epochMs: number): string {
  return `${new Date(epochMs).toISOString().slice(0, 13)}:00`;
}

function hourOffsets(
  startEpochMs: number,
  offsetHours: number,
  count: number,
  index: ReadonlyMap<string, number>,
): number[] {
  const hourMs = 60 * 60 * 1000;
  const found: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = index.get(formatHour(startEpochMs + (offsetHours + i) * hourMs));
    if (at !== undefined) found.push(at);
  }
  return found;
}

function pick(values: readonly (number | null)[], indexes: readonly number[]): number[] {
  const out: number[] = [];
  for (const i of indexes) {
    const value = values[i];
    if (value !== null && value !== undefined) out.push(value);
  }
  return out;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function sum(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

function max(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function round(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
