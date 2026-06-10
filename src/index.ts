import type { CompetitionCode } from "fitzroy";
import { handleMcpRequest } from "./mcp/protocol";
import {
  type BackfillRequest,
  BackfillRequestSchema,
  describeBackfillIssue,
} from "./mcp/validation";
import { calculateAllPav, recalculatePav } from "./sync/pav";
import { sync } from "./sync/sync";
import type { Env } from "./types";

const ALL_COMPETITIONS: readonly CompetitionCode[] = ["AFLM", "AFLW", "VFL", "VFLW"] as const;

/** Earliest season in the historical record. */
const MIN_BACKFILL_YEAR = 1897;

/** Maximum years per backfill request, bounding upstream fetch amplification. */
const MAX_BACKFILL_YEARS = 30;

/** /mcp/health reports unhealthy when the newest sync_log row is older than this. */
const SYNC_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" || path === "/mcp/health") {
      const [freshness, lastSync, lastCritical] = await Promise.all([
        env.DB.prepare(
          "SELECT MAX(date) as latest_match FROM matches WHERE home_points IS NOT NULL",
        ).first(),
        env.DB.prepare(
          "SELECT timestamp, type, rows_affected, error FROM sync_log ORDER BY id DESC LIMIT 1",
        ).first(),
        // Sub-task rows (sync:*:lineups, sync:*:stats) record routine
        // degradations — e.g. lineup 404s before teams are announced — and
        // must not page. Only whole-competition failures or sync:fatal count.
        env.DB.prepare(
          `SELECT timestamp, type, error FROM sync_log
           WHERE error IS NOT NULL
             AND (type = 'sync:fatal' OR type IN ('sync:AFLM','sync:AFLW','sync:VFL','sync:VFLW'))
           ORDER BY id DESC LIMIT 1`,
        ).first(),
      ]);
      // The cadence gate always lets the hourly tick through and every
      // synced competition writes a sync_log row, so a quiet log means the
      // cron itself is broken. Returning 503 lets any dumb uptime monitor
      // alert on status code alone (OPS-02).
      const lastTimestamp = typeof lastSync?.timestamp === "string" ? lastSync.timestamp : null;
      const ageMs = lastTimestamp === null ? null : Date.now() - Date.parse(lastTimestamp);
      const isStale = ageMs === null || Number.isNaN(ageMs) || ageMs > SYNC_STALE_AFTER_MS;
      const criticalTs =
        typeof lastCritical?.timestamp === "string" ? Date.parse(lastCritical.timestamp) : null;
      const hasRecentCriticalError =
        criticalTs !== null &&
        !Number.isNaN(criticalTs) &&
        Date.now() - criticalTs <= SYNC_STALE_AFTER_MS;
      const isHealthy = !isStale && !hasRecentCriticalError;
      return Response.json(
        {
          status: isHealthy ? "ok" : "unhealthy",
          stale: isStale,
          last_sync_age_ms: ageMs,
          latest_match: freshness?.latest_match,
          last_sync: lastSync,
          last_critical_error: lastCritical ?? null,
        },
        { status: isHealthy ? 200 : 503 },
      );
    }

    if (path.startsWith("/mcp/admin/")) {
      const denied = requireAdmin(request, env);
      if (denied) {
        return denied;
      }
      try {
        return await handleAdmin(path, request, env);
      } catch (err) {
        console.error("admin route error:", err);
        return Response.json({ error: "internal error" }, { status: 500 });
      }
    }

    if (path === "/mcp" || path.startsWith("/mcp/")) {
      return handleMcpRequest(request, env, ctx);
    }

    return new Response("Australian Football MCP Server", { status: 200 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    // An exception before the per-competition try/catch (e.g. in the
    // shouldRunNow gate) was previously invisible — waitUntil swallowed
    // it. Record a sync:fatal row so /mcp/health turns unhealthy (OPS-02).
    ctx.waitUntil(
      sync(env, ALL_COMPETITIONS).catch(async (err) => {
        console.error("sync fatal:", err);
        try {
          await env.DB.prepare(
            "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?, 'sync:fatal', 0, ?)",
          )
            .bind(new Date().toISOString(), err instanceof Error ? err.message : String(err))
            .run();
        } catch (logErr) {
          console.error("sync fatal logging failed:", logErr);
        }
      }),
    );
  },
};

/**
 * Authorises an admin request via `Authorization: Bearer <ADMIN_TOKEN>`.
 *
 * Fails closed: when no token is configured the admin surface is disabled
 * entirely rather than left open.
 *
 * @returns A denial response, or null when the request is authorised.
 */
function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_TOKEN) {
    return Response.json({ error: "admin endpoints are not configured" }, { status: 503 });
  }
  const auth = request.headers.get("authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
  if (!timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

/** Constant-time string comparison so token checks don't leak match length/prefix. */
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

async function handleAdmin(path: string, request: Request, env: Env): Promise<Response> {
  if (path === "/mcp/admin/recalculate-pav" && request.method === "POST") {
    // Optional ?year= override — the wall-clock default is wrong at
    // season/year boundaries (COR-11).
    const url = new URL(request.url);
    const yearParam = url.searchParams.get("year");
    let year: number | undefined;
    if (yearParam !== null) {
      const parsed = Number.parseInt(yearParam, 10);
      const currentYear = new Date().getUTCFullYear();
      if (!Number.isInteger(parsed) || parsed < MIN_BACKFILL_YEAR || parsed > currentYear) {
        return Response.json(
          { error: `year must be between ${MIN_BACKFILL_YEAR} and ${currentYear}` },
          { status: 400 },
        );
      }
      year = parsed;
    }
    await Promise.all([recalculatePav(env, "AFLM", year), recalculatePav(env, "AFLW", year)]);
    return Response.json({ status: "ok", year: year ?? new Date().getFullYear() });
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
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }

    const parsed = BackfillRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: describeBackfillIssue(parsed.error) }, { status: 400 });
    }
    const body = parsed.data;

    const rangeError = validateYearRange(body);
    if (rangeError !== null) {
      return Response.json({ error: rangeError }, { status: 400 });
    }

    const results = await sync(env, body.competitions, {
      fromYear: body.fromYear,
      toYear: body.toYear,
      skipShouldRunNow: body.skipShouldRunNow ?? true,
      skipPav: body.skipPav ?? false,
    });
    return Response.json({ status: "ok", results });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

/** Cross-field clamps (SEC-02); shape validation lives in BackfillRequestSchema. */
function validateYearRange(body: BackfillRequest): string | null {
  if (body.toYear < body.fromYear) {
    return "toYear must be >= fromYear";
  }
  const currentYear = new Date().getUTCFullYear();
  if (body.fromYear < MIN_BACKFILL_YEAR || body.toYear > currentYear) {
    return `years must be between ${MIN_BACKFILL_YEAR} and ${currentYear}`;
  }
  if (body.toYear - body.fromYear + 1 > MAX_BACKFILL_YEARS) {
    return `year range too large: max ${MAX_BACKFILL_YEARS} years per request`;
  }
  return null;
}

export { DbProxy } from "./sandbox/executor";
export type { Env };
