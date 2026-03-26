# AFL-MCP

AFL statistics platform that extracts data from the [fitzRoy](https://jimmyday12.github.io/fitzRoy/) R package, stores it in PostgreSQL with pgvector, and exposes it through a CLI and MCP server for LLM-powered querying.

Covers AFL Men's match results and player statistics from 1990 to the current season, updated automatically every 2 hours during match rounds (Thursday evening to Monday morning AEST).

## Getting Started

### Prerequisites

- [uv](https://docs.astral.sh/uv/) (Python package manager)
- Python 3.11+
- PostgreSQL 17+ with [pgvector](https://github.com/pgvector/pgvector) extension
- R with the `fitzRoy` and `readr` packages (for data extraction only)

### Installation

```bash
git clone <repo-url> && cd AFL-MCP
uv sync --extra test
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your PostgreSQL connection string
```

### Data Pipeline

```bash
# 1. Extract data from fitzRoy (requires R)
Rscript etl/extract.R

# 2. Apply database schema
afl-mcp db migrate

# 3. Load CSV data into PostgreSQL
afl-mcp db load

# 4. Generate embeddings for semantic search (requires sentence-transformers)
uv sync --extra ml
afl-mcp db embed

# 5. Calculate PAV ratings (1998 onwards)
afl-mcp db pav
```

## MCP Tools

The server exposes 5 tools for LLM consumption:

| Tool | Purpose | When to use |
|---|---|---|
| `execute_sql` | Read-only SQL queries | Structured questions, aggregations, joins, PAV analysis |
| `get_schema` | Database structure | Before writing SQL, especially first call in a session |
| `get_ladder` | Season standings | "Where does X sit on the ladder?" |
| `search_afl` | Semantic search | Exploratory, fuzzy, or natural language questions |
| `get_last_updated` | Data freshness | "Is this week's data in yet?" |

```bash
# Start for use with Claude Desktop / Claude Code
afl-mcp serve --transport stdio
```

## CLI Usage

```bash
# SQL queries
afl-mcp sql -q "SELECT name FROM teams ORDER BY name"
afl-mcp sql -q "SELECT * FROM matches LIMIT 5" --format json --pretty

# Schema introspection
afl-mcp schema -t players

# Ladder
afl-mcp ladder -y 2024
afl-mcp ladder -y 2025 -r 5

# Semantic search
afl-mcp search "Geelong 2007"
afl-mcp search "close grand finals" -n 5
afl-mcp search "dominant ruckman season" --team Demons --min-games 15

# Data freshness
afl-mcp status

# Output formats (all query commands)
--format table   # default, human-readable
--format json    # machine-readable
--format csv     # for piping
--pretty         # pretty-print JSON
```

### Database Management

```bash
afl-mcp db migrate           # Apply pending migrations
afl-mcp db load              # Load CSV data
afl-mcp db embed             # Generate vector embeddings
afl-mcp db pav               # Calculate PAV ratings
```

## Running Tests

```bash
# Unit tests (no database required)
pytest tests/ -v --ignore=tests/test_integration.py

# Include integration tests (requires running PostgreSQL)
DATABASE_URL="postgresql://user@localhost/afl_mcp" pytest tests/ -v
```

## Project Structure

```
src/afl_mcp/
  core/        Database, loader, queries, semantic search, embeddings, PAV
  cli/         Typer + Rich CLI (5 tool commands + db management + serve)
  mcp_server/  FastMCP server (5 tools)
etl/           R extraction scripts + Docker images
data/raw/      CSV output from ETL (gitignored)
tests/         Unit and integration tests
```

## Contributing

1. Create a feature branch
2. Make changes and add tests
3. Run `ruff check src/ tests/ && ruff format --check src/ tests/` for lint
4. Run `pyright src/` for type checking
5. Run `pytest tests/ -v --ignore=tests/test_integration.py` to verify
6. Submit a pull request
