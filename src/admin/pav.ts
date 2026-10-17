import { Schema } from "effect";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { resolveStoredSeason, type StoredSeason } from "../db/seasons";
import { PavCompetitionSchema } from "../lib/competitions";
import { MIN_PAV_YEAR_BY_COMPETITION } from "../lib/constants";
import { type Decoder, strictDecoder } from "../lib/decode";
import { booleanDefault, SeasonSelectorSchema, Sha256HexSchema } from "../lib/schemas";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import { calculatePav } from "../sync/pav";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

/** One reviewed competition-season replacement; no implicit calendar-year scope. */
export const PavRepairRequestSchema: Schema.Struct<{
  readonly competition: Schema.Literals<readonly ["AFLM", "AFLW"]>;
  readonly season: Schema.Union<readonly [Schema.Int, Schema.String]>;
  readonly dryRun: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly manifestDigest: Schema.optionalKey<Schema.String>;
}> = Schema.Struct({
  competition: PavCompetitionSchema,
  season: SeasonSelectorSchema,
  dryRun: booleanDefault(true),
  resume: booleanDefault(false),
  manifestDigest: Schema.optionalKey(Sha256HexSchema),
});

/** A validated PAV repair request. */
export type PavRepairRequest = typeof PavRepairRequestSchema.Type;

/** Decode a PAV repair body, rejecting unknown keys. */
export const decodePavRepairRequest: Decoder<PavRepairRequest> =
  strictDecoder(PavRepairRequestSchema);

/**
 * Outcome of a PAV repair call. `busy` alone means another operation holds
 * the lease. A preview carries `inputRevision` and `manifestDigest`; an
 * applied repair carries `rows`.
 */
export interface PavRepairResult {
  readonly busy: boolean;
  readonly dryRun?: boolean;
  readonly season?: StoredSeason;
  readonly inputRevision?: number;
  readonly manifestDigest?: string;
  readonly rows?: number;
}

/**
 * Preview or atomically replace one season's PAV while readers remain blocked.
 * Explicit recovery recomputes the same season after an interrupted replacement.
 * @param env - Worker bindings.
 * @param request - Exact season and approved preview digest.
 * @returns Input revision and scope preview, or replaced row count.
 * @throws When the preview is stale, recovery scope differs, or D1 fails.

 * @example
 * await repairPav(env, Result.getOrThrow(decodePavRepairRequest(body))); */
export async function repairPav(env: Env, request: PavRepairRequest): Promise<PavRepairResult> {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  try {
    const season = await resolveStoredSeason(env, request.competition, request.season);
    if (season.year < MIN_PAV_YEAR_BY_COMPETITION[request.competition])
      throw new OperationConflictError({
        message: "PAV is unsupported for this competition-season",
      });
    const revision = await env.DB.prepare(
      "SELECT revision,in_progress,write_operation FROM public_input_revision WHERE id=1",
    ).first<{ revision: number; in_progress: number; write_operation: string | null }>();
    if (!revision) throw new Error("Public input revision is unavailable");
    const preview = { season, inputRevision: revision.revision };
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(preview))),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (request.dryRun) {
      if (revision.in_progress)
        throw new OperationConflictError({
          message: "Recover the active public write before previewing PAV",
        });
      return { busy: false, dryRun: true, ...preview, manifestDigest: digest };
    }
    if (request.resume) {
      if (!request.manifestDigest)
        throw new OperationConflictError({
          message: "Recovery requires the approved preview digest",
        });
      await resumePublicInputWrite(env, holder, `pav:${season.id}:${request.manifestDigest}`);
    } else {
      if (request.manifestDigest !== digest)
        throw new OperationConflictError({ message: "PAV preview missing or stale" });
      await beginPublicInputWrite(env, holder, new Date(), `pav:${season.id}:${digest}`);
    }
    marked = true;
    const writer = protectOperationWrites(env, holder);
    const rows = await calculatePav(writer, season.season_key, request.competition);
    await writer.DB.prepare("DELETE FROM pav_rebuild_queue WHERE season_id=?1")
      .bind(season.id)
      .run();
    consistent = true;
    return { busy: false, dryRun: false, season, rows };
  } finally {
    try {
      if (marked && consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
}
