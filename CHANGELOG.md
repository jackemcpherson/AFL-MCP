# Changelog

This file records all notable project changes.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
