# Match context and data coverage design

Status: accepted design

Evidence date: 2026-07-12

Baseline: `e39598c`
Installed upstream: `fitzroy@3.4.0`

This document defines two additive changes to AFL-MCP:

1. persist the smallest authoritative live-match state supplied by fitzroy; and
2. replace prose-only coverage exceptions with typed expectations plus an
   optional, bounded observation in the existing `schema` tool.

It is an implementation specification, not an implementation. No production
schema, Worker code, migration, or D1 data changed during this spike.

## Product invariants

- `matches.local_time` remains Melbourne local time (`Australia/Melbourne`,
  AEST/AEDT) for every competition. This matches the AFL API ecosystem's
  canonical convention and the existing `src/lib/time.ts` implementation.
- Do not persist or expose venue-native date/time or timezone fields.
  `Match.venueLocalDate` and `Match.venueTimezone` remain intentionally
  discarded.
- Every match or statistics query must filter through `seasons` and
  `competitions`; round labels or `round_number` alone never define a season
  slice.
- The MCP surface remains three tools: `schema`, `tools`, and `code`.
- D1 migrations remain expand-contract because migrations deploy before the
  new Worker bundle.

## Evidence

### Upstream shape

The installed fitzroy declarations and AFL API transform establish:

- `Match.completedQuarter` is `0 | 1 | 2 | 3 | 4 | null`.
- It is derived from the highest `matchClockPeriods[].periodNumber` whose
  `periodCompleted` is true, capped at four.
- `0` means no quarter has completed; `4` means full time; `null` means the
  match clock is unavailable.
- `Match.matchClockPeriods` carries per-period seconds, completion, start, and
  next-start data. No current AFL-MCP query needs that full event-like shape.
- `Match.livePeriodStatus` is raw upstream text. Fitzroy documents it as
  unreliable for 2026 break detection because it can stay `LIVE` through
  breaks. It remains useful as raw source evidence and must not be removed.

`MATCH_COLUMNS` currently persists `status` and `live_period_status`, but not
`completedQuarter` or `matchClockPeriods`. Integration fixtures already model
both discarded fields.

### Bounded live probe

`/tmp/match-context-probe.ts` fetched the complete 2026 AFLM and VFL fixture
sets from fitzroy's `afl-api` adapter. It emitted aggregates only; it did not
emit match objects or write D1.

| Competition/status | Matches | Non-null raw status | Completed-quarter distribution | Clock-period lengths | Contradictions |
|---|---:|---:|---|---|---:|
| AFLM Complete | 150 | 150 | `4: 150` | `4: 150` | 0 |
| AFLM Live | 2 | 2 | `0: 1, 3: 1` | `1: 1, 4: 1` | 0 |
| AFLM Upcoming | 55 | 0 | `null: 55` | `0: 55` | 0 |
| VFL Complete | 148 | 148 | `4: 148` | `4: 148` | 0 |
| VFL Live | 3 | 3 | `2: 2, 3: 1` | `3: 2, 4: 1` | 0 |
| VFL Upcoming | 47 | 0 | `null: 47` | `0: 47` | 0 |

Contradictions checked these invariants: derived completed-period count equals
`completedQuarter`, complete matches with a value have `4`, and upcoming
matches with a value have `0`. The live rows prove the field supplies useful
state between bounce and full time. Absence of an AFLW match on this probe is
not interpreted as a coverage statement.

### Remote coverage sample

A read-only production D1 sample measured the 2026 competition-season rows on
2026-07-12. The first join-shaped query read 1,236,634 rows, showing why the
schema tool must not perform a broad join. Rewriting it as four season-ID
queries using:

```sql
WHERE match_id IN (SELECT id FROM matches WHERE season_id = ?)
```

used existing `idx_matches_season_id` and `idx_pms_match_id`, returned the same
counts, read 17,435 rows, took 9.1 ms of D1 SQL time, and wrote zero rows.

| Competition | Stat rows | Goal assists | Marks inside 50 | One-percenters | Brownlow | Fantasy |
|---|---:|---:|---:|---:|---:|---:|
| AFLM | 6,900 | 6,900 | 6,900 | 6,900 | 0 | 6,900 |
| AFLW | 0 | 0 | 0 | 0 | 0 | 0 |
| VFL | 6,797 | 0 | 0 | 0 | 0 | 6,797 |
| VFLW | 2,178 | 42 | 42 | 42 | 0 | 2,178 |

