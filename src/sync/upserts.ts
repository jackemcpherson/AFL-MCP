import {
  type CompetitionCode,
  type Lineup,
  type LineupPlayer,
  type Match,
  type PlayerStats,
  roundAbbreviation,
  roundLabel,
  roundTypeLabel,
} from "fitzroy";
import { normaliseTeam, normaliseVenue } from "../lib/normalise";
import { toIsoDate, toMelbourneTime } from "../lib/time";
import type { Env } from "../types";
import {
  bindValues,
  changeDetectionWhere,
  insertColumnList,
  placeholderList,
  type UpsertColumn,
  updateSetClause,
} from "./columns";
import { logSync } from "./log";

const COMPETITION_NAME: Record<CompetitionCode, string> = {
  AFLM: "AFL Men's",
  AFLW: "AFL Women's",
  VFL: "Victorian Football League",
  VFLW: "VFL Women's",
};

const BATCH_SIZE = 500;

/**
 * Lineups for seasons before this year were derived from `player_match_stats`
 * by migration 0007 (one-time historical backfill). The AFL API publishes only
 * the Thursday-night announced team for those years, so a sync against them
 * would replace the stats-derived rows with players who didn't actually take
 * the field. `upsertLineups` filters by this constant to make that regression
 * impossible from any caller (cron, manual scripts, future backfills).
 */
const MIN_LINEUP_SYNC_YEAR = 2023;

/**
 * Run prepared statements in batches and return the total number of rows that
 * were actually inserted or updated (`meta.changes`). Combined with WHERE
 * predicates on `ON CONFLICT DO UPDATE`, this distinguishes real writes from
 * UPSERT no-ops where every column already matches.
 */
async function batchAndCountChanges(
  env: Env,
  stmts: readonly D1PreparedStatement[],
): Promise<number> {
  let affected = 0;
  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    const chunk = stmts.slice(i, i + BATCH_SIZE);
    if (chunk.length === 0) continue;
    const results = await env.DB.batch(chunk);
    for (const r of results) {
      if (r.success) affected += r.meta.changes;
    }
  }
  return affected;
}

/** Minimal shape needed to upsert a player record. */
export interface PlayerInput {
  readonly playerId: string;
  readonly givenName: string;
  readonly surname: string;
}

/** Context for `upsertMatches`: the season/competition each match belongs to. */
export interface MatchUpsertContext {
  readonly seasonId: number;
  readonly teamMap: Map<string, number>;
  readonly venueMap: Map<string, number>;
}

/** Union players from stats + lineups, deduped by `playerId`. */
export function unionPlayers(
  stats: readonly PlayerStats[],
  lineups: readonly Lineup[],
): PlayerInput[] {
  const seen = new Map<string, PlayerInput>();
  for (const s of stats) {
    if (!seen.has(s.playerId)) {
      seen.set(s.playerId, {
        playerId: s.playerId,
        givenName: s.givenName,
        surname: s.surname,
      });
    }
  }
  for (const lineup of lineups) {
    for (const p of [...lineup.homePlayers, ...lineup.awayPlayers]) {
      if (!seen.has(p.playerId)) {
        seen.set(p.playerId, {
          playerId: p.playerId,
          givenName: p.givenName,
          surname: p.surname,
        });
      }
    }
  }
  return Array.from(seen.values());
}

/**
 * Ensure a competition row exists for the given code and return its id.
 * @throws if the row cannot be located after the insert (database error).
 */
export async function ensureCompetition(env: Env, code: CompetitionCode): Promise<number> {
  await env.DB.prepare("INSERT OR IGNORE INTO competitions (code, name) VALUES (?, ?)")
    .bind(code, COMPETITION_NAME[code])
    .run();
  const row = await env.DB.prepare("SELECT id FROM competitions WHERE code = ?")
    .bind(code)
    .first<{ id: number }>();
  if (!row) throw new Error(`Failed to ensure competition ${code}`);
  return row.id;
}

/**
 * Ensure a season row exists for the given (competition, year) pair and return its id.
 * @throws if the row cannot be located after the insert (database error).
 */
export async function ensureSeason(env: Env, competitionId: number, year: number): Promise<number> {
  await env.DB.prepare("INSERT OR IGNORE INTO seasons (competition_id, year) VALUES (?, ?)")
    .bind(competitionId, year)
    .run();
  const row = await env.DB.prepare("SELECT id FROM seasons WHERE competition_id = ? AND year = ?")
    .bind(competitionId, year)
    .first<{ id: number }>();
  if (!row) throw new Error(`Failed to ensure season ${year}`);
  return row.id;
}

