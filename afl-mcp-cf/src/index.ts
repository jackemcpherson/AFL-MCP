import { handleCron } from "./sync/cron"
import type { Env } from "./types"

export default {
  async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
    return new Response("AFL MCP v2", { status: 200 })
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleCron(event, env))
  },
}
