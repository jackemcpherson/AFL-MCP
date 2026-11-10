-- PAV reads played matches only. Live score updates on unplayed matches
-- queued a full season rebuild on every five-minute tick. Queue a season only
-- when the row was or becomes played. An older Worker sees fewer queue rows,
-- none of which could change its PAV output.
DROP TRIGGER IF EXISTS pav_matches_update;
CREATE TRIGGER pav_matches_update AFTER UPDATE OF season_id,home_team_id,away_team_id,home_points,away_points,status ON matches
WHEN (OLD.status = 'Complete' OR NEW.status = 'Complete') AND (
 OLD.season_id IS NOT NEW.season_id OR OLD.home_team_id IS NOT NEW.home_team_id
 OR OLD.away_team_id IS NOT NEW.away_team_id OR OLD.home_points IS NOT NEW.home_points
 OR OLD.away_points IS NOT NEW.away_points OR OLD.status IS NOT NEW.status)
BEGIN
  INSERT INTO pav_rebuild_queue(season_id,reason)
  SELECT s.id,'statistics' FROM seasons s JOIN competitions c ON c.id=s.competition_id
  WHERE s.id IN (OLD.season_id,NEW.season_id)
    AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;
