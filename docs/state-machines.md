# State Machines

The Worker persists a handful of lifecycles in D1. Each has one module that
owns its transitions. Change a lifecycle there, not at a call site.

## Operation Lease and Public Write Marker

Owner: `runOperation` in `src/db/operation.ts`. Every cron tick and admin
operation runs through it.

| Machine      | Stored in               | States                                      |
| ------------ | ----------------------- | ------------------------------------------- |
| Lease        | `sync_lease`            | free, held, stale after `LEASE_TTL_MINUTES` |
| Write marker | `public_input_revision` | idle, writing, stranded                     |

A stranded marker has a writer that no longer holds the lease. That state is
deliberate: it is the recovery checkpoint, and readers treat it as "inputs are
changing".

| Operation body            | Marker    | Lease    |
| ------------------------- | --------- | -------- |
| returns without `write()` | untouched | released |
| returns after `write()`   | cleared   | released |
| throws after `write()`    | stranded  | released |

Only an operation that names the same identity and resumes may take over a
stranded marker. Identities are `sync:steady:<competitions>`,
`sync:<scopes>`, `stats:<operationId>`, `weather:<digest>`,
`identity:<digest>`, `pav:<seasonId>:<digest>`, `bears:<digest>`,
`brownlow:<from>:<to>` and `coaching:<source>:<season>`. The steady-state
sync resumes its own. Everything else needs an explicit `resume`.

`operation.settle()` covers the one gap between an operation's last write and
clearing the marker: repeating a completed operation fails until the caller
passes `resume`.

## Match Lifecycle

Owner: `src/lib/match-state.ts`. The provider sets `matches.status` and the
sync stores it as delivered.

| Question                     | Predicate        | Status        |
| ---------------------------- | ---------------- | ------------- |
| Did it finish with a result? | `playedMatch`    | `Complete`    |
| Will it never be played?     | `cancelledMatch` | `Cancelled`   |
| Is its outcome still open?   | `unsettledMatch` | anything else |

Scores are not a lifecycle signal. A `Live` row has a partial score and a
`Cancelled` row has none. `seasons.is_complete` follows from this lifecycle:
a season is complete when it has matches and every one has settled.

## Sync Tick

Owner: `sync` in `src/sync/sync.ts`. `steadySeasons` decides its scope: each
competition's current season plus any later season, so a new fixture loads
before its first match. The tick's scheduled time decides its stages. Every
tick syncs fixtures and lineups and rebuilds queued PAV. `isHourlyTick` adds
statistics refresh, coaching and weather.

Each tick derives lineup polling, with no stored state. It fetches nothing
more than five days out, then every 15 minutes, then every five minutes in the
last 90 minutes. A backlog retry covers played matches without lineups (three
rounds, 14 days).

## Statistics Refresh Schedule

Owner: `nextStatsRefresh` in `src/sync/stats-refresh.ts`. Stored in
`match_stats_refresh`.

| Phase   | Condition                         | Next fetch                   |
| ------- | --------------------------------- | ---------------------------- |
| retry   | `failures > 0`                    | 1, 2, 4, 8, 16, 24 hours     |
| hourly  | under 2 days since first observed | in an hour                   |
| daily   | under 14 days                     | in a day                     |
| final   | under 30 days                     | at day 30                    |
| done    | otherwise, or a historical import | never (`next_retry_at` NULL) |

`origin` names the driver. The cron fetches `scheduled` rows. An `operator`
row waits for a backfill or an approved refresh.

## Weather

Owner: `src/weather/stage.ts`. A match's weather moves through
`match_weather.source`: forecast (`best_match`), interim observed
(`historical_forecast`), final (`era5_land+era5`). Cancelling a match deletes
its rows. A changed kickoff or venue resets them by trigger.

Each fetch has a retry state in `weather_refresh_state`: clear, backing off,
or unavailable. `nextWeatherRetry` is the whole policy.

| Kind     | Retry                    | Gives up                                   |
| -------- | ------------------------ | ------------------------------------------ |
| forecast | 1, 2, 4, 8, 16, 24 hours | never                                      |
| observed | daily                    | after three retries, until `retry-weather` |

## PAV Rebuild Queue

Owner: database triggers enqueue, `rebuildQueuedStatsPav` drains. A row in
`pav_rebuild_queue` means the season's PAV is stale. `reason` is `statistics`
or `identity:<digest>`. A season's PAV values are absent, NULL (inputs
incomplete) or computed.

## Operator Operations

Each follows preview, approve by digest, apply, and resume if interrupted.

| Operation                                | Stored in                         | States                               |
| ---------------------------------------- | --------------------------------- | ------------------------------------ |
| Statistics refresh                       | `stats_refresh_operation_matches` | pending, complete per match          |
| Weather repair                           | `weather_repair_operations`       | pending, complete                    |
| Identity repair                          | `identity_repair_operations`      | `prepared`, `reparented`, `complete` |
| PAV, Bears, Brownlow, coaching, backfill | write marker identity only        | writing, stranded                    |

## Coaching Import

Owner: `runCoachBatch` in `src/admin/coaching.ts`. A source cycle pages
through `coach_backfill_progress.cursor`, then ingests and clears it.
`coach_import_pages.status` is `success` (recheck in 24 hours), `partial` or
`failed` (recheck in three hours).
