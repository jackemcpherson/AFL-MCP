import { z } from "zod";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  publicInputWriteFence,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { MIN_PAV_YEAR_BY_COMPETITION } from "../lib/constants";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import { calculatePav } from "../sync/pav";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

const EvidenceSchema = z.strictObject({
  url: z.url(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  explanation: z.string().min(20),
});
/** Evidence and explicit field decisions required for one verified identity group. */
export const IdentityRepairRequestSchema = z.strictObject({
  kind: z.enum(["merge", "reassign-appearances"]).default("merge"),
  canonicalId: z.number().int().positive().optional(),
  newPerson: z
    .strictObject({
      firstName: z.string().min(1),
      surname: z.string().min(1),
      dateOfBirth: z.iso.date(),
      evidence: EvidenceSchema,
    })
    .optional(),
  matchIds: z.array(z.number().int().positive()).max(500).default([]),
  playerIds: z.array(z.number().int().positive()).min(2).max(10),
  evidence: z.array(EvidenceSchema).min(1),
  providerIdentities: z
    .array(
      z.strictObject({
        provider: z.enum(["afl-api", "afl-tables", "fryzigg"]),
        providerId: z.string().min(1),
        evidence: EvidenceSchema,
      }),
    )
    .max(20)
    .default([]),
  resolutions: z
    .array(
      z.strictObject({
        table: z.enum(["player_match_stats", "match_lineups"]),
        matchId: z.number().int().positive(),
        field: z.string(),
        value: z.union([z.number(), z.string()]),
        evidence: EvidenceSchema,
      }),
    )
    .default([]),
  dryRun: z.boolean().default(true),
  resume: z.boolean().default(false),
  manifestDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
type RepairRequest = z.infer<typeof IdentityRepairRequestSchema>;
type Row = Record<string, string | number | null>;
type AppearanceTable = "player_match_stats" | "match_lineups";
interface Conflict {
  readonly table: AppearanceTable;
  readonly matchId: number;
  readonly field: string;
  readonly values: readonly (string | number)[];
}

/**
 * Merge appearances only after an operator verifies the people. Unknown values remain null.
 * @param table - Reviewed appearance table.
 * @param rows - Captured appearances for the identity group.
 * @param canonicalId - Retained internal identity.
 * @param resolutions - Evidence-backed conflict resolutions.
 * @returns Merged rows and unresolved conflicts.
 * @throws {OperationConflictError} If resolutions are invalid or duplicated.
 * @example
 * mergeIdentityAppearances("player_match_stats", rows, 712, []);
 */
export function mergeIdentityAppearances(
  table: AppearanceTable,
  rows: readonly Row[],
  canonicalId: number,
  resolutions: RepairRequest["resolutions"],
) {
  const groups = new Map<number, Row[]>();
  for (const row of rows) {
    const match = Number(row.match_id);
    groups.set(match, [...(groups.get(match) ?? []), row]);
  }
  const merged: Row[] = [];
  const conflicts: Conflict[] = [];
  const used = new Set<RepairRequest["resolutions"][number]>();
  for (const [matchId, group] of groups) {
    group.sort((a, b) => Number(a.id) - Number(b.id));
    const retained = group.find((row) => row.player_id === canonicalId) ?? group[0];
    if (!retained) continue;
    const row: Row = { ...retained, player_id: canonicalId };
    for (const field of Object.keys(retained)) {
      if (["id", "player_id", "match_id"].includes(field)) continue;
      const values = [
        ...new Set(group.flatMap((entry) => (entry[field] == null ? [] : [entry[field]]))),
      ];
      if (values.length <= 1) row[field] = values[0] ?? null;
      else {
        const resolution = resolutions.find(
          (entry) => entry.table === table && entry.matchId === matchId && entry.field === field,
        );
        if (resolution) {
          const expectedType =
            table === "match_lineups" && field === "position" ? "string" : "number";
          if (typeof resolution.value !== expectedType)
            throw new OperationConflictError(
              `Resolution for ${table}.${field} must be ${expectedType}`,
            );
          used.add(resolution);
          row[field] = resolution.value;
        } else conflicts.push({ table, matchId, field, values });
      }
    }
    merged.push(row);
  }
  if (resolutions.some((entry) => entry.table === table && !used.has(entry)))
    throw new OperationConflictError(
      "Resolution is duplicated or does not address a conflicting field",
    );
  return { rows: merged, conflicts };
}

async function hash(value: unknown): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Preview or apply one approved identity group, then atomically replace affected PAV seasons.
 * The preview digest includes source rows, references and evidence. Mutated previews fail closed.
 * Issued prediction archives are never written by this operation.
 * @param env - Worker bindings.
 * @param request - Validated identity scope, evidence and approval digest.
 * @returns Preview, completed repair report or lease contention result.
 * @throws {OperationConflictError} If scope, evidence, conflicts or approval prevent a repair.
 * @example
 * await repairPlayerIdentity(env, IdentityRepairRequestSchema.parse(request));
 */
export async function repairPlayerIdentity(env: Env, request: RepairRequest) {
  const ids = [...new Set(request.playerIds)].sort((a, b) => a - b);
  const scoped = request.kind === "reassign-appearances";
  if (request.canonicalId !== undefined && (!scoped || !ids.includes(request.canonicalId)))
    throw new OperationConflictError(
      "An explicit target must belong to an appearance reassignment group",
    );
  const canonicalId = request.canonicalId ?? ids[0];
  if (request.newPerson && (!scoped || request.canonicalId === undefined))
    throw new OperationConflictError(
      "A new person requires an explicit scoped reassignment target",
    );
  if (ids.length < 2 || canonicalId === undefined)
    throw new OperationConflictError("At least two distinct player IDs are required");
  if (
    scoped &&
    (ids.length !== 2 || !request.matchIds.length || !request.providerIdentities.length)
  )
    throw new OperationConflictError(
      "Appearance reassignment requires two separate people, exact matches and verified provider identities",
    );
  if (!scoped && request.matchIds.length)
    throw new OperationConflictError("Whole-person merges cannot specify a partial match scope");
  const scope = scoped
    ? JSON.stringify([...new Set(request.matchIds)].sort((a, b) => a - b))
    : null;
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  let prepared = false;
  try {
    if (request.manifestDigest && !request.dryRun) {
      const prior = await env.DB.prepare(
        "SELECT status, manifest_json FROM identity_repair_operations WHERE manifest_digest=?1",
      )
        .bind(request.manifestDigest)
        .first<{ status: string; manifest_json: string }>();
      if (prior?.status === "prepared") {
        if (!request.resume)
          throw new OperationConflictError("Prepared repair requires explicit resume");
        prepared = true;
      }
      if (prior && !prepared) {
        const recorded = JSON.parse(prior.manifest_json) as {
          ids: number[];
          canonicalId?: number;
          newPerson?: RepairRequest["newPerson"];
          kind?: string;
          matchIds?: number[];
        };
        if (
          JSON.stringify(recorded.ids) !== JSON.stringify(ids) ||
          (recorded.canonicalId ?? ids[0]) !== canonicalId ||
          JSON.stringify(recorded.newPerson) !== JSON.stringify(request.newPerson) ||
          (recorded.kind ?? "merge") !== request.kind ||
          JSON.stringify(recorded.matchIds ?? []) !==
            JSON.stringify(scoped ? JSON.parse(scope ?? "[]") : [])
        )
          throw new OperationConflictError("Digest belongs to another identity group");
        if (prior.status !== "complete") {
          if (!request.resume)
            throw new OperationConflictError(
              "Interrupted repair requires explicit resume with its approved digest",
            );
          await resumePublicInputWrite(env, holder, `identity:${request.manifestDigest}`);
          marked = true;
          const seasons =
            await env.DB.prepare(`SELECT s.id, s.season_key, c.code FROM pav_rebuild_queue q
            JOIN seasons s ON s.id=q.season_id JOIN competitions c ON c.id=s.competition_id
            WHERE q.reason=?1 ORDER BY s.id`)
              .bind(`identity:${request.manifestDigest}`)
              .all<Row>();
          await rebuildIdentityPav(env, seasons.results, holder);
          await protectOperationWrites(env, holder)
            .DB.prepare(
              "UPDATE identity_repair_operations SET status='complete' WHERE manifest_digest=?1",
            )
            .bind(request.manifestDigest)
            .run();
          consistent = true;
        }
        if (prior.status === "complete" && request.resume) {
          const marker = await env.DB.prepare(
            "SELECT in_progress, write_operation FROM public_input_revision WHERE id=1",
          ).first<{ in_progress: number; write_operation: string | null }>();
          if (
            marker?.in_progress &&
            marker.write_operation === `identity:${request.manifestDigest}`
          ) {
            await resumePublicInputWrite(env, holder, marker.write_operation);
            marked = true;
            consistent = true;
          }
        }
        return {
          busy: false,
          applied: true,
          idempotent: true,
          canonicalId,
          manifestDigest: request.manifestDigest,
        };
      }
    }
    const selectors = ids.map(() => "?").join(",");
    const identityJson = JSON.stringify(ids);
    const snapshots = await env.DB.batch<Row>([
      env.DB.prepare(
        "SELECT * FROM players WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id",
      ).bind(identityJson),
      env.DB.prepare(
        "SELECT * FROM player_provider_ids WHERE player_id IN (SELECT value FROM json_each(?1)) ORDER BY provider,provider_id",
      ).bind(identityJson),
      ...(["player_match_stats", "match_lineups"] as const).map((table) =>
        env.DB.prepare(`SELECT * FROM ${table} WHERE player_id IN (SELECT value FROM json_each(?1))
          AND (?2 IS NULL OR match_id IN (SELECT value FROM json_each(?2))) ORDER BY match_id,player_id,id`).bind(
          identityJson,
          scope,
        ),
      ),
      env.DB.prepare(`SELECT * FROM player_season_pav WHERE player_id IN (SELECT value FROM json_each(?1))
        AND (?2 IS NULL OR season_id IN (SELECT season_id FROM matches WHERE id IN (SELECT value FROM json_each(?2))))
        ORDER BY season_id,player_id,team_id`).bind(identityJson, scope),
      env.DB.prepare(`SELECT DISTINCT s.id,s.season_key,c.code FROM seasons s JOIN competitions c ON c.id=s.competition_id
        WHERE (s.id IN (SELECT m.season_id FROM matches m JOIN player_match_stats p ON p.match_id=m.id
          WHERE p.player_id IN (SELECT value FROM json_each(?1)))
          OR s.id IN (SELECT season_id FROM player_season_pav WHERE player_id IN (SELECT value FROM json_each(?1))))
        AND (?2 IS NULL OR s.id IN (SELECT season_id FROM matches WHERE id IN (SELECT value FROM json_each(?2))))
        ORDER BY s.id`).bind(identityJson, scope),
    ]);
    const redirected = await env.DB.prepare(
      `SELECT retired_id FROM player_id_redirects WHERE retired_id IN (${selectors})`,
    )
      .bind(...ids)
      .all();
    if (redirected.results.length)
      throw new OperationConflictError(
        "Group includes a retired ID; use its approved repair digest or canonical ID",
      );
    const players = snapshots[0]?.results ?? [];
    if (request.newPerson && players.some((player) => player.id === canonicalId))
      throw new OperationConflictError("The reviewed new person target already exists");
    if (players.length !== ids.length - (request.newPerson ? 1 : 0))
      throw new OperationConflictError("An identity group member no longer exists");
    const datesOfBirth = [
      ...new Set(
        players.flatMap((player) => (player.date_of_birth == null ? [] : [player.date_of_birth])),
      ),
    ];
    const providerLinks = request.providerIdentities.length
      ? await env.DB.batch<Row>(
          request.providerIdentities.map((identity) =>
            env.DB.prepare(
              "SELECT provider,provider_id,player_id FROM player_provider_ids WHERE provider=?1 AND provider_id=?2",
            ).bind(identity.provider, identity.providerId),
          ),
        )
      : [];
    if (
      providerLinks.some((result) =>
        result.results.some((row) => !ids.includes(Number(row.player_id))),
      )
    )
      throw new OperationConflictError(
        "Verified provider identity already belongs to a different player group",
      );
    if (scoped) {
      const official = request.providerIdentities.filter((item) => item.provider === "afl-api");
      const existing = players.find((player) => player.id === canonicalId)?.external_afl_player_id;
      if (
        official.length > 1 ||
        (existing != null && official.some((item) => item.providerId !== existing))
      )
        throw new OperationConflictError(
          "Appearance reassignment cannot overwrite a different canonical provider identity",
        );
      if (!(snapshots[2]?.results.length || snapshots[3]?.results.length))
        throw new OperationConflictError("No appearances in the reviewed reassignment scope");
    }
    const stats = mergeIdentityAppearances(
      "player_match_stats",
      (snapshots[2]?.results as Row[]) ?? [],
      canonicalId,
      request.resolutions,
    );
    const lineups = mergeIdentityAppearances(
      "match_lineups",
      (snapshots[3]?.results as Row[]) ?? [],
      canonicalId,
      request.resolutions,
    );
    const manifest = {
      ids,
      kind: request.kind,
      matchIds: scoped ? JSON.parse(scope ?? "[]") : [],
      canonicalId,
      ...(request.newPerson ? { newPerson: request.newPerson } : {}),
      evidence: request.evidence,
      providerIdentities: request.providerIdentities,
      dateOfBirth: !scoped && datesOfBirth.length === 1 ? datesOfBirth[0] : null,
      resolutions: request.resolutions,
      snapshots: snapshots.map((result) => result.results),
      stats: stats.rows,
      lineups: lineups.rows,
    };
    const digest = await hash(manifest);
    const conflicts = [...stats.conflicts, ...lineups.conflicts];
    if (request.dryRun)
      return {
        busy: false,
        dryRun: true,
        canonicalId,
        manifestDigest: digest,
        conflicts,
        biographyConflicts:
          !scoped && datesOfBirth.length > 1
            ? [{ field: "date_of_birth", values: datesOfBirth }]
            : [],
        manifest,
      };
    if (conflicts.length)
      throw new OperationConflictError(
        "Unresolved non-null appearance conflicts block this identity group",
      );
    if (!scoped && datesOfBirth.length > 1)
      throw new OperationConflictError("Conflicting dates of birth block this identity group");
    if (digest !== request.manifestDigest)
      throw new OperationConflictError("Identity repair preview is stale or not approved");
    const prepareOperation = env.DB.prepare(
      "INSERT INTO identity_repair_operations(manifest_digest, canonical_id, manifest_json, status, applied_at) VALUES(?1,?2,?3,'prepared',?4)",
    ).bind(digest, canonicalId, JSON.stringify(manifest), new Date().toISOString());
    if (!prepared && !request.newPerson) await prepareOperation.run();
    const marker = await env.DB.prepare(
      "SELECT in_progress FROM public_input_revision WHERE id=1",
    ).first<number>("in_progress");
    if ((prepared || request.resume) && marker === 1)
      await resumePublicInputWrite(env, holder, `identity:${digest}`);
    else await beginPublicInputWrite(env, holder, new Date(), `identity:${digest}`);
    marked = true;
    const statements: D1PreparedStatement[] = [publicInputWriteFence(env, holder)];
    if (request.newPerson)
      statements.push(
        env.DB.prepare(
          "INSERT INTO players(id,first_name,surname,date_of_birth) VALUES(?1,?2,?3,?4)",
        ).bind(
          canonicalId,
          request.newPerson.firstName,
          request.newPerson.surname,
          request.newPerson.dateOfBirth,
        ),
      );
    if (request.newPerson) statements.push(prepareOperation);
    for (const [table, merged] of [
      ["player_match_stats", stats],
      ["match_lineups", lineups],
    ] as const) {
      const retained = JSON.stringify(merged.rows.map((row) => row.id));
      statements.push(
        env.DB.prepare(
          `DELETE FROM ${table} WHERE player_id IN (${selectors}) AND id NOT IN (SELECT value FROM json_each(?))
           AND (? IS NULL OR match_id IN (SELECT value FROM json_each(?)))`,
        ).bind(...ids, retained, scope, scope),
      );
      // Column names come from SELECT * on these two fixed tables, never from supplied resolutions.
      const first = merged.rows[0];
      if (first) {
        const columns = Object.keys(first).filter((column) => column !== "id");
        statements.push(
          env.DB.prepare(
            `UPDATE ${table} SET (${columns.join(",")}) = (
            SELECT ${columns.map((column) => `json_extract(j.value, '$.${column}')`).join(",")}
            FROM json_each(?1) j WHERE json_extract(j.value, '$.id')=${table}.id
          ) WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))`,
          ).bind(JSON.stringify(merged.rows)),
        );
      }
    }
    if (!scoped)
      statements.push(
        env.DB.prepare(
          `UPDATE player_provider_ids SET player_id=? WHERE player_id IN (${selectors})`,
        ).bind(canonicalId, ...ids),
      );
    for (const identity of request.providerIdentities) {
      statements.push(
        env.DB.prepare(`INSERT INTO player_provider_ids(provider,provider_id,player_id,evidence_json)
        VALUES(?1,?2,?3,?4) ON CONFLICT(provider,provider_id) DO UPDATE SET
        player_id=excluded.player_id,evidence_json=excluded.evidence_json`).bind(
          identity.provider,
          identity.providerId,
          canonicalId,
          JSON.stringify(identity.evidence),
        ),
      );
    }
    if (scoped) {
      for (const identity of request.providerIdentities.filter(
        (item) => item.provider === "afl-api",
      )) {
        statements.push(
          env.DB.prepare(`UPDATE players SET external_afl_player_id=NULL
          WHERE id IN (${selectors}) AND external_afl_player_id=?`).bind(
            ...ids,
            identity.providerId,
          ),
        );
        statements.push(
          env.DB.prepare("UPDATE players SET external_afl_player_id=?1 WHERE id=?2").bind(
            identity.providerId,
            canonicalId,
          ),
        );
      }
    }
    if (!scoped && datesOfBirth.length === 1)
      statements.push(
        env.DB.prepare(
          "UPDATE players SET date_of_birth=COALESCE(date_of_birth,?1) WHERE id=?2",
        ).bind(datesOfBirth[0], canonicalId),
      );
    if (!scoped)
      statements.push(
        env.DB.prepare(
          `UPDATE player_id_redirects SET canonical_id=? WHERE canonical_id IN (${selectors})`,
        ).bind(canonicalId, ...ids),
      );
    for (const retired of scoped ? [] : ids.slice(1)) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO player_id_redirects(retired_id, canonical_id, manifest_digest) VALUES(?1,?2,?3)",
        ).bind(retired, canonicalId, digest),
      );
    }
    for (const season of snapshots[5]?.results ?? []) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO pav_rebuild_queue(season_id, reason) VALUES(?1,?2) ON CONFLICT(season_id) DO UPDATE SET reason=excluded.reason",
        ).bind(season.id, `identity:${digest}`),
      );
    }
    statements.push(
      env.DB.prepare(
        "UPDATE identity_repair_operations SET status='reparented' WHERE manifest_digest=?1",
      ).bind(digest),
    );
    await env.DB.batch(statements);
    await rebuildIdentityPav(env, snapshots[5]?.results ?? [], holder);
    await protectOperationWrites(env, holder)
      .DB.prepare(
        "UPDATE identity_repair_operations SET status='complete' WHERE manifest_digest=?1",
      )
      .bind(digest)
      .run();
    consistent = true;
    return { busy: false, applied: true, idempotent: false, canonicalId, manifestDigest: digest };
  } finally {
    try {
      if (marked && consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
}

async function rebuildIdentityPav(
  env: Env,
  seasons: readonly Row[],
  holder: string,
): Promise<void> {
  const writer = protectOperationWrites(env, holder);
  for (const season of seasons) {
    if (
      (season.code === "AFLM" || season.code === "AFLW") &&
      Number(String(season.season_key).slice(0, 4)) >= MIN_PAV_YEAR_BY_COMPETITION[season.code]
    )
      await calculatePav(writer, String(season.season_key), season.code, holder);
    else
      await writer.DB.prepare("DELETE FROM player_season_pav WHERE season_id=?1")
        .bind(season.id)
        .run();
    await writer.DB.prepare("DELETE FROM pav_rebuild_queue WHERE season_id=?1")
      .bind(season.id)
      .run();
  }
}
