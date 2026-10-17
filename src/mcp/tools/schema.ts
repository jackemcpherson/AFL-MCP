import type { Env } from "../../types";
import {
  COVERAGE_COMPETITIONS,
  type ContractCoverage,
  type CoverageCompetition,
  type CoverageContract,
  type CoverageOptions,
  competitionYears,
  coverageContract,
  type LegacyCompetitionCoverage,
  legacyCompetitionCoverage,
} from "./coverage";

const COMPETITION_NAMES = {
  AFLM: "AFL Men's",
  AFLW: "AFL Women's",
  VFL: "Victorian Football League",
  VFLW: "VFL Women's",
} as const;

/** Name, year range and legacy availability for one competition. */
export interface CompetitionSummary {
  readonly name: string;
  readonly years: string;
  readonly coverage: LegacyCompetitionCoverage;
}

/**
 * The coverage contract as the schema tool returns it. A competition filter
 * keeps only that competition's `by_competition` entries, in both the
 * coverage and the coaching contract.
 */
export type SchemaCoverageContract = Omit<
  CoverageContract,
  "by_competition" | "coaching_contract"
> & {
  readonly coaching_contract: {
    readonly by_competition: Partial<CoverageContract["coaching_contract"]["by_competition"]>;
  };
  readonly by_competition: Partial<Record<CoverageCompetition, ContractCoverage>>;
};

/** A table documented by the `schema` tool. */
export type SchemaTable =
  | "competitions"
  | "seasons"
  | "season_provider_ids"
  | "player_provider_ids"
  | "player_id_redirects"
  | "teams"
  | "venues"
  | "players"
  | "matches"
  | "player_match_stats"
  | "player_season_pav"
  | "match_lineups"
  | "match_weather"
  | "match_predictions"
  | "coaches"
  | "coach_external_ids"
  | "coach_external_match_ids"
  | "coach_observations"
  | "match_coaches"
  | "public_input_revision";

/** A named example query in the `schema` tool response. */
/** A named example query in the `schema` tool response. */
export type CommonJoin =
  | "match_with_teams_venue"
  | "team_season_pav"
  | "player_career_arc"
  | "match_coaches_lookup"
  | "coaching_source_comparisons"
  | "lineup_round_comparison"
  | "wet_game_scoring"
  | "tipping_performance"
  | "ladder";

/**
 * The public database contract returned by the `schema` tool. Key order is
 * the reading order: the query API and cross-cutting rules come first, the
 * per-table reference next, and the coverage contract last.
 */
export interface SchemaInfo {
  readonly query_api: {
    readonly usage: string;
    readonly methods: readonly string[];
    readonly notes: string;
  };
  readonly database: {
    readonly engine: string;
    readonly competitions: Partial<Record<CoverageCompetition, CompetitionSummary>>;
    readonly notes: readonly string[];
    readonly tables: Readonly<Record<SchemaTable, string>>;
    readonly common_joins: Readonly<Record<CommonJoin, string>>;
    readonly coverage_contract: SchemaCoverageContract;
  };
}

function competitionSummaries<C extends CoverageCompetition>(
  competitions: readonly C[],
): Record<C, CompetitionSummary> {
  // SAFETY: the loop below assigns every competition in `competitions` before return.
  const summaries = {} as Record<C, CompetitionSummary>;
  for (const code of competitions) {
    summaries[code] = {
      name: COMPETITION_NAMES[code],
      years: competitionYears(code),
      coverage: legacyCompetitionCoverage(code),
    };
  }
  return summaries;
}

/**
 * Return the public database contract.
 *
 * Three shapes, matching the schema tool's parameter contract:
 * - No options: the full schema for all four competitions.
 * - `competition` alone: the base schema filtered to that competition —
 *   `database.competitions`, `coverage_contract.by_competition` and
 *   `coverage_contract.coaching_contract.by_competition` contain only that
 *   competition; tables, notes, and join examples are unchanged.
 * - `competition` + `season` + `includeObserved: true`: the full schema with
 *   one bounded competition-season observation overlaid.
 *
 * @param options - Validated options from the schema tool boundary.
 * @param env - Worker environment; required only for observed coverage.
 * @returns The schema document, filtered or overlaid as the options ask.
 * @throws {Error} When observed coverage is requested without `env`, or
 *   the observation fails.
 */
