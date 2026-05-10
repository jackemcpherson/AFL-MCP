-- Team data hygiene: drop phantom Gold Coast Suns row + populate abbreviations.
-- Source: 2026-05-10 data quality review (P2 #10, P2 #18).

-- Phantom row: id=261 ("Gold Coast Suns") has zero matches/stats/lineups/PAV
-- references (verified). Real Gold Coast is id=17. The TEAM_NAME_MAP in
-- src/lib/constants.ts already aliases "Gold Coast Suns" → "Gold Coast", so
-- INSERT OR IGNORE in the sync path will not recreate this row.
DELETE FROM teams WHERE id = 261;

-- AFL standard abbreviations. Idempotent via name match — re-running does
-- nothing if names are unchanged.
UPDATE teams SET abbreviation = 'ADE'  WHERE name = 'Adelaide';
UPDATE teams SET abbreviation = 'BL'   WHERE name = 'Brisbane Lions';
UPDATE teams SET abbreviation = 'CARL' WHERE name = 'Carlton';
UPDATE teams SET abbreviation = 'COLL' WHERE name = 'Collingwood';
UPDATE teams SET abbreviation = 'ESS'  WHERE name = 'Essendon';
UPDATE teams SET abbreviation = 'FITZ' WHERE name = 'Fitzroy';
UPDATE teams SET abbreviation = 'FREO' WHERE name = 'Fremantle';
UPDATE teams SET abbreviation = 'GEEL' WHERE name = 'Geelong';
UPDATE teams SET abbreviation = 'GCFC' WHERE name = 'Gold Coast';
UPDATE teams SET abbreviation = 'GWS'  WHERE name = 'GWS Giants';
UPDATE teams SET abbreviation = 'HAW'  WHERE name = 'Hawthorn';
UPDATE teams SET abbreviation = 'MELB' WHERE name = 'Melbourne';
UPDATE teams SET abbreviation = 'NM'   WHERE name = 'North Melbourne';
UPDATE teams SET abbreviation = 'PORT' WHERE name = 'Port Adelaide';
UPDATE teams SET abbreviation = 'RICH' WHERE name = 'Richmond';
UPDATE teams SET abbreviation = 'STK'  WHERE name = 'St Kilda';
UPDATE teams SET abbreviation = 'SYD'  WHERE name = 'Sydney';
UPDATE teams SET abbreviation = 'WCE'  WHERE name = 'West Coast';
UPDATE teams SET abbreviation = 'WB'   WHERE name = 'Western Bulldogs';
