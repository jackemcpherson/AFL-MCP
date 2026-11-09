import { Schema } from "effect";
import { runOperation } from "../db/operation";
import { resolveStoredSeason, type StoredSeason } from "../db/seasons";
import { CompetitionCodeSchema } from "../lib/competitions";
import { type Decoder, strictDecoder } from "../lib/decode";
import { sha256Hex } from "../lib/hash";
import { playedMatch } from "../lib/match-state";
import {
  booleanDefault,
  PositiveIntSchema,
  SeasonKeyStringSchema,
  Sha256HexSchema,
} from "../lib/schemas";
import { refreshDueStats, type StatsRefreshReport } from "../sync/stats-refresh";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

/** Explicit scope and resumable operation identity for historical corrections. */
export const StatsRefreshRequestSchema: Schema.Struct<{
  readonly competition: typeof CompetitionCodeSchema;
  readonly season: Schema.Union<readonly [Schema.Int, Schema.String]>;
  readonly matchId: Schema.optionalKey<Schema.Int>;
  readonly operationId: Schema.String;
  readonly dryRun: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly manifestDigest: Schema.optionalKey<Schema.String>;
}> = Schema.Struct({
  competition: CompetitionCodeSchema,
  season: Schema.Union([
    Schema.Int.check(Schema.isBetween({ minimum: 1897, maximum: 2100 })),
    SeasonKeyStringSchema,
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
export const decodeStatsRefreshRequest: Decoder<StatsRefreshRequest> =
  strictDecoder(StatsRefreshRequestSchema);

/**
 * Outcome of a stats refresh call. `busy` alone means another operation
 * holds the lease. A preview lists `matches` with a `manifestDigest`; a run
 * reports batch progress, the `remaining` match count and when the earliest
 * of them is next due.
 */
export interface StatsRefreshResult extends Partial<StatsRefreshReport> {
  readonly busy: boolean;
  readonly dryRun?: boolean;
  readonly season?: StoredSeason;
  readonly matches?: readonly Record<string, unknown>[];
  readonly manifestDigest?: string;
  readonly operationId?: string;
  readonly remaining?: number;
  /** Earliest time a pending match becomes due again; null when none is pending. */
  readonly nextRetryAt?: string | null;
}

/**
 * Preview, start, or resume a bounded refresh without fetching unrelated seasons.
 * New operations require the digest returned by their concrete preview.
 * @param env - Worker bindings.
 * @param request - Validated operator scope and operation ID.
 * @returns Preview inventory, or batch progress. Repeating a completed ID is a no-op.

 * @throws If approval, recovery, lease ownership or a database operation fails.
 * @example
 * await operateStatsRefresh(env, Result.getOrThrow(decodeStatsRefreshRequest(body))); */
export async function operateStatsRefresh(
  env: Env,
  request: StatsRefreshRequest,
): Promise<StatsRefreshResult> {
  return runOperation<StatsRefreshResult>(
    env,
    () => ({ busy: true }),
    async (operation) => {
      const season = await resolveStoredSeason(env, request.competition, request.season);
      const matches =
        await env.DB.prepare(`SELECT m.id, m.external_afl_id, m.home_team_id, m.away_team_id, m.date FROM matches m
      WHERE m.season_id = ?1 AND (?2 IS NULL OR m.id = ?2) AND ${playedMatch("m")}
      AND m.external_afl_id IS NOT NULL ORDER BY m.id`)
          .bind(season.id, request.matchId ?? null)
          .all();
      if (!matches.results.length)
        throw new OperationConflictError({
          message: "No eligible completed matches in requested scope",
        });
      const payload = JSON.stringify({ season, matches: matches.results });
      const digest = await sha256Hex(payload);
      if (request.dryRun)
        return {
          busy: false,
          dryRun: true,
          season,
          matches: matches.results,
          manifestDigest: digest,
        };
      const recorded = await env.DB.prepare(
        "SELECT season_id, match_id, manifest_digest FROM stats_refresh_operations WHERE id = ?1",
      )
        .bind(request.operationId)
        .first<{ season_id: number; match_id: number | null; manifest_digest: string }>();
      if (
        recorded &&
        (recorded.season_id !== season.id || recorded.match_id !== (request.matchId ?? null))
      ) {
        throw new OperationConflictError({
          message: "Operation ID already belongs to a different scope",
        });
      }
      if (!recorded && request.manifestDigest !== digest)
        throw new OperationConflictError({
          message: "Preview digest missing or stale; preview again",
        });
      if (request.resume && (recorded?.manifest_digest ?? digest) !== request.manifestDigest)
        throw new OperationConflictError({
          message: "Recovery requires the existing operation and its approved digest",
        });
      const writer = await operation.write(`stats:${request.operationId}`, {
        resume: request.resume,
      });
      const now = new Date();
      if (!recorded) {
        await writer.DB.batch([
          writer.DB.prepare(
            "INSERT INTO stats_refresh_operations(id, season_id, match_id, manifest_digest, requested_at) VALUES (?1, ?2, ?3, ?4, ?5)",
          ).bind(
            request.operationId,
            season.id,
            request.matchId ?? null,
            digest,
            now.toISOString(),
          ),
          writer.DB.prepare(`INSERT INTO stats_refresh_operation_matches(operation_id, match_id)
          SELECT ?1, m.id FROM matches m WHERE m.season_id = ?2 AND (?3 IS NULL OR m.id = ?3)
          AND ${playedMatch("m")} AND m.external_afl_id IS NOT NULL`).bind(
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
        operation.holder,
      );
      // Pending matches are either due now (the batch cap deferred them) or
      // backing off after a failed fetch. The earliest retry tells the operator
      // when repeating this call can make progress.
      const pending = await writer.DB.prepare(
        `SELECT COUNT(*) AS remaining, MIN(r.next_retry_at) AS nextRetryAt
       FROM stats_refresh_operation_matches o
       LEFT JOIN match_stats_refresh r ON r.match_id = o.match_id
       WHERE o.operation_id = ?1 AND o.status = 'pending'`,
      )
        .bind(request.operationId)
        .first<{ remaining: number; nextRetryAt: string | null }>();
      return {
        busy: false,
        dryRun: false,
        operationId: request.operationId,
        ...report,
        remaining: pending?.remaining ?? 0,
        nextRetryAt: pending?.nextRetryAt ?? null,
      };
    },
  );
}