/**
 * Ensure rows exist for every team referenced by `matches`, and return a
 * name → id map.
 *
 * Writes a `sync:novel-team:<competition>` row to `sync_log` whenever a
 * team name not previously seen for this competition appears in the
 * incoming matches. The novel insert is still performed (the guardrail is
 * observational, not blocking), but the log row gives a queryable signal
 * to investigate — a brand-new team name in production is almost always
 * either a real AFL change worth confirming or an alias the AFL API
 * returned that fitzroy hasn't canonicalised yet (see issue #78).
 */
export async function ensureTeams(
  env: Env,
  competitionId: number,
  competitionCode: CompetitionCode,
  matches: readonly Match[],
): Promise<Map<string, number>> {
  const names = new Set<string>();
  for (const m of matches) {
    names.add(normaliseTeam(m.homeTeam));
    names.add(normaliseTeam(m.awayTeam));
  }

  const existing = await env.DB.prepare("SELECT id, name FROM teams WHERE competition_id = ?")
    .bind(competitionId)
    .all<{ id: number; name: string }>();
  const existingNames = new Set(existing.results.map((r) => r.name));

  const novelNames = Array.from(names).filter((n) => !existingNames.has(n));
  if (novelNames.length > 0) {
    const stmts = novelNames.map((name) =>
      env.DB.prepare("INSERT OR IGNORE INTO teams (name, competition_id) VALUES (?, ?)").bind(
        name,
        competitionId,
      ),
    );
    await env.DB.batch(stmts);
    await logSync(
      env,
      `sync:novel-team:${competitionCode}`,
      novelNames.length,
      novelNames.join(", "),
    );
    const refreshed = await env.DB.prepare("SELECT id, name FROM teams WHERE competition_id = ?")
      .bind(competitionId)
      .all<{ id: number; name: string }>();
    return new Map(refreshed.results.map((r) => [r.name, r.id]));
  }

  return new Map(existing.results.map((r) => [r.name, r.id]));
}

/** Ensure rows exist for every venue referenced by `matches`, and return a name → id map. */
export async function ensureVenues(
  env: Env,
  matches: readonly Match[],
): Promise<Map<string, number>> {
  const names = new Set<string>();
  for (const m of matches) names.add(normaliseVenue(m.venue));
  if (names.size > 0) {
    const stmts = Array.from(names).map((name) =>
      env.DB.prepare("INSERT OR IGNORE INTO venues (name) VALUES (?)").bind(name),
    );
    await env.DB.batch(stmts);
  }
  const { results } = await env.DB.prepare("SELECT id, name FROM venues").all<{
    id: number;
    name: string;
  }>();
  return new Map(results.map((r) => [r.name, r.id]));
}

/** Number of completed matches in the season. Counts rows with non-null `home_points`. */
export async function selectCompletedCount(env: Env, seasonId: number): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) as n FROM matches WHERE season_id = ? AND home_points IS NOT NULL",
  )
    .bind(seasonId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * True when at least one completed match in the season has no `player_match_stats`
 * rows. Used as a self-healing fallback so the stats fetch fires after a partial
 * write failure or when a previous tick skipped the fetch (e.g., multiple
 * matches completing on the same calendar date).
 */
export async function selectHasCompletedMatchWithoutStats(
  env: Env,
  seasonId: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 FROM matches m
     WHERE m.season_id = ?
       AND m.home_points IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM player_match_stats ps WHERE ps.match_id = m.id)
     LIMIT 1`,
  )
    .bind(seasonId)
    .first();
  return row !== null;
}

/**
 * Distinct `round_number`s in the season where every match is completed
 * (`home_points IS NOT NULL`) but at least one match has no `match_lineups`
 * row. Used as a self-healing fallback so lineups backfill for past rounds
 * whose Thursday-night release window the sync missed (e.g. an upstream
 * error blocked the lineup fetch). Capped via `limit` so historical
 * seasons that legitimately have no lineups don't refetch on every tick.
 */
export async function selectCompletedRoundsWithoutLineups(
  env: Env,
  seasonId: number,
  limit: number,
): Promise<number[]> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT m.round_number FROM matches m
     WHERE m.season_id = ?
       AND m.home_points IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM match_lineups ml WHERE ml.match_id = m.id)
     ORDER BY m.round_number DESC
     LIMIT ?`,
  )
    .bind(seasonId, limit)
    .all<{ round_number: number }>();
  return results.map((r) => r.round_number);
}

