import type { Env } from "../../types";

/** Describes the product's expected availability for a field and season range. */
export type CoverageExpectation =
  | "complete"
  | "partial"
  | "best-effort"
  | "absent"
  | "not-applicable";

/** Version included in responses and cache keys. */
export const COVERAGE_CONTRACT_VERSION = 2;
/** Date on which static source expectations were last reviewed. */
export const COVERAGE_REVIEW_DATE = "2026-07-12";
/** Competition codes supported by the typed contract. */
export const COVERAGE_COMPETITIONS = ["AFLM", "AFLW", "VFL", "VFLW"] as const;
/** Supported competition code for a coverage request. */
export type CoverageCompetition = (typeof COVERAGE_COMPETITIONS)[number];

type TableName = keyof typeof ANALYTICS_COLUMNS;

interface CoverageTableExpectation {
  readonly range: string;
  readonly expected: CoverageExpectation;
  readonly source: readonly string[];
  readonly notes: readonly string[];
  readonly overrides?: Readonly<Record<string, CoverageExpectation>>;
  readonly ranges?: Readonly<Record<string, string>>;
}

const MATCH_COLUMNS = [
  "id",
  "season_id",
  "round",
  "round_abbreviation",
  "round_number",
  "round_type",
  "date",
  "local_time",
  "venue_id",
  "home_team_id",
  "away_team_id",
  "home_goals",
  "home_behinds",
  "home_points",
  "away_goals",
  "away_behinds",
  "away_points",
  "margin",
  "attendance",
  "weather_temp_c",
  "weather_type",
  "external_afltables_id",
  "external_fryzigg_id",
  "external_afl_id",
  "home_rushed_behinds",
  "away_rushed_behinds",
  "home_minutes_in_front",
  "away_minutes_in_front",
  "home_q1_goals",
  "home_q1_behinds",
  "home_q2_goals",
  "home_q2_behinds",
  "home_q3_goals",
  "home_q3_behinds",
  "home_q4_goals",
  "home_q4_behinds",
  "away_q1_goals",
  "away_q1_behinds",
  "away_q2_goals",
  "away_q2_behinds",
  "away_q3_goals",
  "away_q3_behinds",
  "away_q4_goals",
  "away_q4_behinds",
  "status",
  "live_period_status",
  "completed_quarter",
] as const;

const STAT_COLUMNS = [
  "id",
  "match_id",
  "player_id",
  "team_id",
  "guernsey_number",
  "player_position",
  "subbed",
  "time_on_ground_pct",
  "kicks",
  "handballs",
  "disposals",
  "effective_disposals",
  "disposal_efficiency_pct",
  "marks",
  "bounces",
  "tackles",
  "one_percenters",
  "clangers",
  "contested_possessions",
  "uncontested_possessions",
  "goals",
  "behinds",
  "goal_assists",
  "shots_at_goal",
  "score_involvements",
  "score_launches",
  "centre_clearances",
  "stoppage_clearances",
  "clearances",
  "contested_marks",
  "marks_inside_fifty",
  "intercept_marks",
  "marks_on_lead",
  "free_kicks_for",
  "free_kicks_against",
  "hitouts",
  "hitouts_to_advantage",
  "hitout_win_pct",
  "ruck_contests",
  "inside_fifties",
  "rebounds",
  "turnovers",
  "intercepts",
  "metres_gained",
  "pressure_acts",
  "def_half_pressure_acts",
  "tackles_inside_fifty",
  "spoils",
  "contest_def_losses",
  "contest_def_one_on_ones",
  "contest_off_one_on_ones",
  "contest_off_wins",
  "effective_kicks",
  "ground_ball_gets",
  "f50_ground_ball_gets",
  "brownlow_votes",
  "rating_points",
  "afl_fantasy_score",
  "supercoach_score",
  "goal_accuracy",
  "goal_efficiency",
  "shot_efficiency",
  "kick_efficiency",
  "kick_to_handball_ratio",
  "contested_possession_rate",
  "contest_def_loss_pct",
  "contest_off_wins_pct",
  "centre_bounce_attendances",
  "kickins",
  "kickins_playon",
  "interchange_counts",
  "total_possessions",
] as const;

