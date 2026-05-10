-- Drop unused venue rows. Source: 2026-05-10 data quality review (P2 #12).
--
-- These seven rows have zero matches referencing them. They duplicate
-- venues that ARE referenced under their historical or alternate names:
--   - Ikon Park             ← duplicate of Princes Park
--   - TIO Traeger Park      ← duplicate of Traeger Park
--   - WACA                  ← never used; West Coast home games 1987–1999
--                              are likely tagged Subiaco
--   - Whitten Oval          ← never used; Western Oval is the historical name
--   - GIO Stadium           ← never used; GWS home games are at Manuka Oval
--                              or Sydney Showground
--   - UNSW Canberra Oval    ← never used; 2017–2018 GWS games are at Manuka Oval
--   - Adelaide Hills        ← never used; preseason/community venue
--
-- VENUE_NAME_MAP in src/lib/constants.ts now aliases "Ikon Park" → "Princes Park"
-- so the sync upsert won't recreate the row. The other six don't appear in
-- fitzroy's afl-api source for any played match, so re-creation is unlikely.
--
-- The NOT EXISTS guard makes this safe and idempotent — only deletes rows
-- that no match references, regardless of which IDs the venues happen to have.

DELETE FROM venues
WHERE name IN (
  'Ikon Park',
  'TIO Traeger Park',
  'WACA',
  'Whitten Oval',
  'GIO Stadium',
  'UNSW Canberra Oval',
  'Adelaide Hills'
)
AND NOT EXISTS (SELECT 1 FROM matches WHERE matches.venue_id = venues.id);
