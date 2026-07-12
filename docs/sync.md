# Data Sync

A single Cloudflare cron trigger drives all data updates across all four
competitions (AFLM, AFLW, VFL, VFLW). Everything funnels through one
orchestrator (`src/sync/sync.ts`) which decides whether to fetch, delegates
upserts to `src/sync/upserts.ts`, and re-runs PAV when player stats have
changed for the PAV-supported competitions (AFLM and AFLW).

## Cron

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]
```

The cron fires every five minutes and dispatches `sync(env, ["AFLM", "AFLW",
"VFL", "VFLW"])`. There is no separate cron for full syncs or for PAV — the
orchestrator decides what to run on each tick.

## The `shouldRunNow` gate

`shouldRunNow(now, env)` (in `src/sync/sync.ts`) is the only thing standing
between the cron and a fetch:

1. **Top of every hour** — always run. This guarantees a full hourly refresh
   regardless of fixture state.
2. **Otherwise** — run only if a match exists in the database within roughly
   `±3 days` of now (one day back, three days forward). The query is
   competition-agnostic, so the gate naturally covers the union of all four
   fixture windows.

The gate is date-granular and lives in code rather than in cron expressions,
so changing the polling cadence only requires touching one function.

## Pipeline (`syncCompetition`)

For each `(competition, year)` pair (cron uses current year; the backfill
endpoint iterates a year range):

1. **Fetch matches** for the season from the `afl-api` source.
2. **Ensure** competition + season rows exist; resolve `seasonId`. Unknown
   competitions (e.g. VFL on first sync after a fresh deploy) are auto-upserted
   via `ensureCompetition`.
3. **Detect new completed matches** by comparing the API's count of completed
   matches against `selectCompletedCount(seasonId)`, and asking
   `selectHasCompletedMatchWithoutStats(seasonId)` whether any previously
   completed match still lacks stats. In parallel, ask
   `selectNextRound(seasonId)` for the next round needing lineups. The backlog
   check makes the pipeline self-healing: it recovers from same-day multi-match
   completions and from any partial write failure.
4. **Conditionally fetch** lineups (if a next round exists) and player stats
   (if the API has more completed matches than the database, OR a stats
   backlog exists) — both in parallel.
5. **Upsert** teams, venues, players, matches, stats, lineups (in dependency
   order — `upserts.ts` handles the foreign-key wiring). Match upserts retain
   the AFL API's `completedQuarter` as nullable `completed_quarter` (0–4).
   `COALESCE` preserves the last authoritative value if the upstream clock is
   transiently absent.
6. **Recalculate PAV** when `statsAffected > 0` AND the competition is in
   `{AFLM, AFLW}` AND `skipPav` is not set. VFL/VFLW are skipped because the
   AFL API doesn't populate the PAV formula's required inputs
   (`goal_assists`, `marks_inside_50`, `one_percenters`).
7. **Log** to `sync_log` only when the tick produced new stats or lineup rows.

Errors at any fetch step are logged to `sync_log` with `rows_affected = 0` and
the pipeline continues to the next `(competition, year)` pair.

## Backfill endpoint

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
(e.g. relabelling an existing AFLM season) where stats aren't changing and PAV
recalculation would be wasteful.

The endpoint iterates `(competition, year)` pairs and returns per-tick results:

```json
{
  "status": "ok",
  "results": [
    { "competition": "AFLW", "year": 2024, "matches": 108, "stats": 4536, "lineups": 0 }
  ]
}
```

Cloudflare Workers cap walltime at 30 seconds per request; the caller is
responsible for chunking year ranges. A single year per request is safe for
AFLM; the smaller competitions (AFLW, VFL, VFLW) can typically run a few years
in one call.

## Round labels

The AFL season includes special rounds that don't follow standard numeric
ordering. The schema mirrors R fitzRoy's design: store the AFL API's round
labels directly, no cross-competition normalisation.

Two round-string columns on `matches`:

- `round` is the long form: `Round 1`–`Round N`, `Opening Round` (AFLM 2024+,
  `round_number = 0`), `Wildcard` (VFL only, before finals), and finals
  `Finals Week 1` / `Semi Finals` / `Preliminary Finals` / `Grand Final`.
  Pre-2020 AFLM finals retain the historical `Elimination Final` /
  `Qualifying Final` distinction the AFL collapsed in 2020.
- `round_abbreviation` is the AFL's short form: `Rd N`, `OR`, `WC`, `FW1`,
  `SF`, `PF`, `GF`, plus `EF`/`QF` for pre-2020 AFLM. Stable across all four
  competitions; the right column for cross-competition queries.

`round_type` is `Regular` (home-and-away + Opening Round + Wildcard) or
`Finals`. `round_number` is a per-season ordinal continuous through finals
(e.g. AFLM 2024 finals are 25–28; AFLW 2025 finals are 13–16; VFL 2025 has
Wildcard at 22 then finals 23–26). Round numbers don't align across
competitions — AFLM R1 is March, AFLW R1 is August, VFL R1 is April.

## PAV (Player Approximate Value)

PAV is recomputed by `recalculatePav(env, competition, year?)`
(`src/sync/pav.ts`) and written to the `player_season_pav` table. It is only
triggered from inside the sync pipeline when at least one player-stat row was
actually updated, the competition is `AFLM` or `AFLW`, and `skipPav` is not
set.

Per-competition floor years are in
`MIN_PAV_YEAR_BY_COMPETITION` (`src/lib/constants.ts`):

- AFLM: 1998 — when Champion Data began tracking inside-50s, the
  league-normalising input the formula leans on most heavily.
- AFLW: 2017 — the inaugural AFLW season; AFL API populates the full PAV
  input set from the start.

VFL/VFLW have no PAV rows because `goal_assists`, `marks_inside_fifty`, and
`one_percenters` are not sufficiently complete for the formula. VFLW can have
sparse values in these fields, so their typed coverage expectation is
`best-effort`, not universally absent.

## Match clock context

The sync persists only the smallest authoritative clock state:
`completed_quarter` is `NULL` or 0–4. It does not store per-period clock
objects or transition timestamps. Consumers must pair the value with
`matches.status`; it reflects the five-minute sync cadence, not second-level
match timing. `live_period_status` remains raw upstream text.

`matches.local_time` remains Melbourne time (`Australia/Melbourne`) across
all competitions, matching the AFL API ecosystem convention. Venue-native
time and timezone are intentionally discarded.

## Brownlow votes

Brownlow vote ingestion currently relies on `cells[16]` from AFL Tables, which
fitzroy doesn't yet wire through. Tracked at
[fitzroy-ts#117](https://github.com/jackemcpherson/fitzRoy-ts/issues/117).
The `upsertStats` path uses `COALESCE` on `brownlow_votes`, so when the npm
fix lands a one-off historical backfill (`fetchPlayerStats({ source:
"afl-tables", season })`) can run without clobbering current-season values.
Brownlow votes are AFLM-only — the medal isn't awarded for AFLW/VFL/VFLW.
