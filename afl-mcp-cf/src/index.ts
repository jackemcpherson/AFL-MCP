import type { Env } from "./types"

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return new Response("AFL MCP v2 — stub", { status: 200 })
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // Cron handler — implemented in Unit 3
  },
}

export type { Env }
