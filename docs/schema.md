# Schema Reference

Authoritative source: [`src/db/schema.sql`](../src/db/schema.sql) plus
migrations in [`src/db/migrations/`](../src/db/migrations). The `schema` MCP
tool exposes a hardcoded variant of this for clients
(`src/mcp/tools/schema.ts`); keep both in sync when adding columns.

The D1 database (`afl-stats`) has 12 tables and covers four competitions:
**AFLM**, **AFLW**, **VFL**, **VFLW**. Always filter queries by competition
(join through `seasons → competitions`, then `WHERE c.code = ?`) — without
the filter, results mix competitions silently because team rows with the
same name (e.g. Carlton AFLM vs Carlton VFL) are distinct `team_id`s.

## Reference data

### `competitions`
The competition (`AFLM`, `AFLW`, `VFL`, `VFLW`). The schema seeds AFLM and
AFLW; VFL and VFLW are upserted by the sync's `ensureCompetition` helper on
first sync.
- `code` (UNIQUE), `name`.

### `seasons`
One row per `(competition, year)`.
- `(competition_id, year)` UNIQUE.
- `is_complete` (0/1) — set when every match in the season has been played.

### `teams`
- `(name, competition_id)` UNIQUE — same team across competitions counts as
  separate rows. Carlton AFLM and Carlton VFL have different `team_id`s.

### `venues`
- `name` UNIQUE. Shared across competitions (intentional — MCG hosts all
  four).
- Geodata (migration 0014, seeded from `data/venue-geodata.csv`): `latitude`,
  `longitude`, `timezone` (IANA), `roof` (`'retractable'` — Marvel Stadium
  only — or `'none'`), and `canonical_venue_id` pointing sponsor-renamed
  aliases at the physical ground (self-referencing for canonical rows). All
  NULL (except `canonical_venue_id`) for the 'To Be Confirmed' placeholder
  venue (id 17748).

### `players`
- Stable identity via two external IDs, indexed conditionally so nulls don't
  collide:
  - `external_id` — fryzigg / AFL-tables provider id.
  - `external_afl_player_id` — AFL.com.au id (used by lineups). The AFL's
    CD_I IDs span competitions, so the same player can appear in AFLM and
    VFL stats under one `player_id`. Resolve their competition per stat row
    via `match → season → competition`.
- Demographics: `first_name`, `surname`, `date_of_birth`, `height_cm`,
  `weight_kg`, `is_retired`.

## Match data

### `matches`
- Identity: `(date, home_team_id, away_team_id)` UNIQUE, plus three external
  IDs (`external_afltables_id`, `external_fryzigg_id`, `external_afl_id`).
  Cross-competition collisions are prevented by team-id scoping.
- Round columns mirror R fitzRoy's design — store the AFL API's labels
  directly, no cross-competition normalisation:
  - `round` — long form (`Round 1`, `Opening Round`, `Wildcard`,
    `Finals Week 1`, `Grand Final`, plus historical `Elimination Final` /
    `Qualifying Final` for pre-2020 AFLM).
  - `round_abbreviation` — AFL standard short codes (`Rd N`, `OR`, `WC`,
    `FW1`, `SF`, `PF`, `GF`, plus `EF`/`QF` for pre-2020 AFLM).
  - `round_number` — per-season ordinal, continuous through finals.
  - `round_type` — `'Regular'` (incl. Opening Round + Wildcard) or `'Finals'`.
  Round numbers don't align across competitions; use `round_abbreviation` for
  cross-competition filters.
- Indexed on `date`, `season_id`, `home_team_id`, `away_team_id`, `venue_id`,
  and conditionally on `external_afl_id`.
