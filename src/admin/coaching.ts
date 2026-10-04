import type { MatchCoachAssignment, MatchCoachFailure } from "fitzroy";
import { fetchMatchCoaches } from "fitzroy";
import { z } from "zod";
import {
  beginPublicInputWrite,
  finishPublicInputWrite,
  protectOperationWrites,
  resumePublicInputWrite,
} from "../db/public-inputs";
import { normaliseTeamForMatch } from "../lib/normalise";
import { acquireOperationLease, releaseOperationLease } from "../sync/lease";
import { logSync } from "../sync/log";
import type { Env } from "../types";

type CoachProvider = "afl-tables" | "footywire";

interface MatchCandidate {
  readonly id: number;
  readonly season_id: number;
  readonly external_afltables_id: string | null;
  readonly competition_id: number;
  readonly date: string;
  readonly home_team_id: number;
  readonly away_team_id: number;
  readonly home_name: string;
  readonly away_name: string;
  readonly home_competition_id: number;
  readonly away_competition_id: number;
  readonly home_points: number | null;
  readonly away_points: number | null;
}

export interface CoachingImportSummary {
  readonly season: number;
  readonly source: CoachProvider;
  readonly dryRun: boolean;
  readonly complete: boolean;
  readonly assignments: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly conflicts: number;
  readonly failures: number;
  readonly changed: number;
  readonly pending?: boolean;
}

/**
 * Import one source/season result without turning partial data into deletions.
 *
 * @param env - Worker bindings.
 * @param season - AFLM season being imported.
 * @param source - Provider for the source observations.
 * @param result - Assignments and source completeness envelope.
 * @param dryRun - Resolve and count inputs without writing facts or diagnostics.
 * @param retrievedAt - Shared UTC timestamp for this import pass.
 * @returns A bounded summary of resolution and writes.
 * @throws If a D1 write fails.
 * @example
 * await ingestMatchCoachResult(env, 2024, "afl-tables", result, true);
 */
