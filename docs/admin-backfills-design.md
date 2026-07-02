# Design: Promoting recurring backfills to the admin surface

**Plan**: 011 | **Status**: draft | **Date**: 2026-07-02

## 1. Inventory

All 14 files under `scripts/`. None are imported by `src/`. None are
covered by `tsconfig.json` (`include` lists only `src/**` and
`test/**`). The shared operating pattern: fetch upstream via fitzroy
clients → generate batched `.sql` files under `data/sql-*/`
(git-ignored) → apply via `execSync` calls to `wrangler d1 execute
--remote`. Every script uses production D1 directly, bypassing the
Worker's upsert/lease machinery.

| # | File | Purpose | Tables / columns written | Upstream source | Last git touch | Classification | Idempotent? | Bypass `normaliseTeam`? |
|---|------|---------|--------------------------|-----------------|----------------|----------------|-------------|------------------------|
| 1 | `backfill-brownlow.ts` | Backfill `brownlow_votes` for AFLM seasons 1990–present from AFL Tables | `player_match_stats.brownlow_votes` | `fetchPlayerStats({ source: "afl-tables" })` | `34f9e7e` 2026-05-10 | **RECURRING** | Yes — `WHERE brownlow_votes IS NULL OR brownlow_votes = 0` (line 268) | No — imports `normaliseTeam` from `src/lib/normalise` |
| 2 | `backfill-dob.mts` | Two-stage DOB backfill: Stage 1 via fryzigg external_id, Stage 2 via AFL Tables team roster pages | `players.date_of_birth` | `FryziggClient`, `AflTablesClient` | `2042004` 2026-06-28 | **RECURRING** | Yes — `WHERE date_of_birth IS NULL` on all UPDATEs (lines 211, 370) | No — imports `normaliseTeamName` from `fitzroy` |
| 3 | `backfill-lineups-early.ts` | Lineup backfill for 2015–2019 seasons that lack `external_afl_id`; resolves matches via `year\|round_number\|home_team` | `match_lineups`, `matches.external_afl_id`, `players` | `fetchLineup({ source: "afl-api" })` | `cb4aa1c` 2026-05-09 | **ONE-SHOT-DONE** | Partial — `ON CONFLICT (match_id, player_id) DO UPDATE SET` on lineups, but player INSERTs overwrite | Local `TEAM_NAME_MAP` — drift risk vs `normalise.ts` |
| 4 | `backfill-lineups.ts` | General lineup backfill for 2015+ using `external_afl_id` for match resolution | `match_lineups`, `players` | `fetchLineup({ source: "afl-api" })` | `cb4aa1c` 2026-05-09 | **OPERATIONAL-KEEP** | Yes — `ON CONFLICT (match_id, player_id) DO UPDATE SET` (line 234) | Local `TEAM_NAME_MAP` — drift risk vs `normalise.ts` |
| 5 | `backfill-rounds.ts` | Corrects `round`, `round_number`, `round_type` on matches by comparing D1 vs AFL API; default range 2024–current | `matches.round`, `matches.round_number`, `matches.round_type` | `fetchMatches({ source: "afl-api" })` | `aaef468` 2026-05-10 | **ONE-SHOT-DONE** | Yes — explicit diff check before emitting UPDATE (lines 109–117) | No — imports `normaliseTeam` from `src/lib/normalise` |
| 6 | `dedup-players.ts` | Merge duplicate player records created when fryzigg and AFL API ingested the same person as separate rows; reassigns FKs | `players`, `match_lineups`, `player_match_stats`, `player_season_pav` | D1 only (no upstream fetch) | `668cd06` 2026-04-30 | **ONE-SHOT-DONE** | Yes by design — re-run finds no remaining duplicates | n/a — no team normalisation needed |
| 7 | `diagnose-brownlow-gaps.ts` | Read-only probe: finds Brownlow vote records in AFL Tables that cannot be matched to a D1 player, printing diagnostics | none | `fetchPlayerStats({ source: "afl-tables" })` | `34f9e7e` 2026-05-10 | **OPERATIONAL-KEEP** | n/a — read-only | No — imports `normaliseTeam` from `src/lib/normalise` |
| 8 | `enrich-fryzigg.ts` | Enriches `player_match_stats` (brownlow, supercoach) and `matches` (weather, local_time, external_fryzigg_id) from fryzigg full dataset | `player_match_stats.brownlow_votes`, `player_match_stats.supercoach_score`, `matches.weather_temp_c`, `matches.weather_type`, `matches.local_time`, `matches.external_fryzigg_id` | `FryziggClient.fetchPlayerStats("AFLM")` | `668cd06` 2026-04-30 | **ONE-SHOT-DONE** | Yes — `IS NULL` guards on all write targets (lines 228, 244–253) | Local `FRYZIGG_TEAM_MAP` — also includes historical teams (Fitzroy, Brisbane Bears) not in `normalise.ts` |
| 9 | `probe-afltables-lineups.ts` | Read-only probe: tests `fetchLineup({ source: "afl-tables" })` for specific rounds in 2015–2022 | none | `fetchLineup` | `06df36e` 2026-05-10 | **ONE-SHOT-DONE** | n/a — read-only | n/a |
| 10 | `probe-missing-lineups.ts` | Read-only probe: tests `fetchLineup({ source: "afl-api" })` for the known-missing rounds (2015/R4, 2017/R8, 2018/R9, 2019/R11) | none | `fetchLineup` | `e222e8e` 2026-05-10 | **ONE-SHOT-DONE** | n/a — read-only | n/a |
| 11 | `probe-opening-rounds.ts` | Read-only probe: fetches 2024/2025/2026 match data and prints round-number distributions for Opening Round investigation | none | `fetchMatches({ source: "afl-api" })` | `aaef468` 2026-05-10 | **ONE-SHOT-DONE** | n/a — read-only | n/a |
| 12 | `refetch-lineups.ts` | Re-fetches lineups for a year range (default 2021–2022) using DELETE+INSERT per round, for destructive replacement | `match_lineups` | `fetchLineup({ source: "afl-api" })` | `e222e8e` 2026-05-10 | **OPERATIONAL-KEEP** | No — intentional DELETE then INSERT (not ON CONFLICT); suited to corrupt-data repair | No — imports `normaliseTeam` from `src/lib/normalise` |
| 13 | `seed-d1.ts` | One-time Postgres→D1 migration: reads CSV exports from `data/export/`, generates `INSERT OR REPLACE` SQL files | `competitions`, `seasons`, `teams`, `venues`, `players`, `matches`, `player_match_stats`, `player_season_pav` | `data/export/*.csv` (local) | `668cd06` 2026-04-30 | **ONE-SHOT-DONE** | Yes — `INSERT OR REPLACE` | n/a |
| 14 | `verify-integrity.ts` | Cross-checks CSV row counts against D1 counts; spot-checks specific player/match/PAV rows | none (read-only) | D1 + `data/export/*.csv` | `668cd06` 2026-04-30 | **ONE-SHOT-DONE** | n/a — read-only | n/a |