/** Analytics tables and real columns materialized into the coverage response. */
export const ANALYTICS_COLUMNS = {
  competitions: ["id", "code", "name"],
  seasons: ["id", "competition_id", "year", "is_complete"],
  teams: ["id", "name", "abbreviation", "competition_id"],
  venues: ["id", "name", "latitude", "longitude", "timezone", "roof", "canonical_venue_id"],
  players: [
    "id",
    "first_name",
    "surname",
    "external_id",
    "external_afl_player_id",
    "date_of_birth",
    "height_cm",
    "weight_kg",
    "is_retired",
  ],
  matches: MATCH_COLUMNS,
  player_match_stats: STAT_COLUMNS,
  player_season_pav: [
    "*",
    "id",
    "player_id",
    "season_id",
    "team_id",
    "off_pav",
    "mid_pav",
    "def_pav",
    "total_pav",
  ],
  match_lineups: [
    "*",
    "id",
    "match_id",
    "player_id",
    "team_id",
    "guernsey_number",
    "position",
    "is_emergency",
    "is_substitute",
  ],
  match_weather: [
    "match_id",
    "kind",
    "temp_c",
    "precip_mm",
    "precip_24h_prior_mm",
    "wind_speed_kmh",
    "wind_gust_kmh",
    "humidity_pct",
    "source",
    "fetched_at",
  ],
  match_predictions: [
    "match_id",
    "home_win_prob",
    "predicted_margin",
    "model_version",
    "generated_at",
  ],
} as const;

const CORE = {
  range: "all",
  expected: "complete",
  source: ["afl-api"],
  notes: [],
} as const satisfies CoverageTableExpectation;

const VENUES = {
  ...CORE,
  source: ["afl-api", "venue-geodata"],
  // Alias/placeholder semantics are documented once in the schema tool notes;
  // per-leaf notes multiply across every column and blow the response budget.
  notes: [],
  overrides: {
    latitude: "partial",
    longitude: "partial",
    timezone: "partial",
    roof: "partial",
  },
} as const satisfies CoverageTableExpectation;

// Weather semantics (window, kinds, sources, exclusions) are documented once
// in the schema tool notes; per-leaf notes multiply across every column.
const MATCH_WEATHER_BASE = {
  expected: "partial",
  source: ["open-meteo"],
  notes: [],
} as const;

// Prediction semantics (home perspective, overwrite-in-place, tipper-written)
// are documented once in the schema tool notes; per-leaf notes stay minimal.
const MATCH_PREDICTIONS_AFLM = {
  range: "2026..current",
  expected: "partial",
  source: ["tipper"],
  notes: ["Only rounds tipper has published."],
} as const satisfies CoverageTableExpectation;

const MATCH_PREDICTIONS_ABSENT = {
  range: "all",
  expected: "absent",
  source: ["tipper"],
  notes: [],
} as const satisfies CoverageTableExpectation;

const AFLM_STAT_OVERRIDES = {
  brownlow_votes: "partial",
  supercoach_score: "partial",
  subbed: "partial",
} as const satisfies Record<string, CoverageExpectation>;

const AFLM_STAT_RANGES = {
  brownlow_votes: "1990..2025",
  supercoach_score: "2007..2019",
  afl_fantasy_score: "2007..current",
  subbed: "1990..2019",
  disposal_efficiency_pct: "2012..current",
  score_involvements: "2015..current",
  metres_gained: "2015..current",
  intercepts: "2015..current",
  pressure_acts: "2017..current",
} as const;

