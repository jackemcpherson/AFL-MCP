# AFL-MCP

[![CI](https://github.com/jackemcpherson/AFL-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/jackemcpherson/AFL-MCP/actions/workflows/ci.yml)

MCP server for Australian football statistics covering AFL Men's, AFL Women's, VFL, and VFLW. Powered by Cloudflare Workers and D1, with cron-triggered sync from the AFL API via [fitzroy](https://www.npmjs.com/package/fitzroy).

## Coverage

| Competition | Years | Matches | Stats | Lineups | PAV |
|---|---|:-:|:-:|:-:|:-:|
| AFL Men's (`AFLM`) | 1990 to current | ✓ | ✓ | 2015+ | 1998+ |
| AFL Women's (`AFLW`) | 2017 to current | ✓ | ✓ | 2017+ | 2017+ |
| VFL | 2021 to current | ✓ | ✓ | best-effort | – |
| VFLW | 2021 to current | ✓ | ✓ | best-effort | – |

PAV (Player Approximate Value) is computed for AFLM and AFLW only — VFL/VFLW are excluded because the AFL API doesn't populate the formula's required inputs (`goal_assists`, `marks_inside_50`, `one_percenters`) for those competitions.

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
| `schema` | Database structure, per-competition coverage, column details, join patterns, query API reference |
| `tools` | Sandbox capabilities, constraints, and guidance |
| `code` | Execute TypeScript against the D1 database in an isolated sandbox. Optional `competition` arg hints which competition the query is about (you must still filter via `JOIN competitions c WHERE c.code = ?` — the param does not auto-inject SQL; it is recorded for usage telemetry) |

**Endpoint:** `https://afl.jackemcpherson.com/mcp`

### Filtering by competition

Always join through `seasons → competitions` and filter by `c.code` in your SQL. Without the filter, results mix competitions silently because team rows with the same name (e.g. Carlton AFLM vs Carlton VFL) are distinct `team_id`s.

```sql
SELECT m.date, ht.name AS home, m.home_points, at.name AS away, m.away_points
FROM matches m
JOIN seasons s ON m.season_id = s.id
JOIN competitions c ON s.competition_id = c.id
JOIN teams ht ON m.home_team_id = ht.id
JOIN teams at ON m.away_team_id = at.id
WHERE c.code = 'AFLW' AND s.year = 2025;
```

The `round_abbreviation` column carries the AFL's standard short codes (`Rd N`, `OR`, `WC`, `FW1`, `SF`, `PF`, `GF`) and is consistent across all four competitions — useful for cross-competition queries:

```sql
-- All grand finals across all competitions
SELECT c.code, s.year, ht.name, m.home_points, at.name, m.away_points
FROM matches m
JOIN seasons s ON m.season_id = s.id
JOIN competitions c ON s.competition_id = c.id
JOIN teams ht ON m.home_team_id = ht.id
JOIN teams at ON m.away_team_id = at.id
WHERE m.round_abbreviation = 'GF'
ORDER BY s.year DESC, c.code;
```

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

A single cron (`*/5 * * * *`) drives all data updates for all four competitions. The orchestrator in `src/sync/sync.ts` decides whether to fetch on each tick: it always runs at the top of the hour, and otherwise runs only when a match exists in the database within 1 day back / 3 days forward of now. PAV is recalculated from inside the same pipeline whenever new player stats land for AFLM or AFLW.

For one-shot historical loads, `POST /mcp/admin/backfill` accepts:

```json
{
  "competitions": ["AFLW"],
  "fromYear": 2017,
  "toYear": 2025,
  "skipShouldRunNow": true,
  "skipPav": false
}
```

It iterates `(competition, year)` pairs and returns per-tick row counts. Caller is responsible for chunking year ranges to stay under the Worker walltime cap (typically a single year per request for AFLM, a few for the smaller competitions).

See [`docs/sync.md`](./docs/sync.md) for the full pipeline, the `shouldRunNow` gate, and the AFL season-structure considerations (Opening Round, finals codes, VFL Wildcard) that any query touching match data needs to handle.

## Further Documentation

- [`docs/architecture.md`](./docs/architecture.md) — Worker entry, MCP transport, sandbox model.
- [`docs/sync.md`](./docs/sync.md) — Cron, gating, sync pipeline, PAV scope, backfill endpoint.
- [`docs/schema.md`](./docs/schema.md) — D1 table reference.

## Contributing

1. Create a feature branch
2. Make changes and add tests
3. Run `bun run typecheck` and `bun run check`
4. Run `bun run test` to verify tests pass
5. Submit a pull request

## License

MIT
