-- A season is complete when it has matches and none is unsettled. A cancelled
-- match has no score, so the earlier "every match has home_points" rule held
-- AFLM 2015, VFL 2021 and VFLW 2021 open forever.
UPDATE seasons SET is_complete = CASE
  WHEN EXISTS (SELECT 1 FROM matches m WHERE m.season_id = seasons.id)
   AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.season_id = seasons.id
     AND (m.status IS NULL OR m.status NOT IN ('Complete', 'Cancelled')))
  THEN 1 ELSE 0 END;

-- An operator-queued historical match is a one-off request: once fetched it
-- has no follow-up schedule. Earlier Workers left such rows due forever,
-- although only an operator could ever run them.
UPDATE match_stats_refresh SET next_retry_at = NULL
WHERE origin = 'operator' AND succeeded_at IS NOT NULL AND failures = 0
  AND match_id IN (
    SELECT m.id FROM matches m
    WHERE julianday(match_stats_refresh.completed_observed_at) - julianday(m.date) > 31
  );
