# AFL-MCP Development Guide

## Architecture

AFL-MCP is a Cloudflare Worker serving an MCP (Model Context Protocol) server
with 3 Code Mode tools: `schema`, `tools`, `code`. The LLM writes TypeScript
that executes in sandboxed Dynamic Worker isolates against a D1 (SQLite)
database.

- **Runtime:** Cloudflare Workers
- **Database:** Cloudflare D1 (`afl-stats`)
- **MCP transport:** Streamable HTTP at `https://afl.jackemcpherson.com/mcp`
- **Data sync:** Cron-triggered via `fitzroy` npm package (AFL API source)
- **Sandbox:** Dynamic Workers with `DbProxy` RPC bridge for D1 access
- **Worker code:** `afl-mcp-cf/` subdirectory

## AFL Season Structure

The AFL season includes special rounds that don't follow the standard numeric
round numbering. When working with match data, always account for:

- **Opening Round**: Played before Round 1 (typically 4-5 games). In the
  database this appears as `round = 'Opening Round'` with `round_number = 0`.
  The 2026 season Opening Round had 5 games.
- Numbered rounds use short codes: `R1`, `R2`, etc.
- Finals: `QF`, `EF`, `SF`, `PF`, `GF`.
- `round_type` is either `'Regular'` or `'Finals'`.

When implementing freshness checks, ETL logic, or match queries, never filter or
group by round name/number alone — always use date-based or total match count
comparisons to avoid accidentally excluding Opening Round or other non-standard
rounds.

## Cron Schedule

- `*/5 * * * *` — Freshness check during match windows (Thu 6pm – Mon 1am AEST)
- `0 * * * *` — Full sync (current season matches + player stats)
- `0 17 * * *` — PAV recalculation (3am AEST)

## Key Files

- `afl-mcp-cf/src/index.ts` — Worker entry point, routing
- `afl-mcp-cf/src/mcp/protocol.ts` — MCP streamable-http implementation
- `afl-mcp-cf/src/mcp/tools/schema.ts` — Hardcoded schema documentation
- `afl-mcp-cf/src/sandbox/executor.ts` — Dynamic Worker + DbProxy RPC bridge
- `afl-mcp-cf/src/sync/` — Cron sync pipeline (matches, stats, players, PAV)
- `afl-mcp-cf/src/db/schema.sql` — D1 schema (8 tables)

## Deployment

```bash
cd afl-mcp-cf
npx wrangler deploy
```

D1 migrations:
```bash
npx wrangler d1 migrations apply afl-stats --remote
```
