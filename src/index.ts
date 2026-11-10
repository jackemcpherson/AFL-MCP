import { Result, Schema } from "effect";
import {
  decodeBackfillRequest,
  decodeExactSeasonBackfillRequest,
  describeBackfillIssue,
  decodeSeasonPresence,
} from "./admin/backfill";
import {
  backfillBrownlow,
  decodeBrownlowBackfillRequest,
  describeBrownlowBackfillIssue,
} from "./admin/brownlow";
import { decodeBearsRepairRequest, reconcileBearsIdentity } from "./admin/club-identities";
import { backfillCoaches, decodeCoachingBackfillRequest } from "./admin/coaching";
import { MIN_COACHING_YEAR } from "./lib/coaching-queries";
import { OperationConflictError, OperationRequestError } from "./admin/errors";
import { decodePavRepairRequest, repairPav } from "./admin/pav";
import { decodeIdentityRepairRequest, repairPlayerIdentity } from "./admin/player-identities";
import { decodeStatsRefreshRequest, operateStatsRefresh } from "./admin/stats-refresh";
import { getAdminStatus } from "./admin/status";
import { decodeWeatherRefreshRequest, refreshWeather } from "./admin/weather-refresh";
import { decodeWeatherRetryRequest, retryWeather } from "./admin/weather-retry";
import { SeasonSelectionError, seasonKey } from "./db/seasons";
import { COMPETITION_CODES } from "./lib/competitions";
import { type Decoder, decodeRow, describeIssue } from "./lib/decode";
import { boundedErrorText, logError } from "./lib/errors";
import { toSeasonSelector } from "./lib/schemas";
import { playedMatch } from "./lib/match-state";
import { handleMcpRequest } from "./mcp/protocol";
import { decodeSyncRequest } from "./mcp/validation";
import { auditNextSeason } from "./sync/audit";
import { isHourlyTick, sync } from "./sync/sync";
import type { Env } from "./types";

/** Earliest season in the historical record. */
const MIN_BACKFILL_YEAR = 1897;

/** Maximum years per backfill request, bounding upstream fetch amplification. */
const MAX_BACKFILL_YEARS = 30;

/** Earliest season supported by the AFL Tables Brownlow operation. */
const MIN_BROWNLOW_YEAR = 1990;

/** Maximum Brownlow seasons per request, bounding upstream match-page fetches. */
const MAX_BROWNLOW_YEARS = 2;

/** /mcp/health reports unhealthy when the newest sync_log row is older than this. */
const SYNC_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

