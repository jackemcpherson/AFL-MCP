import { z } from "zod";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { resolveStoredSeason } from "../db/seasons";
import { MIN_PAV_YEAR_BY_COMPETITION } from "../lib/constants";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import { calculatePav } from "../sync/pav";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

/** One reviewed competition-season replacement; no implicit calendar-year scope. */
export const PavRepairRequestSchema = z.strictObject({
  competition: z.enum(["AFLM", "AFLW"]),
  season: z.union([z.number().int(), z.string()]),
  dryRun: z.boolean().default(true),
  resume: z.boolean().default(false),
  manifestDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

/**
 * Preview or atomically replace one season's PAV while readers remain blocked.
 * Explicit recovery recomputes the same season after an interrupted replacement.
 * @param env - Worker bindings.
 * @param request - Exact season and approved preview digest.
 * @returns Input revision and scope preview, or replaced row count.
 * @throws When the preview is stale, recovery scope differs, or D1 fails.
 */
export async function repairPav(env: Env, request: z.infer<typeof PavRepairRequestSchema>) {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  try {
    const season = await resolveStoredSeason(env, request.competition, request.season);
    if (season.year < MIN_PAV_YEAR_BY_COMPETITION[request.competition])
      throw new OperationConflictError("PAV is unsupported for this competition-season");
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
        throw new OperationConflictError("Recover the active public write before previewing PAV");
      return { busy: false, dryRun: true, ...preview, manifestDigest: digest };
    }
    if (request.resume) {
      if (!request.manifestDigest)
        throw new OperationConflictError("Recovery requires the approved preview digest");
      await resumePublicInputWrite(env, holder, `pav:${season.id}:${request.manifestDigest}`);
    } else {
      if (request.manifestDigest !== digest)
        throw new OperationConflictError("PAV preview missing or stale");
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
