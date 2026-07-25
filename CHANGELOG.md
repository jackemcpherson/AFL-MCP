# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.6.1] - 2026-07-25

### Fixed

- **Claude Web connection**: unknown paths now return 404 instead of a
  200 banner. Claude Web probes `/.well-known/oauth-protected-resource`
  and `/.well-known/oauth-authorization-server` before connecting; the
  catch-all 200 made it assume the server had OAuth configured, so it
  attempted dynamic client registration and failed ("Couldn't register
  with AFL MCP's sign-in service"). The banner is now served only at
  `/`.

## [3.6.0] - 2026-07-15

### Added

- **Match predictions**: new `match_predictions` table (migration
  `0015_match_predictions.sql`) — one row per match, PK `match_id`,
  overwritten on regeneration (latest prediction only, no history).
  Columns: `home_win_prob` (0..1) and `predicted_margin` (points,
  positive = home favoured), both from the home team's perspective,
  plus `model_version` (tipper config id) and `generated_at` (UTC
  ISO 8601). Rows are written by tipper over the Cloudflare D1 REST
  API, not by this Worker. Exposed in the `schema` tool with a
  LEFT-JOIN example query and a treat-absence-as-not-published note;
  coverage starts 2026. (#142)
- **Schema tool competition filter**: passing `competition` alone now
  returns the base schema filtered to that competition —
  `database.competitions` and `coverage_contract.by_competition` shrink
  to the one entry; tables, notes, and join examples are unchanged and
  the call stays read-free. (#141)

### Changed

- **Schema tool errors**: any invalid parameter combination now fails
  with a single error naming all three valid call shapes (no params;
  `competition` alone; `competition` + `season` +
  `includeObserved: true`), replacing per-branch messages that chained
  into a two-error loop. (#141)
- **Round derivation**: `src/sync/upserts.ts` now uses the fitzroy 3.4
  package-root exports `roundLabel` / `roundAbbreviation` /
  `roundTypeLabel` instead of local derivation helpers (same semantics
  plus QF/EF codes); all round-derivation behaviour-pin tests pass
  unchanged. `TEAM_NAME_MAP` is retained — fitzroy's canonical names
  differ from this database's for five clubs — with its comment
  corrected so it is not mistaken for a deletable workaround. (#107)

### Removed

- `SLUG_OVERRIDES` and the raw-fetch Brisbane Lions fallback in
  `scripts/backfill-dob.mts` — the slug bug is fixed upstream in
  fitzroy 3.4.0. (#107)

## [3.5.0] - 2026-07-13

### Added

- **Weather data**: new `match_weather` table (one row per match per
  `kind` — `observed` | `forecast`) with six numeric metrics over the
  3-hour match window (`temp_c`, `precip_mm`, `precip_24h_prior_mm`,
  `wind_speed_kmh`, `wind_gust_kmh`, `humidity_pct`), sourced from
  Open-Meteo (ERA5-Land for temperature/humidity/wind, ERA5 for
  precipitation; data CC-BY 4.0). Migration `0014_weather.sql` also
  extends `venues` with `latitude`, `longitude`, `timezone`, `roof`, and
  `canonical_venue_id`, seeded from `data/venue-geodata.csv` (106 venues,
  12 alias groups canonicalised).
- **Weather sync stage**: self-gated hourly stage inside the existing
  cron pipeline/lease — forecasts fetched from 7 days out (daily refresh,
  hourly on match day), observed rows written fast from the Historical
  Forecast API then upgraded to `era5_land+era5` provenance once a match
  is more than 6 days old. Fail-soft: errors land in `sync_log` and
  self-heal on the next hourly pass. Capped at 25 fetches per pass.
- **Weather backfill**: local `scripts/backfill-weather.ts`
  (fetch-with-cache → generate SQL artifacts → apply), with `--dry-run`,
  `--fetch-only`, `--generate-only`, and `--verify` (coverage, range
  sanity, 30-row fresh-API spot-check). Eligible: completed matches
  without an observed row, excluding unplaceable placeholder-venue rows.
- **MCP schema exposure**: `match_weather` and venue-geodata documentation
  in the `schema` tool, including coverage windows, a do-not-mix warning
  for the frozen legacy `weather_temp_c`/`weather_type` columns (fryzigg
  daily-max semantics, AFLM 2010–2025 only), and two example queries.

Design record: wayfinder map #123; spec #138; research assets under
`docs/` (`weather-source-research.md`, `era5-validation.md`,
`venue-geodata-notes.md`, `tbc-venue-investigation.md`).

## [3.4.0] - 2026-07-12

### Added

- **Admin operations v2**: annual dry-run-first Brownlow ingestion endpoint
  (`POST /mcp/admin/backfill-brownlow`) and private aggregate operator status
  endpoint (`GET /mcp/admin/status`), both behind the existing
  `Authorization: Bearer <ADMIN_TOKEN>` guard, plus a shared cron/admin lease
  (`src/sync/lease.ts`). Brownlow ingestion is AFLM-only, annual, dry-run
  first, and never recalculates PAV. The health endpoint's latest-log query
  now excludes `admin:brownlow-backfill` entries; the response shape is
  unchanged. Design: [`docs/admin-operations-v2-design.md`](./docs/admin-operations-v2-design.md).
- **Match context coverage contract**: migration `0013_completed_quarter.sql`
  adds a nullable `matches.completed_quarter` column (CHECK 0–4) written via
  coalescing upsert. The `schema` tool gains versioned typed coverage
  expectations and an optional bounded observed-coverage request (one
  competition-season query with a 15-minute cache); the default response
  remains read-free. Design: [`docs/match-context-coverage-design.md`](./docs/match-context-coverage-design.md).

## [3.3.1] - 2026-07-03

### Dependencies

- `fitzroy` updated `3.0.1` → `3.4.0` (range now `^3.4.0`). Test fixtures
  gained the newly required `Match` fields (`matchClockPeriods`,
  `completedQuarter`, `venueLocalDate`) and `Lineup.source`. Notable upstream
  changes along the way: corrected Brisbane Lions AFL Tables slug (benefits
  the DOB backfill), fryzigg coverage caps (AFLW capped at 2022), and
  coaches-votes finals-round detection. No afl-api sync-path behaviour
  changes; full integration suite green.
- The `undici >= 7.28.0` override is retained: cheerio still declares
  `^7.19.0` (admits but does not require a patched version) and miniflare
  exact-pins `7.24.8`, so dropping the override would regress the dev chain
  into the advisory range. Re-evaluate when either moves.
- Removed the `tsx` devDependency — it was used only by the deleted
  `db:seed` script; remaining scripts run under `bun` directly.

### Removed

- Nine completed one-shot scripts, per the deletion list in
  [`docs/admin-backfills-design.md`](./docs/admin-backfills-design.md)
  (maintainer signed off; git history preserves them):
  `backfill-lineups-early.ts`, `backfill-rounds.ts`, `dedup-players.ts`,
  `enrich-fryzigg.ts`, `probe-afltables-lineups.ts`,
  `probe-missing-lineups.ts`, `probe-opening-rounds.ts`, `seed-d1.ts`,
  `verify-integrity.ts` — plus the `db:seed` npm script that ran `seed-d1`.
  The five retained scripts are the two recurring backfills (Brownlow, DOB)
  and the three operational tools (lineup backfill/refetch, Brownlow gap
  diagnostics).

### Notes

- The 2026 weather gap is now tracked upstream as
  [fitzRoy-ts#179](https://github.com/jackemcpherson/fitzRoy-ts/issues/179)
  (re-verified still null under fitzroy 3.4.0). AFL-MCP self-heals via its
  existing coalesce columns once the upstream fix ships.
- `scripts/backfill-dob.mts` has drifted from current `rds-js`/`fitzroy`
  APIs (Result-shape changes surfaced during a typecheck experiment) — a
  further argument for promoting it to an admin endpoint per the design doc
  before its next run.

## [3.3.0] - 2026-07-03

### Fixed

- `upsertStats` no longer aborts an entire 500-statement batch when a stat
  row's team name cannot be resolved (e.g. a novel Sir Doug Nicholls Round
  alias appearing in the stats feed before `TEAM_NAME_MAP` learns it). The
  unmapped row is skipped — mirroring the existing lineups guard — and each
  distinct unmapped name is recorded once per call as a
  `sync:stats:unmapped-team` row in `sync_log`, which observes without paging
  `/mcp/health`.
- `POST /mcp/admin/sync` now actually syncs: it passes
  `skipShouldRunNow: true` (matching the backfill endpoint's default) so the
  manual trigger works outside the cadence window, and returns the
  per-competition `results` array so a no-op (e.g. sync lease held by a
  concurrent cron tick) is visible to the operator instead of masked by a
  bare `{status:"ok"}`.

### Changed

- **`/mcp/health` response trimmed (hardening).** The anonymous payload no
  longer includes the raw `last_sync` and `last_critical_error` rows (whose
  `error` columns carried verbatim upstream failure text); it now returns
  `status`, `stale`, `last_sync_age_ms`, `latest_match`, and a boolean
  `has_recent_critical_error`. The 200/503 status-code contract for uptime
  monitors is unchanged. The endpoint is also now covered by the same per-IP
  rate limit as the MCP endpoint.
- The `code` tool's `competition` parameter is now recorded as structured
  usage telemetry (a `{"event":"tool:code","competition":...}` log line
  indexed by Workers observability). Its query semantics are unchanged — it
  still does not auto-inject SQL.

### Dependencies

- `fitzroy` moved from an exact `3.0.1` pin to `^3.0.1` so patch releases
  flow through dependency updates. The lockfile currently holds 3.0.1
  (fitzroy 3.3.0 introduces breaking type changes; adopt deliberately).
- Added `"overrides": { "undici": ">=7.28.0" }`, clearing four high-severity
  undici advisories reachable via the runtime chain
  `fitzroy › cheerio › undici` (resolves undici 8.5.0). Remove the override
  once cheerio requires a patched undici natively.

### Added

- Golden-value test for the PAV formula
  (`test/integration/pav-golden.test.ts`): an independent TypeScript
  reference implementation of the HPN formula, run against a deterministic
  2-team/8-player fixture and asserted component-wise (±0.01) against
  `PAV_SELECT_SQL` for every player, with frozen golden literals. SQL and
  reference agreed on first run.
- Regression tests for the admin sync endpoint, the health payload contract,
  and unmapped-team stat skips (suite grows 145 → 161 tests).
- `docs/weather-2026-spike.md` — why AFLM 2026 weather is 0%: the AFL API's
  `matchItems/round` endpoint returns no weather at any match status (2025
  control confirms); the fix belongs upstream in fitzRoy-ts and AFL-MCP's
  coalesce write path needs no change. Includes ready-to-file issue text.
- `docs/admin-backfills-design.md` — inventory of all 14 `scripts/` files
  (2 recurring, 9 one-shot-done, 3 operational) and endpoint specs for
  promoting the Brownlow and date-of-birth backfills to the admin surface.
- `docs/weather-coverage-audit.md` — the 2026-06-30 production weather
  coverage audit (previously untracked) committed for provenance.

## [3.2.1] - 2026-06-28

### Fixed

- The MCP `initialize` handshake now reports the real server version, sourced
  from `package.json`, instead of a hardcoded literal that had drifted to
  `3.0.0`. `tsconfig.json` enables `resolveJsonModule` to support the import.
- `handleMcpRequest` now wraps dispatch in a top-level error boundary: an
  unexpected handler throw returns a well-formed JSON-RPC `-32603` (Internal
  error) at HTTP 200 instead of an opaque Cloudflare 500 with no JSON-RPC
  envelope. Internal error detail is logged, never returned to the client.
- JSON-RPC notifications (methods under `notifications/*`, e.g.
  `notifications/initialized`) are now acknowledged with HTTP 202 and an empty
  body, per the MCP streamable-HTTP transport, instead of an erroneous
  JSON-RPC response carrying `id: 0`.

### Removed

- Stale Python-era artifact `scripts/export-pg.sh` (the one-shot
  PostgreSQL→D1 export, obsolete since the platform migration to Cloudflare
  Workers/D1).

## [3.2.0] - 2026-06-09

### Added

- Two new columns on `matches`: `status TEXT` (the match lifecycle —
  Upcoming / Live / Complete / Postponed / Cancelled, sourced from
  `fitzroy.Match.status`) and `live_period_status TEXT` (the raw AFL
  API score-level status, e.g. LIVE / QTR_TIME / HALF_TIME / 3QTR_TIME
  / FULL_TIME, sourced from fitzroy 2.3.0's new `Match.livePeriodStatus`
  field). Both columns enable live-match siren detection without
  requiring consumers to infer state from `home_points IS NULL`.
  Backfill via migration `0011_match_status.sql`; new rows write both
  columns immediately and existing rows backfill on the next sync that
  touches them.
- New regression test in `test/integration/upsert-matches.test.ts`
  covering the lifecycle transition from `Upcoming` → `Live` with a
  `live_period_status` change.

### Changed

- Bumped `fitzroy` from `^2.2.0` to `^2.3.0` to pick up the
  `Match.livePeriodStatus` field that the new `live_period_status`
  column is populated from. The 2.3.0 release also switched fitzroy's
  HTML parser to `parse5 + cheerio/slim` to drop the transitive
  `node:stream` import, which means the AFL-MCP Worker no longer needs
  to rely on the `nodejs_compat` flag for the library entry.

## [3.1.0] - 2026-05-22

### Changed

- **`buildMatchUpsert` now uses dual `ON CONFLICT` clauses** so the match
  upsert is robust to fixture revisions. Primary path:
  `ON CONFLICT (external_afl_id) WHERE external_afl_id IS NOT NULL DO
  UPDATE` — when the AFL moves a game to a different date (or swaps
  home/away), the stable `external_afl_id` still matches the existing
  row and the UPDATE rewrites `date`, `home_team_id`, `away_team_id` in
  place rather than failing the unique index. Fallback path:
  `ON CONFLICT (date, home_team_id, away_team_id) DO UPDATE` — preserves
  the original behaviour for rows that don't have an `external_afl_id`
  (historical / scraped sources) and COALESCEs in the new
  `external_afl_id` when fitzroy starts providing one. Closes #80.

### Added

- Two regression tests in `test/integration/upsert-matches.test.ts`
  covering the new behaviour: (i) a fixture-revision update that
  changes the stored date in place via the external-id branch, and
  (ii) backfill of a NULL `external_afl_id` on a historical row via
  the tuple branch.

## [3.0.2] - 2026-05-22

### Fixed

- **AFLM 2026 R16–R22 fixture realign.** The AFL revised the AFLM 2026
  fixture for rounds 16–22 (61 games moved to different dates after the
  initial fixture was ingested). The match-upsert's `ON CONFLICT (date,
  home_team_id, away_team_id)` key didn't match the new dates, so every
  cron tick fell through to a fallback INSERT, hit the `external_afl_id`
  UNIQUE index, and rolled back the whole sync batch. Migration 0010
  deletes the 61 stale rows so fitzroy can re-insert them with the
  corrected dates. A permanent fix for the underlying conflict-key bug
  is tracked in issue #80.
- **R10 lineups never backfilled.** Sync only ever fetched lineups for
  the *next* unplayed round, so any past round whose Thursday-night
  lineup release window the sync missed (e.g. it was failing during
  R10's release window because of the SDNR bug in v3.0.1) had no
  recovery path.

### Added

- **Self-healing lineup backfill** (`selectCompletedRoundsWithoutLineups`).
  Each sync tick now also fetches lineups for up to 3 recent completed
  rounds where any match has no `match_lineups` row, in addition to the
  next-round fetch. Mirrors the existing `selectHasCompletedMatchWithoutStats`
  pattern for stats. Capped at 3 to avoid refetching historical seasons
  that legitimately have no lineups (pre-2023 AFLM lineups are derived
  from `player_match_stats` via migration 0007, not the AFL API).

## [3.0.1] - 2026-05-22

### Fixed

- **AFLM 2026 R10/R11 sync integrity (issue #78).** The AFL API began
  returning Sir Doug Nicholls Round indigenous club names (`Walyalup`,
  `Kuwarna`, `Narrm`, `Yartapuulti`, `Euro-Yroke`, `Waalitj Marawar`)
  during AFLM R10/R11. fitzroy 2.1.0 surfaced them verbatim and our
  `TEAM_NAME_MAP` did not canonicalise them, so `ensureTeams` created
  ghost team rows and `buildMatchUpsert` then failed the
  `external_afl_id` UNIQUE constraint when re-upserting completed
  matches. The downstream effect was that R10 matches never had
  `home_points` populated, which kept `selectHasCompletedMatchWithoutStats`
  from triggering stats and lineups fetches for those matches.
- Bumped `fitzroy` to `^2.2.0` (canonicalises SDNR names upstream).
- Added the six SDNR indigenous names to `TEAM_NAME_MAP` as
  belt-and-braces in a distinct comment block.
- Shipped migration `0009_remove_sdnr_ghost_teams.sql` to delete the six
  AFLM ghost team rows produced by the failure.

### Added

- Novel-team guardrail in `ensureTeams`: writes a `sync_log` row of type
  `sync:novel-team:<competition>` (with the novel name(s) in the `error`
  payload field) whenever sync encounters a team name not already in
  the database for that competition. Observational only — does not
  block the insert. Designed to make the next occurrence of this class
  of silent failure visible without changing sync semantics.

## [2.0.0] - 2026-04-04

### Changed

- **Platform migration:** Moved from Python/PostgreSQL/DigitalOcean to Cloudflare Workers/D1/TypeScript
- **MCP tools:** Replaced 5 tools (execute_sql, get_schema, get_ladder, search_afl, get_last_updated) with 3 Code Mode tools (schema, tools, code) — LLM writes TypeScript that executes in sandboxed isolates against D1
- **Data sync:** Replaced GitHub Actions ETL pipeline (R + Docker + cron) with native Cloudflare Workers cron triggers syncing via the fitzroy npm package
- **MCP transport:** Switched from stdio (FastMCP) to streamable HTTP
- **CI/CD:** Rewrote GitHub Actions for Node.js (vitest + tsc) and Cloudflare deployment (wrangler)
- **Dependabot:** Updated ecosystems from pip/docker to npm/github-actions

### Added

- Sandboxed code execution via Cloudflare Dynamic Worker isolates with DbProxy RPC bridge
- Freshness check during match windows (every 5 min Thu–Mon) to trigger sync only when new data is available
- PAV recalculation on daily cron (3am AEST)
- Team and venue name normalisation layer for consistent data from fitzroy
- Test suite: 33 tests covering MCP protocol, cron scheduling, normalisation, and PAV guard logic
- MIT license

### Removed

- Python codebase (src/afl_mcp/, CLI, FastMCP server)
- PostgreSQL schema and migrations (db/)
- R extraction scripts and Docker images (etl/)
- Semantic search and vector embeddings (pgvector)
- DigitalOcean deployment configuration (.do/)

## [1.2.0] - 2026-03-20

### Added

- Quarter-by-quarter match scores (16 new columns: home/away Q1-Q4 goals and behinds)
- Match weather data from AFL API (temperature, weather type)
- Match local start time from AFL API
- Match rushed behinds and minutes in front from AFL API
- 13 new player stat columns from AFL API: goal accuracy, goal efficiency, shot efficiency, kick efficiency, kick-to-handball ratio, contested possession rate, contest def loss percentage, contest off wins percentage, centre bounce attendances, kick-ins, kick-ins play-on, interchange counts, total possessions
- SuperCoach score enrichment from fryzigg source
- FootyWire results now capture goals, behinds, margin, and round number (previously dropped)

### Fixed

- Match margin now computed and stored during AFL API load (was always NULL)
- Nested AFL API period scores flattened in R extraction before CSV export

## [1.1.2] - 2026-03-20

### Fixed

- Removed broken Claude Code Review workflow that failed due to authentication issues
- Refactored connection pool and admin connection handling with proper type narrowing and error messages
- Improved embedding and semantic search modules with explicit error handling and type safety
- Simplified loader internals: flattened nested comprehensions, extracted helper functions, reduced cognitive complexity
- Hardened PAV calculation with bounds checking and explicit type annotations
- Improved SQL query safety with consistent error handling patterns
- Cleaned up MCP server tool registration with better type annotations

### Added

- Comprehensive test coverage for CLI helpers, database module, embeddings, MCP server, PAV calculations, and semantic search
- Query safety tests for additional SQL injection patterns

## [1.1.1] - 2026-03-19

### Fixed

- Duplicate player entries in production database caused by CD_I (AFL API) player IDs being inserted into the `external_id` column instead of `external_afl_player_id`
- Player loader now self-heals misplaced CD_I IDs found in `external_id` during Pass 2, moving them to `external_afl_player_id` and linking to the correct player record
- Added whitespace stripping on `player_id` values during CSV ingestion to prevent ID routing errors

## [1.1.0] - 2026-03-16

### Added

- Multi-source ETL: AFL official API as primary data source (fastest updates), FootyWire as fallback, fryzigg as enrichment for advanced stats
- Column mapping infrastructure for AFL API and FootyWire data formats (`AFL_RESULTS_COLUMN_MAP`, `AFL_STATS_COLUMN_MAP`, `FOOTYWIRE_RESULTS_COLUMN_MAP`)
- `_load_matches_from_afl()` loader with upsert on `(date, home_team_id, away_team_id)` natural key
- `_load_matches_from_footywire()` loader with insert-only dedup via `ON CONFLICT DO NOTHING`
- `_enrich_from_fryzigg()` function for COALESCE-based enrichment of 19 advanced stat columns
- `_detect_source_files()` and `_resolve_sources()` for auto-detecting CSV source files by filename pattern
- Database migration `007_add_afl_source_tracking.sql`: `external_afl_id` column, tuple-based unique constraint, performance index
- New team name mappings for AFL API (`Sydney Swans`, `Geelong Cats`, `GWS GIANTS`, etc.) and FootyWire (`Brisbane`)
- New venue name mappings for AFL API (`Corroboree Group Oval Manuka`, `TIO Traeger Park`)
- Whitespace stripping in `_normalise_team()` and `_normalise_venue()` for FootyWire leading-space data
- Test suite for column remapping, enrichment semantics, and source file detection (`test_enrichment.py`)

### Changed

- ETL extraction script (`etl/extract.R`) uses AFL API as primary source for seasons >= 2020, with FootyWire fallback and fryzigg enrichment pass
- `load_all()` auto-detects source files and routes to appropriate loaders by priority; fully backward compatible with legacy `results.csv` + `player_stats.csv`
- Data update workflow cron frequency increased from every 6 hours to every 2 hours
- Match lookup built once and shared between stats loading and fryzigg enrichment (eliminates duplicate table scan)

## [1.0.0] - 2026-03-16

### Changed

- Reduced MCP tool surface from 14 tools to 5: `execute_sql`, `get_schema`, `get_ladder`, `search_afl`, `get_last_updated`
- Removed 10 high-level tools (`search_players`, `stat_leaders`, `head_to_head`, `player_career_summary`, `player_comparison`, `search_matches`, `get_pav_leaders`, `get_player_pav`, `search_match_summaries`, `search_player_seasons`) — all queries composable via `execute_sql`
- Overhauled CLI: new `sql`, `schema`, `ladder`, `search`, `status` commands with `--format` (json/table/csv) and `--pretty` flags
- Added hidden command aliases matching MCP tool names (`execute-sql`, `get-schema`, `get-ladder`)
- Enriched tool descriptions with full schema documentation, join patterns, and PAV interpretation guide
- Extracted `get_schema_dict()` in core to eliminate duplicated schema assembly logic
- Derived `_ROUND_MAP` from `_SYNONYM_MAP` to eliminate duplicate round abbreviation data
- Rewrote `get_last_updated` SQL with CTEs to reduce redundant table scans

### Added

- `get_last_updated` MCP tool and `status` CLI command for data freshness metadata
- CSV output format for all CLI query commands

### Removed

- 10 MCP tools superseded by `execute_sql` (see Changed)
- 11 CLI commands backing removed tools (`query`, `players`, `leaders`, `h2h`, `career`, `compare`, `matches`, `pav-leaders`, `pav`, `search-matches`, `search-seasons`)

## [0.4.1] - 2026-03-15

### Added

- Anonymous embeddings for player season "find similar" searches — strips player name and team from summaries so results match on statistical profile rather than team identity
- SuperCoach and AFL Fantasy numeric filters extracted from queries (e.g. "supercoach 120" → AVG >= 115)
- Stat-profile queries with "high"/"low" modifiers (e.g. "high tackles low disposals" → AVG(tackles) >= 6 AND AVG(disposals) <= 15)
- `min_games` parameter on unified `search_afl` tool and CLI `search` command
- AFL Fantasy average included in player season summary text and anonymous embeddings

### Changed

- Player season embedding pipeline generates dual embeddings (named + anonymous) per season
- Incremental embedding mode backfills rows missing `anon_embedding`

## [0.4.0] - 2026-03-15

### Added

- Synonym expansion at query time maps domain terms to template vocabulary (e.g. "grand final" → GF, "ruckman" → hitouts, "close game" → low margin terms)
- Hard SQL filters extracted from queries: round names ("grand final" → `round = 'GF'`), margin terms ("close" → `ABS(margin) <= 10`, "draw" → `margin = 0`, "blowout" → `ABS(margin) >= 60`), positional filters ("ruckman" → `AVG(hitouts) >= 15`, "key forward" → `AVG(goals) >= 1.5`, "midfielder" → `AVG(disposals) >= 20`, "defender" → `AVG(intercepts) >= 4`)
- Numeric filter extraction parses explicit numbers from queries (e.g. "margin under 10", "30 disposals", "50 goals") into SQL WHERE clauses
- Rank field in all search results for easy ordering reference
- Summary text included in match and player season search results

### Fixed

- Top performers fallback sort for pre-2007 matches without AFL Fantasy scores (uses weighted stat formula)
- Set `hnsw.ef_search = 1000` when filters are present to prevent pgvector HNSW index returning empty results with selective WHERE clauses

## [0.3.1] - 2026-03-15

### Fixed

- Install sentence-transformers in MCP server Dockerfile (enables text query search)
- Player "find similar" now excludes all seasons by the source player, not just the source season

## [0.3.0] - 2026-03-15

### Added

- Hybrid semantic search with Reciprocal Rank Fusion (vector + full-text)
- search_match_summaries tool: find matches by query or similarity to existing match
- search_player_seasons tool: find player seasons by query or similarity
- search_afl tool: unified cross-table search returning mixed results
- "Find similar" mode using stored embeddings (no embedding API call needed)
- Match results enriched with top 3 performers per team (by AFL Fantasy score)
- Player season results enriched with PAV ratings
- GIN full-text indexes on summary tables for keyword matching
- Switched to uv for dependency management with committed lockfile

## [0.2.0] - 2026-03-15

### Added

- 7 high-level MCP tools: search_players, get_ladder, stat_leaders, head_to_head, player_career_summary, player_comparison, search_matches
- HPN Player Approximate Value (PAV) rating system with pre-computed storage (1998 onwards)
- PAV tools: get_pav_leaders (season leaderboard by zone) and get_player_pav (career history)
- Incremental embedding generation with current-season refresh
- Team alias resolution for all 18 AFL teams (e.g. "Pies" → Collingwood)
- CLI commands for all tools: players, ladder, leaders, h2h, career, compare, matches, pav, pav-leaders
- Slim Docker image for embedding generation (CPU-only PyTorch)

### Changed

- Ladder output now includes position (#) column
- Player career summary includes contested possessions, clearances, inside 50s, rebounds, intercepts, metres gained, hitouts, fantasy/supercoach averages
- Player comparison includes richer stats (rebounds, intercepts, metres gained, hitouts, fantasy/supercoach averages)
- Player comparison accepts names or IDs (previously IDs only)
- Embedding generation deduplicated via shared _embed_and_upsert helper
- calculate_all_pav reuses single DB connection instead of one per year
- search_players applies LIMIT before LATERAL join for efficiency
- CI workflows hardened: concurrency keys, Docker layer caching, environment protection, secret hygiene

## [0.1.0] - 2026-03-14

### Added

- PostgreSQL schema for AFL data: competitions, seasons, teams, venues, players, matches, player_match_stats
- R extraction script using fitzRoy package for seasons 2016-2025 (AFLM)
- CSV data loader with idempotent upserts, team/venue name normalisation
- Read-only SQL query execution with two-layer safety (regex + PostgreSQL session)
- Schema introspection (tables, columns, foreign keys)
- pgvector embedding tables for semantic search (player season and match summaries)
- CLI using Typer + Rich: query, search, schema, db migrate/load/embed, serve
- MCP server via FastMCP: execute_sql, semantic_search, filtered_search, get_schema tools
- Match metadata: attendance, local time, weather from fryzigg source
- Player position, guernsey number, brownlow votes, and 16 additional stat columns
- Dual external ID tracking on matches (afltables + fryzigg)
- Unit test suite (102 tests) covering query safety, loader helpers, embeddings, search, MCP tools
- Integration test suite (10 tests) for live database verification
- CI pipeline: ruff lint/format, pytest, build verification, pyright typecheck
- Dependabot configuration for pip and GitHub Actions
