import { handleMcpRequest } from "./mcp/protocol";
import { calculateAllPav, recalculatePav } from "./sync/pav";
import { sync } from "./sync/sync";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" || path === "/mcp/health") {
      const [freshness, lastSync] = await Promise.all([
        env.DB.prepare(
          "SELECT MAX(date) as latest_match FROM matches WHERE home_points IS NOT NULL",
        ).first(),
        env.DB.prepare(
          "SELECT timestamp, type, rows_affected, error FROM sync_log ORDER BY id DESC LIMIT 1",
        ).first(),
      ]);
      return Response.json({
        status: "ok",
        latest_match: freshness?.latest_match,
        last_sync: lastSync,
      });
    }

    if (path === "/mcp/admin/recalculate-pav" && request.method === "POST") {
      await recalculatePav(env);
      return Response.json({ status: "ok" });
    }

    if (path === "/mcp/admin/recalculate-all-pav" && request.method === "POST") {
      const results = await calculateAllPav(env);
      return Response.json({ status: "ok", results });
    }

    if (path === "/mcp/admin/sync" && request.method === "POST") {
      await sync(env);
      return Response.json({ status: "ok" });
    }

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return handleMcpRequest(request, env, ctx);
    }

    return new Response("AFL MCP Server", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sync(env));
  },
};

export { DbProxy } from "./sandbox/executor";
export type { Env };
