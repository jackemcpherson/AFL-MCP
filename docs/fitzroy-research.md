# fitzRoy R Package - Data Structure Research

## Overview

The [fitzRoy](https://jimmyday12.github.io/fitzRoy/) R package provides access to AFL and AFLW statistics from multiple data sources. This document covers the key functions and their return structures relevant to our ETL pipeline.

## Key Functions

### 1. `fetch_results(season, source, comp)`

Fetches match-level results (scores, venues, dates).

**Recommended source**: `"afltables"` — most complete historical data.

**Parameters**:
- `season`: integer or vector of seasons (e.g., `2016:2025`)
- `source`: `"afltables"`, `"footywire"`, `"squiggle"`
- `comp`: `"AFLM"` (men's) or `"AFLW"` (women's)

**Return columns** (afltables source, ~16 columns):

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| Game | integer | Unique game identifier | 14205 |
| Date | date | Match date (YYYY-MM-DD) | 2023-03-16 |
| Round | character | Round label | "R1" |
| Round.Number | integer | Numeric round | 1 |
| Round.Type | character | Regular/Finals | "Regular" |
| Venue | character | Ground name | "MCG" |
| Home.Team | character | Home team name | "Richmond" |
| Away.Team | character | Away team name | "Carlton" |
| Home.Goals | integer | Home goals scored | 12 |
| Home.Behinds | integer | Home behinds scored | 8 |
| Home.Points | integer | Home total points | 80 |
| Away.Goals | integer | Away goals scored | 10 |
| Away.Behinds | integer | Away behinds scored | 14 |
| Away.Points | integer | Away total points | 74 |
| Margin | integer | Home margin (can be negative) | 6 |

### 2. `fetch_player_stats(season, source, comp)`

Fetches per-match player-level statistics.

**Recommended source**: `"fryzigg"` — includes advanced metrics (pressure acts, metres gained, etc.).

**Parameters**: Same as `fetch_results()`.

**Return columns** (fryzigg source, ~81 columns — key ones listed):

| Column | Type | Description |
|--------|------|-------------|
| providerId | character | External match ID |
| utcStartTime | datetime | Match start time UTC |
| status | character | Match status |
| compSeason.shortName | character | Season label |
| round.roundNumber | integer | Round number |
| round.name | character | Round name |
| venue.name | character | Venue name |
| home.team.name / away.team.name | character | Team names |
| player.player.player.playerId | character | Player ID |
| player.player.player.givenName | character | First name |
| player.player.player.surname | character | Surname |
| team.name | character | Player's team |
| timeOnGroundPercentage | numeric | Time on ground % |
| kicks | integer | Kicks |
| handballs | integer | Handballs |
| disposals | integer | Disposals |
| marks | integer | Marks |
| bounces | integer | Bounces |
| tackles | integer | Tackles |
| contestedPossessions | integer | Contested possessions |
| uncontestedPossessions | integer | Uncontested possessions |
| totalPossessions | integer | Total possessions |
| inside50s | integer | Inside 50s |
| marksInside50 | integer | Marks inside 50 |
| contestedMarks | integer | Contested marks |
| hitouts | integer | Hitouts |
| onePercenters | integer | One percenters |
| disposalEfficiency | numeric | Disposal efficiency % |
| clangers | integer | Clangers |
| freesFor | integer | Frees for |
| freesAgainst | integer | Frees against |
| dreamTeamPoints | integer | Fantasy points |
| supercoachScore | integer | SuperCoach score |
| goals | integer | Goals |
| behinds | integer | Behinds |
| goalAssists | integer | Goal assists |
| clearances.centreClearances | integer | Centre clearances |
| clearances.stoppageClearances | integer | Stoppage clearances |
| clearances.totalClearances | integer | Total clearances |
| rebound50s | integer | Rebound 50s |
| turnovers | integer | Turnovers |
| intercepts | integer | Intercepts |
| tacklesInside50 | integer | Tackles inside 50 |
| shotsAtGoal | integer | Shots at goal |
| scoreInvolvements | integer | Score involvements |
| metresGained | integer | Metres gained |
| pressureActs | integer | Pressure acts |
| extendedStats.effectiveKicks | integer | Effective kicks |
| extendedStats.kickEfficiency | numeric | Kick efficiency % |
| extendedStats.groundBallGets | integer | Ground ball gets |
| extendedStats.interceptMarks | integer | Intercept marks |
| extendedStats.f50GroundBallGets | integer | F50 ground ball gets |
| extendedStats.scoreLaunches | integer | Score launches |

### 3. `fetch_player_details(season, source, comp)`

Fetches player biographical/roster data.

**Recommended source**: `"afltables"` — most complete historical records.

**Return columns**:

| Column | Type | Description | Example |
|--------|------|-------------|---------|
| Season | integer | Season year | 2023 |
| Player | character | Full name | "Tom Mitchell" |
| ID | integer | Player ID (afltables) | 12345 |
| DOB | date | Date of birth | 1993-12-31 |
| Born | character | Birthplace | "Melbourne, VIC" |
| Height | integer | Height (cm) | 184 |
| Weight | integer | Weight (kg) | 83 |
| Games | integer | Career games | 150 |
| Goals | integer | Career goals | 30 |

## Data Quality Notes

1. **Team naming inconsistency**: fitzRoy uses different team name formats across sources:
   - afltables: "Greater Western Sydney"
   - fryzigg: "GWS Giants" or "GWS"
   - Need a normalization mapping in the loader

2. **Date formats**: afltables uses `YYYY-MM-DD`, fryzigg uses UTC datetime strings. Normalize to ISO 8601.

3. **Season coverage**: All three functions support 2016-2025. Earlier seasons have sparser data for advanced stats.

4. **Player IDs**: afltables and fryzigg use different ID systems. Use `external_id` fields in schema to track provenance.

5. **Round naming**: Finals rounds have special names ("QF", "EF", "PF", "GF"). Use `Round.Type` to distinguish.

6. **Missing data**: Some advanced stats (pressure acts, metres gained) are only available from ~2019 onwards. Store as NULL for earlier seasons.

## Extraction Strategy

- Use `afltables` source for match results (most reliable historical data)
- Use `fryzigg` source for player stats (richest stat set including advanced metrics)
- Use `afltables` source for player details (biographical data)
- Extract seasons 2016-2025 for AFLM competition
- Export as UTF-8 CSV with ISO 8601 dates
