-- Collapse players.is_retired to a strict 0/1 flag.
--
-- 525 rows carried NULL from the original PostgreSQL import, giving the
-- column three states (NULL/0/1) that the schema documented as a boolean.
-- No sync path writes the column, so a one-off backfill is sufficient;
-- the DEFAULT 0 in the schema covers new rows. Idempotent.

UPDATE players SET is_retired = 0 WHERE is_retired IS NULL;
