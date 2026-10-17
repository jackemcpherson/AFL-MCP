import { Schema } from "effect";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { resolveStoredSeason } from "../db/seasons";
import { CompetitionCodeSchema } from "../lib/competitions";
import { strictDecoder } from "../lib/decode";
import { booleanDefault, PositiveIntSchema, Sha256HexSchema } from "../lib/schemas";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import { refreshDueStats } from "../sync/stats-refresh";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

/** Explicit scope and resumable operation identity for historical corrections. */
export const StatsRefreshRequestSchema = Schema.Struct({
  competition: CompetitionCodeSchema,
  season: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 1897, maximum: 2100 })),
    Schema.String.check(Schema.isPattern(/^\d{4}(?:-S[67])?$/)),
  ]),
  matchId: Schema.optionalKey(PositiveIntSchema),
  operationId: Schema.String.check(Schema.isUUID()),
  dryRun: booleanDefault(true),
  resume: booleanDefault(false),
  manifestDigest: Schema.optionalKey(Sha256HexSchema),
});

/** A validated statistics refresh request. */
export type StatsRefreshRequest = typeof StatsRefreshRequestSchema.Type;

/** Decode a statistics refresh body, rejecting unknown keys. */
export const decodeStatsRefreshRequest = strictDecoder(StatsRefreshRequestSchema);

/**
 * Preview, start, or resume a bounded refresh without fetching unrelated seasons.
 * New operations require the digest returned by their concrete preview.
 * @param env - Worker bindings.
 * @param request - Validated operator scope and operation ID.
 * @returns Preview inventory, or batch progress. Repeating a completed ID is a no-op.

 * @throws If approval, recovery, lease ownership or a database operation fails.
 * @example
 * await operateStatsRefresh(env, Result.getOrThrow(decodeStatsRefreshRequest(body))); */
export async function operateStatsRefresh(env: Env, request: StatsRefreshRequest) {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  try {
    const season = await resolveStoredSeason(env, request.competition, request.season);
    const matches =
      await env.DB.prepare(`SELECT id, external_afl_id, home_team_id, away_team_id, date FROM matches
      WHERE season_id = ?1 AND (?2 IS NULL OR id = ?2) AND status = 'Complete'
      AND external_afl_id IS NOT NULL ORDER BY id`)
        .bind(season.id, request.matchId ?? null)
        .all();
    if (!matches.results.length)
      throw new OperationConflictError({
        message: "No eligible completed matches in requested scope",
      });
    const payload = JSON.stringify({ season, matches: matches.results });
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload))),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (request.dryRun)
      return {
        busy: false,
        dryRun: true,
        season,
        matches: matches.results,
        manifestDigest: digest,
      };
    const operation = await env.DB.prepare(
      "SELECT season_id, match_id, manifest_digest FROM stats_refresh_operations WHERE id = ?1",
    )
      .bind(request.operationId)
      .first<{ season_id: number; match_id: number | null; manifest_digest: string }>();
    if (
      operation &&
      (operation.season_id !== season.id || operation.match_id !== (request.matchId ?? null))
    ) {
      throw new OperationConflictError({
        message: "Operation ID already belongs to a different scope",
      });
    }
    if (!operation && request.manifestDigest !== digest)
      throw new OperationConflictError({
        message: "Preview digest missing or stale; preview again",
      });
    if (request.resume) {
      if ((operation?.manifest_digest ?? digest) !== request.manifestDigest)
        throw new OperationConflictError({
          message: "Recovery requires the existing operation and its approved digest",
        });
      await resumePublicInputWrite(env, holder, `stats:${request.operationId}`);
    } else await beginPublicInputWrite(env, holder, new Date(), `stats:${request.operationId}`);
    marked = true;
    const writer = protectOperationWrites(env, holder);
    const now = new Date();
    if (!operation) {
      await writer.DB.batch([
        writer.DB.prepare(
          "INSERT INTO stats_refresh_operations(id, season_id, match_id, manifest_digest, requested_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        ).bind(request.operationId, season.id, request.matchId ?? null, digest, now.toISOString()),
        writer.DB.prepare(`INSERT INTO stats_refresh_operation_matches(operation_id, match_id)
          SELECT ?1, id FROM matches WHERE season_id = ?2 AND (?3 IS NULL OR id = ?3)
          AND status = 'Complete' AND external_afl_id IS NOT NULL`).bind(
          request.operationId,
          season.id,
          request.matchId ?? null,
        ),
        writer.DB.prepare(`INSERT INTO match_stats_refresh(match_id, completed_observed_at, next_retry_at)
          SELECT match_id, ?1, ?1 FROM stats_refresh_operation_matches WHERE operation_id = ?2
          ON CONFLICT(match_id) DO UPDATE SET next_retry_at = excluded.next_retry_at`).bind(
          now.toISOString(),
          request.operationId,
        ),
      ]);
    }
    const report = await refreshDueStats(
      writer,
      now,
      undefined,
      season.id,
      request.operationId,
      holder,
    );
    const remaining = await writer.DB.prepare(
      "SELECT COUNT(*) AS n FROM stats_refresh_operation_matches WHERE operation_id = ?1 AND status = 'pending'",
    )
      .bind(request.operationId)
      .first<number>("n");
    consistent = true;
    return {
      busy: false,
      dryRun: false,
      operationId: request.operationId,
      ...report,
      remaining: remaining ?? 0,
    };
  } finally {
    try {
      if (marked && consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
}
