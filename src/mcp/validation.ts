/**
 * `effect/Schema` schemas for the Worker's HTTP boundaries (MNT-02).
 *
 * Per the fleet style guide, external input is decoded at the boundary
 * and trusted internally; types are derived from the schemas.
 */

import { Effect, Schema } from "effect";
import { CompetitionCodeSchema } from "../lib/competitions";
import { firstIssue, looseDecoder, strictDecoder } from "../lib/decode";
import { booleanDefault, SeasonSelectorSchema, Sha256HexSchema } from "../lib/schemas";

/** JSON-RPC 2.0 request envelope. */
export const JsonRpcRequestSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  // Notifications may omit id; default keeps response construction total.
  id: Schema.Union([Schema.String, Schema.Number]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
  ),
  method: Schema.String.check(Schema.isNonEmpty()),
  params: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});

/** A validated JSON-RPC 2.0 request. */
export type JsonRpcRequest = typeof JsonRpcRequestSchema.Type;

/** Decode a JSON-RPC 2.0 request envelope, ignoring unknown members. */
export const decodeJsonRpcRequest = looseDecoder(JsonRpcRequestSchema);

/** The `id` of an envelope that failed validation, echoed in the error reply. */
const JsonRpcIdSchema = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
});

/** Decode just the `id` of an otherwise invalid envelope. */
export const decodeJsonRpcId = looseDecoder(JsonRpcIdSchema);

/** `tools/call` parameters. Arguments stay raw until the named tool decodes them. */
export const ToolCallParamsSchema = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  arguments: Schema.optionalKey(Schema.Unknown),
});

/** Decode `tools/call` parameters. */
export const decodeToolCallParams = looseDecoder(ToolCallParamsSchema);

const COVERAGE_START_YEAR = {
  AFLM: 1990,
  AFLW: 2017,
  VFL: 2021,
  VFLW: 2021,
} as const;

/**
 * The schema tool's complete parameter contract, returned verbatim for every
 * invalid parameter combination so one error names all valid call shapes
 * (issue #141: the previous per-branch messages chained into a two-error loop).
 */
export const SCHEMA_TOOL_CONTRACT =
  "Valid calls: no params (full schema); competition alone (competition-filtered schema); competition + season + includeObserved:true (measured coverage).";

/** A canonical season key such as `2024` or `2022-S7`, or a season year. */
const SchemaToolSeasonSchema = Schema.Union([
  Schema.Int,
  Schema.String.check(Schema.isPattern(/^\d{4}(?:-S[67])?$/)),
]);

const SchemaToolFieldsSchema = Schema.Struct({
  includeObserved: booleanDefault(false),
  competition: Schema.optionalKey(CompetitionCodeSchema),
  season: Schema.optionalKey(SchemaToolSeasonSchema),
});

type SchemaToolFields = typeof SchemaToolFieldsSchema.Type;

/** Cross-field rules of the schema tool; returns an error message or `true`. */
function checkSchemaToolCall(value: SchemaToolFields): string | true {
  if (!value.includeObserved) {
    // `competition` alone filters the base schema; `season` is only
    // meaningful for measured coverage, which needs the full trio.
    return value.season === undefined ? true : SCHEMA_TOOL_CONTRACT;
  }
  if (value.competition === undefined || value.season === undefined) return SCHEMA_TOOL_CONTRACT;
  const key = String(value.season);
  if (
    (value.competition === "AFLW" && key === "2022") ||
    (key.includes("-S") && !(value.competition === "AFLW" && ["2022-S6", "2022-S7"].includes(key)))
  ) {
    return "Ambiguous or invalid season; AFLW 2022 requires 2022-S6 or 2022-S7";
  }
  const currentMelbourneYear = Number(
    new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Melbourne",
      year: "numeric",
    }).format(new Date()),
  );
  const year = Number(key.slice(0, 4));
  if (year < COVERAGE_START_YEAR[value.competition] || year > currentMelbourneYear + 1) {
    return "season is outside the competition coverage range";
  }
  return true;
}

/**
 * Optional arguments accepted by the existing schema tool.
 *
 * Valid shapes: no params (full schema); `competition` alone
 * (competition-filtered schema); `competition` + `season` +
 * `includeObserved: true` (measured coverage). Anything else fails with
 * {@link SCHEMA_TOOL_CONTRACT}.
 */
export const SchemaToolRequestSchema = SchemaToolFieldsSchema.check(
  Schema.makeFilter(checkSchemaToolCall),
);

/** Validated schema tool arguments. */
export type SchemaToolRequest = typeof SchemaToolRequestSchema.Type;

/** Decode schema tool arguments, rejecting unknown keys. */
export const decodeSchemaToolRequest = strictDecoder(SchemaToolRequestSchema);

/**
 * `code` tool arguments. `competition` stays raw: an unrecognised value is
 * ignored rather than rejected, so it is decoded separately with
 * {@link decodeCompetitionHint}.
 */
export const CodeToolRequestSchema = Schema.Struct({
  code: Schema.String.check(Schema.makeFilter((code) => code.trim() !== "")),
  competition: Schema.optionalKey(Schema.Unknown),
});

