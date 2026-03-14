# AFL-MCP - Product Requirements Document

## Overview

AFL-MCP is an AFL statistics platform that extracts data from the fitzRoy R package, stores it in a PostgreSQL database with vector search capabilities, and exposes it through both a CLI tool and an MCP server. The MCP server allows LLMs to query AFL data on behalf of amateur analysts using natural language.

## Goals

- Provide a clean, well-structured PostgreSQL database of AFL statistics derived from fitzRoy
- Enable flexible data access through SQL execution and semantic search
- Expose identical query capabilities via both a CLI (for iteration) and an MCP server (for LLM access)
- Design the schema to accommodate future AFLW data without rework

## Non-Goals

- AFLW data ingestion (deferred to v2, but schema must support it)
- Automated data refresh / ETL scheduling (start with static dataset)
- Web UI or dashboard
- Advanced analytics, fantasy scoring, or predictive models
- Authentication or rate limiting on the MCP server
- Direct user access to the fitzRoy R package (used only for ETL)
- Deployment architecture decisions (deferred until implementation is further along)

## User Stories Overview

**Primary persona: AFL Amateur Analyst** - An AFL fan who wants to explore historical stats, compare players, research match history, and answer questions about AFL data. They interact via an LLM connected to the MCP server, or directly via the CLI.

**Secondary persona: Developer/Maintainer** - Uses the CLI for data management, testing queries, and iterating on functionality before exposing it through MCP.

## Requirements

### Functional Requirements

#### Data Research & Schema Design
- FR-001: Research and document the data structures provided by the fitzRoy R package, covering matches, players, teams, and player statistics
- FR-002: Design a normalised PostgreSQL schema that models the core AFL domain (teams, players, matches, player match statistics, seasons)
- FR-003: Schema must be designed to support AFLW data in future without structural changes (e.g., a competition/league discriminator)
- FR-004: Schema must support vector embeddings for semantic search (pgvector)

#### Data Extraction & Loading
- FR-005: Build an R-based extraction script that pulls data from fitzRoy for the target time range (10 years / 2016-2025 seasons)
- FR-006: Export extracted data in a portable format (CSV or JSON) for loading into PostgreSQL
- FR-007: Build a data loading pipeline that populates the database from exported fitzRoy data
- FR-008: Data loading must be idempotent (safe to re-run without duplicating records)

#### Core Query Library (Python)
- FR-009: Implement a shared Python library that encapsulates all query functions
- FR-010: Support parameterised SQL query execution with safety guards against destructive operations (read-only)
- FR-011: Support semantic search across the dataset (e.g., "dominant key forwards of the 2020s")
- FR-012: Support filtered semantic search combining vector similarity with SQL predicates (e.g., semantic search scoped to a team or season range)
- FR-013: Use the simplest viable embedding solution (e.g., sentence-transformers or similar local model to avoid external API dependencies)

#### CLI
- FR-014: Build a CLI tool that exposes all core query functions from the shared library
- FR-015: CLI must support executing arbitrary read-only SQL queries against the database
- FR-016: CLI must support semantic search and filtered semantic search
- FR-017: CLI output should be human-readable (formatted tables, JSON option)

#### MCP Server
- FR-018: Build an MCP server using the fastMCP Python framework
- FR-019: MCP server must expose the same set of tools/functions as the CLI
- FR-020: Each MCP tool must have clear descriptions and parameter schemas so LLMs can use them effectively
- FR-021: MCP server must connect to the hosted PostgreSQL instance on Digital Ocean

### Non-Functional Requirements

- NFR-001: Database must be hosted on Digital Ocean managed PostgreSQL with pgvector extension enabled
- NFR-002: All SQL execution must be read-only from the CLI/MCP interfaces (no INSERT/UPDATE/DELETE exposed to users)
- NFR-003: Semantic search should return results in under 5 seconds for the 10-year dataset
- NFR-004: CLI and MCP server must share a single core library - no duplicated query logic
- NFR-005: Schema migrations should be version-controlled and reproducible

## Technical Considerations

### Architecture

