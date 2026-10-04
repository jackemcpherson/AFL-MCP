# Changelog

This file records all notable project changes.

The project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
