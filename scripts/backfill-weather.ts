/**
 * One-off local backfill of observed match-window weather for every eligible
 * completed match, from Open-Meteo's free reanalysis archive (#138, spec
 * locked in #128). Follows the backfill-lineups.ts pattern: fetch locally,
 * generate batched SQL artifacts, apply via `wrangler d1 execute`.
 *
 * Phases (resume is free at every phase):
 *   1. FETCH    — eligibility query against remote D1; one 3-day dual-model
 *                 archive call per match (`models=era5_land,era5`), throttled
 *                 to ~3 req/s; raw JSON cached in data/weather-cache/ keyed
 *                 by match id (re-runs skip cached matches).
 *   2. GENERATE — cache -> batched upsert SQL under data/sql-weather/,
 *                 inspectable before apply.
 *   3. APPLY    — per-file `wrangler d1 execute afl-stats --remote`.
 *
 * Modes (each phase is separately inspectable and abortable):
 *   --dry-run        Eligibility counts per competition/season plus a call
 *                    estimate; fetches nothing, writes nothing.
 *   --fetch-only     Phase 1 only: populate the local cache, generate and
 *                    apply nothing.
 *   --generate-only  Phase 2 only: build SQL artifacts from the existing
 *                    cache for inspection; fetch and apply nothing.
 *   --verify         Post-apply checks: observed coverage per
 *                    competition/season, value-range sanity, and a 30-row
 *                    fresh-API spot-check.
 *
 * Eligibility: completed matches (status 'Complete', or legacy NULL status
 * with points) that have no observed row and whose canonical venue has
 * coordinates — the NULL-geodata exclusion subsumes the 'To Be Confirmed'
 * placeholder venue (17748). Coordinates resolve through
 * venues.canonical_venue_id.
 */
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  aggregateWeatherWindow,
  extractHourlySeries,
  type WeatherMetrics,
} from "../src/weather/aggregate";
import {
  ARCHIVE_API,
  FALLBACK_LOCAL_TIME,
  matchWeatherUpsertSql,
  OBSERVED_FINAL_SOURCE,
  openMeteoUrl,
  weatherMetricValues,
} from "../src/weather/openmeteo";