- See [`sync.md`](./sync.md#round-labels) for the full label rules.
- `local_time` is always Melbourne local time (`Australia/Melbourne`,
  AEST/AEDT) for every competition. Venue-native time is intentionally not
  stored.
- `completed_quarter` is nullable and constrained to 0–4. `0` means no
  quarter is complete; `1`–`4` are the highest completed quarter; `NULL`
  means no AFL API clock was supplied or the row predates refresh. Pair it
  with `status`; the five-minute sync does not make it a live siren signal.

### `player_match_stats`
Long table — one row per `(match, player)`, ~70 columns covering disposals,
contested possessions, marks, hitouts, score involvements, ratings, fantasy
scores, Brownlow votes, etc. Indexed on `match_id`, `player_id`, `team_id`,
and `(player_id, team_id)`.

Per-column coverage varies by competition. Use the typed coverage contract in
the `schema` MCP response rather than inferring completeness from omitted
notes. In particular, VFLW has sparse measured values for `goal_assists`,
`marks_inside_fifty`, and `one_percenters`; these are `best-effort`, not
universally absent. `brownlow_votes` is AFLM-only.

### `match_lineups`
Pre-match selected squads. Distinct from `player_match_stats` because lineups
publish on Thursday, before stats exist.
- `(match_id, player_id)` UNIQUE.
- `is_emergency`, `is_substitute` flags.
- AFLM 2015+ via AFL API; AFLW 2017+; VFL/VFLW best-effort (fitzroy may
  return empty for some rounds). 2021–2022 AFLM are derived from
  `player_match_stats` because the AFL API only publishes the
  Thursday-night announced team for those seasons.

### `match_weather`
Match-window weather from Open-Meteo (CC-BY 4.0), keyed `(match_id, kind)` —
at most two rows per match.
- `kind` is `'forecast'` (fetched ≤7 days out, overwritten in place per
  refresh, kept after the match for forecast-error analysis) or
  `'observed'`.
- Metrics cover the 3 hours from scheduled start: `temp_c` and
  `humidity_pct` are means, `precip_mm` a total, `wind_speed_kmh` and
  `wind_gust_kmh` maxima. `precip_24h_prior_mm` totals the 24 hours before
  the window (ground condition).
- `source` records provenance: `'era5_land+era5'` (final reanalysis —
  temp/humidity/wind from ERA5-Land, precipitation from ERA5),
  `'historical_forecast'` (interim observed value, upgraded to reanalysis
  once the match is >6 days old), `'best_match'` (forecast rows).
- Cancelled matches and the placeholder venue (17748) never get rows.
- Do not mix with the frozen fryzigg `matches.weather_temp_c` /
  `weather_type` columns — those are daily-max values, AFLM 2010–2025 only.

## Derived data

### `player_season_pav`
PAV (Player Approximate Value) split into offensive, midfield, and defensive
components plus a total. One row per `(player, season, team)` — a player
traded mid-season has separate rows per club.
- Indexed on `(season_id, total_pav DESC)` for top-N queries.
- Recalculated from `player_match_stats` by `recalculatePav` whenever the
  sync writes new stats.
- Available for **AFLM 1998+ and AFLW 2017+ only**. VFL/VFLW have no PAV
  rows because the AFL API doesn't populate the formula's inputs. Use
  `LEFT JOIN` when combining with `player_match_stats`.

## Coverage contract

The no-argument `schema` call returns deterministic static expectations in
`database.coverage_contract` (version 1) and performs no D1 reads. Every leaf
separates `expected` from `observed`, records source provenance and a review
date, and expands grouped fields to real column names. The legacy
`column_coverage` object is a generated, deprecated compatibility alias for
one release.

Call `schema` with `includeObserved: true`, one `competition`, and one integer
`season` to overlay a bounded measurement. Stats, weather, PAV, and lineup
presence use separate indexed aggregates; successful results are cached for
15 minutes. A zero-row observation does not prove absence. Invalid or broad
requests are rejected before D1 access.

## Operational

### `sync_log`
Append-only log of sync ticks that did work or errored. Columns:
`timestamp`, `type` (e.g. `sync:AFLM`, `sync:VFL`, `pav_recalculation:AFLW`,
`backfill:AFLM:2024`, `admin:brownlow-backfill`), `rows_affected`, `error`.
Brownlow operation errors are bounded codes rather than upstream rows or IDs.
Successful no-op ticks are not logged.

### `sync_lease`
Single-row mutex shared by cron sync, manual sync, and Brownlow ingestion.
Columns are the fixed `id = 1`, an opaque `holder`, and `acquired_at`. Atomic
acquisition permits a free row or one older than ten minutes; release is
holder-checked. The private status endpoint derives only active state and age
and never returns the holder.

## Conventions

- All dates are ISO `YYYY-MM-DD` strings.
- Boolean-ish flags are `INTEGER` (0/1) — SQLite has no native boolean.
- Timestamps in `sync_log` are ISO 8601 strings in UTC.
- Foreign keys are declared but SQLite enforcement requires `PRAGMA
  foreign_keys = ON`; assume integrity comes from the upsert helpers, not the
  engine.