Classification counts: **RECURRING 2**, **ONE-SHOT-DONE 9**, **OPERATIONAL-KEEP 3**.

---

## 2. Classification rationale and promotion decisions

### 2.1 RECURRING scripts

#### `backfill-brownlow.ts` → Promote to admin endpoint

Brownlow votes are published after the season's final round and media
count (typically late September or October). There will always be a
current-year gap until `fitzroy-ts#117` ships. The volume per year
(~450–600 player-game rows) and the three-tier name-resolution
algorithm (exact → normalised exact → surname-on-team → season
fallback) both exceed what the five-minute cron tick can absorb safely
— the algorithm makes two D1 queries per year plus one AFL Tables
fetch, which is fine for a targeted request but too expensive to run on
every tick. The operator needs explicit year-range control, which maps
naturally to the `BackfillRequestSchema` pattern already in
`src/mcp/validation.ts`. Keep as a hardened script until the endpoint
exists, then retire the script.

#### `backfill-dob.mts` → Promote to admin endpoint

New players debut each AFLM season and the AFL Tables source updates
team roster pages throughout the year. The `date_of_birth` column is
needed by age-curve tipper models (T30 feature, as noted in `7cdbb7a`
commit message). The fryzigg stage is a single large download matched
by `external_id`, while the AFL Tables stage makes one HTTP request per
team (~18 requests); combined they far exceed the cron tick budget.
Operator intent is needed — an accidental re-run when all DOBs are
already populated is harmless (all UPDATEs have `WHERE date_of_birth IS
NULL`), but the fetch cost and multi-stage orchestration make an ad-hoc
button better than a script. The `--stage` parameter (fryzigg / afltables
/ all) must be preserved as an endpoint field.