These are measured observations, not timeless promises. In particular, the 42
VFLW non-null rows disprove the current absolute prose claim that these three
fields are null for **all** VFLW rows. The expectation must say
`best-effort`/usually absent for VFLW, while the observation reports what is
currently present. AFLW has a 2026 season row but no player-stat rows yet, so
zero rows means `not_observed`, not `absent`.

Three further season-ID aggregate probes covered the other representative
datasets required by the contract. All wrote zero rows.

| Competition | 2026 matches | Weather temperature | Weather type | PAV rows | Lineup rows | Matches with lineups |
|---|---:|---:|---:|---:|---:|---:|
| AFLM | 207 | 0 | 0 | 643 | 7,969 | 153 |
| AFLW | 108 | 0 | 0 | 0 | 0 | 0 |
| VFL | 198 | 0 | 0 | 0 | 7,186 | 151 |
| VFLW | 91 | 0 | 0 | 0 | 2,239 | 52 |

Weather read 607 rows in 0.5 ms D1 SQL time; PAV read 644 rows in 0.9 ms;
lineups read 18,960 rows in 3.1 ms. Current-season weather absence agrees with
the documented fryzigg historical range, but it does not validate historical
completeness. AFLW's zero PAV and lineup counts mean “not observed yet” because
the season has not begun; VFL/VFLW zero PAV agrees with the product's derived
eligibility rule. Current AFLM, VFL, and VFLW lineup counts demonstrate why
lineup coverage needs match-level presence counts rather than a Boolean.

## Decision 1: persist `completed_quarter` only

Choose option 1: one nullable scalar column. Reject a transition timestamp
because current source data does not provide a stable transition event and the
five-minute sync cannot promise second-level timing. Reject a normalized
period child table because no proved public query needs seconds or period start
timestamps; it would add a table, write amplification, retention semantics,
and a larger schema payload.

### Database contract

Add to `matches`:

```sql
completed_quarter INTEGER CHECK (
  completed_quarter IS NULL OR completed_quarter BETWEEN 0 AND 4
)
```

Meanings:

- `NULL`: match clock absent or row predates an AFL API refresh;
- `0`: match clock exists, but no quarter has completed;
- `1` through `3`: highest fully completed quarter; and
- `4`: fourth quarter completed/full-time clock state.

Do not infer lifecycle solely from this column. Consumers must pair it with
`status`; postponed, cancelled, historical, and not-yet-refreshed rows can be
null. Retain `live_period_status` unchanged as opaque raw source data.

| `status` | Expected `completed_quarter` behavior |
|---|---|
| `Upcoming` | Normally null because no score wrapper exists; 0 is valid if upstream has created a clock before play |
| `Live` | 0-3 during regulation play; 4 can appear during the short interval before lifecycle status becomes complete |
| `Complete` | 4 when match-clock data exists; null remains valid for historical/non-AFL API rows |
| `Postponed` | Null unless a started match was postponed, in which case the last non-null completed quarter is retained |
| `Cancelled` | Null unless a started match was cancelled, in which case the last non-null completed quarter is retained |
| null historical status | Null; do not synthesize lifecycle or quarter state |

### Upsert lifecycle

Add this manifest entry after `live_period_status`:

```ts
{
  name: "completed_quarter",
  kind: "coalesce",
  value: (row) => row.m.completedQuarter,
}
```

`coalesce` is deliberate. Non-null values advance from 0 through 4, while a
transient upstream loss of `matchClock` cannot erase the last authoritative
quarter. New upcoming rows remain null because fitzroy returns null when the
score wrapper is absent. This field must participate in the generated INSERT,
UPDATE, change-detection, and bind lists through `MATCH_COLUMNS`; do not add
hand-written SQL fragments.

If production evidence shows a completed quarter can legitimately decrease
for a corrected match, stop implementation and return for a lifecycle decision.
Do not silently switch to `replace` or implement `MAX(existing, excluded)`.

### Historical coverage

- AFL API-refreshed rows receive a value on their next sync.
- Current complete matches should become `4`; live matches become 0-3;
  upcoming matches normally remain null.