export async function ingestMatchCoachResult(
  env: Env,
  season: number,
  source: CoachProvider,
  result: {
    readonly batch?: {
      readonly scope: "pages";
      readonly nextCursor: string | null;
      readonly completedCoachIds: readonly string[];
    };
    readonly assignments: readonly MatchCoachAssignment[];
    readonly completeness: {
      readonly complete: boolean;
      readonly failures: readonly MatchCoachFailure[];
    };
  },
  dryRun = false,
  retrievedAt = new Date().toISOString(),
): Promise<CoachingImportSummary> {
  const failuresByCoach = new Set(
    result.completeness.failures
      .filter((failure) => failure.scope.startsWith("coach:"))
      .map((failure) => failure.scope.slice("coach:".length).toLocaleLowerCase()),
  );
  const failedCoachIds = new Set(
    result.completeness.failures.flatMap((failure) => (failure.coachId ? [failure.coachId] : [])),
  );
  const [matches, crosswalks, identities, currentAssignments] = await env.DB.batch<
    Record<string, unknown>
  >([
    env.DB.prepare(`${MATCH_PROJECTION} WHERE c.code='AFLM' AND s.year=?1`).bind(season),
    env.DB.prepare(`SELECT x.external_match_id,x.match_id FROM coach_external_match_ids x
      JOIN matches m ON m.id=x.match_id JOIN seasons s ON s.id=m.season_id
      WHERE x.provider=?1 AND s.year=?2 AND s.competition_id=(SELECT id FROM competitions WHERE code='AFLM')`).bind(
      source,
      season,
    ),
    env.DB.prepare(
      "SELECT external_coach_id,coach_id,verified FROM coach_external_ids WHERE provider=?1",
    ).bind(source),
    env.DB.prepare(`SELECT mc.match_id,mc.team_id,mc.coach_id FROM match_coaches mc
      JOIN matches m ON m.id=mc.match_id JOIN seasons s ON s.id=m.season_id
      WHERE s.year=?1 AND s.competition_id=(SELECT id FROM competitions WHERE code='AFLM')`).bind(
      season,
    ),
  ]);
  if (!matches || !crosswalks || !identities || !currentAssignments)
    throw new Error("Coaching reconciliation inputs are unavailable");
  const seasonMatches = matches.results as unknown as MatchCandidate[];
  const matchCrosswalk = new Map(
    crosswalks.results.map((row) => [String(row.external_match_id), Number(row.match_id)]),
  );
  const coachIdentities = new Map(
    identities.results.map((row) => [
      String(row.external_coach_id),
      { coach_id: String(row.coach_id), verified: Number(row.verified) },
    ]),
  );
  const existingAssignments = new Map(
    currentAssignments.results.map((row) => [
      `${row.match_id}:${row.team_id}`,
      String(row.coach_id),
    ]),
  );
  const coaches = new Map<string, string>();
  const writes: D1PreparedStatement[] = [];
  let resolved = 0;
  let unresolved = 0;
  let conflicts = 0;
  let changed = 0;
  const resolvedKeys = new Set<string>();

  const planned: Array<{
    assignment: MatchCoachAssignment;
    match: MatchCandidate;
    teamId: number;
  }> = [];
  const duplicateKeys = new Set<string>();
  // Reconcile the entire response before any mapping or canonical write.
  for (const assignment of result.assignments) {
    if (
      assignment.competition !== "AFLM" ||
      assignment.season !== season ||
      assignment.source !== source
    ) {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "invalid-scope",
          assignment.matchUrl,
          retrievedAt,
        );
      continue;
    }
    const candidate = resolveMatch(seasonMatches, matchCrosswalk, assignment);
    if (candidate.status === "ambiguous") {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "ambiguous-match",
          assignment.matchUrl,
          retrievedAt,
        );
      continue;
    }
    if (!candidate.match) {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "unresolved-match",
          assignment.matchUrl,
          retrievedAt,
        );
      continue;
    }
    const match = candidate.match;
    if (!matchesEvidence(match, assignment, false)) {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "score-mismatch",
          assignment.matchUrl,
          retrievedAt,
        );
      continue;
    }
    const teamName = normaliseTeamForMatch(assignment.team, "AFLM", season);
    const teamId =
      teamName === match.home_name
        ? match.home_team_id
        : teamName === match.away_name
          ? match.away_team_id
          : null;
    const validTeam = teamId === null ? null : { id: teamId };
    if (!validTeam || match.home_competition_id !== match.away_competition_id) {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "invalid-participant",
          assignment.matchUrl,
          retrievedAt,
        );
      continue;
    }

    const key = `${match.id}:${validTeam.id}`;
    if (resolvedKeys.has(key)) duplicateKeys.add(key);
    resolvedKeys.add(key);
    const identity = coachIdentities.get(assignment.coachId);
    if (identity && identity.coach_id !== assignment.coachId && identity.verified !== 1) {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "unverified-identity",
          assignment.coachUrl,
          retrievedAt,
        );
      continue;
    }
    planned.push({ assignment, match, teamId: validTeam.id });
  }

  for (const { assignment, match, teamId } of planned) {
    const key = `${match.id}:${teamId}`;
    if (duplicateKeys.has(key)) {
      unresolved++;
      if (!dryRun)
        await writeDiagnostic(
          env,
          season,
          source,
          "duplicate-assignment",
          assignment.matchUrl,
          retrievedAt,
        );
      continue;
    }
    resolved++;
    const existingAssignment = existingAssignments.get(key);
    const verifiedIdentity = coachIdentities.get(assignment.coachId);
    const canonicalId =
      verifiedIdentity?.verified === 1 ? verifiedIdentity.coach_id : assignment.coachId;
    if (source === "footywire" && existingAssignment && existingAssignment !== canonicalId)
      conflicts++;
    if (dryRun) continue;
    let coachId = coaches.get(assignment.coachId);
    if (!coachId) {
      coachId = await ensureCoach(env, assignment, source, retrievedAt);
      coaches.set(assignment.coachId, coachId);
    }
    writes.push(buildObservation(env, assignment, source, coachId, match.id, teamId, retrievedAt));
    if (
      source === "afl-tables" &&
      !failedCoachIds.has(assignment.coachId) &&
      !failuresByCoach.has(assignment.coachName.toLocaleLowerCase())
    ) {
      writes.push(
        env.DB.prepare(
          `INSERT INTO match_coaches (match_id, team_id, coach_id, observation_id, updated_at)
         SELECT ?1, ?2, ?3, id, ?4 FROM coach_observations
         WHERE provider=?5 AND external_coach_id=?6 AND external_match_id=?7 AND raw_team=?8
         ON CONFLICT (match_id, team_id) DO UPDATE SET
           coach_id = excluded.coach_id,
           observation_id = excluded.observation_id,
           updated_at = excluded.updated_at
         WHERE match_coaches.coach_id IS NOT excluded.coach_id
            OR match_coaches.observation_id IS NOT excluded.observation_id
         RETURNING match_id`,
        ).bind(
          match.id,
          teamId,
          coachId,
          retrievedAt,
          source,
          assignment.coachId,
          assignment.matchId,
          assignment.team,
        ),
      );
    }
    writes.push(
      env.DB.prepare(
        `INSERT INTO coach_external_match_ids (provider, external_match_id, match_id)
       VALUES (?1, ?2, ?3) ON CONFLICT (provider, external_match_id) DO NOTHING`,
      ).bind(source, assignment.matchId, match.id),
    );
  }

  for (let offset = 0; offset < writes.length; offset += 100) {
    const results = await env.DB.batch(writes.slice(offset, offset + 100));
    changed += results.reduce((sum, result) => sum + result.results.length, 0);
  }

  if (
    !dryRun &&
    source === "afl-tables" &&
    !result.batch &&
    result.completeness.complete &&
    result.completeness.failures.length === 0 &&
    unresolved === 0
  ) {
    const existing = await env.DB.prepare(
      `SELECT mc.match_id, mc.team_id
       FROM match_coaches mc
       JOIN matches m ON m.id = mc.match_id
       JOIN seasons s ON s.id = m.season_id
       JOIN coach_observations o ON o.id = mc.observation_id
       WHERE s.year = ?1 AND s.competition_id = (SELECT id FROM competitions WHERE code = 'AFLM') AND o.provider = 'afl-tables'`,
    )
      .bind(season)
      .all<{ match_id: number; team_id: number }>();
    const removals = existing.results
      .filter((row) => !resolvedKeys.has(`${row.match_id}:${row.team_id}`))
      .map((row) =>
        env.DB.prepare(
          "DELETE FROM match_coaches WHERE match_id = ?1 AND team_id = ?2 RETURNING match_id",
        ).bind(row.match_id, row.team_id),
      );
    for (let offset = 0; offset < removals.length; offset += 100) {
      const batch = await env.DB.batch(removals.slice(offset, offset + 100));
      changed += batch.reduce((total, item) => total + item.results.length, 0);
    }
  }

  if (!dryRun) {
    for (const failure of result.completeness.failures) {
      await writeDiagnostic(
        env,
        season,
        source,
        failure.reason.slice(0, 180),
        failure.url,
        retrievedAt,
        failure.scope,
      );
    }
    await env.DB.prepare(
      `INSERT INTO coach_import_pages (provider, season, scope, status, last_checked_at, last_success_at, failure_count)
       VALUES (?1, ?2, 'season', ?3, ?4, ?5, ?6)
       ON CONFLICT (provider, season, scope) DO UPDATE SET
         status = excluded.status, last_checked_at = excluded.last_checked_at,
         last_success_at = COALESCE(excluded.last_success_at, coach_import_pages.last_success_at),
         failure_count = CASE WHEN excluded.status = 'success' THEN 0 ELSE coach_import_pages.failure_count + 1 END`,
    )
      .bind(
        source,
        season,
        !result.batch &&
          result.completeness.complete &&
          result.completeness.failures.length === 0 &&
          unresolved === 0
          ? "success"
          : "partial",
        retrievedAt,
        !result.batch &&
          result.completeness.complete &&
          result.completeness.failures.length === 0 &&
          unresolved === 0
          ? retrievedAt
          : null,
        result.completeness.failures.length + unresolved,
      )
      .run();
    if (
      !result.batch &&
      result.completeness.complete &&
      result.completeness.failures.length === 0 &&
      unresolved === 0
    ) {
      await env.DB.prepare(
        "UPDATE coach_import_diagnostics SET resolved_at = ?1 WHERE provider = ?2 AND season = ?3 AND resolved_at IS NULL",
      )
        .bind(retrievedAt, source, season)
        .run();
    }
  }
  return {
    season,
    source,
    dryRun,
    complete:
      !result.batch &&
      result.completeness.complete &&
      result.completeness.failures.length === 0 &&
      unresolved === 0,
    assignments: result.assignments.length,
    resolved,
    unresolved,
    conflicts,
    failures: result.completeness.failures.length,
    changed,
  };
}

