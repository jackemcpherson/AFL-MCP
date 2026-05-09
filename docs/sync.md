# Data Sync

A single Cloudflare cron trigger drives all data updates. Everything funnels
through one orchestrator (`src/sync/sync.ts`) which decides whether to fetch,
delegates upserts to `src/sync/upserts.ts`, and re-runs PAV when player stats
have changed.

## Cron

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]
```

The cron fires every five minutes. There is no separate cron for full syncs or
for PAV — the orchestrator decides what to run on each tick.

## The `shouldRunNow` gate

`shouldRunNow(now, env)` (in `src/sync/sync.ts`) is the only thing standing
between the cron and a fetch:

1. **Top of every hour** — always run. This guarantees a full hourly refresh
   regardless of fixture state.
2. **Otherwise** — run only if a match exists in the database within roughly
   `±3 days` of now (one day back, three days forward). This window is
   intentionally wide enough to pick up Thursday-evening lineup releases for
   the upcoming weekend and to keep polling completed games for late-arriving
   stats.

The gate is date-granular and lives in code rather than in cron expressions,
so changing the polling cadence only requires touching one function.

## Pipeline (`syncCompetition`)

For each competition (default: `["AFLM"]`):

1. **Fetch matches** for the current season from the `afl-api` source.
2. **Ensure** competition + season rows exist; resolve `seasonId`.
3. **Detect new completed matches** by comparing the API's max completed date
   against `selectMaxCompletedDate(seasonId)`. In parallel, ask
   `selectNextRound(seasonId)` for the next round needing lineups.
4. **Conditionally fetch** lineups (if a next round exists) and player stats
   (if new completed matches exist) — both in parallel.
5. **Upsert** teams, venues, players, matches, stats, lineups (in dependency
   order — `upserts.ts` handles the foreign-key wiring).
6. **Recalculate PAV** when `statsAffected > 0`. Important: this is gated on
   actually-changed rows, not on `stats.length`, because the AFL API returns
   the full season every time.
7. **Log** to `sync_log` only when the tick produced new stats or lineup rows.

Errors at any fetch step are logged to `sync_log` with `rows_affected = 0` and
the pipeline continues to the next competition.

## AFL season structure

The AFL season includes special rounds that don't follow standard numeric
ordering. When writing freshness checks, ETL logic, or match queries, **never
filter or group by round name/number alone** — always use date-based or total
match-count comparisons:

- **Opening Round** — played before Round 1 (typically 4–5 games). Stored as
  `round = 'Opening Round'`, `round_number = 0`.
- Numbered rounds use short codes: `R1`, `R2`, …
- Finals: `QF`, `EF`, `SF`, `PF`, `GF`.
- `round_type` is either `'Regular'` or `'Finals'`.

## PAV (Player Approximate Value)

PAV is recomputed by `recalculatePav(env)` (`src/sync/pav.ts`) and written to
the `player_season_pav` table. It is only triggered from inside the sync
pipeline when at least one player-stat row was actually updated, which keeps
the cron cheap during off-season and quiet match weeks.

## Brownlow votes

Currently absent for completed matches: `fitzroy` does not yet wire
`cells[16]` from AFL Tables into `brownlowVotes`. Tracked at
[fitzroy-ts#117](https://github.com/jackemcpherson/fitzRoy-ts/issues/117).
The `upsertStats` path uses `COALESCE` on `brownlow_votes`, so when the npm
fix lands a one-off historical backfill (`fetchPlayerStats({ source:
"afl-tables", season })`) can run without clobbering current-season values.
