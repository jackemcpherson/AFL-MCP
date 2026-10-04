CREATE TABLE player_provider_ids (
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  player_id INTEGER NOT NULL REFERENCES players(id),
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(provider, provider_id)
);
INSERT INTO player_provider_ids(provider, provider_id, player_id, evidence_json)
SELECT 'afl-api', external_afl_player_id, id, '{"kind":"existing-provider-key"}'
FROM players WHERE external_afl_player_id IS NOT NULL;
CREATE TABLE player_id_redirects (
  retired_id INTEGER PRIMARY KEY REFERENCES players(id),
  canonical_id INTEGER NOT NULL REFERENCES players(id),
  manifest_digest TEXT NOT NULL,
  CHECK(retired_id > canonical_id)
);
CREATE TABLE identity_repair_operations (
  manifest_digest TEXT PRIMARY KEY,
  canonical_id INTEGER NOT NULL REFERENCES players(id),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  status TEXT NOT NULL CHECK(status IN ('prepared','reparented','complete')),
  applied_at TEXT NOT NULL
);
CREATE TABLE pav_rebuild_queue (
  season_id INTEGER PRIMARY KEY REFERENCES seasons(id) ON DELETE CASCADE,
  reason TEXT NOT NULL
);
