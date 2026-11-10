/**
 * Coaching scope and diagnostic counts shared by `/mcp/admin/status` and the `schema`
 * tool's observed coverage, so both report the same definitions.
 *
 * Each statement returns one row with a single `n` column. The season
 * variants bind the AFLM season year as `?1`.
 */

/** First AFLM season with coaching coverage and the earliest one the coaching backfill imports. */
export const MIN_COACHING_YEAR = 1990;

/** Diagnostic reasons that mean a source assignment could not be joined to a stored match side. */
const UNRESOLVED_JOIN_REASONS =
  "('unresolved-match', 'ambiguous-match', 'invalid-participant', 'score-mismatch')";

const UNRESOLVED_JOINS_BASE = `SELECT COUNT(*) AS n FROM coach_import_diagnostics
  WHERE provider = 'afl-tables' AND resolved_at IS NULL
    AND reason IN ${UNRESOLVED_JOIN_REASONS}`;

/**
 * Open AFL Tables diagnostics for assignments that matched no single stored
 * match side, across every season.
 */
export const UNRESOLVED_COACH_JOINS_SQL: string = UNRESOLVED_JOINS_BASE;

/** {@link UNRESOLVED_COACH_JOINS_SQL} for one AFLM season, bound as `?1`. */
export const SEASON_UNRESOLVED_COACH_JOINS_SQL: string = `${UNRESOLVED_JOINS_BASE} AND season = ?1`;

const CONFLICTS_BASE = `SELECT COUNT(*) AS n FROM match_coaches mc
  JOIN matches m ON m.id = mc.match_id JOIN seasons s ON s.id = m.season_id
  JOIN competitions c ON c.id = s.competition_id
  JOIN coach_observations latest_fw ON latest_fw.id = (
    SELECT o.id FROM coach_observations o
    WHERE o.match_id = mc.match_id AND o.team_id = mc.team_id AND o.provider = 'footywire'
    ORDER BY o.retrieved_at DESC, o.id DESC LIMIT 1)
  WHERE c.code = 'AFLM' AND mc.coach_id <> latest_fw.coach_id`;

/**
 * Canonical AFLM match-side coach assignments that disagree with the latest
 * FootyWire observation for the same side, across every season.
 */
export const COACHING_CONFLICTS_SQL: string = CONFLICTS_BASE;

/** {@link COACHING_CONFLICTS_SQL} for one AFLM season, bound as `?1`. */
export const SEASON_COACHING_CONFLICTS_SQL: string = `${CONFLICTS_BASE} AND s.year = ?1`;