/** Whether any match in the given round already has lineup rows stored. */
export async function selectRoundHasAnyLineups(
  env: Env,
  seasonId: number,
  round: number,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS present FROM matches m
     WHERE m.season_id = ?1 AND m.round_number = ?2
       AND EXISTS (SELECT 1 FROM match_lineups ml WHERE ml.match_id = m.id)
     LIMIT 1`,
  )
    .bind(seasonId, round)
    .first();
  return row !== null;
}

/**
 * Smallest `round_number` with at least one not-yet-played match. Opening Round
 * is `round_number = 0` and is correctly returned ahead of R1 when unfinished.
 * Returns null when every match in the season is completed.
 */
export async function selectNextRound(env: Env, seasonId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT MIN(round_number) as next FROM matches WHERE season_id = ? AND home_points IS NULL AND round_number IS NOT NULL",
  )
    .bind(seasonId)
    .first<{ next: number | null }>();
  return row?.next ?? null;
}

/**
 * Recompute and persist `seasons.is_complete` for the given season. A season
 * is complete iff it has at least one match AND every match has a non-null
 * `home_points`. Idempotent; safe to call after every sync.
 */
export async function updateSeasonCompleteness(env: Env, seasonId: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE seasons SET is_complete = (
       CASE WHEN EXISTS (SELECT 1 FROM matches WHERE season_id = ?1)
              AND NOT EXISTS (SELECT 1 FROM matches WHERE season_id = ?1 AND home_points IS NULL)
            THEN 1 ELSE 0 END
     ) WHERE id = ?1`,
  )
    .bind(seasonId)
    .run();
}

/** Map fitzroy `external_afl_id` → internal `matches.id` for the given season. */
export async function buildMatchAflIdMap(env: Env, seasonId: number): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare(
    "SELECT id, external_afl_id FROM matches WHERE season_id = ? AND external_afl_id IS NOT NULL",
  )
    .bind(seasonId)
    .all<{ id: number; external_afl_id: string }>();
  return new Map(results.map((r) => [r.external_afl_id, r.id]));
}

/**
 * Upsert players keyed by `external_afl_player_id`. First tries to adopt an
 * existing fryzigg-only row by name match (so legacy data carries forward
 * without duplication); then inserts/updates by AFL id.
 */
export async function upsertPlayers(
  env: Env,
  players: readonly PlayerInput[],
): Promise<Map<string, number>> {
  for (let i = 0; i < players.length; i += BATCH_SIZE) {
    const chunk = players.slice(i, i + BATCH_SIZE);
    const stmts: D1PreparedStatement[] = [];
    for (const p of chunk) {
      stmts.push(
        // Adopt at most ONE legacy row. Homonyms are real across 130
        // seasons; updating every name match gave multiple rows the same
        // AFL id, violating the unique index and aborting the whole
        // transactional batch until manual intervention (COR-05).
        env.DB.prepare(
          `UPDATE players SET external_afl_player_id = ?
           WHERE id = (
             SELECT MIN(id) FROM players
             WHERE first_name = ? AND surname = ?
               AND external_afl_player_id IS NULL
               AND external_id IS NOT NULL
           )
             AND NOT EXISTS (SELECT 1 FROM players WHERE external_afl_player_id = ?)`,
        ).bind(p.playerId, p.givenName, p.surname, p.playerId),
      );
      stmts.push(
        env.DB.prepare(
          `INSERT INTO players (first_name, surname, external_afl_player_id)
           VALUES (?, ?, ?)
           ON CONFLICT (external_afl_player_id) WHERE external_afl_player_id IS NOT NULL
           DO UPDATE SET first_name = excluded.first_name, surname = excluded.surname`,
        ).bind(p.givenName, p.surname, p.playerId),
      );
    }
    await env.DB.batch(stmts);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, external_afl_player_id FROM players WHERE external_afl_player_id IS NOT NULL",
  ).all<{ id: number; external_afl_player_id: string }>();
  return new Map(results.map((r) => [r.external_afl_player_id, r.id]));
}