const QUARTER_SCORE_RANGES = {
  home_q1_goals: "2020..current",
  home_q1_behinds: "2020..current",
  home_q2_goals: "2020..current",
  home_q2_behinds: "2020..current",
  home_q3_goals: "2020..current",
  home_q3_behinds: "2020..current",
  home_q4_goals: "2020..current",
  home_q4_behinds: "2020..current",
  away_q1_goals: "2020..current",
  away_q1_behinds: "2020..current",
  away_q2_goals: "2020..current",
  away_q2_behinds: "2020..current",
  away_q3_goals: "2020..current",
  away_q3_behinds: "2020..current",
  away_q4_goals: "2020..current",
  away_q4_behinds: "2020..current",
} as const;

const RESERVES_STAT_OVERRIDES = {
  brownlow_votes: "not-applicable",
  supercoach_score: "absent",
  goal_assists: "absent",
  marks_inside_fifty: "absent",
  one_percenters: "absent",
  metres_gained: "best-effort",
  pressure_acts: "best-effort",
} as const satisfies Record<string, CoverageExpectation>;

const VFLW_STAT_OVERRIDES = {
  ...RESERVES_STAT_OVERRIDES,
  goal_assists: "best-effort",
  marks_inside_fifty: "best-effort",
  one_percenters: "best-effort",
} as const satisfies Record<string, CoverageExpectation>;

/** Canonical expectation manifest; exact ranges and prose are generated from this value. */
export const COVERAGE_EXPECTATIONS = {
  AFLM: {
    competitions: CORE,
    seasons: CORE,
    teams: CORE,
    venues: VENUES,
    players: CORE,
    matches: {
      ...CORE,
      range: "1990..current",
      source: ["afl-api", "fryzigg", "afl-tables"],
      expected: "partial",
      overrides: { local_time: "complete", status: "complete" },
      ranges: {
        attendance: "1990..2019",
        weather_temp_c: "2010..2025",
        weather_type: "2010..2025",
        live_period_status: "2026..current",
        completed_quarter: "2026..current",
        ...QUARTER_SCORE_RANGES,
      },
    },
    player_match_stats: {
      ...CORE,
      range: "1990..current",
      source: ["afl-api", "fryzigg"],
      expected: "complete",
      overrides: AFLM_STAT_OVERRIDES,
      ranges: AFLM_STAT_RANGES,
    },
    player_season_pav: { ...CORE, range: "1998..current", source: ["derived-pav"] },
    match_lineups: {
      ...CORE,
      range: "2015..current",
      expected: "partial",
      // Absence semantics live in the schema tool notes (budget); the gap
      // fact itself stays here (coverage design decision 37).
      notes: ["Known historical round gaps."],
    },
    match_weather: { ...MATCH_WEATHER_BASE, range: "1990..current" },
    match_predictions: MATCH_PREDICTIONS_AFLM,
  },
  AFLW: {
    competitions: CORE,
    seasons: CORE,
    teams: CORE,
    venues: VENUES,
    players: CORE,
    matches: {
      ...CORE,
      range: "2017..current",
      expected: "partial",
      overrides: { local_time: "complete", status: "complete" },
    },
    player_match_stats: {
      ...CORE,
      range: "2017..current",
      expected: "partial",
      overrides: { brownlow_votes: "not-applicable", supercoach_score: "absent", subbed: "absent" },
    },
    player_season_pav: { ...CORE, range: "2017..current", source: ["derived-pav"] },
    match_lineups: {
      ...CORE,
      range: "2017..current",
      expected: "partial",
      notes: [],
    },
    match_weather: { ...MATCH_WEATHER_BASE, range: "2017..current" },
    match_predictions: MATCH_PREDICTIONS_ABSENT,
  },
  VFL: {
    competitions: CORE,
    seasons: CORE,
    teams: CORE,
    venues: VENUES,
    players: CORE,
    matches: {
      ...CORE,
      range: "2021..current",
      expected: "partial",
      overrides: { local_time: "complete", status: "complete" },
    },
    player_match_stats: {
      ...CORE,
      range: "2021..current",
      expected: "best-effort",
      overrides: RESERVES_STAT_OVERRIDES,
    },
    player_season_pav: {
      ...CORE,
      range: "all",
      expected: "not-applicable",
      source: ["derived-pav"],
    },
    match_lineups: {
      ...CORE,
      range: "2021..current",
      expected: "best-effort",
      notes: [],
    },
    match_weather: { ...MATCH_WEATHER_BASE, range: "2021..current" },
    match_predictions: MATCH_PREDICTIONS_ABSENT,
  },
  VFLW: {
    competitions: CORE,
    seasons: CORE,
    teams: CORE,
    venues: VENUES,
    players: CORE,
    matches: {
      ...CORE,
      range: "2021..current",
      expected: "partial",
      overrides: { local_time: "complete", status: "complete" },
    },
    player_match_stats: {
      ...CORE,
      range: "2021..current",
      expected: "best-effort",
      overrides: VFLW_STAT_OVERRIDES,
    },
    player_season_pav: {
      ...CORE,
      range: "all",
      expected: "not-applicable",
      source: ["derived-pav"],
    },
    match_lineups: {
      ...CORE,
      range: "2021..current",
      expected: "best-effort",
      notes: [],
    },
    match_weather: { ...MATCH_WEATHER_BASE, range: "2021..current" },
    match_predictions: MATCH_PREDICTIONS_ABSENT,
  },
} as const satisfies Record<CoverageCompetition, Record<TableName, CoverageTableExpectation>>;

