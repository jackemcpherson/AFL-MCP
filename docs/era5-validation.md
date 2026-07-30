# ERA5 and ERA5-Land Validation for the Weather Backfill

This read-only validation ran on 2026-07-13 and made no D1 writes. It compares
Open-Meteo ERA5 data with 3,260 fryzigg-labelled AFLM matches from 2010 to 2025.

The method uses a stratified 422-match sample. It compares each fryzigg label
and temperature with the corresponding three-hour ERA5 match window.

---

## 0. Headline Finding on Source Plumbing

**Open-Meteo's `era5_land` model serves no precipitation at all** - the
`precipitation` and `rain` arrays return only `null` for every probe. Requests
must retrieve precipitation from the `era5` model on its 0.25° grid. Temperature
and relative humidity are available from ERA5-Land (0.1°, ~9 km). A combined
request (`models=era5_land,era5`) returns both, suffixed per model
(`temperature_2m_era5_land`, `precipitation_era5`, …).

Everything below therefore scores **ERA5-Land temperature** and **ERA5
precipitation/wind** - which is what a backfill through Open-Meteo would
actually get.

---

## 1. Sample Selection

Selection was a single D1 query (window functions over the AFLM label
population), stratified three ways:

- weather_type: all THUNDERSTORMS and WINDY_RAIN and WINDY at eligible venues.
  155 of 773 RAIN. proportional slices of the dry types.
- venue: every canonical venue with ≥ 20 labelled AFLM matches (15 venues.
  aliases folded: Domain Stadium to Subiaco, Blundstone to Ninja Stadium).
  **Marvel Stadium (retractable roof, 695 labels) excluded**, as were
  sub-20-match venues (Mars, Cazalys, Traeger, Norwood, Barossa, Wellington,
  Jiangwan, Blacktown, Riverway, Hands - ~60 matches).
- year: interleaved across 2010 - 2025 within each (type, venue) cell via
  `ROW_NUMBER() OVER (PARTITION BY wt, cv, yr ORDER BY <hash>)`.

**ROOF_CLOSED**: 19 labels, all at Marvel Stadium, all 2014. Excluded from
scoring entirely (no outdoor weather to validate). reported here for
completeness. That leaves a scoreable label population of 3,241.

Resulting sample (n = 422. 176 wet-family, 246 dry):

| weather_type  |      sampled | population |
| ------------- | -----------: | ---------: |
| RAIN          |          155 |        773 |
| THUNDERSTORMS |           14 |         18 |
| WINDY_RAIN    |            7 |          7 |
| WINDY         |           31 |         34 |
| MOSTLY_SUNNY  |           85 |      1,373 |
| OVERCAST      |           55 |        534 |
| SUNNY         |           35 |        272 |
| MOSTLY_CLEAR  |           20 |        116 |
| CLEAR_NIGHT   |           20 |        114 |
| ROOF_CLOSED   | 0 (excluded) |         19 |

The fetch used 173 archive calls, one for each venue and year. Every call used
`timezone=Australia/Melbourne`, aligning hourly indices with D1 without venue
conversion. Each three-hour window starts at the match hour. The analysis sums
precipitation, averages temperature, and selects maximum wind. Whole-day
precipitation provides a secondary signal.

---

## 2. Precipitation Discrimination (Wet = RAIN ∪ WINDY_RAIN ∪ THUNDERSTORMS)

Ranking skill: **AUC 0.741** for 3-hour window precip, **0.826** for match-day
precip (Mann-Whitney. 176 wet vs 246 dry). Mean 3h-window RH also separates (AUC
0.725).

Confusion at thresholds. `prec (adj)` re-weights sample precision to the
population wet prevalence of 24.6 % (798 / 3,241) since wet types were
oversampled:

| rule                      |  TP |  FN |  FP |  TN |     recall |    FPR | prec (sample) | prec (adj) |
| ------------------------- | --: | --: | --: | --: | ---------: | -----: | ------------: | ---------: |
| 3h ≥ 0.1 mm               |  99 |  77 |  27 | 219 |     56.3 % | 11.0 % |        78.6 % |     62.6 % |
| 3h ≥ 0.2 mm               |  89 |  87 |  21 | 225 |     50.6 % |  8.5 % |        80.9 % |     65.9 % |
| **3h ≥ 0.5 mm**           |  67 | 109 |   8 | 238 | **38.1 %** |  3.3 % |        89.3 % | **79.3 %** |
| 3h ≥ 1.0 mm               |  44 | 132 |   4 | 242 |     25.0 % |  1.6 % |        91.7 % |     83.4 % |
| 3h ≥ 2.0 mm               |  27 | 149 |   2 | 244 |     15.3 % |  0.8 % |        93.1 % |     86.0 % |
| day ≥ 1 mm                | 126 |  50 |  39 | 207 |     71.6 % | 15.9 % |        76.4 % |     59.6 % |
| day ≥ 5 mm                |  58 | 118 |  12 | 234 |     33.0 % |  4.9 % |        82.9 % |     68.8 % |
| 3h ≥ 0.5 mm OR day ≥ 5 mm |  85 |  91 |  17 | 229 |     48.3 % |  6.9 % |        83.3 % |     69.5 % |

