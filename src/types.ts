interface WorkerLoader {
  load(options: {
    compatibilityDate: string;
    mainModule: string;
    modules: Record<string, string>;
    env?: Record<string, unknown>;
    globalOutbound?: unknown | null;
    limits?: { cpuMs?: number; subRequests?: number };
  }): {
    getEntrypoint(): { fetch(request: Request): Promise<Response> };
  };
}

export interface Env {
  DB: D1Database;
  LOADER: WorkerLoader;
  /** Bearer token for /mcp/admin/* (wrangler secret). Admin routes are disabled when unset. */
  ADMIN_TOKEN?: string;
}
