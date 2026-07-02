# Weather 2026 Ingest Spike

**Date**: 2026-07-02
**Branch**: `advisor/010-spike-2026-weather`
**fitzroy version tested**: 3.0.1 (pinned in package.json, matches deployed)
**Method**: Live `fetchMatches({ source: "afl-api" })` probe against AFL API, two seasons

---

## Probe Results

Script run from worktree root using `bun probe-tmp.ts` (deleted before commit).
Probe function: `fetchMatches({ source: "afl-api", season: N, competition: "AFLM" })`.

### 2026 (primary — the gap under investigation)

```json
{
  "season": 2026,
  "total": 207,
  "withType": 0,
  "withTemp": 0,
  "byStatus": {
    "Complete": { "n": 135, "type": 0, "temp": 0 },
    "Live":     { "n": 1,   "type": 0, "temp": 0 },
    "Upcoming": { "n": 71,  "type": 0, "temp": 0 }
  }
}
```

### 2025 (control — expected to match D1's 100% coverage if live API carried weather)

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

## Case Determination: **Case B**

Both seasons return `withType === 0` and `withTemp === 0`. The afl-api
match-results payload carries no weather for any match status or season.

This is conclusive evidence for **Case B**: the AFL API's `matchItems/round`
endpoint does not include the weather field in its live response, making the
gap entirely upstream of AFL-MCP.

---

## Technical Trace

fitzroy 3.0.1's afl-api path (`node_modules/fitzroy/dist/index.js`):

1. `fetchMatches({ source: "afl-api", season, competition })` resolves the
   compseason ID, then calls `fetchSeasonMatchItems`.
2. `fetchSeasonMatchItems` iterates all rounds and calls `fetchRoundMatchItems`
   for each, hitting:

   ```
   GET https://api.afl.com.au/cfs/afl/matchItems/round/{roundProviderId}
   ```

3. Response items are parsed with `MatchItemSchema`, which includes:

   ```ts
   weather: CfsWeatherSchema.nullable().optional()
   // CfsWeatherSchema: { tempInCelsius?: number | null; weatherType?: string | null }
   ```

4. The transform reads:

   ```ts
   weatherTempCelsius: item.weather?.tempInCelsius ?? null,  // index.js:1045
   weatherType:        item.weather?.weatherType  ?? null,   // index.js:1046
   ```

The schema is wired correctly. The AFL API's `/matchItems/round/{id}` endpoint
simply does not include a `weather` field in its response for either 2025 or
2026. fitzroy correctly returns null via the `?.` optional chain.

**Implication for D1**: the 100% weather coverage in D1 for AFLM 2010-2025
came exclusively from the one-off fryzigg enrichment script
(`scripts/enrich-fryzigg.ts`), not the live sync. The live sync has never
written a non-null weather value to D1. AFL-MCP's write path is sound — the
coalesce columns (`src/sync/upserts.ts:485-486`) would pick up weather the
moment fitzroy begins returning it.

---

## Recommendation

### File an upstream issue on fitzRoy-ts

The AFL API fixture snapshots in fitzRoy-ts's test suite
(`afl-api-round-1-2025.json`, `afl-api-round-10-2026.json`) show that weather
objects do exist in the AFL API ecosystem. The 2025 fixture has
`{ "description": "...", "tempInCelsius": N, "weatherType": "..." }`; the 2026
fixture has `{ "weatherType": "..." }` (no temp — may indicate AFL API stopped
including temp in newer seasons). These fixtures are presumably captured from
the same `/matchItems/round/{id}` endpoint, which suggests the AFL API returns
weather intermittently — possibly only in the live-match window (status
`LIVE`/`INPROGRESS`), not in post-match results.

**Suggested issue text for fitzRoy-ts**:

---

**Title**: `afl-api` source: weather fields are always null in `fetchMatches` output

**Description**:

`fetchMatches({ source: "afl-api" })` returns `weatherType: null` and
`weatherTempCelsius: null` for all matches in at least 2025 (all 216 complete)
and 2026 (all 207, across Complete/Live/Upcoming). The transform in
`src/transforms/match-results.ts` is wired correctly (`item.weather?....`), so
the AFL API's `/cfs/afl/matchItems/round/{roundProviderId}` endpoint is not
returning a `weather` field in its live responses.

Test fixtures in the repo (`afl-api-round-1-2025.json`) do contain weather
objects, which suggests the API either:

- Returns weather only during the live match window (not preserved post-match),
  so historical and completed-season queries always get null; **or**
- Moved weather to a separate endpoint (e.g. a round-detail or fixture endpoint)
  not currently fetched.

**Request**: Investigate which AFL API endpoint carries weather reliably
post-match and either (a) join it into the `fetchRoundMatchItems` response
before the transform, or (b) add a dedicated `fetchRoundWeather` call in
`fetchSeasonMatchItems` and merge weather by match ID.

**Expected `Match` semantics**: `weatherType` should be a string like
`"MOSTLY_SUNNY"` / `"RAIN"` / `"OVERCAST"` for completed matches; `null` is
acceptable for `Upcoming` matches where the AFL API has not yet published a
forecast.

**Observed values known to be valid** (from separate data source):
`MOSTLY_SUNNY`, `RAIN`, `OVERCAST`, `SUNNY`, `MOSTLY_CLEAR`, `CLEAR_NIGHT`,
`WINDY`, `ROOF_CLOSED`, `THUNDERSTORMS`, `WINDY_RAIN`.

**Note on `tempInCelsius`**: the 2026 fixture snapshot already shows
`weatherType` present but `tempInCelsius` absent, so any fix should treat temp
as always nullable and not regress the `weatherType`-only case.

---

### AFL-MCP: no code change needed

Once fitzroy ships the fix, AFL-MCP's existing coalesce write path will fill
2026+ weather on the next 5-minute sync tick with no changes required.

### Schema doc note (do not edit in this spike)

After the fix ships and D1 starts receiving weather, update
`src/mcp/tools/schema.ts`:

- Line 153: change `"Populated 2010-2025."` to reflect the new coverage window
  (e.g. `"Populated 2010-2025 via fryzigg backfill; live afl-api sync fills
  2026+ once upstream fix ships."`).
- Lines 179-187 (`column_coverage` for `matches.weather_temp_c` and
  `matches.weather_type`): change `to: 2025` to `to: "current"` and update the
  `notes` field accordingly.

---

## Open Questions

| Question | Who decides |
|----------|-------------|
| Does the AFL API return weather at any point for completed matches, or only during the live window? A curl of a known-historical `roundProviderId` during a live match would confirm. | fitzRoy-ts maintainer (needs live-window observation) |
| Should `weatherTempCelsius` be dropped from D1 write path and schema doc if the 2026 AFL API fixture confirms temp is no longer included? | Repo maintainer; wait for upstream investigation |
| Is the 2010-2025 fryzigg-sourced weather worth a re-backfill if the AFL API starts returning data for those years? Historical coverage is already complete; probably not worth it. | Repo maintainer |