Per-type ERA5 3h precip:

| label         |   n | median | mean | ≥ 0.2 mm | ≥ 1.0 mm |
| ------------- | --: | -----: | ---: | -------: | -------: |
| THUNDERSTORMS |  14 |   0.90 | 1.40 |     57 % |     43 % |
| RAIN          | 155 |   0.20 | 0.78 |     50 % |     23 % |
| WINDY_RAIN    |   7 |   0.10 | 0.69 |     43 % |     29 % |
| OVERCAST      |  55 |   0.00 | 0.09 |     20 % |      2 % |
| MOSTLY_SUNNY  |  85 |   0.00 | 0.13 |      9 % |      4 % |
| MOSTLY_CLEAR  |  20 |   0.00 | 0.03 |      5 % |      0 % |
| WINDY         |  31 |   0.00 | 0.01 |      3 % |      0 % |
| SUNNY         |  35 |   0.00 | 0.00 |      0 % |      0 % |
| CLEAR_NIGHT   |  20 |   0.00 | 0.00 |      0 % |      0 % |

Reading the asymmetry:

- Precipitation presence is highly specific: dry-labelled matches almost never
  show window rain (4 / 246 at ≥ 1 mm, 8 / 246 at ≥ 0.5 mm). Several of those
  "false alarms" look like ground-truth errors, not ERA5 errors - e.g. match
  1446 (Adelaide Oval 2023-04-15, labelled MOSTLY_SUNNY) has 5.6 mm in the match
  window and 20.4 mm on the day. match 8139 (Gabba 2012-04-28, MOSTLY_SUNNY)
  sits on a 34.8 mm day.
- Absence of window rain does not imply a dry label: 87 / 176 wet labels show <
  0.2 mm in the 3h window - but 40 of those 87 had ≥ 1 mm elsewhere on match
  day. The fryzigg label evidently encodes match-day / forecast conditions, not
  strictly the playing window, so window-recall understates ERA5 as much as it
  indicts it. Day-precip AUC (0.826) being clearly higher than window AUC
  (0.741) confirms this.
- ERA5's known smoothing of convective showers on a 31 km grid (see §5)
  plausibly accounts for much of the remaining miss rate, especially light
  drizzle around 0.1 - 0.3 mm/h.

### Wind (Secondary)

Maximum three-hour `wind_speed_10m` separates WINDY-family labels with an AUC of
0.819. Median maximum wind is 26.0 km/h for WINDY-family labels and 12.9 km/h
for other labels. This result supports a coarse windy flag but needs further
validation.

---

## 3. Temperature Agreement

Across all 422 matches, the ERA5-Land window mean has a 3.31 °C MAE and a -2.46
°C bias. Raw ERA5 has a 3.02 °C MAE and a -2.18 °C bias. Start time strongly
influences this bias, which disappears against the ERA5-Land daily maximum:

| comparison                       |   n |      MAE |      bias |
| -------------------------------- | --: | -------: | --------: |
| window mean, day games (< 16:00) | 209 |     2.32 |     −1.71 |
| window mean, twilight (16 - 18)  |  71 |     3.05 |     −2.09 |
| window mean, night (≥ 18:00)     | 142 |     4.90 |     −3.76 |
| **daily max, all**               | 422 | **2.24** | **−0.72** |
| daily max, night games           | 142 |     2.73 |     −0.14 |

**Conclusion: fryzigg `weather_temp_c` behaves like a daily-maximum temperature,
not a match-time temperature.** The −3.8 °C "error" at night games is a
definition mismatch, not reanalysis error. Scored on like terms (ERA5-Land day
max, excluding TIO's placeholder rows, below): **MAE 2.10 °C, bias −0.89 °C** (n
= 417). Values are also integer-quantised in fryzigg, which alone contributes
~0.25 °C of irreducible MAE.

