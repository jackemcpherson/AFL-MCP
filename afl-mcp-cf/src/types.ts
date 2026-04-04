interface DynamicWorkerLoader {
  load(options: Record<string, unknown>): unknown
}

export interface Env {
  DB: D1Database
  LOADER: DynamicWorkerLoader
}
