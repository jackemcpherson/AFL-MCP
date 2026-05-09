# AFL-MCP Development Guide

## Architecture (TL;DR)

AFL-MCP is a Cloudflare Worker serving an MCP server with 3 Code Mode tools
(`schema`, `tools`, `code`). The `code` tool runs LLM-written TypeScript in
sandboxed Dynamic Worker isolates against a D1 (SQLite) database
(`afl-stats`).

For deeper context, read the appropriate doc:
- [`docs/architecture.md`](./docs/architecture.md) — Worker entry, MCP
  transport, sandbox / `DbProxy` model.
- [`docs/sync.md`](./docs/sync.md) — Single-cron orchestrator, `shouldRunNow`
  gate, PAV recalc, AFL season structure.
- [`docs/schema.md`](./docs/schema.md) — D1 table reference.

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

Deploy:
```bash
bunx wrangler deploy
bunx wrangler d1 migrations apply afl-stats --remote
```

## AFL Season Structure (footgun)

Never filter or group match data by round name or `round_number` alone — use
date-based or total match-count comparisons. The season includes special
rounds outside standard numeric ordering:

- **Opening Round** before R1 (4–5 games), stored as
  `round = 'Opening Round'`, `round_number = 0`. The 2026 Opening Round had 5
  games.
- Numbered rounds: `R1`, `R2`, …
- Finals: `QF`, `EF`, `SF`, `PF`, `GF`. `round_type` is `'Regular'` or
  `'Finals'`.

This rule applies to freshness checks, ETL logic, and any match query.

## Sync Cadence

Cron is `*/5 * * * *` (single trigger). The `shouldRunNow` gate in
`src/sync/sync.ts` runs always at the top of the hour and otherwise only when
a match exists within ±3 days. PAV is recalculated from within the pipeline
whenever stats actually change. See [`docs/sync.md`](./docs/sync.md) for the
full pipeline.

## Key Files

- `src/index.ts` — Worker entry point, routing.
- `src/mcp/protocol.ts` — MCP streamable-http implementation.
- `src/mcp/tools/schema.ts` — Hardcoded schema documentation (keep in sync
  with `src/db/schema.sql`).
- `src/sandbox/executor.ts` — Dynamic Worker + `DbProxy` RPC bridge.
- `src/sync/sync.ts` — Sync orchestrator and `shouldRunNow` gate.
- `src/sync/upserts.ts` — All DB writes for the sync pipeline.
- `src/sync/pav.ts` — PAV recalculation.
- `src/db/schema.sql` — D1 schema (10 tables).

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
