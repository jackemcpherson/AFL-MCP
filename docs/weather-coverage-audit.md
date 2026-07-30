# Weather Coverage Audit

This read-only audit ran on 2026-06-30 under plan 002a. It made no D1 writes.

---

## 1. Weather Writer and Source

The writer is `scripts/enrich-fryzigg.ts`.

The script calls `FryziggClient.fetchPlayerStats("AFLM")` from the `fitzroy`
package. It extracts numeric temperature and string weather-type columns from
the returned DataFrame. It writes them only when the existing D1 value is
`NULL`, making the fill idempotent. No other AFL-MCP script writes these fields.

The source is fryzigg through the `FryziggClient` abstraction in `fitzroy`.

Schema documentation (`src/mcp/tools/schema.ts:153`) states:

> "weather_temp_c and weather_type: AFLM-only fryzigg source. Populated
> 2010-2025. NULL elsewhere."

The season and competition join follows `matches.season_id` to
`seasons.competition_id`, then to `competitions.id`. The AFLM competition has
`id = 1` in the `competitions` table (verified by live query). There is no
`competition` column on `matches` directly - the join path is
`matches  to  seasons  to  competitions`.

---

## 2. Per-Season D1 Weather Coverage (AFLM 2015 - 2026)

Query used (read-only, `--remote`):

```sql
SELECT s.year,
       COUNT(m.id) AS total_matches,
       SUM(CASE WHEN m.weather_type IS NOT NULL THEN 1 ELSE 0 END) AS weather_type_non_null,
       SUM(CASE WHEN m.weather_temp_c IS NOT NULL THEN 1 ELSE 0 END) AS weather_temp_non_null
FROM matches m
JOIN seasons s ON m.season_id = s.id
WHERE s.competition_id = 1
  AND s.year BETWEEN 2015 AND 2026
GROUP BY s.year
ORDER BY s.year
```

| Season | Total matches | weather_type non-null | weather_temp_c non-null | type % | temp % |
| ------ | ------------- | --------------------- | ----------------------- | ------ | ------ |
| 2015   | 206           | 206                   | 206                     | 100%   | 100%   |
| 2016   | 207           | 207                   | 207                     | 100%   | 100%   |
| 2017   | 207           | 207                   | 207                     | 100%   | 100%   |
| 2018   | 207           | 207                   | 207                     | 100%   | 100%   |
| 2019   | 207           | 207                   | 207                     | 100%   | 100%   |
| 2020   | 162           | 162                   | 162                     | 100%   | 100%   |
| 2021   | 207           | 207                   | 207                     | 100%   | 100%   |
| 2022   | 207           | 207                   | 207                     | 100%   | 100%   |
| 2023   | 216           | 216                   | 216                     | 100%   | 100%   |
| 2024   | 216           | 216                   | 216                     | 100%   | 100%   |
| 2025   | 216           | 216                   | 216                     | 100%   | 100%   |
| 2026   | 207           | 0                     | 0                       | 0%     | 0%     |

Notes:

- 2020 has 162 matches (COVID-shortened season) - coverage is still 100%.
- 2026 is the in-progress current season. Fryzigg's coverage window ends
  at 2025. the AFL API sync does return weather for some 2026 rounds (see
  fixtures), but the current ingest path does not write it to
  `matches.weather_*`.
- All queries executed against `--remote` (production D1, database ID
  `fe1c1a89-805f-481d-9ba0-b9f8dee04a36`, region OC/MEL).

### Distinct Weather_type Values (All AFLM Non-Null Rows)

| weather_type  | count     |
| ------------- | --------- |
| MOSTLY_SUNNY  | 1,373     |
| RAIN          | 773       |
| OVERCAST      | 534       |
| SUNNY         | 272       |
| MOSTLY_CLEAR  | 116       |
| CLEAR_NIGHT   | 114       |
| WINDY         | 34        |
| ROOF_CLOSED   | 19        |
| THUNDERSTORMS | 18        |
| WINDY_RAIN    | 7         |
| **Total**     | **3,260** |

---

## 3. Upstream Field Comparison

Both sources expose only temperature and a categorical weather type.

### Fields D1 Holds Now

| Column           | Type | Source  | D1 coverage (AFLM)   |
| ---------------- | ---- | ------- | -------------------- |
| `weather_temp_c` | REAL | fryzigg | 100% for 2010 - 2025 |
| `weather_type`   | TEXT | fryzigg | 100% for 2010 - 2025 |

