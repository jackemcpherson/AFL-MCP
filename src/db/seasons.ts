import type { CompetitionCode } from "fitzroy";
import type { Env } from "../types";

/** Exact stored season identity. The calendar year is descriptive, not unique. */
export interface StoredSeason {
  readonly id: number;
  readonly year: number;
  readonly season_key: string;
  readonly code: CompetitionCode;
}

/** Expected selector failure shared by authenticated operations and coverage. */
export class SeasonSelectionError extends Error {
  constructor(
    message: string,
    readonly code: "AMBIGUOUS_SEASON" | "INVALID_SEASON" | "SEASON_NOT_FOUND",
    readonly validSelectors: readonly string[] = [],
  ) {
    super(message);
    this.name = "SeasonSelectionError";
  }
}

/**
 * Reject ambiguous years and return an exact canonical key before any database write.
 * @param competition - Competition discriminator.
 * @param selector - Calendar year or canonical key.
 * @returns Exact canonical season key.
 * @throws {SeasonSelectionError} If the selector is invalid or ambiguous.
 * @example
 * seasonKey("AFLW", "2022-S7");
 */
export function seasonKey(competition: string, selector: number | string): string {
  const key = String(selector);
  if (competition === "AFLW" && key === "2022") {
    throw new SeasonSelectionError(
      "Ambiguous AFLW season 2022; choose 2022-S6 or 2022-S7",
      "AMBIGUOUS_SEASON",
      ["2022-S6", "2022-S7"],
    );
  }
  if (!/^\d{4}$/.test(key) && !(competition === "AFLW" && ["2022-S6", "2022-S7"].includes(key))) {
    throw new SeasonSelectionError(
      `Invalid ${competition} season selector: ${key}`,
      "INVALID_SEASON",
    );
  }
  return key;
}

/**
 * Resolve a competition and selector to exactly one stored season.
 * @param env - Database bindings.
 * @param competition - Competition discriminator.
 * @param selector - Calendar year or exact season key.
 * @returns The stored season identity with its preserved internal ID.
 * @throws {SeasonSelectionError} If the selector is invalid, ambiguous or absent.
 * @throws If the database query fails.
 * @example
 * await resolveStoredSeason(env, "AFLW", "2022-S6");
 */
export async function resolveStoredSeason(
  env: Env,
  competition: string,
  selector: number | string,
): Promise<StoredSeason> {
  const key = seasonKey(competition, selector);
  const row = await env.DB.prepare(`SELECT s.id, s.year, s.season_key, c.code FROM seasons s
    JOIN competitions c ON c.id = s.competition_id WHERE c.code = ?1 AND s.season_key = ?2`)
    .bind(competition, key)
    .first<StoredSeason>();
  if (!row)
    throw new SeasonSelectionError(`No ${competition} season ${key} exists`, "SEASON_NOT_FOUND");
  return row;
}