function legacyAvailability(spec: CoverageTableExpectation): boolean | string {
  if (spec.expected === "absent" || spec.expected === "not-applicable") return false;
  if (spec.expected === "best-effort") return "best-effort";
  return spec.range === "all" ? true : spec.range.replace("..current", "+");
}

/** Generate the deprecated competition summary from the canonical manifest. */
export function legacyCompetitionCoverage(competition: CoverageCompetition) {
  const manifest: Record<TableName, CoverageTableExpectation> = COVERAGE_EXPECTATIONS[competition];
  return {
    matches: manifest.matches.expected !== "absent",
    stats: manifest.player_match_stats.expected !== "absent",
    lineups: legacyAvailability(manifest.match_lineups),
    pav: legacyAvailability(manifest.player_season_pav),
  };
}

/** Generate the human competition year range from the canonical match expectation. */
export function competitionYears(competition: CoverageCompetition): string {
  return COVERAGE_EXPECTATIONS[competition].matches.range.replace(
    "..current",
    " to current season",
  );
}

/** Validated options passed from the schema tool boundary. */
export interface CoverageOptions {
  readonly includeObserved?: boolean;
  readonly competition?: CoverageCompetition | undefined;
  readonly season?: number | undefined;
}

interface RowObservation {
  readonly unit: "rows";
  readonly rows: number;
  readonly non_null: number;
  readonly null: number;
  readonly ratio: number | null;
}

interface TableRowsObservation {
  readonly unit: "table_rows";
  readonly rows: number;
}
interface MatchPresenceObservation {
  readonly unit: "match_presence";
  readonly total_matches: number;
  readonly matches_with_rows: number;
  readonly rows: number;
  readonly ratio: number | null;
}
/** Column-level deviation from a table default; only deviating keys are present. */
interface ColumnException {
  expected?: CoverageExpectation;
  range?: string;
}

/** Wire shape for one competition-table: a default plus exception columns. */
interface TableContract {
  readonly range: string;
  readonly expected: CoverageExpectation;
  readonly source: readonly string[];
  readonly notes?: readonly string[];
  readonly columns?: Readonly<Record<string, ColumnException>>;
}

type ContractCoverage = Record<string, TableContract>;

/**
 * One-paragraph reading key emitted with every contract response, so the
 * exceptions-only encoding is self-describing to an LLM consumer.
 */
export const COVERAGE_HOW_TO_READ =
  "Each table declares a default: `range` (inclusive season span; 'current' = latest season), " +
  "`expected` (complete | partial | best-effort | absent | not-applicable), and `source`. " +
  "The default applies to every column of that table. `columns` lists ONLY exceptions — a column " +
  "appears there when its `expected` or `range` deviates from the table default; any column not " +
  "listed has exactly the default coverage.";

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1_000_000) / 1_000_000;
}

