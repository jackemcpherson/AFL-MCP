import type { Env } from "../types"

export interface ExecuteResult {
  result: unknown
  error?: string
  execution_time_ms: number
}

export async function executeCode(code: string, env: Env): Promise<ExecuteResult> {
  const start = Date.now()

  try {
    const wrappedCode = `
      export default {
        async run(db) {
          ${code}
        }
      }
    `

    const worker = env.LOADER.load({
      compatibilityDate: "2026-04-01",
      mainModule: "agent.js",
      modules: { "agent.js": wrappedCode },
      env: {},
      globalOutbound: null,
    })

    const result = await worker.getEntrypoint().run(env.DB)

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