- Historical rows from fryzigg or AFL Tables remain null until an AFL API
  source supplies a match clock. No full-history synthetic backfill is needed.
- Existing `status` and `live_period_status` rows remain untouched.

### Migration and deployment

1. Add `completed_quarter` to `src/db/schema.sql`.
2. Add the next available migration, named
   `src/db/migrations/00NN_completed_quarter.sql`, containing only the additive
   `ALTER TABLE`. Resolve `00NN` at implementation time because parallel work
   may claim the next number.
3. Add the manifest mapping and tests.
4. Update schema/docs and the public ecosystem document.
5. Merge. GitOps applies the migration before uploading the new Worker.

The previous Worker ignores the extra column, so forward deployment and a
temporary Worker rollback are safe. Never deploy this manually except under
the repository's break-glass policy.

## Coverage inventory

Coverage claims currently exist in `competitions.*.coverage`, `notes`, and
`column_coverage`. Every declaration is audited below. `Primary class`
controls how its expectation is maintained; supporting classes explain what
can change it.

### Competition coverage block

All 16 leaves in `database.competitions.*.coverage` are listed explicitly.

| Competition/leaf | Current declaration | Primary class | Supporting class | Provenance/correction |
|---|---|---|---|---|
| `AFLM.matches` | `true` | source/version bound | operational freshness | AFL API current plus historical sources from 1990 |
| `AFLM.stats` | `true` | source/version bound | empirical completeness | source mix changes by season and column; Boolean is too broad |
| `AFLM.lineups` | `2015+` | source/version bound | operational freshness, empirical completeness | AFL API with documented round gaps |
| `AFLM.pav` | `1998+` | static derived eligibility | operational freshness | formula floor plus recalculation cadence |
| `AFLW.matches` | `true` | source/version bound | operational freshness | AFL API from 2017 |
| `AFLW.stats` | `true` | source/version bound | empirical completeness | AFL API from 2017; column-specific completeness varies |
| `AFLW.lineups` | `2017+` | source/version bound | operational freshness, empirical completeness | AFL API; zero current rows before season start is not absence |
| `AFLW.pav` | `2017+` | static derived eligibility | operational freshness | formula supported from inaugural season |
| `VFL.matches` | `true` | source/version bound | operational freshness | AFL API from 2021 |
| `VFL.stats` | `true` | source/version bound | empirical completeness | AFL API from 2021; several advanced fields absent |
| `VFL.lineups` | `best-effort` | source/version bound | operational freshness, empirical completeness | AFL API may return empty rounds; 2026 observation has 7,186 rows over 151 matches |
| `VFL.pav` | `false` | static derived eligibility | empirical validation | product excludes competition because formula inputs are insufficient |
| `VFLW.matches` | `true` | source/version bound | operational freshness | AFL API from 2021 |
| `VFLW.stats` | `true` | source/version bound | empirical completeness | Boolean hides sparse advanced fields, including measured 2026 exceptions |
| `VFLW.lineups` | `best-effort` | source/version bound | operational freshness, empirical completeness | 2026 observation has 2,239 rows over 52 matches |
| `VFLW.pav` | `false` | static derived eligibility | empirical validation | product excludes competition; do not justify with an absolute-null claim |

### Column coverage block

Each of the 17 existing `column_coverage.columns` entries is listed explicitly.

