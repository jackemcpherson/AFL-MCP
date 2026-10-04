-- Compatible MCP 4, Tipper 4 and footyBot 0.12 readers are deployed.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE season_contract_backup AS SELECT * FROM seasons;
CREATE TABLE season_sequence_backup AS SELECT seq FROM sqlite_sequence WHERE name='seasons';
CREATE TABLE season_pav_queue_backup AS SELECT * FROM pav_rebuild_queue;
DROP TABLE seasons;
CREATE TABLE seasons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  competition_id INTEGER NOT NULL REFERENCES competitions(id),
  year INTEGER NOT NULL,
  is_complete INTEGER NOT NULL DEFAULT 0,
  season_key TEXT NOT NULL,
  display_name TEXT,
  CHECK(season_key=CAST(year AS TEXT) OR (year=2022 AND season_key IN ('2022-S6','2022-S7')))
);
CREATE UNIQUE INDEX idx_seasons_competition_key ON seasons(competition_id,season_key);
INSERT INTO seasons(id,competition_id,year,is_complete,season_key,display_name)
SELECT id,competition_id,year,is_complete,season_key,display_name FROM season_contract_backup;
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM season_sequence_backup),0)) WHERE name='seasons';
INSERT INTO pav_rebuild_queue SELECT * FROM season_pav_queue_backup;
DROP TABLE season_pav_queue_backup;
DROP TABLE season_sequence_backup;
DROP TABLE season_contract_backup;
CREATE TRIGGER seasons_explicit_key_insert BEFORE INSERT ON seasons
WHEN (NEW.year=2022 AND NEW.competition_id=(SELECT id FROM competitions WHERE code='AFLW') AND NEW.season_key='2022')
  OR (NEW.season_key IN ('2022-S6','2022-S7') AND NEW.competition_id<>(SELECT id FROM competitions WHERE code='AFLW'))
BEGIN SELECT RAISE(ABORT,'Ambiguous or invalid competition season key'); END;
CREATE TRIGGER seasons_explicit_key_update BEFORE UPDATE OF competition_id,year,season_key ON seasons
WHEN (NEW.year=2022 AND NEW.competition_id=(SELECT id FROM competitions WHERE code='AFLW') AND NEW.season_key='2022')
  OR (NEW.season_key IN ('2022-S6','2022-S7') AND NEW.competition_id<>(SELECT id FROM competitions WHERE code='AFLW'))
BEGIN SELECT RAISE(ABORT,'Ambiguous or invalid competition season key'); END;
CREATE TRIGGER public_input_season_update AFTER UPDATE OF year,competition_id,season_key ON seasons
WHEN OLD.year IS NOT NEW.year OR OLD.competition_id IS NOT NEW.competition_id OR OLD.season_key IS NOT NEW.season_key BEGIN
  UPDATE public_input_revision SET revision=revision+1 WHERE id=1;
END;
UPDATE public_input_revision SET revision=revision+1 WHERE id=1;