/**
 * Run the authenticated one-season coaching operation under the shared lease.
 *
 * @param env - Worker bindings.
 * @param season - AFLM season to fetch.
 * @param source - Primary AFL Tables or comparison FootyWire source.
 * @param dryRun - Whether to avoid persistent import writes.
 * @returns Whether the lease was busy and, when acquired, the import summary.
 * @throws If the source or D1 operation fails.
 * @example
 * await backfillCoaches(env, 2024, "afl-tables", true);
 */
export async function backfillCoaches(
  env: Env,
  season: number,
  source: CoachProvider,
  dryRun: boolean,
  resume = false,
): Promise<{ readonly busy: boolean; readonly summary?: CoachingImportSummary }> {
  const holder = crypto.randomUUID();
  if (!(await acquireOperationLease(env, holder))) return { busy: true };
  let marked = false;
  let consistent = false;
  try {
    if (!dryRun) {
      const operation = `coaching:${source}:${season}`;
      if (resume) await resumePublicInputWrite(env, holder, operation);
      else await beginPublicInputWrite(env, holder, new Date(), operation);
      marked = true;
    }
    const writer = dryRun ? env : protectOperationWrites(env, holder);
    const summary = await runCoachBatch(writer, season, source, dryRun);
    consistent = true;
    return { busy: false, summary };
  } finally {
    try {
      if (marked && consistent) await finishPublicInputWrite(env, holder);
    } finally {
      await releaseOperationLease(env, holder);
    }
  }
}

