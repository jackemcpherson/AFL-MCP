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

const OperationRequestErrorBase: TaggedErrorBase<
  OperationRequestError,
  "OperationRequestError",
  MessageFields
> = Schema.TaggedError<OperationRequestError>()("OperationRequestError", {
  message: Schema.String,
});

/**
 * An operation request is invalid on its own terms, before any stored state
 * is consulted, such as a field combination the operation never accepts.
 *
 * The message is written by the application. The admin entry returns it with
 * a 400. Use {@link OperationConflictError} when stored state blocks the
 * request instead.
 *
 * @example
 * throw new OperationRequestError({ message: "Recovery requires the approved digest" });
 */
export class OperationRequestError extends OperationRequestErrorBase {
  /** Stable machine-readable code returned in the 400 body. */
  readonly code = "INVALID_REQUEST";
}
