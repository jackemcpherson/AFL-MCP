/**
 * Field schemas shared by the Worker's request and storage boundaries.
 */

import { Effect, Schema } from "effect";
import { SeasonSelectorSchema as FitzroySeasonSelectorSchema, type SeasonSelector } from "fitzroy";

/**
 * A boolean field that decodes to `value` when the key is absent.
 *
 * @param value - Default used when the key is missing.
 * @returns A struct field schema.
 * @example
 * Schema.Struct({ dryRun: booleanDefault(true) });
 */
export function booleanDefault(value: boolean): Schema.withDecodingDefaultKey<Schema.Boolean> {
  return Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(value)));
}

/**
 * A throwing boundary decoder, as built by `Schema.decodeUnknownSync`.
 *
 * @example
 * export const decodeRow: SyncDecoder<Row> = Schema.decodeUnknownSync(RowSchema);
 */
export type SyncDecoder<A> = (input: unknown) => A;

/** A strictly positive integer, such as a D1 row id. */
export const PositiveIntSchema: Schema.Int = Schema.Int.check(Schema.isGreaterThan(0));

/** A non-empty string. */
export const NonEmptyStringSchema: Schema.String = Schema.String.check(Schema.isNonEmpty());

/** A lowercase hex SHA-256 digest. */
export const Sha256HexSchema: Schema.String = Schema.String.check(
  Schema.isPattern(/^[a-f0-9]{64}$/),
);

/** An absolute URL, kept as its original string. */
export const UrlStringSchema: Schema.String = Schema.String.check(
  Schema.makeFilter((value) => URL.canParse(value), { expected: "a URL" }),
);

/** A calendar date in `YYYY-MM-DD` form. */
export const IsoDateSchema: Schema.String = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
      const time = Date.parse(`${value}T00:00:00Z`);
      return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value;
    },
    { expected: "a YYYY-MM-DD date" },
  ),
);

/** A season selector: a year, or a canonical key such as `2022-S7`. */
export const SeasonSelectorSchema: Schema.Union<readonly [Schema.Int, Schema.String]> =
  Schema.Union([Schema.Int, Schema.String]);

/**
 * Narrow a validated or stored season selector to fitzroy's selector type.
 *
 * @throws {Schema.SchemaError} When the selector is not a year or AFLW 2022 split key.
 */
export const toSeasonSelector: SyncDecoder<SeasonSelector> = Schema.decodeUnknownSync(
  FitzroySeasonSelectorSchema,
);

/** Declared type of {@link evidenceSchema}. */
export type EvidenceSchema = Schema.Struct<{
  readonly url: Schema.String;
  readonly sha256: Schema.String;
  readonly explanation: Schema.String;
}>;

/**
 * Reviewed external evidence attached to a manual repair.
 *
 * @param minExplanationLength - Shortest explanation the repair accepts.
 * @returns A struct schema for one evidence item.
 * @example
 * Schema.Array(evidenceSchema(20));
 */
export function evidenceSchema(minExplanationLength: number): EvidenceSchema {
  return Schema.Struct({
    url: UrlStringSchema,
    sha256: Sha256HexSchema,
    explanation: Schema.String.check(Schema.isMinLength(minExplanationLength)),
  });
}
