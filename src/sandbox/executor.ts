import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "../types";
import { assertReadOnlySql } from "./sql-guard";

export class DbProxy extends WorkerEntrypoint<Env> {
  async query(sql: string, ...params: unknown[]) {
    assertReadOnlySql(sql);
    const stmt = this.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    return await bound.all();
  }

  async queryFirst(sql: string, ...params: unknown[]) {
    assertReadOnlySql(sql);
    const stmt = this.env.DB.prepare(sql);
    const bound = params.length > 0 ? stmt.bind(...params) : stmt;
    return await bound.first();
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
): Promise<ExecuteResult> {
  const start = Date.now();

  try {
    // biome-ignore lint/suspicious/noExplicitAny: Dynamic Worker ctx.exports has no public type defs
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
      return JSON.parse(text) as unknown;
    })();
    // If the timeout wins the race, the abandoned execution promise may still
    // reject later; swallow that so it never becomes an unhandled rejection.
    execution.catch(() => undefined);

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`Execution timed out after ${EXECUTION_TIMEOUT_MS / 1000}s`)),
        EXECUTION_TIMEOUT_MS,
      );
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
      error: err instanceof Error ? err.message : String(err),
      execution_time_ms: Date.now() - start,
    };
  }
}
