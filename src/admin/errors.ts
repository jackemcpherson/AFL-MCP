import { Schema } from "effect";

/**
 * A reviewed operation cannot proceed with its supplied scope or approval.
 *
 * The message is written by the application, never copied from a provider
 * payload or credential, because the admin entry returns it with a 409.
 *
 * @example
 * throw new OperationConflictError({ message: "Preview is stale; preview again" });
 */
export class OperationConflictError extends Schema.TaggedError<OperationConflictError>()(
  "OperationConflictError",
  { message: Schema.String },
) {
  /** Stable machine-readable code returned in the 409 body. */
  readonly code = "OPERATION_CONFLICT";
}
