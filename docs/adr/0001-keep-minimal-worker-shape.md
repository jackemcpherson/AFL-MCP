---
status: accepted
---

# Keep the Minimal-Worker Shape Under TypeScript Standard V4

AFL-MCP keeps hand-rolled routing, raw SQL, Wrangler with GitOps, and thrown
tagged errors, while adopting the rest of v4. The shape is deliberate, and
contributors should leave it in place.

## Context

TypeScript standard v4 allows a minimal-Worker exception for small Workers.
AFL-MCP no longer meets its criteria. The Worker has 17 routes and about 200
SQL statements. Readers of the standard would expect Effect HttpApi or Hono
routing, Drizzle, Alchemy and Effect Layer composition. The current shape
works, has broad integration tests, and ships through the cloudflare-infra
GitOps pipeline.

## Decision

AFL-MCP keeps its current shape as a recorded deviation from v4:

- Hand-rolled routing in `src/index.ts`, with no router library.
- Raw parameterised SQL against D1. Column manifests in
  `src/sync/columns.ts` generate the repeated upsert fragments.
- Wrangler config, deployed by the cloudflare-infra GitOps pipeline. The
  repo does not use Alchemy.
- No Effect Layer or Service composition for dependency injection.
- Tagged errors at module boundaries. Code throws them and the Worker entry
  catches them, with no Effect runtime in request handling.

The rest of v4 still applies. The repo adopts `effect/Schema` for every
boundary decode, along with the v4 toolchain and compiler settings.

Revisit the decision when routing reaches about 20 routes, or when admin
callers need typed clients.

## Alternatives

The maintainer considered and rejected these options.

### Effect HttpApi or Hono Routing

Either gives typed routes and middleware. At 17 routes the if/else chain
stays readable, and a rewrite would touch every route test for little gain.

### Drizzle

Typed queries would replace the column manifests. The manifests already
remove the repetition, and the migration would rewrite about 200 statements
plus the D1 migration workflow.

### Alchemy

Infrastructure as TypeScript would split deploy ownership away from
cloudflare-infra, which runs every other Worker.

### Effect Layer Composition

Layers and an Effect runtime per request give typed dependency injection and
typed error channels. Request handling stays small enough that plain
functions, injected parameters and thrown tagged errors cover the same needs.

## Consequences

- Agents and contributors must not migrate to Hono, HttpApi, Drizzle,
  Alchemy or Effect Layer without a new ADR that supersedes this one.
- Lint config needs no override for thrown errors, as no v4 rule forbids
  `throw`.
- Route tests and sync tests keep exercising the Worker fetch handler
  against real D1 as the main seam.
- Each new route moves the Worker closer to the routing threshold.
- The repo defers the v4 test helper `@effect/vitest`. Every stable
  `@effect/vitest` release requires Vitest 5, and
  `@cloudflare/vitest-pool-workers` still requires Vitest 4. Adopt it once
  the pool supports Vitest 5. No test runs an
  Effect program directly, so nothing needs it yet.