| Declaration | Primary class | Supporting class | Required correction or provenance |
|---|---|---|---|
| `matches.attendance` | source/version bound | empirical completeness | fryzigg/AFLM 1990-2019; measured null rate validates completeness |
| `matches.weather_temp_c` | source/version bound | empirical completeness | fryzigg/AFLM 2010-2025 |
| `matches.weather_type` | source/version bound | empirical completeness | same range/source as temperature |
| quarter-score group | source/version bound | empirical completeness | AFLM 2020+ expectation; other competitions best-effort |
| `brownlow_votes` | source/version bound | operational freshness, empirical completeness | AFLM award only; publication lag makes current season absent; known partial matches belong in notes |
| `supercoach_score` | source/version bound | empirical completeness | fryzigg/AFLM 2007-2019 |
| `afl_fantasy_score` | source/version bound | empirical completeness | AFLM 2007+; observed coverage required elsewhere |
| `subbed` | source/version bound | empirical completeness | fryzigg/AFLM 1990-2019 |
| `disposal_efficiency_pct` | source/version bound | empirical completeness | per-competition start seasons |
| `score_involvements` | source/version bound | empirical completeness | AFLM/AFLW expected; VFL/VFLW best-effort |
| `metres_gained` | source/version bound | empirical completeness | AFLM/AFLW expected; VFL/VFLW measured rather than absolute |
| `intercepts` | source/version bound | empirical completeness | AFLM/AFLW expected; VFL/VFLW best-effort |
| `pressure_acts` | source/version bound | empirical completeness | AFLM/AFLW expected; VFL/VFLW measured rather than absolute |
| `goal_assists` | static capability | empirical completeness | AFLM/AFLW expected; VFL absent; VFLW best-effort after measured counterexample |
| `marks_inside_fifty` | static capability | empirical completeness | AFLM/AFLW expected; VFL absent; VFLW best-effort after measured counterexample |
| `one_percenters` | static capability | empirical completeness | AFLM/AFLW expected; VFL absent; VFLW best-effort after measured counterexample |
| `player_season_pav.*` | static derived eligibility | operational freshness | AFLM 1998+, AFLW 2017+; unsupported for VFL/VFLW |

### Notes-array audit

Indices are zero-based positions in `database.notes` at baseline `e39598c`.
Every note is listed, including notes judged not to declare coverage, so future
review can detect additions or reordering.

| Note | Stable label | Classification | Source/provenance and disposition |
|---:|---|---|---|
| 0 | mandatory competition filter | not a coverage claim | query-safety guidance; keep outside manifest |
| 1 | available competitions and start seasons | source/version bound | duplicates competition years/coverage; generate from manifest |
| 2 | PAV competition/year availability | static derived eligibility + empirical validation | generate eligibility; remove absolute VFLW-input-null justification |
| 3 | two round-string columns | not a coverage claim | schema semantics |
| 4 | long round labels, Opening Round, Wildcard | source/version bound | AFL API competition/season capability; manifest note metadata |
| 5 | round abbreviations stable across competitions | static capability | upstream/domain contract; retain as schema semantics with reviewed-as-of metadata |
| 6 | round-number ordinals and examples | not a coverage claim | query semantics |
| 7 | round-type values | not a coverage claim | schema semantics |
| 8 | pre-v3.0 legacy finals labels awaiting rewrite | source/version bound + operational freshness | migration/backfill state; keep operational note, not column completeness |
| 9 | duplicate round-type guidance | not a coverage claim | schema semantics; candidate deduplication |
| 10 | Opening Round AFLM 2024+ | source/version bound | competition/season capability; generate from round metadata if retained |
| 11 | AFLM finals labels rewritten by v3.0.0 | source/version bound | completed source migration; historical-format provenance |
| 12 | players have no team ID | not a coverage claim | identity/join semantics |
| 13 | PAV component rounding difference | empirical completeness | measured 12-15% behavior; label observation with `as_of` |
| 14 | PAV zone meanings | not a coverage claim | metric semantics |
| 15 | PAV interpretation thresholds | not a coverage claim | analysis guidance |
| 16 | PAV join absence by competition/year | static derived eligibility | duplicates PAV expectation; generate from manifest |
| 17 | match date format | not a coverage claim | format semantics |
| 18 | signed margin | not a coverage claim | value semantics |
| 19 | team abbreviations may be null outside AFLM | static capability + empirical completeness | add typed per-competition expectation for `teams.abbreviation` |
| 20 | source mix by competition and era | source/version bound | canonical provenance feeding all source-bound expectations |
| 21 | external AFL player ID on AFL API rows | source/version bound | add source-conditioned expectation for `players.external_afl_player_id` |
| 22 | negative metres gained and observed minimum | empirical completeness | value-domain observation, not null coverage; carry `as_of` separately |
| 23 | Brownlow range, gaps, current absence | source/version bound + empirical completeness + operational freshness | generate range; retain known-gap/current-publication notes |
| 24 | SuperCoach range | source/version bound + empirical completeness | duplicates column coverage; generate |
| 25 | AFL Fantasy range and sparsity | source/version bound + empirical completeness | duplicates column coverage; generate |
| 26 | subbed range and values | source/version bound | range generated; value enumeration remains schema semantics |
| 27 | weather range | source/version bound + empirical completeness | duplicates two column expectations; generate |
| 28 | Melbourne local time across all competitions/seasons | static capability + empirical completeness | product invariant; typed all-range expectation, never venue-native |
| 29 | fryzigg ID approximately 99% populated | empirical completeness | measured AFLM historical observation; add `as_of` and denominator |
| 30 | attendance range | source/version bound + empirical completeness | duplicates column coverage; generate |
| 31 | quarter-score ranges by competition | source/version bound + empirical completeness | expand grouped alias to eight columns; generate |
| 32 | match lifecycle availability since 2026-06 | source/version bound + operational freshness | typed source/start expectation for `matches.status` |
| 33 | raw live-period availability and observed values | source/version bound + operational freshness | typed expectation for source/null lifecycle; raw values stay schema semantics |
| 34 | lineup source/derivation by competition | source/version bound + operational freshness + empirical completeness | canonical lineup provenance; generate expectation summary |
| 35 | emergency flag AFLM 2024+ | source/version bound | typed expectation for `match_lineups.is_emergency` |
| 36 | substitute flag meaning | not a coverage claim | value semantics |
| 37 | lineup start seasons and known AFLM gaps | source/version bound + empirical completeness | generate ranges; preserve explicit gap notes |
| 38 | lineup position codes and EMERG 2024+ | source/version bound | code list is semantics; EMERG availability derives from emergency expectation |
| 39 | cross-source player unification exceptions | empirical completeness | identity-quality observation; add `as_of`, no row provenance claim |
| 40 | integrity-view meaning | not a coverage claim | operational query semantics |
| 41 | season-complete flag lifecycle | operational freshness | typed operational-state semantics, not historical field completeness |

