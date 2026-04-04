import { WorkerEntrypoint } from "cloudflare:workers"
import type { Env } from "../types"

export class DbProxy extends WorkerEntrypoint<Env> {
  async query(sql: string, ...params: unknown[]) {
    const stmt = this.env.DB.prepare(sql)
    const bound = params.length > 0 ? stmt.bind(...params) : stmt
    return await bound.all()
  }

  async queryFirst(sql: string, ...params: unknown[]) {
    const stmt = this.env.DB.prepare(sql)
    const bound = params.length > 0 ? stmt.bind(...params) : stmt
    return await bound.first()
  }
}

export interface ExecuteResult {
  result: unknown
  error?: string
  execution_time_ms: number
}

export async function executeCode(
  code: string,
  env: Env,
  ctx: ExecutionContext
): Promise<ExecuteResult> {
  const start = Date.now()

  try {
    const dbProxy = (ctx as any).exports.DbProxy({ props: {} })

    const wrappedCode = `
      export default {
        async fetch(request, env) {
          const db = {
            async prepare(sql) {
              const self = { _sql: sql, _params: [] }
              return {
                bind(...args) { self._params = args; return this },
                async all() { return env.__db.query(self._sql, ...self._params) },
                async first() { return env.__db.queryFirst(self._sql, ...self._params) },
              }
            }
          }
          ${code}
        }
      }
    `

    const worker = env.LOADER.load({
      compatibilityDate: "2026-04-01",
      mainModule: "agent.js",
      modules: { "agent.js": wrappedCode },
      env: { __db: dbProxy },
      globalOutbound: null,
    })

    const response = await worker.getEntrypoint().fetch(new Request("https://internal/"))
    const result = await response.json()

    return {
      result,
      execution_time_ms: Date.now() - start,
    }
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
      execution_time_ms: Date.now() - start,
    }
  }
}
