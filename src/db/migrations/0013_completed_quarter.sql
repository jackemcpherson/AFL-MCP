ALTER TABLE matches ADD COLUMN completed_quarter INTEGER
  CHECK (completed_quarter IS NULL OR completed_quarter BETWEEN 0 AND 4);