/**
 * Project the canonical manifest into the exceptions-only wire shape.
 *
 * Contract v1 materialized every declared column so that omission could
 * never imply complete coverage; that made the response ~100 KB of
 * boilerplate leaves. v2 keeps the same guarantee by making omission
 * well-defined instead: the table default is explicit and `columns`
 * carries only deviations (see {@link COVERAGE_HOW_TO_READ}).
 */
export function contractCoverage(): Record<CoverageCompetition, ContractCoverage> {
  const output = {} as Record<CoverageCompetition, ContractCoverage>;
  for (const competition of COVERAGE_COMPETITIONS) {
    const tables: ContractCoverage = {};
    for (const table of Object.keys(ANALYTICS_COLUMNS) as TableName[]) {
      const spec: CoverageTableExpectation = COVERAGE_EXPECTATIONS[competition][table];
      const columns: Record<string, ColumnException> = {};
      for (const [column, expected] of Object.entries(spec.overrides ?? {})) {
        if (expected !== spec.expected) columns[column] = { expected };
      }
      for (const [column, range] of Object.entries(spec.ranges ?? {})) {
        if (range !== spec.range) columns[column] = { ...columns[column], range };
      }
      tables[table] = {
        range: spec.range,
        expected: spec.expected,
        source: spec.source,
        ...(spec.notes.length > 0 && { notes: spec.notes }),
        ...(Object.keys(columns).length > 0 && { columns }),
      };
    }
    output[competition] = tables;
  }
  return output;
}

const OBSERVED_STAT_COLUMNS = STAT_COLUMNS.filter(
  (column) => !["id", "match_id", "player_id", "team_id"].includes(column),
);

type NumericRow = Record<string, number>;

async function queryObservation(env: Env, competition: CoverageCompetition, season: number) {
  const seasonRow = await env.DB.prepare(
    "SELECT s.id FROM seasons s JOIN competitions c ON c.id = s.competition_id WHERE c.code = ? AND s.year = ?",
  )
    .bind(competition, season)
    .first<{ id: number }>();
  if (!seasonRow) throw new Error(`No ${competition} season ${season} exists`);

  const select = OBSERVED_STAT_COLUMNS.flatMap((column, index) => [
    `COUNT(${column}) AS n${index}`,
  ]).join(", ");
  const statRow = await env.DB.prepare(
    `SELECT COUNT(*) AS row_count, ${select} FROM player_match_stats WHERE match_id IN (SELECT id FROM matches WHERE season_id = ?)`,
  )
    .bind(seasonRow.id)
    .first<NumericRow>();
  const weather = await env.DB.prepare(
    "SELECT COUNT(*) AS row_count, COUNT(weather_temp_c) AS temperature_count, COUNT(weather_type) AS type_count FROM matches WHERE season_id = ?",
  )
    .bind(seasonRow.id)
    .first<NumericRow>();
  const pav = await env.DB.prepare(
    "SELECT COUNT(*) AS row_count FROM player_season_pav WHERE season_id = ?",
  )
    .bind(seasonRow.id)
    .first<NumericRow>();
  const lineups = await env.DB.prepare(
    "SELECT COUNT(*) AS row_count, COUNT(DISTINCT match_id) AS match_count FROM match_lineups WHERE match_id IN (SELECT id FROM matches WHERE season_id = ?)",
  )
    .bind(seasonRow.id)
    .first<NumericRow>();
  const matches = await env.DB.prepare(
    "SELECT COUNT(*) AS row_count FROM matches WHERE season_id = ?",
  )
    .bind(seasonRow.id)
    .first<NumericRow>();

  const rows = statRow?.row_count ?? 0;
  const scalar: Record<string, RowObservation> = {};
  for (const [index, column] of OBSERVED_STAT_COLUMNS.entries()) {
    const nonNull = statRow?.[`n${index}`] ?? 0;
    scalar[column] = {
      unit: "rows",
      rows,
      non_null: nonNull,
      null: rows - nonNull,
      ratio: ratio(nonNull, rows),
    };
  }
  const matchRows = weather?.row_count ?? 0;
  for (const [column, countKey] of [
    ["weather_temp_c", "temperature_count"],
    ["weather_type", "type_count"],
  ] as const) {
    const nonNull = weather?.[countKey] ?? 0;
    scalar[`matches.${column}`] = {
      unit: "rows",
      rows: matchRows,
      non_null: nonNull,
      null: matchRows - nonNull,
      ratio: ratio(nonNull, matchRows),
    };
  }
  return {
    measured_at: new Date().toISOString(),
    scalar,
    pav: { unit: "table_rows", rows: pav?.row_count ?? 0 } satisfies TableRowsObservation,
    lineups: {
      unit: "match_presence",
      total_matches: matches?.row_count ?? 0,
      matches_with_rows: lineups?.match_count ?? 0,
      rows: lineups?.row_count ?? 0,
      ratio: ratio(lineups?.match_count ?? 0, matches?.row_count ?? 0),
    } satisfies MatchPresenceObservation,
  };
}