/** The timestamp of a `sync_log` row read by the health check. */
const SyncLogTimestampSchema = Schema.Struct({ timestamp: Schema.String });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/health" || path === "/mcp/health") {
      if (env.MCP_RATE_LIMIT) {
        const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
        const { success } = await env.MCP_RATE_LIMIT.limit({ key: ip });
        if (!success) {
          return Response.json(
            { error: "rate limit exceeded" },
            { status: 429, headers: { "Retry-After": "60" } },
          );
        }
      }
      const [freshness, lastSyncRow, lastCriticalRow] = await Promise.all([
        env.DB.prepare(
          `SELECT MAX(m.date) as latest_match FROM matches m WHERE ${playedMatch("m")}`,
        ).first(),
        env.DB.prepare(
          `SELECT timestamp, type, rows_affected, error FROM sync_log
           WHERE type != 'admin:brownlow-backfill'
           ORDER BY id DESC LIMIT 1`,
        ).first(),
        // Sub-task rows (sync:*:lineups, sync:*:stats) record routine
        // degradations — e.g. lineup 404s before teams are announced — and
        // must not page. A successful retry clears only its own competition
        // failure. Fatal errors still require the existing expiry window.
        env.DB.prepare(
          `SELECT failure.timestamp, failure.type, failure.error FROM sync_log failure
           WHERE failure.error IS NOT NULL AND failure.timestamp >= ?
             AND (failure.type = 'sync:fatal' OR failure.type IN ('sync:AFLM','sync:AFLW','sync:VFL','sync:VFLW'))
             AND NOT EXISTS (
               SELECT 1 FROM sync_log recovery
               WHERE recovery.type = failure.type AND recovery.id > failure.id
                 AND recovery.error IS NULL
             )
           ORDER BY failure.id DESC LIMIT 1`,
        )
          .bind(new Date(Date.now() - SYNC_STALE_AFTER_MS).toISOString())
          .first(),
      ]);
      // The cadence gate always lets the hourly tick through and every
      // synced competition writes a sync_log row, so a quiet log means the
      // cron itself is broken. Returning 503 lets any dumb uptime monitor
      // alert on status code alone (OPS-02).
      const lastTimestamp = decodeRow(lastSyncRow, SyncLogTimestampSchema)?.timestamp ?? null;
      const ageMs = lastTimestamp === null ? null : Date.now() - Date.parse(lastTimestamp);
      const isStale = ageMs === null || Number.isNaN(ageMs) || ageMs > SYNC_STALE_AFTER_MS;
      const criticalTimestamp = decodeRow(lastCriticalRow, SyncLogTimestampSchema)?.timestamp;
      const criticalTs = criticalTimestamp === undefined ? null : Date.parse(criticalTimestamp);
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
          latest_match: freshness?.["latest_match"],
          has_recent_critical_error: hasRecentCriticalError,
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
      } catch (error) {
        return adminErrorResponse(path, error);
      }
    }

    // Only the MCP endpoint itself (with or without a trailing slash) reaches
    // the protocol handler. Any other /mcp/* path is unknown and must 404.
    if (path === "/mcp" || path === "/mcp/") {
      return handleMcpRequest(request, env, ctx);
    }

    if (path === "/") {
      return new Response("Australian Football MCP Server", { status: 200 });
    }

    // Unknown paths must 404. Claude Web probes /.well-known/oauth-* before
    // connecting; a 200 here makes it assume OAuth exists and attempt dynamic
    // client registration, which fails and blocks the connection entirely.
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.SYNC_PAUSED === "true") return;
    // An exception before the per-competition try/catch (e.g. in the
    // shouldRunNow gate) was previously invisible — waitUntil swallowed
    // it. Record a sync:fatal row so /mcp/health turns unhealthy (OPS-02).
    // One clock for the whole tick: the scheduled time decides which stages
    // run, so a late start cannot drop the hourly work.
    const tick = new Date(event.scheduledTime);
    ctx.waitUntil(
      sync(env, COMPETITION_CODES, { now: tick })
        .then(async () => {
          if (isHourlyTick(tick)) await auditNextSeason(env, tick);
        })
        .catch(async (err) => {
          logError("sync_fatal", err);
          try {
            await env.DB.prepare(
              "INSERT INTO sync_log (timestamp, type, rows_affected, error) VALUES (?, 'sync:fatal', 0, ?)",
            )
              .bind(new Date().toISOString(), boundedErrorText(err))
              .run();
          } catch (logErr) {
            logError("sync_fatal_log_failed", logErr);
          }
        }),
    );
  },
};

/**
 * Map a failure thrown by an admin route to its HTTP response.
 *
 * Tagged selection, request and conflict errors carry application-written
 * messages and become 4xx bodies: an invalid request is 400, a missing
 * season 404 and a state conflict 409. Anything else is logged without its message and
 * becomes a generic 500.
 *
 * @param path - Admin route path, recorded in the failure log.
 * @param error - The thrown value.
 * @returns The error response.
 */
function adminErrorResponse(path: string, error: unknown): Response {
  if (error instanceof SeasonSelectionError)
    return Response.json(
      { error: error.message, code: error.code, validSelectors: error.validSelectors },
      { status: error.code === "SEASON_NOT_FOUND" ? 404 : 400 },
    );
  if (error instanceof OperationRequestError)
    return Response.json({ error: error.message, code: error.code }, { status: 400 });
  if (error instanceof OperationConflictError)
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  logError("admin_route_error", error, { path });
  return Response.json({ error: "internal error" }, { status: 500 });
}

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

/** Longest caller-facing request error returned in a 400 body. */
const MAX_REQUEST_ERROR_CHARS = 200;

/**
 * The 400 reply for a request the route cannot accept.
 *
 * @param message - Application-written description of the first problem.
 *   It may quote a key the caller sent, so it is cut to a bounded length.
 * @returns The 400 response.
 */
function invalidRequest(message: string): Response {
  const error =
    message.length > MAX_REQUEST_ERROR_CHARS
      ? `${message.slice(0, MAX_REQUEST_ERROR_CHARS)}…`
      : message;
  return Response.json({ error }, { status: 400 });
}

/**
 * The single 409 reply every admin route gives while another operation
 * holds the lease.
 *
 * @returns The 409 response.
 */