/**
 * Refresh the active AFLM season on a bounded schedule.
 *
 * Successful checks recur every 24 hours. Partial or failed checks retry after
 * three hours. All work runs inside the caller's existing sync lease.
 *
 * @param env - Worker bindings.
 * @param now - Shared clock instant used for season and cadence decisions.
 * @returns A promise that resolves after the best-effort refresh.
 * @example
 * await refreshActiveCoaches(env, new Date());
 */
export async function refreshActiveCoaches(env: Env, now = new Date()): Promise<void> {
  const season = now.getUTCFullYear();
  const last = await env.DB.prepare(
    "SELECT status, last_checked_at FROM coach_import_pages WHERE provider = 'afl-tables' AND season = ?1 AND scope = 'season'",
  )
    .bind(season)
    .first<{ status: string; last_checked_at: string }>();
  const retryInterval = last?.status === "success" ? 24 : 3;
  const pending = await env.DB.prepare(
    "SELECT cursor FROM coach_backfill_progress WHERE provider = 'afl-tables' AND season = ?1",
  )
    .bind(season)
    .first<{ cursor: string | null }>();
  if (
    !pending?.cursor &&
    last &&
    Date.parse(last.last_checked_at) > now.getTime() - retryInterval * 60 * 60 * 1000
  )
    return;
  try {
    const summary = await runCoachBatch(env, season, "afl-tables", false, now.toISOString());
    if (summary.changed > 0 || summary.failures > 0 || summary.unresolved > 0) {
      await logSync(
        env,
        "sync:AFLM:coaches",
        summary.changed,
        summary.complete ? undefined : "partial coaching coverage",
      );
    }
  } catch (error) {
    // Source failures are recorded before mutation. Database failures may leave
    // a partial import and must retain the public write marker for recovery.
    if (!(error instanceof CoachingSourceError)) throw error;
  }
}

class CoachingSourceError extends Error {}

async function runCoachBatch(
  env: Env,
  season: number,
  source: CoachProvider,
  dryRun: boolean,
  now = new Date().toISOString(),
): Promise<CoachingImportSummary> {
  const progress = await env.DB.prepare(
    "SELECT cursor, assignments_json FROM coach_backfill_progress WHERE provider = ?1 AND season = ?2",
  )
    .bind(source, season)
    .first<{ cursor: string | null; assignments_json: string }>();
  const fetched = await fetchMatchCoaches({
    season,
    competition: "AFLM",
    source,
    batch: { limit: 5, ...(progress?.cursor && { cursor: progress.cursor }) },
  });
  if (!fetched.success) {
    if (!dryRun) await recordSourceFailure(env, season, source, now);
    throw new CoachingSourceError("coaching source fetch failed");
  }
  const previous = progress?.cursor
    ? CoachAssignmentsSchema.parse(JSON.parse(progress.assignments_json))
    : [];
  const completed = new Set([
    ...(fetched.data.batch?.completedCoachIds ?? []),
    ...fetched.data.assignments.map((row) => row.coachId),
  ]);
  const assignments = [
    ...previous.filter((row) => !completed.has(row.coachId)),
    ...fetched.data.assignments,
  ];
  const cursor = fetched.data.batch?.nextCursor ?? null;
  if (cursor !== null) {
    if (!dryRun) {
      await env.DB.prepare(
        `INSERT INTO coach_backfill_progress (provider, season, cursor, assignments_json, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (provider, season) DO UPDATE SET
           cursor = excluded.cursor, assignments_json = excluded.assignments_json, updated_at = excluded.updated_at`,
      )
        .bind(source, season, cursor, JSON.stringify(assignments), now)
        .run();
      for (const failure of fetched.data.completeness.failures)
        await writeDiagnostic(env, season, source, failure.reason, failure.url, now, failure.scope);
    }
    // A page batch stages source evidence. It cannot authorize season-wide removals.
    return {
      season,
      source,
      dryRun,
      complete: false,
      assignments: assignments.length,
      resolved: 0,
      unresolved: 0,
      conflicts: 0,
      failures: fetched.data.completeness.failures.length,
      changed: 0,
      pending: true,
    };
  }
  const summary = await ingestMatchCoachResult(
    env,
    season,
    source,
    {
      assignments,
      completeness: fetched.data.completeness,
    },
    dryRun,
    now,
  );
  // A returned summary ends the source cycle, including unresolved evidence.
  // Restart the index next time so corrected earlier profiles can be fetched.
  // A thrown write failure retains the checkpoint for retry.
  if (!dryRun)
    await env.DB.prepare("DELETE FROM coach_backfill_progress WHERE provider = ?1 AND season = ?2")
      .bind(source, season)
      .run();
  return summary;
}

