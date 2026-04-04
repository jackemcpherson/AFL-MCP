interface DynamicWorkerLoader {
  load(options: {
    compatibilityDate: string
    mainModule: string
    modules: Record<string, string>
    env: Record<string, unknown>
    globalOutbound?: null
  }): {
    getEntrypoint(): { run(db: D1Database): Promise<unknown> }
  }
}

export interface Env {
  DB: D1Database
  LOADER: DynamicWorkerLoader
}
