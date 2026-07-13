-- Weather data support (#138; schema locked in #126).
--
-- Additive and expand-contract safe: the previous Worker never reads the
-- new venues columns or match_weather, so the GitOps pipeline can apply
-- this migration before the new Worker ships.
--
-- venues gains geodata so weather fetches can resolve coordinates, an IANA
-- timezone for non-Melbourne consumers, a roof flag ('retractable'|'none')
-- so consumers can discount weather where a roof was probably closed, and
-- canonical_venue_id so sponsor-renamed grounds (Docklands by any name)
-- resolve to one physical venue.
--
-- match_weather holds up to two rows per match keyed (match_id, kind):
-- a forecast row (overwritten in place per refresh, kept after the match
-- for forecast-error analysis) and an observed row. Metrics are a 3-hour
-- window from the scheduled start, plus prior-24h rainfall for ground
-- condition. Populated from Open-Meteo (CC-BY 4.0).

ALTER TABLE venues ADD COLUMN latitude REAL;
ALTER TABLE venues ADD COLUMN longitude REAL;
ALTER TABLE venues ADD COLUMN timezone TEXT;            -- IANA
ALTER TABLE venues ADD COLUMN roof TEXT;                -- 'retractable' | 'none'
ALTER TABLE venues ADD COLUMN canonical_venue_id INTEGER REFERENCES venues(id);

CREATE TABLE match_weather (
  match_id INTEGER NOT NULL REFERENCES matches(id),
  kind TEXT NOT NULL CHECK (kind IN ('observed','forecast')),
  temp_c REAL,               -- 3h mean from scheduled start
  precip_mm REAL,            -- 3h total, match window
  precip_24h_prior_mm REAL,  -- ground condition
  wind_speed_kmh REAL,       -- 3h max
  wind_gust_kmh REAL,        -- 3h max
  humidity_pct REAL,         -- 3h mean
  source TEXT NOT NULL,      -- 'era5_land+era5' | 'historical_forecast' | 'best_match'
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (match_id, kind)
);

-- Venue geodata seed, generated from data/venue-geodata.csv (106 venues,
-- 12 alias groups). The 'To Be Confirmed' placeholder (17748) keeps NULL
-- geodata and is its own canonical id; it is excluded from weather work.
UPDATE venues SET latitude = -37.8200, longitude = 144.9834, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 18 WHERE id = 18;
UPDATE venues SET latitude = -37.8165, longitude = 144.9475, timezone = 'Australia/Melbourne', roof = 'retractable', canonical_venue_id = 22 WHERE id = 22;
UPDATE venues SET latitude = -31.9442, longitude = 115.8299, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 6 WHERE id = 6;
UPDATE venues SET latitude = -34.8797, longitude = 138.4956, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 82 WHERE id = 82;
UPDATE venues SET latitude = -27.4858, longitude = 153.0381, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 15 WHERE id = 15;
UPDATE venues SET latitude = -37.7841, longitude = 144.9617, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 79 WHERE id = 79;
UPDATE venues SET latitude = -33.8915, longitude = 151.2247, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 1 WHERE id = 1;
UPDATE venues SET latitude = -38.1580, longitude = 144.3546, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 5 WHERE id = 5;
UPDATE venues SET latitude = -34.9156, longitude = 138.5961, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 27 WHERE id = 27;
UPDATE venues SET latitude = -28.0063, longitude = 153.3670, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17 WHERE id = 17;
UPDATE venues SET latitude = -37.9256, longitude = 145.1866, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 65 WHERE id = 65;
UPDATE venues SET latitude = -31.9512, longitude = 115.8891, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 12 WHERE id = 12;
UPDATE venues SET latitude = -33.8434, longitude = 151.0678, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 11 WHERE id = 11;
UPDATE venues SET latitude = -38.1073, longitude = 145.3110, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17600 WHERE id = 17600;
UPDATE venues SET latitude = -37.7994, longitude = 144.8886, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17599 WHERE id = 17599;
UPDATE venues SET latitude = -37.7986, longitude = 144.9989, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 70 WHERE id = 70;
UPDATE venues SET latitude = -37.8336, longitude = 144.9395, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17735 WHERE id = 17735;
UPDATE venues SET latitude = -41.4256, longitude = 147.1390, timezone = 'Australia/Hobart', roof = 'none', canonical_venue_id = 19 WHERE id = 19;
UPDATE venues SET latitude = -37.7986, longitude = 144.9413, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17661 WHERE id = 17661;
UPDATE venues SET latitude = -37.8655, longitude = 144.8975, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17741 WHERE id = 17741;
UPDATE venues SET latitude = -37.7517, longitude = 144.9198, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 71 WHERE id = 71;
UPDATE venues SET latitude = -37.8137, longitude = 145.1174, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17746 WHERE id = 17746;
UPDATE venues SET latitude = -37.9455, longitude = 145.0027, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17707 WHERE id = 17707;
UPDATE venues SET latitude = -37.7994, longitude = 144.8886, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17599 WHERE id = 72;
UPDATE venues SET latitude = -35.3182, longitude = 149.1345, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 20 WHERE id = 20;
UPDATE venues SET latitude = -38.1417, longitude = 145.1286, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17691 WHERE id = 17691;
UPDATE venues SET latitude = -37.7390, longitude = 145.0045, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17833 WHERE id = 17833;
UPDATE venues SET latitude = -37.9030, longitude = 144.6560, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17641 WHERE id = 17641;
UPDATE venues SET latitude = -27.6720, longitude = 152.9060, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17728 WHERE id = 17728;
UPDATE venues SET latitude = -31.9598, longitude = 115.8798, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 78 WHERE id = 78;
UPDATE venues SET latitude = -33.8474, longitude = 151.0631, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 3 WHERE id = 3;
UPDATE venues SET latitude = -27.9570, longitude = 153.3750, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17736 WHERE id = 17736;
UPDATE venues SET latitude = NULL, longitude = NULL, timezone = NULL, roof = NULL, canonical_venue_id = 17748 WHERE id = 17748;
UPDATE venues SET latitude = -33.7692, longitude = 150.8593, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17602 WHERE id = 17602;
UPDATE venues SET latitude = -37.9366, longitude = 145.0410, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17651 WHERE id = 17651;
UPDATE venues SET latitude = -37.7448, longitude = 144.9700, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17733 WHERE id = 17733;
UPDATE venues SET latitude = -37.8225, longitude = 144.9866, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17675 WHERE id = 17675;
UPDATE venues SET latitude = -12.3992, longitude = 130.8872, timezone = 'Australia/Darwin', roof = 'none', canonical_venue_id = 13 WHERE id = 13;
UPDATE venues SET latitude = -32.0561, longitude = 115.7492, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 17601 WHERE id = 17601;
UPDATE venues SET latitude = -34.9202, longitude = 138.6320, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 24 WHERE id = 24;
UPDATE venues SET latitude = -37.7240, longitude = 144.9010, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17730 WHERE id = 17730;
UPDATE venues SET latitude = -37.8243, longitude = 144.9810, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17726 WHERE id = 17726;
UPDATE venues SET latitude = -38.1980, longitude = 144.2960, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17836 WHERE id = 17836;
UPDATE venues SET latitude = -33.9074, longitude = 151.1580, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17705 WHERE id = 17705;
UPDATE venues SET latitude = -33.8917, longitude = 151.2219, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17744 WHERE id = 17744;
UPDATE venues SET latitude = -42.8772, longitude = 147.3736, timezone = 'Australia/Hobart', roof = 'none', canonical_venue_id = 166 WHERE id = 166;
UPDATE venues SET latitude = -31.9670, longitude = 115.9050, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 17668 WHERE id = 17668;
UPDATE venues SET latitude = -37.9366, longitude = 145.0410, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17651 WHERE id = 100;
UPDATE venues SET latitude = -31.9442, longitude = 115.8299, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 6 WHERE id = 17606;
UPDATE venues SET latitude = -34.8440, longitude = 138.5200, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 17758 WHERE id = 17758;
UPDATE venues SET latitude = -37.5382, longitude = 143.8465, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 10 WHERE id = 10;
UPDATE venues SET latitude = -42.8772, longitude = 147.3736, timezone = 'Australia/Hobart', roof = 'none', canonical_venue_id = 166 WHERE id = 2;
UPDATE venues SET latitude = -16.9360, longitude = 145.7490, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 21 WHERE id = 21;
UPDATE venues SET latitude = -42.8690, longitude = 147.3180, timezone = 'Australia/Hobart', roof = 'none', canonical_venue_id = 17628 WHERE id = 17628;
UPDATE venues SET latitude = -27.1570, longitude = 152.9570, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17624 WHERE id = 17624;
UPDATE venues SET latitude = -37.7220, longitude = 145.0480, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 18034 WHERE id = 18034;
UPDATE venues SET latitude = -23.7081, longitude = 133.8745, timezone = 'Australia/Darwin', roof = 'none', canonical_venue_id = 8 WHERE id = 8;
UPDATE venues SET latitude = -34.9460, longitude = 138.6010, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 17643 WHERE id = 17643;
UPDATE venues SET latitude = -34.6014, longitude = 138.8892, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 14 WHERE id = 14;
UPDATE venues SET latitude = -27.3190, longitude = 152.9800, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17603 WHERE id = 17603;
UPDATE venues SET latitude = -27.4075, longitude = 153.0090, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17638 WHERE id = 17638;
UPDATE venues SET latitude = -31.9366, longitude = 115.8419, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 17662 WHERE id = 17662;
UPDATE venues SET latitude = -21.1550, longitude = 149.1780, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17663 WHERE id = 17663;
UPDATE venues SET latitude = -37.9800, longitude = 145.1300, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17718 WHERE id = 17718;
UPDATE venues SET latitude = -27.3460, longitude = 153.0240, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17853 WHERE id = 17853;
UPDATE venues SET latitude = -28.0050, longitude = 153.3640, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17878 WHERE id = 17878;
UPDATE venues SET latitude = -38.6080, longitude = 145.5930, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17932 WHERE id = 17932;
UPDATE venues SET latitude = -37.7700, longitude = 145.0030, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 18041 WHERE id = 18041;
UPDATE venues SET latitude = -32.1220, longitude = 115.8450, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 217702 WHERE id = 217702;
UPDATE venues SET latitude = -33.8420, longitude = 151.0700, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17721 WHERE id = 17721;
UPDATE venues SET latitude = -42.8690, longitude = 147.3180, timezone = 'Australia/Hobart', roof = 'none', canonical_venue_id = 17628 WHERE id = 69;
UPDATE venues SET latitude = -37.8243, longitude = 144.9810, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17726 WHERE id = 17608;
UPDATE venues SET latitude = -33.8380, longitude = 151.2080, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17755 WHERE id = 17755;
UPDATE venues SET latitude = 31.3070, longitude = 121.5170, timezone = 'Asia/Shanghai', roof = 'none', canonical_venue_id = 16 WHERE id = 16;
UPDATE venues SET latitude = -41.2730, longitude = 174.7859, timezone = 'Pacific/Auckland', roof = 'none', canonical_venue_id = 87 WHERE id = 87;
UPDATE venues SET latitude = -34.9445, longitude = 138.5550, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 17658 WHERE id = 17658;
UPDATE venues SET latitude = -38.0400, longitude = 145.3750, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17727 WHERE id = 17727;
UPDATE venues SET latitude = -30.3200, longitude = 153.1090, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17794 WHERE id = 17794;
UPDATE venues SET latitude = -37.6070, longitude = 144.9150, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17876 WHERE id = 17876;
UPDATE venues SET latitude = -33.3336, longitude = 115.6519, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 7 WHERE id = 7;
UPDATE venues SET latitude = -34.9130, longitude = 138.5660, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 17598 WHERE id = 17598;
UPDATE venues SET latitude = -33.8520, longitude = 151.1540, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17615 WHERE id = 17615;
UPDATE venues SET latitude = -38.2320, longitude = 146.4020, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17640 WHERE id = 17640;
UPDATE venues SET latitude = -26.6440, longitude = 153.0640, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17706 WHERE id = 17706;
UPDATE venues SET latitude = -33.8917, longitude = 151.2219, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17744 WHERE id = 17905;
UPDATE venues SET latitude = -38.1670, longitude = 144.3320, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 18040 WHERE id = 18040;
UPDATE venues SET latitude = -41.1290, longitude = 146.0700, timezone = 'Australia/Hobart', roof = 'none', canonical_venue_id = 427845 WHERE id = 427845;
UPDATE venues SET latitude = -19.3135, longitude = 146.7390, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 26 WHERE id = 26;
UPDATE venues SET latitude = -35.2496, longitude = 149.1013, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 58 WHERE id = 58;
UPDATE venues SET latitude = -33.7692, longitude = 150.8593, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17602 WHERE id = 93;
UPDATE venues SET latitude = -32.5320, longitude = 115.7250, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 17604 WHERE id = 17604;
UPDATE venues SET latitude = -38.1760, longitude = 146.2610, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17622 WHERE id = 17622;
UPDATE venues SET latitude = -36.7600, longitude = 144.2790, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17660 WHERE id = 17660;
UPDATE venues SET latitude = -35.1190, longitude = 147.3700, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17665 WHERE id = 17665;
UPDATE venues SET latitude = -35.1440, longitude = 138.4990, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 17695 WHERE id = 17695;
UPDATE venues SET latitude = -38.3790, longitude = 142.4800, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17773 WHERE id = 17773;
UPDATE venues SET latitude = -28.0760, longitude = 153.4130, timezone = 'Australia/Brisbane', roof = 'none', canonical_venue_id = 17831 WHERE id = 17831;
UPDATE venues SET latitude = -36.0790, longitude = 146.9200, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17995 WHERE id = 17995;
UPDATE venues SET latitude = -38.3390, longitude = 143.5880, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 18094 WHERE id = 18094;
UPDATE venues SET latitude = -34.7480, longitude = 146.5480, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 427844 WHERE id = 427844;
UPDATE venues SET latitude = -34.6014, longitude = 138.8892, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 14 WHERE id = 9;
UPDATE venues SET latitude = -35.0750, longitude = 138.8800, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 25 WHERE id = 25;
UPDATE venues SET latitude = -34.9460, longitude = 138.6010, timezone = 'Australia/Adelaide', roof = 'none', canonical_venue_id = 17643 WHERE id = 245155;
UPDATE venues SET latitude = -32.1220, longitude = 115.8450, timezone = 'Australia/Perth', roof = 'none', canonical_venue_id = 217702 WHERE id = 763961;
UPDATE venues SET latitude = -33.7692, longitude = 150.8593, timezone = 'Australia/Sydney', roof = 'none', canonical_venue_id = 17602 WHERE id = 1526404;
UPDATE venues SET latitude = -37.9030, longitude = 144.6560, timezone = 'Australia/Melbourne', roof = 'none', canonical_venue_id = 17641 WHERE id = 1184693;