### 2.2 ONE-SHOT-DONE scripts

**`backfill-lineups-early.ts`**: Designed for 2015–2019 seasons that
lacked `matches.external_afl_id` at the time of initial ingestion.
Those matches now have `external_afl_id` populated (set by the script
itself). Re-running would produce no new work. The `year|round_number|
home_team` matching strategy is not used by any other path in the
codebase. Recommend deletion; git history preserves the algorithm.

**`backfill-rounds.ts`**: Created specifically in `aaef468` to correct
round label errors in 2024 and 2025 data after a derivation bug was
found. The sync pipeline (`upsertMatches` in `src/sync/upserts.ts`)
correctly derives and writes `round`, `round_number`, and `round_type`
from AFL API on each tick, so future seasons are covered. If a new
label derivation bug occurs, the fix belongs in `upsertMatches`, not
in a re-run of this script. Recommend deletion.

**`dedup-players.ts`**: Addressed a one-time structural split where the
same player had separate rows under `external_id` (fryzigg) and
`external_afl_player_id` (AFL API). The underlying cause is
resolved — `upsertPlayers` in `src/sync/upserts.ts` now handles both
IDs via `ON CONFLICT (external_afl_player_id)`, so new players will not
split. Re-running when no duplicates remain produces no writes. The
"fryzigg-only player with a separate AFL-only record for the same
person" configuration cannot arise from the current sync pipeline.
Recommend deletion; the disambiguation-by-team-overlap algorithm in the
script is worth citing in any future dedup runbook.

**`enrich-fryzigg.ts`**: Written for the initial data population in
April 2026. The `weather_temp_c`/`weather_type` columns are at 100%
coverage for 2010–2025 (fryzigg weather enrichment decision: NO-ENRICH
— no additional weather fields available). `brownlow_votes` is
maintained by the dedicated Brownlow backfill. `supercoach_score` and
`brownlow_votes` are written by the sync pipeline via `STAT_COLUMNS`
with `kind: "coalesce"` guards (`src/sync/upserts.ts:670–671`).
`local_time` is populated by the sync pipeline. `external_fryzigg_id`
was a one-time population. The local `FRYZIGG_TEAM_MAP` (including
defunct teams: Fitzroy, Brisbane Bears) diverges from `normalise.ts`
— a maintenance risk if kept. Recommend deletion.

