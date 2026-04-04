import type { Env } from "./types"

export default {
  async fetch(_request: Request, _env: Env): Promise<Response> {
    return new Response("AFL MCP CF Worker", { status: 200 })
  },
} satisfies ExportedHandler<Env>
