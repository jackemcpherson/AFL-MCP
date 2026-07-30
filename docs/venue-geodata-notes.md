# Venue Geodata Notes

**Date:** 2026-07-13 **Dataset:**
[`data/venue-geodata.csv`](../data/venue-geodata.csv) (106 rows, one per D1
venue id) **Author:** Claude Code (executor)

---

## 1. Purpose and Method

Geodata (lat/lon, IANA timezone, roof type, canonical-venue wiring) for every
venue in production D1, to support the weather backfill. The weather source is
an ~11 km reanalysis grid, so the precision bar for coordinates is low - within
~3 km of the ground is sufficient. Coordinates are decimal degrees at 4 dp.

Method:

- Well-known AFL/VFL grounds were placed from general knowledge and marked
  `high` confidence.
- Obscure and sponsor-named grounds (mostly VFL/VFLW/AFLW venues 2017+) were
  verified via web search against Austadiums, Wikipedia, AFL.com.au, club sites
  and council pages. Rows verified this way carry a source note in the CSV
  `notes` column.
- Duplicate/renamed/sponsor-alias rows are wired to a canonical venue id: the
  highest-match-count row for the same physical ground. Alias rows carry the
  canonical ground's coordinates.
- `roof` is `retractable` for Marvel Stadium (Docklands) only - no other venue
  in the list has a roof. The placeholder row has all geodata fields empty.
- ACT venues (Manuka Oval, Bruce Stadium) use `Australia/Sydney`.

Sanity checks run before committing: all 106 D1 venue ids present exactly once.
every non-placeholder row has coords + timezone. timezone consistent with
longitude/state. every canonical target is the highest-match-count row in its
alias group. alias rows share coordinates with their canonical row.

## 2. Alias Table

12 alias groups (alias to canonical, canonical = highest match count for the
same physical ground):

| Alias id | Alias name                             | Canonical id | Canonical name                     | Physical ground                                                                                                                |
| -------- | -------------------------------------- | ------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 17606    | Domain Stadium (24)                    | 6            | Subiaco (502)                      | Subiaco Oval, Perth WA (sponsor name 2015 - 2017)                                                                              |
| 72       | Western Oval (84)                      | 17599        | Mission Whitten Oval (121)         | Whitten Oval, Footscray VIC                                                                                                    |
| 2        | Blundstone Arena (19)                  | 166          | Ninja Stadium (26)                 | Bellerive Oval, Hobart TAS                                                                                                     |
| 93       | Blacktown (1)                          | 17602        | Blacktown ISP (53)                 | Blacktown International Sportspark, Rooty Hill NSW                                                                             |
| 1526404  | Blacktown International Sportspark (0) | 17602        | Blacktown ISP (53)                 | as above                                                                                                                       |
| 1184693  | Avalon Airport Oval (0)                | 17641        | Melbourne Avalon Airport Oval (66) | Chirnside Park, Werribee VIC                                                                                                   |
| 9        | Barossa Oval (0)                       | 14           | Barossa Park (7)                   | Lyndoch Recreation Park, Lyndoch SA - see §3                                                                                   |
| 245155   | Unley Oval (0)                         | 17643        | Thomas Farms Oval (13)             | Unley Oval, Unley SA                                                                                                           |
| 100      | Moorabbin Oval (24)                    | 17651        | RSEA Park (52)                     | Moorabbin Oval, Moorabbin VIC                                                                                                  |
| 69       | North Hobart (4)                       | 17628        | North Hobart Oval (17)             | North Hobart Oval, TAS                                                                                                         |
| 17905    | Lakeside Oval Sydney (2)               | 17744        | Tramway Oval (28)                  | Tramway Oval, Moore Park NSW - Wikipedia confirms "Lakeside Oval" is an alternative name for the same ground                   |
| 17608    | Olympic Park Oval (4)                  | 17726        | KGM Centre (34)                    | Olympic Park Oval at Collingwood's HQ (ex AIA Centre). AFL data uses the building name for matches played on the adjacent oval |
| 763961   | Victor George Kailis Oval (0)          | 217702       | Cockburn ARC Oval (6)              | Victor George Kailis Oval at Cockburn ARC, Cockburn Central WA (found during verification. not in the original alias list)     |

Numbers in parentheses are D1 match counts. All other rows are self-canonical.

## 3. Rows Below High Confidence

Eleven rows need additional verification or cannot represent a physical venue.

### Medium (10 Rows - Placed, but with a Stated Ambiguity)

| id    | Name                               | What was ambiguous                                                                                                                                                |
| ----- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 17836 | Deakin University                  | Waurn Ponds campus (Geelong VFL/VFLW) is certain. exact oval within the campus not confirmed.                                                                     |
| 17624 | Moreton Bay Central Sports Complex | Burpengary QLD. placement within the complex approximate, not independently verified.                                                                             |
| 18034 | La Trobe University                | Bundoora campus sports fields. exact oval within campus not confirmed.                                                                                            |
| 17603 | South Pine Sports Complex          | Brendale QLD. placement within the complex approximate.                                                                                                           |
| 17727 | Holm Park Recreation Reserve       | Beaconsfield VIC. reserve placement approximate within the town.                                                                                                  |
| 17706 | Maroochydore                       | Maroochydore Multi Sports Complex, Fishermans Rd (Brisbane AFLW home 2022). precinct has multiple ovals, exact oval unconfirmed.                                  |
| 18040 | KFC Oval - Queens Park             | Queens Park, Highton, Geelong VIC - identified from a single source (GameDay venue listing "Queens Park, Highton VIC 3216"). no second source found.              |
| 18094 | Central Reserve                    | Placed at Colac VIC (hosted VFLW per Colac Herald). a Central Reserve also exists in Glen Waverley VIC. 1 match affected.                                         |
| 25    | Summit Sports Park                 | Summit Sport and Recreation Park, Mount Barker SA (Gather Round 2023 - 24) is certain. park placement approximate. 0 matches.                                     |
| 9     | Barossa Oval                       | No distinct "Barossa Oval" venue found anywhere. treated as an early/alternate AFL API name for Barossa Park, Lyndoch. 0 matches, so no backfill impact if wrong. |

Note on Richmond Oval (17658): the 2020 AFLW ground is Richmond Oval in
Richmond, **South Australia** (West Adelaide FC. Adelaide Crows' 2020 AFLW home
ground) - not Punt Road Oval in Melbourne. Verified via Wikipedia, so it carries
`high` confidence, but flagged here because the name invites confusion.

### Low (1 Row)

| id    | Name            | Issue                                                                    |
| ----- | --------------- | ------------------------------------------------------------------------ |
| 17748 | To Be Confirmed | Placeholder venue, not a physical ground. All geodata fields left empty. |

## 4. Data-Quality Flag: "To Be Confirmed" (Id 17748)

Production D1 assigns 55 matches to the placeholder venue `To Be Confirmed`.
This dataset cannot support weather backfills for those matches because they
have no coordinates or timezone. Resolve the matches against source fixture data
before or during the weather backfill. Until then, expect 55 matches to retain
NULL weather values.