**`probe-afltables-lineups.ts`**, **`probe-missing-lineups.ts`**,
**`probe-opening-rounds.ts`**: One-time diagnostic probes created
alongside their respective bug-fix commits (#73, #71, #67). The
investigations they supported are closed. No remaining value.
Recommend deletion.

**`seed-d1.ts`**, **`verify-integrity.ts`**: Initial Postgres→D1
migration tools. The CSV export files in `data/export/` are no longer
maintained. Recommend deletion.

### 2.3 OPERATIONAL-KEEP scripts

**`backfill-lineups.ts`**: Covers historical season lineup repair for
2015+ when `matches.external_afl_id` is available. The sync pipeline's
`selectCompletedRoundsWithoutLineups` self-heals lineup gaps for
current and recent seasons; for seasons outside the cron's rolling
window, this script is the repair path. Hardening needed: (a) add to
`tsconfig.json` include, (b) replace the local `TEAM_NAME_MAP` with
`import { normaliseTeam } from "../src/lib/normalise"` to prevent
drift.

**`refetch-lineups.ts`**: The DELETE+INSERT pattern (not ON CONFLICT)
is intentionally destructive — the only correct tool when lineup rows
are corrupt rather than merely missing. The pipeline's upsert would
leave bad rows untouched. Hardening needed: same as
`backfill-lineups.ts` (typecheck coverage + drift fix). Add a runbook
note: use this script only when lineups are *wrong*, not *missing*;
for missing lineups, use `backfill-lineups.ts` or trigger a manual sync.

**`diagnose-brownlow-gaps.ts`**: Read-only diagnostic for when the
Brownlow backfill endpoint (or script) reports unresolved players.
Hard-codes years 2022–2025 (line 47); that range should be made a CLI
argument when hardening. No write risk.

---

## 3. Endpoint specifications

### 3.1 `POST /mcp/admin/backfill-brownlow`

**Route**: `POST /mcp/admin/backfill-brownlow`

**Auth**: `requireAdmin` via `Authorization: Bearer <ADMIN_TOKEN>`
(existing pattern, `src/index.ts:122–132`). Fails closed: returns 503
when `ADMIN_TOKEN` is not configured.

**Zod request schema**:

```typescript
// Mirror BackfillRequestSchema style (src/mcp/validation.ts)
const BrownlowBackfillRequestSchema = z.object({
  fromYear: z.number().int(),
  toYear: z.number().int(),
  dryRun: z.boolean().optional(), // default false
});
type BrownlowBackfillRequest = z.infer<typeof BrownlowBackfillRequestSchema>;
```

**Cross-field clamps** (enforced outside the schema, mirroring
`validateYearRange`):
- `fromYear >= 1990` (AFL Tables Brownlow coverage floor; constant:
  `MIN_BROWNLOW_YEAR` in `backfill-brownlow.ts:13`)
- `toYear <= currentYear`
- `toYear - fromYear + 1 <= 10` (max 10 years per request; one AFLM
  season ≈ 450–600 player-game rows, 10 seasons ≈ 5,000–6,000 D1
  writes across ~30 batches — well within 30-second Workers walltime)

**Response**:

```json
{
  "status": "ok",
  "seasons": [
    {
      "year": 2025,
      "updates": 435,
      "unresolvedMatch": 0,
      "unresolvedPlayer": 3
    }
  ],
  "dryRun": false
}
```

On `dryRun: true`, return the same shape but write nothing; include a
`sampleStatement` string for quick inspection.

**Concurrency**: Must acquire the sync lease (`acquireSyncLease` in
`src/sync/sync.ts:108–116`). The endpoint writes
`player_match_stats.brownlow_votes`, which the sync pipeline also
writes (via the `kind: "coalesce"` column in `STAT_COLUMNS`). A
concurrent cron tick could interleave writes. If the lease is held,
return 409 with `{ "error": "sync lease held by another operation" }`.

**Idempotency**: Each UPDATE carries `WHERE (brownlow_votes IS NULL OR
brownlow_votes = 0)`. Re-running after a complete backfill emits zero
writes. The `COALESCE` guard in `upsertStats` means a subsequent cron
tick will not overwrite votes written by this endpoint.

**Chunking contract**: Max 10 years per request. If you need to
backfill 1990–2025 (36 seasons), make four requests: 1990–1999,
2000–2009, 2010–2019, 2020–2025.

**Failure / observability**:
- Write `sync_log` rows with type `admin:brownlow-backfill` on
  completion. Use `error` column only when a season fetch fails
  (same pattern as `logSync` in `src/sync/log.ts`).
- `admin:brownlow-backfill` is NOT in the health-paging set
  (`sync:fatal`, `sync:AFLM`, `sync:AFLW`, `sync:VFL`, `sync:VFLW`).
  Admin one-shot operations must not page on-call.
- Per-season unresolved counts (`unresolvedMatch`, `unresolvedPlayer`)
  surface in the response body for the caller to inspect; they do not
  trigger paging.

**Obsolescence**: This endpoint becomes redundant when
`fitzroy-ts#117` is resolved and Brownlow votes flow through the normal
sync pipeline (`fetchPlayerStats({ source: "afl-tables" })` wired to
`upsertStats`). At that point the endpoint can be removed and the
sync pipeline will populate `brownlow_votes` each season automatically.

**Implementation estimate**: S — algorithm already written in
`backfill-brownlow.ts`; port the three-tier name resolution and D1
write loop to Worker context, replace `wrangler d1 execute` shell calls
with `env.DB.batch()`, add Zod schema and route handler.

---

### 3.2 `POST /mcp/admin/backfill-dob`

**Route**: `POST /mcp/admin/backfill-dob`

**Auth**: `requireAdmin` via `Authorization: Bearer <ADMIN_TOKEN>`.

**Zod request schema**:

```typescript
const DobBackfillRequestSchema = z.object({
  fromYear: z.number().int(),
  toYear: z.number().int(),
  stage: z.enum(["fryzigg", "afltables", "all"]).optional(), // default "all"
  dryRun: z.boolean().optional(), // default false
});
type DobBackfillRequest = z.infer<typeof DobBackfillRequestSchema>;
```

**Cross-field clamps**:
- `fromYear >= 1990`, `toYear <= currentYear`
- `toYear - fromYear + 1 <= 5` when `stage === "afltables"` or
  `stage === "all"` (AFL Tables stage makes one HTTP request per
  AFLM team roster page; ~18 subrequests + D1 queries stay within
  Workers' per-request subrequest budget)
- `stage === "fryzigg"` is exempt from the year-range clamp (it
  downloads the full fryzigg AFLM dataset in one fetch and filters
  by `external_id`; no year iteration)

**Memory note**: The fryzigg stage downloads the full AFLM DataFrame
(the same large payload used by `enrich-fryzigg.ts`). Due to potential
memory pressure in the Worker, the fryzigg stage should be issued as a
separate request (`stage: "fryzigg"`) before the AFL Tables stage.
The `stage: "all"` path is appropriate only for small year ranges.

**Response**:

```json
{
  "status": "ok",
  "stage": "afltables",
  "updates": 142,
  "alreadySet": 3891,
  "ambiguous": 2,
  "unmatched": 45,
  "dryRun": false
}
```

**Concurrency**: Must acquire the sync lease. The sync pipeline writes
to the `players` table via `upsertPlayers` (`src/sync/upserts.ts:364`);
a concurrent cron could insert new player rows while this endpoint is
updating `date_of_birth`. If the lease is held, return 409.

**Idempotency**: Every UPDATE is guarded by `WHERE date_of_birth IS
NULL` (lines 211 and 370 of `backfill-dob.mts`). Re-running after a
complete run emits zero writes. The AFL Tables stage checks
`date_of_birth IS NULL` on the initial D1 query so it only fetches
rosters for teams that still have players with missing DOBs.

**Chunking contract**: For the AFL Tables stage, max 5 years per
request. Recommended invocation pattern:
1. `{ stage: "fryzigg", dryRun: false }` — one request, fills DOBs for
   players with a fryzigg `external_id`.
2. `{ stage: "afltables", fromYear: 1990, toYear: 1999 }`, then
   `2000–2009`, `2010–2025` — three requests for the backlog of players
   without fryzigg IDs.

**Failure / observability**:
- Write `sync_log` rows with type `admin:dob-backfill` on completion.
- NOT in the health-paging set.
- Ambiguous and unmatched player counts surface in the response body;
  they are expected (some common names genuinely cannot be resolved
  safely). The endpoint logs them but does not error.

**Implementation estimate**: M — two-stage algorithm is written;
porting to Worker context requires: replacing shell fetches with native
`fetch()` calls for AFL Tables roster pages, replacing D1 shell queries
with `env.DB.prepare()`, careful memory management for the fryzigg
DataFrame, and the two-stage flow where fryzigg writes are applied
before AFL Tables reads the residual NULL-DOB set.

---

## 4. Deletion recommendations (ONE-SHOT-DONE)

The following nine scripts are recommended for deletion. Git history
preserves the algorithms and commit rationale if they are needed again.
This is a recommendation for maintainer sign-off, not an action taken
by this plan.

| File | Rationale |
|------|-----------|
| `scripts/backfill-lineups-early.ts` | 2015–2019 lineup initial load complete; matches now have `external_afl_id` |
| `scripts/backfill-rounds.ts` | One-time fix for 2024/2025 label errors; `upsertMatches` covers future seasons |
| `scripts/dedup-players.ts` | Initial migration split fixed; `upsertPlayers` prevents recurrence |
| `scripts/enrich-fryzigg.ts` | Weather at 100% (NO-ENRICH); other fields superseded by sync pipeline |
| `scripts/probe-afltables-lineups.ts` | Investigation for #73 closed |
| `scripts/probe-missing-lineups.ts` | Investigation for #71 closed |
| `scripts/probe-opening-rounds.ts` | Investigation for #67 closed |
| `scripts/seed-d1.ts` | Postgres→D1 migration complete; `data/export/` CSVs no longer maintained |
| `scripts/verify-integrity.ts` | Verifier for initial migration; depends on stale CSV files |

---

## 5. Open questions

1. **Typecheck coverage for OPERATIONAL-KEEP scripts**: Should
   `backfill-lineups.ts`, `refetch-lineups.ts`, and
   `diagnose-brownlow-gaps.ts` be added to `tsconfig.json`? The current
   strict compiler config (`noUncheckedIndexedAccess`,
   `exactOptionalPropertyTypes`) would catch latent bugs. The downside
   is that scripts use `node:child_process` and `node:fs` (not Web
   Standard APIs), which would need a separate `tsconfig.scripts.json`
   to avoid polluting the Worker tsconfig.

2. **Brownlow endpoint: should it skip PAV?** The endpoint writes
   `brownlow_votes`, which is not an input to the PAV formula
   (`src/sync/pav.ts` uses kicks, handballs, goals, etc.). PAV
   recalculation after a Brownlow backfill would be a no-op on the
   formula — but the current PAV gate (`statsAffected > 0`) would fire
   if the endpoint's writes count as "stats affected". Safest: set
   `skipPav: true` by default in the Brownlow endpoint (not exposed to
   callers), or check the affected columns before triggering PAV.

3. **DOB endpoint: fryzigg memory footprint**: The full fryzigg AFLM
   DataFrame is large. If it exceeds Workers' memory ceiling (128 MB on
   the free plan, higher on paid), the fryzigg stage must be chunked by
   season range or the fryzigg DataFrame must be streamed. Worth
   profiling before implementation.

4. **`diagnose-brownlow-gaps.ts` hard-coded years**: The script
   hard-codes `[2022, 2023, 2024, 2025]` (line 47). If the Brownlow
   endpoint is built, this diagnostic will need updating to cover the
   years callers are backfilling. Alternatively, promote it to a
   read-only `GET /mcp/admin/diagnose-brownlow-gaps?fromYear=&toYear=`
   endpoint so maintainers can inspect gaps without a local script.

5. **`backfill-lineups.ts` vs the self-healing cron**: The cron's
   `selectCompletedRoundsWithoutLineups` looks back 3 rounds. For a
   season that ended more than 3 rounds ago, the self-healer won't
   fire, and `backfill-lineups.ts` remains the only repair path.
   Should the look-back window be a configurable parameter on
   `POST /mcp/admin/sync`? Or is the 3-round default adequate?

---

## 6. Implementation slicing

Suggested plan ordering (each item is a standalone plan):

| Order | Plan | Endpoint / change | Estimate | Depends on |
|-------|------|-------------------|----------|------------|
| 1 | Plan 012 (or new) | `POST /mcp/admin/backfill-brownlow` | S | This design |
| 2 | New plan | `POST /mcp/admin/backfill-dob` | M | This design + open question 3 answered |
| 3 | New plan | Harden OPERATIONAL-KEEP scripts (typecheck, drift fix) | S | Separate `tsconfig.scripts.json` decision (open question 1) |
| 4 | New plan | Delete ONE-SHOT-DONE scripts (maintainer sign-off required) | XS | Plans above merged |

Start with the Brownlow endpoint: it has the clearest seasonal need
(one run per year, immediately after the media count), the algorithm is
already proven, and the implementation is small enough to be
independently reviewable. The DOB endpoint is more complex due to
the two-stage memory concerns and is better done second once the
Brownlow endpoint pattern is established.
