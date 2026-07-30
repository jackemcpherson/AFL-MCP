# Schema Reference

Authoritative source: [`src/db/schema.sql`](../src/db/schema.sql) plus
migrations in [`src/db/migrations/`](../src/db/migrations). The `schema` MCP
tool exposes the client contract from `src/mcp/tools/schema.ts`. Update both
sources when adding columns.

The D1 database (`afl-stats`) has 13 tables and covers four competitions:
**AFLM**, **AFLW**, **VFL**, **VFLW**. Always filter queries by competition
(join `seasons` to `competitions`, then use `WHERE c.code = ?`). Without the
filter, results mix competitions silently because team rows with the same name
use distinct `team_id` values across competitions.

## Reference Data

Reference tables define competitions, seasons, teams, venues, and players.

### `competitions`

The competition (`AFLM`, `AFLW`, `VFL`, `VFLW`). The schema seeds AFLM and AFLW.
VFL and VFLW are upserted by the sync's `ensureCompetition` helper on first
sync.

- `code` (UNIQUE), `name`.

### `seasons`

One row per `(competition, year)`.

- `(competition_id, year)` UNIQUE.
- `is_complete` (0/1) - set when every match in the season has been played.

### `teams`

- `(name, competition_id)` UNIQUE - same team across competitions counts as
  separate rows. Carlton AFLM and Carlton VFL have different `team_id`s.

### `venues`

- `name` UNIQUE. Shared across competitions (intentional - MCG hosts all four).
- Geodata (migration 0014, seeded from `data/venue-geodata.csv`): `latitude`,
  `longitude`, `timezone` (IANA), `roof` (`'retractable'` - Marvel Stadium
  only - or `'none'`), and `canonical_venue_id` pointing sponsor-renamed aliases
  at the physical ground (self-referencing for canonical rows). All NULL (except
  `canonical_venue_id`) for the 'To Be Confirmed' placeholder venue (id 17748).

### `players`

- Stable identity via two external IDs, indexed conditionally so nulls do not
  collide:
  - `external_id` - fryzigg / AFL-tables provider id.
  - `external_afl_player_id` - AFL.com.au id (used by lineups). The AFL's CD_I
    IDs span competitions, so the same player can appear in AFLM and VFL stats
    under one `player_id`. Resolve their competition through the match and
    season relationships.
- Demographics: `first_name`, `surname`, `date_of_birth`, `height_cm`,
  `weight_kg`, `is_retired`.

## Match Data

Match tables store fixtures, results, player statistics, lineups, and weather.

### `matches`

- Identity: `(date, home_team_id, away_team_id)` UNIQUE, plus three external IDs
  (`external_afltables_id`, `external_fryzigg_id`, `external_afl_id`).
  Cross-competition collisions are prevented by team-id scoping.
- Round columns mirror R fitzRoy's design - store the AFL API's labels directly,
  no cross-competition normalisation:
  - `round` - long form (`Round 1`, `Opening Round`, `Wildcard`,
    `Finals Week 1`, `Grand Final`, plus historical `Elimination Final` /
    `Qualifying Final` for pre-2020 AFLM, and the AFLM 2026 finals labels
    `Wildcard Finals` / `Qualifying & Elimination Finals`).
  - `round_abbreviation` - AFL standard short codes (`Rd N`, `OR`, `WC`,
    `FW1`, `SF`, `PF`, `GF`, plus `EF`/`QF` for pre-2020 AFLM). Finals round
    names without a mapped short form fall back to `F<round_number>` (AFLM
    2026: `F25`, `F26`).
  - `round_number` - per-season ordinal, continuous through finals.
  - `round_type` - `'Regular'`, including Opening Round and Wildcard, or
    `'Finals'`. Round numbers do not align across competitions. Use
    `round_abbreviation` for cross-competition filters.
- Indexed on `date`, `season_id`, `home_team_id`, `away_team_id`, `venue_id`,
  and conditionally on `external_afl_id`.
