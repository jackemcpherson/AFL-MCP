# Data Sync

A single Cloudflare cron trigger drives updates for AFLM, AFLW, VFL, and VFLW.
The orchestrator in `src/sync/sync.ts` decides when to fetch and delegates
upserts to `src/sync/upserts.ts`. It recalculates PAV after AFLM or AFLW player
statistics change.

## Cron

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]
```

The cron fires every five minutes and dispatches
`sync(env, ["AFLM", "AFLW", "VFL", "VFLW"])`. There is no separate cron for full
syncs or for PAV - the orchestrator decides what to run on each tick.

## The `shouldRunNow` Gate

`shouldRunNow(now, env)` (in `src/sync/sync.ts`) is the only thing standing
between the cron and a fetch:

1. **Top of every hour** - always run. This guarantees a full hourly refresh
   regardless of fixture state.
2. **Otherwise** - run only if a match exists in the database within roughly
   `±3 days` of now (one day back, three days forward). The query is
   competition-agnostic, so the gate naturally covers the union of all four
   fixture windows.

The gate is date-granular and lives in code rather than in cron expressions, so
changing the polling cadence only requires touching one function.

## Pipeline (`syncCompetition`)

For each `(competition, year)` pair (cron uses current year. The backfill
endpoint iterates a year range):

1. **Fetch matches** for the season from the `afl-api` source.
2. **Ensure** competition + season rows exist. resolve `seasonId`. Unknown
   competitions (such as VFL on first sync after a fresh deploy) are auto-upserted
   via `ensureCompetition`.
3. **Detect new completed matches** by comparing the API's count of completed
   matches against `selectCompletedCount(seasonId)`, and asking
   `selectHasCompletedMatchWithoutStats(seasonId)` whether any previously
   completed match still lacks stats. The backlog
   check makes the pipeline self-healing: it recovers from same-day multi-match
   completions and from any partial write failure. Cron ticks limit lineup
   retries to rounds played in the last 14 days. This prevents repeated fetches
   for rosters that never publish upstream.
   Admin backfills lift the bound and sweep up to 40 lineup-less rounds per
   season.
4. **Conditionally fetch** lineups and player stats (if the API has more
   completed matches than the database, OR a stats backlog exists) - both in
   parallel. Select lineup rounds from freshly fetched upcoming fixtures
   within five days, including later matches in rounds already underway.
   Refresh every fifteen minutes, increasing to every five minutes within
   ninety minutes of an upcoming kickoff. A 404 is the expected
   not-yet-published state and does not write a `sync_log` error row.
5. **Quarantine** placeholder finals fixtures (`isPlaceholderTeamName`:
   "1st", "Winner of QF1", "Highest-ranked WF Winner", ...) so they never
   become team or match rows, then **upsert** teams, venues, players,
   matches, stats, lineups (in dependency
   order - `upserts.ts` handles the foreign-key wiring). Match upserts retain
   the AFL API's `completedQuarter` as nullable `completed_quarter` (0 - 4).
   `COALESCE` preserves the last authoritative value if the upstream clock is
   transiently absent.
6. **Recalculate PAV** when `statsAffected > 0` AND the competition is in
   `{AFLM, AFLW}` AND `skipPav` is not set. Skip VFL/VFLW because the AFL
   API does not populate the PAV formula's required inputs (`goal_assists`,
   `marks_inside_50`, `one_percenters`).
7. **Log** to `sync_log` only when the tick produced new stats or lineup rows.

The pipeline logs fetch errors to `sync_log` with `rows_affected = 0`, then
continues to the next `(competition, year)` pair.

## Publication Inputs

Match refresh stores `matches.kickoff_at` directly from the source match
instant as a canonical UTC timestamp. Unknown kickoff times remain `NULL`.
Never construct a deadline by joining the UTC `date` with Melbourne
`local_time`. Migration `0021` leaves legacy deadlines unavailable until a
source fixture refresh supplies them.

For AFLM and AFLW, a lineup replacement requires both complete team selections.
Validation checks resolved players, unique player identities, fixture ownership,
and the non-emergency team size: 23 for AFLM and 21 for AFLW. Interchange and
substitute players count toward those totals. Review the sizes against the
published 2027 rules before launch.

Each valid match snapshot replaces its lineup rows in one native D1 batch.
The replacement removes omitted players and records `matches.lineups_observed_at`
in UTC. Invalid, incomplete, or failed upstream responses preserve the previous
valid snapshot. The pre-2023 historical lineup guard remains in place.

Fixture identity, venue, or kickoff changes atomically invalidate current
`match_predictions` and Squiggle mappings, and clear lineup observation metadata.
Historical Tipper captures remain intact. Tipper owns its recorded kickoff locks.
A source correction cannot reopen a prediction after its recorded deadline.

AFL-MCP owns the additive publication migrations. Apply them before activating
the new Tipper Worker, then refresh forthcoming AFLM and AFLW fixtures. Tipper
writes through its native D1 binding and preserves the current prediction fields
used by AFL-MCP and FootyBot. See [the schema reference](./schema.md#match_predictions)
for the capture link and source revision identity.

## Weather Stage

At the top of each hour, the same lease covers the weather stage in
`src/weather/stage.ts`. The stage needs no separate cron or lease.

Upcoming matches within seven days receive an Open-Meteo forecast row. The stage
refreshes it daily and hourly on match day. Completed matches receive an interim
Historical Forecast row. After six days, the stage upgrades provenance to
`era5_land+era5`.

The stage removes rows for cancelled matches. It resolves coordinates through
`venues.canonical_venue_id` and requests `timezone=Australia/Melbourne`.

Weather failures add a bounded `sync:weather` row to `sync_log` without stopping
sync. The next hourly pass retries the work. Use `scripts/backfill-weather.ts`
for historical bulk loading.

## Backfill Endpoint

`POST /mcp/admin/backfill` exposes the same pipeline for one-shot historical
loads. Body:

```json
{
    "competitions": ["AFLM", "AFLW", "VFL", "VFLW"],
    "fromYear": 2021,
    "toYear": 2025,
    "skipShouldRunNow": true,
    "skipPav": false
}
```

`skipShouldRunNow` (default `true`) bypasses the cadence gate so the backfill
runs immediately. `skipPav` (default `false`) is useful for label-only re-syncs
(such as relabelling an existing AFLM season) where stats are not changing and
PAV recalculation would be wasteful.

The endpoint iterates `(competition, year)` pairs and returns per-tick results:

```json
{
    "status": "ok",
    "results": [
        {
            "competition": "AFLW",
            "year": 2024,
            "matches": 108,
            "stats": 4536,
            "lineups": 0
        }
    ]
}
```

Cloudflare Workers cap execution time at 30 seconds per request. The caller is
responsible for chunking year ranges. A single year per request is safe for
AFLM. The smaller competitions (AFLW, VFL, VFLW) can typically run a few years
in one call.

Cron, manual sync, and annual Brownlow ingestion share the single `sync_lease`
row. Acquisition is atomic, holders expire after ten minutes, and release checks
the holder. Contending syncs keep their established log-and-return behaviour.
Brownlow returns HTTP 409.

## Round Labels

The AFL season includes special rounds that do not follow standard numeric
ordering. The schema mirrors R fitzRoy's design: store the AFL API's round
labels directly, no cross-competition normalisation.

Two round-string columns on `matches`:

- `round` is the long form: `Round 1` - `Round N`, `Opening Round` (AFLM 2024+,
  `round_number = 0`), `Wildcard` (VFL only, before finals), and finals
  `Finals Week 1` / `Semi Finals` / `Preliminary Finals` / `Grand Final`.
  Pre-2020 AFLM finals retain the historical `Elimination Final` /
  `Qualifying Final` distinction the AFL collapsed in 2020.
- `round_abbreviation` is the AFL's short form: `Rd N`, `OR`, `WC`, `FW1`, `SF`,
  `PF`, `GF`, plus `EF`/`QF` for pre-2020 AFLM. Stable across all four
  competitions. Use this column for cross-competition queries.

`round_type` is `Regular` (home-and-away + Opening Round + Wildcard) or
`Finals`. `round_number` is a per-season ordinal continuous through finals. For
example, AFLM 2024 finals are 25 to 28, while AFLW 2025 finals are 13 to 16. VFL
2025 has Wildcard at 22, then finals 23 to 26. Round numbers do not align across
competitions - AFLM R1 is March, AFLW R1 is August, VFL R1 is April.

## PAV (Player Approximate Value)

`recalculatePav(env, competition, year?)` in `src/sync/pav.ts` writes to
`player_season_pav`. The sync pipeline runs it after updating player statistics
for AFLM or AFLW, unless `skipPav` is set.

Per-competition floor years are in `MIN_PAV_YEAR_BY_COMPETITION`
(`src/lib/constants.ts`):

- AFLM: 1998 - when Champion Data began tracking inside-50s, the
  league-normalising input the formula leans on most heavily.
- AFLW: 2017 - the inaugural AFLW season. AFL API populates the full PAV input
  set from the start.

VFL/VFLW have no PAV rows because `goal_assists`, `marks_inside_fifty`, and
`one_percenters` are not sufficiently complete for the formula. VFLW can have
sparse values in these fields, so their typed coverage expectation is
`best-effort`, not universally absent.

## Match Clock Context

The sync persists only the smallest authoritative clock state:
`completed_quarter` is `NULL` or 0 to 4. It does not store per-period clock
objects or transition timestamps. Consumers must pair the value with
`matches.status`. It reflects the five-minute sync cadence, not second-level
match timing. `live_period_status` remains raw upstream text.

`matches.local_time` remains Melbourne time (`Australia/Melbourne`) across all
competitions, matching the AFL API ecosystem convention. Venue-native time and
timezone are intentionally discarded.

## Brownlow Votes

fitzroy 3.4 parses AFL Tables `cells[16]` as `brownlowVotes` and returns season
scrapes in the partial-result envelope `{ stats, failedMatchIds }`.
[fitzRoy issue 117](https://github.com/jackemcpherson/fitzRoy-ts/issues/117)
tracks the completed parser work. Brownlow ingestion is an annual operation. The
expensive AFL Tables scrape does not belong in the five-minute sync.

`POST /mcp/admin/backfill-brownlow` accepts one or two AFLM seasons:

```json
{ "fromYear": 2025, "toYear": 2025, "dryRun": true }
```

`dryRun` defaults to true. The operation consumes both `stats` and
`failedMatchIds`. It resolves matches by date and canonical team without
choosing ambiguous player candidates. Every regular-season match must have
exactly six positive votes.

Any partial fetch, unresolved row, ambiguity, finals vote, or mixed total blocks
all seasons before the first update. A wholly unpublished season performs no
writes. Write mode uses batches of at most 100 parameterised updates guarded by
`brownlow_votes IS NULL OR brownlow_votes = 0`. It does not recalculate PAV.

The full contract is in
[`admin-operations-v2-design.md`](./admin-operations-v2-design.md).

The `upsertStats` path uses `COALESCE` on `brownlow_votes`, and the annual
backfill also writes only when the current value is NULL or zero. This keeps
repeated runs idempotent and prevents either path from clobbering an existing
vote. Brownlow votes are AFLM-only - the medal is not awarded for AFLW/VFL/VFLW.

## Private Operator Status

`GET /mcp/admin/status` returns a stable aggregate snapshot for all four
competitions. The snapshot includes whole-sync outcomes, completed match dates,
lease age, and all five integrity-view counts. It also reports 24-hour
partial-lineup, partial-stat, and unmapped-team event counts.

The endpoint uses nine fixed statements and one fixed window. It never returns
raw errors, lease holders, IDs, row samples, client data, or tokens. Public
health routes retain their small uptime contract.

Public health clears a competition-level error after a later successful sync
for that competition. Success in another competition or a lineup/stat sub-task
does not clear it. Error records remain in `sync_log`; fatal errors retain the
three-hour alert window.
