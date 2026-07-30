# TBC Venue Investigation for Venue 17748

This read-only investigation ran on 2026-07-13 and changed no code or D1 data.
It covers 55 VFL and VFLW matches assigned to placeholder venue 17748.

---

## Summary

The matches form two cohorts with different causes and corrections. None can
currently resolve to a real venue.

| Cohort                             | Count | Upstream status (afl-api, checked 2026-07-13)                                   | Disposition                                                                                                              |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| VFL 2021, R9 - R16 (Jun - Jul)     | 27    | `Cancelled` - COVID-lockdown cancellations. venue permanently "To Be Confirmed" | Never played. no venue will ever exist. Backfill `status = 'Cancelled'` and exclude from weather-enrichment denominators |
| VFL 2026 R21 + VFLW 2026 R14 - R16 | 28    | `Upcoming` - fixture block not yet detailed (placeholder Mon 12:00 dates)       | Will self-heal via the existing cron once the AFL announces venues. no action needed                                     |

The sync upsert is not at fault. Its `COALESCE` semantics allow a later non-NULL
venue to replace the placeholder. The AFL API still reports `To Be Confirmed`
for the cancelled 2021 matches. No other fitzroy source covers VFL or VFLW.

---

## 1. Can an Upstream Source Resolve the Venues? (Q1)

The investigation called `fetchMatches` through the same fitzroy source as the
sync. It queried VFL 2021, VFL 2026, and VFLW 2026. All 55 `external_afl_id`
values matched upstream records.

The AFL API still reports `venue = "To Be Confirmed"` for every match.
Therefore, none of the 55 records can resolve to a physical venue.

Empirical tests confirmed that alternative sources do not cover VFL or VFLW:

```text
squiggle   ERR: squiggle does not provide match data for VFL
afl-tables ERR: afl-tables does not provide match data for VFL
footywire  ERR: footywire does not provide match data for VFL
fryzigg    ERR: fryzigg does not provide match data
```

The match-level venue correction list is empty. Instead, correct the status of
the 27 cancelled 2021 matches. Every 2021 VFL and VFLW row currently has
`status = NULL` because the column postdates the season's last sync.

### 1.1 VFL 2021 - Cancelled Matches (Correct Fix: `status = 'Cancelled'`)

| D1 id  | external_afl_id | Round | Date       | Match                             | Upstream status                          |
| ------ | --------------- | ----- | ---------- | --------------------------------- | ---------------------------------------- |
| 181114 | CD_M20210150901 | R9    | 2021-06-11 | Casey Demons v Collingwood        | Cancelled                                |
| 181115 | CD_M20210150903 | R9    | 2021-06-11 | Port Melbourne v North Melbourne  | Cancelled                                |
| 181116 | CD_M20210150904 | R9    | 2021-06-11 | Sandringham v Coburg              | Cancelled                                |
| 181117 | CD_M20210150906 | R9    | 2021-06-11 | Werribee v Geelong                | Cancelled                                |
| 181118 | CD_M20210150907 | R9    | 2021-06-11 | Gold Coast v Williamstown         | Cancelled                                |
| 181131 | CD_M20210151108 | R11   | 2021-06-25 | Gold Coast v Southport Sharks     | Cancelled                                |
| 181150 | CD_M20210151310 | R13   | 2021-07-09 | Williamstown v Southport Sharks   | Cancelled                                |
| 181159 | CD_M20210151401 | R14   | 2021-07-16 | Casey Demons v Box Hill Hawks     | Cancelled                                |
| 181160 | CD_M20210151402 | R14   | 2021-07-16 | Collingwood v Carlton             | Cancelled                                |
| 181161 | CD_M20210151403 | R14   | 2021-07-16 | Gold Coast v Western Bulldogs     | Cancelled                                |
| 181162 | CD_M20210151404 | R14   | 2021-07-16 | North Melbourne v Essendon        | Cancelled                                |
| 181163 | CD_M20210151405 | R14   | 2021-07-16 | Coburg v Geelong                  | Cancelled                                |
| 181164 | CD_M20210151406 | R14   | 2021-07-16 | Aspley v Southport Sharks         | Cancelled                                |
| 181165 | CD_M20210151407 | R14   | 2021-07-16 | Frankston v Sandringham           | Cancelled                                |
| 181166 | CD_M20210151408 | R14   | 2021-07-16 | Port Melbourne v Werribee         | Cancelled                                |
| 181167 | CD_M20210151409 | R14   | 2021-07-16 | Northern Bullants v Williamstown  | Cancelled                                |
| 181168 | CD_M20210151504 | R15   | 2021-07-23 | Carlton v North Melbourne         | Cancelled                                |
| 181169 | CD_M20210151505 | R15   | 2021-07-23 | Northern Bullants v Frankston     | Cancelled                                |
| 181170 | CD_M20210151506 | R15   | 2021-07-23 | Western Bulldogs v Port Melbourne | Cancelled                                |
| 181171 | CD_M20210151507 | R15   | 2021-07-23 | Geelong v Richmond                | Cancelled                                |
| 181172 | CD_M20210151508 | R15   | 2021-07-23 | Collingwood v Sydney              | Cancelled                                |
| 181173 | CD_M20210151509 | R15   | 2021-07-23 | Southport Sharks v Werribee       | Cancelled                                |
| 181174 | CD_M20210151510 | R15   | 2021-07-23 | Williamstown v Sandringham        | Cancelled                                |
| 181178 | CD_M20210151603 | R16   | 2021-07-30 | Gold Coast v Southport Sharks     | Cancelled (abandoned after Q1 - see 1.3) |
| 181179 | CD_M20210151605 | R16   | 2021-07-30 | Aspley v Essendon                 | Cancelled                                |
| 181180 | CD_M20210151609 | R16   | 2021-07-30 | Brisbane Lions v Sydney           | Cancelled                                |
| 181181 | CD_M20210151611 | R16   | 2021-07-30 | Werribee v Northern Bullants      | Cancelled                                |

