/**
 * `effect/Schema` schemas for the MCP endpoint's boundaries (MNT-02). Admin
 * request schemas live next to their handlers in `src/admin/`.
 *
 * Per the fleet style guide, external input is decoded at the boundary
 * and trusted internally; types are derived from the schemas.
 */

import { Effect, Schema } from "effect";
import { CompetitionCodeSchema } from "../lib/competitions";
import { type Decoder, looseDecoder, strictDecoder } from "../lib/decode";
import { booleanDefault, SeasonKeySelectorSchema } from "../lib/schemas";

/** JSON-RPC 2.0 request envelope. */
export const JsonRpcRequestSchema: Schema.Struct<{
  readonly jsonrpc: Schema.Literal<"2.0">;
  readonly id: Schema.withDecodingDefaultKey<
    Schema.Union<readonly [Schema.String, Schema.Number]>,
    never
  >;
  readonly method: Schema.String;
  readonly params: Schema.optionalKey<Schema.$Record<Schema.String, Schema.Unknown>>;
}> = Schema.Struct({
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
export const decodeJsonRpcRequest: Decoder<JsonRpcRequest> = looseDecoder(JsonRpcRequestSchema);

/** The `id` of an envelope that failed validation, echoed in the error reply. */
const JsonRpcIdSchema = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
});

/** Decode just the `id` of an otherwise invalid envelope. */
export const decodeJsonRpcId: Decoder<{ readonly id: string | number }> =
  looseDecoder(JsonRpcIdSchema);

/** `tools/call` parameters. Arguments stay raw until the named tool decodes them. */
export const ToolCallParamsSchema: Schema.Struct<{
  readonly name: Schema.String;
  readonly arguments: Schema.optionalKey<Schema.Unknown>;
}> = Schema.Struct({
  name: Schema.String.check(Schema.isNonEmpty()),
  arguments: Schema.optionalKey(Schema.Unknown),
});

/** Decode `tools/call` parameters. */
export const decodeToolCallParams: Decoder<typeof ToolCallParamsSchema.Type> =
  looseDecoder(ToolCallParamsSchema);

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

const SchemaToolFieldsSchema = Schema.Struct({
  includeObserved: booleanDefault(false),
  competition: Schema.optionalKey(CompetitionCodeSchema),
  season: Schema.optionalKey(SeasonKeySelectorSchema),
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
export const SchemaToolRequestSchema: Schema.Struct<{
  readonly includeObserved: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly competition: Schema.optionalKey<typeof CompetitionCodeSchema>;
  readonly season: Schema.optionalKey<Schema.Union<readonly [Schema.Int, Schema.String]>>;
}> = SchemaToolFieldsSchema.check(Schema.makeFilter(checkSchemaToolCall));

/** Validated schema tool arguments. */
export type SchemaToolRequest = typeof SchemaToolRequestSchema.Type;

/** Decode schema tool arguments, rejecting unknown keys. */
export const decodeSchemaToolRequest: Decoder<SchemaToolRequest> =
  strictDecoder(SchemaToolRequestSchema);

/**
 * `code` tool arguments. `competition` is an optional hint. `null` counts
 * as omitted, since LLM clients often send `null` for unset optionals. Any
 * other value must be a known competition code.
 */
export const CodeToolRequestSchema: Schema.Struct<{
  readonly code: Schema.String;
  readonly competition: Schema.optionalKey<Schema.NullOr<typeof CompetitionCodeSchema>>;
}> = Schema.Struct({
  code: Schema.String.check(Schema.makeFilter((code) => code.trim() !== "")),
  competition: Schema.optionalKey(Schema.NullOr(CompetitionCodeSchema)),
});

/** Decode `code` tool arguments, ignoring unknown keys. */
export const decodeCodeToolRequest: Decoder<typeof CodeToolRequestSchema.Type> =
  looseDecoder(CodeToolRequestSchema);

/** Optional recovery flag for the current competition-season sync scope. */
export const SyncRequestSchema: Schema.Struct<{
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
}> = Schema.Struct({
  resume: booleanDefault(false),
});

/** Decode a POST /mcp/admin/sync body. */
export const decodeSyncRequest: Decoder<typeof SyncRequestSchema.Type> =
  strictDecoder(SyncRequestSchema);
