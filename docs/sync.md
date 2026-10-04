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

Each pass uses an exact competition-season selector. Cron discovers the active
season for each competition.
Backfills accept explicit season keys, including `2022-S6` and `2022-S7` for
AFLW.

1. Fetch the season inventory from `afl-api`. Store its raw snapshot separately
   from reviewed fixture corrections.
2. Resolve the competition and season IDs. Preserve existing IDs and record the
   provider season link.
3. Select upcoming lineup rounds within five days and completed rounds with
   missing lineups.
   Cron limits historical lineup retries to three rounds from the last 14 days.
   Admin backfills select up to 40 rounds.
4. Fetch the selected lineups. Upcoming snapshots refresh every fifteen minutes,
   or every five minutes within ninety minutes of kickoff.
   A provider 404 means the roster has not published. It does not erase a stored
   snapshot.
5. Quarantine placeholder finals participants. Upsert teams, venues, players,
   fixtures and validated lineups in dependency order.
6. Queue recent completed matches for statistics refresh. Hourly passes fetch at
   most 20 due matches across competitions.
   Admin backfills queue their exact season and also fetch at most 20 matches
   per pass.
   Each match has persisted success, failure and retry checkpoints. Match-count
   increases do not gate corrections.
7. Rebuild changed statistics' PAV seasons before clearing the public write
   marker.
   A pass rebuilds at most 20 queued seasons. Remaining rebuilds fail the pass
   and retain the marker for explicit recovery.
   AFLM and AFLW use the canonical formula. Other competitions retain unknown
   derived values where required inputs lack verification.
8. Run hourly coaching and weather work under the same lease, then finish the
   public write marker.
   Finalisation failures propagate and retain the marker. The lease releases
   even when finalisation fails.

Provider statistics failures retain successful match results and persist
retries.
Database failures retain the public write marker and require recovery with the
identical operation scope.

## Publication Inputs