- See [`sync.md`](./sync.md#round-labels) for the full label rules.
- `local_time` is always Melbourne local time (`Australia/Melbourne`, AEST/AEDT)
  for every competition. Venue-native time is intentionally not stored.
- `completed_quarter` is nullable and constrained to 0 - 4. `0` means no quarter
  is complete. `1` - `4` are the highest completed quarter. `NULL` means no AFL
  API clock was supplied or the row predates refresh. Pair it with `status`. The
  five-minute sync does not make it a live siren signal.
- `status` is populated for every row (`Upcoming`, `Live`, `Complete`,
  `Postponed`, `Cancelled`). Migration `0017` backfilled played matches as
  `Complete` and marked the 38 score-less VFL/VFLW 2021 COVID-era matches
  `Cancelled`, so NULL scores on a `Cancelled` row mean cancelled, not
  missing data.
- The legacy `weather_temp_c` / `weather_type` columns (frozen fryzigg
  record, AFLM 2010 - 2025, daily-max semantics) were dropped in migration
  `0020`. Use `match_weather` for all weather analysis.

### `player_match_stats`

Long table - one row per `(match, player)`, about 70 columns covering disposals,
contested possessions, marks, hitouts, score involvements, ratings, fantasy
scores, Brownlow votes, and other metrics. Indexes cover `match_id`,
`player_id`, `team_id`, and `(player_id, team_id)`.

Per-column coverage varies by competition. Use the typed coverage contract in
the `schema` MCP response rather than inferring completeness from omitted notes.
In particular, VFLW has sparse measured values for `goal_assists`,
`marks_inside_fifty`, and `one_percenters`. These are `best-effort`, not
universally absent. `brownlow_votes` is AFLM-only.

### `match_lineups`

Pre-match selected squads. Distinct from `player_match_stats` because lineups
publish on Thursday, before stats exist.

- `(match_id, player_id)` UNIQUE.
- `is_emergency`, `is_substitute` flags.
- AFLM 2015+ via AFL API. AFLW, VFL, and VFLW 2023+ (best-effort for the VFL
  competitions - fitzroy may return empty for some rounds). The AFL API only
  publishes the Thursday-night announced team for pre-2023 seasons, so the
  sync's `MIN_LINEUP_SYNC_YEAR` guard excludes them. 2021 - 2022 AFLM rows are
  instead derived from `player_match_stats`.

### `match_weather`

Match-window weather from Open-Meteo (CC-BY 4.0), keyed `(match_id, kind)` - at
most two rows per match.

- `kind` is `'forecast'` (fetched ≤7 days out, overwritten in place per refresh,
  kept after the match for forecast-error analysis) or `'observed'`.
- Metrics cover the 3 hours from scheduled start: `temp_c` and `humidity_pct`
  are means, `precip_mm` a total, `wind_speed_kmh` and `wind_gust_kmh` maxima.
  `precip_24h_prior_mm` totals the 24 hours before the window (ground
  condition).
- `source` records provenance: `'era5_land+era5'` (final reanalysis -
  temp/humidity/wind from ERA5-Land, precipitation from ERA5),
  `'historical_forecast'` (interim observed value, upgraded to reanalysis once
  the match is >6 days old), `'best_match'` (forecast rows).
- Cancelled matches and the placeholder venue (17748) never get rows.
- This table is the only weather source. The legacy fryzigg
  `matches.weather_temp_c` / `weather_type` columns were dropped in
  migration `0020`.

## Derived Data

Derived tables store player value and external model predictions.

### `player_season_pav`

PAV (Player Approximate Value) split into offensive, midfield, and defensive
components plus a total. One row per `(player, season, team)` - a player traded
mid-season has separate rows per club.

- Indexed on `(season_id, total_pav DESC)` for top-N queries.
- Recalculated from `player_match_stats` by `recalculatePav` whenever the sync
  writes new stats.
- Available for **AFLM 1998+ and AFLW 2017+ only**. VFL/VFLW have no PAV rows
  because the AFL API does not populate the formula's inputs. Use `LEFT JOIN`
  when combining with `player_match_stats`.

### `match_predictions`

Tipper model predictions, one row per match (PK `match_id`), overwritten on
regeneration - only the latest prediction is kept, no history.

- `home_win_prob` - 0..1, the home team's win probability.
- `predicted_margin` - points, one decimal. Positive means the home team is
  favoured.
- `model_version` - tipper configuration ID, such as `predha-080 (2641f46f)`.
- Tipper writes through the D1 REST API under tipper issue 28. This Worker only
  reads the row.
- Coverage starts 2026 and is sparse - rows exist only for rounds tipper has
  published. Use `LEFT JOIN` and treat absence as not-published.

## Coverage Contract

The no-argument `schema` call returns deterministic static expectations in
`database.coverage_contract` (version 2) and performs no D1 reads. Each table
declares a default (`range`, `expected`, `source`) that applies to every
column. `columns` lists only exceptions that deviate from that default. A
`how_to_read` key in the response explains the encoding, and a single
`review_date` covers the whole contract.

Call `schema` with one `competition` and nothing else to get the same static
schema filtered to that competition (its `competitions` entry and
`coverage_contract` subtree. tables and notes are competition-agnostic and
unchanged).

Call `schema` with `includeObserved: true`, one `competition`, and one integer
`season` to attach a bounded measurement as a sibling `observed` block beside
the static contract (measurements never mutate expectations). Stats, PAV, and
lineup presence use separate indexed aggregates. The Worker caches successful
results for 15 minutes. A zero-row observation does not prove absence. Invalid
or broad requests fail before D1 access with a single error stating the full
parameter contract (no params | competition alone | competition + season +
includeObserved:true).

## Operational

Operational tables record sync outcomes and coordinate exclusive work.

### `sync_log`

Append-only log of sync ticks that did work or errored. Columns: `timestamp`,
`type`, such as `sync:AFLM`, `sync:VFL`, `pav_recalculation:AFLW`,
`backfill:AFLM:2024`, `admin:brownlow-backfill`), `rows_affected`, `error`.
Brownlow operations record bounded error codes instead of upstream rows or IDs.
Successful no-op ticks are not logged.

### `sync_lease`

Single-row mutex shared by cron sync, manual sync, and Brownlow ingestion.
Columns are the fixed `id = 1`, an opaque `holder`, and `acquired_at`. Atomic
acquisition permits a free row or one older than ten minutes. Release checks the
holder. The private status endpoint derives only active state and age and never
returns the holder.

## Conventions

- All dates are ISO `YYYY-MM-DD` strings.
- Boolean-ish flags are `INTEGER` (0/1) - SQLite has no native boolean.
- Timestamps in `sync_log` are ISO 8601 strings in UTC.
- Foreign keys are declared but SQLite enforcement requires
  `PRAGMA foreign_keys = ON`. Assume integrity comes from the upsert helpers,
  not the engine.
