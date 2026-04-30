import { MIN_PAV_YEAR } from "../lib/constants";
import type { Env } from "../types";

export { MIN_PAV_YEAR };

import { logSync } from "./log";

// D1 does not support CTEs combined with INSERT...ON CONFLICT in a single
// statement, so we split into a SELECT (with CTEs) and a parameterised UPSERT.

const PAV_SELECT_SQL = `
WITH
-- Step 0: Identify the season
target_season AS (
    SELECT s.id AS season_id
    FROM seasons s
    JOIN competitions c ON s.competition_id = c.id
    WHERE s.year = ? AND c.code = 'AFLM'
),

-- Step 1a: Aggregate inside 50s per team per match
team_match_i50 AS (
    SELECT pms.match_id, pms.team_id,
           SUM(COALESCE(pms.inside_fifties, 0)) AS i50
    FROM player_match_stats pms
    JOIN matches m ON pms.match_id = m.id
    JOIN target_season ts ON m.season_id = ts.season_id
    WHERE m.home_points IS NOT NULL
    GROUP BY pms.match_id, pms.team_id
),

-- Step 1b: Aggregate season totals per team
team_season AS (
    SELECT sub.team_id,
        SUM(sub.pts_for)     AS pts_for,
        SUM(sub.pts_against) AS pts_against,
        SUM(sub.i50_for)     AS i50_for,
        SUM(sub.i50_against) AS i50_against
    FROM (
        -- Home games
        SELECT m.home_team_id AS team_id,
            m.home_points AS pts_for,
            m.away_points AS pts_against,
            h.i50 AS i50_for,
            a.i50 AS i50_against
        FROM matches m
        JOIN target_season ts ON m.season_id = ts.season_id
        JOIN team_match_i50 h
            ON h.match_id = m.id AND h.team_id = m.home_team_id
        JOIN team_match_i50 a
            ON a.match_id = m.id AND a.team_id = m.away_team_id
        WHERE m.home_points IS NOT NULL
        UNION ALL
        -- Away games
        SELECT m.away_team_id,
            m.away_points, m.home_points,
            a.i50, h.i50
        FROM matches m
        JOIN target_season ts ON m.season_id = ts.season_id
        JOIN team_match_i50 h
            ON h.match_id = m.id AND h.team_id = m.home_team_id
        JOIN team_match_i50 a
            ON a.match_id = m.id AND a.team_id = m.away_team_id
        WHERE m.home_points IS NOT NULL
    ) sub
    GROUP BY sub.team_id
),

-- Step 2: League average and team count
league_avg AS (
    SELECT CAST(SUM(pts_for) AS REAL)
         / NULLIF(SUM(i50_for), 0) AS avg_pts_per_i50
    FROM team_season
),
num_teams AS (SELECT COUNT(*) AS n FROM team_season),

-- Step 3: Team ratings
team_ratings AS (
    SELECT ts.team_id,
        (CAST(ts.pts_for AS REAL) / NULLIF(ts.i50_for, 0))
            / la.avg_pts_per_i50                    AS off_rating,
        CAST(ts.i50_for AS REAL)
            / NULLIF(ts.i50_against, 0)             AS mid_rating,
        (CAST(ts.pts_against AS REAL) / NULLIF(ts.i50_against, 0))
            / la.avg_pts_per_i50                    AS dn
    FROM team_season ts
    CROSS JOIN league_avg la
),

-- Step 4: Apply defence transform
team_ratings_full AS (
    SELECT team_id, off_rating, mid_rating, dn,
        (100.0 * ((2.0 * dn - dn * dn)
            / NULLIF(2.0 * dn, 0))) * 2.0          AS def_rating
    FROM team_ratings
),

-- Step 5: Distribute PAVs proportionally
league_totals AS (
    SELECT SUM(off_rating) AS tot_off,
           SUM(mid_rating) AS tot_mid,
           SUM(def_rating) AS tot_def
    FROM team_ratings_full
),
team_pavs AS (
    SELECT trf.team_id,
        (trf.off_rating / NULLIF(lt.tot_off, 0))
            * (nt.n * 100) AS team_off_pavs,
        (trf.mid_rating / NULLIF(lt.tot_mid, 0))
            * (nt.n * 100) AS team_mid_pavs,
        (trf.def_rating / NULLIF(lt.tot_def, 0))
            * (nt.n * 100) AS team_def_pavs
    FROM team_ratings_full trf
    CROSS JOIN league_totals lt
    CROSS JOIN num_teams nt
),

-- Step 6: Player per-match raw scores
player_match AS (
    SELECT pms.player_id, pms.team_id, pms.match_id,
        (COALESCE(pms.goals, 0) * 6
            + COALESCE(pms.behinds, 0))             AS player_points,
        COALESCE(pms.hitouts, 0)                     AS hitouts,
        COALESCE(pms.goal_assists, 0)                AS goal_assists,
        COALESCE(pms.inside_fifties, 0)              AS inside_fifties,
        COALESCE(pms.marks_inside_fifty, 0)          AS marks_inside_fifty,
        COALESCE(pms.free_kicks_for, 0)              AS fk_for,
        COALESCE(pms.free_kicks_against, 0)          AS fk_against,
        COALESCE(pms.rebounds, 0)                     AS rebounds,
        COALESCE(pms.one_percenters, 0)              AS one_percenters,
        COALESCE(pms.marks, 0)                        AS marks,
        COALESCE(pms.clearances, 0)                   AS clearances,
        COALESCE(pms.tackles, 0)                      AS tackles
    FROM player_match_stats pms
    JOIN matches m ON pms.match_id = m.id
    JOIN target_season ts ON m.season_id = ts.season_id
    WHERE m.home_points IS NOT NULL
),

-- Step 7: Aggregate player scores per season
player_scores AS (
    SELECT player_id, team_id,
        SUM(player_points + 0.25 * hitouts
            + 3.0 * goal_assists + inside_fifties
            + marks_inside_fifty
            + (fk_for - fk_against))                AS off_score,
        SUM(20.0 * rebounds + 12.0 * one_percenters
            + (marks - 4.0 * marks_inside_fifty
            + 2.0 * (fk_for - fk_against))
            - (2.0 / 3.0) * hitouts)                AS def_score,
        SUM(15.0 * inside_fifties
            + 20.0 * clearances + 3.0 * tackles
            + 1.5 * hitouts
            + (fk_for - fk_against))                AS mid_score
    FROM player_match
    GROUP BY player_id, team_id
),

-- Step 8: Team total raw scores
team_scores AS (
    SELECT team_id,
        SUM(off_score) AS team_off_score,
        SUM(def_score) AS team_def_score,
        SUM(mid_score) AS team_mid_score
    FROM player_scores
    GROUP BY team_id
),

-- Step 9: Final player PAV
player_pavs AS (
    SELECT ps.player_id, ps.team_id,
        (ps.off_score / NULLIF(ts.team_off_score, 0))
            * tp.team_off_pavs                      AS off_pav,
        (ps.def_score / NULLIF(ts.team_def_score, 0))
            * tp.team_def_pavs                      AS def_pav,
        (ps.mid_score / NULLIF(ts.team_mid_score, 0))
            * tp.team_mid_pavs                      AS mid_pav
    FROM player_scores ps
    JOIN team_scores ts ON ps.team_id = ts.team_id
    JOIN team_pavs tp ON ps.team_id = tp.team_id
)

SELECT
    pp.player_id,
    ts.season_id,
    pp.team_id,
    ROUND(pp.off_pav, 2) AS off_pav,
    ROUND(pp.mid_pav, 2) AS mid_pav,
    ROUND(pp.def_pav, 2) AS def_pav,
    ROUND(pp.off_pav + pp.mid_pav + pp.def_pav, 2) AS total_pav
FROM player_pavs pp
CROSS JOIN target_season ts
`;

