# Schema Reference

Authoritative source: [`src/db/schema.sql`](../src/db/schema.sql) plus
migrations in [`src/db/migrations/`](../src/db/migrations). The `schema` MCP
tool exposes a hardcoded variant of this for clients
(`src/mcp/tools/schema.ts`); keep both in sync when adding columns.

The D1 database (`afl-stats`) has 11 tables and covers four competitions:
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

### `player_match_stats`
Long table — one row per `(match, player)`, ~70 columns covering disposals,
contested possessions, marks, hitouts, score involvements, ratings, fantasy
scores, Brownlow votes, etc. Indexed on `match_id`, `player_id`, `team_id`,
and `(player_id, team_id)`.

Per-column coverage varies by competition. AFLM 1990+ and AFLW 2017+ have the
full stat set. VFL/VFLW (AFL API only, 2021+) have most columns populated but
return NULL for `goal_assists`, `marks_inside_fifty`, `one_percenters` and a
handful of advanced columns — verified at the AFL API level. `brownlow_votes`
is AFLM-only.

### `match_lineups`
Pre-match selected squads. Distinct from `player_match_stats` because lineups
publish on Thursday, before stats exist.
- `(match_id, player_id)` UNIQUE.
- `is_emergency`, `is_substitute` flags.
- AFLM 2015+ via AFL API; AFLW 2017+; VFL/VFLW best-effort (fitzroy may
  return empty for some rounds). 2021–2022 AFLM are derived from
  `player_match_stats` because the AFL API only publishes the
  Thursday-night announced team for those seasons.

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
