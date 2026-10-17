import { Schema } from "effect";
import type { Env } from "../types";
import type { TaggedErrorBase } from "../lib/errors";
import { normalizeCode } from "./normalize";

const SandboxTimeoutErrorBase: TaggedErrorBase<
  SandboxTimeoutError,
  "SandboxTimeoutError",
  { readonly timeoutMs: Schema.Number }
> = Schema.TaggedError<SandboxTimeoutError>()("SandboxTimeoutError", { timeoutMs: Schema.Number });

/**
 * Sandbox code ran past its wall-clock budget.
 *
 * @example
 * new SandboxTimeoutError({ timeoutMs: 30_000 }).message; // "Execution timed out after 30s"
 */
export class SandboxTimeoutError extends SandboxTimeoutErrorBase {
  override get message(): string {
    return `Execution timed out after ${this.timeoutMs / 1000}s`;
  }
}

/**
 * Outcome of one sandbox run: the result, or an error message and the
 * error's class name, and the elapsed time.
 */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  /** Class name of the failure, such as `SyntaxError`. Safe to log: it carries no user text. */
  errorClass?: string;
  execution_time_ms: number;
}

/** Message for code that finished without returning anything. */
const NO_RETURN_VALUE_MESSAGE =
  "The code returned no value. End it with `return` and a JSON-serialisable value, such as `return rows.results`.";

/** Wall-clock execution budget, matching the limit documented by the `tools` tool. */
const EXECUTION_TIMEOUT_MS = 30_000;

/** Serialized results larger than this are truncated rather than returned whole. */
const MAX_RESULT_CHARS = 1_000_000;

/** Resource limits applied to the sandbox isolate itself. */
const SANDBOX_LIMITS = { cpuMs: 10_000, subRequests: 100 } as const;

/**
 * Run LLM-written code in a Dynamic Worker isolate with read-only D1 access.
 *
 * @param code - Body of an async function with `db` in scope, or a shape
 *   {@link normalizeCode} accepts.
 * @param env - Worker bindings, including the Worker loader.
 * @param ctx - Execution context that exposes the `DbProxy` entrypoint.
 * @param timeoutMs - Wall-clock budget before the run is abandoned.
 * @returns The serialised result, truncated when too large, or an error
 *   message with its class name.
 * @example
 * await executeCode("return (await db.prepare('SELECT 1').all()).results", env, ctx);
 */
export async function executeCode(
  code: string,
  env: Env,
  ctx: ExecutionContext,
  timeoutMs: number = EXECUTION_TIMEOUT_MS,
): Promise<ExecuteResult> {
  const start = Date.now();

  try {
    // SAFETY: Dynamic Worker `ctx.exports` has no public type definitions. `DbProxy` is
    // exported from `src/index.ts`, so the runtime always provides it here.
    // oxlint-disable-next-line typescript/no-explicit-any
    const dbProxy = (ctx as any).exports.DbProxy({ props: {} });

    const wrappedCode = `
      export default {
        async fetch(request, env) {
          const db = {
            prepare(sql) {
              const self = { _sql: sql, _params: [] }
              return {
                bind(...args) { self._params = args; return this },
                all() { return env.__db.query(self._sql, ...self._params) },
                first() { return env.__db.queryFirst(self._sql, ...self._params) },
              }
            }
          }
          const __result = await (async () => { ${normalizeCode(code)} })()
          return new Response(JSON.stringify(__result), {
            headers: { "Content-Type": "application/json" },
          })
        }
      }
    `;

    const worker = env.LOADER.load({
      compatibilityDate: "2026-04-01",
      mainModule: "agent.js",
      modules: { "agent.js": wrappedCode },
      env: { __db: dbProxy },
      globalOutbound: null,
      limits: SANDBOX_LIMITS,
    });

    const execution = (async (): Promise<unknown> => {
      const response = await worker.getEntrypoint().fetch(new Request("https://internal/"));
      const text = await response.text();
      // `JSON.stringify(undefined)` is not a string, so a missing return value
      // arrives as an empty body.
      if (text === "") {
        throw new NoReturnValueError();
      }
      if (text.length > MAX_RESULT_CHARS) {
        return `${text.slice(0, MAX_RESULT_CHARS)}\n… [result truncated at ${MAX_RESULT_CHARS} characters — narrow your query with LIMIT or aggregation]`;
      }
      // SAFETY: widens `any` to `unknown`. The sandbox result is arbitrary JSON
      // passed back to the caller unchanged.
      return JSON.parse(text) as unknown;
    })();
    // If the timeout wins the race, the abandoned execution promise may still
    // reject later; swallow that so it never becomes an unhandled rejection.
    execution.catch(() => undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new SandboxTimeoutError({ timeoutMs })), timeoutMs);
    });

    try {
      const result = await Promise.race([execution, timeout]);
      return {
        result,
        execution_time_ms: Date.now() - start,
      };
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  } catch (err) {
    return {
      result: null,
      error: sanitizeErrorMessage(err),
      errorClass: errorClassOf(err),
      execution_time_ms: Date.now() - start,
    };
  }
}

/** Sandbox code finished without returning a value. */
class NoReturnValueError extends Error {
  override readonly name = "NoReturnValueError";

  constructor() {
    super(NO_RETURN_VALUE_MESSAGE);
  }
}

/**
 * The loader reports a module that fails to parse as a start-up failure,
 * with the engine's own error on the next line, such as
 * `Uncaught SyntaxError: Unexpected token ':'`.
 */
const WORKER_START_FAILURE = /^Failed to start Worker:\s*\n\s*Uncaught (([A-Z]\w*): [^\n]*)/;

/** A message that starts with an error class name, as the RPC boundary writes it. */
const CLASS_PREFIX = /^([A-Z]\w*Error): /;

/** V8 parser messages, for a syntax error that reaches the parent as a plain `Error`. */
const PARSER_MESSAGE =
  /^(?:Unexpected (?:token|identifier|strict mode reserved word|reserved word|end of input)|Invalid or unexpected token|Missing initializer)/;

/**
 * Name the class of an execution failure for logs.
 *
 * @param cause - The thrown value.
 * @returns The error's class name, `NonError` for a thrown non-`Error`.
 */
function errorClassOf(cause: unknown): string {
  if (!(cause instanceof Error)) return "NonError";
  const wrapped = WORKER_START_FAILURE.exec(cause.message)?.[2];
  if (wrapped !== undefined) return wrapped;
  const prefixed = CLASS_PREFIX.exec(cause.message)?.[1];
  if (prefixed !== undefined) return prefixed;
  return cause.name === "Error" && PARSER_MESSAGE.test(cause.message) ? "SyntaxError" : cause.name;
}

/**
 * Reduces an execution error to a single bounded line so callers get
 * actionable feedback (their own SQL/code errors) without stack frames,
 * file paths, or unbounded internal detail. A loader start-up failure is
 * reduced to the engine error it wraps, without the wrapper's location.
 *
 * @param cause - The thrown value.
 * @returns One line of at most 500 characters, plus an ellipsis when cut.
 * @example
 * sanitizeErrorMessage(new Error("boom\n  at x.ts:1:1")); // "boom"
 */
export function sanitizeErrorMessage(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const message = WORKER_START_FAILURE.exec(raw)?.[1] ?? raw;
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (firstLine === "") {
    return "execution failed";
  }
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}…` : firstLine;
}
