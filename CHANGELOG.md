# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
