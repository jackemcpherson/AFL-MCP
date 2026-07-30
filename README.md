# AFL-MCP

[![CI](https://github.com/jackemcpherson/AFL-MCP/actions/workflows/ci.yml/badge.svg)](https://github.com/jackemcpherson/AFL-MCP/actions/workflows/ci.yml)

MCP server for Australian football statistics covering AFL Men's, AFL Women's,
VFL, and VFLW. Powered by Cloudflare Workers and D1, with cron-triggered sync
from the AFL API via [fitzroy](https://www.npmjs.com/package/fitzroy).

## Coverage

| Competition          | Years           | Matches | Stats |   Lineups   |  PAV  |
| -------------------- | --------------- | :-----: | :---: | :---------: | :---: |
| AFL Men's (`AFLM`)   | 1990 to current |    ✓    |   ✓   |    2015+    | 1998+ |
| AFL Women's (`AFLW`) | 2017 to current |    ✓    |   ✓   |    2017+    | 2017+ |
| VFL                  | 2021 to current |    ✓    |   ✓   | best-effort |   -   |
| VFLW                 | 2021 to current |    ✓    |   ✓   | best-effort |   -   |

The service calculates Player Approximate Value for AFLM and AFLW only. AFL API
does not supply the required inputs for VFL or VFLW.

## Architecture

- Runtime: Cloudflare Workers
- Database: Cloudflare D1 (SQLite)
- MCP transport: Streamable HTTP
- Data source: [fitzroy](https://www.npmjs.com/package/fitzroy) npm package (AFL
  API)
- Sandbox: User-submitted TypeScript executes in isolated Dynamic Worker
  isolates with read-only DB access

## MCP Tools

The server exposes 3 tools via the
[Model Context Protocol](https://modelcontextprotocol.io/):

| Tool     | Purpose                                                                                                                          |
| -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `schema` | Database structure, per-competition coverage, column details, join patterns, query API reference                                 |
| `tools`  | Sandbox capabilities, constraints, and guidance                                                                                  |
| `code`   | Execute TypeScript against D1 in an isolated sandbox. `competition` records a telemetry hint but never changes the submitted SQL |

**Endpoint:** `https://afl.jackemcpherson.com/mcp`

The no-argument `schema` call remains deterministic and read-free. To measure
current completeness for exactly one competition-season, pass
`{"includeObserved":true,"competition":"AFLM","season":2026}`. The response
keeps typed expectations separate from measured observations and caches a
successful measurement for 15 minutes. Zero rows never prove absence. The MCP
surface remains three tools.

### Filtering by Competition

Always join `seasons` to `competitions` and filter by `c.code` in your SQL.
Without the filter, results mix competitions silently because team rows with the
same name, such as Carlton AFLM and Carlton VFL, use distinct `team_id`s.

```sql
SELECT m.date, ht.name AS home, m.home_points, at.name AS away, m.away_points
FROM matches m
JOIN seasons s ON m.season_id = s.id
JOIN competitions c ON s.competition_id = c.id
JOIN teams ht ON m.home_team_id = ht.id
JOIN teams at ON m.away_team_id = at.id
WHERE c.code = 'AFLW' AND s.year = 2025;
```

The `round_abbreviation` column carries the AFL's standard short codes (`Rd N`,
`OR`, `WC`, `FW1`, `SF`, `PF`, `GF`) and is consistent across all four
competitions - useful for cross-competition queries:

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

Install the dependencies, run the checks, then deploy through Wrangler.

### Prerequisites

- [Bun](https://bun.sh/) 1.3+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (Cloudflare
  Workers CLI)
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

A single cron (`*/5 * * * *`) drives all data updates for all four competitions.
The orchestrator in `src/sync/sync.ts` evaluates every tick. It always runs at
the top of the hour. At other times, it runs only near a recorded match.

The match window spans one day before and three days after the current time. The
pipeline recalculates PAV when new AFLM or AFLW player statistics arrive.

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

It iterates through `(competition, year)` pairs and returns per-tick row counts.
Callers must keep requests within the Worker execution limit. Use one AFLM year
per request and small batches for other competitions.

### Private Operations

All `/mcp/admin/*` routes require `Authorization: Bearer <ADMIN_TOKEN>`. Two
bounded operator routes complement the normal sync:

- `POST /mcp/admin/backfill-brownlow` validates and optionally writes AFLM
  Brownlow votes for one or two seasons. Its body is
  `{ "fromYear": 2025, "toYear": 2025, "dryRun": true }`. `dryRun` defaults to
  `true`. Run the dry-run first and review the aggregate resolution and six-vote
  counters before setting it to `false`.
- `GET /mcp/admin/status` returns aggregate sync freshness, lease state,
  integrity-view counts, and 24-hour degradation event counts. It never returns
  lease holders, raw sync errors, player/match samples, or tokens.

Brownlow backfill, manual sync, and cron share one ten-minute operation lease.
An overlapping request returns `409` instead of duplicating upstream work.

See [`docs/sync.md`](./docs/sync.md) for the full pipeline and the
`shouldRunNow` gate. It also covers season structures that affect match-data
queries, including Opening Round, finals codes, and the VFL Wildcard.

## Further Documentation

- [`docs/architecture.md`](./docs/architecture.md) - Worker entry, MCP
  transport, sandbox model.
- [`docs/sync.md`](./docs/sync.md) - Cron, gating, sync pipeline, PAV scope,
  backfill and operator endpoints.
- [`docs/schema.md`](./docs/schema.md) - D1 table reference.

## Contributing

1. Create a feature branch.
2. Make changes and add tests.
3. Run `bun run typecheck` and `bun run check`.
4. Run `bun run test`.
5. Submit a pull request.

## License

[MIT](LICENSE)
