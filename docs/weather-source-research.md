# Weather Source Research

This research, completed on 2026-07-13, selects a weather source for the AFL
data ecosystem. It covers historical match-time observations from 1990 and
seven-day forecasts.

The source must offer a free tier and work through a Cloudflare Worker's Fetch
API. The assessment prioritises accuracy and uses official documentation, terms,
and live API responses.

---

## Summary and Recommendation

**Use Open-Meteo for both historical observations and forecasts.** Single
source, no split needed.

- Historical (1990 to 5 days ago): Open-Meteo **Historical Weather API**
  (`archive-api.open-meteo.com`), `models=era5_land` (~11 km grid, hourly,
  1950 - present). Verified live for MCG coordinates on both 2017-09-30 and
  1990-10-06.
- Recent past (last ~5 days, ERA5 lag window): Open-Meteo **Historical Forecast
  API** (`historical-forecast-api.open-meteo.com`) - archived high-resolution
  forecast model output, verified live.
- Forecasts (≤7 days, refreshed as match approaches): Open-Meteo **Forecast
  API** (`api.open-meteo.com`), `best_match` model - which for Australia can
  draw on BOM's own ACCESS-G model (`models=bom_access_global` verified live).
  Horizon up to 16 days (verified live).

**Why not the others:**

- BOM: has the most accurate station data (Olympic Park is ~700 m from the MCG)
  but there is **no permitted programmatic path a Worker can use**: the website
  actively blocks automated access and tells scrapers to "stop" (block page
  captured below), the sanctioned free channel is **anonymous FTP** which
  Cloudflare Workers cannot speak (fetch is HTTP(S) only), the undocumented
  `api.weather.bom.gov.au` embeds "You must not use, copy or share it" in every
  response, and historical _hourly_ observations are a paid Registered User data
  service. BOM is disqualified on terms + transport, not on data quality.
- Meteostat: is free (bulk CSVs, CC BY 4.0) but its hourly station inventory
  fails exactly where AFL needs it most: **no hourly-inventory station within 18
  km of the MCG** (nearest usable: Point Cook 18.3 km, Melbourne Airport 20.9
  km - start 1973), **nothing usable near Kardinia Park**, and the RapidAPI JSON
  tier is 500 calls/month - unusable for a 10k backfill. At ~20 km station
  distance it is no more "venue-level" than an 11 km reanalysis grid, with worse
  completeness and gz-CSV parsing in a Worker on top.

**Accuracy caveat (applies to the recommendation):** ERA5-Land is a ~11 km grid
reanalysis, not a stadium rain gauge. Temperature, humidity and sustained wind
represent temperature, humidity, and sustained wind well. The grid can smooth or
displace short convective showers. Mitigation: validate hourly
precipitation/temp against the existing fryzigg `weather_type` +
`weather_temp_c` ground truth for AFLM 2010 - 2025 already in D1 before trusting
the backfill (see Open Risks).

---

## Candidate 1: Open-Meteo (Recommended)

Open-Meteo meets the access, coverage, licensing, and operational requirements.

### Access & Key Management

- No API key: for free non-commercial use. free tier uses the public endpoints
  directly. Paid subscribers get a separate keyed host
  (`customer-api.open-meteo.com`). Source: <https://open-meteo.com/en/pricing>
- Plain HTTPS + JSON - verified working with bare `curl`, no headers needed.
  Fully Workers-compatible.

### Rate Limits (Free Tier)

| Window     | Limit         |
| ---------- | ------------- |
| Per minute | 600 calls     |
| Per hour   | 5,000 calls   |
| Per day    | 10,000 calls  |
| Per month  | 300,000 calls |

Open-Meteo weights calls by data volume. A two-week request with 15 weather
variables counts as 1.5 API calls. Requests over ten variables or two weeks
count as multiple calls. Sources: <https://open-meteo.com/en/terms>,
<https://open-meteo.com/en/pricing>

### Licensing

- Non-commercial free use explicitly includes "private or non-profit websites or
  apps that do not have subscriptions or advertising" - AFL-MCP (private hobby
  project) qualifies.
