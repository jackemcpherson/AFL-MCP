import type { Env } from "../types";

const COMPETITION_CODES = ["AFLM", "AFLW", "VFL", "VFLW"] as const;
const DEGRADATION_WINDOW_HOURS = 24;

interface CompetitionStatus {
  readonly code: (typeof COMPETITION_CODES)[number];
  readonly latestSyncAt: string | null;
  readonly syncAgeSeconds: number | null;
  readonly latestSuccessAt: string | null;
  readonly successAgeSeconds: number | null;
  readonly latestErrorAt: string | null;
  readonly errorAgeSeconds: number | null;
  readonly latestCompletedMatchDate: string | null;
}

/** Aggregate-only private operator status response. */
export interface AdminStatusResponse {
  readonly status: "ok";
  readonly asOf: string;
  readonly lease: { readonly held: boolean; readonly ageSeconds: number | null };
  readonly competitions: readonly CompetitionStatus[];
  readonly integrity: {
    readonly disposals: number;
    readonly matchPoints: number;
    readonly quarterScores: number;
    readonly margin: number;
    readonly brownlow: number;
  };
  readonly degradation: {
    readonly windowHours: 24;
    readonly partialLineupEvents: number;
    readonly partialStatsEvents: number;
    readonly unmappedTeamEvents: number;
  };
  readonly coaching: {
    readonly latestSuccessAt: string | null;
    readonly failedScopes: number;
    readonly unresolvedJoins: number;
    readonly conflicts: number;
    readonly currentSeasonExpectedAssignments: number;
    readonly currentSeasonObservedAssignments: number;
  };
}

/**
 * Reads a fixed, bounded set of aggregate operational diagnostics.
 *
 * @param env - Worker bindings.
 * @param now - Shared clock instant used for all timestamps and ages.
 * @returns Aggregate-only private status.
 * @throws When any fixed D1 statement fails.
 */