function leaseBusy(): Response {
  return Response.json(
    { error: "operation lease held", code: "OPERATION_BUSY", busy: true },
    { status: 409 },
  );
}

/**
 * Parse and decode a JSON request body.
 *
 * @param request - The admin request.
 * @param decode - The route's strict body decoder.
 * @param describe - Maps a decode failure to its caller-facing message.
 * @returns The decoded body, or the 400 response to return.
 */
async function decodeBody<A>(
  request: Request,
  decode: Decoder<A>,
  describe: (error: Schema.SchemaError) => string = describeIssue,
): Promise<Result.Result<A, Response>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return Result.fail(invalidRequest("invalid JSON body"));
  }
  const parsed = decode(raw);
  return Result.isFailure(parsed)
    ? Result.fail(invalidRequest(describe(parsed.failure)))
    : Result.succeed(parsed.success);
}

async function handleAdmin(path: string, request: Request, env: Env): Promise<Response> {
  if (path === "/mcp/admin/repair-player-identity" && request.method === "POST") {
    const parsed = await decodeBody(request, decodeIdentityRepairRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const result = await repairPlayerIdentity(env, parsed.success);
    return result.busy ? leaseBusy() : Response.json(result);
  }

  if (path === "/mcp/admin/refresh-statistics" && request.method === "POST") {
    const parsed = await decodeBody(request, decodeStatsRefreshRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const result = await operateStatsRefresh(env, parsed.success);
    return result.busy ? leaseBusy() : Response.json(result);
  }

  if (path === "/mcp/admin/refresh-weather" && request.method === "POST") {
    const parsed = await decodeBody(request, decodeWeatherRefreshRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const result = await refreshWeather(env, parsed.success);
    return result.busy ? leaseBusy() : Response.json(result);
  }

  if (path === "/mcp/admin/retry-weather" && request.method === "POST") {
    const parsed = await decodeBody(request, decodeWeatherRetryRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const result = await retryWeather(env, parsed.success);
    return result.busy ? leaseBusy() : Response.json(result);
  }

  if (path === "/mcp/admin/status" && request.method === "GET") {
    return Response.json(await getAdminStatus(env));
  }

  if (path === "/mcp/admin/backfill-coaches" && request.method === "POST") {
    const parsed = await decodeBody(request, decodeCoachingBackfillRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const { fromYear, toYear, source, dryRun, resume } = parsed.success;
    // The body names a year range for symmetry with the other backfills,
    // but one request imports exactly one season.
    const rangeError = validateYearRange(fromYear, toYear, MIN_COACHING_YEAR, 1);
    if (rangeError !== null) return invalidRequest(rangeError);
    const result = await backfillCoaches(env, fromYear, source, dryRun, resume);
    if (result.busy) return leaseBusy();
    if (result.sourceFailed)
      return Response.json(
        { error: "coaching source fetch failed; retry later", code: "SOURCE_UNAVAILABLE" },
        { status: 502 },
      );
    return Response.json({ status: "ok", ...result.summary });
  }

  if (path === "/mcp/admin/reconcile-bears" && request.method === "POST") {
    const parsed = await decodeBody(request, decodeBearsRepairRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const result = await reconcileBearsIdentity(env, parsed.success.dryRun, parsed.success);
    if (result.busy) return leaseBusy();
    return Response.json({
      status: "ok",
      ...result.report,
      manifestDigest: result.manifestDigest,
      matchIds: result.matchIds,
    });
  }

  if (path === "/mcp/admin/backfill-brownlow" && request.method === "POST") {
    const parsed = await decodeBody(
      request,
      decodeBrownlowBackfillRequest,
      describeBrownlowBackfillIssue,
    );
    if (Result.isFailure(parsed)) return parsed.failure;
    const { fromYear, toYear, dryRun, resume } = parsed.success;
    const rangeError = validateYearRange(fromYear, toYear, MIN_BROWNLOW_YEAR, MAX_BROWNLOW_YEARS);
    if (rangeError !== null) return invalidRequest(rangeError);
    const result = await backfillBrownlow(env, fromYear, toYear, dryRun, resume);
    if (result.busy) return leaseBusy();
    return Response.json(result.body, { status: result.httpStatus });
  }

  if (path === "/mcp/admin/recalculate-pav" && request.method === "POST") {
    const parsed = await decodeBody(request, decodePavRepairRequest);
    if (Result.isFailure(parsed)) return parsed.failure;
    const result = await repairPav(env, parsed.success);
    return result.busy ? leaseBusy() : Response.json(result);
  }

  if (path === "/mcp/admin/recalculate-all-pav" && request.method === "POST") {
    return Response.json(
      { error: "Use /mcp/admin/recalculate-pav with one explicit competition and season" },
      { status: 410 },
    );
  }

  if (path === "/mcp/admin/sync" && request.method === "POST") {
    // An empty body is a plain sync with the defaults.
    const text = await request.text();
    let raw: unknown;
    try {
      raw = text.trim() ? JSON.parse(text) : {};
    } catch {
      return invalidRequest("invalid JSON body");
    }
    const parsed = decodeSyncRequest(raw);
    if (Result.isFailure(parsed)) return invalidRequest(describeIssue(parsed.failure));
    const results = await sync(env, COMPETITION_CODES, {
      skipShouldRunNow: true,
      resume: parsed.success.resume,
    });
    return Response.json({ status: "ok", results });
  }

  if (path === "/mcp/admin/backfill" && request.method === "POST") {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      return invalidRequest("invalid JSON body");
    }

    if (Result.isSuccess(decodeSeasonPresence(raw))) {
      const exact = decodeExactSeasonBackfillRequest(raw);
      if (Result.isFailure(exact)) return invalidRequest(describeIssue(exact.failure));
      const key = seasonKey(exact.success.competition, exact.success.season);
      const year = Number(key.slice(0, 4));
      if (year < MIN_BACKFILL_YEAR || year > new Date().getUTCFullYear())
        return invalidRequest("season is outside the historical backfill range");
      const results = await sync(env, [exact.success.competition], {
        season: toSeasonSelector(exact.success.season),
        fixturesOnly: exact.success.fixturesOnly,
        skipShouldRunNow: exact.success.skipShouldRunNow,
        resume: exact.success.resume,
      });
      return Response.json({ status: "ok", results });
    }

    const parsed = decodeBackfillRequest(raw);
    if (Result.isFailure(parsed)) return invalidRequest(describeBackfillIssue(parsed.failure));
    const body = parsed.success;

    const rangeError = validateYearRange(
      body.fromYear,
      body.toYear,
      MIN_BACKFILL_YEAR,
      MAX_BACKFILL_YEARS,
    );
    if (rangeError !== null) return invalidRequest(rangeError);

    // AFLW played two 2022 seasons (2022-S6 and 2022-S7), so a calendar-year
    // range cannot name one of them. The caller must use the exact-season form.
    if (body.competitions.includes("AFLW") && body.fromYear <= 2022 && body.toYear >= 2022)
      throw new SeasonSelectionError({
        message: "Ambiguous AFLW season 2022; choose 2022-S6 or 2022-S7",
        code: "AMBIGUOUS_SEASON",
        validSelectors: ["2022-S6", "2022-S7"],
      });

    const results = await sync(env, body.competitions, {
      fromYear: body.fromYear,
      toYear: body.toYear,
      skipShouldRunNow: body.skipShouldRunNow ?? true,
      resume: body.resume,
    });
    return Response.json({ status: "ok", results });
  }

  return Response.json({ error: "not found" }, { status: 404 });
}

/**
 * Cross-field clamps on a year-range request (SEC-02). Shape validation
 * lives in each route's request schema.
 *
 * @param fromYear - First season, inclusive.
 * @param toYear - Final season, inclusive.
 * @param minYear - Earliest season the operation supports.
 * @param maxYears - Most seasons one request may cover.
 * @returns The caller-facing problem, or null when the range is accepted.
 * @example
 * validateYearRange(2024, 2025, MIN_BROWNLOW_YEAR, MAX_BROWNLOW_YEARS); // null
 */
function validateYearRange(
  fromYear: number,
  toYear: number,
  minYear: number,
  maxYears: number,
): string | null {
  if (toYear < fromYear) return "toYear must be >= fromYear";
  const currentYear = new Date().getUTCFullYear();
  if (fromYear < minYear || toYear > currentYear) {
    return `years must be between ${minYear} and ${currentYear}`;
  }
  if (toYear - fromYear + 1 > maxYears) {
    return maxYears === 1
      ? "fromYear and toYear must be the same year"
      : `year range too large: max ${maxYears} years per request`;
  }
  return null;
}

export { DbProxy } from "./sandbox/db-proxy";
export type { Env };