- Data is **CC-BY 4.0**: attribution to Open-Meteo required (add to
  README/ecosystem doc when the integration ships).
- "We reserve the right to block applications and IP addresses that misuse our
  service without prior notice."
- Source: <https://open-meteo.com/en/terms>

### Historical Depth & Resolution

From <https://open-meteo.com/en/docs/historical-weather-api>:

| Dataset       | Resolution        | Coverage           | Update lag |
| ------------- | ----------------- | ------------------ | ---------- |
| ERA5          | 0.25° (~25 km)    | 1940 - present     | ~5 days    |
| **ERA5-Land** | **0.1° (~11 km)** | **1950 - present** | ~5 days    |
| ECMWF IFS     | 9 km              | 2017 - present     | 6-hourly   |

All needed hourly variables exist: `temperature_2m`, `precipitation`, `rain`,
`relative_humidity_2m`, `wind_speed_10m`, `wind_gusts_10m`.
`timezone=Australia/Melbourne` returns local-time timestamps starting at 00:00
local (verified in responses below - `utc_offset_seconds: 36000`), which maps
directly onto match start times without UTC math.

### Live Evidence (2026-07-13)

**1990 depth test** - MCG coords (-37.8199, 144.9834), 1990 Grand Final day
(1990-10-06), `archive-api.open-meteo.com/v1/archive`:

```json
{
    "latitude": -37.85589,
    "longitude": 145.0134,
    "utc_offset_seconds": 36000,
    "timezone": "Australia/Melbourne",
    "hourly": {
        "time": ["1990-10-06T00:00", "..."],
        "temperature_2m": [8.7, 8.6, "...", 12.9, 12.4, 11.7, "..."],
        "precipitation": [0.0, 0.0, "..."],
        "wind_speed_10m": [25.1, 24.3, "..."],
        "relative_humidity_2m": [75, 72, "..."]
    }
}
```

The 2017 Grand Final response returned a maximum temperature of 15.4 °C at 14:00
local time. It also returned gusts of 41 to 56 km/h and trace precipitation.
These results align with the fryzigg `MOSTLY_SUNNY` label and match reports.

**ERA5-Land model selection** (`&models=era5_land`) works and snaps to the 0.1°
cell (-37.8, 145.0) - ~4 km from the MCG:

```json
{
    "latitude": -37.8,
    "longitude": 145.0,
    "hourly": { "time": ["2017-09-30T00:00", "..."] }
}
```

**Forecast API** - 7-day hourly forecast for MCG incl.
`precipitation_probability` returned instantly. `forecast_days=16` returned 16
daily rows (2026-07-13 to 2026-07-28). BOM's own global model is selectable:
`&models=bom_access_global` returned data on a 0.15° grid (-37.95, 145.125).

**Historical Forecast API** - `historical-forecast-api.open-meteo.com` returned
hourly data for 2024-09-28 (covers the ERA5 5-day lag window and gives high-res
model "actuals" for just-played matches).

### Open-Meteo Scores

- Venue accuracy: **good-not-perfect** - 11 km grid. see Open Risks.
- Historical depth: **1950+** (ERA5-Land), comfortably covers 1990. All venues
  covered - it is a global grid, so regional grounds (Norwood, Mars Stadium,
  TIO…) cost nothing extra.
- Forecast: up to 16 days. usable ≤7 days as required. `best_match` blends
  models incl. BOM ACCESS-G for AU.
- Rate limits vs workload: trivially sufficient (math below).
- Licensing: CC-BY 4.0 attribution - one line in the README.
- Keys: none. Workers: plain HTTPS/JSON, verified.

---

## Candidate 2: BOM (Rejected for Terms and Transport)

BOM offers high-quality station data but no suitable programmatic access path.

### What Actually Exists

