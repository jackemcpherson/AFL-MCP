import type { Env } from "../../types";
import {
  COVERAGE_COMPETITIONS,
  type CoverageCompetition,
  type CoverageOptions,
  competitionYears,
  coverageContract,
  legacyCompetitionCoverage,
} from "./coverage";

const LEGACY_COVERAGE_PATHS = [
  ["matches.attendance", "matches", "attendance"],
  ["matches.weather_temp_c", "matches", "weather_temp_c"],
  ["matches.weather_type", "matches", "weather_type"],
  ["matches.home_q1_goals_through_away_q4_behinds", "matches", "home_q1_goals"],
  ["player_match_stats.brownlow_votes", "player_match_stats", "brownlow_votes"],
  ["player_match_stats.supercoach_score", "player_match_stats", "supercoach_score"],
  ["player_match_stats.afl_fantasy_score", "player_match_stats", "afl_fantasy_score"],
  ["player_match_stats.subbed", "player_match_stats", "subbed"],
  ["player_match_stats.disposal_efficiency_pct", "player_match_stats", "disposal_efficiency_pct"],
  ["player_match_stats.score_involvements", "player_match_stats", "score_involvements"],
  ["player_match_stats.metres_gained", "player_match_stats", "metres_gained"],
  ["player_match_stats.intercepts", "player_match_stats", "intercepts"],
  ["player_match_stats.pressure_acts", "player_match_stats", "pressure_acts"],
  ["player_match_stats.goal_assists", "player_match_stats", "goal_assists"],
  ["player_match_stats.marks_inside_fifty", "player_match_stats", "marks_inside_fifty"],
  ["player_match_stats.one_percenters", "player_match_stats", "one_percenters"],
  ["player_season_pav.*", "player_season_pav", "*"],
  ["match_weather.*", "match_weather", "match_id"],
  ["match_predictions.*", "match_predictions", "match_id"],
  ["venues.geodata", "venues", "latitude"],
] as const;

function legacyCoverageEntry(ranges: Record<string, { readonly notes: readonly string[] }>) {
  const entry = Object.entries(ranges)[0];
  const [fromRaw = "all", toRaw = fromRaw] = (entry?.[0] ?? "all").split("..");
  const parseBound = (value: string): number | string =>
    /^\d{4}$/.test(value) ? Number(value) : value;
  return {
    from: parseBound(fromRaw),
    to: parseBound(toRaw),
    notes: entry?.[1].notes.join(" ") || "See database.coverage_contract.",
  };
}

const COMPETITION_NAMES = {
  AFLM: "AFL Men's",
  AFLW: "AFL Women's",
  VFL: "Victorian Football League",
  VFLW: "VFL Women's",
} as const;

interface CompetitionSummary {
  readonly name: string;
  readonly years: string;
  readonly coverage: ReturnType<typeof legacyCompetitionCoverage>;
}

