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

import { Cause, type Effect, Exit, Layer, ManagedRuntime } from "effect";
import { FetchHttpClient } from "effect/http";
import { FitzroyLive } from "fitzroy";

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

/** The settled outcome of one fitzroy call. */
export type FitzroyOutcome<A> =
  | { readonly success: true; readonly data: A }
  | { readonly success: false; readonly error: Error };

/**
 * Run a fitzroy Effect and settle it into a success or failure value.
 *
 * Expected failures arrive as fitzroy's tagged errors, which are `Error`
 * instances with the fitzroy 6 names and messages. An unexpected defect is
 * reported the same way rather than thrown.
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
export async function runFitzroy<A, E>(
  effect: Effect.Effect<A, E, FitzroyServices>,
): Promise<FitzroyOutcome<A>> {
  const exit = await runtime.runPromiseExit(effect);

  if (Exit.isSuccess(exit)) return { success: true, data: exit.value };

  const failure = Cause.squash(exit.cause);

  return {
    success: false,
    error: failure instanceof Error ? failure : new Error(String(failure)),
  };
}

/**
 * Run a fitzroy Effect and return its data, throwing its error on failure.
 *
 * @param effect - A fitzroy call whose failure should propagate as a throw.
 * @returns The data the call succeeded with.
 * @throws The fitzroy error that ended the call.
 */
export async function runFitzroyOrThrow<A, E>(
  effect: Effect.Effect<A, E, FitzroyServices>,
): Promise<A> {
  const result = await runFitzroy(effect);

  if (!result.success) throw result.error;

  return result.data;
}
