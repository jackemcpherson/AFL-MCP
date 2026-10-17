import { Schema } from "effect";
import type { CompetitionCode } from "fitzroy";
import type { TaggedErrorBase } from "../lib/errors";
import type { Env } from "../types";

/** Exact stored season identity. The calendar year is descriptive, not unique. */
export interface StoredSeason {
  readonly id: number;
  readonly year: number;
  readonly season_key: string;
  readonly code: CompetitionCode;
}

const SeasonSelectionErrorBase: TaggedErrorBase<
  SeasonSelectionError,
  "SeasonSelectionError",
  {
    readonly message: Schema.String;
    readonly code: Schema.Literals<
      readonly ["AMBIGUOUS_SEASON", "INVALID_SEASON", "SEASON_NOT_FOUND"]
    >;
    readonly validSelectors: Schema.$Array<Schema.String>;
  }
> = Schema.TaggedError<SeasonSelectionError>()("SeasonSelectionError", {
  message: Schema.String,
  code: Schema.Literals(["AMBIGUOUS_SEASON", "INVALID_SEASON", "SEASON_NOT_FOUND"]),
  validSelectors: Schema.Array(Schema.String),
});

/**
 * Expected selector failure shared by authenticated operations and coverage.
 *
 * The admin entry maps `SEASON_NOT_FOUND` to 404 and the other codes to 400.
 *
 * @example
 * throw new SeasonSelectionError({
 *   message: "No AFLM season 1800 exists",
 *   code: "SEASON_NOT_FOUND",
 *   validSelectors: [],
 * });
 */
export class SeasonSelectionError extends SeasonSelectionErrorBase {}

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
    throw new SeasonSelectionError({
      message: "Ambiguous AFLW season 2022; choose 2022-S6 or 2022-S7",
      code: "AMBIGUOUS_SEASON",
      validSelectors: ["2022-S6", "2022-S7"],
    });
  }
  if (!/^\d{4}$/.test(key) && !(competition === "AFLW" && ["2022-S6", "2022-S7"].includes(key))) {
    throw new SeasonSelectionError({
      message: `Invalid ${competition} season selector: ${key}`,
      code: "INVALID_SEASON",
      validSelectors: [],
    });
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
    throw new SeasonSelectionError({
      message: `No ${competition} season ${key} exists`,
      code: "SEASON_NOT_FOUND",
      validSelectors: [],
    });
  return row;
}
