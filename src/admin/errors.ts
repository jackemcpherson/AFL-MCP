import { Schema } from "effect";
import type { MessageFields, TaggedErrorBase } from "../lib/errors";

const OperationConflictErrorBase: TaggedErrorBase<
  OperationConflictError,
  "OperationConflictError",
  MessageFields
> = Schema.TaggedError<OperationConflictError>()("OperationConflictError", {
  message: Schema.String,
});

/**
 * A reviewed operation cannot proceed with its supplied scope or approval.
 *
 * The message is written by the application, never copied from a provider
 * payload or credential, because the admin entry returns it with a 409.
 *
 * @example
 * throw new OperationConflictError({ message: "Preview is stale; preview again" });
 */
export class OperationConflictError extends OperationConflictErrorBase {
  /** Stable machine-readable code returned in the 409 body. */
  readonly code = "OPERATION_CONFLICT";
}