These rounds coincide with the June - July 2021 Victorian (and late-July
Queensland) COVID lockdowns. The AFL never rescheduled the games and never
assigned venues, so upstream will retain `To Be Confirmed`.

### 1.2 2026 Fixtures - Genuinely Unannounced (No Correction Needed)

All 28 records use the AFL's placeholder time of Monday at noon. The AFL had not
published these late-season fixture details by 2026-07-13. The blocks begin on
2026-08-10.

| D1 ids          | Competition | Round | Placeholder date | Count |
| --------------- | ----------- | ----- | ---------------- | ----- |
| 180618 - 180628 | VFL         | R21   | 2026-08-10       | 11    |
| 181027 - 181032 | VFLW        | R14   | 2026-08-10       | 6     |
| 181033 - 181037 | VFLW        | R15   | 2026-08-17       | 5     |
| 181038 - 181043 | VFLW        | R16   | 2026-08-24       | 6     |

Once the AFL publishes details, the five-minute sync will update the date, local
time, and venue. Each eligible tick fetches the full current-year fixture.

### 1.3 Match 181178 Is Not a Data Error

D1 holds partial Q1-only scores for Gold Coast v Southport (1.2.8 v 1.0.6,
`home_minutes_in_front = 6`). The upstream row confirms this state. Officials
abandoned the match after Q1 (`completedQuarter: 1`, one completed 658-second
period in `matchClockPeriods`, `status: "Cancelled"`,
`livePeriodStatus: "CONCLUDED"`). D1 mirrors upstream exactly. A status backfill
would also populate `completed_quarter = 1` and
`live_period_status = 'CONCLUDED'` for this row.

With
`home_points` non-NULL, the row counts as "completed" under the
`home_points IS NOT NULL` heuristics (`selectCompletedCount`,
`updateSeasonCompleteness`). Prefer `status = 'Cancelled'` over score-based
heuristics wherever cancellation matters.

---

## 2. Would New Venue Rows Be Needed? (Q2)

No new venue rows are necessary because no match resolves to a real venue.
`venues` contains one placeholder row, id 17748 with `To Be Confirmed`, and
`data/venue-geodata.csv` (branch `origin/data/venue-geodata`) already tracks it
honestly: empty lat/long/timezone, `confidence = low`, note "Placeholder venue
(55 matches). no physical ground - data-quality issue for weather backfill".

The announced 2026 venues will probably use existing VFL home grounds already
present in the table and geodata CSV. The normal `ensureVenues` path should
absorb them without additional geodata work. If the AFL adds a new ground, check
the CSV after the fixture release.

---

## 3. Why Did They Stick at TBC? (Q3)

**The upsert is not the gap.** In `src/sync/upserts.ts`, `venue_id` is a
`"coalesce"` column in `MATCH_COLUMNS`:

```text
venue_id = COALESCE(excluded.venue_id, matches.venue_id)
```

