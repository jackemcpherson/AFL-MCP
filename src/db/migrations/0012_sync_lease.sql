-- Single-row lease giving cron ticks and admin syncs cheap mutual
-- exclusion (COR-11). Overlapping runs double-fetched upstream data and
-- interleaved PAV recalcs; idempotent upserts made corruption unlikely
-- but the waste and duplicate sync_log rows were real.
CREATE TABLE sync_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  holder TEXT,
  acquired_at TEXT
);

INSERT INTO sync_lease (id, holder, acquired_at) VALUES (1, NULL, NULL);
