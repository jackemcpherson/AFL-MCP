# AFL-MCP

[![CI](https://github.com/jackemcpherson/AFL-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/jackemcpherson/AFL-MCP/actions/workflows/ci.yml)

MCP server for AFL Men's statistics, powered by Cloudflare Workers and D1. Covers match results and player statistics from 1990 to the current season, updated automatically via cron-triggered sync from the AFL API.

## Architecture

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (SQLite)
- **MCP transport:** Streamable HTTP
- **Data source:** [fitzroy](https://www.npmjs.com/package/fitzroy) npm package (AFL API)
- **Sandbox:** User-submitted TypeScript executes in isolated Dynamic Worker isolates with read-only DB access

## MCP Tools

The server exposes 3 tools via the [Model Context Protocol](https://modelcontextprotocol.io/):

| Tool | Purpose |
|------|---------|
| `schema` | Database structure, column details, join patterns, query API reference |
| `tools` | Sandbox capabilities, constraints, and guidance |
| `code` | Execute TypeScript against the D1 database in an isolated sandbox |

**Endpoint:** `https://afl.jackemcpherson.com/mcp`

## Getting Started

### Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare Workers CLI)
- A Cloudflare account with D1 access

### Setup

```bash
bun install
```

### Development

```bash
bun run dev
```

### Running Tests

```bash
bun run test
```

### Type Checking

```bash
bun run typecheck
```

### Lint and Format

```bash
bun run check        # check for issues
bun run format       # auto-fix formatting
```

### Deployment

```bash
bunx wrangler deploy
```

D1 migrations:

```bash
bunx wrangler d1 migrations apply afl-stats --remote
```

## Data Sync

A single cron (`*/5 * * * *`) drives all data updates. The orchestrator in
`src/sync/sync.ts` decides whether to fetch on each tick: it always runs at
the top of the hour, and otherwise runs only when a match exists in the
database within roughly ±3 days of now. PAV is recalculated from inside the
same pipeline whenever new player stats land.

See [`docs/sync.md`](./docs/sync.md) for the full pipeline, the `shouldRunNow`
gate, and the AFL season-structure considerations (Opening Round, finals
codes) that any query touching match data needs to handle.

## Further Documentation

- [`docs/architecture.md`](./docs/architecture.md) — Worker entry, MCP transport,
  sandbox model.
- [`docs/sync.md`](./docs/sync.md) — Cron, gating, sync pipeline, PAV.
- [`docs/schema.md`](./docs/schema.md) — D1 table reference.

## Contributing

1. Create a feature branch
2. Make changes and add tests
3. Run `bun run typecheck` and `bun run check`
4. Run `bun run test` to verify tests pass
5. Submit a pull request

## License

MIT