### Per-Venue Table (Sample N, Temp Vs ERA5-Land, Precip Discrimination)

| venue                     |   n | wet n | temp MAE (day-max) | bias (day-max) | temp MAE (window) | bias (window) | wet recall @0.5 mm | dry FPR @0.5 mm |
| ------------------------- | --: | ----: | -----------------: | -------------: | ----------------: | ------------: | -----------------: | --------------: |
| MCG                       |  66 |    25 |               1.53 |          −0.64 |              2.85 |         −2.54 |               48 % |             0 % |
| SCG                       |  47 |    20 |               2.24 |          −1.13 |              3.41 |         −2.81 |               50 % |             0 % |
| Kardinia Park             |  44 |    23 |               2.00 |          −1.67 |              3.16 |         −3.11 |               39 % |             5 % |
| Gabba                     |  43 |    21 |               2.40 |          +0.23 |              3.82 |         −2.48 |               52 % |             9 % |
| Carrara                   |  42 |    17 |               2.13 |          −0.56 |              2.80 |         −2.19 |               24 % |             4 % |
| Sydney Showground         |  33 |    16 |               1.92 |          −1.41 |              3.20 |         −2.92 |               25 % |             0 % |
| UTAS Stadium              |  30 |     9 |               1.98 |          −1.56 |              2.69 |         −2.36 |               22 % |             5 % |
| Subiaco                   |  28 |    12 |               2.40 |          −0.06 |              2.83 |         −1.54 |               42 % |             0 % |
| Adelaide Oval             |  18 |     6 |               3.54 |          −0.10 |              5.01 |         −2.07 |               33 % |            17 % |
| Ninja Stadium (Bellerive) |  17 |     9 |               1.59 |          −1.22 |              2.65 |         −2.31 |               22 % |             0 % |
| Manuka Oval               |  15 |     7 |               2.73 |          −2.73 |              4.47 |         −4.47 |               29 % |             0 % |
| Football Park             |  12 |     5 |               2.25 |          −1.87 |              2.99 |         −2.76 |               20 % |            14 % |
| Perth Stadium             |  10 |     4 |               1.64 |          −1.60 |              3.85 |         −3.85 |               75 % |             0 % |
| TIO Stadium               |   9 |     0 |               8.94 |          +8.14 |              6.91 |         +4.57 |                  - |             0 % |
| Accor Stadium             |   8 |     2 |               1.71 |          +0.46 |              2.84 |         −2.48 |                0 % |             0 % |

### Per-Venue Outliers

- TIO Stadium (Darwin) - ground truth is broken, not ERA5.: Sampled fryzigg
  temps are `33, 28, 26, 18, 18, 18, 18, 18, 35`. five consecutive 18 °C values
  for dry-season Darwin night games (where ERA5-Land reads 27 - 29 °C) are
  clearly a placeholder/default. TIO should be excluded from any temp-agreement
  claim and its fryzigg temps treated as suspect.
- Adelaide Oval: worst honest day-max MAE (3.54, n = 18) and the highest dry
  FPR. individual outliers in both directions suggest noisier fryzigg values
  here rather than a grid problem (Football Park, 11 km away, scores 2.25).
- Manuka Oval: day-max bias −2.73 is the largest true negative bias. small
  sample (15) of mostly winter matches in a frost-hollow venue that a 9 km grid
  smooths over.
- Largest single disagreements are label-side howlers, e.g. match 1409 (MCG
  2023-03-18 19:25, fryzigg 37 °C vs ERA5-Land 19.7 °C - actual Melbourne
  evening in March) and match 215 (Adelaide Oval 2017-03-26, fryzigg 18 °C vs
  ERA5 31.1 °C).

---

## 4. Pre-2010 / Pre-2000 Availability (Measured) and Skill (Literature)

No ground truth exists in D1 before 2010, so **nothing below is a measured
accuracy comparison** - only availability probes plus published assessments.

**Measured availability (probe calls, MCG grid point):**

- 1995-06-17: ERA5-Land hourly temperature and ERA5 hourly precipitation both
  fully populated. The 1990s are served identically to the 2020s.
- ERA5-Land begins **1950-01-01** (1950-01-05 probe returns full 24 h. 1940
  probe returns `null` for `era5_land`).
- ERA5 (0.25°) extends back to **1940** with temperature and precipitation
  populated.

**Published skill context:**

