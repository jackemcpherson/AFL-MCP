# Changelog

This file records all notable project changes.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [5.0.0] - 2026-10-17

This release has breaking changes to the MCP tool contract. It also moves
the repository to TypeScript standard v4.

### Changed in 5.0.0

- Breaking: the `code` tool rejects an unknown `competition` with an
  `isError` result that lists the valid codes. It no longer runs the code
  with the hint ignored. Calls that omit `competition` or set it to
  `null` behave as before.
- The Worker logs each failure as a JSON event with the error's tag and
  source frames, and never the raw error message. A failed `sync_log` purge
  now logs a `sync_log_purge_failed` event instead of failing silently.
- `initialize` negotiates protocol revisions 2025-11-25, 2025-06-18 and
  2025-03-26. It echoes a supported requested revision and otherwise
  answers 2025-11-25.
- `/mcp` answers 400 with error `-32600` when a request other than
  `initialize` carries an unsupported `MCP-Protocol-Version` header or
  2026-07-28 request metadata. Clients that speak both eras fall back to
  `initialize`.
- `/mcp` rejects request bodies over 4 MiB with 413, counted on the bytes
  received.
- 405 responses carry an `Allow` header. Errors for a request whose id is
  unknown carry `id: null` instead of `0`.
- Both tools carry a `title` and annotations that mark them read-only,
  non-destructive, idempotent and closed-world. `initialize` returns
  server instructions to call `schema` first and always filter by
  competition.
- `schema` results and object `code` results add `structuredContent`
  next to the unchanged text block. Other `code` results stay text only.
- Breaking: `tools/call` naming an unknown tool returns JSON-RPC error
  `-32602` instead of an `isError` result.
- `schema` argument errors now name the failing key, for example
  `Expected boolean at "includeObserved"` or
  `Expected no excess property at "table"`. Contract errors such as a
  missing `season` keep their existing text.
- `tools/call` without a string tool `name` returns `-32602` with
  `Missing tool name`.

### Internal Changes in 5.0.0

- `effect/Schema` replaces Zod for every boundary decode: MCP and admin
  request bodies, Open-Meteo payloads, D1 rows and stored JSON.
- Vite+ (`vp`) replaces Biome. `oxfmt` formats, `oxlint` lints with type
  information, and Vitest runs the tests. `bun run check` also runs `tsc`
  on each tsconfig.
- Separate tsconfig projects cover Worker source, tests and Node scripts.
  New compiler flags: `noImplicitOverride`, `verbatimModuleSyntax`,
  `noPropertyAccessFromIndexSignature` and `isolatedDeclarations`.
- Golden contract tests pin the MCP wire format under
  `test/fixtures/golden/mcp/`. CI fails when a golden file is missing.
- Tests mirror the `src/` layout. Tests that need the Workers pool end in
  `.worker.test.ts`, and no test mocks a module.
- ADR 0001 and ADR 0002 record the deliberate deviations from the
  standard: the minimal-Worker shape and the hand-rolled MCP protocol.
- The repository waits to adopt `@effect/vitest` until
  `@cloudflare/vitest-pool-workers` supports Vitest 5.

## [4.0.11] - 2026-10-17

This patch tightens MCP request media-type validation.

### Changed in 4.0.11

- `/mcp` accepts a POST body only when its media type is exactly
  `application/json`. Parameters such as `charset` are still accepted.
- `/mcp` logs each request's `Origin` and protocol version as a structured
  `mcp:client` event.

## [4.0.10] - 2026-10-14

This patch moves the sync pipeline to fitzroy 7. Synced data does not change.

### Changed in 4.0.10

- Upgrade fitzroy from 6.0.0 to 7.0.0 and add its `effect` peer dependency.
  fitzroy 7 returns Effects. `src/lib/fitzroy.ts` runs them on one runtime per
  isolate, so the AFL API token stays cached across requests as before.
- Port the backfill scripts to fitzroy 7. `backfill-dob.mts` uses the
  `Fryzigg` and `AflTables` services in place of the removed client classes.

### Fixed in 4.0.10

- `backfill-brownlow.ts` and `diagnose-brownlow-gaps.ts` read
  `fetchPlayerStats` results as the `{ stats, failedMatchIds }` envelope
  instead of iterating the envelope itself.

## [4.0.9] - 2026-10-05

This patch retries safe fenced reads after transient connection loss.

### Fixed

- Retry fenced SELECT reads twice after transient D1 connection loss, with
  bounded delays and jitter. Every attempt rechecks operation ownership.
- Keep mutation calls and shared batches to one attempt. Exhausted reads and lost
  leases retain the public write marker for explicit operator recovery.

## [4.0.8] - 2026-10-04

Preserve distinct weather samples when local clocks repeat.

### Fixed in 4.0.8