/**
 * Upsert matches (completed + upcoming). Score/quarter/weather/attendance use
 * COALESCE so an upcoming-status re-fetch never clobbers a completed match's
 * data with NULLs.
 */
export async function upsertMatches(
  env: Env,
  matches: readonly Match[],
  ctx: MatchUpsertContext,
): Promise<number> {
  const stmts = matches.map((m) => buildMatchUpsert(env, m, ctx));
  return await batchAndCountChanges(env, stmts);
}

/** Input row for the {@link MATCH_COLUMNS} manifest: the fitzroy match plus resolved FK ids and derived date/time strings. */
interface MatchRow {
  readonly m: Match;
  readonly seasonId: number;
  readonly venueId: number | null;
  readonly homeTeamId: number | null;
  readonly awayTeamId: number | null;
  readonly dateStr: string;
  readonly localTime: string;
}

/**
 * Column manifest for the `matches` upsert. Every SQL fragment in
 * `buildMatchUpsert` (INSERT list, placeholders, UPDATE SET, change-detection
 * WHERE) and the bind argument order derive from this single array, so a
 * column can never drift between fragments.
 *
 * Kinds:
 * - `"key"` columns are excluded from the shared SET/WHERE fragments: they
 *   are either conflict targets, insert-only (`season_id`), or updated by
 *   branch-specific SQL in `buildMatchUpsert` (`external_afl_id`, `date`,
 *   `home_team_id`, `away_team_id` — see that function's TSDoc).
 * - `"coalesce"` columns never clobber a completed match's data with NULLs
 *   on an upcoming-status re-fetch.
 */
export const MATCH_COLUMNS = [
  { name: "external_afl_id", kind: "key", value: (r) => r.m.matchId },
  { name: "season_id", kind: "key", value: (r) => r.seasonId },
  { name: "round_number", kind: "replace", value: (r) => r.m.roundNumber },
  { name: "round_type", kind: "replace", value: (r) => roundTypeLabel(r.m.roundType) },
  {
    name: "round",
    kind: "replace",
    value: (r) => roundLabel(r.m.roundNumber, r.m.roundName, r.m.roundType),
  },
  {
    name: "round_abbreviation",
    kind: "replace",
    value: (r) => roundAbbreviation(r.m.roundNumber, r.m.roundName, r.m.roundType),
  },
  { name: "date", kind: "key", value: (r) => r.dateStr },
  { name: "local_time", kind: "replace", value: (r) => r.localTime },
  { name: "venue_id", kind: "coalesce", value: (r) => r.venueId },
  { name: "home_team_id", kind: "key", value: (r) => r.homeTeamId },
  { name: "away_team_id", kind: "key", value: (r) => r.awayTeamId },
  { name: "home_goals", kind: "coalesce", value: (r) => r.m.homeGoals },
  { name: "home_behinds", kind: "coalesce", value: (r) => r.m.homeBehinds },
  { name: "home_points", kind: "coalesce", value: (r) => r.m.homePoints },
  { name: "away_goals", kind: "coalesce", value: (r) => r.m.awayGoals },
  { name: "away_behinds", kind: "coalesce", value: (r) => r.m.awayBehinds },
  { name: "away_points", kind: "coalesce", value: (r) => r.m.awayPoints },
  { name: "margin", kind: "coalesce", value: (r) => r.m.margin },
  { name: "attendance", kind: "coalesce", value: (r) => r.m.attendance },
  { name: "home_rushed_behinds", kind: "coalesce", value: (r) => r.m.homeRushedBehinds },
  { name: "away_rushed_behinds", kind: "coalesce", value: (r) => r.m.awayRushedBehinds },
  { name: "home_minutes_in_front", kind: "coalesce", value: (r) => r.m.homeMinutesInFront },
  { name: "away_minutes_in_front", kind: "coalesce", value: (r) => r.m.awayMinutesInFront },
  { name: "home_q1_goals", kind: "coalesce", value: (r) => r.m.q1Home?.goals ?? null },
  { name: "home_q1_behinds", kind: "coalesce", value: (r) => r.m.q1Home?.behinds ?? null },
  { name: "home_q2_goals", kind: "coalesce", value: (r) => r.m.q2Home?.goals ?? null },
  { name: "home_q2_behinds", kind: "coalesce", value: (r) => r.m.q2Home?.behinds ?? null },
  { name: "home_q3_goals", kind: "coalesce", value: (r) => r.m.q3Home?.goals ?? null },
  { name: "home_q3_behinds", kind: "coalesce", value: (r) => r.m.q3Home?.behinds ?? null },
  { name: "home_q4_goals", kind: "coalesce", value: (r) => r.m.q4Home?.goals ?? null },
  { name: "home_q4_behinds", kind: "coalesce", value: (r) => r.m.q4Home?.behinds ?? null },
  { name: "away_q1_goals", kind: "coalesce", value: (r) => r.m.q1Away?.goals ?? null },
  { name: "away_q1_behinds", kind: "coalesce", value: (r) => r.m.q1Away?.behinds ?? null },
  { name: "away_q2_goals", kind: "coalesce", value: (r) => r.m.q2Away?.goals ?? null },
  { name: "away_q2_behinds", kind: "coalesce", value: (r) => r.m.q2Away?.behinds ?? null },
  { name: "away_q3_goals", kind: "coalesce", value: (r) => r.m.q3Away?.goals ?? null },
  { name: "away_q3_behinds", kind: "coalesce", value: (r) => r.m.q3Away?.behinds ?? null },
  { name: "away_q4_goals", kind: "coalesce", value: (r) => r.m.q4Away?.goals ?? null },
  { name: "away_q4_behinds", kind: "coalesce", value: (r) => r.m.q4Away?.behinds ?? null },
  { name: "weather_temp_c", kind: "coalesce", value: (r) => r.m.weatherTempCelsius },
  { name: "weather_type", kind: "coalesce", value: (r) => r.m.weatherType },
  { name: "status", kind: "coalesce", value: (r) => r.m.status },
  { name: "live_period_status", kind: "coalesce", value: (r) => r.m.livePeriodStatus },
  { name: "completed_quarter", kind: "coalesce", value: (r) => r.m.completedQuarter },
] as const satisfies readonly UpsertColumn<MatchRow>[];

