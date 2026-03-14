# AFL-MCP

AFL statistics platform that extracts data from the [fitzRoy](https://jimmyday12.github.io/fitzRoy/) R package, stores it in PostgreSQL with pgvector, and exposes it through a CLI and MCP server for LLM-powered querying.

## Getting Started

### Prerequisites

- Python 3.11+
- PostgreSQL 17+ with [pgvector](https://github.com/pgvector/pgvector) extension
- R with the `fitzRoy` and `readr` packages (for data extraction only)

### Installation

```bash
git clone <repo-url> && cd AFL-MCP
python -m venv .venv && source .venv/bin/activate
pip install -e ".[test]"
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
```

## Usage

### CLI Queries

```bash
# Run a SQL query
afl-mcp query "SELECT name FROM teams ORDER BY name"

# JSON output
afl-mcp query "SELECT * FROM matches LIMIT 5" --json

# Schema introspection
afl-mcp schema players
```

### MCP Server

```bash
# Start for use with Claude Desktop / Claude Code
afl-mcp serve --transport stdio
```

### All Commands

```
afl-mcp query <SQL>          Execute a read-only SQL query
afl-mcp search <QUERY>       Semantic search (requires embeddings)
afl-mcp schema [TABLE]       Show database schema
afl-mcp db migrate           Apply pending migrations
afl-mcp db load              Load CSV data
afl-mcp db embed             Generate vector embeddings
afl-mcp serve                Start MCP server
```

## Running Tests

```bash
# Unit tests (no database required)
pytest tests/ -v

# Include integration tests (requires running PostgreSQL)
DATABASE_URL="postgresql://user@localhost/afl_mcp" pytest tests/ -v
```

## Project Structure

```
src/afl_mcp/
  core/        Database, loader, queries, search, embeddings
  cli/         Typer + Rich CLI
  mcp_server/  FastMCP server with SQL and search tools
etl/           R extraction scripts
db/migrations/ PostgreSQL schema migrations
data/raw/      CSV output from ETL (gitignored)
tests/         Unit and integration tests
```

## Contributing

1. Create a feature branch
2. Make changes and add tests
3. Run `pytest tests/ -v` to verify
4. Submit a pull request
