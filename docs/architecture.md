# Architecture

AFL-MCP is a Cloudflare Worker that exposes an MCP (Model Context Protocol)
server backed by a Cloudflare D1 database covering four Australian football
competitions: AFL Men's, AFL Women's, VFL, and VFLW. Clients connect over
Streamable HTTP to `https://afl.jackemcpherson.com/mcp` and call three Code
Mode tools: `schema`, `tools`, and `code`. The `code` tool accepts arbitrary
TypeScript which the Worker executes inside a sandboxed Dynamic Worker
isolate with read-only access to the database; an optional `competition`
parameter on the tool surfaces the dimension to the LLM as a hint (the SQL
must still filter explicitly).

## Components

| Layer | Where | What |
|-------|-------|------|
| Entry / routing | `src/index.ts` | Worker `fetch` and `scheduled` handlers; admin endpoints (`sync`, `backfill`, `recalculate-pav`). |
| MCP protocol | `src/mcp/protocol.ts` | Streamable-HTTP transport. |
| MCP tools | `src/mcp/tools/` | `schema`, `tools`, `code` definitions. |
| Sandbox | `src/sandbox/executor.ts` | Dynamic Worker isolate + `DbProxy` RPC bridge. |
| Sync | `src/sync/` | Cron-driven data pipeline (orchestrator, upserts, PAV) — multi-competition. |
| Schema | `src/db/schema.sql` | D1 schema (10 tables — see [`schema.md`](./schema.md)). |

## Code execution model

The `code` tool runs user-supplied TypeScript under a fresh
[Dynamic Worker](https://developers.cloudflare.com/workers/configuration/dynamic-workers/)
isolate created via the `LOADER` binding. The isolate is launched with
`globalOutbound: null`, so submitted code cannot reach the network.

Database access is brokered through `DbProxy`, a `WorkerEntrypoint` exported
by the parent Worker. The sandbox sees a minimal `db` object that mirrors the
familiar `prepare(...).bind(...).all()` / `.first()` shape of the D1 client;
each call hops through `DbProxy.query` / `DbProxy.queryFirst` back to the
parent's D1 binding. This keeps the surface area small and avoids handing the
sandbox the full D1 binding directly.

## Data flow

```
fitzroy (AFL API)
        │
        ▼
sync orchestrator (src/sync/sync.ts)
        │
        ├── upserts.ts   → competitions/seasons/teams/venues/players/matches/stats/lineups
        └── pav.ts       → player_season_pav (recalculated when stats change)
        │
        ▼
       D1 (afl-stats)
        │
        ▼
DbProxy ←─── sandbox isolate ←─── code tool ←─── MCP client
```

The sync writes; everything else reads through `DbProxy`. See
[`sync.md`](./sync.md) for the cron, gating, and pipeline details, and
[`schema.md`](./schema.md) for the table reference.
