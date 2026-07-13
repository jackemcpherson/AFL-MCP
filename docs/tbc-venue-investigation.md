# TBC Venue Investigation (venue_id 17748)

**Date:** 2026-07-13
**Scope:** 55 VFL/VFLW matches on placeholder venue "To Be Confirmed" (venue id 17748); read-only investigation — no D1 writes, no code changes
**Author:** Claude Code (investigator)

---

## Summary

The 55 matches split into two cohorts with different explanations and
different fixes — and **zero of the 55 can be re-resolved to a real venue
today**:

| Cohort | Count | Upstream status (afl-api, checked 2026-07-13) | Disposition |
|--------|-------|-----------------------------------------------|-------------|
| VFL 2021, R9–R16 (Jun–Jul) | 27 | `Cancelled` — COVID-lockdown cancellations; venue permanently "To Be Confirmed" | Never played; no venue will ever exist. Backfill `status = 'Cancelled'` and exclude from weather-enrichment denominators |
| VFL 2026 R21 + VFLW 2026 R14–R16 | 28 | `Upcoming` — fixture block not yet detailed (placeholder Mon 12:00 dates) | Will self-heal via the existing cron once the AFL announces venues; no action needed |

The sync upsert is **not** at fault: `venue_id` uses `COALESCE` semantics,
so a re-sync that carries a real (non-NULL) venue id overwrites the TBC id.
The 2021 rows are stuck because the AFL API itself still reports
"To Be Confirmed" for cancelled matches, and no other fitzroy source covers
VFL/VFLW at all.

---

## 1. Can an upstream source resolve the venues? (Q1)

**Method:** `fetchMatches({ source: "afl-api", season, competition })` was run
from a scratch project against fitzroy (the same library and source the sync
uses) for VFL 2021, VFL 2026, and VFLW 2026, and matched to D1 rows by
`external_afl_id`. All 55 external ids were found upstream.

**Result: 0 of 55 resolvable.** Every one of the 55 matches still reports
`venue = "To Be Confirmed"` on the AFL API today.

Alternative sources were tested empirically and none cover VFL/VFLW:

```
squiggle   ERR: squiggle does not provide match data for VFL
afl-tables ERR: afl-tables does not provide match data for VFL
footywire  ERR: footywire does not provide match data for VFL
fryzigg    ERR: fryzigg does not provide match data
```

