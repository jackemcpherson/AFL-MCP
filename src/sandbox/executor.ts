import { Schema } from "effect";
import type { Env } from "../types";

/**
 * Sandbox code ran past its wall-clock budget.
 *
 * @example
 * new SandboxTimeoutError({ timeoutMs: 30_000 }).message; // "Execution timed out after 30s"
 */
export class SandboxTimeoutError extends Schema.TaggedError<SandboxTimeoutError>()(
  "SandboxTimeoutError",
  { timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `Execution timed out after ${this.timeoutMs / 1000}s`;
  }
}

export interface ExecuteResult {
  result: unknown;
  error?: string;
  execution_time_ms: number;
}

/** Wall-clock execution budget, matching the limit documented by the `tools` tool. */
const EXECUTION_TIMEOUT_MS = 30_000;

/** Serialized results larger than this are truncated rather than returned whole. */
const MAX_RESULT_CHARS = 1_000_000;

/** Resource limits applied to the sandbox isolate itself. */
const SANDBOX_LIMITS = { cpuMs: 10_000, subRequests: 100 } as const;

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
          const __result = await (async () => { ${code} })()
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
      execution_time_ms: Date.now() - start,
    };
  }
}

/**
 * Reduces an execution error to a single bounded line so callers get
 * actionable feedback (their own SQL/code errors) without stack frames,
 * file paths, or unbounded internal detail.
 */
export function sanitizeErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  if (firstLine === "") {
    return "execution failed";
  }
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}…` : firstLine;
}
