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

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Start local worker (wrangler dev)
bun run deploy           # Deploy to Cloudflare Workers
bun run typecheck        # Type-check without emitting (tsc --noEmit)
bun run check            # Lint + format check (biome check .)
bun run format           # Auto-format (biome format --write .)
bun run test             # Run all tests (vitest)
```

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

- `src/index.ts` — Worker entry point, routing
- `src/mcp/protocol.ts` — MCP streamable-http implementation
- `src/mcp/tools/schema.ts` — Hardcoded schema documentation
- `src/sandbox/executor.ts` — Dynamic Worker + DbProxy RPC bridge
- `src/sync/` — Cron sync pipeline (matches, stats, players, PAV)
- `src/db/schema.sql` — D1 schema (8 tables)

## Key Constraints

- **Strict TypeScript** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `noUnusedParameters` are all enabled.
- **No `any`** — Biome enforces `noExplicitAny: "error"`. Use `unknown` and narrow.
- **No `enum`** — use union types instead.
- **No default exports** — Biome enforces `noDefaultExport: "error"`, with overrides
  only for `*.config.ts`.
- **Bun** as package manager, **Biome** for lint+format, **Vitest** for tests.
- Use Web Standard APIs only (no Bun-specific) — code runs on Cloudflare Workers V8.

## Documentation (TSDoc)

Follow Google-style TSDoc conventions. Document all public functions, exported
interfaces/types, and module-level constants with `@param`, `@returns`, `@throws`,
and `@example` tags. Skip docs for self-explanatory one-liners.

## Deployment

```bash
bunx wrangler deploy
```

D1 migrations:
```bash
bunx wrangler d1 migrations apply afl-stats --remote
```
