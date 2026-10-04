import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import type { Env } from "../types";
import { OperationConflictError } from "./errors";

const BEARS_LAST_SEASON = 1996;

export interface BearsRepairReport {
  readonly dryRun: boolean;
  readonly competition: "AFLM";
  readonly affectedMatches: number;
  readonly matchSides: number;
  readonly playerStats: number;
  readonly lineups: number;
  readonly pavRows: number;
  readonly canonicalCoaches: number;
  readonly observations: number;
}

/**
 * Preview or apply the bounded AFLM historical Bears identity repair.
 *
 * @param env - Worker bindings.
 * @param dryRun - Whether to return counts without changing team references.
 * @param options - Approval digest and explicit recovery flag for this repair.
 * @returns Whether the operation lease was busy and the reference count report.
 * @throws If required AFLM team identities or a D1 operation is unavailable.
 * @example
 * await reconcileBearsIdentity(env, true);
 */
export async function reconcileBearsIdentity(
  env: Env,
  dryRun: boolean,
  options: {
    readonly manifestDigest?: string | undefined;
    readonly resume?: boolean | undefined;
  } = {},
): Promise<{
  readonly busy: boolean;
  readonly report?: BearsRepairReport;
  readonly manifestDigest?: string;
  readonly matchIds?: readonly number[];
}> {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  try {
    const previewIds = await findClubIds(env, true);
    const report = await countAffected(env, previewIds.lionsId);
    const matches =
      await env.DB.prepare(`SELECT m.id FROM matches m JOIN seasons s ON s.id=m.season_id
      JOIN competitions c ON c.id=s.competition_id WHERE c.code='AFLM' AND s.year<=?1
      AND ?2 IN (m.home_team_id,m.away_team_id) ORDER BY m.id`)
        .bind(BEARS_LAST_SEASON, previewIds.lionsId)
        .all<{ id: number }>();
    const matchIds = matches.results.map((row) => row.id);
    const revision = await env.DB.prepare(
      "SELECT revision,in_progress FROM public_input_revision WHERE id=1",
    ).first<{ revision: number; in_progress: number }>();
    if (!revision) throw new Error("Public input revision is unavailable");
    const digest = Array.from(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify({ ids: previewIds, report, matchIds, revision: revision.revision }),
          ),
        ),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (dryRun) {
      if (revision.in_progress)
        throw new OperationConflictError("Recover the active public write before previewing Bears");
      return { busy: false, report, manifestDigest: digest, matchIds };
    }
    if (options.resume) {
      if (!options.manifestDigest)
        throw new OperationConflictError("Bears recovery requires the approved digest");
      await resumePublicInputWrite(env, holder, `bears:${options.manifestDigest}`);
    } else {
      if (options.manifestDigest !== digest)
        throw new OperationConflictError("Bears preview missing or stale");
      await beginPublicInputWrite(env, holder, new Date(), `bears:${digest}`);
    }
    marked = true;
    const writer = protectOperationWrites(env, holder);
    const ids = await findClubIds(writer, false);
    if (!dryRun && report.matchSides > 0) {
      const stmts: D1PreparedStatement[] = [];
      stmts.push(
        writer.DB.prepare(
          `UPDATE player_match_stats SET team_id = ?1
           WHERE team_id = ?2 AND match_id IN (
             SELECT m.id FROM matches m JOIN seasons s ON s.id = m.season_id
             JOIN competitions c ON c.id = s.competition_id
             WHERE c.code = 'AFLM' AND s.year <= ?3 AND ?2 IN (m.home_team_id, m.away_team_id)
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
        writer.DB.prepare(
          `UPDATE match_lineups SET team_id = ?1
           WHERE team_id = ?2 AND match_id IN (
             SELECT m.id FROM matches m JOIN seasons s ON s.id = m.season_id
             JOIN competitions c ON c.id = s.competition_id
             WHERE c.code = 'AFLM' AND s.year <= ?3 AND ?2 IN (m.home_team_id, m.away_team_id)
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
        writer.DB.prepare(
          `UPDATE player_season_pav SET team_id = ?1
           WHERE team_id = ?2 AND season_id IN (
             SELECT s.id FROM seasons s JOIN competitions c ON c.id = s.competition_id
             WHERE c.code = 'AFLM' AND s.year <= ?3
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
        writer.DB.prepare(
          `UPDATE coach_observations SET team_id = ?1
           WHERE team_id = ?2 AND season <= ?3 AND match_id IN (
             SELECT m.id FROM matches m JOIN seasons s ON s.id = m.season_id
             WHERE s.year <= ?3 AND ?2 IN (m.home_team_id, m.away_team_id)
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
        writer.DB.prepare(
          `UPDATE match_coaches SET team_id = ?1
           WHERE team_id = ?2 AND match_id IN (
             SELECT m.id FROM matches m JOIN seasons s ON s.id = m.season_id
             JOIN competitions c ON c.id = s.competition_id
             WHERE c.code = 'AFLM' AND s.year <= ?3 AND ?2 IN (m.home_team_id, m.away_team_id)
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
        writer.DB.prepare(
          `UPDATE matches SET home_team_id = ?1
           WHERE home_team_id = ?2 AND season_id IN (
             SELECT s.id FROM seasons s JOIN competitions c ON c.id = s.competition_id
             WHERE c.code = 'AFLM' AND s.year <= ?3
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
        writer.DB.prepare(
          `UPDATE matches SET away_team_id = ?1
           WHERE away_team_id = ?2 AND season_id IN (
             SELECT s.id FROM seasons s JOIN competitions c ON c.id = s.competition_id
             WHERE c.code = 'AFLM' AND s.year <= ?3
           )`,
        ).bind(ids.bearsId, ids.lionsId, BEARS_LAST_SEASON),
      );
      await writer.DB.batch(stmts);
    }
    consistent = true;
    return { busy: false, report: { ...report, dryRun } };
  } finally {
    try {
      if (marked && consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
}

async function findClubIds(
  env: Env,
  dryRun: boolean,
): Promise<{ bearsId: number; lionsId: number }> {
  const competition = await env.DB.prepare(
    "SELECT id FROM competitions WHERE code = 'AFLM'",
  ).first<{ id: number }>();
  if (!competition) throw new OperationConflictError("AFLM competition does not exist");
  let bears = await env.DB.prepare(
    "SELECT id FROM teams WHERE competition_id = ?1 AND name = 'Brisbane Bears'",
  )
    .bind(competition.id)
    .first<{ id: number }>();
  if (!bears) {
    if (!dryRun) {
      await env.DB.prepare(
        "INSERT INTO teams (name, abbreviation, competition_id) VALUES ('Brisbane Bears', 'BB', ?1)",
      )
        .bind(competition.id)
        .run();
      bears = await env.DB.prepare(
        "SELECT id FROM teams WHERE competition_id = ?1 AND name = 'Brisbane Bears'",
      )
        .bind(competition.id)
        .first<{ id: number }>();
    }
  }
  const lions = await env.DB.prepare(
    "SELECT id FROM teams WHERE competition_id = ?1 AND name = 'Brisbane Lions'",
  )
    .bind(competition.id)
    .first<{ id: number }>();
  if (!lions || (!bears && !dryRun))
    throw new OperationConflictError("Brisbane team identity is missing");
  return { bearsId: bears?.id ?? -1, lionsId: lions.id };
}

async function countAffected(env: Env, lionsId: number): Promise<BearsRepairReport> {
  const [matches, sides, stats, lineups, pav, coaches, observations] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM matches m JOIN seasons s ON s.id = m.season_id
       JOIN competitions c ON c.id = s.competition_id WHERE c.code = 'AFLM' AND s.year <= ?1
       AND ?2 IN (m.home_team_id, m.away_team_id)`,
    )
      .bind(BEARS_LAST_SEASON, lionsId)
      .first<{ n: number }>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM matches m JOIN seasons s ON s.id = m.season_id
       JOIN competitions c ON c.id = s.competition_id WHERE c.code = 'AFLM' AND s.year <= ?1
       AND (m.home_team_id = ?2 OR m.away_team_id = ?2)`,
    )
      .bind(BEARS_LAST_SEASON, lionsId)
      .first<{ n: number }>(),
    countReferences(env, "player_match_stats", lionsId, "match_id"),
    countReferences(env, "match_lineups", lionsId, "match_id"),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM player_season_pav p JOIN seasons s ON s.id = p.season_id
       JOIN competitions c ON c.id = s.competition_id WHERE c.code = 'AFLM' AND s.year <= ?1 AND p.team_id = ?2`,
    )
      .bind(BEARS_LAST_SEASON, lionsId)
      .first<{ n: number }>(),
    countReferences(env, "match_coaches", lionsId, "match_id"),
    env.DB.prepare(
      `SELECT COUNT(*) AS n FROM coach_observations o JOIN matches m ON m.id = o.match_id
       JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
       WHERE c.code = 'AFLM' AND s.year <= ?1 AND o.team_id = ?2`,
    )
      .bind(BEARS_LAST_SEASON, lionsId)
      .first<{ n: number }>(),
  ]);
  return {
    dryRun: true,
    competition: "AFLM",
    affectedMatches: matches?.n ?? 0,
    matchSides: sides?.n ?? 0,
    playerStats: stats,
    lineups,
    pavRows: pav?.n ?? 0,
    canonicalCoaches: coaches,
    observations: observations?.n ?? 0,
  };
}

async function countReferences(
  env: Env,
  table: "player_match_stats" | "match_lineups" | "match_coaches",
  teamId: number,
  matchColumn: "match_id",
): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} r JOIN matches m ON m.id = r.${matchColumn}
     JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
     WHERE c.code = 'AFLM' AND s.year <= ?1 AND r.team_id = ?2`,
  )
    .bind(BEARS_LAST_SEASON, teamId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
