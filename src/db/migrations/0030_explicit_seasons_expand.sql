-- Expand only. Keep competition/year uniqueness until every consumer is upgraded.
ALTER TABLE seasons ADD COLUMN season_key TEXT;
ALTER TABLE seasons ADD COLUMN display_name TEXT;
UPDATE seasons SET season_key = CASE
  WHEN year = 2022 AND competition_id = (SELECT id FROM competitions WHERE code = 'AFLW')
    THEN '2022-S6' ELSE CAST(year AS TEXT) END;
CREATE UNIQUE INDEX idx_seasons_competition_key ON seasons(competition_id, season_key);
CREATE TABLE season_provider_ids (
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  provider TEXT NOT NULL,
  provider_season_id TEXT NOT NULL,
  PRIMARY KEY (provider, provider_season_id),
  UNIQUE (season_id, provider)
);
INSERT INTO season_provider_ids (season_id, provider, provider_season_id)
SELECT s.id, 'afl-api', '41' FROM seasons s JOIN competitions c ON c.id = s.competition_id
WHERE c.code = 'AFLW' AND s.season_key = '2022-S6';
CREATE TRIGGER seasons_legacy_key AFTER INSERT ON seasons WHEN NEW.season_key IS NULL BEGIN
  UPDATE seasons SET season_key = CASE
    WHEN NEW.year = 2022 AND NEW.competition_id = (SELECT id FROM competitions WHERE code = 'AFLW')
      THEN '2022-S6' ELSE CAST(NEW.year AS TEXT) END WHERE id = NEW.id;
END;
