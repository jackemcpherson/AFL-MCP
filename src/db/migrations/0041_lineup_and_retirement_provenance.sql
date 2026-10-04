-- Interchange is a bench position, not the provider's dedicated SUB role.
UPDATE match_lineups SET is_substitute=0 WHERE position='INT' AND is_substitute=1;

-- Preserve imported/defaulted flags without presenting them as sourced facts.
ALTER TABLE players RENAME COLUMN is_retired TO legacy_is_retired;
ALTER TABLE players ADD COLUMN is_retired INTEGER DEFAULT NULL CHECK(is_retired IN (0,1));
DROP TRIGGER public_input_players_update;
CREATE TRIGGER public_input_players_update AFTER UPDATE ON players
WHEN OLD.first_name IS NOT NEW.first_name OR OLD.surname IS NOT NEW.surname OR OLD.external_id IS NOT NEW.external_id OR OLD.external_afl_player_id IS NOT NEW.external_afl_player_id OR OLD.date_of_birth IS NOT NEW.date_of_birth OR OLD.height_cm IS NOT NEW.height_cm OR OLD.weight_kg IS NOT NEW.weight_kg OR OLD.legacy_is_retired IS NOT NEW.legacy_is_retired OR OLD.is_retired IS NOT NEW.is_retired BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
