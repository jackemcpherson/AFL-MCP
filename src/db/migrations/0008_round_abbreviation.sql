-- Add the AFL API's canonical round.abbreviation alongside the existing
-- long-form round name. Mirrors R fitzRoy (which exposes both round.name
-- and round.abbreviation); useful for compact display and stable
-- cross-competition filtering.
--
-- Values follow the AFL API's own short codes:
--   "OR"   = Opening Round (AFLM 2024+ only)
--   "Rd N" = Regular round N (all competitions)
--   "WC"   = Wildcard round (VFL only)
--   "FW1"  = Finals Week 1
--   "SF"   = Semi Finals
--   "PF"   = Preliminary Finals
--   "GF"   = Grand Final
--
-- Existing rows get NULL on the column add; the next sync upserts will
-- backfill them in place via the matches UPSERT WHERE predicate (which
-- already triggers on round-related changes).

ALTER TABLE matches ADD COLUMN round_abbreviation TEXT;
