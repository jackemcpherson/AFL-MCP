import { Schema } from "effect";
import { COMPETITION_CODES, type CompetitionCode } from "../lib/competitions";
import { batchRow, batchRows } from "../lib/decode";
import { playedMatch } from "../lib/match-state";
import { LEASE_TTL_MINUTES } from "../sync/lease";
import type { Env } from "../types";
import { COACHING_CONFLICTS_SQL, UNRESOLVED_COACH_JOINS_SQL } from "../lib/coaching-queries";

const DEGRADATION_WINDOW_HOURS = 24;

interface CompetitionStatus {
  readonly code: CompetitionCode;
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
  readonly remediation: {
    readonly inputWriteActive: boolean;
    readonly inputWriteOperation: string | null;
    readonly auditScopesUnresolved: number;
    readonly inputWriteAgeSeconds: number | null;
    /** Scheduled matches the cron will fetch on its next hourly pass. */
    readonly statisticsDue: number;
    /** Operator-queued matches waiting for a backfill or approved refresh. */
    readonly statisticsAwaitingOperator: number;
    readonly statisticsFailed: number;
    readonly statisticsUnresolved: number;
    readonly weatherUnresolved: number;
    readonly weatherUnavailable: number;
    readonly pavSeasonsPending: number;
    readonly identityRepairsPending: number;
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

/** A nullable count or age column; absent and NULL both read as no value. */
const NumberColumn = Schema.optionalKey(Schema.NullOr(Schema.Number));
/** A nullable text column. */
const TextColumn = Schema.optionalKey(Schema.NullOr(Schema.String));

const LeaseRowSchema = Schema.Struct({ held: NumberColumn, ageSeconds: NumberColumn });
const SyncRowSchema = Schema.Struct({
  code: Schema.String,
  latestSyncAt: TextColumn,
  latestSuccessAt: TextColumn,
  latestErrorAt: TextColumn,
});
const MatchRowSchema = Schema.Struct({ code: Schema.String, latestCompletedMatchDate: TextColumn });
const CountRowSchema = Schema.Struct({ count: NumberColumn });
const DegradationRowSchema = Schema.Struct({
  partialLineupEvents: NumberColumn,
  partialStatsEvents: NumberColumn,
  unmappedTeamEvents: NumberColumn,
});
const CoachingRowSchema = Schema.Struct({
  latestSuccessAt: TextColumn,
  failedScopes: NumberColumn,
});
/** One `n` count from the shared coaching diagnostic statements. */
const CoachingCountRowSchema = Schema.Struct({ n: NumberColumn });
const CoachingCoverageRowSchema = Schema.Struct({
  expectedAssignments: NumberColumn,
  observedAssignments: NumberColumn,
});
const RemediationRowSchema = Schema.Struct({
  in_progress: NumberColumn,
  write_started_at: TextColumn,
  write_operation: TextColumn,
  auditScopesUnresolved: NumberColumn,
  statisticsDue: NumberColumn,
  statisticsAwaitingOperator: NumberColumn,
  statisticsFailed: NumberColumn,
  statisticsUnresolved: NumberColumn,
  weatherUnresolved: NumberColumn,
  weatherUnavailable: NumberColumn,
  pavSeasonsPending: NumberColumn,
  identityRepairsPending: NumberColumn,
});

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
         CASE WHEN holder IS NOT NULL AND julianday(acquired_at) >= julianday(?1, '-${LEASE_TTL_MINUTES} minutes') THEN 1 ELSE 0 END AS held,
         CASE WHEN holder IS NOT NULL AND julianday(acquired_at) >= julianday(?1, '-${LEASE_TTL_MINUTES} minutes')
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
         AND ${playedMatch("m")}
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
    env.DB.prepare(UNRESOLVED_COACH_JOINS_SQL),
    env.DB.prepare(COACHING_CONFLICTS_SQL),
    env.DB.prepare(
      `SELECT 2 * COUNT(DISTINCT m.id) AS expectedAssignments,
              COUNT(DISTINCT CAST(mc.match_id AS TEXT) || ':' || CAST(mc.team_id AS TEXT)) AS observedAssignments
       FROM competitions c JOIN seasons s ON s.competition_id = c.id
       JOIN matches m ON m.season_id = s.id
       LEFT JOIN match_coaches mc ON mc.match_id = m.id AND mc.team_id IN (m.home_team_id, m.away_team_id)
       WHERE c.code = 'AFLM' AND s.year = ?1 AND ${playedMatch("m")}`,
    ).bind(now.getUTCFullYear()),
    env.DB.prepare(`SELECT in_progress, write_started_at, write_operation,
      (SELECT COUNT(*) FROM sync_log a WHERE a.type LIKE 'audit:season:%' AND a.error IS NOT NULL
       AND a.id=(SELECT MAX(b.id) FROM sync_log b WHERE b.type=a.type)) AS auditScopesUnresolved,
      (SELECT count(*) FROM match_stats_refresh WHERE next_retry_at <= ?1 AND origin='scheduled') AS statisticsDue,
      (SELECT count(*) FROM match_stats_refresh WHERE next_retry_at <= ?1 AND origin='operator') AS statisticsAwaitingOperator,
      (SELECT count(*) FROM match_stats_refresh WHERE failures > 0) AS statisticsFailed,
      (SELECT count(*) FROM match_stats_refresh WHERE diagnostic IS NOT NULL) AS statisticsUnresolved,
      (SELECT count(*) FROM weather_refresh_state WHERE diagnostic IS NOT NULL) AS weatherUnresolved,
      (SELECT count(*) FROM weather_refresh_state WHERE kind='observed' AND failures > 0 AND next_retry_at IS NULL) AS weatherUnavailable,
      (SELECT count(*) FROM pav_rebuild_queue) AS pavSeasonsPending,
      (SELECT count(*) FROM identity_repair_operations WHERE status <> 'complete') AS identityRepairsPending
      FROM public_input_revision WHERE id=1`).bind(asOf),
  ]);

  const lease = batchRow(results, 0, LeaseRowSchema);
  const syncByCode = new Map(batchRows(results, 1, SyncRowSchema).map((row) => [row.code, row]));
  const matchesByCode = new Map(
    batchRows(results, 2, MatchRowSchema).map((row) => [row.code, row]),
  );
  const competitions = COMPETITION_CODES.map((code): CompetitionStatus => {
    const sync = syncByCode.get(code);
    const latestSyncAt = sync?.latestSyncAt ?? null;
    const latestSuccessAt = sync?.latestSuccessAt ?? null;
    const latestErrorAt = sync?.latestErrorAt ?? null;
    return {
      code,
      latestSyncAt,
      syncAgeSeconds: ageSeconds(latestSyncAt, now),
      latestSuccessAt,
      successAgeSeconds: ageSeconds(latestSuccessAt, now),
      latestErrorAt,
      errorAgeSeconds: ageSeconds(latestErrorAt, now),
      latestCompletedMatchDate: matchesByCode.get(code)?.latestCompletedMatchDate ?? null,
    };
  });
  const degradation = batchRow(results, 8, DegradationRowSchema);
  const coaching = batchRow(results, 9, CoachingRowSchema);
  const coachingJoins = batchRow(results, 10, CoachingCountRowSchema);
  const coachingConflict = batchRow(results, 11, CoachingCountRowSchema);
  const coachingCoverage = batchRow(results, 12, CoachingCoverageRowSchema);
  const remediation = batchRow(results, 13, RemediationRowSchema);
  const response: AdminStatusResponse = {
    status: "ok",
    asOf,
    lease: {
      held: countOrZero(lease?.held) === 1,
      ageSeconds: ageOrNull(lease?.ageSeconds),
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
      partialLineupEvents: countOrZero(degradation?.partialLineupEvents),
      partialStatsEvents: countOrZero(degradation?.partialStatsEvents),
      unmappedTeamEvents: countOrZero(degradation?.unmappedTeamEvents),
    },
    remediation: {
      inputWriteActive: countOrZero(remediation?.in_progress) === 1,
      inputWriteOperation: remediation?.write_operation ?? null,
      auditScopesUnresolved: countOrZero(remediation?.auditScopesUnresolved),
      inputWriteAgeSeconds: ageSeconds(remediation?.write_started_at ?? null, now),
      statisticsDue: countOrZero(remediation?.statisticsDue),
      statisticsAwaitingOperator: countOrZero(remediation?.statisticsAwaitingOperator),
      statisticsFailed: countOrZero(remediation?.statisticsFailed),
      statisticsUnresolved: countOrZero(remediation?.statisticsUnresolved),
      weatherUnresolved: countOrZero(remediation?.weatherUnresolved),
      weatherUnavailable: countOrZero(remediation?.weatherUnavailable),
      pavSeasonsPending: countOrZero(remediation?.pavSeasonsPending),
      identityRepairsPending: countOrZero(remediation?.identityRepairsPending),
    },
    coaching: {
      latestSuccessAt: coaching?.latestSuccessAt ?? null,
      failedScopes: countOrZero(coaching?.failedScopes),
      unresolvedJoins: countOrZero(coachingJoins?.n),
      conflicts: countOrZero(coachingConflict?.n),
      currentSeasonExpectedAssignments: countOrZero(coachingCoverage?.expectedAssignments),
      currentSeasonObservedAssignments: countOrZero(coachingCoverage?.observedAssignments),
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

function countAt(results: readonly D1Result[], index: number): number {
  return countOrZero(batchRow(results, index, CountRowSchema)?.count);
}

/** A finite count, with NULL or a missing row read as zero. */
function countOrZero(value: number | null | undefined): number {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : 0;
}

/** A non-negative age, or null when unknown. */
function ageOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value)
    ? Math.max(0, value)
    : null;
}

function ageSeconds(timestamp: string | null, now: Date): number | null {
  if (timestamp === null) return null;
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((now.getTime() - time) / 1000));
}
