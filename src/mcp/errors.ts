import { Schema } from "effect";
import type { MessageFields, TaggedErrorBase } from "../lib/errors";

const McpRequestErrorBase: TaggedErrorBase<
  McpRequestError,
  "McpRequestError",
  { readonly code: Schema.Number; readonly message: Schema.String }
> = Schema.TaggedError<McpRequestError>()("McpRequestError", {
  code: Schema.Number,
  message: Schema.String,
});

/**
 * A JSON-RPC request the server rejects with a specific error code.
 *
 * Thrown inside request handling and caught by `handleMcpRequest`, which
 * answers with `{ error: { code, message } }` and the request's `id`. The
 * message is application-written and safe to return to the client.
 *
 * @example
 * throw new McpRequestError({ code: -32601, message: "Method not found: foo" });
 */
export class McpRequestError extends McpRequestErrorBase {}

const CoverageObservationErrorBase: TaggedErrorBase<
  CoverageObservationError,
  "CoverageObservationError",
  MessageFields
> = Schema.TaggedError<CoverageObservationError>()("CoverageObservationError", {
  message: Schema.String,
});

/**
 * Observed coverage cannot be measured right now, for example while a data
 * update holds the public input marker.
 *
 * The message is application-written. The `schema` tool returns it as an
 * `isError` tool result so the model can retry, not as a JSON-RPC error.
 *
 * @example
 * throw new CoverageObservationError({ message: "Retry shortly" });
 */
export class CoverageObservationError extends CoverageObservationErrorBase {}
