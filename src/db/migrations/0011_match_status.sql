-- Capture match lifecycle and live period state on the matches table.
--
-- Previously, the upsert dropped `Match.status` from fitzroy entirely —
-- consumers had to infer lifecycle from whether home_points was non-null
-- (and could not distinguish Upcoming/Live/Postponed/Cancelled from
-- a not-yet-played match). `status` makes that explicit.
--
-- `live_period_status` is the raw AFL API score-level status string
-- (CfsScore.status, surfaced by fitzroy 2.3.0 as Match.livePeriodStatus).
-- It carries the per-period siren signal during a live match — observed
-- values include LIVE, QTR_TIME, HALF_TIME, 3QTR_TIME, FULL_TIME — and
-- is the field consumers should watch when polling for quarter-end
-- transitions. NULL pre-match and for any source that doesn't expose
-- a per-period state (every non-afl-api source).
--
-- Both columns get NULL on the column add; the next sync upserts will
-- backfill them in place via the existing matches UPSERT WHERE predicate
-- (after the predicate is extended to trigger on these columns too).

ALTER TABLE matches ADD COLUMN status TEXT;
ALTER TABLE matches ADD COLUMN live_period_status TEXT;