Definitions:

- **static capability**: competition or domain semantics determine whether a
  field can exist;
- **source/version bound**: an adapter/source and season range determine the
  expectation;
- **empirical completeness**: non-null counts validate but do not define the
  source contract; and
- **operational freshness**: current availability changes as sync or award
  publication proceeds.

The implementation must migrate duplicate prose notes to generated summaries
from one manifest. A summary may remain for humans, but it cannot become a
second source of exact ranges.

## Decision 2: typed expectations plus bounded observations

### Options considered

| Option | Source of truth | D1/read cost | Drift risk | Operator value | Decision |
|---|---|---:|---|---|---|
| Typed static manifest embedded in `schema` | TypeScript manifest | none | low for expectations, cannot show live completeness | medium | necessary but insufficient alone |
| Fourth `coverage` MCP tool with static and observed data | manifest plus queries | bounded if designed correctly | medium; duplicates tool registration and compatibility surface | high | reject; no material capability beyond optional schema arguments |
| Persisted coverage table refreshed by sync | D1 table | cheap reads, recurring writes/scans | high; freshness and failed-refresh semantics become operational state | high | reject until observation traffic proves need |
| Typed manifest plus opt-in bounded observation in `schema` | TypeScript manifest plus indexed D1 aggregates | zero by default; one competition-season when requested | low | high | choose |

The default no-argument `schema` call stays deterministic and read-free. It
returns typed expectations materialized for all analytics columns. An explicit
observation request measures exactly one competition and one season, overlays
counts on those expectations, and caches the result briefly. This preserves
three tools and makes cost visible to the caller.

### Canonical files and types

Create `src/mcp/tools/coverage.ts` as the sole exact source of coverage
expectations. It exports:

```ts
export const COVERAGE_EXPECTATIONS = { /* typed manifest */ } as const;
export type CoverageExpectation =
  | "complete"
  | "partial"
  | "best-effort"
  | "absent"
  | "not-applicable";
```

Each analytics table has a typed default per competition plus explicit column
overrides. The response materializer expands defaults so every public
analytics column appears. Absence from JSON never means “fully covered.”
Operational/internal tables remain excluded using the same policy as
`schema-doc-drift.test.ts`.

`src/mcp/tools/schema.ts` imports the manifest and generates both the structured
coverage block and any short human notes from it. `docs/schema.md` summarizes
the contract and points to the MCP response; it must not duplicate every range.

### Input contract

