import { TEAM_NAME_MAP, VENUE_NAME_MAP } from "./constants";

export function normaliseTeam(name: string): string {
  const trimmed = name.trim();
  return TEAM_NAME_MAP[trimmed] ?? trimmed;
}

export function normaliseVenue(name: string): string {
  const trimmed = name.trim();
  return VENUE_NAME_MAP[trimmed] ?? trimmed;
}

/**
 * Placeholder "team" names the AFL API publishes for unresolved finals
 * fixtures, matched after {@link normaliseTeam}:
 *
 * - Ladder-position ordinals: `1st` … `10th` (Wildcard/Qualifying fixtures)
 * - Progression labels: `Winner of QF1`, `Loser of QF2`, …
 * - Ranked progression labels: `Highest-ranked WF Winner`, …
 * - Bare TBC/TBA markers, defensively
 *
 * These must never become `teams` rows (see the 2026 finals-fixture incident
 * and the SDNR precedent in migration 0009); matches referencing them are
 * quarantined until the AFL resolves the fixture to real clubs, at which
 * point the same `external_afl_id` upserts cleanly.
 */
export function isPlaceholderTeamName(name: string): boolean {
  return (
    /^\d{1,2}(st|nd|rd|th)$/i.test(name) ||
    /^(winner|loser) of\b/i.test(name) ||
    /-ranked\b.*\b(winner|loser)$/i.test(name) ||
    /^(tbc|tba|to be confirmed)$/i.test(name)
  );
}