// Shared UPDATE SET fragment for both ON CONFLICT branches in
// `buildMatchUpsert`. `"key"` columns (the ones that differ between
// branches) are excluded — see MATCH_COLUMNS and buildMatchUpsert.
const MATCH_UPDATE_COMMON_SET = updateSetClause("matches", MATCH_COLUMNS);

// Shared change-detection predicate fragment. The matching WHERE clause
// ensures `meta.changes` only ticks when something actually differs from
// the existing row, not on no-op upserts.
const MATCH_UPDATE_COMMON_WHERE = changeDetectionWhere("matches", MATCH_COLUMNS);

/**
 * Build the per-match upsert statement.
 *
 * Has two ON CONFLICT clauses so the upsert is robust to either kind of
 * row-identity collision:
 *
 * 1. `(external_afl_id) WHERE external_afl_id IS NOT NULL` — primary
 *    path for AFL-API-sourced matches. When the AFL revises the fixture
 *    (moves a game to a different date or swaps home/away), the stable
 *    `external_afl_id` still matches the existing row, so the UPDATE
 *    rewrites `date` / `home_team_id` / `away_team_id` in place rather
 *    than failing the unique index and leaving the row stale. Replaces
 *    the manual delete-and-re-insert dance migration 0010 performed
 *    after the 2026-05-22 R16–R22 fixture revision (issue #80).
 * 2. `(date, home_team_id, away_team_id)` — fallback for rows that
 *    don't have an `external_afl_id` (historical / scraped sources).
 *    Preserves the original behaviour and COALESCEs in the new
 *    `external_afl_id` value when fitzroy starts providing one.
 */
