import type { MatchCoachAssignment, MatchCoachFailure } from "fitzroy";
import { fetchMatchCoaches } from "fitzroy";
import { Effect, Schema } from "effect";
import { runOperation } from "../db/operation";
import type { MessageFields, TaggedErrorBase } from "../lib/errors";
import { runFitzroy } from "../lib/fitzroy";
import { type Decoder, strictDecoder } from "../lib/decode";
import {
  booleanDefault,
  IsoDateSchema,
  NonEmptyStringSchema,
  UrlStringSchema,
} from "../lib/schemas";
import { normaliseTeamForMatch } from "../lib/normalise";
import { logSync } from "../sync/log";
import type { Env } from "../types";
import { MIN_COACHING_YEAR } from "../lib/coaching-queries";

type CoachProvider = "afl-tables" | "footywire";

const CoachingSourceErrorBase: TaggedErrorBase<
  CoachingSourceError,
  "CoachingSourceError",
  MessageFields
> = Schema.TaggedError<CoachingSourceError>()("CoachingSourceError", {
  message: Schema.String,
});

/**
 * A coaching provider fetch failed.
 *
 * Thrown before any coaching fact is written. A non-dry run first records the
 * failure as a diagnostic, a failed import page and a sync log row, so callers
 * treat it as a completed, failed attempt rather than a partial import.
 *
 * @example
 * throw new CoachingSourceError({ message: "coaching source fetch failed" });
 */
class CoachingSourceError extends CoachingSourceErrorBase {}

/** One row of {@link MATCH_PROJECTION}. */
const MatchCandidateSchema = Schema.Struct({
  id: Schema.Number,
  season_id: Schema.Number,
  external_afltables_id: Schema.NullOr(Schema.String),
  competition_id: Schema.Number,
  date: Schema.String,
  home_team_id: Schema.Number,
  away_team_id: Schema.Number,
  home_name: Schema.String,
  away_name: Schema.String,
  home_competition_id: Schema.Number,
  away_competition_id: Schema.Number,
  home_points: Schema.NullOr(Schema.Number),
  away_points: Schema.NullOr(Schema.Number),
});

type MatchCandidate = typeof MatchCandidateSchema.Type;

const decodeMatchCandidates = Schema.decodeUnknownSync(Schema.Array(MatchCandidateSchema));

/** Provider match ids already linked to stored matches. */
const decodeCrosswalkRows = Schema.decodeUnknownSync(
  Schema.Array(Schema.Struct({ external_match_id: Schema.String, match_id: Schema.Number })),
);

/** Provider coach ids already linked to canonical coaches. */
const decodeCoachIdentityRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({
      external_coach_id: Schema.String,
      coach_id: Schema.String,
      verified: Schema.Number,
    }),
  ),
);

/** Current coach assignments for the season. */
const decodeAssignmentRows = Schema.decodeUnknownSync(
  Schema.Array(
    Schema.Struct({ match_id: Schema.Number, team_id: Schema.Number, coach_id: Schema.String }),
  ),
);

