# AFL-MCP Database Schema

## Entity Relationship Diagram

```
┌──────────────┐
│ competitions │
│──────────────│
│ id (PK)      │
│ code         │
│ name         │
└──────┬───────┘
       │ 1:N
       │
┌──────▼───────┐     ┌──────────────┐
│   seasons    │     │    venues    │
│──────────────│     │──────────────│
│ id (PK)      │     │ id (PK)      │
│ competition_id│     │ name         │
│ year         │     └──────┬───────┘
└──────┬───────┘            │
       │ 1:N                │
       │                    │
┌──────▼────────────────────▼────────────────────┐
│                   matches                       │
│─────────────────────────────────────────────────│
│ id (PK)                                         │
│ season_id (FK → seasons)                        │
│ round, round_number, round_type                 │
│ date, local_time                                │
│ venue_id (FK → venues)                          │
│ home_team_id, away_team_id (FK → teams)         │
│ home/away_goals, home/away_behinds              │
│ home/away_points, margin                        │
│ attendance, weather_temp_c, weather_type        │
│ external_afltables_id (UNIQUE)                  │
│ external_fryzigg_id (UNIQUE)                    │
└──────────────────┬──────────────────────────────┘
                   │ 1:N
                   │
┌──────────────────▼──────────────────────────────┐
│            player_match_stats                   │
│─────────────────────────────────────────────────│
│ id (PK)                                         │
│ match_id (FK → matches)                         │
│ player_id (FK → players)                        │
│ team_id (FK → teams) ← authoritative team link  │
│ guernsey_number, player_position, subbed        │
│ time_on_ground_pct                              │
│ kicks, handballs, disposals, effective_disposals│
│ disposal_efficiency_pct, marks, bounces, tackles│
│ contested/uncontested_possessions               │
│ goals, behinds, goal_assists, shots_at_goal     │
│ clearances, centre/stoppage_clearances          │
│ hitouts, hitouts_to_advantage, hitout_win_pct   │
│ pressure_acts, metres_gained, intercepts, ...   │
│ brownlow_votes, afl_fantasy_score, supercoach   │
│ UNIQUE (match_id, player_id)                    │
└─────────────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│               players                    │
│──────────────────────────────────────────│
│ id (PK)                                  │
│ first_name, surname                      │
│ external_id (UNIQUE) ← fryzigg player_id │
│ height_cm, weight_kg                     │
│ is_retired                               │
│ (NO team_id — use player_match_stats)    │
└──────────────────────────────────────────┘

┌──────────────────────────────────────────┐
│                teams                     │
│──────────────────────────────────────────│
│ id (PK)                                  │
│ name, abbreviation                       │
│ competition_id (FK → competitions)       │
│ UNIQUE (name, competition_id)            │
└──────────────────────────────────────────┘
```

## Design Notes

### Player team tracking
Players do not have a `team_id`. AFL players change clubs, so team membership
is tracked per-match via `player_match_stats.team_id`. To find a player's
current team: query their most recent `player_match_stats` row.

### Dual external IDs on matches
afltables and fryzigg use different match ID systems. Both are stored:
- `external_afltables_id`: "Game" number from afltables (results.csv)
- `external_fryzigg_id`: "match_id" from fryzigg (player_stats.csv)

### Venue normalisation
Venue names are normalised across sources (e.g. "M.C.G." → "MCG",
"Docklands" → "Marvel Stadium").

### Column naming
`player_match_stats` columns match the fryzigg CSV column names directly
to minimise mapping bugs (e.g. `inside_fifties` not `inside_50s`).

## Embedding Tables (migration 002/003)

### player_season_summaries
Natural language summaries of player seasons with vector embeddings.

### match_summaries
Natural language summaries of matches with vector embeddings.