- Lavers et al. 2022, _QJRMS_
  ([doi:10.1002/qj.4351](https://rmets.onlinelibrary.wiley.com/doi/10.1002/qj.4351)) -
  ERA5 precipitation evaluated against 5,637 gauges (2001 - 2020): smallest
  random errors in the extratropics, largest in the tropics. recommended for
  extratropical precipitation monitoring. All sampled venues except TIO Stadium
  (Darwin) and Cazalys (Cairns) are extratropical.
- _HESS_ 2025, BARRA vs ERA5 over Australia
  ([hess-29-3527-2025](https://hess.copernicus.org/articles/29/3527/2025/)) -
  ERA5 daily precipitation vs AGCD gridded obs: mean temporal correlation ~0.85,
  Perkins skill > 0.9 over most of Australia, but **ERA5 underestimates dry days
  and heavy rainfall** (consistent with the low wet-recall measured in §2).
- _Atmosphere_ 2023
  ([mdpi 2073-4433/14/6/913](https://www.mdpi.com/2073-4433/14/6/913)) - ERA5
  temperature over Australia captures mean and extreme indices reasonably well.
  skill worse for minimum temperature. warm bias stronger in western Australia.
- ECMWF back-extension documentation
  ([Bell et al. 2021](https://rmets.onlinelibrary.wiley.com/doi/10.1002/qj.4174),
  [ERA5 data documentation](https://confluence.ecmwf.int/spaces/CKB/pages/76414402/ERA5+data+documentation),
  [known-issue page for Australia pre-1970](<https://confluence.ecmwf.int/display/CKB/ERA5+back+extension+1950-1978+(Preliminary+version):+large+bias+in+surface+analysis+over+Australia+prior+to+1970>)) -
  skill in the pre-satellite era (before TOVS assimilation, late 1978) is
  **markedly lower over Australia/NZ than Europe**, improving dramatically
  from 1979. a documented warm bias in the surface analysis over Australia prior
  to ~1970 (ERA5 anomalies high vs ACORN-SAT/GISTEMP).

**Inference (not measurement):** 1979 - 2009 backfill quality should resemble
the 2010 - 2025 numbers above. 1950 - 1978 temperature carries a documented
Australia-specific warm bias (worst pre-1970) and weaker precipitation analysis.
pre-1950 only ERA5 (31 km) exists at all.

---

## 5. Limitations

- The ground truth is itself imperfect.: fryzigg labels encode match-day /
  forecast conditions (40 of 87 window-dry RAIN labels had measurable day rain),
  temps are integer-quantised, behave as daily maxima, and contain outright
  placeholders (TIO 18 °C runs) and howlers (§3). Every headline number above is
  a _disagreement_ rate, of which ERA5 error is only one component.
- Wet types were deliberately oversampled. in-sample precision is inflated,
  which is why prevalence-adjusted precision is reported alongside.
- ERA5 precip is a 31 km grid-cell average: localised showers are smoothed,
  depressing wet recall - a real limitation for reconstructing a categorical
  RAIN label, less so for a continuous "wetness" feature.
- One grid point per venue, nearest-cell. no bias correction applied.
- Marvel Stadium (695 labels, 21 % of the population) is unscoreable for
  precipitation by construction (roof), and small venues (< 20 matches) were not
  sampled.
- 422 of 3,241 scoreable labels (~13 %). per-venue rows below n ≈ 15 are
  indicative only.

---

## 6. Verdict: Trust with an Era Cap

Open-Meteo provides sufficiently accurate continuous weather features, subject
to era-dependent confidence. Requests must use ERA5 for precipitation because
the API returns no ERA5-Land precipitation.

- Trust temperature after accounting for fryzigg quantisation and noise.
  Like-for-like definitions produce an MAE near 2.1 °C and bias below 1 °C.
- Store the physically meaningful match-window temperature mean. Document its
  expected difference from the daily-maximum-style value for night matches.
- Treat precipitation as a continuous feature, not a reconstructed fryzigg
  label. A three-hour total of 0.5 mm gives about 79% precision and 38% recall.
- Treat 1979 to 2009 with the same inferred confidence as the validated era.
  Satellite assimilation began in 1979, and a 1995 MCG probe returned full data.
- Mark 1950 to 1978 as lower confidence because ECMWF documents weaker
  pre-satellite skill and an Australian surface warm bias before 1970.
- Treat pre-1950 ERA5-only values as indicative because ERA5-Land does not cover
  that period.
- Skip precipitation semantics for roof-closed matches at Marvel Stadium.
  Ambient temperature remains useful, but outside rain does not describe play.

The evidence does not support changing sources. Definition mismatches and
ground-truth defects explain most disagreements, rather than reanalysis failure.
