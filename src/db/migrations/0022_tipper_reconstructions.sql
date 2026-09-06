-- Historical reconstructions are separate from prospectively issued tips.
CREATE TABLE tipper_reconstruction_batches (
  id TEXT PRIMARY KEY,
  season INTEGER NOT NULL CHECK (season = 2026),
  model_version TEXT NOT NULL,
  source_revision TEXT NOT NULL CHECK (length(source_revision) = 40),
  policy TEXT NOT NULL,
  extracted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expected_count INTEGER NOT NULL CHECK (expected_count > 0),
  completed_at TEXT,
  manifest TEXT NOT NULL CHECK (json_valid(manifest))
);
CREATE TABLE tipper_reconstructions (
  batch_id TEXT NOT NULL REFERENCES tipper_reconstruction_batches(id),
  match_id INTEGER NOT NULL REFERENCES matches(id),
  competition TEXT NOT NULL CHECK (competition IN ('AFLM', 'AFLW')),
  round_number INTEGER NOT NULL,
  cutoff_at TEXT NOT NULL,
  kickoff_at TEXT NOT NULL,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  margin REAL NOT NULL,
  home_probability REAL NOT NULL CHECK (home_probability BETWEEN .01 AND .99),
  winner TEXT NOT NULL CHECK (winner IN ('home', 'away')),
  issued_margin REAL NOT NULL,
  issued_probability REAL NOT NULL CHECK (issued_probability BETWEEN .01 AND .99),
  provisional INTEGER NOT NULL CHECK (provisional IN (0, 1)),
  evidence TEXT NOT NULL CHECK (json_valid(evidence)),
  PRIMARY KEY (batch_id, match_id),
  CHECK (cutoff_at < kickoff_at),
  CHECK (home_team_id != away_team_id),
  CHECK ((margin >= 0 AND winner = 'home') OR (margin < 0 AND winner = 'away'))
);
CREATE INDEX tipper_reconstructions_match ON tipper_reconstructions(match_id, batch_id);
CREATE TRIGGER tipper_reconstruction_finalize
BEFORE UPDATE OF completed_at ON tipper_reconstruction_batches
WHEN NEW.completed_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'incomplete reconstruction batch')
  WHERE (SELECT COUNT(*) FROM tipper_reconstructions WHERE batch_id = NEW.id)
    != NEW.expected_count;
END;
CREATE TRIGGER tipper_reconstruction_closed
BEFORE INSERT ON tipper_reconstructions
WHEN (SELECT completed_at FROM tipper_reconstruction_batches WHERE id = NEW.batch_id)
  IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reconstruction batch already completed');
END;
