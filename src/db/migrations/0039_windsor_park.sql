-- Council facility map: https://www.wtc.tas.gov.au/facility/windsor-park/
-- Published map pin: longitude 147.0908651, latitude -41.402883.
-- Preserve any existing venue ID and roof value. This is the Riverside TAS ground.
INSERT INTO venues(name,latitude,longitude,timezone)
VALUES('Windsor Park',-41.402883,147.0908651,'Australia/Hobart')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude,timezone=excluded.timezone;
UPDATE venues SET canonical_venue_id=id WHERE name='Windsor Park';
UPDATE venues SET canonical_venue_id=(SELECT id FROM venues WHERE name='Windsor Park')
WHERE name='Windsor Park Oval';
