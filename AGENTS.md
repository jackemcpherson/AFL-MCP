# AFL-MCP Development Guide

## Architecture (TL;DR)

AFL-MCP is a Cloudflare Worker serving an MCP server with 2 Code Mode tools
(`schema`, `code`). The `code` tool runs LLM-written JavaScript in
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
bun run check:schema     # Compare migrated and consolidated schemas
bun run check            # vp check (Oxfmt, Oxlint, tsgo) + bun run typecheck
bun run typecheck        # tsc -p on tsconfig.app/test/node.json (isolatedDeclarations)
bun run format           # Auto-format and apply lint fixes (vp check --fix)
bun run test             # Run all tests once (vp test --run)
bunx wrangler deploy --dry-run  # Build the bundle and report its size
```

Deploy (GitOps — this repo does NOT self-deploy):
merging to main publishes the bundle and D1 migrations to R2
(`worker-artifacts/afl-mcp/<sha>.js` + `<sha>-migrations.tar.gz`).
To ship: dispatch `promote-worker.yml` in cloudflare-infra with that SHA,
review and merge the release descriptor PR, then dispatch `apply-prod` for
`targets/afl-mcp`. The pipeline applies D1 migrations
BEFORE uploading the Worker, so migrations must be backwards-compatible
with the previous Worker version (expand-contract). `wrangler deploy` by
hand is break-glass only.

CI (`ci.yml`) runs once per PR head, not on branch pushes. The main
ruleset requires its `check` job with an up-to-date branch. On merge,
`deploy.yml` calls `ci.yml`, which bundles the Worker once and hands that
bundle to the publish job, so R2 gets the bytes CI checked. `release.yml`
re-runs `ci.yml` on the tagged SHA because a main commit outside
`deploy.yml`'s paths has no check run. CI needs Node 24 for `vp` (unit
tests differ under Bun's node shim) and Bun for install and scripts.

## AFL Season Structure (footgun)

Never filter or group match data by round name or `round_number` alone — use
date-based or total match-count comparisons. The season includes special
rounds outside standard numeric ordering:

- **Opening Round** before Round 1 (4-5 games, AFLM 2024+), stored as
  `round = 'Opening Round'`, `round_abbreviation = 'OR'`, `round_number = 0`.
  The 2026 Opening Round had 5 games.
- Numbered rounds: `round = 'Round N'`, `round_abbreviation = 'Rd N'`.
  Exception: AFLW 2024 stores its home-and-away rounds as
  `round = 'Week N'` (`Week 1` to `Week 10`), with `round_abbreviation =
  'Rd N'`, `round_number` 1 to 10 and `round_type = 'Regular'`.
- VFL `Wildcard` (`WC`) before finals is a Regular round. From 2026 the
  finals open with `Wildcard Finals` instead.
- Finals: `round` names vary by competition and era, for example
  `Qualifying Final`, `Elimination Final`, `Finals Week 1`, `Semi Finals`,
  `Preliminary Finals`, `Grand Final`, and from 2026 `Wildcard Finals` and
  `Qualifying & Elimination Finals`. `round_abbreviation` maps known names to
  `QF`, `EF`, `FW1`, `SF`, `PF` and `GF`, and other names become
  `F<round_number>`. Select finals with `round_type = 'Finals'` (the other
  value is `'Regular'`). The `schema` tool's rounds note holds the full rule.

Labels change by competition and season, so a round-name filter silently
misses whole seasons. Filter by date or match count instead. This rule
applies to freshness checks, ETL logic, and any match query.

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
- `src/sandbox/executor.ts` — Dynamic Worker loader and result handling.
- `src/sandbox/db-proxy.ts` — `DbProxy` read-only RPC bridge (re-exported
  from `src/index.ts`).
- `src/sync/sync.ts` — Sync orchestrator and `shouldRunNow` gate.
- `src/sync/upserts.ts` — DB writes for the match-data sync pipeline (the
  weather stage writes `match_weather` itself from `src/weather/stage.ts`).
- `src/sync/pav.ts` — PAV recalculation.
- `src/db/schema.sql` — D1 schema and reference seeds.

## Style-Guide Exception

This Worker deliberately deviates from TypeScript standard v4. Do not
"fix" these without a superseding ADR.

- [ADR 0001](./docs/adr/0001-keep-minimal-worker-shape.md): keep the
  minimal-Worker shape. Hand-rolled routing in `src/index.ts`, raw
  parameterised SQL with upsert fragments generated from column manifests
  in `src/sync/columns.ts`, Wrangler config deployed by the
  cloudflare-infra GitOps pipeline (no Alchemy), no Effect Layer
  composition, and tagged errors thrown and caught at the Worker entry.
  `effect/Schema` and the v4 toolchain still apply. Revisit routing at
  about 20 routes or when admin needs typed clients.
- [ADR 0002](./docs/adr/0002-keep-hand-rolled-mcp-protocol.md): keep the
  hand-rolled MCP protocol in `src/mcp/protocol.ts`. Adopt
  `@modelcontextprotocol/server` when logs show clients requesting
  protocol 2026-07-28, or when a second transport feature (streaming,
  resources) is needed.

`effect/Schema` decodes every external input: MCP request bodies
(`src/mcp/validation.ts`), admin request bodies (each `src/admin/*`
module), Open-Meteo payloads and stored JSON columns. Some admin
operations also decode the D1 rows they read. Other D1 reads, including
the rest of admin, health, coverage and sync, may use a typed
`.first<T>()` or `.all<T>()`. Shared field
schemas live in `src/lib/schemas.ts`, decoders in `src/lib/decode.ts`,
and competition codes in `src/lib/competitions.ts`.

## Key Constraints

- **Strict TypeScript** — `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`,
  `verbatimModuleSyntax`, `noPropertyAccessFromIndexSignature` and
  `isolatedDeclarations` are all enabled. `vp check` misses
  `isolatedDeclarations` errors, so run `bun run check`, not bare `vp check`.
- **No `any`** — Oxlint enforces `typescript/no-explicit-any`. Use `unknown` and narrow.
- **No `enum`** — use union types instead.
- **No default exports** — Oxlint enforces `import/no-default-export`, with overrides
  only for `*.config.ts`, `*.config.mts` and `src/index.ts`.
- **Bun** as package manager, **Vite+** (`vp`: Oxlint, Oxfmt, tsgo, Vitest) for
  checks and tests. Lint and format config lives in `vite.config.ts`.
- Use Web Standard APIs only (no Bun-specific) — code runs on Cloudflare Workers V8.
- **`Id` casing** — identifiers write `Id`, not the standard's `ID`
  (`matchId`, `canonicalId`, `playerIds`). This deviation is deliberate,
  because the names match the admin JSON keys and D1 columns. Do not
  rename them.
- **Tests** mirror `src/` under `test/`. Tests that need `cloudflare:test`
  end in `.worker.test.ts`. Import support code as `#test/<name>`. No
  `vi.mock` (Oxlint `no-module-mocking`); inject collaborators through
  `McpDeps` in `src/mcp/protocol.ts` instead.
- **Golden MCP contract** — `test/fixtures/golden/mcp/*.json` pin every
  MCP response. Update them (`vp test --run -u`) only for a deliberate
  wire-contract change, and review the diff. CI fails on a missing golden.

## Toolchain Pins

`vite-plus` is on 1.x for its security fixes, but tests stay on Vitest 4.1.
vite-plus 1.x bundles Vitest 5, and `@cloudflare/vitest-pool-workers` (0.23)
requires Vitest ^4.1: the Workers test project fails to boot on Vitest 5. The
`overrides` in `package.json` force `vitest` and every `@vitest/*` package that
vite-plus pulls in (`expect`, `mocker`, `pretty-format`, `runner`, `snapshot`,
`spy`, `utils`) to the same 4.1 version. Overriding only `vitest` is not enough:
vite-plus's direct `@vitest/utils` 5 dependency gets hoisted, and the pool then
fails with `'@vitest/utils/display' does not provide an export named
'objDisplay'`. Keep all of them, and the `vitest` devDependency, on one version.

Upgrade trigger: `@cloudflare/vitest-pool-workers` supports Vitest 5. Then:

1. Remove the `vitest` and `@vitest/*` overrides and the `vitest`
   devDependency, so tests run on vite-plus's bundled Vitest. Keep the `vite`
   override and `@oxlint/plugins` (imported by the vendored plugin in
   `tools/oxlint/`) in step with vite-plus.
2. Add `@effect/vitest` matching the `effect` version. It is deferred
   until then because every stable 4.x release peers on Vitest 5.

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
