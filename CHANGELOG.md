# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