const SQL_DIR = join(__dirname, "..", "data", "sql-weather");
const CACHE_DIR = join(__dirname, "..", "data", "weather-cache");
mkdirSync(SQL_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

const BATCH_SIZE = 200;
const THROTTLE_MS = 350; // ~3 req/s
const SPOT_CHECK_ROWS = 30;

// ── Helpers (backfill-lineups.ts pattern) ────────────────────────────

function escapeSQL(value: string | number | null | undefined): string {
  if (value == null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}

function writeBatchedSQL(prefix: string, statements: string[]): number {
  for (const f of readdirSync(SQL_DIR).filter((f) => f.startsWith(`${prefix}_`))) {
    unlinkSync(join(SQL_DIR, f));
  }
  let fileIndex = 0;
  for (let i = 0; i < statements.length; i += BATCH_SIZE) {
    const batch = statements.slice(i, i + BATCH_SIZE);
    const sql = `${batch.join(";\n")};\n`;
    const path = join(SQL_DIR, `${prefix}_${String(fileIndex).padStart(4, "0")}.sql`);
    writeFileSync(path, sql);
    fileIndex++;
  }
  return fileIndex;
}

/** Envelope of `wrangler d1 execute --json`: one result set per statement. */
const D1ExecuteOutputSchema = z.array(z.object({ results: z.array(z.unknown()).default([]) }));

function queryD1<T>(sql: string, rowSchema: z.ZodType<T>): T[] {
  const escaped = sql.replace(/\n/g, " ").replace(/"/g, '\\"');
  const raw = execSync(`npx wrangler d1 execute afl-stats --remote --command "${escaped}" --json`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
  const output = D1ExecuteOutputSchema.parse(JSON.parse(raw));
  return z.array(rowSchema).parse(output[0]?.results ?? []);
}

function executeSQL(filePath: string): void {
  execSync(`npx wrangler d1 execute afl-stats --remote --file "${filePath}"`, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Eligibility ──────────────────────────────────────────────────────

const EligibleMatchSchema = z.object({
  id: z.number(),
  date: z.string(),
  local_time: z.string().nullable(),
  competition: z.string(),
  year: z.number(),
  latitude: z.number(),
  longitude: z.number(),
});
type EligibleMatch = z.infer<typeof EligibleMatchSchema>;

const ELIGIBILITY_SELECT = `
  FROM matches m
  JOIN seasons s ON m.season_id = s.id
  JOIN competitions c ON s.competition_id = c.id
  JOIN venues v ON v.id = m.venue_id
  JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id)
  LEFT JOIN match_weather w ON w.match_id = m.id AND w.kind = 'observed'
  WHERE (m.status = 'Complete' OR (m.status IS NULL AND m.home_points IS NOT NULL))
    AND w.match_id IS NULL
    AND cv.latitude IS NOT NULL AND cv.longitude IS NOT NULL`;

function loadEligibleMatches(): EligibleMatch[] {
  return queryD1(
    `SELECT m.id, m.date, m.local_time, c.code AS competition, s.year,
       cv.latitude, cv.longitude
     ${ELIGIBILITY_SELECT}
     ORDER BY m.date, m.id`,
    EligibleMatchSchema,
  );
}

function printEligibilitySummary(matches: EligibleMatch[]): void {
  const bySeason = new Map<string, number>();
  for (const m of matches) {
    const key = `${m.competition} ${m.year}`;
    bySeason.set(key, (bySeason.get(key) ?? 0) + 1);
  }
  console.log("Eligible matches per competition/season:");
  for (const [key, count] of [...bySeason.entries()].sort()) {
    console.log(`  ${key}: ${count}`);
  }
  const cached = matches.filter((m) => existsSync(cachePath(m.id))).length;
  console.log(`Total eligible: ${matches.length} (${cached} already cached)`);
  // A 3-day dual-model hourly request weighs roughly one API call.
  console.log(
    `Estimated archive calls: ~${matches.length - cached} (free tier: 10,000/day), ` +
      `~${Math.ceil(((matches.length - cached) * THROTTLE_MS) / 60000)} min at ~3 req/s`,
  );
}

// ── Phase 1: fetch ───────────────────────────────────────────────────

function cachePath(matchId: number): string {
  return join(CACHE_DIR, `${matchId}.json`);
}

async function fetchArchivePayload(match: {
  latitude: number;
  longitude: number;
  date: string;
}): Promise<unknown> {
  const response = await fetch(openMeteoUrl(ARCHIVE_API, match, true));
  if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
  return response.json();
}

async function fetchPhase(matches: EligibleMatch[]): Promise<void> {
  console.log("\nPhase 1: fetching from Open-Meteo archive...");
  let fetched = 0;
  let skipped = 0;
  let errors = 0;
  for (const match of matches) {
    if (existsSync(cachePath(match.id))) {
      skipped++;
      continue;
    }
    try {
      const payload = await fetchArchivePayload(match);
      writeFileSync(
        cachePath(match.id),
        JSON.stringify({ fetchedAt: new Date().toISOString(), payload }),
      );
      fetched++;
      process.stdout.write(".");
    } catch (err) {
      errors++;
      process.stdout.write("x");
      console.error(`\n  match ${match.id} (${match.date}): ${String(err)}`);
    }
    if (fetched % 100 === 0 && fetched > 0) process.stdout.write(`[${fetched}]`);
    await sleep(THROTTLE_MS);
  }
  console.log(`\nFetched ${fetched}, cached ${skipped}, errors ${errors}`);
  if (errors > 0) {
    console.log("Re-run to retry failed matches (cache hits are skipped).");
  }
}

// ── Phase 2: generate ────────────────────────────────────────────────

/** Shape of one data/weather-cache/<matchId>.json entry written by fetchPhase. */
const CacheEntrySchema = z.object({ fetchedAt: z.string(), payload: z.unknown() });

function metricsFromCache(match: EligibleMatch): { metrics: WeatherMetrics; fetchedAt: string } {
  const cached = CacheEntrySchema.parse(JSON.parse(readFileSync(cachePath(match.id), "utf-8")));
  const series = extractHourlySeries(cached.payload);
  const scheduledStart = `${match.date}T${match.local_time ?? FALLBACK_LOCAL_TIME}`;
  return { metrics: aggregateWeatherWindow(series, scheduledStart), fetchedAt: cached.fetchedAt };
}

function upsertStatement(matchId: number, metrics: WeatherMetrics, fetchedAt: string): string {
  const values = [
    String(matchId),
    escapeSQL("observed"),
    ...weatherMetricValues(metrics).map(escapeSQL),
    escapeSQL(OBSERVED_FINAL_SOURCE),
    escapeSQL(fetchedAt),
  ].join(", ");
  return matchWeatherUpsertSql(values);
}

function generatePhase(matches: EligibleMatch[]): number {
  console.log("\nPhase 2: generating SQL...");
  const statements: string[] = [];
  let missing = 0;
  for (const match of matches) {
    if (!existsSync(cachePath(match.id))) {
      missing++;
      continue;
    }
    const { metrics, fetchedAt } = metricsFromCache(match);
    statements.push(upsertStatement(match.id, metrics, fetchedAt));
  }
  const files = writeBatchedSQL("weather", statements);
  console.log(`Generated ${statements.length} upserts in ${files} files under ${SQL_DIR}`);
  if (missing > 0) console.log(`Skipped ${missing} matches with no cached payload`);
  return files;
}

// ── Phase 3: apply ───────────────────────────────────────────────────

function applyPhase(): void {
  console.log("\nPhase 3: applying SQL to remote D1...");
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.startsWith("weather_"))
    .sort();
  for (const f of files) {
    console.log(`  ${f}`);
    executeSQL(join(SQL_DIR, f));
  }
}

// ── Verify ───────────────────────────────────────────────────────────

function verifyCoverage(): void {
  console.log("Coverage per competition/season (eligible vs observed):");
  const rows = queryD1(
    `SELECT c.code AS competition, s.year,
       COUNT(*) AS eligible,
       SUM(CASE WHEN w.match_id IS NOT NULL THEN 1 ELSE 0 END) AS observed
     FROM matches m
     JOIN seasons s ON m.season_id = s.id
     JOIN competitions c ON s.competition_id = c.id
     JOIN venues v ON v.id = m.venue_id
     JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id)
     LEFT JOIN match_weather w ON w.match_id = m.id AND w.kind = 'observed'
     WHERE (m.status = 'Complete' OR (m.status IS NULL AND m.home_points IS NOT NULL))
       AND cv.latitude IS NOT NULL AND cv.longitude IS NOT NULL
     GROUP BY c.code, s.year
     ORDER BY c.code, s.year`,
    z.object({
      competition: z.string(),
      year: z.number(),
      eligible: z.number(),
      observed: z.number(),
    }),
  );
  let gaps = 0;
  for (const row of rows) {
    const flag = row.observed < row.eligible ? "  <-- GAP" : "";
    if (flag) gaps++;
    console.log(`  ${row.competition} ${row.year}: ${row.observed}/${row.eligible}${flag}`);
  }
  console.log(gaps === 0 ? "  Coverage: 100% everywhere" : `  ${gaps} season(s) with gaps`);
}

function verifyRanges(): void {
  console.log("\nRange sanity (violations should all be 0):");
  const checks: [string, string][] = [
    ["temp_c outside -5..50", "temp_c IS NOT NULL AND (temp_c < -5 OR temp_c > 50)"],
    ["precip_mm negative", "precip_mm IS NOT NULL AND precip_mm < 0"],
    ["precip_24h_prior_mm negative", "precip_24h_prior_mm IS NOT NULL AND precip_24h_prior_mm < 0"],
    ["wind_speed_kmh negative", "wind_speed_kmh IS NOT NULL AND wind_speed_kmh < 0"],
    ["wind_gust_kmh negative", "wind_gust_kmh IS NOT NULL AND wind_gust_kmh < 0"],
    [
      "humidity_pct outside 0..100",
      "humidity_pct IS NOT NULL AND (humidity_pct < 0 OR humidity_pct > 100)",
    ],
    ["source empty", "source IS NULL OR source = ''"],
    ["fetched_at empty", "fetched_at IS NULL OR fetched_at = ''"],
  ];
  for (const [label, predicate] of checks) {
    const rows = queryD1(
      `SELECT COUNT(*) AS n FROM match_weather WHERE kind = 'observed' AND (${predicate})`,
      z.object({ n: z.number() }),
    );
    const n = rows[0]?.n ?? 0;
    console.log(`  ${label}: ${n}${n > 0 ? "  <-- VIOLATION" : ""}`);
  }
}

async function verifySpotCheck(): Promise<void> {
  console.log(`\nSpot check: re-fetching ${SPOT_CHECK_ROWS} random observed rows fresh...`);
  const rows = queryD1(
    `SELECT m.id, m.date, m.local_time, cv.latitude, cv.longitude,
       w.temp_c, w.precip_mm, w.wind_speed_kmh, w.humidity_pct
     FROM match_weather w
     JOIN matches m ON m.id = w.match_id
     JOIN venues v ON v.id = m.venue_id
     JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id)
     WHERE w.kind = 'observed' AND w.source = '${OBSERVED_FINAL_SOURCE}'
     ORDER BY RANDOM() LIMIT ${SPOT_CHECK_ROWS}`,
    z.object({
      id: z.number(),
      date: z.string(),
      local_time: z.string().nullable(),
      latitude: z.number(),
      longitude: z.number(),
      temp_c: z.number().nullable(),
      precip_mm: z.number().nullable(),
      wind_speed_kmh: z.number().nullable(),
      humidity_pct: z.number().nullable(),
    }),
  );
  let mismatches = 0;
  for (const row of rows) {
    const payload = await fetchArchivePayload(row);
    const series = extractHourlySeries(payload);
    const fresh = aggregateWeatherWindow(
      series,
      `${row.date}T${row.local_time ?? FALLBACK_LOCAL_TIME}`,
    );
    const diffs: string[] = [];
    const compare = (label: string, stored: number | null, live: number | null, tol: number) => {
      if (stored === null && live === null) return;
      if (stored === null || live === null || Math.abs(stored - live) > tol) {
        diffs.push(`${label} stored=${stored} fresh=${live}`);
      }
    };
    compare("temp_c", row.temp_c, fresh.tempC, 0.5);
    compare("precip_mm", row.precip_mm, fresh.precipMm, 0.3);
    compare("wind_speed_kmh", row.wind_speed_kmh, fresh.windSpeedKmh, 1);
    compare("humidity_pct", row.humidity_pct, fresh.humidityPct, 2);
    if (diffs.length > 0) {
      mismatches++;
      console.log(`  match ${row.id} (${row.date}): ${diffs.join(", ")}`);
    }
    await sleep(THROTTLE_MS);
  }
  console.log(
    mismatches === 0
      ? `  All ${rows.length} rows match the fresh API within tolerance`
      : `  ${mismatches}/${rows.length} rows differ (ERA5 revisions can shift values slightly)`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const verify = args.includes("--verify");
  const fetchOnly = args.includes("--fetch-only");
  const generateOnly = args.includes("--generate-only");

  if (verify) {
    console.log("Weather backfill verification\n");
    verifyCoverage();
    verifyRanges();
    await verifySpotCheck();
    return;
  }

  const mode = dryRun
    ? " (dry run)"
    : fetchOnly
      ? " (fetch only)"
      : generateOnly
        ? " (generate only)"
        : "";
  console.log(`Weather backfill${mode}`);
  console.log("Loading eligible matches from D1...");
  const matches = loadEligibleMatches();
  printEligibilitySummary(matches);

  if (dryRun) {
    console.log("\nDry run complete — nothing fetched, nothing written.");
    return;
  }

  if (!generateOnly) await fetchPhase(matches);
  if (fetchOnly) {
    console.log(
      `\nFetch-only complete. Cache in ${CACHE_DIR}; next: --generate-only or a full run.`,
    );
    return;
  }
  const files = generatePhase(matches);
  if (files === 0) {
    console.log("Nothing to apply.");
    return;
  }
  if (generateOnly) {
    console.log(
      `\nGenerate-only complete. Inspect ${SQL_DIR}, then re-run without flags to apply.`,
    );
    return;
  }
  console.log(`\nInspect the SQL under ${SQL_DIR} if desired; applying now.`);
  applyPhase();
  console.log("\nDone! Run with --verify to check coverage, ranges, and a spot sample.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
