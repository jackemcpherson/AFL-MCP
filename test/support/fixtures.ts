/**
 * Typed fixtures for Worker bindings and runtime objects in tests.
 *
 * Each helper owns the one type assertion its stub needs, so test files
 * never cast stubs themselves. Import through the `#test/*` alias.
 */
import type { Env } from "../../src/types";

/**
 * Builds an `Env` holding only the bindings a test supplies.
 *
 * @param bindings - Bindings the code under test reads.
 * @returns The bindings typed as a full `Env`.
 * @example
 * const env = testEnv({ CODE_TOOL_DISABLED: "true" });
 */
export function testEnv(bindings: Partial<Env> = {}): Env {
  // SAFETY: tests pass every binding the code under test reads. A missing
  // binding fails the test with a TypeError instead of passing silently.
  return { ...bindings } as Env;
}

/**
 * Builds an `ExecutionContext` whose lifecycle hooks do nothing.
 *
 * @param exports - Loopback entrypoints exposed on `ctx.exports`.
 * @returns A context accepted by Worker handlers.
 * @example
 * const ctx = testCtx({ DbProxy: () => ({}) });
 */
export function testCtx(exports: Record<string, unknown> = {}): ExecutionContext {
  const ctx: Pick<ExecutionContext, "waitUntil" | "passThroughOnException" | "props"> & {
    exports: Record<string, unknown>;
  } = {
    waitUntil: () => {},
    passThroughOnException: () => {},
    props: {},
    exports,
  };
  // SAFETY: handlers under test call only `waitUntil`, `passThroughOnException`
  // and `exports`. `tracing` and `abort` are never read in tests.
  return ctx as ExecutionContext;
}

/**
 * Builds a Worker Loader whose sandbox entrypoint answers with `fetch`.
 *
 * @param fetch - Handler for requests sent to the loaded sandbox.
 * @returns A `WorkerLoader` binding for `Env.LOADER`.
 * @example
 * const env = testEnv({ LOADER: testLoader(async () => new Response("1")) });
 */
export function testLoader(fetch: () => Promise<Response>): Env["LOADER"] {
  return { load: () => ({ getEntrypoint: () => ({ fetch }) }) };
}

/**
 * Reads the URL from any `fetch` input.
 *
 * @param input - The first argument passed to `fetch` or `Cache`.
 * @returns The absolute or relative URL as a string.
 * @example
 * vi.stubGlobal("fetch", async (input: RequestInfo | URL) => new Response(requestUrl(input)));
 */
export function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

/** Minimal cache surface that coverage reads and writes. */
export type CacheStub = Pick<Cache, "match" | "put">;

/**
 * Builds a `Cache` from `match` and `put`.
 *
 * @param stub - The cache operations under test.
 * @returns The stub typed as a `Cache`.
 * @example
 * const cache = testCache({ match: async () => undefined, put: async () => {} });
 */
export function testCache(stub: CacheStub): Cache {
  // SAFETY: coverage calls only `match` and `put`, never `delete`.
  return stub as Cache;
}

/**
 * Builds an in-memory `Cache` keyed by request URL.
 *
 * @returns The cache and its backing entries for assertions.
 * @example
 * const { cache, entries } = memoryCache();
 */
export function memoryCache() {
  const entries = new Map<string, Response>();
  const cache = testCache({
    async match(request) {
      return entries.get(requestUrl(request))?.clone();
    },
    async put(request, response) {
      entries.set(requestUrl(request), response.clone());
    },
  });
  return { cache, entries };
}

/** One `prepare` call seen by {@link scriptedD1}. */
export interface D1Call {
  sql: string;
  bindings: unknown[];
}

/**
 * Builds a D1 binding that answers the nth `prepare(...).first()` with
 * `rows[n]`. Missing rows answer `null`. An `Error` row rejects instead.
 *
 * @param rows - Scripted `first()` results in `prepare` call order.
 * @returns The binding and the SQL and bindings of every `prepare` call.
 * @example
 * const { db, calls } = scriptedD1([{ id: 1 }, null]);
 */
export function scriptedD1(rows: readonly unknown[]) {
  const calls: D1Call[] = [];
  const db = {
    prepare(sql: string) {
      const call: D1Call = { sql, bindings: [] };
      const row = rows[calls.length] ?? null;
      calls.push(call);
      const statement = {
        bind(...bindings: unknown[]) {
          call.bindings = bindings;
          return statement;
        },
        async first() {
          if (row instanceof Error) throw row;
          return row;
        },
      };
      return statement;
    },
    async batch(statements: { first: () => Promise<unknown> }[]) {
      return Promise.all(
        statements.map(async (statement) => ({ results: [await statement.first()] })),
      );
    },
  };
  // SAFETY: the code under test calls only `prepare`, `bind`, `first` and
  // `batch` on this binding.
  return { db: db as D1Database, calls };
}

/**
 * Reads a key that the test has already put in the map.
 *
 * @param map - Map that holds `key`.
 * @param key - Key to read.
 * @returns The stored value.
 * @throws Error when `key` is missing, which means the fixture is wrong.
 * @example
 * const team = mustGet(teams, "Carlton");
 */
export function mustGet<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing fixture key: ${String(key)}`);
  return value;
}
