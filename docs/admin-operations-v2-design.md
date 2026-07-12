# Design: Brownlow ingestion and private operator diagnostics

**Plan**: 013/016 | **Status**: implemented | **Date**: 2026-07-12

This document specifies two authenticated admin operations:

- annual AFLM Brownlow vote ingestion; and
- bounded, aggregate-only operational status.

The contract is implemented by `src/admin/brownlow.ts`,
`src/admin/status.ts`, and the shared lease in `src/sync/lease.ts`. It
supersedes only the Brownlow material in
[`admin-backfills-design.md`](./admin-backfills-design.md). DOB and lineup
recommendations there remain unchanged.

## 1. Evidence and decisions

### 1.1 Upstream capability

[fitzroy-ts #117](https://github.com/jackemcpherson/fitzRoy-ts/issues/117)
closed on 2026-05-09. Installed `fitzroy@3.4.0` exposes:

```typescript
interface SeasonPlayerStats {
  readonly stats: readonly PlayerStats[];
  readonly failedMatchIds: readonly string[];
}
```

`PlayerStats.brownlowVotes` is `number | null`, and the AFL Tables adapter
parses cell 16. Implementations must read `result.data.stats`; the cast of
`result.data` directly to `readonly PlayerStats[]` in
`scripts/backfill-brownlow.ts` is stale and must not be copied.

A read-only `/tmp/brownlow-probe.ts` fetched AFL Tables data without printing
players, match IDs, or raw rows:

| Season | Rows | Failed matches | Non-null votes | Positive votes | Vote sum |
|--------|-----:|---------------:|---------------:|---------------:|---------:|
| 2024 | 9,936 | 0 | 621 | 621 | 1,242 |
| 2025 | 9,936 | 0 | 621 | 621 | 1,242 |

Both seasons contain 207 regular-season matches, hence 207 × six votes =
1,242. Identical aggregates are plausible and do not imply identical rows.

### 1.2 Production resolution probe

Wrangler authentication was available. A second temporary probe made only
remote `SELECT` calls, joined seasons through `competitions.code = 'AFLM'`,
and resolved positive-vote rows by date plus canonical team, never by round.
It printed aggregate counters only:

| Season | Exact | Normalized | Unique surname | Season fallback | Unresolved match | Unresolved player | Ambiguous | Match totals 0 / 6 / other |
|--------|------:|-----------:|---------------:|----------------:|-----------------:|------------------:|----------:|----------------------------:|
| 2024 | 612 | 7 | 2 | 0 | 0 | 0 | 0 | 0 / 207 / 0 |
| 2025 | 614 | 7 | 0 | 0 | 0 | 0 | 0 | 0 / 207 / 0 |

This supports automatic writes for these two seasons. It does not waive the
per-request dry-run gate: upstream spelling and D1 rosters can drift each
year. Every target season must still resolve all nonzero rows uniquely and
produce only six-vote regular matches before writes are allowed.

### 1.3 Operational decisions

- Brownlow remains an explicit annual operation. Do not add AFL Tables season
  scraping to the five-minute cron.
- Brownlow is AFLM-only and does not recalculate PAV; votes are not a PAV
  input.
- Existing Melbourne-time conventions remain unchanged. Resolution uses the
  stored match date and canonical team, matching the AFL API standard.
- Public `/health` and `/mcp/health` remain unchanged. Detailed status is
  private and aggregate-only.
- No schema migration is required. Existing `brownlow_votes`, `sync_log`,
  `sync_lease`, and five integrity views are sufficient.

## 2. Shared operation lease

Move the current private lease functions from `src/sync/sync.ts` into
`src/sync/lease.ts`:

```typescript
export async function acquireOperationLease(env: Env, holder: string): Promise<boolean>;
export async function releaseOperationLease(env: Env, holder: string): Promise<void>;
```

Keep the current atomic ten-minute expiry SQL and holder-checked release. The
cron, manual sync, and Brownlow endpoint use this single helper; do not create
a second lease row or table. Generate holders internally with
`crypto.randomUUID()`. Never return or log a holder.

If acquisition returns false, Brownlow returns HTTP 409:

```json
{ "error": "operation lease held" }
```

Always release in `finally`. A D1 error while acquiring is an internal error,
not a 409. Existing sync behavior on contention remains unchanged.

## 3. `POST /mcp/admin/backfill-brownlow`

### 3.1 Boundary and clamps

Route through the existing `/mcp/admin/*` branch and `requireAdmin`; missing
configuration remains 503 and an invalid bearer token remains 401. Add this
schema to `src/mcp/validation.ts`:

```typescript
export const BrownlowBackfillRequestSchema = z.object({
  fromYear: z.number().int(),
  toYear: z.number().int(),
  dryRun: z.boolean().default(true),
});
export type BrownlowBackfillRequest = z.infer<typeof BrownlowBackfillRequestSchema>;
```

Reject invalid JSON or shape with 400. Then enforce:

- `1990 <= fromYear <= toYear <= current UTC year`;
- at most two inclusive seasons per request; and
- only `AFLM` internally; competition is not caller-selectable.

Two seasons mean at most roughly 414 upstream match pages. Before coding,
confirm the deployed Worker subrequest budget supports that bound. If it does
not, STOP and reduce the maximum to one season; do not add background or
multi-request orchestration without a new design.

### 3.2 Dedicated module and upstream envelope

Put orchestration and resolution in `src/admin/brownlow.ts`; keep
`src/index.ts` limited to JSON parsing, validation, and response mapping. Call:

```typescript
fetchPlayerStats({ source: "afl-tables", season: year, competition: "AFLM" })
```

On success consume both `result.data.stats` and
`result.data.failedMatchIds`. A non-empty failed-ID list makes that season
ineligible for writes, even if all returned rows resolve. Preserve the IDs
inside the fetch result long enough to count and gate them, but expose and log
only `failedMatchCount`; do not return raw IDs.

### 3.3 Match and player resolution

Load D1 matches and rosters for exactly one AFLM season at a time. Every query
must join `seasons.competition_id` to `competitions.id` and filter both
`c.code = 'AFLM'` and `s.year = ?`. Never filter or group by round name or
`round_number` alone.

Extract the final `YYYYMMDD` from the AFL Tables stats match ID. Resolve a
match by `(stored date, normaliseTeam(stat.team))`, indexing both home and away
teams. Exactly one match is required. Then try player resolution in order:

1. exact `(match_id, canonical team, trimmed given name, trimmed surname)`;
2. normalized exact, lowercasing and stripping non-alphanumerics from names;
3. surname on that match/team, accepted only when one candidate remains after
   full-name prefix matching or a unique three-character given-name stem; and
4. exact trimmed season name, accepted only when it maps to one player ID.

Maps hold arrays or sets, not a single overwritable value. Any zero-candidate
case increments an unresolved counter. Any multi-candidate case increments
`ambiguous`; never pick the first candidate. Keep resolution pure enough for
unit tests.

For each regular match, sum resolved positive votes. A season is writeable
only when all are true:

- `failedMatchCount === 0`;
- every positive-vote row resolves to exactly one match and player;
- `unresolvedMatch === 0`, `unresolvedPlayer === 0`, and `ambiguous === 0`;
- every resolved regular match total equals six; and
- no upstream positive-vote row points to a finals match.

Zero totals are allowed only when the whole season has no published votes. In
that case return `notPublished: true` and perform no writes. A mixture of zero
and six, or any other positive total, is a failed invariant and performs no
writes. This gate must run for dry-run and write requests alike.

### 3.4 Writes and response

Use parameterized D1 statements only:

```sql
UPDATE player_match_stats
SET brownlow_votes = ?1
WHERE match_id = ?2
  AND player_id = ?3
  AND (brownlow_votes IS NULL OR brownlow_votes = 0)
```

Submit native `env.DB.batch()` calls in bounded batches of at most 100
statements. Do not generate SQL files, invoke a shell, call Wrangler, or write
when `dryRun` is true. The NULL-or-zero guard makes re-runs idempotent and
preserves values populated by sync. Do not call `recalculatePav`.

HTTP 200 response has these exact top-level keys:

```json
{
  "status": "ok",
  "dryRun": true,
  "seasons": [
    {
      "year": 2025,
      "upstreamRows": 9936,
      "failedMatchCount": 0,
      "positiveVoteRows": 621,
      "resolution": {
        "exact": 614,
        "normalized": 7,
        "surname": 0,
        "seasonFallback": 0,
        "unresolvedMatch": 0,
        "unresolvedPlayer": 0,
        "ambiguous": 0
      },
      "regularMatchTotals": { "zero": 0, "six": 207, "other": 0 },
      "eligible": true,
      "notPublished": false,
      "updated": 0
    }
  ]
}
```

`updated` is zero in dry-run mode and the sum of D1 `meta.changes` otherwise.
If any season is ineligible, return HTTP 409 with `status: "blocked"`, the same
sanitized season summaries, and no writes for any season in the request. Do
all resolution and invariant checks before starting the first batch.

After a successful write, add one `sync_log` row per season with type
`admin:brownlow-backfill`, `rows_affected = updated`, and `error = NULL`.
For blocked or failed runs, record only a bounded code such as
`blocked:resolution`, `blocked:partial-fetch`, or `failed:upstream`; never log
player names, match IDs, raw upstream errors, tokens, request identity, or row
samples. These admin log types must not enter the public health paging query.

Keep `scripts/backfill-brownlow.ts` until endpoint dry-run and write results
match a script dry-run for two completed seasons. Then delete both it and any
write-capable shell helper in a separate cleanup commit; retain a read-only
diagnostic only if it uses the v3 envelope and aggregate-safe output.

## 4. `GET /mcp/admin/status`

### 4.1 Contract

Require admin auth and reject non-GET methods through the existing not-found
behavior. Return HTTP 200 with these exact keys:

```json
{
  "status": "ok",
  "asOf": "2026-07-12T06:00:00.000Z",
  "lease": { "held": false, "ageSeconds": null },
  "competitions": [
    {
      "code": "AFLM",
      "latestSyncAt": "2026-07-12T05:55:00.000Z",
      "syncAgeSeconds": 300,
      "latestSuccessAt": "2026-07-12T05:55:00.000Z",
      "successAgeSeconds": 300,
      "latestErrorAt": null,
      "errorAgeSeconds": null,
      "latestCompletedMatchDate": "2026-07-11"
    }
  ],
  "integrity": {
    "disposals": 0,
    "matchPoints": 0,
    "quarterScores": 0,
    "margin": 0,
    "brownlow": 0
  },
  "degradation": {
    "windowHours": 24,
    "partialLineupEvents": 0,
    "partialStatsEvents": 0,
    "unmappedTeamEvents": 0
  }
}
```

`competitions` always contains `AFLM`, `AFLW`, `VFL`, and `VFLW` in that
order. Missing data uses null timestamps, null ages, and null match dates; do
not omit keys. Compute ages against one captured `now` and clamp negative ages
to zero.

Lease query returns only `holder IS NOT NULL` and age derived from
`acquired_at`; never select or return `holder`. Treat an expired lease as not
held and return `ageSeconds: null`, matching the ten-minute lease semantics.

For each competition, one grouped aggregate over exact `sync:<code>` rows
returns three timestamps without selecting error text:

- `latestSyncAt` is the maximum timestamp across success and error rows;
- `latestSuccessAt` is the maximum timestamp where `error IS NULL`; and
- `latestErrorAt` is the maximum timestamp where `error IS NOT NULL`.

`syncAgeSeconds`, `successAgeSeconds`, and `errorAgeSeconds` are independently
derived from those timestamps. A category with no row returns null for both
its timestamp and age. An absent or unparsable timestamp also returns a null
age. Subtask types such as `sync:AFLM:stats` must never count as whole-sync
successes or errors. The grouped query may use conditional `MAX(CASE ...)`
expressions, but must not select, return, or parse `sync_log.error`.

`latestCompletedMatchDate` filters by competition and completed score, not
round. Integrity values are `COUNT(*)` over the five existing views.
Degradation counts are event counts in the preceding 24 hours for:

- `partialLineupEvents`: logs with type `sync:<code>:lineups` and an error
  beginning `fetchLineup failed:`;
- `partialStatsEvents`: logs with type `sync:<code>:stats` and an error
  beginning either `fetchPlayerStats failed:` or `partial season stats:`; and
- `sync:stats:unmapped-team` rows.

These prefix predicates classify bounded event rows only. Do not parse counts,
IDs, names, or other content from `sync_log.error`; count matching rows. No raw
error text is returned.

### 4.2 Query and privacy bounds

Implement the queries in `src/admin/status.ts`. Use a fixed statement list,
parameterized timestamps, and `env.DB.batch()` where practical. Maximum query
budget is nine statements: one lease, one grouped whole-sync success/error
aggregate, one grouped latest-match query, five integrity counts, and one
degradation aggregate. The extra success/error and lineup counters must remain
columns in those grouped aggregates, not new per-competition statements. No
caller input may alter SQL, time window, ordering, or limits.

Target a response under 16 KiB and record elapsed query time internally. If
the fixed query set fails, return the existing sanitized 500 response; do not
return a partial status or raw D1 error. Do not add a retry loop. The route
must not query or expose tokens, request headers, client IP, lease holder,
player/match rows, raw errors, or sync-log samples.

Do not add these fields to public health. Public health stays a small uptime
signal with its current keys and status-code behavior.

## 5. Implementation map and slices

Implement in two independent slices after extracting the shared lease:

### Slice A: Brownlow operation

Files in scope:

- `src/admin/brownlow.ts` (new): fetch, resolution, invariant gate, batches;
- `src/sync/lease.ts` (new): shared lease;
- `src/sync/sync.ts`: import shared lease only;
- `src/mcp/validation.ts`: Brownlow request schema and messages;
- `src/index.ts`: route mapping only;
- focused unit and integration tests; and
- public ecosystem docs because this adds an endpoint.

### Slice B: private status

Files in scope:

- `src/admin/status.ts` (new): fixed aggregate queries and response mapping;
- `src/index.ts`: GET route mapping only;
- focused integration tests; and
- public ecosystem docs because this adds an endpoint.

No migration, cron change, PAV change, public-health change, or deployment is
part of either slice. Slice B can follow the lease extraction without waiting
for Brownlow resolution code.

## 6. Test contract

Follow existing Worker integration setup under `test/integration/`. Add tests
for:

- v3 `{ stats, failedMatchIds }` consumption and a partial-fetch write block;
- exact, normalized, unique-surname, and unique-season resolution;
- ambiguous surname/prefix/stem cases never selecting the first candidate;
- date plus canonical-team match resolution, including Opening Round without
  using `round_number`;
- dry-run performing zero writes, write mode batching, NULL-or-zero guards,
  and second-run idempotency;
- all-or-nothing multi-season validation, six-vote invariant, unpublished
  votes, finals rejection, lease contention, and `finally` release;
- Brownlow route auth, JSON/schema/range clamps, response keys, sanitized logs,
  and no PAV call;
- status auth and exact response keys/order;
- all five integrity counts, empty DB nulls, active/stale lease mapping,
  independently aged whole-sync success/error rows, and sanitized failure
  responses;
- partial lineup fetch, full stats fetch, partial season stats, and unmapped
  team degradation event counts, including exclusion of unrelated/raw error
  rows; and
- public health response remaining byte-for-byte shape-compatible.

Required gates:

```bash
bun run typecheck
bun run test
bun run check
```

All must exit zero. New tests must fail before their implementation and pass
after it.

## 7. STOP conditions

Stop and report instead of guessing if:

- installed fitzroy no longer exposes `brownlowVotes` or the v3 envelope;
- an upstream probe requires writes or printing player/raw-row data;
- any nonzero vote needs a non-unique resolution or manual player choice;
- a target season has partial upstream failures or a regular-match vote total
  other than six;
- the Worker subrequest budget cannot support the chosen season clamp;
- status needs an unbounded scan, caller-controlled SQL/window, raw errors, or
  row samples;
- sharing the lease changes existing cron contention semantics; or
- implementation needs a schema migration, PAV recalculation, public-health
  expansion, or broader awards/player-profile work.

## 8. Maintenance

Run Brownlow once after each annual count, dry-run first. Review aggregate
resolution and six-vote counters before sending the write request. Preserve
partial-result awareness whenever fitzroy changes. Reviewers should reject any
future convenience change that identifies seasons by round alone, exposes raw
diagnostics, or turns the operation into a five-minute scraper.