- Request UTC epoch timestamps from Open-Meteo and aggregate exact elapsed-hour
  samples across daylight saving changes. Legacy local-time captures retain
  their conservative unknown values for ambiguous repeated hours.
- Preserve existing daily retry deadlines so partial windows recover through
  their scheduled retry rather than an invented observation time.

## [4.0.7] - 2026-10-04

Keep historical backfills under explicit operator control.

### Fixed in 4.0.7

- Separate scheduled statistics checkpoints from historical operator work.
  Recent fixtures retain their full day-30 schedule and failure retries.
  Historical checkpoints require exact-season or approved operation requests
  and cannot consume the hourly refresh budget.

## [4.0.6] - 2026-10-04

Restore the verified season-seven lineup backfill.

### Fixed in 4.0.6

- Ingest AFLW season-seven rosters when their complete player-team selections
  agree with recorded appearances. Preserve historical announced-team guards
  for other pre-2023 seasons and reject unmatched selections.

## [4.0.5] - 2026-10-04

Correct lineup flags and expose unknown retirement status honestly. Support
reviewed weather refresh after fixture corrections.

### Fixed in 4.0.5

- Correct interchange rows marked as dedicated substitutes. Retain genuine
  `SUB` flags. Preserve imported retirement bits as `legacy_is_retired` and
  leave `is_retired` unknown until source evidence establishes the status.
- Recompute weather for one reviewed fixture with a digest-bound checkpoint,
  exact-scope recovery and idempotent reruns. Source failures retain unknown
  values and real daily retry schedules.
- Invalidate cached weather when kickoff or canonical venue context changes.
- Remove stale quarter-score and Brownlow year limits from coverage metadata.
  Player metadata has partial coverage rather than a completeness guarantee.

## [4.0.4] - 2026-10-04

Split verified people whose appearances share an existing identity.

### Added in 4.0.4

- Allow scoped appearance reassignment to an unused explicit target with a
  reviewed `newPerson` biography and source evidence. Create the person and
  reassign references in one fenced transaction. A failure rolls back creation
  and retains the exact operation marker for recovery.

## [4.0.3] - 2026-10-04

Separate fixture corrections from player ingestion and support scoped identity
repairs with an explicit retained target.

### Added in 4.0.3

- Accept `fixturesOnly: true` for exact-season backfills. Refresh fixture
  metadata without fetching statistics, lineups or weather. Rebuild affected
  PAV and bind recovery to the same refresh mode.
- Accept `canonicalId` for exact appearance reassignments between separate
  people. Retain both historical identities and bind the target to the repair
  digest. Whole-person merges still retain the lowest ID.

## [4.0.2] - 2026-10-04

Complete historical coaching imports within the database request budget.

### Fixed in 4.0.2

- Read season reconciliation inputs together and batch coaching observations,
  assignments and provider links. Retain the interrupted operation marker and
  source checkpoint for explicit recovery after a failed import.

## [4.0.1] - 2026-10-04

Enable explicit season keys after deploying compatible consumers.

### Changed in 4.0.1

- Activate migration `0040` after deploying compatible consumers. Preserve
  existing season IDs and pending derived work while allowing both AFLW 2022
  seasons and rejecting ambiguous season keys.

## [4.0.0] - 2026-10-04

Version 4 distinguishes competition seasons and adds reviewed repair operations.
The expansion deployment retains calendar-year uniqueness until compatible
consumers permit the separate season-key schema transition.

### Changed in 4.0.0

- AFLW 2022 requests require `2022-S6` or `2022-S7`. Ordinary years remain
  valid.
  Coverage contract v4 exposes canonical selectors and ambiguity errors.
- Statistics refresh per match with persisted retries and exact scopes that
  resume after interruption.
  Partial responses preserve known values and each pass fetches at most 20
  matches.
- Verified player repairs require reviewed digests and recorded source evidence.
  Exact-match reassignment keeps separate people and their histories distinct.
- Shared leases and public write markers fence all repair batches. Interrupted
  operations require explicit recovery and stale owners cannot finish a write.
- PAV replacement removes obsolete combinations atomically. Required missing
  inputs remain unknown, and cancelled or live matches do not contribute.
- Weather retries incomplete observations, respects unknown kickoff times and
  measures elapsed windows across Melbourne daylight-saving changes.
- Coverage includes source-backed field support, inventory denominators and
  unresolved refresh diagnostics. An hourly audit identifies specific records.
- Windsor Park uses verified council coordinates. Historical Bears
  reconciliation
  requires a reviewed preview before coaching imports.
- Fitzroy 6 replaces the prior library dependency. The unbounded PAV endpoint
  returns HTTP 410 and the obsolete `skipPav` backfill flag fails validation.

Read [the remediation guide](docs/remediation.md) for deployment order, exact
request scopes, recovery procedures and the staged schema transition.

## Earlier Releases

Read the [archived release notes](archive/changelog-pre-v4.md) for versions
before 4.0.0.
