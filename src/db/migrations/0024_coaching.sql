-- Coaching is additive so the prior Worker remains compatible during GitOps.
CREATE TABLE coaches (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  profile_url TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE coach_external_ids (
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  external_coach_id TEXT NOT NULL,
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  display_name TEXT NOT NULL,
  profile_url TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1)),
  PRIMARY KEY (provider, external_coach_id)
);

CREATE TABLE coach_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  external_coach_id TEXT NOT NULL,
  external_match_id TEXT NOT NULL,
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  match_id INTEGER REFERENCES matches(id),
  team_id INTEGER REFERENCES teams(id),
  season INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  match_date TEXT,
  display_name TEXT NOT NULL,
  raw_team TEXT NOT NULL,
  home_points INTEGER,
  away_points INTEGER,
  UNIQUE (provider, external_coach_id, external_match_id, raw_team)
);
CREATE INDEX idx_coach_observations_match ON coach_observations(match_id, provider);
CREATE INDEX idx_coach_observations_season ON coach_observations(season, provider);

CREATE TABLE coach_external_match_ids (
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  external_match_id TEXT NOT NULL,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  PRIMARY KEY (provider, external_match_id)
);

CREATE TABLE match_coaches (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  team_id INTEGER NOT NULL REFERENCES teams(id),
  coach_id TEXT NOT NULL REFERENCES coaches(id),
  observation_id INTEGER NOT NULL REFERENCES coach_observations(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (match_id, team_id)
);
CREATE INDEX idx_match_coaches_coach ON match_coaches(coach_id, match_id);

CREATE TABLE coach_import_pages (
  provider TEXT NOT NULL,
  season INTEGER NOT NULL,
  scope TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  last_checked_at TEXT NOT NULL,
  last_success_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (provider, season, scope)
);

CREATE TABLE coach_import_diagnostics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  season INTEGER NOT NULL,
  scope TEXT NOT NULL,
  source_url TEXT,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX idx_coach_diagnostics_open ON coach_import_diagnostics(provider, season, resolved_at);
CREATE UNIQUE INDEX idx_coach_diagnostics_scope_source ON coach_import_diagnostics(provider, season, scope, source_url);

-- Monotonic marker for native publisher snapshots. Operational observations
-- and secondary-source evidence never affect public ELO input revisions.
CREATE TABLE public_input_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0,
  in_progress INTEGER NOT NULL DEFAULT 0 CHECK (in_progress IN (0, 1)),
  write_started_at TEXT
);
INSERT INTO public_input_revision (id, revision) VALUES (1, 0);

CREATE TRIGGER public_input_matches_insert AFTER INSERT ON matches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_matches_delete AFTER DELETE ON matches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_matches_update AFTER UPDATE OF
  season_id, round, round_abbreviation, round_number, round_type, date, status, local_time,
  home_team_id, away_team_id, home_goals, home_behinds, home_points,
  away_goals, away_behinds, away_points, margin
ON matches WHEN
  OLD.season_id IS NOT NEW.season_id OR OLD.round IS NOT NEW.round OR
  OLD.round_abbreviation IS NOT NEW.round_abbreviation OR OLD.round_number IS NOT NEW.round_number OR
  OLD.round_type IS NOT NEW.round_type OR OLD.date IS NOT NEW.date OR
  OLD.status IS NOT NEW.status OR OLD.local_time IS NOT NEW.local_time OR
  OLD.home_team_id IS NOT NEW.home_team_id OR OLD.away_team_id IS NOT NEW.away_team_id OR
  OLD.home_goals IS NOT NEW.home_goals OR OLD.home_behinds IS NOT NEW.home_behinds OR
  OLD.home_points IS NOT NEW.home_points OR OLD.away_goals IS NOT NEW.away_goals OR
  OLD.away_behinds IS NOT NEW.away_behinds OR OLD.away_points IS NOT NEW.away_points OR
  OLD.margin IS NOT NEW.margin
BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_team_update AFTER UPDATE OF name, competition_id ON teams
WHEN OLD.name IS NOT NEW.name OR OLD.competition_id IS NOT NEW.competition_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_coaches_insert AFTER INSERT ON match_coaches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_coaches_delete AFTER DELETE ON match_coaches BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_coaches_update AFTER UPDATE OF coach_id, observation_id ON match_coaches
WHEN OLD.coach_id IS NOT NEW.coach_id OR OLD.observation_id IS NOT NEW.observation_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_coach_name_update AFTER UPDATE OF display_name ON coaches
WHEN OLD.display_name IS NOT NEW.display_name AND EXISTS (
  SELECT 1 FROM match_coaches WHERE coach_id = NEW.id
) BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER public_input_season_update AFTER UPDATE OF year, competition_id ON seasons
WHEN OLD.year IS NOT NEW.year OR OLD.competition_id IS NOT NEW.competition_id BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_competition_update AFTER UPDATE OF code ON competitions
WHEN OLD.code IS NOT NEW.code BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;
CREATE TRIGGER public_input_observation_url_update AFTER UPDATE OF source_url ON coach_observations
WHEN OLD.source_url IS NOT NEW.source_url AND EXISTS (
  SELECT 1 FROM match_coaches WHERE observation_id = NEW.id
) BEGIN
  UPDATE public_input_revision SET revision = revision + 1 WHERE id = 1;
END;

-- Bounded profile fetches retain their season evidence until final reconciliation.
CREATE TABLE coach_backfill_progress (
  provider TEXT NOT NULL CHECK (provider IN ('afl-tables', 'footywire')),
  season INTEGER NOT NULL,
  cursor TEXT,
  assignments_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, season)
);
