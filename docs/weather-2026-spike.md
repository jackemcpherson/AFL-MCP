# Weather 2026 Ingest Spike

This spike ran on 2026-07-02 against fitzroy 3.0.1, matching the deployed
version. It used live AFL API probes for the 2025 and 2026 seasons.

---

## Probe Results

Script run from worktree root using `bun probe-tmp.ts` (deleted before commit).
Probe function:
`fetchMatches({ source: "afl-api", season: N, competition: "AFLM" })`.

### 2026 (Primary - the Gap Under Investigation)

```json
{
    "season": 2026,
    "total": 207,
    "withType": 0,
    "withTemp": 0,
    "byStatus": {
        "Complete": { "n": 135, "type": 0, "temp": 0 },
        "Live": { "n": 1, "type": 0, "temp": 0 },
        "Upcoming": { "n": 71, "type": 0, "temp": 0 }
    }
}
```

### 2025 (Control - Expected to Match D1's 100% Coverage If Live API Carried Weather)

```json
{
    "season": 2025,
    "total": 216,
    "withType": 0,
    "withTemp": 0,
    "byStatus": {
        "Complete": { "n": 216, "type": 0, "temp": 0 }
    }
}
```

---

## Case Determination: Case B

Both seasons return `withType === 0` and `withTemp === 0`. The afl-api
match-results payload carries no weather for any match status or season.

These results confirm Case B. The AFL API's `matchItems/round` endpoint omits
the weather field from live responses, placing the gap upstream of AFL-MCP.

---

## Technical Trace

fitzroy 3.0.1's afl-api path (`node_modules/fitzroy/dist/index.js`):

1. `fetchMatches({ source: "afl-api", season, competition })` resolves the
   compseason ID, then calls `fetchSeasonMatchItems`.
2. `fetchSeasonMatchItems` iterates all rounds and calls `fetchRoundMatchItems`
   for each, hitting:

    ```text
    GET https://api.afl.com.au/cfs/afl/matchItems/round/{roundProviderId}
    ```

3. Response items are parsed with `MatchItemSchema`, which includes:

    ```ts
    weather: CfsWeatherSchema.nullable().optional(),
    ```

4. The transform reads:

    ```ts
    weatherTempCelsius: item.weather?.tempInCelsius ?? null,  // index.js:1045
    weatherType:        item.weather?.weatherType  ?? null,   // index.js:1046
    ```

The schema correctly accepts weather data. The AFL API omits `weather` from the
2025 and 2026 round responses. Fitzroy correctly returns null through the `?.`
optional chain.

**Implication for D1**: the 100% weather coverage in D1 for AFLM 2010-2025 came
exclusively from the one-off fryzigg enrichment script
(`scripts/enrich-fryzigg.ts`), not the live sync. The live sync has never
written a non-null weather value to D1. AFL-MCP's write path is sound - the
coalesce columns (`src/sync/upserts.ts:485-486`) would pick up weather the
moment fitzroy begins returning it.

---

## Recommendation

Track the intermittent upstream weather data and leave AFL-MCP unchanged.

### File an Upstream Issue on fitzRoy-Ts

The AFL API fixture snapshots in fitzRoy-ts's test suite
(`afl-api-round-1-2025.json`, `afl-api-round-10-2026.json`) show that weather
objects do exist in the AFL API ecosystem. The 2025 fixture contains a
description, temperature, and weather type. The 2026 fixture contains only a
weather type, which may indicate a change in newer seasons.

Both fixtures appear to use the same endpoint. The API may return weather only
during the live-match window and omit it from later results.

The following draft captures the proposed fitzRoy-ts issue.

---

#### Proposed Title

`afl-api` source: weather fields are always null in `fetchMatches` output

#### Proposed Description

`fetchMatches({ source: "afl-api" })` returns `weatherType: null` and
`weatherTempCelsius: null` for all matches in at least 2025 (all 216 complete)
and 2026 (all 207, across Complete, Live, and Upcoming). The transform in
`src/transforms/match-results.ts` handles the field correctly. The AFL API's
round endpoint does not return `weather` in its live responses.

Test fixtures in the repo (`afl-api-round-1-2025.json`) do contain weather
objects, which suggests the API either:

- Returns weather only during the live match window, so later queries get null.
- Moved weather to a separate round-detail or fixture endpoint not currently
  fetched.

Investigate which AFL API endpoint carries reliable post-match weather. Either
join it into `fetchRoundMatchItems` or merge a dedicated weather response by
match ID in `fetchSeasonMatchItems`.

For completed matches, `weatherType` should contain values such as
`MOSTLY_SUNNY`, `RAIN`, or `OVERCAST`. Upcoming matches may use `null` before
the AFL API publishes a forecast.

The separate source contains these known values: `MOSTLY_SUNNY`, `RAIN`,
`OVERCAST`, `SUNNY`, `MOSTLY_CLEAR`, `CLEAR_NIGHT`, `WINDY`, `ROOF_CLOSED`,
`THUNDERSTORMS`, `WINDY_RAIN`.

The 2026 fixture includes `weatherType` without `tempInCelsius`. Any fix must
keep temperature nullable and preserve weather-type-only responses.

---

### AFL-MCP: No Code Change Needed

Once fitzroy ships the fix, AFL-MCP's existing coalesce write path will fill
2026+ weather on the next 5-minute sync tick with no changes required.

### Schema Doc Note (Do Not Edit in This Spike)

After the fix ships and D1 starts receiving weather, update
`src/mcp/tools/schema.ts`:

- Line 153: change `"Populated 2010-2025."` to reflect the new coverage window.
  One suitable replacement follows:

  ```text
  Populated 2010-2025 via fryzigg backfill. Live afl-api sync fills 2026+
  after the upstream fix ships.
  ```

- Lines 179-187 (`column_coverage` for `matches.weather_temp_c` and
  `matches.weather_type`): change `to: 2025` to `to: "current"` and update the
  `notes` field accordingly.

---

## Open Questions

| Question                                                                                                                                                                              | Who decides                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Does the AFL API return weather at any point for completed matches, or only during the live window? A curl of a known-historical `roundProviderId` during a live match would confirm. | fitzRoy-ts maintainer (needs live-window observation) |
| Should `weatherTempCelsius` be dropped from D1 write path and schema doc if the 2026 AFL API fixture confirms temp is no longer included?                                             | Repo maintainer. wait for upstream investigation      |
| Is the 2010-2025 fryzigg-sourced weather worth a re-backfill if the AFL API starts returning data for those years? Historical coverage is already complete. probably not worth it.    | Repo maintainer                                       |
