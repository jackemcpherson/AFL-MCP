-- Backfill matches.status for rows that predate status tracking (v3.3.0 /
-- migration 0011 added the column; only 2026-era rows were ever populated).
--
-- Before this migration 8,846 played matches had status NULL, so filtering
-- on status = 'Complete' silently dropped all pre-2026 history — an easy
-- trap for LLM-written queries. The 38 unscored VFL/VFLW 2021 matches are
-- the COVID-era cancellations (37 VFL, 1 VFLW); they become 'Cancelled' so
-- absence of scores is distinguishable from missing data.
--
-- The sync upsert COALESCEs status, so a NULL from a historical backfill
-- source never clobbers these values. Both UPDATEs are idempotent.

UPDATE matches
SET status = 'Complete'
WHERE status IS NULL
  AND home_points IS NOT NULL;

UPDATE matches
SET status = 'Cancelled'
WHERE status IS NULL
  AND home_points IS NULL
  AND date < '2022-01-01';
