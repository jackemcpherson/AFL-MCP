/**
 * Safe logging for failures that cross a module boundary.
 *
 * Error messages can carry upstream payloads, request bodies or
 * credential-bearing URLs, so they are never logged. A log line names the
 * event, the error's tag (or `TypeError` / `Error` for untagged errors) and
 * the `src/` stack frames, which is enough to find the failing code.
 */

import type { Cause } from "effect";
import { Predicate, type Schema } from "effect";

/**
 * Declared type of a `Schema.TaggedError` base class.
 *
 * `isolatedDeclarations` rejects an `extends` clause that calls a function,
 * so each tagged error first binds its base to a const of this type.
 *
 * @example
 * const Base: TaggedErrorBase<MyError, "MyError", MessageFields> =
 *   Schema.TaggedError<MyError>()("MyError", { message: Schema.String });
 * export class MyError extends Base {}
 */
export type TaggedErrorBase<
  Self,
  Tag extends string,
  Fields extends Schema.Struct.Fields,
> = Schema.Class<Self, Schema.TaggedStruct<Tag, Fields>, Cause.YieldableError>;

/** Fields of a tagged error that carries only an application-written message. */
export type MessageFields = { readonly message: Schema.String };

/** Matches a `src/` file position such as `src/sync/sync.ts:161:12`. */
const SOURCE_FRAME = /src\/[a-zA-Z0-9_./-]+:\d+:\d+/g;

/**
 * Name a failure without reading its message.
 *
 * @param error - Any thrown value.
 * @returns The `_tag` of a tagged error, `TypeError`, or `Error`.
 * @example
 * errorType(new OperationConflictError({ message: "stale" })); // "OperationConflictError"
 */
export function errorType(error: unknown): string {
  if (Predicate.hasProperty(error, "_tag") && Predicate.isString(error._tag)) return error._tag;
  return error instanceof TypeError ? "TypeError" : "Error";
}

/**
 * Write one structured `console.error` line for a failure.
 *
 * @param event - Stable event name, such as `mcp_handler_error`.
 * @param error - The thrown value. Only its tag and `src/` frames are logged.
 * @param fields - Extra application-controlled fields, never error text.
 * @example
 * logError("sync_log_purge_failed", error);
 */
export function logError(
  event: string,
  error: unknown,
  fields: Readonly<Record<string, string | number | null>> = {},
): void {
  const frames =
    error instanceof Error
      ? (error.stack
          ?.split("\n")
          .slice(1)
          .flatMap((line) => line.match(SOURCE_FRAME) ?? []) ?? [])
      : [];
  console.error(JSON.stringify({ event, ...fields, errorType: errorType(error), frames }));
}