Match refresh stores `matches.kickoff_at` directly from the source match
instant as a canonical UTC timestamp. Unknown kickoff times remain `NULL`.
Never construct a deadline by joining the UTC `date` with Melbourne
`local_time`. Migration
[0021](https://github.com/jackemcpherson/AFL-MCP/blob/migrations-pre-baseline/src/db/migrations/0021_tipper_publication.sql)
leaves legacy deadlines unavailable until a
source fixture refresh supplies them.

For AFLM and AFLW, a lineup replacement requires both complete team selections.
Validation checks resolved players, unique player identities, fixture ownership,
and the non-emergency team size: 23 for AFLM and 21 for AFLW. Interchange and
substitute players count toward those totals. Review the sizes against the
published 2027 rules before launch.

Each valid match snapshot replaces its lineup rows in one native D1 batch.
The replacement removes omitted players and records
`matches.lineups_observed_at`
in UTC. Invalid, incomplete, or failed upstream responses preserve the previous
valid snapshot. The pre-2023 historical lineup guard remains in place, with the
corroborated
AFLW season-seven exception described in the schema guide.

Fixture identity, venue, or kickoff changes atomically invalidate current
`match_predictions` and Squiggle mappings, and clear lineup observation
metadata.
Historical Tipper captures remain intact. Tipper owns its recorded kickoff
locks.
A source correction cannot reopen a prediction after its recorded deadline.

AFL-MCP owns the additive publication migrations. Apply them before activating
the new Tipper Worker, then refresh forthcoming AFLM and AFLW fixtures. Tipper
writes through its native D1 binding and preserves the current prediction fields
used by AFL-MCP and FootyBot. See [the schema
reference](./schema.md#match_predictions)
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

Provider weather failures persist diagnostics and daily retry schedules.
After the initial failure and three unsuccessful daily retries, observations
remain unavailable.
The authenticated `retry-weather` operation previews an exact match before
scheduling another attempt.
Database failures propagate and retain the public marker.
`scripts/backfill-weather.ts` captures sources and produces review artefacts. It
does not write production weather.

## Backfill Endpoint

`POST /mcp/admin/backfill` exposes the same pipeline for one-shot historical
loads. Body:

```json
{
    "competition": "AFLW",
    "season": "2022-S7",
    "skipShouldRunNow": true
}
```

`skipShouldRunNow` (default `true`) bypasses the cadence gate so the backfill
runs immediately. PAV rebuilds only when its inputs change. The major release
removes `skipPav`. Requests containing it fail validation. Set `resume: true`
to recover an interrupted operation with the identical competition-season scope.

The endpoint returns results for each exact competition-season scope:

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

Use one exact competition-season per request and repeat bounded statistics
refresh operations until their remaining count reaches zero.
Lineup and provider work can exceed an individual request's limits. A failed
marked operation requires explicit recovery.

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
for AFLM or AFLW through the persisted rebuild queue.

Cancelled and live matches do not contribute to PAV. Missing completed-match
scores, required inputs
or a missing team participant population leave derived season values null.
The model does not interpret unknown statistics as measured zeroes.

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

## Match Coaches

The hourly path may refresh AFL Tables match-coach facts for the active AFLM
season while holding the existing sync lease. Successful checks recur every 24
hours. Incomplete or failed checks retry every three hours. Five-minute cron
ticks do not fetch coach career pages again.
The sync logs coaching failures and continues score, lineup, statistics,
weather and PAV work.

`POST /mcp/admin/backfill-coaches` accepts one AFLM season per request:

```json
{ "fromYear": 2024, "toYear": 2024, "source": "afl-tables", "dryRun": true }
```

Years must be 1990 or later. FootyWire season-wide coaching requires captured
match headings to establish coverage. Dry-run is the default.

Repeating a request is idempotent by provider key. Stored page status records
the latest outcome. AFL Tables alone writes canonical `match_coaches` rows.

FootyWire observations remain separate. A partial unbounded import can add
successful
observations and assignments but cannot remove prior canonical facts. A fully
successful AFL Tables season pass can remove stale canonical facts absent from
the source snapshot. The importer records unresolved or contradictory joins
for review.

The admin route stages bounded profile batches and returns `pending: true`
until the season source cycle finishes. Repeat write-mode requests to resume.
Dry-run requests do not persist a cursor or advance an existing checkpoint.

`POST /mcp/admin/reconcile-bears` returns a dry-run count report by default.
After review, write mode moves AFLM matches through 1996 from the legacy Lions
team ID to a separate Brisbane Bears team ID. It updates match rows, player
statistics, lineups, PAV, and coaching team references. The operation keeps
match IDs and provider mappings stable. Season-aware normalisation prevents
future syncs from folding those facts back into Brisbane Lions. ELO continuity
belongs to downstream consumers.

## Private Operator Status

`GET /mcp/admin/status` returns a stable aggregate snapshot for all four
competitions. The snapshot includes whole-sync outcomes, completed match dates,
lease age, and all five integrity-view counts. It also reports 24-hour
partial-lineup, partial-stat, and unmapped-team event counts.

The endpoint uses thirteen fixed statements and one fixed window. It includes
aggregate coaching last-success, failed-scope, unresolved-join, disagreement,
and active-season assignment counts. It never returns raw errors, lease
holders, IDs, row samples, client data, or tokens. Public health routes retain
their small uptime contract.

Coaching backfill fetches at most five AFL Tables coach profiles per request,
plus the initial index request. `coach_backfill_progress` stores the opaque
season-specific cursor and staged source assignments. Failed pages return to
the retry queue. Pending responses include `pending: true` and do not update
canonical facts or remove season assignments. Repeated authenticated requests
resume the cursor under the shared lease. Active-season sync continues pending
cycles before applying the normal successful-check cadence.

The final batch reconciles the combined season evidence before any coach or
match mapping write. It rejects duplicate participant assignments and verifies
both participant names and corresponding scores in either orientation. Only a
complete authoritative season permits canonical removals. Unresolved imports
retain their diagnostics for review. A returned final summary clears the page
checkpoint, including unresolved imports, so the next cycle can fetch
corrections
from earlier profiles. A thrown write failure retains its checkpoint for retry.

Public health clears a competition-level error after a later successful sync
for that competition. Success in another competition or a lineup/stat sub-task
does not clear it. Error records remain in `sync_log`. Fatal errors retain the
three-hour alert window.

Bears identity repair changes match participants through the existing fixture
trigger. That trigger invalidates current `match_predictions` and
`tipper_game_ids` mappings. Append-only `tipper_predictions` retain the team
identities from the original prediction. A later source refresh
rebuilds current mappings. Historical snapshots never become identity-repair
inputs.

### Historical Statistics Queue

The recent 30-day queue marks admitted fixtures as scheduled work without
resetting existing retry deadlines. Those fixtures retain their full schedule
from first observed completion, including day 30 and failure retries.
Historical checkpoints default to operator work and remain available to
exact-season and approved requests. They cannot consume the hourly refresh
budget or trigger a historical import when scheduled writes resume.