function buildMatchUpsert(env: Env, m: Match, ctx: MatchUpsertContext): D1PreparedStatement {
  const homeTeam = normaliseTeam(m.homeTeam);
  const awayTeam = normaliseTeam(m.awayTeam);
  const venue = normaliseVenue(m.venue);
  const row: MatchRow = {
    m,
    seasonId: ctx.seasonId,
    venueId: ctx.venueMap.get(venue) ?? null,
    homeTeamId: ctx.teamMap.get(homeTeam) ?? null,
    awayTeamId: ctx.teamMap.get(awayTeam) ?? null,
    dateStr: toIsoDate(m.date),
    localTime: toMelbourneTime(m.date),
  };

  return env.DB.prepare(
    `INSERT INTO matches (${insertColumnList(MATCH_COLUMNS)})
    VALUES (${placeholderList(MATCH_COLUMNS)})
    ON CONFLICT (external_afl_id) WHERE external_afl_id IS NOT NULL DO UPDATE SET
      date = excluded.date,
      home_team_id = excluded.home_team_id,
      away_team_id = excluded.away_team_id,
      ${MATCH_UPDATE_COMMON_SET}
    WHERE
      matches.date IS NOT excluded.date OR
      matches.home_team_id IS NOT excluded.home_team_id OR
      matches.away_team_id IS NOT excluded.away_team_id OR
      ${MATCH_UPDATE_COMMON_WHERE}
    ON CONFLICT (date, home_team_id, away_team_id) DO UPDATE SET
      external_afl_id = COALESCE(excluded.external_afl_id, matches.external_afl_id),
      ${MATCH_UPDATE_COMMON_SET}
    WHERE
      matches.external_afl_id IS NOT COALESCE(excluded.external_afl_id, matches.external_afl_id) OR
      ${MATCH_UPDATE_COMMON_WHERE}`,
  ).bind(...bindValues(MATCH_COLUMNS, row));
}

/**
 * Upsert per-match player stats. Phantom rows (no time on ground AND no
 * disposals) are filtered — these are emergencies/late withdrawals who never
 * took the field but appear in the API.
 *
 * Rows whose team name cannot be resolved in `teamMap` are skipped rather than
 * batched with a `NULL` team_id (which would violate the NOT NULL constraint
 * and abort the entire D1 batch). Each distinct unmapped team name is recorded
 * once per call as a `sync:stats:unmapped-team` entry in `sync_log` so silent
 * skips remain observable without paging `/mcp/health`.
 */
export async function upsertStats(
  env: Env,
  stats: readonly PlayerStats[],
  matchMap: Map<string, number>,
  playerMap: Map<string, number>,
  teamMap: Map<string, number>,
): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  const unmappedTeams = new Set<string>();
  for (const s of stats) {
    const playerId = playerMap.get(s.playerId);
    if (!playerId) continue;
    if (!s.timeOnGroundPercentage && !s.disposals) continue;
    const matchId = matchMap.get(s.matchId);
    if (!matchId) continue;
    const teamId = teamMap.get(normaliseTeam(s.team));
    if (teamId === undefined) {
      unmappedTeams.add(s.team);
      continue;
    }
    stmts.push(buildStatUpsert(env, s, matchId, playerId, teamId));
  }
  if (unmappedTeams.size > 0) {
    await logSync(
      env,
      "sync:stats:unmapped-team",
      0,
      `skipped stat rows for unmapped team(s): ${Array.from(unmappedTeams).join(", ")}`,
    );
  }
  return await batchAndCountChanges(env, stmts);
}

/** Input row for the {@link STAT_COLUMNS} manifest: the fitzroy stats line plus resolved FK ids. */
interface StatRow {
  readonly s: PlayerStats;
  readonly matchId: number;
  readonly playerId: number;
  readonly teamId: number | null;
}

/**
 * Column manifest for the `player_match_stats` upsert. Every SQL fragment in
 * `buildStatUpsert` (INSERT list, placeholders, UPDATE SET, change-detection
 * WHERE) and the bind argument order derive from this single array, so a
 * column can never drift between fragments.
 *
 * Kinds:
 * - `"key"`: `match_id` / `player_id` are the ON CONFLICT target and are
 *   never updated or change-detected.
 * - `"coalesce"`: `supercoach_score` / `brownlow_votes` come from separate
 *   backfills, so a NULL from the AFL API must never clobber them.
 */
