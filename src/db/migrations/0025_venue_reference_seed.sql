-- Replayable venue reference data, verified against production on 2026-10-04.
-- Names are the sync identity. Never assume the same numeric IDs in a fresh D1.
-- Preserve existing venue IDs and resolve canonical aliases after all inserts.

INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('MCG', -37.82, 144.9834, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Marvel Stadium', -37.8165, 144.9475, 'Australia/Melbourne', 'retractable')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Subiaco', -31.9442, 115.8299, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Football Park', -34.8797, 138.4956, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Gabba', -27.4858, 153.0381, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Princes Park', -37.7841, 144.9617, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('SCG', -33.8915, 151.2247, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Kardinia Park', -38.158, 144.3546, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Adelaide Oval', -34.9156, 138.5961, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Carrara', -28.0063, 153.367, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Waverley Park', -37.9256, 145.1866, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Perth Stadium', -31.9512, 115.8891, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Sydney Showground', -33.8434, 151.0678, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Casey Fields', -38.1073, 145.311, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Mission Whitten Oval', -37.7994, 144.8886, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Victoria Park', -37.7986, 144.9989, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('ETU Stadium', -37.8336, 144.9395, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('UTAS Stadium', -41.4256, 147.139, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Arden Street Oval', -37.7986, 144.9413, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('DSV Stadium', -37.8655, 144.8975, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Windy Hill', -37.7517, 144.9198, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Box Hill City Oval', -37.8137, 145.1174, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Wilson Storage Trevor Barker Beach Oval', -37.9455, 145.0027, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Western Oval', -37.7994, 144.8886, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Manuka Oval', -35.3182, 149.1345, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Kinetic Stadium', -38.1417, 145.1286, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Preston City Oval', -37.739, 145.0045, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Melbourne Avalon Airport Oval', -37.903, 144.656, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Brighton Homes Arena', -27.672, 152.906, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('W.A.C.A.', -31.9598, 115.8798, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Accor Stadium', -33.8474, 151.0631, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Fankhauser Reserve', -27.957, 153.375, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('To Be Confirmed', NULL, NULL, NULL, NULL)
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blacktown ISP', -33.7692, 150.8593, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('RSEA Park', -37.9366, 145.041, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Barry Plant Park', -37.7448, 144.97, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Swinburne Centre', -37.8225, 144.9866, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('TIO Stadium', -12.3992, 130.8872, 'Australia/Darwin', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Fremantle Oval', -32.0561, 115.7492, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Norwood Oval', -34.9202, 138.632, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('NEC Hangar', -37.724, 144.901, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('KGM Centre', -37.8243, 144.981, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Deakin University', -38.198, 144.296, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Henson Park', -33.9074, 151.158, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Tramway Oval', -33.8917, 151.2219, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Ninja Stadium', -42.8772, 147.3736, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Mineral Resources Park', -31.967, 115.905, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Moorabbin Oval', -37.9366, 145.041, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Domain Stadium', -31.9442, 115.8299, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Alberton Oval', -34.844, 138.52, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Mars Stadium', -37.5382, 143.8465, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blundstone Arena', -42.8772, 147.3736, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Cazalys Stadium', -16.936, 145.749, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('North Hobart Oval', -42.869, 147.318, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Moreton Bay Central Sports Complex', -27.157, 152.957, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('La Trobe University', -37.722, 145.048, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Traeger Park', -23.7081, 133.8745, 'Australia/Darwin', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Thomas Farms Oval', -34.946, 138.601, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Barossa Park', -34.6014, 138.8892, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('South Pine Sports Complex', -27.319, 152.98, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Hickey Park', -27.4075, 153.009, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Sullivan Logistics Stadium', -31.9366, 115.8419, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Great Barrier Reef Arena', -21.155, 149.178, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Kennedy Community Centre', -37.98, 145.13, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Graham Rd', -27.346, 153.024, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Austworld Centre Oval', -28.005, 153.364, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Wonthaggi Recreation Reserve', -38.608, 145.593, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Bill Lawry Oval', -37.77, 145.003, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Cockburn ARC Oval', -32.122, 115.845, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Tom Wills Oval', -33.842, 151.07, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('North Hobart', -42.869, 147.318, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Olympic Park Oval', -37.8243, 144.981, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('North Sydney Oval', -33.838, 151.208, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Jiangwan Stadium', 31.307, 121.517, 'Asia/Shanghai', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Wellington', -41.273, 174.7859, 'Pacific/Auckland', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Richmond Oval', -34.9445, 138.555, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Holm Park Recreation Reserve', -38.04, 145.375, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('C.ex Coffs International Stadium', -30.32, 153.109, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Highgate Recreation Reserve', -37.607, 144.915, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Hands Oval', -33.3336, 115.6519, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Thebarton Oval', -34.913, 138.566, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Drummoyne Oval', -33.852, 151.154, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Morwell Recreation Reserve', -38.232, 146.402, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Maroochydore', -26.644, 153.064, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Lakeside Oval Sydney', -33.8917, 151.2219, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('KFC Oval - Queens Park', -38.167, 144.332, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Dial Park', -41.129, 146.07, 'Australia/Hobart', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Riverway Stadium', -19.3135, 146.739, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Bruce Stadium', -35.2496, 149.1013, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blacktown', -33.7692, 150.8593, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Rushton Park', -32.532, 115.725, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Ted Summerton Recreational Reserve', -38.176, 146.261, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Queen Elizabeth Oval', -36.76, 144.279, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Robertson Oval', -35.119, 147.37, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Magain Stadium', -35.144, 138.499, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Reid Oval Warrnambool', -38.379, 142.48, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Bond University', -28.076, 153.413, 'Australia/Brisbane', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Albury Sports Ground', -36.079, 146.92, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Central Reserve', -38.339, 143.588, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Narrandera Sports Ground', -34.748, 146.548, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Barossa Oval', -34.6014, 138.8892, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Summit Sports Park', -35.075, 138.88, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Unley Oval', -34.946, 138.601, 'Australia/Adelaide', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Victor George Kailis Oval', -32.122, 115.845, 'Australia/Perth', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Blacktown International Sportspark', -33.7692, 150.8593, 'Australia/Sydney', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;
INSERT INTO venues (name, latitude, longitude, timezone, roof) VALUES ('Avalon Airport Oval', -37.903, 144.656, 'Australia/Melbourne', 'none')
ON CONFLICT(name) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude, timezone=excluded.timezone, roof=excluded.roof;

UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'MCG') WHERE name = 'MCG';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Marvel Stadium') WHERE name = 'Marvel Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Subiaco') WHERE name = 'Subiaco';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Football Park') WHERE name = 'Football Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Gabba') WHERE name = 'Gabba';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Princes Park') WHERE name = 'Princes Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'SCG') WHERE name = 'SCG';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Kardinia Park') WHERE name = 'Kardinia Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Adelaide Oval') WHERE name = 'Adelaide Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Carrara') WHERE name = 'Carrara';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Waverley Park') WHERE name = 'Waverley Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Perth Stadium') WHERE name = 'Perth Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Sydney Showground') WHERE name = 'Sydney Showground';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Casey Fields') WHERE name = 'Casey Fields';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mission Whitten Oval') WHERE name = 'Mission Whitten Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Victoria Park') WHERE name = 'Victoria Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'ETU Stadium') WHERE name = 'ETU Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'UTAS Stadium') WHERE name = 'UTAS Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Arden Street Oval') WHERE name = 'Arden Street Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'DSV Stadium') WHERE name = 'DSV Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Windy Hill') WHERE name = 'Windy Hill';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Box Hill City Oval') WHERE name = 'Box Hill City Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Wilson Storage Trevor Barker Beach Oval') WHERE name = 'Wilson Storage Trevor Barker Beach Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mission Whitten Oval') WHERE name = 'Western Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Manuka Oval') WHERE name = 'Manuka Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Kinetic Stadium') WHERE name = 'Kinetic Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Preston City Oval') WHERE name = 'Preston City Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Melbourne Avalon Airport Oval') WHERE name = 'Melbourne Avalon Airport Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Brighton Homes Arena') WHERE name = 'Brighton Homes Arena';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'W.A.C.A.') WHERE name = 'W.A.C.A.';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Accor Stadium') WHERE name = 'Accor Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Fankhauser Reserve') WHERE name = 'Fankhauser Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'To Be Confirmed') WHERE name = 'To Be Confirmed';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Blacktown ISP') WHERE name = 'Blacktown ISP';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'RSEA Park') WHERE name = 'RSEA Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Barry Plant Park') WHERE name = 'Barry Plant Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Swinburne Centre') WHERE name = 'Swinburne Centre';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'TIO Stadium') WHERE name = 'TIO Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Fremantle Oval') WHERE name = 'Fremantle Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Norwood Oval') WHERE name = 'Norwood Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'NEC Hangar') WHERE name = 'NEC Hangar';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'KGM Centre') WHERE name = 'KGM Centre';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Deakin University') WHERE name = 'Deakin University';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Henson Park') WHERE name = 'Henson Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Tramway Oval') WHERE name = 'Tramway Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Ninja Stadium') WHERE name = 'Ninja Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mineral Resources Park') WHERE name = 'Mineral Resources Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'RSEA Park') WHERE name = 'Moorabbin Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Subiaco') WHERE name = 'Domain Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Alberton Oval') WHERE name = 'Alberton Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Mars Stadium') WHERE name = 'Mars Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Ninja Stadium') WHERE name = 'Blundstone Arena';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Cazalys Stadium') WHERE name = 'Cazalys Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'North Hobart Oval') WHERE name = 'North Hobart Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Moreton Bay Central Sports Complex') WHERE name = 'Moreton Bay Central Sports Complex';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'La Trobe University') WHERE name = 'La Trobe University';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Traeger Park') WHERE name = 'Traeger Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Thomas Farms Oval') WHERE name = 'Thomas Farms Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Barossa Park') WHERE name = 'Barossa Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'South Pine Sports Complex') WHERE name = 'South Pine Sports Complex';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Hickey Park') WHERE name = 'Hickey Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Sullivan Logistics Stadium') WHERE name = 'Sullivan Logistics Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Great Barrier Reef Arena') WHERE name = 'Great Barrier Reef Arena';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Kennedy Community Centre') WHERE name = 'Kennedy Community Centre';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Graham Rd') WHERE name = 'Graham Rd';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Austworld Centre Oval') WHERE name = 'Austworld Centre Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Wonthaggi Recreation Reserve') WHERE name = 'Wonthaggi Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Bill Lawry Oval') WHERE name = 'Bill Lawry Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Cockburn ARC Oval') WHERE name = 'Cockburn ARC Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Tom Wills Oval') WHERE name = 'Tom Wills Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'North Hobart Oval') WHERE name = 'North Hobart';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'KGM Centre') WHERE name = 'Olympic Park Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'North Sydney Oval') WHERE name = 'North Sydney Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Jiangwan Stadium') WHERE name = 'Jiangwan Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Wellington') WHERE name = 'Wellington';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Richmond Oval') WHERE name = 'Richmond Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Holm Park Recreation Reserve') WHERE name = 'Holm Park Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'C.ex Coffs International Stadium') WHERE name = 'C.ex Coffs International Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Highgate Recreation Reserve') WHERE name = 'Highgate Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Hands Oval') WHERE name = 'Hands Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Thebarton Oval') WHERE name = 'Thebarton Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Drummoyne Oval') WHERE name = 'Drummoyne Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Morwell Recreation Reserve') WHERE name = 'Morwell Recreation Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Maroochydore') WHERE name = 'Maroochydore';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Tramway Oval') WHERE name = 'Lakeside Oval Sydney';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'KFC Oval - Queens Park') WHERE name = 'KFC Oval - Queens Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Dial Park') WHERE name = 'Dial Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Riverway Stadium') WHERE name = 'Riverway Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Bruce Stadium') WHERE name = 'Bruce Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Blacktown ISP') WHERE name = 'Blacktown';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Rushton Park') WHERE name = 'Rushton Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Ted Summerton Recreational Reserve') WHERE name = 'Ted Summerton Recreational Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Queen Elizabeth Oval') WHERE name = 'Queen Elizabeth Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Robertson Oval') WHERE name = 'Robertson Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Magain Stadium') WHERE name = 'Magain Stadium';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Reid Oval Warrnambool') WHERE name = 'Reid Oval Warrnambool';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Bond University') WHERE name = 'Bond University';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Albury Sports Ground') WHERE name = 'Albury Sports Ground';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Central Reserve') WHERE name = 'Central Reserve';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Narrandera Sports Ground') WHERE name = 'Narrandera Sports Ground';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Barossa Park') WHERE name = 'Barossa Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Summit Sports Park') WHERE name = 'Summit Sports Park';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Thomas Farms Oval') WHERE name = 'Unley Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Cockburn ARC Oval') WHERE name = 'Victor George Kailis Oval';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Blacktown ISP') WHERE name = 'Blacktown International Sportspark';
UPDATE venues SET canonical_venue_id = (SELECT id FROM venues WHERE name = 'Melbourne Avalon Airport Oval') WHERE name = 'Avalon Airport Oval';