1. **Website JSON feeds** (`www.bom.gov.au/fwo/IDV60901/IDV60901.95936.json`
    - Melbourne Olympic Park obs). A default-UA request gets **HTTP 403** with
      this block page (captured live 2026-07-13):

   > "Your access is blocked due to the detection of a potential automated
   > access request. The Bureau of Meteorology website does not support web
   > scraping: if you are trying to access Bureau data through automated means,
   > you should stop. You may like to consider the following options: An
   > anonymous FTP channel … subject to the default terms of the Bureau's
   > copyright notice … A Registered User service for continued use of Bureau
   > data if your activity does not comply with the default terms…"

   A spoofed browser user agent returns 200, but using one would circumvent the
   stated policy. An unattended scheduled job must not use this path.

2. **Anonymous FTP** (`ftp://ftp.bom.gov.au/anon/gen/fwo/`) - verified live,
   listing returns current product files. This is BOM's sanctioned free channel
   (<http://www.bom.gov.au/catalogue/anon-ftp.shtml>), **but Cloudflare Workers'
   fetch API is HTTP(S)-only - FTP is unreachable from the consumer.** It also
   only carries _current_ obs/forecast products (last ~72 h of observations),
   not 1990 - present history.

3. **`api.weather.bom.gov.au`** (the API behind the BOM app) - responds to plain
   curl, but every response embeds its own prohibition (captured live):

   > "This application programming interface (API) is owned by the Bureau of
   > Meteorology. **You must not use, copy or share it.** Find out more about
   > our data services at <https://www.bom.gov.au/resources/data-services>"

4. **Historical data**: Climate Data Online offers per-station _daily_
   rainfall/temp as manual downloads. **hourly/sub-daily historical observations
   are a paid Registered User data service**
   (<https://www.bom.gov.au/resources/data-services>). There is no free
   programmatic path to 1990 - 2025 hourly station obs.

5. `reg.bom.gov.au` serves the same JSON feeds without the UA block, but it is
   the Registered User host - using it unregistered is the same policy problem
   with different DNS.

### BOM Scores

- Venue accuracy: best available (stations at Olympic Park ~700 m from MCG)
  - irrelevant, because no permitted free automated access exists.
- Historical hourly to 1990: paid only. Forecast API: prohibited.
- Workers compatibility: FTP impossible. HTTP paths are policy-blocked.

---

## Candidate 3: Meteostat (Rejected for Coverage and API Limits)

Meteostat lacks suitable station coverage and sufficient free API capacity.

### Access & Licensing

- JSON API: hosted on RapidAPI (`meteostat.p.rapidapi.com`), requires a RapidAPI
  key. **free tier is 500 calls/month**. Source:
  <https://dev.meteostat.net/api> - useless for a 10k backfill or a 5-min cron.
- Bulk data: `bulk.meteostat.net/v2/hourly/{station}.csv.gz` - free, no key.
  Verified live: station 94767 and station-list `stations/lite.json.gz` all
  returned 200. Source: <https://dev.meteostat.net/bulk/> (note: docs pages have
  moved. bulk endpoints verified directly).
- License: CC BY 4.0 ("even commercially"), attribution "Source: Meteostat,
  [Provider Name]". Meteostat does not own the data. it aggregates NOAA/DWD etc.
  and **fills gaps with model data**. Source:
  <https://dev.meteostat.net/license>

### The Disqualifier: Station Inventory at AFL Venues

From the live `stations/lite.json.gz` inventory (2026-07-13), nearest stations
_with hourly data_ to key venues:

| Venue         | Nearest hourly station                | Distance | Hourly coverage                |
| ------------- | ------------------------------------- | -------- | ------------------------------ |
| MCG           | Point Cook                            | 18.3 km  | 1941 - 2025                    |
| MCG (alt)     | Melbourne Airport                     | 20.9 km  | **1973 - present**             |
| Kardinia Park | (none usable)                         | -        | Avalon has 4 days total (2022) |
| SCG           | Sydney Airport                        | 2.4 km   | 1943 - present                 |
| Gabba         | Brisbane Airport                      | 11.3 km  | 1944 - present                 |
| Adelaide Oval | Adelaide Airport                      | 12.8 km  | 1955 - present                 |
| Optus Stadium | (Perth stations: no hourly inventory) | -        | -                              |

Stations that _look_ close (Olympic Park, Brisbane, Adelaide West Terrace,
Perth) report `hourly: {start: null}` - no hourly series at all in Meteostat.
The nearest hourly station to the MCG is about 20 km away, no closer than an
ERA5-Land grid cell. Airport microclimates, missing Geelong and Perth coverage,
and decade-scale gaps further reduce its value. One Victorian station's hourly
CSV contained only records from the 2010s onwards. Bulk compressed-CSV parsing
inside a Worker would add complexity for poorer data.

### Meteostat Scores

- Venue accuracy: worse than reanalysis for VIC/WA venues. fine for SCG only.
- Historical depth: patchy pre-1973 in Melbourne. holes elsewhere.
- Forecast: point-forecast endpoint exists but behind the 500/month RapidAPI
  cap.
- Licensing: fine (CC BY 4.0). Keys: RapidAPI key needed for API.

---

## Rate-Limit Math (Open-Meteo Free Tier)

**Backfill (~10,080 matches, one-off):**

- One archive call per match: single day, 5 - 6 hourly variables to under both
  weighting thresholds (<2 weeks, ≤10 variables) to **1.0 weighted call per
  match**.
- Total ≈ 10,080 calls vs caps of 10,000/day and 300,000/month to **run at
  ~5,000/day over 2 days** (also clears 5,000/hour. pace ≤2 req/s to stay far
  under 600/min). Batching per venue-season (e.g. 180 days × 6 vars ≈ 13
  weighted calls covering ~11 home matches) saves little and complicates retry
  logic - per-match calls are the right shape.

**Steady state (5-min cron, ≤15 upcoming matches in window):**

- Naive per-tick fetch: 15 × 288 = 4,320 calls/day - legal but wasteful.
- Recommended: refresh forecasts on the top-of-hour tick only (the tick
  `shouldRunNow` already always runs): 15 × 24 = **360 calls/day**, plus a
  handful of archive/historical-forecast calls to write final observed weather
  ~5+ days post-match. Two orders of magnitude of headroom.

---

## Open Risks

1. **Grid vs stadium rain.** ERA5-Land hourly precipitation is a ~11 km cell
   average. brief showers can be under/over-stated at the ground. **Before
   trusting the backfill, validate against D1's fryzigg ground truth (AFLM
   2010 - 2025, ~3,000 matches):** e.g. distribution of match-window
   precipitation for `RAIN`/`WINDY_RAIN` vs `SUNNY`/`MOSTLY_SUNNY` labels, and
   MAE of match-time temp vs `weather_temp_c`. Ship the backfill only if
   separation is clean.
