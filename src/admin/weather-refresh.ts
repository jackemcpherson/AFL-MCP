import { Schema } from "effect";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { resolveStoredSeason } from "../db/seasons";
import { CompetitionCodeSchema } from "../lib/competitions";
import { type Decoder, decodeRow, strictDecoder } from "../lib/decode";
import { sha256Hex } from "../lib/hash";
import {
  type EvidenceSchema,
  PositiveIntSchema,
  SeasonSelectorSchema,
  Sha256HexSchema,
  booleanDefault,
  evidenceSchema,
} from "../lib/schemas";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import type { Env } from "../types";
import { runWeatherStage } from "../weather/stage";
import { OperationConflictError } from "./errors";

/**
 * One fixture's weather context. Field order follows the SELECT, because the
 * decoded row goes into the manifest digest.
 */
const FixtureContextSchema = Schema.Struct({
  id: Schema.Number,
  season_id: Schema.Number,
  date: Schema.String,
  local_time: Schema.NullOr(Schema.String),
  kickoff_at: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  venue_id: Schema.NullOr(Schema.Number),
  canonical_venue_id: Schema.NullOr(Schema.Number),
  latitude: Schema.NullOr(Schema.Number),
  longitude: Schema.NullOr(Schema.Number),
});

/** The reviewed context and evidence recorded with an earlier approved digest. */
const decodeRecordedManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      context: FixtureContextSchema,
      evidence: Schema.Array(
        Schema.Struct({ url: Schema.String, sha256: Schema.String, explanation: Schema.String }),
      ),
    }),
  ),
);

/** Exact weather recomputation after reviewing a fixture or venue correction. */
export const WeatherRefreshRequestSchema: Schema.Struct<{
  readonly competition: typeof CompetitionCodeSchema;
  readonly season: Schema.Union<readonly [Schema.Int, Schema.String]>;
  readonly matchId: Schema.Int;
  readonly evidence: Schema.$Array<EvidenceSchema>;
  readonly dryRun: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly manifestDigest: Schema.optionalKey<Schema.String>;
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
}> = Schema.Struct({
  competition: CompetitionCodeSchema,
  season: SeasonSelectorSchema,
  matchId: PositiveIntSchema,
  evidence: Schema.Array(evidenceSchema(1)).check(Schema.isMinLength(1)),
  dryRun: booleanDefault(true),
  manifestDigest: Schema.optionalKey(Sha256HexSchema),
  resume: booleanDefault(false),
});

/** A validated weather refresh request. */
export type WeatherRefreshRequest = typeof WeatherRefreshRequestSchema.Type;

/** Decode a weather refresh body, rejecting unknown keys. */
export const decodeWeatherRefreshRequest: Decoder<WeatherRefreshRequest> = strictDecoder(
  WeatherRefreshRequestSchema,
);

/**
 * Outcome of a weather refresh call. `busy` alone means another operation
 * holds the lease. A preview carries the reviewed `manifest`; an applied or
 * idempotent repeat reports `applied` and `idempotent`.
 */
export interface WeatherRefreshResult {
  readonly busy: boolean;
  readonly dryRun?: boolean;
  readonly applied?: boolean;
  readonly idempotent?: boolean;
  readonly manifestDigest?: string | undefined;
  readonly manifest?: Readonly<Record<string, unknown>>;
}

/**
 * Recompute one reviewed fixture's weather under the public input fence.
 * @param env - Worker bindings.
 * @param request - Exact fixture, evidence and approved preview digest.
 * @returns Preview, completed operation or lease contention.
 * @throws If the preview is stale, recovery scope differs or a DB write fails.
 * @example
 * await refreshWeather(env, Result.getOrThrow(decodeWeatherRefreshRequest(body)));
 */
