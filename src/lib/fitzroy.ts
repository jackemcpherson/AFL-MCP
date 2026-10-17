/**
 * The boundary between this Worker's Promise-based code and fitzroy's Effects.
 *
 * fitzroy 7 returns an Effect from every data function. This Worker takes the
 * style guide's minimal-Worker exception, so it runs those Effects here and
 * keeps the `{ success, data | error }` shape its call sites already handle.
 *
 * One runtime per isolate shares fitzroy's services across requests and cron
 * runs, including the cached AFL API token, as the module-level fitzroy 6
 * client did. The layer is built lazily on the first call, inside a request.
 */

import { Cause, type Effect, Exit, Layer, ManagedRuntime, Result, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { FitzroyLive } from "fitzroy";
import type { MessageFields, TaggedErrorBase } from "./errors";

/** The services a fitzroy Effect may require. */
export type FitzroyServices = Layer.Success<typeof FitzroyLive>;

/**
 * Looks up the global `fetch` on every request. fitzroy reads its `fetch` once,
 * when the runtime builds, so without this a shared runtime would keep the
 * first `fetch` it saw and ignore later replacements such as test stubs. It is
 * `async` so a replacement that returns a bare `Response` still yields a Promise.
 */
const currentFetch: typeof fetch = async (input, init) => globalThis.fetch(input, init);

const runtime = ManagedRuntime.make(
  FitzroyLive.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, currentFetch))),
);

const FitzroyDefectErrorBase: TaggedErrorBase<
  FitzroyDefectError,
  "FitzroyDefectError",
  MessageFields
> = Schema.TaggedError<FitzroyDefectError>()("FitzroyDefectError", { message: Schema.String });

/**
 * A fitzroy call ended in a defect rather than one of its tagged failures.
 *
 * The message is the defect's own message, or its string form, so
 * `sync_log` rows read as they did before the wrapper existed.
 *
 * @example
 * new FitzroyDefectError({ message: "cannot read rounds" });
 */
export class FitzroyDefectError extends FitzroyDefectErrorBase {}

/** The settled outcome of one fitzroy call. */
export type FitzroyOutcome<A, E = Error> =
  | { readonly success: true; readonly data: A }
  | { readonly success: false; readonly error: E | FitzroyDefectError };

/**
 * Run a fitzroy Effect and settle it into a success or failure value.
 *
 * Expected failures arrive as fitzroy's tagged errors, which are `Error`
 * instances with the fitzroy 6 names and messages. An unexpected defect is
 * reported as a {@link FitzroyDefectError} rather than thrown, so Effect's
 * error channel never leaves this module.
 *
 * @param effect - A fitzroy data call, such as `fetchMatches(query)`.
 * @returns The data, or the error that ended the call.
 *
 * @example
 * ```typescript
 * const result = await runFitzroy(fetchMatches({ source: "afl-api", season: 2025 }));
 * if (!result.success) throw result.error;
 * ```
 */
export async function runFitzroy<A, E extends Error>(
  effect: Effect.Effect<A, E, FitzroyServices>,
): Promise<FitzroyOutcome<A, E>> {
  const exit = await runtime.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) return { success: true, data: exit.value };

  const failure = Cause.findError(exit.cause);
  if (Result.isSuccess(failure)) return { success: false, error: failure.success };

  const defect = Cause.squash(exit.cause);
  return {
    success: false,
    error: new FitzroyDefectError({
      message: defect instanceof Error ? defect.message : String(defect),
    }),
  };
}

/**
 * Run a fitzroy Effect and return its data, throwing its error on failure.
 *
 * @param effect - A fitzroy call whose failure should propagate as a throw.
 * @returns The data the call succeeded with.
 * @throws The fitzroy error that ended the call, or a {@link FitzroyDefectError}.
 */
export async function runFitzroyOrThrow<A, E extends Error>(
  effect: Effect.Effect<A, E, FitzroyServices>,
): Promise<A> {
  const result = await runFitzroy(effect);

  if (!result.success) throw result.error;

  return result.data;
}
