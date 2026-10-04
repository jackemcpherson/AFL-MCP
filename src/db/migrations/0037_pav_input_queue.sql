CREATE TRIGGER pav_stats_insert AFTER INSERT ON player_match_stats
BEGIN
  INSERT INTO pav_rebuild_queue(season_id, reason)
  SELECT s.id, 'statistics' FROM matches m JOIN seasons s ON s.id=m.season_id
  JOIN competitions c ON c.id=s.competition_id WHERE m.id=NEW.match_id
  AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;

CREATE TRIGGER pav_stats_update AFTER UPDATE ON player_match_stats
WHEN OLD.match_id IS NOT NEW.match_id OR OLD.player_id IS NOT NEW.player_id OR OLD.team_id IS NOT NEW.team_id OR OLD.goals IS NOT NEW.goals OR OLD.behinds IS NOT NEW.behinds OR OLD.hitouts IS NOT NEW.hitouts OR OLD.goal_assists IS NOT NEW.goal_assists OR OLD.inside_fifties IS NOT NEW.inside_fifties OR OLD.marks_inside_fifty IS NOT NEW.marks_inside_fifty OR OLD.free_kicks_for IS NOT NEW.free_kicks_for OR OLD.free_kicks_against IS NOT NEW.free_kicks_against OR OLD.rebounds IS NOT NEW.rebounds OR OLD.one_percenters IS NOT NEW.one_percenters OR OLD.marks IS NOT NEW.marks OR OLD.clearances IS NOT NEW.clearances OR OLD.tackles IS NOT NEW.tackles OR OLD.time_on_ground_pct IS NOT NEW.time_on_ground_pct OR OLD.disposals IS NOT NEW.disposals
BEGIN
  INSERT INTO pav_rebuild_queue(season_id, reason)
  SELECT s.id, 'statistics' FROM matches m JOIN seasons s ON s.id=m.season_id
  JOIN competitions c ON c.id=s.competition_id WHERE m.id=OLD.match_id
  AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
  INSERT INTO pav_rebuild_queue(season_id, reason)
  SELECT s.id, 'statistics' FROM matches m JOIN seasons s ON s.id=m.season_id
  JOIN competitions c ON c.id=s.competition_id WHERE m.id=NEW.match_id
  AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;

CREATE TRIGGER pav_stats_delete AFTER DELETE ON player_match_stats
BEGIN
  INSERT INTO pav_rebuild_queue(season_id, reason)
  SELECT s.id, 'statistics' FROM matches m JOIN seasons s ON s.id=m.season_id
  JOIN competitions c ON c.id=s.competition_id WHERE m.id=OLD.match_id
  AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;

CREATE TRIGGER pav_matches_update AFTER UPDATE OF season_id,home_team_id,away_team_id,home_points,away_points,status ON matches
WHEN OLD.season_id IS NOT NEW.season_id OR OLD.home_team_id IS NOT NEW.home_team_id
 OR OLD.away_team_id IS NOT NEW.away_team_id OR OLD.home_points IS NOT NEW.home_points
 OR OLD.away_points IS NOT NEW.away_points OR OLD.status IS NOT NEW.status
BEGIN
  INSERT INTO pav_rebuild_queue(season_id,reason)
  SELECT s.id,'statistics' FROM seasons s JOIN competitions c ON c.id=s.competition_id
  WHERE s.id IN (OLD.season_id,NEW.season_id)
    AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;

CREATE TRIGGER pav_matches_delete AFTER DELETE ON matches
BEGIN
  INSERT INTO pav_rebuild_queue(season_id,reason)
  SELECT s.id,'statistics' FROM seasons s JOIN competitions c ON c.id=s.competition_id
  WHERE s.id=OLD.season_id
    AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;


CREATE TRIGGER pav_matches_insert AFTER INSERT ON matches
WHEN NEW.status='Complete' OR NEW.status IS NULL
BEGIN
  INSERT INTO pav_rebuild_queue(season_id,reason)
  SELECT s.id,'statistics' FROM seasons s JOIN competitions c ON c.id=s.competition_id
  WHERE s.id=NEW.season_id
    AND ((c.code='AFLM' AND s.year>=1998) OR (c.code='AFLW' AND s.year>=2017))
  ON CONFLICT(season_id) DO NOTHING;
END;