export async function getAdminStatus(
  env: Env,
  now: Date = new Date(),
): Promise<AdminStatusResponse> {
  const startedAt = performance.now();
  const asOf = now.toISOString();
  const windowStart = new Date(
    now.getTime() - DEGRADATION_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `SELECT
         CASE WHEN holder IS NOT NULL AND julianday(acquired_at) >= julianday(?1, '-10 minutes') THEN 1 ELSE 0 END AS held,
         CASE WHEN holder IS NOT NULL AND julianday(acquired_at) >= julianday(?1, '-10 minutes')
              THEN MAX(0, CAST(ROUND((julianday(?1) - julianday(acquired_at)) * 86400) AS INTEGER))
              ELSE NULL END AS ageSeconds
       FROM sync_lease WHERE id = 1`,
    ).bind(asOf),
    env.DB.prepare(
      `SELECT substr(type, 6) AS code,
              MAX(timestamp) AS latestSyncAt,
              MAX(CASE WHEN error IS NULL THEN timestamp END) AS latestSuccessAt,
              MAX(CASE WHEN error IS NOT NULL THEN timestamp END) AS latestErrorAt
       FROM sync_log
       WHERE type IN ('sync:AFLM', 'sync:AFLW', 'sync:VFL', 'sync:VFLW')
       GROUP BY type`,
    ),
    env.DB.prepare(
      `SELECT c.code, MAX(m.date) AS latestCompletedMatchDate
       FROM competitions c
       LEFT JOIN seasons s ON s.competition_id = c.id
       LEFT JOIN matches m ON m.season_id = s.id
         AND m.home_points IS NOT NULL AND m.away_points IS NOT NULL
       WHERE c.code IN ('AFLM', 'AFLW', 'VFL', 'VFLW')
       GROUP BY c.code`,
    ),
    env.DB.prepare("SELECT COUNT(*) AS count FROM v_integrity_disposals"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM v_integrity_match_points"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM v_integrity_quarter_scores"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM v_integrity_margin"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM v_integrity_brownlow"),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN type IN ('sync:AFLM:lineups','sync:AFLW:lineups','sync:VFL:lineups','sync:VFLW:lineups')
                       AND error LIKE 'fetchLineup failed:%' THEN 1 ELSE 0 END) AS partialLineupEvents,
         SUM(CASE WHEN type IN ('sync:AFLM:stats','sync:AFLW:stats','sync:VFL:stats','sync:VFLW:stats')
                       AND (error LIKE 'fetchPlayerStats failed:%' OR error LIKE 'partial season stats:%')
                  THEN 1 ELSE 0 END) AS partialStatsEvents,
         SUM(CASE WHEN type = 'sync:stats:unmapped-team' THEN 1 ELSE 0 END) AS unmappedTeamEvents
       FROM sync_log WHERE timestamp >= ?1`,
    ).bind(windowStart),
    env.DB.prepare(
      `SELECT MAX(last_success_at) AS latestSuccessAt,
              SUM(CASE WHEN status IN ('failed', 'partial') THEN 1 ELSE 0 END) AS failedScopes
       FROM coach_import_pages WHERE provider = 'afl-tables'`,
    ),
    env.DB.prepare(
      `SELECT
         SUM(CASE WHEN reason IN ('unresolved-match', 'ambiguous-match', 'invalid-participant', 'score-mismatch') THEN 1 ELSE 0 END) AS unresolvedJoins
       FROM coach_import_diagnostics WHERE provider = 'afl-tables' AND resolved_at IS NULL`,
    ),
    env.DB.prepare(
      `SELECT COUNT(DISTINCT CAST(a.match_id AS TEXT) || ':' || CAST(a.team_id AS TEXT)) AS conflicts
       FROM coach_observations a JOIN coach_observations b
         ON b.match_id = a.match_id AND b.team_id = a.team_id AND b.provider = 'footywire'
       WHERE a.provider = 'afl-tables' AND a.coach_id <> b.coach_id`,
    ),
    env.DB.prepare(
      `SELECT 2 * COUNT(DISTINCT m.id) AS expectedAssignments,
              COUNT(DISTINCT CAST(mc.match_id AS TEXT) || ':' || CAST(mc.team_id AS TEXT)) AS observedAssignments
       FROM competitions c JOIN seasons s ON s.competition_id = c.id
       JOIN matches m ON m.season_id = s.id
       LEFT JOIN match_coaches mc ON mc.match_id = m.id AND mc.team_id IN (m.home_team_id, m.away_team_id)
       WHERE c.code = 'AFLM' AND s.year = ?1 AND m.home_points IS NOT NULL AND m.away_points IS NOT NULL`,
    ).bind(now.getUTCFullYear()),
  ]);

  const lease = resultRow(results, 0);
  const syncRows = resultRows(results, 1);
  const matchRows = resultRows(results, 2);
  const syncByCode = new Map(syncRows.map((row) => [stringValue(row.code), row]));
  const matchesByCode = new Map(matchRows.map((row) => [stringValue(row.code), row]));
  const competitions = COMPETITION_CODES.map((code): CompetitionStatus => {
    const sync = syncByCode.get(code);
    const latestSyncAt = nullableString(sync?.latestSyncAt);
    const latestSuccessAt = nullableString(sync?.latestSuccessAt);
    const latestErrorAt = nullableString(sync?.latestErrorAt);
    return {
      code,
      latestSyncAt,
      syncAgeSeconds: ageSeconds(latestSyncAt, now),
      latestSuccessAt,
      successAgeSeconds: ageSeconds(latestSuccessAt, now),
      latestErrorAt,
      errorAgeSeconds: ageSeconds(latestErrorAt, now),
      latestCompletedMatchDate: nullableString(matchesByCode.get(code)?.latestCompletedMatchDate),
    };
  });
  const degradation = resultRow(results, 8);
  const coaching = resultRow(results, 9);
  const coachingJoins = resultRow(results, 10);
  const coachingConflict = resultRow(results, 11);
  const coachingCoverage = resultRow(results, 12);
  const response: AdminStatusResponse = {
    status: "ok",
    asOf,
    lease: {
      held: numberValue(lease?.held) === 1,
      ageSeconds: numberOrNull(lease?.ageSeconds),
    },
    competitions,
    integrity: {
      disposals: countAt(results, 3),
      matchPoints: countAt(results, 4),
      quarterScores: countAt(results, 5),
      margin: countAt(results, 6),
      brownlow: countAt(results, 7),
    },
    degradation: {
      windowHours: DEGRADATION_WINDOW_HOURS,
      partialLineupEvents: numberValue(degradation?.partialLineupEvents),
      partialStatsEvents: numberValue(degradation?.partialStatsEvents),
      unmappedTeamEvents: numberValue(degradation?.unmappedTeamEvents),
    },
    coaching: {
      latestSuccessAt: nullableString(coaching?.latestSuccessAt),
      failedScopes: numberValue(coaching?.failedScopes),
      unresolvedJoins: numberValue(coachingJoins?.unresolvedJoins),
      conflicts: numberValue(coachingConflict?.conflicts),
      currentSeasonExpectedAssignments: numberValue(coachingCoverage?.expectedAssignments),
      currentSeasonObservedAssignments: numberValue(coachingCoverage?.observedAssignments),
    },
  };
  console.log(
    JSON.stringify({
      event: "admin_status_query",
      elapsedMs: Math.round(performance.now() - startedAt),
    }),
  );
  return response;
}

function resultRows(
  results: readonly D1Result<unknown>[],
  index: number,
): Record<string, unknown>[] {
  const rows = results[index]?.results;
  if (!Array.isArray(rows)) return [];
  return rows.filter(isRecord);
}

function resultRow(
  results: readonly D1Result<unknown>[],
  index: number,
): Record<string, unknown> | undefined {
  return resultRows(results, index)[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countAt(results: readonly D1Result<unknown>[], index: number): number {
  return numberValue(resultRow(results, index)?.count);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function ageSeconds(timestamp: string | null, now: Date): number | null {
  if (timestamp === null) return null;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / 1000));
}