/** Counts for one coaching season import, previewed or applied. */
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
  dryRun: boolean = false,
  retrievedAt: string = new Date().toISOString(),
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
  const seasonMatches = decodeMatchCandidates(matches.results);
  const matchCrosswalk = new Map(
    decodeCrosswalkRows(crosswalks.results).map((row) => [row.external_match_id, row.match_id]),
  );
  const coachIdentities = new Map(
    decodeCoachIdentityRows(identities.results).map((row) => [
      row.external_coach_id,
      { coach_id: row.coach_id, verified: row.verified },
    ]),
  );
  const existingAssignments = new Map(
    decodeAssignmentRows(currentAssignments.results).map((row) => [
      `${row.match_id}:${row.team_id}`,
      row.coach_id,
    ]),
  );
  const coaches = new Set<string>();
  // Every write, diagnostics included, runs in ordered batches of 100 below.
  const writes: D1PreparedStatement[] = [];
  const diagnose = (reason: string, url: string): void => {
    if (!dryRun) writes.push(diagnosticStatement(env, season, source, reason, url, retrievedAt));
  };
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
      diagnose("invalid-scope", assignment.matchUrl);
      continue;
    }
    const candidate = resolveMatch(seasonMatches, matchCrosswalk, assignment);
    if (candidate.status === "ambiguous") {
      unresolved++;
      diagnose("ambiguous-match", assignment.matchUrl);
      continue;
    }
    if (!candidate.match) {
      unresolved++;
      diagnose("unresolved-match", assignment.matchUrl);
      continue;
    }
    const match = candidate.match;
    if (!matchesEvidence(match, assignment, false)) {
      unresolved++;
      diagnose("score-mismatch", assignment.matchUrl);
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
      diagnose("invalid-participant", assignment.matchUrl);
      continue;
    }

    const key = `${match.id}:${validTeam.id}`;
    if (resolvedKeys.has(key)) duplicateKeys.add(key);
    resolvedKeys.add(key);
    const identity = coachIdentities.get(assignment.coachId);
    if (identity && identity.coach_id !== assignment.coachId && identity.verified !== 1) {
      unresolved++;
      diagnose("unverified-identity", assignment.coachUrl);
      continue;
    }
    planned.push({ assignment, match, teamId: validTeam.id });
  }

  for (const { assignment, match, teamId } of planned) {
    const key = `${match.id}:${teamId}`;
    if (duplicateKeys.has(key)) {
      unresolved++;
      diagnose("duplicate-assignment", assignment.matchUrl);
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
    const coachId = canonicalId;
    if (!coaches.has(assignment.coachId)) {
      // Coach rows precede the observations that reference them in `writes`.
      writes.push(...coachStatements(env, assignment, source, coachId, retrievedAt));
      coaches.add(assignment.coachId);
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

  changed += await runInBatches(env, writes);

  // A full, failure-free and fully resolved source cycle. Only this may
  // remove assignments, mark the season successful and close diagnostics.
  const complete =
    !result.batch &&
    result.completeness.complete &&
    result.completeness.failures.length === 0 &&
    unresolved === 0;

  if (!dryRun && source === "afl-tables" && complete) {
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
    changed += await runInBatches(env, removals);
  }

  if (!dryRun) {
    const closing = [
      ...result.completeness.failures.map((failure) =>
        diagnosticStatement(
          env,
          season,
          source,
          failure.reason.slice(0, 180),
          failure.url,
          retrievedAt,
          failure.scope,
        ),
      ),
      env.DB.prepare(
        `INSERT INTO coach_import_pages (provider, season, scope, status, last_checked_at, last_success_at, failure_count)
       VALUES (?1, ?2, 'season', ?3, ?4, ?5, ?6)
       ON CONFLICT (provider, season, scope) DO UPDATE SET
         status = excluded.status, last_checked_at = excluded.last_checked_at,
         last_success_at = COALESCE(excluded.last_success_at, coach_import_pages.last_success_at),
         failure_count = CASE WHEN excluded.status = 'success' THEN 0 ELSE coach_import_pages.failure_count + 1 END`,
      ).bind(
        source,
        season,
        complete ? "success" : "partial",
        retrievedAt,
        complete ? retrievedAt : null,
        result.completeness.failures.length + unresolved,
      ),
      ...(complete
        ? [
            env.DB.prepare(
              "UPDATE coach_import_diagnostics SET resolved_at = ?1 WHERE provider = ?2 AND season = ?3 AND resolved_at IS NULL",
            ).bind(retrievedAt, source, season),
          ]
        : []),
    ];
    await runInBatches(env, closing);
  }
  return {
    season,
    source,
    dryRun,
    complete,
    assignments: result.assignments.length,
    resolved,
    unresolved,
    conflicts,
    failures: result.completeness.failures.length,
    changed,
  };
}

/**
 * Outcome of a backfill-coaches call. `busy` alone means another operation
 * holds the lease. `sourceFailed` means the provider fetch failed: the
 * failure is recorded and the public write marker is cleared.
 */
export interface CoachingBackfillResult {
  readonly busy: boolean;
  readonly sourceFailed?: boolean;
  readonly summary?: CoachingImportSummary;
}

/**
 * Run the authenticated one-season coaching operation under the shared lease.
 *
 * @param env - Worker bindings.
 * @param season - AFLM season to fetch.
 * @param source - Primary AFL Tables or comparison FootyWire source.
 * @param dryRun - Whether to avoid persistent import writes.
 * @param resume - Take over the stranded write marker of an interrupted run
 *   of this same source and season.
 * @returns Whether the lease was busy or the source failed and, otherwise,
 *   the import summary.
 * @throws If a D1 operation fails. The write marker then stays stranded for
 *   an explicit resume.
 * @example
 * await backfillCoaches(env, 2024, "afl-tables", true);
 */
export async function backfillCoaches(
  env: Env,
  season: number,
  source: CoachProvider,
  dryRun: boolean,
  resume = false,
): Promise<CoachingBackfillResult> {
  return runOperation<CoachingBackfillResult>(
    env,
    () => ({ busy: true }),
    async (operation) => {
      const writer = dryRun
        ? env
        : await operation.write(`coaching:${source}:${season}`, { resume });
      try {
        return { busy: false, summary: await runCoachBatch(writer, season, source, dryRun) };
      } catch (error) {
        // The failure is already recorded and no fact was written, so
        // returning lets runOperation clear the marker instead of stranding it.
        if (error instanceof CoachingSourceError) return { busy: false, sourceFailed: true };
        throw error;
      }
    },
  );
}

/**
 * Refresh the active AFLM season on a bounded schedule.
 *
 * Successful checks recur every 24 hours. Partial or failed checks retry after
 * three hours. All work runs inside the caller's existing sync lease.
 *
 * @param env - Worker bindings.
 * @param now - Shared clock instant used for cadence decisions.
 * @param season - The AFLM season to refresh. The sync passes its current
 * season, which is not the calendar year before a season starts.
 * @returns A promise that resolves after the best-effort refresh.
 * @example
 * await refreshActiveCoaches(env, new Date());
 */
export async function refreshActiveCoaches(
  env: Env,
  now: Date = new Date(),
  season: number = now.getUTCFullYear(),
): Promise<void> {
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
  const fetched = await runFitzroy(
    fetchMatchCoaches({
      season,
      competition: "AFLM",
      source,
      batch: { limit: 5, ...(progress?.cursor && { cursor: progress.cursor }) },
    }),
  );
  if (!fetched.success) {
    if (!dryRun) await recordSourceFailure(env, season, source, now);
    throw new CoachingSourceError({ message: "coaching source fetch failed" });
  }
  const previous = progress?.cursor ? decodeStoredCoachAssignments(progress.assignments_json) : [];
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
      await runInBatches(
        env,
        fetched.data.completeness.failures.map((failure) =>
          diagnosticStatement(env, season, source, failure.reason, failure.url, now, failure.scope),
        ),
      );
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

const NullableNonNegativeIntSchema = Schema.NullOr(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
);

/** Assignments saved in `coach_backfill_progress.assignments_json` by an earlier batch. */
const StoredCoachAssignmentsSchema = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      competition: Schema.Literal("AFLM"),
      season: Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_COACHING_YEAR)),
      team: NonEmptyStringSchema,
      coachId: NonEmptyStringSchema,
      coachName: NonEmptyStringSchema,
      coachUrl: UrlStringSchema,
      matchId: NonEmptyStringSchema,
      matchUrl: UrlStringSchema,
      date: Schema.NullOr(IsoDateSchema),
      homeTeam: Schema.NullOr(NonEmptyStringSchema),
      awayTeam: Schema.NullOr(NonEmptyStringSchema),
      homePoints: NullableNonNegativeIntSchema,
      awayPoints: NullableNonNegativeIntSchema,
      roundName: Schema.NullOr(Schema.String),
      source: Schema.Literals(["afl-tables", "footywire"]),
    }),
  ),
);

