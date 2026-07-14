-- Match predictions from the tipper model (#140).
--
-- Additive and expand-contract safe: the previous Worker never reads
-- match_predictions, so the GitOps pipeline can apply this migration
-- before the new Worker ships.
--
-- One row per match, overwritten on regeneration (same overwrite-in-place
-- semantics as match_weather forecasts). Written by tipper via the D1 REST
-- API (tipper#28); this Worker only reads it.

CREATE TABLE match_predictions (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  home_win_prob REAL NOT NULL,        -- 0..1, home team's win probability
  predicted_margin REAL NOT NULL,     -- positive = home favoured, one decimal
  model_version TEXT NOT NULL,        -- tipper config id, e.g. 'predha-080 (2641f46f)'
  generated_at TEXT NOT NULL,
  PRIMARY KEY (match_id)
);