Extend the existing `schema` tool input schema additively:

```json
{
  "includeObserved": false,
  "competition": "AFLM",
  "season": 2026
}
```

Rules:

- all properties remain optional for backward compatibility;
- default `includeObserved` is false;
- when `includeObserved` is true, both `competition` and `season` are required;
- `competition` is one of AFLM, AFLW, VFL, VFLW;
- `season` is an integer within the documented competition range and no later
  than the current Melbourne calendar year plus one; and
- reject extra properties and invalid combinations before querying D1.

Use a Zod schema in `src/mcp/validation.ts`, consistent with repository HTTP
boundary validation. Change `getSchemaInfo` to accept validated options and an
optional `Env`; make the tool-call branch await it. A default call must not
need `Env` and must preserve all existing top-level fields.

### Exact response contract

Add `database.coverage_contract` with `version: 1`. Data is keyed in this
order: competition, table, column, then season/range. Every leaf has the same
shape:

```json
{
  "database": {
    "coverage_contract": {
      "version": 1,
      "by_competition": {
        "AFLM": {
          "player_match_stats": {
            "goal_assists": {
              "1990..current": {
                "expected": "complete",
                "observed": null,
                "source": ["afl-api", "fryzigg"],
                "as_of": "2026-07-12",
                "notes": []
              },
              "2026": {
                "expected": "complete",
                "observed": {
                  "unit": "rows",
                  "rows": 6900,
                  "non_null": 6900,
                  "null": 0,
                  "ratio": 1
                },
                "source": ["afl-api"],
                "as_of": "2026-07-12T05:45:00.000Z",
                "notes": ["Measured observation; not a historical guarantee."]
              }
            }
          }
        }
      }
    }
  }
}
```

Static range keys use `YYYY..YYYY`, `YYYY..current`, or `all`. An observed key
is the requested four-digit season. `source` is a non-empty array of canonical
adapter/derived-source names. Static `as_of` is the manifest review date;
observed `as_of` is the measurement timestamp. `notes` is always an array.

Observed semantics:

- scalar columns, including weather, use `observed: { "unit": "rows",
  "rows": N, "non_null": N, "null": N, "ratio": number | null }`;
- table-presence entries use the virtual `*` column. `player_season_pav.*`
  uses `{ "unit": "table_rows", "rows": N }`; `match_lineups.*` uses
  `{ "unit": "match_presence", "total_matches": N,
  "matches_with_rows": N, "rows": N, "ratio": number | null }`;
- scalar `rows = 0` yields `observed: { "unit": "rows", "rows": 0,
  "non_null": 0, "null": 0, "ratio": null }`
  and a note saying no availability conclusion can be made;
- scalar `ratio` is `non_null / rows`; lineup ratio is
  `matches_with_rows / total_matches`; both are rounded to six decimal places;
- SQL `COUNT(column)` protects against null inflation;
- grouped quarter-score aliases expand to the eight real columns in the new
  contract; and
- computed PAV uses table-row presence for the selected season, while lineup
  coverage uses both row count and match presence. A zero count before a season
  starts is `not_observed`, not proof of absence.

Do not expose row identifiers, player names, match objects, or inferred row
provenance. “Source” describes the expectation's known adapter(s), not a claim
that each observed row records provenance.

### Query bounds and cache

- Resolve one `season_id` from bound `competition` and `season` parameters.
- Run per-table aggregate statements constrained by that ID. For
  `player_match_stats`, use `match_id IN (SELECT id FROM matches WHERE
  season_id = ?)` so existing indexes avoid the 1.2-million-row join plan.
- Query `matches` directly for weather denominators, `player_season_pav`
  directly by indexed `season_id` for PAV row presence, and `match_lineups`
  through indexed season match IDs for row/match presence. Keep these as
  separate statements so a cross-product cannot inflate counts.
- Generate the select list only from a hard-coded, identifier-safe column
  manifest. Bind values; never interpolate user input or column names supplied
  by the caller.
- Query at most one competition-season per call. No ranges, all-competition
  mode, unbounded scans, writes, or background refreshes.
- Cache successful observation JSON for 15 minutes under a versioned key
  containing competition, season, and coverage-contract version. Do not cache
  errors. Use Cloudflare Cache API or a repository-approved equivalent that
  does not add D1 writes.