Upstream supplies the non-NULL placeholder ID 17748. A later non-NULL venue ID
will replace it through `COALESCE`. The change-detection condition
(`matches.venue_id IS NOT COALESCE(...)`) correctly registers it as a change.
Venue updates on re-sync work.

The actual causes, per cohort:

1. **2021 (27 matches): upstream is permanently TBC.** The AFL API reports "To
   Be Confirmed" for COVID-cancelled matches and always will. No amount of
   re-syncing fixes the venue, and no alternative fitzroy source carries
   VFL/VFLW. The rows also have `status = NULL` because the
   `status`/`live_period_status` columns were added after 2021 last synced, and
   historical seasons are only re-synced via the manual
   `POST /mcp/admin/backfill` endpoint (the cron syncs the current calendar year
   only - `src/sync/sync.ts`). So D1 currently cannot distinguish these
   cancelled matches from played ones without score heuristics.

2. **2026 (28 matches): not stuck at all.** The venue genuinely is TBC upstream.
   The cron re-fetches the full current-season fixture, so these will self-heal
   (venue, date, and local_time) within one sync tick of the AFL publishing the
   detail. The `ON CONFLICT (external_afl_id)` branch added for issue #80 also
   handles any accompanying date moves.

A 2021 re-sync will preserve stored dates. `toIsoDate` stores the UTC calendar
date, and upstream timestamps round-trip to the same values. The R9 block probe
confirmed this behaviour.

---

## 4. Recommended Correction Path (Q4)

Run one admin backfill for 2021, leave the sync logic unchanged, and verify the
2026 fixtures after publication.

1. For the 2021 cohort, run the existing backfill endpoint without new code.
   Send this request body to `POST /mcp/admin/backfill`:

   ```json
   {
     "competitions": ["VFL"],
     "fromYear": 2021,
     "toYear": 2021,
     "skipPav": true
   }
   ```

   The request runs the standard pipeline. The `status` coalesce column then fills
   `NULL  to  'Cancelled'` on the 27 matches (and correct statuses on the rest
   of the season). Consider including VFLW 2021 (all 91 rows also have
   `status = NULL`) in the same run for hygiene. `skipPav: true` because no
   stats change. Leave `venue_id = 17748` on these rows - it is the truthful
   upstream value for a match that never had a ground.

2. Exclude cancelled matches from weather enrichment. They have no weather to
   enrich. Any venue-based weather work should filter `status = 'Cancelled'`
   (after step 1) and treat venue 17748 as non-enrichable, exactly as
   `venue-geodata.csv` already flags. This removes the 27 permanent rows from
   coverage denominators instead of leaving them as false gaps.

3. Take no action for the 2026 cohort. Once the AFL publishes the VFL R21 / VFLW
   R14 - R16 details (expected well before the 2026-08-10 block), confirm
   `SELECT COUNT(*) FROM matches WHERE venue_id = 17748 AND date >= '2026-01-01'`
   trends to 0, and spot-check that any newly announced venue landed on an
   existing `venues` row (not a fresh `ensureVenues` insert needing geodata).

4. Leave the venue sync logic unchanged. The coalesce upsert already does the
   right thing. The only structural gap this investigation surfaced is that
   **historical seasons never receive new-column backfills automatically**
   (here: `status`). that is by design (cron = current year) and is adequately
   served by the existing backfill endpoint - worth remembering whenever a new
   match-level column ships.

---

## Appendix: Evidence Trail

- D1 queries via the MCP `code` tool (read-only): 55-row listing joined through
  `seasons`/`competitions`/`teams`. status breakdown for 2021. full row for
  match 181178.
- Upstream checks: scratch project at the session scratchpad, `fitzroy` (npm),
  `fetchMatches({ source: "afl-api", ... })` for VFL 2021 (145 matches), VFL
  2026 (198), VFLW 2026 (91). all 55 external ids matched. alternative sources
  (`squiggle`, `afl-tables`, `footywire`, `fryzigg`) each rejected VFL.
- Code read: `src/sync/upserts.ts` (`MATCH_COLUMNS`, `buildMatchUpsert`),
  `src/sync/columns.ts` (coalesce semantics), `src/sync/sync.ts` (current- year
  cron scope, backfill options), `src/lib/time.ts` (`toIsoDate`),
  `src/lib/normalise.ts` (`normaliseVenue` pass-through).
- Geodata: `data/venue-geodata.csv` on branch `origin/data/venue-geodata`.
