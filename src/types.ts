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
  /** Per-IP rate limiter for the public MCP endpoint. Optional so local/test envs run without it. */
  MCP_RATE_LIMIT?: { limit(options: { key: string }): Promise<{ success: boolean }> };
}