export async function refreshWeather(
  env: Env,
  request: WeatherRefreshRequest,
): Promise<WeatherRefreshResult> {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  try {
    const season = await resolveStoredSeason(env, request.competition, request.season);
    const contextRow =
      await env.DB.prepare(`SELECT m.id,m.season_id,m.date,m.local_time,m.kickoff_at,m.status,m.venue_id,
      cv.id AS canonical_venue_id,cv.latitude,cv.longitude FROM matches m
      LEFT JOIN venues v ON v.id=m.venue_id LEFT JOIN venues cv ON cv.id=COALESCE(v.canonical_venue_id,v.id)
      WHERE m.id=?1 AND m.season_id=?2`)
        .bind(request.matchId, season.id)
        .first();
    const context = decodeRow(contextRow, FixtureContextSchema);
    if (!context)
      throw new OperationConflictError({ message: "No fixture in this exact season scope" });
    const prior =
      !request.dryRun && request.manifestDigest
        ? await env.DB.prepare(
            "SELECT manifest_json,status FROM weather_repair_operations WHERE manifest_digest=?1",
          )
            .bind(request.manifestDigest)
            .first<{ manifest_json: string; status: string }>()
        : null;
    if (prior) {
      const recorded = decodeRecordedManifest(prior.manifest_json);
      if (
        JSON.stringify(recorded.context) !== JSON.stringify(context) ||
        JSON.stringify(recorded.evidence) !== JSON.stringify(request.evidence)
      )
        throw new OperationConflictError({
          message: "Weather recovery differs from the reviewed fixture context or evidence",
        });
      if (prior.status === "complete") {
        const operation = `weather:${request.manifestDigest}`;
        const marker = await env.DB.prepare(
          "SELECT in_progress,write_operation FROM public_input_revision WHERE id=1",
        ).first<{ in_progress: number; write_operation: string | null }>();
        if (marker?.in_progress === 1 && marker.write_operation === operation) {
          if (!request.resume)
            throw new OperationConflictError({
              message: "Weather finalisation requires explicit resume",
            });
          await resumePublicInputWrite(env, holder, operation);
          await finishPublicInputWrite(env, holder);
        }
        return {
          busy: false,
          applied: true,
          idempotent: true,
          manifestDigest: request.manifestDigest,
        };
      }
      if (!request.resume)
        throw new OperationConflictError({
          message: "Interrupted weather refresh requires explicit resume",
        });
    }
    const snapshots = await env.DB.batch([
      env.DB.prepare("SELECT * FROM match_weather WHERE match_id=?1 ORDER BY kind").bind(
        request.matchId,
      ),
      env.DB.prepare(
        "SELECT * FROM weather_refresh_state WHERE match_id=?1 ORDER BY kind,source",
      ).bind(request.matchId),
    ]);
    const manifest = {
      season,
      context,
      evidence: request.evidence,
      snapshots: snapshots.map((row) => row.results),
    };
    const digest = prior ? request.manifestDigest : await sha256Hex(JSON.stringify(manifest));
    if (request.dryRun) return { busy: false, dryRun: true, manifestDigest: digest, manifest };
    if (!digest || digest !== request.manifestDigest)
      throw new OperationConflictError({ message: "Weather refresh preview missing or stale" });
    if (
      context.status !== "Cancelled" &&
      (!context.kickoff_at ||
        !context.local_time ||
        context.latitude === null ||
        context.longitude === null)
    )
      throw new OperationConflictError({
        message: "Verified kickoff and canonical venue coordinates are required",
      });
    const operation = `weather:${digest}`;
    if (prior || request.resume) await resumePublicInputWrite(env, holder, operation);
    else await beginPublicInputWrite(env, holder, new Date(), operation);
    marked = true;
    const writer = protectOperationWrites(env, holder);
    await writer.DB.batch([
      ...(!prior
        ? [
            writer.DB.prepare(
              "INSERT INTO weather_repair_operations(manifest_digest,match_id,manifest_json,status) VALUES(?1,?2,?3,'pending')",
            ).bind(digest, request.matchId, JSON.stringify(manifest)),
          ]
        : []),
      writer.DB.prepare("DELETE FROM match_weather WHERE match_id=?1").bind(request.matchId),
      writer.DB.prepare("DELETE FROM weather_refresh_state WHERE match_id=?1").bind(
        request.matchId,
      ),
    ]);
    await runWeatherStage(writer, fetch, new Date(), request.matchId);
    await writer.DB.prepare(
      "UPDATE weather_repair_operations SET status='complete' WHERE manifest_digest=?1",
    )
      .bind(digest)
      .run();
    consistent = true;
    return { busy: false, applied: true, idempotent: false, manifestDigest: digest };
  } finally {
    try {
      if (marked && consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
}
