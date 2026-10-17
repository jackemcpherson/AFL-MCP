/**
 * Shared `effect/Schema` decoding helpers for the Worker's boundaries.
 *
 * Strictness is a decode option in `effect/Schema`, not a schema property,
 * so each boundary picks a strict or loose decoder once and every caller
 * (route, script or test) uses that same decoder.
 */

import { Predicate, Schema, SchemaIssue } from "effect";

/** Parse options that reject undeclared keys anywhere in the input. */
const STRICT = { onExcessProperty: "error" } as const;

/**
 * Build a decoder that rejects keys the schema does not declare.
 *
 * @param schema - Schema to decode with.
 * @returns A function from raw input to a `Result` of the decoded value.
 * @example
 * const decode = strictDecoder(Schema.Struct({ dryRun: Schema.Boolean }));
 * decode({ dryRun: true, extra: 1 }); // Failure
 */
export function strictDecoder<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.decodeUnknownResult(schema, STRICT);
}

/**
 * Build a decoder that ignores and drops keys the schema does not declare.
 *
 * @param schema - Schema to decode with.
 * @returns A function from raw input to a `Result` of the decoded value.
 * @example
 * const decode = looseDecoder(Schema.Struct({ n: Schema.Number }));
 * decode({ n: 1, extra: 1 }); // Success { n: 1 }
 */
export function looseDecoder<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.decodeUnknownResult(schema);
}

/** The first problem a decode reported, with the path to the failing value. */
export interface DecodeIssue {
  readonly path: readonly PropertyKey[];
  readonly message: string;
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/**
 * Return the first issue of a failed decode.
 *
 * @param error - The decode failure.
 * @returns The first issue's path and message.
 * @example
 * const issue = firstIssue(result.failure);
 * issue.path; // ["competition"]
 */
export function firstIssue(error: Schema.SchemaError): DecodeIssue {
  const [issue] = formatIssues(error.issue).issues;
  return {
    path: (issue?.path ?? []).map((segment) =>
      Predicate.hasProperty(segment, "key") ? segment.key : segment,
    ),
    message: issue?.message ?? error.message,
  };
}

/**
 * Describe the first issue of a failed decode in one line.
 *
 * @param error - The decode failure.
 * @returns The issue message, followed by the failing key path when there is one.
 * @example
 * describeIssue(result.failure); // 'Expected boolean at "includeObserved"'
 */
export function describeIssue(error: Schema.SchemaError): string {
  const { path, message } = firstIssue(error);
  return path.length === 0
    ? message
    : `${message} at ${JSON.stringify(path.map(String).join("."))}`;
}

/**
 * Decode every row of one statement in a D1 batch result.
 *
 * @param results - The batch results.
 * @param index - Position of the statement in the batch.
 * @param schema - Row schema. Columns it does not declare are ignored.
 * @returns The decoded rows, empty when the statement returned none.
 * @throws {Schema.SchemaError} When a row does not match the schema.
 * @example
 * const rows = batchRows(results, 1, Schema.Struct({ code: Schema.String }));
 */
export function batchRows<S extends Schema.ConstraintDecoder<unknown>>(
  results: readonly D1Result[],
  index: number,
  schema: S,
): readonly S["Type"][] {
  return Schema.decodeUnknownSync(Schema.Array(schema))(results[index]?.results ?? []);
}

/**
 * Decode the first row of one statement in a D1 batch result.
 *
 * @param results - The batch results.
 * @param index - Position of the statement in the batch.
 * @param schema - Row schema. Columns it does not declare are ignored.
 * @returns The decoded first row, or undefined when there is none.
 * @throws {Schema.SchemaError} When a row does not match the schema.
 * @example
 * const marker = batchRow(results, 0, MarkerRowSchema);
 */
export function batchRow<S extends Schema.ConstraintDecoder<unknown>>(
  results: readonly D1Result[],
  index: number,
  schema: S,
): S["Type"] | undefined {
  return batchRows(results, index, schema)[0];
}