const CoachAssignmentsSchema = z.array(
  z.object({
    competition: z.literal("AFLM"),
    season: z.number().int().min(1990),
    team: z.string().min(1),
    coachId: z.string().min(1),
    coachName: z.string().min(1),
    coachUrl: z.url(),
    matchId: z.string().min(1),
    matchUrl: z.url(),
    date: z.iso.date().nullable(),
    homeTeam: z.string().min(1).nullable(),
    awayTeam: z.string().min(1).nullable(),
    homePoints: z.number().int().nonnegative().nullable(),
    awayPoints: z.number().int().nonnegative().nullable(),
    roundName: z.string().nullable(),
    source: z.enum(["afl-tables", "footywire"]),
  }),
);

const MATCH_PROJECTION = `SELECT m.id, m.season_id, m.external_afltables_id, s.competition_id, m.date, m.home_team_id, m.away_team_id,
  h.name AS home_name, a.name AS away_name,
  h.competition_id AS home_competition_id, a.competition_id AS away_competition_id,
  m.home_points, m.away_points FROM matches m
  JOIN seasons s ON s.id = m.season_id JOIN competitions c ON c.id = s.competition_id
  JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id`;

function matchesEvidence(
  match: MatchCandidate,
  assignment: MatchCoachAssignment,
  requireAll: boolean,
): boolean {
  if (assignment.date !== null && assignment.date !== match.date) return false;
  if (
    match.home_competition_id !== match.competition_id ||
    match.away_competition_id !== match.competition_id
  )
    return false;
  const home =
    assignment.homeTeam === null
      ? null
      : normaliseTeamForMatch(assignment.homeTeam, "AFLM", assignment.season);
  const away =
    assignment.awayTeam === null
      ? null
      : normaliseTeamForMatch(assignment.awayTeam, "AFLM", assignment.season);
  if (
    requireAll &&
    (home === null ||
      away === null ||
      assignment.date === null ||
      assignment.homePoints === null ||
      assignment.awayPoints === null)
  )
    return false;
  if (home === null || away === null) {
    // A verified provider reference may omit participants, but supplied scores still need orientation.
    return assignment.homePoints === null && assignment.awayPoints === null;
  }
  const normal = home === match.home_name && away === match.away_name;
  const reversed = home === match.away_name && away === match.home_name;
  if (!normal && !reversed) return false;
  return (
    (assignment.homePoints === null ||
      assignment.homePoints === (normal ? match.home_points : match.away_points)) &&
    (assignment.awayPoints === null ||
      assignment.awayPoints === (normal ? match.away_points : match.home_points))
  );
}

