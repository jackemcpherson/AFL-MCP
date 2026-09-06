# Schema Reference

Authoritative source: [`src/db/schema.sql`](../src/db/schema.sql) plus
migrations in [`src/db/migrations/`](../src/db/migrations). The `schema` MCP
tool exposes the client contract from `src/mcp/tools/schema.ts`. Update both
sources when adding columns.

The D1 database (`afl-stats`) covers four competitions:
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
- `is_complete` (0/1) - set when every match in the season has finished.

### `teams`

- `(name, competition_id)` UNIQUE - same team across competitions counts as
  separate rows. Carlton AFLM and Carlton VFL have different `team_id`s.

### `venues`

- `name` UNIQUE. Shared across competitions (intentional - MCG hosts all four).
- Geodata (migration 0014, seeded from `data/venue-geodata.csv`): `latitude`,
  `longitude`, `timezone` (IANA), `roof` (`'retractable'` - Marvel Stadium
  only - or `'none'`), and `canonical_venue_id` pointing sponsor-renamed aliases
  at the physical ground (self-referencing for canonical rows). All NULL (except
  `canonical_venue_id`) for the `To Be Confirmed` placeholder venue (id 17748).

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
  Team-id scoping prevents cross-competition collisions.
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
- `kickoff_at` is nullable canonical UTC from the source match instant. Use it
  for publication deadlines. Unknown times remain `NULL`. Never combine `date`
  and `local_time` to infer a deadline. Migration `0021` requires source refresh
  to populate forthcoming fixtures.
- `lineups_observed_at` is the UTC observation time of the last valid complete
  lineup replacement. Legacy lineups without this metadata are not evidence
  of an observed announced selection.
- `completed_quarter` is nullable and constrained to 0 - 4. `0` means no quarter
  is complete. `1` - `4` are the highest completed quarter. `NULL` means the AFL
  API supplied no clock or the row predates refresh. Pair it with `status`. The
  five-minute sync does not make it a live siren signal.
- Every row has a `status` (`Upcoming`, `Live`, `Complete`,
  `Postponed`, `Cancelled`). Migration `0017` backfilled played matches as
  `Complete`. It marked the 38 score-less VFL/VFLW 2021 COVID-era matches
  `Cancelled`. NULL scores on a `Cancelled` row indicate cancellation.
- Migration `0020` dropped the legacy `weather_temp_c` / `weather_type` columns.
  These held frozen fryzigg daily maxima for AFLM 2010 - 2025.
  Use `match_weather` for all weather analysis.

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

Current selected squads, observed before player statistics exist and refreshed
when late team changes arrive.

- `(match_id, player_id)` UNIQUE.
- `is_emergency`, `is_substitute` flags.
- AFLM and AFLW replacements require both complete team selections, unique
  players, resolved player identities, and matching fixture ownership.
  Non-emergency sizes are 23 for AFLM and 21 for AFLW, including interchange and
  substitute players. Review these sizes against published 2027 rules.
- A valid replacement deletes omitted players and updates
  `matches.lineups_observed_at` in the same D1 transaction. Invalid or incomplete
  responses preserve the previous snapshot. Later upcoming matches in rounds
  already underway continue refreshing, every five minutes in the final ninety
  minutes before kickoff.
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
- `source` records provenance. `'era5_land+era5'` provides final reanalysis,
  with temperature, humidity, and wind from ERA5-Land and precipitation from ERA5.
  `'historical_forecast'` provides interim observations until six days after the
  match. `'best_match'` identifies forecast rows.
- Cancelled matches and the placeholder venue (17748) never get rows.
- This table is the only weather source. Migration `0020` dropped the legacy
  fryzigg `matches.weather_temp_c` / `weather_type` columns.

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

Current Tipper predictions, one row per match with primary key `match_id`.
Unlocked matches can refresh. Append-only captures retain publication history.

- `home_win_prob` - 0..1, the home team's win probability.
- `predicted_margin` - points, one decimal. Positive means the home team is
  favoured.
- `model_version` records the issued model identity and complete build source
  revision. Use the recorded identity when reading older predictions.
- `generated_at` is the UTC publication timestamp.
- Nullable `tipper_run_id` links new rows to `tipper_runs` and the matching
  `(run_id, match_id)` capture in `tipper_predictions`. Legacy rows retain a
  null link and are not prospective captures.
- The Tipper Worker writes through its native D1 binding. AFL-MCP and FootyBot
  retain direct reads of these five existing prediction fields.
- Fixture identity, venue, or kickoff changes atomically remove the current
  projection and Squiggle mapping. Captures remain available. A later schedule
  correction cannot reopen a prediction after its recorded kickoff.
- Use `LEFT JOIN` and treat absence as not published. Prospective coverage starts
  at `tipper_status.activated_at`. Older research gaps are outside that window.

### Tipper Publication Records

Migration `0021` adds these records under AFL-MCP schema ownership. Apply the
migration before activating the new publisher. Existing archives remain separate.

| Table                | Retained Evidence                                                          |
| -------------------- | -------------------------------------------------------------------------- |
| `tipper_runs`        | Ordered attempts, round identity, source revision, model identity, result. |
| `tipper_predictions` | Append-only captures keyed by run and match.                               |
| `tipper_game_ids`    | Validated local-to-Squiggle match and ordered team identities.             |
| `tipper_reports`     | Weekly scoring attempts, input observations, results, and failures.        |
| `tipper_status`      | One activation timestamp and scheduler/reporting heartbeats.               |

Each capture stores fixture identity, UTC kickoff, full-precision margin and
probability, issued output, winner, provisional status, rating and lineup
evidence, and observation/publication times. Captures record what Tipper issued.
They are not complete historical database snapshots.

Tipper commits captures, current projections, and checked run finalisation in one
native D1 transaction. A failure preserves the previous committed set. Each match
locks at its own recorded kickoff, while later matches in the round can refresh.
Weekly reports score stored captures and retain missing predictions as missing.

### Historical Prediction Backfills

`match_predictions` retains historical backfills alongside predictions generated
in real time. The 2026 backfill covers 213 completed AFLM matches and 31 completed
AFLW matches. Each prediction rebuilds Elo and PAV chronologically from eligible
earlier matches and uses the source matchday lineup.

Use the `tipping_performance` schema recipe to join these predictions with
completed match results. It reports coverage, correct winners, draws, accuracy
excluding draws, and margin MAE. The home probability determines the tipped
team, including when the signed margin rounds to zero.

`generated_at` records the actual generation time. Backfilled rows have a null
`tipper_run_id`. Real-time rows link to their publication run. Both use the same
probability, margin, and model-version fields. Existing predictions take
precedence over a backfill.

Migration `0023` consolidates the completed replay into `match_predictions` and
removes the temporary reconstruction tables. Migration `0022` remains in the
migration history. The offline replay archive retains the detailed inputs and
assumptions. Consumers need only the normal predictions table.

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

- Calendar dates use ISO `YYYY-MM-DD`. Kickoff and observation timestamps use
  canonical ISO 8601 UTC strings.
- Boolean-ish flags are `INTEGER` (0/1) - SQLite has no native boolean.
- Timestamps in `sync_log` are ISO 8601 strings in UTC.
- The schema declares foreign keys, but SQLite enforcement requires
  `PRAGMA foreign_keys = ON`. Assume integrity comes from the upsert helpers,
  not the engine.