2. **Roofed venues.** Marvel Stadium (and `ROOF_CLOSED` labels generally):
   ambient weather ≠ playing conditions. Store the Open-Meteo values as ambient
   observations in separate columns. never overwrite the AFL-sourced
   `weather_type`.
3. **ERA5 5-day lag.** Matches from the last ~5 days are not in the archive yet.
   Use the Historical Forecast API as the bridge, or simply delay the
   observation write until T+6 days (a cron no-op either way).
4. **Shared-IP throttling from Workers.** Open-Meteo's free tier is enforced
   without keys, so presumably per-IP. Cloudflare Workers egress IPs are shared
   pools. At ~400 calls/day this is unlikely to trip anything, but the backfill
   (~5k/day) should be run from a residential machine (a Bun script hitting
   archive-api, writing via wrangler), not from the Worker. Open-Meteo
   "reserve[s] the right to block applications and IP addresses that misuse our
   service without prior notice" (<https://open-meteo.com/en/terms>).
5. **Free-tier durability.** The pricing page markets the Historical API under
   paid "restricted APIs". in practice the keyless archive endpoint serves
   non-commercial traffic today (verified live). If Open-Meteo ever key-gates
   it, fallback is the paid tier or re-running validation against Meteostat bulk
   for the SCG/Gabba subset - no schema change either way.
6. **Attribution.** CC-BY 4.0: add "Weather data by Open-Meteo.com"
   (<https://open-meteo.com/>) to the README and the public ecosystem doc when
   the integration ships.