/** Query one bounded competition-season observation, with a 15-minute Cache API entry. */
export async function observeCoverage(
  env: Env,
  competition: CoverageCompetition,
  season: number,
  cache: Cache | undefined = typeof caches === "undefined" ? undefined : caches.default,
) {
  const key = new Request(
    `https://coverage.internal/v${COVERAGE_CONTRACT_VERSION}/${competition}/${season}`,
  );
  const cached = await cache?.match(key);
  if (cached) return (await cached.json()) as Awaited<ReturnType<typeof queryObservation>>;
  const result = await queryObservation(env, competition, season);
  await cache?.put(
    key,
    new Response(JSON.stringify(result), { headers: { "Cache-Control": "max-age=900" } }),
  );
  return result;
}

/** Measured coverage for one competition-season, attached beside the static contract. */
interface ObservedBlock {
  readonly competition: CoverageCompetition;
  readonly season: number;
  readonly measured_at: string;
  readonly notes: readonly string[];
  readonly matches: Readonly<Record<string, RowObservation>>;
  readonly player_match_stats: Readonly<Record<string, RowObservation>>;
  readonly player_season_pav: TableRowsObservation;
  readonly match_lineups: MatchPresenceObservation;
}

/**
 * Return the static contract, optionally with one bounded competition-season
 * observation attached as a sibling `observed` block. Measurements never
 * mutate the static expectations — they are reported side by side.
 */
export async function coverageContract(options: CoverageOptions, env?: Env) {
  const byCompetition = contractCoverage();
  let observed: ObservedBlock | undefined;
  if (options.includeObserved && options.competition && options.season !== undefined) {
    if (!env) throw new Error("Database environment is required for observed coverage");
    const measured = await observeCoverage(env, options.competition, options.season);
    const matchColumns: Record<string, RowObservation> = {};
    const statColumns: Record<string, RowObservation> = {};
    for (const [key, value] of Object.entries(measured.scalar)) {
      const [qualifiedTable, qualifiedColumn] = key.split(".");
      if (qualifiedColumn && qualifiedTable === "matches") matchColumns[qualifiedColumn] = value;
      else statColumns[key] = value;
    }
    observed = {
      competition: options.competition,
      season: options.season,
      measured_at: measured.measured_at,
      notes: ["Measured; not a guarantee.", "Zero non-null counts cannot establish field absence."],
      matches: matchColumns,
      player_match_stats: statColumns,
      player_season_pav: measured.pav,
      match_lineups: measured.lineups,
    };
  }
  return {
    version: COVERAGE_CONTRACT_VERSION,
    review_date: COVERAGE_REVIEW_DATE,
    how_to_read: COVERAGE_HOW_TO_READ,
    by_competition: byCompetition,
    ...(observed && { observed }),
  };
}