```
┌─────────────┐     ┌─────────────────┐     ┌──────────────────────┐
│  fitzRoy R  │────▶│  Exported Data   │────▶│  PostgreSQL + pgvec  │
│  (ETL only) │     │  (CSV/JSON)      │     │  (Digital Ocean)     │
└─────────────┘     └─────────────────┘     └──────────┬───────────┘
                                                        │
                                              ┌─────────┴─────────┐
                                              │  Core Python Lib   │
                                              │  (queries, search) │
                                              └─────────┬─────────┘
                                                        │
                                            ┌───────────┼───────────┐
                                            │                       │
                                      ┌─────┴─────┐         ┌──────┴──────┐
                                      │    CLI     │         │  MCP Server │
                                      │  (click?)  │         │  (fastMCP)  │
                                      └───────────┘         └─────────────┘
```

- **Shared core library**: All query logic lives in one Python package. CLI and MCP server are thin wrappers.
- **Embedding generation**: Run at data load time, stored in pgvector columns. Use a lightweight local model (e.g., `all-MiniLM-L6-v2` via sentence-transformers) to avoid API costs and external dependencies.
- **Read-only access**: CLI and MCP connections use a read-only database role.

### Tech Stack

| Component | Technology |
|-----------|-----------|
| Data extraction | R + fitzRoy package |
| Database | PostgreSQL + pgvector (Digital Ocean Managed) |
| Core library | Python |
| CLI | Python (e.g., click or typer) |
| MCP server | Python + fastMCP |
| Embeddings | sentence-transformers (local) |
| Schema migrations | SQL files (version-controlled) |

### Dependencies

- **fitzRoy** R package (CRAN) - AFL data source
- **psycopg** or **asyncpg** - PostgreSQL driver for Python
- **pgvector** extension on PostgreSQL
- **sentence-transformers** - local embedding generation
- **fastMCP** - MCP server framework

### Integration Points

- **fitzRoy → PostgreSQL**: One-directional ETL. R scripts extract, export to flat files, Python scripts load into database.
- **Core library → PostgreSQL**: Connection pooling via the Python driver. Read-only role for query interfaces.
- **MCP server → LLM clients**: Standard MCP protocol. Any MCP-compatible client (Claude Desktop, Claude Code, etc.) can connect.

## Success Criteria

- [ ] fitzRoy data structures are documented and mapped to a relational schema
- [ ] PostgreSQL database is populated with 10 years of AFL match and player data
- [ ] Database is running on Digital Ocean with pgvector enabled
- [ ] CLI can execute SQL queries and return formatted results
- [ ] Semantic search returns relevant results for natural language queries about players/matches
- [ ] Filtered semantic search works (e.g., "best ruckmen" scoped to 2020-2025)
- [ ] MCP server exposes all CLI functions as tools
- [ ] An LLM (e.g., Claude) can answer AFL stats questions by calling MCP tools
- [ ] Schema supports future AFLW data addition without migration

## Open Questions

- **Embedding strategy**: What text should be embedded? Player descriptions, match summaries, stat narratives? Needs experimentation once data shape is understood.
- **Data refresh**: How and when to update the database as new seasons/rounds are played. Deferred but should inform schema design (e.g., tracking data freshness).
- **Deployment model**: Containerised app vs. Droplet vs. App Platform for the MCP server. Deferred.
- **Project naming**: AFL-MCP is the working name. Final name TBD before launch.
- **Specific fitzRoy endpoints**: Which fitzRoy functions provide the most complete/useful data? Research phase will determine this.
- **Database hosting tier**: Which Digital Ocean managed PostgreSQL plan is sufficient for this dataset size?

## References

- [fitzRoy R package (CRAN)](https://cran.r-project.org/package=fitzRoy)
- [fitzRoy documentation](https://jimmyday12.github.io/fitzRoy/)
- [fastMCP framework](https://github.com/jlowin/fastmcp)
- [pgvector PostgreSQL extension](https://github.com/pgvector/pgvector)
- [Digital Ocean Managed PostgreSQL](https://www.digitalocean.com/products/managed-databases-postgresql)
- [MCP specification](https://modelcontextprotocol.io/)