export const STAT_COLUMNS = [
  { name: "match_id", kind: "key", value: (r) => r.matchId },
  { name: "player_id", kind: "key", value: (r) => r.playerId },
  { name: "team_id", kind: "replace", value: (r) => r.teamId },
  { name: "guernsey_number", kind: "replace", value: (r) => r.s.jumperNumber },
  { name: "player_position", kind: "replace", value: (r) => r.s.position },
  { name: "kicks", kind: "replace", value: (r) => r.s.kicks },
  { name: "handballs", kind: "replace", value: (r) => r.s.handballs },
  { name: "disposals", kind: "replace", value: (r) => r.s.disposals },
  { name: "marks", kind: "replace", value: (r) => r.s.marks },
  { name: "goals", kind: "replace", value: (r) => r.s.goals },
  { name: "behinds", kind: "replace", value: (r) => r.s.behinds },
  { name: "tackles", kind: "replace", value: (r) => r.s.tackles },
  { name: "hitouts", kind: "replace", value: (r) => r.s.hitouts },
  { name: "free_kicks_for", kind: "replace", value: (r) => r.s.freesFor },
  { name: "free_kicks_against", kind: "replace", value: (r) => r.s.freesAgainst },
  { name: "contested_possessions", kind: "replace", value: (r) => r.s.contestedPossessions },
  { name: "uncontested_possessions", kind: "replace", value: (r) => r.s.uncontestedPossessions },
  { name: "contested_marks", kind: "replace", value: (r) => r.s.contestedMarks },
  { name: "intercepts", kind: "replace", value: (r) => r.s.intercepts },
  { name: "centre_clearances", kind: "replace", value: (r) => r.s.centreClearances },
  { name: "stoppage_clearances", kind: "replace", value: (r) => r.s.stoppageClearances },
  { name: "clearances", kind: "replace", value: (r) => r.s.totalClearances },
  { name: "inside_fifties", kind: "replace", value: (r) => r.s.inside50s },
  { name: "rebounds", kind: "replace", value: (r) => r.s.rebound50s },
  { name: "clangers", kind: "replace", value: (r) => r.s.clangers },
  { name: "turnovers", kind: "replace", value: (r) => r.s.turnovers },
  { name: "one_percenters", kind: "replace", value: (r) => r.s.onePercenters },
  { name: "bounces", kind: "replace", value: (r) => r.s.bounces },
  { name: "goal_assists", kind: "replace", value: (r) => r.s.goalAssists },
  { name: "disposal_efficiency_pct", kind: "replace", value: (r) => r.s.disposalEfficiency },
  { name: "metres_gained", kind: "replace", value: (r) => r.s.metresGained },
  { name: "goal_accuracy", kind: "replace", value: (r) => r.s.goalAccuracy },
  { name: "marks_inside_fifty", kind: "replace", value: (r) => r.s.marksInside50 },
  { name: "tackles_inside_fifty", kind: "replace", value: (r) => r.s.tacklesInside50 },
  { name: "shots_at_goal", kind: "replace", value: (r) => r.s.shotsAtGoal },
  { name: "score_involvements", kind: "replace", value: (r) => r.s.scoreInvolvements },
  { name: "total_possessions", kind: "replace", value: (r) => r.s.totalPossessions },
  { name: "time_on_ground_pct", kind: "replace", value: (r) => r.s.timeOnGroundPercentage },
  { name: "afl_fantasy_score", kind: "replace", value: (r) => r.s.dreamTeamPoints },
  { name: "rating_points", kind: "replace", value: (r) => r.s.ratingPoints },
  { name: "goal_efficiency", kind: "replace", value: (r) => r.s.goalEfficiency },
  { name: "shot_efficiency", kind: "replace", value: (r) => r.s.shotEfficiency },
  { name: "interchange_counts", kind: "replace", value: (r) => r.s.interchangeCounts },
  { name: "effective_disposals", kind: "replace", value: (r) => r.s.effectiveDisposals },
  { name: "effective_kicks", kind: "replace", value: (r) => r.s.effectiveKicks },
  { name: "kick_efficiency", kind: "replace", value: (r) => r.s.kickEfficiency },
  { name: "kick_to_handball_ratio", kind: "replace", value: (r) => r.s.kickToHandballRatio },
  { name: "pressure_acts", kind: "replace", value: (r) => r.s.pressureActs },
  { name: "def_half_pressure_acts", kind: "replace", value: (r) => r.s.defHalfPressureActs },
  { name: "spoils", kind: "replace", value: (r) => r.s.spoils },
  { name: "hitouts_to_advantage", kind: "replace", value: (r) => r.s.hitoutsToAdvantage },
  { name: "hitout_win_pct", kind: "replace", value: (r) => r.s.hitoutWinPercentage },
  { name: "ground_ball_gets", kind: "replace", value: (r) => r.s.groundBallGets },
  { name: "f50_ground_ball_gets", kind: "replace", value: (r) => r.s.f50GroundBallGets },
  { name: "intercept_marks", kind: "replace", value: (r) => r.s.interceptMarks },
  { name: "marks_on_lead", kind: "replace", value: (r) => r.s.marksOnLead },
  { name: "contested_possession_rate", kind: "replace", value: (r) => r.s.contestedPossessionRate },
  { name: "contest_off_one_on_ones", kind: "replace", value: (r) => r.s.contestOffOneOnOnes },
  { name: "contest_off_wins", kind: "replace", value: (r) => r.s.contestOffWins },
  { name: "contest_off_wins_pct", kind: "replace", value: (r) => r.s.contestOffWinsPercentage },
  { name: "contest_def_one_on_ones", kind: "replace", value: (r) => r.s.contestDefOneOnOnes },
  { name: "contest_def_losses", kind: "replace", value: (r) => r.s.contestDefLosses },
  { name: "contest_def_loss_pct", kind: "replace", value: (r) => r.s.contestDefLossPercentage },
  { name: "centre_bounce_attendances", kind: "replace", value: (r) => r.s.centreBounceAttendances },
  { name: "kickins", kind: "replace", value: (r) => r.s.kickins },
  { name: "kickins_playon", kind: "replace", value: (r) => r.s.kickinsPlayon },
  { name: "ruck_contests", kind: "replace", value: (r) => r.s.ruckContests },
  { name: "score_launches", kind: "replace", value: (r) => r.s.scoreLaunches },
  { name: "supercoach_score", kind: "coalesce", value: (r) => r.s.supercoachScore },
  { name: "brownlow_votes", kind: "coalesce", value: (r) => r.s.brownlowVotes },
] as const satisfies readonly UpsertColumn<StatRow>[];