function competitionSummaries<C extends CoverageCompetition>(
  competitions: readonly C[],
): Record<C, CompetitionSummary> {
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
 *   `database.competitions` and `coverage_contract.by_competition` contain
 *   only that competition; tables, notes, and join examples are unchanged.
 * - `competition` + `season` + `includeObserved: true`: the full schema with
 *   one bounded competition-season observation overlaid.
 *
 * @param options - Validated options from the schema tool boundary.
 * @param env - Worker environment; required only for observed coverage.
 */
export async function getSchemaInfo(options: CoverageOptions = {}, env?: Env) {
  const coverage = await coverageContract(options, env);
  // `competition` without includeObserved filters the base schema (#141).
  const baseFilter = !options.includeObserved && options.competition ? options.competition : null;
  const coverageResponse = baseFilter
    ? {
        version: coverage.version,
        by_competition: { [baseFilter]: coverage.by_competition[baseFilter] },
      }
    : coverage;
  return {
    database: {
      engine: "SQLite (Cloudflare D1)",
      competitions: competitionSummaries(baseFilter ? [baseFilter] : COVERAGE_COMPETITIONS),
      coverage_contract: coverageResponse,
      tables: {
        competitions: "id INTEGER PRIMARY KEY, code TEXT (AFLM/AFLW/VFL/VFLW), name TEXT",
        seasons:
          "id INTEGER PRIMARY KEY, competition_id INTEGER REFERENCES competitions(id), year INTEGER, is_complete INTEGER (0=in-progress, 1=all matches played)",
        teams:
          "id INTEGER PRIMARY KEY, name TEXT, abbreviation TEXT, competition_id INTEGER REFERENCES competitions(id)",
        venues: [
          "id INTEGER PRIMARY KEY, name TEXT,",
          "latitude REAL, longitude REAL, timezone TEXT (IANA, e.g. Australia/Melbourne),",
          "roof TEXT ('retractable' | 'none'),",
          "canonical_venue_id INTEGER REFERENCES venues(id) (alias -> physical ground; self when canonical)",
        ].join(" "),
        players: [
          "id INTEGER PRIMARY KEY, first_name TEXT, surname TEXT, external_id TEXT,",
          "external_afl_player_id TEXT,",
          "date_of_birth TEXT, height_cm INTEGER, weight_kg INTEGER, is_retired INTEGER",
        ].join(" "),
        matches: [
          "id INTEGER PRIMARY KEY, season_id INTEGER REFERENCES seasons(id),",
          "round TEXT, round_abbreviation TEXT, round_number INTEGER, round_type TEXT,",
          "date TEXT, local_time TEXT,",
          "venue_id INTEGER REFERENCES venues(id),",
          "home_team_id INTEGER REFERENCES teams(id),",
          "away_team_id INTEGER REFERENCES teams(id),",
          "home_goals INTEGER, home_behinds INTEGER, home_points INTEGER,",
          "away_goals INTEGER, away_behinds INTEGER, away_points INTEGER,",
          "margin INTEGER, attendance INTEGER,",
          "weather_temp_c REAL, weather_type TEXT,",
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
          "status TEXT, live_period_status TEXT,",
          "completed_quarter INTEGER (NULL or 0-4; highest fully completed quarter)",
        ].join(" "),
        player_match_stats: [
          "id INTEGER PRIMARY KEY, match_id INTEGER REFERENCES matches(id),",
          "player_id INTEGER REFERENCES players(id),",
          "team_id INTEGER REFERENCES teams(id),",
          "guernsey_number INTEGER, player_position TEXT,",
          "subbed TEXT, time_on_ground_pct REAL,",
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
          "turnovers INTEGER, intercepts INTEGER, metres_gained INTEGER,",
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
          "off_pav REAL, mid_pav REAL, def_pav REAL, total_pav REAL",
        ].join(" "),
        match_lineups: [
          "id INTEGER PRIMARY KEY,",
          "match_id INTEGER REFERENCES matches(id),",
          "player_id INTEGER REFERENCES players(id),",
          "team_id INTEGER REFERENCES teams(id),",
          "guernsey_number INTEGER, position TEXT,",
          "is_emergency INTEGER (0=no, 1=yes),",
          "is_substitute INTEGER (0=no, 1=yes)",
        ].join(" "),
        match_weather: [
          "match_id INTEGER REFERENCES matches(id),",
          "kind TEXT ('observed' | 'forecast'),",
          "temp_c REAL (deg C, mean over the 3h match window),",
          "precip_mm REAL (mm, total over the 3h match window),",
          "precip_24h_prior_mm REAL (mm, total over the 24h before the match window; ground condition),",
          "wind_speed_kmh REAL (km/h, max over the 3h match window),",
          "wind_gust_kmh REAL (km/h, max over the 3h match window),",
          "humidity_pct REAL (%, mean over the 3h match window),",
          "source TEXT ('era5_land+era5' | 'historical_forecast' | 'best_match'),",
          "fetched_at TEXT (UTC ISO 8601),",
          "PRIMARY KEY (match_id, kind)",
        ].join(" "),
        match_predictions: [
          "match_id INTEGER PRIMARY KEY REFERENCES matches(id),",
          "home_win_prob REAL (0..1, home team's win probability),",
          "predicted_margin REAL (points, one decimal; positive = home favoured),",
          "model_version TEXT (tipper config id, e.g. 'predha-080 (2641f46f)'),",
          "generated_at TEXT (UTC ISO 8601)",
        ].join(" "),
      },
      notes: [
        // Multi-competition rules — read first
        "ALWAYS filter queries by competition. Join `seasons s ON m.season_id = s.id` then `competitions c ON s.competition_id = c.id` and add `WHERE c.code = ?`. Without this filter, results mix competitions silently — team rows with the same name (e.g. Carlton AFLM vs Carlton VFL) have distinct team_id values, so unfiltered aggregates double-count.",
        "Coverage expectations, exact ranges, sources, and review dates are canonical in database.coverage_contract. Descriptive notes never override that typed contract.",
        // Round labels — competition-specific
        "Round labels: matches has TWO round-string columns mirroring the AFL API directly (same approach as the R fitzRoy package — no cross-competition normalisation):",
        "- `round` is the long form: `Round 1`–`Round N`, `Opening Round` (AFLM 2024+, round_number=0), `Wildcard` (VFL only, before finals), and finals `Finals Week 1` / `Semi Finals` / `Preliminary Finals` / `Grand Final`.",
        "- `round_abbreviation` is the AFL's short form: `Rd 1`–`Rd N`, `OR`, `WC`, `FW1`, `SF`, `PF`, `GF`. Stable across all four competitions; useful for compact display and abbreviation-based filters.",
        "- `round_number` is a per-season ordinal: continuous through regular and finals (e.g. AFLM 2024 finals are 25–28; AFLW 2025 finals are 13–16; VFL 2025 has Wildcard at 22 then finals 23–26). Round numbers don't align across competitions — AFLM R1 is March, AFLW R1 is August, VFL R1 is April.",
        "- `round_type` is `Regular` (home-and-away + Opening Round + Wildcard) or `Finals`.",
        "Pre-v3.0.0 historical data may still have legacy `EF`/`QF`/`SF`/`PF`/`GF` strings in `round` for AFLM finals 2012–2025; these get rewritten to the long form on the next backfill.",
        "round_type is either 'Regular' or 'Finals'. For granular finals identification use the round column.",
        "Opening Round (round_number=0, only present for AFLM 2024+) is played before Round 1 and must not be excluded from queries.",
        "AFLM 2012–2025 finals labels were rewritten in v3.0.0 to match fitzroy v2.1's labels; legacy `EF/QF/SF/PF/GF` no longer appears in the data.",
        // Players + teams
        "Players have no team_id column — a player's team is determined per-game via player_match_stats.team_id. The same player_id can appear in multiple competitions in the same season (e.g. an AFLM-listed reserves player who also plays VFL games for the affiliate); resolve their competition per stat row via match → season → competition.",
        // PAV semantics
        "total_pav ≈ off_pav + mid_pav + def_pav. ~12-15% of rows differ by exactly ±0.01 because each component is rounded independently. Treat the relationship as approximate, not exact.",
        "PAV zone meanings: off_pav = offensive (goals, score involvements, forward craft); mid_pav = midfield (disposals, clearances, tackles, contested ball); def_pav = defensive (intercepts, spoils, one-percenters, rebounds).",
        "PAV interpretation (AFLM scale): 25+ exceptional (Brownlow contention), 20-25 great (All-Australian), 15-20 very good (team best-22), 10-15 solid contributor, 5-10 below average or limited games, <5 minimal contribution. AFLW PAV is on a similar but lower-totals scale because of shorter games and smaller squads.",
        "Use LEFT JOIN when combining player_season_pav with player_match_stats because PAV is not applicable to every competition-season.",
        // Format
        "match date format is ISO 8601 (YYYY-MM-DD).",
        "matches.margin is signed from the home team's perspective: positive = home team won by that many points, negative = away team won. Use ABS(margin) for absolute margin.",
        "teams.abbreviation: AFL standard 2–4 letter codes for AFLM (ADE, BL, CARL, COLL, ESS, FITZ, FREO, GEEL, GCFC, GWS, HAW, MELB, NM, PORT, RICH, STK, SYD, WCE, WB). May be NULL for AFLW/VFL/VFLW teams sourced from fitzroy.",
        // Value semantics; coverage and ranges live only in coverage_contract.
        "external_afl_player_id is the AFL API player ID (CD_I format).",
        "metres_gained can be negative (valid — player lost net territory). Minimum observed: -92.",
        "subbed values are 'Not Subbed' and 'Subbed'.",
        "local_time is Melbourne local time (AEST/AEDT) as HH:MM:SS for every competition; venue-native time is intentionally not stored.",
        "matches.status lifecycle values are 'Upcoming', 'Live', 'Complete', 'Postponed', and 'Cancelled'.",
        "matches.live_period_status is opaque raw AFL API text; observed values include 'LIVE', 'QTR_TIME', 'HALF_TIME', '3QTR_TIME', and 'FULL_TIME'.",
        "matches.completed_quarter is the highest fully completed quarter from the AFL API match clock: 0 means play has not completed a quarter, 1-4 identify the last completed quarter, and NULL means no clock was supplied or the row predates refresh. Pair it with status; it is five-minute-sync context, not a live siren SLA.",
        // Weather
        "match_weather: up to two rows per match, keyed (match_id, kind). kind='forecast' is the pre-match Open-Meteo forecast, overwritten in place per refresh and KEPT after the match (compare with observed for forecast error); kind='observed' is the post-match value.",
        "match_weather window: metrics cover the 3h from scheduled start — temp_c/humidity_pct are means, precip_mm a total, wind_speed_kmh/wind_gust_kmh maxima. precip_24h_prior_mm is rainfall in the 24h BEFORE the window (ground condition, separate from in-game rain).",
        "match_weather.source: 'era5_land+era5' = final reanalysis (temp/humidity/wind from ERA5-Land, precipitation from ERA5); 'historical_forecast' = interim observed value, upgraded to reanalysis within ~a week; 'best_match' = forecast rows. Data from Open-Meteo (CC-BY 4.0).",
        "DO NOT MIX legacy matches.weather_temp_c/weather_type with match_weather: they are a frozen fryzigg record (AFLM 2010-2025 only) and weather_temp_c is a DAILY-MAX, not a match-window mean. Use match_weather for weather analysis; the legacy columns remain only as the historical label record (e.g. ROOF_CLOSED).",
        "Venue aliases: sponsor renames create separate venues rows; venues.canonical_venue_id points to the physical ground (self for canonical rows). Group by physical venue via JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id).",
        "venues.roof = 'retractable' (Marvel Stadium only) flags grounds where rain may never reach the surface; match_weather always stores ambient conditions, so discount them yourself for roofed venues. Cancelled matches and the 'To Be Confirmed' placeholder venue (id 17748, NULL geodata) never get match_weather rows.",
        // Predictions
        "match_predictions: one row per match from the tipper model, overwritten on regeneration (latest only, no history). home_win_prob (0..1) and predicted_margin (positive = home favoured) are from the HOME team's perspective; model_version is the tipper config id. Written by tipper via the D1 REST API, not this Worker. Coverage starts 2026 and is sparse — LEFT JOIN and treat absence as not-published.",
        // Lineups
        "match_lineups represents the post-change team — the players who actually took the field. Treat absence as not-yet-published rather than canonical.",
        "match_lineups is_emergency=1 means the player is named as an emergency and may not play.",
        "match_lineups is_substitute=1 marks all interchange/bench players (INT + SUB positions), not just the medical sub. To find just the medical substitute, filter on position = 'SUB'.",
        "match_lineups position codes: 18 starting positions (FB, BPL, BPR, CHB, HBFL, HBFR, FF, FPL, FPR, CHF, HFFL, HFFR, C, WL, WR, R, RR, RK), plus INT (interchange), SUB (medical substitute), and EMERG (emergency).",
        "Most players with both fryzigg and AFL API data are unified under a single player_id. A small number of common-name players may have separate records for genuinely different people who share a name.",
        "Integrity-check views (v_integrity_disposals, v_integrity_match_points, v_integrity_quarter_scores, v_integrity_margin, v_integrity_brownlow) return one row per invariant violation; an empty result set means the invariant holds.",
        "seasons.is_complete: 1 when every match in the season has been played (home_points NOT NULL for all rows). 0 for in-progress and not-started seasons.",
      ],
      column_coverage: {
        deprecated: true,
        description:
          "Compatibility alias for one release. Use database.coverage_contract; values below are generated from its AFLM expectations.",
        columns: Object.fromEntries(
          LEGACY_COVERAGE_PATHS.map(([alias, table, column]) => [
            alias,
            legacyCoverageEntry(coverage.by_competition.AFLM[table]?.[column] ?? {}),
          ]),
        ),
      },
      common_joins: {
        // Always filter by competition — first bound parameter in every example.
        multi_comp_summary: [
          "-- Per-competition match counts for a season",
          "SELECT c.code AS competition, COUNT(m.id) AS matches",
          "FROM competitions c",
          "JOIN seasons s ON s.competition_id = c.id",
          "JOIN matches m ON m.season_id = s.id",
          "WHERE s.year = ?",
          "GROUP BY c.code",
          "ORDER BY c.code",
        ].join("\n"),
        team_roster_pav: [
          "-- Bind: competition, team name, season year",
          "SELECT p.first_name, p.surname, psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav",
          "FROM player_season_pav psp",
          "JOIN players p ON psp.player_id = p.id",
          "JOIN seasons s ON psp.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams t ON psp.team_id = t.id",
          "WHERE c.code = ? AND t.name = ? AND s.year = ?",
          "ORDER BY psp.total_pav DESC",
        ].join("\n"),
        player_career_arc: [
          "-- Bind: competition, player_id",
          "SELECT s.year, SUM(pms.disposals) as total_disposals, SUM(pms.goals) as total_goals,",
          "  COUNT(*) as games, psp.total_pav, psp.off_pav, psp.mid_pav, psp.def_pav",
          "FROM player_match_stats pms",
          "JOIN matches m ON pms.match_id = m.id",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "LEFT JOIN player_season_pav psp ON psp.player_id = pms.player_id AND psp.season_id = s.id",
          "WHERE c.code = ? AND pms.player_id = ?",
          "GROUP BY s.year, psp.total_pav, psp.off_pav, psp.mid_pav, psp.def_pav",
          "ORDER BY s.year",
        ].join("\n"),
        zone_leaders: [
          "-- Bind: competition, season year",
          "SELECT p.first_name, p.surname, t.name as team, psp.mid_pav, psp.off_pav, psp.def_pav, psp.total_pav",
          "FROM player_season_pav psp",
          "JOIN players p ON psp.player_id = p.id",
          "JOIN seasons s ON psp.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams t ON psp.team_id = t.id",
          "WHERE c.code = ? AND s.year = ?",
          "ORDER BY psp.total_pav DESC",
          "LIMIT 20",
        ].join("\n"),
        match_with_teams_venue: [
          "-- Bind: competition, season year",
          "SELECT m.date, m.round, ht.name as home_team, at.name as away_team,",
          "  m.home_points, m.away_points, m.margin, v.name as venue",
          "FROM matches m",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams ht ON m.home_team_id = ht.id",
          "JOIN teams at ON m.away_team_id = at.id",
          "JOIN venues v ON m.venue_id = v.id",
          "WHERE c.code = ? AND s.year = ?",
        ].join("\n"),
        lineup_round_comparison: [
          "-- Compare team lineups between two rounds (shows ins/outs)",
          "-- Bind: competition, team name, current round number, prev round number, then again for OUT half",
          "SELECT 'IN' as change, p.first_name, p.surname, ml.position",
          "FROM match_lineups ml",
          "JOIN matches m ON ml.match_id = m.id",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN players p ON ml.player_id = p.id",
          "JOIN teams t ON ml.team_id = t.id",
          "WHERE c.code = ? AND t.name = ? AND m.round_number = ? AND ml.is_emergency = 0",
          "  AND ml.player_id NOT IN (",
          "    SELECT ml2.player_id FROM match_lineups ml2",
          "    JOIN matches m2 ON ml2.match_id = m2.id",
          "    WHERE ml2.team_id = ml.team_id AND m2.round_number = ? AND m2.season_id = m.season_id AND ml2.is_emergency = 0",
          "  )",
          "UNION ALL",
          "SELECT 'OUT', p.first_name, p.surname, ml.position",
          "FROM match_lineups ml",
          "JOIN matches m ON ml.match_id = m.id",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN players p ON ml.player_id = p.id",
          "JOIN teams t ON ml.team_id = t.id",
          "WHERE c.code = ? AND t.name = ? AND m.round_number = ? AND ml.is_emergency = 0",
          "  AND ml.player_id NOT IN (",
          "    SELECT ml2.player_id FROM match_lineups ml2",
          "    JOIN matches m2 ON ml2.match_id = m2.id",
          "    WHERE ml2.team_id = ml.team_id AND m2.round_number = ? AND m2.season_id = m.season_id AND ml2.is_emergency = 0",
          "  )",
        ].join("\n"),
        lineup_with_pav: [
          "-- Team lineup enriched with PAV data",
          "-- Bind: competition, team name, round number, season year",
          "SELECT p.first_name, p.surname, ml.position, ml.guernsey_number,",
          "  ml.is_emergency, ml.is_substitute,",
          "  psp.off_pav, psp.mid_pav, psp.def_pav, psp.total_pav",
          "FROM match_lineups ml",
          "JOIN matches m ON ml.match_id = m.id",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN players p ON ml.player_id = p.id",
          "JOIN teams t ON ml.team_id = t.id",
          "LEFT JOIN player_season_pav psp ON psp.player_id = p.id AND psp.season_id = s.id",
          "WHERE c.code = ? AND t.name = ? AND m.round_number = ? AND s.year = ?",
          "ORDER BY ml.is_emergency, psp.total_pav DESC NULLS LAST",
        ].join("\n"),
        match_weather_lookup: [
          "-- Weather for one match (observed + retained forecast) via the canonical venue.",
          "-- Bind: competition, season year, home team name",
          "SELECT m.date, m.round, ht.name AS home_team, at.name AS away_team,",
          "  cv.name AS venue, cv.roof, w.kind, w.source,",
          "  w.temp_c, w.precip_mm, w.precip_24h_prior_mm,",
          "  w.wind_speed_kmh, w.wind_gust_kmh, w.humidity_pct",
          "FROM matches m",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams ht ON m.home_team_id = ht.id",
          "JOIN teams at ON m.away_team_id = at.id",
          "JOIN venues v ON m.venue_id = v.id",
          "JOIN venues cv ON cv.id = COALESCE(v.canonical_venue_id, v.id)",
          "LEFT JOIN match_weather w ON w.match_id = m.id",
          "WHERE c.code = ? AND s.year = ? AND ht.name = ?",
          "ORDER BY m.date, w.kind",
        ].join("\n"),
        wet_game_scoring: [
          "-- Scoring in wet games, excluding roofed venues.",
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
          "WHERE c.code = ? AND m.home_points IS NOT NULL",
          "  AND w.precip_mm >= 2.0 AND cv.roof = 'none'",
          "ORDER BY w.precip_mm DESC",
        ].join("\n"),
        round_predictions: [
          "-- Model predictions for a round, with team names.",
          "-- Bind: competition, season year, round number",
          "SELECT m.date, m.round, ht.name AS home_team, at.name AS away_team,",
          "  mp.home_win_prob, mp.predicted_margin, mp.model_version",
          "FROM matches m",
          "JOIN seasons s ON m.season_id = s.id",
          "JOIN competitions c ON s.competition_id = c.id",
          "JOIN teams ht ON m.home_team_id = ht.id",
          "JOIN teams at ON m.away_team_id = at.id",
          "LEFT JOIN match_predictions mp ON mp.match_id = m.id",
          "WHERE c.code = ? AND s.year = ? AND m.round_number = ?",
          "ORDER BY m.date",
        ].join("\n"),
        ladder: [
          "-- Ladder for a season (regular season only). Works for any competition.",
          "-- Bind: competition, season year",
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
          "WHERE c.code = ? AND s.year = ? AND m.round_type = 'Regular' AND m.home_points IS NOT NULL",
          "GROUP BY t.id",
          "ORDER BY premiership_points DESC, percentage DESC",
        ].join("\n"),
      },
    },
    query_api: {
      usage:
        "db.prepare(sql).bind(param1, param2, ...).all() returns { results: Row[] }. Use .first() for a single row.",
      methods: [
        "db.prepare(sql).bind(...args).all() — returns { results: Row[], success: boolean }",
        "db.prepare(sql).bind(...args).first() — returns first Row or null",
      ],
      notes:
        "Read-only. 30-second timeout. Use ? for parameter binding. The db object is available in the sandbox via an RPC proxy that transparently handles D1 calls. Always filter your queries by competition (see notes above).",
    },
  };
}