The requested match-level *venue* correction list is therefore empty. The
actionable match-level correction is instead a **status** correction for the
27 cancelled 2021 matches (D1 currently has `status = NULL` for every VFL and
VFLW 2021 match — 145 + 91 rows — because the `status` column postdates those
seasons' last sync).

### 1.1 VFL 2021 — cancelled matches (correct fix: `status = 'Cancelled'`)

| D1 id | external_afl_id | Round | Date | Match | Upstream status |
|-------|-----------------|-------|------|-------|-----------------|
| 181114 | CD_M20210150901 | R9 | 2021-06-11 | Casey Demons v Collingwood | Cancelled |
| 181115 | CD_M20210150903 | R9 | 2021-06-11 | Port Melbourne v North Melbourne | Cancelled |
| 181116 | CD_M20210150904 | R9 | 2021-06-11 | Sandringham v Coburg | Cancelled |
| 181117 | CD_M20210150906 | R9 | 2021-06-11 | Werribee v Geelong | Cancelled |
| 181118 | CD_M20210150907 | R9 | 2021-06-11 | Gold Coast v Williamstown | Cancelled |
| 181131 | CD_M20210151108 | R11 | 2021-06-25 | Gold Coast v Southport Sharks | Cancelled |
| 181150 | CD_M20210151310 | R13 | 2021-07-09 | Williamstown v Southport Sharks | Cancelled |
| 181159 | CD_M20210151401 | R14 | 2021-07-16 | Casey Demons v Box Hill Hawks | Cancelled |
| 181160 | CD_M20210151402 | R14 | 2021-07-16 | Collingwood v Carlton | Cancelled |
| 181161 | CD_M20210151403 | R14 | 2021-07-16 | Gold Coast v Western Bulldogs | Cancelled |
| 181162 | CD_M20210151404 | R14 | 2021-07-16 | North Melbourne v Essendon | Cancelled |
| 181163 | CD_M20210151405 | R14 | 2021-07-16 | Coburg v Geelong | Cancelled |
| 181164 | CD_M20210151406 | R14 | 2021-07-16 | Aspley v Southport Sharks | Cancelled |
| 181165 | CD_M20210151407 | R14 | 2021-07-16 | Frankston v Sandringham | Cancelled |
| 181166 | CD_M20210151408 | R14 | 2021-07-16 | Port Melbourne v Werribee | Cancelled |
| 181167 | CD_M20210151409 | R14 | 2021-07-16 | Northern Bullants v Williamstown | Cancelled |
| 181168 | CD_M20210151504 | R15 | 2021-07-23 | Carlton v North Melbourne | Cancelled |
| 181169 | CD_M20210151505 | R15 | 2021-07-23 | Northern Bullants v Frankston | Cancelled |
| 181170 | CD_M20210151506 | R15 | 2021-07-23 | Western Bulldogs v Port Melbourne | Cancelled |
| 181171 | CD_M20210151507 | R15 | 2021-07-23 | Geelong v Richmond | Cancelled |
| 181172 | CD_M20210151508 | R15 | 2021-07-23 | Collingwood v Sydney | Cancelled |
| 181173 | CD_M20210151509 | R15 | 2021-07-23 | Southport Sharks v Werribee | Cancelled |
| 181174 | CD_M20210151510 | R15 | 2021-07-23 | Williamstown v Sandringham | Cancelled |
| 181178 | CD_M20210151603 | R16 | 2021-07-30 | Gold Coast v Southport Sharks | Cancelled (abandoned after Q1 — see 1.3) |
| 181179 | CD_M20210151605 | R16 | 2021-07-30 | Aspley v Essendon | Cancelled |
| 181180 | CD_M20210151609 | R16 | 2021-07-30 | Brisbane Lions v Sydney | Cancelled |
| 181181 | CD_M20210151611 | R16 | 2021-07-30 | Werribee v Northern Bullants | Cancelled |

These rounds coincide with the June–July 2021 Victorian (and late-July
Queensland) COVID lockdowns. The AFL never rescheduled the games and never
assigned venues, so upstream will report "To Be Confirmed" forever.

### 1.2 2026 fixtures — genuinely unannounced (no correction needed)

All 28 carry the AFL's placeholder date/time (`Mon 12:00` local) as well as
the placeholder venue — the fixture detail for these late-season blocks has
simply not been published yet (today is 2026-07-13; the blocks start
2026-08-10).

| D1 ids | Competition | Round | Placeholder date | Count |
|--------|-------------|-------|------------------|-------|
| 180618–180628 | VFL | R21 | 2026-08-10 | 11 |
| 181027–181032 | VFLW | R14 | 2026-08-10 | 6 |
| 181033–181037 | VFLW | R15 | 2026-08-17 | 5 |
| 181038–181043 | VFLW | R16 | 2026-08-24 | 6 |

Once the AFL publishes the detail, the `*/5` cron (which re-fetches the whole
current-calendar-year fixture per competition on every eligible tick) will
rewrite `date`, `local_time`, and `venue_id` in place — see section 3.

### 1.3 Match 181178 is not a data error

D1 holds partial Q1-only scores for Gold Coast v Southport (1.2.8 v 1.0.6,
`home_minutes_in_front = 6`). The upstream row confirms this is faithful: the
match was abandoned after Q1 (`completedQuarter: 1`, one completed
658-second period in `matchClockPeriods`, `status: "Cancelled"`,
`livePeriodStatus: "CONCLUDED"`). D1 mirrors upstream exactly; a status
backfill would also populate `completed_quarter = 1` and
`live_period_status = 'CONCLUDED'` for this row. Note the side effect: with
`home_points` non-NULL, this row counts as "completed" under the
`home_points IS NOT NULL` heuristics (`selectCompletedCount`,
`updateSeasonCompleteness`), so `status = 'Cancelled'` should be preferred
over score-based heuristics wherever cancellation matters.

---

## 2. Would new venue rows be needed? (Q2)

**No.** Since no match resolves to a real venue, no venue rows are needed
now. `venues` contains exactly one placeholder row (id 17748,
"To Be Confirmed"), and `data/venue-geodata.csv` (branch
`origin/data/venue-geodata`) already tracks it honestly: empty
lat/long/timezone, `confidence = low`, note "Placeholder venue (55 matches);
no physical ground — data-quality issue for weather backfill".

When the 2026 venues are announced they will almost certainly be existing VFL
home grounds already present in both the `venues` table and the geodata CSV
(ETU Stadium, DSV Stadium, Box Hill City Oval, Kinetic Stadium, Barry Plant
Park, Casey Fields, etc.), so the normal `ensureVenues` path plus the CSV's
existing coverage should absorb them without new geodata work. A brand-new
ground (e.g. a Tasmania VFL venue) would surface via `ensureVenues` inserting
a new row — worth a one-line check of the CSV after the fixture drops.

---

## 3. Why did they stick at TBC? (Q3)

**The upsert is not the gap.** In `src/sync/upserts.ts`, `venue_id` is a
`"coalesce"` column in `MATCH_COLUMNS`:

```
venue_id = COALESCE(excluded.venue_id, matches.venue_id)
```

The TBC placeholder is a real non-NULL id (17748) coming *from* upstream, and
a future re-sync carrying a real venue id is also non-NULL — so the COALESCE
overwrites TBC with the real venue, and the change-detection WHERE
(`matches.venue_id IS NOT COALESCE(...)`) correctly registers it as a change.
Venue updates on re-sync work.

The actual causes, per cohort:

1. **2021 (27 matches): upstream is permanently TBC.** The AFL API reports
   "To Be Confirmed" for COVID-cancelled matches and always will. No amount
   of re-syncing fixes the venue, and no alternative fitzroy source carries
   VFL/VFLW. The rows also have `status = NULL` because the
   `status`/`live_period_status` columns were added after 2021 last synced,
   and historical seasons are only re-synced via the manual
   `POST /mcp/admin/backfill` endpoint (the cron syncs the current calendar
   year only — `src/sync/sync.ts`). So D1 currently cannot distinguish these
   cancelled matches from played ones without score heuristics.

2. **2026 (28 matches): not stuck at all.** The venue genuinely is TBC
   upstream. The cron re-fetches the full current-season fixture, so these
   will self-heal (venue, date, and local_time) within one sync tick of the
   AFL publishing the detail. The `ON CONFLICT (external_afl_id)` branch
   added for issue #80 also handles any accompanying date moves.

A re-sync of 2021 is safe on the date axis: `toIsoDate` stores the UTC
calendar date, and the upstream timestamps round-trip to the identical
`date` values already in D1 (verified for the R9 block: upstream
`2021-06-11T14:00:00.000Z` → `2021-06-11`, matching the stored rows).

---

## 4. Recommended correction path (Q4)

**Recommendation: a small one-off admin action for 2021, no sync-logic
change, and a verification check for 2026.** Specifically:

1. **2021 cohort — run the existing backfill endpoint, no new code.**
   `POST /mcp/admin/backfill` with
   `{ "competitions": ["VFL"], "fromYear": 2021, "toYear": 2021, "skipPav": true }`
   re-runs the standard pipeline; the `status` coalesce column then fills
   `NULL → 'Cancelled'` on the 27 matches (and correct statuses on the rest
   of the season). Consider including VFLW 2021 (all 91 rows also have
   `status = NULL`) in the same run for hygiene. `skipPav: true` because no
   stats change. Leave `venue_id = 17748` on these rows — it is the truthful
   upstream value for a match that never had a ground.

2. **Weather enrichment — exclude, don't resolve.** Cancelled matches have no
   weather to enrich. Any venue-based weather work should filter
   `status = 'Cancelled'` (after step 1) and treat venue 17748 as
   non-enrichable, exactly as `venue-geodata.csv` already flags. This removes
   the 27 permanent rows from coverage denominators instead of leaving them
   as false gaps.

3. **2026 cohort — no action; verify self-heal.** Once the AFL publishes the
   VFL R21 / VFLW R14–R16 details (expected well before the 2026-08-10 block),
   confirm `SELECT COUNT(*) FROM matches WHERE venue_id = 17748 AND date >= '2026-01-01'`
   trends to 0, and spot-check that any newly announced venue landed on an
   existing `venues` row (not a fresh `ensureVenues` insert needing geodata).

4. **No sync-logic fix needed for venues.** The coalesce upsert already does
   the right thing. The only structural gap this investigation surfaced is
   that **historical seasons never receive new-column backfills
   automatically** (here: `status`); that is by design (cron = current year)
   and is adequately served by the existing backfill endpoint — worth
   remembering whenever a new match-level column ships.

---

## Appendix: evidence trail

- D1 queries via the MCP `code` tool (read-only): 55-row listing joined
  through `seasons`/`competitions`/`teams`; status breakdown for 2021;
  full row for match 181178.
- Upstream checks: scratch project at the session scratchpad, `fitzroy`
  (npm), `fetchMatches({ source: "afl-api", ... })` for VFL 2021 (145
  matches), VFL 2026 (198), VFLW 2026 (91); all 55 external ids matched;
  alternative sources (`squiggle`, `afl-tables`, `footywire`, `fryzigg`)
  each rejected VFL.
- Code read: `src/sync/upserts.ts` (`MATCH_COLUMNS`, `buildMatchUpsert`),
  `src/sync/columns.ts` (coalesce semantics), `src/sync/sync.ts` (current-
  year cron scope, backfill options), `src/lib/time.ts` (`toIsoDate`),
  `src/lib/normalise.ts` (`normaliseVenue` pass-through).
- Geodata: `data/venue-geodata.csv` on branch `origin/data/venue-geodata`.
