# Schema Reference

Authoritative source: [`src/db/schema.sql`](../src/db/schema.sql). The `schema`
MCP tool exposes a hardcoded variant of this for clients
(`src/mcp/tools/schema.ts`); keep both in sync when adding columns.

The D1 database (`afl-stats`) has 10 tables.

## Reference data

### `competitions`
The competition (e.g. AFLM, AFLW). Seeded at schema creation; not touched by
the sync.
- `code` (UNIQUE), `name`.

### `seasons`
One row per `(competition, year)`.
- `(competition_id, year)` UNIQUE.

### `teams`
- `(name, competition_id)` UNIQUE — same team across competitions counts as
  separate rows.

### `venues`
- `name` UNIQUE.

### `players`
- Stable identity via two external IDs, indexed conditionally so nulls don't
  collide:
  - `external_id` — fryzigg / AFL-tables provider id.
  - `external_afl_player_id` — AFL.com.au id (used by lineups).
- Demographics: `first_name`, `surname`, `date_of_birth`, `height_cm`,
  `weight_kg`, `is_retired`.

## Match data

### `matches`
- Identity: `(date, home_team_id, away_team_id)` UNIQUE, plus three external
  IDs (`external_afltables_id`, `external_fryzigg_id`, `external_afl_id`).
- Round: `round` (e.g. `R1`, `Opening Round`, `GF`), `round_number` (0 for
  Opening Round), `round_type` (`'Regular'` | `'Finals'`).
- Indexed on `date`, `season_id`, `home_team_id`, `away_team_id`, `venue_id`,
  and conditionally on `external_afl_id`.
- See [`sync.md`](./sync.md#afl-season-structure) for the round-naming gotcha.

### `player_match_stats`
Long table — one row per `(match, player)`, ~70 columns covering disposals,
contested possessions, marks, hitouts, score involvements, ratings, fantasy
scores, Brownlow votes, etc. Indexed on `match_id`, `player_id`, `team_id`,
and `(player_id, team_id)`.

`brownlow_votes` is currently null for newly-fetched modern data — see the
note in [`sync.md`](./sync.md#brownlow-votes).

### `match_lineups`
Pre-match selected squads. Distinct from `player_match_stats` because lineups
publish on Thursday, before stats exist.
- `(match_id, player_id)` UNIQUE.
- `is_emergency`, `is_substitute` flags.

## Derived data

### `player_season_pav`
PAV (Player Approximate Value) split into offensive, midfield, and defensive
components plus a total. One row per `(player, season, team)` — a player
traded mid-season has separate rows per club.
- Indexed on `(season_id, total_pav DESC)` for top-N queries.
- Recalculated from `player_match_stats` by `recalculatePav` whenever the
  sync writes new stats.

## Operational

### `sync_log`
Append-only log of sync ticks that did work or errored. Columns:
`timestamp`, `type` (e.g. `sync:AFLM`, `sync:AFLM:lineups`), `rows_affected`,
`error`. Successful no-op ticks are not logged.

## Conventions

- All dates are ISO `YYYY-MM-DD` strings.
- Boolean-ish flags are `INTEGER` (0/1) — SQLite has no native boolean.
- Timestamps in `sync_log` are ISO 8601 strings in UTC.
- Foreign keys are declared but SQLite enforcement requires `PRAGMA
  foreign_keys = ON`; assume integrity comes from the upsert helpers, not the
  engine.
