/**
 * Request schemas for the year-range and exact-season backfill routes. The
 * handlers are in `src/index.ts`, which runs the sync pipeline directly.
 */

import { Schema } from "effect";
import { CompetitionCodeSchema } from "../lib/competitions";
import {
  type Decoder,
  describeIssue,
  firstIssue,
  looseDecoder,
  strictDecoder,
} from "../lib/decode";
import { booleanDefault, SeasonSelectorSchema } from "../lib/schemas";

/** Shape of POST /mcp/admin/backfill bodies. Range clamps live with the route. */
export const BackfillRequestSchema: Schema.Struct<{
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly competitions: Schema.$Array<typeof CompetitionCodeSchema>;
  readonly fromYear: Schema.Int;
  readonly toYear: Schema.Int;
  readonly skipShouldRunNow: Schema.optionalKey<Schema.Boolean>;
}> = Schema.Struct({
  resume: booleanDefault(false),
  competitions: Schema.Array(CompetitionCodeSchema).check(Schema.isMinLength(1)),
  fromYear: Schema.Int,
  toYear: Schema.Int,
  skipShouldRunNow: Schema.optionalKey(Schema.Boolean),
});

/** A validated year-range backfill request. */
export type BackfillRequest = typeof BackfillRequestSchema.Type;

/** Decode a year-range backfill body, rejecting unknown keys. */
export const decodeBackfillRequest: Decoder<BackfillRequest> = strictDecoder(BackfillRequestSchema);

/** Exact-season ingestion, including the two distinct AFLW 2022 seasons. */
export const ExactSeasonBackfillRequestSchema: Schema.Struct<{
  readonly fixturesOnly: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly competition: typeof CompetitionCodeSchema;
  readonly season: Schema.Union<readonly [Schema.Int, Schema.String]>;
  readonly skipShouldRunNow: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
}> = Schema.Struct({
  fixturesOnly: booleanDefault(false),
  resume: booleanDefault(false),
  competition: CompetitionCodeSchema,
  season: SeasonSelectorSchema,
  skipShouldRunNow: booleanDefault(true),
});

/** Decode an exact-season backfill body, rejecting unknown keys. */
export const decodeExactSeasonBackfillRequest: Decoder<
  typeof ExactSeasonBackfillRequestSchema.Type
> = strictDecoder(ExactSeasonBackfillRequestSchema);

/** A body that names a `season`, selecting the exact-season backfill. */
const SeasonPresenceSchema = Schema.Struct({ season: Schema.Unknown });

/** Succeeds when a backfill body has a `season` key, selecting the exact-season form. */
export const decodeSeasonPresence: Decoder<{ readonly season: unknown }> =
  looseDecoder(SeasonPresenceSchema);

/**
 * Map the first backfill decode issue to the caller-facing message contract
 * the endpoint has always used (and the integration tests assert).
 *
 * @param error - The failed decode.
 * @returns A stable caller-facing message.
 */
export function describeBackfillIssue(error: Schema.SchemaError): string {
  const [root, index] = firstIssue(error).path;
  if (root === "competitions") {
    return index === undefined
      ? "competitions must be a non-empty array"
      : "invalid competition code";
  }
  if (root === "fromYear") return "fromYear must be an integer";
  if (root === "toYear") return "toYear must be an integer";
  // Names the failing key, such as an unknown one.
  return describeIssue(error);
}