### Fields the Sources Expose

The fryzigg `FryziggClient.fetchPlayerStats` writer reads exactly two weather
columns: `match_weather_temp_c` (numeric) and `match_weather_type` (string).
Inspection of `scripts/enrich-fryzigg.ts` confirms no other weather columns. The
repository contains no additional fryzigg fixtures or data files that expose
other fields.

The fitzRoy-ts AFL CFS API uses `CfsWeatherSchema`
(`src/lib/validation/afl-api-cfs.ts:117-122`) declares:

```ts
z.object({
    tempInCelsius: z.number().nullable().optional(),
    weatherType: z.string().nullable().optional(),
}).passthrough();
```

The `.passthrough()` would preserve extra keys if present. Inspecting the two
available round fixtures:

- `test/fixtures/afl-api-round-1-2025.json`: weather objects contain
  `{ "description": "...", "tempInCelsius": N, "weatherType": "..." }`. The
  `description` is a free-text string (e.g. "Cloudy", "Shower or two") - not a
  structured numeric field.
- `test/fixtures/afl-api-round-10-2026.json`: weather objects contain only
  `{ "weatherType": "..." }` - no temp, no description.

No rainfall, wind speed, or humidity fields appear in any fixture. The
match-results transform (`src/transforms/match-results.ts:199-200`) maps only
`tempInCelsius` and `weatherType`.

Other fitzRoy-ts sources set `weatherTempCelsius` and `weatherType` to `null`.
The afl-tables, footywire, and squiggle sources carry no weather data.

### Side-by-Side Summary

| Field                 | D1 (current)     | fryzigg source         | AFL CFS API source                   |
| --------------------- | ---------------- | ---------------------- | ------------------------------------ |
| temp (°C)             | `weather_temp_c` | `match_weather_temp_c` | `tempInCelsius`                      |
| weather category      | `weather_type`   | `match_weather_type`   | `weatherType`                        |
| rainfall (mm)         | not present      | not present            | not present                          |
| wind speed            | not present      | not present            | not present                          |
| humidity              | not present      | not present            | not present                          |
| free-text description | not present      | not present            | present (passthrough, not extracted) |

Neither upstream source exposes discrete rainfall, wind, or humidity fields.

---

## 4. Pre-Registered Decision Rule

Recorded verbatim before examining coverage results:

> ENRICH iff the source provides either (a) materially denser coverage of the
> existing two fields (fills a season block 2016 - 2025 that is mostly null in
> D1), OR (b) at least one new field plausibly tied to scoring (rainfall or
> wind) at usable coverage (≥60% for seasons 2016 - 2025). OTHERWISE NO-ENRICH -
> D1 already holds what the source has. report current coverage to 002b and
> stop. NO-ENRICH is a valid, useful outcome.

---

## 5. Verdict

The pre-registered rule produces the following decision.

### Decision: No Enrichment

Reasoning:

- Condition (a) fails: D1 already has 100% coverage of `weather_type` and
  `weather_temp_c` for every completed AFLM season 2010 - 2025. There is no
  partially-null season block to fill.
- Condition (b) fails: Neither the fryzigg source nor the AFL CFS API exposes
  rainfall, wind speed, or humidity as discrete structured fields. The AFL CFS
  API `description` field is free-text and not structurally useful for a model
  feature.

The only genuine gap is the 2026 season, which has no weather coverage. Fixtures
confirm that the AFL CFS API returns `weatherType` for some 2026 rounds.
Populating it requires a new ingest path because fryzigg covers completed
seasons only. That separate schema decision requires maintainer approval.

The audit made no D1 writes and changed no source files or tipper content.

---

## Tipper MatchRow Impact

The no-enrichment verdict requires no new columns. Tipper's `MatchRow` already
declares `weather_temp_c: number | null` and `weather_type: string | null`, and
`queries.ts` already selects both columns. If a future ENRICH verdict added new
fields, extend `MatchRow` and the SELECT in `queries.ts`.

---

## Final Weather Coverage for Plan 002B

**100% of AFLM matches in 2021 - 2025 have non-null weather_type. 100% have
non-null weather_temp_c.**

(2021: 207/207, 2022: 207/207, 2023: 216/216, 2024: 216/216, 2025: 216/216 - all
seasons complete at 100%.)
