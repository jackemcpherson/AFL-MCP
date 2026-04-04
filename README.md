# AFL-MCP

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

- [Node.js](https://nodejs.org/) 22+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare Workers CLI)
- A Cloudflare account with D1 access

### Setup

```bash
cd afl-mcp-cf
npm install
```

### Development

```bash
npx wrangler dev
```

### Running Tests

```bash
npx vitest run
```

### Type Checking

```bash
npx tsc --noEmit
```

### Deployment

```bash
npx wrangler deploy
```

D1 migrations:

```bash
npx wrangler d1 migrations apply afl-stats --remote
```

## Data Sync

Data is synced automatically via Cloudflare Workers cron triggers:

| Schedule | Task |
|----------|------|
| Every 5 min (match window) | Freshness check — sync if new results available |
| Hourly | Full sync — current season matches + player stats |
| Daily 3am AEST | PAV recalculation |

The match window covers Thursday 6pm to Monday 1am AEST, matching the standard AFL round schedule.

## Contributing

1. Create a feature branch
2. Make changes and add tests
3. Run `npx tsc --noEmit` for type checking
4. Run `npx vitest run` to verify tests pass
5. Submit a pull request