const decodeStoredCoachAssignments = Schema.decodeUnknownSync(StoredCoachAssignmentsSchema);

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

/** Outcome of matching a coaching assignment to a season match. */
interface MatchResolution {
  readonly status: "none" | "ambiguous" | "found";
  readonly match?: MatchCandidate;
}

function resolveMatch(
  matches: readonly MatchCandidate[],
  crosswalk: ReadonlyMap<string, number>,
  assignment: MatchCoachAssignment,
): MatchResolution {
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

/**
 * The upserts that make a coach and its provider identity exist.
 *
 * @param env - Worker bindings.
 * @param assignment - Source assignment naming the coach.
 * @param source - Provider of the assignment.
 * @param coachId - Canonical coach id: the verified mapping, else the provider id.
 * @param now - Import timestamp.
 * @returns The coach upsert, then the provider identity insert.
 */
function coachStatements(
  env: Env,
  assignment: MatchCoachAssignment,
  source: CoachProvider,
  coachId: string,
  now: string,
): D1PreparedStatement[] {
  const insert =
    source === "afl-tables"
      ? `INSERT INTO coaches (id, display_name, profile_url, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, profile_url = excluded.profile_url
       WHERE coaches.display_name IS NOT excluded.display_name OR coaches.profile_url IS NOT excluded.profile_url`
      : "INSERT INTO coaches (id, display_name, profile_url, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (id) DO NOTHING";
  return [
    env.DB.prepare(insert).bind(coachId, assignment.coachName, assignment.coachUrl, now),
    env.DB.prepare(
      `INSERT INTO coach_external_ids (provider, external_coach_id, coach_id, display_name, profile_url)
     VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (provider, external_coach_id) DO NOTHING`,
    ).bind(source, assignment.coachId, coachId, assignment.coachName, assignment.coachUrl),
  ];
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

/**
 * Record one import diagnostic, keeping the first copy of a repeated one.
 *
 * @param env - Worker bindings.
 * @param season - AFLM season.
 * @param source - Provider.
 * @param reason - Bounded diagnostic reason.
 * @param url - Source URL the diagnostic refers to.
 * @param now - Import timestamp.
 * @param scope - Import scope, `season` or a `coach:` page.
 * @returns The insert statement.
 */
function diagnosticStatement(
  env: Env,
  season: number,
  source: CoachProvider,
  reason: string,
  url: string,
  now: string,
  scope = "season",
): D1PreparedStatement {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO coach_import_diagnostics (provider, season, scope, source_url, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(source, season, scope, url, reason, now);
}

/** Most statements sent in one D1 batch. */
const WRITE_BATCH_SIZE = 100;

/**
 * Run statements in order, in batches of {@link WRITE_BATCH_SIZE}.
 *
 * @param env - Worker bindings.
 * @param statements - Statements to run.
 * @returns The rows each statement returned, summed.
 */
async function runInBatches(env: Env, statements: readonly D1PreparedStatement[]): Promise<number> {
  let returned = 0;
  for (let offset = 0; offset < statements.length; offset += WRITE_BATCH_SIZE) {
    const results = await env.DB.batch(statements.slice(offset, offset + WRITE_BATCH_SIZE));
    returned += results.reduce((sum, result) => sum + result.results.length, 0);
  }
  return returned;
}

async function recordSourceFailure(env: Env, season: number, source: CoachProvider, now: string) {
  await env.DB.batch([
    diagnosticStatement(env, season, source, "source-fetch-failed", "", now),
    env.DB.prepare(
      `INSERT INTO coach_import_pages (provider, season, scope, status, last_checked_at, failure_count)
     VALUES (?1, ?2, 'season', 'failed', ?3, 1)
     ON CONFLICT (provider, season, scope) DO UPDATE SET status = 'failed',
       last_checked_at = excluded.last_checked_at, failure_count = coach_import_pages.failure_count + 1`,
    ).bind(source, season, now),
  ]);
  await logSync(env, `sync:${source}:coaches`, 0, "coaching source fetch failed");
}

/** One explicit AFLM coaching season and source. */
export const CoachingBackfillRequestSchema: Schema.Struct<{
  readonly resume: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
  readonly fromYear: Schema.Int;
  readonly toYear: Schema.Int;
  readonly source: Schema.withDecodingDefaultKey<
    Schema.Literals<readonly ["afl-tables", "footywire"]>,
    never
  >;
  readonly dryRun: Schema.withDecodingDefaultKey<Schema.Boolean, never>;
}> = Schema.Struct({
  resume: booleanDefault(false),
  fromYear: Schema.Int,
  toYear: Schema.Int,
  source: Schema.Literals(["afl-tables", "footywire"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("afl-tables" as const)),
  ),
  dryRun: booleanDefault(true),
});

/** One-season coaching backfill request shape. */
export type CoachingBackfillRequest = typeof CoachingBackfillRequestSchema.Type;

/** Decode a coaching backfill body, rejecting unknown keys. */
export const decodeCoachingBackfillRequest: Decoder<CoachingBackfillRequest> = strictDecoder(
  CoachingBackfillRequestSchema,
);