function resolveMatch(
  matches: readonly MatchCandidate[],
  crosswalk: ReadonlyMap<string, number>,
  assignment: MatchCoachAssignment,
): { readonly status: "none" | "ambiguous" | "found"; readonly match?: MatchCandidate } {
  const externalId = crosswalk.get(assignment.matchId);
  const external = matches.find((match) => match.id === externalId);
  if (external)
    return matchesEvidence(external, assignment, false)
      ? { status: "found", match: external }
      : { status: "none" };
  if (assignment.source === "afl-tables") {
    const sourceId = assignment.matchId.replace(/^afl-tables:/, "");
    const gameId = /\/([^/]+)\.html$/.exec(assignment.matchUrl)?.[1] ?? sourceId;
    const ids = new Set([sourceId, assignment.matchUrl, gameId, `AT_${gameId}`]);
    const references = matches.filter(
      (match) => match.external_afltables_id !== null && ids.has(match.external_afltables_id),
    );
    if (references.length > 1) return { status: "ambiguous" };
    const reference = references[0];
    if (reference)
      return matchesEvidence(reference, assignment, false)
        ? { status: "found", match: reference }
        : { status: "none" };
  }
  if (!assignment.date) return { status: "none" };
  const verified = matches.filter(
    (match) => match.date === assignment.date && matchesEvidence(match, assignment, true),
  );
  if (verified.length > 1) return { status: "ambiguous" };
  return verified[0] ? { status: "found", match: verified[0] } : { status: "none" };
}

async function ensureCoach(
  env: Env,
  assignment: MatchCoachAssignment,
  source: CoachProvider,
  now: string,
): Promise<string> {
  const mapping = await env.DB.prepare(
    "SELECT coach_id FROM coach_external_ids WHERE provider = ?1 AND external_coach_id = ?2 AND verified = 1",
  )
    .bind(source, assignment.coachId)
    .first<{ coach_id: string }>();
  const internalId = mapping?.coach_id ?? assignment.coachId;
  const insert =
    source === "afl-tables"
      ? `INSERT INTO coaches (id, display_name, profile_url, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, profile_url = excluded.profile_url
       WHERE coaches.display_name IS NOT excluded.display_name OR coaches.profile_url IS NOT excluded.profile_url`
      : "INSERT INTO coaches (id, display_name, profile_url, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING";
  await env.DB.prepare(insert)
    .bind(internalId, assignment.coachName, assignment.coachUrl, now)
    .run();
  await env.DB.prepare(
    `INSERT INTO coach_external_ids (provider, external_coach_id, coach_id, display_name, profile_url)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (provider, external_coach_id) DO NOTHING`,
  )
    .bind(source, assignment.coachId, internalId, assignment.coachName, assignment.coachUrl)
    .run();
  return internalId;
}

function buildObservation(
  env: Env,
  assignment: MatchCoachAssignment,
  source: CoachProvider,
  coachId: string,
  matchId: number,
  teamId: number,
  now: string,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO coach_observations
      (provider, external_coach_id, external_match_id, coach_id, match_id, team_id, season,
       source_url, retrieved_at, match_date, display_name, raw_team, home_points, away_points)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
     ON CONFLICT (provider, external_coach_id, external_match_id, raw_team) DO UPDATE SET
       coach_id = excluded.coach_id, match_id = excluded.match_id, team_id = excluded.team_id,
       season = excluded.season, source_url = excluded.source_url, retrieved_at = excluded.retrieved_at,
       match_date = excluded.match_date, display_name = excluded.display_name,
       home_points = excluded.home_points, away_points = excluded.away_points`,
  ).bind(
    source,
    assignment.coachId,
    assignment.matchId,
    coachId,
    matchId,
    teamId,
    assignment.season,
    assignment.matchUrl,
    now,
    assignment.date,
    assignment.coachName,
    assignment.team,
    assignment.homePoints,
    assignment.awayPoints,
  );
}

async function writeDiagnostic(
  env: Env,
  season: number,
  source: CoachProvider,
  reason: string,
  url: string,
  now: string,
  scope = "season",
): Promise<void> {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO coach_import_diagnostics (provider, season, scope, source_url, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(source, season, scope, url, reason, now)
    .run();
}

async function recordSourceFailure(env: Env, season: number, source: CoachProvider, now: string) {
  await writeDiagnostic(env, season, source, "source-fetch-failed", "", now);
  await env.DB.prepare(
    `INSERT INTO coach_import_pages (provider, season, scope, status, last_checked_at, failure_count)
     VALUES (?1, ?2, 'season', 'failed', ?3, 1)
     ON CONFLICT (provider, season, scope) DO UPDATE SET status = 'failed',
       last_checked_at = excluded.last_checked_at, failure_count = coach_import_pages.failure_count + 1`,
  )
    .bind(source, season, now)
    .run();
  await logSync(env, `sync:${source}:coaches`, 0, "coaching source fetch failed");
}
