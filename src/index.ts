import type { CompetitionCode } from "fitzroy";
import { handleMcpRequest } from "./mcp/protocol";
import { calculateAllPav, recalculatePav } from "./sync/pav";
import { sync } from "./sync/sync";
import type { Env } from "./types";

const ALL_COMPETITIONS: readonly CompetitionCode[] = ["AFLM", "AFLW", "VFL", "VFLW"] as const;
const VALID_COMPETITIONS: ReadonlySet<string> = new Set(ALL_COMPETITIONS);

interface BackfillRequestBody {
  competitions: readonly CompetitionCode[];
  fromYear: number;
  toYear: number;
  skipShouldRunNow?: boolean;
  skipPav?: boolean;
}

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
      await Promise.all([recalculatePav(env, "AFLM"), recalculatePav(env, "AFLW")]);
      return Response.json({ status: "ok" });
    }

    if (path === "/mcp/admin/recalculate-all-pav" && request.method === "POST") {
      const results = await calculateAllPav(env);
      return Response.json({ status: "ok", results });
    }

    if (path === "/mcp/admin/sync" && request.method === "POST") {
      await sync(env, ALL_COMPETITIONS);
      return Response.json({ status: "ok" });
    }

    if (path === "/mcp/admin/backfill" && request.method === "POST") {
      let body: BackfillRequestBody;
      try {
        body = (await request.json()) as BackfillRequestBody;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }

      const validation = validateBackfill(body);
      if (validation !== null) {
        return Response.json({ error: validation }, { status: 400 });
      }

      const results = await sync(env, body.competitions, {
        fromYear: body.fromYear,
        toYear: body.toYear,
        skipShouldRunNow: body.skipShouldRunNow ?? true,
        skipPav: body.skipPav ?? false,
      });
      return Response.json({ status: "ok", results });
    }

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return handleMcpRequest(request, env, ctx);
    }

    return new Response("Australian Football MCP Server", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sync(env, ALL_COMPETITIONS));
  },
};

function validateBackfill(body: BackfillRequestBody): string | null {
  if (!Array.isArray(body.competitions) || body.competitions.length === 0) {
    return "competitions must be a non-empty array";
  }
  for (const c of body.competitions) {
    if (typeof c !== "string" || !VALID_COMPETITIONS.has(c)) {
      return `invalid competition code: ${String(c)}`;
    }
  }
  if (typeof body.fromYear !== "number" || !Number.isInteger(body.fromYear)) {
    return "fromYear must be an integer";
  }
  if (typeof body.toYear !== "number" || !Number.isInteger(body.toYear)) {
    return "toYear must be an integer";
  }
  if (body.toYear < body.fromYear) {
    return "toYear must be >= fromYear";
  }
  return null;
}

export { DbProxy } from "./sandbox/executor";
export type { Env };
