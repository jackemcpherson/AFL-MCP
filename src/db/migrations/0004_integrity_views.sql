-- Integrity-check views for ongoing data quality monitoring.
-- Source: 2026-05-10 data quality review (Rec #2).
--
-- Each view is a SELECT from base tables that returns ONE row per violation.
-- An empty result set means the invariant holds. Use these to detect drift
-- after schema changes, ingestion changes, or upstream-source updates.

-- disposals must equal kicks + handballs (when all three are non-null)
CREATE VIEW v_integrity_disposals AS
SELECT pms.id AS row_id, pms.match_id, pms.player_id, pms.kicks, pms.handballs, pms.disposals
FROM player_match_stats pms
WHERE pms.kicks IS NOT NULL
  AND pms.handballs IS NOT NULL
  AND pms.disposals IS NOT NULL
  AND pms.disposals != pms.kicks + pms.handballs;

-- home_points must equal home_goals * 6 + home_behinds (and same for away)
CREATE VIEW v_integrity_match_points AS
SELECT m.id AS match_id,
       m.home_goals, m.home_behinds, m.home_points,
       m.away_goals, m.away_behinds, m.away_points
FROM matches m
WHERE (
  m.home_points IS NOT NULL
  AND m.home_goals IS NOT NULL
  AND m.home_behinds IS NOT NULL
  AND m.home_points != m.home_goals * 6 + m.home_behinds
) OR (
  m.away_points IS NOT NULL
  AND m.away_goals IS NOT NULL
  AND m.away_behinds IS NOT NULL
  AND m.away_points != m.away_goals * 6 + m.away_behinds
);

-- Per-quarter scores must sum to match totals (when quarters are populated)
CREATE VIEW v_integrity_quarter_scores AS
SELECT m.id AS match_id
FROM matches m
WHERE m.home_q1_goals IS NOT NULL AND (
  m.home_goals != m.home_q1_goals + m.home_q2_goals + m.home_q3_goals + m.home_q4_goals
  OR m.home_behinds != m.home_q1_behinds + m.home_q2_behinds + m.home_q3_behinds + m.home_q4_behinds
  OR m.away_goals != m.away_q1_goals + m.away_q2_goals + m.away_q3_goals + m.away_q4_goals
  OR m.away_behinds != m.away_q1_behinds + m.away_q2_behinds + m.away_q3_behinds + m.away_q4_behinds
);

-- margin is signed home-perspective: margin = home_points - away_points
CREATE VIEW v_integrity_margin AS
SELECT m.id AS match_id, m.home_points, m.away_points, m.margin
FROM matches m
WHERE m.margin IS NOT NULL
  AND m.home_points IS NOT NULL
  AND m.away_points IS NOT NULL
  AND m.margin != m.home_points - m.away_points;

-- Brownlow votes per regular-season match must be either 0 (not yet awarded)
-- or 6 (3-2-1 awarded). Anything else indicates a partial load.
CREATE VIEW v_integrity_brownlow AS
SELECT m.id AS match_id, m.date, m.round, x.total
FROM matches m
JOIN (
  SELECT pms.match_id, SUM(pms.brownlow_votes) AS total
  FROM player_match_stats pms
  GROUP BY pms.match_id
) x ON x.match_id = m.id
WHERE m.round_type = 'Regular'
  AND x.total > 0
  AND x.total != 6;
