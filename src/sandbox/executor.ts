import { Predicate, Schema } from "effect";
import type { Env } from "../types";
import type { TaggedErrorBase } from "../lib/errors";
import { boundConsoleLines, CONSOLE_CAPTURE_SOURCE } from "./console";
import { normalizeCode } from "./normalize";
import { isJsonObject, type JsonValue, truncateResult } from "./truncate";

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
 * error's class name, any console output, and the elapsed time.
 */
export interface ExecuteResult {
  result: JsonValue;
  error?: string;
  /** Class name of the failure, such as `SyntaxError`. Safe to log: it carries no user text. */
  errorClass?: string;
  /** Bounded console lines the code wrote, present only when it wrote any. User text: never log it. */
  logs?: readonly string[];
  execution_time_ms: number;
}

/** A sandbox run before its elapsed time is added. */
type RunOutcome = Omit<ExecuteResult, "execution_time_ms">;

/** Message for code that finished without returning anything. */
const NO_RETURN_VALUE_MESSAGE =
  "The code returned no value. End it with `return` and a JSON-serialisable value, such as `return rows.results`.";

/** Wall-clock execution budget, matching the limit documented by the `tools` tool. */
const EXECUTION_TIMEOUT_MS = 30_000;

/**
 * Results whose text form is longer than this are shortened structurally.
 * About 25,000 tokens: room for a few hundred wide rows, inside the default
 * MCP output budget of common clients.
 */
const MAX_RESULT_CHARS = 100_000;

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
 * @returns The result, shortened when too large, or an error message with
 *   its class name, plus any console output.
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
${CONSOLE_CAPTURE_SOURCE}
          const __headers = { "Content-Type": "application/json" }
          try {
            const __result = await (async () => { ${normalizeCode(code)} })()
            const __body = JSON.stringify({ hasValue: __result !== undefined, value: __result, logs: __logs, droppedLogs: __dropped })
            return new Response(__body, { headers: __headers })
          } catch (__error) {
            const error = __error instanceof Error
              ? { name: __error.name, message: __error.message }
              : { name: "NonError", message: String(__error) }
            return new Response(JSON.stringify({ error, logs: __logs, droppedLogs: __dropped }), { headers: __headers })
          }
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

    const execution = (async (): Promise<RunOutcome> => {
      const response = await worker.getEntrypoint().fetch(new Request("https://internal/"));
      return readReply(await response.text());
    })();
    // If the timeout wins the race, the abandoned execution promise may still
    // reject later; swallow that so it never becomes an unhandled rejection.
    execution.catch(() => undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new SandboxTimeoutError({ timeoutMs })), timeoutMs);
    });

    try {
      const outcome = await Promise.race([execution, timeout]);
      return { ...outcome, execution_time_ms: Date.now() - start };
    } finally {
      if (timeoutHandle !== undefined) {
        clearTimeout(timeoutHandle);
      }
    }
  } catch (err) {
    return { ...failure(err, []), execution_time_ms: Date.now() - start };
  }
}

/**
 * Decode the sandbox's reply envelope: the value or the error the code
 * threw, and its console output.
 *
 * @param text - Response body from the sandbox.
 * @returns The run's outcome, with the result shortened to the cap.
 */
function readReply(text: string): RunOutcome {
  const reply = parseJson(text);
  if (!isJsonObject(reply)) return failure(new SandboxReplyError(), []);
  const lines = Array.isArray(reply["logs"]) ? reply["logs"].filter(Predicate.isString) : [];
  const dropped = Predicate.isNumber(reply["droppedLogs"]) ? reply["droppedLogs"] : 0;
  const logs = boundConsoleLines(lines, dropped);
  const thrown = reply["error"];
  if (isJsonObject(thrown)) {
    const message = Predicate.isString(thrown["message"]) ? thrown["message"] : "";
    const name = Predicate.isString(thrown["name"]) ? thrown["name"] : "Error";
    return failure(Object.assign(new Error(message), { name }), logs);
  }
  // A returned `undefined` or function has no JSON form, so `value` is absent.
  const value = reply["value"];
  if (reply["hasValue"] !== true || value === undefined) {
    return failure(new NoReturnValueError(), logs);
  }
  return withLogs({ result: truncateResult(value, MAX_RESULT_CHARS) }, logs);
}

/**
 * Parse a reply body.
 *
 * @param text - Response body from the sandbox.
 * @returns The parsed JSON, or `null` when the body is not JSON.
 */
function parseJson(text: string): JsonValue {
  try {
    // SAFETY: JSON.parse returns only JSON values; the reply checks narrow it.
    return JSON.parse(text) as JsonValue;
  } catch {
    return null;
  }
}

/**
 * A failed run's outcome.
 *
 * @param cause - The thrown value.
 * @param logs - Console lines written before the failure.
 * @returns The sanitised message, the error class and the lines.
 */
function failure(cause: unknown, logs: readonly string[]): RunOutcome {
  return withLogs(
    { result: null, error: sanitizeErrorMessage(cause), errorClass: errorClassOf(cause) },
    logs,
  );
}

function withLogs(outcome: RunOutcome, logs: readonly string[]): RunOutcome {
  return logs.length > 0 ? { ...outcome, logs } : outcome;
}

/** The sandbox answered with something other than its reply envelope. */
class SandboxReplyError extends Error {
  override readonly name = "SandboxReplyError";

  constructor() {
    super("The sandbox returned an unreadable reply.");
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