const PAV_UPSERT_SQL = `
INSERT INTO player_season_pav
    (player_id, season_id, team_id, off_pav, mid_pav, def_pav, total_pav)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (player_id, season_id, team_id) DO UPDATE SET
    off_pav   = EXCLUDED.off_pav,
    mid_pav   = EXCLUDED.mid_pav,
    def_pav   = EXCLUDED.def_pav,
    total_pav = EXCLUDED.total_pav
`;

interface PavRow {
  player_id: number;
  season_id: number;
  team_id: number;
  off_pav: number;
  mid_pav: number;
  def_pav: number;
  total_pav: number;
}

export async function calculatePav(env: Env, year: number): Promise<number> {
  if (year < MIN_PAV_YEAR) {
    throw new Error(
      `PAV requires inside 50s data (available from ${MIN_PAV_YEAR}). Year ${year} is not supported.`,
    );
  }

  const { results } = await env.DB.prepare(PAV_SELECT_SQL).bind(year).all<PavRow>();

  if (results.length === 0) return 0;

  let totalAffected = 0;
  for (let i = 0; i < results.length; i += 500) {
    const chunk = results.slice(i, i + 500);
    const stmts = chunk.map((row) =>
      env.DB.prepare(PAV_UPSERT_SQL).bind(
        row.player_id,
        row.season_id,
        row.team_id,
        row.off_pav,
        row.mid_pav,
        row.def_pav,
        row.total_pav,
      ),
    );
    const batchResults = await env.DB.batch(stmts);
    totalAffected += batchResults.filter((r) => r.success).length;
  }

  return totalAffected;
}

export async function recalculatePav(env: Env): Promise<void> {
  const currentYear = new Date().getFullYear();
  try {
    const changes = await calculatePav(env, currentYear);
    await logSync(env, "pav_recalculation", changes);
  } catch (err) {
    await logSync(env, "pav_recalculation", 0, err instanceof Error ? err.message : String(err));
  }
}

export async function calculateAllPav(env: Env): Promise<Record<number, number>> {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT s.year FROM seasons s
     JOIN competitions c ON s.competition_id = c.id
     WHERE c.code = 'AFLM' AND s.year >= ?
     ORDER BY s.year`,
  )
    .bind(MIN_PAV_YEAR)
    .all<{ year: number }>();

  const resultMap: Record<number, number> = {};
  for (const row of results) {
    resultMap[row.year] = await calculatePav(env, row.year);
  }
  return resultMap;
}