export async function getSchemaInfo(options: CoverageOptions = {}, env?: Env): Promise<SchemaInfo> {
  const coverage = await coverageContract(options, env);
  // `competition` without includeObserved filters the base schema (#141).
  const baseFilter = !options.includeObserved && options.competition ? options.competition : null;
  const coverageResponse = baseFilter
    ? {
        ...coverage,
        coaching_contract: {
          by_competition: {
            [baseFilter]: coverage.coaching_contract.by_competition[baseFilter],
          },
        },
        by_competition: { [baseFilter]: coverage.by_competition[baseFilter] },
      }
    : coverage;
  return {
    query_api: {
      usage: "Call these on `db` inside code-tool code. Bind values with ? placeholders.",
      methods: [
        "db.prepare(sql).bind(...args).all() — returns { results: Row[], success: boolean }",
        "db.prepare(sql).bind(...args).first() — returns first Row or null",
      ],
      notes: "Read-only. The code tool description lists the sandbox limits.",
    },
    database: {
      engine: "SQLite (Cloudflare D1)",
      competitions: competitionSummaries(baseFilter ? [baseFilter] : COVERAGE_COMPETITIONS),
      // Cross-cutting rules every query needs. Table-specific caveats sit with
      // their table in `tables`.
      notes: [
        "Competition filter path: JOIN seasons s ON m.season_id = s.id JOIN competitions c ON s.competition_id = c.id WHERE c.code = ?. Each competition has its own team rows (Carlton AFLM and Carlton VFL have distinct team_id values), so an unfiltered query silently mixes competitions and double-counts aggregates. One player_id can play in two competitions in one season (an AFLM-listed player in VFL), so resolve a stat row's competition through match → season → competition.",
        "Select seasons by seasons.season_key: 'YYYY', except AFLW 2022, which has two seasons, '2022-S6' and '2022-S7'. A year filter merges them.",
        "Rounds: `round` is the AFL API's long label, `round_abbreviation` its short form ('Rd N', 'OR', 'WC', 'FW1', 'QF', 'EF', 'SF', 'PF', 'GF'; unmapped finals names become 'F<round_number>'), `round_type` is 'Regular' or 'Finals', and `round_number` is a per-season ordinal continuous through finals. Numbered rounds are 'Round N', except AFLW 2024, whose home-and-away rounds are 'Week 1' to 'Week 10' (round_abbreviation 'Rd N', round_number 1-10), so never pick a numbered round by its `round` text. Opening Round (AFLM 2024+, round_number 0) precedes Round 1 and is a Regular round: include it. VFL's 'Wildcard' round before finals is also Regular. Finals names vary by competition and era ('Finals Week 1', 'Qualifying Final', 'Elimination Final', 'Semi Finals', 'Preliminary Finals', 'Grand Final', and from 2026 'Wildcard Finals' and 'Qualifying & Elimination Finals'), so select finals with round_type = 'Finals' and a specific final with `round`. round_number differs across competitions and seasons (AFLM 2024 finals are 25-28, AFLW 2025 finals 13-16, VFL 2025 Wildcard 22 then finals 23-26; AFLM R1 is March, AFLW R1 August, VFL R1 April): compare rounds within one season, or by date.",
        "Played matches have status = 'Complete'. 'Live' rows carry partial scores. 'Cancelled' rows (COVID-era VFL/VFLW 2021 and one AFLM 2015 match) were not played: their NULL scores mean cancelled, not missing, and a recorded score there is not a result.",
        "database.coverage_contract is canonical for which seasons, columns and sources are populated. Where a note seems to disagree, the contract wins.",
        "Integrity-check views v_integrity_disposals, v_integrity_clearances, v_integrity_match_points, v_integrity_quarter_scores, v_integrity_margin and v_integrity_brownlow return one row per invariant violation. An empty result means the invariant holds. Extra-time periods are not stored, so v_integrity_quarter_scores also lists matches decided in extra time, such as match 409 (AFLM 2017 Port Adelaide v West Coast), whose quarters legitimately sum short of the final score. Do not treat such a row as a scoring error.",
      ],
      tables: {
        competitions: "id INTEGER PRIMARY KEY, code TEXT (AFLM/AFLW/VFL/VFLW), name TEXT",
        seasons:
          "id INTEGER PRIMARY KEY, competition_id INTEGER REFERENCES competitions(id), year INTEGER, season_key TEXT (canonical selector, AFLW 2022-S6 or 2022-S7), display_name TEXT, is_complete INTEGER (1 when the season has matches and all have home_points, else 0)",
        season_provider_ids:
          "season_id INTEGER, provider TEXT, provider_season_id TEXT. Verified provider season mappings.",
        player_provider_ids:
          "provider TEXT, provider_id TEXT, player_id INTEGER, evidence_json TEXT. Provider identity crosswalk; names are not identity evidence.",
        player_id_redirects:
          "retired_id INTEGER, canonical_id INTEGER, manifest_digest TEXT. Maps a merged player's retired internal ID to its canonical ID. Resolve stored or external player IDs through it; issued predictions keep the IDs they were issued with.",
        teams: [
          "id INTEGER PRIMARY KEY, name TEXT,",
          "abbreviation TEXT (AFLM club codes: ADE, BB, BL, CARL, COLL, ESS, FITZ, FREO, GEEL, GCFC, GWS, HAW, MELB, NM, PORT, RICH, STK, SYD, WCE, WB. The sync creates teams without one, so AFLW, VFL and VFLW teams have NULL: label teams by name),",
          "competition_id INTEGER REFERENCES competitions(id).",
          "Historical AFLM clubs keep distinct team IDs to preserve source history: Brisbane Bears (through 1996), Fitzroy and Brisbane Lions. Rating models may carry ratings across the Bears-to-Lions transition.",
        ].join(" "),
        venues: [
          "id INTEGER PRIMARY KEY, name TEXT,",
          "latitude REAL, longitude REAL, timezone TEXT (IANA, e.g. Australia/Melbourne),",
          "roof TEXT ('retractable' for Marvel Stadium only, where rain may not reach the surface | 'none' | NULL unclassified),",
          "canonical_venue_id INTEGER REFERENCES venues(id) (sponsor renames create separate rows; this points to the physical ground: self when canonical, NULL until the sync classifies a new venue).",
          "Group by physical ground with JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id).",
        ].join(" "),
        players: [
          "id INTEGER PRIMARY KEY, first_name TEXT, surname TEXT, external_id TEXT,",
          "external_afl_player_id TEXT (AFL API CD_I ID),",
          "date_of_birth TEXT, height_cm INTEGER, weight_kg INTEGER, is_retired INTEGER (NULL=unknown; source-verified 0/1 only), legacy_is_retired INTEGER (unverified imported/defaulted flag; never infer current availability).",
          "A player has no team column: take the team per game from player_match_stats.team_id.",
          "Provider records resolve to one player_id through player_provider_ids, and merged duplicates through player_id_redirects. Names are never identity evidence, so same-name players can keep separate player_id values.",
        ].join(" "),
        matches: [
          "id INTEGER PRIMARY KEY, season_id INTEGER REFERENCES seasons(id),",
          "round TEXT, round_abbreviation TEXT, round_number INTEGER, round_type TEXT (see the rounds note),",
          "date TEXT (YYYY-MM-DD), local_time TEXT (Melbourne time HH:MM:SS for every competition; venue-local time is not stored), kickoff_at TEXT (nullable canonical UTC source instant), lineups_observed_at TEXT (nullable UTC lineup observation),",
          "venue_id INTEGER REFERENCES venues(id),",
          "home_team_id INTEGER REFERENCES teams(id),",
          "away_team_id INTEGER REFERENCES teams(id),",
          "home_goals INTEGER, home_behinds INTEGER, home_points INTEGER,",
          "away_goals INTEGER, away_behinds INTEGER, away_points INTEGER,",
          "margin INTEGER (home perspective: positive = home won; ABS(margin) for size), attendance INTEGER,",
          "external_afltables_id TEXT, external_fryzigg_id TEXT,",
          "external_afl_id TEXT,",
          "home_rushed_behinds INTEGER, away_rushed_behinds INTEGER,",
          "home_minutes_in_front INTEGER, away_minutes_in_front INTEGER,",
          "home_q1_goals INTEGER, home_q1_behinds INTEGER,",
          "home_q2_goals INTEGER, home_q2_behinds INTEGER,",
          "home_q3_goals INTEGER, home_q3_behinds INTEGER,",
          "home_q4_goals INTEGER, home_q4_behinds INTEGER,",
          "away_q1_goals INTEGER, away_q1_behinds INTEGER,",
          "away_q2_goals INTEGER, away_q2_behinds INTEGER,",
          "away_q3_goals INTEGER, away_q3_behinds INTEGER,",
          "away_q4_goals INTEGER, away_q4_behinds INTEGER,",
          "status TEXT ('Upcoming' | 'Live' | 'Complete' | 'Postponed' | 'Cancelled'; set on every row),",
          "live_period_status TEXT (opaque raw AFL API text such as 'LIVE', 'POSTGAME', 'CONCLUDED'; it stays 'LIVE' through quarter breaks),",
          "completed_quarter INTEGER (highest fully completed quarter from the AFL API clock: 0 before the first ends, 1-4 after; NULL when no clock was supplied or the row predates refresh. Pair it with status. Five-minute-sync context, not a live siren signal)",
        ].join(" "),
        player_match_stats: [
          "id INTEGER PRIMARY KEY, match_id INTEGER REFERENCES matches(id),",
          "player_id INTEGER REFERENCES players(id),",
          "team_id INTEGER REFERENCES teams(id),",
          "guernsey_number INTEGER, player_position TEXT,",
          "subbed TEXT ('Not Subbed' | 'Subbed In' | 'Subbed Out' | NULL), time_on_ground_pct REAL,",
          "kicks INTEGER, handballs INTEGER, disposals INTEGER,",
          "effective_disposals INTEGER, disposal_efficiency_pct REAL,",
          "marks INTEGER, bounces INTEGER, tackles INTEGER,",
          "one_percenters INTEGER, clangers INTEGER,",
          "contested_possessions INTEGER, uncontested_possessions INTEGER,",
          "goals INTEGER, behinds INTEGER, goal_assists INTEGER,",
          "shots_at_goal INTEGER, score_involvements INTEGER,",
          "score_launches INTEGER,",
          "centre_clearances INTEGER, stoppage_clearances INTEGER, clearances INTEGER,",
          "contested_marks INTEGER, marks_inside_fifty INTEGER,",
          "intercept_marks INTEGER, marks_on_lead INTEGER,",
          "free_kicks_for INTEGER, free_kicks_against INTEGER,",
          "hitouts INTEGER, hitouts_to_advantage INTEGER,",
          "hitout_win_pct REAL, ruck_contests INTEGER,",
          "inside_fifties INTEGER, rebounds INTEGER,",
          "turnovers INTEGER, intercepts INTEGER, metres_gained INTEGER (can be negative: net territory lost),",
          "pressure_acts INTEGER, def_half_pressure_acts INTEGER,",
          "tackles_inside_fifty INTEGER, spoils INTEGER,",
          "contest_def_losses INTEGER, contest_def_one_on_ones INTEGER,",
          "contest_off_one_on_ones INTEGER, contest_off_wins INTEGER,",
          "effective_kicks INTEGER, ground_ball_gets INTEGER,",
          "f50_ground_ball_gets INTEGER,",
          "brownlow_votes INTEGER, rating_points REAL,",
          "afl_fantasy_score INTEGER, supercoach_score INTEGER,",
          "goal_accuracy REAL, goal_efficiency REAL, shot_efficiency REAL,",
          "kick_efficiency REAL, kick_to_handball_ratio REAL,",
          "contested_possession_rate REAL,",
          "contest_def_loss_pct REAL, contest_off_wins_pct REAL,",
          "centre_bounce_attendances INTEGER, kickins INTEGER,",
          "kickins_playon INTEGER, interchange_counts INTEGER,",
          "total_possessions INTEGER",
        ].join(" "),
        player_season_pav: [
          "id INTEGER PRIMARY KEY,",
          "player_id INTEGER REFERENCES players(id),",
          "season_id INTEGER REFERENCES seasons(id),",
          "team_id INTEGER REFERENCES teams(id),",
          "off_pav REAL (offence: goals, score involvements, forward craft), mid_pav REAL (midfield: disposals, clearances, tackles, contested ball), def_pav REAL (defence: intercepts, spoils, one-percenters, rebounds), total_pav REAL.",
          "total_pav ≈ off_pav + mid_pav + def_pav: each is rounded independently, so about a third of rows differ by ±0.01.",
          "AFLM scale: 25+ exceptional (Brownlow contention), 20-25 great (All-Australian), 15-20 very good (best-22), 10-15 solid contributor, 5-10 below average or limited games, <5 minimal. AFLW totals run lower (shorter games, smaller squads).",
          "Derived only for some competition-seasons (see coverage_contract), so LEFT JOIN it to player_match_stats. Missing season inputs leave values NULL; cancelled and live matches are excluded.",
        ].join(" "),
        match_lineups: [
          "id INTEGER PRIMARY KEY,",
          "match_id INTEGER REFERENCES matches(id),",
          "player_id INTEGER REFERENCES players(id),",
          "team_id INTEGER REFERENCES teams(id),",
          "guernsey_number INTEGER,",
          "position TEXT (18 field positions FB, BPL, BPR, CHB, HBFL, HBFR, C, WL, WR, R, RR, RK, HFFL, HFFR, CHF, FPL, FPR, FF; INT interchange; SUB medical substitute; EMERG emergency),",
          "is_emergency INTEGER (1 = named emergency, may not play),",
          "is_substitute INTEGER (1 = the medical substitute, position 'SUB').",
          "Rows are the team after late changes, plus named emergencies. No rows for a match means not yet published.",
        ].join(" "),
        match_weather: [
          "match_id INTEGER REFERENCES matches(id),",
          "kind TEXT ('forecast' = pre-match forecast, refreshed in place and kept after the match for forecast-error checks | 'observed' = post-match value),",
          "temp_c REAL (deg C, mean), precip_mm REAL (mm, total),",
          "precip_24h_prior_mm REAL (mm, total over the 24h before the match window; ground condition, separate from in-game rain),",
          "wind_speed_kmh REAL (km/h, max), wind_gust_kmh REAL (km/h, max), humidity_pct REAL (%, mean),",
          "source TEXT ('era5_land+era5' = final reanalysis, temp/humidity/wind from ERA5-Land and precipitation from ERA5 | 'historical_forecast' = interim observed value, replaced by reanalysis within about a week | 'best_match' = forecast rows),",
          "fetched_at TEXT (UTC ISO 8601),",
          "PRIMARY KEY (match_id, kind).",
          "Metrics cover the 3h match window from scheduled start. Values are ambient conditions: discount rain yourself at roofed venues (venues.roof). Cancelled matches and the 'To Be Confirmed' placeholder venue get no rows. Data: Open-Meteo (CC-BY 4.0).",
        ].join(" "),
        match_predictions: [
          "match_id INTEGER PRIMARY KEY REFERENCES matches(id),",
          "tipper_run_id INTEGER (prospective capture run; NULL for backfilled rows), home_win_prob REAL (0..1),",
          "predicted_margin REAL (points, one decimal; positive = home favoured),",
          "model_version TEXT (production model identity and full source revision),",
          "generated_at TEXT (UTC ISO 8601, actual generation time).",
          "One retained row per match, combining chronological season backfill with real-time Tipper predictions: read both together for season performance, and LEFT JOIN to report missing predictions. Both values take the HOME team's perspective. The tipped winner is home when home_win_prob >= 0.5, else away (not the rounded margin).",
        ].join(" "),
        coaches:
          "id TEXT PRIMARY KEY, display_name TEXT, profile_url TEXT, created_at TEXT. Coach IDs are provider-qualified unless a cross-provider match has been explicitly verified.",
        coach_external_ids:
          "provider TEXT, external_coach_id TEXT, coach_id TEXT REFERENCES coaches(id), display_name TEXT, profile_url TEXT, verified INTEGER, PRIMARY KEY (provider, external_coach_id)",
        coach_external_match_ids:
          "provider TEXT, external_match_id TEXT, match_id INTEGER REFERENCES matches(id), PRIMARY KEY (provider, external_match_id)",
        coach_observations:
          "id INTEGER PRIMARY KEY, provider TEXT ('afl-tables' | 'footywire'), external_coach_id TEXT, external_match_id TEXT, coach_id TEXT, match_id INTEGER, team_id INTEGER, season INTEGER, source_url TEXT, retrieved_at TEXT, match_date TEXT, display_name TEXT, raw_team TEXT, home_points INTEGER, away_points INTEGER. Keeps each provider's evidence independently. FootyWire is comparison-only and never replaces the canonical AFL Tables assignment; source disagreements stay queryable here.",
        match_coaches:
          "match_id INTEGER REFERENCES matches(id), team_id INTEGER REFERENCES teams(id), coach_id TEXT REFERENCES coaches(id), observation_id INTEGER REFERENCES coach_observations(id), updated_at TEXT, PRIMARY KEY (match_id, team_id). Canonical AFL Tables assignments: at most one credited coach per match and participant club. LEFT JOIN it to keep unknown assignments.",
        public_input_revision:
          "id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER, in_progress INTEGER, write_started_at TEXT, write_holder TEXT (opaque operation ownership), write_operation TEXT (resumable operation identity). A monotonic input-change marker: revision changes for meaningful match result or canonical coach changes. Read revision, in_progress and write_started_at before and after a native snapshot; retry on a revision difference or any active write. The scheduled sync resumes a marker left by its own interrupted run on the next tick; any other stale marker requires operator recovery after checking the shared lease and incomplete work. Last-check timestamps, secondary observations, diagnostics and coverage checks do not change the revision.",
      },
      // Patterns a model would not write correctly from the column list alone.
      // Every example binds the competition first.
      common_joins: {
        match_with_teams_venue: [
          "-- Base pattern: competition filter plus team and venue names.",
          "-- Bind: competition, canonical season key",
          "SELECT m.date, m.round, ht.name as home_team, at.name as away_team,",
          "  m.home_points, m.away_points, m.margin, v.name as venue",
          "FROM matches m",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams ht ON m.home_team_id = ht.id",
          "JOIN teams at ON m.away_team_id = at.id",
          "JOIN venues v ON m.venue_id = v.id",
          "WHERE c.code = ? AND s.season_key = ?",
        ].join("\n"),
        team_season_pav: [
          "-- Bind: competition, team name, canonical season key.",
          "-- Drop the team filter and add LIMIT 20 for league-wide leaders.",
          "SELECT p.first_name, p.surname, t.name AS team,",
          "  psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav",
          "FROM player_season_pav psp",
          "JOIN players p ON psp.player_id = p.id",
          "JOIN seasons s ON psp.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams t ON psp.team_id = t.id",
          "WHERE c.code = ? AND t.name = ? AND s.season_key = ?",
          "ORDER BY psp.total_pav DESC",
        ].join("\n"),
        player_career_arc: [
          "-- One row per season. season_key keeps AFLW 2022-S6 and 2022-S7 apart.",
          "-- Bind: competition, player_id",
          "SELECT s.year, s.season_key, SUM(pms.disposals) as total_disposals, SUM(pms.goals) as total_goals,",
          "  COUNT(*) as games, psp.total_pav, psp.off_pav, psp.mid_pav, psp.def_pav",
          "FROM player_match_stats pms",
          "JOIN matches m ON pms.match_id = m.id",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "LEFT JOIN player_season_pav psp ON psp.player_id = pms.player_id AND psp.season_id = s.id",
          "WHERE c.code = ? AND pms.player_id = ?",
          "GROUP BY s.id, psp.total_pav, psp.off_pav, psp.mid_pav, psp.def_pav",
          "ORDER BY s.year, s.season_key",
        ].join("\n"),
        match_coaches_lookup: [
          "-- Bind: competition, canonical season key",
          "SELECT m.id AS match_id, m.date, m.round, ht.name AS home_team, at.name AS away_team,",
          "  home_coach.display_name AS home_coach, away_coach.display_name AS away_coach,",
          "  home_coach.id AS home_coach_id, away_coach.id AS away_coach_id",
          "FROM matches m",
          "JOIN seasons s ON s.id = m.season_id",
          "JOIN competitions c ON c.id = s.competition_id",
          "JOIN teams ht ON ht.id = m.home_team_id",
          "JOIN teams at ON at.id = m.away_team_id",
          "LEFT JOIN match_coaches hm ON hm.match_id = m.id AND hm.team_id = m.home_team_id",
          "LEFT JOIN coaches home_coach ON home_coach.id = hm.coach_id",
          "LEFT JOIN match_coaches am ON am.match_id = m.id AND am.team_id = m.away_team_id",
          "LEFT JOIN coaches away_coach ON away_coach.id = am.coach_id",
          "WHERE c.code = ? AND s.season_key = ?",
          "ORDER BY m.date, m.id",
        ].join("\n"),
        coaching_source_comparisons: [
          "-- AFL Tables vs FootyWire evidence for one AFLM season.",
          "-- Bind: canonical season key",
          "SELECT primary_obs.match_date, primary_obs.raw_team AS team,",
          "  primary_obs.display_name AS afl_tables_coach, secondary_obs.display_name AS footywire_coach,",
          "  primary_obs.source_url AS afl_tables_evidence, secondary_obs.source_url AS footywire_evidence",
          "FROM coach_observations primary_obs",
          "JOIN coach_observations secondary_obs ON secondary_obs.match_id = primary_obs.match_id",
          "  AND secondary_obs.team_id = primary_obs.team_id AND secondary_obs.provider = 'footywire'",
          "WHERE primary_obs.provider = 'afl-tables' AND primary_obs.season = ?",
          "  AND primary_obs.coach_id <> secondary_obs.coach_id",
          "ORDER BY primary_obs.match_date, team",
        ].join("\n"),
        lineup_round_comparison: [
          "-- Ins and outs for one team between two matches, emergencies excluded.",
          "-- Pick the match ids by date: a round can hold two of a team's matches (double-game weeks, the 2010 Grand Final replay).",
          "-- Bind: competition, team name, current match id, previous match id",
          "WITH pick AS (SELECT ? AS code, ? AS team, ? AS cur_id, ? AS prev_id),",
          "lu AS (",
          "  SELECT ml.match_id, ml.player_id, ml.position, m.date,",
          "    CASE WHEN ml.match_id = pick.cur_id THEN 'cur' ELSE 'prev' END AS side",
          "  FROM pick",
          "  JOIN match_lineups ml ON ml.match_id IN (pick.cur_id, pick.prev_id)",
          "  JOIN matches m ON ml.match_id = m.id",
          "  JOIN seasons s ON m.season_id = s.id",
          "  JOIN competitions c ON s.competition_id = c.id",
          "  JOIN teams t ON ml.team_id = t.id",
          "  WHERE c.code = pick.code AND t.name = pick.team AND ml.is_emergency = 0",
          ")",
          "SELECT CASE a.side WHEN 'cur' THEN 'IN' ELSE 'OUT' END AS change,",
          "  a.player_id, p.first_name, p.surname, a.position, a.match_id, a.date",
          "FROM lu a JOIN players p ON p.id = a.player_id",
          "WHERE NOT EXISTS (SELECT 1 FROM lu b WHERE b.player_id = a.player_id AND b.side <> a.side)",
          "ORDER BY change, p.surname",
        ].join("\n"),
        wet_game_scoring: [
          "-- Observed weather via the canonical venue, excluding roofed and unclassified grounds.",
          "-- Bind: competition",
          "SELECT s.year, m.date, ht.name AS home_team, at.name AS away_team,",
          "  m.home_points + m.away_points AS total_points,",
          "  w.precip_mm, w.precip_24h_prior_mm",
          "FROM matches m",
          "JOIN match_weather w ON w.match_id = m.id AND w.kind = 'observed'",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams ht ON m.home_team_id = ht.id",
          "JOIN teams at ON m.away_team_id = at.id",
          "JOIN venues v ON m.venue_id = v.id",
          "JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id)",
          "WHERE c.code = ? AND m.status = 'Complete'",
          "  AND w.precip_mm >= 2.0 AND cv.roof = 'none'",
          "ORDER BY w.precip_mm DESC",
        ].join("\n"),
        tipping_performance: [
          "-- Bind: competition, canonical season key. Includes retained backfill and real-time predictions.",
          "-- accuracy_pct excludes draws; draws and decisive_matches count predicted games;",
          "-- margin_mae includes covered draws; through_date is the latest scored prediction date.",
          "WITH summary AS (",
          "  SELECT c.code AS competition, s.year, COUNT(*) AS completed_matches,",
          "    COUNT(mp.match_id) AS predictions, COUNT(*) - COUNT(mp.match_id) AS missing_predictions,",
          "    SUM(CASE WHEN (mp.home_win_prob >= 0.5 AND m.home_points > m.away_points)",
          "      OR (mp.home_win_prob < 0.5 AND m.away_points > m.home_points) THEN 1 ELSE 0 END) AS correct_winners,",
          "    SUM(CASE WHEN mp.match_id IS NOT NULL AND m.home_points != m.away_points THEN 1 ELSE 0 END) AS decisive_matches,",
          "    SUM(CASE WHEN mp.match_id IS NOT NULL AND m.home_points = m.away_points THEN 1 ELSE 0 END) AS draws,",
          "    AVG(ABS(mp.predicted_margin - (m.home_points - m.away_points))) AS margin_mae,",
          "    MAX(CASE WHEN mp.match_id IS NOT NULL THEN m.date END) AS through_date",
          "  FROM matches m JOIN seasons s ON s.id = m.season_id",
          "  JOIN competitions c ON c.id = s.competition_id",
          "  LEFT JOIN match_predictions mp ON mp.match_id = m.id",
          "  WHERE c.code = ? AND s.season_key = ? AND m.status = 'Complete'",
          "    AND m.home_points >= 0 AND m.away_points >= 0",
          "  GROUP BY c.code, s.year",
          ") SELECT *, 100.0 * correct_winners / NULLIF(decisive_matches, 0) AS accuracy_pct FROM summary",
        ].join("\n"),
        ladder: [
          "-- Home-and-away ladder: played Regular rounds, including Opening Round, excluding VFL's Wildcard.",
          "-- Derived from played results only. It applies no administrative adjustments, so it can differ from the official ladder:",
          "-- in AFLM 2015 Adelaide and Geelong each got 2 points for their cancelled match, and in AFLM 2013 Essendon was officially ranked 9th.",
          "-- Bind: competition, canonical season key",
          "SELECT t.name AS team,",
          "  COUNT(*) AS played,",
          "  SUM(CASE WHEN (m.home_team_id = t.id AND m.home_points > m.away_points) OR (m.away_team_id = t.id AND m.away_points > m.home_points) THEN 1 ELSE 0 END) AS wins,",
          "  SUM(CASE WHEN (m.home_team_id = t.id AND m.home_points < m.away_points) OR (m.away_team_id = t.id AND m.away_points < m.home_points) THEN 1 ELSE 0 END) AS losses,",
          "  SUM(CASE WHEN m.home_points = m.away_points THEN 1 ELSE 0 END) AS draws,",
          "  SUM(CASE WHEN m.home_team_id = t.id THEN m.home_points ELSE m.away_points END) AS points_for,",
          "  SUM(CASE WHEN m.home_team_id = t.id THEN m.away_points ELSE m.home_points END) AS points_against,",
          "  ROUND(100.0 * SUM(CASE WHEN m.home_team_id = t.id THEN m.home_points ELSE m.away_points END) / NULLIF(SUM(CASE WHEN m.home_team_id = t.id THEN m.away_points ELSE m.home_points END), 0), 1) AS percentage,",
          "  SUM(CASE WHEN (m.home_team_id = t.id AND m.home_points > m.away_points) OR (m.away_team_id = t.id AND m.away_points > m.home_points) THEN 4 WHEN m.home_points = m.away_points THEN 2 ELSE 0 END) AS premiership_points",
          "FROM teams t",
          "JOIN competitions c ON t.competition_id = c.id",
          "JOIN matches m ON t.id = m.home_team_id OR t.id = m.away_team_id",
          "JOIN seasons s ON m.season_id = s.id",
          "WHERE c.code = ? AND s.season_key = ? AND m.round_type = 'Regular' AND m.round <> 'Wildcard'",
          "  AND m.status = 'Complete'",
          "GROUP BY t.id",
          "ORDER BY premiership_points DESC, percentage DESC",
        ].join("\n"),
      },
      coverage_contract: coverageResponse,
    },
  };
}
