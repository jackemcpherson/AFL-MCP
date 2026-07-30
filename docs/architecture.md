# Architecture

AFL-MCP is a Cloudflare Worker that serves Australian football data through the
Model Context Protocol. Cloudflare D1 stores AFLM, AFLW, VFL, and VFLW data.

Clients connect to `https://afl.jackemcpherson.com/mcp` through Streamable HTTP.
The server exposes `schema` and `code`. Sandbox constraints travel in the
`code` tool's description.

## Schema Contract

The `schema` tool accepts three request shapes:

- No arguments return the complete static schema without reading D1.
- `competition` returns the static schema for one competition.
- `competition`, `season`, and `includeObserved: true` add bounded observations.

The observed request runs indexed aggregates for statistics, weather, PAV, and
lineups. The Worker caches successful output for 15 minutes. It rejects every
other argument combination before querying D1.

## Components

| Layer             | Location                  | Responsibility                                          |
| ----------------- | ------------------------- | ------------------------------------------------------- |
| Entry and routing | `src/index.ts`            | Worker fetch, scheduled, and authenticated admin routes |
| Admin operations  | `src/admin/`              | Brownlow backfill and bounded operator status           |
| MCP protocol      | `src/mcp/protocol.ts`     | Streamable HTTP transport                               |
| MCP tools         | `src/mcp/tools/`          | `schema` and `code` definitions                         |
| Sandbox           | `src/sandbox/executor.ts` | Dynamic Worker isolation and `DbProxy` access           |
| Sync              | `src/sync/`               | Cron orchestration, upserts, weather, and PAV           |
| Schema            | `src/db/schema.sql`       | D1 schema documented in [Schema Reference](schema.md)   |

## Code Execution Model

The `code` tool launches a fresh
[Dynamic Worker](https://developers.cloudflare.com/workers/configuration/dynamic-workers/)
through the `LOADER` binding. `globalOutbound: null` prevents submitted code
from reaching the network.

The parent Worker exports `DbProxy` as a `WorkerEntrypoint`. The sandbox
receives only a small, read-only database interface that supports prepared
queries. Every call returns through `DbProxy.query` or `DbProxy.queryFirst` to
the parent D1 binding.

The optional `competition` argument records a telemetry hint. It never changes
submitted SQL. Client code must still filter through `seasons` and
`competitions`.

## Data Flow

```text
fitzroy and AFL API
        |
        v
sync orchestrator
        |
        |-- upserts to reference, match, stat, and lineup tables
        `-- calculates player_season_pav after stat changes
        |
        v
Cloudflare D1
        |
        v
DbProxy <- sandbox isolate <- code tool <- MCP client
```

Sync and authenticated admin operations can write. MCP client code receives only
read access through `DbProxy`.

Brownlow ingestion shares the sync lease with cron and manual sync. Private
status uses fixed aggregate queries and never returns raw diagnostics.

See [Data Sync](sync.md) for orchestration and [Schema Reference](schema.md) for
the table contract.
