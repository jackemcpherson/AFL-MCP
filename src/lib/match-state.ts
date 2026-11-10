/**
 * The match lifecycle, as SQL conditions over `matches.status`.
 *
 * The provider owns the status (`Upcoming`, `Live`, `Postponed`, `Complete`,
 * `Cancelled`) and the sync stores it as delivered. Everything downstream
 * asks one of three questions, and each has one definition here:
 *
 * - **played**: the match finished and its result counts.
 * - **cancelled**: the match will never be played.
 * - **unsettled**: neither of the above, so its outcome is still open.
 *
 * Scores are not a lifecycle signal. A `Live` row carries partial scores and
 * a `Cancelled` row has none, so `home_points IS NOT NULL` answers neither
 * "has it finished" nor "is it over".
 */

/**
 * The match was played to a result.
 *
 * @param alias - Table alias of `matches` in the surrounding query.
 * @returns A SQL condition.
 * @example
 * `SELECT COUNT(*) FROM matches m WHERE ${playedMatch("m")}`;
 */
export function playedMatch(alias: string): string {
  return `${alias}.status = 'Complete'`;
}

/**
 * The match was abandoned and will never have a result.
 *
 * @param alias - Table alias of `matches` in the surrounding query.
 * @returns A SQL condition.
 */
export function cancelledMatch(alias: string): string {
  return `${alias}.status = 'Cancelled'`;
}

/**
 * The match is neither played nor cancelled: upcoming, live, postponed, or
 * of unknown status.
 *
 * @param alias - Table alias of `matches` in the surrounding query.
 * @returns A SQL condition.
 */
export function unsettledMatch(alias: string): string {
  return `(${alias}.status IS NULL OR ${alias}.status NOT IN ('Complete', 'Cancelled'))`;
}