/** Decode `code` tool arguments, ignoring unknown keys. */
export const decodeCodeToolRequest = looseDecoder(CodeToolRequestSchema);

/** Decode the `code` tool's optional competition hint. */
export const decodeCompetitionHint = Schema.decodeUnknownOption(CompetitionCodeSchema);

/** Optional recovery flag for the current competition-season sync scope. */
export const SyncRequestSchema = Schema.Struct({
  resume: booleanDefault(false),
});

/** Decode a POST /mcp/admin/sync body. */
export const decodeSyncRequest = strictDecoder(SyncRequestSchema);

/** Shape of POST /mcp/admin/backfill bodies. Range clamps live with the route. */
export const BackfillRequestSchema = Schema.Struct({
  resume: booleanDefault(false),
  competitions: Schema.Array(CompetitionCodeSchema).check(Schema.isMinLength(1)),
  fromYear: Schema.Int,
  toYear: Schema.Int,
  skipShouldRunNow: Schema.optionalKey(Schema.Boolean),
});

/** A validated year-range backfill request. */
export type BackfillRequest = typeof BackfillRequestSchema.Type;

/** Decode a year-range backfill body, rejecting unknown keys. */
export const decodeBackfillRequest = strictDecoder(BackfillRequestSchema);

/** Exact-season ingestion, including the two distinct AFLW 2022 seasons. */
export const ExactSeasonBackfillRequestSchema = Schema.Struct({
  fixturesOnly: booleanDefault(false),
  resume: booleanDefault(false),
  competition: CompetitionCodeSchema,
  season: SeasonSelectorSchema,
  skipShouldRunNow: booleanDefault(true),
});

/** Decode an exact-season backfill body, rejecting unknown keys. */
export const decodeExactSeasonBackfillRequest = strictDecoder(ExactSeasonBackfillRequestSchema);

/** A body that names a `season`, selecting the exact-season backfill. */
const SeasonKeySchema = Schema.Struct({ season: Schema.Unknown });

/** Succeeds when a backfill body names a `season`, selecting the exact-season form. */
export const decodeSeasonKey = looseDecoder(SeasonKeySchema);

/** Shape of POST /mcp/admin/backfill-brownlow bodies. Range clamps live with the route. */
export const BrownlowBackfillRequestSchema = Schema.Struct({
  resume: booleanDefault(false),
  fromYear: Schema.Int,
  toYear: Schema.Int,
  dryRun: booleanDefault(true),
});

/** A validated Brownlow backfill request. */
export type BrownlowBackfillRequest = typeof BrownlowBackfillRequestSchema.Type;

/** Decode a Brownlow backfill body, ignoring unknown keys. */
export const decodeBrownlowBackfillRequest = looseDecoder(BrownlowBackfillRequestSchema);

/** One explicit AFLM coaching season and source. */
export const CoachingBackfillRequestSchema = Schema.Struct({
  resume: booleanDefault(false),
  fromYear: Schema.Int,
  toYear: Schema.Int,
  source: Schema.Literals(["afl-tables", "footywire"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("afl-tables" as const)),
  ),
  dryRun: booleanDefault(true),
});

/** One-season coaching backfill request shape. */
export type CoachingBackfillRequest = typeof CoachingBackfillRequestSchema.Type;

/** Decode a coaching backfill body, ignoring unknown keys. */
export const decodeCoachingBackfillRequest = looseDecoder(CoachingBackfillRequestSchema);

/** Explicit historical club identity repair request. */
export const BearsRepairRequestSchema = Schema.Struct({
  dryRun: booleanDefault(true),
  resume: booleanDefault(false),
  manifestDigest: Schema.optionalKey(Sha256HexSchema),
});

/** Decode a Bears repair body, rejecting unknown keys. */
export const decodeBearsRepairRequest = strictDecoder(BearsRepairRequestSchema);

/**
 * Map the first backfill decode issue to the caller-facing message contract
 * the endpoint has always used (and the integration tests assert).
 *
 * @param error - The failed decode.
 * @returns A stable caller-facing message.
 */
export function describeBackfillIssue(error: Schema.SchemaError): string {
  const { path, message } = firstIssue(error);
  const [root, index] = path;
  if (root === "competitions") {
    return index === undefined
      ? "competitions must be a non-empty array"
      : "invalid competition code";
  }
  if (root === "fromYear") return "fromYear must be an integer";
  if (root === "toYear") return "toYear must be an integer";
  return message;
}

/**
 * Map the first Brownlow request issue to a stable caller-facing message.
 *
 * @param error - The failed decode.
 * @returns A stable caller-facing message.
 */
export function describeBrownlowBackfillIssue(error: Schema.SchemaError): string {
  const { path, message } = firstIssue(error);
  const [root] = path;
  if (root === "fromYear") return "fromYear must be an integer";
  if (root === "toYear") return "toYear must be an integer";
  if (root === "dryRun") return "dryRun must be a boolean";
  return message;
}
