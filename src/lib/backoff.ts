/** Milliseconds in an hour. */
export const HOUR_MS: number = 60 * 60 * 1000;
/** Milliseconds in a day. */
export const DAY_MS: number = 24 * HOUR_MS;

/**
 * Delay before retrying a provider fetch after consecutive failures:
 * 1, 2, 4, 8 and 16 hours, then daily.
 *
 * @param failures - Consecutive failures so far, at least one.
 * @returns Milliseconds to wait before the next attempt.
 * @example
 * backoffMs(3); // four hours
 */
export function backoffMs(failures: number): number {
  return Math.min(2 ** Math.min(Math.max(failures, 1) - 1, 5), 24) * HOUR_MS;
}