- Cap serialized `schema` output at 128 KiB in a test. If fully materialized
  expectations exceed this ceiling, stop and redesign; do not silently omit
  columns.

### Compatibility

- Existing `schema` calls with `{}` continue to work and return the existing
  tables, notes, joins, and query API plus additive coverage fields.
- Existing `column_coverage` may remain as a generated version-1 alias for one
  release. Mark it deprecated in prose. Remove it only in a later major
  compatibility decision.
- `tools/list` still reports three tools. The `schema` input JSON Schema gains
  optional properties only.
- Coverage values are descriptive, never authorization or SQL rewrite rules.

## Implementation slices

The live-state and coverage changes should be separate commits and may be
implemented on parallel branches. They share schema documentation, so one
integration owner must resolve `src/mcp/tools/schema.ts`, `docs/schema.md`, and
the public ecosystem document after both land.

### Slice A: completed-quarter persistence

In scope:

- `src/db/schema.sql`
- next `src/db/migrations/00NN_completed_quarter.sql`
- `src/sync/upserts.ts`
- `src/mcp/tools/schema.ts`
- `docs/schema.md`
- `docs/sync.md`
- `test/integration/_fixtures.ts`
- `test/integration/upsert-matches.test.ts`
- `test/integration/schema-doc-drift.test.ts`
- `test/upsert-columns.test.ts`
- homepage `public/docs/afl-data-ecosystem.md`

Tests must cover migration compatibility with the old and new Worker shape;
null on upcoming/no-clock input; 0, 1, 2, 3, and 4 lifecycle updates; null not
clobbering a prior value; invalid CHECK values; manifest fragment consistency;
schema-tool exact text; and competition isolation in example queries.

### Slice B: coverage contract

In scope:

- new `src/mcp/tools/coverage.ts`
- `src/mcp/tools/schema.ts`
- `src/mcp/protocol.ts`
- `src/mcp/validation.ts`
- `docs/schema.md`
- `docs/architecture.md`
- new unit tests for manifest expansion and observation SQL
- `test/integration/schema-doc-drift.test.ts`
- protocol tests for default and observed schema calls
- homepage `public/docs/afl-data-ecosystem.md`

Tests must cover manifest type safety; every analytics table/column assigned an
expectation; every competition coverage leaf and baseline notes-array coverage
claim either generated from the manifest or explicitly classified as semantic
prose; exact range resolution; empty, sparse, and full observations;
`COUNT(column)` null handling; VFLW best-effort behavior; all-null weather;
AFLM-present/AFLW-VFL-VFLW-empty PAV row presence; lineup row and distinct-match
presence including zero-row pre-season input; competition and season isolation;
rejection of missing/invalid bounds; indexed query shape with separate weather,
PAV, stats, and lineup statements; 15-minute cache behavior; default-call zero
D1 reads; response compatibility; and the 128 KiB payload ceiling.

### Shared verification gates

Run after each slice and again after integration:

```bash
bun run typecheck
bun run test
bun run check
```

Expected: typecheck exits 0; all Vitest tests pass; Biome exits 0. Existing
Biome warnings may remain only if unchanged. Also inspect the final diff to
confirm no venue-native fields or time conversion changes were introduced.

## Stop conditions

Stop and report instead of improvising if any of these becomes true:

- installed/current fitzroy no longer exposes `completedQuarter` with the
  documented semantics;
- production behavior requires private data to interpret quarter completion;
- a proposal changes Melbourne-time canonical storage;
- honest observations require an unbounded scan or any D1 write;
- expectations and observations cannot be distinguished in the response;
- a fourth MCP tool becomes necessary without a new capability/cost matrix;
- observation payload exceeds 128 KiB; or
- migration ordering cannot preserve compatibility with the previous Worker.

## Maintenance

- Treat `completed_quarter` as five-minute-sync context, not a second-level
  siren SLA. Keep raw `live_period_status` for upstream debugging.
- Any new analytics column must add or inherit a typed coverage expectation;
  CI must fail if it does neither.
- Adapter upgrades that change field availability require updating manifest
  provenance/review date and measured fixtures in the same change.
- Schema, migration, MCP schema response, repository docs, and homepage
  ecosystem docs must change together when public coverage changes.