const STAT_UPSERT_SQL = `INSERT INTO player_match_stats (${insertColumnList(STAT_COLUMNS)})
    VALUES (${placeholderList(STAT_COLUMNS)})
    ON CONFLICT (match_id, player_id) DO UPDATE SET
      ${updateSetClause("player_match_stats", STAT_COLUMNS)}
    WHERE
      ${changeDetectionWhere("player_match_stats", STAT_COLUMNS)}`;

function buildStatUpsert(
  env: Env,
  s: PlayerStats,
  matchId: number,
  playerId: number,
  teamId: number | null,
): D1PreparedStatement {
  return env.DB.prepare(STAT_UPSERT_SQL).bind(
    ...bindValues(STAT_COLUMNS, { s, matchId, playerId, teamId }),
  );
}

/** Upsert per-match lineups (one row per player per match). */
export async function upsertLineups(
  env: Env,
  lineups: readonly Lineup[],
  matchMap: Map<string, number>,
  playerMap: Map<string, number>,
  teamMap: Map<string, number>,
): Promise<number> {
  const stmts: D1PreparedStatement[] = [];
  for (const lineup of lineups) {
    if (lineup.season < MIN_LINEUP_SYNC_YEAR) continue;
    const matchId = matchMap.get(lineup.matchId);
    if (!matchId) continue;
    const homeTeamId = teamMap.get(normaliseTeam(lineup.homeTeam));
    const awayTeamId = teamMap.get(normaliseTeam(lineup.awayTeam));
    const sides: Array<{ players: readonly LineupPlayer[]; teamId: number | undefined }> = [
      { players: lineup.homePlayers, teamId: homeTeamId },
      { players: lineup.awayPlayers, teamId: awayTeamId },
    ];
    for (const { players, teamId } of sides) {
      if (!teamId) continue;
      for (const p of players) {
        const playerId = playerMap.get(p.playerId);
        if (!playerId) continue;
        stmts.push(
          env.DB.prepare(
            `INSERT INTO match_lineups (match_id, player_id, team_id, guernsey_number, position, is_emergency, is_substitute)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (match_id, player_id) DO UPDATE SET
               team_id = excluded.team_id,
               guernsey_number = excluded.guernsey_number,
               position = excluded.position,
               is_emergency = excluded.is_emergency,
               is_substitute = excluded.is_substitute
             WHERE
               match_lineups.team_id IS NOT excluded.team_id OR
               match_lineups.guernsey_number IS NOT excluded.guernsey_number OR
               match_lineups.position IS NOT excluded.position OR
               match_lineups.is_emergency IS NOT excluded.is_emergency OR
               match_lineups.is_substitute IS NOT excluded.is_substitute`,
          ).bind(
            matchId,
            playerId,
            teamId,
            p.jumperNumber,
            p.matchPosition,
            p.isEmergency ? 1 : 0,
            p.isSubstitute ? 1 : 0,
          ),
        );
      }
    }
  }
  return await batchAndCountChanges(env, stmts);
}
