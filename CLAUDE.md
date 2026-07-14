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
bun run typecheck        # Type-check without emitting (tsc --noEmit)
bun run check            # Lint + format check (biome check .)
bun run format           # Auto-format (biome format --write .)
bun run test             # Run all tests (vitest)
```

Deploy (GitOps — this repo does NOT self-deploy):
merging to main publishes the bundle and D1 migrations to R2
(`worker-artifacts/afl-mcp/<sha>.js` + `<sha>-migrations.tar.gz`).
To ship: bump `afl_mcp_version` to that SHA in the cloudflare-infra repo
and run its gated `apply-prod` workflow. The pipeline applies D1 migrations
BEFORE uploading the Worker, so migrations must be backwards-compatible
with the previous Worker version (expand-contract). `wrangler deploy` by
hand is break-glass only.

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
a match exists within 1 day back / 3 days forward. PAV is recalculated from within the pipeline
whenever stats actually change. See [`docs/sync.md`](./docs/sync.md) for the
full pipeline.

## Key Files

- `src/index.ts` — Worker entry point, routing.
- `src/mcp/protocol.ts` — MCP streamable-http implementation.
- `src/mcp/tools/schema.ts` — Hardcoded schema documentation (keep in sync
  with `src/db/schema.sql`).
- `src/sandbox/executor.ts` — Dynamic Worker + `DbProxy` RPC bridge.
- `src/sync/sync.ts` — Sync orchestrator and `shouldRunNow` gate.
- `src/sync/upserts.ts` — DB writes for the match-data sync pipeline (the
  weather stage writes `match_weather` itself from `src/weather/stage.ts`).
- `src/sync/pav.ts` — PAV recalculation.
- `src/db/schema.sql` — D1 schema (13 tables).

## Style-Guide Exception

This Worker takes the style guide's **minimal-Worker exception**: no
Hono (hand-rolled routing in `src/index.ts`) and no Drizzle (raw
parameterised SQL, with the repeated upsert fragments generated from
column manifests in `src/sync/columns.ts`). Zod still validates all
HTTP boundaries (`src/mcp/validation.ts`). Revisit if routing outgrows
the current if/else chain or schema churn makes the manifests painful.

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

## Ecosystem doc

The public ecosystem doc (homepage repo: `public/docs/afl-data-ecosystem.md`,
served at jackemcpherson.com/docs/afl-data-ecosystem.md) describes this
project's public surface. If a change alters that surface — exported
functions/types, data sources or coverage, endpoints, DB schema, CLI
commands, cron behavior — update the doc in the same sitting.
