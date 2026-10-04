import type { Env } from "../types";

/**
 * Inspect one competition-season per hourly pass without changing public inputs.
 * Rotate by the least recently audited season. Log bounded, actionable record IDs;
 * findings are investigation candidates, never automatic repair instructions.
 * @param env - Worker bindings.
 * @param now - Audit observation time.

 * @returns Resolves after persisting a bounded audit or skipping changing inputs.
 * @throws If a database query or audit write fails.
 * @example
 * await auditNextSeason(env);
 */
export async function auditNextSeason(env: Env, now = new Date()): Promise<void> {
  const season = await env.DB.prepare(`SELECT s.id, s.season_key, c.code
    FROM seasons s JOIN competitions c ON c.id=s.competition_id
    LEFT JOIN sync_log l ON l.type='audit:season:' || s.id
    WHERE c.code IN ('AFLM','AFLW','VFL','VFLW')
    GROUP BY s.id ORDER BY MAX(l.timestamp), s.id LIMIT 1`).first<{
    id: number;
    season_key: string;
    code: string;
  }>();
  if (!season) return;
  const [marker, findings] = await env.DB.batch([
    env.DB.prepare("SELECT revision, in_progress FROM public_input_revision WHERE id=1"),
    env.DB.prepare(`SELECT 'completed-without-statistics' AS issue, CAST(m.id AS TEXT) AS record_id
      FROM matches m WHERE m.season_id=?1 AND m.status='Complete'
      AND NOT EXISTS (SELECT 1 FROM player_match_stats p WHERE p.match_id=m.id)
      UNION ALL
      SELECT 'provider-match-not-linked', json_extract(j.value, '$.matchId')
      FROM season_provider_inventory i, json_each(i.matches_json) j
      WHERE i.season_id=?1 AND NOT EXISTS (
        SELECT 1 FROM matches m WHERE m.season_id=?1
        AND m.external_afl_id=json_extract(j.value, '$.matchId'))
      UNION ALL
      SELECT 'statistics-refresh-failed', CAST(m.id AS TEXT)
      FROM matches m JOIN match_stats_refresh r ON r.match_id=m.id
      WHERE m.season_id=?1 AND r.failures>0
      UNION ALL
      SELECT 'pav-inputs-unresolved', CAST(p.player_id AS TEXT)
      FROM player_season_pav p WHERE p.season_id=?1 AND p.total_pav IS NULL
      LIMIT 101`).bind(season.id),
  ]);
  const start = marker?.results[0] as { revision: number; in_progress: number } | undefined;
  const end = await env.DB.prepare(
    "SELECT revision, in_progress FROM public_input_revision WHERE id=1",
  ).first<{ revision: number; in_progress: number }>();
  if (!start || !end || start.in_progress || end.in_progress || start.revision !== end.revision)
    return;
  const rows = findings?.results ?? [];
  const report = {
    competition: season.code,
    season: season.season_key,
    seasonId: season.id,
    observedAt: now.toISOString(),
    inputRevision: end.revision,
    findings: rows.slice(0, 100),
    truncated: rows.length > 100,
  };
  await env.DB.prepare(
    "INSERT INTO sync_log(timestamp,type,rows_affected,error) VALUES (?1,?2,0,?3)",
  )
    .bind(
      now.toISOString(),
      `audit:season:${season.id}`,
      rows.length ? JSON.stringify(report) : null,
    )
    .run();
}
