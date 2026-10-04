ALTER TABLE tipper_runs ADD COLUMN season_key TEXT;
UPDATE tipper_runs SET season_key = (
  SELECT s.season_key FROM tipper_predictions p JOIN seasons s ON s.id = p.season_id
  WHERE p.run_id = tipper_runs.id LIMIT 1
);
