-- A cached model window cannot survive a changed kickoff or physical venue.
CREATE TRIGGER weather_matches_context_update AFTER UPDATE OF date,local_time,kickoff_at,venue_id ON matches
WHEN OLD.date IS NOT NEW.date OR OLD.local_time IS NOT NEW.local_time
 OR OLD.kickoff_at IS NOT NEW.kickoff_at OR OLD.venue_id IS NOT NEW.venue_id
BEGIN
  DELETE FROM match_weather WHERE match_id=NEW.id;
  DELETE FROM weather_refresh_state WHERE match_id=NEW.id;
END;

CREATE TRIGGER weather_venues_context_update AFTER UPDATE OF latitude,longitude,timezone,canonical_venue_id ON venues
WHEN OLD.latitude IS NOT NEW.latitude OR OLD.longitude IS NOT NEW.longitude
 OR OLD.timezone IS NOT NEW.timezone OR OLD.canonical_venue_id IS NOT NEW.canonical_venue_id
BEGIN
  DELETE FROM match_weather WHERE match_id IN (
    SELECT id FROM matches WHERE venue_id IN (
      SELECT id FROM venues WHERE id=NEW.id OR canonical_venue_id=NEW.id
    )
  );
  DELETE FROM weather_refresh_state WHERE match_id IN (
    SELECT id FROM matches WHERE venue_id IN (
      SELECT id FROM venues WHERE id=NEW.id OR canonical_venue_id=NEW.id
    )
  );
END;
